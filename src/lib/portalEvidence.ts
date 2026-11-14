/**
 * 포털 증적(`portal` · '포털 응답 기록')을 읽기 좋게 나눈다 — 리포트와 툴 증적 창이 같은 구성을 쓴다(2026-11-07 사용자 결정, 목업 확인).
 *
 * 구성: 숫자 카드(최초 끊김 · 1차 정상화 · 다시 끊김 · 최종 정상화) → ① 일어난 순서 → ② 화면별 → ③ 연속 통과 기록 → ④ 원문.
 * 저장된 증적(facts 문구 · 표)에서 다시 뽑는다 — 이미 저장된 회차도 같은 모양으로 보이게. 그래서 문구 머리
 * ('최초 끊김' · '1차 정상화' · '다시 끊김' · '최종 정상화' · '아직 안 돌아온')가 바뀌면 여기도 같이 고쳐야 한다(StatusBoard addPortalEvent).
 *
 * 연속 통과 기록은 API 마다 한 줄로 줄인다(compactStreak). 화면에 붙는 API 는 대부분 핵심 API 라(사용자) 화면당 10개를 넘기도 하는데,
 * 요청마다 한 칸인 표는 11줄 × 12칸이 되고 연속 구간은 정의상 전부 ✓ 라 새로 알려 주는 것이 없다. 볼 것은 '바로 앞 실패에서 어느 API 가
 * 깨져 있었나' 와 응답 시간이다. 요청마다의 칸은 지우지 않고 접어 둔다(원문 근거).
 */
import type { BoardEvidenceItem, BoardEvidenceTable } from '../../electron/shared-types'
import { episodes, portalStreakTable, type PortalEvent } from './portalPhases'

export interface PortalFact {
  at: number
  label: string
}
export interface PortalStreak {
  /** 저장된 표(요청마다 한 칸) */
  tb: BoardEvidenceTable
  /** 1차 정상화를 채운 화면 · 최종 정상화를 만든 화면 · 그 밖 */
  role: 'first' | 'final' | ''
  compact: BoardEvidenceTable | null
}
export interface PortalEvView {
  first?: PortalFact
  firstAll?: PortalFact
  flaps: PortalFact[]
  /**
   * 1차 정상화 뒤 다시 끊긴 횟수 — 같은 순간 끊긴 화면은 한 번(portalPhases.flapsAfterFirst 와 같은 셈). 리포트 요약의 '1차 뒤 다시 끊김 3회' 와
   * 같은 숫자를 말해야 한다(코드 점검 11-07: 카드는 화면마다 세어 같은 회차를 5회로 적었다). 화면 수는 flapRows 로 따로 적는다
   */
  flapTimes: number
  /** 1차 정상화 뒤 다시 끊긴 화면 줄 수 */
  flapRows: number
  /** 다시 끊김이 있었던 회차의 최종 정상화(없으면 1차가 곧 최종이라 따로 두지 않는다) */
  final?: PortalFact
  pending?: string
  /** 일어난 순서 표에 그대로 둘 줄(시각순) */
  facts: { at?: number; text?: string; label: string; role: 'first' | 'firstAll' | 'flap' | 'final' | 'pending' | '' }[]
  pages?: BoardEvidenceTable
  streaks: PortalStreak[]
  /** 1차 정상화의 화면 수(문구 '4개 화면' · 옛 '4개 페이지') */
  screens: number | null
  /** 1차 · 최종 정상화를 이룬 화면별 근거(회차 이력의 판정 기록에서) — 없으면(옛 회차) streaks 로 그린다 */
  basis?: PortalBasis
}

