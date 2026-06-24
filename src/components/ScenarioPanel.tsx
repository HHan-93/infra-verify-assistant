import { useMemo, useState } from 'react'
import { Play, CornerDownLeft, Copy, Check, X, ListChecks } from 'lucide-react'
import { SCENARIOS, type Scenario } from '../scenarios'

interface ScenarioPanelProps {
  connected: boolean
  /** 명령어 실행/입력. execute=false 면 실행 없이 터미널에 입력만(플레이스홀더 수정용) */
  onRun: (cmd: string, execute: boolean) => void
  onClose: () => void
}

const hasPlaceholder = (cmd: string) => /<[^>]+>/.test(cmd)

/**
 * 작업 시나리오 패널 (순서가 있는 명령어 흐름).
 *  - 좌: 솔루션별 시나리오 목록
 *  - 우: 선택한 시나리오의 단계(Step)를 번호와 설명, 실행/입력 버튼과 함께 나열
 */
export default function ScenarioPanel({ connected, onRun, onClose }: ScenarioPanelProps) {
  const [selectedId, setSelectedId] = useState(SCENARIOS[0].id)
  const [copied, setCopied] = useState<string | null>(null)

  // 솔루션별로 시나리오 그룹화
  const groups = useMemo(() => {
    const map = new Map<string, Scenario[]>()
    for (const s of SCENARIOS) {
      const arr = map.get(s.solution) ?? []
      arr.push(s)
      map.set(s.solution, arr)
    }
    return Array.from(map, ([solution, scenarios]) => ({ solution, scenarios }))
  }, [])

  const scenario = SCENARIOS.find((s) => s.id === selectedId) ?? SCENARIOS[0]

  const copy = async (cmd: string) => {
    try {
      await navigator.clipboard.writeText(cmd)
      setCopied(cmd)
      setTimeout(() => setCopied((c) => (c === cmd ? null : c)), 1500)
    } catch {
      /* 무시 */
    }
  }

  return (
    <div className="flex h-80 border-b border-white/10 bg-panel">
      {/* 시나리오 목록 */}
      <div className="w-52 shrink-0 overflow-y-auto border-r border-white/10 py-2">
        <div className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-wide text-gray-500">
          시나리오
        </div>
        {groups.map((g) => (
          <div key={g.solution} className="mb-1">
            <div className="px-3 py-1 text-[10px] font-semibold text-blue-300/80">{g.solution}</div>
            {g.scenarios.map((s) => (
              <button
                key={s.id}
                onClick={() => setSelectedId(s.id)}
                className={
                  'mx-1 block w-[calc(100%-0.5rem)] rounded-md px-2.5 py-1.5 text-left text-[12px] leading-snug transition ' +
                  (s.id === selectedId
                    ? 'bg-blue-600/30 font-medium text-blue-100'
                    : 'text-gray-300 hover:bg-white/5')
                }
              >
                {s.title}
              </button>
            ))}
          </div>
        ))}
      </div>

      {/* 선택한 시나리오의 단계 */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-start gap-2 border-b border-white/10 px-3 py-2">
          <ListChecks size={15} className="mt-0.5 shrink-0 text-blue-300" />
          <div className="min-w-0">
            <div className="text-[13px] font-semibold text-gray-100">{scenario.title}</div>
            <div className="text-[11px] leading-relaxed text-gray-400">{scenario.summary}</div>
          </div>
          <button
            onClick={onClose}
            title="시나리오 닫기"
            className="ml-auto shrink-0 rounded p-1 text-gray-400 hover:bg-white/10 hover:text-gray-200"
          >
            <X size={14} />
          </button>
        </div>

        {!connected && (
          <div className="bg-amber-500/10 px-3 py-1 text-[11px] text-amber-300">
            SSH 연결 후 단계를 실행할 수 있습니다. (복사는 지금도 가능)
          </div>
        )}

        {/* 단계 목록 */}
        <div className="flex-1 space-y-2 overflow-y-auto p-2.5">
          {scenario.steps.map((step, idx) => {
            const ph = hasPlaceholder(step.command)
            return (
              <div key={idx} className="flex gap-2.5">
                {/* 단계 번호 */}
                <div className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-blue-600/40 text-[11px] font-semibold text-blue-100">
                  {idx + 1}
                </div>
                {/* 단계 내용 */}
                <div className="min-w-0 flex-1 rounded-md border border-white/10 bg-panel-light p-2">
                  <div className="flex items-center gap-2">
                    <span className="shrink-0 text-[13px] font-medium text-gray-100">
                      {step.title}
                    </span>
                    <code className="min-w-0 flex-1 truncate rounded bg-black/40 px-1.5 py-0.5 font-mono text-[11px] text-pink-200">
                      {step.command}
                    </code>
                    <div className="flex shrink-0 items-center gap-1">
                      <button
                        onClick={() => copy(step.command)}
                        title="명령어 복사"
                        className="rounded p-1 text-gray-400 hover:bg-white/10 hover:text-gray-200"
                      >
                        {copied === step.command ? (
                          <Check size={13} className="text-green-400" />
                        ) : (
                          <Copy size={13} />
                        )}
                      </button>
                      <button
                        onClick={() => onRun(step.command, !ph)}
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
                  <p className="mt-1 text-[11px] leading-relaxed text-gray-400">{step.desc}</p>
                  {step.note && (
                    <p className="mt-1 rounded bg-amber-500/10 px-1.5 py-1 text-[11px] leading-relaxed text-amber-300/90">
                      {step.note}
                    </p>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
