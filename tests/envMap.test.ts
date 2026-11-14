// 환경 구성도 — 2026-11-14 실제 장비 출력(IP 는 10.99 로 가림) 견본으로 파서 · 묶음 · HTML 을 확인한다
import { test, eq, ok, fixture } from './harness'
import { parseNodeFacts, parseCtrl, parseOs, parseCeph, parseK8s, buildEnvMap, renderEnvMapHtml, pickVms, serviceRoles, splitSections, diffEnvMaps, renderEnvDiffHtml } from '../src/lib/envMap'

const osRaw = () => {
  const j = JSON.parse(fixture('envmap-openstack.json'))
  return {
    servers: JSON.stringify(j.servers),
    hypervisors: JSON.stringify(j.hypervisors),
    flavors: JSON.stringify(j.flavors),
    computes: JSON.stringify(j.computes),
    segments: JSON.stringify(j.segments),
    segHosts: Object.fromEntries(Object.entries(j.segHosts).map(([k, v]) => [k, JSON.stringify(v)])),
  }
}

test('구역 나누기 — 표시 줄 사이 출력만', () => {
  eq(splitSections("@@QT:a@@\nx\ny\n@@QT:b@@\nz"), { a: 'x\ny', b: 'z' })
})

test('물리 노드 — OS · 커널 · CPU · 메모리 · 인터페이스 · NTP', () => {
  const f = parseNodeFacts(fixture('envmap-node1.txt'))!
  eq([f.host, f.os, f.kernel, f.cpus, f.sockets, f.memGiB], ['contrabass01', 'Rocky Linux 9.6 (CIQ LTS)', '5.14.0-570.60.1', 96, 2, 503])
  eq(f.ifaces.find((x) => x.name === 'vlan.1120')?.addrs, ['10.99.120.1', '10.99.120.50'])
  eq(f.ntp, { refId: 'CBF8F08C', name: 'ntp.example.net', stratum: 3 })
  const r = serviceRoles(f.units)
  eq([r.controller, r.compute, r.nova, r.neutron, r.masakari], [true, true, ['api', 'conductor', 'scheduler', 'noVNC', 'compute'], ['server', 'DHCP', 'L3', 'metadata', 'OVS'], ['api', 'engine', 'host-monitor']])
  // 컴퓨트 노드 — 컨트롤러 서비스 없음, mysql 은 돈다(클러스터 밖)
  const r4 = serviceRoles(parseNodeFacts(fixture('envmap-node4.txt'))!.units)
  eq([r4.controller, r4.compute, r4.nova, r4.masakari, r4.mysql, r4.rabbit], [false, true, ['compute'], ['host-monitor'], true, false])
})

test('컨트롤러 — pcs DC · 리소스 위치 · RabbitMQ · Galera(표 꼴)', () => {
  const c = parseCtrl(fixture('envmap-ctrl.txt'))
  eq([c.pcs?.dc, c.pcs?.online.length, c.pcs?.resources.map((r) => `${r.name}@${r.node}`)], ['contrabass02', 4, ['int_vip@contrabass01', 'haproxy@contrabass01', 'openstack_exporter@contrabass01', 'thanos-compact-timer@contrabass02']])
  eq(c.rabbit, { disk: ['contrabass01', 'contrabass02', 'contrabass03'], running: ['contrabass01', 'contrabass02', 'contrabass03'], version: '4.1.2' })
  eq(c.galera, { size: 3, members: ['contrabass01', 'contrabass02', 'contrabass03'], state: 'Synced' })
  // 비대화형 mysql -e 는 표 대신 탭으로 낸다
  eq(parseCtrl("@@QT:galera@@\nVariable_name\tValue\nwsrep_cluster_size\t3\nwsrep_incoming_addresses\ta:3306,b:3306\nwsrep_local_state_comment\tSynced").galera, { size: 3, members: ['a', 'b'], state: 'Synced' })
})

test('OpenStack JSON — VM 망 · HA_Enabled · flavor · 세그먼트', () => {
  const o = parseOs(osRaw())
  const d = o.vms!.find((v) => v.name === 'Epoxy_Deploy')!
  eq([d.host, d.ha, d.ips.map((x) => x.net)], ['contrabass01', true, ['vm_mgmt', 'vm_ceph']])
  eq(o.flavors!['Epoxy_Manager_flavor3'], { vcpus: 8, ramMB: 24576 })
  eq(o.segments, [{ name: 'HA_qa', recovery: 'auto', hosts: ['contrabass04', 'contrabass03', 'contrabass02', 'contrabass01'].map((name) => ({ name, maintenance: false, reserved: false })) }])
})

