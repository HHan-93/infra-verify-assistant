import { useEffect, useRef, useState } from 'react'
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
} from 'lucide-react'
import RemotePathPicker from './RemotePathPicker'

interface LiveLogViewerProps {
  sessionId: string
  /** 파일탐색기에서 "실시간 보기"로 열었을 때 미리 채워지는 경로 — 있으면 바로 tail 시작 */
  initialPath?: string
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

/** 대소문자 구분 없이 일치하는 부분을 <mark>로 강조 (특수문자 이스케이프 포함) */
function highlight(text: string, query: string) {
  if (!query) return text
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const parts = text.split(new RegExp(`(${escaped})`, 'gi'))
  return parts.map((part, i) =>
    part.toLowerCase() === query.toLowerCase() ? (
      <mark key={i} className="rounded bg-yellow-500/40 text-inherit">
        {part}
      </mark>
    ) : (
      part
    ),
  )
}

/**
 * 실시간 로그(tail -f) 뷰어.
 *  - 경로를 몰라도 되도록: 자동완성 + "찾아보기"(트리) + 자주 쓰는 로그 프리셋 칩 + 최근 경로
 *  - 시작 후에는 계속 흘러들어오는 줄을 자동 스크롤로 표시, 키워드 강조, 일시정지 지원
 */
export default function LiveLogViewer({ sessionId, initialPath, onClose }: LiveLogViewerProps) {
  const [stage, setStage] = useState<'entry' | 'tail'>('entry')
  const [pathInput, setPathInput] = useState(initialPath ?? '')
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState('')
  const [needSudo, setNeedSudo] = useState(false)
  const [sudoPw, setSudoPw] = useState('')
  const [showSudoPw, setShowSudoPw] = useState(false)
  const [showPicker, setShowPicker] = useState(false)
  const [recent, setRecent] = useState<string[]>(() => loadRecent())
  const [presets, setPresets] = useState(() => loadPresets())
  const [showAddPreset, setShowAddPreset] = useState(false)
  const [newPresetLabel, setNewPresetLabel] = useState('')
  const [newPresetPath, setNewPresetPath] = useState('')

  // 경로 자동완성 (마지막 '/' 기준 디렉토리를 sftp:list 로 조회해 제안)
  const [acOpen, setAcOpen] = useState(false)
  const [acEntries, setAcEntries] = useState<{ name: string; type: string }[]>([])
  const acDirRef = useRef<string | null>(null)
  const acTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // tail 상태
  const [tailPath, setTailPath] = useState('')
  const tailIdRef = useRef<string | null>(null)
  const pendingRef = useRef('') // 줄바꿈으로 안 끝난 마지막 조각(다음 청크와 이어붙임)
  const [lines, setLines] = useState<string[]>([])
  const pausedRef = useRef(false)
  const [paused, setPaused] = useState(false)
  const pausedQueueRef = useRef<string[]>([])
  const [pendingCount, setPendingCount] = useState(0)
  const [autoScroll, setAutoScroll] = useState(true)
  const [highlightQuery, setHighlightQuery] = useState('')
  const [closedNotice, setClosedNotice] = useState('')
  const bodyRef = useRef<HTMLDivElement>(null)

  // 원격 데이터 수신 구독 — sessionId 뿐 아니라 tailId 로도 필터링해야 함. 같은 세션에서
  // "다른 경로"로 재시작하면(컴포넌트는 그대로, tailId만 바뀜) 이전 tail 의 늦게 도착하는
  // close 이벤트나 버퍼된 데이터가 새 tail 화면을 덮어쓰는 걸 막기 위함.
  useEffect(() => {
    const offData = window.electronAPI.onLogtailData((d) => {
      if (d.sessionId !== sessionId || d.tailId !== tailIdRef.current) return
      const combined = pendingRef.current + d.data
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
    })
    const offClosed = window.electronAPI.onLogtailClosed((d) => {
      if (d.sessionId !== sessionId || d.tailId !== tailIdRef.current) return
      setClosedNotice('연결이 종료되었습니다 (세션 재접속 또는 파일 삭제 등으로 스트림이 끊겼습니다).')
    })
    return () => {
      offData()
      offClosed()
    }
  }, [sessionId])

  // 자동 스크롤 (잠금 상태일 때만, 새 줄 도착 시 맨 아래로)
  useEffect(() => {
    if (!autoScroll) return
    const el = bodyRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines, autoScroll])

  // 언마운트 시 tail 정리
  useEffect(() => {
    return () => {
      window.electronAPI.logtailStop(sessionId)
    }
  }, [sessionId])

  const startTail = async (path: string, sudoPassword?: string) => {
    const p = path.trim()
    if (!p) return
    setStarting(true)
    setStartError('')
    const r = await window.electronAPI.logtailStart(sessionId, p, sudoPassword)
    setStarting(false)
    if (r.ok) {
      tailIdRef.current = r.tailId ?? null
      setTailPath(p)
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
      saveRecent(p)
      setRecent(loadRecent())
      setStage('tail')
    } else if (r.needSudoPassword) {
      setNeedSudo(true)
    } else {
      setStartError(r.error || '로그를 열 수 없습니다.')
    }
  }

  // 최초 진입 시 미리 채워진 경로가 있으면 바로 시작
  useEffect(() => {
    if (initialPath) startTail(initialPath)
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
    window.electronAPI.logtailStop(sessionId)
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
        const r = await window.electronAPI.sftpList(sessionId, dir)
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-8">
      <div className="flex h-[75vh] w-[720px] max-w-[94vw] flex-col overflow-hidden rounded-lg border border-white/10 bg-panel shadow-2xl">
        <div className="flex items-center gap-2 border-b border-white/10 px-4 py-2.5">
          <Activity size={16} className="text-emerald-400" />
          <span className="text-sm font-semibold text-gray-100">실시간 로그</span>
          {stage === 'tail' && <span className="truncate font-mono text-[11px] text-gray-500">{tailPath}</span>}
          <button onClick={onClose} className="ml-auto rounded p-1 text-gray-400 hover:bg-white/10 hover:text-gray-200">
            <X size={16} />
          </button>
        </div>

        {stage === 'entry' ? (
          <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-5">
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
                      if (e.key === 'Enter') startTail(pathInput)
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
                  onClick={() => startTail(pathInput)}
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
                        if (e.key === 'Enter') startTail(pathInput, sudoPw)
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
                    onClick={() => startTail(pathInput, sudoPw)}
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
              <span className="shrink-0 text-[10px] text-gray-500">{lines.length}줄</span>
            </div>
            {closedNotice && (
              <div className="bg-red-500/10 px-3 py-1 text-[11px] text-red-300">{closedNotice}</div>
            )}
            <div
              ref={bodyRef}
              onScroll={onScrollBody}
              className="min-h-0 flex-1 overflow-auto bg-[#1e1e2e] p-2.5 font-mono text-[11px] leading-relaxed"
            >
              {lines.length === 0 ? (
                <p className="text-gray-500">데이터를 기다리는 중...</p>
              ) : (
                lines.map((line, i) => (
                  <div key={i} className="whitespace-pre-wrap break-all text-gray-300">
                    {highlight(line, highlightQuery.trim())}
                  </div>
                ))
              )}
            </div>
          </>
        )}
      </div>

      {showPicker && (
        <RemotePathPicker
          sessionId={sessionId}
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
