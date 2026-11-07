// Ceph 카드 문구 · 클러스터 로그 시각 · 경고 코드 설명
import { test, eq } from './harness'
import { cephHints, cephLineHot, cephLogLocal, cephLogTone, cephNote } from '../src/lib/cephView'

test('카드 문구 — 이번 검증에서 복구를 봤는지로 가른다', () => {
  // 11-07 캡처: 검증 전 평상시, MON_DISK_LOW 만 있고 degraded · misplaced 0
  eq(cephNote('WARN', 0, 0), '데이터 정상 · 복제와 무관한 경고 있음 (위 사유)')
  eq(cephNote('WARN', 0, 2187), '데이터 복구 완료 · 다른 경고 남음 (위 사유)')
  eq(cephNote('OK', 0, 0), 'HEALTH_OK · 정상')
  eq(cephNote('OK', 0, 2187), 'HEALTH_OK · 복구 완료')
  eq(cephNote('WARN', 120, 2187), '리밸런스 진행 중')
  eq(cephNote('OK', 5, 0), '리밸런스 진행 중')
  eq(cephNote('unknown', 0, 0), '조회 실패 (권한/명령 확인)')
})

test('클러스터 로그 시각(UTC)을 이 PC 시간대로', () => {
  // 10-28 1회차 증적의 실제 줄(ceph log last 1000)
  const raw = [
    '2026-10-28T02:10:34.042868+0000 mon.contrabass01 (mon.0) 216 : cluster [INF] Health check cleared: PG_DEGRADED (was: Degraded data redundancy: 2187/418875 objects degraded (0.522%), 1 pg degraded)',
    '2026-10-28T02:10:34.042901+0000 mon.contrabass01 (mon.0) 217 : cluster [INF] Cluster is now healthy',
    '(형식이 다른 줄)',
  ].join('\n')
  const out = cephLogLocal(raw).split('\n')
  eq(out[1], '2026-10-28 11:10:34  mon.contrabass01 (mon.0) 217 : cluster [INF] Cluster is now healthy')
  eq(out[2], '(형식이 다른 줄)')
})

test('칠할 줄과 경고 코드 설명', () => {
  eq(cephLineHot('[WRN] MON_DISK_LOW: mon contrabass01 is low on available space'), true)
  eq(cephLineHot('    health: HEALTH_WARN'), true)
  eq(cephLineHot('cluster [INF] Cluster is now healthy'), false)
  const h = cephHints('HEALTH_WARN mon contrabass01 is low on available space\n[WRN] MON_DISK_LOW: mon contrabass01 is low on available space\n    mon.contrabass01 has 27% avail')
  eq(h.map((x) => x.code), ['MON_DISK_LOW'])
  eq(cephHints('[WRN] SOME_UNKNOWN_CODE: x'), [])
})

test('클러스터 로그는 상태가 바뀐 줄만 칠한다(10-28 1회차 로그)', () => {
  eq(cephLogTone('2026-10-28 11:09:40  mon.contrabass01 (mon.0) 113 : cluster [WRN] Health check update: Degraded data redundancy: 92726/418863 objects degraded'), '')
  eq(cephLogTone('2026-10-28 11:10:34  mon.contrabass01 (mon.0) 216 : cluster [INF] Health check cleared: PG_DEGRADED (was: Degraded data redundancy)'), 'good')
  eq(cephLogTone('2026-10-28 11:10:34  mon.contrabass01 (mon.0) 217 : cluster [INF] Cluster is now healthy'), 'good')
  eq(cephLogTone('mon.contrabass01 [WRN] Health check failed: 1 osds down (OSD_DOWN)'), 'bad')
})
