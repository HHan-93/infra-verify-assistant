import { useEffect, useMemo, useState } from 'react'
import { Check, Clock, Download, FileText, Loader2, RefreshCw, Trash2, X } from 'lucide-react'
import type { ScenarioRunDetail, ScenarioRunSummary } from '../../electron/shared-types'
import {
  buildBundleHtml,
  buildBundleMd,
  countsText,
  durText,
  runStamp,
  sameScenario,
  stepGrid,
} from '../lib/scenarioReport'
import ConfirmDialog from './ConfirmDialog'

/**
 * 시나리오 검증 **이력**.
 *
 * 회차를 골라 한 리포트로 뽑는 창이다. 왜 이 창이 필요한가는 scenarioReport.ts 의 머리에
 * 적어 두었다 — 요약하면 "한 회차만 보면 실패 2건이 전부인데, 세 회차를 나란히 놓으면
 * 고쳐지지 않은 것과 그때만 그랬던 것이 갈린다".
 *
 * 목록은 요약(index.json)만 읽는다. 상세는 리포트를 뽑거나 격자를 그릴 때만 읽는다 —
 * 회차마다 리포트 원문이 붙어 있어 전부 읽으면 창이 느려진다.
 */

const DAY = 24 * 60 * 60 * 1000

/** 판정 표기 — 러너 화면과 같은 낱말 */
const LABEL: Record<string, string> = {
  pass: '정상',
  fail: '실패',
  info: '실행됨',
  skip: '건너뜀',
  'manual-wait': '수동',
  pending: '미실행',
  error: '오류',
}

function Badge({ n, kind }: { n: number; kind: 'pass' | 'fail' | 'error' | 'wait' | 'skip' | 'none' }) {
  if (!n) return null
  const cls =
    kind === 'pass'
      ? 'bg-emerald-500/20 text-emerald-300'
      : kind === 'fail' || kind === 'error'
        ? 'bg-red-500/25 text-red-300'
        : kind === 'wait'
          ? 'bg-sky-500/20 text-sky-300'
          : kind === 'skip'
            ? 'bg-violet-500/20 text-violet-300'
            : 'bg-white/10 text-gray-400'
  const label =
    kind === 'pass' ? '정상' : kind === 'fail' ? '실패' : kind === 'error' ? '실행오류' : kind === 'wait' ? '수동' : kind === 'skip' ? '건너뜀' : '미실행'
  return <span className={`rounded px-1.5 py-0.5 text-[9.5px] ${cls}`}>{`${label} ${n}`}</span>
}

