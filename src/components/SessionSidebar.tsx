import { useEffect, useRef, useState } from 'react'
import {
  ServerCog,
  Plus,
  Pencil,
  Trash2,
  X,
  Eye,
  EyeOff,
  PanelLeftClose,
  Folder,
  FolderOpen,
  ChevronRight,
  ChevronDown,
  FileKey,
  Search,
  CheckSquare,
  Square,
  LayoutGrid,
  Upload,
} from 'lucide-react'
import type { SavedProfile, JumpProfile } from '../../electron/shared-types'

/** 같은 서버 식별 키 (메인의 profileKey와 동일 규칙) */
export const profileKey = (p: SavedProfile) => `${p.host}:${p.port}:${p.username}`

type AuthMethod = 'password' | 'key' | 'agent'

interface SessionSidebarProps {
  profiles: SavedProfile[]
  /** 현재 어느 세션엔가 연결되어 있는 프로필 키 집합 (● 표시용) */
  connectedKeys: Set<string>
  /** 더블클릭 → 연결 */
  onConnect: (p: SavedProfile) => void
  /** 등록/편집 저장. originalKey 지정 시 키가 바뀌면 기존 항목 삭제 후 갱신 */
  onSave: (p: SavedProfile, originalKey?: string) => void
  /** 삭제 */
  onDelete: (p: SavedProfile) => void
  /** 여러 세션 일괄 삭제 (선택 삭제 / 폴더 전체 삭제) */
  onDeleteMany: (list: SavedProfile[]) => void
  /** 폴더 이동 (사이드바 내 드래그) — group 미지정 시 분류 없음으로 */
  onMove: (p: SavedProfile, group: string | undefined) => void
  /** 폴더명 일괄 변경 */
  onRenameFolder: (from: string, to: string) => void
  /** 사이드바 드래그 재정렬 — 새 전체 순서(그룹 포함) 반영 */
  onReorder: (list: SavedProfile[]) => void
  /** 선택한 여러 세션을 한 번에 그리드+동시입력으로 열기 */
  onOpenMulti: (list: SavedProfile[]) => void
  /** CSV/JSON 파일에서 세션 프로필 일괄 가져오기 (사이드바에 추가만, 연결은 수동) */
  onImport: () => void
  /** 사이드바 접기 */
  onCollapse: () => void
  /** 항목을 터미널로 드래그 시작 (App 이 드롭 오버레이 표시) */
  onDragProfileStart: (p: SavedProfile) => void
  /** 드래그 종료 (드롭 여부와 무관) */
  onDragProfileEnd: () => void
}

const empty = (group?: string): SavedProfile => ({
  host: '',
  port: '22',
  username: 'root',
  authMethod: 'password',
  password: '',
  privateKey: '',
  passphrase: '',
  label: '',
  group: group ?? '',
})

const emptyJump = (): JumpProfile => ({
  host: '',
  port: '22',
  username: 'root',
  authMethod: 'password',
  password: '',
  privateKey: '',
  passphrase: '',
})

/**
 * 좌측 세션 사이드바 (MobaXterm 스타일).
 *  - 저장된 SSH 세션을 폴더 트리로 표시 + 더블클릭/드래그로 연결
 *  - ➕ 로 새 세션 등록(폴더 지정 가능), hover 시 편집/삭제
 *  - 접속 정보는 메인 프로세스에서 safeStorage 로 암호화 저장
 */
