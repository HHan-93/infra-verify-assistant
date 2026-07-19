import { useEffect, useRef, useState } from 'react'
import { Plus, X, Circle, Square, Columns2, Rows2, Grid2x2, Minus, Radio, Copy, ChevronLeft, ChevronRight } from 'lucide-react'

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

interface TabBarProps {
  tabs: TabInfo[]
  activeId: string
  /** 세션별 연결 상태 ('connecting'|'connected'|'closed'|'error'|'idle') */
  statuses: Record<string, { status: string; msg: string } | undefined>
  max: number
  onSelect: (id: string) => void
  onAdd: () => void
  onClose: (id: string) => void
  /** 탭 이름 변경 */
  onRename: (id: string, title: string) => void
  /** 탭 순서 변경 (from 을 to 위치로) */
  onReorder: (fromId: string, toId: string) => void
  /** 탭 복제 */
  onDuplicate: (id: string) => void
  /** 탭 드래그 시작 (그리드 칸에 배치용 — App 이 칸 드롭 처리) */
  onTabDragStart?: (id: string) => void
  onTabDragEnd?: () => void
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
  onRename,
  onReorder,
  onDuplicate,
  onTabDragStart,
  onTabDragEnd,
  layout,
  onSetLayout,
  onApplyPreset,
  onSplitPane,
  canSplit,
  onClosePane,
  canClosePane,
  broadcast,
  onToggleBroadcast,
}: TabBarProps) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [dragId, setDragId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)
  const [canScrollLeft, setCanScrollLeft] = useState(false)
  const [canScrollRight, setCanScrollRight] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

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
          {tabs.map((t) => {
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
                  'group flex cursor-pointer items-center gap-1.5 rounded-md py-1 pl-1 pr-2.5 text-xs ' +
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
