/**
 * 포털 정상화의 두 기준 — 1차 정상화 · 최종 정상화(사용자 요청 10-28).
 *
 * 페일오버 뒤 포털은 한 번 다 돌아왔다가 failback · DB 전환으로 다시 끊기고, 몇 번 흔들린 뒤 자리를 잡는다. 예전 판정은 최종 정상화
 * (다시 끊기지 않은 마지막 정상화)만 '포털 서비스 정상화' 로 썼고, 처음 돌아온 시점은 '가장 먼저 돌아온 한 페이지' 로만 적었다.
 * 사용자가 원한 것은 둘 다다: 사용자가 처음으로 서비스를 다 쓸 수 있었던 때와, 흔들림이 끝나 안정된 때.
 *
 * 1차 정상화는 **감시 페이지가 모두 동시에 정상인 첫 순간**이다. '각 페이지가 처음 돌아온 시각 중 가장 늦은 것' 으로 잡으면
 * A 는 이미 다시 끊겼는데 B 가 돌아온 시각이 1차 정상화로 찍힌다 — 그 순간 서비스는 다 쓸 수 없었다.
 * 페이지마다 정상 구간을 만든다: 다시 끊긴 정상화는 [upAt, downAt), 최종 정상화는 [at, ∞).
 * 끊긴 적 없는 페이지는 기록이 없다(늘 정상) — 계산에서 빠지는 것이 맞다.
 */

export interface PortalPhaseInput {
  /** 대상별 최종 정상화 */
  portal: { at: number; name: string; streak?: number }[]
  /** 정상화됐다가 다시 끊긴 것 */
  portalFlaps?: { name: string; upAt: number; downAt: number }[]
  /** 끊긴 뒤 아직 안 돌아온 대상 */
  portalPending?: string[]
  /** 판정이 바뀐 순간(증적 원문) — 화면마다 첫 끊김 시각을 알려고. 없으면(옛 회차) 첫 끊김 전 구간을 모른다 */
  portalLog?: { name: string; kind: string; at: number }[]
  /** 장애 뒤 감시한 화면 전체(끊기지 않은 화면 포함) — 분모(total)용. 없으면(옛 회차) 끊긴 화면 수가 곧 분모 */
  portalWatched?: string[]
}

export interface PortalPhases {
  /** 끊긴 적 있는 페이지 수(기록에 나오는 페이지) — 판정(1차 · 최종 정상화)은 이 화면들로 한다 */
  pages: number
  /**
   * 감시한 화면 전체 수 · 그중 끊기지 않은 수(2026-11-14 사용자 지적: 화면 4개를 등록했는데 가끔 '3/3' 으로 보였다).
   * 끊기지 않은 화면은 판정 기록이 없어 pages 에서 빠진다 — 그 화면은 내내 정상이었으므로 1차 정상화 시각은 그대로 맞지만,
   * 분모가 3 이면 '4개 중 3개만 봤다' 로 읽힌다. 표시는 total 을 쓰고 끊기지 않은 수를 함께 밝힌다
   */
  total: number
  calm: number
  /** 감시 페이지가 모두 동시에 정상인 첫 순간 — 끝내 그런 순간이 없으면 null */
  firstAll: number | null
  /** 그 뒤 다시 끊기지 않은 최종 정상화(가장 늦게 확정된 페이지) — 미복구가 남았으면 null */
  finalAll: number | null
  /**
   * 1차 정상화 뒤에 다시 끊긴 횟수 — 같은 순간(SAME_MS 안에 이어서) 끊긴 페이지는 한 번으로 센다. 타임라인의 '포털 흔들림 n회' 와
   * 같은 셈이다(페이지 수로 세면 표는 4, 타임라인은 3 처럼 같은 일을 다른 숫자로 말했다).
   */
  flapsAfterFirst: number
  /** 다시 끊긴 횟수 전체 */
  flaps: number
}