test('Ceph — 호스트별 데몬 · active · 복제 · 경고', () => {
  const c = parseCeph(fixture('envmap-ceph.txt'))!
  eq([c.version, c.health, c.healthMsgs, c.osdNum, c.replicas], ['19.2.3', 'HEALTH_WARN', ['mon contrabass01 is low on available space'], 7, ['복제 3 (min 2)']])
  eq(c.hosts.contrabass02, { mon: true, mgr: true, mgrActive: true, mds: true, mdsActive: true, rgw: true, osds: [3, 4] })
  eq(c.hosts.contrabass04, { mon: false, mgr: false, mgrActive: false, mds: false, mdsActive: false, rgw: false, osds: [0] })
})

test('k8s — ReplicaSet 을 Deployment 로 · Pending · 정적 파드 · Job 뺌 · DaemonSet 준비 수', () => {
  const k = parseK8s(fixture('envmap-k8s.txt'))!
  eq([k.version, k.nodes.length, k.nodes.filter((n) => !n.ready).map((n) => n.name)], ['v1.34.11', 8, ['epoxy-infra-3', 'epoxy-master-3']])
  const w = (n: string) => k.workloads.find((x) => x.name === n)!
  eq([w('percona-xtradb-cluster-operator').kind, w('percona-xtradb-cluster-operator').pending, w('percona-xtradb-cluster-operator').at['epoxy-infra-1']], ['Deploy', 1, 1])
  eq([w('harbor-db').kind, w('valkey-cluster').kind, w('valkey-cluster').at['epoxy-infra-2']], ['Cluster', 'STS', 2])
  ok(!k.workloads.some((x) => /cronjob|cilium$/.test(x.name)), 'Job · DaemonSet 파드는 워크로드 줄에 넣지 않는다')
  eq(k.statics, ['kube-apiserver', 'kube-scheduler'])
  eq(k.daemonsets.find((d) => d.name === 'prometheus-stack-prometheus-node-exporter'), { ns: 'monitoring', name: 'prometheus-stack-prometheus-node-exporter', desired: 8, ready: 0 })
})

test('VM 고르기 — k8s 노드와 IP 가 같은 VM 의 이름 머리(Epoxy_)로, 상관없는 VM 은 뺀다', () => {
  const vms = parseOs(osRaw()).vms!
  const k = parseK8s(fixture('envmap-k8s.txt'))!
  const names = pickVms(vms, new Set(k.nodes.map((n) => n.ip))).map((v) => v.name)
  eq(names.length, 13)
  ok(!names.some((n) => /pqa|hh-|service_|amphora/.test(n)), '검증 기본 구성 밖 VM')
})

