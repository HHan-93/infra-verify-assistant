/**
 * 환경 구성도(2026-11-14 사용자 요청 · 목업 envmap-mock4) — 가용성 검증 환경을 **조회 명령만으로** 모아 리포트와 별도 HTML 로 낸다.
 * 물리 노드(OS · 서비스 · 클러스터 역할) → 노드 배치 VM → k8s 애플리케이션 배치(레플리카가 물리 노드 몇 대에 나뉘었나) → IP 목록.
 *
 * 원칙(사용자 결정):
 *  - 노드 안에서 아무것도 바꾸지 않는다. 여기 명령은 모두 읽기(hostname · systemctl list-units · pcs status · openstack … list …)
 *  - 사람이 정한 그룹 환경(표준 이름 · evacuation 대상)과 섞지 않는다 — 이 구성도는 '장비가 지금 이렇다' 이고 따로 저장한다
 *  - 네트워크는 관리 IP 하나만. 파드 IP 는 바뀌는 값이라 싣지 않는다. VM 은 검증 기본 구성만(아래 pickVms)
 *  - 이상한 것(HEALTH_WARN · NotReady · Pending …)은 그림을 바꾸지 않고 위 '확인 필요' 상자에 따로 모은다
 *  - IP 는 가리지 않는다 — 설정의 '리포트 저장 시 IP 가리기' 를 켜도 이 구성도만 예외(2026-11-14 사용자 결정: 제출용이라 IP 가 있어야 한다).
 *    그래서 maskForExport 를 거치지 않는다. 리포트 만들기 창의 체크 옆에 '실제 이름과 IP 가 실린다' 고 밝혀 둔다
 *
 * 파서는 11-14 실제 출력(Rocky 9.6 CIQ · pacemaker 2.1.6 · RabbitMQ 4.1.2 · Percona XtraDB · OpenStack Epoxy CLI JSON ·
 * Ceph 19.2.3 cephadm · k8s v1.34) 견본(tests/fixtures/envmap-*)에 맞춰 있다. 못 읽은 것은 빈 값으로 두고 '못 읽음' 으로 보인다(조회 실패 ≠ 없음).
 */
import { parsePcsRoles } from './clusterEvidence'

// ── 수집 명령(호출부가 세션마다 돌린다) ─────────────────────────────
/** 구역 표시 — 한 번의 실행으로 여러 명령을 돌리고 출력을 나눈다 */
const MK = (k: string) => `echo '@@QT:${k}@@'`
/**
 * 셸 앞머리 — 한국어 로케일이면 free · lscpu 출력이 번역되어 메모리 · CPU 를 못 읽는다(검토 지적 11-14). 명령마다 timeout 으로 묶어
 * 노드가 죽어 늦게 답하는 명령 하나가 묶음 전체의 시간 제한을 넘겨 앞서 읽은 것까지 버려지지 않게 한다(timeout 은 읽기 동작을 바꾸지 않는다)
 */
const PRE = 'export LC_ALL=C'
/** 물리 노드마다 */
export const NODE_SCRIPT = [
  PRE,
  `${MK('host')}; hostname; head -6 /etc/os-release; uname -r`,
  `${MK('hw')}; nproc; free -g | head -2; lscpu | grep -E '^(Model name|Socket\\(s\\))'`,
  `${MK('ip')}; ip -br -4 addr`,
  `${MK('units')}; systemctl list-units --type=service --state=running --no-pager --plain --no-legend`,
  `${MK('chrony')}; chronyc sources 2>&1; chronyc tracking 2>&1 | head -4`,
].join('; ')
/** 컨트롤러(OpenStack 조회 세션)에서 — 클러스터 상태 */
export const CTRL_SCRIPT = [
  PRE,
  `${MK('pcs')}; timeout 20 pcs status 2>&1`,
  `${MK('rabbit')}; timeout 20 rabbitmqctl cluster_status 2>&1`,
  `${MK('galera')}; timeout 15 mysql -e "SHOW STATUS WHERE Variable_name IN ('wsrep_cluster_size','wsrep_incoming_addresses','wsrep_local_state_comment')" 2>&1`,
].join('; ')
/** OpenStack CLI(JSON) — 호출부가 openrc 를 소싱해 `openstack <이것> -f json` 으로 돌린다 */
export const OS_CMDS = {
  servers: 'server list --all-projects --long',
  hypervisors: 'hypervisor list --long',
  flavors: 'flavor list',
  computes: 'compute service list',
  segments: 'segment list',
} as const
export const segHostsCmd = (uuid: string) => `segment host list ${uuid}`
export const CEPH_SCRIPT = [
  PRE,
  `${MK('status')}; timeout 15 ceph -s -f json 2>&1`,
  `${MK('orch')}; timeout 15 ceph orch ps -f json 2>&1`,
  `${MK('node')}; timeout 15 ceph node ls 2>&1`,
  `${MK('tree')}; timeout 15 ceph osd tree -f json 2>&1`,
  `${MK('pools')}; timeout 15 ceph osd pool ls detail -f json 2>&1`,
].join('; ')
export const K8S_SCRIPT = [
  PRE,
  `${MK('version')}; kubectl version --request-timeout=10s 2>&1`,
  `${MK('nodes')}; kubectl get nodes -o wide --request-timeout=15s 2>&1`,
  `${MK('pods')}; kubectl get pods -A --request-timeout=20s -o custom-columns='NS:.metadata.namespace,NAME:.metadata.name,NODE:.spec.nodeName,KIND:.metadata.ownerReferences[0].kind,OWNER:.metadata.ownerReferences[0].name,PHASE:.status.phase' 2>&1`,
  `${MK('ds')}; kubectl get ds -A --no-headers --request-timeout=15s 2>&1`,
].join('; ')

/** `@@QT:x@@` 구역으로 나눈 출력 */
export function splitSections(out: string): Record<string, string> {
  const r: Record<string, string> = {}
  const re = /^@@QT:([a-z]+)@@\s*$/gm
  const marks = [...out.matchAll(re)]
  marks.forEach((m, i) => {
    const s = (m.index ?? 0) + m[0].length
    const e = i + 1 < marks.length ? marks[i + 1].index ?? out.length : out.length
    r[m[1]] = out.slice(s, e).replace(/^\r?\n/, '').replace(/\s+$/, '')
  })
  return r
}
/**
 * 출력 속 JSON(앞뒤에 경고 줄이 섞여도). 앞 경고 줄에 '[' 가 있으면 첫 괄호부터 자르면 실패한다(검토 지적) — 줄 머리의 여는 괄호를
 * 차례로 시도한다(최대 20곳)
 */
export function jsonOf(out: string | undefined): unknown {
  if (!out) return null
  const starts = [...out.matchAll(/(^|\n)\s*([[{])/g)].map((m) => (m.index ?? 0) + m[0].length - 1).slice(0, 20)
  for (const a of starts) {
    const b = out.lastIndexOf(out[a] === '[' ? ']' : '}')
    if (b <= a) continue
    try {
      return JSON.parse(out.slice(a, b + 1))
    } catch {
      /* 다음 후보 */
    }
  }
  return null
}
type J = Record<string, unknown>
const arr = (v: unknown): J[] => (Array.isArray(v) ? (v as J[]) : [])
const obj = (v: unknown): J => (v && typeof v === 'object' && !Array.isArray(v) ? (v as J) : {})
const str = (v: unknown) => (v == null ? '' : String(v))
const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true })

