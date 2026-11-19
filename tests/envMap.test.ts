// 환경 구성도 — 2026-11-14 실제 장비 출력(IP 는 10.99 로 가림) 견본으로 파서 · 묶음 · HTML 을 확인한다
import { test, eq, ok, fixture } from './harness'
import { parseNodeFacts, parseCtrl, parseOs, parseCeph, parseK8s, buildEnvMap, renderEnvMapHtml, pickVms, serviceRoles, splitSections, diffEnvMaps, renderEnvDiffHtml, parsePkgs, osVersionRows, parsePkgTimes } from '../src/lib/envMap'

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

// OpenStack 서비스 버전 — 2026-11-17 실제 장비 rpm -qa · python 출력(contrabass01 · 04)
const n1v = () => fixture('envmap-node1.txt') + '\n' + fixture('envmap-pkgs-node1.txt')
const n4v = () => fixture('envmap-node4.txt') + '\n' + fixture('envmap-pkgs-node4.txt')
test('OpenStack 버전 — rpm 이름 · 버전-릴리스 가르기(배포판 표시 · 아키텍처 뗌), pip 줄', () => {
  const p = parsePkgs(fixture('envmap-pkgs-node1.txt'))
  const v = (n: string) => p.find((x) => x.name === n)?.ver
  eq([v('openstack-nova-api'), v('openstack-cinder'), v('openstack-dashboard-theme'), v('openstack-network-scripts-openvswitch3.4'), v('pip:masakari')], ['31.0.0-1', '26.0.0-1', '25.3.0-1', '10.11.1-7', '19.0.1.dev3'])
  // egg-info · dist-info 로 두 번 잡혀도 하나
  eq(parsePkgs('pip masakari 19.0.1\npip masakari 19.0.1').length, 1)
})
test('OpenStack 버전 — 노드별 표: 없는 서비스는 -, 도는데 못 읽은 Masakari 는 못 읽음, 플러그인(ui) 은 섞지 않는다', () => {
  const m = buildEnvMap({ at: 0, nodes: [{ out: n1v() }, { out: n4v() }], errors: {} })
  const rows = osVersionRows(m.nodes)!
  const r = (n: string) => rows.find((x) => x.name === n)?.cells
  eq(r('Cinder'), ['26.0.0-1', null])
  eq(r('Nova'), ['31.0.0-1', '31.0.0-1'])
  eq(r('Octavia'), ['16.0.0-1', null])
  eq(r('Manila'), ['20.0.0-1', null])
  eq(r('Masakari'), ['19.0.1.dev3', null])
  // 노드 1 의 견본은 pip3 list 를 masakari 로만 걸러 masakari-monitors 가 없다 — host-monitor 가 도니 '없음' 이 아니라 '못 읽음'
  eq(r('Masakari monitors'), [undefined, '19.0.1.dev2'])
  ok(!rows.some((x) => x.mixed), '같은 버전이면 다름 아님')
  ok(!m.warnings.some((w) => /버전이 노드마다/.test(w)), '확인 필요 없음')
  const h = renderEnvMapHtml(m, { title: 't' })
  ok(h.includes('OpenStack 서비스 버전') && h.includes('openstack-cinder') && h.includes('못 읽음'), '표가 그려짐')
  // 버전 조회 전 수집본(옛 명령) — 절을 그리지 않는다
  const old = buildEnvMap({ at: 0, nodes: [{ out: fixture('envmap-node1.txt') }], errors: {} })
  eq(osVersionRows(old.nodes), null)
  ok(!renderEnvMapHtml(old, { title: 't' }).includes('OpenStack 서비스 버전'), '옛 수집본은 절 없음')
})
test('OpenStack 버전 — 노드마다 다르면 확인 필요 · 노란 칸, 수집본 비교에 전 → 후', () => {
  const up = n1v().replace('openstack-cinder-26.0.0-1', 'openstack-cinder-26.1.0-1')
  const n2 = n1v().replace(/contrabass01/g, 'contrabass02')
  const m = buildEnvMap({ at: 0, nodes: [{ out: up }, { out: n2 }], errors: {} })
  ok(m.warnings.includes('Cinder 버전이 노드마다 다름: 노드 1 26.1.0-1 · 노드 2 26.0.0-1'), m.warnings.join(' | '))
  ok(renderEnvMapHtml(m, { title: 't' }).includes('<td class="vc diff">'), '노란 칸')
  const before = buildEnvMap({ at: 0, nodes: [{ out: n1v() }, { out: n4v() }], errors: {} })
  const after = buildEnvMap({ at: 1, nodes: [{ out: up }, { out: n4v() }], errors: {} })
  const sw = diffEnvMaps(before, after).sections[0].rows
  const c = sw.find((x) => x.key === 'OpenStack Cinder')!
  eq([c.before, c.after, c.mark], ['26.0.0-1', '26.1.0-1', 'chg'])
  eq(sw.find((x) => x.key === 'OpenStack Nova')?.mark, 'same')
  // 버전은 그대로 두고 릴리스만 올린 사내 수정 패치(26.0.0-1 → 26.0.0-2)도 변경으로 잡는다(11-17 사용자 결정)
  const re = buildEnvMap({ at: 1, nodes: [{ out: n1v().replace('openstack-cinder-26.0.0-1', 'openstack-cinder-26.0.0-2') }, { out: n4v() }], errors: {} })
  const cr = diffEnvMaps(before, re).sections[0].rows.find((x) => x.key === 'OpenStack Cinder')!
  eq([cr.before, cr.after, cr.mark], ['26.0.0-1', '26.0.0-2', 'chg'])
  // 2.17.6 수집본(릴리스 번호 없이 버전만)과 견주면 버전만으로 — '26.0.0 → 26.0.0-1' 이 변경으로 찍히지 않게
  const v176 = JSON.parse(JSON.stringify(before)) as typeof before
  for (const n of v176.nodes) if (n.facts?.pkgs) n.facts.pkgs = n.facts.pkgs.map((p) => (p.name.startsWith('pip:') ? p : { ...p, ver: p.ver.replace(/-.*$/, '') }))
  const c176 = diffEnvMaps(v176, before).sections[0].rows.find((x) => x.key === 'OpenStack Cinder')!
  eq([c176.before, c176.after, c176.mark], ['26.0.0', '26.0.0', 'same'])
  // 한쪽이 버전 조회 전 수집본이면 버전 줄을 싣지 않는다('신규' 로 읽히지 않게)
  const old = buildEnvMap({ at: 0, nodes: [{ out: fixture('envmap-node1.txt') }], errors: {} })
  ok(!diffEnvMaps(old, after).sections[0].rows.some((x) => x.key.startsWith('OpenStack ')), '옛 수집본과는 비교 안 함')
})
test('OpenStack 설치 저장소 — dnf 줄 끝 @저장소(11-17 dnf list 출력 줄), 노드마다 다르면 노드별로', () => {
  // 'openstack-cinder.noarch  1:26.0.0-1.el9s  @Openstack-Epoxy' 를 awk '{print $NF}' | sort -u 한 것 — 머리 줄 'Installed Packages' 의 Packages 는 버린다
  const repo = '@@QT:repo@@\n@Openstack-Epoxy\nPackages'
  const m = buildEnvMap({ at: 0, nodes: [{ out: n1v() + '\n' + repo }, { out: n4v() + '\n' + repo }], errors: {} })
  eq(m.nodes[0].facts?.repos, ['Openstack-Epoxy'])
  ok(renderEnvMapHtml(m, { title: 't' }).includes('설치 저장소: <b>Openstack-Epoxy</b>'), '표 위 한 줄')
  const m2 = buildEnvMap({ at: 0, nodes: [{ out: n1v() + '\n' + repo }, { out: n4v() + '\n@@QT:repo@@\n@Openstack-Epoxy\n@commandline' }], errors: {} })
  ok(renderEnvMapHtml(m2, { title: 't' }).includes('노드 1: Openstack-Epoxy / 노드 2: Openstack-Epoxy · 파일로 직접 설치'), '노드마다 다르면 노드별')
  // 저장소를 못 읽은 수집(dnf 없음)은 줄을 싣지 않는다
  ok(!renderEnvMapHtml(buildEnvMap({ at: 0, nodes: [{ out: n1v() }], errors: {} }), { title: 't' }).includes('설치 저장소'), '못 읽으면 없음')
})

