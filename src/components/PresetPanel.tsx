import { useEffect, useMemo, useRef, useState } from 'react'
import { Play, CornerDownLeft, Copy, Check, X, Search, Plus, Pencil, Trash2, ChevronUp, ChevronDown } from 'lucide-react'
import { PRESETS, type PresetGroup } from '../presets'
import type { CustomPresetCommand } from '../../electron/shared-types'
import AutocompleteInput from './AutocompleteInput'
import ConfirmDialog from './ConfirmDialog'
import { computeMoveOrder, computeInsertBeforeOrder, computeAppendOrder } from '../lib/orderedMerge'

interface PresetPanelProps {
  connected: boolean
  onRun: (cmd: string, execute: boolean) => void
  onClose: () => void
}

interface PanelCommand {
  label: string
  command: string
  desc: string
  /** 사용자 정의 항목일 때만 존재 — 편집/삭제/이동 대상 식별용 */
  id?: string
  custom?: boolean
  /** 병합 정렬 기준값 — 내장 항목은 배열 인덱스, 사용자 정의 항목은 저장된 order */
  order: number
}
interface PanelSubGroup {
  name: string
  commands: PanelCommand[]
}
interface PanelGroup {
  solution: string
  subgroups: PanelSubGroup[]
}

/**
 * 내장 PRESETS(고정) 와 사용자 정의 프리셋을 카테고리/하위분류 기준으로 병합하고,
 * order 값(내장=배열 인덱스, 사용자 정의=저장된 값) 기준으로 정렬 — 사용자 정의 항목이
 * 내장 항목들 사이 어디든 끼워질 수 있고, 다른 카테고리로도 옮겨질 수 있게 하기 위함.
 */
