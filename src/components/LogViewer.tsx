import { useEffect, useMemo, useRef, useState } from 'react'
import {
  X,
  Search,
  Trash2,
  Play,
  Pause,
  RotateCcw,
  FileText,
  Clapperboard,
  ChevronUp,
  ChevronDown,
  Settings,
} from 'lucide-react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { LogIndexEntry, LogRetentionSettings } from '../../electron/shared-types'
import ConfirmDialog from './ConfirmDialog'

interface LogViewerProps {
  onClose: () => void
}

type Mode = 'text' | 'replay'

function fmtDate(ms: number): string {
  const d = new Date(ms)
  return d.toLocaleString('ko-KR', { hour12: false })
}
function fmtDuration(startMs: number, endMs?: number): string {
  const sec = Math.max(0, Math.round(((endMs ?? Date.now()) - startMs) / 1000))
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  return h > 0 ? `${h}시간 ${m}분` : m > 0 ? `${m}분 ${s}초` : `${s}초`
}
function fmtSize(bytes?: number): string {
  if (!bytes) return '-'
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}
function daysLeft(startedAt: number, retentionDays: number): number {
  const ageMs = Date.now() - startedAt
  return Math.ceil(retentionDays - ageMs / (24 * 60 * 60 * 1000))
}

const SPEEDS = [1, 2, 4, 8] as const

