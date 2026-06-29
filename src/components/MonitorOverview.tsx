import { useEffect } from 'react'
import { ArrowRight, Activity, WifiOff } from 'lucide-react'
import { useMonitor } from '../hooks/useMonitor'

interface SessionInfo {
  id: string
  label: string
  connected: boolean
}

interface Props {
  sessions: SessionInfo[]
  onOpenDashboard: (sessionId: string) => void
}

function fmtUptime(sec: number): string {
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  if (d > 0) return `${d}일 ${h}시간`
  if (h > 0) return `${h}시간 ${m}분`
  return `${m}분`
}

function UsageBar({ pct, warn }: { pct: number; warn: boolean }) {
  return (
    <div className="h-1 w-full overflow-hidden rounded-full bg-white/10">
      <div
        className={'h-full rounded-full transition-all ' + (warn ? 'bg-rose-500' : 'bg-emerald-500')}
        style={{ width: `${Math.min(pct, 100)}%` }}
      />
    </div>
  )
}

function SessionKpiCard({
  sessionId,
  label,
  connected,
  onOpen,
}: {
  sessionId: string
  label: string
  connected: boolean
  onOpen: () => void
}) {
  const { latest, running, start, resumeIfRunning } = useMonitor(sessionId)

  useEffect(() => {
    if (connected) resumeIfRunning()
  }, [connected, resumeIfRunning])

  const diskPct = Number(latest?.disk.pct ?? 0)

  return (
    <div
      className={
        'flex flex-col gap-2 rounded border p-3 transition-colors ' +
        (connected
          ? 'border-white/10 bg-black/20 hover:border-white/20'
          : 'border-white/5 bg-black/10 opacity-50')
      }
    >
      {/* 헤더 */}
      <div className="flex items-center gap-2">
        {connected ? (
          <Activity size={12} className={running ? 'text-emerald-400' : 'text-gray-500'} />
        ) : (
          <WifiOff size={12} className="text-gray-600" />
        )}
        <span className="flex-1 truncate text-sm font-medium text-gray-200">{label}</span>
        {latest && (
          <span className="text-[10px] text-gray-500">up {fmtUptime(latest.uptime)}</span>
        )}
        <button
          onClick={onOpen}
          title="대시보드 탭으로 이동"
          className="rounded p-0.5 text-gray-500 hover:text-gray-200"
        >
          <ArrowRight size={13} />
        </button>
      </div>

      {/* 미연결 */}
      {!connected && (
        <div className="text-[11px] text-gray-600">연결 안 됨</div>
      )}

      {/* 연결 중이나 모니터링 미실행 */}
      {connected && !latest && (
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-gray-500">모니터링 미실행</span>
          <button
            onClick={() => start(5000)}
            className="rounded bg-emerald-700/50 px-2 py-0.5 text-[11px] text-emerald-300 hover:bg-emerald-700"
          >
            시작
          </button>
        </div>
      )}

      {/* KPI */}
      {latest && (
        <>
          <div className="grid grid-cols-3 gap-2 text-[11px]">
            <div>
              <div className="mb-0.5 flex justify-between text-gray-500">
                <span>CPU</span>
                <span className={(latest.cpu > 85 ? 'text-rose-400' : 'text-gray-300')}>
                  {latest.cpu}%
                </span>
              </div>
              <UsageBar pct={latest.cpu} warn={latest.cpu > 85} />
            </div>
            <div>
              <div className="mb-0.5 flex justify-between text-gray-500">
                <span>Memory</span>
                <span className={(latest.mem.pct > 90 ? 'text-rose-400' : 'text-gray-300')}>
                  {latest.mem.pct}%
                </span>
              </div>
              <UsageBar pct={latest.mem.pct} warn={latest.mem.pct > 90} />
            </div>
            <div>
              <div className="mb-0.5 flex justify-between text-gray-500">
                <span>Disk</span>
                <span className={(diskPct > 85 ? 'text-rose-400' : 'text-gray-300')}>
                  {latest.disk.pct}%
                </span>
              </div>
              <UsageBar pct={diskPct} warn={diskPct > 85} />
            </div>
          </div>

          {/* Network + Load */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-gray-500">
            {latest.net && (
              <span>
                Net ↓{latest.net.rxMBs} ↑{latest.net.txMBs} MB/s
              </span>
            )}
            <span>Load {latest.load[0]}</span>
          </div>

          {/* Failed 서비스 목록 */}
        </>
      )}
    </div>
  )
}

export default function MonitorOverview({ sessions, onOpenDashboard }: Props) {
  return (
    <div className="flex h-full flex-col gap-2 overflow-y-auto bg-[#181825] p-3 text-gray-100">
      <div className="text-[11px] text-gray-500">
        연결된 세션 {sessions.length}개
      </div>
      {sessions.length === 0 && (
        <div className="flex flex-1 items-center justify-center text-xs text-gray-600">
          연결된 세션이 없습니다.
        </div>
      )}
      {sessions.map((s) => (
        <SessionKpiCard
          key={s.id}
          sessionId={s.id}
          label={s.label}
          connected={s.connected}
          onOpen={() => onOpenDashboard(s.id)}
        />
      ))}
    </div>
  )
}
