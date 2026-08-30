import { useEffect, useMemo, useState } from 'react'
import { PRESETS } from '../presets'
import { extractPlaceholders, fillPlaceholders, hasPlaceholder } from '../lib/placeholder'
import { presetId, pushRecent, readFavorites, readRecents } from '../lib/presetFavorites'
import { riskyCommand } from '../lib/riskyCommand'
import type { CommandCheck, CustomPresetCommand } from '../../electron/shared-types'
import { SquareTerminal, X, Play, Loader2, ChevronDown, ChevronRight, Search, ScanText, Info, AlertTriangle, ListChecks, ShieldCheck } from 'lucide-react'
import { judgeOutput, verdictBadge, type Verdict } from '../lib/verdict'

export interface RunTarget {
  id: string
  name: string
}

interface MultiRunProps {
  sessions: RunTarget[]
  onClose: () => void
  /** 실행 결과 전체를 AI 패널로 보내 분석 (스트리밍 중이면 false 반환) */
  onAnalyze: (text: string) => boolean
}

interface Result {
  status: 'running' | 'done' | 'error'
  code?: number
  out?: string
  err?: string
  error?: string
}

/** 대소문자 구분 없이 일치하는 부분을 <mark>로 감싸 하이라이트 (특수문자 이스케이프 포함) */
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
 * 다중 호스트 명령 실행 — 명령 1개를 선택한 세션들에 동시 실행하고
 * 호스트별 종료코드/출력을 표 형태로 수집(인터랙티브 셸과 분리된 exec 채널).
 */