function mergeGroups(builtIn: PresetGroup[], custom: CustomPresetCommand[]): PanelGroup[] {
  const groups: PanelGroup[] = builtIn.map((g) => ({
    solution: g.solution,
    subgroups: g.subgroups.map((s) => ({
      name: s.name,
      commands: s.commands.map((c, i): PanelCommand => ({ ...c, order: i })),
    })),
  }))
  for (const c of custom) {
    let g = groups.find((g) => g.solution === c.solution)
    if (!g) {
      g = { solution: c.solution, subgroups: [] }
      groups.push(g)
    }
    let s = g.subgroups.find((s) => s.name === c.subgroup)
    if (!s) {
      s = { name: c.subgroup, commands: [] }
      g.subgroups.push(s)
    }
    s.commands.push({
      label: c.label,
      command: c.command,
      desc: c.desc,
      id: c.id,
      custom: true,
      order: c.order ?? Date.now(),
    })
  }
  for (const g of groups) for (const s of g.subgroups) s.commands.sort((a, b) => a.order - b.order)
  return groups
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

export default function PresetPanel({ connected, onRun, onClose }: PresetPanelProps) {
  const [solution, setSolution] = useState(PRESETS[0].solution)
  const [subName, setSubName] = useState(PRESETS[0].subgroups[0].name)
  const [copied, setCopied] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  // 카테고리 목록(좌측) 너비 — 드래그로 조절, localStorage 보존
  const [catWidth, setCatWidth] = useState(() => Number(localStorage.getItem('preset_cat_width')) || 128)
  const catWidthRef = useRef(catWidth)
  const catDragRef = useRef(false)
  const bodyRef = useRef<HTMLDivElement>(null)
  // 값 입력 인라인 영역 — 어느 명령어(key) 아래에 펼쳐져 있는지 + 그 명령어/플레이스홀더 목록
  const [openPh, setOpenPh] = useState<{ key: string; command: string; placeholders: string[] } | null>(null)
  const [phValues, setPhValues] = useState<Record<string, string>>({})

  // 사용자 정의 프리셋(런타임 추가) — 메인 프로세스에 JSON 으로 저장, 내장 PRESETS 와 병합해 표시
  const [customPresets, setCustomPresets] = useState<CustomPresetCommand[]>([])
  const [editing, setEditing] = useState<CustomPresetCommand | 'new' | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; label: string } | null>(null)
  // 드래그앤드롭 이동 — 사용자 정의 항목만 드래그 가능, 내장/사용자 정의 항목 모두 드롭 대상 가능
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [overKey, setOverKey] = useState<string | null>(null)

  useEffect(() => {
    window.electronAPI.customPresetsList().then(setCustomPresets)
  }, [])

  const groups = useMemo(() => mergeGroups(PRESETS, customPresets), [customPresets])
  const ALL_COMMANDS = useMemo(
    () =>
      groups.flatMap((g) =>
        g.subgroups.flatMap((s) => s.commands.map((c) => ({ ...c, solution: g.solution, subgroup: s.name }))),
      ),
    [groups],
  )

  const saveCustomPreset = async (item: CustomPresetCommand) => {
    const list = await window.electronAPI.customPresetsUpsert(item)
    setCustomPresets(list)
    setEditing(null)
  }
  const deleteCustomPreset = async (id: string) => {
    const list = await window.electronAPI.customPresetsDelete(id)
    setCustomPresets(list)
  }
  /** 병합·정렬된 순서 그대로의 형제 목록 (내장+사용자 정의 전부) — 화살표/드래그 위치 계산 기준 */
  const siblingsOf = (sol: string, sub: string): PanelCommand[] =>
    groups.find((g) => g.solution === sol)?.subgroups.find((s) => s.name === sub)?.commands ?? []

  // 화살표: 병합된 전체 목록 안에서 한 칸 이동 (내장 항목을 넘어서도 이동 가능)
  const moveCustomPreset = async (sol: string, sub: string, id: string, dir: -1 | 1) => {
    const merged = siblingsOf(sol, sub)
    const idx = merged.findIndex((c) => c.id === id)
    if (idx < 0) return
    const newOrder = computeMoveOrder(merged, idx, dir)
    if (newOrder === null) return
    const item = customPresets.find((p) => p.id === id)
    if (!item) return
    const list = await window.electronAPI.customPresetsUpsert({ ...item, order: newOrder })
    setCustomPresets(list)
  }

  // 드래그앤드롭: targetSol/targetSub 의 beforeIdx 앞에 끼워넣기 (다른 카테고리/하위분류로도 이동 가능)
  const dropCustomPresetBefore = async (id: string, targetSol: string, targetSub: string, beforeIdx: number) => {
    const merged = siblingsOf(targetSol, targetSub).filter((c) => c.id !== id)
    const newOrder = computeInsertBeforeOrder(merged, beforeIdx)
    const item = customPresets.find((p) => p.id === id)
    if (!item) return
    const list = await window.electronAPI.customPresetsUpsert({
      ...item,
      solution: targetSol,
      subgroup: targetSub,
      order: newOrder,
    })
    setCustomPresets(list)
  }
  // 드래그앤드롭: 카테고리/하위분류 헤더에 드롭 — 그 목록 맨 끝으로 이동
  const dropCustomPresetAppend = async (id: string, targetSol: string, targetSub: string) => {
    const merged = siblingsOf(targetSol, targetSub).filter((c) => c.id !== id)
    const newOrder = computeAppendOrder(merged)
    const item = customPresets.find((p) => p.id === id)
    if (!item) return
    const list = await window.electronAPI.customPresetsUpsert({
      ...item,
      solution: targetSol,
      subgroup: targetSub,
      order: newOrder,
    })
    setCustomPresets(list)
  }

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!catDragRef.current) return
      const el = bodyRef.current
      if (!el) return
      const r = el.getBoundingClientRect()
      const w = Math.max(100, Math.min(320, e.clientX - r.left))
      catWidthRef.current = w
      setCatWidth(w)
    }
    const onUp = () => {
      if (!catDragRef.current) return
      catDragRef.current = false
      document.body.style.cursor = ''
      localStorage.setItem('preset_cat_width', String(Math.round(catWidthRef.current)))
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [])

  // 같은 명령어를 다시 누르면 접고, 다른 명령어면 그걸로 교체해서 펼침
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

  // 카테고리/하위분류 전환 시 이전에 열려 있던 값 입력 영역은 닫음
  useEffect(() => {
    setOpenPh(null)
  }, [solution, subName])

  const trimmed = query.trim()

  const group = useMemo(
    () => groups.find((g) => g.solution === solution) ?? groups[0],
    [groups, solution],
  )
  const sub = useMemo(
    () => group.subgroups.find((s) => s.name === subName) ?? group.subgroups[0],
    [group, subName],
  )

  const selectSolution = (name: string) => {
    const g = groups.find((p) => p.solution === name)
    setSolution(name)
    setSubName(g?.subgroups[0].name ?? '')
  }

  const copy = async (cmd: string) => {
    try {
      await navigator.clipboard.writeText(cmd)
      setCopied(cmd)
      setTimeout(() => setCopied((c) => (c === cmd ? null : c)), 1500)
    } catch { /* 무시 */ }
  }

  const searchResults = useMemo(() => {
    if (!trimmed) return []
    const q = trimmed.toLowerCase()
    return ALL_COMMANDS.filter(
      (c) =>
        c.label.toLowerCase().includes(q) ||
        c.command.toLowerCase().includes(q) ||
        (c.desc ?? '').toLowerCase().includes(q)
    )
  }, [trimmed])

  const renderCommand = (
    c: PanelCommand & { solution?: string; subgroup?: string },
    key: string,
    showContext = false,
  ) => {
    const ph = hasPlaceholder(c.command)
    const isOpenPh = openPh?.key === key
    const sol = c.solution ?? solution
    const sub = c.subgroup ?? subName
    return (
      <div
        key={key}
        draggable={!!(c.custom && c.id)}
        onDragStart={(e) => {
          if (!c.id) return
          e.dataTransfer.effectAllowed = 'move'
          e.dataTransfer.setData('text/plain', c.id)
          setDraggingId(c.id)
        }}
        onDragEnd={() => {
          setDraggingId(null)
          setOverKey(null)
        }}
        onDragOver={(e) => {
          if (!draggingId || draggingId === c.id) return
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
          if (overKey !== key) setOverKey(key)
        }}
        onDragLeave={() => setOverKey((k) => (k === key ? null : k))}
        onDrop={(e) => {
          e.preventDefault()
          const id = e.dataTransfer.getData('text/plain')
          setOverKey(null)
          setDraggingId(null)
          if (!id || id === c.id) return
          const merged = siblingsOf(sol, sub)
          // c.id 가 있으면(사용자 정의 대상) id 로, 없으면(내장 대상 — 전부 id===undefined 라 id만으론
          // 구분 불가) 같은 라벨+명령어 조합으로 정확한 위치를 찾는다.
          const beforeIdx = merged.findIndex((x) =>
            c.id ? x.id === c.id : !x.id && x.command === c.command && x.label === c.label,
          )
          dropCustomPresetBefore(id, sol, sub, beforeIdx < 0 ? merged.length : beforeIdx)
        }}
        title={c.custom ? '드래그해서 순서/카테고리 이동' : undefined}
        className={
          'group rounded-md border bg-panel-light p-2 transition hover:border-blue-500/40 ' +
          (overKey === key ? 'border-blue-400 shadow-[inset_0_2px_0_0_rgb(96,165,250)]' : 'border-white/10') +
          (c.custom ? ' cursor-grab active:cursor-grabbing' : '')
        }
      >
        <div className="flex items-center gap-2">
          {showContext && (
            <span className="shrink-0 rounded bg-blue-600/20 px-1.5 py-0.5 text-[10px] text-blue-300">
              {c.solution} · {c.subgroup}
            </span>
          )}
          {c.custom && (
            <span className="shrink-0 rounded bg-emerald-600/20 px-1.5 py-0.5 text-[10px] text-emerald-300">
              사용자 정의
            </span>
          )}
          <span className="shrink-0 text-[13px] font-medium text-gray-100">
            <Highlight text={c.label} query={trimmed} />
          </span>
          <code
            title={c.command}
            className="min-w-0 flex-1 truncate rounded bg-black/40 px-1.5 py-0.5 font-mono text-[11px] text-pink-200"
          >
            <Highlight text={c.command} query={trimmed} />
          </code>
          <div className="flex shrink-0 items-center gap-1">
            {c.custom && c.id && (() => {
              const merged = siblingsOf(sol, sub)
              const idx = merged.findIndex((p) => p.id === c.id)
              return (
                <>
                  <button
                    onClick={() => moveCustomPreset(sol, sub, c.id!, -1)}
                    disabled={idx <= 0}
                    title="위로 이동"
                    className="rounded p-1 text-gray-400 hover:bg-white/10 hover:text-gray-200 disabled:opacity-20"
                  >
                    <ChevronUp size={13} />
                  </button>
                  <button
                    onClick={() => moveCustomPreset(sol, sub, c.id!, 1)}
                    disabled={idx < 0 || idx >= merged.length - 1}
                    title="아래로 이동"
                    className="rounded p-1 text-gray-400 hover:bg-white/10 hover:text-gray-200 disabled:opacity-20"
                  >
                    <ChevronDown size={13} />
                  </button>
                  <button
                    onClick={() =>
                      setEditing({
                        id: c.id!,
                        solution: sol,
                        subgroup: sub,
                        label: c.label,
                        command: c.command,
                        desc: c.desc,
                        order: c.order,
                      })
                    }
                    title="편집"
                    className="rounded p-1 text-gray-400 hover:bg-white/10 hover:text-gray-200"
                  >
                    <Pencil size={13} />
                  </button>
                  <button
                    onClick={() => setConfirmDelete({ id: c.id!, label: c.label })}
                    title="삭제"
                    className="rounded p-1 text-gray-400 hover:bg-red-500/20 hover:text-red-300"
                  >
                    <Trash2 size={13} />
                  </button>
                </>
              )
            })()}
            <button
              onClick={() => copy(c.command)}
              title="명령어 복사"
              className="rounded p-1 text-gray-400 hover:bg-white/10 hover:text-gray-200"
            >
              {copied === c.command ? (
                <Check size={13} className="text-green-400" />
              ) : (
                <Copy size={13} />
              )}
            </button>
            <button
              onClick={() => (ph ? togglePlaceholderInput(key, c.command) : onRun(c.command, true))}
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
        </div>
        {c.desc && (
          <p className="mt-1 text-[11px] leading-relaxed text-gray-400">
            <Highlight text={c.desc} query={trimmed} />
            {ph && <span className="ml-1 text-amber-400/80">· &lt;...&gt; 수정 필요</span>}
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
    )
  }

  return (
    <div className="flex h-full flex-col border-b border-white/10 bg-panel">
      {/* 검색 바 */}
      <div className="flex items-center gap-2 border-b border-white/10 px-2.5 py-1.5">
        <Search size={13} className="shrink-0 text-gray-500" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="명령어, 설명 검색..."
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
              title="사용자 정의 프리셋 추가"
              className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-emerald-300 hover:bg-emerald-500/10"
            >
              <Plus size={13} />
              추가
            </button>
            <button
              onClick={onClose}
              title="프리셋 닫기"
              className="shrink-0 text-gray-500 hover:text-gray-300"
            >
              <X size={14} />
            </button>
          </>
        )}
      </div>

      {trimmed ? (
        /* 검색 결과 모드 */
        <div className="flex-1 overflow-y-auto p-2">
          {searchResults.length === 0 ? (
            <p className="py-6 text-center text-[12px] text-gray-500">
              일치하는 명령어가 없습니다.
            </p>
          ) : (
            <div className="space-y-1.5">
              <p className="px-1 pb-1 text-[10px] text-gray-500">
                {searchResults.length}개 일치
              </p>
              {searchResults.map((c) =>
                renderCommand(c, `${c.solution}-${c.subgroup}-${c.command}`, true)
              )}
            </div>
          )}
        </div>
      ) : (
        /* 일반 탐색 모드 */
        <div ref={bodyRef} className="flex min-w-0 flex-1 overflow-hidden">
          {/* 1단계: 카테고리 */}
          <div style={{ width: catWidth }} className="flex shrink-0 flex-col py-2">
            <div className="px-3 pb-2 text-[10px] font-semibold uppercase tracking-wide text-gray-500">
              카테고리
            </div>
            {groups.map((g) => (
              <button
                key={g.solution}
                onClick={() => selectSolution(g.solution)}
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
                  if (id && g.subgroups[0]) dropCustomPresetAppend(id, g.solution, g.subgroups[0].name)
                }}
                title={draggingId ? `"${g.solution}" 카테고리로 이동` : undefined}
                className={
                  'mx-1 rounded-md px-2.5 py-1.5 text-left text-[13px] transition ' +
                  (overKey === 'cat-' + g.solution
                    ? 'bg-blue-500/40 ring-1 ring-blue-400'
                    : g.solution === solution
                      ? 'bg-blue-600/30 font-medium text-blue-100'
                      : 'text-gray-300 hover:bg-white/5')
                }
              >
                {g.solution}
              </button>
            ))}
          </div>

          <div
            onMouseDown={() => {
              catDragRef.current = true
              document.body.style.cursor = 'col-resize'
            }}
            title="드래그하여 카테고리 너비 조절"
            className="w-1 shrink-0 cursor-col-resize bg-white/10 hover:bg-blue-400/50"
          />

          {/* 2·3단계: 하위분류 + 명령어 */}
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex flex-wrap items-center gap-1 border-b border-white/10 px-2 py-1.5">
              {group.subgroups.map((s) => (
                <button
                  key={s.name}
                  onClick={() => setSubName(s.name)}
                  onDragOver={(e) => {
                    if (!draggingId) return
                    e.preventDefault()
                    e.dataTransfer.dropEffect = 'move'
                    if (overKey !== 'sub-' + s.name) setOverKey('sub-' + s.name)
                  }}
                  onDragLeave={() => setOverKey((k) => (k === 'sub-' + s.name ? null : k))}
                  onDrop={(e) => {
                    e.preventDefault()
                    const id = e.dataTransfer.getData('text/plain')
                    setOverKey(null)
                    setDraggingId(null)
                    if (id) dropCustomPresetAppend(id, group.solution, s.name)
                  }}
                  title={draggingId ? `"${s.name}" 하위분류 맨 끝으로 이동` : undefined}
                  className={
                    'rounded-full px-2.5 py-0.5 text-[11px] transition ' +
                    (overKey === 'sub-' + s.name
                      ? 'bg-blue-500/40 ring-1 ring-blue-400'
                      : s.name === sub.name
                        ? 'bg-blue-500/80 text-white'
                        : 'bg-panel-light text-gray-300 hover:bg-white/10')
                  }
                >
                  {s.name}
                  <span className="ml-1 opacity-60">{s.commands.length}</span>
                </button>
              ))}
            </div>

            {!connected && (
              <div className="bg-amber-500/10 px-3 py-1 text-[11px] text-amber-300">
                SSH 연결 후 실행 가능합니다. (복사는 지금도 가능)
              </div>
            )}

            <div className="flex-1 space-y-1.5 overflow-y-auto p-2">
              {sub.commands.map((c) => renderCommand(c, c.command))}
            </div>
          </div>
        </div>
      )}

      {editing && (
        <PresetEditorModal
          initial={editing === 'new' ? null : editing}
          defaultSolution={solution}
          defaultSubgroup={subName}
          solutions={groups.map((g) => g.solution)}
          subgroupsOf={(sol) => groups.find((g) => g.solution === sol)?.subgroups.map((s) => s.name) ?? []}
          onCancel={() => setEditing(null)}
          onSave={saveCustomPreset}
        />
      )}

      {confirmDelete && (
        <ConfirmDialog
          title="프리셋 삭제"
          message={`"${confirmDelete.label}" 프리셋을 삭제할까요?`}
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => {
            deleteCustomPreset(confirmDelete.id)
            setConfirmDelete(null)
          }}
        />
      )}
    </div>
  )
}

