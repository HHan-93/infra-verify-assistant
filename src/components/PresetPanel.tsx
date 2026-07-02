import { useEffect, useMemo, useRef, useState } from 'react'
import { Play, CornerDownLeft, Copy, Check, X, Search } from 'lucide-react'
import { PRESETS } from '../presets'

interface PresetPanelProps {
  connected: boolean
  onRun: (cmd: string, execute: boolean) => void
  onClose: () => void
}

const hasPlaceholder = (cmd: string) => /<[^>]+>/.test(cmd)

// 검색용 전체 명령어 플랫 목록
const ALL_COMMANDS = PRESETS.flatMap((g) =>
  g.subgroups.flatMap((s) =>
    s.commands.map((c) => ({ ...c, solution: g.solution, subgroup: s.name }))
  )
)

function Highlight({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>
  const idx = text.toLowerCase().indexOf(query.toLowerCase())
  if (idx === -1) return <>{text}</>
  return (
    <>
      {text.slice(0, idx)}
      <mark className="rounded-sm bg-yellow-400/30 px-0.5 text-yellow-200 not-italic">
        {text.slice(idx, idx + query.length)}
      </mark>
      {text.slice(idx + query.length)}
    </>
  )
}

export default function PresetPanel({ connected, onRun, onClose }: PresetPanelProps) {
  const [solution, setSolution] = useState(PRESETS[0].solution)
  const [subName, setSubName] = useState(PRESETS[0].subgroups[0].name)
  const [copied, setCopied] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  // 카테고리 목록(좌측) 너비 — 드래그로 조절, localStorage 보존
  const [catWidth, setCatWidth] = useState(() => Number(localStorage.getItem('preset_cat_width')) || 128)
  const catWidthRef = useRef(catWidth)
  const catDragRef = useRef(false)
  const bodyRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!catDragRef.current) return
      const el = bodyRef.current
      if (!el) return
      const r = el.getBoundingClientRect()
      const w = Math.max(100, Math.min(320, e.clientX - r.left))
      catWidthRef.current = w
      setCatWidth(w)
    }
    const onUp = () => {
      if (!catDragRef.current) return
      catDragRef.current = false
      document.body.style.cursor = ''
      localStorage.setItem('preset_cat_width', String(Math.round(catWidthRef.current)))
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [])

  const trimmed = query.trim()

  const group = useMemo(
    () => PRESETS.find((g) => g.solution === solution) ?? PRESETS[0],
    [solution],
  )
  const sub = useMemo(
    () => group.subgroups.find((s) => s.name === subName) ?? group.subgroups[0],
    [group, subName],
  )

  const selectSolution = (name: string) => {
    const g = PRESETS.find((p) => p.solution === name)
    setSolution(name)
    setSubName(g?.subgroups[0].name ?? '')
  }

  const copy = async (cmd: string) => {
    try {
      await navigator.clipboard.writeText(cmd)
      setCopied(cmd)
      setTimeout(() => setCopied((c) => (c === cmd ? null : c)), 1500)
    } catch { /* 무시 */ }
  }

  const searchResults = useMemo(() => {
    if (!trimmed) return []
    const q = trimmed.toLowerCase()
    return ALL_COMMANDS.filter(
      (c) =>
        c.label.toLowerCase().includes(q) ||
        c.command.toLowerCase().includes(q) ||
        (c.desc ?? '').toLowerCase().includes(q)
    )
  }, [trimmed])

  const renderCommand = (
    c: { label: string; command: string; desc?: string; solution?: string; subgroup?: string },
    key: string,
    showContext = false,
  ) => {
    const ph = hasPlaceholder(c.command)
    return (
      <div
        key={key}
        className="group rounded-md border border-white/10 bg-panel-light p-2 transition hover:border-blue-500/40"
      >
        <div className="flex items-center gap-2">
          {showContext && (
            <span className="shrink-0 rounded bg-blue-600/20 px-1.5 py-0.5 text-[10px] text-blue-300">
              {c.solution} · {c.subgroup}
            </span>
          )}
          <span className="shrink-0 text-[13px] font-medium text-gray-100">
            <Highlight text={c.label} query={trimmed} />
          </span>
          <code className="min-w-0 flex-1 truncate rounded bg-black/40 px-1.5 py-0.5 font-mono text-[11px] text-pink-200">
            <Highlight text={c.command} query={trimmed} />
          </code>
          <div className="flex shrink-0 items-center gap-1">
            <button
              onClick={() => copy(c.command)}
              title="명령어 복사"
              className="rounded p-1 text-gray-400 hover:bg-white/10 hover:text-gray-200"
            >
              {copied === c.command ? (
                <Check size={13} className="text-green-400" />
              ) : (
                <Copy size={13} />
              )}
            </button>
            <button
              onClick={() => onRun(c.command, !ph)}
              disabled={!connected}
              title={
                !connected
                  ? 'SSH 연결 필요'
                  : ph
                    ? '<...> 부분을 채운 뒤 Enter (실행 없이 입력만)'
                    : '터미널에서 실행'
              }
              className={
                'flex items-center gap-1 rounded px-2 py-1 text-[11px] text-white disabled:cursor-not-allowed disabled:opacity-40 ' +
                (ph ? 'bg-amber-600/80 hover:bg-amber-500' : 'bg-blue-600/80 hover:bg-blue-500')
              }
            >
              {ph ? <CornerDownLeft size={11} /> : <Play size={11} />}
              {ph ? '입력' : '실행'}
            </button>
          </div>
        </div>
        {c.desc && (
          <p className="mt-1 text-[11px] leading-relaxed text-gray-400">
            <Highlight text={c.desc} query={trimmed} />
            {ph && <span className="ml-1 text-amber-400/80">· &lt;...&gt; 수정 필요</span>}
          </p>
        )}
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col border-b border-white/10 bg-panel">
      {/* 검색 바 */}
      <div className="flex items-center gap-2 border-b border-white/10 px-2.5 py-1.5">
        <Search size={13} className="shrink-0 text-gray-500" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="명령어, 설명 검색..."
          className="min-w-0 flex-1 bg-transparent text-[12px] text-gray-200 outline-none placeholder:text-gray-600"
        />
        {trimmed ? (
          <button
            onClick={() => setQuery('')}
            className="shrink-0 text-gray-500 hover:text-gray-300"
          >
            <X size={13} />
          </button>
        ) : (
          <button
            onClick={onClose}
            title="프리셋 닫기"
            className="shrink-0 text-gray-500 hover:text-gray-300"
          >
            <X size={14} />
          </button>
        )}
      </div>

      {trimmed ? (
        /* 검색 결과 모드 */
        <div className="flex-1 overflow-y-auto p-2">
          {searchResults.length === 0 ? (
            <p className="py-6 text-center text-[12px] text-gray-500">
              일치하는 명령어가 없습니다.
            </p>
          ) : (
            <div className="space-y-1.5">
              <p className="px-1 pb-1 text-[10px] text-gray-500">
                {searchResults.length}개 일치
              </p>
              {searchResults.map((c) =>
                renderCommand(c, `${c.solution}-${c.subgroup}-${c.command}`, true)
              )}
            </div>
          )}
        </div>
      ) : (
        /* 일반 탐색 모드 */
        <div ref={bodyRef} className="flex min-w-0 flex-1 overflow-hidden">
          {/* 1단계: 카테고리 */}
          <div style={{ width: catWidth }} className="flex shrink-0 flex-col py-2">
            <div className="px-3 pb-2 text-[10px] font-semibold uppercase tracking-wide text-gray-500">
              카테고리
            </div>
            {PRESETS.map((g) => (
              <button
                key={g.solution}
                onClick={() => selectSolution(g.solution)}
                className={
                  'mx-1 rounded-md px-2.5 py-1.5 text-left text-[13px] transition ' +
                  (g.solution === solution
                    ? 'bg-blue-600/30 font-medium text-blue-100'
                    : 'text-gray-300 hover:bg-white/5')
                }
              >
                {g.solution}
              </button>
            ))}
          </div>

          <div
            onMouseDown={() => {
              catDragRef.current = true
              document.body.style.cursor = 'col-resize'
            }}
            title="드래그하여 카테고리 너비 조절"
            className="w-1 shrink-0 cursor-col-resize bg-white/10 hover:bg-blue-400/50"
          />

          {/* 2·3단계: 하위분류 + 명령어 */}
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex flex-wrap items-center gap-1 border-b border-white/10 px-2 py-1.5">
              {group.subgroups.map((s) => (
                <button
                  key={s.name}
                  onClick={() => setSubName(s.name)}
                  className={
                    'rounded-full px-2.5 py-0.5 text-[11px] transition ' +
                    (s.name === sub.name
                      ? 'bg-blue-500/80 text-white'
                      : 'bg-panel-light text-gray-300 hover:bg-white/10')
                  }
                >
                  {s.name}
                  <span className="ml-1 opacity-60">{s.commands.length}</span>
                </button>
              ))}
            </div>

            {!connected && (
              <div className="bg-amber-500/10 px-3 py-1 text-[11px] text-amber-300">
                SSH 연결 후 실행 가능합니다. (복사는 지금도 가능)
              </div>
            )}

            <div className="flex-1 space-y-1.5 overflow-y-auto p-2">
              {sub.commands.map((c) => renderCommand(c, c.command))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