/** 같은 사건으로 묶는 폭 — 상태보드 타임라인(SAME_EVENT_MS)과 같은 값. 포털 페이지들은 같은 폴링에서 끊겨도 ms 가 조금씩 다르다 */
export const SAME_MS = 2000
/** 시각들을 SAME_MS 안에 이어진 것끼리 묶었을 때의 묶음 수(포털 증적의 '다시 끊김' 카드도 같은 셈 — portalEvidence.ts) */
export function episodes(ts: number[]): number {
  const a = [...ts].sort((x, y) => x - y)
  let n = 0
  for (let i = 0; i < a.length; i++) if (i === 0 || a[i] - a[i - 1] > SAME_MS) n++
  return n
}

export function portalPhases(m: PortalPhaseInput): PortalPhases {
  const flaps = m.portalFlaps ?? []
  const pending = m.portalPending ?? []
  const names = Array.from(new Set([...m.portal.map((p) => p.name), ...flaps.map((f) => f.name), ...pending]))
  const spans = new Map<string, [number, number][]>()
  for (const n of names) spans.set(n, [])
  for (const f of flaps) spans.get(f.name)?.push([f.upAt, f.downAt])
  for (const p of m.portal) spans.get(p.name)?.push([p.at, Infinity])
  /*
   * 처음 끊기기 **전** 도 정상 구간이다(코드 점검 10-30). 이 구간이 없으면, A 가 돌아와 모든 화면이 정상이던 순간 뒤에 B 가 failback 때
   * 처음 끊기면 그 순간 B 를 '정상 아님' 으로 봐서 1차 정상화가 B 가 돌아온 때로 늦게 찍혔다 — 1차가 리포트의 포털 서비스 정상화가 되면서
   * (10-30) 최종과 같아져 버리는 일이었다. 첫 끊김은 증적 원문(portalLog)의 첫 'fail' 이고, 기록이 없는 옛 회차는 예전처럼 계산한다.
   */
  for (const n of names) {
    const firstFail = Math.min(...(m.portalLog ?? []).filter((e) => e.name === n && e.kind === 'fail').map((e) => e.at))
    if (!Number.isFinite(firstFail)) continue
    /*
     * 첫 끊김보다 **앞에서 시작한** 정상 구간은 정상화가 아니다 — 끊긴 적 없는 화면이 DOWN 뒤 N회 정상으로 '정상화' 가 찍히던 버그
     * (PortalPanel sinceDown 주석, 10-30)로 저장된 옛 회차를 바로잡는다. 그 구간은 위의 '첫 끊김 전' 구간과 같은 뜻이라 버린다.
     */
    const kept = (spans.get(n) ?? []).filter(([a]) => a >= firstFail)
    spans.set(n, [...kept, [-Infinity, firstFail]])
  }
  const upAt = (n: string, t: number) => (spans.get(n) ?? []).some(([a, b]) => a <= t && t < b)
  // 모두 정상인 순간은 반드시 어느 페이지가 돌아온 순간에 시작한다 — 그 후보들만 보면 된다
  // 첫 끊김 전 구간(-∞ 부터)은 후보에서 뺀다 — 아무것도 안 끊긴 때가 '정상화' 일 수는 없다
  const starts = Array.from(new Set([...spans.values()].flat().map(([a]) => a)))
    .filter((a) => Number.isFinite(a))
    .sort((a, b) => a - b)
  const firstAll = names.length ? (starts.find((t) => names.every((n) => upAt(n, t))) ?? null) : null
  const finalAll = names.length && !pending.length && m.portal.length ? Math.max(...m.portal.map((p) => p.at)) : null
  const total = new Set([...names, ...(m.portalWatched ?? [])]).size
  return {
    pages: names.length,
    total,
    calm: total - names.length,
    firstAll,
    finalAll,
    flapsAfterFirst: firstAll == null ? 0 : episodes(flaps.map((f) => f.downAt).filter((t) => t > firstAll)),
    flaps: flaps.length,
  }
}

