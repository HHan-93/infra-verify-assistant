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
import FileViewer from './components/FileViewer'
import FileExplorer from './components/FileExplorer'
import LiveLogViewer from './components/LiveLogViewer'
import TunnelManager from './components/TunnelManager'
import MultiRun from './components/MultiRun'
import NodeDiff, { type DiffSource } from './components/NodeDiff'
import TabBar, { type TabInfo, type LayoutMode } from './components/TabBar'
import SessionSidebar, { profileKey } from './components/SessionSidebar'
import Mascot from './components/Mascot'
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

/** 터미널 색상 테마 프리셋 */
const THEMES: Record<string, { name: string; background: string; foreground: string; cursor: string }> = {
  default: { name: '기본 (Catppuccin)', background: '#1e1e2e', foreground: '#cdd6f4', cursor: '#f5e0dc' },
  black: { name: '블랙', background: '#000000', foreground: '#e0e0e0', cursor: '#ffffff' },
  solarized: { name: '솔라라이즈드 다크', background: '#002b36', foreground: '#839496', cursor: '#93a1a1' },
  light: { name: '라이트', background: '#fafafa', foreground: '#2b2b2b', cursor: '#2b2b2b' },
}

/** 유휴 마스코트 등장까지의 시간(ms) */
const IDLE_DELAY = 60_000
/** 활동 발생 후 마스코트를 유지하다 사라지기까지의 유예(ms) */
const HIDE_GRACE = 5_000

