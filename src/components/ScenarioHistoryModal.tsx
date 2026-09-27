import { useEffect, useMemo, useState } from 'react'
import { Check, Clock, Copy, Download, FileText, Loader2, Minus, RefreshCw, Trash2, X } from 'lucide-react'
import { formatShell } from '../lib/shellFormat'
import type { ScenarioRunDetail, ScenarioRunRetention, ScenarioRunSummary } from '../../electron/shared-types'
import {
  buildBundleHtml,
  buildBundleMd,
  defaultBundleTitle,
  durText,
  parseReportSteps,
  type StepBody,
  runStamp,
  runVerdict,
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

/**
 * **언제나 '모든 시나리오' 로 연다.**
 *
 * 전에는 패널에서 고른 시나리오로 걸러진 채 열었다. 그런데 그 시나리오를 아직 한 번도
 * 검증하지 않았으면 빈 목록이 나오고, 사람은 이력이 통째로 없는 줄 알았다(사용자 지적).
 * 이력을 여는 이유는 대개 '지금까지 뭘 했나' 를 보려는 것이므로 전체가 기본이 맞다.
 * 특정 시나리오만 보려면 드롭다운에서 고르면 된다.
 */
/** 회차 한 줄의 판정 — 리포트와 같은 규칙(runVerdict)을 쓴다. 창과 문서가 다른 말을 하면 안 된다 */
function VerdictPill({ r }: { r: ScenarioRunSummary }) {
  const v = runVerdict(r)
  const cls =
    v.key === 'pass'
      ? 'bg-emerald-500/20 text-emerald-300'
      : v.key === 'fail'
        ? 'bg-red-500/25 text-red-200'
        : 'bg-amber-500/20 text-amber-200'
  return (
    <span className={`whitespace-nowrap rounded px-1.5 py-0.5 text-[9.5px] font-medium ${cls}`}>{v.label}</span>
  )
}

/** 스텝 구성 막대 — 숫자를 세지 않아도 회차의 모양이 눈에 들어온다 */
function CountsBar({ c }: { c: ScenarioRunSummary['counts'] }) {
  const total = Math.max(1, c.pass + c.fail + c.info + c.skip + c.waiting + c.pending + c.error)
  const seg: [number, string][] = [
    [c.pass, 'bg-emerald-500'],
    [c.info, 'bg-emerald-500/40'],
    [c.fail, 'bg-red-500'],
    [c.error, 'bg-red-700'],
    [c.waiting, 'bg-amber-500'],
    [c.skip, 'bg-violet-400'],
    [c.pending, 'bg-white/20'],
  ]
  return (
    <span className="flex h-1.5 w-full overflow-hidden rounded-full bg-white/[0.07]">
      {seg.map(([n, cls], i) =>
        n ? <i key={i} className={cls} style={{ width: `${(n / total) * 100}%` }} /> : null,
      )}
    </span>
  )
}

export default function ScenarioHistoryModal({ onClose }: { onClose: () => void }) {
  const [list, setList] = useState<ScenarioRunSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [scenarioFilter, setScenarioFilter] = useState('')
  const [query, setQuery] = useState('')
  const [onlyFail, setOnlyFail] = useState(false)
  const [recent7, setRecent7] = useState(false)
  const [confirmDel, setConfirmDel] = useState(false)
  /**
   * 뽑기 전에 받는 **문서 제목.**
   *
   * '시나리오 검증 묶음 리포트' 는 우리가 붙인 이름이지 이 문서가 무엇인지가 아니다 —
   * 받는 사람에게는 'CONTRABASS V3.0.6 시나리오 수행' 같은 것이 제목이어야 한다. 우리가
   * 지을 수 없는 값이라 사람에게 묻고, 비워 두면 시나리오 이름으로 만든다.
   */
  const [exportAsk, setExportAsk] = useState<{ kind: 'md' | 'html'; title: string } | null>(null)
  const [busy, setBusy] = useState(false)
  /** 스텝 출력을 펼쳐 둔 번호 */
  const [openStep, setOpenStep] = useState<Set<number>>(new Set())
  /**
   * 방금 복사한 출력 칸 — `스텝번호:출력번호`.
   *
   * 한 스텝에 stdout·stderr 처럼 칸이 둘 이상일 수 있어 스텝 번호만으로는 어느 것을
   * 복사했는지 가릴 수 없다. 알림 문구 대신 그 자리에서 잠깐 '복사됨' 으로 바꾼다 —
   * 어느 칸을 담았는지가 버튼 위치로 드러나야 한다.
   */
  const [copiedOut, setCopiedOut] = useState<string | null>(null)
  const copyOutput = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopiedOut(key)
      setTimeout(() => setCopiedOut((c) => (c === key ? null : c)), 1200)
    } catch {
      setNotice('클립보드 복사에 실패했습니다.')
    }
  }
  /** 고른 회차의 상세 — 격자를 그리려면 필요하다 */
  const [details, setDetails] = useState<ScenarioRunDetail[]>([])
  /**
   * 보관 한도(개수·기간). 머리의 문구를 눌러 연다.
   *
   * 값이 실제로 **회차를 지우는 기준**이라, 저장은 메인에서 범위를 묶고(10~2000회차 ·
   * 1~3650일) 설정 파일이 깨졌을 때는 정리를 아예 건너뛴다(main.ts 주석).
   */
  const [retention, setRetention] = useState<ScenarioRunRetention | null>(null)
  const [retOpen, setRetOpen] = useState(false)
  const [retDraft, setRetDraft] = useState({ maxRuns: '', retentionDays: '' })
  useEffect(() => {
    void window.electronAPI.scenarioRunsGetRetention().then((v) => {
      setRetention(v)
      setRetDraft({ maxRuns: String(v.maxRuns), retentionDays: String(v.retentionDays) })
    })
  }, [])
  const saveRetention = async () => {
    const r = await window.electronAPI.scenarioRunsSetRetention({
      maxRuns: Number(retDraft.maxRuns),
      retentionDays: Number(retDraft.retentionDays),
    })
    setRetention(r.settings)
    setRetDraft({ maxRuns: String(r.settings.maxRuns), retentionDays: String(r.settings.retentionDays) })
    setRetOpen(false)
    setNotice(`보관 한도를 ${r.settings.maxRuns}회차 · ${r.settings.retentionDays}일로 바꿨습니다.`)
  }

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

  /**
   * 거르기 드롭다운에 올릴 시나리오들.
   *
   * **고른 값에 해당하는 option 이 없으면 안 된다.** 없으면 브라우저가 첫 항목('모든
   * 시나리오')을 대신 보여줘서, 거르기가 걸린 줄 모른 채 빈 목록을 보게 된다. 지금은 기본이
   * 전체라 처음부터 그럴 일은 없지만, **창을 열어 둔 채 그 시나리오의 회차를 모두 지우면**
   * 같은 상태가 된다. 그래서 보호막은 남긴다.
   */
  const scenarios = useMemo(() => {
    const m = new Map<string, string>()
    if (scenarioFilter && !list.some((r) => r.scenarioId === scenarioFilter))
      m.set(scenarioFilter, `${scenarioFilter} (회차 없음)`)
    for (const r of list) if (!m.has(r.scenarioId)) m.set(r.scenarioId, r.title)
    return [...m.entries()]
  }, [list, scenarioFilter])

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

  /**
   * 지금 **보이는 것만** 고르고/푼다.
   *
   * 거르기를 걸어 둔 채 '전체'를 누르면 화면 밖의 회차까지 딸려 들어가기 쉽다 — 그래서
   * 대상은 filtered 다. 이미 고른 것 중 목록에 없는 것은 건드리지 않는다(여러 시나리오를
   * 거르기를 바꿔 가며 모으는 방식을 깨지 않기 위해서다).
   */
  const allShownPicked = filtered.length > 0 && filtered.every((r) => picked.has(r.id))
  /** 일부만 고른 상태 — 체크박스를 '가로줄' 로 보여 준다(전부도 아니고 없지도 않다) */
  const someShownPicked = !allShownPicked && filtered.some((r) => picked.has(r.id))
  const toggleAllShown = () =>
    setPicked((p) => {
      const n = new Set(p)
      for (const r of filtered) if (allShownPicked) n.delete(r.id)
        else n.add(r.id)
      return n
    })

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
  /**
   * 한 회차만 골랐을 때 그 회차의 **명령·출력.**
   *
   * 회차 요약에는 판정과 근거만 있어서 "무엇을 실행했고 무엇이 나왔나" 를 알 수 없다.
   * 리포트 원문에는 그게 다 들어 있으므로 거기서 꺼내 쓴다(parseReportSteps 주석 참고).
   */
  const bodies = useMemo<Map<number, StepBody>>(
    () => (ordered.length === 1 ? parseReportSteps(ordered[0].reportMd) : new Map()),
    [ordered],
  )
  // 고른 회차가 바뀌면 펼침도 접는다 — 다른 회차의 스텝이 펼쳐진 채 남지 않게
  useEffect(() => setOpenStep(new Set()), [ordered])

  /**
   * 고른 회차 중 **읽히지 않은 것.**
   *
   * 상세 파일이 없어졌으면(외부에서 지웠거나 보존에 밀렸거나) 조용히 빠진 채로 리포트가
   * 만들어진다 — 5개를 골랐는데 4개짜리 제출물이 나오고 어디에도 그 사실이 없다.
   */
  const missing = picked.size - details.length
  /**
   * 고른 회차 중 **지금 목록에 안 보이는 것.**
   *
   * 거르기를 바꿔도 고른 것은 남는다(그게 여러 시나리오를 묶는 방법이기도 하다). 다만
   * 화면에 체크 2개만 보이는데 리포트에 5회차가 들어가면 사람이 알 수 없으므로 짚어 준다.
   */
  const hiddenPicked = [...picked].filter((id) => !filtered.some((r) => r.id === id)).length

  /** 파일 이름 — 제목을 그대로 쓴다(파일서버에서 제목으로 찾게 된다). 경로에 못 쓰는 글자만 바꾼다 */
  const fileBase = (title: string) =>
    (title.trim() || defaultBundleTitle(ordered)).replace(/[\\/:*?"<>|]/g, '_').slice(0, 80)

  const exportAs = async (kind: 'md' | 'html', title: string) => {
    if (!ordered.length) return
    setBusy(true)
    try {
      const content =
        kind === 'md' ? buildBundleMd(ordered, { title }) : buildBundleHtml(ordered, { title })
      const r = await window.electronAPI.saveReport({ defaultName: `${fileBase(title)}.${kind}`, content })
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
      <div className="flex h-full max-h-[760px] w-[1280px] max-w-[96vw] flex-col overflow-hidden rounded-lg border border-white/10 bg-panel shadow-2xl">
        {/* 머리 */}
        <div className="flex items-center gap-2 border-b border-white/10 px-3 py-2">
          <Clock size={13} className="shrink-0 text-gray-400" />
          <span className="text-[12.5px] font-semibold text-gray-100">시나리오 검증 이력</span>
          <span className="text-[10.5px] text-gray-600">회차 {list.length}개</span>
          <button
            onClick={() => setRetOpen((v) => !v)}
            title="보관 한도를 바꿉니다 — 둘 중 하나라도 넘으면 오래된 회차부터 지워집니다"
            className="rounded border border-white/25 bg-white/[0.08] px-2 py-0.5 text-[10.5px] text-gray-200 hover:border-white/40 hover:bg-white/[0.14]"
          >
            {retention ? `${retention.retentionDays}일 · ${retention.maxRuns}회차까지 보관` : '보관 설정'}
          </button>
          <button
            onClick={() => void load()}
            title="다시 읽기"
            className="ml-auto shrink-0 rounded border border-white/15 p-1 text-gray-300 hover:border-white/35 hover:bg-white/10 hover:text-gray-100"
          >
            <RefreshCw size={12} />
          </button>
          <button
            onClick={onClose}
            className="shrink-0 rounded border border-white/15 p-1 text-gray-300 hover:border-white/35 hover:bg-white/10 hover:text-gray-100"
          >
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
                  : 'border-white/25 bg-white/[0.08] text-gray-200 hover:border-white/40 hover:bg-white/[0.14]')
              }
            >
              {label}
            </button>
          ))}
        </div>

        {retOpen && (
          <div className="flex flex-wrap items-center gap-2 border-b border-white/[0.07] bg-blue-500/[0.06] px-3 py-2 text-[11px] text-gray-300">
            <span className="text-gray-400">보관 한도</span>
            <label className="flex items-center gap-1">
              최근
              <input
                value={retDraft.retentionDays}
                onChange={(e) => setRetDraft((d) => ({ ...d, retentionDays: e.target.value.replace(/[^0-9]/g, '') }))}
                className="w-14 rounded border border-white/10 bg-panel-light px-1.5 py-0.5 text-right text-[11px] text-gray-100 outline-none focus:border-blue-500/60"
              />
              일
            </label>
            <label className="flex items-center gap-1">
              그리고 최대
              <input
                value={retDraft.maxRuns}
                onChange={(e) => setRetDraft((d) => ({ ...d, maxRuns: e.target.value.replace(/[^0-9]/g, '') }))}
                className="w-16 rounded border border-white/10 bg-panel-light px-1.5 py-0.5 text-right text-[11px] text-gray-100 outline-none focus:border-blue-500/60"
              />
              회차
            </label>
            <span className="text-[10.5px] text-gray-500">
              둘 중 하나라도 넘으면 오래된 회차부터 지워집니다 (1~3650일 · 10~2000회차)
            </span>
            <button
              onClick={() => void saveRetention()}
              className="ml-auto rounded border border-blue-400/50 bg-blue-500/20 px-2 py-0.5 text-blue-100 hover:bg-blue-500/30"
            >
              저장
            </button>
            <button
              onClick={() => {
                if (retention)
                  setRetDraft({ maxRuns: String(retention.maxRuns), retentionDays: String(retention.retentionDays) })
                setRetOpen(false)
              }}
              className="rounded border border-white/15 px-2 py-0.5 text-gray-400 hover:bg-white/10"
            >
              취소
            </button>
          </div>
        )}

        {error && (
          <div className="flex items-center gap-2 border-b border-red-500/30 bg-red-500/10 px-3 py-1.5 text-[11px] text-red-200">
            <span className="min-w-0 flex-1">
              {error} — 목록 파일이 손상되었을 수 있습니다. 회차 본문은 각자 파일로 남아 있으므로 되살릴 수 있습니다.
            </span>
            <button
              onClick={async () => {
                const r = await window.electronAPI.scenarioRunsRebuild()
                setNotice(r.ok ? `목록을 다시 만들었습니다 — 회차 ${r.count}개` : (r.error ?? '되살리지 못했습니다.'))
                if (r.ok) await load()
              }}
              className="shrink-0 rounded border border-red-300/40 bg-red-500/20 px-2 py-0.5 hover:bg-red-500/30"
            >
              목록 다시 만들기
            </button>
          </div>
        )}
        {notice && (
          <div className="border-b border-white/10 bg-black/20 px-3 py-1.5 text-[11px] text-gray-300">{notice}</div>
        )}

        {/* 본문 */}
        <div className="flex min-h-0 flex-1">
          {/* 회차 목록 */}
          {/* 왼쪽은 '고르는 곳' 이라 제목과 배지만 읽히면 된다 — 자리는 오른쪽에 준다 */}
          <div className="w-[372px] shrink-0 overflow-y-auto border-r border-white/[0.08]">
            {/*
              전체 선택은 **체크박스 열 맨 위**에 둔다. 거르기 줄 오른쪽 끝에 두었더니
              체크를 누르는 손과 멀어, 무엇을 고르는 버튼인지 눈에 붙지 않았다(사용자 지적).
              아래 줄들과 같은 세로줄에 서게 여백을 맞춘다.
            */}
            {!loading && filtered.length > 0 && (
              <button
                onClick={toggleAllShown}
                title="지금 목록에 보이는 회차를 모두 고릅니다 (거르기를 건 상태면 그 안에서만)"
                className="sticky top-0 z-10 flex w-full items-center gap-2.5 border-b border-white/[0.07] bg-panel px-3 py-1.5 text-left hover:bg-white/[0.04]"
              >
                <span
                  className={
                    'flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border ' +
                    (allShownPicked
                      ? 'border-blue-500 bg-blue-600 text-white'
                      : someShownPicked
                        ? 'border-blue-500/70 bg-blue-600/40 text-white'
                        : 'border-white/25')
                  }
                >
                  {allShownPicked ? <Check size={9} /> : someShownPicked ? <Minus size={9} /> : null}
                </span>
                <span className="text-[10.5px] font-medium text-gray-300">
                  {allShownPicked ? '전체 해제' : `전체 선택 (${filtered.length})`}
                </span>
                {picked.size > 0 && (
                  <span className="ml-auto text-[10.5px] text-gray-600">{picked.size}개 선택됨</span>
                )}
              </button>
            )}
            {loading ? (
              <p className="flex items-center gap-2 p-4 text-[11.5px] text-gray-500">
                <Loader2 size={13} className="animate-spin" /> 이력을 읽는 중…
              </p>
            ) : filtered.length === 0 ? (
              <p className="p-4 text-[11.5px] leading-relaxed text-gray-500">
                {/* 손상된 목록을 '아직 없습니다' 로 말하지 않는다 — 사람이 '지워졌구나' 로
                    읽고 넘어가면, 되살릴 수 있는 회차를 그냥 잃는다 */}
                {error
                  ? '목록을 읽지 못했습니다. 위의 [목록 다시 만들기] 를 눌러 보세요.'
                  : list.length === 0
                    ? '아직 이력이 없습니다. 시나리오를 한 번 검증하면 회차가 자동으로 남습니다.'
                    : scenarioFilter && !list.some((r) => r.scenarioId === scenarioFilter)
                      ? '이 시나리오는 아직 검증 회차가 없습니다.'
                      : '조건에 맞는 회차가 없습니다.'}
                {/* 걸러서 비어 있는 것이면 푸는 방법을 그 자리에 둔다 — 조건을 찾아 올라가게 두지 않는다 */}
                {!error && list.length > 0 && (scenarioFilter || query.trim() || onlyFail || recent7) && (
                  <button
                    onClick={() => {
                      setScenarioFilter('')
                      setQuery('')
                      setOnlyFail(false)
                      setRecent7(false)
                    }}
                    className="ml-1.5 rounded border border-white/15 px-1.5 py-0.5 text-[11px] text-gray-300 hover:bg-white/10"
                  >
                    거르기 지우고 전체 보기 ({list.length})
                  </button>
                )}
              </p>
            ) : (
              filtered.map((r) => {
                const on = picked.has(r.id)
                return (
                  <button
                    key={r.id}
                    onClick={() => toggle(r.id)}
                    className={
                      /*
                        고른 줄은 **얇은 왼쪽 띠**로 표시한다. 파란 배경을 깔았더니 여러 개를
                        골랐을 때 목록 절반이 파랗게 물들어, 정작 읽어야 할 제목·배지가 묻혔다
                        (사용자 지적). 띠는 세로로 훑을 때 더 빨리 세어지기도 한다.
                      */
                      'flex w-full items-start gap-2.5 border-b border-l-2 border-b-white/[0.05] px-3 py-2 text-left hover:bg-white/[0.04] ' +
                      (on ? 'border-l-blue-500/70 bg-blue-500/[0.04]' : 'border-l-transparent')
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

          {/*
            고른 것 미리보기 — **고른 개수에 따라 아래가 바뀐다.**

            하나만 골랐을 때 요약 한 줄만 보여주면 창이 비어 보이는데(사용자 지적), 그때
            정작 보고 싶은 것은 '그 회차에서 무엇이 돌았나' 다. 여러 개를 골랐을 때 보고 싶은
            것은 반대로 '회차끼리 무엇이 달라졌나' 라서, 같은 자리에 다른 표를 놓는다.
          */}
          <div className="min-w-0 flex-1 overflow-y-auto p-3">
            {ordered.length === 0 ? (
              /* 배경에 묻히는 회색 글씨 한 줄이었다 — 테두리를 둘러 '아직 비어 있다' 를 형태로 보여준다 */
              <div className="flex h-full items-center justify-center p-6">
                <div className="max-w-[420px] rounded-lg border border-dashed border-white/20 bg-white/[0.03] px-5 py-6 text-center">
                  <Clock size={20} className="mx-auto mb-2 text-gray-500" />
                  <p className="text-[13px] font-medium text-gray-200">왼쪽에서 회차를 고르세요</p>
                  <p className="mt-1.5 text-[11.5px] leading-relaxed text-gray-400">
                    <span className="text-gray-200">하나</span>를 고르면 그 회차의{' '}
                    <span className="text-gray-200">스텝 결과와 실제 출력</span>이 나오고,
                    <br />
                    <span className="text-gray-200">같은 시나리오 둘 이상</span>을 고르면{' '}
                    <span className="text-gray-200">스텝별 추이</span> 표가 나옵니다.
                  </p>
                </div>
              </div>
            ) : (
              <>
                <div className="mb-1.5 flex items-baseline gap-2">
                  <span className="shrink-0 text-[11.5px] font-medium text-gray-200">
                    고른 회차 {ordered.length}개
                  </span>
                  <span className="min-w-0 truncate text-[10.5px] text-gray-500">
                    {sameScenario(ordered)
                      ? ordered[0].title
                      : '서로 다른 시나리오가 섞여 있습니다 — 회차별 요약만 나옵니다'}
                  </span>
                </div>

                {/* 회차별 한 줄 — 판정 · 구성 · 소요를 같은 높이에서 읽는다 */}
                <table className="mb-3 w-full border-collapse text-[10.5px]">
                  <tbody>
                    {ordered.map((r) => (
                      <tr key={r.id} className="border-b border-white/[0.06]">
                        <td className="whitespace-nowrap py-1.5 pr-2 align-middle text-gray-400">
                          {runStamp(r.startedAt)}
                        </td>
                        {/* 시나리오가 섞여 있으면 시각만으로는 어느 회차인지 알 수 없다 */}
                        {!sameScenario(ordered) && (
                          <td className="py-1.5 pr-2 align-middle">
                            <span className="block max-w-[260px] truncate text-gray-300">{r.title}</span>
                          </td>
                        )}
                        <td className="py-1.5 pr-2 align-middle">
                          <VerdictPill r={r} />
                        </td>
                        <td className="py-1.5 pr-2 align-middle">
                          <span className="flex flex-wrap gap-1">
                            <Badge n={r.counts.pass} kind="pass" />
                            <Badge n={r.counts.fail} kind="fail" />
                            <Badge n={r.counts.error} kind="error" />
                            <Badge n={r.counts.waiting} kind="wait" />
                            <Badge n={r.counts.skip} kind="skip" />
                            <Badge n={r.counts.pending} kind="none" />
                          </span>
                        </td>
                        <td className="w-[104px] py-1.5 pr-2 align-middle">
                          <CountsBar c={r.counts} />
                        </td>
                        <td className="whitespace-nowrap py-1.5 text-right align-middle text-gray-600">
                          {durText(r.endedAt - r.startedAt)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                {ordered.length === 1 ? (
                  /* 한 회차 — 그 회차의 스텝 결과를 그대로 편다 */
                  <>
                    <div className="mb-1 text-[11.5px] font-medium text-gray-200">
                      스텝 결과
                      <span className="ml-1.5 text-[10.5px] font-normal text-gray-500">
                        이 회차에서 실제로 무엇이 돌았는지 · 대상 {ordered[0].targets.join(' · ') || '—'}
                      </span>
                    </div>
                    {ordered[0].steps.length === 0 ? (
                      <p className="text-[10.5px] text-gray-600">이 회차에는 스텝 기록이 없습니다.</p>
                    ) : (
                      /* table-fixed 다 — 칸 너비를 내용이 정하게 두면 안 된다.
                         기본(auto) 표는 각 칸이 원하는 너비를 재서 나눠 갖는데, 출력 칸에는 수십 줄짜리
                         터미널 출력이 들어 있어 "최대한 넓게" 를 요구한다. 그러면 남은 칸들이 최소 너비까지
                         눌려, 스텝 제목이 한 글자씩 끊기고 판정 배지가 세로로 서 버렸다(사용자 지적).
                         너비를 미리 못 박으면 출력을 펼치든 접든 앞 세 칸은 그대로 있는다. */
                      <table className="w-full table-fixed border-collapse text-[10.5px]">
                        <thead>
                          <tr>
                            <th className="w-7 border-b border-white/10 py-1 pr-2 text-right font-medium text-gray-500">
                              #
                            </th>
                            <th className="w-[150px] border-b border-white/10 py-1 pr-2 text-left font-medium text-gray-500">
                              스텝
                            </th>
                            <th className="w-[62px] border-b border-white/10 py-1 pr-2 text-left font-medium text-gray-500">
                              판정
                            </th>
                            <th className="border-b border-white/10 py-1 text-left font-medium text-gray-500">
                              실행한 명령 · 출력
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {ordered[0].steps.map((st) => {
                            const bad = st.effective === 'fail' || st.effective === 'error'
                            return (
                              <tr key={st.index} className="border-b border-white/[0.05]">
                                <td className="py-1 pr-2 text-right text-gray-600">{st.index + 1}</td>
                                {/* break-keep — 한국어는 낱말 중간에서 끊지 않는다.
                                    '강제 종료 후 자동 복구 확인' 이 '강제 종' / '료 후 자동' 으로 갈리면 읽기 어렵다 */}
                                <td
                                  className={
                                    'break-keep py-1 pr-2 align-top ' + (bad ? 'text-red-200' : 'text-gray-300')
                                  }
                                >
                                  {st.title}
                                </td>
                                <td className="py-1 pr-2 align-top">
                                  <span
                                    className={
                                      'inline-block whitespace-nowrap rounded px-1.5 py-0.5 text-[9.5px] ' +
                                      (bad
                                        ? 'bg-red-500/25 text-red-300'
                                        : st.effective === 'pass'
                                          ? 'bg-emerald-500/20 text-emerald-300'
                                          : st.effective === 'manual-wait'
                                            ? 'bg-sky-500/20 text-sky-300'
                                            : st.effective === 'skip'
                                              ? 'bg-violet-500/20 text-violet-300'
                                              : 'bg-white/10 text-gray-400')
                                    }
                                  >
                                    {LABEL[st.effective] ?? st.effective}
                                  </span>
                                </td>
                                <td className="py-1 align-top">
                                  {(() => {
                                    const b = bodies.get(st.index)
                                    const open = openStep.has(st.index)
                                    const outs = b?.outputs ?? []
                                    return (
                                      <>
                                        {b?.command ? (
                                          /* 칸 너비가 고정됐으니 명령도 그 폭에 맞춰 한 줄로 자른다
                                             (전문은 title 에 있다 — 마우스를 올리면 보인다) */
                                          <code
                                            title={formatShell(b.command)}
                                            className="block w-full truncate font-mono text-[10px] text-gray-300"
                                          >
                                            $ {b.command}
                                          </code>
                                        ) : (
                                          <span className="text-[10px] text-gray-600">명령 없음 (안내 단계)</span>
                                        )}
                                        <div className="mt-0.5 flex flex-wrap items-center gap-2">
                                          {outs.length > 0 && (
                                            <button
                                              onClick={() =>
                                                setOpenStep((o) => {
                                                  const n = new Set(o)
                                                  if (n.has(st.index)) n.delete(st.index)
                                                  else n.add(st.index)
                                                  return n
                                                })
                                              }
                                              className="text-[10px] text-blue-300/90 hover:text-blue-200"
                                            >
                                              {open ? '▾ 출력 접기' : `▸ 출력 보기 (${outs
                                                .reduce((a, o) => a + o.text.split('\n').length, 0)}줄)`}
                                            </button>
                                          )}
                                          {/* 판정 근거는 남기되 뒤로 내린다 — 근거를 지우면 왜 그 판정인지 알 수 없다 */}
                                          <span className="text-[10px] text-gray-600">
                                            {(st.reasons ?? []).join(' · ')}
                                          </span>
                                        </div>
                                        {open &&
                                          outs.map((o, oi) => {
                                            const ck = `${st.index}:${oi}`
                                            return (
                                              <div key={oi} className="relative mt-1">
                                                {outs.length > 1 && (
                                                  <div className="text-[10px] text-gray-500">{o.label}</div>
                                                )}
                                                {/* 복사 버튼은 pre 바깥에 둔다 — 안에 두면 출력을 스크롤할 때
                                                    같이 밀려 올라가 보이지 않는다. 여는 순간부터 늘 같은 자리다.
                                                    담는 것은 이 칸의 출력뿐이다. 명령·판정 근거까지 섞으면
                                                    로그 도구에 그대로 붙여 넣을 수 없다 — 그러려고 여는 칸이다. */}
                                                <button
                                                  onClick={() => copyOutput(ck, o.text)}
                                                  title="이 출력만 클립보드로"
                                                  className={
                                                    // 오른쪽을 조금 비운다 — 출력이 길면 pre 에 세로 스크롤막대가
                                                    // 생기는데, 딱 붙여 두면 버튼이 그 위를 덮는다
                                                    'absolute right-2.5 z-10 flex items-center gap-1 rounded border border-white/10 bg-panel/90 px-1.5 py-0.5 text-[9.5px] backdrop-blur-sm hover:bg-white/10 ' +
                                                    (outs.length > 1 ? 'top-[18px] ' : 'top-1 ') +
                                                    (copiedOut === ck ? 'text-emerald-300' : 'text-gray-400')
                                                  }
                                                >
                                                  {copiedOut === ck ? (
                                                    <>
                                                      <Check size={10} /> 복사됨
                                                    </>
                                                  ) : (
                                                    <>
                                                      <Copy size={10} /> 복사
                                                    </>
                                                  )}
                                                </button>
                                                {/* 오른쪽 여백은 버튼 자리다 — 없으면 첫 줄이 버튼 밑으로 들어가 가려진다 */}
                                                <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded border border-white/10 bg-black/30 py-1.5 pl-2 pr-16 font-mono text-[10px] leading-relaxed text-gray-300">
                                                  {o.text}
                                                </pre>
                                              </div>
                                            )
                                          })}
                                      </>
                                    )
                                  })()}
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    )}
                  </>
                ) : grid.length > 0 ? (
                  /* 같은 시나리오 여러 회차 — 스텝별 추이 */
                  <>
                    <div className="mb-1 text-[11.5px] font-medium text-gray-200">
                      스텝별 추이
                      <span className="ml-1.5 text-[10.5px] font-normal text-gray-500">
                        계속 실패하는 것과 그때만 그런 것을 가릅니다
                      </span>
                    </div>
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
                ) : (
                  <p className="text-[10.5px] leading-relaxed text-gray-600">
                    스텝별 추이는 <span className="text-gray-400">같은 시나리오</span>끼리만 뜻이 있어 그리지 않습니다.
                    리포트에는 위 요약과 회차별 상세가 그대로 들어갑니다.
                  </p>
                )}
              </>
            )}
          </div>
        </div>

        {/* 발 */}
        <div className="flex items-center gap-2 border-t border-white/10 bg-white/[0.02] px-3 py-2">
          <span className="mr-auto min-w-0 text-[11px] text-gray-500">
            {picked.size ? `${picked.size}개 선택` : '회차를 골라 리포트로 뽑습니다'}
            {missing > 0 && (
              <span className="ml-1.5 text-red-300">
                · {missing}개는 회차 파일을 읽지 못해 리포트에 들어가지 않습니다
              </span>
            )}
            {missing <= 0 && hiddenPicked > 0 && (
              <span className="ml-1.5 text-amber-300/90">· 그중 {hiddenPicked}개는 지금 목록에 안 보입니다</span>
            )}
          </span>
          <button
            onClick={() => setConfirmDel(true)}
            disabled={!picked.size || busy}
            className="flex items-center gap-1 rounded border border-white/15 bg-panel-light px-2 py-1 text-[11px] text-gray-300 hover:bg-white/10 disabled:opacity-40"
          >
            <Trash2 size={11} /> 회차 삭제
          </button>
          <button
            onClick={() => setExportAsk({ kind: 'md', title: defaultBundleTitle(ordered) })}
            disabled={!picked.size || busy}
            title="Markdown — 붙여넣기·이슈 등록·AI 분석에 쓰기 좋습니다"
            className="flex items-center gap-1 rounded border border-white/15 bg-panel-light px-2 py-1 text-[11px] text-gray-200 hover:bg-white/10 disabled:opacity-40"
          >
            <Download size={11} /> Markdown
          </button>
          <button
            onClick={() => setExportAsk({ kind: 'html', title: defaultBundleTitle(ordered) })}
            disabled={!picked.size || busy}
            title="한 파일 HTML — 그대로 첨부해 보낼 수 있습니다(외부 자원 없음, 인쇄용 밝은 배경)"
            className="flex items-center gap-1 rounded border border-blue-500/40 bg-blue-600/25 px-2.5 py-1 text-[11px] text-blue-100 hover:bg-blue-600/40 disabled:opacity-40"
          >
            <FileText size={11} /> 리포트 출력 (HTML)
          </button>
        </div>
      </div>

      {/* 제목 창 — 배경 클릭으로 닫지 않는다(적던 제목이 날아간다). 닫는 것은 취소뿐 */}
      {exportAsk && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-6">
          <div className="w-full max-w-md rounded-lg border border-white/10 bg-panel p-4 shadow-2xl">
            <div className="mb-1 text-sm font-semibold text-gray-100">리포트 제목</div>
            <p className="mb-2.5 text-[11.5px] leading-relaxed text-gray-400">
              문서 맨 위와 파일 이름에 그대로 들어갑니다. 무엇을 검증한 문서인지 적어 주세요.
            </p>
            <input
              autoFocus
              value={exportAsk.title}
              onChange={(e) => setExportAsk({ ...exportAsk, title: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  const a = exportAsk
                  setExportAsk(null)
                  void exportAs(a.kind, a.title)
                }
              }}
              placeholder="예: CONTRABASS V3.0.6 시나리오 수행"
              className="w-full rounded border border-white/10 bg-panel-light px-2 py-1.5 text-[12.5px] text-gray-100 outline-none focus:border-blue-500/60"
            />
            <p className="mt-1.5 text-[10.5px] text-gray-600">
              {ordered.length}회차 · {exportAsk.kind === 'html' ? '한 파일 HTML' : 'Markdown'} 으로 저장합니다.
              비워 두면 <span className="text-gray-400">{defaultBundleTitle(ordered)}</span> 로 들어갑니다.
            </p>
            <div className="mt-3 flex justify-end gap-2">
              <button
                onClick={() => setExportAsk(null)}
                className="rounded-md border border-white/10 bg-panel-light px-3 py-1.5 text-xs text-gray-200 hover:bg-white/10"
              >
                취소
              </button>
              <button
                onClick={() => {
                  const a = exportAsk
                  setExportAsk(null)
                  void exportAs(a.kind, a.title)
                }}
                className="rounded-md border border-blue-500/40 bg-blue-600/40 px-3 py-1.5 text-xs text-blue-50 hover:bg-blue-600/60"
              >
                저장
              </button>
            </div>
          </div>
        </div>
      )}

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