export default function MultiRun({ sessions, onClose, onAnalyze }: MultiRunProps) {
  const [cmd, setCmd] = useState('')
  const [analyzeNotice, setAnalyzeNotice] = useState('')
  const [targets, setTargets] = useState<Set<string>>(new Set(sessions.map((s) => s.id)))
  const [results, setResults] = useState<Record<string, Result>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [query, setQuery] = useState('')
  const [onlyFailed, setOnlyFailed] = useState(false)
  /**
   * 지금 명령의 판정 기준.
   *
   * 다중 실행은 원래 임의 명령을 돌리는 도구라 기준이 없었고, 그래서 초록 PASS 가 뜨지 않았다
   * (기준 없이 초록을 띄우지 않는 것이 이 앱의 규칙이다). 프리셋에서 골라 오면 그 프리셋에
   * 달린 기준을 함께 가져오므로, 여러 대를 한 번에 **검증**할 수 있게 된다.
   * 명령을 손으로 고치면 기준을 버린다 — 다른 명령의 기준으로 판정하면 안 된다.
   */
  const [check, setCheck] = useState<CommandCheck | null>(null)
  /** 프리셋에서 고른 경우 그 식별자 (최근 목록에 남기기 위해) */
  const [pickedId, setPickedId] = useState<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerQuery, setPickerQuery] = useState('')
  const [phValues, setPhValues] = useState<Record<string, string>>({})
  /** 위험 명령 확인 대기 — 확인을 눌러야 실제로 나간다 */
  const [confirmRun, setConfirmRun] = useState<{ cmd: string; hits: { what: string; why: string }[] } | null>(null)
  const [customPresets, setCustomPresets] = useState<CustomPresetCommand[]>([])
  useEffect(() => {
    window.electronAPI.customPresetsList().then(setCustomPresets).catch(() => undefined)
  }, [])

  /** 내장 + 사용자 정의를 한 목록으로 — 다중 실행에서는 순서보다 검색이 중요하다 */
  const allPresets = useMemo(() => {
    const built = PRESETS.flatMap((g) =>
      g.subgroups.flatMap((sg) =>
        sg.commands
          .filter((c) => !c.info) // 안내 문구 항목은 실행할 명령이 아니다
          .map((c) => ({ solution: g.solution, subgroup: sg.name, label: c.label, command: c.command, check: c.check })),
      ),
    )
    const custom = customPresets.map((c) => ({
      solution: c.solution,
      subgroup: c.subgroup,
      label: c.label,
      command: c.command,
      check: c.check,
    }))
    return [...built, ...custom]
  }, [customPresets])

  const favIds = useMemo(() => new Set(readFavorites()), [pickerOpen])
  const recentIds = useMemo(() => readRecents(), [pickerOpen])
  const pickerList = useMemo(() => {
    const q = pickerQuery.trim().toLowerCase()
    if (q)
      return allPresets
        .filter((c) => c.label.toLowerCase().includes(q) || c.command.toLowerCase().includes(q))
        .slice(0, 60)
    // 검색 전에는 별을 단 것과 최근 것만 — 184개를 그냥 쏟아 놓으면 고르는 데 더 걸린다
    const byId = new Map(allPresets.map((c) => [presetId(c.solution, c.subgroup, c.command), c]))
    const picked: typeof allPresets = []
    for (const id of [...favIds, ...recentIds]) {
      const c = byId.get(id)
      if (c && !picked.includes(c)) picked.push(c)
    }
    return picked
  }, [allPresets, pickerQuery, favIds, recentIds])

  const choosePreset = (c: (typeof allPresets)[number]) => {
    setCmd(c.command)
    setCheck(c.check ?? null)
    setPickedId(presetId(c.solution, c.subgroup, c.command))
    setPhValues({})
    setPickerOpen(false)
    setPickerQuery('')
  }

  const placeholders = useMemo(() => (hasPlaceholder(cmd) ? extractPlaceholders(cmd) : []), [cmd])
  /** 값을 안 채운 자리는 원문(`<이름>`) 그대로 나간다 — 프리셋 패널과 같은 규칙 */
  const finalCmd = useMemo(() => (placeholders.length ? fillPlaceholders(cmd, phValues) : cmd), [cmd, phValues, placeholders])

  const toggleTarget = (id: string) =>
    setTargets((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  const toggleExpand = (id: string) =>
    setExpanded((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })

  /** 실행 요청 — 위험한 명령이면 먼저 물어본다(대상 수만큼 파급이 커진다) */
  const requestRun = () => {
    if (!finalCmd.trim() || !targets.size) return
    const hits = riskyCommand(finalCmd)
    if (hits.length) {
      setConfirmRun({ cmd: finalCmd, hits })
      return
    }
    void run()
  }

  const run = async () => {
    const ids = sessions.filter((s) => targets.has(s.id)).map((s) => s.id)
    const cmdToRun = finalCmd
    if (!cmdToRun.trim() || !ids.length) return
    setConfirmRun(null)
    if (pickedId) pushRecent(pickedId) // 프리셋 패널의 '최근 실행' 과 같은 목록에 남는다
    setBusy(true)
    setResults(Object.fromEntries(ids.map((id) => [id, { status: 'running' as const }])))
    // 타임아웃이 없으면 `tail -f`·`top` 같은 블로킹 명령에서 스피너가 영원히 돌고
    // busy 가 true 로 고착돼 모달을 닫는 것 외에는 복구할 방법이 없다(시나리오 러너와 동일 정책).
    const RUN_TIMEOUT_MS = 45000
    await Promise.all(
      ids.map(async (id) => {
        const r = await Promise.race([
          window.electronAPI.sessionRun(id, cmdToRun),
          new Promise<{ ok: false; error: string }>((res) =>
            setTimeout(
              () => res({ ok: false, error: `${RUN_TIMEOUT_MS / 1000}초 내 응답이 없어 중단했습니다 (계속 실행되는 명령일 수 있습니다)` }),
              RUN_TIMEOUT_MS,
            ),
          ),
        ])
        setResults((prev) => ({
          ...prev,
          [id]: r.ok
            ? { status: 'done', code: r.code, out: r.out, err: r.err }
            : { status: 'error', error: r.error },
        }))
      }),
    )
    setBusy(false)
    setExpanded(new Set(ids)) // 결과는 기본 펼침
  }

  const nameOf = (id: string) => sessions.find((s) => s.id === id)?.name ?? id

  // 실행 결과 전체를 노드별로 묶어 AI 분석에 보냄 (노드 간 차이/이상 비교)
  const analyzeResults = () => {
    const entries = Object.entries(results)
    if (!entries.length) return
    const parts = entries.map(([id, r]) => {
      const body = r.error
        ? `⚠ ${r.error}`
        : `exit ${r.code}\n${(r.out || '') + (r.err ? `\n[stderr]\n${r.err}` : '')}`.trim()
      return `### 세션: ${nameOf(id)}\n$ ${cmd}\n${body || '(출력 없음)'}`
    })
    const text = `다음은 여러 노드에서 같은 명령 "${cmd}" 를 실행한 결과입니다. 노드 간 차이/이상 징후를 비교 분석해 주세요.\n\n${parts.join('\n\n')}`
    const started = onAnalyze(text)
    setAnalyzeNotice(started ? '' : 'AI가 이미 다른 응답을 생성하는 중입니다. 잠시 후 다시 시도하세요.')
  }

  const trimmedQuery = query.trim()
  // 자동 판정 — MultiRun 은 임의 명령을 직접 입력해 돌리는 도구라 명시적 기준(check)이 없으므로
  // 기본 판정(위험 키워드/종료코드)만 적용된다: 실패(빨강) 또는 정보(회색). 초록 PASS 는 뜨지 않음.
  const verdictOf = (r: Result): Verdict | null =>
    r.status === 'done' ? judgeOutput(r.out, r.err, r.code, check).verdict : null
  const isFailed = (r: Result) => r.status === 'error' || verdictOf(r) === 'fail'
  const summary = useMemo(() => {
    let fail = 0, info = 0, err = 0, pass = 0
    for (const r of Object.values(results)) {
      if (r.status === 'error') err++
      else if (r.status === 'done') {
        const v = judgeOutput(r.out, r.err, r.code, check).verdict
        if (v === 'fail') fail++
        else if (v === 'pass') pass++
        else info++
      }
    }
    return { fail, info, err, pass }
    // check 가 바뀌면 같은 결과라도 판정이 달라진다
  }, [results, check])
  const matchesQuery = (id: string, r: Result) => {
    if (!trimmedQuery) return true
    const q = trimmedQuery.toLowerCase()
    return (
      nameOf(id).toLowerCase().includes(q) ||
      (r.out ?? '').toLowerCase().includes(q) ||
      (r.err ?? '').toLowerCase().includes(q) ||
      (r.error ?? '').toLowerCase().includes(q)
    )
  }
  const filteredEntries = useMemo(
    () =>
      Object.entries(results).filter(
        ([id, r]) => (!onlyFailed || isFailed(r)) && matchesQuery(id, r),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [results, onlyFailed, trimmedQuery, sessions],
  )

  const targetNames = sessions.filter((s) => targets.has(s.id)).map((s) => s.name)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-8">
      {/*
        위험 명령 확인 — 다중 실행은 한 번의 클릭이 노드 수만큼 파급된다.
        무엇이 걸렸는지·왜 위험한지·**어디로 나가는지**를 함께 보여준다. 대상 목록이 없으면
        "설마 그 노드까지?" 를 실행하고 나서 알게 된다.
      */}
      {confirmRun && (
        <div className="absolute inset-0 z-[60] flex items-center justify-center bg-black/70 p-8">
          <div className="w-full max-w-lg rounded-lg border border-amber-500/40 bg-panel p-4 shadow-2xl">
            <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-amber-200">
              <AlertTriangle size={15} /> {targetNames.length}대에 한 번에 실행합니다
            </div>
            <div className="mb-2 space-y-1">
              {confirmRun.hits.map((h) => (
                <div key={h.what} className="text-[12px] text-amber-100">
                  <b>{h.what}</b> — <span className="text-amber-200/80">{h.why}</span>
                </div>
              ))}
            </div>
            <div className="mb-2 rounded bg-black/40 px-2.5 py-2">
              <div className="mb-1 text-[10.5px] text-gray-500">실행할 명령</div>
              <code className="block break-all font-mono text-[11.5px] text-green-300/90">{confirmRun.cmd}</code>
            </div>
            <div className="mb-3 rounded bg-black/30 px-2.5 py-2">
              <div className="mb-1 text-[10.5px] text-gray-500">대상 {targetNames.length}대</div>
              <div className="max-h-24 overflow-y-auto text-[11.5px] leading-relaxed text-gray-200">
                {targetNames.join(' · ')}
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setConfirmRun(null)}
                className="rounded-md border border-white/10 bg-panel-light px-3 py-1.5 text-xs text-gray-200 hover:bg-white/10"
              >
                취소
              </button>
              <button
                onClick={() => void run()}
                className="rounded-md bg-red-600/80 px-3 py-1.5 text-xs text-white hover:bg-red-500"
              >
                {targetNames.length}대에 실행
              </button>
            </div>
          </div>
        </div>
      )}
      <div
        className="flex h-[80vh] w-[1000px] max-w-[94vw] flex-col overflow-hidden rounded-lg border border-white/10 bg-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-white/10 px-4 py-2.5">
          <SquareTerminal size={16} className="text-blue-400" />
          <span className="text-sm font-semibold text-gray-100">다중 호스트 실행</span>
          {Object.keys(results).length > 0 && (
            <button
              onClick={analyzeResults}
              title="실행 결과 전체를 AI로 비교 분석"
              className="ml-auto flex items-center gap-1 rounded-md border border-white/10 bg-panel-light px-2 py-1 text-xs text-gray-200 hover:bg-white/10"
            >
              <ScanText size={14} className="text-blue-300" />
              AI 분석
            </button>
          )}
          <button
            onClick={onClose}
            className={
              (Object.keys(results).length > 0 ? '' : 'ml-auto ') +
              'rounded p-1 text-gray-400 hover:bg-white/10 hover:text-gray-200'
            }
          >
            <X size={16} />
          </button>
        </div>
        {analyzeNotice && (
          <div className="bg-amber-500/10 px-4 py-1 text-[11px] text-amber-300">{analyzeNotice}</div>
        )}

        {sessions.length === 0 ? (
          <div className="flex flex-1 items-center justify-center text-sm text-gray-500">
            연결된 세션이 없습니다. 먼저 SSH 연결하세요.
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            {/* 명령 + 대상 */}
            <div className="space-y-2 border-b border-white/10 p-3">
              <div className="relative flex gap-2">
                {/* 명령을 외우지 않아도 되게 — 프리셋에서 골라 오면 판정 기준까지 함께 온다 */}
                <button
                  onClick={() => setPickerOpen((v) => !v)}
                  title="프리셋에서 명령 고르기 (즐겨찾기·최근 먼저)"
                  className="flex shrink-0 items-center gap-1 rounded-md border border-white/10 bg-panel-light px-2.5 text-xs text-gray-200 hover:bg-white/10"
                >
                  <ListChecks size={14} className="text-blue-300" /> 프리셋
                </button>
                <input
                  value={cmd}
                  onChange={(e) => {
                    setCmd(e.target.value)
                    // 손으로 고친 명령에 옛 기준을 그대로 쓰면 다른 명령을 그 기준으로 판정하게 된다
                    setCheck(null)
                    setPickedId(null)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !busy) requestRun()
                  }}
                  placeholder="실행할 명령 (예: uptime, df -h, ceph -s) — 또는 왼쪽에서 프리셋 고르기"
                  className="flex-1 rounded-md border border-white/10 bg-panel-light px-2.5 py-1.5 font-mono text-sm text-gray-100 placeholder:text-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
                {pickerOpen && (
                  <div className="absolute left-0 top-full z-20 mt-1 max-h-72 w-[520px] overflow-y-auto rounded-md border border-white/15 bg-panel p-2 shadow-2xl">
                    <input
                      autoFocus
                      value={pickerQuery}
                      onChange={(e) => setPickerQuery(e.target.value)}
                      placeholder="프리셋 검색 (이름·명령어)"
                      className="mb-1.5 w-full rounded border border-white/10 bg-panel-light px-2 py-1 text-[12px] text-gray-100 outline-none focus:border-blue-500/60"
                    />
                    {pickerList.length === 0 ? (
                      <p className="px-1 py-3 text-center text-[11.5px] leading-relaxed text-gray-500">
                        {pickerQuery.trim()
                          ? '일치하는 프리셋이 없습니다.'
                          : '프리셋 패널에서 별을 달아 두거나 한 번 실행하면 여기 먼저 나옵니다. 지금은 검색해서 고르세요.'}
                      </p>
                    ) : (
                      <div className="space-y-0.5">
                        {pickerList.map((c) => (
                          <button
                            key={presetId(c.solution, c.subgroup, c.command)}
                            onClick={() => choosePreset(c)}
                            className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left hover:bg-white/10"
                          >
                            <span className="shrink-0 text-[11.5px] text-gray-200">{c.label}</span>
                            <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-gray-500">{c.command}</span>
                            {c.check && (
                              <span className="shrink-0 rounded bg-emerald-500/15 px-1.5 text-[10px] text-emerald-300">판정 기준</span>
                            )}
                            <span className="shrink-0 text-[10px] text-gray-600">{c.solution}</span>
                          </button>
                        ))}
                      </div>
                    )}
                    <button
                      onClick={() => setPickerOpen(false)}
                      className="mt-1.5 w-full rounded border border-white/10 py-1 text-[11px] text-gray-400 hover:bg-white/5"
                    >
                      닫기
                    </button>
                  </div>
                )}
                <button
                  onClick={requestRun}
                  disabled={busy || !targets.size}
                  className="flex shrink-0 items-center gap-1.5 rounded-md bg-blue-600 px-3 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
                >
                  {busy ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />} 실행
                </button>
              </div>
              {(check || placeholders.length > 0 || riskyCommand(finalCmd).length > 0) && (
                <div className="space-y-1.5">
                  {check && (
                    <div className="flex items-center gap-1.5 text-[11px] text-emerald-300/90">
                      <ShieldCheck size={12} />
                      판정 기준이 함께 옵니다 — 기준을 만족한 노드는 <b>초록(정상)</b>으로 표시됩니다
                      <button
                        onClick={() => setCheck(null)}
                        className="ml-1 rounded border border-white/10 px-1.5 text-[10px] text-gray-400 hover:bg-white/10"
                      >
                        기준 빼기
                      </button>
                    </div>
                  )}
                  {placeholders.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-[11px] text-amber-300/90">값 입력:</span>
                      {placeholders.map((ph) => (
                        <span key={ph} className="flex items-center gap-1">
                          <span className="font-mono text-[10.5px] text-gray-500">{ph}</span>
                          <input
                            value={phValues[ph] ?? ''}
                            onChange={(e) => setPhValues((v) => ({ ...v, [ph]: e.target.value }))}
                            className="w-32 rounded border border-amber-500/40 bg-panel-light px-1.5 py-0.5 font-mono text-[11px] text-gray-100 outline-none focus:border-amber-400"
                          />
                        </span>
                      ))}
                      <span className="text-[10.5px] text-gray-500">비우면 원문 그대로 나갑니다</span>
                    </div>
                  )}
                  {riskyCommand(finalCmd).length > 0 && (
                    <div className="flex items-start gap-1.5 text-[11px] text-amber-300">
                      <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                      <span>
                        {riskyCommand(finalCmd).map((h) => h.what).join(' · ')} — 실행 전에 대상과 함께 한 번 더 확인합니다
                      </span>
                    </div>
                  )}
                </div>
              )}
              <div className="flex flex-wrap gap-1.5">
                {sessions.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => toggleTarget(s.id)}
                    className={
                      'rounded-full border px-2 py-0.5 text-[11px] ' +
                      (targets.has(s.id)
                        ? 'border-blue-500/50 bg-blue-600/20 text-blue-100'
                        : 'border-white/10 text-gray-400 hover:bg-white/5')
                    }
                  >
                    {s.name}
                  </button>
                ))}
              </div>
            </div>

            {/* 결과 검색/필터 */}
            {Object.keys(results).length > 0 && (
              <div className="flex items-center gap-2 border-b border-white/10 px-3 py-1.5">
                <Search size={12} className="shrink-0 text-gray-500" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="호스트명, 출력 내용 검색..."
                  className="min-w-0 flex-1 bg-transparent text-xs text-gray-200 outline-none placeholder:text-gray-600"
                />
                {/* 기준이 있을 때만 초록이 나온다 — 기준 없이 통과를 말하지 않는다(verdict.ts 규칙) */}
                {summary.pass > 0 && (
                  <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-emerald-300">정상 {summary.pass}</span>
                )}
                {(summary.fail > 0 || summary.err > 0) && (
                  <span className="shrink-0 rounded bg-red-500/15 px-1.5 py-0.5 text-[11px] font-medium text-red-300">
                    실패 {summary.fail + summary.err}
                  </span>
                )}
                {summary.info > 0 && (
                  <span className="shrink-0 flex items-center gap-0.5 text-[11px] text-emerald-300/70">
                    <Info size={11} /> 실행됨 {summary.info}
                  </span>
                )}
                <button
                  onClick={() => setOnlyFailed((v) => !v)}
                  className={
                    'shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium ' +
                    (onlyFailed ? 'bg-amber-500/30 text-amber-200' : 'text-gray-400 hover:bg-white/10')
                  }
                >
                  실패만
                </button>
                <span className="shrink-0 text-[11px] text-gray-500">
                  {filteredEntries.length}/{Object.keys(results).length}
                </span>
              </div>
            )}

            {/* 결과 표 */}
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {Object.keys(results).length === 0 ? (
                <div className="px-2 py-6 text-center text-xs text-gray-500">
                  명령을 입력하고 실행하면 호스트별 결과가 표시됩니다.
                </div>
              ) : filteredEntries.length === 0 ? (
                <div className="px-2 py-6 text-center text-xs text-gray-500">일치하는 결과가 없습니다.</div>
              ) : (
                <ul className="space-y-1">
                  {filteredEntries.map(([id, r]) => {
                    const open = expanded.has(id) || !!trimmedQuery
                    return (
                      <li key={id} className="overflow-hidden rounded-md border border-white/10">
                        <div
                          onClick={() => toggleExpand(id)}
                          className="flex cursor-pointer items-center gap-2 bg-panel-light px-2.5 py-1.5 text-xs hover:bg-white/5"
                        >
                          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                          <span className="flex-1 truncate font-medium text-gray-100">
                            {highlight(nameOf(id), trimmedQuery)}
                          </span>
                          {r.status === 'running' ? (
                            <Loader2 size={13} className="animate-spin text-gray-400" />
                          ) : r.status === 'error' ? (
                            <span className="rounded bg-red-500/20 px-1.5 text-[10px] text-red-300">오류</span>
                          ) : (
                            (() => {
                              const j = judgeOutput(r.out, r.err, r.code)
                              const b = verdictBadge(j.verdict)
                              return (
                                <>
                                  <span
                                    title={j.reasons.join(', ')}
                                    className={'flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] font-medium ' + b.cls}
                                  >
                                    {j.verdict === 'info' && <Info size={10} />}
                                    {b.label}
                                  </span>
                                  <span className="text-[10px] text-gray-500">exit {r.code}</span>
                                </>
                              )
                            })()
                          )}
                        </div>
                        {open && r.status !== 'running' && (
                          <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-all bg-[#1e1e2e] px-3 py-2 font-mono text-[11px] text-gray-200">
                            {highlight(
                              r.error
                                ? `⚠ ${r.error}`
                                : (r.out || '') + (r.err ? `\n[stderr]\n${r.err}` : '') || '(출력 없음)',
                              trimmedQuery,
                            )}
                          </pre>
                        )}
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
