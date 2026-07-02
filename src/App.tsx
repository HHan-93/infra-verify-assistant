import { useEffect, useRef, useState } from 'react'
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
} from 'lucide-react'
import SSHForm, { type SSHFormHandle } from './components/SSHForm'
import Toolbar from './components/Toolbar'
import PresetPanel from './components/PresetPanel'
import ScenarioPanel from './components/ScenarioPanel'
import TerminalView, { type TerminalHandle } from './components/TerminalView'
import AIPanel, { type AIPanelHandle } from './components/AIPanel'
import Dashboard from './components/Dashboard'
import MonitorOverview from './components/MonitorOverview'
import FileViewer from './components/FileViewer'
import FileExplorer from './components/FileExplorer'
import TunnelManager from './components/TunnelManager'
import MultiRun from './components/MultiRun'
import NodeDiff, { type DiffSource } from './components/NodeDiff'
import TabBar, { type TabInfo, type LayoutMode } from './components/TabBar'
import SessionSidebar, { profileKey } from './components/SessionSidebar'
import Mascot from './components/Mascot'
import type { SavedProfile } from '../electron/shared-types'

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
  const [diffSources, setDiffSources] = useState<DiffSource[] | null>(null)
  // 선택/전체 세션 AI 분석 — 질문 입력 모달 (공용)
  const [analysisPending, setAnalysisPending] = useState<string | null>(null)
  const [analysisLabel, setAnalysisLabel] = useState('선택 AI 분석')
  const [analysisQuestion, setAnalysisQuestion] = useState('')
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
  // 유휴 마스코트 표시 여부 (입력/출력/마우스 없을 때 등장)
  const [idle, setIdle] = useState(false)
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
  // 분할 화면 크기 비율 (드래그 리사이즈, localStorage 보존)
  const [colFrac, setColFrac] = useState(() => Number(localStorage.getItem('split_col')) || 0.5)
  const [rowFrac, setRowFrac] = useState(() => Number(localStorage.getItem('split_row')) || 0.5)
  const colFracRef = useRef(colFrac)
  const rowFracRef = useRef(rowFrac)
  const termAreaRef = useRef<HTMLDivElement>(null)
  const splitDragRef = useRef<null | 'col' | 'row'>(null)

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

  // 레이아웃별 분할 패널 수 / 분할 여부
  const paneCount = layout === '4' ? 4 : layout === 'tabs' ? 1 : 2
  const isSplit = layout !== 'tabs'
  // 분할에 표시되는 세션 ID (앞 paneCount 개)
  const gridIds = tabs.slice(0, paneCount).map((t) => t.id)
  // 동시입력 실제 대상 = 선택된 세션 ∩ 현재 분할 (닫힌/분할 밖 세션 자동 제외)
  const effectiveTargets = gridIds.filter((id) => broadcastTargets.includes(id))
  // 실제 브로드캐스트 활성 여부 (분할 모드 + 동시입력 ON + 대상 1개 이상)
  const broadcasting = isSplit && broadcast && effectiveTargets.length > 0

  // 현재 연결되어 있는 프로필 키 집합 (사이드바 '연결중' 표시)
  const connectedKeys = new Set(
    tabs
      .filter((t) => statuses[t.id]?.status === 'connected' && statuses[t.id]?.key)
      .map((t) => statuses[t.id]!.key as string),
  )

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

  // 분할 경계 드래그 리사이즈
  useEffect(() => {
    const clamp = (v: number) => Math.max(0.15, Math.min(0.85, v))
    const onMove = (e: MouseEvent) => {
      const el = termAreaRef.current
      if (!el || !splitDragRef.current) return
      const r = el.getBoundingClientRect()
      if (splitDragRef.current === 'col') {
        const v = clamp((e.clientX - r.left) / r.width)
        colFracRef.current = v
        setColFrac(v)
      } else {
        const v = clamp((e.clientY - r.top) / r.height)
        rowFracRef.current = v
        setRowFrac(v)
      }
    }
    const onUp = () => {
      splitDragRef.current = null
      document.body.style.cursor = ''
      localStorage.setItem('split_col', String(colFracRef.current))
      localStorage.setItem('split_row', String(rowFracRef.current))
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
      else if (cur === 'closed' && prev === 'connected')
        term?.writeNotice('연결이 종료되었습니다. 다시 연결하려면 SSH 정보를 입력하세요.')
      else if (cur === 'error' && prev === 'connected') term?.writeNotice('연결이 끊겼습니다 (오류).')
    }
  }, [statuses, tabs])

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

  // 세션이 n개 미만이면 부족한 만큼 새로 만들어 채운다 (분할 모드 진입 시)
  const ensureTabs = (n: number) => {
    if (tabs.length >= n) return
    const add: TabInfo[] = []
    let count = tabs.length
    while (count < n) {
      const id = `s${++idCounter.current}`
      add.push({ id, title: `세션 ${count + 1}` })
      count++
    }
    setTabs((t) => [...t, ...add])
    setStatuses((m) => {
      const c = { ...m }
      add.forEach((x) => {
        c[x.id] = { status: 'idle', msg: '' }
      })
      return c
    })
  }

  // 분할 레이아웃 변경 — 분할 모드면 필요한 패널 수만큼 세션 자동 생성
  const setLayout = (l: LayoutMode) => {
    setLayoutMode(l)
    if (l === 'tabs') {
      setBroadcast(false) // 단일 보기로 가면 동시입력 해제(오작동 방지)
      return
    }
    ensureTabs(l === '4' ? 4 : 2)
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
    const n = newIds.length
    if (n >= 2) {
      setLayout(n === 2 ? '2v' : '4')
      setBroadcast(true)
      setBroadcastTargets(newIds.slice(0, n === 2 ? 2 : 4))
    }
  }

  // 사이드바 등록/편집 저장 (키가 바뀌면 기존 항목 삭제 후 갱신)
  const saveProfile = async (p: SavedProfile, originalKey?: string) => {
    if (originalKey && originalKey !== profileKey(p)) {
      await window.electronAPI.profilesDelete(originalKey)
    }
    setProfiles(await window.electronAPI.profilesUpsert(p))
  }

  const deleteProfile = async (p: SavedProfile) => {
    setProfiles(await window.electronAPI.profilesDelete(profileKey(p)))
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
  // 탭을 특정 그리드 칸(index)으로 이동 (탭→칸 드래그 배치)
  const reorderTabToIndex = (id: string, index: number) => {
    setTabs((ts) => {
      const from = ts.findIndex((t) => t.id === id)
      if (from < 0 || from === index) return ts
      const next = [...ts]
      const [m] = next.splice(from, 1)
      next.splice(Math.min(index, next.length), 0, m)
      return next
    })
    setActiveId(id)
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
      const r = await window.electronAPI.logStart(id)
      if (r.ok) setLoggingSessions((s) => new Set(s).add(id))
    }
  }

  // 분할 그리드 행/열 — 세로2분할(좌우)=2열1행, 가로2분할(상하)=1열2행, 4분할=2열2행
  const gridCols = layout === '2h' ? 1 : 2
  const gridRows = layout === '2v' ? 1 : 2

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
      <div className="relative flex flex-1 flex-col border-r border-white/10">
        <Mascot active={idle} />

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

        {/* 세션별 SSH 폼 (활성 탭만 표시 — 비활성은 상태 보존 위해 hidden) */}
        {tabs.map((t) => (
          <div key={t.id} className={t.id === activeId ? '' : 'hidden'}>
            <SSHForm
              ref={(h) => {
                sshFormRefs.current[t.id] = h
              }}
              sessionId={t.id}
              status={statuses[t.id]?.status ?? 'idle'}
              profiles={profiles}
              onConnected={(p) => {
                setStatuses((m) => ({
                  ...m,
                  [t.id]: {
                    status: 'connected',
                    msg: m[t.id]?.msg ?? '',
                    host: p.host,
                    key: profileKey(p),
                    since: m[t.id]?.since ?? Date.now(),
                  },
                }))
                if (p.color) {
                  setTabs((ts) => ts.map((tab) => tab.id === t.id ? { ...tab, color: p.color } : tab))
                }
              }}
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
          logging={loggingSessions.has(activeId)}
          onToggleLog={toggleLog}
          onOpenSettings={() => setShowSettings(true)}
          onCompareNodes={compareNodes}
          onAnalyzeSelection={analyzeSelection}
          onAnalyzeAll={analyzeAll}
        />
        {panel === 'presets' && (
          <PresetPanel connected={connected} onRun={runOnActive} onClose={() => setPanel(null)} />
        )}
        {panel === 'scenarios' && (
          <ScenarioPanel connected={connected} onRun={runOnActive} onClose={() => setPanel(null)} />
        )}

        {isSplit && broadcast && (
          <div className="bg-red-600/15 px-3 py-0.5 text-center text-[11px] font-medium text-red-300">
            {effectiveTargets.length > 0
              ? `⚠ 동시입력 ON — 선택된 ${effectiveTargets.length}개 세션에 동시에 입력됩니다`
              : '동시입력 ON — 대상 세션을 선택하세요 (셀 헤더의 체크박스)'}
          </div>
        )}
        {isSplit && tabs.length > paneCount && (
          <div className="bg-amber-500/10 px-3 py-0.5 text-[11px] text-amber-300">
            분할에는 앞 {paneCount}개 세션만 표시합니다 (나머지는 단일 보기 탭에서 확인).
          </div>
        )}

        {/* 터미널 영역 — 탭 보기(겹침) / 그리드 보기(격자). 인스턴스는 항상 마운트 유지 */}
        <div
          ref={termAreaRef}
          className="relative min-h-0 flex-1 overflow-hidden"
          style={
            isSplit
              ? {
                  display: 'grid',
                  gridTemplateColumns:
                    gridCols === 2 ? `${colFrac}fr ${1 - colFrac}fr` : '1fr',
                  gridTemplateRows: gridRows === 2 ? `${rowFrac}fr ${1 - rowFrac}fr` : '1fr',
                  gap: '2px',
                }
              : {}
          }
        >
          {/* 분할 경계 드래그 핸들 */}
          {isSplit && gridCols === 2 && (
            <div
              onMouseDown={() => {
                splitDragRef.current = 'col'
                document.body.style.cursor = 'col-resize'
              }}
              style={{ left: `calc(${colFrac * 100}% - 3px)` }}
              className="absolute bottom-0 top-0 z-20 w-1.5 cursor-col-resize bg-white/5 hover:bg-blue-400/50"
            />
          )}
          {isSplit && gridRows === 2 && (
            <div
              onMouseDown={() => {
                splitDragRef.current = 'row'
                document.body.style.cursor = 'row-resize'
              }}
              style={{ top: `calc(${rowFrac * 100}% - 3px)` }}
              className="absolute left-0 right-0 z-20 h-1.5 cursor-row-resize bg-white/5 hover:bg-blue-400/50"
            />
          )}
          {tabs.map((t, i) => {
            const inGrid = i < paneCount
            // 이 셀이 동시입력 대상으로 선택되어 있는지
            const isTarget = broadcast && isSplit && broadcastTargets.includes(t.id)
            let cls: string
            if (!isSplit) {
              cls = t.id === activeId ? 'absolute inset-0' : 'hidden'
            } else if (inGrid) {
              cls =
                'relative min-h-0 min-w-0 overflow-hidden ' +
                (isTarget
                  ? 'ring-1 ring-red-500/70'
                  : t.id === activeId
                    ? 'ring-1 ring-blue-400'
                    : 'ring-1 ring-white/10')
            } else {
              cls = 'hidden'
            }
            return (
              <div key={t.id} className={cls} onMouseDown={() => setActiveId(t.id)}>
                {/* 그리드 셀 헤더 바 (터미널을 가리지 않도록 상단에 분리 배치) */}
                {isSplit && inGrid && (
                  <div className="absolute left-0 right-0 top-0 z-10 flex h-[19px] items-center gap-1 border-b border-white/10 bg-panel-light px-1.5 text-[10px] text-gray-300">
                    <Circle size={7} className={dotColor(statuses[t.id]?.status) + ' fill-current'} />
                    <span className="truncate">{t.custom ? t.title : (statuses[t.id]?.host ?? t.title)}</span>
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
                {/* 탭을 이 칸으로 드래그 배치 (그리드 모드) */}
                {draggingTabId && isSplit && inGrid && (
                  <div
                    onDragOver={(e) => {
                      e.preventDefault()
                      e.dataTransfer.dropEffect = 'move'
                      if (dragOverId !== t.id) setDragOverId(t.id)
                    }}
                    onDragLeave={() => setDragOverId((cur) => (cur === t.id ? null : cur))}
                    onDrop={(e) => {
                      e.preventDefault()
                      if (draggingTabId) reorderTabToIndex(draggingTabId, i)
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
                {draggingProfile && (!isSplit ? t.id === activeId : inGrid) && (
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
                  headerSpace={isSplit && inGrid}
                  fontSize={fontSize}
                  highlight={highlight}
                  theme={{
                    background: theme.background,
                    foreground: theme.foreground,
                    cursor: theme.cursor,
                  }}
                />
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
            <AIPanel ref={aiPanelRef} onClose={() => setShowAI(false)} />
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
        <FileExplorer sessionId={activeId} connected={connected} onClose={() => setShowExplorer(false)} />
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
