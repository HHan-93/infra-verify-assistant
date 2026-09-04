import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
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
  ChevronDown,
  ChevronRight,
  ChevronUp,
  ClipboardPaste,
  Sparkles,
  PanelRightOpen,
  Save,
  Upload,
} from 'lucide-react'
import type {
  PerfEnvStatus,
  PerfPreset,
  PerfRunConfig,
  PerfRunMeta,
  PerfRunRecord,
  PerfStep,
} from '../../electron/shared-types'
import { normalizeFormScenario } from '../../electron/shared-types'
// 브라우저에서 복사한 요청을 그대로 가져오는 파서 — 포털 감시가 쓰는 것과 같은 것을 쓴다
import { parseCurl } from '../lib/portal'
import {
  parseLocustConsole,
  parseLocustFailures,
  parseLocustHistory,
  parseLocustStats,
  parseStatsApi,
  type PerfHistoryPoint,
  type PerfLive,
  type PerfSummary,
} from '../lib/perfParse'
import { perfVerdict } from '../lib/perfVerdict'
import { maskForAI, maskForDisplay } from '../lib/mask'
import { notifyOs } from '../lib/notify'
import ConfirmDialog from './ConfirmDialog'

interface PerfTarget {
  id: string
  name: string
}

interface PerfPanelProps {
  /** 연결된 세션 — 대상 주소를 여기서 가져온다(부하는 이 PC 에서 나간다) */
  sessions: PerfTarget[]
  onClose: () => void
  /** 결과 요약을 AI 패널로 보내 해석을 맡긴다 (스트리밍 중이면 false) */
  onAnalyze: (text: string) => boolean
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

/** 그래프 범례 한 칸 */
function Legend({ color, label, dashed }: { color: string; label: string; dashed?: boolean }) {
  return (
    <span className="flex items-center gap-1">
      <span
        className="inline-block h-0 w-3 shrink-0"
        style={{ borderTop: `2px ${dashed ? 'dashed' : 'solid'} ${color}` }}
      />
      {label}
    </span>
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
/** 초당 바이트 → 사람이 읽는 단위 */
function fmtRate(bytesPerSec?: number): string {
  if (bytesPerSec === undefined || !Number.isFinite(bytesPerSec)) return '–'
  const mbps = (bytesPerSec * 8) / 1_000_000
  if (mbps >= 1) return `${mbps.toFixed(1)} Mbps`
  return `${((bytesPerSec * 8) / 1000).toFixed(0)} kbps`
}
function fmtBytes(b?: number): string {
  if (b === undefined) return '–'
  if (b < 1024) return `${Math.round(b)}B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)}KB`
  return `${(b / 1024 / 1024).toFixed(1)}MB`
}

export default function PerfPanel({ sessions, onClose, onAnalyze }: PerfPanelProps) {
  const [env, setEnv] = useState<PerfEnvStatus | null>(null)
  const [envChecking, setEnvChecking] = useState(true)
  const [locustPath, setLocustPath] = useState('')

  const [sessionId, setSessionId] = useState(sessions[0]?.id ?? '')
  const [targetUrl, setTargetUrl] = useState('')
  const [users, setUsers] = useState('50')
  const [spawnRate, setSpawnRate] = useState('5')
  const [durationMin, setDurationMin] = useState('3')
  const [p50Th, setP50Th] = useState('')
  const [p95Th, setP95Th] = useState('')
  const [p99Th, setP99Th] = useState('')
  const [errTh, setErrTh] = useState('')
  const [warmupSec, setWarmupSec] = useState('')
  const [insecure, setInsecure] = useState(true)

  const [scenarioKind, setScenarioKind] = useState<'form' | 'file'>('form')
  /** 단계들 — 요청 하나가 한 줄. 비율(weight)로 실제 트래픽 모양을 흉내낸다 */
  const [steps, setSteps] = useState<PerfStep[]>([{ method: 'GET', path: '/', weight: 1 }])
  const [order, setOrder] = useState<'weighted' | 'sequential'>('weighted')
  /** 펼쳐서 이름·본문·헤더를 고치는 단계 (한 번에 하나) */
  const [openStep, setOpenStep] = useState<number | null>(null)
  const [commonHeaderText, setCommonHeaderText] = useState('')
  const [captureFailures, setCaptureFailures] = useState(true)
  const [waitMin, setWaitMin] = useState('1')
  const [waitMax, setWaitMax] = useState('2')
  const [scenarioFile, setScenarioFile] = useState('')
  /** 부하 모양 — 평평하게 유지할지, 계단식으로 올려 한계점을 찾을지 */
  /** 이 PC 코어 나눠 쓰기 · 다른 PC 워커 기다리기 */
  const [processes, setProcesses] = useState('1')
  const [expectWorkers, setExpectWorkers] = useState('0')
  /** 고급 설정 펼침 — 기본은 접힘, 편 상태는 기억한다 */
  const [advOpen, setAdvOpen] = useState(() => localStorage.getItem('perf_adv_open') === '1')
  /** 저장해 둔 검증 설정 */
  const [presets, setPresets] = useState<PerfPreset[]>([])
  const [presetName, setPresetName] = useState<string | null>(null)
  /** locust 설치 확인 창 */
  const [confirmInstall, setConfirmInstall] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [loadMode, setLoadMode] = useState<'flat' | 'stages'>('flat')
  const [stages, setStages] = useState<{ users: string; spawnRate: string; holdSec: string }[]>([
    { users: '10', spawnRate: '5', holdSec: '60' },
    { users: '50', spawnRate: '10', holdSec: '60' },
    { users: '200', spawnRate: '20', holdSec: '60' },
  ])
  /** cURL 붙여넣기 상자 (null 이면 안 열림) */
  const [curlText, setCurlText] = useState<string | null>(null)
  const [curlMsg, setCurlMsg] = useState('')

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
  /** 고른 회차의 초 단위 이력 — 목록에 얹으면 무거워서 고를 때만 읽는다 */
  const [history, setHistory] = useState<PerfHistoryPoint[]>([])
  /** 실패 응답 표본 (생성한 시나리오에서 '실패 본문 남기기' 를 켠 회차에만 있다) */
  const [samples, setSamples] = useState<
    { t: number; name: string; code: number | null; error: string; body: string }[]
  >([])
  const [openSample, setOpenSample] = useState<number | null>(null)
  /** 회차 이름·메모 편집 중인 값 (null 이면 안 열림) */
  const [labelEdit, setLabelEdit] = useState<{ label: string; memo: string } | null>(null)
  /**
   * 같은 시간대 **대상 서버**의 자원 (상태보드/대시보드의 모니터 데몬이 모아 둔 것).
   *
   * 이게 이 앱이라서 되는 부분이다 — 성능 도구만으로는 "응답이 느린데 서버 CPU 는 한가하다"
   * (= 서버가 아니라 다른 곳이 병목) 를 한 화면에서 볼 수 없다.
   */
  const [serverSeries, setServerSeries] = useState<{ sec: number; cpu?: number; mem?: number }[]>([])
  const [serverNote, setServerNote] = useState('')
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
    void window.electronAPI.perfPresetsList().then(setPresets)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const applyPreset = (pre: PerfPreset) => {
    const c = pre.config
    setUsers(String(c.users ?? 50))
    setSpawnRate(String(c.spawnRate ?? 5))
    setDurationMin(String(Math.round((c.durationSec ?? 180) / 60)))
    setP50Th(c.p50ThresholdMs !== undefined ? String(c.p50ThresholdMs) : '')
    setP95Th(c.p95ThresholdMs !== undefined ? String(c.p95ThresholdMs) : '')
    setP99Th(c.p99ThresholdMs !== undefined ? String(c.p99ThresholdMs) : '')
    setErrTh(c.errorRateThresholdPct !== undefined ? String(c.errorRateThresholdPct) : '')
    setWarmupSec(c.warmupSec !== undefined ? String(c.warmupSec) : '')
    setInsecure(!!c.insecureTls)
    setProcesses(String(c.processes ?? 1))
    setExpectWorkers(String(c.expectWorkers ?? 0))
    if (c.stages?.length) {
      setLoadMode('stages')
      setStages(
        c.stages.map((st) => ({
          users: String(st.users),
          spawnRate: String(st.spawnRate),
          holdSec: String(st.holdSec),
        })),
      )
    } else {
      setLoadMode('flat')
    }
    if (c.scenario.kind === 'file') {
      setScenarioKind('file')
      setScenarioFile(c.scenario.path)
    } else {
      setScenarioKind('form')
      const n = normalizeFormScenario(c.scenario)
      setSteps(n.steps.length ? n.steps : [{ method: 'GET', path: '/', weight: 1 }])
      setOrder(n.order)
      setCommonHeaderText(
        Object.entries(n.commonHeaders)
          .map(([k, v]) => `${k}: ${v}`)
          .join('\n'),
      )
      setCaptureFailures(n.captureFailures)
      setWaitMin(String(n.waitMinSec))
      setWaitMax(String(n.waitMaxSec))
    }
    setPresetName(pre.name)
    setNote(`'${pre.name}' 설정을 불러왔습니다 — 대상 주소는 그대로 둡니다.`)
  }

  const savePreset = async () => {
    const name = (presetName ?? '').trim()
    if (!name) {
      setNote('저장할 이름을 적어 주세요.')
      return
    }
    const cfg = buildConfig()
    const existing = presets.find((p) => p.name === name)
    const list = await window.electronAPI.perfPresetsUpsert({
      id: existing?.id ?? '',
      name,
      savedAt: Date.now(),
      config: {
        users: cfg.users,
        spawnRate: cfg.spawnRate,
        durationSec: cfg.durationSec,
        p50ThresholdMs: cfg.p50ThresholdMs,
        p95ThresholdMs: cfg.p95ThresholdMs,
        p99ThresholdMs: cfg.p99ThresholdMs,
        errorRateThresholdPct: cfg.errorRateThresholdPct,
        warmupSec: cfg.warmupSec,
        insecureTls: cfg.insecureTls,
        processes: cfg.processes,
        expectWorkers: cfg.expectWorkers,
        stages: cfg.stages,
        scenario: cfg.scenario,
      },
    })
    setPresets(list)
    setNote(existing ? `'${name}' 설정을 덮어썼습니다.` : `'${name}' 으로 저장했습니다.`)
  }

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
      // 검증은 몇 분 걸리는 일이라 창을 보고 있지 않을 때가 많다. 판정까지는 아직 모르므로
      // '끝났다' 만 알린다 — 알림에 결론을 적으려면 통계를 다시 읽어야 하고, 그 사이 알림이
      // 늦어지면 알림의 의미가 없다.
      if (!e.canceled) notifyOs('성능 검증 끝', '결과와 리포트가 회차로 남았습니다.')
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

  const parseHeaders = (text: string): Record<string, string> => {
    const out: Record<string, string> = {}
    for (const line of text.split('\n')) {
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
    p50ThresholdMs: numOrUndef(p50Th),
    p95ThresholdMs: numOrUndef(p95Th),
    p99ThresholdMs: numOrUndef(p99Th),
    errorRateThresholdPct: numOrUndef(errTh),
    warmupSec: numOrUndef(warmupSec),
    insecureTls: insecure,
    processes: Math.max(1, Number(processes) || 1),
    expectWorkers: Math.max(0, Number(expectWorkers) || 0),
    stages:
      loadMode === 'stages'
        ? stages
            .map((st) => ({
              users: Number(st.users) || 0,
              spawnRate: Number(st.spawnRate) || 1,
              holdSec: Number(st.holdSec) || 0,
            }))
            .filter((st) => st.users > 0 && st.holdSec > 0)
        : undefined,
    scenario:
      scenarioKind === 'file'
        ? { kind: 'file', path: scenarioFile }
        : {
            kind: 'form',
            steps: steps
              .map((st) => ({ ...st, path: st.path.trim() }))
              .filter((st) => st.path),
            order,
            commonHeaders: parseHeaders(commonHeaderText),
            captureFailures,
            waitMinSec: Number(waitMin) || 0,
            waitMaxSec: Number(waitMax) || 0,
          },
  })

  // ── 단계 편집 ─────────────────────────────────────────────
  const updateStep = (i: number, patch: Partial<PerfStep>) =>
    setSteps((prev) => prev.map((st, k) => (k === i ? { ...st, ...patch } : st)))
  const addStep = () => setSteps((prev) => [...prev, { method: 'GET', path: '/', weight: 1 }])
  const removeStep = (i: number) => {
    setSteps((prev) => (prev.length <= 1 ? prev : prev.filter((_, k) => k !== i)))
    setOpenStep(null)
  }
  const moveStep = (i: number, dir: -1 | 1) =>
    setSteps((prev) => {
      const j = i + dir
      if (j < 0 || j >= prev.length) return prev
      const next = [...prev]
      ;[next[i], next[j]] = [next[j], next[i]]
      return next
    })

  /**
   * cURL 을 단계로 만든다.
   *
   * 주소의 경로만 떼어 쓰고, **호스트가 대상과 다르면 대상 주소도 그 값으로 바꾼다** —
   * 브라우저에서 복사한 요청은 대개 진짜 대상을 가리키므로, 경로만 가져가면 엉뚱한 곳을 때린다.
   */
  const addFromCurl = (text: string) => {
    const parsed = parseCurl(text)
    if (!parsed) {
      setCurlMsg('cURL 명령을 읽지 못했습니다 — 개발자도구에서 복사한 내용을 그대로 붙여넣으세요.')
      return
    }
    let pathOnly = parsed.url
    let origin = ''
    try {
      const u = new URL(parsed.url)
      origin = u.origin
      pathOnly = u.pathname + (u.search || '')
    } catch {
      /* 상대 경로면 그대로 쓴다 */
    }
    const m = parsed.method.toUpperCase()
    const method: PerfStep['method'] = m === 'POST' || m === 'PUT' || m === 'DELETE' ? m : 'GET'
    // 인증·컨텐츠 관련 헤더만 남긴다. 브라우저가 붙이는 것을 다 넘기면 요청이 오히려 깨진다
    const keep = ['authorization', 'x-auth-token', 'content-type', 'accept', 'cookie', 'x-subject-token']
    const headers: Record<string, string> = {}
    const dropped: string[] = []
    for (const [k, v] of Object.entries(parsed.headers)) {
      if (keep.includes(k.toLowerCase())) headers[k] = v
      else dropped.push(k)
    }
    setSteps((prev) => [
      ...prev.filter((st) => st.path.trim()),
      { method, path: pathOnly, weight: 1, body: parsed.body, headers },
    ])
    if (origin && origin !== targetUrl.trim()) {
      urlTouched.current = true
      setTargetUrl(origin)
    }
    setCurlText(null)
    setCurlMsg('')
    setNote(
      `단계를 추가했습니다${origin ? ` · 대상을 ${origin} 로 맞췄습니다` : ''}${
        dropped.length ? ` · 헤더 ${dropped.length}개는 뺐습니다(${dropped.slice(0, 3).join(', ')}…)` : ''
      }`,
    )
  }

  /**
   * 부하 설정을 사람 말로 되짚는다.
   *
   * '사용자 50 / 증가 5 / 시간 3' 만 보면 무엇이 5 인지, 3분이 어디부터인지 매번 짐작하게 된다.
   * 예상 요청 수는 **대기 시간이 있을 때만** 어림한다 — 대기가 0이면 초당 요청 수가 응답
   * 시간에 좌우되므로, 우리가 계산한 숫자를 내놓으면 틀린 기대를 심는다.
   */
  const loadSentence = useMemo(() => {
    if (loadMode === 'stages') {
      const rows = stages
        .map((st) => ({ u: Number(st.users) || 0, h: Number(st.holdSec) || 0 }))
        .filter((st) => st.u > 0 && st.h > 0)
      if (!rows.length) return '단계에 사용자 수와 유지 시간을 적어 주세요.'
      const total = rows.reduce((a, st) => a + st.h, 0)
      return (
        `${rows.map((st) => `${st.u}명`).join(' → ')} 으로 올리며 모두 ${Math.round(total / 60)}분 ` +
        `${total % 60 ? `${total % 60}초 ` : ''}돕니다. 어디서 응답이 무너지는지 요약의 그래프로 보세요.`
      )
    }
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
  }, [users, spawnRate, durationMin, waitMin, waitMax, scenarioKind, loadMode, stages])

  /** 시작을 막아야 하는 이유 (없으면 빈 문자열) — 왜 못 누르는지 그 자리에 밝힌다 */
  const blockedReason = (() => {
    if (envChecking) return '환경을 확인하는 중입니다'
    if (!env?.ok) return '환경 확인이 필요합니다'
    if (!targetUrl.trim()) return '대상 주소를 적어 주세요'
    if (targetUrl.trim() && !/^https?:\/\//i.test(targetUrl.trim()))
      return '대상 주소는 http:// 또는 https:// 로 시작해야 합니다'
    if (scenarioKind === 'file' && !scenarioFile.trim()) return 'locustfile 을 고르세요'
    if (scenarioKind === 'form' && !steps.some((st) => st.path.trim())) return '요청할 경로를 한 개 이상 적어 주세요'
    if (loadMode === 'stages' && !stages.some((st) => Number(st.users) > 0 && Number(st.holdSec) > 0))
      return '계단식 단계에 사용자 수와 유지 시간을 적어 주세요'
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
              p50ThresholdMs: selected.meta.config.p50ThresholdMs,
              p95ThresholdMs: selected.meta.config.p95ThresholdMs,
              p99ThresholdMs: selected.meta.config.p99ThresholdMs,
              errorRateThresholdPct: selected.meta.config.errorRateThresholdPct,
              warmupSec: selected.meta.config.warmupSec,
            },
            { canceled: selected.meta.canceled, exitCode: selected.meta.exitCode, history },
          )
        : null,
    [selected, selectedSummary, history],
  )

  useEffect(() => {
    if (!selectedRunId) {
      setHistory([])
      return
    }
    let alive = true
    void window.electronAPI.perfReadHistory(selectedRunId).then((r) => {
      if (!alive) return
      setHistory(r.ok && r.csv ? parseLocustHistory(r.csv) : [])
    })
    void window.electronAPI.perfReadFailureSamples(selectedRunId).then((r) => {
      if (!alive) return
      setSamples(r.samples ?? [])
      setOpenSample(null)
    })
    setLabelEdit(null)

    // 대상 서버의 자원 이력 — 회차가 돌던 시간대만 잘라 온다
    const rec = runs.find((r) => r.meta.id === selectedRunId)
    const host = hostOf(rec?.meta.config.sessionLabel ?? '')
    if (!rec || !host) {
      setServerSeries([])
      setServerNote('')
    } else {
      const from = rec.meta.startedAt
      const to = rec.meta.endedAt ?? Date.now()
      void window.electronAPI.monitorHistory(host, from).then((r) => {
        if (!alive) return
        const inWindow = (r.samples ?? []).filter((sp) => sp.ts * 1000 >= from && sp.ts * 1000 <= to + 5000)
        setServerSeries(
          inWindow.map((sp) => ({
            sec: Math.round((sp.ts * 1000 - from) / 1000),
            cpu: sp.cpu,
            mem: sp.mem?.pct,
          })),
        )
        setServerNote(
          inWindow.length
            ? ''
            : '이 시간대에 수집된 서버 지표가 없습니다 — 대시보드에서 수집을 켜 두면 다음 회차부터 같이 보입니다.',
        )
      })
    }
    return () => {
      alive = false
    }
    // 돌고 있는 회차는 끝난 뒤에 다시 읽어야 이력이 채워진다 — running 이 풀릴 때 다시 돈다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRunId, running, runs])

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
    return { at: prevRec.meta.startedAt, label: prevRec.meta.label, items }
  }, [selected, selectedSummary, runs])

  /**
   * 리포트 맨 앞에 얹을 판정 조각.
   *
   * 리포트를 그대로 제출했을 때 "그래서 통과인가" 가 문서 안에 있어야 한다. 스타일은 인라인
   * 으로만 쓴다 — 남의 문서에 우리 CSS 를 섞으면 리포트 쪽이 깨질 수 있다.
   */
  const brandHtml = (): string => {
    if (!selected || !verdict) return ''
    const esc = (v: string) =>
      String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    const cfg = selected.meta.config
    const color = verdict.tone === 'pass' ? '#137333' : verdict.tone === 'fail' ? '#b3261e' : '#5f6368'
    const bg = verdict.tone === 'pass' ? '#e6f4ea' : verdict.tone === 'fail' ? '#fce8e6' : '#f1f3f4'
    const rows: [string, string][] = [
      ['대상', cfg.targetUrl],
      [
        '부하',
        cfg.stages?.length
          ? `계단식 ${cfg.stages.map((st) => `${st.users}명(${st.holdSec}초)`).join(' → ')}`
          : `사용자 ${cfg.users}명 · ${cfg.spawnRate}명/초 · ${Math.round(cfg.durationSec / 60)}분`,
      ],
      [
        '기준',
        [
          cfg.p50ThresholdMs !== undefined ? `p50 ${cfg.p50ThresholdMs}ms` : '',
          cfg.p95ThresholdMs !== undefined ? `p95 ${cfg.p95ThresholdMs}ms` : '',
          cfg.p99ThresholdMs !== undefined ? `p99 ${cfg.p99ThresholdMs}ms` : '',
          cfg.errorRateThresholdPct !== undefined ? `실패율 ${cfg.errorRateThresholdPct}%` : '',
          cfg.warmupSec ? `워밍업 ${cfg.warmupSec}초 제외` : '',
        ]
          .filter(Boolean)
          .join(' · ') || '없음 (측정값만)',
      ],
      ['실행', new Date(selected.meta.startedAt).toLocaleString('ko-KR', { hour12: false })],
    ]
    return (
      `<div style="font-family:system-ui,'Malgun Gothic',sans-serif;margin:16px;padding:14px 16px;` +
      `border:1px solid #dadce0;border-radius:8px;background:#fff">` +
      `<div style="font-size:13px;color:#5f6368;margin-bottom:6px">Q-Term 성능 검증` +
      (selected.meta.label ? ` — ${esc(selected.meta.label)}` : '') +
      `</div>` +
      `<div style="display:inline-block;padding:4px 10px;border-radius:12px;background:${bg};color:${color};` +
      `font-size:14px;font-weight:600">${esc(verdict.label)}</div>` +
      `<ul style="margin:8px 0 10px;padding-left:18px;font-size:13px;color:#3c4043">` +
      verdict.reasons.map((r) => `<li>${esc(r)}</li>`).join('') +
      `</ul>` +
      (selected.meta.memo ? `<p style="font-size:13px;color:#3c4043;margin:0 0 10px">${esc(selected.meta.memo)}</p>` : '') +
      `<table style="font-size:12.5px;color:#5f6368;border-collapse:collapse">` +
      rows
        .map(
          ([k, v]) =>
            `<tr><td style="padding:2px 12px 2px 0;white-space:nowrap">${esc(k)}</td>` +
            `<td style="padding:2px 0;color:#202124">${esc(v)}</td></tr>`,
        )
        .join('') +
      `</table></div>`
    )
  }

  /** 리포트를 열거나 저장하기 전에 판정 조각을 심어 둔다(여러 번 불러도 쌓이지 않는다) */
  const ensureBranded = async () => {
    if (!selected) return
    const html = brandHtml()
    if (html) await window.electronAPI.perfBrandReport(selected.meta.id, html)
  }

  /**
   * AI 에게 보낼 글.
   *
   * 숫자만 던지면 "느립니다" 같은 답이 온다. **조건·분포·실패 내용·직전 회차 대비**를 같이
   * 줘야 원인 후보가 나온다. 나가는 글에는 마스킹을 건다 — 토큰·비밀번호가 실패 본문에
   * 섞여 있을 수 있고, 이건 외부로 나가는 경로다(AI 패널과 같은 규칙).
   */
  const aiText = (): string => {
    if (!selected) return ''
    const cfg = selected.meta.config
    const n = cfg.scenario.kind === 'form' ? normalizeFormScenario(cfg.scenario) : null
    const lines: string[] = [
      '성능 검증 결과를 해석해 주세요. 원인 후보와 다음에 확인할 것을 알려 주세요.',
      '',
      `대상: ${cfg.targetUrl}`,
      cfg.stages?.length
        ? `부하: 계단식 ${cfg.stages.map((st) => `${st.users}명(${st.holdSec}초)`).join(' → ')}`
        : `부하: 사용자 ${cfg.users}명 · ${cfg.spawnRate}명/초 · ${Math.round(cfg.durationSec / 60)}분`,
      n
        ? `시나리오: ${n.order === 'sequential' ? '순서대로' : '비율대로'} ${n.steps
            .map((st) => `${st.method} ${st.path}(비율 ${st.weight})`)
            .join(', ')}`
        : `시나리오: 파일 ${cfg.scenario.kind === 'file' ? cfg.scenario.path : ''}`,
      `요청 사이 대기: ${n ? `${n.waitMinSec}~${n.waitMaxSec}초` : '알 수 없음'}`,
      '',
    ]
    if (verdict) lines.push(`판정: ${verdict.label}`, ...verdict.reasons.map((r) => `- ${r}`), '')
    if (selectedSummary) {
      lines.push(
        `요청 ${selectedSummary.requests}건 · 실패 ${selectedSummary.failures}건(${selectedSummary.failRatePct.toFixed(
          2,
        )}%) · 초당 ${selectedSummary.rps.toFixed(1)}건`,
        `응답 p50 ${fmtMs(selectedSummary.p50Ms)} · p95 ${fmtMs(selectedSummary.p95Ms)} · p99 ${fmtMs(
          selectedSummary.p99Ms,
        )} · 최대 ${fmtMs(selectedSummary.maxMs)}`,
        '',
        '요청별:',
        ...selectedSummary.perEndpoint.map(
          (e) =>
            `- ${e.name}: ${e.requests}건, 실패 ${e.failures}건, 평균 ${fmtMs(e.avgMs)}, p95 ${fmtMs(e.p95Ms)}`,
        ),
        '',
      )
    }
    if (failures.length) {
      lines.push('실패 내용:', ...failures.slice(0, 5).map((f) => `- ${f.name}: ${f.error} (${f.count}건)`), '')
    }
    if (samples.length) {
      lines.push('실패 응답 본문(앞 2건):')
      for (const sp of samples.slice(0, 2)) {
        lines.push(`- [${sp.code ?? '연결 실패'}] ${sp.name}: ${(sp.body || sp.error).slice(0, 300)}`)
      }
      lines.push('')
    }
    if (compare) {
      lines.push(
        `직전 회차 대비: ${compare.items.map((it) => `${it.label} ${it.before}→${it.after}(${it.delta})`).join(', ')}`,
        '',
      )
    }
    if (history.length > 1) {
      const peak = history.reduce((a, b) => ((b.p95Ms ?? 0) > (a.p95Ms ?? 0) ? b : a))
      lines.push(
        `시간에 따라: p95 최악은 시작 후 ${peak.sec}초 지점 ${fmtMs(peak.p95Ms)} (그때 사용자 ${peak.users}명, 초당 ${peak.rps.toFixed(
          1,
        )}건)`,
      )
    }
    if (serverSeries.length > 1) {
      const cpuMax = Math.max(...serverSeries.map((s) => s.cpu ?? 0))
      const memMax = Math.max(...serverSeries.map((s) => s.mem ?? 0))
      lines.push(`같은 시간대 대상 서버: CPU 최대 ${Math.round(cpuMax)}% · 메모리 최대 ${Math.round(memMax)}%`)
    }
    return maskForAI(lines.join('\n'))
  }

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
                    onClick={() => setConfirmInstall(true)}
                    disabled={installing}
                    className="flex items-center gap-1 rounded border border-blue-500/40 bg-blue-600/20 px-2 py-1 text-[11.5px] text-blue-100 hover:bg-blue-600/30 disabled:opacity-50"
                  >
                    <Download size={11} /> {installing ? '설치 중…' : '자동으로 설치'}
                  </button>
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
            {/* ── 필수 ─────────────────────────────────────────── */}

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
              <p className="mt-1 text-[10px] leading-relaxed text-gray-600">
                세션에서 가져온 주소입니다. 이 PC 에서 안 닿으면 포트 포워딩으로 로컬 포트를 열고 그 주소를 적으세요.
              </p>
            </Card>

            {/* 부하 — 얼마나 세게 */}
            <Card
              icon={<Gauge size={12} />}
              title="부하"
              badge={
                <span className="flex gap-0.5 rounded bg-black/30 p-0.5">
                  {(['flat', 'stages'] as const).map((m) => (
                      <button
                        key={m}
                        onClick={() => setLoadMode(m)}
                        disabled={!!running}
                        title={
                          m === 'flat'
                            ? '정해진 사용자 수로 쭉 유지합니다'
                            : '사용자를 단계적으로 올려 어디서 무너지는지 봅니다'
                        }
                        className={
                          'rounded px-1.5 py-0.5 text-[9.5px] disabled:opacity-50 ' +
                          (loadMode === m ? 'bg-blue-600/70 text-white' : 'text-gray-400 hover:text-gray-200')
                        }
                    >
                      {m === 'flat' ? '평평하게' : '계단식'}
                    </button>
                  ))}
                </span>
              }
            >
              {loadMode === 'flat' ? (
                <>
                  <div className="mb-1.5 flex flex-wrap gap-1">
                    {LOAD_PRESETS.map((pre) => {
                        const on =
                          users === String(pre.users) &&
                          spawnRate === String(pre.rate) &&
                          durationMin === String(pre.min)
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
                  <div className="grid grid-cols-3 gap-1.5">
                    <Field label="사용자" unit="명" value={users} onChange={setUsers} disabled={!!running} />
                    <Field label="증가" unit="명/초" value={spawnRate} onChange={setSpawnRate} disabled={!!running} />
                    <Field label="시간" unit="분" value={durationMin} onChange={setDurationMin} disabled={!!running} />
                  </div>
                </>
              ) : (
                <>
                  {/* 계단식 — 각 줄이 한 단계. 어디서 무너지는지 시계열 그래프와 같이 보면 한계점이 보인다 */}
                  <div className="mb-1 grid grid-cols-[1fr_1fr_1fr_20px] gap-1.5 text-[9.5px] text-gray-500">
                    <span>사용자(명)</span>
                    <span>증가(명/초)</span>
                    <span>유지(초)</span>
                    <span />
                  </div>
                  <div className="space-y-1">
                    {stages.map((st, i) => (
                      <div key={i} className="grid grid-cols-[1fr_1fr_1fr_20px] items-center gap-1.5">
                        {(['users', 'spawnRate', 'holdSec'] as const).map((k) => (
                          <input
                            key={k}
                            value={st[k]}
                            onChange={(e) =>
                              setStages((prev) => prev.map((x, j) => (j === i ? { ...x, [k]: e.target.value } : x)))
                            }
                            disabled={!!running}
                            className={inputCls + ' w-full text-center disabled:opacity-50'}
                          />
                        ))}
                        <button
                          onClick={() => setStages((prev) => (prev.length <= 1 ? prev : prev.filter((_, j) => j !== i)))}
                          disabled={!!running || stages.length <= 1}
                          title="이 단계 삭제"
                          className="rounded p-0.5 text-gray-600 hover:bg-white/10 hover:text-red-300 disabled:opacity-30"
                        >
                          <Trash2 size={11} />
                        </button>
                      </div>
                    ))}
                  </div>
                  <button
                    onClick={() => setStages((prev) => [...prev, { users: '', spawnRate: '10', holdSec: '60' }])}
                    disabled={!!running}
                    className="mt-1.5 w-full rounded border border-dashed border-white/15 py-1 text-[10.5px] text-gray-400 hover:bg-white/5 disabled:opacity-50"
                  >
                    + 단계 추가
                  </button>
                </>
              )}
              {/* 숫자들이 실제로 무슨 뜻인지 한 문장으로 되짚는다 */}
              <p className="mt-1.5 rounded bg-black/20 px-2 py-1 text-[10.5px] leading-relaxed text-gray-400">
                {loadSentence}
              </p>
            </Card>

            {/* 시나리오 — 무엇을 요청할지 */}
            <Card
              icon={<FileCode size={12} />}
              title="시나리오"
              badge={
                scenarioKind === 'form' ? (
                  <span className="flex gap-0.5 rounded bg-black/30 p-0.5">
                    {(['weighted', 'sequential'] as const).map((o) => (
                      <button
                        key={o}
                        onClick={() => setOrder(o)}
                        disabled={!!running}
                        title={
                          o === 'weighted'
                            ? '각 사용자가 비율대로 아무 단계나 고릅니다 (실제 트래픽 흉내)'
                            : '한 사용자가 위에서 아래로 순서대로 돕니다 (로그인 후 조회처럼)'
                        }
                        className={
                          'rounded px-1.5 py-0.5 text-[9.5px] disabled:opacity-50 ' +
                          (order === o ? 'bg-blue-600/70 text-white' : 'text-gray-400 hover:text-gray-200')
                        }
                      >
                        {o === 'weighted' ? '비율대로' : '순서대로'}
                      </button>
                    ))}
                  </span>
                ) : undefined
              }
            >
              <div className="mb-2 flex gap-1 rounded-md bg-black/25 p-0.5">
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
                  <div className="space-y-1">
                    {steps.map((st, i) => (
                      <div key={i} className="rounded border border-white/10 bg-black/15">
                        <div className="flex items-center gap-1 p-1">
                          <select
                            value={st.method}
                            onChange={(e) => updateStep(i, { method: e.target.value as PerfStep['method'] })}
                            disabled={!!running}
                            className={inputCls + ' shrink-0 !px-1 disabled:opacity-50'}
                          >
                            {(['GET', 'POST', 'PUT', 'DELETE'] as const).map((m) => (
                              <option key={m} value={m}>
                                {m}
                              </option>
                            ))}
                          </select>
                          <input
                            value={st.path}
                            onChange={(e) => updateStep(i, { path: e.target.value })}
                            disabled={!!running}
                            placeholder="/v3/servers"
                            className={inputCls + ' min-w-0 flex-1 font-mono disabled:opacity-50'}
                          />
                          {order === 'weighted' ? (
                            <input
                              value={String(st.weight)}
                              onChange={(e) => updateStep(i, { weight: Number(e.target.value) || 1 })}
                              disabled={!!running}
                              title="상대 비율 — 10 이면 비율 1 인 단계보다 10배 자주 실행됩니다"
                              className={inputCls + ' w-9 shrink-0 text-center disabled:opacity-50'}
                            />
                          ) : (
                            <span className="w-9 shrink-0 text-center text-[10px] text-gray-600">{i + 1}번</span>
                          )}
                          <button
                            onClick={() => setOpenStep(openStep === i ? null : i)}
                            title="이름·본문·헤더"
                            className="shrink-0 rounded p-0.5 text-gray-500 hover:bg-white/10 hover:text-gray-200"
                          >
                            {openStep === i ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                          </button>
                          {order === 'sequential' && (
                            <span className="flex shrink-0 flex-col">
                              <button
                                onClick={() => moveStep(i, -1)}
                                disabled={!!running || i === 0}
                                className="text-gray-600 hover:text-gray-300 disabled:opacity-30"
                                title="위로"
                              >
                                <ChevronUp size={10} />
                              </button>
                              <button
                                onClick={() => moveStep(i, 1)}
                                disabled={!!running || i === steps.length - 1}
                                className="text-gray-600 hover:text-gray-300 disabled:opacity-30"
                                title="아래로"
                              >
                                <ChevronDown size={10} />
                              </button>
                            </span>
                          )}
                          <button
                            onClick={() => removeStep(i)}
                            disabled={!!running || steps.length <= 1}
                            title="이 단계 삭제"
                            className="shrink-0 rounded p-0.5 text-gray-600 hover:bg-white/10 hover:text-red-300 disabled:opacity-30"
                          >
                            <Trash2 size={11} />
                          </button>
                        </div>
                        {openStep === i && (
                          <div className="space-y-1 border-t border-white/10 p-1.5">
                            <input
                              value={st.name ?? ''}
                              onChange={(e) => updateStep(i, { name: e.target.value })}
                              disabled={!!running}
                              placeholder="통계에 찍힐 이름 (비우면 경로)"
                              className={inputCls + ' w-full disabled:opacity-50'}
                            />
                            {(st.method === 'POST' || st.method === 'PUT') && (
                              <textarea
                                value={st.body ?? ''}
                                onChange={(e) => updateStep(i, { body: e.target.value })}
                                disabled={!!running}
                                rows={2}
                                placeholder={'본문 (JSON)'}
                                className={inputCls + ' w-full resize-y font-mono disabled:opacity-50'}
                              />
                            )}
                            <textarea
                              value={Object.entries(st.headers ?? {})
                                .map(([k, v]) => `${k}: ${v}`)
                                .join('\n')}
                              onChange={(e) => updateStep(i, { headers: parseHeaders(e.target.value) })}
                              disabled={!!running}
                              rows={2}
                              placeholder={'이 단계만의 헤더 (공통 헤더에 덮어씀)'}
                              className={inputCls + ' w-full resize-y font-mono disabled:opacity-50'}
                            />
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                  <div className="mt-1.5 flex gap-1">
                    <button
                      onClick={addStep}
                      disabled={!!running}
                      className="flex-1 rounded border border-dashed border-white/15 py-1 text-[10.5px] text-gray-400 hover:bg-white/5 disabled:opacity-50"
                    >
                      + 단계 추가
                    </button>
                    <button
                      onClick={() => {
                        setCurlText('')
                        setCurlMsg('')
                      }}
                      disabled={!!running}
                      title="개발자도구에서 Copy as cURL 한 요청을 그대로 단계로 만듭니다"
                      className="flex items-center gap-1 rounded border border-white/15 bg-panel-light px-2 py-1 text-[10.5px] text-gray-300 hover:bg-white/10 disabled:opacity-50"
                    >
                      <ClipboardPaste size={11} /> cURL 로 추가
                    </button>
                    <button
                      onClick={async () => {
                        const r = await window.electronAPI.perfPreviewScenario(buildConfig())
                        setPreview(r.text)
                      }}
                      className="shrink-0 rounded border border-white/15 bg-panel-light px-2 py-1 text-[10.5px] text-gray-300 hover:bg-white/10"
                    >
                      미리보기
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div className="flex items-center gap-1.5">
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
                </>
              )}
            </Card>

            {/* 판정 기준 — 없으면 초록을 띄우지 않는다 (이 앱의 핵심이라 접지 않는다) */}
            <Card
              icon={<CircleCheck size={12} />}
              title="판정 기준"
              badge={
                p50Th.trim() || p95Th.trim() || p99Th.trim() || errTh.trim() ? undefined : (
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

            {/* ── 고급 설정 ─────────────────────────────────────
                안 건드려도 돌아가는 것들만 여기 넣는다. 처음 여는 사람에게 스무 칸을 한꺼번에
                보여주면 무엇이 필수인지 알 수 없다. 기본은 접고, 편 상태는 기억한다. */}
            <button
              onClick={() => {
                const next = !advOpen
                setAdvOpen(next)
                localStorage.setItem('perf_adv_open', next ? '1' : '0')
              }}
              className="mb-2 flex w-full items-center gap-1.5 rounded-md border border-white/10 bg-panel-light/25 px-2.5 py-1.5 text-[11px] text-gray-400 hover:bg-white/5"
            >
              {advOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              고급 설정
              <span className="ml-auto text-[10px] text-gray-600">
                {advOpen ? '접기' : '인증서 · 백분위 · 워밍업 · 대기 · 헤더 · 프로세스'}
              </span>
            </button>

            {advOpen && (
              <>
                <Card icon={<Target size={12} />} title="연결">
                  <label className="flex items-start gap-2 text-[11px] text-gray-300">
                    <input
                      type="checkbox"
                      checked={insecure}
                      disabled={!!running || scenarioKind === 'file'}
                      onChange={(e) => setInsecure(e.target.checked)}
                      className="mt-0.5"
                    />
                    <span>
                      자체 서명 인증서 무시
                      <span className="block text-[10px] text-gray-600">
                        {scenarioKind === 'file'
                          ? '고른 파일이 정합니다 (앱이 만든 시나리오에만 넣을 수 있습니다)'
                          : '사내 인프라는 대개 필요합니다'}
                      </span>
                    </span>
                  </label>
                </Card>

                <Card icon={<CircleCheck size={12} />} title="판정 기준 — 더">
                  <div className="grid grid-cols-2 gap-1.5">
                    <Field label="p50 이하" unit="ms" value={p50Th} onChange={setP50Th} disabled={!!running} placeholder="—" />
                    <Field label="p99 이하" unit="ms" value={p99Th} onChange={setP99Th} disabled={!!running} placeholder="—" />
                  </div>
                  <div className="mt-1.5 flex items-end gap-2">
                    <div className="w-24">
                      <Field
                        label="워밍업 제외"
                        unit="초"
                        value={warmupSec}
                        onChange={setWarmupSec}
                        disabled={!!running}
                        placeholder="0"
                      />
                    </div>
                    <p className="min-w-0 flex-1 pb-1 text-[10px] leading-relaxed text-gray-600">
                      사용자가 붙는 동안은 응답이 느려 전체 p95 를 끌어올립니다. 이 시간을 빼면 남은 구간의 p95
                      최댓값으로 판정합니다.
                    </p>
                  </div>
                </Card>

                {scenarioKind === 'form' && (
                  <Card icon={<FileCode size={12} />} title="요청 방식">
                    <div className="flex items-center gap-1.5">
                      <span className="shrink-0 text-[10.5px] text-gray-500">요청 사이 대기</span>
                      <input
                        value={waitMin}
                        onChange={(e) => setWaitMin(e.target.value)}
                        disabled={!!running}
                        className={inputCls + ' w-11 shrink-0 text-center disabled:opacity-50'}
                      />
                      <span className="shrink-0 text-gray-600">~</span>
                      <input
                        value={waitMax}
                        onChange={(e) => setWaitMax(e.target.value)}
                        disabled={!!running}
                        className={inputCls + ' w-11 shrink-0 text-center disabled:opacity-50'}
                      />
                      <span className="shrink-0 text-[10.5px] text-gray-500">초</span>
                    </div>
                    <textarea
                      value={commonHeaderText}
                      onChange={(e) => setCommonHeaderText(e.target.value)}
                      disabled={!!running}
                      rows={2}
                      placeholder={'공통 헤더 — 한 줄에 하나\nX-Auth-Token: ...'}
                      className={inputCls + ' mt-1.5 w-full resize-y font-mono disabled:opacity-50'}
                    />
                    <label className="mt-1.5 flex items-start gap-2 text-[11px] text-gray-300">
                      <input
                        type="checkbox"
                        checked={captureFailures}
                        disabled={!!running}
                        onChange={(e) => setCaptureFailures(e.target.checked)}
                        className="mt-0.5"
                      />
                      <span>
                        실패 응답 본문 남기기
                        <span className="block text-[10px] text-gray-600">
                          Locust 는 한 줄 문구만 남깁니다. 본문이 있어야 게이트웨이 오류인지 앱 오류인지 갈립니다 (앞 50건)
                        </span>
                      </span>
                    </label>
                  </Card>
                )}

                <Card icon={<Gauge size={12} />} title="부하 발생기">
                    <div className="grid grid-cols-2 gap-1.5">
                      <Field
                        label="이 PC 프로세스"
                        unit="개"
                        value={processes}
                        onChange={setProcesses}
                        disabled={!!running}
                      />
                      <Field
                        label="다른 PC 워커"
                        unit="대"
                        value={expectWorkers}
                        onChange={setExpectWorkers}
                        disabled={!!running}
                      />
                    </div>
                    <p className="mt-1 text-[10px] leading-relaxed text-gray-600">
                      파이썬 한 프로세스는 코어 하나만 씁니다. 부하가 크면 프로세스를 늘리세요 — 대상이 아니라 내 PC 가
                      먼저 막히면 그 응답 시간은 서버 성능이 아닙니다.
                      {Number(expectWorkers) > 0 && (
                        <>
                          <br />
                          워커 {Number(expectWorkers)}대가 붙을 때까지 시작을 기다립니다. 다른 PC 에서:
                          <span className="mt-0.5 block break-all rounded bg-black/40 px-1.5 py-1 font-mono text-[10px] text-gray-400">
                            locust -f locustfile.py --worker --master-host &lt;이 PC 의 IP&gt;
                          </span>
                        </>
                      )}
                  </p>
                </Card>
              </>
            )}


            {/* 저장해 둔 설정 — 같은 검증을 다음에 또 돌리고, 팀에 넘기기도 한다 */}
            <div className="mb-2 rounded-md border border-white/10 bg-panel-light/25 p-2">
              <div className="flex items-center gap-1.5">
                <Save size={12} className="shrink-0 text-gray-500" />
                <span className="text-[11px] font-medium text-gray-300">저장한 설정</span>
                <button
                  onClick={async () => {
                    const r = await window.electronAPI.perfPresetsExport()
                    setNote(r.saved ? `${r.count}개를 내보냈습니다 — ${r.path}` : (r.error ?? '내보내지 않았습니다.'))
                  }}
                  title="파일로 내보내기"
                  className="ml-auto rounded p-0.5 text-gray-600 hover:bg-white/10 hover:text-gray-300"
                >
                  <Download size={11} />
                </button>
                <button
                  onClick={async () => {
                    const r = await window.electronAPI.perfPresetsImport()
                    if (r.ok && r.list) {
                      setPresets(r.list)
                      setNote(`${r.count}개를 가져왔습니다.`)
                    } else if (r.error) setNote(r.error)
                  }}
                  title="파일에서 가져오기"
                  className="rounded p-0.5 text-gray-600 hover:bg-white/10 hover:text-gray-300"
                >
                  <Upload size={11} />
                </button>
              </div>
              {presets.length > 0 && (
                <div className="mt-1.5 space-y-0.5">
                  {presets.map((pre) => (
                    <div key={pre.id} className="flex items-center gap-1">
                      <button
                        onClick={() => applyPreset(pre)}
                        disabled={!!running}
                        className="min-w-0 flex-1 truncate rounded px-1.5 py-0.5 text-left text-[11px] text-gray-300 hover:bg-white/10 disabled:opacity-50"
                        title="이 설정을 화면에 불러옵니다 (대상 주소는 그대로)"
                      >
                        {pre.name}
                      </button>
                      <button
                        onClick={async () => setPresets(await window.electronAPI.perfPresetsDelete(pre.id))}
                        disabled={!!running}
                        title="삭제"
                        className="shrink-0 rounded p-0.5 text-gray-600 hover:bg-white/10 hover:text-red-300 disabled:opacity-30"
                      >
                        <Trash2 size={10} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <div className="mt-1.5 flex items-center gap-1.5">
                <input
                  value={presetName ?? ''}
                  onChange={(e) => setPresetName(e.target.value)}
                  disabled={!!running}
                  placeholder="이름을 적어 지금 설정을 저장"
                  className={inputCls + ' min-w-0 flex-1 disabled:opacity-50'}
                />
                <button
                  onClick={() => void savePreset()}
                  disabled={!!running || !(presetName ?? '').trim()}
                  className="shrink-0 rounded border border-white/15 bg-panel-light px-2 py-1 text-[11px] text-gray-200 hover:bg-white/10 disabled:opacity-40"
                >
                  저장
                </button>
              </div>
            </div>

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
                              {r.meta.label || new Date(r.meta.startedAt).toLocaleString('ko-KR', { hour12: false }).slice(5, 16)}
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
                        <button
                          onClick={async () => {
                            const r = await window.electronAPI.perfOpenDashboard(running.webUrl!)
                            if (!r.ok) setNote(r.error ?? '창을 열 수 없습니다.')
                          }}
                          title="화면이 두 개면 대시보드를 옆으로 빼 두세요"
                          className="flex shrink-0 items-center gap-1 rounded border border-white/10 px-1.5 py-0.5 text-gray-400 hover:bg-white/10 hover:text-gray-200"
                        >
                          <PanelRightOpen size={11} /> 별도 창
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
                      {/* 회차 이름·메모 — 시각만으로는 나중에 못 찾는다 */}
                      <div className="mb-2 flex items-start gap-2">
                        {labelEdit ? (
                          <>
                            <div className="min-w-0 flex-1 space-y-1">
                              <input
                                autoFocus
                                value={labelEdit.label}
                                onChange={(e) => setLabelEdit({ ...labelEdit, label: e.target.value })}
                                placeholder="회차 이름 — 예: 게이트웨이 튜닝 후"
                                className={inputCls + ' w-full'}
                              />
                              <textarea
                                value={labelEdit.memo}
                                onChange={(e) => setLabelEdit({ ...labelEdit, memo: e.target.value })}
                                rows={2}
                                placeholder="메모 — 무엇을 바꾸고 돌렸는지"
                                className={inputCls + ' w-full resize-y'}
                              />
                            </div>
                            <button
                              onClick={async () => {
                                await window.electronAPI.perfSetLabel(
                                  selected.meta.id,
                                  labelEdit.label,
                                  labelEdit.memo,
                                )
                                setLabelEdit(null)
                                await refreshRuns()
                              }}
                              className="shrink-0 rounded-md bg-blue-600 px-2.5 py-1 text-[11px] text-white hover:bg-blue-500"
                            >
                              저장
                            </button>
                            <button
                              onClick={() => setLabelEdit(null)}
                              className="shrink-0 rounded-md border border-white/10 bg-panel-light px-2.5 py-1 text-[11px] text-gray-300 hover:bg-white/10"
                            >
                              취소
                            </button>
                          </>
                        ) : (
                          <>
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-[13px] text-gray-100">
                                {selected.meta.label || '이름 없는 회차'}
                              </div>
                              {selected.meta.memo && (
                                <p className="mt-0.5 whitespace-pre-wrap text-[11px] leading-relaxed text-gray-500">
                                  {selected.meta.memo}
                                </p>
                              )}
                            </div>
                            <button
                              onClick={() =>
                                setLabelEdit({ label: selected.meta.label ?? '', memo: selected.meta.memo ?? '' })
                              }
                              className="shrink-0 rounded border border-white/15 bg-panel-light px-2 py-0.5 text-[10.5px] text-gray-300 hover:bg-white/10"
                            >
                              이름·메모
                            </button>
                          </>
                        )}
                      </div>

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

                      {/* 시계열 — 평균 한 줄로는 '언제 무너졌나' 를 알 수 없다.
                          Locust 웹 UI 는 돌고 있는 동안만 보여주므로 끝난 회차는 여기서 본다. */}
                      {history.length > 1 && (
                        <div className="mt-3">
                          <div className="mb-1 flex items-center gap-2">
                            <span className="text-[11px] font-medium text-gray-300">시간에 따라</span>
                            <span className="text-[10px] text-gray-600">가로축 = 시작 후 초</span>
                            {selected.meta.config.warmupSec ? (
                              <span className="text-[10px] text-amber-300/70">
                                앞 {selected.meta.config.warmupSec}초는 판정에서 제외
                              </span>
                            ) : null}
                          </div>
                          <div className="rounded-md border border-white/10 bg-black/20 p-1.5">
                            <ResponsiveContainer width="100%" height={132}>
                              <LineChart data={history} margin={{ top: 4, right: 8, bottom: 0, left: -18 }}>
                                <CartesianGrid strokeDasharray="3 3" stroke="#ffffff14" />
                                <XAxis
                                  dataKey="sec"
                                  tick={{ fontSize: 10, fill: '#9ca3af' }}
                                  tickFormatter={(v: number) => `${v}s`}
                                />
                                <YAxis
                                  yAxisId="ms"
                                  tick={{ fontSize: 10, fill: '#9ca3af' }}
                                  tickFormatter={(v: number) => String(Math.round(v))}
                                />
                                <YAxis
                                  yAxisId="rps"
                                  orientation="right"
                                  tick={{ fontSize: 10, fill: '#6b7280' }}
                                  tickFormatter={(v: number) => String(Math.round(v))}
                                />
                                <Tooltip
                                  contentStyle={{ background: '#1e1e2e', border: '1px solid #ffffff22', fontSize: 12 }}
                                  labelStyle={{ color: '#9ca3af' }}
                                  labelFormatter={(v) => `시작 후 ${v}초`}
                                  formatter={(value, name) => {
                                    const n = Number(value)
                                    const isCount = name === '초당 요청' || name === '초당 실패'
                                    return [
                                      Number.isFinite(n) ? (isCount ? n.toFixed(1) : `${Math.round(n)}ms`) : '–',
                                      String(name),
                                    ]
                                  }}
                                />
                                <Line
                                  yAxisId="ms"
                                  type="monotone"
                                  dataKey="p95Ms"
                                  name="p95"
                                  stroke="#60a5fa"
                                  strokeWidth={1.6}
                                  dot={false}
                                  connectNulls={false}
                                />
                                <Line
                                  yAxisId="ms"
                                  type="monotone"
                                  dataKey="p50Ms"
                                  name="p50"
                                  stroke="#93c5fd"
                                  strokeWidth={1}
                                  strokeDasharray="3 3"
                                  dot={false}
                                  connectNulls={false}
                                />
                                <Line
                                  yAxisId="rps"
                                  type="monotone"
                                  dataKey="rps"
                                  name="초당 요청"
                                  stroke="#34d399"
                                  strokeWidth={1.2}
                                  dot={false}
                                />
                                <Line
                                  yAxisId="rps"
                                  type="monotone"
                                  dataKey="failsPerSec"
                                  name="초당 실패"
                                  stroke="#f87171"
                                  strokeWidth={1.2}
                                  dot={false}
                                />
                              </LineChart>
                            </ResponsiveContainer>
                          </div>
                          <div className="mt-1 flex flex-wrap items-center gap-3 text-[10px] text-gray-500">
                            <Legend color="#60a5fa" label="p95 (왼쪽, ms)" />
                            <Legend color="#93c5fd" label="p50" dashed />
                            <Legend color="#34d399" label="초당 요청 (오른쪽)" />
                            <Legend color="#f87171" label="초당 실패" />
                          </div>

                          {/* 같은 시간축의 대상 서버 자원 — 성능 도구만으로는 볼 수 없는 부분 */}
                          {serverSeries.length > 1 ? (
                            <div className="mt-2">
                              <div className="mb-1 flex items-center gap-2">
                                <span className="text-[10.5px] text-gray-500">
                                  같은 시간대 대상 서버 ({hostOf(selected.meta.config.sessionLabel ?? '')})
                                </span>
                                <Legend color="#fbbf24" label="CPU %" />
                                <Legend color="#a78bfa" label="메모리 %" />
                              </div>
                              <div className="rounded-md border border-white/10 bg-black/20 p-1.5">
                                <ResponsiveContainer width="100%" height={96}>
                                  <LineChart data={serverSeries} margin={{ top: 4, right: 8, bottom: 0, left: -18 }}>
                                    <CartesianGrid strokeDasharray="3 3" stroke="#ffffff14" />
                                    <XAxis
                                      dataKey="sec"
                                      tick={{ fontSize: 10, fill: '#9ca3af' }}
                                      tickFormatter={(v: number) => `${v}s`}
                                    />
                                    <YAxis
                                      domain={[0, 100]}
                                      tick={{ fontSize: 10, fill: '#9ca3af' }}
                                      unit="%"
                                    />
                                    <Tooltip
                                      contentStyle={{
                                        background: '#1e1e2e',
                                        border: '1px solid #ffffff22',
                                        fontSize: 12,
                                      }}
                                      labelStyle={{ color: '#9ca3af' }}
                                      labelFormatter={(v) => `시작 후 ${v}초`}
                                    />
                                    <Line
                                      type="monotone"
                                      dataKey="cpu"
                                      name="CPU"
                                      stroke="#fbbf24"
                                      strokeWidth={1.3}
                                      dot={false}
                                      connectNulls
                                    />
                                    <Line
                                      type="monotone"
                                      dataKey="mem"
                                      name="메모리"
                                      stroke="#a78bfa"
                                      strokeWidth={1.3}
                                      dot={false}
                                      connectNulls
                                    />
                                  </LineChart>
                                </ResponsiveContainer>
                              </div>
                              <p className="mt-1 text-[10px] leading-relaxed text-gray-600">
                                응답이 느린데 서버가 한가하면 병목은 서버 밖(네트워크·프록시·내 PC)입니다.
                              </p>
                            </div>
                          ) : (
                            serverNote && <p className="mt-2 text-[10px] text-gray-600">{serverNote}</p>
                          )}
                        </div>
                      )}

                      {/* 얼마나 주고받았나 — 대역폭이 병목이면 서버 탓이 아니다 */}
                      {selectedSummary?.avgContentBytes !== undefined && selectedSummary.avgContentBytes > 0 && (
                        <p className="mt-2 text-[10.5px] text-gray-500">
                          응답 평균 {fmtBytes(selectedSummary.avgContentBytes)} · 대략{' '}
                          {fmtRate(selectedSummary.avgContentBytes * selectedSummary.rps)} 주고받았습니다 (본문만,
                          헤더 제외)
                        </p>
                      )}

                      {/* 직전 회차와 비교 — 성능은 절대값보다 '지난번보다 나빠졌나' 로 읽는다 */}
                      {compare && (
                        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-white/10 bg-panel-light/25 px-2.5 py-2 text-[11px]">
                          <span className="shrink-0 text-gray-500">
                            직전 회차(
                            {compare.label ||
                              new Date(compare.at).toLocaleString('ko-KR', { hour12: false }).slice(5, 16)}
                            ) 대비
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

                          {/* 응답 본문 표본 — 같은 503 이라도 게이트웨이가 낸 것과 앱이 낸 것이 다르다 */}
                          {samples.length > 0 && (
                            <div className="mt-2 rounded-md border border-white/10 bg-black/20 p-2">
                              <div className="mb-1 text-[10.5px] text-gray-500">
                                실패 응답 본문 {samples.length}건 — 눌러서 펼치기
                              </div>
                              <div className="space-y-0.5">
                                {samples.slice(0, 8).map((sp, i) => (
                                  <div key={i}>
                                    <button
                                      onClick={() => setOpenSample(openSample === i ? null : i)}
                                      className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-white/5"
                                    >
                                      {openSample === i ? (
                                        <ChevronDown size={11} className="shrink-0 text-gray-500" />
                                      ) : (
                                        <ChevronRight size={11} className="shrink-0 text-gray-500" />
                                      )}
                                      <span className="shrink-0 rounded bg-red-500/15 px-1 text-[10px] text-red-300">
                                        {sp.code ?? '연결 실패'}
                                      </span>
                                      <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-gray-400">
                                        {sp.name}
                                      </span>
                                      <span className="shrink-0 text-[10px] text-gray-600">
                                        {new Date(sp.t).toLocaleTimeString('ko-KR', { hour12: false })}
                                      </span>
                                    </button>
                                    {openSample === i && (
                                      <pre className="mt-0.5 max-h-40 overflow-auto rounded bg-black/40 p-2 font-mono text-[10.5px] leading-relaxed text-gray-400">
                                        {maskForDisplay(sp.error ? sp.error + '\n\n' : '')}
                                        {maskForDisplay(sp.body || '(본문 없음)')}
                                      </pre>
                                    )}
                                  </div>
                                ))}
                              </div>
                            </div>
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
                                selected.meta.config.stages?.length
                                  ? `계단식 · ${selected.meta.config.stages
                                      .map((st) => `${st.users}명(${st.holdSec}초)`)
                                      .join(' → ')}`
                                  : `사용자 ${selected.meta.config.users}명 · ${selected.meta.config.spawnRate}명/초 · ${Math.round(
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
                                  ? (() => {
                                      // 옛 회차(경로 목록만 있던 형식)도 같은 규칙으로 읽는다
                                      const n = normalizeFormScenario(selected.meta.config.scenario)
                                      return `${n.order === 'sequential' ? '순서대로' : '비율대로'} ${
                                        n.steps.length
                                      }단계 · ${n.steps.map((st) => `${st.method} ${st.path}`).join(', ')}`
                                    })()
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
                            await ensureBranded()
                            const r = await window.electronAPI.perfOpenReport(selected.meta.id)
                            if (!r.ok) setNote(r.error ?? '리포트를 열 수 없습니다.')
                          }}
                          title="맨 앞에 우리 판정이 얹힌 리포트가 열립니다"
                          className="flex items-center gap-1 rounded border border-white/15 bg-panel-light px-2 py-1 text-[11px] text-gray-200 hover:bg-white/10"
                        >
                          <ExternalLink size={11} /> 리포트 열기
                        </button>
                        <button
                          onClick={async () => {
                            await ensureBranded()
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
                        <button
                          onClick={() => {
                            const ok = onAnalyze(aiText())
                            setNote(ok ? 'AI 패널로 보냈습니다.' : 'AI 가 이미 답하는 중입니다 — 잠시 뒤에 다시.')
                          }}
                          title="조건·결과·실패 내용을 AI 패널로 보내 해석을 맡깁니다"
                          className="flex items-center gap-1 rounded border border-white/15 bg-panel-light px-2 py-1 text-[11px] text-gray-200 hover:bg-white/10"
                        >
                          <Sparkles size={11} className="text-blue-300" /> AI 해석
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

      {/* 설치는 반드시 묻고 나서 — 무엇을 어떤 명령으로 설치하는지 그대로 보여준다 */}
      {confirmInstall && (
        <ConfirmDialog
          title="Locust 를 설치할까요?"
          confirmLabel="설치"
          message={
            '이 PC 에 파이썬 패키지를 설치합니다. 아래 명령을 그대로 실행합니다.\n\n' +
            'python -m pip install locust\n\n' +
            '설치되는 곳 — 지금 PATH 에 있는 파이썬의 site-packages\n' +
            '가상환경을 쓰신다면 이 버튼 대신 그 환경에서 직접 설치하고, ' +
            '위의 "직접 지정" 에 경로를 적어 주세요.'
          }
          onCancel={() => setConfirmInstall(false)}
          onConfirm={async () => {
            setConfirmInstall(false)
            setInstalling(true)
            setNote('설치를 시작했습니다 — 진행 상황은 실시간 로그 탭에 나옵니다.')
            setTab('log')
            try {
              const r = await window.electronAPI.perfInstallLocust()
              setNote(r.ok ? '설치했습니다. 환경을 다시 확인합니다.' : (r.error ?? '설치하지 못했습니다.'))
              await checkEnv()
            } finally {
              setInstalling(false)
            }
          }}
        />
      )}

      {/* cURL 붙여넣기 — 브라우저가 실제로 보낸 요청을 그대로 단계로 (포털 감시와 같은 파서) */}
      {curlText !== null && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-6">
          <div className="w-[680px] max-w-[92vw] rounded-lg border border-white/10 bg-panel p-4 shadow-2xl">
            <div className="mb-1 flex items-center gap-2">
              <ClipboardPaste size={13} className="text-blue-300" />
              <span className="text-[12.5px] font-medium text-gray-100">cURL 로 단계 추가</span>
              <button
                onClick={() => setCurlText(null)}
                className="ml-auto rounded p-1 text-gray-500 hover:bg-white/10 hover:text-gray-200"
              >
                <X size={14} />
              </button>
            </div>
            <p className="mb-2 text-[11px] leading-relaxed text-gray-500">
              개발자도구 <span className="text-gray-300">Network</span> 에서 그 요청을{' '}
              <span className="text-gray-300">우클릭 → Copy → Copy as cURL</span> 한 뒤 붙여넣으세요. 인증·컨텐츠
              헤더만 남기고 나머지는 뺍니다 — 브라우저가 붙이는 헤더를 다 넘기면 요청이 오히려 깨집니다.
            </p>
            <textarea
              autoFocus
              value={curlText}
              onChange={(e) => setCurlText(e.target.value)}
              rows={6}
              placeholder="curl 'https://10.255.233.21:5000/v3/servers' -H 'X-Auth-Token: ...'"
              className={inputCls + ' w-full resize-y font-mono'}
            />
            {curlMsg && <p className="mt-1 text-[11px] text-amber-300/80">{curlMsg}</p>}
            <div className="mt-2 flex justify-end gap-2">
              <button
                onClick={() => setCurlText(null)}
                className="rounded-md border border-white/10 bg-panel-light px-3 py-1 text-[11.5px] text-gray-200 hover:bg-white/10"
              >
                취소
              </button>
              <button
                onClick={() => addFromCurl(curlText)}
                disabled={!curlText.trim()}
                className="rounded-md bg-blue-600 px-3 py-1 text-[11.5px] text-white hover:bg-blue-500 disabled:opacity-40"
              >
                단계로 추가
              </button>
            </div>
          </div>
        </div>
      )}

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
