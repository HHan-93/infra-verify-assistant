/**
 * 포털 API 응답 시간 — 노드 UP · 노드 DOWN 구간별 최소 · 중앙 · 최대(2026-11-19 사용자 결정 · 목업 latency_mock2).
 *
 * 이번 검증에서 일부 API 가 느렸는데 리포트에서 '얼마나' 를 볼 곳이 없었다. 회차 기록에는 화면 판정이 바뀐 순간(portalLog)과 정상화를
 * 확정한 연속 요청만 남아, 평소(노드 UP) 응답은 한 건도 없었다(이력 파일로 확인). 그래서:
 *  - 이후 회차: 포털 감시가 요청할 때마다 API 별 응답 시간을 회차 기록(Milestones.portalLat)에 남긴다. 응답 원문은 남기지 않는다.
 *  - 이미 끝난 회차: 정상화를 확정한 연속 요청(portalLog 'up' 의 streak)만 있어 노드 DOWN 칸만 그것으로 채운다(사용자 결정).
 *    회복되던 구간이라 가장 느렸던 때(끊김 직후)가 빠진다 — 리포트에 그 사실을 적는다.
 * 응답 시간은 **정상 응답만** 센다 — 시간 초과 · 연결 실패는 잴 수 있는 응답 시간이 없고, 빨리 돌아온 오류(500 · 22ms)를 넣으면
 * 장애 중 응답이 오히려 빨라 보인다. 시간 초과 횟수는 싣지 않는다(사용자 결정).
 * 구간: 노드 DOWN = DOWN 감지 ~ 노드 UP(nodeBackAt), 그 밖은 노드 UP(DOWN 전 · 노드가 돌아온 뒤). 노드가 끝내 안 돌아왔으면 DOWN 감지 뒤 전부 DOWN.
 */

/** 회차 기록에 남기는 꼴 — s 는 [검증 시작부터 초, 응답 ms, …] 를 평평하게(JSON 이 작게) */
export interface PortalLatRec {
  v: 1
  apis: { screen: string; name: string; s: number[] }[]
}
/** API 하나에 남기는 최대 표본 수 — 5초마다면 약 2.8시간. 넘치면 새 것을 버린다(DOWN 앞뒤가 먼저 쌓이므로) */
export const LAT_MAX_SAMPLES = 2000

export interface LatSample {
  screen: string
  name: string
  ms: number
}
/** 한 주기의 정상 응답들을 더한다(제자리 변경 — 상태보드가 회차 기록 객체에 바로 쌓는다) */
export function addLatSamples(rec: PortalLatRec, t0: number, at: number, list: LatSample[]): void {
  const sec = Math.max(0, Math.round((at - t0) / 1000))
  for (const x of list) {
    if (!Number.isFinite(x.ms) || x.ms < 0) continue
    let a = rec.apis.find((y) => y.screen === x.screen && y.name === x.name)
    if (!a) {
      a = { screen: x.screen, name: x.name, s: [] }
      rec.apis.push(a)
    }
    if (a.s.length / 2 >= LAT_MAX_SAMPLES) continue
    a.s.push(sec, Math.round(x.ms))
  }
}

export interface LatStat {
  min: number
  med: number
  max: number
  n: number
}
export interface LatRow {
  screen: string
  name: string
  up: LatStat | null
  down: LatStat | null
}
export interface LatView {
  rows: LatRow[]
  /** full = 이 기능 뒤 회차(구간 전부) · streak = 옛 회차(정상화 확정 구간만, UP 없음) */
  source: 'full' | 'streak'
}

export function latStat(xs: number[]): LatStat | null {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  const med = s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
  return { min: s[0], med, max: s[s.length - 1], n: s.length }
}

type StreakPoll = { at: number; apis: { name: string; ok: boolean; ms?: number }[] }
type LogEv = { name: string; kind: string; at: number; streak?: StreakPoll[] }

/**
 * 표의 줄. downAt 이 없으면(DOWN 을 못 잡은 회차) 전부 UP. 화면 · API 순서는 처음 나온 순서(포털 감시 설정 순서와 같다)
 */
