// 원격 로그 색 코드 지우기 — ESC 시퀀스와 ESC 가 떨어져 나간 조각(2026-10-26 masakari-engine.log 실시간 로그 화면)
import { test, eq } from './harness'
import { stripAnsi } from '../src/lib/ansi'

test('ESC 가 떨어져 나간 SGR 조각을 지운다 — 실제 화면 줄', () => {
  eq(
    stripAnsi('2026-10-26 15:54:44.178 TRACE masakari.engine.drivers.taskflow.driver [01;35m[00m  File "x.py", line 52'),
    '2026-10-26 15:54:44.178 TRACE masakari.engine.drivers.taskflow.driver   File "x.py", line 52',
  )
  eq(stripAnsi('[[01;36mreq-1e69 [00;36mservice None] [01;35mFetch'), '[req-1e69 service None] Fetch')
})
test('ESC 시퀀스도 지운다', () => {
  eq(stripAnsi('\x1b[01;36mreq\x1b[00m'), 'req')
})
test('일반 글자는 건드리지 않는다', () => {
  eq(stripAnsi('[mysql] timeout [5m] array[0m]'), '[mysql] timeout [5m] array[0m]')
})
