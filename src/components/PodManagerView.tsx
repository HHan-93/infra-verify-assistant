import { useEffect, useMemo, useRef, useState } from 'react'
import { Search, Loader2, RotateCw, RefreshCw, AlertTriangle, Activity } from 'lucide-react'
import type { PodInfo } from '../../electron/shared-types'
import { podDisplayStatus, type PodTone } from '../lib/podStatus'
import ConfirmDialog from './ConfirmDialog'

/** "3시간 전" 식 표시 — 저장은 늘 epoch ms, 사람에게 보일 때만 이렇게 바꾼다 */
function fmtAge(ms?: number): string {
  if (!ms) return '—'
  const d = Date.now() - ms
  if (d < 0) return '방금'
  const min = Math.floor(d / 60000)
  if (min < 1) return '방금'
  if (min < 60) return `${min}분 전`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}시간 전`
  return `${Math.floor(hr / 24)}일 전`
}

const TONE_STYLE: Record<PodTone, string> = {
  ok: 'text-emerald-300',
  warn: 'text-amber-300',
  bad: 'text-red-400',
  done: 'text-gray-400',
}

/** 재시작 확인창 문구 — 지운 뒤 무엇이 일어나는지는 소유 컨트롤러와 상태에 따라 다르다 */
function restartMessage(p: PodInfo): string {
  if (!p.ownerKind)
    return `⚠ "${p.name}" 파드는 관리하는 컨트롤러가 없습니다.\n지금 재시작하면 다시 생기지 않고 완전히 삭제됩니다 — 정말 진행할까요?`
  // 끝난 Job 의 파드는 Job 이 이미 완료로 기록했으므로 지워도 새로 만들지 않는다
  if (p.ownerKind === 'Job' && (p.phase === 'Succeeded' || p.phase === 'Failed'))
    return `"${p.name}" 는 이미 끝난 Job 의 파드입니다.\n삭제하면 다시 생기지 않습니다(재실행되지 않음) — 진행할까요?`
  return `"${p.name}" 파드를 재시작할까요?\n${p.ownerKind}가 관리하는 파드라, 삭제 직후 새 파드로 자동 재생성됩니다.`
}

/**
 * 설정 관리 창의 **파드 상태 모드**.
 *
 * ConfigMap 모드(네임스페이스 → 리소스 목록)와 같은 탐색 구조를 쓰지만, 여기는 '값을 고쳐서
 * 적용' 이 아니라 '행을 보고 그 자리에서 재시작' 이라 대기 목록이 없다 — 모니터링 대시보드의
 * 프로세스 종료(kill) 버튼과 같은 즉시-확인-실행 패턴이다.
 *
 * **재시작 = 삭제.** 컨트롤러(ReplicaSet·StatefulSet·DaemonSet·Job)가 있으면 즉시 재생성되지만,
 * 컨트롤러 없는 단독 파드는 지우면 그냥 사라진다. 그 구분을 모르고 누르면 사고로 이어지므로
 * ownerKind 유무에 따라 확인창 문구를 다르게 보여준다(파괴적 동작에는 대상 확인을 붙인다).
 */
export default function PodManagerView({
  sessionId,
  connected,
  active,
  onOpenLiveLog,
}: {
  sessionId: string
  connected: boolean
  /** 이 탭이 화면에 보이는가 — 보이지 않는 동안에는 조회하지 않는다 (ConfigMap 모드와 같은 규칙) */
  active: boolean
  /** 행의 '로그' 버튼 — 그 네임스페이스/파드로 실시간 로그 창을 열어 달라고 상위에 올린다 */
  onOpenLiveLog?: (namespace: string, pod: string) => void
}) {
  const [namespaces, setNamespaces] = useState<string[]>([])
  const [ns, setNs] = useState('')
  const [pods, setPods] = useState<PodInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [msg, setMsg] = useState('')
  const [query, setQuery] = useState('')
  const [restarting, setRestarting] = useState<Set<string>>(new Set())
  const [confirmTarget, setConfirmTarget] = useState<PodInfo | null>(null)

  /** 지금 화면이 보여주는 네임스페이스 — 비동기 응답·지연 새로고침이 '아직 그 화면인가' 를 묻는 데 쓴다 */
  const nsRef = useRef('')
  /**
   * 조회 요청 번호 — **늦게 도착한 옛 응답을 버린다.** 네임스페이스를 A→B 로 바꿨는데 A 의 응답이
   * 늦게 오면, 선택 상자는 B 인데 표에는 A 의 파드가 깔리고, 거기서 누른 재시작이 엉뚱한
   * 네임스페이스로 나간다(설정 파일 모드의 loadSeqRef 와 같은 이유).
   */
  const seqRef = useRef(0)
  /** 마지막으로 목록을 제대로 받아 온 시각 — 새로고침이 실패했을 때 '몇 초 전 목록' 인지 밝힌다 */
  const [loadedAt, setLoadedAt] = useState<number | null>(null)
  const [stale, setStale] = useState(false)

  const nsFetchedRef = useRef('')
  useEffect(() => {
    if (!connected || !active) return
    if (nsFetchedRef.current === sessionId) return
    nsFetchedRef.current = sessionId
    // 다른 세션의 목록이 남아 있으면 그 행에서 누른 재시작이 새 세션으로 나간다 — 세션이 바뀌면 비운다
    nsRef.current = ''
    seqRef.current++
    setNs('')
    setPods([])
    setNamespaces([])
    setLoadedAt(null)
    setStale(false)
    setLoading(false)
    window.electronAPI.k8sListNamespaces(sessionId).then((r) => {
      if (r.ok && r.namespaces) setNamespaces(r.namespaces)
      else setMsg(r.error ?? '네임스페이스를 가져오지 못했습니다.')
    })
  }, [sessionId, connected, active])

  /** 네임스페이스를 고른다 — 다른 곳의 목록이므로 비우고 새로 받는다 */
  const selectNs = (namespace: string) => {
    nsRef.current = namespace
    setNs(namespace)
    setPods([])
    setLoadedAt(null)
    setStale(false)
    void fetchPods(namespace)
  }

  /**
   * 지금 네임스페이스의 목록을 다시 받는다.
   *
   * **실패해도 직전 목록을 지우지 않는다.** 비우면 "파드가 없습니다" 가 떠서 조회 실패가
   * '파드가 다 사라졌다' 로 읽힌다 — 재시작 직후처럼 API 가 잠깐 늦을 때 특히 그렇다.
   * 직전 목록을 둔 채 그것이 몇 초 전 값인지만 밝힌다(조회 실패 ≠ 장애).
   */
  const fetchPods = async (namespace: string) => {
    if (!namespace) return
    const seq = ++seqRef.current
    setLoading(true)
    const r = await window.electronAPI.k8sListPodsDetail(sessionId, namespace)
    if (seq !== seqRef.current || nsRef.current !== namespace) return
    setLoading(false)
    if (r.ok && r.pods) {
      setPods(r.pods)
      setLoadedAt(Date.now())
      setStale(false)
      setMsg(`${namespace}: 파드 ${r.pods.length}개`)
    } else {
      setStale(true)
      setMsg(`조회 실패 — ${r.error ?? '파드 목록 조회 실패'}`)
    }
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? pods.filter((p) => p.name.toLowerCase().includes(q)) : pods
  }, [pods, query])

  const restart = async (p: PodInfo) => {
    setRestarting((prev) => new Set(prev).add(p.name))
    // 대상 네임스페이스는 **그 행을 받아 온 곳**(p.namespace)이다 — 화면 상태(ns)가 아니다
    const r = await window.electronAPI.k8sRestartPod(sessionId, p.namespace, p.name)
    if (!r.ok) {
      setRestarting((prev) => {
        const s = new Set(prev)
        s.delete(p.name)
        return s
      })
      setMsg(r.error || `${p.name} 재시작에 실패했습니다.`)
      return
    }
    setMsg(`${p.name} 재시작 요청을 보냈습니다 — 목록을 다시 불러옵니다.`)
    // 삭제 직후엔 Terminating 상태라 바로 다시 조회해도 그대로 보인다. 컨트롤러가 있으면 보통
    // 수 초 안에 새 파드가 뜨므로, 잠깐 뒤 한 번 더 불러온다 — 그 사이 다른 네임스페이스로
    // 옮겨 갔으면 부르지 않는다(옛 목록으로 화면을 되돌려 놓게 된다).
    await fetchPods(p.namespace)
    setTimeout(() => {
      if (nsRef.current === p.namespace) void fetchPods(p.namespace)
    }, 3000)
    setRestarting((prev) => {
      const s = new Set(prev)
      s.delete(p.name)
      return s
    })
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 네임스페이스 선택 */}
      <div className="flex items-center gap-2 border-b border-white/10 px-4 py-2">
        <select
          value={ns}
          onChange={(e) => selectNs(e.target.value)}
          className="rounded-md border border-white/10 bg-panel-light px-2 py-1.5 text-xs text-gray-200 focus:outline-none"
        >
          <option value="">네임스페이스 선택…</option>
          {namespaces.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        <div className="relative min-w-0 flex-1">
          <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-500" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="파드 이름 검색…"
            disabled={!ns}
            className="w-full rounded-md border border-white/10 bg-panel-light py-1.5 pl-7 pr-2 text-xs text-gray-200 outline-none placeholder:text-gray-600 focus:ring-1 focus:ring-blue-500 disabled:opacity-50"
          />
        </div>
        <button
          onClick={() => ns && fetchPods(ns)}
          disabled={!ns || loading}
          title="새로고침"
          className="shrink-0 rounded p-1.5 text-gray-400 hover:bg-white/10 hover:text-gray-200 disabled:opacity-40"
        >
          {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
        </button>
      </div>

      {msg && (
        <div
          className={
            'border-b border-white/10 px-4 py-1.5 text-[11px] ' +
            (stale ? 'bg-amber-500/[0.08] text-amber-200/90' : 'text-gray-400')
          }
        >
          {msg}
          {stale && loadedAt && (
            <span className="ml-1.5 text-amber-200/70">
              · 아래 목록은 {Math.max(1, Math.round((Date.now() - loadedAt) / 1000))}초 전 값입니다
            </span>
          )}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        {!ns ? (
          <div className="flex h-full items-center justify-center text-xs text-gray-500">
            네임스페이스를 먼저 선택하세요.
          </div>
        ) : (
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-panel text-gray-500">
              <tr>
                <th className="px-3 py-1.5 text-left font-medium">이름</th>
                <th className="px-2 py-1.5 text-left font-medium">상태</th>
                <th className="px-2 py-1.5 text-right font-medium">준비</th>
                <th className="px-2 py-1.5 text-right font-medium">재시작횟수</th>
                <th className="px-2 py-1.5 text-left font-medium">생성</th>
                <th className="px-2 py-1.5 text-left font-medium">노드</th>
                <th className="w-[172px]" />
              </tr>
            </thead>
            <tbody>
              {!loading && filtered.length === 0 && (
                <tr>
                  <td colSpan={7} className="py-6 text-center text-gray-500">
                    {/* 한 번도 못 받았으면 '없다' 가 아니라 '모른다' 다 */}
                    {loadedAt === null
                      ? '목록을 받지 못했습니다.'
                      : pods.length === 0
                        ? '파드가 없습니다.'
                        : '일치하는 파드가 없습니다.'}
                  </td>
                </tr>
              )}
              {filtered.map((p) => {
                const st = podDisplayStatus(p)
                return (
                <tr key={p.name} className="group border-t border-white/5 hover:bg-white/5">
                  <td className="max-w-[260px] truncate px-3 py-1.5 font-mono text-[11px]" title={p.name}>
                    {p.name}
                  </td>
                  <td className={'whitespace-nowrap px-2 py-1.5 ' + TONE_STYLE[st.tone]} title={`phase: ${p.phase}`}>
                    {st.label}
                  </td>
                  <td className="px-2 py-1.5 text-right text-gray-300">
                    {p.readyCount}/{p.totalContainers}
                  </td>
                  <td className="px-2 py-1.5 text-right text-gray-300">{p.restarts}</td>
                  <td className="px-2 py-1.5 text-gray-400">{fmtAge(p.createdAtMs)}</td>
                  <td className="max-w-[160px] truncate px-2 py-1.5 text-gray-500" title={p.node}>
                    {p.node ?? '—'}
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    {/* 아이콘만 두고 마우스를 올려야 보이게 했더니(ProcessListModal 의 종료 버튼과
                        같은 방식) 버튼이 있는지조차 알아보기 어렵다는 피드백이 있었다. 이 탭에서
                        로그 보기·재시작은 '가끔 쓰는 부가 기능'이 아니라 탭의 주 목적이라 늘 보이는
                        글자 버튼으로 둔다. */}
                    <div className="inline-flex items-center gap-1.5">
                      {onOpenLiveLog && (
                        <button
                          onClick={() => onOpenLiveLog(p.namespace, p.name)}
                          title={`${p.name} 실시간 로그 보기`}
                          className="inline-flex items-center gap-1 whitespace-nowrap rounded border border-white/15 px-2 py-1 text-[11px] text-gray-300 hover:border-emerald-400/50 hover:bg-emerald-500/10 hover:text-emerald-200"
                        >
                          <Activity size={12} />
                          로그
                        </button>
                      )}
                      <button
                        onClick={() => setConfirmTarget(p)}
                        disabled={restarting.has(p.name) || p.terminating}
                        title={`${p.name} 재시작`}
                        className="inline-flex items-center gap-1 whitespace-nowrap rounded border border-white/15 px-2 py-1 text-[11px] text-gray-300 hover:border-blue-400/50 hover:bg-blue-500/10 hover:text-blue-200 disabled:opacity-30"
                      >
                        {restarting.has(p.name) ? (
                          <Loader2 size={12} className="animate-spin" />
                        ) : (
                          <RotateCw size={12} />
                        )}
                        재시작
                      </button>
                    </div>
                  </td>
                </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {confirmTarget && (
        <ConfirmDialog
          title="파드 재시작"
          confirmLabel="재시작"
          message={restartMessage(confirmTarget)}
          onCancel={() => setConfirmTarget(null)}
          onConfirm={() => {
            const p = confirmTarget
            setConfirmTarget(null)
            restart(p)
          }}
        />
      )}

      {!connected && (
        <div className="flex items-center gap-1.5 border-t border-white/10 bg-amber-500/[0.08] px-4 py-1.5 text-[11px] text-amber-200/90">
          <AlertTriangle size={12} /> SSH 연결이 필요합니다.
        </div>
      )}
    </div>
  )
}
