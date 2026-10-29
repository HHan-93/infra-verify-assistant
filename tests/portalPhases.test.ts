// 포털 1차 정상화(모든 페이지가 처음 동시에 정상) · 최종 정상화
import { test, eq } from './harness'
import { portalPhases, portalLogText, portalPageRows, portalStreakTable } from '../src/lib/portalPhases'

const T = (hms: string) => new Date(`2026-10-28T${hms}`).getTime()

test('흔들림 없이 돌아오면 1차 = 최종 = 가장 늦은 페이지', () => {
  const r = portalPhases({ portal: [{ at: T('10:58:10'), name: '로그인' }, { at: T('10:58:30'), name: '대시보드' }] })
  eq([r.firstAll, r.finalAll, r.flaps], [T('10:58:30'), T('10:58:30'), 0])
})

test('각 페이지 첫 정상의 최댓값이 아니라 모두 동시에 정상인 첫 순간', () => {
  // 로그인 10:58 정상 → 11:00 다시 끊김 → 11:10 최종, 대시보드는 11:01 에야 첫 정상
  // 11:01 에 로그인은 끊겨 있으므로 1차 정상화는 11:10(로그인이 다시 돌아온 때)이다
  const r = portalPhases({
    portal: [{ at: T('11:10:00'), name: '로그인' }, { at: T('11:01:00'), name: '대시보드' }],
    portalFlaps: [{ name: '로그인', upAt: T('10:58:00'), downAt: T('11:00:00') }],
  })
  eq(r.firstAll, T('11:10:00'))
  eq(r.finalAll, T('11:10:00'))
})

test('다 돌아왔다가 흔들린 뒤 최종 — 사진(10-28) 꼴', () => {
  const r = portalPhases({
    portal: [
      { at: T('11:14:34'), name: '로그인' },
      { at: T('11:15:15'), name: '대시보드' },
      { at: T('11:15:31'), name: '인스턴스 목록' },
      { at: T('11:15:31'), name: '모니터링' },
    ],
    portalFlaps: [
      { name: '로그인', upAt: T('10:58:00'), downAt: T('11:03:45') },
      { name: '대시보드', upAt: T('10:58:20'), downAt: T('11:08:00') },
      { name: '인스턴스 목록', upAt: T('10:58:30'), downAt: T('11:13:43') },
      { name: '모니터링', upAt: T('10:58:30'), downAt: T('11:13:43') },
    ],
  })
  eq(r.firstAll, T('10:58:30'))
  eq(r.finalAll, T('11:15:31'))
  // 인스턴스 목록 · 모니터링은 같은 순간(11:13:43) 끊겨 한 번 — 페이지 수(4)가 아니라 3
  eq(r.flapsAfterFirst, 3)
})

test('미복구가 남으면 최종은 없다 · 1차도 끝내 없을 수 있다', () => {
  const r = portalPhases({ portal: [{ at: T('10:58:00'), name: '로그인' }], portalPending: ['대시보드'] })
  eq([r.firstAll, r.finalAll], [null, null])
})

test('끊긴 페이지가 없으면 둘 다 없음', () => {
  eq(portalPhases({ portal: [] }).firstAll, null)
})

test('판정 로그 — 상태가 바뀐 순간만, 첫 관측과 확정 시각을 함께', () => {
  const txt = portalLogText([
    { at: T('11:03:45'), name: '로그인', kind: 'down', confirmAt: T('11:03:55'), status: 503, ms: 12, n: 3 },
    { at: T('10:54:15'), name: '로그인', kind: 'fail', status: 503, ms: 9 },
  ]).split('\n')
  eq(txt[1], '10:54:15\t로그인\t끊김(첫 실패)\tHTTP 503 · 9ms')
  eq(txt[2], '11:03:45\t로그인\t다시 끊김 확정\t3회 연속 실패 · 첫 실패 11:03:45 → 확정 11:03:55 · HTTP 503 · 12ms')
})

test('페이지별 표 — 미복구는 표시', () => {
  const t = portalPageRows({ portal: [{ at: T('11:10:00'), name: '로그인' }], portalFlaps: [{ name: '로그인', upAt: T('10:58:00'), downAt: T('11:00:00') }], portalPending: ['대시보드'] }, [
    { at: T('10:54:15'), name: '로그인', kind: 'fail' },
  ])
  eq(t.rows[0], ['로그인', '10:54:15', '10:58:00', '1회', '11:10:00'])
  eq(t.rows[1], ['대시보드', '-', '-', '-', '미복구'])
  eq(t.bad, [false, true])
})

test('연속 통과 기록 — 앞(실패) 1회 + 연속 N회, 핵심 API 마다 ✓ 응답 시간 · ✗ 코드, 칸 설명에 사유', () => {
  const T = Date.parse('2026-10-29T05:08:00Z')
  const poll = (i: number, ok: boolean) => ({
    at: T + i * 5000,
    ok,
    apis: [
      { name: 'hypervisors', ok, status: ok ? 200 : 503, ms: ok ? 412 : 30, why: ok ? undefined : 'HTTP 503 (기대: 200)' },
      { name: 'solution-info', ok: true, status: 200, ms: 15 },
    ],
  })
  const t = portalStreakTable({ at: T + 5000, name: '대시보드', kind: 'up', confirmAt: T + 15000, n: 3, streak: [poll(0, false), poll(1, true), poll(2, true), poll(3, true)] }, '최종 정상화')!
  eq(t.columns, ['핵심 API', '앞(실패)', '1', '2', '3'])
  eq(t.rows[1], ['hypervisors', '✗ 503', '✓ 412ms', '✓ 412ms', '✓ 412ms'])
  eq(t.cellTitles[1][1], 'HTTP 503 · 30ms · HTTP 503 (기대: 200)')
  eq(t.title, '연속 통과 기록: 대시보드 · 최종 정상화 · 첫 정상 14:08:05 → 확정 14:08:15 (3회 연속)')
  eq(portalStreakTable({ at: T, name: 'x', kind: 'up' }), null)
  // 앞이 실패가 아니면(정상 n+1 회) 앞 칸 없이 끝의 n 회만 — 제목의 'n회 연속' 과 열 수가 같게(코드 검토 10-29)
  const u = portalStreakTable({ at: T, name: 'x', kind: 'up', n: 3, streak: [poll(0, true), poll(1, true), poll(2, true), poll(3, true)] })!
  eq(u.columns, ['핵심 API', '1', '2', '3'])
  eq(u.rows[0].length, 4)
})
