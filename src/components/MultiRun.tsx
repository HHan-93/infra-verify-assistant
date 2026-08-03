import { useMemo, useState } from 'react'
import { SquareTerminal, X, Play, Loader2, ChevronDown, ChevronRight, Search, ScanText, Info } from 'lucide-react'
import { judgeOutput, verdictBadge, type Verdict } from '../lib/verdict'

export interface RunTarget {
  id: string
  name: string
}

interface MultiRunProps {
  sessions: RunTarget[]
  onClose: () => void
  /** 실행 결과 전체를 AI 패널로 보내 분석 (스트리밍 중이면 false 반환) */
  onAnalyze: (text: string) => boolean
}

interface Result {
  status: 'running' | 'done' | 'error'
  code?: number
  out?: string
  err?: string
  error?: string
}

/** 대소문자 구분 없이 일치하는 부분을 <mark>로 감싸 하이라이트 (특수문자 이스케이프 포함) */
function highlight(text: string, query: string) {
  if (!query) return text
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const parts = text.split(new RegExp(`(${escaped})`, 'gi'))
  return parts.map((part, i) =>
    part.toLowerCase() === query.toLowerCase() ? (
      <mark key={i} className="rounded bg-yellow-500/40 text-inherit">
        {part}
      </mark>
    ) : (
      part
    ),
  )
}

/**
 * 다중 호스트 명령 실행 — 명령 1개를 선택한 세션들에 동시 실행하고
 * 호스트별 종료코드/출력을 표 형태로 수집(인터랙티브 셸과 분리된 exec 채널).
 */