/**
 * 판정 기록(portalLog)으로 화면별 최종 정상화 · 다시 끊김 · 안 돌아온 화면을 다시 만든다(2026-11-10 사용자 결정).
 *
 * 왜: 상태보드를 최소화하면 포털 감시가 내려갔다가 펼칠 때 새로 시작해 화면 상태를 잊었다(StatusBoard minChip 주석). 그 뒤 정상화됐던
 * 화면이 다시 끊기면 '다시 끊김(down)' 이 아니라 '처음 끊김(fail)' 으로 남아 portal(최종 정상화) 에서 거둬지지 않았고, 안 돌아온 화면도
 * portalPending 에 없었다 — 8회차(11-10 10:18)는 화면 3개가 끊긴 채 끝났는데 리포트는 전체 48분 06초 성공, 최종이 1차보다 이르게 나왔다.
 * 판정 기록은 그 순간마다 남은 원문이라, 화면마다 시각순으로 따라가면 실제 흐름이 나온다:
 *  - up: 정상 구간 시작(이미 정상이면 무시 — 처음 정상화 시각을 지킨다)
 *  - down, 또는 정상이던 화면의 fail: 다시 끊김(그 정상화는 portalFlaps 로)
 *  - fail(정상이 아니던 화면): 처음 끊김 — 상태만 '끊김'
 * 끝에 정상이면 portal, 끊김이면 portalPending. 감시를 놓친 구간(최소화 중)에 언제 끊겼는지는 알 수 없어, 다시 끊긴 시각은 다시 본 첫 실패다.
 * 판정 기록이 없는 옛 회차(2.13.8 전)는 null — 저장된 값을 그대로 쓴다.
 *
 * 다시 만들지 않는 경우(null — 저장된 값을 그대로 쓴다, 코드 리뷰 11-10):
 *  - 기록이 상한(maxLog)에 닿았다 — 그 뒤 사건은 기록에 없고 저장된 값은 계속 갱신됐으니 저장된 값이 더 맞다
 *  - 판단할 수 없는 화면이 있다: 마지막 기록이 '처음 끊김(fail)' 하나뿐인데 저장된 값은 안 돌아온 화면으로 보지 않는다. 최소화 중에
 *    돌아온 화면은 다시 펼친 뒤 정상이라 아무 기록도 남지 않는다 — 기록만 믿으면 '못 봄' 이 '장애' 가 된다(조회 실패 ≠ 장애).
 *    정상이던 화면의 fail · 같은 화면의 fail 되풀이는 다시 펼친 뒤에 본 실패라 판단할 수 있다.
 */
export function portalFromLog(m: PortalPhaseInput & { maxLog?: number; portal: { at: number; name: string; group?: string; streak?: number }[]; portalFlaps?: { name: string; group?: string; upAt: number; downAt: number }[] }): {
  portal: { at: number; name: string; group?: string; streak?: number }[]
  portalFlaps: { name: string; group?: string; upAt: number; downAt: number }[]
  portalPending: string[]
} | null {
  const log = [...((m.portalLog ?? []) as { name: string; kind: string; at: number; n?: number }[])].sort((a, b) => a.at - b.at)
  if (!log.length) return null
  if (m.maxLog != null && log.length >= m.maxLog) return null
  const groupOf = new Map<string, string | undefined>()
  for (const p of m.portal) groupOf.set(p.name, p.group)
  for (const f of m.portalFlaps ?? []) if (!groupOf.has(f.name)) groupOf.set(f.name, f.group)
  // sure: 마지막 끊김을 '본 것' 으로 믿을 수 있는가 — down, 정상이던 화면의 fail, 끊긴 화면에 되풀이된 fail(다시 펼친 뒤 본 실패)
  const st = new Map<string, { up: { at: number; n?: number } | null; failed: boolean; sure: boolean }>()
  const flaps: { name: string; group?: string; upAt: number; downAt: number }[] = []
  for (const e of log) {
    const s = st.get(e.name) ?? { up: null, failed: false, sure: false }
    st.set(e.name, s)
    if (e.kind === 'up') {
      if (!s.up) s.up = { at: e.at, n: e.n }
      s.failed = false
    } else if (s.up) {
      flaps.push({ name: e.name, group: groupOf.get(e.name), upAt: s.up.at, downAt: e.at })
      s.up = null
      s.failed = true
      s.sure = true
    } else {
      s.sure = e.kind === 'down' || s.failed
      s.failed = true
    }
  }
  const storedPending = new Set(m.portalPending ?? [])
  for (const [name, s] of st) if (!s.up && !s.sure && !storedPending.has(name)) return null
  const portal: { at: number; name: string; group?: string; streak?: number }[] = []
  const pending: string[] = []
  for (const [name, s] of st) {
    if (s.up) {
      const old = m.portal.find((p) => p.name === name)
      portal.push({ at: s.up.at, name, group: groupOf.get(name), streak: s.up.n ?? old?.streak })
    } else pending.push(name)
  }
  // 판정 기록에 한 번도 나오지 않은 화면(있을 수 없지만)은 저장된 값을 둔다 — 지우지 않는다
  for (const p of m.portal) if (!st.has(p.name)) portal.push(p)
  for (const f of m.portalFlaps ?? []) if (!st.has(f.name)) flaps.push(f)
  for (const n of m.portalPending ?? []) if (!st.has(n)) pending.push(n)
  return { portal, portalFlaps: flaps, portalPending: pending }
}