export default function ScenarioHistoryModal({
  onClose,
  /** 열 때 이 시나리오만 걸러 보여준다 (패널에서 고른 것) */
  initialScenarioId,
}: {
  onClose: () => void
  initialScenarioId?: string
}) {
  const [list, setList] = useState<ScenarioRunSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [scenarioFilter, setScenarioFilter] = useState(initialScenarioId ?? '')
  const [query, setQuery] = useState('')
  const [onlyFail, setOnlyFail] = useState(false)
  const [recent7, setRecent7] = useState(false)
  const [confirmDel, setConfirmDel] = useState(false)
  const [busy, setBusy] = useState(false)
  /** 고른 회차의 상세 — 격자를 그리려면 필요하다 */
  const [details, setDetails] = useState<ScenarioRunDetail[]>([])

  const load = async () => {
    setLoading(true)
    const r = await window.electronAPI.scenarioRunsList()
    // 목록을 못 읽는 것과 '아직 없는 것' 은 다르다 — 손상된 목록을 빈 목록으로 보여주면
    // 사람이 '지워졌구나' 로 읽고, 다음 검증이 그 위에 덮어써 정말로 사라진다.
    if (!r.ok) setError(r.error ?? '이력을 읽지 못했습니다.')
    else setError('')
    setList(r.list)
    setLoading(false)
  }
  useEffect(() => {
    void load()
  }, [])

  const scenarios = useMemo(() => {
    const m = new Map<string, string>()
    for (const r of list) if (!m.has(r.scenarioId)) m.set(r.scenarioId, r.title)
    return [...m.entries()]
  }, [list])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const cut = Date.now() - 7 * DAY
    return list.filter((r) => {
      if (scenarioFilter && r.scenarioId !== scenarioFilter) return false
      if (onlyFail && r.counts.fail + r.counts.error === 0) return false
      if (recent7 && r.startedAt < cut) return false
      if (q && !(`${r.title} ${r.targets.join(' ')}`.toLowerCase().includes(q))) return false
      return true
    })
  }, [list, scenarioFilter, onlyFail, recent7, query])

  // 고른 회차가 바뀌면 상세를 읽어 격자를 다시 그린다
  useEffect(() => {
    const ids = [...picked]
    if (!ids.length) {
      setDetails([])
      return
    }
    let alive = true
    void window.electronAPI.scenarioRunsRead(ids).then((r) => {
      if (alive) setDetails(r.list)
    })
    return () => {
      alive = false
    }
  }, [picked])

  const toggle = (id: string) =>
    setPicked((p) => {
      const n = new Set(p)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })

  const grid = useMemo(
    () => (details.length > 1 && sameScenario(details) ? stepGrid([...details].sort((a, b) => a.startedAt - b.startedAt)) : []),
    [details],
  )
  const ordered = useMemo(() => [...details].sort((a, b) => a.startedAt - b.startedAt), [details])

  const fileBase = () => {
    const one = sameScenario(ordered) ? ordered[ordered.length - 1].title : '시나리오검증'
    return `검증묶음_${one}_${ordered.length}회차`.replace(/[\\/:*?"<>|]/g, '_')
  }

  const exportAs = async (kind: 'md' | 'html') => {
    if (!ordered.length) return
    setBusy(true)
    try {
      const content = kind === 'md' ? buildBundleMd(ordered) : buildBundleHtml(ordered)
      const r = await window.electronAPI.saveReport({ defaultName: `${fileBase()}.${kind}`, content })
      if (r.saved) setNotice(`저장됨: ${r.path}`)
      else if (r.error) setNotice(r.error)
    } finally {
      setBusy(false)
    }
  }

  const del = async () => {
    setConfirmDel(false)
    const ids = [...picked]
    const r = await window.electronAPI.scenarioRunsDelete(ids)
    if (!r.ok) {
      setNotice(r.error ?? '지우지 못했습니다.')
      return
    }
    setPicked(new Set())
    setNotice(`${ids.length}개 회차를 지웠습니다.`)
    await load()
  }

  return (
    // 배경 클릭으로 닫지 않는다 — 이 앱의 모든 모달이 같은 규칙이다(고른 회차가 날아간다)
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-6">
      <div className="flex h-full max-h-[720px] w-[1040px] max-w-[95vw] flex-col overflow-hidden rounded-lg border border-white/10 bg-panel shadow-2xl">
        {/* 머리 */}
        <div className="flex items-center gap-2 border-b border-white/10 px-3 py-2">
          <Clock size={13} className="shrink-0 text-gray-400" />
          <span className="text-[12.5px] font-semibold text-gray-100">시나리오 검증 이력</span>
          <span className="text-[10.5px] text-gray-600">
            회차 {list.length}개 · 90일 또는 200회차까지 보관
          </span>
          <button
            onClick={() => void load()}
            title="다시 읽기"
            className="ml-auto shrink-0 rounded p-1 text-gray-500 hover:bg-white/10 hover:text-gray-200"
          >
            <RefreshCw size={12} />
          </button>
          <button onClick={onClose} className="shrink-0 rounded p-1 text-gray-500 hover:bg-white/10 hover:text-gray-200">
            <X size={14} />
          </button>
        </div>

        {/* 걸러 보기 */}
        <div className="flex flex-wrap items-center gap-1.5 border-b border-white/[0.07] bg-white/[0.02] px-3 py-2">
          <select
            value={scenarioFilter}
            onChange={(e) => setScenarioFilter(e.target.value)}
            className="rounded border border-white/10 bg-panel-light px-1.5 py-1 text-[11px] text-gray-200"
          >
            <option value="">모든 시나리오</option>
            {scenarios.map(([id, title]) => (
              <option key={id} value={id}>
                {title}
              </option>
            ))}
          </select>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="시나리오 · 대상 검색"
            className="min-w-0 flex-1 rounded border border-white/10 bg-panel-light px-2 py-1 text-[11px] text-gray-100 outline-none focus:border-blue-500/60"
          />
          {(
            [
              ['실패 있는 것만', onlyFail, () => setOnlyFail((v) => !v)],
              ['최근 7일', recent7, () => setRecent7((v) => !v)],
            ] as const
          ).map(([label, on, fn]) => (
            <button
              key={label}
              onClick={fn}
              className={
                'shrink-0 rounded-full border px-2 py-0.5 text-[10px] transition ' +
                (on
                  ? 'border-blue-400/60 bg-blue-500/20 text-blue-100'
                  : 'border-white/15 bg-white/[0.04] text-gray-400 hover:border-white/30 hover:bg-white/10 hover:text-gray-100')
              }
            >
              {label}
            </button>
          ))}
        </div>

        {error && (
          <div className="border-b border-red-500/30 bg-red-500/10 px-3 py-1.5 text-[11px] text-red-200">
            {error} — 이력 파일이 손상되었을 수 있습니다. 지금 검증한 결과는 러너의 [저장]으로 남기세요.
          </div>
        )}
        {notice && (
          <div className="border-b border-white/10 bg-black/20 px-3 py-1.5 text-[11px] text-gray-300">{notice}</div>
        )}

        {/* 본문 */}
        <div className="flex min-h-0 flex-1">
          {/* 회차 목록 */}
          <div className="w-[560px] shrink-0 overflow-y-auto border-r border-white/[0.08]">
            {loading ? (
              <p className="flex items-center gap-2 p-4 text-[11.5px] text-gray-500">
                <Loader2 size={13} className="animate-spin" /> 이력을 읽는 중…
              </p>
            ) : filtered.length === 0 ? (
              <p className="p-4 text-[11.5px] leading-relaxed text-gray-500">
                {list.length === 0
                  ? '아직 이력이 없습니다. 시나리오를 한 번 검증하면 회차가 자동으로 남습니다.'
                  : '조건에 맞는 회차가 없습니다.'}
              </p>
            ) : (
              filtered.map((r) => {
                const on = picked.has(r.id)
                return (
                  <button
                    key={r.id}
                    onClick={() => toggle(r.id)}
                    className={
                      'flex w-full items-start gap-2.5 border-b border-white/[0.05] px-3 py-2 text-left hover:bg-white/[0.04] ' +
                      (on ? 'bg-blue-500/10' : '')
                    }
                  >
                    <span
                      className={
                        'mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border ' +
                        (on ? 'border-blue-500 bg-blue-600 text-white' : 'border-white/25')
                      }
                    >
                      {on && <Check size={9} />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12px] text-gray-100">{r.title}</span>
                      <span className="mt-0.5 block truncate text-[10px] text-gray-600">
                        {runStamp(r.startedAt)} · {durText(r.endedAt - r.startedAt)}
                        {r.targets.length ? ` · ${r.targets.join(' · ')}` : ''}
                      </span>
                      <span className="mt-1 flex flex-wrap items-center gap-1">
                        <Badge n={r.counts.pass} kind="pass" />
                        <Badge n={r.counts.fail} kind="fail" />
                        <Badge n={r.counts.error} kind="error" />
                        <Badge n={r.counts.waiting} kind="wait" />
                        <Badge n={r.counts.skip} kind="skip" />
                        <Badge n={r.counts.pending} kind="none" />
                        {/* 중단은 반드시 보인다 — 그 뒤 스텝은 정상도 실패도 아니다 */}
                        {r.stopped && (
                          <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[9.5px] text-amber-300">
                            {r.stoppedAt ? `${r.stoppedAt}번에서 중단` : '중단됨'}
                          </span>
                        )}
                        {r.compatShell && (
                          <span className="rounded bg-white/10 px-1.5 py-0.5 text-[9.5px] text-gray-400">호환 모드</span>
                        )}
                      </span>
                    </span>
                  </button>
                )
              })
            )}
          </div>

          {/* 고른 것 미리보기 */}
          <div className="min-w-0 flex-1 overflow-y-auto p-3">
            {ordered.length === 0 ? (
              <p className="text-[11.5px] leading-relaxed text-gray-500">
                왼쪽에서 회차를 고르세요.
                <br />
                <span className="text-[11px] text-gray-600">
                  같은 시나리오를 <span className="text-gray-400">둘 이상</span> 고르면 스텝별 추이 표가 여기 나오고,
                  그 표가 묶음 리포트의 첫 장에 들어갑니다.
                </span>
              </p>
            ) : (
              <>
                <div className="mb-2 text-[11.5px] font-medium text-gray-200">골라 놓은 {ordered.length}회차</div>
                <div className="mb-2 text-[10.5px] leading-relaxed text-gray-500">
                  {sameScenario(ordered) ? (
                    <>
                      시나리오 <span className="text-gray-300">{ordered[0].title}</span> ·{' '}
                      {runStamp(ordered[0].startedAt)} ~ {runStamp(ordered[ordered.length - 1].startedAt)}
                    </>
                  ) : (
                    <>
                      서로 다른 시나리오가 섞여 있습니다 — 회차별 요약만 나옵니다(스텝 추이는 같은 시나리오끼리만
                      뜻이 있습니다).
                    </>
                  )}
                </div>

                {/* 회차별 요약 */}
                <table className="w-full border-collapse text-[10.5px]">
                  <tbody>
                    {ordered.map((r) => (
                      <tr key={r.id} className="border-b border-white/[0.06]">
                        <td className="py-1 pr-2 text-gray-400">{runStamp(r.startedAt)}</td>
                        <td className="py-1 pr-2 text-gray-500">{countsText(r.counts)}</td>
                        <td className="py-1 text-right text-gray-600">{durText(r.endedAt - r.startedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                {grid.length > 0 && (
                  <>
                    <div className="mb-1 mt-3 text-[11.5px] font-medium text-gray-200">스텝별 추이</div>
                    <div className="overflow-x-auto">
                      <table className="w-full border-collapse text-[10.5px]">
                        <thead>
                          <tr>
                            <th className="border-b border-white/10 py-1 pr-2 text-left font-medium text-gray-500">
                              스텝
                            </th>
                            {ordered.map((r) => (
                              <th
                                key={r.id}
                                className="border-b border-white/10 px-1.5 py-1 text-left font-medium text-gray-500"
                              >
                                {runStamp(r.startedAt).slice(5)}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {grid.map((row) => {
                            const allBad = row.cells.every((c) => c && (c.effective === 'fail' || c.effective === 'error'))
                            return (
                              <tr key={row.title} className="border-b border-white/[0.05]">
                                <td className={'py-1 pr-2 ' + (allBad ? 'text-red-200' : 'text-gray-300')}>
                                  {row.title}
                                </td>
                                {row.cells.map((c, i) => (
                                  <td
                                    key={i}
                                    className={
                                      'px-1.5 py-1 ' +
                                      (!c
                                        ? 'text-gray-700'
                                        : c.effective === 'fail' || c.effective === 'error'
                                          ? 'text-red-300'
                                          : c.effective === 'pass'
                                            ? 'text-emerald-300/90'
                                            : 'text-gray-500')
                                    }
                                  >
                                    {c ? LABEL[c.effective] : '—'}
                                  </td>
                                ))}
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                    {grid.some((row) => row.cells.every((c) => c && (c.effective === 'fail' || c.effective === 'error'))) && (
                      <p className="mt-1.5 rounded border border-red-500/30 bg-red-500/10 px-2 py-1.5 text-[10.5px] leading-relaxed text-red-100">
                        <b>모든 회차에서 실패한 스텝이 있습니다</b> — 회차를 거듭해도 같은 곳에서 실패한다는 뜻입니다.
                        리포트 첫 장에 그대로 올라갑니다.
                      </p>
                    )}
                    <p className="mt-1.5 text-[10px] leading-relaxed text-gray-600">
                      칸이 <span className="text-gray-500">—</span> 인 것은 그 회차에 없던 스텝입니다(시나리오를 고친
                      뒤 돌렸을 때). 스텝은 번호가 아니라 <span className="text-gray-500">제목</span>으로 맞춥니다.
                    </p>
                  </>
                )}
              </>
            )}
          </div>
        </div>

        {/* 발 */}
        <div className="flex items-center gap-2 border-t border-white/10 bg-white/[0.02] px-3 py-2">
          <span className="mr-auto text-[11px] text-gray-500">
            {picked.size ? `${picked.size}개 선택` : '회차를 골라 리포트로 뽑습니다'}
          </span>
          <button
            onClick={() => setConfirmDel(true)}
            disabled={!picked.size || busy}
            className="flex items-center gap-1 rounded border border-white/15 bg-panel-light px-2 py-1 text-[11px] text-gray-300 hover:bg-white/10 disabled:opacity-40"
          >
            <Trash2 size={11} /> 회차 삭제
          </button>
          <button
            onClick={() => void exportAs('md')}
            disabled={!picked.size || busy}
            title="Markdown — 붙여넣기·이슈 등록·AI 분석에 쓰기 좋습니다"
            className="flex items-center gap-1 rounded border border-white/15 bg-panel-light px-2 py-1 text-[11px] text-gray-200 hover:bg-white/10 disabled:opacity-40"
          >
            <Download size={11} /> Markdown
          </button>
          <button
            onClick={() => void exportAs('html')}
            disabled={!picked.size || busy}
            title="한 파일 HTML — 그대로 첨부해 보낼 수 있습니다(외부 자원 없음, 인쇄용 밝은 배경)"
            className="flex items-center gap-1 rounded border border-blue-500/40 bg-blue-600/25 px-2.5 py-1 text-[11px] text-blue-100 hover:bg-blue-600/40 disabled:opacity-40"
          >
            <FileText size={11} /> 묶음 리포트 (HTML)
          </button>
        </div>
      </div>

      {confirmDel && (
        <ConfirmDialog
          title="고른 회차를 지울까요?"
          message={
            `회차 ${picked.size}개를 지웁니다.\n\n` +
            [...picked]
              .map((id) => list.find((r) => r.id === id))
              .filter(Boolean)
              .map((r) => `· ${runStamp(r!.startedAt)} ${r!.title}`)
              .join('\n') +
            '\n\n검증은 대개 다시 돌릴 수 없습니다 — 지우기 전에 리포트로 뽑아 두세요.'
          }
          onCancel={() => setConfirmDel(false)}
          onConfirm={() => void del()}
        />
      )}
    </div>
  )
}
