import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Activity,
  Globe,
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
  Eye,
  FileText,
  Copy,
  Download,
} from 'lucide-react'
import PortalPanel, { type PortalMilestone } from './PortalPanel'
import { notifyOs } from '../lib/notify'
import {
  parsePcsRoles,
  parseCrmOps,
  parseCtimeLocal,
  parseLogTime,
  podFactsFromJson,
  parseEvacMigrations,
  parseControllers,
  type ControllerStat,
  type PcsResource,
} from '../lib/clusterEvidence'
import { maskForExport } from '../lib/mask'
import { newPodCand, podCandPending, stepPodRecovery, type PodCand } from '../lib/podRecovery'
import { parseDurationInput } from '../lib/durationInput'
import { alignTabBlocks } from '../lib/textAlign'
import type { BoardEvidenceItem } from '../../electron/shared-types'

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
  /**
   * DOWN 된 노드의 22번 포트가 다시 열렸을 때 그 세션을 재연결해 달라는 요청.
   * (IPMI 로 전원을 올리면 부팅에 수 분 걸려 앱의 기본 자동 재연결(약 41초)은 이미 포기한 뒤다)
   */
  onReconnect?: (sessionId: string) => void
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

/** 잡이 '직전 값을 유지만 했다' 고 알리는 표식 — guard 가 갱신 시각을 올리지 않는다 */
const STALE_FRAME = Symbol('stale-frame')

// ── 파싱 결과 타입 ─────────────────────────────────────────────
interface HostStat {
  id: string
  name: string
  up: boolean
  vip: boolean
  /** DOWN 을 처음 인지한 절대시각(epoch ms). UP 이면 undefined */
  downAt?: number
  /**
   * DOWN 판정 근거.
   *  pcs — 살아있는 노드의 pacemaker 가 OFFLINE 으로 보고 (수 초 내, 가장 정확)
   *  ssh — SSH 세션 끊김 (keepalive 특성상 최대 90초 늦음)
   *  pre — 검증을 시작했을 때 이미 죽어 있던 노드 (인지 시각이 존재하지 않음)
   */
  downSource?: 'pcs' | 'ssh' | 'pre'
  /**
   * 재연결 감시 상태 — "지금 되고 있는 게 맞나?" 를 화면에서 바로 알 수 있어야 한다.
   * 조용히 아무것도 안 보여주면 더 기다릴지 손을 댈지 판단할 수가 없다.
   */
  probe?: { tries: number; note: string; ok: boolean }
}
/**
 * idle = evacuation 로그가 아예 없는 상태.
 *
 * 예전에는 이것도 'progress'(진행 중)로 뭉갰다. 아무 일도 안 일어났는데 노란 스피너가 돌고
 * 종합 판정까지 '복구 진행 중'으로 떨어져, 멀쩡한 상태가 장애처럼 읽혔다.
 * '아직 아무 일 없음'과 '지금 처리 중'은 사용자가 할 일이 다르다 — 앞은 그냥 두면 되고 뒤는 기다려야 한다.
 */
type MasakariState = 'finished' | 'progress' | 'idle' | 'unknown'
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
  /**
   * 검증 시작 후 관측된 '남은 객체(degraded+misplaced)'의 최대값 = 복구 진행률의 기준선.
   * 이게 없으면 진행률을 (전체-남은)/전체 로 계산하게 되는데, 그건 '복구 진행률'이 아니라
   * '현재 정상 복제율'이라 복구를 시작하지도 않은 시점에 70%대가 찍힌다.
   */
  peakRemain: number
  etaSec: number | null
  reasons: string[] // HEALTH_WARN/ERR 사유 줄 (osd down, clock skew, pool full 등)
  note: string
  /** 이번 프레임은 응답이 늦어 **직전 값**을 보여 주는 중 — 몇 초 전 값인지. 초록·진행률을 그리지 않는다 */
  staleSec?: number
}
interface PodRow {
  name: string
  ready: string // READY 컬럼 (예: "1/1", "0/1")
  status: string
  node: string
  healthy: boolean // Running + Ready 충족 (또는 Completed) · nodeNotReady 면 무조건 false
  /**
   * 배치된 노드가 Ready 가 아니다 — 이 파드의 'Running' 은 **낡은 값**이다.
   * (노드가 죽어도 API 서버는 한동안 Running 을 계속 답한다) 정상으로 세지 않는다.
   */
  nodeNotReady?: boolean
}
interface PodStat {
  namespace: string
  total: number
  abnormalCount: number // 표시 범위와 무관하게 항상 비정상 개수
  rows: PodRow[] // 표시할 행 (scope 에 따라 비정상만 또는 전체)
  note: string
  /** 출력은 있었는데 파드 줄로 읽힌 것이 없다(kubectl 오류·경고 문구뿐) — 조회 실패로 다룬다 */
  unparsed?: boolean
  /**
   * 조회 자체를 못 했다(세션 끊김·kubectl 타임아웃·권한 오류).
   * '비정상 0개'와 반드시 구분해야 한다 — 조회 실패를 '이상 없음'으로 세면
   * 종합 판정이 초록이 되고, 사용자는 그걸 보고 다음 노드를 죽인다.
   */
  unknown?: boolean
}
type SvcState = 'active' | 'activating' | 'failed' | 'inactive' | 'notfound' | 'unknown'
interface NodeSvc {
  id: string
  name: string
  up: boolean
  states: Record<string, SvcState> // 유닛명 → 상태
  /**
   * 이번 주기 조회가 실패해 **직전 값을 그대로 쓴** 경우의 경과 초.
   * 이게 없으면 조회 실패가 열 전체 '—'(상태 미상)로 보여, 노드가 이상한 것처럼 읽힌다.
   */
  staleSec?: number
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
  abnormalCount: number // down 또는 disabled (표시 범위 판단용)
  /** 진짜 장애 — 서비스가 응답하지 않음(State/Alive down) */
  downCount: number
  /** 확인 필요 — 살아있지만 관리상 중지(disabled). evacuation 중 masakari 가 거는 정상 상태 포함 */
  disabledCount: number
  total: number
  errors: string[] // 조회 실패한 명령(권한/rc/CLI 문제) 안내
  /**
   * 이번 주기에 조회가 실패해 **직전 값을 그대로 쓴** 종류들.
   * 실패를 빈 결과로 반영하면 행·열이 사라졌다 나타났다 하며 '서비스가 없어졌다'로 읽힌다.
   * 값은 유지하되, 지금 값이 아니라는 사실은 반드시 화면에 남긴다.
   */
  stale: string[]
}
/**
 * 복구 타임라인 마일스톤 — 모두 '절대시각(epoch ms)'으로 보관한다.
 * 경과(mm:ss)만 저장하면 나중에 이력에서 시:분:초를 복원할 수 없기 때문.
 */
interface Milestones {
  /** 노드 DOWN 인지 (여러 노드가 죽으면 첫 노드 기준) */
  down?: { at: number; node: string; source: 'pcs' | 'ssh' | 'pre'; /** corosync·pacemaker 저널이 노드 이탈을 처음 남긴 시각(증적) */ srvAt?: number }
  /**
   * VIP 가 다른 노드로 넘어간 시점(툴 관측).
   * `pcmkAt` 은 pacemaker 가 **스스로 기록한** 새 노드의 int_vip start 시각(`crm_mon -1 -t` 의 last-rc-change,
   * 호스트 시계 → PC 시계 보정). 판정에는 쓰지 않고 증적으로 나란히 보여 준다.
   */
  vip?: { at: number; from: string; to: string; pcmkAt?: number; /** VIP 와 같은 리소스 그룹이라 함께 옮겨 간 리소스 — 역할 이동 줄을 따로 두지 않는다 */ with?: string[] }
  /** masakari evacuation 완료 */
  masakari?: {
    at: number
    by: string
    evac: number
    /**
     * Nova 의 VM 별 evacuation 기록 요약(증적) — 첫 VM 시작 · 마지막 VM 완료 · 대수 · 실패.
     * masakari 의 'finished' 는 알림 하나가 끝났다는 뜻이라, 20대를 옮길 때 각 VM 이 언제 끝났는지는 Nova 에 있다.
     */
    vms?: { count: number; failed: number; firstAt: number; lastAt: number }
  }
  /** 워크로드(Deployment/StatefulSet) 단위 파드 정상화 */
  pods: { at: number; ns: string; workload: string }[]
  /**
   * 네임스페이스의 비정상 워크로드가 **0 이 된** 시점 = 그 네임스페이스의 진짜 '복구 완료'.
   * 위 pods(워크로드별 복구)의 마지막 시각을 완료로 쓰면, 아직 못 돌아온 워크로드가 있어도
   * 완료로 적히고 새 복구가 관측될 때마다 시각이 뒤로 밀린다.
   * 옛 이력에는 이 필드가 없다(undefined) — 표시할 때 그것으로 갈라 예전 모양을 유지한다.
   */
  podsDone?: { at: number; ns: string; readyAt?: number }[]
  /**
   * pacemaker 가 관리하는 리소스(그룹)·DC 가 다른 노드로 옮겨 간 시점 — 데몬 표의 (m)/(s) 가 바뀐 순간.
   * VIP(int_vip)는 위 `vip` 줄이 따로 있어 여기서 뺀다. 리소스마다 **첫 이동만** 남긴다(되돌아오는 failback 은
   * 총 소요를 부풀릴 뿐 '언제 넘어갔나' 의 답이 아니다).
   */
  roles?: { at: number; name: string; from: string; to: string }[]
  /** Ceph degraded + misplaced 가 모두 0 이 된 시점 (= 데이터 복제 복구 완료) */
  ceph?: { at: number; /** Ceph 클러스터 로그의 'Health check cleared' 시각(증적) */ srvAt?: number }
  /**
   * Ceph 이 HEALTH_OK 까지 간 시점.
   * 위 `ceph` 와 반드시 구분해야 한다 — clock skew 처럼 복제와 무관한 사유로 WARN 이 남으면
   * degraded·misplaced 가 0 이어도 클러스터는 정상이 아니고, 종합 판정도 통과하지 않는다.
   */
  cephHealthy?: { at: number; /** Ceph 클러스터 로그의 'Cluster is now healthy' 시각(증적) */ srvAt?: number }
  /** IPMI 재기동 후 SSH 세션이 다시 붙은 시점 */
  reconnect?: { at: number; node: string; /** 그 노드가 부팅된 시각(uptime -s, 증적) */ bootAt?: number }
  /**
   * 노드가 **클러스터에** 돌아온 시각들 — SSH 가 붙었다고 클러스터에 다시 들어온 것은 아니다. 이미 받는 조회에서 뽑는다.
   *  - rejoin  : pcs 가 OFFLINE 으로 보고했던 노드가 다시 Online
   *  - k8sReady: 이 회차에 NotReady 였던 k8s 노드가 다시 Ready
   *  - osdUp   : `ceph -s` 의 OSD 가 모자랐다가 다시 전부 up·in (연속 2회)
   */
  rejoin?: { at: number; node: string }[]
  k8sReady?: { at: number; node: string }[]
  osdUp?: { at: number; up: number; total: number }
  /**
   * 서비스 포털 각 페이지가 다시 실데이터를 내려주기 시작한 시점.
   * 사용자가 "언제부터 포털을 쓸 수 있었나" 를 판단하는 최종 지표라, 클러스터 복구와
   * **같은 타임라인** 위에 있어야 의미가 있다(따로 재면 두 시계를 눈으로 맞춰야 한다).
   */
  portal: { at: number; name: string; group?: string; streak?: number }[]
  /**
   * 장애 뒤 끊겼다가 **아직 복구되지 않은** 포털 대상(회차를 저장·갱신한 시점 기준). 비어 있지 않으면 그 회차의
   * 포털은 미복구(Fail) — '포털 서비스 정상화' 를 돌아온 대상만으로 계산하지 않는다(사용자 기준: 모두 돌아와야 완료).
   */
  portalPending?: string[]
  /**
   * 장애를 **넣은** 시각 — DOWN 감지에는 감지 지연(pcs 수 초 · SSH 최대 90초)이 있어, 사용자가 체감한 중단 시작은 이보다 이르다.
   *  - button : 노드를 끈 순간 [장애 주입] 을 눌러 남긴 PC 시각
   *  - manual : 나중에 IPMI(BMC) 이벤트 로그의 전원 꺼짐 시각을 보고 사람이 넣은 값(note 에 출처). BMC 시계는 NTP 를
   *             안 쓰는 경우가 많아 수 분씩 틀리기도 한다 — 화면과 리포트에 그 사실을 함께 적는다.
   * 판정·총 소요에는 쓰지 않고 '주입 → 감지' 와 '주입부터의 시간' 을 나란히 보여 준다.
   */
  inject?: { at: number; source: 'button' | 'manual'; note?: string }
}
const emptyMilestones = (): Milestones => ({ pods: [], podsDone: [], portal: [] })
/** 이 회차에서 가장 늦은 마일스톤 시각 (없으면 0) — 이력의 '총 소요' 기준 */
const lastMilestoneAt = (ms: Milestones): number =>
  Math.max(
    0,
    ms.down?.at ?? 0,
    ms.vip?.at ?? 0,
    ms.masakari?.at ?? 0,
    ms.ceph?.at ?? 0,
    ms.cephHealthy?.at ?? 0,
    ms.reconnect?.at ?? 0,
    // 역할 이동(ms.roles)은 넣지 않는다 — 복구의 끝이 아니라 증적이다. 노드가 돌아와 리소스가 되돌아가거나
    // 누가 `pcs resource move` 를 하면 첫 이동이 검증 끝 무렵에 찍혀 총 소요가 그만큼 늘어난다.
    ...(ms.pods ?? []).map((p) => p.at),
    ...(ms.podsDone ?? []).map((p) => p.at),
    ...(ms.portal ?? []).map((p) => p.at),
  )

/** pcs 노드명을 상태보드 host(세션 id)로 이은 리소스 역할 */
interface BoardRoleRes extends PcsResource {
  ownerIds: string[]
  standbyIds: string[]
}
interface BoardRoles {
  /** DC 노드(pcs 이름) · 그 host id */
  dc: string
  dcId: string
  resources: BoardRoleRes[]
  /** pacemaker 클러스터에 속한 host — 컴퓨트처럼 클러스터 밖 노드에는 '대기' 를 그리지 않는다 */
  clusterIds: string[]
  /** 이번 프레임에 pcs 가 답하지 않아 **직전 역할**을 보여 주는 중 — 몇 초 전 값인지 */
  staleSec?: number
}

interface BoardState {
  hosts: HostStat[]
  vipNode: string
  /** 이번 주기에 응답 시간 초과로 갱신하지 못한 섹션 이름 */
  delayed: string[]
  /** 역할 매핑에 남아 있지만 아직 그 서버를 열지 않아 조회 대상이 아닌 host 슬롯 수 */
  pendingHosts: number
  /**
   * 첫 폴링의 모든 그룹이 한 번씩 응답했는지.
   * 그룹별 부분 갱신으로 바꾸면서 생긴 함정 — 아직 아무 그룹도 안 끝난 시점의 state 는
   * hosts=[] · ceph=null · pods=[] 라서 종합 판정 조건이 전부 통과해 '정상(다음 노드 가능)'
   * 이라는 거짓 초록이 잠깐 뜬다. 첫 주기를 마치기 전에는 판정도 보드도 보류한다.
   */
  ready: boolean
  masakari: MasakariStat[]
  ceph: CephStat | null
  pods: PodStat[]
  podScope: 'abnormal' | 'all'
  serviceUnits: string[] // 서비스 패널 행(유닛) 목록
  /** pacemaker 리소스의 주(m)/보조(s) 노드와 DC — 데몬 표에 역할 표시. pcs 를 못 읽었으면 null */
  roles: BoardRoles | null
  services: NodeSvc[] // 노드별 서비스 데몬 상태
  openstack: OsStat | null // OpenStack 서비스(API) 상태
  osScope: 'abnormal' | 'all'
  tzNote: string
  lastAt: number
  /** Ready 가 아닌 k8s 노드 — 파드 상태를 믿을 수 없는 구간을 화면에 밝히기 위해 들고 있는다 */
  notReadyNodes: string[]
  /** 그룹별 마지막 갱신 시각 — 특정 섹션만 갱신이 멈춘 것을 화면에서 알아볼 수 있게 한다 */
  updatedAt: Record<string, number>
  /** 그룹별 예외 문구 — 예외를 삼키면 그 섹션이 옛 값에 멈춘 채 아무 표시도 나지 않는다 */
  jobErrors: Record<string, string>
}

// sudo -n(비번없이) 먼저 시도 → 실패 시 sudo 없이. root 진입이 기본이라 대개 첫 시도로 통과.
const sudoOr = (cmd: string) => `sudo -n ${cmd} 2>/dev/null || ${cmd} 2>&1`

/**
 * 명령 하나의 최대 대기 시간. 노드를 죽여 놓고 보는 화면이라 `ceph -s` 나 `openstack ... list`
 * 가 수십 초 매달리는 일이 흔한데, 타임아웃이 없으면 그 한 건이 보드 전체 갱신을 붙잡는다.
 * (초과해도 서버쪽 실행은 계속될 수 있다 — 클라이언트 대기만 끊는다)
 */
const CMD_TIMEOUT_MS = 12000
/** pcs 가 답하지 않을 때 직전 OFFLINE 을 유지하는 최대 시간 — SSH keepalive 한도(15초×6=90초)에 여유를 둔 값 */
const PCS_HOLD_MAX_MS = 120_000
type RunResult = { ok: boolean; code?: number; out?: string; err?: string; error?: string; timedOut?: boolean }
async function run(id: string, cmd: string, timeoutMs = CMD_TIMEOUT_MS): Promise<RunResult> {
  let tid: ReturnType<typeof setTimeout> | undefined
  const r = await Promise.race<RunResult>([
    window.electronAPI.sessionRun(id, cmd),
    new Promise<RunResult>((resolve) => {
      tid = setTimeout(() => resolve({ ok: false, error: `응답 시간 초과(${timeoutMs / 1000}초)`, timedOut: true }), timeoutMs)
    }),
  ])
  if (tid) clearTimeout(tid)
  return r
}
// admin_openrc 를 소싱한 뒤 openstack CLI 를 JSON 으로 실행 (로그인 셸로 PATH 확보)
const osCmd = (rc: string, sub: string) => `bash -lc '. ${rc} 2>/dev/null; openstack ${sub} -f json 2>&1'`

// ── 파서 ───────────────────────────────────────────────────────
/** 노드명으로 볼 수 있는 토큰인가 — 대괄호·콜론 같은 서식 문자가 노드명으로 잡히는 걸 막는다 */
const looksLikeNode = (s: string) => /^[A-Za-z0-9][\w.-]*$/.test(s)
/**
 * pcs status 출력에서 int_vip 리소스가 붙은 노드명 추출.
 *
 * `Started con02` 만 나오는 게 아니다 — 리소스 종류와 전환 중 상태에 따라
 * `Started: [ con02 ]` · `Started [ con02 con03 ]` 형태도 나온다.
 * 예전 정규식(`Started\s+(\S+)`)은 그 형태에서 **`[` 를 노드명으로 잡았고**, 그 값이
 * 바뀌는 순간(노드가 다시 합류할 때 서식이 변한다) 타임라인에 가짜 'VIP 이동' 이 찍혔다.
 */
function parseVipNode(out: string): string {
  for (const m of out.matchAll(/int_vip\b[^\n]*?Started\b[:\s]*(\[[^\]\n]*\]|\S+)/gi)) {
    const raw = (m[1] ?? '').trim()
    // 대괄호 안이면 그 안의 첫 노드명을 쓴다(전환 중에는 여러 노드가 나열될 수 있다)
    const cands = raw.startsWith('[') ? raw.slice(1, -1).trim().split(/\s+/) : [raw]
    const node = cands.find(looksLikeNode)
    if (node) return node
  }
  return ''
}
/**
 * pcs status 에서 노드별 Online/OFFLINE 목록 추출.
 * SSH 세션 끊김으로 DOWN 을 판정하면 keepalive(15초×6회) 때문에 최대 90초까지 늦게 잡힌다.
 * 살아있는 노드의 pacemaker 는 corosync 토큰 타임아웃(보통 수 초) 안에 OFFLINE 을 보고하므로
 * 복구 타임라인의 기준 시각으로는 이쪽이 훨씬 정확하다.
 *   포맷1: "Online: [ con01 con02 ]" / "OFFLINE: [ con03 ]"
 *   포맷2: "Node con03: UNCLEAN (offline)" / "Node con03: OFFLINE"
 */
function parsePcsNodes(out: string): { online: string[]; offline: string[] } {
  const online: string[] = []
  const offline: string[] = []
  const grab = (re: RegExp, into: string[]) => {
    for (const m of out.matchAll(re)) for (const n of m[1].trim().split(/\s+/)) if (n) into.push(n)
  }
  // 최신 pacemaker 는 각 줄을 "  * Online: [ ... ]" 처럼 불릿으로 시작하므로 * 를 허용한다
  const BULLET = String.raw`^[ \t]*(?:\*[ \t]*)?`
  grab(new RegExp(BULLET + String.raw`Online:[ \t]*\[([^\]]*)\]`, 'gim'), online)
  grab(new RegExp(BULLET + String.raw`OFFLINE:[ \t]*\[([^\]]*)\]`, 'gim'), offline)
  const unclean = new RegExp(BULLET + String.raw`Node[ \t]+(\S+?):[ \t]*(?:UNCLEAN[ \t]*\(offline\)|OFFLINE)`, 'gim')
  for (const m of out.matchAll(unclean)) offline.push(m[1])
  return { online, offline }
}
/**
 * pcs 노드명 목록 중 이 host 세션과 일치하는 게 있는지.
 *
 * hostname 을 알고 있으면 **정확히 일치**만 인정한다(부분일치 금지).
 * 실제 클러스터에 `con01`/`com01` 처럼 한 글자만 다른 노드가 함께 있어서,
 * 느슨하게 매칭하면 컨트롤러의 상태를 컴퓨트 노드 것으로 잘못 읽을 수 있다.
 * hostname 을 아직 못 받은 경우(한 번도 접속 못 한 노드)에만 표시명 기반 근사 매칭으로 폴백한다.
 */
function pcsHas(nodes: string[], name: string, hostname?: string): boolean {
  if (hostname) {
    const h = hostname.toLowerCase()
    const hShort = h.split('.')[0]
    return nodes.some((n) => {
      const v = n.toLowerCase()
      return h === v || hShort === v || hShort === v.split('.')[0]
    })
  }
  return nodes.some((n) => matchesVip(n, name))
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
// (예전에 있던 단일 UUID_RE 는 지웠다 — 한 줄에서 첫 UUID 만 집어 요청 id(req-…)를 인스턴스로
//  착각했다. 폴백은 req 를 지운 뒤 그 줄의 UUID 를 전부 모은다)
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
): { state: MasakariState; detail: string; evac: number; at?: number; line?: string } {
  const all = stripAnsi(out).split('\n').filter(Boolean)
  const recent = all.filter((l) => {
    const ts = lineTs(l)
    return ts != null && ts - delta >= t0
  })
  // 검증 시작 이후의 로그가 한 줄도 없다 = 아직 아무 일도 안 일어났다. '진행 중'이 아니다.
  if (!recent.length) return { state: 'idle', detail: '검증 시작 후 evacuation 로그 없음', evac: 0 }
  const uuids = new Set<string>()
  for (const l of recent) {
    let m: RegExpExecArray | null
    EVAC_RE.lastIndex = 0
    while ((m = EVAC_RE.exec(l)) !== null) uuids.add(m[1].toLowerCase())
  }
  // 정확한 패턴이 안 잡히면(masakari 버전마다 문구가 다르다) evacuat 라인의 UUID 로 폴백.
  //
  // 여기에 함정이 둘 있었다:
  //  1) masakari 로그는 **모든 줄 앞머리에 요청 id(`req-<uuid>`)** 를 붙인다. 그게 줄마다
  //     다르므로 인스턴스 id 로 세면 **줄 수만큼 대수가 뛴다.** 먼저 지운다.
  //  2) 한 줄에서 `match()` 로 **첫 UUID 하나만** 집었다 — 그 첫 값이 바로 위의 req id 였다.
  //     즉 폴백이 걸리는 환경에서는 대수가 통째로 엉터리였다.
  if (uuids.size === 0) {
    const REQ_RE = new RegExp(`req-${UUID}`, 'gi')
    const ALL_UUID_RE = new RegExp(UUID, 'gi')
    for (const l of recent) {
      if (!/evacuat/i.test(l)) continue
      for (const m of l.replace(REQ_RE, '').matchAll(ALL_UUID_RE)) uuids.add(m[0].toLowerCase())
    }
  }
  const evac = uuids.size
  // 완료 판정: 알림이 실제로 종료된 로그만 매칭 ("Notification <uuid> exits with status: finished.")
  //   중복 스킵 WARNING("...current status ... in db is 'finished'")이나 "Processing notification..." 은 완료가 아님.
  // 가장 이른 완료 줄을 고른다 — 그 줄의 타임스탬프가 '언제 끝났나' 의 답이다.
  // (some() 으로 존재만 확인하면 시각을 잃어버려, 마일스톤이 '발견 시각' 으로 찍힌다)
  const finishedLine = recent.find((l) => /exits\s+with\s+status:\s*finished/i.test(l))
  if (finishedLine) {
    const ts = lineTs(finishedLine)
    return {
      state: 'finished',
      detail: evac ? `evacuation 완료 · ${evac}대` : 'evacuation 완료',
      evac,
      // delta 를 빼서 호스트 로컬 표기를 절대시각으로 되돌린다(t0 비교와 같은 기준).
      at: ts != null ? ts - delta : undefined,
      // 판정 근거가 된 바로 그 줄 — 증적 화면이 이 줄로 스크롤해 강조한다
      line: finishedLine,
    }
  }
  // 처리할 알림이 하나도 안 잡혔으면 '진행 중'이 아니라 '아직 아무 일 없음'이다
  if (evac === 0) return { state: 'idle', detail: '검증 시작 후 evacuation 로그 없음', evac }
  return { state: 'progress', detail: `진행 중 · ${evac}대 처리`, evac }
}
/**
 * '지정은 했는데 확인하지 못한' Ceph 상태.
 * health 'unknown' 이라 종합 판정에서 통과되지 않는다 — 이게 핵심이다.
 */
const unknownCeph = (note: string): CephStat => ({
  health: 'unknown',
  degraded: 0,
  misplaced: 0,
  total: 0,
  rate: 0,
  peakRemain: 0,
  etaSec: null,
  reasons: [],
  note,
})
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
  return { health, degraded, misplaced, total, rate, peakRemain: remain, etaSec, reasons, note }
}
/**
 * kubectl get pods -o wide --no-headers 파싱.
 * 컬럼: NAME READY STATUS RESTARTS AGE IP NODE ...
 * 정상(healthy) = Completed 이거나, Running 이면서 READY 가 a/a(모두 준비). 그 외는 비정상.
 * scope='abnormal' → 비정상 행만, 'all' → 전체 행 반환. (abnormalCount 는 항상 계산)
 */
/**
 * `kubectl get nodes --no-headers` 에서 **Ready 가 아닌 노드**를 뽑는다.
 *
 * 왜 필요한가 — 노드(VM)가 갑자기 죽어도 API 서버는 그 노드의 파드를 한동안 `Running` 으로
 * 계속 보고한다. 기본값으로 노드가 `NotReady` 가 되기까지 약 40초, 파드 축출이 시작되기까지
 * 그로부터 5분(`tolerationSeconds`)이다. 그동안 파드 상태만 보면 '정상' 이라, 실제로는
 * 아무것도 확인되지 않는 구간이 몇 분씩 초록으로 남는다.
 *
 * 그래서 노드 상태를 교차 확인한다. **NotReady 노드의 `Running` 은 정상 확인이 아니라 낡은 값이다.**
 *
 * STATUS 컬럼은 쉼표로 여러 값이 붙는다: `Ready` · `NotReady` · `Ready,SchedulingDisabled`(cordon)
 * · `NotReady,SchedulingDisabled`. cordon 만 걸린 노드는 **정상이다** — 스케줄만 막힌 것이다.
 * 그래서 문자열에 'NotReady' 가 있는지 보는 게 아니라, 토큰에 'Ready' 가 있는지로 가른다.
 */
/** kubectl 이 STATUS 컬럼에 쓰는 값 — 이 중 하나도 없으면 노드 줄이 아니다 */
const KNOWN_NODE_STATUS = ['Ready', 'NotReady', 'Unknown', 'SchedulingDisabled']
function parseNotReadyNodes(out: string): Set<string> {
  const bad = new Set<string>()
  for (const line of out.split('\n')) {
    const cols = line.trim().split(/\s+/)
    if (cols.length < 2) continue
    const name = cols[0]
    // kubectl 에러 문구가 섞여 들어오면 노드명처럼 보이지 않는다 — 그런 줄은 버린다
    if (!/^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/i.test(name)) continue
    /**
     * STATUS 값이 아는 것인지 먼저 본다. 이게 없으면 kubectl 이 에러 문구를 뱉었을 때
     * 'Unable to connect to the server...' 의 'Unable' 을 노드명으로, 'to' 를 STATUS 로 잡아
     * **없는 노드가 NotReady 로 화면에 뜬다.** (뽑은 값을 아는 목록과 교차 검증하는 규칙)
     */
    const tokens = cols[1].split(',')
    if (!tokens.some((t) => KNOWN_NODE_STATUS.includes(t))) continue
    if (!tokens.includes('Ready')) bad.add(name)
  }
  return bad
}
function parsePods(
  namespace: string,
  out: string,
  scope: 'abnormal' | 'all',
  notReadyNodes: Set<string>,
): PodStat {
  const lines = out
    .split('\n')
    .map((l) => l.trim())
    // kubectl 안내/에러 줄 제외 ("No resources found in <ns> namespace." 등)
    .filter((l) => l && !/^error|^the connection|^the server|no resources found|not found|unable to connect|forbidden/i.test(l))
    // klog 형식의 오류·경고 줄(`E1008 10:00:00.123456 12345 memcache.go:265] …`) — apiserver 에 못 닿으면
    // kubectl 이 이런 줄을 찍는데, 위 문구 필터를 빠져나가 `E1008` 이라는 **가짜 비정상 파드**가 됐다.
    // 그러면 조회 실패가 '확인 불가' 가 아니라 비정상 파드로 보였고, 직전에 비정상이던 워크로드가 이번
    // 목록에 없으니 그 시각에 '복구' 로 찍혔다(가짜 조기 복구).
    .filter((l) => !/^[EWIF]\d{4} \d\d:\d\d:\d\d/.test(l))
  if (!lines.length) return { namespace, total: 0, abnormalCount: 0, rows: [], note: '파드 없음 또는 조회 실패' }
  const all: PodRow[] = []
  for (const l of lines) {
    const cols = l.split(/\s+/)
    if (cols.length < 3) continue
    const name = cols[0]
    const ready = cols[1] ?? ''
    const status = cols[2]
    // 파드 줄인지 교차 검증한다 — READY 는 늘 `숫자/숫자`, 이름은 DNS 이름 형태다. 아니면 kubectl 이 찍은
    // 다른 문구이므로 파드로 세지 않는다(정규식 파싱은 서식 변화를 가정한다는 이 저장소의 규칙)
    if (!/^\d+\/\d+$/.test(ready) || !/^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/.test(name)) continue
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
    // 노드가 Ready 가 아니면 파드 상태와 무관하게 '확인되지 않음' 이다 (parseNotReadyNodes 주석 참고)
    const nodeNotReady = notReadyNodes.has(node)
    /**
     * CronJob 이 띄운 파드(`<cronjob>-<예약 분 8자리 이상>-<5자>`)는 판정에서 뺀다. 주기마다 새로 생겨
     * ContainerCreating → Running 0/1 → Completed 를 거치는데, 그 생성 순간이 '비정상' 으로 잡혀 장애와 무관한
     * '파드 복구 시작·완료' 가 찍혔다(실제로 10분마다 도는 valkey-cluster-maintenance-cronjob 이 그랬다).
     * 배치 작업은 서비스 가용성이 아니다. 이름 규칙으로만 가리므로 CronJob 없이 직접 만든 Job 의 파드
     * (`<job>-<5자>`)는 가려내지 못한다 — 그런 것이 문제가 되면 네임스페이스 범위에서 빼야 한다.
     * 숫자 자리는 **예약 시각(epoch 분)** 이므로 지금과 이틀 안쪽인지 교차 검증한다 — Deployment 파드의 해시
     * (`api-<해시>-<5자>`)가 우연히 숫자만으로 나오면 그 파드가 판정에서 통째로 빠지기 때문이다(검토 지적).
     * 지난 회차의 완료 파드는 어차피 Completed(정상)라 이틀 밖이어도 상관없다.
     */
    const cronMin = /-(\d{8,})-[a-z0-9]{5}$/.exec(name)?.[1]
    const cronPod = !!cronMin && Math.abs(Number(cronMin) * 60_000 - Date.now()) < 2 * 86_400_000
    const healthy =
      cronPod || (!nodeNotReady && (/^Completed$/i.test(status) || (/^Running$/i.test(status) && readyFull)))
    all.push({ name, ready, status, node, healthy, ...(nodeNotReady ? { nodeNotReady: true } : {}) })
  }
  const abnormalCount = all.filter((p) => !p.healthy).length
  // 비정상(Running 아님/Ready 미충족)을 항상 맨 위로. 전체 보기에서 파드가 수십 개면
  // Terminating/Pending 이 중간에 묻혀 스크롤로 찾아야 하므로 정렬로 끌어올린다.
  // (같은 그룹 안의 순서는 kubectl 출력 순서 유지 — sort 는 안정 정렬)
  const rows = (scope === 'all' ? [...all] : all.filter((p) => !p.healthy)).sort(
    (a, b) => Number(a.healthy) - Number(b.healthy),
  )
  // 줄은 있었는데 파드로 읽힌 것이 하나도 없다 = kubectl 이 다른 것을 찍었다 — '없음' 이 아니라 '모름'
  if (all.length === 0) return { namespace, total: 0, abnormalCount: 0, rows: [], note: '파드 목록을 읽지 못함', unparsed: true }
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
  // down(장애)과 disabled(관리상 중지)는 심각도가 다르다 — 합쳐서 '이상'으로 세면
  // evacuation 중 정상적으로 disable 된 nova-compute 가 장애처럼 보인다.
  const downCount = all.filter((s) => !s.up).length
  const disabledCount = all.filter((s) => s.up && !s.enabled).length
  // stale 은 '이번 주기에 조회가 실패해 직전 값을 썼는가' 라 파서가 알 수 없다 — 호출부가 채운다.
  return { rows: all, abnormalCount, downCount, disabledCount, total: all.length, errors, stale: [] }
}

/**
 * 파드 이름 → 워크로드(Deployment/StatefulSet/DaemonSet) 이름.
 * 노드가 죽으면 파드는 '복구'되는 게 아니라 다른 이름으로 재생성되므로(app-7d9f-x2k1 →
 * app-7d9f-p8mq) 파드명으로는 복구 시점을 추적할 수 없다. 접미사를 떼어 워크로드 단위로 본다.
 */
function workloadOf(pod: string): string {
  const sts = pod.replace(/-\d+$/, '') // StatefulSet: name-0
  if (sts !== pod) return sts
  const dep = pod.replace(/-[a-z0-9]{6,10}-[a-z0-9]{5}$/, '') // Deployment: name-<rs>-<pod>
  if (dep !== pod) return dep
  return pod.replace(/-[a-z0-9]{5}$/, '') // DaemonSet/Job: name-<pod>
}

