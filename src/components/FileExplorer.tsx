import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import {
  HardDrive,
  Folder,
  FolderOpen,
  File as FileIcon,
  ChevronRight,
  ChevronDown,
  Download,
  Upload,
  RefreshCw,
  X,
  Loader2,
  ArrowUp,
  Home,
  CornerDownLeft,
  Pencil,
  Trash2,
  FolderPlus,
  SquarePen,
  Save,
  Eye,
  EyeOff,
  Lock,
  AlertCircle,
  CheckSquare,
  Square,
  PanelLeftClose,
  PanelLeftOpen,
  Laptop,
  Search,
  Activity,
} from 'lucide-react'

const BINARY_EXTENSIONS = new Set([
  'xlsx', 'xls', 'xlsm', 'docx', 'doc', 'pptx', 'ppt',
  'pdf', 'png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'ico', 'svg',
  'zip', 'tar', 'gz', 'bz2', 'xz', '7z', 'rar',
  'bin', 'exe', 'so', 'dylib', 'dll', 'pkg', 'deb', 'rpm',
  'mp3', 'mp4', 'mkv', 'avi', 'mov', 'wav',
  'ttf', 'otf', 'woff', 'woff2',
])

const isBinaryFile = (name: string) => {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  return BINARY_EXTENSIONS.has(ext)
}

interface FileExplorerProps {
  sessionId: string
  connected: boolean
  onClose: () => void
  /** 파일 행의 "실시간 보기" 아이콘 클릭 시 — 경로를 넘겨 실시간 로그 뷰어를 프리필로 연다 */
  onOpenLiveTail?: (path: string) => void
  /** 연결된 다른 세션 목록 — 좌측 패널을 "로컬" 대신 다른 세션의 원격 트리로 전환할 때 사용 */
  otherSessions?: { id: string; label: string }[]
}

interface Node {
  name: string
  path: string
  type: 'dir' | 'file' | 'link'
  expanded?: boolean
  loading?: boolean
  children?: Node[]
}

/** POSIX 경로 결합 */
const rjoin = (dir: string, name: string) => (dir.endsWith('/') ? dir + name : dir + '/' + name)

/** 트리에서 path 노드에 patch 적용 (불변) */
function patchNode(nodes: Node[], path: string, patch: Partial<Node>): Node[] {
  return nodes.map((n) => {
    if (n.path === path) return { ...n, ...patch }
    if (n.children) return { ...n, children: patchNode(n.children, path, patch) }
    return n
  })
}

/** 트리에서 path 로 노드 찾기 (다중선택 → 실제 배치 작업 대상 조회용) */
function findNode(nodes: Node[], path: string): Node | null {
  for (const n of nodes) {
    if (n.path === path) return n
    if (n.children) {
      const found = findNode(n.children, path)
      if (found) return found
    }
  }
  return null
}

// ── 권한(chmod) 다이얼로그용 메타 ──────────────────────────────
// 8진수에 익숙하지 않은 사용자를 위해 위치(소유자/그룹/기타) × 권한(읽기/쓰기/실행)을
// 체크박스로 고르게 한다. shift 는 8진수 자리(소유자=상위 3비트 …)에 대응.
const PERM_GROUPS = [
  { label: '소유자', sub: '파일 주인', shift: 6 },
  { label: '그룹', sub: '같은 그룹', shift: 3 },
  { label: '기타', sub: '그 외 모두', shift: 0 },
] as const
const PERM_BITS = [
  { label: '읽기', sub: '내용 보기 (r)', bit: 4 },
  { label: '쓰기', sub: '수정·삭제 (w)', bit: 2 },
  { label: '실행', sub: '실행·진입 (x)', bit: 1 },
] as const
const CHMOD_PRESETS = [
  { mode: 0o644, label: '644', desc: '일반 파일 — 주인만 수정, 나머지는 읽기만' },
  { mode: 0o755, label: '755', desc: '폴더·실행파일 — 주인은 전체, 나머지는 읽기·실행' },
  { mode: 0o600, label: '600', desc: '비밀 파일 — 주인만 읽기·쓰기 (키/비밀번호)' },
  { mode: 0o700, label: '700', desc: '개인 폴더 — 주인만 전체 접근' },
] as const
const bitChar = (bit: number) => (bit === 4 ? 'r' : bit === 2 ? 'w' : 'x')
/** 8진수 mode → 'rwxr-xr-x' 형태 기호 표기 */
const toSymbolic = (m: number) =>
  PERM_GROUPS.map((g) =>
    PERM_BITS.map((b) => (m & (b.bit << g.shift) ? bitChar(b.bit) : '-')).join(''),
  ).join('')

/**
 * 원격(SFTP) 파일 탐색기 모달.
 *  - 연결된 세션의 디렉토리를 계층 트리로 지연 로딩
 *  - 파일 더블클릭/버튼 → 다운로드, 폴더에 OS 파일 드롭/버튼 → 업로드
 */
