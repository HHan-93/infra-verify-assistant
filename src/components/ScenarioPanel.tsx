import { useMemo, useRef, useState, useEffect } from 'react'
import { Play, CornerDownLeft, Copy, Check, X, ListChecks, Search, ChevronDown, AlertTriangle } from 'lucide-react'
import { SCENARIOS, type Scenario } from '../scenarios'

interface ScenarioPanelProps {
  connected: boolean
  onRun: (cmd: string, execute: boolean) => void
  onClose: () => void
}

// [^<>\n]: heredoc(<< 'EOF')의 << 를 placeholder 시작으로 오인하지 않도록 중첩 < 와 개행을 제외
const PLACEHOLDER_RE = /<([^<>\n]+)>/g
const hasPlaceholder = (cmd: string) => /<[^<>\n]+>/.test(cmd)

/** 명령어에서 <플레이스홀더> 목록을 등장 순서대로 중복 없이 추출 */
const extractPlaceholders = (cmd: string): string[] => {
  const found: string[] = []
  for (const m of cmd.matchAll(PLACEHOLDER_RE)) {
    if (!found.includes(m[1])) found.push(m[1])
  }
  return found
}

/** 명령어의 모든 <플레이스홀더>를 입력값으로 치환 */
const fillPlaceholders = (cmd: string, values: Record<string, string>) =>
  cmd.replace(PLACEHOLDER_RE, (full, key) => values[key]?.trim() || full)

/** 여러 줄 명령어(heredoc 등)는 배지에 첫 줄만 요약 표시 — 전체를 넣으면 truncate가 깨져 패널이 가로로 늘어남 */
const commandPreview = (cmd: string) => {
  const firstLine = cmd.split('\n')[0]
  return cmd.includes('\n') ? firstLine + ' …' : firstLine
}

