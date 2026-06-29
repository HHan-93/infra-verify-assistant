import { GitCompare, X } from 'lucide-react'

export interface DiffSource {
  id: string
  label: string
  lines: string[]
}

interface NodeDiffProps {
  sources: DiffSource[]
  onClose: () => void
}

/**
 * 노드 간 출력 비교(diff).
 *  - 여러 세션의 최근 출력(또는 선택 영역)을 줄 단위로 나란히 비교
 *  - 한 줄이라도 세션 간 내용이 다르면 빨강으로 하이라이트 → 클러스터 일관성 점검
 */
export default function NodeDiff({ sources, onClose }: NodeDiffProps) {
  const maxLines = sources.reduce((m, s) => Math.max(m, s.lines.length), 0)
  // 각 줄이 모든 세션에서 동일한지
  const differ: boolean[] = []
  for (let i = 0; i < maxLines; i++) {
    const first = sources[0]?.lines[i] ?? ''
    differ[i] = sources.some((s) => (s.lines[i] ?? '') !== first)
  }
  const diffCount = differ.filter(Boolean).length

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6" onClick={onClose}>
      <div
        className="flex h-[82vh] w-[90vw] max-w-[1100px] flex-col overflow-hidden rounded-lg border border-white/10 bg-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-white/10 px-4 py-2.5">
          <GitCompare size={16} className="text-blue-400" />
          <span className="text-sm font-semibold text-gray-100">노드 간 출력 비교</span>
          <span className="text-[11px] text-gray-500">
            {sources.length}개 세션 · 차이 {diffCount}줄
          </span>
          <button
            onClick={onClose}
            className="ml-auto rounded p-1 text-gray-400 hover:bg-white/10 hover:text-gray-200"
          >
            <X size={16} />
          </button>
        </div>

        {sources.length < 2 ? (
          <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-gray-500">
            비교하려면 연결된 세션이 2개 이상 필요합니다.
            <br />
            여러 노드에서 같은 명령을 실행(동시입력 활용)한 뒤 비교하면 좋습니다.
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto">
            <div className="flex min-w-full">
              {/* 줄 번호 */}
              <div className="sticky left-0 z-10 shrink-0 select-none border-r border-white/10 bg-panel text-right font-mono text-[10px] text-gray-600">
                <div className="border-b border-white/10 px-2 py-1">#</div>
                {Array.from({ length: maxLines }).map((_, i) => (
                  <div
                    key={i}
                    className={'px-2 leading-5 ' + (differ[i] ? 'bg-red-500/10 text-red-300' : '')}
                  >
                    {i + 1}
                  </div>
                ))}
              </div>
              {/* 세션별 컬럼 */}
              {sources.map((s) => (
                <div key={s.id} className="min-w-[260px] flex-1 border-r border-white/10">
                  <div className="truncate border-b border-white/10 px-2 py-1 font-mono text-[11px] text-gray-200">
                    {s.label}
                  </div>
                  {Array.from({ length: maxLines }).map((_, i) => (
                    <div
                      key={i}
                      className={
                        'whitespace-pre overflow-hidden text-ellipsis px-2 font-mono text-[11px] leading-5 ' +
                        (differ[i] ? 'bg-red-500/10 text-red-200' : 'text-gray-300')
                      }
                      title={s.lines[i] ?? ''}
                    >
                      {s.lines[i] ?? ''}
                    </div>
                  ))}
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
