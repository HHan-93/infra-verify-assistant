// Valkey 마스터 배치 점검 — 줄 모양은 2026-11-18 epoxy 의 dataplatform/valkey-cluster(마스터 0 · 1 · 2, 레플리카 3 · 4 · 5)
// /data/nodes.conf 를 awk 로 줄여 본 결과를 nodes.conf 원래 칸 순서(id 주소 깃발 마스터 ping pong epoch link 슬롯)로 되돌린 것이다.
// id 는 앞 4글자만 실제와 같은 모양으로 지었고 IP 는 문서용 대역(192.0.2.x)이다 — 레포가 공개라 내부 주소를 넣지 않는다
import { test, eq } from './harness'
import { findValkeySets, judgeValkey, parseNodesConf, valkeyBad, valkeyCmd, type ValkeySet } from '../src/lib/valkeySpread'
import { parseSpread } from '../src/lib/podSpread'

const id = (c: string) => c.repeat(40)
const host = (pod: string) => `${pod}.valkey-cluster-headless.dataplatform.svc.cluster.local`
const line = (i: string, pod: string, ip: string, flags: string, master: string, slots = '') =>
  `${id(i)} ${ip}:6379@16379,${host(pod)} ${flags} ${master} 0 1763430000000 3 connected${slots ? ' ' + slots : ''}`

const ctrl = JSON.stringify({
  items: [
    {
      kind: 'StatefulSet',
      metadata: { name: 'valkey-cluster', namespace: 'dataplatform' },
      spec: { replicas: 6, template: { spec: { containers: [{ name: 'metrics', image: 'oliver006/redis_exporter' }, { name: 'valkey', image: 'docker.io/valkey/valkey:8.1' }] } } },
    },
    { kind: 'StatefulSet', metadata: { name: 'okestro-db-pxc', namespace: 'dataplatform' }, spec: { replicas: 3, template: { spec: { containers: [{ name: 'pxc', image: 'percona/pxc' }] } } } },
  ],
})
const pods = [0, 1, 2, 3, 4, 5]
  .map((n) => `dataplatform  valkey-cluster-${n}  epoxy-infra-${(n % 3) + 1}  Running  <none>  StatefulSet  valkey-cluster  192.0.2.${10 + n}`)
  .concat(['dataplatform  okestro-db-pxc-0  epoxy-infra-1  Running  <none>  StatefulSet  okestro-db-pxc  192.0.2.30'])
  .join('\n')
const set = (): ValkeySet => findValkeySets(ctrl, pods, ['dataplatform'])[0]
const out = (conf: string[], cj = 'valkey-cluster-maintenance-cronjob   2026-11-18T01:35:00Z   */5 * * * *') =>
  `__QT_FROM__ valkey-cluster-1\n${conf.join('\n')}\nvars currentEpoch 6 lastVoteEpoch 0\n__QT_CJ__\n${cj}\n`

test('대상 찾기 — 이미지에 valkey 가 든 StatefulSet 만, 컨테이너 이름 · Running 파드 · IP', () => {
  const s = findValkeySets(ctrl, pods, ['dataplatform'])
  eq(s.length, 1)
  eq(s[0].name, 'valkey-cluster')
  eq(s[0].container, 'valkey')
  eq(s[0].pods.length, 6)
  eq(s[0].pods[1], { pod: 'valkey-cluster-1', node: 'epoxy-infra-2', ip: '192.0.2.11' })
  eq(findValkeySets(ctrl, pods, ['other']).length, 0)
})

test('읽기 명령 — 서로 다른 노드의 파드 3개까지 차례로', () => {
  const cmd = valkeyCmd(set())
  eq(cmd.includes('for p in valkey-cluster-0 valkey-cluster-1 valkey-cluster-2;'), true)
  eq(cmd.includes('-c valkey '), true)
})

