import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Plus, X, Circle, Square, Columns2, Rows2, Grid2x2, Minus, Radio, Copy, ChevronLeft, ChevronRight, ChevronDown, XCircle, Pencil } from 'lucide-react'

export interface TabInfo {
  id: string
  title: string
  /** 사용자가 직접 이름을 지정했는지 (true 면 host 대신 title 표시) */
  custom?: boolean
  /** 탭 색상 키 (rose/orange/amber/emerald/sky/blue/violet) */
  color?: string
}

/** 터미널 배치 레이아웃 — 단일(탭 전환) / 임의 재귀 분할(tmux 스타일, PaneNode 트리로 구성) */
export type LayoutMode = 'tabs' | 'split'

/** 탭바에 표시할 그리드 그룹 하나 — 활성 그룹(분할 보기 중)은 active=true, 파킹된 그룹은 false. */
export interface GridGroupInfo {
  id: string
  name?: string
  /** 이 그룹에 속한 세션 id 목록(중복 가능 — 스페어 없이 분할한 경우) */
  memberIds: string[]
  /** 현재 분할 보기로 화면에 떠 있는 그룹인지 */
  active: boolean
}

interface TabBarProps {
  tabs: TabInfo[]
  activeId: string
  /** 세션별 연결 상태 ('connecting'|'connected'|'closed'|'error'|'idle') */
  statuses: Record<string, { status: string; msg: string } | undefined>
  max: number
  onSelect: (id: string) => void
  onAdd: () => void
  onClose: (id: string) => void
  /** 모든 탭 한 번에 닫기 (확인은 App 쪽에서 처리) */
  onCloseAll: () => void
  /** 탭 이름 변경 */
  onRename: (id: string, title: string) => void
  /** 탭 순서 변경 (from 을 to 위치로) */
  onReorder: (fromId: string, toId: string) => void
  /** 탭 복제 */
  onDuplicate: (id: string) => void
  /** 탭 드래그 시작 (그리드 칸에 배치용 — App 이 칸 드롭 처리) */
  onTabDragStart?: (id: string) => void
  onTabDragEnd?: () => void
  /** 그리드(분할) 그룹 목록 — 각 그룹의 멤버 세션은 개별 탭 대신 하나의 "그리드 그룹" 칩으로 묶어 표시.
      여러 그룹이 공존할 수 있고, active=true 인 그룹만 분할 보기로 화면에 뜬다(나머지는 칩만). */
  gridGroups: GridGroupInfo[]
  /** 그리드 그룹 칩 클릭 → 그 그룹을 분할 보기로 전환(멤버 id 주면 그 칸을 활성화) */
  onSelectGrid: (groupId: string, memberId?: string) => void
  /** 그리드 그룹 해제 → 묶음만 풀기(세션 자체는 유지) */
  onDissolveGrid: (groupId: string) => void
  /** 그리드 그룹 X → 그룹에 포함된 세션을 전부 닫기(확인창은 상위에서) */
  onCloseGrid: (groupId: string) => void
  /** 그리드 그룹 이름 변경 */
  onRenameGrid: (groupId: string, name: string) => void
  /** 현재 레이아웃 */
  layout: LayoutMode
  onSetLayout: (m: LayoutMode) => void
  /** 기본 제공 프리셋 — 좌우2분할/상하2분할/4분할을 원클릭으로 (기존 트리는 버리고 새로 구성) */
  onApplyPreset: (preset: '2v' | '2h' | '4') => void
  /** 현재 활성 세션이 있는 칸을 가로(좌우)/세로(상하)로 분할 — 프리셋을 넘어선 임의분할(옵션) */
  onSplitPane: (dir: 'row' | 'col') => void
  /** 더 분할할 여유(세션 한도)가 있는지 — 없으면 분할 버튼 비활성화 */
  canSplit: boolean
  /** 활성 세션이 있는 칸을 닫고(탭 자체는 유지) 형제 칸을 그 자리로 승격 — 분할 모드 + 칸이 2개 이상일 때만 */
  onClosePane: () => void
  canClosePane: boolean
  /** 분할 동시 입력(브로드캐스트) 토글 — 분할 모드에서만 노출 */
  broadcast: boolean
  onToggleBroadcast: () => void
  /** 세션 로그 기록 중인 탭 id 집합 — 활성 탭이 아니어도 기록 중임을 표시하기 위함 */
  loggingIds: Set<string>
}

