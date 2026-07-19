import { useMemo, useRef, useState, useEffect } from 'react'
import {
  Play,
  CornerDownLeft,
  Copy,
  Check,
  X,
  ListChecks,
  Search,
  ChevronDown,
  ChevronUp,
  AlertTriangle,
  Plus,
  Pencil,
  Trash2,
} from 'lucide-react'
import { SCENARIOS, type Scenario } from '../scenarios'
import type { CustomScenario, CustomScenarioStep } from '../../electron/shared-types'
import AutocompleteInput from './AutocompleteInput'
import ConfirmDialog from './ConfirmDialog'
import { computeMoveOrder, computeInsertBeforeOrder, computeAppendOrder } from '../lib/orderedMerge'

interface ScenarioPanelProps {
  connected: boolean
  onRun: (cmd: string, execute: boolean) => void
  onClose: () => void
}

/**
 * 사용자 정의 시나리오는 내장 Scenario 와 구조가 같아 그대로 병합 가능 — custom 플래그와
 * order(병합 정렬 기준값: 내장=배열 인덱스, 사용자 정의=저장된 값)만 덧붙임.
 */
type PanelScenario = Scenario & { custom?: boolean; order: number }

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
  // 사용자 정의 시나리오(런타임 추가) — 메인 프로세스에 JSON 으로 저장, 내장 SCENARIOS 와 병합해 표시
  const [customScenarios, setCustomScenarios] = useState<CustomScenario[]>([])
  const [editing, setEditing] = useState<PanelScenario | 'new' | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; title: string } | null>(null)
  // 드래그앤드롭 이동 — 사용자 정의 항목만 드래그 가능, 내장/사용자 정의 항목 모두 드롭 대상 가능
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [overKey, setOverKey] = useState<string | null>(null)

  useEffect(() => {
    window.electronAPI.customScenariosList().then(setCustomScenarios)
  }, [])

  const allScenarios = useMemo<PanelScenario[]>(
    () => [
      ...SCENARIOS.map((s, i): PanelScenario => ({ ...s, order: i })),
      ...customScenarios.map((s): PanelScenario => ({ ...s, custom: true, order: s.order ?? Date.now() })),
    ],
    [customScenarios],
  )

  const saveCustomScenario = async (item: CustomScenario) => {
    const list = await window.electronAPI.customScenariosUpsert(item)
    setCustomScenarios(list)
    setSelectedId(item.id || list[list.length - 1]?.id)
    setEditing(null)
  }
  const deleteCustomScenario = async (id: string) => {
    const list = await window.electronAPI.customScenariosDelete(id)
    setCustomScenarios(list)
    if (selectedId === id) setSelectedId(SCENARIOS[0].id)
  }
  /** 병합·정렬된 순서 그대로의 형제 목록 (내장+사용자 정의 전부, 해당 카테고리) */
  const siblingsOf = (sol: string): PanelScenario[] =>
    allScenarios.filter((s) => s.solution === sol).sort((a, b) => a.order - b.order)

  // 화살표: 병합된 전체 목록 안에서 한 칸 이동 (내장 항목을 넘어서도 이동 가능)
  const moveCustomScenario = async (sol: string, id: string, dir: -1 | 1) => {
    const merged = siblingsOf(sol)
    const idx = merged.findIndex((s) => s.id === id)
    if (idx < 0) return
    const newOrder = computeMoveOrder(merged, idx, dir)
    if (newOrder === null) return
    const item = customScenarios.find((s) => s.id === id)
    if (!item) return
    const list = await window.electronAPI.customScenariosUpsert({ ...item, order: newOrder })
    setCustomScenarios(list)
  }
  // 드래그앤드롭: targetSol 의 beforeIdx 앞에 끼워넣기 (다른 카테고리로도 이동 가능)
  const dropCustomScenarioBefore = async (id: string, targetSol: string, beforeIdx: number) => {
    const merged = siblingsOf(targetSol).filter((s) => s.id !== id)
    const newOrder = computeInsertBeforeOrder(merged, beforeIdx)
    const item = customScenarios.find((s) => s.id === id)
    if (!item) return
    const list = await window.electronAPI.customScenariosUpsert({ ...item, solution: targetSol, order: newOrder })
    setCustomScenarios(list)
  }
  // 드래그앤드롭: 카테고리 헤더에 드롭 — 그 카테고리 맨 끝으로 이동
  const dropCustomScenarioAppend = async (id: string, targetSol: string) => {
    const merged = siblingsOf(targetSol).filter((s) => s.id !== id)
    const newOrder = computeAppendOrder(merged)
    const item = customScenarios.find((s) => s.id === id)
    if (!item) return
    const list = await window.electronAPI.customScenariosUpsert({ ...item, solution: targetSol, order: newOrder })
    setCustomScenarios(list)
  }
  // 값 입력 인라인 영역 — 어느 스텝(key) 아래에 펼쳐져 있는지 + 그 명령어/플레이스홀더 목록
  const [openPh, setOpenPh] = useState<{ key: string; command: string; placeholders: string[] } | null>(null)
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

  // 같은 스텝을 다시 누르면 접고, 다른 스텝이면 그걸로 교체해서 펼침
  const togglePlaceholderInput = (key: string, command: string) => {
    if (openPh?.key === key) {
      setOpenPh(null)
      return
    }
    const placeholders = extractPlaceholders(command)
    setOpenPh({ key, command, placeholders })
    setPhValues(Object.fromEntries(placeholders.map((p) => [p, ''])))
  }

  // 값을 안 채운 플레이스홀더는 원문 <...> 그대로 남겨 기본 명령어로 실행됨 (fillPlaceholders 참고)
  const submitPlaceholders = () => {
    if (!openPh) return
    const filled = fillPlaceholders(openPh.command, phValues)
    onRun(filled, true)
    setOpenPh(null)
  }

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
    const map = new Map<string, PanelScenario[]>()
    for (const s of allScenarios) {
      const arr = map.get(s.solution) ?? []
      arr.push(s)
      map.set(s.solution, arr)
    }
    for (const arr of map.values()) arr.sort((a, b) => a.order - b.order)
    return Array.from(map, ([solution, scenarios]) => ({ solution, scenarios }))
  }, [allScenarios])

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

  const scenario = allScenarios.find((s) => s.id === effectiveId) ?? allScenarios[0]

  const solutionOptions = useMemo(() => Array.from(new Set(allScenarios.map((s) => s.solution))), [allScenarios])

  useEffect(() => {
    stepsRef.current?.scrollTo({ top: 0 })
    setOpenPh(null) // 시나리오 전환 시 이전 스텝의 값 입력 영역은 닫음
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
          <>
            <button
              onClick={() => setEditing('new')}
              title="사용자 정의 시나리오 추가"
              className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-emerald-300 hover:bg-emerald-500/10"
            >
              <Plus size={13} />
              추가
            </button>
            <button
              onClick={onClose}
              title="시나리오 닫기"
              className="shrink-0 text-gray-500 hover:text-gray-300"
            >
              <X size={14} />
            </button>
          </>
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
                  onDragOver={(e) => {
                    if (!draggingId) return
                    e.preventDefault()
                    e.dataTransfer.dropEffect = 'move'
                    if (overKey !== 'cat-' + g.solution) setOverKey('cat-' + g.solution)
                  }}
                  onDragLeave={() => setOverKey((k) => (k === 'cat-' + g.solution ? null : k))}
                  onDrop={(e) => {
                    e.preventDefault()
                    const id = e.dataTransfer.getData('text/plain')
                    setOverKey(null)
                    setDraggingId(null)
                    if (id) dropCustomScenarioAppend(id, g.solution)
                  }}
                  title={draggingId ? `"${g.solution}" 카테고리 맨 끝으로 이동` : undefined}
                  className={
                    'flex w-full items-center gap-1 px-3 py-1 text-left text-[10px] font-semibold transition ' +
                    (overKey === 'cat-' + g.solution
                      ? 'bg-blue-500/20 text-blue-200 ring-1 ring-blue-400'
                      : 'text-blue-300/80 hover:text-blue-200')
                  }
                >
                  <ChevronDown
                    size={11}
                    className={'shrink-0 transition-transform ' + (collapsed ? '-rotate-90' : '')}
                  />
                  {g.solution}
                </button>
                {!collapsed && g.scenarios.map((s, idx) => {
                  const { stepCount } = trimmed ? matchScenario(s, trimmed) : { stepCount: 0 }
                  const rowKey = 'scn-' + s.id
                  return (
                    <div
                      key={s.id}
                      draggable={!!s.custom}
                      onDragStart={(e) => {
                        e.dataTransfer.effectAllowed = 'move'
                        e.dataTransfer.setData('text/plain', s.id)
                        setDraggingId(s.id)
                      }}
                      onDragEnd={() => {
                        setDraggingId(null)
                        setOverKey(null)
                      }}
                      onDragOver={(e) => {
                        if (!draggingId || draggingId === s.id) return
                        e.preventDefault()
                        e.dataTransfer.dropEffect = 'move'
                        if (overKey !== rowKey) setOverKey(rowKey)
                      }}
                      onDragLeave={() => setOverKey((k) => (k === rowKey ? null : k))}
                      onDrop={(e) => {
                        e.preventDefault()
                        const id = e.dataTransfer.getData('text/plain')
                        setOverKey(null)
                        setDraggingId(null)
                        if (id && id !== s.id) dropCustomScenarioBefore(id, g.solution, idx)
                      }}
                      title={s.custom ? '드래그해서 순서/카테고리 이동' : undefined}
                      className={
                        'group mx-1 flex w-[calc(100%-0.5rem)] items-start gap-1 rounded-md text-left text-[12px] leading-snug transition ' +
                        (overKey === rowKey
                          ? 'ring-1 ring-blue-400'
                          : s.id === effectiveId
                            ? 'bg-blue-600/30 font-medium text-blue-100'
                            : 'text-gray-300 hover:bg-white/5') +
                        (s.custom ? ' cursor-grab active:cursor-grabbing' : '')
                      }
                    >
                      <button onClick={() => setSelectedId(s.id)} className="min-w-0 flex-1 px-2.5 py-1.5 text-left">
                        <span className="flex-1">{s.title}</span>
                        {trimmed && stepCount > 0 && (
                          <span className="ml-1 mt-0.5 shrink-0 rounded bg-yellow-500/20 px-1 text-[10px] text-yellow-300">
                            {stepCount}
                          </span>
                        )}
                      </button>
                      {s.custom && (
                        <div className="flex shrink-0 items-center gap-0.5 pr-1 pt-1 opacity-0 group-hover:opacity-100">
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              moveCustomScenario(g.solution, s.id, -1)
                            }}
                            disabled={idx <= 0}
                            title="위로 이동"
                            className="rounded p-0.5 text-gray-400 hover:bg-white/10 hover:text-gray-200 disabled:opacity-20"
                          >
                            <ChevronUp size={12} />
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              moveCustomScenario(g.solution, s.id, 1)
                            }}
                            disabled={idx >= g.scenarios.length - 1}
                            title="아래로 이동"
                            className="rounded p-0.5 text-gray-400 hover:bg-white/10 hover:text-gray-200 disabled:opacity-20"
                          >
                            <ChevronDown size={12} />
                          </button>
                        </div>
                      )}
                    </div>
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
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="text-[13px] font-semibold text-gray-100">{scenario.title}</span>
                {scenario.custom && (
                  <span className="rounded bg-emerald-600/20 px-1.5 py-0.5 text-[10px] text-emerald-300">
                    사용자 정의
                  </span>
                )}
              </div>
              <div className="text-[11px] leading-relaxed text-gray-400">{scenario.summary}</div>
            </div>
            {scenario.custom && (
              <div className="flex shrink-0 items-center gap-1">
                <button
                  onClick={() => setEditing(scenario)}
                  title="편집"
                  className="rounded p-1 text-gray-400 hover:bg-white/10 hover:text-gray-200"
                >
                  <Pencil size={14} />
                </button>
                <button
                  onClick={() => setConfirmDelete({ id: scenario.id, title: scenario.title })}
                  title="삭제"
                  className="rounded p-1 text-gray-400 hover:bg-red-500/20 hover:text-red-300"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            )}
          </div>

          {!connected && (
            <div className="bg-amber-500/10 px-3 py-1 text-[11px] text-amber-300">
              SSH 연결 후 단계를 실행할 수 있습니다. (복사는 지금도 가능)
            </div>
          )}

          <div ref={stepsRef} className="flex-1 space-y-2 overflow-y-auto p-2.5">
            {scenario.steps.map((step, idx) => {
              const ph = hasPlaceholder(step.command)
              const rowKey = `${effectiveId}-${idx}`
              const isOpenPh = openPh?.key === rowKey
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
                                ph
                                  ? togglePlaceholderInput(rowKey, step.command)
                                  : onRun(step.command, true)
                              }
                              disabled={!connected}
                              title={
                                !connected
                                  ? 'SSH 연결 필요'
                                  : ph
                                    ? '값 입력란 펼치기 (비워두면 기본 명령어 그대로 실행)'
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
                    {isOpenPh && openPh && (
                      <div className="mt-1.5 space-y-1.5 rounded-md border border-amber-500/30 bg-amber-500/5 p-2">
                        {openPh.placeholders.map((p, i) => (
                          <div key={p}>
                            <label className="mb-1 block break-words text-[11px] text-gray-400">
                              {p} 입력 :
                            </label>
                            <input
                              autoFocus={i === 0}
                              value={phValues[p] ?? ''}
                              onChange={(e) => setPhValues((v) => ({ ...v, [p]: e.target.value }))}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') submitPlaceholders()
                                if (e.key === 'Escape') setOpenPh(null)
                              }}
                              placeholder="비워두면 기본 명령어 그대로 실행"
                              className="w-full rounded-md border border-white/10 bg-panel-light px-2 py-1 text-[12px] text-gray-200 outline-none placeholder:text-gray-600 focus:ring-1 focus:ring-blue-500"
                            />
                          </div>
                        ))}
                        <div className="flex justify-end gap-2 pt-0.5">
                          <button
                            onClick={() => setOpenPh(null)}
                            className="rounded px-2 py-1 text-[11px] text-gray-400 hover:text-gray-200"
                          >
                            취소
                          </button>
                          <button
                            onClick={submitPlaceholders}
                            className="rounded bg-blue-600/80 px-2.5 py-1 text-[11px] text-white hover:bg-blue-500"
                          >
                            치환 후 실행
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>

      {editing && (
        <ScenarioEditorModal
          initial={editing === 'new' ? null : editing}
          solutions={solutionOptions}
          onCancel={() => setEditing(null)}
          onSave={saveCustomScenario}
        />
      )}

      {confirmDelete && (
        <ConfirmDialog
          title="시나리오 삭제"
          message={`"${confirmDelete.title}" 시나리오를 삭제할까요?`}
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => {
            deleteCustomScenario(confirmDelete.id)
            setConfirmDelete(null)
          }}
        />
      )}
    </div>
  )
}

const emptyStep = (): CustomScenarioStep => ({ title: '', command: '', desc: '' })

// ── 사용자 정의 시나리오 추가/편집 모달 ───────────────────────
function ScenarioEditorModal({
  initial,
  solutions,
  onCancel,
  onSave,
}: {
  initial: PanelScenario | null
  solutions: string[]
  onCancel: () => void
  onSave: (item: CustomScenario) => void
}) {
  const [solutionVal, setSolutionVal] = useState(initial?.solution ?? solutions[0] ?? '')
  const [title, setTitle] = useState(initial?.title ?? '')
  const [summary, setSummary] = useState(initial?.summary ?? '')
  const [steps, setSteps] = useState<CustomScenarioStep[]>(
    initial?.steps?.length ? initial.steps.map((s) => ({ ...s })) : [emptyStep()],
  )
  const [err, setErr] = useState('')

  const inputCls =
    'w-full rounded-md border border-white/10 bg-panel-light px-2.5 py-1.5 text-[13px] text-gray-100 ' +
    'placeholder:text-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-500'

  const patchStep = (i: number, patch: Partial<CustomScenarioStep>) =>
    setSteps((arr) => arr.map((s, idx) => (idx === i ? { ...s, ...patch } : s)))
  const addStep = () => setSteps((arr) => [...arr, emptyStep()])
  const removeStep = (i: number) => setSteps((arr) => arr.filter((_, idx) => idx !== i))

  const submit = () => {
    if (!solutionVal.trim() || !title.trim() || !summary.trim()) {
      setErr('카테고리 · 제목 · 요약은 필수입니다.')
      return
    }
    const cleanSteps = steps
      .map((s) => ({
        title: s.title.trim(),
        command: s.command.trim(),
        desc: s.desc.trim(),
        note: s.note?.trim() || undefined,
        info: s.info?.trim() || undefined,
        warn: s.warn?.trim() || undefined,
        code: s.code?.trim() || undefined,
      }))
      .filter((s) => s.title || s.command || s.desc)
    if (!cleanSteps.length) {
      setErr('최소 1개 이상의 단계를 입력하세요.')
      return
    }
    onSave({
      id: initial?.id ?? '',
      solution: solutionVal.trim(),
      title: title.trim(),
      summary: summary.trim(),
      steps: cleanSteps,
      // 편집 시 기존 순서를 그대로 유지 (신규 추가는 undefined → 메인에서 생성 시각으로 기본값 지정)
      order: initial?.order,
    })
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      onClick={onCancel}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-lg border border-white/10 bg-panel p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 shrink-0 text-sm font-semibold text-gray-100">
          {initial ? '시나리오 편집' : '사용자 정의 시나리오 추가'}
        </div>
        <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto pr-1">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="mb-1 block text-[11px] text-gray-400">카테고리</label>
              <AutocompleteInput
                value={solutionVal}
                onChange={setSolutionVal}
                options={solutions}
                placeholder="기존 선택 또는 새로 입력"
                className={inputCls}
                newLabel="카테고리"
              />
            </div>
            <div>
              <label className="mb-1 block text-[11px] text-gray-400">제목</label>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="예: [K8s] 파드 재기동 검증"
                className={inputCls}
              />
            </div>
          </div>
          <div>
            <label className="mb-1 block text-[11px] text-gray-400">요약</label>
            <input
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              placeholder="이 시나리오가 검증하는 내용을 한 줄로"
              className={inputCls}
            />
          </div>

          <div className="pt-1">
            <div className="mb-1.5 flex items-center justify-between">
              <label className="text-[11px] text-gray-400">단계</label>
              <button
                onClick={addStep}
                className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-emerald-300 hover:bg-emerald-500/10"
              >
                <Plus size={12} />
                단계 추가
              </button>
            </div>
            <div className="space-y-2">
              {steps.map((s, i) => (
                <div key={i} className="rounded-md border border-white/10 bg-panel-light p-2">
                  <div className="mb-1.5 flex items-center gap-2">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-blue-600/40 text-[11px] font-semibold text-blue-100">
                      {i + 1}
                    </span>
                    <input
                      value={s.title}
                      onChange={(e) => patchStep(i, { title: e.target.value })}
                      placeholder="단계 제목"
                      className={inputCls}
                    />
                    <button
                      onClick={() => removeStep(i)}
                      title="단계 삭제"
                      className="shrink-0 rounded p-1 text-gray-400 hover:bg-red-500/20 hover:text-red-300"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                  <input
                    value={s.command}
                    onChange={(e) => patchStep(i, { command: e.target.value })}
                    placeholder="명령어 (선택 — 안내만 있는 단계는 비워둘 수 있음)"
                    className={inputCls + ' mb-1.5 font-mono'}
                  />
                  <input
                    value={s.desc}
                    onChange={(e) => patchStep(i, { desc: e.target.value })}
                    placeholder="이 단계에 대한 설명"
                    className={inputCls}
                  />
                </div>
              ))}
            </div>
          </div>
          {err && <p className="text-[11px] text-red-400">{err}</p>}
        </div>
        <div className="mt-4 flex shrink-0 justify-end gap-2">
          <button
            onClick={onCancel}
            className="rounded-md border border-white/10 bg-panel-light px-3 py-1.5 text-xs text-gray-200 hover:bg-white/10"
          >
            취소
          </button>
          <button
            onClick={submit}
            className="rounded-md bg-blue-600/80 px-3 py-1.5 text-xs text-white hover:bg-blue-500"
          >
            저장
          </button>
        </div>
      </div>
    </div>
  )
}
