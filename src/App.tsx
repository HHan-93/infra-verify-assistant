import { useEffect, useRef, useState } from 'react'
import { Circle } from 'lucide-react'
import SSHForm from './components/SSHForm'
import Toolbar from './components/Toolbar'
import PresetPanel from './components/PresetPanel'
import ScenarioPanel from './components/ScenarioPanel'
import TerminalView, { type TerminalHandle } from './components/TerminalView'
import AIPanel, { type AIPanelHandle } from './components/AIPanel'
import FileViewer from './components/FileViewer'
import TabBar, { type TabInfo, type ViewMode } from './components/TabBar'

const MAX_SESSIONS = 6
const GRID_MAX = 4 // 그리드에 동시에 보여줄 최대 세션 수

interface SessionStatus {
  status: string
  msg: string
  /** 연결된 호스트 (탭/그리드 제목 표시용) */
  host?: string
}

/** 상태별 점 색상 */
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
 * 메인 레이아웃 (다중 세션 — 탭 / 그리드)
 *  - 탭 보기: 세션 최대 6개, 한 번에 1개 표시 (기본)
 *  - 그리드 보기: 앞 4개 세션을 동시에 격자로 표시
 *  - 동시입력(브로드캐스트): 그리드의 모든 세션에 같은 입력/명령 전송
 *  - AI 분석 패널은 공용 (활성 세션 출력 분석)
 */
