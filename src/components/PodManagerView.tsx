import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import {
  Search,
  Loader2,
  RotateCw,
  RefreshCw,
  AlertTriangle,
  Activity,
  ChevronRight,
  ChevronDown,
  CheckCircle2,
  XCircle,
  X,
} from 'lucide-react'
import type { PodInfo, PodEvent } from '../../electron/shared-types'
import { podDisplayStatus, type PodTone } from '../lib/podStatus'
import { startRestartTrack, stepRestartTrack, type RestartTrack } from '../lib/podRestart'
import { maskForDisplay } from '../lib/mask'
import {
  analyzePodEvents,
  explainEvent,
  STAGE_LABEL,
  type AnnotatedWarning,
  type HeadlineTone,
  type StageState,
} from '../lib/podEvents'
import ConfirmDialog from './ConfirmDialog'

/**
 * "3시간 전" 식 표시 — 저장은 늘 epoch ms, 사람에게 보일 때만 이렇게 바꾼다.
 * ms 는 서버 시계로 찍힌 시각이라, 지금(이 PC 시계)에 skew(서버 − PC)를 더해 같은 기준으로 맞춘다.
 */
function fmtAge(ms: number | undefined, skewMs: number): string {
  if (!ms) return '-'
  const d = Date.now() + skewMs - ms
  // skew 를 못 잰 호스트(date 가 %3N 을 모름)에서는 시계 차이로 음수가 나올 수 있다 — '방금' 으로 둔다
  if (d < 0) return '방금'
  // 갓 뜬 파드는 초 단위로 — 1초 자동 갱신과 함께 재시작 직후 새 파드가 몇 초째인지 보이게.
  // 10분까지는 kubectl 의 AGE(2m30s) 처럼 분·초를 같이 쓴다
  const sec = Math.floor(d / 1000)
  if (sec < 60) return `${sec}초 전`
  const min = Math.floor(sec / 60)
  if (min < 10) return `${min}분 ${sec % 60}초 전`
  if (min < 60) return `${min}분 전`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}시간 전`
  return `${Math.floor(hr / 24)}일 전`
}

/**
 * 자동 새로고침 간격 — 재시작을 누른 뒤 Terminating → ContainerCreating → Running 이 바뀌는 것을
 * 그 자리에서 보려는 것이다(2026-10-08 사용자 요청). setInterval 이 아니라 **직전 조회가 끝난 뒤**
 * 이만큼 쉬고 다음을 부른다 — kubectl 이 1초보다 느리면 요청이 겹겹이 쌓여 SSH 슬롯(연결당 4)을
 * 상태보드와 나눠 먹게 되므로, 느리면 간격이 저절로 늘어나게 둔다.
 */
const AUTO_REFRESH_MS = 1000
const AUTO_KEY = 'pod_auto_refresh'

const TONE_STYLE: Record<PodTone, string> = {
  ok: 'text-emerald-300',
  warn: 'text-amber-300',
  bad: 'text-red-400',
  done: 'text-gray-400',
}

/** 재시작 확인창 문구 — 지운 뒤 무엇이 일어나는지는 소유 컨트롤러와 상태에 따라 다르다 */
function restartMessage(p: PodInfo): string {
  if (!p.ownerKind)
    return `⚠ "${p.name}" 파드는 관리하는 컨트롤러가 없습니다.\n지금 재시작하면 다시 생기지 않고 완전히 삭제됩니다. 정말 진행할까요?`
  // 끝난 Job 의 파드는 Job 이 이미 완료로 기록했으므로 지워도 새로 만들지 않는다
  if (p.ownerKind === 'Job' && (p.phase === 'Succeeded' || p.phase === 'Failed'))
    return `"${p.name}" 는 이미 끝난 Job 의 파드입니다.\n삭제하면 다시 생기지 않습니다(재실행되지 않음): 진행할까요?`
  return `"${p.name}" 파드를 재시작할까요?\n${p.ownerKind}가 관리하는 파드라, 삭제 직후 새 파드로 자동 재생성됩니다.`
}

/** 걸린 시간 — "14초" · "1분 5초" */
function fmtDur(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s}초` : `${Math.floor(s / 60)}분 ${s % 60}초`
}