export default function FileExplorer({
  sessionId,
  connected,
  onClose,
  onOpenLiveTail,
  otherSessions = [],
}: FileExplorerProps) {
  const [root, setRoot] = useState('')
  const [nodes, setNodes] = useState<Node[]>([])
  const [selectedDir, setSelectedDir] = useState('')
  const [pathInput, setPathInput] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  // 원격 디렉토리 재귀 파일명 검색 — null 이면 검색 모드 아님(평소 트리 표시), 배열이면 검색 결과 표시
  const [searchQuery, setSearchQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [searchResults, setSearchResults] = useState<
    { path: string; name: string; type: 'dir' | 'file' | 'link' }[] | null
  >(null)
  const [searchTruncated, setSearchTruncated] = useState(false)
  const [searchError, setSearchError] = useState('')
  // 검색 요청 토큰 — 응답이 온 시점에 더 이상 최신 요청이 아니면(그 사이 새 검색/다른 폴더 이동) 결과를 버림
  const searchTokenRef = useRef(0)
  const [dragOver, setDragOver] = useState<string | null>(null)
  // 이름 입력 다이얼로그(새 폴더/이름변경) + 삭제 확인
  const [prompt, setPrompt] = useState<{ title: string; ok: (v: string) => void } | null>(null)
  const [promptVal, setPromptVal] = useState('')
  const [confirmDel, setConfirmDel] = useState<Node | null>(null)
  // 권한 변경 다이얼로그 대상 노드 + 현재 편집 중인 8진수 mode
  const [chmodTarget, setChmodTarget] = useState<Node | null>(null)
  const [chmodMode, setChmodMode] = useState(0o644)
  const [editFile, setEditFile] = useState<{ path: string; name: string } | null>(null)
  const [binaryWarnFile, setBinaryWarnFile] = useState<{ path: string; name: string } | null>(null)
  const [progress, setProgress] = useState<{ name: string; pct: number } | null>(null)
  // 다중선택(체크박스) — 원격/로컬 각각 별도 집합. 배치 다운로드/업로드/삭제 대상.
  const [remoteSelected, setRemoteSelected] = useState<Set<string>>(new Set())
  const [localSelected, setLocalSelected] = useState<Set<string>>(new Set())
  // 로컬 패널(듀얼패인 좌측) — 파일 업로드 대상을 눈으로 보고 여러 개 골라 옮기기 위함.
  // leftMode==='session' 이면 로컬 대신 다른 연결된 세션의 원격 트리를 보여줘서 세션 간 직접 전송 가능.
  const [showLocalPane, setShowLocalPane] = useState(true)
  const [leftMode, setLeftMode] = useState<'local' | 'session'>('local')
  const [leftSessionId, setLeftSessionId] = useState<string | null>(null)
  // 이 창이 대상으로 하는 주 세션(sessionId) 자체가 바뀌면(활성 탭 전환 등) 좌측의 "다른 세션"
  // 선택은 더 이상 유효하지 않을 수 있으니 로컬로 되돌림 — 그대로 두면 자기자신 전송 등 혼란 방지
  useEffect(() => {
    setLeftMode('local')
    setLeftSessionId(null)
  }, [sessionId])
  const [localRoot, setLocalRoot] = useState('')
  const [localParent, setLocalParent] = useState('')
  const [localNodes, setLocalNodes] = useState<Node[]>([])
  const [localSelectedDir, setLocalSelectedDir] = useState('')
  const [localPathInput, setLocalPathInput] = useState('')
  const [localError, setLocalError] = useState('')
  const [confirmBatchDel, setConfirmBatchDel] = useState(false)
  // 좌측(로컬) 패널 너비 — 드래그로 조절
  const [localWidth, setLocalWidth] = useState(280)
  const localWidthRef = useRef(localWidth)
  const localDragRef = useRef(false)
  const bodyRef = useRef<HTMLDivElement>(null)

  // 전송 진행률 구독
  useEffect(() => {
    const off = window.electronAPI.onSftpProgress((d) => {
      if (d.sessionId !== sessionId) return
      setProgress(d.pct >= 100 ? null : { name: d.name, pct: d.pct })
    })
    return off
  }, [sessionId])

  const listDir = useCallback(
    async (path?: string) => {
      const r = await window.electronAPI.sftpList(sessionId, path)
      if (!r.ok) {
        setError(r.error || '목록을 불러오지 못했습니다.')
        return null
      }
      setError('')
      return r
    },
    [sessionId],
  )

  // 지정 경로를 새 루트로 열기 (path 없으면 홈)
  const openDir = useCallback(
    async (path?: string) => {
      const r = await listDir(path)
      if (!r) return
      setRoot(r.path!)
      setSelectedDir(r.path!)
      setPathInput(r.path!)
      setNodes(r.entries!.map((e) => ({ name: e.name, path: rjoin(r.path!, e.name), type: e.type })))
      // 위치가 바뀌면 이전 위치 기준 검색 결과/다중선택은 더 이상 유효하지 않으니 초기화.
      // 진행 중인 검색 요청도 무효화(토큰 증가) — 나중에 응답이 와도 이동한 뒤 화면을 덮어쓰지 않게.
      searchTokenRef.current++
      setSearchQuery('')
      setSearchResults(null)
      setSearchTruncated(false)
      setSearchError('')
      setRemoteSelected(new Set())
    },
    [listDir],
  )

  // 최초 로드 (홈 디렉토리)
  useEffect(() => {
    if (!connected) return
    openDir()
  }, [connected, openDir])

  // 상위 폴더 경로
  const parentOf = (p: string) => {
    if (p === '/' || !p) return '/'
    const up = p.replace(/\/+$/, '').replace(/\/[^/]*$/, '')
    return up || '/'
  }

  const toggle = async (node: Node) => {
    if (node.type === 'file') return
    if (node.expanded) {
      setNodes((prev) => patchNode(prev, node.path, { expanded: false }))
      return
    }
    setSelectedDir(node.path)
    setNodes((prev) => patchNode(prev, node.path, { loading: true }))
    const r = await listDir(node.path)
    const children = (r?.entries ?? []).map((e) => ({
      name: e.name,
      path: rjoin(node.path, e.name),
      type: e.type,
    }))
    setNodes((prev) => patchNode(prev, node.path, { expanded: true, loading: false, children }))
  }

  // 폴더 새로고침 (업로드 후)
  const refreshDir = async (dirPath: string) => {
    if (dirPath === root) {
      const r = await listDir(root)
      if (r) setNodes(r.entries!.map((e) => ({ name: e.name, path: rjoin(root, e.name), type: e.type })))
      return
    }
    const r = await listDir(dirPath)
    const children = (r?.entries ?? []).map((e) => ({
      name: e.name,
      path: rjoin(dirPath, e.name),
      type: e.type,
    }))
    setNodes((prev) => patchNode(prev, dirPath, { expanded: true, children }))
  }

  // ── 좌측 패널(듀얼패인) — 읽기 전용 탐색 + 다중선택, 업로드/전송 소스로만 사용.
  // leftMode==='local' 이면 local:list, 'session' 이면 다른 세션의 sftp:list 로 조회하되
  // 반환 형태(path/parent/entries)는 동일하게 맞춰서 이후 로직(toggle/refresh)은 공용으로 쓴다.
  const listLocalDir = useCallback(
    async (dirPath?: string) => {
      if (leftMode === 'session') {
        if (!leftSessionId) return null
        const r = await window.electronAPI.sftpList(leftSessionId, dirPath)
        if (!r.ok) {
          setLocalError(r.error || '목록을 불러오지 못했습니다.')
          return null
        }
        setLocalError('')
        const cwd = r.path!
        return {
          path: cwd,
          parent: parentOf(cwd),
          entries: (r.entries ?? []).map((e) => ({ name: e.name, path: rjoin(cwd, e.name), type: e.type })),
        }
      }
      const r = await window.electronAPI.localList(dirPath)
      if (!r.ok) {
        setLocalError(r.error || '목록을 불러오지 못했습니다.')
        return null
      }
      setLocalError('')
      return { path: r.path!, parent: r.parent!, entries: r.entries! }
    },
    [leftMode, leftSessionId],
  )

  const openLocalDir = useCallback(
    async (dirPath?: string) => {
      const r = await listLocalDir(dirPath)
      if (!r) return
      setLocalRoot(r.path!)
      setLocalParent(r.parent!)
      setLocalSelectedDir(r.path!)
      setLocalPathInput(r.path!)
      setLocalNodes(r.entries!.map((e) => ({ name: e.name, path: e.path, type: e.type })))
      setLocalSelected(new Set())
    },
    [listLocalDir],
  )

  // 최초 로드(로컬 홈 디렉토리) + leftMode/leftSessionId 전환 시 그 위치를 새로 염
  useEffect(() => {
    if (leftMode === 'session' && !leftSessionId) return
    openLocalDir()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leftMode, leftSessionId])

  const toggleLocal = async (node: Node) => {
    if (node.type === 'file') return
    if (node.expanded) {
      setLocalNodes((prev) => patchNode(prev, node.path, { expanded: false }))
      return
    }
    setLocalSelectedDir(node.path)
    setLocalNodes((prev) => patchNode(prev, node.path, { loading: true }))
    const r = await listLocalDir(node.path)
    const children = (r?.entries ?? []).map((e) => ({ name: e.name, path: e.path, type: e.type }))
    setLocalNodes((prev) => patchNode(prev, node.path, { expanded: true, loading: false, children }))
  }

  const refreshLocalDir = async (dirPath: string) => {
    if (dirPath === localRoot) {
      const r = await listLocalDir(localRoot)
      if (r) setLocalNodes(r.entries!.map((e) => ({ name: e.name, path: e.path, type: e.type })))
      return
    }
    const r = await listLocalDir(dirPath)
    const children = (r?.entries ?? []).map((e) => ({ name: e.name, path: e.path, type: e.type }))
    setLocalNodes((prev) => patchNode(prev, dirPath, { expanded: true, children }))
  }

  const toggleRemoteSelect = (p: string) =>
    setRemoteSelected((prev) => {
      const n = new Set(prev)
      n.has(p) ? n.delete(p) : n.add(p)
      return n
    })
  const toggleLocalSelect = (p: string) =>
    setLocalSelected((prev) => {
      const n = new Set(prev)
      n.has(p) ? n.delete(p) : n.add(p)
      return n
    })

  // 로컬에서 선택한 항목들을 현재 원격 선택 폴더로 업로드 (파일/폴더 모두 지원, 재귀)
  const batchUpload = async () => {
    if (!localSelected.size) return
    const dir = selectedDir || root
    if (leftMode === 'session' && leftSessionId) {
      if (leftSessionId === sessionId) return // 안전장치 — 자기 자신에게는 전송하지 않음
      // 세션 간(원격→원격) 직접 전송 — 앱이 임시 로컬 폴더를 경유해 중계
      const items = [...localSelected]
        .map((p) => findNode(localNodes, p))
        .filter((n): n is Node => !!n)
        .map((n) => ({ path: n.path, name: n.name, isDir: n.type !== 'file' }))
      if (!items.length) return
      setBusy(`전송 중... (${items.length}개)`)
      const r = await window.electronAPI.sftpRelayTransfer(leftSessionId, sessionId, items, dir)
      setBusy('')
      if (r.ok) {
        setLocalSelected(new Set())
        refreshDir(dir)
      } else if (r.error) setError(r.error)
      return
    }
    const paths = [...localSelected]
    setBusy(`업로드 중... (${paths.length}개)`)
    const r = await window.electronAPI.sftpUpload(sessionId, dir, paths)
    setBusy('')
    if (r.ok) {
      setLocalSelected(new Set())
      refreshDir(dir)
    } else if (!r.canceled) setError(r.error || '업로드 실패')
  }

  // 원격에서 선택한 항목들을 현재 로컬 선택 폴더로 다운로드 (대화상자 없이 바로)
  const batchDownload = async () => {
    if (!remoteSelected.size) return
    const items = [...remoteSelected]
      .map((p) => findNode(nodes, p))
      .filter((n): n is Node => !!n)
      .map((n) => ({ path: n.path, name: n.name, isDir: n.type !== 'file' }))
    if (!items.length) return
    const targetDir = localSelectedDir || localRoot
    setBusy(`다운로드 중... (${items.length}개)`)
    const r = await window.electronAPI.sftpDownloadPaths(sessionId, items, targetDir)
    setBusy('')
    if (r.ok) {
      setRemoteSelected(new Set())
      refreshLocalDir(targetDir)
    } else setError(r.error || '다운로드 실패')
  }

  // 원격에서 선택한 항목들을 한 번에 삭제
  const batchDelete = async () => {
    setConfirmBatchDel(false)
    const targets = [...remoteSelected]
      .map((p) => findNode(nodes, p))
      .filter((n): n is Node => !!n)
    if (!targets.length) return
    const items = targets.map((n) => ({ path: n.path, isDir: n.type !== 'file' }))
    setBusy(`삭제 중... (${items.length}개)`)
    const r = await window.electronAPI.sftpDeletePaths(sessionId, items)
    setBusy('')
    if (r.ok) {
      setRemoteSelected(new Set())
      const parents = new Set(targets.map((n) => parentOf(n.path)))
      for (const p of parents) refreshDir(p)
    } else setError(r.error || '삭제 실패')
  }

  const download = async (node: Node) => {
    setBusy(`다운로드: ${node.name}`)
    const r = await window.electronAPI.sftpDownload(sessionId, node.path, node.name)
    setBusy('')
    if (!r.ok && !r.canceled) setError(r.error || '다운로드 실패')
  }

  // 현재 열려있는 루트(root) 아래 전체를 재귀로 파일명 검색 — 트리 대신 결과 목록 표시로 전환
  const runSearch = async () => {
    const q = searchQuery.trim()
    if (!q) {
      setSearchResults(null)
      return
    }
    const token = ++searchTokenRef.current
    setSearching(true)
    setSearchError('')
    const r = await window.electronAPI.sftpSearch(sessionId, root, q)
    // 응답 오는 사이 새 검색을 시작했거나 다른 폴더로 이동했으면 이 결과는 이제 유효하지 않으니 버림
    if (searchTokenRef.current !== token) return
    setSearching(false)
    if (r.ok) {
      setSearchResults(r.results ?? [])
      setSearchTruncated(!!r.truncated)
    } else {
      setSearchError(r.error || '검색 실패')
      setSearchResults([])
    }
  }
  const clearSearch = () => {
    searchTokenRef.current++
    setSearchQuery('')
    setSearchResults(null)
    setSearchTruncated(false)
    setSearchError('')
  }
  // 검색 결과 클릭 — 폴더면 그 위치로 이동(검색 모드 종료), 파일이면 바로 다운로드
  const openSearchResult = (r: { path: string; name: string; type: 'dir' | 'file' | 'link' }) => {
    // 폴더면 그 위치로 이동(openDir 이 검색 모드도 함께 종료), 파일이면 바로 다운로드
    if (r.type === 'dir') openDir(r.path)
    else download({ path: r.path, name: r.name, type: r.type })
  }

  // 로컬 경로 배열을 원격 dir 로 업로드
  const uploadPaths = async (dirPath: string, paths: string[]) => {
    if (!paths.length) return
    setBusy(`업로드 중... (${paths.length}개)`)
    const r = await window.electronAPI.sftpUpload(sessionId, dirPath, paths)
    setBusy('')
    if (r.ok) refreshDir(dirPath)
    else if (!r.canceled) setError(r.error || '업로드 실패')
  }

  // 버튼 업로드 (대화상자) → 선택된 폴더로
  const uploadDialog = async () => {
    const dir = selectedDir || root
    setBusy('업로드 중...')
    const r = await window.electronAPI.sftpUpload(sessionId, dir)
    setBusy('')
    if (r.ok) refreshDir(dir)
    else if (!r.canceled) setError(r.error || '업로드 실패')
  }

  const openPrompt = (title: string, value: string, ok: (v: string) => void) => {
    setPromptVal(value)
    setPrompt({ title, ok })
  }

  const mkdirIn = (dir: string) =>
    openPrompt('새 폴더 이름', '', async (name) => {
      const nm = name.trim()
      if (!nm) return
      setBusy('폴더 생성 중...')
      const r = await window.electronAPI.sftpMkdir(sessionId, rjoin(dir, nm))
      setBusy('')
      if (r.ok) refreshDir(dir)
      else setError(r.error || '폴더 생성 실패')
    })

  const renameNode = (n: Node) =>
    openPrompt('이름 변경', n.name, async (name) => {
      const nm = name.trim()
      if (!nm || nm === n.name) return
      const parent = parentOf(n.path)
      setBusy('이름 변경 중...')
      const r = await window.electronAPI.sftpRename(sessionId, n.path, rjoin(parent, nm))
      setBusy('')
      if (r.ok) refreshDir(parent)
      else setError(r.error || '이름 변경 실패')
    })

  const removeNode = async (n: Node) => {
    setConfirmDel(null)
    setBusy(`삭제 중: ${n.name}`)
    const r = await window.electronAPI.sftpDelete(sessionId, n.path, n.type !== 'file')
    setBusy('')
    if (r.ok) refreshDir(parentOf(n.path))
    else setError(r.error || '삭제 실패')
  }

  // 권한 변경: 8진수 직접 입력 대신 체크박스 다이얼로그를 연다 (기본값: 폴더 755 / 파일 644)
  const chmodNode = (n: Node) => {
    setChmodMode(n.type === 'file' ? 0o644 : 0o755)
    setChmodTarget(n)
  }
  const applyChmod = async () => {
    const n = chmodTarget
    if (!n) return
    setChmodTarget(null)
    setBusy(`권한 변경: ${n.name}`)
    const r = await window.electronAPI.sftpChmod(sessionId, n.path, chmodMode)
    setBusy('')
    if (!r.ok) setError(r.error || '권한 변경 실패')
  }

  const downloadDir = async (n: Node) => {
    setBusy(`폴더 다운로드: ${n.name}`)
    const r = await window.electronAPI.sftpDownloadDir(sessionId, n.path, n.name)
    setBusy('')
    if (!r.ok && !r.canceled) setError(r.error || '폴더 다운로드 실패')
  }

  const onDropTo = async (e: React.DragEvent, dirPath: string) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(null)
    const paths = Array.from(e.dataTransfer.files)
      .map((f) => window.electronAPI.getPathForFile(f))
      .filter(Boolean)
    uploadPaths(dirPath, paths)
  }

  const allowDrop = (e: React.DragEvent, key: string) => {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    e.stopPropagation()
    if (dragOver !== key) setDragOver(key)
  }

  // 로컬 패널 너비 드래그 조절
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!localDragRef.current) return
      const el = bodyRef.current
      if (!el) return
      const r = el.getBoundingClientRect()
      const w = Math.max(180, Math.min(480, e.clientX - r.left))
      localWidthRef.current = w
      setLocalWidth(w)
    }
    const onUp = () => {
      localDragRef.current = false
      document.body.style.cursor = ''
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [])

  // 로컬 패널 트리 렌더 (재귀) — 읽기 전용 + 체크박스 다중선택만
  const renderLocalNodes = (list: Node[], depth: number) =>
    list.map((n) => {
      const isDir = n.type !== 'file'
      const checked = localSelected.has(n.path)
      return (
        <div key={n.path}>
          <div
            onClick={() => (isDir ? toggleLocal(n) : toggleLocalSelect(n.path))}
            style={{ paddingLeft: depth * 14 + 8 }}
            className={
              'group flex cursor-pointer items-center gap-1 py-1 pr-2 text-[13px] hover:bg-white/5 ' +
              (checked ? ' bg-blue-600/10' : '') +
              (localSelectedDir === n.path && isDir ? ' bg-white/5' : '')
            }
            title={n.path}
          >
            <button
              onClick={(e) => {
                e.stopPropagation()
                toggleLocalSelect(n.path)
              }}
              className="shrink-0 rounded p-0.5 text-gray-500 hover:text-gray-300"
            >
              {checked ? <CheckSquare size={12} className="text-blue-400" /> : <Square size={12} />}
            </button>
            {isDir ? (
              n.loading ? (
                <Loader2 size={13} className="shrink-0 animate-spin text-gray-400" />
              ) : n.expanded ? (
                <ChevronDown size={13} className="shrink-0 text-gray-400" />
              ) : (
                <ChevronRight size={13} className="shrink-0 text-gray-400" />
              )
            ) : (
              <span className="w-[13px] shrink-0" />
            )}
            {isDir ? (
              n.expanded ? (
                <FolderOpen size={14} className="shrink-0 text-amber-300/90" />
              ) : (
                <Folder size={14} className="shrink-0 text-amber-300/90" />
              )
            ) : (
              <FileIcon size={14} className="shrink-0 text-gray-400" />
            )}
            <span className="min-w-0 flex-1 truncate text-gray-100">{n.name}</span>
            {n.type === 'link' && <span className="text-[10px] text-gray-500">↪</span>}
          </div>
          {isDir && n.expanded && n.children && renderLocalNodes(n.children, depth + 1)}
        </div>
      )
    })

  // 트리 렌더 (재귀)
  const renderNodes = (list: Node[], depth: number) =>
    list.map((n) => {
      const isDir = n.type !== 'file'
      const over = dragOver === n.path
      const checked = remoteSelected.has(n.path)
      return (
        <div key={n.path}>
          <div
            draggable={!isDir}
            onDragStart={
              !isDir
                ? (e) => {
                    // OS로 드래그-아웃: 기본 동작 막고 메인에서 임시파일 받아 네이티브 드래그
                    e.preventDefault()
                    window.electronAPI.startFileDrag(sessionId, n.path, n.name)
                  }
                : undefined
            }
            onClick={() => (isDir ? toggle(n) : undefined)}
            onDoubleClick={() => (!isDir ? download(n) : undefined)}
            onDragOver={isDir ? (e) => allowDrop(e, n.path) : undefined}
            onDragLeave={isDir ? () => setDragOver((c) => (c === n.path ? null : c)) : undefined}
            onDrop={isDir ? (e) => onDropTo(e, n.path) : undefined}
            style={{ paddingLeft: depth * 14 + 8 }}
            className={
              'group flex cursor-pointer items-center gap-1 py-1 pr-2 text-[13px] hover:bg-white/5 ' +
              (over ? 'bg-blue-600/30 ring-1 ring-inset ring-blue-400' : '') +
              (checked ? ' bg-blue-600/10' : '') +
              (selectedDir === n.path && isDir ? ' bg-white/5' : '')
            }
            title={n.path}
          >
            <button
              onClick={(e) => {
                e.stopPropagation()
                toggleRemoteSelect(n.path)
              }}
              className="shrink-0 rounded p-0.5 text-gray-500 hover:text-gray-300"
            >
              {checked ? <CheckSquare size={12} className="text-blue-400" /> : <Square size={12} />}
            </button>
            {isDir ? (
              n.loading ? (
                <Loader2 size={13} className="shrink-0 animate-spin text-gray-400" />
              ) : n.expanded ? (
                <ChevronDown size={13} className="shrink-0 text-gray-400" />
              ) : (
                <ChevronRight size={13} className="shrink-0 text-gray-400" />
              )
            ) : (
              <span className="w-[13px] shrink-0" />
            )}
            {isDir ? (
              n.expanded ? (
                <FolderOpen size={14} className="shrink-0 text-amber-300/90" />
              ) : (
                <Folder size={14} className="shrink-0 text-amber-300/90" />
              )
            ) : (
              <FileIcon size={14} className="shrink-0 text-gray-400" />
            )}
            <span className="min-w-0 flex-1 truncate text-gray-100">{n.name}</span>
            {n.type === 'link' && <span className="text-[10px] text-gray-500">↪</span>}
            <div className="flex items-center gap-0.5 opacity-0 transition group-hover:opacity-100">
              {!isDir && (
                isBinaryFile(n.name) ? (
                  <button
                    onClick={(e) => { e.stopPropagation(); setBinaryWarnFile({ path: n.path, name: n.name }) }}
                    title="텍스트 편집 불가 — 클릭하여 안내 보기"
                    className="rounded p-0.5 text-gray-600 hover:bg-white/10 hover:text-amber-400"
                  >
                    <AlertCircle size={13} />
                  </button>
                ) : (
                  <button
                    onClick={(e) => { e.stopPropagation(); setEditFile({ path: n.path, name: n.name }) }}
                    title="편집"
                    className="rounded p-0.5 text-gray-500 hover:bg-white/10 hover:text-blue-300"
                  >
                    <SquarePen size={13} />
                  </button>
                )
              )}
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  isDir ? downloadDir(n) : download(n)
                }}
                title={isDir ? '폴더 통째 다운로드' : '다운로드'}
                className="rounded p-0.5 text-gray-500 hover:bg-white/10 hover:text-gray-200"
              >
                <Download size={13} />
              </button>
              {!isDir && onOpenLiveTail && (
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    onOpenLiveTail(n.path)
                  }}
                  title="실시간 보기 (tail -f)"
                  className="rounded p-0.5 text-gray-500 hover:bg-white/10 hover:text-emerald-300"
                >
                  <Activity size={13} />
                </button>
              )}
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  chmodNode(n)
                }}
                title="권한 변경 (chmod)"
                className="rounded p-0.5 text-gray-500 hover:bg-white/10 hover:text-gray-200"
              >
                <Lock size={12} />
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  renameNode(n)
                }}
                title="이름 변경"
                className="rounded p-0.5 text-gray-500 hover:bg-white/10 hover:text-gray-200"
              >
                <Pencil size={12} />
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  setConfirmDel(n)
                }}
                title="삭제"
                className="rounded p-0.5 text-gray-500 hover:bg-white/10 hover:text-red-300"
              >
                <Trash2 size={12} />
              </button>
            </div>
          </div>
          {isDir && n.expanded && n.children && renderNodes(n.children, depth + 1)}
        </div>
      )
    })

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-8" onClick={onClose}>
      <div
        className="relative flex h-[80vh] w-[1040px] max-w-[95vw] flex-col overflow-hidden rounded-lg border border-white/10 bg-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 헤더 */}
        <div className="flex items-center gap-2 border-b border-white/10 px-4 py-2.5">
          <HardDrive size={16} className="text-blue-400" />
          <span className="text-sm font-semibold text-gray-100">파일 탐색기</span>
          <span className="truncate font-mono text-[11px] text-gray-500">{root}</span>
          <div className="ml-auto flex items-center gap-1">
            <button
              onClick={() => setShowLocalPane((v) => !v)}
              title={showLocalPane ? '로컬 패널 숨기기' : '로컬 패널 보이기'}
              className="flex items-center gap-1 rounded-md border border-white/10 bg-panel-light px-2 py-1 text-xs text-gray-200 hover:bg-white/10"
            >
              {showLocalPane ? <PanelLeftClose size={13} /> : <PanelLeftOpen size={13} />} 로컬 패널
            </button>
            {remoteSelected.size > 0 && (
              <>
                <button
                  onClick={batchDownload}
                  disabled={!connected}
                  title="선택 항목을 로컬 패널의 현재 폴더로 다운로드"
                  className="flex items-center gap-1 rounded-md border border-emerald-500/30 bg-emerald-600/15 px-2 py-1 text-xs text-emerald-200 hover:bg-emerald-600/25 disabled:opacity-40"
                >
                  <Download size={13} /> 선택 다운로드 ({remoteSelected.size})
                </button>
                <button
                  onClick={() => setConfirmBatchDel(true)}
                  disabled={!connected}
                  title="선택 항목 일괄 삭제"
                  className="flex items-center gap-1 rounded-md border border-red-500/30 bg-red-600/15 px-2 py-1 text-xs text-red-200 hover:bg-red-600/25 disabled:opacity-40"
                >
                  <Trash2 size={13} /> 선택 삭제 ({remoteSelected.size})
                </button>
              </>
            )}
            <button
              onClick={() => mkdirIn(selectedDir || root)}
              disabled={!connected}
              title="선택한 폴더에 새 폴더 만들기"
              className="flex items-center gap-1 rounded-md border border-white/10 bg-panel-light px-2 py-1 text-xs text-gray-200 hover:bg-white/10 disabled:opacity-40"
            >
              <FolderPlus size={13} /> 새 폴더
            </button>
            <button
              onClick={uploadDialog}
              disabled={!connected}
              title="선택한 폴더에 업로드"
              className="flex items-center gap-1 rounded-md border border-white/10 bg-panel-light px-2 py-1 text-xs text-gray-200 hover:bg-white/10 disabled:opacity-40"
            >
              <Upload size={13} /> 업로드
            </button>
            <button
              onClick={() => refreshDir(root)}
              disabled={!connected}
              title="새로고침"
              className="rounded p-1 text-gray-400 hover:bg-white/10 hover:text-gray-200 disabled:opacity-40"
            >
              <RefreshCw size={15} />
            </button>
            <button
              onClick={onClose}
              className="rounded p-1 text-gray-400 hover:bg-white/10 hover:text-gray-200"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {error && <div className="bg-red-500/10 px-4 py-1 text-[11px] text-red-300">{error}</div>}
        {busy && (
          <div className="flex items-center gap-1.5 bg-blue-500/10 px-4 py-1 text-[11px] text-blue-200">
            <Loader2 size={12} className="animate-spin" /> {busy}
            {progress && (
              <span className="ml-1 flex flex-1 items-center gap-2">
                <span className="truncate font-mono text-blue-300/80">{progress.name}</span>
                <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/10">
                  <span
                    className="block h-full bg-blue-400 transition-all"
                    style={{ width: `${progress.pct}%` }}
                  />
                </span>
                <span className="tabular-nums">{progress.pct}%</span>
              </span>
            )}
          </div>
        )}

        {/* 본문 — 좌: 로컬 패널(선택) / 우: 원격 패널 */}
        <div ref={bodyRef} className="flex min-h-0 flex-1 overflow-hidden">
          {showLocalPane && (
            <>
              <div style={{ width: localWidth }} className="flex shrink-0 flex-col overflow-hidden border-r border-white/10">
                <div className="flex items-center gap-1.5 border-b border-white/10 px-2.5 py-1.5">
                  <Laptop size={13} className="shrink-0 text-gray-400" />
                  {otherSessions.length > 0 ? (
                    <select
                      value={leftMode === 'local' ? 'local' : leftSessionId ?? ''}
                      onChange={(e) => {
                        const v = e.target.value
                        if (v === 'local') {
                          setLeftMode('local')
                          setLeftSessionId(null)
                        } else {
                          setLeftMode('session')
                          setLeftSessionId(v)
                        }
                      }}
                      title="좌측 패널에서 볼 대상 — 로컬 또는 다른 연결된 세션"
                      className="rounded border border-white/10 bg-panel-light px-1 py-0.5 text-[11px] font-semibold text-gray-300 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    >
                      <option value="local">로컬</option>
                      {otherSessions.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.label}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className="text-[11px] font-semibold text-gray-300">로컬</span>
                  )}
                  {localSelected.size > 0 && (
                    <button
                      onClick={batchUpload}
                      disabled={!connected}
                      title={
                        leftMode === 'session'
                          ? '선택 항목을 이 세션의 현재 폴더로 직접 전송(임시 파일 경유)'
                          : '선택 항목을 원격 현재 폴더로 업로드'
                      }
                      className="ml-auto flex shrink-0 items-center gap-1 rounded-md border border-blue-500/30 bg-blue-600/20 px-1.5 py-0.5 text-[10px] text-blue-200 hover:bg-blue-600/30 disabled:opacity-40"
                    >
                      <Upload size={11} />
                      {leftMode === 'session' ? '선택 전송' : '선택 업로드'} ({localSelected.size})
                    </button>
                  )}
                </div>
                <div className="flex items-center gap-1 border-b border-white/10 px-2 py-1">
                  <button
                    onClick={() => openLocalDir(localParent)}
                    title="상위 폴더"
                    className="rounded p-1 text-gray-400 hover:bg-white/10 hover:text-gray-200"
                  >
                    <ArrowUp size={13} />
                  </button>
                  <button
                    onClick={() => openLocalDir()}
                    title="홈 디렉토리"
                    className="rounded p-1 text-gray-400 hover:bg-white/10 hover:text-gray-200"
                  >
                    <Home size={13} />
                  </button>
                  <button
                    onClick={() => refreshLocalDir(localRoot)}
                    title="새로고침"
                    className="rounded p-1 text-gray-400 hover:bg-white/10 hover:text-gray-200"
                  >
                    <RefreshCw size={13} />
                  </button>
                  <div className="relative flex-1">
                    <input
                      value={localPathInput}
                      onChange={(e) => setLocalPathInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') openLocalDir(localPathInput.trim())
                      }}
                      placeholder={leftMode === 'session' ? '원격 경로 입력...' : '로컬 경로 입력...'}
                      className="w-full rounded-md border border-white/10 bg-panel-light px-2 py-0.5 pr-6 font-mono text-[11px] text-gray-100 placeholder:text-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    />
                    <CornerDownLeft size={11} className="absolute right-1.5 top-1/2 -translate-y-1/2 text-gray-500" />
                  </div>
                </div>
                {localError && <div className="bg-red-500/10 px-2.5 py-1 text-[10px] text-red-300">{localError}</div>}
                <div className="min-h-0 flex-1 overflow-auto py-1">{renderLocalNodes(localNodes, 0)}</div>
                <div className="border-t border-white/10 px-2.5 py-1 text-[9px] text-gray-500">
                  {leftMode === 'session'
                    ? '체크박스로 다중선택 후 "선택 전송" (세션 간 직접 전송)'
                    : '체크박스로 다중선택 후 "선택 업로드"'}
                </div>
              </div>
              <div
                onMouseDown={() => {
                  localDragRef.current = true
                  document.body.style.cursor = 'col-resize'
                }}
                title="드래그하여 로컬 패널 너비 조절"
                className="w-1 shrink-0 cursor-col-resize bg-white/10 hover:bg-blue-400/50"
              />
            </>
          )}

          <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
            {/* 주소 표시줄 (경로 직접 입력 / 상위·홈·루트 이동) */}
            {connected && (
              <div className="flex items-center gap-1 border-b border-white/10 px-3 py-1.5">
                <button
                  onClick={() => openDir(parentOf(root))}
                  title="상위 폴더"
                  className="rounded p-1 text-gray-400 hover:bg-white/10 hover:text-gray-200"
                >
                  <ArrowUp size={14} />
                </button>
                <button
                  onClick={() => openDir()}
                  title="홈 디렉토리"
                  className="rounded p-1 text-gray-400 hover:bg-white/10 hover:text-gray-200"
                >
                  <Home size={14} />
                </button>
                <button
                  onClick={() => openDir('/')}
                  title="루트(/)"
                  className="rounded px-1.5 py-1 font-mono text-xs text-gray-400 hover:bg-white/10 hover:text-gray-200"
                >
                  /
                </button>
                <div className="relative flex-1">
                  <input
                    value={pathInput}
                    onChange={(e) => setPathInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') openDir(pathInput.trim() || '/')
                    }}
                    placeholder="경로 입력 후 Enter (예: /etc, /var/log)"
                    className="w-full rounded-md border border-white/10 bg-panel-light px-2.5 py-1 pr-7 font-mono text-xs text-gray-100 placeholder:text-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                  <CornerDownLeft size={12} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500" />
                </div>
              </div>
            )}

            {/* 파일명 재귀 검색 — 현재 위치(root) 아래 전체를 대상으로, 결과는 트리 대신 플랫 목록으로 표시 */}
            {connected && (
              <div className="flex items-center gap-1.5 border-b border-white/10 px-3 py-1.5">
                <Search size={12} className="shrink-0 text-gray-500" />
                <input
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') runSearch()
                    if (e.key === 'Escape') clearSearch()
                  }}
                  placeholder={`"${root}" 아래 전체에서 파일명 검색...`}
                  className="min-w-0 flex-1 bg-transparent text-xs text-gray-200 outline-none placeholder:text-gray-600"
                />
                {searching && <Loader2 size={12} className="shrink-0 animate-spin text-gray-400" />}
                {searchResults !== null && (
                  <>
                    <span className="shrink-0 text-[11px] text-gray-500">{searchResults.length}개</span>
                    <button
                      onClick={clearSearch}
                      title="검색 종료"
                      className="shrink-0 rounded p-0.5 text-gray-500 hover:bg-white/10 hover:text-gray-200"
                    >
                      <X size={13} />
                    </button>
                  </>
                )}
              </div>
            )}

            {!connected ? (
              <div className="flex flex-1 items-center justify-center text-sm text-gray-500">
                세션에 SSH 연결 후 사용할 수 있습니다.
              </div>
            ) : searchResults !== null ? (
              <div className="min-h-0 flex-1 overflow-auto py-1">
                {searchError ? (
                  <p className="px-3 py-6 text-center text-xs text-red-400">{searchError}</p>
                ) : searchResults.length === 0 ? (
                  <p className="px-3 py-6 text-center text-xs text-gray-500">일치하는 항목이 없습니다.</p>
                ) : (
                  <>
                    {searchTruncated && (
                      <div className="bg-amber-500/10 px-3 py-1 text-[10px] text-amber-300">
                        결과가 많아 일부만 표시합니다 — 검색어를 더 구체적으로 입력해보세요.
                      </div>
                    )}
                    {searchResults.map((r) => (
                      <div
                        key={r.path}
                        onClick={() => openSearchResult(r)}
                        title={r.path}
                        className="flex cursor-pointer items-center gap-1.5 px-3 py-1 text-[13px] hover:bg-white/5"
                      >
                        {r.type === 'dir' ? (
                          <Folder size={14} className="shrink-0 text-amber-300/90" />
                        ) : (
                          <FileIcon size={14} className="shrink-0 text-gray-400" />
                        )}
                        <span className="min-w-0 flex-1 truncate text-gray-100">{r.name}</span>
                        <span className="min-w-0 max-w-[45%] shrink truncate text-[10px] text-gray-500">
                          {r.path}
                        </span>
                      </div>
                    ))}
                  </>
                )}
              </div>
            ) : (
              <div
                className={
                  'min-h-0 flex-1 overflow-auto py-1 ' +
                  (dragOver === root ? 'bg-blue-600/10 ring-1 ring-inset ring-blue-400/50' : '')
                }
                onDragOver={(e) => allowDrop(e, root)}
                onDragLeave={() => setDragOver((c) => (c === root ? null : c))}
                onDrop={(e) => onDropTo(e, root)}
              >
                {renderNodes(nodes, 0)}
              </div>
            )}

            <div className="border-t border-white/10 px-4 py-1.5 text-[10px] text-gray-500">
              체크박스=다중선택 · 폴더 클릭=펼치기 · 파일 더블클릭/드래그=다운로드 · OS→폴더 드롭=업로드
            </div>
          </div>
        </div>

        {/* 바이너리 파일 편집 불가 안내 모달 */}
        {binaryWarnFile && (
          <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 p-6">
            <div className="w-80 rounded-xl border border-amber-500/30 bg-[#1e1e2e] shadow-2xl">
              <div className="flex items-center gap-2 border-b border-white/10 px-4 py-3">
                <AlertCircle size={15} className="shrink-0 text-amber-400" />
                <span className="text-[13px] font-semibold text-gray-100">텍스트 편집 불가</span>
                <button onClick={() => setBinaryWarnFile(null)} className="ml-auto text-gray-500 hover:text-gray-300">
                  <X size={15} />
                </button>
              </div>
              <div className="px-4 py-4 text-[12px] leading-relaxed text-gray-300">
                <span className="font-mono text-amber-300">{binaryWarnFile.name}</span> 파일은
                바이너리 형식이라 텍스트 편집기로 열 수 없습니다.
                <br /><br />
                파일을 다운로드한 뒤 로컬에서 수정하고 다시 업로드하세요.
              </div>
              <div className="flex justify-end gap-2 border-t border-white/10 px-4 py-3">
                <button
                  onClick={() => setBinaryWarnFile(null)}
                  className="rounded-md px-3 py-1.5 text-[12px] text-gray-400 hover:bg-white/10"
                >
                  닫기
                </button>
                <button
                  onClick={() => { download({ path: binaryWarnFile.path, name: binaryWarnFile.name, type: 'file' }); setBinaryWarnFile(null) }}
                  className="flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-[12px] font-medium text-white hover:bg-blue-500"
                >
                  <Download size={12} /> 다운로드
                </button>
              </div>
            </div>
          </div>
        )}

        {/* 원격 파일 편집 모달 */}
        {editFile && (
          <FileEditModal
            sessionId={sessionId}
            path={editFile.path}
            name={editFile.name}
            onClose={() => setEditFile(null)}
          />
        )}

        {/* 이름 입력 다이얼로그 (새 폴더 / 이름 변경) */}
        {prompt && (
          <div
            className="absolute inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
            onClick={() => setPrompt(null)}
          >
            <div
              className="w-full max-w-xs rounded-lg border border-white/10 bg-panel p-4 shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="mb-2 text-sm font-semibold text-gray-100">{prompt.title}</div>
              <input
                autoFocus
                value={promptVal}
                onChange={(e) => setPromptVal(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    prompt.ok(promptVal)
                    setPrompt(null)
                  } else if (e.key === 'Escape') setPrompt(null)
                }}
                className="w-full rounded-md border border-white/10 bg-panel-light px-2.5 py-1.5 text-sm text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
              <div className="mt-3 flex justify-end gap-2">
                <button
                  onClick={() => setPrompt(null)}
                  className="rounded-md border border-white/10 bg-panel-light px-3 py-1.5 text-xs text-gray-200 hover:bg-white/10"
                >
                  취소
                </button>
                <button
                  onClick={() => {
                    prompt.ok(promptVal)
                    setPrompt(null)
                  }}
                  className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500"
                >
                  확인
                </button>
              </div>
            </div>
          </div>
        )}

        {/* 삭제 확인 */}
        {confirmDel && (
          <div
            className="absolute inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
            onClick={() => setConfirmDel(null)}
          >
            <div
              className="w-full max-w-sm rounded-lg border border-white/10 bg-panel p-4 shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="mb-2 text-sm font-semibold text-gray-100">삭제 확인</div>
              <p className="text-[13px] leading-relaxed text-gray-200">
                <span className="font-mono text-gray-100">{confirmDel.name}</span>
                {confirmDel.type !== 'file' ? ' 폴더와 그 안의 모든 항목' : ''} 을(를) 삭제할까요?
              </p>
              <div className="mt-3 flex justify-end gap-2">
                <button
                  onClick={() => setConfirmDel(null)}
                  className="rounded-md border border-white/10 bg-panel-light px-3 py-1.5 text-xs text-gray-200 hover:bg-white/10"
                >
                  취소
                </button>
                <button
                  onClick={() => removeNode(confirmDel)}
                  className="rounded-md bg-red-600/80 px-3 py-1.5 text-xs text-white hover:bg-red-500"
                >
                  삭제
                </button>
              </div>
            </div>
          </div>
        )}

        {/* 다중선택 일괄 삭제 확인 */}
        {confirmBatchDel && (
          <div
            className="absolute inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
            onClick={() => setConfirmBatchDel(false)}
          >
            <div
              className="w-full max-w-sm rounded-lg border border-white/10 bg-panel p-4 shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="mb-2 text-sm font-semibold text-gray-100">일괄 삭제 확인</div>
              <p className="text-[13px] leading-relaxed text-gray-200">
                선택한 <span className="font-mono text-gray-100">{remoteSelected.size}개</span> 항목(폴더는 안의
                모든 내용 포함)을 삭제할까요?
              </p>
              <div className="mt-3 flex justify-end gap-2">
                <button
                  onClick={() => setConfirmBatchDel(false)}
                  className="rounded-md border border-white/10 bg-panel-light px-3 py-1.5 text-xs text-gray-200 hover:bg-white/10"
                >
                  취소
                </button>
                <button
                  onClick={batchDelete}
                  className="rounded-md bg-red-600/80 px-3 py-1.5 text-xs text-white hover:bg-red-500"
                >
                  삭제
                </button>
              </div>
            </div>
          </div>
        )}

        {/* 권한 변경 다이얼로그 (체크박스 + 안내 + 예시) */}
        {chmodTarget && (
          <div
            className="absolute inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
            onClick={() => setChmodTarget(null)}
          >
            <div
              className="w-full max-w-sm rounded-lg border border-white/10 bg-panel p-4 shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="mb-1 flex items-center gap-1.5 text-sm font-semibold text-gray-100">
                <Lock size={14} /> 권한 변경
              </div>
              <div className="mb-3 truncate font-mono text-[12px] text-gray-400">
                {chmodTarget.name}
              </div>

              {/* 안내 문구 */}
              <p className="mb-3 rounded-md bg-panel-light px-2.5 py-2 text-[11px] leading-relaxed text-gray-400">
                허용할 권한만 체크하세요. <b className="text-gray-200">읽기</b>=내용 보기,{' '}
                <b className="text-gray-200">쓰기</b>=수정·삭제,{' '}
                <b className="text-gray-200">실행</b>=프로그램 실행(폴더는 안으로 들어가기).
                <br />
                <b className="text-gray-200">소유자</b>=파일 주인, <b className="text-gray-200">그룹</b>=같은 그룹원,{' '}
                <b className="text-gray-200">기타</b>=그 외 모든 사용자.
              </p>

              {/* 위치 × 권한 체크박스 */}
              <div className="grid grid-cols-[auto_repeat(3,1fr)] items-center gap-x-2 gap-y-2">
                <div />
                {PERM_BITS.map((b) => (
                  <div key={b.label} className="text-center text-[11px] text-gray-300">
                    {b.label}
                    <div className="text-[9px] text-gray-500">{b.sub}</div>
                  </div>
                ))}
                {PERM_GROUPS.map((g) => (
                  <Fragment key={g.label}>
                    <div className="text-xs text-gray-300">
                      {g.label}
                      <span className="ml-1 text-[10px] text-gray-500">{g.sub}</span>
                    </div>
                    {PERM_BITS.map((b) => {
                      const v = b.bit << g.shift
                      const on = (chmodMode & v) !== 0
                      return (
                        <label key={b.label} className="flex justify-center">
                          <input
                            type="checkbox"
                            checked={on}
                            onChange={() => setChmodMode((m) => (on ? m & ~v : m | v))}
                            className="h-4 w-4 accent-blue-500"
                          />
                        </label>
                      )
                    })}
                  </Fragment>
                ))}
              </div>

              {/* 결과 미리보기 */}
              <div className="mt-3 flex items-center gap-2 text-xs">
                <span className="text-gray-500">결과</span>
                <span className="font-mono text-gray-100">
                  {chmodMode.toString(8).padStart(3, '0')}
                </span>
                <span className="font-mono text-gray-400">({toSymbolic(chmodMode)})</span>
              </div>

              {/* 자주 쓰는 예시 */}
              <div className="mt-3">
                <div className="mb-1 text-[11px] text-gray-500">자주 쓰는 예시 (눌러서 적용)</div>
                <div className="flex flex-col gap-1">
                  {CHMOD_PRESETS.map((p) => (
                    <button
                      key={p.mode}
                      onClick={() => setChmodMode(p.mode)}
                      className={
                        'flex items-start gap-2 rounded-md border px-2 py-1 text-left text-[11px] ' +
                        (chmodMode === p.mode
                          ? 'border-blue-500/60 bg-blue-600/15'
                          : 'border-white/10 hover:bg-white/5')
                      }
                    >
                      <span className="shrink-0 font-mono text-gray-100">{p.label}</span>
                      <span className="text-gray-400">{p.desc}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="mt-4 flex justify-end gap-2">
                <button
                  onClick={() => setChmodTarget(null)}
                  className="rounded-md border border-white/10 bg-panel-light px-3 py-1.5 text-xs text-gray-200 hover:bg-white/10"
                >
                  취소
                </button>
                <button
                  onClick={applyChmod}
                  className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500"
                >
                  적용
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ── 원격 파일 편집 모달 (sudo 처리 포함, 설정뷰어와 동일 IPC 사용) ──
function FileEditModal({
  sessionId,
  path,
  name,
  onClose,
}: {
  sessionId: string
  path: string
  name: string
  onClose: () => void
}) {
  const [content, setContent] = useState('')
  const [original, setOriginal] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [needSudo, setNeedSudo] = useState(false)
  const [sudoPw, setSudoPw] = useState('')
  const [showPw, setShowPw] = useState(false)
  const [applyNotice, setApplyNotice] = useState<{ command: string; desc: string } | null>(null)

  const APPLY_REQUIRED: { pattern: RegExp; command: string; desc: string }[] = [
    { pattern: /\/etc\/netplan\//,      command: 'sudo netplan apply',                        desc: '저장만으로는 적용되지 않습니다. 터미널에서 netplan apply를 실행해야 네트워크 설정이 반영됩니다.' },
    { pattern: /\/etc\/sysctl\.conf$/,  command: 'sudo sysctl -p',                            desc: '저장만으로는 적용되지 않습니다. 터미널에서 sysctl -p를 실행해야 커널 파라미터가 반영됩니다.' },
    { pattern: /\/etc\/fstab$/,         command: 'sudo mount -a',                             desc: '저장만으로는 적용되지 않습니다. 터미널에서 mount -a를 실행하거나 재부팅해야 마운트 설정이 반영됩니다.' },
    { pattern: /\/etc\/resolv\.conf$/,  command: 'sudo systemctl restart systemd-resolved',   desc: '저장만으로는 적용되지 않습니다. 터미널에서 systemd-resolved를 재시작해야 DNS 설정이 반영됩니다.' },
  ]

  const load = useCallback(
    async (pw?: string) => {
      setLoading(true)
      setError('')
      const r = await window.electronAPI.sftpRead(sessionId, path, pw)
      setLoading(false)
      if (r.ok) {
        setContent(r.content ?? '')
        setOriginal(r.content ?? '')
        setNeedSudo(false)
      } else if (r.needSudoPassword) {
        setNeedSudo(true)
      } else {
        setError(r.error || '읽기 실패')
      }
    },
    [sessionId, path],
  )

  useEffect(() => {
    load()
  }, [load])

  const save = async () => {
    setSaving(true)
    setError('')
    const r = await window.electronAPI.sftpWrite(sessionId, path, content, sudoPw || undefined)
    setSaving(false)
    if (r.ok) {
      setOriginal(content)
      const match = APPLY_REQUIRED.find(a => a.pattern.test(path))
      if (match) {
        setApplyNotice({ command: match.command, desc: match.desc })
      } else {
        onClose()
      }
    } else if (r.needSudoPassword) {
      setNeedSudo(true)
    } else {
      setError(r.error || '저장 실패')
    }
  }

  const dirty = content !== original

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 p-6" onClick={onClose}>
      <div
        className="flex h-[70vh] w-[560px] max-w-full flex-col overflow-hidden rounded-lg border border-white/10 bg-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-white/10 px-4 py-2.5">
          <SquarePen size={15} className="text-blue-400" />
          <span className="truncate text-sm font-semibold text-gray-100">{name}</span>
          <span className="truncate font-mono text-[10px] text-gray-500">{path}</span>
          <button
            onClick={save}
            disabled={saving || loading || !dirty}
            className="ml-auto flex items-center gap-1 rounded-md bg-blue-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-40"
          >
            <Save size={13} /> 저장
          </button>
          <button onClick={onClose} className="rounded p-1 text-gray-400 hover:bg-white/10 hover:text-gray-200">
            <X size={16} />
          </button>
        </div>

        {applyNotice && (
          <div className="flex flex-col gap-2 border-b border-amber-500/20 bg-amber-500/10 px-4 py-3">
            <div className="flex items-start gap-2">
              <AlertCircle size={15} className="mt-0.5 shrink-0 text-amber-400" />
              <div className="min-w-0 flex-1">
                <p className="text-[12px] font-medium text-amber-200">저장 완료 — 추가 적용 명령이 필요합니다</p>
                <p className="mt-0.5 text-[11px] text-amber-300/80">{applyNotice.desc}</p>
                <code className="mt-1.5 block rounded bg-black/40 px-2 py-1 font-mono text-[11px] text-amber-100">{applyNotice.command}</code>
              </div>
            </div>
            <button
              onClick={onClose}
              className="self-end rounded-md bg-amber-500/20 px-3 py-1 text-[11px] font-medium text-amber-200 hover:bg-amber-500/30"
            >
              확인 후 닫기
            </button>
          </div>
        )}
        {error && <div className="bg-red-500/10 px-4 py-1 text-[11px] text-red-300">{error}</div>}

        {needSudo ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
            <div className="text-sm text-gray-300">root 권한이 필요합니다. sudo 비밀번호를 입력하세요.</div>
            <div className="relative w-64">
              <input
                type={showPw ? 'text' : 'password'}
                autoFocus
                value={sudoPw}
                onChange={(e) => setSudoPw(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') load(sudoPw)
                }}
                placeholder="sudo password"
                className="w-full rounded-md border border-white/10 bg-panel-light px-2.5 py-1.5 pr-9 text-sm text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
              <button
                type="button"
                tabIndex={-1}
                onClick={() => setShowPw((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-200"
              >
                {showPw ? <Eye size={15} /> : <EyeOff size={15} />}
              </button>
            </div>
            <button
              onClick={() => load(sudoPw)}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-xs text-white hover:bg-blue-500"
            >
              확인
            </button>
          </div>
        ) : loading ? (
          <div className="flex flex-1 items-center justify-center text-sm text-gray-500">불러오는 중...</div>
        ) : (
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            spellCheck={false}
            className="min-h-0 flex-1 resize-none bg-[#1e1e2e] p-3 font-mono text-xs text-gray-100 focus:outline-none"
          />
        )}

        <div className="border-t border-white/10 px-4 py-1.5 text-[10px] text-gray-500">
          저장 시 자동 백업 후 기록 · root 파일은 sudo 자동 처리 {dirty ? '· ● 수정됨' : ''}
        </div>
      </div>
    </div>
  )
}
