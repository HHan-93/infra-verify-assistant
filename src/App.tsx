import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Circle,
  CheckSquare,
  Square,
  PanelLeftOpen,
  PanelRightOpen,
  Search,
  ChevronUp,
  ChevronDown,
  X,
  Plug,
  Maximize2,
  Minimize2,
  Highlighter,
} from 'lucide-react'
import SSHForm, { type SSHFormHandle } from './components/SSHForm'
import Toolbar from './components/Toolbar'
import PresetPanel from './components/PresetPanel'
import ScenarioPanel from './components/ScenarioPanel'
import TerminalView, { type TerminalHandle } from './components/TerminalView'
import AIPanel, { type AIPanelHandle } from './components/AIPanel'
import Dashboard from './components/Dashboard'
import MonitorOverview from './components/MonitorOverview'
import LogViewer from './components/LogViewer'
import HighlightRulesModal from './components/HighlightRulesModal'
import FileViewer from './components/FileViewer'
import FileExplorer from './components/FileExplorer'
import LiveLogViewer from './components/LiveLogViewer'
import TunnelManager from './components/TunnelManager'
import MultiRun from './components/MultiRun'
import StatusBoard from './components/StatusBoard'
import ScenarioRunner, { type RunnerScenario } from './components/ScenarioRunner'
import TabBar, { type TabInfo, type LayoutMode, type GridGroupInfo } from './components/TabBar'
import SessionSidebar, { profileKey } from './components/SessionSidebar'
import Mascot from './components/Mascot'
import ConfirmDialog from './components/ConfirmDialog'
import type { SavedProfile, ProfileImportResult } from '../electron/shared-types'
import {
  type PaneNode,
  collectLeafTabIds,
  findLeaf,
  splitLeaf,
  closeLeaf,
  removeTabId,
  patchRatio,
  reassignTab,
  layoutTree,
  buildBalancedTree,
} from './lib/paneTree'
import {
  maskReportEnabled,
  setMaskReportEnabled,
  maskDisplayEnabled,
  setMaskDisplayEnabled,
  maskIpEnabled,
  setMaskIpEnabled,
} from './lib/mask'

/** 터미널 색상 테마 프리셋 */
const THEMES: Record<string, { name: string; background: string; foreground: string; cursor: string }> = {
  default: { name: '기본 (Catppuccin)', background: '#1e1e2e', foreground: '#cdd6f4', cursor: '#f5e0dc' },
  black: { name: '블랙', background: '#000000', foreground: '#e0e0e0', cursor: '#ffffff' },
  solarized: { name: '솔라라이즈드 다크', background: '#002b36', foreground: '#839496', cursor: '#93a1a1' },
  light: { name: '라이트', background: '#fafafa', foreground: '#2b2b2b', cursor: '#2b2b2b' },
}

/** 활동 발생 후 마스코트를 유지하다 사라지기까지의 유예(ms) */
const HIDE_GRACE = 5_000

// 동시 세션(탭) 최대 개수 — 그리드 그룹 여러 개로 나눠 쓸 수 있어 상향(폴더 통째로 그리드 열기 대비).
// 트리는 개수 제한 없이 균형 분할되므로, 화면 밀도·리소스만 고려한 값이다(필요하면 조절).
const MAX_SESSIONS = 15

/** 파킹된(비활성) 그리드 그룹 — 화면에는 splitTree(활성 그룹)만 보이고, 나머지는 칩으로만 남겨 둔다. */
interface ParkedGrid {
  id: string
  name?: string
  tree: PaneNode
}