export default function App() {
  const [tabs, setTabs] = useState<TabInfo[]>([{ id: 's1', title: '세션 1' }])
  const [activeId, setActiveId] = useState('s1')
  const [statuses, setStatuses] = useState<Record<string, SessionStatus>>({
    s1: { status: 'idle', msg: '' },
  })
  const [viewMode, setViewMode] = useState<ViewMode>('tabs')
  const [broadcast, setBroadcast] = useState(false)
  // 명령어 프리셋 / 시나리오 패널 (하나만 열림) — 활성 탭 대상
  const [panel, setPanel] = useState<'presets' | 'scenarios' | null>(null)
  const [showFiles, setShowFiles] = useState(false)

  // 세션ID 생성용 카운터 (s1 은 초기값으로 이미 사용)
  const idCounter = useRef(1)
  // 세션별 터미널 핸들
  const terminalRefs = useRef<Record<string, TerminalHandle | null>>({})
  const aiPanelRef = useRef<AIPanelHandle>(null)

  const activeStatus = statuses[activeId]?.status ?? 'idle'
  const activeMsg = statuses[activeId]?.msg ?? ''
  const connected = activeStatus === 'connected'
  const activeTerm = () => terminalRefs.current[activeId] ?? null

  // 그리드에 표시되는 세션 ID (앞 GRID_MAX 개)
  const gridIds = tabs.slice(0, GRID_MAX).map((t) => t.id)
  // 실제 브로드캐스트 활성 여부 (그리드 모드 + 동시입력 ON)
  const broadcasting = viewMode === 'grid' && broadcast

  // 메인 프로세스(ssh2)가 보내는 연결 상태 이벤트 구독 (sessionId 별로 반영)
  useEffect(() => {
    const off = window.electronAPI.onStatus((event) => {
      setStatuses((m) => {
        const prev = m[event.sessionId]
        // 연결/연결중일 때만 host 유지, 끊기면 제거 (제목이 기본으로 복귀)
        const keepHost = event.status === 'connected' || event.status === 'connecting'
        return {
          ...m,
          [event.sessionId]: {
            status: event.status,
            msg: event.message ?? prev?.msg ?? '',
            host: keepHost ? prev?.host : undefined,
          },
        }
      })
    })
    return off
  }, [])

  // 보기 모드/탭 수/활성/패널 변경 시 보이는 터미널 refit + 활성 포커스
  useEffect(() => {
    tabs.forEach((t) => terminalRefs.current[t.id]?.fit())
    activeTerm()?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panel, activeId, viewMode, tabs.length])

  // 세션별 상태 전환에 따른 터미널 시각 표시 (연결 시작/종료/오류)
  const prevStatuses = useRef<Record<string, string>>({})
  useEffect(() => {
    for (const t of tabs) {
      const cur = statuses[t.id]?.status ?? 'idle'
      const prev = prevStatuses.current[t.id] ?? 'idle'
      if (cur === prev) continue
      prevStatuses.current[t.id] = cur
      const term = terminalRefs.current[t.id]
      if (cur === 'connecting') term?.reset()
      else if (cur === 'closed' && prev === 'connected')
        term?.writeNotice('연결이 종료되었습니다. 다시 연결하려면 SSH 정보를 입력하세요.')
      else if (cur === 'error' && prev === 'connected') term?.writeNotice('연결이 끊겼습니다 (오류).')
    }
  }, [statuses, tabs])

  // ── 탭 추가/닫기 / 보기 모드 ──────────────────────────────────
  const addTab = () => {
    if (tabs.length >= MAX_SESSIONS) return
    const id = `s${++idCounter.current}`
    setTabs((t) => [...t, { id, title: `세션 ${t.length + 1}` }])
    setStatuses((m) => ({ ...m, [id]: { status: 'idle', msg: '' } }))
    setActiveId(id)
  }

  const closeTab = (id: string) => {
    window.electronAPI.sessionClose(id) // 백엔드 연결/로컬셸 정리
    const remaining = tabs.filter((x) => x.id !== id)
    if (remaining.length === 0) {
      const nid = `s${++idCounter.current}`
      setTabs([{ id: nid, title: '세션 1' }])
      setStatuses({ [nid]: { status: 'idle', msg: '' } })
      setActiveId(nid)
      return
    }
    if (id === activeId) setActiveId(remaining[remaining.length - 1].id)
    setTabs(remaining)
    setStatuses((m) => {
      const c = { ...m }
      delete c[id]
      return c
    })
  }

  const setView = (m: ViewMode) => {
    setViewMode(m)
    if (m === 'tabs') setBroadcast(false) // 탭 보기로 가면 동시입력 해제(오작동 방지)
  }

  // 키 입력 위임 — 브로드캐스트 시 그리드 전체로, 아니면 자기 세션으로
  const handleInput = (fromId: string, data: string) => {
    if (broadcasting) gridIds.forEach((id) => window.electronAPI.sendInput(id, data))
    else window.electronAPI.sendInput(fromId, data)
  }

  // 프리셋/시나리오 명령 실행 — 브로드캐스트 시 그리드 전체, 아니면 활성 세션
  const runOnActive = (cmd: string, execute: boolean) => {
    const ids = broadcasting ? gridIds : [activeId]
    ids.forEach((id) => {
      const h = terminalRefs.current[id]
      if (!h) return
      if (execute) h.runCommand(cmd)
      else h.insertCommand(cmd)
    })
  }

  // 터미널 출력 → AI 분석 (공용 — 활성 세션 기준)
  const analyzeSelection = () => {
    aiPanelRef.current?.analyze(activeTerm()?.getSelection() ?? '')
  }
  const analyzeRecent = () => {
    aiPanelRef.current?.analyze(activeTerm()?.getRecentOutput() ?? '')
  }

  const gridCount = Math.min(tabs.length, GRID_MAX)
  const gridCols = gridCount <= 1 ? 1 : 2
  const gridRows = gridCount <= 2 ? 1 : 2

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-panel text-gray-100">
      {/* ── 좌측 6 : 터미널 영역 ───────────────────────────── */}
      <div className="flex w-3/5 flex-col border-r border-white/10">
        <TabBar
          tabs={tabs.map((t) => ({ id: t.id, title: statuses[t.id]?.host ?? t.title }))}
          activeId={activeId}
          statuses={statuses}
          max={MAX_SESSIONS}
          onSelect={setActiveId}
          onAdd={addTab}
          onClose={closeTab}
          viewMode={viewMode}
          onSetView={setView}
          broadcast={broadcast}
          onToggleBroadcast={() => setBroadcast((b) => !b)}
        />

        {/* 세션별 SSH 폼 (활성 탭만 표시 — 비활성은 상태 보존 위해 hidden) */}
        {tabs.map((t) => (
          <div key={t.id} className={t.id === activeId ? '' : 'hidden'}>
            <SSHForm
              sessionId={t.id}
              status={statuses[t.id]?.status ?? 'idle'}
              onConnected={(host) =>
                setStatuses((m) => ({
                  ...m,
                  [t.id]: { status: 'connected', msg: m[t.id]?.msg ?? '', host },
                }))
              }
              onError={(msg) => setStatuses((m) => ({ ...m, [t.id]: { status: 'error', msg } }))}
            />
          </div>
        ))}

        <Toolbar
          showPresets={panel === 'presets'}
          onTogglePresets={() => setPanel((p) => (p === 'presets' ? null : 'presets'))}
          showScenarios={panel === 'scenarios'}
          onToggleScenarios={() => setPanel((p) => (p === 'scenarios' ? null : 'scenarios'))}
          onOpenFiles={() => setShowFiles(true)}
          onAnalyzeSelection={analyzeSelection}
          onAnalyzeRecent={analyzeRecent}
        />
        {panel === 'presets' && (
          <PresetPanel connected={connected} onRun={runOnActive} onClose={() => setPanel(null)} />
        )}
        {panel === 'scenarios' && (
          <ScenarioPanel connected={connected} onRun={runOnActive} onClose={() => setPanel(null)} />
        )}

        {broadcasting && (
          <div className="bg-red-600/15 px-3 py-0.5 text-center text-[11px] font-medium text-red-300">
            ⚠ 동시입력 ON — 그리드의 모든 세션({gridCount}개)에 동시에 입력됩니다
          </div>
        )}
        {viewMode === 'grid' && tabs.length > GRID_MAX && (
          <div className="bg-amber-500/10 px-3 py-0.5 text-[11px] text-amber-300">
            그리드는 앞 {GRID_MAX}개 세션만 표시합니다 (나머지는 탭 보기에서 확인).
          </div>
        )}

        {/* 터미널 영역 — 탭 보기(겹침) / 그리드 보기(격자). 인스턴스는 항상 마운트 유지 */}
        <div
          className="min-h-0 flex-1 overflow-hidden"
          style={
            viewMode === 'grid'
              ? {
                  display: 'grid',
                  gridTemplateColumns: `repeat(${gridCols}, minmax(0, 1fr))`,
                  gridTemplateRows: `repeat(${gridRows}, minmax(0, 1fr))`,
                  gap: '2px',
                }
              : { position: 'relative' }
          }
        >
          {tabs.map((t, i) => {
            const inGrid = i < GRID_MAX
            let cls: string
            if (viewMode === 'tabs') {
              cls = t.id === activeId ? 'absolute inset-0' : 'hidden'
            } else if (inGrid) {
              cls =
                'relative min-h-0 min-w-0 overflow-hidden ' +
                (broadcasting
                  ? 'ring-1 ring-red-500/70'
                  : t.id === activeId
                    ? 'ring-1 ring-blue-400'
                    : 'ring-1 ring-white/10')
            } else {
              cls = 'hidden'
            }
            return (
              <div key={t.id} className={cls} onMouseDown={() => setActiveId(t.id)}>
                {viewMode === 'grid' && inGrid && (
                  <div className="pointer-events-none absolute left-0 top-0 z-10 flex items-center gap-1 rounded-br bg-black/60 px-1.5 py-0.5 text-[10px] text-gray-300">
                    <Circle size={7} className={dotColor(statuses[t.id]?.status) + ' fill-current'} />
                    {statuses[t.id]?.host ?? t.title}
                  </div>
                )}
                <TerminalView
                  ref={(h) => {
                    terminalRefs.current[t.id] = h
                  }}
                  sessionId={t.id}
                  onData={handleInput}
                />
              </div>
            )
          })}
        </div>
        {activeMsg && (
          <div className="border-t border-white/10 bg-panel px-3 py-1 text-[11px] text-gray-400">
            {activeMsg}
          </div>
        )}
      </div>

      {/* ── 우측 4 : AI 분석 패널 (공용 — 활성 탭 출력 분석) ──── */}
      <div className="w-2/5">
        <AIPanel ref={aiPanelRef} />
      </div>

      {/* 설정파일 뷰어 (SFTP) 모달 — 활성 세션 대상 */}
      {showFiles && (
        <FileViewer
          sessionId={activeId}
          connected={connected}
          onClose={() => {
            setShowFiles(false)
            setTimeout(() => activeTerm()?.focus(), 0)
          }}
          onAnalyze={(text) => aiPanelRef.current?.analyze(text)}
        />
      )}
    </div>
  )
}
