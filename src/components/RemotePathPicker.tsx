import { useCallback, useEffect, useState } from 'react'
import { HardDrive, Folder, FolderOpen, File as FileIcon, ChevronRight, ChevronDown, Loader2, X } from 'lucide-react'

interface RemotePathPickerProps {
  sessionId: string
  /** 최초로 펼쳐서 보여줄 경로 (없거나 접근 실패 시 기본 홈 디렉토리로 폴백) */
  initialPath?: string
  /** 파일을 선택하면 그 경로를 돌려주고 자동으로 닫힘 */
  onSelect: (path: string) => void
  onClose: () => void
}

interface PickerNode {
  name: string
  path: string
  type: 'dir' | 'file' | 'link'
  expanded?: boolean
  loading?: boolean
  children?: PickerNode[]
}

const rjoin = (dir: string, name: string) => (dir.endsWith('/') ? dir + name : dir + '/' + name)

function patchNode(nodes: PickerNode[], path: string, patch: Partial<PickerNode>): PickerNode[] {
  return nodes.map((n) => {
    if (n.path === path) return { ...n, ...patch }
    if (n.children) return { ...n, children: patchNode(n.children, path, patch) }
    return n
  })
}

/**
 * 실시간 로그 뷰어의 "찾아보기" 버튼용 — 경로를 몰라도 트리를 눈으로 보면서 파일을 골라 선택.
 * 원격 파일 탐색기(FileExplorer)의 편집/다운로드 등 부가기능 없이, 오직 "파일 하나 고르기"만 한다.
 */
export default function RemotePathPicker({ sessionId, initialPath, onSelect, onClose }: RemotePathPickerProps) {
  const [root, setRoot] = useState('')
  const [nodes, setNodes] = useState<PickerNode[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

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

  useEffect(() => {
    setLoading(true)
    // 기본으로 /var/log 를 펼쳐서 보여주되, 접근 권한이 없는 등 실패하면 홈 디렉토리로 폴백
    ;(initialPath ? listDir(initialPath) : Promise.resolve(null))
      .then((r) => r ?? listDir())
      .then((r) => {
        if (r) {
          setRoot(r.path!)
          setNodes(r.entries!.map((e) => ({ name: e.name, path: rjoin(r.path!, e.name), type: e.type })))
        }
        setLoading(false)
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const toggle = async (node: PickerNode) => {
    if (node.type === 'file') {
      onSelect(node.path)
      return
    }
    if (node.expanded) {
      setNodes((prev) => patchNode(prev, node.path, { expanded: false }))
      return
    }
    setNodes((prev) => patchNode(prev, node.path, { loading: true }))
    const r = await listDir(node.path)
    const children = (r?.entries ?? []).map((e) => ({ name: e.name, path: rjoin(node.path, e.name), type: e.type }))
    setNodes((prev) => patchNode(prev, node.path, { expanded: true, loading: false, children }))
  }

  const renderNodes = (list: PickerNode[], depth: number) =>
    list.map((n) => {
      const isDir = n.type !== 'file'
      return (
        <div key={n.path}>
          <div
            onClick={() => toggle(n)}
            style={{ paddingLeft: depth * 14 + 8 }}
            className="flex cursor-pointer items-center gap-1 py-1 pr-2 text-[13px] hover:bg-white/5"
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
          </div>
          {isDir && n.expanded && n.children && renderNodes(n.children, depth + 1)}
        </div>
      )
    })

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 p-6" onClick={onClose}>
      <div
        className="flex h-[70vh] w-[480px] max-w-[92vw] flex-col overflow-hidden rounded-lg border border-white/10 bg-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-white/10 px-4 py-2.5">
          <HardDrive size={15} className="text-blue-400" />
          <span className="text-sm font-semibold text-gray-100">파일 선택</span>
          <span className="truncate font-mono text-[11px] text-gray-500">{root}</span>
          <button onClick={onClose} className="ml-auto rounded p-1 text-gray-400 hover:bg-white/10 hover:text-gray-200">
            <X size={16} />
          </button>
        </div>
        {error && <div className="bg-red-500/10 px-4 py-1 text-[11px] text-red-300">{error}</div>}
        <div className="min-h-0 flex-1 overflow-auto py-1">
          {loading ? (
            <div className="flex h-full items-center justify-center text-sm text-gray-500">불러오는 중...</div>
          ) : (
            renderNodes(nodes, 0)
          )}
        </div>
        <div className="border-t border-white/10 px-4 py-1.5 text-[10px] text-gray-500">
          폴더 클릭=펼치기 · 파일 클릭=선택
        </div>
      </div>
    </div>
  )
}
