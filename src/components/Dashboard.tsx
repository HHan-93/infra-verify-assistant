import { useEffect, useRef, useState } from 'react'
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from 'recharts'
import { Play, Square, FileText, Save, FileDown, Loader2, Info, X, Download } from 'lucide-react'
import Markdown from './Markdown'
import ProcessListModal from './ProcessListModal'
import { useMonitor, formatForReport } from '../hooks/useMonitor'
import { buildReportHtml } from '../lib/reportHtml'
import type { AIProvider, AnalysisStyle, MetricSample } from '../../electron/shared-types'

interface Props {
  sessionId: string
  connected: boolean
}

type ChartRange = '5m' | '30m' | '1h' | '6h' | '24h' | '7d'
const CHART_RANGES: ChartRange[] = ['5m', '30m', '1h', '6h', '24h', '7d']
const RANGE_SEC: Record<ChartRange, number> = {
  '5m': 300,
  '30m': 1800,
  '1h': 3600,
  '6h': 6 * 3600,
  '24h': 24 * 3600,
  '7d': 7 * 24 * 3600,
}
const RANGE_LABEL: Record<ChartRange, string> = {
  '5m': '5분',
  '30m': '30분',
  '1h': '1시간',
  '6h': '6시간',
  '24h': '24시간',
  '7d': '7일',
}
// 실시간 버퍼(최근 최대 1시간)로는 부족한 범위 — 로컬에 장기 보관된 이력을 추가로 불러와야 함
const LONG_RANGES = new Set<ChartRange>(['6h', '24h', '7d'])

/** 업타임(초)을 "N일 N시간" 또는 "N시간 N분" 형태로 변환 */
function fmtUptime(sec: number): string {
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  if (d > 0) return `${d}일 ${h}시간`
  if (h > 0) return `${h}시간 ${m}분`
  return `${m}분`
}

/** AIPanel 이 localStorage 에 저장한 설정(ai_config)을 그대로 읽어 리포트에 사용 */
function readAiConfig(): {
  provider: AIProvider
  model?: string
  apiKey?: string
  style: AnalysisStyle
} {
  try {
    const raw = localStorage.getItem('ai_config')
    if (raw) {
      const p = JSON.parse(raw) as {
        provider: AIProvider
        configs: Record<AIProvider, { key: string; model: string }>
        analysisStyle?: AnalysisStyle
      }
      const cfg = p.configs?.[p.provider]
      return {
        provider: p.provider ?? 'anthropic',
        model: cfg?.model || undefined,
        apiKey: cfg?.key || undefined,
        style: p.analysisStyle ?? 'detailed',
      }
    }
  } catch {
    /* 손상된 설정 무시 */
  }
  return { provider: 'gemini', style: 'detailed' }
}

const KILL_ON_EXIT_KEY = 'monitor_kill_on_exit'

const fileStamp = () => {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
}