const MAX_SESSIONS = 6

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
  const [tabs, setTabs] = useState<TabInfo[]>([{ id: 's1', title: '세션 1' }])
  const [activeId, setActiveId] = useState('s1')
  const [statuses, setStatuses] = useState<Record<string, SessionStatus>>({
    s1: { status: 'idle', msg: '' },
  })
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
  const [showLogViewer, setShowLogViewer] = useState(false)
  // 실시간 로그(tail -f) 뷰어 — 파일탐색기의 "실시간 보기"로 열면 prefillPath 가 채워짐
  const [showLiveLog, setShowLiveLog] = useState(false)
  const [liveLogPrefill, setLiveLogPrefill] = useState<string | undefined>(undefined)
  const [diffSources, setDiffSources] = useState<DiffSource[] | null>(null)
  // 선택/전체 세션 AI 분석 — 질문 입력 모달 (공용)
  const [analysisPending, setAnalysisPending] = useState<string | null>(null)
  const [analysisLabel, setAnalysisLabel] = useState('선택 AI 분석')
  const [analysisQuestion, setAnalysisQuestion] = useState('')
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
  // 사이드바 더블클릭/클러스터 열기 → 탭 폼이 마운트되면 연결 (지연 연결 큐)
  const [pendingConnects, setPendingConnects] = useState<{ id: string; p: SavedProfile }[]>([])
  // 사이드바에서 터미널로 드래그 중인 프로필 (드롭 오버레이 표시)
  const [draggingProfile, setDraggingProfile] = useState<SavedProfile | null>(null)
  // 드래그가 올라가 있는 터미널 세션 id (하이라이트)
  const [dragOverId, setDragOverId] = useState<string | null>(null)
  // 탭을 그리드 칸으로 드래그 중인 탭 id
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null)
  // 그리드 모드에서 인라인 SSH 연결 폼이 열려있는 셀의 세션 id — 상단 공용 폼과 분리되어
  // 이 칸을 선택(클릭)한다고 해서 자동으로 열리거나 닫히지 않는다(레이아웃 흔들림 방지).
  const [openConnectCellId, setOpenConnectCellId] = useState<string | null>(null)
  // 유휴 마스코트 표시 여부 (입력/출력/마우스 없을 때 등장)
  const [idle, setIdle] = useState(false)
  // 마스코트 리액션(놀람/슬픔) 트리거 — 마스코트가 이미 나와있을 때(idle)만 반영됨
  const [mascotReaction, setMascotReaction] = useState<{ type: 'surprised' | 'sad'; nonce: number } | null>(null)
  const triggerMascotReaction = (type: 'surprised' | 'sad') => {
    if (!idle) return
    setMascotReaction({ type, nonce: Date.now() })
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
  // 임의 재귀 분할 레이아웃(tmux 스타일) — null 이면 탭 보기와 동일(단일 리프로 취급)
  const [splitTree, setSplitTree] = useState<PaneNode | null>(null)
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

  // 세션ID 생성용 카운터 (s1 은 초기값으로 이미 사용)
  const idCounter = useRef(1)
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
  // 분할 트리가 현재 화면에 보여주는 세션 id 목록 (중복 가능 — 스페어 탭 없이 분할한 경우)
  const gridIds = isSplit && splitTree ? collectLeafTabIds(splitTree) : []
  // 동시입력 실제 대상 = 선택된 세션 ∩ 현재 분할 (닫힌/분할 밖 세션 자동 제외)
  const effectiveTargets = gridIds.filter((id) => broadcastTargets.includes(id))
  // 실제 브로드캐스트 활성 여부 (분할 모드 + 동시입력 ON + 대상 1개 이상)
  const broadcasting = isSplit && broadcast && effectiveTargets.length > 0
  // 분할 가능 여부 — 아직 트리에 없는 스페어 탭이 있거나, 세션을 더 만들 여유가 있으면 항상 분할 가능
  const canSplit = new Set(gridIds).size < MAX_SESSIONS
  // 활성 세션이 분할 트리 안에 있고, 트리에 칸이 2개 이상일 때만 "칸 닫기" 가능
  const canClosePane = isSplit && !!splitTree && splitTree.type === 'split' && !!findLeaf(splitTree, activeId)

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

  // 유휴 감지 — IDLE_DELAY 동안 활동 없으면 등장. 등장 중 활동이 생기면
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
        // 미표시 → 충분히 유휴면 등장
        if (now - lastActivityRef.current > IDLE_DELAY) {
          idleRef.current = true
          hideAtRef.current = 0
          setIdle(true)
        }
      } else {
        // 표시 중 → 예약된 사라짐 시각 지나면 숨김
        if (hideAtRef.current && now >= hideAtRef.current) {
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
        const keepHost = event.status === 'connected' || event.status === 'connecting'
        return {
          ...m,
          [event.sessionId]: {
            status: event.status,
            msg: event.message ?? prev?.msg ?? '',
            host: keepHost ? prev?.host : undefined,
            key: keepHost ? prev?.key : undefined,
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
  useEffect(() => {
    for (const t of tabs) {
      const cur = statuses[t.id]?.status ?? 'idle'
      const prev = prevStatuses.current[t.id] ?? 'idle'
      if (cur === prev) continue
      prevStatuses.current[t.id] = cur
      const term = terminalRefs.current[t.id]
      if (cur === 'connecting') term?.reset()
      else if (cur === 'closed' && prev === 'connected') {
        term?.writeNotice('연결이 종료되었습니다. 다시 연결하려면 SSH 정보를 입력하세요.')
        triggerMascotReaction('sad')
      } else if (cur === 'error' && prev === 'connected') {
        term?.writeNotice('연결이 끊겼습니다 (오류).')
        triggerMascotReaction('sad')
      }
    }
  }, [statuses, tabs])

  // 그리드 셀 인라인 연결 폼 — 연결에 성공하면 자동으로 닫고 터미널을 보여준다
  useEffect(() => {
    if (openConnectCellId && statuses[openConnectCellId]?.status === 'connected') {
      setOpenConnectCellId(null)
    }
  }, [openConnectCellId, statuses])

  // ── 탭 추가/닫기 / 보기 모드 ──────────────────────────────────
  // 새 탭 생성 (활성 전환은 호출부에서). 생성된 id 반환
  const createTab = (): string => {
    const id = `s${++idCounter.current}`
    setTabs((t) => [...t, { id, title: `세션 ${t.length + 1}` }])
    setStatuses((m) => ({ ...m, [id]: { status: 'idle', msg: '' } }))
    return id
  }

  const addTab = () => {
    if (tabs.length >= MAX_SESSIONS) return
    setActiveId(createTab())
  }


  // 레이아웃 전환 — 탭(단일) 보기로 가면 동시입력 해제(오작동 방지) 하고, 분할용으로 자동
  // 추가됐다가 한 번도 연결 안 해본(idle) 빈 세션 탭은 정리한다 — 연결됐거나 연결 시도/오류
  // 이력이 있는 세션(closed/error/connecting)은 다시 쓸 수 있어야 하니 그대로 둔다.
  const setLayout = (l: LayoutMode) => {
    setLayoutMode(l)
    if (l !== 'tabs') return
    setBroadcast(false)
    const idleIds = tabs.filter((t) => t.id !== activeId && (statuses[t.id]?.status ?? 'idle') === 'idle').map((t) => t.id)
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
    // 트리에 빈 세션이 남아있으면 다음에 분할 보기로 돌아왔을 때 존재하지 않는 탭을 가리키는
    // 빈 칸이 생기므로, 이번에 정리한 이상 트리도 함께 비운다(다음 분할은 새로 구성됨).
    setSplitTree(null)
  }

  // 기본 제공 프리셋(좌우2분할/상하2분할/4분할) — 활성 세션을 포함해 원클릭으로 균형 트리를 새로 구성.
  // 기존 트리는 버리고 처음부터 다시 짜므로 항상 예측 가능한 결과가 나온다(임의분할은 이후 보조로 계속 다듬을 수 있음).
  const applyPresetLayout = (preset: '2v' | '2h' | '4') => {
    const n = preset === '4' ? 4 : 2
    const dir: 'row' | 'col' = preset === '2h' ? 'col' : 'row'
    const ids = [activeId]
    for (const t of tabs) {
      if (ids.length >= n) break
      if (!ids.includes(t.id)) ids.push(t.id)
    }
    let total = tabs.length
    while (ids.length < n && total < MAX_SESSIONS) {
      ids.push(createTab())
      total++
    }
    setSplitTree(buildBalancedTree(ids, nextPaneId, dir))
    setLayoutMode('split')
  }

  // 활성 세션이 있는 칸을 dir 방향으로 분할 — 아직 트리에 없는 스페어 탭이 있으면 그걸, 없으면 새 세션을 만들어 채운다.
  // 탭 보기로 갔다가 트리에 없는 다른 세션으로 바꾼 뒤 분할하면, 기존 트리는 버리고 그 세션 하나부터 새로 시작한다.
  const baseTreeFor = (activeTabId: string): PaneNode =>
    splitTree && findLeaf(splitTree, activeTabId) ? splitTree : { type: 'leaf', id: nextPaneId(), tabId: activeTabId }
  const splitActivePane = (dir: 'row' | 'col') => {
    const baseTree = baseTreeFor(activeId)
    const activeLeaf = findLeaf(baseTree, activeId)
    const leafId = activeLeaf?.id ?? (baseTree.type === 'leaf' ? baseTree.id : null)
    if (!leafId) return
    const usedIds = new Set(collectLeafTabIds(baseTree))
    const spare = tabs.find((t) => !usedIds.has(t.id))?.id
    const newTabId = spare ?? (tabs.length < MAX_SESSIONS ? createTab() : null)
    if (!newTabId) return // 스페어도 없고 더 만들 여유도 없으면(세션 한도) 분할하지 않음
    setSplitTree(splitLeaf(baseTree, leafId, dir, nextPaneId(), nextPaneId(), newTabId))
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
      // 단일 리프(다른 세션을 가리킬 수 있음)가 되어 버려서 엉뚱한 세션이 분할되는 문제 방지
      setSplitTree(null)
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
    let target = activeId
    if (!free(activeId)) {
      const freeTab = tabs.find((t) => free(t.id))
      if (freeTab) target = freeTab.id
      else if (tabs.length < MAX_SESSIONS) target = createTab()
    }
    setActiveId(target)
    setPendingConnects((q) => [...q, { id: target, p }])
  }

  // 여러 세션을 한 번에 그리드+동시입력으로 열기 (클러스터)
  const openCluster = (list: SavedProfile[]) => {
    const connectedCount = tabs.filter((t) => {
      const s = statuses[t.id]?.status
      return s === 'connected' || s === 'connecting'
    }).length
    const room = Math.max(1, MAX_SESSIONS - connectedCount)
    const sel = list.slice(0, room)
    if (!sel.length) return
    const newIds = sel.map(() => createTab())
    // 새 탭들을 앞으로 모아 그리드 앞칸에 표시
    setTabs((ts) => {
      const news = ts.filter((t) => newIds.includes(t.id))
      const olds = ts.filter((t) => !newIds.includes(t.id))
      return [...news, ...olds]
    })
    setActiveId(newIds[0])
    setPendingConnects((q) => [...q, ...newIds.map((id, i) => ({ id, p: sel[i] }))])
    if (newIds.length >= 2) {
      setSplitTree(buildBalancedTree(newIds, nextPaneId))
      setLayoutMode('split')
      setBroadcast(true)
      setBroadcastTargets(newIds)
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
    setActiveId(nid)
    if (p) setPendingConnects((q) => [...q, { id: nid, p }]) // 연결돼 있던 세션이면 같은 프로필로 연결
  }

  // 사이드바에서 세션을 폴더로 드래그 → 그룹(폴더) 변경 (키 불변이므로 upsert만)
  const moveProfile = async (p: SavedProfile, group: string | undefined) => {
    setProfiles(await window.electronAPI.profilesUpsert({ ...p, group: group || undefined }))
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

  // 사이드바 → 터미널 드롭: 그 터미널의 세션으로 즉시 연결
  const dropConnect = (id: string) => {
    const p = draggingProfile
    setDraggingProfile(null)
    setDragOverId(null)
    if (!p) return
    setActiveId(id)
    sshFormRefs.current[id]?.connectProfile(p)
  }

  const closeTab = (id: string) => {
    window.electronAPI.sessionClose(id) // 백엔드 연결/로컬셸 정리
    const remaining = tabs.filter((x) => x.id !== id)
    if (remaining.length === 0) {
      const nid = `s${++idCounter.current}`
      setTabs([{ id: nid, title: '세션 1' }])
      setStatuses({ [nid]: { status: 'idle', msg: '' } })
      setActiveId(nid)
      setSplitTree(null)
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
    // 닫는 탭이 분할 트리 안에 있었다면 그 칸을 제거(안 그러면 존재하지 않는 탭을 가리키는 빈 칸이 남음).
    // 활성 탭을 닫은 경우, 분할 트리에 남은 칸이 있으면 그쪽을 먼저 활성화(보고 있던 그리드 안에서 포커스 유지).
    let nextActive: string | null = null
    if (splitTree) {
      const next = removeTabId(splitTree, id)
      if (!next || next.type === 'leaf') {
        setSplitTree(null)
        setLayoutMode('tabs')
        if (next) nextActive = next.tabId
      } else {
        setSplitTree(next)
        if (id === activeId) nextActive = collectLeafTabIds(next)[0]
      }
    }
    if (id === activeId) setActiveId(nextActive ?? remaining[remaining.length - 1].id)
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
    setAnalysisLabel('선택 AI 분석')
    setAnalysisQuestion('')
  }

  const submitAnalysis = () => {
    if (analysisPending === null) return
    setShowAI(true)
    aiPanelRef.current?.analyze(analysisPending, analysisQuestion.trim() || undefined)
    setAnalysisPending(null)
    setAnalysisQuestion('')
  }
  // 연결된 모든 세션 출력을 라벨과 함께 묶어 한 번에 AI 분석
  const analyzeAll = () => {
    const parts = tabs
      .filter((t) => statuses[t.id]?.status === 'connected')
      .map((t) => {
        const label = t.custom ? t.title : (statuses[t.id]?.host ?? t.title)
        const text = terminalRefs.current[t.id]?.getRecentOutput(60) ?? ''
        return `### 세션: ${label}\n${text}`
      })
    const ctx = parts.length
      ? `다음은 여러 노드(세션)의 최근 터미널 출력입니다. 노드 간 차이/이상 징후를 비교 분석해 주세요.\n\n${parts.join('\n\n')}`
      : (activeTerm()?.getRecentOutput() ?? '')
    setAnalysisPending(ctx)
    setAnalysisLabel('전체 세션 AI 분석')
    setAnalysisQuestion('')
  }

  // 노드 간 출력 비교 — 연결된 세션들의 선택영역(없으면 최근 출력)을 모아 diff
  const compareNodes = () => {
    const sources: DiffSource[] = tabs
      .filter((t) => statuses[t.id]?.status === 'connected')
      .map((t) => {
        const ref = terminalRefs.current[t.id]
        const sel = ref?.getSelection() ?? ''
        const text = sel.trim() ? sel : (ref?.getRecentOutput(50) ?? '')
        return {
          id: t.id,
          label: t.custom ? t.title : (statuses[t.id]?.host ?? t.title),
          lines: text.replace(/\s+$/, '').split('\n'),
        }
      })
    setDiffSources(sources)
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
          onMove={moveProfile}
          onRenameFolder={renameFolder}
          onReorder={reorderProfiles}
          onOpenMulti={openCluster}
          onImport={() => setShowImportGuide(true)}
          onCollapse={() => setShowSidebar(false)}
          onDragProfileStart={(p) => setDraggingProfile(p)}
          onDragProfileEnd={() => {
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
          onSelect={setActiveId}
          onAdd={addTab}
          onClose={closeTab}
          onRename={renameTab}
          onReorder={reorderTabs}
          onDuplicate={duplicateTab}
          onTabDragStart={(id) => setDraggingTabId(id)}
          onTabDragEnd={() => {
            setDraggingTabId(null)
            setDragOverId(null)
          }}
          layout={layout}
          onSetLayout={setLayout}
          onApplyPreset={applyPresetLayout}
          onSplitPane={splitActivePane}
          canSplit={canSplit}
          onClosePane={closeActivePane}
          canClosePane={canClosePane}
          broadcast={broadcast}
          onToggleBroadcast={toggleBroadcast}
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
          onCompareNodes={compareNodes}
          onAnalyzeSelection={analyzeSelection}
          onAnalyzeAll={analyzeAll}
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
                <ScenarioPanel connected={connected} onRun={runOnActive} onClose={() => setPanel(null)} />
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
              ? `⚠ 동시입력 ON — 선택된 ${effectiveTargets.length}개 세션에 동시에 입력됩니다`
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
          {tabs.map((t) => {
            const leaf = isSplit && splitTree ? paneLeaves.find((l) => l.tabId === t.id) : undefined
            // 이 셀이 동시입력 대상으로 선택되어 있는지
            const isTarget = broadcast && isSplit && broadcastTargets.includes(t.id)
            let cls: string
            let posStyle: React.CSSProperties | undefined
            if (!isSplit) {
              cls = t.id === activeId ? 'absolute inset-0' : 'hidden'
            } else if (leaf) {
              cls =
                'absolute overflow-hidden ' +
                (isTarget
                  ? 'ring-1 ring-red-500/70'
                  : t.id === activeId
                    ? 'ring-1 ring-blue-400'
                    : 'ring-1 ring-white/10')
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
                {/* 그리드 셀 헤더 바 (터미널을 가리지 않도록 상단에 분리 배치) */}
                {isSplit && leaf && (
                  <div className="absolute left-0 right-0 top-0 z-10 flex h-[19px] items-center gap-1 border-b border-white/10 bg-panel-light px-1.5 text-[10px] text-gray-300">
                    <Circle size={7} className={dotColor(statuses[t.id]?.status) + ' fill-current'} />
                    <span className="truncate">{gridCellLabel(t)}</span>
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
                    {broadcast && (
                      <button
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation()
                          toggleTarget(t.id)
                        }}
                        title={isTarget ? '동시입력 대상에서 제외' : '동시입력 대상에 포함'}
                        className={
                          'ml-auto flex items-center gap-1 rounded px-1.5 text-[10px] font-medium ' +
                          (isTarget ? 'bg-red-600/80 text-white' : 'text-gray-400 hover:bg-white/10')
                        }
                      >
                        {isTarget ? <CheckSquare size={10} /> : <Square size={10} />}
                        동시입력
                      </button>
                    )}
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
            <AIPanel ref={aiPanelRef} onClose={() => setShowAI(false)} onRunCommand={runOnActive} />
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
                  setActiveId(id)
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
        />
      )}

      {/* 세션 로그 뷰어(목록/검색/리플레이) */}
      {showLogViewer && <LogViewer onClose={() => setShowLogViewer(false)} />}

      {/* 노드 간 출력 비교 모달 */}
      {diffSources && <NodeDiff sources={diffSources} onClose={() => setDiffSources(null)} />}

      {/* 선택 AI 분석 — 질문 입력 모달 */}
      {analysisPending !== null && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
          onClick={() => setAnalysisPending(null)}
        >
          <div
            className="w-full max-w-md rounded-lg border border-white/10 bg-panel p-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setAnalysisPending(null)
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
            <div className="mt-3 flex justify-end gap-2">
              <button
                onClick={() => setAnalysisPending(null)}
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
          onAnalyze={(text) => aiPanelRef.current?.analyze(text)}
        />
      )}
    </div>
  )
}