interface SessionStatus {
  status: string
  msg: string
  /** 연결된 호스트 (탭/그리드 제목 표시용) */
  host?: string
  /** 연결된 프로필 키 (사이드바 '연결중' 표시용) */
  key?: string
  /** 연결 시작 시각(ms) — 상태바 연결시간 표시 */
  since?: number
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
  // 첫 탭도 UUID 로 채번한다. 예전엔 's1' 고정이라 앱을 재시작해도 같은 id 가 재사용됐고,
  // 그 결과 세션 id 로 뭔가를 기억하는 기능들(AI 명령 카드의 대상 검증, 상태보드 역할 매핑)이
  // '이전 실행의 다른 서버'를 같은 세션으로 착각했다.
  const [firstTabId] = useState<string>(() => crypto.randomUUID())
  const [tabs, setTabs] = useState<TabInfo[]>(() => [{ id: firstTabId, title: '세션 1' }])
  const [activeId, setActiveId] = useState<string>(firstTabId)
  const [statuses, setStatuses] = useState<Record<string, SessionStatus>>(() => ({
    [firstTabId]: { status: 'idle', msg: '' },
  }))
  const [layout, setLayoutMode] = useState<LayoutMode>('tabs')
  const [broadcast, setBroadcast] = useState(false)
  // 동시입력 대상으로 선택된 세션 ID 목록 (그리드 중 일부만 고를 수 있음)
  const [broadcastTargets, setBroadcastTargets] = useState<string[]>([])
  // 명령어 프리셋 / 시나리오 패널 (하나만 열림) — 활성 탭 대상
  const [panel, setPanel] = useState<'presets' | 'scenarios' | null>(null)
  const [showFiles, setShowFiles] = useState(false)
  const [showExplorer, setShowExplorer] = useState(false)
  const [showTunnels, setShowTunnels] = useState(false)
  const [showMultiRun, setShowMultiRun] = useState(false)
  const [runnerScenario, setRunnerScenario] = useState<RunnerScenario | null>(null)
  const [showLogViewer, setShowLogViewer] = useState(false)
  const [showHlRules, setShowHlRules] = useState(false)
  // 실시간 로그(tail -f) 뷰어 — 파일탐색기의 "실시간 보기"로 열면 prefillPath 가 채워짐
  const [showLiveLog, setShowLiveLog] = useState(false)
  const [liveLogPrefill, setLiveLogPrefill] = useState<string | undefined>(undefined)
  const [showStatusBoard, setShowStatusBoard] = useState(false)
  // 선택 세션 AI 분석 — 질문 입력 모달 (공용)
  const [analysisPending, setAnalysisPending] = useState<string | null>(null)
  const [analysisLabel, setAnalysisLabel] = useState('선택 세션 AI 분석')
  const [analysisQuestion, setAnalysisQuestion] = useState('')
  // AI 패널이 이미 스트리밍 중이라 analyze() 가 무시됐을 때만 채워지는 안내 문구
  const [analysisBusyNotice, setAnalysisBusyNotice] = useState('')
  // 세션 프로필 가져오기(CSV/JSON) 결과 — 완료 후 요약 모달에 표시
  const [importResult, setImportResult] = useState<ProfileImportResult | null>(null)
  // 가져오기 전 형식 안내 + 템플릿 다운로드 모달
  const [showImportGuide, setShowImportGuide] = useState(false)
  // 우측 AI 패널 표시 여부 (기본 열림, 사용자가 토글 가능)
  const [showAI, setShowAI] = useState(true)
  // 우측 패널 탭 (AI 분석 / 대시보드 모니터링)
  const [rightTab, setRightTab] = useState<'ai' | 'dashboard' | 'overview'>('ai')
  // 좌측 세션 사이드바 표시 여부 (기본 열림)
  const [showSidebar, setShowSidebar] = useState(true)
  // AI 패널 너비(px) — 드래그로 조절, localStorage 보존
  const [aiWidth, setAiWidth] = useState(() => Number(localStorage.getItem('ai_width')) || 460)
  const aiWidthRef = useRef(aiWidth)
  const aiDragRef = useRef(false)
  // 저장된 SSH 세션 프로필 목록 (App 이 단일 소스)
  const [profiles, setProfiles] = useState<SavedProfile[]>([])
  // 재연결 타이머처럼 '나중에' 실행되는 코드가 최신 프로필을 읽도록 하는 미러
  const profilesRef = useRef<SavedProfile[]>([])
  profilesRef.current = profiles
  // 사이드바 더블클릭/클러스터 열기 → 탭 폼이 마운트되면 연결 (지연 연결 큐)
  const [pendingConnects, setPendingConnects] = useState<{ id: string; p: SavedProfile }[]>([])
  // 사이드바에서 터미널로 드래그 중인 프로필 (드롭 오버레이 표시)
  const [draggingProfile, setDraggingProfile] = useState<SavedProfile | null>(null)
  // 드래그 중인 프로필을 ref 로도 유지 — 드롭(onDrop) 시점에 React 상태가 dragend/리렌더 타이밍으로
  // 잠깐 비어 dropConnect 가 조용히 무시되던 문제(셀이 흰 점/idle 로 남음)를 막는다.
  const draggingProfileRef = useRef<SavedProfile | null>(null)
  // 드래그가 올라가 있는 터미널 세션 id (하이라이트)
  const [dragOverId, setDragOverId] = useState<string | null>(null)
  // 탭을 그리드 칸으로 드래그 중인 탭 id
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null)
  // 그리드 모드에서 인라인 SSH 연결 폼이 열려있는 셀의 세션 id — 상단 공용 폼과 분리되어
  // 이 칸을 선택(클릭)한다고 해서 자동으로 열리거나 닫히지 않는다(레이아웃 흔들림 방지).
  const [openConnectCellId, setOpenConnectCellId] = useState<string | null>(null)
  // 유휴 마스코트 표시 여부 (입력/출력/마우스 없을 때 등장)
  const [idle, setIdle] = useState(false)
  // 마스코트 리액션(놀람/슬픔) 트리거 — 마스코트가 이미 나와있을 때(idle)만 반영됨.
  // nonce 는 Date.now() 대신 단조 증가 카운터를 쓴다 — 같은 렌더 배치에서 여러 세션이 동시에
  // 끊기는 등 짧은 시간 안에 연달아 트리거되면 Date.now() 는 밀리초 해상도상 같은 값이 나올 수
  // 있어, Mascot 쪽에서 "새 이벤트"로 인식하지 못하고 묻힐 수 있었다.
  const [mascotReaction, setMascotReaction] = useState<{ type: 'surprised' | 'sad'; nonce: number } | null>(null)
  const mascotNonceRef = useRef(0)
  const triggerMascotReaction = (type: 'surprised' | 'sad') => {
    if (!idle) return
    setMascotReaction({ type, nonce: ++mascotNonceRef.current })
  }
  // SSH 폼(상단 공용 / 그리드 셀 인라인) 공통 연결 성공 처리
  const handleSessionConnected = (tabId: string, p: SavedProfile) => {
    setStatuses((m) => ({
      ...m,
      [tabId]: {
        status: 'connected',
        msg: m[tabId]?.msg ?? '',
        host: p.host,
        key: profileKey(p),
        since: m[tabId]?.since ?? Date.now(),
      },
    }))
    if (p.color) {
      setTabs((ts) => ts.map((tab) => (tab.id === tabId ? { ...tab, color: p.color } : tab)))
    }
  }
  // 터미널 검색바 (Ctrl+F)
  const [showFind, setShowFind] = useState(false)
  const [findTerm, setFindTerm] = useState('')
  // 로그 기록 중인 세션 ID 집합
  const [loggingSessions, setLoggingSessions] = useState<Set<string>>(new Set())
  // 상태바: 활성 세션 지연시간(ms) + 연결시간 갱신용 틱
  const [latency, setLatency] = useState<number | null>(null)
  const [, setNowTick] = useState(0)
  // 외형 설정 (글꼴 크기 / 테마) — localStorage 보존
  const [showSettings, setShowSettings] = useState(false)
  const [fontSize, setFontSize] = useState(() => Number(localStorage.getItem('term_font_size')) || 13)
  const [themeKey, setThemeKey] = useState(() => localStorage.getItem('term_theme') || 'default')
  const theme = THEMES[themeKey] ?? THEMES.default
  // 출력 하이라이트(기본 ON) / 시작 시 세션 복원(기본 OFF)
  const [highlight, setHighlight] = useState(() => localStorage.getItem('term_highlight') !== '0')
  const [restoreOnLaunch, setRestoreOnLaunch] = useState(
    () => localStorage.getItem('restore_sessions') === '1',
  )
  // 작업 중 예기치 않게 끊긴 세션을 자동으로 다시 연결 (기본 OFF — 사용자가 켬)
  const [autoReconnect, setAutoReconnect] = useState(
    () => localStorage.getItem('auto_reconnect') === '1',
  )
  // 민감정보 마스킹 — 리포트 저장/AI 전송 시(기본 ON) / 로그 화면 표시(기본 OFF) / IP까지(기본 OFF)
  const [maskReport, setMaskReport] = useState(() => maskReportEnabled())
  const [maskDisplay, setMaskDisplay] = useState(() => maskDisplayEnabled())
  const [maskIp, setMaskIp] = useState(() => maskIpEnabled())
  // 유휴 마스코트 등장까지의 시간(ms) — 기본 5분, 외형 설정에서 조절 가능
  const [idleDelayMs, setIdleDelayMs] = useState(() => {
    // 0('끄기')도 유효값으로 보존 — `|| 기본값` 을 쓰면 0 이 falsy 라 기본값으로 되돌아간다.
    const raw = localStorage.getItem('mascot_idle_delay_ms')
    const n = raw == null ? NaN : Number(raw)
    return Number.isFinite(n) ? n : 300_000
  })
  const idleDelayRef = useRef(idleDelayMs)
  useEffect(() => {
    idleDelayRef.current = idleDelayMs
  }, [idleDelayMs])
  const changeIdleDelay = (ms: number) => {
    setIdleDelayMs(ms)
    localStorage.setItem('mascot_idle_delay_ms', String(ms))
  }
  // 임의 재귀 분할 레이아웃(tmux 스타일) — null 이면 탭 보기와 동일(단일 리프로 취급)
  // splitTree 는 항상 "활성 그리드 그룹"의 트리다. 나머지 그룹은 parkedGrids 에 칩으로만 보관.
  const [splitTree, setSplitTree] = useState<PaneNode | null>(null)
  // 파킹된(비활성) 그리드 그룹들 — 칩으로만 존재하고, 클릭하면 활성 그룹과 자리를 바꾼다.
  const [parkedGrids, setParkedGrids] = useState<ParkedGrid[]>([])
  // 활성 그룹(=splitTree)의 id. splitTree 가 non-null 이면 반드시 유효한 id 를, null 이면 null 을 유지한다(INVARIANT).
  const [activeGridId, setActiveGridId] = useState<string | null>(null)
  // 그리드 그룹 id 채번용
  const gridSeqRef = useRef(0)
  const newGridId = () => `grid${++gridSeqRef.current}`
  const termAreaRef = useRef<HTMLDivElement>(null)
  // 분할선 드래그 리사이즈 대상 — 어느 분할(split) 노드의 비율을 조정 중인지
  const resizeDragRef = useRef<{ nodeId: string; dir: 'row' | 'col' } | null>(null)
  // 분할 트리 노드 id 채번용
  const paneIdCounter = useRef(0)
  const nextPaneId = () => `p${++paneIdCounter.current}`
  // 프리셋/시나리오 패널 높이(px) — 드래그로 조절, localStorage 보존
  const [panelHeight, setPanelHeight] = useState(() => Number(localStorage.getItem('panel_height')) || 320)
  const panelHeightRef = useRef(panelHeight)
  const panelDragRef = useRef(false)
  const panelWrapRef = useRef<HTMLDivElement>(null)

  // 세션별 터미널 핸들
  const terminalRefs = useRef<Record<string, TerminalHandle | null>>({})
  // 세션별 SSH 폼 핸들 (사이드바에서 연결 트리거)
  const sshFormRefs = useRef<Record<string, SSHFormHandle | null>>({})
  const aiPanelRef = useRef<AIPanelHandle>(null)
  // 마지막 활동 시각 (유휴 마스코트 판정용)
  const lastActivityRef = useRef(Date.now())
  // 세션 복원 1회 수행 가드
  const restoredRef = useRef(false)
  // 마스코트 표시 중 여부(ref 미러) + 활동 후 사라질 예정 시각
  const idleRef = useRef(false)
  const hideAtRef = useRef(0)

  const activeStatus = statuses[activeId]?.status ?? 'idle'
  const activeMsg = statuses[activeId]?.msg ?? ''
  const connected = activeStatus === 'connected'
  const activeTerm = () => terminalRefs.current[activeId] ?? null

  // 분할 모드 여부 — 트리 렌더/브로드캐스트 대상 계산 등에서 공용으로 사용
  const isSplit = layout === 'split'
  // 활성 그룹(=splitTree)의 멤버 세션 id 목록
  const activeMembers = splitTree ? collectLeafTabIds(splitTree) : []
  // 파킹된 그룹들의 멤버 세션 id 목록(모든 파킹 그룹 합산)
  const parkedMembers = parkedGrids.flatMap((g) => collectLeafTabIds(g.tree))
  // 모든 그리드 그룹(활성+파킹)에 속한 세션 id — 탭바에서 개별 탭으로 표시하지 않도록 숨긴다.
  const allGridTabIds = [...activeMembers, ...parkedMembers]
  // 분할 트리가 현재 화면에 보여주는 세션 id 목록 (중복 가능 — 스페어 탭 없이 분할한 경우)
  const gridIds = isSplit && splitTree ? activeMembers : []
  // 동시입력 실제 대상 = 선택된 세션 ∩ 현재 분할 (닫힌/분할 밖 세션 자동 제외).
  // gridIds 는 스페어 없는 분할 시 같은 id 가 중복될 수 있어 Set 으로 한 번 걸러 이중 입력을 막는다.
  // SSH 로 '연결된' 칸만 대상으로 삼는다. 미연결 칸에는 로컬 셸(cmd.exe/bash)이 붙어 있어서,
  // 상태를 안 보고 보내면 서버에 칠 명령이 운영자 PC 에서 실행된다(끊긴 칸이 섞이면 특히 위험).
  const effectiveTargets = [
    ...new Set(gridIds.filter((id) => broadcastTargets.includes(id) && statuses[id]?.status === 'connected')),
  ]
  // 대상으로 골라뒀지만 연결이 끊겨 제외된 칸 수 — 배너에 알려 사용자가 착각하지 않게 한다.
  const droppedTargetCount = new Set(gridIds.filter((id) => broadcastTargets.includes(id))).size - effectiveTargets.length
  // 실제 브로드캐스트 활성 여부 (분할 모드 + 동시입력 ON + 대상 1개 이상)
  const broadcasting = isSplit && broadcast && effectiveTargets.length > 0
  // 분할 가능 여부 — 아직 트리에 없는 스페어 탭이 있거나, 세션을 더 만들 여유가 있으면 항상 분할 가능
  const canSplit = new Set(gridIds).size < MAX_SESSIONS
  // 그리드 셀이 많아 좁을 때, 특정 칸만 팝업처럼 크게 확대해서 보는 기능 — 그리드 안에 있는
  // 탭이 아니게 되면(칸이 닫히는 등) 자동으로 무효 처리
  const [zoomedId, setZoomedId] = useState<string | null>(null)
  const zoomActive = isSplit && !!zoomedId && gridIds.includes(zoomedId)
  // 그리드 그룹 사용자 지정 이름(없으면 "그리드 N"). 그리드가 완전히 해제(splitTree=null)되면 초기화.
  const [gridLabel, setGridLabel] = useState<string | null>(null)
  useEffect(() => {
    if (!splitTree) setGridLabel(null)
  }, [splitTree])
  // 활성 세션이 분할 트리 안에 있고, 트리에 칸이 2개 이상일 때만 "칸 닫기" 가능
  const canClosePane = isSplit && !!splitTree && splitTree.type === 'split' && !!findLeaf(splitTree, activeId)

  // 탭바에 넘길 그리드 그룹 목록 — 활성 그룹(있으면) + 파킹 그룹들. active 는 현재 분할 보기 중인 그룹만 true.
  const gridGroups: GridGroupInfo[] = [
    ...(splitTree
      ? [{ id: activeGridId!, name: gridLabel ?? undefined, memberIds: activeMembers, active: isSplit }]
      : []),
    ...parkedGrids.map((g) => ({ id: g.id, name: g.name, memberIds: collectLeafTabIds(g.tree), active: false })),
  ]

  // 현재 연결되어 있는 프로필 키 집합 (사이드바 '연결중' 표시)
  const connectedKeys = new Set(
    tabs
      .filter((t) => statuses[t.id]?.status === 'connected' && statuses[t.id]?.key)
      .map((t) => statuses[t.id]!.key as string),
  )

  // 그리드(다중 세션) 셀 헤더용 — 여러 세션이 동시에 보일 땐 어떤 세션인지 구분되도록 "별칭 (IP)" 형태로 표시
  const gridCellLabel = (t: TabInfo) => {
    if (t.custom) return t.title
    const host = statuses[t.id]?.host
    if (!host) return t.title
    const key = statuses[t.id]?.key
    const label = key ? profiles.find((p) => profileKey(p) === key)?.label?.trim() : undefined
    return label ? `${label} (${host})` : host
  }

  // 저장된 세션 프로필 로드 (앱 시작 시 1회)
  useEffect(() => {
    window.electronAPI.profilesList().then(setProfiles)
  }, [])

  // 현재 연결된 세션 구성을 저장 (복원용)
  useEffect(() => {
    const data = tabs
      .map((t) => ({ key: statuses[t.id]?.key, title: t.custom ? t.title : undefined, custom: t.custom }))
      .filter((x) => x.key)
    localStorage.setItem('session_restore', JSON.stringify(data))
  }, [tabs, statuses])

  // 시작 시 이전 세션 복원 (설정 ON + 프로필 로드 후 1회, 자동 재연결)
  useEffect(() => {
    if (restoredRef.current || !restoreOnLaunch || !profiles.length) return
    restoredRef.current = true
    try {
      const data = JSON.parse(localStorage.getItem('session_restore') || '[]') as {
        key: string
        title?: string
        custom?: boolean
      }[]
      const valid = data
        .map((d) => ({ d, p: profiles.find((x) => profileKey(x) === d.key) }))
        .filter((x): x is { d: typeof x.d; p: SavedProfile } => !!x.p)
        .slice(0, MAX_SESSIONS) // 손상/과다 복원 데이터가 세션 상한을 넘기지 않게 제한
      if (!valid.length) return
      const ids = valid.map((v, i) => {
        const id = i === 0 ? tabs[0].id : createTab()
        if (v.d.custom && v.d.title) renameTab(id, v.d.title)
        return id
      })
      setActiveId(ids[0])
      setPendingConnects(valid.map((v, i) => ({ id: ids[i], p: v.p })))
    } catch {
      /* 복원 데이터 손상 시 무시 */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profiles, restoreOnLaunch])

  // 상태바: 활성 세션 지연시간 측정 + 연결시간 갱신 (5초 주기)
  useEffect(() => {
    setLatency(null)
    let alive = true
    const measure = async () => {
      setNowTick((t) => t + 1)
      if (statuses[activeId]?.status !== 'connected') {
        setLatency(null)
        return
      }
      const t0 = performance.now()
      const r = await window.electronAPI.sessionRun(activeId, 'true')
      if (alive) setLatency(r.ok ? Math.round(performance.now() - t0) : null)
    }
    measure()
    const timer = setInterval(measure, 5000)
    return () => {
      alive = false
      clearInterval(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, statuses[activeId]?.status])

  // AI 패널 너비 드래그 리사이즈 (우측 → 화면 우측 끝과 커서 거리)
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!aiDragRef.current) return
      const w = Math.max(300, Math.min(window.innerWidth * 0.7, window.innerWidth - e.clientX))
      aiWidthRef.current = w
      setAiWidth(w)
    }
    const onUp = () => {
      if (!aiDragRef.current) return
      aiDragRef.current = false
      document.body.style.cursor = ''
      localStorage.setItem('ai_width', String(Math.round(aiWidthRef.current)))
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [])

  // 프리셋/시나리오 패널 높이 드래그 리사이즈
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!panelDragRef.current) return
      const el = panelWrapRef.current
      if (!el) return
      const r = el.getBoundingClientRect()
      const h = Math.max(160, Math.min(window.innerHeight * 0.7, e.clientY - r.top))
      panelHeightRef.current = h
      setPanelHeight(h)
    }
    const onUp = () => {
      if (!panelDragRef.current) return
      panelDragRef.current = false
      document.body.style.cursor = ''
      localStorage.setItem('panel_height', String(Math.round(panelHeightRef.current)))
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [])

  // 분할선 드래그 리사이즈 — 어느 분할 노드를 조정 중인지는 resizeDragRef, 최신 트리는 ref로 미러링
  const splitTreeRef = useRef(splitTree)
  useEffect(() => {
    splitTreeRef.current = splitTree
  }, [splitTree])
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const el = termAreaRef.current
      const drag = resizeDragRef.current
      const tree = splitTreeRef.current
      if (!el || !drag || !tree) return
      const areaRect = el.getBoundingClientRect()
      const { nodeRects } = layoutTree(tree)
      const rect = nodeRects[drag.nodeId]
      if (!rect) return
      const mxPct = ((e.clientX - areaRect.left) / areaRect.width) * 100
      const myPct = ((e.clientY - areaRect.top) / areaRect.height) * 100
      const ratio = drag.dir === 'row' ? (mxPct - rect.left) / rect.width : (myPct - rect.top) / rect.height
      setSplitTree((t) => (t ? patchRatio(t, drag.nodeId, ratio) : t))
    }
    const onUp = () => {
      resizeDragRef.current = null
      document.body.style.cursor = ''
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [])

  // 그리드 셀 헤더 드래그(칸끼리 자리 맞바꿈) — 네이티브 HTML5 DnD 대신 마우스 좌표 추적 방식.
  // 헤더 위 텍스트에서 드래그를 시작하면 브라우저가 엘리먼트 드래그 대신 텍스트 선택/포커스
  // 이동으로 가로채 dragstart 자체가 안 일어나는 문제가 있어, 직접 mousemove/mouseup 으로 구현.
  const gridDragRef = useRef<{ tabId: string; startX: number; startY: number; moved: boolean } | null>(null)
  const leafAtPoint = (mxPct: number, myPct: number) => {
    const tree = splitTreeRef.current
    if (!tree) return null
    const { leaves } = layoutTree(tree)
    return (
      leaves.find(
        (l) => mxPct >= l.left && mxPct <= l.left + l.width && myPct >= l.top && myPct <= l.top + l.height,
      ) ?? null
    )
  }
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const drag = gridDragRef.current
      const el = termAreaRef.current
      if (!drag || !el) return
      if (!drag.moved) {
        if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < 6) return
        drag.moved = true
        setDraggingTabId(drag.tabId)
        document.body.style.cursor = 'grabbing'
      }
      const areaRect = el.getBoundingClientRect()
      const mxPct = ((e.clientX - areaRect.left) / areaRect.width) * 100
      const myPct = ((e.clientY - areaRect.top) / areaRect.height) * 100
      const hovered = leafAtPoint(mxPct, myPct)
      setDragOverId(hovered ? hovered.tabId : null)
    }
    const onUp = (e: MouseEvent) => {
      const drag = gridDragRef.current
      gridDragRef.current = null
      document.body.style.cursor = ''
      const el = termAreaRef.current
      if (!drag?.moved || !el) {
        setDraggingTabId(null)
        setDragOverId(null)
        return
      }
      const areaRect = el.getBoundingClientRect()
      const mxPct = ((e.clientX - areaRect.left) / areaRect.width) * 100
      const myPct = ((e.clientY - areaRect.top) / areaRect.height) * 100
      const hovered = leafAtPoint(mxPct, myPct)
      if (hovered) {
        setSplitTree((t) => (t ? reassignTab(t, hovered.leafId, drag.tabId) : t))
      }
      setDraggingTabId(null)
      setDragOverId(null)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 유휴 감지 — idleDelayMs(외형 설정에서 조절) 동안 활동 없으면 등장. 등장 중 활동이 생기면
  // 즉시 사라지지 않고 HIDE_GRACE(5초) 유지 후 사라짐.
  useEffect(() => {
    const bump = () => {
      const now = Date.now()
      lastActivityRef.current = now
      // 마스코트가 떠 있는 동안에는 '첫 활동' 시점에만 사라질 시각을 고정한다.
      // (마우스 움직임마다 계속 미루면 5초를 넘겨 사라지므로, 활성화 후 정확히 HIDE_GRACE 뒤 제거)
      if (idleRef.current && !hideAtRef.current) hideAtRef.current = now + HIDE_GRACE
    }
    window.addEventListener('keydown', bump)
    window.addEventListener('mousedown', bump)
    window.addEventListener('mousemove', bump)
    const offData = window.electronAPI.onTerminalData(() => bump()) // 터미널 출력도 활동으로 간주
    const timer = setInterval(() => {
      const now = Date.now()
      if (!idleRef.current) {
        // 미표시 → 충분히 유휴면 등장 (idleDelay <= 0 은 '끄기' → 등장 안 함)
        if (idleDelayRef.current > 0 && now - lastActivityRef.current > idleDelayRef.current) {
          idleRef.current = true
          hideAtRef.current = 0
          setIdle(true)
        }
      } else {
        // 표시 중 → '끄기'로 바뀌었거나 예약된 사라짐 시각이 지나면 숨김
        if (idleDelayRef.current <= 0 || (hideAtRef.current && now >= hideAtRef.current)) {
          idleRef.current = false
          hideAtRef.current = 0
          setIdle(false)
        }
      }
    }, 250)
    return () => {
      window.removeEventListener('keydown', bump)
      window.removeEventListener('mousedown', bump)
      window.removeEventListener('mousemove', bump)
      offData()
      clearInterval(timer)
    }
  }, [])

  // 지연 연결: 큐의 각 항목 폼이 마운트되면 connectProfile 호출
  useEffect(() => {
    if (!pendingConnects.length) return
    const remaining = pendingConnects.filter((pc) => {
      const h = sshFormRefs.current[pc.id]
      if (h) {
        h.connectProfile(pc.p)
        return false
      }
      return true
    })
    if (remaining.length !== pendingConnects.length) setPendingConnects(remaining)
  }, [pendingConnects, tabs])

  // 메인 프로세스(ssh2)가 보내는 연결 상태 이벤트 구독 (sessionId 별로 반영)
  useEffect(() => {
    const off = window.electronAPI.onStatus((event) => {
      setStatuses((m) => {
        const prev = m[event.sessionId]
        // 연결/연결중일 때만 host 유지, 끊기면 제거 (제목이 기본으로 복귀)
        // key(프로필 식별자)는 끊겨도 보존 — 자동 재연결(scheduleReconnect)이 이 값으로 프로필을 찾기 때문.
        const keepHost = event.status === 'connected' || event.status === 'connecting'
        return {
          ...m,
          [event.sessionId]: {
            status: event.status,
            msg: event.message ?? prev?.msg ?? '',
            host: keepHost ? prev?.host : undefined,
            key: prev?.key,
            since:
              event.status === 'connected'
                ? prev?.status === 'connected'
                  ? prev?.since
                  : Date.now()
                : undefined,
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
  }, [panel, activeId, layout, tabs.length, showAI, showSidebar])

  // 세션별 상태 전환에 따른 터미널 시각 표시 (연결 시작/종료/오류)
  const prevStatuses = useRef<Record<string, string>>({})
  // 자동 재연결 상태 — 세션별 시도 횟수 / 예약 타이머. manualClosingRef 는 사용자가 직접 닫은 세션(재연결 제외).
  const reconnectRef = useRef<{ attempts: Record<string, number>; timers: Record<string, ReturnType<typeof setTimeout>> }>({
    attempts: {},
    timers: {},
  })
  const manualClosingRef = useRef<Set<string>>(new Set())
  const RECONNECT_BACKOFF_MS = [3000, 6000, 12000, 20000] // 시도별 대기(마지막 값 이후 포기)

  // 예기치 않게 끊긴 세션을 프로필로 다시 연결 예약 (백오프 + 최대 시도 제한)
  const scheduleReconnect = (id: string) => {
    const rc = reconnectRef.current
    const attempt = rc.attempts[id] ?? 0
    const term = terminalRefs.current[id]
    if (attempt >= RECONNECT_BACKOFF_MS.length) {
      term?.writeNotice(`자동 재연결 ${attempt}회 실패 — 중단했습니다. SSH 정보를 입력해 수동으로 연결하세요.`)
      return
    }
    // 이 세션의 프로필 찾기 (상태에 보관된 key → 저장 프로필). 못 찾으면 자동 재연결 불가.
    const key = statuses[id]?.key
    if (!key || !profiles.some((p) => profileKey(p) === key)) {
      term?.writeNotice('자동 재연결할 프로필 정보를 찾지 못했습니다. 수동으로 연결하세요.')
      return
    }
    const delay = RECONNECT_BACKOFF_MS[attempt]
    rc.attempts[id] = attempt + 1
    term?.writeNotice(`자동 재연결 예약: ${Math.round(delay / 1000)}초 후 재시도 (${attempt + 1}/${RECONNECT_BACKOFF_MS.length})`)
    if (rc.timers[id]) clearTimeout(rc.timers[id])
    rc.timers[id] = setTimeout(() => {
      delete rc.timers[id]
      // 그 사이 사용자가 탭을 닫았거나 이미 다시 연결됐으면 중단
      if (manualClosingRef.current.has(id)) return
      if (statuses[id]?.status === 'connected' || statuses[id]?.status === 'connecting') return
      // 대기하는 동안 사용자가 사이드바에서 host/비밀번호를 고쳤을 수 있으므로, 예약 시점에
      // 붙잡아 둔 값이 아니라 '지금' 저장된 프로필로 다시 찾아서 연결한다.
      const profile = profilesRef.current.find((p) => profileKey(p) === key)
      if (!profile) {
        terminalRefs.current[id]?.writeNotice('자동 재연결할 프로필이 삭제되어 중단합니다. 수동으로 연결하세요.')
        return
      }
      terminalRefs.current[id]?.writeNotice('자동 재연결 시도 중…')
      // 폼 ref 마운트 타이밍을 처리하는 지연 연결 큐에 넣는다(끊긴 셀은 SSH 폼이 다시 마운트됨).
      setPendingConnects((prev) => (prev.some((pc) => pc.id === id) ? prev : [...prev, { id, p: profile }]))
    }, delay)
  }

  useEffect(() => {
    for (const t of tabs) {
      const cur = statuses[t.id]?.status ?? 'idle'
      const prev = prevStatuses.current[t.id] ?? 'idle'
      if (cur === prev) continue
      prevStatuses.current[t.id] = cur
      const term = terminalRefs.current[t.id]
      if (cur === 'connecting') {
        term?.reset()
        // 재연결 예약 타이머가 남아 있으면 취소 — 수동 재연결이 시작됐거나 이미 연결 시도 중이라
        // 뒤늦게 타이머가 발화해 중복 연결하는 것을 막는다(오래된 statuses 클로저 방지).
        const rc = reconnectRef.current
        if (rc.timers[t.id]) {
          clearTimeout(rc.timers[t.id])
          delete rc.timers[t.id]
        }
      } else if (cur === 'connected') {
        // 재연결 성공(또는 정상 연결) — 시도 카운터/타이머 초기화
        const rc = reconnectRef.current
        if (rc.attempts[t.id]) term?.writeNotice('연결이 복구되었습니다.')
        rc.attempts[t.id] = 0
        if (rc.timers[t.id]) {
          clearTimeout(rc.timers[t.id])
          delete rc.timers[t.id]
        }
        manualClosingRef.current.delete(t.id)
      } else if (cur === 'closed' || cur === 'error') {
        // 끊김 원인: 정상 연결 상태에서의 드롭(prev==='connected') 또는
        // 재연결 시도(prev==='connecting')가 실패한 경우 — 후자는 진행 중인 재시도 사이클을 이어간다.
        const inCycle = (reconnectRef.current.attempts[t.id] ?? 0) > 0 && prev === 'connecting'
        const droppedFromConnected = prev === 'connected'
        if (droppedFromConnected) triggerMascotReaction('sad')
        if (
          autoReconnect &&
          !manualClosingRef.current.has(t.id) &&
          (droppedFromConnected || inCycle)
        ) {
          scheduleReconnect(t.id)
        } else if (droppedFromConnected) {
          term?.writeNotice(
            cur === 'error'
              ? '연결이 끊겼습니다 (오류).'
              : '연결이 종료되었습니다. 다시 연결하려면 SSH 정보를 입력하세요.',
          )
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statuses, tabs, autoReconnect])

  // 자동 재연결 설정을 백엔드에 동기화(마운트 포함) + 끄면 예약돼 있던 재연결 타이머를 모두 취소
  useEffect(() => {
    window.electronAPI.sshSetAutoReconnect(autoReconnect)
    if (autoReconnect) return
    const rc = reconnectRef.current
    Object.values(rc.timers).forEach((t) => clearTimeout(t))
    rc.timers = {}
    rc.attempts = {}
  }, [autoReconnect])

  // 그리드 셀 인라인 연결 폼 — 연결에 성공하면 자동으로 닫고 터미널을 보여준다
  useEffect(() => {
    if (openConnectCellId && statuses[openConnectCellId]?.status === 'connected') {
      setOpenConnectCellId(null)
    }
  }, [openConnectCellId, statuses])

  // ── 탭 추가/닫기 / 보기 모드 ──────────────────────────────────
  // 새 탭 생성 (활성 전환은 호출부에서). 생성된 id 반환
  const createTab = (): string => {
    // 렌더러 HMR(개발 모드 핫리로드) 재시작 시에도 절대 겹치지 않도록 카운터 대신 UUID 사용 —
    // main 프로세스의 세션 Map은 렌더러와 별개로 살아있어, 카운터가 리셋되면 과거에 쓰던 id와
    // 겹쳐 죽은 세션 정보를 재사용해버리는 문제가 있었다.
    const id = crypto.randomUUID()
    setTabs((t) => [...t, { id, title: `세션 ${t.length + 1}` }])
    setStatuses((m) => ({ ...m, [id]: { status: 'idle', msg: '' } }))
    return id
  }

  // 탭 선택 — 분할 모드에서 현재 트리에 없는 탭(스페어 탭, 방금 만든 새 탭 등)을 고르면 그
  // 탭은 어느 칸에도 그려지지 않아 "선택했는데 화면에 안 보이는" 상태가 된다. 그 경우 탭(단일)
  // 보기로 전환해 방금 고른 세션을 바로 보여준다 — splitTree 자체는 그대로 둬서, 다시 분할
  // 프리셋을 누르면 기존 그리드를 이어서 쓸 수 있다.
  const selectTab = (id: string) => {
    setActiveId(id)
    if (layout === 'split' && splitTree && !findLeaf(splitTree, id)) {
      setLayoutMode('tabs')
    }
  }

  const addTab = () => {
    if (tabs.length >= MAX_SESSIONS) return
    selectTab(createTab())
  }


  // 레이아웃 전환 — 탭(단일) 보기로 가면 동시입력 해제(오작동 방지) 하고, 분할용으로 자동
  // 추가됐다가 한 번도 연결 안 해본(idle) 빈 세션 탭은 정리한다 — 연결됐거나 연결 시도/오류
  // 이력이 있는 세션(closed/error/connecting)은 다시 쓸 수 있어야 하니 그대로 둔다.
  const setLayout = (l: LayoutMode) => {
    setLayoutMode(l)
    if (l !== 'tabs') return
    setBroadcast(false)
    // 어떤 그리드 그룹(활성이든 파킹이든)에도 속하지 않은 '겉도는' 미접속 탭만 정리한다.
    // 그리드 칸은 SSH 를 안 붙였어도 로컬 셸로 실제 작업 중일 수 있고(가로/세로 나누기로 만든 칸이
    // 대표적), 사용자는 칩으로 언제든 그 그룹에 돌아온다. 여기서 지우면 확인창도 없이 작업 내용이
    // 사라진다 — 그룹 정리는 칩의 X 로만 하도록 한다.
    const gridMemberIds = new Set(allGridTabIds)
    const idleIds = tabs
      .filter((t) => t.id !== activeId && !gridMemberIds.has(t.id) && (statuses[t.id]?.status ?? 'idle') === 'idle')
      .map((t) => t.id)
    if (!idleIds.length) return
    idleIds.forEach((id) => window.electronAPI.sessionClose(id))
    setTabs((ts) => ts.filter((t) => !idleIds.includes(t.id)))
    setStatuses((m) => {
      const c = { ...m }
      idleIds.forEach((id) => delete c[id])
      return c
    })
    setOpenConnectCellId((cur) => (cur && idleIds.includes(cur) ? null : cur))
    setBroadcastTargets((bt) => bt.filter((id) => !idleIds.includes(id)))
    // 아직 폼이 안 뜬 채 닫힌 탭의 예약 연결은 영영 소비되지 않는다. 비밀번호를 품은 채로
    // 메모리에 남으므로 여기서 함께 버린다.
    setPendingConnects((q) => q.filter((pc) => !idleIds.includes(pc.id)))
    // 위에서 그리드 멤버를 제외했으므로 트리에 손댈 일은 없지만, 혹시 모를 잔여 참조는
    // 죽은 칸 자동 정리 이펙트가 걷어낸다.
  }

  // ── 그리드 그룹 활성/파킹 헬퍼 ──
  // INVARIANT: splitTree 가 non-null 이면 activeGridId 도 유효해야 하고, null 이면 둘 다 null.
  const activateGrid = (tree: PaneNode, id: string, name: string | null) => {
    setSplitTree(tree)
    setActiveGridId(id)
    setGridLabel(name)
  }
  const clearActiveGrid = () => {
    setSplitTree(null)
    setActiveGridId(null)
    setGridLabel(null)
  }
  // 현재 활성 그룹을 파킹 목록에 넣은(교체) 새 목록을 돌려준다 — 현재 클로저의 splitTree/activeGridId/gridLabel 을 읽는다.
  const parkActiveInto = (list: ParkedGrid[]): ParkedGrid[] =>
    splitTree && activeGridId
      ? [...list.filter((g) => g.id !== activeGridId), { id: activeGridId, name: gridLabel ?? undefined, tree: splitTree }]
      : list

  // 탭바의 "그리드 그룹" 진입점 — 해당 그룹을 활성(분할 보기)으로 올린다. 다른 그룹이던 것이면 현재 활성 그룹은 파킹.
  const selectGrid = (groupId?: string, memberId?: string) => {
    // 활성 그룹(또는 그룹 지정 없음) → 오늘과 동일하게 활성 그룹의 분할 보기로 진입.
    if (!groupId || groupId === activeGridId) {
      if (!splitTree) return
      // 활성 세션이 그리드 밖(스페어 탭 등)이면 분할 진입 시 활성 칸이 하나도 강조되지 않고 입력이
      // 화면에 없는 터미널로 새므로, 그리드 첫 칸으로 activeId 를 보정한다.
      const target =
        memberId && findLeaf(splitTree, memberId)
          ? memberId
          : findLeaf(splitTree, activeId)
            ? activeId
            : collectLeafTabIds(splitTree)[0]
      if (target) setActiveId(target)
      setLayoutMode('split')
      return
    }
    // 파킹된 다른 그룹 → 현재 활성 그룹을 파킹하고, 그 그룹을 활성으로 교체.
    const target = parkedGrids.find((g) => g.id === groupId)
    if (!target) return
    const nextParked = parkActiveInto(parkedGrids.filter((g) => g.id !== groupId))
    setParkedGrids(nextParked)
    // 다른 그룹으로 넘어갈 때 동시입력은 끈다 — 안 끄면 A그룹에서 켜둔 동시입력이 B를 거쳐
    // A로 돌아왔을 때 사용자가 다시 켠 적도 없는데 살아나 여러 서버에 한꺼번에 입력된다.
    setBroadcast(false)
    activateGrid(target.tree, target.id, target.name ?? null)
    setActiveId(memberId && findLeaf(target.tree, memberId) ? memberId : collectLeafTabIds(target.tree)[0])
    setLayoutMode('split')
  }
  // 그리드 그룹 해제 — 그리드 묶음만 풀고 세션은 개별 탭으로 유지. 활성 그룹이면 트리를 제거하고 단일 보기로,
  // 파킹 그룹이면 목록에서만 뺀다(멤버는 이미 일반 탭).
  const dissolveGrid = (groupId?: string) => {
    if (!groupId || groupId === activeGridId) {
      // "그룹 해제 (세션 유지)" — 묶음만 풀고 멤버는 개별 탭으로 남겨야 하므로, idle 셀까지 닫는
      // setLayout('tabs') 의 정리 로직은 쓰지 않는다. 단일 보기로 전환 + 동시입력만 해제.
      setLayoutMode('tabs')
      setBroadcast(false)
      clearActiveGrid() // 활성 트리는 제거(칩도 사라짐), 멤버 탭은 유지
      return
    }
    setParkedGrids((prev) => prev.filter((g) => g.id !== groupId))
  }

  // (안전망) 분할 트리가 이미 닫힌 세션을 가리키면, 그 칸은 tabs.map() 렌더에서 아무 엘리먼트도
  // 만들어지지 않아 '아무것도 안 보이고 클릭도 안 되는 빈 구멍'이 된다. 어떤 경로로 그런 죽은 leaf 가
  // 생기든 여기서 걷어내, 그리드가 죽은 칸을 안고 살아남지 않도록 한다.
  useEffect(() => {
    // INVARIANT: splitTree 가 null 이면 activeGridId 도 null. (splitTree 만 null 로 만드는 경로가
    // 있으면 activeGridId 가 유령으로 남아 activeGridId! 단언들이 근거를 잃는다)
    if (!splitTree && activeGridId) setActiveGridId(null)
    const alive = new Set(tabs.map((t) => t.id))
    const hasDead = (tree: PaneNode) => collectLeafTabIds(tree).some((id) => !alive.has(id))
    const prune = (tree: PaneNode): PaneNode | null =>
      collectLeafTabIds(tree)
        .filter((id) => !alive.has(id))
        .reduce<PaneNode | null>((acc, id) => (acc ? removeTabId(acc, id) : null), tree)

    if (splitTree && hasDead(splitTree)) {
      const next = prune(splitTree)
      if (!next || next.type === 'leaf') {
        // 칸이 하나도/하나만 남으면 그룹으로서 의미가 없으므로 해제하고 단일 보기로.
        // 살아남은 칸이 있으면 그걸 활성으로 — 안 그러면 방금 사라진 칸을 계속 가리킨다.
        if (next) setActiveId(next.tabId)
        clearActiveGrid()
        setLayoutMode('tabs')
      } else {
        setSplitTree(next)
      }
    }
    if (parkedGrids.some((g) => hasDead(g.tree))) {
      setParkedGrids((prev) =>
        prev
          .map((g) => (hasDead(g.tree) ? { ...g, tree: prune(g.tree) } : g))
          .filter((g): g is ParkedGrid => !!g.tree && g.tree.type === 'split'),
      )
    }
  }, [tabs, splitTree, parkedGrids, activeGridId])

  // 세션 id 로 키를 잡는 부수 상태들 정리. 닫기 경로가 여러 개(탭 닫기/전체 닫기/그룹 닫기/
  // 유휴 정리)라 각각에 정리 코드를 흩뿌리면 또 빠뜨린다 — tabs 를 기준으로 여기서 한 번에 맞춘다.
  useEffect(() => {
    const alive = new Set(tabs.map((t) => t.id))
    setLoggingSessions((s) => {
      if ([...s].every((id) => alive.has(id))) return s
      return new Set([...s].filter((id) => alive.has(id)))
    })
    // ref 들은 렌더에 영향이 없으므로 그냥 지운다(계속 쌓이면 메모리만 먹는다)
    for (const id of Object.keys(prevStatuses.current)) if (!alive.has(id)) delete prevStatuses.current[id]
    for (const id of Object.keys(reconnectRef.current.attempts)) if (!alive.has(id)) delete reconnectRef.current.attempts[id]
    for (const id of [...manualClosingRef.current]) if (!alive.has(id)) manualClosingRef.current.delete(id)
    for (const id of Object.keys(terminalRefs.current)) if (!alive.has(id)) delete terminalRefs.current[id]
    for (const id of Object.keys(sshFormRefs.current)) if (!alive.has(id)) delete sshFormRefs.current[id]
  }, [tabs])

  // 기본 제공 프리셋(좌우2분할/상하2분할/4분할).
  // 활성 세션이 "활성 그룹 안"이면 그 그룹을 그대로 재배치(기존 id/이름 유지). 활성 세션이 스페어(어느 그룹에도
  // 없음)면 기존 활성 그룹을 파킹하고, 스페어 세션들로 새 그룹을 만들어 활성화한다(기존 그룹들은 보존).
  const applyPresetLayout = (preset: '2v' | '2h' | '4') => {
    const n = preset === '4' ? 4 : 2
    const dir: 'row' | 'col' = preset === '2h' ? 'col' : 'row'
    if (splitTree && findLeaf(splitTree, activeId)) {
      // 활성 세션이 현재 활성 그룹 안 → 오늘과 동일하게 그 그룹을 재배치(id/이름 유지).
      const existing = collectLeafTabIds(splitTree)
      const ids: string[] = [activeId]
      for (const id of existing) {
        if (ids.length >= n) break
        if (!ids.includes(id)) ids.push(id)
      }
      let total = tabs.length
      while (ids.length < n && total < MAX_SESSIONS) {
        ids.push(createTab())
        total++
      }
      activateGrid(buildBalancedTree(ids, nextPaneId, dir), activeGridId!, gridLabel)
      setLayoutMode('split')
      return
    }
    // 활성 세션이 스페어 → 새 그룹 생성. 모든 그룹 멤버(활성+파킹)를 제외한 스페어들로 채운다.
    const allGridMembers = new Set(allGridTabIds)
    const spares = tabs.map((t) => t.id).filter((id) => !allGridMembers.has(id) && id !== activeId)
    const ids: string[] = [activeId]
    for (const id of spares) {
      if (ids.length >= n) break
      if (!ids.includes(id)) ids.push(id)
    }
    let total = tabs.length
    while (ids.length < n && total < MAX_SESSIONS) {
      ids.push(createTab())
      total++
    }
    // 기존 활성 그룹은 파킹하고, 새 그룹을 활성화.
    setParkedGrids((prev) => parkActiveInto(prev))
    activateGrid(buildBalancedTree(ids, nextPaneId, dir), newGridId(), null)
    setLayoutMode('split')
  }

  // 활성 세션이 있는 칸을 dir 방향으로 분할 — 새로 생기는 칸은 항상 '빈 세션'으로 채운다.
  // (밖에 열려있는 스페어 세션을 자동으로 끌어오지 않는다 — 필요하면 사용자가 드래그로 직접 합류시킨다.)
  // 탭 보기로 갔다가 트리에 없는 다른 세션으로 바꾼 뒤 분할하면, 기존 트리는 버리고 그 세션 하나부터 새로 시작한다.
  const baseTreeFor = (activeTabId: string): PaneNode =>
    splitTree && findLeaf(splitTree, activeTabId) ? splitTree : { type: 'leaf', id: nextPaneId(), tabId: activeTabId }
  const splitActivePane = (dir: 'row' | 'col') => {
    // 활성 세션이 현재 활성 그룹 안이면 그 그룹을 제자리 분할(id 유지). 아니면 새 그룹을 시작한다.
    const inActive = !!(splitTree && findLeaf(splitTree, activeId))
    const baseTree = baseTreeFor(activeId)
    const activeLeaf = findLeaf(baseTree, activeId)
    const leafId = activeLeaf?.id ?? (baseTree.type === 'leaf' ? baseTree.id : null)
    if (!leafId) return
    const newTabId = tabs.length < MAX_SESSIONS ? createTab() : null
    if (!newTabId) return // 세션 한도에 도달하면 분할하지 않음
    const newTree = splitLeaf(baseTree, leafId, dir, nextPaneId(), nextPaneId(), newTabId)
    if (inActive) {
      activateGrid(newTree, activeGridId!, gridLabel)
    } else {
      // 스페어 세션에서 새 분할을 시작 → 기존 활성 그룹은 파킹하고 새 그룹을 활성화(기존 그룹 보존).
      setParkedGrids((prev) => parkActiveInto(prev))
      activateGrid(newTree, newGridId(), null)
    }
    setLayoutMode('split')
  }

  // 활성 세션이 있는 칸을 닫는다(세션 자체는 유지) — 형제 칸이 그 자리로 승격, 칸이 하나만 남으면 탭 보기로 전환
  const closeActivePane = () => {
    if (!splitTree) return
    const activeLeaf = findLeaf(splitTree, activeId)
    if (!activeLeaf) return
    const next = closeLeaf(splitTree, activeLeaf.id)
    if (!next || next.type === 'leaf') {
      // 칸이 하나만 남으면 트리를 비우고 탭 보기로 — 남겨두면 다음 분할 시작점이 이 오래된
      // 단일 리프(다른 세션을 가리킬 수 있음)가 되어 버려서 엉뚱한 세션이 분할되는 문제 방지.
      // (파킹된 그룹들은 그대로 칩으로 남는다 — 자동 활성화하지 않는다.)
      clearActiveGrid()
      setLayoutMode('tabs')
      if (next) setActiveId(next.tabId)
      return
    }
    setSplitTree(next)
    setActiveId(collectLeafTabIds(next)[0])
  }

  // 사이드바 더블클릭 → 스마트 대상 선택 후 연결
  //  - 활성 탭이 비어있으면 거기 / 다른 빈 탭이 있으면 그 탭 / 없으면 새 탭(여유 시) / 다 차면 활성 탭에서 전환
  const openProfile = (p: SavedProfile) => {
    const st = (id: string) => statuses[id]?.status ?? 'idle'
    const free = (id: string) => st(id) !== 'connected' && st(id) !== 'connecting'
    // 분할 보기에서 선택된 활성 칸이 그리드 안의 빈(미접속) 칸이면 새 탭 대신 그 칸에 연결
    // (사이드바→칸 드래그 연결과 동일한 UX). 연결 중/연결됨 칸은 실수 방지를 위해 덮어쓰지 않고 새 탭으로.
    if (isSplit && splitTree && findLeaf(splitTree, activeId) && free(activeId)) {
      setPendingConnects((q) => [...q.filter((pc) => pc.id !== activeId), { id: activeId, p }])
      return
    }
    // 그 외에는 항상 새 탭으로 연결 — 세션 한도에 걸렸을 때만 예외적으로 비어있는 탭을 재사용.
    const target = tabs.length < MAX_SESSIONS ? createTab() : (tabs.find((t) => free(t.id))?.id ?? activeId)
    selectTab(target)
    setPendingConnects((q) => [...q, { id: target, p }])
  }

  // 여러 세션을 한 번에 그리드+동시입력으로 열기 (클러스터).
  // 모든 칸을 "새 탭"으로 만들고, 겉돌던 미접속(idle) 빈 탭("세션 1" 등)은 이번에 정리한다.
  //  - 예전엔 빈 탭을 재사용했는데, 재사용된 탭은 이미 마운트돼 있던 폼/로컬셸 인스턴스라
  //    새로 만들어지는 탭들과 ref/마운트 타이밍이 달라(+StrictMode 이펙트 이중실행) 연결 지연 큐
  //    (pendingConnects)에서 그 한 칸만 누락돼 연결이 안 되는 문제가 있었다. 새 탭만 쓰면
  //    항상 동일한(안정적인) 연결 경로를 타므로 이 레이스가 사라진다.
  //  - room 은 연결 중/연결됨으로 "실제 사용 중"인 탭 수만 제외하고 계산(idle 탭은 어차피 정리하므로).
  const openCluster = (list: SavedProfile[]) => {
    // 정리 대상은 "어느 그리드 그룹에도 속하지 않은" 겉도는 미접속 탭뿐이다.
    // 그리드 멤버(활성+파킹)까지 지우면 분할 트리에 죽은 leaf 가 남고, 그 칸은 tabs.map() 렌더에서
    // 아무 엘리먼트도 만들어지지 않아 클릭도 안 되는 '빈 구멍'이 된다. 특히 가로/세로 나누기로 만든
    // 칸은 SSH 연결이 없는 로컬셸이라 status 가 항상 idle 이라, 예전엔 새 그리드를 열 때마다 통째로
    // 날아가면서 기존 그리드에 빈 칸이 생겼다.
    const gridMemberIds = new Set(allGridTabIds)
    const idleIds = tabs
      .filter((t) => !gridMemberIds.has(t.id) && (statuses[t.id]?.status ?? 'idle') === 'idle')
      .map((t) => t.id)
    const keptCount = tabs.length - idleIds.length
    const room = Math.max(0, MAX_SESSIONS - keptCount)
    const sel = list.slice(0, room)
    if (!sel.length) return
    const newIds = sel.map(() => createTab())
    // 겉돌던 빈 탭은 백엔드 로컬셸까지 정리
    idleIds.forEach((id) => window.electronAPI.sessionClose(id))
    // 새 탭들을 앞으로 모으고, 정리 대상 idle 탭은 목록에서 제거
    setTabs((ts) => {
      const news = ts.filter((t) => newIds.includes(t.id))
      const kept = ts.filter((t) => !newIds.includes(t.id) && !idleIds.includes(t.id))
      return [...news, ...kept]
    })
    setStatuses((m) => {
      const c = { ...m }
      idleIds.forEach((id) => delete c[id])
      return c
    })
    setActiveId(newIds[0])
    setPendingConnects((q) => [
      ...q.filter((pc) => !idleIds.includes(pc.id)),
      ...newIds.map((id, i) => ({ id, p: sel[i] })),
    ])
    if (newIds.length >= 2) {
      // 기존 활성 그룹은 파킹하고, 새 클러스터로 새 그룹을 만들어 활성화(기존 그룹 보존).
      setParkedGrids((prev) => parkActiveInto(prev))
      activateGrid(buildBalancedTree(newIds, nextPaneId), newGridId(), null)
      setLayoutMode('split')
      // 동시입력은 기본 비활성 — 켜두면 그리드를 열자마자 여러 세션에 동시 입력되는 게 당황스러움.
      // 대상 목록만 미리 채워둬서, 나중에 수동으로 켜면 바로 이 세션들을 대상으로 쓸 수 있게 한다.
      setBroadcast(false)
      setBroadcastTargets(newIds)
    } else {
      // 1개만 열 때는 그리드를 만들지 않는다. 그런데 분할 보기 중이었다면 새 세션은 어느 칸에도
      // 없어 화면에 안 보이는데 activeId 만 그쪽을 가리키게 된다 — 프리셋/시나리오/AI 실행이
      // '보이지 않는 세션'에 나가는 위험한 상태. 탭 보기로 바꿔 방금 연 세션을 실제로 보여준다.
      setLayoutMode('tabs')
    }
  }

  // 사이드바 등록/편집 저장 (키가 바뀌면 기존 항목 삭제 후 갱신).
  // preserveMeta:false — 이 경로는 사용자가 편집 폼에서 값을 직접 채우거나 지운 결과이므로,
  // (SSHForm 자동저장과 달리) 별칭/폴더/자동실행/점프호스트를 비웠으면 그대로 비워서 저장해야 한다.
  const saveProfile = async (p: SavedProfile, originalKey?: string) => {
    if (originalKey && originalKey !== profileKey(p)) {
      await window.electronAPI.profilesDelete(originalKey)
    }
    setProfiles(await window.electronAPI.profilesUpsert(p, { preserveMeta: false }))
  }

  const deleteProfile = async (p: SavedProfile) => {
    setProfiles(await window.electronAPI.profilesDelete(profileKey(p)))
  }

  // 선택 항목 / 폴더 전체 일괄 삭제 — 메인에서 한 번의 읽기·쓰기로 처리(부분 삭제 상태가 남지 않음)
  const deleteProfiles = async (list: SavedProfile[]) => {
    if (!list.length) return
    setProfiles(await window.electronAPI.profilesDeleteMany(list.map(profileKey)))
  }

  // CSV/JSON 파일에서 세션 프로필 가져오기 — 사이드바에 추가만 하며 연결은 하지 않음 (수동으로 그리드 열기)
  const importProfiles = async () => {
    const result = await window.electronAPI.profilesImport()
    if (result.canceled) return
    if (result.list) setProfiles(result.list)
    setImportResult(result)
  }

  // 가져오기 양식 예시 파일 저장 (사용자가 값을 채워 넣을 수 있도록)
  const saveImportTemplate = (format: 'csv' | 'json') => {
    window.electronAPI.profilesSaveTemplate(format)
  }

  // 현재 저장된 전체 프로필을 파일로 내보내기 (백업/이관용) — 가져오기와 같은 형식이라 재가져오기 가능
  const [exportMsg, setExportMsg] = useState<string | null>(null)
  const exportProfiles = async (format: 'csv' | 'json') => {
    const r = await window.electronAPI.profilesExport(format)
    if (r.saved) setExportMsg(`${r.count}개 세션 프로필을 내보냈습니다.\n${r.path}`)
    else if (r.error) setExportMsg(`내보내기 실패: ${r.error}`)
  }

  // ── 탭 이름변경 / 순서변경 / 복제 ──
  const renameTab = (id: string, title: string) => {
    setTabs((ts) => ts.map((t) => (t.id === id ? { ...t, title, custom: true } : t)))
  }
  const reorderTabs = (fromId: string, toId: string) => {
    setTabs((ts) => {
      const from = ts.findIndex((t) => t.id === fromId)
      const to = ts.findIndex((t) => t.id === toId)
      if (from < 0 || to < 0) return ts
      const next = [...ts]
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved)
      return next
    })
  }
  const duplicateTab = (id: string) => {
    if (tabs.length >= MAX_SESSIONS) return
    const key = statuses[id]?.key
    const p = key ? profiles.find((x) => profileKey(x) === key) : undefined
    const nid = createTab()
    selectTab(nid)
    if (p) setPendingConnects((q) => [...q, { id: nid, p }]) // 연결돼 있던 세션이면 같은 프로필로 연결
  }

  // 사이드바에서 세션을 폴더로 드래그 → 그룹(폴더) 변경 (키 불변이므로 upsert만).
  // preserveMeta:false — "분류 없음"으로 뺄 때 group:undefined 가 기존 값으로 되살아나지 않도록.
  const moveProfile = async (p: SavedProfile, group: string | undefined) => {
    setProfiles(
      await window.electronAPI.profilesUpsert({ ...p, group: group || undefined }, { preserveMeta: false }),
    )
  }

  // 폴더명 일괄 변경 (순서 보존)
  const renameFolder = async (from: string, to: string) => {
    if (!to.trim() || to.trim() === from) return
    setProfiles(await window.electronAPI.profilesRenameGroup(from, to.trim()))
  }

  // 사이드바 드래그 재정렬/폴더이동 — 새 전체 순서 영속화
  const reorderProfiles = async (list: SavedProfile[]) => {
    setProfiles(list) // 즉시 반영(낙관적)
    setProfiles(await window.electronAPI.profilesReorder(list))
  }

  // 사이드바 → 터미널 드롭: 그 터미널의 세션으로 즉시 연결.
  // 폼 ref 가 이 순간 마운트돼 있으면 바로 연결하고, 없으면(리렌더 타이밍 등으로 잠깐 null) 연결 큐에
  // 넣어 폼이 뜨는 즉시 연결한다. 예전엔 `?.` 로 조용히 무시돼 "한 번 더 드래그해야 연결되는" 증상이 있었다.
  const dropConnect = (id: string) => {
    // 상태보다 ref 를 우선 — 드롭 시점에 상태가 잠깐 비어도 프로필을 잃지 않는다.
    const p = draggingProfileRef.current ?? draggingProfile
    draggingProfileRef.current = null
    setDraggingProfile(null)
    setDragOverId(null)
    if (!p) return
    setActiveId(id)
    const h = sshFormRefs.current[id]
    if (h) h.connectProfile(p)
    else setPendingConnects((q) => [...q.filter((pc) => pc.id !== id), { id, p }])
  }

  const closeTab = (id: string) => {
    manualClosingRef.current.add(id) // 사용자가 직접 닫음 — 자동 재연결 대상에서 제외
    const rc = reconnectRef.current
    if (rc.timers[id]) {
      clearTimeout(rc.timers[id])
      delete rc.timers[id]
    }
    window.electronAPI.sessionClose(id) // 백엔드 연결/로컬셸 정리
    const remaining = tabs.filter((x) => x.id !== id)
    if (remaining.length === 0) {
      const nid = crypto.randomUUID()
      setTabs([{ id: nid, title: '세션 1' }])
      setStatuses({ [nid]: { status: 'idle', msg: '' } })
      setActiveId(nid)
      clearActiveGrid()
      setParkedGrids([])
      setLayoutMode('tabs')
      return
    }
    setOpenConnectCellId((cur) => (cur === id ? null : cur))
    setTabs(remaining)
    setStatuses((m) => {
      const c = { ...m }
      delete c[id]
      return c
    })
    // 폼이 마운트되기 전에 탭을 닫으면 예약 연결이 영영 소비되지 않는다. 비밀번호를 담은 채
    // 메모리에 남고, 나중에 같은 id 의 자동 재연결을 가로막기도 하므로 함께 버린다.
    setPendingConnects((q) => q.filter((pc) => pc.id !== id))
    delete reconnectRef.current.attempts[id]
    // 파킹된 그룹들에서도 닫힌 세션을 제거하고, 붕괴(리프/빈)한 그룹은 칩에서 없앤다.
    setParkedGrids((prev) =>
      prev
        .map((g) => ({ ...g, tree: removeTabId(g.tree, id) }))
        .filter((g): g is ParkedGrid => !!g.tree && g.tree.type === 'split'),
    )
    // 닫는 탭이 분할 트리 안에 있었다면 그 칸을 제거(안 그러면 존재하지 않는 탭을 가리키는 빈 칸이 남음).
    // 활성 탭을 닫은 경우, 분할 트리에 남은 칸이 있으면 그쪽을 먼저 활성화(보고 있던 그리드 안에서 포커스 유지).
    let nextActive: string | null = null
    if (splitTree) {
      const next = removeTabId(splitTree, id)
      if (!next || next.type === 'leaf') {
        clearActiveGrid()
        setLayoutMode('tabs')
        if (next) nextActive = next.tabId
      } else {
        setSplitTree(next)
        if (id === activeId) nextActive = collectLeafTabIds(next)[0]
      }
    }
    if (id === activeId) setActiveId(nextActive ?? remaining[remaining.length - 1].id)
  }

  // 모든 탭 한 번에 닫기 — 열려 있는 세션이 하나뿐이고 미접속(idle)이면 닫아봐야 잃을 게 없으니
  // 확인창 없이 바로 처리하고, 그 외(연결됨/연결시도 이력 있음/여러 개)에는 확인을 거친다.
  const [confirmCloseAll, setConfirmCloseAll] = useState(false)
  // 그리드 셀 헤더의 닫기(X) — 확대/축소 버튼 바로 옆이라 실수 방지를 위해 확인창을 거친다.
  const [confirmCloseCell, setConfirmCloseCell] = useState<string | null>(null)
  // 그리드 그룹 칩의 닫기(X) — 어떤 그룹을 닫을지(groupId)를 기억한다. null 이면 확인창 닫힘.
  const [confirmCloseGrid, setConfirmCloseGrid] = useState<string | null>(null)
  const closeAllTabs = () => {
    // 예약된 재연결 타이머를 모두 취소하고 수동 종료로 표시 (뒤늦은 유령 재연결 방지)
    const rc = reconnectRef.current
    Object.values(rc.timers).forEach((t) => clearTimeout(t))
    rc.timers = {}
    rc.attempts = {}
    tabs.forEach((t) => {
      manualClosingRef.current.add(t.id)
      window.electronAPI.sessionClose(t.id)
    })
    const nid = crypto.randomUUID()
    setTabs([{ id: nid, title: '세션 1' }])
    setStatuses({ [nid]: { status: 'idle', msg: '' } })
    setActiveId(nid)
    clearActiveGrid()
    setParkedGrids([])
    setLayoutMode('tabs')
    setOpenConnectCellId(null)
    setBroadcast(false)
    setBroadcastTargets([])
    setPendingConnects([])
  }

  // 그리드 그룹 칩의 X — 지정한 그룹(활성/파킹)에 포함된 세션을 전부 닫는다(다른 그룹/단일 탭은 유지).
  // 남는 탭이 없으면 새 세션 하나로. groupId 미지정/활성 id 면 활성 그룹을 닫는다.
  const closeGridGroup = (groupId?: string) => {
    const isActiveTarget = !groupId || groupId === activeGridId
    const targetTree = isActiveTarget ? splitTree : (parkedGrids.find((g) => g.id === groupId)?.tree ?? null)
    const ids = targetTree ? collectLeafTabIds(targetTree) : []
    if (!ids.length) return
    const rc = reconnectRef.current
    ids.forEach((id) => {
      manualClosingRef.current.add(id)
      if (rc.timers[id]) {
        clearTimeout(rc.timers[id])
        delete rc.timers[id]
      }
      delete rc.attempts[id]
      window.electronAPI.sessionClose(id)
    })
    const idSet = new Set(ids)
    const remaining = tabs.filter((t) => !idSet.has(t.id))
    if (isActiveTarget) {
      clearActiveGrid()
      setLayoutMode('tabs')
    } else {
      setParkedGrids((prev) => prev.filter((g) => g.id !== groupId))
    }
    setBroadcast(false)
    setBroadcastTargets((bt) => bt.filter((id) => !idSet.has(id)))
    setPendingConnects((q) => q.filter((pc) => !idSet.has(pc.id)))
    setOpenConnectCellId((cur) => (cur && idSet.has(cur) ? null : cur))
    if (remaining.length === 0) {
      const nid = crypto.randomUUID()
      setTabs([{ id: nid, title: '세션 1' }])
      setStatuses({ [nid]: { status: 'idle', msg: '' } })
      setActiveId(nid)
    } else {
      setTabs(remaining)
      setStatuses((m) => {
        const c = { ...m }
        ids.forEach((id) => delete c[id])
        return c
      })
      if (idSet.has(activeId)) setActiveId(remaining[remaining.length - 1].id)
    }
  }
  // 그리드 그룹 이름 변경 — 활성 그룹이면 gridLabel, 파킹 그룹이면 해당 그룹의 name 을 갱신.
  const renameGrid = (groupId: string, name: string) => {
    const trimmed = name.trim()
    if (groupId === activeGridId) {
      setGridLabel(trimmed || null)
    } else {
      setParkedGrids((prev) => prev.map((g) => (g.id === groupId ? { ...g, name: trimmed || undefined } : g)))
    }
  }
  const requestCloseAllTabs = () => {
    const trivial = tabs.length === 1 && (statuses[tabs[0].id]?.status ?? 'idle') === 'idle'
    if (trivial) return
    setConfirmCloseAll(true)
  }

  // 동시입력 토글 — 켤 때 기본값으로 분할 전체를 대상에 포함
  const toggleBroadcast = () => {
    setBroadcast((b) => {
      const next = !b
      if (next) setBroadcastTargets(gridIds)
      return next
    })
  }

  // 개별 세션을 동시입력 대상에 포함/제외
  const toggleTarget = (id: string) => {
    setBroadcastTargets((t) => (t.includes(id) ? t.filter((x) => x !== id) : [...t, id]))
  }

  // 키 입력 위임 — 브로드캐스트 시 선택된 대상으로, 아니면 자기 세션으로.
  // 단, 대상에서 제외된 셀에서 타이핑하면 그 세션 혼자만 입력(개별 사용 가능).
  const handleInput = (fromId: string, data: string) => {
    if (broadcasting && effectiveTargets.includes(fromId))
      effectiveTargets.forEach((id) => window.electronAPI.sendInput(id, data))
    else window.electronAPI.sendInput(fromId, data)
  }

  // 프리셋/시나리오 명령 실행 — 브로드캐스트 시 선택된 대상, 아니면 활성 세션
  const runOnActive = (cmd: string, execute: boolean) => {
    const ids = broadcasting ? effectiveTargets : [activeId]
    ids.forEach((id) => {
      const h = terminalRefs.current[id]
      if (!h) return
      if (execute) h.runCommand(cmd)
      else h.insertCommand(cmd)
    })
  }

  // 터미널 출력 → AI 분석 (공용 — 활성 세션 기준). 패널이 닫혀 있으면 자동으로 연다.
  const analyzeSelection = () => {
    const text = activeTerm()?.getSelection() ?? ''
    setAnalysisPending(text)
    setAnalysisLabel('선택 세션 AI 분석')
    setAnalysisQuestion('')
    setAnalysisBusyNotice('')
  }

  const submitAnalysis = () => {
    if (analysisPending === null) return
    setShowAI(true)
    // analyze() 는 AI 패널이 이미 스트리밍 중이면 조용히 무시하고 false 를 반환한다 — 이 경우
    // 모달을 닫으면 사용자는 요청이 처리된 줄 알지만 실제로는 유실되므로, 열어둔 채 안내만 표시.
    const started = aiPanelRef.current?.analyze(analysisPending, analysisQuestion.trim() || undefined)
    if (started === false) {
      setAnalysisBusyNotice('AI가 이미 다른 응답을 생성하는 중입니다. 잠시 후 다시 시도하세요.')
      return
    }
    setAnalysisBusyNotice('')
    setAnalysisPending(null)
    setAnalysisQuestion('')
  }

  // 모달(다중 실행/세션 비교/파일 뷰어)에서 만든 컨텍스트를 AI 패널로 바로 보내 분석.
  // AI 패널을 열고 analyze() 를 호출 — 이미 스트리밍 중이면 analyze() 가 false 를 반환한다.
  const analyzeText = (text: string): boolean => {
    setShowAI(true)
    return aiPanelRef.current?.analyze(text) ?? false
  }
  // 터미널 검색 (활성 세션 대상)
  const doFind = (dir: 'next' | 'prev') => {
    const t = activeTerm()
    if (!t || !findTerm) return
    if (dir === 'next') t.findNext(findTerm)
    else t.findPrevious(findTerm)
  }
  const closeFind = () => {
    setShowFind(false)
    activeTerm()?.clearSearch()
  }

  // 빠른 연결: "user@host:port" 파싱 → 활성 세션 폼에 채우고 펼침
  const [quickInput, setQuickInput] = useState('')
  const quickConnect = () => {
    const s = quickInput.trim()
    if (!s) return
    let user = ''
    let rest = s
    if (s.includes('@')) {
      const at = s.indexOf('@')
      user = s.slice(0, at)
      rest = s.slice(at + 1)
    }
    let host = rest
    let port = ''
    if (rest.includes(':')) {
      ;[host, port] = rest.split(':')
    }
    if (!host) return
    sshFormRefs.current[activeId]?.prefill({ host, port, user })
    setQuickInput('')
  }

  const changeFontSize = (n: number) => {
    const v = Math.max(9, Math.min(24, n))
    setFontSize(v)
    localStorage.setItem('term_font_size', String(v))
  }
  const changeTheme = (k: string) => {
    setThemeKey(k)
    localStorage.setItem('term_theme', k)
  }

  // 활성 세션 로그 기록 토글
  const toggleLog = async () => {
    const id = activeId
    if (loggingSessions.has(id)) {
      await window.electronAPI.logStop(id)
      setLoggingSessions((s) => {
        const n = new Set(s)
        n.delete(id)
        return n
      })
    } else {
      const host = statuses[id]?.host
      const key = statuses[id]?.key
      const label = key ? profiles.find((p) => profileKey(p) === key)?.label?.trim() : undefined
      const r = await window.electronAPI.logStart(id, { host, label })
      if (r.ok) setLoggingSessions((s) => new Set(s).add(id))
    }
  }

  // 분할 트리 → 화면 좌표(%) 리프 사각형 + 분할선(리사이즈 핸들) 목록
  const { leaves: paneLeaves, dividers: paneDividers } = useMemo(
    () => (isSplit && splitTree ? layoutTree(splitTree) : { leaves: [], dividers: [] }),
    [isSplit, splitTree],
  )

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-panel text-gray-100">
      {/* ── 최좌측 : 세션 사이드바 (접이식) ─────────────────── */}
      {showSidebar ? (
        <SessionSidebar
          profiles={profiles}
          connectedKeys={connectedKeys}
          onConnect={openProfile}
          onSave={saveProfile}
          onDelete={deleteProfile}
          onDeleteMany={deleteProfiles}
          onMove={moveProfile}
          onRenameFolder={renameFolder}
          onReorder={reorderProfiles}
          onOpenMulti={openCluster}
          onImport={() => setShowImportGuide(true)}
          onCollapse={() => setShowSidebar(false)}
          onDragProfileStart={(p) => {
            draggingProfileRef.current = p
            setDraggingProfile(p)
          }}
          onDragProfileEnd={() => {
            draggingProfileRef.current = null
            setDraggingProfile(null)
            setDragOverId(null)
          }}
        />
      ) : (
        <button
          onClick={() => setShowSidebar(true)}
          title="세션 목록 열기"
          className="flex w-7 shrink-0 items-start justify-center border-r border-white/10 bg-panel-light pt-2.5 text-gray-400 hover:text-gray-200"
        >
          <PanelLeftOpen size={16} />
        </button>
      )}

      {/* ── 중앙 : 터미널 영역 (AI 패널 닫히면 전체 폭으로 확장) ─── */}
      <div className="relative flex min-w-0 flex-1 flex-col border-r border-white/10">
        <Mascot active={idle} reaction={mascotReaction} />

        {/* 터미널 검색바 (Ctrl+F) */}
        {showFind && (
          <div className="absolute right-3 top-2 z-40 flex items-center gap-1 rounded-md border border-white/10 bg-panel-light px-2 py-1 shadow-lg">
            <Search size={13} className="text-gray-400" />
            <input
              autoFocus
              value={findTerm}
              onChange={(e) => {
                setFindTerm(e.target.value)
                if (e.target.value) activeTerm()?.findNext(e.target.value)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.shiftKey ? doFind('prev') : doFind('next'))
                else if (e.key === 'Escape') closeFind()
              }}
              placeholder="검색 (Enter: 다음, Shift+Enter: 이전)"
              className="w-56 bg-transparent text-xs text-gray-100 placeholder:text-gray-500 focus:outline-none"
            />
            <button
              onClick={() => doFind('prev')}
              title="이전"
              className="rounded p-0.5 text-gray-400 hover:bg-white/10 hover:text-gray-200"
            >
              <ChevronUp size={14} />
            </button>
            <button
              onClick={() => doFind('next')}
              title="다음"
              className="rounded p-0.5 text-gray-400 hover:bg-white/10 hover:text-gray-200"
            >
              <ChevronDown size={14} />
            </button>
            <button
              onClick={closeFind}
              title="닫기 (Esc)"
              className="rounded p-0.5 text-gray-400 hover:bg-white/10 hover:text-gray-200"
            >
              <X size={13} />
            </button>
          </div>
        )}
        <TabBar
          tabs={tabs.map((t) => ({
            id: t.id,
            title: t.custom ? t.title : (statuses[t.id]?.host ?? t.title),
            custom: t.custom,
            color: t.color,
          }))}
          activeId={activeId}
          statuses={statuses}
          max={MAX_SESSIONS}
          onSelect={selectTab}
          onAdd={addTab}
          onClose={closeTab}
          onCloseAll={requestCloseAllTabs}
          onRename={renameTab}
          onReorder={reorderTabs}
          onDuplicate={duplicateTab}
          onTabDragStart={(id) => setDraggingTabId(id)}
          onTabDragEnd={() => {
            setDraggingTabId(null)
            setDragOverId(null)
          }}
          gridGroups={gridGroups}
          onRenameGrid={renameGrid}
          onSelectGrid={selectGrid}
          onDissolveGrid={dissolveGrid}
          onCloseGrid={(gid) => setConfirmCloseGrid(gid)}
          layout={layout}
          onSetLayout={setLayout}
          onApplyPreset={applyPresetLayout}
          onSplitPane={splitActivePane}
          canSplit={canSplit}
          onClosePane={closeActivePane}
          canClosePane={canClosePane}
          broadcast={broadcast}
          onToggleBroadcast={toggleBroadcast}
          loggingIds={loggingSessions}
        />

        {/* 빠른 연결 바 */}
        <div className="flex items-center gap-2 border-b border-white/10 bg-panel-light px-3 py-1.5">
          <span className="text-[11px] text-gray-500">빠른 연결</span>
          <input
            value={quickInput}
            onChange={(e) => setQuickInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') quickConnect()
            }}
            placeholder="user@host:port 입력 후 Enter → 활성 탭 폼 채우기"
            className="flex-1 rounded-md border border-white/10 bg-panel px-2.5 py-1 font-mono text-xs text-gray-100 placeholder:text-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
          <button
            onClick={quickConnect}
            className="rounded-md bg-blue-600/80 px-2.5 py-1 text-xs text-white hover:bg-blue-500"
          >
            채우기
          </button>
        </div>

        {/* 세션별 SSH 폼 — 탭(겹침) 보기에서만 여기 표시(활성 탭만, 비활성은 상태 보존 위해 hidden).
            그리드 보기에서는 셀을 선택한다고 이 폼이 열렸다 닫혔다 하지 않도록 아예 숨기고,
            대신 각 그리드 셀 안에서 필요할 때만 인라인으로 연다(아래 그리드 렌더링부 참고). */}
        {tabs.map((t) => (
          <div key={t.id} className={!isSplit && t.id === activeId ? '' : 'hidden'}>
            <SSHForm
              ref={(h) => {
                sshFormRefs.current[t.id] = h
              }}
              sessionId={t.id}
              status={statuses[t.id]?.status ?? 'idle'}
              profiles={profiles}
              onConnected={(p) => handleSessionConnected(t.id, p)}
              onError={(msg) => setStatuses((m) => ({ ...m, [t.id]: { status: 'error', msg } }))}
              onProfilesChanged={setProfiles}
            />
          </div>
        ))}

        <Toolbar
          showPresets={panel === 'presets'}
          onTogglePresets={() => setPanel((p) => (p === 'presets' ? null : 'presets'))}
          showScenarios={panel === 'scenarios'}
          onToggleScenarios={() => setPanel((p) => (p === 'scenarios' ? null : 'scenarios'))}
          onOpenFiles={() => setShowFiles(true)}
          onOpenExplorer={() => setShowExplorer(true)}
          onOpenTunnels={() => setShowTunnels(true)}
          onOpenMultiRun={() => setShowMultiRun(true)}
          onOpenLogViewer={() => setShowLogViewer(true)}
          onOpenLiveLog={() => {
            setLiveLogPrefill(undefined)
            setShowLiveLog(true)
          }}
          logging={loggingSessions.has(activeId)}
          onToggleLog={toggleLog}
          onOpenSettings={() => setShowSettings(true)}
          onOpenStatusBoard={() => setShowStatusBoard(true)}
          onAnalyzeSelection={analyzeSelection}
        />
        {(panel === 'presets' || panel === 'scenarios') && (
          <>
            <div ref={panelWrapRef} style={{ height: panelHeight }} className="shrink-0 overflow-hidden">
              {panel === 'presets' && (
                <PresetPanel
                  connected={connected}
                  onRun={runOnActive}
                  onClose={() => setPanel(null)}
                />
              )}
              {panel === 'scenarios' && (
                <ScenarioPanel
                  connected={connected}
                  onRun={runOnActive}
                  onClose={() => setPanel(null)}
                  onRunScenario={(s) => setRunnerScenario(s)}
                />
              )}
            </div>
            <div
              onMouseDown={() => {
                panelDragRef.current = true
                document.body.style.cursor = 'row-resize'
              }}
              title="드래그하여 패널 높이 조절"
              className="h-1 shrink-0 cursor-row-resize bg-white/10 hover:bg-blue-400/50"
            />
          </>
        )}

        {isSplit && broadcast && (
          <div className="bg-red-600/15 px-3 py-0.5 text-center text-[11px] font-medium text-red-300">
            {effectiveTargets.length > 0
              ? `⚠ 동시입력 ON — 선택된 ${effectiveTargets.length}개 세션에 동시에 입력됩니다` +
                (droppedTargetCount > 0 ? ` (연결이 끊긴 ${droppedTargetCount}개는 제외됨)` : '')
              : '동시입력 ON — 대상 세션을 선택하세요 (셀 헤더의 체크박스)'}
          </div>
        )}
        {isSplit && tabs.length > new Set(gridIds).size && (
          <div className="bg-amber-500/10 px-3 py-0.5 text-[11px] text-amber-300">
            분할 화면에 표시되지 않는 세션이 있습니다 (나머지는 단일 보기 탭에서 확인, 분할 버튼으로 칸 추가 가능).
          </div>
        )}

        {/* 터미널 영역 — 탭 보기(겹침) / 분할 보기(임의 재귀 분할 트리, % 좌표로 절대배치). 인스턴스는 항상 마운트 유지 */}
        <div ref={termAreaRef} className="relative min-h-0 flex-1 overflow-hidden">
          {/* 분할선 드래그 핸들 — 트리의 각 split 노드마다 하나씩 */}
          {isSplit &&
            paneDividers.map((d) => (
              <div
                key={d.nodeId}
                onMouseDown={() => {
                  resizeDragRef.current = { nodeId: d.nodeId, dir: d.dir }
                  document.body.style.cursor = d.dir === 'row' ? 'col-resize' : 'row-resize'
                }}
                style={
                  d.dir === 'row'
                    ? { left: `calc(${d.left}% - 3px)`, top: `${d.top}%`, height: `${d.height}%` }
                    : { top: `calc(${d.top}% - 3px)`, left: `${d.left}%`, width: `${d.width}%` }
                }
                className={
                  'absolute z-20 ' +
                  (d.dir === 'row'
                    ? 'w-1.5 cursor-col-resize bg-white/5 hover:bg-blue-400/50'
                    : 'h-1.5 cursor-row-resize bg-white/5 hover:bg-blue-400/50')
                }
              />
            ))}
          {/* 셀 확대 중이면 나머지 그리드를 덮어 어둡게 — 클릭하면 확대 해제 */}
          {zoomActive && (
            <div className="absolute inset-0 z-30 bg-black/70" onClick={() => setZoomedId(null)} />
          )}
          {tabs.map((t) => {
            const leaf = isSplit && splitTree ? paneLeaves.find((l) => l.tabId === t.id) : undefined
            // 이 셀이 동시입력 대상으로 선택되어 있는지
            const isTarget = broadcast && isSplit && broadcastTargets.includes(t.id)
            const zoomedHere = zoomActive && t.id === zoomedId
            let cls: string
            let posStyle: React.CSSProperties | undefined
            if (!isSplit) {
              cls = t.id === activeId ? 'absolute inset-0' : 'hidden'
            } else if (zoomedHere) {
              // 팝업처럼 화면 대부분을 차지하게 확대 — 그리드 좌표(%) 대신 고정 오버레이 위치 사용
              cls = 'absolute z-40 overflow-hidden rounded-lg border border-white/20 shadow-2xl'
              posStyle = { left: '4%', top: '4%', width: '92%', height: '92%' }
            } else if (leaf) {
              // 테두리는 ring(box-shadow)으로 그리면 (a) 바깥쪽은 인접 셀에 가려 끊기고 (b) 안쪽은
              // 자식 터미널 캔버스에 덮여 안 보인다. 그래서 아래에서 별도의 pointer-events-none 오버레이
              // div 로 터미널 위에 테두리를 그린다. 여기서는 위치/클리핑만 담당.
              cls = 'absolute overflow-hidden ' + (t.id === activeId ? 'z-20' : '')
              posStyle = {
                left: `${leaf.left}%`,
                top: `${leaf.top}%`,
                width: `${leaf.width}%`,
                height: `${leaf.height}%`,
              }
            } else {
              cls = 'hidden'
            }
            return (
              <div
                key={t.id}
                className={cls}
                style={posStyle}
                onMouseDown={() => {
                  setActiveId(t.id)
                  // 클릭 즉시 해당 터미널로 포커스 이동 — React 이펙트 반영 전 짧은 순간
                  // 이전 활성 터미널이 여전히 포커스를 쥐고 있어 키 입력이 다른 세션으로 새는 것 방지
                  terminalRefs.current[t.id]?.focus()
                  triggerMascotReaction('surprised')
                }}
              >
                {/* 그리드 셀 헤더 바 (터미널을 가리지 않도록 상단에 분리 배치)
                    — 헤더 자체를 드래그해서 다른 칸으로 끌어다 놓으면 그 칸과 서로 자리를 맞바꿈
                    (탭바에서 드래그하는 것과 동일한 draggingTabId/reassignTab 경로 재사용) */}
                {isSplit && leaf && (
                  <div
                    onMouseDown={(e) => {
                      // 상위 셀의 onMouseDown(터미널 focus 이동)이 먼저 발동하는 걸 막아야 함.
                      // 드래그 자체는 네이티브 HTML5 DnD 가 아니라 gridDragRef 기반 마우스 추적으로
                      // 처리한다 — 텍스트 위에서 드래그 시작 시 브라우저가 엘리먼트 드래그 대신
                      // 텍스트 선택/포커스 이동으로 가로채 dragstart 가 아예 안 일어나는 문제가 있었음.
                      e.stopPropagation()
                      setActiveId(t.id)
                      gridDragRef.current = { tabId: t.id, startX: e.clientX, startY: e.clientY, moved: false }
                    }}
                    title="드래그해서 다른 칸과 자리 바꾸기"
                    className="absolute left-0 right-0 top-0 z-10 flex h-[19px] cursor-grab select-none items-center gap-1 border-b border-white/10 bg-panel-light px-1.5 text-[10px] text-gray-300 active:cursor-grabbing"
                  >
                    <Circle size={7} className={dotColor(statuses[t.id]?.status) + ' fill-current'} />
                    <span className="truncate">{gridCellLabel(t)}</span>
                    {loggingSessions.has(t.id) && (
                      <span title="세션 로그 기록 중" className="shrink-0">
                        <Circle size={6} className="fill-current text-red-400" />
                      </span>
                    )}
                    {statuses[t.id]?.status !== 'connected' && (
                      <button
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation()
                          setOpenConnectCellId((cur) => (cur === t.id ? null : t.id))
                        }}
                        title="SSH 연결 정보 입력"
                        className={
                          'flex shrink-0 items-center gap-0.5 rounded border px-1.5 py-[1px] text-[10px] font-medium transition ' +
                          (openConnectCellId === t.id
                            ? 'border-blue-400 bg-blue-600 text-white'
                            : 'border-blue-500/40 bg-blue-500/20 text-blue-200 hover:border-blue-400 hover:bg-blue-500/40')
                        }
                      >
                        <Plug size={9} />
                        연결
                      </button>
                    )}
                    <div className="ml-auto flex shrink-0 items-center gap-1">
                      {broadcast && (
                        <button
                          onMouseDown={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            e.stopPropagation()
                            toggleTarget(t.id)
                          }}
                          title={isTarget ? '동시입력 대상에서 제외' : '동시입력 대상에 포함'}
                          className={
                            'flex items-center gap-1 rounded px-1.5 text-[10px] font-medium ' +
                            (isTarget ? 'bg-red-600/80 text-white' : 'text-gray-400 hover:bg-white/10')
                          }
                        >
                          {isTarget ? <CheckSquare size={10} /> : <Square size={10} />}
                          동시입력
                        </button>
                      )}
                      <button
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation()
                          setZoomedId((cur) => (cur === t.id ? null : t.id))
                        }}
                        title={zoomedHere ? '원래 크기로' : '이 세션 크게 보기'}
                        className="flex items-center rounded p-0.5 text-gray-400 hover:bg-white/10 hover:text-gray-200"
                      >
                        {zoomedHere ? <Minimize2 size={10} /> : <Maximize2 size={10} />}
                      </button>
                      {/* 확대 상태에서는 닫기 버튼을 숨긴다(확대/축소 버튼 바로 옆이라 실수로 닫히는 것 방지).
                          평소에도 닫기는 확인창을 한 번 거친다. */}
                      {!zoomedHere && (
                        <button
                          onMouseDown={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            e.stopPropagation()
                            setConfirmCloseCell(t.id)
                          }}
                          title="이 세션 닫기"
                          className="flex items-center rounded p-0.5 text-gray-400 hover:bg-red-500/20 hover:text-red-300"
                        >
                          <X size={11} />
                        </button>
                      )}
                    </div>
                  </div>
                )}
                {/* 탭을 이 칸으로 드래그 배치 (분할 모드 — 원래 있던 탭과 서로 자리를 맞바꿈) */}
                {draggingTabId && isSplit && leaf && (
                  <div
                    onDragOver={(e) => {
                      e.preventDefault()
                      e.dataTransfer.dropEffect = 'move'
                      if (dragOverId !== t.id) setDragOverId(t.id)
                    }}
                    onDragLeave={() => setDragOverId((cur) => (cur === t.id ? null : cur))}
                    onDrop={(e) => {
                      e.preventDefault()
                      if (draggingTabId)
                        setSplitTree((tree) => (tree ? reassignTab(tree, leaf.leafId, draggingTabId) : tree))
                      setDraggingTabId(null)
                      setDragOverId(null)
                    }}
                    className={
                      'absolute inset-0 z-30 flex items-center justify-center border-2 border-dashed transition ' +
                      (dragOverId === t.id
                        ? 'border-blue-400 bg-blue-500/25'
                        : 'border-white/25 bg-black/40')
                    }
                  >
                    <div className="pointer-events-none rounded-md bg-blue-600/90 px-3 py-1.5 text-xs font-medium text-white shadow">
                      이 칸에 배치
                    </div>
                  </div>
                )}
                {/* 사이드바에서 드래그 중일 때 드롭 오버레이 (xterm 위에 덮어 드롭 캡처)
                    drag가 터미널 위에 올라오기 전까지는 invisible 유지 — 사이드바 폴더 이동 시 딤 방지 */}
                {draggingProfile && (!isSplit ? t.id === activeId : !!leaf) && (
                  <div
                    onDragOver={(e) => {
                      e.preventDefault()
                      e.dataTransfer.dropEffect = 'copy'
                      if (dragOverId !== t.id) setDragOverId(t.id)
                    }}
                    onDragLeave={() => setDragOverId((cur) => (cur === t.id ? null : cur))}
                    onDrop={(e) => {
                      e.preventDefault()
                      dropConnect(t.id)
                    }}
                    className={
                      'absolute inset-0 z-30 flex items-center justify-center border-2 border-dashed transition ' +
                      (dragOverId === t.id
                        ? 'border-blue-400 bg-blue-500/25'
                        : 'border-transparent bg-transparent')
                    }
                  >
                    {dragOverId === t.id && (
                      <div className="pointer-events-none rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white shadow">
                        여기에 연결 · {draggingProfile.label?.trim() || draggingProfile.host}
                      </div>
                    )}
                  </div>
                )}
                <TerminalView
                  ref={(h) => {
                    terminalRefs.current[t.id] = h
                  }}
                  sessionId={t.id}
                  onData={handleInput}
                  onFind={() => setShowFind(true)}
                  headerSpace={isSplit && !!leaf}
                  fontSize={fontSize}
                  highlight={highlight}
                  theme={{
                    background: theme.background,
                    foreground: theme.foreground,
                    cursor: theme.cursor,
                  }}
                />
                {/* 선택/동시입력 테두리 — 터미널 캔버스 위에 그려야 보이므로 별도 오버레이(클릭 통과). */}
                {isSplit && leaf && (
                  <div
                    className={
                      'pointer-events-none absolute inset-0 z-20 rounded-[1px] ' +
                      (isTarget
                        ? 'border-2 border-red-500/80'
                        : t.id === activeId
                          ? 'border-2 border-blue-400'
                          : 'border border-white/10')
                    }
                  />
                )}
                {/* 그리드 셀 인라인 SSH 연결 폼 — 이 칸에서만 열리고 닫히며, 다른 칸/상단 레이아웃에는 영향 없음 */}
                {isSplit && leaf && openConnectCellId === t.id && (
                  <div
                    className="absolute inset-x-0 bottom-0 z-20 overflow-y-auto bg-panel"
                    style={{ top: 19 }}
                    onMouseDown={(e) => e.stopPropagation()}
                  >
                    <div className="flex items-center justify-between border-b border-white/10 px-2 py-1">
                      <span className="text-[11px] font-medium text-gray-300">SSH 연결</span>
                      <button
                        onClick={() => setOpenConnectCellId(null)}
                        title="닫기"
                        className="rounded p-0.5 text-gray-400 hover:bg-white/10 hover:text-gray-200"
                      >
                        <X size={12} />
                      </button>
                    </div>
                    <SSHForm
                      sessionId={t.id}
                      status={statuses[t.id]?.status ?? 'idle'}
                      profiles={profiles}
                      onConnected={(p) => handleSessionConnected(t.id, p)}
                      onError={(msg) => setStatuses((m) => ({ ...m, [t.id]: { status: 'error', msg } }))}
                      onProfilesChanged={setProfiles}
                    />
                  </div>
                )}
              </div>
            )
          })}
        </div>
        {(() => {
          const st = statuses[activeId]
          if (!st || st.status !== 'connected') {
            return activeMsg ? (
              <div className="border-t border-white/10 bg-panel px-3 py-1 text-[11px] text-gray-400">
                {activeMsg}
              </div>
            ) : null
          }
          const parts = st.key?.split(':')
          const who = parts && parts.length >= 3 ? `${parts[2]}@${parts[0]}:${parts[1]}` : (st.host ?? '')
          const sec = st.since ? Math.floor((Date.now() - st.since) / 1000) : 0
          const h = Math.floor(sec / 3600)
          const m = Math.floor((sec % 3600) / 60)
          const dur = h ? `${h}시간 ${m}분` : m ? `${m}분 ${sec % 60}초` : `${sec}초`
          return (
            <div className="flex items-center gap-3 border-t border-white/10 bg-panel px-3 py-1 text-[11px] text-gray-400">
              <span className="flex items-center gap-1.5 text-green-300">
                <Circle size={7} className="fill-current" /> 연결됨
              </span>
              <span className="truncate font-mono text-gray-300">{who}</span>
              <span className="shrink-0">· 연결 {dur}</span>
              {latency != null && <span className="shrink-0">· {latency}ms</span>}
              {activeMsg && <span className="ml-auto truncate text-gray-500">{activeMsg}</span>}
            </div>
          )
        })()}
      </div>

      {/* ── 우측 : AI 분석 패널 (공용, 너비 드래그 조절). 숨김 시 언마운트 안 함 ── */}
      {showAI && (
        <div
          onMouseDown={() => {
            aiDragRef.current = true
            document.body.style.cursor = 'col-resize'
          }}
          title="드래그하여 AI 패널 너비 조절"
          className="w-1 shrink-0 cursor-col-resize bg-white/5 hover:bg-blue-400/50"
        />
      )}
      <div
        className={showAI ? 'flex shrink-0 flex-col overflow-hidden' : 'hidden'}
        style={showAI ? { width: aiWidth } : undefined}
      >
        {/* 우측 패널 탭 (AI 분석 / 대시보드) */}
        <div className="flex shrink-0 items-center border-b border-white/10 bg-panel-light text-sm">
          <button
            onClick={() => setRightTab('ai')}
            className={
              'flex-1 py-2 ' +
              (rightTab === 'ai'
                ? 'bg-white/10 font-semibold text-gray-100'
                : 'text-gray-400 hover:text-gray-200')
            }
          >
            AI 분석
          </button>
          <button
            onClick={() => setRightTab('dashboard')}
            className={
              'flex-1 py-2 ' +
              (rightTab === 'dashboard'
                ? 'bg-white/10 font-semibold text-gray-100'
                : 'text-gray-400 hover:text-gray-200')
            }
          >
            대시보드
          </button>
          <button
            onClick={() => setRightTab('overview')}
            className={
              'flex-1 py-2 ' +
              (rightTab === 'overview'
                ? 'bg-white/10 font-semibold text-gray-100'
                : 'text-gray-400 hover:text-gray-200')
            }
          >
            개요
          </button>
          <button
            onClick={() => setShowAI(false)}
            title="패널 닫기"
            className="px-2 py-2 text-gray-400 hover:text-gray-200"
          >
            <X size={15} />
          </button>
        </div>
        <div className="min-h-0 flex-1">
          {/* AIPanel 은 언마운트하면 대화/스트림이 끊기므로 hidden 으로 유지 */}
          <div className={rightTab === 'ai' ? 'h-full' : 'hidden'}>
            <AIPanel
              ref={aiPanelRef}
              onClose={() => setShowAI(false)}
              onRunCommand={runOnActive}
              // 명령 카드가 "어느 서버를 보고 만든 것인지" 새겨두고, 실행 시 지금 대상과 다르면 막기 위해 전달
              activeSessionId={activeId}
              // 탭 제목("세션 1")이 아니라 실제 서버가 보이는 라벨("별칭 (IP)")을 넘긴다
              activeSessionLabel={gridCellLabel(tabs.find((t) => t.id === activeId) ?? { id: activeId, title: '' })}
              broadcasting={broadcasting}
              activeConnected={statuses[activeId]?.status === 'connected'}
            />
          </div>
          {rightTab === 'dashboard' && (
            <div className="h-full">
              {/* 활성 세션 대상. 탭 전환 시 remount 되어 해당 세션 이력으로 backfill */}
              <Dashboard key={activeId} sessionId={activeId} connected={connected} />
            </div>
          )}
          {rightTab === 'overview' && (
            <div className="h-full">
              <MonitorOverview
                sessions={tabs
                  .filter((t) => statuses[t.id]?.status === 'connected')
                  .map((t) => ({
                    id: t.id,
                    label: t.custom ? t.title : (statuses[t.id]?.host ?? t.title),
                    connected: true,
                  }))}
                onOpenDashboard={(id) => {
                  // setActiveId 를 직접 쓰면, 고른 세션이 분할 트리 밖(스페어/파킹 그룹 멤버)일 때
                  // 화면엔 안 보이면서 activeId 만 그쪽으로 옮겨간다. selectTab 은 그런 경우
                  // 탭 보기로 전환해 실제로 보여준다.
                  selectTab(id)
                  setRightTab('dashboard')
                }}
              />
            </div>
          )}
        </div>
      </div>
      {/* 닫힘 상태: 우측 끝 얇은 바로 다시 열기 (좌측 사이드바와 대칭) */}
      {!showAI && (
        <button
          onClick={() => setShowAI(true)}
          title="AI 분석 패널 열기"
          className="flex w-7 shrink-0 items-start justify-center border-l border-white/10 bg-panel-light pt-3 text-gray-400 hover:text-gray-200"
        >
          <PanelRightOpen size={16} />
        </button>
      )}

      {/* 원격 파일 탐색기 (SFTP) 모달 — 활성 세션 대상 */}
      {showExplorer && (
        <FileExplorer
          sessionId={activeId}
          connected={connected}
          onClose={() => setShowExplorer(false)}
          onOpenLiveTail={(path) => {
            setLiveLogPrefill(path)
            setShowLiveLog(true)
          }}
          otherSessions={tabs
            .filter((t) => t.id !== activeId && statuses[t.id]?.status === 'connected')
            .map((t) => ({ id: t.id, label: gridCellLabel(t) }))}
        />
      )}

      {/* 실시간 로그(tail -f) 뷰어 — 활성 세션 대상. key 로 세션/경로가 바뀌면 완전히 새로 시작 */}
      {showLiveLog && (
        <LiveLogViewer
          key={`${activeId}-${liveLogPrefill ?? ''}`}
          sessionId={activeId}
          initialPath={liveLogPrefill}
          currentLabel={(() => {
            const t = tabs.find((t) => t.id === activeId)
            return t ? gridCellLabel(t) : undefined
          })()}
          otherSessions={tabs
            .filter((t) => t.id !== activeId && statuses[t.id]?.status === 'connected')
            .map((t) => ({ id: t.id, label: gridCellLabel(t) }))}
          onClose={() => {
            setShowLiveLog(false)
            setLiveLogPrefill(undefined)
          }}
        />
      )}

      {/* 포트 포워딩(터널) 관리 모달 — 활성 세션 대상 */}
      {showTunnels && (
        <TunnelManager sessionId={activeId} connected={connected} onClose={() => setShowTunnels(false)} />
      )}

      {/* 다중 호스트 실행 모달 — 연결된 세션 대상 */}
      {showMultiRun && (
        <MultiRun
          sessions={tabs
            .filter((t) => statuses[t.id]?.status === 'connected')
            .map((t) => ({ id: t.id, name: t.custom ? t.title : (statuses[t.id]?.host ?? t.title) }))}
          onClose={() => setShowMultiRun(false)}
          onAnalyze={analyzeText}
        />
      )}

      {/* 시나리오 검증 러너 (순차 실행 + 자동 판정 + 리포트) */}
      {runnerScenario && (
        <ScenarioRunner
          scenario={runnerScenario}
          sessions={tabs
            .filter((t) => statuses[t.id]?.status === 'connected')
            .map((t) => ({ id: t.id, name: t.custom ? t.title : (statuses[t.id]?.host ?? t.title) }))}
          defaultSessionId={activeId}
          onClose={() => setRunnerScenario(null)}
          onAnalyze={analyzeText}
        />
      )}

      {/* 세션 로그 뷰어(목록/검색/리플레이) */}
      {showLogViewer && <LogViewer onClose={() => setShowLogViewer(false)} />}
      {showHlRules && <HighlightRulesModal onClose={() => setShowHlRules(false)} />}

      {/* 가용성 검증 상태보드 (역할 매핑 → 실시간 상태 폴링) */}
      {showStatusBoard && (
        <StatusBoard
          sessions={tabs.map((t) => ({
            // 프로필 label 기반 "별칭 (IP)" (그리드 셀 라벨과 동일 규칙)
            id: t.id,
            name: gridCellLabel(t),
            connected: statuses[t.id]?.status === 'connected',
            // 역할 매핑 영속화용 안정 키 — 연결이 끊겨도 statuses[].key 는 유지된다
            profileKey: statuses[t.id]?.key,
          }))}
          onClose={() => setShowStatusBoard(false)}
        />
      )}

      {confirmCloseAll && (
        <ConfirmDialog
          title="모든 탭 닫기"
          message={`열려 있는 세션 ${tabs.length}개를 모두 닫을까요?\n연결된 세션은 전부 연결 해제됩니다.`}
          confirmLabel="모두 닫기"
          onCancel={() => setConfirmCloseAll(false)}
          onConfirm={() => {
            setConfirmCloseAll(false)
            closeAllTabs()
          }}
        />
      )}

      {confirmCloseGrid !== null && (
        <ConfirmDialog
          title="그리드 세션 닫기"
          message={`그리드에 포함된 세션 ${
            confirmCloseGrid === activeGridId
              ? activeMembers.length
              : (() => {
                  const t = parkedGrids.find((g) => g.id === confirmCloseGrid)?.tree
                  return t ? collectLeafTabIds(t).length : 0
                })()
          }개를 모두 닫을까요?\n연결된 세션은 연결 해제되며, 그 외 세션은 그대로 유지됩니다.`}
          confirmLabel="모두 닫기"
          onCancel={() => setConfirmCloseGrid(null)}
          onConfirm={() => {
            const gid = confirmCloseGrid
            setConfirmCloseGrid(null)
            closeGridGroup(gid ?? undefined)
          }}
        />
      )}

      {confirmCloseCell !== null && (
        <ConfirmDialog
          title="세션 닫기"
          message={`"${gridCellLabel(tabs.find((t) => t.id === confirmCloseCell) ?? { id: confirmCloseCell, title: confirmCloseCell })}" 세션을 닫을까요?${
            (statuses[confirmCloseCell]?.status ?? 'idle') === 'connected' ? '\n연결이 해제됩니다.' : ''
          }`}
          confirmLabel="닫기"
          onCancel={() => setConfirmCloseCell(null)}
          onConfirm={() => {
            const id = confirmCloseCell
            setConfirmCloseCell(null)
            if (zoomedId === id) setZoomedId(null)
            closeTab(id)
          }}
        />
      )}

      {/* 선택 AI 분석 — 질문 입력 모달 */}
      {analysisPending !== null && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
          onClick={() => { setAnalysisPending(null); setAnalysisBusyNotice('') }}
        >
          <div
            className="w-full max-w-md rounded-lg border border-white/10 bg-panel p-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Escape') { setAnalysisPending(null); setAnalysisBusyNotice('') }
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitAnalysis() }
            }}
          >
            <div className="mb-3 text-sm font-semibold text-gray-100">{analysisLabel}</div>
            <textarea
              autoFocus
              rows={3}
              value={analysisQuestion}
              onChange={(e) => setAnalysisQuestion(e.target.value)}
              placeholder="질문을 입력하세요... (비우면 기본 분석 스타일 적용)"
              className="w-full resize-none rounded-md border border-white/10 bg-panel-light px-3 py-2 text-sm text-gray-200 outline-none placeholder:text-gray-600 focus:ring-1 focus:ring-blue-500"
            />
            {analysisBusyNotice && (
              <p className="mt-1.5 text-[11px] text-amber-300">{analysisBusyNotice}</p>
            )}
            <div className="mt-3 flex justify-end gap-2">
              <button
                onClick={() => { setAnalysisPending(null); setAnalysisBusyNotice('') }}
                className="rounded px-3 py-1.5 text-xs text-gray-400 hover:text-gray-200"
              >
                취소
              </button>
              <button
                onClick={submitAnalysis}
                className="rounded bg-blue-600/80 px-3 py-1.5 text-xs text-white hover:bg-blue-500"
              >
                분석
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 세션 프로필 가져오기 전 형식 안내 + 템플릿 다운로드 모달 */}
      {showImportGuide && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
          onClick={() => setShowImportGuide(false)}
        >
          <div
            className="w-full max-w-md rounded-lg border border-white/10 bg-panel p-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.key === 'Escape' && setShowImportGuide(false)}
          >
            <div className="mb-2 text-sm font-semibold text-gray-100">세션 프로필 가져오기 / 내보내기</div>
            <div className="space-y-1.5 text-[12px] leading-relaxed text-gray-300">
              <p>
                CSV 또는 JSON 파일로 여러 세션을 한 번에 사이드바에 등록할 수 있습니다. 필수 항목은{' '}
                <code className="rounded bg-black/30 px-1 py-0.5 text-[11px] text-blue-300">host</code>,{' '}
                <code className="rounded bg-black/30 px-1 py-0.5 text-[11px] text-blue-300">port</code>,{' '}
                <code className="rounded bg-black/30 px-1 py-0.5 text-[11px] text-blue-300">username</code>{' '}
                세 가지뿐이며, 나머지는 비워도 됩니다.
              </p>
              <p className="text-gray-400">
                선택 항목: authMethod, password, keyPath(개인키 파일 경로), passphrase, label, group, startup, color.
                authMethod를 안 적으면 password/keyPath 유무로 자동 판별합니다.
              </p>
              <p className="text-gray-400">
                같은 host:port:username 조합이 이미 있으면 자동으로 건너뜁니다. 아래에서 예시 파일을 받아 형식을 확인한 뒤 값을 채워 넣으세요.
              </p>
            </div>
            <div className="mt-3 flex gap-2">
              <button
                onClick={() => saveImportTemplate('csv')}
                className="flex-1 rounded-md border border-white/10 px-2.5 py-1.5 text-[12px] text-gray-200 hover:bg-white/10"
              >
                CSV 템플릿 저장
              </button>
              <button
                onClick={() => saveImportTemplate('json')}
                className="flex-1 rounded-md border border-white/10 px-2.5 py-1.5 text-[12px] text-gray-200 hover:bg-white/10"
              >
                JSON 템플릿 저장
              </button>
            </div>

            <div className="mt-3 border-t border-white/10 pt-3">
              <div className="mb-1.5 text-[12px] font-medium text-gray-200">현재 목록 내보내기 (백업)</div>
              <p className="mb-2 text-[11px] leading-relaxed text-amber-300/90">
                내보낸 파일에는 비밀번호·개인키가 평문으로 포함됩니다. 보관/공유 시 주의하세요.
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => exportProfiles('csv')}
                  className="flex-1 rounded-md border border-white/10 px-2.5 py-1.5 text-[12px] text-gray-200 hover:bg-white/10"
                >
                  CSV로 내보내기
                </button>
                <button
                  onClick={() => exportProfiles('json')}
                  className="flex-1 rounded-md border border-white/10 px-2.5 py-1.5 text-[12px] text-gray-200 hover:bg-white/10"
                >
                  JSON으로 내보내기
                </button>
              </div>
            </div>

            <div className="mt-3 flex justify-end gap-2 border-t border-white/10 pt-3">
              <button
                onClick={() => setShowImportGuide(false)}
                className="rounded px-3 py-1.5 text-xs text-gray-400 hover:text-gray-200"
              >
                취소
              </button>
              <button
                autoFocus
                onClick={() => {
                  setShowImportGuide(false)
                  importProfiles()
                }}
                className="rounded bg-blue-600/80 px-3 py-1.5 text-xs text-white hover:bg-blue-500"
              >
                파일 선택해서 가져오기
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 세션 프로필 내보내기 결과 모달 */}
      {exportMsg && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
          onClick={() => setExportMsg(null)}
        >
          <div
            className="w-full max-w-md rounded-lg border border-white/10 bg-panel p-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Escape' || e.key === 'Enter') setExportMsg(null)
            }}
          >
            <div className="mb-2 text-sm font-semibold text-gray-100">내보내기 결과</div>
            <p className="whitespace-pre-line text-[13px] leading-relaxed text-gray-300">{exportMsg}</p>
            <div className="mt-3 flex justify-end">
              <button
                autoFocus
                onClick={() => setExportMsg(null)}
                className="rounded bg-blue-600/80 px-3 py-1.5 text-xs text-white hover:bg-blue-500"
              >
                확인
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 세션 프로필 가져오기 결과 모달 */}
      {importResult && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
          onClick={() => setImportResult(null)}
        >
          <div
            className="w-full max-w-md rounded-lg border border-white/10 bg-panel p-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Escape' || e.key === 'Enter') setImportResult(null)
            }}
          >
            <div className="mb-3 text-sm font-semibold text-gray-100">가져오기 결과</div>
            {importResult.ok ? (
              <>
                <p className="text-[13px] text-gray-300">
                  추가 <span className="font-semibold text-emerald-400">{importResult.addedCount ?? 0}</span>건 ·
                  스킵(중복) <span className="font-semibold text-amber-400">{importResult.skippedCount ?? 0}</span>건 ·
                  오류 <span className="font-semibold text-red-400">{importResult.errorCount ?? 0}</span>건
                </p>
                {(!!importResult.warnings?.length || !!importResult.errors?.length) && (
                  <div className="mt-2 max-h-40 space-y-1 overflow-y-auto rounded border border-white/10 bg-black/20 p-2">
                    {importResult.errors?.map((e, i) => (
                      <p key={'e' + i} className="text-[11px] text-red-300">{e}</p>
                    ))}
                    {importResult.warnings?.map((w, i) => (
                      <p key={'w' + i} className="text-[11px] text-gray-400">{w}</p>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <p className="text-[13px] text-red-300">{importResult.error ?? '가져오기에 실패했습니다.'}</p>
            )}
            <div className="mt-3 flex justify-end">
              <button
                autoFocus
                onClick={() => setImportResult(null)}
                className="rounded bg-blue-600/80 px-3 py-1.5 text-xs text-white hover:bg-blue-500"
              >
                확인
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 외형 설정 모달 */}
      {showSettings && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
          onClick={() => setShowSettings(false)}
        >
          <div
            className="w-full max-w-sm rounded-lg border border-white/10 bg-panel p-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 text-sm font-semibold text-gray-100">외형 설정</div>

            <label className="mb-1 block text-[11px] text-gray-400">글꼴 크기: {fontSize}px</label>
            <div className="mb-3 flex items-center gap-2">
              <input
                type="range"
                min={9}
                max={24}
                value={fontSize}
                onChange={(e) => changeFontSize(Number(e.target.value))}
                className="flex-1"
              />
              <button
                onClick={() => changeFontSize(fontSize - 1)}
                className="rounded border border-white/10 px-2 text-gray-200 hover:bg-white/10"
              >
                −
              </button>
              <button
                onClick={() => changeFontSize(fontSize + 1)}
                className="rounded border border-white/10 px-2 text-gray-200 hover:bg-white/10"
              >
                +
              </button>
            </div>

            <label className="mb-1 block text-[11px] text-gray-400">색상 테마</label>
            <div className="grid grid-cols-2 gap-2">
              {Object.entries(THEMES).map(([k, t]) => (
                <button
                  key={k}
                  onClick={() => changeTheme(k)}
                  className={
                    'flex items-center gap-2 rounded-md border px-2 py-1.5 text-xs ' +
                    (themeKey === k ? 'border-blue-500/60 bg-blue-600/15 text-blue-100' : 'border-white/10 text-gray-300 hover:bg-white/5')
                  }
                >
                  <span
                    className="h-4 w-4 shrink-0 rounded-sm border border-white/20"
                    style={{ background: t.background }}
                  />
                  <span className="truncate">{t.name}</span>
                </button>
              ))}
            </div>

            <label className="mt-4 flex items-center gap-2 text-xs text-gray-300">
              <input
                type="checkbox"
                checked={highlight}
                onChange={(e) => {
                  setHighlight(e.target.checked)
                  localStorage.setItem('term_highlight', e.target.checked ? '1' : '0')
                }}
              />
              출력 하이라이트 (ERROR/WARN/OK 색상 강조)
            </label>
            <button
              onClick={() => setShowHlRules(true)}
              className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-md border border-white/10 bg-panel-light px-2 py-1.5 text-xs text-gray-200 hover:bg-white/10"
            >
              <Highlighter size={13} className="text-blue-300" />
              로그 하이라이트 규칙 관리 (사용자 키워드)
            </button>
            <label className="mt-2 flex items-center gap-2 text-xs text-gray-300">
              <input
                type="checkbox"
                checked={restoreOnLaunch}
                onChange={(e) => {
                  setRestoreOnLaunch(e.target.checked)
                  localStorage.setItem('restore_sessions', e.target.checked ? '1' : '0')
                }}
              />
              시작 시 이전 세션 복원 (자동 재연결)
            </label>
            <label className="mt-2 flex items-center gap-2 text-xs text-gray-300">
              <input
                type="checkbox"
                checked={autoReconnect}
                onChange={(e) => {
                  setAutoReconnect(e.target.checked)
                  localStorage.setItem('auto_reconnect', e.target.checked ? '1' : '0')
                }}
              />
              작업 중 끊기면 자동 재연결 시도 (최대 4회, 백오프)
            </label>

            <div className="mt-4 rounded-md border border-white/10 bg-panel-light/50 p-2.5">
              <div className="mb-1.5 text-[11px] font-medium text-gray-300">민감정보 마스킹</div>
              <label className="flex items-center gap-2 text-xs text-gray-300">
                <input
                  type="checkbox"
                  checked={maskReport}
                  onChange={(e) => {
                    setMaskReport(e.target.checked)
                    setMaskReportEnabled(e.target.checked)
                  }}
                />
                리포트 저장·AI 전송 시 비밀번호/토큰/키 가리기
              </label>
              <label className="mt-2 flex items-center gap-2 text-xs text-gray-300">
                <input
                  type="checkbox"
                  checked={maskDisplay}
                  onChange={(e) => {
                    setMaskDisplay(e.target.checked)
                    setMaskDisplayEnabled(e.target.checked)
                  }}
                />
                실시간 로그 화면에도 마스킹 적용
              </label>
              <label className="mt-2 flex items-center gap-2 text-xs text-gray-300">
                <input
                  type="checkbox"
                  checked={maskIp}
                  disabled={!maskReport && !maskDisplay}
                  onChange={(e) => {
                    setMaskIp(e.target.checked)
                    setMaskIpEnabled(e.target.checked)
                  }}
                />
                <span className={maskReport || maskDisplay ? '' : 'text-gray-500'}>
                  IP 주소도 가리기 (앞 3옥텟)
                </span>
              </label>
            </div>

            <label className="mt-3 block text-[11px] text-gray-400">
              유휴 마스코트 등장 시간 (무동작 상태가 이 시간만큼 지속되면 등장)
            </label>
            <select
              value={idleDelayMs}
              onChange={(e) => changeIdleDelay(Number(e.target.value))}
              className="mt-1 w-full rounded-md border border-white/10 bg-panel-light px-2 py-1 text-xs text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              <option value={0}>끄기 (표시 안 함)</option>
              <option value={60_000}>1분</option>
              <option value={180_000}>3분</option>
              <option value={300_000}>5분</option>
              <option value={600_000}>10분</option>
              <option value={1_200_000}>20분</option>
            </select>

            <div className="mt-4 flex justify-end">
              <button
                onClick={() => setShowSettings(false)}
                className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500"
              >
                닫기
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 설정파일 뷰어 (SFTP) 모달 — 활성 세션 대상 */}
      {showFiles && (
        <FileViewer
          sessionId={activeId}
          connected={connected}
          onClose={() => {
            setShowFiles(false)
            setTimeout(() => activeTerm()?.focus(), 0)
          }}
          onAnalyze={analyzeText}
        />
      )}
    </div>
  )
}