test('2026-11-18 실제 배치 — 마스터 0 · 1 · 2 가 노드마다 하나, 레플리카는 다른 노드', () => {
  const v = judgeValkey(
    set(),
    out([
      line('b', 'valkey-cluster-1', '192.0.2.11', 'myself,master', '-', '5461-10922'),
      line('e', 'valkey-cluster-5', '192.0.2.15', 'slave', id('a')),
      line('a', 'valkey-cluster-0', '192.0.2.10', 'master', '-', '0-5460'),
      line('d', 'valkey-cluster-3', '192.0.2.13', 'slave', id('b')),
      line('f', 'valkey-cluster-4', '192.0.2.14', 'slave', id('c')),
      line('c', 'valkey-cluster-2', '192.0.2.12', 'master', '-', '10923-16383'),
    ]),
    true,
  )
  eq(v.verdict, 'ok')
  eq(v.from, 'valkey-cluster-1')
  eq(
    v.masters.map((m) => [m.pod, m.node, m.slots, m.replicas.map((r) => r.node).join()]),
    [
      ['valkey-cluster-0', 'epoxy-infra-1', '0-5460', 'epoxy-infra-3'],
      ['valkey-cluster-1', 'epoxy-infra-2', '5461-10922', 'epoxy-infra-1'],
      ['valkey-cluster-2', 'epoxy-infra-3', '10923-16383', 'epoxy-infra-2'],
    ],
  )
  eq(v.cron, [{ name: 'valkey-cluster-maintenance-cronjob', last: Date.parse('2026-11-18T01:35:00Z'), schedule: '*/5 * * * *' }])
  eq(valkeyBad(v), false)
})

test('페일오버 뒤 마스터 두 개가 한 노드에 — 몰림', () => {
  // infra-1 장애로 cluster-0 의 슬롯을 cluster-4(infra-2)가 받았고 cluster-1 도 infra-2
  const v = judgeValkey(
    set(),
    out([
      line('b', 'valkey-cluster-1', '192.0.2.11', 'myself,master', '-', '5461-10922'),
      line('f', 'valkey-cluster-4', '192.0.2.14', 'master', '-', '0-5460'),
      line('a', 'valkey-cluster-0', '192.0.2.10', 'slave', id('f')),
      line('c', 'valkey-cluster-2', '192.0.2.12', 'master', '-', '10923-16383'),
      line('d', 'valkey-cluster-3', '192.0.2.13', 'slave', id('b')),
      line('e', 'valkey-cluster-5', '192.0.2.15', 'slave', id('a')),
    ]),
    true,
  )
  eq(v.verdict, 'stacked')
  eq(v.stackedNodes, [{ node: 'epoxy-infra-2', count: 2 }])
  eq(v.masters.filter((m) => m.stacked).map((m) => m.pod), ['valkey-cluster-4', 'valkey-cluster-1'])
  eq(valkeyBad(v), true)
})

test('마스터와 그 레플리카가 같은 노드 — 같은 노드', () => {
  const v = judgeValkey(
    set(),
    out([
      line('a', 'valkey-cluster-0', '192.0.2.10', 'master', '-', '0-5460'),
      line('b', 'valkey-cluster-1', '192.0.2.11', 'master', '-', '5461-10922'),
      line('c', 'valkey-cluster-2', '192.0.2.12', 'master', '-', '10923-16383'),
      line('d', 'valkey-cluster-3', '192.0.2.13', 'slave', id('a')), // 둘 다 infra-1
      line('e', 'valkey-cluster-4', '192.0.2.14', 'slave', id('c')),
      line('f', 'valkey-cluster-5', '192.0.2.15', 'slave', id('b')),
    ]),
    true,
  )
  eq(v.verdict, 'same')
  eq(v.masters.filter((m) => m.same).map((m) => [m.pod, m.node]), [['valkey-cluster-0', 'epoxy-infra-1']])
})

test('주소에 hostname 이 없으면 IP 로 파드를 찾는다', () => {
  const n = parseNodesConf(`${id('a')} 192.0.2.10:6379@16379 master - 0 0 1 connected 0-5460`)
  eq(n[0].pod, '192.0.2.10')
  const v = judgeValkey(set(), out([`${id('a')} 192.0.2.10:6379@16379 master - 0 0 1 connected 0-5460`]), true)
  eq(v.masters[0].node, 'epoxy-infra-1')
})

test('읽지 못함 — 확인 못 함(몰림으로 치지 않는다)', () => {
  const v = judgeValkey(set(), '__QT_CJ__\n', true)
  eq(v.verdict, 'error')
  eq(valkeyBad(v), false)
  eq(judgeValkey(set(), '', false).verdict, 'error')
})

test('분산 점검 파드 줄에 IP 칸이 붙어도 워크로드 판정은 그대로', () => {
  const rows = parseSpread(ctrl, pods, ['dataplatform'])
  eq(rows?.find((w) => w.name === 'valkey-cluster')?.placement, { 'epoxy-infra-1': 2, 'epoxy-infra-2': 2, 'epoxy-infra-3': 2 })
})