export default function SessionSidebar({
  profiles,
  connectedKeys,
  onConnect,
  onSave,
  onDelete,
  onDeleteMany,
  onMove,
  onRenameFolder,
  onReorder,
  onOpenMulti,
  onImport,
  onCollapse,
  onDragProfileStart,
  onDragProfileEnd,
}: SessionSidebarProps) {
  // 등록/편집 모달 상태 (null = 닫힘)
  const [editor, setEditor] = useState<{ draft: SavedProfile; originalKey?: string } | null>(null)
  const [confirmDel, setConfirmDel] = useState<SavedProfile | null>(null)
  // 선택 항목 일괄 삭제 확인 (null = 닫힘). 폴더 전체 삭제도 '그 폴더를 전체 선택한 상태'로 이 경로를 탄다.
  const [confirmDelMany, setConfirmDelMany] = useState<SavedProfile[] | null>(null)
  // 접힌 폴더 이름 집합
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  // 사이드바 내 드래그 종류 (세션 / 폴더)
  const [dragKind, setDragKind] = useState<'session' | 'folder' | null>(null)
  // 세션 항목 위에 드래그가 올라간 대상 키 (삽입 표시)
  const [overItem, setOverItem] = useState<string | null>(null)
  // 드래그가 올라간 드롭 대상 폴더 ('' = 분류 없음 루트)
  const ROOT = 'root'
  const [overFolder, setOverFolder] = useState<string | null>(null)
  // 세션 검색어
  const [query, setQuery] = useState('')
  // 폴더명 인라인 편집 (대상 폴더명 / 입력값)
  const [editingFolder, setEditingFolder] = useState<string | null>(null)
  const [folderEdit, setFolderEdit] = useState('')
  // 다중 선택(클러스터 열기용) 프로필 키 집합
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const toggleSelect = (key: string) =>
    setSelected((s) => {
      const n = new Set(s)
      if (n.has(key)) n.delete(key)
      else n.add(key)
      return n
    })

  // 드롭 시 dataTransfer 의 키로 프로필을 찾아 폴더 이동
  const handleFolderDrop = (e: React.DragEvent, group: string | undefined) => {
    e.preventDefault()
    const key = e.dataTransfer.getData('text/plain')
    setOverFolder(null)
    setDragKind(null)
    if (key.startsWith('folder:')) {
      if (group) reorderFolderBefore(key.slice(7), group) // 폴더→폴더헤더: 폴더 순서 변경
      return
    }
    const p = profiles.find((x) => profileKey(x) === key)
    if (p && (p.group?.trim() || undefined) !== (group || undefined)) onMove(p, group)
  }

  const openAdd = (group?: string) => setEditor({ draft: empty(group) })
  const openEdit = (p: SavedProfile) => setEditor({ draft: { ...p }, originalKey: profileKey(p) })

  const startFolderRename = (name: string) => {
    setEditingFolder(name)
    setFolderEdit(name)
  }
  const commitFolderRename = () => {
    if (editingFolder && folderEdit.trim() && folderEdit.trim() !== editingFolder) {
      onRenameFolder(editingFolder, folderEdit.trim())
    }
    setEditingFolder(null)
  }

  const groupOf = (p: SavedProfile) => p.group?.trim() ?? ''

  // 세션을 다른 세션 앞으로 이동 (+대상 세션의 폴더로 합류)
  const reorderSessionBefore = (fromKey: string, beforeKey: string) => {
    if (fromKey === beforeKey) return
    const arr = profiles.slice()
    const fromIdx = arr.findIndex((p) => profileKey(p) === fromKey)
    const target = arr.find((p) => profileKey(p) === beforeKey)
    if (fromIdx < 0 || !target) return
    const moved = { ...arr.splice(fromIdx, 1)[0], group: target.group }
    const beforeIdx = arr.findIndex((p) => profileKey(p) === beforeKey)
    arr.splice(beforeIdx, 0, moved)
    onReorder(arr)
  }

  // 폴더 블록을 다른 폴더 앞으로 이동
  const reorderFolderBefore = (fromName: string, beforeName: string) => {
    if (fromName === beforeName) return
    const block = profiles.filter((p) => groupOf(p) === fromName)
    const rest = profiles.filter((p) => groupOf(p) !== fromName)
    const beforeIdx = rest.findIndex((p) => groupOf(p) === beforeName)
    if (beforeIdx < 0) onReorder([...rest, ...block])
    else onReorder([...rest.slice(0, beforeIdx), ...block, ...rest.slice(beforeIdx)])
  }

  const toggleFolder = (name: string) =>
    setCollapsed((s) => {
      const n = new Set(s)
      if (n.has(name)) n.delete(name)
      else n.add(name)
      return n
    })

  // 검색 필터
  const q = query.trim().toLowerCase()
  const match = (p: SavedProfile) =>
    !q ||
    (p.label ?? '').toLowerCase().includes(q) ||
    p.host.toLowerCase().includes(q) ||
    p.username.toLowerCase().includes(q) ||
    (p.group ?? '').toLowerCase().includes(q)
  const visible = profiles.filter(match)
  // 목록에서 사라진 프로필의 키가 selected 에 남아 있으면 개수가 부풀고, 나중에 같은
  // host:port:username 으로 새로 만든 프로필이 저절로 체크된 채 일괄 삭제에 휩쓸릴 수 있다.
  useEffect(() => {
    const live = new Set(profiles.map(profileKey))
    setSelected((s) => {
      if ([...s].every((k) => live.has(k))) return s
      return new Set([...s].filter((k) => live.has(k)))
    })
  }, [profiles])
  // 선택돼 있지만 지금 검색 결과에는 안 보이는 항목 수 — 삭제/열기 전에 사용자에게 알려준다.
  const hiddenSelectedCount = selected.size - visible.filter((p) => selected.has(profileKey(p))).length

  // 폴더별 그룹화 + 폴더 없는(루트) 세션 분리
  const folders = new Map<string, SavedProfile[]>()
  const ungrouped: SavedProfile[] = []
  for (const p of visible) {
    const g = p.group?.trim()
    if (g) {
      if (!folders.has(g)) folders.set(g, [])
      folders.get(g)!.push(p)
    } else {
      ungrouped.push(p)
    }
  }
  // 폴더 순서 = 저장 배열의 첫 등장 순서 (드래그로 재정렬 가능)
  const folderNames = [...folders.keys()]
  const existingFolders = [...new Set(profiles.map((p) => p.group?.trim()).filter(Boolean) as string[])]

  const authLabel = (p: SavedProfile) =>
    p.authMethod === 'key' ? '개인키' : p.authMethod === 'agent' ? '에이전트' : '비밀번호'

  // 단일 세션 항목 렌더 (카드형)
  const renderItem = (p: SavedProfile) => {
    const connected = connectedKeys.has(profileKey(p))
    return (
      <li
        key={profileKey(p)}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = 'copyMove'
          e.dataTransfer.setData('text/plain', profileKey(p))
          setDragKind('session')
          onDragProfileStart(p)
        }}
        onDragEnd={() => {
          setDragKind(null)
          setOverFolder(null)
          setOverItem(null)
          onDragProfileEnd()
        }}
        onDragOver={(e) => {
          if (dragKind !== 'session') return
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
          if (overItem !== profileKey(p)) setOverItem(profileKey(p))
        }}
        onDragLeave={() => setOverItem((c) => (c === profileKey(p) ? null : c))}
        onDrop={(e) => {
          e.preventDefault()
          e.stopPropagation()
          const from = e.dataTransfer.getData('text/plain')
          setOverItem(null)
          setDragKind(null)
          if (from && !from.startsWith('folder:')) reorderSessionBefore(from, profileKey(p))
        }}
        onDoubleClick={() => onConnect(p)}
        title="더블클릭/터미널로 드래그=연결 · 다른 항목 위로 드래그=순서 변경"
        className={
          'group relative mx-2 my-px flex cursor-grab items-center gap-2.5 rounded-lg py-1.5 pl-2.5 pr-1.5 transition hover:bg-white/[0.055] active:cursor-grabbing ' +
          (overItem === profileKey(p) ? 'shadow-[inset_0_2px_0_0_rgb(96,165,250)]' : '')
        }
      >
        {/* 연결 시 좌측 에메랄드 액센트 바 */}
        {connected && (
          <span className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-emerald-400/80" />
        )}
        {/* 다중 선택 체크박스 */}
        <button
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation()
            toggleSelect(profileKey(p))
          }}
          title="클러스터 열기용 선택"
          className={
            'shrink-0 ' +
            (selected.has(profileKey(p)) || selected.size > 0
              ? 'text-blue-400'
              : 'text-gray-600 opacity-0 group-hover:opacity-100')
          }
        >
          {selected.has(profileKey(p)) ? <CheckSquare size={13} /> : <Square size={13} />}
        </button>
        {/* 상태 점 (연결 시 글로우) */}
        <span
          className={
            'h-2 w-2 shrink-0 rounded-full ' +
            (connected
              ? 'bg-emerald-400 shadow-[0_0_6px_1px_rgba(52,211,153,0.55)]'
              : 'bg-gray-600 ring-1 ring-inset ring-white/10')
          }
        />
        <div className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-gray-200 group-hover:text-white">
            {p.label?.trim() || p.host}
          </span>
          <span className="block truncate font-mono text-[10px] text-gray-500">
            {p.username}@{p.host}:{p.port} · {authLabel(p)}
            {p.jump?.host ? ' · ↪점프' : ''}
          </span>
        </div>
        <div className="flex shrink-0 items-center opacity-0 transition group-hover:opacity-100">
          <button
            onClick={(e) => {
              e.stopPropagation()
              openEdit(p)
            }}
            title="편집"
            className="rounded-md p-1 text-gray-500 hover:bg-white/10 hover:text-gray-200"
          >
            <Pencil size={12} />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation()
              setConfirmDel(p)
            }}
            title="삭제"
            className="rounded-md p-1 text-gray-500 hover:bg-white/10 hover:text-red-300"
          >
            <Trash2 size={12} />
          </button>
        </div>
      </li>
    )
  }

  return (
    <div className="flex h-full w-64 shrink-0 flex-col border-r border-white/10 bg-panel-light">
      {/* 헤더 */}
      <div className="border-b border-white/10 px-3 py-2.5">
        <div className="flex items-center gap-2">
          <div className="flex h-6 w-6 items-center justify-center rounded-md bg-blue-500/15 text-blue-300">
            <ServerCog size={14} />
          </div>
          <span className="text-[13px] font-semibold text-gray-100">세션</span>
          <span className="rounded-full bg-white/10 px-1.5 py-0.5 text-[10px] font-medium text-gray-300">
            {profiles.length}
          </span>
          <div className="ml-auto flex items-center gap-0.5">
            <button
              onClick={() => openAdd()}
              title="새 세션 등록"
              className="rounded-md p-1 text-gray-300 hover:bg-white/10 hover:text-white"
            >
              <Plus size={16} />
            </button>
            <button
              onClick={onImport}
              title="CSV/JSON 파일에서 세션 가져오기"
              className="rounded-md p-1 text-gray-300 hover:bg-white/10 hover:text-white"
            >
              <Upload size={14} />
            </button>
            <button
              onClick={onCollapse}
              title="사이드바 접기"
              className="rounded-md p-1 text-gray-400 hover:bg-white/10 hover:text-gray-200"
            >
              <PanelLeftClose size={15} />
            </button>
          </div>
        </div>
        {/* 검색 */}
        <div className="relative mt-2">
          <Search size={12} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="세션 검색..."
            className="w-full rounded-md border border-white/10 bg-black/20 py-1 pl-7 pr-2 text-xs text-gray-200 placeholder:text-gray-500 focus:border-blue-500/40 focus:outline-none focus:ring-1 focus:ring-blue-500/30"
          />
        </div>
      </div>

      {/* 다중 선택 액션 바 — 사이드바가 좁아도 줄바꿈되지 않도록 아이콘 버튼 + nowrap 으로 압축.
          설명이 필요한 건 title 툴팁으로 돌리고, 안내 문구는 아래 줄로 분리한다. */}
      {selected.size > 0 && (
        <div className="border-b border-blue-500/30 bg-blue-600/15 px-2 py-1.5 text-blue-100">
          <div className="flex items-center gap-1">
            {/* 개수가 길어지면(두 자릿수 등) 버튼을 밀지 않고 이쪽이 줄어들도록 min-w-0 + truncate */}
            <span className="min-w-0 flex-1 truncate text-xs font-medium">{selected.size}개 선택</span>
            <div className="flex shrink-0 items-center gap-1">
              <button
                onClick={() => {
                  onOpenMulti(profiles.filter((p) => selected.has(profileKey(p))))
                  setSelected(new Set())
                }}
                title="선택한 세션을 그리드로 열기"
                className="flex items-center gap-1 whitespace-nowrap rounded-md bg-blue-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-blue-500"
              >
                <LayoutGrid size={12} /> 그리드로 열기
              </button>
              <button
                onClick={() => {
                  const list = profiles.filter((p) => selected.has(profileKey(p)))
                  if (list.length) setConfirmDelMany(list)
                }}
                title="선택한 세션을 목록에서 모두 삭제"
                className="rounded-md border border-red-500/40 p-1 text-red-200 hover:bg-red-600/30"
              >
                <Trash2 size={13} />
              </button>
              <button
                onClick={() => setSelected(new Set())}
                title="선택 해제"
                className="rounded-md p-1 text-gray-300 hover:bg-white/10"
              >
                <X size={13} />
              </button>
            </div>
          </div>
          {hiddenSelectedCount > 0 && (
            <div
              className="mt-0.5 text-[10px] leading-tight text-amber-300"
              title="검색어를 바꿔서 지금 목록에 안 보이는 선택 항목입니다"
            >
              검색 결과 밖 {hiddenSelectedCount}개 포함
            </div>
          )}
        </div>
      )}

      {/* 트리 */}
      <div className="min-h-0 flex-1 overflow-y-auto py-1.5">
        {profiles.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/5 text-gray-500">
              <ServerCog size={20} />
            </div>
            <div className="text-xs text-gray-400">저장된 세션이 없습니다</div>
            <div className="text-[11px] leading-relaxed text-gray-600">
              상단 <span className="text-gray-400">＋</span> 로 등록하거나
              <br />
              SSH 연결 시 자동 저장됩니다
            </div>
          </div>
        ) : visible.length === 0 ? (
          <div className="px-4 py-8 text-center text-xs text-gray-500">검색 결과가 없습니다.</div>
        ) : (
          <ul>
            {/* 폴더들 */}
            {folderNames.map((name) => {
              const open = q ? true : !collapsed.has(name)
              const items = folders.get(name)!
              const connCount = items.filter((p) => connectedKeys.has(profileKey(p))).length
              return (
                <li key={'folder:' + name}>
                  <div
                    draggable={editingFolder !== name}
                    onDragStart={(e) => {
                      e.dataTransfer.effectAllowed = 'move'
                      e.dataTransfer.setData('text/plain', 'folder:' + name)
                      setDragKind('folder')
                    }}
                    onDragEnd={() => {
                      setDragKind(null)
                      setOverFolder(null)
                    }}
                    onClick={() => toggleFolder(name)}
                    onDragOver={(e) => {
                      if (!dragKind) return
                      e.preventDefault()
                      e.dataTransfer.dropEffect = 'move'
                      if (overFolder !== name) setOverFolder(name)
                    }}
                    onDragLeave={() => setOverFolder((c) => (c === name ? null : c))}
                    onDrop={(e) => handleFolderDrop(e, name)}
                    className={
                      'group mx-2 my-px flex cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1.5 text-gray-300 transition hover:bg-white/[0.04] ' +
                      (overFolder === name ? 'bg-blue-500/15 ring-1 ring-inset ring-blue-400/70' : '')
                    }
                  >
                    {open ? (
                      <ChevronDown size={13} className="shrink-0 text-gray-500" />
                    ) : (
                      <ChevronRight size={13} className="shrink-0 text-gray-500" />
                    )}
                    {open ? (
                      <FolderOpen size={14} className="shrink-0 text-amber-300/80" />
                    ) : (
                      <Folder size={14} className="shrink-0 text-amber-300/80" />
                    )}
                    {editingFolder === name ? (
                      <input
                        autoFocus
                        value={folderEdit}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => setFolderEdit(e.target.value)}
                        onBlur={commitFolderRename}
                        onKeyDown={(e) => {
                          e.stopPropagation()
                          if (e.key === 'Enter') commitFolderRename()
                          else if (e.key === 'Escape') setEditingFolder(null)
                        }}
                        className="flex-1 rounded bg-black/30 px-1 text-[12.5px] font-semibold text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
                      />
                    ) : (
                      <span
                        onDoubleClick={(e) => {
                          e.stopPropagation()
                          startFolderRename(name)
                        }}
                        title="더블클릭하여 폴더명 변경"
                        className="flex-1 truncate text-[12.5px] font-semibold tracking-tight text-gray-200"
                      >
                        {name}
                      </span>
                    )}
                    {connCount > 0 && (
                      <span className="flex items-center gap-1 rounded-full bg-emerald-500/15 px-1.5 text-[9px] font-medium text-emerald-300">
                        <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                        {connCount}
                      </span>
                    )}
                    {items.length - connCount > 0 && (
                      <span className="text-[10px] tabular-nums text-gray-500">{items.length - connCount}</span>
                    )}
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        // 이 폴더가 이미 전부 선택돼 있으면 해제, 아니면 폴더 전체를 선택에 추가.
                        // (선택 바의 '삭제'로 폴더 통째 삭제까지 이어진다)
                        const keys = items.map(profileKey)
                        const allOn = keys.every((k) => selected.has(k))
                        setSelected((s) => {
                          const n = new Set(s)
                          keys.forEach((k) => (allOn ? n.delete(k) : n.add(k)))
                          return n
                        })
                      }}
                      title={
                        items.every((p) => selected.has(profileKey(p)))
                          ? '이 폴더 선택 해제'
                          : `이 폴더의 세션 ${items.length}개 전체 선택`
                      }
                      className={
                        'rounded-md p-0.5 transition hover:bg-white/10 ' +
                        (items.length && items.every((p) => selected.has(profileKey(p)))
                          ? 'text-blue-300'
                          : 'text-gray-500 opacity-0 hover:text-gray-200 group-hover:opacity-100')
                      }
                    >
                      <CheckSquare size={13} />
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        if (items.length) onOpenMulti(items)
                      }}
                      title={`이 폴더의 세션 ${items.length}개를 모두 그리드로 열기`}
                      className="rounded-md p-0.5 text-blue-400/70 transition hover:bg-blue-500/20 hover:text-blue-200"
                    >
                      <LayoutGrid size={13} />
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        openAdd(name)
                      }}
                      title="이 폴더에 세션 추가"
                      className="rounded-md p-0.5 text-gray-500 opacity-0 transition hover:bg-white/10 hover:text-gray-200 group-hover:opacity-100"
                    >
                      <Plus size={13} />
                    </button>
                  </div>
                  {open && (
                    <ul className="my-0.5 ml-[18px] border-l border-white/[0.07] pl-0.5">
                      {items.map((p) => renderItem(p))}
                    </ul>
                  )}
                </li>
              )
            })}

            {/* 폴더 없는 세션 (+ 세션 드래그 중에는 '여기로 빼기' 드롭존) */}
            {(ungrouped.length > 0 || (dragKind === 'session' && folderNames.length > 0)) && (
              <>
                {folderNames.length > 0 && (
                  <li
                    onDragOver={(e) => {
                      if (dragKind !== 'session') return
                      e.preventDefault()
                      e.dataTransfer.dropEffect = 'move'
                      if (overFolder !== ROOT) setOverFolder(ROOT)
                    }}
                    onDragLeave={() => setOverFolder((c) => (c === ROOT ? null : c))}
                    onDrop={(e) => handleFolderDrop(e, undefined)}
                    className={
                      'mx-3 mb-0.5 mt-2 rounded px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wider ' +
                      (overFolder === ROOT
                        ? 'bg-blue-500/15 text-blue-200 ring-1 ring-inset ring-blue-400/70'
                        : 'text-gray-600')
                    }
                  >
                    분류 없음{dragKind === 'session' ? ' · 여기로 빼기' : ''}
                  </li>
                )}
                {ungrouped.map((p) => renderItem(p))}
              </>
            )}
          </ul>
        )}
      </div>

      <div className="border-t border-white/10 px-3 py-2 text-[10px] leading-relaxed text-gray-500">
        더블클릭·드래그로 연결 · <span className="text-gray-400">＋</span> 등록
      </div>

      {/* 등록/편집 모달 */}
      {editor && (
        <EditorModal
          state={editor}
          folders={existingFolders}
          existingKeys={new Set(profiles.map(profileKey))}
          onClose={() => setEditor(null)}
          onSubmit={(draft, originalKey) => {
            onSave(draft, originalKey)
            setEditor(null)
          }}
        />
      )}

      {/* 선택 항목 일괄 삭제 확인 */}
      {confirmDelMany && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
        >
          <div
            className="w-full max-w-sm rounded-lg border border-white/10 bg-panel p-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-2 text-sm font-semibold text-gray-100">세션 {confirmDelMany.length}개 삭제</div>
            <p className="text-[13px] leading-relaxed text-gray-200">
              선택한 <span className="font-semibold text-white">{confirmDelMany.length}개</span> 세션을 목록에서
              삭제할까요? 되돌릴 수 없습니다.
            </p>
            {confirmDelMany.some((p) => connectedKeys.has(profileKey(p))) && (
              <p className="mt-2 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[11px] leading-relaxed text-amber-200">
                접속 중인 세션이 포함돼 있습니다. 연결 자체는 끊기지 않지만, 목록에서 지워지면{' '}
                <strong>끊겼을 때 자동 재연결이 되지 않고</strong> 탭 이름도 IP 로만 표시됩니다.
              </p>
            )}
            {/* 목록은 자르지 않는다 — 검색으로 가려진 항목이 섞여 있을 수 있어, 지우기 전에 전부 볼 수 있어야 한다 */}
            <ul className="mt-2 max-h-40 overflow-y-auto rounded-md border border-white/10 bg-black/20 p-2 text-[11px] text-gray-400">
              {confirmDelMany.map((p) => (
                <li key={profileKey(p)} className="flex items-center gap-1 truncate font-mono">
                  {connectedKeys.has(profileKey(p)) && (
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400" title="접속 중" />
                  )}
                  <span className="truncate">{p.label?.trim() || `${p.username}@${p.host}`}</span>
                </li>
              ))}
            </ul>
            <div className="mt-3 flex justify-end gap-2">
              <button
                onClick={() => setConfirmDelMany(null)}
                className="rounded-md border border-white/10 bg-panel-light px-3 py-1.5 text-xs text-gray-200 hover:bg-white/10"
              >
                취소
              </button>
              <button
                onClick={() => {
                  onDeleteMany(confirmDelMany)
                  setSelected(new Set())
                  setConfirmDelMany(null)
                }}
                className="rounded-md bg-red-600/80 px-3 py-1.5 text-xs text-white hover:bg-red-500"
              >
                {confirmDelMany.length}개 삭제
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 삭제 확인 */}
      {confirmDel && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
        >
          <div
            className="w-full max-w-sm rounded-lg border border-white/10 bg-panel p-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-2 text-sm font-semibold text-gray-100">세션 삭제</div>
            <p className="text-[13px] leading-relaxed text-gray-200">
              <span className="font-mono text-gray-100">
                {confirmDel.label?.trim() || `${confirmDel.username}@${confirmDel.host}`}
              </span>{' '}
              세션을 목록에서 삭제할까요?
            </p>
            <div className="mt-3 flex justify-end gap-2">
              <button
                onClick={() => setConfirmDel(null)}
                className="rounded-md border border-white/10 bg-panel-light px-3 py-1.5 text-xs text-gray-200 hover:bg-white/10"
              >
                취소
              </button>
              <button
                onClick={() => {
                  onDelete(confirmDel)
                  setConfirmDel(null)
                }}
                className="rounded-md bg-red-600/80 px-3 py-1.5 text-xs text-white hover:bg-red-500"
              >
                삭제
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── 등록/편집 모달 ───────────────────────────────────────────
function EditorModal({
  state,
  folders,
  existingKeys,
  onClose,
  onSubmit,
}: {
  state: { draft: SavedProfile; originalKey?: string }
  folders: string[]
  /** 이미 등록된 프로필들의 키(host:port:username) — 다른 항목과 겹치는 수정 방지용 */
  existingKeys: Set<string>
  onClose: () => void
  onSubmit: (draft: SavedProfile, originalKey?: string) => void
}) {
  const [d, setD] = useState<SavedProfile>(state.draft)
  const [showPw, setShowPw] = useState(false)
  const [err, setErr] = useState('')
  const [folderOpen, setFolderOpen] = useState(false)
  const folderWrapRef = useRef<HTMLDivElement>(null)
  const folderMatches = folders.filter((f) =>
    f.toLowerCase().includes((d.group ?? '').trim().toLowerCase()),
  )
  const set = (patch: Partial<SavedProfile>) => setD((v) => ({ ...v, ...patch }))
  const setJ = (patch: Partial<JumpProfile>) =>
    setD((v) => ({ ...v, jump: { ...(v.jump ?? emptyJump()), ...patch } }))

  // 폴더 자동완성 드롭다운 — 바깥 클릭 시 닫기
  useEffect(() => {
    const onDocMouseDown = (e: MouseEvent) => {
      if (folderWrapRef.current && !folderWrapRef.current.contains(e.target as Node)) {
        setFolderOpen(false)
      }
    }
    document.addEventListener('mousedown', onDocMouseDown)
    return () => document.removeEventListener('mousedown', onDocMouseDown)
  }, [])

  const submit = () => {
    if (!d.host.trim()) {
      setErr('IP/호스트를 입력하세요.')
      return
    }
    const newKey = `${d.host.trim()}:${d.port.trim() || '22'}:${d.username.trim() || 'root'}`
    if (newKey !== state.originalKey && existingKeys.has(newKey)) {
      setErr('같은 IP/Port/User 조합의 세션이 이미 있습니다. 값을 다르게 입력하세요.')
      return
    }
    const jump =
      d.jump && d.jump.host.trim()
        ? {
            ...d.jump,
            host: d.jump.host.trim(),
            port: d.jump.port.trim() || '22',
            username: d.jump.username.trim() || 'root',
          }
        : undefined
    onSubmit(
      {
        ...d,
        host: d.host.trim(),
        username: d.username.trim() || 'root',
        port: d.port.trim() || '22',
        label: d.label?.trim() || undefined,
        group: d.group?.trim() || undefined,
        startup: d.startup?.trim() || undefined,
        jump,
      },
      state.originalKey,
    )
  }

  const inputCls =
    'w-full rounded-md bg-panel-light border border-white/10 px-2.5 py-1.5 text-sm text-gray-100 ' +
    'placeholder:text-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-500'

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
    >
      <div
        className="w-full max-w-md rounded-lg border border-white/10 bg-panel p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center">
          <div className="text-sm font-semibold text-gray-100">
            {state.originalKey ? '세션 편집' : '새 세션 등록'}
          </div>
          <button
            onClick={onClose}
            className="ml-auto rounded p-1 text-gray-400 hover:bg-white/10 hover:text-gray-200"
          >
            <X size={15} />
          </button>
        </div>

        <p className="mb-1.5 text-[10px] text-gray-500">
          별칭과 폴더를 입력하지 않으면 IP 정보로 세션이 등록됩니다.
        </p>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="mb-0.5 block text-[11px] text-gray-400">별칭 (선택)</label>
            <input
              className={inputCls}
              placeholder="예: con2"
              value={d.label ?? ''}
              onChange={(e) => set({ label: e.target.value })}
            />
          </div>
          <div ref={folderWrapRef} className="relative">
            <label className="mb-0.5 block text-[11px] text-gray-400">폴더 (선택)</label>
            <input
              className={inputCls}
              placeholder="예: poc3_suse"
              value={d.group ?? ''}
              onChange={(e) => set({ group: e.target.value })}
              onFocus={() => setFolderOpen(true)}
            />
            {folderOpen && folderMatches.length > 0 && (
              <div className="absolute z-10 mt-1 max-h-36 w-full overflow-y-auto rounded-md border border-white/10 bg-panel-light shadow-lg">
                {folderMatches.map((f) => (
                  <button
                    key={f}
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      set({ group: f })
                      setFolderOpen(false)
                    }}
                    className="block w-full truncate px-2.5 py-1.5 text-left text-[12px] text-gray-200 hover:bg-white/10"
                  >
                    {f}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* 탭 색상 */}
        <div className="mt-2">
          <label className="mb-1 block text-[11px] text-gray-400">탭 색상 (선택)</label>
          <div className="flex items-center gap-1.5 flex-wrap">
            {[
              { key: '', label: '없음', bg: '#374151' },
              { key: 'rose',    label: 'Rose',    bg: '#fb7185' },
              { key: 'orange',  label: 'Orange',  bg: '#fb923c' },
              { key: 'amber',   label: 'Amber',   bg: '#fbbf24' },
              { key: 'emerald', label: 'Emerald', bg: '#34d399' },
              { key: 'sky',     label: 'Sky',     bg: '#38bdf8' },
              { key: 'blue',    label: 'Blue',    bg: '#60a5fa' },
              { key: 'violet',  label: 'Violet',  bg: '#a78bfa' },
            ].map(({ key, label, bg }) => (
              <button
                key={key}
                type="button"
                title={label}
                onClick={() => set({ color: key || undefined })}
                style={{ background: bg }}
                className={
                  'h-5 w-5 rounded-full border-2 transition ' +
                  ((d.color ?? '') === key
                    ? 'border-white scale-110'
                    : 'border-transparent opacity-60 hover:opacity-100')
                }
              />
            ))}
          </div>
        </div>

        <div className="mt-2 grid grid-cols-12 gap-2">
          <div className="col-span-7">
            <label className="mb-0.5 block text-[11px] text-gray-400">IP / 호스트</label>
            <input
              className={inputCls}
              placeholder="192.168.0.10"
              value={d.host}
              onChange={(e) => set({ host: e.target.value })}
            />
          </div>
          <div className="col-span-2">
            <label className="mb-0.5 block text-[11px] text-gray-400">Port</label>
            <input className={inputCls} value={d.port} onChange={(e) => set({ port: e.target.value })} />
          </div>
          <div className="col-span-3">
            <label className="mb-0.5 block text-[11px] text-gray-400">User</label>
            <input
              className={inputCls}
              value={d.username}
              onChange={(e) => set({ username: e.target.value })}
            />
          </div>
        </div>

        <div className="mt-2 flex gap-3 text-xs text-gray-300">
          <label className="flex items-center gap-1">
            <input
              type="radio"
              checked={d.authMethod === 'password'}
              onChange={() => set({ authMethod: 'password' as AuthMethod })}
            />
            비밀번호
          </label>
          <label className="flex items-center gap-1">
            <input
              type="radio"
              checked={d.authMethod === 'key'}
              onChange={() => set({ authMethod: 'key' as AuthMethod })}
            />
            개인키(Key)
          </label>
          <label className="flex items-center gap-1">
            <input
              type="radio"
              checked={d.authMethod === 'agent'}
              onChange={() => set({ authMethod: 'agent' as AuthMethod })}
            />
            SSH 에이전트
          </label>
        </div>

        <div className="mt-2">
          {d.authMethod === 'agent' ? (
            <div className="rounded-md bg-white/5 px-2.5 py-2 text-[11px] leading-relaxed text-gray-400">
              OS SSH 에이전트(Pageant / OpenSSH agent)에 등록된 키로 인증합니다.
            </div>
          ) : d.authMethod === 'password' ? (
            <div className="relative">
              <input
                type={showPw ? 'text' : 'password'}
                className={inputCls + ' pr-9'}
                placeholder="Password"
                value={d.password}
                onChange={(e) => set({ password: e.target.value })}
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
          ) : (
            <div className="space-y-2">
              <button
                type="button"
                onClick={async () => {
                  const r = await window.electronAPI.sshPickKeyFile()
                  if (r.ok && r.content) set({ privateKey: r.content })
                }}
                className="flex items-center gap-1 rounded-md border border-white/10 bg-panel-light px-2 py-1 text-[11px] text-gray-200 hover:bg-white/10"
              >
                <FileKey size={12} /> 키 파일 불러오기
              </button>
              <textarea
                className={inputCls + ' h-20 resize-none font-mono text-xs'}
                placeholder="-----BEGIN OPENSSH PRIVATE KEY----- ..."
                value={d.privateKey}
                onChange={(e) => set({ privateKey: e.target.value })}
              />
              <div className="relative">
                <input
                  type={showPw ? 'text' : 'password'}
                  className={inputCls + ' pr-9'}
                  placeholder="Passphrase (선택)"
                  value={d.passphrase}
                  onChange={(e) => set({ passphrase: e.target.value })}
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
            </div>
          )}
        </div>

        {/* 접속 후 자동 실행 명령 */}
        <div className="mt-3 border-t border-white/10 pt-2">
          <label className="mb-0.5 block text-[11px] text-gray-400">
            접속 후 자동 실행 (한 줄에 하나, 선택)
          </label>
          <textarea
            className={inputCls + ' h-14 resize-none font-mono text-xs'}
            placeholder={'예:\ncd /var/log\nsudo -i'}
            value={d.startup ?? ''}
            onChange={(e) => set({ startup: e.target.value })}
          />
        </div>

        {/* 점프 호스트(Bastion) 경유 */}
        <label className="mt-3 flex items-center gap-1.5 border-t border-white/10 pt-2 text-xs text-gray-300">
          <input
            type="checkbox"
            checked={!!d.jump}
            onChange={(e) => set({ jump: e.target.checked ? emptyJump() : undefined })}
          />
          점프 호스트(Bastion) 경유
        </label>
        {d.jump && (
          <div className="mt-2 space-y-2 rounded-md border border-white/10 bg-panel-light/50 p-2">
            <div className="grid grid-cols-12 gap-2">
              <div className="col-span-7">
                <label className="mb-0.5 block text-[11px] text-gray-400">점프 IP / 호스트</label>
                <input
                  className={inputCls}
                  placeholder="bastion.example.com"
                  value={d.jump.host}
                  onChange={(e) => setJ({ host: e.target.value })}
                />
              </div>
              <div className="col-span-2">
                <label className="mb-0.5 block text-[11px] text-gray-400">Port</label>
                <input className={inputCls} value={d.jump.port} onChange={(e) => setJ({ port: e.target.value })} />
              </div>
              <div className="col-span-3">
                <label className="mb-0.5 block text-[11px] text-gray-400">User</label>
                <input
                  className={inputCls}
                  value={d.jump.username}
                  onChange={(e) => setJ({ username: e.target.value })}
                />
              </div>
            </div>
            <div className="flex gap-3 text-xs text-gray-300">
              <label className="flex items-center gap-1">
                <input
                  type="radio"
                  checked={d.jump.authMethod === 'password'}
                  onChange={() => setJ({ authMethod: 'password' })}
                />
                비밀번호
              </label>
              <label className="flex items-center gap-1">
                <input
                  type="radio"
                  checked={d.jump.authMethod === 'key'}
                  onChange={() => setJ({ authMethod: 'key' })}
                />
                개인키(Key)
              </label>
              <label className="flex items-center gap-1">
                <input
                  type="radio"
                  checked={d.jump.authMethod === 'agent'}
                  onChange={() => setJ({ authMethod: 'agent' })}
                />
                에이전트
              </label>
            </div>
            {d.jump.authMethod === 'agent' ? (
              <div className="rounded bg-white/5 px-2 py-1 text-[10px] text-gray-400">
                SSH 에이전트로 인증
              </div>
            ) : d.jump.authMethod === 'password' ? (
              <input
                type={showPw ? 'text' : 'password'}
                className={inputCls}
                placeholder="점프 호스트 Password"
                value={d.jump.password}
                onChange={(e) => setJ({ password: e.target.value })}
              />
            ) : (
              <div className="space-y-2">
                <button
                  type="button"
                  onClick={async () => {
                    const r = await window.electronAPI.sshPickKeyFile()
                    if (r.ok && r.content) setJ({ privateKey: r.content })
                  }}
                  className="flex items-center gap-1 rounded-md border border-white/10 bg-panel-light px-2 py-1 text-[11px] text-gray-200 hover:bg-white/10"
                >
                  <FileKey size={12} /> 키 파일 불러오기
                </button>
                <textarea
                  className={inputCls + ' h-16 resize-none font-mono text-xs'}
                  placeholder="점프 호스트 개인키 (-----BEGIN ...)"
                  value={d.jump.privateKey}
                  onChange={(e) => setJ({ privateKey: e.target.value })}
                />
                <input
                  type={showPw ? 'text' : 'password'}
                  className={inputCls}
                  placeholder="Passphrase (선택)"
                  value={d.jump.passphrase}
                  onChange={(e) => setJ({ passphrase: e.target.value })}
                />
              </div>
            )}
          </div>
        )}

        {err && <div className="mt-2 text-[11px] text-red-300">{err}</div>}

        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-md border border-white/10 bg-panel-light px-3 py-1.5 text-xs text-gray-200 hover:bg-white/10"
          >
            취소
          </button>
          <button
            onClick={submit}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500"
          >
            저장
          </button>
        </div>
      </div>
    </div>
  )
}
