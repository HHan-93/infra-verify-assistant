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
}

export interface PortalPhases {
  /** 끊긴 적 있는 페이지 수(기록에 나오는 페이지) */
  pages: number
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
/** 시각들을 SAME_MS 안에 이어진 것끼리 묶었을 때의 묶음 수 */
function episodes(ts: number[]): number {
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
  const upAt = (n: string, t: number) => (spans.get(n) ?? []).some(([a, b]) => a <= t && t < b)
  // 모두 정상인 순간은 반드시 어느 페이지가 돌아온 순간에 시작한다 — 그 후보들만 보면 된다
  const starts = Array.from(new Set([...spans.values()].flat().map(([a]) => a))).sort((a, b) => a - b)
  const firstAll = names.length ? (starts.find((t) => names.every((n) => upAt(n, t))) ?? null) : null
  const finalAll = names.length && !pending.length && m.portal.length ? Math.max(...m.portal.map((p) => p.at)) : null
  return {
    pages: names.length,
    firstAll,
    finalAll,
    flapsAfterFirst: firstAll == null ? 0 : episodes(flaps.map((f) => f.downAt).filter((t) => t > firstAll)),
    flaps: flaps.length,
  }
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
  const columns = ['핵심 API', ...(lead ? ['앞(실패)'] : []), ...okPolls.map((_, i) => String(i + 1))]
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
