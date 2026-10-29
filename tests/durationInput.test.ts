// 목표 복구 시간 입력 — 여러 표기를 같은 초로, 못 읽으면 null
import { test, eq } from './harness'
import { parseDurationInput as p, fmtDuration } from '../src/lib/durationInput'

test('분:초 · 한글 단위 · 숫자만', () => eq([p('1:30'), p('0:30'), p('1분 30초'), p('1분30초'), p('1분'), p('30초'), p('90'), p('2.5분')], [90, 30, 90, 90, 60, 30, 90, 150]))
test('영문 단위', () => eq([p('1m30s'), p('5 min'), p('45s')], [90, 300, 45]))
test('빈 칸·0 은 판정 안 함, 못 읽으면 null', () => eq([p(''), p('  '), p('0'), p('0:00'), p('1:75'), p('abc'), p('1시간')], [undefined, undefined, undefined, undefined, null, null, null]))

// 리포트 소요 표기 — 시각(14:51:06)과 꼴이 달라야 한다(사용자 지적 10-27: '08:02' 가 시각으로 읽혔다)
test('소요 표기: 1분 미만은 초만', () => {
  eq(fmtDuration(0), '0초')
  eq(fmtDuration(42_900), '42초')
})
test('소요 표기: 1시간 미만은 분 · 두 자리 초', () => {
  eq(fmtDuration(8 * 60_000 + 2_000), '8분 02초')
  eq(fmtDuration(35 * 60_000 + 47_000), '35분 47초')
})
test('소요 표기: 1시간 이상은 초를 뺀다', () => {
  eq(fmtDuration(65 * 60_000 + 47_000), '1시간 05분')
  eq(fmtDuration(76 * 60_000 + 52_000), '1시간 16분')
})
test('소요 표기: 음수는 자르지 않고 − 를 붙인다', () => {
  eq(fmtDuration(-5_000), '−5초')
})