/**
 * 포털 감시가 상태를 바꾼 순간 — 증적('포털 응답 기록')의 원문이다. 모든 폴링을 남기면 회차마다 수천 줄이 되므로
 * 판정이 바뀐 순간만 남긴다: 처음 끊김(fail) · 정상화 확정(up) · 다시 끊김 확정(down).
 * `at` 은 그 상태가 **시작된** 관측(연속 구간의 첫 응답), `confirmAt` 은 연속 기준을 채워 확정한 관측이다 — 두 시각이 다른 이유가
 * 증적에서 보여야 '왜 이 시각인가' 를 설명할 수 있다.
 */
export interface PortalEvent {
  at: number
  name: string
  kind: 'fail' | 'up' | 'down'
  confirmAt?: number
  /** 확정한 관측의 HTTP 상태(응답이 없으면 없음) · 응답 시간 */
  status?: number
  ms?: number
  /** 실패 사유(시간 초과 · 조건 불일치 등) */
  reason?: string
  /** 연속 기준 횟수 */
  n?: number
  /**
   * 'up' 만 — 정상화를 확정한 **연속 N회 요청과 그 바로 앞(실패) 1회**, 핵심 API 마다의 응답(사용자 요청 10-29 목업 확정).
   * 예전 증적에는 '10회 연속 정상' 이라는 결론만 있어, 그 10번에 각 API 가 어떻게 답했는지는 볼 수 없었다.
   */
  streak?: PortalPoll[]
}

/** 한 주기(요청 한 번)의 화면 관측 — 핵심 API 마다의 응답 */
export interface PortalPoll {
  at: number
  ok: boolean
  apis: { name: string; ok: boolean; status?: number; ms?: number; why?: string }[]
}

/**
 * 연속 통과 기록 표 — 행은 핵심 API, 열은 요청 순서(앞의 실패 1회 + 연속 정상 N회). 칸은 '✓ 412ms' · '✗ 503',
 * 마우스를 올리면 HTTP · 응답 시간 · 실패 사유. 첫 행은 요청 시각이다.
 */
export function portalStreakTable(
  e: PortalEvent,
  tag = '',
): { title: string; columns: string[]; rows: string[][]; cellTitles: string[][]; bad: boolean[] } | null {
  const all = e.streak ?? []
  if (!all.length) return null
  /*
   * 연속 구간 = 끝에서 n 회, 앞 칸 = 그 바로 앞이 실패일 때만(코드 검토 10-29). 버퍼는 n+1 개라, 앞이 실패가 아니면(정상 n+1 회)
   * 예전엔 1..n+1 열이 생겨 제목의 'n회 연속' 과 어긋났고 첫 열은 연속 구간 밖의 관측이었다.
   */
  const n = Math.min(e.n ?? all.length, all.length)
  const okPolls = all.slice(all.length - n)
  const before = all[all.length - n - 1]
  const lead = !!before && !before.ok
  const polls = lead ? [before, ...okPolls] : okPolls
  // '직전 응답' — portalEvidence LEAD_COL 과 같은 이름(그쪽 주석)
  const columns = ['핵심 API', ...(lead ? ['직전 응답'] : []), ...okPolls.map((_, i) => String(i + 1))]
  const names = Array.from(new Set(polls.flatMap((p) => p.apis.map((a) => a.name))))
  const cell = (p: PortalPoll, n: string) => {
    const a = p.apis.find((x) => x.name === n)
    if (!a) return { t: '-', h: '이 주기에 없음' }
    const http = a.status != null ? `HTTP ${a.status}` : '응답 없음'
    return {
      t: a.ok ? `✓ ${a.ms != null ? `${a.ms}ms` : ''}`.trim() : `✗ ${a.status ?? '-'}`,
      h: [http, a.ms != null ? `${a.ms}ms` : '', a.ok ? '조건 모두 통과' : (a.why ?? '')].filter(Boolean).join(' · '),
    }
  }
  const rows = [['요청 시각', ...polls.map((p) => clock(p.at))], ...names.map((n) => [n, ...polls.map((p) => cell(p, n).t)])]
  const cellTitles = [['', ...polls.map(() => '')], ...names.map((n) => ['', ...polls.map((p) => cell(p, n).h)])]
  return {
    title: `연속 통과 기록: ${e.name}${tag ? ` · ${tag}` : ''} · 첫 정상 ${clock(e.at)}${e.confirmAt ? ` → 확정 ${clock(e.confirmAt)}` : ''} (${e.n ?? okPolls.length}회 연속)`,
    columns,
    rows,
    cellTitles,
    bad: rows.map(() => false),
  }
}

