// 포털 API 응답 시간(노드 UP · DOWN 구간) — 옛 회차 모양은 2026-11-19 이력 파일(대시보드 정상화 확정 11회 · API 8개)의 portalLog 'up' streak 꼴
import { test, eq } from './harness'
import { addLatSamples, latencyView, latChange, latStat, fmtLat, LAT_MAX_SAMPLES, latencyCompare, latCmpChange, latCmpTop, type PortalLatRec, type LatCmpRun } from '../src/lib/portalLatency'

const t0 = Date.parse('2026-11-19T10:00:00+09:00')
const down = t0 + 60_000
const up = t0 + 600_000

test('최소 · 중앙 · 최대 — 짝수 개는 가운데 둘의 평균', () => {
  eq(latStat([300, 100, 200]), { min: 100, med: 200, max: 300, n: 3 })
  eq(latStat([100, 200, 300, 400])?.med, 250)
  eq(latStat([]), null)
})

test('이후 회차 — 요청마다 쌓고, DOWN 감지 ~ 노드 UP 은 DOWN, 그 밖(전 · 뒤)은 UP', () => {
  const rec: PortalLatRec = { v: 1, apis: [] }
  addLatSamples(rec, t0, t0 + 10_000, [{ screen: '인스턴스 목록', name: 'servers', ms: 310.4 }])
  addLatSamples(rec, t0, t0 + 120_000, [{ screen: '인스턴스 목록', name: 'servers', ms: 2410 }])
  addLatSamples(rec, t0, t0 + 300_000, [{ screen: '인스턴스 목록', name: 'servers', ms: 9800 }])
  addLatSamples(rec, t0, t0 + 700_000, [{ screen: '인스턴스 목록', name: 'servers', ms: 280 }, { screen: '대시보드', name: 'summary', ms: 420 }])
  eq(rec.apis[0].s, [10, 310, 120, 2410, 300, 9800, 700, 280])
  const v = latencyView({ portalLat: rec }, t0, down, up)!
  eq(v.source, 'full')
  eq(v.rows[0], { screen: '인스턴스 목록', name: 'servers', up: { min: 280, med: 295, max: 310, n: 2 }, down: { min: 2410, med: 6105, max: 9800, n: 2 } })
  eq(v.rows[1].down, null)
  // 노드가 안 돌아왔으면 DOWN 뒤 전부 DOWN · DOWN 을 못 잡았으면 전부 UP
  eq(latencyView({ portalLat: rec }, t0, down, null)!.rows[0].up?.n, 1)
  eq(latencyView({ portalLat: rec }, t0, null, null)!.rows[0].down, null)
})

test('API 하나에 표본 한도', () => {
  const rec: PortalLatRec = { v: 1, apis: [] }
  for (let i = 0; i < LAT_MAX_SAMPLES + 5; i++) addLatSamples(rec, t0, t0 + i * 5000, [{ screen: 'a', name: 'b', ms: 1 }])
  eq(rec.apis[0].s.length, LAT_MAX_SAMPLES * 2)
})

test('옛 회차 — 정상화 확정 연속 요청의 정상 응답만 DOWN 칸으로, 같은 요청은 한 번', () => {
  const poll = (s: number, apis: [string, boolean, number?][]) => ({ at: t0 + s * 1000, ok: true, apis: apis.map(([name, ok, ms]) => ({ name, ok, ms })) })
  const log = [
    { name: '대시보드', kind: 'fail', at: t0 + 70_000 },
    { name: '대시보드', kind: 'up', at: t0 + 280_000, streak: [poll(270, [['summary', false, 90014], ['graph', true, 8117]]), poll(275, [['summary', true, 1200], ['graph', true, 900]])] },
    // 다시 정상화 — 앞 요청(275초)이 겹쳐도 한 번만
    { name: '대시보드', kind: 'up', at: t0 + 400_000, streak: [poll(275, [['summary', true, 1200], ['graph', true, 900]]), poll(395, [['summary', true, 800], ['graph', true, 700]])] },
  ]
  const v = latencyView({ portalLog: log }, t0, down, up)!
  eq(v.source, 'streak')
  eq(
    v.rows.map((r) => [r.screen, r.name, r.up, r.down?.min, r.down?.med, r.down?.max, r.down?.n]),
    [
      ['대시보드', 'summary', null, 800, 1000, 1200, 2],
      ['대시보드', 'graph', null, 700, 900, 8117, 3],
    ],
  )
  eq(latencyView({ portalLog: [] }, t0, down, up), null)
})

