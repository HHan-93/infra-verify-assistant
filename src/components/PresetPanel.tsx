import { useMemo, useState } from 'react'
import { Play, CornerDownLeft, Copy, Check, X } from 'lucide-react'
import { PRESETS } from '../presets'

interface PresetPanelProps {
  connected: boolean
  /** 명령어 실행/입력. execute=false 면 실행 없이 터미널에 입력만(플레이스홀더 수정용) */
  onRun: (cmd: string, execute: boolean) => void
  /** 패널 닫기 */
  onClose: () => void
}

/** <...> 플레이스홀더 포함 여부 */
const hasPlaceholder = (cmd: string) => /<[^>]+>/.test(cmd)

/**
 * 명령어 프리셋 패널 (3단계: 카테고리 → 하위분류 → 명령어).
 *  - 좌: 솔루션 카테고리(OpenStack / Ceph / Kubernetes / 공통)
 *  - 우 상단: 선택한 카테고리의 하위분류 탭(컴퓨트/네트워크/스토리지 …)
 *  - 우 본문: 선택한 하위분류의 명령어를 설명과 함께 나열 → 실행/입력/복사
 */
export default function PresetPanel({ connected, onRun, onClose }: PresetPanelProps) {
  const [solution, setSolution] = useState(PRESETS[0].solution)
  const [subName, setSubName] = useState(PRESETS[0].subgroups[0].name)
  const [copied, setCopied] = useState<string | null>(null)

  const group = useMemo(
    () => PRESETS.find((g) => g.solution === solution) ?? PRESETS[0],
    [solution],
  )
  const sub = useMemo(
    () => group.subgroups.find((s) => s.name === subName) ?? group.subgroups[0],
    [group, subName],
  )

  // 카테고리 변경 시 하위분류를 첫 항목으로 리셋
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
    } catch {
      /* 무시 */
    }
  }

  return (
    <div className="flex h-80 border-b border-white/10 bg-panel">
      {/* 1단계: 카테고리 */}
      <div className="flex w-32 shrink-0 flex-col border-r border-white/10 py-2">
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

      {/* 2·3단계: 하위분류 + 명령어 */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* 하위분류 탭 */}
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
          <button
            onClick={onClose}
            title="프리셋 닫기"
            className="ml-auto rounded p-1 text-gray-400 hover:bg-white/10 hover:text-gray-200"
          >
            <X size={14} />
          </button>
        </div>

        {!connected && (
          <div className="bg-amber-500/10 px-3 py-1 text-[11px] text-amber-300">
            SSH 연결 후 실행 가능합니다. (복사는 지금도 가능)
          </div>
        )}

        {/* 명령어 목록 */}
        <div className="flex-1 space-y-1.5 overflow-y-auto p-2">
          {sub.commands.map((c) => {
            const ph = hasPlaceholder(c.command)
            return (
              <div
                key={c.command}
                className="group rounded-md border border-white/10 bg-panel-light p-2 transition hover:border-blue-500/40"
              >
                <div className="flex items-center gap-2">
                  <span className="shrink-0 text-[13px] font-medium text-gray-100">{c.label}</span>
                  <code className="min-w-0 flex-1 truncate rounded bg-black/40 px-1.5 py-0.5 font-mono text-[11px] text-pink-200">
                    {c.command}
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
                <p className="mt-1 text-[11px] leading-relaxed text-gray-400">
                  {c.desc}
                  {ph && <span className="ml-1 text-amber-400/80">· &lt;...&gt; 수정 필요</span>}
                </p>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
