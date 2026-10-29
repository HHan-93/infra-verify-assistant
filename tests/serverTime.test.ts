// 복구 시간 기준 시각 — 서버 기록(저널 이탈 · pacemaker start)을 쓸지 교차 검증(2026-10-26 17:53 회차 시각)
import { test, eq } from './harness'
import { downBaseOf, vipAtOf } from '../src/lib/serverTime'

const at = (hms: string) => new Date(`2026-10-26T${hms}`).getTime()
const T0 = at('17:53:06')
const down = { at: at('17:53:54'), source: 'pcs' as const, srvAt: at('17:53:33') }

test('저널 이탈이 감지보다 21초 앞 — 서버 기록을 기준으로', () => {
  eq(downBaseOf(down, T0), { at: at('17:53:33'), server: true })
})
test('서버 기록이 검증 시작 전 · 감지보다 뒤 · 2분 넘게 앞이면 도구 감지로', () => {
  eq(downBaseOf({ ...down, srvAt: at('17:52:00') }, T0)?.server, false)
  eq(downBaseOf({ ...down, srvAt: at('17:54:00') }, T0)?.server, false)
  eq(downBaseOf({ ...down, at: at('17:58:00') }, T0)?.server, false)
})
test('검증 전부터 죽어 있던 노드는 기준이 없다', () => {
  eq(downBaseOf({ at: T0, source: 'pre' }, T0), null)
})
test('VIP — pacemaker start(보정) 17:53:38 을 쓴다', () => {
  eq(vipAtOf({ at: at('17:53:55'), pcmkAt: at('17:53:38') }, down), { at: at('17:53:38'), server: true })
  eq(vipAtOf({ at: at('17:53:55') }, down).server, false)
  // 노드 이탈보다 한참 앞선 start 는 이번 이동이 아니다
  eq(vipAtOf({ at: at('17:53:55'), pcmkAt: at('17:50:00') }, down).server, false)
})
