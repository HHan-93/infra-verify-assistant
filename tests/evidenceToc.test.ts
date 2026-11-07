// 증적 원문 목차 — 묶음 가르기 · 사건 시각 정렬 · 같은 순간의 Ceph 증적 합치기
import { test, eq, ok } from './harness'
import { arrangeEvidence, evGroupOf, mergeSameCeph, resolveEvKey, tocLabel, CEPH_MERGED_KEY, strongFocusCount } from '../src/lib/evidenceToc'
import type { BoardEvidenceItem } from '../electron/shared-types'

const T = (hms: string) => new Date(`2026-10-28T${hms}+09:00`).getTime()
const ev = (key: string, title: string, capturedAt: number, extra: Partial<BoardEvidenceItem> = {}): BoardEvidenceItem => ({
  key,
  title,
  capturedAt,
  host: 'contrabass02',
  command: 'ceph log last 1000  ·  ceph -s',
  text: '',
  ...extra,
})

// 10-28 1회차 Ceph 클러스터 로그의 두 근거 줄(같은 초)
const L_DEG = '2026-10-28T02:10:34.042868+0000 mon.contrabass01 (mon.0) 216 : cluster [INF] Health check cleared: PG_DEGRADED (was: Degraded data redundancy: 2187/418875 objects degraded (0.522%), 1 pg degraded)'
const L_OK = '2026-10-28T02:10:34.042901+0000 mon.contrabass01 (mon.0) 217 : cluster [INF] Cluster is now healthy'
const cephA = () =>
  ev('ceph', 'Ceph 데이터 복구 완료: 클러스터 로그', T('11:10:48'), {
    text: `# ceph log last 1000\n${L_DEG}`,
    focus: [L_DEG],
    facts: [{ label: '툴이 degraded·misplaced 0 를 연속 2회 확인', text: '타임라인 시각' }],
  })
const cephB = () =>
  ev('cephHealthy', 'Ceph HEALTH_OK: 클러스터 로그', T('11:10:49'), {
    text: `# ceph log last 1000\n${L_DEG}\n${L_OK}`,
    focus: [L_OK],
    facts: [{ label: '툴이 HEALTH_OK 를 연속 2회 확인', text: '타임라인 시각' }],
  })

test('같은 순간의 Ceph 데이터 복구 · HEALTH_OK 는 증적 하나로 합친다(근거 줄 둘 다 진하게)', () => {
  const out = mergeSameCeph([ev('down', '호스트 DOWN', T('10:54:20')), cephA(), cephB()], T('11:10:46'), T('11:10:46'), 3000)
  eq(out.map((x) => x.key), ['down', CEPH_MERGED_KEY])
  const m = out[1]
  eq(m.focus?.slice(0, 2), [L_DEG, L_OK])
  eq(strongFocusCount(m), 2)
  eq(m.facts?.length, 2)
  ok(m.text.includes(L_OK), '나중 원문을 쓴다')
})

test('시각이 갈라지면 합치지 않는다(갈라진 것 자체가 볼 정보)', () => {
  const items = [cephA(), cephB()]
  eq(mergeSameCeph(items, T('11:10:46'), T('11:25:00'), 3000).map((x) => x.key), ['ceph', 'cephHealthy'])
  eq(mergeSameCeph(items, T('11:10:46'), null, 3000).length, 2)
})

test('나중 원문에 앞 근거 줄이 없거나 서버가 다르면 합치지 않는다', () => {
  const b = cephB()
  b.text = `# ceph log last 1000\n${L_OK}`
  eq(mergeSameCeph([cephA(), b], T('11:10:46'), T('11:10:46'), 3000).length, 2)
  const b2 = cephB()
  b2.host = 'contrabass03'
  eq(mergeSameCeph([cephA(), b2], T('11:10:46'), T('11:10:46'), 3000).length, 2)
})

test('타임라인의 ceph · cephHealthy 줄은 합친 증적으로 이어진다', () => {
  const keys = new Set(['down', CEPH_MERGED_KEY])
  eq(resolveEvKey('ceph', keys), CEPH_MERGED_KEY)
  eq(resolveEvKey('cephHealthy', keys), CEPH_MERGED_KEY)
  eq(resolveEvKey('vip', keys), null)
})

test('묶음은 장애 시작 · 노드 복귀 시각으로 가른다', () => {
  const base = T('10:54:08')
  const up = T('11:08:18')
  eq(evGroupOf(T('10:51:23'), base, up), 0)
  // 서버 시계 반올림으로 1초 앞선 VIP 이동 · 포털 첫 끊김은 장애의 결과(10-30 회차)
  eq(evGroupOf(T('10:54:07'), base, up), 1)
  eq(evGroupOf(T('10:53:50'), base, up), 0)
  eq(evGroupOf(T('10:54:08'), base, up), 1)
  eq(evGroupOf(T('11:02:39'), base, up), 1)
  eq(evGroupOf(T('11:08:18'), base, up), 2)
  // 노드가 아직 안 돌아왔으면 UP 이후는 없다
  eq(evGroupOf(T('11:30:00'), base, null), 1)
})

test('사건 시각 순으로 늘어놓고, 장애 중에 누른 분산 점검은 DOWN 이후에 든다', () => {
  const base = T('10:54:08')
  const items = [
    ev('spread', '검증 전 파드 분산 상태', T('10:51:23')),
    ev('down', '호스트 DOWN: contrabass01', T('10:54:20')),
    ev('pods:dataplatform', 'dataplatform 파드 복구 완료: 클러스터 기록', T('11:15:30')),
    ev('pods:cilium', 'cilium 파드 복구 완료: 클러스터 기록', T('11:13:21')),
    ev('spread:1', '파드 분산 상태: 10:55:14', T('10:55:14')),
  ]
  const at: Record<string, number> = { down: T('10:54:10'), 'pods:dataplatform': T('11:15:28'), 'pods:cilium': T('11:13:19') }
  const arr = arrangeEvidence(items, (it) => at[it.key] ?? null, base, T('11:08:18'))
  eq(arr.map((x) => [x.it.key, x.grp]), [['spread', 0], ['down', 1], ['spread:1', 1], ['pods:cilium', 2], ['pods:dataplatform', 2]])
  eq(tocLabel(arr[2].it, arr[2].grp), '파드 분산 상태 (장애 중)')
  eq(tocLabel(arr[3].it, arr[3].grp), 'cilium 파드 복구 완료')
  eq(tocLabel(arr[0].it, arr[0].grp), '검증 전 파드 분산 상태')
})

test('장애 주입 시각이 검증 시작보다 앞서도 검증 전 분산 점검은 DOWN 이전', () => {
  // 10-28 2회차: 주입(BMC 시계) 12:45:36 < 검증 시작 12:46:33
  const arr = arrangeEvidence([ev('spread', '검증 전 파드 분산 상태', T('12:46:33'))], () => null, T('12:45:36'), null)
  eq(arr[0].grp, 0)
})
