import { useMemo, useRef, useState } from 'react'
import {
  ListChecks,
  X,
  Play,
  Loader2,
  ChevronDown,
  ChevronRight,
  Check,
  Ban,
  SkipForward,
  ClipboardCopy,
  Save,
  ScanText,
  Info,
} from 'lucide-react'
import type { CommandCheck } from '../../electron/shared-types'
import { judgeOutput, hasCheck, type Verdict } from '../lib/verdict'
import { maskForExport } from '../lib/mask'

export interface RunnerStep {
  title: string
  command: string
  desc?: string
  warn?: string
  check?: CommandCheck
}
export interface RunnerScenario {
  title: string
  summary: string
  steps: RunnerStep[]
}
interface RunTarget {
  id: string
  name: string
}

interface ScenarioRunnerProps {
  scenario: RunnerScenario
  sessions: RunTarget[]
  defaultSessionId?: string
  onClose: () => void
  /** 리포트를 AI 패널로 보내 분석 (스트리밍 중이면 false) */
  onAnalyze?: (text: string) => boolean
}

type StepStatus = 'pending' | 'running' | 'ran' | 'error'
interface StepResult {
  status: StepStatus
  out?: string
  err?: string
  code?: number
  verdict?: Verdict
  reasons?: string[]
  /** 사람이 직접 지정한 판정(자동 판정을 덮어씀, 안내 스텝의 유일한 판정 수단) */
  manual?: 'pass' | 'fail' | 'skip'
}

/** 스텝의 최종 판정 — 수동 지정이 있으면 그것, 없으면 자동 판정 */
type Effective = 'pass' | 'fail' | 'info' | 'skip' | 'manual-wait' | 'pending'
function effectiveOf(step: RunnerStep, r: StepResult | undefined): Effective {
  if (r?.manual === 'skip') return 'skip'
  if (r?.manual === 'pass') return 'pass'
  if (r?.manual === 'fail') return 'fail'
  if (r?.verdict) return r.verdict
  // 명령이 없는 안내 스텝은 사람이 판정해야 함
  if (!step.command.trim()) return 'manual-wait'
  return 'pending'
}

const EFFECTIVE_META: Record<Effective, { label: string; cls: string }> = {
  pass: { label: '정상', cls: 'bg-emerald-500/20 text-emerald-300' },
  fail: { label: '실패', cls: 'bg-red-500/25 text-red-300' },
  info: { label: '실행됨', cls: 'bg-emerald-500/10 text-emerald-300/80' },
  skip: { label: '건너뜀', cls: 'bg-violet-500/20 text-violet-300' },
  'manual-wait': { label: '수동 확인', cls: 'bg-sky-500/20 text-sky-300' },
  pending: { label: '대기', cls: 'bg-white/10 text-gray-500' },
}

// <...> 플레이스홀더 — 검증 실행 전에 값을 한 번 받아 명령에 치환한다(VIP 등).
const PH_RE = /<([^<>\n]+)>/g
function extractPlaceholders(cmd: string): string[] {
  const found: string[] = []
  for (const m of cmd.matchAll(PH_RE)) if (!found.includes(m[1])) found.push(m[1])
  return found
}
function fillPlaceholders(cmd: string, values: Record<string, string>): string {
  return cmd.replace(PH_RE, (full, key) => (values[key]?.trim() ? values[key] : full))
}
const hasUnfilled = (cmd: string) => /<[^<>\n]+>/.test(cmd)

// 각 스텝이 독립 exec 로 실행돼 cd 가 유지되지 않으므로, 명령에서 cd 대상을 추출해 러너가
// 작업 디렉토리를 기억하고 다음 스텝 앞에 `cd <cwd> &&` 를 붙여준다.
function extractCdTarget(cmd: string): string | null {
  const m = [...cmd.matchAll(/(?:^|&&|;)\s*cd\s+([^\s&;|]+)/g)]
  return m.length ? m[m.length - 1][1] : null
}
function resolveCwd(current: string, target: string): string {
  if (target.startsWith('/') || target.startsWith('~')) return target // 절대/홈 기준 → 교체
  return current ? `${current}/${target}` : target // 상대 → 이어붙임
}

const RUN_TIMEOUT_MS = 45000

/**
 * 시나리오 검증 러너 — 시나리오의 각 스텝을 대상 세션에서 순차 실행(session:run 캡처)하고
 * 자동 판정(verdict)한다. 명령이 없는 안내 스텝은 검증자가 통과/실패/건너뜀을 수동 지정.
 * 최종 결과는 요약 + 스텝별 리포트(Markdown)로 복사/저장한다.
 */
