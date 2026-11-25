import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Activity,
  ChevronDown,
  ChevronRight,
  Globe,
  X,
  Play,
  Square,
  RefreshCw,
  MapPin,
  Bolt,
  CircleCheck,
  CircleX,
  Loader2,
  AlertTriangle,
  HeartPulse,
  Server,
  Settings2,
  Hourglass,
  Minus,
  Maximize2,
  HelpCircle,
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
import { parseDurationInput, fmtDuration } from '../lib/durationInput'
import { alignTabBlocks } from '../lib/textAlign'
import { arrangeEvidence, mergeSameCeph, resolveEvKey, strongFocusCount, tocEntries, tocLabel, podLogLabel, EV_GROUP_LABEL, type ArrangedEv } from '../lib/evidenceToc'
import { mergeLogIssues, recordDropped } from '../lib/podLogList'
import { cephHints, cephLineHot, cephLogLocal, cephLogTone, cephNote } from '../lib/cephView'
import { applyRunTruth, hasFinalBasis, hasFirstBasis, portalEvidenceView, portalStartAt, type PortalBasisRow, type PortalEvView, type PortalStreak } from '../lib/portalEvidence'
import { parseKubeAge } from '../lib/podStatus'
import { downBaseOf as downBaseLib, vipAtOf as vipAtLib } from '../lib/serverTime'
import { parseSpread, splitSpreadOutput, SPREAD_CMD, type SpreadWorkload, type SpreadVerdict } from '../lib/podSpread'
import { findValkeySets, judgeValkey, valkeyBad, valkeyCmd, valkeyEvidenceLines, valkeySummary, type ValkeyCheck } from '../lib/valkeySpread'
import { parseMasakari, UUID, MASAKARI_GREP, type MasakariState } from '../lib/masakariLog'
import { stripAnsi } from '../lib/ansi'
import { episodes, portalFromLog, portalPhases, portalLogText, portalPageRows, portalStreakTable, SAME_MS as PORTAL_SAME_MS, type PortalEvent } from '../lib/portalPhases'
import { addLatSamples, latencyView, latChange, fmtLat, latencyCompare, latCmpTop, type LatSample, type LatStat, type LatView, type PortalLatRec, type LatCmpRun, type LatCmpChange } from '../lib/portalLatency'
import ConfirmDialog from './ConfirmDialog'
import type { BoardEvidenceItem, BoardEvidenceTable, BoardHistoryRecord, LogTailTarget } from '../../electron/shared-types'
import { groupHeadline, newInRun, type LogGroup } from '../lib/podLogScan'
import { usePodLogWatch, LogIssuesModal, MergedLogModal, type LogWatchInfo } from './PodLogWatch'
import { envSame, envChanges } from '../lib/groupEnvDiff'
import { layoutPhase, blockRows, type ActGroup, type IssueView, type SumAction } from '../lib/phaseSummary'
import { buildEnvMap, renderEnvMapHtml, renderEnvDiffHtml, roleText, NODE_SCRIPT, CTRL_SCRIPT, OS_CMDS, segHostsCmd, CEPH_SCRIPT, K8S_SCRIPT, jsonOf, type EnvMapRaw, type EnvMapSnapshot, type OsVerChange } from '../lib/envMap'

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
  /**
   * 그 세션의 로그 파일을 실시간 로그 창으로 연다 — Masakari 카드의 [로그](사용자 요청: 매번 실시간 로그로 가서 경로를 고르지
   * 않게). 창이 이미 열려 있으면 App 이 두 번째 패널에 연다.
   */
  onOpenLiveLog?: (sessionId: string, path: string | LogTailTarget) => void
  /** 글을 AI 분석 창으로 넘긴다(파드 로그 합친 창의 [AI 분석]) — 보드는 접어 두어야 답이 보인다 */
  /** part: 무엇을 보내는지 — 있으면 AI 분석 창이 터미널용 고르기(선택 영역 · 최근 200줄 · 500줄) 대신 이 한 줄만 보인다 */
  onAnalyzeText?: (text: string, label: string, part?: string) => void
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
  /** 파드 로그 이상 감시(10-28) — 상태보드를 띄워 두면 늘 돈다. 끄면 훑지 않는다 */
  logWatch?: boolean
  /** 훑는 주기(초) — 기본 60 */
  logWatchSec?: number
  /** 무시 문구(글자 그대로 포함되면 버림) · 더 찾을 단어 */
  logIgnore?: string[]
  logWords?: string[]
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
// systemd 로 실제 관리되는 데몬만 기본값에 둔다. glance/cinder/mariadb 처럼 컨테이너·WSGI 로 도는 서비스는
// systemctl 로 안 잡혀 오탐이 나므로 제외(그런 서비스는 `openstack ... service/agent list` 로 확인 — 별도 방식).
//
// **Rocky(RDO 패키지) 이름 기준**(2026-11-09, 표준이 Ubuntu → Rocky 로 바뀜 · contrabass01 의 systemctl list-units 로 확인):
//  - nova 는 Rocky 에서 systemd 서비스로 돈다 → `openstack-nova-*` 로 감시에 넣었다(예전엔 컨테이너라 뺐다)
//  - Ubuntu 이름 `nova-compute` · `masakari-hostmonitor` 는 `openstack-nova-compute` · `masakari-host-monitor` 로
//  - `masakari-instancemonitor` · `masakari-processmonitor` 는 이 환경에 설치돼 있지 않아 뺐다
//  - libvirt 는 Rocky 9 기본이 분리형(virtqemud)이지만 이 환경은 `libvirtd`(legacy)가 돈다 — 그대로 둔다
// 이름이 맞지 않는 유닛은 '없음' 으로 보일 뿐 '중지' 로 오탐하지는 않는다(LoadState=not-found).
const SVC_PRESETS = {
  controller: [
    'rabbitmq-server', 'memcached',
    'neutron-server', 'httpd',
    'openstack-nova-api', 'openstack-nova-conductor', 'openstack-nova-scheduler',
    'masakari-api', 'masakari-engine',
    'pacemaker', 'corosync', 'pcsd',
  ],
  compute: [
    'libvirtd', 'openstack-nova-compute', 'neutron-openvswitch-agent',
    'masakari-host-monitor',
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
 * 상태(idle · progress · error · failed …)의 뜻은 lib/masakariLog.ts 의 MasakariState 주석.
 * idle 을 'progress' 로 뭉개면 아무 일도 없는데 스피너가 돌고, error 를 못 보면 실패한 엔진이 영원히 '진행 중' 이다.
 */
interface MasakariStat {
  id: string
  name: string
  state: MasakariState
  detail: string
  evac: number // T0 이후 evacuation 대상으로 감지된 인스턴스 수
  /** 그 인스턴스 id — 엔진 여러 대가 같은 알림을 이어받으면 노드 합계를 겹치지 않게 센다 */
  uuids?: string[]
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
  /** 이 값을 만든 `ceph -s` 원문과 받은 시각 — [상세 보기] 창의 ceph -s 탭(폴링이 이미 돌리는 명령이라 명령을 더 보내지 않는다) */
  raw?: string
  rawAt?: number
}
interface PodRow {
  name: string
  ready: string // READY 컬럼 (예: "1/1", "0/1")
  status: string
  node: string
  /** RESTARTS 칸 원문("3" · "5 (23h ago)") · AGE · 파드 IP — 확대 창에서만 쓴다(-o wide 에 이미 있어 추가 조회 없음) */
  restarts?: string
  age?: string
  ip?: string
  /** 검증 시작 뒤에 생긴 파드(AGE 로 계산 — 분 단위 오차) — 복구로 새로 뜬 것을 눈에 띄게 한다 */
  isNew?: boolean
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
  abnormalCount: number // 표시 범위와 무관하게 항상 비정상 개수(확인 불가 포함 — 종합 판정 기준)
  /** 그중 NotReady 노드 위라 '확인 불가' 인 것 — 복구 측정에서 빼는 행. 표에서 진짜 비정상과 나눠 보인다 */
  unsureCount?: number
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
  vip?: { at: number; from: string; to: string; pcmkAt?: number; /** VIP 와 같은 리소스 그룹이라 함께 옮겨 간 리소스: 역할 이동 줄을 따로 두지 않는다 */ with?: string[] }
  /** masakari evacuation 완료 */
  masakari?: {
    at: number
    by: string
    evac: number
    /**
     * Nova 의 VM 별 evacuation 기록 요약(증적) — 첫 VM 시작 · 마지막 VM 완료 · 대수 · 실패.
     * masakari 의 'finished' 는 알림 하나가 끝났다는 뜻이라, 20대를 옮길 때 각 VM 이 언제 끝났는지는 Nova 에 있다.
     */
    vms?: { count: number; failed: number; firstAt: number; lastAt: number; pending?: number; /** 옮기지 못한 VM 이름(Nova, 2026-11-11 부터) — 리포트 '실패 원인' */ failedNames?: string[] }
    /**
     * Nova 기록을 끝내 읽지 못함(다섯 번 다시 물어도 조회 실패) — 'VM 모두 옮김' 으로 보면 안 된다(코드 점검 10-30: 조회 실패 ≠ 성공).
     * pending 은 다시 물은 뒤에도 끝나지 않은 VM 수 — 사용자 기준(VM 이 모두 옮겨져야 성공)으로 실패에 넣는다.
     */
    vmUnchecked?: boolean
  }
  /**
   * masakari 엔진이 알림을 **실패로 끝낸** 시각들(status: error · failed). 2026-10-26 검증에서 con02 엔진이 keystone 500
   * 으로 error → con03 이 이어받아 evacuate → 끝내 failed 였는데, 예전에는 finished 만 기록해 타임라인에 아무 흔적이 없었다.
   * error 는 masakari 가 다시 집어 가므로 끝이 아니고, failed 는 확정이다. 총 소요(lastMilestoneAt)에는 넣지 않는다 — 복구가 아니다.
   */
  masakariFail?: { at: number; by: string; status: string; evac: number; /** 로그에서 읽은 실패 이유 요약 */ reason?: string; /** 그 짧은 꼴(타임라인 요약 한 줄용, 이 필드 전 회차엔 없다) */ brief?: string; /** 옮기지 못한 VM 수 */ failedVms?: number; /** 옮기지 못한 VM 이름(Nova 에서 찾음, 2026-11-11 부터 · 못 찾으면 없음) — 리포트 '실패 원인' */ failedVmNames?: string[] }[]
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
   * 완료(podsDone)된 네임스페이스가 **다시 비정상** 이 된 시각(연속 2프레임 확인, 시각은 첫 비정상 프레임).
   * 지우지 않고 남긴다 — '한 번 돌아왔다 다시 깨졌다' 자체가 검증 결과다(2026-10-26: 두 번째 k8s 노드가 늦게 빠지며
   * 이미 완료였던 boot-factory·ceph 가 Pending 으로 되돌아갔는데, 타임라인·판정·리포트는 모두 '완료' 였다).
   */
  podsBroken?: { at: number; ns: string; workloads: string[] }[]
  /**
   * k8s 노드가 NotReady 로 **새로** 바뀐 순간(같은 프레임에 바뀐 노드는 한 줄로). 첫 묶음은 호스트 DOWN 과 같은 일이고,
   * 뒤에 오는 묶음(+1 epoxy-manager2 같은)이 그 아래 '다시 비정상' 줄들의 원인이다 — 나란히 있어야 읽힌다.
   */
  k8sNotReady?: { at: number; nodes: string[] }[]
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
   * 정상화가 확정됐다가 **다시 끊긴** 포털 대상 — 그때의 정상화 시각(upAt)과 다시 끊긴 시각(downAt, 연속 실패의 첫 관측).
   * 예전에는 다시 끊기면 정상화 줄을 그냥 지워 '한 번 돌아왔다 다시 끊겼다' 가 기록에서 사라졌다(사용자 지적). `portal` 은
   * 그대로 '마지막 정상화' 만 들고(판정·리포트 기준은 최종 정상화) 흔들린 이력은 여기 남는다.
   */
  portalFlaps?: { name: string; group?: string; upAt: number; downAt: number }[]
  /**
   * 장애 뒤 끊겼다가 **아직 복구되지 않은** 포털 대상(회차를 저장·갱신한 시점 기준). 비어 있지 않으면 그 회차의
   * 포털은 미복구(Fail) — '포털 서비스 정상화' 를 돌아온 대상만으로 계산하지 않는다(사용자 기준: 모두 돌아와야 완료).
   */
  portalPending?: string[]
  /** 장애 뒤 감시한 포털 화면 전체(끊기지 않은 화면 포함) — 리포트 · 타임라인의 'n/n 화면' 분모(lib/portalPhases total 주석) */
  portalWatched?: string[]
  /**
   * 포털 감시의 판정이 바뀐 순간(처음 끊김 · 정상화 확정 · 다시 끊김 확정) — '포털 응답 기록' 증적의 원문(lib/portalPhases).
   * 대상별 '최초 끊김' 은 여기에만 있다. 이 필드 전의 회차에는 없다(1차 · 최종 정상화는 portal · portalFlaps 로 계산된다).
   */
  portalLog?: PortalEvent[]
  /** 포털 API 응답 시간(요청마다, lib/portalLatency) — 2026-11-19 부터. 옛 회차는 없고 리포트가 portalLog 의 정상화 확정 요청으로 대신한다 */
  portalLat?: PortalLatRec
  /**
   * 파드 로그에 **새로** 나온 오류(기준선 밖) — 검증 중에 처음 본 것만. 파드 표가 다 Running 이어도 서비스가 깨져 있는 경우를
   * 남기려는 것(10-28 boot-factory → valkey DNS 실패). 상세는 증적 'podlog:<at>'.
   * 복구 타임라인에는 넣지 않고 그 아래 따로 둔다(LogIssueList · 10-29 사용자 결정). count · last 는 검증 중 계속 갱신된다.
   */
  logIssues?: { at: number; ns: string; workload: string; text: string; level: 'error' | 'warn'; pods: number; key: string; count?: number; last?: number; ev?: string }[]
  /**
   * 회차당 한도(LOG_ISSUES_MAX)를 넘어 자세히 남기지 않은 새 오류 종류 — 개수와 처음 넘친 시각만(2026-11-07 사용자 결정).
   * keys 는 묶음 key 의 짧은 해시(같은 종류를 훑을 때마다 다시 세지 않게). 상한을 둬 이것 자체가 커지지 않게 한다.
   */
  logIssuesDropped?: { since: number; keys: string[] }
  /**
   * 장애를 **넣은** 시각 — DOWN 감지에는 감지 지연(pcs 수 초 · SSH 최대 90초)이 있어, 사용자가 체감한 중단 시작은 이보다 이르다.
   *  - button : 노드를 끈 순간 [장애 주입] 을 눌러 남긴 PC 시각
   *  - manual : 나중에 IPMI(BMC) 이벤트 로그의 전원 꺼짐 시각을 보고 사람이 넣은 값(note 에 출처). BMC 시계는 NTP 를
   *             안 쓰는 경우가 많아 수 분씩 틀리기도 한다 — 화면과 리포트에 그 사실을 함께 적는다.
   * 판정·총 소요에는 쓰지 않고 '주입 → 감지' 와 '주입부터의 시간' 을 나란히 보여 준다.
   */
  inject?: { at: number; source: 'button' | 'manual'; note?: string }
  /**
   * 이 회차에 무엇을 감시했나(시작할 때 설정에서) — '기록 없음' 이 '감시 안 함' 인지 '안 끝남' 인지 가르려고. 전체 복구(예전 서비스 복구)가
   * Masakari 세션을 지정하지 않은 회차까지 '미복구' 로 세던 것을 막는다(코드 점검). 이 필드 전의 회차는 기록이 있는지로 짐작한다.
   */
  watched?: { masakari: boolean }
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
    // 메인에도 같은 시간을 알린다 — 손 뗀 조회가 메인 줄에서 기다렸다 뒤늦게 실행되며 슬롯을 쥐던 것을 막는다(main.ts acquireExecSlot)
    window.electronAPI.sessionRun(id, cmd, timeoutMs),
    new Promise<RunResult>((resolve) => {
      tid = setTimeout(() => resolve({ ok: false, error: `응답 시간 초과(${timeoutMs / 1000}초)`, timedOut: true }), timeoutMs)
    }),
  ])
  if (tid) clearTimeout(tid)
  return r
}
/**
 * stderr 까지 받아 실행 — `ceph log last` 는 이 클러스터에서 결과를 stderr 로 냈다. sudoOr 는 sudo 쪽 stderr 를 버리므로 sudo 가
 * 성공(종료 0)하면 출력이 통째로 비었다(2026-11-07 dev: Ceph 상세의 클러스터 로그가 빈 결과 → 같은 명령으로 뜨는 Ceph 증적도 근거 줄 ·
 * 서버 기록 시각을 잃을 수 있었다). 둘을 합쳐 받고, sudo 가 비번을 요구한 줄('sudo: …')만 뺀다. 종료 코드를 같이 돌려준다.
 */
async function runMerged(id: string, cmd: string, timeoutMs: number): Promise<RunResult & { rc?: number }> {
  const r = await run(id, `(sudo -n ${cmd} || ${cmd}) 2>&1; echo "__QT_RC__$?"`, timeoutMs)
  const raw = r.out ?? ''
  const rc = raw.match(/__QT_RC__(\d+)/)?.[1]
  const out = raw
    .replace(/\n?__QT_RC__\d+\s*$/, '')
    .split('\n')
    .filter((l) => !/^sudo: /.test(l))
    .join('\n')
  return { ...r, out, rc: rc != null ? +rc : undefined }
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

// masakari 로그 판정(parseMasakari · lineTs · UUID)은 src/lib/masakariLog.ts, 색 코드 지우기는 src/lib/ansi.ts 에 있다
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
  // 여기서는 이번 프레임만 안다 — 복구를 본 적 있는지(peak)는 폴링이 다시 매긴다(lib/cephView cephNote)
  const note = cephNote(health, remain, remain)
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
  /** 검증 시작 시각 — 이 뒤에 생긴 파드를 '새 파드' 로 가린다(표시 전용) */
  t0?: number,
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
    let restarts: string | undefined
    let age: string | undefined
    let ip: string | undefined
    for (let idx = 3; idx < cols.length - 1; idx++) {
      const c = cols[idx]
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(c) || c.includes(':') || c === '<none>') {
        node = cols[idx + 1] ?? '-'
        // IP 앞이 AGE, 그 앞(3번째 칸부터)이 RESTARTS — "5 (23h ago)" 처럼 공백이 들어가도 이어 붙이면 원문이다
        ip = c
        age = idx - 1 >= 4 ? cols[idx - 1] : undefined
        restarts = idx - 1 > 3 ? cols.slice(3, idx - 1).join(' ') : undefined
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
    const ageMs = parseKubeAge(age)
    const isNew = t0 != null && ageMs != null && Date.now() - ageMs >= t0
    all.push({ name, ready, status, node, restarts, age, ip, healthy, ...(nodeNotReady ? { nodeNotReady: true } : {}), ...(isNew ? { isNew: true } : {}) })
  }
  const abnormalCount = all.filter((p) => !p.healthy).length
  const unsureCount = all.filter((p) => !p.healthy && p.nodeNotReady).length
  // 비정상(Running 아님/Ready 미충족)을 항상 맨 위로. 전체 보기에서 파드가 수십 개면
  // Terminating/Pending 이 중간에 묻혀 스크롤로 찾아야 하므로 정렬로 끌어올린다.
  // (같은 그룹 안의 순서는 kubectl 출력 순서 유지 — sort 는 안정 정렬)
  /**
   * 진짜 비정상(Pending 등) → 정상(검증 시작 뒤 새로 뜬 파드 먼저) → 확인 불가(NotReady 노드 위, 맨 아래) 순.
   * 처음엔 확인 불가를 정상보다 위에 뒀는데, 회색 줄이 카드 위쪽을 채워 **복구된 새 파드가 스크롤 아래에 묻혔다**(사용자 지적).
   */
  const rank = (p: PodRow) => (!p.healthy && !p.nodeNotReady ? 0 : p.healthy ? (p.isNew ? 1 : 2) : 3)
  const rows = (scope === 'all' ? [...all] : all.filter((p) => !p.healthy)).sort((a, b) => rank(a) - rank(b))
  // 줄은 있었는데 파드로 읽힌 것이 하나도 없다 = kubectl 이 다른 것을 찍었다 — '없음' 이 아니라 '모름'
  if (all.length === 0) return { namespace, total: 0, abnormalCount: 0, rows: [], note: '파드 목록을 읽지 못함', unparsed: true }
  return { namespace, total: all.length, abnormalCount, unsureCount, rows, note: '' }
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
/** 예전 이력 저장 위치(localStorage) — 지금은 파일(statusboard-history/)로 옮긴 뒤 읽기만 한다(처음 한 번 옮기기 · 리포트 하네스) */
const HIST_KEY = 'statusboard_history_v1'
/**
 * 이력 보관 한도 — 그룹에 들지 않은 회차만 센다(2026-11-13: 파일 저장으로 옮기며 50 → 500).
 * 검증 그룹에 넣은 회차는 버전별 기록이라 자동으로 지우지 않는다. 지우는 것은 사람이 이력 창에서만.
 */
const HIST_MAX = 500
/**
 * 회차당 '파드 로그 이상' 을 자세히 남기는 종류(묶음) 수 — 로그 줄 수가 아니다(같은 오류는 횟수만 오른다).
 * 이력은 localStorage 에 최근 50회차를 통째로 저장한다. 10-30 회차는 25종류에 12.6KB 였고, 시끄러운 클러스터에서 오래 검증해
 * 회차마다 수백 종류가 쌓이면 50회차 합이 저장 한도(약 5MB)를 넘어 **이력 저장 자체가 실패**한다(코드 점검 11-07).
 * 넘친 종류는 개수만 남기고 증적도 만들지 않는다. 이력을 파일 저장으로 옮기면 다시 볼 값이다.
 */
const LOG_ISSUES_MAX = 150
/** 넘친 종류의 해시를 몇 개까지 들고 있을지 — 이것도 이력에 들어가므로 끝없이 늘지 않게 */
const LOG_DROPPED_KEYS_MAX = 3000
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
  /** 세부 원인 및 조치(RunNote 주석) — 검증이 끝난 뒤 이력 창에서 사람이 적는다 */
  notes?: RunNote[]
  /** 결과 변경(RunOverride 주석) — 앱 판정이 실패인 회차를 사람이 성공으로 본 것 */
  override?: RunOverride
  /** 속한 검증 그룹 · 차수(VerifyGroup 주석). 없으면 그룹 없음 */
  groupId?: string
  phaseId?: string
}
/**
 * 회차의 세부 원인 및 조치(2026-11-11 사용자 결정 · 목업 cause-mock · total-mock6). 앱은 '무엇이 실패했나(Masakari · 포털)' 까지만 안다.
 * 그 안에서 무엇이 원인이었는지 · 누가 무엇을 조치했는지는 담당자가 분석한 뒤에 알게 되므로 이력 창에서 적고, 리포트 '실패 원인' 표의
 * 오른쪽 칸 · 회차별 상세에 그대로 싣는다. 이름 · 장애 주입 시각처럼 회차 기록에 같이 둔다(이력이 있는 곳에 같이 있어야 한다).
 *
 * 'manual'(수동 조치)은 앱이 성공으로 본 회차에 사람이 손댄 것 — 11-11 회차: coredns 파드 2개가 한 노드에 있어 포털이 돌아오지 않았는데,
 * 담당자가 파드를 강제로 지워 정상화됐다. 앱이 보기엔 성공이다. 누가 지웠는지 앱이 알 수 없고(다른 터미널), 노드가 죽으면 k8s 도 파드를
 * 지우므로 앱이 짐작해 실패로 바꾸지 않는다 — 사람이 recovered 를 켜면 그 회차는 **실패**로 센다(사용자 결정: 판정 이름은 실패).
 */
interface RunNote {
  step: 'masakari' | 'portal' | 'manual'
  /**
   * 이슈 — 필수(비면 저장하지 않는다). 예전 이름은 '세부 원인' 이었고 실제로는 '무엇이 일어났나'(마사카리 실패 - VM 11대 중 7대 실패)를
   * 적어 왔다. 2026-11-19 사용자 결정으로 화면 이름을 '이슈' 로 바꾸고 원인(why)을 따로 받는다 — 필드 이름(cause)은 저장된 기록과 맞추려 그대로 둔다
   */
  cause: string
  /** 원인(2026-11-19 추가) — 왜 그랬나. 그룹 리포트 차수별 요약의 '원인' 칸으로 간다(notesToPhase). 옛 기록에는 없다 */
  why?: string
  action?: string
  /** 담당자 — 'XX팀 이름' */
  owner?: string
  /** 조치 시각(epoch ms) — 적으면 회차별 상세 타임라인에 '사람 조치' 줄로 들어간다 */
  at?: number
  /** manual 만: 이 조치가 없었으면 복구되지 않았음 → 회차는 실패, 잰 시간은 표에 남기고 평균에서 뺀다 */
  recovered?: boolean
}
const NOTE_STEP_LABEL: Record<RunNote['step'], string> = { masakari: 'Masakari', portal: '포털', manual: '수동 조치' }
/**
 * 결과 변경(2026-11-16 사용자 결정 · 목업 verdict-override-mock A 안). 3회차 1세트(contrabass02)는 Masakari 엔진이 최종 실패로 끝냈지만
 * 2대가 재시도로 옮겨져 VM 10대가 모두 넘어갔고, 보고받는 쪽이 Masakari 를 성공으로 보자고 했다. 앱 판정은 바꾸지 않고(증적 · 마일스톤 ·
 * 타임라인은 그대로) 사람이 실패한 **단계마다** '성공으로 결과 변경' 을 켜고 이유를 적는다(이유 필수 — 비면 켜지지 않은 것으로 본다).
 * 단계별인 이유(사용자 확인): Masakari · 포털이 둘 다 실패한 회차에서 Masakari 만 바꾸면 포털은 실패 그대로고 회차도 포털 때문에 실패다.
 * 회차 전체를 한 번에 성공으로 뒤집는 꼴로 만들었다가 이 질문으로 바꿨다 — 바꾸지 않은 실패까지 덮으면 안 된다.
 * 리포트(사용자 결정): 바꾼 단계는 그냥 '성공' 으로 센다(Masakari 카드 포함) — '판정 변경' 표시 · 툴 판정 문구 · 각주를 싣지 않는다.
 * 바꾼 단계가 있는 회차의 전체 복구 칸은 '-'(완료 시각이 없다 · 평균에서 뺌), 바꾼 단계는 실패 원인 표에서 빠진다.
 * 앱 안(이력 목록)에서만 노란 '성공 (결과 변경)' 과 이유가 보인다 — 바꾼 사실이 앱에서까지 사라지면 다음 사람이 이유를 모른다.
 * 반대 방향(성공 → 실패)은 RunNote 의 '이 조치가 없었으면 복구되지 않았음' 이 맡는다
 * 이유는 단계마다(2026-11-17 사용자 결정 · 목업 ov-reason-mock 안 B): 칸이 하나면 Masakari · 포털 둘 다 바꿀 때 두 이유를 한 글에 섞어 써야 했고,
 * 나중에 어느 문장이 어느 단계 이유인지 가려 읽어야 했다. 체크한 단계마다 이유가 필수다.
 */
type OvStep = 'masakari' | 'portal'
interface RunOverride {
  /** 성공으로 바꾼 단계 */
  steps: OvStep[]
  /**
   * 단계별 이유를 한 글로 붙인 것('Masakari: …' 줄). 2.17.4 까지는 이유 칸이 하나라 이것만 있었다 — 그 기록은 reasons 가 없고
   * 이 글이 모든 바꾼 단계의 이유다(reasonOf). 2.17.4 설치본이 새 기록을 읽어도 결과 변경이 켜진 채로 보이게 계속 채운다
   */
  reason: string
  /** 단계별 이유(2026-11-17 안 B) */
  reasons?: Partial<Record<OvStep, string>>
  /** 마지막으로 바꾼 시각 */
  at: number
}
/** 그 단계의 이유 — 단계별 이유가 없는 옛 기록(2.17.4)은 하나뿐인 이유를 쓴다 */
const reasonOf = (h: { override?: RunOverride }, st: OvStep) => (h.override?.reasons ? (h.override.reasons[st] ?? '') : (h.override?.reason ?? '')).trim()
/** 이 단계를 사람이 성공으로 바꿨나(그 단계의 이유가 있어야 켜진 것) */
const ovStep = (h: { override?: RunOverride }, st: OvStep) => (h.override?.steps ?? []).includes(st) && !!reasonOf(h, st)
/** 사람이 '조치로 복구됨' 을 켠 회차 — 앱 판정과 상관없이 실패로 센다(RunNote 주석) */
const manualFailOf = (h: { notes?: RunNote[] }) => !!h.notes?.some((n) => n.step === 'manual' && n.recovered && n.cause.trim())
/**
 * 검증 그룹(2026-11-13 사용자 결정 · 목업 group-mock1~6). 버전 · 환경마다 회차를 묶는다(예: CONTRABASS V4.0.0 PoC #3).
 * 그룹은 차수(사전 점검 · 1회차 · 2회차 …)와 환경(노드 · VM 배치, 다음 단계)을 갖고, 회차는 groupId · phaseId 로 속한다.
 * 리포트를 그룹으로 만들면 맨 앞에 검증 환경 · 시나리오 흐름 · 차수별 요약(이슈 → 팀별 조치)이 붙는다.
 *
 * 회차 이름 '1회차 2세트(…)' 의 앞 'n회차' 가 차수이고, 세트는 차수 안의 이름이다(사용자 설명). 차수를 이름에서 매번 읽지 않고
 * 따로 기록한다 — 이름을 고치면 차수가 바뀌어 버리고, '사전 점검' 처럼 꼴이 다른 차수도 있다.
 * 이름 앞부분으로 차수를 나눠 주던 '회차 이름으로 나누기' 는 2026-11-14 사용자 결정으로 뺐다(결과를 미리 알기 어려워 헷갈렸다). 차수는 사람이 고른다.
 * 이력과 같은 곳(statusboard-history/groups.json)에 둔다: 그룹이 가리키는 회차와 같은 저장소에 있어야 지우기 · 되살리기가 어긋나지 않는다.
 */
interface PhaseIssue {
  id: string
  text: string
  /** 관련 회차 id — 비면 '공통' */
  runIds: string[]
}
interface PhaseAction {
  id: string
  team: string
  text: string
  /**
   * 조치 결과: 조치 완료 · 확인 중 · 재현 안 됨 · 재현됨 · 표시 안 함(none).
   * 처음엔 재현 안 됨 · 재현됨 · 확인 중 셋이었는데(주신 문서의 '적용 후 재현되지 않음 / 재현 됨'), '조치는 했고 재검증 전' 을 고를 수
   * 없었다(2026-11-14 사용자 지적). 조치 완료를 더하고 기본값으로, 결과를 밝히지 않을 때는 표시 안 함
   */
  result: 'done' | 'ok' | 'repro' | 'wip' | 'none'
  /**
   * 원인 · 관련 이슈(2026-11-16 사용자 결정 · 목업 phase-c-mock 시안 C). 차수별 요약이 이슈 · 원인 · 조치 · 결과 칸으로 나뉘면서 더했다.
   * 관련 이슈를 고르지 않은 조치(옛 기록 포함)는 리포트에서 '공통 조치' 줄로 간다. 줄 짜는 규칙은 lib/phaseSummary
   */
  cause?: string
  issueIds?: string[]
}
interface GroupPhase {
  id: string
  name: string
  issues: PhaseIssue[]
  actions: PhaseAction[]
  /**
   * 이 차수만의 검증 환경(2026-11-16 사용자 결정 · 목업 env-flex-mock B). 없으면 그룹 기본 환경(VerifyGroup.env)을 따른다.
   * 환경 구성이 차수 사이에 바뀔 수 있어서(예: 2차부터 노드 추가) 차수마다 따로 적게 했다. 리포트는 고른 회차의 차수 환경을 싣고,
   * 차수끼리 환경이 다르면 나눠 싣고 그룹 기본과 다른 점을 자동으로 적는다(lib/groupEnvDiff)
   */
  env?: GroupEnv
  /**
   * 이 차수 전에 적용한 변경 · 패치(2026-11-25 사용자 요청, 예: 'SeaweedFS 패치'). 리포트 차수별 요약의 차수 이름 아래에 싣는다 —
   * '2차 (패치 후 확인)' 처럼 이름만으로는 무엇을 고친 뒤의 차수인지 알 수 없었다. 환경(env)과 따로 둔다: 노드 · VM 배치가 아니라 소프트웨어 변경이다
   */
  patch?: string
}
interface VerifyGroup {
  id: string
  name: string
  createdAt: number
  phases: GroupPhase[]
  /** 검증 환경(GroupEnv 주석) — 없으면 리포트에 '검증 환경' 을 싣지 않는다 */
  env?: GroupEnv
  /**
   * 환경 구성도(lib/envMap 주석) — 장비에서 조회한 실제 구성. 사람이 정한 env 와 따로 두고 서로 덮어쓰지 않는다(2026-11-14 사용자 결정).
   * 원문은 남기지 않고 구성도에 쓰는 값만 둔다(groups.json 이 커지지 않게)
   */
  envMap?: EnvMapSnapshot
  /** 검증 결과(GroupResult 주석) — 리포트 종합 결과 맨 위 표 */
  result?: GroupResult
}
/**
 * 검증 결과(2026-11-19 사용자 결정 · 목업 result_mock2) — 리포트 종합 결과 맨 위 '검증 결과' 표(색 없이 왼쪽 이름 칸 · 오른쪽 글).
 * 처음 목업(결론 색 이름표 + 숫자 줄 + 이슈 · 확인 · 계획 세 칸)은 '형형색색' 하다고 해서 표 하나로 바꿨다.
 * 대상 · 기간 · 환경은 비우면 툴이 아는 값(그룹 이름 · 고른 회차의 처음 ~ 끝 · 환경 탭 한 줄), 목적 · 담당자 · 종합 결과 · 비고는 사람만.
 * 사람이 적는 넷이 모두 비면 절을 싣지 않는다(자동 값만으로 된 표는 아래 절과 겹친다). 그룹에 한 벌(차수 · 회차와 따로)
 */
interface GroupResult {
  target?: string
  period?: string
  purpose?: string
  owner?: string
  env?: string
  /** 검증 결과 — PASS(초록) · FAIL(빨강) 이름표(2026-11-19 사용자 결정, 처음 '성공 · 실패' 에서 바꿈). 없으면 그 줄을 싣지 않는다 */
  verdict?: 'ok' | 'fail'
  /** 실패 사유 — 검증 결과가 FAIL 일 때만 리포트에 싣는다(2026-11-20 사용자 결정). PASS 로 바꿔도 글은 지우지 않는다(다시 FAIL 로 돌릴 때 남게) */
  failReason?: string
  /** 주요 이슈 및 조치내역(예전 이름 '종합 검증 결과') — 자유 글. 줄바꿈 · 줄 앞 공백 그대로(리포트 txt 주석) */
  summary?: string
  note?: string
}
/** 검증 결과의 '검증 환경' 자동 값 — 환경 탭의 노드 · VM 수와 장애 주입 한 줄 */
function groupEnvLine(e: GroupEnv | undefined): string {
  if (!e?.nodes.length) return ''
  const role = new Map<string, number>()
  for (const n of e.nodes) {
    const r = n.controller && n.compute ? '컨트롤러 겸 컴퓨트' : n.controller ? '컨트롤러' : n.compute ? '컴퓨트' : ''
    if (r) role.set(r, (role.get(r) ?? 0) + 1)
  }
  const vms = e.nodes.flatMap((n) => n.vms)
  const cnt = (k: EnvVm['kind']) => vms.filter((v) => v.kind === k).reduce((a, v) => a + vmCount(v), 0)
  return [
    `물리 노드 ${e.nodes.length}대${role.size ? `(${[...role].map(([r, n]) => `${r} ${n}`).join(' · ')})` : ''}`,
    cnt('k8s') ? `k8s VM ${cnt('k8s')}` : '',
    cnt('web') ? `웹 서비스 VM ${cnt('web')}` : '',
    e.inject?.trim() ? `장애 주입 ${e.inject.trim()}` : '',
  ]
    .filter(Boolean)
    .join(' · ')
}
/** 검증 결과의 '검증 기간' 자동 값 — 회차의 처음 시작 ~ 마지막 끝 날짜(회차 수) */
function runsPeriodLine(rs: HistoryRecord[]): string {
  if (!rs.length) return ''
  const a = fmtDateTime(Math.min(...rs.map((h) => h.t0))).slice(0, 10)
  const b = fmtDateTime(Math.max(...rs.map((h) => h.closedAt || h.t0))).slice(0, 10)
  return `${a === b ? a : `${a} ~ ${b}`} (${rs.length}회차)`
}
/** 환경 구성도 수집 단계 — 출처마다 하나 */
type EnvStep = 'nodes' | 'ctrl' | 'os' | 'ceph' | 'k8s'
const ENV_STEPS: { k: EnvStep; label: string; what: string }[] = [
  { k: 'nodes', label: '물리 노드', what: 'OS · CPU · 메모리 · 서비스 · NTP' },
  { k: 'ctrl', label: 'Pacemaker · RabbitMQ · Galera', what: 'pcs status · rabbitmqctl cluster_status · wsrep' },
  { k: 'os', label: 'OpenStack', what: '서버 · 하이퍼바이저 · flavor · nova 서비스 · Masakari 세그먼트' },
  { k: 'ceph', label: 'Ceph', what: 'ceph -s · orch ps · osd tree · pool' },
  { k: 'k8s', label: 'k8s', what: '노드 · 파드 · DaemonSet' },
]
type EnvCollect = {
  run: (onStep: (k: EnvStep, st: 'run' | 'ok' | 'fail', msg?: string) => void) => Promise<EnvMapRaw>
  /** 출처마다 쓰는 세션(상태보드 설정 그대로) */
  sessions: () => Record<EnvStep, string>
}
/**
 * 검증 환경(2026-11-13 사용자 결정 · 목업 group-mock3~6) — 리포트 맨 앞 '① 검증 환경' 카드가 그대로 이 데이터다.
 *  - 노드: 표준 이름('노드 1') + 그 버전의 실제 호스트 이름(contrabass01) + 역할(컨트롤러 · 컴퓨트, 겸용이면 둘 다)
 *  - VM: 표준 이름(리포트 기본) + 실제 이름(선택, 리포트에서 '실제 이름' 을 고를 때만) + 종류(k8s · 웹 서비스 · 기타 = 색)
 *    + evacuation 대상(종류와 따로 — 웹 서비스이면서 대상일 수 있어 노란 테두리로 겹쳐 보인다)
 *  - 묶음 VM: 'webserver01~10' 처럼 대수(count)를 가진 한 칸. 실제 이름은 대수만큼 줄로 적는다
 *  - 안내 문구: 줄마다 리포트 카드 아래 '* …' 로. 문구 속 표준 이름은 '실제 이름' 리포트에서 실제 이름으로 바뀐다(자리표시 문법 없이)
 * 기본 틀은 고정 구성이 아니다 — 4노드 · 3노드(3중화) · 빈 틀 · 다른 그룹 복사에서 시작해 노드 · VM 을 자유롭게 더하고 뺀다.
 * 리포트의 숫자(노드 수 · VM 수)는 모두 이 데이터에서 센다.
 */
interface EnvVm {
  id: string
  /** 표준 이름 — 묶음이면 'webserver01~10' */
  name: string
  /** 묶음 대수(2 이상일 때만) */
  count?: number
  /** 실제 이름 — 묶음이면 대수만큼. 비면 리포트는 표준 이름 */
  real?: string[]
  kind: 'k8s' | 'web' | 'etc'
  evac: boolean
}
interface EnvNode {
  id: string
  /** 표준 이름 — '노드 1' */
  label: string
  /** 그 버전의 실제 호스트 이름 */
  host: string
  controller: boolean
  compute: boolean
  vms: EnvVm[]
}
interface GroupEnv {
  /** 장애 주입 방법 — 리포트 환경 머리 · 시나리오 흐름 ① 에 */
  inject: string
  nodes: EnvNode[]
  /** 안내 문구(줄마다 한 항목) */
  notes: string[]
}
const vmCount = (v: EnvVm) => (v.count && v.count > 1 ? v.count : 1)
/** 리포트에 보일 VM 이름 — 실제 이름을 골랐고 적어 둔 것이 있으면 그것(묶음은 번호가 이어지면 'a01~10', 아니면 이름 나열) */
function vmDisplay(v: EnvVm, real: boolean): string {
  const r = (v.real ?? []).map((x) => x.trim()).filter(Boolean)
  if (!real || !r.length) return v.name
  if (r.length === 1) return r[0]
  const m = r.map((x) => x.match(/^(.*?)(\d+)$/))
  if (m.every((x) => x && x[1] === m[0]![1])) {
    const ns = m.map((x) => Number(x![2]))
    if (ns.every((n, i) => i === 0 || n === ns[i - 1] + 1)) return `${m[0]![1]}${m[0]![2]}~${m[m.length - 1]![2]}`
  }
  return r.join(', ')
}
function envTemplate(kind: '4' | '3' | 'empty'): GroupEnv {
  const vm = (name: string, kind2: EnvVm['kind'], evac = false, count?: number): EnvVm => ({ id: newId('vm'), name, kind: kind2, evac, count })
  const k8s = (n: number, manager: boolean) => [vm(`master0${n}`, 'k8s'), vm(`infra0${n}`, 'k8s'), vm(`biz0${n}`, 'k8s'), ...(manager ? [vm(`manager0${n}`, 'k8s')] : [])]
  const node = (n: number, vms: EnvVm[], compute = true, controller = true): EnvNode => ({ id: newId('nd'), label: `노드 ${n}`, host: '', controller, compute, vms })
  const note = '웹 서비스 VM(webserver01~10)은 고정 배치가 아니라, 매 회차 다음 DOWN 대상 노드로 옮겨 두고 진행합니다.'
  if (kind === 'empty') return { inject: 'IPMI 포털 접속 후 Power Down', nodes: [], notes: [] }
  if (kind === '3')
    return {
      inject: 'IPMI 포털 접속 후 Power Down',
      nodes: [
        node(1, [...k8s(1, true), vm('deploy', 'etc', true), vm('webserver01~10', 'web', true, 10)]),
        node(2, k8s(2, true)),
        node(3, [...k8s(3, false), vm('backup', 'etc', true)]),
      ],
      notes: [note],
    }
  return {
    inject: 'IPMI 포털 접속 후 Power Down',
    nodes: [
      node(1, [...k8s(1, true), vm('deploy', 'etc', true), vm('webserver01~10', 'web', true, 10)]),
      node(2, k8s(2, true)),
      node(3, [...k8s(3, false), vm('backup', 'etc', true)]),
      node(4, [], true, false),
    ],
    notes: [note],
  }
}
/** Nova 에서 읽은 컴퓨트 호스트와 그 위 VM 이름 */
type NovaHosts = { host: string; vms: string[] }[]
/** Nova 에서 읽은 VM 이 환경과 다른 노드에 있는 것 — [Nova 배치대로 옮기기] 로 옮긴다 */
type NovaMove = { vmId: string; vm: string; real: string; fromNode: string; toNodeId?: string; toNode?: string; host: string }
/**
 * Nova 결과로 환경의 **빈 칸만** 채운다(2026-11-13 사용자 요청: 상태보드 설정의 OpenStack 세션 · openrc 를 그대로 쓴다).
 *  - 노드 호스트: 적어 둔 호스트가 Nova 호스트와 같거나 앞부분이 같으면 그 호스트. 빈 칸은 그 노드의 표준 VM 과 가장 많이 맞는 호스트,
 *    그래도 남은 빈 노드 · 호스트가 같은 수면 순서대로
 *  - VM 실제 이름: 표준 이름의 글자 부분(biz)이 들어 있고 끝 번호(01)가 같은 VM(대소문자 무시). 그 노드 호스트에서 하나로 정해지면 그것,
 *    없으면 **모든 호스트에서** 하나로 정해질 때 채운다 — 이름 짝은 위치와 무관하다. 11-13 실사용: Epoxy_Biz1~3 이 모두 contrabass04 에,
 *    Epoxy_Backup 이 contrabass01 에 있어 '그 노드 호스트에서만' 찾던 규칙이 놓쳤다. 이때 배치가 다르다는 것은 moves 로 따로 알린다
 *    (배치는 사람이 정한 기준이라 자동으로 옮기지 않고 [Nova 배치대로 옮기기] 로 고르게 한다)
 *  - 묶음(webserver01~10): 이름에 표준 글자가 든 VM 이 대수만큼이면 그것. 없으면 '같은 글자 + 이어지는 번호' 계열 중 대수가 딱 맞는
 *    계열이 **하나뿐일 때만**(11-13 실사용: 웹 서비스 VM 실제 이름이 service_vm01~10 이었다)
 *  - 이미 적어 둔 값은 덮어쓰지 않는다. 확신 없는 것은 비워 두고 이유와 함께 알린다(엉뚱한 이름이 리포트에 실리는 것보다 낫다)
 */
function fillFromNova(
  env: GroupEnv,
  nova: NovaHosts,
): { env: GroupEnv; hosts: number; names: number; missed: { where: string; why: string }[]; moves: NovaMove[]; spare: string[] } {
  const H = nova.map((x) => x.host)
  const same = (a: string, b: string) => {
    const x = a.toLowerCase()
    const y = b.toLowerCase()
    return x === y || x.startsWith(y + '.') || y.startsWith(x + '.')
  }
  const taken = new Set<string>()
  let hosts = 0
  let names = 0
  const missed: { where: string; why: string }[] = []
  const moves: NovaMove[] = []
  const nodes = env.nodes.map((n) => {
    const hit = n.host ? H.find((h) => same(h, n.host)) : undefined
    if (hit) taken.add(hit)
    return { ...n, _h: hit }
  })
  const tail = (v: string) => v.match(/(\d+)$/)?.[1]
  const base = (v: string) => v.replace(/[\d~]+$/, '').replace(/\d+~\d+$/, '').replace(/[-_.\s]+$/, '').toLowerCase()
  /** 단일 VM 의 후보 — 표준 이름의 글자 부분이 들어 있고 끝 번호가 같은 것 */
  const candOf = (v: EnvVm, names2: string[]) => {
    const b = base(v.name)
    const num = tail(v.name)
    return b ? names2.filter((x) => x.toLowerCase().includes(b) && (num == null || Number(tail(x)) === Number(num))) : []
  }
  const vmsOf = (h: string) => nova.find((x) => x.host === h)?.vms ?? []
  const score = (n: EnvNode, h: string) => n.vms.filter((v) => vmCount(v) === 1 && candOf(v, vmsOf(h)).length > 0).length
  for (const n of [...nodes].filter((x) => !x._h && !x.host.trim()).sort((a, b) => b.vms.length - a.vms.length)) {
    let best: string | undefined
    let bs = 0
    for (const h of H) {
      if (taken.has(h)) continue
      const sc = score(n, h)
      if (sc > bs) {
        bs = sc
        best = h
      }
    }
    if (!best && !n.vms.length) best = H.find((h) => !taken.has(h) && !vmsOf(h).length)
    if (!best) continue
    taken.add(best)
    n._h = best
    n.host = best
    hosts++
  }
  const restN = nodes.filter((x) => !x._h && !x.host.trim())
  const restH = H.filter((h) => !taken.has(h))
  if (restN.length && restN.length === restH.length)
    restN.forEach((n, i) => {
      taken.add(restH[i])
      n._h = restH[i]
      n.host = restH[i]
      hosts++
    })
  const nodeOfHost = (h: string) => nodes.find((x) => x._h === h)
  const used = new Set<string>()
  const allVms = nova.flatMap((x) => x.vms)
  const hostOfVm = (name: string) => nova.find((x) => x.vms.includes(name))?.host ?? ''
  // 같은 글자 + 이어지는 번호 계열(service_vm01~10) — 묶음 VM 찾기용
  const series = (() => {
    const m = new Map<string, { n: number; name: string }[]>()
    for (const x of allVms) {
      const mm = x.match(/^(.*?)(\d+)$/)
      if (!mm) continue
      const k = mm[1].toLowerCase()
      m.set(k, [...(m.get(k) ?? []), { n: Number(mm[2]), name: x }])
    }
    return [...m.values()].map((a) => a.sort((p, q) => p.n - q.n)).filter((a) => a.every((x, i) => i === 0 || x.n === a[i - 1].n + 1))
  })()
  const out = nodes.map(({ _h, ...n }) => ({
    ...n,
    vms: n.vms.map((v) => {
      if ((v.real ?? []).some((x) => x.trim())) return v
      const b = base(v.name.split('~')[0])
      if (!b) return v
      if (vmCount(v) > 1) {
        let cand = allVms.filter((x) => !used.has(x) && x.toLowerCase().includes(b))
        if (cand.length !== vmCount(v)) {
          const fit = series.filter((a) => a.length === vmCount(v) && a.every((x) => !used.has(x.name)))
          cand = fit.length === 1 ? fit[0].map((x) => x.name) : []
        }
        if (cand.length === vmCount(v)) {
          cand.forEach((x) => used.add(x))
          names++
          return { ...v, real: [...cand].sort((a, c) => a.localeCompare(c, undefined, { numeric: true })) }
        }
        missed.push({ where: `${n.label} · ${v.name}`, why: `'${b}' 가 든 VM 도, 번호가 이어지는 ${vmCount(v)}대짜리 이름 계열도 하나로 정해지지 않음` })
        return v
      }
      const here = _h ? candOf(v, vmsOf(_h).filter((x) => !used.has(x))) : []
      const any = candOf(
        v,
        allVms.filter((x) => !used.has(x)),
      )
      const pick = here.length === 1 ? here[0] : !here.length && any.length === 1 ? any[0] : null
      if (pick) {
        used.add(pick)
        names++
        const h = hostOfVm(pick)
        if (_h && h !== _h) {
          const to = nodeOfHost(h)
          moves.push({ vmId: v.id, vm: v.name, real: pick, fromNode: n.label, toNodeId: to?.id, toNode: to?.label, host: h })
        }
        return { ...v, real: [pick] }
      }
      const num = tail(v.name)
      missed.push({
        where: `${n.label} · ${v.name}`,
        why: (here.length ? here : any).length
          ? `후보 ${(here.length ? here : any).length}개: ${(here.length ? here : any).slice(0, 3).join(', ')}`
          : `'${b}'${num != null ? ` + 번호 ${Number(num)}` : ''} 인 VM 없음`,
      })
      return v
    }),
  }))
  const spare = allVms.filter((x) => !used.has(x) && !env.nodes.some((n) => n.vms.some((v) => (v.real ?? []).includes(x))))
  return { env: { ...env, nodes: out }, hosts, names, missed, moves, spare }
}
/** 편집용 사본 — id 는 그대로(취소하면 원본이 그대로 남게 얕은 공유를 끊는다) */
/**
 * 저장 전 환경 정리 — 빈 줄 · 빈 실제 이름은 버린다(실제 이름이 하나도 없으면 칸 자체를 뺀다 — 리포트가 표준 이름을 쓴다).
 * 그룹 기본 환경과 차수 환경이 같은 규칙으로 저장되게 하나로 둔다. 표준 이름이 빈 노드가 있으면 문구를 돌려준다
 */
function cleanEnv(env: GroupEnv): { env: GroupEnv; err?: string } {
  const out: GroupEnv = {
    ...env,
    inject: env.inject.trim(),
    notes: env.notes.map((x) => x.trim()).filter(Boolean),
    nodes: env.nodes.map((nd) => ({
      ...nd,
      label: nd.label.trim(),
      host: nd.host.trim(),
      vms: nd.vms
        .filter((v) => v.name.trim())
        .map((v) => {
          const real = (v.real ?? []).map((x) => x.trim()).filter(Boolean)
          return { ...v, name: v.name.trim(), real: real.length ? real : undefined }
        }),
    })),
  }
  return { env: out, err: out.nodes.some((nd) => !nd.label) ? '표준 이름이 빈 노드가 있습니다' : undefined }
}
/** 그 차수 회차가 쓰는 환경 — 차수 환경이 있으면 그것, 없으면 그룹 기본 */
const effEnv = (g: VerifyGroup | undefined, phaseId?: string): GroupEnv | undefined => (g?.phases.find((ph) => ph.id === phaseId)?.env ?? g?.env)
function cloneEnvKeepIds(e: GroupEnv): GroupEnv {
  return { ...e, notes: [...e.notes], nodes: e.nodes.map((n) => ({ ...n, vms: n.vms.map((v) => ({ ...v, real: v.real ? [...v.real] : undefined })) })) }
}
/** 다른 그룹 환경 복사 — id 는 새로 붙인다(두 그룹이 같은 노드 · VM 객체를 나눠 쓰지 않게) */
function cloneEnv(e: GroupEnv): GroupEnv {
  return { ...e, notes: [...e.notes], nodes: e.nodes.map((n) => ({ ...n, id: newId('nd'), vms: n.vms.map((v) => ({ ...v, id: newId('vm'), real: v.real ? [...v.real] : undefined })) })) }
}
const GROUPS_KEY = 'statusboard_groups_v1'
/** 새 회차가 들어갈 그룹 · 차수(상태보드 머리에서 고름) */
const CUR_GROUP_KEY = 'statusboard_group_cur_v1'
/** 그룹 정리 — 저장본마다 빠진 칸을 채운다(파일 · 예전 localStorage 공통) */
function normGroups(arr: unknown[]): VerifyGroup[] {
  return (arr as VerifyGroup[])
    .filter((g) => g && typeof g.id === 'string')
    .map((g) => ({
      ...g,
      phases: (g.phases ?? []).map((ph) => ({ ...ph, issues: ph.issues ?? [], actions: ph.actions ?? [] })),
    }))
}
/** 예전 저장 위치(localStorage)의 그룹 — 파일로 처음 옮길 때만 읽는다 */
function loadGroupsLegacy(): VerifyGroup[] {
  try {
    const arr = JSON.parse(localStorage.getItem(GROUPS_KEY) || '[]')
    return Array.isArray(arr) ? normGroups(arr) : []
  } catch {
    return []
  }
}
function loadCurGroup(): { groupId?: string; phaseId?: string } {
  try {
    const v = JSON.parse(localStorage.getItem(CUR_GROUP_KEY) || 'null')
    return v && typeof v === 'object' ? { groupId: v.groupId || undefined, phaseId: v.phaseId || undefined } : {}
  } catch {
    return {}
  }
}
function saveCurGroup(v: { groupId?: string; phaseId?: string }): void {
  try {
    localStorage.setItem(CUR_GROUP_KEY, JSON.stringify(v))
  } catch {
    /* 기억 못 해도 이번에는 쓴다 */
  }
}
const newId = (p: string) => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`
/** 담당자 칸('플랫폼팀 이OO')의 팀 부분 — 첫 낱말. 비면 '담당 팀 미기재' */
const teamOfOwner = (owner?: string) => (owner ?? '').trim().split(/\s+/)[0] || '담당 팀 미기재'
/**
 * 회차마다 적은 원인 · 조치(RunNote)를 차수의 이슈 · 팀별 조치 꼴로 모은다(2026-11-14 사용자 결정: 가져오기 · 비워 두면 자동 둘 다).
 * 같은 원인은 이슈 하나에 회차를 모으고, 조치는 담당자의 팀별로(같은 팀 · 같은 글은 하나로). 조치 결과는 회차 기록에 없어 비워 둔다
 * (result 없음 = 리포트에 결과 표시를 붙이지 않는다 — 모르는 것을 '확인 중' 으로 지어 붙이지 않는다).
 */
/*
 * 조치의 관련 이슈 = 같은 기록(RunNote)에 함께 적은 원인(2026-11-19 사용자 지적: 가져오면 조치가 모두 '공통 조치' 로 갔다 — 회차 기록에는
 * 원인과 조치가 한 줄로 짝지어 있는데 가져오면서 그 짝을 버렸다). 같은 팀 · 같은 조치 글이 여러 기록에 있으면 그 원인들을 모두 잇는다
 */
function notesToPhase(runs: HistoryRecord[]): { issues: PhaseIssue[]; actions: (Omit<PhaseAction, 'result'> & { result?: PhaseAction['result'] })[] } {
  const iss = new Map<string, string[]>()
  const acts = new Map<string, { team: string; text: string; causes: string[]; whys: string[] }>()
  for (const h of runs)
    for (const n of h.notes ?? []) {
      const c = n.cause.trim()
      if (c) iss.set(c, [...new Set([...(iss.get(c) ?? []), h.id])])
      const a = (n.action ?? '').trim()
      if (a) {
        const team = teamOfOwner(n.owner)
        const key = `${team}\n${a}`
        const cur = acts.get(key)
        const w = (n.why ?? '').trim()
        acts.set(key, { team, text: a, causes: [...new Set([...(cur?.causes ?? []), ...(c ? [c] : [])])], whys: [...new Set([...(cur?.whys ?? []), ...(w ? [w] : [])])] })
      }
    }
  const issues = [...iss].map(([text, runIds]) => ({ id: newId('is'), text, runIds }))
  const idOf = new Map(issues.map((x) => [x.text, x.id]))
  return {
    issues,
    // 회차 기록의 원인은 조치의 원인 칸으로(2026-11-19 — 차수별 요약의 이슈 · 원인 · 조치 칸과 회차 기록 칸을 맞췄다)
    actions: [...acts.values()].map(({ causes, whys, ...x }) => ({
      id: newId('ac'),
      ...x,
      cause: whys.length ? whys.join('\n') : undefined,
      issueIds: causes.map((c) => idOf.get(c)!).filter(Boolean),
    })),
  }
}
/** 그룹 · 차수가 사라진 회차의 소속을 지운다 — 그룹을 지우거나 차수를 빼면 회차는 남고 소속만 풀린다 */
function pruneMembership(list: HistoryRecord[], groups: VerifyGroup[]): HistoryRecord[] {
  const gm = new Map(groups.map((g) => [g.id, new Set(g.phases.map((p) => p.id))]))
  let changed = false
  const out = list.map((h) => {
    if (!h.groupId) return h
    const ps = gm.get(h.groupId)
    if (!ps) {
      changed = true
      return { ...h, groupId: undefined, phaseId: undefined }
    }
    if (h.phaseId && !ps.has(h.phaseId)) {
      changed = true
      return { ...h, phaseId: undefined }
    }
    return h
  })
  return changed ? out : list
}
/**
 * 저장된 이력을 읽지 못했다(JSON 깨짐) — 이때는 **덮어쓰지 않는다**(코드 점검 10-30). 예전엔 읽기 실패를 빈 목록으로 돌려줘, 다음 회차가
 * 그 위에 저장되며 남아 있던 이력 전체가 지워졌다(CLAUDE.md '손상 시 기본값으로 뭉개지 않는다').
 */
let historyUnreadable = false
/**
 * 포털 최종 정상화 · 다시 끊김 · 안 돌아온 화면을 판정 기록(portalLog)으로 다시 맞춘다(lib/portalPhases portalFromLog 주석).
 * 최소화 버그(StatusBoard minChip 주석)로 굳은 옛 회차도 이력 · 리포트 · 증적에서 같은 말을 하게, 읽을 때 한 번 고친다.
 * 판정 기록이 없는 옛 회차는 그대로 둔다. 같은 기록으로 늘 같은 결과라 여러 번 거쳐도 바뀌지 않는다.
 */
function repairPortalRecord(h: HistoryRecord): HistoryRecord {
  const ms = h?.milestones
  if (!ms?.portalLog?.length) return h
  const fixed = portalFromLog({ portal: ms.portal ?? [], portalFlaps: ms.portalFlaps, portalPending: ms.portalPending, portalLog: ms.portalLog, maxLog: PORTAL_LOG_MAX })
  if (!fixed) return h
  return {
    ...h,
    milestones: {
      ...ms,
      portal: fixed.portal,
      portalFlaps: fixed.portalFlaps.length ? fixed.portalFlaps : undefined,
      portalPending: fixed.portalPending.length ? fixed.portalPending : undefined,
    },
  }
}
function loadHistory(): HistoryRecord[] {
  try {
    const raw = localStorage.getItem(HIST_KEY)
    if (!raw) return []
    const arr = JSON.parse(raw)
    if (Array.isArray(arr)) return (arr as HistoryRecord[]).map(repairPortalRecord)
    historyUnreadable = true
    return []
  } catch {
    historyUnreadable = true
    return []
  }
}
/**
 * 보관 한도를 넘는 회차 — 그룹에 들지 않은 회차 중 오래된 것부터(HIST_MAX 주석). list 는 새 회차가 앞(시작 시각 내림차순)
 */
function overflowOf(list: HistoryRecord[]): string[] {
  const loose = list.filter((h) => !h.groupId)
  return loose.length > HIST_MAX ? loose.slice(HIST_MAX).map((h) => h.id) : []
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

export default function StatusBoard({ sessions, onClose, onReconnect, onOpenLiveLog, onAnalyzeText }: StatusBoardProps) {
  const [cfg, setCfg] = useState<BoardConfig>(loadCfg)
  const [view, setView] = useState<'config' | 'board'>('config')
  /**
   * 검증 이력 — 파일(statusboard-history/)에서 열 때 읽어 온다(boardHistory:load). 읽기가 끝나기 전에 회차가 저장돼도 그 회차 파일만
   * 쓰므로 다른 회차를 지우지 않고, 읽어 온 목록과 합친다(같은 id 는 메모리 쪽이 최신).
   */
  const [history, setHistory] = useState<HistoryRecord[]>([])
  /**
   * 마지막으로 저장한 목록 — persistHistory 가 바뀐 회차만 골라 쓰고 빠진 회차만 지우는 기준. **이력을 바꾸는 곳은 모두 이것을 바탕으로
   * 새 목록을 만든다**(화면 상태 history 가 아니라) — 검증 중에는 회차가 주기마다 다시 저장되므로, 한 박자 늦은 history 로 만든 목록을
   * 저장하면 방금 저장된 진행 중 회차가 '빠진 회차' 로 지워진다(빌드 전 검토 11-13)
   */
  const historyRef = useRef<HistoryRecord[]>([])
  const [histLoaded, setHistLoaded] = useState(false)
  const histLoadedRef = useRef(false)
  /** 불러올 때 난 경고 — 저장 성공으로 지우지 않는다 */
  const loadWarnRef = useRef('')
  const [showHistory, setShowHistory] = useState(false)
  /**
   * 이력 지우기 확인(코드 점검 10-30) — '전체 삭제' · 회차 X 가 누르는 즉시 이력과 증적 파일(서버 원문)까지 지웠다. 되살릴 수 없는데
   * '전체 삭제' 는 [목표 기준] 버튼 바로 옆이다. CLAUDE.md '파괴적 동작에는 대상 확인' 에 맞춘다.
   */
  const [askDrop, setAskDrop] = useState<{ ids: string[]; all: boolean } | null>(null)
  /**
   * 검증 중 닫기 확인(2026-11-09 사용자 요청) — X 는 곧 '검증 종료' 인데 확인 없이 닫혀, 지켜보던 회차가 손이 스친 클릭에 끝났다.
   * 응답 측정 창과 같은 꼴: [검증 종료하고 닫기] · [최소화(검증 계속)] · [취소]. 검증 중이 아니면 묻지 않고 닫는다.
   * 최소화 칩의 X 도 같은 확인을 거친다(칩에서는 창을 펼쳐서 묻는다 — 칩 크기에는 확인창이 안 들어간다).
   */
  const [closeAsk, setCloseAsk] = useState(false)
  /** 이력 저장 실패 사유(없으면 빈 문자열) — 보드 위에 빨갛게 띄운다 */
  const [histErr, setHistErr] = useState('')
  /**
   * 이력 저장 — 직전 목록과 견줘 **바뀐 회차만 쓰고, 빠진 회차만 지운다**. 실패하면 보드 위에 사유를 띄운다(검증은 막지 않는다).
   * 성공하면 true(밀려난 회차의 증적은 저장이 된 뒤에 지운다 — 코드 점검 10-30).
   */
  const persistHistory = async (next: HistoryRecord[]): Promise<boolean> => {
    const prev = new Map(historyRef.current.map((h) => [h.id, h]))
    historyRef.current = next
    const ups = next.filter((h) => prev.get(h.id) !== h)
    const keep = new Set(next.map((h) => h.id))
    const dels = [...prev.keys()].filter((id) => !keep.has(id))
    try {
      const a = ups.length ? await window.electronAPI.boardHistorySave(ups as unknown as BoardHistoryRecord[]) : { ok: true }
      const b = dels.length ? await window.electronAPI.boardHistoryDelete(dels) : { ok: true }
      const err = !a.ok ? `검증 이력을 저장하지 못했습니다(${(a as { error?: string }).error ?? '저장 실패'}). 이번 회차는 앱을 끄면 사라질 수 있습니다. 리포트로 먼저 내보내 두세요.` : !b.ok ? `이력에서 지운 회차 파일을 지우지 못했습니다(${(b as { error?: string }).error ?? '삭제 실패'}). 다음에 열면 다시 보일 수 있습니다.` : ''
      // 저장이 잘 되면 저장 오류만 지운다 — 불러올 때 난 경고(손상 파일 · 그룹 파일)는 남긴다(저장 한 번에 경고가 사라져 놓쳤다)
      if (mountedRef.current) setHistErr(err || loadWarnRef.current)
      return !err
    } catch (e) {
      if (mountedRef.current) setHistErr(`검증 이력을 저장하지 못했습니다(${e instanceof Error ? e.message : String(e)}).`)
      return false
    }
  }
  /** 검증 그룹(VerifyGroup 주석) · 새 회차가 들어갈 그룹 · 차수 */
  const [groups, setGroups] = useState<VerifyGroup[]>([])
  const groupsRef = useRef<VerifyGroup[]>([])
  groupsRef.current = groups
  /** groups.json 을 읽지 못함(손상) — 덮어쓰면 그룹이 지워지므로 저장을 막는다 */
  const groupsBadRef = useRef(false)
  /**
   * 열 때 파일에서 이력 · 그룹을 읽는다. 처음 한 번은 예전 저장 위치(localStorage)의 이력 · 그룹을 파일로 옮긴다(boardHistory:migrate 주석).
   * 예전 이력이 깨져 읽지 못하면 옮기지 않고(표시도 남기지 않아 다음에 다시 시도) 알리기만 한다.
   */
  useEffect(() => {
    let alive = true
    void (async () => {
      let r = await window.electronAPI.boardHistoryLoad()
      let migWarn = ''
      if (r.ok && !r.migrated) {
        const legacy = loadHistory()
        if (historyUnreadable) {
          migWarn = '예전 저장 위치의 검증 이력을 읽지 못해 새 저장 위치로 옮기지 못했습니다. 예전 이력은 지우지 않고 남겨 둡니다.'
        } else {
          const m = await window.electronAPI.boardHistoryMigrate(legacy as unknown as BoardHistoryRecord[], loadGroupsLegacy())
          if (!m.ok) migWarn = `예전 검증 이력을 새 저장 위치로 옮기지 못했습니다(${m.error ?? '실패'}). 다음에 열면 다시 시도합니다.`
          if (m.ok) r = await window.electronAPI.boardHistoryLoad()
        }
      }
      if (!alive) return
      const warns: string[] = migWarn ? [migWarn] : []
      if (!r.ok) warns.push(`검증 이력을 읽지 못했습니다(${r.error ?? '읽기 실패'}). 새 회차는 저장되지만 지난 회차 · 그룹이 보이지 않을 수 있고, 그룹 변경은 저장하지 않습니다.`)
      else if (r.bad.length) warns.push(`검증 이력 파일 ${r.bad.length}개를 읽지 못했습니다(손상). 그 파일은 지우지 않고 남겨 둡니다.`)
      if (r.groupsBad) warns.push('검증 그룹 파일을 읽지 못했습니다(손상). 그룹을 덮어쓰지 않으려고 그룹 변경을 저장하지 않습니다.')
      const loaded = (r.list as unknown as HistoryRecord[]).map(repairPortalRecord)
      // 읽는 사이에 저장된 회차(메모리 쪽)가 이긴다
      const map = new Map(loaded.map((h) => [h.id, h]))
      for (const h of historyRef.current) map.set(h.id, h)
      const merged = [...map.values()].sort((a, b) => b.t0 - a.t0)
      historyRef.current = merged
      setHistory(merged)
      // 읽기 자체가 실패했어도(r.ok=false) 그룹은 빈 목록일 뿐 '없는' 것이 아니다 — 저장하면 파일의 그룹을 지우므로 막는다
      groupsBadRef.current = !!r.groupsBad || !r.ok
      if (warns.length) {
        loadWarnRef.current = warns.join(' ')
        setHistErr((cur) => [cur, loadWarnRef.current].filter(Boolean).join(' '))
      }
      if (!groupsRef.current.length) setGroups(normGroups(r.groups))
      histLoadedRef.current = true
      setHistLoaded(true)
    })()
    return () => {
      alive = false
    }
  }, [])
  /**
   * 환경 구성도 수집(lib/envMap 주석) — 상태보드 설정의 세션을 그대로 쓰고 **조회 명령만** 보낸다(2026-11-14 사용자: 노드 안 제어 금지).
   * 출처마다 따로 돌려 하나가 실패해도 나머지는 그린다. 노드 세션은 설정의 노드 칸(hosts) · 클러스터 상태는 OpenStack 조회 세션 ·
   * Ceph 는 Ceph 조회 세션(없으면 OpenStack 조회 세션) · k8s 는 kubectl 조회 세션.
   */
  const envCollect: EnvCollect = {
    sessions: () => {
      const c = cfgRef.current
      const nm = (id: string) => (id ? `${nameOf(id)}${connectedOf(id) ? '' : '(연결 안 됨)'}` : '설정 안 됨')
      const nodes = [...new Set(c.hosts.filter(Boolean))]
      return {
        nodes: `${nodes.length ? `노드 세션 ${nodes.length}개(${nodes.map(nm).join(', ')})` : '설정의 노드 세션 없음'} + 연결된 다른 세션`,
        ctrl: nm(c.osSession),
        os: nm(c.osSession),
        ceph: nm(c.ceph || c.osSession),
        k8s: nm(c.pod),
      }
    },
    run: async (onStep) => {
      const c = cfgRef.current
      const raw: EnvMapRaw = { at: Date.now(), nodes: [], errors: {} }
      const live = (id: string) => !!id && connectedOf(id)
      /** 성공이지만 알릴 말(다른 세션으로 읽음 등) — 단계 줄에 회색으로 */
      const notes: Partial<Record<EnvStep, string>> = {}
      const step = async (k: EnvStep, label: string, fn: () => Promise<string>) => {
        onStep(k, 'run')
        try {
          const msg = await fn()
          if (msg) raw.errors[label] = msg
          onStep(k, msg ? 'fail' : 'ok', msg || notes[k])
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          raw.errors[label] = msg
          onStep(k, 'fail', msg)
        }
      }
      const tail = (r: RunResult) => ((r.out || r.err || r.error || '') + '').trim().slice(-200)
      await Promise.all([
        step('nodes', '물리 노드', async () => {
          /*
           * 설정의 노드 칸 세션 + **연결된 다른 세션 전부**(11-14 실사용: 컴퓨트 노드 세션을 열어 두었지만 설정의 노드 칸(3개)에 없어 노드4 가
           * '못 읽음' 이었다 — 상태보드 노드 칸은 DOWN 감시 대상이라 컴퓨트를 일부러 넣지 않을 수 있다). 다른 세션도 hostname · 서비스 목록 같은
           * 조회뿐이고, 물리 노드가 아닌 곳(k8s VM 등)의 결과는 묶을 때 Nova 하이퍼바이저 · pcs 노드에 없는 이름이라 버린다(buildEnvMap)
           */
          const cfgIds = [...new Set(c.hosts.filter(Boolean))]
          const extra = sessionsRef.current.filter((x) => x.connected && !cfgIds.includes(x.id)).map((x) => x.id)
          const on = [...cfgIds.filter(live), ...extra]
          if (!on.length) return '연결된 세션이 없습니다'
          const rs = await Promise.all(on.map((id) => run(id, NODE_SCRIPT, 40_000)))
          raw.nodes = rs.map((r) => (r.ok && r.out ? { out: r.out } : { error: tail(r) }))
          // 실패 수는 설정의 노드 칸만 센다(다른 세션은 노드가 아닐 수 있다)
          const bad = rs.slice(0, cfgIds.filter(live).length).filter((r) => !r.ok || !r.out).length
          const off = cfgIds.length - cfgIds.filter(live).length
          return bad || off ? `설정의 노드 세션 ${bad + off}개를 읽지 못했습니다(연결 안 됨 ${off} · 실패 ${bad})` : ''
        }),
        step('ctrl', 'Pacemaker · RabbitMQ · Galera', async () => {
          if (!live(c.osSession)) return 'OpenStack 조회 세션이 연결돼 있지 않습니다'
          const r = await run(c.osSession, CTRL_SCRIPT, 40_000)
          if (!r.ok) return `읽지 못했습니다. ${tail(r)}`
          raw.ctrl = r.out
          return ''
        }),
        step('os', 'OpenStack', async () => {
          if (!live(c.osSession)) return 'OpenStack 조회 세션이 연결돼 있지 않습니다'
          const os: NonNullable<EnvMapRaw['os']> = {}
          const miss: string[] = []
          for (const [k, sub] of Object.entries(OS_CMDS) as [keyof typeof OS_CMDS, string][]) {
            const r = await run(c.osSession, osCmd(c.osRc, sub), 90_000)
            if (r.ok && jsonOf(r.out) != null) os[k] = r.out
            else miss.push(sub.split(' ')[0])
          }
          // 세그먼트마다 호스트(uuid 는 셸에 들어가므로 UUID 꼴만)
          const segs = Array.isArray(jsonOf(os.segments)) ? (jsonOf(os.segments) as Record<string, unknown>[]) : []
          os.segHosts = {}
          for (const g of segs) {
            const id = String(g.uuid ?? '')
            if (!/^[0-9a-f-]{36}$/i.test(id)) continue
            const r = await run(c.osSession, osCmd(c.osRc, segHostsCmd(id)), 60_000)
            // osCmd 는 2>&1 이라 실패해도 ok 다 — JSON 이 아니면 못 읽은 것(빈 세그먼트로 그리지 않는다, 검토 지적)
            if (r.ok && Array.isArray(jsonOf(r.out))) os.segHosts[id] = r.out ?? ''
            else miss.push(`segment host list(${String(g.name ?? id)})`)
          }
          raw.os = os
          return miss.length ? `일부를 읽지 못했습니다(${miss.join(', ')}). openrc(${c.osRc}) · openstack CLI 를 확인하세요` : ''
        }),
        step('ceph', 'Ceph', async () => {
          const id = c.ceph || c.osSession
          if (!live(id)) return 'Ceph 조회 세션이 연결돼 있지 않습니다'
          const r = await run(id, CEPH_SCRIPT, 60_000)
          if (!r.ok) return `읽지 못했습니다. ${tail(r)}`
          raw.ceph = r.out
          return /"health"/.test(r.out ?? '') ? '' : 'ceph -s 를 읽지 못했습니다'
        }),
        step('k8s', 'k8s', async () => {
          /*
           * 설정의 kubectl 조회 세션이 지금 열린 세션으로 풀리지 않으면(저장된 프로필 키와 다른 주소 · 계정으로 붙은 경우 — 11-14 실사용:
           * 컨트롤플레인 VM 을 열어 두었는데 '연결 안 됨'), 연결된 세션 중 kubectl 이 답하는 곳을 찾아 쓴다. 노드 · OpenStack · Ceph 세션은
           * 뒤로 미룬다(대개 kubectl 이 없다). 찾는 명령도 조회(get nodes)뿐이다
           */
          let id = c.pod
          if (!live(id)) {
            const all = sessionsRef.current.filter((x) => x.connected).map((x) => x.id)
            const used = new Set([...c.hosts, c.osSession, c.ceph])
            for (const cid of [...all.filter((x) => !used.has(x)), ...all.filter((x) => used.has(x))]) {
              const t = await run(cid, 'kubectl get nodes --no-headers --request-timeout=8s 2>&1 | head -3', 15_000)
              if (t.ok && /\s(Ready|NotReady)(,\S+)?\s/.test(t.out ?? '')) {
                id = cid
                notes.k8s = `설정의 kubectl 조회 세션이 연결돼 있지 않아 ${nameOf(cid)} 에서 읽었습니다`
                break
              }
            }
            if (!live(id)) return 'kubectl 조회 세션이 연결돼 있지 않고, 연결된 세션 중 kubectl 이 되는 곳도 없습니다'
          }
          const r = await run(id, K8S_SCRIPT, 90_000)
          if (!r.ok) return `읽지 못했습니다. ${tail(r)}`
          raw.k8s = r.out
          return /^NAME\s+STATUS/m.test(r.out ?? '') ? '' : 'kubectl get nodes 를 읽지 못했습니다'
        }),
      ])
      return raw
    },
  }
  /**
   * 검증 환경의 Nova 불러오기(fillFromNova 주석) — 상태보드 설정의 OpenStack 세션 · openrc 로 nova-compute 호스트를 읽고, 호스트마다
   * 그 위 VM 이름을 읽는다. 호스트 이름은 셸 명령에 들어가므로 노드명 꼴만 쓴다(looksLikeNode).
   */
  const novaFetch = async (): Promise<{ ok: true; hosts: NovaHosts } | { ok: false; error: string }> => {
    const c = cfgRef.current
    if (!c.osSession || !connectedOf(c.osSession)) return { ok: false, error: '상태보드 설정의 OpenStack 세션이 연결돼 있지 않습니다(설정 → OpenStack 세션 · admin_openrc 경로).' }
    const json = (out: string): unknown => {
      const a = out.indexOf('[')
      const b = out.lastIndexOf(']')
      if (a < 0 || b < a) return null
      try {
        return JSON.parse(out.slice(a, b + 1))
      } catch {
        return null
      }
    }
    const r = await run(c.osSession, osCmd(c.osRc, 'compute service list --service nova-compute'), 60_000)
    const svc = r.ok ? json(r.out ?? '') : null
    if (!Array.isArray(svc)) return { ok: false, error: `nova-compute 목록을 읽지 못했습니다. openrc(${c.osRc}) · openstack CLI 를 확인하세요. ${(r.out || r.err || r.error || '').toString().trim().slice(-240)}` }
    const hostNames = [...new Set(svc.map((x) => String((x as Record<string, unknown>).Host ?? '')).filter(looksLikeNode))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    const hosts: NovaHosts = []
    for (const h of hostNames) {
      // --limit 은 쓰지 않는다 — '--limit -1' 은 -1 을 옵션으로 읽었고, '--limit=-1' 은 'expected a non-negative integer' 로 막혔다
      // (2026-11-13 실사용, CLI 판마다 다름). 빼면 Nova 기본 한도(max_limit, 보통 1000)까지 온다 — 호스트 하나의 VM 수로는 넉넉하다
      const r2 = await run(c.osSession, osCmd(c.osRc, `server list --all-projects --host ${h} -c Name`), 60_000)
      const arr = r2.ok ? json(r2.out ?? '') : null
      // CLI 오류는 사용법(usage) 전문 뒤 마지막 줄에 이유가 온다 — 앞을 자르면 이유가 안 보였다(11-13 실사용)
      if (!Array.isArray(arr)) return { ok: false, error: `${h} 의 VM 목록을 읽지 못했습니다. ${(r2.out || r2.err || r2.error || '').toString().trim().slice(-240)}` }
      hosts.push({ host: h, vms: arr.map((x) => String((x as Record<string, unknown>).Name ?? '')).filter(Boolean) })
    }
    return { ok: true, hosts }
  }
  /** 그룹 저장 — 파일 쓰기는 비동기라 화면은 먼저 바꾸고, 실패하면 보드 위에 알린다 */
  const saveGroups = (next: VerifyGroup[]): string => {
    // 불러오기 전에 저장하면 파일의 그룹 목록을 이 목록(새로 만든 것 하나)으로 덮어쓴다(빌드 전 검토 11-13)
    if (!histLoadedRef.current) return '검증 이력 · 그룹을 아직 불러오는 중입니다. 잠시 뒤에 다시 저장하세요.'
    if (groupsBadRef.current) return '검증 그룹 파일을 읽지 못해 덮어쓰지 않았습니다(기존 그룹을 지우지 않으려고).'
    void window.electronAPI
      .boardHistorySaveGroups(next)
      .then((r) => {
        if (!r.ok && mountedRef.current) setHistErr(`검증 그룹을 저장하지 못했습니다(${r.error ?? '저장 실패'}).`)
      })
      .catch(() => {})
    return ''
  }
  const [curGroup, setCurGroupState] = useState(loadCurGroup)
  const curGroupRef = useRef(curGroup)
  curGroupRef.current = curGroup
  const setCurGroup = (v: { groupId?: string; phaseId?: string }) => {
    setCurGroupState(v)
    saveCurGroup(v)
  }
  /** 그룹을 바꾸고 저장 — 사라진 그룹 · 차수에 걸려 있던 회차의 소속도 같이 푼다 */
  const applyGroups = (next: VerifyGroup[], hist: HistoryRecord[] = historyRef.current): string => {
    const err = saveGroups(next)
    if (err) return err
    setGroups(next)
    const pruned = pruneMembership(hist, next)
    if (pruned !== hist || hist !== historyRef.current) {
      void persistHistory(pruned)
      setHistory(pruned)
    }
    const cg = curGroupRef.current
    const g = next.find((x) => x.id === cg.groupId)
    if (cg.groupId && (!g || (cg.phaseId && !g.phases.some((ph) => ph.id === cg.phaseId)))) setCurGroup(g ? { groupId: g.id } : {})
    return ''
  }
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
  /**
   * 직전 회차가 저장된 이름 — 다음 회차를 시작할 때 입력칸에 그 이름이 그대로 남아 있으면 비운다(코드 점검 10-30). 예전엔 1회차에 자동으로
   * 붙은 'con01 down' 이 [재시작] 한 2회차(con02)에도 그대로 저장돼 리포트 · 증적 파일 이름이 틀린 노드를 가리켰다. 중지할 때 비우지 않는
   * 이유: 중지 뒤에 끝나는 잡이 한 번 더 저장하는데(stop) 그때 이름이 지워진다. 시작 전에 새로 적어 둔 이름은 남긴다.
   */
  const lastRunLabelRef = useRef('')
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
  const requestClose = () => {
    if (!running) return onClose()
    setMinimized(false)
    setCloseAsk(true)
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
  /** 옮기지 못한 VM 이름을 이미 물어본 실패 기록(회차 · 엔진 · 시각) — 한 번만 묻는다(코드 리뷰 11-11: 폴링마다 server list 를 다시 쌓았다) */
  const vmNameTriedRef = useRef<Set<string>>(new Set())
  /** Masakari 실패 증적 — VM 이름을 찾으면 같은 키로 다시 저장하려고 잠시 들고 있다(키 = vmNameTriedRef 와 같은 tryKey) */
  const masaFailEvRef = useRef<Map<string, BoardEvidenceItem>>(new Map())
  // 네임스페이스 → 직전 폴링에서 비정상이던 워크로드 집합 (사라지면 복구로 판정)
  const badWorkloadsRef = useRef<Record<string, Set<string>>>({})
  /** pcs 가 OFFLINE 으로 본 적 있는 host — 다시 Online 이면 '클러스터 재합류' */
  const pcsSawOfflineRef = useRef<Set<string>>(new Set())
  /** 이 회차에 NotReady 였던 k8s 노드 */
  const k8sNotReadySeenRef = useRef<Set<string>>(new Set())
  /** 이 회차에 노드 목록을 한 번이라도 제대로 받았는지 — 첫 응답의 NotReady 는 회차 이전 일이라 사건으로 남기지 않는다 */
  const k8sNodesSeenRef = useRef(false)
  /** 아직 끝나지 않은 조회 잡 — Host 프레임이 느린 잡을 기다리지 않으므로, 같은 잡을 겹쳐 걸지 않게 들고 있는다 */
  const jobInflightRef = useRef<Record<string, Promise<void>>>({})
  /** 그 잡이 시작된 시각 — 뒤에서 도는 잡이 '늦었는지' 를 가린다 */
  const jobStartRef = useRef<Record<string, number>>({})
  const frameSeqRef = useRef(0)
  /** 이 회차에 모든 잡이 한 번씩 답했는지 — 그 전에는 프레임이 전부 기다린다(거짓 초록 방지) */
  const readyOnceRef = useRef(false)
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
  const calibRef = useRef<Record<string, { delta: number; ok: boolean; skew?: number }>>({})
  /** 지금 시계를 재는 중인 masakari 호스트 — 같은 호스트를 겹쳐 재지 않게 */
  const calibBusyRef = useRef<Set<string>>(new Set())
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
    // 다음 렌더를 기다리지 않고 바로 — 그 사이에 끝난 폴링이 옛 설정(지운 네임스페이스)으로 판단하지 않게(podJob 주석)
    cfgRef.current = next
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

  /**
   * 회차(runT0)에 증적 한 건을 남긴다. 원문·강조 문자열 모두 마스킹 설정을 거친다(강조가 원문과 어긋나지 않게).
   * 표(칸 · 칸 설명) · 기록 글 · 메모도 거친다 — 연속 통과 기록의 칸 설명에는 실패 사유 원문(`connect ECONNREFUSED <IP>:443` 등)이 들어가
   * 저장 증적 · 리포트의 title 에 IP 가 그대로 남았다(코드 검토 10-29)
   */
  const saveEvidence = (runT0: number, item: BoardEvidenceItem) => {
    const id = String(runT0)
    const maskTable = (t: BoardEvidenceTable): BoardEvidenceTable => ({
      ...t,
      rows: t.rows.map((r) => r.map((c) => maskForExport(c))),
      cellTitles: t.cellTitles?.map((r) => r.map((c) => (c ? maskForExport(c) : c))),
    })
    const masked: BoardEvidenceItem = {
      ...item,
      text: maskForExport(item.text),
      focus: item.focus?.map((f) => maskForExport(f)),
      table: item.table && maskTable(item.table),
      tables: item.tables?.map(maskTable),
      // 기록(facts)의 글 · 메모도 — 파드 로그 증적의 '원인 줄' 은 로그 원문이라 비밀번호 · IP 가 그대로 남았다(코드 점검 10-30)
      facts: item.facts?.map((f) => (f.text ? { ...f, text: maskForExport(f.text) } : f)),
      note: item.note && maskForExport(item.note),
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
  // 포털 판정 기록(addPortalEvent)은 useCallback 이라 매 렌더 새로 만들어지는 saveEvidence 를 ref 로 부른다
  const saveEvidenceRef = useRef(saveEvidence)
  saveEvidenceRef.current = saveEvidence
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
   * Masakari 증적의 시각 근거 두 줄(2026-11-13 사용자 지적: 증적의 finished 줄 시각과 복구 타임라인이 1초씩 어긋났다).
   * 어긋남은 오류가 아니다 — 로그는 **서버 시계 · 초 단위** 로 찍히고, 타임라인은 그것을 **PC 시계** 로 밀리초까지 보정한 뒤 초 아래를
   * 버려 보인다. 서버 시계가 PC 보다 0.6초 빠르면 원문 15:04:05 가 타임라인 15:04:04 가 된다. 보정을 초 단위로 되돌리면 예전처럼
   * 서버 시각이 최대 1초 치우친다(measureClock 주석) — 그래서 보정은 그대로 두고, 원문 표기 시각과 잰 시계 차이를 증적에 나란히 밝힌다.
   */
  const masaClockFacts = (id: string, line?: string): { label: string; text: string }[] => {
    const out: { label: string; text: string }[] = []
    const raw = (line ?? '').match(/\d{4}-\d{2}-\d{2}[ T](\d{2}:\d{2}:\d{2})/)?.[1]
    if (raw) out.push({ label: '로그 원문 시각 (서버 시계 표기)', text: raw })
    const sk = calibRef.current[id]?.skew
    if (sk != null)
      out.push({
        label: '서버 시계 차이',
        text:
          Math.abs(sk) < 50
            ? '거의 없음 (0.05초 안쪽)'
            : // 값과 설명을 줄로 나눈다(2026-11-16 사용자 지적: 한 문장으로 붙어 시각 칸 너비에 꺾여 읽히지 않았다)
            `서버가 PC 보다 ${(Math.abs(sk) / 1000).toFixed(2)}초 ${sk > 0 ? '빠름' : '느림'}\n타임라인은 이만큼 보정한 PC 시계라 원문과 1초 안팎 다를 수 있습니다`,
      })
    return out
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
        facts.push({ label: `pacemaker 기록 · ${o.resource} ${o.op}: ${o.node}`, at })
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
    /**
     * 진하게 칠하는 첫 줄(focus[0])은 **타임라인 시각의 근거 줄**이어야 한다. crm_mon 은 리소스를 출력 순서대로 내놓아
     * openstack_exporter 의 start(17:53:44)가 먼저 잡혀 진하게 칠해졌는데, 타임라인의 VIP 이동은 int_vip 의 start(17:53:38)다
     * (사용자 확인 요청으로 대조하다 발견). int_vip 줄을 맨 앞으로 올린다.
     */
    if (opt.vip) {
      const vipOp = crm.ops
        .filter((o) => /int_vip/i.test(o.resource) && /^(start|promote)$/.test(o.op) && o.rc === 0 && crm.abs(o.raw) === vipAt)
        .map((o) => `last-rc-change="${o.raw}"`)[0]
      if (vipOp) focus.splice(focus.indexOf(vipOp), 1), focus.unshift(vipOp)
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
        opt.before.trim() || '(없음: 검증 첫 조회에서 바로 바뀌었습니다)',
        '',
        '# 이동을 감지한 pcs status',
        opt.after.trim(),
      ].join('\n'),
      focus,
      facts,
      note: !crm.ok
        ? 'crm_mon 동작 이력을 읽지 못했습니다. pcs status 원문만 남깁니다.'
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
      title: `호스트 DOWN: ${node}`,
      capturedAt: Date.now(),
      host: nameOf(srcId),
      command: `journalctl -u corosync -u pacemaker --since @${since} -o short-iso | grep …  ·  pcs status`,
      verifyCmd: `journalctl -u corosync -u pacemaker --since "${fmtDateTime(runT0 - 60_000)}" | grep -i ${node}`,
      text: [
        `# crm_node -l (노드 번호: corosync 저널은 번호로 적는다${nodeId ? ` · ${node} = ${nodeId}` : ''})`,
        nodeList.trim() || '(읽지 못함)',
        '',
        `# corosync · pacemaker 저널 (${nameOf(srcId)})`,
        lines.join('\n').trim() || '(해당 줄 없음: 권한·저널 보관 설정을 확인하세요)',
        '',
        '# DOWN 을 감지한 pcs status',
        pcsSnap.trim(),
      ].join('\n'),
      focus: [first ?? '', ...(nodeId ? [`host: ${nodeId} `] : []), `OFFLINE`, node].filter(Boolean),
      facts: (() => {
        // 타임라인·리포트의 DOWN 기준은 이 저널 첫 줄이 믿을 만하면 그것(serverTime.ts) — 어느 쪽을 썼는지 그대로 적는다
        const tool = msRef.current.down?.at
        const base = tool != null ? downBaseLib({ at: tool, source: 'pcs', srvAt: srvAt ?? undefined }, runT0) : null
        return [
          { label: `툴이 DOWN 을 감지 (pcs OFFLINE)${base && !base.server ? '타임라인 기준' : ''}`, ...(tool != null ? { at: tool } : { text: '-' }) },
          ...(srvAt != null ? [{ label: `저널 기록 · ${node} 이탈 첫 줄${base?.server ? ': 타임라인 기준' : ' (감지보다 너무 앞서 기준으로 쓰지 않음)'}`, at: srvAt }] : []),
        ]
      })(),
      note: '살아 있는 노드의 저널입니다. 진하게 칠한 첫 줄이 클러스터가 노드를 잃었다고 남긴 시각이고, 타임라인의 DOWN 시각입니다(감지보다 2분 안쪽으로 앞설 때). 저널 표기는 호스트 시계라 PC 시계로 보정한 타임라인과 1초 안팎 다를 수 있습니다.',
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
      title: `세션 재연결: ${svcShortName(nameOf(id))}`,
      capturedAt: Date.now(),
      host: nameOf(id),
      command: 'uptime -s  ·  who -b  ·  journalctl --list-boots',
      verifyCmd: 'uptime -s; journalctl --list-boots | tail -3',
      text: out || '(읽지 못함)',
      focus: [bootLine].filter(Boolean),
      facts: [
        { label: '툴이 SSH 재연결', text: '타임라인 시각' },
        bootAt != null
          ? { label: inRun ? '부팅 시각 (uptime -s, PC 시계로 보정)' : '부팅 시각: 이 회차 전 (재부팅 아님)', at: bootAt }
          : { label: '부팅 시각', text: '읽지 못함' },
      ],
      note: inRun ? undefined : '부팅 시각이 검증 시작보다 이릅니다. 이 재연결은 재부팅이 아니라 네트워크 단절 뒤 복구일 수 있습니다.',
    })
  }

  /**
   * Ceph 복구의 근거 — 모니터가 남긴 클러스터 로그(`ceph log last`). 'Health check cleared: PG_DEGRADED' ·
   * 'Cluster is now healthy' 처럼 Ceph 자신이 상태가 바뀐 순간을 적는다.
   */
  const captureCeph = async (runT0: number, sid: string, which: 'ceph' | 'cephHealthy') => {
    // 한꺼번에 돌리면 같은 노드의 ceph -s 폴링이 밀려 다음 확정이 늦어진다 — 하나씩
    const clock = await measureClock(sid)
    // stderr 까지 받는다(runMerged 주석) — 이 클러스터는 ceph log last 를 stderr 로 냈다
    const lg = await runMerged(sid, 'ceph log last 1000', 20_000)
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
      title: which === 'ceph' ? 'Ceph 데이터 복구 완료: 클러스터 로그' : 'Ceph HEALTH_OK: 클러스터 로그',
      capturedAt: Date.now(),
      host: nameOf(sid),
      command: 'ceph log last 1000  ·  ceph -s',
      verifyCmd: which === 'ceph' ? 'ceph log last 1000 | grep -i "health check cleared"' : 'ceph log last 1000 | grep -i "now healthy"',
      text: [
        '# ceph log last 1000',
        lines.join('\n').trim() ||
          (lg.ok && !lg.timedOut
            ? '(비어 있음: 이 클러스터는 모니터 클러스터 로그를 남기지 않습니다. 아래 상태 원문이 근거입니다)'
            : `(읽지 못함${lg.timedOut ? ': 시간 초과' : ''})`),
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
        : '클러스터 로그에서 해당 기록을 찾지 못해 서버 기록 시각은 없습니다. 완료를 확정한 순간의 ceph -s · health detail 원문만 남깁니다.',
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
    if (mr && parsed === null && t0Ref.current === runT0 && msRef.current.masakari) {
      msRef.current.masakari.vmUnchecked = true
      refreshSavedHistory(runT0)
    }
    if (vms.length && t0Ref.current === runT0 && msRef.current.masakari) {
      msRef.current.masakari.vmUnchecked = undefined
      msRef.current.masakari.vms = {
        count: vms.length,
        failed,
        pending: unfinished.length || undefined,
        firstAt: Math.min(...vms.map((v) => v.createdAt)),
        // 아직 옮기는 중인 VM 의 updatedAt 은 '완료' 가 아니다 — 끝난 VM 만
        lastAt: Math.max(...(vms.some((v) => v.done) ? vms.filter((v) => v.done) : vms).map((v) => v.updatedAt)),
        // 이름을 찾은 것만(못 찾으면 비워 둔다 — 2026-11-11 사용자 결정: '기록 없음' 은 더 이상하다)
        failedNames: vms.filter((v) => v.failed || !v.done).map((v) => names[v.server]).filter(Boolean).length
          ? vms.filter((v) => v.failed || !v.done).map((v) => names[v.server]).filter(Boolean)
          : undefined,
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
      logLines = [...logLines.slice(0, LOG_KEEP), `… (${logLines.length - LOG_KEEP * 2}줄 생략: 서버에서 직접 확인 명령으로 전체를 볼 수 있습니다) …`, ...logLines.slice(-LOG_KEEP)]
    const table = vms.length
      ? ''
      : !mr
        ? '(OpenStack 조회 세션이 없어 Nova 기록을 읽지 않았습니다. 상태보드 설정의 OpenStack 세션·openrc 를 지정하세요)'
        : parsed
          ? '(이 회차의 evacuation 기록 없음)'
          : `(Nova 기록 조회 실패: openrc(${os.rc})·openstack CLI 를 확인하세요)\n${((mr.out || mr.err || mr.error || '') + '').trim().slice(0, 400)}`
    saveEvidence(runT0, {
      key: 'masakari',
      title: `Masakari evacuation 완료${vms.length ? ` · VM ${vms.length}대` : ''}`,
      capturedAt: Date.now(),
      host: nameOf(id),
      command: `masakari-engine 로그(tail · grep)  ·  openstack server migration list --type evacuation`,
      verifyCmd: uuid
        ? `grep -n "${uuid}" ${logPath}   ·   openstack server migration list --type evacuation`
        : `openstack server migration list --type evacuation`,
      text: [
        ...(vms.length ? [] : ['# Nova evacuation 기록', table, '']),
        `# masakari-engine 로그 (${nameOf(id)}${keys.length ? '이 VM 들 · 이 알림의 줄만' : ''})`,
        logLines.join('\n').trim(),
      ].join('\n'),
      table: vms.length
        ? {
            title: `Nova evacuation 기록: VM ${vms.length}대 (시작 순 · 이 PC 시간대)`,
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
        ...masaClockFacts(id, p.line),
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
    /** nsReady 를 만든 파드 — 진하게 칠할 첫 줄(타임라인의 '클러스터 기록 Ready' 시각이 이 파드의 Ready 전환이다) */
    let nsReadyPod = ''
    let allReady = workloads.size > 0
    for (const w of workloads) {
      const ready = mine.filter((f) => workloadOf(f.name) === w && f.ready && f.readyAt != null)
      if (!ready.length) {
        allReady = false
        factRows.push({ label: `${w}: Ready 파드 없음`, text: '조회 시점 기준' })
        continue
      }
      // 죽은 노드의 파드가 지워져서 '복구' 된 워크로드는 남은 파드가 며칠째 Ready 다 — 그 시각은 이번 복구의
      // 근거가 아니다(검토 지적). 이 회차에 Ready 가 된 파드만 센다(1분은 시계 오차 여유)
      const fresh = ready.filter((f) => (f.readyAt as number) >= runT0 - 60_000)
      if (!fresh.length) {
        factRows.push({ label: `${w}: 이 회차에 새로 Ready 된 파드 없음 (기존 파드가 계속 Ready)`, text: '-' })
        continue
      }
      const at = Math.max(...fresh.map((f) => f.readyAt as number))
      if (nsReady == null || at > nsReady) nsReadyPod = fresh.find((f) => f.readyAt === at)?.name ?? ''
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
      : `(파드 JSON 을 읽지 못함${pj.timedOut ? ': 시간 초과' : ''})`
    saveEvidence(runT0, {
      key: `pods:${ns}`,
      title: `${ns} 파드 복구 완료: 클러스터 기록`,
      capturedAt: Date.now(),
      host: nameOf(sid),
      command: `kubectl get pods -n ${ns} -o json  ·  kubectl get events -n ${ns} --sort-by=.lastTimestamp`,
      verifyCmd: `kubectl get pods -n ${ns} -o custom-columns=NAME:.metadata.name,CREATED:.metadata.creationTimestamp,READY_AT:'.status.conditions[?(@.type=="Ready")].lastTransitionTime'`,
      text: [
        `# 파드 시각 (kubectl get pods -o json 에서 추출 · 표시는 이 PC 시간대)`,
        table,
        '',
        `# 이벤트 (kubectl get events -n ${ns} · 시각은 이 PC 시간대로 바꿔 표시, 원본은 UTC)`,
        ev.ok ? utcToLocalInText((ev.out ?? '').trim()) || '(이벤트 없음)' : `(이벤트를 읽지 못함${ev.timedOut ? ': 시간 초과' : ''})`,
      ].join('\n'),
      // 첫 강조는 워크로드 이름이 아니라 그 Ready 시각을 만든 **파드 줄** — 이름만 주면 같은 이름의 Terminating 옛 파드 줄이 먼저 칠해졌다. 표는 화면에서 탭이 공백으로 맞춰지므로 이름 뒤 공백까지 맞춘다
      focus: [...(nsReadyPod ? [`${nsReadyPod} `] : []), ...workloads],
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
    /** 이 프레임 번호 — 뒤에서 늦게 끝난 앞 프레임의 잡이 patch 할 때 '늦은 항목' 목록은 지금 프레임 것을 지킨다 */
    const frameSeq = ++frameSeqRef.current

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
        // 앞 프레임의 잡이 늦게 끝나 patch 하면 그 프레임의 목록으로 지금 목록을 덮어 배너가 깜빡였다(코드 점검)
        delayed: frameSeq === frameSeqRef.current ? Array.from(delayed) : prev?.delayed ?? [],
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

    // masakari host 의 로그시각 보정값(delta)을 (아직 없으면) 산출 — 잴 때까지 프레임마다 다시 시도하되 **기다리지 않는다**.
    //   date 로 '절대epoch 로컬표기' 를 받아, 로컬표기를 PC-로컬로 파싱한 값과 절대시각의 차이를 delta 로 둔다.
    //   예전엔 이 측정을 await 했다 — 다시 재게 되면서(아래) 느린 호스트가 프레임 전체(pcs DOWN 감지 포함)를 최대 30초 붙잡을 수 있다.
    void Promise.all(
      masaIds.map(async (id) => {
        if (calibBusyRef.current.has(id)) return
        // 재지 못했으면 다음 프레임에 다시 잰다(코드 점검 10-30) — 예전엔 첫 프레임 실패로 delta 0 이 굳어, 시간대가 다른 호스트면 로그가 모두
        // 검증 시작 전으로 걸러져 끝까지 '대기 중'(거짓 미복구)이거나, 반대 방향이면 지난 회차의 finished 줄이 이번 완료로 잡혔다
        if (!connectedOf(id) || calibRef.current[id]?.ok) return
        /**
         * delta 는 **호스트 로컬 표기 → 이 PC 의 시계** 로 바꾸는 값이다. 예전에는 `localMs - epoch*1000`
         * 이었는데, 두 값이 모두 **호스트 시계**에서 나와 시간대 차이만 잡히고 호스트와 PC 의 시계 차이는
         * 그대로 남았다(주석은 '상쇄된다' 고 잘못 적고 있었다). 호스트가 PC 보다 40초 늦으면 evacuation 완료가
         * 40초 이르게 찍히고 t0 뒤 40초의 로그가 걸러졌다 — NTP 가 안 맞는 폐쇄망 랩에서 흔하다.
         * 요청 직전·직후 PC 시각의 가운데를 '호스트가 date 를 찍은 순간' 으로 보고 그 PC 시각과 견준다
         * (오차는 왕복 지연의 절반 이내).
         */
        // measureClock 을 쓴다 — 밀리초 · 세 번 재서 왕복이 가장 짧은 값(슬롯 대기로 이르게 잡히는 것을 피함). 여기만 한 번 · 초 단위였다
        calibBusyRef.current.add(id)
        try {
          const clock = await measureClock(id)
          calibRef.current[id] = clock ? { delta: clock.delta, ok: true, skew: clock.skew } : { delta: 0, ok: false }
        } finally {
          calibBusyRef.current.delete(id)
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
      /** 같은 프레임의 역할 이동을 VIP 증적에 합칠 것(아래 byMove 주석) */
      let vipExtra: { targets: { resources: string[]; to: string; label: string }[]; dc: string } | null = null
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
          /*
           * 같은 프레임에 VIP 도 옮겨 갔으면 역할 이동을 따로 뜨지 않고 VIP 증적에 합친다(2026-11-10 사용자 요청: 'VIP 이동' · 'pacemaker 역할
           * 이동' 이 같은 페일오버를 두 번 말했다). 다른 때 옮겨 간 것(노드가 돌아와 되돌아감 등)은 지금처럼 따로 남긴다.
           */
          if (vipMoved && srcId) {
            vipExtra = { targets, dc: dcMove ? `DC ${dcMove.from} → ${dcMove.to}` : '' }
          } else if (srcId)
            void ((runT0: number, opt: Parameters<typeof captureMove>[1]) => inSeq(srcId, () => captureMove(runT0, opt)))(t0Ref.current, {
              key: `roles:${now}`,
              title: `pacemaker 역할 이동${dcMove ? `: DC ${dcMove.from} → ${dcMove.to}` : ''}`,
              srcId,
              before: lastPcsOutRef.current,
              after: pcsOut,
              targets,
            })
        }
        if (vipMoved && srcId) {
          // VIP 와 같은 그룹의 리소스 start 시각도 함께 — 'VIP 는 넘어갔는데 haproxy 는 언제 떴나' 가 증적의 핵심이다
          const ex = vipExtra as { targets: { resources: string[]; to: string; label: string }[]; dc: string } | null
          const vipRes = resources.find((r) => /int_vip/i.test(r.name))
          const groupMates = vipRes?.group ? resources.filter((r) => r.group === vipRes.group).map((r) => r.name) : []
          if (msRef.current.vip) msRef.current.vip.with = groupMates.filter((n) => !/int_vip/i.test(n))
          void ((runT0: number, opt: Parameters<typeof captureMove>[1]) => inSeq(srcId, () => captureMove(runT0, opt)))(t0Ref.current, {
            key: 'vip',
            title: `VIP 이동: ${vipMoved.from} → ${vipMoved.to}${ex?.dc ? ` (pacemaker ${ex.dc})` : ''}`,
            srcId,
            before: lastPcsOutRef.current,
            after: pcsOut,
            targets: [
              {
                resources: Array.from(new Set([vipRes?.name ?? 'int_vip', ...groupMates])),
                to: vipMoved.to,
                label: `VIP: ${vipMoved.from} → ${vipMoved.to}`,
              },
              // 같은 때 옮겨 간 다른 pacemaker 리소스(역할 이동)도 이 증적에서 start 시각을 함께 본다
              ...(ex?.targets ?? []),
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
          const cmd = sudoOr(`sh -c 'tail -n 20000 ${c.logPath} | grep -iE "${MASAKARI_GREP}" | tail -n 800'`)
          const r = await run(id, cmd)
          if (r.timedOut) delayed.add('Masakari')
          /**
           * **조회 실패는 '로그 없음' 이 아니다.** 예전에는 실패하면 빈 문자열로 판정해 idle(검증 시작 후
           * evacuation 로그 없음)이 됐다 — 이미 finished 였던 카드가 '대기 중' 으로 돌아가고 종합 판정이
           * 정상↔복구 진행 중으로 흔들렸다. 직전 결과를 그대로 두고 그 사실만 밝힌다(없으면 확인 불가).
           */
          if (!r.ok || r.timedOut) {
            const prev = lastMasakariRef.current[id]
            if (prev) return { id, ...prev.p, detail: `${prev.p.detail} (조회 실패: ${Math.round((Date.now() - prev.at) / 1000)}초 전 값)` }
            return { id, state: 'unknown' as MasakariState, detail: '조회 실패: 확인 불가', evac: 0, at: undefined as number | undefined }
          }
          // 호스트 시각을 아직 못 쟀으면 판정하지 않는다 — 보정 없이 읽으면 완료 시각이 틀리거나 지난 회차 줄을 잡는다. 조회 실패와 같이 다룬다
          if (!calibRef.current[id]?.ok) {
            const prev = lastMasakariRef.current[id]
            if (prev) return { id, ...prev.p, detail: `${prev.p.detail} (host 시각 확인 중)` }
            return { id, state: 'unknown' as MasakariState, detail: 'host 시각 확인 중: 판정 보류', evac: 0, at: undefined as number | undefined }
          }
          const p = parseMasakari(r.out ?? '', t0Ref.current, calibRef.current[id].delta)
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
        uuids: 'uuids' in m ? m.uuids : undefined,
      }))
      // 엔진이 알림을 실패로 끝낸 것 — 노드·시각마다 한 번만 남긴다(같은 줄을 매 폴링 다시 읽는다)
      for (const m of results) {
        if ((m.state !== 'error' && m.state !== 'failed') || m.at == null) continue
        const by = svcShortName(nameOf(m.id))
        const list = (msRef.current.masakariFail ??= [])
        if (!list.some((x) => x.by === by && x.at === m.at) && 'raw' in m && m.raw) {
          /**
           * 실패에도 증적을 남긴다 — 예전엔 완료만 증적이 있어, 실패 줄의 [증적] 이 없고 원인을 보려면 서버 로그를 다시 열어야
           * 했다(엔진 로그는 회전되면 사라진다). 진하게 칠하는 첫 줄은 타임라인 시각의 근거인 'exits with status' 줄이다.
           */
          const at = m.at
          const lines = stripAnsi(m.raw).split('\n').filter((l) => /\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(l))
          // 실패한 Task 줄 · API 예외 줄도 — 어느 단계에서 무엇 때문에 멈췄는지가 원문에 보여야 한다(10-27: Nova API 503)
          const near = lines.filter((l) =>
            /Failed to|Timeout for instance|exits with status|Processing notification|evacuate command|state 'FAILURE'|\w+client\.exceptions\.|keystoneauth1\.exceptions\./i.test(l),
          )
          /*
           * 이유는 ' · ' 마다 줄을 나누고, 옮기지 못한 VM 을 함께 싣는다(2026-11-16 사용자 지적: 'VM 10대 중 2대 옮기지 못함' 한 줄만 있어
           * 어느 VM 인지 증적에서 알 수 없었다). 로그에는 UUID 만 있어 먼저 UUID 로 싣고, 아래에서 Nova 이름을 찾으면 같은 키로 다시 저장한다
           */
          const failIds = 'failedIds' in m ? (m.failedIds ?? []) : []
          const ev: BoardEvidenceItem = {
            key: `masakariFail:${at}`,
            title: `Masakari ${m.state === 'failed' ? '최종 실패' : '1차 시도 실패'}: ${by}`,
            capturedAt: Date.now(),
            host: nameOf(m.id),
            command: `masakari-engine 로그(tail · grep): ${c.logPath}`,
            verifyCmd: `grep -nE "exits with status|Failed to" ${c.logPath} | tail -n 20`,
            text: ['# masakari-engine 로그: 알림 처리 · 실패 · evacuate 줄', ...(near.length ? near : lines).slice(-300)].join('\n'),
            focus: [m.line ?? '', ...near.filter((l) => /Failed to|Timeout for instance|state 'FAILURE'|\(HTTP \d{3}\)/i.test(l))].filter(Boolean),
            facts: [
              { label: `${m.state === 'failed' ? '최종 실패' : '1차 시도 실패'} (masakari 로그 시각, PC 시계로 보정): 타임라인 기준`, at },
              ...masaClockFacts(m.id, m.line),
              ...('reason' in m && m.reason ? [{ label: '이유', text: m.reason.split(' · ').join('\n') }] : []),
              ...(failIds.length ? [{ label: `옮기지 못한 VM (${failIds.length}대)`, text: failIds.join('\n') }] : []),
            ],
            note: '강조된 첫 줄이 알림을 실패로 끝낸 줄(타임라인 시각)입니다. error 는 1차 시도 실패로 masakari 가 한 번 더 시도하고, failed 는 재시도까지 끝난 최종 실패입니다. 실패해도 장애 호스트는 maintenance 로 남으므로 노드가 돌아오면 풀어야 다음 장애 알림을 받습니다.',
          }
          saveEvidence(t0Ref.current, ev)
          if (failIds.length) masaFailEvRef.current.set(`${t0Ref.current}|${by}|${at}`, ev)
        }
        if (!list.some((x) => x.by === by && x.at === m.at))
          list.push({
            at: m.at,
            by,
            status: 'status' in m && m.status ? m.status : m.state,
            evac: m.evac,
            reason: 'reason' in m ? m.reason : undefined,
            brief: 'brief' in m ? m.brief : undefined,
            failedVms: 'failedVms' in m ? m.failedVms : undefined,
          })
        /*
         * 옮기지 못한 VM 의 이름 — 로그에는 UUID 만 있다. Nova 에서 이름을 찾아 붙인다(리포트 '실패 원인', 2026-11-11 사용자 요청).
         * 못 찾으면 비워 둔다(사용자 결정: '기록 없음' 을 남기면 더 이상하다). 한 번만 묻는다 — 이미 이름이 있으면 건너뛴다.
         */
        const ids = 'failedIds' in m ? m.failedIds : undefined
        const entry = list.find((x) => x.by === by && x.at === m.at)
        const tryKey = `${t0Ref.current}|${by}|${m.at}`
        if (ids?.length && entry && !entry.failedVmNames && !vmNameTriedRef.current.has(tryKey)) {
          vmNameTriedRef.current.add(tryKey)
          const os = masaOs(m.id)
          const runT0 = t0Ref.current
          if (os.sid)
            void inSeq(os.sid, async () => {
              const nr = await run(os.sid, `bash -lc '. ${os.rc} 2>/dev/null; openstack server list --all-projects --limit 2000 -c ID -c Name -f json'`, 30_000)
              try {
                const byId = new Map((JSON.parse(nr.out ?? '[]') as { ID?: string; Name?: string }[]).map((x) => [String(x.ID ?? '').toLowerCase(), x.Name ?? '']))
                const found = ids.map((u) => byId.get(u.toLowerCase())).filter((x): x is string => !!x)
                if (found.length && t0Ref.current === runT0) {
                  entry.failedVmNames = found
                  refreshSavedHistory(runT0)
                }
                // 실패 증적의 'UUID 만' 줄을 '이름 (UUID)' 로 바꿔 다시 저장한다(같은 키라 덮어쓴다). 못 찾은 VM 은 UUID 그대로
                const ev = masaFailEvRef.current.get(tryKey)
                // 한 번만 묻는다(vmNameTriedRef) — 이름을 못 찾았어도 들고 있을 까닭이 없다
                masaFailEvRef.current.delete(tryKey)
                if (ev && found.length) {
                  const named = ids.map((u) => {
                    const n = byId.get(u.toLowerCase())
                    return n ? `${n} (${u})` : u
                  })
                  saveEvidence(runT0, { ...ev, facts: ev.facts?.map((f) => (f.label.startsWith('옮기지 못한 VM') ? { ...f, text: named.join('\n') } : f)) })
                }
              } catch {
                /* 이름 없이 둔다 */
              }
            })
        }
      }
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
      if (!connectedOf(c.ceph)) return patch({ ceph: unknownCeph('세션 미연결: 확인 불가') })
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
            : unknownCeph('응답 지연: 확인 불가'),
        })
        return STALE_FRAME
      }
      const out = r.ok ? (r.out ?? '') : ''
      if (!out) return patch({ ceph: unknownCeph('조회 실패 (권한/명령 확인): 확인 불가') })
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
        console.warn('[StatusBoard] ceph -s 가 HEALTH_ 를 안 줬습니다. 원문:', out)
        return patch({ ceph: unknownCeph(`상태를 답하지 못함: 응답: ${peek}`) })
      }
      const remain = parsed.degraded + parsed.misplaced
      // 복구 진행률의 기준선(peak)은 폴링 간에 유지돼야 하므로 ref 에 누적한다.
      cephPeakRef.current = Math.max(cephPeakRef.current, remain)
      // 문구는 이번 검증에서 복구를 봤는지(peak)로 가른다 — 평상시에 '복구 완료' · '리밸런스 진행 중' 이 뜨지 않게(cephNote 주석)
      const ceph = { ...parsed, peakRemain: cephPeakRef.current, note: cephNote(parsed.health, remain, cephPeakRef.current), raw: out, rawAt: Date.now() }
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
            note: 'kubectl 세션 미연결: 확인 불가',
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
        // 새로 NotReady 가 된 노드 — 한 프레임에 바뀐 것은 한 줄로. 회차의 첫 응답에서 이미 NotReady 였던 노드는 이 회차의
        // 사건이 아니라서 남기지 않는다(검증 시작 +0 에 'NotReady' 줄이 찍히면 장애가 그때 난 것으로 읽힌다)
        const fresh = [...notReady].filter((n) => !k8sNotReadySeenRef.current.has(n))
        if (fresh.length && k8sNodesSeenRef.current) (msRef.current.k8sNotReady ??= []).push({ at: Date.now(), nodes: fresh.sort() })
        k8sNodesSeenRef.current = true
        for (const n of notReady) k8sNotReadySeenRef.current.add(n)
        for (const n of [...k8sNotReadySeenRef.current]) {
          if (notReady.has(n)) continue
          k8sNotReadySeenRef.current.delete(n)
          ;(msRef.current.k8sReady ??= []).push({ at: Date.now(), node: n })
        }
      }
      /** 네임스페이스별 컨트롤러 Ready — undefined = 묻지 않음(이상 없음), null = 조회 실패 */
      const ctrlByNs = new Map<string, ControllerStat[] | null | undefined>()
      const podsAll = await Promise.all(
        namespaces.map(async (ns) => {
          // kubectl 자체 타임아웃을 걸어, 죽은 노드의 apiserver 엔드포인트를 물고 늘어지지 않게 한다
          const r = await run(c.pod, `kubectl get pods -n ${ns} -o wide --no-headers --request-timeout=5s 2>&1`)
          if (r.timedOut) delayed.add(`파드(${ns})`)
          const raw = r.ok ? (r.out ?? '') : ''
          const p = parsePods(ns, raw, c.podScope, notReady, t0Ref.current)
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
          return failed ? { ...p, unknown: true, note: 'kubectl 조회 실패: 확인 불가' } : p
        }),
      )
      /*
       * 묻는 동안 X 로 뺀 네임스페이스는 버린다(2026-11-17 사용자 지적: 지운 네임스페이스 카드가 다시 나타나 한 번 더 지워야 했다).
       * 이 프레임은 X 를 누르기 전에 시작해 옛 목록(namespaces)으로 물었으므로, 끝나고 patch 하면 지운 카드가 되살아났다.
       * 마일스톤(복구 · 끊김)도 지운 네임스페이스 것은 남기지 않는다. 판단은 끝난 시점의 설정(cfgRef)으로 한다
       */
      const pods = podsAll.filter((p) => cfgRef.current.namespaces.includes(p.namespace))
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
        if (step.brokenAt != null) {
          ;(msRef.current.podsBroken ??= []).push({ at: step.brokenAt, ns: p.namespace, workloads: [...bad].sort() })
          // 이미 저장한 회차에도 곧바로 반영한다 — 저장본이 '완료' 로 남은 채 앱이 닫히면 리포트가 틀린다
          if (savedRef.current) commitHistory(closedAtRef.current, true)
        }
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
      tzNote = 'host 시각 확인 실패: masakari 판정이 부정확할 수 있습니다'
    } else if (calibs.length) {
      const maxAbs = Math.max(0, ...calibs.map((cb) => Math.abs(cb.delta)))
      if (maxAbs > 60_000) tzNote = `host 로그 시각이 PC와 약 ${(maxAbs / 3_600_000).toFixed(1)}시간 차이: 자동 보정 적용됨`
    }
    patch({ tzNote })

    /**
     * **Host(pcs) 는 다른 잡을 기다리지 않는다.** 예전엔 여섯 잡을 모두 끝내야 다음 프레임이 돌아, 노드를 죽인 순간 Ceph(mon 1대
     * 다운)·죽은 노드 쪽 kubectl 이 타임아웃까지 붙잡는 동안 pcs 조회도 같이 밀렸다 — 2026-10-26 17:53 회차에서 저널 이탈
     * 17:53:33 · VIP start 17:53:38 인데 DOWN 을 17:53:54 에 봤다. 이제 프레임은 Host 만 기다리고, 느린 잡은 뒤에서 마저 돈다.
     * 아직 도는 잡은 다음 프레임에 **다시 걸지 않는다**(같은 조회가 쌓여 SSH 실행 슬롯을 먹지 않게) — 그 프레임에는 '응답이 늦어
     * 갱신하지 못한 항목' 으로 밝힌다. 첫 프레임만은 전부 기다린다 — 모든 그룹이 한 번씩 답하기 전에 판정을 켜면 거짓 초록이다.
     */
    const JOB_LABEL: Record<string, string> = { host: 'Host(pcs)', masakari: 'Masakari', ceph: 'Ceph', 파드: '파드', 서비스: '서비스', OpenStack: 'OpenStack' }
    const runJob = (key: string, fn: () => Promise<unknown>): Promise<void> => {
      const cur = jobInflightRef.current[key]
      if (cur) {
        /**
         * 아직 돌고 있다는 것만으로는 '늦음' 이 아니다 — OpenStack CLI 는 원래 몇 초 걸려, 1초 주기마다 '갱신하지 못한 항목: OpenStack'
         * 이 떴다 사라졌다 했다(사용자 지적). 주기의 3배(최소 10초)를 넘겨서야 늦은 것으로 밝힌다. 정말 멈추면 '갱신 멈춤' 이 따로 뜬다.
         */
        const since = jobStartRef.current[key] ?? Date.now()
        if (Date.now() - since > Math.max(10_000, cfgRef.current.intervalSec * 3000)) delayed.add(JOB_LABEL[key] ?? key)
        return cur
      }
      jobStartRef.current[key] = Date.now()
      const p: Promise<void> = guard(key, fn).finally(() => {
        if (jobInflightRef.current[key] === p) delete jobInflightRef.current[key]
      })
      jobInflightRef.current[key] = p
      return p
    }
    const hostP = runJob('host', hostJob)
    const rest = [
      runJob('masakari', masakariJob),
      runJob('ceph', cephJob),
      runJob('파드', podJob),
      runJob('서비스', svcJob),
      runJob('OpenStack', osJob),
    ]
    if (!readyOnceRef.current) {
      await Promise.all([hostP, ...rest])
      readyOnceRef.current = true
    } else {
      await hostP
      // 다른 잡이 금방 끝나면 같은 프레임에 반영되게 잠깐만 기다린다(주기의 절반, 최대 2초) — 그보다 길면 뒤에서 마저 돈다
      await Promise.race([Promise.all(rest), new Promise((r) => setTimeout(r, Math.min(2000, cfgRef.current.intervalSec * 500)))])
    }
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
      label: (lastRunLabelRef.current = runLabelRef.current.trim()) || undefined,
      // ref 를 그대로 넣으면 이후 폴링이 같은 객체를 계속 수정한다 → 깊은 복사
      // 저장 뒤에 붙는 값(역할 이동 · 파드 Ready 시각 · pacemaker 시각)이 화면 이력만 바꾸고 저장본에는
      // 안 들어가는 일이 없게, 나중에 바뀌는 것은 전부 떼어 복사한다
      milestones: {
        ...ms,
        pods: [...ms.pods],
        portal: [...ms.portal],
        podsDone: ms.podsDone?.map((d) => ({ ...d })),
        podsBroken: ms.podsBroken?.map((d) => ({ ...d, workloads: [...d.workloads] })),
        k8sNotReady: ms.k8sNotReady?.map((d) => ({ ...d, nodes: [...d.nodes] })),
        portalFlaps: ms.portalFlaps?.map((d) => ({ ...d })),
        portalLog: ms.portalLog?.map((d) => ({ ...d })),
        logIssues: ms.logIssues?.map((d) => ({ ...d })),
        roles: ms.roles?.map((r) => ({ ...r })),
        vip: ms.vip ? { ...ms.vip } : undefined,
        down: ms.down ? { ...ms.down } : undefined,
        masakari: ms.masakari ? { ...ms.masakari } : undefined,
        masakariFail: ms.masakariFail?.map((x) => ({ ...x })),
        watched: ms.watched ? { ...ms.watched } : undefined,
        reconnect: ms.reconnect ? { ...ms.reconnect } : undefined,
        ceph: ms.ceph ? { ...ms.ceph } : undefined,
        cephHealthy: ms.cephHealthy ? { ...ms.cephHealthy } : undefined,
        portalPending: ms.portalPending?.length ? [...ms.portalPending] : undefined,
        portalWatched: ms.portalWatched?.length ? [...ms.portalWatched] : undefined,
        rejoin: ms.rejoin ? [...ms.rejoin] : undefined,
        k8sReady: ms.k8sReady ? [...ms.k8sReady] : undefined,
      },
    }
    const saved = historyRef.current
    // 진행 중인 회차를 다시 저장할 때 이력 창에서 적어 둔 원인 · 조치를 덮어 지우지 않게(rec 은 마일스톤으로만 새로 만든다)
    const prev = saved.find((h) => h.id === rec.id)
    if (prev?.notes?.length) rec.notes = prev.notes
    if (prev?.override) rec.override = prev.override
    // 그룹 · 차수: 이미 저장된 회차면 이력 창에서 바꾼 소속을 지키고, 처음 저장이면 상태보드에서 고른 '지금 그룹 · 차수' 로
    if (prev) {
      rec.groupId = prev.groupId
      rec.phaseId = prev.phaseId
    } else {
      const cg = curGroupRef.current
      const g = groupsRef.current.find((x) => x.id === cg.groupId)
      if (g) {
        rec.groupId = g.id
        rec.phaseId = g.phases.some((ph) => ph.id === cg.phaseId) ? cg.phaseId : undefined
      }
    }
    const all = [rec, ...saved.filter((h) => h.id !== rec.id)]
    // 보관 한도를 넘어 밀려나는 회차(그룹 밖 · 오래된 것)는 이력과 증적을 같이 지운다(HIST_MAX 주석)
    // 밀려난 회차의 증적은 **저장이 된 뒤에** 지운다 — 저장이 실패하면 저장본에는 그 회차가 남아 있어 증적 없는 회차가 됐다(코드 점검 10-30)
    const over = new Set(overflowOf(all))
    const next = over.size ? all.filter((h) => !over.has(h.id)) : all
    void persistHistory(next).then((ok) => {
      if (ok && over.size) dropEvidence([...over])
    })
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
        if (!open.open) return void bump(`${target.host}:${target.port} 아직 안 열림: 부팅 대기`)
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

  /**
   * 분산 점검 — 설정한 네임스페이스 전부를 한 번에 묻는다(네임스페이스마다 누르게 하지 않는다 — 10개가 넘으면 빠뜨린다).
   * 파드 세션이 없거나 네임스페이스가 없으면 null(점검 없이 시작한다 — 점검이 검증을 막아서는 안 된다).
   */
  const runSpread = async (only?: string[], quiet = false): Promise<SpreadResult | null> => {
    const c = cfgRef.current
    const ns = (only ?? c.namespaces).filter(Boolean)
    if (!c.pod || !connectedOf(c.pod) || !ns.length) return null
    // quiet: 검증 중 추가 점검(addedSpread) — 수동 [분산 점검] 버튼을 잠그지 않는다(둘이 겹치면 먼저 끝난 쪽이 busy 를 풀어 버린다)
    if (!quiet) setSpreadBusy(true)
    try {
      const r = await run(c.pod, SPREAD_CMD, 45_000)
      const parts = splitSpreadOutput(r.ok ? r.out ?? '' : '')
      const rows = r.ok && !r.timedOut ? parseSpread(parts.ctrl, parts.pods, ns) : null
      /*
       * Valkey 마스터 배치(2026-11-18 사용자 요청) — 위에서 받은 목록으로 대상을 찾아 그 파드의 nodes.conf 를 읽는다(valkeySpread 주석).
       * 분산 점검을 못 했으면 묻지 않는다. 읽기 실패는 '확인 못 함' 으로만 남고 시작을 막지 않는다.
       * 종료 코드는 끝의 크론잡 조회 것이라 보지 않고, 읽은 파드 표시(__QT_FROM__)로 판단한다
       */
      const sets = rows ? findValkeySets(parts.ctrl, parts.pods, ns) : []
      const valkey = await Promise.all(
        sets.map(async (set) => {
          const v = await run(c.pod, valkeyCmd(set), 50_000)
          return judgeValkey(set, v.timedOut ? '' : v.out ?? '', !v.timedOut)
        }),
      )
      return {
        at: Date.now(),
        rows,
        valkey,
        descheduler: parts.descheduler,
        namespaces: ns,
        error: rows ? undefined : r.timedOut ? '시간 초과' : 'kubectl 응답을 읽지 못함',
      }
    } finally {
      if (!quiet) setSpreadBusy(false)
    }
  }
  /** 분산 점검 결과를 그 회차 증적으로 — 리포트에 '검증 전(또는 회차 사이) 분산 상태' 로 남는다 */
  const saveSpreadEvidence = (runT0: number, res: SpreadResult, when: 'pre' | 'mid') => {
    if (!res.rows) return
    const bad = res.rows.filter((w) => w.verdict === 'stacked')
    saveEvidence(runT0, {
      key: when === 'pre' ? 'spread' : `spread:${res.at}`,
      title: when === 'pre' ? '검증 전 파드 분산 상태' : `파드 분산 상태: ${fmtClock(res.at)}`,
      capturedAt: res.at,
      host: nameOf(cfgRef.current.pod),
      command: 'kubectl get deploy,sts -A -o json  ·  kubectl get pods -A (노드 · 주인)  ·  descheduler 유무',
      verifyCmd: "kubectl get deploy,sts -n <ns> -o custom-columns='NAME:.metadata.name,REPLICAS:.spec.replicas,ANTI:.spec.template.spec.affinity.podAntiAffinity'",
      text: [
        'NS\tWORKLOAD\tREPLICAS\tANTI-AFFINITY\tSPREAD\t배치(노드별 Running)\t판정 · 노드가 죽으면',
        ...res.rows.map((w) => `${w.ns}\t${w.name}\t${w.replicas}\t${SPREAD_RULE[w.anti]}\t${SPREAD_RULE[w.spread]}\t${placementText(w)}\t${verdictLabel(w)}. ${spreadMeaning(w, res.descheduler)}`),
        '',
        `descheduler: ${res.descheduler == null ? '확인 못 함' : res.descheduler ? '있음' : '없음. 권장 분산은 노드가 돌아와도 다시 나뉘지 않습니다.'}`,
        ...(res.valkey ?? []).flatMap((v) => ['', ...valkeyEvidenceLines(v)]),
      ].join('\n'),
      focus: [...bad.map((w) => `${w.name} `), ...(res.valkey?.some(valkeyBad) ? ['마스터 몰림', '같은 노드'] : [])],
      facts: [
        { label: '점검한 네임스페이스', text: `${res.namespaces.length}개` },
        { label: '한 노드에 몰림', text: `${bad.length}개 워크로드` },
        ...(res.valkey ?? []).map((v) => ({ label: `Valkey 마스터 배치(${v.name})`, text: valkeySummary(v) })),
        { label: '필수 규칙 없음(권장만 · 규칙 없음)', text: `${res.rows.filter((w) => w.verdict === 'soft' || w.verdict === 'none').length}개` },
      ],
      note: `레플리카가 한 노드에만 있으면 그 노드를 내렸을 때 그 워크로드는 통째로 끊깁니다. ${SPREAD_NOTE_NEW}`,
    })
  }
  /**
   * 수동 [분산 점검] — 회차 사이(노드가 돌아온 뒤 다음 노드를 내리기 전)에 쓴다. 결과 창으로만 보이고 증적에는 남기지 않는다
   * (2026-11-10 사용자 결정: 검증 중에 누른 점검이 증적 · 리포트에 '파드 분산 상태 (장애 중)' 으로 섞였다. 회차 증적은 시작 직전 점검 하나면 된다).
   * 예전 회차에 남은 'spread:<시각>' 증적은 그대로 읽힌다.
   */
  const checkSpreadNow = async () => {
    if (spreadBusy) return
    const res = await runSpread()
    if (!res) return setSpreadView({ mode: 'manual', res: { at: Date.now(), rows: null, descheduler: null, namespaces: [], error: '파드 세션이 연결돼 있지 않거나 네임스페이스가 없습니다' } })
    setSpreadView({ mode: 'manual', res })
  }
  /**
   * 검증 중에 네임스페이스를 더하면 **더한 것만** 분산 점검을 다시 돌린다(2026-11-16 사용자 결정).
   * 시작 점검은 그때 설정한 네임스페이스만 보므로, 나중에 더한 cicd 의 harbor 가 한 노드에 몰려 있어도 확인 없이 시작됐다.
   *  - 결과는 창을 띄우지 않고 [분산 점검] 버튼 옆 표시로만 알린다(화면이 저절로 움직이지 않게). 누르면 창이 열린다.
   *  - 장애 중일 수 있는 배치라 창 제목에 시점을 밝힌다(권장 분산은 죽은 노드 때문에 몰려 보일 수 있다).
   *  - 증적 · 리포트에는 남기지 않는다(2026-11-10 결정: 검증 중 점검은 증적에 섞지 않는다).
   * checkedNsRef = 이번 회차에서 이미 본 네임스페이스(시작 점검 + 추가 점검). 지웠다 다시 더한 것은 다시 보지 않는다.
   */
  const checkedNsRef = useRef<Set<string>>(new Set())
  const addedNsRef = useRef<string[]>([])
  const addedGenRef = useRef(0)
  const [addedSpread, setAddedSpread] = useState<{ busy: boolean; res: SpreadResult | null; at: number } | null>(null)
  const runAddedSpread = async () => {
    const t0 = t0Ref.current
    const gen = ++addedGenRef.current
    const ns = addedNsRef.current.filter((n) => cfgRef.current.namespaces.includes(n))
    if (!ns.length) return setAddedSpread(null)
    setAddedSpread((cur) => ({ busy: true, res: cur?.res ?? null, at: Date.now() }))
    const res = await runSpread(ns, true)
    // 그 사이 회차가 바뀌었거나 더 새 점검이 시작됐으면 버린다
    if (!mountedRef.current || t0 !== t0Ref.current || gen !== addedGenRef.current) return
    const out = res ?? { at: Date.now(), rows: null, descheduler: null, namespaces: ns, error: '파드 세션이 연결돼 있지 않습니다' }
    setAddedSpread({ busy: false, res: out, at: out.at })
    setSpreadView((v) => (v?.mode === 'added' ? { mode: 'added', res: out } : v))
  }
  useEffect(() => {
    if (!running) return
    const added = cfg.namespaces.filter((n) => n && !checkedNsRef.current.has(n))
    if (!added.length) return
    // 한 개씩 입력해 더하는 경우가 많아 잠깐 모았다가 한 번에 묻는다
    const id = window.setTimeout(() => {
      for (const n of added) checkedNsRef.current.add(n)
      addedNsRef.current = [...addedNsRef.current, ...added.filter((n) => !addedNsRef.current.includes(n))]
      void runAddedSpread()
    }, 2000)
    return () => window.clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg.namespaces, running])
  /** 시작 직전 점검 결과 — beginRun 뒤 그 회차 증적으로 저장한다(t0 가 정해져야 저장할 자리가 생긴다) */
  const pendingSpreadRef = useRef<SpreadResult | null>(null)
  /**
   * [시작] — 먼저 분산 점검을 돌리고, 레플리카가 한 노드에 몰린 워크로드가 있으면 확인 창을 띄운다(사용자 결정 — 경고만이 아니라
   * 확인을 받되 [무시하고 시작] 으로 넘어갈 수 있게). 문제가 없거나 점검을 못 했으면 그대로 시작한다.
   */
  const start = () => {
    if (!cfg.hosts.filter(Boolean).length || startingRef.current || spreadBusy || running) return
    void (async () => {
      const res = await runSpread()
      pendingSpreadRef.current = res
      if (res?.rows?.some((w) => w.verdict === 'stacked') || res?.valkey?.some(valkeyBad)) return setSpreadView({ mode: 'precheck', res })
      startNow()
    })()
  }
  const startNow = () => {
    if (!cfg.hosts.filter(Boolean).length) return
    if (startingRef.current) return
    startingRef.current = true
    void (async () => {
      // 앞 회차의 폴링이 아직 돌고 있으면 끝나기를 기다린다(위 pollInflightRef 주석).
      // 재연결 감시(probe)는 기다리지 않는다 — SSH 재접속을 수십 초 붙잡고 있을 수 있어 시작 버튼이 죽은
      // 것처럼 보였다. probe 는 마일스톤을 쓰지 않고, 아래에서 상태를 비운 뒤 다음 주기에 덮인다.
      // 뒤에서 마저 도는 느린 잡도 기다린다 — 앞 회차의 Ceph·파드 결과가 새 회차 마일스톤에 써지면 안 된다
      await Promise.allSettled([pollInflightRef.current, ...Object.values(jobInflightRef.current)])
      startingRef.current = false
      if (!mountedRef.current) return
      beginRun()
      const sp = pendingSpreadRef.current
      pendingSpreadRef.current = null
      // 시작 점검이 본 범위 — 점검을 못 했으면(파드 세션 없음) 설정값을 본 것으로 친다. 나중에 세션이 붙었다고 전부를 '추가' 로 다시 보지 않게
      checkedNsRef.current = new Set(sp?.namespaces ?? cfgRef.current.namespaces)
      addedNsRef.current = []
      addedGenRef.current++
      setAddedSpread(null)
      if (sp) saveSpreadEvidence(t0Ref.current, sp, 'pre')
    })()
  }
  const beginRun = () => {
    t0Ref.current = Date.now()
    autoLabeledRef.current = false
    if (runLabelRef.current.trim() && runLabelRef.current.trim() === lastRunLabelRef.current) {
      runLabelRef.current = ''
      setRunLabel('')
    }
    lastRunLabelRef.current = ''
    notifiedRef.current = { down: false, recovered: false }
    msRef.current = { ...emptyMilestones(), watched: { masakari: cfgRef.current.masakari.filter(Boolean).length > 0 } }
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
    k8sNodesSeenRef.current = false
    readyOnceRef.current = false
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
    /**
     * 뒤에서 돌던 잡이 중지 뒤에 끝나며 마일스톤(다시 비정상 · Masakari 실패 등)을 남기면 저장본에 빠졌다(코드 점검). 끝나기를 기다려
     * 한 번 더 저장한다. 다시 시작할 때도 이 잡들을 기다리므로(start) 새 회차와 섞이지 않는다 — 이 then 이 먼저 돈다.
     */
    const pending = Object.values(jobInflightRef.current)
    if (pending.length) {
      const runT0 = t0Ref.current
      void Promise.allSettled(pending).then(() => {
        if (t0Ref.current === runT0) commitRef.current(Date.now(), true)
      })
    }
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
  /** 분산 점검 — 진행 중 · 결과 창(시작 전 확인 / 수동 점검) */
  const [spreadBusy, setSpreadBusy] = useState(false)
  const [spreadView, setSpreadView] = useState<{ mode: 'precheck' | 'manual' | 'added'; res: SpreadResult } | null>(null)
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
  /** 장애 뒤 감시한 화면 — 회차 동안 본 화면을 모두 모은다(중간에 설정을 바꿔 빠진 화면도 그 회차에서는 감시했던 것) */
  /** 포털 응답 시간을 회차 기록에 쌓는다 — 검증 중일 때만. 저장은 다른 기록이 저장될 때 함께(요청마다 파일을 쓰지 않는다) */
  const addPortalSamples = useCallback((at: number, list: LatSample[]) => {
    if (!runningRef.current || !list.length || !t0Ref.current) return
    addLatSamples((msRef.current.portalLat ??= { v: 1, apis: [] }), t0Ref.current, at, list)
  }, [])
  const setPortalWatched = useCallback((names: string[]) => {
    const cur = msRef.current.portalWatched ?? []
    const add = names.filter((n) => !cur.includes(n))
    if (!add.length) return
    msRef.current.portalWatched = [...cur, ...add]
    if (savedRef.current) commitRef.current(closedAtRef.current, true)
  }, [])
  const setPortalPending = useCallback((names: string[]) => {
    const cur = msRef.current.portalPending ?? []
    if (cur.length === names.length && cur.every((n, i) => n === names[i])) return
    msRef.current.portalPending = names
    if (savedRef.current) commitRef.current(closedAtRef.current, true)
    forceTick((n) => n + 1)
  }, [])
  /**
   * 다시 깨진 대상 — `portal`(최종 정상화 목록)에서는 거두고, 그 정상화와 다시 끊긴 시각은 portalFlaps 에 남긴다.
   * 예전에는 거두기만 해서 '한 번 돌아왔다 다시 끊겼다' 가 기록에서 사라졌다(사용자 지적). 다시 복구되면
   * addPortalMilestones 가 새 시각으로 올린다.
   */
  const revokePortalMilestone = useCallback((name: string, downAt: number) => {
    const cur = msRef.current.portal.find((x) => x.name === name)
    if (cur) (msRef.current.portalFlaps ??= []).push({ name, group: cur.group, upAt: cur.at, downAt })
    msRef.current.portal = msRef.current.portal.filter((x) => x.name !== name)
    if (savedRef.current) commitRef.current(closedAtRef.current, true)
    forceTick((n) => n + 1)
  }, [])

  /**
   * 포털 판정이 바뀐 순간을 쌓고 '포털 응답 기록' 증적을 다시 만든다(같은 key 라 덮어쓴다). 포털은 서버 원문이 아니라 Q-Term 이 직접
   * 요청한 결과라 host 를 'Q-Term (이 PC)' 로 밝힌다. 회차가 길어도 바뀐 순간만이라 수십 줄이지만, 흔들림이 끝없는 경우를 위해 상한을 둔다.
   */
  const addPortalEvent = useCallback((ev: PortalEvent) => {
    const ms = msRef.current
    const log = (ms.portalLog ??= [])
    if (log.length >= PORTAL_LOG_MAX) return
    log.push(ev)
    const ph = portalPhases(ms)
    const tbl = portalPageRows(ms, log)
    saveEvidenceRef.current(t0Ref.current, {
      key: 'portal',
      title: '포털 응답 기록',
      capturedAt: Date.now(),
      host: 'Q-Term (이 PC)',
      command: `포털 감시: 화면마다 그 화면이 부르는 API 를 주기적으로 요청(핵심 API 가 모두 정상이어야 화면 정상) · 연속 ${ev.n ?? 'N'}회 정상 = 정상화 확정 · 연속 ${ev.n ?? 'N'}회 실패 = 다시 끊김 확정`,
      text: portalLogText(log),
      // 처음 스크롤할 자리 = 마지막 정상화 확정 줄
      focus: log.filter((e) => e.kind === 'up').map((e) => `${fmtClock(e.at)}	${e.name}`).slice(-1),
      facts: [
        ...(() => {
          const f = [...log].filter((e) => e.kind === 'fail').sort((a, b) => a.at - b.at)[0]
          return f ? [{ label: `최초 끊김 (${f.name})`, at: f.at }] : []
        })(),
        ...(ph.firstAll != null ? [{ label: `1차 정상화: ${ph.total}개 화면이 처음 모두 정상${ph.calm ? `(끊기지 않은 ${ph.calm}개 포함)` : ''}`, at: ph.firstAll }] : []),
        ...(ms.portalFlaps ?? []).map((x) => ({ label: `다시 끊김: ${x.name}`, at: x.downAt })),
        ...(ph.finalAll != null && ph.flaps ? [{ label: '최종 정상화: 그 뒤 다시 끊기지 않음', at: ph.finalAll }] : []),
        ...(ms.portalPending?.length ? [{ label: '아직 안 돌아온 화면', text: ms.portalPending.join(', ') }] : []),
      ],
      table: { title: '화면별', ...tbl },
      /*
       * 연속 통과 기록 — 정상화를 확정할 때마다 하나(그 화면의 연속 N회 + 바로 앞 실패 1회, 핵심 API 마다의 응답). 1차 · 최종 정상화를
       * 만든 화면에는 그 사실을 붙인다. 흔들림이 길면 표가 끝없이 늘므로 최근 8개만(원문 · 화면별 표에는 전부 있다)
       */
      tables: log
        .filter((e) => e.kind === 'up' && e.streak?.length)
        .slice(-8)
        .map((e) => portalStreakTable(e, e.at === ph.finalAll && ph.flaps ? '최종 정상화' : e.at === ph.firstAll ? '1차 정상화를 채운 화면' : ''))
        .filter((x): x is NonNullable<typeof x> => !!x),
      note: 'Q-Term 이 직접 요청해 본 결과입니다(서버 기록 아님). 각 시각은 그 상태가 시작된 첫 응답이고, 연속 기준을 채워 확정한 시각은 원문의 → 뒤에 있습니다. 연속 통과 기록의 칸에 마우스를 올리면 HTTP · 응답 시간 · 실패 사유가 보입니다.',
    })
  }, [])

  /**
   * 파드 로그 이상 감시(10-28) — 보드를 띄워 두면 늘 돈다. 검증 중에 **새로** 나온 오류는 타임라인 한 줄 + 증적으로 남긴다
   * (파드는 다 Running 인데 서비스는 깨진 경우가 표에는 안 보인다).
   */
  const podSid = cfg.pod && connectedOf(cfg.pod) ? cfg.pod : undefined
  const restarts: Record<string, number> = {}
  for (const p of state?.pods ?? [])
    for (const r of p.rows) {
      const n = parseInt(r.restarts ?? '', 10)
      if (!Number.isNaN(n)) restarts[`${p.namespace}/${r.name}`] = n
    }
  /**
   * 로그 줄 시각은 노드(kubelet) 시계다 — 검증 시작(PC 시계)과 견주려면 호스트 시계 차이(skew)를 더해 노드 시계로 바꾼다
   * (CLAUDE.md: 원격 시각은 호스트 시계 오차를 빼서 맞춘다). 노드가 30초 늦으면 검증 10초 뒤 오류가 시작 전으로 읽혀 빠졌다(코드 점검 10-29).
   * kubectl 서버의 시계로 잰다(노드들은 같은 NTP 를 쓴다고 본다). 못 재면 0 — 증적에 그 사실을 적는다.
   * 잰 값이 오기 전에는 검증 시작을 넘기지 않는다: 넘겼다가 바꾸면 그 사이 센 줄의 '검증 뒤 처음 본 시각' 을 잃는다.
   */
  const [logSkew, setLogSkew] = useState<{ t0: number; skew: number; ok: boolean } | null>(null)
  useEffect(() => {
    if (!running || !podSid) return
    const runT0 = t0Ref.current
    if (logSkew?.t0 === runT0) return
    let alive = true
    void measureClock(podSid)
      .catch(() => null)
      .then((m) => {
        if (alive) setLogSkew({ t0: runT0, skew: m?.skew ?? 0, ok: !!m })
      })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, podSid, logSkew?.t0])
  const skewNow = running && logSkew?.t0 === t0Ref.current ? logSkew : null
  const logWatch = usePodLogWatch({
    sessionId: podSid,
    namespaces: cfg.namespaces,
    enabled: cfg.logWatch !== false,
    intervalSec: cfg.logWatchSec ?? 60,
    ignore: cfg.logIgnore ?? [],
    extraWords: cfg.logWords ?? [],
    runningSince: skewNow ? t0Ref.current + skewNow.skew : null,
    restarts,
  })
  /**
   * 이번 검증의 새 로그 이상을 회차 기록 · 증적에 올리고, 이미 올린 것은 횟수 · 마지막 시각을 따라 올린다(코드 점검 10-29).
   * 예전엔 묶음이 처음 생길 때(onNew) 한 번만 올려서, 롤링 2회차에 1회차와 같은 오류가 다시 나도 기록이 비었다 — 지금은 훑을 때마다
   * 묶음의 '검증 뒤' 값으로 가른다(lib/podLogScan newInRun). 시각은 PC 시계로 되돌려 둔다(skew 를 뺀다).
   * 증적 key 에는 묶음 key 의 해시를 넣는다 — 시각 · 워크로드만으로는 같은 순간의 ERROR · WARN 두 묶음이나 다른 네임스페이스의
   * 같은 이름 워크로드가 서로 덮어썼다.
   */
  useEffect(() => {
    if (!running || !skewNow) return
    const runT0 = t0Ref.current
    const skew = skewNow.skew
    const runSince = runT0 + skew
    // 감시 결과가 아직 앞 회차(또는 검증 전) 기준이면 기다린다 — 롤링에서 1회차가 끝나고 다음 훑기 전에 2회차를 시작하면,
    // 1회차 기준의 묶음이 2회차의 '새 오류' 로 올라가 2회차 시작보다 앞선 시각으로 찍혔다(코드 검토 10-29)
    if (logWatch.state.runSince !== runSince) return
    const ms = msRef.current
    let added = false
    for (const g of logWatch.state.groups) {
      const x = (ms.logIssues ?? []).find((k) => k.key === g.key)
      if (x) {
        x.count = g.countRun ?? x.count
        x.last = g.last - skew
        x.pods = g.pods.length
        x.level = g.level
        continue
      }
      if (!newInRun(g, runSince)) continue
      const at = (g.sinceRun as number) - skew
      // 회차당 한도 — 넘친 종류는 개수만(LOG_ISSUES_MAX 주석)
      if ((ms.logIssues?.length ?? 0) >= LOG_ISSUES_MAX) {
        const r = recordDropped(ms.logIssuesDropped, keyHash(g.key), at, LOG_DROPPED_KEYS_MAX)
        ms.logIssuesDropped = r.next
        if (r.changed) added = true
        continue
      }
      const ev = `podlog:${at}:${keyHash(g.key)}`
      const item = { at, ns: g.ns, workload: g.workload, text: groupHeadline(g), level: g.level, pods: g.pods.length, key: g.key, count: g.countRun ?? 1, last: g.last - skew, ev }
      ;(ms.logIssues ??= []).push(item)
      added = true
      saveEvidence(runT0, {
        key: ev,
        title: `${g.ns} 파드 로그: ${item.text}`,
        capturedAt: Date.now(),
        host: sessions.find((x2) => x2.id === podSid)?.name ?? '파드 세션',
        command: `kubectl logs -n ${g.ns} <파드> --all-containers --timestamps --since=… | grep -E -i (오류 · 경고 단어)`,
        text: [g.sample, g.cause ? g.cause : ''].filter(Boolean).join('\n'),
        focus: [g.sample.slice(0, 60)],
        facts: [
          { label: '검증 뒤 처음 본 줄', at },
          { label: '파드', text: g.pods.join(', ') },
          ...(g.target ? [{ label: '연결 대상', text: `${g.target}${g.kind ? ` (${g.kind})` : ''}` }] : []),
          ...(g.cause ? [{ label: '원인 줄', text: g.cause }] : []),
        ],
        note:
          '평소 오류(감시를 켠 뒤 처음 5분)와 검증 시작 전 5분 안에 이미 나던 오류는 빼고, 이번 검증 뒤에 새로 나온 것만 남깁니다. ' +
          (skewNow.ok
            ? `시각은 노드가 찍은 로그 시각을 이 PC 시계로 바꾼 값입니다(호스트 시계 차이 ${(skew / 1000).toFixed(1)}초 보정).`
            : '호스트 시계 차이를 재지 못해 노드가 찍은 로그 시각을 그대로 썼습니다.') +
          ' 앞뒤 줄은 [로그 열기] 의 [이 구간 저장] 으로 더 남길 수 있습니다.',
      })
    }
    if (added && savedRef.current) commitRef.current(closedAtRef.current, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [logWatch.state, running, skewNow])
  /** 로그 이상 창(네임스페이스로 좁혀 열 수 있다) · 합친 로그 창 */
  const [logList, setLogList] = useState<{ ns?: string } | null>(null)
  const [logOpen, setLogOpen] = useState<LogGroup | null>(null)

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
    /**
     * masakari 가 evacuation 을 **실패로 확정**(failed)했고 어느 엔진도 완료·진행 중이 아니면 기다릴 것이 없다 — '복구 진행 중'
     * 으로 두면 사람이 하염없이 기다린다. error 는 masakari 가 다시 집어 가므로 아직 진행 중으로 둔다.
     */
    const masaFailed =
      state.masakari.some((m) => m.state === 'failed') &&
      !state.masakari.some((m) => m.state === 'finished' || m.state === 'progress')
    if (masaFailed)
      return {
        label: 'Masakari evacuation 실패',
        cls: 'bg-red-500/20 text-red-300',
        detail: state.masakari.filter((m) => m.state === 'failed').map((m) => `${m.name}: ${m.detail}`).join('\n'),
      }
    /**
     * **장애가 아직 안 났으면** '복구 진행 중' 이 아니다. 예전엔 시작하자마자 Ceph 경고·비정상 파드가 하나라도 있으면 노란
     * '복구 진행 중' 이 떠, 노드를 죽이기도 전에 시작된 것처럼 보였다(사용자 지적). 채운 노랑은 장애 뒤에만 쓴다.
     *  · 모두 정상 → '장애 대기 중'(회청색 테두리 — 준비됐고 기다리는 중)
     *  · 이미 이상 → '장애 대기 중 · 시작 전부터 이상'(노랑 테두리) — 앞 회차가 덜 풀린 채 다음 노드를 죽이면 안 된다는 신호라
     *    '대기' 와 섞지 않는다. 조회 실패(확인 불가)는 아래 기존 판정이 빨강으로 따로 짚는다.
     */
    const ceph = state.ceph
    const unsureNow = ceph?.health === 'unknown' || state.pods.some((p) => p.unknown)
    if (!hadDown && downCount === 0 && !unsureNow) {
      const pre: string[] = []
      if (!cephOk) pre.push('Ceph')
      const badNs = state.pods.filter((p) => p.abnormalCount > 0).length
      if (badNs) pre.push(`파드 ${badNs}개 ns`)
      if (state.masakari.some((m) => m.state === 'progress' || m.state === 'error')) pre.push('Masakari')
      if (!pre.length) return { label: '장애 대기 중', cls: 'border border-sky-400/40 text-sky-200' }
      return {
        label: '장애 대기 중 · 시작 전부터 이상',
        cls: 'border border-amber-400/50 text-amber-200',
        detail: `장애를 넣기 전부터 정상이 아닌 항목: ${pre.join(' · ')}: 앞 회차가 덜 풀렸다면 다 돌아온 뒤 다음 노드를 내리세요`,
      }
    }
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
        label: `확인 불가: ${unsure.join(' · ')}`,
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
      notifyOs('장애 감지', `${d.node} DOWN: 복구 감시를 시작합니다`)
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

  /*
   * 최소화: 칩만 보이고 보드는 **숨기기만** 한다(display:none). 예전엔 최소화하면 칩만 돌려주고(early return) 보드 본문을 내려서,
   * 그 안의 포털 감시(PortalPanel) · 파드 로그 감시가 언마운트됐다. 최소화한 동안 포털을 조회하지 않았고, 다시 펼치면 감시가 새로
   * 시작돼 화면마다 '끊김 · 정상화' 상태를 잊었다 — 2026-11-10 8회차: 이미 끊긴 화면에 '처음 끊김' 이 또 찍히고, 정상화됐던 화면이
   * 다시 끊긴 것이 '다시 끊김' 이 아니라 '처음 끊김' 으로 남아 최종 정상화가 1차보다 이르게 굳었다(포털 실패가 성공으로 나옴).
   * 다시 early return 으로 바꾸지 말 것: 상태보드 폴링(이 컴포넌트)만 살아 있어도 그 자식 감시는 죽는다.
   */
  const minChip = minimized ? (
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
        <button onClick={requestClose} title="닫기" className="rounded p-1 text-gray-400 hover:bg-white/10 hover:text-gray-200">
          <X size={14} />
        </button>
      </div>
  ) : null

  return (
    <>
    {minChip}
    {/* 배경 클릭으로 닫히지 않게 한다(검증 중 실수 방지). 닫기는 X, 잠깐 비켜두려면 최소화 사용. 최소화 중에는 숨기기만 한다(minChip 주석) */}
    <div className={'fixed inset-0 z-50 items-center justify-center bg-black/60 p-8 ' + (minimized ? 'hidden' : 'flex')}>
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
              title="노드를 끈(장애를 넣은) 순간 누르세요. 그 시각을 '장애 주입' 으로 남겨 '주입 → DOWN 감지' 지연과 주입부터의 복구 시간을 리포트에 함께 적습니다. 다시 누르면 새 시각으로 바뀝니다"
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
                    downAt={downBaseOf(msRef.current, t0Ref.current)?.at}
                    runAt={t0Ref.current || undefined}
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
          {view === 'board' && groups.length > 0 && (
            <span
              className="ml-2 flex shrink-0 items-center gap-1"
              title="새 회차가 들어갈 검증 그룹 · 차수. 회차가 처음 저장될 때 붙고, 나중에 이력 창에서 바꿀 수 있습니다"
            >
              <select
                value={curGroup.groupId ?? ''}
                onChange={(e) => setCurGroup(e.target.value ? { groupId: e.target.value } : {})}
                className="max-w-[170px] rounded border border-white/10 bg-panel-light px-1.5 py-1 text-[11px] text-gray-100"
              >
                <option value="">그룹 없음</option>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
              {(() => {
                const g = groups.find((x) => x.id === curGroup.groupId)
                return g ? (
                  <select
                    value={curGroup.phaseId ?? ''}
                    onChange={(e) => setCurGroup({ groupId: g.id, phaseId: e.target.value || undefined })}
                    className="max-w-[110px] rounded border border-white/10 bg-panel-light px-1.5 py-1 text-[11px] text-gray-100"
                  >
                    <option value="">차수 없음</option>
                    {g.phases.map((ph) => (
                      <option key={ph.id} value={ph.id}>
                        {ph.name}
                      </option>
                    ))}
                  </select>
                ) : null
              })()}
            </span>
          )}
          {view === 'board' && (
            <input
              value={runLabel}
              onChange={(e) => setRunLabel(e.target.value)}
              placeholder="회차 이름 (장애 감지 시 자동)"
              title="이력에 저장됩니다. 비워 두면 장애가 감지될 때 '08-30 18:40 con2 down' 형태로 채워 드립니다. 적어 두신 것이 있으면 건드리지 않습니다"
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
                  title="역할 매핑 보기: 검증은 계속 진행됩니다"
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
            <button onClick={requestClose} title="닫기 (검증 종료)" className="rounded p-1 text-gray-400 hover:bg-white/10 hover:text-gray-200">
              <X size={16} />
            </button>
          </div>
        </div>

        {/*
          포털 감시: 설정 화면과 검증 화면 **양쪽 바깥**에 둔다.
           · 검증을 시작하기 전에 주소·계정·대상을 미리 맞춰둘 수 있어야 한다(설정 화면에서도 보여야 함).
           · 검증 도중 '설정' 으로 잠깐 넘어가도 감시가 끊기면 안 된다. 뷰 안에 두면 그때 언마운트되어
             폴링이 멈추고 연속 카운트가 초기화된다. 측정에 구멍이 생긴다.
        */}
        {histErr && (
          <div className="shrink-0 border-b border-red-500/40 bg-red-500/15 px-4 py-1.5 text-[12px] text-red-200">⚠ {histErr}</div>
        )}
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
            onWatched={setPortalWatched}
            onEvent={addPortalEvent}
            onSamples={addPortalSamples}
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
                검증이 <strong>계속 진행 중</strong>입니다. 매핑만 확인하고 위 <strong>'검증 화면으로'</strong>를 누르면 지금까지의
                타임라인이 그대로 유지됩니다. (여기서 매핑을 바꾸면 다음 주기부터 반영됩니다)
              </div>
            )}
            <ConfigView
              cfg={cfg}
              connected={connected}
              sessions={sessions}
              onChange={saveCfg}
              canStart={canStart && !spreadBusy}
              onStart={start}
              checking={spreadBusy}
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
            podSession={cfg.pod && connectedOf(cfg.pod) ? cfg.pod : undefined}
            onSpreadCheck={() => void checkSpreadNow()}
            spreadBusy={spreadBusy}
            addedSpread={running ? addedSpread : null}
            onAddedSpreadOpen={() => addedSpread?.res && setSpreadView({ mode: 'added', res: addedSpread.res })}
            onMasakariLog={onOpenLiveLog ? (id) => onOpenLiveLog(id, cfg.logPath) : undefined}
            logWatch={cfg.logWatch !== false && podSid ? logWatch : null}
            onLogIssues={(ns) => setLogList({ ns })}
            cephHost={cfg.ceph ? nameOf(cfg.ceph) : undefined}
            onCephRun={async (kind) => {
              const sid = cfgRef.current.ceph
              if (!sid || !connectedOf(sid)) return { ok: false, out: '', at: Date.now(), err: 'Ceph 세션이 연결돼 있지 않습니다' }
              // 조회만 — health detail 은 경고의 자세한 수치, log last 50 은 경고가 언제 시작 · 해소됐는지
              const c = kind === 'detail' ? 'ceph health detail' : 'ceph log last 50'
              /*
               * stderr 도 같이 받고 종료 코드를 붙인다(runMerged). dev 에서 클러스터 로그가 '조회 실패' 로만 떠(11-07) 실패인지 ·
               * 돌았는데 출력이 없는지 · ceph 가 무슨 말을 했는지 알 수 없었다 — 원인은 결과가 stderr 로 나와 버려진 것이었다.
               */
              const r = await runMerged(sid, c, 20_000)
              const rc = r.rc
              const out = (r.out ?? '').trim()
              const err = r.timedOut
                ? '시간 초과(20초)'
                : !r.ok
                  ? `실행하지 못함${r.error ? `: ${r.error}` : ''}`
                  : rc != null && rc !== 0
                    ? `종료 코드 ${rc}${out ? '' : ' · 출력 없음'}`
                    : !out
                      ? kind === 'log'
                        ? '명령은 끝났지만 출력이 없습니다. 이 클러스터는 모니터에 클러스터 로그를 남기지 않을 수 있습니다(ceph -s · health detail 이 근거입니다).'
                        : '명령은 끝났지만 출력이 없습니다.'
                      : undefined
              return { ok: !err, out, at: Date.now(), err }
            }}
            onLogGroup={(key) => {
              const g = logWatch.state.groups.find((x) => x.key === key)
              if (!g) return false
              setLogOpen(g)
              return true
            }}
          />
        )}
      </div>
      {logList && (
        <LogIssuesModal info={logWatch} initialNs={logList.ns} onOpen={(g) => setLogOpen(g)} onRescan={logWatch.rescan} onClose={() => setLogList(null)} />
      )}
      {logOpen && (
        <MergedLogModal
          group={logOpen}
          sessionId={podSid}
          extraPods={(state?.pods.find((p) => p.namespace === logOpen.ns)?.rows ?? [])
            .map((r) => r.name)
            .filter((n) => n.startsWith(logOpen.workload + '-') && !logOpen.pods.includes(n))}
          onClose={() => setLogOpen(null)}
          onLive={onOpenLiveLog && podSid ? (pod) => onOpenLiveLog(podSid, { kind: 'k8s', namespace: logOpen.ns, pod }) : undefined}
          onSave={
            running
              ? (text) =>
                  saveEvidence(t0Ref.current, {
                    key: `podlog:${logOpen.first}:view:${Date.now()}`,
                    title: `${logOpen.ns} 파드 로그 구간: ${groupHeadline(logOpen)}`,
                    capturedAt: Date.now(),
                    host: sessions.find((x) => x.id === podSid)?.name ?? '파드 세션',
                    command: `kubectl logs -n ${logOpen.ns} <파드> --all-containers --timestamps --since=…`,
                    text,
                    note: '[로그 열기] 에서 지금 보이던 줄(고른 파드 · 보기 방식 그대로)을 남긴 것입니다.',
                  })
              : undefined
          }
          onAnalyze={
            onAnalyzeText
              ? (text, part) => {
                  onAnalyzeText(text, `${logOpen.ns} 파드 로그`, part)
                  setLogOpen(null)
                  setLogList(null)
                  setMinimized(true)
                }
              : undefined
          }
        />
      )}
      {spreadView && (
        <SpreadModal
          mode={spreadView.mode}
          res={spreadView.res}
          busy={spreadView.mode === 'added' ? !!addedSpread?.busy : spreadBusy}
          onClose={() => {
            pendingSpreadRef.current = null
            setSpreadView(null)
          }}
          onProceed={() => {
            setSpreadView(null)
            startNow()
          }}
          onRecheck={() => void (spreadView.mode === 'added' ? runAddedSpread() : checkSpreadNow())}
        />
      )}
      {showHistory && (
        <HistoryView
          list={history}
          loading={!histLoaded}
          groups={groups}
          onSaveGroups={(next) => applyGroups(next)}
          initialGroupId={curGroup.groupId}
          novaFetch={novaFetch}
          envCollect={envCollect}
          onAssign={(map, nextGroups) => {
            const hist = historyRef.current.map((h) => {
              const m = map[h.id]
              return m ? { ...h, groupId: m.groupId, phaseId: m.groupId ? m.phaseId : undefined } : h
            })
            return applyGroups(nextGroups ?? groups, hist)
          }}
          evIndex={evIndex}
          onEvidence={(id, key) => setEvOpen({ id, key })}
          onClose={() => setShowHistory(false)}
          onClear={() => history.length && setAskDrop({ ids: history.map((h) => h.id), all: true })}
          onRemove={(id) => setAskDrop({ ids: [id], all: false })}
          onRename={(id, label) => {
            // 지금 진행 중인 회차면 입력칸에도 — 안 그러면 다음 갱신 저장(commitHistory)이 입력칸 이름으로 되돌린다(코드 점검 10-30)
            if (id === String(t0Ref.current) && savedRef.current) {
              runLabelRef.current = label
              setRunLabel(label)
            }
            const next = historyRef.current.map((h) => (h.id === id ? { ...h, label: label.trim() || undefined } : h))
            void persistHistory(next)
            setHistory(next)
          }}
          onSetInject={(id, inject) => {
            // 지금 진행 중인 회차면 메모리에도 넣는다 — 안 그러면 다음 갱신 저장이 이 값을 덮어쓴다
            if (id === String(t0Ref.current)) msRef.current.inject = inject
            const next = historyRef.current.map((h) => (h.id === id ? { ...h, milestones: { ...h.milestones, inject } } : h))
            void persistHistory(next)
            setHistory(next)
          }}
          onSetNotes={(id, notes, override) => {
            // 진행 중인 회차를 다시 저장해도 지워지지 않는다 — commitHistory 가 저장본의 notes · override 를 이어 받는다
            const next = historyRef.current.map((h) => (h.id === id ? { ...h, notes: notes.length ? notes : undefined, override } : h))
            void persistHistory(next)
            setHistory(next)
          }}
        />
      )}
      {evOpen && (
        <EvidenceView
          id={evOpen.id}
          initialKey={evOpen.key}
          // 묶음 · 경과를 재려면 그 회차의 마일스톤이 필요하다 — 진행 중이면 지금 것, 아니면 이력
          run={
            running && evOpen.id === String(t0Ref.current)
              ? { id: evOpen.id, t0: t0Ref.current, closedAt: Date.now(), node: msRef.current.down?.node ?? '', milestones: msRef.current }
              : history.find((h) => h.id === evOpen.id) ?? null
          }
          onClose={() => setEvOpen(null)}
        />
      )}
      {closeAsk && (
        <ConfirmDialog
          title="검증 중입니다"
          message={
            '창을 닫으면 이 회차 검증이 끝납니다(지금까지의 기록은 이력에 남습니다).\n' +
            '· 검증 종료하고 닫기: 폴링을 멈추고 이 회차를 확정합니다\n' +
            '· 최소화: 검증은 계속 돌고, 툴바 옆 칩으로 줄여 둡니다'
          }
          confirmLabel="검증 종료하고 닫기"
          onConfirm={() => {
            setCloseAsk(false)
            onClose()
          }}
          secondaryLabel="최소화 (검증 계속)"
          onSecondary={() => {
            setCloseAsk(false)
            minimize()
          }}
          onCancel={() => setCloseAsk(false)}
        />
      )}
      {askDrop && (
        <ConfirmDialog
          title={askDrop.all ? '검증 이력을 모두 지울까요?' : '이 회차를 지울까요?'}
          message={
            (askDrop.all
              ? `회차 ${askDrop.ids.length}개를 지웁니다.`
              : `${(() => {
                  const h = history.find((x) => x.id === askDrop.ids[0])
                  return h ? `${h.label || h.node} (${fmtDateTime(h.t0)})` : '회차'
                })()} 를 지웁니다.`) +
            `

타임라인과 저장된 증적(서버 원문) ${askDrop.ids.reduce((n, id) => n + (evIndex[id]?.length ?? 0), 0)}건도 함께 지워지며 되살릴 수 없습니다.`
          }
          onCancel={() => setAskDrop(null)}
          onConfirm={() => {
            const drop = new Set(askDrop.ids)
            const next = historyRef.current.filter((h) => !drop.has(h.id))
            const ids = askDrop.ids
            void persistHistory(next).then((ok) => {
              if (ok) dropEvidence(ids)
            })
            setHistory(next)
            setAskDrop(null)
          }}
        />
      )}
    </div>
    </>
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
 * 회차의 복구 시간 — **장애 시작부터** 잰다.
 * 처음엔 '검증 시작' 부터 쟀는데, 시작을 누르고 몇 분 뒤에 노드를 죽이면 그 몇 분이 복구 시간에 섞였다 → DOWN 감지부터(사용자 요청).
 * 10-30 사용자 결정으로 셋을 다시 정했다(10-28 1세트 1회차 리포트를 보고):
 *  - 기준(base): **장애 주입 시각**(수동 입력 · IPMI 이벤트 로그 · 버튼)이 있으면 그것, 없으면 DOWN 감지. IPMI 로 끄면 Q-Term 은 3~5초 뒤에
 *    DOWN 을 보므로 주입이 실제 중단 시각에 더 가깝다. 주입이 DOWN 감지보다 늦게 찍혔으면(잘못 누른 것) DOWN 감지를 쓴다.
 *    DOWN 과의 차이에 상한은 두지 않는다(사용자 결정 10-30: 수동 입력은 IPMI 이벤트 로그를 보고 KST 로 맞춰 넣는다 — BMC 가 UTC 면 사람이 +9 해서).
 *    **DOWN 을 못 잡은 회차는 주입이 있어도 쓰지 않는다**(같은 결정: 주입만 있고 DOWN 이 없으면 시험 삼아 넣어 둔 것일 수 있다 — 노드가 실제로
 *    내려가야 DOWN 이 뜬다). 그 회차는 예전처럼 검증 시작 기준 · * 표시 · 평균에서 뺀다.
 *    리포트에서 '장애 주입 시각' 항목을 빼면 주입을 쓰지 않고 DOWN 감지부터 잰다(useInject) — 빼 놓고 주입 기준으로 재면 0점이 보이지 않는다.
 *    예전엔 DOWN 감지 기준에 '장애 주입' · '주입부터 포털 정상화 · 전체 복구' 칸을 따로 붙였는데, 같은 일을 두 기준으로 적어 헷갈렸다.
 *  - 포털 서비스 정상화(svc): DOWN 뒤 **처음으로 모든 화면이 동시에 정상**(1차 정상화, lib/portalPhases firstAll). 10-28 에는 흔들림이
 *    끝난 최종 정상화를 이 값으로 썼지만, 사용자가 보는 것은 '서비스를 다시 쓸 수 있게 된 때' 다. 최종(svcFinal)은 참고로 남긴다.
 *    1차 뒤 다시 끊겨 끝내 안 돌아온 화면이 있으면(svcPending) 시간은 1차로 적되 판정은 미복구다(사용자 결정 A).
 *  - 전체 복구(all): Masakari 완료와 포털 1차 정상화 중 **늦은 쪽**. 예전엔 노드가 다시 올라온 뒤 Ceph HEALTH_OK 까지였는데, 그건
 *    사람이 노드를 언제 올리느냐에 따라 바뀌는 값이라 장애 대응 시간이 아니다. Ceph · 파드 · 노드 복귀는 참고로 리포트에 남는다.
 *    감시하지 않은 쪽은 빼고 본다. 감시한 것 중 하나라도 안 끝났으면(Masakari 실패 · 포털 미복구) all 은 없다(allFail).
 *    Masakari 는 **VM 이 모두 옮겨져야 완료**다(사용자 결정 10-30) — 한 대라도 못 옮겼으면(vms.failed) 실패라 전체 복구도 미복구다.
 * DOWN 을 못 잡은 회차(검증 전부터 죽어 있었거나 기록 없음)는 검증 시작을 기준으로 하고 그 사실을 표시한다.
 */
// DOWN · VIP 기준 시각(서버 기록 우선)은 src/lib/serverTime.ts — 실제 17:53 회차 시각으로 검사한다
const downBaseOf = (ms: Milestones, t0?: number) => downBaseLib(ms.down, t0)
const vipAtOf = (ms: Milestones) => vipAtLib(ms.vip as NonNullable<Milestones['vip']>, ms.down)

interface RunTotals {
  /** 기준 시각 — 장애 주입(있으면) · DOWN 감지 · 검증 시작 순 */
  base: number
  fromDown: boolean
  /** 기준이 장애 주입 시각인가 */
  fromInject: boolean
  /** DOWN 감지 시각(서버 기록 우선) — 장애 주입이 기준일 때 '+2초' 로 같이 보여 준다 */
  downAt: number | null
  /** 포털 1차 정상화까지(기준부터) */
  svc: number | null
  /** 포털 최종 정상화까지(참고) — 1차와 같으면 흔들림이 없었던 것 */
  svcFinal: number | null
  svcPending: string[]
  /** 전체 복구까지 — Masakari 완료 · 포털 1차 중 늦은 쪽. 감시한 것이 모두 끝나야 값이 있다 */
  all: number | null
  /** 감시한 것 중 끝나지 않은 것이 있다(Masakari 실패 · 포털 미복구) */
  allFail: boolean
  /** 전체 복구를 정한 쪽 */
  allBy: 'masakari' | 'portal' | null
}

/** 이 회차가 Masakari 를 감시했는가 — 감시 기록이 없던 옛 회차는 결과가 있으면 감시한 것으로 본다 */
const masaWatchedOf = (ms: Milestones) => (ms.watched ? ms.watched.masakari : !!ms.masakari || (ms.masakariFail ?? []).length > 0)
/** Masakari 가 VM 을 **모두** 옮겼다(사용자 결정 10-30: 한 대라도 못 옮기면 실패) */
const masaDoneOf = (ms: Milestones) => !!ms.masakari && !masaPartOf(ms)
/** 완료 기록은 있지만 못 옮긴 VM(실패 · 끝까지 안 끝남)이 있다 — 'VM N대 중 n대 실패' */
const masaPartOf = (ms: Milestones) => !!ms.masakari && (ms.masakari.vms?.failed ?? 0) + (ms.masakari.vms?.pending ?? 0) > 0
/** Nova 기록을 못 읽어 VM 이 다 옮겨졌는지 모른다 — 완료로 두되 평균에서는 뺀다 */
const masaUncheckedOf = (ms: Milestones) => !!ms.masakari?.vmUnchecked
/** Masakari 실패(확정 실패 또는 못 옮긴 VM) */
const masaFailOf = (ms: Milestones) => masaFailedRun(ms) || masaPartOf(ms)
const masaFailText = (ms: Milestones) =>
  masaPartOf(ms)
    ? `VM ${ms.masakari?.vms?.count ?? ms.masakari?.evac}대 중 ${(ms.masakari?.vms?.failed ?? 0) + (ms.masakari?.vms?.pending ?? 0)}대 실패${ms.masakari?.vms?.pending ? `(${ms.masakari.vms.pending}대는 끝까지 완료 안 됨)` : ''}`
    : masaFailedVms(ms)
      ? `VM ${masaFailedVms(ms)}대 못 옮김`
      : 'status: failed'

function runTotals(h: HistoryRecord, useInject = true): RunTotals {
  const ms = h.milestones
  const fromDown = !!ms.down && ms.down.source !== 'pre'
  const downAt = fromDown ? (downBaseOf(ms, h.t0) as { at: number }).at : null
  const fromInject = useInject && downAt != null && !!ms.inject && ms.inject.at <= downAt
  const base = fromInject ? (ms.inject as { at: number }).at : (downAt ?? h.t0)
  const svcPending = ms.portalPending ?? []
  const ph = portalPhases({ portal: ms.portal ?? [], portalFlaps: ms.portalFlaps, portalPending: svcPending, portalLog: ms.portalLog, portalWatched: ms.portalWatched })
  const portalHad = ph.pages > 0
  const masaWatched = masaWatchedOf(ms)
  const allFail = (masaWatched && !masaDoneOf(ms)) || svcPending.length > 0 || (portalHad && ph.firstAll == null)
  const ends: { at: number; by: 'masakari' | 'portal' }[] = []
  if (masaWatched && ms.masakari && masaDoneOf(ms)) ends.push({ at: ms.masakari.at, by: 'masakari' })
  if (portalHad && ph.firstAll != null) ends.push({ at: ph.firstAll, by: 'portal' })
  const last = ends.length ? ends.reduce((a, b) => (b.at >= a.at ? b : a)) : null
  return {
    base,
    fromDown,
    fromInject,
    downAt,
    svc: ph.firstAll == null ? null : ph.firstAll - base,
    // 최종은 끝내 다 돌아온 회차에만(미복구가 남았으면 finalAll 이 없다) — 예전엔 돌아온 화면만으로 '최종' 을 찍었다(코드 점검 10-30)
    svcFinal: ph.finalAll == null ? null : ph.finalAll - base,
    svcPending,
    all: allFail || !last ? null : last.at - base,
    allFail,
    allBy: allFail || !last ? null : last.by,
  }
}

/** 노드 복귀 시각 — 타임라인 요약의 '노드 복귀' 줄과 같은 셈(재연결 · 클러스터 재합류 · OSD up · k8s Ready 중 가장 이른 것) */
function nodeBackAt(m: Milestones): number | null {
  const xs = [m.reconnect?.at, ...(m.rejoin ?? []).map((r) => r.at), m.osdUp?.at, ...(m.k8sReady ?? []).map((r) => r.at)].filter((v): v is number => v != null)
  return xs.length ? Math.min(...xs) : null
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
  const broken = lastPodsBroken(ms)
  const started = new Set([...(ms.pods ?? []).map((p) => p.ns), ...broken.keys()])
  let pending = 0
  /**
   * 완료 뒤 **다시 비정상** 이 된 네임스페이스는 그 뒤 완료가 또 오기 전까지 미완이다. 예전에는 완료가 한 번이라도 있으면
   * 끝으로 셌다 — 2026-10-26 boot-factory 가 15:53 완료 뒤 epoxy-manager2 NotReady 로 Running 0 · Pending 인데도 리포트에
   * '파드 복구 완료 +05:18' 이 나갈 뻔했다.
   */
  for (const ns of started) if (!done.has(ns) || (broken.get(ns) ?? 0) > (done.get(ns) ?? 0)) pending++
  return { at: done.size ? Math.max(...done.values()) : null, pending }
}
/**
 * 네임스페이스 하나의 마지막 완료 · 마지막 다시 비정상 시각 — 카드 배지(nsPhase) · 타임라인 칩(timelineStatus) · 리포트(podsDoneSummary)가
 * 같은 규칙을 쓰게(코드 점검: 세 군데가 따로 계산했다). broken > done 이면 미완.
 */
function nsPodTimes(ms: Pick<Milestones, 'podsDone' | 'podsBroken'>, ns: string): { done: number; broken: number } {
  return {
    done: Math.max(0, ...(ms.podsDone ?? []).filter((d) => d.ns === ns).map((d) => d.at)),
    broken: Math.max(0, ...(ms.podsBroken ?? []).filter((d) => d.ns === ns).map((d) => d.at)),
  }
}
/** 네임스페이스별 마지막 '다시 비정상' 시각 */
function lastPodsBroken(ms: Milestones): Map<string, number> {
  const m = new Map<string, number>()
  for (const b of ms.podsBroken ?? []) m.set(b.ns, Math.max(m.get(b.ns) ?? 0, b.at))
  return m
}
/** masakari 가 evacuation 을 실패로 **확정**(failed)했고 완료는 없던 회차 */
const masaFailedRun = (ms: Milestones) => !ms.masakari && (ms.masakariFail ?? []).some((f) => f.status === 'failed')
/**
 * 그 회차에서 옮기지 못한 VM 수 — 마지막 실패 기록의 목록 개수(사용자 요청 '마사카리 실패 N대'). 실패 확정(failed) 줄에는 목록이
 * 없고 바로 앞 error 시도 줄에 있으므로, 값이 있는 마지막 기록을 쓴다.
 */
const masaFailedVms = (ms: Milestones): number | undefined =>
  [...(ms.masakariFail ?? [])].sort((a, b) => a.at - b.at).filter((f) => f.failedVms).pop()?.failedVms

const he = (v: unknown) =>
  String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * 목표 복구 시간(합격 기준) — 기본 **Off**. 합격 기준이 정해지지 않은 검증이 많아 평소엔 평균만 보고, 기준이 명확해지면
 * On 으로 두고 회차별 합격·불합격을 판정한다(사용자 결정). 값은 장애 시작(runTotals.base)부터의 초, 비워 둔 항목은 판정하지 않는다.
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
  { key: 'svc', label: '포털 1차 정상화' },
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
 * 리포트에 넣을 항목(사용자 요청 — 보고받는 사람은 파드·Ceph 에 관심이 없다). 여러 회차를 골라도 **모든 회차에 같은 선택**을
 * 쓴다 — 회차마다 칸이 다르면 비교표로 비교할 수 없다. 예전엔 뺀 항목을 머리에 '제외한 항목' 으로 밝혔으나 2026-11-10 사용자 요청으로 뺐다(보고용 묶음이 기본이라 늘 붙었다).
 */
interface ReportItems {
  hostVip: boolean
  masakari: boolean
  portal: boolean
  pods: boolean
  ceph: boolean
  node: boolean
  /**
   * 파드 로그 이상(새 오류 묶음) — 파드 복구와 따로 고른다(2026-11-10 사용자 요청: 회차마다 100건이 넘어 증적 원문이 너무 길어졌다).
   * 기본은 뺀다(보고용 · 창을 열 때마다). 기술 검토용은 넣는다. 증적 원문의 'podlog:' 증적과 회차별 결과의 파드 로그 이상 표가 이 항목을 따른다.
   */
  podLogs: boolean
  inject: boolean
  evidence: boolean
}
const REPORT_ITEM_LABELS: { key: keyof ReportItems; label: string }[] = [
  { key: 'hostVip', label: '호스트 DOWN · VIP 이동' },
  { key: 'masakari', label: 'Masakari evacuation' },
  { key: 'portal', label: '포털 정상화' },
  { key: 'pods', label: '파드 복구' },
  { key: 'ceph', label: 'Ceph 복구' },
  { key: 'node', label: '노드 복귀 (재연결 · 재합류 · OSD · k8s Ready)' },
  { key: 'podLogs', label: '파드 로그 이상 (회차마다 많아 증적이 길어집니다)' },
  { key: 'inject', label: '장애 주입 시각 (빼면 DOWN 감지부터 잼)' },
  { key: 'evidence', label: '증적(서버 원문) 포함' },
]
const REPORT_ALL: ReportItems = { hostVip: true, masakari: true, portal: true, pods: true, ceph: true, node: true, podLogs: true, inject: true, evidence: true }
/** 보고용 — 서비스가 언제 돌아왔나만(사용자가 정한 묶음) */
const REPORT_BRIEF: ReportItems = { hostVip: true, masakari: true, portal: true, pods: false, ceph: false, node: false, podLogs: false, inject: true, evidence: false }
/** 증적 key 에 넣는 짧은 해시(로그 묶음 key 는 문장이 들어 있어 길다) */
function keyHash(s: string): string {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}
/*
 * 넣을 항목은 창을 열 때마다 보고용 묶음(호스트 DOWN · VIP · Masakari · 포털 · 장애 주입)에서 시작한다(2026-11-10 사용자 요청: 대부분 이
 * 묶음으로 뽑는다). 예전엔 마지막에 고른 것을 기억해(report_items_v1) 기술 검토용을 한 번 뽑으면 다음에도 파드 · Ceph · 노드 복귀가
 * 켜진 채 열렸다. 파드 · Ceph · 노드 복귀가 필요하면 그때 켜거나 [기술 검토용] 을 누른다. 종류(종합 · 회차별 · 증적)는 지금처럼 기억한다.
 */
function loadReportItems(): ReportItems {
  return { ...REPORT_BRIEF }
}
/**
 * 증적 머리 이름표 — 앱 증적 창 · HTML 리포트 · Markdown 내보내기 세 곳이 같은 말을 쓰게 한 곳에 둔다(예전엔 따로 적혀 있었다).
 * '읽은 서버 · 떠 온 시각' 이 어색하다는 지적(10-27)으로 바꿨다. 조회 시각은 로그를 가져온 시각이지 사건 시각이 아니다 —
 * 'Masakari 완료 14:59:09' 증적의 조회 시각 14:59:32 가 완료 시각으로 읽히지 않게 그 사실을 옆에 적는다.
 */
/**
 * 증적 사실 표의 문구 — 포털 '다시 끊김' 줄 끝의 '(12:49:26 정상화 뒤)' 는 뺀다(2026-11-07 사용자 결정). 바로 위 줄들과 화면별 표에
 * 정상화 시각이 이미 있어 같은 시각이 줄마다 되풀이됐다. 이미 저장된 회차의 증적에도 남아 있으므로 그릴 때 걷어 낸다.
 */
const factLabel = (l: string) => l.replace(/^(다시 끊김: .+?) \(\d{1,2}:\d{2}:\d{2} 정상화 뒤\)$/, '$1')
const EV_LABEL = {
  host: '조회한 서버',
  at: '조회 시각',
  atHint: '사건 시각은 아래 표',
  cmd: '조회 명령',
  verify: '재확인 명령',
  verifyHint: '서버에서 직접 실행',
} as const
/**
 * 증적의 '조회 명령' 칸 — 포털은 명령이 아니라 판정 기준을 한 줄로(2026-11-10 사용자 요청: 감시 방식 설명이 길고 '조회 명령' 이라는 이름과도
 * 맞지 않았다). 연속 횟수는 저장된 문구('연속 10회 정상')에서 읽는다 — 회차마다 설정이 다를 수 있다.
 */
const evCmdOf = (it: { key: string; command: string }): { label: string; text: string; code: boolean } => {
  if (it.key !== 'portal') return { label: EV_LABEL.cmd, text: it.command, code: true }
  const n = it.command.match(/연속 (\d+)회 정상/)?.[1] ?? 'N'
  return { label: '판정 기준', text: `각 화면의 핵심 API 가 ${n}회 연속 200 OK 이면 정상`, code: false }
}
/** 타임라인 줄이 어느 항목인가 — 리포트에서 뺀 항목의 줄은 넣지 않는다 */
function rowItem(r: TimelineItem): keyof ReportItems | null {
  const t = r.target ?? ''
  if (t === 'host' || t === 'vip' || t === 'roles') return 'hostVip'
  if (t === 'masakari') return 'masakari'
  // 포털 정상화 묶음의 하위 줄도 포털 항목이다(포털을 뺀 리포트에서는 같이 빠져야 한다)
  if (t === 'portal' || t === 'portal-child') return 'portal'
  if (t === 'pods' || t.startsWith('pods:') || t === 'k8s' || t === 'podlog') return 'pods'
  if (t === 'ceph') return 'ceph'
  if (t === 'node') return 'node'
  if (t === 'inject') return 'inject'
  return null
}
/** 증적이 어느 항목인가 */
/**
 * 리포트(증적 원문 포함)에 넣을 증적인가 — buildHtmlReport 와 makeRunsReport(만들 파일 고르기)가 같은 판단을 하게 한 곳에(코드 리뷰 11-10:
 * 파일 고르기는 거르기 전 개수로 해서, 고른 항목에 맞는 증적이 하나도 없는 회차에 '저장된 증적이 없습니다' 파일이 생겼다).
 * 검증 전 분산 점검('spread')은 늘 넣고, 검증 중에 누른 점검('spread:<시각>')은 넣지 않는다(buildHtmlReport 주석).
 */
function evKeep(key: string, inc: ReportItems): boolean {
  if (key === 'spread') return true
  if (key.startsWith('spread:')) return false
  const k = evItem(key)
  return k == null || inc[k]
}
function evItem(key: string): keyof ReportItems | null {
  if (key === 'portal') return 'portal'
  if (key === 'down' || key === 'vip' || key.startsWith('roles')) return 'hostVip'
  if (key === 'masakari' || key.startsWith('masakariFail')) return 'masakari'
  if (key.startsWith('podlog')) return 'podLogs'
  if (key.startsWith('pods') || key.startsWith('spread')) return 'pods'
  if (key.startsWith('ceph')) return 'ceph'
  if (key === 'reconnect') return 'node'
  return null
}

/**
 * 여러 회차를 묶은 제출용 HTML 리포트 — 인터넷 없이 열리는 한 파일(CSS 내장, 스크립트는 펼치기·이동 보조뿐이라
 * 꺼져 있어도 내용은 다 보인다).
 *
 * 구성: 머리(기간 · 회차 수) → 주요 수치 → ① 회차 비교표 → ② 복구 흐름(VIP · Masakari · 포털 1차 정상화 점) → ③ 회차별 상세
 * (접힘, 표에서 이름을 누르면 이동) → 참고사항. 예전 '핵심 요약'(자동 문장)은 10-30 에 뺐다(그 자리 주석).
 * 복구 시간은 모두 **장애 시작부터**다(runTotals). 20회차를 쭉 펼치면 스크롤이 끝없이 길어져(사용자 지적)
 * 상세는 회차마다 접고, 접힌 머리에 핵심 숫자를 띄웠다. PDF 는 접힌 내용이 인쇄되지 않으므로 전부 펼쳐 뽑는다.
 * 증적 원문은 저장할 때 이미 마스킹 설정을 거쳤다.
 */
/**
 * 회차의 증적을 목차 · 본문 순서로 정리한다 — 리포트와 툴 증적 창이 같은 묶음 · 순서를 쓰게(2026-11-07, evidenceToc.ts).
 * 같은 순간의 Ceph 데이터 복구 · HEALTH_OK 는 증적 하나로(타임라인 요약과 같은 기준). 사건 시각은 그 증적을 가리키는 타임라인 줄의 시각,
 * 포털은 최초 끊김(포털 이야기가 시작된 때), 그런 줄이 없으면(분산 점검 · 파드 로그) 떠 온 시각이다.
 */
/**
 * withUp=false: 노드 복귀를 리포트에서 뺐으면 '노드 UP 이후' 로 가르지 않는다(2026-11-10 사용자 요청: 포털까지만 뽑았는데 포털 다시 끊김
 * 하나 때문에 '노드 UP 이후' 묶음이 섰다). 툴 증적 창은 늘 가른다.
 */
function runEvidenceLayout(items0: BoardEvidenceItem[], msIn: Milestones, t0: number, base: number, withUp = true) {
  // 분산 점검 증적의 옛 '필수 분산' 문장은 새 문장으로 바꿔 보인다(spreadMeaning 주석) — 원문 파일은 그대로
  const items = items0.map((it) => (it.key.startsWith('spread') ? { ...it, text: spreadTextNow(it.text), note: it.note?.split(SPREAD_NOTE_OLD).join(SPREAD_NOTE_NEW) } : it))
  const ms: Milestones = { ...msIn, pods: msIn.pods ?? [], portal: msIn.portal ?? [] }
  const evItems = mergeSameCeph(items, ms.ceph?.at ?? null, ms.cephHealthy?.at ?? null, SAME_EVENT_MS)
  const evKeys = new Set(evItems.map((x) => x.key))
  const evRowAt = new Map<string, number>()
  for (const r of buildTimelineRows(ms, t0, 'full')) {
    const k = r.ev ? resolveEvKey(r.ev, evKeys) : null
    if (k && (!evRowAt.has(k) || r.at < (evRowAt.get(k) as number))) evRowAt.set(k, r.at)
  }
  const upAt = withUp ? nodeBackAt(ms) : null
  const portalV = new Map<string, PortalEvView>()
  // 미복구 · 최종 정상화 · 화면별은 이력으로 바로잡는다(applyRunTruth 주석 — 옛 버전이 미복구 목록보다 먼저 저장한 증적)
  const ph = portalPhases(ms)
  const truth = {
    pending: ms.portalPending ?? [],
    firstAll: ph.firstAll,
    finalAll: ph.finalAll,
    pages: ms.portalLog?.length ? { title: '', ...portalPageRows(ms, ms.portalLog) } : undefined,
    // 1차 · 최종 정상화 근거를 화면별로 다시 만들 판정 기록(정상화마다 연속 구간 원본)
    log: ms.portalLog,
    // 다시 끊김도 이력(판정 기록으로 맞춘 것)으로 — 판정 기록이 없는 옛 회차는 증적 문구 그대로
    flaps: ms.portalLog?.length ? (ms.portalFlaps ?? []) : undefined,
  }
  for (const it of evItems) if (it.key === 'portal') portalV.set(it.key, applyRunTruth(portalEvidenceView(it), truth))
  const evArr: ArrangedEv[] = arrangeEvidence(
    evItems,
    (it) => (it.key === 'portal' ? portalStartAt(portalV.get(it.key) as PortalEvView) : evRowAt.get(it.key) ?? null),
    base,
    upAt,
  )
  return { evItems, evKeys, evArr, upAt, portalV, masaDone: masaDoneOf(ms) }
}

/** 다시 끊김 카드의 작은 글씨 — 화면 몇 건 · 첫 ~ 마지막 시각(같은 순간 끊긴 화면은 횟수로는 한 번이라 건수를 따로 적는다) */
function flapSmall(v: PortalEvView): string {
  const after = v.flaps.filter((f) => !v.firstAll || f.at > v.firstAll.at)
  if (!after.length) return '없음'
  return `화면 ${v.flapRows}건 · ${fmtClock(after[0].at)}${after.length > 1 ? ` ~ ${fmtClock(after[after.length - 1].at)}` : ''}`
}

/** 포털 증적 안의 자리(목차가 가리킬 곳) — 연속 통과 기록 표가 있으면 그 표, 없으면(옛 회차) 일어난 순서의 그 줄 */
function portalPartId(v: PortalEvView, a: string, part: '' | 'firstAll' | 'flap' | 'final'): string {
  if (part === 'firstAll') return hasFirstBasis(v) ? `${a}-s1` : `${a}-f1`
  if (part === 'final') return hasFinalBasis(v) ? `${a}-s2` : `${a}-f2`
  if (part === 'flap') return v.pages ? `${a}-pages` : a
  return a
}

/**
 * 포털 API 응답 조치 전 · 후 비교에 넣을 회차(2026-11-25 사용자 결정, lib/portalLatency latencyCompare 주석). 리포트 만들기 창에서 묶음마다
 * 차수를 고르면 그 차수의 회차가 들어오고, 회차를 직접 넣고 뺀다(오래 걸린 회차만 고르는 식). label 은 차수 이름(직접 골랐으면 빈칸).
 * 회차는 리포트에 담는 회차(고른 회차) 안에서만 고른다 — 리포트에 없는 회차가 비교에만 나오면 표의 #번호를 따라갈 수 없다.
 */
interface LatCmpPick {
  pre: { label: string; ids: string[] }
  post: { label: string; ids: string[] }
}

function buildHtmlReport(
  recs: HistoryRecord[],
  evidence: Record<string, BoardEvidenceItem[]>,
  opts: {
    openEvidence: boolean
    rto?: RtoTargets
    items?: ReportItems
    /**
     * 무엇을 만드나(10-29 사용자 결정 · 이름 확정). 예전엔 한 파일에 요약 · 비교표 · 회차별 상세 · 증적을 다 넣어 14회차면 보고받는 사람이
     * 증적 수천 줄을 스크롤해야 했고, 증적 하나를 건네려면 전부를 건네야 했다.
     *  - total(종합 결과): 주요 수치 · ① 회차 비교 · ② 복구 흐름. 회차 상세 · 증적 없음
     *  - runs(회차별 결과): 회차마다 핵심 시간 · 타임라인 · 파드 로그 이상. 증적 없음
     *  - evidence(증적 원문): 회차 하나(회차마다 한 파일) — 머리 카드 · 타임라인 · 증적
     *  - all: 예전 한 파일(지금은 부르는 곳이 없지만 꼴을 지키려고 남긴다)
     */
    kind?: 'total' | 'runs' | 'evidence' | 'all' | 'latency'
    /** 같이 뽑는 '포털 API 응답 시간' 파일 — 종합 결과의 느려진 API 표에서 회차별 전체 표로 간다 */
    latFile?: string
    /** 종합 결과 제목 — 종합 · 중간 결과 보고(REPORT_TITLE 주석) */
    reportTitle?: ReportTitle
    /** 종합 결과에서 회차 이름을 누르면 갈 회차별 결과 파일 이름(같은 폴더). 없으면 링크를 걸지 않는다 */
    runsFile?: string
    /**
     * 파일 사이 이동(2026-11-10 사용자 요청) — 같이 뽑아 같은 폴더에 둔 파일만 건다(HTML 일 때만, PDF 는 파일 사이 링크가 안 된다).
     *  - evFiles: 회차 id → 그 회차 증적 원문 파일. 종합 결과 비교표 끝 '증적' 칸 · 회차별 결과 회차 머리에서 간다
     *  - totalFile: 종합 결과 파일 — 회차별 결과 · 증적 원문 머리의 [← 종합 결과] 로 돌아간다
     */
    evFiles?: Record<string, string>
    totalFile?: string
    /**
     * 검증 그룹(VerifyGroup 주석) — 고른 회차가 모두 한 그룹이면 들어온다. 종합 결과 맨 앞에 ① 검증 환경 · ② 시나리오 흐름 · ③ 차수별 요약을
     * 싣고, 회차는 차수 순서 → 시작 시각 순으로 센다(회차별 결과 파일도 같은 순서라야 #번호 링크가 맞는다)
     */
    group?: VerifyGroup
    /** 검증 환경의 VM 을 실제 이름으로(기본은 표준 이름 — 리포트 만들기 창에서 매번 고른다) */
    realNames?: boolean
    /** 같이 뽑는 환경 구성도 파일 — ① 검증 환경 머리에 '상세 환경 구성도 →' 를 단다(2026-11-14) */
    envFile?: string
    /** 포털 API 응답 조치 전 · 후 비교(LatCmpPick 주석) — 리포트 만들기 창에서 고른 두 묶음 */
    latCmp?: LatCmpPick
  },
): string {
  const kind = opts.kind ?? 'all'
  // 증적은 '증적 원문' 에만 — 종합 · 회차별에서는 항목 체크와 상관없이 뺀다(그래서 '제외한 항목' 에도 적지 않는다)
  const inc: ReportItems = { ...(opts.items ?? REPORT_ALL), ...(kind === 'all' ? {} : { evidence: kind === 'evidence' }) }
  const keepRow = (r: TimelineItem) => {
    const k = rowItem(r)
    return k == null || inc[k]
  }
  const excluded = REPORT_ITEM_LABELS.filter((x) => !inc[x.key] && (kind === 'all' || x.key !== 'evidence')).map((x) => x.label)
  /**
   * 회차로 가는 링크. 같은 파일 안이면 #run-n(+ 펼치기), 종합 결과면 옆 회차별 결과 파일의 #run-n. 회차별 결과를 같이 뽑지 않았으면
   * 링크를 걸지 않는다 — 없는 파일로 가는 링크는 눌러도 아무 일이 없어 고장으로 보인다.
   */
  const evFileOf = (h: HistoryRecord) => opts.evFiles?.[h.id]
  const evCol = kind === 'total' && !!opts.evFiles && Object.keys(opts.evFiles).length > 0
  const fileHref = (f: string) => he(encodeURIComponent(f))
  const hrefRun = (i: number) =>
    kind === 'total' ? (opts.runsFile ? `href="${he(encodeURIComponent(opts.runsFile))}#run-${i + 1}"` : '') : `href="#run-${i + 1}" data-open="run-${i + 1}"`
  const DOC_TITLE = { total: REPORT_TITLE[opts.reportTitle ?? 'final'], runs: '가용성 검증 회차별 결과', evidence: '가용성 검증 증적 원문', all: '가용성 검증 결과', latency: '포털 API 응답 시간' }[kind]
  const grp = opts.group
  const phIdx = (h: HistoryRecord) => {
    const k = grp ? grp.phases.findIndex((ph) => ph.id === h.phaseId) : -1
    return k < 0 ? 1e9 : k
  }
  const runs = [...recs].sort((a, b) => (grp ? phIdx(a) - phIdx(b) : 0) || a.t0 - b.t0)
  /** 증적 표 하나 — 제목이 비면 머리 없이. 칸에 마우스를 올리면 cellTitles(HTTP · 응답 시간 · 사유) */
  const tblHtml = (tb: BoardEvidenceTable, id = ''): string =>
    `${tb.title ? `<h3 style="font-size:12.5px"${id ? ` id="${id}"` : ''}>${he(tb.title)}</h3>` : ''}<div style="overflow:auto"${!tb.title && id ? ` id="${id}"` : ''}><table class="grid"><thead><tr>${tb.columns
      .map((c) => `<th class="c">${he(c)}</th>`)
      .join('')}</tr></thead><tbody>${tb.rows
      .map(
        (r, ri) =>
          `<tr${tb.bad?.[ri] ? ' class="badrow"' : ''}>${r
            .map((c, k) => {
              const tt = tb.cellTitles?.[ri]?.[k]
              const cls = c.startsWith('✓') ? ' pass' : c.startsWith('✗') ? ' fail' : ''
              return `<td class="num${k ? ' c' : ''}${cls}"${tt ? ` title="${he(tt)}"` : ''}>${he(c)}</td>`
            })
            .join('')}</tr>`,
      )
      .join('')}</tbody></table></div>`
  const msOf = (h: HistoryRecord): Milestones => ({ ...h.milestones, pods: h.milestones.pods ?? [], portal: h.milestones.portal ?? [] })
  const tot = runs.map((h) => runTotals(h, inc.inject))
  const nameOfRun = (h: HistoryRecord, i: number) => h.label || `${i + 1}회차 · ${h.node}`
  /** 회차 하나만 뽑은 리포트 — 번호 · 평균 · '회차 비교' 같은 여러 회차용 꼴을 쓰지 않는다 */
  const one = runs.length === 1
  /**
   * 열 — 값은 그 회차의 장애 시작(runTotals.base)부터의 경과. 두 묶음이다(10-30 사용자 결정, 표를 보고 다시 정함):
   *  - step(단계별 복구): VIP 이동 · Masakari 완료 · 파드 복구 · 포털 1차 정상화 · Ceph 복구
   *  - total(총 소요): 전체 복구(Masakari 완료 · 포털 1차 정상화 중 늦은 쪽) 하나
   * 처음엔 총 소요에 '포털 서비스 정상화' 를 따로 두고 포털 최종 · 파드 · Ceph 를 '참고' 묶음으로 뺐는데, 포털 서비스 정상화가 곧 1차
   * 정상화라 같은 값이 두 이름으로 나왔고 표가 화면 폭을 넘었다. 포털 최종 정상화는 회차 상세의 '참고' 줄에만 둔다.
   * 묶음 머리를 칸 수로 그리므로 배열은 묶음 순서대로 둔다.
   */
  type Col = {
    key: string
    label: string
    grp: 'step' | 'total'
    at: (h: HistoryRecord, ms: Milestones, i: number) => number | null
    note?: (ms: Milestones) => string
    /** 값은 있지만 끝난 값이 아니다(평균 · 최대 · 빠름/느림에서 뺀다) */
    partial?: (ms: Milestones) => boolean
  }
  /**
   * 하나라도 끝나지 않았으면 미복구 — 단, **감시하지 않은 것은 빼고** 본다(코드 점검: 포털이 한 번도 안 끊긴 회차 · Masakari 세션을
   * 지정하지 않은 회차가 '미복구' 로 찍혔다). 포털은 끊겼다가 안 돌아온 대상(portalPending)만 실패다 — 안 끊겼으면 기록이 없는 게 정상.
   * 리포트에서 뺀 항목(Masakari · 포털)은 전체 복구에서도 빼고 본다 — 그래서 runTotals.all 을 그대로 쓰지 않고 여기서 다시 잰다.
   */
  /*
   * 리포트에서 쓰는 결과 변경 — 바꾼 단계가 **지금도 실패이고 리포트에 넣은 항목**일 때만 켠다(코드 리뷰 11-17). overrideOf 만 보면
   * 나중에 기록이 고쳐져 실패가 아니게 된 단계 · 리포트에서 뺀 항목을 바꾼 회차까지 전체 복구가 '-' 가 되고 평균에서 빠졌다
   */
  const ovM = (h: HistoryRecord) => inc.masakari && ovStep(h, 'masakari') && masaWatchedOf(h.milestones) && !masaDoneOf(h.milestones)
  const ovP = (h: HistoryRecord) => inc.portal && ovStep(h, 'portal') && (h.milestones.portalPending ?? []).length > 0
  const ovIn = (h: HistoryRecord) => ovM(h) || ovP(h)
  const svcFail = runs.map((h) => {
    const ms = h.milestones
    // 사람이 '이 조치가 없었으면 복구되지 않았음' 을 켠 회차도 실패(RunNote 주석, 2026-11-11 사용자 결정)
    // 사람이 성공으로 바꾼 단계는 실패로 세지 않는다 — 바꾸지 않은 단계의 실패는 그대로(RunOverride 주석)
    return (
      (inc.masakari && masaWatchedOf(ms) && !masaDoneOf(ms) && !ovStep(h, 'masakari')) ||
      (inc.portal && (ms.portalPending ?? []).length > 0 && !ovStep(h, 'portal')) ||
      manualFailOf(h)
    )
  })
  const cols: Col[] = [
    { key: 'vip', label: 'VIP 이동', grp: 'step', at: (_h, ms) => (ms.vip ? vipAtOf(ms).at : null) },
    {
      key: 'masa',
      label: 'Masakari 완료',
      grp: 'step',
      at: (_h, ms) => ms.masakari?.at ?? null,
      note: (ms) => (masaFailedRun(ms) ? ` (실패${masaFailedVms(ms) ? ` ${masaFailedVms(ms)}대` : ''})` : masaUncheckedOf(ms) ? ' (VM 확인 못 함)' : ''),
      // 못 옮긴 VM 이 있으면 완료 시각이 있어도 실패다 · Nova 를 못 읽었으면 다 옮겼는지 모른다(둘 다 평균에서 뺀다)
      partial: (ms) => masaPartOf(ms) || masaUncheckedOf(ms),
    },
    {
      key: 'pods',
      label: '파드 복구',
      grp: 'step',
      at: (_h, ms) => podsDoneSummary(ms).at,
      note: (ms) => {
        const n = podsDoneSummary(ms).pending
        return n ? ` (미완 ${n})` : ''
      },
      // 끝나지 않은 네임스페이스가 남은 값은 '그때까지 끝난 것' 의 시각이지 복구 시간이 아니다
      partial: (ms) => podsDoneSummary(ms).pending > 0,
    },
    {
      key: 'svc',
      /*
       * 포털 1차 정상화 — 감시 화면이 **처음 모두 동시에** 정상이 된 순간(lib/portalPhases, runTotals 주석). 포털 서비스 정상화는 이 값이다.
       * 1차 뒤 다시 끊겨 안 돌아온 화면이 있으면 시간은 남기되 끝난 값이 아니다(평균에서 뺌, 칸은 미복구)
       */
      label: '포털 1차 정상화',
      grp: 'step',
      at: (_h, _ms, i) => (tot[i].svc == null ? null : tot[i].base + (tot[i].svc as number)),
      note: (ms) => {
        const n = portalPhases(ms).flapsAfterFirst
        return n ? ` (이후 끊김 ${n})` : ''
      },
      partial: (ms) => (ms.portalPending ?? []).length > 0,
    },
    // Ceph 는 한 칸(사용자 결정 10-30: 데이터 복구 · HEALTH_OK 는 같은 쪽). HEALTH_OK 가 있으면 그것, 없으면 데이터 복구(옛 회차)
    {
      key: 'ceph',
      label: 'Ceph 복구',
      grp: 'step',
      at: (_h, ms) => ms.cephHealthy?.at ?? ms.ceph?.at ?? null,
      note: (ms) => (!ms.cephHealthy && ms.ceph ? ' (데이터 복구)' : ''),
      // HEALTH_OK 가 없어 데이터 복구 값을 대신 쓴 칸은 다른 지표라 평균에 섞지 않는다(코드 점검 10-30: 3회차 1시간 27분이 평균을 끌었다)
      partial: (ms) => !ms.cephHealthy && !!ms.ceph,
    },
    {
      key: 'all',
      label: '전체 복구',
      grp: 'total',
      partial: (ms) => inc.masakari && masaUncheckedOf(ms),
      at: (_h, ms, k) => {
        // 바꾼 단계가 있는 회차는 전체 복구 값이 없다(그 단계의 완료 시각이 없음 — 사용자 결정: '-' · 평균에서 뺌)
        if (svcFail[k] || ovIn(_h)) return null
        const ends = [inc.masakari && masaWatchedOf(ms) ? ms.masakari?.at : undefined, inc.portal && tot[k].svc != null ? tot[k].base + (tot[k].svc as number) : undefined].filter(
          (v): v is number => v != null,
        )
        return ends.length ? Math.max(...ends) : null
      },
    },
  ]
  // 전체 복구는 Masakari · 포털 둘 다 뺀 리포트에서는 잴 것이 없다
  if (!inc.masakari && !inc.portal) cols.splice(cols.findIndex((c) => c.key === 'all'), 1)
  const colItem: Record<string, keyof ReportItems | null> = { vip: 'hostVip', masa: 'masakari', pods: 'pods', svc: 'portal', ceph: 'ceph', all: null }
  for (let k = cols.length - 1; k >= 0; k--) {
    const it = colItem[cols[k].key]
    if (it && !inc[it]) cols.splice(k, 1)
  }
  const allLabel = cols.find((c) => c.key === 'all')?.label
  /** 전체 복구를 무엇으로 쟀나 — 항목을 하나 뺀 리포트에서 '중 늦은 쪽' 이라 쓰지 않게 */
  const allParts = [inc.masakari && 'Masakari 완료', inc.portal && '포털 1차 정상화'].filter(Boolean) as string[]
  const allBasis = allParts.length > 1 ? `${allParts.join(' · ')} 중 늦은 쪽` : `기준: ${allParts[0] ?? '-'}`
  const ci = (k: string) => cols.findIndex((c) => c.key === k)
  const vals = cols.map((c) =>
    runs.map((h, i) => {
      const at = c.at(h, msOf(h), i)
      // 0 으로 자르지 않는다 — SSH 끊김으로 DOWN 을 잡은 회차는 감지가 최대 90초 늦어 VIP 이동이 먼저 보일 수 있다.
      // 그걸 00:00 으로 그리면 '즉시 넘어갔다' 로 읽힌다. 음수 그대로 두고 표기에서 밝힌다.
      return at == null ? null : at - tot[i].base
    }),
  )
  /**
   * 평균 · 최대 · 빠름/느림에 넣는 값 — **DOWN 을 감지한 회차의 끝난 값** 만(사용자 검토 10-27). 13회차 리포트에서 '전체 복구 평균
   * 22:14' 가 DOWN 미감지(*) 시험 회차의 14초 · 2분, Ceph 를 기다리지 않고 끝낸 회차의 '기록 종료까지' 값을 그대로 섞은 단순
   * 평균이었다. 검증 시작부터 잰 값(*)은 기준이 달라 같이 평균 낼 수 없다. 모든 회차가 DOWN 미감지면 그것끼리는 낸다.
   */
  const anyDown = tot.some((t) => t.fromDown)
  const counted = (i: number) => tot[i].fromDown || !anyDown
  const isPartial = (k: number, i: number) => !!cols[k].partial?.(msOf(runs[i]))
  const idxs = (k: string) => {
    const c = ci(k)
    // 수동 조치로 복구된 회차의 시간은 사람이 끼어든 값이라 표에만 남기고 평균 · 최소 · 최대에서 뺀다(RunNote 주석).
    // 한 회차 리포트는 '평균' 이 곧 그 회차 값이라 빼면 카드가 'VIP 이동 없음 · 포털 감시 없음' 으로 거짓말을 한다 — 여러 회차일 때만
    return c < 0 ? [] : runs.map((_h, i) => i).filter((i) => vals[c][i] != null && counted(i) && !isPartial(c, i) && (one || !manualFailOf(runs[i])))
  }
  const nums = (k: string) => idxs(k).map((i) => vals[ci(k)][i] as number)
  const stat = (k: string) => {
    if (!idxs(k).length) return null
    const a = nums(k)
    return { avg: a.reduce((x, y) => x + y, 0) / a.length, min: Math.min(...a), max: Math.max(...a), n: a.length }
  }
  /*
   * 여러 회차 카드의 작은 글씨는 '최소 · 최대' 만(2026-11-10 사용자 요청). 예전 '최대 … · 6회차 기준 · 미복구 2회' 는 카드 폭을 넘어
   * 두 줄로 꺾였다. 평균에서 뺀 회차 · 미복구는 바로 아래 회차 비교 표의 칸(미복구 · *)과 평균 줄 설명에 남는다.
   */
  // 값이 없는 칸은 짧은 하이픈 — 긴 대시(—)는 표에서 선처럼 보였다(사용자 지적). 소요는 '8분 02초' 꼴(fmtDuration 주석)
  const E = (ms: number | null | undefined) => (ms == null ? '-' : fmtDuration(ms))
  const rangeOf = (st: { min: number; max: number } | null) => (st ? `최소 ${E(st.min)} · 최대 ${E(st.max)}` : '')
  const first = runs[0]
  const last = runs[runs.length - 1]
  /**
   * 대상 노드 — DOWN 을 못 잡은 회차의 '(미확인)' 은 노드가 아니다. 예전엔 '대상 노드 4개' 에 그것까지 셌다.
   * 'contrabass01' 과 '(미확인)' 이 같은 노드였는지 알 수 없으므로 따로 센다.
   */
  const UNKNOWN_NODE = '(미확인)'
  const nodes = Array.from(new Set(runs.map((h) => h.node).filter((n) => n && n !== UNKNOWN_NODE)))
  const unknownRuns = runs.filter((h) => !h.node || h.node === UNKNOWN_NODE).length
  const pendingRuns = inc.portal ? runs.filter((h, i) => tot[i].svcPending.length && !ovStep(h, 'portal')) : []
  const sSvc = stat('svc')
  const sAll = stat('all')
  const sVip = stat('vip')
  const sMasa = stat('masa')
  /**
   * 요약 문장에서 회차를 짚는 꼴 — 여러 회차면 이름 대신 번호 링크(#7). 20회차를 이름으로 늘어놓으면 한 문장이 문단이 됐다(사용자 검토).
   * 이름은 마우스를 올리면 보이고, 누르면 그 회차 상세가 펼쳐진다. 비교표 · 상세 머리에 같은 번호가 있다.
   */
  const runLink = (h: HistoryRecord) => {
    const i = runs.indexOf(h)
    return one ? he(nameOfRun(h, i)) : `<a ${hrefRun(i)} title="${he(nameOfRun(h, i))}">#${i + 1}</a>`
  }
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
    // 수동 조치로 복구된 회차는 목표와 상관없이 불합격(RunNote 주석)
    if (manualFailOf(h)) return 'fail'
    /*
     * 성공으로 바꾼 단계(RunOverride 주석)는 그 단계의 실패 · 목표만 건너뛴다. 예전엔 바꾼 회차를 통째로 '남은 실패 없으면 합격' 으로
     * 끝내, Masakari 만 바꿨는데 VIP 이동 · 파드 미완 같은 다른 항목의 목표 초과까지 합격이 됐다(코드 리뷰 11-17)
     */
    // 포털 대상이 하나라도 돌아오지 않았으면 그 회차는 불합격이다(모두 돌아와야 완료)
    if (inc.portal && tot[i].svcPending.length && !ovP(h)) return 'fail'
    // 파드도 같다 — 복구가 시작됐는데 끝나지 않은 네임스페이스가 있으면 값이 없다고 건너뛰지 않는다.
    // 건너뛰면 끝내 안 돌아온 회차가 다른 항목만으로 '합격' 이 됐다(검토 지적). VIP·Masakari 는 값이 없는 것이
    // '그 노드에 VIP 가 없었다 · 감시하지 않았다' 일 수 있어 미완과 구분할 수 없으므로 지금처럼 건너뛴다
    if (inc.pods && rto?.pods != null && podsDoneSummary(msOf(h)).pending > 0) return 'fail'
    // masakari 가 실패로 확정한 회차는 Masakari 목표가 있으면 불합격 — 값이 없는 것이 '감시 안 함' 이 아니라 '실패' 다
    if (inc.masakari && rto?.masa != null && masaFailedRun(msOf(h)) && !ovM(h)) return 'fail'
    // 전체 복구도 같다 — 감시한 것이 끝나지 않은 회차는 값이 없으므로 건너뛰면 '합격' 이 된다
    if (rto?.all != null && ci('all') >= 0 && svcFail[i]) return 'fail'
    let any = false
    for (const it of RTO_ITEMS) {
      const goal = rto?.[it.key]
      if (goal == null || ci(it.key) < 0) continue
      // 성공으로 바꾼 단계의 시간(못 옮긴 VM 이 있던 완료 · 1차 뒤 다시 끊긴 포털)은 목표에 대지 않는다
      if ((it.key === 'masa' && ovM(h)) || (it.key === 'svc' && ovP(h))) continue
      const v = vals[ci(it.key)][i]
      if (v == null) continue
      any = true
      if (v > goal * 1000) return 'fail'
    }
    // 바꾼 단계 말고는 잰 것이 없으면 합격(사람이 성공으로 본 회차)
    return any || ovIn(h) ? 'pass' : 'none'
  })

  /*
   * '핵심 요약'(자동 문장) 절은 뺐다(10-30 사용자 검토). 위 주요 수치(회차 · 포털 평균 · 전체 평균 · VIP · Masakari)와 회차 비교 표가 같은
   * 숫자를 이미 보여 주고, 문장은 파드 미완 · 다시 끊김 · 장애 주입 지연 같은 곁가지까지 늘어놓아 정작 볼 숫자를 가렸다.
   * 미복구 · 실패 · DOWN 미감지는 표의 칸(빨강 · *)과 주요 수치 카드의 작은 글씨로 남는다. 문장을 되살리지 말 것.
   */
  const svcFailRuns = ci('all') >= 0 ? runs.filter((_h, i) => svcFail[i]) : []

  /**
   * 검증 기간 — 같은 날이면 끝 쪽 날짜를 뺀다. 예전엔 '시작 ~ 끝 · 작성 … · Q-Term' 이 이름표 없이 한 줄에 붙어 날짜 세 개가 무엇인지
   * 읽히지 않았고(사용자 지적 10-27), 문서 제목은 첫 날짜만 적어 8월~10월 리포트가 '2026-08-11' 이었다.
   */
  const dStart = fmtDateTime(first.t0)
  const dEnd = fmtDateTime(last.closedAt)
  const sameDay = dStart.slice(0, 10) === dEnd.slice(0, 10)
  const period = `${dStart} ~ ${sameDay ? dEnd.slice(11) : dEnd}`
  const appVer = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : ''
  const H: string[] = []
  H.push(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${DOC_TITLE}: ${he(kind === 'evidence' && one ? nameOfRun(first, 0) : sameDay ? dStart.slice(0, 10) : `${dStart.slice(0, 10)} ~ ${dEnd.slice(0, 10)}`)}</title>
<style>
:root{--fg:#1b2430;--mut:#5b6675;--line:#dfe3ea;--soft:#f5f7fa;--brand:#1f3a68;--acc:#2f6fdc;--ok:#13804b;--okbg:#e3f6ec;--warn:#a15c00;--warnbg:#fff4dd;--bad:#c62f2f;--badbg:#fdeaea}
*{box-sizing:border-box}html{scroll-behavior:smooth}
body{font-family:"Malgun Gothic","맑은 고딕","Apple SD Gothic Neo","Pretendard",sans-serif;color:var(--fg);margin:0;background:#eef1f5;font-size:12.5px;line-height:1.6}
.page{max-width:1160px;margin:0 auto;padding:0 24px 48px}
header.hero{background:linear-gradient(135deg,#1f3a68,#2f6fdc);color:#fff;padding:30px 24px 26px}
header.hero .in{max-width:1112px;margin:0 auto}
header.hero h1{margin:0;font-size:22px;letter-spacing:-.3px}
header.hero .meta{margin-top:6px;opacity:.85;font-size:13px}header.hero .meta+.meta{margin-top:2px}header.hero .meta.sm{font-size:12px;opacity:.7}header.hero .ml{display:inline-block;min-width:84px;opacity:.75}
header.hero .chips{margin-top:12px;display:flex;flex-wrap:wrap;gap:6px}
header.hero .chip{background:rgba(255,255,255,.16);border-radius:999px;padding:2px 10px;font-size:12px}header.hero a.chip.back{color:#fff;text-decoration:none;background:rgba(255,255,255,.28);font-weight:600}header.hero a.chip.back:hover{background:rgba(255,255,255,.4)}a.evl{font-size:12px;white-space:nowrap}
.kpis{display:grid;grid-template-columns:repeat(5,1fr);gap:12px;margin:-18px 0 8px}
.kpi{background:#fff;border-radius:12px;padding:12px 14px;box-shadow:0 1px 3px rgba(20,30,50,.08);border-top:3px solid var(--acc);display:flex;flex-direction:column}
.kpi span{display:block;color:var(--mut);font-size:11.5px}.kpi b{display:block;font-size:17px;font-variant-numeric:tabular-nums;margin-top:3px}.kpi small{display:block;color:var(--mut);font-size:11px}
.kpi .sr{display:flex;align-items:center;gap:6px;margin-top:auto;padding-top:6px;font-size:11px;color:var(--mut);font-variant-numeric:tabular-nums;white-space:nowrap}.kpi .sb{flex:1;height:6px;border-radius:3px;background:var(--badbg);overflow:hidden}.kpi .sb i{display:block;height:100%;background:#2ea567}.kpi small.fl{color:var(--bad)}.kpi.lead{background:#e7eefb;box-shadow:inset 0 0 0 1px #c8d7f2,0 1px 3px rgba(20,30,50,.08)}.kpi.ok{border-top-color:var(--ok)}.kpi.warn{border-top-color:var(--warn)}.kpi.bad{border-top-color:var(--bad)}
section.sec{background:#fff;border-radius:14px;box-shadow:0 1px 3px rgba(20,30,50,.08);padding:18px 20px;margin-top:16px}
.sh{display:flex;align-items:center;gap:10px;margin:0 0 12px;padding-bottom:10px;border-bottom:2px solid var(--soft)}
.sh .n{width:22px;height:22px;border-radius:7px;background:var(--brand);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:12px}
.sh h2{margin:0;font-size:15px}.sh .d{margin-left:auto;color:var(--mut);font-size:12px}
ul.sum{list-style:none;margin:0;padding:0;display:grid;gap:6px}
ul.sum li{padding:8px 12px 8px 14px;border-radius:8px;background:var(--soft);border-left:4px solid var(--acc)}

table{border-collapse:separate;border-spacing:0;width:100%}
table.grid{border:1px solid var(--line);border-radius:10px;overflow:hidden}
table.grid th{background:#eef2f8;color:#34404f;font-weight:600;font-size:12px;padding:8px;text-align:left;border-bottom:1px solid var(--line);white-space:nowrap}
table.grid td{padding:7px 8px;border-bottom:1px solid var(--line);vertical-align:top}
table.grid tr:last-child td{border-bottom:0}table.grid tbody tr:nth-child(even) td{background:#fafbfd}
table.grid th.grp{text-align:center;background:#e3eaf6}table.grid th.c,table.grid td.c{text-align:center}
.num{font-variant-numeric:tabular-nums;white-space:nowrap}
.best{color:var(--ok);font-weight:700}.worst{color:var(--warn);font-weight:700}.pass{color:var(--ok);font-weight:700}.fail{color:var(--bad);font-weight:700}.wip{color:var(--warn);font-weight:700}
.cn{display:block;font-size:11px;font-weight:400;color:var(--mut)}td.st{font-weight:700}td.fail .cn,td.wip .cn{color:inherit}
.rn{display:block;max-width:200px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
table.cmp{overflow:visible}table.grid.cmp tbody tr:nth-child(even) td{background:transparent}table.grid.cmp td.key.ff{background:var(--badbg)!important;color:var(--bad)}table.cmp thead tr:first-child th{position:sticky;top:0;z-index:2;height:36px}table.cmp thead tr:nth-child(2) th{position:sticky;top:36px;z-index:2;white-space:normal;line-height:1.3}
table.cmp thead tr:first-child th:first-child{border-top-left-radius:10px}table.cmp thead tr:first-child th:last-child{border-top-right-radius:10px}
table.cmp tr.avg td:first-child{border-bottom-left-radius:10px}table.cmp tr.avg td:last-child{border-bottom-right-radius:10px}
td.key{background:#f3f7ff!important;font-weight:600}tr.avg td,tr.sok td{background:#eef2f8!important;font-weight:700}
a{color:var(--acc);text-decoration:none}a:hover{text-decoration:underline}
.mut{color:var(--mut)}.note{color:var(--mut);font-size:12px;margin:8px 0 0}
.explain{margin:12px 0 0;padding:10px 14px;border-radius:8px;background:var(--soft);font-size:10.5px;line-height:1.7}
.explain b{color:var(--brand)}
.legend{display:flex;flex-wrap:wrap;gap:12px;font-size:11.5px;color:var(--mut);margin:10px 0 0}
.legend i{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:4px;vertical-align:-1px}
.flow{display:grid;grid-template-columns:210px 1fr 150px;gap:6px 12px;align-items:center;font-size:12px}
.flow .hd{color:var(--mut);font-size:11.5px}
.track{position:relative;height:22px;background:var(--soft);border-radius:6px}
.bar{position:absolute;top:8px;height:6px;left:0;border-radius:3px;background:#c9d6ee}
.dot{position:absolute;top:4px;width:14px;height:14px;margin-left:-7px;border-radius:50%;border:2px solid #fff;box-shadow:0 0 0 1px rgba(0,0,0,.08)}
.dot.up{top:-3px}.dot.dn{top:11px}.dot.over{border-radius:3px}
.axis{position:relative;height:16px;font-size:10.5px;color:var(--mut)}.axis span{position:absolute;transform:translateX(-50%);white-space:nowrap}.axis span:first-child{transform:none}.axis span.e{transform:translateX(-100%)}
.sbar{position:absolute;top:5px;height:12px;left:0;border-radius:3px}
.ovf{display:block;font-size:11px;color:var(--warn)}
.after{margin:10px 0 0;padding:8px 12px;border-radius:8px;background:var(--soft);font-size:12.5px}
.refl{margin:-4px 0 12px;font-size:12px;color:var(--mut)}
table.grid.tl tbody tr.kd td{background:#fdeeee}table.grid.tl tbody tr.kd td:first-child{box-shadow:inset 3px 0 0 #d64545}table.grid.tl tbody tr.kd td:nth-child(3){color:#a32d2d;font-weight:600}
table.grid.tl tbody tr.kr td{background:#eaf1fd}table.grid.tl tbody tr.kr td:first-child{box-shadow:inset 3px 0 0 #2f6fdc}table.grid.tl tbody tr.kr td:nth-child(3){color:#1d4f9e;font-weight:600}
table.grid.tl tbody tr.kf td:first-child{box-shadow:inset 3px 0 0 #a0a8b5}table.grid.tl tbody tr.kf td:nth-child(3){color:var(--mut)}
table.grid.tl tbody tr.dim td{color:#a0a8b5}table.grid tbody tr.sep td{background:var(--soft);color:var(--mut);font-size:11.5px;padding:5px 8px}table.grid.tl tbody tr.sep td{background:var(--soft);color:var(--mut);font-size:11.5px;padding:5px 8px}
.alltag{display:inline-block;margin-left:6px;padding:0 6px;border-radius:6px;background:#dff3e6;color:#13804b;font-size:11px;font-weight:600}
.legend i.lk{display:inline-block;width:12px;height:10px;margin-right:4px;vertical-align:-1px;border-radius:2px}.lk.kd{background:#fdeeee;box-shadow:inset 3px 0 0 #d64545}.lk.kr{background:#eaf1fd;box-shadow:inset 3px 0 0 #2f6fdc}.lk.kf{background:#f1f3f6;box-shadow:inset 3px 0 0 #a0a8b5}.lk.ka{background:#fff3e3;box-shadow:inset 3px 0 0 #e08a1e}
table.grid.tl tbody tr.ka td{background:#fff3e3}table.grid.tl tbody tr.ka td:first-child{box-shadow:inset 3px 0 0 #e08a1e}table.grid.tl tbody tr.ka td:nth-child(3){color:#9a5200;font-weight:600}
.envsum{display:flex;align-items:center;gap:18px;padding:8px 12px;background:#f5f7fa;border:1px solid #e3e7ed;border-radius:8px;margin-bottom:12px;font-size:12px}
.envsum b{color:#1f3a68;font-size:14px;margin-left:4px}.envsum .lgd{margin-left:auto;display:flex;gap:6px;align-items:center}
.nodes{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:10px}
.nd{border:1px solid #d8dde4;border-radius:10px;overflow:hidden}
.nd .ntop{background:#f3f6fb;border-bottom:1px solid #e3e7ed;padding:9px 12px}
.nd .ntop .nt{display:flex;align-items:center;gap:5px}.nd .ntop .nt b{font-size:14px;color:#1f3a68;margin-right:2px}
.nd .ntop .nh{font-size:12px;color:#374151;font-weight:600;margin-top:2px}
.nrole{font-size:10.5px;border-radius:4px;padding:0 6px;font-weight:700}.nrole.ctl{background:#e3ebf8;color:#1f3a68}.nrole.cpt{background:#eef0f3;color:#374151}
.nd .nbd{padding:10px 12px;line-height:1.9}.nd .nbd .nnone{font-size:11.5px;color:#5b6675}
.vchip{display:inline-block;border-radius:4px;padding:0 6px;margin:0 6px 4px 0;font-size:11px;line-height:20px;white-space:nowrap}
.vchip.vk8s{background:#e3ebf8;color:#1f3a68;border:1px solid #c3d2ea}.vchip.vweb{background:#e3f4ea;color:#0f5132;border:1px solid #b9e0c8}.vchip.vetc{background:#f1f3f6;color:#374151;border:1px solid #dde2e8}
.vchip.vev{box-shadow:0 0 0 2px #f0c860;margin:0 9px 6px 2px}.envsum .lgd .vchip{margin:0}.envsum .lgd .vchip.vev{background:#fff;margin:0 2px}
.envtabs{display:flex;gap:6px;margin:0 0 8px;flex-wrap:wrap}.envtabs button{border:1px solid #c5cfdd;background:#fff;border-radius:999px;padding:1px 12px;font:inherit;font-size:12px;cursor:pointer}.envtabs button.on{background:#1f3a68;color:#fff;border-color:#1f3a68}.envblk+.envblk{margin-top:14px}.envph{font-weight:700;font-size:13px;color:#1f3a68;margin:0 0 6px}.envchg{font-size:12px;background:#fff4dd;color:#6b4300;border-radius:6px;padding:6px 10px;margin-top:8px}@media print{.envtabs{display:none}.envblk{display:block!important}}
.envnote{margin:10px 0 0;padding:7px 12px;list-style:none;font-size:12.5px;font-weight:600;color:#3d2f00;background:#fff8e1;border-left:3px solid #e0b84a;border-radius:4px}.envnote li+li{margin-top:3px}
.sflow{display:flex;align-items:stretch;margin-bottom:12px}
.sf .sgo{font-weight:800;color:#1f3a68;margin-bottom:2px}.sf .srl{line-height:1.55}.sf .sli{padding-left:0.7em}.sf .sfl{color:#b42318;font-size:11.5px;margin-top:2px}.sf tr.sref .sfl{color:#5b6675}
.sflow .sst{flex:1;border:1px solid #c9d6ea;border-radius:10px;padding:12px 8px;background:#f7f9fd;text-align:center;font-weight:800;color:#1f3a68;display:flex;align-items:center;justify-content:center}
.sflow .sst.sinj{background:#fdecec;border-color:#f3c1c1;color:#b42318}.sflow .sst.sfin{background:#e3f4ea;border-color:#b9e0c8;color:#0f5132}.sflow .sst.sref{background:#fff;border-style:dashed}
.sflow .sar{display:flex;align-items:center;padding:0 5px;color:#9aa3ae;font-size:16px}
table.sf{width:100%;border-collapse:collapse;font-size:12px;table-layout:fixed;-webkit-print-color-adjust:exact;print-color-adjust:exact}
table.sf th{background:#c9d6ea;color:#1f3a68;border:1px solid #aebfda;padding:6px 8px}
table.sf td{border:1px solid #d8dde4;padding:7px 9px;vertical-align:middle}table.sf td.snm{font-weight:700;color:#1f3a68}
table.sf tr.sfin td{background:#f0f8f3}table.sf tr.sref td{color:#5b6675}
table.ps{width:100%;border-collapse:collapse;font-size:12.5px;table-layout:fixed;-webkit-print-color-adjust:exact;print-color-adjust:exact}
table.ps th{background:#c9d6ea;color:#1f3a68;border:1px solid #aebfda;padding:7px 8px;font-size:12px;text-align:center}table.ps th.pgrp{background:#bccbe3}
table.ps td{border:1px solid #d8dde4;padding:9px 10px;vertical-align:top}table.ps td.pc{text-align:center;vertical-align:middle}
table.ps td.pc .pdt{font-size:11px;color:#5b6675;font-weight:400;white-space:nowrap}table.ps td.pc .ppatch{font-size:11px;color:#1d5fd0;font-weight:600;margin-top:2px}
table.ps .plb{font-weight:800;color:#1f3a68;font-size:12px;margin:0 0 4px}table.ps .plb.pact{margin-top:10px;padding-top:8px;border-top:1px dashed #d8dde4}
table.ps ul{margin:0;padding-left:16px}table.ps li{margin:2px 0;line-height:1.5;white-space:pre-line}table.ps .irn{font-size:11px;margin-left:4px}table.ps .irn a{color:#1d5fd0}
table.ps .ptm{font-weight:700;margin:6px 0 2px}table.ps .pnone{color:#5b6675}
.ares{font-size:10.5px;border-radius:4px;padding:0 6px;font-weight:700;margin-left:6px;white-space:nowrap}.ares.a-ok{background:#e3f4ea;color:#0f5132}.ares.a-repro{background:#fdecec;color:#b42318}.ares.a-wip{background:#f1f3f6;color:#374151}.ares.a-done{background:#e3ebf8;color:#1f3a68}
table.ps tfoot td{background:#e9eef6;font-weight:800;border-top:2px solid #aebfda;vertical-align:middle}
table.ps .pg{color:#047a3f;font-weight:800}table.ps .pr{color:#c21f1f;font-weight:800}
table.ps.psum{margin-bottom:12px}table.ps td.pdt{font-size:12px;color:#1d5fd0;white-space:nowrap}table.ps tr.ptot td{background:#e9eef6;font-weight:800}
table.ps .pln{font-size:11.5px;color:#3a4556;margin-top:2px;line-height:1.5;padding-left:0.85em;text-indent:-0.85em}table.ps .pmut{color:#5b6675}table.ps td.pno{color:#1f3a68;font-weight:800}
table.ps .ptm{display:inline-block;border-radius:4px;padding:0 7px;font-size:11px;font-weight:700;background:#eef2f8;color:#1f3a68;margin:0 0 4px}
table.ps ul.pacts{margin:0;padding-left:16px}table.ps ul.pacts li{margin:0 0 4px;white-space:normal}table.ps ul.pacts li:last-child{margin-bottom:0}
table.ps td[rowspan]{vertical-align:middle}table.ps tr.pcom td{background:#fafbfd}table.ps.pdet .ares{margin-left:0}
table.nc td.phc{font-weight:800;color:#1f3a68;background:#f3f6fb}
table.nc,table.fx{width:100%;border-collapse:collapse;border:1px solid #c7cdd6;font-size:12.5px;font-variant-numeric:tabular-nums;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.ksum{background:#fff;border:1px solid var(--line);border-radius:12px;margin:-18px 0 8px;padding:16px 20px 6px;box-shadow:0 1px 3px rgba(20,30,50,.08);-webkit-print-color-adjust:exact;print-color-adjust:exact}
.ksum .kh{display:flex;align-items:baseline;gap:14px;padding:0 4px 12px;border-bottom:1px solid #e5e7eb}
.ksum .kt{font-size:12px;color:#4b5563;font-weight:700}.ksum .kn{font-size:14px;font-weight:700;color:#1f2937}.ksum .kn b{color:#047a3f;font-weight:800}
.ksum .km{margin-left:auto;font-size:11px;color:var(--mut)}
table.ks{width:100%;border-collapse:collapse;table-layout:fixed;font-size:12.5px;font-variant-numeric:tabular-nums}
table.ks th{font-size:11.5px;color:#374151;font-weight:700;text-align:center;padding:0 10px;height:32px;border-bottom:1.5px solid #1f3a68}
table.ks td{padding:0 10px;height:38px;border-bottom:1px solid #eceff3;text-align:center;vertical-align:middle;white-space:nowrap}
table.ks .l{text-align:left}table.ks td.fr{white-space:normal}table.ks td.nm{font-weight:700}table.ks td.avg{font-weight:800;font-size:14px}
table.ks tr.tot td{background:#f3f6fb;border-top:1.5px solid #c9d3e3}table.ks tr:last-child td{border-bottom:0}
table.ks td.sr2 .sb{display:inline-block;width:min(120px,45%);height:7px;border-radius:4px;background:#f6dcdc;vertical-align:middle;margin-right:10px;overflow:hidden}
table.ks td.sr2 .sb i{display:block;height:100%;background:#3aa76d}
table.ks .g{color:#047a3f}table.ks .r{color:#c21f1f}table.ks .nv{color:#9aa3ae}
table.nc th,table.fx th{background:#c9d6ea;color:#1f3a68;font-weight:700;font-size:12px;border:1px solid #aebfda;padding:0 10px;height:34px;text-align:center;vertical-align:middle}
table.nc thead tr:first-child th.grp{background:#bccbe3}
table.nc td{border:1px solid #d8dde4;height:38px;padding:0 10px;text-align:center;vertical-align:middle;white-space:nowrap;background:#fff}
table.nc td.l{text-align:left}table.nc td.node{font-weight:600}
table.nc td.res{font-weight:800}table.nc td.res.ok{color:#047a3f}table.nc td.res.bad{color:#c21f1f}table.nc td.res.nn{color:#6b7280;font-weight:600}
table.nc td.fl{color:#c21f1f;font-weight:700}table.nc td.pass{color:var(--ok);font-weight:700}table.nc td.fail{color:var(--bad);font-weight:700}
table.nc td.tot{font-weight:800;font-size:13px;background:#f3f6fb}table.nc td.nv{color:#6b7280;font-weight:400}
table.nc tfoot td{background:#e9eef6;font-weight:800;border-top:2px solid #aebfda}table.nc td.rsum{font-weight:400;font-size:12px}table.nc td.rsum .g{color:#047a3f}table.nc td.rsum .r{color:#c21f1f}
table.nc a.rn,table.fx a.rn{font-weight:600}
table.fx td{border:1px solid #d8dde4;padding:9px 10px;vertical-align:middle;line-height:1.55;background:#fff}table.fx td.c{text-align:center}table.fx td.dc{background:#f7f9fc;font-size:11.5px}
table.fx .rs{display:block;color:#6b7280;font-size:11.5px}
.ln{display:flex;gap:4px}.ln+.ln{margin-top:1px}.ln b{color:#6b7280;flex:none}.ln span{white-space:pre-wrap;word-break:break-word}.nt+.nt{margin-top:6px;padding-top:6px;border-top:1px dashed var(--line)}
.fstep.act{background:#fff0dc;color:#b45f00}
.lnav{display:flex;flex-direction:column;gap:6px}.lrow{display:flex;gap:10px;align-items:baseline}.lph{flex:none;width:76px;color:var(--mut);font-size:12px;font-weight:600}.lchips{display:flex;flex-wrap:wrap;gap:4px}
.lchip{display:inline-block;min-width:34px;text-align:center;border:1px solid var(--line);border-radius:6px;padding:0 6px;font-size:12px;color:var(--fg);background:#fff;text-decoration:none;font-variant-numeric:tabular-nums}.lchip:hover{background:var(--soft)}.lchip.hot{background:#fff1e0;border-color:#f5c58a;color:#b45309;font-weight:700}
table.rkv{border-collapse:collapse;width:100%;font-size:12px}table.rkv th{width:104px;background:#eef2f8;color:#1f3a68;font-weight:700;text-align:center;border:1px solid #d8dde4;padding:5px 8px;vertical-align:middle;white-space:nowrap}table.rkv td{border:1px solid #d8dde4;padding:5px 10px;line-height:1.55;vertical-align:middle}table.rkv .rs0{display:block;height:.6em}table.rkv .rvd{display:inline-block;border-radius:4px;padding:0 8px;font-weight:600;font-size:12px;line-height:1.55}table.rkv .rvd.ok{background:#e3f6ea;color:#047a3f}table.rkv .rvd.fail{background:#fde2e2;color:#c21f1f}table.rkv .rs1,table.rkv .rs2{display:block;white-space:pre-wrap;word-break:break-word}table.rkv .rs2{padding-left:14px;color:#3b4554}
.cbox{border:1px solid var(--line);border-radius:10px;margin:10px 0 4px;overflow:hidden}.cbox .hd{background:#eef2f8;padding:6px 12px;font-weight:700;font-size:12.5px}.cbox .it{display:grid;grid-template-columns:90px 1fr;gap:10px;align-items:center;padding:9px 12px;border-top:1px solid var(--line);font-size:11.5px}.cbox .it .c{text-align:center}
@media (max-width:900px){table.nc th,table.nc td{padding:0 6px;font-size:11.5px}}
.tools{display:flex;gap:6px;margin-bottom:10px;align-items:center}table.grid.fc td{vertical-align:top;padding:9px 8px}.fstep{display:inline-block;background:var(--badbg);color:var(--bad);border-radius:6px;padding:1px 10px;font-weight:700;font-size:12px}.fm{display:block;color:var(--mut);font-size:11.5px;margin-top:1px}.ncards{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px}.ncard{border:1px solid var(--line);border-radius:10px;padding:12px 14px}.ncard .t{font-weight:700;font-size:13px}.ncard .big{font-size:16px;font-weight:700;margin:4px 0}.ncard .nb{height:8px;border-radius:4px;background:var(--badbg);overflow:hidden;margin:6px 0}.ncard .nb i{display:block;height:100%;background:#2ea567}.ncard .mut b{color:var(--fg)}.tools .tsum{margin-left:auto;font-size:12.5px;color:var(--mut)}.tools button{border:1px solid var(--line);background:#fff;border-radius:8px;padding:4px 10px;font-size:12px;cursor:pointer}
details.run{border:1px solid var(--line);border-radius:12px;margin:8px 0;background:#fff;scroll-margin-top:12px}
details.run>summary{list-style:none;cursor:pointer;padding:10px 14px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
details.run>summary::-webkit-details-marker{display:none}
details.run>summary:before{content:'▸';color:var(--mut);transition:transform .15s}details.run[open]>summary:before{transform:rotate(90deg)}
details.run[open]>summary{border-bottom:1px solid var(--line);background:var(--soft);border-radius:12px 12px 0 0}
.rt{font-weight:700;font-size:14px}.tag{background:#e6eefc;color:var(--brand);border-radius:6px;padding:1px 8px;font-size:12px;font-weight:600}
.pill{border-radius:999px;padding:1px 9px;font-size:11.5px;background:var(--soft);color:var(--mut)}.pill.ok{background:var(--okbg);color:var(--ok)}.pill.warn{background:var(--warnbg);color:var(--warn)}.pill.bad{background:var(--badbg);color:var(--bad)}
.rb{padding:12px 16px 16px}
.kv{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:4px 0 12px}.kv div{background:var(--soft);border-radius:8px;padding:6px 10px}.kv span{display:block;color:var(--mut);font-size:11.5px}.kv b{display:block;font-variant-numeric:tabular-nums;font-size:14px}.kv small{display:block;color:var(--mut);font-size:11px;font-variant-numeric:tabular-nums}
h3{font-size:13.5px;margin:14px 0 6px;color:var(--brand)}
.svr{background:var(--okbg);color:var(--ok);border-radius:4px;padding:0 6px;font-size:11.5px;white-space:nowrap}
details.ev{border:1px solid var(--line);border-radius:8px;padding:6px 10px;margin:6px 0;background:#fcfdff}details.ev>summary{cursor:pointer;font-weight:600}
.evk{display:grid;grid-template-columns:150px 1fr;gap:2px 10px;margin:6px 0;font-size:12px}.evk span:nth-child(odd){color:var(--mut)}
code,.pre{font-family:Consolas,"D2Coding",monospace;font-size:11.5px}.pre{background:#f6f8fb;border:1px solid var(--line);border-radius:8px;padding:8px;white-space:pre;line-height:1.5;max-height:420px;overflow:auto}.pre .lw{display:block;width:max-content;min-width:100%}.pre .ln{display:block;max-width:200ch;white-space:pre-wrap;overflow-wrap:anywhere;padding-left:2ch;text-indent:-2ch;min-height:1.5em}.pre.nowrap .ln{max-width:none;white-space:pre}
.h1l{background:#ffe8a3;color:#7a4b00;font-weight:700}.h2l{background:#fff7d6}
tr.badrow td{background:var(--badbg)!important;color:var(--bad)}
.top{display:inline-block;margin-top:10px;font-size:12px}
.page.wtoc{max-width:1460px;display:grid;grid-template-columns:250px minmax(0,1fr);gap:20px;align-items:start}.tmain{min-width:0}body:has(.page.wtoc) header.hero .in{max-width:1412px}
nav.toc{position:sticky;top:12px;margin-top:16px;max-height:calc(100vh - 24px);overflow:auto;background:#fff;border-radius:12px;box-shadow:0 1px 3px rgba(20,30,50,.08);padding:10px 8px 12px}
.toc .tt{font-size:12px;font-weight:700;color:var(--brand);padding:2px 8px 6px;border-bottom:1px solid var(--line);margin-bottom:6px;display:flex;align-items:center}
.toc .tt button{margin-left:auto;border:1px solid var(--line);background:#fff;border-radius:6px;font-size:11px;padding:0 6px;cursor:pointer;color:var(--mut)}
.toc .grp{font-size:11px;color:var(--mut);padding:8px 8px 2px;font-weight:600}
.toc a{display:grid;grid-template-columns:46px 1fr;gap:6px;align-items:baseline;padding:4px 8px;border-radius:6px;color:var(--fg);font-size:12px;line-height:1.35;border-left:3px solid transparent;text-decoration:none}
.toc a:hover{background:var(--soft)}.toc a.on{background:#eaf1fd;border-left-color:var(--acc);font-weight:600}.toc a.pl{grid-template-columns:1fr}
.toc a .t{font-variant-numeric:tabular-nums;font-size:11px;color:var(--mut);text-align:right}.toc a.kd .t{color:var(--bad);font-weight:700}.toc a.kr .t{color:var(--acc);font-weight:700}.toc a.dim{color:#8a93a1}
.evgrp{font-size:12px;color:var(--mut);font-weight:700;margin:14px 0 2px;padding-bottom:2px;border-bottom:1px dashed var(--line)}
details.ev,[id^="sum-"],[id^="tl-"],[id^="ev-"],#notes{scroll-margin-top:12px}.flash{animation:evfl 1.2s ease-out}
.toc a .lbl{display:flex;align-items:baseline;gap:5px;min-width:0}.toc a .lbl>span{min-width:0}.toc a .pb{flex:none;font-style:normal;display:inline-block;margin-left:0;padding:0 5px;border-radius:5px;background:#efe6fb;color:#6a2fc0;font-size:10.5px;font-weight:600;vertical-align:1px}
.toc details.tf>summary{list-style:none;cursor:pointer;display:grid;grid-template-columns:46px 1fr;gap:6px;padding:4px 8px;font-size:12px;border-radius:6px}.toc details.tf>summary::-webkit-details-marker{display:none}
.toc details.tf>summary:hover{background:var(--soft)}.toc details.tf>summary span:last-child:after{content:' ▸';color:var(--mut)}.toc details.tf[open]>summary span:last-child:after{content:' ▾'}.toc details.tf a{padding-left:20px;font-size:11.5px}
.pcards{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0 4px}.pcards div{background:var(--soft);border-radius:8px;padding:6px 10px;min-width:150px}.pcards span{display:block;color:var(--mut);font-size:11.5px}.pcards b{display:block;font-size:14px;font-variant-numeric:tabular-nums}.pcards small{display:block;color:var(--mut);font-size:11px}.pcards .k{box-shadow:inset 3px 0 0 #2f6fdc}
.psub{font-size:12px;font-weight:700;color:var(--mut);margin:14px 0 4px}table.grid tr.pk td{background:#eaf1fd}table.grid tr.pk td:first-child{box-shadow:inset 3px 0 0 #2f6fdc}@keyframes evfl{0%{box-shadow:0 0 0 3px #2f6fdc}100%{box-shadow:0 0 0 0 transparent}}
.tlev{margin-left:6px;font-size:11px;white-space:nowrap}
@media (max-width:900px){.page.wtoc{grid-template-columns:1fr}nav.toc{position:static;max-height:none}}
@media print{.pre .lw{width:auto}.pre .ln{max-width:none}.pre.nowrap .ln{white-space:pre-wrap}body{background:#fff}.tools,.top,nav.toc,.tlev{display:none}.page.wtoc{display:block;max-width:none}section.sec,.kpi,.ksum{box-shadow:none;border:1px solid var(--line)}.kpi.lead{box-shadow:none;border-left-color:#c8d7f2;border-right-color:#c8d7f2;border-bottom-color:#c8d7f2;-webkit-print-color-adjust:exact;print-color-adjust:exact}.pre{max-height:none;overflow:visible;white-space:pre-wrap;word-break:break-all}details.run{break-inside:auto}header.hero{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
@media (max-width:820px){.kpis{grid-template-columns:repeat(2,1fr)}.flow{grid-template-columns:120px 1fr 80px}.kv{grid-template-columns:repeat(2,1fr)}}
</style></head><body>`)

  // ── 머리 · 주요 수치 ──
  // 머리 칩은 회차 수만(10-30 사용자 지적) — 예전엔 대상 노드를 칩으로 늘어놓아 20회차면 같은 노드 이름이 줄줄이 섰다. 노드는 회차 상세 · 비교표에 있다
  H.push(`<header class="hero" id="top"><div class="in"><h1>${DOC_TITLE}${kind === 'evidence' && one ? `: ${he(nameOfRun(first, 0))}` : ''}${kind === 'latency' && grp ? ` · ${he(grp.name)}` : ''}</h1>
<div class="meta"><span class="ml">검증 기간</span>${he(period)}${one ? ` (${E(last.closedAt - first.t0)})` : ` · ${runs.length}회차`}</div>
<div class="meta sm"><span class="ml">리포트 작성</span>${he(fmtDateTime(Date.now()))} · Q-Term${appVer ? ` ${he(appVer)}` : ''}</div>
<div class="chips"><span class="chip">${runs.length}회차</span>${kind !== 'total' && opts.totalFile ? `<a class="chip back" href="${fileHref(opts.totalFile)}">← 종합 결과</a>` : ''}</div></div></header><div class="page">`)
  // '제외한 항목: 파드 복구 · Ceph …' 줄은 뺐다(2026-11-10 사용자 요청) — 보고용 묶음이 기본이 되면서 거의 늘 붙어 머리만 길게 했다. 뺀 항목은 표 · 카드에 없는 것으로 드러난다
  void excluded
  /*
   * 포털 API 응답 시간(2026-11-19 사용자 결정 · 목업 latency_mock2 · 4) — 화면 · API 마다 노드 UP · DOWN 의 최소 · 중앙 · 최대(각각 칸)와
   * 변화(중앙값: 오르면 빨강 'n배 상승', 아니면 회색). 리포트 만들기의 '포털 API 응답 시간' 이 따로 파일로 내고(이것만 고르면 이 내용만 —
   * 문제 API 를 그 파일만 건네려고), 종합 결과에는 '느려진 API' 다섯 줄만 싣는다. 옛 회차는 정상화 확정 요청만 있어 DOWN 칸만(lib/portalLatency).
   * API · 화면 이름은 사람이 붙인 이름이라 내보내기 마스킹을 거친다
   */
  // 회차 짧은 이름 — 이름 끝 '(노드)' 를 뗀다(노드는 옆 칸에 있다). 포털 API 응답 파일이 앞에서 쓰므로 여기에(뒤에 두면 그 파일에서 초기화 전 참조)
  const shortName = (h: HistoryRecord, i: number) => {
    const n = nameOfRun(h, i)
    const s2 = n.replace(/\s*\(([^()]*)\)\s*$/, (m, x: string) => (h.node && x.includes(h.node) ? '' : m))
    return s2 || n
  }
  const latOf = (h: HistoryRecord) => latencyView(msOf(h), h.t0, h.milestones.down?.at ?? null, nodeBackAt(msOf(h)))
  const latCells = (x: LatStat | null) =>
    x ? `<td class="num c">${fmtLat(x.min)}</td><td class="num c"><b>${fmtLat(x.med)}</b></td><td class="num c">${fmtLat(x.max)}</td>` : '<td class="c mut">-</td><td class="c mut">-</td><td class="c mut">-</td>'
  const latChg = (up: LatStat | null, dn: LatStat | null) => {
    const ch = latChange(up, dn)
    return ch ? `<span style="color:${ch.rise ? '#c21f1f;font-weight:700' : '#6b7280'}">${ch.text}</span>` : '<span class="mut">-</span>'
  }
  const latName = (x: string) => he(maskForExport(x))
  const latTable = (lat: LatView) => {
    let prev = ''
    const th3 = '<th class="c" style="width:74px">최소</th><th class="c" style="width:74px">중앙</th><th class="c" style="width:74px">최대</th>'
    const body = lat.rows
      .map((r) => {
        const sep = r.screen !== prev ? `<tr class="sep"><td colspan="8">${latName(r.screen)}</td></tr>` : ''
        prev = r.screen
        return `${sep}<tr><td>${latName(r.name)}</td>${latCells(r.up)}${latCells(r.down)}<td class="c">${latChg(r.up, r.down)}</td></tr>`
      })
      .join('')
    return (
      `<table class="grid"><thead><tr><th rowspan="2">화면 · API</th><th class="c" colspan="3">노드 UP 응답</th><th class="c" colspan="3">노드 DOWN 응답</th><th class="c" rowspan="2" style="width:110px">변화 (중앙값)</th></tr><tr>${th3}${th3}</tr></thead><tbody>${body}</tbody></table>` +
      `<div class="note">${
        lat.source === 'streak'
          ? '이 회차는 노드 DOWN 중 화면이 정상화를 확정한 연속 요청의 응답만 남아 있습니다(끊김 직후 가장 느렸던 때는 빠짐). 노드 UP 응답은 이후 회차부터 기록됩니다.'
          : '노드 DOWN = DOWN 감지부터 노드가 돌아올 때까지, 노드 UP = 그 전과 노드가 돌아온 뒤.'
      } 정상 응답만 셉니다(시간 초과 · 오류 응답 제외).</div>`
    )
  }
  /** 포털 API 응답 지연(2026-11-19 사용자 결정: 제목 · 오른쪽 글 · 글자 2 작게, 예전 '느려진 API') — 고른 회차 전체에서 노드 DOWN 중앙값이 큰 다섯. runHref: 회차 칸 링크(없으면 글만) */
  const latTop = () =>
    runs
      .flatMap((h, i) => (latOf(h)?.rows ?? []).filter((r) => r.down).map((r) => ({ i, r })))
      .sort((a, b) => (b.r.down as LatStat).med - (a.r.down as LatStat).med)
      .slice(0, 5)
  const latSummary = (no: string, runHref: ((i: number) => string) | null, more: string) => {
    const top = latTop()
    if (!top.length) return ''
    return (
      `<section class="sec"><div class="sh">${no ? `<span class="n">${no}</span>` : ''}<h2>포털 API 응답 지연</h2><span class="d" style="font-size:10px">전체 회차 중 노드 DOWN 중 응답이 가장 느린 API ${top.length}개</span></div>` +
      `<table class="grid"><thead><tr><th>화면 · API</th><th class="c" style="width:120px">회차</th><th class="c" style="width:96px">DOWN 중앙</th><th class="c" style="width:96px">DOWN 최대</th><th class="c" style="width:96px">UP 중앙</th><th class="c" style="width:110px">변화 (중앙값)</th></tr></thead><tbody>` +
      top
        .map(({ i, r }) => {
          const lbl = `#${i + 1} ${he(shortName(runs[i], i))}`
          return `<tr><td>${latName(r.screen)} · <b>${latName(r.name)}</b></td><td class="c">${runHref ? `<a ${runHref(i)}>${lbl}</a>` : lbl}</td><td class="num c"><b>${fmtLat((r.down as LatStat).med)}</b></td><td class="num c">${fmtLat((r.down as LatStat).max)}</td><td class="num c">${r.up ? fmtLat(r.up.med) : '<span class="mut">-</span>'}</td><td class="c">${latChg(r.up, r.down)}</td></tr>`
        })
        .join('') +
      `</tbody></table>${more}</section>`
    )
  }
  /*
   * 조치 전 · 후 비교(2026-11-25 사용자 결정 · 목업 latency_compare_mock, lib/portalLatency latencyCompare 주석) — '포털 API 응답' 파일 맨 위에
   * 표 전부(cmpSection), 종합 결과에는 많이 줄어든 API 다섯 줄(cmpSummary). 고른 회차가 리포트에 없으면(창에서 회차를 다시 고른 뒤) 뺀다
   */
  const cmpPick = opts.latCmp
  const cmpRecs = (ids: string[]) => ids.map((id) => runs.find((h) => h.id === id)).filter((h): h is HistoryRecord => !!h).sort((a, b) => a.t0 - b.t0)
  const cmpPreRecs = cmpPick ? cmpRecs(cmpPick.pre.ids) : []
  const cmpPostRecs = cmpPick ? cmpRecs(cmpPick.post.ids) : []
  const cmpRun = (h: HistoryRecord): LatCmpRun => ({ m: msOf(h), t0: h.t0, downAt: h.milestones.down?.at ?? null, upAt: nodeBackAt(msOf(h)) })
  const cmp = cmpPreRecs.length && cmpPostRecs.length ? latencyCompare(cmpPreRecs.map(cmpRun), cmpPostRecs.map(cmpRun)) : null
  const cmpHead = (side: 'pre' | 'post') => {
    const pk = cmpPick?.[side]
    return `조치 ${side === 'pre' ? '전' : '후'}${pk?.label ? ` ${he(pk.label)}` : ''} ${(side === 'pre' ? cmpPreRecs : cmpPostRecs).length}회차`
  }
  const cmpChg = (c: LatCmpChange | null) =>
    c ? `<span style="font-weight:700;color:${c.kind === 'down' ? '#15803d' : c.kind === 'up' ? '#c21f1f' : '#6b7280'}">${c.text}</span>` : '<span class="mut">-</span>'
  // 포털 정상화(1차) 평균 — 리포트의 포털 복구 시간과 같은 값(runTotals.svc). 정상화가 없는 회차는 평균에서 뺀다
  const svcAvg = (hs: HistoryRecord[]) => {
    const xs = hs.map((h) => runTotals(h, inc.inject).svc).filter((v): v is number => v != null)
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null
  }
  const cmpSvc = () => {
    const a = svcAvg(cmpPreRecs)
    const b = svcAvg(cmpPostRecs)
    if (a == null || b == null) return null
    const pct = a > 0 ? Math.round((Math.abs(a - b) / a) * 100) : 0
    return { a, b, text: b <= a ? `${pct}% 짧아짐` : `${pct}% 길어짐`, better: b <= a }
  }
  /** 최소 ~ 최대(조치 전 → 후) 칸 — 위 줄 조치 전(흐리게), 아래 줄 조치 후. 한 줄로 두면 '7.96초 ~ 81.1초 → 1.74초 ~ 47.7초' 가 칸을 넘었다 */
  const CMP_RNG_TH = '<th class="c" style="width:150px">최소 ~ 최대<br>조치 전 → 후</th>'
  const cmpRng = (s: { min: number; max: number } | null) => (s ? `${fmtLat(s.min)} ~ ${fmtLat(s.max)}` : '-')
  const cmpRngCell = (r: { pre: { min: number; max: number } | null; post: { min: number; max: number } | null }) =>
    `<td class="num c" style="white-space:nowrap"><span class="mut">${cmpRng(r.pre)}</span><br>→ <b>${cmpRng(r.post)}</b></td>`
  const cmpSection = () => {
    if (!cmp) return ''
    const n = (k: LatCmpChange['kind']) => cmp.rows.filter((r) => r.change?.kind === k).length
    const sv = cmpSvc()
    const line =
      (sv ? `포털 정상화 평균 <b>${E(sv.a)}</b> → <b style="color:${sv.better ? '#15803d' : '#c21f1f'}">${E(sv.b)}</b> (${sv.text}) · ` : '') +
      `API ${cmp.rows.length}개 중 <span style="color:#15803d">${n('down')}개 감소</span>, <span style="color:#c21f1f">${n('up')}개 증가</span>, ${n('flat')}개 차이 근소함`
    let prev = ''
    const body = cmp.rows
      .map((r) => {
        const sep = r.screen !== prev ? `<tr class="sep"><td colspan="5">${latName(r.screen)}</td></tr>` : ''
        prev = r.screen
        return `${sep}<tr><td><b>${latName(r.name)}</b></td><td class="num c">${r.pre ? fmtLat(r.pre.avg) : '-'}</td><td class="num c"><b>${r.post ? fmtLat(r.post.avg) : '-'}</b></td><td class="c">${cmpChg(r.change)}</td>${cmpRngCell(r)}</tr>`
      })
      .join('')
    const no = (h: HistoryRecord) => `#${runs.indexOf(h) + 1}`
    const meds = (xs: (number | null)[] | undefined) => (xs ? xs.map((x) => (x == null ? '-' : fmtLat(x))).join(' · ') : '-')
    const runsTbl =
      `<table class="grid"><thead><tr><th>화면 · API</th><th class="c">조치 전 회차별 중앙값<br><span class="mut" style="font-weight:400">${cmpPreRecs.map(no).join(' · ')}</span></th><th class="c">조치 후 회차별 중앙값<br><span class="mut" style="font-weight:400">${cmpPostRecs.map(no).join(' · ')}</span></th></tr></thead><tbody>` +
      cmp.rows.map((r) => `<tr><td>${latName(r.name)}</td><td class="num c">${meds(r.pre?.meds)}</td><td class="num c">${meds(r.post?.meds)}</td></tr>`).join('') +
      '</tbody></table>'
    return (
      `<section class="sec"><div class="sh"><h2>조치 전 · 후 비교</h2><span class="d">${cmpHead('pre')} · ${cmpHead('post')} · 노드 DOWN 구간 · 정상 응답만</span></div>` +
      `<p style="margin:0 0 10px;font-size:13px">${line}</p>` +
      `<table class="grid"><thead><tr><th>화면 · API</th><th class="c" style="width:150px">${cmpHead('pre')}<br>중앙 평균</th><th class="c" style="width:150px">${cmpHead('post')}<br>중앙 평균</th><th class="c" style="width:100px">변화</th>${CMP_RNG_TH}</tr></thead><tbody>${body}</tbody></table>` +
      `<details class="run"${opts.openEvidence ? ' open' : ''} style="margin-top:8px"><summary><span class="rt">회차별 중앙값 보기</span></summary><div class="rb">${runsTbl}</div></details>` +
      `<div class="note">중앙 평균 = 회차마다 '보통 걸린 시간(중앙값)'의 평균. 최소 ~ 최대 = 그 묶음 요청 중 가장 빠른 · 느린 한 건. 변화가 0.2초 미만이면 '차이 근소함'.${
        cmp.streakOnly
          ? ' 고른 회차 중 11-19 전 회차는 노드 DOWN 중 화면이 정상화를 확정한 연속 요청만 남아 있어, 양쪽 모두 그 요청만으로 맞춰 비교했습니다(끊김 직후 가장 느렸던 때는 빠짐).'
          : ''
      }</div></section>`
    )
  }
  /**
   * 종합 결과 요약 — 중앙 평균이 가장 많이 줄어든 API 다섯(사용자 결정 11-25: 머리글 '조치 전 N회차 중앙 평균', 제목 '(핵심 변화)',
   * 변화 오른쪽에 조치 전 · 후 최소 ~ 최대). 아래 한 줄(포털 정상화 평균 · 늘어난 API 안내)은 뺐다 — 사용자: 굳이 필요 없는 문구
   */
  const cmpSummary = (no: string, lf?: string) => {
    if (!cmp) return ''
    // 상세(전체 API · 회차별 중앙값)로 가는 링크 — 같이 뽑은 '포털 API 응답 시간' 파일이 있을 때만(응답 지연 절의 '회차별 전체 표는 …' 과 같은 꼴)
    const more = lf ? `<div class="note">전체 API · 회차별 중앙값은 <a href="${fileHref(lf)}">포털 API 응답 시간 →</a></div>` : ''
    const top = latCmpTop(cmp)
    return (
      `<section class="sec"><div class="sh">${no ? `<span class="n">${no}</span>` : ''}<h2>포털 API 응답 조치 전 · 후 (핵심 변화)</h2><span class="d" style="font-size:10px">중앙 평균이 가장 많이 줄어든 API</span></div>` +
      (top.length
        ? `<table class="grid"><thead><tr><th>화면 · API</th><th class="c" style="width:130px">${cmpHead('pre')}<br>중앙 평균</th><th class="c" style="width:130px">${cmpHead('post')}<br>중앙 평균</th><th class="c" style="width:90px">변화</th>${CMP_RNG_TH}</tr></thead><tbody>${top
            .map(
              (r) =>
                `<tr><td>${latName(r.screen)} · <b>${latName(r.name)}</b></td><td class="num c">${fmtLat((r.pre as { avg: number }).avg)}</td><td class="num c"><b>${fmtLat((r.post as { avg: number }).avg)}</b></td><td class="c">${cmpChg(r.change)}</td>${cmpRngCell(r)}</tr>`,
            )
            .join('')}</tbody></table>`
        : '<p class="note" style="margin:0">중앙 평균이 줄어든 API 가 없습니다.</p>') +
      `${more}</section>`
    )
  }
  if (kind === 'latency') {
    H.push(cmpSection())
    H.push(
      // 요약에는 번호를 달지 않는다 — 아래 회차 절이 1 부터 회차 번호를 쓴다
      latSummary('', (i) => `href="#lat-${i + 1}"`, '') ||
        '<section class="sec"><p class="note" style="margin:0">고른 회차에 포털 응답 기록이 없습니다(포털 감시를 하지 않았거나, 노드 DOWN 중 정상화가 없었던 회차).</p></section>',
    )
    /*
     * 회차 이동 · 회차별 표(2026-11-19 사용자 요청): 이동 단추는 '#번호' 만(이름은 툴팁) · 차수마다 한 줄로 묶고, 위 응답 지연 다섯이 나온
     * 회차는 주황으로. 회차별 표는 기본 접힘(30회차를 펼쳐 두면 한참 내려야 했다) — 단추 · 요약표의 회차 링크를 누르면 그 회차가 펼쳐진다
     */
    const hot = new Set(latTop().map((x) => x.i))
    const phOf = (h: HistoryRecord) => (grp ? grp.phases.find((ph) => ph.id === h.phaseId)?.name ?? '차수 없음' : '')
    const chip = (i: number) =>
      `<a class="lchip${hot.has(i) ? ' hot' : ''}" href="#lat-${i + 1}" title="${he(nameOfRun(runs[i], i))}">#${i + 1}</a>`
    const lines: { ph: string; idx: number[] }[] = []
    runs.forEach((h, i) => {
      const ph = phOf(h)
      const last = lines[lines.length - 1]
      if (last && last.ph === ph) last.idx.push(i)
      else lines.push({ ph, idx: [i] })
    })
    H.push(
      `<section class="sec" style="padding:12px 18px"><div class="lnav">${lines
        .map((l) => `<div class="lrow">${l.ph ? `<span class="lph">${he(l.ph)}</span>` : ''}<span class="lchips">${l.idx.map(chip).join('')}</span></div>`)
        .join('')}</div>${hot.size ? '<div class="note" style="margin:6px 0 0"><span class="lchip hot" style="pointer-events:none">#</span> 위 응답 지연 다섯이 나온 회차</div>' : ''}</section>`,
    )
    H.push('<section class="sec"><div class="sh"><h2>회차별 응답 시간</h2><span class="d">회차를 누르면 펼쳐집니다</span></div>')
    runs.forEach((h, i) => {
      const lat = latOf(h)
      const dn = h.milestones.down?.at
      H.push(
        // PDF 는 접힌 칸이 인쇄되지 않아 펼쳐 둔다(다른 접힌 칸 · openEvidence 와 같은 기준)
        `<details class="run" id="lat-${i + 1}"${opts.openEvidence ? ' open' : ''}><summary><span class="rt">#${i + 1} ${he(nameOfRun(h, i))}</span><span class="pill">${he(h.node)}${
          dn != null ? ` DOWN · ${he(fmtDateTime(dn))}` : ` · ${he(fmtDateTime(h.t0))} 시작`
        }</span>${hot.has(i) ? '<span class="pill warn">응답 지연 상위</span>' : ''}${lat?.rows.length ? '' : '<span class="pill">기록 없음</span>'}</summary><div class="rb">${
          lat?.rows.length ? latTable(lat) : '<p class="note" style="margin:0">이 회차에는 포털 응답 기록이 없습니다.</p>'
        }</div></details>`,
      )
    })
    H.push('</section>')
    // 회차 링크(단추 · 요약표)를 누르거나 주소 뒤 #lat-n 으로 열면 그 회차를 펼친다(한 파일 리포트에서는 BUNDLE_CHILD 가 같은 일을 한다)
    H.push(
      `</div><script>document.querySelectorAll('a[href^="#lat-"]').forEach(function(a){a.addEventListener('click',function(){var d=document.getElementById(a.getAttribute('href').slice(1));if(d)d.open=true})});if(location.hash){var d=document.getElementById(location.hash.slice(1));if(d&&d.tagName==='DETAILS')d.open=true}</script></body></html>`,
    )
    return H.join('\n')
  }
  // 증적 원문의 왼쪽 목차가 들어갈 자리 — 회차를 그린 뒤에야 증적 목록을 알므로 끝에서 이 줄을 바꾼다(evidenceToc.ts)
  const pageIdx = H.length - 1
  let tocNav = ''
  /**
   * 세부 원인 및 조치 — '원인 : …' / '조치 : …' / '담당자 : …' 세 줄(2026-11-11 사용자 결정: 콜론 뒤 한 칸, 상태 라벨은 넣지 않는다).
   * 사람이 적은 글이라 IP · 토큰이 섞일 수 있어 내보내기 마스킹을 거친다(증적 원문과 같은 출구).
   */
  const noteLine = (k: string, v?: string) => (v?.trim() ? `<div class="ln"><b>${k} :</b><span>${he(maskForExport(v.trim()))}</span></div>` : '')
  // 원인(why)을 따로 적은 기록은 '이슈 : … / 원인 : …', 옛 기록(원인 칸 없음)은 예전대로 적은 글을 '원인 :' 으로(2026-11-19 사용자: 실패 원인 표는 지금 모양이 낫다)
  const noteHtml = (ns: RunNote[]) =>
    ns.map((n) => `<div class="nt">${n.why?.trim() ? noteLine('이슈', n.cause) + noteLine('원인', n.why) : noteLine('원인', n.cause)}${noteLine('조치', n.action)}${noteLine('담당자', n.owner)}</div>`).join('')
  const kpi = (cls: string, label: string, v: string, sub = '', extra = '') => `<div class="kpi ${cls}"><span>${label}</span><b>${v}</b>${sub ? `<small>${sub}</small>` : ''}${extra}</div>`
  /*
   * 회차 성공 셈(2026-11-10 사용자 요청 · 목업) — 종합 결과에 '몇 회 중 몇 회 성공' 이 없어, Masakari 카드의 '성공 7 / 8회' 만 튀어
   * 8회 중 7회가 성공한 것처럼 읽혔다(실제로는 포털 실패 포함 5 / 8). 회차의 성공 = 전체 복구 성공(svcFail 이 아님).
   * 항목마다: 성공 = 값이 있고 끝난 회차, 실패 = 그 항목이 끝나지 않은 회차. 일어나지 않은 회차('-')는 분모에서 뺀다.
   */
  const colFail = (key: string, i: number): boolean => {
    const ms = msOf(runs[i])
    // 바꾼 단계는 성공으로 센다(RunOverride 주석, 사용자 결정: Masakari 카드도 성공에 포함). 전체 복구는 svcFail 이 이미 바꾼 단계를 뺐다
    if (key === 'masa' && ovStep(runs[i], 'masakari')) return false
    if (key === 'svc' && ovStep(runs[i], 'portal')) return false
    if (key === 'all') return svcFail[i]
    if (key === 'svc') return tot[i].svcPending.length > 0
    if (key === 'masa') return masaWatchedOf(ms) && !masaDoneOf(ms)
    if (key === 'pods') return podsDoneSummary(ms).pending > 0
    return false
  }
  const colCount = (key: string): { ok: number; n: number } | null => {
    const c = ci(key)
    if (c < 0) return null
    let ok = 0
    let n = 0
    runs.forEach((h, i) => {
      if ((key === 'masa' && ovM(h)) || (key === 'svc' && ovP(h)) || (key === 'all' && ovIn(h) && !svcFail[i])) {
        ok++
        n++
        return
      }
      if (colFail(key, i)) n++
      else if (vals[c][i] != null && !isPartial(c, i)) {
        ok++
        n++
      }
    })
    return n ? { ok, n } : null
  }
  /** 카드 아래 '성공 n / m' 막대 */
  // 성공 막대는 카드 바닥에 붙인다(.kpi 세로 flex + .sr margin-top:auto) — 카드마다 위 글 줄 수가 달라 막대 높이가 들쑥날쑥했다(2026-11-11 사용자 지적)
  const okBar = (st: { ok: number; n: number } | null) =>
    st ? `<div class="sr"><span class="sb"><i style="width:${((st.ok / st.n) * 100).toFixed(1)}%"></i></span>성공 ${st.ok} / ${st.n}</div>` : ''
  const okCls = (st: { ok: number; n: number } | null) => (!st ? '' : st.ok === st.n ? 'ok' : 'bad')
  /*
   * 회차 결과 — 전체 복구 열의 '성공' 셈(colCount('all'))과 같은 기준(코드 리뷰 11-11: 검증 결과 카드는 7/8, 전체 복구 카드는 6/7 처럼
   * 같은 회차를 다르게 셌다). 실패 = 끝나지 않은 것이 있다(svcFail). 성공 = 전체 복구 값이 있고 끝난 값. 그 밖(잴 것이 없었던 회차 ·
   * Nova 를 못 읽어 VM 이 다 옮겨졌는지 모름)은 '판정 못 함' 으로 성공에 넣지 않는다 — 조회 실패를 성공으로 세지 않는다.
   */
  const runVerdict = (i: number): 'ok' | 'fail' | 'none' => {
    if (svcFail[i]) return 'fail'
    // 바꾼 단계 말고는 실패가 없는 회차는 성공(전체 복구 값은 '-' 라 아래 셈으로는 '판정 못 함' 이 된다)
    if (ovIn(runs[i])) return 'ok'
    const ca = ci('all')
    return ca >= 0 && vals[ca][i] != null && !isPartial(ca, i) ? 'ok' : 'none'
  }
  const failRunIdx = runs.map((_h, i) => i).filter((i) => runVerdict(i) === 'fail')
  const okRunN = runs.filter((_h, i) => runVerdict(i) === 'ok').length
  const noneRunN = runs.length - okRunN - failRunIdx.length
  /**
   * Masakari 카드 — 성공 / 실패를 말한다(사용자 지적 10-27). 예전엔 '실패 VM 0대 / evacuation 실패 없음' 이라 VM 10대를 옮기며 성공한
   * 회차도 실패 숫자로 읽혔다. 한 회차: 성공 · 실패 · 미완료 · '-'(동작 없음). 여러 회차: '성공 4 / 5회'(목표 합격 카드와 같은 꼴).
   * Masakari 가 움직이지 않은 회차(감시 안 함 · VIP 만 있는 노드)는 분모에서 뺀다.
   */
  const masaOutcome = (ms: Milestones): 'ok' | 'part' | 'fail' | 'open' | 'none' =>
    ms.masakari
      ? masaPartOf(ms)
        ? 'part'
        : 'ok'
      : masaFailedRun(ms)
        ? 'fail'
        : (ms.masakariFail ?? []).length
          ? 'open'
          : 'none'
  const masaKpi = () => {
    // Masakari 를 성공으로 바꾼 회차(RunOverride 주석)
    const oc = runs.map((h) => (ovM(h) ? 'ok' : masaOutcome(msOf(h))))
    if (one) {
      const ms = msOf(runs[0])
      const fails = [...(ms.masakariFail ?? [])].sort((a, b) => a.at - b.at)
      const lastF = fails[fails.length - 1]
      const moved = ms.masakari ? (ms.masakari.vms?.count ?? ms.masakari.evac) : 0
      const dur = ci('masa') >= 0 ? vals[ci('masa')][0] : null
      switch (oc[0]) {
        case 'ok':
          return kpi('ok', 'Masakari evacuation', '성공', [moved ? `VM ${moved}대 이동` : '', dur != null ? E(dur) : '', fails.length ? '재시도로 완료' : ''].filter(Boolean).join(' · '))
        case 'part':
          // 한 대라도 못 옮기면 실패(사용자 결정 10-30)
          return kpi('bad', 'Masakari evacuation', '실패', he(masaFailText(ms)))
        case 'fail':
          return kpi('bad', 'Masakari evacuation', '실패', he(lastF?.brief ?? lastF?.reason ?? 'status: failed'))
        case 'open':
          return kpi('warn', 'Masakari evacuation', '미완료', '마지막 상태: 1차 시도 실패 (결과 전에 검증 종료)')
        default:
          return kpi('', 'Masakari evacuation', '-', 'Masakari 동작 없음')
      }
    }
    const judged = oc.filter((o) => o !== 'none').length
    if (!judged) return kpi('', 'Masakari evacuation', '-', 'Masakari 동작 없음')
    const okN = oc.filter((o) => o === 'ok').length
    const bad = runs.filter((_h, i) => oc[i] === 'fail' || oc[i] === 'part')
    const open = oc.filter((o) => o === 'open').length
    const moved = runs.reduce((a, h) => a + (h.milestones.masakari ? (h.milestones.masakari.vms?.count ?? h.milestones.masakari.evac) : 0), 0)
    // 여러 회차: 다른 카드와 같은 꼴(평균 크게 · 최소 최대 · 성공 막대). 예전엔 '성공 7 / 8회' 를 크게 써서 이 카드만 튀었다(colCount 주석)
    void okN
    void moved
    return kpi(
      okCls(colCount('masa')) || (bad.length || open ? 'bad' : 'ok'),
      'Masakari evacuation',
      sMasa ? `평균 ${E(sMasa.avg)}` : '-',
      sMasa ? rangeOf(sMasa) : '',
      // 실패는 둘째 줄에 '실패 n회: #4'(2026-11-11 사용자 지적: 최소 · 최대 뒤에 이어 붙여 이 카드만 줄이 꺾였다). 검증 결과 카드와 같은 꼴
      `${bad.length || open ? `<small>${[bad.length ? `실패 ${bad.length}회: ${bad.map(runLink).join(' ')}` : '', open ? `미완료 ${open}회` : ''].filter(Boolean).join(' · ')}</small>` : ''}${
      // 막대는 표의 '성공' 줄과 같은 셈(colCount) — 감시했는데 Masakari 가 움직이지 않은 회차도 실패로 센다(회차 결과 svcFail 과 같은 기준).
      // 예전엔 judged(동작이 있었던 회차)만 세어, 22회차 리포트에서 카드 11/14 · 표 11/17 로 같은 항목이 다른 숫자였다(기능 점검 11-11)
      okBar(colCount('masa'))}`,
    )
  }
  // 주요 수치 ~ ③ 복구 흐름은 종합 결과(와 예전 한 파일)에만 — 나머지 종류는 아래에서 이 자리부터 잘라 낸다
  const topStart = H.length
  const kpiCards =
    // 카드 순서는 일이 일어나는 차례(2026-11-10 사용자 요청): 총 회차 → VIP 이동 → Masakari evacuation → 포털 1차 정상화 → 전체 복구
    // 결론 카드(검증 결과 · 전체 복구)는 lead — 옅은 남색 바탕으로 가운데 단계 카드와 가른다(2026-11-11 사용자 결정 · 시안 A). 상태는 윗줄 색이 그대로 맡는다
    `<div class="kpis">${
      // 맨 앞은 회차 결과(colCount 주석). 전체 복구를 잴 수 없는 리포트(Masakari · 포털 둘 다 뺌)는 예전처럼 회차 수
      allLabel
        ? one
          ? kpi(
              `lead ${{ ok: 'ok', fail: 'bad', none: '' }[runVerdict(0)]}`,
              '검증 결과',
              { ok: '성공', fail: '실패', none: '-' }[runVerdict(0)],
              runVerdict(0) === 'none' ? '판정 못 함(잴 것이 없었거나 VM 이동을 확인하지 못함)' : `대상 노드 ${he(runs[0].node)}`,
            )
          : kpi(
              failRunIdx.length ? 'lead bad' : 'lead ok',
              '검증 결과',
              `성공 ${okRunN} / ${okRunN + failRunIdx.length}회`,
              [failRunIdx.length ? `실패 ${failRunIdx.length}회: ${failRunIdx.map((i) => runLink(runs[i])).join(' ')}` : '모두 성공', noneRunN ? `판정 못 함 ${noneRunN}회` : '']
                .filter(Boolean)
                .join(' · '),
              `<small>대상 노드 ${nodes.length}개${unknownRuns ? ` · 미확인 ${unknownRuns}회차` : ''}</small>${okBar(okRunN + failRunIdx.length ? { ok: okRunN, n: okRunN + failRunIdx.length } : null)}`,
            )
        : kpi('', one ? '회차' : '총 회차', String(runs.length), `대상 노드 ${nodes.length}개${unknownRuns ? ` · 미확인 ${unknownRuns}회차` : ''}`)
    }${
      rtoOn
        ? kpi(
            verdicts.includes('fail') ? 'bad' : 'ok',
            '목표 합격',
            `${verdicts.filter((v) => v === 'pass').length} / ${verdicts.filter((v) => v !== 'none').length}회`,
            '목표 기준 On',
          )
        : inc.hostVip
          ? one
            ? kpi('', 'VIP 이동', E(sVip?.avg), sVip ? '장애 시작 후' : 'VIP 이동 없음')
            : kpi(okCls(colCount('vip')), 'VIP 이동', sVip ? `평균 ${E(sVip.avg)}` : '-', sVip ? rangeOf(sVip) : 'VIP 이동 없음', okBar(colCount('vip')))
          : ''
    }${inc.masakari ? masaKpi() : ''}${
      inc.portal
        ? kpi(
            one ? (pendingRuns.length ? 'bad' : 'ok') : okCls(colCount('svc')),
            '포털 1차 정상화',
            pendingRuns.length && one ? '실패' : one ? E(sSvc?.avg) : sSvc ? `평균 ${E(sSvc.avg)}` : '-',
            one
              ? pendingRuns.length
                ? `화면 ${tot[0].svcPending.length}개 안 돌아옴`
                : sSvc
                  ? '장애 시작 후 처음 모두 정상'
                  : '포털 감시 없음'
              : sSvc
                ? rangeOf(sSvc)
                : '포털 감시 없음',
            one ? '' : okBar(colCount('svc')),
          )
        : ''
    }${
      allLabel
        ? kpi(
            `lead ${one ? (svcFailRuns.length ? 'bad' : '') : okCls(colCount('all'))}`,
            allLabel,
            one && !sAll ? (svcFailRuns.length ? '실패' : '-') : one ? E(sAll?.avg) : sAll ? `평균 ${E(sAll.avg)}` : '-',
            one
              ? sAll
                ? allBasis
                : svcFailRuns.length
                  ? manualFailOf(runs[0]) && !(inc.masakari && masaWatchedOf(msOf(runs[0])) && !masaDoneOf(msOf(runs[0]))) && !tot[0].svcPending.length
                    ? '자동으로 복구되지 않아 수동 조치 후 복구'
                    : 'Masakari · 포털이 다 끝나지 않음'
                  : ovIn(runs[0]) && !svcFail[0]
                    ? ''
                    : '잴 것 없음(Masakari 동작 · 포털 끊김 없음)'
              : sAll
                ? rangeOf(sAll)
                : '',
            one ? '' : okBar(colCount('all')),
          )
        : ''
    }</div>`
  /*
   * 여러 회차의 주요 수치는 카드 5개 대신 요약 표 하나(2026-11-12 사용자 결정 · 목업 kpi-alt 시안 B → mock-b-total).
   * 카드는 제목 · 평균 · 범위 · 실패 회차 · 막대가 같은 크기로 흩어져 읽을 곳이 분명하지 않았고, 폭이 좁으면 3줄로 꺾였다.
   * 단계를 행으로, 성공 · 평균 · 최소 · 최대 · 실패 회차를 열로 두어 숫자가 세로로 줄을 맞춘다. 셈은 카드와 같은 colCount · stat.
   * 머리 줄은 '총 n회 중 m회 성공' 만(실패 회차는 아래 전체 복구 행과 겹쳐 뺐다) · 성공은 초록 · 글씨는 표 평균과 같은 크기(혼자 튀지 않게).
   * 한 회차 리포트는 최소 = 최대 = 평균이라 표가 의미 없어 카드를 그대로 쓴다.
   */
  const stepSummary = () => {
    const rows = [
      inc.hostVip ? { key: 'vip', label: 'VIP 이동', st: sVip } : null,
      inc.masakari ? { key: 'masa', label: 'Masakari evacuation', st: sMasa } : null,
      inc.portal ? { key: 'svc', label: '포털 1차 정상화', st: sSvc } : null,
      allLabel ? { key: 'all', label: allLabel, st: sAll } : null,
    ].filter((r): r is { key: string; label: string; st: typeof sAll } => !!r)
    const tr = rows
      .map((r) => {
        const cnt = colCount(r.key)
        const fails = ci(r.key) >= 0 ? runs.map((_h, i) => i).filter((i) => colFail(r.key, i)) : []
        const okTd = cnt
          ? `<span class="sb"><i style="width:${((cnt.ok / cnt.n) * 100).toFixed(1)}%"></i></span><b class="${cnt.ok === cnt.n ? 'g' : 'r'}">${cnt.ok}</b> / ${cnt.n}`
          : '<span class="nv">-</span>'
        return `<tr${r.key === 'all' ? ' class="tot"' : ''}><td class="l nm">${he(r.label)}</td><td class="l sr2">${okTd}</td><td class="avg">${r.st ? E(r.st.avg) : '-'}</td><td>${r.st ? E(r.st.min) : '-'}</td><td>${r.st ? E(r.st.max) : '-'}</td><td class="l fr">${
          fails.length ? fails.map((i) => runLink(runs[i])).join(' ') : '<span class="nv">-</span>'
        }</td></tr>`
      })
      .join('')
    const verdict = allLabel
      ? `총 ${runs.length}회 중 <b>${okRunN}회 성공</b>${noneRunN ? ` · 판정 못 함 ${noneRunN}회` : ''}`
      : `총 ${runs.length}회`
    const goal = rtoOn ? ` · 목표 합격 ${verdicts.filter((v) => v === 'pass').length} / ${verdicts.filter((v) => v !== 'none').length}회` : ''
    return `<div class="ksum"><div class="kh"><span class="kt">검증 결과</span><span class="kn">${verdict}${goal}</span><span class="km">대상 노드 ${nodes.length}개${
      unknownRuns ? ` · 미확인 ${unknownRuns}회차` : ''
    }${rows.length ? ' · 시간은 성공한 회차만' : ''}</span></div>${
      rows.length
        ? `<table class="ks"><thead><tr><th class="l" style="width:22%">단계</th><th class="l" style="width:22%">성공</th><th>평균</th><th>최소</th><th>최대</th><th class="l" style="width:18%">실패 회차</th></tr></thead><tbody>${tr}</tbody></table>`
        : ''
    }</div>`
  }
  /**
   * 그룹 리포트 앞 절 셋(2026-11-13 사용자 결정 · 목업 group-mock2 · 6): ① 검증 환경 → ② 시나리오 흐름 → ③ 차수별 요약.
   *  - 환경: 노드 카드(표준 이름 + 실제 호스트 + 역할) · VM 칩(파랑 k8s · 초록 웹 서비스 · 회색 기타, 노란 테두리 = evacuation 대상).
   *    VM 이름은 기본 표준 이름, 리포트 만들기 창에서 '실제 이름' 을 고르면 적어 둔 실제 이름(안내 문구 속 표준 이름도 같이 바뀐다)
   *  - 흐름: 단계 이름만 상자로 잇고, 단계마다 내용 · 완료 기준은 아래 표(상자 안 설명은 표와 겹쳐 뺐다). 평균 시간은 넣지 않는다
   *  - 차수별 요약: 건수 · 성공 평균은 앱이 세고, 이슈 → 팀별 조치는 그룹 편집 창에서 사람이 적은 것. 이 리포트에 든 회차의 차수만
   * 그룹 · 환경이 없으면 해당 절을 싣지 않는다(빈 카드를 내보내지 않는다).
   */
  // 이슈 · 조치 글은 입력한 줄바꿈을 그대로 살린다(white-space:pre-line, 2026-11-14 사용자 요청: 툴에서 Enter 로 나눠 적어도 리포트에서 한 줄로 이어졌다)
  function groupSections(): string {
    if (!grp) return ''
    const out: string[] = []
    /*
     * 차수마다 환경이 다를 수 있다(2026-11-16 사용자 결정 · 목업 env-flex-mock ③). 고른 회차의 차수 환경을 같은 것끼리 묶어
     *  - 하나면 예전과 같은 한 장(차수 환경이 없는 그룹은 예전 출력 그대로)
     *  - 여럿이면 차수 묶음마다 한 장씩: HTML 은 탭(스크립트가 꺼져 있으면 모두 차례로 보인다), PDF 는 모두 차례로 펼친다.
     *    그룹 기본과 다른 묶음 아래에 '바뀐 점' 을 자동으로 적는다(lib/groupEnvDiff, 메모는 비교하지 않는다)
     */
    const envTabs = groupEnvTabs(grp, runs).filter((t) => t.env && t.env.nodes.length)
    const env = envTabs.length === 1 ? envTabs[0].env : envTabs.length ? envTabs[0].env : grp.env
    const real = !!opts.realNames
    // 검증 결과 표(GroupResult 주석) — 검증 환경 앞. 사람이 적은 글은 내보내기 마스킹을 거친다
    const res = grp.result
    if (res && (res.verdict || [res.purpose, res.owner, res.summary, res.note].some((x) => x?.trim()))) {
      /*
       * 툴에서 적은 줄을 그대로(2026-11-19 사용자 요청): 빈 줄은 빈 줄로 남기고(예전엔 버려 묶음 사이 간격이 사라졌다), 줄 앞 공백도 살린다
       * ('  > HAProxy …' 처럼 들여 쓴 줄이 왼쪽으로 붙었다). '-' 로 시작한 줄은 위 줄 아래로 들여 쓴다. 앞뒤 빈 줄만 버린다
       */
      const txt = (v: string) => {
        const ls = v.split(/\r?\n/).map((l) => l.trimEnd())
        while (ls.length && !ls[0].trim()) ls.shift()
        while (ls.length && !ls[ls.length - 1].trim()) ls.pop()
        return ls
          .map((l) => {
            if (!l.trim()) return '<span class="rs0"></span>'
            /*
             * 들여쓰기는 적은 공백 수대로(2026-11-19 사용자 지적: ' - 라이프싸이클팀' 아래 '  > 파드 분산…' 이 '-' 보다 왼쪽에 나왔다 —
             * '-' 줄만 고정 폭으로 들이고 다른 줄은 공백 그대로라 깊이가 뒤집혔다). 공백 하나 = 0.6em(탭 = 4칸)으로 같은 잣대에 둔다.
             * 공백 없이 '-' 로 시작한 줄은 예전처럼 한 단계(공백 하나만큼) 들인다
             */
            const lead = (/^[ \t]*/.exec(l)?.[0] ?? '').replace(/\t/g, '    ').length
            const body = l.trimStart()
            const lv = lead || (/^[-–]/.test(body) ? 1 : 0)
            return `<span class="rs1"${lv ? ` style="padding-left:${(lv * 0.6).toFixed(1)}em"` : ''}>${he(maskForExport(body))}</span>`
          })
          .join('')
      }
      const rows: [string, string | undefined][] = [
        ['검증 대상', res.target?.trim() || grp.name],
        ['검증 기간', res.period?.trim() || runsPeriodLine(runs)],
        ['검증 목적', res.purpose],
        ['검증 담당자', res.owner],
        ['검증 환경', res.env?.trim() || groupEnvLine(env)],
        // 검증 결과 이름표 — 글이 아니라 표시라 아래에서 따로 그린다(자리만 둔다)
        ['검증 결과', res.verdict ? '\u0000' : ''],
        // 실패 사유 — FAIL 일 때만(PASS 면 적어 둔 글이 있어도 싣지 않는다)
        ['실패 사유', res.verdict === 'fail' ? res.failReason : ''],
        // 이름(2026-11-19 사용자 결정): '종합 검증 결과' → '주요 이슈 및 조치내역'. 저장 칸 이름(summary)은 그대로
        ['주요 이슈 및 조치내역', res.summary],
        // 이름은 '참고사항'(2026-11-20 사용자 결정, 비고 → 특이사항 → 참고사항) — 저장 칸 이름(note)은 그대로
        ['참고사항', res.note],
      ]
      out.push(
        `<section class="sec"><div class="sh"><span class="n">${sno()}</span><h2>검증 결과</h2></div><table class="rkv"><tbody>${rows
          .filter(([, v]) => v?.trim())
          .map(([k, v]) =>
            v === '\u0000'
              ? `<tr><th>${k}</th><td><span class="rvd ${res.verdict}">${res.verdict === 'ok' ? 'PASS' : 'FAIL'}</span></td></tr>`
              : `<tr><th>${k}</th><td>${txt(v as string)}</td></tr>`,
          )
          .join('')}</tbody></table></section>`,
      )
    }
    const envBody = (e: GroupEnv) => {
      const allVms = e.nodes.flatMap((n) => n.vms)
      const cnt = (f: (v: EnvVm) => boolean) => allVms.filter(f).reduce((a, v) => a + vmCount(v), 0)
      const chip = (v: EnvVm) => {
        const nm = vmDisplay(v, real)
        const many = vmCount(v) > 1
        // 실제 이름이 이어지지 않아 나열로 바뀐 묶음은 칩 하나에 몰지 않고 '이름 (n대)' 에 마우스를 올려 보게 한다
        const long = many && nm.includes(', ')
        return `<span class="vchip v${v.kind}${v.evac ? ' vev' : ''}"${long ? ` title="${he(nm)}"` : ''}>${he(long ? v.name : nm)}${many ? ` <b>(${vmCount(v)}대)</b>` : ''}</span>`
      }
      // 안내 문구 속 표준 이름 → 실제 이름(실제 이름 리포트일 때만). 긴 이름부터 바꿔 'web01' 이 'web01~10' 안에서 먼저 바뀌지 않게
      const swap = (t: string) =>
        real
          ? allVms
              .filter((v) => (v.real ?? []).length)
              .sort((a, b) => b.name.length - a.name.length)
              .reduce((acc, v) => acc.split(v.name).join(vmDisplay(v, true)), t)
          : t
      // 2026-11-14 사용자 요청: 요약 줄의 'evacuation 대상 VM n' 은 뺐다(노란 테두리 범례로 충분하다).
      // 아래 안내(envnote)는 웹 서비스 VM 배치처럼 꼭 읽어야 하는 말이라 굵게 · 노란 띠로 눈에 띄게 했다
      return [
        `<div class="envsum"><span>물리 노드<b>${e.nodes.length}</b></span><span>k8s VM<b>${cnt((v) => v.kind === 'k8s')}</b></span><span>웹 서비스 VM<b>${cnt((v) => v.kind === 'web')}</b></span><span class="lgd"><span class="vchip vk8s">k8s VM</span><span class="vchip vweb">웹 서비스 VM</span><span class="vchip vetc vev">노란 테두리 = evacuation 대상</span></span></div>`,
        `<div class="nodes">${e.nodes
          .map(
            (n) =>
              `<div class="nd"><div class="ntop"><div class="nt"><b>${he(n.label)}</b>${n.controller ? '<span class="nrole ctl">컨트롤러</span>' : ''}${n.compute ? '<span class="nrole cpt">컴퓨트</span>' : ''}</div><div class="nh">${he(n.host || '-')}</div></div><div class="nbd">${
                n.vms.length ? n.vms.map(chip).join('') : '<span class="nnone">배치 VM 없음</span>'
              }</div></div>`,
          )
          .join('')}</div>`,
        e.notes.length ? `<ul class="envnote">${e.notes.map((t) => `<li>* ${he(maskForExport(swap(t)))}</li>`).join('')}</ul>` : '',
      ]
    }
    const envHead = (inj: string) =>
      `<section class="sec"><div class="sh"><span class="n">${sno()}</span><h2>검증 환경</h2>${inj || opts.envFile ? `<span class="d">${inj ? `장애 주입: ${he(inj)}` : ''}${opts.envFile ? `${inj ? ' · ' : ''}<a href="${he(encodeURIComponent(opts.envFile))}" style="color:#1d5fd0;font-weight:700">상세 환경 구성도 →</a>` : ''}</span>` : ''}</div>`
    if (envTabs.length > 1) {
      const injs = new Set(envTabs.map((t) => (t.env as GroupEnv).inject.trim()))
      const pdfOut = !!opts.openEvidence
      const label = (t: EnvTab) => `${he(t.label)} (${t.runs}회)`
      const changeLine = (t: EnvTab) => {
        const ch = t.base ? [] : envChanges(grp.env, t.env)
        return ch.length ? `<div class="envchg"><b>${he(t.label)}에서 바뀐 점</b> · ${ch.map((x) => he(x)).join(' · ')}</div>` : ''
      }
      out.push(envHead(injs.size === 1 ? [...injs][0] : ''))
      if (!pdfOut)
        out.push(
          `<div class="envtabs">${envTabs.map((t, i) => `<button type="button" data-envtab="${i}"${i === 0 ? ' class="on"' : ''}>${label(t)}</button>`).join('')}</div>`,
        )
      envTabs.forEach((t, i) => {
        const e = t.env as GroupEnv
        out.push(
          `<div class="envblk" data-envblk="${i}">`,
          pdfOut ? `<div class="envph">${label(t)}${injs.size > 1 && e.inject ? ` · 장애 주입: ${he(e.inject)}` : ''}</div>` : injs.size > 1 && e.inject ? `<div class="envph">장애 주입: ${he(e.inject)}</div>` : '',
          ...envBody(e),
          changeLine(t),
          `</div>`,
        )
      })
      // 탭 — 스크립트가 돌 때만 첫 묶음만 남기고 숨긴다(꺼져 있으면 모두 차례로 보인다)
      if (!pdfOut)
        out.push(
          `<script>(function(){var b=document.querySelectorAll('[data-envtab]'),k=document.querySelectorAll('[data-envblk]');function s(n){for(var i=0;i<k.length;i++)k[i].style.display=String(i)===n?'':'none';for(var j=0;j<b.length;j++)b[j].className=b[j].getAttribute('data-envtab')===n?'on':''}for(var j=0;j<b.length;j++)b[j].onclick=function(){s(this.getAttribute('data-envtab'))};s('0')})()</script>`,
        )
      out.push(`</section>`)
    } else if (env && env.nodes.length) {
      out.push(envHead(env.inject), ...envBody(env), `</section>`)
    } else if (opts.envFile) {
      // 환경 탭을 비워 둔 그룹 — 검증 환경 카드는 없지만 같이 뽑은 구성도로 가는 길은 남긴다(검토 지적: 파일은 생기는데 링크가 없었다)
      out.push(
        `<section class="sec"><div class="sh"><span class="n">${sno()}</span><h2>검증 환경</h2><span class="d"><a href="${he(encodeURIComponent(opts.envFile))}" style="color:#1d5fd0;font-weight:700">상세 환경 구성도 →</a></span></div></section>`,
      )
    }
    // ② 시나리오 흐름 — 리포트에 넣은 항목대로. 포털 화면 이름은 이 리포트 회차들이 감시한 화면(버전마다 달라서 고정 문구로 두지 않는다)
    /*
     * 화면 이름은 **가장 최근 회차 한 곳**에서 읽는다(2026-11-16 사용자 지적: '인스턴스 모니터링(CPU)' · '인스턴스 모니터링' 이 둘 다 나왔다).
     * 감시 설정이 회차 사이에 바뀌어(10-28 은 API 이름 + 화면 group, 11-09 부터 화면 이름 하나) 회차를 모두 합치면 같은 화면이 다른 이름으로
     * 겹친다. 판정 단위인 화면(group, 없으면 이름: lib/portal screenOf 와 같은 규칙)으로 세고, 마지막 설정이 지금 보는 화면이다
     */
    // 포털 기록은 정상이 된 화면만 남아 실패 회차는 화면이 모자라다 — 화면이 가장 많이 남은 회차 중 가장 최근 것
    const scrOf = (h: HistoryRecord) => Array.from(new Set((msOf(h).portal ?? []).map((pm) => (pm.group ?? '').trim() || pm.name)))
    const screens = [...runs]
      .sort((a, b) => b.t0 - a.t0)
      .map(scrOf)
      .reduce<string[]>((best, x) => (x.length > best.length ? x : best), [])
      // 기록 순서는 정상이 된 순서라 회차마다 뒤섞인다. 사람이 화면을 여는 순서(로그인 → 대시보드 → 목록 → 상세 · 모니터링)로 놓고, 모르는 이름은 뒤에
      .map((nm, k) => ({ nm, r: [/로그인/, /대시보드/, /목록/, /상세|모니터링/].findIndex((re) => re.test(nm)), k }))
      .sort((x, y) => (x.r < 0 ? 99 : x.r) - (y.r < 0 ? 99 : y.r) || x.k - y.k)
      .map((x) => x.nm)
      .slice(0, 8)
    // 내용 칸은 모두 '~ 확인' 으로 끝낸다(2026-11-14 사용자 요청: 각 단계에서 무엇을 확인하는지 읽히게).
    // 장애 주입은 예전 기본값 'IPMI 포털 Power Down' 으로 저장된 그룹도 '접속 후' 가 들어간 새 기본값 문장으로 싣는다
    const inject = env?.inject ? (env.inject.trim() === 'IPMI 포털 Power Down' ? 'IPMI 포털 접속 후 Power Down' : env.inject.trim()) : ''
    // 포털 정상의 연속 성공 횟수 — 회차 기록(정상화 확정 streak · 판정 기록 n)에서 읽고, 기록이 없으면 사용자가 정한 10회로 적는다
    // (2026-11-16 사용자 요청: 완료 기준을 '주요 API n회 연속 200 OK' 로 명확히. 실제 설정과 다른 숫자를 쓰지 않으려고 기록값을 먼저 쓴다)
    const portalN = Math.max(0, ...runs.flatMap((h) => [...(msOf(h).portal ?? []).map((p) => p.streak ?? 0), ...(msOf(h).portalLog ?? []).map((e) => e.n ?? 0)])) || 10
    /*
     * 완료 기준 = 이 구간을 보는 목적(굵게 한 줄) + 언제 완료로 치는지(2026-11-16 사용자 결정 문구). 줄 나눔이 필요한 기준은 HTML 로 둔다.
     * 포털의 '주요 n개 화면' 은 이 리포트 회차들이 감시한 화면 수(버전마다 달라 고정 숫자로 두지 않는다)
     */
    const goal = (g: string, rule: string) => `<div class="sgo">${he(g)}</div><div class="srl">${rule}</div>`
    const nScreens = screens.length
    const steps: { name: string; cls: string; body: string; done: string }[] = [
      { name: '노드 DOWN', cls: 'sinj', body: `장애 대상 노드를 ${inject ? `${he(inject)} 진행` : '강제 종료'} 확인`, done: goal('장애 시작 시각 확정', 'IPMI 이벤트 로그의 Power Down 시각') },
      ...(inc.hostVip
        ? [{ name: 'VIP 이동', cls: '', body: '장애 대상 노드에 vIP 를 위치시킨 뒤 DOWN, 다른 컨트롤러 노드로 vIP 이동 확인', done: goal('API 진입점 전환', '다른 컨트롤러 노드에서 VIP 가 올라온 시각') }]
        : []),
      // Masakari 완료 기준은 '이동' 만이 아니라 이동한 VM 이 제 일을 하는지까지(2026-11-16 사용자 요청: deploy · backup 은 기능, 웹 서비스는 응답)
      ...(inc.masakari
        ? [
            {
              name: 'Masakari evacuation',
              cls: '',
              body: '장애 대상 노드에 있던 evacuation 대상 VM 이 다른 노드로 정상 이동되었는지 확인',
              // deploy · backup 과 웹 VM 기준은 줄을 나눠 따로 읽히게(사용자 요청)
              done: goal(
                'VM 서비스 연속성',
                '대상 VM 이 모두 다른 노드에서 정상 동작한 시각<div class="sli">· deploy · backup VM: 기능 정상(예: 백업)</div><div class="sli">· 웹 VM: 응답 정상</div><div class="sfl">1대라도 안 되면 실패</div>',
              ),
            },
          ]
        : []),
      ...(inc.portal
        ? [{ name: '포털 1차 정상화', cls: '', body: `주요 화면${screens.length ? `(${he(screens.join(', '))})` : ''} 정상 응답 확인`, done: goal('포털 정상화 시간', `주요 ${nScreens ? `${nScreens}개 ` : ''}화면이 처음으로 모두 함께 정상이 된 시각. 화면마다 핵심 API 가 ${portalN}회 연속 200 OK 시 정상 판정`) }]
        : []),
    ]
    const circ = (k: number) => '①②③④⑤⑥⑦⑧'[k] ?? `${k + 1}.`
    const last = steps.length
    const flowBoxes = [
      ...steps.map((st, k) => `<div class="sst${st.cls ? ` ${st.cls}` : ''}">${circ(k)} ${he(st.name)}</div>`),
      ...(allLabel ? [`<div class="sst sfin">${he(allLabel)}</div>`] : []),
      `<div class="sst sref">${circ(last)} 노드 UP</div>`,
    ]
    const ends = [inc.masakari && steps.findIndex((x) => x.name === 'Masakari evacuation'), inc.portal && steps.findIndex((x) => x.name === '포털 1차 정상화')].filter((x): x is number => typeof x === 'number' && x >= 0)
    out.push(
      `<section class="sec"><div class="sh"><span class="n">${sno()}</span><h2>시나리오 흐름</h2></div>`,
      `<div class="sflow">${flowBoxes.join('<div class="sar">›</div>')}</div>`,
      `<table class="sf"><colgroup><col style="width:170px"><col style="width:36%"><col></colgroup><thead><tr><th>단계</th><th>내용</th><th>완료 기준</th></tr></thead><tbody>`,
      ...steps.map((st, k) => `<tr><td class="snm">${circ(k)} ${he(st.name)}</td><td>${st.body}</td><td>${st.done}</td></tr>`),
      allLabel
        ? `<tr class="sfin"><td class="snm">${he(allLabel)}</td><td>${
            ends.length > 1 ? `${circ(ends[0])} ${he(steps[ends[0]].name)} 과 ${circ(ends[1])} ${he(steps[ends[1]].name)} 중 늦게 복구된 시각 확인` : ends.length ? `${circ(ends[0])} ${he(steps[ends[0]].name)} 완료 시각 확인` : '-'
          }${
            // 복구 뒤 노드 DOWN 상태 그대로 서비스가 쓸 만한지 사람이 확인하는 것(2026-11-19 사용자 요청) — 시간에는 넣지 않는 확인 항목
            ends.length ? '<div class="sli">· 노드 DOWN 상태에서 인스턴스 신규 생성 후 모니터링 · 제어(마이그레이션 등) 정상 동작 확인</div>' : ''
          }</td><td>${goal(
            '전체 복구 시간',
            ends.length > 1
              ? `① 노드 DOWN 부터 ${circ(ends[0])} · ${circ(ends[1])} 중 마지막으로 복구된 시각까지 걸린 시간<div class="sfl">하나라도 안 끝나면 실패</div>`
              : ends.length
                ? `① 노드 DOWN 부터 ${circ(ends[0])} 완료 시각까지 걸린 시간<div class="sfl">안 끝나면 실패</div>`
                : '-',
          )}</td></tr>`
        : '',
      `<tr class="sref"><td class="snm">${circ(last)} 노드 UP</td><td>${he(allLabel || '복구')} 이후 노드를 올리고 k8s VM 기동 후 Ceph 정상화 · 파드 정상화 확인</td><td>${goal('참고 기록', '파드 정상 배치 확인, Ceph 정상화 확인<div class="sfl">전체 복구 시간에는 넣지 않음</div>')}</td></tr>`,
      `</tbody></table></section>`,
    )
    // ③ 차수별 요약
    const ca = ci('all')
    const rowsOf = (ids: Set<number>) => {
      const idx = [...ids]
      const ok = idx.filter((i) => runVerdict(i) === 'ok')
      const vs = ca >= 0 ? ok.filter((i) => counted(i)).map((i) => vals[ca][i] as number).filter((v) => v != null) : []
      return { n: idx.length, ok: ok.length, fail: idx.filter((i) => runVerdict(i) === 'fail').length, avg: vs.length ? vs.reduce((a, b) => a + b, 0) / vs.length : null }
    }
    const used = grp.phases.filter((ph) => runs.some((h) => h.phaseId === ph.id))
    const loose = runs.map((h, i) => (grp.phases.some((ph) => ph.id === h.phaseId) ? -1 : i)).filter((i) => i >= 0)
    if (used.length || loose.length) {
      /*
       * 2026-11-16 사용자 결정(목업 phase-c-mock 시안 C): 차수 한 칸에 이슈 목록 · 팀별 조치 목록을 늘어놓던 표를 둘로 나눴다.
       *  - 위 표: 차수 · 기간 · 총 · 성공 · 실패 · 전체 복구 — 차수마다 한 줄 + 합계(전체 기간)
       *  - 아래 표: 차수 · NO · 이슈 · 원인 · 조치(팀) · 결과 — 이슈마다 한 줄, 어느 조치가 어느 이슈인지 칸으로 보인다(lib/phaseSummary)
       * 두 표가 같은 칸 격자(PS_GRID)를 써서 세로선이 위아래로 이어진다(사용자 요청: 구분선이 뒤죽박죽). 위 기간 = 아래 NO + 이슈,
       * 위 총 · 성공 · 실패 = 아래 원인, 위 전체 복구 = 아래 조치 + 결과. NO 는 차수를 넘어 1 부터 이어서(사용자 요청).
       * 기간은 '10.28 ~ 11.10' 한 줄로(2026-11-14 사용자 요청) — 줄바꿈 금지
       */
      const day = (t: number) => fmtDateTime(t).slice(5, 10).replace('-', '.')
      const span = (idx: number[]) => {
        const ts = idx.map((i) => runs[i].t0)
        const a = day(Math.min(...ts))
        const b = day(Math.max(...ts))
        return a === b ? a : `${a} ~ ${b}`
      }
      const RES: Record<PhaseAction['result'], string> = { done: '조치 완료', ok: '재현 안 됨', repro: '재현됨', wip: '확인 중', none: '' }
      const grid = '<colgroup>' + ['9%', '4%', '24%', '8%', '8%', '8%', '30%', '9%'].map((w) => `<col style="width:${w}">`).join('') + '</colgroup>'
      const phaseRows = [
        ...used.map((ph) => ({ name: ph.name, ph: ph as GroupPhase | null, idx: runs.map((h, i) => (h.phaseId === ph.id ? i : -1)).filter((i) => i >= 0) })),
        ...(loose.length ? [{ name: '차수 없음', ph: null as GroupPhase | null, idx: loose }] : []),
      ]
      // 적용한 패치(GroupPhase.patch, 2026-11-25) — 차수 이름 아래 작은 글씨로. 두 표(위 요약 · 아래 이슈) 모두 차수 칸에
      const patchTag = (ph: GroupPhase | null) => (ph?.patch?.trim() ? `<div class="ppatch">적용: ${he(maskForExport(ph.patch.trim()))}</div>` : '')
      const sumRow = (name: string, idx: number[], tot = false, ph: GroupPhase | null = null) => {
        const r = rowsOf(new Set(idx))
        return `<tr${tot ? ' class="ptot"' : ''}><td class="pc"><b>${he(name)}</b>${patchTag(ph)}</td><td colspan="2" class="pc pdt">${span(idx)}</td><td class="pc">${r.n}</td><td class="pc pg">${r.ok}</td><td class="pc${r.fail ? ' pr' : ''}">${r.fail}</td><td colspan="2" class="pc"><b>${r.avg != null ? E(r.avg) : '-'}</b></td></tr>`
      }
      // 아래 표 — 차수마다 덩어리(lib/phaseSummary layoutPhase)를 줄로 편다
      let no = 0
      // 세부 줄은 줄마다 div — 길어서 꺾이면 '-' 뒤 글자 자리에 맞춰 들여 쓴다(내어쓰기). '.psub' 는 증적 소제목(굵게)과 이름이 겹쳐 '.pln'
      const lines = (ls: string[], tail = '') => (ls.length ? ls.map((l, k) => `<div class="pln">- ${he(maskForExport(l))}${k === ls.length - 1 ? tail : ''}</div>`).join('') : '')
      const issueCell = (v: IssueView, runIds: string[], idx: number[], rs: number) => {
        const ri = runIds.map((id) => runs.findIndex((h) => h.id === id)).filter((i) => i >= 0 && idx.includes(i))
        const tag = ri.length ? `<span class="irn">${ri.map((i) => runLink(runs[i])).join(' ')}</span>` : ''
        const r = rs > 1 ? ` rowspan="${rs}"` : ''
        return `<td class="pc pno"${r}>${++no}</td><td${r}><b>${he(maskForExport(v.title))}</b>${v.lines.length ? lines(v.lines, tag) : tag ? `<div class="pln">${tag}</div>` : ''}</td>`
      }
      const actCells = (g: ActGroup | null, rs: number) => {
        const r = rs > 1 ? ` rowspan="${rs}"` : ''
        if (!g) return `<td colspan="3" class="pmut"${r}>-</td><td class="pmut"${r}>-</td><td class="pc pmut"${r}>-</td>`
        const cause = g.causes.length ? g.causes.map((c) => he(maskForExport(c))).join('<br>') : '<span class="pmut">-</span>'
        const items = g.items.map((x) => `<li>${he(maskForExport(x.text))}${lines(x.subs)}</li>`).join('')
        return `<td colspan="3"${r}>${cause}</td><td${r}><span class="ptm">${he(g.team)}</span><ul class="pacts">${items}</ul></td><td class="pc"${r}>${g.result !== 'none' ? `<span class="ares a-${g.result}">${RES[g.result]}</span>` : ''}</td>`
      }
      const detail: string[] = []
      let anyIssue = false
      for (const { name, ph, idx } of phaseRows) {
        let iss: PhaseIssue[] = (ph?.issues ?? []).filter((x) => x.text.trim())
        let acts: SumAction[] = (ph?.actions ?? []).filter((x) => x.text.trim())
        // 차수에 하나도 적지 않았으면 그 차수 회차들의 원인 · 조치를 모아 싣는다(notesToPhase 주석). 이때는 이슈 ↔ 조치 연결이 없어 조치는 공통 조치로
        if (!iss.length && !acts.length) {
          const d = notesToPhase(idx.map((i) => runs[i]))
          iss = d.issues
          acts = d.actions
        }
        const runIdsOf = new Map(iss.map((x) => [x.id, x.runIds]))
        const blocks = layoutPhase(iss, acts)
        const phCell = (rs: number) => `<td class="pc"${rs > 1 ? ` rowspan="${rs}"` : ''}><b>${he(name)}</b>${patchTag(ph)}<div class="pdt">${span(idx)}</div></td>`
        if (!blocks.length) {
          detail.push(`<tr>${phCell(1)}<td class="pc pmut">-</td><td colspan="6" class="pmut">이슈 없음</td></tr>`)
          continue
        }
        anyIssue = true
        const total = blocks.reduce((s, b) => s + blockRows(b), 0)
        let first = true
        const head = () => {
          const h = first ? phCell(total) : ''
          first = false
          return h
        }
        for (const b of blocks) {
          if (b.kind === 'issues') {
            b.issues.forEach((v, k) => detail.push(`<tr>${head()}${issueCell(v, runIdsOf.get(v.id) ?? [], idx, 1)}${k === 0 ? actCells(b.act, b.issues.length) : ''}</tr>`))
          } else if (b.kind === 'acts') {
            b.acts.forEach((g, k) => detail.push(`<tr>${head()}${k === 0 ? issueCell(b.issue, runIdsOf.get(b.issue.id) ?? [], idx, b.acts.length) : ''}${actCells(g, 1)}</tr>`))
          } else {
            b.acts.forEach((g, k) =>
              detail.push(`<tr class="pcom">${head()}${k === 0 ? `<td class="pc pmut"${b.acts.length > 1 ? ` rowspan="${b.acts.length}"` : ''}>-</td><td class="pmut"${b.acts.length > 1 ? ` rowspan="${b.acts.length}"` : ''}>공통 조치</td>` : ''}${actCells(g, 1)}</tr>`),
            )
          }
        }
      }
      const allIdx = runs.map((_h, i) => i)
      out.push(
        `<section class="sec"><div class="sh"><span class="n">${sno()}</span><h2>차수별 요약</h2></div>`,
        `<table class="ps psum">${grid}<thead><tr><th>차수</th><th colspan="2">기간</th><th>총</th><th>성공</th><th>실패</th><th colspan="2">${he(allLabel || '전체 복구')}(성공 평균)</th></tr></thead><tbody>`,
        ...phaseRows.map((p) => sumRow(p.name, p.idx, false, p.ph)),
        sumRow('합계', allIdx, true),
        `</tbody></table>`,
        // 이슈가 하나도 없으면 아래 표는 '이슈 없음' 줄만 늘어서니 싣지 않는다
        anyIssue
          ? `<table class="ps pdet">${grid}<thead><tr><th>차수</th><th>NO</th><th>이슈</th><th colspan="3">원인</th><th>조치 (팀)</th><th>결과</th></tr></thead><tbody>${detail.join('')}</tbody></table>`
          : '',
        `</section>`,
      )
    }
    return out.join('\n')
  }
  // 그룹 리포트는 맨 위 요약 표를 싣지 않는다 — ③ 차수별 요약이 같은 일을 한다(2026-11-13 사용자 결정)
  H.push(one ? kpiCards : grp ? '' : stepSummary())
  /** 절 번호 — 그룹 리포트는 앞에 절이 셋 붙어 번호가 밀린다 */
  let secNo = 0
  const sno = () => String(++secNo)
  if (grp && kind === 'total') H.push(groupSections())

  // ── ② 회차 비교 ──
  const nStep = cols.filter((c) => c.grp === 'step').length
  const nTotal = cols.filter((c) => c.grp === 'total').length
  const grpTh = (n: number, label: string) => (n ? `<th class="grp" colspan="${n}">${label}</th>` : '')
  // 오른쪽 안내(2026-11-14 사용자 요청): 회차 · 증적이 눌리는 링크라는 것을 알린다. 링크가 실제로 걸릴 때만(회차별 결과 · 증적을 같이 뽑았을 때) 그 말을 넣는다
  const runLinked = kind !== 'total' || !!opts.runsFile
  const cmpHint = !one && (runLinked || evCol) ? `${runLinked && evCol ? '회차와 증적을' : runLinked ? '회차를' : '증적을'} 선택하면 상세 내용을 확인할 수 있습니다` : ''
  H.push(`<section class="sec"><div class="sh"><span class="n">${sno()}</span><h2>${one ? '단계별 시간' : '회차 비교'}</h2><span class="d">장애 시작부터 걸린 시간${cmpHint ? ` · ${cmpHint}` : ''}</span></div>`)
  /*
   * 회차 비교 표(2026-11-11 사용자 결정 · 목업 cmp-mock → total-mock6). '보기 힘들다 · 가시성이 떨어진다' 는 의견에 다시 그렸다:
   *  - 칸마다 선 · 머리는 모두 가운데. 머리 색은 처음 진한 남색(흰 글씨)이었다가 너무 진해 연한 남색 바탕 · 남색 글씨로(2026-11-12 사용자 결정 · 목업 시안 C, 실패 원인 표도 같이). 글꼴은 리포트 전체를 맑은 고딕으로(Pretendard 가 없는 PC 에서 한글 · 숫자가 서로 다른 글꼴로 섞였다)
   *  - 노드 바로 뒤에 '검증 결과' 칸(성공 초록 · 실패 빨강 굵은 글씨). 판정 못 함은 회색 글씨.
   *    처음엔 칸을 초록 · 빨강으로 채웠으나 너무 진해 표에서 혼자 튀었다(2026-11-12 사용자 결정) — 실패 단계 칸처럼 글자색으로만
   *  - 실패한 단계 칸은 바탕 없이 빨간 글씨 '실패'(분홍 바탕은 알록달록해 보기 힘들었다) · 실패한 회차의 전체 복구는 '-'(결과 칸이 이미 말한다)
   *  - '장애 시작' 칸 · 회차 아래 날짜 줄은 뺐다(회차별 상세에 있다).
   *    세트마다 묶음 줄('1회차 1세트 · 날짜')도 넣었다가 뺐다(2026-11-12 사용자 결정) — 회차 칸에 같은 세트 이름이 있어 줄만 늘고 읽기를 끊었다
   *  - 맨 아래 '성공' 줄은 뺐다(위 카드에 같은 숫자) · '평균 (성공한 회차만)' → '결과 및 소요 시간 평균', 결과 칸 아래 '성공 n · 실패 n'
   */
  const showRes = !!allLabel
  /** 회차 이름의 '(노드 down)' 꼬리 — 옆 칸이 노드라 표에서는 뺀다(전체 이름은 마우스를 올리면) */
  /** 차수 칸(그룹 리포트) — 같은 차수가 이어지는 행을 세로로 합친다(회차는 차수 순서로 정렬돼 있다) */
  const phCol = !!grp && !one
  const phaseOfRun = (h: HistoryRecord) => grp?.phases.find((ph) => ph.id === h.phaseId)?.name ?? '차수 없음'
  const nFix = (one ? 0 : 1) + 2 + (phCol ? 1 : 0)
  const resCell = (i: number) => {
    const v = runVerdict(i)
    return v === 'ok'
      ? '<td class="res ok">성공</td>'
      : v === 'fail'
        ? `<td class="res bad"${manualFailOf(runs[i]) ? ' title="수동 조치로 복구됨: 자동 복구 실패로 셈"' : ''}>실패</td>`
        : '<td class="res nn" title="잴 것이 없었거나 VM 이동을 확인하지 못함">판정 못 함</td>'
  }
  H.push(
    `<table class="nc"><thead><tr>${phCol ? '<th rowspan="2" style="width:76px">차수</th>' : ''}${one ? '' : '<th rowspan="2" style="width:44px">#</th>'}<th rowspan="2">회차</th><th rowspan="2" style="width:130px">대상 노드</th>${showRes ? '<th rowspan="2" style="width:92px">검증 결과</th>' : ''}${grpTh(nStep, '단계별 복구')}${grpTh(nTotal, '총 소요')}${rtoOn ? '<th rowspan="2" style="width:84px">목표 판정</th>' : ''}${evCol ? '<th rowspan="2" style="width:70px">증적</th>' : ''}</tr><tr>${cols
      .map((c) => `<th>${he(c.label)}${rtoGoal(c.key) != null ? `<div style="font-weight:400;font-size:10.5px;opacity:.85">목표 ≤ ${fmtDuration((rtoGoal(c.key) as number) * 1000)}</div>` : ''}</th>`)
      .join('')}</tr></thead><tbody>`,
  )
  runs.forEach((h, i) => {
    const ms = msOf(h)
    const cells = cols
      .map((c, k) => {
        const v = vals[k][i]
        // 빠름 · 느림 칠과 칸 아래 꼬리표는 뺐다(2026-11-10 사용자 요청) — 표는 숫자만, 자세한 것은 회차 상세
        if (c.key === 'svc' && tot[i].svcPending.length && !ovStep(h, 'portal')) return `<td class="fl" title="${he(tot[i].svcPending.join(', '))}">실패</td>`
        // 실패한 회차의 전체 복구는 '-' — 결과 칸이 이미 실패라고 말한다(2026-11-11 사용자 결정)
        if (c.key === 'all' && svcFail[i]) return `<td class="tot nv">-</td>`
        // 성공으로 바꾼 단계: 완료 시각이 없으면 '-'(실패로 칠하지 않는다 — RunOverride 주석)
        if (c.key === 'masa' && ovStep(h, 'masakari') && v == null) return `<td class="nv">-</td>`
        if (c.key === 'masa' && masaFailOf(ms) && !ovStep(h, 'masakari')) return `<td class="fl" title="${he(masaFailText(ms))}">실패</td>`
        // 감시했는데 끝나지 않음(완료 · 최종 실패 기록 없음) — 회차 결과는 실패인데 칸이 '-' 라 셈과 맞지 않았다(코드 리뷰 11-11)
        if (c.key === 'masa' && v == null && masaWatchedOf(ms) && !masaDoneOf(ms) && !ovStep(h, 'masakari')) return `<td class="fl" title="Masakari 가 evacuation 을 끝낸 기록이 없음">미완료</td>`
        // 목표 기준이 켜져 있고 이 항목에 목표가 있으면 합격 · 불합격으로 칠한다
        const goal = rtoGoal(c.key)
        const cls = goal != null && v != null ? (v <= goal * 1000 ? 'pass' : 'fail') : ''
        const tc = [cls, c.grp === 'total' ? 'tot' : '', v == null ? 'nv' : ''].filter(Boolean).join(' ')
        return `<td${tc ? ` class="${tc}"` : ''}>${E(v)}${goal != null && v != null ? (v <= goal * 1000 ? ' ✓' : ' ✗') : ''}${!tot[i].fromDown && v != null ? '*' : ''}</td>`
      })
      .join('')
    const phCell = (() => {
      if (!phCol) return ''
      if (i > 0 && phaseOfRun(runs[i - 1]) === phaseOfRun(h)) return ''
      let span = 1
      while (i + span < runs.length && phaseOfRun(runs[i + span]) === phaseOfRun(h)) span++
      return `<td class="phc" rowspan="${span}">${he(phaseOfRun(h))}</td>`
    })()
    H.push(
      `<tr>${phCell}${one ? '' : `<td>${i + 1}</td>`}<td class="l"><a${one ? '' : ' class="rn"'} ${hrefRun(i)} title="${he(nameOfRun(h, i))}">${he(shortName(h, i))}</a></td><td class="node">${he(h.node)}</td>${showRes ? resCell(i) : ''}${cells}${
        rtoOn ? `<td>${verdicts[i] === 'pass' ? '<span class="pill ok">합격</span>' : verdicts[i] === 'fail' ? '<span class="pill bad">불합격</span>' : '<span class="mut">-</span>'}</td>` : ''
      }${evCol ? `<td>${evFileOf(h) ? `<a class="evl" href="${fileHref(evFileOf(h) as string)}" title="이 회차의 증적 원문 파일">증적 →</a>` : '<span class="mut">-</span>'}</td>` : ''}</tr>`,
    )
  })
  H.push(`</tbody>`)
  // 한 회차면 평균 줄은 같은 숫자의 되풀이라 뺀다
  if (!one) {
    const avgRow = cols.map((c) => {
      const a = nums(c.key)
      return `<td${c.grp === 'total' ? ' class="tot"' : ''}>${a.length ? E(a.reduce((x, y) => x + y, 0) / a.length) : '-'}</td>`
    })
    const resSum = [`<b class="g">성공 ${okRunN}</b>`, `<b class="r">실패 ${failRunIdx.length}</b>`, noneRunN ? `판정 못 함 ${noneRunN}` : ''].filter(Boolean).join(' · ')
    H.push(
      `<tfoot><tr><td colspan="${nFix}" class="l" title="평균은 실패 회차 · DOWN 을 감지하지 못한 회차(*) · 끝나지 않은 값 · 수동 조치로 복구된 회차를 빼고 냄">${showRes ? '결과 및 소요 시간 평균' : '소요 시간 평균'}</td>${
        showRes ? `<td class="rsum">${resSum}</td>` : ''
      }${avgRow.join('')}${rtoOn ? '<td></td>' : ''}${evCol ? '<td></td>' : ''}</tr></tfoot>`,
    )
  }
  H.push(`</table>`)
  H.push(`<div class="explain">
<div><b>장애 시작</b> 복구 시간을 재는 기준(0)입니다. ${inc.inject ? '장애 주입 시각(수동 입력 · 버튼)이 있으면 그 시각, 없으면 노드 DOWN 을 감지한 시각입니다.' : '노드 DOWN 을 감지한 시각입니다(장애 주입 시각 항목을 뺐습니다).'} DOWN 을 감지하지 못한 회차는 검증 시작부터 잽니다(*).</div>
<div><b>포털 1차 정상화</b> 장애 시작부터, 감시 중인 포털 화면이 <b>처음으로 모두 동시에</b> 정상(화면의 핵심 API 가 모두 200 OK, 연속 정해진 횟수)이 된 시점까지입니다(포털 서비스 정상화). 그 뒤 다시 끊겼다가 안정된 최종 정상화는 회차 상세의 참고에 있습니다.</div>
${
    allLabel
      ? `<div><b>전체 복구 기준</b> ${
          allParts.length > 1
            ? `장애 시작 이후 ${[inc.masakari && 'Masakari evacuation 완료(VM 모두 이동)', inc.portal && '포털 1차 정상화'].filter(Boolean).join('와 ')} 중 <b>마지막으로 완료된 시점</b>까지입니다. 하나라도 끝나지 않으면 실패입니다.`
            : `장애 시작 이후 ${he(allParts[0])} 시점까지입니다(다른 항목은 리포트에서 뺐습니다).`
        }</div>`
      : ''
  }
${inc.pods || inc.ceph ? `<div><b>${[inc.pods && '파드', inc.ceph && 'Ceph'].filter(Boolean).join(' · ')}</b> 노드를 다시 올린 뒤에 끝나는 일이라 노드를 언제 올리느냐에 따라 달라집니다. 전체 복구에는 넣지 않습니다.</div>` : ''}
</div>`)
  // 표 아래 기호 설명(- · * · −)은 뺐다(2026-11-10 사용자 요청). 목표 기준을 켰을 때의 ✓ · ✗ 만 남긴다
  H.push(`${rtoOn ? `<div class="legend"><span><b class="pass">✓</b> 목표 이내</span><span><b class="fail">✗</b> 목표 초과</span></div>` : ''}</section>`)

  /**
   * ③ 복구 흐름 — 장애 시작(0)부터 각 단계가 끝난 시점. 막대는 장애 대응 구간(VIP · Masakari · 포털 정상화)만이고, 포털 최종 · 파드 ·
   * Ceph 는 노드를 올린 시각에 따라 달라지는 참고라 아래 '참고' 줄에 글자로만 둔다(10-30 사용자 결정).
   *
   * 예전 모양(회차마다 막대 하나 + 단계 점)의 문제(사용자 지적 10-27, 1회차 리포트): 머리는 '포털 서비스 정상화까지' 인데 막대 끝은
   * 모든 점의 최댓값(그 회차는 Masakari 08:02)이라 끝 점이 바로 옆 '전체 35:47' 과 붙어 전체처럼 읽혔고, 값은 마우스 툴팁뿐이라
   * PDF 에선 숫자가 하나도 없었다. 눈금도 없었고 1:16 · 1:41 · 1:41 점이 한 자리에 겹쳤다. 그래서
   *  - 한 회차: 단계마다 한 줄(단계 | 막대 | 시간 글자), 끝난 순서대로. Ceph 처럼 수십 분 걸리는 것은 같은 축이면 앞 단계가 눌리므로
   *    아래 '그 뒤' 줄에 글자로만.
   *  - 여러 회차: 회차당 한 줄은 그대로 두되 눈금 축을 달고, 축 끝을 값들의 90% 지점에서 자른다(13회차 리포트에서 파드 76분 한 회차에
   *    축이 끌려 나머지 점이 왼쪽에 뭉쳤다). 넘친 점은 끝에 네모로 두고 오른쪽 열에 '축 밖' 으로 값을 적는다. 겹치는 점은 위아래로 엇갈린다.
   */
  const marks = [
    { key: 'vip', label: 'VIP 이동', color: '#2f6fdc' },
    { key: 'masa', label: 'Masakari 완료', color: '#13804b' },
    { key: 'svc', label: '포털 1차 정상화', color: '#6a2fc0' },
  ].filter((mk) => ci(mk.key) >= 0)
  /** 축 — 눈금이 6개 안쪽이 되는 가장 작은 간격으로 끝을 올림 */
  const axisOf = (max: number) => {
    const m = Math.max(max, 1000)
    const step = [30, 60, 120, 300, 600, 900, 1800, 3600, 7200].map((x) => x * 1000).find((x) => m / x <= 6) ?? 3_600_000 * Math.ceil(m / 3_600_000 / 6)
    return { step, end: Math.ceil(m / step) * step }
  }
  const tickLabel = (ms: number) => {
    if (!ms) return '0'
    const sec = Math.round(ms / 1000)
    if (sec < 60) return `${sec}초`
    const h = Math.floor(sec / 3600)
    const mm = Math.floor((sec % 3600) / 60)
    const ss = sec % 60
    return [h ? `${h}시간` : '', mm ? `${mm}분` : '', ss ? `${ss}초` : ''].filter(Boolean).join(' ')
  }
  const pct = (v: number, end: number) => ((Math.min(Math.max(0, v), end) / end) * 100).toFixed(2)
  const axisRow = (ax: { step: number; end: number }) => {
    const ticks: number[] = []
    for (let t = 0; t <= ax.end; t += ax.step) ticks.push(t)
    return `<div class="axis">${ticks.map((t, k) => `<span${k === ticks.length - 1 && k > 0 ? ' class="e"' : ''} style="left:${pct(t, ax.end)}%">${tickLabel(t)}</span>`).join('')}</div>`
  }
  const grid = (ax: { step: number; end: number }) =>
    `background-image:repeating-linear-gradient(90deg,#dfe3ea 0,#dfe3ea 1px,transparent 1px,transparent ${((ax.step / ax.end) * 100).toFixed(3)}%)`
  if (marks.length) {
    if (one) {
      const ms = msOf(runs[0])
      const t = tot[0]
      const steps = marks
        .map((m) => ({ ...m, v: vals[ci(m.key)][0], note: cols[ci(m.key)].note?.(ms).trim() ?? '' }))
        .filter((x): x is typeof x & { v: number } => x.v != null)
        .sort((x, y) => x.v - y.v)
      // 값이 없어 막대가 없는 실패 — 빠뜨리면 '없었다' 로 읽힌다
      const fails = [
        inc.masakari && masaFailOf(ms) ? { label: 'Masakari', text: `실패 (${masaFailText(ms)})`, title: '' } : null,
        inc.portal && t.svcPending.length ? { label: '포털', text: `실패 (화면 ${t.svcPending.length}개 안 돌아옴)`, title: t.svcPending.join(', ') } : null,
      ].filter((x): x is { label: string; text: string; title: string } => !!x)
      const ax = axisOf(Math.max(0, ...steps.map((x) => x.v)))
      H.push(`<section class="sec"><div class="sh"><span class="n">${sno()}</span><h2>복구 흐름</h2><span class="d">장애 시작(0)부터 각 단계가 끝난 시점</span></div><div class="flow">`)
      H.push(`<div></div>${axisRow(ax)}<div></div>`)
      for (const x of steps)
        H.push(
          `<div>${he(x.label)}</div><div class="track" style="${grid(ax)}"><span class="sbar" style="width:${pct(x.v, ax.end)}%;background:${x.color}"></span></div><div class="num">${E(x.v)}${x.note ? `<span class="cn">${he(x.note)}</span>` : ''}</div>`,
        )
      for (const f of fails) H.push(`<div>${he(f.label)}</div><div class="track"></div><div class="fail" title="${he(f.title)}">${he(f.text)}</div>`)
      H.push(`</div>`)
      const after = (['pods', 'ceph'] as const)
        .filter((k) => ci(k) >= 0 && vals[ci(k)][0] != null)
        .map((k) => `${cols[ci(k)].label} ${E(vals[ci(k)][0])}${cols[ci(k)].note?.(ms) ?? ''}`)
      if (allLabel || after.length)
        H.push(
          `<div class="after">${allLabel ? `<b>${he(allLabel)} ${ci('all') >= 0 && vals[ci('all')][0] != null ? E(vals[ci('all')][0]) : '실패'}</b>` : ''}${after.length ? `${allLabel ? ' · ' : ''}참고: ${after.join(' · ')}` : ''}</div>`,
        )
      H.push(`</section>`)
    }
  }
  /*
   * 여러 회차: ② 실패 원인 · ③ 노드별 결과(2026-11-11 사용자 결정 · 목업). 예전 '② 복구 흐름'(회차마다 단계 점)은 ① 회차 비교 표의 시간을
   * 다시 그린 것이라 새로 알려 주는 것이 없었다(사용자 지적). 표에 없는 것 — 왜 실패했나 · 노드별로 다른가 — 를 둔다. 한 회차는 위 흐름 그대로.
   */
  if (!one && allLabel) {
    // 포털 판정의 연속 성공 횟수 — 회차 기록(정상화 확정 streak · 판정 기록 n)에서 읽는다. 없으면 숫자 없이
    const streakN = (ms: Milestones) => Math.max(0, ...(ms.portal ?? []).map((p) => p.streak ?? 0), ...(ms.portalLog ?? []).map((e) => e.n ?? 0)) || null
    /** key: 세부 원인 및 조치를 찾을 단계(RunNote.step) · note: 수동 조치 줄은 그 기록 하나 */
    const failRows: { i: number; step: string; head: string; subs: string[]; key: RunNote['step']; note?: RunNote }[] = []
    runs.forEach((h, i) => {
      if (!svcFail[i]) return
      const ms = msOf(h)
      const t = tot[i]
      if (inc.masakari && masaWatchedOf(ms) && !masaDoneOf(ms) && !ovStep(h, 'masakari')) {
        const subs: string[] = []
        let head = (ms.masakariFail ?? []).length ? 'Masakari evacuation 끝나지 않음' : 'Masakari evacuation 기록 없음'
        let names: string[] | undefined
        if (masaPartOf(ms) && ms.masakari?.vms) {
          const v = ms.masakari.vms
          head = `VM ${v.count}대 중 ${v.failed + (v.pending ?? 0)}대 실패`
          if (v.pending) subs.push(`${v.pending}대는 끝까지 완료되지 않음`)
          names = v.failedNames
        } else if (masaFailedRun(ms)) {
          const fs = [...(ms.masakariFail ?? [])].sort((a, b) => a.at - b.at)
          const f = fs.filter((x) => x.failedVms).pop() ?? fs[fs.length - 1]
          head = f?.failedVms ? (f.evac >= f.failedVms ? `VM ${f.evac}대 중 ${f.failedVms}대 실패` : `VM ${f.failedVms}대 실패`) : 'Masakari evacuation 실패'
          // 이유에서 대수 부분은 위 굵은 글씨와 겹치므로 뺀다('VM 11대 중 1대 옮기지 못함 · 1대 evacuation 확인 시간 초과(601초)' → 뒤만)
          const why = (f?.reason ?? f?.brief ?? '').replace(/^VM \d+대(?: 중 \d+대)? 옮기지 못함(?: · )?/, '').trim()
          if (why) subs.push(why)
          // 대수를 정한 기록(f)의 이름만 — 앞선 1차 시도에서 실패했다가 재시도에서 옮겨진 VM 이 섞이지 않게(코드 리뷰 11-11)
          names = f?.failedVmNames
        }
        if (!masaPartOf(ms) && !masaFailedRun(ms) && !(ms.masakariFail ?? []).length) subs.push('알림 처리 · evacuation 완료 기록을 찾지 못함')
        if (names?.length) subs.push(Array.from(new Set(names)).join(' · '))
        failRows.push({ i, step: 'Masakari', head, subs, key: 'masakari' })
      }
      if (inc.portal && t.svcPending.length && !ovStep(h, 'portal')) {
        const ph = portalPhases(ms)
        const n = streakN(ms)
        if (ph.firstAll != null) {
          // 끝내 안 돌아온 화면이 다시 끊긴 시각만 — 다른 화면의 끊김(곧 돌아온 것)을 적지 않게(코드 리뷰 11-11)
          const re = Math.min(...(ms.portalFlaps ?? []).filter((f) => t.svcPending.includes(f.name)).map((f) => f.downAt).filter((x) => x > (ph.firstAll as number)))
          failRows.push({
            i,
            step: '포털',
            key: 'portal',
            head: '정상화 이후 다시 포털 실패',
            subs: [
              `${E(ph.firstAll - t.base)}에 모두 정상${Number.isFinite(re) ? ` → ${E(re - t.base)}에 다시 끊김` : ''} → 검증 끝까지 안 돌아옴`,
              t.svcPending.join(' · '),
            ],
          })
        } else failRows.push({ i, step: '포털', key: 'portal', head: `주요 화면 API 200 OK ${n ? `${n}회 ` : ''}연속 성공하지 못함`, subs: [t.svcPending.join(' · ')] })
      }
      // 사람이 '조치로 복구됨' 을 켠 수동 조치 — 앱이 성공으로 본 회차도 여기서 실패 줄이 된다(RunNote 주석)
      for (const nt of (h.notes ?? []).filter((x) => x.step === 'manual' && x.recovered && x.cause.trim()))
        failRows.push({
          i,
          step: '수동 조치',
          key: 'manual',
          note: nt,
          head: '수동 조치 후 복구',
          subs: [`자동으로 복구되지 않아 사람이 조치함${nt.at != null ? ` · ${fmtDateTime(nt.at)}` : ''}`],
        })
    })
    H.push(`<section class="sec"><div class="sh"><span class="n">${sno()}</span><h2>실패 세부 원인</h2><span class="d">실패한 회차만 · 실패한 단계마다 한 줄</span></div>`)
    if (!failRows.length) H.push(`<p class="note" style="margin:0">모든 회차가 성공했습니다.</p>`)
    else {
      /*
       * 실패 원인 표(2026-11-11 사용자 결정 · 목업 total-mock6): 회차 비교 표와 같은 꼴(남색 머리 · 칸마다 선 · 머리 가운데).
       * 회차 · 실패 칸은 좌우 · 위아래 가운데, 내용 · 세부 원인 및 조치는 왼쪽(위아래 가운데). 오른쪽 칸은 이력 창에서 적은 것 — 비었으면 빈칸.
       */
      H.push(`<table class="fx"><thead><tr><th style="width:190px">회차</th><th style="width:96px">실패</th><th style="width:34%">내용</th><th>세부 원인 및 조치</th></tr></thead><tbody>`)
      failRows.forEach((r, k) => {
        const span = failRows.filter((x) => x.i === r.i).length
        const firstOfRun = k === 0 || failRows[k - 1].i !== r.i
        const h = runs[r.i]
        const ns = r.note ? [r.note] : (h.notes ?? []).filter((x) => x.step === r.key && x.cause.trim())
        H.push(
          `<tr>${
            firstOfRun
              ? `<td class="c"${span > 1 ? ` rowspan="${span}"` : ''}><a class="rn" ${hrefRun(r.i)} title="${he(nameOfRun(h, r.i))}">#${r.i + 1} ${he(shortName(h, r.i))}</a><span class="rs">${he(h.node)}</span></td>`
              : ''
          }<td class="c"><span class="fstep${r.key === 'manual' ? ' act' : ''}">${he(r.step)}</span></td><td><b>${he(r.head)}</b>${r.subs
            .filter(Boolean)
            .map((x) => `<span class="fm">${he(x)}</span>`)
            .join('')}</td><td class="dc">${noteHtml(ns)}</td></tr>`,
        )
      })
      H.push(`</tbody></table>`)
    }
    H.push(`</section>`)

    // 느려진 API(포털 API 응답 시간 요약, 2026-11-19 사용자 결정) — 같이 뽑은 '포털 API 응답 시간' 파일이 있으면 회차 칸 · 아래 줄에서 그리로 간다
    if (inc.portal) {
      const lf = opts.latFile
      /*
       * 조치 전 · 후(2026-11-25) — 리포트 만들기 창에서 비교를 켰을 때만, 그때는 '응답 지연' 다섯 줄 **대신** 싣는다(사용자 결정).
       * 둘을 연달아 두면 응답 지연(같은 API 가 회차만 바꿔 다섯 줄)이 비교 표의 조치 전 칸을 미리 보여 주는 것에 그쳤다. 비교는 이번
       * 패치처럼 조치가 있을 때만 켜는 것이고, 평소 리포트는 지금처럼 응답 지연이 나온다
       */
      if (cmp) H.push(cmpSummary(String(sno()), lf))
      else H.push(latSummary(String(sno()), lf ? (i) => `href="${fileHref(lf)}#lat-${i + 1}"` : null, lf ? `<div class="note">회차별 전체 표는 <a href="${fileHref(lf)}">포털 API 응답 시간 →</a></div>` : ''))
    }
    // ③ 노드별 결과 — 어느 노드를 내렸을 때 약한가. 평균 · 최대는 성공한 회차만(위 평균과 같은 기준)
    const nodeList = Array.from(new Set(runs.map((h) => h.node).filter((nd) => nd && nd !== UNKNOWN_NODE)))
    if (nodeList.length) {
      const ca = ci('all')
      H.push(`<section class="sec"><div class="sh"><span class="n">${sno()}</span><h2>노드별 결과</h2><span class="d">시간은 성공한 회차만</span></div><div class="ncards">`)
      for (const nd of nodeList) {
        const idx = runs.map((_h, i) => i).filter((i) => runs[i].node === nd)
        const okN = idx.filter((i) => runVerdict(i) === 'ok').length
        const judgedN = idx.filter((i) => runVerdict(i) !== 'none').length
        const vs = idx.filter((i) => runVerdict(i) === 'ok' && counted(i)).map((i) => vals[ca][i] as number)
        const avg = vs.length ? vs.reduce((a, b) => a + b, 0) / vs.length : null
        H.push(
          `<div class="ncard"><div class="t">${he(nd)}</div><div class="mut">${idx.length}회 (${idx.map((i) => runLink(runs[i])).join(' ')})</div><div class="big">성공 ${okN} / ${judgedN}</div><div class="nb"><i style="width:${judgedN ? ((okN / judgedN) * 100).toFixed(1) : 0}%"></i></div><div class="mut">${
            avg != null ? `${he(allLabel)} 평균 <b>${E(avg)}</b> · 최대 ${E(Math.max(...vs))}` : `${he(allLabel)}: 성공한 회차 없음`
          }</div></div>`,
        )
      }
      H.push(`</div></section>`)
    }
  }

  if (kind !== 'total' && kind !== 'all') H.splice(topStart)

  // ── ④ 회차별 상세 ── (종합 결과에는 없다 — 아래에서 이 자리부터 잘라 낸다)
  const runsStart = H.length
  /** 회차별 · 증적 파일은 회차를 펼친 채로 연다 — 그 파일은 상세를 보려고 여는 것이다 */
  const openRuns = opts.openEvidence || kind === 'runs' || kind === 'evidence'
  H.push(
    `<section class="sec"><div class="sh"><span class="n">${kind === 'all' ? '3' : '1'}</span><h2>${kind === 'evidence' ? '증적 원문' : '회차별 상세'}</h2><span class="d">${
      kind === 'evidence' ? '마일스톤이 찍힌 순간 떠 둔 서버 원문' : '회차를 눌러 펼치거나 접으세요'
    }</span></div>`,
  )
  // 회차가 많으면 '모두 펼치기' 가 수만 픽셀이 된다(13회차: 회차 하나가 증적까지 2천~7천 px) — 볼 것이 있는 회차만 여는 버튼을 둔다
  H.push(
    `<div class="tools"><button type="button" onclick="document.querySelectorAll('details.run').forEach(d=>d.open=true)">모두 펼치기</button>${
      one ? '' : `<button type="button" onclick="document.querySelectorAll('details.run').forEach(d=>d.open=d.hasAttribute('data-bad'))">문제 있는 회차만 펼치기</button>`
    }<button type="button" onclick="document.querySelectorAll('details.run').forEach(d=>d.open=false)">모두 접기</button>${
      // 회차 결과 요약 — 종합 결과의 '검증 결과' 카드와 같은 말
      allLabel && !one
        ? `<span class="tsum">${runs.length}회 중 <b class="pass">성공 ${okRunN}</b> · <b class="fail">실패 ${failRunIdx.length}</b>${noneRunN ? ` · 판정 못 함 ${noneRunN}` : ''}${failRunIdx.length ? ` (${failRunIdx.map((i) => runLink(runs[i])).join(' ')})` : ''}</span>`
        : ''
    }</div>`,
  )
  runs.forEach((h, i) => {
    const ms = msOf(h)
    const t = tot[i]
    // 뺀 항목의 증적은 넣지 않는다 — 증적을 통째로 뺐으면 하나도 넣지 않는다.
    /*
     * '증적 원문' 파일도 넣을 항목을 따른다(2026-11-10 사용자 요청: 포털 정상화까지만 뽑았는데 증적 목차에 노드 UP 이후의 파드 · Ceph ·
     * 세션 재연결이 줄줄이 섰다). 예전(10-29)엔 증적 원문만 항목과 상관없이 전부 넣었다 — 보고용 항목으로 뽑으면 '저장된 증적이 없습니다' 가
     * 됐던 탓인데, 그 판단은 저장된 증적 수(makeRunsReport)로 하므로 여기서 걸러도 파일이 빠지지 않는다.
     * 검증 전 분산 점검('spread')은 항목과 상관없이 넣는다(장애 전 상태라 늘 볼 값). 검증 중에 누른 점검('spread:<시각>', 이제는 저장하지 않음)은
     * 옛 회차에 남아 있어도 넣지 않는다(사용자 결정: 검증 중 점검은 이력에 남기지 않는다).
     */
    const items = inc.evidence ? (evidence[h.id] ?? []).filter((it) => evKeep(it.key, inc)) : []
    // 증적을 사건 시각 순으로 늘어놓고 '노드 DOWN 이전 · 이후 · UP 이후' 로 묶는다(runEvidenceLayout)
    const lay = runEvidenceLayout(items, ms, h.t0, t.base, inc.node)
    const { evItems, evKeys, evArr, upAt } = lay
    const evAnchor = new Map(evArr.map((x, n) => [x.it.key, `ev-${i + 1}-${n + 1}`]))
    const pend = podsDoneSummary(ms).pending
    const allV = ci('all') >= 0 ? vals[ci('all')][i] : null
    const pills = [
      /*
       * 포털 실패 · 전체 실패 · Masakari 실패 라벨은 뺐다(2026-11-10 사용자 요청: 펼치면 바로 아래 카드가 같은 말을 한다).
       * 포털 · 전체 시간 알약도 뺐다(같은 날 사용자 요청) — 회차 결과(성공 / 실패) 하나만 남긴다
       */
      t.fromDown ? '' : `<span class="pill warn">DOWN 미감지: 시작 기준</span>`,
      inc.pods && pend ? `<span class="pill warn">파드 미완 ${pend}</span>` : '',
      inc.evidence ? `<span class="pill">증적 ${evItems.length}</span>` : '',
      // 회차 결과 하나(2026-11-10 사용자 요청: 포털 · 전체 시간 알약은 빼고 끝에 성공 / 실패, 그 오른쪽에 증적 링크). 시간은 펼친 카드에 있다
      allLabel ? { ok: '<span class="pill ok">성공</span>', fail: '<span class="pill bad">실패</span>', none: '<span class="pill" title="잴 것이 없었거나 VM 이동을 확인하지 못함">판정 못 함</span>' }[runVerdict(i)] : '',
      kind === 'runs' && evFileOf(h) ? `<a class="evl" href="${fileHref(evFileOf(h) as string)}" title="이 회차의 증적 원문 파일">증적 →</a>` : '',
    ].join('')
    // '문제 있는 회차만 펼치기' 의 대상 — 실패 · 미완 · DOWN 미감지
    // 회차는 첫 회차만 펼쳐 연다(2026-11-10 사용자 요청: 다 펼치면 첫 화면이 한 회차로 꽉 찬다). PDF(openEvidence)는 접힌 것이 인쇄되지 않아 모두 펼친다
    const bad = (inc.portal && t.svcPending.length > 0) || svcFail[i] || (inc.masakari && masaFailOf(ms)) || (inc.pods && pend > 0) || !t.fromDown
    H.push(
      `<details class="run" id="run-${i + 1}"${bad ? ' data-bad' : ''}${openRuns && (i === 0 || opts.openEvidence) ? ' open' : ''}><summary><span class="rt">${i + 1}. ${he(nameOfRun(h, i))}</span><span class="tag">${he(h.node)}</span><span class="mut">${he(fmtDateTime(h.t0))}</span>${pills}</summary><div class="rb">`,
    )
    /*
     * 머리 카드 — 장애 시작 · Masakari 완료 · 포털 1차 정상화 · 전체 복구 넷(10-30 사용자 결정, 목업). 걸린 시간은 크게, 시각은 작게.
     * 예전엔 대상 노드 · DOWN 감지 · 포털 · 전체에 '장애 주입' · '주입부터 포털 정상화 · 전체 복구' 를 더 붙여 같은 일을 두 기준으로 적었다.
     * 이제 장애 주입이 있으면 그것이 기준(장애 시작)이고, DOWN 감지는 그 카드에 '+2초' 로 같이 적는다. 노드는 회차 머리에 있다.
     * 흔들림이 끝난 포털 최종 · Ceph · 노드 복귀는 노드를 올린 시각에 따라 바뀌므로 카드 아래 '참고' 한 줄로.
     */
    const inj = h.milestones.inject
    // 카드 아래 작은 글씨(수동 입력 · DOWN 감지 +n초 · 화면 수 앞 '처음' · 전체 복구 기준)는 뺐다(2026-11-10 사용자 요청: 간결하게).
    // 장애 시작은 이미 장애 주입 · DOWN 감지 중 이른 쪽이다(runTotals)
    void inj
    const startCard = t.fromDown ? `<b>${he(fmtDateTime(t.base))}</b>` : '<b>-</b><small>DOWN 감지 못함: 검증 시작 기준</small>'
    // 성공으로 바꾼 단계는 실패로 칠하지 않는다 — 완료 시각이 있으면 그 시각, 없으면 '성공'(RunOverride 주석)
    const masaCard = masaFailOf(ms) && !ovStep(h, 'masakari')
      ? `<b class="fail">실패</b><small>${he(masaFailText(ms))}</small>`
      : ms.masakari
        ? `<b>${E(ms.masakari.at - t.base)}</b><small>${ms.masakari.evac > 0 ? `${ms.masakari.evac}대 · ` : ''}${he(fmtDateTime(ms.masakari.at))}${masaUncheckedOf(ms) ? ' · VM 이동 확인 못 함(Nova 조회 실패)' : ''}</small>`
        : ovStep(h, 'masakari') && masaWatchedOf(ms)
          ? '<b>성공</b>'
          : `<b>-</b><small>${masaWatchedOf(ms) ? '끝나지 않음' : 'Masakari 동작 없음'}</small>`
    const ph = portalPhases(ms)
    // 끝나지 않은 것은 '미복구' 가 아니라 '실패' 로 부른다(2026-11-10 사용자 요청) — 리포트 전체가 같은 말
    const svcCard = ovStep(h, 'portal') && t.svcPending.length
      ? t.svc != null
        ? `<b>${E(t.svc)}</b>`
        : '<b>성공</b>'
      : t.svcPending.length
      ? `<b class="fail">실패</b><small>${t.svc != null ? `1차 정상화 ${E(t.svc)} 뒤 다시 끊겨 안 돌아옴: ` : '안 돌아온 화면: '}${he(t.svcPending.join(', '))}</small>`
      : t.svc == null
        ? '<b>-</b><small>포털 끊김 기록 없음</small>'
        : `<b>${E(t.svc)}</b><small>${ph.total}/${ph.total} 화면${ph.calm ? `(끊기지 않은 ${ph.calm}개 포함)` : ''} · ${he(fmtDateTime(t.base + t.svc))}</small>`
    /*
     * 전체 복구 실패는 무엇 때문인지 한 줄로(2026-11-10 사용자 요청: 'Masakari 는 성공했으나 포털 정상화 불가로 실패' 꼴). svcFail 과 같은 조건:
     * Masakari 를 감시했는데 끝나지 않았거나, 포털에 안 돌아온 화면이 있다. 리포트에서 뺀 항목은 말하지 않는다.
     */
    const masaBad = inc.masakari && masaWatchedOf(ms) && !masaDoneOf(ms) && !ovStep(h, 'masakari')
    const portalBad = inc.portal && t.svcPending.length > 0 && !ovStep(h, 'portal')
    // 사람이 '조치로 복구됨' 을 켠 회차 — 앱이 잰 것은 모두 끝났지만 사람이 손대서 끝난 것(RunNote 주석)
    const failWhy = !masaBad && !portalBad && manualFailOf(h)
      ? '자동으로 복구되지 않아 수동 조치 후 복구'
      : masaBad && portalBad
        ? 'Masakari evacuation 실패 · 포털 정상화 불가로 실패'
        : portalBad
          ? `${inc.masakari && masaDoneOf(ms) ? 'Masakari evacuation 은 성공했으나 ' : ''}포털 정상화 불가로 실패`
          : `${inc.portal && t.svc != null ? '포털은 정상화됐으나 ' : ''}Masakari evacuation ${masaFailOf(ms) ? '실패' : '미완료'}로 실패`
    const allCard = svcFail[i]
      ? `<b class="fail">실패</b><small>${he(failWhy)}</small>`
      : ovIn(h)
      ? '<b>-</b>'
      : allV == null
        ? '<b>-</b><small>잴 것 없음(Masakari 동작 · 포털 끊김 없음)</small>'
        : `<b>${E(allV)}</b>`
    // 노드 항목을 뺀 리포트는 노드 복귀 · 그 뒤 구분선 · 흐린 줄을 쓰지 않는다
    const nb = inc.node ? nodeBackAt(ms) : null
    const refLine = [
      inc.portal && t.svcFinal != null && t.svc != null && t.svcFinal > t.svc + 999
        ? `포털 최종 정상화 ${E(t.svcFinal)}${ph.flapsAfterFirst ? ` (1차 뒤 다시 끊김 ${ph.flapsAfterFirst}회)` : ''}`
        : '',
      inc.ceph && ms.cephHealthy ? `Ceph HEALTH_OK ${E(ms.cephHealthy.at - t.base)}` : inc.ceph && ms.ceph ? `Ceph 데이터 복구 ${E(ms.ceph.at - t.base)}` : '',
      nb != null ? `노드 복귀 ${E(nb - t.base)}` : '',
    ].filter(Boolean)
    H.push(
      `<div class="kv" id="sum-${i + 1}"><div><span>장애 시작</span>${startCard}</div>${inc.masakari ? `<div><span>Masakari 완료</span>${masaCard}</div>` : ''}${
        inc.portal ? `<div><span>포털 1차 정상화</span>${svcCard}</div>` : ''
      }${allLabel ? `<div><span>전체 복구</span>${allCard}</div>` : ''}</div>${refLine.length ? `<div class="refl">참고: ${refLine.map(he).join(' · ')}</div>` : ''}`,
    )
    // 세부 원인 및 조치(RunNote 주석) — 요약 칸 아래 상자. 종합 결과의 실패 원인 표 오른쪽 칸과 같은 글
    const notesOk = (h.notes ?? []).filter((n) => n.cause.trim())
    if (notesOk.length)
      H.push(
        `<div class="cbox"><div class="hd">세부 원인 및 조치</div>${notesOk
          .map(
            (n) =>
              `<div class="it"><div class="c"><span class="fstep${n.step === 'manual' ? ' act' : ''}">${NOTE_STEP_LABEL[n.step]}</span></div><div>${noteHtml([n])}${
                n.step === 'manual' && n.recovered ? '<div class="mut" style="font-size:11px;margin-top:2px">이 조치로 복구됨: 회차는 실패로 셈</div>' : ''
              }</div></div>`,
          )
          .join('')}</div>`,
      )
    /** 조치 시각을 적은 기록은 타임라인에 '사람 조치' 줄(주황)로 — 무엇이 조치 덕분에 돌아왔는지 시간 순서로 보이게 */
    const noteRows: TimelineItem[] = notesOk
      .filter((n) => n.at != null)
      .map((n) => ({
        at: n.at as number,
        icon: null,
        text: maskForExport(`${n.step === 'manual' ? '수동 조치' : '조치'}: ${(n.action?.trim() || n.cause.trim()).split('\n')[0]}${n.owner?.trim() ? ` (${n.owner.trim()})` : ''}`),
        tone: 'info' as TlTone,
        target: 'note',
      }))
    const manualAt = Math.min(Infinity, ...notesOk.filter((n) => n.step === 'manual' && n.recovered && n.at != null).map((n) => n.at as number))
    const withNotes = (rows: TimelineItem[]) =>
      noteRows.length ? [...rows, ...noteRows].sort((a, b) => (a.sortAt ?? a.at) - (b.sortAt ?? b.at) || (a.ord ?? 0) - (b.ord ?? 0)) : rows
    /**
     * 타임라인은 화면과 같이 **요약** 을 먼저 두고, 전체 기록은 접어서 아래에 둔다(사용자 결정 — 보고서가 30줄 넘는 표로 시작했다).
     * PDF 는 접힌 내용이 인쇄되지 않으므로 증적처럼 펼쳐서 뽑는다. 리포트에서 뺀 항목(opts.keep)은 두 표 모두에서 뺀다.
     */
    /*
     * 줄 강조(10-30 사용자 결정, 목업) — 리포트만. 앱의 복구 타임라인은 그대로 둔다(사용자: 나중에 요청).
     *  - 장애 시작(장애 주입 · 호스트 DOWN): 빨강 / 복구 이정표(VIP 이동 · Masakari 완료 · 포털 1차 정상화): 파랑, 전체 복구를 정한 줄에 표시
     *  - 포털 최종 정상화: 파랑 띠만(참고) / 노드 복귀 뒤 · 검증 시작: 흐리게(포털 줄은 장애 판단에 필요해 흐리게 하지 않는다)
     * 경과는 장애 시작 기준이다 — 카드의 09:37 과 타임라인의 같은 줄이 같은 숫자로 읽히게(예전엔 검증 시작 기준이라 +12:22 였다).
     */
    const allAt = allV != null ? t.base + allV : null
    /*
     * 포털 줄은 **문구가 아니라 시각으로** 가른다(코드 점검 10-30). 1차 정상화 전에만 흔들린 회차는 그 순간의 줄 문구가 '포털 최종 정상화' 라
     * 참고 색으로 칠해지고 전체 복구 표시도 빠졌고, 전체 기록 표의 '포털 정상화: 4개 화면 (4/4)' 은 문구 꼴이 달라 강조되지 않았다.
     */
    const isUp = (r: TimelineItem) => r.target === 'portal' && r.text.includes('정상화') && !r.text.includes('미복구')
    const rowCls = (r: TimelineItem): 'kd' | 'kr' | 'kf' | 'ka' | '' => {
      if (r.target === 'note') return 'ka'
      // 끝내 안 돌아온 포털(요약의 '포털 실패' 줄)도 장애 색 — 범례가 장애 · 복구 · 참고 셋이다
      if (r.target === 'inject' || (r.target === 'host' && r.text.startsWith('호스트 DOWN')) || (r.target === 'portal' && r.text.startsWith('포털 실패'))) return 'kd'
      // Masakari 최종 실패 · 일부 VM 을 못 옮긴 완료도 장애 색 — 회차 결과를 '실패' 로 만든 줄인데 흰 줄이었다(2026-11-11 사용자 지적).
      // 1차 시도 실패(error)는 재시도로 넘어가는 중간 단계라 칠하지 않는다
      if (r.target === 'masakari' && (r.text.startsWith('Masakari 최종 실패') || (r.text.startsWith('Masakari evacuation 완료') && masaPartOf(ms)))) return 'kd'
      if (r.target === 'vip' || (r.target === 'masakari' && r.text.startsWith('Masakari evacuation 완료') && masaDoneOf(ms))) return 'kr'
      // 전체 기록 표는 같은 순간(PORTAL_SAME_MS 안) 돌아온 화면을 한 줄로 묶고 그 묶음의 가장 이른 시각을 적는다 — 1~2초 어긋날 수 있다
      const near = (x: number | null) => x != null && Math.abs(r.at - x) <= PORTAL_SAME_MS
      if (isUp(r) && near(ph.firstAll)) return 'kr'
      if (isUp(r) && near(ph.finalAll)) return 'kf'
      return ''
    }
    const elapsedHead = t.fromDown ? '장애 시작 후' : '검증 시작 후'
    const since = (at: number) => `${at < t.base ? '−' : '+'}${fmtElapsed(Math.abs(at - t.base))}`
    // 요약 표는 화면 요약과 같이 '한 문장' 만(안 1) — 설명 · 서버 기록은 아래 전체 기록에 있다
    /*
     * 요약 타임라인 줄이기(2026-11-10 사용자 요청: 전체 기록에 다 있으니 요약은 흐름만).
     *  - 장애 주입과 호스트 DOWN 은 같은 일을 두 줄로 말했다 → 이른 쪽 시각(= 장애 시작)에 '호스트 DOWN: 노드' 한 줄
     *  - 포털 다시 끊김을 화면 · 순간마다 늘어놓지 않는다 → 끊김 > 1차 정상화 > 다시 끊김 n회 > 최종 정상화
     */
    const condense = (rows: TimelineItem[]): TimelineItem[] => {
      // 포털 묶음만 머리 한 줄로 줄인다. 파드 흔들림 같은 다른 묶음은 예전처럼 머리를 빼고 줄을 펼친다(항목에서 뺐으면 keepRow 가 거른다)
      let out = rows.filter((x) => x.fold !== 'portal' && (!x.foldHead || x.foldHead === 'portal') && (x.foldHead === 'portal' || keepRow(x)))
      if (!inc.portal) out = out.filter((x) => x.foldHead !== 'portal')
      const injRow = out.find((r) => r.target === 'inject')
      const downRow = out.find((r) => r.target === 'host' && r.text.startsWith('호스트 DOWN'))
      if (injRow && downRow) {
        const merged: TimelineItem = { ...downRow, at: Math.min(injRow.at, downRow.at), text: `호스트 DOWN: ${h.node}` }
        out = out.filter((r) => r !== injRow && r !== downRow)
        out.push(merged)
      }
      out = out.map((r) =>
        r.foldHead
          ? { ...r, foldHead: undefined, target: 'portal', text: r.text.replace(/^포털 흔들림 (\d+)회.*$/, '포털 다시 끊김 $1회') }
          : r.target === 'portal' && r.text.startsWith('포털 1차 정상화')
            ? { ...r, text: r.text.replace(/ · 이후 다시 끊김 \d+회$/, '') }
            : r,
      )
      /*
       * 끝내 안 돌아온 화면이 있는 회차의 '포털 1/4 정상화 · 미복구 3' 줄은 마지막으로 돌아온 화면의 시각에 서서, 1차 정상화보다 앞에
       * 놓였다(11-10 8회차). 리포트 요약에서는 마지막으로 끊긴 때에 '포털 실패: n개 화면 안 돌아옴' 으로 둔다(카드와 같은 말)
       */
      const pend = t.svcPending.length
      if (pend) {
        const lastBad = Math.max(-Infinity, ...(ms.portalLog ?? []).filter((e) => e.kind !== 'up').map((e) => e.at))
        const failText = `포털 실패: ${pend}개 화면 안 돌아옴`
        out = out.map((r) =>
          r.target === 'portal' && / · 미복구 \d+$/.test(r.text) ? { ...r, at: Number.isFinite(lastBad) ? Math.max(r.at, lastBad) : r.at, sortAt: undefined, text: failText } : r,
        )
        // 돌아온 화면이 하나도 없으면 위 줄이 없다 — 마지막으로 끊긴 때에 같은 줄을 둔다
        if (!out.some((r) => r.text === failText) && Number.isFinite(lastBad))
          out.push({ at: lastBad, icon: null, text: failText, tone: 'bad', target: 'portal', ev: 'portal' })
      }
      // 다시 끊김이 접히지 않을 만큼 적으면(FLAP_FOLD_MIN 미만) 순간마다 줄이 섰다 — 요약은 첫 순간에 'n회' 한 줄
      /*
       * 1차 정상화 앞 · 뒤로 나눠 센다(코드 리뷰 11-10) — 한 줄로 합치면 1차 전 흔들림까지 세어 카드의 '1차 뒤 다시 끊김 n회'
       * (flapsAfterFirst)와 숫자가 달랐다. 셈은 portalPhases 와 같이 같은 순간(SAME_MS) 끊긴 화면을 한 번으로.
       */
      const reDown = out.filter((r) => r.target === 'portal' && r.text.startsWith('포털 다시 끊김'))
      if (reDown.length) {
        const downs = (ms.portalFlaps ?? []).map((f) => f.downAt)
        const fa = ph.firstAll
        out = out.filter((r) => !reDown.includes(r))
        const side = (xs: number[]) => {
          if (!xs.length) return
          out.push({ ...reDown[0], at: Math.min(...xs), sortAt: undefined, sub: undefined, text: `포털 다시 끊김 ${episodes(xs)}회` })
        }
        side(fa == null ? downs : downs.filter((x) => x <= fa))
        if (fa != null) side(downs.filter((x) => x > fa))
      }
      // 1차 뒤 다시 끊기지 않았으면 1차가 곧 최종이다 — 흐름(끊김 > 1차 > 다시 끊김 > 최종)에 맞춰 '1차 정상화' 로 부른다
      if (ph.firstAll != null && ph.flapsAfterFirst === 0)
        out = out.map((r) => (r.target === 'portal' && /^포털 (최종 )?정상화/.test(r.text) ? { ...r, text: r.text.replace(/^포털 (최종 )?정상화/, '포털 1차 정상화') } : r))
      return out.sort((a, b) => (a.sortAt ?? a.at) - (b.sortAt ?? b.at) || (a.ord ?? 0) - (b.ord ?? 0))
    }
    const tlTable = (rows: TimelineItem[], compact = false) => {
      const kept = compact ? condense(rows) : rows.filter((x) => !x.foldHead && keepRow(x))
      const sepAt = nb != null ? kept.findIndex((r) => r.at >= nb) : -1
      const span = compact ? 3 : 4
      return `<table class="grid tl"><thead><tr><th style="width:150px">시각</th><th class="c" style="width:78px">${elapsedHead}</th><th>내용</th>${compact ? '' : '<th style="width:230px">서버 기록</th>'}</tr></thead><tbody>${kept
        .map((r, k) => {
          const c = rowCls(r)
          const dim = !c && (r.text === '검증 시작' || (sepAt >= 0 && k >= sepAt && r.target !== 'portal'))
          const tag =
            c === 'kr' && allAt != null && (r.at === allAt || (r.target === 'portal' && t.allBy !== 'masakari' && allAt === ph.firstAll))
              ? '<span class="alltag">전체 복구</span>'
              : ''
          // 증적 원문 파일이면 증적이 있는 줄에서 그 원문으로 바로 간다
          const evK = kind === 'evidence' && r.ev ? resolveEvKey(r.ev, evKeys) : null
          const evLink = evK && evAnchor.has(evK) ? `<a class="tlev" href="#${evAnchor.get(evK)}">증적 →</a>` : ''
          // 수동 조치 뒤에 돌아온 포털은 '(조치 후)' — 그 정상화가 사람 손으로 된 것이라는 게 줄에서 보이게
          const afterFix = c === 'kr' && r.target === 'portal' && Number.isFinite(manualAt) && r.at > manualAt ? ' (조치 후)' : ''
          return `${k === sepAt ? `<tr class="sep"><td colspan="${span}">노드 UP 이후 (참고: 노드를 올린 시각에 따라 달라짐)</td></tr>` : ''}<tr${c || dim ? ` class="${c || 'dim'}"` : ''}><td class="num">${he(fmtDateTime(r.at))}</td><td class="num c">${since(r.at)}</td><td>${he(r.text)}${afterFix}${tag}${evLink}${!compact && r.sub ? `<br><span class="mut">${he(r.sub)}</span>` : ''}${!compact && r.tag ? `<br><span class="mut">${he(r.tag)}</span>` : ''}</td>${compact ? '' : `<td>${r.server ? `<span class="svr">${he(r.server)}</span>` : ''}</td>`}</tr>`
        })
        .join('')}</tbody></table>`
    }
    H.push(`<h3 id="tl-${i + 1}">타임라인</h3>${tlTable(withNotes(buildTimelineRows(ms, h.t0, 'summary')), true)}`)
    H.push(
      `<div class="legend"><span><i class="lk kd"></i>장애</span><span><i class="lk kr"></i>복구</span>${noteRows.length ? '<span><i class="lk ka"></i>사람 조치</span>' : ''}<span><i class="lk kf"></i>참고</span></div>`,
    )
    H.push(`<details class="ev"${opts.openEvidence ? ' open' : ''}><summary>전체 기록 (네임스페이스·노드마다 한 줄씩)</summary>${tlTable(withNotes(buildTimelineRows(ms, h.t0, 'full')))}</details>`)
    // 파드 로그 이상은 타임라인과 따로(10-29) — 오류는 표로 펼치고, 경고는 접어 둔다(화면의 LogIssueList 와 같은 기준)
    const logIs = [...(ms.logIssues ?? [])].sort((a, b) => a.at - b.at)
    if (inc.podLogs && logIs.length) {
      /*
       * 상태보드 목록(LogIssueList)과 같이 같은 문구는 한 줄로 합치고(횟수 합 · 처음은 가장 이른 · 마지막은 가장 늦은), 장애 시작 · 노드 UP 으로
       * 구간을 나눈다(2026-11-07 사용자 결정, lib/podLogList). 리포트는 펼칠 수 없어 'n건 합침' 같은 표시는 붙이지 않는다(사용자 결정).
       */
      const segLabel = (seg: number) =>
        // 이 표의 시각은 검증 시작 기준(+mm:ss)이라 구분 줄도 같은 기준으로 적는다
        seg === 0 ? '장애 시작 전 (평소에도 나던 것일 수 있음)' : seg === 1 ? `장애 시작 +${fmtElapsed(t.base - h.t0)} 뒤` : `노드 UP +${fmtElapsed((upAt as number) - h.t0)} 뒤`
      const logTable = (list: typeof logIs) => {
        let prev: number | null = null
        return `<table class="grid"><thead><tr><th class="c" style="width:70px">처음</th><th class="c" style="width:50px">종류</th><th style="width:130px">네임스페이스</th><th>무엇이</th><th class="c" style="width:44px">파드</th><th class="c" style="width:44px">횟수</th><th class="c" style="width:70px">마지막</th></tr></thead><tbody>${mergeLogIssues(list, t.fromDown ? t.base : null, upAt)
          .map((x) => {
            const sep = x.seg != null && x.seg !== prev ? `<tr class="sep"><td colspan="7">${he(segLabel(x.seg))}</td></tr>` : ''
            prev = x.seg
            return `${sep}<tr><td class="num c">+${fmtElapsed(x.at - h.t0)}</td><td class="c">${x.level === 'error' ? '오류' : '경고'}</td><td>${he(x.ns)}</td><td>${he(x.text)}</td><td class="num c">${x.pods}</td><td class="num c">${x.count ?? '-'}</td><td class="num c">${x.last != null ? `+${fmtElapsed(x.last - h.t0)}` : '-'}</td></tr>`
          })
          .join('')}</tbody></table>`
      }
      const errs = logIs.filter((x) => x.level === 'error')
      const warns = logIs.filter((x) => x.level === 'warn')
      H.push(`<h3>파드 로그 이상 (검증 중 새로 나온 것) · 오류 ${errs.length} · 경고 ${warns.length}</h3>`)
      H.push(errs.length ? logTable(errs) : `<div class="note">새로 나온 오류가 없습니다.</div>`)
      if (warns.length) H.push(`<details class="ev"${opts.openEvidence ? ' open' : ''}><summary>경고 ${warns.length}건</summary>${logTable(warns)}</details>`)
      const dropped = ms.logIssuesDropped
      if (dropped?.keys.length)
        H.push(`<div class="note">⚠ 오류 종류 한도(${LOG_ISSUES_MAX})를 넘어 +${fmtElapsed(dropped.since - h.t0)} 이후 새 종류 ${dropped.keys.length}건은 개수만 남겼습니다.</div>`)
    }
    if (inc.evidence) H.push(`<h3>증적 (서버 원문)</h3>`)
    if (inc.evidence && !evItems.length) H.push(`<div class="note">이 회차에는 저장된 증적이 없습니다. 증적 저장 기능 이전의 회차이거나 해당 마일스톤이 없었습니다.</div>`)
    const el = (at: number) => `${at < t.base ? '−' : '+'}${fmtElapsed(Math.abs(at - t.base))}`
    /*
     * 포털 증적(portalEvidence.ts) — 숫자 카드 → ① 일어난 순서 → ② 화면별 → ③ 연속 통과 기록 → ④ 원문(2026-11-07 사용자 결정, 목업).
     * 연속 통과 기록은 API 마다 한 줄로 줄이고, 1차 정상화 · 최종 정상화를 만든 표만 펼친다. 요청마다의 칸 · 나머지 정상화는 접는다.
     */
    const portalHtml = (v: PortalEvView, a: string): string => {
      const o = opts.openEvidence ? ' open' : ''
      const sFirst = v.streaks.find((x) => x.role === 'first')
      const sFinal = v.streaks.find((x) => x.role === 'final')
      const others = v.streaks.filter((x) => x !== sFirst && x !== sFinal)
      const n = v.screens != null ? ` · ${v.screens}/${v.screens} 화면` : ''
      const card = (label: string, big: string, small: string, k = false) => `<div${k ? ' class="k"' : ''}><span>${label}</span><b>${big}</b><small>${small}</small></div>`
      const P: string[] = []
      P.push(
        `<div class="pcards">${card('최초 끊김', v.first ? el(v.first.at) : '-', v.first ? `${fmtClock(v.first.at)} · ${he(v.first.label.replace(/^최초 끊김 \((.*)\)$/, '$1'))}` : '끊김 기록 없음')}${card(
          '1차 정상화',
          v.firstAll ? el(v.firstAll.at) : '-',
          v.firstAll ? `${fmtClock(v.firstAll.at)}${n}` : '아직 모두 정상이 된 적 없음',
          true,
        )}${card(v.firstAll ? '1차 뒤 다시 끊김' : '다시 끊김', `${v.flapTimes}회`, flapSmall(v))}${card(
          '최종 정상화',
          v.pending ? '실패' : v.final ? el(v.final.at) : v.firstAll ? el(v.firstAll.at) : '-',
          v.pending ? he(v.pending) : v.final ? `${fmtClock(v.final.at)}${n}` : v.firstAll ? '1차 정상화와 같음' : '',
          true,
        )}</div>`,
      )
      P.push(
        `<div class="psub">① 일어난 순서</div><table class="grid" style="margin:6px 0"><thead><tr><th style="width:170px">시각</th><th class="c" style="width:64px">경과</th><th>기록</th></tr></thead><tbody>${v.facts
          .map((f) => {
            const id = f.role === 'firstAll' ? `${a}-f1` : f.role === 'final' ? `${a}-f2` : ''
            const go = f.role === 'firstAll' && (sFirst || v.basis?.first.length) ? `${a}-s1` : f.role === 'final' && (sFinal || v.basis?.final.length) ? `${a}-s2` : ''
            return `<tr${id ? ` id="${id}" class="pk"` : ''}><td class="num">${he(f.at ? fmtDateTime(f.at) : f.text ?? '-')}</td><td class="num c">${f.at ? el(f.at) : ''}</td><td>${he(factLabel(f.label))}${
              go ? ` <a class="tlev" href="#${go}">연속 통과 기록 ↓</a>` : ''
            }</td></tr>`
          })
          .join('')}</tbody></table>`,
      )
      if (v.pages) P.push(`<div class="psub" id="${a}-pages">② 화면별</div>${tblHtml({ ...v.pages, title: '' })}`)
      /*
       * ③ 1차 · 최종 정상화 근거(화면별, 2026-11-09 사용자 요청 · 목업) — 그 순간 정상이던 모든 화면을 한 표로 보이고, 화면마다 API 별 기록을
       * 아래에 둔다(마지막으로 돌아온 화면만 펼침). 판정 기록이 있는 회차만 — 없으면 아래 예전 그림.
       */
      const basisHtml = (rows: PortalBasisRow[], title: string, id: string) =>
        `<div class="psub" id="${id}">${title}</div><div style="overflow:auto"><table class="grid"><thead><tr><th>화면</th><th class="c">첫 정상</th><th class="c">확정</th><th class="c">연속</th><th class="c">핵심 API</th><th>직전 응답에서 깨져 있던 API</th><th class="c">응답 시간(중앙값)</th></tr></thead><tbody>${rows
          .map(
            (r) =>
              `<tr${r.last ? ' class="pk"' : ''}><td>${he(r.name)}${r.last ? ' <span class="pill">마지막으로 돌아옴</span>' : ''}</td><td class="num c">${fmtClock(r.firstOk)}</td><td class="num c">${r.confirm ? fmtClock(r.confirm) : '-'}</td><td class="num c pass">✓ ${r.n ?? '-'}회</td><td class="num c">${r.apis || '-'}</td><td class="${r.broken.length ? 'fail' : 'mut'}">${r.broken.length ? he(r.broken.join(', ')) : '-'}</td><td class="num c">${r.median != null ? `${r.median}ms` : '-'}</td></tr>`,
          )
          .join('')}</tbody></table></div>${rows
          .map(
            (r) =>
              `<details class="ev"${r.last || o ? ' open' : ''}><summary>${he(r.name)} · API 별 기록</summary>${r.compact ? tblHtml({ ...r.compact, title: '' }) : ''}${
                r.tb ? `<details class="ev"${o}><summary>요청마다의 칸 보기 (${r.tb.columns.length - 1}회 × ${r.tb.rows.length - 1}개)</summary>${tblHtml({ ...r.tb, title: '' })}</details>` : ''
              }</details>`,
          )
          .join('')}`
      if (v.basis?.first.length) {
        const nb = v.basis.first.length
        P.push(basisHtml(v.basis.first, `③ 1차 정상화 근거 (${nb}/${nb} 화면) · ${v.firstAll ? fmtClock(v.firstAll.at) : ''} 모든 화면이 처음 동시에 정상`, `${a}-s1`))
        if (v.basis.final.length) {
          const nf = v.basis.final.length
          P.push(basisHtml(v.basis.final, `최종 정상화 근거 (${nf}/${nf} 화면) · 각 화면의 마지막 정상화`, `${a}-s2`))
        }
        if (v.basis.others.length)
          P.push(
            `<details class="ev"${o}><summary>그 밖의 정상화 확정 ${v.basis.others.length}건 (1차 · 최종에 쓰이지 않은 중간 정상화)</summary>${v.basis.others
              .map((r) => (r.compact ? tblHtml({ ...r.compact, title: `${r.name} · 첫 정상 ${fmtClock(r.firstOk)}` }) : ''))
              .join('')}</details>`,
          )
      } else if (v.streaks.length) {
        P.push(`<div class="psub">③ 연속 통과 기록 (정상화를 확정한 근거)</div>`)
        const one1 = (x: (typeof v.streaks)[number], id = '') =>
          x.compact
            ? `${tblHtml(x.compact, id)}<details class="ev"${o}><summary>요청마다의 칸 보기 (${x.tb.columns.length - 1}회 × ${x.tb.rows.length - 1}개)</summary>${tblHtml({ ...x.tb, title: '' })}</details>`
            : tblHtml(x.tb, id)
        if (sFirst) P.push(one1(sFirst, `${a}-s1`))
        if (sFinal) P.push(one1(sFinal, `${a}-s2`))
        if (others.length) P.push(`<details class="ev"${o}><summary>그 밖의 정상화 확정 ${others.length}건</summary>${others.map((x) => one1(x)).join('')}</details>`)
      }
      return P.join('')
    }
    // 묶음 머리는 묶음이 둘 이상일 때만 — 한 묶음뿐이면 이름이 아무것도 가르지 않는다
    const manyGrp = new Set(evArr.map((x) => x.grp)).size > 1
    let prevGrp = -1
    for (const { it, grp } of evArr) {
      if (manyGrp && grp !== prevGrp) H.push(`<div class="evgrp">${EV_GROUP_LABEL[grp]}</div>`)
      prevGrp = grp
      const lines = alignTabBlocks(it.text.split('\n'))
      const focus = (it.focus ?? []).filter(Boolean)
      // 진하게 칠할 근거 줄 — 보통 focus[0] 하나, 합친 Ceph 증적은 데이터 복구 · HEALTH_OK 둘
      const strong = new Set(focus.slice(0, strongFocusCount(it)).map((f) => lines.findIndex((l) => l.includes(f))).filter((x) => x >= 0))
      if (!strong.size) {
        const fi = lines.findIndex((l) => focus.some((f) => l.includes(f)))
        if (fi >= 0) strong.add(fi)
      }
      /*
       * 원문 줄(2026-11-10 사용자 요청): 보통 길이의 줄은 한 줄 그대로(창보다 넓으면 가로 스크롤), 200자를 넘는 줄만 접고 이어지는 줄은
       * 들여 쓴다. 다 접으면 열로 읽는 명령 출력이 줄마다 쪼개져 읽기 어렵고(증적 창 wrap 주석), 안 접으면 페이로드 한 줄이 화면 몇 배로 늘었다.
       */
      const pre = `<span class="lw">${lines
        .map((l, li) => {
          const cls = strong.has(li) ? ' h1l' : focus.some((f) => l.includes(f)) ? ' h2l' : ''
          return `<span class="ln${cls}">${he(l)}</span>`
        })
        .join('')}</span>`
      const a = evAnchor.get(it.key) as string
      H.push(`<details class="ev" id="${a}"${opts.openEvidence || kind === 'evidence' ? ' open' : ''}><summary>${he(it.title)}</summary>`)
      H.push(
        `<div class="evk"><span>${EV_LABEL.host}</span><span>${he(it.host)}</span><span>${EV_LABEL.at}</span><span>${he(fmtDateTime(it.capturedAt))} <span class="mut">(${EV_LABEL.atHint})</span></span><span>${evCmdOf(it).label}</span>${evCmdOf(it).code ? `<code>${he(it.command)}</code>` : `<span>${he(evCmdOf(it).text)}</span>`}${it.verifyCmd ? `<span>${EV_LABEL.verify}</span><span><code>${he(it.verifyCmd)}</code> <span class="mut">(${EV_LABEL.verifyHint})</span></span>` : ''}</div>`,
      )
      const v = it.key === 'portal' ? lay.portalV.get(it.key) : undefined
      if (v) {
        H.push(portalHtml(v, a))
        if (it.note) H.push(`<div class="note">${he(it.note)}</div>`)
        H.push(`<div class="psub">④ 원문 (판정이 바뀐 순간)</div><div class="pre" style="margin-top:6px">${pre}</div></details>`)
        continue
      }
      if (it.facts?.length)
        H.push(`<table class="grid" style="margin:6px 0"><thead><tr><th style="width:170px">시각 / 값</th><th>기록</th></tr></thead><tbody>${it.facts.map((f) => `<tr><td class="num">${he(f.at ? fmtDateTime(f.at) : f.text ?? '-').replace(/\n/g, '<br>')}</td><td>${he(factLabel(f.label))}</td></tr>`).join('')}</tbody></table>`)
      for (const tb of [it.table, ...(it.tables ?? [])]) if (tb) H.push(tblHtml(tb))
      if (it.note) H.push(`<div class="note">${he(it.note)}</div>`)
      // 분산 점검은 열로 읽는 표라 접지 않는다(2026-11-10 사용자 요청: 판정 칸이 접혀 다음 워크로드 줄에 섞였다) — 가로 스크롤
      H.push(`<div class="pre${it.key.startsWith('spread') ? ' nowrap' : ''}" style="margin-top:6px">${pre}</div></details>`)
    }
    H.push(`<a class="top" href="#top">↑ 맨 위로</a></div></details>`)
    // 왼쪽 목차 — 증적 원문 파일(회차 하나)에만. 여러 회차를 담는 회차별 · 종합 결과는 이번엔 붙이지 않았다
    if (kind === 'evidence' && one) {
      const nav: string[] = [`<a class="pl" href="#sum-${i + 1}">요약 (복구 시간)</a>`, `<a class="pl" href="#tl-${i + 1}">타임라인</a>`]
      let g = -1
      const hrefOf = (e: { key: string; part: '' | 'firstAll' | 'flap' | 'final' }) => {
        const a = evAnchor.get(e.key) as string
        const v = lay.portalV.get(e.key)
        return v ? portalPartId(v, a, e.part) : a
      }
      const link = (e: Parameters<typeof hrefOf>[0] & { at: number; label: string; tone: string; portal?: boolean }) =>
        `<a href="#${hrefOf(e)}"${e.tone ? ` class="${e.tone}"` : ''}><span class="t">${el(e.at)}</span>${e.portal ? `<span class="lbl"><span>${he(e.label)}</span><i class="pb">포털</i></span>` : `<span>${he(e.label)}</span>`}</a>`
      for (const e of tocEntries(evArr, t.base, upAt, { masaDone: lay.masaDone, portal: (it) => lay.portalV.get(it.key) as PortalEvView })) {
        if (e.grp !== g) nav.push(`<div class="grp">${EV_GROUP_LABEL[e.grp]}</div>`)
        g = e.grp
        nav.push(e.fold ? `<details class="tf"><summary><span class="t">${el(e.at)}</span><span>${he(e.label)}</span></summary>${e.fold.map(link).join('')}</details>` : link(e))
      }
      tocNav = `<nav class="toc" id="toc"><div class="tt">목차${evArr.length ? '<button type="button" id="evAll">모두 접기</button>' : ''}</div>${nav.join('')}</nav>`
    }
  })
  H.push(`</section>`)
  if (kind === 'total') H.splice(runsStart)

  // 맨 아래 절 이름은 '참고사항'(10-30 사용자 요청, 예전 '읽는 법')
  if (tocNav) H[pageIdx] = H[pageIdx].replace(/<div class="page">$/, `<div class="page wtoc">${tocNav}<div class="tmain">`)
  // 참고사항은 종합 · 회차별 · 증적 원문 모두에서 뺐다(2026-11-10 사용자 요청: 숫자 아래 긴 설명이 오히려 방해). 예전 한 파일(all)에만 남는다
  if (kind === 'all') H.push(`<section class="sec" id="notes"><div class="sh"><span class="n">i</span><h2>참고사항</h2></div><ul class="sum">
<li><b>기준 시각(장애 시작)</b> 복구 시간은 모두 장애 시작부터 잽니다. 장애 주입 시각(수동 입력 · 버튼)이 있으면 그 시각을, 없으면 노드 DOWN 시각을 씁니다. DOWN 시각은 클러스터 저널에 노드 이탈 기록이 있고 Q-Term 감지보다 2분 안쪽으로 앞서면 그 서버 기록을, 없으면 Q-Term 이 처음 본 시각(pcs OFFLINE)입니다. Q-Term 은 몇 초~수십 초 늦게 보기 때문에 그대로 쓰면 복구 시간이 짧게 나옵니다. VIP 이동도 pacemaker 가 남긴 start 시각을 같은 원칙으로 씁니다. DOWN 을 감지하지 못한 회차만 검증 시작부터 재고 * 로 표시합니다. 타임라인의 경과도 같은 기준입니다.</li>
<li><b>복구 이정표와 참고</b> 장애 대응을 보는 구간은 장애 시작부터 Masakari evacuation 완료와 포털 1차 정상화(처음으로 모든 화면 정상)까지이고, 전체 복구는 둘 중 마지막으로 완료된 시점입니다. 포털 최종 정상화 · 파드 · Ceph · 노드 복귀는 노드를 다시 올린 시각에 따라 달라지므로 참고로만 적습니다.</li>
<li><b>Q-Term 관측</b> 상태보드가 주기적으로 조회해 처음 확인한 시각입니다. 복구는 연속 성공(포털 N회 · Ceph 2회)으로 확정하므로 한 번 튄 성공은 복구로 세지 않습니다. 표와 판정은 이 시각 기준입니다.</li>
<li><b>서버 기록</b> pacemaker(동작 이력) · corosync 저널 · k8s(Ready 전환) · Nova(VM 별 evacuation) · masakari-engine 로그가 스스로 남긴 시각입니다. 시간대가 없는 표기는 그 서버 시계를 Q-Term PC 시계로 보정했고, UTC 기록은 이 PC 시간대로 바꿔 표시했습니다.</li>
<li><b>증적 원문</b> 마일스톤이 찍힌 순간 떠 둔 원문입니다. 진한 노란 줄이 그 시각의 근거입니다. k8s 이벤트(1시간 보관)·pacemaker 이력(cleanup 시 삭제)은 나중에 다시 구할 수 없을 수 있습니다.</li>
</ul></section>`)
  H.push(`${tocNav ? '</div>' : ''}</div>
<script>
// 비교표·흐름의 회차 이름을 누르면 그 상세를 펼치고 이동한다(스크립트가 꺼져 있어도 이동은 된다)
document.querySelectorAll('[data-open]').forEach(function(a){a.addEventListener('click',function(){var d=document.getElementById(a.getAttribute('data-open'));if(d)d.open=true})});
if(location.hash){var d=document.getElementById(location.hash.slice(1));if(d&&d.tagName==='DETAILS')d.open=true}
// 증적 목차 · 타임라인의 '증적 →': 접혀 있으면(회차까지) 펼치고 도착한 상자를 잠깐 강조한다
document.querySelectorAll('a[href^="#ev-"]').forEach(function(a){a.addEventListener('click',function(){var d=document.getElementById(a.getAttribute('href').slice(1));if(!d)return;for(var p=d;p;p=p.parentElement)if(p.tagName==='DETAILS')p.open=true;d.classList.remove('flash');void d.offsetWidth;d.classList.add('flash')})});
(function(){var toc=document.getElementById('toc');if(!toc)return;
var b=document.getElementById('evAll'),evs=function(){return document.querySelectorAll('details.ev[id^="ev-"]')};
if(b)b.onclick=function(){var ds=evs(),anyClosed=[].some.call(ds,function(d){return!d.open});ds.forEach(function(d){d.open=anyClosed});b.textContent=anyClosed?'모두 접기':'모두 펼치기'};
// 지금 보고 있는 구간을 목차에 표시한다(본문은 움직이지 않고 목차 안에서만 따라간다)
var links=[].slice.call(toc.querySelectorAll('a')),targets=links.map(function(a){return document.getElementById(a.getAttribute('href').slice(1))});
// 목차는 시각순이고 본문은 증적 순서라 둘이 다르다 — '목차에서 마지막으로 지나친 것' 이 아니라 화면 위쪽에 가장 가까운 대상을 켠다(코드 점검 11-07)
function spy(){var y=window.scrollY+80,cur=0,best=-Infinity;targets.forEach(function(t,i){if(!t||t.offsetParent===null)return;var top=t.getBoundingClientRect().top+window.scrollY;if(top<=y&&top>best){best=top;cur=i}});
links.forEach(function(a,i){a.classList.toggle('on',i===cur)});var on=links[cur];
if(on&&getComputedStyle(toc).position==='sticky'){var r=on.offsetTop-toc.scrollTop;if(r<30||r>toc.clientHeight-30)toc.scrollTop=on.offsetTop-toc.clientHeight/2}}
window.addEventListener('scroll',spy,{passive:true});spy()})();
</script></body></html>`)
  return H.join('\n')
}

/** 무엇을 만들까 — 리포트 만들기 창의 세 가지(10-29 사용자 결정). 다음에도 기억한다 */
interface ReportKinds {
  total: boolean
  runs: boolean
  evidence: boolean
  /** 포털 API 응답 시간(2026-11-19) — 없으면 끔(예전에 저장한 값 · 보고용 · 기술 검토용 묶음) */
  latency?: boolean
}
const REPORT_KINDS_KEY = 'report_kinds_v1'
const REPORT_KINDS_DEFAULT: ReportKinds = { total: true, runs: true, evidence: false }
function loadReportKinds(): ReportKinds {
  try {
    const v = JSON.parse(localStorage.getItem(REPORT_KINDS_KEY) || 'null')
    return v && typeof v === 'object' ? { ...REPORT_KINDS_DEFAULT, ...v } : { ...REPORT_KINDS_DEFAULT }
  } catch {
    return { ...REPORT_KINDS_DEFAULT }
  }
}
function saveReportKinds(v: ReportKinds): void {
  try {
    localStorage.setItem(REPORT_KINDS_KEY, JSON.stringify(v))
  } catch {
    /* 저장 못 해도 이번에는 쓴다 */
  }
}
/** 리포트를 한 파일로 만들까(2026-11-12 사용자 결정: 기본 한 파일, 따로 받고 싶은 사람은 끈다). 다음에도 기억한다 */
const REPORT_ONEFILE_KEY = 'report_onefile_v1'
/**
 * 종합 결과 제목(2026-11-20 사용자 결정) — 리포트 만들기에서 '종합 결과 보고' · '중간 결과 보고' 를 고른다. 같은 그룹으로 진행 중엔 중간,
 * 끝나면 종합을 뽑으므로 그룹이 아니라 뽑을 때 정한다. 바뀌는 것은 종합 결과 제목 · 파일 이름(한 파일 리포트 포함)뿐이고 내용은 같다
 * (중간 보고에도 검증 결과 · 실패 사유를 싣는다 — 사용자 확인). 회차별 · 증적 · API 응답 파일은 첨부 자료라 제목을 바꾸지 않는다
 */
type ReportTitle = 'final' | 'mid'
const REPORT_TITLE: Record<ReportTitle, string> = { final: '가용성 검증 종합 결과 보고', mid: '가용성 검증 중간 결과 보고' }
const REPORT_TITLE_FILE: Record<ReportTitle, string> = { final: '종합결과보고', mid: '중간결과보고' }
const REPORT_TITLE_KEY = 'report_title_v1'
function loadReportTitle(): ReportTitle {
  try {
    return localStorage.getItem(REPORT_TITLE_KEY) === 'mid' ? 'mid' : 'final'
  } catch {
    return 'final'
  }
}
function loadReportOneFile(): boolean {
  try {
    return localStorage.getItem(REPORT_ONEFILE_KEY) !== '0'
  } catch {
    return true
  }
}
function saveReportOneFile(v: boolean): void {
  try {
    localStorage.setItem(REPORT_ONEFILE_KEY, v ? '1' : '0')
  } catch {
    /* 저장 못 해도 이번에는 쓴다 */
  }
}
const stampOf = (t: number, sec = false) => {
  const d = new Date(t)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${sec ? p(d.getSeconds()) : ''}`
}
/** 파일 이름에 못 쓰는 글자 · 공백 정리 — 회차 이름은 사람이 넣은 것이라 '/' · ':' 가 섞일 수 있다 */
const fileSafe = (s: string) => s.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/\s+/g, '_').slice(0, 60)

/**
 * 한 파일 리포트(2026-11-12 사용자 결정) — 종합 결과 · 회차별 결과 · 증적 원문(회차마다)을 **따로 만든 그대로** 한 HTML 에 담는다.
 * 받는 사람이 파일 여러 개를 같은 폴더에 두지 않아도 되게 하되, 보는 방식은 여러 파일과 같다: 종합 결과에서 회차를 누르면 회차별 결과의
 * 그 회차로, '증적 →' 을 누르면 그 회차 증적만 있는 화면으로 바뀐다(한 페이지에 다 늘어놓으면 8회차에 증적 상자 900개가 한 화면이 된다).
 *
 * 화면마다 iframe(srcdoc)에 그 페이지 원문을 그대로 띄운다 — 페이지마다 같은 id(run-1 · ev-…)와 스크립트 · 목차가 있어 한 문서에 합치면 서로
 * 부딪친다. 원문은 JSON 으로 품고 보이는 화면 하나만 그리므로 증적이 수 MB 여도 열 때 무겁지 않다.
 *  - 파일 사이 링크(runsFile · evFiles · totalFile)는 손대지 않는다: 페이지 안 스크립트가 같은 이름의 화면으로 바꿔 달라고 부모에 알린다
 *  - srcdoc 문서의 기준 주소는 부모 파일이라 '#run-3' 같은 페이지 안 링크가 부모 파일로 빠져나간다 — 페이지 안 링크도 직접 이동시킨다
 *  - 화면 바꿈은 주소 뒤 #p1/run-3 로 남겨 브라우저 뒤로 가기가 된다
 *  - Ctrl+P 는 보이는 화면을 인쇄한다(부모를 인쇄하면 iframe 한 장만 나온다). PDF 는 이 방식을 쓰지 않는다(파일 사이 이동이 없다)
 */
const BUNDLE_CHILD = `<script>(function(){var P=window.parent;if(P===window)return;
function go(id){if(!id){window.scrollTo(0,0);return}var d=document.getElementById(id);if(!d)return;for(var p=d;p;p=p.parentElement)if(p.tagName==='DETAILS')p.open=true;d.scrollIntoView();if(id.indexOf('ev-')===0){d.classList.remove('flash');void d.offsetWidth;d.classList.add('flash')}}
window.addEventListener('message',function(e){if(e.source!==P)return;var m=e.data||{};if(typeof m.qtGo==='string')go(m.qtGo);if(m.qtPrint)window.print()});
document.addEventListener('click',function(e){var a=e.target&&e.target.closest?e.target.closest('a[href]'):null;if(!a)return;var h=a.getAttribute('href')||'';if(/^[a-z]+:/i.test(h)){e.preventDefault();window.open(h,'_blank');return}
e.preventDefault();var i=h.indexOf('#'),f=i<0?h:h.slice(0,i),id=i<0?'':h.slice(i+1);if(!f){go(id);return}P.postMessage({qtNav:decodeURIComponent(f),a:id},'*')});
document.addEventListener('keydown',function(e){if((e.ctrlKey||e.metaKey)&&(e.key==='p'||e.key==='P')){e.preventDefault();window.print()}});
P.postMessage({qtTitle:document.title},'*')})();</script>`
function bundleReportHtml(files: { name: string; html: string }[], title: string): string {
  const keyOf = new Map(files.map((f, i) => [`${f.name}.html`, `p${i}`]))
  const pages: Record<string, string> = {}
  files.forEach((f, i) => {
    const at = f.html.lastIndexOf('</body>')
    pages[`p${i}`] = at < 0 ? f.html + BUNDLE_CHILD : f.html.slice(0, at) + BUNDLE_CHILD + f.html.slice(at)
  })
  // </script> 로 품은 JSON 이 끊기지 않게 '<' 를 이스케이프한다
  const json = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c')
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${he(title)}</title>
<style>html,body{margin:0;height:100%;overflow:hidden;background:#eef1f6}iframe{position:fixed;inset:0;width:100%;height:100%;border:0;background:#eef1f6}</style></head>
<body><iframe id="qtv" title="${he(title)}"></iframe>
<script id="qt-pages" type="application/json">${json(pages)}</script>
<script id="qt-names" type="application/json">${json(Object.fromEntries(keyOf))}</script>
<script>(function(){var pages=JSON.parse(document.getElementById('qt-pages').textContent),names=JSON.parse(document.getElementById('qt-names').textContent),f=document.getElementById('qtv'),cur=null,pend='';
function parse(){var h=location.hash.slice(1),i=h.indexOf('/'),p=i<0?h:h.slice(0,i);return pages[p]?{p:p,a:i<0?'':decodeURIComponent(h.slice(i+1))}:{p:'p0',a:''}}
function show(){var r=parse();if(r.p!==cur){cur=r.p;pend=r.a;f.srcdoc=pages[r.p]}else if(f.contentWindow)f.contentWindow.postMessage({qtGo:r.a},'*')}
f.addEventListener('load',function(){if(f.contentWindow)f.contentWindow.postMessage({qtGo:pend},'*');pend=''});
window.addEventListener('message',function(e){if(e.source!==f.contentWindow)return;var m=e.data||{};
if(typeof m.qtNav==='string'){var k=names[m.qtNav];if(k){var nh='#'+k+(m.a?'/'+encodeURIComponent(m.a):'');if(location.hash===nh)show();else location.hash=nh}}
if(typeof m.qtTitle==='string'&&m.qtTitle)document.title=m.qtTitle});
window.addEventListener('hashchange',show);
document.addEventListener('keydown',function(e){if((e.ctrlKey||e.metaKey)&&(e.key==='p'||e.key==='P')){e.preventDefault();if(f.contentWindow)f.contentWindow.postMessage({qtPrint:1},'*')}});
show()})();</script></body></html>`
}

/**
 * 고른 종류대로 리포트 파일을 만든다(10-29). 한 파일이면 예전처럼 저장 창, 여러 파일이면 폴더를 한 번만 고른다.
 * 증적 원문은 **회차마다 한 파일**(사용자 결정) — 문의가 오면 그 회차 파일만 건네면 되고, 증적을 다 몰면 수십 MB 라 열기가 무겁다.
 * 증적이 하나도 없는 회차(증적 저장 이전)는 빈 파일을 만들지 않고 건너뛴 수를 알린다.
 * HTML 은 기본으로 이 파일들을 한 파일에 담는다(bundleReportHtml, 2026-11-12) — 화면은 따로라 증적을 다 몰아도 보이는 화면 하나만 그린다.
 */
async function makeRunsReport(
  recs: HistoryRecord[],
  fmt: 'html' | 'pdf',
  kinds: ReportKinds,
  rto?: RtoTargets,
  items?: ReportItems,
  /** HTML 을 한 파일로(bundleReportHtml) — 기본. 끄면 예전처럼 종류마다 · 회차마다 따로 */
  oneFile = true,
  /** 고른 회차가 모두 든 검증 그룹(buildHtmlReport opts.group) · VM 실제 이름 여부 */
  group?: VerifyGroup,
  realNames = false,
  /** 환경 구성도 HTML(renderEnvMapHtml) — 있으면 종합 결과 다음 파일로 같이 뽑고 검증 환경에서 링크한다 */
  envMapHtml?: string,
  /** 종합 결과 제목(REPORT_TITLE) */
  reportTitle: ReportTitle = 'final',
  /** 포털 API 응답 조치 전 · 후 비교(LatCmpPick) — 종합 결과 요약 · 포털 API 응답 파일 맨 위 */
  latCmp?: LatCmpPick,
): Promise<{ msg: string; path?: string }> {
  const evidence: Record<string, BoardEvidenceItem[]> = {}
  /** 증적을 **읽지 못한** 회차 — '증적이 없는 회차' 와 섞으면 복호화 실패 등으로 못 읽은 증적이 '저장 기능 이전' 으로 둔갑한다(조회 실패 ≠ 없음) */
  const readFail: HistoryRecord[] = []
  if (kinds.evidence)
    for (const h of recs) {
      const r = await window.electronAPI.boardEvidenceRead(h.id).catch((e) => ({ ok: false, items: [] as BoardEvidenceItem[], error: String(e) }))
      if (!r.ok) readFail.push(h)
      evidence[h.id] = r.items ?? []
    }
  const stamp = stampOf(Date.now(), true)
  const n = recs.length
  const ext = fmt === 'pdf' ? '.pdf' : '.html'
  /*
   * 파일 이름(2026-11-11 사용자 결정) — 여러 회차면 '(총합)', 한 회차면 증적 파일처럼 회차 이름을 붙인다. 사용자가 받은 파일을
   * '종합결과(총합)' · '회차별상세결과(총합)' 으로 손수 고쳐 쓰고 있었는데, 그러면 파일 사이 링크(종합 → 회차별 23곳)가 옛 이름을 가리켜 끊겼다.
   */
  const scope = n === 1 ? `_${fileSafe(recs[0].label || recs[0].node || '회차')}` : '(총합)'
  const runsName = `가용성검증_회차별상세결과${scope}_${stamp}`
  const files: { name: string; html: string }[] = []
  // 종합 결과의 회차 링크는 같이 뽑는 회차별 결과(HTML)로 — PDF 는 파일 사이 링크가 안 되므로 걸지 않는다
  const runsFile = kinds.runs && fmt === 'html' ? `${runsName}.html` : undefined
  const pdf = fmt === 'pdf'
  const totalName = `가용성검증_${REPORT_TITLE_FILE[reportTitle]}${scope}_${stamp}`
  // 파일 사이 링크(buildHtmlReport opts.evFiles · totalFile 주석) — 이름을 먼저 정해 두고 서로 건다. 파일이 둘 이상일 때만(한 파일이면 갈 곳이 없다)
  /*
   * 증적 파일 이름 — 이름 · 노드가 같고 같은 분에 시작한 회차는 이름이 겹친다. 저장할 때 뒤 파일에 ' (2)' 가 붙으면서 링크 바꾸기가 두 회차의
   * 링크를 함께 바꿔, 종합 결과에서 1회차의 '증적 →' 이 2회차 파일로 갔다(코드 리뷰 11-10). 여기서 미리 번호를 붙여 겹치지 않게 한다.
   */
  const evItemsSel: ReportItems = { ...(items ?? REPORT_ALL), evidence: true }
  const evCount = (h: HistoryRecord) => (evidence[h.id] ?? []).filter((it) => evKeep(it.key, evItemsSel)).length
  const evRecs = kinds.evidence ? [...recs].sort((a, b) => a.t0 - b.t0).filter((h) => !readFail.includes(h) && evCount(h)) : []
  const evNames = new Map<string, string>()
  const usedEv = new Set<string>()
  for (const h of evRecs) {
    const b = `가용성검증_증적_${fileSafe(h.label || h.node || '회차')}_${stampOf(h.t0)}`
    let nm = b
    for (let k = 2; usedEv.has(nm.toLowerCase()); k++) nm = `${b}_${k}`
    usedEv.add(nm.toLowerCase())
    evNames.set(h.id, nm)
  }
  const evName = (h: HistoryRecord) => evNames.get(h.id) as string
  const envName = `가용성검증_환경구성도${scope}_${stamp}`
  const latName = `가용성검증_포털API응답시간${scope}_${stamp}`
  const nFiles = (kinds.total ? 1 : 0) + (kinds.runs ? 1 : 0) + evRecs.length + (envMapHtml ? 1 : 0) + (kinds.latency ? 1 : 0)
  const linkOn = !pdf && nFiles > 1
  const envFile = linkOn && envMapHtml && kinds.total ? `${envName}.html` : undefined
  const evFiles = linkOn && evRecs.length ? Object.fromEntries(evRecs.map((h) => [h.id, `${evName(h)}.html`])) : undefined
  const totalFile = linkOn && kinds.total ? `${totalName}.html` : undefined
  const latFile = linkOn && kinds.latency ? `${latName}.html` : undefined
  if (kinds.total) files.push({ name: totalName, html: buildHtmlReport(recs, {}, { kind: 'total', openEvidence: pdf, rto, items, runsFile, evFiles, group, realNames, envFile, latFile, reportTitle, latCmp }) })
  // 구성도 머리의 '← 종합 결과' — 링크가 걸릴 때만(파일 이름 자리표시를 바꾼다, renderEnvMapHtml totalFile)
  // 걸 곳이 없으면(PDF · 종합 결과 없음) 링크째 뺀다 — 빈 링크는 눌러도 아무 일이 없어 고장으로 보인다
  if (envMapHtml)
    files.push({
      name: envName,
      html: envMapHtml.replace(/<a href="__QT_TOTAL_FILE__"[^>]*>← 종합 결과<\/a>/, (a) => (totalFile ? a.replace('__QT_TOTAL_FILE__', he(encodeURIComponent(totalFile))) : '')),
    })
  if (kinds.runs) files.push({ name: runsName, html: buildHtmlReport(recs, {}, { kind: 'runs', openEvidence: pdf, rto, items, evFiles, totalFile, group }) })
  // 포털 API 응답 시간 — 이것만 고르면 이 파일 하나(문제 API 를 그 파일만 건네려고, 2026-11-19 사용자 결정)
  if (kinds.latency) files.push({ name: latName, html: buildHtmlReport(recs, {}, { kind: 'latency', openEvidence: pdf, rto, items, totalFile, group, latCmp }) })
  const noEv = kinds.evidence ? recs.filter((h) => !readFail.includes(h) && !evCount(h)).length : 0
  for (const h of evRecs)
    files.push({
      name: evName(h),
      html: buildHtmlReport([h], evidence, { kind: 'evidence', openEvidence: pdf, rto, items, totalFile, group }),
    })
  const skipped =
    (noEv ? ` 고른 항목의 증적이 없는 회차 ${noEv}개는 증적 원문을 만들지 않았습니다(증적 저장 기능 이전의 회차이거나, 고른 항목에 맞는 증적이 없음).` : '') +
    (readFail.length ? ` 증적을 읽지 못한 회차 ${readFail.length}개(${readFail.map((h) => h.label || fmtDateTime(h.t0)).slice(0, 3).join(', ')}${readFail.length > 3 ? ' 외' : ''})는 증적 원문을 만들지 못했습니다. 다시 시도해 보세요.` : '')
  if (!files.length) return { msg: `만들 것이 없습니다.${skipped}` }
  if (oneFile && !pdf && files.length > 1) {
    // 종합 결과가 들었으면 한 파일 이름 · 제목도 고른 보고 제목으로(REPORT_TITLE 주석)
    const name = kinds.total ? `가용성검증_${REPORT_TITLE_FILE[reportTitle]}${scope}_${stamp}` : `가용성검증_결과${scope}_${stamp}`
    const html = bundleReportHtml(files, `${kinds.total ? REPORT_TITLE[reportTitle] : '가용성 검증 결과'}${n === 1 ? `: ${recs[0].label || recs[0].node}` : ''}`)
    const res = await window.electronAPI.saveReport({ defaultName: `${name}.html`, content: html, format: 'html' })
    if (res.saved) return { msg: `저장했습니다(${files.length}개 화면을 한 파일에). ${res.path ?? ''}${skipped}`, path: res.path }
    return { msg: res.error ? `저장 실패: ${res.error}` : '저장하지 않았습니다(저장 창을 닫았습니다).' }
  }
  // 취소도 말로 남긴다 — 예전엔 빈 문구라, 폴더를 골랐는데 취소로 돌아온 경우 '저장했는데 파일이 없다' 로 보였다(사용자 지적 10-29)
  const CANCELED = '저장하지 않았습니다(저장 창을 닫았습니다).'
  if (files.length === 1) {
    const f = files[0]
    const res = pdf
      ? await window.electronAPI.saveReportPdf({ html: f.html, defaultName: `${f.name}${ext}` })
      : await window.electronAPI.saveReport({ defaultName: `${f.name}${ext}`, content: f.html, format: 'html' })
    if (res.saved) return { msg: `저장했습니다. ${res.path ?? ''}${skipped}`, path: res.path }
    return { msg: res.error ? `저장 실패: ${res.error}` : CANCELED }
  }
  const res = await window.electronAPI.saveReportMany({ files, format: fmt })
  if (!res.saved) return { msg: res.error ? `저장 실패: ${res.error}` : CANCELED }
  const partial = res.error ? ` 일부만 저장했습니다(${res.paths?.length ?? 0}/${files.length}): ${res.error}.` : ''
  return { msg: `${res.paths?.length ?? files.length}개 파일을 저장했습니다. ${res.dir ?? ''}${partial}${skipped}`, path: res.paths?.[0] }
}

/** 이력 한 회차를 제출용 Markdown 으로 — 툴 타임라인 + 증적(서버 원문·서버 기록 시각) */
function buildRunReport(h: HistoryRecord, items: BoardEvidenceItem[]): string {
  /** 표 칸 — 포털·워크로드 이름에 | 가 있으면 표가 깨진다 */
  const cell = (v: unknown) => String(v ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')
  const ms = { ...h.milestones, pods: h.milestones.pods ?? [], portal: h.milestones.portal ?? [] }
  const rows = buildTimelineRows(ms, h.t0).filter((x) => !x.foldHead)
  const L: string[] = []
  L.push(`# 가용성 검증 회차: ${h.label || h.node} (${fmtDateTime(h.t0)})`, '')
  const t = runTotals(h)
  L.push(
    `- 대상 노드: ${h.node}`,
    `- 검증 시작: ${fmtDateTime(h.t0)}`,
    // 기준 · 포털 · 전체 복구는 HTML 리포트와 같은 정의(runTotals 주석, 10-30 사용자 결정)
    `- 장애 시작 (복구 시간의 기준): ${
      t.fromInject
        ? `${fmtDateTime(t.base)} (장애 주입 · DOWN 감지 +${fmtElapsed((t.downAt as number) - t.base)})`
        : t.fromDown
          ? `${fmtDateTime(t.base)} (DOWN 감지)`
          : '- (DOWN 감지 못함: 아래 시간은 검증 시작 기준)'
    }`,
    `- Masakari 완료: ${masaFailOf(h.milestones) ? `실패 (${masaFailText(h.milestones)})` : h.milestones.masakari ? fmtSigned(h.milestones.masakari.at - t.base) : '-'}`,
    `- 포털 1차 정상화 (처음으로 모든 화면 정상): ${
      t.svcPending.length
        ? `미복구(Fail): ${t.svcPending.join(', ')}${t.svc != null ? ` (1차 정상화 ${fmtSigned(t.svc)} 뒤 다시 끊김)` : ''}`
        : t.svc == null
          ? '- (포털 끊김 기록 없음)'
          : fmtSigned(t.svc)
    }`,
    `- 전체 복구 (Masakari 완료(VM 모두 이동) · 포털 1차 정상화 중 마지막으로 완료된 시점): ${t.all != null ? fmtElapsed(t.all) : t.allFail ? '미복구' : '- (잴 것 없음)'}`,
    `- 참고: ${
      [
        t.svcFinal != null && t.svc != null && t.svcFinal > t.svc + 999 ? `포털 최종 정상화 ${fmtSigned(t.svcFinal)}` : '',
        h.milestones.cephHealthy
          ? `Ceph HEALTH_OK ${fmtSigned(h.milestones.cephHealthy.at - t.base)}`
          : h.milestones.ceph
            ? `Ceph 데이터 복구 ${fmtSigned(h.milestones.ceph.at - t.base)}`
            : '',
        nodeBackAt(ms) != null ? `노드 복귀 ${fmtSigned((nodeBackAt(ms) as number) - t.base)}` : '',
      ]
        .filter(Boolean)
        .join(' · ') || '-'
    }`,
    '',
  )
  // 세부 원인 및 조치(RunNote 주석) — HTML 리포트와 같은 글. 사람이 적은 글이라 IP · 토큰이 섞일 수 있어 내보내기 마스킹을 거친다
  const notesOk = (h.notes ?? []).filter((n) => n.cause.trim())
  if (notesOk.length) {
    L.push('## 세부 원인 및 조치', '')
    for (const n of notesOk) {
      L.push(`### ${NOTE_STEP_LABEL[n.step]}${n.step === 'manual' && n.recovered ? ' (이 조치로 복구됨: 회차는 실패로 셈)' : ''}`, '')
      if (n.why?.trim()) L.push(`- 이슈 : ${maskForExport(n.cause.replace(/\n/g, ' '))}`, `- 원인 : ${maskForExport(n.why.replace(/\n/g, ' '))}`)
      else L.push(`- 원인 : ${maskForExport(n.cause.replace(/\n/g, ' '))}`)
      if (n.action?.trim()) L.push(`- 조치 : ${maskForExport(n.action.replace(/\n/g, ' '))}`)
      if (n.owner?.trim()) L.push(`- 담당자 : ${maskForExport(n.owner)}`)
      if (n.at != null) L.push(`- 조치 시각 : ${fmtDateTime(n.at)}`)
      L.push('')
    }
  }
  L.push('## 복구 타임라인', '', `| 시각 | ${t.fromDown ? '장애 시작 후' : '검증 시작 후'} | 내용 | 비고 |`, '|---|---|---|---|')
  for (const r of rows) L.push(`| ${fmtDateTime(r.at)} | ${r.at < t.base ? '−' : '+'}${fmtElapsed(Math.abs(r.at - t.base))} | ${cell(r.text)} | ${cell([r.sub, r.tag, r.server].filter(Boolean).join(' · '))} |`)
  L.push('')
  const logIs = [...(ms.logIssues ?? [])].sort((a, b) => a.at - b.at)
  if (logIs.length) {
    L.push('## 파드 로그 이상 (검증 중 새로 나온 것)', '', '| 처음 | 종류 | 네임스페이스 | 무엇이 | 파드 | 횟수 | 마지막 |', '|---|---|---|---|---|---|---|')
    for (const x of logIs)
      L.push(`| +${fmtElapsed(x.at - h.t0)} | ${x.level === 'error' ? '오류' : '경고'} | ${cell(x.ns)} | ${cell(x.text)} | ${x.pods} | ${x.count ?? '-'} | ${x.last != null ? `+${fmtElapsed(x.last - h.t0)}` : '-'} |`)
    L.push('')
  }
  if (!items.length) {
    L.push('_이 회차에는 저장된 증적이 없습니다(증적 저장 기능 이전의 회차이거나, 해당 마일스톤이 없었습니다)._')
    return L.join('\n')
  }
  L.push('## 증적 (서버 원문)', '')
  // 리포트와 같게 — 검증 중에 누른 분산 점검은 빼고, 옛 '필수 분산' 문장은 새 문장으로(runEvidenceLayout)
  for (const it0 of items) {
    if (it0.key.startsWith('spread:')) continue
    const it = it0.key === 'spread' ? { ...it0, text: spreadTextNow(it0.text) } : it0
    L.push(`### ${it.title}`, '')
    L.push(`- ${EV_LABEL.host}: ${it.host} · ${EV_LABEL.at}: ${fmtDateTime(it.capturedAt)} (${EV_LABEL.atHint})`)
    L.push(evCmdOf(it).code ? `- ${EV_LABEL.cmd}: \`\` ${it.command} \`\`` : `- ${evCmdOf(it).label}: ${evCmdOf(it).text}`)
    if (it.verifyCmd) L.push(`- ${EV_LABEL.verify} (${EV_LABEL.verifyHint}): \`\` ${it.verifyCmd} \`\``)
    L.push('')
    if (it.facts?.length) {
      L.push('| 기록 | 시각 / 값 |', '|---|---|')
      for (const f of it.facts) L.push(`| ${cell(factLabel(f.label))} | ${cell(f.at ? fmtDateTime(f.at) : f.text ?? '-')} |`)
      L.push('')
    }
    for (const tb of [it.table, ...(it.tables ?? [])]) {
      if (!tb) continue
      L.push(`**${tb.title}**`, '', `| ${tb.columns.map(cell).join(' | ')} |`, `|${tb.columns.map(() => '---').join('|')}|`)
      // Markdown 에는 마우스 설명이 없다 — 실패 칸(✗)만 사유를 괄호로 붙인다. 시간 초과는 '✗ -' 만으로는 왜인지 안 보였다(코드 검토 10-29)
      tb.rows.forEach((r, ri) => {
        const ct = tb.cellTitles?.[ri]
        L.push(`| ${r.map((c, ci) => cell(c.startsWith('✗') && ct?.[ci] ? `${c} (${ct[ci]})` : c)).join(' | ')} |`)
      })
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
  if (res.saved) return `저장했습니다. ${res.path ?? ''}`
  return res.error ? `저장 실패: ${res.error}` : ''
}

/** 증적 표 하나(툴) — 칸에 마우스를 올리면 HTTP · 응답 시간 · 사유 */
function EvTable({ tb, id }: { tb: BoardEvidenceTable; id?: string }) {
  return (
    <div className="mb-3" id={id}>
      {tb.title && <div className="mb-1 text-[11.5px] font-medium text-gray-300">{tb.title}</div>}
      <div className="overflow-x-auto rounded-lg border border-white/10">
        <table className="w-full text-[11.5px]">
          <thead className="bg-white/[0.04] text-gray-400">
            <tr>
              {tb.columns.map((c) => (
                <th key={c} className="whitespace-nowrap px-2 py-1 text-left font-normal">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {tb.rows.map((r, ri) => (
              <tr key={ri} title={tb.titles?.[ri]} className={'border-t border-white/5 ' + (tb.bad?.[ri] ? 'bg-red-500/10 text-red-200' : 'text-gray-200')}>
                {r.map((c, ci) => (
                  <td
                    key={ci}
                    title={tb.cellTitles?.[ri]?.[ci] || undefined}
                    className={'whitespace-nowrap px-2 py-0.5 tabular-nums ' + (c.startsWith('✓') ? 'text-emerald-300' : c.startsWith('✗') ? 'text-red-300' : '')}
                  >
                    {c}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/** 접어 둔 것(요청마다의 칸 · 그 밖의 정상화) — 툴 증적 창 안에서만 */
function EvFold({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="mb-2">
      <button onClick={() => setOpen(!open)} className="inline-flex items-center gap-1 rounded px-1 py-0.5 text-[11.5px] text-gray-400 hover:bg-white/10 hover:text-gray-200">
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />} {label}
      </button>
      {open && <div className="mt-1">{children}</div>}
    </div>
  )
}

/**
 * 정상화 근거 표(툴) — 그 순간 정상이던 화면을 한 줄씩, 누르면 그 화면의 API 별 기록을 펼친다. 처음엔 마지막으로 돌아온 화면만 펼친다
 * (그 화면이 1차 · 최종 정상화를 만들었다). 화면이 저절로 움직이지 않게 펼침은 사람이 누를 때만 바뀐다.
 */
function BasisTable({ rows, title, id }: { rows: PortalBasisRow[]; title: string; id: string }) {
  const [open, setOpen] = useState<Set<string>>(() => new Set(rows.filter((r) => r.last).map((r) => r.name)))
  const toggle = (n: string) =>
    setOpen((cur) => {
      const x = new Set(cur)
      if (x.has(n)) x.delete(n)
      else x.add(n)
      return x
    })
  return (
    <div className="mb-3" id={id}>
      <div className="mb-1.5 mt-4 text-[11.5px] font-semibold text-gray-400">{title}</div>
      <div className="overflow-x-auto rounded-lg border border-white/10">
        <table className="w-full text-[11.5px]">
          <thead className="bg-white/[0.04] text-gray-400">
            <tr>
              {['화면', '첫 정상', '확정', '연속', '핵심 API', '직전 응답에서 깨져 있던 API', '응답 시간(중앙값)'].map((c) => (
                <th key={c} className="whitespace-nowrap px-2 py-1 text-left font-normal">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.name}
                onClick={() => toggle(r.name)}
                className={'cursor-pointer border-t border-white/5 text-gray-200 hover:bg-white/[0.04] ' + (r.last ? 'bg-blue-500/10 shadow-[inset_3px_0_0_#3b82f6]' : '')}
              >
                <td className="whitespace-nowrap px-2 py-1">
                  <span className="mr-1 text-gray-500">{open.has(r.name) ? '▾' : '▸'}</span>
                  {r.name}
                  {r.last && <span className="ml-1.5 rounded bg-blue-500/20 px-1.5 text-[10.5px] text-blue-200">마지막으로 돌아옴</span>}
                </td>
                <td className="px-2 py-1 tabular-nums">{fmtClock(r.firstOk)}</td>
                <td className="px-2 py-1 tabular-nums">{r.confirm ? fmtClock(r.confirm) : '-'}</td>
                <td className="px-2 py-1 text-emerald-300">✓ {r.n ?? '-'}회</td>
                <td className="px-2 py-1 tabular-nums">{r.apis || '-'}</td>
                <td className={'px-2 py-1 ' + (r.broken.length ? 'text-red-300' : 'text-gray-500')}>{r.broken.length ? r.broken.join(', ') : '-'}</td>
                <td className="px-2 py-1 tabular-nums">{r.median != null ? `${r.median}ms` : '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows
        .filter((r) => open.has(r.name))
        .map((r) => (
          <div key={r.name} className="ml-4 mt-2">
            {r.compact && <EvTable tb={{ ...r.compact, title: `${r.name} · 첫 정상 ${fmtClock(r.firstOk)}${r.confirm ? ` → 확정 ${fmtClock(r.confirm)}` : ''}` }} />}
            {r.tb && (
              <EvFold label={`요청마다의 칸 보기 (${r.tb.columns.length - 1}회 × ${r.tb.rows.length - 1}개)`}>
                <EvTable tb={{ ...r.tb, title: '' }} />
              </EvFold>
            )}
          </div>
        ))}
    </div>
  )
}

/** 포털 증적(툴) — 리포트와 같은 구성(portalEvidence.ts): 숫자 카드 → ① 일어난 순서 → ② 화면별 → ③ 연속 통과 기록. ④ 원문은 아래 공통 */
function PortalEvSections({ v, base }: { v: PortalEvView; base: number | null }) {
  const el = (at: number) => (base == null ? fmtClock(at) : `${at < base ? '−' : '+'}${fmtElapsed(Math.abs(at - base))}`)
  const sFirst = v.streaks.find((x) => x.role === 'first')
  const sFinal = v.streaks.find((x) => x.role === 'final')
  const others = v.streaks.filter((x) => x !== sFirst && x !== sFinal)
  const n = v.screens != null ? ` · ${v.screens}/${v.screens} 화면` : ''
  const jump = (id: string) => document.getElementById(id)?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  const card = (label: string, big: string, small: string, k = false) => (
    <div className={'min-w-[150px] rounded-md border border-white/10 bg-white/[0.04] px-2.5 py-1.5 ' + (k ? 'border-l-[3px] border-l-blue-500' : '')}>
      <span className="block text-[11px] text-gray-400">{label}</span>
      <b className="block text-[15px] tabular-nums text-gray-100">{big}</b>
      <small className="block text-[11px] text-gray-500">{small}</small>
    </div>
  )
  const sub = (t: string, id?: string) => (
    <div id={id} className="mb-1.5 mt-4 text-[11.5px] font-semibold text-gray-400">
      {t}
    </div>
  )
  const streak = (x: PortalStreak, id?: string) =>
    x.compact ? (
      <div key={x.tb.title}>
        <EvTable tb={x.compact} id={id} />
        <EvFold label={`요청마다의 칸 보기 (${x.tb.columns.length - 1}회 × ${x.tb.rows.length - 1}개)`}>
          <EvTable tb={{ ...x.tb, title: '' }} />
        </EvFold>
      </div>
    ) : (
      <EvTable key={x.tb.title} tb={x.tb} id={id} />
    )
  return (
    <>
      <div id="pe-top" className="mb-1 flex flex-wrap gap-2">
        {card('최초 끊김', v.first ? el(v.first.at) : '-', v.first ? `${fmtClock(v.first.at)} · ${v.first.label.replace(/^최초 끊김 \((.*)\)$/, '$1')}` : '끊김 기록 없음')}
        {card('1차 정상화', v.firstAll ? el(v.firstAll.at) : '-', v.firstAll ? `${fmtClock(v.firstAll.at)}${n}` : '아직 모두 정상이 된 적 없음', true)}
        {card(v.firstAll ? '1차 뒤 다시 끊김' : '다시 끊김', `${v.flapTimes}회`, flapSmall(v))}
        {card(
          '최종 정상화',
          v.pending ? '실패' : v.final ? el(v.final.at) : v.firstAll ? el(v.firstAll.at) : '-',
          v.pending ? v.pending : v.final ? `${fmtClock(v.final.at)}${n}` : v.firstAll ? '1차 정상화와 같음' : '',
          true,
        )}
      </div>
      {sub('① 일어난 순서')}
      <div className="mb-3 rounded-lg border border-white/10 bg-black/20 p-1.5">
        {v.facts.map((f, i) => {
          const k = f.role === 'firstAll' || f.role === 'final'
          const go = f.role === 'firstAll' && hasFirstBasis(v) ? 'pe-s1' : f.role === 'final' && hasFinalBasis(v) ? 'pe-s2' : ''
          return (
            <div
              key={i}
              id={f.role === 'firstAll' ? 'pe-f1' : f.role === 'final' ? 'pe-f2' : undefined}
              className={'grid gap-2 rounded px-1.5 py-0.5 ' + (k ? 'bg-blue-500/10 shadow-[inset_3px_0_0_#3b82f6]' : '')}
              style={{ gridTemplateColumns: '150px 56px 1fr' }}
            >
              <span className="tabular-nums text-gray-100">{f.at ? fmtDateTime(f.at) : f.text ?? '-'}</span>
              <span className="tabular-nums text-gray-500">{f.at ? el(f.at) : ''}</span>
              <span className="text-gray-300">
                {factLabel(f.label)}
                {go && (
                  <button onClick={() => jump(go)} className="ml-2 text-[11px] text-blue-400 hover:underline">
                    연속 통과 기록 ↓
                  </button>
                )}
              </span>
            </div>
          )
        })}
      </div>
      {v.pages && (
        <>
          {sub('② 화면별', 'pe-pages')}
          <EvTable tb={{ ...v.pages, title: '' }} />
        </>
      )}
      {/* ③ 1차 · 최종 정상화 근거(화면별) — 리포트와 같은 구성(portalBasis). 판정 기록이 없는 옛 회차는 아래 예전 그림 */}
      {v.basis?.first.length ? (
        <>
          <BasisTable rows={v.basis.first} id="pe-s1" title={`③ 1차 정상화 근거 (${v.basis.first.length}/${v.basis.first.length} 화면)${v.firstAll ? ` · ${fmtClock(v.firstAll.at)} 모든 화면이 처음 동시에 정상` : ''}`} />
          {!!v.basis.final.length && (
            <BasisTable rows={v.basis.final} id="pe-s2" title={`최종 정상화 근거 (${v.basis.final.length}/${v.basis.final.length} 화면) · 각 화면의 마지막 정상화`} />
          )}
          {!!v.basis.others.length && (
            <EvFold label={`그 밖의 정상화 확정 ${v.basis.others.length}건 (1차 · 최종에 쓰이지 않은 중간 정상화)`}>
              {v.basis.others.map((r, i) => r.compact && <EvTable key={i} tb={{ ...r.compact, title: `${r.name} · 첫 정상 ${fmtClock(r.firstOk)}` }} />)}
            </EvFold>
          )}
        </>
      ) : !!v.streaks.length && (
        <>
          {sub('③ 연속 통과 기록 (정상화를 확정한 근거)')}
          {sFirst && streak(sFirst, 'pe-s1')}
          {sFinal && streak(sFinal, 'pe-s2')}
          {!!others.length && <EvFold label={`그 밖의 정상화 확정 ${others.length}건`}>{others.map((x) => streak(x))}</EvFold>}
        </>
      )}
    </>
  )
}

/**
 * 증적 한 건 보기 — 서버 원문을 보여 주고 **판정 근거 줄로 스크롤해 강조**한다.
 * 모달 규칙대로 배경 클릭으로 닫지 않는다(X 만).
 *
 * 왼쪽 목록은 리포트 목차와 같은 묶음(노드 DOWN 이전 · 이후 · UP 이후, runEvidenceLayout)이다(2026-11-07 사용자 결정, 목업).
 * 예전엔 위에 증적 제목 버튼을 저장 순서대로 늘어놓아, 증적이 33개(파드 로그 24개)인 회차는 비슷한 버튼이 여러 줄 쌓여 찾기 어려웠다.
 * 포털 증적은 목록에서 그 아래에 최초 끊김 · 1차 정상화 · 다시 끊김 · 최종 정상화를 들여 써 그 자리로 바로 간다. 파드 로그 이상은 한 줄로 접는다.
 * `run` 이 없으면(이력에서 회차를 못 찾음) 묶음 없이 저장 순서대로 보인다.
 */
function EvidenceView({ id, initialKey, run, onClose }: { id: string; initialKey: string; run?: HistoryRecord | null; onClose: () => void }) {
  const [items, setItems] = useState<BoardEvidenceItem[] | null>(null)
  const [err, setErr] = useState('')
  const [key, setKey] = useState(initialKey)
  const [copied, setCopied] = useState(false)
  /** 펼친 파드 로그 묶음(노드 DOWN 이전 · 이후 · UP 이후 마다 따로 접는다) */
  const [logsOpen, setLogsOpen] = useState<Set<number>>(() => new Set())
  /** 포털 증적 안에서 갈 자리(목록의 하위 줄을 눌렀을 때) */
  const [jumpTo, setJumpTo] = useState<string | null>(null)
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
  const bodyRef = useRef<HTMLDivElement | null>(null)
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
  // 진행 중인 회차면 부모가 그릴 때마다 run 이 새 객체다 — 회차(id)와 증적이 바뀔 때만 다시 정리한다(안 그러면 폴링마다 스크롤이 튄다)
  const base = useMemo(
    () => (run ? runTotals({ ...run, milestones: { ...run.milestones, pods: run.milestones.pods ?? [], portal: run.milestones.portal ?? [] } }).base : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [run?.id, items],
  )
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const lay = useMemo(() => (items && run && base != null ? runEvidenceLayout(items, run.milestones, run.t0, base) : null), [items, run?.id, base])
  const list = lay ? lay.evItems : items ?? []
  // 타임라인의 [증적] 은 'ceph' · 'cephHealthy' 를 가리킨다 — 합쳐졌으면 합친 것으로
  const curKey = lay ? resolveEvKey(key, lay.evKeys) ?? key : key
  const item = list.find((x) => x.key === curKey)
  const pv = item && lay ? lay.portalV.get(item.key) : undefined
  useEffect(() => {
    if (jumpTo) {
      // 맨 위(카드)는 위의 조회 서버 · 명령까지 보이게 창 맨 위로
      if (jumpTo === 'pe-top') bodyRef.current?.scrollTo({ top: 0 })
      else document.getElementById(jumpTo)?.scrollIntoView({ block: 'start' })
      setJumpTo(null)
      return
    }
    // 포털은 카드부터 보이게 맨 위로, 그 밖은 원문의 첫 근거 줄을 가운데로
    if (pv) bodyRef.current?.scrollTo({ top: 0 })
    else focusRef.current?.scrollIntoView({ block: 'center' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [curKey, jumpTo, items])
  const lines = item ? alignTabBlocks(item.text.split('\n')) : []
  const focus = (item?.focus ?? []).filter(Boolean)
  // 진하게 칠할 근거 줄 — 보통 focus[0] 하나, 합친 Ceph 증적은 둘. 처음 스크롤할 자리는 그 첫 줄
  const strong = new Set(item ? focus.slice(0, strongFocusCount(item)).map((f) => lines.findIndex((l) => l.includes(f))).filter((x) => x >= 0) : [])
  if (!strong.size) {
    const fi = lines.findIndex((l) => focus.some((f) => l.includes(f)))
    if (fi >= 0) strong.add(fi)
  }
  const firstIdx = strong.size ? Math.min(...strong) : -1
  const el = (at: number) => (base == null ? fmtClock(at) : `${at < base ? '−' : '+'}${fmtElapsed(Math.abs(at - base))}`)
  const pick = (k: string, part?: string) => {
    setKey(k)
    setJumpTo(part ?? null)
  }
  const sideRow = (o: { k: string; at: number; label: ReactNode; tone?: string; sub?: boolean; part?: string; active?: boolean }) => (
    <button
      /*
       * key 에 줄 종류(본 줄 · 하위 줄)와 이름까지 넣는다. 포털 본 줄과 '└ 최초 끊김' 은 증적 · 자리(pe-top) · 시각이 모두 같아
       * key 가 겹쳤고, 목록을 다시 그릴 때마다(파드 로그 묶음 펼치기 등) React 가 옛 줄을 못 지워 '포털 응답 기록' 이 쌓였다(2026-11-09 사용자 발견).
       */
      key={`${o.sub ? 'sub' : 'main'}:${o.k}:${o.part ?? ''}:${o.at}:${typeof o.label === 'string' ? o.label : ''}`}
      onClick={() => pick(o.k, o.part)}
      className={
        'grid w-full gap-1.5 rounded px-2 py-1 text-left leading-snug ' +
        (o.sub ? 'pl-5 text-[11.5px] ' : 'text-[12px] ') +
        (o.active ? 'bg-blue-500/20 text-blue-100 shadow-[inset_2px_0_0_#3b82f6] ' : o.tone === 'dim' ? 'text-gray-500 hover:bg-white/[0.06] ' : 'text-gray-300 hover:bg-white/[0.06] ')
      }
      style={{ gridTemplateColumns: '44px 1fr' }}
    >
      <span className={'text-right text-[11px] tabular-nums ' + (o.tone === 'kd' ? 'font-bold text-red-400' : o.tone === 'kr' ? 'font-bold text-blue-400' : 'text-gray-500')}>{el(o.at)}</span>
      <span className="min-w-0">{o.label}</span>
    </button>
  )
  const side: ReactNode[] = []
  if (lay && base != null) {
    // 파드 로그 이상은 묶음마다 한 줄로 접는다(리포트 목차와 같은 기준, tocEntries). 선택한 것이 들어 있는 묶음은 늘 펼친다
    const logsOf = (grp: number) => lay.evArr.filter((x) => x.grp === grp && x.it.key.startsWith('podlog:'))
    let g = -1
    const done = new Set<number>()
    for (const x of lay.evArr) {
      const isLog = x.it.key.startsWith('podlog:')
      const ls = isLog ? logsOf(x.grp) : []
      if (x.grp !== g) {
        side.push(
          <div key={`g${x.grp}`} className="px-2 pb-0.5 pt-2 text-[11px] font-semibold text-gray-500">
            {EV_GROUP_LABEL[x.grp]}
          </div>,
        )
        g = x.grp
      }
      if (isLog && ls.length > 1) {
        if (done.has(x.grp)) continue
        done.add(x.grp)
        const open = logsOpen.has(x.grp) || ls.some((y) => y.it.key === curKey)
        side.push(
          <button
            key={`logs${x.grp}`}
            onClick={() =>
              setLogsOpen((cur) => {
                const n = new Set(cur)
                if (n.has(x.grp)) n.delete(x.grp)
                else n.add(x.grp)
                return n
              })
            }
            className="grid w-full gap-1.5 rounded px-2 py-1 text-left text-[12px] leading-snug text-gray-400 hover:bg-white/[0.06]"
            style={{ gridTemplateColumns: '44px 1fr' }}
          >
            <span className="text-right text-[11px] tabular-nums text-gray-500">{el(x.at)}</span>
            <span className="inline-flex items-center gap-1">
              파드 로그 이상 {ls.length}건 {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </span>
          </button>,
        )
        if (open) for (const y of ls) side.push(sideRow({ k: y.it.key, at: y.at, label: podLogLabel(y.it), sub: true, active: y.it.key === curKey }))
        continue
      }
      const tone = x.it.key === 'down' ? 'kd' : x.it.key === 'masakari' && lay.masaDone ? 'kr' : x.grp === 2 ? 'dim' : ''
      const v = lay.portalV.get(x.it.key)
      // 포털은 하위 줄로 아래를 본 뒤 다시 눌러도 맨 위(카드)로 가게 자리를 준다 — 자리가 없으면 같은 증적이라 아무 일도 없었다
      side.push(sideRow({ k: x.it.key, at: x.at, label: isLog ? podLogLabel(x.it) : tocLabel(x.it, x.grp), tone, active: x.it.key === curKey, part: v ? 'pe-top' : undefined }))
      if (v) {
        if (v.first) side.push(sideRow({ k: 'portal', at: v.first.at, label: '└ 최초 끊김', sub: true, part: 'pe-top' }))
        if (v.firstAll) side.push(sideRow({ k: 'portal', at: v.firstAll.at, label: `└ 1차 정상화${v.screens != null ? ` (${v.screens}/${v.screens})` : ''}`, tone: 'kr', sub: true, part: hasFirstBasis(v) ? 'pe-s1' : 'pe-f1' }))
        const after = v.flaps.find((f) => !v.firstAll || f.at > v.firstAll.at)
        if (v.flapTimes && after) side.push(sideRow({ k: 'portal', at: after.at, label: `└ 다시 끊김 ${v.flapTimes}회`, sub: true, part: v.pages ? 'pe-pages' : 'pe-top' }))
        if (v.final) side.push(sideRow({ k: 'portal', at: v.final.at, label: `└ 최종 정상화${v.screens != null ? ` (${v.screens}/${v.screens})` : ''}`, tone: 'kr', sub: true, part: hasFinalBasis(v) ? 'pe-s2' : 'pe-f2' }))
      }
    }
  } else {
    for (const x of list) side.push(sideRow({ k: x.key, at: x.capturedAt, label: x.title, active: x.key === curKey }))
  }
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
                title="원문이 창보다 길 때: 끄면 가로 스크롤로 한 줄씩, 켜면 창 너비에서 접어 보여 줍니다"
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
        <div className="flex min-h-0 flex-1">
          {list.length > 1 && <div className="w-[270px] shrink-0 overflow-y-auto border-r border-white/10 px-1.5 py-2">{side}</div>}
          <div ref={bodyRef} className="min-h-0 min-w-0 flex-1 overflow-y-auto p-4 text-[12px]">
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
                  <span>{EV_LABEL.host}</span>
                  <span className="text-gray-200">{item.host}</span>
                  <span>{EV_LABEL.at}</span>
                  <span className="text-gray-200">
                    {fmtDateTime(item.capturedAt)} <span className="text-gray-500">({EV_LABEL.atHint})</span>
                  </span>
                  <span>{evCmdOf(item).label}</span>
                  {evCmdOf(item).code ? <code className="break-all text-gray-300">{item.command}</code> : <span className="text-gray-300">{evCmdOf(item).text}</span>}
                  {item.verifyCmd && (
                    <>
                      <span title={EV_LABEL.verifyHint}>{EV_LABEL.verify}</span>
                      <span>
                        <code className="break-all text-emerald-300/90">{item.verifyCmd}</code> <span className="text-gray-500">({EV_LABEL.verifyHint})</span>
                      </span>
                    </>
                  )}
                </div>
                {pv ? (
                  <PortalEvSections v={pv} base={base} />
                ) : (
                  <>
                    {!!item.facts?.length && (
                      <div className="mb-3 rounded-lg border border-white/10 bg-black/20 p-2.5">
                        {item.facts.map((f, i) =>
                          /*
                           * 왼쪽 150px 칸은 시각 · 짧은 값 자리다. 긴 글(이유 · 시계 차이 설명 · VM 목록)을 넣으면 좁게 꺾여 읽히지 않았다(2026-11-16
                           * 사용자 지적) — 그런 줄은 이름을 위에, 글을 아래에 전체 너비로, 글 안의 줄바꿈은 그대로 보인다
                           */
                          !f.at && f.text && (f.text.includes('\n') || f.text.length > 18) ? (
                            <div key={i} className="py-1">
                              <div className="text-gray-400">{factLabel(f.label)}</div>
                              <div className="whitespace-pre-line break-words pl-3 text-gray-100">{f.text}</div>
                            </div>
                          ) : (
                            <div key={i} className="flex gap-3 py-0.5">
                              <span className="w-[150px] shrink-0 tabular-nums text-gray-100">{f.at ? fmtDateTime(f.at) : f.text ?? '-'}</span>
                              <span className="text-gray-300">{factLabel(f.label)}</span>
                            </div>
                          ),
                        )}
                      </div>
                    )}
                    {[item.table, ...(item.tables ?? [])]
                      .filter((tb): tb is NonNullable<typeof tb> => !!tb)
                      .map((tb, ti) => (
                        <EvTable key={ti} tb={tb} />
                      ))}
                  </>
                )}
                {item.note && <p className="mb-2 text-[11px] leading-relaxed text-gray-500">{item.note}</p>}
                {pv && <div className="mb-1.5 mt-4 text-[11.5px] font-semibold text-gray-400">④ 원문 (판정이 바뀐 순간)</div>}
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
                            // 접기 끔(기본)이어도 200자를 넘는 줄은 접는다 — 리포트 원문과 같은 기준(buildHtmlReport '원문 줄' 주석)
                            // 분산 점검은 열로 읽는 표라 접지 않는다(리포트 '.pre.nowrap' 과 같은 기준)
                            (wrap ? 'whitespace-pre-wrap break-all' : item.key.startsWith('spread') ? 'whitespace-pre' : 'max-w-[200ch] whitespace-pre-wrap [overflow-wrap:anywhere]') +
                            ' pl-[calc(2ch+0.25rem)] pr-1 -indent-[2ch] ' +
                            (strong.has(i) ? 'rounded bg-amber-400/25 text-amber-100' : hit ? 'rounded bg-amber-400/10 text-amber-100/90' : '')
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
    </div>
  )
}

/** '2026-10-22 14:19:58' · '14:19:58'(그 회차 날짜) → epoch ms(이 PC 시간대) */
function parseLocalDateTime(text: string, baseDay: number): number | null {
  const t = text.trim()
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/)
  /*
   * 범위 밖 값(2026-02-31 · 25:00 · 14:60)은 Date 가 조용히 다음 날 · 다음 달로 넘겨 엉뚱한 시각이 저장됐다.
   * 2.17.8 에서 날짜 칸을 따로 고칠 수 있게 하면서 칸마다 범위를 본다(코드 리뷰)
   */
  const valid = (y: number, mo: number, d: number, h: number, mi: number, se: number) => {
    const v = new Date(y, mo - 1, d, h, mi, se)
    return v.getMonth() === mo - 1 && v.getDate() === d && h < 24 && mi < 60 && se < 60 ? v.getTime() : null
  }
  if (m) return valid(+m[1], +m[2], +m[3], +m[4], +m[5], +(m[6] ?? 0))
  m = t.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/)
  if (m) {
    const d = new Date(baseDay)
    return valid(d.getFullYear(), d.getMonth() + 1, d.getDate(), +m[1], +m[2], +(m[3] ?? 0))
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
  runAt,
}: {
  value: Milestones['inject']
  downAt?: number
  onSave: (v: Milestones['inject'] | undefined) => void
  /** 있으면 처음부터 입력 상태로 열리고, 저장·지우기·취소 뒤 이것을 부른다 (보드 머리줄의 진행 중 회차 수정용) */
  onDone?: () => void
  /** 회차 시작 시각 — 날짜 칸의 기본값(주입 · DOWN 시각이 없을 때) */
  runAt?: number
}) {
  const [edit, setEditRaw] = useState(!!onDone)
  /*
   * 날짜 · 시각 칸을 나눴다(2026-11-17 사용자 요청: 연도 · 날짜까지 치기 불편하다). 날짜는 회차 날짜로 미리 채우고 사람은 시각만 넣는다.
   * 자정을 넘긴 회차(주입이 전날 23:59 · DOWN 이 00:00)는 날짜 칸을 고치면 된다. 시각 칸에 날짜까지 붙여 넣어도 그대로 받는다
   */
  const base = value?.at ?? downAt ?? runAt ?? Date.now()
  const [day, setDay] = useState(() => fmtDateTime(base).slice(0, 10))
  const [text, setText] = useState(() => (onDone && value ? fmtDateTime(value.at).slice(11) : ''))
  const [note, setNote] = useState(() => (onDone ? value?.note ?? 'IPMI 이벤트 로그' : ''))
  const [err, setErr] = useState('')
  const setEdit = (v: boolean) => {
    setEditRaw(v)
    if (!v) onDone?.()
  }
  if (!edit)
    return (
      <div className="mb-1.5 flex items-center gap-2 text-[11.5px] text-gray-400">
        <Bolt size={11} className="text-amber-400" />
        {value ? (
          <span>
            장애 주입 <b className="text-gray-200 tabular-nums">{fmtDateTime(value.at)}</b>{' '}
            {value.source === 'manual' ? `(수동${value.note ? ` · ${value.note}` : ''})` : '(버튼)'}
            {downAt && downAt >= value.at && <span className="text-gray-500"> · DOWN 감지까지 {fmtElapsed(downAt - value.at)}</span>}
            {/* DOWN 보다 늦은 주입은 리포트 기준으로 쓰지 않는다(runTotals) — 말없이 빠지면 IPMI 기준으로 잰 줄 안다(코드 점검 10-30) */}
            {downAt != null && downAt < value.at && (
              <span className="text-amber-300"> · DOWN 감지({fmtClock(downAt)})보다 늦어 기준으로 쓰지 않습니다(날짜 · 시각을 확인하세요)</span>
            )}
          </span>
        ) : (
          <span className="text-gray-500">장애 주입 시각 없음</span>
        )}
        <button
          onClick={() => {
            setText(value ? fmtDateTime(value.at).slice(11) : '')
            setDay(fmtDateTime(base).slice(0, 10))
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
          value={day}
          onChange={(e) => setDay(e.target.value)}
          title="날짜 (회차 날짜로 채워 둡니다. 자정을 넘긴 경우만 고치세요)"
          className="w-[86px] rounded border border-white/10 bg-panel-light px-1.5 py-0.5 font-mono text-[11.5px] text-gray-400"
        />
        <input
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="14:19:58"
          className="w-[76px] rounded border border-white/10 bg-panel-light px-1.5 py-0.5 font-mono text-[11.5px] text-gray-100 placeholder:text-gray-600"
        />
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="출처 (예: IPMI 이벤트 로그)"
          className="w-[160px] rounded border border-white/10 bg-panel-light px-1.5 py-0.5 text-[11.5px] text-gray-100 placeholder:text-gray-600"
        />
        <button
          onClick={() => {
            // 시각만 넣으면 날짜 칸의 날짜로, 날짜까지 붙여 넣었으면 그것으로
            const t = text.trim()
            const at = /^\d{4}-/.test(t) ? parseLocalDateTime(t, base) : /^\d{4}-\d{2}-\d{2}$/.test(day.trim()) ? parseLocalDateTime(`${day.trim()} ${t}`, base) : null
            if (at == null) return setErr(/^\d{4}-\d{2}-\d{2}$/.test(day.trim()) ? '시각은 14:19:58 또는 14:19 처럼 넣으세요' : '날짜는 2026-11-17 처럼 넣으세요')
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
        이 PC 시간대(KST)로 넣습니다. IPMI(BMC) 시계는 NTP 를 쓰지 않아 수 분씩 틀린 경우가 많습니다. BMC 시각과 실제 시각의 차이를 확인하고
        (예: <code>ipmitool sel time get</code> 과 <code>date</code> 비교) 그만큼 고쳐 넣으세요.
      </div>
    </div>
  )
}

// ── 세부 원인 및 조치 입력 (이력 창) ───────────────────────────
/**
 * 회차의 실패 단계 · 수동 조치마다 원인 · 조치 · 담당자 · 조치 시각을 적는 창(RunNote 주석, 2026-11-11 사용자 결정 · 목업 cause-mock).
 * 카드는 앱이 실패로 잡은 단계(Masakari · 포털)마다 하나씩 열리고, 앱이 잡지 못한 것(검증 중 사람이 손댄 것)은 '수동 조치 추가' 로 더한다.
 * 상태(분석 중 · 조치 완료 · 재검증 필요) 칸은 두지 않는다 — 리포트에 싣지 않기로 해서(사용자 결정) 고르게 해 봐야 번거롭기만 하다.
 * 닫기는 X · 취소 · 저장 버튼뿐(모달 규칙 — 길게 적은 글이 손이 스친 클릭에 사라지면 안 된다).
 */
type NoteDraft = { step: RunNote['step']; cause: string; why: string; action: string; owner: string; atText: string; recovered: boolean }
const toDraft = (n: RunNote): NoteDraft => ({
  step: n.step,
  cause: n.cause,
  why: n.why ?? '',
  action: n.action ?? '',
  owner: n.owner ?? '',
  atText: n.at != null ? fmtDateTime(n.at) : '',
  recovered: !!n.recovered,
})
/** 앱이 실패로 잡은 단계 — 카드 머리에 회색으로 보여 무엇에 대한 원인인지 알게 한다(리포트 svcFail 과 같은 조건) */
function failedStepsOf(h: HistoryRecord): { step: 'masakari' | 'portal'; text: string }[] {
  const ms = h.milestones
  const out: { step: 'masakari' | 'portal'; text: string }[] = []
  if (masaWatchedOf(ms) && !masaDoneOf(ms)) out.push({ step: 'masakari', text: masaFailOf(ms) ? masaFailText(ms) : 'Masakari evacuation 끝나지 않음' })
  const pend = ms.portalPending ?? []
  if (pend.length) out.push({ step: 'portal', text: `안 돌아온 화면: ${pend.join(' · ')}` })
  return out
}
/** 사람이 성공으로 바꾸지 않은 실패 단계가 남았나(이력 목록 판정 — 리포트 svcFail 과 같은 뜻) */
const restFailOf = (h: HistoryRecord) => manualFailOf(h) || failedStepsOf(h).some((f) => !ovStep(h, f.step))
/** 바꾼 단계 중 지금도 실패인 것이 있나 — 실패가 아니게 된 단계를 바꿔 둔 것만으로 '결과 변경' 이라 부르지 않는다(코드 리뷰 11-17) */
const ovUsedOf = (h: HistoryRecord) => failedStepsOf(h).some((f) => ovStep(h, f.step))

function RunNotesDialog({
  h,
  num,
  onSave,
  onClose,
}: {
  h: HistoryRecord
  num: number
  onSave: (notes: RunNote[], override: RunOverride | undefined) => void
  onClose: () => void
}) {
  const failed = failedStepsOf(h)
  // 결과 변경(RunOverride 주석) — 앱이 실패로 잡은 단계(또는 이미 바꿔 둔 단계)마다 칸을 보인다
  const [ovSteps, setOvSteps] = useState<OvStep[]>(() => (h.override?.steps ?? []).filter((st) => ovStep(h, st)))
  // 단계별 이유(RunOverride 주석, 안 B). 옛 기록(이유 하나)은 그 이유가 바꾼 단계 칸에 그대로 들어간다(reasonOf)
  const [ovReasons, setOvReasons] = useState<Partial<Record<OvStep, string>>>(() =>
    Object.fromEntries((h.override?.steps ?? []).map((st) => [st, reasonOf(h, st)])),
  )
  const ovRows: { step: OvStep; text: string }[] = [
    ...failed,
    ...(h.override?.steps ?? []).filter((st) => !failed.some((f) => f.step === st)).map((st) => ({ step: st, text: '지금은 실패 아님' })),
  ]
  const ovOn = ovSteps.length > 0
  const [drafts, setDrafts] = useState<NoteDraft[]>(() => {
    const have = h.notes ?? []
    const out: NoteDraft[] = []
    // 실패한 단계는 늘 카드를 연다(적은 것이 있으면 그것으로). 지금은 실패가 아닌데 예전에 적어 둔 단계 기록도 버리지 않고 보여 준다
    for (const st of ['masakari', 'portal'] as const) {
      const n = have.find((x) => x.step === st)
      if (n) out.push(toDraft(n))
      else if (failed.some((f) => f.step === st)) out.push({ step: st, cause: '', why: '', action: '', owner: '', atText: '', recovered: false })
    }
    for (const n of have.filter((x) => x.step === 'manual')) out.push(toDraft(n))
    return out
  })
  const [err, setErr] = useState('')
  const set = (k: number, patch: Partial<NoteDraft>) => setDrafts((cur) => cur.map((d, j) => (j === k ? { ...d, ...patch } : d)))
  const save = () => {
    const out: RunNote[] = []
    for (const d of drafts) {
      // 아무것도 안 적은 카드는 저장하지 않는다(실패 단계 카드가 비어 있어도 된다 — 리포트에서 빈칸)
      if (!(d.cause.trim() || d.why.trim() || d.action.trim() || d.owner.trim() || d.atText.trim())) continue
      if (!d.cause.trim()) return setErr(`${NOTE_STEP_LABEL[d.step]}: 이슈를 적어 주세요`)
      let at: number | undefined
      if (d.atText.trim()) {
        const v = parseLocalDateTime(d.atText, h.t0)
        if (v == null) return setErr(`${NOTE_STEP_LABEL[d.step]}: 조치 시각은 2026-11-11 15:09 또는 15:09 처럼 넣으세요`)
        at = v
      }
      out.push({
        step: d.step,
        cause: d.cause.trim(),
        why: d.why.trim() || undefined,
        action: d.action.trim() || undefined,
        owner: d.owner.trim() || undefined,
        at,
        recovered: d.step === 'manual' && d.recovered ? true : undefined,
      })
    }
    const noReason = ovSteps.find((st) => !(ovReasons[st] ?? '').trim())
    if (noReason) return setErr(`결과 변경(${NOTE_STEP_LABEL[noReason]}): 이유를 필수로 기입해주세요`)
    // 성공으로 바꾸면서 '이 조치가 없었으면 복구되지 않았음'(실패로 셈)을 켜 두면 서로 반대 — 어느 쪽인지 사람이 고르게 한다
    if (ovOn && out.some((n) => n.step === 'manual' && n.recovered)) return setErr("성공으로 결과 변경과 '이 조치가 없었으면 복구되지 않았음' 은 함께 켤 수 없습니다")
    // 단계 · 이유가 그대로면 바꾼 시각도 그대로 둔다
    const steps = (['masakari', 'portal'] as const).filter((st) => ovSteps.includes(st))
    const reasons: Partial<Record<OvStep, string>> = Object.fromEntries(steps.map((st) => [st, (ovReasons[st] ?? '').trim()]))
    const same =
      !!h.override && steps.join() === [...(h.override.steps ?? [])].sort().join() && steps.every((st) => reasons[st] === reasonOf(h, st))
    const ov: RunOverride | undefined = ovOn
      ? {
          steps,
          reason: steps.map((st) => `${NOTE_STEP_LABEL[st]}: ${reasons[st]}`).join('\n'),
          reasons,
          at: same ? h.override!.at : Date.now(),
        }
      : undefined
    onSave(out, ov)
  }
  const field =
    'w-full rounded border border-white/10 bg-black/30 px-2 py-1 text-[12px] leading-relaxed text-gray-100 placeholder:text-gray-600 focus:border-blue-500/60 focus:outline-none'
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-8">
      <div className="flex max-h-[90vh] w-[720px] max-w-[94vw] flex-col rounded-lg border border-white/10 bg-panel shadow-2xl">
        <div className="flex items-center gap-2 border-b border-white/10 px-4 py-2.5">
          <span className="shrink-0 text-sm font-semibold text-gray-100">원인 · 조치</span>
          <span className="min-w-0 truncate text-[11.5px] text-gray-400">
            #{num} {h.label || h.node} · {fmtDateTime(h.t0)}
            {!failed.length ? ' · 앱 판정은 실패 아님' : ''}
          </span>
          <button onClick={onClose} title="닫기 (저장하지 않음)" className="ml-auto rounded p-1 text-gray-400 hover:bg-white/10 hover:text-gray-100">
            <X size={15} />
          </button>
        </div>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          {ovRows.length > 0 && (
            <div className={'rounded-lg border p-3 ' + (ovOn ? 'border-amber-500/50 bg-amber-500/[0.07]' : 'border-white/10 bg-black/20')}>
              <div className="mb-1.5 text-[12px]">
                <b className="text-amber-300">회차 판정</b>
                <span className="ml-2 text-[11px] text-gray-500">바꾸지 않은 단계는 실패 그대로이고, 하나라도 남으면 회차도 실패입니다.</span>
              </div>
              {ovRows.map((r) => (
                <div key={r.step}>
                <div className="flex flex-wrap items-center gap-2 py-0.5 text-[12px]">
                  <span className="w-[72px] shrink-0 text-gray-300">{NOTE_STEP_LABEL[r.step]}</span>
                  {failed.some((f) => f.step === r.step) ? (
                    <span className="rounded bg-red-500/15 px-2 py-0.5 text-[11.5px] font-semibold text-red-300">앱 판정 실패</span>
                  ) : (
                    <span className="rounded bg-white/10 px-2 py-0.5 text-[11.5px] font-semibold text-gray-400">앱 판정 성공</span>
                  )}
                  <span className="min-w-0 max-w-[330px] truncate text-[11.5px] text-gray-500" title={r.text}>
                    {r.text}
                  </span>
                  <label className="ml-auto flex items-center gap-1.5 text-gray-100">
                    <input
                      type="checkbox"
                      checked={ovSteps.includes(r.step)}
                      onChange={(e) => setOvSteps((cur) => (e.target.checked ? [...cur, r.step] : cur.filter((x) => x !== r.step)))}
                    />
                    성공으로 결과 변경
                  </label>
                </div>
                {/*
                 * 체크한 단계 바로 아래에 그 단계의 이유 칸(안 B). 여러 줄 칸 — 한 줄 input 이라 긴 이유가 옆으로만 밀려 다 보이지 않았다
                 * (2026-11-17 사용자 지적). 높이는 글에 맞춰 최대 6줄까지 늘린다
                 */}
                {ovSteps.includes(r.step) && (
                  <textarea
                    value={ovReasons[r.step] ?? ''}
                    onChange={(e) => setOvReasons((cur) => ({ ...cur, [r.step]: e.target.value }))}
                    rows={Math.min(6, Math.max(2, Math.ceil((ovReasons[r.step] ?? '').length / 50) + (ovReasons[r.step] ?? '').split('\n').length - 1))}
                    placeholder={
                      r.step === 'masakari' ? '예: VM 10대 모두 이동 완료 (2대는 Masakari 재시도로 15:55:59 복구)' : '예: 화면 3개 모두 감시 종료 뒤 정상 확인'
                    }
                    // field 의 w-full 을 빼고 왼쪽 들여쓰기만큼 줄인 폭으로 — 둘이 같이 걸려 w-full 이 이기면서 칸이 오른쪽으로 80px 넘쳤다(2026-11-17 사용자 지적)
                    className={field.replace('w-full ', '') + ' mb-1.5 ml-[80px] mt-0.5 block w-[calc(100%-80px)] resize-y'}
                  />
                )}
                </div>
              ))}
              {ovOn && <div className="ml-[80px] text-[11px] text-gray-500">체크한 단계마다 이유를 필수로 기입해주세요.</div>}
            </div>
          )}
          {drafts.length === 0 && (
            <div className="text-[12px] text-gray-500">앱이 실패로 잡은 단계가 없는 회차입니다. 검증 중 사람이 손댄 것이 있으면 아래 '수동 조치 추가' 로 적으세요.</div>
          )}
          {drafts.map((d, k) => {
            const auto = failed.find((f) => f.step === d.step)?.text
            return (
              <div key={k} className="rounded-lg border border-white/10 bg-black/20 p-3">
                <div className="mb-2 flex items-center gap-2">
                  <span
                    className={'shrink-0 rounded px-2 py-0.5 text-[11.5px] font-semibold ' + (d.step === 'manual' ? 'bg-amber-500/15 text-amber-300' : 'bg-red-500/15 text-red-300')}
                  >
                    {NOTE_STEP_LABEL[d.step]}
                  </span>
                  <span className="min-w-0 truncate text-[11.5px] text-gray-500">
                    {d.step === 'manual' ? '앱이 실패로 잡지 않은 것 · 검증 중 사람이 손댄 것' : (auto ?? '지금 기록으로는 이 단계가 실패가 아님 (예전에 적은 내용)')}
                  </span>
                  {(d.step === 'manual' || !auto) && (
                    <button
                      onClick={() => setDrafts((cur) => cur.filter((_x, j) => j !== k))}
                      title="이 카드 지우기"
                      className="ml-auto shrink-0 rounded p-0.5 text-gray-500 hover:bg-white/10 hover:text-gray-200"
                    >
                      <X size={13} />
                    </button>
                  )}
                </div>
                <div className="grid grid-cols-[84px_1fr] items-baseline gap-x-3 gap-y-2 text-[12px]">
                  {/* 이슈 · 원인 · 조치(2026-11-19 사용자 결정) — 그룹 리포트 차수별 요약의 칸과 같은 이름 · 같은 순서 */}
                  <label className="text-gray-400">
                    이슈 <span className="text-red-400">*</span>
                  </label>
                  <textarea rows={2} value={d.cause} onChange={(e) => set(k, { cause: e.target.value })} placeholder={'무엇이 일어났는지\n- 세부 내용'} className={field + ' resize-y'} />
                  <label className="text-gray-400">원인</label>
                  <textarea rows={2} value={d.why} onChange={(e) => set(k, { why: e.target.value })} placeholder="왜 그랬는지 (모르면 비워 두기)" className={field + ' resize-y'} />
                  <label className="text-gray-400">조치 내역</label>
                  <textarea rows={2} value={d.action} onChange={(e) => set(k, { action: e.target.value })} placeholder="무엇을 했는지 (없으면 비워 두기)" className={field + ' resize-y'} />
                  <label className="text-gray-400">담당자</label>
                  <div className="grid grid-cols-[1fr_64px_1fr] items-baseline gap-3">
                    <input value={d.owner} onChange={(e) => set(k, { owner: e.target.value })} placeholder="XX팀 이름" className={field} />
                    <label className="text-right text-gray-400">조치 시각</label>
                    <input value={d.atText} onChange={(e) => set(k, { atText: e.target.value })} placeholder="예: 15:09 (적으면 타임라인에)" className={field + ' font-mono'} />
                  </div>
                  {d.step === 'manual' && (
                    <>
                      <span />
                      <label className="flex cursor-pointer items-start gap-2 text-gray-200">
                        <input type="checkbox" checked={d.recovered} onChange={(e) => set(k, { recovered: e.target.checked })} className="mt-[3px]" />
                        <span>
                          이 조치가 없었으면 복구되지 않았음
                          <span className="block text-[11px] text-gray-500">켜면 이 회차는 실패로 셉니다. 잰 시간은 표에 남기고 평균에서는 뺍니다.</span>
                        </span>
                      </label>
                    </>
                  )}
                </div>
              </div>
            )
          })}
          <button
            onClick={() => setDrafts((cur) => [...cur, { step: 'manual', cause: '', why: '', action: '', owner: '', atText: '', recovered: false }])}
            className="flex w-full items-center justify-center gap-1 rounded-lg border border-dashed border-white/15 py-2 text-[12px] text-gray-400 hover:bg-white/5 hover:text-gray-200"
          >
            <Plus size={13} /> 수동 조치 추가 (앱이 실패로 잡지 못한 것 · 검증 중 사람이 손댄 것)
          </button>
          <div className="text-[11px] leading-relaxed text-gray-500">
            적은 내용은 리포트 종합 결과의 '실패 세부 원인' 표 오른쪽 칸과 회차별 결과에 나옵니다. 리포트로 저장할 때 IP · 토큰은 마스킹 설정대로 가려집니다.
          </div>
        </div>
        <div className="flex items-center gap-2 border-t border-white/10 px-4 py-2.5">
          {err && <span className="text-[11.5px] text-amber-300">{err}</span>}
          <button onClick={onClose} className="ml-auto rounded border border-white/10 px-3 py-1 text-[12px] text-gray-300 hover:bg-white/10">
            취소
          </button>
          <button onClick={save} className="rounded border border-blue-500/50 bg-blue-500/80 px-3 py-1 text-[12px] font-medium text-white hover:bg-blue-500">
            저장
          </button>
        </div>
      </div>
    </div>
  )
}

// ── 검증 그룹 · 차수 (VerifyGroup 주석) ───────────────────────────
/** VM 종류 색 — 리포트와 같은 뜻(파랑 k8s · 초록 웹 서비스 · 회색 기타), evacuation 대상은 노란 테두리 */
const VM_KIND_LABEL: Record<EnvVm['kind'], string> = { k8s: 'k8s', web: '웹 서비스', etc: '기타' }
const vmChipCls = (v: EnvVm) =>
  'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11.5px] border ' +
  (v.kind === 'k8s' ? 'border-blue-400/30 bg-blue-500/15 text-blue-100' : v.kind === 'web' ? 'border-emerald-400/30 bg-emerald-500/15 text-emerald-100' : 'border-white/15 bg-white/[0.06] text-gray-200') +
  (v.evac ? ' ring-2 ring-amber-400/70' : '')

/**
 * 환경 탭(GroupEnv 주석) — 틀 고르기 · 노드 · VM · 안내 문구. 값은 부모(그룹 편집 창)가 들고 저장할 때 같이 쓴다.
 * VM 칸을 누르면 아래에 그 VM 편집 줄이 열린다(표준 이름 · 대수 · 실제 이름 · 종류 · evacuation 대상 · 옮기기 · 빼기).
 */
function EnvEditor({
  value,
  onChange,
  others,
  hosts,
  novaFetch,
  envMap,
}: {
  value: GroupEnv | undefined
  onChange: (v: GroupEnv | undefined) => void
  /** 이 그룹의 환경 구성도 수집본 — 있으면 [실측 이름 불러오기] 가 장비에 다시 묻지 않고 이것으로 채운다 */
  envMap?: EnvMapSnapshot
  /** 복사해 올 수 있는 다른 그룹 환경 */
  others: { id: string; name: string; env: GroupEnv }[]
  /** 이 그룹 회차들이 실제로 내린 노드 이름(호스트 채우기 제안) */
  hosts: string[]
  /** Nova 에서 호스트 · VM 이름 읽기(상태보드 설정의 OpenStack 세션 · openrc) */
  novaFetch?: () => Promise<{ ok: true; hosts: NovaHosts } | { ok: false; error: string }>
}) {
  const [open, setOpen] = useState<string | null>(null)
  const [novaBusy, setNovaBusy] = useState(false)
  const [novaMsg, setNovaMsg] = useState<{
    text: string
    warn: boolean
    missed: { where: string; why: string }[]
    moves: NovaMove[]
    spare: string[]
  } | null>(null)
  /**
   * [실측 이름 불러오기] 하나(2026-11-14 사용자 결정 · 목업 envdiff-mock ①): 환경 구성도 수집본이 있으면 그것으로(장비 조회 없이 즉시),
   * 없으면 Nova 를 조회한다. 버튼을 둘 두면 무엇을 눌러야 할지 애매하다는 의견 — 어디서 가져오는지는 버튼 옆 글자로만 보인다.
   * 수집본은 검증 기본 구성 VM 만 싣고 웹 서비스 VM 은 없어서, 그 칸은 못 맞춘 안내 안에서만 'Nova 에서 다시 읽기' 를 보인다.
   * 맞추는 규칙은 같다(fillFromNova) — 수집본의 노드 · VM 이름을 Nova 결과와 같은 꼴로 넘긴다
   */
  const [lastSrc, setLastSrc] = useState<'map' | 'nova' | null>(null)
  const loadNova = async (force?: 'nova') => {
    if (!value) return
    const useMap = !!envMap && force !== 'nova'
    if (!useMap && !novaFetch) return
    setNovaBusy(true)
    setNovaMsg(null)
    setLastSrc(useMap ? 'map' : 'nova')
    try {
      const r: { ok: true; hosts: NovaHosts } | { ok: false; error: string } = useMap
        ? { ok: true, hosts: envMap!.nodes.map((n) => ({ host: n.host, vms: envMap!.vms.filter((v) => v.host === n.host).map((v) => v.name) })) }
        : await novaFetch!()
      if (!r.ok) return setNovaMsg({ text: r.error, warn: true, missed: [], moves: [], spare: [] })
      const f = fillFromNova(value, r.hosts)
      onChange(f.env)
      setNovaMsg({
        text: `${useMap ? `환경 구성도 수집본(${fmtDateTime(envMap!.at)})에서` : 'Nova 에서'} 호스트 ${r.hosts.length}개 · VM ${r.hosts.reduce((a, x) => a + x.vms.length, 0)}대를 읽어 호스트 ${f.hosts}칸 · 실측 이름 ${f.names}칸을 채웠습니다. 적어 둔 칸은 그대로 둡니다.${useMap ? ' (장비 조회 없음)' : ''}`,
        warn: f.missed.length > 0 || f.moves.length > 0,
        missed: f.missed,
        moves: f.moves,
        spare: f.spare,
      })
    } catch (e) {
      setNovaMsg({ text: `Nova 를 읽지 못했습니다(${e instanceof Error ? e.message : String(e)})`, warn: true, missed: [], moves: [], spare: [] })
    } finally {
      setNovaBusy(false)
    }
  }
  const [newVm, setNewVm] = useState<Record<string, string>>({})
  const [askTpl, setAskTpl] = useState<GroupEnv | null>(null)
  const field = 'rounded border border-white/10 bg-black/30 px-2 py-1 text-[12px] text-gray-100 placeholder:text-gray-600 focus:border-blue-500/60 focus:outline-none'
  const env = value
  const setNodes = (f: (n: EnvNode[]) => EnvNode[]) => env && onChange({ ...env, nodes: f(env.nodes) })
  const setNode = (id: string, patch: Partial<EnvNode>) => setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, ...patch } : n)))
  const setVm = (nid: string, vid: string, patch: Partial<EnvVm>) =>
    setNodes((ns) => ns.map((n) => (n.id === nid ? { ...n, vms: n.vms.map((v) => (v.id === vid ? { ...v, ...patch } : v)) } : n)))
  const pickTpl = (t: GroupEnv) => (env && env.nodes.length ? setAskTpl(t) : onChange(t))
  // 버튼 이름(2026-11-14 사용자 결정): '틀 고르기' → '환경 구성 선택', 겸용 → 믹스드(현장 용어), 빈 틀 → 수동 구성
  const tplBar = (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-[11px] text-gray-400">환경 구성 선택</span>
      <button onClick={() => pickTpl(envTemplate('4'))} className="rounded border border-white/10 px-2 py-0.5 text-[11.5px] text-gray-200 hover:bg-white/10">
        4노드 (믹스드 3 + 컴퓨트 1)
      </button>
      <button onClick={() => pickTpl(envTemplate('3'))} className="rounded border border-white/10 px-2 py-0.5 text-[11.5px] text-gray-200 hover:bg-white/10">
        3노드 (믹스드 3, 3중화)
      </button>
      <button onClick={() => pickTpl(envTemplate('empty'))} className="rounded border border-white/10 px-2 py-0.5 text-[11.5px] text-gray-200 hover:bg-white/10">
        수동 구성
      </button>
      {others.length > 0 && (
        <select
          value=""
          onChange={(e) => {
            const o = others.find((x) => x.id === e.target.value)
            if (o) pickTpl(cloneEnv(o.env))
          }}
          className="rounded border border-white/10 bg-panel-light px-1.5 py-0.5 text-[11.5px] text-gray-200"
        >
          <option value="">다른 그룹에서 복사</option>
          {others.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
      )}
    </div>
  )
  if (!env)
    return (
      <div className="space-y-2 text-[12px]">
        <div className="text-[11.5px] leading-relaxed text-gray-400">
          리포트 맨 앞 '검증 환경' 에 나올 노드 · VM 배치입니다. 환경 구성을 하나 고른 뒤 이 버전 환경에 맞게 고치세요. 노드 이름은 '노드 1' 같은 표준 이름과 실제 호스트 이름을 같이 적고,
          VM 은 표준 이름(리포트 기본)과 필요하면 실제 이름을 적습니다.
        </div>
        {tplBar}
      </div>
    )
  const nVm = env.nodes.reduce((a, n) => a + n.vms.reduce((b, v) => b + vmCount(v), 0), 0)
  return (
    <div className="space-y-3 text-[12px]">
      {askTpl && (
        <div className="flex items-center gap-2 rounded border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-[11.5px] text-amber-100">
          지금 적은 노드 · VM 을 이 구성으로 바꿀까요? (저장 전이라 취소하면 되돌릴 수 있습니다)
          <button
            onClick={() => {
              onChange({ ...askTpl, inject: env.inject || askTpl.inject })
              setAskTpl(null)
            }}
            className="ml-auto rounded border border-amber-400/50 px-2 py-0.5 hover:bg-amber-500/20"
          >
            바꾸기
          </button>
          <button onClick={() => setAskTpl(null)} className="rounded border border-white/10 px-2 py-0.5 text-gray-300 hover:bg-white/10">
            그만두기
          </button>
        </div>
      )}
      {tplBar}
      <label className="flex items-center gap-2">
        <span className="w-[86px] shrink-0 text-[11px] text-gray-400">장애 주입 방법</span>
        <input value={env.inject} onChange={(e) => onChange({ ...env, inject: e.target.value })} placeholder="예: IPMI 포털 접속 후 Power Down" className={field + ' flex-1'} />
      </label>
      {/* 좁은 창에서 글자가 한 자씩 꺾여 깨졌다(2026-11-14 사용자 지적). 항목은 줄바꿈 없이 두고 줄째로 넘긴다 */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 whitespace-nowrap text-[11px] text-gray-500">
        <span className="shrink-0">
          노드 {env.nodes.length} · VM {nVm}대
        </span>
        {(envMap || novaFetch) && (
          <>
            <button
              onClick={() => void loadNova()}
              disabled={novaBusy}
              title={
                envMap
                  ? '환경 구성도 수집본의 호스트 · VM 이름으로 비어 있는 호스트 · 실측 이름 칸을 채웁니다(장비 조회 없음)'
                  : '상태보드 설정의 OpenStack 세션 · openrc 로 nova-compute 호스트와 그 위 VM 이름을 읽어, 비어 있는 호스트 · 실측 이름 칸을 채웁니다'
              }
              className="inline-flex shrink-0 items-center gap-1 rounded border border-blue-500/40 bg-blue-500/15 px-2 py-0.5 text-blue-100 hover:bg-blue-500/25 disabled:opacity-50"
            >
              {novaBusy && <Loader2 size={11} className="animate-spin" />} 실측 이름 불러오기
            </button>
            {/* 한 줄에 다 들어가도록 짧게 — 자세한 뜻은 버튼 title 에 있다 */}
            <span className="shrink-0 text-[11px] text-blue-200/80">{envMap ? `수집본 ${fmtDateTime(envMap.at).slice(5, 16)} 기준` : 'Nova 조회'}</span>
          </>
        )}
        {hosts.length > 0 && (
          <button
            onClick={() => setNodes((ns) => ns.map((n, i) => (n.host.trim() || !hosts[i] ? n : { ...n, host: hosts[i] })))}
            title={`이 그룹 회차들이 내린 노드: ${hosts.join(', ')}. 비어 있는 호스트 칸만 순서대로 채웁니다`}
            className="shrink-0 rounded border border-white/10 px-2 py-0.5 text-gray-300 hover:bg-white/10"
          >
            회차 기록으로 호스트 채우기
          </button>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          <span className="rounded border border-blue-400/30 bg-blue-500/15 px-1.5 text-blue-100">k8s</span>
          <span className="rounded border border-emerald-400/30 bg-emerald-500/15 px-1.5 text-emerald-100">웹 서비스</span>
          <span className="rounded border border-white/15 bg-white/[0.06] px-1.5 text-gray-200">기타</span>
          <span className="rounded px-1.5 text-gray-300 ring-2 ring-amber-400/70">evacuation 대상</span>
        </span>
      </div>
      {/* 버튼만 보고는 무엇을 미리 해 둬야 하는지 몰랐다(2026-11-14 사용자 요청). 누르기 전에 알도록 버튼 바로 아래에 늘 보인다 */}
      {novaFetch && !envMap && (
        <div className="-mt-1.5 text-[11px] leading-relaxed text-gray-500">
          Nova 조회는 상태보드 설정 → ⑥ OpenStack 서비스(API) 의 조회 세션에 컨트롤러 세션을 골라 두고, 그 세션이 연결돼 있어야 동작합니다.
        </div>
      )}
      {novaMsg && (
        <div className={'space-y-1.5 rounded px-2.5 py-2 text-[11.5px] leading-relaxed ' + (novaMsg.warn ? 'bg-amber-500/10 text-amber-50' : 'bg-emerald-500/10 text-emerald-100')}>
          <div>{novaMsg.text}</div>
          {novaMsg.moves.length > 0 && (
            <div>
              <div className="flex items-center gap-2 font-semibold text-amber-200">
                환경과 다른 노드에 있는 VM {novaMsg.moves.length}개 (실제 이름은 채움)
                {novaMsg.moves.some((m) => m.toNodeId) && (
                  <button
                    onClick={() => {
                      const mv = novaMsg.moves.filter((m) => m.toNodeId)
                      setNodes((ns) => {
                        const pick = new Map(mv.map((m) => [m.vmId, m.toNodeId as string]))
                        const moving = ns.flatMap((n) => n.vms.filter((v) => pick.has(v.id)))
                        return ns.map((n) => ({
                          ...n,
                          vms: [...n.vms.filter((v) => !pick.has(v.id)), ...moving.filter((v) => pick.get(v.id) === n.id)],
                        }))
                      })
                      setNovaMsg({ ...novaMsg, moves: novaMsg.moves.filter((m) => !m.toNodeId) })
                    }}
                    title="이 VM 들을 실측(Nova · 환경 구성도)에서 올라가 있는 노드로 옮깁니다. 리포트 검증 환경의 배치가 바뀝니다"
                    className="rounded border border-amber-400/50 px-2 py-0.5 font-normal text-amber-100 hover:bg-amber-500/20"
                  >
                    실측 배치대로 옮기기
                  </button>
                )}
              </div>
              <ul className="mt-0.5 space-y-0.5 pl-1">
                {novaMsg.moves.map((m) => (
                  <li key={m.vmId} className="flex gap-1.5">
                    <span className="text-amber-300">·</span>
                    <span>
                      <b className="font-medium">{m.vm}</b> ({m.real}): 환경은 {m.fromNode}, 실측은 {m.toNode ? `${m.toNode}(${m.host})` : m.host}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {novaMsg.missed.length > 0 && (
            <div>
              <div className="flex flex-wrap items-center gap-2 font-semibold text-amber-200">
                못 맞춘 VM {novaMsg.missed.length}개 (칩을 눌러 실측 이름을 직접 적으세요)
                {/* 수집본에는 검증 기본 구성 VM 만 있어 웹 서비스 VM 등은 여기서만 Nova 로 다시 읽게 한다(버튼은 평소 하나) */}
                {lastSrc === 'map' && novaFetch && (
                  <button
                    onClick={() => void loadNova('nova')}
                    disabled={novaBusy}
                    className="rounded border border-amber-400/50 px-2 py-0.5 font-normal text-amber-100 hover:bg-amber-500/20 disabled:opacity-50"
                  >
                    Nova 에서 다시 읽기
                  </button>
                )}
              </div>
              {lastSrc === 'map' && <div className="text-[11px] font-normal text-amber-100/80">환경 구성도에는 검증 기본 구성 VM 만 있어, 웹 서비스 VM 같은 것은 Nova 조회가 필요합니다.</div>}
              <ul className="mt-0.5 space-y-0.5 pl-1">
                {novaMsg.missed.map((m) => (
                  <li key={m.where} className="flex gap-1.5">
                    <span className="text-amber-300">·</span>
                    <span>
                      <b className="font-medium">{m.where}</b>: {m.why}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {novaMsg.spare.length > 0 && (
            <details className="mt-1 text-gray-300">
              <summary className="cursor-pointer text-[11px] text-gray-400">환경에 없는 Nova VM {novaMsg.spare.length}대 (복사해서 쓰기)</summary>
              <div className="mt-1 select-text break-all font-mono text-[11px]">{novaMsg.spare.join('  ')}</div>
            </details>
          )}
        </div>
      )}
      {env.nodes.map((n, k) => (
        <div key={n.id} className="rounded-lg border border-white/10 bg-black/20 p-2.5">
          <div className="mb-2 flex flex-wrap items-center gap-1.5">
            <input value={n.label} onChange={(e) => setNode(n.id, { label: e.target.value })} title="표준 이름" className={field + ' w-[84px] font-semibold'} />
            <input value={n.host} onChange={(e) => setNode(n.id, { host: e.target.value })} placeholder="실제 호스트 이름" title="그 버전의 실제 호스트 이름" className={field + ' w-[150px]'} />
            <label className="flex items-center gap-1 text-[11.5px] text-gray-300">
              <input type="checkbox" checked={n.controller} onChange={(e) => setNode(n.id, { controller: e.target.checked })} /> 컨트롤러
            </label>
            <label className="flex items-center gap-1 text-[11.5px] text-gray-300">
              <input type="checkbox" checked={n.compute} onChange={(e) => setNode(n.id, { compute: e.target.checked })} /> 컴퓨트
            </label>
            <span className="ml-auto flex items-center gap-0.5">
              <button
                onClick={() => setNodes((ns) => (k ? [...ns.slice(0, k - 1), ns[k], ns[k - 1], ...ns.slice(k + 1)] : ns))}
                disabled={!k}
                title="위로"
                className="rounded px-1.5 text-gray-400 hover:bg-white/10 disabled:opacity-30"
              >
                ↑
              </button>
              <button
                onClick={() => setNodes((ns) => (k < ns.length - 1 ? [...ns.slice(0, k), ns[k + 1], ns[k], ...ns.slice(k + 2)] : ns))}
                disabled={k === env.nodes.length - 1}
                title="아래로"
                className="rounded px-1.5 text-gray-400 hover:bg-white/10 disabled:opacity-30"
              >
                ↓
              </button>
              <button onClick={() => setNodes((ns) => ns.filter((x) => x.id !== n.id))} title="이 노드 빼기" className="rounded p-0.5 text-gray-500 hover:bg-white/10 hover:text-gray-200">
                <X size={13} />
              </button>
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {n.vms.map((v) => (
              <button
                key={v.id}
                onClick={() => setOpen(open === v.id ? null : v.id)}
                title={(v.real ?? []).some((x) => x.trim()) ? `실제 이름: ${vmDisplay(v, true)} (눌러서 고치기)` : '눌러서 고치기'}
                className={vmChipCls(v) + (open === v.id ? ' outline outline-1 outline-white/60' : '')}>
                {v.name}
                {vmCount(v) > 1 && <b>({vmCount(v)}대)</b>}
                {/* 실제 이름을 채운 칩 표시 — '실제' 는 무엇이 실제인지 모호해 '실측' 으로(2026-11-14 사용자 결정) */}
                {(v.real ?? []).some((x) => x.trim()) && <span className="text-[10px] opacity-70">실측</span>}
              </button>
            ))}
            <input
              value={newVm[n.id] ?? ''}
              onChange={(e) => setNewVm((c) => ({ ...c, [n.id]: e.target.value }))}
              onKeyDown={(e) => {
                const v = (newVm[n.id] ?? '').trim()
                if (e.key !== 'Enter' || !v) return
                const kind: EnvVm['kind'] = /master|infra|biz|manager|k8s|worker/i.test(v) ? 'k8s' : /web/i.test(v) ? 'web' : 'etc'
                setNode(n.id, { vms: [...n.vms, { id: newId('vm'), name: v, kind, evac: kind !== 'k8s' }] })
                setNewVm((c) => ({ ...c, [n.id]: '' }))
              }}
              placeholder="+ VM 이름 (Enter)"
              className={field + ' w-[130px] py-0.5 text-[11.5px]'}
            />
          </div>
          {n.vms
            .filter((v) => v.id === open)
            .map((v) => (
              <div key={v.id} className="mt-2 grid grid-cols-[70px_1fr] items-start gap-x-2 gap-y-1.5 rounded border border-white/10 bg-black/30 p-2 text-[11.5px]">
                <span className="pt-1 text-gray-400">표준 이름</span>
                <div className="flex flex-wrap items-center gap-1.5">
                  <input value={v.name} onChange={(e) => setVm(n.id, v.id, { name: e.target.value })} className={field + ' w-[150px]'} />
                  <span className="text-gray-400">대수</span>
                  <input
                    value={v.count ?? 1}
                    onChange={(e) => {
                      const c = Math.max(1, Math.min(200, Number(e.target.value.replace(/\D/g, '')) || 1))
                      setVm(n.id, v.id, { count: c > 1 ? c : undefined })
                    }}
                    title="묶음 VM 이면 대수(예: webserver01~10 → 10)"
                    className={field + ' w-[52px] text-right'}
                  />
                  <select value={v.kind} onChange={(e) => setVm(n.id, v.id, { kind: e.target.value as EnvVm['kind'] })} className={field}>
                    {(['k8s', 'web', 'etc'] as const).map((x) => (
                      <option key={x} value={x}>
                        {VM_KIND_LABEL[x]}
                      </option>
                    ))}
                  </select>
                  <label className="flex items-center gap-1 text-gray-200">
                    <input type="checkbox" checked={v.evac} onChange={(e) => setVm(n.id, v.id, { evac: e.target.checked })} /> evacuation 대상
                  </label>
                </div>
                <span className="pt-1 text-gray-400">실제 이름</span>
                <div>
                  <textarea
                    rows={Math.min(5, Math.max(1, vmCount(v)))}
                    value={(v.real ?? []).join('\n')}
                    onChange={(e) => setVm(n.id, v.id, { real: e.target.value.split('\n') })}
                    placeholder={vmCount(v) > 1 ? `한 줄에 하나씩 ${vmCount(v)}개 (비우면 리포트에 표준 이름)` : '비우면 리포트에 표준 이름'}
                    className={field + ' w-full resize-y font-mono'}
                  />
                  {(() => {
                    const c = (v.real ?? []).filter((x) => x.trim()).length
                    return c > 0 && c !== vmCount(v) ? <div className="text-amber-300">{vmCount(v)}대인데 실제 이름이 {c}개입니다</div> : null
                  })()}
                </div>
                <span />
                <div className="flex items-center gap-1.5">
                  <select
                    value=""
                    onChange={(e) => {
                      const to = e.target.value
                      if (!to) return
                      setNodes((ns) => ns.map((x) => (x.id === n.id ? { ...x, vms: x.vms.filter((y) => y.id !== v.id) } : x.id === to ? { ...x, vms: [...x.vms, v] } : x)))
                    }}
                    className={field}
                  >
                    <option value="">다른 노드로 옮기기</option>
                    {env.nodes
                      .filter((x) => x.id !== n.id)
                      .map((x) => (
                        <option key={x.id} value={x.id}>
                          {x.label}
                        </option>
                      ))}
                  </select>
                  <button
                    onClick={() => {
                      setNode(n.id, { vms: n.vms.filter((y) => y.id !== v.id) })
                      setOpen(null)
                    }}
                    className="rounded border border-white/10 px-2 py-0.5 text-gray-300 hover:bg-white/10"
                  >
                    이 VM 빼기
                  </button>
                  <button onClick={() => setOpen(null)} className="ml-auto rounded border border-white/10 px-2 py-0.5 text-gray-300 hover:bg-white/10">
                    접기
                  </button>
                </div>
              </div>
            ))}
        </div>
      ))}
      <button
        onClick={() =>
          setNodes((ns) => [...ns, { id: newId('nd'), label: `노드 ${ns.length + 1}`, host: '', controller: false, compute: true, vms: [] }])
        }
        className="flex w-full items-center justify-center gap-1 rounded-lg border border-dashed border-white/15 py-1.5 text-[12px] text-gray-400 hover:bg-white/5 hover:text-gray-200"
      >
        <Plus size={13} /> 노드 더하기
      </button>
      <label className="block">
        <span className="mb-1 block text-[11px] text-gray-400">안내 문구 (한 줄이 한 항목, 리포트 카드 아래 '* …' 로. 문구 속 표준 VM 이름은 실제 이름 리포트에서 바뀝니다)</span>
        <textarea rows={2} value={env.notes.join('\n')} onChange={(e) => onChange({ ...env, notes: e.target.value.split('\n') })} className={field + ' w-full resize-y'} />
      </label>
    </div>
  )
}

/**
 * 차수의 이슈 · 팀별 조치(목업 group-mock2 A) — 리포트 '차수별 요약' 의 이슈 및 조치 칸이 그대로 이것이다.
 * 이슈는 관련 회차를 눌러 고르면 리포트에 '#번호' 가 붙는다. 첫 줄이 제목, 아래 줄이 설명.
 * 조치는 팀 · 원인 · 내용 · 결과 + 관련 이슈(2026-11-16 시안 C — 리포트에서 어느 조치가 어느 이슈인지 칸으로 보이게. 줄 짜기는 lib/phaseSummary).
 * [회차 원인 · 조치 가져오기] 는 이 차수 회차들에 적어 둔 원인(RunNote)을 이슈로 옮긴다(같은 글은 다시 넣지 않는다).
 */
function PhaseNotesEditor({
  phase,
  runs,
  numOf,
  teams,
  onChange,
}: {
  phase: GroupPhase
  /** 이 차수 회차(시작 시각 순) */
  runs: HistoryRecord[]
  numOf: (id: string) => number
  teams: string[]
  onChange: (ph: GroupPhase) => void
}) {
  const field = 'rounded border border-white/10 bg-black/30 px-2 py-1 text-[12px] text-gray-100 placeholder:text-gray-600 focus:border-blue-500/60 focus:outline-none'
  const setIssue = (id: string, patch: Partial<PhaseIssue>) => onChange({ ...phase, issues: phase.issues.map((x) => (x.id === id ? { ...x, ...patch } : x)) })
  const setAct = (id: string, patch: Partial<PhaseAction>) => onChange({ ...phase, actions: phase.actions.map((x) => (x.id === id ? { ...x, ...patch } : x)) })
  const fromNotes = runs.flatMap((h) => (h.notes ?? []).filter((n) => n.cause.trim()).map((n) => ({ h, n })))
  /** 조치의 관련 이슈 칩에 쓸 이슈 — 글이 있는 것만 */
  const issueList = phase.issues.filter((i) => i.text.trim())
  const dlId = `teams-${phase.id}`
  return (
    <div className="mt-1.5 space-y-2.5 rounded-lg border border-white/10 bg-black/20 p-2.5 text-[12px]">
      <datalist id={dlId}>
        {teams.map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>
      <div>
        <div className="mb-1 flex items-center gap-2">
          <span className="font-semibold text-gray-200">① 이슈</span>
          <button
            onClick={() => onChange({ ...phase, issues: [...phase.issues, { id: newId('is'), text: '', runIds: [] }] })}
            className="ml-auto rounded border border-white/10 px-2 py-0.5 text-[11.5px] text-gray-200 hover:bg-white/10"
          >
            + 이슈
          </button>
        </div>
        {phase.issues.length === 0 && <div className="text-[11.5px] text-gray-500">이슈가 없습니다. 리포트에는 '없음' 으로 나옵니다.</div>}
        {phase.issues.map((x) => (
          // 회차가 없으면 회차 고르기 칸을 아예 빼고 입력칸을 넓힌다(2026-11-14 사용자 요청: '회차가 아직 없습니다' 안내가 불필요했다.
          // 넣는 방법은 새 그룹 창 위 '검증 그룹 쓰는 순서' 가 알려 준다)
          <div key={x.id} className={'mb-1.5 grid items-start gap-2 ' + (runs.length ? 'grid-cols-[1fr_200px_20px]' : 'grid-cols-[1fr_20px]')}>
            <textarea rows={2} value={x.text} onChange={(e) => setIssue(x.id, { text: e.target.value })} placeholder={'이슈 (첫 줄 제목)\n- 설명'} className={field + ' resize-y'} />
            <div className={runs.length ? 'flex flex-wrap gap-1' : 'hidden'}>
              {runs.map((h) => {
                const on = x.runIds.includes(h.id)
                return (
                  <button
                    key={h.id}
                    onClick={() => setIssue(x.id, { runIds: on ? x.runIds.filter((y) => y !== h.id) : [...x.runIds, h.id] })}
                    title={`${h.label || h.node} · ${fmtDateTime(h.t0)}`}
                    className={'rounded border px-1.5 text-[11px] ' + (on ? 'border-blue-400/60 bg-blue-500/25 text-blue-100' : 'border-white/10 text-gray-400 hover:bg-white/10')}
                  >
                    #{numOf(h.id)}
                  </button>
                )
              })}
              {runs.length > 0 && !x.runIds.length && <span className="text-[11px] text-gray-500">공통</span>}
            </div>
            <button onClick={() => onChange({ ...phase, issues: phase.issues.filter((y) => y.id !== x.id) })} title="이 이슈 지우기" className="rounded p-0.5 text-gray-500 hover:bg-white/10 hover:text-gray-200">
              <X size={13} />
            </button>
          </div>
        ))}
        {fromNotes.length > 0 && (
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-gray-500">
            이 차수 회차에 적은 원인 · 조치 {fromNotes.length}건
            <button
              onClick={() => {
                // 원인 → 이슈(회차 모음), 조치 → 담당자 팀별 조치(회차에 적은 조치는 이미 한 일이라 '조치 완료' 로 넣고 사람이 고친다). 이미 있는 글은 다시 넣지 않는다.
                // 조치의 관련 이슈는 같은 기록의 원인으로 잇는다(notesToPhase). 이미 들어 있는 이슈 글이면 그 이슈에 잇고, 전에 가져와
                // 관련 이슈가 비어 있는 조치는 다시 누르면 채운다(2026-11-19 — 옛 가져오기로 '공통 조치' 가 된 차수를 버튼 하나로 고치게). 사람이 고른 연결은 건드리지 않는다
                const d = notesToPhase(runs)
                const byText = new Map(phase.issues.map((x) => [x.text.trim(), x.id]))
                const added = d.issues.filter((x) => !byText.has(x.text))
                for (const x of added) byText.set(x.text, x.id)
                const textOf = new Map(d.issues.map((x) => [x.id, x.text]))
                const idsOf = (a: { issueIds?: string[] }) => [...new Set((a.issueIds ?? []).map((id) => byText.get(textOf.get(id) ?? '')).filter((x): x is string => !!x))]
                const fromD = new Map(d.actions.map((x) => [`${x.team}\n${x.text}`, x]))
                const haveA = new Set(phase.actions.map((x) => `${x.team.trim()}\n${x.text.trim()}`))
                onChange({
                  ...phase,
                  issues: [...phase.issues, ...added],
                  actions: [
                    ...phase.actions.map((x) => {
                      const m = fromD.get(`${x.team.trim()}\n${x.text.trim()}`)
                      if (!m) return x
                      // 비어 있는 것만 채운다(관련 이슈 · 원인) — 사람이 고르거나 적은 것은 그대로
                      return { ...x, issueIds: (x.issueIds ?? []).length ? x.issueIds : idsOf(m), cause: x.cause?.trim() ? x.cause : m.cause }
                    }),
                    ...d.actions.filter((x) => !haveA.has(`${x.team}\n${x.text}`)).map((x) => ({ ...x, issueIds: idsOf(x), result: 'done' as const })),
                  ],
                })
              }}
              className="rounded border border-white/10 px-2 py-0.5 text-gray-300 hover:bg-white/10"
            >
              원인 · 조치 가져오기
            </button>
            <span>비워 두면 리포트가 이 회차 기록을 자동으로 모아 싣습니다</span>
          </div>
        )}
      </div>
      <div>
        <div className="mb-1 flex items-center gap-2">
          <span className="font-semibold text-gray-200">② 팀별 조치</span>
          <button
            onClick={() => onChange({ ...phase, actions: [...phase.actions, { id: newId('ac'), team: '', text: '', result: 'done' }] })}
            className="ml-auto rounded border border-white/10 px-2 py-0.5 text-[11.5px] text-gray-200 hover:bg-white/10"
          >
            + 조치
          </button>
        </div>
        {phase.actions.length > 0 && (
          <div className="mb-0.5 grid grid-cols-[110px_1fr_1.4fr_96px_20px] gap-2 text-[10.5px] text-gray-500">
            <span>팀</span>
            <span>원인</span>
            <span>조치 (줄마다 • · '-' 로 시작하면 위 조치의 세부)</span>
            <span>결과</span>
          </div>
        )}
        {phase.actions.map((x) => {
          const linked = (x.issueIds ?? []).filter((id) => issueList.some((i) => i.id === id))
          return (
            <div key={x.id} className="mb-2 border-t border-white/5 pt-1.5 first-of-type:border-t-0">
              <div className="grid grid-cols-[110px_1fr_1.4fr_96px_20px] items-start gap-2">
                <input list={dlId} value={x.team} onChange={(e) => setAct(x.id, { team: e.target.value })} placeholder="팀 (예: Expert팀)" className={field} />
                {/* 원인은 조치마다(시안 C). 같은 팀 · 같은 이슈 조치에 원인을 한 번만 적어도 리포트에서 한 칸으로 합쳐진다(lib/phaseSummary) */}
                <textarea value={x.cause ?? ''} onChange={(e) => setAct(x.id, { cause: e.target.value })} placeholder="원인 (비우면 '-')" className={field + ' h-[55px] resize-y leading-[18px]'} />
                {/* 2.5줄 높이(줄 18px x 2.5 + 위아래 여백 · 테두리 10px). 2026-11-14 사용자 요청: 회차 조치를 불러오면 한 줄 칸이라 글이 잘려 보였다.
                    반 줄을 더 보여 줘서 아래에 글이 더 있다는 것을 알 수 있게 한다. 더 보려면 오른쪽 아래 모서리로 늘린다 */}
                <textarea value={x.text} onChange={(e) => setAct(x.id, { text: e.target.value })} placeholder={'조치한 내용\n- 세부 내용'} className={field + ' h-[55px] resize-y leading-[18px]'} />
                <select value={x.result} onChange={(e) => setAct(x.id, { result: e.target.value as PhaseAction['result'] })} className={field}>
                  <option value="done">조치 완료</option>
                  <option value="wip">확인 중</option>
                  <option value="ok">재현 안 됨</option>
                  <option value="repro">재현됨</option>
                  <option value="none">표시 안 함</option>
                </select>
                <button onClick={() => onChange({ ...phase, actions: phase.actions.filter((y) => y.id !== x.id) })} title="이 조치 지우기" className="rounded p-0.5 text-gray-500 hover:bg-white/10 hover:text-gray-200">
                  <X size={13} />
                </button>
              </div>
              {/* 관련 이슈 — 이름 칩(번호 없이, 사용자 요청). 안 고르면 리포트 '공통 조치' */}
              {issueList.length > 0 && (
                <div className="mt-1 flex flex-wrap items-center gap-1 pl-[118px] text-[11px] text-gray-500">
                  관련 이슈
                  {issueList.map((i) => {
                    const on = linked.includes(i.id)
                    const title = i.text.trim().split(/\r?\n/)[0]
                    return (
                      <button
                        key={i.id}
                        onClick={() => setAct(x.id, { issueIds: on ? linked.filter((y) => y !== i.id) : [...linked, i.id] })}
                        title={i.text.trim()}
                        className={'max-w-[220px] truncate rounded-full border px-2 ' + (on ? 'border-blue-400/60 bg-blue-500/25 text-blue-100' : 'border-white/10 text-gray-400 hover:bg-white/10')}
                      >
                        {title}
                      </button>
                    )
                  })}
                  {!linked.length && <span className="text-gray-600">(안 고르면 공통 조치)</span>}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/**
 * 그룹 만들기 · 고치기 — 이름과 차수 목록. 차수를 지우면 그 차수의 회차는 지워지지 않고 '차수 없음' 으로 남는다(pruneMembership).
 * 닫기는 X · 취소 · 저장뿐(모달 규칙).
 */
/**
 * OpenStack 서비스 버전 변경 날짜(2026-11-19 사용자 요청: 수집한 날이 아니라 실제로 바뀐 날). 기본은 노드의 패키지 설치 기록(rpm INSTALLTIME)이고,
 * 못 읽었거나 실제 작업일이 다르면 여기서 고른다. 같은 서비스 · 같은 전후 버전 · 같은 날은 노드를 묶어 한 줄로(세 노드를 한 번에 고친다).
 * 고른 날은 그날 0시로 남기고 manual 을 켠다 — 다음 수집에서 버전이 그대로면 고른 날이 그대로 이어진다(osVerChanges)
 */
function VerChangeDates({ snap, onChange }: { snap: EnvMapSnapshot; onChange: (v: EnvMapSnapshot) => void }) {
  const list = snap.verChanges ?? []
  const day = (t: number) => fmtDateTime(t).slice(0, 10)
  const groups = new Map<string, OsVerChange[]>()
  for (const c of list) {
    const k = `${c.svc}\n${c.from}\n${c.to}\n${day(c.at)}`
    groups.set(k, [...(groups.get(k) ?? []), c])
  }
  const label = (host: string) => snap.nodes.find((n) => n.host === host)?.label ?? host
  return (
    <div className="mt-2 rounded border border-orange-400/30 bg-orange-500/[0.06] px-2.5 py-1.5 text-[11.5px]">
      <div className="mb-1 text-[11px] text-orange-200">OpenStack 버전 변경 (구성도 버전 표의 주황 칸 · 날짜를 고르면 그 날짜로 실립니다)</div>
      {[...groups.entries()].map(([k, cs]) => {
        const c = cs[0]
        return (
          <div key={k} className="flex flex-wrap items-center gap-2 py-0.5">
            <b className="w-[120px] shrink-0 text-gray-100">{c.svc}</b>
            <span className="font-mono text-gray-300">
              {c.from} → <span className="text-orange-200">{c.to}</span>
            </span>
            <span className="text-gray-500">{cs.map((x) => label(x.host)).join(' · ')}</span>
            <input
              type="date"
              value={day(c.at)}
              onChange={(e) => {
                const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(e.target.value)
                if (!m) return
                const at = new Date(+m[1], +m[2] - 1, +m[3]).getTime()
                const set = new Set(cs)
                onChange({ ...snap, verChanges: list.map((x) => (set.has(x) ? { ...x, at, manual: true } : x)) })
              }}
              className="ml-auto rounded border border-white/10 bg-panel-light px-1.5 py-0.5 text-[11.5px] text-gray-100 [color-scheme:dark]"
            />
            <span className="w-[150px] text-[11px] text-gray-500">{c.manual ? '직접 고른 날짜' : c.installed ? '패키지 설치 기록' : '수집한 날(설치 기록 못 읽음)'}</span>
          </div>
        )
      })}
    </div>
  )
}

/** 환경 구성도 파일 이름 */
const envMapFile = (groupName: string, at: number, ext: string) => `환경구성도_${fileSafe(groupName || '검증그룹')}_${stampOf(at)}.${ext}`
/**
 * 환경 구성도 보기 — 앱 안 큰 창에 그대로 띄운다(파일로 저장하기 전에 확인). 배경 클릭으로 닫지 않는다(모달 규칙)
 */
function EnvMapViewer({
  snap,
  title,
  fileBase,
  onClose,
  page,
}: {
  snap?: EnvMapSnapshot
  title: string
  fileBase: { group: string; at: number }
  onClose: () => void
  /** 구성도가 아닌 다른 페이지(수집본 비교) — 보기 · 저장에 이 HTML 을 그대로 쓴다 */
  page?: { html: string; name: string }
}) {
  const [msg, setMsg] = useState('')
  // 앱 안에서는 '확인 필요' 상자까지 보이고, 저장 파일에는 싣지 않는다(renderEnvMapHtml checks 주석)
  const view = useMemo(() => page?.html ?? (snap ? renderEnvMapHtml(snap, { title, checks: true }) : ''), [page, snap, title])
  const html = useMemo(() => page?.html ?? (snap ? renderEnvMapHtml(snap, { title }) : ''), [page, snap, title])
  const save = async (png: boolean) => {
    setMsg('')
    const name = page ? page.name.replace(/\.html$/, png ? '.png' : '.html') : envMapFile(fileBase.group, fileBase.at, png ? 'png' : 'html')
    const r = png ? await window.electronAPI.saveHtmlPng({ html, defaultName: name }) : await window.electronAPI.saveReport({ defaultName: name, content: html, format: 'html' })
    setMsg(r.saved ? `저장했습니다. ${r.path ?? ''}${'cut' in r && r.cut ? ' (그림이 너무 길어 아래 일부가 잘렸습니다. 전체는 HTML 로 저장하세요)' : ''}` : r.error ? `저장 실패: ${r.error}` : '')
  }
  return (
    <div className="fixed inset-0 z-[80] flex flex-col bg-black/70 p-5">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-white/10 bg-panel shadow-2xl">
        <div className="flex items-center gap-2 border-b border-white/10 px-4 py-2">
          <span className="text-sm font-semibold text-gray-100">{title}</span>
          {msg && <span className="truncate text-[11.5px] text-gray-400">{msg}</span>}
          <button onClick={() => void save(false)} className="ml-auto rounded border border-white/10 px-2.5 py-0.5 text-[12px] text-gray-200 hover:bg-white/10">
            HTML 저장
          </button>
          <button onClick={() => void save(true)} className="rounded border border-white/10 px-2.5 py-0.5 text-[12px] text-gray-200 hover:bg-white/10">
            PNG 저장
          </button>
          <button onClick={onClose} title="닫기" className="rounded p-1 text-gray-400 hover:bg-white/10 hover:text-gray-100">
            <X size={15} />
          </button>
        </div>
        <iframe title={title} srcDoc={view} sandbox="allow-scripts" className="min-h-0 flex-1 bg-white" />
      </div>
    </div>
  )
}
/**
 * 그룹 편집 → 환경 구성도 탭(2026-11-14 사용자 결정 · 목업 envmap-tool-mock). 수집 · 요약 · 확인 필요 · 노드별 미리 보기 · 보기/저장.
 * 수집본은 이 창의 [저장] 으로 그룹에 남는다(다른 탭과 같다 — 취소하면 버린다).
 */
function EnvMapPanel({
  value,
  onChange,
  collect,
  groupName,
  env,
  dirty,
  others = [],
}: {
  value?: EnvMapSnapshot
  /** 수집본이 있는 다른 그룹 — 비교 대상 */
  others?: { id: string; name: string; envMap: EnvMapSnapshot }[]
  onChange: (v: EnvMapSnapshot) => void
  collect?: EnvCollect
  groupName: string
  env?: GroupEnv
  /** 저장 안 한 새 수집본 */
  dirty: boolean
}) {
  type St = { st: 'run' | 'ok' | 'fail'; msg?: string; t0: number; ms?: number }
  const [steps, setSteps] = useState<Partial<Record<EnvStep, St>>>({})
  const [busy, setBusy] = useState(false)
  const [view, setView] = useState(false)
  const [msg, setMsg] = useState('')
  /** 비교할 다른 그룹(수집본) — 왼쪽이 그 그룹(이전), 오른쪽이 이 그룹(지금) */
  const [cmpId, setCmpId] = useState(() => others[0]?.id ?? '')
  const [cmpView, setCmpView] = useState(false)
  /*
   * 고른 그룹이 이후(To-Be)인가(2026-11-17 사용자 요청). 예전엔 고른 그룹이 늘 이전 · 이 그룹이 지금이었다 — 업그레이드 뒤 그룹을 새로 만들어
   * 수집하면 맞지만, 업그레이드 전 그룹에서 '업그레이드 후' 그룹을 고르면 앞뒤가 뒤집혀 '26.4.0 → 26.0.0' 으로 읽혔다
   */
  const [cmpAfter, setCmpAfter] = useState(false)
  const cmp = others.find((o) => o.id === cmpId) ?? others[0]
  const diffPage = useMemo(() => {
    if (!value || !cmp) return null
    const me = { envMap: value, name: groupName || '이 그룹' }
    const [a, b] = cmpAfter ? [me, cmp] : [cmp, me]
    return {
      html: renderEnvDiffHtml(a.envMap, b.envMap, { title: '환경 구성도 비교', nameA: a.name, nameB: b.name }),
      name: `환경구성도비교_${fileSafe(a.name)}_${fileSafe(b.name)}_${stampOf(Math.max(a.envMap.at, b.envMap.at))}.html`,
    }
  }, [value, cmp, groupName, cmpAfter])
  const sess = collect?.sessions()
  const title = `환경 구성도 · ${groupName || '검증 그룹'}`
  const html = useMemo(() => (value ? renderEnvMapHtml(value, { title }) : ''), [value, title])
  const doCollect = async () => {
    if (!collect || busy) return
    setBusy(true)
    setMsg('')
    setSteps({})
    try {
      const raw = await collect.run((k, st, m) =>
        setSteps((cur) => {
          const t0 = st === 'run' ? Date.now() : cur[k]?.t0 ?? Date.now()
          return { ...cur, [k]: { st, msg: m, t0, ms: st === 'run' ? undefined : Date.now() - t0 } }
        }),
      )
      // 노드 표준 이름은 환경 탭에 적어 둔 것을 따른다(호스트가 같으면 '노드 1' 등). VM 은 환경 탭의 실제 이름도 고르는 데 넣는다
      const labels = Object.fromEntries((env?.nodes ?? []).filter((n) => n.host.trim()).map((n) => [n.host.trim(), n.label]))
      const keepVms = (env?.nodes ?? []).flatMap((n) => n.vms.flatMap((v) => v.real ?? []))
      // 직전 수집본을 넘겨 바뀐 OpenStack 서비스 버전을 남긴다(osVerChanges — 구성도는 그룹마다 하나라 덮이면 이전 버전이 사라진다)
      onChange(buildEnvMap(raw, { labels, keepVms, prev: value }))
    } catch (e) {
      setMsg(`수집하지 못했습니다(${e instanceof Error ? e.message : String(e)})`)
    } finally {
      setBusy(false)
    }
  }
  const save = async (png: boolean) => {
    if (!value) return
    setMsg('')
    const name = envMapFile(groupName, value.at, png ? 'png' : 'html')
    const r = png ? await window.electronAPI.saveHtmlPng({ html, defaultName: name }) : await window.electronAPI.saveReport({ defaultName: name, content: html, format: 'html' })
    setMsg(r.saved ? `저장했습니다. ${r.path ?? ''}${'cut' in r && r.cut ? ' (그림이 너무 길어 아래 일부가 잘렸습니다. 전체는 HTML 로 저장하세요)' : ''}` : r.error ? `저장 실패: ${r.error}` : '')
  }
  const k8s = value?.k8s
  const nPods = k8s?.workloads.reduce((a, w) => a + Object.values(w.at).reduce((x, y) => x + y, 0) + w.pending, 0) ?? 0
  const errs = value ? Object.entries(value.errors) : []
  const btn = 'rounded border border-white/10 px-2.5 py-1 text-[12px] text-gray-200 hover:bg-white/10 disabled:opacity-40'
  return (
    <div className="space-y-3 text-[12px]">
      <div className="text-[11.5px] leading-relaxed text-gray-400">
        장비에서 조회한 실제 구성입니다. 환경 탭(사람이 정한 표준 이름 · evacuation 대상)과 따로 두고 서로 덮어쓰지 않습니다. 검증을 시작하기 전 형상으로 수집해 두세요.
      </div>
      <div className="rounded border border-white/10 bg-white/[0.02] px-3 py-2.5">
        {value ? (
          <div className="grid grid-cols-[86px_1fr] gap-x-3 gap-y-1 text-[11.5px]">
            <span className="text-gray-400">마지막 수집</span>
            <span className="text-gray-100">
              {fmtDateTime(value.at)}
              {dirty && <span className="ml-2 text-amber-300">저장을 눌러야 이 그룹에 남습니다</span>}
            </span>
            <span className="text-gray-400">요약</span>
            <span className="text-emerald-300">
              물리 노드 {value.nodes.length} · 검증 VM {value.vms.length}
              {k8s ? ` · k8s 노드 ${k8s.nodes.length} · 워크로드 ${k8s.workloads.length} · 파드 ${nPods}` : ''}
            </span>
            {value.warnings.length > 0 && (
              <>
                <span className="text-gray-400">확인 필요</span>
                <ul className="space-y-0.5 text-amber-200">
                  {value.warnings.map((w, i) => (
                    <li key={i}>· {w}</li>
                  ))}
                </ul>
              </>
            )}
            {errs.length > 0 && (
              <>
                <span className="text-gray-400">못 읽음</span>
                <ul className="space-y-0.5 text-red-300">
                  {errs.map(([k, v]) => (
                    <li key={k}>
                      · {k}: {v}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        ) : (
          <div className="text-[11.5px] text-gray-400">아직 수집하지 않았습니다. [수집] 을 누르면 아래 세션으로 조회합니다.</div>
        )}
        {value && (value.verChanges?.length ?? 0) > 0 && <VerChangeDates snap={value} onChange={onChange} />}
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <button onClick={() => void doCollect()} disabled={!collect || busy} className="inline-flex items-center gap-1 rounded border border-blue-500/60 bg-blue-500/80 px-2.5 py-1 text-[12px] font-medium text-white hover:bg-blue-500 disabled:opacity-50">
            {busy && <Loader2 size={12} className="animate-spin" />}
            {value ? '다시 수집' : '수집'}
          </button>
          <button onClick={() => setView(true)} disabled={!value || busy} className={btn}>
            구성도 보기
          </button>
          <button onClick={() => void save(false)} disabled={!value || busy} className={btn}>
            HTML 저장
          </button>
          <button onClick={() => void save(true)} disabled={!value || busy} className={btn}>
            PNG 저장
          </button>
          <span className="ml-auto text-[11px] text-gray-500">조회 명령만 실행합니다(설정 · 상태 변경 없음)</span>
        </div>
        {msg && <div className="mt-1.5 text-[11.5px] text-gray-300">{msg}</div>}
      </div>
      {/* 수집본 비교(2026-11-14 사용자 결정 · 목업 envdiff-mock ②) — 수집본은 그룹(버전)마다 하나라 비교 대상은 수집본이 있는 다른 그룹 */}
      {value && (
        <div className="rounded border border-white/10 px-3 py-2">
          {cmp ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[11px] font-semibold text-amber-200">비교</span>
              <select
                value={cmpAfter ? 'after' : 'before'}
                onChange={(e) => setCmpAfter(e.target.value === 'after')}
                title="고른 그룹을 업그레이드 · 변경 전(As-Is)으로 볼지 후(To-Be)로 볼지"
                className="rounded border border-white/10 bg-panel-light px-1.5 py-0.5 text-[11.5px] text-gray-100"
              >
                <option value="before">이전(As-Is)</option>
                <option value="after">이후(To-Be)</option>
              </select>
              <select value={cmp.id} onChange={(e) => setCmpId(e.target.value)} className="min-w-0 max-w-[340px] rounded border border-white/10 bg-panel-light px-1.5 py-0.5 text-[11.5px] text-gray-100">
                {others.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name} ({fmtDateTime(o.envMap.at).slice(0, 10)} 수집)
                  </option>
                ))}
              </select>
              <span className="text-[11px] text-gray-400">{cmpAfter ? '· 이 그룹은 이전(As-Is)' : '· 이 그룹은 이후(To-Be)'}</span>
              <button onClick={() => setCmpView(true)} disabled={busy} className={btn}>
                비교 보기
              </button>
              <button
                onClick={async () => {
                  if (!diffPage) return
                  const r = await window.electronAPI.saveReport({ defaultName: diffPage.name, content: diffPage.html, format: 'html' })
                  setMsg(r.saved ? `비교를 저장했습니다. ${r.path ?? ''}` : r.error ? `저장 실패: ${r.error}` : '')
                }}
                disabled={busy}
                className={btn}
              >
                비교 HTML 저장
              </button>
            </div>
          ) : (
            <div className="text-[11px] text-gray-500">다른 그룹(버전)에 환경 구성도 수집본이 생기면 여기서 비교할 수 있습니다.</div>
          )}
        </div>
      )}
      {cmpView && diffPage && cmp && <EnvMapViewer title={`환경 구성도 비교 · ${cmpAfter ? `${groupName || '이 그룹'} → ${cmp.name}` : `${cmp.name} → ${groupName || '이 그룹'}`}`} fileBase={{ group: groupName, at: value?.at ?? Date.now() }} page={diffPage} onClose={() => setCmpView(false)} />}
      <div className="rounded border border-white/10 px-3 py-2">
        <div className="mb-1 text-[11px] text-gray-400">수집 출처 (상태보드 설정 그대로)</div>
        <div className="space-y-0.5">
          {ENV_STEPS.map((x) => {
            const st = steps[x.k]
            return (
              <div key={x.k} className="flex items-start gap-2 text-[11.5px]">
                <span className={'w-4 shrink-0 text-center ' + (st?.st === 'ok' ? 'text-emerald-400' : st?.st === 'fail' ? 'text-red-400' : 'text-gray-500')}>
                  {st?.st === 'run' ? <Loader2 size={11} className="mt-0.5 inline animate-spin" /> : st?.st === 'ok' ? '✓' : st?.st === 'fail' ? '✕' : '·'}
                </span>
                <span className="w-[178px] shrink-0 text-gray-200">{x.label}</span>
                <span className="min-w-0 flex-1 text-gray-500">
                  {sess?.[x.k] ?? '-'}
                  {st?.msg ? <span className={'block ' + (st.st === 'fail' ? 'text-red-300' : 'text-gray-400')}>{st.msg}</span> : null}
                </span>
                {st?.ms != null && <span className="shrink-0 text-gray-500">{(st.ms / 1000).toFixed(1)}초</span>}
              </div>
            )
          })}
        </div>
        <details className="mt-1.5 text-[11px] text-gray-500">
          <summary className="cursor-pointer select-none hover:text-gray-300">실행하는 명령 보기</summary>
          <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-black/30 p-2 font-mono text-[10.5px] leading-relaxed text-gray-400">
            {[
              `# 물리 노드마다\n${NODE_SCRIPT.split('; ').filter((x) => !x.startsWith('echo')).join('\n')}`,
              `# OpenStack 조회 세션\n${CTRL_SCRIPT.split('; ').filter((x) => !x.startsWith('echo')).join('\n')}\n${Object.values(OS_CMDS).map((x) => `openstack ${x} -f json`).join('\n')}\nopenstack segment host list <세그먼트> -f json`,
              `# Ceph 조회 세션\n${CEPH_SCRIPT.split('; ').filter((x) => !x.startsWith('echo')).join('\n')}`,
              `# kubectl 조회 세션\n${K8S_SCRIPT.split('; ').filter((x) => !x.startsWith('echo')).join('\n')}`,
            ].join('\n\n')}
          </pre>
        </details>
      </div>
      {value && value.nodes.length > 0 && (
        <div>
          <div className="mb-1 text-[11px] text-gray-400">미리 보기 (노드별 요약 · 전체 그림은 [구성도 보기])</div>
          <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${Math.min(value.nodes.length, 4)}, minmax(0, 1fr))` }}>
            {value.nodes.map((n) => {
              const c = n.ceph
              const bits = [
                n.vip ? 'VIP' : '',
                n.pcs?.resources.some((r) => /haproxy/i.test(r)) ? 'HAProxy' : '',
                n.pcs?.dc ? 'DC' : '',
                c?.mon ? 'MON' : '',
                c?.mgr ? (c.mgrActive ? 'MGR active' : 'MGR') : '',
                c?.mds ? (c.mdsActive ? 'MDS active' : 'MDS') : '',
                c?.rgw ? 'RGW' : '',
                c?.osds.length ? `OSD ${c.osds.join('·')}` : '',
              ].filter(Boolean)
              return (
                <div key={n.host} className="min-w-0 rounded border border-white/10 bg-white/[0.02] px-2.5 py-2">
                  <div className="flex items-center gap-1.5">
                    <b className="text-[12.5px] text-gray-100">{n.label}</b>
                    {n.role && <span className={'rounded px-1.5 text-[10.5px] font-semibold text-white ' + (n.role === 'compute' ? 'bg-slate-500' : 'bg-blue-900')}>{roleText(n.role)}</span>}
                  </div>
                  <div className="truncate text-[11px] text-gray-500">
                    {n.host} · {n.mgmtIp}
                  </div>
                  <div className="mt-1 text-[11px] leading-relaxed text-gray-400">
                    {bits.join(' · ') || '-'}
                    {n.mysql === 'outside' && <span className="text-amber-300"> · mysql (Galera 구성 미포함)</span>}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {value.vms
                      .filter((v) => v.host === n.host)
                      .map((v) => (
                        <span
                          key={v.name}
                          title={`${v.ip}${v.k8s ? ` · k8s ${v.k8s}` : ''}${v.ha ? ' · evacuation 대상' : ''}`}
                          className={
                            'rounded border px-1.5 text-[10.5px] ' +
                            (v.k8s ? 'border-blue-400/30 bg-blue-500/15 text-blue-100' : 'border-white/15 bg-white/[0.06] text-gray-200') +
                            (v.ha ? ' ring-1 ring-amber-400/80' : '') +
                            (v.status !== 'ACTIVE' ? ' opacity-50' : '')
                          }
                        >
                          {v.name.replace(/^[A-Za-z0-9]+[_-]/, '')}
                        </span>
                      ))}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
      {view && value && <EnvMapViewer snap={value} title={title} fileBase={{ group: groupName, at: value.at }} onClose={() => setView(false)} />}
    </div>
  )
}
/**
 * 리포트에 실릴 환경 묶음 — 회차를 차수별 실제 환경(effEnv)으로 나누고 같은 환경끼리 합친다(2026-11-16 사용자 결정 · 목업 env-flex-mock).
 * 차수 순서대로, 차수 없는 회차는 그룹 기본 환경을 따른다. base = 그룹 기본 환경과 같은 묶음
 */
interface EnvTab {
  env?: GroupEnv
  /** 이 묶음의 차수 id ('' = 차수 없음) */
  phaseIds: string[]
  label: string
  runs: number
  base: boolean
}
function groupEnvTabs(g: VerifyGroup, recs: HistoryRecord[]): EnvTab[] {
  const order = [...g.phases.map((ph) => ph.id), '']
  const used = order.filter((id) => recs.some((h) => (g.phases.some((ph) => ph.id === h.phaseId) ? h.phaseId : '') === id))
  const tabs: EnvTab[] = []
  for (const id of used) {
    const env = effEnv(g, id || undefined)
    const n = recs.filter((h) => (g.phases.some((ph) => ph.id === h.phaseId) ? h.phaseId : '') === id).length
    const name = id ? g.phases.find((ph) => ph.id === id)?.name ?? '' : '차수 없음'
    const t = tabs.find((x) => envSame(x.env, env))
    if (t) {
      t.phaseIds.push(id)
      t.label += ` · ${name}`
      t.runs += n
    } else tabs.push({ env, phaseIds: [id], label: name, runs: n, base: envSame(env, g.env) })
  }
  return tabs
}

/**
 * 검증 환경 편집 창(2026-11-16 사용자 결정 · 목업 env-flex-mock ②) — 그룹 편집 → 회차 설정의 [환경], 리포트 창의 [편집] 이 같이 쓴다.
 * 차수 환경이면 맨 위에서 '그룹 기본 환경 따르기 / 이 차수만 따로' 를 고른다. 따로로 바꾸면 그룹 기본을 복사해 시작하고,
 * 따르기로 저장하면 그 차수 환경을 지운다. 편집기는 환경 탭과 같은 EnvEditor. 닫는 것은 X · 취소 · 저장뿐(배경 클릭으로 닫지 않음)
 */
function EnvEditDialog({
  title,
  base,
  phaseEnv,
  isPhase,
  others,
  hosts,
  novaFetch,
  envMap,
  onSave,
  onClose,
}: {
  title: string
  /** 그룹 기본 환경 */
  base: GroupEnv | undefined
  /** 차수 환경(차수일 때만) */
  phaseEnv?: GroupEnv
  isPhase: boolean
  others: { id: string; name: string; env: GroupEnv }[]
  hosts: string[]
  novaFetch?: () => Promise<{ ok: true; hosts: NovaHosts } | { ok: false; error: string }>
  envMap?: EnvMapSnapshot
  /** 차수: undefined = 그룹 기본 따르기. 그룹: 새 기본 환경. 실패 문구를 돌려주면 창을 닫지 않는다 */
  onSave: (env: GroupEnv | undefined) => string
  onClose: () => void
}) {
  const [own, setOwn] = useState(!isPhase || !!phaseEnv)
  const [val, setVal] = useState<GroupEnv | undefined>(() => {
    const v = isPhase ? phaseEnv : base
    return v ? cloneEnvKeepIds(v) : undefined
  })
  const [err, setErr] = useState('')
  const pick = (o: boolean) => {
    setOwn(o)
    if (o && !val && base) setVal(cloneEnv(base))
  }
  const changes = isPhase && own && val ? envChanges(base, val) : []
  const save = () => {
    setErr('')
    let next: GroupEnv | undefined
    if (isPhase && !own) next = undefined
    else if (val) {
      const c = cleanEnv(val)
      if (c.err) return setErr(c.err)
      next = c.env
    }
    const e = onSave(next)
    if (e) setErr(e)
  }
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 p-8">
      <div className="flex max-h-[88vh] w-[760px] max-w-[94vw] flex-col rounded-lg border border-white/10 bg-panel shadow-2xl">
        <div className="flex items-center gap-2 border-b border-white/10 px-4 py-2.5">
          <span className="text-sm font-semibold text-gray-100">{title}</span>
          <button onClick={onClose} title="닫기 (저장하지 않음)" className="ml-auto rounded p-1 text-gray-400 hover:bg-white/10 hover:text-gray-100">
            <X size={15} />
          </button>
        </div>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4 text-[12px]">
          {isPhase && (
            <div className="rounded border border-white/10 bg-white/[0.03] px-3 py-2">
              <div className="flex flex-wrap items-center gap-4 text-gray-200">
                <span className="text-[11px] text-gray-400">이 차수 환경</span>
                <label className="flex cursor-pointer items-center gap-1.5">
                  <input type="radio" checked={!own} onChange={() => pick(false)} /> 그룹 기본 환경 따르기
                </label>
                <label className="flex cursor-pointer items-center gap-1.5">
                  <input type="radio" checked={own} onChange={() => pick(true)} /> <b className="font-semibold">이 차수만 따로</b>
                </label>
              </div>
              <div className="mt-1 text-[11px] text-gray-500">따로 정하면 그룹 기본 환경을 복사해 시작합니다. 다시 "따르기" 로 저장하면 이 차수 환경은 지워집니다.</div>
            </div>
          )}
          {own ? (
            <EnvEditor value={val} onChange={setVal} others={others} hosts={hosts} novaFetch={novaFetch} envMap={envMap} />
          ) : (
            <div className="rounded border border-white/10 px-3 py-2 text-[11.5px] text-gray-400">
              {base ? `그룹 기본 환경(물리 노드 ${base.nodes.length})을 그대로 씁니다.` : '그룹 기본 환경이 아직 없습니다. 그룹 편집 → 환경 탭에서 적거나, "이 차수만 따로" 를 고르세요.'}
            </div>
          )}
          {isPhase && own && val && (
            <div className="rounded border border-amber-400/30 bg-amber-500/[0.07] px-3 py-2 text-[11.5px] text-amber-100">
              <div className="mb-0.5 font-semibold">그룹 기본 환경과 다른 점 {changes.length ? `${changes.length}곳` : '없음'}</div>
              {changes.length > 0 ? (
                <ul className="list-disc space-y-0.5 pl-4 text-amber-100/90">
                  {changes.map((c, i) => (
                    <li key={i}>{c}</li>
                  ))}
                </ul>
              ) : (
                <div className="text-amber-100/70">노드 · VM 배치가 그룹 기본과 같습니다(메모만 다르면 리포트에는 따로 실립니다).</div>
              )}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 border-t border-white/10 px-4 py-2.5">
          {err && <span className="text-[11.5px] text-red-300">{err}</span>}
          <button onClick={onClose} className="ml-auto rounded border border-white/10 px-3 py-1 text-[12px] text-gray-300 hover:bg-white/10">
            취소
          </button>
          <button onClick={save} className="rounded bg-blue-600 px-3 py-1 text-[12px] font-medium text-white hover:bg-blue-500">
            저장
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * 리포트 창의 '리포트에 실릴 검증 환경'(2026-11-16 사용자 결정 · 목업 env-flex-mock ① A). 리포트를 뽑기 전에 실릴 환경을 보고 바로 고친다.
 * 고른 회차의 차수 환경대로 묶어(groupEnvTabs) 탭으로 보이고, 그룹 기본과 다른 묶음에는 '바뀜' 을 단다. [편집] 은 그 묶음의 차수 환경
 * (그룹 기본 묶음이면 그룹 기본 환경)을 고치고 곧바로 그룹에 저장한다 — 리포트와 그룹 기록이 늘 같게(이번 리포트에만 쓰는 임시 수정은 두지 않는다)
 */
function ReportEnvPreview({
  group,
  recs,
  others,
  hosts,
  novaFetch,
  onSaveGroup,
}: {
  group: VerifyGroup
  recs: HistoryRecord[]
  others: { id: string; name: string; env: GroupEnv }[]
  hosts: string[]
  novaFetch?: () => Promise<{ ok: true; hosts: NovaHosts } | { ok: false; error: string }>
  onSaveGroup: (g: VerifyGroup) => string
}) {
  const tabs = groupEnvTabs(group, recs)
  const [sel, setSel] = useState(0)
  const [edit, setEdit] = useState<EnvTab | 'new' | null>(null)
  const t: EnvTab | undefined = tabs[Math.min(sel, tabs.length - 1)]
  const env = t?.env
  const cnt = (f: (v: EnvVm) => boolean) => (env ? env.nodes.flatMap((n) => n.vms).filter(f).reduce((a, v) => a + vmCount(v), 0) : 0)
  // 묶음이 그룹 기본이 아니면 차수 환경 편집, 그룹 기본이면 기본 환경 편집. 같은 환경을 따로 적은 차수가 여럿이면 함께 고친다
  const isGroupEdit = (x: EnvTab | 'new') => x === 'new' || x.base
  const save = (x: EnvTab | 'new', v: GroupEnv | undefined) => {
    if (x === 'new' || x.base) return onSaveGroup({ ...group, env: v })
    return onSaveGroup({ ...group, phases: group.phases.map((ph) => (x.phaseIds.includes(ph.id) ? { ...ph, env: v } : ph)) })
  }
  const changes = t && env && !t.base ? envChanges(group.env, env) : []
  /*
   * 기본 접힘(2026-11-19 사용자 요청: 노드 카드가 리포트 창을 길게 밀어 아래 선택지가 안 보였다). 접힌 머리줄에 규모 · 환경 가짓수를 남기고,
   * 환경을 적지 않았으면 접혀 있어도 노란 글씨로 알린다(리포트에서 검증 환경이 빠지는 것을 놓치지 않게)
   */
  const [open, setOpen] = useState(false)
  const empty = !tabs.length || tabs.some((x) => !x.env || !x.env.nodes.length)
  return (
    <div className="mt-1.5 overflow-hidden rounded border border-white/10">
      <button onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-2 bg-white/[0.04] px-2.5 py-1.5 text-left hover:bg-white/[0.07]">
        {open ? <ChevronDown size={13} className="shrink-0 text-gray-400" /> : <ChevronRight size={13} className="shrink-0 text-gray-400" />}
        <b className="font-semibold text-gray-100">리포트에 실릴 검증 환경</b>
        <span className="text-[11px] text-gray-400">고른 회차의 차수 환경대로 실립니다</span>
        {!open && env && env.nodes.length > 0 && (
          <span className="text-[11px] text-gray-400">
            · 물리 노드 {env.nodes.length} · k8s VM {cnt((v) => v.kind === 'k8s')} · 웹 서비스 VM {cnt((v) => v.kind === 'web')}
          </span>
        )}
        {!open && empty && <span className="text-[11px] text-amber-200">· 적지 않은 환경이 있어 리포트에서 빠집니다</span>}
        {tabs.length > 1 && <span className="ml-auto text-[11px] text-amber-200">환경 {tabs.length}가지</span>}
      </button>
      {open && tabs.length > 1 && (
        <div className="flex flex-wrap gap-1 px-2.5 pt-1.5">
          {tabs.map((x, i) => (
            <button
              key={i}
              onClick={() => setSel(i)}
              className={
                'rounded-t border border-b-0 px-2.5 py-0.5 text-[11.5px] ' +
                (i === sel ? 'border-white/20 bg-white/10 font-semibold text-gray-100' : 'border-white/10 text-gray-400 hover:bg-white/5')
              }
            >
              {x.label} <span className="text-gray-500">{x.runs}회</span>
              {!x.base && <span className="ml-1 rounded bg-orange-500/20 px-1 text-[10px] font-semibold text-orange-200">바뀜</span>}
            </button>
          ))}
        </div>
      )}
      {open && (
      <div className="bg-black/20 px-2.5 py-2">
        {t && env && env.nodes.length ? (
          <>
            <div className="mb-1.5 flex flex-wrap items-center gap-2 text-[11.5px] text-gray-300">
              <span className={'rounded px-1.5 text-[10.5px] ' + (t.base ? 'bg-blue-500/15 text-blue-200' : 'bg-amber-500/15 text-amber-200')}>
                {t.base ? '그룹 기본 환경' : '차수 환경'}
              </span>
              <span>
                물리 노드 {env.nodes.length} · k8s VM {cnt((v) => v.kind === 'k8s')} · 웹 서비스 VM {cnt((v) => v.kind === 'web')}
              </span>
              {env.inject && <span className="text-gray-500">장애 주입: {env.inject}</span>}
              <button onClick={() => setEdit(t)} className="ml-auto rounded border border-blue-500/40 bg-blue-500/15 px-2 py-0.5 text-[11px] text-blue-100 hover:bg-blue-500/25">
                편집
              </button>
            </div>
            <div className="grid grid-cols-4 gap-1.5">
              {env.nodes.map((n) => (
                <div key={n.id} className="min-w-0 rounded border border-white/10 bg-panel px-2 py-1 text-[11px]">
                  <div className="truncate">
                    <b className="text-gray-100">{n.label}</b> <span className="text-gray-500">{n.host}</span>
                  </div>
                  <div className="mt-0.5 flex flex-wrap gap-0.5">
                    {n.vms.length ? (
                      n.vms.map((v) => (
                        <span key={v.id} className={vmChipCls(v) + ' !px-1 !py-0 !text-[10.5px]'}>
                          {v.name}
                        </span>
                      ))
                    ) : (
                      <span className="text-gray-500">배치 VM 없음</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
            {env.notes.length > 0 && (
              <div className="mt-1.5 rounded bg-amber-500/10 px-2 py-1 text-[11px] text-amber-100">
                {env.notes.map((x, i) => (
                  <div key={i}>* {x}</div>
                ))}
              </div>
            )}
            {changes.length > 0 && <div className="mt-1.5 text-[11px] text-orange-200">그룹 기본과 다른 점: {changes.join(' · ')}</div>}
          </>
        ) : (
          <div className="flex items-center gap-2 text-[11.5px] text-amber-200/90">
            환경을 적지 않아 리포트에 검증 환경이 빠집니다.
            <button onClick={() => setEdit(t ?? 'new')} className="rounded border border-blue-500/40 bg-blue-500/15 px-2 py-0.5 text-[11px] text-blue-100 hover:bg-blue-500/25">
              환경 적기
            </button>
          </div>
        )}
      </div>
      )}
      {edit && (
        <EnvEditDialog
          title={isGroupEdit(edit) ? '검증 환경 편집 · 그룹 기본' : `검증 환경 편집 · ${(edit as EnvTab).label}`}
          base={group.env}
          phaseEnv={isGroupEdit(edit) ? undefined : (edit as EnvTab).env}
          isPhase={!isGroupEdit(edit)}
          others={others}
          hosts={hosts}
          novaFetch={novaFetch}
          envMap={group.envMap}
          onSave={(v) => {
            const e = save(edit, v)
            if (!e) setEdit(null)
            return e
          }}
          onClose={() => setEdit(null)}
        />
      )}
    </div>
  )
}

function GroupEditDialog({
  group,
  runCount,
  others,
  hosts,
  groupRuns,
  teams,
  novaFetch,
  envCollect,
  envMaps,
  onSave,
  onDelete,
  onClose,
}: {
  /** null = 새 그룹 */
  group: VerifyGroup | null
  /** 환경을 복사해 올 수 있는 다른 그룹 */
  others: { id: string; name: string; env: GroupEnv }[]
  /** 이 그룹 회차들이 내린 노드 이름 */
  hosts: string[]
  /** 이 그룹 회차 — 차수의 이슈에 관련 회차를 고를 때 */
  groupRuns: HistoryRecord[]
  /** 다른 차수 · 그룹에서 쓴 팀 이름(조치 팀 칸 제안) */
  teams: string[]
  novaFetch?: () => Promise<{ ok: true; hosts: NovaHosts } | { ok: false; error: string }>
  envCollect?: EnvCollect
  /** 환경 구성도 수집본이 있는 다른 그룹 — 비교 대상 */
  envMaps?: { id: string; name: string; envMap: EnvMapSnapshot }[]
  /** 차수 id → 회차 수 (지울 때 알리려고). '' = 그룹 전체 */
  runCount: Record<string, number>
  onSave: (g: VerifyGroup) => string
  onDelete?: () => string
  onClose: () => void
}) {
  const [name, setName] = useState(group?.name ?? '')
  const [phases, setPhases] = useState<GroupPhase[]>(() => group?.phases.map((ph) => ({ ...ph })) ?? [])
  const [err, setErr] = useState('')
  const [askDel, setAskDel] = useState(false)
  const [tab, setTab] = useState<'result' | 'phase' | 'env' | 'map'>('phase')
  const [result, setResult] = useState<GroupResult>(() => ({ ...(group?.result ?? {}) }))
  const [envMap, setEnvMap] = useState<EnvMapSnapshot | undefined>(group?.envMap)
  /** 이슈 · 조치를 펼친 차수 */
  const [phOpen, setPhOpen] = useState<string | null>(null)
  /** 환경 편집 창을 연 차수(EnvEditDialog) */
  const [envPh, setEnvPh] = useState<string | null>(null)
  /** 리포트와 같은 번호 — 그룹 전체를 뽑을 때의 차례(차수 순서 → 시작 시각) */
  const runNum = (id: string) => {
    const k = (h: HistoryRecord) => {
      const i = phases.findIndex((ph) => ph.id === h.phaseId)
      return i < 0 ? 1e9 : i
    }
    return [...groupRuns].sort((a, b) => k(a) - k(b) || a.t0 - b.t0).findIndex((h) => h.id === id) + 1
  }
  const [env, setEnv] = useState<GroupEnv | undefined>(() => (group?.env ? cloneEnvKeepIds(group.env) : undefined))
  /**
   * 차수는 [+ 차수 추가] 하나로 빈 줄을 더하고 이름은 사람이 적는다(2026-11-14 사용자 결정).
   * 예전의 이름 칸 + [더하기] · [+ 사전 점검] · [+ n회차] 세 버튼은 쓸모가 겹치고 이름 꼴도 버전마다 달라 뺐다.
   * 빈 이름은 저장 때 막는다(save). 새 줄의 이름 칸에 바로 커서를 둔다
   */
  const [focusPh, setFocusPh] = useState<string | null>(null)
  const addPhase = () => {
    const id = newId('ph')
    setErr('')
    setPhases((cur) => [...cur, { id, name: '', issues: [], actions: [] }])
    setFocusPh(id)
  }
  const move = (k: number, d: -1 | 1) =>
    setPhases((cur) => {
      const j = k + d
      if (j < 0 || j >= cur.length) return cur
      const next = [...cur]
      ;[next[k], next[j]] = [next[j], next[k]]
      return next
    })
  const save = () => {
    const n = name.trim()
    if (!n) return setErr('그룹 이름을 적어 주세요 (예: CONTRABASS V4.0.0 PoC #3)')
    const names = phases.map((ph) => ph.name.trim())
    if (names.some((x) => !x)) return setErr('이름이 빈 차수가 있습니다')
    if (new Set(names).size !== names.length) return setErr('같은 이름의 차수가 둘 있습니다')
    // 환경: 빈 줄 · 빈 실제 이름은 버린다(cleanEnv)
    const ce = env && cleanEnv(env)
    if (ce?.err) return setErr(`환경: ${ce.err}`)
    const envClean = ce?.env
    const e = onSave({
      id: group?.id ?? newId('g'),
      name: n,
      createdAt: group?.createdAt ?? Date.now(),
      phases: phases.map((ph) => ({ ...ph, name: ph.name.trim(), patch: ph.patch?.trim() || undefined })),
      env: envClean,
      envMap,
      // 빈 칸은 버리고, 모두 비면 필드째 없앤다
      result: (() => {
        const r = Object.fromEntries(Object.entries(result).filter(([, v]) => typeof v === 'string' && v.trim())) as GroupResult
        return Object.keys(r).length ? r : undefined
      })(),
    })
    if (e) setErr(e)
  }
  const field = 'rounded border border-white/10 bg-black/30 px-2 py-1 text-[12px] text-gray-100 placeholder:text-gray-600 focus:border-blue-500/60 focus:outline-none'
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-8">
      <div className="flex max-h-[88vh] w-[760px] max-w-[94vw] flex-col rounded-lg border border-white/10 bg-panel shadow-2xl">
        <div className="flex items-center gap-2 border-b border-white/10 px-4 py-2.5">
          <span className="text-sm font-semibold text-gray-100">{group ? '검증 그룹 편집' : '새 검증 그룹'}</span>
          <button onClick={onClose} title="닫기 (저장하지 않음)" className="ml-auto rounded p-1 text-gray-400 hover:bg-white/10 hover:text-gray-100">
            <X size={15} />
          </button>
        </div>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4 text-[12px]">
          {/* 새 그룹에서만 보이는 사용 순서(2026-11-14 사용자 요청: 그룹을 만든 뒤 지난 회차를 넣고 다음 회차를 지정하는 방법이 창에 안 보였다).
              편집 때는 이미 아는 내용이라 빼서 창을 짧게 둔다 */}
          {!group && (
            <div className="rounded border border-blue-400/30 bg-blue-500/10 px-3 py-2.5 text-[12px] leading-relaxed text-blue-50">
              <div className="mb-1 font-semibold text-blue-200">검증 그룹 쓰는 순서</div>
              <ol className="list-decimal space-y-0.5 pl-4">
                <li>그룹 이름을 적고 [+ 차수 추가] 로 차수를 만들어 이름(1회차 · 사전 점검 등)을 적은 뒤 저장합니다.</li>
                <li>
                  <b className="font-semibold">이미 진행한 회차</b>: 이력 목록에서 회차를 고르고 [그룹 · 차수 지정] 으로 넣습니다.
                </li>
                <li>
                  <b className="font-semibold">앞으로 진행할 회차</b>: 상태보드 위쪽에서 그룹 · 차수를 골라 두고 시작하면 그 차수로 저장됩니다.
                </li>
                <li>환경 탭은 리포트의 검증 환경 그림입니다. 나중에 [그룹 편집] 에서 채워도 됩니다.</li>
              </ol>
            </div>
          )}
          <label className="block">
            <span className="mb-1 block text-[11px] text-gray-400">그룹 이름 (버전 · 환경)</span>
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="예: CONTRABASS V4.0.0 PoC #3" className={field + ' w-full'} />
          </label>
          <div className="flex gap-1 border-b border-white/10">
            {(
              [
                // 검증 결과(2026-11-19 사용자 결정) — 리포트 맨 위 표라 첫 탭
                ['result', '검증 결과'],
                // 탭 이름(2026-11-14 사용자 결정): '차수 n' → '회차 설정'. 숫자는 차수 개수라 '회차' 옆에 두면 회차 수로 읽혀 뺐다
                ['phase', '회차 설정'],
                ['env', env ? `환경 · 노드 ${env.nodes.length}` : '환경'],
                // 장비에서 조회한 실제 구성 — 환경 탭(사람이 정한 기준) 옆에 따로(2026-11-14 사용자 결정)
                ['map', '환경 구성도'],
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                onClick={() => setTab(k)}
                className={'-mb-px border-b-2 px-3 py-1.5 text-[12px] ' + (tab === k ? 'border-blue-400 font-semibold text-gray-100' : 'border-transparent text-gray-400 hover:text-gray-200')}
              >
                {label}
              </button>
            ))}
          </div>
          {tab === 'result' && (
            <div className="grid grid-cols-[96px_1fr] items-start gap-x-3 gap-y-2">
              {(
                [
                  ['target', '검증 대상', 'input', name.trim(), '비우면 그룹 이름'],
                  ['period', '검증 기간', 'input', runsPeriodLine(groupRuns), '비우면 리포트에 고른 회차의 처음 ~ 끝'],
                  ['purpose', '검증 목적', 2, '', ''],
                  ['owner', '검증 담당자', 'input', '', ''],
                  ['env', '검증 환경', 'input', groupEnvLine(env), "비우면 '환경' 탭으로 만든 한 줄"],
                  ['verdict', '검증 결과', 'verdict', '', '리포트에 PASS(초록) · FAIL(빨강) 이름표로 나옵니다'],
                  // 실패 사유도 여러 줄을 보며 적게(2026-11-20 사용자 요청: 4줄은 좁았다)
                  ['failReason', '실패 사유', 7, '', 'FAIL 일 때만 리포트에 실립니다'],
                  ['summary', '주요 이슈 및 조치내역', 10, '', '자유롭게 적습니다. 줄바꿈 · 줄 앞 공백(들여쓰기)이 그대로 실립니다'],
                  // 비고도 여러 줄을 적는다(2026-11-19 사용자 요청: 3줄이라 스크롤해야 읽혔다)
                  ['note', '참고사항', 6, '', ''],
                ] as const
              )
                // 실패 사유 칸은 FAIL 을 골랐을 때만 보인다
                .filter(([k]) => k !== 'failReason' || result.verdict === 'fail')
                .map(([k, label, kind, auto, hint]) => (
                <Fragment key={k}>
                  <span className="pt-1.5 text-gray-400">{label}</span>
                  <div className="min-w-0">
                    {kind === 'verdict' ? (
                      <div className="flex items-center gap-1.5 pt-0.5">
                        {(
                          [
                            [undefined, '선택 안 함', 'border-white/15 bg-white/10 text-gray-100'],
                            // 표시는 PASS · FAIL(2026-11-19 사용자 결정, 처음엔 성공 · 실패)
                            ['ok', 'PASS', 'border-emerald-500/60 bg-emerald-500/20 text-emerald-200'],
                            ['fail', 'FAIL', 'border-red-500/60 bg-red-500/20 text-red-200'],
                          ] as const
                        ).map(([v, l, on]) => (
                          <button
                            key={l}
                            type="button"
                            onClick={() => setResult((r) => ({ ...r, verdict: v }))}
                            className={'rounded-full border px-3 py-0.5 text-[12px] ' + (result.verdict === v ? on : 'border-white/10 text-gray-400 hover:bg-white/10')}
                          >
                            {l}
                          </button>
                        ))}
                      </div>
                    ) : kind === 'input' ? (
                      <input value={(result[k] as string | undefined) ?? ''} onChange={(e) => setResult((r) => ({ ...r, [k]: e.target.value }))} placeholder={auto || ''} className={field + ' w-full'} />
                    ) : (
                      <textarea
                        rows={kind}
                        value={(result[k] as string | undefined) ?? ''}
                        onChange={(e) => setResult((r) => ({ ...r, [k]: e.target.value }))}
                        className={field + ' w-full resize-y leading-[18px]'}
                      />
                    )}
                    {hint && <div className="mt-0.5 text-[11px] text-gray-500">{hint}</div>}
                  </div>
                </Fragment>
              ))}
              <span />
              <div className="text-[11px] text-gray-500">리포트 종합 결과 맨 위 '검증 결과' 표에 실립니다. 목적 · 담당자 · 검증 결과 · 주요 이슈 및 조치내역 · 참고사항이 모두 비면 싣지 않습니다.</div>
            </div>
          )}
          {tab === 'env' && <EnvEditor value={env} onChange={setEnv} others={others} hosts={hosts} novaFetch={novaFetch} envMap={envMap} />}
          {/* 다른 탭으로 가도 내리지 않는다 — 수집 중 탭을 바꿨다 돌아와 다시 누르면 수집이 겹쳐 늦은 옛 결과가 새 결과를 덮었다(검토 지적) */}
          <div className={tab === 'map' ? '' : 'hidden'}>
            <EnvMapPanel value={envMap} onChange={setEnvMap} collect={envCollect} groupName={name.trim()} env={env} dirty={envMap !== group?.envMap} others={envMaps} />
          </div>
          {envPh &&
            (() => {
              const ph = phases.find((x) => x.id === envPh)
              if (!ph) return null
              return (
                <EnvEditDialog
                  title={`검증 환경 편집 · ${ph.name.trim() || '이름 없는 차수'}`}
                  base={env}
                  phaseEnv={ph.env}
                  isPhase
                  others={others}
                  hosts={hosts}
                  novaFetch={novaFetch}
                  envMap={envMap}
                  onSave={(v) => {
                    // 그룹 편집 창 안의 값만 바꾼다 — 저장은 그룹 [저장] 때 같이(다른 칸과 같은 규칙)
                    setPhases((cur) => cur.map((x) => (x.id === envPh ? { ...x, env: v } : x)))
                    setEnvPh(null)
                    return ''
                  }}
                  onClose={() => setEnvPh(null)}
                />
              )
            })()}
          <div className={tab === 'phase' ? '' : 'hidden'}>
            <div className="mb-1 text-[11px] text-gray-400">차수 (리포트 차수별 요약의 행 순서)</div>
            {phases.length === 0 && <div className="mb-1 text-[11.5px] text-gray-500">차수가 없습니다. [+ 차수 추가] 로 더하고 이름을 적으세요.</div>}
            <div className="space-y-1">
              {phases.map((ph, k) => (
                <div key={ph.id} className="flex flex-wrap items-center gap-1.5">
                  <input
                    autoFocus={focusPh === ph.id}
                    value={ph.name}
                    onChange={(e) => setPhases((cur) => cur.map((x, j) => (j === k ? { ...x, name: e.target.value } : x)))}
                    placeholder="예: 1회차, 사전 점검"
                    className={field + ' w-40'}
                  />
                  <span className="w-14 text-[11px] text-gray-500">{runCount[ph.id] ?? 0}회</span>
                  {/* 이 차수 전에 적용한 패치(GroupPhase.patch) — 리포트 차수별 요약의 차수 이름 아래에 나온다 */}
                  <input
                    value={ph.patch ?? ''}
                    onChange={(e) => setPhases((cur) => cur.map((x, j) => (j === k ? { ...x, patch: e.target.value } : x)))}
                    placeholder="적용한 패치 (예: SeaweedFS 패치)"
                    title="이 차수 전에 적용한 변경 · 패치. 리포트 차수별 요약의 차수 이름 아래에 나옵니다"
                    className={field + ' w-52'}
                  />
                  <button
                    onClick={() => setPhOpen(phOpen === ph.id ? null : ph.id)}
                    className={
                      'rounded border px-2 py-0.5 text-[11.5px] ' + (phOpen === ph.id ? 'border-blue-400/50 bg-blue-500/15 text-blue-100' : 'border-white/10 text-gray-300 hover:bg-white/10')
                    }
                  >
                    이슈 · 조치 {ph.issues.filter((x) => x.text.trim()).length + ph.actions.filter((x) => x.text.trim()).length || ''}
                  </button>
                  {/* 차수 환경(2026-11-16 사용자 결정 · 목업 env-flex-mock): 그룹 기본을 따르는지, 따로 정했으면 몇 곳 다른지 */}
                  {(() => {
                    const n = ph.env ? envChanges(env, ph.env).length : 0
                    return (
                      <>
                        <span
                          className={
                            'rounded px-1.5 text-[10.5px] ' + (ph.env ? 'bg-amber-500/15 text-amber-200' : 'bg-blue-500/10 text-blue-200/80')
                          }
                        >
                          {ph.env ? `따로 정한 환경${n ? ` · ${n}곳 다름` : ''}` : '그룹 기본 환경'}
                        </span>
                        <button onClick={() => setEnvPh(ph.id)} className="rounded border border-white/10 px-2 py-0.5 text-[11.5px] text-gray-300 hover:bg-white/10">
                          환경
                        </button>
                      </>
                    )
                  })()}
                  <button onClick={() => move(k, -1)} disabled={k === 0} title="위로" className="rounded px-1.5 text-gray-400 hover:bg-white/10 disabled:opacity-30">
                    ↑
                  </button>
                  <button onClick={() => move(k, 1)} disabled={k === phases.length - 1} title="아래로" className="rounded px-1.5 text-gray-400 hover:bg-white/10 disabled:opacity-30">
                    ↓
                  </button>
                  <button
                    onClick={() => setPhases((cur) => cur.filter((_x, j) => j !== k))}
                    title={runCount[ph.id] ? `이 차수의 회차 ${runCount[ph.id]}개는 '차수 없음' 으로 남습니다 (회차는 지우지 않음)` : '차수 지우기'}
                    className="ml-auto rounded p-0.5 text-gray-500 hover:bg-white/10 hover:text-gray-200"
                  >
                    <X size={13} />
                  </button>
                  {phOpen === ph.id && (
                    <div className="basis-full">
                      <PhaseNotesEditor
                        phase={ph}
                        runs={groupRuns.filter((h) => h.phaseId === ph.id).sort((a, b) => a.t0 - b.t0)}
                        numOf={runNum}
                        teams={teams}
                        onChange={(next) => setPhases((cur) => cur.map((x) => (x.id === ph.id ? next : x)))}
                      />
                    </div>
                  )}
                </div>
              ))}
            </div>
            <div className="mt-2">
              <button onClick={addPhase} className="rounded border border-white/10 px-2.5 py-1 text-gray-200 hover:bg-white/10">
                + 차수 추가
              </button>
            </div>
          </div>
          {group && onDelete && (
            <div className="border-t border-white/10 pt-3">
              {askDel ? (
                <div className="flex items-center gap-2 text-[11.5px] text-amber-200">
                  이 그룹을 지울까요? 회차 {runCount[''] ?? 0}개는 지워지지 않고 '그룹 없음' 으로 남습니다.
                  <button
                    onClick={() => {
                      const e = onDelete()
                      if (e) setErr(e)
                    }}
                    className="ml-auto rounded border border-red-500/40 bg-red-500/15 px-2 py-0.5 text-red-100 hover:bg-red-500/25"
                  >
                    지우기
                  </button>
                  <button onClick={() => setAskDel(false)} className="rounded border border-white/10 px-2 py-0.5 text-gray-300 hover:bg-white/10">
                    그만두기
                  </button>
                </div>
              ) : (
                <button onClick={() => setAskDel(true)} className="rounded border border-white/10 px-2 py-1 text-[11.5px] text-gray-400 hover:bg-white/10">
                  그룹 지우기
                </button>
              )}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 border-t border-white/10 px-4 py-2.5">
          {err && <span className="text-[11.5px] text-amber-300">{err}</span>}
          <button onClick={onClose} className="ml-auto rounded border border-white/10 px-3 py-1 text-[12px] text-gray-300 hover:bg-white/10">
            취소
          </button>
          <button onClick={save} className="rounded border border-blue-500/50 bg-blue-500/80 px-3 py-1 text-[12px] font-medium text-white hover:bg-blue-500">
            저장
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * 고른 회차를 그룹 · 차수에 넣기. 차수는 기존 차수 · 새 차수 · 회차 이름 앞부분으로 나누기('1회차 2세트' → 1회차, 없는 차수는 만든다) · 차수 없음.
 * 지난 회차를 처음 묶을 때 이름으로 나누기가 가장 빠르다(사용자 설명: 이름 앞 'n회차' 가 차수).
 */
function AssignDialog({
  recs,
  groups,
  defaultGroupId,
  onApply,
  onClose,
}: {
  recs: HistoryRecord[]
  groups: VerifyGroup[]
  defaultGroupId?: string
  onApply: (map: Record<string, { groupId?: string; phaseId?: string }>, nextGroups: VerifyGroup[]) => string
  onClose: () => void
}) {
  const [gsel, setGsel] = useState<string>(defaultGroupId && groups.some((g) => g.id === defaultGroupId) ? defaultGroupId : groups[0]?.id ?? '__new')
  const [newGroup, setNewGroup] = useState('')
  const g = groups.find((x) => x.id === gsel)
  /**
   * 기본은 '기존 차수'(2026-11-14 사용자 결정). '회차 이름으로 나누기'(이름 앞 'n회차' · '사전 점검' 을 읽어 차수를 만들던 것)는
   * 결과를 미리 알기 어려워 헷갈린다고 해서 뺐다. 고른 그룹에 차수가 없으면(새 그룹 포함) 고를 것이 없으므로 '새 차수' 로 연다
   */
  const hasPh = (id: string) => !!groups.find((x) => x.id === id)?.phases.length
  const [mode, setMode] = useState<'existing' | 'new' | 'none'>(() => (hasPh(gsel) ? 'existing' : 'new'))
  const pickGroup = (id: string) => {
    setGsel(id)
    setPhSel('')
    if (mode === 'existing' && !hasPh(id)) setMode('new')
  }
  const [phSel, setPhSel] = useState('')
  const [phNew, setPhNew] = useState('')
  const [err, setErr] = useState('')
  const apply = () => {
    if (gsel === '__out') {
      const e = onApply(Object.fromEntries(recs.map((h) => [h.id, {}])), groups)
      return e ? setErr(e) : onClose()
    }
    let grp: VerifyGroup
    let nextGroups = groups
    if (gsel === '__new') {
      const n = newGroup.trim()
      if (!n) return setErr('새 그룹 이름을 적어 주세요')
      grp = { id: newId('g'), name: n, createdAt: Date.now(), phases: [] }
      nextGroups = [...groups, grp]
    } else {
      if (!g) return setErr('그룹을 고르세요')
      grp = { ...g, phases: [...g.phases] }
      nextGroups = groups.map((x) => (x.id === g.id ? grp : x))
    }
    const findOrAdd = (name: string): string => {
      const v = name.trim()
      const hit = grp.phases.find((ph) => ph.name.trim() === v)
      if (hit) return hit.id
      const ph = { id: newId('ph'), name: v, issues: [], actions: [] }
      grp.phases.push(ph)
      return ph.id
    }
    const map: Record<string, { groupId?: string; phaseId?: string }> = {}
    let phaseId: string | undefined
    if (mode === 'existing') {
      if (!phSel) return setErr('차수를 선택하세요')
      phaseId = phSel
    } else if (mode === 'new') {
      if (!phNew.trim()) return setErr('새 차수 이름을 적어 주세요')
      phaseId = findOrAdd(phNew)
    }
    for (const h of recs) map[h.id] = { groupId: grp.id, phaseId }
    const e = onApply(map, nextGroups)
    if (e) setErr(e)
    else onClose()
  }
  const field = 'rounded border border-white/10 bg-black/30 px-2 py-1 text-[12px] text-gray-100 placeholder:text-gray-600 focus:border-blue-500/60 focus:outline-none'
  const radio = (v: typeof mode, label: ReactNode, extra?: ReactNode, disabled = false) => (
    <label className={'flex items-center gap-2 ' + (disabled ? 'opacity-40' : 'cursor-pointer')}>
      <input type="radio" disabled={disabled} checked={mode === v} onChange={() => setMode(v)} />
      <span className="w-[150px] shrink-0">{label}</span>
      {extra}
    </label>
  )
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-8">
      <div className="w-[560px] max-w-[94vw] rounded-lg border border-white/10 bg-panel shadow-2xl">
        <div className="flex items-center gap-2 border-b border-white/10 px-4 py-2.5">
          <span className="text-sm font-semibold text-gray-100">그룹 · 차수 지정</span>
          <span className="text-[11.5px] text-gray-400">고른 {recs.length}회</span>
          <button onClick={onClose} title="닫기" className="ml-auto rounded p-1 text-gray-400 hover:bg-white/10 hover:text-gray-100">
            <X size={15} />
          </button>
        </div>
        <div className="space-y-3 p-4 text-[12px] text-gray-200">
          <div className="flex items-center gap-2">
            <span className="w-12 shrink-0 text-[11px] text-gray-400">그룹</span>
            <select value={gsel} onChange={(e) => pickGroup(e.target.value)} className={field + ' min-w-0 flex-1'}>
              {groups.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
              <option value="__new">새 그룹 만들기</option>
              <option value="__out">그룹에서 빼기</option>
            </select>
          </div>
          {gsel === '__new' && (
            <div className="flex items-center gap-2">
              <span className="w-12 shrink-0" />
              <input autoFocus value={newGroup} onChange={(e) => setNewGroup(e.target.value)} placeholder="예: CONTRABASS V4.0.0 PoC #3" className={field + ' flex-1'} />
            </div>
          )}
          {gsel !== '__out' && (
            <div className="space-y-1.5">
              <div className="text-[11px] text-gray-400">차수</div>
              {radio(
                'existing',
                '기존 차수',
                <select value={phSel} onChange={(e) => setPhSel(e.target.value)} disabled={mode !== 'existing' || !g?.phases.length} className={field + ' min-w-0 flex-1'}>
                  <option value="">차수를 선택하세요</option>
                  {(g?.phases ?? []).map((ph) => (
                    <option key={ph.id} value={ph.id}>
                      {ph.name}
                    </option>
                  ))}
                </select>,
                !g?.phases.length,
              )}
              {radio('new', '새 차수', <input value={phNew} onChange={(e) => setPhNew(e.target.value)} disabled={mode !== 'new'} placeholder="예: 3회차" className={field + ' flex-1'} />)}
              {radio('none', '차수 없음')}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 border-t border-white/10 px-4 py-2.5">
          {err && <span className="text-[11.5px] text-amber-300">{err}</span>}
          <button onClick={onClose} className="ml-auto rounded border border-white/10 px-3 py-1 text-[12px] text-gray-300 hover:bg-white/10">
            취소
          </button>
          <button onClick={apply} className="rounded border border-blue-500/50 bg-blue-500/80 px-3 py-1 text-[12px] font-medium text-white hover:bg-blue-500">
            {gsel === '__out' ? '그룹에서 빼기' : '지정'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── 검증 이력 (회차별 복구 타임라인) ───────────────────────────
function HistoryView({
  list: allList,
  loading,
  groups,
  initialGroupId,
  onSaveGroups,
  onAssign,
  novaFetch,
  envCollect,
  evIndex,
  onEvidence,
  onClose,
  onClear,
  onRemove,
  onRename,
  onSetInject,
  onSetNotes,
}: {
  list: HistoryRecord[]
  /** 파일에서 이력을 읽는 중 */
  loading?: boolean
  groups: VerifyGroup[]
  initialGroupId?: string
  onSaveGroups: (next: VerifyGroup[]) => string
  onAssign: (map: Record<string, { groupId?: string; phaseId?: string }>, nextGroups?: VerifyGroup[]) => string
  novaFetch?: () => Promise<{ ok: true; hosts: NovaHosts } | { ok: false; error: string }>
  envCollect?: EnvCollect
  evIndex: Record<string, string[]>
  onEvidence: (id: string, key: string) => void
  onClose: () => void
  onClear: () => void
  onRemove: (id: string) => void
  onRename: (id: string, label: string) => void
  onSetInject: (id: string, inject: Milestones['inject'] | undefined) => void
  onSetNotes: (id: string, notes: RunNote[], override: RunOverride | undefined) => void
}) {
  /**
   * 보는 그룹(VerifyGroup 주석) — 'all' 전체 · 'none' 그룹 없음 · 그룹 id. 그룹을 고르면 회차를 차수별로 묶어 보이고, 번호(#) · 범위 고르기 ·
   * 리포트도 그 그룹 안에서 센다. 처음엔 상태보드에서 고른 '지금 그룹' 으로 연다(그 그룹에 회차가 있을 때).
   */
  const [gview, setGviewState] = useState<string>(() =>
    initialGroupId && allList.some((h) => h.groupId === initialGroupId) ? initialGroupId : 'all',
  )
  const viewGroup = groups.find((g) => g.id === gview)
  const list = useMemo(
    () => (gview === 'all' ? allList : gview === 'none' ? allList.filter((h) => !h.groupId || !groups.some((g) => g.id === h.groupId)) : allList.filter((h) => h.groupId === gview)),
    [allList, gview, groups],
  )
  /** 그룹 편집 창 — null 닫힘, 'new' 새 그룹, 그 밖 그룹 id */
  const [groupEdit, setGroupEdit] = useState<string | null>(null)
  const [assignOpen, setAssignOpen] = useState(false)
  /** 원인 · 조치 창을 연 회차 */
  const [noteFor, setNoteFor] = useState<string | null>(null)
  const noteRec = noteFor ? list.find((h) => h.id === noteFor) : undefined
  /** 리포트에 담을 회차 — 체크한 순서와 무관하게 시작 시각 순으로 담긴다 */
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [rto, setRtoState] = useState<RtoTargets>(loadRto)
  const [rtoOpen, setRtoOpen] = useState(false)
  const [rtoErr, setRtoErr] = useState('')
  /**
   * 리포트 만들기 창(10-29) — 예전엔 [리포트(HTML)] · [PDF] 두 버튼이 같은 창을 열었다. 이제 버튼은 하나이고, 창에서 무엇을(종합 · 회차별 ·
   * 증적) · 어떤 형식으로 만들지 고른다. 고른 종류는 다음에도 기억하고, 넣을 항목은 늘 보고용 묶음에서 시작한다(loadReportItems 주석). 형식은 늘 HTML 로 연다 — PDF 는 가끔 쓰는 것.
   */
  const [reportAsk, setReportAsk] = useState(false)
  /** 방금 저장한 리포트(첫 파일) — [폴더 열기] 로 탐색기에서 보인다 */
  const [savedPath, setSavedPath] = useState<string | null>(null)
  const [repFmt, setRepFmt] = useState<'html' | 'pdf'>('html')
  const [repItems, setRepItems] = useState<ReportItems>(loadReportItems)
  const [repKinds, setRepKinds] = useState<ReportKinds>(loadReportKinds)
  const [repOneFile, setRepOneFile] = useState<boolean>(loadReportOneFile)
  const [repTitle, setRepTitle] = useState<ReportTitle>(loadReportTitle)
  /** VM 이름을 실제 이름으로 — 기본 표준 이름, 기억하지 않는다(실제 이름은 내부 정보에 가까워 밖으로 나가는 리포트엔 기본으로 싣지 않는다) */
  const [repReal, setRepReal] = useState(false)
  /** 리포트에 환경 구성도를 같이(그룹에 수집본이 있을 때만 보인다 · 기본 켬) */
  const [repEnv, setRepEnv] = useState(true)
  /**
   * 포털 API 응답 조치 전 · 후 비교(LatCmpPick 주석) — 묶음마다 차수(ph, '' = 직접 고르기)와 넣은 회차. 기본은 끔(켜면 리포트 두 곳에 표가
   * 붙는다), 창을 열 때마다 차수 기본값(처음 · 마지막 차수)으로 다시 채운다. 기억하지 않는다 — 회차 고르기가 매번 다르다
   */
  const [cmpOn, setCmpOn] = useState(false)
  const [cmpSel, setCmpSel] = useState<{ pre: { ph: string; ids: string[] }; post: { ph: string; ids: string[] } }>({ pre: { ph: '', ids: [] }, post: { ph: '', ids: [] } })
  /** 이력 머리줄 [환경 구성도] 로 연 그룹 */
  const [envView, setEnvView] = useState<string | null>(null)
  const setRto = (next: RtoTargets) => {
    setRtoState(next)
    try {
      localStorage.setItem(RTO_KEY, JSON.stringify(next))
    } catch {
      /* 무시 — 설정은 이 창에서만 쓰인다 */
    }
  }
  const pickedRecs = list.filter((h) => picked.has(h.id))
  const setGview = (v: string) => {
    setGviewState(v)
    // 다른 그룹으로 바꾸면 고른 것을 비운다 — 보이지 않는 회차가 리포트에 섞이지 않게
    setPicked(new Set())
    lastPickRef.current = null
  }
  /*
   * 회차 고르기(2026-11-10 사용자 요청: 50회차 중 10~19 만 고르려면 긴 타임라인을 내리며 체크박스를 하나씩 눌러야 했다).
   *  - 한 줄 목록(기본): 회차마다 한 줄. 타임라인은 [자세히] 에서 본다. 늘 한 줄 목록으로 연다(기억하지 않는다)
   *  - 번호: 오래된 회차가 #1 — 리포트가 회차를 시작 시각 순으로 담는 것과 같은 차례다
   *  - 범위 입력 '10-19, 22' · Shift 클릭(마지막으로 누른 줄부터 이 줄까지 모두 고름)
   */
  const [histView, setHistView] = useState<'list' | 'detail'>('list')
  /*
   * 차수 접기(2026-11-17 사용자 요청: 그룹을 고르면 차수마다 회차가 길게 늘어서 아래 차수를 보려면 한참 내려야 했다). 기본은 모두 펼침,
   * 사람이 머리를 눌러야만 접힌다(화면이 저절로 움직이지 않게). 접은 상태는 이 PC 에만 남긴다(보기 편의 — 못 읽어도 모두 펼침으로 그린다)
   */
  const [folded, setFolded] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem('board_hist_fold_v1') ?? '[]') as string[])
    } catch {
      return new Set()
    }
  })
  const toggleFold = (k: string) =>
    setFolded((cur) => {
      const n = new Set(cur)
      if (n.has(k)) n.delete(k)
      else n.add(k)
      try {
        localStorage.setItem('board_hist_fold_v1', JSON.stringify([...n]))
      } catch {
        /* 기억만 못 한다 */
      }
      return n
    })
  const [rangeText, setRangeText] = useState('')
  const [rangeErr, setRangeErr] = useState('')
  const lastPickRef = useRef<string | null>(null)
  const numOf = useMemo(() => {
    const m = new Map<string, number>()
    ;[...list].sort((a, b) => a.t0 - b.t0).forEach((h, i) => m.set(h.id, i + 1))
    return m
  }, [list])
  const pick = (id: string, shift: boolean) => {
    const last = lastPickRef.current
    lastPickRef.current = id
    setPicked((cur) => {
      const next = new Set(cur)
      if (shift && last && last !== id && numOf.has(last)) {
        const a = Math.min(numOf.get(last) as number, numOf.get(id) as number)
        const b = Math.max(numOf.get(last) as number, numOf.get(id) as number)
        for (const h of list) {
          const n = numOf.get(h.id) as number
          if (n >= a && n <= b) next.add(h.id)
        }
      } else if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const pickRange = () => {
    const v = rangeText.trim()
    if (!v) return setRangeErr('범위를 넣으세요. 예: 10-19, 22')
    const want = new Set<number>()
    for (const part of v.split(',')) {
      const m = part.trim().match(/^(\d+)(?:\s*[-~]\s*(\d+))?$/)
      if (!m) return setRangeErr(`'${part.trim()}' 는 읽을 수 없습니다. 예: 10-19, 22`)
      let a = Number(m[1])
      let b = m[2] ? Number(m[2]) : a
      if (a > b) [a, b] = [b, a]
      if (a < 1 || b > list.length) return setRangeErr(`1 ~ ${list.length} 사이로 넣으세요`)
      for (let i = a; i <= b; i++) want.add(i)
    }
    setRangeErr('')
    setPicked((cur) => {
      const next = new Set(cur)
      for (const h of list) if (want.has(numOf.get(h.id) as number)) next.add(h.id)
      return next
    })
  }
  /** 회차 한 줄 요약 — 한 줄 목록 · 자세히 머리가 같은 말을 한다. 끝나지 않은 것은 리포트처럼 '실패' */
  const runSummary = (h: HistoryRecord) => {
    const t = runTotals(h)
    return (
      <span
        className="whitespace-nowrap text-gray-500"
        title={`${t.fromInject ? '장애 주입부터' : t.fromDown ? 'DOWN 감지부터' : 'DOWN 을 감지하지 못해 검증 시작부터'} · 포털 = 처음으로 모든 화면 정상 · 전체 = Masakari 완료 · 포털 정상화 중 늦은 쪽(실패 = 하나라도 끝나지 않음)`}
      >
        {/*
         * 결과를 바꾼 회차 표시(2026-11-17 사용자 요청: 나중에 어느 회차를 바꿨는지 찾기 어렵다). Masakari 만 바꾸고 포털이 실패로 남은 회차는
         * 줄이 '포털 실패 · 전체 실패' 그대로라 바꾼 흔적이 마우스를 올려야만 보였다. 바꾼 단계를 이름표로 늘 보이고, 이유는 마우스를 올리면
         */}
        {ovUsedOf(h) && (
          <span
            className="mr-1.5 rounded border border-amber-500/50 bg-amber-500/10 px-1.5 py-px text-[10.5px] text-amber-300"
            title={`성공으로 결과 변경\n${failedStepsOf(h)
              .filter((f) => ovStep(h, f.step))
              .map((f) => `${NOTE_STEP_LABEL[f.step]} (원래: ${f.text}): ${reasonOf(h, f.step)}`)
              .join('\n')}\n${restFailOf(h) ? '바꾸지 않은 실패가 남아 회차는 실패' : '남은 실패가 없어 회차는 성공'} (원인 · 조치에서 바꿈)`}
          >
            결과 변경: {failedStepsOf(h)
              .filter((f) => ovStep(h, f.step))
              .map((f) => NOTE_STEP_LABEL[f.step])
              .join(' · ')}
          </span>
        )}
        {t.svcPending.length ? (
          ovStep(h, 'portal') ? (
            <span className="text-amber-300">포털 성공 · </span>
          ) : (
            <span className="text-red-300">포털 실패 · </span>
          )
        ) : t.svc != null ? (
          `포털 ${fmtSigned(t.svc)} · `
        ) : (
          ''
        )}
        {ovUsedOf(h) && !restFailOf(h) ? (
          <span className="text-amber-300">성공</span>
        ) : manualFailOf(h) ? (
          <span className="text-red-300" title="이 조치가 없었으면 복구되지 않았음 (원인 · 조치에서 켬)">실패 (조치 후 복구)</span>
        ) : t.allFail ? (
          <span className="text-red-300">
            전체 실패
          </span>
        ) : (
          `전체 ${t.all != null ? fmtElapsed(t.all) : '-'}`
        )}
        {t.fromDown ? '' : ' *'}
      </span>
    )
  }
  const makeReport = async () => {
    if (!pickedRecs.length || busy || !(repKinds.total || repKinds.runs || repKinds.evidence || repKinds.latency)) return
    setReportAsk(false)
    saveReportKinds(repKinds)
    saveReportOneFile(repOneFile)
    try {
      localStorage.setItem(REPORT_TITLE_KEY, repTitle)
    } catch {
      /* 저장 못 해도 이번에는 쓴다 */
    }
    setBusy(true)
    setMsg('')
    setSavedPath(null)
    try {
      const envMapHtml = pickGroup?.envMap && repEnv ? renderEnvMapHtml(pickGroup.envMap, { title: `환경 구성도 · ${pickGroup.name}`, totalFile: '__QT_TOTAL_FILE__' }) : undefined
      const r = await makeRunsReport(pickedRecs, repFmt, repKinds, rto, repItems, repOneFile, pickGroup, !!pickGroup && repReal, envMapHtml, repTitle, cmpReady ? cmpPickOut() : undefined)
      setMsg(r.msg)
      setSavedPath(r.path ?? null)
    } catch (e) {
      setMsg(`만들지 못했습니다. ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }
  // 증적은 이제 '증적 원문' 종류가 정한다 — 항목 비교에서는 뺀다
  const same = (a: ReportItems, b: ReportItems) => REPORT_ITEM_LABELS.every((x) => x.key === 'evidence' || a[x.key] === b[x.key])
  /** 보고용 · 기술 검토용 — 항목과 만들 것을 같이 바꾼다(사용자 결정: 보고용 = 종합만, 기술 검토용 = 회차별 + 증적) */
  const PRESETS = [
    { label: '보고용', items: REPORT_BRIEF, kinds: { total: true, runs: false, evidence: false }, title: '종합 결과만 · 호스트·VIP · Masakari · 포털 · 장애 주입' },
    { label: '기술 검토용', items: REPORT_ALL, kinds: { total: false, runs: true, evidence: true }, title: '회차별 결과 + 증적 원문 · 모든 항목' },
  ] as const
  const sameKinds = (a: ReportKinds, b: ReportKinds) => a.total === b.total && a.runs === b.runs && a.evidence === b.evidence && !!a.latency === !!b.latency
  /** 고른 회차가 모두 한 그룹이면 그 그룹 — 리포트 앞에 검증 환경 · 시나리오 흐름 · 차수별 요약이 붙는다 */
  const pickGroup = pickedRecs.length ? groups.find((g) => pickedRecs.every((h) => h.groupId === g.id)) : undefined
  /** 조치 전 · 후 비교에 고를 수 있는 차수 — 고른 회차가 하나라도 든 차수(그룹 순서) */
  const cmpPhases = pickGroup ? pickGroup.phases.filter((ph) => pickedRecs.some((h) => h.phaseId === ph.id)) : []
  /** 묶음 목록에 보일 회차 — 차수를 골랐으면 그 차수, 직접 고르기면 고른 회차 전부 */
  const cmpCands = (ph: string) => pickedRecs.filter((h) => !ph || h.phaseId === ph).sort((a, b) => a.t0 - b.t0)
  /**
   * 회차 번호 · 포털 시간을 리포트와 같게(빌드 전 검토 11-25) — 이력 창의 #번호는 보는 목록의 번호라 리포트의 #번호(차수 순서 → 시작 시각,
   * buildHtmlReport runs)와 달랐고, 포털 시간은 장애 주입 시각 사용 여부(넣을 항목)에 따라 리포트 값과 어긋날 수 있었다
   */
  const cmpRepNo = (() => {
    const phIdx = (h: HistoryRecord) => {
      const k = pickGroup ? pickGroup.phases.findIndex((ph) => ph.id === h.phaseId) : -1
      return k < 0 ? 1e9 : k
    }
    const sorted = [...pickedRecs].sort((a, b) => (pickGroup ? phIdx(a) - phIdx(b) : 0) || a.t0 - b.t0)
    return new Map(sorted.map((h, i) => [h.id, i + 1]))
  })()
  /** 기본 — 차수가 둘 이상이면 처음 차수 = 조치 전, 마지막 차수 = 조치 후(그 차수 회차 모두). 아니면 직접 고르기로 비워 둔다 */
  const cmpDefault = () => {
    if (cmpPhases.length < 2) return { pre: { ph: '', ids: [] }, post: { ph: '', ids: [] } }
    const a = cmpPhases[0].id
    const b = cmpPhases[cmpPhases.length - 1].id
    return { pre: { ph: a, ids: cmpCands(a).map((h) => h.id) }, post: { ph: b, ids: cmpCands(b).map((h) => h.id) } }
  }
  const cmpIds = (side: 'pre' | 'post') => cmpSel[side].ids.filter((id) => pickedRecs.some((h) => h.id === id))
  const cmpShow = (repKinds.total || repKinds.latency) && pickedRecs.length >= 2
  const cmpReady = cmpOn && cmpShow && cmpIds('pre').length > 0 && cmpIds('post').length > 0
  const cmpPickOut = (): LatCmpPick => {
    const lb = (ph: string) => cmpPhases.find((x) => x.id === ph)?.name ?? ''
    return { pre: { label: lb(cmpSel.pre.ph), ids: cmpIds('pre') }, post: { label: lb(cmpSel.post.ph), ids: cmpIds('post') } }
  }
  /** 회차 하나를 넣고 빼기 — 한 회차가 두 묶음에 같이 들 수 없다(넣으면 다른 쪽에서 뺀다) */
  const cmpToggle = (side: 'pre' | 'post', id: string, on: boolean) => {
    const other = side === 'pre' ? 'post' : 'pre'
    setCmpSel((c) => ({
      ...c,
      [side]: { ...c[side], ids: on ? [...c[side].ids.filter((x) => x !== id), id] : c[side].ids.filter((x) => x !== id) },
      [other]: on ? { ...c[other], ids: c[other].ids.filter((x) => x !== id) } : c[other],
    }))
  }
  const cmpSetPh = (side: 'pre' | 'post', ph: string) => {
    const other = side === 'pre' ? 'post' : 'pre'
    setCmpSel((c) => ({ ...c, [side]: { ph, ids: ph ? cmpCands(ph).map((h) => h.id).filter((id) => !c[other].ids.includes(id)) : [] } }))
  }
  // 실제 이름 고르기 — 그룹 기본이든 차수 환경이든 실제 이름을 적어 둔 VM 이 하나라도 있으면
  const pickHasReal = !!pickGroup && [pickGroup.env, ...pickGroup.phases.map((ph) => ph.env)].some((e) => e?.nodes.some((n) => n.vms.some((v) => (v.real ?? []).some((x) => x.trim()))))
  /** 회차 결과(차수 머리의 성공 · 실패 셈) — 리포트와 같은 뜻: 끝나지 않은 것이 있거나 사람이 '조치로 복구' 를 켜면 실패 */
  const outcomeOf = (h: HistoryRecord): 'ok' | 'fail' | 'none' => {
    const t = runTotals(h)
    if (manualFailOf(h)) return 'fail'
    // 바꾼 단계가 있으면 남은 실패로만 가른다(RunOverride 주석)
    if (ovUsedOf(h)) return restFailOf(h) ? 'fail' : 'ok'
    return t.allFail ? 'fail' : t.all != null ? 'ok' : 'none'
  }
  /** 한 줄 목록의 묶음 — 그룹을 고르면 차수 순서대로(빈 차수도 머리는 보인다) + 차수 없음, 아니면 한 묶음 */
  const sections: { key: string; title: string | null; none?: boolean; recs: HistoryRecord[] }[] = viewGroup
    ? [
        ...viewGroup.phases.map((ph) => ({ key: ph.id, title: ph.name, recs: list.filter((h) => h.phaseId === ph.id) })),
        ...(() => {
          const rest = list.filter((h) => !h.phaseId || !viewGroup.phases.some((ph) => ph.id === h.phaseId))
          return rest.length ? [{ key: '__none', title: '차수 없음', none: true, recs: rest }] : []
        })(),
      ]
    : [{ key: '__all', title: null, recs: list }]
  const nEvFiles = pickedRecs.filter((h) => (evIndex[h.id] ?? []).length > 0).length
  const nParts = (repKinds.total ? 1 : 0) + (repKinds.runs ? 1 : 0) + (repKinds.evidence ? nEvFiles : 0) + (pickGroup?.envMap && repEnv ? 1 : 0) + (repKinds.latency ? 1 : 0)
  const oneFileOn = repOneFile && repFmt === 'html' && nParts > 1
  const nFiles = oneFileOn ? 1 : nParts
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-8">
      {(() => {
        const g = envView ? groups.find((x) => x.id === envView) : undefined
        if (!g?.envMap) return null
        const title = `환경 구성도 · ${g.name}`
        return <EnvMapViewer snap={g.envMap} title={title} fileBase={{ group: g.name, at: g.envMap.at }} onClose={() => setEnvView(null)} />
      })()}
      {groupEdit && (
        <GroupEditDialog
          group={groupEdit === 'new' ? null : groups.find((g) => g.id === groupEdit) ?? null}
          others={groups.filter((g) => g.id !== groupEdit && g.env && g.env.nodes.length).map((g) => ({ id: g.id, name: g.name, env: g.env as GroupEnv }))}
          hosts={[...new Set(allList.filter((h) => h.groupId === groupEdit && h.node && !h.node.startsWith('(')).map((h) => h.node))].sort()}
          groupRuns={allList.filter((h) => h.groupId === groupEdit)}
          teams={[...new Set(groups.flatMap((g) => g.phases.flatMap((ph) => ph.actions.map((a) => a.team.trim()))).filter(Boolean))]}
          novaFetch={novaFetch}
          envCollect={envCollect}
          envMaps={groups.filter((g) => g.id !== groupEdit && g.envMap).map((g) => ({ id: g.id, name: g.name, envMap: g.envMap as EnvMapSnapshot }))}
          runCount={(() => {
            const c: Record<string, number> = { '': 0 }
            for (const h of allList)
              if (h.groupId === groupEdit) {
                c['']++
                if (h.phaseId) c[h.phaseId] = (c[h.phaseId] ?? 0) + 1
              }
            return c
          })()}
          onSave={(g) => {
            const next = groups.some((x) => x.id === g.id) ? groups.map((x) => (x.id === g.id ? g : x)) : [...groups, g]
            const e = onSaveGroups(next)
            if (!e) {
              if (groupEdit === 'new') setGview(g.id)
              setGroupEdit(null)
            }
            return e
          }}
          onDelete={
            groupEdit === 'new'
              ? undefined
              : () => {
                  const e = onSaveGroups(groups.filter((x) => x.id !== groupEdit))
                  if (!e) {
                    setGview('all')
                    setGroupEdit(null)
                  }
                  return e
                }
          }
          onClose={() => setGroupEdit(null)}
        />
      )}
      {assignOpen && (
        <AssignDialog
          recs={pickedRecs}
          groups={groups}
          defaultGroupId={viewGroup?.id ?? initialGroupId}
          onApply={(map, next) => {
            const e = onAssign(map, next)
            if (!e) {
              setPicked(new Set())
              lastPickRef.current = null
            }
            return e
          }}
          onClose={() => setAssignOpen(false)}
        />
      )}
      {noteRec && (
        <RunNotesDialog
          h={noteRec}
          num={numOf.get(noteRec.id) ?? 0}
          onClose={() => setNoteFor(null)}
          onSave={(notes, override) => {
            onSetNotes(noteRec.id, notes, override)
            setNoteFor(null)
          }}
        />
      )}
      {reportAsk && (
        /**
         * 리포트 항목 선택 — 보고받는 쪽은 파드·Ceph 를 보지 않는다(사용자 요청). 여러 회차를 골라도 같은 선택을 모든 회차에 쓴다.
         * 전체 복구 = Masakari 완료 · 포털 1차 정상화 중 늦은 쪽(10-30, Ceph 와 무관). 닫기는 버튼으로만(모달 규칙).
         */
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-8">
          <div className={'max-h-[90vh] max-w-[94vw] overflow-y-auto rounded-lg border border-white/10 bg-panel p-4 shadow-2xl ' + (pickGroup ? 'w-[680px]' : 'w-[520px]')}>
            <div className="mb-2 flex items-center gap-2">
              <span className="text-sm font-semibold text-gray-100">리포트 만들기</span>
              <span className="text-[11px] text-gray-500">고른 {pickedRecs.length}회차</span>
              <span className="ml-auto flex gap-1.5">
                {PRESETS.map((p) => (
                  <button
                    key={p.label}
                    onClick={() => {
                      setRepItems({ ...p.items })
                      setRepKinds({ ...p.kinds })
                    }}
                    title={p.title}
                    className={
                      'rounded border px-2 py-0.5 text-[11px] ' +
                      (same(repItems, p.items) && sameKinds(repKinds, p.kinds) ? 'border-blue-500/40 bg-blue-500/15 text-blue-100' : 'border-white/10 text-gray-300 hover:bg-white/10')
                    }
                  >
                    {p.label}
                  </button>
                ))}
              </span>
            </div>
            <div className="mb-1 text-[11px] text-gray-400">무엇을 만들까요 (여러 개 고를 수 있음)</div>
            <div className="mb-3 space-y-1 rounded bg-white/[0.03] px-2.5 py-2">
              {(
                [
                  ['total', '종합 결과', '주요 수치 · 전체 회차 비교 · 실패 세부 원인 · 포털 API 응답 지연 · 노드별 결과'],
                  ['runs', '회차별 결과', '회차마다 핵심 시간 · 요약 타임라인 · 파드 로그 이상 (증적 없음)'],
                  ['evidence', '증적 원문', `서버 원문, 회차마다 한 파일 (증적 있는 회차 ${nEvFiles}개)`],
                  ['latency', '포털 API 응답', '회차마다 화면 · API 별 노드 UP · DOWN 응답 시간 (이것만 고르면 이 내용만 한 파일)'],
                ] as const
              ).map(([k, label, desc]) => (
                <label key={k} className="flex cursor-pointer items-baseline gap-2 text-[12px] text-gray-200">
                  <input type="checkbox" checked={!!repKinds[k]} onChange={(e) => setRepKinds({ ...repKinds, [k]: e.target.checked })} className="translate-y-[1px]" />
                  <span className="w-[84px] shrink-0 whitespace-nowrap font-medium">{label}</span>
                  <span className="text-[11px] text-gray-500">{desc}</span>
                </label>
              ))}
            </div>
            {cmpShow && (
              /* 포털 API 응답 조치 전 · 후 비교(2026-11-25 목업 A) — 차수로 채우고 회차를 직접 넣고 뺀다. 회차 옆은 포털 1차 정상화까지 걸린 시간(오래 걸린 회차 찾기용) */
              <div className={'mb-3 rounded px-2.5 py-2 ' + (cmpOn ? 'bg-white/[0.04]' : 'bg-white/[0.02]')}>
                <label className="flex cursor-pointer items-baseline gap-2 text-[12px] text-gray-200">
                  <input type="checkbox" checked={cmpOn} onChange={(e) => setCmpOn(e.target.checked)} className="translate-y-[1px]" />
                  <span className="shrink-0 font-medium">포털 API 응답 조치 전 · 후 비교</span>
                  <span className="text-[11px] text-gray-500">조치가 있을 때만. 종합 결과의 응답 지연 자리에 · 포털 API 응답 맨 위 (노드 DOWN 구간)</span>
                </label>
                {cmpOn && (
                  <>
                    <div className="mt-2 grid grid-cols-2 gap-2">
                      {(['pre', 'post'] as const).map((side) => {
                        const sel = cmpSel[side]
                        const ids = cmpIds(side)
                        return (
                          <div
                            key={side}
                            className={'rounded border px-2 py-1.5 ' + (side === 'pre' ? 'border-amber-500/30 bg-amber-500/[0.06]' : 'border-emerald-500/30 bg-emerald-500/[0.06]')}
                          >
                            <div className="mb-1 flex items-center gap-2 text-[12px] font-medium text-gray-100">
                              조치 {side === 'pre' ? '전' : '후'}
                              <select
                                value={sel.ph}
                                onChange={(e) => cmpSetPh(side, e.target.value)}
                                className="min-w-0 flex-1 rounded border border-white/10 bg-panel-light px-1.5 py-0.5 text-[11px] text-gray-200"
                              >
                                {cmpPhases.map((ph) => (
                                  <option key={ph.id} value={ph.id}>
                                    {ph.name}
                                  </option>
                                ))}
                                <option value="">직접 고르기 (고른 회차 전부)</option>
                              </select>
                              <span className="shrink-0 text-[11px] text-gray-400">{ids.length}회차</span>
                            </div>
                            <div className="max-h-[150px] space-y-0.5 overflow-y-auto pr-1">
                              {cmpCands(sel.ph).map((h) => {
                                const svc = runTotals(h, repItems.inject).svc
                                return (
                                  <label key={h.id} className={'flex cursor-pointer items-center gap-1.5 text-[11.5px] ' + (ids.includes(h.id) ? 'text-gray-200' : 'text-gray-500')}>
                                    <input type="checkbox" checked={ids.includes(h.id)} onChange={(e) => cmpToggle(side, h.id, e.target.checked)} />
                                    <span className="min-w-0 flex-1 truncate">
                                      #{cmpRepNo.get(h.id)} {h.label || h.node}
                                    </span>
                                    <span className="shrink-0 text-[10.5px] text-gray-500">포털 {svc == null ? '-' : fmtDuration(svc)}</span>
                                  </label>
                                )
                              })}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                    <div className="mt-1.5 text-[11px] leading-relaxed text-gray-500">
                      차수를 고르면 그 차수의 회차가 모두 들어갑니다. 빼고 싶은 회차는 체크를 푸세요. 회차 옆 시간은 포털 정상화까지 걸린 시간입니다.
                    </div>
                    {!cmpReady && <div className="mt-1 text-[11px] text-amber-300/90">조치 전 · 후에 회차를 하나 이상씩 넣어야 비교 표가 붙습니다.</div>}
                  </>
                )}
              </div>
            )}
            {/* 보고 제목(REPORT_TITLE 주석) — 종합 결과에만 붙어, 종합 결과를 고르지 않았으면 흐리게 */}
            <div className={'mb-3 flex items-center gap-3 text-[12px] text-gray-200 ' + (repKinds.total ? '' : 'opacity-40')}>
              <span className="w-[26px] shrink-0 text-[11px] text-gray-400">보고</span>
              {(['final', 'mid'] as const).map((v) => (
                <label key={v} className="flex shrink-0 cursor-pointer items-center gap-1 whitespace-nowrap">
                  <input type="radio" checked={repTitle === v} disabled={!repKinds.total} onChange={() => setRepTitle(v)} />
                  {v === 'final' ? '종합 결과 보고' : '중간 결과 보고'}
                </label>
              ))}
              <span className="min-w-0 flex-1 text-[11px] text-gray-500">종합 결과 제목 · 파일 이름에 붙습니다(내용은 같음)</span>
            </div>
            <div className="mb-3 flex items-center gap-3 text-[12px] text-gray-200">
              <span className="w-[26px] shrink-0 text-[11px] text-gray-400">형식</span>
              {(['html', 'pdf'] as const).map((f) => (
                <label key={f} className="flex w-[58px] shrink-0 cursor-pointer items-center gap-1 whitespace-nowrap">
                  <input type="radio" checked={repFmt === f} onChange={() => setRepFmt(f)} />
                  {f === 'html' ? 'HTML' : 'PDF'}
                </label>
              ))}
              <span className="min-w-0 flex-1 text-[11px] text-gray-500">
                {repFmt === 'pdf' ? '접힌 내용까지 펼쳐 인쇄, 파일 사이 링크 없음' : '브라우저로 열고 인쇄할 수 있습니다'}
              </span>
            </div>
            {repFmt === 'html' && (
              <div className="-mt-1.5 mb-3 flex items-center gap-3 text-[12px] text-gray-200">
                <span className="w-[26px] shrink-0 text-[11px] text-gray-400">파일</span>
                {(
                  [
                    [true, '통합'],
                    [false, '분할'],
                  ] as const
                ).map(([v, label]) => (
                  <label key={label} className="flex w-[58px] shrink-0 cursor-pointer items-center gap-1 whitespace-nowrap">
                    <input type="radio" checked={repOneFile === v} onChange={() => setRepOneFile(v)} />
                    {label}
                  </label>
                ))}
                <span className="min-w-0 flex-1 text-[11px] text-gray-500">{repOneFile ? '한 파일에 모두, 링크를 누르면 그 화면으로 이동' : '종류마다 따로, 증적은 회차마다 한 파일'}</span>
              </div>
            )}
            {pickGroup ? (
              <div className="mb-3 rounded bg-blue-500/[0.08] px-2.5 py-1.5 text-[11.5px] leading-relaxed text-blue-100/90">
                <div>
                  검증 그룹 <b>{pickGroup.name}</b>: 종합 결과 앞에 검증 환경 · 시나리오 흐름 · 차수별 요약이 붙습니다.
                </div>
                <ReportEnvPreview
                  group={pickGroup}
                  recs={pickedRecs}
                  others={groups.filter((g) => g.id !== pickGroup.id && g.env && g.env.nodes.length).map((g) => ({ id: g.id, name: g.name, env: g.env as GroupEnv }))}
                  hosts={[...new Set(allList.filter((h) => h.groupId === pickGroup.id && h.node && !h.node.startsWith('(')).map((h) => h.node))].sort()}
                  novaFetch={novaFetch}
                  onSaveGroup={(g) => onSaveGroups(groups.map((x) => (x.id === g.id ? g : x)))}
                />
                {pickGroup.envMap && (
                  // 한 줄로(2026-11-19 사용자 요청: '환경 구성도 함께' 가 두 줄로 꺾였다). 설명은 줄이고, 넘치면 말줄임 · 전문은 툴팁
                  <label
                    className="mt-1 flex min-w-0 cursor-pointer items-center gap-1.5 whitespace-nowrap text-gray-200"
                    title="검증 환경에서 링크 · VM 이름 선택과 상관없이 실제 호스트 · VM 이름과 IP 가 실립니다"
                  >
                    <input type="checkbox" checked={repEnv} onChange={(e) => setRepEnv(e.target.checked)} className="shrink-0 accent-blue-500" />
                    <span className="shrink-0">환경 구성도 함께</span>
                    <span className="min-w-0 truncate text-[11px] text-gray-400">({fmtDateTime(pickGroup.envMap.at)} 수집본 · 실제 호스트 · VM 이름 · IP 로 실림)</span>
                  </label>
                )}
                {pickHasReal && (
                  <div className="mt-1 flex items-center gap-3 text-gray-200">
                    <span className="text-[11px] text-gray-400">VM 이름</span>
                    <label className="flex cursor-pointer items-center gap-1">
                      <input type="radio" checked={!repReal} onChange={() => setRepReal(false)} /> 표준 이름
                    </label>
                    <label className="flex cursor-pointer items-center gap-1">
                      <input type="radio" checked={repReal} onChange={() => setRepReal(true)} /> 실제 이름
                    </label>
                  </div>
                )}
              </div>
            ) : (
              pickedRecs.some((h) => h.groupId) && (
                <div className="mb-3 text-[11px] text-gray-500">고른 회차가 여러 그룹에 걸쳐 있어 검증 환경 · 차수별 요약은 싣지 않습니다. 한 그룹만 고르면 붙습니다.</div>
              )
            )}
            <div className="mb-1 text-[11px] text-gray-400">넣을 항목</div>
            <div className="space-y-1">
              {REPORT_ITEM_LABELS.filter((x) => x.key !== 'evidence').map((x) => (
                <label key={x.key} className="flex cursor-pointer items-center gap-2 text-[12px] text-gray-200">
                  <input type="checkbox" checked={repItems[x.key]} onChange={(e) => setRepItems({ ...repItems, [x.key]: e.target.checked })} />
                  {x.label}
                </label>
              ))}
            </div>
            <div className="mt-3 rounded bg-white/[0.04] px-2.5 py-1.5 text-[11px] leading-relaxed text-gray-400">
              {repItems.masakari || repItems.portal
                ? `전체 복구 = 장애 시작(장애 주입, 없으면 DOWN 감지)부터 ${[repItems.masakari && 'Masakari 완료', repItems.portal && '포털 1차 정상화(처음 모두 정상)'].filter(Boolean).join('와 ')} 중 마지막으로 완료된 시각까지: 하나라도 끝나지 않은 회차는 실패입니다.${repItems.ceph || repItems.pods ? ' 파드 · Ceph 는 단계별로만 들어갑니다.' : ''}`
                : '전체 복구 칸이 없습니다. Masakari, 포털 중 하나는 넣어야 전체 복구를 잽니다.'}
              {pickedRecs.length > 1 && ` 고른 ${pickedRecs.length}회차 모두에 같은 항목을 씁니다.`} 뺀 항목은 표 · 카드 · 타임라인 · 증적 원문에서 모두 빠집니다.
            </div>
            {/* DOWN 을 못 잡은 회차(시험 삼아 켰다 끈 회차 등)는 기준이 달라 평균에서 빠진다 — 전체 선택으로 섞여 들어가기 쉬워
                고르기 전에 알린다(13회차 리포트 검토). 빼라고 막지는 않는다: 그 회차도 기록으로 낼 수 있다 */}
            {(() => {
              const noDown = pickedRecs.filter((h) => !runTotals(h).fromDown)
              return noDown.length > 0 && pickedRecs.length > 1 ? (
                <div className="mt-2 rounded border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-[11px] leading-relaxed text-amber-200">
                  DOWN 을 감지하지 못한 회차 {noDown.length}개가 들어 있습니다({noDown.map((h) => h.label || fmtDateTime(h.t0)).slice(0, 4).join(', ')}
                  {noDown.length > 4 ? ` 외 ${noDown.length - 4}개` : ''}). 시험 회차라면 빼고 뽑는 것이 낫습니다. 넣으면 표에 * 로 표시되고 평균에서는 빠집니다.
                </div>
              ) : null
            })()}
            {repKinds.evidence && nEvFiles < pickedRecs.length && (
              <div className="mt-2 text-[11px] text-gray-500">증적이 없는 회차 {pickedRecs.length - nEvFiles}개는 증적 원문 파일을 만들지 않습니다.</div>
            )}
            {(() => {
              // 실패 회차인데 원인 · 조치를 하나도 적지 않은 것 — 빠뜨린 채 제출하지 않게 알리기만 한다(만들기는 막지 않는다)
              // 성공으로 바꿔 남은 실패가 없는 회차는 리포트에서 실패가 아니라 빼고 센다(RunOverride 주석)
              const miss = pickedRecs.filter((h) => restFailOf(h) && !(h.notes ?? []).some((n) => n.cause.trim()))
              return repKinds.total && miss.length > 0 ? (
                <div className="mt-2 text-[11px] text-amber-300/90">
                  실패 회차 중 원인 · 조치를 적지 않은 회차 {miss.length}개: {miss.map((h) => `#${numOf.get(h.id)}`).join(' ')} (실패 원인 표의 오른쪽 칸이 비어 나옵니다. 창을 닫고 회차의 [원인 · 조치] 에서 적을 수 있습니다)
                </div>
              ) : null
            })()}
            <div className="mt-3 flex items-center justify-end gap-2">
              <span className="mr-auto text-[11px] text-gray-500">
                {nFiles === 0
                  ? '만들 것을 하나 이상 고르세요'
                  : oneFileOn
                    ? `파일 1개(화면 ${nParts}개): 저장할 이름을 고릅니다`
                    : nFiles === 1
                      ? '파일 1개: 저장할 이름을 고릅니다'
                      : `파일 ${nFiles}개: 저장 창에서 위치를 한 번 고르면 같은 폴더에 모두 저장합니다`}
              </span>
              <button onClick={() => setReportAsk(false)} className="rounded border border-white/10 px-3 py-1 text-[12px] text-gray-300 hover:bg-white/10">
                취소
              </button>
              <button
                onClick={() => void makeReport()}
                disabled={nFiles === 0}
                className="rounded border border-blue-500/40 bg-blue-500/15 px-3 py-1 text-[12px] text-blue-100 hover:bg-blue-500/25 disabled:opacity-40"
              >
                만들기
              </button>
            </div>
          </div>
        </div>
      )}
      <div
        className="flex h-[78vh] w-[1000px] max-w-[94vw] flex-col overflow-hidden rounded-lg border border-white/10 bg-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-white/10 px-4 py-2.5">
          <Activity size={16} className="text-blue-400" />
          <span className="shrink-0 whitespace-nowrap text-sm font-semibold text-gray-100">검증 이력</span>
          <span
            className="shrink-0 whitespace-nowrap text-[11px] text-gray-500"
            title={`그룹에 든 회차는 자동으로 지우지 않습니다. 그룹 밖 회차는 최근 ${HIST_MAX}회까지 보관합니다`}
          >
            {list.length}회
          </span>
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
                onClick={() => {
                  // 열 때마다 보고용 묶음에서 시작(loadReportItems 주석) — 같은 창에서 기술 검토용을 뽑은 뒤 다시 열어도 마찬가지
                  setRepItems(loadReportItems())
                  setRepReal(false)
                  setCmpSel(cmpDefault())
                  setReportAsk(true)
                }}
                disabled={!pickedRecs.length || busy}
                title="고른 회차로 종합 결과 · 회차별 결과 · 증적 원문을 HTML 또는 PDF 로 만듭니다"
                className="ml-auto inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md border border-blue-500/40 bg-blue-500/15 px-2 py-1 text-xs text-blue-100 hover:bg-blue-500/25 disabled:opacity-40"
              >
                {busy ? <Loader2 size={12} className="animate-spin" /> : <FileText size={12} />} 리포트 만들기
              </button>
              {/* 버튼이 곧 On/Off 다. 예전에는 이 버튼이 설정 칸만 펼치고 켜고 끄는 것은 안쪽 체크박스였는데,
                  눌러도 글자가 'Off' 그대로라 고장 난 것처럼 보였다. 켜면 목표 시간 칸을 함께 펼친다 */}
              <button
                onClick={() => {
                  const on = !rto.enabled
                  setRto({ ...rto, enabled: on })
                  setRtoOpen(on)
                }}
                title={rto.enabled ? '눌러서 끄기: 평균·최대만 봅니다' : '눌러서 켜기: 목표 복구 시간으로 회차별 합격·불합격을 판정합니다'}
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
        {(allList.length > 0 || groups.length > 0) && (
          <div className="flex flex-wrap items-center gap-2 border-b border-white/10 px-4 py-1.5 text-[11.5px]">
            <span className="text-gray-400">검증 그룹</span>
            <select
              value={gview}
              onChange={(e) => setGview(e.target.value)}
              className="max-w-[300px] rounded border border-white/10 bg-panel-light px-1.5 py-0.5 text-gray-100"
            >
              <option value="all">전체 ({allList.length}회)</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name} ({allList.filter((h) => h.groupId === g.id).length}회)
                </option>
              ))}
              <option value="none">그룹 없음 ({allList.filter((h) => !h.groupId || !groups.some((g) => g.id === h.groupId)).length}회)</option>
            </select>
            {viewGroup?.envMap && (
              <button
                onClick={() => setEnvView(viewGroup.id)}
                title={`이 그룹의 환경 구성도(${fmtDateTime(viewGroup.envMap.at)} 수집). 다시 수집은 그룹 편집 → 환경 구성도`}
                className="rounded border border-white/10 px-2 py-0.5 text-gray-200 hover:bg-white/10"
              >
                환경 구성도
              </button>
            )}
            {viewGroup && (
              <button onClick={() => setGroupEdit(viewGroup.id)} className="rounded border border-white/10 px-2 py-0.5 text-gray-200 hover:bg-white/10">
                그룹 편집
              </button>
            )}
            <button onClick={() => setGroupEdit('new')} className="inline-flex items-center gap-1 rounded border border-white/10 px-2 py-0.5 text-gray-200 hover:bg-white/10">
              <Plus size={12} /> 새 그룹
            </button>
            <button
              onClick={() => setAssignOpen(true)}
              disabled={!pickedRecs.length}
              title="고른 회차를 검증 그룹 · 차수에 넣거나 뺍니다"
              className="rounded border border-white/10 px-2 py-0.5 text-gray-200 hover:bg-white/10 disabled:opacity-40"
            >
              그룹 · 차수 지정{pickedRecs.length ? ` (${pickedRecs.length})` : ''}
            </button>
            <span className="text-gray-500">{groups.length ? '그룹을 고르면 차수별로 묶어 보입니다' : '버전 · 환경마다 그룹을 만들어 회차를 묶을 수 있습니다'}</span>
          </div>
        )}
        {rtoOpen && rto.enabled && (
          <div className="border-b border-white/10 bg-white/[0.02] px-4 py-2.5 text-[12px] text-gray-300">
            <div className="mb-2 flex items-center gap-2">
              <span>
                목표 복구 시간으로 <b>합격·불합격</b> 판정 중 <span className="text-gray-500"> 끄려면 위의 [목표 기준 On] 을 누르세요</span>
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
                        setRtoErr(`${it.label}: '${e.target.value}' 는 읽을 수 없어 직전 값으로 되돌렸습니다. 1:30 · 1분 30초 · 90 처럼 넣으세요`)
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
              장애 시작(장애 주입, 없으면 DOWN 감지)부터의 시간입니다.{' '}
              <span className="text-amber-300/90">
                10-30 에 기준이 바뀌었습니다: 포털 = 처음으로 모든 화면 정상(1차), 전체 복구 = Masakari 완료 · 포털 1차 중 늦은 쪽(예전엔 Ceph HEALTH_OK). 예전에 넣어 둔 값이 있으면 다시 확인하세요.
              </span>{' '}
              <b className="text-gray-300">1:30 · 1분 30초 · 5분 · 30초 · 90</b>(숫자만 쓰면 초) 모두 되고, 칸을 벗어나면 분:초로 정리됩니다. 비워 둔 항목은 판정하지 않습니다. 리포트(HTML·PDF)에 회차별 합격·불합격과 합격 수가 들어갑니다.
            </p>
            {rtoErr && <p className="mt-1 text-[11px] text-amber-300">{rtoErr}</p>}
          </div>
        )}
        {msg && (
          <div className="flex items-center gap-2 border-b border-white/10 px-4 py-1.5 text-[11.5px] text-gray-300">
            <span className="min-w-0 flex-1 break-all">{msg}</span>
            {savedPath && (
              <button
                onClick={() => void window.electronAPI.revealReport(savedPath)}
                className="shrink-0 rounded border border-white/10 px-2 py-0.5 text-[11px] text-gray-200 hover:bg-white/10"
              >
                폴더 열기
              </button>
            )}
          </div>
        )}
        {list.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-b border-white/10 px-4 py-1.5 text-[11.5px]">
            <span className="inline-flex overflow-hidden rounded-md border border-white/10">
              {(['list', 'detail'] as const).map((v) => (
                <button
                  key={v}
                  onClick={() => setHistView(v)}
                  className={'px-2 py-0.5 ' + (histView === v ? 'bg-blue-500/25 text-blue-100' : 'text-gray-400 hover:bg-white/10')}
                >
                  {v === 'list' ? '한 줄 목록' : '자세히'}
                </button>
              ))}
            </span>
            {/* 문구(2026-11-14 사용자 요청): '범위로 고르기 · 고르기' → '범위로 회차 선택 · 선택'. 버튼은 회차를 고르기만 하므로 '조회' 대신 '선택' 으로 옆 [선택 해제] 와 짝을 맞춘다 */}
            <span className="ml-2 text-gray-400">범위로 회차 선택</span>
            <input
              value={rangeText}
              onChange={(e) => {
                setRangeText(e.target.value)
                setRangeErr('')
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') pickRange()
              }}
              placeholder="예: 10-19, 22"
              title="목록의 #번호로 선택합니다(오래된 회차가 #1). 이미 선택한 회차에 더합니다"
              className="w-32 rounded border border-white/10 bg-panel-light px-1.5 py-0.5 text-gray-100 placeholder:text-gray-600"
            />
            <button onClick={pickRange} className="rounded border border-white/10 px-2 py-0.5 text-gray-200 hover:bg-white/10">
              선택
            </button>
            <button
              onClick={() => {
                setPicked(new Set())
                lastPickRef.current = null
              }}
              disabled={!pickedRecs.length}
              className="rounded border border-white/10 px-2 py-0.5 text-gray-200 hover:bg-white/10 disabled:opacity-40"
            >
              선택 해제
            </button>
            {rangeErr ? <span className="text-amber-300">{rangeErr}</span> : <span className="text-gray-500">Shift 를 누른 채 누르면 사이가 모두 골라집니다</span>}
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {list.length === 0 && allList.length > 0 ? (
            <div className="text-[12px] leading-relaxed text-gray-500">
              {gview === 'none' ? '그룹에 들지 않은 회차가 없습니다.' : '이 그룹에 든 회차가 없습니다. 위에서 [전체] 로 바꿔 회차를 고른 뒤 [그룹 · 차수 지정] 으로 넣으세요.'}
            </div>
          ) : list.length === 0 && loading ? (
            <div className="flex items-center gap-2 text-[12px] text-gray-500">
              <Loader2 size={13} className="animate-spin" /> 검증 이력을 불러오는 중입니다.
            </div>
          ) : list.length === 0 ? (
            <div className="text-[12px] leading-relaxed text-gray-500">
              아직 저장된 이력이 없습니다.
              <br />
              Ceph 의 degraded · misplaced 가 모두 0 이 되면 그 회차가 자동으로 저장됩니다. (검증을 중지해도 저장됩니다)
            </div>
          ) : histView === 'list' ? (
            <div className="space-y-2">
              {sections.map((sec) => {
                const fk = `${viewGroup?.id ?? ''}|${sec.key}`
                const shut = sec.title != null && folded.has(fk)
                // 접힌 차수 안에서 고른 회차 — 안 보이는 채 리포트에 담기지 않게 머리에 수를 밝힌다(Shift 범위 선택이 접힌 차수를 지나갈 수 있다)
                const nPick = sec.recs.filter((h) => picked.has(h.id)).length
                return (
                <div key={sec.key} className="overflow-hidden rounded-lg border border-white/10 text-[12px]">
                  {sec.title != null && (
                    <div
                      onClick={() => toggleFold(fk)}
                      title={shut ? '펼치기' : '접기'}
                      className={'flex cursor-pointer select-none items-center gap-2.5 bg-white/[0.05] px-3 py-1.5 hover:bg-white/[0.08] ' + (shut ? '' : 'border-b border-white/10')}
                    >
                      {shut ? <ChevronRight size={14} className="-mr-1 shrink-0 text-gray-400" /> : <ChevronDown size={14} className="-mr-1 shrink-0 text-gray-400" />}
                      <input
                        onClick={(e) => e.stopPropagation()}
                        type="checkbox"
                        checked={sec.recs.length > 0 && sec.recs.every((h) => picked.has(h.id))}
                        disabled={!sec.recs.length}
                        onChange={(e) =>
                          setPicked((cur) => {
                            const n = new Set(cur)
                            for (const h of sec.recs) {
                              if (e.target.checked) n.add(h.id)
                              else n.delete(h.id)
                            }
                            return n
                          })
                        }
                        aria-label="이 차수 회차 모두 고르기"
                        title="이 차수 회차 모두 고르기"
                      />
                      <span className={'font-semibold ' + (sec.none ? 'text-gray-400' : 'text-gray-100')}>{sec.title}</span>
                      <span className="text-[11px] text-gray-500">
                        {sec.recs.length}회
                        {sec.recs.length > 0 && (
                          <>
                            {' · '}
                            <span className="text-emerald-300/90">성공 {sec.recs.filter((h) => outcomeOf(h) === 'ok').length}</span>
                            {' · '}
                            <span className="text-red-300/90">실패 {sec.recs.filter((h) => outcomeOf(h) === 'fail').length}</span>
                          </>
                        )}
                      </span>
                      {shut && nPick > 0 && <span className="text-[11px] text-blue-300">· 고른 회차 {nPick}</span>}
                    </div>
                  )}
                  {!shut && sec.recs.map((h) => (
                <div
                  key={h.id}
                  onClick={(e) => pick(h.id, e.shiftKey)}
                  onMouseDown={(e) => {
                    // Shift 클릭이 글자를 드래그 선택하지 않게
                    if (e.shiftKey) e.preventDefault()
                  }}
                  className={
                    'flex cursor-pointer select-none items-center gap-2.5 border-b border-white/5 px-3 py-1.5 last:border-b-0 ' +
                    (picked.has(h.id) ? 'bg-blue-500/15' : 'hover:bg-white/5')
                  }
                >
                  <input type="checkbox" readOnly checked={picked.has(h.id)} className="pointer-events-none" aria-label="리포트에 담기" />
                  <span className="w-8 shrink-0 text-right tabular-nums text-gray-500">#{numOf.get(h.id)}</span>
                  <span className="shrink-0 whitespace-nowrap tabular-nums text-gray-400">{fmtDateTime(h.t0)}</span>
                  <span className="shrink-0 rounded bg-blue-500/20 px-1.5 py-0.5 text-[11px] font-medium text-blue-200">{h.node}</span>
                  {/* 한 줄 목록에서도 이름을 고친다(2026-11-19 사용자 요청) — 자세히 보기와 같은 입력칸. 줄을 누르면 회차를 고르므로 칸 안 클릭은 줄로 올리지 않는다 */}
                  <input
                    value={h.label ?? ''}
                    onChange={(e) => onRename(h.id, e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    onMouseDown={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                    }}
                    placeholder="이름 없음"
                    title="이 회차의 이름 (눌러서 고치기)"
                    className="min-w-0 flex-1 cursor-text select-text truncate rounded border border-transparent bg-transparent px-1.5 py-0.5 text-gray-100 placeholder:text-gray-600 hover:border-white/10 focus:border-blue-500/60 focus:bg-black/20 focus:outline-none"
                  />
                  {runSummary(h)}
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      setNoteFor(h.id)
                    }}
                    title="이슈 · 원인 · 조치 적기: 리포트 실패 세부 원인 표 · 회차별 결과 · 차수별 요약(가져오기)에 나옴"
                    className={
                      'inline-flex h-6 shrink-0 items-center gap-1 rounded border px-2 text-[11px] ' +
                      ((h.notes ?? []).length ? 'border-blue-500/40 text-blue-200 hover:bg-blue-500/15' : 'border-white/10 text-gray-300 hover:bg-white/10')
                    }
                  >
                    원인 · 조치
                    {(h.notes ?? []).length > 0 && <span className="rounded-full bg-blue-500/25 px-1.5 text-[10.5px] leading-4 text-blue-100">{(h.notes ?? []).length}</span>}
                  </button>
                </div>
                  ))}
                </div>
              )
              })}
            </div>
          ) : (
            <div className="space-y-3">
              {list.map((h) => (
                <div key={h.id} className="rounded-xl border border-white/10 bg-panel-light p-3.5">
                  <div className="mb-2 flex items-center gap-2 text-[12px]">
                    <input
                      type="checkbox"
                      checked={picked.has(h.id)}
                      onChange={() => undefined}
                      onClick={(e) => pick(h.id, e.shiftKey)}
                      title="리포트에 담기 (Shift: 사이 모두)"
                      aria-label="리포트에 담기"
                    />
                    <span className="tabular-nums text-gray-500">#{numOf.get(h.id)}</span>
                    <span className="rounded bg-blue-500/20 px-2 py-0.5 font-medium text-blue-200">{h.node}</span>
                    <span className="whitespace-nowrap text-gray-300">{fmtDateTime(h.t0)}</span>
                    {runSummary(h)}
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
                    onClick={(e) => {
                      e.stopPropagation()
                      setNoteFor(h.id)
                    }}
                    title="이슈 · 원인 · 조치 적기: 리포트 실패 세부 원인 표 · 회차별 결과 · 차수별 요약(가져오기)에 나옴"
                    className={
                      'inline-flex h-6 shrink-0 items-center gap-1 rounded border px-2 text-[11px] ml-auto ' +
                      ((h.notes ?? []).length ? 'border-blue-500/40 text-blue-200 hover:bg-blue-500/15' : 'border-white/10 text-gray-300 hover:bg-white/10')
                    }
                  >
                    원인 · 조치
                    {(h.notes ?? []).length > 0 && <span className="rounded-full bg-blue-500/25 px-1.5 text-[10.5px] leading-4 text-blue-100">{(h.notes ?? []).length}</span>}
                  </button>
                    <button
                      onClick={() => {
                        exportRun(h)
                          .then((m) => m && setMsg(m))
                          .catch((e) => setMsg(`저장 실패: ${e instanceof Error ? e.message : String(e)}`))
                      }}
                      title="이 회차의 타임라인과 증적(서버 원문)을 Markdown 으로 저장: 제출용"
                      className="inline-flex shrink-0 items-center gap-1 rounded border border-white/10 px-1.5 py-0.5 text-[11px] text-gray-300 hover:bg-white/10"
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
                  <InjectEditor value={h.milestones.inject} downAt={downBaseOf(h.milestones, h.t0)?.at} runAt={h.t0} onSave={(v) => onSetInject(h.id, v)} />
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
  checking,
}: {
  cfg: BoardConfig
  connected: BoardSession[]
  /** 열려 있는 전체 세션(연결 끊긴 것 포함) */
  sessions: BoardSession[]
  onChange: (c: BoardConfig) => void
  canStart: boolean
  onStart: () => void
  /** 시작 전 분산 점검 중 — 버튼이 눌린 것처럼 보이게(점검이 몇 초 걸린다) */
  checking?: boolean
}) {
  /**
   * 드롭다운에는 연결이 끊긴 세션도 넣는다.
   * 검증 도중 노드를 죽이면(그게 이 도구의 목적이다) 그 세션은 '연결 끊김'이 되는데,
   * 연결된 것만 목록에 넣으면 지정해 둔 값이 목록에 없어 칸이 빈 것처럼 보이고
   * 사용자가 매핑이 날아간 줄 알고 다시 만지다 진짜로 지워버린다.
   */
  const selectable = useMemo(
    () => sessions.map((s) => (s.connected ? s : { ...s, name: `${s.name}: 연결 끊김` })),
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
        {connected.length === 0 && <span className="ml-1 text-amber-300"> 현재 연결된 세션이 없습니다.</span>}
      </p>

      <Section
        n={1}
        title="Host 노드: 전원 상태 · VIP 위치"
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

      <Section n={2} title="Masakari: 정상 2대 로그" desc="두 세션 중 한쪽만 finished 여도 완료로 종합 판정합니다.">
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
          {/* 파드 로그 이상 감시(10-28) — 파드가 다 Running 이어도 로그에 연결 실패가 찍히는 경우를 짚는다 */}
          <div className="mt-2.5 rounded border border-white/10 bg-black/20 px-2.5 py-2">
            <label className="flex items-center gap-2 text-[12px] text-gray-200">
              <input
                type="checkbox"
                checked={cfg.logWatch !== false}
                onChange={(e) => onChange({ ...cfg, logWatch: e.target.checked })}
                className="h-3.5 w-3.5 accent-blue-500"
              />
              파드 로그 이상 감시
              <span className="text-[10.5px] text-gray-500">
                보드를 띄워 두면 위 네임스페이스의 Running 파드 로그를 훑어 오류 · 경고 줄을 묶습니다. 처음 5분(검증을 시작하면 그때까지)의 오류는 평소 오류로 보고 뺍니다
              </span>
            </label>
            {cfg.logWatch !== false && (
              <div className="mt-1.5 grid grid-cols-[auto_1fr_1fr] items-start gap-2 text-[11px]">
                <label className="block">
                  <span className="mb-0.5 block text-gray-400">주기(초)</span>
                  <input
                    type="number"
                    min={30}
                    value={cfg.logWatchSec ?? 60}
                    onChange={(e) => onChange({ ...cfg, logWatchSec: Math.max(30, Number(e.target.value) || 60) })}
                    className="w-20 rounded border border-white/10 bg-panel-light px-2 py-1 text-gray-100"
                  />
                </label>
                <label className="block">
                  <span className="mb-0.5 block text-gray-400">더 찾을 단어 (쉼표)</span>
                  <CommaListInput value={cfg.logWords ?? []} onCommit={(v) => onChange({ ...cfg, logWords: v })} placeholder="예: Deadlock, HikariPool" />
                </label>
                <label className="block">
                  <span className="mb-0.5 block text-gray-400">무시할 문구 (쉼표)</span>
                  <CommaListInput value={cfg.logIgnore ?? []} onCommit={(v) => onChange({ ...cfg, logIgnore: v })} placeholder="예: deprecated, health check" />
                </label>
              </div>
            )}
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
          {checking ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />} {checking ? '분산 점검 중…' : '검증 시작'}
        </button>
      </div>
    </div>
  )
}

/** 쉼표 목록 칸 — 칠 때마다 나눠 저장하면 쉼표를 치는 순간 지워져 두 번째 단어를 못 넣는다. 칸을 떠날 때 반영한다 */
function CommaListInput({ value, onCommit, placeholder }: { value: string[]; onCommit: (v: string[]) => void; placeholder?: string }) {
  const [text, setText] = useState(value.join(', '))
  useEffect(() => setText(value.join(', ')), [value.join('|')])
  return (
    <input
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => onCommit(text.split(',').map((x) => x.trim()).filter(Boolean))}
      placeholder={placeholder}
      className="w-full rounded border border-white/10 bg-panel-light px-2 py-1 text-gray-100 placeholder:text-gray-600"
    />
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

/** [상세 보기] 의 한 번 실행 결과 */
interface CephRunResult {
  ok: boolean
  out: string
  at: number
  err?: string
}
const CEPH_TAB_KEY = 'ceph_detail_tab'
/**
 * Ceph 상세 창(2026-11-07 사용자 결정, 목업) — `watch ceph -s` 를 하려고 상태보드를 내리고 따로 명령을 치던 것을 대신한다.
 *  - ceph -s: 폴링이 이미 받은 원문 그대로(명령을 더 보내지 않는다). 폴링마다 바뀐다. 응답이 늦은 프레임이면 직전 원문과 '몇 초 전' 을 밝힌다
 *  - health detail · 클러스터 로그(ceph log last 50): **누를 때만** 한 번. 노드를 내린 동안 mon 이 느려 매초 돌리면 ceph -s 폴링이 밀린다
 * 머리에 HEALTH · degraded · misplaced 를 같이 띄워 창을 보는 동안에도 상황을 놓치지 않게 한다. 창이 떠 있어도 폴링 · 판정은 계속된다.
 * 닫기는 X 만(모달 규칙). 마지막에 본 탭은 기억한다.
 */
function CephDetailModal({ ceph, host, onRun, onClose }: { ceph: CephStat; host?: string; onRun?: (kind: 'detail' | 'log') => Promise<CephRunResult>; onClose: () => void }) {
  const [tab, setTab] = useState<'s' | 'detail' | 'log'>(() => {
    try {
      const v = localStorage.getItem(CEPH_TAB_KEY)
      return v === 'detail' || v === 'log' ? v : 's'
    } catch {
      return 's'
    }
  })
  const [res, setRes] = useState<Partial<Record<'detail' | 'log', CephRunResult>>>({})
  const [busy, setBusy] = useState<'detail' | 'log' | null>(null)
  const [copied, setCopied] = useState(false)
  const [, tick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [])
  const exec = async (k: 'detail' | 'log') => {
    if (!onRun || busy) return
    setBusy(k)
    try {
      const r = await onRun(k)
      setRes((cur) => ({ ...cur, [k]: r }))
    } finally {
      setBusy(null)
    }
  }
  const pick = (k: 's' | 'detail' | 'log') => {
    setTab(k)
    try {
      localStorage.setItem(CEPH_TAB_KEY, k)
    } catch {
      /* 기억 못 해도 이번 창에서는 동작한다 */
    }
    // 처음 누를 때 한 번 실행한다(누르는 것이 곧 실행) — 이미 받은 것은 [다시 조회] 로
    if (k !== 's' && !res[k]) void exec(k)
  }
  useEffect(() => {
    if (tab !== 's' && !res[tab]) void exec(tab)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const ago = (t?: number) => (t ? Math.max(0, Math.round((Date.now() - t) / 1000)) : null)
  const cur = tab === 's' ? null : res[tab]
  const text = tab === 's' ? (ceph.raw ?? '') : tab === 'log' ? cephLogLocal(cur?.out ?? '') : (cur?.out ?? '')
  const hints = tab === 'detail' && cur?.ok ? cephHints(cur.out) : []
  const badge =
    ceph.health === 'OK' ? 'bg-emerald-500/20 text-emerald-300' : ceph.health === 'unknown' ? 'bg-white/10 text-gray-400' : 'bg-amber-500/20 text-amber-300'
  const TabBtn = ({ k, label, sub }: { k: 's' | 'detail' | 'log'; label: string; sub?: string }) => (
    <button
      onClick={() => pick(k)}
      className={'rounded border px-2.5 py-0.5 text-[12px] ' + (tab === k ? 'border-blue-500/50 bg-blue-500/15 text-blue-100' : 'border-white/10 text-gray-300 hover:bg-white/5')}
    >
      {label}
      {sub && <span className="ml-1 text-[10.5px] text-gray-500">{sub}</span>}
    </button>
  )
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-8">
      <div className="flex h-[80vh] w-[1100px] max-w-[96vw] flex-col overflow-hidden rounded-lg border border-white/10 bg-panel shadow-2xl">
        <div className="flex items-center gap-2.5 border-b border-white/10 px-4 py-2.5">
          <FileText size={15} className="text-blue-400" />
          <span className="text-sm font-semibold text-gray-100">Ceph 상세</span>
          <span className={'inline-flex items-center gap-1 rounded-full px-2 py-px text-[11.5px] font-medium ' + badge}>
            {ceph.health === 'OK' ? <CircleCheck size={12} /> : <AlertTriangle size={12} />} HEALTH_{ceph.health === 'unknown' ? '?' : ceph.health}
          </span>
          <span className="text-[11.5px] text-gray-400">
            degraded <span className={ceph.degraded > 0 ? 'text-red-300' : 'text-emerald-300'}>{ceph.degraded.toLocaleString()}</span> · misplaced{' '}
            <span className={ceph.misplaced > 0 ? 'text-amber-300' : 'text-emerald-300'}>{ceph.misplaced.toLocaleString()}</span>
            {host ? ` · ${host}` : ''}
            {ceph.rawAt ? ` · ${fmtClock(ceph.rawAt)} 받음 (${ago(ceph.rawAt)}초 전)` : ''}
            {ceph.staleSec ? <span className="text-amber-300"> · 응답 지연</span> : null}
          </span>
          <button onClick={onClose} className="ml-auto rounded p-1 text-gray-400 hover:bg-white/10 hover:text-gray-200" title="닫기">
            <X size={16} />
          </button>
        </div>
        <div className="flex items-center gap-1.5 border-b border-white/10 px-4 py-2">
          <TabBtn k="s" label="ceph -s" sub="자동 갱신" />
          <TabBtn k="detail" label="health detail" />
          <TabBtn k="log" label="클러스터 로그" />
          <span className="ml-auto flex items-center gap-2 text-[11px] text-gray-500">
            {tab === 's' ? (
              <span>상태보드 폴링마다 갱신</span>
            ) : (
              <>
                {busy === tab ? (
                  <span className="inline-flex items-center gap-1">
                    <Loader2 size={11} className="animate-spin" /> 실행 중…
                  </span>
                ) : cur ? (
                  <span>{fmtClock(cur.at)} 실행</span>
                ) : null}
                <button
                  onClick={() => void exec(tab)}
                  disabled={!!busy || !onRun}
                  className="inline-flex items-center gap-1 rounded border border-white/10 px-2 py-0.5 text-gray-300 hover:bg-white/10 disabled:opacity-40"
                >
                  <RefreshCw size={11} /> 다시 조회
                </button>
              </>
            )}
            <button
              onClick={() => {
                void navigator.clipboard.writeText(text).then(() => {
                  setCopied(true)
                  setTimeout(() => setCopied(false), 1500)
                })
              }}
              disabled={!text}
              className="inline-flex items-center gap-1 rounded border border-white/10 px-2 py-0.5 text-gray-300 hover:bg-white/10 disabled:opacity-40"
            >
              <Copy size={11} /> {copied ? '복사됨' : '원문 복사'}
            </button>
          </span>
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-4 py-3 text-[12px]">
          <div className="mb-1.5 text-[11px] text-gray-500">
            {tab === 's' ? (
              <>
                <span className="font-mono text-gray-400">ceph -s</span> · 상태보드가 주기마다 이미 돌리는 명령의 원문입니다(명령을 더 보내지 않음). 창이 떠 있어도 폴링 · 판정은 계속됩니다.
                {ceph.staleSec ? <span className="text-amber-300"> 지금은 응답이 늦어 {ceph.staleSec}초 전 원문입니다.</span> : null}
              </>
            ) : tab === 'detail' ? (
              <>
                <span className="font-mono text-gray-400">ceph health detail</span> · 누를 때만 실행합니다(조회만)
              </>
            ) : (
              <>
                <span className="font-mono text-gray-400">ceph log last 50</span> · 누를 때만 실행합니다(조회만) · 시각은 이 PC 시간대 · 경고가 언제 시작 · 해소(Health check cleared)됐는지 봅니다
              </>
            )}
          </div>
          {cur?.err && <div className="mb-2 text-[12px] text-red-300">{cur.err}</div>}
          {text ? (
            <div className="overflow-x-auto rounded-lg bg-black/40 p-2 font-mono text-[11.5px] leading-[1.55] text-gray-300">
              <div className="w-max min-w-full">
                {text.split('\n').map((l, i) => {
                  // 로그는 상태가 바뀐 줄만(cephLogTone), ceph -s · health detail 은 경고 · 오류 줄과 경고 사유
                  const tone = tab === 'log' ? cephLogTone(l) : cephLineHot(l) || (tab === 's' && ceph.reasons.some((r) => r && l.includes(r))) ? 'bad' : ''
                  return (
                    <div
                      key={i}
                      className={'whitespace-pre px-1 ' + (tone === 'bad' ? 'rounded bg-amber-400/15 text-amber-100' : tone === 'good' ? 'rounded bg-emerald-400/15 text-emerald-100' : '')}
                    >
                      {l || ' '}
                    </div>
                  )
                })}
              </div>
            </div>
          ) : (
            !cur?.err && <div className="py-6 text-center text-gray-500">{tab === 's' ? '아직 받은 원문이 없습니다.' : busy ? '실행 중…' : '결과가 없습니다.'}</div>
          )}
          {hints.length > 0 && (
            <div className="mt-2 space-y-0.5 text-[11.5px] text-gray-400">
              {hints.map((h) => (
                <div key={h.code}>
                  <span className="font-mono text-amber-200">{h.code}</span> {h.desc}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
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
  podSession,
  onSpreadCheck,
  spreadBusy,
  addedSpread,
  onAddedSpreadOpen,
  onMasakariLog,
  logWatch,
  onLogIssues,
  onLogGroup,
  cephHost,
  onCephRun,
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
  /** 파드를 조회하는 세션 — 확대 창이 Pending 파드의 배정 실패 이유(이벤트)를 물을 때만 쓴다 */
  podSession?: string
  /** Ceph 를 묻는 세션 이름 — [상세 보기] 창 머리 */
  cephHost?: string
  /** [상세 보기] 의 health detail · 클러스터 로그 — 누를 때만 한 번 돌린다 */
  onCephRun?: (kind: 'detail' | 'log') => Promise<CephRunResult>
  /** 회차 사이 수동 분산 점검(노드가 돌아온 뒤 다음 노드를 내리기 전) */
  onSpreadCheck?: () => void
  spreadBusy?: boolean
  /** 검증 중 더한 네임스페이스의 추가 분산 점검 — 버튼 옆 표시로만 알린다(SpreadModal 'added') */
  addedSpread?: { busy: boolean; res: SpreadResult | null; at: number } | null
  onAddedSpreadOpen?: () => void
  /** Masakari 카드의 [로그] — 그 노드의 masakari-engine 로그를 실시간 로그 창으로 */
  onMasakariLog?: (sessionId: string) => void
  /** 파드 로그 이상 감시 — 꺼져 있거나 파드 세션이 없으면 null */
  logWatch?: LogWatchInfo | null
  onLogIssues?: (ns?: string) => void
  /** 묶음 key 로 합친 로그 창 열기 — 감시에 그 묶음이 없으면 false */
  onLogGroup?: (key: string) => boolean
}) {
  const [cephOpen, setCephOpen] = useState(false)
  // 크게 보고 있는 네임스페이스 — 훅이라 아래 '첫 폴링 대기' 보다 먼저 둔다
  const [expandNs, setExpandNs] = useState<string | null>(null)
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
  // 지금 이 알림을 들고 있는 엔진 — 앞 엔진이 error 로 끝냈으면 '여기서 다시 처리 중' 이라고 짚는다
  const progressBy = state.masakari
    .filter((m) => m.state === 'progress')
    .map((m) => svcShortName(resolveName(m.id, m.name)))
  /**
   * 노드 카드를 합친 evacuation 대수. 카드마다 **그 노드 로그**만 세므로, 엔진 여러 대가 같은 알림을 이어받으면 카드마다
   * 일부만 보인다(2026-10-26: con02 error → con03 이 11대). 인스턴스 id 로 겹친 것을 한 번만 센다.
   */
  const evacTotal = new Set(state.masakari.flatMap((m) => m.uuids ?? [])).size
  /**
   * 네임스페이스 카드 머리에 붙이는 판정 — 표만 보고는 타임라인의 '복구 완료' 와 이어지지 않았다(사용자 지적).
   * podsDoneSummary 와 같은 기준: 마지막 사건이 '다시 비정상' 이면 미완이다.
   */
  const nsPhase = (ns: string): NsPhase => {
    const { done, broken } = nsPodTimes(milestones, ns)
    if (broken && broken > done) return { kind: 'broken', at: broken }
    if (done) return { kind: 'done', at: done }
    if (milestones.pods.some((p) => p.ns === ns)) return { kind: 'recovering' }
    return { kind: 'none' }
  }
  const expandPod = expandNs ? state.pods.find((p) => p.namespace === expandNs) ?? null : null
  return (
    <div className="flex min-h-0 flex-1">
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
      {problems.length > 0 && (
        <div
          title={jobErrs.map(([k, msg]) => `${k}: ${msg}`).join('\n') || undefined}
          className="mb-2.5 flex items-center gap-1.5 rounded-md border border-red-500/40 bg-red-500/10 px-2.5 py-1 text-[11px] text-red-200"
        >
          <AlertTriangle size={12} className="shrink-0" />
          <span className="min-w-0 truncate">갱신 멈춤 (지금 값 아님): {problems.join(' · ')}</span>
        </div>
      )}
      {state.delayed.length > 0 && (
        <div className="mb-2.5 flex items-center gap-1.5 rounded-md bg-amber-500/10 px-2.5 py-1 text-[11px] text-amber-300">
          <Hourglass size={12} /> 응답이 늦어 이번 주기에 갱신하지 못한 항목: {state.delayed.join(', ')}: 직전 값을 표시 중입니다.
        </div>
      )}
      {/* 1. Host */}
      <SectionLabel n={1} text="Host: 전원 상태 · VIP 위치" />
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
                        (() => {
                          /**
                           * 타임라인 · 리포트와 같은 DOWN 시각을 보인다 — 서버 기록(저널 이탈)이 믿을 만하면 그것(serverTime.ts). 카드만 Q-Term 감지
                           * 시각을 보여 한 화면에 DOWN 이 두 개였다(코드 점검). 감지 시각은 툴팁으로 남긴다.
                           */
                          const md = milestones.down
                          const base = md && md.node === svcShortName(resolveName(h.id, h.name)) ? downBaseOf(milestones, t0) : null
                          const srv = base?.server ? base.at : null
                          return (
                            <span
                              className="whitespace-nowrap text-[11px] text-red-300/80"
                              title={
                                (srv != null ? `클러스터 저널이 이 노드의 이탈을 남긴 시각입니다(타임라인과 같음). Q-Term 감지는 ${fmtClock(h.downAt as number)}. ` : '') +
                                (h.downSource === 'pcs'
                                  ? 'Q-Term 감지: 살아있는 노드의 pacemaker 가 이 노드를 OFFLINE 으로 보고한 시각입니다.'
                                  : 'Q-Term 감지: SSH 세션이 끊긴 것을 확인한 시각입니다. keepalive 특성상 실제 정전 시점보다 최대 90초 늦을 수 있습니다.')
                              }
                            >
                              DOWN 시간 : {fmtClock(srv ?? (h.downAt as number))}
                              <span className="ml-1 text-gray-600">({srv != null ? '저널' : h.downSource})</span>
                            </span>
                          )
                        })()
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
          역할 매핑에 저장된 host {state.pendingHosts}개는 아직 접속하지 않아 표시하지 않습니다. 해당 세션을 연결하면 카드가 나타납니다.
        </div>
      )}

      {/* 2. Masakari */}
      {/* 카드에 적힌 노드명은 '로그를 읽은 호스트' 다 — VM 이 옮겨 간 곳으로 오해하기 쉬워 제목에 밝힌다 */}
      <SectionLabel
        n={2}
        text={`Masakari evacuation: 로그 조회 노드 기준 (한쪽만 finished 여도 완료)${
          state.masakari.filter((m) => (m.uuids?.length ?? 0) > 0).length > 1 ? ` · 노드 합계 ${evacTotal}대` : ''
        }`}
      />
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
          /**
           * 이 엔진은 error 로 끝냈지만 **다른 엔진이 이어받았다**(진행 중이거나 그쪽이 결론을 냈다). 그대로 빨강이면 회차 끝까지
           * 실패가 둘인 것처럼 보였다(코드 검토 지적) — 이어받은 쪽이 판정의 주인이므로 이 카드는 회색으로 물린다.
           */
          const handedOff =
            m.state === 'error' && state.masakari.some((o) => o.id !== m.id && (o.state === 'progress' || o.state === 'failed'))
          /** 넘겨받은 엔진 — '어디서 다시 시도하나' 를 카드에 적는다(진행 중이면 그쪽, 아니면 실패로 끝낸 쪽) */
          const takenBy = handedOff
            ? state.masakari
                .filter((o) => o.id !== m.id && (o.state === 'progress' || o.state === 'failed'))
                .map((o) => svcShortName(resolveName(o.id, o.name)))
            : []
          return (
          <div key={m.id} className="flex items-center gap-3 rounded-xl border border-white/10 bg-panel-light p-3">
            {m.state === 'finished' || doneElsewhere ? (
              <CircleCheck size={24} className={'shrink-0 ' + (m.state === 'finished' ? 'text-emerald-400' : 'text-emerald-400/60')} />
            ) : m.state === 'progress' ? (
              <Loader2 size={22} className="shrink-0 animate-spin text-amber-400" />
            ) : m.state === 'error' || m.state === 'failed' ? (
              <CircleX size={22} className={'shrink-0 ' + (m.state === 'failed' ? 'text-red-400' : handedOff ? 'text-gray-500' : 'text-amber-400')} />
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
                  <span
                    className={
                      m.state === 'finished'
                        ? 'text-emerald-300'
                        : m.state === 'progress'
                          ? 'text-amber-300'
                          : m.state === 'error' && handedOff
                            ? 'text-gray-400'
                            : m.state === 'error'
                              ? 'text-amber-300'
                              : m.state === 'failed'
                            ? 'text-red-300'
                            : 'text-gray-400'
                    }
                  >
                    {m.state === 'finished'
                      ? 'finished'
                      : m.state === 'progress'
                        ? '진행 중'
                        : m.state === 'failed'
                          ? '실패 (failed)'
                          : m.state === 'error'
                            ? // 'error' 는 끝이 아니다: masakari 가 한 번 더 시도한다. '처리 실패' 로는 그게 안 보였다(사용자 지적 10-27)
                              handedOff
                              ? '1차 시도 실패 → 재시도로 넘어감'
                              : '1차 시도 실패 · 재시도 대기'
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
                {/* 일이 벌어지는 카드에만(진행 중 · 처리 실패 · 실패) — 대기 중인 카드의 로그는 볼 것이 없다 */}
                {onMasakariLog && (m.state === 'progress' || m.state === 'error' || m.state === 'failed') && (
                  <button
                    onClick={() => onMasakariLog(m.id)}
                    title="이 노드의 masakari-engine 로그를 실시간 로그 창으로: 이미 열려 있으면 두 번째 패널에 엽니다"
                    className={
                      (m.evac > 0 ? '' : 'ml-auto ') +
                      'inline-flex shrink-0 items-center gap-1 rounded border border-white/10 px-1.5 py-0.5 text-[11px] text-gray-300 hover:bg-white/10'
                    }
                  >
                    <FileText size={11} /> 로그
                  </button>
                )}
              </div>
              {/* 한 줄로 잘리므로 전체 사유(실패 단계 · 원인)는 마우스를 올리면 */}
              <div className="truncate text-[11px] text-gray-500" title={m.detail}>
                {doneElsewhere
                  ? '이 노드에는 완료 로그 없음: 알림은 한 엔진만 처리합니다'
                  : m.state === 'error' && progressBy.length
                    ? `${progressBy.join(', ')} 에서 다시 시도 중. 최종 결과는 그쪽 카드 · error`
                    : handedOff
                      ? `${takenBy.join(', ')} 가 다시 시도함. 최종 결과는 그쪽 카드 · error`
                      : m.state === 'error'
                        ? '보통 1~2분 안에 한 번 더 시도함 (그래도 실패하면 최종 실패) · error'
                        : m.detail}
              </div>
            </div>
          </div>
          )
        })}
        {state.masakari.length === 0 && <div className="col-span-2 text-[12px] text-gray-500">masakari 세션이 지정되지 않았습니다.</div>}
      </div>

      {/* 3. Ceph (단독 행) */}
      <SectionLabel n={3} text="Ceph 상태" />
      {cephOpen && ceph && <CephDetailModal ceph={ceph} host={cephHost} onRun={onCephRun} onClose={() => setCephOpen(false)} />}
      <div className="mb-4 rounded-xl border border-white/10 bg-panel-light p-3.5">
        {ceph ? (
          <>
            <div className="flex items-center justify-between gap-2">
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
              {/* 원문 · health detail · 클러스터 로그 — 카드에 펼치지 않고 창으로(2026-11-07 사용자 결정: 카드 아래가 길어져 상태보드가 밀렸다) */}
              <button
                onClick={() => setCephOpen(true)}
                className={'inline-flex shrink-0 items-center gap-1 rounded border border-white/10 px-2 py-0.5 text-[11px] text-gray-300 hover:bg-white/10 ' + (ceph.etaSec != null ? '' : 'ml-auto')}
              >
                <FileText size={12} /> 상세 보기
              </button>
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
                    복구 진행률: <span className="text-gray-400">확인 불가</span> · ceph -s 가 응답하지 않아 위 수치는{' '}
                    {ceph.staleSec}초 전 값입니다
                  </div>
                )
              if (ceph.health === 'unknown')
                return (
                  <div className="mt-2.5 rounded-md border border-white/5 bg-black/20 px-2.5 py-2 text-[11px] text-gray-500">
                    복구 진행률: <span className="text-gray-400">확인 불가</span> · 위 수치는 조회에 실패한 값이라 0 으로 보입니다
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
              <span title="ceph -s 의 recovery 항목(objects/s): 초당 복구되는 오브젝트 수입니다.">
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
        help={
          '비정상 n: 살아 있는 노드 위에서 정상이 아닌 파드(Pending · CrashLoop · Ready 미충족)\n' +
          '확인 불가 n: NotReady 노드 위라 상태를 믿을 수 없는 파드. 복구 판정에서 빼고 카드 맨 아래에 회색으로 둡니다\n' +
          '새 파드: 검증 시작 뒤 새로 뜬 파드(복구로 다시 뜬 것)\n' +
          '복구 중: 장애 뒤 다시 뜨기 시작했지만 비정상 워크로드가 남음\n' +
          '복구 완료 시각: 비정상 워크로드 0 을 연속 2회 확인한 시각(확인 불가는 빼고 워크로드 Ready 수로 확인)\n' +
          '다시 비정상: 완료였다가 다시 깨짐. 다시 완료될 때까지 미완입니다'
        }
        right={
          <span className="inline-flex items-center gap-2">
            {logWatch && onLogIssues && (() => {
              // 오류만 센다(10-29) — 경고까지 세면 노드를 내리기 전부터 버튼이 노랗다. 경고는 회색으로 수만 밝힌다
              const fresh = logWatch.state.groups.filter((g) => !g.baseline && g.level === 'error')
              const freshWarn = logWatch.state.groups.filter((g) => !g.baseline && g.level === 'warn').length
              return (
                <button
                  onClick={() => onLogIssues()}
                  title={
                    `파드 로그를 1분마다 훑어 오류 · 경고 줄을 묶습니다${logWatch.state.lastAt ? ` (마지막 ${fmtClock(logWatch.state.lastAt)})` : ''}` +
                    (logWatch.baselineUntil ? `\n평소 오류 기준선을 ${fmtClock(logWatch.baselineUntil)}까지 뜨는 중` : '') +
                    (logWatch.err ? `\n${logWatch.err}` : '')
                  }
                  className={
                    'inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[11px] ' +
                    (fresh.length ? 'border-amber-500/50 bg-amber-500/15 text-amber-100 hover:bg-amber-500/25' : 'border-white/10 text-gray-400 hover:bg-white/10')
                  }
                >
                  {logWatch.scanning ? <Loader2 size={11} className="animate-spin" /> : <FileText size={11} />}
                  {fresh.length
                    ? `로그 새 오류 ${fresh.length}`
                    : logWatch.baselineUntil
                      ? '로그 기준선 뜨는 중'
                      : freshWarn
                        ? `로그 새 경고 ${freshWarn}`
                        : '로그 이상 없음'}
                  {logWatch.err && <AlertTriangle size={10} className="text-amber-300" />}
                </button>
              )
            })()}
            {onSpreadCheck && (
              <button
                onClick={onSpreadCheck}
                disabled={spreadBusy}
                title="레플리카가 노드별로 나뉘어 있는지 점검: 노드가 돌아온 뒤 다음 노드를 내리기 전에 누르세요"
                className="inline-flex items-center gap-1 rounded border border-white/10 px-2 py-0.5 text-[11px] text-gray-300 hover:bg-white/10 disabled:opacity-40"
              >
                {spreadBusy ? <Loader2 size={11} className="animate-spin" /> : <Server size={11} />} 분산 점검
              </button>
            )}
            {addedSpread &&
              (() => {
                // 몰림 · 조회 실패는 계속 보이고, 이상 없음은 15초만 회색으로 보였다가 사라진다
                const r = addedSpread.res
                // Valkey 마스터 몰림 · 같은 노드도 몰림으로 센다(같은 확인 창에서 보인다)
                const stacked = (r?.rows?.filter((w) => w.verdict === 'stacked').length ?? 0) + (r?.valkey?.filter(valkeyBad).length ?? 0)
                if (addedSpread.busy)
                  return (
                    <span className="inline-flex items-center gap-1 text-[11px] text-gray-500">
                      <Loader2 size={10} className="animate-spin" /> 추가 점검 중
                    </span>
                  )
                if (!r) return null
                if (r.rows && !stacked && now - addedSpread.at > 15_000) return null
                const cls = !r.rows
                  ? 'border-amber-500/40 bg-amber-500/10 text-amber-200'
                  : stacked
                    ? 'border-red-500/50 bg-red-500/15 text-red-200'
                    : 'border-white/10 text-gray-400'
                return (
                  <button
                    onClick={onAddedSpreadOpen}
                    title={`검증 중 더한 네임스페이스 점검: ${r.namespaces.join(', ')} · ${fmtClock(r.at)}`}
                    className={'inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[11px] hover:bg-white/10 ' + cls}
                  >
                    {!r.rows ? '추가 점검 실패' : stacked ? `추가 점검: 몰림 ${stacked}` : '추가 점검: 이상 없음'}
                  </button>
                )
              })()}
            {podsAt && (
              <span className={now - podsAt > staleLimit ? 'text-[11px] text-red-300' : 'text-[11px] text-gray-500'}>
                갱신 {fmtAgo(now - podsAt)}
              </span>
            )}
          </span>
        }
      />
      {state.notReadyNodes?.length > 0 && (
        <div className="mb-2 flex items-start gap-1.5 rounded-md border border-red-500/30 bg-red-500/10 px-2.5 py-1.5 text-[12px] text-red-200">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          {/* 두 줄 — 무슨 일인지·대상 / 왜 그런지·보드가 어떻게 다루는지(사용자 결정). 한 줄에 다 넣으니 괄호 속 설명이 핵심처럼 읽혔다 */}
          <div className="min-w-0">
            <div>
              <b>k8s 노드 {state.notReadyNodes.length}대 응답 없음 (NotReady)</b> {state.notReadyNodes.join(' · ')}
            </div>
            <div className="mt-0.5 text-[11px] text-gray-400">
              이 노드에 있는 파드는 'Running' 으로 보여도 실제로 살아 있는지 알 수 없습니다(노드가 끊겨도 API 서버는 한동안 마지막
              상태를 그대로 보여 줍니다). 표에서는 '확인 불가' 로 따로 묶고, 노드가 Ready 로 돌아오거나 파드가 다른 노드에서 다시 뜰
              때까지 복구로 판정하지 않습니다.
            </div>
          </div>
        </div>
      )}
      {state.pods.length === 0 ? (
        <div className="mb-4 rounded-xl border border-white/10 bg-panel-light p-3.5 text-[12px] text-gray-500">
          파드 세션/네임스페이스가 지정되지 않았습니다.
        </div>
      ) : (
        <div className="mb-4 grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(430px, 1fr))' }}>
          {state.pods.map((p) => (
            <PodNsCard
              key={p.namespace}
              p={p}
              scope={state.podScope}
              phase={nsPhase(p.namespace)}
              onRemove={() => onRemoveNamespace(p.namespace)}
              onExpand={() => setExpandNs(p.namespace)}
              logNew={logWatch ? logWatch.state.groups.filter((g) => g.ns === p.namespace && !g.baseline && g.level === 'error').length : 0}
              onLog={onLogIssues ? () => onLogIssues(p.namespace) : undefined}
            />
          ))}
        </div>
      )}

      {expandPod && (
        <PodNsModal
          p={expandPod}
          phase={nsPhase(expandPod.namespace)}
          podSession={podSession}
          onClose={() => setExpandNs(null)}
          logByPod={
            logWatch
              ? logWatch.state.groups
                  .filter((g) => g.ns === expandPod.namespace && !g.baseline && g.level === 'error')
                  .reduce<Record<string, number>>((m, g) => {
                    for (const pod of g.pods) m[pod] = (m[pod] ?? 0) + 1
                    return m
                  }, {})
              : undefined
          }
          onLog={onLogIssues ? () => onLogIssues(expandPod.namespace) : undefined}
        />
      )}

      {/* 복구 타임라인 */}
      <div className="mb-1 flex items-center gap-1.5 text-[13px] text-gray-300">
        <Activity size={15} /> 복구 타임라인
        <span className="text-[11px] text-gray-500">시:분:초 (검증 시작 후 경과)</span>
      </div>
      <div className="rounded-xl bg-panel-light/50 p-3.5 text-[12px]">
        <Timeline milestones={milestones} t0={t0} evKeys={evKeys} onEvidence={onEvidence} onOpenLog={onLogGroup} />
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

/** 분산 점검 한 번의 결과 — rows 가 null 이면 조회 실패(문제 없음이 아니다) */
interface SpreadResult {
  at: number
  rows: SpreadWorkload[] | null
  /** Valkey 마스터 배치 — 대상이 없으면 빈 배열, 예전 결과에는 없다 */
  valkey?: ValkeyCheck[]
  descheduler: boolean | null
  namespaces: string[]
  error?: string
}
const SPREAD_RULE: Record<SpreadWorkload['anti'], string> = { required: '필수', preferred: '권장', none: '없음' }
const SPREAD_LABEL: Record<SpreadVerdict, string> = {
  stacked: '❌ 한 노드에 몰림',
  none: '⚠ 분산 규칙 없음',
  soft: '⚠ 권장 분산만',
  ok: '✅ 필수 분산',
  single: '레플리카 1개',
}
const SPREAD_CLS: Record<SpreadVerdict, string> = {
  stacked: 'text-red-300',
  none: 'text-amber-200',
  soft: 'text-amber-200',
  ok: 'text-emerald-300',
  single: 'text-gray-500',
}
/** 판정 글자 — 레플리카 0 은 '1개' 가 아니라 꺼져 있는 것이다(화면에서 '레플리카 0 · 레플리카 1개' 로 보였다) */
const verdictLabel = (w: SpreadWorkload) => (w.verdict === 'single' && w.replicas === 0 ? '꺼져 있음' : SPREAD_LABEL[w.verdict])
const placementText = (w: SpreadWorkload) =>
  Object.entries(w.placement)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([n, c]) => `${n} ×${c}`)
    .join(' · ') || 'Running 없음'
/**
 * 규칙 칸 하나 — '노드 분리'(anti-affinity) · '고르게 분산'(topologySpread) 에 필수 · 권장 · 없음 한 단어. 원문 값 · YAML 위치는 툴팁.
 *
 * 처음엔 설정값을 툴팁으로만 뒀고('필수 · ScheduleAnyway 같은 글자는 뜻이 안 읽혔다'), 다음엔 '필수 분산 · 권장 분산' 이라는 말만으로는
 * YAML 의 어느 값인지 모른다(사용자 지적)고 해서 이름 아래에 원문 칩 두 개를 달았다. 그랬더니 28개 워크로드 대부분에 같은 칩
 * (anti-affinity preferred · topologySpread ScheduleAnyway)이 붙어 줄마다 세 줄 높이가 되고 정작 다른 정보가 묻혔다(2026-11-07 사용자 지적).
 * 지금: 줄에는 한 단어, 어느 YAML 값인지는 위 '판정 기준' 의 [YAML 값과 판정 규칙](접힘)에 대응표로 한 번 · 열 이름 아래 필드 이름 · 칸 툴팁.
 */
function RuleCell({ w, which }: { w: SpreadWorkload; which: 'anti' | 'spread' }) {
  const kind = w[which]
  const path =
    which === 'anti'
      ? kind === 'none'
        ? '호스트 기준 podAntiAffinity 가 없습니다'
        : `spec.template.spec.affinity.podAntiAffinity.${kind === 'required' ? 'required' : 'preferred'}DuringSchedulingIgnoredDuringExecution (topologyKey: kubernetes.io/hostname)`
      : kind === 'none'
        ? '호스트 기준 topologySpreadConstraints 가 없습니다'
        : `spec.template.spec.topologySpreadConstraints[].whenUnsatisfiable: ${kind === 'required' ? 'DoNotSchedule' : 'ScheduleAnyway'} (topologyKey: kubernetes.io/hostname)`
  return (
    <span
      title={path}
      className={
        'cursor-help border-b border-dotted text-[11.5px] font-medium ' +
        (kind === 'required' ? 'border-emerald-300/50 text-emerald-300' : kind === 'preferred' ? 'border-amber-200/50 text-amber-200' : 'border-gray-500/50 text-gray-500')
      }
    >
      {SPREAD_RULE[kind]}
    </span>
  )
}

const ruleRaw = (w: SpreadWorkload) =>
  `anti-affinity: ${w.anti === 'required' ? 'required(필수)' : w.anti === 'preferred' ? 'preferred(권장)' : '없음'} · topologySpread: ${
    w.spread === 'required' ? 'DoNotSchedule(필수)' : w.spread === 'preferred' ? 'ScheduleAnyway(권장)' : '없음'
  }`
/**
 * 그 규칙이면 **노드가 죽었을 때 어떻게 되나** — 설정값 대신 결과를 한 문장으로. 사용자가 판단하는 것은 결과다.
 * 몰림은 규칙과 무관하게 '지금' 이 문제이므로 그것을 먼저 말한다.
 */
/*
 * '필수 분산' 판정의 뜻 — 어떤 필수 규칙인지에 따라 쉬운 말로(2026-11-10 사용자 요청). 처음 바꾼 '파드 고정 · UP 되면 자동 복귀' 는
 * 늘 맞지 않았다(코드 리뷰): Deployment 는 죽은 노드의 파드가 정리되면 규칙을 만족하는 빈 노드에 새로 뜨고, 노드가 돌아와도 저절로
 * 다시 나뉘지 않는다. 규칙이 보장하는 것만 말한다.
 *  - anti-affinity 필수: 같은 노드에 두 개가 뜨지 않는다 → 남은 파드로 서비스가 이어지고, 다시 뜰 때도 다른 파드가 없는 노드에만 뜬다
 *  - topologySpread 필수(DoNotSchedule): 노드마다 고르게 뜬다 → 남은 파드로 이어지고, 고르게 맞출 수 있는 노드에만 다시 뜬다
 */
const SPREAD_OK_ANTI = '같은 노드에 두 개가 뜨지 않는 규칙(anti-affinity 필수). 노드가 DOWN 되어도 남은 파드로 서비스 유지, 다시 뜰 때도 파드가 없는 노드에만 뜸.'
const SPREAD_OK_SPREAD = '노드마다 고르게 뜨는 규칙(topologySpread 필수). 노드가 DOWN 되어도 남은 파드로 서비스 유지, 고르게 맞출 수 있는 노드에만 다시 뜸.'
/** 분산 점검 증적 아래 설명 — 옛 문장('돌아올 때 자동으로 다시 나뉩니다')도 늘 맞지는 않아 바꿨다(SPREAD_OK_ANTI 주석). 저장된 증적은 그릴 때 바꾼다 */
const SPREAD_NOTE_OLD = '필수(required) 규칙이면 장애 뒤 노드가 돌아올 때 자동으로 다시 나뉩니다.'
const SPREAD_NOTE_NEW = '필수(required) 규칙이면 노드마다 나뉘어 있어, 한 노드가 DOWN 되어도 남은 파드로 서비스가 이어집니다.'
/** 이미 저장된 증적에 남은 옛 '필수 분산' 문장들 — 그릴 때 줄의 ANTI-AFFINITY 칸을 보고 새 문장으로 바꾼다(spreadTextNow) */
const SPREAD_OK_OLDS = ['노드가 죽어도 남은 노드에서 버티고, 돌아오면 자동으로 다시 나뉩니다.', 'k8s 노드가 DOWN 되어도 파드는 그 자리에 고정(다른 노드로 옮기지 않음), 노드가 UP 되면 자동 복귀.']
/** 분산 점검 증적 원문의 옛 문장을 지금 문장으로 — 줄은 탭으로 나뉜 NS · WORKLOAD · REPLICAS · ANTI-AFFINITY · SPREAD · 배치 · 판정 */
function spreadTextNow(text: string): string {
  if (!SPREAD_OK_OLDS.some((o) => text.includes(o))) return text
  return text
    .split('\n')
    .map((l) => {
      const old = SPREAD_OK_OLDS.find((o) => l.includes(o))
      return old ? l.split(old).join(l.split('\t')[3] === '필수' ? SPREAD_OK_ANTI : SPREAD_OK_SPREAD) : l
    })
    .join('\n')
}
function spreadMeaning(w: SpreadWorkload, descheduler: boolean | null): string {
  const nodes = Object.keys(w.placement)
  switch (w.verdict) {
    case 'stacked':
      return `지금 ${nodes[0]} 에만 ${w.placement[nodes[0]]}개 있어 이 노드를 내리면 끊깁니다.${
        w.anti === 'required' || w.spread === 'required' ? ' 규칙은 필수인데 다른 노드에 자리가 없어 몰린 상태입니다.' : ''
      }`
    case 'ok':
      // 어떤 필수 규칙인지에 따라(SPREAD_OK_ANTI 주석). 이미 저장된 증적의 옛 문장은 spreadTextNow 로 바꿔 보인다
      return w.anti === 'required' ? SPREAD_OK_ANTI : SPREAD_OK_SPREAD
    case 'soft':
      return descheduler
        ? '노드가 죽으면 한 노드로 몰리고, 돌아오면 descheduler 가 다시 나눕니다.'
        : '노드가 죽으면 한 노드로 몰리고, 돌아와도 몰린 채 남습니다.'
    case 'none':
      return '분산 규칙이 없어 처음부터 한 노드에 몰릴 수 있습니다.'
    default:
      return w.replicas === 0 ? '레플리카가 0 이라 실행 중인 파드가 없습니다.' : '그 노드가 죽으면 다른 노드에서 다시 뜰 때까지 끊깁니다.'
  }
}

/** 판정 용어 설명 — 한 줄로 늘어놓으니 읽히지 않았다(사용자 지적). 2×2 칸에 배지와 설명을 따로 둔다 */
const SPREAD_LEGEND: { v: SpreadVerdict; name: string; desc: string }[] = [
  { v: 'ok', name: '필수 분산', desc: '필수 규칙으로 노드마다 나뉘어, 노드가 DOWN 되어도 남은 파드로 서비스 유지' },
  { v: 'soft', name: '권장 분산만', desc: '노드가 죽으면 한 노드로 몰리고, 돌아와도 몰린 채 남을 수 있습니다' },
  { v: 'none', name: '규칙 없음', desc: '처음부터 한 노드에 몰릴 수 있습니다' },
  { v: 'stacked', name: '몰림', desc: '지금 한 노드에만 있어, 그 노드를 내리면 끊깁니다' },
]

/**
 * Valkey 마스터 배치 칸(2026-11-18 사용자 요청, 목업) — 분산 점검 창의 워크로드 표 위. 마스터 줄마다 노드 · 슬롯 · 레플리카와 그 노드,
 * 마스터 몰림(빨강) · 같은 노드(노랑). 문제가 있으면 '그 노드를 내리면 무엇이 되는지' 와 크론잡이 다시 나눈다는 조치를 붙인다.
 * 읽지 못하면 회색 한 줄(조회 실패 ≠ 장애).
 */
function ValkeySection({ v, at }: { v: ValkeyCheck; at: number }) {
  const title = (
    <>
      <span className="font-medium text-gray-100">Valkey 마스터 배치</span>
      <span className={'rounded px-2 py-0.5 font-mono text-[11px] ' + NS_TINT}>
        {v.ns}/{v.name}
      </span>
    </>
  )
  if (v.verdict === 'error')
    return (
      <div className="flex flex-wrap items-center gap-2 border-b border-white/10 px-4 py-2 text-[12px]">
        {title}
        <span className="text-[11px] text-gray-500">확인 못 함. {v.error} 시작은 막지 않습니다.</span>
      </div>
    )
  const same = v.masters.filter((m) => m.same)
  const cronText = v.cron
    .map((c) => `${c.name} 마지막 실행 ${c.last ? fmtAgo(Math.max(0, at - c.last)) : '기록 없음'}${c.schedule ? ` (${c.schedule})` : ''}`)
    .join(' · ')
  return (
    <div className="border-b border-white/10 px-4 py-2 text-[12px]">
      <div className="flex flex-wrap items-center gap-2">
        {title}
        {v.stackedNodes.length > 0 ? (
          <span className="text-red-300">❌ 마스터 몰림: {v.stackedNodes.map((s) => `${s.node} 에 ${s.count}개`).join(', ')}</span>
        ) : (
          <span className="text-emerald-300">✅ 마스터 노드마다 1개</span>
        )}
        {same.length > 0 ? (
          <span className="text-amber-200">· ⚠ 마스터와 레플리카가 같은 노드 {same.length}쌍</span>
        ) : (
          <span className="text-[11px] text-emerald-300/80">· 레플리카는 모두 다른 노드</span>
        )}
        <span className="ml-auto text-[11px] text-gray-500">{v.from} 의 /data/nodes.conf</span>
      </div>
      <table className="mt-1.5 w-full table-fixed text-[11.5px]">
        <thead>
          <tr className="text-center text-[10.5px] text-gray-500">
            <th className="py-0.5 font-normal">마스터</th>
            <th className="py-0.5 font-normal">노드</th>
            <th className="py-0.5 font-normal">슬롯</th>
            <th className="py-0.5 font-normal">레플리카</th>
            <th className="py-0.5 font-normal">레플리카 노드</th>
            <th className="py-0.5 font-normal">판정</th>
          </tr>
        </thead>
        <tbody>
          {v.masters.map((m) => (
            <tr
              key={m.pod}
              className={
                'border-t border-white/5 text-center ' +
                (m.stacked ? 'bg-red-500/[0.07] shadow-[inset_3px_0_0_#ef4444]' : m.same ? 'bg-amber-500/[0.06] shadow-[inset_3px_0_0_#f59e0b]' : '')
              }
            >
              <td className="py-1 font-mono text-gray-100">
                {m.pod}
                {m.flags.length > 0 && <span className="ml-1 text-[10.5px] text-amber-200">({m.flags.join(',')})</span>}
              </td>
              <td className="py-1 font-mono text-gray-300">{m.node ?? '?'}</td>
              <td className="py-1 font-mono text-gray-400">{m.slots}</td>
              <td className="break-words py-1 font-mono text-gray-300">{m.replicas.map((r) => r.pod).join(', ') || '-'}</td>
              <td className="break-words py-1 font-mono text-gray-300">{m.replicas.map((r) => r.node ?? '?').join(', ') || '-'}</td>
              <td className="py-1">
                {m.stacked ? <span className="text-red-300">마스터 몰림</span> : m.same ? <span className="text-amber-200">같은 노드</span> : <span className="text-emerald-300">정상</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {v.unknown.length > 0 && (
        <div className="mt-1 text-[11px] text-gray-500">노드를 알 수 없어 판정에서 뺀 것: {v.unknown.join(', ')}</div>
      )}
      {valkeyBad(v) && (
        <div className="mt-1.5 rounded bg-black/20 px-2.5 py-1.5 text-[11px] leading-relaxed text-red-100/90">
          {v.stackedNodes.map((s) => (
            <div key={s.node}>
              <b className="font-medium">{s.node}</b> 를 내리면 마스터 {s.count}개가 한꺼번에 페일오버합니다.
            </div>
          ))}
          {same.map((m) => (
            <div key={m.pod}>
              <b className="font-medium">{m.node}</b> 를 내리면 {m.pod} 와 그 레플리카가 같이 죽어 슬롯 {m.slots} 를 받을 곳이 없습니다.
            </div>
          ))}
          <div className="mt-0.5 text-red-100/70">
            재배치 크론잡이 다시 나눕니다. 기다린 뒤 다시 점검하세요.{cronText && ` ${cronText}`}
          </div>
        </div>
      )}
      {!valkeyBad(v) && cronText && <div className="mt-1 text-[11px] text-gray-500">{cronText}</div>}
    </div>
  )
}

/**
 * 분산 점검 결과 창 — 문제 있는 네임스페이스만 펼치고, 줄마다 설정값이 아니라 '노드가 죽으면 어떻게 되나' 를 적는다(설정값은 툴팁).
 * 몰림 안내는 **기본 접힘** 한 줄 요약 → 누르면 노드별 목록과 조치(사용자 지적: 펼쳐 둔 목록이 길어 표가 밀렸다).
 * 네임스페이스를 다 펼쳐도 열이 맞게 **하나의 표**에 네임스페이스 머리 줄을 끼우고 열 너비를 고정한다(넘치면 칸 안에서 줄바꿈).
 * 시작 전 확인(precheck)에서는 [취소] · [무시하고 시작], 수동 점검(manual)에서는 [다시 점검] · [닫기]. 닫기는 버튼으로만(모달 규칙).
 */
function SpreadModal({
  mode,
  res,
  busy,
  onClose,
  onProceed,
  onRecheck,
}: {
  mode: 'precheck' | 'manual' | 'added'
  res: SpreadResult
  busy: boolean
  onClose: () => void
  onProceed?: () => void
  onRecheck?: () => void
}) {
  const [onlyBad, setOnlyBad] = useState(true)
  const [bannerOpen, setBannerOpen] = useState(false)
  const [legendOpen, setLegendOpen] = useState(false)
  /**
   * 사람이 정한 펼침 상태 — 없으면 기본(문제 있는 것만 펼침). 처음엔 '기본과 반대' 집합으로 들고 있어 [문제만] 을 바꾸면 사람이 연 것이
   * 거꾸로 닫혔다(코드 점검). 열림/닫힘을 그대로 적어 둔다.
   */
  const [openState, setOpenState] = useState<Map<string, boolean>>(() => new Map())
  const rows = res.rows ?? []
  const isBad = (v: SpreadVerdict) => v === 'stacked' || v === 'none' || v === 'soft'
  const byNs = new Map<string, SpreadWorkload[]>()
  for (const w of rows) byNs.set(w.ns, [...(byNs.get(w.ns) ?? []), w])
  const stacked = rows.filter((w) => w.verdict === 'stacked')
  // 몰림을 노드별로 — '이 노드를 내리면 이것들이 끊긴다'
  const byNode = new Map<string, SpreadWorkload[]>()
  for (const w of stacked) {
    const n = Object.keys(w.placement)[0]
    byNode.set(n, [...(byNode.get(n) ?? []), w])
  }
  const count = (list: SpreadWorkload[], v: SpreadVerdict) => list.filter((w) => w.verdict === v).length
  // 몰림이 있는 네임스페이스를 맨 위로(2026-11-07 목업) — 끊길 것이 먼저 보이게. 나머지는 이름순(rows 가 이미 이름순)
  const nsList = [...byNs.entries()]
    .filter(([, list]) => !onlyBad || list.some((w) => isBad(w.verdict)))
    .sort((a, b) => Number(b[1].some((w) => w.verdict === 'stacked')) - Number(a[1].some((w) => w.verdict === 'stacked')))
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-8">
      <div className="flex max-h-[86vh] w-[1180px] max-w-[96vw] flex-col overflow-hidden rounded-lg border border-white/10 bg-panel shadow-2xl">
        <div className="flex flex-wrap items-center gap-2 border-b border-white/10 px-4 py-2.5">
          <Server size={15} className="text-blue-400" />
          <span className="text-sm font-semibold text-gray-100">{mode === 'added' ? '검증 중 추가 점검' : '파드 분산 점검'}</span>
          {mode === 'added' && <span className="text-[11px] text-amber-300/90">(장애 중일 수 있음)</span>}
          <span className="text-[11px] text-gray-500">
            {res.namespaces.length}개 네임스페이스 · 워크로드 {rows.length}개 · {fmtClock(res.at)}
          </span>
          {/* 전체 열기 · 닫기 — 네임스페이스를 하나씩 누르지 않게(사용자 요청). 기본 펼침(문제 있는 것)과 다른 것만 toggled 에 담는 방식이라
              '모두 열림/닫힘' 이 되도록 toggled 를 다시 계산한다 */}
          <span className="ml-auto inline-flex overflow-hidden rounded border border-white/10 text-[11px]">
            {(['open', 'close'] as const).map((k) => (
              <button
                key={k}
                onClick={() => setOpenState(new Map(nsList.map(([ns]) => [ns, k === 'open'])))}
                className="px-2 py-0.5 text-gray-300 hover:bg-white/10"
              >
                {k === 'open' ? '전체 열기' : '전체 닫기'}
              </button>
            ))}
          </span>
          <label className="inline-flex cursor-pointer items-center gap-1 text-[11px] text-gray-400">
            <input type="checkbox" checked={onlyBad} onChange={(e) => setOnlyBad(e.target.checked)} /> 문제만
          </label>
        </div>

        {stacked.length > 0 && (
          <div className="border-b border-red-500/30 bg-red-500/10 px-4 py-2 text-[12px] text-red-200">
            <button onClick={() => setBannerOpen((v) => !v)} className="flex w-full items-center gap-2 text-left">
              <AlertTriangle size={13} className="shrink-0" />
              <span className="font-medium">
                한 노드에 몰린 워크로드 {stacked.length}개 (노드 {byNode.size}대)
              </span>
              <span className="text-[11px] text-red-200/70">그 노드를 내리면 서비스가 끊깁니다.</span>
              <span className="ml-auto text-[11px] text-red-200/80">{bannerOpen ? '접기 ▴' : '자세히 ▾'}</span>
            </button>
            {bannerOpen && (
              <div className="mt-2 space-y-2 pl-5">
                <table className="w-full table-fixed text-[11.5px]">
                  <colgroup>
                    <col style={{ width: 150 }} />
                    <col />
                  </colgroup>
                  <thead>
                    <tr className="text-left text-[10.5px] text-red-200/60">
                      <th className="pb-0.5 font-normal">이 노드를 내리면</th>
                      <th className="pb-0.5 font-normal">끊기는 워크로드</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...byNode.entries()].map(([node, list]) => (
                      <tr key={node} className="border-t border-red-500/15 align-top">
                        <td className="py-1 pr-3 font-mono text-red-100">{node}</td>
                        <td className="break-words py-1 text-red-200/90">{list.map((w) => `${w.ns}/${w.name}`).join(', ')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="rounded bg-black/20 px-2.5 py-1.5 text-[11px] leading-relaxed text-red-100/90">
                  <b className="font-medium">조치</b> 노드가 모두 Ready 인지 먼저 확인한 뒤, 몰린 워크로드를 다시 배포하면 노드별로 나뉩니다.
                  <code className="mt-1 block font-mono text-[11px] text-red-50">kubectl rollout restart deployment/&lt;이름&gt; -n &lt;네임스페이스&gt;</code>
                </div>
              </div>
            )}
          </div>
        )}

        {res.valkey?.some(valkeyBad) && (
          <div className="border-b border-red-500/30 bg-red-500/10 px-4 py-2 text-[12px] text-red-200">
            <span className="inline-flex items-center gap-2">
              <AlertTriangle size={13} className="shrink-0" />
              <span className="font-medium">Valkey 마스터 배치에 문제가 있습니다</span>
              <span className="text-[11px] text-red-200/70">아래 Valkey 마스터 배치를 확인하세요.</span>
            </span>
          </div>
        )}
        {(res.valkey ?? []).map((v) => (
          <ValkeySection key={`${v.ns}/${v.name}`} v={v} at={res.at} />
        ))}

        {/*
          판정 기준(2026-11-07 사용자 결정, 목업) — 네 판정의 뜻은 늘 보인다(줄마다 되풀이하던 설명 문장을 여기로 한 번만 옮겼다).
          어느 YAML 값이 필수 · 권장인지 대응표와 판정 규칙은 따로 접어 둔다(처음 한 번 읽으면 되는 것이라 표를 밀지 않게).
        */}
        <div className="border-b border-white/10 px-4 py-1.5 text-[11px]">
          <div className="grid grid-cols-2 gap-x-6 gap-y-0.5">
            {SPREAD_LEGEND.map((x) => (
              <div key={x.v} className="flex items-baseline gap-2">
                <span className={'w-[78px] shrink-0 font-medium ' + SPREAD_CLS[x.v]}>{x.name}</span>
                <span className="text-gray-400">
                  {x.v === 'soft' && res.descheduler ? '노드가 죽으면 한 노드로 몰리고, 돌아오면 descheduler 가 다시 나눕니다' : x.desc}
                </span>
              </div>
            ))}
          </div>
          <button onClick={() => setLegendOpen((v) => !v)} className="mt-1 flex items-center gap-1 text-left text-gray-300 hover:text-gray-100">
            {legendOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />} YAML 값과 판정 규칙
            <span className="text-gray-500">표의 '노드 분리 · 고르게 분산' 이 어느 설정값인지</span>
          </button>
          {legendOpen && (
            <div className="mt-1 mb-1 pl-4">
              <table className="text-[10.5px]">
                <thead>
                  <tr className="text-left text-gray-500">
                    <th className="pb-0.5 pr-4 font-normal">표의 칸</th>
                    <th className="pb-0.5 pr-4 font-normal">YAML 위치</th>
                    <th className="pb-0.5 pr-4 font-normal text-emerald-300">필수</th>
                    <th className="pb-0.5 pr-4 font-normal text-amber-200">권장</th>
                    <th className="pb-0.5 font-normal">없음</th>
                  </tr>
                </thead>
                <tbody className="text-gray-300">
                  <tr className="border-t border-white/5">
                    <td className="py-0.5 pr-4">노드 분리</td>
                    <td className="py-0.5 pr-4 font-mono">spec.template.spec.affinity.podAntiAffinity</td>
                    <td className="py-0.5 pr-4 font-mono text-emerald-300">requiredDuringScheduling…</td>
                    <td className="py-0.5 pr-4 font-mono text-amber-200">preferredDuringScheduling…</td>
                    <td className="py-0.5 text-gray-500">설정 없음</td>
                  </tr>
                  <tr className="border-t border-white/5">
                    <td className="py-0.5 pr-4">고르게 분산</td>
                    <td className="py-0.5 pr-4 font-mono">spec.template.spec.topologySpreadConstraints[].whenUnsatisfiable</td>
                    <td className="py-0.5 pr-4 font-mono text-emerald-300">DoNotSchedule</td>
                    <td className="py-0.5 pr-4 font-mono text-amber-200">ScheduleAnyway</td>
                    <td className="py-0.5 text-gray-500">설정 없음</td>
                  </tr>
                </tbody>
              </table>
              <p className="mt-1 text-[10.5px] leading-relaxed text-gray-500">
                둘 다 topologyKey 가 kubernetes.io/hostname(노드 단위)인 것만 봅니다. 두 칸 중 하나라도 필수면 필수 분산, 아니고 하나라도 권장이면 권장 분산만,
                둘 다 없으면 규칙 없음입니다. 몰림은 규칙과 상관없이 지금 Running 파드가 한 노드에만 있으면 붙습니다. 칸에 마우스를 올리면 그 워크로드의 원문 값이 보입니다.
              </p>
            </div>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-4 py-2 text-[12px]">
          {!res.rows ? (
            <div className="py-6 text-center text-red-300">점검하지 못했습니다. {res.error ?? '알 수 없는 오류'}</div>
          ) : (
            <table className="w-full table-fixed text-[11.5px]">
              <colgroup>
                <col style={{ width: '27%' }} />
                <col style={{ width: 60 }} />
                <col style={{ width: 84 }} />
                <col style={{ width: 96 }} />
                <col style={{ width: '28%' }} />
                <col />
              </colgroup>
              <thead className="sticky top-0 z-[1] bg-panel">
                <tr className="text-left text-[10.5px] text-gray-500">
                  <th className="py-1 pl-5 font-normal">워크로드</th>
                  <th className="py-1 text-center font-normal">레플리카</th>
                  <th className="py-1 text-center font-normal">
                    노드 분리<span className="block font-mono text-[9.5px] text-gray-600">anti-affinity</span>
                  </th>
                  <th className="py-1 text-center font-normal">
                    고르게 분산<span className="block font-mono text-[9.5px] text-gray-600">topologySpread</span>
                  </th>
                  <th className="py-1 font-normal">지금 배치 (노드별 Running)</th>
                  <th className="py-1 font-normal">판정</th>
                </tr>
              </thead>
              {nsList.map(([ns, list]) => {
                const bad = list.filter((w) => isBad(w.verdict))
                const open = openState.get(ns) ?? (onlyBad && bad.length > 0)
                const shown = onlyBad ? bad : list
                return (
                  <tbody key={ns}>
                    <tr className="border-t border-white/10">
                      <td colSpan={6} className="py-1">
                        <button
                          onClick={() => setOpenState((cur) => new Map(cur).set(ns, !open))}
                          className="flex w-full items-center gap-2 text-left text-[12px]"
                        >
                          <span className="w-3 text-gray-500">{open ? '▾' : '▸'}</span>
                          <span className={'rounded px-2 py-0.5 font-mono text-[11px] ' + NS_TINT}>{ns}</span>
                          {count(list, 'stacked') > 0 && <span className="text-red-300">몰림 {count(list, 'stacked')}</span>}
                          {count(list, 'none') > 0 && <span className="text-amber-200">규칙 없음 {count(list, 'none')}</span>}
                          {count(list, 'soft') > 0 && <span className="text-amber-200">권장만 {count(list, 'soft')}</span>}
                          {count(list, 'ok') > 0 && <span className="text-emerald-300">필수 {count(list, 'ok')}</span>}
                        </button>
                      </td>
                    </tr>
                    {open &&
                      shown.map((w) => (
                        <tr
                          key={w.kind + w.name}
                          className={'border-t border-white/5 align-top ' + (w.verdict === 'stacked' ? 'bg-red-500/[0.07] shadow-[inset_3px_0_0_#ef4444]' : '')}
                          title={ruleRaw(w)}
                        >
                          <td className="break-words py-1 pl-5 pr-3 font-mono text-gray-100">{w.name}</td>
                          <td className="py-1 text-center text-gray-400">{w.replicas}</td>
                          <td className="py-1 text-center">
                            <RuleCell w={w} which="anti" />
                          </td>
                          <td className="py-1 text-center">
                            <RuleCell w={w} which="spread" />
                          </td>
                          <td className="break-words py-1 pr-3 text-gray-300">{placementText(w)}</td>
                          {/* 판정 이름만 — 뜻은 위 판정 기준에 한 번. 몰림 · 1개 · 꺼짐은 그 줄만의 사정이라 문장을 붙인다 */}
                          <td className="py-1" title={spreadMeaning(w, res.descheduler)}>
                            <span className={SPREAD_CLS[w.verdict]}>{verdictLabel(w)}</span>
                            {(w.verdict === 'stacked' || w.verdict === 'single') && (
                              <span className="block break-words text-[11px] text-gray-500">{spreadMeaning(w, res.descheduler)}</span>
                            )}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                )
              })}
            </table>
          )}
          {res.rows && onlyBad && !rows.some((w) => isBad(w.verdict)) && (
            <div className="py-6 text-center text-emerald-300">모든 워크로드가 필수 분산으로 나뉘어 있습니다.</div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t border-white/10 px-4 py-2 text-[11px] text-gray-500">
          <span>
            descheduler{' '}
            {res.descheduler == null ? '확인 못 함' : res.descheduler ? '있음' : '없음. 권장 분산은 노드가 돌아와도 다시 나뉘지 않습니다.'}
          </span>
          <span className="ml-auto flex gap-2">
            {mode === 'precheck' ? (
              <>
                <button onClick={onClose} className="rounded border border-white/10 px-3 py-1 text-[12px] text-gray-300 hover:bg-white/10">
                  취소
                </button>
                <button
                  onClick={onProceed}
                  className="rounded border border-amber-500/40 bg-amber-500/15 px-3 py-1 text-[12px] text-amber-100 hover:bg-amber-500/25"
                >
                  무시하고 시작
                </button>
              </>
            ) : (
              <>
                <button
                  onClick={onRecheck}
                  disabled={busy}
                  className="inline-flex items-center gap-1 rounded border border-white/10 px-3 py-1 text-[12px] text-gray-300 hover:bg-white/10 disabled:opacity-40"
                >
                  {busy ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} 다시 점검
                </button>
                <button onClick={onClose} className="rounded border border-white/10 px-3 py-1 text-[12px] text-gray-300 hover:bg-white/10">
                  닫기
                </button>
              </>
            )}
          </span>
        </div>
      </div>
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

/** 네임스페이스 카드 머리의 복구 판정 — 타임라인과 같은 기준(마지막 사건이 '다시 비정상' 이면 미완) */
type NsPhase = { kind: 'done'; at: number } | { kind: 'broken'; at: number } | { kind: 'recovering' } | { kind: 'none' }

function NsPhaseBadge({ phase, badNow = 0 }: { phase: NsPhase; badNow?: number }) {
  /**
   * 완료 배지인데 **지금** 진짜 비정상이 있으면 그대로 초록이면 안 된다 — '비정상 1 · 복구 완료' 가 나란히 떠 서로 다른 말을
   * 했다(사용자 지적). 연속 2프레임 확인 전이라 아직 '다시 비정상' 으로 확정되지 않은 순간이다. 확정되면 아래 broken 으로 바뀐다.
   */
  if (phase.kind === 'done' && badNow > 0)
    return (
      <span className="inline-flex items-center gap-1 whitespace-nowrap rounded bg-amber-500/15 px-1.5 py-0.5 text-[11px] text-amber-200" title="복구 완료 뒤 비정상 파드가 다시 보입니다. 연속 2회 확인되면 '다시 비정상' 으로 바뀝니다">
        <AlertTriangle size={11} /> 복구 완료 {fmtClock(phase.at)} · 비정상 확인 중
      </span>
    )
  if (phase.kind === 'done')
    return (
      <span className="inline-flex items-center gap-1 whitespace-nowrap rounded bg-emerald-500/15 px-1.5 py-0.5 text-[11px] text-emerald-300" title="비정상 워크로드 0 이 연속 2회 확인된 시각(타임라인과 같은 기준)">
        <CircleCheck size={11} /> 복구 완료 {fmtClock(phase.at)}
      </span>
    )
  if (phase.kind === 'broken')
    return (
      <span className="inline-flex items-center gap-1 whitespace-nowrap rounded bg-amber-500/20 px-1.5 py-0.5 text-[11px] text-amber-200" title="복구 완료였다가 다시 비정상이 됐습니다. 다시 완료되기 전까지 미완입니다">
        <AlertTriangle size={11} /> 다시 비정상 · {fmtClock(phase.at)}부터
      </span>
    )
  if (phase.kind === 'recovering')
    return <span className="whitespace-nowrap rounded bg-sky-500/15 px-1.5 py-0.5 text-[11px] text-sky-200">복구 중</span>
  return null
}

/** 파드 표의 머리 숫자 — 진짜 비정상과 'NotReady 노드 위라 확인 불가' 를 나눈다(판정이 둘을 다르게 다루므로 표도 같이) */
function PodCounts({ p }: { p: PodStat }) {
  const unsure = p.unsureCount ?? 0
  const bad = p.abnormalCount - unsure
  return (
    <span className="text-[12px] text-gray-400">
      전체 {p.total}개
      {bad > 0 && <span className="text-amber-300"> · 비정상 {bad}</span>}
      {unsure > 0 && (
        <span className="text-gray-400" title="배치된 노드가 NotReady 라 실제 상태를 알 수 없는 파드: 복구 측정에서는 빼고, 종합 판정에서는 정상으로 치지 않습니다">
          {' '}
          · 확인 불가 {unsure}
        </span>
      )}
      {p.abnormalCount === 0 && <span className="text-emerald-300"> · 이상 없음</span>}
    </span>
  )
}

/** 파드 한 줄의 상태 배지 — 확인 불가 행은 회색으로(빨강·노랑은 진짜 비정상에만) */
function PodStatusPills({ pod }: { pod: PodRow }) {
  const unsure = !pod.healthy && pod.nodeNotReady
  return (
    <>
      <span
        className={
          'shrink-0 rounded-full px-2 py-0.5 text-[11px] ' +
          (pod.healthy ? 'bg-emerald-500/20 text-emerald-300' : unsure ? 'bg-white/10 text-gray-400' : podStatusCls(pod.status))
        }
      >
        {pod.status}
      </span>
      {pod.nodeNotReady && (
        <span
          title="배치된 노드가 Ready 가 아닙니다. 이 파드 상태는 낡은 값이라 확인 불가로 봅니다"
          className="shrink-0 rounded-full bg-white/10 px-2 py-0.5 text-[11px] text-gray-300"
        >
          노드 NotReady
        </span>
      )}
    </>
  )
}

// 네임스페이스 1개의 파드 상태 카드.
//  scope='abnormal': 비정상만(정상이면 '이상 없음') / 'all': 전체 파드(Running 은 초록)
function PodNsCard({
  p,
  scope,
  phase,
  onRemove,
  onExpand,
  logNew = 0,
  onLog,
}: {
  p: PodStat
  scope: 'abnormal' | 'all'
  phase: NsPhase
  onRemove: () => void
  onExpand: () => void
  /** 이 네임스페이스 파드 로그의 새 오류 묶음 수 — 파드가 다 Running 이어도 로그는 깨져 있을 수 있다(10-28) */
  logNew?: number
  onLog?: () => void
}) {
  // 조회를 못 한 것을 "✓ 이상 없음 · 0개" 로 그리면 안 된다 — 초록은 '확인했고 괜찮다'는 뜻이어야 한다
  const cleanEmpty = !p.unknown && scope === 'abnormal' && p.abnormalCount === 0
  return (
    <div className="group relative flex flex-col rounded-xl border border-white/10 bg-panel-light p-3.5">
      <div className="absolute right-1.5 top-1.5 flex items-center gap-0.5">
        <button
          onClick={onExpand}
          title="이 네임스페이스의 파드를 큰 창으로 보기(전체 이름 · 재시작 · 나이 · IP · 배정 실패 이유)"
          className="rounded p-0.5 text-gray-500 opacity-60 hover:bg-white/10 hover:text-gray-200 hover:opacity-100"
        >
          <Maximize2 size={13} />
        </button>
        <button
          onClick={onRemove}
          title="이 네임스페이스를 상태보드에서 제외 (역할 매핑에서 다시 추가 가능)"
          className="rounded p-0.5 text-gray-500 opacity-60 hover:bg-white/10 hover:text-gray-200 hover:opacity-100"
        >
          <X size={13} />
        </button>
      </div>
      <div className="mb-2 flex flex-wrap items-center gap-2 pr-12">
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
        ) : (
          <PodCounts p={p} />
        )}
        <NsPhaseBadge phase={phase} badNow={p.abnormalCount - (p.unsureCount ?? 0)} />
        {logNew > 0 && onLog && (
          <button
            onClick={onLog}
            title="이 네임스페이스 파드 로그에 감시를 켠 뒤 새로 생긴 오류 묶음 수(경고는 세지 않음). 누르면 목록"
            className="inline-flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-[11px] font-medium text-amber-200 hover:bg-amber-500/25"
          >
            <AlertTriangle size={11} /> 로그 새 오류 {logNew}
          </button>
        )}
      </div>
      {p.rows.length > 0 && (
        <div className="flex max-h-[220px] flex-col divide-y divide-white/5 overflow-y-auto pr-1">
          {p.rows.map((pod, i) => {
            const unsure = !pod.healthy && !!pod.nodeNotReady
            // 확인 불가 묶음은 맨 아래 — 그 시작에 구분줄을 둬 '여기부터는 상태를 믿을 수 없는 행' 임을 밝힌다
            const firstUnsure = unsure && !(i > 0 && !p.rows[i - 1].healthy && p.rows[i - 1].nodeNotReady)
            return (
            <Fragment key={i}>
            {firstUnsure && (
              <div className="py-1 text-center text-[10.5px] text-gray-500">── NotReady 노드 위 · 확인 불가 {p.unsureCount ?? 0} ──</div>
            )}
            {/* 한 줄 나열: 파드명(길면 말줄임+툴팁) · READY · 상태 · 배치 NODE */}
            <div className={'flex items-center gap-2 py-1 text-[12px] ' + (unsure ? 'opacity-70' : '')}>
              <span className="min-w-0 flex-1 truncate font-mono text-gray-100" title={pod.name}>
                {pod.name}
              </span>
              {pod.isNew && (
                <span className="shrink-0 rounded bg-sky-500/15 px-1 text-[10px] text-sky-200" title={`검증 시작 뒤 새로 뜬 파드(생성 ${pod.age ?? '?'} 전)`}>
                  새 파드
                </span>
              )}
              <span
                className={'shrink-0 font-mono text-[11px] ' + (pod.healthy ? 'text-gray-400' : 'text-red-300')}
                title="READY (준비된 컨테이너/전체)"
              >
                {pod.ready || '-'}
              </span>
              <PodStatusPills pod={pod} />
              <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-gray-400" title={pod.node}>
                <Server size={12} className="shrink-0" />
                <span className="max-w-[110px] truncate">{pod.node}</span>
              </span>
            </div>
            </Fragment>
            )
          })}
        </div>
      )}
    </div>
  )
}

/**
 * 네임스페이스 하나를 크게 — 카드에서는 이름이 잘리고(`ceph-service-api-69d…`) 재시작·나이를 볼 수 없어, 장애 중 파드 상태
 * 창을 따로 열어야 했다(사용자 요청). 보드가 받은 같은 데이터를 그대로 그리므로 1초마다 함께 바뀌고 조회가 늘지 않는다.
 * 늘어나는 조회는 **배정 안 된 Pending 파드가 있을 때의 이벤트 한 번(15초 간격)** 뿐이다 — 왜 못 뜨는지(노드 affinity·taint·
 * 자원 부족)가 장애 분석의 핵심인데 파드 목록에는 없다. 닫기는 X · 닫기 버튼으로만(모달 규칙).
 */
function PodNsModal({
  p,
  phase,
  podSession,
  onClose,
  logByPod,
  onLog,
}: {
  p: PodStat
  phase: NsPhase
  podSession?: string
  onClose: () => void
  /** 파드마다 새 로그 오류 묶음 수 — 로그 감시가 꺼져 있으면 없음(칸을 안 그린다) */
  logByPod?: Record<string, number>
  onLog?: () => void
}) {
  const [filter, setFilter] = useState<'all' | 'bad' | 'unsure'>('all')
  const [q, setQ] = useState('')
  /** 파드 이름 → 가장 최근 FailedScheduling 문구 */
  const [sched, setSched] = useState<Record<string, string>>({})
  const [schedAt, setSchedAt] = useState(0)
  const pendingUnplaced = p.rows.filter((r) => !r.healthy && /^Pending$/i.test(r.status)).length
  useEffect(() => {
    if (!podSession || pendingUnplaced === 0) return
    let alive = true
    const ns = p.namespace
    const fetchOnce = async () => {
      /**
       * 정렬을 kubectl(--sort-by=.lastTimestamp)에 맡기지 않는다 — 스케줄러는 events.k8s.io/v1 로 이벤트를 남겨 core 보기에서
       * lastTimestamp 가 비고 eventTime 만 있다. 그걸로 정렬하면 '가장 최근 이유' 대신 오래된 문구가 남았다(코드 검토 지적).
       * 두 시각을 다 받아 파드마다 늦은 쪽의 문구를 고른다.
       */
      const r = await run(
        podSession,
        `kubectl get events -n ${ns} --field-selector reason=FailedScheduling --no-headers -o custom-columns=OBJ:.involvedObject.name,LAST:.lastTimestamp,EVT:.eventTime,MSG:.message --request-timeout=5s 2>/dev/null`,
      )
      if (!alive || !r.ok || r.timedOut) return // 조회 실패면 직전 이유를 그대로 둔다(조회 실패 ≠ 이유 없음)
      const best: Record<string, { at: number; msg: string }> = {}
      for (const l of (r.out ?? '').split('\n')) {
        const t = l.trim().match(/^(\S+)\s+(\S+)\s+(\S+)\s+(.+)$/)
        if (!t || t[4] === '<none>') continue
        const at = Math.max(Date.parse(t[2]) || 0, Date.parse(t[3]) || 0)
        if (!best[t[1]] || at >= best[t[1]].at) best[t[1]] = { at, msg: t[4] }
      }
      const m: Record<string, string> = {}
      for (const [k, v] of Object.entries(best)) m[k] = v.msg
      setSched(m)
      setSchedAt(Date.now())
    }
    void fetchOnce()
    const t = setInterval(() => void fetchOnce(), 15_000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [podSession, p.namespace, pendingUnplaced > 0])
  const rows = p.rows.filter((r) => {
    if (filter === 'bad' && (r.healthy || r.nodeNotReady)) return false
    if (filter === 'unsure' && !(r.nodeNotReady && !r.healthy)) return false
    return !q.trim() || r.name.includes(q.trim())
  })
  const unsure = p.unsureCount ?? 0
  const bad = p.abnormalCount - unsure
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-8">
      <div className="flex h-[82vh] w-[1100px] max-w-[96vw] flex-col overflow-hidden rounded-lg border border-white/10 bg-panel shadow-2xl">
        <div className="flex flex-wrap items-center gap-2 border-b border-white/10 px-4 py-2.5">
          <Server size={15} className="text-blue-400" />
          <span className={'rounded px-2 py-0.5 font-mono text-[12px] ' + NS_TINT}>{p.namespace}</span>
          {p.unknown ? <span className="text-[12px] text-red-300">확인 불가: {p.note}</span> : <PodCounts p={p} />}
          <NsPhaseBadge phase={phase} badNow={bad} />
          <button onClick={onClose} title="닫기" className="ml-auto rounded p-1 text-gray-400 hover:bg-white/10 hover:text-gray-100">
            <X size={16} />
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-2 border-b border-white/10 px-4 py-2">
          {(
            [
              ['all', `전체 ${p.rows.length}`],
              ['bad', `비정상 ${bad}`],
              ['unsure', `확인 불가 ${unsure}`],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              onClick={() => setFilter(k)}
              className={
                'rounded border px-2 py-0.5 text-[11px] ' +
                (filter === k ? 'border-blue-500/40 bg-blue-500/15 text-blue-100' : 'border-white/10 text-gray-300 hover:bg-white/10')
              }
            >
              {label}
            </button>
          ))}
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="파드 이름 검색"
            className="ml-2 w-56 rounded border border-white/10 bg-black/20 px-2 py-0.5 text-[12px] text-gray-100 outline-none placeholder:text-gray-500 focus:border-blue-500/50"
          />
          <span className="ml-auto text-[11px] text-gray-500">
            보드와 같이 갱신됩니다{p.rows.length < p.total ? ` · 보드 표시 범위가 '비정상만' 이라 정상 파드 ${p.total - p.rows.length}개는 빠져 있습니다` : ''}
          </span>
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-4 py-2">
          <table className="w-full border-collapse text-[12px]">
            <thead className="sticky top-0 bg-panel text-left text-[11px] text-gray-500">
              <tr>
                <th className="py-1.5 pr-3 font-normal">이름</th>
                <th className="py-1.5 pr-3 font-normal">Ready</th>
                <th className="py-1.5 pr-3 font-normal">상태</th>
                <th className="py-1.5 pr-3 font-normal">재시작</th>
                <th className="py-1.5 pr-3 font-normal">나이</th>
                <th className="py-1.5 pr-3 font-normal">IP</th>
                <th className="py-1.5 pr-3 font-normal">노드</th>
                {logByPod && <th className="py-1.5 font-normal" title="감시를 켠 뒤 새로 생긴 로그 오류 · 경고 묶음 수">로그</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {rows.map((pod) => (
                <Fragment key={pod.name}>
                  <tr className={!pod.healthy && pod.nodeNotReady ? 'opacity-70' : ''}>
                    {/* 이름 · '새 파드' 는 한 줄로 — 표가 칸 폭을 내용에 맞춰 나누다 보니 상태 칸(알약 두 개)에 밀려 이름 칸이 좁아지고
                        배지가 '새 파 / 드' 로 쪼개졌다(10-28). 대신 재시작 칸을 두 줄로 줄이고, 그래도 넘치면 표가 가로로 스크롤된다 */}
                    <td className="whitespace-nowrap py-1 pr-3 font-mono text-gray-100">
                      {pod.name}
                      {pod.isNew && <span className="ml-1.5 inline-block whitespace-nowrap rounded bg-sky-500/15 px-1 font-sans text-[10px] text-sky-200">새 파드</span>}
                    </td>
                    <td className={'py-1 pr-3 font-mono ' + (pod.healthy ? 'text-gray-400' : 'text-red-300')}>{pod.ready || '-'}</td>
                    <td className="py-1 pr-3">
                      <span className="inline-flex items-center gap-1 whitespace-nowrap">
                        <PodStatusPills pod={pod} />
                      </span>
                    </td>
                    <td className="whitespace-nowrap py-1 pr-3 text-gray-300">
                      {(() => {
                        // kubectl 의 '7 (75m ago)' — 횟수 아래에 언제인지를 작게(한 줄이면 이 칸이 이름 칸 폭을 가져갔다)
                        const m = /^(\d+)\s*\((.+?)\s+ago\)$/.exec(pod.restarts ?? '')
                        if (!m) return pod.restarts ?? '-'
                        return (
                          <>
                            {m[1]}
                            <span className="block text-[10px] leading-tight text-gray-500">{m[2]} 전</span>
                          </>
                        )
                      })()}
                    </td>
                    <td className="whitespace-nowrap py-1 pr-3 text-gray-300">{pod.age ?? '-'}</td>
                    <td className="whitespace-nowrap py-1 pr-3 font-mono text-gray-400">{pod.ip && pod.ip !== '<none>' ? pod.ip : '-'}</td>
                    <td className="whitespace-nowrap py-1 pr-3 text-gray-300">{pod.node}</td>
                    {logByPod && (
                      <td className="whitespace-nowrap py-1">
                        {logByPod[pod.name] ? (
                          <button onClick={onLog} className="rounded bg-amber-500/15 px-1.5 text-[11px] text-amber-200 hover:bg-amber-500/25">
                            새 오류 {logByPod[pod.name]}
                          </button>
                        ) : (
                          <span className="text-gray-600">-</span>
                        )}
                      </td>
                    )}
                  </tr>
                  {sched[pod.name] && /^Pending$/i.test(pod.status) && (
                    <tr>
                      <td colSpan={8} className="pb-1.5 pl-4 text-[11px] text-amber-200/90">
                        ↳ 배정 안 됨: {sched[pod.name]}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={8} className="py-6 text-center text-gray-500">
                    해당하는 파드가 없습니다
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="flex items-center gap-2 border-t border-white/10 px-4 py-2 text-[11px] text-gray-500">
          {pendingUnplaced > 0 &&
            (podSession
              ? `Pending 파드의 배정 실패 이유는 FailedScheduling 이벤트에서 15초마다 읽습니다${schedAt ? ` · ${fmtClock(schedAt)} 기준` : ''}`
              : '파드 세션이 연결돼 있지 않아 배정 실패 이유를 읽지 못합니다')}
          <button onClick={onClose} className="ml-auto rounded border border-white/10 px-3 py-1 text-[12px] text-gray-200 hover:bg-white/10">
            닫기
          </button>
        </div>
      </div>
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
  unknown: ['bg-white/5 text-gray-500', '-'],
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
    return { label: 'active (DC)', title: `pacemaker DC: 클러스터 결정을 내리는 노드 (${roles.dc})`, abnormal: false }
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
  const where = `pacemaker 리소스 ${res.name}: ${res.owners.join(', ')} 에서 실행`
  if (isOwner) return state === 'active' ? { label: 'active (m)', title: where, abnormal: false } : undefined
  if (isStandby) return state === 'active' ? { label: 'active (s)', title: `${where} · 이 노드는 보조`, abnormal: false } : undefined
  if (!inCluster) return undefined
  if (state === 'inactive') return { label: '대기 (s)', cls: ROLE_STANDBY_CLS, title: `${where} · 이 노드는 대기(정상)`, abnormal: false }
  if (state === 'active')
    return {
      label: 'active ?',
      cls: 'bg-amber-500/15 text-amber-300',
      title: `${where}이라고 pcs 가 보고했는데 이 노드에서도 active 입니다. 전환 중이거나 두 곳에서 도는 중일 수 있습니다`,
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
          role={{ label: r.standbys.length ? 'Promoted (m)' : '실행 (m)', title: `${r.name} (${r.agent || 'clone'}): ${r.state}`, abnormal: false }}
        />
      )
    if (r.standbyIds.includes(n.id))
      return <SvcCell key={n.id} state="active" role={{ label: 'Unpromoted (s)', cls: ROLE_STANDBY_CLS, title: `${r.name} 보조`, abnormal: false }} />
    if (roles?.clusterIds.includes(n.id))
      return <SvcCell key={n.id} state="unknown" role={{ label: '대기 (s)', cls: ROLE_STANDBY_CLS, title: `${r.name} 은 ${r.owners.join(', ')} 에서 실행: 이 노드는 대기`, abnormal: false }} />
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
                pacemaker 리소스{roles?.staleSec ? ` (pcs 응답 없음, ${roles.staleSec}초 전 역할)` : ''}
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
            조회 실패로 <b className="text-gray-300">직전 값</b>을 표시 중: {' '}
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
          <LegendChip cls={SVC_CELL.unknown[0]} label="-" text="조회 실패" />
        </div>
        {roles && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="text-gray-400">pacemaker 역할</span>
            <LegendChip cls={SVC_CELL.active[0]} label="(m)" text="이 노드에서 실행" />
            <LegendChip cls={ROLE_STANDBY_CLS} label="(s)" text="대기: 멈춰 있는 게 정상" />
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
      title={(s.up ? 'up (작동 중)' : 'down (응답 없음)') + (s.enabled ? '' : ' · disabled: 관리상 중지(evacuation 중 정상적으로 발생)')}
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
              title="서비스가 응답하지 않습니다 (State/Alive down): 실제 장애"
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
            <span>{os.errors.join(' · ')}: rc 경로·권한, openstack CLI 설치를 확인하세요.</span>
          </div>
        )}
        {/* 실패를 빈 결과로 반영하면 행·열이 사라져 '서비스가 없어졌다' 로 읽힌다 — 값은 지키고 사실만 밝힌다 */}
        {os.stale.length > 0 && (
          <div className="mb-2 flex items-start gap-1.5 rounded-md bg-white/[0.04] px-2.5 py-1 text-[11px] text-gray-400">
            <RefreshCw size={12} className="mt-0.5 shrink-0" />
            <span>
              이번 주기 조회 실패: <b className="text-gray-300">{os.stale.join(' · ')}</b> 값을 그대로 표시하고 있습니다.
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

function SectionLabel({ n, text, right, help }: { n: number; text: string; right?: ReactNode; help?: string }) {
  return (
    <div className="mb-1.5 flex items-center gap-1.5 text-[13px] text-gray-300">
      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-blue-600/40 text-[11px] text-blue-100">{n}</span>
      {text}
      {help && (
        <span title={help} className="cursor-help text-gray-500 hover:text-gray-300">
          <HelpCircle size={13} />
        </span>
      )}
      {right && <span className="ml-auto shrink-0">{right}</span>}
    </div>
  )
}
/**
 * 타임라인 줄의 종류 — 왼쪽 색 띠와 '지금' 배지 색. 빨강 = 장애·끊김, 초록 = 복구, 노랑 = 진행 중·다시 비정상, 회색 = 그 밖.
 * 아이콘 색만으로는 종류가 섞여 읽혔다(사용자 지적 — 안 C).
 */
type TlTone = 'bad' | 'ok' | 'wip' | 'info'
const TL_BORDER: Record<TlTone, string> = {
  bad: 'border-red-500/60',
  ok: 'border-emerald-500/50',
  wip: 'border-amber-400/60',
  info: 'border-white/15',
}
/**
 * 아이콘 색 — 줄 왼쪽 막대와 같은 tone 하나로 칠한다(사용자 결정 10-27). 예전엔 아이콘마다 종류별 색(VIP 파랑 · 파드 하늘 · 포털 보라 …)이라
 * 타임라인이 형형색색이었고, 색이 '종류' 인지 '결과' 인지 섞여 읽혔다. 종류는 아이콘 모양이 말하고, 색은 결과만 말한다:
 * 회색 = 정보 · 시작 · 최종이 아닌 중간 결과, 빨강 = 장애 · 실패, 초록 = 완료, 노랑 = 지켜볼 것(다시 비정상 · 재시도 대기 · 경고 남음).
 */
const TL_ICON: Record<TlTone, string> = {
  bad: 'text-red-400',
  ok: 'text-emerald-400',
  wip: 'text-amber-400',
  info: 'text-gray-400',
}
const TL_PILL: Record<Exclude<TlTone, 'info'>, string> = {
  bad: 'bg-red-500/20 text-red-300',
  ok: 'bg-emerald-500/15 text-emerald-300',
  wip: 'bg-amber-500/20 text-amber-200',
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
  tone,
  muted,
  tag,
  onToggle,
  open,
  compact,
  child,
}: {
  /** 묶음의 하위 줄 — 들여 써서 작게 */
  child?: boolean
  at: number
  t0: number
  icon: React.ReactNode
  text: string
  sub?: string
  /** 서버 기록 시각 배지 — 있으면 본문 아래 줄에 따로 단다 */
  server?: string
  tone: TlTone
  /** 뒤에 다시 깨져 '최종' 이 아닌 줄 — 글씨만 회색(흐림 처리는 읽기 힘들었다) */
  muted?: boolean
  /** 다시 깨진 사실(↻ n분 뒤 다시 끊김) — 줄 끝이 아니라 **다음 줄**에 둔다(줄 끝에 붙이니 설명과 섞였다) */
  tag?: string
  /** 접힌 흔들림 묶음의 머리 줄 — 누르면 펼친다 */
  onToggle?: () => void
  open?: boolean
  /** 지난 회차를 볼 때는 시:분:초만으로 언제 일인지 알 수 없으므로 날짜까지 표기 */
  showDate?: boolean
  /** 이 줄의 증적(서버 원문) 열기 — 저장된 증적이 있을 때만 */
  onEvidence?: () => void
  /**
   * 요약 보기 — 시각 · 경과 · 한 문장만(사용자 결정 안 1). 설명 줄 · 꼬리표 · 서버 기록 · 증적은 전체 보기에만 둔다.
   * 요약에도 다 달았더니 줄마다 두세 줄이 되어 '요약' 이 아니었다.
   */
  compact?: boolean
  /*
   * 줄 오른쪽 '지금' 상태 배지 열(정상 · 복구 중 · 복귀 · 실패 · 이동 완료)은 없앴다(사용자 결정 10-27). 초록 배지는 줄 문장과
   * 같은 말이고, 안 끝난 것은 맨 위 '아직 안 끝남' 칩이 이미 보여 준다. 대상의 마지막 줄에만 붙어 그 시각의 상태로 읽히기도 했다.
   * 다시 만들지 말 것: 지난 회차에서 먼저 뺐고(군더더기), 검증 중 전체 보기에만 남겼던 것도 같은 이유로 뺐다.
   */
}) {
  return (
    <div className={'flex items-start gap-2.5 border-l-[3px] pl-2 ' + (child ? 'py-0.5 text-[12px] ' : 'py-1 ') + TL_BORDER[tone]}>
      <span
        className={
          'shrink-0 whitespace-nowrap tabular-nums ' +
          (child ? 'text-gray-400 ' : 'font-medium text-gray-100 ') +
          (showDate ? 'w-[140px]' : 'w-[62px]')
        }
      >
        {showDate ? fmtDateTime(at) : fmtClock(at)}
      </span>
      <span className="w-[46px] shrink-0 whitespace-nowrap pt-px text-[11px] text-gray-500 tabular-nums">+{fmtElapsed(at - t0)}</span>
      <span className={'shrink-0 translate-y-0.5 ' + TL_ICON[tone]}>{child ? <span className="inline-block w-[13px]" /> : icon}</span>
      <span className={'min-w-0 flex-1 ' + (child ? 'pl-2 text-gray-400' : muted ? 'text-gray-400' : 'text-gray-200')}>
        {onToggle ? (
          <button onClick={onToggle} className="text-left text-amber-200 hover:underline" title={open ? '접기' : '펼쳐서 중간 과정 보기'}>
            {text} {open ? '▾' : '▸'}
          </button>
        ) : (
          text
        )}
        {!compact && sub && <span className="block text-[11px] text-gray-500">{sub}</span>}
        {!compact && tag && <span className="block text-[11px] text-amber-300/90">{tag}</span>}
        {!compact && server && (
          <span className="mt-0.5 block">
            <span
              className="inline-flex items-center gap-1 rounded bg-emerald-500/10 px-1.5 py-px text-[10.5px] text-emerald-300/90"
              title="서버(pacemaker · k8s)가 스스로 기록한 시각: 판정에는 쓰지 않고 근거로 나란히 보여 줍니다"
            >
              <Server size={10} /> {server}
            </span>
          </span>
        )}
      </span>
      {/* 칸 폭은 버튼이 한 줄로 들어가게 — 46px 일 때 '증적' 이 두 줄로 꺾였다(사용자 지적) */}
      {!compact && (
      <span className="w-[60px] shrink-0 text-right">
        {onEvidence && (
          <button
            onClick={onEvidence}
            title="이 시각의 근거가 된 서버 원문(로그·pacemaker 기록·k8s 기록) 보기"
            className="inline-flex items-center gap-1 whitespace-nowrap rounded border border-white/10 px-1.5 py-0.5 text-[10.5px] text-gray-300 hover:bg-white/10"
          >
            <FileText size={11} /> 증적
          </button>
        )}
      </span>
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
  tone: TlTone
  /** 어떤 대상의 줄인가 — 대상마다 마지막 줄에 '지금' 배지를 단다(timelineStatus 의 key) */
  target?: string
  /** 뒤에 다시 깨져 최종이 아닌 줄 */
  muted?: boolean
  /** 다시 깨진 사실 꼬리표 */
  tag?: string
  /** 접힘 묶음에 속한 줄 — 그 묶음이 펼쳐졌을 때만 화면에 보인다(내보내기에는 늘 들어간다) */
  fold?: string
  /** 접힘 묶음의 머리 줄(화면 전용 — 내보내기에서는 뺀다) */
  foldHead?: string
  /** 요약 보기에만 / 전체 보기에만 있는 줄 */
  only?: 'summary' | 'full'
  /** 묶음의 하위 줄(들여 써서 작게, 아이콘 · 증적 버튼 없이) — 전체 보기의 포털 정상화 묶음 */
  child?: boolean
  /** 정렬 시각(없으면 at) · 같은 시각 안 순서 — 하위 줄을 머리 줄 바로 아래에 두려고(하위 줄 시각은 머리보다 이르다) */
  sortAt?: number
  ord?: number
}
/**
 * 같은 대상이 **재장애(완료 → 다시 깨짐)를 이만큼 이상** 겪으면 중간 과정을 한 줄로 접는다(사용자 결정 3회).
 * 1~2회는 펼쳐도 몇 줄이고, 그보다 많으면 VIP·파드 같은 다른 사건을 가린다. 접힌 줄은 눌러서 펼친다.
 */
const FLAP_FOLD_MIN = 3
/** 포털 판정 기록 상한 — 바뀐 순간만이라 보통 수십 줄. 끝없이 흔들리는 회차가 이력(localStorage)을 채우지 않게 */
const PORTAL_LOG_MAX = 400
/** 같은 사건으로 묶을 시각 폭 — 포털 페이지들은 같은 폴링에서 확정돼도 대상마다 ms 가 다르다 */
const SAME_EVENT_MS = PORTAL_SAME_MS
/** 요약 보기에서 '다시 비정상 → 금방 다시 완료' 를 한 줄로 합치는 폭 — 이보다 짧게 깨졌다 돌아온 것은 한 사건으로 읽는 편이 낫다 */
const QUICK_FLAP_MS = 60_000
/** 시각순 목록을 SAME_EVENT_MS 안에 붙은 것끼리 묶는다 */
function clusterByTime<T extends { at: number }>(list: T[]): T[][] {
  const sorted = [...list].sort((a, b) => a.at - b.at)
  const out: T[][] = []
  for (const x of sorted) {
    const g = out[out.length - 1]
    if (g && x.at - g[g.length - 1].at <= SAME_EVENT_MS) g.push(x)
    else out.push([x])
  }
  return out
}

/**
 * 대상별 '지금'(지난 회차면 '기록이 끝날 때') 상태 — 타임라인 줄의 오른쪽 배지와 맨 위 '아직 안 끝남' 칩이 같은 것을 쓴다.
 * 마일스톤만으로 계산한다(화면 상태를 쓰면 지난 회차를 그릴 수 없다).
 */
function timelineStatus(m: Milestones, t0: number): Map<string, { tone: Exclude<TlTone, 'info'>; text: string; name: string }> {
  const s = new Map<string, { tone: Exclude<TlTone, 'info'>; text: string; name: string }>()
  if (m.down && m.down.source !== 'pre')
    s.set('host', m.reconnect || (m.rejoin ?? []).length ? { tone: 'ok', text: '복귀', name: '호스트' } : { tone: 'bad', text: 'DOWN', name: '호스트' })
  if (m.vip) s.set('vip', { tone: 'ok', text: '이동 완료', name: 'VIP' })
  // k8s 노드 — NotReady 가 된 뒤 Ready 가 안 온 노드
  const nr = new Map<string, number>()
  for (const x of m.k8sNotReady ?? []) for (const n of x.nodes) nr.set(n, Math.max(nr.get(n) ?? 0, x.at))
  for (const r of m.k8sReady ?? []) if ((nr.get(r.node) ?? Infinity) <= r.at) nr.delete(r.node)
  if ((m.k8sNotReady ?? []).length)
    s.set('k8s', nr.size ? { tone: 'bad', text: `NotReady ${nr.size}`, name: 'k8s 노드' } : { tone: 'ok', text: '모두 Ready', name: 'k8s 노드' })
  const lastFail = [...(m.masakariFail ?? [])].sort((a, b) => a.at - b.at).pop()
  if (m.masakari) s.set('masakari', { tone: 'ok', text: '완료', name: 'Masakari' })
  else if (lastFail)
    s.set('masakari', lastFail.status === 'failed' ? { tone: 'bad', text: '실패', name: 'Masakari' } : { tone: 'wip', text: '재시도 대기', name: 'Masakari' })
  if (m.podsDone !== undefined) {
    const nss = new Set([...(m.pods ?? []).map((p) => p.ns), ...(m.podsBroken ?? []).map((p) => p.ns)])
    for (const ns of nss) {
      const { done, broken } = nsPodTimes(m, ns)
      s.set(
        `pods:${ns}`,
        broken > done ? { tone: 'wip', text: '다시 비정상', name: ns } : done ? { tone: 'ok', text: '완료', name: ns } : { tone: 'wip', text: '복구 중', name: ns },
      )
    }
    if (nss.size) {
      const pend = podsDoneSummary(m).pending
      s.set('pods', pend ? { tone: 'wip', text: `미완 ${pend}개 ns`, name: '파드' } : { tone: 'ok', text: '모두 완료', name: '파드' })
    }
  }
  if ((m.portal ?? []).length || (m.portalFlaps ?? []).length || (m.portalPending ?? []).length) {
    const pend = (m.portalPending ?? []).length
    s.set('portal', pend ? { tone: 'bad', text: `끊김 ${pend}`, name: '포털' } : { tone: 'ok', text: '정상', name: '포털' })
  }
  if (m.cephHealthy) s.set('ceph', { tone: 'ok', text: 'HEALTH_OK', name: 'Ceph' })
  else if (m.ceph) s.set('ceph', { tone: 'wip', text: '경고 남음', name: 'Ceph' })
  if (m.reconnect || (m.rejoin ?? []).length || m.osdUp) s.set('node', { tone: 'ok', text: '복귀', name: '노드 복귀' })
  void t0
  return s
}

/**
 * 복구 타임라인 — 검증 시작 → 노드 DOWN → VIP 이동 → evacuation → 파드 → Ceph → 세션 재연결.
 * 마일스톤을 절대시각으로 들고 있으므로 시:분:초와 경과를 함께 보여준다.
 * 화면 타임라인과 회차 내보내기(Markdown)가 같은 줄을 쓴다 — 둘이 다른 내용을 말하면 안 된다.
 *
 * `view` — 요약(기본)은 핵심 마일스톤만 남기고 비슷한 줄을 묶는다(사용자 결정 — 네임스페이스마다 시작·완료, 노드마다 Ready 가
 * 찍혀 30줄이 넘었다). 다시 비정상·미완인 것은 요약에서도 접지 않는다 — 봐야 할 것이니까. 전체는 예전처럼 다 보인다.
 */
function buildTimelineRows(m: Milestones, t0: number, view: 'summary' | 'full' = 'full'): TimelineItem[] {
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
  for (const d of m.podsDone ?? []) if (d.at >= (doneByNs.get(d.ns) ?? 0)) doneByNs.set(d.ns, d.at)
  /**
   * 예전에 저장된 이력에는 podsDone 자체가 없다(필드가 생기기 전 회차).
   * 그 회차는 예전 방식 그대로 한 줄로 그린다 — 지난 기록의 모양이 바뀌면 비교가 안 된다.
   */
  const legacyPods = m.podsDone === undefined
  const rows: TimelineItem[] = [
    { at: t0, icon: <Play size={13} />, text: '검증 시작', tone: 'info' },
  ]
  if (m.inject)
    rows.push({
      at: m.inject.at,
      icon: <Bolt size={13} />,
      text: m.inject.source === 'manual' ? '장애 주입 (수동 입력)' : '장애 주입 (버튼)',
      tone: 'info',
      target: 'inject',
      sub:
        m.inject.source === 'manual'
          ? `${m.inject.note ? `${m.inject.note} · ` : ''}BMC 시계 기준일 수 있음`
          : m.down && m.down.source !== 'pre'
            ? `DOWN 감지까지 ${fmtElapsed(Math.max(0, m.down.at - m.inject.at))}`
            : undefined,
    })
  if (m.down) {
    // DOWN 시각은 서버 기록(클러스터 저널 이탈)이 믿을 만하면 그것 — downBaseOf 주석(사용자 결정 (a))
    const base = downBaseOf(m, t0)
    rows.push({
      at: base?.at ?? m.down.at,
      icon: <Bolt size={13} />,
      text: m.down.source === 'pre' ? `호스트 DOWN: ${m.down.node} (검증 시작 전부터)` : `호스트 DOWN: ${m.down.node}`,
      tone: 'bad',
      target: 'host',
      sub: base?.server
        ? `클러스터 저널 이탈 기준 · Q-Term 감지 ${fmtClock(m.down.at)} (+${Math.round((m.down.at - base.at) / 1000)}초, ${m.down.source === 'pcs' ? 'pcs OFFLINE' : 'SSH 끊김'})`
        : m.down.source === 'pcs'
          ? '(pcs OFFLINE 기준)'
          : m.down.source === 'ssh'
            ? '(SSH 끊김 기준 · 최대 90초 늦을 수 있음)'
            : '(DOWN 시각 불명: 검증 시작 시점으로 표기)',
      server: !base?.server && m.down.srvAt ? `클러스터 저널 이탈 ${fmtClock(m.down.srvAt)}` : undefined,
      ev: m.down.source === 'pre' ? undefined : 'down',
    })
  }
  if (m.vip) {
    const v = vipAtOf(m)
    rows.push({
      at: v.at,
      icon: <MapPin size={13} />,
      text: `VIP 이동: ${m.vip.from} → ${m.vip.to}`,
      tone: 'ok',
      target: 'vip',
      sub: [
        m.vip.with?.length ? `함께 이동: ${m.vip.with.join(', ')}` : '',
        v.server ? `pacemaker 기록 기준 · Q-Term 감지 ${fmtClock(m.vip.at)}` : '',
      ]
        .filter(Boolean)
        .join(' · ') || undefined,
      server: !v.server && m.vip.pcmkAt ? `pacemaker 기록 start ${fmtClock(m.vip.pcmkAt)}` : undefined,
      ev: 'vip',
    })
  }
  for (const r of m.roles ?? [])
    rows.push({
      at: r.at,
      icon: <MapPin size={13} />,
      text: `역할 이동: ${r.name}: ${r.from} → ${r.to}`,
      tone: 'info',
      target: 'roles',
      sub: '(pcs status 기준 · (m) 이 바뀐 순간)',
      ev: `roles:${r.at}`,
      only: 'full',
    })
  if (m.masakari)
    rows.push({
      at: m.masakari.at,
      icon: <CircleCheck size={13} />,
      /**
       * `by` 는 **masakari-engine 로그를 읽은 호스트**다 — VM 이 옮겨 간 호스트가 아니다.
       * 예전에는 `evacuation 완료 — con1` 처럼 노드명이 앞에 붙어, 'con1 으로 이동했다' 로
       * 읽히기 쉬웠다. 대수를 앞으로 빼고, 노드명은 '로그 출처' 라고 못박아 뒤로 보낸다.
       */
      text: `Masakari evacuation 완료${m.masakari.evac > 0 ? ` · ${m.masakari.evac}대` : ''}`,
      tone: 'ok',
      target: 'masakari',
      sub: `${m.masakari.by} 의 masakari-engine 로그 기준 (이동 대상 호스트 아님)`,
      server: m.masakari.vms
        ? `Nova VM ${m.masakari.vms.count}대 · 첫 시작 ${fmtClock(m.masakari.vms.firstAt)} → 마지막 완료 ${fmtClock(m.masakari.vms.lastAt)}${m.masakari.vms.failed ? ` · 실패 ${m.masakari.vms.failed}` : ''}`
        : undefined,
      ev: 'masakari',
    })
  /**
   * error(1차 시도 실패)와 failed(최종 실패)를 다른 말로 — 예전엔 둘 다 같은 영어 사유를 달아 같은 일이 두 번 찍힌 것처럼
   * 보였고, 요약 보기엔 노드 배지가 없어 어느 엔진 얘기인지도 몰랐다(사용자 지적 10-27). 노드명을 문장에 넣고, 사유는
   * 요약 한 줄에 들어가는 짧은 꼴(brief)을 쓴다. 'evacuation 실패' 라고 쓰지 않는다: VM 을 옮기기 전 단계에서 멈춘 것도 그렇게 읽혔다.
   */
  const masaFails = [...(m.masakariFail ?? [])].sort((a, b) => a.at - b.at)
  for (const f of masaFails) {
    const why = f.brief ?? f.reason ?? (f.evac > 0 ? `${f.evac}대 시도` : '')
    // 이 뒤에 다른 결과(재시도 실패 · 완료)가 찍혔으면 이 error 는 넘겨진 것
    const handed = masaFails.some((x) => x.at > f.at) || (!!m.masakari && m.masakari.at > f.at)
    const retried = masaFails.some((x) => x.at < f.at && x.status !== 'failed')
    rows.push({
      at: f.at,
      ev: `masakariFail:${f.at}`,
      icon: <CircleX size={13} />,
      text:
        f.status === 'failed'
          ? `Masakari 최종 실패: ${f.by}${retried ? ' 재시도도 실패' : ''}${why ? ` · ${why}` : ''}`
          : `Masakari 1차 시도 실패: ${f.by} · ${handed ? '재시도로 넘어감' : '재시도 대기'}`,
      // 넘겨진 1차 실패는 결과가 아니다(최종 결과는 뒤 줄) — 회색. 아직 넘겨지지 않았으면 지켜볼 것이라 노랑
      tone: f.status === 'failed' ? 'bad' : handed ? 'info' : 'wip',
      target: 'masakari',
      sub:
        f.status === 'failed'
          ? `${f.reason && f.reason !== why ? `${f.reason} · ` : ''}${f.by} 의 masakari-engine 로그 기준 · 사람이 확인해야 합니다(호스트가 maintenance 로 남음)`
          : `${f.reason ? `${f.reason} · ` : ''}${f.by} 의 masakari-engine 로그 기준 (status: ${f.status}) · masakari 가 한 번 더 시도함`,
    })
  }
  /** 네임스페이스별 '다시 비정상' — 시각순 */
  const brokenByNs = new Map<string, { at: number; workloads: string[] }[]>()
  for (const x of m.podsBroken ?? []) brokenByNs.set(x.ns, [...(brokenByNs.get(x.ns) ?? []), x])
  /**
   * 요약 보기의 파드 — 네임스페이스마다 '시작 · 완료' 두 줄씩이면 13개 ns 에 26줄이었다. 처음 시작 한 줄 + 모두 끝난 한 줄로 묶고,
   * 흔들린(다시 비정상) 네임스페이스만 따로 남긴다. 아직 안 끝난 ns 는 '파드' 줄의 지금 배지와 맨 위 칩이 짚는다.
   */
  if (!legacyPods && podByNs.size && view === 'summary') {
    const firsts = [...podByNs.entries()].sort((a, b) => a[1].first - b[1].first)
    rows.push({
      at: firsts[0][1].first,
      icon: <Server size={13} />,
      text: `파드 복구 시작: ${podByNs.size}개 네임스페이스`,
      tone: 'info',
      target: 'pods',
      sub: `첫 복구 ${firsts[0][0]} · ${firsts[0][1].sample}`,
      only: 'summary',
    })
    const pend = podsDoneSummary(m).pending
    if (!pend && doneByNs.size) {
      const lastNs = [...doneByNs.entries()].sort((a, b) => b[1] - a[1])[0]
      rows.push({
        at: lastNs[1],
        icon: <Server size={13} />,
        text: `파드 복구 모두 완료: ${doneByNs.size}개 네임스페이스`,
        tone: 'ok',
        target: 'pods',
        sub: `가장 늦은 ${lastNs[0]}`,
        ev: `pods:${lastNs[0]}`,
        only: 'summary',
      })
    }
  }
  for (const [ns, v] of podByNs) {
    const detail = v.count > 1 ? `워크로드 ${v.count}개 (${v.sample} 외)` : v.sample
    if (legacyPods) {
      // 옛 회차 — 완료 시각을 알 수 없어 '마지막으로 관측된 복구' 를 그대로 쓴다
      rows.push({
        at: v.last,
        icon: <Server size={13} />,
        text: `${ns} 파드 복구 완료`,
        tone: 'ok',
        sub: detail,
      })
      continue
    }
    const done = doneByNs.get(ns)
    const brokens = (brokenByNs.get(ns) ?? []).sort((a, b) => a.at - b.at)
    // 요약에서는 흔들리지 않은 네임스페이스를 위의 묶음 두 줄에 맡긴다
    if (view === 'summary' && !brokens.length) continue
    if (view === 'full')
      rows.push({
        at: v.first,
        icon: <Server size={13} />,
        text: `${ns} 파드 복구 시작`,
        tone: 'info',
        target: `pods:${ns}`,
        sub: done ? `첫 복구 ${v.sample}` : `아직 완료 아님: 워크로드 ${v.count}개 복구됨`,
      })
    /**
     * 완료 → 다시 비정상 → 완료 … 를 지우지 않고 다 적는다. 뒤에 다시 깨진 완료는 회색 글씨에 '↻ 다시 비정상' 꼬리표를,
     * 마지막 완료는 '최종' 으로. 마지막이 '다시 비정상' 이면 그 네임스페이스는 미완이다(podsDoneSummary 와 같은 기준).
     */
    const dones = (m.podsDone ?? []).filter((d) => d.ns === ns).sort((a, b) => a.at - b.at)
    const lastDone = dones[dones.length - 1]
    const lastBroken = brokens[brokens.length - 1]
    const endsBroken = !!lastBroken && (!lastDone || lastBroken.at > lastDone.at)
    const foldKey = brokens.length >= FLAP_FOLD_MIN ? `pods:${ns}` : undefined
    const nsRows: TimelineItem[] = []
    /**
     * 요약 보기 — 다시 비정상이 됐다가 QUICK_FLAP_MS 안에 다시 완료되면 한 줄로 합친다('다시 비정상 → 17초 뒤 다시 완료').
     * 안 C 목업에서 정한 모양이다. 전체 보기는 두 줄 그대로.
     */
    const merged = new Set<(typeof dones)[number]>()
    // '다시 비정상' 기록이 없으면(그 기능 전의 회차 포함) 예전처럼 마지막 완료 한 줄만 — 그때는 완료가 여러 번 남아도 사이에
    // 무슨 일이 있었는지 모르므로 늘어놓지 않는다
    for (const b of brokens) {
      const isLast = b === lastBroken && endsBroken
      const back = view === 'summary' ? dones.find((d) => d.at > b.at && d.at - b.at <= QUICK_FLAP_MS) : undefined
      if (back) merged.add(back)
      const nb = back ? brokens.find((x) => x.at > back.at) : undefined
      nsRows.push({
        at: b.at,
        icon: <AlertTriangle size={13} />,
        text: back
          ? `${ns} 파드 다시 비정상 → ${fmtElapsed(back.at - b.at)} 뒤 다시 완료`
          : `${ns} 파드 다시 비정상: 워크로드 ${b.workloads.length}개`,
        // 금방 돌아왔지만 뒤에 또 깨진 줄(muted)은 결과가 아니라 회색
        tone: back && back === lastDone && !endsBroken ? 'ok' : back ? 'info' : 'wip',
        target: `pods:${ns}`,
        sub: `${b.workloads.slice(0, 3).join(', ')}${b.workloads.length > 3 ? ' 외' : ''}${isLast ? ' · 아직 복구 안 됨' : ''}`,
        tag: nb ? `↻ ${fmtElapsed(nb.at - (back as { at: number }).at)} 뒤 다시 비정상` : undefined,
        muted: !!back && !(back === lastDone && !endsBroken),
        fold: !isLast && foldKey ? foldKey : undefined,
      })
    }
    for (const d of brokens.length ? dones : dones.slice(-1)) {
      if (merged.has(d)) continue
      const nb = brokens.find((b) => b.at > d.at)
      const isFinal = d === lastDone && !endsBroken
      nsRows.push({
        at: d.at,
        icon: <Server size={13} />,
        text: isFinal && brokens.length ? `${ns} 파드 최종 복구 완료` : `${ns} 파드 복구 완료`,
        // 뒤에 다시 깨진 완료는 최종 결과가 아니다 — 초록으로 칠하면 '끝났다' 로 읽힌다
        tone: isFinal ? 'ok' : 'info',
        target: `pods:${ns}`,
        sub: isFinal && brokens.length ? `재장애 ${brokens.length}회 뒤 · ${detail}` : detail,
        server: d.readyAt ? `클러스터 기록 Ready ${fmtClock(d.readyAt)}` : undefined,
        // 증적은 네임스페이스마다 마지막 완료 때 떠 둔 것 하나다
        ev: d === lastDone ? `pods:${ns}` : undefined,
        muted: !isFinal,
        tag: nb ? `↻ ${fmtElapsed(nb.at - d.at)} 뒤 다시 비정상` : undefined,
        fold: !isFinal && foldKey ? foldKey : undefined,
      })
    }
    if (foldKey) {
      const folded = nsRows.filter((r) => r.fold)
      if (folded.length) {
        const lo = Math.min(...folded.map((r) => r.at))
        const hi = Math.max(...folded.map((r) => r.at))
        rows.push({
          at: lo,
          icon: <AlertTriangle size={13} />,
          text: `${ns} 파드 흔들림 ${brokens.length}회 (${fmtClock(lo)} ~ ${fmtClock(hi)})`,
          tone: 'wip',
          foldHead: foldKey,
        })
      }
    }
    rows.push(...nsRows)
  }
  // k8s 노드 NotReady — 첫 묶음은 호스트 DOWN 의 결과, 뒤에 오는 '+n' 이 그 뒤 '다시 비정상' 줄들의 원인이다
  ;(m.k8sNotReady ?? []).forEach((x, i) =>
    rows.push({
      at: x.at,
      icon: <Server size={13} />,
      text: i === 0 ? `k8s 노드 NotReady ${x.nodes.length}대` : `k8s 노드 NotReady +${x.nodes.length}`,
      tone: 'bad',
      target: 'k8s',
      sub: `${x.nodes.join(' · ')} (kubectl get nodes 기준)`,
    }),
  )
  // Ceph — 요약에서는 데이터 복구와 HEALTH_OK 가 같은 순간이면 한 줄
  const cephSame = !!m.ceph && !!m.cephHealthy && Math.abs(m.cephHealthy.at - m.ceph.at) <= SAME_EVENT_MS
  if (view === 'summary' && cephSame && m.ceph && m.cephHealthy)
    rows.push({
      at: m.ceph.at,
      icon: <CircleCheck size={13} />,
      text: 'Ceph 데이터 복구 · HEALTH_OK',
      tone: 'ok',
      target: 'ceph',
      server: m.cephHealthy.srvAt ? `Ceph 기록 ${fmtClock(m.cephHealthy.srvAt)}` : undefined,
      ev: 'cephHealthy',
    })
  else {
    if (m.ceph)
      rows.push({
        at: m.ceph.at,
        // HEALTH_OK 까지 안 갔으면 초록으로 칠하지 않는다 — '다 끝났다' 로 읽히면 안 된다.
        icon: <CircleCheck size={13} />,
        text: 'Ceph 데이터 복구 완료: degraded · misplaced 0',
        tone: m.cephHealthy ? 'ok' : 'wip',
        target: 'ceph',
        sub: m.cephHealthy ? undefined : 'HEALTH_OK 아직 아님: 복제와 무관한 경고가 남아 있습니다',
        server: m.ceph.srvAt ? `Ceph 기록 ${fmtClock(m.ceph.srvAt)}` : undefined,
        ev: 'ceph',
      })
    if (m.cephHealthy)
      rows.push({
        at: m.cephHealthy.at,
        icon: <CircleCheck size={13} />,
        text: 'Ceph HEALTH_OK: 경고 해소',
        tone: 'ok',
        target: 'ceph',
        server: m.cephHealthy.srvAt ? `Ceph 기록 ${fmtClock(m.cephHealthy.srvAt)}` : undefined,
        ev: 'cephHealthy',
      })
  }
  /**
   * 노드 복귀 — 세션 재연결 · 클러스터 재합류 · OSD up · k8s Ready 가 노드마다 찍혀 6~7줄이 됐다. 요약에서는 한 줄로 묶고
   * 순서와 마지막 시각을 sub 에 적는다. 전체 보기는 그대로.
   */
  const back: { at: number; label: string }[] = [
    ...(m.reconnect ? [{ at: m.reconnect.at, label: '재연결' }] : []),
    ...(m.rejoin ?? []).map((r) => ({ at: r.at, label: '재합류' })),
    ...(m.osdUp ? [{ at: m.osdUp.at, label: `OSD ${m.osdUp.up}/${m.osdUp.total}` }] : []),
  ].sort((a, b) => a.at - b.at)
  const readyN = (m.k8sReady ?? []).length
  if (view === 'summary' && (back.length || readyN)) {
    const allAt = [...back.map((b) => b.at), ...(m.k8sReady ?? []).map((r) => r.at)]
    const node = m.reconnect?.node ?? m.rejoin?.[0]?.node ?? m.down?.node ?? ''
    rows.push({
      at: Math.min(...allAt),
      icon: <Activity size={13} />,
      text: `노드 복귀${node ? `: ${node}` : ''}`,
      tone: 'ok',
      target: 'node',
      sub: [...back.map((b) => `${b.label} ${fmtClock(b.at)}`), ...(readyN ? [`k8s Ready ${readyN}대`] : [])].join(' → ') + ` · 마지막 ${fmtClock(Math.max(...allAt))}`,
      server: m.reconnect?.bootAt ? `부팅 ${fmtClock(m.reconnect.bootAt)}` : undefined,
      ev: m.reconnect ? 'reconnect' : undefined,
    })
  } else {
    for (const r of m.rejoin ?? [])
      rows.push({ at: r.at, icon: <Server size={13} />, text: `클러스터 재합류: ${r.node}`, tone: 'ok', target: 'node', sub: '(pcs Online 복귀)' })
    for (const r of m.k8sReady ?? [])
      rows.push({ at: r.at, icon: <Server size={13} />, text: `k8s 노드 Ready: ${r.node}`, tone: 'ok', target: 'k8s' })
    if (m.osdUp)
      rows.push({
        at: m.osdUp.at,
        icon: <CircleCheck size={13} />,
        text: `Ceph OSD 전부 up: ${m.osdUp.up}/${m.osdUp.total}`,
        tone: 'ok',
        target: 'node',
      })
    if (m.reconnect)
      rows.push({
        at: m.reconnect.at,
        icon: <Activity size={13} />,
        text: `세션 재연결: ${m.reconnect.node}`,
        tone: 'ok',
        target: 'host',
        server: m.reconnect.bootAt ? `부팅 ${fmtClock(m.reconnect.bootAt)}` : undefined,
        ev: 'reconnect',
      })
  }
  /**
   * 포털 — 같은 폴링에서 함께 돌아온 페이지는 한 줄로 묶는다(4개 페이지가 같은 초에 4줄로 찍혀 타임라인을 덮었다).
   * 정상화 뒤 다시 끊긴 것(portalFlaps)은 지우지 않고 회색 정상화 줄 + '다시 끊김' 줄로 남긴다. 재장애가 FLAP_FOLD_MIN 번
   * 이상이면 중간을 접는다. 판정·리포트의 포털 정상화는 여전히 마지막(최종) 정상화다.
   */
  const flaps = m.portalFlaps ?? []
  const allPages = new Set([...(m.portal ?? []).map((p) => p.name), ...flaps.map((f) => f.name), ...(m.portalPending ?? [])])
  const pageLabel = (names: string[]) => (names.length === 1 ? names[0] : `${names.length}개 화면`)
  const downClusters = clusterByTime(flaps.map((f) => ({ ...f, at: f.downAt })))
  const portalFold = downClusters.length >= FLAP_FOLD_MIN ? 'portal' : undefined
  const portalRows: TimelineItem[] = []
  /*
   * 전체 보기의 포털 정상화 묶음(2026-11-09 사용자 요청 · 목업) — 요약은 '포털 정상화: 4/4' 한 줄인데 전체는 2/4 · 모니터링 · 대시보드 줄이
   * 흩어지고 줄마다 [증적] 이 붙어 같은 일을 다르게 말했다. 1차 정상화(감시 화면이 처음 모두 동시에 정상) 순간을 이룬 화면별 정상화를
   * 머리 줄 하나 + 하위 줄로 묶고 [증적] 은 머리 줄에만(증적 창의 '1차 정상화 근거' 로 연다). 다시 끊긴 회차는 최종 정상화도 같은 꼴로 묶는다.
   * 화면이 하나뿐이면 묶지 않는다(묶을 것이 없다). 머리 줄은 1차 정상화 시각에 — 요약의 그 줄과 같은 자리 · 같은 말이다.
   */
  const grouped = new Set<string>()
  if (view === 'full' && allPages.size > 1) {
    const ph = portalPhases(m)
    const ups = [
      ...(m.portal ?? []).map((p) => ({ name: p.name, at: p.at, streak: p.streak, down: null as number | null })),
      ...flaps.map((f) => ({ name: f.name, at: f.upAt, streak: undefined as number | undefined, down: f.downAt as number | null })),
    ]
    const n = allPages.size
    const streak = Math.max(0, ...(m.portal ?? []).map((p) => p.streak ?? 0))
    const tail = streak ? ` · 연속 ${streak}회 200` : ''
    const group = (members: typeof ups, at: number, title: string, startCount: number, tone: TlTone) => {
      for (const x of members) grouped.add(`${x.name}@${x.at}`)
      const cl = clusterByTime(members)
      const last = cl[cl.length - 1]
      portalRows.push({
        at,
        icon: <Globe size={13} />,
        text: title,
        sub: `${fmtClock(cl[0][0].at)} 첫 화면 → ${fmtClock(last[0].at)} 마지막 화면(${last.map((x) => x.name).join(', ')})`,
        tone,
        target: 'portal',
        only: 'full',
        ev: 'portal',
        sortAt: at,
        ord: 0,
      })
      let k = startCount
      cl.forEach((g, i) => {
        k += g.length
        const flapped = g.filter((x) => x.down != null)
        portalRows.push({
          at: g[0].at,
          icon: null,
          text: `└ ${g.map((x) => x.name).join(' · ')} (${k}/${n})`,
          tone,
          target: 'portal-child',
          tag: flapped.length ? `↻ ${flapped.map((x) => `${x.name} ${fmtElapsed((x.down as number) - x.at)} 뒤 다시 끊김`).join(', ')}` : undefined,
          only: 'full',
          child: true,
          sortAt: at,
          ord: i + 1,
        })
      })
    }
    if (ph.firstAll != null) {
      // 화면마다 1차 정상화 순간 이전의 마지막 정상화 — 그 순간 그 화면을 정상으로 만든 것
      const latest = new Map<string, (typeof ups)[number]>()
      for (const x of [...ups].sort((a, b) => a.at - b.at)) if (x.at <= (ph.firstAll as number)) latest.set(x.name, x)
      const first = [...latest.values()]
      const flappedAfter = ph.flapsAfterFirst > 0
      if (first.length === n)
        group(first, ph.firstAll, `포털 ${flappedAfter ? '1차 ' : ''}정상화: ${n}/${n} 화면${flappedAfter ? ` · 이후 다시 끊김 ${ph.flapsAfterFirst}회` : tail}`, 0, flappedAfter ? 'info' : 'ok')
      // 최종 — 1차 뒤 다시 끊긴 회차만: 1차 뒤에 다시 정상화된 화면들(끝내 다시 끊기지 않은 것)
      if (flappedAfter && ph.finalAll != null) {
        const fin = (m.portal ?? []).filter((p) => p.at > (ph.firstAll as number)).map((p) => ({ name: p.name, at: p.at, streak: p.streak, down: null }))
        if (fin.length) group(fin, ph.finalAll, `포털 최종 정상화: ${n}/${n} 화면${tail}`, n - fin.length, 'ok')
      }
    }
  }
  for (const g0 of clusterByTime(m.portal ?? [])) {
    const g = g0.filter((p) => !grouped.has(`${p.name}@${p.at}`))
    if (!g.length) continue
    const names = g.map((p) => p.name)
    const flapped = flaps.filter((f) => names.includes(f.name)).length
    const streak = g[0].streak
    portalRows.push({
      at: g[0].at,
      icon: <Globe size={13} />,
      // 시각만 적으면 '왜 이때인가' 를 알 수 없다. 무엇이 이 시각을 확정했는지 같이 적는다.
      text:
        g.length === 1 && !flapped
          ? `${g[0].name} 200 OK${streak ? ` (${streak}회 연속 성공)` : ''}`
          : `포털 ${flapped ? '최종 ' : ''}정상화: ${pageLabel(names)}${allPages.size > 1 ? ` (${names.length}/${allPages.size})` : ''}${streak ? ` · 연속 ${streak}회 200` : ''}`,
      tone: 'ok',
      target: 'portal',
      sub:
        g.length === 1
          ? [g[0].group && g[0].group !== g[0].name ? `(${g[0].group})` : '', flapped ? `재장애 ${flapped}회 뒤` : ''].filter(Boolean).join(' ') || undefined
          : `${flapped ? `재장애 ${flapped}회 뒤 · ` : ''}${names.join(', ')}`,
      only: 'full',
      // 증적('포털 응답 기록')은 2.13.8 부터 쌓인다. 버튼은 증적이 있는 회차에만 그려진다(옛 회차엔 안 보임)
      ev: 'portal',
    })
  }
  for (const g0 of clusterByTime(flaps.map((f) => ({ ...f, at: f.upAt })))) {
    // 묶음에 들어간 정상화(1차를 이룬 뒤 다시 끊긴 것)는 하위 줄의 '↻ 다시 끊김' 꼬리표가 맡는다
    const g = g0.filter((f) => !grouped.has(`${f.name}@${f.upAt}`))
    if (!g.length) continue
    const names = g.map((f) => f.name)
    const down = Math.min(...g.map((f) => f.downAt))
    portalRows.push({
      at: g[0].at,
      icon: <Globe size={13} />,
      text: `포털 정상화: ${pageLabel(names)}`,
      tone: 'info',
      target: 'portal',
      sub: g.length > 1 ? names.join(', ') : undefined,
      muted: true,
      tag: `↻ ${fmtElapsed(down - g[0].at)} 뒤 다시 끊김`,
      fold: portalFold,
      only: 'full',
      ev: 'portal',
    })
  }
  for (const g of downClusters) {
    const names = g.map((f) => f.name)
    portalRows.push({
      at: g[0].at,
      icon: <Globe size={13} />,
      text: `포털 다시 끊김: ${pageLabel(names)}`,
      tone: 'bad',
      target: 'portal',
      sub: g.length > 1 ? names.join(', ') : undefined,
      fold: portalFold,
      ev: 'portal',
    })
  }
  /**
   * 요약 보기의 포털 — 페이지가 따로 확정되면 '포털 최종 정상화' 가 페이지 묶음마다 찍혀 서너 줄이 됐다(사용자 지적 10-28). 요약에는
   * 1차 정상화(감시 페이지가 처음 모두 동시에 정상) · 최종 정상화(그 뒤 다시 끊기지 않음, 리포트 회차 상세의 참고 '포털 최종 정상화' — 리포트의 포털 정상화는 1차다, 10-30)
   * 두 줄만 두고, 사이의 다시 끊김은 위 줄들(많으면 '흔들림 n회' 로 접힘)이 맡는다. 페이지별 시각은 전체 보기에 있다.
   */
  if (view === 'summary' && allPages.size) {
    const ph = portalPhases(m)
    const streak = Math.max(0, ...(m.portal ?? []).map((p) => p.streak ?? 0))
    const tail = streak ? ` · 연속 ${streak}회 200` : ''
    const flapped = ph.firstAll != null && ph.flapsAfterFirst > 0
    if (flapped)
      rows.push({
        at: ph.firstAll as number,
        icon: <Globe size={13} />,
        text: `포털 1차 정상화: ${ph.total}/${ph.total} 화면${ph.calm ? `(끊기지 않은 ${ph.calm}개 포함)` : ''} · 이후 다시 끊김 ${ph.flapsAfterFirst}회`,
        // 뒤에 다시 끊겼으니 최종 결과가 아니다 — 회색([27] 규칙)
        tone: 'info',
        target: 'portal',
        ev: 'portal',
      })
    if (ph.finalAll != null)
      rows.push({
        at: ph.finalAll,
        icon: <Globe size={13} />,
        text: `포털 ${flapped || ph.flaps ? '최종 ' : ''}정상화: ${ph.total}/${ph.total} 화면${ph.calm ? `(끊기지 않은 ${ph.calm}개 포함)` : ''}${tail}`,
        tone: 'ok',
        target: 'portal',
        ev: 'portal',
      })
    else if ((m.portalPending ?? []).length && (m.portal ?? []).length) {
      const pend = (m.portalPending ?? []).length
      rows.push({
        at: Math.max(...(m.portal ?? []).map((p) => p.at)),
        icon: <Globe size={13} />,
        text: `포털 ${ph.total - pend}/${ph.total} 정상화 · 미복구 ${pend}`,
        tone: 'wip',
        target: 'portal',
        ev: 'portal',
      })
    }
  }
  /**
   * 포털이 처음 끊긴 순간(portalLog 의 fail) — 정상화까지 걸린 시간의 출발점이 타임라인에 보이게(사용자 요청 10-28). 같은 순간 끊긴 페이지는
   * 한 줄로, 요약에서는 첫 묶음 한 줄만. 이 기록이 생기기 전의 회차에는 없다.
   */
  const fails = clusterByTime((m.portalLog ?? []).filter((e) => e.kind === 'fail'))
  fails.forEach((g, i) => {
    if (view === 'summary' && i > 0) return
    const names = Array.from(new Set((view === 'summary' ? fails.flat() : g).map((e) => e.name)))
    rows.push({
      at: g[0].at,
      icon: <Globe size={13} />,
      text: `포털 끊김: ${pageLabel(names)}`,
      tone: 'bad',
      target: 'portal',
      sub: names.length > 1 ? names.join(', ') : undefined,
      ev: 'portal',
    })
  })
  if (portalFold) {
    // 요약에서는 접힌 정상화 줄(전체 보기 전용)이 안 보이므로 다시 끊긴 줄들의 범위만 — 1차 정상화 줄보다 앞에 서지 않게
    const folded = portalRows.filter((r) => r.fold && (view === 'full' || r.only !== 'full'))
    const lo = Math.min(...folded.map((r) => r.at))
    const hi = Math.max(...folded.map((r) => r.at))
    rows.push({
      at: lo,
      icon: <Globe size={13} />,
      text: `포털 흔들림 ${downClusters.length}회 (${fmtClock(lo)} ~ ${fmtClock(hi)})`,
      tone: 'wip',
      foldHead: portalFold,
    })
  }
  rows.push(...portalRows)
  /*
   * 파드 로그의 새 오류는 타임라인에 넣지 않는다(10-29 사용자 결정). 처음엔 네임스페이스마다 한 줄씩 넣었는데, 노드를 내리기도 전
   * 검증 시작 17초 만에 경고 세 줄이 붙었다 — 타임라인은 '언제 내려가고 언제 돌아왔나' 를 읽는 곳이고 로그 이상은 원인을 짐작하는
   * 정보라 성격이 다르다. 다시 넣지 말 것: 노드를 내리면 네임스페이스마다 줄이 생겨 복구 마일스톤이 묻힌다. 타임라인 아래
   * LogIssueList 에 따로 둔다(같은 '+경과' 꼴이라 나란히 비교된다).
   */
  // 정렬은 sortAt(묶음 머리 시각) 우선, 같은 묶음 안은 ord — 하위 줄이 머리 줄 바로 아래에 붙게
  rows.sort((a, b) => (a.sortAt ?? a.at) - (b.sortAt ?? b.at) || (a.ord ?? 0) - (b.ord ?? 0))
  return rows.filter((r) => !r.only || r.only === view)
}

/*
 * 요약 / 전체 보기 — 늘 요약으로 연다(사용자 결정 10-27). 예전엔 마지막으로 누른 보기를 localStorage('timeline_view')에 기억했는데,
 * 한 번 전체를 눌러 보면 그 뒤 검증 이력의 모든 회차 · 상태보드가 전체로 열렸다. 전체는 그 자리에서 누를 때만.
 * 다시 만들지 말 것: 기억하면 '기본이 요약' 이 지켜지지 않는다. 남아 있는 timeline_view 키는 읽지 않는다.
 */

function Timeline({
  milestones: m,
  t0,
  showDate,
  evKeys,
  onEvidence,
  onOpenLog,
}: {
  milestones: Milestones
  t0: number
  showDate?: boolean
  /** 이 회차에 저장된 증적 key 들 */
  evKeys?: string[]
  onEvidence?: (key: string) => void
  /** 파드 로그 이상 목록의 [로그 열기] — 지금 감시 중일 때만. 그 묶음이 없으면 false */
  onOpenLog?: (key: string) => boolean | undefined
}) {
  const [view, setView] = useState<'summary' | 'full'>('summary')
  const rows = buildTimelineRows(m, t0, view)
  const status = timelineStatus(m, t0)
  // 펼친 흔들림 묶음 — 기본은 접힘(사람이 열 때만 연다)
  const [openFolds, setOpenFolds] = useState<Set<string>>(() => new Set())
  const toggle = (k: string) =>
    setOpenFolds((cur) => {
      const n = new Set(cur)
      if (n.has(k)) n.delete(k)
      else n.add(k)
      return n
    })
  const shown = rows.filter((r) => !r.fold || openFolds.has(r.fold))
  /**
   * 맨 위 '아직 안 끝남' 칩 — 끝까지 읽지 않아도 지금 무엇이 남았는지 보이게(안 C). 파드는 네임스페이스가 많으면 한 칩으로.
   * 지난 회차(showDate)는 그 회차가 저장된 때 기준이다 — 문구는 '이 회차 미완료'(처음 쓴 '기록이 끝날 때 안 끝난 것' 은 어색했다).
   */
  const open = [...status.entries()].filter(([k, v]) => v.tone !== 'ok' && k !== 'pods')
  const podOpen = open.filter(([k]) => k.startsWith('pods:'))
  const chips = [
    ...open.filter(([k]) => !k.startsWith('pods:')).map(([, v]) => v),
    ...(podOpen.length > 3
      ? [{ tone: 'wip' as const, text: `미완 ${podOpen.length}개 ns`, name: '파드' }]
      : podOpen.map(([, v]) => v)),
  ]
  return (
    <>
      <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
        {chips.length > 0 && (
          <>
            <span className="text-[11px] text-gray-500">{showDate ? '이 회차 미완료' : '아직 안 끝남'}</span>
            {chips.map((c, i) => (
              <span key={i} className={'whitespace-nowrap rounded-full px-2 py-px text-[11px] ' + TL_PILL[c.tone]}>
                {c.name} {c.text}
              </span>
            ))}
          </>
        )}
        <span className="ml-auto inline-flex overflow-hidden rounded border border-white/10 text-[11px]">
          {(['summary', 'full'] as const).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              title={v === 'summary' ? '핵심 마일스톤만: 비슷한 줄은 묶습니다' : '모든 기록: 네임스페이스·노드마다 한 줄씩'}
              className={'px-2 py-0.5 ' + (view === v ? 'bg-white/10 text-gray-100' : 'text-gray-400 hover:bg-white/5')}
            >
              {v === 'summary' ? '요약' : '전체'}
            </button>
          ))}
        </span>
      </div>
      {shown.map((r, i) => {
        return (
          <TimelineRow
            key={i}
            at={r.at}
            t0={t0}
            icon={r.icon}
            text={r.text}
            sub={r.sub}
            server={r.server}
            tone={r.tone}
            muted={r.muted}
            tag={r.tag}
            compact={view === 'summary'}
            child={r.child}
            showDate={showDate}
            onToggle={r.foldHead ? () => toggle(r.foldHead as string) : undefined}
            open={r.foldHead ? openFolds.has(r.foldHead) : undefined}
            onEvidence={r.ev && onEvidence && evKeys?.includes(r.ev) ? () => onEvidence(r.ev as string) : undefined}
          />
        )
      })}
      {(m.logIssues?.length ?? 0) > 0 && (
        <LogIssueList
          items={m.logIssues ?? []}
          t0={t0}
          // 구간 구분은 장애 시작을 잡은 회차만(DOWN 못 잡은 회차는 검증 시작이 기준이라 '장애 전' 이 없다)
          base={(() => {
            const tt = runTotals({ id: '', t0, closedAt: t0, node: '', milestones: m })
            return tt.fromDown ? tt.base : null
          })()}
          upAt={nodeBackAt(m)}
          dropped={m.logIssuesDropped}
          evKeys={evKeys}
          onEvidence={onEvidence}
          onOpenLog={onOpenLog}
        />
      )}
    </>
  )
}

/**
 * 검증 중 새로 나온 파드 로그 이상 — 복구 타임라인 **아래 따로**(10-29 사용자 결정, 타임라인에서 뺀 이유는 buildTimelineRows 주석).
 * 늘 접힌 채로 연다(화면이 저절로 움직이지 않게). 기본은 **오류만** — 경고는 노드를 내리기 전에도 붙어(검증 시작 17초 만에 3줄)
 * 목록을 덮는다. 기준선은 검증 시작에서 끊는다(안 B): 기준선을 5분 채우면 그 안에 노드를 내렸을 때의 오류까지 '평소' 로 빠진다.
 */
function LogIssueList({
  items,
  t0,
  base,
  upAt,
  dropped,
  evKeys,
  onEvidence,
  onOpenLog,
}: {
  items: NonNullable<Milestones['logIssues']>
  t0: number
  /** 장애 시작(장애 주입 · DOWN) — 모르면 null(구간 구분 줄을 그리지 않는다) */
  base: number | null
  /** 노드 복귀 */
  upAt: number | null
  /** 회차당 한도를 넘어 개수만 남긴 종류 */
  dropped?: Milestones['logIssuesDropped']
  evKeys?: string[]
  onEvidence?: (key: string) => void
  /** 지금 감시 중인 묶음이면 합친 로그 창을 연다(지난 회차에는 없다) */
  onOpenLog?: (key: string) => boolean | undefined
}) {
  const [open, setOpen] = useState(false)
  const [warn, setWarn] = useState(false)
  /** 펼친 합친 줄 */
  const [openRows, setOpenRows] = useState<Set<string>>(() => new Set())
  const errN = items.filter((x) => x.level === 'error').length
  const warnN = items.length - errN
  /*
   * 표시만 묶는다(lib/podLogList): 같은 문구는 한 줄로 합치고(×n, 펼치면 원래 줄), 장애 시작 · 노드 UP 으로 구간을 나눈다.
   * 목록은 그 안에서만 스크롤한다(2026-11-07 사용자 결정) — 수십 건이면 이력 창 전체 스크롤에 묻혀 아래 내용까지 한참 내려가야 했다.
   */
  const rows = mergeLogIssues(
    items.filter((x) => warn || x.level === 'error'),
    base,
    upAt,
  )
  const segLabel = (seg: number) =>
    seg === 0 ? '장애 시작 전 (평소에도 나던 것일 수 있음)' : seg === 1 ? `장애 시작 +${fmtElapsed((base as number) - t0)} 뒤` : `노드 UP +${fmtElapsed((upAt as number) - t0)} 뒤`
  const buttons = (x: (typeof items)[number]) => {
    // 예전 회차(ev 필드 전)는 시각 · 워크로드로 만든 key
    const ev = x.ev ?? `podlog:${x.at}:${x.workload}`
    return (
      <>
        {onOpenLog && <LogOpenButton onClick={() => onOpenLog(x.key)} />}
        {onEvidence && evKeys?.includes(ev) && (
          <button onClick={() => onEvidence(ev)} className="ml-1 rounded border border-white/10 px-1.5 text-[10.5px] text-gray-300 hover:bg-white/10">
            증적
          </button>
        )}
      </>
    )
  }
  const badge = (level: 'error' | 'warn') => (
    <span className={'rounded px-1.5 text-[10.5px] ' + (level === 'error' ? 'bg-red-500/20 text-red-200' : 'bg-amber-500/15 text-amber-200')}>{level === 'error' ? '오류' : '경고'}</span>
  )
  let prevSeg: number | null = null
  return (
    <div className="mt-2 rounded-lg border border-white/10 bg-black/20">
      <button onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-[12px] text-gray-300 hover:bg-white/[0.03]">
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <FileText size={13} className={errN ? 'text-red-300' : 'text-gray-500'} />
        파드 로그 이상
        <span className="text-[11px] text-gray-500">(검증 중 새로 나온 것)</span>
        <span className={'ml-1 rounded px-1.5 text-[11px] ' + (errN ? 'bg-red-500/20 text-red-200' : 'text-gray-500')}>오류 {errN}</span>
        <span className="text-[11px] text-gray-500">· 경고 {warnN}</span>
        {!!dropped?.keys.length && <span className="text-[11px] text-amber-300/80">· 한도로 생략 {dropped.keys.length}</span>}
      </button>
      {open && (
        <div className="border-t border-white/10 px-2.5 pb-2 pt-1.5">
          <div className="mb-1 flex items-center gap-2 text-[11px] text-gray-500">
            <span>시각은 타임라인과 같은 검증 시작 후 경과입니다. 파드 로그가 찍은 시각이라 폴링 오차가 없습니다(노드 시계 차이를 재지 못한 동안은 노드 시계 그대로). 같은 문구는 한 줄로 합쳤습니다(×n 을 누르면 펼침).</span>
            {warnN > 0 && (
              <label className="ml-auto flex shrink-0 items-center gap-1 text-gray-400">
                <input type="checkbox" checked={warn} onChange={(e) => setWarn(e.target.checked)} className="h-3 w-3 accent-blue-500" />
                경고도 보기
              </label>
            )}
          </div>
          {rows.length === 0 ? (
            <p className="py-2 text-[11.5px] text-gray-500">새로 나온 오류가 없습니다{warnN ? `. 경고 ${warnN}건은 [경고도 보기] 에서 봅니다` : ''}.</p>
          ) : (
            // 열 이름은 위에 고정, 끝에 닿아도 바깥(이력 창)이 같이 밀리지 않게 overscroll-contain
            <div className="max-h-[340px] overflow-y-auto overscroll-contain">
              <table className="w-full border-collapse text-[11.5px]">
                <thead className="sticky top-0 z-[1] bg-[#191926] text-left text-[10.5px] text-gray-500">
                  <tr>
                    <th className="py-0.5 pr-2 font-normal">처음</th>
                    <th className="py-0.5 pr-2 font-normal">종류</th>
                    <th className="py-0.5 pr-2 font-normal">네임스페이스</th>
                    <th className="py-0.5 pr-2 font-normal">무엇이</th>
                    <th className="py-0.5 pr-2 text-right font-normal">파드</th>
                    <th className="py-0.5 pr-2 text-right font-normal">횟수</th>
                    <th className="py-0.5 pr-2 font-normal">마지막</th>
                    <th className="py-0.5 font-normal" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const sep =
                      r.seg != null && r.seg !== prevSeg ? (
                        <tr key={`seg${r.seg}`}>
                          <td colSpan={8} className="pb-0.5 pt-2 text-[10.5px] font-semibold text-gray-500">
                            ── {segLabel(r.seg)}
                          </td>
                        </tr>
                      ) : null
                    prevSeg = r.seg
                    const many = r.items.length > 1
                    const isOpen = openRows.has(r.id)
                    const toggle = () =>
                      setOpenRows((cur) => {
                        const n = new Set(cur)
                        if (n.has(r.id)) n.delete(r.id)
                        else n.add(r.id)
                        return n
                      })
                    return (
                      <Fragment key={r.id}>
                        {sep}
                        <tr className="border-t border-white/5 align-top">
                          <td className="whitespace-nowrap py-1 pr-2 font-mono text-gray-300">+{fmtElapsed(r.at - t0)}</td>
                          <td className="py-1 pr-2">{badge(r.level)}</td>
                          <td className="py-1 pr-2 font-mono text-gray-400">{r.ns}</td>
                          <td className="py-1 pr-2 text-gray-200">
                            {r.text}
                            {many && (
                              <button
                                onClick={toggle}
                                title="같은 문구로 따로 묶인 기록들 — 눌러서 하나씩 봅니다"
                                className="ml-1.5 inline-flex items-center gap-0.5 rounded bg-white/10 px-1 text-[10.5px] text-gray-300 hover:bg-white/20"
                              >
                                ×{r.items.length} {isOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                              </button>
                            )}
                          </td>
                          <td className="py-1 pr-2 text-right text-gray-400">{r.pods}</td>
                          <td className="py-1 pr-2 text-right text-gray-400">{r.count ?? '-'}</td>
                          <td className="whitespace-nowrap py-1 pr-2 font-mono text-gray-500">{r.last != null ? `+${fmtElapsed(r.last - t0)}` : '-'}</td>
                          <td className="whitespace-nowrap py-1 text-right">{many ? null : buttons(r.items[0])}</td>
                        </tr>
                        {many &&
                          isOpen &&
                          r.items.map((x) => (
                            <tr key={x.key} className="align-top text-gray-400">
                              <td className="whitespace-nowrap py-0.5 pr-2 pl-3 font-mono">+{fmtElapsed(x.at - t0)}</td>
                              <td />
                              <td />
                              {/* 합친 줄끼리 다른 것은 서명(정규화한 로그 문구) — key 가 '<ns>|<워크로드>|<서명>' 이다(podLogScan) */}
                              <td className="max-w-[520px] truncate py-0.5 pr-2 font-mono text-[10.5px] text-gray-500" title={x.key.split('|').slice(2).join('|')}>
                                └ {x.key.split('|').slice(2).join('|') || x.workload}
                              </td>
                              <td className="py-0.5 pr-2 text-right">{x.pods}</td>
                              <td className="py-0.5 pr-2 text-right">{x.count ?? '-'}</td>
                              <td className="whitespace-nowrap py-0.5 pr-2 font-mono text-gray-500">{x.last != null ? `+${fmtElapsed(x.last - t0)}` : '-'}</td>
                              <td className="whitespace-nowrap py-0.5 text-right">{buttons(x)}</td>
                            </tr>
                          ))}
                      </Fragment>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
          {!!dropped?.keys.length && (
            <div
              className="mt-1.5 rounded border border-amber-500/30 bg-amber-500/[0.08] px-2.5 py-1 text-[11.5px] text-amber-200"
              title="이력 저장 공간이 넘치지 않게 회차당 오류 종류를 150가지까지만 자세히 남깁니다. 그 시간대 로그는 상태보드의 [로그 열기] 나 서버에서 직접 확인하세요."
            >
              ⚠ 오류 종류 한도({LOG_ISSUES_MAX})를 넘어 +{fmtElapsed(dropped.since - t0)} 이후 새 종류 {dropped.keys.length}건은 개수만 남겼습니다.
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** [로그 열기] — 감시가 그 묶음을 이미 잊었으면(보드를 다시 열었을 때 등) 눌러도 열 것이 없다고 그 자리에서 알린다 */
function LogOpenButton({ onClick }: { onClick: () => boolean | undefined }) {
  const [gone, setGone] = useState(false)
  return gone ? (
    <span className="text-[10.5px] text-gray-500">지금 감시에 없음</span>
  ) : (
    <button
      onClick={() => {
        if (onClick() === false) setGone(true)
      }}
      className="rounded border border-white/10 px-1.5 text-[10.5px] text-gray-200 hover:bg-white/10"
    >
      로그 열기
    </button>
  )
}
