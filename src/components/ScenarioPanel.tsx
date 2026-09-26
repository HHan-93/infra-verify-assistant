import { useMemo, useRef, useState, useEffect } from 'react'
import {
  Play,
  CornerDownLeft,
  Copy,
  Check,
  X,
  ListChecks,
  ClipboardCheck,
  Search,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  AlertTriangle,
  Plus,
  Pencil,
  Trash2,
  History,
} from 'lucide-react'
import { SCENARIOS, type Scenario, type ScenarioStep } from '../scenarios'
import type {
  CustomScenario,
  CustomScenarioStep,
  CaptureRule,
  ExpectRule,
  OnFailureAction,
} from '../../electron/shared-types'
import AutocompleteInput from './AutocompleteInput'
import ConfirmDialog from './ConfirmDialog'
import CustomItemsMenu from './CustomItemsMenu'
import ScenarioHistoryModal from './ScenarioHistoryModal'
import { splitShell } from '../lib/shellSplit'
import { computeMoveOrder, computeInsertBeforeOrder, computeAppendOrder } from '../lib/orderedMerge'
import { extractPlaceholders, fillPlaceholders, hasPlaceholder } from '../lib/placeholder'

interface ScenarioPanelProps {
  connected: boolean
  onRun: (cmd: string, execute: boolean) => void
  onClose: () => void
  /** 시나리오를 검증 러너로 실행 (순차 실행 + 자동 판정 + 리포트) */
  onRunScenario?: (scenario: {
    /** 이력에서 같은 시나리오의 회차끼리 묶는 기준 */
    id: string
    title: string
    summary: string
    steps: ScenarioStep[]
    /** 입력값 ← 역할 주소 자동 채움 규칙 (러너가 역할 매핑에서 값을 끌어온다) */
    roleValues?: Record<string, string>
    /** 진단형 — 검증 창에서도 같은 표시를 띄운다 (scenarios.ts 의 주석 참고) */
    diagnostic?: boolean
  }) => void
}

/**
 * 사용자 정의 시나리오는 내장 Scenario 와 구조가 같아 그대로 병합 가능 — custom 플래그와
 * order(병합 정렬 기준값: 내장=배열 인덱스, 사용자 정의=저장된 값)만 덧붙임.
 */
type PanelScenario = Scenario & { custom?: boolean; order: number }

// 자리표시자 규칙은 검증 러너·프리셋과 하나로 쓴다 (src/lib/placeholder.ts)

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