/**
 * skew 표본을 몇 개 모아 고르는가. 표본은 '호스트 시각 − 받은 직후 PC 시각' 이라 돌아오는 지연만큼
 * **늘 작게** 나온다 — 그래서 평균이 아니라 최근 것 중 가장 큰 값이 참값에 가장 가깝다.
 */
const SKEW_SAMPLES = 10

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
  /** 서버 시계 − 이 PC 시계(ms). 못 쟀으면 0 — 생성 시각과 재시작 추적이 이 값으로 같은 기준에 선다 */
  const [skewMs, setSkewMs] = useState(0)
  const skewSamplesRef = useRef<number[]>([])
  const skewRef = useRef(0)
  skewRef.current = skewMs
  /** 진행 중이거나 막 끝난 재시작들 — 위쪽 띠에 '몇 초 만에 Ready' 를 보여준다 */
  const [tracks, setTracks] = useState<RestartTrack[]>([])
  /** 펼친 행(파드 이름)과 그 파드의 이벤트 */
  const [expanded, setExpanded] = useState<string | null>(null)
  const [events, setEvents] = useState<{ pod: string; loading: boolean; list?: PodEvent[]; error?: string } | null>(
    null,
  )

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
  /** 사람이 누른 조회가 진행 중인가 — 그동안 자동 조회는 건너뛴다(자동이 seq 를 올려 그 응답을 버리게 하면 스피너가 멈추지 않는다) */
  const manualBusyRef = useRef(false)
  const [auto, setAuto] = useState(() => {
    try {
      return localStorage.getItem(AUTO_KEY) !== '0'
    } catch {
      return true
    }
  })
  const toggleAuto = () => {
    setAuto((v) => {
      try {
        localStorage.setItem(AUTO_KEY, v ? '0' : '1')
      } catch {
        /* 저장 못 해도 이번 화면에서는 동작한다 */
      }
      return !v
    })
  }

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
    setTracks([])
    setExpanded(null)
    setEvents(null)
    skewSamplesRef.current = []
    setSkewMs(0)
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
    setExpanded(null)
    setEvents(null)
    // 재시작 추적은 비우지 않는다 — 돌아오면 이어서 관측한다(다른 네임스페이스 목록에는 대 보지 않는다)
    void fetchPods(namespace)
  }

  /**
   * 지금 네임스페이스의 목록을 다시 받는다.
   *
   * **실패해도 직전 목록을 지우지 않는다.** 비우면 "파드가 없습니다" 가 떠서 조회 실패가
   * '파드가 다 사라졌다' 로 읽힌다 — 재시작 직후처럼 API 가 잠깐 늦을 때 특히 그렇다.
   * 직전 목록을 둔 채 그것이 몇 초 전 값인지만 밝힌다(조회 실패 ≠ 장애).
   */
  const fetchPods = async (namespace: string, silent = false) => {
    if (!namespace) return
    // 자동 조회는 사람이 누른 조회를 앞지르지 않는다 — 결과는 어차피 곧 그쪽에서 온다
    if (silent && manualBusyRef.current) return
    const seq = ++seqRef.current
    if (!silent) {
      manualBusyRef.current = true
      setLoading(true)
    }
    let r: Awaited<ReturnType<typeof window.electronAPI.k8sListPodsDetail>>
    try {
      r = await window.electronAPI.k8sListPodsDetail(sessionId, namespace)
    } catch (e) {
      r = { ok: false, error: e instanceof Error ? e.message : String(e) }
    } finally {
      if (!silent) {
        manualBusyRef.current = false
        setLoading(false)
      }
    }
    if (seq !== seqRef.current || nsRef.current !== namespace) return
    if (r.ok && r.pods) {
      const now = Date.now()
      if (typeof r.skewMs === 'number') {
        const xs = [...skewSamplesRef.current, r.skewMs].slice(-SKEW_SAMPLES)
        skewSamplesRef.current = xs
        setSkewMs(Math.max(...xs))
      }
      const got = r.pods
      // 성공한 목록만 관측으로 쓴다 — 실패한 회차를 '옛 파드가 사라졌다' 로 읽으면 안 된다
      setTracks((ts) => ts.map((t) => (t.namespace === namespace ? stepRestartTrack(t, got, now) : t)))
      setPods(got)
      setLoadedAt(now)
      // 자동 조회는 위쪽 문구(재시작 요청 결과 등)를 매초 덮지 않는다 — 실패 문구만 걷어 낸다.
      // 파드 개수 줄은 문구가 비었을 때 목록에서 바로 그리므로 따로 갱신할 필요가 없다.
      if (!silent || staleRef.current) setMsg('')
      setStale(false)
    } else {
      setStale(true)
      setMsg(`조회 실패: ${r.error ?? '파드 목록 조회 실패'}`)
    }
  }

  const staleRef = useRef(false)
  staleRef.current = stale

  // 자동 새로고침 — 이 탭이 보이고, 연결돼 있고, 네임스페이스를 골랐을 때만 돈다. 이 컴포넌트는
  // 다른 탭에 있어도 숨김으로 붙어 있으므로 active 를 빼면 보지도 않는 목록을 매초 받는다.
  // 설정 관리 창을 닫으면 컴포넌트째 사라지며 정리된다.
  useEffect(() => {
    if (!auto || !active || !connected || !ns) return
    let stopped = false
    let timer: number | undefined
    const tick = async () => {
      await fetchPods(ns, true)
      if (!stopped) timer = window.setTimeout(tick, AUTO_REFRESH_MS)
    }
    timer = window.setTimeout(tick, AUTO_REFRESH_MS)
    return () => {
      stopped = true
      window.clearTimeout(timer)
    }
    // fetchPods 는 sessionId 만 바깥에서 읽는다 — 그 값이 바뀌면 다시 건다
  }, [auto, active, connected, ns, sessionId])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? pods.filter((p) => p.name.toLowerCase().includes(q)) : pods
  }, [pods, query])

  const restart = async (p: PodInfo) => {
    setRestarting((prev) => new Set(prev).add(p.name))
    // 재는 기준은 '요청을 보낸 순간' — 응답이 온 뒤로 잡으면 kubectl 왕복만큼 짧게 잰다.
    // 컨트롤러가 없거나 이미 끝난 Job 은 다시 생기지 않으므로 잴 것이 없다.
    // 정적 파드(ownerKind Node)는 버튼부터 막혀 있지만, 혹시 들어와도 재지 않는다 — 지우면 같은 컨테이너의
    // 그림자 객체가 새 uid 로 곧장 다시 생겨 '1초 만에 Ready' 라는 거짓 복구 시간이 찍힌다
    const track =
      p.ownerKind &&
      p.ownerKind !== 'Node' &&
      !(p.ownerKind === 'Job' && (p.phase === 'Succeeded' || p.phase === 'Failed'))
        ? startRestartTrack(p, Date.now(), skewRef.current)
        : null
    // 최근 것부터 6건까지 — 띠가 표를 밀어내지 않게. 끝난 것은 X 로 치울 수 있다
    if (track) setTracks((ts) => [track, ...ts].slice(0, 6))
    // 대상 네임스페이스는 **그 행을 받아 온 곳**(p.namespace)이다 — 화면 상태(ns)가 아니다
    const r = await window.electronAPI.k8sRestartPod(sessionId, p.namespace, p.name)
    if (!r.ok) {
      setRestarting((prev) => {
        const s = new Set(prev)
        s.delete(p.name)
        return s
      })
      if (track) setTracks((ts) => ts.filter((t) => t.id !== track.id))
      setMsg(r.error || `${p.name} 재시작에 실패했습니다.`)
      return
    }
    await fetchPods(p.namespace)
    if (!track) setMsg(`${p.name} 삭제 요청을 보냈습니다.`)
    // 자동 새로고침이 꺼져 있을 때만: 삭제 직후엔 새 파드가 아직 안 떴을 수 있어 잠깐 뒤 한 번 더
    // 불러온다 — 그 사이 다른 네임스페이스로 옮겨 갔으면 부르지 않는다(옛 목록으로 화면을 되돌려
    // 놓게 된다). 켜져 있으면 1초 갱신이 그 일을 한다.
    if (!auto)
      setTimeout(() => {
        if (nsRef.current === p.namespace) void fetchPods(p.namespace)
      }, 3000)
    setRestarting((prev) => {
      const s = new Set(prev)
      s.delete(p.name)
      return s
    })
  }

  /** 이벤트는 펼칠 때 한 번 받는다(1초 갱신에 얹지 않는다 — 파드마다 API 를 한 번씩 더 두드린다) */
  const loadEvents = async (p: PodInfo) => {
    setEvents({ pod: p.name, loading: true })
    const r = await window.electronAPI.k8sPodEvents(sessionId, p.namespace, p.name, p.uid)
    setEvents((cur) =>
      cur?.pod !== p.name
        ? cur
        : r.ok
          ? { pod: p.name, loading: false, list: r.events ?? [] }
          : { pod: p.name, loading: false, error: r.error ?? '이벤트 조회 실패' },
    )
  }
  const toggleExpand = (p: PodInfo) => {
    if (expanded === p.name) {
      setExpanded(null)
      setEvents(null)
      return
    }
    setExpanded(p.name)
    void loadEvents(p)
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
          onClick={toggleAuto}
          title={auto ? '1초마다 자동 새로고침 중: 누르면 끕니다' : '자동 새로고침 꺼짐: 누르면 1초마다 갱신합니다'}
          className={
            'flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border px-2 py-1 text-[11px] ' +
            (auto
              ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
              : 'border-white/10 text-gray-400 hover:bg-white/5')
          }
        >
          <span
            className={
              'h-1.5 w-1.5 rounded-full ' +
              (auto && active && connected && ns && !stale ? 'animate-pulse bg-emerald-400' : auto ? 'bg-emerald-700' : 'bg-gray-600')
            }
          />
          자동 1초
        </button>
        <button
          onClick={() => ns && fetchPods(ns)}
          disabled={!ns || loading}
          title="새로고침"
          className="shrink-0 rounded p-1.5 text-gray-400 hover:bg-white/10 hover:text-gray-200 disabled:opacity-40"
        >
          {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
        </button>
      </div>

      {(msg || (ns && loadedAt)) && (
        <div
          className={
            'border-b border-white/10 px-4 py-1.5 text-[11px] ' +
            (stale ? 'bg-amber-500/[0.08] text-amber-200/90' : 'text-gray-400')
          }
        >
          {/* 문구가 없으면 개수 줄 — 목록에서 바로 세므로 자동 갱신 중에도 늘 맞다 */}
          {msg || `${ns}: 파드 ${pods.length}개`}
          {stale && loadedAt && (
            <span className="ml-1.5 text-amber-200/70">
              · 아래 목록은 {Math.max(1, Math.round((Date.now() - loadedAt) / 1000))}초 전 값입니다
            </span>
          )}
        </div>
      )}

      {/* 재시작 추적 띠 — 누른 뒤 새 파드가 Ready 가 되기까지 걸린 시간 */}
      {tracks.length > 0 && (
        <div className="space-y-1 border-b border-white/10 px-4 py-1.5 text-[11px]">
          {tracks.map((t) => {
            const done = t.readyAt !== undefined
            const elsewhere = t.namespace !== ns
            return (
              <div key={t.id} className="flex items-center gap-1.5">
                {done ? (
                  <CheckCircle2 size={12} className="shrink-0 text-emerald-400" />
                ) : t.timedOut ? (
                  <AlertTriangle size={12} className="shrink-0 text-amber-400" />
                ) : (
                  <Loader2 size={12} className="shrink-0 animate-spin text-blue-300" />
                )}
                <span className="min-w-0 truncate text-gray-300">
                  <span className="font-mono">{t.oldName}</span> 재시작
                  {done ? (
                    <>
                      {' → '}
                      <span className="font-mono">{t.newName}</span>{' '}
                      <span className="text-emerald-300">Ready 까지 약 {fmtDur(t.readyAt! - t.startedAt)}</span>
                      {t.oldGoneAt !== undefined && (
                        <span className="text-gray-500"> · 옛 파드 종료 {fmtDur(t.oldGoneAt - t.startedAt)}</span>
                      )}
                    </>
                  ) : t.timedOut ? (
                    <span className="text-amber-300"> 10분 안에 Ready 가 되지 않았습니다</span>
                  ) : (
                    <span className="text-gray-400">
                      {' · '}
                      {t.newName ? (
                        <>
                          새 파드 <span className="font-mono">{t.newName}</span> Ready 기다리는 중
                        </>
                      ) : t.oldTerminating ? (
                        '옛 파드 종료 중'
                      ) : (
                        '새 파드 기다리는 중'
                      )}
                      {' · '}
                      {fmtDur(Date.now() - t.startedAt)} 경과
                    </span>
                  )}
                  {!done && !t.timedOut && elsewhere && (
                    <span className="text-gray-500"> ({t.namespace} 로 돌아오면 이어서 잽니다)</span>
                  )}
                  {!done && !t.timedOut && !auto && (
                    <span className="text-amber-200/70"> · 자동 갱신이 꺼져 있어 새로고침할 때만 잽니다</span>
                  )}
                </span>
                <button
                  onClick={() => setTracks((ts) => ts.filter((x) => x.id !== t.id))}
                  title="이 줄 닫기"
                  className="ml-auto shrink-0 rounded p-0.5 text-gray-500 hover:bg-white/10 hover:text-gray-300"
                >
                  <X size={11} />
                </button>
              </div>
            )
          })}
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
                <th className="whitespace-nowrap px-2 py-1.5 text-right font-medium">재시작</th>
                <th className="whitespace-nowrap px-2 py-1.5 text-left font-medium">생성</th>
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
                const open = expanded === p.name
                // 진행 중인 재시작이 짝으로 잡은 새 파드 — 표에서 어느 줄인지 바로 보이게
                const isNew = tracks.some((t) => t.newName === p.name && t.readyAt === undefined && !t.timedOut)
                return (
                <Fragment key={p.name}>
                <tr
                  className={
                    'group border-t border-white/5 hover:bg-white/5 ' +
                    (open ? 'bg-white/[0.04] ' : '') +
                    (isNew ? 'bg-blue-500/[0.07]' : '')
                  }
                >
                  <td className="max-w-[260px] px-3 py-1.5 font-mono text-[11px]" title={`${p.name}\n누르면 컨테이너 상태와 최근 이벤트를 펼칩니다`}>
                    <button
                      onClick={() => toggleExpand(p)}
                      className="flex w-full min-w-0 items-center gap-1 text-left hover:text-white"
                    >
                      {open ? (
                        <ChevronDown size={12} className="shrink-0 text-gray-400" />
                      ) : (
                        <ChevronRight size={12} className="shrink-0 text-gray-600 group-hover:text-gray-400" />
                      )}
                      <span className="truncate">{p.name}</span>
                    </button>
                  </td>
                  <td className={'whitespace-nowrap px-2 py-1.5 ' + TONE_STYLE[st.tone]} title={`phase: ${p.phase}`}>
                    {st.label}
                  </td>
                  <td className="px-2 py-1.5 text-right text-gray-300">
                    {p.readyCount}/{p.totalContainers}
                  </td>
                  <td className="px-2 py-1.5 text-right text-gray-300">{p.restarts}</td>
                  <td className="whitespace-nowrap px-2 py-1.5 text-gray-400">{fmtAge(p.createdAtMs, skewMs)}</td>
                  <td className="max-w-[160px] truncate px-2 py-1.5 text-gray-500" title={p.node}>
                    {p.node ?? '-'}
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
                        disabled={restarting.has(p.name) || p.terminating || p.ownerKind === 'Node'}
                        title={
                          p.ownerKind === 'Node'
                            ? `${p.name} 는 정적 파드(노드의 매니페스트로 kubelet 이 직접 띄움)라 여기서 재시작할 수 없습니다. 지워도 API 의 그림자 객체만 다시 생기고 컨테이너는 그대로입니다. 그 노드에서 매니페스트를 옮기거나 crictl 로 재시작하세요.`
                            : `${p.name} 재시작`
                        }
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
                {open && (
                  <tr className="bg-black/20">
                    <td colSpan={7} className="px-4 pb-3 pt-2">
                      <PodDetail
                        pod={p}
                        skewMs={skewMs}
                        events={events?.pod === p.name ? events : null}
                        onReloadEvents={() => loadEvents(p)}
                      />
                    </td>
                  </tr>
                )}
                </Fragment>
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

const KIND_LABEL: Record<string, string> = { main: '', init: 'init', sidecar: '사이드카' }

/**
 * 컨테이너 상태의 표시 — 위 파드 표의 상태 칸(Running · CrashLoopBackOff)과 같은 표기로 맞춘다.
 * 값은 메인이 주는 `running` · `waiting:원인` · `terminated:원인` 그대로 두고(색 판정이 그 값을 쓴다)
 * 보여줄 때만 kubectl describe 의 `State: Waiting / Reason: …` 처럼 대문자로 바꾼다.
 */
function stateLabel(state: string): string {
  const [kind, reason] = state.split(':')
  const K = kind.charAt(0).toUpperCase() + kind.slice(1)
  return reason ? `${K}: ${reason}` : K
}

/** 컨테이너 지금 상태의 색 — running 이어도 Ready 가 아니면 주황 */
function stateTone(state: string, ready: boolean): string {
  if (state === 'running') return ready ? 'text-emerald-300' : 'text-amber-300'
  if (state === 'terminated:Completed') return 'text-gray-400'
  if (state === 'waiting:ContainerCreating' || state === 'waiting:PodInitializing') return 'text-amber-300'
  return 'text-red-400'
}

/**
 * 펼친 행 — **왜 이 상태인가.** 상태 칸은 CrashLoopBackOff 라는 이름만 말해 준다. 정작 필요한
 * 것은 바로 전에 왜 죽었는지(lastState: OOMKilled · exit 137)와 이벤트(probe 실패 · 이미지 못 받음 ·
 * 스케줄 실패)다. 지금까지는 그걸 보려면 터미널로 가서 describe 를 쳐야 했다.
 *
 * 메시지에는 이미지 주소·환경값이 섞일 수 있어 화면 표시용 마스킹을 거친다(로그 표시와 같은 경로).
 */
function PodDetail({
  pod,
  skewMs,
  events,
  onReloadEvents,
}: {
  pod: PodInfo
  skewMs: number
  events: { loading: boolean; list?: PodEvent[]; error?: string } | null
  onReloadEvents: () => void
}) {
  const cs = pod.containers ?? []
  const [showRaw, setShowRaw] = useState(false)
  const loaded = !!events && !events.loading && !events.error
  // 이벤트를 못 받았어도 결론 줄은 컨테이너 상태만으로 낸다 — 대신 그 사실을 밝힌다
  const an = analyzePodEvents(pod, loaded ? (events!.list ?? []) : [])
  const H = HEADLINE_STYLE[an.headline.tone]
  return (
    <div className="space-y-3 text-[11px]">
      {/* ① 한 줄 결론 */}
      <div className={'rounded-md border px-3 py-2 ' + H.box}>
        <div className={'flex items-center gap-1.5 text-xs font-medium ' + H.text}>
          <H.Icon size={13} className="shrink-0" />
          {an.headline.text}
        </div>
        {an.headline.hint && <div className="mt-0.5 pl-[19px] text-gray-300">→ {an.headline.hint}</div>}
        {!loaded && (
          <div className="mt-0.5 pl-[19px] text-gray-500">
            {events?.error ? '이벤트를 받지 못해 컨테이너 상태만 보고 판단했습니다.' : '이벤트를 받는 중…'}
          </div>
        )}
      </div>

      {/* ② 단계 */}
      {loaded && an.stages.length > 0 && (
        <div className="flex flex-wrap items-start gap-x-1 gap-y-2">
          {an.stages.map((s, i) => {
            const S = STAGE_STYLE[s.state]
            return (
              <Fragment key={s.stage}>
                {i > 0 && <div className="mt-[7px] h-px w-5 shrink-0 bg-white/15" />}
                <div className="min-w-[88px]">
                  <div className={'flex items-center gap-1 ' + S.text}>
                    <span className="font-medium">{STAGE_LABEL[s.stage]}</span>
                    <span>{S.mark}</span>
                  </div>
                  <div className="text-[10px] text-gray-500">
                    {s.lastAtMs !== undefined && <div>{fmtClock(s.lastAtMs)}</div>}
                    {s.notes.map((n) => (
                      <div key={n}>{n}</div>
                    ))}
                  </div>
                </div>
              </Fragment>
            )
          })}
        </div>
      )}

      {/* ③ 경고 — 지금 것은 위에 강조, 풀린 것은 아래에 흐리게 */}
      {loaded && an.current.length > 0 && (
        <div>
          <div className="mb-1 text-amber-300">지금 경고 {an.current.length}</div>
          <div className="space-y-1.5">
            {an.current.map((w, i) => (
              <WarningLine key={i} w={w} skewMs={skewMs} />
            ))}
          </div>
        </div>
      )}
      {loaded && an.past.length > 0 && (
        <div>
          <div className="mb-1 text-gray-500">해결된 경고 {an.past.length}</div>
          <div className="space-y-1.5 opacity-70">
            {an.past.map((w, i) => (
              <WarningLine key={i} w={w} skewMs={skewMs} />
            ))}
          </div>
        </div>
      )}

      {/* 컨테이너 */}
      <div>
        <div className="mb-1 text-gray-500">컨테이너</div>
        {cs.length === 0 ? (
          <div className="text-gray-500">컨테이너 상태가 아직 없습니다(스케줄 전이거나 막 생성됨).</div>
        ) : (
          <table className="w-full">
            <thead className="text-gray-600">
              <tr>
                <th className="py-0.5 pr-3 text-left font-normal">이름</th>
                <th className="py-0.5 pr-3 text-left font-normal">지금 상태</th>
                <th className="py-0.5 pr-3 text-right font-normal">준비</th>
                <th className="py-0.5 pr-3 text-right font-normal">재시작</th>
                <th className="py-0.5 text-left font-normal">직전 종료</th>
              </tr>
            </thead>
            <tbody>
              {cs.map((c) => {
                const lt = c.lastTerminated
                return (
                  <tr key={`${c.kind}/${c.name}`} className="align-top">
                    <td className="py-0.5 pr-3 font-mono">
                      {c.name}
                      {KIND_LABEL[c.kind] && <span className="ml-1 text-[10px] text-gray-500">({KIND_LABEL[c.kind]})</span>}
                    </td>
                    <td className={'py-0.5 pr-3 ' + stateTone(c.state, c.ready)}>
                      {stateLabel(c.state)}
                      {c.stateMessage && (
                        <div className="max-w-[420px] whitespace-pre-wrap break-all text-gray-500">
                          {maskForDisplay(c.stateMessage).slice(0, 400)}
                        </div>
                      )}
                    </td>
                    <td className="py-0.5 pr-3 text-right text-gray-300">{c.ready ? '예' : '아니오'}</td>
                    <td className="py-0.5 pr-3 text-right text-gray-300">{c.restartCount}</td>
                    <td className="py-0.5 text-gray-400">
                      {lt ? (
                        <>
                          <span className={lt.reason === 'Completed' ? 'text-gray-400' : 'text-red-300'}>
                            {lt.reason ?? '종료'}
                          </span>
                          {lt.exitCode !== undefined && <span> (exit {lt.exitCode})</span>}
                          {lt.finishedAtMs !== undefined && (
                            <span className="text-gray-500"> · {fmtAge(lt.finishedAtMs, skewMs)}</span>
                          )}
                          {lt.message && (
                            <div className="max-w-[420px] whitespace-pre-wrap break-all text-gray-500">
                              {maskForDisplay(lt.message).slice(0, 400)}
                            </div>
                          )}
                        </>
                      ) : (
                        <span className="text-gray-600">-</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* ④ 원문 이벤트 — 접어 둔다 */}
      <div>
        <div className="flex items-center gap-2 text-gray-500">
          <button
            onClick={() => setShowRaw((v) => !v)}
            disabled={!loaded || an.ordered.length === 0}
            className="flex items-center gap-1 hover:text-gray-300 disabled:hover:text-gray-500"
          >
            {showRaw ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
            {!events || events.loading
              ? '이벤트 불러오는 중…'
              : events.error
                ? `이벤트를 받지 못했습니다. ${events.error}`
                : an.ordered.length === 0
                  ? '이벤트 기록이 없습니다 (클러스터는 이벤트를 보통 1시간 뒤 지웁니다. 없다고 정상인 것은 아닙니다)'
                  : `원문 이벤트 ${an.ordered.length}개 ${showRaw ? '접기' : '보기'}`}
          </button>
          <button
            onClick={onReloadEvents}
            disabled={events?.loading}
            title="이벤트 다시 받기"
            className="rounded p-0.5 hover:bg-white/10 hover:text-gray-300 disabled:opacity-40"
          >
            {events?.loading ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
          </button>
        </div>
        {showRaw && loaded && (
          <div className="mt-1 space-y-0.5">
            {an.ordered.map((e, i) => (
              <div key={i} className="flex gap-2">
                <span className="w-[64px] shrink-0 whitespace-nowrap text-gray-500" title={fmtAge(e.atMs, skewMs)}>
                  {fmtClock(e.atMs)}
                </span>
                <span
                  className={'w-[150px] shrink-0 truncate ' + (e.type === 'Warning' ? 'text-amber-300' : 'text-gray-300')}
                  title={e.reason}
                >
                  {explainEvent(e).title}
                  {e.count > 1 && <span className="text-gray-500"> ×{e.count}</span>}
                </span>
                <span className="min-w-0 whitespace-pre-wrap break-all text-gray-500">
                  {e.container && <span className="text-gray-400">[{e.container}] </span>}
                  {maskForDisplay(e.message)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/** 경고 한 건 — 사람 말 제목 · 볼 곳 · 풀어 쓴 사정 · (해결됐다면) 무엇으로 */
function WarningLine({ w, skewMs }: { w: AnnotatedWarning; skewMs: number }) {
  const e = w.event
  const resolved = w.resolvedBy
  return (
    <div className={'rounded border-l-2 pl-2 ' + (resolved ? 'border-white/15' : 'border-amber-400/70')}>
      <div className={resolved ? 'text-gray-400' : 'text-amber-200'}>
        <span className="text-gray-500">{STAGE_LABEL[w.stage]} · </span>
        {w.explain.title}
        {e.count > 1 && <span className="text-gray-500"> ×{e.count}</span>}
        <span className="text-gray-500">
          {' · '}
          {fmtAge(e.atMs, skewMs)}
          {e.container && ` · ${e.container}`}
        </span>
      </div>
      {resolved && (
        <div className="text-emerald-300/80">
          {resolved.kind === 'healthy'
            ? '→ 지금은 정상(모든 컨테이너 Ready)'
            : `→ ${fmtClock(resolved.atMs)} '${explainEvent({ ...e, type: 'Normal', reason: resolved.reason }).title}' 로 해결`}
        </div>
      )}
      {w.explain.detail?.map((d) => (
        <div key={d} className="text-gray-400">
          · {d}
        </div>
      ))}
      {!resolved && w.explain.hint && <div className="text-gray-300">볼 곳: {w.explain.hint}</div>}
      <div className="whitespace-pre-wrap break-all text-[10px] text-gray-600">{maskForDisplay(e.message)}</div>
    </div>
  )
}

/** 원문 순서를 가르는 시각 — 'N분 전' 만으로는 같은 분에 몰린 이벤트의 순서가 안 보인다 */
function fmtClock(ms?: number): string {
  if (!ms) return '-'
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

const HEADLINE_STYLE: Record<HeadlineTone, { box: string; text: string; Icon: typeof CheckCircle2 }> = {
  ok: { box: 'border-emerald-500/30 bg-emerald-500/[0.06]', text: 'text-emerald-300', Icon: CheckCircle2 },
  progress: { box: 'border-amber-500/30 bg-amber-500/[0.06]', text: 'text-amber-300', Icon: Loader2 },
  bad: { box: 'border-red-500/40 bg-red-500/[0.07]', text: 'text-red-300', Icon: XCircle },
  done: { box: 'border-white/10 bg-white/[0.03]', text: 'text-gray-300', Icon: CheckCircle2 },
}

const STAGE_STYLE: Record<StageState, { text: string; mark: string }> = {
  ok: { text: 'text-emerald-300', mark: '✔' },
  past: { text: 'text-emerald-300', mark: '✔' },
  warn: { text: 'text-amber-300', mark: '⚠' },
  none: { text: 'text-gray-500', mark: '-' },
}