export function latencyView(
  m: { portalLat?: PortalLatRec; portalLog?: LogEv[] },
  t0: number,
  downAt: number | null,
  upAt: number | null,
  /** 요청마다 남긴 기록이 있어도 정상화 확정 요청만으로 — 조치 전 · 후 비교에서 옛 회차와 같은 기준으로 맞출 때(latencyCompare) */
  streakOnly = false,
): LatView | null {
  const isDown = (at: number) => downAt != null && at >= downAt && (upAt == null || at < upAt)
  if (!streakOnly && m.portalLat?.apis.length) {
    const rows = m.portalLat.apis.map((a) => {
      const up: number[] = []
      const dn: number[] = []
      for (let i = 0; i + 1 < a.s.length; i += 2) (isDown(t0 + a.s[i] * 1000) ? dn : up).push(a.s[i + 1])
      return { screen: a.screen, name: a.name, up: latStat(up), down: latStat(dn) }
    })
    return { rows, source: 'full' }
  }
  // 옛 회차 — 정상화 확정 연속 요청. 같은 화면이 여러 번 정상화했으면 요청이 겹칠 수 있어 (화면 · 시각)으로 한 번만
  const seen = new Set<string>()
  const by = new Map<string, LatRow & { xs: number[] }>()
  for (const e of m.portalLog ?? []) {
    if (e.kind !== 'up') continue
    for (const p of e.streak ?? []) {
      const k = `${e.name}\n${p.at}`
      if (seen.has(k) || !isDown(p.at)) continue
      seen.add(k)
      for (const a of p.apis) {
        // 줄 순서는 API 가 처음 나온 순서(설정 순서) — 그 요청에서 실패였어도 자리는 먼저 잡는다
        const key = `${e.name}\n${a.name}`
        const r = by.get(key) ?? { screen: e.name, name: a.name, up: null, down: null, xs: [] }
        by.set(key, r)
        if (a.ok && a.ms != null) r.xs.push(a.ms)
      }
    }
  }
  if (!by.size) return null
  return { rows: [...by.values()].map(({ xs, ...r }) => ({ ...r, down: latStat(xs) })), source: 'streak' }
}

/** 응답 시간 글 — 1초 미만 '0.31초', 10초 미만 '2.41초', 그 위 '12.4초' */
export const fmtLat = (ms: number) => (ms < 10_000 ? `${(ms / 1000).toFixed(2)}초` : `${(ms / 1000).toFixed(1)}초`)

/**
 * 변화(중앙값) — DOWN 이 UP 보다 몇 배(사용자 결정: 오르면 빨강 'n배 상승', 아니면 회색 'n배 하락' · '변화 없음').
 * 소수 한 자리로 1.0배가 되면 변화 없음. 한쪽이 없으면 없음(null)
 */
export function latChange(up: LatStat | null, down: LatStat | null): { text: string; rise: boolean } | null {
  if (!up || !down || up.med <= 0 || down.med <= 0) return null
  const r = down.med / up.med
  if (r >= 1) return Number(r.toFixed(1)) <= 1 ? { text: '변화 없음', rise: false } : { text: `${r.toFixed(1)}배 상승`, rise: true }
  const f = up.med / down.med
  return Number(f.toFixed(1)) <= 1 ? { text: '변화 없음', rise: false } : { text: `${f.toFixed(1)}배 하락`, rise: false }
}

/*
 * 조치 전 · 후 비교(2026-11-25 사용자 결정 · 목업 latency_compare_mock). Expert 팀 패치 뒤 "많이 느렸지만 조치 뒤 이만큼 줄었다" 를
 * 리포트에 싣고 싶은데, 포털 API 응답 리포트는 회차별 표 + 느린 API 다섯 줄뿐이라 묶음끼리 견줄 곳이 없었다(Gemini 로 손수 만들던 표).
 *  - 묶음은 검증 그룹 차수로 고르고, 리포트 만들기 창에서 회차를 직접 넣고 뺀다(오래 걸린 회차만 고르는 식). 고르는 것은 화면 쪽 일이다
 *  - 구간은 노드 DOWN 고정(사용자 결정) — 문제가 된 것이 DOWN 중 지연이고, 11-19 전 회차는 DOWN 기록만 있다
 *  - 값은 회차마다 DOWN 중앙값을 구해 그 평균(중앙 평균)과, 묶음 모든 요청 중 가장 느린 한 건(최대). 최소는 싣지 않는다(간결하게, 사용자 결정)
 *  - 변화는 중앙 평균 차이 — 0.2초 미만이면 '차이 근소함'(사용자 결정: '차이 작음' 대신). 들쭉날쭉 · 튄 값 표시는 목업에 있었다가 뺐다(사용자 결정)
 *  - **같은 기준으로 맞춘다**: 한 회차라도 정상화 확정 요청만 남은 옛 회차면 양쪽 모두 그 요청만으로 잰다. 옛 회차(끊김 직후가 빠져 덜 느림)와
 *    새 회차(DOWN 전부)를 섞으면 조치 전이 실제보다 빨라 보여, 조치 효과가 작게(또는 거꾸로) 나온다
 */