test('묶음 — 관리 IP · VIP · 역할 · 클러스터 밖 mysql · k8s 노드의 물리 노드 · 확인 필요', () => {
  const m = buildEnvMap({
    at: 0,
    nodes: [{ out: fixture('envmap-node1.txt') }, { out: fixture('envmap-node4.txt') }],
    ctrl: fixture('envmap-ctrl.txt'),
    os: osRaw(),
    ceph: fixture('envmap-ceph.txt'),
    k8s: fixture('envmap-k8s.txt'),
    errors: {},
  })
  // 노드 세션이 둘뿐이어도 Nova · pcs 에 있는 노드는 모두 나온다
  eq(m.nodes.map((n) => `${n.label}:${n.host}:${n.mgmtIp}:${n.role}`), ['노드 1:contrabass01:10.99.120.1:mixed', '노드 2:contrabass02:10.99.120.2:compute', '노드 3:contrabass03:10.99.120.3:compute', '노드 4:contrabass04:10.99.120.4:compute'])
  eq([m.nodes[0].vip, m.nodes[0].pcs?.resources, m.nodes[1].pcs?.dc], ['10.99.120.50', ['int_vip', 'haproxy', 'openstack_exporter'], true])
  eq([m.nodes[0].mysql, m.nodes[3].mysql, m.nodes[3].rabbit], ['member', 'outside', undefined])
  eq(m.vms.filter((v) => v.ha).map((v) => v.name), ['Epoxy_Deploy', 'Epoxy_Backup'])
  eq(m.vms.find((v) => v.name === 'Epoxy_Infra2'), { name: 'Epoxy_Infra2', host: 'contrabass02', ip: '10.99.120.65', vcpus: 8, ramGB: 16, status: 'ACTIVE', hostStatus: 'UP', ha: false, k8s: 'epoxy-infra-2' })
  eq(m.k8s?.nodes.find((n) => n.name === 'epoxy-manager-1')?.host, 'contrabass01')
  eq(m.ntpName, 'ntp.example.net')
  ok(m.warnings.some((w) => /HEALTH_WARN/.test(w)), 'Ceph 경고')
  ok(m.warnings.some((w) => /노드 4\(contrabass04\).*mysql/.test(w)), '클러스터 밖 mysql')
  ok(m.warnings.some((w) => /NotReady 2/.test(w)) && m.warnings.some((w) => /Pending\) 파드 1/.test(w)) && m.warnings.some((w) => /node-exporter 0\/8/.test(w)), 'k8s 확인 필요')
  // HTML — 띠가 노드1~3 만(RabbitMQ · Galera), 몰림 표시, 화면 문구에 '—' 없음
  const h = renderEnvMapHtml(m, { title: '환경 구성도' })
  ok(/grid-column:1 \/ 4;grid-row:3"><i>RabbitMQ 3\/3 · Galera 3\/3 Synced/.test(h), 'RabbitMQ · Galera 띠는 노드 1~3')
  ok(h.includes('1대에 몰림') && h.includes('VIP 10.99.120.50') && h.includes('MGR active'), '몰림 · VIP · active')
  ok(!h.includes('—'), "화면 문구에 '—'")
})

test('VM 고르기 — k8s 를 못 읽으면 환경의 실제 이름에서 머리만 찾는다(웹 서비스 VM 이름을 그대로 넣지 않는다)', () => {
  const vms = parseOs(osRaw()).vms!
  const names = pickVms(vms, new Set(), ['Epoxy_Master1', 'Epoxy_Infra1', 'service_vm01']).map((v) => v.name)
  eq([names.length, names.includes('service_vm01')], [13, false])
})

test('노드 — 연결된 다른 세션(k8s VM 등)의 결과는 버리고, 같은 호스트를 두 번 읽어도 하나', () => {
  const vmOut = fixture('envmap-node4.txt').replace(/^contrabass04$/m, 'epoxy-master-2')
  const m = buildEnvMap({ at: 0, nodes: [{ out: fixture('envmap-node1.txt') }, { out: fixture('envmap-node1.txt') }, { out: fixture('envmap-node4.txt') }, { out: vmOut }], os: osRaw(), errors: {} })
  eq(m.nodes.map((n) => [n.host, !!n.facts]), [['contrabass01', true], ['contrabass02', false], ['contrabass03', false], ['contrabass04', true]])
})

test('검토 지적 — 조회 실패를 다른 것으로 그리지 않는다', () => {
  // mysql 접속 실패 · rabbitmqctl 꼴이 달라 클러스터 상태를 못 읽음 → 'outside(구성 미포함)' 가 아니라 'unread' + 못 읽음
  const ctrl = '@@QT:pcs@@\n' + splitSections(fixture('envmap-ctrl.txt')).pcs + "\n@@QT:rabbit@@\nError: unable to perform an operation\n@@QT:galera@@\nERROR 1045 (28000): Access denied for user 'root'@'localhost'"
  const m = buildEnvMap({ at: 0, nodes: [{ out: fixture('envmap-node1.txt') }, { out: fixture('envmap-node4.txt') }], ctrl, errors: {} })
  eq([m.nodes[0].mysql, m.nodes[3].mysql, m.nodes[0].rabbit], ['unread', 'unread', 'unread'])
  ok(!m.warnings.some((w) => /구성원이 아님/.test(w)), '못 읽은 것을 구성 미포함으로 경고하지 않는다')
  ok(!!m.errors.Galera && !!m.errors.RabbitMQ, '못 읽음으로 올린다')
  // kubectl 경고 줄이 앞에 와도 머리줄을 찾는다 · 파드 머리줄이 없으면 podsOk=false(워크로드 0 으로 보이지 않게)
  const k = fixture('envmap-k8s.txt').replace('@@QT:nodes@@\n', '@@QT:nodes@@\nE1114 memcache.go:265] couldn\'t get current server API group list\n').replace(/@@QT:pods@@[\s\S]*?@@QT:ds@@/, '@@QT:pods@@\nerror: the server doesn\'t have a resource type "pods"\n@@QT:ds@@')
  const kf = parseK8s(k)!
  eq([kf.nodes.length, kf.podsOk, kf.workloads.length], [8, false, 0])
  const mk = buildEnvMap({ at: 0, nodes: [], k8s: k, errors: {} })
  ok(!!mk.errors['k8s 파드'], '파드 못 읽음')
})

