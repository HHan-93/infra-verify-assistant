// 상태보드 — masakari-engine 로그 판정(완료 · 처리 실패 · 재처리 · 대수)
import { test, eq, fixture } from './harness'
import { parseMasakari, failReason, failedInstances, failBrief, MASAKARI_GREP } from '../src/lib/masakariLog'

const T0 = new Date('2026-10-26T15:47:57').getTime()
const ESC = '\x1b[01;36m'

test('error 로 끝난 엔진은 진행 중이 아니라 처리 실패 — 실제 로그(con02, keystone 500)', () => {
  const p = parseMasakari(fixture('masakari-engine-error.log'), T0, 0)
  eq(p.state, 'error')
  eq(p.status, 'error')
  eq(new Date(p.at as number).toTimeString().slice(0, 8), '15:54:50')
})

test('flow id 를 VM 으로 세지 않는다 — evacuate 를 한 대도 못 한 엔진은 0대', () => {
  eq(parseMasakari(fixture('masakari-engine-error.log'), T0, 0).evac, 0)
})

// con03 로그를 evacuate 3대까지만 잘라 '그 시점' 을 본다(뒤에는 16:20 의 실제 실패 줄이 이어진다)
const retryUntil = (hhmm: string) =>
  fixture('masakari-engine-retry.log')
    .split('\n')
    .filter((l) => !l || l.slice(11, 16) < hhmm)
    .join('\n')

test('이어받은 엔진은 진행 중 · evacuate 한 VM 만 센다 — 실제 로그(con03)', () => {
  const p = parseMasakari(retryUntil('16:00'), T0, 0)
  eq(p.state, 'progress')
  eq(p.evac, 3)
})

test('실제 로그 — evacuation 시간 초과 뒤 error 와 failed 가 잇달아 찍히면 실패 확정(16:20 con03)', () => {
  const p = parseMasakari(fixture('masakari-engine-retry.log'), T0, 0)
  eq(p.state, 'failed')
  eq(new Date(p.at as number).toTimeString().slice(0, 8), '16:20:38')
})

test('ANSI 색이 섞여 있어도 같다', () => {
  const raw = retryUntil('16:00').replace(/\[req-/g, `[${ESC}req-`)
  eq(parseMasakari(raw, T0, 0).evac, 3)
})

test('error 뒤 같은 엔진이 다시 Processing 하면 진행 중', () => {
  const raw = fixture('masakari-engine-error.log') + retryUntil('16:00')
  eq(parseMasakari(raw, T0, 0).state, 'progress')
})

// finished 줄은 masakari engine/manager.py 의 로그 형식(`Notification %s exits with status: %s.`)으로 만든 것이다
test('finished 가 있으면 완료 — 시각은 그 줄', () => {
  const raw = retryUntil('16:00') +
    '2026-10-26 16:05:10.000 INFO masakari.engine.manager [req-0 service masakari] Notification df33594d-5165-428f-aab8-d886dbe26056 exits with status: finished.\n'
  const p = parseMasakari(raw, T0, 0)
  eq(p.state, 'finished')
  eq(new Date(p.at as number).toTimeString().slice(0, 8), '16:05:10')
})

test('검증 시작 전 로그만 있으면 idle', () => {
  eq(parseMasakari(fixture('masakari-engine-error.log'), new Date('2026-10-26T17:00:00').getTime(), 0).state, 'idle')
})

// 프로세스 재시작 같은 호스트 장애가 아닌 알림 — 종류 줄 형식은 위 con03 실제 로그의 'of type: COMPUTE_HOST' 와 같다
const procNote = (exit: string) =>
  '2026-10-26 15:50:00.000 INFO masakari.engine.manager [req-1 None None] Processing notification 11111111-2222-4333-8444-555555555555 of type: PROCESS\n' +
  `2026-10-26 15:50:05.000 INFO masakari.engine.manager [req-1 service masakari] Notification 11111111-2222-4333-8444-555555555555 exits with status: ${exit}.\n`

test('호스트 장애가 아닌 알림(PROCESS)의 처리·실패·완료는 evacuation 이 아니다', () => {
  eq(parseMasakari(procNote('error'), T0, 0).state, 'idle')
  eq(parseMasakari(procNote('finished'), T0, 0).state, 'idle')
  // 그 뒤에 진짜 호스트 장애 알림이 오면 그쪽으로 판정한다
  eq(parseMasakari(procNote('finished') + fixture('masakari-engine-retry.log'), T0, 0).state, 'failed')
})

test('실패 이유 — 실제 로그(con03 16:20): 옮기지 못한 VM 수 · 확인 시간 초과', () => {
  eq(parseMasakari(fixture('masakari-engine-retry.log'), T0, 0).reason, 'VM 5대 옮기지 못함 · 1대 evacuation 확인 시간 초과(601초)')
})
test('실패 이유 — 실제 로그(con02 15:54): 실패한 단계 · API 오류(HTTP 코드 없음)', () => {
  eq(parseMasakari(fixture('masakari-engine-error.log'), T0, 0).reason, '대상 VM 조회 단계에서 Nova API 오류 · VM 이동 시도 없음')
})

test('실패 대수 — 실제 로그(18:30 con03): 11대 중 7대 · 확인 시간 초과 608초', () => {
  const lines = fixture('masakari-engine-fail-1830.log').split('\n')
  eq(failedInstances(lines).length, 7)
  eq(failReason(lines, 11), 'VM 11대 중 7대 옮기지 못함 · 1대 evacuation 확인 시간 초과(608초)')
})

// 2026-10-27: evacuation 전 첫 단계에서 Nova API 503 — 'evacuation 실패' 로 읽히지 않게 단계 · 원인을 적는다
const T0_1027 = new Date('2026-10-27T13:46:13').getTime()
test('실제 로그(10-27 con02): 재시도도 503 → failed · 단계와 원인 · VM 이동 시도 없음', () => {
  const p = parseMasakari(fixture('masakari-engine-503.log'), T0_1027, 0)
  eq(p.state, 'failed')
  eq(new Date(p.at as number).toTimeString().slice(0, 8), '13:51:42')
  eq(p.evac, 0)
  eq(p.reason, '서비스 비활성화 단계에서 Nova API 503 · VM 이동 시도 없음')
  eq(p.brief, 'Nova API 503, VM 이동 시도 없음')
})
test('상태보드 grep 을 거친 줄만으로도 같은 사유가 나온다(Task FAILURE · TRACE 예외 줄이 걸러지지 않아야)', () => {
  const re = new RegExp(MASAKARI_GREP, 'i')
  const grepped = fixture('masakari-engine-503.log').split('\n').filter((l) => re.test(l)).join('\n')
  eq(parseMasakari(grepped, T0_1027, 0).reason, '서비스 비활성화 단계에서 Nova API 503 · VM 이동 시도 없음')
})
test('VM 을 옮기다 실패한 경우의 짧은 사유는 대수 문장 그대로', () => {
  const lines = fixture('masakari-engine-fail-1830.log').split('\n')
  eq(failBrief(lines, 11), 'VM 11대 중 7대 옮기지 못함 · 1대 evacuation 확인 시간 초과(608초)')
})