// ── 사용자 정의 프리셋 추가/편집 모달 ─────────────────────────
function PresetEditorModal({
  initial,
  defaultSolution,
  defaultSubgroup,
  solutions,
  subgroupsOf,
  onCancel,
  onSave,
}: {
  initial: CustomPresetCommand | null
  defaultSolution: string
  defaultSubgroup: string
  solutions: string[]
  subgroupsOf: (solution: string) => string[]
  onCancel: () => void
  onSave: (item: CustomPresetCommand) => void
}) {
  const [solutionVal, setSolutionVal] = useState(initial?.solution ?? defaultSolution)
  const [subgroupVal, setSubgroupVal] = useState(initial?.subgroup ?? defaultSubgroup)
  const [label, setLabel] = useState(initial?.label ?? '')
  const [command, setCommand] = useState(initial?.command ?? '')
  const [desc, setDesc] = useState(initial?.desc ?? '')
  const [err, setErr] = useState('')

  const inputCls =
    'w-full rounded-md border border-white/10 bg-panel-light px-2.5 py-1.5 text-[13px] text-gray-100 ' +
    'placeholder:text-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-500'

  const submit = () => {
    if (!solutionVal.trim() || !subgroupVal.trim() || !label.trim() || !command.trim()) {
      setErr('카테고리 · 하위분류 · 라벨 · 명령어는 필수입니다.')
      return
    }
    onSave({
      id: initial?.id ?? '',
      solution: solutionVal.trim(),
      subgroup: subgroupVal.trim(),
      label: label.trim(),
      command: command.trim(),
      desc: desc.trim(),
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
        className="w-full max-w-md rounded-lg border border-white/10 bg-panel p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 text-sm font-semibold text-gray-100">
          {initial ? '프리셋 편집' : '사용자 정의 프리셋 추가'}
        </div>
        <div className="space-y-2.5">
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
              <label className="mb-1 block text-[11px] text-gray-400">하위분류</label>
              <AutocompleteInput
                value={subgroupVal}
                onChange={setSubgroupVal}
                options={subgroupsOf(solutionVal)}
                placeholder="기존 선택 또는 새로 입력"
                className={inputCls}
                newLabel="하위분류"
              />
            </div>
          </div>
          <div>
            <label className="mb-1 block text-[11px] text-gray-400">라벨</label>
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="예: 특정 파드 재시작"
              className={inputCls}
            />
          </div>
          <div>
            <label className="mb-1 block text-[11px] text-gray-400">
              명령어 (플레이스홀더는 &lt;NAME&gt; 형식)
            </label>
            <input
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="예: kubectl rollout restart deploy/<NAME>"
              className={inputCls + ' font-mono'}
            />
          </div>
          <div>
            <label className="mb-1 block text-[11px] text-gray-400">설명 (선택)</label>
            <input
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              placeholder="이 명령어가 하는 일"
              className={inputCls}
            />
          </div>
          {err && <p className="text-[11px] text-red-400">{err}</p>}
        </div>
        <div className="mt-4 flex justify-end gap-2">
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