export default function Dashboard({ sessionId, connected }: Props) {
  const { history, latest, running, resumed, error, start, stop, resetState, resumeIfRunning } =
    useMonitor(sessionId)

  // 접속되어 있으면 데몬 생존 확인 후 자동 resume (탭 전환/재접속 대응)
  // 끊기면 UI 상태 초기화 → "수집 시작" 버튼으로 복귀
  useEffect(() => {
    if (connected) resumeIfRunning()
    else resetState()
  }, [connected, resumeIfRunning, resetState])

  // 앱 종료 시 데몬 kill 옵션 (localStorage 저장 + 메인과 동기화)
  const [killOnExit, setKillOnExit] = useState(false)
  useEffect(() => {
    const saved = localStorage.getItem(KILL_ON_EXIT_KEY) === '1'
    setKillOnExit(saved)
    window.electronAPI.monitorSetKillOnExit(saved)
  }, [])
  const toggleKillOnExit = (v: boolean) => {
    setKillOnExit(v)
    localStorage.setItem(KILL_ON_EXIT_KEY, v ? '1' : '0')
    window.electronAPI.monitorSetKillOnExit(v)
  }

  // 차트 범위 토글 — 가로축은 '시각' 기준, 항상 [지금-범위 ~ 지금] 구간을 표시
  // 프로세스 kill 진행 중인 PID 추적
  const [killingPids, setKillingPids] = useState<Set<number>>(new Set())
  const killProc = async (pid: number) => {
    setKillingPids((prev) => new Set(prev).add(pid))
    await window.electronAPI.monitorKillProc(sessionId, pid)
    setKillingPids((prev) => { const s = new Set(prev); s.delete(pid); return s })
  }

  const [chartRange, setChartRange] = useState<ChartRange>('5m')
  const [intervalMs, setIntervalMs] = useState(5000)
  const [showAllProcs, setShowAllProcs] = useState(false)
  const [showProcessModal, setShowProcessModal] = useState(false)
  // 원격 서버 시각(ts) 기준 — 로컬 PC와 서버 시계가 어긋나 있어도(NTP 미동기화 등)
  // "최근 N분" 창이 실제 수집 데이터를 기준으로 맞춰지도록 함 (Date.now() 사용 시 시계 어긋나면 차트가 비어보임)
  const nowMs = latest ? latest.ts * 1000 : Date.now()
  const cutoffMs = nowMs - RANGE_SEC[chartRange] * 1000

  // 6h/24h/7d 처럼 실시간 버퍼(최근 최대 1시간)를 넘어서는 범위는 로컬에 장기 보관된 이력을 추가로 불러옴
  const [longHistory, setLongHistory] = useState<MetricSample[]>([])
  const [loadingLongHistory, setLoadingLongHistory] = useState(false)
  useEffect(() => {
    if (!LONG_RANGES.has(chartRange) || !latest?.host) {
      setLongHistory([])
      return
    }
    let cancelled = false
    setLoadingLongHistory(true)
    window.electronAPI.monitorHistory(latest.host, cutoffMs).then((r) => {
      if (!cancelled) {
        setLongHistory(r.ok && r.samples ? r.samples : [])
        setLoadingLongHistory(false)
      }
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chartRange, latest?.host])

  // 장기 이력 + 실시간 버퍼 병합 (ts 기준 중복 제거, 오름차순)
  const combinedHistory =
    LONG_RANGES.has(chartRange) && longHistory.length
      ? Array.from(new Map([...longHistory, ...history].map((s) => [s.ts, s])).values()).sort(
          (a, b) => a.ts - b.ts,
        )
      : history
  const visibleHistory = combinedHistory.filter((s) => s.ts * 1000 >= cutoffMs)

  const chartData = visibleHistory.map((s) => ({
    ts: s.ts * 1000, // epoch ms (X축 시간 도메인)
    cpu: s.cpu,
    mem: s.mem.pct,
    rx: s.net?.rxMBs ?? null,
    tx: s.net?.txMBs ?? null,
  }))

  // 5분 범위면 초까지, 24h/7d 처럼 하루를 넘어가는 범위는 날짜도 함께 표시(날짜 구분 위해)
  const fmtClock = (v: number) => {
    if (chartRange === '24h' || chartRange === '7d') {
      return new Date(v).toLocaleString('ko-KR', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      })
    }
    return new Date(v).toLocaleTimeString('ko-KR', {
      hour: '2-digit',
      minute: '2-digit',
      ...(chartRange === '5m' ? { second: '2-digit' } : {}),
      hour12: false,
    })
  }
  // 모든 차트가 공유하는 X축(시간) 설정
  const xAxisProps = {
    dataKey: 'ts',
    type: 'number' as const,
    scale: 'time' as const,
    domain: [cutoffMs, nowMs] as [number, number],
    tickFormatter: fmtClock,
    tick: { fontSize: 10, fill: '#9ca3af' },
    minTickGap: 50,
  }

  // ── AI 리포트(스트리밍) ──
  const [report, setReport] = useState('')
  const [reporting, setReporting] = useState(false)
  const [saveMsg, setSaveMsg] = useState('')
  const reqIdRef = useRef<string | null>(null)

  useEffect(() => {
    const offDelta = window.electronAPI.onAiDelta((e) => {
      if (e.requestId === reqIdRef.current && e.text) setReport((r) => r + e.text)
    })
    const offDone = window.electronAPI.onAiDone((e) => {
      if (e.requestId === reqIdRef.current) setReporting(false)
    })
    const offErr = window.electronAPI.onAiError((e) => {
      if (e.requestId === reqIdRef.current) {
        setReport((r) => r + `\n\n> ⚠️ ${e.error ?? '오류'}`)
        setReporting(false)
      }
    })
    return () => {
      offDelta()
      offDone()
      offErr()
    }
  }, [])

  const generateReport = () => {
    if (!history.length || reporting) return
    const id = crypto.randomUUID()
    reqIdRef.current = id
    setReport('')
    setReporting(true)
    const ai = readAiConfig()
    window.electronAPI.aiSend({
      requestId: id,
      provider: ai.provider,
      model: ai.model,
      style: ai.style,
      apiKey: ai.apiKey,
      messages: [{ role: 'user', content: formatForReport(history) }],
    })
  }

  const saveReport = async () => {
    const res = await window.electronAPI.saveReport({
      defaultName: `server-report-${latest?.host ?? 'host'}-${fileStamp()}.md`,
      content: report,
    })
    if (res.saved) setSaveMsg(`저장됨: ${res.path}`)
    else if (res.error) setSaveMsg(`저장 실패: ${res.error}`)
    if (res.saved) setTimeout(() => setSaveMsg(''), 4000)
  }

  const savePdfReport = async () => {
    const html = buildReportHtml(report, `서버 상태 리포트 - ${latest?.host ?? ''}`)
    const res = await window.electronAPI.saveReportPdf({
      html,
      defaultName: `server-report-${latest?.host ?? 'host'}-${fileStamp()}.pdf`,
    })
    if (res.saved) setSaveMsg(`저장됨: ${res.path}`)
    else if (res.error) setSaveMsg(`저장 실패: ${res.error}`)
    if (res.saved) setTimeout(() => setSaveMsg(''), 4000)
  }

  const exportCSV = async () => {
    if (!history.length) return
    const header = 'timestamp,cpu,mem_pct,mem_used_mb,mem_total_mb,disk_pct,disk_used_gb,disk_total_gb,rx_mbs,tx_mbs,load_1m,load_5m,load_15m'
    const rows = history.map((s) => {
      const ts = new Date(s.ts * 1000).toISOString()
      return [
        ts, s.cpu, s.mem.pct, s.mem.used, s.mem.total,
        s.disk.pct, s.disk.used, s.disk.total,
        s.net?.rxMBs ?? '', s.net?.txMBs ?? '',
        s.load[0], s.load[1], s.load[2],
      ].join(',')
    })
    const csv = [header, ...rows].join('\n')
    const res = await window.electronAPI.saveReport({
      defaultName: `metrics-${latest?.host ?? 'host'}-${fileStamp()}.csv`,
      content: csv,
    })
    if (res.saved) setSaveMsg('CSV 저장됨')
    else if (res.error) setSaveMsg(`저장 실패: ${res.error}`)
    if (res.saved || res.error) setTimeout(() => setSaveMsg(''), 4000)
  }

  const diskPct = Number(latest?.disk.pct ?? 0)
  const hasNet = !!latest?.net

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto bg-[#181825] p-3 text-gray-100">
      {/* 헤더 / 컨트롤 */}
      <div className="flex flex-wrap items-center gap-2">
        {!running ? (
          <>
            <select
              value={intervalMs}
              onChange={(e) => setIntervalMs(Number(e.target.value))}
              className="rounded border border-white/10 bg-neutral-800 px-1.5 py-1.5 text-xs text-gray-200 focus:outline-none"
              style={{ colorScheme: 'dark' }}
              title="수집 주기"
            >
              <option value={2000}>2초</option>
              <option value={5000}>5초</option>
              <option value={10000}>10초</option>
              <option value={30000}>30초</option>
            </select>
            <button
              disabled={!connected}
              onClick={() => start(intervalMs)}
              title="에이전트 배포 + 서버 데몬 기동 + 수집 시작"
              className="flex items-center gap-1 rounded bg-emerald-600 px-3 py-1.5 text-sm hover:bg-emerald-500 disabled:opacity-40"
            >
              <Play size={14} /> 수집 시작
            </button>
          </>
        ) : (
          <button
            onClick={stop}
            title="서버 데몬까지 완전히 종료"
            className="flex items-center gap-1 rounded bg-rose-600 px-3 py-1.5 text-sm hover:bg-rose-500"
          >
            <Square size={14} /> 중지
          </button>
        )}
        {running && (
          <span className="text-xs text-emerald-400">
            🟢 {resumed ? '데몬 실행 중(재연결됨)' : '수집 중'}
          </span>
        )}
        {latest && (
          <span className="text-xs text-gray-400">
            {latest.host}
            <span className="ml-2 text-gray-500">up {fmtUptime(latest.uptime)}</span>
          </span>
        )}
        {error && <span className="text-xs text-rose-400">⚠ {error}</span>}

        <label
          className="ml-auto flex cursor-pointer items-center gap-1.5 text-xs text-gray-400"
          title="끄면(기본) 앱을 닫아도 서버 데몬이 계속 수집합니다. 켜면 앱 종료 시 데몬을 정리합니다."
        >
          <input
            type="checkbox"
            checked={killOnExit}
            onChange={(e) => toggleKillOnExit(e.target.checked)}
            className="accent-emerald-500"
          />
          앱 종료 시 데몬 종료
        </label>
      </div>

      {/* 에이전트 안내 — 무엇이 어디서 실행 중인지 */}
      <div className="flex items-start gap-1.5 rounded border border-white/10 bg-black/20 px-2.5 py-1.5 text-[11px] leading-relaxed text-gray-400">
        <Info size={13} className="mt-0.5 shrink-0 text-gray-500" />
        <span>
          수집 에이전트 <b className="text-gray-300">collect.sh</b> 가 원격 서버의{' '}
          <code className="rounded bg-black/40 px-1 font-mono text-gray-300">/tmp/.ivk-agent/</code>{' '}
          에서 백그라운드 데몬으로 {intervalMs / 1000}초마다 수집합니다. (데이터{' '}
          <span className="font-mono">metrics.jsonl</span>, 프로세스 ID{' '}
          <span className="font-mono">agent.pid</span>)
        </span>
      </div>

      {/* KPI 카드 */}
      <div className="grid grid-cols-4 gap-2">
        <Kpi label="CPU" value={latest ? `${latest.cpu}%` : '—'} warn={(latest?.cpu ?? 0) > 85} />
        <Kpi
          label="Memory"
          value={latest ? `${latest.mem.pct}%` : '—'}
          sub={latest ? `${latest.mem.used} / ${latest.mem.total} MB` : undefined}
          warn={(latest?.mem.pct ?? 0) > 90}
        />
        <Kpi
          label="Disk"
          value={latest ? `${latest.disk.pct}%` : '—'}
          sub={latest ? `루트(/) · ${latest.disk.used}/${latest.disk.total} GB` : '루트(/) 파티션'}
          warn={diskPct > 85}
        />
        {/* Network: 두 수치가 받기/보내기임을 라벨로 명시 */}
        <div
          className="rounded border border-white/10 bg-black/20 p-2"
          title="현재 초당 네트워크 전송량 (루프백 lo 제외 전체 인터페이스 합계)"
        >
          <div className="text-[11px] text-gray-400">Network (MB/s)</div>
          {hasNet ? (
            <div className="mt-0.5 space-y-0.5">
              <div className="flex items-baseline justify-between gap-1">
                <span className="text-[10px] text-gray-500">↓ RX</span>
                <span className="font-mono text-sm tabular-nums text-emerald-400">{latest!.net!.rxMBs}</span>
              </div>
              <div className="flex items-baseline justify-between gap-1">
                <span className="text-[10px] text-gray-500">↑ TX</span>
                <span className="font-mono text-sm tabular-nums text-orange-400">{latest!.net!.txMBs}</span>
              </div>
            </div>
          ) : (
            <div className="text-lg font-semibold">—</div>
          )}
        </div>
      </div>

      {/* 실시간 차트 */}
      <div className="rounded border border-white/10 bg-black/20 p-2">
        <div className="mb-1 flex items-center gap-2">
          <span className="text-xs text-gray-400">CPU / Memory 사용률 (%)</span>
          <div className="flex items-center gap-2 text-[10px]">
            <LegendDot color="#38bdf8" label="CPU" />
            <LegendDot color="#a78bfa" label="Memory" />
          </div>
          <div className="ml-auto flex items-center gap-1">
            {CHART_RANGES.map((r) => (
              <button
                key={r}
                onClick={() => setChartRange(r)}
                title={`최근 ${RANGE_LABEL[r]} 표시`}
                className={
                  'rounded px-2 py-0.5 text-[11px] ' +
                  (chartRange === r
                    ? 'bg-white/20 text-white'
                    : 'text-gray-500 hover:text-gray-300')
                }
              >
                {r}
              </button>
            ))}
            <button
              onClick={exportCSV}
              disabled={!history.length}
              title="수집 데이터를 CSV로 저장"
              className="ml-1 rounded p-0.5 text-gray-500 hover:text-gray-300 disabled:opacity-30"
            >
              <Download size={13} />
            </button>
          </div>
        </div>
        <div className="mb-1 text-[10px] text-gray-500">
          가로축: 시각 · 최근 {RANGE_LABEL[chartRange]} 구간
          {loadingLongHistory && <span className="ml-1 text-blue-400">불러오는 중...</span>}
        </div>
        <ResponsiveContainer width="100%" height={160}>
          <LineChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: -20 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#ffffff14" />
            <XAxis {...xAxisProps} />
            <YAxis domain={[0, 100]} tick={{ fontSize: 10, fill: '#9ca3af' }} unit="%" />
            <Tooltip
              contentStyle={{ background: '#1e1e2e', border: '1px solid #ffffff22', fontSize: 12 }}
              labelStyle={{ color: '#9ca3af' }}
              labelFormatter={(v) => fmtClock(v as number)}
            />
            <Line type="monotone" dataKey="cpu" stroke="#38bdf8" dot={false} isAnimationActive={false} name="CPU" />
            <Line type="monotone" dataKey="mem" stroke="#a78bfa" dot={false} isAnimationActive={false} name="Memory" />
          </LineChart>
        </ResponsiveContainer>

        {/* 네트워크 차트 (에이전트 v3+) */}
        {hasNet && (
          <>
            <div className="mb-1 mt-3 flex items-center gap-2">
              <span className="text-xs text-gray-400">Network I/O (MB/s)</span>
              <div className="flex items-center gap-2 text-[10px]">
                <LegendDot color="#34d399" label="Receive (↓)" />
                <LegendDot color="#fb923c" label="Transmit (↑)" />
              </div>
            </div>
            <ResponsiveContainer width="100%" height={100}>
              <LineChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: -20 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#ffffff14" />
                <XAxis {...xAxisProps} />
                <YAxis tick={{ fontSize: 10, fill: '#9ca3af' }} />
                <Tooltip
                  contentStyle={{ background: '#1e1e2e', border: '1px solid #ffffff22', fontSize: 12 }}
                  labelStyle={{ color: '#9ca3af' }}
                  labelFormatter={(v) => fmtClock(v as number)}
                />
                <Line type="monotone" dataKey="rx" stroke="#34d399" dot={false} isAnimationActive={false} name="Receive" />
                <Line type="monotone" dataKey="tx" stroke="#fb923c" dot={false} isAnimationActive={false} name="Transmit" />
              </LineChart>
            </ResponsiveContainer>
          </>
        )}

        {!history.length && (
          <div className="py-6 text-center text-xs text-gray-500">
            {connected ? '"수집 시작"을 누르면 그래프가 그려집니다.' : 'SSH 연결 후 사용하세요.'}
          </div>
        )}
        {!!history.length && !visibleHistory.length && (
          <div className="py-6 text-center text-xs text-gray-500">
            수집된 데이터는 있지만 선택한 범위({RANGE_LABEL[chartRange]}) 안에 없습니다. 서버-로컬
            시계가 어긋나 있을 수 있으니 범위를 늘려보거나 서버 시간 동기화를 확인하세요.
          </div>
        )}
      </div>


      {/* 디스크 마운트 포인트 (에이전트 v6+, /dev/* 파티션) */}
      {latest?.disks && latest.disks.length > 0 && (
        <div className="rounded border border-white/10 bg-black/20 p-2">
          <div className="mb-1.5 text-xs text-gray-400">디스크 파티션</div>
          <div className="space-y-1.5">
            {latest.disks.map((d) => (
              <div key={d.mount} className="text-[11px]">
                <div className="mb-0.5 flex items-center justify-between text-gray-400">
                  <span className="font-mono">{d.mount}</span>
                  <span className={d.pct > 85 ? 'text-rose-400' : 'text-gray-300'}>
                    {d.used} / {d.total} GB · {d.pct}%
                  </span>
                </div>
                <div className="h-1 overflow-hidden rounded-full bg-white/10">
                  <div
                    className={'h-full rounded-full ' + (d.pct > 85 ? 'bg-rose-500' : 'bg-sky-500')}
                    style={{ width: `${Math.min(d.pct, 100)}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 상위 프로세스 */}
      <div className="rounded border border-white/10 bg-black/20 p-2">
        <div className="mb-1 flex items-center gap-2">
          <span className="text-xs text-gray-400">상위 프로세스 (CPU)</span>
          {(latest?.procs.length ?? 0) > 5 && (
            <button
              onClick={() => setShowAllProcs((v) => !v)}
              className="ml-auto text-[11px] text-gray-500 hover:text-gray-300"
            >
              {showAllProcs ? '접기' : `더보기 (${latest!.procs.length}개)`}
            </button>
          )}
          <button
            onClick={() => setShowProcessModal(true)}
            className={(latest?.procs.length ?? 0) > 5 ? 'text-[11px] text-blue-300 hover:text-blue-200' : 'ml-auto text-[11px] text-blue-300 hover:text-blue-200'}
          >
            전체 프로세스 보기
          </button>
        </div>
        <table className="w-full text-xs">
          <thead className="text-gray-500">
            <tr>
              <th className="text-left font-medium">PID</th>
              <th className="text-left font-medium">이름</th>
              <th className="text-right font-medium">CPU%</th>
              <th className="text-right font-medium">MEM%</th>
              <th className="w-6" />
            </tr>
          </thead>
          <tbody>
            {latest?.procs.slice(0, showAllProcs ? 10 : 5).map((p) => (
              <tr key={p.pid} className="group border-t border-white/5">
                <td className="py-0.5 text-gray-400">{p.pid}</td>
                <td className="max-w-[120px] truncate">{p.name}</td>
                <td className="text-right">{p.cpu}</td>
                <td className="text-right">{p.mem}</td>
                <td className="text-right">
                  <button
                    onClick={() => killProc(p.pid)}
                    disabled={killingPids.has(p.pid)}
                    title={`PID ${p.pid} (${p.name}) 프로세스 종료`}
                    className="rounded p-0.5 text-gray-600 opacity-0 transition-opacity hover:bg-rose-500/20 hover:text-rose-400 group-hover:opacity-100 disabled:opacity-30"
                  >
                    {killingPids.has(p.pid)
                      ? <Loader2 size={11} className="animate-spin" />
                      : <X size={11} />}
                  </button>
                </td>
              </tr>
            ))}
            {!latest && (
              <tr>
                <td colSpan={5} className="py-3 text-center text-gray-500">
                  데이터 없음
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* AI 리포트 */}
      <div className="rounded border border-white/10 bg-black/20 p-2">
        <div className="mb-2 flex items-center gap-2">
          <button
            disabled={!history.length || reporting}
            onClick={generateReport}
            title="최근 수집 데이터로 AI 상태 요약·이상징후 리포트 생성"
            className="flex items-center gap-1 rounded bg-indigo-600 px-3 py-1.5 text-sm hover:bg-indigo-500 disabled:opacity-40"
          >
            {reporting ? <Loader2 size={14} className="animate-spin" /> : <FileText size={14} />}
            {reporting ? '분석 중…' : '리포트 생성'}
          </button>
          {report && !reporting && (
            <>
              <button
                onClick={saveReport}
                className="flex items-center gap-1 rounded bg-white/10 px-3 py-1.5 text-sm hover:bg-white/20"
              >
                <Save size={14} /> .md 저장
              </button>
              <button
                onClick={savePdfReport}
                title="정리된 문서 형태(PDF)로 저장 — 공유·인쇄에 적합"
                className="flex items-center gap-1 rounded bg-white/10 px-3 py-1.5 text-sm hover:bg-white/20"
              >
                <FileDown size={14} /> PDF 저장
              </button>
            </>
          )}
        </div>
        {saveMsg && <div className="mb-1 truncate text-[11px] text-gray-400">{saveMsg}</div>}
        {report && (
          <div className="rounded bg-panel-light/50 p-2">
            <Markdown content={report} />
          </div>
        )}
      </div>

      {showProcessModal && (
        <ProcessListModal sessionId={sessionId} onClose={() => setShowProcessModal(false)} />
      )}
    </div>
  )
}

function Kpi({ label, value, warn, sub }: { label: string; value: string; warn?: boolean; sub?: string }) {
  return (
    <div
      className={
        'rounded border p-2 ' +
        (warn ? 'border-rose-500/50 bg-rose-500/10' : 'border-white/10 bg-black/20')
      }
    >
      <div className="text-[11px] text-gray-400">{label}</div>
      <div className={'truncate text-lg font-semibold leading-tight ' + (warn ? 'text-rose-300' : '')}>{value}</div>
      {sub && <div className="truncate text-[10px] text-gray-500">{sub}</div>}
    </div>
  )
}

/** 차트 선 색상 범례 점 */
function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1 text-gray-400">
      <span className="inline-block h-2 w-2 rounded-full" style={{ background: color }} />
      {label}
    </span>
  )
}