export interface LatCmpRun {
  m: { portalLat?: PortalLatRec; portalLog?: LogEv[] }
  t0: number
  downAt: number | null
  upAt: number | null
}
export interface LatCmpSide {
  /** 회차별 DOWN 중앙값의 평균 */
  avg: number
  /** 묶음 모든 요청 중 가장 빠른 한 건 — 종합 결과 요약의 '최소 ~ 최대' 칸(2026-11-25 사용자 요청: 중앙 평균 옆에 범위도) */
  min: number
  /** 묶음 모든 요청 중 가장 느린 한 건 */
  max: number
  /** 회차별 DOWN 중앙값 — 고른 회차 순서, 그 회차에 이 API 응답이 없으면 null */
  meds: (number | null)[]
}
export interface LatCmpChange {
  text: string
  kind: 'down' | 'up' | 'flat'
  /** 조치 후 − 조치 전(ms) — 많이 줄어든 순 정렬용 */
  diff: number
}
export interface LatCmpRow {
  screen: string
  name: string
  pre: LatCmpSide | null
  post: LatCmpSide | null
  change: LatCmpChange | null
}
export interface LatCmp {
  rows: LatCmpRow[]
  /** 옛 회차가 섞여 양쪽 모두 정상화 확정 요청만으로 쟀다 */
  streakOnly: boolean
}
/** 이보다 작은 차이는 '차이 근소함'(사용자 결정 11-25) */
export const LAT_CMP_FLAT_MS = 200

export function latCmpChange(pre: LatCmpSide | null, post: LatCmpSide | null): LatCmpChange | null {
  if (!pre || !post || pre.avg <= 0) return null
  const diff = post.avg - pre.avg
  if (Math.abs(diff) < LAT_CMP_FLAT_MS) return { text: '차이 근소함', kind: 'flat', diff }
  const pct = Math.round((Math.abs(diff) / pre.avg) * 100)
  return diff < 0 ? { text: `${pct}% 감소`, kind: 'down', diff } : { text: `${pct}% 증가`, kind: 'up', diff }
}

export function latencyCompare(pre: LatCmpRun[], post: LatCmpRun[]): LatCmp | null {
  if (!pre.length || !post.length) return null
  const all = [...pre, ...post]
  const viewOf = (r: LatCmpRun, streak: boolean) => latencyView(r.m, r.t0, r.downAt, r.upAt, streak)
  // 요청마다 남긴 기록이 없는 회차(옛 회차)가 하나라도 있으면 모두 정상화 확정 요청만으로
  const streakOnly = all.some((r) => !r.m.portalLat?.apis.length && viewOf(r, true) != null)
  const order: { screen: string; name: string }[] = []
  const keyOf = (x: { screen: string; name: string }) => `${x.screen}\n${x.name}`
  const sideViews = (runs: LatCmpRun[]) =>
    runs.map((r) => {
      const mp = new Map<string, LatStat>()
      for (const row of viewOf(r, streakOnly)?.rows ?? []) {
        if (!order.some((o) => keyOf(o) === keyOf(row))) order.push({ screen: row.screen, name: row.name })
        if (row.down) mp.set(keyOf(row), row.down)
      }
      return mp
    })
  const pv = sideViews(pre)
  const qv = sideViews(post)
  const side = (vs: Map<string, LatStat>[], k: string): LatCmpSide | null => {
    const st = vs.map((v) => v.get(k) ?? null)
    const got = st.filter((x): x is LatStat => x != null)
    if (!got.length) return null
    return { avg: got.reduce((a, x) => a + x.med, 0) / got.length, min: Math.min(...got.map((x) => x.min)), max: Math.max(...got.map((x) => x.max)), meds: st.map((x) => (x ? x.med : null)) }
  }
  const rows = order
    .map((o) => {
      const k = keyOf(o)
      const a = side(pv, k)
      const b = side(qv, k)
      return { ...o, pre: a, post: b, change: latCmpChange(a, b) }
    })
    .filter((r) => r.pre || r.post)
  return rows.length ? { rows, streakOnly } : null
}

/** 종합 결과 요약 — 중앙 평균이 가장 많이 줄어든 API(줄어든 것만) */
export function latCmpTop(c: LatCmp, n = 5): LatCmpRow[] {
  return c.rows.filter((r) => r.change?.kind === 'down').sort((a, b) => (a.change as LatCmpChange).diff - (b.change as LatCmpChange).diff).slice(0, n)
}
