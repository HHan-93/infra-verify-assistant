import { useEffect, useMemo, useState } from 'react'
import { GitCompare, X, ScanText, Camera, Clock, Plus } from 'lucide-react'
import { buildDiffRows } from '../lib/lineDiff'
import { maskForExport } from '../lib/mask'
import {
  getSnapshots,
  saveSnapshot,
  deleteSnapshot,
  type OutputSnapshot,
} from '../lib/snapshots'

const hhmm = (ts: number) => {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

export interface DiffSource {
  id: string
  label: string
  lines: string[]
}

interface NodeDiffProps {
  sources: DiffSource[]
  onClose: () => void
  /** 비교 대상 전체를 AI 패널로 보내 분석 (스트리밍 중이면 false 반환) */
  onAnalyze: (text: string) => boolean
}

/**
 * 노드 간 출력 비교(diff).
 *  - 여러 세션의 최근 출력(또는 선택 영역)을 LCS 기반으로 줄 정렬해 나란히 비교
 *  - 첫 번째 세션을 기준으로 삼아, 실제로 추가/삭제/변경된 줄만 빨강으로 하이라이트
 *    (단순 줄번호 비교와 달리, 줄 하나가 밀려도 그 이후 전부 달라 보이지 않음)
 */
export default function NodeDiff({ sources: liveSources, onClose, onAnalyze }: NodeDiffProps) {
  const [analyzeNotice, setAnalyzeNotice] = useState('')
  // 시점 비교용: 불러온 스냅샷을 diff 컬럼으로 추가 (id 'snap-...' 로 라이브 세션과 구분)
  const [snapCols, setSnapCols] = useState<DiffSource[]>([])
  const [snaps, setSnaps] = useState<OutputSnapshot[]>(() => getSnapshots())
  const [showSnapMenu, setShowSnapMenu] = useState(false)
  const [savedNotice, setSavedNotice] = useState('')

  useEffect(() => {
    const refresh = () => setSnaps(getSnapshots())
    window.addEventListener('snapshots-changed', refresh)
    return () => window.removeEventListener('snapshots-changed', refresh)
  }, [])

  // 라이브 세션 컬럼 + 불러온 스냅샷 컬럼을 합쳐 비교
  const sources = useMemo(() => [...liveSources, ...snapCols], [liveSources, snapCols])
  const rows = useMemo(() => buildDiffRows(sources.map((s) => s.lines)), [sources])
  const diffCount = rows.filter((r) => r.differs).length

  const isSnapCol = (id: string) => id.startsWith('snap-')

  // 라이브 세션 컬럼을 스냅샷으로 저장 (라벨 = 세션명 @ 시각)
  const captureSource = (s: DiffSource) => {
    saveSnapshot(`${s.label} @ ${hhmm(Date.now())}`, s.lines)
    setSavedNotice(`스냅샷 저장됨: ${s.label}`)
    setTimeout(() => setSavedNotice(''), 2000)
  }
  // 저장된 스냅샷을 diff 컬럼으로 추가
  const addSnapCol = (snap: OutputSnapshot) => {
    setSnapCols((cols) =>
      cols.some((c) => c.id === snap.id)
        ? cols
        : [...cols, { id: snap.id, label: `🕘 ${snap.label}`, lines: snap.lines }],
    )
    setShowSnapMenu(false)
  }
  const removeSnapCol = (id: string) => setSnapCols((cols) => cols.filter((c) => c.id !== id))

  // 비교 대상 세션들의 출력을 노드별로 묶어 AI 분석에 보냄 (차이 원인/이상 진단)
  const analyzeDiff = () => {
    const parts = sources.map((s) => `### 세션: ${s.label}\n${s.lines.join('\n')}`)
    const text = `다음은 여러 노드(세션)의 출력을 비교한 것입니다. 총 ${diffCount}줄이 서로 다릅니다. 노드 간 차이의 원인과 이상 징후를 진단해 주세요.\n\n${parts.join('\n\n')}`
    const started = onAnalyze(maskForExport(text))
    setAnalyzeNotice(started ? '' : 'AI가 이미 다른 응답을 생성하는 중입니다. 잠시 후 다시 시도하세요.')
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6" onClick={onClose}>
      <div
        className="flex h-[86vh] w-[1700px] max-w-[97vw] flex-col overflow-hidden rounded-lg border border-white/10 bg-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-white/10 px-4 py-2.5">
          <GitCompare size={16} className="text-blue-400" />
          <span className="text-sm font-semibold text-gray-100">출력 비교 (노드 간 · 시점 간)</span>
          <span className="text-[11px] text-gray-500">
            {sources.length}개 열 · 차이 {diffCount}줄
          </span>
          {savedNotice && <span className="text-[11px] text-emerald-300">{savedNotice}</span>}
          {sources.length >= 2 && (
            <button
              onClick={analyzeDiff}
              title="비교 대상 전체를 AI로 진단"
              className="ml-auto flex items-center gap-1 rounded-md border border-white/10 bg-panel-light px-2 py-1 text-xs text-gray-200 hover:bg-white/10"
            >
              <ScanText size={14} className="text-blue-300" />
              AI 분석
            </button>
          )}
          <button
            onClick={onClose}
            className={
              (sources.length >= 2 ? '' : 'ml-auto ') +
              'rounded p-1 text-gray-400 hover:bg-white/10 hover:text-gray-200'
            }
          >
            <X size={16} />
          </button>
        </div>
        {analyzeNotice && (
          <div className="bg-amber-500/10 px-4 py-1 text-[11px] text-amber-300">{analyzeNotice}</div>
        )}

        {/* 시점 스냅샷 컨트롤바 — 라이브 열을 스냅샷으로 저장 / 저장된 스냅샷을 비교 열로 불러오기 */}
        <div className="relative flex flex-wrap items-center gap-1.5 border-b border-white/10 px-4 py-1.5">
          <Camera size={12} className="shrink-0 text-gray-500" />
          <span className="mr-1 text-[11px] text-gray-500">현재 열 저장:</span>
          {liveSources.length === 0 ? (
            <span className="text-[11px] text-gray-600">연결된 세션 없음</span>
          ) : (
            liveSources.map((s) => (
              <button
                key={s.id}
                onClick={() => captureSource(s)}
                title={`${s.label} 의 현재 출력을 시점 스냅샷으로 저장`}
                className="rounded-full border border-white/10 bg-panel-light px-2 py-0.5 text-[11px] text-gray-300 hover:bg-white/10"
              >
                {s.label}
              </button>
            ))
          )}
          <span className="mx-1 h-4 w-px bg-white/15" />
          <button
            onClick={() => setShowSnapMenu((v) => !v)}
            className="flex items-center gap-1 rounded-md border border-white/10 bg-panel-light px-2 py-0.5 text-[11px] text-gray-200 hover:bg-white/10"
          >
            <Clock size={12} className="text-sky-300" />
            스냅샷 불러오기 ({snaps.length})
          </button>
          {showSnapMenu && (
            <div className="absolute left-4 top-full z-20 mt-1 max-h-72 w-[420px] overflow-y-auto rounded-md border border-white/10 bg-panel shadow-2xl">
              {snaps.length === 0 ? (
                <div className="px-3 py-3 text-[11px] text-gray-500">
                  저장된 스냅샷이 없습니다. 위에서 현재 열을 저장하세요.
                </div>
              ) : (
                snaps.map((snap) => {
                  const added = snapCols.some((c) => c.id === snap.id)
                  return (
                    <div key={snap.id} className="flex items-center gap-2 px-2 py-1.5 hover:bg-white/5">
                      <button
                        onClick={() => addSnapCol(snap)}
                        disabled={added}
                        className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-[11px] text-gray-200 disabled:opacity-40"
                      >
                        <Plus size={12} className="shrink-0 text-emerald-300" />
                        <span className="truncate">{snap.label}</span>
                        <span className="shrink-0 text-[10px] text-gray-500">{snap.lines.length}줄</span>
                      </button>
                      <button
                        onClick={() => {
                          deleteSnapshot(snap.id)
                          removeSnapCol(snap.id)
                        }}
                        title="스냅샷 삭제"
                        className="shrink-0 rounded p-1 text-gray-500 hover:bg-red-500/15 hover:text-red-300"
                      >
                        <X size={11} />
                      </button>
                    </div>
                  )
                })
              )}
            </div>
          )}
        </div>

        {sources.length < 2 ? (
          <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-gray-500">
            비교하려면 열이 2개 이상 필요합니다 (연결된 세션 또는 저장된 스냅샷).
            <br />
            같은 명령을 여러 노드에서 실행해 비교하거나, 작업 전 저장해 둔 스냅샷과 현재 출력을 비교하세요.
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto">
            <div className="flex min-w-full">
              {/* 줄 번호 (기준 세션 = sources[0] 기준) */}
              <div className="sticky left-0 z-10 shrink-0 select-none border-r border-white/10 bg-panel text-right font-mono text-[10px] text-gray-600">
                <div className="border-b border-white/10 px-2 py-1">#</div>
                {rows.map((row, i) => (
                  <div
                    key={i}
                    className={'px-2 leading-5 ' + (row.differs ? 'bg-red-500/10 text-red-300' : '')}
                  >
                    {row.refIdx !== null ? row.refIdx + 1 : ''}
                  </div>
                ))}
              </div>
              {/* 세션별 컬럼 */}
              {sources.map((s, si) => (
                <div key={s.id} className="min-w-[260px] flex-1 border-r border-white/10">
                  <div
                    className={
                      'flex items-center gap-1 border-b border-white/10 px-2 py-1 font-mono text-[11px] ' +
                      (isSnapCol(s.id) ? 'bg-sky-500/10 text-sky-200' : 'text-gray-200')
                    }
                  >
                    <span className="truncate">{s.label}</span>
                    {isSnapCol(s.id) ? (
                      <button
                        onClick={() => removeSnapCol(s.id)}
                        title="이 스냅샷 열 제거"
                        className="ml-auto shrink-0 rounded p-0.5 text-sky-300/70 hover:bg-white/10 hover:text-sky-200"
                      >
                        <X size={11} />
                      </button>
                    ) : (
                      <button
                        onClick={() => captureSource(s)}
                        title="이 열을 시점 스냅샷으로 저장"
                        className="ml-auto shrink-0 rounded p-0.5 text-gray-500 hover:bg-white/10 hover:text-gray-200"
                      >
                        <Camera size={11} />
                      </button>
                    )}
                  </div>
                  {rows.map((row, i) => {
                    const cell = row.cells[si]
                    return (
                      <div
                        key={i}
                        className={
                          'whitespace-pre overflow-hidden text-ellipsis px-2 font-mono text-[11px] leading-5 ' +
                          (!row.differs
                            ? 'text-gray-300'
                            : cell === null
                              ? 'bg-red-500/5'
                              : 'bg-red-500/10 text-red-200')
                        }
                        title={cell ?? ''}
                      >
                        {cell ?? ''}
                      </div>
                    )
                  })}
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="border-t border-white/10 px-4 py-1.5 text-[10px] text-gray-500">
          빨강 = 세션 간 내용이 다른 줄 · 각 세션의 드래그 선택이 있으면 그 영역, 없으면 최근 출력 비교
        </div>
      </div>
    </div>
  )
}
