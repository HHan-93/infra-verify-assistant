// 상태보드 증적 파서 — pcs 역할 · crm_mon 동작 이력 · 로그 시각 · Nova evacuation · k8s 워크로드
import { test, eq, ok, fixture } from './harness'
import {
  parsePcsRoles,
  parseCrmOps,
  parseCtimeLocal,
  parseLogTime,
  parseEvacMigrations,
  parseControllers,
  podFactsFromJson,
} from '../src/lib/clusterEvidence'

const kst = (ms: number) => new Date(ms).toLocaleTimeString('en-GB', { timeZone: 'Asia/Seoul', hour12: false })

test('pcs 역할 — 실제 출력: DC · 그룹 · 단독 리소스', () => {
  const r = parsePcsRoles(fixture('pcs-status-full.txt'))
  eq(r.dc, 'contrabass03')
  eq(
    r.resources.map((x) => `${x.name}@${x.owners.join(',')}${x.group ? `[${x.group}]` : ''}${x.unit ? `{${x.unit}}` : ''}`),
    ['int_vip@contrabass01[openstack]', 'haproxy@contrabass01[openstack]{haproxy}', 'openstack_exporter@contrabass01[openstack]{openstack-exporter}', 'thanos-compact-timer@contrabass02{thanos-compact.timer}'],
  )
})

test('pcs 역할 — 전환 중·멈춤은 주인이 없다(가짜 이동 방지)', () => {
  const r = parsePcsRoles(`Full List of Resources:
  * Clone Set: galera-clone [galera] (promotable):
    * Promoted: [ con01 ]
    * Unpromoted: [ con02 con03 ]
  * Clone Set: rabbit-clone [rabbit]:
    * Started: [ con01 con02 con03 ]
  * int_vip	(ocf:heartbeat:IPaddr2):	 Stopped
  * haproxy (systemd:haproxy): FAILED con02 (blocked)
  * Current DC: NONE`)
  eq(r.resources.map((x) => `${x.name}:${x.owners}/${x.standbys}`), ['galera:con01/con02,con03', 'int_vip:/', 'haproxy:/'])
})

test('crm_mon 동작 이력 — 노드·리소스·동작·시각', () => {
  const ops = parseCrmOps(fixture('crm_mon-t.txt'))
  const vip = ops.find((o) => o.resource === 'int_vip' && o.op === 'start')
  ok(vip, 'int_vip start 없음')
  eq([vip?.node, vip?.raw, vip?.rc], ['contrabass01', 'Wed Oct 14 10:42:56 2026', 0])
})

test('crm_mon — 못 읽은 머리줄 아래 동작을 앞 리소스에 붙이지 않는다', () => {
  const ops = parseCrmOps(`Operations:
  * Node: con01:
    * int_vip: migration-threshold=1000000:
      * (11) start: last-rc-change="Wed Oct 14 10:42:56 2026" exec-time="60ms" queue-time="0ms" rc=0 (ok)
    * galera:0: migration-threshold=1000000:
      * (30) promote: last-rc-change="Wed Oct 14 10:50:00 2026" exec-time="60ms" queue-time="0ms" rc=0 (ok)
    * weird thing: something
      * (31) start: last-rc-change="Wed Oct 14 10:51:00 2026" exec-time="60ms" queue-time="0ms" rc=0 (ok)`)
  eq(ops.map((o) => `${o.resource} ${o.op}`), ['int_vip start', 'galera promote'])
})

test('ctime 표기 → 로컬 시각', () => {
  eq(kst(parseCtimeLocal('Wed Oct 14 10:42:56 2026') as number), '10:42:56')
  eq(parseCtimeLocal('garbage'), null)
})

test('로그 줄 시각 — short-iso · ceph · uptime -s · UTC', () => {
  const j = parseLogTime(fixture('journal-corosync.txt').split('\n')[1])
  eq([j?.tz, new Date(j?.ms as number).toISOString()], [true, '2026-10-20T09:03:45.000Z'])
  eq(parseLogTime('2026-10-22T15:03:40.123456+0900 mon.a cluster [INF] ok')?.ms, Date.parse('2026-10-22T06:03:40.123Z'))
  eq(parseLogTime('2026-10-22 14:55:10')?.tz, false)
  eq(parseLogTime('Oct 22 14:20:07 host corosync'), null)
})

test('corosync 저널 — 노드 번호로 그 노드 줄만', () => {
  // captureDown 의 정규식과 같은 규칙: host: <번호> · left…: <번호> · 노드 이름
  const id = '3'
  const re = new RegExp(`host:\\s*${id}\\b|left[^:\\n]*:[\\s\\d]*\\b${id}\\b|\\bcontrabass03\\b`, 'i')
  const lines = fixture('journal-corosync.txt').split('\n').filter(Boolean)
  eq(lines.map((l) => re.test(l)), [false, true, false, true])
  ok(!re.test('[KNET  ] link: host: 13 link: 0 is down'), 'host: 13 을 3 으로 보면 안 된다')
  ok(re.test('[QUORUM] Sync left[1]: 3') && !re.test('[QUORUM] Sync left[1]: 13'))
})

test('Nova evacuation — UTC → KST, 같은 VM 은 마지막 레코드, 회차 밖 제외', () => {
  const since = Date.parse('2026-08-12T07:00:00Z')
  const v = parseEvacMigrations(fixture('nova-migration-list.json'), since) ?? []
  eq(v.length, 1, '회차 밖(08-11) 제외 · 같은 VM 둘은 하나로')
  eq([v[0].src, v[0].dest, kst(v[0].createdAt), kst(v[0].updatedAt), v[0].done], ['con01', 'con02', '16:54:05', '17:05:53', true])
})

test('Nova — 조회 실패(문구)는 null, 빈 배열은 기록 없음', () => {
  eq(parseEvacMigrations('Missing value auth-url required for auth plugin password', 0), null)
  eq(parseEvacMigrations('[]', 0), [])
})

test('k8s 워크로드 Ready 수', () => {
  const j = JSON.stringify({
    items: [
      { kind: 'Deployment', metadata: { name: 'api' }, spec: { replicas: 3 }, status: { readyReplicas: 2 } },
      { kind: 'StatefulSet', metadata: { name: 'db' }, spec: { replicas: 3 }, status: {} },
      { kind: 'DaemonSet', metadata: { name: 'cilium' } },
    ],
  })
  eq(parseControllers(j), [
    { kind: 'Deployment', name: 'api', replicas: 3, ready: 2 },
    { kind: 'StatefulSet', name: 'db', replicas: 3, ready: 0 },
  ])
  eq(parseControllers('error: the server is unavailable'), null)
})

test('k8s 파드 시각', () => {
  const f = podFactsFromJson(
    JSON.stringify({
      items: [
        {
          metadata: { name: 'a-1', creationTimestamp: '2026-10-22T02:00:00Z' },
          spec: { nodeName: 'n1' },
          status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True', lastTransitionTime: '2026-10-22T02:00:30Z' }], containerStatuses: [{ restartCount: 1, state: { running: { startedAt: '2026-10-22T02:00:20Z' } } }] },
        },
      ],
    }),
  )
  eq([f[0].ready, kst(f[0].readyAt as number), f[0].restarts], [true, '11:00:30', 1])
})