test('변화 — 오르면 n배 상승, 아니면 n배 하락 · 변화 없음', () => {
  const s = (med: number) => ({ min: med, med, max: med, n: 1 })
  eq(latChange(s(310), s(2410)), { text: '7.8배 상승', rise: true })
  eq(latChange(s(800), s(400)), { text: '2.0배 하락', rise: false })
  eq(latChange(s(300), s(310)), { text: '변화 없음', rise: false })
  eq(latChange(null, s(1)), null)
  eq([fmtLat(310), fmtLat(2410), fmtLat(12_400)], ['0.31초', '2.41초', '12.4초'])
})

// 조치 전 · 후 비교(2026-11-25) — 노드 DOWN 구간만, 회차별 중앙값의 평균 · 묶음 최대, 0.2초 미만 '차이 근소함'
/** 이후 회차 — DOWN 구간(60초 ~ 600초)에 응답들, UP 구간에 한 건(비교에 들어가면 안 된다) */
const fullRun = (apis: Record<string, number[]>): LatCmpRun => {
  const rec: PortalLatRec = { v: 1, apis: [] }
  addLatSamples(rec, t0, t0 + 10_000, Object.keys(apis).map((name) => ({ screen: '대시보드', name, ms: 99_999 })))
  Object.entries(apis).forEach(([name, xs]) => xs.forEach((ms, i) => addLatSamples(rec, t0, t0 + 100_000 + i * 5000, [{ screen: '대시보드', name, ms }])))
  return { m: { portalLat: rec }, t0, downAt: down, upAt: up }
}

test('조치 전 · 후 — 회차별 DOWN 중앙값의 평균 · 묶음 최대, 변화는 중앙 평균 차이', () => {
  const pre = [fullRun({ graph: [14000, 15000, 77000], status: [120, 130] }), fullRun({ graph: [50000, 60000, 81000], status: [6000, 6100] })]
  const post = [fullRun({ graph: [4700, 4800, 4900], status: [4500, 4600] }), fullRun({ graph: [1900, 2000, 47000] })]
  const c = latencyCompare(pre, post)!
  eq(c.streakOnly, false)
  const g = c.rows[0]
  eq([g.screen, g.name, g.pre?.meds, g.pre?.avg, g.pre?.min, g.pre?.max], ['대시보드', 'graph', [15000, 60000], 37500, 14000, 81000])
  eq([g.post?.meds, g.post?.avg, g.post?.min, g.post?.max, g.change?.text, g.change?.kind], [[4800, 2000], 3400, 1900, 47000, '91% 감소', 'down'])
  // 조치 후 한 회차에는 status 응답이 없음 → 그 회차는 null, 평균은 있는 회차만
  const st = c.rows[1]
  eq([st.pre?.avg, st.post?.meds, st.post?.avg, st.change?.text], [3087.5, [4550, null], 4550, '47% 증가'])
  eq(latCmpTop(c).map((r) => r.name), ['graph'])
  eq(latencyCompare([], post), null)
})

test('차이 근소함 — 0.2초 미만', () => {
  const s = (avg: number) => ({ avg, min: avg, max: avg, meds: [avg] })
  eq(latCmpChange(s(560), s(565))?.text, '차이 근소함')
  eq(latCmpChange(s(160), s(250))?.text, '차이 근소함')
  eq(latCmpChange(s(390), s(690)), { text: '77% 증가', kind: 'up', diff: 300 })
  eq(latCmpChange(null, s(1)), null)
})

test('옛 회차가 섞이면 양쪽 모두 정상화 확정 요청만으로 — 같은 기준', () => {
  const poll = (sec: number, ms: number) => ({ at: t0 + sec * 1000, ok: true, apis: [{ name: 'graph', ok: true, ms }] })
  const old: LatCmpRun = { m: { portalLog: [{ name: '대시보드', kind: 'up', at: t0 + 300_000, streak: [poll(290, 30000), poll(295, 20000)] }] }, t0, downAt: down, upAt: up }
  // 새 회차: 요청마다 기록(DOWN 내내 60초)도 있고 정상화 확정 요청(2초)도 있다 → 비교에는 확정 요청만
  const nw = fullRun({ graph: [60000, 60000, 60000] })
  nw.m.portalLog = [{ name: '대시보드', kind: 'up', at: t0 + 300_000, streak: [poll(290, 2000), poll(295, 2000)] }]
  const c = latencyCompare([old], [nw])!
  eq(c.streakOnly, true)
  eq([c.rows[0].pre?.avg, c.rows[0].post?.avg, c.rows[0].change?.text], [25000, 2000, '92% 감소'])
  // 모두 새 회차면 요청마다 기록으로
  eq(latencyCompare([nw], [nw])!.rows[0].pre?.avg, 60000)
})