/** 상태별 점 색상 — 연결됨(초록)/연결중(노랑)/오류(빨강)/로컬·미연결(회색) */
function dotColor(status?: string): string {
  switch (status) {
    case 'connected':
      return 'text-green-400'
    case 'connecting':
      return 'text-amber-400'
    case 'error':
      return 'text-red-400'
    default:
      return 'text-gray-500'
  }
}

/** 색상 키 → 탭 좌측 테두리 인라인 스타일 */
const TAB_COLORS: Record<string, string> = {
  rose:    '#fb7185',
  orange:  '#fb923c',
  amber:   '#fbbf24',
  emerald: '#34d399',
  sky:     '#38bdf8',
  blue:    '#60a5fa',
  violet:  '#a78bfa',
}

/** 그리드 그룹 칩 하나 — 이름/멤버 상태점/이름변경/멤버 메뉴(포털)/그룹 닫기. 메뉴·이름편집 상태는 칩 내부 보관. */
function GridChip({
  group,
  tabs,
  statuses,
  activeId,
  loggingIds,
  onSelect,
  onDissolve,
  onClose,
  onRename,
  onDuplicate,
  onCloseMember,
  editingId,
  editValue,
  setEditValue,
  startRenameMember,
  commitRenameMember,
  cancelRenameMember,
}: {
  group: GridGroupInfo
  tabs: TabInfo[]
  statuses: Record<string, { status: string; msg: string } | undefined>
  activeId: string
  loggingIds: Set<string>
  onSelect: (memberId?: string) => void
  onDissolve: () => void
  onClose: () => void
  onRename: (name: string) => void
  onDuplicate: (id: string) => void
  onCloseMember: (id: string) => void
  editingId: string | null
  editValue: string
  setEditValue: (v: string) => void
  startRenameMember: (t: TabInfo) => void
  commitRenameMember: () => void
  cancelRenameMember: () => void
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editName, setEditName] = useState('')
  const chipRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  // 멤버 메뉴 바깥 클릭 시 닫기 (메뉴는 포털로 body 에 렌더되므로 칩·메뉴 둘 다 바깥일 때만)
  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (!chipRef.current?.contains(t) && !menuRef.current?.contains(t)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [menuOpen])

  const members = group.memberIds.map((id) => tabs.find((t) => t.id === id)).filter((t): t is TabInfo => !!t)
  const active = group.active
  const beginNameEdit = () => {
    setEditName(group.name ?? '')
    setEditing(true)
  }
  const commitName = () => {
    onRename(editName)
    setEditing(false)
  }

  return (
    <div ref={chipRef} className="relative shrink-0">
      <div
        onClick={() => onSelect()}
        className={
          'group flex cursor-pointer select-none items-center gap-1.5 rounded-md py-1 pl-2 pr-1.5 text-xs ' +
          (active
            ? 'bg-blue-600/30 text-blue-100 ring-1 ring-blue-400/40'
            : 'text-gray-300 hover:bg-white/5 hover:text-gray-100 ring-1 ring-white/10')
        }
        title="그리드 보기로 전환"
        style={{ flexShrink: 0 }}
      >
        <Grid2x2 size={12} className="shrink-0" />
        {editing ? (
          <input
            autoFocus
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitName()
              else if (e.key === 'Escape') setEditing(false)
            }}
            placeholder={`그리드 ${members.length}`}
            className="w-24 rounded bg-panel px-1 text-xs text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        ) : (
          <span
            className="whitespace-nowrap font-medium"
            onDoubleClick={(e) => {
              e.stopPropagation()
              beginNameEdit()
            }}
            title="더블클릭 또는 연필 버튼으로 그룹 이름 변경"
          >
            {group.name || `그리드 ${members.length}`}
          </span>
        )}
        <span className="flex items-center gap-0.5">
          {members.map((m) => (
            <Circle key={m.id} size={6} className={dotColor(statuses[m.id]?.status) + ' fill-current'} />
          ))}
        </span>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            beginNameEdit()
          }}
          title="그룹 이름 변경"
          className="rounded p-0.5 text-gray-400 hover:bg-white/10 hover:text-gray-200"
        >
          <Pencil size={11} />
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            setMenuOpen((v) => !v)
          }}
          title="그리드 멤버 관리"
          className="rounded p-0.5 text-gray-400 hover:bg-white/10 hover:text-gray-200"
        >
          <ChevronDown size={12} />
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            setMenuOpen(false)
            onClose()
          }}
          title="그리드 세션 모두 닫기"
          className="rounded p-0.5 text-gray-400 hover:bg-red-500/20 hover:text-red-300"
        >
          <X size={12} />
        </button>
      </div>

      {menuOpen &&
        createPortal(
          <div
            ref={menuRef}
            style={{
              position: 'fixed',
              top: (chipRef.current?.getBoundingClientRect().bottom ?? 0) + 4,
              left: chipRef.current?.getBoundingClientRect().left ?? 0,
            }}
            className="z-50 min-w-[200px] rounded-md border border-white/10 bg-panel-light py-1 shadow-xl"
          >
            {members.map((m) => {
              const memberEditing = editingId === m.id
              return (
                <div
                  key={m.id}
                  onClick={() => {
                    if (!memberEditing) {
                      onSelect(m.id)
                      setMenuOpen(false)
                    }
                  }}
                  onDoubleClick={() => startRenameMember(m)}
                  className={
                    'group flex cursor-pointer items-center gap-1.5 px-2 py-1 text-xs hover:bg-white/5 ' +
                    (m.id === activeId && active ? 'text-gray-100' : 'text-gray-300')
                  }
                  title="클릭: 해당 칸으로 · 더블클릭: 이름변경"
                >
                  <span
                    className="h-3 w-[3px] shrink-0 rounded-full"
                    style={{ background: m.color ? TAB_COLORS[m.color] : 'transparent' }}
                  />
                  <Circle size={7} className={dotColor(statuses[m.id]?.status) + ' fill-current shrink-0'} />
                  {memberEditing ? (
                    <input
                      autoFocus
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      onBlur={commitRenameMember}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitRenameMember()
                        else if (e.key === 'Escape') cancelRenameMember()
                      }}
                      className="w-28 rounded bg-panel px-1 text-xs text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    />
                  ) : (
                    <span className="flex-1 truncate">{m.title}</span>
                  )}
                  {loggingIds.has(m.id) && <Circle size={6} className="shrink-0 fill-current text-red-400" />}
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      onDuplicate(m.id)
                    }}
                    title="세션 복제"
                    className="rounded p-0.5 text-gray-500 opacity-0 hover:bg-white/10 hover:text-gray-200 group-hover:opacity-100"
                  >
                    <Copy size={11} />
                  </button>
                  {tabs.length > 1 && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        onCloseMember(m.id)
                      }}
                      title="세션 닫기 (그리드에서 제거)"
                      className="rounded p-0.5 text-gray-500 opacity-0 hover:bg-white/10 hover:text-gray-200 group-hover:opacity-100"
                    >
                      <X size={12} />
                    </button>
                  )}
                </div>
              )
            })}
            <div className="my-1 border-t border-white/10" />
            <button
              type="button"
              onClick={() => {
                onDissolve()
                setMenuOpen(false)
              }}
              className="flex w-full items-center gap-1.5 px-2 py-1 text-left text-xs text-gray-300 hover:bg-white/5"
              title="그리드 묶음만 풀고 세션은 개별 탭으로 유지"
            >
              <Minus size={12} className="shrink-0" />
              그룹 해제 (세션 유지)
            </button>
          </div>,
          document.body,
        )}
    </div>
  )
}