export default function ScenarioPanel({ connected, onRun, onClose, onRunScenario }: ScenarioPanelProps) {
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
  /**
   * 검증 이력 창.
   *
   * 여기(추가 왼쪽)에 두는 이유: 시나리오를 고르는 자리가 곧 "이 시나리오를 언제 어떻게
   * 돌렸나" 를 묻는 자리다. 러너 안에 두면 검증을 한 번 더 열어야 지난 회차를 볼 수 있다.
   */
  const [historyOpen, setHistoryOpen] = useState(false)
  /** 저장된 회차 수 — 이력이 쌓여 있다는 사실이 버튼에 보여야 눌러 볼 생각이 든다 */
  const [runCount, setRunCount] = useState(0)

  // 이력 창을 닫을 때도 다시 센다(그 안에서 지웠을 수 있다)
  useEffect(() => {
    if (historyOpen) return
    // 못 읽은 것과 '없는 것' 은 다르다 — 못 읽었으면 숫자를 지우지 않고 그대로 둔다
    // (0 으로 보이면 이력이 사라진 줄 알고 창을 열어 보지 않는다)
    void window.electronAPI.scenarioRunsList().then((r) => {
      if (r.ok) setRunCount(r.list.length)
    })
  }, [historyOpen])

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
  /**
   * 시나리오 복제 — 내장 시나리오는 자동 생성 파일이라 편집할 수 없다.
   * 판정 기준·원복 명령 같은 검증 옵션을 붙이려면 사용자 정의로 한 벌 떠서 고쳐야 한다.
   */
  const duplicateScenario = async (src: PanelScenario) => {
    const copy: CustomScenario = {
      id: '', // 메인에서 새로 발급
      solution: src.solution,
      title: `${src.title} (복사본)`,
      summary: src.summary,
      steps: src.steps.map((st) => ({
        title: st.title,
        command: st.command,
        desc: st.desc,
        note: st.note,
        info: st.info,
        warn: st.warn,
        code: st.code,
        needsInput: st.needsInput,
        manualOnly: st.manualOnly,
        check: st.check,
        target: st.target,
        capture: st.capture,
        expect: st.expect,
        onFailure: st.onFailure,
        onFailureCommand: st.onFailureCommand,
        onFailureDesc: st.onFailureDesc,
        undo: st.undo,
      })),
      roleValues: src.roleValues,
      order: computeAppendOrder(siblingsOf(src.solution)),
    }
    const list = await window.electronAPI.customScenariosUpsert(copy)
    setCustomScenarios(list)
    const added = list[list.length - 1]
    if (added) {
      setSelectedId(added.id)
      setEditing({ ...added, custom: true, order: added.order ?? Date.now() })
    }
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
  // 드래그앤드롭: targetSol 안에서 targetId 바로 앞에 끼워넣기 (다른 카테고리로도 이동 가능).
  // "드래그 대상을 뺀 목록" 안에서 targetId 의 위치를 직접 찾는다 — 호출부에서 미리 계산한
  // 인덱스(필터링 전 목록 기준)를 그대로 넘기면 필터링 후 하나씩 밀려 위치가 어긋난다(off-by-one).
  const dropCustomScenarioBefore = async (id: string, targetSol: string, targetId: string | null) => {
    const merged = siblingsOf(targetSol).filter((s) => s.id !== id)
    const beforeIdx = targetId ? merged.findIndex((s) => s.id === targetId) : -1
    const newOrder = computeInsertBeforeOrder(merged, beforeIdx < 0 ? merged.length : beforeIdx)
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
              onClick={() => setHistoryOpen(true)}
              title="지난 검증 회차 — 골라서 한 리포트로 뽑습니다"
              className="flex shrink-0 items-center gap-1 rounded border border-blue-500/35 bg-blue-500/10 px-1.5 py-0.5 text-[11px] text-blue-200 hover:bg-blue-500/20"
            >
              <History size={12} />
              이력
              {runCount > 0 && (
                <span className="rounded-full bg-blue-500/30 px-1.5 text-[9.5px] text-blue-50">{runCount}</span>
              )}
            </button>
            <button
              onClick={() => setEditing('new')}
              title="사용자 정의 시나리오 추가"
              className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-emerald-300 hover:bg-emerald-500/10"
            >
              <Plus size={13} />
              추가
            </button>
            <CustomItemsMenu
              onImported={() => window.electronAPI.customScenariosList().then(setCustomScenarios)}
            />
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
                        if (id && id !== s.id) dropCustomScenarioBefore(id, g.solution, s.id)
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
                {/* 판정 기준이 비어 있는 것이 **빠뜨린 것이 아니라 원래 그런 것**임을 밝힌다.
                    이 표시가 없으면 검증 회차의 '판정 없음' 이 결함처럼 읽힌다. */}
                {scenario.diagnostic && (
                  <span
                    title="원인을 좁히는 시나리오입니다. 무엇이 정상인지는 사람이 출력을 읽고 판단하므로 자동 판정하지 않습니다."
                    className="rounded bg-sky-500/15 px-1.5 py-0.5 text-[10px] text-sky-300"
                  >
                    진단형 · 자동 판정 없음
                  </span>
                )}
              </div>
              {/* 줄바꿈을 살린다 — 요약은 '무엇을 하는 시나리오인가' + '어떤 순서인가' 두 줄로 적는다.
                  한 덩어리로 흘려 쓰면 화면 폭에서 세 줄로 접히며 어디서 끊어 읽어야 할지 사라진다. */}
              <div className="whitespace-pre-line text-[11px] leading-relaxed text-gray-400">
                {scenario.summary}
              </div>
            </div>
            {onRunScenario && (
              <button
                onClick={() =>
                  onRunScenario({
                    id: scenario.id,
                    title: scenario.title,
                    summary: scenario.summary,
                    steps: scenario.steps,
                    roleValues: scenario.roleValues,
                    diagnostic: scenario.diagnostic,
                  })
                }
                disabled={!connected}
                title={connected ? '시나리오를 순차 실행하고 결과를 자동 판정' : 'SSH 연결 필요'}
                className="flex shrink-0 items-center gap-1 rounded-md border border-blue-500/40 bg-blue-600/20 px-2 py-1 text-[11px] text-blue-100 hover:bg-blue-600/30 disabled:opacity-40"
              >
                <ClipboardCheck size={13} /> 검증 실행
              </button>
            )}
            <button
              onClick={() => duplicateScenario(scenario)}
              title={
                scenario.custom
                  ? '이 시나리오를 복사해 새로 만듭니다'
                  : '내장 시나리오는 수정할 수 없습니다 — 복사본을 만들면 판정 기준·원복 명령을 넣을 수 있습니다'
              }
              className="flex shrink-0 items-center gap-1 rounded px-1.5 py-1 text-[11px] text-gray-400 hover:bg-white/10 hover:text-gray-200"
            >
              <Copy size={14} /> 복제
            </button>
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
                            {(() => {
                              // 버튼은 **아는 것만** 말한다.
                              //   needsInput  → 실행 뒤 터미널에서 사람이 입력해야 끝나는 단계 ('실행·입력')
                              //   warn 만 있음 → 주의 사항이 있을 뿐 입력은 없다 ('실행', 주황 + 경고 아이콘)
                              // 예전에는 warn 만 보고 입력이 필요하다고 추측해, "데이터가 지워집니다" 같은
                              // 단순 경고에까지 '실행·입력' 이 붙었다(사용자 지적). warn 스텝 36개 중 실제로
                              // 입력을 받는 것은 7개뿐이라, 나머지 29개는 받지도 않을 입력을 예고하고 있었다.
                              const needsInput = !ph && !!step.needsInput
                              const cautious = !ph && !!step.warn
                              return (
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
                                        ? '값 입력란 펼치기 (비우면 <이름> 이 치환되지 않고 그대로 남습니다)'
                                        : needsInput
                                          ? '실행 후 터미널에서 입력(Enter/비밀번호 등)이 필요합니다 — 아래 경고 확인'
                                          : cautious
                                            ? '주의 사항이 있는 단계입니다 — 아래 경고를 먼저 읽으세요'
                                            : '터미널에서 실행'
                                  }
                                  className={
                                    'flex items-center gap-1 rounded px-2 py-1 text-[11px] text-white disabled:cursor-not-allowed disabled:opacity-40 ' +
                                    (ph
                                      ? 'bg-amber-600/80 hover:bg-amber-500'
                                      : needsInput || cautious
                                        ? 'bg-orange-600/80 hover:bg-orange-500'
                                        : 'bg-blue-600/80 hover:bg-blue-500')
                                  }
                                >
                                  {ph ? (
                                    <CornerDownLeft size={11} />
                                  ) : needsInput || cautious ? (
                                    <AlertTriangle size={11} />
                                  ) : (
                                    <Play size={11} />
                                  )}
                                  {ph ? '입력' : needsInput ? '실행·입력' : '실행'}
                                </button>
                              )
                            })()}
                          </div>
                        </>
                      )}
                    </div>
                    {/* info·warn 과 같이 줄바꿈을 살린다 — 설명은 대개 '무엇을 하는가' 와
                        '결과에서 무엇을 보는가' 두 가지라, 그 경계에서 끊어 주면 읽는 속도가 다르다.
                        검증 창에서는 이 자리가 한 줄로 잘리므로(truncate) 첫 줄에 핵심을 둔다. */}
                    <p className="mt-1 whitespace-pre-line text-[11px] leading-relaxed text-gray-400">
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
                              placeholder="비우면 <이름> 이 그대로 남습니다"
                              className="w-full rounded-md border border-white/10 bg-panel-light px-2 py-1 text-[12px] text-gray-200 outline-none placeholder:text-gray-600 focus:ring-1 focus:ring-blue-500"
                            />
                          </div>
                        ))}
                        {/*
                          비운 칸은 자동으로 채워지지 않는다 — `<이름>` 이 **명령에 그대로 들어간다**.
                          힌트가 "비워두면 기본 명령어 그대로 실행" 이라 기본값이 들어오는 줄 알고
                          비워 둔 채 실행해, 설정 파일에 리터럴 `<공인IP>` 가 박힌 일이 있었다
                          (사용자 지적). 실행 직전에 몇 개가 비었는지 세어서 보여 준다.
                        */}
                        {(() => {
                          const blank = openPh.placeholders.filter((p) => !phValues[p]?.trim())
                          return (
                            <>
                              {blank.length > 0 && (
                                <p className="flex items-start gap-1.5 rounded border border-red-500/30 bg-red-500/10 px-1.5 py-1 text-[11px] leading-relaxed text-red-300">
                                  <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                                  <span>
                                    비운 칸 {blank.length}개 —{' '}
                                    <span className="font-mono">
                                      {blank.map((p) => `<${p}>`).join(' ')}
                                    </span>{' '}
                                    가 치환되지 않고 명령에 그대로 들어갑니다
                                  </span>
                                </p>
                              )}
                              <div className="flex justify-end gap-2 pt-0.5">
                                <button
                                  onClick={() => setOpenPh(null)}
                                  className="rounded px-2 py-1 text-[11px] text-gray-400 hover:text-gray-200"
                                >
                                  취소
                                </button>
                                <button
                                  onClick={submitPlaceholders}
                                  className={
                                    'rounded px-2.5 py-1 text-[11px] text-white ' +
                                    (blank.length > 0
                                      ? 'bg-orange-600/80 hover:bg-orange-500'
                                      : 'bg-blue-600/80 hover:bg-blue-500')
                                  }
                                >
                                  {blank.length > 0 ? '비운 채로 실행' : '치환 후 실행'}
                                </button>
                              </div>
                            </>
                          )
                        })()}
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>

      {/* 지금 고른 시나리오로 걸러 열어 준다 — 대개 "이것을 지난번엔 어땠나" 를 보러 온다.
          창 안에서 '모든 시나리오' 로 바꿀 수 있다. */}
      {historyOpen && (
        <ScenarioHistoryModal onClose={() => setHistoryOpen(false)} />
      )}

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
/** "a, b , c" → ["a","b","c"] (빈 항목 제거) */
const splitCsv = (v: string): string[] => v.split(',').map((x) => x.trim()).filter(Boolean)
/** 판정 기준이 하나라도 채워져 있는지 — 비어 있으면 저장하지 않는다(빈 객체가 남지 않게) */
const cleanCheck = (c?: CustomScenarioStep['check']): CustomScenarioStep['check'] => {
  if (!c) return undefined
  const out = {
    ...(c.passContains?.length ? { passContains: c.passContains } : {}),
    ...(c.failContains?.length ? { failContains: c.failContains } : {}),
    ...(c.passRegex?.trim() ? { passRegex: c.passRegex.trim() } : {}),
    ...(c.requireExitZero ? { requireExitZero: true } : {}),
  }
  return Object.keys(out).length ? out : undefined
}

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

  /**
   * 입력칸 공용 클래스. **폭은 여기서 정하지 않는다.**
   *
   * 예전에는 여기에 `w-full` 이 들어 있었는데, 사용처에서 `inputCls + ' w-32 '` 처럼 좁은 폭을
   * 덧붙여도 **적용되지 않았다** — 클래스 문자열의 순서는 우선순위와 무관하고, Tailwind 가
   * 만드는 CSS 에서 `.w-full` 이 `.w-14`/`.w-32` 보다 뒤에 정의되므로 그쪽이 이긴다.
   * 그 결과 고급 설정의 값 추출·자동 응답 줄에서 모든 칸이 100% 폭이 되어 한 줄이 창을
   * 몇 배로 넘고, 가로 스크롤이 생겨 왼쪽 칸이 잘려 보였다.
   *
   * min-w-0 은 남긴다 — input 은 기본 최소 폭이 있어 flex 안에서 그 아래로 줄어들지 않는다.
   */
  const inputCls =
    'min-w-0 rounded-md border border-white/10 bg-panel-light px-2.5 py-1.5 text-[13px] text-gray-100 ' +
    'placeholder:text-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-500'

  const patchStep = (i: number, patch: Partial<CustomScenarioStep>) =>
    setSteps((arr) => arr.map((s, idx) => (idx === i ? { ...s, ...patch } : s)))
  const addStep = () => setSteps((arr) => [...arr, emptyStep()])
  const removeStep = (i: number) => setSteps((arr) => arr.filter((_, idx) => idx !== i))
  // 고급 설정(대상 역할·값 추출·자동 응답·실패 시 동작)은 접어둔다 — 대부분의 단계는 안 쓴다
  const [advOpen, setAdvOpen] = useState<Set<number>>(new Set())
  const toggleAdv = (i: number) =>
    setAdvOpen((s) => {
      const n = new Set(s)
      if (n.has(i)) n.delete(i)
      else n.add(i)
      return n
    })
  /** 이 단계에 고급 설정이 하나라도 채워져 있는지 (접혀 있어도 알 수 있게 표시) */
  const hasAdv = (s: CustomScenarioStep) =>
    !!(
      cleanCheck(s.check) ||
      s.undo?.trim() ||
      s.target?.trim() ||
      s.capture?.length ||
      s.expect?.length ||
      (s.onFailure && s.onFailure !== 'stop')
    )

  const patchCapture = (i: number, ci: number, patch: Partial<CaptureRule>) =>
    patchStep(i, { capture: (steps[i].capture ?? []).map((c, k) => (k === ci ? { ...c, ...patch } : c)) })
  const patchExpect = (i: number, ei: number, patch: Partial<ExpectRule>) =>
    patchStep(i, { expect: (steps[i].expect ?? []).map((x, k) => (k === ei ? { ...x, ...patch } : x)) })

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
        // 편집 화면에 토글은 없지만 값은 지킨다 — 복제본을 한 번 열었다 저장했다고 표시가 사라지면 안 된다
        needsInput: s.needsInput || undefined,
        manualOnly: s.manualOnly || undefined,
        check: cleanCheck(s.check),
        // 고급 설정 — 빈 행은 저장하지 않는다
        target: s.target?.trim() || undefined,
        capture: (s.capture ?? []).filter((c) => c.name?.trim() && c.regex?.trim()).map((c) => ({
          name: c.name.trim(),
          regex: c.regex.trim(),
          ...(typeof c.group === 'number' ? { group: c.group } : {}),
        })),
        expect: (s.expect ?? []).filter((x) => x.match?.trim() && x.send !== undefined).map((x) => ({
          match: x.match.trim(),
          send: x.send,
          ...(x.secret ? { secret: true } : {}),
        })),
        onFailure: s.onFailure && s.onFailure !== 'stop' ? s.onFailure : undefined,
        onFailureCommand:
          s.onFailure === 'run' || s.onFailure === 'retry' ? s.onFailureCommand?.trim() || undefined : undefined,
        // 대응 명령이 없으면 설명도 남기지 않는다 (붙을 곳이 없는 문구가 저장돼 남는 것을 막는다)
        onFailureDesc:
          (s.onFailure === 'run' || s.onFailure === 'retry') && s.onFailureCommand?.trim()
            ? (s.onFailureDesc ?? []).map((d) => d.trim()).filter(Boolean).length
              ? (s.onFailureDesc ?? []).map((d) => d.trim())
              : undefined
            : undefined,
        undo: s.undo?.trim() || undefined,
      }))
      .map((s) => ({
        ...s,
        capture: s.capture.length ? s.capture : undefined,
        expect: s.expect.length ? s.expect : undefined,
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
                className={inputCls + ' w-full'}
                newLabel="카테고리"
              />
            </div>
            <div>
              <label className="mb-1 block text-[11px] text-gray-400">제목</label>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="예: [K8s] 파드 재기동 검증"
                className={inputCls + ' w-full'}
              />
            </div>
          </div>
          <div>
            <label className="mb-1 block text-[11px] text-gray-400">요약</label>
            {/* 설명과 같은 이유로 textarea — 개행을 지우는 input 에 두면 복제한 시나리오의
                두 줄짜리 요약이 한 줄로 붙는다 */}
            <textarea
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              placeholder="무엇을 검증하는 시나리오인지 (줄바꿈 가능)"
              rows={2}
              className={inputCls + ' w-full resize-y'}
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
                      className={inputCls + ' w-full'}
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
                    className={inputCls + ' w-full mb-1.5 font-mono'}
                  />
                  {/* input 이 아니라 textarea 다 — 설명은 줄을 나눠 적고, 화면도 그대로 보여준다.
                      input 은 값에서 개행을 아예 지워 버려서, 내장 시나리오를 복제해 열기만 해도
                      두 줄짜리 설명이 "…정상입니다.결과에서 볼 것…" 처럼 붙어 버린다. */}
                  <textarea
                    value={s.desc}
                    onChange={(e) => patchStep(i, { desc: e.target.value })}
                    placeholder="이 단계에 대한 설명 (줄바꿈 가능)"
                    rows={2}
                    className={inputCls + ' w-full resize-y'}
                  />

                  <button
                    onClick={() => toggleAdv(i)}
                    className="mt-1.5 flex items-center gap-1 text-[11px] text-gray-400 hover:text-gray-200"
                  >
                    {advOpen.has(i) ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    고급 설정
                    {hasAdv(s) && <span className="rounded bg-blue-500/20 px-1.5 text-[10px] text-blue-200">설정됨</span>}
                  </button>

                  {advOpen.has(i) && (
                    <div className="mt-1.5 space-y-2 rounded-md border border-white/10 bg-black/20 p-2">
                      {/* 판정 기준 — 이게 없으면 러너는 '실행됨'까지만 판단하고 정상/실패를 확정하지 못한다 */}
                      <div>
                        <label className="mb-1 block text-[10px] text-gray-400">
                          판정 기준 <span className="text-gray-600">— 비우면 종료 코드·위험 키워드만 보고 '실행됨'으로 표시</span>
                        </label>
                        <div className="grid grid-cols-2 gap-1.5">
                          <input
                            value={(s.check?.passContains ?? []).join(', ')}
                            onChange={(e) =>
                              patchStep(i, {
                                check: { ...s.check, passContains: splitCsv(e.target.value) },
                              })
                            }
                            placeholder="정상: 이 문자열이 모두 있어야 통과 (쉼표 구분)"
                            className={inputCls + ' w-full text-[12px]'}
                          />
                          <input
                            value={(s.check?.failContains ?? []).join(', ')}
                            onChange={(e) =>
                              patchStep(i, {
                                check: { ...s.check, failContains: splitCsv(e.target.value) },
                              })
                            }
                            placeholder="실패: 하나라도 있으면 실패 (쉼표 구분)"
                            className={inputCls + ' w-full text-[12px]'}
                          />
                          <input
                            value={s.check?.passRegex ?? ''}
                            onChange={(e) => patchStep(i, { check: { ...s.check, passRegex: e.target.value } })}
                            placeholder="정상 판정 정규식 (선택)"
                            className={inputCls + ' w-full font-mono text-[12px]'}
                          />
                          <label className="flex items-center gap-1.5 text-[11px] text-gray-400">
                            <input
                              type="checkbox"
                              checked={!!s.check?.requireExitZero}
                              onChange={(e) => patchStep(i, { check: { ...s.check, requireExitZero: e.target.checked } })}
                              className="accent-blue-500"
                            />
                            종료 코드 0 을 요구
                          </label>
                        </div>
                      </div>

                      {/* 원복 명령 — 검증이 끝난 뒤 되돌리기용 */}
                      <div>
                        <label className="mb-1 block text-[10px] text-gray-400">
                          원복 명령{' '}
                          <span className="text-gray-600">
                            — 이 단계가 만든 변경을 되돌리는 명령. 비우면 원복 대상에서 제외
                          </span>
                        </label>
                        <input
                          value={s.undo ?? ''}
                          onChange={(e) => patchStep(i, { undo: e.target.value })}
                          placeholder="예: sudo umount /mnt/config  (조회만 하는 단계는 비워두세요)"
                          className={inputCls + ' w-full font-mono text-[12px]'}
                        />
                        <p className="mt-1 text-[10px] leading-relaxed text-gray-500">
                          검증 후 <strong>&apos;원복 실행&apos;</strong>을 누르면, 실제로 실행된 단계만 골라{' '}
                          <strong>역순으로</strong> 되돌립니다. DNS 설정·패키지 설치처럼 남겨둬도 되는 것은 비워두면 됩니다.
                        </p>
                      </div>

                      {/* 대상 역할 — 검증 실행 창에서 이 역할에 실제 세션을 지정한다 */}
                      <div>
                        <label className="mb-1 block text-[10px] text-gray-400">
                          대상 역할{' '}
                          <span className="text-gray-600">
                            — 비우면 기본 대상에서 실행 · 쉼표로 여러 역할을 적으면 그 세션 모두에서 실행
                          </span>
                        </label>
                        <input
                          value={s.target ?? ''}
                          onChange={(e) => patchStep(i, { target: e.target.value })}
                          placeholder="예: 서버  /  서버, 클라이언트"
                          className={inputCls + ' w-full text-[12px]'}
                        />
                      </div>

                      {/* 값 추출 — 이 단계 출력에서 뽑아 다음 단계의 <이름> 으로 넘긴다 */}
                      <div>
                        <div className="mb-1 flex items-center justify-between">
                          <label className="text-[10px] text-gray-400">
                            값 추출 <span className="text-gray-600">— 출력에서 뽑아 다음 단계 &lt;이름&gt; 으로 전달</span>
                          </label>
                          <button
                            onClick={() => patchStep(i, { capture: [...(s.capture ?? []), { name: '', regex: '' }] })}
                            className="rounded px-1.5 py-0.5 text-[10px] text-emerald-300 hover:bg-emerald-500/10"
                          >
                            + 추가
                          </button>
                        </div>
                        {(s.capture ?? []).map((c, ci) => (
                          <div key={ci} className="mb-1 flex items-center gap-1">
                            <input
                              value={c.name}
                              onChange={(e) => patchCapture(i, ci, { name: e.target.value })}
                              placeholder="변수명"
                              className={inputCls + ' w-32 shrink-0 text-[12px]'}
                            />
                            <input
                              value={c.regex}
                              onChange={(e) => patchCapture(i, ci, { regex: e.target.value })}
                              placeholder="정규식 (예: inet (\d+\.\d+\.\d+\.\d+))"
                              className={inputCls + ' w-full font-mono text-[12px]'}
                            />
                            <input
                              type="number"
                              min={0}
                              value={c.group ?? 1}
                              onChange={(e) => patchCapture(i, ci, { group: parseInt(e.target.value, 10) || 0 })}
                              title="사용할 캡처 그룹 번호 (0 = 매치 전체)"
                              className={inputCls + ' w-14 shrink-0 text-[12px]'}
                            />
                            <button
                              onClick={() => patchStep(i, { capture: (s.capture ?? []).filter((_, k) => k !== ci) })}
                              className="shrink-0 rounded p-1 text-gray-500 hover:bg-red-500/20 hover:text-red-300"
                            >
                              <Trash2 size={12} />
                            </button>
                          </div>
                        ))}
                      </div>

                      {/* 자동 응답 — sudo 비밀번호나 y/n 확인 프롬프트 처리 */}
                      <div>
                        <div className="mb-1 flex items-center justify-between">
                          <label className="text-[10px] text-gray-400">
                            자동 응답 <span className="text-gray-600">— 프롬프트가 뜨면 대신 입력</span>
                          </label>
                          <button
                            onClick={() => patchStep(i, { expect: [...(s.expect ?? []), { match: '', send: '' }] })}
                            className="rounded px-1.5 py-0.5 text-[10px] text-emerald-300 hover:bg-emerald-500/10"
                          >
                            + 추가
                          </button>
                        </div>
                        {(s.expect ?? []).map((x, ei) => (
                          <div key={ei} className="mb-1 flex items-center gap-1">
                            <input
                              value={x.match}
                              onChange={(e) => patchExpect(i, ei, { match: e.target.value })}
                              placeholder="프롬프트 정규식 (예: password, \[y/N\])"
                              className={inputCls + ' w-full font-mono text-[12px]'}
                            />
                            <input
                              value={x.send}
                              onChange={(e) => patchExpect(i, ei, { send: e.target.value })}
                              type={x.secret ? 'password' : 'text'}
                              placeholder="보낼 값 (예: y, <PASSWORD>)"
                              className={inputCls + ' w-40 shrink-0 text-[12px]'}
                            />
                            <label className="flex shrink-0 items-center gap-1 text-[10px] text-gray-400" title="리포트에서 값을 가립니다">
                              <input
                                type="checkbox"
                                checked={!!x.secret}
                                onChange={(e) => patchExpect(i, ei, { secret: e.target.checked })}
                                className="accent-blue-500"
                              />
                              비밀
                            </label>
                            <button
                              onClick={() => patchStep(i, { expect: (s.expect ?? []).filter((_, k) => k !== ei) })}
                              className="shrink-0 rounded p-1 text-gray-500 hover:bg-red-500/20 hover:text-red-300"
                            >
                              <Trash2 size={12} />
                            </button>
                          </div>
                        ))}
                        <p className="text-[10px] text-gray-600">
                          영속 셸이 열린 경우에만 동작합니다. 비밀번호는 시나리오에 그대로 저장되니, 가급적{' '}
                          <span className="font-mono">&lt;PASSWORD&gt;</span> 처럼 두고 실행 시 입력받으세요.
                        </p>
                      </div>

                      {/* 실패 시 동작 */}
                      <div>
                        <label className="mb-1 block text-[10px] text-gray-400">실패 시</label>
                        <div className="flex items-center gap-1">
                          <select
                            value={s.onFailure ?? 'stop'}
                            onChange={(e) => patchStep(i, { onFailure: e.target.value as OnFailureAction })}
                            className={inputCls + ' w-44 shrink-0 text-[12px]'}
                          >
                            <option value="stop">중단 (이후 단계 미실행)</option>
                            <option value="continue">계속 진행</option>
                            <option value="run">대응 명령 실행 후 중단</option>
                            <option value="retry">대응 명령 실행 후 이 단계 재시도</option>
                          </select>
                          {(s.onFailure === 'run' || s.onFailure === 'retry') && (
                            <input
                              value={s.onFailureCommand ?? ''}
                              onChange={(e) => patchStep(i, { onFailureCommand: e.target.value })}
                              placeholder={s.onFailure === 'retry' ? '원인을 고칠 명령 (예: DNS 지정)' : '롤백/로그수집 명령'}
                              className={inputCls + ' w-full font-mono text-[12px]'}
                            />
                          )}
                        </div>
                        {/* 단계 설명 — 대응 명령이 여러 동작을 이어 붙인 경우에만 의미가 있다.
                            명령을 최상위 구분자로 쪼갠 조각 수만큼 칸을 보여주고, 순서대로 짝지어
                            검증 실행 창에 표시한다(비워두면 그 단계는 명령만 보인다). */}
                        {(s.onFailure === 'run' || s.onFailure === 'retry') &&
                          (() => {
                            const segs = splitShell(s.onFailureCommand ?? '')
                            if (segs.length < 2) return null
                            return (
                              <div className="mt-1.5 rounded-md border border-white/10 bg-black/20 p-2">
                                <div className="mb-1 text-[10px] text-gray-400">
                                  단계 설명 (선택) — 실행 창에서 이 문구가 명령 조각 앞에 붙습니다
                                </div>
                                <div className="space-y-1">
                                  {segs.map((sg, k) => (
                                    <div key={k} className="flex items-center gap-1.5">
                                      <span className="w-9 shrink-0 text-right text-[10px] text-gray-500">
                                        {k + 1}단계
                                      </span>
                                      <input
                                        value={s.onFailureDesc?.[k] ?? ''}
                                        onChange={(e) => {
                                          const next = [...(s.onFailureDesc ?? [])]
                                          while (next.length < segs.length) next.push('')
                                          next[k] = e.target.value
                                          patchStep(i, { onFailureDesc: next })
                                        }}
                                        placeholder={sg.cmd.slice(0, 40)}
                                        className={inputCls + ' w-full text-[11px]'}
                                      />
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )
                          })()}
                        {(s.onFailure === 'retry' || s.onFailure === 'run') && (
                          <div className="mt-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 p-2">
                            <div className="flex items-start gap-1.5 text-[10.5px] leading-relaxed text-amber-200">
                              <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                              <span>
                                <strong>대응 명령은 대상 서버의 상태를 실제로 바꿉니다.</strong> DNS·패키지·서비스 설정을
                                건드리는 명령이라면 <strong>테스트용으로 만든 인스턴스에서만</strong> 사용하세요. 운영
                                장비에서는 점검만 하고(실패 시: 중단) 조치는 사람이 판단하는 편이 안전합니다.
                                <br />
                                <span className="text-amber-300/80">
                                  특히 <code>netplan apply</code> 처럼 네트워크를 재시작하는 명령은 넣지 마세요 — SSH 연결이
                                  끊겨 그 노드에 다시 못 들어갈 수 있습니다.
                                </span>
                              </span>
                            </div>
                          </div>
                        )}
                        {s.onFailure === 'retry' && (
                          <p className="mt-1 text-[10px] leading-relaxed text-gray-500">
                            대응 명령을 실행한 뒤 이 단계를 <strong>한 번만</strong> 다시 실행합니다. 성공하면 다음 단계로
                            진행하고, 그래도 실패하면 중단합니다.
                            <br />
                            예) <code className="text-gray-400">apt update</code> 가 DNS 문제로 실패 → 대응 명령{' '}
                            <code className="text-gray-400">
                              sudo resolvectl dns $(ip route show default | awk &apos;{'{'}print $5; exit{'}'}&apos;) 8.8.8.8
                            </code>{' '}
                            → 재시도 (재부팅하면 원래 설정으로 돌아가는 런타임 설정이라 비교적 안전합니다)
                          </p>
                        )}
                      </div>
                    </div>
                  )}
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
