import { useState } from 'react'
import { SquareTerminal, X, Play, Loader2, ChevronDown, ChevronRight } from 'lucide-react'

export interface RunTarget {
  id: string
  name: string
}

interface MultiRunProps {
  sessions: RunTarget[]
  onClose: () => void
}

interface Result {
  status: 'running' | 'done' | 'error'
  code?: number
  out?: string
  err?: string
  error?: string
}

/**
 * 다중 호스트 명령 실행 — 명령 1개를 선택한 세션들에 동시 실행하고
 * 호스트별 종료코드/출력을 표 형태로 수집(인터랙티브 셸과 분리된 exec 채널).
 */
export default function MultiRun({ sessions, onClose }: MultiRunProps) {
  const [cmd, setCmd] = useState('')
  const [targets, setTargets] = useState<Set<string>>(new Set(sessions.map((s) => s.id)))
  const [results, setResults] = useState<Record<string, Result>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)

  const toggleTarget = (id: string) =>
    setTargets((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  const toggleExpand = (id: string) =>
    setExpanded((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })

  const run = async () => {
    const ids = sessions.filter((s) => targets.has(s.id)).map((s) => s.id)
    if (!cmd.trim() || !ids.length) return
    setBusy(true)
    setResults(Object.fromEntries(ids.map((id) => [id, { status: 'running' as const }])))
    await Promise.all(
      ids.map(async (id) => {
        const r = await window.electronAPI.sessionRun(id, cmd)
        setResults((prev) => ({
          ...prev,
          [id]: r.ok
            ? { status: 'done', code: r.code, out: r.out, err: r.err }
            : { status: 'error', error: r.error },
        }))
      }),
    )
    setBusy(false)
    setExpanded(new Set(ids)) // 결과는 기본 펼침
  }

  const nameOf = (id: string) => sessions.find((s) => s.id === id)?.name ?? id

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-8" onClick={onClose}>
      <div
        className="flex h-[80vh] w-[760px] max-w-[94vw] flex-col overflow-hidden rounded-lg border border-white/10 bg-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-white/10 px-4 py-2.5">
          <SquareTerminal size={16} className="text-blue-400" />
          <span className="text-sm font-semibold text-gray-100">다중 호스트 실행</span>
          <button
            onClick={onClose}
            className="ml-auto rounded p-1 text-gray-400 hover:bg-white/10 hover:text-gray-200"
          >
            <X size={16} />
          </button>
        </div>

        {sessions.length === 0 ? (
          <div className="flex flex-1 items-center justify-center text-sm text-gray-500">
            연결된 세션이 없습니다. 먼저 SSH 연결하세요.
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            {/* 명령 + 대상 */}
            <div className="space-y-2 border-b border-white/10 p-3">
              <div className="flex gap-2">
                <input
                  value={cmd}
                  onChange={(e) => setCmd(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !busy) run()
                  }}
                  placeholder="실행할 명령 (예: uptime, df -h, ceph -s)"
                  className="flex-1 rounded-md border border-white/10 bg-panel-light px-2.5 py-1.5 font-mono text-sm text-gray-100 placeholder:text-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
                <button
                  onClick={run}
                  disabled={busy || !targets.size}
                  className="flex shrink-0 items-center gap-1.5 rounded-md bg-blue-600 px-3 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
                >
                  {busy ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />} 실행
                </button>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {sessions.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => toggleTarget(s.id)}
                    className={
                      'rounded-full border px-2 py-0.5 text-[11px] ' +
                      (targets.has(s.id)
                        ? 'border-blue-500/50 bg-blue-600/20 text-blue-100'
                        : 'border-white/10 text-gray-400 hover:bg-white/5')
                    }
                  >
                    {s.name}
                  </button>
                ))}
              </div>
            </div>

            {/* 결과 표 */}
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {Object.keys(results).length === 0 ? (
                <div className="px-2 py-6 text-center text-xs text-gray-500">
                  명령을 입력하고 실행하면 호스트별 결과가 표시됩니다.
                </div>
              ) : (
                <ul className="space-y-1">
                  {Object.entries(results).map(([id, r]) => {
                    const open = expanded.has(id)
                    return (
                      <li key={id} className="overflow-hidden rounded-md border border-white/10">
                        <div
                          onClick={() => toggleExpand(id)}
                          className="flex cursor-pointer items-center gap-2 bg-panel-light px-2.5 py-1.5 text-xs hover:bg-white/5"
                        >
                          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                          <span className="flex-1 truncate font-medium text-gray-100">{nameOf(id)}</span>
                          {r.status === 'running' ? (
                            <Loader2 size={13} className="animate-spin text-gray-400" />
                          ) : r.status === 'error' ? (
                            <span className="rounded bg-red-500/20 px-1.5 text-[10px] text-red-300">오류</span>
                          ) : (
                            <span
                              className={
                                'rounded px-1.5 text-[10px] ' +
                                (r.code === 0
                                  ? 'bg-emerald-500/20 text-emerald-300'
                                  : 'bg-amber-500/20 text-amber-300')
                              }
                            >
                              exit {r.code}
                            </span>
                          )}
                        </div>
                        {open && r.status !== 'running' && (
                          <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-all bg-[#1e1e2e] px-3 py-2 font-mono text-[11px] text-gray-200">
                            {r.error
                              ? `⚠ ${r.error}`
                              : (r.out || '') + (r.err ? `\n[stderr]\n${r.err}` : '') || '(출력 없음)'}
                          </pre>
                        )}
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