/** 한 화면이 정상화를 확정한 근거 한 줄 — 1차 · 최종 정상화 근거 표의 행 */
export interface PortalBasisRow {
  name: string
  /** 연속 정상의 첫 성공 */
  firstOk: number
  /** 연속 기준을 채워 확정한 시각 */
  confirm?: number
  /** 연속 기준 횟수 */
  n?: number
  /** 요청마다 한 칸인 표 · API 마다 한 줄로 줄인 표 */
  tb: BoardEvidenceTable | null
  compact: BoardEvidenceTable | null
  /** 바로 앞(실패) 요청에서 깨져 있던 API — 화면을 끝까지 붙잡고 있던 것 */
  broken: string[]
  /** 연속 구간 응답 시간 중앙값(모든 핵심 API) */
  median: number | null
  apis: number
  /** 이 묶음에서 마지막으로 돌아온 화면(= 1차 · 최종 정상화를 만든 화면) */
  last: boolean
}
export interface PortalBasis {
  first: PortalBasisRow[]
  /** 1차 뒤 다시 끊긴 회차만 — 각 화면의 마지막 정상화 */
  final: PortalBasisRow[]
  /** 1차 · 최종 어디에도 안 쓰인 중간 정상화 */
  others: PortalBasisRow[]
}

const basisRow = (e: PortalEvent): PortalBasisRow => {
  const tb = portalStreakTable(e)
  const compact = tb ? compactStreak(tb) : null
  const lat = (e.streak ?? []).flatMap((p) => p.apis.filter((a) => a.ok && a.ms != null).map((a) => a.ms as number)).sort((a, b) => a - b)
  return {
    name: e.name,
    firstOk: e.at,
    confirm: e.confirmAt,
    n: e.n,
    tb,
    compact,
    broken: compact ? compact.rows.filter((r) => r[1].startsWith('✗')).map((r) => r[0]) : [],
    median: lat.length ? lat[Math.floor(lat.length / 2)] : null,
    apis: compact?.rows.length ?? 0,
    last: false,
  }
}

/**
 * 1차 · 최종 정상화의 화면별 근거(2026-11-09 사용자 요청, 목업): 예전엔 마지막에 돌아온 화면(1차 정상화를 '채운' 화면) 하나만 펼치고
 * 나머지 화면은 '그 밖의 정상화 확정 n건' 에 접혀, 요약의 '포털 정상화 4/4' 와 달리 근거가 흩어져 보였다.
 *  - 1차: 화면마다 1차 정상화 시각 이전의 마지막 정상화(그 순간 그 화면을 정상으로 만든 연속 구간)
 *  - 최종: 1차 뒤 다시 끊긴 회차만 — 화면마다 마지막 정상화
 * 판정 기록(회차 이력의 portalLog, 정상화마다 연속 구간 원본이 있다)에서 다시 만든다 — 증적에는 최근 8개 표만 남아 화면이 많거나 흔들림이
 * 길면 빠질 수 있었다. 연속 구간 원본이 없는 옛 회차는 null(예전 그림).
 */
export function portalBasis(log: PortalEvent[], firstAll: number | null, finalAll: number | null, flapsAfter: number): PortalBasis | null {
  const ups = log.filter((e) => e.kind === 'up' && e.streak?.length).sort((a, b) => a.at - b.at)
  if (!ups.length || firstAll == null) return null
  const latestBy = (until: number) => {
    const m = new Map<string, PortalEvent>()
    for (const e of ups) if (e.at <= until) m.set(e.name, e)
    return [...m.values()].sort((a, b) => a.at - b.at)
  }
  const mark = (rows: PortalBasisRow[]) => {
    const max = Math.max(...rows.map((r) => r.firstOk))
    return rows.map((r) => ({ ...r, last: r.firstOk === max }))
  }
  const firstEv = latestBy(firstAll)
  const finalEv = flapsAfter > 0 && finalAll != null ? latestBy(finalAll) : []
  const used = new Set([...firstEv, ...finalEv])
  return {
    first: mark(firstEv.map(basisRow)),
    final: finalEv.length ? mark(finalEv.map(basisRow)) : [],
    others: ups.filter((e) => !used.has(e)).map(basisRow),
  }
}

/** 목차 · 왼쪽 목록이 가리킬 자리가 있는지 */
export const hasFirstBasis = (v: PortalEvView) => !!v.basis?.first.length || v.streaks.some((x) => x.role === 'first')
export const hasFinalBasis = (v: PortalEvView) => !!v.basis?.final.length || v.streaks.some((x) => x.role === 'final')