/**
 * 다중 세션 탭바.
 *  - 탭 클릭으로 전환, × 로 닫기, + 로 추가(최대 max개)
 *  - 각 탭 좌측 점으로 연결 상태 표시, 좌측 컬러 라인으로 서버 구분
 *  - 탭이 넘치면 ‹ › 스크롤 화살표 자동 표시
 *  - 우측에서 분할 레이아웃 선택 + 분할 시 동시입력 토글
 */
export default function TabBar({
  tabs,
  activeId,
  statuses,
  max,
  onSelect,
  onAdd,
  onClose,
  onCloseAll,
  onRename,
  onReorder,
  onDuplicate,
  onTabDragStart,
  onTabDragEnd,
  gridGroups,
  onSelectGrid,
  onDissolveGrid,
  onCloseGrid,
  onRenameGrid,
  layout,
  onSetLayout,
  onApplyPreset,
  onSplitPane,
  canSplit,
  onClosePane,
  canClosePane,
  broadcast,
  onToggleBroadcast,
  loggingIds,
}: TabBarProps) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [dragId, setDragId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)
  const [canScrollLeft, setCanScrollLeft] = useState(false)
  const [canScrollRight, setCanScrollRight] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  // 그리드 그룹: 어떤 그룹이든 그에 속한 세션은 개별 탭에서 빼고 그룹 칩으로 묶는다(활성/파킹 모두).
  const allGridMemberIds = new Set(gridGroups.flatMap((g) => g.memberIds))
  const singleTabs = tabs.filter((t) => !allGridMemberIds.has(t.id))

  // 탭 컨테이너 스크롤/리사이즈 감지 → 화살표 표시 여부 갱신
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const check = () => {
      setCanScrollLeft(el.scrollLeft > 0)
      setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1)
    }
    check()
    el.addEventListener('scroll', check)
    const ro = new ResizeObserver(check)
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', check)
      ro.disconnect()
    }
  }, [tabs.length])

  const startRename = (t: TabInfo) => {
    setEditingId(t.id)
    setEditValue(t.title)
  }
  const commitRename = () => {
    if (editingId) onRename(editingId, editValue.trim() || editingId)
    setEditingId(null)
  }

  return (
    <div className="flex items-center gap-1 border-b border-white/10 bg-panel-light px-2 py-1">
      {/* 스크롤 영역 래퍼 */}
      <div className="relative flex flex-1 overflow-hidden">
        {/* 왼쪽 스크롤 화살표 */}
        {canScrollLeft && (
          <button
            onClick={() => containerRef.current?.scrollBy({ left: -150, behavior: 'smooth' })}
            className="absolute left-0 top-0 z-10 flex h-full items-center bg-gradient-to-r from-panel-light via-panel-light to-transparent pl-0.5 pr-3 text-gray-400 hover:text-gray-200"
          >
            <ChevronLeft size={14} />
          </button>
        )}

        {/* 탭 목록 */}
        <div
          ref={containerRef}
          className="flex flex-1 items-center gap-1 overflow-x-auto"
          style={{ scrollbarWidth: 'none' }}
        >
          {/* 그리드 그룹 칩들 — 각 그룹(활성/파킹)을 하나의 칩으로. 본문 클릭=그 그룹 분할 보기, ▾=멤버 메뉴, ×=세션 모두 닫기 */}
          {gridGroups.map((g) => (
            <GridChip
              key={g.id}
              group={g}
              tabs={tabs}
              statuses={statuses}
              activeId={activeId}
              loggingIds={loggingIds}
              onSelect={(m) => onSelectGrid(g.id, m)}
              onDissolve={() => onDissolveGrid(g.id)}
              onClose={() => onCloseGrid(g.id)}
              onRename={(n) => onRenameGrid(g.id, n)}
              onDuplicate={onDuplicate}
              onCloseMember={onClose}
              editingId={editingId}
              editValue={editValue}
              setEditValue={setEditValue}
              startRenameMember={startRename}
              commitRenameMember={commitRename}
              cancelRenameMember={() => setEditingId(null)}
            />
          ))}

          {singleTabs.map((t) => {
            const active = t.id === activeId
            const editing = editingId === t.id
            const colorBorder = t.color ? TAB_COLORS[t.color] : undefined
            return (
              <div
                key={t.id}
                draggable={!editing}
                onDragStart={(e) => {
                  e.dataTransfer.setData('text/plain', t.id)
                  setDragId(t.id)
                  onTabDragStart?.(t.id)
                }}
                onDragEnd={() => {
                  setDragId(null)
                  setOverId(null)
                  onTabDragEnd?.()
                }}
                onDragOver={(e) => {
                  if (!dragId || dragId === t.id) return
                  e.preventDefault()
                  if (overId !== t.id) setOverId(t.id)
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  if (dragId && dragId !== t.id) onReorder(dragId, t.id)
                  setDragId(null)
                  setOverId(null)
                }}
                onClick={() => onSelect(t.id)}
                onDoubleClick={() => startRename(t)}
                className={
                  'group flex cursor-grab select-none items-center gap-1.5 rounded-md py-1 pl-1 pr-2.5 text-xs active:cursor-grabbing ' +
                  (active
                    ? 'bg-panel text-gray-100 ring-1 ring-white/15'
                    : 'text-gray-400 hover:bg-white/5 hover:text-gray-200') +
                  (overId === t.id ? ' ring-1 ring-blue-400' : '')
                }
                title={editing ? '' : t.title + ' (더블클릭: 이름변경)'}
                style={{ flexShrink: 0 }}
              >
                {/* 색상 라인 */}
                <span
                  className="h-3.5 w-[3px] rounded-full shrink-0"
                  style={{ background: colorBorder ?? 'transparent' }}
                />
                <Circle size={8} className={dotColor(statuses[t.id]?.status) + ' fill-current shrink-0'} />
                {editing ? (
                  <input
                    autoFocus
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitRename()
                      else if (e.key === 'Escape') setEditingId(null)
                    }}
                    className="w-24 rounded bg-panel-light px-1 text-xs text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                ) : (
                  <span className="max-w-[120px] truncate">{t.title}</span>
                )}
                {loggingIds.has(t.id) && (
                  <span title="세션 로그 기록 중" className="shrink-0">
                    <Circle size={7} className="fill-current text-red-400" />
                  </span>
                )}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    onDuplicate(t.id)
                  }}
                  title="세션 복제"
                  className="rounded p-0.5 text-gray-500 opacity-0 hover:bg-white/10 hover:text-gray-200 group-hover:opacity-100"
                >
                  <Copy size={11} />
                </button>
                {tabs.length > 1 && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      onClose(t.id)
                    }}
                    title="세션 닫기"
                    className="rounded p-0.5 text-gray-500 opacity-0 hover:bg-white/10 hover:text-gray-200 group-hover:opacity-100"
                  >
                    <X size={12} />
                  </button>
                )}
              </div>
            )
          })}
        </div>

        {/* 오른쪽 스크롤 화살표 */}
        {canScrollRight && (
          <button
            onClick={() => containerRef.current?.scrollBy({ left: 150, behavior: 'smooth' })}
            className="absolute right-0 top-0 z-10 flex h-full items-center bg-gradient-to-l from-panel-light via-panel-light to-transparent pl-3 pr-0.5 text-gray-400 hover:text-gray-200"
          >
            <ChevronRight size={14} />
          </button>
        )}
      </div>

      <button
        type="button"
        onClick={onAdd}
        disabled={tabs.length >= max}
        title={tabs.length >= max ? `최대 ${max}개까지` : '세션 추가'}
        className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-gray-300 hover:bg-white/10 disabled:opacity-30"
      >
        <Plus size={14} />
      </button>

      <button
        type="button"
        onClick={onCloseAll}
        title="모든 탭 닫기"
        className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-gray-300 hover:bg-red-500/20 hover:text-red-300"
      >
        <XCircle size={14} />
      </button>

      {/* 분할 동시입력(브로드캐스트) — 분할 모드에서만 */}
      {layout !== 'tabs' && (
        <button
          type="button"
          onClick={onToggleBroadcast}
          title="분할된 모든 세션에 동시 입력"
          className={
            'flex items-center gap-1 rounded-md px-2 py-1 text-xs transition ' +
            (broadcast ? 'bg-red-600/80 text-white' : 'text-gray-300 hover:bg-white/10')
          }
        >
          <Radio size={13} />
          동시입력
        </button>
      )}

      {/* 분할 레이아웃 프리셋 (기본) — 원클릭으로 단일/좌우2분할/상하2분할/4분할 */}
      <div className="ml-1 flex items-center rounded-md border border-white/10">
        <button
          type="button"
          onClick={() => onSetLayout('tabs')}
          title="단일 터미널 (탭 전환)"
          className={
            'flex items-center rounded-l-md px-2 py-1 ' +
            (layout === 'tabs' ? 'bg-blue-600/30 text-blue-100' : 'text-gray-400 hover:bg-white/10')
          }
        >
          <Square size={14} />
        </button>
        <button
          type="button"
          onClick={() => onApplyPreset('2v')}
          title="좌우 2분할"
          className="flex items-center px-2 py-1 text-gray-400 hover:bg-white/10"
        >
          <Columns2 size={14} />
        </button>
        <button
          type="button"
          onClick={() => onApplyPreset('2h')}
          title="상하 2분할"
          className="flex items-center px-2 py-1 text-gray-400 hover:bg-white/10"
        >
          <Rows2 size={14} />
        </button>
        <button
          type="button"
          onClick={() => onApplyPreset('4')}
          title="4분할"
          className="flex items-center rounded-r-md px-2 py-1 text-gray-400 hover:bg-white/10"
        >
          <Grid2x2 size={14} />
        </button>
      </div>

      {/* 임의 분할(옵션) — 프리셋을 넘어서 활성 칸을 더 세밀하게 나누거나 닫기 */}
      <div className="ml-1 flex items-center rounded-md border border-white/10 opacity-80">
        <button
          type="button"
          onClick={() => onSplitPane('row')}
          disabled={!canSplit}
          title={canSplit ? '활성 칸을 좌우로 추가 분할 (임의분할)' : '최대 세션 개수에 도달했습니다'}
          className="flex items-center rounded-l-md px-1.5 py-1 text-gray-500 hover:bg-white/10 hover:text-gray-300 disabled:opacity-30"
        >
          <Columns2 size={11} />
        </button>
        <button
          type="button"
          onClick={() => onSplitPane('col')}
          disabled={!canSplit}
          title={canSplit ? '활성 칸을 상하로 추가 분할 (임의분할)' : '최대 세션 개수에 도달했습니다'}
          className="flex items-center px-1.5 py-1 text-gray-500 hover:bg-white/10 hover:text-gray-300 disabled:opacity-30"
        >
          <Rows2 size={11} />
        </button>
        <button
          type="button"
          onClick={onClosePane}
          disabled={!canClosePane}
          title={canClosePane ? '활성 칸 닫기 (세션 자체는 유지)' : undefined}
          className="flex items-center rounded-r-md px-1.5 py-1 text-gray-500 hover:bg-white/10 hover:text-gray-300 disabled:opacity-30"
        >
          <Minus size={11} />
        </button>
      </div>
    </div>
  )
}