export default function LogViewer({ onClose }: LogViewerProps) {
  const [entries, setEntries] = useState<LogIndexEntry[]>([])
  const [listQuery, setListQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [mode, setMode] = useState<Mode>('text')
  const [confirmDeleteEntry, setConfirmDeleteEntry] = useState<LogIndexEntry | null>(null)
  const [retention, setRetention] = useState<LogRetentionSettings | null>(null)
  const [editingRetention, setEditingRetention] = useState(false)
  const [draftDays, setDraftDays] = useState('')
  const [draftEntries, setDraftEntries] = useState('')
  const [savingRetention, setSavingRetention] = useState(false)

  useEffect(() => {
    window.electronAPI.logsList().then(setEntries)
    window.electronAPI.logsGetRetentionSettings().then(setRetention)
  }, [])

  const saveRetention = async () => {
    const retentionDays = Number(draftDays)
    const maxEntries = Number(draftEntries)
    if (!Number.isFinite(retentionDays) || retentionDays < 1 || !Number.isFinite(maxEntries) || maxEntries < 1) return
    setSavingRetention(true)
    try {
      const saved = await window.electronAPI.logsSetRetentionSettings({ retentionDays, maxEntries })
      setRetention(saved)
      setEntries(await window.electronAPI.logsList())
      setEditingRetention(false)
    } finally {
      setSavingRetention(false)
    }
  }

  const filtered = useMemo(() => {
    const q = listQuery.trim().toLowerCase()
    if (!q) return entries
    return entries.filter(
      (e) => e.host.toLowerCase().includes(q) || (e.label ?? '').toLowerCase().includes(q),
    )
  }, [entries, listQuery])

  const selected = entries.find((e) => e.id === selectedId) ?? null

  const oldestFinished = useMemo(
    () => [...entries].filter((e) => e.endedAt).sort((a, b) => a.startedAt - b.startedAt)[0] ?? null,
    [entries],
  )

  const deleteEntry = async (e: LogIndexEntry) => {
    await window.electronAPI.logsDelete(e.id)
    const list = await window.electronAPI.logsList()
    setEntries(list)
    if (selectedId === e.id) setSelectedId(null)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6">
      <div className="flex h-full max-h-[880px] w-full max-w-5xl overflow-hidden rounded-lg border border-white/10 bg-panel shadow-2xl">
        {/* 좌측: 로그 목록 */}
        <div className="flex w-64 shrink-0 flex-col border-r border-white/10">
          <div className="flex items-center gap-2 border-b border-white/10 px-2.5 py-1.5">
            <Search size={13} className="shrink-0 text-gray-500" />
            <input
              value={listQuery}
              onChange={(e) => setListQuery(e.target.value)}
              placeholder="호스트, 별칭 검색..."
              className="min-w-0 flex-1 bg-transparent text-[12px] text-gray-200 outline-none placeholder:text-gray-600"
            />
          </div>
          <div className="flex-1 overflow-y-auto p-1.5">
            {filtered.length === 0 ? (
              <p className="py-6 text-center text-[12px] text-gray-500">
                {entries.length === 0 ? '기록된 세션 로그가 없습니다.' : '일치하는 로그가 없습니다.'}
              </p>
            ) : (
              <div className="space-y-1">
                {filtered.map((e) => (
                  <button
                    key={e.id}
                    onClick={() => {
                      setSelectedId(e.id)
                      setMode('text')
                    }}
                    className={
                      'group flex w-full flex-col items-start gap-0.5 rounded-md px-2.5 py-1.5 text-left transition ' +
                      (e.id === selectedId ? 'bg-blue-600/30' : 'hover:bg-white/5')
                    }
                  >
                    <div className="flex w-full items-center gap-1">
                      <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-gray-100">
                        {e.label || e.host}
                      </span>
                      <Trash2
                        size={12}
                        className="shrink-0 text-gray-500 opacity-0 hover:text-red-300 group-hover:opacity-100"
                        onClick={(ev) => {
                          ev.stopPropagation()
                          setConfirmDeleteEntry(e)
                        }}
                      />
                    </div>
                    <span className="text-[10px] text-gray-500">{fmtDate(e.startedAt)}</span>
                    <span className="text-[10px] text-gray-500">
                      {fmtDuration(e.startedAt, e.endedAt)} · {fmtSize(e.sizeBytes)}
                      {!e.endedAt && <span className="ml-1 text-emerald-400">기록중</span>}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* 하단: 보관 정책 안내 + 인라인 설정 */}
          <div className="border-t border-white/10 px-2.5 py-1.5 text-[10px] text-gray-500">
            {retention && (
              <div className="flex items-center gap-1">
                <span className="min-w-0 flex-1">
                  현재 {entries.length}개 보관 · 최근 {retention.maxEntries}개 · {retention.retentionDays}일까지
                  {oldestFinished && (
                    <>
                      {' '}
                      · 가장 오래된 로그{' '}
                      {(() => {
                        const d = daysLeft(oldestFinished.startedAt, retention.retentionDays)
                        return d <= 0 ? '삭제 대상' : `약 ${d}일 후 삭제`
                      })()}
                    </>
                  )}
                </span>
                <button
                  onClick={() => {
                    setDraftDays(String(retention.retentionDays))
                    setDraftEntries(String(retention.maxEntries))
                    setEditingRetention((v) => !v)
                  }}
                  title="보관 정책 설정"
                  className="shrink-0 rounded p-0.5 text-gray-500 hover:bg-white/10 hover:text-gray-300"
                >
                  <Settings size={12} />
                </button>
              </div>
            )}
            {editingRetention && retention && (
              <div className="mt-1.5 flex flex-col gap-1.5 rounded-md bg-panel-light p-1.5">
                <label className="flex items-center justify-between gap-2">
                  <span>보관기간(일)</span>
                  <input
                    type="number"
                    min={1}
                    value={draftDays}
                    onChange={(e) => setDraftDays(e.target.value)}
                    className="w-16 rounded border border-white/10 bg-black/30 px-1.5 py-0.5 text-right text-[11px] text-gray-100 outline-none focus:border-blue-500 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                  />
                </label>
                <label className="flex items-center justify-between gap-2">
                  <span>최대 개수</span>
                  <input
                    type="number"
                    min={1}
                    value={draftEntries}
                    onChange={(e) => setDraftEntries(e.target.value)}
                    className="w-16 rounded border border-white/10 bg-black/30 px-1.5 py-0.5 text-right text-[11px] text-gray-100 outline-none focus:border-blue-500 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                  />
                </label>
                <div className="flex justify-end gap-1.5 pt-0.5">
                  <button
                    onClick={() => setEditingRetention(false)}
                    className="rounded px-2 py-0.5 text-gray-400 hover:bg-white/10"
                  >
                    취소
                  </button>
                  <button
                    onClick={saveRetention}
                    disabled={savingRetention}
                    className="rounded bg-blue-600/80 px-2 py-0.5 text-white hover:bg-blue-500 disabled:opacity-40"
                  >
                    저장
                  </button>
                </div>
                <p className="text-[9px] text-gray-600">
                  둘 중 하나라도 넘으면 자동 삭제됩니다 (기록 중인 세션 제외).
                </p>
              </div>
            )}
          </div>
        </div>

        {/* 우측: 상세 (텍스트 보기 / 리플레이) */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-2 border-b border-white/10 px-3 py-1.5">
            <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-gray-100">
              {selected ? selected.label || selected.host : '세션 로그'}
            </span>
            {selected && (
              <div className="flex shrink-0 items-center gap-1 rounded-md bg-panel-light p-0.5">
                <button
                  onClick={() => setMode('text')}
                  className={
                    'flex items-center gap-1 rounded px-2 py-1 text-[11px] ' +
                    (mode === 'text' ? 'bg-blue-600/70 text-white' : 'text-gray-300 hover:bg-white/10')
                  }
                >
                  <FileText size={12} />
                  텍스트
                </button>
                <button
                  onClick={() => setMode('replay')}
                  className={
                    'flex items-center gap-1 rounded px-2 py-1 text-[11px] ' +
                    (mode === 'replay' ? 'bg-blue-600/70 text-white' : 'text-gray-300 hover:bg-white/10')
                  }
                >
                  <Clapperboard size={12} />
                  리플레이
                </button>
              </div>
            )}
            <button onClick={onClose} title="닫기" className="shrink-0 text-gray-500 hover:text-gray-300">
              <X size={16} />
            </button>
          </div>

          {!selected ? (
            <div className="flex flex-1 items-center justify-center text-[12px] text-gray-500">
              왼쪽에서 로그를 선택하세요.
            </div>
          ) : mode === 'text' ? (
            <LogTextView entry={selected} />
          ) : (
            <LogReplayView entry={selected} />
          )}
        </div>
      </div>

      {confirmDeleteEntry && (
        <ConfirmDialog
          title="로그 삭제"
          message={`"${confirmDeleteEntry.label || confirmDeleteEntry.host}" 로그 기록을 삭제할까요?\n(원본 평문 로그 파일은 남아있습니다)`}
          onCancel={() => setConfirmDeleteEntry(null)}
          onConfirm={() => {
            deleteEntry(confirmDeleteEntry)
            setConfirmDeleteEntry(null)
          }}
        />
      )}
    </div>
  )
}

// ── 텍스트 보기 + 검색 ────────────────────────────────────────
function LogTextView({ entry }: { entry: LogIndexEntry }) {
  const [content, setContent] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [truncated, setTruncated] = useState(false)
  const [query, setQuery] = useState('')
  const [matchIdx, setMatchIdx] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)
  const matchRefs = useRef<(HTMLElement | null)[]>([])

  useEffect(() => {
    setLoading(true)
    setError('')
    setQuery('')
    window.electronAPI.logsRead(entry.id).then((r) => {
      if (r.ok) {
        setContent(r.content ?? '')
        setTruncated(!!r.truncated)
      } else {
        setError(r.error ?? '로그를 불러오지 못했습니다.')
      }
      setLoading(false)
    })
  }, [entry.id])

  const lines = useMemo(() => content.split('\n'), [content])
  const trimmedQuery = query.trim().toLowerCase()

  const matchCount = useMemo(() => {
    if (!trimmedQuery) return 0
    return lines.reduce((acc, line) => acc + (line.toLowerCase().includes(trimmedQuery) ? 1 : 0), 0)
  }, [lines, trimmedQuery])

  useEffect(() => {
    matchRefs.current = []
    setMatchIdx(0)
  }, [trimmedQuery])

  useEffect(() => {
    if (!trimmedQuery || matchCount === 0) return
    const el = matchRefs.current[matchIdx]
    el?.scrollIntoView({ block: 'center' })
  }, [matchIdx, trimmedQuery, matchCount])

  const goNext = () => matchCount > 0 && setMatchIdx((i) => (i + 1) % matchCount)
  const goPrev = () => matchCount > 0 && setMatchIdx((i) => (i - 1 + matchCount) % matchCount)

  let matchSeen = -1

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-white/10 px-3 py-1.5">
        <Search size={12} className="shrink-0 text-gray-500" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.shiftKey ? goPrev() : goNext())
          }}
          placeholder="로그 내용 검색..."
          className="min-w-0 flex-1 bg-transparent text-[12px] text-gray-200 outline-none placeholder:text-gray-600"
        />
        {trimmedQuery && (
          <>
            <span className="shrink-0 text-[11px] text-gray-500">
              {matchCount > 0 ? `${matchIdx + 1}/${matchCount}` : '0/0'}
            </span>
            <button onClick={goPrev} className="shrink-0 rounded p-0.5 text-gray-400 hover:text-gray-200">
              <ChevronUp size={13} />
            </button>
            <button onClick={goNext} className="shrink-0 rounded p-0.5 text-gray-400 hover:text-gray-200">
              <ChevronDown size={13} />
            </button>
          </>
        )}
      </div>
      {truncated && (
        <div className="bg-amber-500/10 px-3 py-1 text-[11px] text-amber-300">
          로그가 너무 커서 앞부분 5MB만 표시합니다.
        </div>
      )}
      <div ref={containerRef} className="flex-1 overflow-auto bg-black/30 p-2.5 font-mono text-[11px] leading-relaxed">
        {loading ? (
          <p className="text-gray-500">불러오는 중...</p>
        ) : error ? (
          <p className="text-red-400">{error}</p>
        ) : (
          lines.map((line, i) => {
            const hasMatch = trimmedQuery && line.toLowerCase().includes(trimmedQuery)
            if (hasMatch) matchSeen++
            const isCurrent = hasMatch && matchSeen === matchIdx
            return (
              <div
                key={i}
                ref={(el) => {
                  if (hasMatch) matchRefs.current[matchSeen] = el
                }}
                className={
                  'whitespace-pre-wrap break-all text-gray-300' +
                  (isCurrent ? ' rounded bg-yellow-500/30' : hasMatch ? ' bg-yellow-500/10' : '')
                }
              >
                {line || ' '}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

// ── 리플레이 (xterm 재생) ─────────────────────────────────────
function LogReplayView({ entry }: { entry: LogIndexEntry }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const framesRef = useRef<{ t: number; d: string }[]>([])
  const idxRef = useRef(0)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const playingRef = useRef(false)
  const speedRef = useRef<number>(4)
  const anchorRef = useRef({ wallStart: 0, frameT: 0 })

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(4)
  const [progress, setProgress] = useState(0)
  const [total, setTotal] = useState(0)

  const clearTimer = () => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = null
  }

  const scheduleNext = () => {
    const frames = framesRef.current
    if (!playingRef.current || idxRef.current >= frames.length) {
      if (idxRef.current >= frames.length) {
        playingRef.current = false
        setPlaying(false)
      }
      return
    }
    const frame = frames[idxRef.current]
    const targetElapsed = (frame.t - anchorRef.current.frameT) / speedRef.current
    const wallElapsed = performance.now() - anchorRef.current.wallStart
    const delay = Math.max(0, targetElapsed - wallElapsed)
    timerRef.current = setTimeout(() => {
      termRef.current?.write(frame.d)
      idxRef.current++
      setProgress(idxRef.current)
      scheduleNext()
    }, delay)
  }

  const play = () => {
    if (idxRef.current >= framesRef.current.length) return
    playingRef.current = true
    setPlaying(true)
    anchorRef.current = { wallStart: performance.now(), frameT: framesRef.current[idxRef.current]?.t ?? 0 }
    scheduleNext()
  }
  const pause = () => {
    playingRef.current = false
    setPlaying(false)
    clearTimer()
  }
  const restart = () => {
    pause()
    termRef.current?.reset()
    idxRef.current = 0
    setProgress(0)
    play()
  }
  const changeSpeed = (v: number) => {
    speedRef.current = v
    setSpeed(v)
    if (playingRef.current) {
      clearTimer()
      anchorRef.current = { wallStart: performance.now(), frameT: framesRef.current[idxRef.current]?.t ?? 0 }
      scheduleNext()
    }
  }

  useEffect(() => {
    if (!containerRef.current) return
    const term = new Terminal({
      cursorBlink: false,
      disableStdin: true,
      fontFamily: 'Consolas, "D2Coding", "Courier New", monospace',
      fontSize: 12,
      scrollback: 20000,
      theme: { background: '#1e1e2e', foreground: '#cdd6f4', cursor: '#f5e0dc' },
    })
    const fitAddon = new FitAddon()
    fitAddonRef.current = fitAddon
    term.loadAddon(fitAddon)
    term.open(containerRef.current)
    termRef.current = term
    const safeFit = () => {
      requestAnimationFrame(() => {
        try {
          fitAddonRef.current?.fit()
        } catch {
          /* 컨테이너가 아직 0 크기일 때 무시 */
        }
      })
    }
    safeFit()

    const resizeObserver = new ResizeObserver(() => safeFit())
    resizeObserver.observe(containerRef.current)

    setLoading(true)
    setError('')
    window.electronAPI.logsReadCast(entry.id).then((r) => {
      if (r.ok && r.frames) {
        framesRef.current = r.frames
        setTotal(r.frames.length)
        idxRef.current = 0
        setProgress(0)
        setLoading(false)
        play()
      } else {
        setError(r.error ?? '리플레이 기록을 찾을 수 없습니다. (이 세션 로그는 리플레이를 지원하지 않을 수 있습니다)')
        setLoading(false)
      }
    })

    return () => {
      resizeObserver.disconnect()
      pause()
      term.dispose()
      termRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry.id])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-white/10 px-3 py-1.5">
        <button
          onClick={playing ? pause : play}
          disabled={loading || !!error}
          title={playing ? '일시정지' : '재생'}
          className="flex items-center gap-1 rounded bg-blue-600/80 px-2 py-1 text-[11px] text-white hover:bg-blue-500 disabled:opacity-40"
        >
          {playing ? <Pause size={12} /> : <Play size={12} />}
          {playing ? '일시정지' : '재생'}
        </button>
        <button
          onClick={restart}
          disabled={loading || !!error}
          title="처음부터"
          className="flex items-center gap-1 rounded px-1.5 py-1 text-[11px] text-gray-300 hover:bg-white/10 disabled:opacity-40"
        >
          <RotateCcw size={12} />
        </button>
        <div className="flex items-center gap-1">
          {SPEEDS.map((v) => (
            <button
              key={v}
              onClick={() => changeSpeed(v)}
              className={
                'rounded px-1.5 py-0.5 text-[11px] ' +
                (speed === v ? 'bg-blue-600/70 text-white' : 'text-gray-400 hover:bg-white/10')
              }
            >
              {v}x
            </button>
          ))}
        </div>
        <span className="ml-auto shrink-0 text-[11px] text-gray-500">
          {total > 0 ? `${progress}/${total} 조각` : ''}
        </span>
      </div>
      {error && <div className="bg-red-500/10 px-3 py-1 text-[11px] text-red-300">{error}</div>}
      <div className="min-h-0 flex-1 overflow-hidden bg-black/30 p-1.5" ref={containerRef} />
    </div>
  )
}
