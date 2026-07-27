import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  X,
  Play,
  Pause,
  Search,
  FolderTree,
  Loader2,
  Eye,
  EyeOff,
  ArrowDownToLine,
  CornerDownLeft,
  Plus,
  Columns2,
  RefreshCw,
  Box,
  Bookmark,
  Save,
  Trash2,
  FileText,
} from 'lucide-react'
import type { LogTailTarget } from '../../electron/shared-types'
import RemotePathPicker from './RemotePathPicker'
import { renderLogLine, lineBucket, type LineBucket } from '../lib/logDisplay'

interface OtherSession {
  id: string
  label: string
}

// 레벨 필터 카테고리 — lineBucket 의 progress/plain 은 "기타"로 합친다.
type FilterCat = 'danger' | 'warn' | 'done' | 'other'
const FILTER_CHIPS: { cat: FilterCat; label: string; onCls: string }[] = [
  { cat: 'danger', label: '위험', onCls: 'bg-red-500/25 text-red-200' },
  { cat: 'warn', label: '경고', onCls: 'bg-amber-500/25 text-amber-200' },
  { cat: 'done', label: '완료', onCls: 'bg-emerald-500/25 text-emerald-200' },
  { cat: 'other', label: '기타', onCls: 'bg-white/15 text-gray-200' },
]
const bucketCat = (b: LineBucket): FilterCat =>
  b === 'danger' || b === 'warn' || b === 'done' ? b : 'other'

interface LiveLogViewerProps {
  sessionId: string
  /** 파일탐색기에서 "실시간 보기"로 열었을 때 미리 채워지는 경로 — 있으면 바로 tail 시작 */
  initialPath?: string
  /** 연결된 다른 세션들 — 패널별로 대상 세션을 바꿔볼 수 있게(다른 서버 로그와 나란히 비교) */
  otherSessions?: OtherSession[]
  /** 현재(기본) 세션의 표시 라벨 — 로그 세트의 세션 힌트 매칭에 사용 */
  currentLabel?: string
  onClose: () => void
}

const DEFAULT_LOG_PATHS = [
  { label: 'syslog(RHEL/CentOS)', path: '/var/log/messages' },
  { label: 'syslog(Debian/Ubuntu)', path: '/var/log/syslog' },
  { label: '인증 로그', path: '/var/log/secure' },
  { label: 'nginx 접속로그', path: '/var/log/nginx/access.log' },
  { label: 'nginx 에러로그', path: '/var/log/nginx/error.log' },
  { label: '커널(dmesg)', path: '/var/log/dmesg' },
]

const RECENT_KEY = 'livelog_recent_paths'
const PRESETS_KEY = 'livelog_presets'
const K8S_RECENT_KEY = 'livelog_k8s_recent'
const MAX_RECENT = 8
const MAX_LINES = 5000

function loadRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY)
    const arr = raw ? JSON.parse(raw) : []
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}
function saveRecent(path: string) {
  const next = [path, ...loadRecent().filter((p) => p !== path)].slice(0, MAX_RECENT)
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next))
  } catch {
    /* 무시 */
  }
}
function removeRecent(path: string) {
  const next = loadRecent().filter((p) => p !== path)
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next))
  } catch {
    /* 무시 */
  }
  return next
}

/** "자주 쓰는 로그" 칩 — 기본값은 DEFAULT_LOG_PATHS 이되, 사용자가 추가/삭제하면 그 결과를 저장 */
function loadPresets(): { label: string; path: string }[] {
  try {
    const raw = localStorage.getItem(PRESETS_KEY)
    if (!raw) return DEFAULT_LOG_PATHS
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr : DEFAULT_LOG_PATHS
  } catch {
    return DEFAULT_LOG_PATHS
  }
}
function savePresets(list: { label: string; path: string }[]) {
  try {
    localStorage.setItem(PRESETS_KEY, JSON.stringify(list))
  } catch {
    /* 무시 */
  }
}

// ── 로그 세트 — 2분할 조합(경로/파드 × 2)을 이름 붙여 저장해 한 번에 불러오기 ──
const SETS_KEY = 'livelog_sets'
type SavedPaneTarget =
  | { kind: 'file'; path: string; sessionHint?: string }
  | { kind: 'k8s'; namespace: string; pod: string; container?: string; sessionHint?: string }
