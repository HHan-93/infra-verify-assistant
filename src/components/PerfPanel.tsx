import { useEffect, useMemo, useRef, useState } from 'react'
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
} from 'lucide-react'
import type { PerfEnvStatus, PerfRunConfig, PerfRunMeta, PerfRunRecord } from '../../electron/shared-types'
import { parseLocustConsole, parseLocustStats, type PerfLive, type PerfSummary } from '../lib/perfParse'
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
  const [startError, setStartError] = useState('')
  const [runs, setRuns] = useState<PerfRunRecord[]>([])
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<PerfRunRecord | null>(null)
  const [note, setNote] = useState('')
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
        className="flex h-full max-h-[920px] w-[1500px] max-w-[97vw] flex-col overflow-hidden rounded-lg border border-white/10 bg-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 머리 */}
        <div className="flex items-center gap-2 border-b border-white/10 px-4 py-2">
          <Gauge size={15} className="text-blue-300" />
          <span className="text-sm font-semibold text-gray-100">성능 테스트</span>
          {running ? (
            <span className="rounded-full bg-blue-600/25 px-2 py-0.5 text-[11px] text-blue-200">
              돌고 있음 · {Math.floor(elapsed / 60000)}:{String(Math.floor((elapsed % 60000) / 1000)).padStart(2, '0')} /{' '}
              {durationMin}:00
            </span>
          ) : (
            note && <span className="text-[11px] text-gray-400">{note}</span>
          )}
          <span className="ml-auto text-[10.5px] text-gray-500">부하는 이 PC 에서 나갑니다</span>
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
          <div className="flex w-[268px] shrink-0 flex-col overflow-y-auto border-r border-white/10 p-3">
            <div className="text-[10.5px] font-medium uppercase tracking-wide text-gray-500">대상</div>
            <select
              value={sessionId}
              onChange={(e) => setSessionId(e.target.value)}
              disabled={!!running}
              className={inputCls + ' mt-1 w-full disabled:opacity-50'}
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

            <div className="mt-3 text-[10.5px] font-medium uppercase tracking-wide text-gray-500">부하</div>
            <div className="mt-1 grid grid-cols-2 gap-1.5">
              <label className="text-[10.5px] text-gray-500">
                사용자
                <input
                  value={users}
                  onChange={(e) => setUsers(e.target.value)}
                  disabled={!!running}
                  className={inputCls + ' mt-0.5 w-full disabled:opacity-50'}
                />
              </label>
              <label className="text-[10.5px] text-gray-500">
                초당 증가
                <input
                  value={spawnRate}
                  onChange={(e) => setSpawnRate(e.target.value)}
                  disabled={!!running}
                  className={inputCls + ' mt-0.5 w-full disabled:opacity-50'}
                />
              </label>
              <label className="text-[10.5px] text-gray-500">
                시간(분)
                <input
                  value={durationMin}
                  onChange={(e) => setDurationMin(e.target.value)}
                  disabled={!!running}
                  className={inputCls + ' mt-0.5 w-full disabled:opacity-50'}
                />
              </label>
              <label className="text-[10.5px] text-gray-500">
                대기(초)
                <div className="mt-0.5 flex items-center gap-1">
                  <input
                    value={waitMin}
                    onChange={(e) => setWaitMin(e.target.value)}
                    disabled={!!running || scenarioKind === 'file'}
                    className={inputCls + ' w-full disabled:opacity-50'}
                  />
                  <span className="text-gray-600">~</span>
                  <input
                    value={waitMax}
                    onChange={(e) => setWaitMax(e.target.value)}
                    disabled={!!running || scenarioKind === 'file'}
                    className={inputCls + ' w-full disabled:opacity-50'}
                  />
                </div>
              </label>
            </div>

            <div className="mt-3 flex items-center gap-1.5 text-[10.5px] font-medium uppercase tracking-wide text-gray-500">
              판정 기준
              <span className="font-normal normal-case tracking-normal text-gray-600">비워 두면 측정값만</span>
            </div>
            <div className="mt-1 grid grid-cols-2 gap-1.5">
              <label className="text-[10.5px] text-gray-500">
                p95 (ms)
                <input
                  value={p95Th}
                  onChange={(e) => setP95Th(e.target.value)}
                  disabled={!!running}
                  placeholder="500"
                  className={inputCls + ' mt-0.5 w-full disabled:opacity-50'}
                />
              </label>
              <label className="text-[10.5px] text-gray-500">
                실패율 (%)
                <input
                  value={errTh}
                  onChange={(e) => setErrTh(e.target.value)}
                  disabled={!!running}
                  placeholder="1"
                  className={inputCls + ' mt-0.5 w-full disabled:opacity-50'}
                />
              </label>
            </div>

            <div className="mt-3 text-[10.5px] font-medium uppercase tracking-wide text-gray-500">시나리오</div>
            <div className="mt-1 flex gap-1 rounded-md bg-black/25 p-0.5">
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
                <div className="mt-1.5 flex items-center gap-1.5">
                  <select
                    value={method}
                    onChange={(e) => setMethod(e.target.value as 'GET' | 'POST')}
                    disabled={!!running}
                    className={inputCls + ' disabled:opacity-50'}
                  >
                    <option value="GET">GET</option>
                    <option value="POST">POST</option>
                  </select>
                  <span className="text-[10px] text-gray-600">경로 (한 줄에 하나)</span>
                </div>
                <textarea
                  value={paths}
                  onChange={(e) => setPaths(e.target.value)}
                  disabled={!!running}
                  rows={3}
                  className={inputCls + ' mt-1 w-full resize-y font-mono disabled:opacity-50'}
                />
                {method === 'POST' && (
                  <textarea
                    value={body}
                    onChange={(e) => setBody(e.target.value)}
                    disabled={!!running}
                    rows={3}
                    placeholder='{"key": "value"}'
                    className={inputCls + ' mt-1.5 w-full resize-y font-mono disabled:opacity-50'}
                  />
                )}
                <textarea
                  value={headerText}
                  onChange={(e) => setHeaderText(e.target.value)}
                  disabled={!!running}
                  rows={2}
                  placeholder={'헤더 (한 줄에 하나)\nX-Auth-Token: ...'}
                  className={inputCls + ' mt-1.5 w-full resize-y font-mono disabled:opacity-50'}
                />
              </>
            ) : (
              <div className="mt-1.5 flex items-center gap-1.5">
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

            <label className="mt-2 flex items-start gap-2 text-[11px] text-gray-300">
              <input
                type="checkbox"
                checked={insecure}
                disabled={!!running || scenarioKind === 'file'}
                onChange={(e) => setInsecure(e.target.checked)}
                className="mt-0.5"
              />
              <span>
                자체 서명 인증서 무시
                <span className="block text-[10px] text-gray-600">사내 인프라는 대개 필요합니다</span>
              </span>
            </label>

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

            {/* 회차 */}
            <div className="mt-4 border-t border-white/10 pt-2">
              <div className="flex items-center gap-2">
                <span className="text-[10.5px] font-medium uppercase tracking-wide text-gray-500">회차</span>
                <button
                  onClick={() => void refreshRuns()}
                  className="ml-auto rounded p-0.5 text-gray-600 hover:bg-white/10 hover:text-gray-300"
                  title="새로 읽기"
                >
                  <RefreshCw size={11} />
                </button>
              </div>
              {runs.length === 0 ? (
                <p className="py-3 text-[11px] text-gray-600">아직 돌린 적이 없습니다.</p>
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
                          <div className="flex items-center gap-1.5">
                            <span className="min-w-0 truncate text-[11.5px] text-gray-200">
                              {new Date(r.meta.startedAt).toLocaleString('ko-KR', { hour12: false }).slice(5)}
                            </span>
                            {isRunning && <span className="shrink-0 text-[10px] text-blue-300">돌고 있음</span>}
                            {r.meta.canceled && <span className="shrink-0 text-[10px] text-amber-300/80">중지</span>}
                          </div>
                          <div className="mt-0.5 truncate text-[10px] text-gray-500">
                            {sum
                              ? `p95 ${fmtMs(sum.p95Ms)} · 실패 ${sum.failRatePct.toFixed(2)}%`
                              : r.meta.canceled
                                ? '결과 없음'
                                : '통계 없음'}
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
                돌고 있는 동안의 값은 콘솔에서 읽은 어림값입니다 — 끝나면 통계 파일로 다시 계산합니다.
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
                  // 돌고 있는 동안의 대시보드는 http 라 dev·배포에서 똑같이 끼워진다.
                  // (정적 리포트는 file:// 이라 별도 창으로 띄운다 — perf:openReport)
                  <iframe
                    src={running.webUrl}
                    title="Locust 대시보드"
                    className="h-full w-full rounded-md border border-white/10 bg-white"
                  />
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
                <div className="h-full overflow-auto">
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

                      <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-gray-500">
                        <span>{selected.meta.config.targetUrl}</span>
                        <span>
                          · 사용자 {selected.meta.config.users} · {Math.round(selected.meta.config.durationSec / 60)}분
                        </span>
                        {selected.meta.config.sessionLabel && <span>· 세션 {selected.meta.config.sessionLabel}</span>}
                        <button
                          onClick={async () => {
                            const r = await window.electronAPI.perfOpenReport(selected.meta.id)
                            if (!r.ok) setNote(r.error ?? '리포트를 열 수 없습니다.')
                          }}
                          className="ml-auto flex items-center gap-1 rounded border border-white/15 bg-panel-light px-2 py-1 text-[11px] text-gray-200 hover:bg-white/10"
                        >
                          <ExternalLink size={11} /> 원본 리포트
                        </button>
                        <button
                          onClick={() => void window.electronAPI.perfOpenFolder(selected.meta.id)}
                          className="flex items-center gap-1 rounded border border-white/15 bg-panel-light px-2 py-1 text-[11px] text-gray-200 hover:bg-white/10"
                        >
                          <FolderOpen size={11} /> 폴더
                        </button>
                      </div>

                      {selectedSummary && selectedSummary.perEndpoint.length > 0 && (
                        <table className="mt-3 w-full table-fixed text-[11.5px]">
                          <thead>
                            <tr className="text-left text-[10.5px] text-gray-500">
                              <th className="w-[46%] pb-1 font-normal">요청</th>
                              <th className="pb-1 text-right font-normal">건수</th>
                              <th className="pb-1 text-right font-normal">실패</th>
                              <th className="pb-1 text-right font-normal">평균</th>
                              <th className="pb-1 text-right font-normal">p95</th>
                            </tr>
                          </thead>
                          <tbody>
                            {selectedSummary.perEndpoint.map((e) => (
                              <tr key={e.name} className="border-t border-white/5">
                                <td className="truncate py-1 font-mono text-gray-300" title={e.name}>
                                  {e.name}
                                </td>
                                <td className="py-1 text-right tabular-nums text-gray-400">{fmtInt(e.requests)}</td>
                                <td
                                  className={
                                    'py-1 text-right tabular-nums ' +
                                    (e.failures > 0 ? 'text-amber-300' : 'text-gray-400')
                                  }
                                >
                                  {fmtInt(e.failures)}
                                </td>
                                <td className="py-1 text-right tabular-nums text-gray-400">{fmtMs(e.avgMs)}</td>
                                <td className="py-1 text-right tabular-nums text-gray-400">{fmtMs(e.p95Ms)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

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
