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
import { episodes } from './portalPhases'

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
}

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
  const facts = v.facts.filter((f) => f.role !== 'pending' && f.role !== 'final')
  const firstAll = t.firstAll != null ? { at: t.firstAll, label: v.firstAll?.label ?? '1차 정상화: 모든 화면이 처음 모두 정상' } : v.firstAll
  const final = t.finalAll != null && t.pending.length === 0 && v.flaps.length ? { at: t.finalAll, label: FINAL_LABEL } : undefined
  if (final) facts.push({ at: final.at, label: final.label, role: 'final' })
  facts.sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity))
  const pending = t.pending.length ? t.pending.join(', ') : undefined
  if (pending) facts.push({ text: pending, label: '아직 안 돌아온 화면', role: 'pending' })
  const out: PortalEvView = { ...v, firstAll, final, pending, facts, pages: t.pages ? { ...t.pages, title: v.pages?.title ?? '화면별' } : v.pages }
  countFlaps(out)
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
export function compactStreak(tb: BoardEvidenceTable): BoardEvidenceTable | null {
  if (tb.columns[0] !== '핵심 API' || tb.rows[0]?.[0] !== '요청 시각') return null
  const lead = tb.columns[1] === '앞(실패)'
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
  return { title: tb.title, columns: [`핵심 API (${rows.length}개)`, '앞(실패)', '연속 통과', '응답 시간', '중앙값'], rows, cellTitles: titles, bad }
}
