// 판정 기록(portalLog)으로 포털 최종 정상화 · 다시 끊김 · 안 돌아온 화면 다시 맞추기(최소화 버그로 굳은 회차 바로잡기)
import { test, eq } from './harness'
import { portalFromLog, portalPhases } from '../src/lib/portalPhases'

const T = (hms: string) => new Date(`2026-11-10T${hms}+09:00`).getTime()
const ev = (hms: string, name: string, kind: 'fail' | 'up' | 'down') => ({ at: T(hms), name, kind })

test('최소화로 감시가 새로 시작된 회차: 정상이던 화면의 fail 은 다시 끊김, 끝에 끊긴 화면은 안 돌아온 화면(11-10 8회차 꼴)', () => {
  const log = [
    ev('10:19:37', '목록', 'fail'),
    ev('10:19:37', '모니터링', 'fail'),
    ev('10:19:37', '대시보드', 'fail'),
    ev('10:19:38', '로그인', 'fail'),
    ev('10:20:51', '로그인', 'up'),
    ev('10:21:53', '목록', 'up'),
    ev('10:41:08', '모니터링', 'up'),
    // 여기서 최소화 · 펼침 — 감시가 새로 시작돼 끊겨 있던 대시보드에 'fail' 이 또 찍혔다
    ev('11:05:15', '대시보드', 'fail'),
    ev('11:05:38', '대시보드', 'up'),
    ev('11:06:44', '모니터링', 'fail'),
    ev('11:06:47', '모니터링', 'up'),
    // 정상화됐던 목록이 끊긴 것이 'down' 이 아니라 'fail' 로 남았다
    ev('11:10:20', '목록', 'fail'),
    ev('11:10:20', '대시보드', 'down'),
    ev('11:11:02', '모니터링', 'down'),
  ]
  // 저장된 값(버그로 굳은 것): 목록이 최종 정상화로 남고 안 돌아온 화면이 없다
  const stored = {
    portal: [
      { name: '로그인', at: T('10:20:51'), streak: 10 },
      { name: '목록', at: T('10:21:53'), streak: 10 },
    ],
    portalFlaps: [
      { name: '대시보드', upAt: T('11:05:38'), downAt: T('11:10:20') },
      { name: '모니터링', upAt: T('11:06:47'), downAt: T('11:11:02') },
    ],
    portalLog: log,
  }
  const before = portalPhases(stored)
  eq(before.finalAll != null && before.firstAll != null && before.finalAll < before.firstAll, true)
  const r = portalFromLog(stored)!
  eq(r.portal.map((p) => p.name), ['로그인'])
  eq([...r.portalPending].sort(), ['대시보드', '모니터링', '목록'])
  const after = portalPhases({ ...r, portalLog: log })
  // 1차 = 네 화면이 처음 동시에 정상: 대시보드가 돌아온 11:05:38(모니터링은 10:41:08 부터 정상으로 본다)
  eq(after.firstAll, T('11:05:38'))
  eq(after.finalAll, null)
})

test('평소 회차(최소화 없음)는 저장된 값과 같다', () => {
  const log = [ev('12:00:00', 'A', 'fail'), ev('12:00:00', 'B', 'fail'), ev('12:01:00', 'A', 'up'), ev('12:02:00', 'B', 'up'), ev('12:05:00', 'A', 'down'), ev('12:06:00', 'A', 'up')]
  const r = portalFromLog({ portal: [{ name: 'B', at: T('12:02:00'), group: 'g' }, { name: 'A', at: T('12:06:00') }], portalLog: log })!
  eq(
    r.portal.map((p) => [p.name, p.at, p.group]).sort(),
    [
      ['A', T('12:06:00'), undefined],
      ['B', T('12:02:00'), 'g'],
    ],
  )
  eq(r.portalFlaps.map((f) => [f.name, f.upAt, f.downAt]), [['A', T('12:01:00'), T('12:05:00')]])
  eq(r.portalPending, [])
})

test('판정 기록이 없는 옛 회차는 손대지 않는다', () => {
  eq(portalFromLog({ portal: [{ name: 'A', at: 1 }] }), null)
})

test('최소화 중 돌아온 화면(마지막 기록이 처음 끊김뿐 · 저장된 값은 안 돌아온 화면 아님)은 판단할 수 없어 손대지 않는다', () => {
  // A 가 끊긴 뒤 최소화 · 그 사이 돌아옴 · 펼친 뒤엔 정상이라 아무 기록이 없다
  const log = [ev('10:00:00', 'A', 'fail'), ev('10:00:00', 'B', 'fail'), ev('10:01:00', 'B', 'up')]
  eq(portalFromLog({ portal: [{ name: 'B', at: T('10:01:00') }], portalLog: log }), null)
  // 저장된 값도 안 돌아온 화면이라 하면 그대로 실패
  eq(portalFromLog({ portal: [{ name: 'B', at: T('10:01:00') }], portalPending: ['A'], portalLog: log })?.portalPending, ['A'])
})

test('판정 기록이 상한에 닿은 회차는 저장된 값을 쓴다(그 뒤 사건이 기록에 없다)', () => {
  const log = [ev('10:00:00', 'A', 'fail'), ev('10:01:00', 'A', 'up')]
  eq(portalFromLog({ portal: [], portalPending: ['A'], portalLog: log, maxLog: 2 }), null)
})