interface LogSet {
  name: string
  panes: SavedPaneTarget[] // 1~2개
}
function loadSets(): LogSet[] {
  try {
    const raw = localStorage.getItem(SETS_KEY)
    const arr = raw ? JSON.parse(raw) : []
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}
function saveSets(list: LogSet[]) {
  try {
    localStorage.setItem(SETS_KEY, JSON.stringify(list))
  } catch {
    /* 무시 */
  }
}
/** SavedPaneTarget → 실제 tail 대상(LogTailTarget) */
function toTailTarget(p: SavedPaneTarget): LogTailTarget {
  return p.kind === 'file'
    ? { kind: 'file', path: p.path }
    : { kind: 'k8s', namespace: p.namespace, pod: p.pod, container: p.container }
}
/** 세트 칩에 보여줄 짧은 라벨 */
function paneSummary(p: SavedPaneTarget): string {
  return p.kind === 'file' ? p.path : `${p.namespace}/${p.pod}${p.container ? ':' + p.container : ''}`
}

interface K8sRecentEntry {
  namespace: string
  pod: string
  container?: string
}
function k8sKey(e: K8sRecentEntry) {
  return `${e.namespace}/${e.pod}${e.container ? ':' + e.container : ''}`
}
function loadK8sRecent(): K8sRecentEntry[] {
  try {
    const raw = localStorage.getItem(K8S_RECENT_KEY)
    const arr = raw ? JSON.parse(raw) : []
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}
function saveK8sRecent(entry: K8sRecentEntry) {
  const next = [entry, ...loadK8sRecent().filter((e) => k8sKey(e) !== k8sKey(entry))].slice(0, MAX_RECENT)
  try {
    localStorage.setItem(K8S_RECENT_KEY, JSON.stringify(next))
  } catch {
    /* 무시 */
  }
}
function removeK8sRecent(entry: K8sRecentEntry) {
  const next = loadK8sRecent().filter((e) => k8sKey(e) !== k8sKey(entry))
  try {
    localStorage.setItem(K8S_RECENT_KEY, JSON.stringify(next))
  } catch {
    /* 무시 */
  }
  return next
}

/**
 * 실시간 로그(tail -f / kubectl logs -f) 뷰어 — 패널 하나.
 *  - 소스: [파일 경로] 또는 [Kubernetes 파드] 중 선택
 *  - 파일: 자동완성 + "찾아보기"(트리) + 자주 쓰는 로그 프리셋 칩 + 최근 경로
 *  - 파드: 네임스페이스 → 파드 → (다중 컨테이너면) 컨테이너 순으로 선택 + 최근 사용 조합
 *  - 시작 후에는 계속 흘러들어오는 줄을 자동 스크롤로 표시, 키워드 강조, 일시정지 지원
 */
function LogTailPane({
  sessionId,
  otherSessions,
  initialPath,
  initialTarget,
  initialSessionId,
  autoStart,
  onActiveTarget,
  paneTitle,
  onRequestClose,
  currentLabel,
}: {
  sessionId: string
  otherSessions: OtherSession[]
  /** 현재(기본) 세션의 표시 라벨(별칭·IP) */
  currentLabel?: string
  initialPath?: string
  /** 로그 세트에서 불러온 대상(파일/파드) — 있으면 마운트 시 바로 tail 시작 */
  initialTarget?: LogTailTarget
  /** 세트에서 지정한 대상 세션 id — 없으면 기본 sessionId */
  initialSessionId?: string
  /** false 면 initialTarget 을 자동 실행하지 않고 입력란만 채워 대기(폴백 세션 오실행 방지) */
  autoStart?: boolean
  /** tail 시작할 때마다 현재 (대상, 세션)을 부모에 알림 — '세트로 저장'용 */
  onActiveTarget?: (target: LogTailTarget, sessionId: string) => void
  paneTitle?: string
  onRequestClose?: () => void
}) {
  const [targetSessionId, setTargetSessionId] = useState(initialSessionId ?? sessionId)
  const [stage, setStage] = useState<'entry' | 'tail'>('entry')
  const [sourceKind, setSourceKind] = useState<'file' | 'k8s'>('file')

  // ── 파일 모드 ──
  const [pathInput, setPathInput] = useState(initialPath ?? '')
  const [acOpen, setAcOpen] = useState(false)
  const [acEntries, setAcEntries] = useState<{ name: string; type: string }[]>([])
  const acDirRef = useRef<string | null>(null)
  const acTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [showPicker, setShowPicker] = useState(false)
  const [recent, setRecent] = useState<string[]>(() => loadRecent())
  const [presets, setPresets] = useState(() => loadPresets())
  const [showAddPreset, setShowAddPreset] = useState(false)
  const [newPresetLabel, setNewPresetLabel] = useState('')
  const [newPresetPath, setNewPresetPath] = useState('')

  // ── Kubernetes 모드 ──
  const [namespaces, setNamespaces] = useState<string[]>([])
  const [nsLoading, setNsLoading] = useState(false)
  const [nsError, setNsError] = useState('')
  const [namespace, setNamespace] = useState('')
  const [pods, setPods] = useState<string[]>([])
  const [podLoading, setPodLoading] = useState(false)
  const [podError, setPodError] = useState('')
  const [podInput, setPodInput] = useState('')
  const [podAcOpen, setPodAcOpen] = useState(false)
  const [containers, setContainers] = useState<string[]>([])
  const [container, setContainer] = useState('')
  const [k8sRecent, setK8sRecent] = useState<K8sRecentEntry[]>(() => loadK8sRecent())

  // ── 공용(시작/오류) ──
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState('')
  const [needSudo, setNeedSudo] = useState(false)
  const [sudoPw, setSudoPw] = useState('')
  const [showSudoPw, setShowSudoPw] = useState(false)

  // ── tail 상태 ──
  const [tailLabel, setTailLabel] = useState('')
  const tailIdRef = useRef<string | null>(null)
  const currentTargetRef = useRef<LogTailTarget | null>(null) // 현재 tail 중인 대상 — 세션 전환 시 같은 대상 재사용
  const pendingRef = useRef('') // 줄바꿈으로 안 끝난 마지막 조각(다음 청크와 이어붙임)
  // tailId 가 확정되기 전(= logtailStart invoke 응답이 renderer 에 아직 안 온 시점)에 도착하는
  // 초기 데이터(tail -n 200 의 기존 로그 덤프 등)를 버려지지 않게 잠깐 담아두는 버퍼.
  const earlyBufferRef = useRef<{ tailId: string; data: string }[]>([])
  const [lines, setLines] = useState<string[]>([])
  const pausedRef = useRef(false)
  const [paused, setPaused] = useState(false)
  const pausedQueueRef = useRef<string[]>([])
  const [pendingCount, setPendingCount] = useState(0)
  const [autoScroll, setAutoScroll] = useState(true)
  const [highlightQuery, setHighlightQuery] = useState('')
  const [closedNotice, setClosedNotice] = useState('')
  // 레벨 필터 — 표시할 카테고리 집합(위험/경고/완료/기타) + 정규식 필터
  const [levelFilter, setLevelFilter] = useState<Set<FilterCat>>(
    () => new Set<FilterCat>(['danger', 'warn', 'done', 'other']),
  )
  const [regexFilter, setRegexFilter] = useState('')
  // 라인 북마크 — 내용 기준(버퍼가 5000줄에서 앞부터 잘려도 안전). '북마크만' 필터 가능.
  const [bookmarks, setBookmarks] = useState<Set<string>>(new Set())
  const [bookmarkOnly, setBookmarkOnly] = useState(false)
  const toggleBookmark = (line: string) =>
    setBookmarks((s) => {
      const n = new Set(s)
      if (n.has(line)) n.delete(line)
      else n.add(line)
      return n
    })
  const bodyRef = useRef<HTMLDivElement>(null)

  // 청크 데이터를 줄 단위로 쪼개 lines(또는 일시정지 큐)에 반영. 실시간 수신 경로와
  // earlyBufferRef 드레인 경로가 동일한 로직을 타야 하므로 함수로 분리.
  const ingest = useCallback((data: string) => {
    const combined = pendingRef.current + data
    const parts = combined.split('\n')
    pendingRef.current = parts.pop() ?? ''
    if (!parts.length) return
    if (pausedRef.current) {
      pausedQueueRef.current.push(...parts)
      if (pausedQueueRef.current.length > MAX_LINES) {
        pausedQueueRef.current = pausedQueueRef.current.slice(pausedQueueRef.current.length - MAX_LINES)
      }
      setPendingCount(pausedQueueRef.current.length)
      return
    }
    setLines((prev) => {
      const next = [...prev, ...parts]
      return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next
    })
  }, [])

  // 원격 데이터 수신 구독 — targetSessionId 뿐 아니라 tailId 로도 필터링해야 함. 같은 세션에서
  // "다른 경로"로 재시작하면(컴포넌트는 그대로, tailId만 바뀜) 이전 tail 의 늦게 도착하는
  // close 이벤트나 버퍼된 데이터가 새 tail 화면을 덮어쓰는 걸 막기 위함.
  useEffect(() => {
    const offData = window.electronAPI.onLogtailData((d) => {
      if (d.sessionId !== targetSessionId) return
      if (!tailIdRef.current) {
        // logtailStart 의 invoke 응답(및 tailIdRef 반영)보다 main 프로세스의 grace-period
        // 초기 덤프(tail -n 200 등)가 먼저 도착하는 경우가 있다 — 유실되지 않게 잠깐 버퍼링.
        earlyBufferRef.current.push(d)
        if (earlyBufferRef.current.length > 500) earlyBufferRef.current.shift()
        return
      }
      if (d.tailId !== tailIdRef.current) return
      ingest(d.data)
    })
    const offClosed = window.electronAPI.onLogtailClosed((d) => {
      if (d.sessionId !== targetSessionId || d.tailId !== tailIdRef.current) return
      setClosedNotice('연결이 종료되었습니다 (세션 재접속 또는 대상 삭제 등으로 스트림이 끊겼습니다).')
    })
    return () => {
      offData()
      offClosed()
    }
  }, [targetSessionId, ingest])

  // 자동 스크롤 (잠금 상태일 때만, 새 줄 도착 시 맨 아래로)
  useEffect(() => {
    if (!autoScroll) return
    const el = bodyRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines, autoScroll])

  // 언마운트 시 tail 정리
  useEffect(() => {
    return () => {
      if (tailIdRef.current) window.electronAPI.logtailStop(targetSessionId, tailIdRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const startTail = async (target: LogTailTarget, sudoPassword?: string, sessionOverride?: string) => {
    // sessionOverride — 세션 전환 시 setTargetSessionId 는 비동기라, 이번 호출에 쓸 세션을 직접 넘긴다.
    const sid = sessionOverride ?? targetSessionId
    setStarting(true)
    setStartError('')
    const r = await window.electronAPI.logtailStart(sid, target, sudoPassword)
    setStarting(false)
    if (r.ok) {
      tailIdRef.current = r.tailId ?? null
      setTailLabel(target.kind === 'file' ? target.path : `${target.namespace}/${target.pod}${target.container ? ':' + target.container : ''}`)
      setLines([])
      pendingRef.current = ''
      pausedQueueRef.current = []
      setPendingCount(0)
      setPaused(false)
      pausedRef.current = false
      setAutoScroll(true)
      setClosedNotice('')
      setNeedSudo(false)
      setSudoPw('')
      if (target.kind === 'file') {
        saveRecent(target.path)
        setRecent(loadRecent())
      } else {
        saveK8sRecent({ namespace: target.namespace, pod: target.pod, container: target.container })
        setK8sRecent(loadK8sRecent())
      }
      // tailId 확정 전에 도착해 earlyBufferRef 에 쌓여 있던 초기 데이터(tail -n 200 덤프 등)를 반영
      const buffered = earlyBufferRef.current.filter((x) => x.tailId === tailIdRef.current)
      earlyBufferRef.current = []
      buffered.forEach((d) => ingest(d.data))
      currentTargetRef.current = target
      setStage('tail')
      onActiveTarget?.(target, sid) // '세트로 저장'용 — 현재 대상/세션 부모에 보고
    } else if (r.needSudoPassword) {
      setNeedSudo(true)
      // tail 중(세션 전환 등)이라면 입력 단계의 sudo UI 가 안 보이므로 배너로 안내
      if (stage === 'tail') {
        setLines([])
        setClosedNotice("이 세션은 root 권한이 필요합니다. '다른 경로'로 다시 열어 sudo 비밀번호를 입력하세요.")
      }
    } else {
      const msg = r.error || '로그를 열 수 없습니다.'
      setStartError(msg)
      // tail 중 실패(대상 파일/파드 없음 등) — 이전 로그가 남지 않게 비우고 배너로 안내
      if (stage === 'tail') {
        setLines([])
        setTailLabel(
          target.kind === 'file'
            ? target.path
            : `${target.namespace}/${target.pod}${target.container ? ':' + target.container : ''}`,
        )
        setClosedNotice(`이 세션에서 로그를 열 수 없습니다: ${msg}`)
      }
    }
  }

  const startFileTail = (sudoPassword?: string) => {
    const p = pathInput.trim()
    if (!p) return
    startTail({ kind: 'file', path: p }, sudoPassword)
  }
  const startK8sTail = () => {
    const ns = namespace.trim()
    const pod = podInput.trim()
    if (!ns || !pod) return
    startTail({ kind: 'k8s', namespace: ns, pod, container: container || undefined })
  }
  // tail 중 세션 전환 — 같은 대상(경로/파드)을 다른 연결 세션에 다시 붙인다.
  const retargetSession = (newSid: string) => {
    const t = currentTargetRef.current
    if (!t || newSid === targetSessionId) return
    if (tailIdRef.current) window.electronAPI.logtailStop(targetSessionId, tailIdRef.current)
    tailIdRef.current = null
    // 전환 순간 이전 세션의 로그를 즉시 비운다 — 새 세션에서 안 열려도 옛 로그가 남지 않게.
    setLines([])
    pendingRef.current = ''
    earlyBufferRef.current = []
    setClosedNotice('')
    setTargetSessionId(newSid)
    startTail(t, undefined, newSid)
  }

  // 최초 진입 시 미리 지정된 대상(세트에서 불러온 파일/파드, 또는 파일탐색기 경로)이 있으면 처리.
  // autoStart === false(힌트 세션 미연결로 폴백된 패널)면 자동 실행하지 않고 입력란만 채워 대기한다.
  useEffect(() => {
    if (initialTarget) {
      if (initialTarget.kind === 'k8s') {
        setSourceKind('k8s')
        if (autoStart === false) {
          setNamespace(initialTarget.namespace)
          setPodInput(initialTarget.pod)
          if (initialTarget.container) {
            setContainers([initialTarget.container])
            setContainer(initialTarget.container)
          }
          return
        }
      } else if (autoStart === false) {
        setPathInput(initialTarget.path)
        return
      }
      startTail(initialTarget)
    } else if (initialPath) {
      startTail({ kind: 'file', path: initialPath })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const deleteRecent = (path: string) => setRecent(removeRecent(path))
  const clearAllRecent = () => {
    try {
      localStorage.removeItem(RECENT_KEY)
    } catch {
      /* 무시 */
    }
    setRecent([])
  }

  const addPreset = () => {
    const label = newPresetLabel.trim()
    const path = newPresetPath.trim()
    if (!label || !path) return
    const next = [...presets, { label, path }]
    setPresets(next)
    savePresets(next)
    setNewPresetLabel('')
    setNewPresetPath('')
    setShowAddPreset(false)
  }
  const removePreset = (path: string) => {
    const next = presets.filter((p) => p.path !== path)
    setPresets(next)
    savePresets(next)
  }

  const backToEntry = () => {
    if (tailIdRef.current) window.electronAPI.logtailStop(targetSessionId, tailIdRef.current)
    tailIdRef.current = null
    setStage('entry')
  }

  const togglePause = () => {
    setPaused((v) => {
      const next = !v
      pausedRef.current = next
      if (!next && pausedQueueRef.current.length) {
        const queued = pausedQueueRef.current
        pausedQueueRef.current = []
        setPendingCount(0)
        setLines((prev) => {
          const merged = [...prev, ...queued]
          return merged.length > MAX_LINES ? merged.slice(merged.length - MAX_LINES) : merged
        })
      }
      return next
    })
  }

  const onScrollBody = () => {
    const el = bodyRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24
    if (!atBottom && autoScroll) setAutoScroll(false)
  }
  const jumpToBottom = () => {
    setAutoScroll(true)
    const el = bodyRef.current
    if (el) el.scrollTop = el.scrollHeight
  }

  const runAutocomplete = (value: string) => {
    if (acTimerRef.current) clearTimeout(acTimerRef.current)
    acTimerRef.current = setTimeout(async () => {
      const idx = value.lastIndexOf('/')
      if (idx < 0) {
        setAcOpen(false)
        return
      }
      const dir = value.slice(0, idx) || '/'
      if (acDirRef.current !== dir) {
        const r = await window.electronAPI.sftpList(targetSessionId, dir)
        if (!r.ok) {
          setAcEntries([])
          setAcOpen(false)
          return
        }
        acDirRef.current = dir
        setAcEntries((r.entries ?? []).map((e) => ({ name: e.name, type: e.type })))
      }
      setAcOpen(true)
    }, 250)
  }

  const acPrefix = (() => {
    const idx = pathInput.lastIndexOf('/')
    return idx < 0 ? pathInput : pathInput.slice(idx + 1)
  })()
  const acSuggestions = acEntries
    .filter((e) => e.name.toLowerCase().startsWith(acPrefix.toLowerCase()))
    .slice(0, 30)

  const applySuggestion = (e: { name: string; type: string }) => {
    const idx = pathInput.lastIndexOf('/')
    const dir = idx < 0 ? '' : pathInput.slice(0, idx)
    const next = (dir || '') + '/' + e.name + (e.type === 'dir' ? '/' : '')
    setPathInput(next)
    if (e.type === 'dir') {
      acDirRef.current = null
      runAutocomplete(next)
    } else {
      setAcOpen(false)
    }
  }

  // ── Kubernetes 탐색: 네임스페이스 → 파드 → 컨테이너 ──
  const loadNamespaces = async () => {
    setNsLoading(true)
    setNsError('')
    const r = await window.electronAPI.k8sListNamespaces(targetSessionId)
    setNsLoading(false)
    if (r.ok) setNamespaces(r.namespaces ?? [])
    else setNsError(r.error || '네임스페이스를 불러오지 못했습니다.')
  }
  useEffect(() => {
    if (sourceKind === 'k8s' && namespaces.length === 0 && !nsLoading && !nsError) loadNamespaces()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKind, targetSessionId])

  const loadPods = async (ns: string) => {
    setPodLoading(true)
    setPodError('')
    setPods([])
    setContainers([])
    setContainer('')
    const r = await window.electronAPI.k8sListPods(targetSessionId, ns)
    setPodLoading(false)
    if (r.ok) setPods(r.pods ?? [])
    else setPodError(r.error || '파드를 불러오지 못했습니다.')
  }
  const selectNamespace = (ns: string) => {
    setNamespace(ns)
    setPodInput('')
    if (ns) loadPods(ns)
  }

  const loadContainers = async (ns: string, pod: string) => {
    const r = await window.electronAPI.k8sListContainers(targetSessionId, ns, pod)
    if (r.ok) {
      const list = r.containers ?? []
      setContainers(list)
      setContainer(list.length === 1 ? list[0] : '')
    } else {
      setContainers([])
      setContainer('')
    }
  }
  const selectPod = (pod: string) => {
    setPodInput(pod)
    setPodAcOpen(false)
    if (namespace && pod) loadContainers(namespace, pod)
  }

  const podSuggestions = pods
    .filter((p) => p.toLowerCase().includes(podInput.toLowerCase()))
    .slice(0, 50)

  // ── 레벨/정규식 필터 (표시 단계에서만 적용, 버퍼는 그대로 유지) ──
  const rx = useMemo(() => {
    const s = regexFilter.trim()
    if (!s) return null
    try {
      return new RegExp(s, 'i')
    } catch {
      return null
    }
  }, [regexFilter])
  const filterActive = levelFilter.size < FILTER_CHIPS.length || !!rx || bookmarkOnly
  const displayLines = useMemo(() => {
    const indexed = lines.map((l, i) => [i, l] as [number, string])
    if (!filterActive) return indexed
    return indexed.filter(
      ([, l]) =>
        levelFilter.has(bucketCat(lineBucket(l))) &&
        (!rx || rx.test(l)) &&
        (!bookmarkOnly || bookmarks.has(l)),
    )
  }, [lines, levelFilter, rx, filterActive, bookmarkOnly, bookmarks])
  const hiddenCount = lines.length - displayLines.length
  const toggleCat = (c: FilterCat) =>
    setLevelFilter((s) => {
      const n = new Set(s)
      if (n.has(c)) n.delete(c)
      else n.add(c)
      return n
    })
  const onlyDangerWarn = () => setLevelFilter(new Set<FilterCat>(['danger', 'warn']))
  const allLevels = () => setLevelFilter(new Set<FilterCat>(['danger', 'warn', 'done', 'other']))

  const deleteK8sRecent = (e: K8sRecentEntry) => setK8sRecent(removeK8sRecent(e))
  const applyK8sRecent = (e: K8sRecentEntry) => {
    setNamespace(e.namespace)
    setPodInput(e.pod)
    setContainer(e.container ?? '')
    loadPods(e.namespace)
    if (e.container) setContainers([e.container])
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
      <div className="flex items-center gap-2 border-b border-white/10 bg-black/10 px-3 py-1.5">
        {paneTitle && <span className="shrink-0 text-[10px] font-semibold text-gray-500">{paneTitle}</span>}
        {otherSessions.length > 0 && stage === 'entry' && (
          <select
            value={targetSessionId}
            onChange={(e) => {
              // 대상 세션이 바뀌면 이전 세션 기준으로 조회했던 목록/캐시가 전부 무효가 된다
              // (다른 서버의 네임스페이스/파드/자동완성 후보가 섞여 보이지 않도록 초기화).
              setTargetSessionId(e.target.value)
              setNamespaces([])
              setNsError('')
              setNamespace('')
              setPods([])
              setPodInput('')
              setPodError('')
              setContainers([])
              setContainer('')
              acDirRef.current = null
              setAcEntries([])
              setAcOpen(false)
            }}
            className="rounded border border-white/10 bg-panel-light px-1.5 py-0.5 text-[11px] text-gray-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            <option value={sessionId}>{currentLabel || '이 세션'}</option>
            {otherSessions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        )}
        {stage === 'tail' && (
          <span className="flex min-w-0 items-center gap-1.5 text-[11px]">
            {otherSessions.length > 0 ? (
              <select
                value={targetSessionId}
                onChange={(e) => retargetSession(e.target.value)}
                title="이 로그를 볼 세션 변경 (같은 경로/파드를 다른 세션에서 다시 봄)"
                className="shrink-0 rounded border border-white/10 bg-panel-light px-1.5 py-0.5 text-[11px] text-gray-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
              >
                <option value={sessionId}>{currentLabel || '이 세션'}</option>
                {otherSessions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
            ) : (
              <span className="shrink-0 rounded bg-white/10 px-1.5 py-0.5 text-gray-300">
                {currentLabel || '이 세션'}
              </span>
            )}
            <span className="truncate font-mono text-gray-500">{tailLabel}</span>
          </span>
        )}
        {onRequestClose && (
          <button
            onClick={() => {
              if (tailIdRef.current) window.electronAPI.logtailStop(targetSessionId, tailIdRef.current)
              onRequestClose()
            }}
            title="이 패널 닫기"
            className="ml-auto rounded p-0.5 text-gray-500 hover:bg-white/10 hover:text-gray-200"
          >
            <X size={13} />
          </button>
        )}
      </div>

      {stage === 'entry' ? (
        <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-4">
          <div className="flex items-center gap-1 rounded-md bg-panel-light p-0.5 text-[11px]">
            <button
              onClick={() => setSourceKind('file')}
              className={
                'flex-1 rounded px-2 py-1 font-medium transition ' +
                (sourceKind === 'file' ? 'bg-blue-600/30 text-blue-100' : 'text-gray-400 hover:bg-white/5')
              }
            >
              파일 경로
            </button>
            <button
              onClick={() => setSourceKind('k8s')}
              className={
                'flex-1 rounded px-2 py-1 font-medium transition ' +
                (sourceKind === 'k8s' ? 'bg-blue-600/30 text-blue-100' : 'text-gray-400 hover:bg-white/5')
              }
            >
              Kubernetes 파드
            </button>
          </div>

          {sourceKind === 'file' ? (
            <>
              <div>
                <label className="mb-1 block text-[11px] text-gray-400">경로</label>
                <div className="relative flex gap-2">
                  <div className="relative flex-1">
                    <input
                      autoFocus
                      value={pathInput}
                      onChange={(e) => {
                        setPathInput(e.target.value)
                        runAutocomplete(e.target.value)
                      }}
                      onFocus={() => runAutocomplete(pathInput)}
                      onBlur={() => setTimeout(() => setAcOpen(false), 150)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') startFileTail()
                        if (e.key === 'Escape') setAcOpen(false)
                      }}
                      placeholder="/var/log/messages"
                      className="w-full rounded-md border border-white/10 bg-panel-light px-2.5 py-1.5 pr-8 font-mono text-[13px] text-gray-100 placeholder:text-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    />
                    <CornerDownLeft size={12} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-500" />
                    {acOpen && acSuggestions.length > 0 && (
                      <div className="absolute left-0 right-0 top-full z-10 mt-1 max-h-48 overflow-y-auto rounded-md border border-white/10 bg-panel-light shadow-xl">
                        {acSuggestions.map((s) => (
                          <div
                            key={s.name}
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => applySuggestion(s)}
                            className="cursor-pointer px-2.5 py-1 text-[12px] text-gray-200 hover:bg-white/10"
                          >
                            {s.name}
                            {s.type === 'dir' ? '/' : ''}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  <button
                    onClick={() => setShowPicker(true)}
                    title="트리에서 찾아보기"
                    className="flex shrink-0 items-center gap-1 rounded-md border border-white/10 bg-panel-light px-2.5 py-1.5 text-xs text-gray-200 hover:bg-white/10"
                  >
                    <FolderTree size={13} /> 찾아보기
                  </button>
                  <button
                    onClick={() => startFileTail()}
                    disabled={starting || !pathInput.trim()}
                    className="flex shrink-0 items-center gap-1 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-40"
                  >
                    {starting ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />} 보기
                  </button>
                </div>
                {startError && <p className="mt-1.5 text-[11px] text-red-400">{startError}</p>}
                {needSudo && (
                  <div className="mt-2 flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-2">
                    <span className="shrink-0 text-[11px] text-amber-200">root 권한 필요 — sudo 비밀번호</span>
                    <div className="relative flex-1">
                      <input
                        type={showSudoPw ? 'text' : 'password'}
                        autoFocus
                        value={sudoPw}
                        onChange={(e) => setSudoPw(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') startFileTail(sudoPw)
                        }}
                        className="w-full rounded border border-white/10 bg-panel px-2 py-1 pr-7 text-[12px] text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
                      />
                      <button
                        type="button"
                        tabIndex={-1}
                        onClick={() => setShowSudoPw((v) => !v)}
                        className="absolute right-1.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-200"
                      >
                        {showSudoPw ? <Eye size={13} /> : <EyeOff size={13} />}
                      </button>
                    </div>
                    <button
                      onClick={() => startFileTail(sudoPw)}
                      className="shrink-0 rounded bg-amber-500/80 px-2.5 py-1 text-[11px] font-medium text-black hover:bg-amber-400"
                    >
                      확인
                    </button>
                  </div>
                )}
              </div>

              <div>
                <div className="mb-1.5 flex items-center text-[11px] text-gray-500">
                  자주 쓰는 로그
                  <button
                    onClick={() => setShowAddPreset((v) => !v)}
                    className="ml-auto flex items-center gap-0.5 text-blue-400/80 hover:text-blue-300"
                  >
                    <Plus size={12} /> 추가
                  </button>
                </div>
                {showAddPreset && (
                  <div className="mb-2 flex items-center gap-1.5">
                    <input
                      autoFocus
                      value={newPresetLabel}
                      onChange={(e) => setNewPresetLabel(e.target.value)}
                      placeholder="이름 (예: was 에러로그)"
                      className="w-28 shrink-0 rounded-md border border-white/10 bg-panel-light px-2 py-1 text-[11px] text-gray-100 placeholder:text-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    />
                    <input
                      value={newPresetPath}
                      onChange={(e) => setNewPresetPath(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && addPreset()}
                      placeholder="/var/log/was/error.log"
                      className="min-w-0 flex-1 rounded-md border border-white/10 bg-panel-light px-2 py-1 font-mono text-[11px] text-gray-100 placeholder:text-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    />
                    <button
                      onClick={addPreset}
                      disabled={!newPresetLabel.trim() || !newPresetPath.trim()}
                      className="shrink-0 rounded-md bg-blue-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-blue-500 disabled:opacity-40"
                    >
                      확인
                    </button>
                  </div>
                )}
                <div className="flex flex-wrap gap-1.5">
                  {presets.map((p) => (
                    <span
                      key={p.path}
                      title={p.path}
                      className="group flex items-center gap-1 rounded-full border border-white/10 pl-2.5 pr-1 py-1 text-[11px] text-gray-300 hover:bg-white/5"
                    >
                      <button onClick={() => setPathInput(p.path)}>{p.label}</button>
                      <button
                        onClick={() => removePreset(p.path)}
                        title="이 프리셋 삭제"
                        className="rounded-full p-0.5 text-gray-500 opacity-0 hover:bg-white/10 hover:text-red-300 group-hover:opacity-100"
                      >
                        <X size={11} />
                      </button>
                    </span>
                  ))}
                  {presets.length === 0 && <span className="text-[11px] text-gray-600">없음 — "추가"로 등록하세요.</span>}
                </div>
              </div>

              {recent.length > 0 && (
                <div>
                  <div className="mb-1.5 flex items-center text-[11px] text-gray-500">
                    최근 사용한 경로
                    <button onClick={clearAllRecent} className="ml-auto text-gray-500 hover:text-red-300">
                      전체 삭제
                    </button>
                  </div>
                  <div className="flex flex-col gap-1">
                    {recent.map((p) => (
                      <div key={p} className="group flex items-center gap-1 rounded-md hover:bg-white/5">
                        <button
                          onClick={() => setPathInput(p)}
                          className="min-w-0 flex-1 truncate px-2 py-1 text-left font-mono text-[12px] text-gray-300"
                        >
                          {p}
                        </button>
                        <button
                          onClick={() => deleteRecent(p)}
                          title="이 경로 삭제"
                          className="mr-1 shrink-0 rounded p-0.5 text-gray-500 opacity-0 hover:bg-white/10 hover:text-red-300 group-hover:opacity-100"
                        >
                          <X size={12} />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <div className="mb-1 flex items-center text-[11px] text-gray-400">
                    네임스페이스
                    <button
                      onClick={loadNamespaces}
                      disabled={nsLoading}
                      title="새로고침"
                      className="ml-auto rounded p-0.5 text-gray-500 hover:bg-white/10 hover:text-gray-200 disabled:opacity-40"
                    >
                      {nsLoading ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
                    </button>
                  </div>
                  <select
                    value={namespace}
                    onChange={(e) => selectNamespace(e.target.value)}
                    disabled={nsLoading || namespaces.length === 0}
                    className="w-full rounded-md border border-white/10 bg-panel-light px-2 py-1.5 text-[12px] text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50"
                  >
                    <option value="">선택...</option>
                    {namespaces.map((ns) => (
                      <option key={ns} value={ns}>
                        {ns}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-[11px] text-gray-400">
                    컨테이너 {containers.length > 1 ? '' : '(단일이면 자동)'}
                  </label>
                  <select
                    value={container}
                    onChange={(e) => setContainer(e.target.value)}
                    disabled={containers.length <= 1}
                    className="w-full rounded-md border border-white/10 bg-panel-light px-2 py-1.5 text-[12px] text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50"
                  >
                    {containers.length === 0 && <option value="">-</option>}
                    {containers.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              {nsError && <p className="text-[11px] text-red-400">{nsError}</p>}

              <div>
                <label className="mb-1 block text-[11px] text-gray-400">파드</label>
                <div className="relative flex gap-2">
                  <div className="relative flex-1">
                    <input
                      value={podInput}
                      onChange={(e) => {
                        setPodInput(e.target.value)
                        setPodAcOpen(true)
                      }}
                      onFocus={() => setPodAcOpen(true)}
                      onBlur={() => setTimeout(() => setPodAcOpen(false), 150)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') startK8sTail()
                        if (e.key === 'Escape') setPodAcOpen(false)
                      }}
                      disabled={!namespace}
                      placeholder={namespace ? '파드 이름 검색...' : '먼저 네임스페이스를 선택하세요'}
                      className="w-full rounded-md border border-white/10 bg-panel-light px-2.5 py-1.5 font-mono text-[13px] text-gray-100 placeholder:text-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50"
                    />
                    {podLoading && (
                      <Loader2 size={13} className="absolute right-2.5 top-1/2 -translate-y-1/2 animate-spin text-gray-500" />
                    )}
                    {podAcOpen && podSuggestions.length > 0 && (
                      <div className="absolute left-0 right-0 top-full z-10 mt-1 max-h-48 overflow-y-auto rounded-md border border-white/10 bg-panel-light shadow-xl">
                        {podSuggestions.map((p) => (
                          <div
                            key={p}
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => selectPod(p)}
                            className="cursor-pointer px-2.5 py-1 text-[12px] text-gray-200 hover:bg-white/10"
                          >
                            {p}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  <button
                    onClick={startK8sTail}
                    disabled={starting || !namespace || !podInput.trim()}
                    className="flex shrink-0 items-center gap-1 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-40"
                  >
                    {starting ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />} 보기
                  </button>
                </div>
                {podError && <p className="mt-1.5 text-[11px] text-red-400">{podError}</p>}
                {startError && <p className="mt-1.5 text-[11px] text-red-400">{startError}</p>}
              </div>

              {k8sRecent.length > 0 && (
                <div>
                  <div className="mb-1.5 text-[11px] text-gray-500">최근 사용한 파드</div>
                  <div className="flex flex-col gap-1">
                    {k8sRecent.map((e) => (
                      <div key={k8sKey(e)} className="group flex items-center gap-1 rounded-md hover:bg-white/5">
                        <button
                          onClick={() => applyK8sRecent(e)}
                          className="flex min-w-0 flex-1 items-center gap-1.5 truncate px-2 py-1 text-left font-mono text-[12px] text-gray-300"
                        >
                          <Box size={11} className="shrink-0 text-gray-500" />
                          {k8sKey(e)}
                        </button>
                        <button
                          onClick={() => deleteK8sRecent(e)}
                          title="이 항목 삭제"
                          className="mr-1 shrink-0 rounded p-0.5 text-gray-500 opacity-0 hover:bg-white/10 hover:text-red-300 group-hover:opacity-100"
                        >
                          <X size={12} />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2 border-b border-white/10 px-3 py-1.5">
            <button
              onClick={togglePause}
              className={
                'flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium ' +
                (paused ? 'bg-amber-500/80 text-black' : 'bg-blue-600/80 text-white hover:bg-blue-500')
              }
            >
              {paused ? <Play size={12} /> : <Pause size={12} />}
              {paused ? `재개${pendingCount ? ` (${pendingCount})` : ''}` : '일시정지'}
            </button>
            <button
              onClick={backToEntry}
              className="rounded px-2 py-1 text-[11px] text-gray-400 hover:bg-white/10 hover:text-gray-200"
            >
              다른 경로
            </button>
            <div className="relative ml-2 flex-1">
              <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-500" />
              <input
                value={highlightQuery}
                onChange={(e) => setHighlightQuery(e.target.value)}
                placeholder="키워드 강조..."
                className="w-full rounded-md border border-white/10 bg-panel-light py-1 pl-7 pr-2 text-[11px] text-gray-200 outline-none placeholder:text-gray-600 focus:ring-1 focus:ring-blue-500"
              />
            </div>
            {!autoScroll && (
              <button
                onClick={jumpToBottom}
                className="flex shrink-0 items-center gap-1 rounded bg-panel-light px-2 py-1 text-[11px] text-gray-300 hover:bg-white/10"
              >
                <ArrowDownToLine size={12} /> 최신으로
              </button>
            )}
            <span className="shrink-0 text-[10px] text-gray-500">
              {filterActive ? `${displayLines.length}/${lines.length}줄` : `${lines.length}줄`}
            </span>
          </div>

          {/* 레벨/정규식 필터 */}
          <div className="flex flex-wrap items-center gap-1.5 border-b border-white/10 px-3 py-1.5">
            <span className="text-[10px] text-gray-500">레벨</span>
            {FILTER_CHIPS.map((c) => {
              const on = levelFilter.has(c.cat)
              return (
                <button
                  key={c.cat}
                  onClick={() => toggleCat(c.cat)}
                  className={
                    'rounded-full px-2 py-0.5 text-[10px] font-medium transition ' +
                    (on ? c.onCls : 'bg-panel-light text-gray-500 line-through hover:text-gray-300')
                  }
                >
                  {c.label}
                </button>
              )
            })}
            <button
              onClick={onlyDangerWarn}
              className="rounded px-1.5 py-0.5 text-[10px] text-gray-400 hover:bg-white/10 hover:text-gray-200"
            >
              위험·경고만
            </button>
            {levelFilter.size < FILTER_CHIPS.length && (
              <button
                onClick={allLevels}
                className="rounded px-1.5 py-0.5 text-[10px] text-gray-400 hover:bg-white/10 hover:text-gray-200"
              >
                전체
              </button>
            )}
            <div className="relative ml-auto w-56">
              <input
                value={regexFilter}
                onChange={(e) => setRegexFilter(e.target.value)}
                placeholder="정규식 필터 (예: proxysql|6032)"
                className={
                  'w-full rounded-md border bg-panel-light py-0.5 px-2 font-mono text-[10px] text-gray-200 outline-none placeholder:text-gray-600 focus:ring-1 ' +
                  (regexFilter.trim() && !rx ? 'border-red-500/50 focus:ring-red-500' : 'border-white/10 focus:ring-blue-500')
                }
              />
            </div>
            <button
              onClick={() => setBookmarkOnly((v) => !v)}
              disabled={bookmarks.size === 0 && !bookmarkOnly}
              title="북마크한 줄만 보기"
              className={
                'flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium disabled:opacity-40 ' +
                (bookmarkOnly ? 'bg-amber-500/25 text-amber-200' : 'text-gray-400 hover:bg-white/10')
              }
            >
              <Bookmark size={10} className={bookmarkOnly ? 'fill-current' : ''} />
              북마크 {bookmarks.size > 0 ? bookmarks.size : ''}
            </button>
            {hiddenCount > 0 && (
              <span className="shrink-0 text-[10px] text-gray-500">{hiddenCount}줄 숨김</span>
            )}
          </div>

          {closedNotice && <div className="bg-red-500/10 px-3 py-1 text-[11px] text-red-300">{closedNotice}</div>}
          <div
            ref={bodyRef}
            onScroll={onScrollBody}
            className="min-h-0 flex-1 overflow-auto bg-[#1e1e2e] p-2.5 font-mono text-[11px] leading-relaxed"
          >
            {lines.length === 0 ? (
              <p className="text-gray-500">데이터를 기다리는 중...</p>
            ) : displayLines.length === 0 ? (
              <p className="text-gray-500">필터에 맞는 줄이 없습니다. (레벨/정규식 필터를 조정하세요)</p>
            ) : (
              displayLines.map(([i, line]) => {
                const marked = bookmarks.has(line)
                return (
                  <div
                    key={i}
                    className={
                      'group flex items-start gap-1.5 whitespace-pre-wrap break-all text-gray-300 ' +
                      (marked ? 'bg-amber-500/10' : '')
                    }
                  >
                    <button
                      onClick={() => toggleBookmark(line)}
                      title={marked ? '북마크 해제' : '이 줄 북마크'}
                      className={
                        'mt-0.5 shrink-0 ' +
                        (marked
                          ? 'text-amber-400'
                          : 'text-gray-700 opacity-0 hover:text-gray-300 group-hover:opacity-100')
                      }
                    >
                      <Bookmark size={11} className={marked ? 'fill-current' : ''} />
                    </button>
                    <span className="min-w-0 flex-1">{renderLogLine(line, highlightQuery.trim())}</span>
                  </div>
                )
              })
            )}
          </div>
        </>
      )}

      {showPicker && (
        <RemotePathPicker
          sessionId={targetSessionId}
          initialPath="/var/log"
          onSelect={(p) => {
            setPathInput(p)
            setShowPicker(false)
          }}
          onClose={() => setShowPicker(false)}
        />
      )}
    </div>
  )
}

/**
 * 실시간 로그 뷰어 모달 — 기본 패널 1개, 필요하면 두 번째 패널을 열어 나란히 비교.
 * 각 패널은 독립적으로 세션/경로(또는 파드)를 고른다.
 */
export default function LiveLogViewer({ sessionId, initialPath, otherSessions = [], currentLabel, onClose }: LiveLogViewerProps) {
  const [showSecondPane, setShowSecondPane] = useState(false)
  const [sets, setSets] = useState<LogSet[]>(() => loadSets())
  // 각 패널이 tail 시작할 때 보고하는 "현재 대상/세션" — '세트로 저장'의 재료
  const [paneTargets, setPaneTargets] = useState<(LogTailTarget | null)[]>([null, null])
  const [paneSessions, setPaneSessions] = useState<(string | null)[]>([null, null])
  // 세트 불러오기로 주입할 초기 대상 + 강제 remount용 nonce
  const [loadedPanes, setLoadedPanes] = useState<
    { target: LogTailTarget; sessionId: string; autoStart: boolean }[] | null
  >(null)
  const [loadNonce, setLoadNonce] = useState(0)
  const [setNotice, setSetNotice] = useState('')
  const [showSaveInput, setShowSaveInput] = useState(false)
  const [newSetName, setNewSetName] = useState('')
  const [showSetMenu, setShowSetMenu] = useState(false)
  // 2분할 가운데 분할선 드래그 — 패널1의 너비 비율(%). localStorage 보존.
  const [splitPct, setSplitPct] = useState(() => {
    const v = Number(localStorage.getItem('livelog_split'))
    return v >= 20 && v <= 80 ? v : 50
  })
  const splitRef = useRef(splitPct)
  const draggingRef = useRef(false)
  const paneRowRef = useRef<HTMLDivElement>(null)

  // 세션 힌트(라벨) ↔ 세션 id 매핑 — 현재 세션 포함
  const sessionMap = [{ id: sessionId, label: currentLabel || '이 세션' }, ...otherSessions]
  const labelOf = (id: string) => sessionMap.find((s) => s.id === id)?.label
  const resolveHint = (hint?: string): { id: string; matched: boolean } => {
    if (!hint) return { id: sessionId, matched: true }
    const found = sessionMap.find((s) => s.label === hint)
    return found ? { id: found.id, matched: true } : { id: sessionId, matched: false }
  }

  const canSave = !!(paneTargets[0] || (showSecondPane && paneTargets[1]))

  const saveCurrentAsSet = (rawName: string) => {
    const name = rawName.trim()
    if (!name) return
    const panes: SavedPaneTarget[] = []
    const add = (t: LogTailTarget | null, sid: string | null) => {
      if (!t) return
      const sessionHint = sid ? labelOf(sid) : undefined
      panes.push(
        t.kind === 'file'
          ? { kind: 'file', path: t.path, sessionHint }
          : { kind: 'k8s', namespace: t.namespace, pod: t.pod, container: t.container, sessionHint },
      )
    }
    add(paneTargets[0], paneSessions[0])
    if (showSecondPane) add(paneTargets[1], paneSessions[1])
    if (!panes.length) return
    const next = [{ name, panes }, ...loadSets().filter((s) => s.name !== name)]
    saveSets(next)
    setSets(next)
    setNewSetName('')
    setShowSaveInput(false)
    setSetNotice(`'${name}' 세트를 저장했습니다.`)
  }

  const loadSet = (set: LogSet) => {
    const resolved = set.panes.map((p) => {
      const r = resolveHint(p.sessionHint)
      return { target: toTailTarget(p), sessionId: r.id, matched: r.matched, hint: p.sessionHint }
    })
    setShowSecondPane(resolved.length >= 2)
    // 힌트 세션이 매칭된 패널만 자동 실행. 미연결로 폴백된 패널은 경로만 채워 대기(오실행 방지).
    setLoadedPanes(
      resolved.map((r) => ({ target: r.target, sessionId: r.sessionId, autoStart: r.matched })),
    )
    setLoadNonce((n) => n + 1)
    const missed = resolved.filter((r) => r.hint && !r.matched).map((r) => r.hint)
    setSetNotice(
      missed.length
        ? `저장된 세션(${missed.join(', ')})이 연결돼 있지 않습니다. 해당 패널은 경로만 채워 두었으니, 패널 상단에서 세션을 고른 뒤 '보기'를 누르세요.`
        : '',
    )
  }

  const deleteSet = (name: string) => {
    const next = sets.filter((s) => s.name !== name)
    saveSets(next)
    setSets(next)
  }

  // 2분할 수동 토글 — 세트로 주입된 초기 대상을 지우고 패널을 새로 remount
  const toggleSecondPane = () => {
    setLoadedPanes(null)
    setSetNotice('')
    setLoadNonce((n) => n + 1)
    setShowSecondPane((v) => !v)
  }

  // 분할선 드래그 — 패널1 너비 비율 조절(20~80%), 마우스업에 저장
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!draggingRef.current) return
      const el = paneRowRef.current
      if (!el) return
      const r = el.getBoundingClientRect()
      const pct = ((e.clientX - r.left) / r.width) * 100
      const clamped = Math.max(20, Math.min(80, pct))
      splitRef.current = clamped
      setSplitPct(clamped)
    }
    const onUp = () => {
      if (!draggingRef.current) return
      draggingRef.current = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      localStorage.setItem('livelog_split', String(Math.round(splitRef.current)))
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [])
  const resetSplit = () => {
    splitRef.current = 50
    setSplitPct(50)
    localStorage.setItem('livelog_split', '50')
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-8">
      <div className="flex h-[88vh] w-[1840px] max-w-[98vw] flex-col overflow-hidden rounded-lg border border-white/10 bg-panel shadow-2xl">
        <div className="flex items-center gap-2 border-b border-white/10 px-4 py-2.5">
          <Activity size={16} className="text-emerald-400" />
          <span className="text-sm font-semibold text-gray-100">실시간 로그</span>
          <button
            onClick={toggleSecondPane}
            title={showSecondPane ? '두 번째 패널 닫기' : '패널을 하나 더 열어 나란히 비교'}
            className={
              'ml-2 flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] transition ' +
              (showSecondPane
                ? 'border-blue-500/50 bg-blue-600/20 text-blue-100'
                : 'border-white/10 bg-panel-light text-gray-300 hover:bg-white/10')
            }
          >
            <Columns2 size={12} /> 2분할
          </button>

          {/* 로그 세트 불러오기 — 드롭다운(세트가 많아도 한 줄로 안 늘어남) */}
          <div className="relative">
            <button
              onClick={() => setShowSetMenu((v) => !v)}
              title="저장된 로그 세트 불러오기"
              className={
                'flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] transition ' +
                (showSetMenu
                  ? 'border-blue-500/50 bg-blue-600/20 text-blue-100'
                  : 'border-white/10 bg-panel-light text-gray-300 hover:bg-white/10')
              }
            >
              <Bookmark size={12} className="text-blue-300" /> 세트 불러오기
              {sets.length > 0 && <span className="text-[9px] text-gray-500">({sets.length})</span>}
            </button>
            {showSetMenu && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setShowSetMenu(false)} />
                <div className="absolute left-0 top-full z-20 mt-1 max-h-80 w-80 overflow-y-auto rounded-md border border-white/10 bg-panel-light shadow-xl">
                  {sets.length === 0 ? (
                    <div className="px-3 py-3 text-center text-[11px] text-gray-500">
                      저장된 세트가 없습니다. 패널에서 로그를 실행한 뒤 '세트로 저장'을 누르세요.
                    </div>
                  ) : (
                    sets.map((s) => (
                      <div
                        key={s.name}
                        className="group flex items-center gap-2 border-b border-white/5 px-2.5 py-1.5 last:border-0 hover:bg-white/5"
                      >
                        <button
                          onClick={() => {
                            loadSet(s)
                            setShowSetMenu(false)
                          }}
                          className="flex min-w-0 flex-1 flex-col items-start gap-0.5 text-left"
                        >
                          <span className="flex items-center gap-1 text-[12px] font-medium text-gray-100">
                            {s.panes.some((p) => p.kind === 'k8s') ? <Box size={11} /> : <FileText size={11} />}
                            {s.name}
                            <span className="text-[9px] text-gray-500">×{s.panes.length}</span>
                          </span>
                          <span className="w-full truncate font-mono text-[10px] text-gray-500">
                            {s.panes.map(paneSummary).join('  |  ')}
                          </span>
                        </button>
                        <button
                          onClick={() => deleteSet(s.name)}
                          title="이 세트 삭제"
                          className="shrink-0 rounded p-1 text-gray-500 opacity-0 hover:bg-white/10 hover:text-red-300 group-hover:opacity-100"
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </>
            )}
          </div>

          <button
            onClick={() => setShowSaveInput((v) => !v)}
            disabled={!canSave}
            title={canSave ? '현재 패널 구성을 세트로 저장' : '먼저 패널에서 로그를 실행하세요'}
            className="flex items-center gap-1 rounded-md border border-white/10 bg-panel-light px-2 py-1 text-[11px] text-gray-300 hover:bg-white/10 disabled:opacity-40"
          >
            <Save size={12} /> 세트로 저장
          </button>
          <button onClick={onClose} className="ml-auto rounded p-1 text-gray-400 hover:bg-white/10 hover:text-gray-200">
            <X size={16} />
          </button>
        </div>

        {/* 세트 저장 입력 */}
        {showSaveInput && (
          <div className="flex items-center gap-1.5 border-b border-white/10 px-4 py-1.5">
            <Bookmark size={12} className="shrink-0 text-blue-300" />
            <span className="shrink-0 text-[10px] text-gray-500">세트 이름</span>
            <input
              autoFocus
              value={newSetName}
              onChange={(e) => setNewSetName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') saveCurrentAsSet(newSetName)
                if (e.key === 'Escape') setShowSaveInput(false)
              }}
              placeholder="예: proxysql + mysql 에러"
              className="w-64 rounded-md border border-white/10 bg-panel-light px-2 py-0.5 text-[11px] text-gray-100 outline-none placeholder:text-gray-600 focus:ring-1 focus:ring-blue-500"
            />
            <button
              onClick={() => saveCurrentAsSet(newSetName)}
              disabled={!newSetName.trim()}
              className="rounded-md bg-blue-600 px-2.5 py-0.5 text-[11px] font-medium text-white hover:bg-blue-500 disabled:opacity-40"
            >
              저장
            </button>
            <span className="text-[10px] text-gray-500">현재 2패널의 경로/파드 + 세션을 함께 저장합니다.</span>
          </div>
        )}
        {setNotice && <div className="bg-blue-500/10 px-4 py-1 text-[11px] text-blue-200">{setNotice}</div>}

        <div ref={paneRowRef} className="flex min-h-0 flex-1">
          <div
            className="flex min-h-0 min-w-0"
            style={showSecondPane ? { width: `${splitPct}%` } : { flex: 1 }}
          >
            <LogTailPane
              key={`p1-${loadNonce}`}
              sessionId={sessionId}
              otherSessions={otherSessions}
              currentLabel={currentLabel}
              initialPath={loadedPanes ? undefined : initialPath}
              initialTarget={loadedPanes?.[0]?.target}
              initialSessionId={loadedPanes?.[0]?.sessionId}
              autoStart={loadedPanes?.[0]?.autoStart}
              onActiveTarget={(t, sid) => {
                setPaneTargets((a) => [t, a[1]])
                setPaneSessions((a) => [sid, a[1]])
              }}
              paneTitle={showSecondPane ? '패널 1' : undefined}
            />
          </div>
          {showSecondPane && (
            <>
              <div
                onMouseDown={() => {
                  draggingRef.current = true
                  document.body.style.cursor = 'col-resize'
                  document.body.style.userSelect = 'none'
                }}
                onDoubleClick={resetSplit}
                title="드래그하여 패널 너비 조절 · 더블클릭: 5:5"
                className="w-1.5 shrink-0 cursor-col-resize bg-white/10 transition-colors hover:bg-blue-400/60"
              />
              <div className="flex min-h-0 min-w-0 flex-1">
                <LogTailPane
                  key={`p2-${loadNonce}`}
                  sessionId={sessionId}
                  otherSessions={otherSessions}
                  currentLabel={currentLabel}
                  initialTarget={loadedPanes?.[1]?.target}
                  initialSessionId={loadedPanes?.[1]?.sessionId}
                  autoStart={loadedPanes?.[1]?.autoStart}
                  onActiveTarget={(t, sid) => {
                    setPaneTargets((a) => [a[0], t])
                    setPaneSessions((a) => [a[0], sid])
                  }}
                  paneTitle="패널 2"
                  onRequestClose={toggleSecondPane}
                />
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