function Highlight({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>
  const idx = text.toLowerCase().indexOf(query.toLowerCase())
  if (idx === -1) return <>{text}</>
  return (
    <>
      {text.slice(0, idx)}
      <mark className="rounded-sm bg-yellow-400/30 px-0.5 text-yellow-200 not-italic">
        {text.slice(idx, idx + query.length)}
      </mark>
      {text.slice(idx + query.length)}
    </>
  )
}

/** 시나리오가 쿼리와 일치하는지, 몇 개의 스텝이 일치하는지 반환 */
function matchScenario(s: Scenario, q: string): { matches: boolean; stepCount: number } {
  const ql = q.toLowerCase()
  const titleMatch =
    s.title.toLowerCase().includes(ql) || s.summary.toLowerCase().includes(ql)
  const matchedSteps = s.steps.filter(
    (step) =>
      step.title.toLowerCase().includes(ql) ||
      step.command.toLowerCase().includes(ql) ||
      step.desc.toLowerCase().includes(ql)
  )
  return { matches: titleMatch || matchedSteps.length > 0, stepCount: matchedSteps.length }
}

export default function ScenarioPanel({ connected, onRun, onClose }: ScenarioPanelProps) {
  const [selectedId, setSelectedId] = useState(SCENARIOS[0].id)
  const [copied, setCopied] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())
  const [phModal, setPhModal] = useState<{ command: string; placeholders: string[] } | null>(null)
  const [phValues, setPhValues] = useState<Record<string, string>>({})
  const stepsRef = useRef<HTMLDivElement>(null)
  // 시나리오 목록(좌측) 너비 — 드래그로 조절, localStorage 보존
  const [listWidth, setListWidth] = useState(() => Number(localStorage.getItem('scenario_list_width')) || 208)
  const listWidthRef = useRef(listWidth)
  const listDragRef = useRef(false)
  const bodyRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!listDragRef.current) return
      const el = bodyRef.current
      if (!el) return
      const r = el.getBoundingClientRect()
      const w = Math.max(140, Math.min(420, e.clientX - r.left))
      listWidthRef.current = w
      setListWidth(w)
    }
    const onUp = () => {
      if (!listDragRef.current) return
      listDragRef.current = false
      document.body.style.cursor = ''
      localStorage.setItem('scenario_list_width', String(Math.round(listWidthRef.current)))
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [])

  const openPlaceholderModal = (command: string) => {
    const placeholders = extractPlaceholders(command)
    setPhModal({ command, placeholders })
    setPhValues(Object.fromEntries(placeholders.map((p) => [p, ''])))
  }

  const submitPlaceholders = () => {
    if (!phModal) return
    const filled = fillPlaceholders(phModal.command, phValues)
    onRun(filled, true)
    setPhModal(null)
  }

  const allPhFilled = phModal
    ? phModal.placeholders.every((p) => phValues[p]?.trim())
    : false

  const toggleGroup = (solution: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(solution)) next.delete(solution)
      else next.add(solution)
      return next
    })
  }

  const trimmed = query.trim()

  const groups = useMemo(() => {
    const map = new Map<string, Scenario[]>()
    for (const s of SCENARIOS) {
      const arr = map.get(s.solution) ?? []
      arr.push(s)
      map.set(s.solution, arr)
    }
    return Array.from(map, ([solution, scenarios]) => ({ solution, scenarios }))
  }, [])

  // 검색 시 필터링된 시나리오 목록
  const filteredGroups = useMemo(() => {
    if (!trimmed) return groups
    return groups
      .map((g) => ({
        ...g,
        scenarios: g.scenarios.filter((s) => matchScenario(s, trimmed).matches),
      }))
      .filter((g) => g.scenarios.length > 0)
  }, [trimmed, groups])

  // 검색 결과에서 현재 선택된 항목이 없으면 첫 번째로 이동
  const effectiveId = useMemo(() => {
    if (!trimmed) return selectedId
    const allFiltered = filteredGroups.flatMap((g) => g.scenarios)
    if (allFiltered.some((s) => s.id === selectedId)) return selectedId
    return allFiltered[0]?.id ?? selectedId
  }, [trimmed, filteredGroups, selectedId])

  const scenario = SCENARIOS.find((s) => s.id === effectiveId) ?? SCENARIOS[0]

  useEffect(() => {
    stepsRef.current?.scrollTo({ top: 0 })
  }, [effectiveId])

  const copy = async (key: string, text?: string) => {
    try {
      await navigator.clipboard.writeText(text ?? key)
      setCopied(key)
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500)
    } catch { /* 무시 */ }
  }

  return (
    <div className="flex h-full flex-col border-b border-white/10 bg-panel">
      {/* 검색 바 */}
      <div className="flex items-center gap-2 border-b border-white/10 px-2.5 py-1.5">
        <Search size={13} className="shrink-0 text-gray-500" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="시나리오, 명령어, 설명 검색..."
          className="min-w-0 flex-1 bg-transparent text-[12px] text-gray-200 outline-none placeholder:text-gray-600"
        />
        {trimmed ? (
          <button
            onClick={() => setQuery('')}
            className="shrink-0 text-gray-500 hover:text-gray-300"
          >
            <X size={13} />
          </button>
        ) : (
          <button
            onClick={onClose}
            title="시나리오 닫기"
            className="shrink-0 text-gray-500 hover:text-gray-300"
          >
            <X size={14} />
          </button>
        )}
      </div>

      {/* 본문: 좌측 목록 + 우측 상세 */}
      <div ref={bodyRef} className="flex min-w-0 flex-1 overflow-hidden">
        {/* 시나리오 목록 */}
        <div style={{ width: listWidth }} className="shrink-0 overflow-y-auto py-2">
          {filteredGroups.length === 0 ? (
            <p className="px-3 py-4 text-center text-[11px] text-gray-500">일치 없음</p>
          ) : (
            filteredGroups.map((g) => {
              const collapsed = !trimmed && collapsedGroups.has(g.solution)
              return (
              <div key={g.solution} className="mb-1">
                <button
                  onClick={() => toggleGroup(g.solution)}
                  className="flex w-full items-center gap-1 px-3 py-1 text-left text-[10px] font-semibold text-blue-300/80 hover:text-blue-200"
                >
                  <ChevronDown
                    size={11}
                    className={'shrink-0 transition-transform ' + (collapsed ? '-rotate-90' : '')}
                  />
                  {g.solution}
                </button>
                {!collapsed && g.scenarios.map((s) => {
                  const { stepCount } = trimmed ? matchScenario(s, trimmed) : { stepCount: 0 }
                  return (
                    <button
                      key={s.id}
                      onClick={() => setSelectedId(s.id)}
                      className={
                        'mx-1 flex w-[calc(100%-0.5rem)] items-start gap-1 rounded-md px-2.5 py-1.5 text-left text-[12px] leading-snug transition ' +
                        (s.id === effectiveId
                          ? 'bg-blue-600/30 font-medium text-blue-100'
                          : 'text-gray-300 hover:bg-white/5')
                      }
                    >
                      <span className="flex-1">{s.title}</span>
                      {trimmed && stepCount > 0 && (
                        <span className="mt-0.5 shrink-0 rounded bg-yellow-500/20 px-1 text-[10px] text-yellow-300">
                          {stepCount}
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>
              )
            })
          )}
        </div>

        <div
          onMouseDown={() => {
            listDragRef.current = true
            document.body.style.cursor = 'col-resize'
          }}
          title="드래그하여 목록 너비 조절"
          className="w-1 shrink-0 cursor-col-resize bg-white/10 hover:bg-blue-400/50"
        />

        {/* 선택한 시나리오의 단계 */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-start gap-2 border-b border-white/10 px-3 py-2">
            <ListChecks size={15} className="mt-0.5 shrink-0 text-blue-300" />
            <div className="min-w-0">
              <div className="text-[13px] font-semibold text-gray-100">{scenario.title}</div>
              <div className="text-[11px] leading-relaxed text-gray-400">{scenario.summary}</div>
            </div>
          </div>

          {!connected && (
            <div className="bg-amber-500/10 px-3 py-1 text-[11px] text-amber-300">
              SSH 연결 후 단계를 실행할 수 있습니다. (복사는 지금도 가능)
            </div>
          )}

          <div ref={stepsRef} className="flex-1 space-y-2 overflow-y-auto p-2.5">
            {scenario.steps.map((step, idx) => {
              const ph = hasPlaceholder(step.command)
              // 검색 중일 때 해당 스텝이 일치하는지
              const stepMatches =
                trimmed &&
                (step.title.toLowerCase().includes(trimmed.toLowerCase()) ||
                  step.command.toLowerCase().includes(trimmed.toLowerCase()) ||
                  step.desc.toLowerCase().includes(trimmed.toLowerCase()))
              return (
                <div
                  key={idx}
                  className={
                    'flex gap-2.5' +
                    (stepMatches ? ' rounded-md ring-1 ring-yellow-500/30' : '')
                  }
                >
                  <div className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-blue-600/40 text-[11px] font-semibold text-blue-100">
                    {idx + 1}
                  </div>
                  <div className="min-w-0 flex-1 rounded-md border border-white/10 bg-panel-light p-2">
                    <div className="flex items-center gap-2">
                      <span className="shrink-0 text-[13px] font-medium text-gray-100">
                        <Highlight text={step.title} query={trimmed} />
                      </span>
                      {step.command && (
                        <>
                          <code
                            title={step.command}
                            className="min-w-0 flex-1 truncate rounded bg-black/40 px-1.5 py-0.5 font-mono text-[11px] text-pink-200"
                          >
                            <Highlight text={commandPreview(step.command)} query={trimmed} />
                          </code>
                          <div className="flex shrink-0 items-center gap-1">
                            <button
                              onClick={() => copy(step.command)}
                              title="명령어 복사"
                              className="rounded p-1 text-gray-400 hover:bg-white/10 hover:text-gray-200"
                            >
                              {copied === step.command ? (
                                <Check size={13} className="text-green-400" />
                              ) : (
                                <Copy size={13} />
                              )}
                            </button>
                            <button
                              onClick={() =>
                                ph ? openPlaceholderModal(step.command) : onRun(step.command, true)
                              }
                              disabled={!connected}
                              title={
                                !connected
                                  ? 'SSH 연결 필요'
                                  : ph
                                    ? '<...> 값을 입력받아 치환 후 실행'
                                    : '터미널에서 실행'
                              }
                              className={
                                'flex items-center gap-1 rounded px-2 py-1 text-[11px] text-white disabled:cursor-not-allowed disabled:opacity-40 ' +
                                (ph ? 'bg-amber-600/80 hover:bg-amber-500' : 'bg-blue-600/80 hover:bg-blue-500')
                              }
                            >
                              {ph ? <CornerDownLeft size={11} /> : <Play size={11} />}
                              {ph ? '입력' : '실행'}
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                    <p className="mt-1 text-[11px] leading-relaxed text-gray-400">
                      <Highlight text={step.desc} query={trimmed} />
                    </p>
                    {step.info && (
                      <p className="mt-1 whitespace-pre-line rounded bg-blue-500/10 px-1.5 py-1 text-[11px] leading-relaxed text-blue-300/90">
                        {step.info}
                      </p>
                    )}
                    {step.warn && (
                      <p className="mt-1 flex items-start gap-1.5 whitespace-pre-line rounded border border-red-500/30 bg-red-500/15 px-1.5 py-1 text-[11px] font-medium leading-relaxed text-red-300">
                        <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                        <span>{step.warn}</span>
                      </p>
                    )}
                    {step.code && (
                      <details className="group mt-1.5 overflow-hidden rounded border border-emerald-500/25">
                        <summary className="flex cursor-pointer select-none list-none items-center gap-1.5 bg-emerald-500/10 px-2 py-1 text-[11px] font-medium text-emerald-400/80 hover:bg-emerald-500/15 hover:text-emerald-300 group-open:border-b group-open:border-emerald-500/20">
                          <span>입력 예시</span>
                          <button
                            onClick={(e) => { e.preventDefault(); copy('code-' + idx, step.code) }}
                            title="내용 복사"
                            className="ml-auto rounded p-0.5 text-emerald-500/60 hover:bg-emerald-500/20 hover:text-emerald-300"
                          >
                            {copied === 'code-' + idx
                              ? <Check size={11} className="text-green-400" />
                              : <Copy size={11} />}
                          </button>
                          <span className="font-mono text-[9px] text-emerald-500/60 group-open:hidden">펼치기 ▾</span>
                          <span className="hidden font-mono text-[9px] text-emerald-500/60 group-open:inline">접기 ▴</span>
                        </summary>
                        <pre className="overflow-x-auto whitespace-pre bg-black/40 px-3 py-2 font-mono text-[10px] leading-relaxed text-green-300/85">
                          {step.code}
                        </pre>
                      </details>
                    )}
                    {step.note && (
                      <p className="mt-1 whitespace-pre-line rounded bg-amber-500/10 px-1.5 py-1 text-[11px] leading-relaxed text-amber-300/90">
                        {step.note}
                      </p>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>

      {/* 플레이스홀더 값 입력 후 치환 실행 모달 */}
      {phModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
          onClick={() => setPhModal(null)}
        >
          <div
            className="w-full max-w-sm rounded-lg border border-white/10 bg-panel p-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setPhModal(null)
              if (e.key === 'Enter' && allPhFilled) submitPlaceholders()
            }}
          >
            <div className="mb-3 text-sm font-semibold text-gray-100">값 입력</div>
            <div className="space-y-2">
              {phModal.placeholders.map((p, i) => (
                <div key={p}>
                  <label className="mb-1 block text-[11px] text-gray-400">{p}</label>
                  <input
                    autoFocus={i === 0}
                    value={phValues[p] ?? ''}
                    onChange={(e) => setPhValues((v) => ({ ...v, [p]: e.target.value }))}
                    className="w-full rounded-md border border-white/10 bg-panel-light px-2.5 py-1.5 text-[12px] text-gray-200 outline-none focus:ring-1 focus:ring-blue-500"
                  />
                </div>
              ))}
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setPhModal(null)}
                className="rounded px-3 py-1.5 text-xs text-gray-400 hover:text-gray-200"
              >
                취소
              </button>
              <button
                onClick={submitPlaceholders}
                disabled={!allPhFilled}
                className="rounded bg-blue-600/80 px-3 py-1.5 text-xs text-white disabled:cursor-not-allowed disabled:opacity-40 hover:bg-blue-500"
              >
                치환 후 실행
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