export default function MultiRun({ sessions, onClose, onAnalyze }: MultiRunProps) {
  const [cmd, setCmd] = useState('')
  const [analyzeNotice, setAnalyzeNotice] = useState('')
  const [targets, setTargets] = useState<Set<string>>(new Set(sessions.map((s) => s.id)))
  const [results, setResults] = useState<Record<string, Result>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [query, setQuery] = useState('')
  const [onlyFailed, setOnlyFailed] = useState(false)

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
    // 타임아웃이 없으면 `tail -f`·`top` 같은 블로킹 명령에서 스피너가 영원히 돌고
    // busy 가 true 로 고착돼 모달을 닫는 것 외에는 복구할 방법이 없다(시나리오 러너와 동일 정책).
    const RUN_TIMEOUT_MS = 45000
    await Promise.all(
      ids.map(async (id) => {
        const r = await Promise.race([
          window.electronAPI.sessionRun(id, cmd),
          new Promise<{ ok: false; error: string }>((res) =>
            setTimeout(
              () => res({ ok: false, error: `${RUN_TIMEOUT_MS / 1000}초 내 응답이 없어 중단했습니다 (계속 실행되는 명령일 수 있습니다)` }),
              RUN_TIMEOUT_MS,
            ),
          ),
        ])
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

  // 실행 결과 전체를 노드별로 묶어 AI 분석에 보냄 (노드 간 차이/이상 비교)
  const analyzeResults = () => {
    const entries = Object.entries(results)
    if (!entries.length) return
    const parts = entries.map(([id, r]) => {
      const body = r.error
        ? `⚠ ${r.error}`
        : `exit ${r.code}\n${(r.out || '') + (r.err ? `\n[stderr]\n${r.err}` : '')}`.trim()
      return `### 세션: ${nameOf(id)}\n$ ${cmd}\n${body || '(출력 없음)'}`
    })
    const text = `다음은 여러 노드에서 같은 명령 "${cmd}" 를 실행한 결과입니다. 노드 간 차이/이상 징후를 비교 분석해 주세요.\n\n${parts.join('\n\n')}`
    const started = onAnalyze(text)
    setAnalyzeNotice(started ? '' : 'AI가 이미 다른 응답을 생성하는 중입니다. 잠시 후 다시 시도하세요.')
  }

  const trimmedQuery = query.trim()
  // 자동 판정 — MultiRun 은 임의 명령을 직접 입력해 돌리는 도구라 명시적 기준(check)이 없으므로
  // 기본 판정(위험 키워드/종료코드)만 적용된다: 실패(빨강) 또는 정보(회색). 초록 PASS 는 뜨지 않음.
  const verdictOf = (r: Result): Verdict | null =>
    r.status === 'done' ? judgeOutput(r.out, r.err, r.code).verdict : null
  const isFailed = (r: Result) => r.status === 'error' || verdictOf(r) === 'fail'
  const summary = useMemo(() => {
    let fail = 0, info = 0, err = 0
    for (const r of Object.values(results)) {
      if (r.status === 'error') err++
      else if (r.status === 'done') {
        const v = judgeOutput(r.out, r.err, r.code).verdict
        if (v === 'fail') fail++
        else info++
      }
    }
    return { fail, info, err }
  }, [results])
  const matchesQuery = (id: string, r: Result) => {
    if (!trimmedQuery) return true
    const q = trimmedQuery.toLowerCase()
    return (
      nameOf(id).toLowerCase().includes(q) ||
      (r.out ?? '').toLowerCase().includes(q) ||
      (r.err ?? '').toLowerCase().includes(q) ||
      (r.error ?? '').toLowerCase().includes(q)
    )
  }
  const filteredEntries = useMemo(
    () =>
      Object.entries(results).filter(
        ([id, r]) => (!onlyFailed || isFailed(r)) && matchesQuery(id, r),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [results, onlyFailed, trimmedQuery, sessions],
  )

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-8" onClick={onClose}>
      <div
        className="flex h-[80vh] w-[1000px] max-w-[94vw] flex-col overflow-hidden rounded-lg border border-white/10 bg-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-white/10 px-4 py-2.5">
          <SquareTerminal size={16} className="text-blue-400" />
          <span className="text-sm font-semibold text-gray-100">다중 호스트 실행</span>
          {Object.keys(results).length > 0 && (
            <button
              onClick={analyzeResults}
              title="실행 결과 전체를 AI로 비교 분석"
              className="ml-auto flex items-center gap-1 rounded-md border border-white/10 bg-panel-light px-2 py-1 text-xs text-gray-200 hover:bg-white/10"
            >
              <ScanText size={14} className="text-blue-300" />
              AI 분석
            </button>
          )}
          <button
            onClick={onClose}
            className={
              (Object.keys(results).length > 0 ? '' : 'ml-auto ') +
              'rounded p-1 text-gray-400 hover:bg-white/10 hover:text-gray-200'
            }
          >
            <X size={16} />
          </button>
        </div>
        {analyzeNotice && (
          <div className="bg-amber-500/10 px-4 py-1 text-[11px] text-amber-300">{analyzeNotice}</div>
        )}

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

            {/* 결과 검색/필터 */}
            {Object.keys(results).length > 0 && (
              <div className="flex items-center gap-2 border-b border-white/10 px-3 py-1.5">
                <Search size={12} className="shrink-0 text-gray-500" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="호스트명, 출력 내용 검색..."
                  className="min-w-0 flex-1 bg-transparent text-xs text-gray-200 outline-none placeholder:text-gray-600"
                />
                {(summary.fail > 0 || summary.err > 0) && (
                  <span className="shrink-0 rounded bg-red-500/15 px-1.5 py-0.5 text-[11px] font-medium text-red-300">
                    실패 {summary.fail + summary.err}
                  </span>
                )}
                {summary.info > 0 && (
                  <span className="shrink-0 flex items-center gap-0.5 text-[11px] text-emerald-300/70">
                    <Info size={11} /> 실행됨 {summary.info}
                  </span>
                )}
                <button
                  onClick={() => setOnlyFailed((v) => !v)}
                  className={
                    'shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium ' +
                    (onlyFailed ? 'bg-amber-500/30 text-amber-200' : 'text-gray-400 hover:bg-white/10')
                  }
                >
                  실패만
                </button>
                <span className="shrink-0 text-[11px] text-gray-500">
                  {filteredEntries.length}/{Object.keys(results).length}
                </span>
              </div>
            )}

            {/* 결과 표 */}
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {Object.keys(results).length === 0 ? (
                <div className="px-2 py-6 text-center text-xs text-gray-500">
                  명령을 입력하고 실행하면 호스트별 결과가 표시됩니다.
                </div>
              ) : filteredEntries.length === 0 ? (
                <div className="px-2 py-6 text-center text-xs text-gray-500">일치하는 결과가 없습니다.</div>
              ) : (
                <ul className="space-y-1">
                  {filteredEntries.map(([id, r]) => {
                    const open = expanded.has(id) || !!trimmedQuery
                    return (
                      <li key={id} className="overflow-hidden rounded-md border border-white/10">
                        <div
                          onClick={() => toggleExpand(id)}
                          className="flex cursor-pointer items-center gap-2 bg-panel-light px-2.5 py-1.5 text-xs hover:bg-white/5"
                        >
                          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                          <span className="flex-1 truncate font-medium text-gray-100">
                            {highlight(nameOf(id), trimmedQuery)}
                          </span>
                          {r.status === 'running' ? (
                            <Loader2 size={13} className="animate-spin text-gray-400" />
                          ) : r.status === 'error' ? (
                            <span className="rounded bg-red-500/20 px-1.5 text-[10px] text-red-300">오류</span>
                          ) : (
                            (() => {
                              const j = judgeOutput(r.out, r.err, r.code)
                              const b = verdictBadge(j.verdict)
                              return (
                                <>
                                  <span
                                    title={j.reasons.join(', ')}
                                    className={'flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] font-medium ' + b.cls}
                                  >
                                    {j.verdict === 'info' && <Info size={10} />}
                                    {b.label}
                                  </span>
                                  <span className="text-[10px] text-gray-500">exit {r.code}</span>
                                </>
                              )
                            })()
                          )}
                        </div>
                        {open && r.status !== 'running' && (
                          <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-all bg-[#1e1e2e] px-3 py-2 font-mono text-[11px] text-gray-200">
                            {highlight(
                              r.error
                                ? `⚠ ${r.error}`
                                : (r.out || '') + (r.err ? `\n[stderr]\n${r.err}` : '') || '(출력 없음)',
                              trimmedQuery,
                            )}
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