export default function ScenarioRunner({
  scenario,
  sessions,
  defaultSessionId,
  onClose,
  onAnalyze,
}: ScenarioRunnerProps) {
  const [targetId, setTargetId] = useState(
    defaultSessionId && sessions.some((s) => s.id === defaultSessionId)
      ? defaultSessionId
      : sessions[0]?.id ?? '',
  )
  const [results, setResults] = useState<Record<number, StepResult>>({})
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  // 시나리오 전체에서 쓰인 <...> 플레이스홀더 목록 + 사용자가 채운 값
  const allPlaceholders = useMemo(() => {
    const s: string[] = []
    for (const step of scenario.steps)
      for (const p of extractPlaceholders(step.command)) if (!s.includes(p)) s.push(p)
    return s
  }, [scenario.steps])
  const [phValues, setPhValues] = useState<Record<string, string>>({})
  // 러너가 기억하는 작업 디렉토리 — cd 스텝 이후 후속 명령 앞에 `cd <cwd> &&` 로 붙인다.
  const cwdRef = useRef('')

  const targetName = sessions.find((s) => s.id === targetId)?.name ?? '(세션 없음)'
  const setRes = (idx: number, patch: Partial<StepResult>) =>
    setResults((prev) => ({ ...prev, [idx]: { ...prev[idx], ...patch } as StepResult }))
  const toggleExpand = (idx: number) =>
    setExpanded((s) => {
      const n = new Set(s)
      if (n.has(idx)) n.delete(idx)
      else n.add(idx)
      return n
    })

  const runStep = async (idx: number) => {
    const step = scenario.steps[idx]
    if (!step.command.trim() || !targetId) return
    const baseCmd = fillPlaceholders(step.command, phValues)
    // 값이 안 채워진 <...> 가 남아 있으면 실행하지 않고 안내 — 잘못된 명령이 나가는 것을 방지.
    if (hasUnfilled(baseCmd)) {
      setRes(idx, {
        status: 'error',
        err: `입력값이 필요합니다: ${extractPlaceholders(baseCmd).map((p) => `<${p}>`).join(', ')}\n상단 '검증 입력값'에 값을 채운 뒤 다시 실행하세요.`,
      })
      setExpanded((s) => new Set(s).add(idx))
      return
    }
    // 기억해 둔 작업 디렉토리에서 실행 (각 exec 는 기본 홈에서 시작하므로 cd 를 앞에 붙임)
    const cwd = cwdRef.current
    const cmd = cwd ? `cd ${cwd} && ${baseCmd}` : baseCmd
    setRes(idx, { status: 'running', manual: undefined })
    // 블로킹/대기성 명령(curl 무응답, tail -f 등)이 session:run 을 영영 반환하지 않아
    // 스피너가 무한 회전하는 것을 막기 위해 타임아웃을 건다(서버측 실행은 계속될 수 있음).
    const r = await Promise.race([
      window.electronAPI.sessionRun(targetId, cmd),
      new Promise<{ ok: false; error: string }>((resolve) =>
        setTimeout(
          () =>
            resolve({
              ok: false,
              error: `응답 시간 초과(${RUN_TIMEOUT_MS / 1000}초) — 블로킹/대기성 명령이거나 대상이 응답하지 않아 자동 중단했습니다. 이 스텝은 터미널에서 직접 확인 후 수동 판정하세요.`,
            }),
          RUN_TIMEOUT_MS,
        ),
      ),
    ])
    if (!r.ok) {
      setRes(idx, { status: 'error', err: r.error })
      setExpanded((s) => new Set(s).add(idx))
      return
    }
    const j = judgeOutput(r.out, r.err, r.code, step.check)
    setRes(idx, {
      status: 'ran',
      out: r.out,
      err: r.err,
      code: r.code,
      verdict: j.verdict,
      reasons: j.reasons,
    })
    // 이 스텝이 cd 를 포함했다면 작업 디렉토리를 갱신해 다음 스텝에 이어지게 한다.
    if (r.code === 0) {
      const cd = extractCdTarget(baseCmd)
      if (cd) cwdRef.current = resolveCwd(cwd, cd)
    }
    if (j.verdict === 'fail') setExpanded((s) => new Set(s).add(idx))
  }

  const runAll = async () => {
    if (!targetId) return
    setBusy(true)
    cwdRef.current = '' // 새 전체 실행은 홈에서 시작
    let skipped = 0
    let manualSkipped = 0
    for (let i = 0; i < scenario.steps.length; i++) {
      const c = scenario.steps[i].command
      if (!c.trim()) continue
      // 사용자가 수동으로 통과/실패/건너뜀을 지정한 스텝은 그 결정을 존중해 자동 실행하지 않는다.
      if (results[i]?.manual) {
        manualSkipped++
        continue
      }
      if (hasUnfilled(fillPlaceholders(c, phValues))) {
        skipped++
        continue
      }
      await runStep(i)
    }
    setBusy(false)
    const parts: string[] = []
    if (manualSkipped) parts.push(`수동 지정 ${manualSkipped}개는 그대로 유지`)
    if (skipped) parts.push(`입력값 미지정 ${skipped}개 건너뜀 — 상단 '검증 입력값'을 채우고 다시 실행`)
    setNotice(parts.join(' · '))
  }

  const setManual = (idx: number, v: 'pass' | 'fail' | 'skip') =>
    setRes(idx, { manual: results[idx]?.manual === v ? undefined : v })

  const summary = useMemo(() => {
    let pass = 0, fail = 0, info = 0, skip = 0, waiting = 0, pending = 0
    scenario.steps.forEach((step, idx) => {
      const e = effectiveOf(step, results[idx])
      if (e === 'pass') pass++
      else if (e === 'fail') fail++
      else if (e === 'info') info++
      else if (e === 'skip') skip++
      else if (e === 'manual-wait') waiting++
      else pending++
    })
    return { pass, fail, info, skip, waiting, pending }
  }, [scenario.steps, results])

  const buildReport = (): string => {
    const now = new Date().toLocaleString('ko-KR', { hour12: false })
    const lines: string[] = []
    lines.push(`# 시나리오 검증 리포트: ${scenario.title}`)
    lines.push('')
    lines.push(`- 대상 세션: ${targetName}`)
    lines.push(`- 실행 시각: ${now}`)
    lines.push(
      `- 결과 요약: 정상 ${summary.pass} · 실패 ${summary.fail} · 실행됨 ${summary.info} · 건너뜀 ${summary.skip} · 수동대기 ${summary.waiting} · 미실행 ${summary.pending}`,
    )
    lines.push('')
    scenario.steps.forEach((step, idx) => {
      const r = results[idx]
      const e = effectiveOf(step, r)
      const meta = EFFECTIVE_META[e]
      lines.push(`## ${idx + 1}. ${step.title}  [${meta.label}${r?.manual ? ' (수동)' : ''}]`)
      if (step.command.trim()) lines.push('```\n$ ' + fillPlaceholders(step.command, phValues) + '\n```')
      if (r?.reasons?.length) lines.push(`- 판정 근거: ${r.reasons.join(', ')}`)
      if (typeof r?.code === 'number') lines.push(`- 종료 코드: ${r.code}`)
      const body = (r?.out || '') + (r?.err ? `\n[stderr]\n${r.err}` : '')
      if (body.trim()) {
        const trimmed = body.length > 2000 ? body.slice(0, 2000) + '\n…(생략)' : body
        lines.push('<details><summary>출력</summary>\n\n```\n' + trimmed + '\n```\n</details>')
      }
      lines.push('')
    })
    // 리포트 저장/복사/AI 전송 공통 출구 — 설정 ON 시 민감정보(비밀번호/토큰/키) 마스킹
    return maskForExport(lines.join('\n'))
  }

  const copyReport = async () => {
    try {
      await navigator.clipboard.writeText(buildReport())
      setNotice('리포트를 클립보드에 복사했습니다.')
    } catch {
      setNotice('클립보드 복사에 실패했습니다.')
    }
  }
  const saveReport = async () => {
    const r = await window.electronAPI.saveReport({
      defaultName: `검증리포트_${scenario.title}.md`.replace(/[\\/:*?"<>|]/g, '_'),
      content: buildReport(),
    })
    if (r.saved) setNotice(`저장됨: ${r.path}`)
    else if (r.error) setNotice(r.error)
  }
  const analyzeReport = () => {
    if (!onAnalyze) return
    const started = onAnalyze(
      `다음은 인프라 검증 시나리오 실행 리포트입니다. 실패/이상 항목을 중심으로 원인과 조치를 정리해 주세요.\n\n${buildReport()}`,
    )
    setNotice(started ? '' : 'AI가 이미 다른 응답을 생성하는 중입니다. 잠시 후 다시 시도하세요.')
  }

  const anyRun = Object.keys(results).length > 0

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-8" onClick={onClose}>
      <div
        className="flex h-[85vh] w-[1100px] max-w-[96vw] flex-col overflow-hidden rounded-lg border border-white/10 bg-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 헤더 */}
        <div className="flex items-center gap-2 border-b border-white/10 px-4 py-2.5">
          <ListChecks size={16} className="text-blue-400" />
          <span className="truncate text-sm font-semibold text-gray-100">시나리오 검증 · {scenario.title}</span>
          <button onClick={onClose} className="ml-auto rounded p-1 text-gray-400 hover:bg-white/10 hover:text-gray-200">
            <X size={16} />
          </button>
        </div>

        {/* 실행 바 */}
        <div className="flex flex-wrap items-center gap-2 border-b border-white/10 px-4 py-2">
          <span className="text-[11px] text-gray-400">대상</span>
          <select
            value={targetId}
            onChange={(e) => setTargetId(e.target.value)}
            disabled={busy || sessions.length === 0}
            className="rounded border border-white/10 bg-panel-light px-2 py-1 text-[12px] text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50"
          >
            {sessions.length === 0 && <option value="">연결된 세션 없음</option>}
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <button
            onClick={runAll}
            disabled={busy || !targetId}
            className="flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50"
          >
            {busy ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />} 전체 실행
          </button>

          {/* 요약 */}
          {anyRun && (
            <div className="flex items-center gap-1.5 text-[11px]">
              <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-emerald-300">정상 {summary.pass}</span>
              <span className="rounded bg-red-500/15 px-1.5 py-0.5 text-red-300">실패 {summary.fail}</span>
              {summary.info > 0 && (
                <span className="flex items-center gap-0.5 text-emerald-300/70">
                  <Info size={11} /> 실행됨 {summary.info}
                </span>
              )}
              {summary.waiting > 0 && <span className="text-sky-300">수동대기 {summary.waiting}</span>}
            </div>
          )}

          {/* 리포트 액션 */}
          <div className="ml-auto flex items-center gap-1.5">
            {onAnalyze && (
              <button
                onClick={analyzeReport}
                disabled={!anyRun}
                title="리포트를 AI로 분석"
                className="flex items-center gap-1 rounded-md border border-white/10 bg-panel-light px-2 py-1 text-xs text-gray-200 hover:bg-white/10 disabled:opacity-40"
              >
                <ScanText size={13} className="text-blue-300" /> AI 분석
              </button>
            )}
            <button
              onClick={copyReport}
              disabled={!anyRun}
              className="flex items-center gap-1 rounded-md border border-white/10 bg-panel-light px-2 py-1 text-xs text-gray-200 hover:bg-white/10 disabled:opacity-40"
            >
              <ClipboardCopy size={13} /> 복사
            </button>
            <button
              onClick={saveReport}
              disabled={!anyRun}
              className="flex items-center gap-1 rounded-md border border-white/10 bg-panel-light px-2 py-1 text-xs text-gray-200 hover:bg-white/10 disabled:opacity-40"
            >
              <Save size={13} /> 저장
            </button>
          </div>
        </div>
        {notice && <div className="bg-blue-500/10 px-4 py-1 text-[11px] text-blue-200">{notice}</div>}

        {/* 검증 입력값 — <...> 플레이스홀더 값을 실행 전에 한 번 받아 모든 스텝에 치환 */}
        {allPlaceholders.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-b border-white/10 bg-amber-500/5 px-4 py-2">
            <span className="text-[11px] font-medium text-amber-300">검증 입력값</span>
            {allPlaceholders.map((p) => (
              <label key={p} className="flex items-center gap-1 text-[11px] text-gray-400">
                <span className="font-mono text-amber-200/90">&lt;{p}&gt;</span>
                <input
                  value={phValues[p] ?? ''}
                  onChange={(e) => setPhValues((v) => ({ ...v, [p]: e.target.value }))}
                  placeholder="값 입력"
                  className="w-40 rounded border border-white/10 bg-panel-light px-2 py-0.5 text-[11px] text-gray-100 outline-none placeholder:text-gray-600 focus:ring-1 focus:ring-amber-500"
                />
              </label>
            ))}
            <span className="text-[10px] text-gray-500">값을 채워야 해당 스텝이 자동 실행됩니다.</span>
          </div>
        )}

        {/* 스텝 목록 */}
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          <ul className="space-y-1.5">
            {scenario.steps.map((step, idx) => {
              const r = results[idx]
              const e = effectiveOf(step, r)
              const meta = EFFECTIVE_META[e]
              const isCmd = !!step.command.trim()
              const open = expanded.has(idx)
              const body = (r?.out || '') + (r?.err ? `\n[stderr]\n${r.err}` : '')
              return (
                <li key={idx} className="overflow-hidden rounded-md border border-white/10">
                  <div className="flex items-center gap-2 bg-panel-light px-2.5 py-1.5">
                    <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-blue-600/40 text-[11px] font-semibold text-blue-100">
                      {idx + 1}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-medium text-gray-100">{step.title}</div>
                      {isCmd ? (
                        <code className="block truncate font-mono text-[10px] text-pink-200/80">{step.command}</code>
                      ) : (
                        <span className="text-[10px] text-gray-500">안내 스텝 (수동 확인)</span>
                      )}
                    </div>

                    {r?.status === 'running' ? (
                      <Loader2 size={14} className="shrink-0 animate-spin text-gray-400" />
                    ) : r?.status === 'error' ? (
                      <span className="shrink-0 rounded bg-red-500/20 px-1.5 text-[10px] text-red-300">오류</span>
                    ) : (
                      <span className={'flex shrink-0 items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] font-medium ' + meta.cls}>
                        {e === 'info' && <Info size={10} />}
                        {meta.label}
                        {r?.manual ? ' ·수동' : ''}
                      </span>
                    )}

                    {/* 수동 판정 */}
                    <div className="flex shrink-0 items-center gap-0.5">
                      <button
                        onClick={() => setManual(idx, 'pass')}
                        title="수동: 통과"
                        className={
                          'rounded p-1 hover:bg-emerald-500/20 ' +
                          (r?.manual === 'pass' ? 'text-emerald-300' : 'text-gray-500')
                        }
                      >
                        <Check size={13} />
                      </button>
                      <button
                        onClick={() => setManual(idx, 'fail')}
                        title="수동: 실패"
                        className={
                          'rounded p-1 hover:bg-red-500/20 ' +
                          (r?.manual === 'fail' ? 'text-red-300' : 'text-gray-500')
                        }
                      >
                        <Ban size={13} />
                      </button>
                      <button
                        onClick={() => setManual(idx, 'skip')}
                        title="수동: 건너뜀"
                        className={
                          'rounded p-1 hover:bg-violet-500/20 ' +
                          (r?.manual === 'skip' ? 'text-violet-300' : 'text-gray-500')
                        }
                      >
                        <SkipForward size={13} />
                      </button>
                    </div>

                    {isCmd && (
                      <button
                        onClick={() => runStep(idx)}
                        disabled={busy || !targetId}
                        title="이 스텝만 실행"
                        className="flex shrink-0 items-center gap-1 rounded bg-blue-600/80 px-2 py-1 text-[11px] text-white hover:bg-blue-500 disabled:opacity-40"
                      >
                        <Play size={11} /> 실행
                      </button>
                    )}
                    {(body.trim() || r?.reasons?.length) && (
                      <button
                        onClick={() => toggleExpand(idx)}
                        className="shrink-0 rounded p-1 text-gray-400 hover:bg-white/10"
                      >
                        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      </button>
                    )}
                  </div>

                  {step.check && hasCheck(step.check) && (
                    <div className="border-t border-white/5 bg-black/10 px-2.5 py-1 text-[10px] text-gray-500">
                      판정 기준:
                      {step.check.failContains?.length ? ` 실패=[${step.check.failContains.join(', ')}]` : ''}
                      {step.check.passContains?.length ? ` 정상=[${step.check.passContains.join(', ')}]` : ''}
                      {step.check.passRegex ? ` 정규식=/${step.check.passRegex}/` : ''}
                      {step.check.requireExitZero ? ' exit0요구' : ''}
                    </div>
                  )}

                  {open && (
                    <div className="border-t border-white/5">
                      {r?.reasons?.length ? (
                        <div className="bg-black/20 px-3 py-1 text-[10px] text-gray-400">
                          판정 근거: {r.reasons.join(', ')}
                        </div>
                      ) : null}
                      <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-all bg-[#1e1e2e] px-3 py-2 font-mono text-[11px] text-gray-200">
                        {r?.status === 'error' ? `⚠ ${r.err}` : body.trim() || '(출력 없음)'}
                      </pre>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        </div>
      </div>
    </div>
  )
}