// ── 검증 이력 (마일스톤만) ─────────────────────────────────────
const HIST_KEY = 'statusboard_history_v1'
const HIST_MAX = 50
interface HistoryRecord {
  id: string
  /** 검증 시작 시각 */
  t0: number
  /** 이력이 확정된 시각(= Ceph 복구 완료 시점, 없으면 수동 종료 시각) */
  closedAt: number
  /** 어떤 노드를 죽인 회차인지 */
  node: string
  /**
   * 사람이 붙인 회차 이름 (예: `306ha con1 1차`, `IPMI 강제종료 재시험`).
   * 노드명·시각만으로는 며칠 뒤에 어떤 조건의 회차였는지 구분이 안 된다.
   * 검증 중에 입력해두면 저장 시 함께 남고, 이력 목록에서 나중에 고칠 수도 있다.
   */
  label?: string
  milestones: Milestones
}
function loadHistory(): HistoryRecord[] {
  try {
    const raw = localStorage.getItem(HIST_KEY)
    if (!raw) return []
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? (arr as HistoryRecord[]) : []
  } catch {
    return []
  }
}
function saveHistory(list: HistoryRecord[]): void {
  try {
    localStorage.setItem(HIST_KEY, JSON.stringify(list.slice(0, HIST_MAX)))
  } catch {
    /* 용량 초과 등은 무시 — 이력은 부가 기능이라 검증 자체를 막지 않는다 */
  }
}

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(s / 60)
  const ss = s % 60
  return `${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
}
/** '몇 초 전' — 특정 섹션의 갱신이 멈춘 것을 한눈에 알아보게 하는 표기 */
function fmtAgo(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}초 전`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}분 ${s % 60}초 전` : `${Math.floor(m / 60)}시간 ${m % 60}분 전`
}
function fmtEta(sec: number): string {
  if (sec < 60) return `약 ${sec}초`
  return `약 ${Math.round(sec / 60)}분`
}
/**
 * 절대시각 → HH:MM:SS.
 * toLocaleTimeString('ko-KR', {hour12:false}) 를 쓰면 안 된다 —
 * "16시 2분 55초" 처럼 한글 단위가 붙어 나와서 폭이 두 배가 되고 '초' 에서 줄바꿈된다.
 * 타임라인은 자릿수가 고정돼야 세로로 정렬되므로 직접 0 채움으로 만든다.
 */
function fmtClock(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
/** 절대시각 → YYYY-MM-DD HH:MM:SS (이력 목록용) */
function fmtDateTime(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${fmtClock(ms)}`
}
/**
 * DOWN 노드 SSH 부활 감시 주기.
 * 상태보드 폴링(intervalSec, 기본 5초)과 분리된 독립 타이머로 돈다 — 폴링 주기를 30초로 길게
 * 잡아둔 경우에도 재연결은 빠르게 되어야 하기 때문. 시도 횟수 제한은 두지 않는다(부팅이
 * 얼마나 걸릴지 알 수 없고, 중간에 포기하면 그때부터는 사람이 붙어 있어야 한다).
 */
const PROBE_TICK_MS = 3000
/** 재연결을 '요청한' 뒤 다음 요청까지의 최소 간격 (연결 시도가 겹치지 않게) */
const RECONNECT_PROBE_MS = 6000

/**
 * 가용성 검증 상태보드 — 역할 매핑(host/masakari/ceph/pod 세션 지정) 후, 각 역할 세션에
 * 단발 명령(session:run)을 주기 폴링해 상태 카드 + 복구 타임라인으로 표시한다.
 * 신규 IPC 없이 기존 sessionRun 만 사용하며, 겹침 방지를 위해 재귀 setTimeout 으로 폴링한다.
 */
/**
 * 회차 이름 제안 — `08-30 18:40 con2 down`.
 * 날짜를 앞에 두는 이유: 이력 목록이 시각 역순이라 같은 날 회차가 붙어 보이고, 그때 구분되는
 * 것은 노드 이름이다. 연도는 넣지 않는다(이력에 절대 시각이 이미 있다).
 */
