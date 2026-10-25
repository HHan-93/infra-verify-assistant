// 목표 복구 시간 입력 — 여러 표기를 같은 초로, 못 읽으면 null
import { test, eq } from './harness'
import { parseDurationInput as p } from '../src/lib/durationInput'

test('분:초 · 한글 단위 · 숫자만', () => eq([p('1:30'), p('0:30'), p('1분 30초'), p('1분30초'), p('1분'), p('30초'), p('90'), p('2.5분')], [90, 30, 90, 90, 60, 30, 90, 150]))
test('영문 단위', () => eq([p('1m30s'), p('5 min'), p('45s')], [90, 300, 45]))
test('빈 칸·0 은 판정 안 함, 못 읽으면 null', () => eq([p(''), p('  '), p('0'), p('0:00'), p('1:75'), p('abc'), p('1시간')], [undefined, undefined, undefined, undefined, null, null, null]))
