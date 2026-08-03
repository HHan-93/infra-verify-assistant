import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  X,
  Play,
  Square,
  RefreshCw,
  MapPin,
  Bolt,
  CircleCheck,
  Loader2,
  AlertTriangle,
  HeartPulse,
  Server,
  Settings2,
  Hourglass,
  Minus,
  Maximize2,
  Plus,
} from 'lucide-react'

interface BoardSession {
  id: string
  name: string
  connected: boolean
  /**
   * 저장된 프로필 키(host:port:username). 역할 매핑을 영속화할 때 쓰는 '안정적인' 식별자.
   * - 세션 id 는 앱 재시작 시 다른 서버에 재할당될 수 있어 못 쓴다.
   * - 표시 이름은 연결이 끊기면 "세션 N" 으로 바뀌어 버려서(App.gridCellLabel) 더 위험하다.
   * 이 값은 끊겨도 유지되므로(App 의 statuses[id].key) 매핑 키로 적합하다.
   */
  profileKey?: string
}
interface StatusBoardProps {
  sessions: BoardSession[]
  onClose: () => void
}

// 역할 매핑 설정 — localStorage 에 저장해 다음에 열 때 복원
interface BoardConfig {
  hosts: string[] // host1/2/3 세션 id (최대 3)
  masakari: string[] // 정상 2대 세션 id (최대 2)
  logPath: string
  ceph: string // Ceph 조회 세션 id
  pod: string // kubectl 조회 세션 id
  namespaces: string[] // 파드 상태 확인할 네임스페이스 목록
  podScope: 'abnormal' | 'all' // 비정상(Running·Ready 아닌 것)만 / 전체 파드
  services: string[] // Host 노드에서 systemctl is-active 로 확인할 서비스 유닛 목록(공통)
  showServices: boolean // 상태보드 우측 서비스 데몬 패널 표시 여부
  osSession: string // OpenStack CLI(openstack ...) 를 실행할 컨트롤러 세션 id
  osRc: string // admin_openrc 경로 (openstack CLI 인증정보 소싱용)
  showOpenstack: boolean // OpenStack 서비스(API) 섹션 표시 여부
  osScope: 'abnormal' | 'all' // 비정상(down/disabled)만 / 전체
  intervalSec: number
}
// v2 — 역할 매핑을 '세션 id' 가 아니라 '세션 이름(별칭 (IP))' 으로 저장한다.
// 세션 id 는 앱을 껐다 켜면 다른 서버에 재할당될 수 있어(특히 첫 탭 id 는 고정값),
// 저장된 매핑이 엉뚱한 서버에 붙은 채로 pcs/systemctl/kubectl 이 나가는 사고가 났다.
// 구버전 키(statusboard_cfg)는 위험하므로 읽지 않고 버린다.
const CFG_KEY = 'statusboard_cfg_v2'
/** cfg 안에서 세션을 가리키는 필드들 — 저장/복원 시 id ↔ 이름 변환 대상 */
const SESSION_FIELDS = { lists: ['hosts', 'masakari'] as const, singles: ['ceph', 'pod', 'osSession'] as const }
function mapCfgSessions(cfg: BoardConfig, convert: (v: string) => string): BoardConfig {
  const out: BoardConfig = { ...cfg }
  for (const k of SESSION_FIELDS.lists) out[k] = cfg[k].map((v) => (v ? convert(v) : v))
  for (const k of SESSION_FIELDS.singles) out[k] = cfg[k] ? convert(cfg[k]) : cfg[k]
  return out
}
// 노드별 서비스 데몬 프리셋 — 역할별 기본 유닛 목록(편집 가능). .service 는 생략.
// systemd 로 실제 관리되는 데몬만 기본값에 둔다. nova/glance/cinder/mariadb 처럼
// 컨테이너·WSGI·OpenStack API 로 도는 서비스는 systemctl 로 안 잡혀 오탐이 나므로 제외
// (그런 서비스는 `openstack ... service/agent list` 로 확인 — 별도 방식).
const SVC_PRESETS = {
  controller: [
    'rabbitmq-server', 'memcached',
    'neutron-server', 'httpd',
    'masakari-api', 'masakari-engine',
    'pacemaker', 'corosync', 'pcsd',
  ],
  compute: [
    'libvirtd', 'nova-compute', 'neutron-openvswitch-agent',
    'masakari-instancemonitor', 'masakari-processmonitor', 'masakari-hostmonitor',
  ],
}
// 유닛 목록 정규화(공백/빈 줄 제거) — 텍스트에어리어 편집 중 빈 줄을 허용하려고 소비 시점에만 적용
const cleanUnits = (arr: string[]): string[] => Array.from(new Set(arr.map((s) => s.trim()).filter(Boolean)))
const DEFAULT_CFG: BoardConfig = {
  hosts: ['', '', ''], // 기본 3슬롯(빈 값) — 노드 추가/삭제로 가변
  masakari: [],
  logPath: '/var/log/masakari/masakari-engine.log',
  ceph: '',
  pod: '',
  namespaces: ['dataplatform'],
  podScope: 'abnormal',
  services: [...SVC_PRESETS.controller],
  showServices: true,
  osSession: '',
  osRc: '~/contrabass-openrc',
  showOpenstack: false,
  osScope: 'abnormal',
  intervalSec: 5,
}
function loadCfg(): BoardConfig {
  try {
    const raw = localStorage.getItem(CFG_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<BoardConfig> & { namespace?: string }
      const merged: BoardConfig = { ...DEFAULT_CFG, ...parsed }
      // 구버전(namespace: string) → namespaces: string[] 마이그레이션 (raw 값 기준으로 판정)
      if (!Array.isArray(parsed.namespaces)) {
        merged.namespaces = parsed.namespace ? [parsed.namespace] : [...DEFAULT_CFG.namespaces]
      }
      return merged
    }
  } catch {
    /* 무시 */
  }
  return DEFAULT_CFG
}

// ── 파싱 결과 타입 ─────────────────────────────────────────────
interface HostStat {
  id: string
  name: string
  up: boolean
  vip: boolean
}
type MasakariState = 'finished' | 'progress' | 'unknown'
interface MasakariStat {
  id: string
  name: string
  state: MasakariState
  detail: string
  evac: number // T0 이후 evacuation 대상으로 감지된 인스턴스 수
}
interface CephStat {
  health: 'OK' | 'WARN' | 'ERR' | 'unknown'
  degraded: number
  misplaced: number
  total: number
  rate: number // objects/s
  etaSec: number | null
  reasons: string[] // HEALTH_WARN/ERR 사유 줄 (osd down, clock skew, pool full 등)
  note: string
}
interface PodRow {
  name: string
  ready: string // READY 컬럼 (예: "1/1", "0/1")
  status: string
  node: string
  healthy: boolean // Running + Ready 충족 (또는 Completed)
}
interface PodStat {
  namespace: string
  total: number
  abnormalCount: number // 표시 범위와 무관하게 항상 비정상 개수
  rows: PodRow[] // 표시할 행 (scope 에 따라 비정상만 또는 전체)
  note: string
}
type SvcState = 'active' | 'activating' | 'failed' | 'inactive' | 'notfound' | 'unknown'
interface NodeSvc {
  id: string
  name: string
  up: boolean
  states: Record<string, SvcState> // 유닛명 → 상태
}
interface OsSvc {
  type: 'nova' | 'neutron' | 'cinder'
  binary: string // nova-conductor, neutron-l3-agent, cinder-volume 등
  host: string
  up: boolean // State up / Alive
  enabled: boolean // Status enabled (admin state up)
}
interface OsStat {
  rows: OsSvc[] // scope 에 따라 비정상만 또는 전체
  abnormalCount: number // down 또는 disabled
  total: number
  errors: string[] // 조회 실패한 명령(권한/rc/CLI 문제) 안내
}
interface BoardState {
  hosts: HostStat[]
  vipNode: string
  masakari: MasakariStat[]
  ceph: CephStat | null
  pods: PodStat[]
  podScope: 'abnormal' | 'all'
  serviceUnits: string[] // 서비스 패널 행(유닛) 목록
  services: NodeSvc[] // 노드별 서비스 데몬 상태
  openstack: OsStat | null // OpenStack 서비스(API) 상태
  osScope: 'abnormal' | 'all'
  tzNote: string
  lastAt: number
}

// sudo -n(비번없이) 먼저 시도 → 실패 시 sudo 없이. root 진입이 기본이라 대개 첫 시도로 통과.
const sudoOr = (cmd: string) => `sudo -n ${cmd} 2>/dev/null || ${cmd} 2>&1`
const run = (id: string, cmd: string) => window.electronAPI.sessionRun(id, cmd)
// admin_openrc 를 소싱한 뒤 openstack CLI 를 JSON 으로 실행 (로그인 셸로 PATH 확보)
const osCmd = (rc: string, sub: string) => `bash -lc '. ${rc} 2>/dev/null; openstack ${sub} -f json 2>&1'`