// ── 물리 노드 ─────────────────────────────────────────────────
export interface NodeFacts {
  host: string
  /** 'Rocky Linux 9.6 (CIQ LTS)' 꼴 */
  os: string
  /** '5.14.0-570.60.1' — 빌드 꼬리(+21.1.el9_6_ciq.x86_64)는 뗀다 */
  kernel: string
  cpus?: number
  cpuModel?: string
  sockets?: number
  memGiB?: number
  /** 인터페이스별 IPv4(마스크 뺌) — 관리 IP · VIP 를 고르는 데만 쓴다 */
  ifaces: { name: string; addrs: string[] }[]
  /** 돌고 있는 서비스 유닛(.service 뗌) */
  units: string[]
  ntp?: { refId: string; name: string; stratum?: number }
}
export function parseNodeFacts(out: string): NodeFacts | null {
  const s = splitSections(out)
  const hostLines = (s.host ?? '').split('\n').map((l) => l.trim()).filter(Boolean)
  // 짧은 이름으로 — hostname 이 FQDN 이면 Nova · pcs 의 짧은 이름과 갈라져 같은 노드가 두 칸이 된다
  const host = hostLines[0] && /^[A-Za-z0-9][\w.-]*$/.test(hostLines[0]) ? hostLines[0].split('.')[0] : ''
  if (!host) return null
  const kv = (k: string) => hostLines.find((l) => l.startsWith(`${k}=`))?.slice(k.length + 1).replace(/^"|"$/g, '') ?? ''
  const name = kv('NAME')
  const ver = kv('VERSION_ID') || kv('VERSION').split(/\s/)[0]
  // 'Rocky Linux from CIQ - LTS' → 'Rocky Linux 9.6 (CIQ LTS)'
  const m = name.match(/^(.*?)\s+from\s+(.*)$/i)
  const os = m ? `${m[1]} ${ver} (${m[2].replace(/\s*-\s*/g, ' ').trim()})` : `${name} ${ver}`.trim()
  const kRaw = hostLines.find((l) => /^\d+\.\d+\.\d+/.test(l)) ?? ''
  const kernel = kRaw.replace(/[+].*$/, '').replace(/\.el\d.*$/, '')
  const hw = (s.hw ?? '').split('\n')
  const cpus = Number(hw.find((l) => /^\d+\s*$/.test(l.trim()))?.trim()) || undefined
  const mem = hw.find((l) => /^Mem:/.test(l.trim()))?.trim().split(/\s+/)[1]
  const cpuModel = hw.find((l) => /^Model name:/.test(l))?.replace(/^Model name:\s*/, '').trim()
  const sockets = Number(hw.find((l) => /^Socket\(s\):/.test(l))?.replace(/^Socket\(s\):\s*/, '')) || undefined
  const ifaces = (s.ip ?? '')
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
    .filter((t) => t.length >= 3 && t[0] !== 'lo')
    .map((t) => ({ name: t[0].replace(/@.*$/, ''), addrs: t.slice(2).filter((x) => /^\d+\.\d+\.\d+\.\d+\//.test(x)).map((x) => x.replace(/\/\d+$/, '')) }))
  const units = (s.units ?? '')
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
    .filter((t) => t[0]?.endsWith('.service') && t[2] === 'active')
    .map((t) => t[0].replace(/\.service$/, ''))
  const ch = s.chrony ?? ''
  const ref = ch.match(/Reference ID\s*:\s*([0-9A-F]{8})\s*\(([^)]*)\)/i)
  const stratum = Number(ch.match(/Stratum\s*:\s*(\d+)/)?.[1]) || undefined
  // 고른 서버 이름은 sources 의 '^*' 줄이 이름으로 나오기도(노드1 은 서버 이름) IP 로 나오기도(나머지) 했다 — tracking 의 Reference ID 로 묶는다
  const sel = ch.split('\n').find((l) => /^\^\*/.test(l))?.trim().split(/\s+/)[1]
  const ntp = ref ? { refId: ref[1].toUpperCase(), name: sel || ref[2], stratum } : undefined
  return { host, os, kernel, cpus, cpuModel, sockets, memGiB: mem ? Number(mem) : undefined, ifaces, units, ntp }
}

/** 노드 유닛에서 OpenStack · Masakari 역할 */
export function serviceRoles(units: string[]) {
  const has = (re: RegExp) => units.some((u) => re.test(u))
  const pick = (re: RegExp, names: Record<string, string>) =>
    Object.entries(names)
      .filter(([k]) => units.some((u) => re.test(u) && u.endsWith(k)))
      .map(([, v]) => v)
  const nova = pick(/nova-/, { 'nova-api': 'api', 'nova-conductor': 'conductor', 'nova-scheduler': 'scheduler', 'nova-novncproxy': 'noVNC', 'nova-compute': 'compute' })
  const neutron = pick(/neutron-/, {
    'neutron-server': 'server',
    'dhcp-agent': 'DHCP',
    'l3-agent': 'L3',
    'neutron-metadata-agent': 'metadata',
    'openvswitch-agent': 'OVS',
    'linuxbridge-agent': 'linuxbridge',
    'ovn-metadata-agent': 'OVN metadata',
  })
  const masakari = pick(/masakari-/, { 'masakari-api': 'api', 'masakari-engine': 'engine', 'host-monitor': 'host-monitor', hostmonitor: 'host-monitor', 'instance-monitor': 'instance-monitor', 'process-monitor': 'process-monitor' })
  const other = ['httpd', 'apache2', 'memcached', 'libvirtd'].filter((u) => units.includes(u))
  return {
    controller: has(/nova-(api|conductor|scheduler)$/) || has(/^neutron-server$/),
    compute: has(/nova-compute$/),
    nova,
    neutron,
    masakari: [...new Set(masakari)],
    other,
    pacemaker: has(/^pacemaker$/),
    rabbit: has(/^rabbitmq-server$/),
    mysql: has(/^(mysql|mysqld|mariadb)$/),
  }
}

// ── 컨트롤러: pcs · rabbit · galera ─────────────────────────────
export interface CtrlFacts {
  /** standby — pacemaker 2.1 은 standby · maintenance 노드를 Online 목록에 넣지 않고 '* Node x: standby' 줄로 낸다(검토 지적) */
  pcs?: { online: string[]; standby: string[]; offline: string[]; dc: string; resources: { name: string; agent: string; group?: string; node: string }[] }
  rabbit?: { disk: string[]; running: string[]; version: string }
  galera?: { size: number; members: string[]; state: string }
}
export function parseCtrl(out: string): CtrlFacts {
  const s = splitSections(out)
  const r: CtrlFacts = {}
  const p = s.pcs ?? ''
  if (/Node List|Online:|Current DC/i.test(p)) {
    // 이름은 모두 짧게 — FQDN 이면 Nova · Ceph(짧은 이름)와 갈라져 같은 노드가 두 칸이 되고 VIP · DC 를 못 맞춘다
    const short = (x: string) => x.split('.')[0]
    const list = (re: RegExp) => (p.match(re)?.[1] ?? '').trim().split(/\s+/).filter((x) => /^[A-Za-z0-9][\w.-]*$/.test(x)).map(short)
    const roles = parsePcsRoles(p)
    const standby = [...p.matchAll(/^\s*\*?\s*Node\s+([A-Za-z0-9][\w.-]*?):?\s*:\s*(standby|maintenance|UNCLEAN[^\n]*|pending)/gim)].map((m) => short(m[1]))
    r.pcs = {
      online: list(/Online:\s*\[([^\]]*)\]/),
      standby: [...new Set(standby)],
      offline: list(/OFFLINE:\s*\[([^\]]*)\]/i),
      dc: short(roles.dc),
      resources: roles.resources.map((x) => ({ name: x.name, agent: x.agent, group: x.group, node: short(x.owners[0] ?? '') })),
    }
  }
  const rb = s.rabbit ?? ''
  if (/Running Nodes/i.test(rb)) {
    const sect = (t: string) => {
      // 'Disk Nodes' 다음 빈 줄, 그 아래 노드 줄들, 빈 줄에서 끝(\s 는 줄바꿈까지 먹어 빈 줄을 못 찾는다 — 공백 · 탭만)
      // 끝은 빈 줄이나 출력 끝 — 'm' 이라 $ 는 줄 끝이 되어 첫 줄에서 멈췄다(검사로 잡음)
      const m = rb.match(new RegExp(`^${t}[ \\t]*\\r?\\n[ \\t]*\\r?\\n([\\s\\S]*?)(?:\\r?\\n[ \\t]*\\r?\\n|(?![\\s\\S]))`, 'm'))
      return (m?.[1] ?? '').split('\n').map((l) => l.trim().replace(/^rabbit@/, '').split('.')[0]).filter(Boolean)
    }
    r.rabbit = { disk: sect('Disk Nodes'), running: sect('Running Nodes'), version: rb.match(/RabbitMQ\s+(\d[\w.]*)/)?.[1] ?? '' }
  }
  const g = s.galera ?? ''
  const gv = (k: string) => g.match(new RegExp(`${k}\\s*\\|?\\s*([^|\\n]*?)\\s*\\|?\\s*$`, 'm'))?.[1]?.trim() ?? ''
  if (/wsrep_cluster_size/.test(g)) {
    r.galera = {
      size: Number(gv('wsrep_cluster_size')) || 0,
      // 이름이면 짧게, IP 면 그대로(묶을 때 노드 주소와 맞춘다)
      members: gv('wsrep_incoming_addresses')
        .split(',')
        .map((x) => x.trim().replace(/:\d+$/, ''))
        .filter(Boolean)
        .map((x) => (/^\d+\.\d+\.\d+\.\d+$/.test(x) ? x : x.split('.')[0])),
      state: gv('wsrep_local_state_comment'),
    }
  }
  return r
}

// ── OpenStack ─────────────────────────────────────────────────
export interface OsVm {
  name: string
  host: string
  status: string
  hostStatus: string
  ips: { net: string; ip: string }[]
  flavor: string
  ha: boolean
}
export function parseServers(out: string): OsVm[] | null {
  const a = jsonOf(out)
  if (!Array.isArray(a)) return null
  return arr(a).map((v) => {
    const nets = v.Networks
    // 새 CLI 는 {망: [IP]}, 옛 CLI 는 '망=IP, IP; 망2=IP' 문자열
    const ips: { net: string; ip: string }[] =
      nets && typeof nets === 'object'
        ? Object.entries(nets as Record<string, unknown>).flatMap(([net, l]) => (Array.isArray(l) ? l : [l]).map((ip) => ({ net, ip: str(ip) })))
        : str(nets)
            .split(';')
            .flatMap((part) => {
              const [net, l] = part.split('=')
              return (l ?? '').split(',').map((ip) => ({ net: net.trim(), ip: ip.trim() }))
            })
            .filter((x) => x.ip)
    // 새 CLI 는 {HA_Enabled: 'True'}, 옛 CLI 는 "HA_Enabled='True'" 문자열
    const props = obj(v.Properties)
    const propStr = typeof v.Properties === 'string' ? v.Properties : ''
    return {
      name: str(v.Name),
      host: str(v.Host),
      status: str(v.Status),
      hostStatus: str(v['Host Status']),
      ips,
      flavor: str(v.Flavor),
      ha: /^true$/i.test(str(props.HA_Enabled)) || /HA_Enabled\s*=\s*'?true/i.test(propStr),
    }
  })
}
/** VM 의 관리 IP — 이름에 mgmt 가 든 망 먼저 */
export const vmMgmtIp = (v: OsVm) => (v.ips.find((x) => /mgmt/i.test(x.net)) ?? v.ips[0])?.ip ?? ''

export interface OsFacts {
  vms: OsVm[]
  hyper: { host: string; ip: string; state: string }[]
  flavors: Record<string, { vcpus: number; ramMB: number }>
  computes: { binary: string; host: string; status: string; state: string }[]
  segments: { name: string; recovery: string; hosts: { name: string; maintenance: boolean; reserved: boolean }[] }[]
}
export function parseOs(raw: { servers?: string; hypervisors?: string; flavors?: string; computes?: string; segments?: string; segHosts?: Record<string, string> }): Partial<OsFacts> {
  const r: Partial<OsFacts> = {}
  const vms = parseServers(raw.servers ?? '')
  if (vms) r.vms = vms
  const hv = jsonOf(raw.hypervisors)
  if (Array.isArray(hv)) r.hyper = arr(hv).map((h) => ({ host: str(h['Hypervisor Hostname']).split('.')[0], ip: str(h['Host IP']), state: str(h.State) }))
  const fl = jsonOf(raw.flavors)
  if (Array.isArray(fl)) r.flavors = Object.fromEntries(arr(fl).map((f) => [str(f.Name), { vcpus: Number(f.VCPUs) || 0, ramMB: Number(f.RAM) || 0 }]))
  const cs = jsonOf(raw.computes)
  if (Array.isArray(cs)) r.computes = arr(cs).map((c) => ({ binary: str(c.Binary), host: str(c.Host), status: str(c.Status), state: str(c.State) }))
  const sg = jsonOf(raw.segments)
  if (Array.isArray(sg))
    r.segments = arr(sg).map((g) => {
      const hs = jsonOf(raw.segHosts?.[str(g.uuid)])
      return {
        name: str(g.name),
        recovery: str(g.recovery_method),
        hosts: arr(hs).map((h) => ({ name: str(h.name), maintenance: h.on_maintenance === true || /^true$/i.test(str(h.on_maintenance)), reserved: h.reserved === true || /^true$/i.test(str(h.reserved)) })),
      }
    })
  return r
}

// ── Ceph ──────────────────────────────────────────────────────
export interface CephFacts {
  version: string
  health: string
  healthMsgs: string[]
  osdNum: number
  osdUp: number
  totalBytes: number
  classes: string[]
  /** 풀 복제 — '복제 3 (min 2)' 이 모두 같으면 하나 */
  replicas: string[]
  /** 호스트별 데몬 */
  hosts: Record<string, { mon: boolean; mgr: boolean; mgrActive: boolean; mds: boolean; mdsActive: boolean; rgw: boolean; osds: number[] }>
}
export function parseCeph(out: string): CephFacts | null {
  const s = splitSections(out)
  const st = obj(jsonOf(s.status))
  if (!st.health) return null
  const health = obj(st.health)
  const checks = obj(health.checks)
  const osdmap = obj(st.osdmap)
  const pg = obj(st.pgmap)
  const hosts: CephFacts['hosts'] = {}
  const H = (h: string) => (hosts[h] ??= { mon: false, mgr: false, mgrActive: false, mds: false, mdsActive: false, rgw: false, osds: [] })
  let version = ''
  const orch = jsonOf(s.orch)
  if (Array.isArray(orch)) {
    for (const d of arr(orch)) {
      const h = H(str(d.hostname).split('.')[0])
      const t = str(d.daemon_type)
      const act = d.is_active === true
      if (t === 'mon') h.mon = true
      if (t === 'mgr') {
        h.mgr = true
        if (act) h.mgrActive = true
      }
      if (t === 'mds') {
        h.mds = true
        if (act) h.mdsActive = true
      }
      if (t === 'rgw') h.rgw = true
      if (t === 'osd') h.osds.push(Number(d.daemon_id))
      if (!version && /^\d/.test(str(d.version)) && t === 'mon') version = str(d.version)
    }
  } else {
    // cephadm 이 아니면 node ls 로(어느 쪽이 active 인지는 모른다)
    const nl = obj(jsonOf(s.node))
    for (const [t, m] of Object.entries(nl))
      for (const [hn, l] of Object.entries(obj(m))) {
        const h = H(hn.split('.')[0])
        if (t === 'mon') h.mon = true
        if (t === 'mgr') h.mgr = true
        if (t === 'mds') h.mds = true
        if (t === 'osd') h.osds.push(...(Array.isArray(l) ? l.map(Number) : []))
      }
  }
  // MDS active 는 fsmap 이 더 정확하다(orch 는 새로 고침 주기만큼 늦다)
  // MDS 이름은 cephadm 이면 'fs.호스트.xxx', 옛 배치면 호스트 이름 그대로 — 이름 조각 중 알려진 호스트를 찾는다(검토 지적)
  for (const rk of arr(obj(st.fsmap).by_rank)) {
    const parts = str(rk.name).split('.')
    const hn = Object.keys(hosts).find((h) => parts.includes(h))
    if (hn && /active/.test(str(rk.status))) hosts[hn].mdsActive = true
  }
  for (const h of Object.values(hosts)) h.osds.sort((a, b) => a - b)
  const tree = obj(jsonOf(s.tree))
  const classes = [...new Set(arr(tree.nodes).filter((n) => n.type === 'osd').map((n) => str(n.device_class)).filter(Boolean))]
  const pools = jsonOf(s.pools)
  const replicas = [...new Set(arr(pools).map((p) => `복제 ${p.size} (min ${p.min_size})`))]
  return {
    version,
    health: str(health.status),
    healthMsgs: Object.values(checks).map((c) => str(obj(obj(c).summary).message)).filter(Boolean),
    osdNum: Number(osdmap.num_osds) || 0,
    osdUp: Number(osdmap.num_up_osds) || 0,
    totalBytes: Number(pg.bytes_total) || 0,
    classes,
    replicas,
    hosts,
  }
}

// ── k8s ───────────────────────────────────────────────────────
export interface K8sNode {
  name: string
  ready: boolean
  /** Ready,SchedulingDisabled — 새 파드를 받지 않는다 */
  cordoned?: boolean
  roles: string
  ip: string
}
export interface K8sWorkload {
  ns: string
  name: string
  /** Deploy · STS · 그 밖은 소유자 종류 그대로(CNPG Cluster 등) */
  kind: string
  /** k8s 노드별 파드 수 */
  at: Record<string, number>
  /** 배치되지 못한(Pending) 파드 */
  pending: number
}
export interface K8sFacts {
  version: string
  nodes: K8sNode[]
  workloads: K8sWorkload[]
  /** 노드마다 하나(DaemonSet) — 원하는 수 · 준비된 수 */
  daemonsets: { ns: string; name: string; desired: number; ready: number }[]
  /** control-plane 정적 파드(소유자 Node) 이름 — 노드 이름을 뗀 것 */
  statics: string[]
  /** 파드 목록을 읽었는가 — 못 읽었는데 '워크로드 0' 으로 보이면 안 된다(조회 실패 ≠ 없음) */
  podsOk: boolean
}
export function parseK8s(out: string): K8sFacts | null {
  const s = splitSections(out)
  // kubectl 은 2>&1 로 받아 경고 줄(metrics API 의 memcache.go … 등)이 앞에 올 수 있다 — 첫 줄이 아니라 머리줄을 찾는다(검토 지적)
  const nodeLines = (s.nodes ?? '').split('\n').filter((l) => l.trim())
  const nh = nodeLines.findIndex((l) => /^NAME\s+STATUS/.test(l))
  if (nh < 0) return null
  const nodes: K8sNode[] = nodeLines
    .slice(nh + 1)
    .map((l) => l.trim().split(/\s+/))
    .filter((t) => t.length >= 6 && /^(Not)?Ready|^Unknown/.test(t[1]))
    .map((t) => ({ name: t[0], ready: /^Ready(,|$)/.test(t[1]), cordoned: /SchedulingDisabled/.test(t[1]) || undefined, roles: t[2] === '<none>' ? '' : t[2], ip: t[5] ?? '' }))
  const known = new Set(nodes.map((n) => n.name))
  const wl = new Map<string, K8sWorkload>()
  const statics = new Set<string>()
  const podLines = (s.pods ?? '').split('\n')
  const ph = podLines.findIndex((l) => /^NS\s+NAME\s+NODE/.test(l))
  for (const l of ph < 0 ? [] : podLines.slice(ph + 1)) {
    const t = l.trim().split(/\s+/)
    if (t.length < 6 || !/^(Running|Pending|Succeeded|Failed|Unknown)$/.test(t[5])) continue
    const [ns, name, node, kind, owner, phase] = t
    if (phase === 'Succeeded' || phase === 'Failed') continue
    if (kind === 'DaemonSet' || kind === 'Job') continue
    if (kind === 'Node') {
      statics.add(name.endsWith(`-${owner}`) ? name.slice(0, -owner.length - 1) : name)
      continue
    }
    // ReplicaSet → Deployment: 끝의 pod-template-hash 를 뗀다
    const wName = kind === 'ReplicaSet' ? owner.replace(/-[a-z0-9]{6,10}$/, '') : kind === '<none>' ? name : owner
    const wKind = kind === 'ReplicaSet' ? 'Deploy' : kind === 'StatefulSet' ? 'STS' : kind === '<none>' ? 'Pod' : kind
    const k = `${ns}/${wKind}/${wName}`
    const w = wl.get(k) ?? { ns, name: wName, kind: wKind, at: {}, pending: 0 }
    if (node === '<none>' || !known.has(node)) w.pending++
    else w.at[node] = (w.at[node] ?? 0) + 1
    wl.set(k, w)
  }
  const daemonsets = (s.ds ?? '')
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
    .filter((t) => t.length >= 6 && /^\d+$/.test(t[2]))
    .map((t) => ({ ns: t[0], name: t[1].replace(/^daemonset\.apps\//, ''), desired: Number(t[2]), ready: Number(t[4]) }))
  return {
    version: s.version?.match(/Server Version:\s*(v[\w.+-]+)/)?.[1] ?? '',
    nodes,
    workloads: [...wl.values()].sort((a, b) => natural(a.ns, b.ns) || natural(a.name, b.name)),
    daemonsets,
    statics: [...statics].sort(natural),
    podsOk: ph >= 0,
  }
}

// ── 모아서 구성도 데이터로 ─────────────────────────────────────
export interface EnvMapRaw {
  at: number
  nodes: { out?: string; error?: string }[]
  ctrl?: string
  os?: { servers?: string; hypervisors?: string; flavors?: string; computes?: string; segments?: string; segHosts?: Record<string, string> }
  ceph?: string
  k8s?: string
  /** 출처별 수집 실패 문구 */
  errors: Record<string, string>
}
export interface EnvMapNode {
  host: string
  label: string
  mgmtIp: string
  role: 'mixed' | 'controller' | 'compute' | ''
  facts?: NodeFacts
  vip?: string
  /** state: online · standby(standby · maintenance · UNCLEAN) · offline · none(pcs 구성원 아님) */
  pcs?: { online: boolean; state: 'online' | 'standby' | 'offline' | 'none'; dc: boolean; resources: string[] }
  /**
   * 클러스터 구성원인가. unread = 서비스는 도는데 클러스터 상태를 못 읽음(rabbitmqctl · mysql 실패) — 이때 'outside' 로 칠하면
   * 조회 실패가 '구성 미포함' 경고로 둔갑한다(검토 지적, 조회 실패 ≠ 장애)
   */
  rabbit?: 'member' | 'outside' | 'unread'
  mysql?: 'member' | 'outside' | 'unread'
  ceph?: CephFacts['hosts'][string]
  segment?: string
}
export interface EnvMapVm {
  name: string
  host: string
  ip: string
  vcpus?: number
  ramGB?: number
  status: string
  hostStatus: string
  ha: boolean
  k8s?: string
}
/** 저장되는 구성도 — 원문은 남기지 않는다(그룹 저장 파일이 커지지 않게, 화면 · HTML 에 쓰는 값만) */
export interface EnvMapSnapshot {
  v: 1
  at: number
  nodes: EnvMapNode[]
  pcs?: { dc: string; nodes: number }
  rabbit?: { members: string[]; running: number; version: string }
  galera?: { members: string[]; size: number; state: string }
  segments: { name: string; recovery: string; hosts: string[] }[]
  ntpName?: string
  ceph?: Omit<CephFacts, 'hosts'>
  vms: EnvMapVm[]
  k8s?: Omit<K8sFacts, 'nodes'> & { nodes: (K8sNode & { host?: string })[] }
  /** 확인이 필요한 것(그림은 그대로 두고 따로 알린다) */
  warnings: string[]
  /** 수집하지 못한 출처 */
  errors: Record<string, string>
}

/**
 * 구성도에 실을 VM — 검증 기본 구성만(사용자: 'deploy · master · infra · manager · biz 같은 것만, 상관없는 VM 은 표현 안 함').
 * k8s 노드와 IP 가 같은 VM 의 이름 머리(Epoxy_)를 기준으로 같은 머리의 VM 을 모두 고른다(Biz · Deploy · Backup 은 k8s 노드가 아니지만
 * 같은 머리라 들어온다). k8s 를 못 읽었으면 그룹 환경에 적어 둔 실제 이름들에서 머리를 찾는다 — 실제 이름을 그대로 넣지는 않는다
 * (11-14 실사용: 환경에 웹 서비스 VM(service_vm01~10) 실제 이름이 있어 k8s 를 못 읽은 수집에서 그것들이 섞였다. 사용자: 기본 구성만).
 * 머리를 못 찾으면 전부.
 */
export function pickVms(vms: OsVm[], k8sIps: Set<string>, keep: string[] = []): OsVm[] {
  const headOf = (n: string) => n.match(/^([A-Za-z0-9]+)[_-]/)?.[1]
  const top = (names: string[]) => {
    const m = new Map<string, number>()
    for (const n of names) {
      const h = headOf(n)
      if (h) m.set(h, (m.get(h) ?? 0) + 1)
    }
    return [...m].sort((a, b) => b[1] - a[1])[0]?.[0]
  }
  const head = top(vms.filter((v) => v.ips.some((x) => k8sIps.has(x.ip))).map((v) => v.name)) ?? top(keep.map((x) => x.trim()).filter(Boolean))
  if (!head) return vms
  return vms.filter((v) => new RegExp(`^${head}[_-]`).test(v.name))
}

export function buildEnvMap(raw: EnvMapRaw, opts: { labels?: Record<string, string>; keepVms?: string[] } = {}): EnvMapSnapshot {
  const warnings: string[] = []
  const allFacts = raw.nodes.map((n) => (n.out ? parseNodeFacts(n.out) : null)).filter((x): x is NodeFacts => !!x)
  const ctrl = raw.ctrl ? parseCtrl(raw.ctrl) : {}
  const os = raw.os ? parseOs(raw.os) : {}
  const ceph = raw.ceph ? parseCeph(raw.ceph) : null
  const k8s = raw.k8s ? parseK8s(raw.k8s) : null
  // 노드 목록: 수집한 노드 + Nova 하이퍼바이저 + pcs 노드(세션이 없는 노드도 빠지지 않게)
  // 물리 노드 = Nova 하이퍼바이저 · pcs 노드. 둘 다 못 읽었을 때만 세션에서 읽은 hostname 을 노드로 본다
  // (연결된 세션을 모두 읽으므로 k8s VM 같은 곳의 결과가 섞여 온다 — 알려진 노드 이름이 아니면 버린다). 같은 호스트를 두 세션으로 읽었으면 하나만
  // Ceph 전용 노드도 물리 노드다(Nova · pcs 에 없어도) — 검토 지적
  const known = new Set([
    ...(os.hyper ?? []).map((h) => h.host),
    ...(ctrl.pcs ? [...ctrl.pcs.online, ...ctrl.pcs.standby, ...ctrl.pcs.offline] : []),
    ...Object.keys(ceph?.hosts ?? {}),
  ])
  const facts = allFacts.filter((f, i) => (!known.size || known.has(f.host)) && allFacts.findIndex((x) => x.host === f.host) === i)
  const hosts = [...new Set([...facts.map((f) => f.host), ...known])].sort(natural)
  const vipRes = ctrl.pcs?.resources.find((r) => /IPaddr/i.test(r.agent))
  const nodes: EnvMapNode[] = hosts.map((host, i) => {
    const f = facts.find((x) => x.host === host)
    const hv = os.hyper?.find((h) => h.host === host)
    const allAddrs = f?.ifaces.flatMap((x) => x.addrs) ?? []
    // 관리 IP = Nova 하이퍼바이저 Host IP(인터페이스 이름으로 고르면 Ceph · Octavia 망과 헷갈린다). 없으면 첫 주소
    const mgmtIp = hv?.ip || allAddrs[0] || ''
    const sr = f ? serviceRoles(f.units) : null
    const novaComputeHost = os.computes?.some((c) => c.binary === 'nova-compute' && c.host.split('.')[0] === host)
    const ctrlHost = os.computes?.some((c) => /conductor|scheduler/.test(c.binary) && c.host.split('.')[0] === host)
    // 유닛과 Nova 서비스 목록 둘 다 본다 — 컨테이너 배치(systemd 유닛 없음)면 유닛만으로는 역할이 비었다(검토 지적)
    const isCtrl = !!sr?.controller || !!ctrlHost
    const isComp = !!sr?.compute || !!novaComputeHost
    // VIP = VIP 리소스가 붙은 노드의, 관리 IP 와 같은 인터페이스의 다른 주소
    let vip: string | undefined
    if (vipRes && vipRes.node === host && f) {
      const ifc = f.ifaces.find((x) => x.addrs.includes(mgmtIp))
      vip = ifc?.addrs.find((a) => a !== mgmtIp)
    }
    const inRabbit = ctrl.rabbit?.disk.includes(host) || ctrl.rabbit?.running.includes(host)
    const inGalera = ctrl.galera?.members.some((m) => m === host || allAddrs.includes(m) || m === mgmtIp)
    const seg = os.segments?.find((s) => s.hosts.some((h) => h.name.split('.')[0] === host))
    return {
      host,
      label: opts.labels?.[host] || `노드 ${i + 1}`,
      mgmtIp,
      role: isCtrl && isComp ? 'mixed' : isCtrl ? 'controller' : isComp ? 'compute' : '',
      facts: f ?? undefined,
      vip,
      pcs: ctrl.pcs
        ? {
            online: ctrl.pcs.online.includes(host),
            state: ctrl.pcs.online.includes(host) ? 'online' : ctrl.pcs.standby.includes(host) ? 'standby' : ctrl.pcs.offline.includes(host) ? 'offline' : 'none',
            dc: ctrl.pcs.dc === host,
            resources: ctrl.pcs.resources.filter((r) => r.node === host).map((r) => r.name),
          }
        : undefined,
      rabbit: inRabbit ? 'member' : sr?.rabbit ? (ctrl.rabbit ? 'outside' : 'unread') : undefined,
      mysql: inGalera ? 'member' : sr?.mysql ? (ctrl.galera ? 'outside' : 'unread') : undefined,
      ceph: ceph?.hosts[host],
      segment: seg?.name,
    }
  })

  // VM
  const k8sIps = new Set((k8s?.nodes ?? []).map((n) => n.ip).filter(Boolean))
  const picked = os.vms ? pickVms(os.vms, k8sIps, opts.keepVms) : []
  const vms: EnvMapVm[] = picked
    .map((v) => {
      const fl = os.flavors?.[v.flavor]
      const kn = k8s?.nodes.find((n) => n.ip && v.ips.some((x) => x.ip === n.ip))
      return {
        name: v.name,
        host: v.host.split('.')[0],
        ip: vmMgmtIp(v),
        vcpus: fl?.vcpus,
        ramGB: fl ? Math.round(fl.ramMB / 1024) : undefined,
        status: v.status,
        hostStatus: v.hostStatus,
        ha: v.ha,
        k8s: kn?.name,
      }
    })
    .sort((a, b) => natural(a.host, b.host) || natural(a.name, b.name))
  const k8sNodes = (k8s?.nodes ?? []).map((n) => ({ ...n, host: vms.find((v) => v.k8s === n.name)?.host ?? os.vms?.find((v) => v.ips.some((x) => x.ip === n.ip))?.host.split('.')[0] }))

  // ── 확인 필요 ──
  if (ceph && ceph.health && ceph.health !== 'HEALTH_OK') warnings.push(`Ceph ${ceph.health}${ceph.healthMsgs.length ? `: ${ceph.healthMsgs.join(' · ')}` : ''}`)
  if (ceph && ceph.osdUp < ceph.osdNum) warnings.push(`Ceph OSD ${ceph.osdUp}/${ceph.osdNum} up`)
  if (ctrl.pcs?.offline.length) warnings.push(`Pacemaker OFFLINE: ${ctrl.pcs.offline.join(', ')}`)
  if (ctrl.pcs?.standby.length) warnings.push(`Pacemaker standby · maintenance: ${ctrl.pcs.standby.join(', ')}`)
  if (ctrl.rabbit && ctrl.rabbit.running.length < ctrl.rabbit.disk.length) warnings.push(`RabbitMQ 실행 ${ctrl.rabbit.running.length}/${ctrl.rabbit.disk.length}`)
  if (ctrl.galera && ctrl.galera.state && !/^Synced$/i.test(ctrl.galera.state)) warnings.push(`Galera 상태 ${ctrl.galera.state}`)
  for (const n of nodes) {
    if (n.mysql === 'outside') warnings.push(`${n.label}(${n.host}) 에서 mysql 이 돌지만 Galera 클러스터(${ctrl.galera?.size ?? '?'}대) 구성원이 아님`)
    if (n.rabbit === 'outside') warnings.push(`${n.label}(${n.host}) 에서 rabbitmq-server 가 돌지만 클러스터 구성원이 아님`)
  }
  const badCompute = (os.computes ?? []).filter((c) => c.binary === 'nova-compute' && (c.status !== 'enabled' || c.state !== 'up'))
  if (badCompute.length) warnings.push(`nova-compute ${badCompute.map((c) => `${c.host} ${c.status}/${c.state}`).join(' · ')}`)
  const maint = (os.segments ?? []).flatMap((s) => s.hosts.filter((h) => h.maintenance).map((h) => h.name))
  if (maint.length) warnings.push(`Masakari 유지보수(on_maintenance): ${maint.join(', ')}`)
  const badVm = vms.filter((v) => v.status !== 'ACTIVE' || (v.hostStatus && v.hostStatus !== 'UP'))
  if (badVm.length) warnings.push(`VM 상태: ${badVm.map((v) => `${v.name} ${v.status}${v.hostStatus && v.hostStatus !== 'UP' ? `/${v.hostStatus}` : ''}`).join(' · ')}`)
  const nr = (k8s?.nodes ?? []).filter((n) => !n.ready)
  if (nr.length) warnings.push(`k8s 노드 NotReady ${nr.length}: ${nr.map((n) => n.name).join(' · ')}`)
  const cord = (k8s?.nodes ?? []).filter((n) => n.cordoned)
  if (cord.length) warnings.push(`k8s 노드 스케줄 막힘(cordon) ${cord.length}: ${cord.map((n) => n.name).join(' · ')}`)
  const pend = (k8s?.workloads ?? []).reduce((a, w) => a + w.pending, 0)
  if (pend) warnings.push(`배치되지 못한(Pending) 파드 ${pend}`)
  for (const d of k8s?.daemonsets ?? []) if (d.ready < d.desired) warnings.push(`DaemonSet ${d.name} ${d.ready}/${d.desired}`)

  // NTP — Reference ID 가 모두 같으면 이름 하나로(이름으로 찍힌 노드의 것을 쓴다)
  const refs = [...new Set(facts.map((f) => f.ntp?.refId).filter(Boolean))]
  const ntpName = refs.length === 1 ? facts.map((f) => f.ntp?.name ?? '').find((n) => /[a-z]/i.test(n)) ?? facts[0]?.ntp?.name : undefined

  // 원문은 받았는데 읽지 못한 것 — 단계는 ✓ 인데 그림에서 통째로 빠지면 '없음' 으로 보인다(검토 지적). 여기서 '못 읽음' 으로 올린다
  const errors = { ...raw.errors }
  const unread = (k: string, msg: string) => {
    if (!errors[k]) errors[k] = msg
  }
  if (raw.ctrl) {
    if (!ctrl.pcs) unread('Pacemaker', 'pcs status 출력을 읽지 못했습니다')
    if (!ctrl.rabbit) unread('RabbitMQ', 'rabbitmqctl cluster_status 출력을 읽지 못했습니다(구성원 판정 없이 그림)')
    if (!ctrl.galera) unread('Galera', 'wsrep 상태를 읽지 못했습니다(mysql 접속 · 권한 확인, 구성원 판정 없이 그림)')
  }
  if (raw.ceph && !ceph) unread('Ceph', 'ceph -s 출력을 읽지 못했습니다')
  if (raw.k8s && !k8s) unread('k8s', 'kubectl get nodes 출력을 읽지 못했습니다')
  if (k8s && !k8s.podsOk) unread('k8s 파드', 'kubectl get pods 출력을 읽지 못했습니다(배치 표를 그리지 않음)')
  if (raw.os?.servers && !os.vms) unread('OpenStack 서버', 'server list 출력을 읽지 못했습니다')
  return {
    v: 1,
    at: raw.at,
    nodes,
    pcs: ctrl.pcs ? { dc: ctrl.pcs.dc, nodes: ctrl.pcs.online.length + ctrl.pcs.standby.length + ctrl.pcs.offline.length } : undefined,
    rabbit: ctrl.rabbit ? { members: ctrl.rabbit.disk, running: ctrl.rabbit.running.length, version: ctrl.rabbit.version } : undefined,
    galera: ctrl.galera,
    segments: (os.segments ?? []).map((s) => ({ name: s.name, recovery: s.recovery, hosts: s.hosts.map((h) => h.name.split('.')[0]) })),
    ntpName,
    ceph: ceph
      ? { version: ceph.version, health: ceph.health, healthMsgs: ceph.healthMsgs, osdNum: ceph.osdNum, osdUp: ceph.osdUp, totalBytes: ceph.totalBytes, classes: ceph.classes, replicas: ceph.replicas }
      : undefined,
    vms,
    k8s: k8s ? { ...k8s, nodes: k8sNodes } : undefined,
    warnings,
    errors,
  }
}

// ── HTML ──────────────────────────────────────────────────────
const he = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)
const TiB = (b: number) => (b ? `${(b / 1024 ** 4).toFixed(1)} TiB` : '')
const fmtAt = (t: number) => {
  const d = new Date(t)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
export const roleText = (r: EnvMapNode['role']) => ({ mixed: '믹스드', controller: '컨트롤러', compute: '컴퓨트', '': '' })[r]
const CSS = `:root{--ink:#1b2430;--mut:#5b6675;--line:#d8dde4;--hd:#c9d6ea;--hdi:#1f3a68;--bg:#eef1f5;--ok:#047a3f;--warn:#a35b00;--bad:#c21f1f;--ev:#e0b84a}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:13px/1.5 "Malgun Gothic","맑은 고딕",system-ui,sans-serif;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.wrap{max-width:1360px;margin:0 auto;padding:22px 16px 60px}
.top{background:linear-gradient(90deg,#1d3d78,#2d64c0);color:#fff;border-radius:10px;padding:18px 22px}.top h1{margin:0;font-size:20px}.top .sub{opacity:.85;font-size:12.5px;margin-top:4px}
.ver{display:flex;gap:8px;flex-wrap:wrap;margin:14px 0 0;font-size:12px}.ver span{background:#fff;border:1px solid var(--line);border-radius:999px;padding:3px 12px;color:var(--mut)}.ver b{color:var(--ink);margin-left:4px}
.sum{display:flex;gap:10px;flex-wrap:wrap;margin:12px 0}.sum .k{display:flex;align-items:center;gap:7px;height:40px;background:#fff;border:1px solid var(--line);border-radius:8px;padding:0 14px;color:var(--mut);line-height:1}.sum .k b{font-size:18px;line-height:1;color:var(--ink)}
.chk{background:#fff8e1;border:1px solid #f0d58a;border-left:4px solid var(--ev);border-radius:8px;padding:10px 14px;margin-bottom:16px;font-size:12.5px;color:#3d2f00}.chk b{color:#7a5600}.chk ul{margin:4px 0 0;padding-left:18px;line-height:1.75}
.chk.err{background:#fdf1f1;border-color:#efc2c2;border-left-color:#c94b4b;color:#5a1414}.chk.err b{color:#8a1f1f}
.sec{background:#fff;border:1px solid var(--line);border-radius:12px;padding:18px 20px 22px;margin-bottom:16px;break-inside:avoid}
.sh{display:flex;align-items:center;gap:10px;margin-bottom:16px;flex-wrap:wrap}.sh .n{background:#1f3a68;color:#fff;border-radius:6px;width:24px;height:24px;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:12px}.sh h2{margin:0;font-size:16px}.sh .d{margin-left:auto;color:var(--mut);font-size:12px}
.ip{font-family:Consolas,monospace}.mut{color:var(--mut)}
.ng{display:grid;column-gap:22px;row-gap:12px}
.ng>.cardbg{grid-row:1 / -1;border-radius:10px;z-index:0;background:#fff;border:1px solid #c5cfdd;box-shadow:0 1px 3px rgba(20,40,80,.06)}
.ng>.cell{z-index:2;padding:4px 12px;min-width:0;display:flex;flex-wrap:wrap;gap:5px;align-content:flex-start}
.ng>.band{z-index:1;margin:-7px -10px -5px;border-radius:8px;pointer-events:none;position:relative}
.ng>.band>i{position:absolute;right:10px;top:-10px;font-style:normal;font-size:10.5px;font-weight:700;padding:0 6px;border-radius:4px;white-space:nowrap;background:#fff}
.hdr{padding:10px 12px 9px!important;background:#e8eef7;border-radius:10px 10px 0 0;border-bottom:1px solid #c5cfdd;display:block!important;margin-bottom:4px}
.hdr b{font-size:15px;color:var(--hdi)}.hdr .h{color:var(--hdi);font-weight:600;margin-left:6px}.hdr .meta{display:flex;justify-content:space-between;align-items:center;margin-top:2px;font-size:11.5px;color:#3a5583}.hdr .hw{font-size:11px;color:#3a5583;margin-top:2px}
.role{border-radius:4px;padding:0 7px;font-size:11px;font-weight:700;background:#1f3a68;color:#fff}.role.cp{background:#6b7685}
.b{border-radius:4px;padding:3px 8px;font-size:11.5px;text-align:center;flex:1 1 auto;white-space:nowrap;background:#eef3fb;border:1px solid #c6d5ee;color:#1f3a68}.b.full{flex-basis:100%}.b small{opacity:.8}
.b.vip{background:#0f7a5a;border-color:#0f7a5a;color:#fff;font-weight:700}.b.act{background:#dff3e8;border-color:#93c9a8;color:#0f5132;font-weight:700}
.b.mq{background:#fff1e3;border-color:#f0c79a;color:#7a3e00}.b.ntp{background:#f4f1fb;border-color:#d3c9ec;color:#4a3a7a}
.b.ceph{background:#fdecec;border-color:#eab3b3;color:#7d1d1d}.b.ceph.on{background:#c94b4b;border-color:#c94b4b;color:#fff;font-weight:700}
.b.ma{background:#eef7f7;border-color:#9fd0cf;color:#0f5c5a}.b.dim{background:#fafbfc;border:1px dashed #d0d6de;color:#7b8594}.b.warn{background:#fff;border:1px dashed #e39a3b;color:#a35b00;font-weight:700}
.sub2{flex-basis:100%;font-size:10.5px;color:var(--mut);margin:2px 0 -2px}
.osbar{margin-top:6px;border-radius:0 0 10px 10px;background:#33415a;color:#e8eef7;padding:8px 12px!important;display:block!important;text-align:center;font-size:11.5px}.osbar b{color:#fff}
.band.pm{border:2px dashed #7c9cd0;background:rgba(80,120,200,.04)}.band.pm>i{color:#1f3a68;border:1px solid #b5c7e6}
.band.cp{border:2px dashed #e39a3b;background:rgba(255,166,64,.05)}.band.cp>i{color:#a35b00;border:1px solid #f0c79a}
.band.ms{border:2px dashed #3aa6a2;background:rgba(40,160,160,.04)}.band.ms>i{color:#0f5c5a;border:1px solid #9fd0cf}
.band.ce{border:2px dashed #c9b400;background:rgba(220,200,0,.05)}.band.ce>i{color:#6d6200;border:1px solid #e3d77a}
.legend{display:flex;gap:14px;flex-wrap:wrap;margin-top:12px;font-size:11.5px;color:var(--mut)}.legend .sw{display:inline-block;width:22px;height:10px;border-radius:3px;margin-right:4px;vertical-align:-1px}
.vg{display:grid;gap:14px}.vc{border:1px solid #c5cfdd;border-radius:10px;overflow:hidden;background:#fff}
.vc .vh{background:#e8eef7;padding:8px 12px;display:flex;align-items:baseline;gap:8px;border-bottom:1px solid #c5cfdd}.vc .vh b{color:var(--hdi);font-size:14px}.vc .vh span{color:#3a5583;font-size:11.5px}.vc .vh em{margin-left:auto;font-style:normal;font-size:11.5px;color:var(--mut)}
.vc .vb{padding:10px 12px;display:flex;flex-direction:column;gap:6px}.vgrp{font-size:10.5px;font-weight:700;color:var(--mut);margin-top:2px}.vrow{display:flex;flex-wrap:wrap;gap:7px}
.vm{border:1px solid #c9ced6;background:#f1f2f4;border-radius:5px;padding:3px 8px;font-size:11.5px;line-height:1.4;min-width:118px}.vm .ip{display:block;font-size:10.5px;color:var(--mut)}.vm .fl{display:block;font-size:10px;color:#8a94a3}.vm .kn{display:block;font-size:10px;color:#2d64c0}
.vm.k8s{background:#e6eefb;border-color:#9fb6e0}.vm.ev{box-shadow:0 0 0 2px #fff,0 0 0 4px #e0b84a}.vm.off{opacity:.55}.vm .st{display:block;font-size:10px;color:var(--bad);font-weight:700}.vm.hl{outline:2px solid #2d64c0;outline-offset:1px}
.vnone{color:#9aa3ae;font-size:12px;padding:6px 0}.lgd{display:flex;gap:6px;align-items:center;font-size:11.5px;color:var(--mut)}.lgd .vm{min-width:0;padding:0 6px}
.pd{width:100%;border-collapse:collapse;font-size:12px;table-layout:fixed}.pd th,.pd td{border:1px solid var(--line);padding:4px;text-align:center}
.pd thead th{background:var(--hd);color:var(--hdi);font-size:11.5px}.pd thead tr:first-child th{background:#bccbe3}.pd th .nr{display:block;color:var(--bad);font-size:10px}
.pd td.wl{text-align:left;padding-left:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.pd td.wl small{color:var(--mut);margin-left:5px}
.pd tr.ns td{background:#f5f7fa;text-align:left;font-weight:700;color:var(--hdi);padding-left:10px}
.pd td.c{color:#2d64c0;font-size:12px;letter-spacing:1px}.pd td.c.z{color:#d0d5dc}.pd td.c.nr{background:#fdf3f3}
.pd th.pb,.pd td.pb{border-left:2px solid #9fb2cf}.pd th.hl,.pd td.hl{background:#eef4ff}.pd td.pe{color:var(--warn);font-weight:700}
.pd td.sp{white-space:nowrap;font-weight:700}.sp.good{color:var(--ok)}.sp.bad{color:var(--bad)}.sp.one{color:var(--mut);font-weight:400}.pd tr.risk td.wl{color:var(--bad);font-weight:700}
.note{margin-top:10px;font-size:12px;color:var(--mut);line-height:1.7}
.inv{width:100%;border-collapse:collapse;font-size:12px}.inv th,.inv td{border:1px solid var(--line);padding:5px 8px;text-align:left}.inv th{background:var(--hd);color:var(--hdi)}
@page{size:A4 landscape;margin:8mm}
@media print{body{background:#fff}.wrap{padding:0}.sec{box-shadow:none}.pd{font-size:10.5px}}`
// 인쇄 · PDF 는 A4 가로(2026-11-14 확인: 세로 A4 폭(약 720px)에서는 노드 카드 머리가 '노드 / 1' 로 꺾이고 k8s 표 열 이름이 겹쳤다.
// 리포트 PDF 저장(printToPDF A4)도 이 @page 를 따른다 — 구성도 페이지만 가로가 되고 다른 리포트는 그대로)

/** 연속한 열 묶음 — 띠가 끊긴 노드를 건너뛰어 덮지 않게(1 · 2 · 4 면 1~2 와 4 두 띠) */
function runsOf(cols: number[]): [number, number][] {
  const out: [number, number][] = []
  for (const c of [...cols].sort((a, b) => a - b)) {
    const last = out[out.length - 1]
    if (last && last[1] === c - 1) last[1] = c
    else out.push([c, c])
  }
  return out
}

/**
 * VM 역할 — k8s 노드가 아닌 VM 은 이름으로(2026-11-14 사용자 설명: deploy = 배포용, backup = Viola 백업, biz = Viola Biz 클러스터).
 * 이 환경의 이름 짓기에 맞춘 것이라 맞지 않는 이름은 '-' 로 둔다
 */
const VM_ROLE: [RegExp, string][] = [
  [/deploy/i, '배포용(Helm 차트 · 이미지)'],
  [/backup/i, 'Viola 백업'],
  [/biz/i, 'Viola Biz 클러스터'],
]
export const vmRole = (v: EnvMapVm) => (v.k8s ? (/master|control/i.test(v.k8s) ? 'k8s control-plane' : 'k8s worker') : VM_ROLE.find(([re]) => re.test(v.name))?.[1] ?? '-')
/**
 * opts.checks — '수집하지 못한 것' · '확인이 필요한 것' 상자를 싣는가. 앱 안 보기에서만 켠다(2026-11-14 사용자: 리포트 · 저장 파일에는 나오지 않게).
 * 못 읽은 칸은 상자가 없어도 그 자리에 '못 읽음' 으로 남는다
 */
export function renderEnvMapHtml(m: EnvMapSnapshot, opts: { title: string; checks?: boolean; /** 같이 뽑은 종합 결과 — 머리에 '← 종합 결과' */ totalFile?: string }): string {
  const N = m.nodes
  const cols = N.length || 1
  const b = (t: string, c = '', full = false) => `<div class="b ${c}${full ? ' full' : ''}">${t}</div>`
  const sub = (t: string) => `<div class="sub2">${he(t)}</div>`
  const NA = b('못 읽음', 'dim', true)
  const rows: { k: string; cell: (n: EnvMapNode) => string }[] = [
    {
      k: 'pm',
      cell: (n) => {
        if (!n.pcs) return NA
        if (n.pcs.state === 'standby') return b('Pacemaker standby · maintenance', 'warn', true)
        if (n.pcs.state === 'offline') return b('Pacemaker OFFLINE', 'warn', true)
        if (!n.pcs.online) return b('Pacemaker 참여 안 함', 'dim', true)
        const res = n.pcs.resources
        return (
          b(`Pacemaker${n.pcs.dc ? ' <small>· DC</small>' : ''}`, '', true) +
          (n.vip ? b(`VIP ${he(n.vip)}`, 'vip') : '') +
          res.filter((r) => /haproxy/i.test(r)).map((r) => b(he(r === 'haproxy' ? 'HAProxy' : r), 'act')).join('') +
          res.filter((r) => !/haproxy|vip/i.test(r)).map((r) => b(he(r), '', true)).join('') +
          (!res.length ? b('리소스 없음', 'dim', true) : '')
        )
      },
    },
    {
      k: 'mq',
      cell: (n) =>
        // 클러스터 밖에서 도는 것(11-14 사용자 문구 결정: 'mysql (Galera 구성 미포함)')
        // 클러스터 상태를 못 읽었으면 구성원 판정 없이 '실행 중' 만(검토 지적). 서비스 목록도 클러스터 상태도 없으면 '못 읽음'
        (n.rabbit === 'member' ? b('rabbitmq-server', 'mq') : n.rabbit === 'outside' ? b('rabbitmq-server (클러스터 구성 미포함)', 'warn', true) : n.rabbit === 'unread' ? b('rabbitmq-server (클러스터 못 읽음)', 'dim') : '') +
        (n.mysql === 'member' ? b('mysql (Galera)', 'mq') : n.mysql === 'outside' ? b('mysql (Galera 구성 미포함)', 'warn', true) : n.mysql === 'unread' ? b('mysql (Galera 못 읽음)', 'dim') : '') +
        (!n.rabbit && !n.mysql && !n.facts && !m.rabbit && !m.galera ? NA : ''),
    },
    {
      k: 'osv',
      cell: (n) => {
        if (!n.facts) return NA
        const r = serviceRoles(n.facts.units)
        return (
          (r.nova.length ? sub('Nova') + r.nova.map((x) => b(he(x))).join('') : '') +
          (r.neutron.length ? sub('Neutron') + r.neutron.map((x) => b(he(x))).join('') : '') +
          (r.other.length ? sub('그 밖') + r.other.map((x) => b(he(x))).join('') : '')
        )
      },
    },
    {
      k: 'ma',
      cell: (n) => {
        if (!n.facts) return NA
        const r: string[] = serviceRoles(n.facts.units).masakari
        const ae: string[] = r.filter((x) => x === 'api' || x === 'engine')
        return (ae.length ? b(`masakari-${ae.join(' · ')}`, 'ma') : '') + r.filter((x) => !ae.includes(x)).map((x) => b(he(x), 'ma', ae.length === 0)).join('')
      },
    },
    { k: 'ntp', cell: (n) => (n.facts?.ntp ? b(`chrony → ${he(m.ntpName ?? n.facts.ntp.name)}`, 'ntp', true) : n.facts ? b('NTP 못 읽음', 'dim', true) : NA) },
    {
      k: 'ceph',
      cell: (n) => {
        const c = n.ceph
        if (!c) return m.ceph ? '' : NA
        return (
          (c.mon ? b('MON', 'ceph') : '') +
          (c.mgr ? b(c.mgrActive ? 'MGR active' : 'MGR', `ceph${c.mgrActive ? ' on' : ''}`) : '') +
          (c.mds ? b(c.mdsActive ? 'MDS active' : 'MDS', `ceph${c.mdsActive ? ' on' : ''}`) : '') +
          (c.rgw ? b('RGW', 'ceph') : '') +
          (c.osds.length ? b(`OSD ${c.osds.join(' · ')}`, 'ceph', true) : '')
        )
      },
    },
  ]
  const R = (k: string) => rows.findIndex((r) => r.k === k) + 2
  const colsOf = (pred: (n: EnvMapNode) => boolean) => N.map((n, i) => (pred(n) ? i + 1 : 0)).filter(Boolean)
  const bands: { k: string; r: string; cols: number[]; label: string }[] = []
  if (m.pcs) bands.push({ k: 'pm', r: 'pm', cols: colsOf((n) => !!n.pcs?.online), label: `Pacemaker ${m.pcs.nodes}노드${m.pcs.dc ? ` · DC ${N.find((n) => n.host === m.pcs!.dc)?.label ?? m.pcs.dc}` : ''}` })
  if (m.rabbit || m.galera)
    bands.push({
      k: 'cp',
      r: 'mq',
      cols: colsOf((n) => n.rabbit === 'member' || n.mysql === 'member'),
      label: [m.rabbit ? `RabbitMQ ${m.rabbit.running}/${m.rabbit.members.length}` : '', m.galera ? `Galera ${m.galera.size}/${m.galera.members.length} ${m.galera.state}` : ''].filter(Boolean).join(' · '),
    })
  for (const s of m.segments)
    bands.push({ k: 'ms', r: 'ma', cols: colsOf((n) => s.hosts.includes(n.host)), label: `Masakari 세그먼트 ${s.name} · 호스트 ${s.hosts.length}${s.recovery === 'auto' ? ' · 자동 복구' : s.recovery ? ` · ${s.recovery}` : ''}` })
  if (m.ceph)
    bands.push({
      k: 'ce',
      r: 'ceph',
      cols: colsOf((n) => !!n.ceph),
      label: [`Ceph ${colsOf((n) => !!n.ceph).length}노드`, `OSD ${m.ceph.osdNum}${m.ceph.classes.length ? `(${m.ceph.classes.join('·').toUpperCase()})` : ''}`, ...m.ceph.replicas, TiB(m.ceph.totalBytes), m.ceph.health].filter(Boolean).join(' · '),
    })
  const OS = (n: EnvMapNode) => (n.facts ? `<b>${he(n.facts.os.replace(/\s*\(.*\)$/, ''))}</b>${/\(/.test(n.facts.os) ? ` ${he(n.facts.os.match(/\(.*\)$/)?.[0])}` : ''}<br>커널 ${he(n.facts.kernel)} · KVM` : '<b>OS 못 읽음</b><br>노드 세션이 없거나 연결돼 있지 않음')
  let g = `<div class="ng" style="grid-template-columns:repeat(${cols},minmax(0,1fr));grid-template-rows:auto repeat(${rows.length},auto) auto">`
  N.forEach((n, i) => {
    const f = n.facts
    const hw = f ? [f.cpus ? `${f.cpus} vCPU${f.cpuModel ? ` (${f.cpuModel.replace(/\(R\)|\(TM\)|CPU|@.*$/g, '').replace(/\s+/g, ' ').trim()}${f.sockets ? ` × ${f.sockets}` : ''})` : ''}` : '', f.memGiB ? `메모리 ${f.memGiB}GB` : ''].filter(Boolean).join(' · ') : ''
    g += `<div class="cardbg" style="grid-column:${i + 1}"></div><div class="cell hdr" style="grid-column:${i + 1};grid-row:1"><b>${he(n.label)}</b><span class="h">${he(n.host)}</span><div class="meta"><span class="ip">${he(n.mgmtIp)}</span>${n.role ? `<span class="role${n.role === 'compute' ? ' cp' : ''}">${roleText(n.role)}</span>` : ''}</div>${hw ? `<div class="hw">${he(hw)}</div>` : ''}</div>`
  })
  rows.forEach((r, ri) => N.forEach((n, i) => (g += `<div class="cell" style="grid-column:${i + 1};grid-row:${ri + 2}">${r.cell(n)}</div>`)))
  N.forEach((n, i) => (g += `<div class="cell osbar" style="grid-column:${i + 1};grid-row:${rows.length + 2}">${OS(n)}</div>`))
  for (const bd of bands)
    runsOf(bd.cols).forEach(([a, z], j) => (g += `<div class="band ${bd.k}" style="grid-column:${a} / ${z + 1};grid-row:${R(bd.r)}">${j === 0 ? `<i>${he(bd.label)}</i>` : ''}</div>`))
  g += '</div>'

  // ② VM
  const vmChip = (v: EnvMapVm) =>
    `<span class="vm${v.k8s ? ' k8s' : ''}${v.ha ? ' ev' : ''}${v.status !== 'ACTIVE' ? ' off' : ''}"${v.k8s ? ` data-vm="${he(v.k8s)}"` : ''}>${he(v.name)}<span class="ip">${he(v.ip)}</span>${v.vcpus ? `<span class="fl">${v.vcpus} vCPU · ${v.ramGB}GB</span>` : ''}${v.k8s ? `<span class="kn">k8s · ${he(v.k8s)}</span>` : ''}${v.status !== 'ACTIVE' ? `<span class="st">${he(v.status)}</span>` : ''}</span>`
  const vmHtml = N.map((n) => {
    const v = m.vms.filter((x) => x.host === n.host)
    const k8 = v.filter((x) => x.k8s)
    const ot = v.filter((x) => !x.k8s)
    return `<div class="vc"><div class="vh"><b>${he(n.label)}</b><span>${he(n.host)}</span><em>VM ${v.length}대</em></div><div class="vb">${
      !v.length
        ? '<div class="vnone">배치된 VM 없음</div>'
        : (k8.length ? `<div class="vgrp">k8s 노드</div><div class="vrow">${k8.map(vmChip).join('')}</div>` : '') + (ot.length ? `<div class="vgrp">그 밖</div><div class="vrow">${ot.map(vmChip).join('')}</div>` : '')
    }</div></div>`
  }).join('')

  // ③ 파드
  let pd = ''
  const K = m.k8s
  if (K && !K.podsOk) pd = '<div class="vnone">파드 목록을 읽지 못해 배치 표를 그리지 않았습니다.</div>'
  else if (K) {
    // 물리 노드마다 control-plane 을 앞에(이름순이면 infra · manager · master 가 되어 master 가 끝에 갔다)
    const cpFirst = (a: K8sNode, b: K8sNode) => Number(!/control-plane|master/.test(a.roles)) - Number(!/control-plane|master/.test(b.roles)) || natural(a.name, b.name)
    const groups = N.map((n) => ({ n, nodes: K.nodes.filter((k) => k.host === n.host).sort(cpFirst) })).filter((x) => x.nodes.length)
    const loose = K.nodes.filter((k) => !k.host || !N.some((n) => n.host === k.host))
    if (loose.length) groups.push({ n: { host: '', label: '물리 노드 모름' } as EnvMapNode, nodes: loose })
    const cl = groups.flatMap((gp) => gp.nodes.map((k, i) => ({ k, first: i === 0, host: gp.n.host })))
    const physOf = (name: string) => cl.find((c) => c.k.name === name)?.host ?? ''
    const short = (s: string) => s.replace(/^[a-z0-9]+-(?=(master|infra|manager|worker|biz|control))/i, '')
    pd += `<table class="pd"><colgroup><col style="width:250px">${cl.map(() => '<col>').join('')}<col style="width:46px"><col style="width:100px"></colgroup>`
    pd += `<thead><tr><th rowspan="2">워크로드</th>${groups.map((gp) => `<th class="pb" colspan="${gp.nodes.length}">${he(gp.n.label)}${gp.n.host ? ` · ${he(gp.n.host)}` : ''}</th>`).join('')}<th rowspan="2">대기</th><th rowspan="2">물리 노드</th></tr><tr>`
    pd += cl.map((c) => `<th class="${c.first ? 'pb' : ''}" data-col="${he(c.k.name)}">${he(short(c.k.name))}${!c.k.ready ? '<span class="nr">NotReady</span>' : ''}</th>`).join('') + '</tr></thead><tbody>'
    const byNs = new Map<string, K8sWorkload[]>()
    for (const w of K.workloads) byNs.set(w.ns, [...(byNs.get(w.ns) ?? []), w])
    for (const [ns, ws] of byNs) {
      pd += `<tr class="ns"><td colspan="${cl.length + 3}">${he(ns)} <span class="mut" style="font-weight:400">· 워크로드 ${ws.length}</span></td></tr>`
      for (const w of ws) {
        const total = Object.values(w.at).reduce((a, x) => a + x, 0)
        const physAll = Object.keys(w.at).map(physOf)
        const phys = new Set(physAll.filter(Boolean)).size
        // 물리 노드를 모르는 k8s 노드에 파드가 있으면 판정하지 않는다 — 모르는 것을 '나뉨' · '몰림' 으로 지어 붙이지 않는다(검토 지적)
        const sp =
          total < 2
            ? '<span class="sp one">단일 파드</span>'
            : physAll.some((h) => !h)
              ? '<span class="sp one">물리 노드 모름</span>'
              : phys === 1
                ? '<span class="sp bad">1대에 몰림</span>'
                : `<span class="sp good">${phys}대에 나뉨</span>`
        pd += `<tr class="${total > 1 && phys === 1 && !physAll.some((h) => !h) ? 'risk' : ''}"><td class="wl" title="${he(w.name)}">${he(w.name)}<small>${he(w.kind)} · ${total + w.pending}</small></td>`
        pd += cl.map((c) => `<td class="c${w.at[c.k.name] ? '' : ' z'}${c.first ? ' pb' : ''}${!c.k.ready ? ' nr' : ''}" data-col="${he(c.k.name)}">${w.at[c.k.name] ? '●'.repeat(Math.min(w.at[c.k.name], 6)) : '·'}</td>`).join('')
        pd += `<td class="${w.pending ? 'pe' : 'mut'}">${w.pending || ''}</td><td class="sp">${sp}</td></tr>`
      }
    }
    if (K.daemonsets.length || K.statics.length) {
      pd += `<tr class="ns"><td colspan="${cl.length + 3}">노드마다 하나씩 <span class="mut" style="font-weight:400">· DaemonSet · control-plane 정적 파드</span></td></tr>`
      pd += `<tr><td class="wl" colspan="${cl.length + 3}" style="white-space:normal">${K.daemonsets
        .map((d) => (d.ready < d.desired ? `<b style="color:#c21f1f">${he(d.name)} ${d.ready}/${d.desired}</b>` : `${he(d.name)} (${d.desired})`))
        .join(' · ')}${K.statics.length ? `${K.daemonsets.length ? ' · ' : ''}${K.statics.map(he).join(' · ')} (control-plane)` : ''}</td></tr>`
    }
    pd += '</tbody></table>'
  }

  // ④ IP
  let inv = '<table class="inv"><thead><tr><th>구분</th><th>이름</th><th>관리 IP</th><th>위치</th><th>역할</th></tr></thead><tbody>'
  for (const n of N) inv += `<tr><td>물리 노드</td><td>${he(n.label)} · ${he(n.host)}</td><td class="ip">${he(n.mgmtIp)}</td><td>-</td><td>${roleText(n.role)}</td></tr>`
  for (const n of N) if (n.vip) inv += `<tr><td>VIP</td><td>Pacemaker VIP</td><td class="ip">${he(n.vip)}</td><td>${he(n.label)}</td><td>HAProxy · OpenStack API</td></tr>`
  for (const v of m.vms) inv += `<tr><td>VM</td><td>${he(v.name)}</td><td class="ip">${he(v.ip)}</td><td>${he(N.find((n) => n.host === v.host)?.label ?? v.host)}</td><td>${he(vmRole(v))}</td></tr>`
  inv += '</tbody></table>'

  const nW = K?.workloads.length ?? 0
  const nP = K?.workloads.reduce((a, w) => a + Object.values(w.at).reduce((x, y) => x + y, 0) + w.pending, 0) ?? 0
  const osName = N.find((n) => n.facts)?.facts?.os
  const ver = [m.ceph?.version ? `<span>Ceph <b>${he(m.ceph.version)}</b></span>` : '', K?.version ? `<span>Kubernetes <b>${he(K.version)}</b></span>` : '', m.rabbit?.version ? `<span>RabbitMQ <b>${he(m.rabbit.version)}</b></span>` : '', osName ? `<span>OS <b>${he(osName)}</b></span>` : ''].join('')
  const errs = Object.entries(m.errors)
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${he(opts.title)}</title><style>${CSS}</style></head><body><div class="wrap">
<div class="top">${opts.totalFile ? `<a href="${opts.totalFile === '__QT_TOTAL_FILE__' ? opts.totalFile : he(encodeURIComponent(opts.totalFile))}" style="color:#dbe6ff;font-size:12px;text-decoration:none">← 종합 결과</a>` : ''}<h1>${he(opts.title)}</h1><div class="sub">수집 ${fmtAt(m.at)} · 조회 명령만 사용(설정 · 상태 변경 없음)</div></div>
${ver ? `<div class="ver">${ver}</div>` : ''}
<div class="sum"><div class="k">물리 노드<b>${N.length}</b></div><div class="k">검증 VM<b>${m.vms.length}</b></div>${K ? `<div class="k">k8s 노드<b>${K.nodes.length}</b></div><div class="k">워크로드<b>${nW}</b></div><div class="k">파드<b>${nP}</b></div>` : ''}</div>
${opts.checks && errs.length ? `<div class="chk err"><b>수집하지 못한 것</b> (그 칸은 '못 읽음' 으로 그렸습니다)<ul>${errs.map(([k, v]) => `<li>${he(k)}: ${he(v)}</li>`).join('')}</ul></div>` : ''}
${opts.checks && m.warnings.length ? `<div class="chk"><b>수집 시점에 확인이 필요한 것</b> (구성도는 그대로 그리고 여기서 따로 알립니다)<ul>${m.warnings.map((w) => `<li>${he(w)}</li>`).join('')}</ul></div>` : ''}
<div class="sec"><div class="sh"><span class="n">1</span><h2>물리 노드</h2><span class="d">점선 = 여러 노드가 묶인 클러스터 · 진한 칸 = 지금 일을 맡은 쪽(VIP · active)</span></div>${g}
<div class="legend"><span><span class="sw" style="border:2px dashed #7c9cd0"></span>Pacemaker</span><span><span class="sw" style="border:2px dashed #e39a3b"></span>RabbitMQ · Galera</span><span><span class="sw" style="border:2px dashed #3aa6a2"></span>Masakari 세그먼트</span><span><span class="sw" style="border:2px dashed #c9b400"></span>Ceph</span></div></div>
<div class="sec"><div class="sh"><span class="n">2</span><h2>노드 배치 VM</h2><span class="d lgd"><span class="vm k8s">k8s 노드</span><span class="vm">그 밖</span><span class="vm ev" style="margin:0 4px">노란 테두리 = evacuation 대상(HA_Enabled)</span>VM 에 마우스를 올리면 ③ 에서 그 열이 표시됩니다</span></div><div class="vg" style="grid-template-columns:repeat(${cols},minmax(0,1fr))">${m.vms.length ? vmHtml : '<div class="vnone">VM 을 읽지 못했습니다</div>'}</div></div>
${K ? `<div class="sec"><div class="sh"><span class="n">3</span><h2>k8s 애플리케이션 배치</h2><span class="d">● 하나 = 파드 하나 · 같은 이름의 레플리카를 한 줄로</span></div>${pd}
<div class="note">'물리 노드' 는 레플리카가 물리 노드 몇 대에 나뉘어 있는지입니다. <b class="sp bad">1대에 몰림</b> 은 그 노드를 내리면 레플리카가 모두 같이 내려갑니다. '대기' 는 노드에 배치되지 못한(Pending) 파드입니다.<br>DaemonSet 과 control-plane 정적 파드는 맨 아래에 모았습니다. 파드 IP 는 바뀌는 값이라 싣지 않습니다.</div></div>` : ''}
<div class="sec"><div class="sh"><span class="n">${K ? 4 : 3}</span><h2>IP 목록</h2><span class="d">찾기 · 복사용</span></div>${inv}</div>
</div><script>(function(){document.querySelectorAll('.vm[data-vm]').forEach(function(el){el.addEventListener('mouseenter',function(){el.classList.add('hl');document.querySelectorAll('[data-col="'+el.getAttribute('data-vm')+'"]').forEach(function(x){x.classList.add('hl')})});el.addEventListener('mouseleave',function(){document.querySelectorAll('.hl').forEach(function(x){x.classList.remove('hl')})})})})()</script></body></html>`
}

// ── 수집본 비교(2026-11-14 사용자 결정 · 목업 envdiff-mock) ─────────────
/*
 * 두 구성도(보통 이전 버전 그룹 → 지금 그룹)의 차이. 표시는 **변경 · 신규 · 동일** 셋뿐이다(사용자 결정: 이동 · 사양 · 없어짐 · 나빠짐도
 * 모두 '변경' — 무엇이 어떻게 바뀌었는지는 이전 · 지금 칸의 글로 읽는다). 색은 변경 주황 · 신규 파랑 · 동일 초록.
 * 짝짓기: 물리 노드는 표준 이름('노드 1')으로(버전마다 호스트 이름이 다를 수 있다), VM 은 이름 머리(Epoxy_)를 뗀 이름으로,
 * 워크로드는 네임스페이스/이름으로. 분산이 나빠진 워크로드(나뉨 → 몰림)는 표시는 변경이지만 맨 위에 두고 지금 칸을 빨강으로
 */
export type DiffMark = 'chg' | 'add' | 'same'
export interface DiffRow {
  key: string
  before: string
  after: string
  mark: DiffMark
  /** 맨 위로 · 빨강(분산 나빠짐) */
  worse?: boolean
}
export interface EnvDiff {
  sections: { title: string; desc?: string; keyHead: string; rows: DiffRow[] }[]
  counts: Record<DiffMark, number>
}
const NONE = '없음'
const drow = (key: string, before: string | undefined, after: string | undefined): DiffRow => ({
  key,
  before: before ?? NONE,
  after: after ?? NONE,
  mark: before == null ? 'add' : before === after ? 'same' : 'chg',
})
const vmKey = (n: string) => n.replace(/^[A-Za-z0-9]+[_-]/, '').toLowerCase()
/** 워크로드의 물리 노드 분산 — 화면의 '물리 노드' 칸과 같은 판정 */
export function spreadText(m: EnvMapSnapshot, w: K8sWorkload): { text: string; phys: number; known: boolean } {
  const hostOf = (k: string) => m.k8s?.nodes.find((n) => n.name === k)?.host ?? ''
  const total = Object.values(w.at).reduce((a, x) => a + x, 0)
  const hs = Object.keys(w.at).map(hostOf)
  const phys = new Set(hs.filter(Boolean)).size
  const known = !hs.some((h) => !h)
  const text = total < 2 ? '단일 파드' : !known ? '물리 노드 모름' : phys === 1 ? '1대에 몰림' : `${phys}대에 나뉨`
  return { text: `레플리카 ${total + w.pending} · ${text}`, phys, known }
}
const nodeSummary = (n: EnvMapNode) =>
  [
    roleText(n.role),
    n.vip ? 'VIP' : '',
    n.pcs?.dc ? 'DC' : '',
    n.pcs?.state === 'standby' ? 'Pacemaker standby' : n.pcs?.state === 'offline' ? 'Pacemaker OFFLINE' : '',
    n.ceph?.mon ? 'MON' : '',
    n.ceph?.mgr ? (n.ceph.mgrActive ? 'MGR active' : 'MGR') : '',
    n.ceph?.mds ? (n.ceph.mdsActive ? 'MDS active' : 'MDS') : '',
    n.ceph?.rgw ? 'RGW' : '',
    n.ceph?.osds.length ? `OSD ${n.ceph.osds.length}개` : '',
    n.mysql === 'outside' ? 'mysql (Galera 구성 미포함)' : '',
    n.rabbit === 'outside' ? 'rabbitmq-server (클러스터 구성 미포함)' : '',
  ]
    .filter(Boolean)
    .join(' · ') + (n.facts ? '' : ' (노드 정보 못 읽음)')
/** 노드에서 도는 OpenStack · Masakari 서비스 이름 모음 */
const serviceSet = (m: EnvMapSnapshot) => {
  const s = new Set<string>()
  for (const n of m.nodes) {
    if (!n.facts) continue
    const r = serviceRoles(n.facts.units)
    r.nova.forEach((x) => s.add(`nova ${x}`))
    r.neutron.forEach((x) => s.add(`neutron ${x}`))
    r.masakari.forEach((x) => s.add(`masakari ${x}`))
    r.other.forEach((x) => s.add(x))
  }
  return s
}

export function diffEnvMaps(a: EnvMapSnapshot, b: EnvMapSnapshot): EnvDiff {
  const osOf = (m: EnvMapSnapshot) => m.nodes.find((n) => n.facts)?.facts
  const sw: DiffRow[] = [
    drow('OS', osOf(a)?.os, osOf(b)?.os),
    drow('커널', osOf(a)?.kernel, osOf(b)?.kernel),
    drow('Ceph', a.ceph?.version || undefined, b.ceph?.version || undefined),
    drow('Kubernetes', a.k8s?.version || undefined, b.k8s?.version || undefined),
    drow('RabbitMQ', a.rabbit?.version || undefined, b.rabbit?.version || undefined),
  ].filter((r) => !(r.before === NONE && r.after === NONE))

  const labels = [...new Set([...a.nodes.map((n) => n.label), ...b.nodes.map((n) => n.label)])].sort(natural)
  const nodeRows = labels.map((l) => {
    const na = a.nodes.find((n) => n.label === l)
    const nb = b.nodes.find((n) => n.label === l)
    return drow(`${l} · ${(nb ?? na)!.host}`, na ? nodeSummary(na) : undefined, nb ? nodeSummary(nb) : undefined)
  })
  const sa = serviceSet(a)
  const sb = serviceSet(b)
  const addS = [...sb].filter((x) => !sa.has(x))
  const delS = [...sa].filter((x) => !sb.has(x))
  if (sa.size || sb.size)
    nodeRows.push({
      key: '서비스',
      before: delS.length ? delS.join(' · ') : `${sa.size}종`,
      after: addS.length ? addS.map((x) => `+ ${x}`).join(' · ') : `${sb.size}종`,
      mark: addS.length || delS.length ? 'chg' : 'same',
    })
  const cl = (m: EnvMapSnapshot) =>
    [m.pcs ? `Pacemaker ${m.pcs.nodes}노드 · DC ${m.nodes.find((n) => n.host === m.pcs!.dc)?.label ?? m.pcs.dc}` : '', m.rabbit ? `RabbitMQ ${m.rabbit.running}/${m.rabbit.members.length}` : '', m.galera ? `Galera ${m.galera.size}` : '']
      .filter(Boolean)
      .join(' · ') || undefined
  nodeRows.push(drow('클러스터', cl(a), cl(b)))
  const cp = (m: EnvMapSnapshot) => (m.ceph ? [`OSD ${m.ceph.osdNum}`, ...m.ceph.replicas, TiB(m.ceph.totalBytes)].filter(Boolean).join(' · ') : undefined)
  nodeRows.push(drow('Ceph', cp(a), cp(b)))
  const sg = (m: EnvMapSnapshot) =>
    m.segments.length ? m.segments.map((s) => `${s.name} · 호스트 ${s.hosts.length}${s.recovery ? ` · ${s.recovery === 'auto' ? '자동 복구' : s.recovery}` : ''}`).join(' / ') : undefined
  nodeRows.push(drow('Masakari 세그먼트', sg(a), sg(b)))

  const vmText = (m: EnvMapSnapshot, v: EnvMapVm) =>
    [m.nodes.find((n) => n.host === v.host)?.label ?? v.host, v.vcpus ? `${v.vcpus} vCPU · ${v.ramGB}GB` : '', v.ha ? 'evacuation 대상' : '', v.status !== 'ACTIVE' ? v.status : ''].filter(Boolean).join(' · ')
  const vk = [...new Set([...a.vms.map((v) => vmKey(v.name)), ...b.vms.map((v) => vmKey(v.name))])].sort(natural)
  const vmRows = vk.map((k) => {
    const va = a.vms.find((v) => vmKey(v.name) === k)
    const vb = b.vms.find((v) => vmKey(v.name) === k)
    return drow((vb ?? va)!.name.replace(/^[A-Za-z0-9]+[_-]/, ''), va ? vmText(a, va) : undefined, vb ? vmText(b, vb) : undefined)
  })

  const wk = (w: K8sWorkload) => `${w.ns} / ${w.name}`
  const wa = new Map((a.k8s?.podsOk ? a.k8s.workloads : []).map((w) => [wk(w), w]))
  const wb = new Map((b.k8s?.podsOk ? b.k8s.workloads : []).map((w) => [wk(w), w]))
  const k8sRows = [...new Set([...wa.keys(), ...wb.keys()])].sort(natural).map((k) => {
    const x = wa.get(k)
    const y = wb.get(k)
    const sx = x ? spreadText(a, x) : null
    const sy = y ? spreadText(b, y) : null
    const r = drow(k, sx?.text, sy?.text)
    // 나뉨 → 몰림(물리 노드 하나에)
    if (sx && sy && sx.known && sy.known && sx.phys > 1 && sy.phys === 1) r.worse = true
    return r
  })
  k8sRows.sort((p, q) => Number(!!q.worse) - Number(!!p.worse))

  const sections = [
    { title: '버전 · 소프트웨어', keyHead: '항목', rows: sw },
    { title: '물리 노드 · 클러스터', desc: '노드는 표준 이름(노드 1 …)끼리 맞춘다', keyHead: '노드', rows: nodeRows },
    { title: 'VM 배치', desc: '이름 머리(Epoxy_ 등)를 떼고 같은 이름끼리 맞춘다', keyHead: 'VM', rows: vmRows },
    ...(a.k8s || b.k8s ? [{ title: 'k8s 애플리케이션 배치', desc: '레플리카 수 · 물리 노드 분산', keyHead: '워크로드', rows: k8sRows }] : []),
  ]
  const counts: Record<DiffMark, number> = { chg: 0, add: 0, same: 0 }
  for (const s of sections) for (const r of s.rows) counts[r.mark]++
  return { sections, counts }
}

const DIFF_CSS = `*{box-sizing:border-box}body{margin:0;background:#eef1f5;color:#1b2430;font:13px/1.5 "Malgun Gothic","맑은 고딕",system-ui,sans-serif;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.wrap{max-width:1240px;margin:0 auto;padding:22px 16px 60px}
.top{background:linear-gradient(90deg,#1d3d78,#2d64c0);color:#fff;border-radius:10px;padding:16px 20px}.top h1{margin:0;font-size:19px}.top .sub{opacity:.85;font-size:12.5px;margin-top:4px}
.vs{display:flex;align-items:center;gap:10px;margin-top:10px;font-size:12.5px;flex-wrap:wrap}.vs b{background:rgba(255,255,255,.18);border-radius:5px;padding:2px 10px}
.sum{display:flex;gap:10px;margin:14px 0}.sum .k{display:flex;align-items:center;gap:7px;height:40px;background:#fff;border:1px solid #d8dde4;border-radius:8px;padding:0 14px;color:#5b6675;line-height:1}.sum .k b{font-size:18px;line-height:1}
.k.chg b{color:#a35b00}.k.add b{color:#1d5fd0}.k.same b{color:#047a3f}
.tools{margin-bottom:12px;font-size:12px}.tools label{display:inline-flex;align-items:center;gap:5px;cursor:pointer}
.sec{background:#fff;border:1px solid #d8dde4;border-radius:12px;padding:16px 18px 18px;margin-bottom:14px}
.sh{display:flex;align-items:center;gap:10px;margin-bottom:12px}.sh .n{background:#1f3a68;color:#fff;border-radius:6px;width:24px;height:24px;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:12px}.sh h2{margin:0;font-size:15px}.sh .d{margin-left:auto;color:#5b6675;font-size:12px}
table{width:100%;border-collapse:collapse;font-size:12px;table-layout:fixed}th,td{border:1px solid #d8dde4;padding:6px 9px;text-align:left;vertical-align:top;word-break:break-all}th{background:#c9d6ea;color:#1f3a68;text-align:center}td.c{text-align:center}
td.now{font-weight:700}tr.m-chg td.now{color:#a35b00}tr.m-add td.now{color:#1d5fd0}tr.worse td.now{color:#c21f1f}tr.m-same td{color:#5b6675;font-weight:400}td.none{color:#9aa3ae}
.tag{display:inline-block;border-radius:4px;padding:0 6px;font-size:11px;font-weight:700}.t-chg{background:#fff1e0;color:#a35b00}.t-add{background:#e6eefb;color:#1d5fd0}.t-same{background:#e3f4ea;color:#047a3f}
body:not(.all) tr.m-same{display:none}.empty{color:#5b6675;font-size:12px;padding:6px 2px}body.all .empty{display:none}
.note{font-size:12px;color:#5b6675;margin-top:8px}
@page{size:A4 landscape;margin:8mm}`
const MARK: Record<DiffMark, [string, string]> = { chg: ['t-chg', '변경'], add: ['t-add', '신규'], same: ['t-same', '동일'] }
export function renderEnvDiffHtml(a: EnvMapSnapshot, b: EnvMapSnapshot, opts: { title: string; nameA: string; nameB: string }): string {
  const d = diffEnvMaps(a, b)
  const secs = d.sections
    .map((s, i) => {
      const shown = s.rows.filter((r) => r.mark !== 'same').length
      const rows = s.rows
        .map(
          (r) =>
            `<tr class="m-${r.mark}${r.worse ? ' worse' : ''}"><td>${he(r.key)}</td><td class="${r.before === NONE ? 'none' : ''}">${he(r.before)}</td><td class="now${r.after === NONE ? ' none' : ''}">${he(r.after)}</td><td class="c"><span class="tag ${MARK[r.mark][0]}">${MARK[r.mark][1]}</span></td></tr>`,
        )
        .join('')
      return `<div class="sec"><div class="sh"><span class="n">${i + 1}</span><h2>${he(s.title)}</h2>${s.desc ? `<span class="d">${he(s.desc)}</span>` : ''}</div>
<table><colgroup><col style="width:24%"><col><col><col style="width:70px"></colgroup><thead><tr><th>${he(s.keyHead)}</th><th>이전</th><th>지금</th><th>변화</th></tr></thead><tbody>${rows}</tbody></table>${
        shown ? '' : '<div class="empty">변경 · 신규 없음(동일 항목도 보기로 펼칩니다)</div>'
      }${s.rows.some((r) => r.worse) ? '<div class="note">빨강은 물리 노드 분산이 나빠진 것(나뉨 → 몰림)입니다. 그 노드를 내리면 레플리카가 모두 같이 내려가므로 검증 전에 확인하세요.</div>' : ''}</div>`
    })
    .join('')
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${he(opts.title)}</title><style>${DIFF_CSS}</style></head><body><div class="wrap">
<div class="top"><h1>${he(opts.title)}</h1><div class="sub">조회 명령으로 수집한 두 구성도의 차이</div><div class="vs"><b>${he(opts.nameA)} · ${fmtAt(a.at)} 수집</b><span>→</span><b>${he(opts.nameB)} · ${fmtAt(b.at)} 수집</b></div></div>
<div class="sum"><div class="k chg">변경<b>${d.counts.chg}</b></div><div class="k add">신규<b>${d.counts.add}</b></div><div class="k same">동일<b>${d.counts.same}</b></div></div>
<div class="tools"><label><input type="checkbox" onchange="document.body.classList.toggle('all',this.checked)"> 동일 항목도 보기</label></div>
${secs}</div></body></html>`
}