test('검토 지적 — pcs standby · FQDN 이름 · 옛 HA_Enabled 문자열 · 경고 줄 뒤 JSON', () => {
  const p = parseCtrl("@@QT:pcs@@\nNode List:\n  * Node contrabass03.example.local: standby\n  * Online: [ contrabass01.example.local contrabass02.example.local ]\n\nFull List of Resources:\n  * int_vip   (ocf:heartbeat:IPaddr2):   Started contrabass01.example.local\n@@QT:rabbit@@\nDisk Nodes\n\nrabbit@contrabass01.example.local\n\nRunning Nodes\n\nrabbit@contrabass01.example.local\n")
  eq([p.pcs?.online, p.pcs?.standby, p.pcs?.resources[0].node, p.rabbit?.running], [['contrabass01', 'contrabass02'], ['contrabass03'], 'contrabass01', ['contrabass01']])
  const old = parseOs({ servers: JSON.stringify([{ Name: 'Epoxy_Deploy', Status: 'ACTIVE', Networks: 'vm_mgmt=10.99.120.70', Flavor: 'x', Host: 'h1', Properties: "HA_Enabled='True'" }]) }).vms!
  eq([old[0].ha, old[0].ips], [true, [{ net: 'vm_mgmt', ip: '10.99.120.70' }]])
  eq(parseOs({ hypervisors: "WARNING: option [x] is deprecated\n[{\"Hypervisor Hostname\": \"h1\", \"Host IP\": \"10.0.0.1\", \"State\": \"up\"}]" }).hyper, [{ host: 'h1', ip: '10.0.0.1', state: 'up' }])
})

test('수집본 비교 — 변경 · 신규 · 동일 셋만, 분산이 나빠진 워크로드는 맨 위', () => {
  const full = () =>
    buildEnvMap({ at: 0, nodes: [{ out: fixture('envmap-node1.txt') }, { out: fixture('envmap-node4.txt') }], ctrl: fixture('envmap-ctrl.txt'), os: osRaw(), ceph: fixture('envmap-ceph.txt'), k8s: fixture('envmap-k8s.txt'), errors: {} })
  const a = full()
  const same = diffEnvMaps(a, full())
  eq([same.counts.chg, same.counts.add], [0, 0])
  const b = full()
  // VM 하나 이동 · 하나 삭제 · 하나 신규, 워크로드 하나 몰림, 버전 하나 변경
  b.vms = b.vms.map((v) => (v.name === 'Epoxy_Biz1' ? { ...v, host: 'contrabass01' } : v)).filter((v) => v.name !== 'Epoxy_Biz3')
  b.vms.push({ name: 'Epoxy_Manager3', host: 'contrabass03', ip: '10.99.120.80', status: 'ACTIVE', hostStatus: 'UP', ha: false })
  b.k8s = { ...b.k8s!, version: 'v1.35.0', workloads: b.k8s!.workloads.map((w) => (w.name === 'boot-factory-auth' ? { ...w, at: { 'epoxy-manager-1': 2 } } : w)) }
  const d = diffEnvMaps(a, b)
  const rowOf = (k: string) => d.sections.flatMap((s) => s.rows).find((r) => r.key === k)!
  eq([rowOf('Biz1').mark, rowOf('Biz3').mark, rowOf('Biz3').after, rowOf('Manager3').mark, rowOf('Kubernetes').mark], ['chg', 'chg', '없음', 'add', 'chg'])
  const k8s = d.sections.find((s) => s.title.startsWith('k8s'))!
  eq([k8s.rows[0].key, k8s.rows[0].worse, k8s.rows[0].after], ['boot-factory / boot-factory-auth', true, '레플리카 2 · 1대에 몰림'])
  const h = renderEnvDiffHtml(a, b, { title: '환경 구성도 비교', nameA: 'V3', nameB: 'V4' })
  ok(h.includes('>변경<b>') && h.includes('>신규<b>') && h.includes('>동일<b>') && !/바뀜|없어짐|새로 생김|—/.test(h), '표시 문구')
})