function suggestRunLabel(at: number, node: string): string {
  const d = new Date(at)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())} ${node} down`
}

export default function StatusBoard({ sessions, onClose, onReconnect }: StatusBoardProps) {
  const [cfg, setCfg] = useState<BoardConfig>(loadCfg)
  const [view, setView] = useState<'config' | 'board'>('config')
  const [history, setHistory] = useState<HistoryRecord[]>(loadHistory)
  const [showHistory, setShowHistory] = useState(false)
  /** 회차 id(t0) → 저장된 증적 key 들 — 타임라인의 [증적] 버튼을 띄울지 정한다 */
  const [evIndex, setEvIndex] = useState<Record<string, string[]>>({})
  /** 지금 열어 둔 증적 (회차 id + key) */
  const [evOpen, setEvOpen] = useState<{ id: string; key: string } | null>(null)
  /**
   * 이번 회차 이름. 검증 중에 입력해두면 이력에 함께 저장된다.
   * 회차를 시작할 때 비우지 않는다 — '…1차' → '…2차' 처럼 고쳐 쓰는 게 대부분이고,
   * 헤더에 그대로 보이므로 모르고 지나칠 일은 없다.
   */
  const [runLabel, setRunLabel] = useState('')
  /**
   * 회차 이름을 자동으로 채운 적이 있는지.
   *
   * 며칠 뒤 이력에서 시각만 보고는 어떤 회차였는지 구분이 안 되는데, 검증 중에 이름을 적는 사람은
   * 많지 않다(빈칸으로 남는다). 장애가 감지되면 그 시점의 정보로 한 번만 채워 준다 —
   * **사람이 이미 적어 둔 것은 건드리지 않는다.** 채운 뒤에도 그대로 고칠 수 있다.
   */
  const autoLabeledRef = useRef(false)
  /**
   * 이번 회차에 이미 보낸 알림.
   *
   * 같은 사건을 두 번 알리지 않는다 — 1초마다 도는 판정에서 조건이 계속 참이므로 그냥 두면
   * 초당 한 번씩 토스트가 쌓인다. 회차를 새로 시작할 때 비운다.
   */
  const notifiedRef = useRef({ down: false, recovered: false })
  // commitHistory 는 언마운트 정리에서도 불리므로 최신 값을 ref 로 노출한다
  const runLabelRef = useRef('')
  runLabelRef.current = runLabel
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
  /**
   * 폴링 루프의 세대. 루프는 자기를 setTimeout 으로 다시 부르므로, 이전 루프가 await 중일 때 새 루프를 띄우면
   * 둘 다 살아 조회가 두 배가 된다. 새로 띄울 때 세대를 올리고, 세대가 바뀐 루프는 다음 주기를 잡지 않는다.
   */
  const loopGenRef = useRef(0)
  /** 정리(cleanup) 순간 검증이 돌고 있었는지 — 같은 화면이 다시 붙으면(dev 의 HMR) 이어서 돌린다 */
  const resumeRef = useRef(false)
  // 재연결 감시 전용 타이머 (폴링과 분리)
  const probeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const t0Ref = useRef<number>(0)
  // 마일스톤 최초 감지 시각(절대 epoch ms) — 복구 타임라인 + 이력 저장용
  const msRef = useRef<Milestones>(emptyMilestones())
  // host 세션 id → DOWN 최초 인지 시각/근거 (노드가 다시 살아나면 지워진다)
  const downAtRef = useRef<Record<string, { at: number; source: 'pcs' | 'ssh' | 'pre' }>>({})
  /**
   * 이번 회차에 한 번이라도 DOWN 이었던 host — SSH 가 실제로 다시 붙을 때까지 유지한다.
   * downAtRef 로 대신하면 안 된다: IPMI 로 전원을 올리면 pacemaker 가 먼저 Online 을 보고해
   * downAtRef 가 지워지는데, 그 시점엔 아직 SSH 가 안 붙어서 재연결 감시가 꺼져버린다.
   */
  const wasDownRef = useRef<Set<string>>(new Set())
  /**
   * SSH 가 **실제로 끊긴 것을 관측한** host — '재연결' 을 인정하는 전제 조건이다.
   * 전원이 갑자기 끊기면 FIN/RST 가 못 나가 소켓이 한동안 살아 있는 것처럼 보이므로,
   * pcs 가 DOWN 을 보고한 것만으로 재연결을 판정하면 안 된다.
   */
  const sshLostRef = useRef<Set<string>>(new Set())
  /** pcs 가 Online 으로 보고한 적이 있는 host — 이 노드의 OFFLINE 만 '전원 다운'으로 신뢰한다 */
  const pcsSeenOnlineRef = useRef<Set<string>>(new Set())
  /** `pcs status` 를 마지막으로 제대로 답해준 host 세션 — 다음 폴링에서 먼저 물어본다 */
  const pcsSourceRef = useRef<string>('')
  /** 이번 검증 중 한 번이라도 UP 이었던 host — 아니면 '시작 전부터 죽어 있던' 노드로 구분한다 */
  const seenUpRef = useRef<Set<string>>(new Set())
  // 직전에 관측한 VIP 노드명 — 이 값이 바뀌는 순간이 'VIP 이동'
  const vipSeenRef = useRef('')
  /** pacemaker 리소스(·DC)별 처음 본 주 노드 — 바뀌면 역할 이동 마일스톤 */
  const rolesSeenRef = useRef<Record<string, string>>({})
  /** 이미 이동을 기록한 리소스 — 첫 이동만 남긴다 */
  const rolesDoneRef = useRef<Set<string>>(new Set())
  /** 마지막으로 **제대로 읽은** 역할 — pcs 가 답하지 않는 프레임에 '몇 초 전 값' 으로 보여 준다 */
  const lastRolesRef = useRef<{ v: BoardRoles; at: number } | null>(null)
  /** 직전 프레임의 pcs status 원문 — 이동 증적에 '이동 전' 으로 붙인다 */
  const lastPcsOutRef = useRef('')
  /** masakari 완료를 원문 없이(직전 값으로) 처음 본 회차 — 다음 성공 조회에서 증적을 남긴다 */
  const masakariEvPendingRef = useRef(false)
  // 네임스페이스 → 직전 폴링에서 비정상이던 워크로드 집합 (사라지면 복구로 판정)
  const badWorkloadsRef = useRef<Record<string, Set<string>>>({})
  /** pcs 가 OFFLINE 으로 본 적 있는 host — 다시 Online 이면 '클러스터 재합류' */
  const pcsSawOfflineRef = useRef<Set<string>>(new Set())
  /** 이 회차에 NotReady 였던 k8s 노드 */
  const k8sNotReadySeenRef = useRef<Set<string>>(new Set())
  /** OSD 가 모자란 것을 본 적 있나 · 전부 돌아온 연속 횟수 */
  const osdRef = useRef<{ short: boolean; hits: number; firstAt: number }>({ short: false, hits: 0, firstAt: 0 })
  /** 네임스페이스별 복구 후보 — 연속 2프레임 정상이어야 확정한다 */
  const podCandRef = useRef<Record<string, PodCand>>({})
  // 재연결 감시 상태 — lastFire: 마지막 재연결 요청 시각(연속 호출 방지), state: 화면 표시용
  const probeRef = useRef<{
    lastFire: Record<string, number>
    state: Record<string, { tries: number; note: string; ok: boolean }>
  }>({ lastFire: {}, state: {} })
  // 이번 검증 회차를 이력으로 이미 저장했는지
  const savedRef = useRef(false)
  /** 저장 시점에 쓴 '확정 시각' — 갱신할 때 이 값을 유지해 총 소요가 부풀지 않게 한다 */
  const closedAtRef = useRef(0)
  /** HEALTH_OK 도달을 이력에 반영했는지 (데이터 복구보다 늦게 오므로 한 번 더 덮어쓴다) */
  const savedHealthyRef = useRef(false)
  /** 그룹별 마지막 갱신 시각 / 예외 — 폴링 주기 사이에 유지돼야 하므로 ref 에 둔다 */
  const updatedAtRef = useRef<Record<string, number>>({})
  const jobErrorsRef = useRef<Record<string, string>>({})
  // Ceph 복구 진행률 기준선 — 검증 시작 후 관측된 '남은 객체' 최대값(장애 직후 최대치)
  const cephPeakRef = useRef(0)
  /**
   * '남은 객체 0' 을 연속 몇 번 봤는지. 복구 완료 마일스톤은 한 번 박히면 안 지워지므로,
   * 부분 출력 한 프레임에 속아 가짜로 찍히지 않도록 연속 2회를 요구한다.
   */
  const cephDoneHitsRef = useRef(0)
  /** HEALTH_OK + 남은 객체 0 을 연속 몇 번 봤는지 (위와 같은 이유로 연속 2회 요구) */
  const cephOkHitsRef = useRef(0)
  /**
   * OpenStack 조회 결과의 마지막 성공값 (종류별).
   * 노드를 죽여 놓은 동안 `openstack ... list` 는 자주 타임아웃한다. 그때 빈 결과로 덮으면
   * 표의 행·열이 사라졌다 나타났다 해서 읽을 수가 없다 — 직전 값을 유지하고 '몇 초 전 값'만 밝힌다.
   */
  const osCacheRef = useRef<Record<string, { out: string; at: number }>>({})
  /** 노드별 서비스 데몬 상태의 마지막 성공값 — 위와 같은 이유(열 전체가 '—' 로 바뀌는 것 방지) */
  const svcCacheRef = useRef<Record<string, { states: Record<string, SvcState>; at: number }>>({})
  // host 세션 id → 실제 hostname (VIP 노드명 매칭용, 세션당 1회만 조회)
  const hostnamesRef = useRef<Record<string, string>>({})
  // masakari 세션 id → 로그시각 보정값 { delta(ms), ok } (검증 시작 시 host date 로 1회 산출)
  const calibRef = useRef<Record<string, { delta: number; ok: boolean }>>({})
  /** 마지막으로 **제대로 받은** Ceph 상태 — 응답이 늦은 프레임에 '몇 초 전 값' 으로 보여 준다 */
  const lastCephRef = useRef<{ v: CephStat; at: number } | null>(null)
  /** masakari 호스트별 마지막으로 **제대로 받은** 판정 — 조회 실패 프레임에 이것을 유지한다 */
  /** pcs 가 OFFLINE 이라고 확정한 노드 — pcs 가 답하지 않는 프레임에도 그 판정을 유지한다 */
  const pcsDownRef = useRef<Map<string, { at: number; sshDropped: boolean }>>(new Map())
  const lastMasakariRef = useRef<Record<string, { p: ReturnType<typeof parseMasakari>; at: number }>>({})

  // 폴링 루프는 시작 시점의 클로저에 고정되므로, 최신 cfg/sessions 를 ref 로 노출해 항상 최신값을 읽게 한다.
  const cfgRef = useRef(cfg)
  cfgRef.current = cfg
  const sessionsRef = useRef(sessions)
  sessionsRef.current = sessions

  const nameOf = (id: string) => sessionsRef.current.find((s) => s.id === id)?.name ?? id
  const connectedOf = (id: string) => sessionsRef.current.find((s) => s.id === id)?.connected ?? false
  const connected = sessions.filter((s) => s.connected)
  // 재연결 콜백은 매 렌더 새 함수가 들어오므로 ref 로 최신값을 폴링 루프에 노출한다
  const onReconnectRef = useRef(onReconnect)
  onReconnectRef.current = onReconnect
  /**
   * 세션의 접속 주소(host/port).
   * 1순위는 프로필 키("host:port:username"). 다만 연결 실패가 반복되면 앱이 이 키를 잃을 수
   * 있으므로(그 경우 재연결 감시가 통째로 죽는다), 마지막으로 알고 있던 주소를 따로 기억해 둔다.
   */
  const lastAddrRef = useRef<Record<string, { host: string; port: number }>>({})
  const hostAddrOf = (id: string): { host: string; port: number } | null => {
    const key = sessionsRef.current.find((s) => s.id === id)?.profileKey
    if (key) {
      const parts = key.split(':')
      const port = parseInt(parts[1] ?? '', 10)
      if (parts.length >= 2 && parts[0]) {
        const addr = { host: parts[0], port: Number.isFinite(port) ? port : 22 }
        lastAddrRef.current[id] = addr
        return addr
      }
    }
    return lastAddrRef.current[id] ?? null
  }

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

  useEffect(() => {
    window.electronAPI
      .boardEvidenceList()
      .then((r) => {
        if (mountedRef.current) setEvIndex(Object.fromEntries(r.list.map((x) => [x.id, x.keys])))
      })
      .catch(() => {})
  }, [])

  // ── 증적 — 마일스톤이 찍히는 순간 서버 원문을 떠 둔다 ─────────────────────
  //
  // 사후에 다시 구할 수 없어서다. k8s 이벤트는 기본 1시간 뒤 사라지고, pacemaker 동작 이력은
  // `pcs resource cleanup` 한 번에 지워지며, masakari 로그는 로테이트된다. 판정에는 쓰지 않는다.

  /** 회차(runT0)에 증적 한 건을 남긴다. 원문·강조 문자열 모두 마스킹 설정을 거친다(강조가 원문과 어긋나지 않게) */
  const saveEvidence = (runT0: number, item: BoardEvidenceItem) => {
    const id = String(runT0)
    const masked: BoardEvidenceItem = {
      ...item,
      text: maskForExport(item.text),
      focus: item.focus?.map((f) => maskForExport(f)),
    }
    window.electronAPI
      .boardEvidenceSave(id, masked)
      .then((r) => {
        if (!r.ok) {
          console.warn('[상태보드] 증적 저장 실패', r.error)
          return
        }
        if (mountedRef.current)
          setEvIndex((cur) => ({ ...cur, [id]: Array.from(new Set([...(cur[id] ?? []), item.key])) }))
      })
      .catch((e) => console.warn('[상태보드] 증적 저장 실패', e))
  }
  /** 이력에서 빠진 회차의 증적 파일을 지운다 */
  const dropEvidence = (ids: string[]) => {
    if (!ids.length) return
    void window.electronAPI.boardEvidenceDelete(ids).catch(() => {})
    setEvIndex((cur) => {
      const next = { ...cur }
      for (const id of ids) delete next[id]
      return next
    })
  }
  /** 증적에서 얻은 서버 시각을 마일스톤에 붙였으면, 이미 저장된 이력에도 반영한다 */
  const refreshSavedHistory = (runT0: number) => {
    if (t0Ref.current === runT0 && savedRef.current) commitRef.current(closedAtRef.current, true)
  }

  /**
   * 호스트 시계 → PC 시계 보정값. 짧은 date 의 왕복 가운데를 '호스트가 찍은 순간' 으로 본다(masakari 와 같은 방식).
   *  - delta: 호스트 **로컬 표기**(시간대 없음)를 PC 로컬로 읽은 값 → PC 시계  (시간대 차이 + 시계 차이)
   *  - skew : 호스트 **epoch** → PC 시계  (시계 차이만 — 시간대가 붙은 로그 줄에 쓴다)
   * 장애 중에는 같은 연결의 실행 슬롯(4개)을 폴링이 차지해 date 가 줄을 서는데, 그 대기가 왕복에 들어가면
   * 가운데 값이 실제보다 이르게 잡혀 서버 시각이 **이르게** 보인다(검토 지적). 세 번 재고 **왕복이 가장 짧은**
   * 측정을 쓴다(NTP 와 같은 방식). 못 읽으면 null — 그 사실을 증적에 밝힌다.
   */
  const measureClock = async (sid: string): Promise<{ delta: number; skew: number; rtt: number } | null> => {
    let best: { delta: number; skew: number; rtt: number } | null = null
    for (let i = 0; i < 3; i++) {
      const pcBefore = Date.now()
      // 밀리초까지 받는다 — 초 단위로 자르면 보정값이 0~1초 치우쳐 서버 시각이 최대 1초 늦게 찍혔다(검토 지적).
      // %3N 을 모르는 date 면 글자 N 이 남는다 — 그때는 초 단위로 읽는다
      const d = await run(sid, `date '+%s%3N %Y-%m-%dT%H:%M:%S.%3N'`, 10_000)
      const pcAfter = Date.now()
      const pcMid = (pcBefore + pcAfter) / 2
      const [ep, loc] = (d.ok ? d.out ?? '' : '').trim().split('\n')[0].split(/\s+/)
      const epochMs = /^\d{13}$/.test(ep ?? '') ? parseInt(ep, 10) : parseInt((ep ?? '').replace(/\D.*$/, ''), 10) * 1000
      const epoch = epochMs / 1000
      const hostLocal = loc ? Date.parse(loc.replace(/\.[^\d].*$/, '').replace(/\.$/, '')) : NaN
      if (Number.isNaN(epoch) || Number.isNaN(hostLocal)) continue
      const m = { delta: hostLocal - pcMid, skew: epoch * 1000 - pcMid, rtt: pcAfter - pcBefore }
      if (!best || m.rtt < best.rtt) best = m
      if (m.rtt < 300) break // 충분히 짧다 — 더 잴 필요 없다
    }
    return best
  }
  /**
   * 로그 줄 앞머리 시각 → PC 시계 epoch.
   * 시간대가 붙은 표기(journalctl short-iso · ceph 로그)도 **호스트 시계 차이(skew)** 는 빼야 다른 증적과 같은 기준이 된다
   * (CLAUDE.md: 원격 시각은 호스트 시계 오차를 빼서 맞춘다). 보정값이 없으면 시간대 붙은 줄만 그대로 쓴다.
   */
  const logLineAt = (line: string, clock: { delta: number; skew: number } | null): number | null => {
    const t = parseLogTime(line)
    if (!t) return null
    if (t.tz) return clock ? t.ms - clock.skew : t.ms
    return clock == null ? null : t.ms - clock.delta
  }
  /**
   * 증적 수집은 **세션마다 한 번에 하나씩** 돈다. 장애 순간에는 DOWN·VIP·역할 증적이 같은 pcs 노드로 몰리고,
   * 각 명령이 연결의 실행 슬롯(4개)을 오래 쥐면 그 노드의 pcs·ceph·서비스 폴링이 밀려 '확인 불가'·늦은 확정이
   * 됐다(검토 지적). 줄을 세우면 폴링이 쓸 슬롯이 남는다.
   */
  const captureChainRef = useRef<Record<string, Promise<unknown>>>({})
  const inSeq = (sid: string, fn: () => Promise<unknown>) => {
    const prev = captureChainRef.current[sid] ?? Promise.resolve()
    const next = prev.then(fn, fn).catch((e) => console.warn('[상태보드] 증적 수집 실패', e))
    captureChainRef.current[sid] = next
    return next
  }

  const readCrm = async (srcId: string) => {
    // 시각은 crm_mon 과 **따로** 짧은 date 한 번으로 잰다. 처음엔 crm_mon 뒤에 date 를 붙이고 왕복 전체의
    // 가운데를 썼는데, 장애 중 crm_mon 은 몇 초씩 걸려(sudo -n 실패면 두 번 돈다) 보정값이 그 절반만큼
    // 틀어졌다 — pacemaker 시각이 실제보다 **이르게** 보이는 쪽이라 증적으로 쓸 수 없다.
    const clock = await measureClock(srcId)
    const delta = clock ? clock.delta : null
    const r = await run(srcId, sudoOr('crm_mon -1 -t'), 20_000)
    const body = (r.out ?? '').trim()
    const ops = parseCrmOps(body)
    const abs = (raw: string) => {
      const t = parseCtimeLocal(raw)
      return t == null || delta == null ? null : t - delta
    }
    return { ok: r.ok && !r.timedOut && ops.length > 0, body, ops, abs, delta }
  }

  /**
   * VIP·리소스 그룹·DC 이동의 증적 — pacemaker 의 동작 이력에서 **새 노드의 start 시각**을 뽑는다.
   * VIP 는 이동이 '보인' 직후라도 start 기록이 아직 안 올라왔을 수 있어 5초 간격으로 두 번까지 다시 읽는다.
   */
  const captureMove = async (
    runT0: number,
    opt: {
      key: string
      title: string
      srcId: string
      before: string
      after: string
      targets: { resources: string[]; to: string; label: string }[]
      vip?: boolean
    },
    attempt = 0,
  ): Promise<void> => {
    const crm = await readCrm(opt.srcId)
    const facts: { label: string; at?: number; text?: string }[] = []
    const focus: string[] = []
    let vipAt: number | null = null
    /** start 기록이 아직 안 올라온 리소스 — VIP 와 같은 그룹은 몇 초 늦게 뜬다(haproxy 는 int_vip 3초 뒤) */
    const missing: string[] = []
    for (const tg of opt.targets) {
      facts.push({ label: tg.label, text: '툴이 이동을 감지한 순간' })
      const want = new Set(tg.resources.map((x) => x.toLowerCase()))
      for (const o of crm.ops) {
        if (o.node.toLowerCase() !== tg.to.toLowerCase() || !want.has(o.resource.toLowerCase())) continue
        if (!/^(start|promote)$/.test(o.op) || o.rc !== 0) continue
        const at = crm.abs(o.raw)
        // 검증 전의 기록(지난 이동)은 증적이 아니다 — 1분 여유는 호스트 시계 오차 몫
        if (at == null || at < runT0 - 60_000) continue
        facts.push({ label: `pacemaker 기록 · ${o.resource} ${o.op} — ${o.node}`, at })
        focus.push(`last-rc-change="${o.raw}"`)
        if (/int_vip/i.test(o.resource)) vipAt = vipAt == null ? at : Math.min(vipAt, at)
      }
      for (const name of tg.resources)
        if (!facts.some((f) => f.label.startsWith(`pacemaker 기록 · ${name} `))) missing.push(name)
      focus.push(`Started ${tg.to}`)
    }
    if (missing.length && attempt < 2 && t0Ref.current === runT0) {
      setTimeout(() => void inSeq(opt.srcId, () => captureMove(runT0, opt, attempt + 1)), 5_000)
      return
    }
    if (opt.vip && vipAt != null && t0Ref.current === runT0 && msRef.current.vip) {
      msRef.current.vip.pcmkAt = vipAt
      refreshSavedHistory(runT0)
    }
    saveEvidence(runT0, {
      key: opt.key,
      title: opt.title,
      capturedAt: Date.now(),
      host: nameOf(opt.srcId),
      command: 'crm_mon -1 -t  ·  pcs status (상태보드 폴링)',
      verifyCmd: opt.targets.length
        ? `crm_mon -1 -t   # Operations > Node: ${opt.targets[0].to} > ${opt.targets[0].resources[0]} > start 의 last-rc-change`
        : 'pcs status --full   # Current DC 줄',
      text: [
        `# crm_mon -1 -t  (${nameOf(opt.srcId)})`,
        crm.body || '(읽지 못함)',
        '',
        '# 이동 직전 pcs status',
        opt.before.trim() || '(없음 — 검증 첫 조회에서 바로 바뀌었습니다)',
        '',
        '# 이동을 감지한 pcs status',
        opt.after.trim(),
      ].join('\n'),
      focus,
      facts,
      note: !crm.ok
        ? 'crm_mon 동작 이력을 읽지 못했습니다 — pcs status 원문만 남깁니다.'
        : crm.delta == null
          ? '호스트 시각을 읽지 못해 pacemaker 시각을 PC 시계로 보정하지 못했습니다.'
          : 'pacemaker 시각은 호스트 시계 표기를 PC 시계로 보정한 값입니다(1초 단위). 동작 이력은 pcs resource cleanup 으로 지워집니다.',
    })
  }

  /**
   * 노드 DOWN 의 근거 — 살아 있는 노드의 corosync·pacemaker 저널. 막(membership)에서 빠진 순간이
   * 서버 쪽 기록으로 남는다. `-o short-iso` 라 시각에 시간대가 붙어 그대로 절대시각이다.
   */
  const captureDown = async (runT0: number, srcId: string, node: string, pcsSnap: string) => {
    const since = Math.floor((runT0 - 60_000) / 1000)
    const safeNode = node.replace(/[^\w.-]/g, '')
    const pat = `lost|left|down|offline|unclean|failed|quorum|membership|members|fenc${safeNode ? `|${safeNode}` : ''}`
    /**
     * corosync 는 노드를 **이름이 아니라 번호**로 적는다 — 실제 저널(2026-10-22 contrabass):
     *   `2026-10-20T18:03:45+0900 contrabass01 corosync[56612]: [KNET  ] link: host: 3 link: 0 is down`
     * 처음엔 노드 이름이 든 줄만 찾아서 이탈 시각을 하나도 못 잡았다. `crm_node -l`(번호 이름 상태)로
     * 번호를 얻어 `host: <번호>` · `left…: <번호>` 도 그 노드의 줄로 본다.
     */
    const r = await run(
      srcId,
      `{ ${sudoOr('crm_node -l')}; }; echo '__QT_SPLIT__'; { ${sudoOr(`journalctl -u corosync -u pacemaker --since @${since} --no-pager -o short-iso`)}; } | grep -iE "${pat}" | head -n 400`,
      20_000,
    )
    const [nodeList, journal = ''] = (r.ok ? r.out ?? '' : '').split('__QT_SPLIT__')
    const short = safeNode.toLowerCase().split('.')[0]
    const nodeId = nodeList
      .split('\n')
      .map((l) => l.trim().match(/^(\d+)\s+(\S+)/))
      .find((m) => m && m[2].toLowerCase().split('.')[0] === short)?.[1]
    const lines = journal.split('\n').filter((l) => l.trim())
    const clock = await measureClock(srcId)
    const esc = safeNode.replace(/[.]/g, '\\.')
    // 이탈 '첫 줄' 이 필요하므로 앞에서부터 자른다(head) — 예전엔 tail 이라 줄이 많으면 첫 줄이 잘려 서버 시각이 늦게 찍혔다.
    // 노드 이름을 못 얻었으면(빈 이름) 이름 조건을 넣지 않는다 — `\b\b` 는 모든 줄에 맞는다
    const idPart = nodeId ? `host:\\s*${nodeId}\\b|left[^:\\n]*:[\\s\\d]*\\b${nodeId}\\b` : ''
    const namePart = esc ? `\\b${esc}\\b` : ''
    const nodeRe = new RegExp([idPart, namePart].filter(Boolean).join('|') || '(?!)', 'i')
    const first = lines.find((l) => {
      const at = logLineAt(l, clock)
      // 링크 down 은 순간 네트워크 흔들림에도 남는다(위 예의 10-20 줄들) — 이 회차 시작 뒤의 그 노드 줄만
      return at != null && at >= runT0 && nodeRe.test(l) && /lost|left|down|offline|unclean|failed/i.test(l)
    })
    const srvAt = first ? logLineAt(first, clock) : null
    if (srvAt != null && t0Ref.current === runT0 && msRef.current.down && msRef.current.down.source !== 'pre') {
      msRef.current.down.srvAt = srvAt
      refreshSavedHistory(runT0)
    }
    saveEvidence(runT0, {
      key: 'down',
      title: `호스트 DOWN — ${node}`,
      capturedAt: Date.now(),
      host: nameOf(srcId),
      command: `journalctl -u corosync -u pacemaker --since @${since} -o short-iso | grep …  ·  pcs status`,
      verifyCmd: `journalctl -u corosync -u pacemaker --since "${fmtDateTime(runT0 - 60_000)}" | grep -i ${node}`,
      text: [
        `# crm_node -l (노드 번호 — corosync 저널은 번호로 적는다${nodeId ? ` · ${node} = ${nodeId}` : ''})`,
        nodeList.trim() || '(읽지 못함)',
        '',
        `# corosync · pacemaker 저널 (${nameOf(srcId)})`,
        lines.join('\n').trim() || '(해당 줄 없음 — 권한·저널 보관 설정을 확인하세요)',
        '',
        '# DOWN 을 감지한 pcs status',
        pcsSnap.trim(),
      ].join('\n'),
      focus: [first ?? '', ...(nodeId ? [`host: ${nodeId} `] : []), `OFFLINE`, node].filter(Boolean),
      facts: [
        { label: '툴이 DOWN 을 감지 (pcs OFFLINE)', text: '타임라인 시각' },
        ...(srvAt != null ? [{ label: `저널 기록 · ${node} 이탈 첫 줄`, at: srvAt }] : []),
      ],
      note: '살아 있는 노드의 저널입니다. 강조된 첫 줄이 클러스터가 노드를 잃었다고 남긴 시각입니다.',
    })
  }

  /** 재연결의 근거 — 그 노드가 실제로 재부팅됐는지, 언제 부팅됐는지 */
  const captureReconnect = async (runT0: number, id: string) => {
    const clock = await measureClock(id)
    const r = await run(
      id,
      `uptime -s 2>/dev/null; echo '---'; who -b 2>/dev/null; echo '---'; journalctl --list-boots --no-pager 2>/dev/null | tail -n 3`,
      15_000,
    )
    const out = (r.out ?? '').trim()
    const bootLine = out.split('\n')[0] ?? ''
    const bootAt = logLineAt(bootLine.replace(' ', 'T'), clock)
    // 이 회차 안의 부팅이어야 재부팅의 증거다(1분은 시계 오차 여유)
    const inRun = bootAt != null && bootAt >= runT0 - 60_000
    // 그사이 대상 노드의 재연결로 마일스톤이 바뀌었으면 다른 노드의 부팅 시각을 붙이지 않는다
    if (inRun && t0Ref.current === runT0 && msRef.current.reconnect?.node === svcShortName(nameOf(id))) {
      msRef.current.reconnect.bootAt = bootAt as number
      refreshSavedHistory(runT0)
    }
    saveEvidence(runT0, {
      key: 'reconnect',
      title: `세션 재연결 — ${svcShortName(nameOf(id))}`,
      capturedAt: Date.now(),
      host: nameOf(id),
      command: 'uptime -s  ·  who -b  ·  journalctl --list-boots',
      verifyCmd: 'uptime -s; journalctl --list-boots | tail -3',
      text: out || '(읽지 못함)',
      focus: [bootLine].filter(Boolean),
      facts: [
        { label: '툴이 SSH 재연결', text: '타임라인 시각' },
        bootAt != null
          ? { label: inRun ? '부팅 시각 (uptime -s, PC 시계로 보정)' : '부팅 시각 — 이 회차 전 (재부팅 아님)', at: bootAt }
          : { label: '부팅 시각', text: '읽지 못함' },
      ],
      note: inRun ? undefined : '부팅 시각이 검증 시작보다 이릅니다 — 이 재연결은 재부팅이 아니라 네트워크 단절 뒤 복구일 수 있습니다.',
    })
  }

  /**
   * Ceph 복구의 근거 — 모니터가 남긴 클러스터 로그(`ceph log last`). 'Health check cleared: PG_DEGRADED' ·
   * 'Cluster is now healthy' 처럼 Ceph 자신이 상태가 바뀐 순간을 적는다.
   */
  const captureCeph = async (runT0: number, sid: string, which: 'ceph' | 'cephHealthy') => {
    // 한꺼번에 돌리면 같은 노드의 ceph -s 폴링이 밀려 다음 확정이 늦어진다 — 하나씩
    const clock = await measureClock(sid)
    const lg = await run(sid, sudoOr('ceph log last 1000'), 20_000)
    const st = await run(sid, `${sudoOr('ceph -s')}; echo; ${sudoOr('ceph health detail')}`, 20_000)
    const lines = (lg.ok ? lg.out ?? '' : '').split('\n')
    const want =
      which === 'ceph'
        ? /Health check cleared: (PG_DEGRADED|OBJECT_DEGRADED|OBJECT_MISPLACED|PG_AVAILABILITY|OSD_DOWN|OSD_HOST_DOWN)/i
        : /Cluster is now healthy|overall HEALTH_OK/i
    const hits = lines
      .map((l) => ({ l, at: logLineAt(l, clock) }))
      .filter((x) => x.at != null && (x.at as number) >= runT0 && want.test(x.l))
    const last = hits[hits.length - 1]
    if (last && t0Ref.current === runT0) {
      const m = which === 'ceph' ? msRef.current.ceph : msRef.current.cephHealthy
      if (m) {
        m.srvAt = last.at as number
        refreshSavedHistory(runT0)
      }
    }
    saveEvidence(runT0, {
      key: which,
      title: which === 'ceph' ? 'Ceph 데이터 복구 완료 — 클러스터 로그' : 'Ceph HEALTH_OK — 클러스터 로그',
      capturedAt: Date.now(),
      host: nameOf(sid),
      command: 'ceph log last 1000  ·  ceph -s',
      verifyCmd: which === 'ceph' ? 'ceph log last 1000 | grep -i "health check cleared"' : 'ceph log last 1000 | grep -i "now healthy"',
      text: [
        '# ceph log last 1000',
        lines.join('\n').trim() ||
          (lg.ok && !lg.timedOut
            ? '(비어 있음 — 이 클러스터는 모니터 클러스터 로그를 남기지 않습니다. 아래 상태 원문이 근거입니다)'
            : `(읽지 못함${lg.timedOut ? ' — 시간 초과' : ''})`),
        '',
        '# ceph -s · ceph health detail (완료를 확정한 직후)',
        (st.out ?? '').trim(),
      ].join('\n'),
      focus: [last?.l ?? '', ...hits.map((h) => h.l)].filter(Boolean),
      facts: [
        { label: `툴이 ${which === 'ceph' ? 'degraded·misplaced 0' : 'HEALTH_OK'} 를 연속 2회 확인`, text: '타임라인 시각' },
        ...hits.map((h) => ({ label: `Ceph 기록 · ${h.l.replace(/^.*?cluster \[\w+\]\s*/i, '').slice(0, 80)}`, at: h.at as number })),
      ],
      note: hits.length
        ? 'Ceph 모니터의 클러스터 로그입니다. 시간대가 없는 표기는 그 서버 시계를 PC 시계로 보정했습니다.'
        : '클러스터 로그에서 해당 기록을 찾지 못해 서버 기록 시각은 없습니다 — 완료를 확정한 순간의 ceph -s · health detail 원문만 남깁니다.',
    })
  }

  /**
   * Masakari 완료 판정의 근거 — 판정에 쓴 engine 로그 + **Nova 의 VM 별 evacuation 기록**.
   *
   * engine 로그는 VM 마다 'evacuate 시작' 만 남기고, 끝은 알림 전체의 'finished' 한 줄이다. 20대를 옮기면
   * 어느 VM 이 언제 끝났는지가 로그에 없다. Nova 는 VM 마다 migration(type=evacuation) 레코드를 남기고
   * 생성(시작) · 마지막 갱신(완료) · 출발/도착 호스트 · 상태를 갖는다 — 그것으로 VM 별 표를 만든다.
   * 로그 원문은 그 VM 들의 UUID 가 든 줄만 남기고, 길면 앞뒤만 둔다(20대면 수백 줄이 된다).
   * VM 이 아직 옮겨지는 중(status 가 끝나지 않음)이면 20초 간격으로 다섯 번까지 다시 읽는다.
   */
  const captureMasakari = async (
    runT0: number,
    id: string,
    raw: string,
    p: { at?: number; evac: number; line?: string },
    logPath: string,
    os: { sid: string; rc: string },
    attempt = 0,
  ): Promise<void> => {
    const mr = os.sid
      ? // --limit 은 compute API 2.59 이상에서만 받는 CLI 가 있어 빼 둔다(회차 필터는 코드가 한다)
        await run(os.sid, `bash -lc '. ${os.rc} 2>/dev/null; openstack server migration list --type evacuation -f json'`, 30_000)
      : null
    // session:run 은 종료코드와 무관하게 ok 다 — JSON 배열로 읽히지 않으면 **조회 실패**다('기록 없음' 이 아니다)
    const parsed = mr && mr.ok && !mr.timedOut ? parseEvacMigrations(mr.out ?? '', runT0 - 60_000) : null
    const vms = parsed ?? []
    const unfinished = vms.filter((v) => !v.done)
    // 한 번의 조회 실패(CLI·인증 순간 오류)로 VM 표를 영영 잃지 않게, 실패도 아직 안 끝난 VM 처럼 다시 묻는다
    if ((unfinished.length || (mr && parsed === null)) && attempt < 5 && t0Ref.current === runT0) {
      setTimeout(() => void inSeq(os.sid, () => captureMasakari(runT0, id, raw, p, logPath, os, attempt + 1)), 20_000)
      return
    }
    // VM 이름 — 표에 UUID 만 있으면 사람이 못 알아본다. 못 읽으면 UUID 앞자리로 둔다.
    const names: Record<string, string> = {}
    if (vms.length && os.sid) {
      const nr = await run(
        os.sid,
        `bash -lc '. ${os.rc} 2>/dev/null; openstack server list --all-projects --limit 2000 -c ID -c Name -f json'`,
        30_000,
      )
      try {
        for (const x of JSON.parse(nr.out ?? '[]') as { ID?: string; Name?: string }[]) if (x.ID) names[x.ID] = x.Name ?? ''
      } catch {
        /* 이름 없이 간다 */
      }
    }
    const vmName = (u: string) => names[u] || u.slice(0, 8)
    const failed = vms.filter((v) => v.failed).length
    if (vms.length && t0Ref.current === runT0 && msRef.current.masakari) {
      msRef.current.masakari.vms = {
        count: vms.length,
        failed,
        firstAt: Math.min(...vms.map((v) => v.createdAt)),
        // 아직 옮기는 중인 VM 의 updatedAt 은 '완료' 가 아니다 — 끝난 VM 만
        lastAt: Math.max(...(vms.some((v) => v.done) ? vms.filter((v) => v.done) : vms).map((v) => v.updatedAt)),
      }
      refreshSavedHistory(runT0)
    }
    const uuid = p.line?.match(new RegExp(`Notification\\s+(${UUID})`, 'i'))?.[1]
    // 로그는 이 VM 들 · 이 알림의 줄만 — 없으면(Nova 를 못 읽음) 판정에 쓴 원문 그대로
    const all = stripAnsi(raw).split('\n')
    const keys = [...vms.map((v) => v.server.toLowerCase()), ...(uuid ? [uuid.toLowerCase()] : [])]
    let logLines = keys.length ? all.filter((l) => keys.some((k) => l.toLowerCase().includes(k))) : all
    const LOG_KEEP = 300
    if (logLines.length > LOG_KEEP * 2)
      logLines = [...logLines.slice(0, LOG_KEEP), `… (${logLines.length - LOG_KEEP * 2}줄 생략 — 서버에서 직접 확인 명령으로 전체를 볼 수 있습니다) …`, ...logLines.slice(-LOG_KEEP)]
    const table = vms.length
      ? ''
      : !mr
        ? '(OpenStack 조회 세션이 없어 Nova 기록을 읽지 않았습니다 — 상태보드 설정의 OpenStack 세션·openrc 를 지정하세요)'
        : parsed
          ? '(이 회차의 evacuation 기록 없음)'
          : `(Nova 기록 조회 실패 — openrc(${os.rc})·openstack CLI 를 확인하세요)\n${((mr.out || mr.err || mr.error || '') + '').trim().slice(0, 400)}`
    saveEvidence(runT0, {
      key: 'masakari',
      title: `Masakari evacuation 완료${vms.length ? ` — VM ${vms.length}대` : ''}`,
      capturedAt: Date.now(),
      host: nameOf(id),
      command: `masakari-engine 로그(tail · grep)  ·  openstack server migration list --type evacuation`,
      verifyCmd: uuid
        ? `grep -n "${uuid}" ${logPath}   ·   openstack server migration list --type evacuation`
        : `openstack server migration list --type evacuation`,
      text: [
        ...(vms.length ? [] : ['# Nova evacuation 기록', table, '']),
        `# masakari-engine 로그 (${nameOf(id)}${keys.length ? ' — 이 VM 들 · 이 알림의 줄만' : ''})`,
        logLines.join('\n').trim(),
      ].join('\n'),
      table: vms.length
        ? {
            title: `Nova evacuation 기록 — VM ${vms.length}대 (시작 순 · 이 PC 시간대)`,
            columns: ['VM', '출발 → 도착', '상태', '시작', '완료', '소요'],
            rows: vms.map((v) => [
              vmName(v.server),
              `${v.src} → ${v.dest}`,
              v.status,
              fmtClock(v.createdAt),
              fmtClock(v.updatedAt),
              fmtElapsed(v.updatedAt - v.createdAt),
            ]),
            bad: vms.map((v) => v.failed || !v.done),
            titles: vms.map((v) => v.server),
          }
        : undefined,
      focus: [p.line ?? '', ...vms.map((v) => v.server)].filter(Boolean),
      facts: [
        { label: 'evacuation 완료 (masakari 로그 시각, PC 시계로 보정)', at: p.at },
        ...(vms.length
          ? [
              { label: `첫 VM 시작 (Nova)`, at: Math.min(...vms.map((v) => v.createdAt)) },
              {
                label: unfinished.length ? `마지막 VM 완료 (Nova · 아직 ${unfinished.length}대 진행 중)` : `마지막 VM 완료 (Nova)`,
                at: Math.max(...(vms.some((v) => v.done) ? vms.filter((v) => v.done) : vms).map((v) => v.updatedAt)),
              },
              { label: 'VM 수 · 실패', text: `${vms.length}대 · 실패 ${failed}` },
            ]
          : [{ label: '대상 인스턴스 (masakari 로그)', text: `${p.evac}대` }]),
        ...(uuid ? [{ label: 'notification id', text: uuid }] : []),
      ],
      note:
        (vms.length
          ? 'VM 별 시각은 Nova migration 레코드(Created = 시작, Updated = 마지막 갱신 ≒ 완료, UTC 를 PC 시간대로 표시)입니다. '
          : '') +
        (unfinished.length ? `조회 시점에 아직 끝나지 않은 VM ${unfinished.length}대가 있었습니다. ` : '') +
        '강조된 줄이 완료 판정 근거입니다.',
    })
  }

  /**
   * 네임스페이스 파드 복구 완료의 근거 — apiserver 가 기록한 생성·시작·Ready 전환 시각과 이벤트.
   * 이벤트는 기본 1시간이면 사라지므로 **완료가 관측된 그 순간** 떠 둔다.
   */
  const capturePods = async (
    runT0: number,
    sid: string,
    ns: string,
    workloads: Set<string>,
    entry: { readyAt?: number },
  ) => {
    const [pj, ev] = await Promise.all([
      run(sid, `kubectl get pods -n ${ns} -o json --request-timeout=10s`, 25_000),
      run(
        sid,
        `kubectl get events -n ${ns} --sort-by=.lastTimestamp --request-timeout=10s -o custom-columns=FIRST:.firstTimestamp,LAST:.lastTimestamp,TYPE:.type,REASON:.reason,KIND:.involvedObject.kind,OBJECT:.involvedObject.name,MESSAGE:.message`,
        25_000,
      ),
    ])
    const facts = podFactsFromJson(pj.ok ? pj.out ?? '' : '')
    const mine = facts.filter((f) => workloads.has(workloadOf(f.name)) && !f.deleting)
    const factRows: { label: string; at?: number; text?: string }[] = []
    let nsReady: number | null = null
    let allReady = workloads.size > 0
    for (const w of workloads) {
      const ready = mine.filter((f) => workloadOf(f.name) === w && f.ready && f.readyAt != null)
      if (!ready.length) {
        allReady = false
        factRows.push({ label: `${w} — Ready 파드 없음`, text: '조회 시점 기준' })
        continue
      }
      // 죽은 노드의 파드가 지워져서 '복구' 된 워크로드는 남은 파드가 며칠째 Ready 다 — 그 시각은 이번 복구의
      // 근거가 아니다(검토 지적). 이 회차에 Ready 가 된 파드만 센다(1분은 시계 오차 여유)
      const fresh = ready.filter((f) => (f.readyAt as number) >= runT0 - 60_000)
      if (!fresh.length) {
        factRows.push({ label: `${w} — 이 회차에 새로 Ready 된 파드 없음 (기존 파드가 계속 Ready)`, text: '-' })
        continue
      }
      const at = Math.max(...fresh.map((f) => f.readyAt as number))
      nsReady = nsReady == null ? at : Math.max(nsReady, at)
      factRows.push({ label: `클러스터 기록 · ${w} Ready`, at })
    }
    if (allReady && nsReady != null && t0Ref.current === runT0) {
      entry.readyAt = nsReady
      refreshSavedHistory(runT0)
    }
    const fmt = (t: number | null) => (t == null ? '-' : fmtDateTime(t))
    const table = facts.length
      ? [
          'NAME\tNODE\tCREATED\tSTARTED\tREADY(전환)\tRESTARTS',
          ...facts.map(
            (f) =>
              `${f.name}\t${f.node || '-'}\t${fmt(f.createdAt)}\t${fmt(f.startedAt)}\t${f.ready ? fmt(f.readyAt) : `아님(${fmt(f.readyAt)})`}\t${f.restarts}`,
          ),
        ].join('\n')
      : `(파드 JSON 을 읽지 못함${pj.timedOut ? ' — 시간 초과' : ''})`
    saveEvidence(runT0, {
      key: `pods:${ns}`,
      title: `${ns} : 파드 복구 완료 — 클러스터 기록`,
      capturedAt: Date.now(),
      host: nameOf(sid),
      command: `kubectl get pods -n ${ns} -o json  ·  kubectl get events -n ${ns} --sort-by=.lastTimestamp`,
      verifyCmd: `kubectl get pods -n ${ns} -o custom-columns=NAME:.metadata.name,CREATED:.metadata.creationTimestamp,READY_AT:'.status.conditions[?(@.type=="Ready")].lastTransitionTime'`,
      text: [
        `# 파드 시각 (kubectl get pods -o json 에서 추출 · 표시는 이 PC 시간대)`,
        table,
        '',
        `# 이벤트 (kubectl get events -n ${ns} · 시각은 이 PC 시간대로 바꿔 표시, 원본은 UTC)`,
        ev.ok ? utcToLocalInText((ev.out ?? '').trim()) || '(이벤트 없음)' : `(이벤트를 읽지 못함${ev.timedOut ? ' — 시간 초과' : ''})`,
      ].join('\n'),
      focus: [...workloads],
      facts: factRows,
      note: '시각은 apiserver(클러스터) 시계 기준입니다. 이벤트는 기본 1시간 뒤 클러스터에서 사라지므로 이 기록이 남는 유일한 사본일 수 있습니다.',
    })
  }

  /**
   * 한 번 폴링 — 6개 그룹을 병렬로 돌리되 **끝나는 그룹부터 즉시 화면에 반영**한다.
   * 예전에는 전부 Promise.all 로 묶어 한 번에 setState 했는데, 노드 DOWN 상태에서
   * `ceph -s` 나 `openstack ... list` 가 수십 초 매달리면 이미 나와 있는 파드 결과까지
   * 그만큼 늦게 그려져 "파드 상태가 느리게 바뀐다"는 증상이 됐다.
   */
  const pollOnce = async () => {
    const c = cfgRef.current
    // 같은 세션을 여러 역할 슬롯에 지정했을 때 중복 명령/중복 카운트/React key 충돌을 막으려 중복 제거
    // cfg 의 세션 칸에는 '아직 안 연 서버의 프로필 키'가 그대로 남아 있을 수 있다(복원 대기 상태).
    // 그걸 걸러내지 않으면 그 키가 호스트 이름인 척 카드로 그려지고("10.255.233.23:22:root"),
    // 세션이 없으니 항상 DOWN 으로 찍혀 죽지도 않은 노드가 장애처럼 보인다.
    const isLive = (id: string) => sessionsRef.current.some((s) => s.id === id)
    const mappedHosts = Array.from(new Set(c.hosts.filter(Boolean)))
    const hostIds = mappedHosts.filter(isLive)
    const pendingHosts = mappedHosts.length - hostIds.length
    const masaIds = Array.from(new Set(c.masakari.filter(Boolean))).filter(isLive)
    // VIP/노드상태 판정용 후보 — 연결된 host 를 순서대로 모아둔다.
    // 하나만 쓰면 안 된다: 첫 후보가 하필 지금 죽인 노드면 SSH 가 끊긴 걸 알아채기까지
    // 수십 초 동안 pcs 조회가 매번 타임아웃하고, 그 사이 DOWN/VIP 이동을 못 잡는다.
    // 그 구간이 바로 이 보드로 재보려는 구간이라, 다음 노드로 넘어가며 재시도한다.
    // 직전에 제대로 답한 노드를 맨 앞에 둔다 — 평소에는 1회 조회로 끝나 폴링 주기를 지킨다.
    const live = hostIds.filter((id) => connectedOf(id))
    const last = pcsSourceRef.current
    const ordered = last && live.includes(last) ? [last, ...live.filter((id) => id !== last)] : live
    // 최대 2곳까지만 — 전부 pcs 가 없는 환경에서 매 폴링마다 전 노드를 훑으면 주기(기본 5초)를 넘긴다.
    const pcsCandidates = ordered.slice(0, 2)
    const delayed = new Set<string>()

    // 그룹 하나가 끝날 때마다 부분 갱신. 언마운트/중지 후에는 낡은 값으로 덮어쓰지 않는다.
    const patch = (p: Partial<BoardState>) => {
      if (!mountedRef.current || !runningRef.current) return
      setState((prev) => ({
        ...(prev ?? {
          hosts: [], vipNode: '', delayed: [], pendingHosts: 0, ready: false, masakari: [], ceph: null, pods: [],
          podScope: c.podScope, serviceUnits: [], roles: null, services: [], openstack: null,
          osScope: c.osScope, tzNote: '', lastAt: 0, notReadyNodes: [], updatedAt: {}, jobErrors: {},
        }),
        ...p,
        delayed: Array.from(delayed),
        lastAt: Date.now(),
        updatedAt: { ...updatedAtRef.current },
        jobErrors: { ...jobErrorsRef.current },
      }))
    }
    /**
     * 그룹(잡) 하나를 감싸 **끝난 시각과 예외를 남긴다.**
     *
     * 예전에는 여섯 잡을 그냥 `Promise.all` 에 넣었다. 그러면 한 잡이 예외를 던지는 순간
     * 그 잡의 patch 는 매 주기 조용히 건너뛰어지고, **화면에는 마지막으로 성공한 값이 계속
     * 남는다.** 다른 섹션은 정상적으로 갱신되니 화면만 보고는 알아챌 수 없다 — 실제로 파드
     * 섹션이 페일오버 당시 값(Terminating·Pending)에 멈춰 있는데 Ceph·포털은 멀쩡한 일이 있었다.
     *
     * 그래서 잡마다 마지막으로 끝난 시각(updatedAt)과 예외 문구(jobErrors)를 남긴다.
     * 갱신이 멈추면 화면 위쪽에 '갱신 멈춤' 경고가 뜨고, 파드 섹션 제목에 경과가 붙는다.
     */
    const guard = (key: string, fn: () => Promise<unknown>) =>
      fn().then(
        (res) => {
          // 직전 값을 유지만 한 프레임은 '갱신' 이 아니다 — 끝난 시각을 올리면 '갱신 멈춤' 경고가 영영 안 뜬다
          if (res !== STALE_FRAME) updatedAtRef.current[key] = Date.now()
          delete jobErrorsRef.current[key]
          patch({})
        },
        (e: unknown) => {
          // 예외를 삼키지 않는다 — 화면에 남기고 콘솔에도 남긴다(원인 추적용)
          jobErrorsRef.current[key] = e instanceof Error ? e.message : String(e)
          console.error(`[상태보드] ${key} 조회 중 예외`, e)
          patch({})
        },
      )



    // 각 host 의 실제 hostname 을 (아직 없으면) 한 번만 조회해 pcs 노드명 매칭에 사용
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
        /**
         * delta 는 **호스트 로컬 표기 → 이 PC 의 시계** 로 바꾸는 값이다. 예전에는 `localMs - epoch*1000`
         * 이었는데, 두 값이 모두 **호스트 시계**에서 나와 시간대 차이만 잡히고 호스트와 PC 의 시계 차이는
         * 그대로 남았다(주석은 '상쇄된다' 고 잘못 적고 있었다). 호스트가 PC 보다 40초 늦으면 evacuation 완료가
         * 40초 이르게 찍히고 t0 뒤 40초의 로그가 걸러졌다 — NTP 가 안 맞는 폐쇄망 랩에서 흔하다.
         * 요청 직전·직후 PC 시각의 가운데를 '호스트가 date 를 찍은 순간' 으로 보고 그 PC 시각과 견준다
         * (오차는 왕복 지연의 절반 이내).
         */
        const pcBefore = Date.now()
        const r = await run(id, `date '+%s %Y-%m-%dT%H:%M:%S'`)
        const pcMid = (pcBefore + Date.now()) / 2
        const parts = (r.ok ? r.out ?? '' : '').trim().split(/\s+/)
        const epoch = parseInt(parts[0], 10)
        const localMs = parts[1] ? Date.parse(parts[1]) : NaN
        if (!Number.isNaN(epoch) && !Number.isNaN(localMs)) {
          calibRef.current[id] = { delta: localMs - pcMid, ok: true }
        } else {
          calibRef.current[id] = { delta: 0, ok: false }
        }
      }),
    )

    const namespaces = c.namespaces.filter(Boolean)
    const svcUnits = cleanUnits(c.services)

    // ── 1) Host: pcs status → 노드 Online/OFFLINE + VIP 위치 ────────────────
    const hostJob = async () => {
      /**
       * 이 프레임의 기준 시각 — **pcs 를 묻기 직전**. DOWN 은 이 시각으로 찍는다.
       * 예전엔 pcs 응답을 받은 뒤의 시각을 썼고, 후보를 차례로 물어 죽인 노드가 첫 후보면 12초 타임아웃을 다 기다렸다.
       * 그만큼 DOWN 이 늦게 찍혀 'DOWN 부터의 복구 시간' 이 **짧게(유리하게)** 나왔다(검토 지적).
       */
      const frameAt = Date.now()
      let pcsOut = ''
      /**
       * 노드 목록을 실제로 읽어낸 첫 응답을 쓴다. 직전에 답한 노드를 먼저 묻고, **2초 안에 못 받으면 다음 후보에도 함께**
       * 묻는다(먼저 온 유효 응답 채택). 둘을 늘 같이 물으면 평소 pcs 조회가 두 배가 되고, 차례로만 물으면 죽은 첫 후보의
       * 타임아웃(12초)을 다 기다린다. 죽어가는 노드는 타임아웃하거나 빈/부분 출력만 주므로 그걸로 판정하지 않는다.
       */
      pcsOut = await new Promise<string>((resolve) => {
        let settled = false
        let fallback = ''
        let started = 0
        let finished = 0
        const ask = (id: string) => {
          started++
          void run(id, sudoOr('pcs status')).then((r) => {
            finished++
            if (settled) return
            if (r.timedOut) delayed.add('Host(pcs)')
            const out = r.ok ? (r.out ?? '') : ''
            const n = parsePcsNodes(out)
            const readable = n.online.length > 0 || n.offline.length > 0
            /**
             * 쿼럼 없는 파티션의 답은 채택하지 않는다 — 네트워크 격리 시험에서 떨어져 나간 노드는 **나머지를 OFFLINE** 으로
             * 답한다. 그 답이 먼저 오면 멀쩡한 두 노드가 DOWN 으로 찍히고, 그 노드가 다음 폴링의 첫 후보로 굳었다(검토 지적).
             * 다른 후보의 답을 기다리고, 끝내 그것뿐이면 대체값으로만 쓴다(아래 호스트 판정에서 OFFLINE 을 믿지 않는다).
             */
            if (readable && !/partition WITHOUT quorum/i.test(out)) {
              settled = true
              pcsSourceRef.current = id // 다음 폴링부터 이 노드를 먼저 물어본다
              resolve(out)
              return
            }
            // 아무데서도 못 읽으면 마지막 응답이라도 남긴다 — 노드 목록을 읽을 수 있는 답(쿼럼 없는 쪽)을 빈 답보다 앞세운다
            if (!fallback || (readable && !parsePcsNodes(fallback).online.length && !parsePcsNodes(fallback).offline.length)) fallback = out
            // 이 후보가 실패했으면 아직 안 물은 다음 후보를 바로 묻는다
            if (started < pcsCandidates.length) ask(pcsCandidates[started])
            else if (finished >= started) {
              settled = true
              resolve(fallback)
            }
          })
        }
        if (!pcsCandidates.length) return resolve('')
        ask(pcsCandidates[0])
        setTimeout(() => {
          if (!settled && started < pcsCandidates.length) ask(pcsCandidates[started])
        }, 2000)
      })
      /**
       * 쿼럼이 없는 파티션의 시각은 믿지 않는다 — 네트워크 격리 시험에서 떨어져 나간 노드가 pcs 원천이면 자기 쪽에서
       * 리소스가 Started 라고 답해(no-quorum-policy=ignore 등) 가짜 VIP·역할 이동이 찍혔다(검토 지적). DC 와 같은 기준.
       * 호스트 판정도 같다 — 그 답의 OFFLINE 은 '내가 남들과 끊겼다' 는 뜻이지 남들이 죽었다는 뜻이 아니다.
       * 그래서 노드 목록 자체를 '이번 프레임 pcs 무응답' 으로 다룬다(직전 판정 유지 · SSH 판정).
       */
      const noQuorum = /partition WITHOUT quorum/i.test(pcsOut)
      // VIP 위치도 그쪽 시각이라 화면에 'VIP 여기' 로 그리지 않는다(모름)
      const vipNode = noQuorum ? '' : parseVipNode(pcsOut)
      const pcs = noQuorum ? { online: [] as string[], offline: [] as string[] } : parsePcsNodes(pcsOut)
      const now = Date.now()

      const hosts: HostStat[] = hostIds.map((id) => {
        const nm = nameOf(id)
        const hn = hostnamesRef.current[id]
        const sshUp = connectedOf(id)
        const pcsOffline = pcs.offline.length > 0 && pcsHas(pcs.offline, nm, hn)
        const pcsOnline = pcs.online.length > 0 && pcsHas(pcs.online, nm, hn)
        if (pcsOnline) pcsSeenOnlineRef.current.add(id)
        // pcs 의 OFFLINE 은 '이 검증 중에 Online 이었다가 빠진 노드'일 때만 전원 다운으로 신뢰한다.
        // pacemaker 가 아직 안 떴거나 pcs 조회가 실패한 순간의 OFFLINE 을 그대로 믿으면,
        // SSH 는 멀쩡히 붙어 있는데 DOWN 으로 잘못 표시된다.
        const trustedOffline = pcsOffline && pcsSeenOnlineRef.current.has(id)
        /**
         * pcs 가 **이번 프레임에 답하지 않았으면** 직전 pcs 판정을 유지한다(조회 실패 ≠ 상태 변화).
         * 예전에는 pcs 조회가 타임아웃하면 SSH 연결 여부로 떨어졌다. 노드를 죽인 직후 keepalive 가 끊김을
         * 알아채기 전(최대 90초)에는 SSH 가 아직 붙어 있다고 나오므로, OFFLINE 으로 확정됐던 노드가 그
         * 프레임에 **초록 UP** 으로 그려지고 DOWN 시각이 지워졌다 — 다른 섹션이 만족된 경우 '복구 완료'
         * 알림까지 한 번 나갈 수 있었다.
         */
        const pcsAnswered = pcs.online.length + pcs.offline.length > 0
        if (pcsAnswered) {
          if (trustedOffline) pcsDownRef.current.set(id, { at: now, sshDropped: !sshUp })
          if (trustedOffline) pcsSawOfflineRef.current.add(id)
          // 클러스터 재합류 — OFFLINE 이었던 노드를 pcs 가 다시 Online 으로 본 첫 순간
          if (pcsOnline && pcsSawOfflineRef.current.has(id)) {
            pcsSawOfflineRef.current.delete(id)
            ;(msRef.current.rejoin ??= []).push({ at: now, node: svcShortName(nm) })
          }
          // 재합류 프레임에도 지운다 — 예전엔 위 분기와 else 로 묶여 남았고, 바로 다음 pcs 무응답 프레임에 그 낡은
          // OFFLINE 이 '유지' 되어 돌아온 노드가 다시 DOWN 으로 그려졌다(검토 지적)
          if (pcsOnline) pcsDownRef.current.delete(id)
        }
        /**
         * 단, 유지는 **SSH 가 끊김을 알아채기 전의 틈만** 덮는다. 처음엔 pcs 가 다시 답할 때까지 무조건
         * 유지했는데, 컨트롤러를 여러 대 함께 내리고 pacemaker 가 부팅 때 자동으로 안 뜨는 환경에서는 pcs 가
         * 끝내 답하지 않아 SSH 가 다시 붙은 노드가 검증 끝까지 DOWN 이었다(노드 복구 시각이 안 찍힘).
         * 그래서 ① 유지 중 SSH 가 한 번 끊겼다가 다시 붙었으면 — 재부팅을 실제로 본 것이므로 — 풀고,
         * ② 마지막 pcs OFFLINE 확인 뒤 keepalive 한도(15초×6)를 넉넉히 넘겼는데도 SSH 가 붙어 있으면 풀어
         * SSH 판정으로 돌아간다.
         */
        const held = pcsDownRef.current.get(id)
        if (!pcsAnswered && held) {
          if (!sshUp) held.sshDropped = true
          else if (held.sshDropped || now - held.at > PCS_HOLD_MAX_MS) pcsDownRef.current.delete(id)
        }
        const heldOffline = !pcsAnswered && pcsDownRef.current.has(id)
        const up = trustedOffline || heldOffline ? false : pcsOnline ? true : sshUp
        if (up) {
          seenUpRef.current.add(id)
          delete downAtRef.current[id]
        } else if (!downAtRef.current[id]) {
          // 최초 인지 시점만 기록 — 이후 폴링에서 덮어쓰지 않는다.
          // 단, 이 검증 중 한 번도 UP 인 걸 못 봤다면 '검증 시작 전부터 이미 죽어 있던' 노드다.
          // 이때 지금 시각을 DOWN 시각이라고 적으면 타임라인에 가짜 시각이 박히므로 따로 구분한다.
          const everUp = seenUpRef.current.has(id)
          downAtRef.current[id] = everUp
            ? { at: frameAt, source: trustedOffline ? 'pcs' : 'ssh' }
            : { at: t0Ref.current, source: 'pre' }
          wasDownRef.current.add(id)
        }
        const d = downAtRef.current[id]
        return {
          id,
          name: nm,
          up,
          vip: up && matchesVip(vipNode, nm, hn),
          downAt: d?.at,
          downSource: d?.source,
          probe: up ? undefined : probeRef.current.state[id],
        }
      })

      // 마일스톤: 노드 DOWN.
      // '검증 시작 전부터 죽어 있던 노드'(source='pre')는 이번 회차에 죽인 노드가 아니므로
      // 실제로 감지된 DOWN 이 하나라도 생기면 그쪽으로 교체한다.
      // (예: com01 이 이미 OFFLINE 인 상태에서 con01 을 죽였다면 타임라인 주인공은 con01)
      const downs = hosts.filter((h) => !h.up && typeof h.downAt === 'number')
      const real = downs
        .filter((h) => h.downSource === 'pcs' || h.downSource === 'ssh')
        .sort((a, b) => (a.downAt ?? 0) - (b.downAt ?? 0))[0]
      const cur = msRef.current.down
      if (real) {
        if (!cur || cur.source === 'pre') {
          msRef.current.down = {
            at: real.downAt as number,
            node: svcShortName(real.name),
            source: real.downSource === 'pcs' ? 'pcs' : 'ssh',
          }
          // 살아 있는 pcs 노드의 저널에서 이탈 기록을 뜬다(죽은 노드 자신은 물어볼 수 없다)
          const evSrc = pcsSourceRef.current && pcsSourceRef.current !== real.id ? pcsSourceRef.current : ''
          if (evSrc)
            void inSeq(evSrc, () => captureDown(t0Ref.current, evSrc, hostnamesRef.current[real.id] || svcShortName(real.name), pcsOut))
        }
      } else if (!cur) {
        const pre = downs.find((h) => h.downSource === 'pre')
        if (pre) msRef.current.down = { at: pre.downAt as number, node: svcShortName(pre.name), source: 'pre' }
      }
      // 마일스톤: VIP 이동 — 첫 관측값을 기준으로 두고, 다른 노드로 바뀐 순간만 기록한다.
      // (예전에는 vipNode 가 처음 채워지기만 해도 'VIP 확인'으로 찍혀 항상 00:00 이 나왔다)
      //
      // 한 겹 더 — pcs 가 알려준 노드 목록에 **없는** 값으로의 변화는 이동이 아니라 파싱 잡음이다.
      // 파서를 고쳐도 서식이 또 바뀔 수 있으니, '노드 목록에 있는 이름' 이라는 사실로 검증한다.
      const knownNodes = [...pcs.online, ...pcs.offline]
      let vipMoved: { from: string; to: string } | null = null
      const isKnown = (n: string) => knownNodes.some((k) => k.toLowerCase() === n.toLowerCase())
      if (vipNode && !noQuorum && (knownNodes.length === 0 || isKnown(vipNode))) {
        if (!vipSeenRef.current) vipSeenRef.current = vipNode
        else if (vipSeenRef.current !== vipNode && !msRef.current.vip) {
          msRef.current.vip = { at: now, from: vipSeenRef.current, to: vipNode }
          vipMoved = { from: vipSeenRef.current, to: vipNode }
          vipSeenRef.current = vipNode
        }
      }

      /**
       * pacemaker 역할 — 데몬 표의 (m)/(s)·DC.
       *
       * systemd 데몬 자체에는 주/보조가 없다(rabbitmq·memcached·httpd 등은 모든 노드가 같은 일을 한다).
       * 역할이 있는 것은 **pacemaker 가 한 노드에서만 띄우는 리소스**(`systemd:haproxy` 처럼 유닛과 이어진다)와
       * promotable 리소스, 그리고 클러스터 결정을 내리는 DC 다. 이미 받은 pcs status 를 읽을 뿐 명령은 늘지 않는다.
       * 노드 이름은 VIP 와 같이 **pcs 노드 목록에 있는 이름만** 믿는다.
       */
      const srcId = pcsSourceRef.current
      const pcsOk = knownNodes.length > 0
      const idOfPcs = (n: string) => hostIds.find((id) => pcsHas([n], nameOf(id), hostnamesRef.current[id])) ?? ''
      let roles: BoardRoles | null = null
      if (pcsOk) {
        const pr = parsePcsRoles(pcsOut)
        const resources: BoardRoleRes[] = pr.resources.map((r) => {
          const owners = r.owners.filter(isKnown)
          const standbys = r.standbys.filter(isKnown)
          return {
            ...r,
            owners,
            standbys,
            ownerIds: owners.map(idOfPcs).filter(Boolean),
            standbyIds: standbys.map(idOfPcs).filter(Boolean),
          }
        })
        const dc = pr.dc && isKnown(pr.dc) ? pr.dc : ''
        roles = { dc, dcId: dc ? idOfPcs(dc) : '', resources, clusterIds: knownNodes.map(idOfPcs).filter(Boolean) }
        lastRolesRef.current = { v: roles, at: now }

        // 역할 이동 — 처음 본 주 노드에서 다른 노드로 '새로 Started' 된 순간. Stopped·전환 중 프레임은 건너뛴다.
        const changes: { name: string; group?: string; from: string; to: string }[] = []
        const track = (key: string, owner: string, group?: string) => {
          if (!owner) return
          const seen = rolesSeenRef.current[key]
          if (!seen) {
            rolesSeenRef.current[key] = owner
            return
          }
          if (seen === owner) return
          if (!rolesDoneRef.current.has(key)) {
            rolesDoneRef.current.add(key)
            changes.push({ name: key, group, from: seen, to: owner })
          }
          rolesSeenRef.current[key] = owner
        }
        // 네트워크 격리 시험에서 떨어져 나간 노드가 답하면 'Current DC: 자기 자신 … partition WITHOUT quorum' 이다 —
        // 그걸 DC 이동으로 적지 않는다(검토 지적)
        if (!noQuorum) track('DC', dc)
        /**
         * VIP(int_vip)와 **같은 리소스 그룹**은 따로 남기지 않는다. 그룹은 한 몸으로 옮겨 가므로 'VIP 이동' 과
         * '역할 이동 — openstack 그룹' 두 줄이 같은 사건을 두 번 말했다(사용자 지적). VIP 줄 하나에 '함께 옮겨 간
         * 리소스' 로 붙이고, 증적도 VIP 증적에 그 리소스들의 start 시각을 함께 담는다.
         * 그룹 밖 리소스(thanos 등)와 DC 는 VIP 와 따로 움직이므로 지금처럼 역할 이동 줄로 남긴다.
         */
        const vipGroup = resources.find((r) => /int_vip/i.test(r.name))?.group
        for (const r of noQuorum ? [] : resources) {
          if (/int_vip/i.test(r.name) || (vipGroup && r.group === vipGroup)) continue
          track(r.name, r.owners.join(','), r.group)
        }
        // 그룹째 옮겨 간 리소스는 한 줄로 — 한 번의 페일오버가 리소스 수만큼 줄을 차지하지 않게
        const byMove = new Map<string, { names: string[]; group?: string; from: string; to: string }>()
        for (const ch of changes) {
          const k = `${ch.group ?? ch.name}|${ch.from}|${ch.to}`
          const cur = byMove.get(k)
          if (cur) cur.names.push(ch.name)
          else byMove.set(k, { names: [ch.name], group: ch.group, from: ch.from, to: ch.to })
        }
        if (byMove.size) {
          if (!msRef.current.roles) msRef.current.roles = []
          const targets: { resources: string[]; to: string; label: string }[] = []
          for (const g of byMove.values()) {
            const name = g.names[0] === 'DC' ? 'DC (pacemaker)' : g.group ? `${g.group} 그룹 (${g.names.join(', ')})` : g.names[0]
            msRef.current.roles.push({ at: now, name, from: g.from, to: g.to })
            if (g.names[0] !== 'DC') targets.push({ resources: g.names, to: g.to, label: `${name}: ${g.from} → ${g.to}` })
          }
          const dcMove = [...byMove.values()].find((g) => g.names[0] === 'DC')
          if (srcId)
            void ((runT0: number, opt: Parameters<typeof captureMove>[1]) => inSeq(srcId, () => captureMove(runT0, opt)))(t0Ref.current, {
              key: `roles:${now}`,
              title: `pacemaker 역할 이동${dcMove ? ` — DC ${dcMove.from} → ${dcMove.to}` : ''}`,
              srcId,
              before: lastPcsOutRef.current,
              after: pcsOut,
              targets,
            })
        }
        if (vipMoved && srcId) {
          // VIP 와 같은 그룹의 리소스 start 시각도 함께 — 'VIP 는 넘어갔는데 haproxy 는 언제 떴나' 가 증적의 핵심이다
          const vipRes = resources.find((r) => /int_vip/i.test(r.name))
          const groupMates = vipRes?.group ? resources.filter((r) => r.group === vipRes.group).map((r) => r.name) : []
          if (msRef.current.vip) msRef.current.vip.with = groupMates.filter((n) => !/int_vip/i.test(n))
          void ((runT0: number, opt: Parameters<typeof captureMove>[1]) => inSeq(srcId, () => captureMove(runT0, opt)))(t0Ref.current, {
            key: 'vip',
            title: `VIP 이동 — ${vipMoved.from} → ${vipMoved.to}`,
            srcId,
            before: lastPcsOutRef.current,
            after: pcsOut,
            targets: [
              {
                resources: Array.from(new Set([vipRes?.name ?? 'int_vip', ...groupMates])),
                to: vipMoved.to,
                label: `VIP: ${vipMoved.from} → ${vipMoved.to}`,
              },
            ],
            vip: true,
          })
        }
        lastPcsOutRef.current = pcsOut
      } else if (lastRolesRef.current) {
        roles = { ...lastRolesRef.current.v, staleSec: Math.max(1, Math.round((now - lastRolesRef.current.at) / 1000)) }
      }
      patch({ hosts, vipNode, pendingHosts, roles })
    }

    // ── 2) Masakari: engine 로그에서 evacuation 완료 판정 ────────────────────
    /** Nova 기록을 읽을 세션 — OpenStack 세션이 붙어 있으면 그것, 아니면 로그를 읽은 노드에서 openrc 로 */
    const masaOs = (logId: string) => ({
      sid: c.osSession && connectedOf(c.osSession) ? c.osSession : logId,
      rc: c.osRc,
    })
    const masakariJob = async () => {
      const results = await Promise.all(
        masaIds.map(async (id) => {
          if (!connectedOf(id))
            return { id, state: 'unknown' as MasakariState, detail: '세션 미연결', evac: 0, at: undefined as number | undefined }
          // 마지막 200줄만 보면 **대수가 모자라게 세진다** — 인스턴스 하나가 여러 줄을 남기므로
          // (get server · unlock server · notification …) VM 이 여러 대면 앞쪽 evacuate 줄이
          // 밀려 나간다. 전송량은 grep 이 줄이니 여유를 준다.
          const cmd = sudoOr(`sh -c 'tail -n 20000 ${c.logPath} | grep -iE "evacuat|finish|complet|notification" | tail -n 800'`)
          const r = await run(id, cmd)
          if (r.timedOut) delayed.add('Masakari')
          /**
           * **조회 실패는 '로그 없음' 이 아니다.** 예전에는 실패하면 빈 문자열로 판정해 idle(검증 시작 후
           * evacuation 로그 없음)이 됐다 — 이미 finished 였던 카드가 '대기 중' 으로 돌아가고 종합 판정이
           * 정상↔복구 진행 중으로 흔들렸다. 직전 결과를 그대로 두고 그 사실만 밝힌다(없으면 확인 불가).
           */
          if (!r.ok || r.timedOut) {
            const prev = lastMasakariRef.current[id]
            if (prev) return { id, ...prev.p, detail: `${prev.p.detail} (조회 실패 — ${Math.round((Date.now() - prev.at) / 1000)}초 전 값)` }
            return { id, state: 'unknown' as MasakariState, detail: '조회 실패 — 확인 불가', evac: 0, at: undefined as number | undefined }
          }
          const p = parseMasakari(r.out ?? '', t0Ref.current, calibRef.current[id]?.delta ?? 0)
          lastMasakariRef.current[id] = { p, at: Date.now() }
          return { id, ...p, raw: r.out ?? '' }
        }),
      )
      const masakari: MasakariStat[] = results.map((m) => ({
        id: m.id,
        name: nameOf(m.id),
        state: m.state,
        detail: m.detail,
        evac: m.evac,
      }))
      const done = results.find((m) => m.state === 'finished')
      if (!msRef.current.masakari && done) {
        // 시각은 **로그가 말하는 시각**을 쓴다. Date.now() 를 쓰면 '폴링이 발견한 시각' 이 찍혀
        // 폴링 주기만큼 늦고, 호스트 시계가 PC 와 어긋나 있으면 그 오차까지 그대로 실린다.
        // (delta 는 시간대와 호스트↔PC 시계 차이를 함께 잡는다 — 보정값 산출부 주석)
        msRef.current.masakari = { at: done.at ?? Date.now(), by: svcShortName(nameOf(done.id)), evac: done.evac }
        // 조회 실패 프레임의 '직전 값' 으로 완료를 처음 본 경우에는 원문이 없다 — 다음 성공 프레임에서 남긴다
        if ('raw' in done && done.raw) {
          const os = masaOs(done.id)
          const runT0 = t0Ref.current
          void inSeq(os.sid, () => captureMasakari(runT0, done.id, done.raw, done, c.logPath, os))
        }
        else masakariEvPendingRef.current = true
      } else if (msRef.current.masakari && masakariEvPendingRef.current) {
        const okDone = results.find((m) => m.state === 'finished' && 'raw' in m && m.raw)
        if (okDone && 'raw' in okDone && okDone.raw) {
          masakariEvPendingRef.current = false
          const os = masaOs(okDone.id)
          const runT0 = t0Ref.current
          void inSeq(os.sid, () => captureMasakari(runT0, okDone.id, okDone.raw, okDone, c.logPath, os))
        }
      }
      patch({ masakari })
    }

    // ── 3) Ceph ────────────────────────────────────────────────────────────
    const cephJob = async () => {
      // ceph 를 지정하지 않았으면 판정 대상이 아니다(null = 미설정).
      if (!c.ceph) return patch({ ceph: null })
      // 지정했는데 못 물어본 경우는 null 로 두면 안 된다 — 종합 판정이 '미설정 = 통과'로 읽어
      // Ceph 이 한창 리밸런스 중인데 "정상(다음 노드 가능)" 이 뜬다. 그 초록을 보고 다음 노드를
      // 죽이면 복제본이 모자란 상태에서 두 번째 장애가 겹친다. '모름'을 명시적으로 남긴다.
      if (!connectedOf(c.ceph)) return patch({ ceph: unknownCeph('세션 미연결 — 확인 불가') })
      const r = await run(c.ceph, sudoOr('ceph -s'))
      if (r.timedOut) {
        delayed.add('Ceph')
        /**
         * 직전 값을 유지하되(빈 화면으로 깜빡이지 않게) **몇 초 전 값인지 밝힌다.** 예전에는 그냥 돌아가
         * 카드에 HEALTH_OK · 100% 초록 바가 그대로 남았고, 종합 판정(cephOk)도 그 낡은 값으로 초록을 줬다 —
         * 끝난 시각까지 갱신돼 '갱신 멈춤' 경고도 안 떴다. mon 이 흔들리는 바로 그 순간이다.
         */
        const last = lastCephRef.current
        patch({
          ceph: last
            ? { ...last.v, staleSec: Math.max(1, Math.round((Date.now() - last.at) / 1000)) }
            : unknownCeph('응답 지연 — 확인 불가'),
        })
        return STALE_FRAME
      }
      const out = r.ok ? (r.out ?? '') : ''
      if (!out) return patch({ ceph: unknownCeph('조회 실패 (권한/명령 확인) — 확인 불가') })
      const parsed = parseCeph(out)
      /**
       * OSD 복귀 — `osd: 12 osds: 11 up (since 3m), 12 in (since 2w)`. 모자란 것을 본 뒤 전부 up·in 이 **연속 2회**면
       * 처음 그렇게 본 시각으로 남긴다(Ceph 데이터 복구와 같은 기준). 형식을 못 읽은 프레임은 건너뛴다.
       */
      const om = out.match(/osd:\s*(\d+)\s*osds?:\s*(\d+)\s*up[^,\n]*,\s*(\d+)\s*in/)
      if (om && !msRef.current.osdUp) {
        const total = +om[1]
        const up = +om[2]
        const inn = +om[3]
        if (up < total || inn < total) osdRef.current = { short: true, hits: 0, firstAt: 0 }
        else if (osdRef.current.short) {
          if (!osdRef.current.hits) osdRef.current.firstAt = Date.now()
          osdRef.current.hits++
          if (osdRef.current.hits >= 2) msRef.current.osdUp = { at: osdRef.current.firstAt, up, total }
        }
      }
      /**
       * 출력은 왔는데 `HEALTH_` 문자열이 없다 = 클러스터가 상태를 답하지 못한 것이다.
       * mon quorum 이 흔들리는 동안 `ceph -s` 는 이런 걸 돌려준다:
       *   monclient(hunting): authenticate timed out / [errno 110] RADOS timed out
       * 이때 degraded·misplaced 는 '0' 이 아니라 **모름**이다. 그대로 계산에 넣으면
       *   · remain 이 0 이 되어 진행률 바가 100% 초록으로 뒤집히고
       *   · 아래 마일스톤이 가짜 'Ceph 복구 완료' 를 타임라인에 **영구히** 박는다(한 번 찍히면 안 지워진다)
       * 빈 출력과 똑같이 '확인 불가' 로 남긴다.
       */
      if (parsed.health === 'unknown') {
        // 원인 추적용 — **받은 응답을 그대로** 남긴다.
        // 이 상태가 왜 생기는지 화면만 봐서는 알 수 없었다(mon 접속 실패? 권한? 다른 이유?).
        // 카드 note 에 붙여 바로 보이게 하고, 지나간 것도 볼 수 있게 콘솔에도 남긴다.
        const peek = out.trim().replace(/\s+/g, ' ').slice(0, 300)
        console.warn('[StatusBoard] ceph -s 가 HEALTH_ 를 안 줬습니다 — 원문:', out)
        return patch({ ceph: unknownCeph(`상태를 답하지 못함 — 응답: ${peek}`) })
      }
      const remain = parsed.degraded + parsed.misplaced
      // 복구 진행률의 기준선(peak)은 폴링 간에 유지돼야 하므로 ref 에 누적한다.
      cephPeakRef.current = Math.max(cephPeakRef.current, remain)
      const ceph = { ...parsed, peakRemain: cephPeakRef.current }
      // 마일스톤: degraded 도 misplaced 도 0 — 단, '한 번이라도 깨진 적이 있어야' 완료로 본다.
      // (검증 시작 시점부터 계속 0 이면 그건 복구가 아니라 애초에 정상이었던 것)
      //
      // health 가 OK 인 프레임만 신뢰한다. WARN 인데 remain 0 인 순간은 실제로 존재하고
      // (다른 사유로 WARN, 복제는 끝남) 그건 완료로 봐도 되지만, 한 번의 관측으로 확정하면
      // 부분 출력 한 프레임에 속는다 — `session:run` 은 종료코드가 0 이 아니어도 모아둔
      // 출력만큼 ok:true 로 돌려주므로 degraded 줄이 잘린 반쪽 응답이 올 수 있다.
      // 연속 2회 관측해야 확정한다.
      if (!msRef.current.ceph && cephPeakRef.current > 0 && remain === 0) {
        cephDoneHitsRef.current += 1
        if (cephDoneHitsRef.current >= 2) {
          msRef.current.ceph = { at: Date.now() }
          const runT0 = t0Ref.current
          void inSeq(c.ceph, () => captureCeph(runT0, c.ceph, 'ceph'))
        }
      } else {
        cephDoneHitsRef.current = 0
      }
      /**
       * HEALTH_OK 는 '데이터 복구' 와 **다른 사건**이다.
       * clock skew 처럼 복제와 무관한 사유로 WARN 이 남으면 degraded·misplaced 가 0 이어도
       * 클러스터는 정상이 아니다. 종합 판정(cephOk)은 이미 health OK 를 요구하는데
       * 타임라인만 '복구 완료' 라고 말해 서로 어긋났다 — 같은 기준의 줄을 따로 둔다.
       */
      if (!msRef.current.cephHealthy && cephPeakRef.current > 0 && remain === 0 && parsed.health === 'OK') {
        cephOkHitsRef.current += 1
        if (cephOkHitsRef.current >= 2) {
          msRef.current.cephHealthy = { at: Date.now() }
          const runT0 = t0Ref.current
          void inSeq(c.ceph, () => captureCeph(runT0, c.ceph, 'cephHealthy'))
        }
      } else {
        cephOkHitsRef.current = 0
      }
      lastCephRef.current = { v: ceph, at: Date.now() }
      patch({ ceph })
    }

    // ── 4) 파드 (네임스페이스별) ────────────────────────────────────────────
    const podJob = async () => {
      // 미설정 → 판정 대상 아님
      if (!c.pod || !namespaces.length) return patch({ pods: [], podScope: c.podScope, notReadyNodes: [] })
      // 설정했는데 세션이 끊겼으면 '확인 불가'를 남긴다 — 빈 목록으로 두면 every() 가 통과해
      // 파드 상태를 한 번도 못 봤는데 "정상(다음 노드 가능)" 이 된다.
      if (!connectedOf(c.pod))
        return patch({
          pods: namespaces.map((ns) => ({
            namespace: ns, total: 0, abnormalCount: 0, rows: [], unknown: true,
            note: 'kubectl 세션 미연결 — 확인 불가',
          })),
          podScope: c.podScope,
        })
      /**
       * 노드 상태를 **파드보다 먼저** 확인한다.
       *
       * VM 이 죽어도 API 서버는 그 노드의 파드를 한동안 Running 으로 답한다(기본값으로 노드가
       * NotReady 가 되기까지 약 40초, 파드 축출까지 그로부터 5분). 파드 상태만 보면 그 몇 분이
       * 전부 '정상' 으로 남는데, 실제로는 아무것도 확인되지 않은 구간이다.
       * 노드가 NotReady 인 것은 약 40초에 알 수 있으므로, 그 노드의 파드는 그때부터 '확인 불가' 로 본다.
       *
       * 조회가 실패하면 **빈 집합**을 쓴다 — 모르는 정보로 파드를 비정상으로 몰지 않는다.
       */
      const nodeRes = await run(c.pod, 'kubectl get nodes --no-headers --request-timeout=5s 2>&1')
      if (nodeRes.timedOut) delayed.add('노드 상태')
      const notReady = parseNotReadyNodes(nodeRes.ok ? (nodeRes.out ?? '') : '')
      // k8s 노드 복귀 — 제대로 받은 프레임에서만 본다(조회 실패를 'NotReady 없음 = 다 돌아옴' 으로 읽지 않게)
      if (nodeRes.ok && !nodeRes.timedOut && /\b(Ready|NotReady)\b/.test(nodeRes.out ?? '')) {
        for (const n of notReady) k8sNotReadySeenRef.current.add(n)
        for (const n of [...k8sNotReadySeenRef.current]) {
          if (notReady.has(n)) continue
          k8sNotReadySeenRef.current.delete(n)
          ;(msRef.current.k8sReady ??= []).push({ at: Date.now(), node: n })
        }
      }
      /** 네임스페이스별 컨트롤러 Ready — undefined = 묻지 않음(이상 없음), null = 조회 실패 */
      const ctrlByNs = new Map<string, ControllerStat[] | null | undefined>()
      const pods = await Promise.all(
        namespaces.map(async (ns) => {
          // kubectl 자체 타임아웃을 걸어, 죽은 노드의 apiserver 엔드포인트를 물고 늘어지지 않게 한다
          const r = await run(c.pod, `kubectl get pods -n ${ns} -o wide --no-headers --request-timeout=5s 2>&1`)
          if (r.timedOut) delayed.add(`파드(${ns})`)
          const raw = r.ok ? (r.out ?? '') : ''
          const p = parsePods(ns, raw, c.podScope, notReady)
          /**
           * 워크로드(Deployment·StatefulSet)의 Ready 수 — 이상이 있거나 복구를 지켜보는 중인 네임스페이스만 묻는다(평소엔 안 묻는다).
           * 파드 행만 보면 죽은 노드 위에 Terminating 으로 멈춘 StatefulSet 파드(강제 삭제 전에는 다시 안 뜬다)를 nodeNotReady
           * 라 빼서, DB 계열이 내려가 있는데도 '복구 완료' 가 찍혔다. 레플리카가 모자란데 새 파드가 아직 안 생긴 경우도 같다(검토 지적).
           */
          const watching =
            p.abnormalCount > 0 || (badWorkloadsRef.current[ns]?.size ?? 0) > 0 || podCandPending(podCandRef.current[ns])
          let ctrl: ControllerStat[] | null | undefined
          if (watching && r.ok && !r.timedOut) {
            const cr = await run(c.pod, `kubectl get deploy,sts -n ${ns} -o json --request-timeout=5s`)
            ctrl = cr.ok && !cr.timedOut ? parseControllers(cr.out ?? '') : null
          }
          ctrlByNs.set(ns, ctrl)
          // 조회 자체가 실패했는지 — 세션 오류/타임아웃이거나, kubectl 이 에러 문구만 뱉은 경우.
          // (정상적으로 '파드가 하나도 없는' 네임스페이스와 구분해야 한다)
          const failed =
            !r.ok || !!r.timedOut || !!p.unparsed ||
            (p.total === 0 && /error|refused|unable to connect|forbidden|timed out|no such host|not found/i.test(raw))
          return failed ? { ...p, unknown: true, note: 'kubectl 조회 실패 — 확인 불가' } : p
        }),
      )
      // 마일스톤: 워크로드(Deployment/StatefulSet) 단위 정상화.
      // 파드는 노드 DOWN 시 '복구'되는 게 아니라 다른 이름으로 재생성되므로 파드명으로는 추적이 안 된다.
      const now = Date.now()
      for (const p of pods) {
        // 조회 실패(노드 DOWN 직후 kubectl 타임아웃 등)면 결과가 빈 목록으로 온다.
        // 이걸 그대로 믿으면 비정상이던 워크로드가 전부 '복구됨'으로 잘못 기록되므로 건너뛴다.
        if (p.total === 0 || p.unknown) continue
        /**
         * 타임라인 기록 기준은 **파드 자체의 증상**(Pending · Terminating · Ready 미충족)이다.
         * 노드가 NotReady 라서 비정상으로 센 것(nodeNotReady)은 여기서 제외한다.
         *
         * 왜 — 노드 하나가 죽으면 그 노드의 파드가 전부 비정상이 되는데, 거기엔 모든 노드에
         * 하나씩 있는 DaemonSet(cilium · kube-proxy · node-local-dns …)이 반드시 포함된다.
         * DaemonSet 은 재배치가 없어 그 노드가 돌아와야 다시 뜨므로, 그 복구 시각은 곧
         * '노드 복귀 시각' 이다. 그대로 기록하면 타임라인이 **노드 복귀를 네임스페이스 수만큼
         * 반복해 적은 줄**로 덮이고, 정작 봐야 할 앱 워크로드의 페일오버 시각이 묻힌다.
         *
         * 반대로 Deployment 는 다른 노드에 새 파드가 Pending 으로 뜨므로 파드 수준 증상이 남는다
         * → 워크로드 종류를 따로 조회하지 않고도 이 기준만으로 둘이 갈린다.
         *
         * **판정과 화면 표시는 그대로 nodeNotReady 를 비정상으로 본다** — 확인하지 못한 구간을
         * 초록으로 넘기지 않는다는 원칙은 유지하고, '무엇을 복구 시각으로 측정할지' 만 좁힌 것이다.
         */
        const bad = new Set(
          p.rows.filter((r) => !r.healthy && !r.nodeNotReady).map((r) => workloadOf(r.name)),
        )
        // 컨트롤러 기준으로도 모자란 워크로드를 더한다(Ready < 원하는 수). DaemonSet 은 묻지 않는다 — 노드에 묶여 있어
        // 그 노드가 돌아와야 뜨므로 그 복구는 '노드 복귀' 다(위 주석)
        const ctrl = ctrlByNs.get(p.namespace)
        // 컨트롤러 조회가 실패한 프레임에는 복구를 확정하지 않는다(조회 실패 ≠ 복구) — 직전 상태를 그대로 둔다
        if (ctrl === null) continue
        for (const k of ctrl ?? []) if (k.replicas > 0 && k.ready < k.replicas) bad.add(k.name)
        // 전체 보기 모드에서는 rows 에 정상 파드도 섞여 있으므로 비정상만 추린 위 집합이 정답이다.
        const prev = badWorkloadsRef.current[p.namespace]
        /**
         * 복구는 **연속 2프레임** 정상이어야 확정한다(Ceph 와 같은 기준). 처음엔 한 프레임만 보고 찍어, 재생성 중
         * 잠깐 Ready 가 됐다 다시 빠지는 파드에 이른 복구가 찍혔다. 시각은 처음 정상으로 본 프레임이다.
         */
        const cand = (podCandRef.current[p.namespace] ??= newPodCand())
        const step = stepPodRecovery(cand, prev, bad, now)
        for (const r of step.recovered) msRef.current.pods.push({ at: r.at, ns: p.namespace, workload: r.workload })
        {
          /**
           * 비정상 워크로드가 **하나도 안 남은 순간**이 그 네임스페이스의 진짜 '복구 완료' 다.
           *
           * 워크로드별 복구 시각의 마지막 값을 완료로 쓰면 안 된다 — 아직 복구되지 않은 워크로드가
           * 남아 있어도 '완료' 로 적히고, 그 뒤에 하나가 더 복구될 때마다 시각이 뒤로 밀린다.
           * (7개 중 5개만 돌아왔는데 5번째 시각에 '완료' 가 찍히던 문제)
           *
           * 다시 깨졌다 또 복구되면 그 시각으로 갱신되는 게 맞으므로, 전이마다 기록하고
           * 표시할 때 가장 늦은 것을 쓴다.
           */
          if (step.doneAt != null) {
            const doneAt = step.doneAt
            if (!msRef.current.podsDone) msRef.current.podsDone = []
            const entry: { at: number; ns: string; readyAt?: number } = { at: doneAt, ns: p.namespace }
            msRef.current.podsDone.push(entry)
            const recovered = new Set(msRef.current.pods.filter((x) => x.ns === p.namespace).map((x) => x.workload))
            const runT0 = t0Ref.current
            void inSeq(c.pod, () => capturePods(runT0, c.pod, p.namespace, recovered, entry))
          }
        }
        badWorkloadsRef.current[p.namespace] = bad
      }
      patch({ pods, podScope: c.podScope, notReadyNodes: [...notReady] })
    }

    // ── 5) 노드별 서비스 데몬 (systemctl) ───────────────────────────────────
    const svcJob = async () => {
      if (!c.showServices || !svcUnits.length || !hostIds.length) return patch({ serviceUnits: [], services: [] })
      const services = await Promise.all(
        hostIds.map(async (id): Promise<NodeSvc> => {
          if (!connectedOf(id)) return { id, name: nameOf(id), up: false, states: {} }
          const r = await run(id, `systemctl show -p Id -p LoadState -p ActiveState -p SubState ${svcUnits.join(' ')} 2>/dev/null`)
          if (r.timedOut) delayed.add('서비스 데몬')
          const out = r.ok ? (r.out ?? '') : ''
          // 응답이 비면 parseServices 가 모든 유닛을 'unknown' 으로 채워 **열 전체가 '—'** 가 된다.
          // 사용자에게는 "이 노드가 이상하다" 로 읽히지만, 실제로는 systemctl 조회가 실패한 것뿐이다
          // (노드 하나가 죽은 동안 pcs·ceph·openstack·kubectl 이 몰려 12초 타임아웃을 넘기기 쉽다).
          if (!out.trim()) {
            const cached = svcCacheRef.current[id]
            if (cached)
              return {
                id,
                name: nameOf(id),
                up: true,
                states: cached.states,
                staleSec: Math.max(1, Math.round((Date.now() - cached.at) / 1000)),
              }
            return { id, name: nameOf(id), up: true, states: parseServices(svcUnits, '') }
          }
          const states = parseServices(svcUnits, out)
          svcCacheRef.current[id] = { states, at: Date.now() }
          return { id, name: nameOf(id), up: true, states }
        }),
      )
      patch({ serviceUnits: svcUnits, services })
    }

    // ── 6) OpenStack 서비스(API) ────────────────────────────────────────────
    const osJob = async () => {
      if (!c.showOpenstack || !c.osSession || !connectedOf(c.osSession)) return patch({ openstack: null, osScope: c.osScope })
      const SUBS = [
        ['nova', 'compute service list'],
        ['neutron', 'network agent list'],
        ['cinder', 'volume service list'],
      ] as const
      const stale: string[] = []
      const [nova, neutron, cinder] = await Promise.all(
        SUBS.map(async ([type, sub]) => {
          const r = await run(c.osSession, osCmd(c.osRc, sub))
          if (r.timedOut) delayed.add('OpenStack')
          const out = r.ok ? (r.out ?? '') : ''
          // **파싱까지 통과한 응답만** 새 값으로 인정한다. 타임아웃·인증만료·CLI 오류를 빈
          // 문자열로 넘기면 parseOpenstack 이 그 종류를 통째로 건너뛰어(`if (!out.trim()) continue`)
          // 표에서 행과 열이 사라졌다 나타났다 한다 — 노드가 죽어 있는 동안 특히 잦다.
          if (out.trim() && parseOsJson(out, type).ok) {
            osCacheRef.current[type] = { out, at: Date.now() }
            return out
          }
          const cached = osCacheRef.current[type]
          if (!cached) return '' // 한 번도 성공한 적이 없으면 보여줄 직전 값도 없다
          stale.push(`${type} ${Math.max(1, Math.round((Date.now() - cached.at) / 1000))}초 전`)
          return cached.out
        }),
      )
      patch({ openstack: { ...parseOpenstack(nova, neutron, cinder), stale }, osScope: c.osScope })
    }

    // 시각 보정 안내
    const calibs = masaIds.map((id) => calibRef.current[id]).filter(Boolean)
    let tzNote = ''
    if (calibs.length && calibs.some((cb) => !cb.ok)) {
      tzNote = 'host 시각 확인 실패 — masakari 판정이 부정확할 수 있습니다'
    } else if (calibs.length) {
      const maxAbs = Math.max(0, ...calibs.map((cb) => Math.abs(cb.delta)))
      if (maxAbs > 60_000) tzNote = `host 로그 시각이 PC와 약 ${(maxAbs / 3_600_000).toFixed(1)}시간 차이 — 자동 보정 적용됨`
    }
    patch({ tzNote })

    await Promise.all([
      guard('host', hostJob),
      guard('masakari', masakariJob),
      guard('ceph', cephJob),
      guard('파드', podJob),
      guard('서비스', svcJob),
      guard('OpenStack', osJob),
    ])
    // 모든 그룹이 한 번씩 응답한 뒤에야 판정/보드를 켠다 (거짓 초록 방지)
    patch({ ready: true })

    // 이력 확정 — Ceph 의 degraded/misplaced 가 모두 복구된 시점을 1회차의 끝으로 본다.
    if (!savedRef.current && msRef.current.ceph) commitHistory(msRef.current.ceph.at)
    // HEALTH_OK 는 데이터 복구보다 **늦게** 온다(clock skew 같은 다른 사유가 남아 있으면).
    // 그때 이력을 다시 덮어쓰지 않으면 그 줄이 저장본에서 통째로 빠진다.
    else if (savedRef.current && msRef.current.cephHealthy && !savedHealthyRef.current) {
      savedHealthyRef.current = true
      commitHistory(msRef.current.cephHealthy.at, true)
    }
  }

  /**
   * 이번 회차의 마일스톤을 이력으로 남긴다. 마일스톤이 하나도 없으면 저장하지 않는다.
   *
   * `refresh` 는 **이미 저장한 회차를 덮어쓸 때** 쓴다. 저장은 Ceph 데이터 복구 시점에 한 번
   * 일어나는데, 그 뒤에 오는 마일스톤(HEALTH_OK · 늦게 복구된 포털 대상 등)이 있으면
   * 화면 타임라인에는 보이지만 **저장된 이력에는 빠진다.** 같은 id 를 덮어써 채워 넣는다.
   */
  const commitHistory = (closedAt: number, refresh = false) => {
    if (savedRef.current && !refresh) return
    const ms = msRef.current
    if (!ms.down && !ms.vip && !ms.masakari && !ms.ceph && ms.pods.length === 0 && ms.portal.length === 0) return
    // 총 소요는 't0 → 마지막 마일스톤' 이어야 한다. 갱신할 때 지금 시각을 쓰면 보드를
    // 열어둔 시간만큼 부풀고, 처음 값을 그대로 두면 뒤에 온 마일스톤이 소요에 안 잡힌다.
    if (!savedRef.current) closedAtRef.current = closedAt
    closedAtRef.current = Math.max(closedAtRef.current, lastMilestoneAt(ms))
    savedRef.current = true
    const rec: HistoryRecord = {
      id: `${t0Ref.current}`,
      t0: t0Ref.current,
      closedAt: closedAtRef.current,
      node: ms.down?.node ?? '(미확인)',
      label: runLabelRef.current.trim() || undefined,
      // ref 를 그대로 넣으면 이후 폴링이 같은 객체를 계속 수정한다 → 깊은 복사
      // 저장 뒤에 붙는 값(역할 이동 · 파드 Ready 시각 · pacemaker 시각)이 화면 이력만 바꾸고 저장본에는
      // 안 들어가는 일이 없게, 나중에 바뀌는 것은 전부 떼어 복사한다
      milestones: {
        ...ms,
        pods: [...ms.pods],
        portal: [...ms.portal],
        podsDone: ms.podsDone?.map((d) => ({ ...d })),
        roles: ms.roles?.map((r) => ({ ...r })),
        vip: ms.vip ? { ...ms.vip } : undefined,
        down: ms.down ? { ...ms.down } : undefined,
        masakari: ms.masakari ? { ...ms.masakari } : undefined,
        reconnect: ms.reconnect ? { ...ms.reconnect } : undefined,
        ceph: ms.ceph ? { ...ms.ceph } : undefined,
        cephHealthy: ms.cephHealthy ? { ...ms.cephHealthy } : undefined,
        portalPending: ms.portalPending?.length ? [...ms.portalPending] : undefined,
        rejoin: ms.rejoin ? [...ms.rejoin] : undefined,
        k8sReady: ms.k8sReady ? [...ms.k8sReady] : undefined,
      },
    }
    const next = [rec, ...loadHistory().filter((h) => h.id !== rec.id)]
    // 50회를 넘어 밀려나는 회차의 증적도 같이 지운다
    dropEvidence(next.slice(HIST_MAX).map((h) => h.id))
    saveHistory(next)
    // 언마운트(보드 닫기) 중에도 저장은 돼야 하므로, 화면 갱신만 마운트 상태에서 한다
    if (mountedRef.current) setHistory(next)
  }
  // 최신 commitHistory 를 언마운트 정리에서 부르기 위한 ref (effect 를 [] 로 유지)
  const commitRef = useRef(commitHistory)
  commitRef.current = commitHistory

  /**
   * DOWN 노드 SSH 부활 감시 — 상태보드 폴링과 **분리된 독립 타이머**로 돈다.
   * 폴링 주기를 30초로 잡아둔 경우에도 재연결은 빨라야 하고, 시도 횟수 제한도 두지 않는다
   * (부팅이 얼마나 걸릴지 알 수 없다. 중간에 포기하면 그때부터 사람이 붙어 있어야 한다).
   */
  const probeReconnect = async () => {
    if (!runningRef.current) return
    const c = cfgRef.current
    const hostIds = Array.from(new Set(c.hosts.filter(Boolean))).filter((id) =>
      sessionsRef.current.some((s) => s.id === id),
    )
    const now = Date.now()
    if (!onReconnectRef.current) {
      for (const id of hostIds)
        if (!connectedOf(id)) probeRef.current.state[id] = { tries: 0, ok: false, note: '재연결 기능이 연결되지 않음' }
      return
    }
    await Promise.all(
      hostIds.map(async (id) => {
        if (connectedOf(id)) {
          // 죽었다가 SSH 가 **실제로 끊겼다가** 다시 붙은 순간만 타임라인에 기록한다.
          //
          // sshLost 게이트가 없으면 이렇게 무너진다: 전원이 갑자기 끊긴 호스트는 FIN/RST 를
          // 보낼 틈이 없어 소켓이 keepalive 타임아웃까지 살아 있는 것처럼 보인다. 그래서 pcs 가
          // OFFLINE 을 보고한 **직후에도 connected 가 true** 다. 그 순간을 재연결로 읽으면
          //   · 타임라인에 DOWN 1초 뒤 가짜 '세션 재연결' 이 찍히고
          //   · 여기서 wasDown 을 지워버려 **진짜 재연결 감시가 통째로 꺼진다**
          //     (아래 'DOWN 확정 대기 중' 분기에 갇혀 프로브가 영영 안 나간다)
          if (wasDownRef.current.has(id) && sshLostRef.current.has(id)) {
            // 타임라인 주인공(=DOWN 마일스톤의 노드)이 따로 있으면 그 노드의 재연결을 우선 기록한다.
            const short = svcShortName(nameOf(id))
            const target = msRef.current.down?.node
            const cur = msRef.current.reconnect
            if (!cur || (target && short === target && cur.node !== target)) {
              msRef.current.reconnect = { at: now, node: short }
              const runT0 = t0Ref.current
              void inSeq(id, () => captureReconnect(runT0, id))
            }
            wasDownRef.current.delete(id)
            sshLostRef.current.delete(id)
            delete probeRef.current.lastFire[id]
            delete probeRef.current.state[id]
          }
          return
        }
        // 여기 도달했다는 건 지금 SSH 가 끊겨 있다는 뜻 — 위 게이트가 기다리던 관측이다.
        sshLostRef.current.add(id)
        const st = probeRef.current.state
        const bump = (note: string, ok = false) => (st[id] = { tries: (st[id]?.tries ?? 0) + 1, note, ok })

        // pacemaker 가 먼저 Online 을 보고해 downAtRef 가 지워졌어도, SSH 가 붙기 전까지는 계속 감시한다
        if (!wasDownRef.current.has(id)) {
          st[id] = { tries: st[id]?.tries ?? 0, ok: false, note: 'DOWN 확정 대기 중' }
          return
        }
        const target = hostAddrOf(id)
        if (!target) {
          st[id] = { tries: st[id]?.tries ?? 0, ok: false, note: '접속 주소를 알 수 없음(저장 프로필 없음)' }
          return
        }
        // 재연결을 요청한 직후에는 잠시 쉰다(연결 시도가 겹치지 않게)
        if (now - (probeRef.current.lastFire[id] ?? 0) < RECONNECT_PROBE_MS) {
          st[id] = { tries: st[id]?.tries ?? 0, ok: true, note: '재연결 시도 중…' }
          return
        }
        let open: { ok: boolean; open: boolean; error?: string }
        try {
          open = await window.electronAPI.netProbeTcp(target.host, target.port, 2500)
        } catch (e) {
          bump(`포트 확인 실패: ${e instanceof Error ? e.message : String(e)}`)
          return
        }
        if (!open.ok) return void bump(`포트 확인 오류: ${open.error ?? '알 수 없음'}`)
        if (!open.open) return void bump(`${target.host}:${target.port} 아직 안 열림 — 부팅 대기`)
        probeRef.current.lastFire[id] = now
        bump('포트 열림 → 재연결 요청함', true)
        onReconnectRef.current?.(id)
      }),
    )
  }

  // 감시 전용 루프 — 폴링(pollOnce)과 겹치지 않도록 별도 타이머로 돌린다
  /**
   * 진행 중인 폴링·재연결 감시 — 다시 시작할 때 이것들이 끝나기를 기다린다.
   * 중지 → 시작을 앞 폴링이 끝나기 전에 누르면, 앞 루프가 끝나며 다음 주기를 **또 걸어** 회차 내내
   * 루프가 둘이 됐다(SSH 실행 슬롯 부하 두 배 → 타임아웃 증가). 게다가 앞 폴링의 마일스톤이 막 비운
   * 새 회차 기록에 써졌다. 앞 것이 끝난 뒤에 상태를 비우고 새로 시작한다.
   */
  const pollInflightRef = useRef<Promise<unknown> | null>(null)
  const probeInflightRef = useRef<Promise<unknown> | null>(null)
  const startingRef = useRef(false)

  const probeLoop = async (gen = loopGenRef.current) => {
    if (!runningRef.current || gen !== loopGenRef.current) return
    try {
      const pr = probeReconnect()
      probeInflightRef.current = pr
      await pr
    } catch {
      /* 개별 실패는 무시하고 다음 주기에 재시도 — 감시는 절대 멈추면 안 된다 */
    }
    if (runningRef.current && gen === loopGenRef.current) probeTimerRef.current = setTimeout(() => probeLoop(gen), PROBE_TICK_MS)
  }

  const loop = async (gen = loopGenRef.current) => {
    if (!runningRef.current || gen !== loopGenRef.current) return
    try {
      const pr = pollOnce()
      pollInflightRef.current = pr
      await pr
    } catch {
      /* 폴링 오류는 무시하고 다음 주기 재시도 */
    }
    if (runningRef.current && gen === loopGenRef.current) timerRef.current = setTimeout(() => loop(gen), cfgRef.current.intervalSec * 1000)
  }

  const start = () => {
    if (!cfg.hosts.filter(Boolean).length) return
    if (startingRef.current) return
    startingRef.current = true
    void (async () => {
      // 앞 회차의 폴링이 아직 돌고 있으면 끝나기를 기다린다(위 pollInflightRef 주석).
      // 재연결 감시(probe)는 기다리지 않는다 — SSH 재접속을 수십 초 붙잡고 있을 수 있어 시작 버튼이 죽은
      // 것처럼 보였다. probe 는 마일스톤을 쓰지 않고, 아래에서 상태를 비운 뒤 다음 주기에 덮인다.
      await Promise.allSettled([pollInflightRef.current])
      startingRef.current = false
      if (!mountedRef.current) return
      beginRun()
    })()
  }
  const beginRun = () => {
    t0Ref.current = Date.now()
    autoLabeledRef.current = false
    notifiedRef.current = { down: false, recovered: false }
    msRef.current = emptyMilestones()
    cephPeakRef.current = 0
    updatedAtRef.current = {}
    jobErrorsRef.current = {}
    cephDoneHitsRef.current = 0
    cephOkHitsRef.current = 0
    osCacheRef.current = {}
    svcCacheRef.current = {}
    hostnamesRef.current = {}
    calibRef.current = {}
    lastMasakariRef.current = {}
    lastCephRef.current = null
    pcsDownRef.current = new Map()
    downAtRef.current = {}
    wasDownRef.current = new Set()
    sshLostRef.current = new Set()
    pcsSeenOnlineRef.current = new Set()
    pcsSourceRef.current = ''
    seenUpRef.current = new Set()
    vipSeenRef.current = ''
    rolesSeenRef.current = {}
    rolesDoneRef.current = new Set()
    lastRolesRef.current = null
    lastPcsOutRef.current = ''
    masakariEvPendingRef.current = false
    badWorkloadsRef.current = {}
    podCandRef.current = {}
    pcsSawOfflineRef.current = new Set()
    k8sNotReadySeenRef.current = new Set()
    osdRef.current = { short: false, hits: 0, firstAt: 0 }
    probeRef.current = { lastFire: {}, state: {} }
    savedRef.current = false
    savedHealthyRef.current = false
    closedAtRef.current = 0
    setState(null)
    runningRef.current = true
    setRunning(true)
    setView('board')
    const gen = ++loopGenRef.current
    loop(gen)
    probeLoop(gen)
  }
  const stop = () => {
    runningRef.current = false
    setRunning(false)
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = null
    if (probeTimerRef.current) clearTimeout(probeTimerRef.current)
    probeTimerRef.current = null
    // Ceph 를 지정하지 않았거나 중간에 멈춘 회차도 기록이 남도록 중지 시점에 확정한다.
    // 이미 저장된 회차여도 **덮어쓴다** — 저장 이후에 붙은 마일스톤(HEALTH_OK, 늦게 복구된
    // 포털 대상 등)이 저장본에서 빠지지 않게. 총 소요는 마지막 마일스톤 기준이라 안 부풀어난다.
    commitHistory(Date.now(), true)
  }
  useEffect(() => {
    // StrictMode 이중 마운트 시 cleanup 이 mountedRef 를 false 로 만들므로, 마운트마다 true 로 되돌린다.
    mountedRef.current = true
    /**
     * 정리 뒤 같은 화면이 다시 붙은 경우 — 검증 중이었으면 폴링을 이어서 돌린다.
     * dev 에서 이 파일을 고치면 React Fast Refresh 가 effect 를 정리 → 재실행하는데, 정리가 타이머를 끄고
     * runningRef 를 내리지만 화면 상태(running)는 그대로 '검증 중' 으로 남았다. 폴링만 조용히 죽어
     * 모든 섹션에 '갱신 멈춤 n분 전' 이 떴다. 진짜로 닫힌 경우에는 이 setup 이 다시 오지 않는다.
     */
    if (resumeRef.current) {
      resumeRef.current = false
      runningRef.current = true
      const gen = ++loopGenRef.current
      void loop(gen)
      void probeLoop(gen)
    }
    return () => {
      resumeRef.current = runningRef.current
      // 검증 도중 보드를 그냥 닫아도 그 회차 기록은 남긴다 (중지 버튼을 누르지 않는 경우가 잦다).
      // 저장 이후에 붙은 마일스톤까지 담기도록 덮어쓴다 — 닫는 순간이 가장 완전한 상태다.
      commitRef.current(Date.now(), true)
      mountedRef.current = false
      runningRef.current = false
      if (timerRef.current) clearTimeout(timerRef.current)
      if (probeTimerRef.current) clearTimeout(probeTimerRef.current)
    }
  }, [])

  // 경과시간 표시용 1초 틱
  const [tick, forceTick] = useState(0)
  // 진행 중 회차의 장애 주입 시각 수정 — 이력에는 Ceph 복구 시점에야 저장되므로 그 전에는 여기서만 고칠 수 있다
  const [injectEdit, setInjectEdit] = useState(false)
  useEffect(() => {
    if (!running) setInjectEdit(false)
  }, [running])

  /**
   * 포털 감시 패널이 '복구 확정' 을 올려주면 이번 회차 마일스톤에 합친다.
   * 대상당 한 줄이다 — **같은 대상이 다시 올라오면 새 시각으로 바꾼다.** 확정 뒤 다시 깨졌다 복구되면
   * 패널이 새 시각을 다시 보낸다(portal.ts applyObservation 주석). 예전에는 이름이 같으면 버려서 최종
   * 복구 시각이 사라지고 첫 시각(실제보다 이른)이 남았다.
   */
  const addPortalMilestones = useCallback((list: PortalMilestone[]) => {
    const cur = msRef.current.portal
    for (const m of list) {
      const i = cur.findIndex((x) => x.name === m.name)
      if (i < 0) cur.push(m)
      else if (m.at > cur[i].at) cur[i] = m
    }
    forceTick((n) => n + 1)
  }, [])
  /** 포털 미복구 대상 — 바뀌면 이미 저장한 회차에도 반영한다(돌아올 때까지 계속 감시하므로 나중에 비워질 수 있다) */
  const setPortalPending = useCallback((names: string[]) => {
    const cur = msRef.current.portalPending ?? []
    if (cur.length === names.length && cur.every((n, i) => n === names[i])) return
    msRef.current.portalPending = names
    if (savedRef.current) commitRef.current(closedAtRef.current, true)
    forceTick((n) => n + 1)
  }, [])
  /** 다시 깨진 대상의 복구 줄을 거둔다 — 다시 복구되면 addPortalMilestones 가 새 시각으로 올린다 */
  const revokePortalMilestone = useCallback((name: string) => {
    msRef.current.portal = msRef.current.portal.filter((x) => x.name !== name)
    forceTick((n) => n + 1)
  }, [])

  useEffect(() => {
    if (!running) return
    const t = setInterval(() => {
      forceTick((n) => n + 1)
      // 장애가 감지된 순간 회차 이름을 한 번만 제안한다
      const d = msRef.current.down
      if (!autoLabeledRef.current && d) {
        autoLabeledRef.current = true
        setRunLabel((cur) => (cur.trim() ? cur : suggestRunLabel(d.at, d.node)))
      }
    }, 1000)
    return () => clearInterval(t)
  }, [running])

  /**
   * 종합 판정 배지.
   *
   * **label 은 짧게 유지해야 한다.** 예전에는 확인 불가인 네임스페이스를 전부 나열해
   * `확인 불가 — 파드(boot-factory, ceph, cicd, cilium, …)` 처럼 길어졌는데, 그러면 헤더의
   * 다른 항목이 눌려 글자가 줄바꿈되고 헤더 높이가 늘어난다. 다음 폴링에 정상으로 돌아오면
   * 다시 한 줄로 줄어들어, 폴링마다 화면 전체가 위아래로 튀었다(사용자에게는 깜빡임으로 보인다).
   * 자세한 목록은 `detail`(툴팁)과 파드 섹션의 각 카드에 있다.
   */
  const verdict = useMemo((): { label: string; cls: string; detail?: string } => {
    // ready 이전에는 섹션들이 비어 있어(hosts=[]·ceph=null) 조건이 전부 통과해버린다 → 판정 보류
    if (!state || !state.ready) return { label: '대기', cls: 'bg-white/10 text-gray-300' }
    // 미설정(지정 안 한) 섹션은 판정을 막지 않는다(= skip). 설정된 항목만 조건에 반영.
    /**
     * evacuation 이 안 일어난 상태(idle)를 어떻게 볼지는 **노드가 죽었느냐**에 달렸다.
     *
     *  · 아무도 안 죽었으면 — 기다릴 게 없다. 판정을 막지 않는다.
     *    (예전엔 이걸 'progress' 로 뭉개서 평상시에도 배지가 '복구 진행 중' 으로 떴다)
     *  · 노드가 죽은 뒤라면 — evacuation 이 **아직 시작되지 않은** 것이다. 기다려야 한다.
     *    이걸 통과시키면, masakari 가 끝내 동작하지 않아도 SSH 만 돌아오면 '정상' 으로 찍힌다.
     *    HA 검증에서 그건 통과가 아니라 지적사항이다.
     */
    const hadDown = !!msRef.current.down
    const masaOk =
      state.masakari.length === 0 ||
      state.masakari.some((m) => m.state === 'finished') ||
      (!hadDown && state.masakari.every((m) => m.state === 'idle' || m.state === 'unknown'))
    // 직전 값을 보여 주는 프레임(staleSec)은 확인한 것이 아니다 — 초록을 주지 않는다(조회 실패 ≠ 정상)
    const cephOk =
      state.ceph === null ||
      (!state.ceph.staleSec && state.ceph.health === 'OK' && state.ceph.degraded + state.ceph.misplaced === 0)
    // unknown(조회 실패/세션 끊김)은 '이상 없음'이 아니다 — 확인을 못 한 것이다
    const podOk = state.pods.every((p) => !p.unknown && p.abnormalCount === 0)
    const downCount = state.hosts.filter((h) => !h.up).length
    // 포털은 감시한 페이지가 **모두** 돌아와야 완료다 — 하나라도 남아 있으면 초록을 주지 않는다(사용자 기준)
    const portalPending = msRef.current.portalPending ?? []
    if (masaOk && cephOk && podOk && downCount === 0 && portalPending.length === 0)
      return { label: '정상 (다음 노드 가능)', cls: 'bg-emerald-500/20 text-emerald-300' }
    if (masaOk && cephOk && podOk && downCount === 0 && portalPending.length)
      return {
        label: `포털 미복구 ${portalPending.length}개`,
        cls: 'bg-amber-500/20 text-amber-300',
        detail: `아직 돌아오지 않은 포털 대상: ${portalPending.join(', ')}`,
      }
    /**
     * '복구를 기다리는 중'과 '확인을 못 하는 중'은 사용자가 해야 할 일이 다르다.
     * 전자는 기다리면 되고, 후자는 세션을 다시 붙이거나 권한을 봐야 한다.
     * 둘 다 노란 '복구 진행 중'으로 뭉개면 하염없이 기다리게 된다.
     */
    const unsure: string[] = []
    if (state.ceph?.health === 'unknown') unsure.push('Ceph')
    const unknownNs = state.pods.filter((p) => p.unknown).map((p) => p.namespace)
    // 개수만 적는다 — 이름 나열은 툴팁으로 (위 주석 참고)
    if (unknownNs.length) unsure.push(unknownNs.length === 1 ? `파드 ${unknownNs[0]}` : `파드 ${unknownNs.length}개`)
    if (unsure.length && downCount === 0)
      return {
        label: `확인 불가 — ${unsure.join(' · ')}`,
        cls: 'bg-red-500/20 text-red-300',
        detail: unknownNs.length ? `확인 불가 네임스페이스: ${unknownNs.join(', ')}` : undefined,
      }
    return { label: '복구 진행 중', cls: 'bg-amber-500/20 text-amber-300' }
  }, [state])

  /**
   * 창 밖으로 알린다 — 장애가 감지된 순간과, 그 뒤 종합 판정이 처음 초록이 된 순간.
   *
   * 이 둘만 알린다. 마일스톤마다 울리면(파드·Ceph·VIP…) 한 회차에 열 번 넘게 뜨고, 그러면
   * 정작 중요한 두 순간이 묻힌다. 알림을 끄는 사람이 생기는 것이 가장 나쁜 결과다.
   * 조건은 1초마다 계속 참이므로 회차당 한 번만 보낸다(notifiedRef).
   */
  useEffect(() => {
    if (!running) return
    const d = msRef.current.down
    if (!d) return
    if (!notifiedRef.current.down) {
      notifiedRef.current.down = true
      notifyOs('장애 감지', `${d.node} DOWN — 복구 감시를 시작합니다`)
    }
    if (!notifiedRef.current.recovered && verdict.label.startsWith('정상')) {
      notifiedRef.current.recovered = true
      notifyOs('복구 완료', `${d.node} · 장애 후 ${fmtElapsed(Date.now() - d.at)} 만에 종합 판정 정상`)
    }
    // tick 은 msRef(참조)가 1초마다 바뀌는 것을 따라가기 위한 것이다 — 값 자체는 쓰지 않는다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, verdict.label, running])

  const canStart = cfg.hosts.filter(Boolean).length > 0
  // 우측 패널(서비스 데몬/OpenStack)이 켜져 있으면 보드를 가로로 넓힌다
  const wideBoard =
    view === 'board' &&
    ((cfg.showServices && cleanUnits(cfg.services).length > 0) || (cfg.showOpenstack && !!cfg.osSession))

  // 최소화: 컴포넌트는 계속 마운트되어 폴링이 유지되고, 우하단 작은 칩만 표시 → 뒤 세션 확인 가능
  if (minimized) {
    return (
      <div
        data-anchor="board-chip"
        onMouseDown={onChipDown}
        style={chipPos ? { left: chipPos.x, top: chipPos.y } : { left: 16, bottom: 16 }}
        className="fixed z-50 flex cursor-move select-none items-center gap-2 rounded-lg border border-white/10 bg-panel px-3 py-2 shadow-2xl"
      >
        <HeartPulse size={15} className="text-blue-400" />
        <span className="text-xs font-medium text-gray-100">가용성 상태보드</span>
        {state && (
          <span
            title={verdict.detail ?? verdict.label}
            className={'max-w-[240px] truncate whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-medium ' + verdict.cls}
          >
            {verdict.label}
          </span>
        )}
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
        {/* 헤더 — 폴링마다 문구 길이가 바뀌므로, 항목들이 서로를 밀어 줄바꿈되지 않게 고정한다.
            (shrink-0 + whitespace-nowrap 이 없으면 긴 배지 하나에 헤더가 3줄로 부풀며 화면이 튄다) */}
        <div className="flex flex-nowrap items-center gap-2 border-b border-white/10 px-4 py-2.5">
          <HeartPulse size={16} className="shrink-0 text-blue-400" />
          <span className="shrink-0 whitespace-nowrap text-sm font-semibold text-gray-100">가용성 검증 상태보드</span>
          {view === 'board' && (
            // 유일하게 줄어드는 항목 — 길면 잘리고 전문은 툴팁으로 본다
            <span
              title={verdict.detail ?? verdict.label}
              className={
                'ml-1 min-w-0 max-w-[420px] truncate whitespace-nowrap rounded px-2 py-0.5 text-[11px] font-medium ' +
                verdict.cls
              }
            >
              {verdict.label}
            </span>
          )}
          {view === 'board' && running && (
            <span className="flex shrink-0 items-center gap-1 whitespace-nowrap text-[11px] text-gray-400">
              <RefreshCw size={11} className="animate-spin" /> {cfg.intervalSec}초 갱신
            </span>
          )}
          {view === 'board' && (
            <span className="ml-2 flex shrink-0 items-center gap-1 whitespace-nowrap text-[12px] text-gray-300">
              검증 시작 후 <span className="font-semibold text-gray-100">{fmtElapsed(Date.now() - t0Ref.current)}</span> 경과
            </span>
          )}
          {/* 회차 이름 — 지금 무슨 조건으로 돌리는지 알고 있는 '검증 중'에 적어두는 게 가장 정확하다.
              (며칠 뒤 이력에서 노드명·시각만 보고는 어떤 회차였는지 구분이 안 된다) */}
          {view === 'board' && running && (
            <button
              onClick={() => {
                msRef.current.inject = { at: Date.now(), source: 'button' }
                if (savedRef.current) commitRef.current(closedAtRef.current, true)
                forceTick((n) => n + 1)
              }}
              title="노드를 끈(장애를 넣은) 순간 누르세요 — 그 시각을 '장애 주입' 으로 남겨 '주입 → DOWN 감지' 지연과 주입부터의 복구 시간을 리포트에 함께 적습니다. 다시 누르면 새 시각으로 바뀝니다"
              className={
                'ml-2 flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md border px-2 py-1 text-xs ' +
                (msRef.current.inject
                  ? 'border-amber-500/30 bg-amber-500/10 text-amber-200'
                  : 'border-red-500/40 bg-red-500/15 text-red-100 hover:bg-red-500/25')
              }
            >
              <Bolt size={12} />
              {msRef.current.inject ? `장애 주입 ${fmtClock(msRef.current.inject.at)}` : '장애 주입'}
            </button>
          )}
          {view === 'board' && running && (
            <span className="relative shrink-0">
              <button
                onClick={() => setInjectEdit((v) => !v)}
                title="장애 주입 시각을 직접 넣거나 고칩니다 (IPMI 이벤트 로그 시각 등)"
                className="ml-1 whitespace-nowrap rounded-md border border-white/10 px-1.5 py-1 text-[11px] text-gray-300 hover:bg-white/10"
              >
                {msRef.current.inject ? '수정' : '수동 입력'}
              </button>
              {injectEdit && (
                <div className="absolute left-0 top-full z-30 mt-1 w-[560px] rounded-md border border-white/10 bg-panel p-2 shadow-xl">
                  <InjectEditor
                    value={msRef.current.inject}
                    downAt={msRef.current.down?.at}
                    onSave={(v) => {
                      msRef.current.inject = v
                      if (savedRef.current) commitRef.current(closedAtRef.current, true)
                      forceTick((n) => n + 1)
                    }}
                    onDone={() => setInjectEdit(false)}
                  />
                </div>
              )}
            </span>
          )}
          {view === 'board' && (
            <input
              value={runLabel}
              onChange={(e) => setRunLabel(e.target.value)}
              placeholder="회차 이름 (장애 감지 시 자동)"
              title="이력에 저장됩니다. 비워 두면 장애가 감지될 때 '08-30 18:40 con2 down' 형태로 채워 드립니다 — 적어 두신 것이 있으면 건드리지 않습니다"
              className="ml-2 w-[190px] shrink-0 rounded border border-white/10 bg-panel-light px-2 py-1 text-[11px] text-gray-100 placeholder:text-gray-600 focus:border-blue-500/60 focus:outline-none"
            />
          )}
          <div className="ml-auto flex shrink-0 items-center gap-1.5 whitespace-nowrap">
            <button
              onClick={() => setShowHistory(true)}
              title="지난 검증 회차의 복구 타임라인 보기"
              className="flex items-center gap-1 rounded-md border border-white/10 bg-panel-light px-2 py-1 text-xs text-gray-200 hover:bg-white/10"
            >
              <Activity size={12} /> 이력
              {history.length > 0 && <span className="text-gray-500">{history.length}</span>}
            </button>
            {view === 'board' && (
              <>
                <button
                  onClick={() => (running ? stop() : start())}
                  className="flex items-center gap-1 rounded-md border border-white/10 bg-panel-light px-2 py-1 text-xs text-gray-200 hover:bg-white/10"
                >
                  {running ? <Square size={12} /> : <Play size={12} />} {running ? '중지' : '재시작'}
                </button>
                <button
                  onClick={() => setView('config')}
                  title="역할 매핑 보기 — 검증은 계속 진행됩니다"
                  className="flex items-center gap-1 rounded-md border border-white/10 bg-panel-light px-2 py-1 text-xs text-gray-200 hover:bg-white/10"
                >
                  <Settings2 size={12} /> 역할 매핑
                </button>
              </>
            )}
            {/* 매핑을 잠깐 확인하러 들어온 경우가 대부분이다 — 진행 중인 검증을 버리지 않고 돌아갈 길을 준다.
                (예전에는 '역할 매핑' 이 곧바로 stop() 이라, 매핑만 보고 나오면 회차가 통째로 날아갔다) */}
            {view === 'config' && state && (
              <button
                onClick={() => setView('board')}
                className={
                  'flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium text-white ' +
                  (running ? 'animate-pulse bg-emerald-600 hover:bg-emerald-500' : 'bg-blue-600 hover:bg-blue-500')
                }
              >
                <Activity size={12} /> 검증 화면으로
              </button>
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

        {/*
          포털 감시 — 설정 화면과 검증 화면 **양쪽 바깥**에 둔다.
           · 검증을 시작하기 전에 주소·계정·대상을 미리 맞춰둘 수 있어야 한다(설정 화면에서도 보여야 함).
           · 검증 도중 '설정' 으로 잠깐 넘어가도 감시가 끊기면 안 된다. 뷰 안에 두면 그때 언마운트되어
             폴링이 멈추고 연속 카운트가 초기화된다 — 측정에 구멍이 생긴다.
        */}
        <div className="max-h-[45vh] shrink-0 overflow-y-auto border-b border-white/10 px-4 pt-3">
          <PortalPanel
            running={running}
            t0={t0Ref.current}
            // 노드가 죽기 전의 정상 응답은 타임라인에 올리지 않는다 — 이번 장애의 복구만 남긴다.
            // ref 라 곧바로 리렌더를 부르지 않지만, 검증 중에는 1초마다 forceTick 이 돌아 바로 따라온다.
            downAt={msRef.current.down?.at ?? null}
            onMilestones={addPortalMilestones}
            onMilestoneRevoked={revokePortalMilestone}
            onPending={setPortalPending}
          />
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
            {running && (
              <div className="mx-4 mt-3 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-[12px] leading-relaxed text-emerald-200">
                검증이 <strong>계속 진행 중</strong>입니다 — 매핑만 확인하고 위 <strong>'검증 화면으로'</strong>를 누르면 지금까지의
                타임라인이 그대로 유지됩니다. (여기서 매핑을 바꾸면 다음 주기부터 반영됩니다)
              </div>
            )}
            <ConfigView
              cfg={cfg}
              connected={connected}
              sessions={sessions}
              onChange={saveCfg}
              canStart={canStart}
              onStart={start}
            />
          </>
        ) : (
          <BoardView
            state={state}
            milestones={msRef.current}
            t0={t0Ref.current}
            resolveName={(id, fb) => sessions.find((s) => s.id === id)?.name ?? fb}
            onRemoveNamespace={removeNamespaceLive}
            intervalSec={cfg.intervalSec}
            running={running}
            evKeys={evIndex[String(t0Ref.current)] ?? []}
            onEvidence={(key) => setEvOpen({ id: String(t0Ref.current), key })}
          />
        )}
      </div>
      {showHistory && (
        <HistoryView
          list={history}
          evIndex={evIndex}
          onEvidence={(id, key) => setEvOpen({ id, key })}
          onClose={() => setShowHistory(false)}
          onClear={() => {
            dropEvidence(history.map((h) => h.id))
            saveHistory([])
            setHistory([])
          }}
          onRemove={(id) => {
            const next = history.filter((h) => h.id !== id)
            dropEvidence([id])
            saveHistory(next)
            setHistory(next)
          }}
          onRename={(id, label) => {
            const next = history.map((h) => (h.id === id ? { ...h, label: label.trim() || undefined } : h))
            saveHistory(next)
            setHistory(next)
          }}
          onSetInject={(id, inject) => {
            // 지금 진행 중인 회차면 메모리에도 넣는다 — 안 그러면 다음 갱신 저장이 이 값을 덮어쓴다
            if (id === String(t0Ref.current)) msRef.current.inject = inject
            const next = history.map((h) => (h.id === id ? { ...h, milestones: { ...h.milestones, inject } } : h))
            saveHistory(next)
            setHistory(next)
          }}
        />
      )}
      {evOpen && <EvidenceView id={evOpen.id} initialKey={evOpen.key} onClose={() => setEvOpen(null)} />}
    </div>
  )
}

// ── 증적 보기 · 내보내기 ─────────────────────────────────────

/**
 * 원문 안의 UTC 시각(`2026-10-22T05:20:58Z`)을 이 PC 시간대(한국이면 KST, +9시간) 표기로 바꾼다.
 * k8s 이벤트는 UTC 로만 나와 화면의 다른 시각(KST)과 9시간 어긋나 보였다. 시간대 표기가 없는 줄은 건드리지 않는다.
 */
function utcToLocalInText(text: string): string {
  return text.replace(/\b(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.\d+)?Z\b/g, (m, d: string, t: string) => {
    const ms = Date.parse(`${d}T${t}Z`)
    return Number.isNaN(ms) ? m : fmtDateTime(ms)
  })
}

/**
 * 회차의 복구 시간 — **DOWN 감지 시각부터** 잰다(사용자 요청).
 * 처음엔 '검증 시작' 부터 쟀는데, 시작을 누르고 몇 분 뒤에 노드를 죽이면 그 몇 분이 복구 시간에 섞였다.
 *  - 포털 서비스 정상화: 감시한 포털 API 가 모두 연속 N회 200 OK 가 된 시각(가장 늦게 돌아온 페이지)
 *  - 전체 복구: 노드가 돌아온 뒤 Ceph 가 HEALTH_OK 가 된 시각(없으면 데이터 복구, 그것도 없으면 마지막 기록)
 * DOWN 을 못 잡은 회차(검증 전부터 죽어 있었거나 기록 없음)는 검증 시작을 기준으로 하고 그 사실을 표시한다.
 */
function runTotals(h: HistoryRecord): { base: number; fromDown: boolean; svc: number | null; all: number; svcPending: string[] } {
  const ms = h.milestones
  const fromDown = !!ms.down && ms.down.source !== 'pre'
  const base = fromDown ? (ms.down as { at: number }).at : h.t0
  const portal = ms.portal?.length ? Math.max(...ms.portal.map((p) => p.at)) : null
  const end = ms.cephHealthy?.at ?? ms.ceph?.at ?? h.closedAt
  // 미복구 대상이 남았으면 포털 서비스 정상화는 없다(돌아온 대상만으로 시각을 만들지 않는다)
  const svcPending = ms.portalPending ?? []
  return { base, fromDown, svc: portal == null || svcPending.length ? null : portal - base, all: Math.max(0, end - base), svcPending }
}

/** 경과 표기 — 음수(DOWN 감지보다 먼저 관측)는 0 으로 자르지 않고 −mm:ss 로. 리포트·이력·Markdown 이 같은 표기를 쓴다 */
function fmtSigned(ms: number): string {
  return ms < 0 ? `−${fmtElapsed(-ms)}` : fmtElapsed(ms)
}

/** 네임스페이스 파드 복구 완료 중 가장 늦은 것 + 아직 완료되지 않은 네임스페이스 수 */
function podsDoneSummary(ms: Milestones): { at: number | null; pending: number } {
  // podsDone 이 생기기 전의 회차는 '완료' 를 따로 남기지 않았다 — 타임라인(legacyPods)과 같이 마지막 복구를 완료로 보고
  // 미완으로 세지 않는다. 안 그러면 옛 회차가 전부 '파드 미완' 으로 리포트에 찍힌다(검토 지적)
  if (ms.podsDone === undefined) {
    const at = (ms.pods ?? []).length ? Math.max(...(ms.pods ?? []).map((p) => p.at)) : null
    return { at, pending: 0 }
  }
  const done = new Map<string, number>()
  for (const d of ms.podsDone ?? []) done.set(d.ns, Math.max(done.get(d.ns) ?? 0, d.at))
  const started = new Set((ms.pods ?? []).map((p) => p.ns))
  let pending = 0
  for (const ns of started) if (!done.has(ns)) pending++
  return { at: done.size ? Math.max(...done.values()) : null, pending }
}

const he = (v: unknown) =>
  String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * 목표 복구 시간(합격 기준) — 기본 **Off**. 합격 기준이 정해지지 않은 검증이 많아 평소엔 평균만 보고, 기준이 명확해지면
 * On 으로 두고 회차별 합격·불합격을 판정한다(사용자 결정). 값은 DOWN 감지부터의 초, 비워 둔 항목은 판정하지 않는다.
 */
interface RtoTargets {
  enabled: boolean
  vip?: number
  masa?: number
  pods?: number
  svc?: number
  all?: number
}
const RTO_KEY = 'statusboard_rto_v1'
const RTO_ITEMS: { key: keyof Omit<RtoTargets, 'enabled'>; label: string }[] = [
  { key: 'vip', label: 'VIP 이동' },
  { key: 'masa', label: 'Masakari 완료' },
  { key: 'pods', label: '파드 복구' },
  { key: 'svc', label: '포털 서비스 정상화' },
  { key: 'all', label: '전체 복구' },
]
function loadRto(): RtoTargets {
  try {
    const v = JSON.parse(localStorage.getItem(RTO_KEY) || 'null')
    return v && typeof v === 'object' ? { enabled: !!v.enabled, ...v } : { enabled: false }
  } catch {
    return { enabled: false }
  }
}
/** '1:30' · '90' · '2분' → 초. 비우면 undefined */
/**
 * 여러 회차를 묶은 제출용 HTML 리포트 — 인터넷 없이 열리는 한 파일(CSS 내장, 스크립트는 펼치기·이동 보조뿐이라
 * 꺼져 있어도 내용은 다 보인다).
 *
 * 구성: 머리(기간·회차·노드) → 주요 수치 → ① 핵심 요약(자동 문장) → ② 회차 비교표 → ③ 복구 흐름(포털 정상화까지
 * 단계 점) → ④ 회차별 상세(접힘, 표에서 이름을 누르면 이동) → 읽는 법.
 * 복구 시간은 모두 **DOWN 감지 시각부터**다(runTotals). 20회차를 쭉 펼치면 스크롤이 끝없이 길어져(사용자 지적)
 * 상세는 회차마다 접고, 접힌 머리에 핵심 숫자를 띄웠다. PDF 는 접힌 내용이 인쇄되지 않으므로 전부 펼쳐 뽑는다.
 * 증적 원문은 저장할 때 이미 마스킹 설정을 거쳤다.
 */
function buildHtmlReport(
  recs: HistoryRecord[],
  evidence: Record<string, BoardEvidenceItem[]>,
  opts: { openEvidence: boolean; rto?: RtoTargets },
): string {
  const runs = [...recs].sort((a, b) => a.t0 - b.t0)
  const msOf = (h: HistoryRecord): Milestones => ({ ...h.milestones, pods: h.milestones.pods ?? [], portal: h.milestones.portal ?? [] })
  const tot = runs.map(runTotals)
  const nameOfRun = (h: HistoryRecord, i: number) => h.label || `${i + 1}회차 · ${h.node}`
  /** 단계·총 소요 열 — 값은 그 회차의 DOWN 감지(없으면 검증 시작)부터의 경과 */
  type Col = { key: string; label: string; grp: 'step' | 'total'; at: (h: HistoryRecord, ms: Milestones, i: number) => number | null; note?: (ms: Milestones) => string }
  const cols: Col[] = [
    { key: 'vip', label: 'VIP 이동', grp: 'step', at: (_h, ms) => ms.vip?.at ?? null },
    { key: 'masa', label: 'Masakari 완료', grp: 'step', at: (_h, ms) => ms.masakari?.at ?? null },
    {
      key: 'pods',
      label: '파드 복구',
      grp: 'step',
      at: (_h, ms) => podsDoneSummary(ms).at,
      note: (ms) => {
        const n = podsDoneSummary(ms).pending
        return n ? ` (미완 ${n})` : ''
      },
    },
    { key: 'portal1', label: '포털 API 첫 정상', grp: 'step', at: (_h, ms) => (ms.portal.length ? Math.min(...ms.portal.map((p) => p.at)) : null) },
    { key: 'ceph', label: 'Ceph 데이터', grp: 'step', at: (_h, ms) => ms.ceph?.at ?? null },
    { key: 'ok', label: 'Ceph HEALTH_OK', grp: 'step', at: (_h, ms) => ms.cephHealthy?.at ?? null },
    { key: 'svc', label: '포털 서비스 정상화', grp: 'total', at: (_h, _ms, i) => (tot[i].svc == null ? null : tot[i].base + (tot[i].svc as number)) },
    { key: 'all', label: '전체 복구', grp: 'total', at: (_h, _ms, i) => tot[i].base + tot[i].all },
  ]
  const ci = (k: string) => cols.findIndex((c) => c.key === k)
  const vals = cols.map((c) =>
    runs.map((h, i) => {
      const at = c.at(h, msOf(h), i)
      // 0 으로 자르지 않는다 — SSH 끊김으로 DOWN 을 잡은 회차는 감지가 최대 90초 늦어 VIP 이동이 먼저 보일 수 있다.
      // 그걸 00:00 으로 그리면 '즉시 넘어갔다' 로 읽힌다. 음수 그대로 두고 표기에서 밝힌다.
      return at == null ? null : at - tot[i].base
    }),
  )
  const nums = (k: string) => vals[ci(k)].filter((v): v is number => v != null)
  const stat = (k: string) => {
    const a = nums(k)
    if (!a.length) return null
    const i = vals[ci(k)].indexOf(Math.max(...a))
    return { avg: a.reduce((x, y) => x + y, 0) / a.length, max: Math.max(...a), maxRun: runs[i], maxIdx: i, n: a.length }
  }
  // 값이 없는 칸은 짧은 하이픈 — 긴 대시(—)는 표에서 선처럼 보였다(사용자 지적)
  const E = (ms: number | null | undefined) => (ms == null ? '-' : fmtSigned(ms))
  const first = runs[0]
  const last = runs[runs.length - 1]
  const nodes = Array.from(new Set(runs.map((h) => h.node)))
  const vmFailRuns = runs.filter((h) => (h.milestones.masakari?.vms?.failed ?? 0) > 0)
  const vmFailTotal = runs.reduce((a, h) => a + (h.milestones.masakari?.vms?.failed ?? 0), 0)
  const podPendingRuns = runs.filter((h) => podsDoneSummary(msOf(h)).pending > 0)
  const noPortalRuns = runs.filter((_h, i) => tot[i].svc == null && !tot[i].svcPending.length)
  const pendingRuns = runs.filter((_h, i) => tot[i].svcPending.length)
  const noDownRuns = runs.filter((_h, i) => !tot[i].fromDown)
  const noEvRuns = runs.filter((h) => !(evidence[h.id] ?? []).length)
  const sSvc = stat('svc')
  const sAll = stat('all')
  const sVip = stat('vip')
  const sMasa = stat('masa')
  const sPods = stat('pods')
  const sCeph = stat('ceph')
  const runLink = (h: HistoryRecord) => he(nameOfRun(h, runs.indexOf(h)))
  // 목표 기준 — 켜져 있고 값이 있는 항목만 판정한다. 회차는 판정한 항목이 모두 목표 이내면 합격, 값이 없는 항목은 건너뛴다
  const rto = opts.rto
  const rtoOn = !!rto?.enabled && RTO_ITEMS.some((x) => rto[x.key] != null)
  const rtoGoal = (colKey: string): number | undefined => {
    if (!rtoOn || !rto) return undefined
    const k = colKey as keyof Omit<RtoTargets, 'enabled'>
    return RTO_ITEMS.some((x) => x.key === k) ? rto[k] : undefined
  }
  const verdicts: ('pass' | 'fail' | 'none')[] = runs.map((h, i) => {
    if (!rtoOn) return 'none'
    // 포털 대상이 하나라도 돌아오지 않았으면 그 회차는 불합격이다(모두 돌아와야 완료)
    if (tot[i].svcPending.length) return 'fail'
    // 파드도 같다 — 복구가 시작됐는데 끝나지 않은 네임스페이스가 있으면 값이 없다고 건너뛰지 않는다.
    // 건너뛰면 끝내 안 돌아온 회차가 다른 항목만으로 '합격' 이 됐다(검토 지적). VIP·Masakari 는 값이 없는 것이
    // '그 노드에 VIP 가 없었다 · 감시하지 않았다' 일 수 있어 미완과 구분할 수 없으므로 지금처럼 건너뛴다
    if (rto?.pods != null && podsDoneSummary(msOf(h)).pending > 0) return 'fail'
    let any = false
    for (const it of RTO_ITEMS) {
      const goal = rto?.[it.key]
      if (goal == null) continue
      const v = vals[ci(it.key)][i]
      if (v == null) continue
      any = true
      if (v > goal * 1000) return 'fail'
    }
    return any ? 'pass' : 'none'
  })

  // ── ① 핵심 요약 — 숫자를 문장으로 ──
  const S: { tone: 'ok' | 'warn' | 'info'; html: string }[] = []
  S.push({ tone: 'info', html: `${runs.length}회차를 검증했습니다 — 대상 노드 <b>${he(nodes.join(', '))}</b>. 아래 시간은 모두 <b>DOWN 감지 시각부터</b>입니다.` })
  if (sSvc)
    S.push({
      tone: 'ok',
      html: `<b>포털 서비스 정상화</b>(감시한 포털 API 가 모두 연속 200 OK)까지 평균 <b>${E(sSvc.avg)}</b>, 가장 오래 걸린 회차는 <b>${he(nameOfRun(sSvc.maxRun, sSvc.maxIdx))}</b> ${E(sSvc.max)}입니다.`,
    })
  if (sAll)
    S.push({
      tone: 'info',
      html:
        `<b>전체 복구</b>(노드 UP 이후 Ceph 클러스터 정상화까지)는 평균 <b>${E(sAll.avg)}</b>, 최대 ${E(sAll.max)}입니다.` +
        (() => {
          // 포털 값이 있는 회차끼리만 뺀다 — 포털을 안 본 회차의 전체 복구가 섞이면 차이가 부풀거나 음수가 된다
          const gaps = runs
            .map((_h, i) => (tot[i].svc == null ? null : tot[i].all - (tot[i].svc as number)))
            .filter((v): v is number => v != null)
          return gaps.length ? ` 포털이 돌아온 뒤 Ceph 정상화를 기다린 시간이 평균 약 ${E(gaps.reduce((a, b) => a + b, 0) / gaps.length)}입니다.` : ''
        })(),
    })
  const steps = [
    sVip && `VIP 이동 ${E(sVip.avg)}`,
    sMasa && `Masakari 완료 ${E(sMasa.avg)}`,
    sPods && `파드 복구 ${E(sPods.avg)}`,
    sCeph && `Ceph 데이터 복구 ${E(sCeph.avg)}`,
  ].filter(Boolean)
  if (steps.length) S.push({ tone: 'info', html: `단계별 평균: ${steps.join(' · ')}.` })
  if (vmFailTotal) S.push({ tone: 'warn', html: `Masakari evacuation 에 <b>실패한 VM ${vmFailTotal}대</b> — ${vmFailRuns.map(runLink).join(', ')}.` })
  if (podPendingRuns.length) S.push({ tone: 'warn', html: `파드 복구가 끝나지 않은 채 기록된 회차 ${podPendingRuns.length}개 — ${podPendingRuns.map(runLink).join(', ')}.` })
  if (noDownRuns.length) S.push({ tone: 'warn', html: `DOWN 을 감지하지 못해 검증 시작부터 잰 회차 ${noDownRuns.length}개 — ${noDownRuns.map(runLink).join(', ')} (표에 * 표시).` })
  const injected = runs.filter((h, i) => h.milestones.inject && tot[i].fromDown)
  if (injected.length) {
    const lags = injected.map((h) => runTotals(h).base - (h.milestones.inject as { at: number }).at)
    S.push({
      tone: 'info',
      html: `장애 주입 시각이 있는 회차 ${injected.length}개 — <b>주입 → DOWN 감지</b> 평균 ${E(lags.reduce((a, b) => a + b, 0) / lags.length)}, 최대 ${E(Math.max(...lags))}. 표의 시간은 DOWN 감지부터이므로 실제 중단 시간은 이만큼 더 깁니다.`,
    })
  }
  if (pendingRuns.length)
    S.push({
      tone: 'warn',
      html: `<b>포털 미복구(Fail)</b> 회차 ${pendingRuns.length}개 — ${pendingRuns
        .map((h) => `${runLink(h)}(${he(runTotals(h).svcPending.join(', '))})`)
        .join(' · ')}. 감시한 포털 페이지가 모두 돌아와야 완료입니다.`,
    })
  if (noPortalRuns.length) S.push({ tone: 'info', html: `포털을 감시하지 않아 포털 서비스 정상화 시간이 없는 회차 ${noPortalRuns.length}개.` })
  if (noEvRuns.length) S.push({ tone: 'info', html: `증적(서버 원문)이 없는 회차 ${noEvRuns.length}개 — 증적 저장 기능 이전의 회차입니다.` })
  if (!vmFailTotal && !podPendingRuns.length) S.push({ tone: 'ok', html: '모든 회차에서 실패한 VM 이나 끝나지 않은 파드 복구는 없었습니다.' })
  if (rtoOn) {
    const judged = verdicts.filter((v) => v !== 'none').length
    const passed = verdicts.filter((v) => v === 'pass').length
    const failedRuns = runs.filter((_h, i) => verdicts[i] === 'fail')
    const goals = RTO_ITEMS.filter((x) => rto?.[x.key] != null).map((x) => `${x.label} ≤ ${fmtElapsed((rto?.[x.key] as number) * 1000)}`)
    S.unshift({
      tone: failedRuns.length ? 'warn' : 'ok',
      html:
        `<b>목표 기준 판정</b>(${he(goals.join(' · '))}): ${judged}회 중 <b>${passed}회 합격</b>` +
        (failedRuns.length ? ` — 불합격 ${failedRuns.map(runLink).join(', ')}.` : '.'),
    })
  }

  const H: string[] = []
  H.push(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>가용성 검증 결과 — ${he(fmtDateTime(first.t0).slice(0, 10))}</title>
<style>
:root{--fg:#1b2430;--mut:#5b6675;--line:#dfe3ea;--soft:#f5f7fa;--brand:#1f3a68;--acc:#2f6fdc;--ok:#13804b;--okbg:#e3f6ec;--warn:#a15c00;--warnbg:#fff4dd;--bad:#c62f2f;--badbg:#fdeaea}
*{box-sizing:border-box}html{scroll-behavior:smooth}
body{font-family:"Pretendard","Segoe UI","Malgun Gothic","Apple SD Gothic Neo",sans-serif;color:var(--fg);margin:0;background:#eef1f5;font-size:13px;line-height:1.6}
.page{max-width:1160px;margin:0 auto;padding:0 24px 48px}
header.hero{background:linear-gradient(135deg,#1f3a68,#2f6fdc);color:#fff;padding:30px 24px 26px}
header.hero .in{max-width:1112px;margin:0 auto}
header.hero h1{margin:0;font-size:26px;letter-spacing:-.3px}
header.hero .meta{margin-top:6px;opacity:.85;font-size:13px}
header.hero .chips{margin-top:12px;display:flex;flex-wrap:wrap;gap:6px}
header.hero .chip{background:rgba(255,255,255,.16);border-radius:999px;padding:2px 10px;font-size:12px}
.kpis{display:grid;grid-template-columns:repeat(5,1fr);gap:12px;margin:-18px 0 8px}
.kpi{background:#fff;border-radius:12px;padding:12px 14px;box-shadow:0 1px 3px rgba(20,30,50,.08);border-top:3px solid var(--acc)}
.kpi span{display:block;color:var(--mut);font-size:12px}.kpi b{display:block;font-size:22px;font-variant-numeric:tabular-nums;margin-top:2px}.kpi small{color:var(--mut);font-size:11.5px}
.kpi.ok{border-top-color:var(--ok)}.kpi.warn{border-top-color:var(--warn)}.kpi.bad{border-top-color:var(--bad)}
section.sec{background:#fff;border-radius:14px;box-shadow:0 1px 3px rgba(20,30,50,.08);padding:18px 20px;margin-top:16px}
.sh{display:flex;align-items:center;gap:10px;margin:0 0 12px;padding-bottom:10px;border-bottom:2px solid var(--soft)}
.sh .n{width:26px;height:26px;border-radius:8px;background:var(--brand);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px}
.sh h2{margin:0;font-size:17px}.sh .d{margin-left:auto;color:var(--mut);font-size:12px}
ul.sum{list-style:none;margin:0;padding:0;display:grid;gap:6px}
ul.sum li{padding:8px 12px 8px 14px;border-radius:8px;background:var(--soft);border-left:4px solid var(--acc)}
ul.sum li.ok{border-left-color:var(--ok);background:var(--okbg)}ul.sum li.warn{border-left-color:var(--warn);background:var(--warnbg)}
table{border-collapse:separate;border-spacing:0;width:100%}
table.grid{border:1px solid var(--line);border-radius:10px;overflow:hidden}
table.grid th{background:#eef2f8;color:#34404f;font-weight:600;font-size:12px;padding:8px;text-align:left;border-bottom:1px solid var(--line);white-space:nowrap}
table.grid td{padding:7px 8px;border-bottom:1px solid var(--line);vertical-align:top}
table.grid tr:last-child td{border-bottom:0}table.grid tbody tr:nth-child(even) td{background:#fafbfd}
table.grid th.grp{text-align:center;background:#e3eaf6}table.grid th.c,table.grid td.c{text-align:center}
.num{font-variant-numeric:tabular-nums;white-space:nowrap}
.best{color:var(--ok);font-weight:700}.worst{color:var(--warn);font-weight:700}.pass{color:var(--ok);font-weight:700}.fail{color:var(--bad);font-weight:700}
td.key{background:#f3f7ff!important;font-weight:600}tr.avg td{background:#eef2f8!important;font-weight:700}
a{color:var(--acc);text-decoration:none}a:hover{text-decoration:underline}
.mut{color:var(--mut)}.note{color:var(--mut);font-size:12px;margin:8px 0 0}
.explain{margin:12px 0 0;padding:10px 14px;border-radius:8px;background:var(--soft);font-size:12.5px;line-height:1.7}
.explain b{color:var(--brand)}
.legend{display:flex;flex-wrap:wrap;gap:12px;font-size:12px;color:var(--mut);margin:10px 0 0}
.legend i{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:4px;vertical-align:-1px}
.flow{display:grid;grid-template-columns:200px 1fr 120px;gap:6px 12px;align-items:center;font-size:12px}
.track{position:relative;height:20px;background:var(--soft);border-radius:6px}
.bar{position:absolute;top:7px;height:6px;left:0;border-radius:3px;background:#c9d6ee}
.dot{position:absolute;top:3px;width:14px;height:14px;margin-left:-7px;border-radius:50%;border:2px solid #fff;box-shadow:0 0 0 1px rgba(0,0,0,.08)}
.tools{display:flex;gap:6px;margin-bottom:10px}.tools button{border:1px solid var(--line);background:#fff;border-radius:8px;padding:4px 10px;font-size:12px;cursor:pointer}
details.run{border:1px solid var(--line);border-radius:12px;margin:8px 0;background:#fff;scroll-margin-top:12px}
details.run>summary{list-style:none;cursor:pointer;padding:10px 14px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
details.run>summary::-webkit-details-marker{display:none}
details.run>summary:before{content:'▸';color:var(--mut);transition:transform .15s}details.run[open]>summary:before{transform:rotate(90deg)}
details.run[open]>summary{border-bottom:1px solid var(--line);background:var(--soft);border-radius:12px 12px 0 0}
.rt{font-weight:700;font-size:14px}.tag{background:#e6eefc;color:var(--brand);border-radius:6px;padding:1px 8px;font-size:12px;font-weight:600}
.pill{border-radius:999px;padding:1px 9px;font-size:11.5px;background:var(--soft);color:var(--mut)}.pill.ok{background:var(--okbg);color:var(--ok)}.pill.warn{background:var(--warnbg);color:var(--warn)}.pill.bad{background:var(--badbg);color:var(--bad)}
.rb{padding:12px 16px 16px}
.kv{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:4px 0 12px}.kv div{background:var(--soft);border-radius:8px;padding:6px 10px}.kv span{display:block;color:var(--mut);font-size:11.5px}.kv b{font-variant-numeric:tabular-nums}
h3{font-size:13.5px;margin:14px 0 6px;color:var(--brand)}
.svr{background:var(--okbg);color:var(--ok);border-radius:4px;padding:0 6px;font-size:11.5px;white-space:nowrap}
details.ev{border:1px solid var(--line);border-radius:8px;padding:6px 10px;margin:6px 0;background:#fcfdff}details.ev>summary{cursor:pointer;font-weight:600}
.evk{display:grid;grid-template-columns:150px 1fr;gap:2px 10px;margin:6px 0;font-size:12px}.evk span:nth-child(odd){color:var(--mut)}
code,.pre{font-family:Consolas,"D2Coding",monospace;font-size:11.5px}.pre{background:#f6f8fb;border:1px solid var(--line);border-radius:8px;padding:8px;white-space:pre;line-height:1.5;max-height:420px;overflow:auto}
.h1l{background:#ffe8a3;color:#7a4b00;font-weight:700}.h2l{background:#fff7d6}
tr.badrow td{background:var(--badbg)!important;color:var(--bad)}
.top{display:inline-block;margin-top:10px;font-size:12px}
@media print{body{background:#fff}.tools,.top{display:none}section.sec,.kpi{box-shadow:none;border:1px solid var(--line)}.pre{max-height:none;overflow:visible;white-space:pre-wrap;word-break:break-all}details.run{break-inside:auto}header.hero{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
@media (max-width:820px){.kpis{grid-template-columns:repeat(2,1fr)}.flow{grid-template-columns:120px 1fr 80px}.kv{grid-template-columns:repeat(2,1fr)}}
</style></head><body>`)

  // ── 머리 · 주요 수치 ──
  H.push(`<header class="hero" id="top"><div class="in"><h1>가용성 검증 결과</h1>
<div class="meta">${he(fmtDateTime(first.t0))} ~ ${he(fmtDateTime(last.closedAt))} · 작성 ${he(fmtDateTime(Date.now()))} · Q-Term</div>
<div class="chips"><span class="chip">${runs.length}회차</span>${nodes.map((n) => `<span class="chip">${he(n)}</span>`).join('')}</div></div></header><div class="page">`)
  const kpi = (cls: string, label: string, v: string, sub = '') => `<div class="kpi ${cls}"><span>${label}</span><b>${v}</b>${sub ? `<small>${sub}</small>` : ''}</div>`
  H.push(
    `<div class="kpis">${kpi('', '회차', String(runs.length), `대상 노드 ${nodes.length}개`)}${kpi('ok', '포털 서비스 정상화 평균', E(sSvc?.avg), sSvc ? `최대 ${E(sSvc.max)}` : '포털 감시 없음')}${kpi('', '전체 복구 평균', E(sAll?.avg), sAll ? `최대 ${E(sAll.max)}` : '')}${
      rtoOn
        ? kpi(
            verdicts.includes('fail') ? 'bad' : 'ok',
            '목표 합격',
            `${verdicts.filter((v) => v === 'pass').length} / ${verdicts.filter((v) => v !== 'none').length}회`,
            '목표 기준 On',
          )
        : kpi('', 'VIP 이동 평균', E(sVip?.avg), sVip ? `${sVip.n}회차` : 'VIP 이동 없음')
    }${kpi(vmFailTotal ? 'bad' : 'ok', '실패한 VM', `${vmFailTotal}대`, vmFailTotal ? `${vmFailRuns.length}개 회차` : 'evacuation 실패 없음')}</div>`,
  )

  // ── ① 핵심 요약 ──
  H.push(`<section class="sec"><div class="sh"><span class="n">1</span><h2>핵심 요약</h2><span class="d">아래 표·상세에서 자동으로 뽑은 문장입니다</span></div><ul class="sum">${S.map((x) => `<li class="${x.tone}">${x.html}</li>`).join('')}</ul></section>`)

  // ── ② 회차 비교 ──
  const nStep = cols.filter((c) => c.grp === 'step').length
  const nTotal = cols.length - nStep
  H.push(`<section class="sec"><div class="sh"><span class="n">2</span><h2>회차 비교</h2><span class="d">DOWN 감지부터의 경과 (분:초)</span></div>`)
  H.push(
    `<table class="grid"><thead><tr><th rowspan="2">회차</th><th rowspan="2">대상 노드</th><th rowspan="2" class="c">DOWN 감지</th><th class="grp" colspan="${nStep}">단계별 복구</th><th class="grp" colspan="${nTotal}">총 소요</th>${rtoOn ? '<th rowspan="2" class="c">목표 판정</th>' : ''}</tr><tr>${cols
      .map((c) => `<th class="c">${he(c.label)}${rtoGoal(c.key) != null ? `<div class="mut" style="font-weight:400;font-size:11px">목표 ≤ ${fmtElapsed((rtoGoal(c.key) as number) * 1000)}</div>` : ''}</th>`)
      .join('')}</tr></thead><tbody>`,
  )
  runs.forEach((h, i) => {
    const ms = msOf(h)
    const cells = cols
      .map((c, k) => {
        const v = vals[k][i]
        const a = nums(c.key)
        // 모든 회차가 같은 값이면 빠르고 느린 것이 없다 — 전부 초록으로 칠하지 않는다
        const lo = Math.min(...a)
        const hi = Math.max(...a)
        if (c.key === 'svc' && tot[i].svcPending.length)
          return `<td class="num c fail key" title="${he(tot[i].svcPending.join(', '))}">미복구 ${tot[i].svcPending.length}</td>`
        // 목표 기준이 켜져 있고 이 항목에 목표가 있으면 빠름·느림 대신 합격·불합격으로 칠한다
        const goal = rtoGoal(c.key)
        const cls =
          goal != null
            ? v == null
              ? ''
              : v <= goal * 1000
                ? 'pass'
                : 'fail'
            : a.length > 1 && v != null && lo < hi
              ? v === lo
                ? 'best'
                : v === hi
                  ? 'worst'
                  : ''
              : ''
        const key = c.grp === 'total' ? ' key' : ''
        return `<td class="num c ${cls}${key}">${E(v)}${goal != null && v != null ? (v <= goal * 1000 ? ' ✓' : ' ✗') : ''}${c.note ? he(c.note(ms)) : ''}${!tot[i].fromDown && v != null ? '*' : ''}</td>`
      })
      .join('')
    H.push(
      `<tr><td><a href="#run-${i + 1}" data-open="run-${i + 1}">${he(nameOfRun(h, i))}</a><div class="mut" style="font-size:11.5px">${he(fmtDateTime(h.t0))}</div></td><td>${he(h.node)}</td><td class="num c">${tot[i].fromDown ? he(fmtClock(tot[i].base)) : '-'}</td>${cells}${
        rtoOn ? `<td class="c">${verdicts[i] === 'pass' ? '<span class="pill ok">합격</span>' : verdicts[i] === 'fail' ? '<span class="pill bad">불합격</span>' : '<span class="mut">-</span>'}</td>` : ''
      }</tr>`,
    )
  })
  const avgRow = cols.map((c) => {
    const a = nums(c.key)
    return `<td class="num c${c.grp === 'total' ? ' key' : ''}">${a.length ? E(a.reduce((x, y) => x + y, 0) / a.length) : '-'}</td>`
  })
  H.push(`<tr class="avg"><td colspan="3">평균</td>${avgRow.join('')}${rtoOn ? '<td></td>' : ''}</tr></tbody></table>`)
  H.push(`<div class="explain">
<div><b>포털 서비스 정상화</b> — 노드 DOWN 을 감지한 시점부터, 감시 중인 포털 API(페이지)가 <b>모두</b> 200 OK 를 연속 정해진 횟수(예: 10회) 받아 정상으로 확정된 시점까지의 시간입니다. 가장 늦게 돌아온 페이지 기준입니다.</div>
<div><b>전체 복구</b> — 노드 DOWN 을 감지한 시점부터, 노드가 다시 올라온 뒤 Ceph 클러스터가 정상(HEALTH_OK)이 된 시점까지의 시간입니다.</div>
<div><b>단계별 복구</b> — 같은 기준(DOWN 감지부터)으로 각 단계가 끝난 시점입니다. 포털 API 첫 정상은 가장 먼저 돌아온 페이지, 포털 서비스 정상화는 마지막 페이지입니다.</div>
</div>`)
  H.push(`<div class="legend">${
    rtoOn
      ? `<span><b class="pass">✓</b> 목표 이내</span><span><b class="fail">✗</b> 목표 초과</span><span>목표가 없는 열은 <b class="best">초록</b> 가장 빠름 · <b class="worst">노랑</b> 가장 느림</span>`
      : `<span><b class="best">초록</b> 가장 빠름</span><span><b class="worst">노랑</b> 가장 느림</span>`
  }<span>- 해당 없음(그 회차에 일어나지 않았거나 감시하지 않음)</span><span>* DOWN 을 감지하지 못해 검증 시작부터 잰 값</span><span>− DOWN 감지보다 먼저 관측됨(SSH 끊김으로 DOWN 을 잡은 회차는 감지가 최대 90초 늦을 수 있음)</span></div></section>`)

  // ── ③ 복구 흐름 — 포털 서비스 정상화까지 단계 점 ──
  const marks = [
    { key: 'vip', label: 'VIP 이동', color: '#2f6fdc' },
    { key: 'masa', label: 'Masakari 완료', color: '#13804b' },
    { key: 'pods', label: '파드 복구', color: '#0e8fa3' },
    { key: 'portal1', label: '포털 API 첫 정상', color: '#b06ce0' },
    { key: 'svc', label: '포털 서비스 정상화', color: '#6a2fc0' },
  ]
  const scale = Math.max(1, ...runs.map((_h, i) => Math.max(...marks.map((m) => vals[ci(m.key)][i] ?? 0))))
  H.push(`<section class="sec"><div class="sh"><span class="n">3</span><h2>복구 흐름</h2><span class="d">DOWN 감지(왼쪽 끝)부터 포털 서비스 정상화까지 · 막대 끝 = ${E(scale)}</span></div><div class="flow">`)
  runs.forEach((h, i) => {
    const end = Math.max(...marks.map((m) => vals[ci(m.key)][i] ?? 0))
    const dots = marks
      .map((m) => {
        const v = vals[ci(m.key)][i]
        // DOWN 감지보다 먼저 관측된 단계(음수)는 막대 왼쪽 끝에 붙이고, 값은 툴팁에 그대로 둔다
        return v == null
          ? ''
          : `<span class="dot" title="${he(m.label)} ${v < 0 ? '' : '+'}${E(v)}" style="left:${((Math.max(0, v) / scale) * 100).toFixed(2)}%;background:${m.color}"></span>`
      })
      .join('')
    H.push(
      `<div><a href="#run-${i + 1}" data-open="run-${i + 1}">${he(nameOfRun(h, i))}</a></div><div class="track"><span class="bar" style="width:${((end / scale) * 100).toFixed(2)}%"></span>${dots}</div><div class="num mut">전체 ${E(vals[ci('all')][i])}</div>`,
    )
  })
  H.push(`</div><div class="legend">${marks.map((m) => `<span><i style="background:${m.color}"></i>${he(m.label)}</span>`).join('')}<span>점에 마우스를 올리면 경과가 보입니다 · Ceph 정상화는 수십 분이라 막대에서 뺐습니다(오른쪽 '전체')</span></div></section>`)

  // ── ④ 회차별 상세 ──
  H.push(`<section class="sec"><div class="sh"><span class="n">4</span><h2>회차별 상세</h2><span class="d">회차를 눌러 펼치세요</span></div>`)
  H.push(`<div class="tools"><button type="button" onclick="document.querySelectorAll('details.run').forEach(d=>d.open=true)">모두 펼치기</button><button type="button" onclick="document.querySelectorAll('details.run').forEach(d=>d.open=false)">모두 접기</button></div>`)
  runs.forEach((h, i) => {
    const ms = msOf(h)
    const t = tot[i]
    const items = evidence[h.id] ?? []
    const fails = h.milestones.masakari?.vms?.failed ?? 0
    const pend = podsDoneSummary(ms).pending
    const pills = [
      t.svcPending.length ? `<span class="pill bad">포털 미복구 ${t.svcPending.length}</span>` : `<span class="pill ok">포털 ${E(t.svc)}</span>`,
      `<span class="pill">전체 ${E(t.all)}</span>`,
      t.fromDown ? '' : `<span class="pill warn">DOWN 미감지 — 시작 기준</span>`,
      fails ? `<span class="pill bad">실패 VM ${fails}</span>` : '',
      pend ? `<span class="pill warn">파드 미완 ${pend}</span>` : '',
      `<span class="pill">증적 ${items.length}</span>`,
    ].join('')
    H.push(
      `<details class="run" id="run-${i + 1}"${opts.openEvidence ? ' open' : ''}><summary><span class="rt">${i + 1}. ${he(nameOfRun(h, i))}</span><span class="tag">${he(h.node)}</span><span class="mut">${he(fmtDateTime(h.t0))}</span>${pills}</summary><div class="rb">`,
    )
    H.push(
      `<div class="kv"><div><span>대상 노드</span><b>${he(h.node)}</b></div><div><span>DOWN 감지</span><b>${t.fromDown ? he(fmtDateTime(t.base)) : '- (검증 시작 기준)'}</b></div><div><span>포털 서비스 정상화</span><b>${t.svcPending.length ? `<span class="fail">미복구 — ${he(t.svcPending.join(', '))}</span>` : t.svc == null ? '- (포털 감시 없음)' : `${E(t.svc)} · ${he(fmtClock(t.base + t.svc))}`}</b></div><div><span>전체 복구</span><b>${E(t.all)} · ${he(fmtClock(t.base + t.all))}</b></div>${
        h.milestones.inject
          ? `<div><span>장애 주입 (${h.milestones.inject.source === 'manual' ? `수동${h.milestones.inject.note ? ` · ${he(h.milestones.inject.note)}` : ''}` : '버튼'})</span><b>${he(fmtClock(h.milestones.inject.at))}${
              t.fromDown ? ` · 감지까지 ${E(t.base - h.milestones.inject.at)}` : ''
            }</b></div><div><span>주입부터 포털 정상화 · 전체 복구</span><b>${t.svc != null && !t.svcPending.length ? E(t.base + t.svc - h.milestones.inject.at) : '-'} · ${E(t.base + t.all - h.milestones.inject.at)}</b></div>`
          : ''
      }</div>`,
    )
    H.push(`<h3>타임라인</h3><table class="grid"><thead><tr><th style="width:150px">시각</th><th class="c" style="width:70px">검증 시작 후</th><th>내용 (Q-Term 관측)</th><th style="width:230px">서버 기록</th></tr></thead><tbody>`)
    for (const r of buildTimelineRows(ms, h.t0))
      H.push(
        `<tr><td class="num">${he(fmtDateTime(r.at))}</td><td class="num c">+${fmtElapsed(r.at - h.t0)}</td><td>${he(r.text)}${r.sub ? ` <span class="mut">${he(r.sub)}</span>` : ''}</td><td>${r.server ? `<span class="svr">${he(r.server)}</span>` : ''}</td></tr>`,
      )
    H.push(`</tbody></table><h3>증적 (서버 원문)</h3>`)
    if (!items.length) H.push(`<div class="note">이 회차에는 저장된 증적이 없습니다 — 증적 저장 기능 이전의 회차이거나 해당 마일스톤이 없었습니다.</div>`)
    for (const it of items) {
      const lines = alignTabBlocks(it.text.split('\n'))
      const focus = (it.focus ?? []).filter(Boolean)
      let fi = focus.length ? lines.findIndex((l) => l.includes(focus[0])) : -1
      if (fi < 0) fi = lines.findIndex((l) => focus.some((f) => l.includes(f)))
      const pre = lines
        .map((l, li) => {
          const cls = li === fi ? 'h1l' : focus.some((f) => l.includes(f)) ? 'h2l' : ''
          return cls ? `<span class="${cls}">${he(l)}</span>` : he(l)
        })
        .join('\n')
      H.push(`<details class="ev"${opts.openEvidence ? ' open' : ''}><summary>${he(it.title)}</summary>`)
      H.push(
        `<div class="evk"><span>읽은 서버</span><span>${he(it.host)}</span><span>떠 온 시각</span><span>${he(fmtDateTime(it.capturedAt))}</span><span>Q-Term 이 실행한 명령</span><code>${he(it.command)}</code>${it.verifyCmd ? `<span>서버에서 직접 확인</span><code>${he(it.verifyCmd)}</code>` : ''}</div>`,
      )
      if (it.facts?.length)
        H.push(`<table class="grid" style="margin:6px 0"><thead><tr><th style="width:170px">시각 / 값</th><th>기록</th></tr></thead><tbody>${it.facts.map((f) => `<tr><td class="num">${he(f.at ? fmtDateTime(f.at) : f.text ?? '-')}</td><td>${he(f.label)}</td></tr>`).join('')}</tbody></table>`)
      if (it.table)
        H.push(
          `<h3 style="font-size:12.5px">${he(it.table.title)}</h3><table class="grid"><thead><tr>${it.table.columns.map((c) => `<th class="c">${he(c)}</th>`).join('')}</tr></thead><tbody>${it.table.rows
            .map((r, ri) => `<tr${it.table?.bad?.[ri] ? ' class="badrow"' : ''}>${r.map((c, k) => `<td class="num${k ? ' c' : ''}">${he(c)}</td>`).join('')}</tr>`)
            .join('')}</tbody></table>`,
        )
      if (it.note) H.push(`<div class="note">${he(it.note)}</div>`)
      H.push(`<div class="pre" style="margin-top:6px">${pre}</div></details>`)
    }
    H.push(`<a class="top" href="#top">↑ 맨 위로</a></div></details>`)
  })
  H.push(`</section>`)

  H.push(`<section class="sec"><div class="sh"><span class="n">i</span><h2>읽는 법</h2></div><ul class="sum">
<li><b>기준 시각</b> — 복구 시간은 모두 노드 DOWN 을 감지한 시각(pcs 가 OFFLINE 을 보고한 순간)부터 잽니다. DOWN 을 감지하지 못한 회차만 검증 시작부터 재고 * 로 표시합니다. 타임라인의 '검증 시작 후' 는 검증 시작부터의 경과입니다.</li>
<li><b>Q-Term 관측</b> — 상태보드가 주기적으로 조회해 처음 확인한 시각입니다. 복구는 연속 성공(포털 N회 · Ceph 2회)으로 확정하므로 한 번 튄 성공은 복구로 세지 않습니다. 표와 판정은 이 시각 기준입니다.</li>
<li><b>서버 기록</b> — pacemaker(동작 이력) · corosync 저널 · k8s(Ready 전환) · Nova(VM 별 evacuation) · masakari-engine 로그가 스스로 남긴 시각입니다. 시간대가 없는 표기는 그 서버 시계를 Q-Term PC 시계로 보정했고, UTC 기록은 이 PC 시간대로 바꿔 표시했습니다.</li>
<li><b>증적 원문</b> — 마일스톤이 찍힌 순간 떠 둔 원문입니다. 진한 노란 줄이 그 시각의 근거입니다. k8s 이벤트(1시간 보관)·pacemaker 이력(cleanup 시 삭제)은 나중에 다시 구할 수 없을 수 있습니다.</li>
</ul></section></div>
<script>
// 비교표·흐름의 회차 이름을 누르면 그 상세를 펼치고 이동한다(스크립트가 꺼져 있어도 이동은 된다)
document.querySelectorAll('[data-open]').forEach(function(a){a.addEventListener('click',function(){var d=document.getElementById(a.getAttribute('data-open'));if(d)d.open=true})});
if(location.hash){var d=document.getElementById(location.hash.slice(1));if(d&&d.tagName==='DETAILS')d.open=true}
</script></body></html>`)
  return H.join('\n')
}

async function makeRunsReport(recs: HistoryRecord[], kind: 'html' | 'pdf', rto?: RtoTargets): Promise<string> {
  const evidence: Record<string, BoardEvidenceItem[]> = {}
  for (const h of recs) {
    const r = await window.electronAPI.boardEvidenceRead(h.id).catch(() => ({ ok: false, items: [] as BoardEvidenceItem[] }))
    evidence[h.id] = r.items ?? []
  }
  const html = buildHtmlReport(recs, evidence, { openEvidence: kind === 'pdf', rto })
  const d = new Date()
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}_${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`
  const base = `가용성검증결과_${recs.length}회차_${stamp}`
  const res =
    kind === 'pdf'
      ? await window.electronAPI.saveReportPdf({ html, defaultName: `${base}.pdf` })
      : await window.electronAPI.saveReport({ defaultName: `${base}.html`, content: html, format: 'html' })
  if (res.saved) return `저장했습니다 — ${res.path ?? ''}`
  return res.error ? `저장 실패 — ${res.error}` : ''
}

/** 이력 한 회차를 제출용 Markdown 으로 — 툴 타임라인 + 증적(서버 원문·서버 기록 시각) */
function buildRunReport(h: HistoryRecord, items: BoardEvidenceItem[]): string {
  /** 표 칸 — 포털·워크로드 이름에 | 가 있으면 표가 깨진다 */
  const cell = (v: unknown) => String(v ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')
  const ms = { ...h.milestones, pods: h.milestones.pods ?? [], portal: h.milestones.portal ?? [] }
  const rows = buildTimelineRows(ms, h.t0)
  const L: string[] = []
  L.push(`# 가용성 검증 회차 — ${h.label || h.node} (${fmtDateTime(h.t0)})`, '')
  const t = runTotals(h)
  L.push(
    `- 대상 노드: ${h.node}`,
    `- 검증 시작: ${fmtDateTime(h.t0)}`,
    `- DOWN 감지: ${t.fromDown ? fmtDateTime(t.base) : '- (감지 못함 — 아래 시간은 검증 시작 기준)'}`,
    `- 포털 서비스 정상화 (DOWN 감지 → 포털 API 모두 연속 200 OK): ${t.svcPending.length ? `미복구(Fail) — ${t.svcPending.join(', ')}` : t.svc == null ? '- (포털 감시 없음)' : fmtSigned(t.svc)}`,
    `- 전체 복구 (DOWN 감지 → 노드 UP 이후 Ceph 정상화): ${fmtElapsed(t.all)}`,
    '',
  )
  L.push('## 복구 타임라인 (Q-Term 관측)', '', '| 시각 | 검증 시작 후 | 내용 | 비고 |', '|---|---|---|---|')
  for (const r of rows) L.push(`| ${fmtDateTime(r.at)} | +${fmtElapsed(r.at - h.t0)} | ${cell(r.text)} | ${cell([r.sub, r.server].filter(Boolean).join(' · '))} |`)
  L.push('')
  if (!items.length) {
    L.push('_이 회차에는 저장된 증적이 없습니다(증적 저장 기능 이전의 회차이거나, 해당 마일스톤이 없었습니다)._')
    return L.join('\n')
  }
  L.push('## 증적 (서버 원문)', '')
  for (const it of items) {
    L.push(`### ${it.title}`, '')
    L.push(`- 읽은 서버: ${it.host} · 떠 온 시각: ${fmtDateTime(it.capturedAt)}`)
    L.push(`- Q-Term 이 실행한 명령: \`\` ${it.command} \`\``)
    if (it.verifyCmd) L.push(`- 서버에서 직접 확인: \`\` ${it.verifyCmd} \`\``)
    L.push('')
    if (it.facts?.length) {
      L.push('| 기록 | 시각 / 값 |', '|---|---|')
      for (const f of it.facts) L.push(`| ${cell(f.label)} | ${cell(f.at ? fmtDateTime(f.at) : f.text ?? '-')} |`)
      L.push('')
    }
    if (it.table) {
      L.push(`**${it.table.title}**`, '', `| ${it.table.columns.map(cell).join(' | ')} |`, `|${it.table.columns.map(() => '---').join('|')}|`)
      for (const r of it.table.rows) L.push(`| ${r.map(cell).join(' | ')} |`)
      L.push('')
    }
    if (it.note) L.push(`> ${it.note}`, '')
    L.push('~~~~text', it.text, '~~~~', '')
  }
  return L.join('\n')
}

async function exportRun(h: HistoryRecord): Promise<string> {
  const r = await window.electronAPI.boardEvidenceRead(h.id).catch(() => ({ ok: false, items: [] as BoardEvidenceItem[] }))
  const d = new Date(h.t0)
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}_${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`
  const name = `가용성검증_${(h.label || h.node).replace(/[\\/:*?"<>|\s]+/g, '_')}_${stamp}.md`
  const res = await window.electronAPI.saveReport({ defaultName: name, content: buildRunReport(h, r.items ?? []) })
  if (res.saved) return `저장했습니다 — ${res.path ?? ''}`
  return res.error ? `저장 실패 — ${res.error}` : ''
}

/**
 * 증적 한 건 보기 — 서버 원문을 보여 주고 **판정 근거 줄로 스크롤해 강조**한다.
 * 모달 규칙대로 배경 클릭으로 닫지 않는다(X 만).
 */
function EvidenceView({ id, initialKey, onClose }: { id: string; initialKey: string; onClose: () => void }) {
  const [items, setItems] = useState<BoardEvidenceItem[] | null>(null)
  const [err, setErr] = useState('')
  const [key, setKey] = useState(initialKey)
  const [copied, setCopied] = useState(false)
  /**
   * 원문 줄바꿈 — 기본은 끈다(가로 스크롤). 명령 출력은 열로 읽는 표라, 창 너비에서 접히면 한 행이 두세 줄로
   * 쪼개져 다음 행과 섞여 보였다. 긴 메시지 한 줄을 통째로 읽고 싶을 때만 켠다(PC 에 기억)
   */
  const [wrap, setWrap] = useState(() => {
    try {
      return localStorage.getItem('evidence_wrap') === '1'
    } catch {
      return false
    }
  })
  const focusRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    let alive = true
    window.electronAPI
      .boardEvidenceRead(id)
      .then((r) => {
        if (!alive) return
        if (!r.ok) setErr(r.error || '증적을 읽지 못했습니다')
        setItems(r.items ?? [])
      })
      .catch((e) => alive && setErr(String(e)))
    return () => {
      alive = false
    }
  }, [id])
  const item = items?.find((x) => x.key === key)
  useEffect(() => {
    // 원문이 그려진 다음 첫 근거 줄을 가운데로
    focusRef.current?.scrollIntoView({ block: 'center' })
  }, [item])
  const lines = item ? alignTabBlocks(item.text.split('\n')) : []
  const focus = (item?.focus ?? []).filter(Boolean)
  // 첫 스크롤 자리는 focus[0] 을 담은 줄 — 없으면 다른 강조 줄
  let firstIdx = focus.length ? lines.findIndex((l) => l.includes(focus[0])) : -1
  if (firstIdx < 0) firstIdx = lines.findIndex((l) => focus.some((f) => l.includes(f)))
  const tabs = items ?? []
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-8">
      <div className="flex h-[86vh] w-[1400px] max-w-[96vw] flex-col overflow-hidden rounded-lg border border-white/10 bg-panel shadow-2xl">
        <div className="flex items-center gap-2 border-b border-white/10 px-4 py-2.5">
          <FileText size={16} className="text-blue-400" />
          <span className="shrink-0 text-sm font-semibold text-gray-100">증적</span>
          <span className="min-w-0 truncate text-[12px] text-gray-400">{item?.title}</span>
          {item && (
            <>
              <button
                onClick={() => {
                  const v = !wrap
                  setWrap(v)
                  try {
                    localStorage.setItem('evidence_wrap', v ? '1' : '0')
                  } catch {
                    /* 저장 못 해도 이번 창에서는 동작한다 */
                  }
                }}
                title="원문이 창보다 길 때 — 끄면 가로 스크롤로 한 줄씩, 켜면 창 너비에서 접어 보여 줍니다"
                className={
                  'ml-auto inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded border px-2 py-1 text-[11px] ' +
                  (wrap ? 'border-blue-500/40 bg-blue-500/15 text-blue-100' : 'border-white/10 text-gray-300 hover:bg-white/10')
                }
              >
                줄바꿈 {wrap ? 'On' : 'Off'}
              </button>
              <button
                onClick={() => {
                  void navigator.clipboard.writeText(item.text).then(() => {
                    setCopied(true)
                    setTimeout(() => setCopied(false), 1500)
                  })
                }}
                className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded border border-white/10 px-2 py-1 text-[11px] text-gray-300 hover:bg-white/10"
              >
                <Copy size={12} /> {copied ? '복사됨' : '원문 복사'}
              </button>
            </>
          )}
          <button onClick={onClose} className={'rounded p-1 text-gray-400 hover:bg-white/10 hover:text-gray-200 ' + (item ? '' : 'ml-auto')}>
            <X size={16} />
          </button>
        </div>
        {tabs.length > 1 && (
          <div className="flex flex-wrap gap-1 border-b border-white/10 px-4 py-1.5">
            {tabs.map((t) => (
              <button
                key={t.key}
                onClick={() => setKey(t.key)}
                className={
                  'rounded px-2 py-0.5 text-[11px] ' +
                  (t.key === key ? 'bg-blue-500/25 text-blue-100' : 'text-gray-400 hover:bg-white/10')
                }
              >
                {t.title.split(' — ')[0]}
              </button>
            ))}
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto p-4 text-[12px]">
          {err && <div className="mb-2 text-red-300">{err}</div>}
          {!items && !err && (
            <div className="flex items-center text-gray-400">
              <Loader2 size={14} className="mr-2 animate-spin" /> 불러오는 중…
            </div>
          )}
          {items && !item && <div className="text-gray-400">이 항목의 증적이 없습니다.</div>}
          {item && (
            <>
              <div className="mb-3 grid gap-1 text-[11.5px] text-gray-400" style={{ gridTemplateColumns: '120px 1fr' }}>
                <span>읽은 서버</span>
                <span className="text-gray-200">{item.host}</span>
                <span>떠 온 시각</span>
                <span className="text-gray-200">{fmtDateTime(item.capturedAt)}</span>
                <span>Q-Term 이 실행한 명령</span>
                <code className="break-all text-gray-300">{item.command}</code>
                {item.verifyCmd && (
                  <>
                    <span>서버에서 직접 확인</span>
                    <code className="break-all text-emerald-300/90">{item.verifyCmd}</code>
                  </>
                )}
              </div>
              {!!item.facts?.length && (
                <div className="mb-3 rounded-lg border border-white/10 bg-black/20 p-2.5">
                  {item.facts.map((f, i) => (
                    <div key={i} className="flex gap-3 py-0.5">
                      <span className="w-[150px] shrink-0 tabular-nums text-gray-100">{f.at ? fmtDateTime(f.at) : f.text ?? '-'}</span>
                      <span className="text-gray-300">{f.label}</span>
                    </div>
                  ))}
                </div>
              )}
              {item.table && (
                <div className="mb-3">
                  <div className="mb-1 text-[11.5px] font-medium text-gray-300">{item.table.title}</div>
                  <div className="overflow-x-auto rounded-lg border border-white/10">
                    <table className="w-full text-[11.5px]">
                      <thead className="bg-white/[0.04] text-gray-400">
                        <tr>
                          {item.table.columns.map((c) => (
                            <th key={c} className="whitespace-nowrap px-2 py-1 text-left font-normal">
                              {c}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {item.table.rows.map((r, ri) => (
                          <tr
                            key={ri}
                            title={item.table?.titles?.[ri]}
                            className={'border-t border-white/5 ' + (item.table?.bad?.[ri] ? 'bg-red-500/10 text-red-200' : 'text-gray-200')}
                          >
                            {r.map((c, ci) => (
                              <td key={ci} className="whitespace-nowrap px-2 py-0.5 tabular-nums">
                                {c}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
              {item.note && <p className="mb-2 text-[11px] leading-relaxed text-gray-500">{item.note}</p>}
              <div className={'rounded-lg bg-black/40 p-2 font-mono text-[11px] leading-[1.55] text-gray-300 ' + (wrap ? '' : 'overflow-x-auto')}>
                {/* 줄바꿈을 끄면 줄들을 가장 긴 줄 너비로 맞춰(w-max) 강조 띠가 화면 끝에서 끊기지 않게 한다 */}
                <div className={wrap ? '' : 'w-max min-w-full'}>
                {lines.map((l, i) => {
                  const hit = focus.some((f) => l.includes(f))
                  return (
                    <div
                      key={i}
                      ref={i === firstIdx ? focusRef : undefined}
                      className={
                        (wrap ? 'whitespace-pre-wrap break-all' : 'whitespace-pre') + ' px-1 ' +
                        (i === firstIdx ? 'rounded bg-amber-400/25 text-amber-100' : hit ? 'rounded bg-amber-400/10 text-amber-100/90' : '')
                      }
                    >
                      {l || ' '}
                    </div>
                  )
                })}
              </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/** '2026-10-22 14:19:58' · '14:19:58'(그 회차 날짜) → epoch ms(이 PC 시간대) */
function parseLocalDateTime(text: string, baseDay: number): number | null {
  const t = text.trim()
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/)
  if (m) {
    const v = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0)).getTime()
    return Number.isNaN(v) ? null : v
  }
  m = t.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/)
  if (m) {
    const d = new Date(baseDay)
    return new Date(d.getFullYear(), d.getMonth(), d.getDate(), +m[1], +m[2], +(m[3] ?? 0)).getTime()
  }
  return null
}

/**
 * 이력 회차의 '장애 주입' 시각 — 버튼으로 남긴 값을 보거나, IPMI(BMC) 이벤트 로그 시각을 보고 수동으로 넣는다.
 */
function InjectEditor({
  value,
  downAt,
  onSave,
  onDone,
}: {
  value: Milestones['inject']
  downAt?: number
  onSave: (v: Milestones['inject'] | undefined) => void
  /** 있으면 처음부터 입력 상태로 열리고, 저장·지우기·취소 뒤 이것을 부른다 (보드 머리줄의 진행 중 회차 수정용) */
  onDone?: () => void
}) {
  const [edit, setEditRaw] = useState(!!onDone)
  const [text, setText] = useState(() => (onDone && value ? fmtDateTime(value.at) : ''))
  const [note, setNote] = useState(() => (onDone ? value?.note ?? 'IPMI 이벤트 로그' : ''))
  const [err, setErr] = useState('')
  const setEdit = (v: boolean) => {
    setEditRaw(v)
    if (!v) onDone?.()
  }
  const base = value?.at ?? downAt ?? Date.now()
  if (!edit)
    return (
      <div className="mb-1.5 flex items-center gap-2 text-[11.5px] text-gray-400">
        <Bolt size={11} className="text-amber-400" />
        {value ? (
          <span>
            장애 주입 <b className="text-gray-200 tabular-nums">{fmtDateTime(value.at)}</b>{' '}
            {value.source === 'manual' ? `(수동${value.note ? ` · ${value.note}` : ''})` : '(버튼)'}
            {downAt && downAt >= value.at && <span className="text-gray-500"> · DOWN 감지까지 {fmtElapsed(downAt - value.at)}</span>}
          </span>
        ) : (
          <span className="text-gray-500">장애 주입 시각 없음</span>
        )}
        <button
          onClick={() => {
            setText(value ? fmtDateTime(value.at) : '')
            setNote(value?.note ?? 'IPMI 이벤트 로그')
            setErr('')
            setEdit(true)
          }}
          className="rounded border border-white/10 px-1.5 py-0.5 text-[11px] text-gray-300 hover:bg-white/10"
        >
          {value ? '수정' : '수동 입력'}
        </button>
      </div>
    )
  return (
    <div className="mb-1.5 rounded border border-white/10 bg-black/20 px-2 py-1.5 text-[11.5px] text-gray-300">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-gray-400">장애 주입 시각</span>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="2026-10-22 14:19:58"
          className="w-[150px] rounded border border-white/10 bg-panel-light px-1.5 py-0.5 font-mono text-[11.5px] text-gray-100 placeholder:text-gray-600"
        />
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="출처 (예: IPMI 이벤트 로그)"
          className="w-[160px] rounded border border-white/10 bg-panel-light px-1.5 py-0.5 text-[11.5px] text-gray-100 placeholder:text-gray-600"
        />
        <button
          onClick={() => {
            const at = parseLocalDateTime(text, base)
            if (at == null) return setErr('2026-10-22 14:19:58 또는 14:19:58 처럼 넣으세요')
            onSave({ at, source: 'manual', note: note.trim() || undefined })
            setEdit(false)
          }}
          className="rounded border border-blue-500/40 bg-blue-500/15 px-2 py-0.5 text-[11px] text-blue-100 hover:bg-blue-500/25"
        >
          저장
        </button>
        {value && (
          <button
            onClick={() => {
              onSave(undefined)
              setEdit(false)
            }}
            className="rounded border border-white/10 px-2 py-0.5 text-[11px] text-gray-300 hover:bg-white/10"
          >
            지우기
          </button>
        )}
        <button onClick={() => setEdit(false)} className="rounded px-1.5 py-0.5 text-[11px] text-gray-400 hover:bg-white/10">
          취소
        </button>
      </div>
      {err && <div className="mt-1 text-red-300">{err}</div>}
      <div className="mt-1 text-[10.5px] text-gray-500">
        이 PC 시간대(KST)로 넣습니다. IPMI(BMC) 시계는 NTP 를 쓰지 않아 수 분씩 틀린 경우가 많습니다 — BMC 시각과 실제 시각의 차이를 확인하고
        (예: <code>ipmitool sel time get</code> 과 <code>date</code> 비교) 그만큼 고쳐 넣으세요.
      </div>
    </div>
  )
}

// ── 검증 이력 (회차별 복구 타임라인) ───────────────────────────
function HistoryView({
  list,
  evIndex,
  onEvidence,
  onClose,
  onClear,
  onRemove,
  onRename,
  onSetInject,
}: {
  list: HistoryRecord[]
  evIndex: Record<string, string[]>
  onEvidence: (id: string, key: string) => void
  onClose: () => void
  onClear: () => void
  onRemove: (id: string) => void
  onRename: (id: string, label: string) => void
  onSetInject: (id: string, inject: Milestones['inject'] | undefined) => void
}) {
  /** 리포트에 담을 회차 — 체크한 순서와 무관하게 시작 시각 순으로 담긴다 */
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [rto, setRtoState] = useState<RtoTargets>(loadRto)
  const [rtoOpen, setRtoOpen] = useState(false)
  const [rtoErr, setRtoErr] = useState('')
  const setRto = (next: RtoTargets) => {
    setRtoState(next)
    try {
      localStorage.setItem(RTO_KEY, JSON.stringify(next))
    } catch {
      /* 무시 — 설정은 이 창에서만 쓰인다 */
    }
  }
  const pickedRecs = list.filter((h) => picked.has(h.id))
  const toggle = (id: string) =>
    setPicked((cur) => {
      const next = new Set(cur)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const makeReport = async (kind: 'html' | 'pdf') => {
    if (!pickedRecs.length || busy) return
    setBusy(true)
    setMsg('')
    try {
      setMsg(await makeRunsReport(pickedRecs, kind, rto))
    } catch (e) {
      setMsg(`만들지 못했습니다 — ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-8">
      <div
        className="flex h-[78vh] w-[1000px] max-w-[94vw] flex-col overflow-hidden rounded-lg border border-white/10 bg-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-white/10 px-4 py-2.5">
          <Activity size={16} className="text-blue-400" />
          <span className="shrink-0 whitespace-nowrap text-sm font-semibold text-gray-100">검증 이력</span>
          <span className="shrink-0 whitespace-nowrap text-[11px] text-gray-500">{list.length}회 · 최근 {HIST_MAX}회까지 보관</span>
          {list.length > 0 && (
            <>
              <label className="ml-3 inline-flex shrink-0 cursor-pointer items-center gap-1 whitespace-nowrap text-[11px] text-gray-400">
                <input
                  type="checkbox"
                  checked={pickedRecs.length > 0 && pickedRecs.length === list.length}
                  onChange={(e) => setPicked(e.target.checked ? new Set(list.map((h) => h.id)) : new Set())}
                />
                전체 선택
              </label>
              <span className="min-w-0 truncate text-[11px] text-gray-500">{pickedRecs.length ? `${pickedRecs.length}회 선택` : '리포트에 담을 회차를 고르세요'}</span>
              <button
                onClick={() => void makeReport('html')}
                disabled={!pickedRecs.length || busy}
                title="고른 회차를 비교표 · 타임라인 · 증적이 담긴 HTML 한 파일로 저장 (브라우저로 열고 인쇄)"
                className="ml-auto inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md border border-blue-500/40 bg-blue-500/15 px-2 py-1 text-xs text-blue-100 hover:bg-blue-500/25 disabled:opacity-40"
              >
                {busy ? <Loader2 size={12} className="animate-spin" /> : <FileText size={12} />} 리포트 (HTML)
              </button>
              <button
                onClick={() => void makeReport('pdf')}
                disabled={!pickedRecs.length || busy}
                title="같은 리포트를 PDF 로 — 증적은 펼친 채로 인쇄됩니다"
                className="shrink-0 whitespace-nowrap rounded-md border border-white/10 bg-panel-light px-2 py-1 text-xs text-gray-300 hover:bg-white/10 disabled:opacity-40"
              >
                PDF
              </button>
              {/* 버튼이 곧 On/Off 다. 예전에는 이 버튼이 설정 칸만 펼치고 켜고 끄는 것은 안쪽 체크박스였는데,
                  눌러도 글자가 'Off' 그대로라 고장 난 것처럼 보였다. 켜면 목표 시간 칸을 함께 펼친다 */}
              <button
                onClick={() => {
                  const on = !rto.enabled
                  setRto({ ...rto, enabled: on })
                  setRtoOpen(on)
                }}
                title={rto.enabled ? '눌러서 끄기 — 평균·최대만 봅니다' : '눌러서 켜기 — 목표 복구 시간으로 회차별 합격·불합격을 판정합니다'}
                className={
                  'shrink-0 whitespace-nowrap rounded-md border px-2 py-1 text-xs ' +
                  (rto.enabled ? 'border-emerald-500/50 bg-emerald-500/20 text-emerald-100 hover:bg-emerald-500/30' : 'border-white/10 bg-panel-light text-gray-300 hover:bg-white/10')
                }
              >
                목표 기준 {rto.enabled ? 'On' : 'Off'}
              </button>
              {rto.enabled && (
                <button
                  onClick={() => setRtoOpen((v) => !v)}
                  title="목표 시간 설정 펼치기·접기"
                  className={
                    'shrink-0 rounded-md border p-1 ' +
                    (rtoOpen ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200' : 'border-white/10 bg-panel-light text-gray-300 hover:bg-white/10')
                  }
                >
                  <Settings2 size={14} />
                </button>
              )}
              <button
                onClick={onClear}
                className="shrink-0 whitespace-nowrap rounded-md border border-white/10 bg-panel-light px-2 py-1 text-xs text-gray-300 hover:bg-white/10"
              >
                전체 삭제
              </button>
            </>
          )}
          <button onClick={onClose} className={'shrink-0 rounded p-1 text-gray-400 hover:bg-white/10 hover:text-gray-200 ' + (list.length ? '' : 'ml-auto')}>
            <X size={16} />
          </button>
        </div>
        {rtoOpen && rto.enabled && (
          <div className="border-b border-white/10 bg-white/[0.02] px-4 py-2.5 text-[12px] text-gray-300">
            <div className="mb-2 flex items-center gap-2">
              <span>
                목표 복구 시간으로 <b>합격·불합격</b> 판정 중 <span className="text-gray-500">— 끄려면 위의 [목표 기준 On] 을 누르세요</span>
              </span>
              <button onClick={() => setRtoOpen(false)} className="ml-auto rounded px-1.5 py-0.5 text-[11px] text-gray-400 hover:bg-white/10">
                접기
              </button>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              {RTO_ITEMS.map((it) => (
                <label key={it.key} className="flex items-center gap-1.5">
                  <span className="text-gray-400">{it.label} ≤</span>
                  <input
                    key={`${it.key}-${rto[it.key] ?? ''}`}
                    defaultValue={rto[it.key] != null ? fmtElapsed((rto[it.key] as number) * 1000) : ''}
                    disabled={!rto.enabled}
                    onBlur={(e) => {
                      const sec = parseDurationInput(e.target.value)
                      // 못 읽은 값은 직전 목표로 되돌린다 — 조용히 비우면 그 항목이 판정에서 빠진다
                      if (sec === null) {
                        setRtoErr(`${it.label}: '${e.target.value}' 는 읽을 수 없어 직전 값으로 되돌렸습니다 — 1:30 · 1분 30초 · 90 처럼 넣으세요`)
                        e.target.value = rto[it.key] != null ? fmtElapsed((rto[it.key] as number) * 1000) : ''
                        return
                      }
                      setRtoErr('')
                      setRto({ ...rto, [it.key]: sec })
                    }}
                    placeholder="예: 1:30"
                    title="1:30 · 1분 30초 · 5분 · 30초 · 90(숫자만 = 초) 모두 됩니다. 칸을 벗어나면 분:초로 바뀝니다"
                    className="w-20 rounded border border-white/10 bg-panel-light px-1.5 py-0.5 text-[12px] text-gray-100 placeholder:text-gray-600 disabled:opacity-50"
                  />
                </label>
              ))}
            </div>
            <p className="mt-1.5 text-[11px] text-gray-500">
              DOWN 감지부터의 시간입니다. <b className="text-gray-300">1:30 · 1분 30초 · 5분 · 30초 · 90</b>(숫자만 쓰면 초) 모두 되고, 칸을 벗어나면 분:초로 정리됩니다. 비워 둔 항목은 판정하지 않습니다. 리포트(HTML·PDF)에 회차별 합격·불합격과 합격 수가 들어갑니다.
            </p>
            {rtoErr && <p className="mt-1 text-[11px] text-amber-300">{rtoErr}</p>}
          </div>
        )}
        {msg && <div className="border-b border-white/10 px-4 py-1.5 text-[11.5px] text-gray-300">{msg}</div>}
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {list.length === 0 ? (
            <div className="text-[12px] leading-relaxed text-gray-500">
              아직 저장된 이력이 없습니다.
              <br />
              Ceph 의 degraded · misplaced 가 모두 0 이 되면 그 회차가 자동으로 저장됩니다. (검증을 중지해도 저장됩니다)
            </div>
          ) : (
            <div className="space-y-3">
              {list.map((h) => (
                <div key={h.id} className="rounded-xl border border-white/10 bg-panel-light p-3.5">
                  <div className="mb-2 flex items-center gap-2 text-[12px]">
                    <input
                      type="checkbox"
                      checked={picked.has(h.id)}
                      onChange={() => toggle(h.id)}
                      title="리포트에 담기"
                      aria-label="리포트에 담기"
                    />
                    <span className="rounded bg-blue-500/20 px-2 py-0.5 font-medium text-blue-200">{h.node}</span>
                    <span className="whitespace-nowrap text-gray-300">{fmtDateTime(h.t0)}</span>
                    {(() => {
                      const t = runTotals(h)
                      return (
                        <span
                          className="whitespace-nowrap text-gray-500"
                          title={`${t.fromDown ? 'DOWN 감지부터' : 'DOWN 을 감지하지 못해 검증 시작부터'} · 포털 = 감시한 포털 API 가 모두 연속 200 OK · 전체 = 노드 UP 이후 Ceph 정상화까지`}
                        >
                          {t.svcPending.length ? (
                            <span className="text-red-300">포털 미복구 {t.svcPending.length} · </span>
                          ) : t.svc != null ? (
                            `포털 ${fmtSigned(t.svc)} · `
                          ) : (
                            ''
                          )}
                          전체 {fmtElapsed(t.all)}
                          {t.fromDown ? '' : ' *'}
                        </span>
                      )
                    })()}
                    {/* 이름은 나중에도 고칠 수 있어야 한다 — 검증 중엔 손이 바빠 못 적고 지나가기 쉽다.
                        평소엔 테두리 없는 글자처럼 보이고, 올리면 입력칸임이 드러난다. */}
                    <input
                      value={h.label ?? ''}
                      onChange={(e) => onRename(h.id, e.target.value)}
                      placeholder="이름 입력…"
                      title="이 회차의 이름 (예: 306ha con1 1차)"
                      className="min-w-0 flex-1 rounded border border-transparent bg-transparent px-1.5 py-0.5 font-medium text-gray-100 placeholder:font-normal placeholder:text-gray-600 hover:border-white/10 focus:border-blue-500/60 focus:bg-black/20 focus:outline-none"
                    />
                    <button
                      onClick={() => {
                        exportRun(h)
                          .then((m) => m && setMsg(m))
                          .catch((e) => setMsg(`저장 실패 — ${e instanceof Error ? e.message : String(e)}`))
                      }}
                      title="이 회차의 타임라인과 증적(서버 원문)을 Markdown 으로 저장 — 제출용"
                      className="ml-auto inline-flex shrink-0 items-center gap-1 rounded border border-white/10 px-1.5 py-0.5 text-[11px] text-gray-300 hover:bg-white/10"
                    >
                      <Download size={12} /> 내보내기
                    </button>
                    <button
                      onClick={() => onRemove(h.id)}
                      title="이 회차 삭제 (저장된 증적도 함께 지웁니다)"
                      className="rounded p-1 text-gray-500 hover:bg-white/10 hover:text-gray-200"
                    >
                      <X size={13} />
                    </button>
                  </div>
                  <InjectEditor value={h.milestones.inject} downAt={h.milestones.down?.at} onSave={(v) => onSetInject(h.id, v)} />
                  <div className="rounded-lg bg-black/20 p-2.5 text-[12px]">
                    <Timeline
                      milestones={{ ...h.milestones, pods: h.milestones.pods ?? [], portal: h.milestones.portal ?? [] }}
                      t0={h.t0}
                      showDate
                      evKeys={evIndex[h.id]}
                      onEvidence={(key) => onEvidence(h.id, key)}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
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
  sessions,
  onChange,
  canStart,
  onStart,
}: {
  cfg: BoardConfig
  connected: BoardSession[]
  /** 열려 있는 전체 세션(연결 끊긴 것 포함) */
  sessions: BoardSession[]
  onChange: (c: BoardConfig) => void
  canStart: boolean
  onStart: () => void
}) {
  /**
   * 드롭다운에는 연결이 끊긴 세션도 넣는다.
   * 검증 도중 노드를 죽이면(그게 이 도구의 목적이다) 그 세션은 '연결 끊김'이 되는데,
   * 연결된 것만 목록에 넣으면 지정해 둔 값이 목록에 없어 칸이 빈 것처럼 보이고
   * 사용자가 매핑이 날아간 줄 알고 다시 만지다 진짜로 지워버린다.
   */
  const selectable = useMemo(
    () => sessions.map((s) => (s.connected ? s : { ...s, name: `${s.name} — 연결 끊김` })),
    [sessions],
  )
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
              <RoleSelect value={h ?? ''} onPick={(v) => setHost(i, v)} options={selectable} />
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
                <RoleSelect value={cfg.masakari[i] ?? ''} onPick={(v) => setMasa(i, v)} options={selectable} />
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
              <RoleSelect value={cfg.ceph} onPick={(v) => onChange({ ...cfg, ceph: v })} options={selectable} />
            </div>
          </label>
        </Section>
        <Section n={4} title="파드 상태 (kubectl)" desc="Running 아닌 파드만 · 배치 NODE 표시 · 네임스페이스 여러 개 가능">
          <label className="text-[11px] text-gray-400">
            조회 세션
            <div className="mt-1">
              <RoleSelect value={cfg.pod} onPick={(v) => onChange({ ...cfg, pod: v })} options={selectable} />
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
              className="shrink-0 whitespace-nowrap rounded border border-white/10 bg-panel-light px-2 py-1 text-[11px] text-gray-200 hover:bg-white/10 disabled:opacity-40"
            >
              전체 추가 ({nsOptions.length})
            </button>
            {cfg.namespaces.length > 0 && (
              <button
                onClick={() => onChange({ ...cfg, namespaces: [] })}
                className="shrink-0 whitespace-nowrap rounded border border-white/10 bg-panel-light px-2 py-1 text-[11px] text-gray-400 hover:bg-white/10"
              >
                전체 해제
              </button>
            )}
            {/* 오류 문구가 길어도 버튼을 밀지 않게 — 이 항목만 줄어들고 전문은 툴팁으로 본다 */}
            {nsErr && (
              <span className="min-w-0 truncate text-[10px] text-amber-300" title={nsErr}>
                {nsErr}
              </span>
            )}
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
              <RoleSelect value={cfg.osSession} onPick={(v) => onChange({ ...cfg, osSession: v })} options={selectable} />
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
  t0,
  resolveName,
  onRemoveNamespace,
  intervalSec,
  running,
  evKeys,
  onEvidence,
}: {
  state: BoardState | null
  milestones: Milestones
  t0: number
  /** 이번 회차에 저장된 증적 key — 타임라인 [증적] 버튼 */
  evKeys: string[]
  onEvidence: (key: string) => void
  /**
   * 세션 이름을 '그리는 시점에' 다시 조회한다.
   * 폴링할 때 잡아둔 이름을 그대로 쓰면, 그 순간 프로필을 못 찾았을 경우 "세션 N" 이 화면에
   * 굳어버린다(검증을 멈춰 두면 다음 폴링이 없어 영영 안 고쳐진다).
   */
  resolveName: (id: string, fallback: string) => string
  onRemoveNamespace: (ns: string) => void
  /** 갱신이 '멈춤' 인지 판단하는 기준을 주기에서 뽑기 위해 받는다 */
  intervalSec: number
  /**
   * 폴링이 돌고 있는지. 중지 상태에서는 갱신이 안 되는 게 당연하므로 '갱신 멈춤' 을 띄우지 않는다
   * (중지 후 결과를 들여다보는 동안 모든 섹션이 빨갛게 경고로 덮이던 문제)
   */
  running: boolean
}) {
  // 첫 주기가 끝나기 전에 그리면 '파드 없음 · host 미지정' 같은 빈 상태가 잠깐 보여 오해를 준다.
  if (!state || !state.ready) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-gray-400">
        <Loader2 size={16} className="mr-2 animate-spin" /> 첫 폴링 대기 중…
      </div>
    )
  }
  /**
   * 갱신이 멈춘 그룹 찾기.
   *
   * 한 그룹이 예외로 죽으면 그 섹션만 옛 값에 멈추고 다른 섹션은 정상 갱신된다 —
   * 화면만 보고는 알 수 없어서, 주기의 4배(최소 15초)를 넘기면 여기서 밝힌다.
   */
  const now = Date.now()
  const staleLimit = Math.max(15_000, intervalSec * 4000)
  const jobErrs = Object.entries(state.jobErrors ?? {})
  /**
   * 지금 문제인 항목만. 오류는 '오류' 한 마디로만 적는다 — 예외 원문은 길어서 헤더를 밀어내고,
   * 사용자가 바로 할 수 있는 일도 아니다(원문은 title 과 개발자도구 콘솔에 남긴다).
   * 오류가 난 잡은 대개 갱신도 멈춰 있으므로 중복해서 적지 않는다.
   */
  const problems = !running
    ? []
    : [
        ...jobErrs.map(([k]) => `${k} 오류`),
        ...Object.entries(state.updatedAt ?? {})
          .filter(([k, at]) => now - at > staleLimit && !state.jobErrors?.[k])
          .map(([k, at]) => `${k} ${fmtAgo(now - at)}`),
      ]
  const podsAt = state.updatedAt?.['파드']

  const ceph = state.ceph
  const hasServices = state.serviceUnits.length > 0 && state.services.length > 0
  const hasOpenstack = state.openstack != null
  // evacuation 을 실제로 완료한 노드(별칭) — 나머지 노드 카드에 교차 표시한다
  const finishedBy = state.masakari
    .filter((m) => m.state === 'finished')
    .map((m) => svcShortName(resolveName(m.id, m.name)))
  return (
    <div className="flex min-h-0 flex-1">
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
      {problems.length > 0 && (
        <div
          title={jobErrs.map(([k, msg]) => `${k}: ${msg}`).join('\n') || undefined}
          className="mb-2.5 flex items-center gap-1.5 rounded-md border border-red-500/40 bg-red-500/10 px-2.5 py-1 text-[11px] text-red-200"
        >
          <AlertTriangle size={12} className="shrink-0" />
          <span className="min-w-0 truncate">갱신 멈춤 (지금 값 아님) — {problems.join(' · ')}</span>
        </div>
      )}
      {state.delayed.length > 0 && (
        <div className="mb-2.5 flex items-center gap-1.5 rounded-md bg-amber-500/10 px-2.5 py-1 text-[11px] text-amber-300">
          <Hourglass size={12} /> 응답이 늦어 이번 주기에 갱신하지 못한 항목: {state.delayed.join(', ')} — 직전 값을 표시 중입니다.
        </div>
      )}
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
              <div className="truncate text-[14px] font-medium text-gray-100">{resolveName(h.id, h.name)}</div>
              <div className="mt-1 text-[12px]">
                {h.vip ? (
                  <span className="inline-flex items-center gap-1 rounded bg-blue-500/20 px-2 py-0.5 font-medium text-blue-200">
                    <MapPin size={12} /> VIP 여기
                  </span>
                ) : h.up ? (
                  <span className="text-gray-500">VIP 없음</span>
                ) : (
                  <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                    <span className="inline-flex items-center gap-1 text-red-300">
                      <Bolt size={12} /> 무응답
                    </span>
                    {h.downAt &&
                      (h.downSource === 'pre' ? (
                        <span
                          className="whitespace-nowrap text-[11px] text-gray-500"
                          title="검증을 시작했을 때 이미 응답이 없던 노드입니다. DOWN 된 시각을 알 수 없어 표시하지 않습니다."
                        >
                          검증 시작 전부터 DOWN
                        </span>
                      ) : (
                        <span
                          className="whitespace-nowrap text-[11px] text-red-300/80"
                          title={
                            h.downSource === 'pcs'
                              ? '살아있는 노드의 pacemaker 가 이 노드를 OFFLINE 으로 보고한 시각입니다.'
                              : 'SSH 세션이 끊긴 것을 확인한 시각입니다. keepalive 특성상 실제 정전 시점보다 최대 90초 늦을 수 있습니다.'
                          }
                        >
                          DOWN 시간 : {fmtClock(h.downAt)}
                          <span className="ml-1 text-gray-600">({h.downSource})</span>
                        </span>
                      ))}
                  </span>
                )}
              </div>
              {/* 재연결 감시 진행 상황 — 부팅 대기 중인지, 포트가 열렸는지, 어디서 막혔는지 그대로 보여준다 */}
              {h.probe && (
                <div className={'mt-1 text-[11px] ' + (h.probe.ok ? 'text-emerald-300/90' : 'text-gray-500')}>
                  ↻ {h.probe.note}
                  {h.probe.tries > 0 && <span className="ml-1 text-gray-600">({h.probe.tries}회 확인)</span>}
                </div>
              )}
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
      {state.pendingHosts > 0 && (
        <div className="-mt-2 mb-4 text-[11px] text-gray-500">
          역할 매핑에 저장된 host {state.pendingHosts}개는 아직 접속하지 않아 표시하지 않습니다 — 해당 세션을 연결하면 카드가 나타납니다.
        </div>
      )}

      {/* 2. Masakari */}
      {/* 카드에 적힌 노드명은 '로그를 읽은 호스트' 다 — VM 이 옮겨 간 곳으로 오해하기 쉬워 제목에 밝힌다 */}
      <SectionLabel n={2} text="Masakari evacuation — 로그 조회 노드 기준 (한쪽만 finished 여도 완료)" />
      {state.tzNote && (
        <div className="mb-1.5 flex items-center gap-1.5 rounded-md bg-amber-500/10 px-2.5 py-1 text-[11px] text-amber-300">
          <AlertTriangle size={12} /> {state.tzNote}
        </div>
      )}
      <div className="mb-4 grid grid-cols-2 gap-3">
        {state.masakari.map((m) => {
          // Masakari 는 알림 하나를 엔진 한 대만 처리하므로, 다른 노드는 끝까지 finished 로그가
          // 안 남는 게 정상이다. 그걸 '진행 중' 으로 두면 영영 안 끝난 것처럼 보이므로,
          // 다른 노드에서 완료되면 그 노드 이름과 함께 완료로 표시한다.
          const doneElsewhere = m.state !== 'finished' && finishedBy.length > 0
          return (
          <div key={m.id} className="flex items-center gap-3 rounded-xl border border-white/10 bg-panel-light p-3">
            {m.state === 'finished' || doneElsewhere ? (
              <CircleCheck size={24} className={'shrink-0 ' + (m.state === 'finished' ? 'text-emerald-400' : 'text-emerald-400/60')} />
            ) : m.state === 'progress' ? (
              <Loader2 size={22} className="shrink-0 animate-spin text-amber-400" />
            ) : m.state === 'idle' ? (
              // 아무 일도 안 일어난 상태 — 돌아가는 스피너를 두면 뭔가 밀린 것처럼 보인다
              <Eye size={22} className="shrink-0 text-gray-500" />
            ) : (
              <AlertTriangle size={22} className="shrink-0 text-gray-500" />
            )}
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 text-[13px] font-medium text-gray-100">
                {resolveName(m.id, m.name)}{' '}
                {doneElsewhere ? (
                  <span className="truncate text-emerald-300/90">{finishedBy.join(', ')} : finished</span>
                ) : (
                  <span className={m.state === 'finished' ? 'text-emerald-300' : m.state === 'progress' ? 'text-amber-300' : 'text-gray-400'}>
                    {m.state === 'finished'
                      ? 'finished'
                      : m.state === 'progress'
                        ? '진행 중'
                        : m.state === 'idle'
                          ? // 같은 '로그 없음' 이라도 노드가 죽기 전과 후는 뜻이 다르다.
                            // 죽은 뒤라면 evacuation 이 아직 시작 안 된 것 — 기다리는 중이다.
                            milestones.down
                            ? '대기 중'
                            : '감시 중'
                          : '미상'}
                  </span>
                )}
                {m.evac > 0 && (
                  <span className="ml-auto shrink-0 rounded-full bg-blue-500/20 px-2 py-0.5 text-[11px] font-medium text-blue-200">
                    evacuation {m.evac}대
                  </span>
                )}
              </div>
              <div className="truncate text-[11px] text-gray-500">
                {doneElsewhere ? '이 노드에는 완료 로그 없음 — 알림은 한 엔진만 처리합니다' : m.detail}
              </div>
            </div>
          </div>
          )
        })}
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
                  (ceph.staleSec
                    ? 'bg-white/10 text-gray-400'
                    : ceph.health === 'OK'
                    ? 'bg-emerald-500/20 text-emerald-300'
                    : ceph.health === 'unknown'
                      ? 'bg-white/10 text-gray-400'
                      : 'bg-amber-500/20 text-amber-300')
                }
              >
                {ceph.health === 'OK' ? <CircleCheck size={13} /> : <AlertTriangle size={13} />}
                HEALTH_{ceph.health === 'unknown' ? '?' : ceph.health}
                {ceph.staleSec ? <span className="text-amber-300/90"> · 응답 지연, {ceph.staleSec}초 전 값</span> : null}
              </span>
              {ceph.etaSec != null && (
                <span
                  className="inline-flex items-center gap-1 text-[12px] font-medium text-gray-100"
                  title={`남은 오브젝트 ${(ceph.degraded + ceph.misplaced).toLocaleString()}개 ÷ 현재 복구 속도 ${Math.round(ceph.rate)}개/초 로 계산한 값입니다. 복구 속도가 변하면 함께 바뀝니다.`}
                >
                  <Hourglass size={13} className="text-gray-400" />
                  <span className="text-gray-400">복구 완료까지</span> {fmtEta(ceph.etaSec)} 예상
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
              /**
               * 조회를 못 한 프레임에서는 진행률을 그리지 않는다.
               * degraded·misplaced 가 0 으로 내려오므로 그대로 계산하면 remain=0 → 100% 초록이 되어,
               * 배지는 회색 `HEALTH_?` 인데 바로 아래 바는 '복구 완료' 로 보이는 모순이 생긴다.
               */
              if (ceph.staleSec)
                return (
                  <div className="mt-2.5 rounded-md border border-white/5 bg-black/20 px-2.5 py-2 text-[11px] text-gray-500">
                    복구 진행률 — <span className="text-gray-400">확인 불가</span> · ceph -s 가 응답하지 않아 위 수치는{' '}
                    {ceph.staleSec}초 전 값입니다
                  </div>
                )
              if (ceph.health === 'unknown')
                return (
                  <div className="mt-2.5 rounded-md border border-white/5 bg-black/20 px-2.5 py-2 text-[11px] text-gray-500">
                    복구 진행률 — <span className="text-gray-400">확인 불가</span> · 위 수치는 조회에 실패한 값이라 0 으로 보입니다
                  </div>
                )
              const remain = ceph.degraded + ceph.misplaced
              const peak = ceph.peakRemain
              // 복구 진행률 = 장애 직후 최대치(peak) 대비 얼마나 줄었는가.
              //   장애 발생 시점 0% → degraded/misplaced 가 모두 0 이 되면 100%.
              // (예전엔 (전체-남은)/전체 였는데, 그건 '정상 복제율'이라 복구 시작 전에도 70%대가 나왔다.)
              const pct = peak > 0 ? Math.min(100, Math.max(0, Math.round(((peak - remain) / peak) * 100))) : remain > 0 ? 0 : 100
              const done = remain === 0
              // 정상 복제율 — 전체 오브젝트 복제본 중 지금 정상인 비율(참고 지표)
              const healthPct = ceph.total > 0 ? Math.min(100, Math.max(0, ((ceph.total - remain) / ceph.total) * 100)) : null
              return (
                <>
                  <div className="mt-2.5 flex items-baseline justify-between text-[11px] text-gray-500">
                    <span title="장애 직후 남은 오브젝트 최대치를 0% 로 두고, 모두 복구되면 100% 가 됩니다.">
                      복구 진행률
                      {peak > 0 && <span className="ml-1 text-gray-600">(기준 {peak.toLocaleString()}개)</span>}
                    </span>
                    <span className={done ? 'text-emerald-300' : 'text-amber-300'}>{pct}%</span>
                  </div>
                  <div className="mt-1 h-2 overflow-hidden rounded-full bg-black/30">
                    {/* 색은 health 가 아니라 '남은 객체가 0인가'로 판단한다.
                        HEALTH_OK 이면서 리밸런스가 남아있는 구간이 실제로 존재해, health 기준이면
                        99% 남은 상태가 초록으로 보여 '완료'로 오인된다. */}
                    <div
                      className={'h-full transition-all ' + (done ? 'bg-emerald-500' : 'bg-amber-500')}
                      style={{ width: `${Math.max(3, pct)}%` }}
                    />
                  </div>
                  {healthPct != null && (
                    <div className="mt-1 text-right text-[10px] text-gray-600">
                      정상 복제율 {healthPct.toFixed(1)}% · 전체 {ceph.total.toLocaleString()}개
                    </div>
                  )}
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
            <div className="mt-2 flex justify-between gap-2 text-[11px] text-gray-500">
              <span title="ceph -s 의 recovery 항목(objects/s) — 초당 복구되는 오브젝트 수입니다.">
                {ceph.rate > 0
                  ? `복구 속도 · 초당 ${Math.round(ceph.rate).toLocaleString()}개 오브젝트`
                  : '복구 중인 오브젝트 없음 (복구 IO 정지)'}
              </span>
              {/* 조회 실패 시 원문이 실려 오므로 길다 — 줄이고 title 로 전문을 남긴다 */}
              <span className="min-w-0 truncate text-right" title={ceph.note}>
                {ceph.note}
              </span>
            </div>
          </>
        ) : (
          <div className="text-[12px] text-gray-500">Ceph 세션이 지정되지 않았습니다.</div>
        )}
      </div>

      {/* 4. 파드 — 네임스페이스별 카드 (Running 이 아닌 것만 · 배치 NODE) */}
      <SectionLabel
        n={4}
        text="네임스페이스별 파드 조회"
        right={
          podsAt ? (
            <span className={now - podsAt > staleLimit ? 'text-[11px] text-red-300' : 'text-[11px] text-gray-500'}>
              갱신 {fmtAgo(now - podsAt)}
            </span>
          ) : undefined
        }
      />
      {state.notReadyNodes?.length > 0 && (
        <div className="mb-2 flex items-start gap-1.5 rounded-md border border-red-500/30 bg-red-500/10 px-2.5 py-1 text-[11px] text-red-200">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" />
          <span>
            Ready 아닌 노드: <b>{state.notReadyNodes.join(', ')}</b> — 이 노드의 파드는 상태가 'Running' 으로 보여도
            확인된 것이 아닙니다(노드가 죽어도 API 서버는 한동안 Running 을 답합니다).
          </span>
        </div>
      )}
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
        <Activity size={15} /> 복구 타임라인
        <span className="text-[11px] text-gray-500">시:분:초 (검증 시작 후 경과)</span>
      </div>
      <div className="rounded-xl bg-panel-light/50 p-3.5 text-[12px]">
        <Timeline milestones={milestones} t0={t0} evKeys={evKeys} onEvidence={onEvidence} />
        <div className="mt-1.5 text-[11px] text-gray-500">
          마지막 갱신 {fmtClock(state.lastAt)}
          <span className="ml-2 text-gray-600">· 각 시각은 폴링 주기만큼(기본 5초) 오차가 있습니다</span>
        </div>
      </div>
      </div>
      {(hasServices || hasOpenstack) && (
        <>
          <div className="w-px shrink-0 bg-white/10" />
          <div className="min-h-0 w-[520px] shrink-0 space-y-4 overflow-y-auto p-4">
            {hasServices && (
              <ServicePanel units={state.serviceUnits} nodes={state.services} resolveName={resolveName} roles={state.roles} />
            )}
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
  // 조회를 못 한 것을 "✓ 이상 없음 · 0개" 로 그리면 안 된다 — 초록은 '확인했고 괜찮다'는 뜻이어야 한다
  const cleanEmpty = !p.unknown && scope === 'abnormal' && p.abnormalCount === 0
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
        {p.unknown ? (
          <span
            title={p.note}
            className="inline-flex items-center gap-1 rounded bg-red-500/20 px-1.5 py-0.5 text-[12px] font-medium text-red-300"
          >
            확인 불가
          </span>
        ) : cleanEmpty ? (
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
              {pod.nodeNotReady && (
                <span
                  title="배치된 노드가 Ready 가 아닙니다 — 이 파드 상태는 낡은 값입니다"
                  className="shrink-0 rounded-full bg-red-500/25 px-2 py-0.5 text-[11px] text-red-200"
                >
                  노드 NotReady
                </span>
              )}
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
function SvcCell({ state, role }: { state: SvcState | 'down'; role?: SvcRole }) {
  const [baseCls, baseLabel] = SVC_CELL[state] ?? SVC_CELL.unknown
  const cls = role?.cls ?? baseCls
  const label = role?.label ?? baseLabel
  return (
    <div className={'truncate rounded px-1 py-1 text-center text-[10.5px] ' + cls} title={role?.title ?? label}>
      {label}
    </div>
  )
}

/** 범례 한 칸 — 표의 칸과 같은 색 견본 + 짧은 설명 */
function LegendChip({ cls, label, text }: { cls: string; label: string; text: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className={'rounded px-1.5 py-px text-[10px] ' + cls}>{label}</span>
      <span>{text}</span>
    </span>
  )
}

/** 셀 하나의 역할 표시 — 라벨·색을 덮어쓴다. abnormal=false 면 '중지' 여도 이상으로 세지 않는다(대기 노드) */
interface SvcRole {
  label: string
  cls?: string
  title: string
  abnormal: boolean
}
const ROLE_STANDBY_CLS = 'bg-sky-500/10 text-sky-300/80'
/**
 * 유닛 u 가 노드 n 에서 맡은 역할.
 *  - pacemaker 가 이 유닛을 리소스(`systemd:<유닛>`)로 관리하면: 도는 노드 = (m), 나머지 클러스터 노드 = (s) 대기.
 *    대기 노드에서 유닛이 inactive 인 건 **정상**이다 — 예전처럼 빨간 '중지' 로 그리면 안 된다.
 *  - pacemaker 유닛 행에는 DC 노드를 표시한다.
 *  - 그 밖의 데몬(rabbitmq·memcached·httpd …)은 모든 노드가 같은 일을 해 주/보조가 없다 — 표시하지 않는다.
 */
function svcRoleOf(u: string, nodeId: string, state: SvcState, roles: BoardRoles | null): SvcRole | undefined {
  if (!roles) return undefined
  const key = svcKey(u)
  if (key === 'pacemaker' && roles.dcId === nodeId && state === 'active')
    return { label: 'active (DC)', title: `pacemaker DC — 클러스터 결정을 내리는 노드 (${roles.dc})`, abnormal: false }
  const res = roles.resources.find((r) => r.unit && svcKey(r.unit) === key)
  if (!res || !res.ownerIds.length) return undefined
  /**
   * pcs 가 이번 프레임에 답하지 않아 **직전 역할**을 쓰는 중이면 '대기(정상)' 로 덮지 않는다.
   * 주 노드를 죽인 직후 pcs 가 몇 프레임 응답하지 않는 사이, 새 노드에서 리소스가 못 떠 inactive 인 것이
   * 옛 역할 때문에 조용한 '대기' 로 보이고 이상 개수에서도 빠졌다(조회 실패 ≠ 정상).
   */
  if (roles.staleSec && state !== 'active') return undefined
  const isOwner = res.ownerIds.includes(nodeId)
  const isStandby = res.standbyIds.includes(nodeId)
  const inCluster = roles.clusterIds.includes(nodeId)
  const where = `pacemaker 리소스 ${res.name} — ${res.owners.join(', ')} 에서 실행`
  if (isOwner) return state === 'active' ? { label: 'active (m)', title: where, abnormal: false } : undefined
  if (isStandby) return state === 'active' ? { label: 'active (s)', title: `${where} · 이 노드는 보조`, abnormal: false } : undefined
  if (!inCluster) return undefined
  if (state === 'inactive') return { label: '대기 (s)', cls: ROLE_STANDBY_CLS, title: `${where} · 이 노드는 대기(정상)`, abnormal: false }
  if (state === 'active')
    return {
      label: 'active ?',
      cls: 'bg-amber-500/15 text-amber-300',
      title: `${where}이라고 pcs 가 보고했는데 이 노드에서도 active 입니다 — 전환 중이거나 두 곳에서 도는 중일 수 있습니다`,
      abnormal: false,
    }
  return undefined
}

// 노드별 서비스 데몬 상태 매트릭스 (행=유닛, 열=노드). systemctl is-active 결과.
function ServicePanel({
  units,
  nodes,
  resolveName,
  roles,
}: {
  units: string[]
  nodes: NodeSvc[]
  resolveName: (id: string, fallback: string) => string
  roles: BoardRoles | null
}) {
  const roleAt = (u: string, n: NodeSvc) => svcRoleOf(u, n.id, n.states[svcKey(u)] ?? 'unknown', roles)
  // 이상 = 로드됐지만 죽은 것(failed) 또는 멈춘 것(inactive). '없음'(미설치)·전환중(activating)·미상은 제외.
  // pacemaker 가 다른 노드에서 돌리는 리소스의 대기 노드(inactive)는 정상이라 세지 않는다.
  const abnormal = nodes.reduce(
    (acc, n) =>
      acc +
      (n.up
        ? units.filter((u) => {
            const st = n.states[svcKey(u)]
            if (st !== 'failed' && st !== 'inactive') return false
            return roleAt(u, n)?.abnormal !== false
          }).length
        : 0),
    0,
  )
  /** 데몬 행으로 이어지지 않는 pacemaker 리소스(int_vip 같은 ocf 리소스 · 표에 없는 유닛) — 아래에 따로 그린다 */
  const unitKeys = new Set(units.map(svcKey))
  const extraRes = (roles?.resources ?? []).filter(
    (r) => (r.ownerIds.length || r.standbyIds.length) && !(r.unit && unitKeys.has(svcKey(r.unit))),
  )
  const resCell = (r: BoardRoleRes, n: NodeSvc) => {
    if (!n.up) return <SvcCell key={n.id} state="down" />
    if (r.ownerIds.includes(n.id))
      return (
        <SvcCell
          key={n.id}
          state="active"
          role={{ label: r.standbys.length ? 'Promoted (m)' : '실행 (m)', title: `${r.name} (${r.agent || 'clone'}) — ${r.state}`, abnormal: false }}
        />
      )
    if (r.standbyIds.includes(n.id))
      return <SvcCell key={n.id} state="active" role={{ label: 'Unpromoted (s)', cls: ROLE_STANDBY_CLS, title: `${r.name} 보조`, abnormal: false }} />
    if (roles?.clusterIds.includes(n.id))
      return <SvcCell key={n.id} state="unknown" role={{ label: '대기 (s)', cls: ROLE_STANDBY_CLS, title: `${r.name} 은 ${r.owners.join(', ')} 에서 실행 — 이 노드는 대기`, abnormal: false }} />
    return <SvcCell key={n.id} state="unknown" role={{ label: '·', cls: 'bg-white/[0.03] text-gray-600/70', title: 'pacemaker 클러스터 밖 노드', abnormal: false }} />
  }
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
                title={resolveName(n.id, n.name)}
              >
                {svcShortName(resolveName(n.id, n.name))}
                {!n.up && ' ↓'}
              </div>
            ))}
            {units.map((u) => (
              <Fragment key={u}>
                <div className="sticky left-0 z-10 truncate bg-panel-light py-1 pr-2 font-mono text-[11px] text-gray-400" title={u}>
                  {u}
                </div>
                {nodes.map((n) => (
                  <SvcCell key={n.id} state={n.up ? (n.states[svcKey(u)] ?? 'unknown') : 'down'} role={n.up ? roleAt(u, n) : undefined} />
                ))}
              </Fragment>
            ))}
            {extraRes.length > 0 && (
              <div
                className="sticky left-0 z-10 bg-panel-light pt-1.5 text-[10px] font-medium text-gray-500"
                style={{ gridColumn: '1 / -1' }}
              >
                pacemaker 리소스{roles?.staleSec ? ` — pcs 응답 없음, ${roles.staleSec}초 전 역할` : ''}
              </div>
            )}
            {extraRes.map((r) => (
              <Fragment key={'res:' + r.name}>
                <div
                  className="sticky left-0 z-10 truncate bg-panel-light py-1 pr-2 font-mono text-[11px] text-gray-400"
                  title={`${r.name} (${r.agent || 'clone'})${r.group ? ` · 그룹 ${r.group}` : ''}`}
                >
                  {r.name}
                </div>
                {nodes.map((n) => resCell(r, n))}
              </Fragment>
            ))}
          </div>
        </div>
      </div>
      {nodes.some((n) => n.staleSec) && (
        <p className="mt-2 flex items-start gap-1.5 rounded-md bg-white/[0.04] px-2.5 py-1 text-[10.5px] text-gray-400">
          <RefreshCw size={11} className="mt-0.5 shrink-0" />
          <span>
            조회 실패로 <b className="text-gray-300">직전 값</b>을 표시 중 —{' '}
            {nodes
              .filter((n) => n.staleSec)
              .map((n) => `${svcShortName(n.name)} ${n.staleSec}초 전`)
              .join(' · ')}
          </span>
        </p>
      )}
      {/* 범례 — 한 문단으로 이어 쓰면 읽히지 않아(사용자 지적) 칸 모양 그대로 견본을 두고 짧게 단다 */}
      <div className="mt-2 space-y-1.5 rounded-md bg-white/[0.03] px-2.5 py-2 text-[10.5px] text-gray-500">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-gray-400">
            <code>systemctl show</code> 상태
          </span>
          <LegendChip cls={SVC_CELL.active[0]} label="active" text="정상" />
          <LegendChip cls={SVC_CELL.inactive[0]} label="중지" text="멈춤" />
          <LegendChip cls={SVC_CELL.notfound[0]} label="없음" text="설치 안 됨" />
          <LegendChip cls={SVC_CELL.down[0]} label="·" text="SSH 끊김(조회 불가)" />
          <LegendChip cls={SVC_CELL.unknown[0]} label="—" text="조회 실패" />
        </div>
        {roles && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="text-gray-400">pacemaker 역할</span>
            <LegendChip cls={SVC_CELL.active[0]} label="(m)" text="이 노드에서 실행" />
            <LegendChip cls={ROLE_STANDBY_CLS} label="(s)" text="대기 — 멈춰 있는 게 정상" />
            <LegendChip cls={SVC_CELL.active[0]} label="(DC)" text={`클러스터 결정 노드${roles.dc ? ` · ${roles.dc}` : ''}`} />
            <span className="text-gray-600">rabbitmq·memcached 등 pacemaker 밖 데몬은 역할 없음</span>
          </div>
        )}
      </div>
    </>
  )
}

// OpenStack 서비스 매트릭스 셀 — 작동상태(up/down)=색, 이용상태 disabled=주황 테두리. 없으면 '·'.
function OsCell({ s }: { s?: OsSvc }) {
  // 해당 노드에 그 서비스가 없음(정상) — 구멍처럼 안 보이게 은은한 '해당 없음' 타일로 채운다
  if (!s) return <div className="rounded bg-white/[0.03] px-1 py-1 text-center text-[10.5px] text-gray-600/70">·</div>
  const base = s.up ? 'bg-emerald-500/15 text-emerald-300' : 'bg-red-500/25 text-red-300'
  // disabled 는 테두리로만 표시한다. 예전엔 별표(*)도 같이 찍었는데, 노드 재기동 중
  // masakari 가 nova-compute 를 일부러 disable 한 정상 상황에서 '이상' 처럼 보였다.
  const ring = s.enabled ? '' : ' ring-1 ring-inset ring-amber-400/70'
  return (
    <div
      className={'truncate rounded px-1 py-1 text-center text-[10.5px] ' + base + ring}
      title={(s.up ? 'up (작동 중)' : 'down (응답 없음)') + (s.enabled ? '' : ' · disabled — 관리상 중지(evacuation 중 정상적으로 발생)')}
    >
      {s.up ? 'up' : 'down'}
    </div>
  )
}

// OpenStack 서비스(API) — 위 서비스 데몬 패널과 동일한 매트릭스(행=서비스명, 열=노드).
//  scope='abnormal': 이상(down/disabled) 있는 서비스 행만 / 'all': 전체 행.
function OpenstackPanel({ os, scope }: { os: OsStat; scope: 'abnormal' | 'all' }) {
  const hosts = Array.from(new Set(os.rows.map((s) => s.host))).sort()
  const cell = new Map<string, OsSvc>() // `${binary}\u0000${host}` → 인스턴스
  for (const s of os.rows) cell.set(s.binary + '\u0000' + s.host, s)
  const at = (b: string, h: string) => cell.get(b + '\u0000' + h)
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
        <span className="ml-auto flex items-center gap-1.5">
          {os.downCount > 0 && (
            <span
              title="서비스가 응답하지 않습니다 (State/Alive down) — 실제 장애"
              className="rounded-full bg-red-500/20 px-2 py-0.5 text-[11px] font-medium text-red-300"
            >
              이상 {os.downCount}
            </span>
          )}
          {os.disabledCount > 0 && (
            <span
              title="서비스는 살아있지만 관리상 중지(disabled) 상태입니다. evacuation 중 masakari 가 nova-compute 를 비활성화하는 정상 동작일 수 있으니 확인만 하면 됩니다."
              className="rounded-full bg-amber-500/20 px-2 py-0.5 text-[11px] font-medium text-amber-300"
            >
              확인필요 {os.disabledCount}
            </span>
          )}
        </span>
      </div>
      <div className="rounded-xl border border-white/10 bg-panel-light p-2">
        {os.errors.length > 0 && (
          <div className="mb-2 flex items-start gap-1.5 rounded-md bg-amber-500/10 px-2.5 py-1 text-[11px] text-amber-300">
            <AlertTriangle size={12} className="mt-0.5 shrink-0" />
            <span>{os.errors.join(' · ')} — rc 경로·권한, openstack CLI 설치를 확인하세요.</span>
          </div>
        )}
        {/* 실패를 빈 결과로 반영하면 행·열이 사라져 '서비스가 없어졌다' 로 읽힌다 — 값은 지키고 사실만 밝힌다 */}
        {os.stale.length > 0 && (
          <div className="mb-2 flex items-start gap-1.5 rounded-md bg-white/[0.04] px-2.5 py-1 text-[11px] text-gray-400">
            <RefreshCw size={12} className="mt-0.5 shrink-0" />
            <span>
              이번 주기 조회 실패 — <b className="text-gray-300">{os.stale.join(' · ')}</b> 값을 그대로 표시하고 있습니다.
            </span>
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
          up(초록)·down(빨강)=작동상태(살아있음) · <span className="text-amber-300">주황 테두리</span>=관리중지(disabled, evacuation 중 정상 발생) · <span className="text-gray-600">·</span>빈칸=해당 노드에 없는 서비스(정상).
        </p>
      </div>
    </>
  )
}

function SectionLabel({ n, text, right }: { n: number; text: string; right?: ReactNode }) {
  return (
    <div className="mb-1.5 flex items-center gap-1.5 text-[13px] text-gray-300">
      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-blue-600/40 text-[11px] text-blue-100">{n}</span>
      {text}
      {right && <span className="ml-auto shrink-0">{right}</span>}
    </div>
  )
}
function TimelineRow({
  at,
  t0,
  icon,
  text,
  sub,
  server,
  showDate,
  onEvidence,
}: {
  at: number
  t0: number
  icon: React.ReactNode
  text: string
  sub?: string
  /** 서버 기록 시각 배지 — 있으면 본문 아래 줄에 따로 단다 */
  server?: string
  /** 지난 회차를 볼 때는 시:분:초만으로 언제 일인지 알 수 없으므로 날짜까지 표기 */
  showDate?: boolean
  /** 이 줄의 증적(서버 원문) 열기 — 저장된 증적이 있을 때만 */
  onEvidence?: () => void
}) {
  return (
    <div className="flex items-baseline gap-2.5 py-1">
      <span
        className={
          'shrink-0 whitespace-nowrap font-medium text-gray-100 tabular-nums ' +
          (showDate ? 'w-[140px]' : 'w-[62px]')
        }
      >
        {showDate ? fmtDateTime(at) : fmtClock(at)}
      </span>
      <span className="w-[46px] shrink-0 whitespace-nowrap text-[11px] text-gray-500 tabular-nums">+{fmtElapsed(at - t0)}</span>
      <span className="shrink-0 translate-y-0.5">{icon}</span>
      <span className="min-w-0 flex-1 text-gray-200">
        {text}
        {sub && <span className="ml-1.5 text-[11px] text-gray-500">{sub}</span>}
        {server && (
          <span className="mt-0.5 block">
            <span
              className="inline-flex items-center gap-1 rounded bg-emerald-500/10 px-1.5 py-px text-[10.5px] text-emerald-300/90"
              title="서버(pacemaker · k8s)가 스스로 기록한 시각 — 판정에는 쓰지 않고 근거로 나란히 보여 줍니다"
            >
              <Server size={10} /> {server}
            </span>
          </span>
        )}
      </span>
      {onEvidence && (
        <button
          onClick={onEvidence}
          title="이 시각의 근거가 된 서버 원문(로그·pacemaker 기록·k8s 기록) 보기"
          className="inline-flex shrink-0 items-center gap-1 self-start rounded border border-white/10 px-1.5 py-0.5 text-[10.5px] text-gray-300 hover:bg-white/10"
        >
          <FileText size={11} /> 증적
        </button>
      )}
    </div>
  )
}

interface TimelineItem {
  at: number
  icon: React.ReactNode
  text: string
  sub?: string
  /** 이 줄의 증적 key — 저장돼 있으면 [증적] 버튼이 붙는다 */
  ev?: string
  /**
   * 서버가 스스로 남긴 시각(pacemaker start · k8s Ready). 처음엔 sub 문구 끝에 이어 붙였는데, 긴 줄이
   * 중간에서 접혀 읽기 어려웠다(사용자 지적) — 툴 시각과 구분되는 별도 배지로 다음 줄에 둔다.
   */
  server?: string
}
/**
 * 복구 타임라인 — 검증 시작 → 노드 DOWN → VIP 이동 → evacuation → 파드 → Ceph → 세션 재연결.
 * 마일스톤을 절대시각으로 들고 있으므로 시:분:초와 경과를 함께 보여준다.
 * 화면 타임라인과 회차 내보내기(Markdown)가 같은 줄을 쓴다 — 둘이 다른 내용을 말하면 안 된다.
 */
function buildTimelineRows(m: Milestones, t0: number): TimelineItem[] {
  // 파드 복구는 워크로드가 많으면 줄이 폭주하므로 네임스페이스별 '마지막 복구 시각'으로 접는다
  // 네임스페이스별 첫 복구 / 마지막 복구 / 복구된 워크로드 수
  const podByNs = new Map<string, { first: number; last: number; count: number; sample: string }>()
  for (const p of m.pods) {
    const cur = podByNs.get(p.ns)
    if (!cur) podByNs.set(p.ns, { first: p.at, last: p.at, count: 1, sample: p.workload })
    else
      podByNs.set(p.ns, {
        first: Math.min(cur.first, p.at),
        last: Math.max(cur.last, p.at),
        count: cur.count + 1,
        sample: cur.sample,
      })
  }
  /** 네임스페이스별 '비정상 0이 된' 시각 — 여러 번 있었으면 가장 늦은 것 */
  const doneByNs = new Map<string, number>()
  /** 그 완료 시각에 떠 둔 클러스터 기록의 Ready 시각 */
  const readyByNs = new Map<string, number | undefined>()
  for (const d of m.podsDone ?? []) {
    if (d.at >= (doneByNs.get(d.ns) ?? 0)) {
      doneByNs.set(d.ns, d.at)
      readyByNs.set(d.ns, d.readyAt)
    }
  }
  /**
   * 예전에 저장된 이력에는 podsDone 자체가 없다(필드가 생기기 전 회차).
   * 그 회차는 예전 방식 그대로 한 줄로 그린다 — 지난 기록의 모양이 바뀌면 비교가 안 된다.
   */
  const legacyPods = m.podsDone === undefined
  const rows: TimelineItem[] = [
    { at: t0, icon: <Play size={13} className="text-gray-400" />, text: '검증 시작' },
  ]
  if (m.inject)
    rows.push({
      at: m.inject.at,
      icon: <Bolt size={13} className="text-amber-400" />,
      text: m.inject.source === 'manual' ? '장애 주입 (수동 입력)' : '장애 주입 (버튼)',
      sub:
        m.inject.source === 'manual'
          ? `${m.inject.note ? `${m.inject.note} · ` : ''}BMC 시계 기준일 수 있음`
          : m.down && m.down.source !== 'pre'
            ? `DOWN 감지까지 ${fmtElapsed(Math.max(0, m.down.at - m.inject.at))}`
            : undefined,
    })
  if (m.down)
    rows.push({
      at: m.down.at,
      icon: <Bolt size={13} className="text-red-400" />,
      text: m.down.source === 'pre' ? `호스트 DOWN — ${m.down.node} (검증 시작 전부터)` : `호스트 DOWN — ${m.down.node}`,
      sub:
        m.down.source === 'pcs'
          ? '(pcs OFFLINE 기준)'
          : m.down.source === 'ssh'
            ? '(SSH 끊김 기준 · 최대 90초 늦을 수 있음)'
            : '(DOWN 시각 불명 — 검증 시작 시점으로 표기)',
      server: m.down.srvAt ? `클러스터 저널 이탈 ${fmtClock(m.down.srvAt)}` : undefined,
      ev: m.down.source === 'pre' ? undefined : 'down',
    })
  if (m.vip)
    rows.push({
      at: m.vip.at,
      icon: <MapPin size={13} className="text-blue-400" />,
      text: `VIP 이동 — ${m.vip.from} → ${m.vip.to}`,
      sub: m.vip.with?.length ? `(함께 이동: ${m.vip.with.join(', ')})` : undefined,
      server: m.vip.pcmkAt ? `pacemaker 기록 start ${fmtClock(m.vip.pcmkAt)}` : undefined,
      ev: 'vip',
    })
  for (const r of m.roles ?? [])
    rows.push({
      at: r.at,
      icon: <MapPin size={13} className="text-amber-300" />,
      text: `역할 이동 — ${r.name}: ${r.from} → ${r.to}`,
      sub: '(pcs status 기준 · (m) 이 바뀐 순간)',
      ev: `roles:${r.at}`,
    })
  if (m.masakari)
    rows.push({
      at: m.masakari.at,
      icon: <CircleCheck size={13} className="text-emerald-400" />,
      /**
       * `by` 는 **masakari-engine 로그를 읽은 호스트**다 — VM 이 옮겨 간 호스트가 아니다.
       * 예전에는 `evacuation 완료 — con1` 처럼 노드명이 앞에 붙어, 'con1 으로 이동했다' 로
       * 읽히기 쉬웠다. 대수를 앞으로 빼고, 노드명은 '로그 출처' 라고 못박아 뒤로 보낸다.
       */
      text: `Masakari evacuation 완료${m.masakari.evac > 0 ? ` — ${m.masakari.evac}대` : ''}`,
      sub: `${m.masakari.by} 의 masakari-engine 로그 기준 (이동 대상 호스트 아님)`,
      server: m.masakari.vms
        ? `Nova VM ${m.masakari.vms.count}대 · 첫 시작 ${fmtClock(m.masakari.vms.firstAt)} → 마지막 완료 ${fmtClock(m.masakari.vms.lastAt)}${m.masakari.vms.failed ? ` · 실패 ${m.masakari.vms.failed}` : ''}`
        : undefined,
      ev: 'masakari',
    })
  for (const [ns, v] of podByNs) {
    const detail = v.count > 1 ? `워크로드 ${v.count}개 (${v.sample} 외)` : v.sample
    if (legacyPods) {
      // 옛 회차 — 완료 시각을 알 수 없어 '마지막으로 관측된 복구' 를 그대로 쓴다
      rows.push({
        at: v.last,
        icon: <Server size={13} className="text-sky-400" />,
        text: `${ns} : 파드 복구 완료`,
        sub: detail,
      })
      continue
    }
    const done = doneByNs.get(ns)
    rows.push({
      at: v.first,
      icon: <Server size={13} className="text-sky-400/60" />,
      text: `${ns} : 파드 복구 시작`,
      sub: done ? `첫 복구 ${v.sample}` : `아직 완료 아님 — 워크로드 ${v.count}개 복구됨`,
    })
    if (done)
      rows.push({
        at: done,
        icon: <Server size={13} className="text-sky-400" />,
        text: `${ns} : 파드 복구 완료`,
        sub: `비정상 워크로드 0 · ${detail}`,
        server: readyByNs.get(ns) ? `클러스터 기록 Ready ${fmtClock(readyByNs.get(ns) as number)}` : undefined,
        ev: `pods:${ns}`,
      })
  }
  if (m.ceph)
    rows.push({
      at: m.ceph.at,
      // HEALTH_OK 까지 안 갔으면 초록으로 칠하지 않는다 — '다 끝났다' 로 읽히면 안 된다.
      icon: <CircleCheck size={13} className={m.cephHealthy ? 'text-emerald-400' : 'text-amber-400'} />,
      text: 'Ceph 데이터 복구 완료 — degraded · misplaced 0',
      sub: m.cephHealthy ? undefined : 'HEALTH_OK 아직 아님 — 복제와 무관한 경고가 남아 있습니다',
      server: m.ceph.srvAt ? `Ceph 기록 ${fmtClock(m.ceph.srvAt)}` : undefined,
      ev: 'ceph',
    })
  if (m.cephHealthy)
    rows.push({
      at: m.cephHealthy.at,
      icon: <CircleCheck size={13} className="text-emerald-400" />,
      text: 'Ceph HEALTH_OK — 경고 해소',
      server: m.cephHealthy.srvAt ? `Ceph 기록 ${fmtClock(m.cephHealthy.srvAt)}` : undefined,
      ev: 'cephHealthy',
    })
  for (const r of m.rejoin ?? [])
    rows.push({ at: r.at, icon: <Server size={13} className="text-emerald-400" />, text: `클러스터 재합류 — ${r.node}`, sub: '(pcs Online 복귀)' })
  for (const r of m.k8sReady ?? [])
    rows.push({ at: r.at, icon: <Server size={13} className="text-emerald-400" />, text: `k8s 노드 Ready — ${r.node}` })
  if (m.osdUp)
    rows.push({
      at: m.osdUp.at,
      icon: <CircleCheck size={13} className="text-emerald-400" />,
      text: `Ceph OSD 전부 up — ${m.osdUp.up}/${m.osdUp.total}`,
    })
  if (m.reconnect)
    rows.push({
      at: m.reconnect.at,
      icon: <Activity size={13} className="text-emerald-400" />,
      text: `세션 재연결 — ${m.reconnect.node}`,
      server: m.reconnect.bootAt ? `부팅 ${fmtClock(m.reconnect.bootAt)}` : undefined,
      ev: 'reconnect',
    })
  for (const p of m.portal ?? [])
    rows.push({
      at: p.at,
      icon: <Globe size={13} className="text-violet-400" />,
      // 시각만 적으면 '왜 이때인가' 를 알 수 없다. 무엇이 이 시각을 확정했는지 같이 적는다.
      text: `${p.name} 200 OK${p.streak ? ` (${p.streak}회 연속 성공)` : ''}`,
      sub: p.group && p.group !== p.name ? `(${p.group})` : undefined,
    })
  rows.sort((a, b) => a.at - b.at)
  return rows
}

function Timeline({
  milestones: m,
  t0,
  showDate,
  evKeys,
  onEvidence,
}: {
  milestones: Milestones
  t0: number
  showDate?: boolean
  /** 이 회차에 저장된 증적 key 들 */
  evKeys?: string[]
  onEvidence?: (key: string) => void
}) {
  const rows = buildTimelineRows(m, t0)
  return (
    <>
      {rows.map((r, i) => (
        <TimelineRow
          key={i}
          at={r.at}
          t0={t0}
          icon={r.icon}
          text={r.text}
          sub={r.sub}
          server={r.server}
          showDate={showDate}
          onEvidence={r.ev && onEvidence && evKeys?.includes(r.ev) ? () => onEvidence(r.ev as string) : undefined}
        />
      ))}
    </>
  )
}
