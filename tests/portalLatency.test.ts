// 포털 API 응답 시간(노드 UP · DOWN 구간) — 옛 회차 모양은 2026-11-19 이력 파일(대시보드 정상화 확정 11회 · API 8개)의 portalLog 'up' streak 꼴
import { test, eq } from './harness'
import { addLatSamples, latencyView, latChange, latStat, fmtLat, LAT_MAX_SAMPLES, type PortalLatRec } from '../src/lib/portalLatency'

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