const p2 = (n: number) => String(n).padStart(2, '0')
const clock = (ms: number) => {
  const d = new Date(ms)
  return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`
}
const resp = (e: PortalEvent) => [e.status != null ? `HTTP ${e.status}` : '응답 없음', e.ms != null ? `${e.ms}ms` : ''].filter(Boolean).join(' · ')

/** 증적 원문 — 상태가 바뀐 순간의 판정 로그(시각순) */
export function portalLogText(events: PortalEvent[]): string {
  const rows = [...events].sort((a, b) => a.at - b.at)
  return [
    '시각\t화면\t판정\t근거',
    ...rows.map((e) => {
      const what = e.kind === 'fail' ? '끊김(첫 실패)' : e.kind === 'up' ? '정상화 확정' : '다시 끊김 확정'
      const why =
        e.kind === 'up'
          ? `${e.n ?? '?'}회 연속 정상 · 첫 정상 ${clock(e.at)}${e.confirmAt ? ` → 확정 ${clock(e.confirmAt)}` : ''} · ${resp(e)}`
          : e.kind === 'down'
            ? `${e.n ?? '?'}회 연속 실패 · 첫 실패 ${clock(e.at)}${e.confirmAt ? ` → 확정 ${clock(e.confirmAt)}` : ''} · ${resp(e)}${e.reason ? ` · ${e.reason}` : ''}`
            : `${resp(e)}${e.reason ? ` · ${e.reason}` : ''}`
      return `${clock(e.at)}\t${e.name}\t${what}\t${why}`
    }),
  ].join('\n')
}

/** 페이지별 표 — 최초 끊김 · 1차 정상(그 페이지가 처음 돌아온 때) · 재장애 · 최종 정상화 */
export function portalPageRows(m: PortalPhaseInput, events: PortalEvent[]): { columns: string[]; rows: string[][]; bad: boolean[] } {
  const flaps = m.portalFlaps ?? []
  const pending = new Set(m.portalPending ?? [])
  const names = Array.from(new Set([...m.portal.map((p) => p.name), ...flaps.map((f) => f.name), ...pending, ...events.map((e) => e.name)]))
  const rows = names.map((n) => {
    const firstFail = events.filter((e) => e.name === n && e.kind === 'fail').sort((a, b) => a.at - b.at)[0]
    const ups = [...flaps.filter((f) => f.name === n).map((f) => f.upAt), ...m.portal.filter((p) => p.name === n).map((p) => p.at)].sort((a, b) => a - b)
    const fin = m.portal.find((p) => p.name === n)
    const nFlap = flaps.filter((f) => f.name === n).length
    return [n, firstFail ? clock(firstFail.at) : '-', ups.length ? clock(ups[0]) : '-', nFlap ? `${nFlap}회` : '-', pending.has(n) ? '미복구' : fin ? clock(fin.at) : '-']
  })
  return { columns: ['화면', '최초 끊김', '처음 정상화', '다시 끊김', '최종 정상화'], rows, bad: names.map((n) => pending.has(n)) }
}