// 다시 수집했을 때 바뀐 버전(2026-11-19 사용자 요청: '26.0.0 → 26.4.0 (2026-11-18 변경)'). 설치 시각 줄은 rpm --qf '%{NAME} %{INSTALLTIME}' 모양
test('OpenStack 버전 변경 — 직전 수집본과 견줘 칸에 이전 → 지금 · 설치한 날, 다음 수집에도 이어 감', () => {
  eq(parsePkgTimes('openstack-cinder 1763440087\npip:masakari 1763000000\nopenstack-nova-api 12\n'), { 'openstack-cinder': 1763440087000, 'pip:masakari': 1763000000000 })
  const n2 = (s: string) => s.replace(/contrabass01/g, 'contrabass02')
  const before = buildEnvMap({ at: 1, nodes: [{ out: n1v() }, { out: n2(n1v()) }], errors: {} })
  eq(before.verChanges, undefined)
  const t = Date.parse('2026-11-18T13:28:07+09:00')
  const up = (s: string) => s.replace('openstack-cinder-26.0.0-1', 'openstack-cinder-26.4.0-1') + `\n@@QT:pkgt@@\nopenstack-cinder ${t / 1000}\nopenstack-nova-api ${t / 1000 - 86400 * 30}`
  const at2 = Date.parse('2026-11-19T10:00:00+09:00')
  const after = buildEnvMap({ at: at2, nodes: [{ out: up(n1v()) }, { out: n2(n1v()) }], errors: {} }, )
  eq(after.verChanges, undefined) // prev 를 넘기지 않으면 계산하지 않는다
  const a2 = buildEnvMap({ at: at2, nodes: [{ out: up(n1v()) }, { out: n2(n1v()) }], errors: {} }, { prev: before })
  eq(a2.verChanges, [{ svc: 'Cinder', host: 'contrabass01', from: '26.0.0-1', to: '26.4.0-1', at: t, installed: true }])
  const h = renderEnvMapHtml(a2, { title: 't' })
  ok(h.includes('<span class="from">26.0.0-1</span> → <b>26.4.0-1</b><div class="when">2026-11-18 변경</div>'), '바뀐 칸')
  ok(h.includes('주황 칸 = 지난 수집 뒤 버전이 바뀐 곳'), '설명 한 줄')
  // 다음 수집에서 그대로면 이어 간다 · 노드 2 를 올렸는데 설치 시각을 못 읽었으면 수집 날짜로 '수집에서 확인'
  const at3 = Date.parse('2026-11-20T09:00:00+09:00')
  const a3 = buildEnvMap({ at: at3, nodes: [{ out: up(n1v()) }, { out: n2(n1v()).replace('openstack-cinder-26.0.0-1', 'openstack-cinder-26.4.0-1') }], errors: {} }, { prev: a2 })
  eq(a3.verChanges?.map((c) => [c.host, c.from, c.to, c.installed]), [['contrabass01', '26.0.0-1', '26.4.0-1', true], ['contrabass02', '26.0.0-1', '26.4.0-1', false]])
  ok(renderEnvMapHtml(a3, { title: 't' }).includes('2026-11-20 수집에서 확인'), '설치 시각 모름')
  // 2.17.6 수집본(버전만)에서 다시 모은 것만으로는 변경이 아니다
  const v176 = JSON.parse(JSON.stringify(before)) as typeof before
  for (const n of v176.nodes) if (n.facts?.pkgs) n.facts.pkgs = n.facts.pkgs.map((p) => (p.name.startsWith('pip:') ? p : { ...p, ver: p.ver.replace(/-.*$/, '') }))
  eq(buildEnvMap({ at: at2, nodes: [{ out: n1v() }, { out: n2(n1v()) }], errors: {} }, { prev: v176 }).verChanges, [])
  // 2.17.6 수집본 26.0.0 → 26.4.0-1 은 변경
  eq(buildEnvMap({ at: at2, nodes: [{ out: up(n1v()) }, { out: n2(n1v()) }], errors: {} }, { prev: v176 }).verChanges?.map((c) => [c.from, c.to]), [['26.0.0', '26.4.0-1']])
})
