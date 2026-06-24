import { Plus, X, Circle, SquareStack, LayoutGrid, Radio } from 'lucide-react'

export interface TabInfo {
  id: string
  title: string
}

export type ViewMode = 'tabs' | 'grid'

interface TabBarProps {
  tabs: TabInfo[]
  activeId: string
  /** 세션별 연결 상태 ('connecting'|'connected'|'closed'|'error'|'idle') */
  statuses: Record<string, { status: string; msg: string } | undefined>
  max: number
  onSelect: (id: string) => void
  onAdd: () => void
  onClose: (id: string) => void
  /** 보기 모드 (탭 / 그리드) */
  viewMode: ViewMode
  onSetView: (m: ViewMode) => void
  /** 그리드 동시 입력(브로드캐스트) 토글 — 그리드 모드에서만 노출 */
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

/**
 * 다중 세션 탭바.
 *  - 탭 클릭으로 전환, × 로 닫기, + 로 추가(최대 max개)
 *  - 각 탭 좌측 점으로 연결 상태 표시
 */
export default function TabBar({
  tabs,
  activeId,
  statuses,
  max,
  onSelect,
  onAdd,
  onClose,
  viewMode,
  onSetView,
  broadcast,
  onToggleBroadcast,
}: TabBarProps) {
  return (
    <div className="flex items-center gap-1 border-b border-white/10 bg-panel-light px-2 py-1">
      <div className="flex flex-1 items-center gap-1 overflow-x-auto">
        {tabs.map((t) => {
          const active = t.id === activeId
          return (
            <div
              key={t.id}
              onClick={() => onSelect(t.id)}
              className={
                'group flex cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-1 text-xs ' +
                (active
                  ? 'bg-panel text-gray-100 ring-1 ring-white/15'
                  : 'text-gray-400 hover:bg-white/5 hover:text-gray-200')
              }
              title={t.title}
            >
              <Circle size={8} className={dotColor(statuses[t.id]?.status) + ' fill-current'} />
              <span className="max-w-[120px] truncate">{t.title}</span>
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
      <button
        type="button"
        onClick={onAdd}
        disabled={tabs.length >= max}
        title={tabs.length >= max ? `최대 ${max}개까지` : '세션 추가'}
        className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-gray-300 hover:bg-white/10 disabled:opacity-30"
      >
        <Plus size={14} />
      </button>

      {/* 그리드 동시입력(브로드캐스트) — 그리드 모드에서만 */}
      {viewMode === 'grid' && (
        <button
          type="button"
          onClick={onToggleBroadcast}
          title="그리드의 모든 세션에 동시 입력"
          className={
            'flex items-center gap-1 rounded-md px-2 py-1 text-xs transition ' +
            (broadcast
              ? 'bg-red-600/80 text-white'
              : 'text-gray-300 hover:bg-white/10')
          }
        >
          <Radio size={13} />
          동시입력
        </button>
      )}

      {/* 보기 모드 토글 (탭 / 그리드) */}
      <div className="ml-1 flex items-center rounded-md border border-white/10">
        <button
          type="button"
          onClick={() => onSetView('tabs')}
          title="탭 보기 (한 번에 1개)"
          className={
            'flex items-center rounded-l-md px-2 py-1 ' +
            (viewMode === 'tabs' ? 'bg-blue-600/30 text-blue-100' : 'text-gray-400 hover:bg-white/10')
          }
        >
          <SquareStack size={14} />
        </button>
        <button
          type="button"
          onClick={() => onSetView('grid')}
          title="그리드 보기 (최대 4개 동시)"
          className={
            'flex items-center rounded-r-md px-2 py-1 ' +
            (viewMode === 'grid' ? 'bg-blue-600/30 text-blue-100' : 'text-gray-400 hover:bg-white/10')
          }
        >
          <LayoutGrid size={14} />
        </button>
      </div>
    </div>
  )
}
