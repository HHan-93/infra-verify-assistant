// 파드 로그 이상 목록 — 같은 문구 합치기 · 장애 기준 구간
import { test, eq } from './harness'
import { mergeLogIssues, recordDropped, type LogIssueLike } from '../src/lib/podLogList'

const T = (hms: string) => new Date(`2026-10-30T${hms}+09:00`).getTime()
const it = (hms: string, text: string, extra: Partial<LogIssueLike> = {}): LogIssueLike => ({
  at: T(hms),
  ns: 'contrabass',
  text,
  level: 'error',
  pods: 1,
  key: `contrabass|contrabass-api-admin|${text}|${hms}`,
  count: 1,
  last: T(hms),
  ...extra,
})

test('같은 네임스페이스 · 문구 · 종류는 한 줄로 합친다(10-30 회차: 같은 줄 다섯 개)', () => {
  const rows = mergeLogIssues(
    [
      it('15:47:40', 'contrabass-api-admin: 오류'),
      it('15:47:40', 'contrabass-api-admin: 오류', { pods: 2, count: 3, last: T('15:49:00') }),
      it('15:47:40', 'contrabass-api-admin: 오류'),
      it('15:47:40', 'contrabass-api-admin: 경고', { level: 'warn', count: 9 }),
      it('15:46:00', 'contrabass-integration → 10.0.0.50:15000 연결 실패'),
    ],
    null,
    null,
  )
  eq(rows.map((r) => [r.text, r.items.length]), [
    ['contrabass-integration → 10.0.0.50:15000 연결 실패', 1],
    ['contrabass-api-admin: 오류', 3],
    ['contrabass-api-admin: 경고', 1],
  ])
  const m = rows[1]
  // 횟수는 더하고, 파드는 더하지 않고 가장 큰 값(같은 파드가 여러 서명에 걸친다), 마지막은 가장 늦은 것
  eq([m.count, m.pods, m.last], [5, 2, T('15:49:00')])
  eq(m.seg, null)
})

test('장애 시작 · 노드 UP 으로 구간을 나누고, 구간이 다르면 같은 문구도 합치지 않는다', () => {
  const base = T('15:50:24')
  const up = T('16:00:00')
  const rows = mergeLogIssues(
    [it('15:47:40', 'a: 오류'), it('15:52:00', 'a: 오류'), it('15:53:00', 'a: 오류'), it('16:01:00', 'b: 오류'), it('15:50:20', 'c: 오류')],
    base,
    up,
  )
  eq(
    rows.map((r) => [r.seg, r.text, r.items.length]),
    [
      [0, 'a: 오류', 1],
      // 장애 시작 4초 전(15초 안쪽)은 장애의 결과로 본다(evidenceToc 와 같은 기준)
      [1, 'c: 오류', 1],
      [1, 'a: 오류', 2],
      [2, 'b: 오류', 1],
    ],
  )
})

test('한도를 넘은 종류는 한 번만 세고, 처음 넘친 시각은 가장 이른 것', () => {
  let d = recordDropped(undefined, 'a1', T('16:10:00'), 3)
  eq([d.changed, d.next.keys, d.next.since], [true, ['a1'], T('16:10:00')])
  d = recordDropped(d.next, 'a1', T('16:11:00'), 3)
  eq([d.changed, d.next.keys.length], [false, 1])
  d = recordDropped(d.next, 'b2', T('16:05:00'), 3)
  eq([d.next.keys, d.next.since], [['a1', 'b2'], T('16:05:00')])
  d = recordDropped(d.next, 'c3', T('16:12:00'), 3)
  // 해시 목록 상한(3)에 닿으면 더 늘지 않는다
  d = recordDropped(d.next, 'd4', T('16:13:00'), 3)
  eq([d.changed, d.next.keys.length], [false, 3])
})
