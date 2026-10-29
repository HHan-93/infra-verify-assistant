import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, ChevronDown, ChevronRight, FileText, Loader2, Play, RefreshCw, Save, Sparkles, X } from 'lucide-react'
import {
  buildFetchCmd,
  FETCH_MAX_LINES,
  buildLogView,
  buildScanCmd,
  emptyLogWatch,
  groupHeadline,
  mergeScan,
  parseScan,
  type LogGroup,
  type LogWatchState,
  type ViewEntry,
} from '../lib/podLogScan'

/**
 * 파드 로그 이상 감시(사용자 요청 10-28) — 상태보드를 띄워 두면 늘 돈다(검증 중이 아니어도).
 * 판정은 lib/podLogScan, 여기는 훑는 반복 · 이상 목록 창 · 합친 로그 창.
 *
 * 훑기는 상태보드 폴링(DOWN · VIP 감지)과 **따로 돈다** — 파드 수십 개의 로그를 받는 데 몇 초 걸리는데, 폴링 프레임에 넣으면
 * 그만큼 DOWN 감지가 밀린다([8] 과 같은 문제).
 */

/** 기준선 — 감시를 켠 뒤 이만큼은 '평소에도 나는 오류' 로 본다. 첫 훑기는 이만큼 거슬러 받아 바로 기준선을 채운다 */
export const LOG_BASELINE_MS = 5 * 60_000
/** session:run 은 60초에 채널을 닫는다(EXEC_HARD_MS) — 그보다 길게 기다려 봐야 소용없다. 명령 자체는 40초에 스스로 끊는다(SCAN_ALL_SEC) */
const SCAN_TIMEOUT_MS = 58_000
/** 실패가 이어져도 한 번에 거슬러 받는 최대 구간(초) */
const MAX_SINCE_SEC = 900

export interface LogWatchInfo {
  state: LogWatchState
  /** 기준선을 뜨는 중이면 끝나는 시각 */
  baselineUntil: number | null
  scanning: boolean
  err: string
  /** 마지막 훑기에 걸린 시간 */
  lastMs: number
}

