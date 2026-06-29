import { Fragment, useCallback, useEffect, useState } from 'react'
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
} from 'lucide-react'

interface FileExplorerProps {
  sessionId: string
  connected: boolean
  onClose: () => void
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
export default function FileExplorer({ sessionId, connected, onClose }: FileExplorerProps) {
  const [root, setRoot] = useState('')
  const [nodes, setNodes] = useState<Node[]>([])
  const [selectedDir, setSelectedDir] = useState('')
  const [pathInput, setPathInput] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [dragOver, setDragOver] = useState<string | null>(null)
  // 이름 입력 다이얼로그(새 폴더/이름변경) + 삭제 확인
  const [prompt, setPrompt] = useState<{ title: string; ok: (v: string) => void } | null>(null)
  const [promptVal, setPromptVal] = useState('')
  const [confirmDel, setConfirmDel] = useState<Node | null>(null)
  // 권한 변경 다이얼로그 대상 노드 + 현재 편집 중인 8진수 mode
  const [chmodTarget, setChmodTarget] = useState<Node | null>(null)
  const [chmodMode, setChmodMode] = useState(0o644)
  const [editFile, setEditFile] = useState<{ path: string; name: string } | null>(null)
  const [progress, setProgress] = useState<{ name: string; pct: number } | null>(null)

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

  const download = async (node: Node) => {
    setBusy(`다운로드: ${node.name}`)
    const r = await window.electronAPI.sftpDownload(sessionId, node.path, node.name)
    setBusy('')
    if (!r.ok && !r.canceled) setError(r.error || '다운로드 실패')
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

  // 트리 렌더 (재귀)
  const renderNodes = (list: Node[], depth: number) =>
    list.map((n) => {
      const isDir = n.type !== 'file'
      const over = dragOver === n.path
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
              (selectedDir === n.path && isDir ? ' bg-white/5' : '')
            }
            title={n.path}
          >
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
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    setEditFile({ path: n.path, name: n.name })
                  }}
                  title="편집"
                  className="rounded p-0.5 text-gray-500 hover:bg-white/10 hover:text-blue-300"
                >
                  <SquarePen size={13} />
                </button>
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
        className="relative flex h-[80vh] w-[640px] max-w-[92vw] flex-col overflow-hidden rounded-lg border border-white/10 bg-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 헤더 */}
        <div className="flex items-center gap-2 border-b border-white/10 px-4 py-2.5">
          <HardDrive size={16} className="text-blue-400" />
          <span className="text-sm font-semibold text-gray-100">원격 파일 탐색기</span>
          <span className="truncate font-mono text-[11px] text-gray-500">{root}</span>
          <div className="ml-auto flex items-center gap-1">
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

        {/* 본문 */}
        {!connected ? (
          <div className="flex flex-1 items-center justify-center text-sm text-gray-500">
            세션에 SSH 연결 후 사용할 수 있습니다.
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
          폴더 클릭=펼치기 · 파일 더블클릭/드래그=다운로드 · OS→폴더 드롭=업로드 · 상단 경로 입력으로 이동
        </div>

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
      onClose()
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
