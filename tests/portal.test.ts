// 포털 감시 — 복구는 연속 N회 성공의 첫 성공, 한 번 튄 실패로 복구를 취소하지 않는다
import { test, eq } from './harness'
import { applyObservation, emptyTargetState } from '../src/lib/portal'

const T = 1_760_000_000_000
function rec(seq: [number, boolean][]): number | null {
  let st = emptyTargetState()
  for (const [sec, ok] of seq) st = applyObservation(st, { at: T + sec * 1000, ok, reasons: [] }, 3)
  return st.recoveredAt === null ? null : (st.recoveredAt - T) / 1000
}

test('처음 복구 — 연속 3회의 첫 성공', () => eq(rec([[0, false], [5, false], [10, true], [15, true], [20, true]]), 10))
test('튄 성공은 복구 아님', () => eq(rec([[0, false], [5, true], [10, false], [15, true]]), null))
test('복구 뒤 한 번 튄 실패는 무시', () => eq(rec([[0, false], [60, true], [65, true], [70, true], [600, false], [605, true]]), 60))
test('복구 뒤 연속 3회 실패면 취소', () => eq(rec([[0, false], [60, true], [65, true], [70, true], [600, false], [605, false], [610, false]]), null))
test('재장애 뒤 최종 복구 시각으로', () =>
  eq(rec([[0, false], [60, true], [65, true], [70, true], [120, false], [125, false], [130, false], [200, true], [205, true], [210, true]]), 200))
