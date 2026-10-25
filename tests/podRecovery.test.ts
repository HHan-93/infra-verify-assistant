// 상태보드 — 파드 복구 확정(연속 2프레임, 시각은 첫 정상 프레임)
import { test, eq } from './harness'
import { newPodCand, stepPodRecovery } from '../src/lib/podRecovery'

const S = (...a: string[]) => new Set(a)
function run(frames: [number, Set<string>][]): string {
  const c = newPodCand()
  let prev: Set<string> | undefined
  const out: string[] = []
  for (const [t, bad] of frames) {
    const r = stepPodRecovery(c, prev, bad, t)
    r.recovered.forEach((x) => out.push(`${x.workload}@${x.at}`))
    if (r.doneAt != null) out.push(`done@${r.doneAt}`)
    prev = bad
  }
  return out.join(',')
}

test('워크로드·네임스페이스 모두 연속 2프레임, 시각은 첫 정상', () => {
  eq(run([[0, S('api', 'db')], [5, S('db')], [10, S('db')], [15, S()], [20, S()]]), 'api@5,db@15,done@15')
})
test('한 프레임 튄 정상은 복구가 아니다', () => {
  eq(run([[0, S('api')], [5, S()], [10, S('api')], [15, S()], [20, S()]]), 'api@15,done@15')
})
test('처음부터 이상 없으면 아무것도 찍지 않는다', () => {
  eq(run([[0, S()], [5, S()], [10, S()]]), '')
})