export function portalEvidenceView(it: BoardEvidenceItem): PortalEvView {
  const v: PortalEvView = { flaps: [], flapTimes: 0, flapRows: 0, facts: [], streaks: [], screens: null }
  for (const f of it.facts ?? []) {
    const l = f.label
    let role: PortalEvView['facts'][number]['role'] = ''
    if (l.startsWith('최초 끊김') && f.at != null) (role = 'first'), (v.first = { at: f.at, label: l })
    else if (l.startsWith('1차 정상화') && f.at != null) {
      role = 'firstAll'
      v.firstAll = { at: f.at, label: l }
      const m = l.match(/(\d+)개 (화면|페이지)/)
      v.screens = m ? +m[1] : null
    } else if (l.startsWith('다시 끊김') && f.at != null) (role = 'flap'), v.flaps.push({ at: f.at, label: l })
    else if (l.startsWith('최종 정상화') && f.at != null) (role = 'final'), (v.final = { at: f.at, label: l })
    else if (l.startsWith('아직 안 돌아온')) (role = 'pending'), (v.pending = f.text ?? '')
    v.facts.push({ at: f.at, text: f.text, label: l, role })
  }
  v.flaps.sort((a, b) => a.at - b.at)
  v.pages = it.table
  countFlaps(v)
  for (const tb of it.tables ?? []) {
    const role = / · 1차 정상화를 채운 화면 · /.test(tb.title) ? 'first' : / · 최종 정상화 · /.test(tb.title) ? 'final' : ''
    v.streaks.push({ tb, role, compact: compactStreak(tb) })
  }
  return v
}

function countFlaps(v: PortalEvView): void {
  const after = v.flaps.filter((f) => v.firstAll == null || f.at > v.firstAll.at)
  v.flapRows = after.length
  v.flapTimes = episodes(after.map((f) => f.at))
}

/** 회차 이력에서 본 포털 결과 — 증적 문구보다 이것을 믿는다 */
export interface PortalRunTruth {
  pending: string[]
  firstAll: number | null
  finalAll: number | null
  /** 화면별 표를 이력으로 다시 만든 것(이력에 판정 기록이 있을 때) */
  pages?: BoardEvidenceTable
  /** 판정 기록(정상화마다 연속 구간 원본) — 1차 · 최종 정상화 근거를 화면별로 다시 만든다 */
  log?: PortalEvent[]
  /**
   * 이력의 다시 끊김(판정 기록으로 다시 맞춘 것, StatusBoard repairPortalRecord). 있으면 증적의 '다시 끊김' 줄을 이것으로 바꾼다 —
   * 최소화 버그로 굳은 증적은 다시 끊김을 빠뜨려, 타임라인은 3회 · 증적 목차는 2회처럼 같은 일을 다른 숫자로 말했다(11-10 8회차)
   */
  flaps?: { name: string; downAt: number }[]
}

const FINAL_LABEL = '최종 정상화: 그 뒤 다시 끊기지 않음'
/**
 * 미복구 여부 · 최종 정상화 · 화면별 표는 **회차 이력**으로 바로잡는다(코드 점검 11-07).
 * 증적은 판정이 바뀔 때마다 그 순간을 떠 둔 것이라, 예전 버전에서 미복구 목록보다 먼저 저장하던 순서 탓에(PortalPanel 주석,
 * 지금은 고쳐짐) 10-28 2회차는 마지막 화면이 돌아온 뒤에도 '인스턴스 목록: 아직 안 돌아온 화면' · 화면별 '미복구' 로 굳어 있었다.
 * 이력은 그 뒤에도 갱신돼 '모두 정상화 13:06:03' 이다 — 같은 리포트에서 요약은 정상화, 포털 카드는 미복구라고 말하게 된다.
 * 1차 정상화 시각은 증적 · 이력이 같은 계산(portalPhases)이라 이력 값을 쓴다.
 */