export function usePodLogWatch(o: {
  sessionId?: string
  namespaces: string[]
  enabled: boolean
  intervalSec: number
  ignore: string[]
  extraWords: string[]
  /**
   * 검증을 시작한 시각 — **줄과 같은 노드 시계로**(PC 시각 + 호스트 시계 차이). 시작하면 기준선을 닫고(사용자 결정: 그 시점까지 뜬
   * 기준선을 쓴다) 묶음마다 이 시각 뒤의 첫 줄 · 횟수를 잰다(newInRun)
   */
  runningSince: number | null
  /** `${ns}/${pod}` → 재시작 횟수 — 늘어난 파드는 죽기 전 컨테이너 로그도 본다 */
  restarts: Record<string, number>
  onNew?: (groups: LogGroup[]) => void
}): LogWatchInfo & { rescan: () => void } {
  const [info, setInfo] = useState<LogWatchInfo>({ state: emptyLogWatch(), baselineUntil: null, scanning: false, err: '', lastMs: 0 })
  const stRef = useRef<LogWatchState>(emptyLogWatch())
  const startRef = useRef(0)
  const optRef = useRef(o)
  optRef.current = o
  const seenRestarts = useRef<Record<string, number>>({})
  const kick = useRef<() => void>(() => {})
  const nsKey = o.namespaces.join(',')
  useEffect(() => {
    if (!o.enabled || !o.sessionId || !o.namespaces.length) {
      setInfo((s) => ({ ...s, scanning: false }))
      return
    }
    // 대상(세션 · 네임스페이스)이 바뀌면 처음부터 — 다른 클러스터의 기준선을 들고 가면 안 된다
    stRef.current = emptyLogWatch()
    startRef.current = Date.now()
    seenRestarts.current = { ...optRef.current.restarts }
    let alive = true
    let timer: ReturnType<typeof setTimeout> | null = null
    let first = true
    /** 훑는 중 — [지금 훑기] 가 겹쳐 돌면 exec 슬롯(4개)을 둘이 잡아 보드 폴링이 밀렸다(코드 점검 10-29) */
    let busy = false
    /** 마지막으로 성공한 훑기의 시작 시각 — 다음 구간은 여기서부터(+여유) */
    let lastOkStart = 0
    const sid = o.sessionId
    const scan = async () => {
      if (!alive || busy) return
      busy = true
      if (timer) clearTimeout(timer)
      timer = null
      const p = optRef.current
      const now0 = Date.now()
      const baselineUntil = startRef.current + LOG_BASELINE_MS
      // 이 시각 전에 처음 나온 오류는 '평소' — 검증을 시작했으면 그 시각까지만(사용자 결정)
      const baselineBefore = p.runningSince != null ? Math.min(p.runningSince, baselineUntil) : baselineUntil
      const baselineOpen = now0 < baselineBefore
      // 재시작이 늘어난 파드 — 죽기 직전 컨테이너 로그(CrashLoop 의 이유). 본 횟수는 훑기가 **성공한 뒤에** 올린다 —
      // 먼저 올리면 노드를 죽인 직후처럼 훑기가 실패할 때 그 파드의 --previous 를 영영 안 본다(코드 점검 10-29)
      const prev: { ns: string; pod: string }[] = []
      for (const [k, n] of Object.entries(p.restarts)) {
        if (n > (seenRestarts.current[k] ?? n)) {
          const [ns, pod] = k.split('/')
          prev.push({ ns, pod })
        }
      }
      setInfo((s) => ({ ...s, scanning: true, baselineUntil: baselineOpen ? baselineBefore : null }))
      /*
       * 구간: 첫 훑기는 기준선 길이만큼 거슬러(띄우자마자 검증을 시작해도 평소 오류를 걸러 내게). 그 뒤로는 **마지막으로 성공한 훑기의
       * 시작부터** + 15초. 예전엔 '주기 + 15초' 고정이라, 훑기가 16초 넘게 걸리면 구간 사이가 비었고 실패 뒤엔 실패한 동안이 통째로 빠졌다
       * (코드 점검 10-29). 같은 줄은 seen 으로 한 번만 센다. 너무 길면 15분까지만
       */
      const since = first || !lastOkStart ? LOG_BASELINE_MS / 1000 : Math.min(MAX_SINCE_SEC, Math.max(70, Math.ceil((now0 - lastOkStart) / 1000) + 15))
      const cmd = buildScanCmd({ namespaces: p.namespaces, sinceSec: since, prev, extraWords: p.extraWords })
      let tid: ReturnType<typeof setTimeout> | undefined
      const r = await Promise.race([
        window.electronAPI.sessionRun(sid, cmd),
        new Promise<{ ok: false; error: string }>((res) => {
          tid = setTimeout(() => res({ ok: false, error: `응답 시간 초과(${SCAN_TIMEOUT_MS / 1000}초)` }), SCAN_TIMEOUT_MS)
        }),
      ]).catch((e) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }))
      if (tid) clearTimeout(tid)
      busy = false
      if (!alive) return
      const out = r.ok ? ('out' in r ? (r.out ?? '') : '') : ''
      const parsed = parseScan(out)
      if (!r.ok || !parsed.complete) {
        // 조회 실패 ≠ 오류 없음 — 쌓아 둔 결과는 그대로 두고 사유만 밝힌다
        setInfo((s) => ({ ...s, scanning: false, err: r.ok ? '훑기가 끝까지 돌지 못했습니다(출력이 잘림)' : ('error' in r ? r.error : '') || '조회 실패' }))
      } else {
        const now = Date.now()
        // 검증 시작은 **받은 뒤에** 다시 읽는다 — 훑기(최대 40초)가 도는 중에 검증을 시작하면, 시작할 때 읽은 값(null)으로 합쳐져
        // 검증 뒤 줄이 seen 에만 들어가고 다음 훑기에서 '이미 본 줄' 이 되어 회차 기록에서 빠졌다(코드 검토 10-29)
        const runSince = optRef.current.runningSince
        const bb = runSince != null ? Math.min(runSince, baselineUntil) : baselineUntil
        const m = mergeScan(stRef.current, parsed.pods, { now, baselineBefore: bb, ignore: p.ignore, words: p.extraWords, runSince })
        stRef.current = m.state
        for (const [k, n] of Object.entries(p.restarts)) seenRestarts.current[k] = n
        // 전체 제한 시간에 걸린 훑기도 읽은 파드는 쓴다. 못 읽은 파드가 있다는 사실만 밝힌다 — 다음 구간은 그대로 이어 받는다
        if (!parsed.cut) lastOkStart = now0
        else if (!lastOkStart) lastOkStart = now0 - LOG_BASELINE_MS
        setInfo({
          state: m.state,
          baselineUntil: now < bb ? bb : null,
          scanning: false,
          err: parsed.cut ? '시간 안에 일부 파드만 읽었습니다(나머지는 다음 훑기에 이어 받음)' : '',
          lastMs: now - now0,
        })
        if (m.newGroups.length) p.onNew?.(m.newGroups)
        first = false
      }
      if (alive) timer = setTimeout(() => void scan(), Math.max(30, optRef.current.intervalSec) * 1000)
    }
    kick.current = () => void scan()
    void scan()
    return () => {
      alive = false
      if (timer) clearTimeout(timer)
      kick.current = () => {}
    }
    // 세션 · 네임스페이스 · 켜고 끄기가 바뀔 때만 다시 건다(나머지는 ref 로 읽는다)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [o.enabled, o.sessionId, nsKey])
  return { ...info, rescan: () => kick.current() }
}

