import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  X,
  Play,
  Square,
  Gauge,
  ExternalLink,
  FolderOpen,
  Trash2,
  RefreshCw,
  TriangleAlert,
  CircleCheck,
  FileCode,
  Info,
  Target,
  Download,
  ArrowRight,
} from 'lucide-react'
import type { PerfEnvStatus, PerfRunConfig, PerfRunMeta, PerfRunRecord } from '../../electron/shared-types'
import {
  parseLocustConsole,
  parseLocustFailures,
  parseLocustStats,
  parseStatsApi,
  type PerfLive,
  type PerfSummary,
} from '../lib/perfParse'
import { perfVerdict } from '../lib/perfVerdict'
import { maskForDisplay } from '../lib/mask'
import ConfirmDialog from './ConfirmDialog'

interface PerfTarget {
  id: string
  name: string
}

interface PerfPanelProps {
  /** 연결된 세션 — 대상 주소를 여기서 가져온다(부하는 이 PC 에서 나간다) */
  sessions: PerfTarget[]
  onClose: () => void
}

type Tab = 'dash' | 'log' | 'summary'

const LOG_MAX_CHARS = 200_000

/** `con1 (10.255.233.21)` 처럼 이름에 든 주소를 뽑는다 — 대상 주소를 미리 채우기 위한 것 */
function hostOf(name: string): string {
  const m = name.match(/(\d{1,3}(?:\.\d{1,3}){3})/)
  if (m) return m[1]
  return name.split(/[\s(]/)[0] ?? ''
}

/**
 * 부하 프리셋.
 *
 * 처음 여는 사람이 "사용자 몇 명이 적당한가" 를 알 수가 없다. 세 칸으로 시작점을 준다 —
 * 값은 그대로 편집되니 프리셋은 잠금이 아니라 출발점이다.
 */
const LOAD_PRESETS = [
  { label: '가볍게', users: 10, rate: 2, min: 1 },
  { label: '보통', users: 50, rate: 5, min: 3 },
  { label: '세게', users: 200, rate: 20, min: 5 },
] as const

/** 설정 묶음 하나 — 제목과 내용을 테두리로 묶는다(전에는 라벨만 있어 어디까지가 한 묶음인지 안 보였다) */
function Card({
  icon,
  title,
  badge,
  children,
}: {
  icon: ReactNode
  title: string
  badge?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="mb-2 rounded-md border border-white/10 bg-panel-light/25 p-2.5">
      <div className="mb-1.5 flex items-center gap-1.5">
        <span className="text-gray-500">{icon}</span>
        <span className="text-[11px] font-medium text-gray-300">{title}</span>
        {badge && <span className="ml-auto">{badge}</span>}
      </div>
      {children}
    </div>
  )
}

/** 숫자 입력 한 칸 — 단위를 입력칸 안에 붙여 라벨을 짧게 유지한다 */
function Field({
  label,
  unit,
  value,
  onChange,
  disabled,
  placeholder,
}: {
  label: string
  unit: string
  value: string
  onChange: (v: string) => void
  disabled?: boolean
  placeholder?: string
}) {
  return (
    <label className="block">
      <span className="text-[10px] text-gray-500">{label}</span>
      <span className="mt-0.5 flex items-center rounded border border-white/10 bg-panel-light focus-within:border-blue-500/60">
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          placeholder={placeholder}
          className="min-w-0 flex-1 bg-transparent px-2 py-1 text-[11.5px] text-gray-100 outline-none disabled:opacity-50"
        />
        <span className="shrink-0 pr-2 text-[10px] text-gray-500">{unit}</span>
      </span>
    </label>
  )
}

const fmtMs = (v?: number) => (v === undefined ? '–' : v >= 1000 ? `${(v / 1000).toFixed(2)}s` : `${Math.round(v)}ms`)
const fmtInt = (v?: number) => (v === undefined ? '–' : Math.round(v).toLocaleString())

export default function PerfPanel({ sessions, onClose }: PerfPanelProps) {
  const [env, setEnv] = useState<PerfEnvStatus | null>(null)
  const [envChecking, setEnvChecking] = useState(true)
  const [locustPath, setLocustPath] = useState('')

  const [sessionId, setSessionId] = useState(sessions[0]?.id ?? '')
  const [targetUrl, setTargetUrl] = useState('')
  const [users, setUsers] = useState('50')
  const [spawnRate, setSpawnRate] = useState('5')
  const [durationMin, setDurationMin] = useState('3')
  const [p95Th, setP95Th] = useState('')
  const [errTh, setErrTh] = useState('')
  const [insecure, setInsecure] = useState(true)

  const [scenarioKind, setScenarioKind] = useState<'form' | 'file'>('form')
  const [paths, setPaths] = useState('/')
  const [method, setMethod] = useState<'GET' | 'POST'>('GET')
  const [body, setBody] = useState('')
  const [headerText, setHeaderText] = useState('')
  const [waitMin, setWaitMin] = useState('1')
  const [waitMax, setWaitMax] = useState('2')
  const [scenarioFile, setScenarioFile] = useState('')

  const [running, setRunning] = useState<PerfRunMeta | null>(null)
  const [log, setLog] = useState('')
  const [live, setLive] = useState<PerfLive>({})
  const [tab, setTab] = useState<Tab>('dash')
  /**
   * 대시보드를 끼울 준비가 됐는가.
   *
   * spawn 직후 바로 iframe 을 걸었더니 흰 화면만 남았다 — Locust 가 포트를 잡기까지 몇백
   * 밀리초가 걸리고, 그 사이에 연결이 거부된 iframe 은 **스스로 다시 시도하지 않는다.**
   * 그래서 통계 API 가 응답할 때까지 기다렸다가 끼운다(그 응답이 웹 UI 가 떴다는 증거다).
   */
  const [dashReady, setDashReady] = useState(false)
  /** 사람이 다시 불러올 때 iframe 을 새로 만들기 위한 키 */
  const [dashKey, setDashKey] = useState(0)
  const [startError, setStartError] = useState('')
  const [runs, setRuns] = useState<PerfRunRecord[]>([])
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<PerfRunRecord | null>(null)
  const [note, setNote] = useState('')
  /** 앱이 만들어 줄 locustfile 미리보기 (null 이면 안 열림) */
  const [preview, setPreview] = useState<string | null>(null)
  const logRef = useRef<HTMLDivElement>(null)
  const [elapsed, setElapsed] = useState(0)

  const session = sessions.find((s) => s.id === sessionId)

  // 대상 주소 미리 채우기 — 세션을 바꾸면 (사용자가 손대지 않은 경우에만) 따라간다
  const urlTouched = useRef(false)
  useEffect(() => {
    if (urlTouched.current) return
    const h = session ? hostOf(session.name) : ''
    setTargetUrl(h ? `https://${h}` : '')
  }, [session])

  const checkEnv = async () => {
    setEnvChecking(true)
    try {
      setEnv(await window.electronAPI.perfEnv())
      setLocustPath(await window.electronAPI.perfGetLocustPath())
    } finally {
      setEnvChecking(false)
    }
  }
  const refreshRuns = async () => setRuns(await window.electronAPI.perfList())

  useEffect(() => {
    void checkEnv()
    void refreshRuns()
  }, [])

  // 실시간 로그 — 100ms 씩 묶여서 온다. 화면에 다 쌓아 두면 느려지므로 앞부분을 버린다.
  useEffect(() => {
    const offLog = window.electronAPI.onPerfLog((e) => {
      setLog((prev) => {
        const next = prev + e.text
        return next.length > LOG_MAX_CHARS ? next.slice(next.length - LOG_MAX_CHARS) : next
      })
      const l = parseLocustConsole(e.text)
      if (Object.keys(l).length) setLive((prev) => ({ ...prev, ...l }))
    })
    const offDone = window.electronAPI.onPerfDone((e) => {
      setRunning(null)
      setNote(e.canceled ? '중지했습니다.' : '끝났습니다 — 요약과 리포트가 회차로 남았습니다.')
      setSelectedRunId(e.runId)
      setTab('summary')
      void refreshRuns()
    })
    return () => {
      offLog()
      offDone()
    }
  }, [])

  /**
   * 돌고 있는 동안의 숫자는 Locust 통계 API 에서 받는다.
   * 첫 응답이 오면 웹 UI 도 뜬 것이므로 그때 대시보드를 끼운다.
   */
  useEffect(() => {
    if (!running?.webUrl) return
    const base = running.webUrl.replace(/\/+$/, '')
    let alive = true
    const tick = async () => {
      try {
        const r = await fetch(`${base}/stats/requests`, { cache: 'no-store' })
        if (!r.ok) throw new Error(String(r.status))
        const j = await r.json()
        if (!alive) return
        setDashReady(true)
        setLive(parseStatsApi(j))
      } catch {
        /* 아직 안 떴거나 이미 끝났다 — 다음 차례에 다시 */
      }
    }
    void tick()
    const t = setInterval(tick, 1500)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [running])

  // 경과 시간 (돌고 있을 때만)
  useEffect(() => {
    if (!running) return
    const t = setInterval(() => setElapsed(Date.now() - running.startedAt), 1000)
    setElapsed(Date.now() - running.startedAt)
    return () => clearInterval(t)
  }, [running])

  useEffect(() => {
    if (tab === 'log' && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [log, tab])

  const parseHeaders = (): Record<string, string> => {
    const out: Record<string, string> = {}
    for (const line of headerText.split('\n')) {
      const i = line.indexOf(':')
      if (i <= 0) continue
      const k = line.slice(0, i).trim()
      const v = line.slice(i + 1).trim()
      if (k) out[k] = v
    }
    return out
  }

  const numOrUndef = (v: string) => {
    const n = Number(v.trim())
    return v.trim() && Number.isFinite(n) ? n : undefined
  }

  const buildConfig = (): PerfRunConfig => ({
    sessionId: session?.id,
    sessionLabel: session?.name,
    targetUrl: targetUrl.trim(),
    users: Number(users) || 1,
    spawnRate: Number(spawnRate) || 1,
    durationSec: Math.max(1, Math.round((Number(durationMin) || 1) * 60)),
    p95ThresholdMs: numOrUndef(p95Th),
    errorRateThresholdPct: numOrUndef(errTh),
    insecureTls: insecure,
    scenario:
      scenarioKind === 'file'
        ? { kind: 'file', path: scenarioFile }
        : {
            kind: 'form',
            paths: paths
              .split('\n')
              .map((x) => x.trim())
              .filter(Boolean),
            method,
            body: method === 'POST' ? body : undefined,
            headers: parseHeaders(),
            waitMinSec: Number(waitMin) || 0,
            waitMaxSec: Number(waitMax) || 0,
          },
  })

  /**
   * 부하 설정을 사람 말로 되짚는다.
   *
   * '사용자 50 / 증가 5 / 시간 3' 만 보면 무엇이 5 인지, 3분이 어디부터인지 매번 짐작하게 된다.
   * 예상 요청 수는 **대기 시간이 있을 때만** 어림한다 — 대기가 0이면 초당 요청 수가 응답
   * 시간에 좌우되므로, 우리가 계산한 숫자를 내놓으면 틀린 기대를 심는다.
   */
  const loadSentence = useMemo(() => {
    const u = Number(users) || 0
    const r = Number(spawnRate) || 0
    const min = Number(durationMin) || 0
    const rampSec = r > 0 ? Math.ceil(u / r) : 0
    const head = `사용자 ${u}명이 ${rampSec}초에 걸쳐 붙어 ${min}분 동안 요청합니다.`
    if (scenarioKind === 'file') return head + ' 요청 내용은 고른 파일이 정합니다.'
    const wMin = Number(waitMin) || 0
    const wMax = Math.max(wMin, Number(waitMax) || 0)
    if (wMax <= 0) return head + ' 쉬지 않고 보내므로 초당 요청 수는 응답 시간이 정합니다.'
    const avgWait = (wMin + wMax) / 2
    const rps = u / avgWait
    const total = Math.round(rps * min * 60)
    return (
      head +
      ` 요청 사이 ${wMin}~${wMax}초 쉬므로 대략 초당 ${rps.toFixed(0)}건, 모두 ${total.toLocaleString()}건쯤 됩니다.`
    )
  }, [users, spawnRate, durationMin, waitMin, waitMax, scenarioKind])

  /** 시작을 막아야 하는 이유 (없으면 빈 문자열) — 왜 못 누르는지 그 자리에 밝힌다 */
  const blockedReason = (() => {
    if (envChecking) return '환경을 확인하는 중입니다'
    if (!env?.ok) return '환경 확인이 필요합니다'
    if (!targetUrl.trim()) return '대상 주소를 적어 주세요'
    if (!/^https?:\/\//i.test(targetUrl.trim())) return '대상 주소는 http:// 또는 https:// 로 시작해야 합니다'
    if (scenarioKind === 'file' && !scenarioFile.trim()) return 'locustfile 을 고르세요'
    return ''
  })()

  const start = async () => {
    setStartError('')
    setNote('')
    setLog('')
    setLive({})
    setDashReady(false)
    const r = await window.electronAPI.perfStart(buildConfig())
    if (!r.ok || !r.meta) {
      setStartError(r.error ?? '시작하지 못했습니다.')
      return
    }
    setRunning(r.meta)
    setSelectedRunId(r.meta.id)
    setTab('dash')
    void refreshRuns()
  }

  const selected = runs.find((r) => r.meta.id === selectedRunId) ?? null
  const selectedSummary: PerfSummary | null = useMemo(
    () => (selected?.statsCsv ? parseLocustStats(selected.statsCsv) : null),
    [selected],
  )
  const verdict = useMemo(
    () =>
      selected
        ? perfVerdict(
            selectedSummary,
            {
              p95ThresholdMs: selected.meta.config.p95ThresholdMs,
              errorRateThresholdPct: selected.meta.config.errorRateThresholdPct,
            },
            { canceled: selected.meta.canceled, exitCode: selected.meta.exitCode },
          )
        : null,
    [selected, selectedSummary],
  )

  const failures = useMemo(
    () => (selected?.failuresCsv ? parseLocustFailures(selected.failuresCsv) : []),
    [selected],
  )

  /**
   * 직전 회차와의 비교.
   *
   * 성능은 절대값보다 "지난번보다 나빠졌나" 로 읽는 일이 많다(설정을 바꿔 보며 여러 번 돌리므로).
   * 목록은 최신순이니 **고른 회차보다 뒤(=더 예전)에서 통계가 있는 첫 회차**를 짝으로 잡는다.
   * 중지된 회차는 짝으로 쓰지 않는다 — 끝까지 돌지 않은 값과 비교하면 결론이 거짓이 된다.
   */
  const compare = useMemo(() => {
    if (!selected || !selectedSummary || selected.meta.canceled) return null
    const idx = runs.findIndex((r) => r.meta.id === selected.meta.id)
    if (idx < 0) return null
    const prevRec = runs.slice(idx + 1).find((r) => r.statsCsv && !r.meta.canceled)
    const prev = prevRec?.statsCsv ? parseLocustStats(prevRec.statsCsv) : null
    if (!prevRec || !prev) return null

    const pct = (before: number, after: number) =>
      before > 0 ? `${after >= before ? '+' : ''}${(((after - before) / before) * 100).toFixed(0)}%` : '—'

    const items: { label: string; before: string; after: string; delta: string; worse: boolean | null }[] = []
    if (prev.p95Ms !== undefined && selectedSummary.p95Ms !== undefined) {
      items.push({
        label: 'p95',
        before: fmtMs(prev.p95Ms),
        after: fmtMs(selectedSummary.p95Ms),
        delta: pct(prev.p95Ms, selectedSummary.p95Ms),
        worse: selectedSummary.p95Ms === prev.p95Ms ? null : selectedSummary.p95Ms > prev.p95Ms,
      })
    }
    items.push({
      label: '실패율',
      before: `${prev.failRatePct.toFixed(2)}%`,
      after: `${selectedSummary.failRatePct.toFixed(2)}%`,
      delta: `${selectedSummary.failRatePct >= prev.failRatePct ? '+' : ''}${(
        selectedSummary.failRatePct - prev.failRatePct
      ).toFixed(2)}%p`,
      worse:
        selectedSummary.failRatePct === prev.failRatePct ? null : selectedSummary.failRatePct > prev.failRatePct,
    })
    items.push({
      label: 'req/s',
      before: fmtInt(prev.rps),
      after: fmtInt(selectedSummary.rps),
      delta: pct(prev.rps, selectedSummary.rps),
      // 처리량은 높은 쪽이 좋다 — 다른 둘과 방향이 반대다
      worse: selectedSummary.rps === prev.rps ? null : selectedSummary.rps < prev.rps,
    })
    return { at: prevRec.meta.startedAt, items }
  }, [selected, selectedSummary, runs])

  // 타일에 쓰는 값: 돌고 있으면 어림값, 끝났으면 확정값
  const tiles = running
    ? {
        rps: live.rps,
        p95: live.p95Ms,
        failPct: live.requests ? ((live.failures ?? 0) / live.requests) * 100 : undefined,
        requests: live.requests,
      }
    : {
        rps: selectedSummary?.rps,
        p95: selectedSummary?.p95Ms,
        failPct: selectedSummary?.failRatePct,
        requests: selectedSummary?.requests,
      }

  const inputCls =
    'rounded border border-white/10 bg-panel-light px-2 py-1 text-[11.5px] text-gray-100 outline-none focus:border-blue-500/60'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6">
      <div
        className="flex h-full max-h-[920px] w-[1760px] max-w-[97vw] flex-col overflow-hidden rounded-lg border border-white/10 bg-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 머리 */}
        <div className="flex items-center gap-2 border-b border-white/10 px-4 py-2">
          <Gauge size={15} className="text-blue-300" />
          <span className="text-sm font-semibold text-gray-100">성능 검증</span>
          {running ? (
            <span className="rounded-full bg-blue-600/25 px-2 py-0.5 text-[11px] text-blue-200">
              진행 중 · {Math.floor(elapsed / 60000)}:{String(Math.floor((elapsed % 60000) / 1000)).padStart(2, '0')} /{' '}
              {durationMin}:00
              {live.users !== undefined && ` · 사용자 ${live.users}`}
            </span>
          ) : (
            note && (
              // 저장 경로가 들어오면 길어진다 — 줄이고 툴팁에 전체를 남긴다
              <span className="min-w-0 max-w-[38%] truncate text-[11px] text-gray-400" title={note}>
                {note}
              </span>
            )
          )}
          <span
            className="ml-auto text-[10.5px] text-gray-500"
            title="부하 발생기(Locust)는 이 PC 에서 돌고, 요청만 대상 세션으로 나갑니다. 대상 서버에는 아무것도 설치하지 않습니다."
          >
            로컬 PC 에 설치된 Locust 로 원격 세션에 부하를 겁니다
          </span>
          {running && (
            <button
              onClick={() => void window.electronAPI.perfCancel()}
              className="flex items-center gap-1 rounded border border-red-500/40 px-2 py-1 text-[11.5px] text-red-300 hover:bg-red-500/10"
            >
              <Square size={11} /> 중지
            </button>
          )}
          <button onClick={onClose} title="닫기" className="rounded p-1 text-gray-500 hover:bg-white/10 hover:text-gray-200">
            <X size={15} />
          </button>
        </div>

        {/* 환경 점검 — 안 되면 무엇을 하면 되는지 여기서 말한다 */}
        {envChecking ? (
          <div className="flex items-center gap-2 border-b border-white/10 bg-panel-light/40 px-4 py-1.5 text-[11.5px] text-gray-400">
            <RefreshCw size={12} className="animate-spin" /> 부하 도구(Locust) 를 찾는 중…
          </div>
        ) : env?.ok ? (
          <div className="flex items-center gap-2 border-b border-white/10 bg-panel-light/40 px-4 py-1.5 text-[11.5px] text-gray-400">
            <CircleCheck size={12} className="text-emerald-400" />
            <span className="text-gray-300">{env.version}</span>
            <span className="text-gray-600">· {env.how}</span>
            <button onClick={() => void checkEnv()} className="ml-auto text-[11px] text-gray-500 hover:text-gray-300">
              다시 확인
            </button>
          </div>
        ) : (
          <div className="border-b border-amber-500/20 bg-amber-500/[0.07] px-4 py-2.5">
            <div className="flex items-start gap-2">
              <TriangleAlert size={14} className="mt-0.5 shrink-0 text-amber-300" />
              <div className="min-w-0 flex-1">
                <p className="text-[12.5px] font-medium text-amber-100">
                  {env?.problem ?? '부하 도구를 찾을 수 없습니다.'}
                </p>
                <p className="mt-1 text-[11.5px] leading-relaxed text-gray-300">
                  {env?.hint} 설치가 끝나면 <span className="text-gray-100">다시 확인</span> 을 누르세요 — 그때까지
                  시작 버튼은 눌리지 않습니다.
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <code className="rounded bg-black/40 px-2 py-1 font-mono text-[11px] text-gray-300">
                    pip install locust
                  </code>
                  <button
                    onClick={() => void checkEnv()}
                    className="flex items-center gap-1 rounded border border-white/15 bg-panel-light px-2 py-1 text-[11.5px] text-gray-200 hover:bg-white/10"
                  >
                    <RefreshCw size={11} /> 다시 확인
                  </button>
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <span className="shrink-0 text-[11px] text-gray-500">직접 지정</span>
                  <input
                    value={locustPath}
                    onChange={(e) => setLocustPath(e.target.value)}
                    placeholder="C:\\Python312\\Scripts\\locust.exe"
                    className={inputCls + ' min-w-0 flex-1 font-mono'}
                  />
                  <button
                    onClick={async () => {
                      await window.electronAPI.perfSetLocustPath(locustPath.trim() || null)
                      await checkEnv()
                    }}
                    className="shrink-0 rounded border border-white/15 bg-panel-light px-2 py-1 text-[11.5px] text-gray-200 hover:bg-white/10"
                  >
                    적용
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        <div className="flex min-h-0 flex-1">
          {/* 왼쪽 — 설정 + 회차 */}
          {/* 왼쪽을 둘로 나눈다 — 설정이 남는 높이를 먹고, 회차는 내용만큼만 차지한다.
              전에는 회차가 긴 칸의 맨 아래에 붙어 회차 하나에 빈 공간이 한 뼘씩 남았다. */}
          <div className="flex w-[392px] shrink-0 flex-col overflow-hidden border-r border-white/10">
            <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {/* 대상 — 어디를 때리는가 */}
            <Card icon={<Target size={12} />} title="대상">
              <select
                value={sessionId}
                onChange={(e) => setSessionId(e.target.value)}
                disabled={!!running}
                className={inputCls + ' w-full disabled:opacity-50'}
              >
                {sessions.length === 0 && <option value="">연결된 세션이 없습니다</option>}
                {sessions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
              <input
                value={targetUrl}
                onChange={(e) => {
                  urlTouched.current = true
                  setTargetUrl(e.target.value)
                }}
                disabled={!!running}
                placeholder="https://10.255.233.21:5000"
                className={inputCls + ' mt-1.5 w-full font-mono disabled:opacity-50'}
              />
              <label className="mt-1.5 flex items-center gap-2 text-[11px] text-gray-300">
                <input
                  type="checkbox"
                  checked={insecure}
                  disabled={!!running || scenarioKind === 'file'}
                  onChange={(e) => setInsecure(e.target.checked)}
                />
                자체 서명 인증서 무시
                <span className="text-[10px] text-gray-600">사내 인프라는 대개 필요</span>
              </label>
              <p className="mt-1 text-[10px] leading-relaxed text-gray-600">
                세션에서 가져온 주소입니다. 이 PC 에서 안 닿으면 포트 포워딩으로 로컬 포트를 열고 그 주소를 적으세요.
              </p>
            </Card>

            {/* 부하 — 얼마나 세게 */}
            <Card icon={<Gauge size={12} />} title="부하">
              <div className="flex flex-wrap gap-1">
                {LOAD_PRESETS.map((pre) => {
                  const on = users === String(pre.users) && spawnRate === String(pre.rate) && durationMin === String(pre.min)
                  return (
                    <button
                      key={pre.label}
                      onClick={() => {
                        setUsers(String(pre.users))
                        setSpawnRate(String(pre.rate))
                        setDurationMin(String(pre.min))
                      }}
                      disabled={!!running}
                      title={`사용자 ${pre.users}명 · ${pre.rate}명/초 · ${pre.min}분`}
                      className={
                        'rounded-full px-2 py-0.5 text-[10.5px] disabled:opacity-50 ' +
                        (on ? 'bg-blue-600/70 text-white' : 'bg-black/25 text-gray-400 hover:text-gray-200')
                      }
                    >
                      {pre.label}
                    </button>
                  )
                })}
              </div>
              <div className="mt-1.5 grid grid-cols-3 gap-1.5">
                <Field label="사용자" unit="명" value={users} onChange={setUsers} disabled={!!running} />
                <Field label="증가" unit="명/초" value={spawnRate} onChange={setSpawnRate} disabled={!!running} />
                <Field label="시간" unit="분" value={durationMin} onChange={setDurationMin} disabled={!!running} />
              </div>
              {/* 숫자 세 개가 실제로 무슨 뜻인지 한 문장으로 되짚는다 — 이게 없으면
                  '증가 5' 가 무엇을 5 하는 것인지 매번 짐작하게 된다 */}
              <p className="mt-1.5 rounded bg-black/20 px-2 py-1 text-[10.5px] leading-relaxed text-gray-400">
                {loadSentence}
              </p>
            </Card>

            {/* 판정 기준 — 없으면 초록을 띄우지 않는다 */}
            <Card
              icon={<CircleCheck size={12} />}
              title="판정 기준"
              badge={
                p95Th.trim() || errTh.trim() ? undefined : (
                  <span className="rounded bg-white/10 px-1.5 py-0.5 text-[9.5px] text-gray-400">
                    비워 두면 측정값만
                  </span>
                )
              }
            >
              <div className="grid grid-cols-2 gap-1.5">
                <Field label="p95 이하" unit="ms" value={p95Th} onChange={setP95Th} disabled={!!running} placeholder="500" />
                <Field label="실패율 이하" unit="%" value={errTh} onChange={setErrTh} disabled={!!running} placeholder="1" />
              </div>
            </Card>

            {/* 시나리오 — 무엇을 요청할지 */}
            <Card icon={<FileCode size={12} />} title="시나리오">
              <div className="flex gap-1 rounded-md bg-black/25 p-0.5">
                {(['form', 'file'] as const).map((k) => (
                  <button
                    key={k}
                    onClick={() => setScenarioKind(k)}
                    disabled={!!running}
                    className={
                      'flex-1 rounded px-2 py-1 text-[11px] disabled:opacity-50 ' +
                      (scenarioKind === k ? 'bg-blue-600/70 text-white' : 'text-gray-400 hover:text-gray-200')
                    }
                  >
                    {k === 'form' ? '폼으로 만들기' : '파일 고르기'}
                  </button>
                ))}
              </div>

              {scenarioKind === 'form' ? (
                <>
                  <div className="mt-2 flex items-center gap-1.5">
                    <select
                      value={method}
                      onChange={(e) => setMethod(e.target.value as 'GET' | 'POST')}
                      disabled={!!running}
                      className={inputCls + ' shrink-0 disabled:opacity-50'}
                    >
                      <option value="GET">GET</option>
                      <option value="POST">POST</option>
                    </select>
                    <span className="min-w-0 flex-1 text-[10.5px] text-gray-500">경로 — 한 줄에 하나</span>
                  </div>
                  <textarea
                    value={paths}
                    onChange={(e) => setPaths(e.target.value)}
                    disabled={!!running}
                    rows={3}
                    placeholder={'/v3\n/v3/auth/tokens'}
                    className={inputCls + ' mt-1 w-full resize-y font-mono disabled:opacity-50'}
                  />
                  {method === 'POST' && (
                    <textarea
                      value={body}
                      onChange={(e) => setBody(e.target.value)}
                      disabled={!!running}
                      rows={3}
                      placeholder={'본문 (JSON)\n{"key": "value"}'}
                      className={inputCls + ' mt-1.5 w-full resize-y font-mono disabled:opacity-50'}
                    />
                  )}
                  <div className="mt-1.5 flex items-center gap-1.5">
                    <span className="shrink-0 text-[10.5px] text-gray-500">요청 사이 대기</span>
                    <input
                      value={waitMin}
                      onChange={(e) => setWaitMin(e.target.value)}
                      disabled={!!running}
                      className={inputCls + ' w-12 shrink-0 text-center disabled:opacity-50'}
                    />
                    <span className="shrink-0 text-gray-600">~</span>
                    <input
                      value={waitMax}
                      onChange={(e) => setWaitMax(e.target.value)}
                      disabled={!!running}
                      className={inputCls + ' w-12 shrink-0 text-center disabled:opacity-50'}
                    />
                    <span className="shrink-0 text-[10.5px] text-gray-500">초</span>
                    <button
                      onClick={async () => {
                        const r = await window.electronAPI.perfPreviewScenario(buildConfig())
                        setPreview(r.text)
                      }}
                      className="ml-auto shrink-0 rounded border border-white/15 bg-panel-light px-2 py-0.5 text-[10.5px] text-gray-300 hover:bg-white/10"
                    >
                      미리보기
                    </button>
                  </div>
                  <textarea
                    value={headerText}
                    onChange={(e) => setHeaderText(e.target.value)}
                    disabled={!!running}
                    rows={2}
                    placeholder={'헤더 — 한 줄에 하나\nX-Auth-Token: ...'}
                    className={inputCls + ' mt-1.5 w-full resize-y font-mono disabled:opacity-50'}
                  />
                </>
              ) : (
                <div className="mt-2 flex items-center gap-1.5">
                  <input
                    value={scenarioFile}
                    onChange={(e) => setScenarioFile(e.target.value)}
                    disabled={!!running}
                    placeholder="locustfile.py"
                    className={inputCls + ' min-w-0 flex-1 font-mono disabled:opacity-50'}
                  />
                  <button
                    onClick={async () => {
                      const r = await window.electronAPI.perfPickScenario()
                      if (r.path) setScenarioFile(r.path)
                    }}
                    disabled={!!running}
                    className="shrink-0 rounded border border-white/15 bg-panel-light p-1.5 text-gray-300 hover:bg-white/10 disabled:opacity-50"
                    title="파일 고르기"
                  >
                    <FileCode size={13} />
                  </button>
                </div>
              )}
            </Card>

            {!running ? (
              <button
                onClick={() => void start()}
                disabled={!!blockedReason}
                title={blockedReason || '부하를 시작합니다'}
                className="mt-3 flex items-center justify-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-[12px] font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Play size={13} /> 시작
              </button>
            ) : (
              <button
                onClick={() => void window.electronAPI.perfCancel()}
                className="mt-3 flex items-center justify-center gap-1.5 rounded-md border border-red-500/40 px-3 py-1.5 text-[12px] text-red-300 hover:bg-red-500/10"
              >
                <Square size={12} /> 중지
              </button>
            )}
            {blockedReason && !running && (
              <p className="mt-1 text-[10.5px] leading-relaxed text-amber-300/80">{blockedReason}</p>
            )}
            {startError && <p className="mt-1 text-[10.5px] leading-relaxed text-red-300">{startError}</p>}

            </div>

            {/* 회차 — 아래에 붙이고 높이는 내용만큼 (많아지면 이 안에서만 스크롤) */}
            <div className="max-h-[45%] shrink-0 overflow-y-auto border-t border-white/10 px-3 pb-3 pt-2">
              <div className="flex items-center gap-2">
                <span className="text-[10.5px] font-medium uppercase tracking-wide text-gray-500">
                  회차 {runs.length > 0 && <span className="text-gray-600">{runs.length}</span>}
                </span>
                <button
                  onClick={() => void refreshRuns()}
                  className="ml-auto rounded p-0.5 text-gray-600 hover:bg-white/10 hover:text-gray-300"
                  title="새로 읽기"
                >
                  <RefreshCw size={11} />
                </button>
              </div>
              {runs.length === 0 ? (
                <p className="py-2 text-[11px] leading-relaxed text-gray-600">
                  아직 돌린 적이 없습니다. 한 번 돌리면 조건과 결과가 여기 쌓여 회차끼리 비교할 수 있습니다.
                </p>
              ) : (
                <div className="mt-1 space-y-1">
                  {runs.map((r) => {
                    const sum = r.statsCsv ? parseLocustStats(r.statsCsv) : null
                    const isRunning = running?.id === r.meta.id
                    return (
                      <div
                        key={r.meta.id}
                        className={
                          'group flex items-start gap-1 rounded-md px-2 py-1.5 ' +
                          (selectedRunId === r.meta.id ? 'bg-blue-600/25' : 'hover:bg-white/5')
                        }
                      >
                        <button
                          onClick={() => {
                            setSelectedRunId(r.meta.id)
                            if (!running) setTab('summary')
                          }}
                          className="min-w-0 flex-1 text-left"
                        >
                          <div className="flex items-baseline gap-1.5">
                            <span className="min-w-0 truncate text-[11.5px] text-gray-200">
                              {new Date(r.meta.startedAt).toLocaleString('ko-KR', { hour12: false }).slice(5, 16)}
                            </span>
                            {isRunning && <span className="shrink-0 text-[10px] text-blue-300">진행 중</span>}
                            {r.meta.canceled && <span className="shrink-0 text-[10px] text-amber-300/80">중지</span>}
                            {/* 어떤 조건으로 돌린 회차인지 — 이것이 없으면 회차끼리 비교가 안 된다 */}
                            <span className="ml-auto shrink-0 text-[10px] text-gray-600">
                              사용자 {r.meta.config.users} · {Math.round(r.meta.config.durationSec / 60)}분
                            </span>
                          </div>
                          <div className="mt-0.5 flex items-baseline gap-1.5 text-[10px]">
                            {sum ? (
                              <>
                                <span className="text-gray-400">p95 {fmtMs(sum.p95Ms)}</span>
                                <span className={sum.failRatePct > 0 ? 'text-amber-300/90' : 'text-gray-500'}>
                                  실패 {sum.failRatePct.toFixed(2)}%
                                </span>
                                <span className="ml-auto shrink-0 text-gray-600">{fmtInt(sum.rps)} req/s</span>
                              </>
                            ) : (
                              <span className="text-gray-600">
                                {isRunning ? '끝나면 결과가 채워집니다' : r.meta.canceled ? '결과 없음' : '통계 없음'}
                              </span>
                            )}
                          </div>
                        </button>
                        {!isRunning && (
                          <button
                            onClick={() => setConfirmDelete(r)}
                            title="이 회차 삭제"
                            className="mt-0.5 shrink-0 rounded p-0.5 text-gray-600 hover:bg-white/10 hover:text-red-300"
                          >
                            <Trash2 size={11} />
                          </button>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>

          {/* 오른쪽 — 타일 + 탭 */}
          <div className="flex min-w-0 flex-1 flex-col p-3">
            <div className="grid grid-cols-4 gap-2">
              {[
                { label: '초당 요청', value: fmtInt(tiles.rps) },
                { label: 'p95 응답', value: fmtMs(tiles.p95) },
                {
                  label: '실패율',
                  value: tiles.failPct === undefined ? '–' : `${tiles.failPct.toFixed(2)}%`,
                  warn: (tiles.failPct ?? 0) > 0,
                },
                { label: '총 요청', value: fmtInt(tiles.requests) },
              ].map((t) => (
                <div key={t.label} className="rounded-md border border-white/10 bg-panel-light/40 p-2.5">
                  <div className="text-[10px] text-gray-500">{t.label}</div>
                  <div className={'mt-0.5 text-lg font-medium ' + (t.warn ? 'text-amber-300' : 'text-gray-100')}>
                    {t.value}
                  </div>
                </div>
              ))}
            </div>
            {running && (
              <p className="mt-1 text-[10px] text-gray-600">
                돌고 있는 동안은 1.5초마다 Locust 통계를 받아 옵니다 — 끝나면 통계 파일로 다시 계산합니다.
              </p>
            )}

            <div className="mt-2 flex gap-1 border-b border-white/10">
              {(
                [
                  ['dash', '대시보드'],
                  ['log', '실시간 로그'],
                  ['summary', '요약'],
                ] as const
              ).map(([k, label]) => (
                <button
                  key={k}
                  onClick={() => setTab(k)}
                  className={
                    'px-3 py-1.5 text-[11.5px] ' +
                    (tab === k
                      ? 'border-b-2 border-blue-500 text-blue-200'
                      : 'text-gray-400 hover:text-gray-200')
                  }
                >
                  {label}
                </button>
              ))}
            </div>

            <div className="mt-2 min-h-0 flex-1 overflow-hidden">
              {tab === 'dash' &&
                (running?.webUrl ? (
                  dashReady ? (
                    // 돌고 있는 동안의 대시보드는 http 라 dev·배포에서 똑같이 끼워진다.
                    // (정적 리포트는 file:// 이라 별도 창으로 띄운다 — perf:openReport)
                    <div className="flex h-full flex-col">
                      <div className="mb-1 flex items-center gap-2 text-[10px] text-gray-600">
                        <span className="min-w-0 flex-1 truncate">{running.webUrl}</span>
                        <button
                          onClick={() => setDashKey((k) => k + 1)}
                          className="shrink-0 rounded border border-white/10 px-1.5 py-0.5 text-gray-400 hover:bg-white/10 hover:text-gray-200"
                        >
                          다시 불러오기
                        </button>
                      </div>
                      <iframe
                        key={dashKey}
                        src={running.webUrl.replace(/\/+$/, '') + '/'}
                        title="Locust 대시보드"
                        className="min-h-0 w-full flex-1 rounded-md border border-white/10 bg-white"
                      />
                    </div>
                  ) : (
                    <div className="flex h-full flex-col items-center justify-center gap-2 rounded-md border border-dashed border-white/15 p-6 text-center">
                      <RefreshCw size={18} className="animate-spin text-gray-600" />
                      <p className="text-[12px] leading-relaxed text-gray-500">
                        대시보드를 준비하는 중입니다…
                        <br />
                        <span className="text-[11px] text-gray-600">
                          Locust 가 웹 화면을 띄우면 여기 들어옵니다. 그 사이 진행 상황은{' '}
                          <span className="text-gray-400">실시간 로그</span> 에서 볼 수 있습니다.
                        </span>
                      </p>
                    </div>
                  )
                ) : (
                  <div className="flex h-full flex-col items-center justify-center gap-2 rounded-md border border-dashed border-white/15 p-6 text-center">
                    <Gauge size={20} className="text-gray-600" />
                    <p className="text-[12px] leading-relaxed text-gray-500">
                      실시간 대시보드는 <span className="text-gray-300">돌고 있는 동안</span>만 뜹니다.
                      <br />
                      끝난 회차는 아래 <span className="text-gray-300">원본 리포트 열기</span> 로 보세요.
                    </p>
                    {selected && !selected.meta.canceled && (
                      <button
                        onClick={async () => {
                          const r = await window.electronAPI.perfOpenReport(selected.meta.id)
                          if (!r.ok) setNote(r.error ?? '리포트를 열 수 없습니다.')
                        }}
                        className="mt-1 flex items-center gap-1.5 rounded-md border border-white/15 bg-panel-light px-2.5 py-1 text-[11.5px] text-gray-200 hover:bg-white/10"
                      >
                        <ExternalLink size={12} /> 원본 리포트 열기
                      </button>
                    )}
                  </div>
                ))}

              {tab === 'log' && (
                <div
                  ref={logRef}
                  className="h-full overflow-auto rounded-md bg-black/40 p-2.5 font-mono text-[11px] leading-relaxed text-gray-300"
                >
                  {log ? (
                    // 로그에 토큰·비밀번호가 섞여 나온다 — 화면 마스킹 설정을 그대로 따른다
                    <pre className="whitespace-pre-wrap break-all">{maskForDisplay(log)}</pre>
                  ) : (
                    <p className="text-gray-600">시작하면 부하 도구의 출력이 여기 흐릅니다.</p>
                  )}
                </div>
              )}

              {tab === 'summary' && (
                <div className="h-full overflow-auto pr-1">
                  {!selected ? (
                    <p className="text-[12px] text-gray-500">왼쪽에서 회차를 고르세요.</p>
                  ) : (
                    <>
                      {verdict && (
                        <div
                          className={
                            'rounded-md border p-2.5 ' +
                            (verdict.tone === 'pass'
                              ? 'border-emerald-500/30 bg-emerald-500/[0.07]'
                              : verdict.tone === 'fail'
                                ? 'border-red-500/30 bg-red-500/[0.07]'
                                : 'border-white/10 bg-panel-light/40')
                          }
                        >
                          <div className="flex items-center gap-1.5">
                            {verdict.tone === 'pass' ? (
                              <CircleCheck size={14} className="text-emerald-400" />
                            ) : verdict.tone === 'fail' ? (
                              <TriangleAlert size={14} className="text-red-300" />
                            ) : (
                              <Info size={14} className="text-gray-400" />
                            )}
                            <span
                              className={
                                'text-[12.5px] font-medium ' +
                                (verdict.tone === 'pass'
                                  ? 'text-emerald-200'
                                  : verdict.tone === 'fail'
                                    ? 'text-red-200'
                                    : 'text-gray-200')
                              }
                            >
                              {verdict.label}
                            </span>
                            <span className="ml-auto text-[10.5px] text-gray-500">
                              {new Date(selected.meta.startedAt).toLocaleString('ko-KR', { hour12: false })}
                              {selected.meta.endedAt &&
                                ` · ${Math.round((selected.meta.endedAt - selected.meta.startedAt) / 1000)}초 걸림`}
                            </span>
                          </div>
                          <ul className="mt-1 space-y-0.5">
                            {verdict.reasons.map((r, i) => (
                              <li key={i} className="text-[11px] leading-relaxed text-gray-400">
                                · {r}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}

                      {/* 응답 시간 분포 — 평균만 보면 꼬리를 놓친다 */}
                      {selectedSummary && (
                        <div className="mt-2 grid grid-cols-4 gap-2">
                          {(
                            [
                              ['중앙값 p50', selectedSummary.p50Ms],
                              ['p95', selectedSummary.p95Ms],
                              ['p99', selectedSummary.p99Ms],
                              ['최대', selectedSummary.maxMs],
                            ] as const
                          ).map(([label, v]) => (
                            <div key={label} className="rounded-md border border-white/10 bg-panel-light/25 p-2">
                              <div className="text-[10px] text-gray-500">{label}</div>
                              <div className="mt-0.5 text-[13.5px] tabular-nums text-gray-100">{fmtMs(v)}</div>
                            </div>
                          ))}
                        </div>
                      )}

                      {/* 직전 회차와 비교 — 성능은 절대값보다 '지난번보다 나빠졌나' 로 읽는다 */}
                      {compare && (
                        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-white/10 bg-panel-light/25 px-2.5 py-2 text-[11px]">
                          <span className="shrink-0 text-gray-500">
                            직전 회차({new Date(compare.at).toLocaleString('ko-KR', { hour12: false }).slice(5, 16)}) 대비
                          </span>
                          {compare.items.map((it) => (
                            <span key={it.label} className="flex items-center gap-1">
                              <span className="text-gray-500">{it.label}</span>
                              <span className="tabular-nums text-gray-400">{it.before}</span>
                              <ArrowRight size={10} className="text-gray-600" />
                              <span className="tabular-nums text-gray-200">{it.after}</span>
                              <span
                                className={
                                  'tabular-nums ' +
                                  (it.worse === null
                                    ? 'text-gray-500'
                                    : it.worse
                                      ? 'text-red-300'
                                      : 'text-emerald-300')
                                }
                              >
                                {it.delta}
                              </span>
                            </span>
                          ))}
                        </div>
                      )}

                      {/* 무엇이 실패했나 — 인프라에서는 실패율 숫자보다 이게 먼저다 */}
                      {failures.length > 0 && (
                        <div className="mt-3">
                          <div className="mb-1 flex items-center gap-1.5">
                            <TriangleAlert size={12} className="text-amber-300" />
                            <span className="text-[11px] font-medium text-gray-300">실패 내용</span>
                            <span className="text-[10px] text-gray-600">많은 것부터</span>
                          </div>
                          <table className="w-full table-fixed text-[11.5px]">
                            <tbody>
                              {failures.slice(0, 6).map((f, i) => (
                                <tr key={i} className="border-t border-white/5">
                                  <td className="w-[34%] truncate py-1 font-mono text-gray-400" title={f.name}>
                                    {f.name}
                                  </td>
                                  <td className="truncate py-1 text-amber-200/90" title={f.error}>
                                    {f.error}
                                  </td>
                                  <td className="w-16 py-1 text-right tabular-nums text-gray-400">
                                    {fmtInt(f.count)}건
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                          {failures.length > 6 && (
                            <p className="mt-1 text-[10px] text-gray-600">
                              그 외 {failures.length - 6}종은 원본 리포트에서 볼 수 있습니다.
                            </p>
                          )}
                        </div>
                      )}

                      {/* 요청별 — p95 를 막대로 같이 보여 어느 경로가 느린지 눈에 들어오게 */}
                      {selectedSummary && selectedSummary.perEndpoint.length > 0 && (
                        <div className="mt-3">
                          <div className="mb-1 text-[11px] font-medium text-gray-300">요청별</div>
                          <table className="w-full table-fixed text-[11.5px]">
                            <thead>
                              <tr className="text-left text-[10.5px] text-gray-500">
                                <th className="w-[34%] pb-1 font-normal">요청</th>
                                <th className="w-16 pb-1 text-right font-normal">건수</th>
                                <th className="w-14 pb-1 text-right font-normal">실패</th>
                                <th className="w-16 pb-1 text-right font-normal">평균</th>
                                <th className="pb-1 pl-3 font-normal">p95</th>
                              </tr>
                            </thead>
                            <tbody>
                              {selectedSummary.perEndpoint.map((e) => {
                                const max = Math.max(
                                  1,
                                  ...selectedSummary.perEndpoint.map((x) => x.p95Ms ?? 0),
                                )
                                const w = Math.round(((e.p95Ms ?? 0) / max) * 100)
                                return (
                                  <tr key={e.name} className="border-t border-white/5">
                                    <td className="truncate py-1 font-mono text-gray-300" title={e.name}>
                                      {e.name}
                                    </td>
                                    <td className="py-1 text-right tabular-nums text-gray-400">{fmtInt(e.requests)}</td>
                                    <td
                                      className={
                                        'py-1 text-right tabular-nums ' +
                                        (e.failures > 0 ? 'text-amber-300' : 'text-gray-500')
                                      }
                                    >
                                      {fmtInt(e.failures)}
                                    </td>
                                    <td className="py-1 text-right tabular-nums text-gray-400">{fmtMs(e.avgMs)}</td>
                                    <td className="py-1 pl-3">
                                      <div className="flex items-center gap-2">
                                        <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-white/[0.06]">
                                          <span
                                            className="block h-full rounded-full bg-blue-500/60"
                                            style={{ width: `${w}%` }}
                                          />
                                        </span>
                                        <span className="w-14 shrink-0 text-right tabular-nums text-gray-400">
                                          {fmtMs(e.p95Ms)}
                                        </span>
                                      </div>
                                    </td>
                                  </tr>
                                )
                              })}
                            </tbody>
                          </table>
                        </div>
                      )}

                      {/* 어떤 조건으로 돌린 회차인가 — 표만 남기면 나중에 조건을 잊는다 */}
                      <div className="mt-3 rounded-md border border-white/10 bg-panel-light/25 p-2.5">
                        <div className="mb-1.5 text-[11px] font-medium text-gray-300">실행 조건</div>
                        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
                          {(
                            [
                              ['대상', selected.meta.config.targetUrl],
                              [
                                '부하',
                                `사용자 ${selected.meta.config.users}명 · ${selected.meta.config.spawnRate}명/초 · ${Math.round(
                                  selected.meta.config.durationSec / 60,
                                )}분`,
                              ],
                              [
                                '세션',
                                selected.meta.config.sessionLabel ?? '—',
                              ],
                              [
                                '시나리오',
                                selected.meta.config.scenario.kind === 'form'
                                  ? `폼 · ${selected.meta.config.scenario.method} ${selected.meta.config.scenario.paths.join(', ') || '/'}`
                                  : `파일 · ${selected.meta.config.scenario.path}`,
                              ],
                              [
                                '판정 기준',
                                [
                                  selected.meta.config.p95ThresholdMs !== undefined
                                    ? `p95 ${selected.meta.config.p95ThresholdMs}ms 이하`
                                    : null,
                                  selected.meta.config.errorRateThresholdPct !== undefined
                                    ? `실패율 ${selected.meta.config.errorRateThresholdPct}% 이하`
                                    : null,
                                ]
                                  .filter(Boolean)
                                  .join(' · ') || '없음 (측정값만)',
                              ],
                              [
                                '인증서',
                                selected.meta.config.insecureTls ? '자체 서명 무시' : '검증',
                              ],
                            ] as const
                          ).map(([k, v]) => (
                            <div key={k} className="flex min-w-0 gap-2">
                              <dt className="w-16 shrink-0 text-gray-500">{k}</dt>
                              <dd className="min-w-0 flex-1 truncate text-gray-300" title={String(v)}>
                                {v}
                              </dd>
                            </div>
                          ))}
                        </dl>
                      </div>

                      {/* 내보내기 */}
                      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-white/10 pt-2.5">
                        <button
                          onClick={async () => {
                            const r = await window.electronAPI.perfOpenReport(selected.meta.id)
                            if (!r.ok) setNote(r.error ?? '리포트를 열 수 없습니다.')
                          }}
                          className="flex items-center gap-1 rounded border border-white/15 bg-panel-light px-2 py-1 text-[11px] text-gray-200 hover:bg-white/10"
                        >
                          <ExternalLink size={11} /> 원본 리포트 열기
                        </button>
                        <button
                          onClick={async () => {
                            const r = await window.electronAPI.perfSaveReport(selected.meta.id)
                            if (r.saved) setNote(`리포트를 저장했습니다 — ${r.path}`)
                            else if (r.error) setNote(r.error)
                          }}
                          className="flex items-center gap-1 rounded border border-white/15 bg-panel-light px-2 py-1 text-[11px] text-gray-200 hover:bg-white/10"
                        >
                          <Download size={11} /> 리포트 저장 (HTML)
                        </button>
                        <button
                          onClick={async () => {
                            const r = await window.electronAPI.perfSaveCsv(selected.meta.id)
                            if (r.saved) setNote(`통계를 저장했습니다 — ${r.path}`)
                            else if (r.error) setNote(r.error)
                          }}
                          className="flex items-center gap-1 rounded border border-white/15 bg-panel-light px-2 py-1 text-[11px] text-gray-200 hover:bg-white/10"
                        >
                          <Download size={11} /> 통계 저장 (CSV)
                        </button>
                        <button
                          onClick={() => void window.electronAPI.perfOpenFolder(selected.meta.id)}
                          className="flex items-center gap-1 rounded border border-white/15 bg-panel-light px-2 py-1 text-[11px] text-gray-200 hover:bg-white/10"
                        >
                          <FolderOpen size={11} /> 폴더 열기
                        </button>
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* 만들어 줄 locustfile 미리보기 — 무엇이 돌아갈지 모르는 채 부하를 걸지 않게 */}
      {preview !== null && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-6">
          <div className="flex h-full max-h-[560px] w-[720px] max-w-[92vw] flex-col overflow-hidden rounded-lg border border-white/10 bg-panel shadow-2xl">
            <div className="flex items-center gap-2 border-b border-white/10 px-4 py-2">
              <FileCode size={13} className="text-blue-300" />
              <span className="text-[12.5px] font-medium text-gray-100">locustfile.py — 이대로 실행됩니다</span>
              <button
                onClick={() => setPreview(null)}
                className="ml-auto rounded p-1 text-gray-500 hover:bg-white/10 hover:text-gray-200"
              >
                <X size={14} />
              </button>
            </div>
            <pre className="min-h-0 flex-1 overflow-auto bg-black/40 p-3 font-mono text-[11.5px] leading-relaxed text-gray-300">
              {preview}
            </pre>
            <div className="flex items-center gap-2 border-t border-white/10 px-4 py-2">
              <p className="min-w-0 flex-1 text-[10.5px] leading-relaxed text-gray-500">
                회차 폴더에도 같은 파일이 남습니다. 고쳐 쓰려면 그 파일을 복사해 두고 '파일 고르기' 로 선택하세요.
              </p>
              <button
                onClick={() => setPreview(null)}
                className="shrink-0 rounded-md border border-white/10 bg-panel-light px-3 py-1 text-[11.5px] text-gray-200 hover:bg-white/10"
              >
                닫기
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmDelete && (
        <ConfirmDialog
          title="회차 삭제"
          message={
            `${new Date(confirmDelete.meta.startedAt).toLocaleString('ko-KR', { hour12: false })} 회차를 지울까요?\n\n` +
            '지워지는 것 — 통계·리포트·시나리오 파일이 든 회차 폴더 전체'
          }
          onCancel={() => setConfirmDelete(null)}
          onConfirm={async () => {
            const id = confirmDelete.meta.id
            setConfirmDelete(null)
            const r = await window.electronAPI.perfDelete(id)
            if (!r.ok) setNote(r.error ?? '지우지 못했습니다.')
            if (selectedRunId === id) setSelectedRunId(null)
            await refreshRuns()
          }}
        />
      )}
    </div>
  )
}