// ── 파서 ───────────────────────────────────────────────────────
/** pcs status 출력에서 int_vip 리소스가 붙은 노드명 추출 */
function parseVipNode(out: string): string {
  const m = out.match(/int_vip\b[^\n]*?Started\s+(\S+)/i)
  return m ? m[1].trim() : ''
}
/** vipNode(pcs 노드명)가 이 host 인지 판정 — 실제 hostname 우선, 없으면 세션 표시명과 부분일치 */
function matchesVip(vipNode: string, name: string, hostname?: string): boolean {
  if (!vipNode) return false
  const v = vipNode.toLowerCase()
  const h = (hostname ?? '').toLowerCase()
  if (h && (h === v || h.startsWith(v + '.') || v === h.split('.')[0])) return true
  const n = name.toLowerCase()
  return n === v || n.includes(v) || v.includes(n)
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
// masakari-engine 의 인스턴스 단위 evacuation 호출 로그 (예: "Call evacuate command for instance <uuid> on host ...")
const EVAC_RE = new RegExp(`evacuate\\s+command\\s+for\\s+instance\\s+(${UUID})`, 'gi')
const UUID_RE = new RegExp(UUID, 'i')
// 로그에 섞인 ANSI 색상 이스케이프 제거
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g
const stripAnsi = (s: string) => s.replace(ANSI_RE, '')

/** 로그 줄 앞머리의 타임스탬프(YYYY-MM-DD HH:MM:SS)를 (호스트 로컬로) 파싱 → epoch ms (없으면 null) */
function lineTs(l: string): number | null {
  const m = l.match(/(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/)
  if (!m) return null
  const t = new Date(`${m[1]}T${m[2]}`).getTime()
  return Number.isNaN(t) ? null : t
}
/**
 * masakari-engine.log 에서 T0 이후 로그만 보고 evacuation 완료 여부 + 인스턴스 수 판정.
 * (이전 라운드의 finished 이력이 섞이지 않도록 반드시 T0 이후로 필터)
 * delta: 로그 타임스탬프(호스트 로컬 표기)를 PC-로컬로 파싱했을 때와 절대시각의 차이(ms).
 *   host 가 UTC 등 다른 TZ 여도 이 값으로 보정해 T0(절대시각) 비교가 맞도록 한다.
 */
function parseMasakari(
  out: string,
  t0: number,
  delta: number,
): { state: MasakariState; detail: string; evac: number } {
  const all = stripAnsi(out).split('\n').filter(Boolean)
  const recent = all.filter((l) => {
    const ts = lineTs(l)
    return ts != null && ts - delta >= t0
  })
  if (!recent.length) return { state: 'progress', detail: '검증 시작 후 evacuation 로그 없음', evac: 0 }
  const uuids = new Set<string>()
  for (const l of recent) {
    let m: RegExpExecArray | null
    EVAC_RE.lastIndex = 0
    while ((m = EVAC_RE.exec(l)) !== null) uuids.add(m[1].toLowerCase())
  }
  // 정확한 패턴이 안 잡히면 evacuat 라인의 UUID 로 폴백
  if (uuids.size === 0) {
    for (const l of recent) {
      if (/evacuat/i.test(l)) {
        const u = l.match(UUID_RE)
        if (u) uuids.add(u[0].toLowerCase())
      }
    }
  }
  const evac = uuids.size
  // 완료 판정: 알림이 실제로 종료된 로그만 매칭 ("Notification <uuid> exits with status: finished.")
  //   중복 스킵 WARNING("...current status ... in db is 'finished'")이나 "Processing notification..." 은 완료가 아님.
  const finished = recent.some((l) => /exits\s+with\s+status:\s*finished/i.test(l))
  if (finished) return { state: 'finished', detail: evac ? `evacuation 완료 · ${evac}대` : 'evacuation 완료', evac }
  return { state: 'progress', detail: evac ? `진행 중 · ${evac}대 처리` : 'evacuation 진행 중', evac }
}
/** ceph -s 출력 파싱 (health / 잔여 objects / 복구 속도 / ETA) */
function parseCeph(out: string): CephStat {
  const health = /HEALTH_OK/.test(out)
    ? 'OK'
    : /HEALTH_WARN/.test(out)
      ? 'WARN'
      : /HEALTH_ERR/.test(out)
        ? 'ERR'
        : 'unknown'
  const deg = out.match(/(\d+)\/(\d+)\s+objects\s+degraded/i)
  const mis = out.match(/(\d+)\/(\d+)\s+objects\s+misplaced/i)
  const degraded = deg ? parseInt(deg[1], 10) : 0
  const misplaced = mis ? parseInt(mis[1], 10) : 0
  const total = Math.max(deg ? parseInt(deg[2], 10) : 0, mis ? parseInt(mis[2], 10) : 0)
  // recovery: 218 MiB/s, 54 objects/s  형태에서 objects/s 추출
  const rt = out.match(/([\d.]+)\s*(k|M|G)?\s*objects\/s/i)
  let rate = rt ? parseFloat(rt[1]) : 0
  if (rt && rt[2]) {
    const u = rt[2].toLowerCase()
    rate *= u === 'k' ? 1e3 : u === 'm' ? 1e6 : 1e9
  }
  const remain = degraded + misplaced
  const etaSec = rate > 0 && remain > 0 ? Math.round(remain / rate) : null

  // HEALTH_WARN/ERR 사유 줄 추출 — `health: HEALTH_X` 아래 더 들여쓴 줄들을 다음 섹션 전까지 수집
  //   (예: "1 osds down", "clock skew detected on mon.b", "Degraded data redundancy: ...")
  const reasons: string[] = []
  const lines = out.split('\n')
  const hi = lines.findIndex((l) => /health:\s*HEALTH_/i.test(l))
  if (hi >= 0) {
    const baseIndent = lines[hi].search(/\S/)
    // 같은 줄에 사유가 붙는 경우도 있음: "health: HEALTH_WARN  <사유>"
    const inline = lines[hi].replace(/.*HEALTH_(OK|WARN|ERR)\s*/i, '').trim()
    if (inline) reasons.push(inline)
    for (let i = hi + 1; i < lines.length; i++) {
      const ind = lines[i].search(/\S/)
      if (ind <= baseIndent) break // 빈 줄(-1)이거나 상위 섹션으로 dedent → 종료
      reasons.push(lines[i].trim())
    }
  }
  const note =
    health === 'OK' && remain === 0
      ? 'HEALTH_OK · 복구 완료'
      : health === 'unknown'
        ? '조회 실패 (권한/명령 확인)'
        : '리밸런스 진행 중'
  return { health, degraded, misplaced, total, rate, etaSec, reasons, note }
}
/**
 * kubectl get pods -o wide --no-headers 파싱.
 * 컬럼: NAME READY STATUS RESTARTS AGE IP NODE ...
 * 정상(healthy) = Completed 이거나, Running 이면서 READY 가 a/a(모두 준비). 그 외는 비정상.
 * scope='abnormal' → 비정상 행만, 'all' → 전체 행 반환. (abnormalCount 는 항상 계산)
 */
function parsePods(namespace: string, out: string, scope: 'abnormal' | 'all'): PodStat {
  const lines = out
    .split('\n')
    .map((l) => l.trim())
    // kubectl 안내/에러 줄 제외 ("No resources found in <ns> namespace." 등)
    .filter((l) => l && !/^error|^the connection|^the server|no resources found|not found|unable to connect|forbidden/i.test(l))
  if (!lines.length) return { namespace, total: 0, abnormalCount: 0, rows: [], note: '파드 없음 또는 조회 실패' }
  const all: PodRow[] = []
  for (const l of lines) {
    const cols = l.split(/\s+/)
    if (cols.length < 3) continue
    const name = cols[0]
    const ready = cols[1] ?? ''
    const status = cols[2]
    // RESTARTS 가 "5 (23h ago)" 처럼 공백을 포함해 컬럼이 밀릴 수 있어, NODE 는 IP 바로 다음 토큰으로 찾는다.
    // (NAME/READY/STATUS 는 항상 앞 3개로 고정) IP 는 IPv4 / IPv6(':') / 미스케줄 '<none>' 형태.
    let node = '-'
    for (let idx = 3; idx < cols.length - 1; idx++) {
      const c = cols[idx]
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(c) || c.includes(':') || c === '<none>') {
        node = cols[idx + 1] ?? '-'
        break
      }
    }
    const rf = /^(\d+)\/(\d+)$/.exec(ready)
    const readyFull = rf ? rf[1] === rf[2] : true // "a/b" 형태가 아니면 판정 보류(정상 취급)
    const healthy = /^Completed$/i.test(status) || (/^Running$/i.test(status) && readyFull)
    all.push({ name, ready, status, node, healthy })
  }
  const abnormalCount = all.filter((p) => !p.healthy).length
  const rows = scope === 'all' ? all : all.filter((p) => !p.healthy)
  return { namespace, total: all.length, abnormalCount, rows, note: '' }
}
// 유닛명 정규화(.service 등 접미사 제거) — Id= 값과 사용자가 입력한 이름을 같은 키로 맞춘다
const svcKey = (u: string) => u.trim().replace(/\.(service|socket|target|timer|mount|path|scope|slice)$/i, '')
// LoadState/ActiveState/SubState → 표시 상태
function svcStateFrom(load: string, active: string, sub: string): SvcState {
  if (load === 'not-found') return 'notfound'
  if (active === 'active') return 'active'
  if (active === 'activating' || active === 'reloading' || active === 'deactivating') return 'activating'
  if (active === 'failed' || sub === 'failed') return 'failed'
  if (active === 'inactive') return 'inactive'
  return 'unknown'
}
/**
 * `systemctl show -p Id -p LoadState -p ActiveState -p SubState <units...>` 출력을 유닛→상태로 매핑.
 * 각 유닛이 빈 줄로 구분된 블록으로 나오고 블록마다 Id= 로 자기 이름을 밝히므로(줄 순서 의존 X),
 * 컨트롤러/컴퓨트가 섞여 일부 유닛이 없는 경우에도 정렬이 어긋나지 않는다.
 * 해당 노드에 유닛이 없으면 LoadState=not-found → 'notfound'('없음')로 구분(‘중지’ 오탐 방지).
 */
function parseServices(units: string[], out: string): Record<string, SvcState> {
  const res: Record<string, SvcState> = {}
  units.forEach((u) => {
    res[svcKey(u)] = 'unknown'
  })
  for (const block of out.split(/\n\s*\n/)) {
    const kv: Record<string, string> = {}
    for (const line of block.split('\n')) {
      const i = line.indexOf('=')
      if (i > 0) kv[line.slice(0, i).trim()] = line.slice(i + 1).trim()
    }
    if (!kv.Id) continue
    res[svcKey(kv.Id)] = svcStateFrom(
      (kv.LoadState ?? '').toLowerCase(),
      (kv.ActiveState ?? '').toLowerCase(),
      (kv.SubState ?? '').toLowerCase(),
    )
  }
  return res
}

/**
 * `openstack ... service/agent list -f json` 출력(JSON 배열)을 서비스 인스턴스 목록으로 파싱.
 * nova(compute service)/cinder(volume service): Binary/Host/Status(enabled|disabled)/State(up|down).
 * neutron(network agent): Binary(또는 Agent Type)/Host/Alive(true|:-))/State(UP|DOWN)/Admin State Up.
 * JSON 파싱 실패(rc 미소싱·CLI 없음·권한)면 빈 배열 + 에러로 처리.
 */
function parseOsJson(out: string, type: OsSvc['type']): { rows: OsSvc[]; ok: boolean } {
  let arr: unknown
  try {
    arr = JSON.parse(out.trim())
  } catch {
    return { rows: [], ok: false }
  }
  if (!Array.isArray(arr)) return { rows: [], ok: false }
  const isUp = (v: unknown) => v === true || /^(up|true|:-\))/i.test(String(v ?? '').trim())
  const isEnabled = (v: unknown) => (v === undefined ? true : v === true || /^(enabled|up|true)/i.test(String(v ?? '').trim()))
  const rows: OsSvc[] = arr.map((raw) => {
    const o = raw as Record<string, unknown>
    const binary = String(o.Binary ?? o['Agent Type'] ?? o.binary ?? '?')
    const host = String(o.Host ?? o.host ?? '?')
    // 주의: neutron(network agent)은 Alive=작동상태, State=관리상태(UP/DOWN)로 nova/cinder와 필드 의미가 반대다.
    //   nova/cinder: State=작동(up/down), Status=관리(enabled/disabled).
    //   (이 구분을 안 하면 죽은 neutron 에이전트 Alive:false·State:"UP" 가 초록 up 으로 오탐됨)
    let up: boolean
    let enabled: boolean
    if (type === 'neutron') {
      up = isUp(o.Alive)
      enabled = isEnabled(o.State ?? o['Admin State Up'])
    } else {
      up = isUp(o.State ?? o.state)
      enabled = isEnabled(o.Status ?? o['Admin State Up'])
    }
    return { type, binary, host, up, enabled }
  })
  return { rows, ok: true }
}
/** nova/neutron/cinder 세 조회결과를 합쳐 전체 rows + 비정상(down/disabled) 집계 (매트릭스 표시는 패널에서 scope 적용) */
function parseOpenstack(nova: string, neutron: string, cinder: string): OsStat {
  const parts: Array<[OsSvc['type'], string, string]> = [
    ['nova', nova, 'compute service list'],
    ['neutron', neutron, 'network agent list'],
    ['cinder', cinder, 'volume service list'],
  ]
  const all: OsSvc[] = []
  const errors: string[] = []
  for (const [type, out, label] of parts) {
    if (!out.trim()) continue // 미조회(세션/명령 스킵)
    const { rows, ok } = parseOsJson(out, type)
    if (!ok) errors.push(`openstack ${label} 조회 실패`)
    else all.push(...rows)
  }
  const abnormalCount = all.filter((s) => !s.up || !s.enabled).length
  return { rows: all, abnormalCount, total: all.length, errors }
}

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(s / 60)
  const ss = s % 60
  return `${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
}
function fmtEta(sec: number): string {
  if (sec < 60) return `약 ${sec}초`
  return `약 ${Math.round(sec / 60)}분`
}

/**
 * 가용성 검증 상태보드 — 역할 매핑(host/masakari/ceph/pod 세션 지정) 후, 각 역할 세션에
 * 단발 명령(session:run)을 주기 폴링해 상태 카드 + 복구 타임라인으로 표시한다.
 * 신규 IPC 없이 기존 sessionRun 만 사용하며, 겹침 방지를 위해 재귀 setTimeout 으로 폴링한다.
 */
export default function StatusBoard({ sessions, onClose }: StatusBoardProps) {
  const [cfg, setCfg] = useState<BoardConfig>(loadCfg)
  const [view, setView] = useState<'config' | 'board'>('config')
  const [state, setState] = useState<BoardState | null>(null)
  const [running, setRunning] = useState(false)
  const [minimized, setMinimized] = useState(false)
  // 최소화 칩 위치(px). null 이면 기본(좌하단). 드래그로 옮길 수 있다.
  const [chipPos, setChipPos] = useState<{ x: number; y: number } | null>(null)
  const chipDrag = useRef<{ dx: number; dy: number } | null>(null)
  const onChipDown = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button')) return // 버튼 클릭은 드래그 아님
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    chipDrag.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top }
    const move = (ev: MouseEvent) => {
      if (!chipDrag.current) return
      const x = Math.max(4, Math.min(window.innerWidth - rect.width - 4, ev.clientX - chipDrag.current.dx))
      const y = Math.max(4, Math.min(window.innerHeight - rect.height - 4, ev.clientY - chipDrag.current.dy))
      setChipPos({ x, y })
    }
    const up = () => {
      chipDrag.current = null
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }
  // 최소화 시 칩을 툴바의 '포트 포워딩(터널)' 버튼 우측에 붙인다(기본 위치). 이후 드래그로 옮길 수 있다.
  const minimize = () => {
    const btn = document.querySelector('[data-anchor="tunnel"]') as HTMLElement | null
    if (btn) {
      const r = btn.getBoundingClientRect()
      const w = 280
      setChipPos({ x: Math.max(4, Math.min(window.innerWidth - w - 4, r.right + 6)), y: Math.max(4, r.top) })
    } else {
      setChipPos(null)
    }
    setMinimized(true)
  }
  const runningRef = useRef(false)
  const mountedRef = useRef(true)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const t0Ref = useRef<number>(0)
  // 마일스톤 최초 감지 시각(경과 ms) — 복구 타임라인용
  const msRef = useRef<{ vip?: number; masakari?: number; ceph?: number }>({})
  // host 세션 id → 실제 hostname (VIP 노드명 매칭용, 세션당 1회만 조회)
  const hostnamesRef = useRef<Record<string, string>>({})
  // masakari 세션 id → 로그시각 보정값 { delta(ms), ok } (검증 시작 시 host date 로 1회 산출)
  const calibRef = useRef<Record<string, { delta: number; ok: boolean }>>({})

  // 폴링 루프는 시작 시점의 클로저에 고정되므로, 최신 cfg/sessions 를 ref 로 노출해 항상 최신값을 읽게 한다.
  const cfgRef = useRef(cfg)
  cfgRef.current = cfg
  const sessionsRef = useRef(sessions)
  sessionsRef.current = sessions

  const nameOf = (id: string) => sessionsRef.current.find((s) => s.id === id)?.name ?? id
  const connectedOf = (id: string) => sessionsRef.current.find((s) => s.id === id)?.connected ?? false
  const connected = sessions.filter((s) => s.connected)

  // 저장은 '프로필 키'로. 세션 id 는 재시작 시 다른 서버에 재할당되고, 표시 이름은 연결이
  // 끊기는 순간 "세션 N" 으로 바뀌어 버려서 둘 다 영속 키로 쓸 수 없다.
  // 프로필 키가 없는 세션(한 번도 접속 안 한 로컬 탭)은 저장하지 않는다 — 복원할 방법이 없으므로.
  const keyOf = (id: string) => sessionsRef.current.find((s) => s.id === id)?.profileKey ?? ''
  const saveCfg = (next: BoardConfig) => {
    setCfg(next)
    try {
      localStorage.setItem(CFG_KEY, JSON.stringify(mapCfgSessions(next, keyOf)))
    } catch {
      /* 무시 */
    }
  }

  // 복원 직후 cfg 의 세션 칸에는 '프로필 키'가 들어있다. 세션 목록과 대조해 id 로 바꾼다.
  // 아직 그 서버를 안 열었으면 키를 그대로 두고(=미해석), 나중에 열리면 이 이펙트가 다시 채운다.
  // 매칭 실패를 조용히 빈 값으로 만들면 사용자가 매핑이 사라진 걸 눈치채지 못하므로 유지한다.
  useEffect(() => {
    setCfg((cur) => {
      const next = mapCfgSessions(cur, (v) => {
        if (sessions.some((s) => s.id === v)) return v // 이미 살아있는 세션 id
        return sessions.find((s) => s.profileKey && s.profileKey === v)?.id ?? v
      })
      // 실제로 바뀐 게 없으면 같은 객체를 돌려줘 무한 렌더를 피한다
      return JSON.stringify(next) === JSON.stringify(cur) ? cur : next
    })
  }, [sessions])
  /** cfg 값이 현재 열린 세션으로 해석되지 않는 상태(=아직 안 연 서버)인지 */
  const unresolved = (v: string) => !!v && !sessions.some((s) => s.id === v)

  // 보드에서 네임스페이스 카드의 X → 설정에서 제외(다음 폴링부터 미조회) + 현재 화면에서도 즉시 제거
  const removeNamespaceLive = (ns: string) => {
    saveCfg({ ...cfgRef.current, namespaces: cfgRef.current.namespaces.filter((n) => n !== ns) })
    setState((s) => (s ? { ...s, pods: s.pods.filter((p) => p.namespace !== ns) } : s))
  }

  // 한 번 폴링: 4개 그룹 병렬 실행 → 파싱 → state 갱신 (항상 최신 cfg 를 ref 로 읽음)
  const pollOnce = async () => {
    const c = cfgRef.current
    // 같은 세션을 여러 역할 슬롯에 지정했을 때 중복 명령/중복 카운트/React key 충돌을 막으려 중복 제거
    const hostIds = Array.from(new Set(c.hosts.filter(Boolean)))
    const masaIds = Array.from(new Set(c.masakari.filter(Boolean)))
    // VIP 판정용: host 중 연결된(UP) 첫 세션
    const vipSession = hostIds.find((id) => connectedOf(id)) ?? ''

    // 각 host 의 실제 hostname 을 (아직 없으면) 한 번만 조회해 VIP 노드명 매칭에 사용
    await Promise.all(
      hostIds.map(async (id) => {
        if (!connectedOf(id) || hostnamesRef.current[id]) return
        const r = await run(id, 'hostname -s 2>/dev/null || hostname')
        if (r.ok && (r.out ?? '').trim()) hostnamesRef.current[id] = (r.out ?? '').trim().split('\n')[0]
      }),
    )

    // masakari host 의 로그시각 보정값(delta)을 (아직 없으면) 한 번만 산출
    //   date 로 '절대epoch 로컬표기' 를 받아, 로컬표기를 PC-로컬로 파싱한 값과 절대시각의 차이를 delta 로 둔다.
    await Promise.all(
      masaIds.map(async (id) => {
        if (!connectedOf(id) || calibRef.current[id]) return
        const r = await run(id, `date '+%s %Y-%m-%dT%H:%M:%S'`)
        const parts = (r.ok ? r.out ?? '' : '').trim().split(/\s+/)
        const epoch = parseInt(parts[0], 10)
        const localMs = parts[1] ? Date.parse(parts[1]) : NaN
        if (!Number.isNaN(epoch) && !Number.isNaN(localMs)) {
          calibRef.current[id] = { delta: localMs - epoch * 1000, ok: true }
        } else {
          calibRef.current[id] = { delta: 0, ok: false }
        }
      }),
    )

    const namespaces = c.namespaces.filter(Boolean)
    const svcUnits = cleanUnits(c.services)
    const [pcsOut, masResults, cephOut, pods, svcResults, osResults] = await Promise.all([
      vipSession ? run(vipSession, sudoOr('pcs status')).then((r) => (r.ok ? (r.out ?? '') : '')) : Promise.resolve(''),
      Promise.all(
        masaIds.map(async (id) => {
          if (!connectedOf(id)) return { id, state: 'unknown' as MasakariState, detail: '세션 미연결', evac: 0 }
          const cmd = sudoOr(`sh -c 'tail -n 4000 ${c.logPath} | grep -iE "evacuat|finish|complet|notification" | tail -n 200'`)
          const r = await run(id, cmd)
          const p = parseMasakari(r.ok ? (r.out ?? '') : '', t0Ref.current, calibRef.current[id]?.delta ?? 0)
          return { id, ...p }
        }),
      ),
      c.ceph && connectedOf(c.ceph)
        ? run(c.ceph, sudoOr('ceph -s')).then((r) => (r.ok ? (r.out ?? '') : ''))
        : Promise.resolve(''),
      c.pod && connectedOf(c.pod) && namespaces.length
        ? Promise.all(
            namespaces.map(async (ns) => {
              const r = await run(c.pod, `kubectl get pods -n ${ns} -o wide --no-headers 2>&1`)
              return parsePods(ns, r.ok ? (r.out ?? '') : '', c.podScope)
            }),
          )
        : Promise.resolve([] as PodStat[]),
      // 5) 노드별 서비스 데몬 상태 — Host 세션에 systemctl is-active 묶음 조회
      c.showServices && svcUnits.length && hostIds.length
        ? Promise.all(
            hostIds.map(async (id) => {
              if (!connectedOf(id)) return { id, name: nameOf(id), up: false, states: {} as Record<string, SvcState> }
              const r = await run(id, `systemctl show -p Id -p LoadState -p ActiveState -p SubState ${svcUnits.join(' ')} 2>/dev/null`)
              return { id, name: nameOf(id), up: true, states: parseServices(svcUnits, r.ok ? (r.out ?? '') : '') }
            }),
          )
        : Promise.resolve([] as NodeSvc[]),
      // 6) OpenStack 서비스(API) — 지정 세션에서 admin_openrc 소싱 후 nova/neutron/cinder 목록 조회
      c.showOpenstack && c.osSession && connectedOf(c.osSession)
        ? Promise.all([
            run(c.osSession, osCmd(c.osRc, 'compute service list')).then((r) => (r.ok ? (r.out ?? '') : '')),
            run(c.osSession, osCmd(c.osRc, 'network agent list')).then((r) => (r.ok ? (r.out ?? '') : '')),
            run(c.osSession, osCmd(c.osRc, 'volume service list')).then((r) => (r.ok ? (r.out ?? '') : '')),
          ]).then(([nova, neutron, cinder]) => parseOpenstack(nova, neutron, cinder))
        : Promise.resolve(null as OsStat | null),
    ])

    const vipNode = parseVipNode(pcsOut)
    const hosts: HostStat[] = hostIds.map((id) => {
      const up = connectedOf(id)
      const nm = nameOf(id)
      const vip = up && matchesVip(vipNode, nm, hostnamesRef.current[id])
      return { id, name: nm, up, vip }
    })
    const masakari: MasakariStat[] = masResults.map((m) => ({
      id: m.id,
      name: nameOf(m.id),
      state: m.state,
      detail: m.detail,
      evac: m.evac,
    }))
    const ceph = cephOut ? parseCeph(cephOut) : null

    // 마일스톤 최초 감지 기록
    const el = Date.now() - t0Ref.current
    if (msRef.current.vip == null && vipNode) msRef.current.vip = el
    if (msRef.current.masakari == null && masakari.some((m) => m.state === 'finished')) msRef.current.masakari = el
    if (msRef.current.ceph == null && ceph?.health === 'OK' && ceph.degraded + ceph.misplaced === 0)
      msRef.current.ceph = el

    // 시각 보정 안내
    const calibs = masaIds.map((id) => calibRef.current[id]).filter(Boolean)
    let tzNote = ''
    if (calibs.length && calibs.some((cb) => !cb.ok)) {
      tzNote = 'host 시각 확인 실패 — masakari 판정이 부정확할 수 있습니다'
    } else if (calibs.length) {
      const maxAbs = Math.max(0, ...calibs.map((cb) => Math.abs(cb.delta)))
      if (maxAbs > 60_000) tzNote = `host 로그 시각이 PC와 약 ${(maxAbs / 3_600_000).toFixed(1)}시간 차이 — 자동 보정 적용됨`
    }

    // 언마운트됐거나 이 폴링 도중 중지됐으면 낡은 상태로 덮어쓰지 않는다
    if (!mountedRef.current || !runningRef.current) return
    setState({
      hosts,
      vipNode,
      masakari,
      ceph,
      pods,
      podScope: c.podScope,
      serviceUnits: c.showServices ? svcUnits : [],
      services: svcResults,
      openstack: osResults,
      osScope: c.osScope,
      tzNote,
      lastAt: Date.now(),
    })
  }

  const loop = async () => {
    if (!runningRef.current) return
    try {
      await pollOnce()
    } catch {
      /* 폴링 오류는 무시하고 다음 주기 재시도 */
    }
    if (runningRef.current) timerRef.current = setTimeout(loop, cfgRef.current.intervalSec * 1000)
  }

  const start = () => {
    if (!cfg.hosts.filter(Boolean).length) return
    t0Ref.current = Date.now()
    msRef.current = {}
    hostnamesRef.current = {}
    calibRef.current = {}
    setState(null)
    runningRef.current = true
    setRunning(true)
    setView('board')
    loop()
  }
  const stop = () => {
    runningRef.current = false
    setRunning(false)
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = null
  }
  useEffect(() => {
    // StrictMode 이중 마운트 시 cleanup 이 mountedRef 를 false 로 만들므로, 마운트마다 true 로 되돌린다.
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      runningRef.current = false
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  // 경과시간 표시용 1초 틱
  const [, forceTick] = useState(0)
  useEffect(() => {
    if (!running) return
    const t = setInterval(() => forceTick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [running])

  // 종합 판정
  const verdict = useMemo(() => {
    if (!state) return { label: '대기', cls: 'bg-white/10 text-gray-300' }
    // 미설정(지정 안 한) 섹션은 판정을 막지 않는다(= skip). 설정된 항목만 조건에 반영.
    const masaOk = state.masakari.length === 0 || state.masakari.some((m) => m.state === 'finished')
    const cephOk = state.ceph === null || (state.ceph.health === 'OK' && state.ceph.degraded + state.ceph.misplaced === 0)
    const podOk = state.pods.every((p) => p.abnormalCount === 0)
    const downCount = state.hosts.filter((h) => !h.up).length
    if (masaOk && cephOk && podOk && downCount === 0)
      return { label: '정상 (다음 노드 가능)', cls: 'bg-emerald-500/20 text-emerald-300' }
    return { label: '복구 진행 중', cls: 'bg-amber-500/20 text-amber-300' }
  }, [state])

  const canStart = cfg.hosts.filter(Boolean).length > 0
  // 우측 패널(서비스 데몬/OpenStack)이 켜져 있으면 보드를 가로로 넓힌다
  const wideBoard =
    view === 'board' &&
    ((cfg.showServices && cleanUnits(cfg.services).length > 0) || (cfg.showOpenstack && !!cfg.osSession))

  // 최소화: 컴포넌트는 계속 마운트되어 폴링이 유지되고, 우하단 작은 칩만 표시 → 뒤 세션 확인 가능
  if (minimized) {
    return (
      <div
        onMouseDown={onChipDown}
        style={chipPos ? { left: chipPos.x, top: chipPos.y } : { left: 16, bottom: 16 }}
        className="fixed z-50 flex cursor-move select-none items-center gap-2 rounded-lg border border-white/10 bg-panel px-3 py-2 shadow-2xl"
      >
        <HeartPulse size={15} className="text-blue-400" />
        <span className="text-xs font-medium text-gray-100">가용성 상태보드</span>
        {state && <span className={'rounded px-1.5 py-0.5 text-[10px] font-medium ' + verdict.cls}>{verdict.label}</span>}
        {running && (
          <span className="flex items-center gap-1 text-[11px] text-gray-400">
            <RefreshCw size={10} className="animate-spin" /> 경과 {fmtElapsed(Date.now() - t0Ref.current)}
          </span>
        )}
        <button
          onClick={() => setMinimized(false)}
          title="펼치기"
          className="rounded p-1 text-gray-400 hover:bg-white/10 hover:text-gray-200"
        >
          <Maximize2 size={14} />
        </button>
        <button onClick={onClose} title="닫기" className="rounded p-1 text-gray-400 hover:bg-white/10 hover:text-gray-200">
          <X size={14} />
        </button>
      </div>
    )
  }

  return (
    // 배경 클릭으로 닫히지 않게 한다(검증 중 실수 방지). 닫기는 X, 잠깐 비켜두려면 최소화 사용.
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-8">
      <div
        className={
          'flex h-[88vh] max-w-[97vw] flex-col overflow-hidden rounded-lg border border-white/10 bg-panel shadow-2xl ' +
          (wideBoard ? 'w-[1560px]' : 'w-[1120px]')
        }
        onClick={(e) => e.stopPropagation()}
      >
        {/* 헤더 */}
        <div className="flex items-center gap-2 border-b border-white/10 px-4 py-2.5">
          <HeartPulse size={16} className="text-blue-400" />
          <span className="text-sm font-semibold text-gray-100">가용성 검증 상태보드</span>
          {view === 'board' && (
            <span className={'ml-1 rounded px-2 py-0.5 text-[11px] font-medium ' + verdict.cls}>{verdict.label}</span>
          )}
          {view === 'board' && running && (
            <span className="flex items-center gap-1 text-[11px] text-gray-400">
              <RefreshCw size={11} className="animate-spin" /> {cfg.intervalSec}초 갱신
            </span>
          )}
          {view === 'board' && (
            <span className="ml-2 flex items-center gap-1 text-[12px] text-gray-300">
              검증 시작 후 <span className="font-semibold text-gray-100">{fmtElapsed(Date.now() - t0Ref.current)}</span> 경과
            </span>
          )}
          <div className="ml-auto flex items-center gap-1.5">
            {view === 'board' && (
              <>
                <button
                  onClick={() => (running ? stop() : start())}
                  className="flex items-center gap-1 rounded-md border border-white/10 bg-panel-light px-2 py-1 text-xs text-gray-200 hover:bg-white/10"
                >
                  {running ? <Square size={12} /> : <Play size={12} />} {running ? '중지' : '재시작'}
                </button>
                <button
                  onClick={() => {
                    stop()
                    setView('config')
                  }}
                  className="flex items-center gap-1 rounded-md border border-white/10 bg-panel-light px-2 py-1 text-xs text-gray-200 hover:bg-white/10"
                >
                  <Settings2 size={12} /> 역할 매핑
                </button>
              </>
            )}
            <button
              onClick={minimize}
              title="최소화 (검증은 계속 진행 · 툴바 버튼 위에 표시)"
              className="rounded p-1 text-gray-400 hover:bg-white/10 hover:text-gray-200"
            >
              <Minus size={16} />
            </button>
            <button onClick={onClose} title="닫기 (검증 종료)" className="rounded p-1 text-gray-400 hover:bg-white/10 hover:text-gray-200">
              <X size={16} />
            </button>
          </div>
        </div>

        {view === 'config' ? (
          <>
            {/* 저장된 매핑이 아직 열리지 않은 서버를 가리키면, 조용히 비워두지 말고 알려준다.
                (예전엔 빈 값으로 만들어 사용자가 매핑이 사라진 걸 모른 채 검증을 시작했다) */}
            {[...cfg.hosts, ...cfg.masakari, cfg.ceph, cfg.pod, cfg.osSession].some(unresolved) && (
              <div className="mx-4 mt-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[12px] leading-relaxed text-amber-200">
                저장된 역할 매핑 중 <strong>아직 접속하지 않은 서버</strong>가 있어 일부 칸이 비어 보입니다. 해당 세션을
                먼저 연결하면 자동으로 다시 채워집니다.
              </div>
            )}
            <ConfigView
              cfg={cfg}
              connected={connected}
              onChange={saveCfg}
              canStart={canStart}
              onStart={start}
            />
          </>
        ) : (
          <BoardView state={state} milestones={msRef.current} onRemoveNamespace={removeNamespaceLive} />
        )}
      </div>
    </div>
  )
}

// 역할 매핑 드롭다운 — 모듈 레벨 컴포넌트로 두어 부모 리렌더 시에도 remount 되지 않게 한다
// (ConfigView 내부에 정의하면 매 렌더마다 새 컴포넌트가 되어 열린 native select 가 바로 닫힌다)
function RoleSelect({
  value,
  onPick,
  options,
  placeholder = '세션 선택',
}: {
  value: string
  onPick: (v: string) => void
  options: BoardSession[]
  placeholder?: string
}) {
  return (
    <select
      value={value}
      onChange={(e) => onPick(e.target.value)}
      className="w-full rounded border border-white/10 bg-panel-light px-2 py-1 text-[12px] text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
    >
      <option value="">{placeholder}</option>
      {options.map((s) => (
        <option key={s.id} value={s.id}>
          {s.name}
        </option>
      ))}
    </select>
  )
}

// ── 역할 매핑 화면 ─────────────────────────────────────────────
function ConfigView({
  cfg,
  connected,
  onChange,
  canStart,
  onStart,
}: {
  cfg: BoardConfig
  connected: BoardSession[]
  onChange: (c: BoardConfig) => void
  canStart: boolean
  onStart: () => void
}) {
  const setHost = (i: number, v: string) => {
    const hosts = [...cfg.hosts]
    hosts[i] = v
    onChange({ ...cfg, hosts })
  }
  const addHost = () => onChange({ ...cfg, hosts: [...cfg.hosts, ''] })
  const removeHost = (i: number) => onChange({ ...cfg, hosts: cfg.hosts.filter((_, idx) => idx !== i) })
  const setMasa = (i: number, v: string) => {
    const masakari = [...cfg.masakari]
    masakari[i] = v
    onChange({ ...cfg, masakari })
  }
  const removeNs = (ns: string) => onChange({ ...cfg, namespaces: cfg.namespaces.filter((n) => n !== ns) })
  const addNsValue = (ns: string) => {
    if (ns && !cfg.namespaces.includes(ns)) onChange({ ...cfg, namespaces: [...cfg.namespaces, ns] })
  }

  // 파드 조회 세션이 정해지면 그 세션의 네임스페이스 목록을 kubectl 로 불러와 드롭다운으로 제공
  const [nsOptions, setNsOptions] = useState<string[]>([])
  const [nsLoading, setNsLoading] = useState(false)
  const [nsErr, setNsErr] = useState('')
  useEffect(() => {
    if (!cfg.pod) {
      setNsOptions([])
      setNsErr('')
      return
    }
    let cancelled = false
    setNsLoading(true)
    setNsErr('')
    window.electronAPI
      .k8sListNamespaces(cfg.pod)
      .then((r) => {
        if (cancelled) return
        if (r.ok && r.namespaces) setNsOptions(r.namespaces)
        else {
          setNsOptions([])
          setNsErr(r.error || '네임스페이스 조회 실패')
        }
      })
      .catch(() => {
        if (!cancelled) {
          setNsOptions([])
          setNsErr('네임스페이스 조회 실패')
        }
      })
      .finally(() => {
        if (!cancelled) setNsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [cfg.pod])
  const addAllNs = () => {
    const namespaces = [...cfg.namespaces]
    for (const ns of nsOptions) if (!namespaces.includes(ns)) namespaces.push(ns)
    onChange({ ...cfg, namespaces })
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4">
      <p className="mb-3 text-[12px] text-gray-400">
        각 검증 항목을 어느 세션에서 조회할지 지정합니다. 연결된 세션만 선택할 수 있습니다.
        {connected.length === 0 && <span className="ml-1 text-amber-300">— 현재 연결된 세션이 없습니다.</span>}
      </p>

      <Section
        n={1}
        title="Host 노드 — 전원 상태 · VIP 위치"
        desc="각 노드에 SSH 세션을 지정합니다. 노드를 추가하면 서비스 데몬 매트릭스 열도 함께 늘어납니다(컴퓨트 노드 등). 전원(UP/DOWN)은 세션 연결 상태, VIP는 연결된 노드의 pcs status 로 판정."
      >
        <div className="grid gap-2.5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))' }}>
          {cfg.hosts.map((h, i) => (
            <div key={i} className="text-[11px] text-gray-400">
              <div className="mb-1 flex items-center justify-between">
                <span>노드 {i + 1}</span>
                <button
                  onClick={() => removeHost(i)}
                  title="이 노드 슬롯 제거"
                  className="rounded p-0.5 text-gray-500 hover:bg-white/10 hover:text-red-300"
                >
                  <X size={12} />
                </button>
              </div>
              <RoleSelect value={h ?? ''} onPick={(v) => setHost(i, v)} options={connected} />
            </div>
          ))}
          <button
            onClick={addHost}
            className="flex min-h-[52px] flex-col items-center justify-center gap-0.5 self-end rounded border border-dashed border-white/15 py-1 text-[11px] text-gray-400 hover:bg-white/5 hover:text-gray-200"
          >
            <Plus size={14} /> 노드 추가
          </button>
        </div>
      </Section>

      <Section n={2} title="Masakari — 정상 2대 로그" desc="두 세션 중 한쪽만 finished 여도 완료로 종합 판정합니다.">
        <div className="mb-2 grid grid-cols-2 gap-2.5">
          {[0, 1].map((i) => (
            <label key={i} className="text-[11px] text-gray-400">
              엔진 세션 {i === 0 ? 'A' : 'B'}
              <div className="mt-1">
                <RoleSelect value={cfg.masakari[i] ?? ''} onPick={(v) => setMasa(i, v)} options={connected} />
              </div>
            </label>
          ))}
        </div>
        <label className="text-[11px] text-gray-400">
          로그 경로
          <input
            value={cfg.logPath}
            onChange={(e) => onChange({ ...cfg, logPath: e.target.value })}
            className="mt-1 w-full rounded border border-white/10 bg-panel-light px-2 py-1 font-mono text-[12px] text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </label>
      </Section>

      <div className="grid grid-cols-2 gap-2.5">
        <Section n={3} title="Ceph 상태" desc="HEALTH_OK + PG 복구율 + 예상 복구시간(ETA)">
          <label className="text-[11px] text-gray-400">
            조회 세션
            <div className="mt-1">
              <RoleSelect value={cfg.ceph} onPick={(v) => onChange({ ...cfg, ceph: v })} options={connected} />
            </div>
          </label>
        </Section>
        <Section n={4} title="파드 상태 (kubectl)" desc="Running 아닌 파드만 · 배치 NODE 표시 · 네임스페이스 여러 개 가능">
          <label className="text-[11px] text-gray-400">
            조회 세션
            <div className="mt-1">
              <RoleSelect value={cfg.pod} onPick={(v) => onChange({ ...cfg, pod: v })} options={connected} />
            </div>
          </label>
          <div className="mt-2 flex items-center justify-between">
            <span className="text-[11px] text-gray-400">네임스페이스</span>
            <span className="text-[10px] text-gray-500">파드 상태를 확인할 네임스페이스를 아래에서 선택하면 등록됩니다.</span>
          </div>
          {/* 등록된 네임스페이스 칩 (선택으로만 추가/제거) */}
          {cfg.namespaces.length > 0 && (
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              {cfg.namespaces.map((ns) => (
                <span key={ns} className="inline-flex items-center gap-1 rounded-full bg-blue-500/15 px-2 py-0.5 text-[11px] text-blue-200">
                  {ns}
                  <button onClick={() => removeNs(ns)} title="제거" className="text-blue-300/70 hover:text-blue-100">
                    <X size={11} />
                  </button>
                </span>
              ))}
            </div>
          )}
          {/* 세션의 네임스페이스 목록에서 골라 추가 (실시간 로그의 k8s 드롭다운과 동일 방식) */}
          <div className="mt-1.5 flex items-center gap-2">
            <select
              value=""
              onChange={(e) => addNsValue(e.target.value)}
              disabled={!cfg.pod || nsLoading || nsOptions.length === 0}
              className="w-52 rounded border border-white/10 bg-panel-light px-2 py-1 text-[11px] text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50"
            >
              <option value="">
                {!cfg.pod
                  ? '조회 세션을 먼저 선택'
                  : nsLoading
                    ? '네임스페이스 불러오는 중…'
                    : nsOptions.length === 0
                      ? '세션 네임스페이스 없음'
                      : '네임스페이스 선택 → 등록'}
              </option>
              {nsOptions
                .filter((ns) => !cfg.namespaces.includes(ns))
                .map((ns) => (
                  <option key={ns} value={ns}>
                    {ns}
                  </option>
                ))}
            </select>
            <button
              onClick={addAllNs}
              disabled={!cfg.pod || nsLoading || nsOptions.length === 0 || nsOptions.every((ns) => cfg.namespaces.includes(ns))}
              className="rounded border border-white/10 bg-panel-light px-2 py-1 text-[11px] text-gray-200 hover:bg-white/10 disabled:opacity-40"
            >
              전체 추가 ({nsOptions.length})
            </button>
            {cfg.namespaces.length > 0 && (
              <button
                onClick={() => onChange({ ...cfg, namespaces: [] })}
                className="rounded border border-white/10 bg-panel-light px-2 py-1 text-[11px] text-gray-400 hover:bg-white/10"
              >
                전체 해제
              </button>
            )}
            {nsErr && <span className="text-[10px] text-amber-300">{nsErr}</span>}
          </div>
          {/* 표시 범위: 비정상만 / 전체 파드 */}
          <div className="mt-2.5 flex items-center gap-2">
            <span className="text-[11px] text-gray-400">표시 범위</span>
            <div className="flex overflow-hidden rounded border border-white/10">
              {(['abnormal', 'all'] as const).map((sc) => (
                <button
                  key={sc}
                  onClick={() => onChange({ ...cfg, podScope: sc })}
                  className={
                    'px-2.5 py-1 text-[11px] ' +
                    (cfg.podScope === sc ? 'bg-blue-600/30 text-blue-100' : 'text-gray-400 hover:bg-white/5')
                  }
                >
                  {sc === 'abnormal' ? '비정상만' : '전체 파드'}
                </button>
              ))}
            </div>
            <span className="text-[10px] text-gray-500">
              {cfg.podScope === 'abnormal'
                ? 'Running·Ready 아닌 파드만 표시'
                : '모든 파드 표시 (Running 은 초록, READY 미충족은 비정상)'}
            </span>
          </div>
        </Section>
      </div>

      <Section
        n={5}
        title="노드별 서비스 데몬 상태"
        desc="Host 세션에서 systemctl is-active 로 각 데몬의 실행 상태를 조회해 보드 우측 패널에 표시합니다."
      >
        <label className="flex items-center gap-2 text-[12px] text-gray-200">
          <input
            type="checkbox"
            checked={cfg.showServices}
            onChange={(e) => onChange({ ...cfg, showServices: e.target.checked })}
            className="h-3.5 w-3.5 accent-blue-500"
          />
          상태보드 우측에 서비스 패널 표시
        </label>
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <span className="text-[11px] text-gray-400">프리셋 추가</span>
          <button
            onClick={() => onChange({ ...cfg, services: Array.from(new Set([...cleanUnits(cfg.services), ...SVC_PRESETS.controller])) })}
            className="rounded border border-white/10 bg-panel-light px-2 py-1 text-[11px] text-gray-200 hover:bg-white/10"
          >
            + 컨트롤러 ({SVC_PRESETS.controller.length})
          </button>
          <button
            onClick={() => onChange({ ...cfg, services: Array.from(new Set([...cleanUnits(cfg.services), ...SVC_PRESETS.compute])) })}
            className="rounded border border-white/10 bg-panel-light px-2 py-1 text-[11px] text-gray-200 hover:bg-white/10"
          >
            + 컴퓨트 ({SVC_PRESETS.compute.length})
          </button>
          {cleanUnits(cfg.services).length > 0 && (
            <button
              onClick={() => onChange({ ...cfg, services: [] })}
              className="rounded border border-white/10 bg-panel-light px-2 py-1 text-[11px] text-gray-400 hover:bg-white/10"
            >
              비우기
            </button>
          )}
          <span className="text-[10px] text-gray-500">현재 {cleanUnits(cfg.services).length}개 유닛</span>
        </div>
        <textarea
          value={cfg.services.join('\n')}
          onChange={(e) => onChange({ ...cfg, services: e.target.value.split('\n') })}
          rows={6}
          spellCheck={false}
          placeholder="한 줄에 유닛 하나 (예: nova-api · .service 생략 가능)"
          className="mt-2 w-full resize-y rounded border border-white/10 bg-panel-light px-2 py-1.5 font-mono text-[11px] leading-relaxed text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
        <p className="mt-1 text-[10px] text-gray-500">
          모든 Host 노드에 같은 목록을 조회합니다. 해당 노드에 설치되지 않은 유닛은 '없음'(회색)으로, 로드됐지만 멈춘 유닛만 '중지'(빨강)로 표시됩니다.
        </p>
      </Section>

      <Section
        n={6}
        title="OpenStack 서비스 (API)"
        desc="nova/neutron/cinder 처럼 systemctl 로 안 잡히는 서비스를 openstack CLI 로 호스트별 up/down 조회합니다. (노드 다운 시 nova-compute down 확인에 유용)"
      >
        <label className="flex items-center gap-2 text-[12px] text-gray-200">
          <input
            type="checkbox"
            checked={cfg.showOpenstack}
            onChange={(e) => onChange({ ...cfg, showOpenstack: e.target.checked })}
            className="h-3.5 w-3.5 accent-blue-500"
          />
          OpenStack 서비스(API) 섹션 표시
        </label>
        <div className="mt-2.5 grid grid-cols-2 gap-2.5">
          <label className="text-[11px] text-gray-400">
            조회 세션 (admin 크리덴셜 보유 컨트롤러)
            <div className="mt-1">
              <RoleSelect value={cfg.osSession} onPick={(v) => onChange({ ...cfg, osSession: v })} options={connected} />
            </div>
          </label>
          <label className="text-[11px] text-gray-400">
            admin_openrc 경로
            <input
              value={cfg.osRc}
              onChange={(e) => onChange({ ...cfg, osRc: e.target.value })}
              placeholder="~/contrabass-openrc"
              className="mt-1 w-full rounded border border-white/10 bg-panel-light px-2 py-1 font-mono text-[12px] text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </label>
        </div>
        <div className="mt-2.5 flex items-center gap-2">
          <span className="text-[11px] text-gray-400">표시 범위</span>
          <div className="flex overflow-hidden rounded border border-white/10">
            {(['abnormal', 'all'] as const).map((sc) => (
              <button
                key={sc}
                onClick={() => onChange({ ...cfg, osScope: sc })}
                className={
                  'px-2.5 py-1 text-[11px] ' +
                  (cfg.osScope === sc ? 'bg-blue-600/30 text-blue-100' : 'text-gray-400 hover:bg-white/5')
                }
              >
                {sc === 'abnormal' ? '비정상만' : '전체'}
              </button>
            ))}
          </div>
          <span className="text-[10px] text-gray-500">
            {cfg.osScope === 'abnormal' ? 'down·disabled 인 서비스만 표시' : '모든 서비스 표시'}
          </span>
        </div>
        <p className="mt-1.5 text-[10px] text-gray-500">
          지정 세션에서 <code className="text-gray-400">. {cfg.osRc || '~/contrabass-openrc'}; openstack ... service list</code> 를 실행합니다. 조회 실패 시 rc 경로·권한을 확인하세요.
        </p>
      </Section>

      <div className="mt-4 flex items-center gap-3 border-t border-white/10 pt-3">
        <label className="flex items-center gap-2 text-[11px] text-gray-400">
          <RefreshCw size={13} /> 폴링 주기
          <select
            value={cfg.intervalSec}
            onChange={(e) => onChange({ ...cfg, intervalSec: Number(e.target.value) })}
            className="rounded border border-white/10 bg-panel-light px-2 py-1 text-[12px] text-gray-100"
          >
            <option value={1}>1초</option>
            <option value={2}>2초</option>
            <option value={3}>3초</option>
            <option value={5}>5초</option>
            <option value={10}>10초</option>
            <option value={30}>30초</option>
          </select>
        </label>
        <span className="text-[10px] text-gray-500">1~3초는 서버 부하가 커질 수 있어요(이전 폴링이 끝난 뒤 다음 실행).</span>
        <button
          onClick={onStart}
          disabled={!canStart}
          className="ml-auto flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-40"
        >
          <Play size={13} /> 검증 시작
        </button>
      </div>
    </div>
  )
}

function Section({ n, title, desc, children }: { n: number; title: string; desc: string; children: React.ReactNode }) {
  return (
    <div className="mb-3 rounded-lg border border-white/10 bg-panel-light/40 p-3">
      <div className="flex items-center gap-1.5 text-[13px] font-medium text-gray-100">
        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-blue-600/40 text-[11px] text-blue-100">
          {n}
        </span>
        {title}
      </div>
      <p className="mb-2.5 mt-1 text-[11px] text-gray-500">{desc}</p>
      {children}
    </div>
  )
}

// ── 실시간 보드 화면 ───────────────────────────────────────────
function BoardView({
  state,
  milestones,
  onRemoveNamespace,
}: {
  state: BoardState | null
  milestones: { vip?: number; masakari?: number; ceph?: number }
  onRemoveNamespace: (ns: string) => void
}) {
  if (!state) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-gray-400">
        <Loader2 size={16} className="mr-2 animate-spin" /> 첫 폴링 대기 중…
      </div>
    )
  }
  const ceph = state.ceph
  const hasServices = state.serviceUnits.length > 0 && state.services.length > 0
  const hasOpenstack = state.openstack != null
  return (
    <div className="flex min-h-0 flex-1">
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
      {/* 1. Host */}
      <SectionLabel n={1} text="Host — 전원 상태 · VIP 위치" />
      <div className="mb-4 grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))' }}>
        {state.hosts.map((h) => (
          <div
            key={h.id}
            className={
              'flex items-center justify-between gap-2 rounded-xl border p-3 ' +
              (h.up ? 'border-white/10 bg-panel-light' : 'border-red-500/40 bg-panel-light')
            }
          >
            {/* 좌: 호스트명 + VIP 정보(세로 스택) / 우: UP·DOWN 상태(상하 가운데) */}
            <div className="min-w-0">
              <div className="truncate text-[14px] font-medium text-gray-100">{h.name}</div>
              <div className="mt-1 text-[12px]">
                {h.vip ? (
                  <span className="inline-flex items-center gap-1 rounded bg-blue-500/20 px-2 py-0.5 font-medium text-blue-200">
                    <MapPin size={12} /> VIP 여기
                  </span>
                ) : h.up ? (
                  <span className="text-gray-500">VIP 없음</span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-red-300">
                    <Bolt size={12} /> 무응답
                  </span>
                )}
              </div>
            </div>
            {h.up ? (
              <span className="shrink-0 rounded-full bg-emerald-500/20 px-3 py-1 text-[14px] font-semibold text-emerald-300">UP</span>
            ) : (
              <span className="shrink-0 rounded-full bg-red-500/25 px-3 py-1 text-[14px] font-semibold text-red-300">DOWN</span>
            )}
          </div>
        ))}
        {state.hosts.length === 0 && <div className="col-span-3 text-[12px] text-gray-500">host 세션이 지정되지 않았습니다.</div>}
      </div>

      {/* 2. Masakari */}
      <SectionLabel n={2} text="Masakari evacuation (한쪽만 finished 여도 완료)" />
      {state.tzNote && (
        <div className="mb-1.5 flex items-center gap-1.5 rounded-md bg-amber-500/10 px-2.5 py-1 text-[11px] text-amber-300">
          <AlertTriangle size={12} /> {state.tzNote}
        </div>
      )}
      <div className="mb-4 grid grid-cols-2 gap-3">
        {state.masakari.map((m) => (
          <div key={m.id} className="flex items-center gap-3 rounded-xl border border-white/10 bg-panel-light p-3">
            {m.state === 'finished' ? (
              <CircleCheck size={24} className="shrink-0 text-emerald-400" />
            ) : m.state === 'progress' ? (
              <Loader2 size={22} className="shrink-0 animate-spin text-amber-400" />
            ) : (
              <AlertTriangle size={22} className="shrink-0 text-gray-500" />
            )}
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 text-[13px] font-medium text-gray-100">
                {m.name}{' '}
                <span className={m.state === 'finished' ? 'text-emerald-300' : m.state === 'progress' ? 'text-amber-300' : 'text-gray-400'}>
                  {m.state === 'finished' ? 'finished' : m.state === 'progress' ? '진행 중' : '미상'}
                </span>
                {m.evac > 0 && (
                  <span className="ml-auto shrink-0 rounded-full bg-blue-500/20 px-2 py-0.5 text-[11px] font-medium text-blue-200">
                    evac {m.evac}대
                  </span>
                )}
              </div>
              <div className="truncate text-[11px] text-gray-500">{m.detail}</div>
            </div>
          </div>
        ))}
        {state.masakari.length === 0 && <div className="col-span-2 text-[12px] text-gray-500">masakari 세션이 지정되지 않았습니다.</div>}
      </div>

      {/* 3. Ceph (단독 행) */}
      <SectionLabel n={3} text="Ceph 상태" />
      <div className="mb-4 rounded-xl border border-white/10 bg-panel-light p-3.5">
        {ceph ? (
          <>
            <div className="flex items-center justify-between">
              <span
                className={
                  'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[12px] font-medium ' +
                  (ceph.health === 'OK'
                    ? 'bg-emerald-500/20 text-emerald-300'
                    : ceph.health === 'unknown'
                      ? 'bg-white/10 text-gray-400'
                      : 'bg-amber-500/20 text-amber-300')
                }
              >
                {ceph.health === 'OK' ? <CircleCheck size={13} /> : <AlertTriangle size={13} />}
                HEALTH_{ceph.health === 'unknown' ? '?' : ceph.health}
              </span>
              {ceph.etaSec != null && (
                <span className="inline-flex items-center gap-1 text-[12px] font-medium text-gray-100">
                  <Hourglass size={13} className="text-gray-400" /> ETA {fmtEta(ceph.etaSec)}
                </span>
              )}
            </div>
            {/* degraded(복제 부족)와 misplaced(재배치 중)는 의미가 다른 별개 수치 → 라벨을 붙여 분리 표시 */}
            <div className="mt-3 grid grid-cols-2 gap-2">
              <div className="rounded-md bg-black/20 px-2.5 py-1.5">
                <div className="text-[10px] text-gray-500">degraded · 복제 부족</div>
                <div className={'text-[15px] font-semibold ' + (ceph.degraded > 0 ? 'text-red-300' : 'text-emerald-300')}>
                  {ceph.degraded.toLocaleString()}
                </div>
              </div>
              <div className="rounded-md bg-black/20 px-2.5 py-1.5">
                <div className="text-[10px] text-gray-500">misplaced · 재배치 중</div>
                <div className={'text-[15px] font-semibold ' + (ceph.misplaced > 0 ? 'text-amber-300' : 'text-emerald-300')}>
                  {ceph.misplaced.toLocaleString()}
                </div>
              </div>
            </div>
            {(() => {
              // 복구 진행률(대략): 남은 객체(degraded+misplaced, 중복 가능성 있어 total 로 클램프) 대비
              const remain = ceph.degraded + ceph.misplaced
              const pct =
                ceph.total > 0
                  ? Math.min(100, Math.max(0, Math.round(((ceph.total - remain) / ceph.total) * 100)))
                  : ceph.health === 'OK'
                    ? 100
                    : 0
              return (
                <>
                  <div className="mt-2.5 flex justify-between text-[11px] text-gray-500">
                    <span>복구 진행률</span>
                    <span className="text-gray-300">{pct}%</span>
                  </div>
                  <div className="mt-1 h-2 overflow-hidden rounded-full bg-black/30">
                    <div
                      className={'h-full ' + (ceph.health === 'OK' ? 'bg-emerald-500' : 'bg-amber-500')}
                      style={{ width: `${Math.max(3, pct)}%` }}
                    />
                  </div>
                </>
              )
            })()}
            {/* HEALTH_WARN/ERR 사유 — degraded/misplaced 외의 다른 이슈(osd down, clock skew, pool full 등)도 그대로 표시 */}
            {ceph.health !== 'OK' && ceph.health !== 'unknown' && ceph.reasons.length > 0 && (
              <div className="mt-2.5 rounded-md border border-white/5 bg-black/20 p-2">
                <div className="mb-1 flex items-center gap-1 text-[10px] text-gray-500">
                  <AlertTriangle size={11} className={ceph.health === 'ERR' ? 'text-red-400' : 'text-amber-400'} />
                  경고 사유 ({ceph.reasons.length})
                </div>
                <div className="flex max-h-[110px] flex-col gap-0.5 overflow-y-auto pr-1">
                  {ceph.reasons.map((r, i) => (
                    <div key={i} className={'text-[11px] leading-snug ' + (ceph.health === 'ERR' ? 'text-red-200/90' : 'text-amber-200/90')}>
                      · {r}
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div className="mt-2 flex justify-between text-[11px] text-gray-500">
              <span>{ceph.rate > 0 ? `복구 속도 ${Math.round(ceph.rate)} obj/s` : '복구 IO 없음'}</span>
              <span>{ceph.note}</span>
            </div>
          </>
        ) : (
          <div className="text-[12px] text-gray-500">Ceph 세션이 지정되지 않았습니다.</div>
        )}
      </div>

      {/* 4. 파드 — 네임스페이스별 카드 (Running 이 아닌 것만 · 배치 NODE) */}
      <SectionLabel n={4} text="네임스페이스별 파드 조회" />
      {state.pods.length === 0 ? (
        <div className="mb-4 rounded-xl border border-white/10 bg-panel-light p-3.5 text-[12px] text-gray-500">
          파드 세션/네임스페이스가 지정되지 않았습니다.
        </div>
      ) : (
        <div className="mb-4 grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(430px, 1fr))' }}>
          {state.pods.map((p) => (
            <PodNsCard key={p.namespace} p={p} scope={state.podScope} onRemove={() => onRemoveNamespace(p.namespace)} />
          ))}
        </div>
      )}

      {/* 복구 타임라인 */}
      <div className="mb-1 flex items-center gap-1.5 text-[13px] text-gray-300">
        <Activity size={15} /> 복구 타임라인 (검증 시작 기준)
      </div>
      <div className="rounded-xl bg-panel-light/50 p-3.5 text-[12px]">
        <TimelineRow t="00:00" icon={<Bolt size={13} className="text-red-400" />} text="검증 시작" />
        {milestones.vip != null && (
          <TimelineRow
            t={fmtElapsed(milestones.vip)}
            icon={<MapPin size={13} className="text-blue-400" />}
            text={`VIP 위치 확인${state.vipNode ? ` → ${state.vipNode}` : ''}`}
          />
        )}
        {milestones.masakari != null && (
          <TimelineRow t={fmtElapsed(milestones.masakari)} icon={<CircleCheck size={13} className="text-emerald-400" />} text="Masakari evacuation 완료" />
        )}
        {milestones.ceph != null && (
          <TimelineRow t={fmtElapsed(milestones.ceph)} icon={<CircleCheck size={13} className="text-emerald-400" />} text="Ceph HEALTH_OK · 리밸런스 완료" />
        )}
        <div className="mt-1 text-[11px] text-gray-500">마지막 갱신 {new Date(state.lastAt).toLocaleTimeString('ko-KR', { hour12: false })}</div>
      </div>
      </div>
      {(hasServices || hasOpenstack) && (
        <>
          <div className="w-px shrink-0 bg-white/10" />
          <div className="min-h-0 w-[520px] shrink-0 space-y-4 overflow-y-auto p-4">
            {hasServices && <ServicePanel units={state.serviceUnits} nodes={state.services} />}
            {hasOpenstack && state.openstack && <OpenstackPanel os={state.openstack} scope={state.osScope} />}
          </div>
        </>
      )}
    </div>
  )
}

// 네임스페이스 라벨용 은은한 틴트 — 모든 네임스페이스 동일 색으로 통일
const NS_TINT = 'bg-blue-500/15 text-blue-200/90'

// 비정상 파드 STATUS 를 심각도별 색으로 — 심각(빨강): Crash/Error/ImagePull/OOM/Evict/Fail 등, 그 외(노랑): Pending/Creating/Terminating/Init 등
function podStatusCls(status: string): string {
  const s = status.toLowerCase()
  if (/crash|backoff|error|err|oomkill|evict|fail|invalid|unknown/.test(s)) return 'bg-red-500/20 text-red-300'
  return 'bg-amber-500/20 text-amber-200'
}

// 네임스페이스 1개의 파드 상태 카드.
//  scope='abnormal': 비정상만(정상이면 '이상 없음') / 'all': 전체 파드(Running 은 초록)
function PodNsCard({ p, scope, onRemove }: { p: PodStat; scope: 'abnormal' | 'all'; onRemove: () => void }) {
  const cleanEmpty = scope === 'abnormal' && p.abnormalCount === 0
  return (
    <div className="group relative flex flex-col rounded-xl border border-white/10 bg-panel-light p-3.5">
      <button
        onClick={onRemove}
        title="이 네임스페이스를 상태보드에서 제외 (역할 매핑에서 다시 추가 가능)"
        className="absolute right-1.5 top-1.5 rounded p-0.5 text-gray-500 opacity-60 hover:bg-white/10 hover:text-gray-200 hover:opacity-100"
      >
        <X size={13} />
      </button>
      <div className="mb-2 flex flex-wrap items-center gap-2 pr-5">
        <span className={'rounded px-2 py-0.5 font-mono text-[11px] ' + NS_TINT}>{p.namespace}</span>
        {cleanEmpty ? (
          <span className="inline-flex items-center gap-1 text-[12px] text-emerald-300">
            <CircleCheck size={13} /> 이상 없음 · {p.total}개
          </span>
        ) : scope === 'all' ? (
          <span className="text-[12px] text-gray-400">
            전체 {p.total}개
            {p.abnormalCount > 0 ? (
              <span className="text-amber-300"> · 비정상 {p.abnormalCount}</span>
            ) : (
              <span className="text-emerald-300"> · 이상 없음</span>
            )}
          </span>
        ) : (
          <span className="text-[12px]">
            <span className="font-semibold text-amber-300">{p.abnormalCount}</span>
            <span className="text-gray-400"> 비정상 · 전체 {p.total}개</span>
          </span>
        )}
      </div>
      {p.rows.length > 0 && (
        <div className="flex max-h-[220px] flex-col divide-y divide-white/5 overflow-y-auto pr-1">
          {p.rows.map((pod, i) => (
            // 한 줄 나열: 파드명(길면 말줄임+툴팁) · READY · 상태 · 배치 NODE
            <div key={i} className="flex items-center gap-2 py-1 text-[12px]">
              <span className="min-w-0 flex-1 truncate font-mono text-gray-100" title={pod.name}>
                {pod.name}
              </span>
              <span
                className={'shrink-0 font-mono text-[11px] ' + (pod.healthy ? 'text-gray-400' : 'text-red-300')}
                title="READY (준비된 컨테이너/전체)"
              >
                {pod.ready || '-'}
              </span>
              <span
                className={
                  'shrink-0 rounded-full px-2 py-0.5 text-[11px] ' +
                  (pod.healthy ? 'bg-emerald-500/20 text-emerald-300' : podStatusCls(pod.status))
                }
              >
                {pod.status}
              </span>
              <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-gray-400" title={pod.node}>
                <Server size={12} className="shrink-0" />
                <span className="max-w-[110px] truncate">{pod.node}</span>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// 노드명("별칭 (IP)")에서 컬럼 헤더용 짧은 별칭만 추출
const svcShortName = (n: string) => n.split(' (')[0]
// systemctl 상태 → [셀 스타일, 라벨]
const SVC_CELL: Record<SvcState | 'down', [string, string]> = {
  active: ['bg-emerald-500/15 text-emerald-300', 'active'],
  activating: ['bg-amber-500/15 text-amber-300', 'starting'],
  failed: ['bg-red-500/25 text-red-300', 'failed'],
  inactive: ['bg-red-500/15 text-red-300', '중지'],
  notfound: ['bg-white/5 text-gray-600', '없음'],
  unknown: ['bg-white/5 text-gray-500', '—'],
  down: ['bg-white/5 text-gray-600', '·'],
}
function SvcCell({ state }: { state: SvcState | 'down' }) {
  const [cls, label] = SVC_CELL[state] ?? SVC_CELL.unknown
  return (
    <div className={'truncate rounded px-1 py-1 text-center text-[10.5px] ' + cls} title={label}>
      {label}
    </div>
  )
}

// 노드별 서비스 데몬 상태 매트릭스 (행=유닛, 열=노드). systemctl is-active 결과.
function ServicePanel({ units, nodes }: { units: string[]; nodes: NodeSvc[] }) {
  // 이상 = 로드됐지만 죽은 것(failed) 또는 멈춘 것(inactive). '없음'(미설치)·전환중(activating)·미상은 제외.
  const abnormal = nodes.reduce(
    (acc, n) => acc + (n.up ? units.filter((u) => n.states[svcKey(u)] === 'failed' || n.states[svcKey(u)] === 'inactive').length : 0),
    0,
  )
  return (
    <>
      <div className="mb-1.5 flex items-center gap-1.5 text-[13px] text-gray-300">
        <Server size={15} /> 노드별 서비스 데몬 상태
        {abnormal > 0 && (
          <span className="ml-auto rounded-full bg-red-500/20 px-2 py-0.5 text-[11px] font-medium text-red-300">이상 {abnormal}</span>
        )}
      </div>
      <div className="rounded-xl border border-white/10 bg-panel-light p-2">
        {/* 노드 열은 많아지면 가로 스크롤. 서비스명 열은 sticky 로 왼쪽에 고정해 안 잘리게 한다. */}
        <div className="overflow-x-auto">
          <div
            className="grid items-center gap-1"
            style={{ gridTemplateColumns: `116px repeat(${Math.max(1, nodes.length)}, minmax(64px, 1fr))` }}
          >
            <div className="sticky left-0 z-10 bg-panel-light" />
            {nodes.map((n) => (
              <div
                key={n.id}
                className={'truncate px-1 py-1 text-center text-[11px] font-medium ' + (n.up ? 'text-gray-200' : 'text-red-300')}
                title={n.name}
              >
                {svcShortName(n.name)}
                {!n.up && ' ↓'}
              </div>
            ))}
            {units.map((u) => (
              <Fragment key={u}>
                <div className="sticky left-0 z-10 truncate bg-panel-light py-1 pr-2 font-mono text-[11px] text-gray-400" title={u}>
                  {u}
                </div>
                {nodes.map((n) => (
                  <SvcCell key={n.id} state={n.up ? (n.states[svcKey(u)] ?? 'unknown') : 'down'} />
                ))}
              </Fragment>
            ))}
          </div>
        </div>
      </div>
      <p className="mt-2 text-[10px] leading-relaxed text-gray-500">
        <code className="text-gray-400">systemctl show</code> 결과 · active 만 정상. 노드에 없는 유닛은 '없음', 노드 DOWN 이면 열 전체 '·'.
      </p>
    </>
  )
}

// OpenStack 서비스 매트릭스 셀 — 작동상태(up/down)=색, 이용상태 disabled=주황 테두리+별표. 없으면 '·'.
function OsCell({ s }: { s?: OsSvc }) {
  // 해당 노드에 그 서비스가 없음(정상) — 구멍처럼 안 보이게 은은한 '해당 없음' 타일로 채운다
  if (!s) return <div className="rounded bg-white/[0.03] px-1 py-1 text-center text-[10.5px] text-gray-600/70">·</div>
  const base = s.up ? 'bg-emerald-500/15 text-emerald-300' : 'bg-red-500/25 text-red-300'
  const ring = s.enabled ? '' : ' ring-1 ring-inset ring-amber-400/70'
  return (
    <div
      className={'truncate rounded px-1 py-1 text-center text-[10.5px] ' + base + ring}
      title={(s.up ? 'up' : 'down') + (s.enabled ? '' : ' · disabled(관리중지)')}
    >
      {s.up ? 'up' : 'down'}
      {!s.enabled && <span className="text-amber-300">*</span>}
    </div>
  )
}

// OpenStack 서비스(API) — 위 서비스 데몬 패널과 동일한 매트릭스(행=서비스명, 열=노드).
//  scope='abnormal': 이상(down/disabled) 있는 서비스 행만 / 'all': 전체 행.
function OpenstackPanel({ os, scope }: { os: OsStat; scope: 'abnormal' | 'all' }) {
  const hosts = Array.from(new Set(os.rows.map((s) => s.host))).sort()
  const cell = new Map<string, OsSvc>() // `${binary} ${host}` → 인스턴스
  for (const s of os.rows) cell.set(s.binary + ' ' + s.host, s)
  const at = (b: string, h: string) => cell.get(b + ' ' + h)
  let binaries = Array.from(new Set(os.rows.map((s) => s.binary))).sort()
  if (scope === 'abnormal') {
    binaries = binaries.filter((b) => hosts.some((h) => { const s = at(b, h); return s && (!s.up || !s.enabled) }))
  }
  const empty = os.total === 0 && os.errors.length === 0
  const clean = scope === 'abnormal' && os.abnormalCount === 0

  return (
    <>
      <div className="mb-1.5 flex items-center gap-1.5 text-[13px] text-gray-300">
        <Bolt size={15} /> OpenStack 서비스 (API)
        {os.abnormalCount > 0 && (
          <span className="ml-auto rounded-full bg-red-500/20 px-2 py-0.5 text-[11px] font-medium text-red-300">이상 {os.abnormalCount}</span>
        )}
      </div>
      <div className="rounded-xl border border-white/10 bg-panel-light p-2">
        {os.errors.length > 0 && (
          <div className="mb-2 flex items-start gap-1.5 rounded-md bg-amber-500/10 px-2.5 py-1 text-[11px] text-amber-300">
            <AlertTriangle size={12} className="mt-0.5 shrink-0" />
            <span>{os.errors.join(' · ')} — rc 경로·권한, openstack CLI 설치를 확인하세요.</span>
          </div>
        )}
        {empty ? (
          <div className="px-1 py-1 text-[12px] text-gray-500">서비스 없음</div>
        ) : clean ? (
          <div className="inline-flex items-center gap-1 px-1 py-1 text-[12px] text-emerald-300">
            <CircleCheck size={13} /> 이상 없음 · 전체 {os.total}개
          </div>
        ) : (
          // 노드 열은 API 호스트 수만큼 늘어남 → 많으면 가로 스크롤
          <div className="max-h-[340px] overflow-auto">
            <div
              className="grid items-center gap-1"
              style={{ gridTemplateColumns: `132px repeat(${Math.max(1, hosts.length)}, minmax(64px, 1fr))` }}
            >
              <div className="sticky left-0 z-10 bg-panel-light" />
              {hosts.map((h) => (
                <div key={h} className="truncate px-1 py-1 text-center text-[11px] font-medium text-gray-200" title={h}>
                  {h}
                </div>
              ))}
              {binaries.map((b) => (
                <Fragment key={b}>
                  <div className="sticky left-0 z-10 truncate bg-panel-light py-1 pr-2 font-mono text-[11px] text-gray-400" title={b}>
                    {b}
                  </div>
                  {hosts.map((h) => (
                    <OsCell key={h} s={at(b, h)} />
                  ))}
                </Fragment>
              ))}
            </div>
          </div>
        )}
        <p className="mt-2 text-[10px] leading-relaxed text-gray-500">
          up(초록)·down(빨강)=작동상태(살아있음) · <span className="text-amber-300">*</span>주황테=관리중지(disabled) · <span className="text-gray-600">·</span>빈칸=해당 노드에 없는 서비스(정상).
        </p>
      </div>
    </>
  )
}

function SectionLabel({ n, text }: { n: number; text: string }) {
  return (
    <div className="mb-1.5 flex items-center gap-1.5 text-[13px] text-gray-300">
      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-blue-600/40 text-[11px] text-blue-100">{n}</span>
      {text}
    </div>
  )
}
function TimelineRow({ t, icon, text }: { t: string; icon: React.ReactNode; text: string }) {
  return (
    <div className="flex items-center gap-2.5 py-1">
      <span className="w-12 text-gray-500 tabular-nums">{t}</span>
      {icon}
      <span className="text-gray-200">{text}</span>
    </div>
  )
}
