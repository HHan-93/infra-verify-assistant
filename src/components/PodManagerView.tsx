import { useEffect, useMemo, useRef, useState } from 'react'
import { Search, Loader2, RotateCw, RefreshCw, AlertTriangle, Activity } from 'lucide-react'
import type { PodInfo } from '../../electron/shared-types'
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

const PHASE_STYLE: Record<string, string> = {
  Running: 'text-emerald-300',
  Pending: 'text-amber-300',
  Succeeded: 'text-gray-400',
  Failed: 'text-red-400',
  Unknown: 'text-gray-500',
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

  const nsFetchedRef = useRef('')
  useEffect(() => {
    if (!connected || !active) return
    if (nsFetchedRef.current === sessionId) return
    nsFetchedRef.current = sessionId
    window.electronAPI.k8sListNamespaces(sessionId).then((r) => {
      if (r.ok && r.namespaces) setNamespaces(r.namespaces)
      else setMsg(r.error ?? '네임스페이스를 가져오지 못했습니다.')
    })
  }, [sessionId, connected, active])

  const loadPods = async (namespace: string) => {
    setNs(namespace)
    setPods([])
    if (!namespace) return
    setLoading(true)
    const r = await window.electronAPI.k8sListPodsDetail(sessionId, namespace)
    setLoading(false)
    if (r.ok && r.pods) {
      setPods(r.pods)
      setMsg(`${namespace}: 파드 ${r.pods.length}개`)
    } else setMsg(r.error ?? '파드 목록 조회 실패')
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? pods.filter((p) => p.name.toLowerCase().includes(q)) : pods
  }, [pods, query])

  const restart = async (p: PodInfo) => {
    setRestarting((prev) => new Set(prev).add(p.name))
    const r = await window.electronAPI.k8sRestartPod(sessionId, ns, p.name)
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
    // 수 초 안에 새 파드가 뜨므로, 잠깐 뒤 한 번 더 불러온다.
    await loadPods(ns)
    setTimeout(() => loadPods(ns), 3000)
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
          onChange={(e) => loadPods(e.target.value)}
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
          onClick={() => ns && loadPods(ns)}
          disabled={!ns || loading}
          title="새로고침"
          className="shrink-0 rounded p-1.5 text-gray-400 hover:bg-white/10 hover:text-gray-200 disabled:opacity-40"
        >
          {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
        </button>
      </div>

      {msg && <div className="border-b border-white/10 px-4 py-1.5 text-[11px] text-gray-400">{msg}</div>}

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
                    {pods.length === 0 ? '파드가 없습니다.' : '일치하는 파드가 없습니다.'}
                  </td>
                </tr>
              )}
              {filtered.map((p) => (
                <tr key={p.name} className="group border-t border-white/5 hover:bg-white/5">
                  <td className="max-w-[260px] truncate px-3 py-1.5 font-mono text-[11px]" title={p.name}>
                    {p.name}
                  </td>
                  <td className={'px-2 py-1.5 ' + (PHASE_STYLE[p.phase] ?? 'text-gray-300')}>
                    {p.terminating ? 'Terminating' : p.phase}
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
                          onClick={() => onOpenLiveLog(ns, p.name)}
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
              ))}
            </tbody>
          </table>
        )}
      </div>

      {confirmTarget && (
        <ConfirmDialog
          title="파드 재시작"
          confirmLabel="재시작"
          message={
            confirmTarget.ownerKind
              ? `"${confirmTarget.name}" 파드를 재시작할까요?\n${confirmTarget.ownerKind}가 관리하는 파드라, 삭제 직후 새 파드로 자동 재생성됩니다.`
              : `⚠ "${confirmTarget.name}" 파드는 관리하는 컨트롤러가 없습니다.\n지금 재시작하면 다시 생기지 않고 완전히 삭제됩니다 — 정말 진행할까요?`
          }
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