export function applyRunTruth(v: PortalEvView, t: PortalRunTruth): PortalEvView {
  let facts = v.facts.filter((f) => f.role !== 'pending' && f.role !== 'final')
  let flaps = v.flaps
  if (t.flaps) {
    flaps = t.flaps.map((f) => ({ at: f.downAt, label: `다시 끊김: ${f.name}` }))
    facts = [...facts.filter((f) => f.role !== 'flap'), ...flaps.map((f) => ({ ...f, role: 'flap' as const }))]
  }
  const firstAll = t.firstAll != null ? { at: t.firstAll, label: v.firstAll?.label ?? '1차 정상화: 모든 화면이 처음 모두 정상' } : v.firstAll
  const final = t.finalAll != null && t.pending.length === 0 && flaps.length ? { at: t.finalAll, label: FINAL_LABEL } : undefined
  if (final) facts.push({ at: final.at, label: final.label, role: 'final' })
  facts.sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity))
  const pending = t.pending.length ? t.pending.join(', ') : undefined
  if (pending) facts.push({ text: pending, label: '아직 안 돌아온 화면', role: 'pending' })
  const out: PortalEvView = { ...v, flaps, firstAll, final, pending, facts, pages: t.pages ? { ...t.pages, title: v.pages?.title ?? '화면별' } : v.pages }
  countFlaps(out)
  out.basis = t.log ? portalBasis(t.log, firstAll?.at ?? null, final?.at ?? null, out.flapTimes) ?? undefined : undefined
  return out
}

/** 처음 보여 줄 시각 — 최초 끊김(없으면 1차 정상화). 증적을 타임라인 순서에 놓을 때 쓴다 */
export const portalStartAt = (v: PortalEvView): number | null => v.first?.at ?? v.firstAll?.at ?? null

const msOf = (c: string): number | null => {
  const m = c.match(/(\d+)\s*ms/)
  return m ? +m[1] : null
}

/**
 * 요청마다 한 칸인 연속 통과 표 → API 마다 한 줄(앞(실패) · 연속 통과 · 응답 시간 범위 · 중앙값).
 * 표의 꼴(portalPhases.portalStreakTable): 열 = ['핵심 API', ('앞(실패)'), '1'…'n'], 첫 줄 = '요청 시각'. 꼴이 다르면 null(접지 않고 원래 표를 보인다).
 */
/**
 * 연속 통과 구간 바로 앞 요청 칸의 이름(2026-11-10 사용자 요청으로 '앞(실패)' 에서 바꿈). 그 요청은 화면으로는 실패지만 API 마다 보면
 * 정상인 것도 있어(✓ 1055ms) '실패' 라고 부르면 맞지 않았다 — 연속 정상이 시작되기 직전의 응답이다.
 */
export const LEAD_COL = '직전 응답'
export function compactStreak(tb: BoardEvidenceTable): BoardEvidenceTable | null {
  if (tb.columns[0] !== '핵심 API' || tb.rows[0]?.[0] !== '요청 시각') return null
  // 저장된 표는 옛 이름 '앞(실패)' 일 수 있다 — 둘 다 읽는다
  const lead = tb.columns[1] === '앞(실패)' || tb.columns[1] === LEAD_COL
  const from = lead ? 2 : 1
  const rows: string[][] = []
  const titles: string[][] = []
  const bad: boolean[] = []
  tb.rows.slice(1).forEach((r, k) => {
    // '-' 는 그 주기에 그 API 가 없었다는 뜻(portalStreakTable: '이 주기에 없음') — 실패가 아니므로 세지 않는다
    const cells = r.slice(from).filter((c) => c !== '-')
    const okN = cells.filter((c) => c.startsWith('✓')).length
    const ms = cells.map(msOf).filter((x): x is number => x != null).sort((a, b) => a - b)
    rows.push([
      r[0],
      lead ? r[1] : '-',
      `${okN === cells.length ? '✓' : '✗'} ${okN}/${cells.length}`,
      ms.length ? (ms[0] === ms[ms.length - 1] ? `${ms[0]}ms` : `${ms[0]} ~ ${ms[ms.length - 1]}ms`) : '-',
      ms.length ? `${ms[Math.floor(ms.length / 2)]}ms` : '-',
    ])
    titles.push(['', lead ? tb.cellTitles?.[k + 1]?.[1] ?? '' : '', '', '', ''])
    bad.push(okN !== cells.length)
  })
  return { title: tb.title, columns: [`핵심 API (${rows.length}개)`, LEAD_COL, '연속 통과', '응답 시간', '중앙값'], rows, cellTitles: titles, bad }
}