const POD_COLORS = ['text-sky-300', 'text-emerald-300', 'text-pink-300', 'text-amber-300', 'text-violet-300', 'text-teal-300', 'text-orange-300']
const p2 = (n: number) => String(n).padStart(2, '0')
const clock = (t: number | null) => {
  if (t == null) return '--:--:--'
  const d = new Date(t)
  return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`
}

/** 이상 목록 — 네임스페이스 → 워크로드 → 오류 종류. 기본은 새 오류만(평소 오류는 [전체] 에서) */
export function LogIssuesModal({
  info,
  initialNs,
  onOpen,
  onRescan,
  onClose,
}: {
  info: LogWatchInfo
  initialNs?: string
  onOpen: (g: LogGroup) => void
  onRescan: () => void
  onClose: () => void
}) {
  const [onlyNew, setOnlyNew] = useState(true)
  const [ns, setNs] = useState<string | null>(initialNs ?? null)
  // 경고는 기본으로 숨긴다(10-29) — 노드를 내리기 전에도 경고가 목록을 덮어 정작 오류가 안 보였다
  const [warn, setWarn] = useState(false)
  const { state } = info
  const all = state.groups
  const warnHidden = all.filter((g) => g.level === 'warn' && (!onlyNew || !g.baseline) && (!ns || g.ns === ns)).length
  const list = all
    .filter((g) => (!onlyNew || !g.baseline) && (!ns || g.ns === ns) && (warn || g.level === 'error'))
    .sort((a, b) => a.ns.localeCompare(b.ns) || (a.level === b.level ? b.last - a.last : a.level === 'error' ? -1 : 1))
  const nss = Array.from(new Set(all.map((g) => g.ns))).sort()
  const byNs = nss.filter((n) => list.some((g) => g.ns === n))
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-6">
      <div className="flex max-h-[88vh] w-[1180px] max-w-[97vw] flex-col overflow-hidden rounded-lg border border-white/10 bg-panel shadow-2xl">
        <div className="flex items-center gap-2 border-b border-white/10 px-4 py-2.5">
          <FileText size={15} className="text-amber-300" />
          <span className="text-[13px] font-semibold text-gray-100">파드 로그 이상</span>
          <span className="text-[11px] text-gray-500">
            {state.lastAt ? `${clock(state.lastAt)} 훑음 · 파드 ${state.pods}개${info.lastMs ? ` · ${Math.round(info.lastMs / 1000)}초 걸림` : ''}` : '첫 훑기 중'}
            {info.baselineUntil ? ` · 평소 오류 기준선 뜨는 중(${clock(info.baselineUntil)}까지)` : ''}
          </span>
          {info.err && <span className="text-[11px] text-amber-300">{info.err}</span>}
          <button onClick={onRescan} disabled={info.scanning} className="ml-auto flex items-center gap-1 rounded border border-white/10 px-2 py-0.5 text-[11px] text-gray-300 hover:bg-white/5 disabled:opacity-40">
            {info.scanning ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />} 지금 훑기
          </button>
          <button onClick={onClose} className="rounded p-1 text-gray-400 hover:bg-white/10 hover:text-gray-200" title="닫기">
            <X size={15} />
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 border-b border-white/10 px-4 py-2 text-[11.5px]">
          {(
            [
              [true, '새 오류만'],
              [false, '전체 (평소 오류 포함)'],
            ] as const
          ).map(([v, label]) => (
            <button
              key={label}
              onClick={() => setOnlyNew(v)}
              className={'rounded border px-2 py-0.5 ' + (onlyNew === v ? 'border-blue-500/50 bg-blue-500/15 text-blue-100' : 'border-white/10 text-gray-400 hover:bg-white/5')}
            >
              {label}
            </button>
          ))}
          <span className="mx-1 h-3 w-px bg-white/10" />
          <button onClick={() => setNs(null)} className={'rounded px-2 py-0.5 ' + (!ns ? 'bg-white/10 text-gray-100' : 'text-gray-400 hover:bg-white/5')}>
            모든 네임스페이스
          </button>
          {nss.map((n) => (
            <button key={n} onClick={() => setNs(n)} className={'rounded px-2 py-0.5 font-mono ' + (ns === n ? 'bg-white/10 text-gray-100' : 'text-gray-400 hover:bg-white/5')}>
              {n} {all.filter((g) => g.ns === n && !g.baseline && (warn || g.level === 'error')).length || ''}
            </button>
          ))}
          <label className="ml-auto flex items-center gap-1 text-gray-400">
            <input type="checkbox" checked={warn} onChange={(e) => setWarn(e.target.checked)} className="h-3 w-3 accent-blue-500" />
            경고도 보기{!warn && warnHidden ? ` (${warnHidden})` : ''}
          </label>
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-4 py-2">
          {list.length === 0 ? (
            <p className="py-10 text-center text-[12px] text-gray-500">
              {state.lastAt
                ? (onlyNew ? '새로 생긴 오류가 없습니다.' : '걸린 오류 줄이 없습니다.') + (!warn && warnHidden ? ` 경고 ${warnHidden}건은 [경고도 보기] 에서 봅니다.` : '')
                : '첫 훑기를 기다리는 중입니다.'}
            </p>
          ) : (
            <table className="w-full border-collapse text-[12px]">
              <thead className="sticky top-0 bg-panel text-left text-[10.5px] text-gray-500">
                <tr>
                  <th className="py-1 pr-2 font-normal">종류</th>
                  <th className="py-1 pr-2 font-normal">무엇이</th>
                  <th className="py-1 pr-2 font-normal">대표 줄 · 원인</th>
                  <th className="py-1 pr-2 text-right font-normal">파드</th>
                  <th className="py-1 pr-2 text-right font-normal">횟수</th>
                  <th className="py-1 pr-2 font-normal">처음 ~ 마지막</th>
                  <th className="py-1 font-normal" />
                </tr>
              </thead>
              <tbody>
                {byNs.map((n) => (
                  <Fragment key={n}>
                    <tr>
                      <td colSpan={7} className="pb-1 pt-3 font-mono text-[11.5px] text-gray-300">
                        {n}
                      </td>
                    </tr>
                    {list
                      .filter((g) => g.ns === n)
                      .map((g) => (
                        <tr key={g.key} className="border-t border-white/5 align-top">
                          <td className="whitespace-nowrap py-1.5 pr-2">
                            <span className={'rounded px-1.5 py-0.5 text-[10.5px] ' + (g.level === 'error' ? 'bg-red-500/20 text-red-200' : 'bg-amber-500/15 text-amber-200')}>
                              {g.level === 'error' ? '오류' : '경고'}
                            </span>
                            {g.baseline && <span className="ml-1 text-[10px] text-gray-500">평소</span>}
                          </td>
                          <td className="py-1.5 pr-2 text-gray-200">{groupHeadline(g)}</td>
                          <td className="max-w-[460px] py-1.5 pr-2">
                            <div className="truncate font-mono text-[11px] text-gray-400" title={g.sample}>
                              {g.sample}
                            </div>
                            {g.cause && (
                              <div className="truncate font-mono text-[10.5px] text-gray-500" title={g.cause}>
                                ↳ {g.cause}
                              </div>
                            )}
                          </td>
                          <td className="py-1.5 pr-2 text-right text-gray-300" title={g.pods.join('\n')}>
                            {g.pods.length}
                          </td>
                          <td className="py-1.5 pr-2 text-right text-gray-300">{g.count}</td>
                          <td className="whitespace-nowrap py-1.5 pr-2 text-[11px] text-gray-400">
                            {clock(g.first)} ~ {clock(g.last)}
                          </td>
                          <td className="py-1.5">
                            <button
                              onClick={() => onOpen(g)}
                              className="flex items-center gap-1 whitespace-nowrap rounded border border-white/10 px-1.5 py-0.5 text-[11px] text-gray-200 hover:bg-white/10"
                            >
                              <FileText size={11} /> 로그 열기
                            </button>
                          </td>
                        </tr>
                      ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          )}
          {state.unreadable.length > 0 && (
            <div className="mt-3 rounded border border-white/10 bg-white/[0.03] px-3 py-2 text-[11px] text-gray-400">
              <b className="text-gray-300">로그를 못 읽은 파드 {state.unreadable.length}개</b>: 오류가 없다는 뜻이 아닙니다(죽은 노드 위 파드는 kubelet 에 닿지 않습니다).
              <div className="mt-1 font-mono text-[10.5px] text-gray-500">
                {state.unreadable.slice(0, 12).map((u) => `${u.ns}/${u.pod}`).join(' · ')}
                {state.unreadable.length > 12 ? ` 외 ${state.unreadable.length - 12}` : ''}
              </div>
            </div>
          )}
          <p className="mt-3 text-[10.5px] leading-relaxed text-gray-500">
            1분마다 Running 파드의 최근 로그에서 오류 · 경고 줄만 받아 같은 오류끼리 묶습니다(시각 · 숫자 · IP 를 지운 문장이 같으면 같은 오류). 감시를 켠 뒤
            처음 5분(검증을 시작하면 그때까지)에 이미 있던 오류는 '평소' 로 보고 [새 오류만] 에서 뺍니다. 시각은 각 노드가 찍은 로그 시각입니다.
          </p>
        </div>
        <div className="flex border-t border-white/10 px-4 py-2">
          <button onClick={onClose} className="ml-auto rounded border border-white/10 px-3 py-1 text-[12px] text-gray-200 hover:bg-white/10">
            닫기
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * 합친 로그(목업 10-28, 사용자 확정) — 같은 오류를 낸 파드들의 로그를 **한 창에 시간순으로**. 파드마다 창을 열면 '동시에 터졌나' 를 비교할 수 없다.
 * 위 칩으로 파드를 켜고 끄고, [이 오류만] · [앞뒤 5줄] · [전체] 로 얼마나 볼지 정한다. 스택은 접고 원인만, 같은 오류 반복은 한 줄로.
 */
export function MergedLogModal({
  group,
  sessionId,
  extraPods,
  onClose,
  onLive,
  onSave,
  onAnalyze,
}: {
  group: LogGroup
  sessionId?: string
  /** 같은 워크로드의 다른 파드(오류가 없던 것) — 칩으로만 보이고 처음엔 꺼 둔다 */
  extraPods: string[]
  onClose: () => void
  onLive?: (pod: string) => void
  onSave?: (text: string) => void
  /** part: 무엇을 보내는지(보기 방식 · 파드 수) — AI 분석 창에 그대로 적는다 */
  onAnalyze?: (text: string, part: string) => void
}) {
  const pods = useMemo(() => Array.from(new Set([...group.pods, ...extraPods])), [group, extraPods])
  const [on, setOn] = useState<Set<string>>(() => new Set(group.pods))
  const [mode, setMode] = useState<'match' | 'ctx' | 'all'>('match')
  const [data, setData] = useState<{ pod: string; lines: { ts: number | null; text: string }[] }[] | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  /** 전체 제한 시간에 끊겨 일부 파드만 받음 */
  const [cut, setCut] = useState(false)
  const [openFold, setOpenFold] = useState<Set<number>>(new Set())
  const [savedMsg, setSavedMsg] = useState('')
  // 펼친 스택은 줄 번호로 기억하므로 보기 방식 · 파드를 바꾸면 다른 스택이 열렸다 — 바뀌면 접는다(코드 점검 10-29)
  useEffect(() => setOpenFold(new Set()), [mode, on, data])
  /** 늦게 온 앞 요청이 새 결과를 덮지 않게 */
  const reqRef = useRef(0)
  const load = async () => {
    if (!sessionId) return setErr('파드 세션이 연결돼 있지 않습니다')
    const my = ++reqRef.current
    setBusy(true)
    setErr('')
    // 오류 1분 앞부터 마지막 오류 1분 뒤까지(앞뒤 줄을 보려면 그 전후도 필요하다). 평소 오류처럼 오래 이어진 묶음은
    // 마지막 10분만 — 처음부터 받으면 줄 수 한도에 걸려 최근 것이 안 보인다
    const from = Math.max(group.first, group.last - 10 * 60_000) - 60_000
    const r = await window.electronAPI
      .sessionRun(sessionId, buildFetchCmd(group.ns, pods, from, group.last + 60_000))
      .catch((e) => ({ ok: false, error: String(e) }) as { ok: boolean; out?: string; error?: string })
    if (my !== reqRef.current) return
    setBusy(false)
    if (!r.ok) return setErr(r.error || '로그를 받지 못했습니다')
    const parsed = parseScan(r.out ?? '')
    setCut(parsed.cut)
    setData(parsed.pods.map((p) => ({ pod: p.pod, lines: p.lines })))
  }
  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [group.key])
  const color = (pod: string) => POD_COLORS[pods.indexOf(pod) % POD_COLORS.length]
  const entries: ViewEntry[] = useMemo(() => (data ? buildLogView(data.filter((d) => on.has(d.pod)), group.sig, mode) : []), [data, on, mode, group.sig])
  // 칩마다 그릴 때마다 4000줄을 다시 훑지 않게 받은 자료가 바뀔 때만 센다
  const matchCount = useMemo(() => {
    const m: Record<string, number> = {}
    for (const d of data ?? []) m[d.pod] = buildLogView([d], group.sig, 'match').reduce((n, e) => n + 1 + (e.repeat?.n ?? 0), 0)
    return m
  }, [data, group.sig])
  const matchN = (pod: string) => matchCount[pod] ?? 0
  const asText = () =>
    entries
      .map((e) => `${clock(e.ts)} ${e.pod}  ${e.text}${e.repeat ? `  (같은 줄 ${e.repeat.n}번 더, ~${clock(e.repeat.until)})` : ''}${e.fold ? '\n' + e.fold.lines.join('\n') : ''}`)
      .join('\n')
  return (
    <div className="fixed inset-0 z-[61] flex items-center justify-center bg-black/60 p-6">
      <div className="flex h-[86vh] w-[1180px] max-w-[97vw] flex-col overflow-hidden rounded-lg border border-white/10 bg-panel shadow-2xl">
        <div className="flex items-center gap-2 border-b border-white/10 px-4 py-2.5">
          <FileText size={15} className="text-amber-300" />
          <span className="font-mono text-[13px] font-semibold text-gray-100">{group.ns}</span>
          <span className="text-[12.5px] text-gray-300">{groupHeadline(group)}</span>
          <span className="text-[11px] text-gray-500">
            파드 {group.pods.length}개 · {clock(group.first)} ~ {clock(group.last)}
          </span>
          <button onClick={onClose} className="ml-auto rounded p-1 text-gray-400 hover:bg-white/10 hover:text-gray-200" title="닫기">
            <X size={15} />
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 border-b border-white/10 px-4 py-2 text-[11px]">
          {pods.map((p) => (
            <button
              key={p}
              onClick={() => setOn((s) => {
                const n = new Set(s)
                if (n.has(p)) n.delete(p)
                else n.add(p)
                return n
              })}
              title={p}
              className={'flex items-center gap-1 rounded border px-2 py-0.5 font-mono ' + (on.has(p) ? 'border-blue-500/50 bg-blue-500/10 text-gray-100' : 'border-white/10 text-gray-500 hover:bg-white/5')}
            >
              <span className={color(p)}>●</span>
              {p.length > 34 ? '…' + p.slice(-33) : p}
              {data && <span className="text-gray-500">· {matchN(p)}</span>}
            </button>
          ))}
          <span className="ml-auto" />
          {(
            [
              ['match', '이 오류만'],
              ['ctx', '앞뒤 5줄'],
              ['all', '전체'],
            ] as const
          ).map(([m, label]) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={'rounded border px-2 py-0.5 ' + (mode === m ? 'border-blue-500/50 bg-blue-500/15 text-blue-100' : 'border-white/10 text-gray-400 hover:bg-white/5')}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="min-h-0 flex-1 overflow-auto bg-black/30 py-1.5 font-mono text-[11.5px] leading-relaxed">
          {busy && (
            <div className="flex items-center gap-2 px-4 py-6 text-gray-400">
              <Loader2 size={13} className="animate-spin" /> 로그를 받는 중
            </div>
          )}
          {err && (
            <div className="mx-4 my-3 flex items-center gap-1.5 rounded bg-red-500/10 px-2 py-1.5 font-sans text-[12px] text-red-200">
              <AlertTriangle size={13} /> {err}
            </div>
          )}
          {data && !busy && entries.length === 0 && (
            // 0줄을 '오류가 사라졌다' 로 읽지 않게 몇 줄을 받았는지와 다음 행동을 같이 밝힌다
            <div className="px-4 py-6 font-sans text-[12px] text-gray-500">
              {(() => {
                const got = data.filter((d) => on.has(d.pod)).reduce((n, d) => n + d.lines.length, 0)
                if (!on.size) return '위에서 파드를 하나 이상 켜세요.'
                if (!got) return '고른 파드에서 그 시각의 로그를 받지 못했습니다. 파드가 다시 떠 로그가 비었을 수 있습니다.'
                return `받은 ${got}줄 안에 이 오류 줄이 없습니다. [전체] 로 받은 줄을 확인하세요.`
              })()}
            </div>
          )}
          {data && !busy && cut && (
            <div className="mx-4 my-1 rounded bg-amber-500/10 px-2 py-1 font-sans text-[11px] text-amber-200">
              시간 안에 일부 파드의 로그만 받았습니다(노드가 응답하지 않는 파드는 빠졌을 수 있습니다). 받은 것만 보여 줍니다.
            </div>
          )}
          {data && !busy && data.some((d) => on.has(d.pod) && d.lines.length >= FETCH_MAX_LINES) && (
            <div className="mx-4 my-1 rounded bg-amber-500/10 px-2 py-1 font-sans text-[11px] text-amber-200">
              로그가 많아 파드마다 앞 {FETCH_MAX_LINES}줄(처음 오류 1분 전부터)까지만 받았습니다.
            </div>
          )}
          {entries.map((e, i) => (
            <Fragment key={i}>
              <div className={'grid grid-cols-[68px_minmax(0,210px)_minmax(0,1fr)] gap-2 px-3 ' + (e.kind === 'match' ? 'bg-red-500/10' : '')}>
                <span className="text-gray-500">{clock(e.ts)}</span>
                <span className={'truncate ' + color(e.pod)} title={e.pod}>
                  {e.pod}
                </span>
                <span className={'whitespace-pre-wrap break-all ' + (e.kind === 'match' ? 'text-red-200' : 'text-gray-400')}>
                  {e.text}
                  {e.repeat && (
                    <span className="ml-2 font-sans text-[10.5px] text-gray-500">
                      (같은 줄 {e.repeat.n}번 더, ~{clock(e.repeat.until)})
                    </span>
                  )}
                </span>
              </div>
              {e.fold && (
                <button
                  onClick={() => setOpenFold((s) => {
                    const n = new Set(s)
                    if (n.has(i)) n.delete(i)
                    else n.add(i)
                    return n
                  })}
                  className="flex w-full items-center gap-1 py-0.5 pl-[290px] pr-3 text-left font-sans text-[10.5px] text-gray-500 hover:text-gray-300"
                >
                  {openFold.has(i) ? <ChevronDown size={11} /> : <ChevronRight size={11} />} 스택 {e.fold.n}줄 {openFold.has(i) ? '' : '접힘'}
                  {e.fold.cause ? ` · 원인: ${e.fold.cause}` : ''}
                </button>
              )}
              {e.fold && openFold.has(i) && <pre className="whitespace-pre-wrap break-all pl-[290px] pr-3 text-[11px] text-gray-500">{e.fold.lines.join('\n')}</pre>}
            </Fragment>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t border-white/10 px-4 py-2 text-[12px]">
          {onLive && (
            <button
              onClick={() => {
                const p = pods.find((x) => on.has(x))
                if (p) onLive(p)
              }}
              title="실시간 로그 창에서 이어 봅니다(고른 파드 중 첫 번째)"
              className="flex items-center gap-1 rounded border border-white/10 px-2 py-1 text-gray-200 hover:bg-white/10"
            >
              <Play size={12} /> 실시간 이어 보기
            </button>
          )}
          <button onClick={() => void load()} disabled={busy} className="flex items-center gap-1 rounded border border-white/10 px-2 py-1 text-gray-200 hover:bg-white/10 disabled:opacity-40">
            <RefreshCw size={12} /> 다시 받기
          </button>
          {onSave && (
            <button
              onClick={() => {
                onSave(asText())
                setSavedMsg('지금 보이는 구간을 이번 회차 증적에 남겼습니다')
              }}
              disabled={!entries.length}
              className="flex items-center gap-1 rounded border border-white/10 px-2 py-1 text-gray-200 hover:bg-white/10 disabled:opacity-40"
            >
              <Save size={12} /> 이 구간 저장
            </button>
          )}
          {savedMsg && <span className="text-[11px] text-emerald-300/90">{savedMsg}</span>}
          {onAnalyze && (
            <button
              onClick={() =>
                onAnalyze(
                  `[${group.ns}] ${groupHeadline(group)}\n${asText()}`,
                  `로그 창의 '${mode === 'match' ? '이 오류만' : mode === 'ctx' ? '앞뒤 5줄' : '전체'}' 보기에 보이던 줄 · 파드 ${on.size}개`,
                )
              }
              disabled={!entries.length}
              className="ml-auto flex items-center gap-1 rounded border border-violet-500/40 bg-violet-500/10 px-2 py-1 text-violet-100 hover:bg-violet-500/20 disabled:opacity-40"
            >
              <Sparkles size={12} /> AI 분석
            </button>
          )}
          <button onClick={onClose} className={(onAnalyze ? '' : 'ml-auto ') + 'rounded border border-white/10 px-3 py-1 text-gray-200 hover:bg-white/10'}>
            닫기
          </button>
        </div>
      </div>
    </div>
  )
}
