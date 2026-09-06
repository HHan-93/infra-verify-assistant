// 메인 프로세스(ssh2)와 렌더러(React)가 공유하는 타입 정의

/** SSH 접속 정보 (렌더러 폼 → 메인 프로세스로 전달) */
export interface SSHConfig {
  host: string
  port: number
  username: string
  /** 비밀번호 인증 시 사용 */
  password?: string
  /** 개인키 인증 시 사용 (PEM 문자열) */
  privateKey?: string
  /** 개인키 암호화 시 사용하는 passphrase */
  passphrase?: string
  /** SSH 에이전트(Pageant/OpenSSH agent) 사용 — 백엔드가 경로 해석 */
  useAgent?: boolean
  /** 접속(쉘 오픈) 후 자동 실행할 명령 (줄 단위) */
  startup?: string
  /** 점프 호스트(Bastion) 경유 접속. 먼저 jump 에 연결한 뒤 그 위로 target 에 연결 */
  jump?: SSHConfig
}

/** ssh:connect 호출 결과 */
export interface ConnectResult {
  success: boolean
  message: string
  /** 저장된 호스트 키와 달라 거부됨 (사용자가 신뢰 후 재접속 필요) */
  hostKeyChanged?: boolean
}

/** 연결 상태 변화 이벤트 (메인 → 렌더러) */
export type SSHStatus = 'connecting' | 'connected' | 'closed' | 'error'

export interface SSHStatusEvent {
  /** 어느 세션(터미널 탭)의 상태인지 구분 */
  sessionId: string
  status: SSHStatus
  message?: string
}

/** 터미널 출력 이벤트 (메인 → 렌더러) — sessionId 로 해당 탭 xterm 에 라우팅 */
export interface TerminalDataEvent {
  sessionId: string
  data: string
}

// ── AI 분석 관련 타입 ──────────────────────────────────────────

/** 지원하는 AI 프로바이더 */
export type AIProvider = 'anthropic' | 'gemini' | 'openai'

/** 프로바이더별 메타데이터 (렌더러 UI 기본값/모델목록/안내 및 메인 환경변수 폴백에 사용) */
export const PROVIDER_INFO: Record<
  AIProvider,
  { label: string; defaultModel: string; models: string[]; keyHint: string; envVar: string; apiKeyUrl: string }
> = {
  anthropic: {
    label: 'Claude (Anthropic)',
    defaultModel: 'claude-opus-4-8',
    models: ['claude-opus-4-8', 'claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
    keyHint: 'sk-ant-...',
    envVar: 'ANTHROPIC_API_KEY',
    apiKeyUrl: 'https://console.anthropic.com/settings/keys',
  },
  gemini: {
    // gemini-2.5-pro 는 무료 등급(free tier) 미지원(limit 0). 무료 키로 쓰려면 flash 계열 사용.
    label: 'Gemini (Google)',
    defaultModel: 'gemini-2.5-flash',
    models: [
      'gemini-2.5-flash',
      'gemini-2.5-pro',
      'gemini-2.5-flash-lite',
      'gemini-2.0-flash',
      'gemini-2.0-flash-lite',
    ],
    keyHint: 'AIza... (Google AI Studio 키)',
    envVar: 'GEMINI_API_KEY',
    apiKeyUrl: 'https://aistudio.google.com/app/apikey',
  },
  openai: {
    label: 'OpenAI (GPT)',
    defaultModel: 'gpt-4o',
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini', 'o4-mini', 'o3'],
    keyHint: 'sk-...',
    envVar: 'OPENAI_API_KEY',
    apiKeyUrl: 'https://platform.openai.com/api-keys',
  },
}

// ── 분석 스타일 (시스템 프롬프트 프리셋) ──────────────────────

export type AnalysisStyle = 'standard' | 'detailed' | 'simple' | 'free' | 'shellgen'

const PERSONA =
  '당신은 OpenStack, Ceph, Kubernetes 등 클라우드 인프라의 품질 검증과 트러블슈팅을 돕는 시니어 인프라 엔지니어입니다. 사용자는 터미널 명령어 출력이나 질문을 전달합니다. 한국어로 답하세요.'

/** UI에서 선택하는 분석 스타일별 라벨/설명/시스템 프롬프트 */
export const ANALYSIS_STYLES: Record<
  AnalysisStyle,
  { label: string; hint: string; system: string }
> = {
  standard: {
    label: '기본 (요약·이상징후·권장조치)',
    hint: '3단 형식으로 균형 있게',
    system: `${PERSONA}
다음 형식으로 간결하게 분석하세요.
1. **요약** — 출력/상황의 핵심을 1~2줄로
2. **이상 징후** — 경고·오류·비정상 지표가 있으면 구체적으로 (없으면 "특이사항 없음")
3. **권장 조치** — 문제가 있으면 원인과 해결 방법을, 정상이면 다음 검증 단계를 제안
수치/상태값을 근거로 해석하고, 추측은 추측이라고 명시하세요.`,
  },
  detailed: {
    label: '상세 (근거·원인·추가확인)',
    hint: '지표 인용까지 깊게',
    system: `${PERSONA}
다음 형식으로 상세히 분석하세요.
1. **요약**
2. **주요 지표 해석** — 출력의 핵심 수치/상태값을 근거로 한 줄씩 해석
3. **이상 징후 및 원인 추정** — 의심 원인 포함
4. **권장 조치** — 단계별 구체적 명령/방법
5. **추가 확인** — 더 봐야 할 명령어/로그 제안
근거를 출력에서 명확히 인용하고, 불확실한 부분은 표시하세요.`,
  },
  simple: {
    label: '간단 (핵심만)',
    hint: '한두 줄로 짧게',
    system: `${PERSONA}
군더더기 없이 아주 간결하게 답하세요.
- 한 줄 요약
- 문제가 있으면 핵심 원인과 즉시 조치를 한 줄로
정상이면 "정상"이라고만 하고 끝내세요. 불필요한 설명은 하지 마세요.`,
  },
  free: {
    label: '자유형 (형식 없음)',
    hint: '형식 강제 없이 자연스럽게',
    system: `${PERSONA}
정해진 형식 없이, 주어진 출력/질문에 가장 도움이 되는 방식으로 자연스럽게 분석·설명하세요. 핵심부터 말하고, 근거는 출력에서 인용하며, 추측은 추측이라고 밝히세요.`,
  },
  // UI 셀렉트 목록에는 노출하지 않고, "명령어 생성" 모드에서만 내부적으로 사용하는 스타일.
  // 파싱 가능하도록 반드시 고정된 형식으로만 답하게 강제한다.
  shellgen: {
    label: '명령어 생성 (내부용)',
    hint: '자연어 요청을 쉘 명령어로 변환',
    system: `당신은 리눅스/유닉스 쉘 명령어, 그리고 OpenStack/Ceph/Kubernetes 등 클라우드 인프라 CLI 전문가입니다. 사용자의 자연어 요청을 실행 가능한 명령어 한 줄로 변환하세요.
반드시 아래 형식으로만 답하고, 다른 텍스트·코드블록·마크다운은 절대 추가하지 마세요.
COMMAND: <명령어>
설명: <한국어로 한 줄 설명>
사용자 메시지 끝에 "(참고용 사내 검증 명령어 후보)" 블록이 붙어 있으면, 그중 요청과 일치하는 항목이 있으면 반드시 그 명령어를 정확히 그대로 COMMAND 로 사용하세요 — 새로 만들거나 비슷하게 바꾸지 마세요.
그런 후보가 없는 요청이라면 알고 있는 정확한 문법으로 직접 생성하되, OpenStack(openstack/nova/neutron 등)처럼 서브커맨드가 버전마다 바뀌어온 CLI는 특히 신중하게: 서브커맨드나 옵션 철자를 확신할 수 없으면 그럴듯하게 지어내지 말고, 설명에 "정확한 문법은 공식 문서로 재확인 권장"이라고 반드시 덧붙이세요.
명령어를 확신할 수 없거나 파괴적인 작업(rm -rf, dd, mkfs 등)이 필요하면, COMMAND 에는 요청을 만족하는 가장 안전한 형태의 명령어를 적고 설명에 주의사항을 반드시 포함하세요.`,
  },
}

/** 대화 메시지 (렌더러 ↔ 메인 ↔ AI API 공유) */
export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

/** ai:start 요청 payload */
export interface AIRequest {
  /** 응답 스트림을 구분하기 위한 요청 ID */
  requestId: string
  /** 사용할 프로바이더 */
  provider: AIProvider
  /** 모델 ID (비우면 프로바이더 기본 모델 사용) */
  model?: string
  /** 분석 스타일(시스템 프롬프트 프리셋). 비우면 standard */
  style?: AnalysisStyle
  /** 전체 대화 히스토리 (마지막 user 메시지 포함) */
  messages: ChatMessage[]
  /** 사용자가 UI 에서 입력한 API 키 (없으면 메인의 프로바이더별 환경변수 사용) */
  apiKey?: string
}

/** ai:delta / ai:done / ai:error 이벤트 payload */
export interface AIStreamEvent {
  requestId: string
  /** 'delta' 일 때 누적 텍스트 조각 */
  text?: string
  /** 'error' 일 때 메시지 */
  error?: string
}

// ── 모니터링(서버 메트릭) ──────────────────────────────────────

/** 마운트 포인트 디스크 정보 */
export interface DiskInfo {
  mount: string
  total: number  // GB
  used: number   // GB
  pct: number    // 0~100
}

/** 상위 프로세스 1개 */
export interface ProcInfo {
  pid: number
  name: string
  cpu: number // %
  mem: number // %
}

/** 에이전트가 한 번 출력하는 시스템 메트릭 스냅샷 (JSON 한 줄) */
export interface MetricSample {
  ts: number // epoch seconds
  host: string
  uptime: number // seconds
  cpu: number // 0~100 (%)
  load: [number, number, number] // 1/5/15분 load average
  mem: { total: number; used: number; avail: number; pct: number } // MB, pct=%
  disk: { total: number; used: number; pct: string } // GB, pct="83"
  procs: ProcInfo[]
  net?: { rxMBs: number; txMBs: number } // 네트워크 rx/tx MB/s (에이전트 v3+)
  svcFailed?: string[]                   // failed 상태 systemd 서비스 목록 (에이전트 v4+)
  disks?: DiskInfo[]                     // 전체 마운트 포인트 (에이전트 v6+)
}

/** monitor:start 옵션 */
export interface MonitorStartOptions {
  /** 데몬 수집 주기(ms). 기본 5000, 최소 2000 */
  intervalMs?: number
}

/** monitor:sample 이벤트 (메인 → 렌더러) — sessionId 로 해당 탭 대시보드에 라우팅 */
export interface MonitorSampleEvent {
  sessionId: string
  sample: MetricSample
}

/** monitor:error 이벤트 (메인 → 렌더러) */
export interface MonitorErrorEvent {
  sessionId: string
  error: string
}

// ── 접속 정보 저장(암호화) ─────────────────────────────────────

/** 다음 실행 시 자동 채움을 위해 저장하는 SSH 접속 프로필 */
export interface SavedProfile {
  host: string
  port: string
  username: string
  authMethod: 'password' | 'key' | 'agent'
  password: string
  privateKey: string
  passphrase: string
  /** 사이드바 표시용 별칭 (예: con2). 없으면 host 로 표시 */
  label?: string
  /** 폴더(그룹)명 — 2단계 트리 구조용. 미지정 시 평면 목록 */
  group?: string
  /** 접속 후 자동 실행할 명령 (줄 단위) */
  startup?: string
  /** 점프 호스트(Bastion) 경유 설정. 미지정 시 직접 접속 */
  jump?: JumpProfile
  /** 탭 색상 키 (rose/orange/amber/emerald/sky/blue/violet). 미지정 시 기본 */
  color?: string
}

/** 점프 호스트(Bastion) 접속 정보 */
export interface JumpProfile {
  host: string
  port: string
  username: string
  authMethod: 'password' | 'key' | 'agent'
  password: string
  privateKey: string
  passphrase: string
}

/** CSV/JSON 파일에서 세션 프로필을 일괄 가져온 결과 */
export interface ProfileImportResult {
  ok: boolean
  canceled?: boolean
  error?: string
  addedCount?: number
  skippedCount?: number
  errorCount?: number
  warnings?: string[]
  errors?: string[]
  list?: SavedProfile[]
}

/** 세션 로그 한 건의 메타데이터 (실제 내용은 별도 파일에 있고, 이 인덱스는 목록/검색용) */
export interface LogIndexEntry {
  id: string
  host: string
  label?: string
  /** 사용자가 선택한 저장 위치의 평문 로그 파일 (ANSI 코드 포함, 외부 뷰어로도 열람 가능) */
  path: string
  /** 리플레이용 타이밍 포함 JSONL — 앱 관리 폴더(userData/session-logs)에 저장 */
  castPath: string
  startedAt: number
  endedAt?: number
  sizeBytes?: number
}

/**
 * 목록에 곁들이는 **실물 정보** — 인덱스에 없거나 낡을 수 있는 것만 파일에서 직접 확인한다.
 *
 * 인덱스의 `sizeBytes` 는 기록이 끝날 때만 채워져, 예전 항목이나 기록 중인 항목은 비어 있다.
 * 그 빈 값과 "파일이 사라진 것" 이 화면에서 똑같이 `-` 로 보여 구분되지 않았다.
 */
export interface LogEntryDetail {
  id: string
  /** 평문 로그 파일이 지금도 그 자리에 있는가 (사용자가 옮기거나 지웠을 수 있다) */
  plainExists: boolean
  /** 실제 파일 크기 — 인덱스 값이 아니라 지금 잰 것 */
  plainSize?: number
  /** 리플레이 기록(.cast.jsonl)이 있는가 — 없으면 리플레이 탭이 실패한다 */
  castExists: boolean
  /** 리플레이 기록의 크기 — 자동 정리가 지우는 것은 이쪽이다 */
  castSize?: number
  /** 로그 앞부분에서 뽑은 첫 명령어. 못 찾으면 없음(추측해서 채우지 않는다) */
  firstCommand?: string
}

/** 세션 로그(.cast.jsonl) 자동 정리 기준 — 렌더러(로그뷰어)에서 조회/변경 가능 */
export interface LogRetentionSettings {
  retentionDays: number
  maxEntries: number
}

/** 실시간 로그 뷰어(logtail)의 조회 대상 — 파일 tail -f 또는 Kubernetes 파드 로그 */
export type LogTailTarget =
  | { kind: 'file'; path: string }
  | { kind: 'k8s'; namespace: string; pod: string; container?: string }

/**
 * 명령 결과 자동 판정 기준. 미지정(또는 빈 값)이면 위험 키워드 유무로 "정보/실패"만 가리고
 * 초록 PASS 는 띄우지 않는다 — 단순 조회 명령(df -h, lscpu 등)에 의미 없는 통과 표시를 막기 위함.
 */
export interface CommandCheck {
  /** 하나라도 출력에 있으면 FAIL (예: ["HEALTH_ERR", "OFFLINE"]) */
  failContains?: string[]
  /** 모두 출력에 있어야 PASS (예: ["HEALTH_OK"]) */
  passContains?: string[]
  /** 이 정규식이 출력과 매칭되면 PASS (대소문자 무시) */
  passRegex?: string
  /** 종료 코드 0 을 요구할지 (기본 true — check 가 설정된 경우에만 적용) */
  requireExitZero?: boolean
}

/** 사용자가 앱 내에서 직접 추가한 단일 명령어 프리셋 (내장 PRESETS 와 병합되어 표시됨) */
export interface CustomPresetCommand {
  id: string
  /** 카테고리 — 기존 내장 카테고리와 같은 이름이면 그 카테고리에 합쳐짐 */
  solution: string
  /** 하위분류 — 기존과 같은 이름이면 그 하위분류에 합쳐짐 */
  subgroup: string
  label: string
  command: string
  desc: string
  /** 실행 결과 자동 판정 기준 (선택) */
  check?: CommandCheck
  /**
   * 같은 하위분류 안에서의 표시 순서. 내장 명령어는 배열 인덱스(0,1,2..)를 암묵적 순서로 쓰고,
   * 사용자 정의 항목은 이 값으로 그 사이 어디든 끼워 넣을 수 있음(소수점 사용, 두 이웃의 중간값).
   * 미지정 시 생성 시각(ms)을 사용해 내장 항목들보다 항상 뒤로 감.
   */
  order?: number
}

/**
 * 스텝 실행 중 나타나는 대화형 프롬프트에 자동 응답할 규칙.
 * 영속 셸(PTY)에서만 동작한다 — 출력에 match(정규식, 대소문자 무시)가 나타나면 send 를 입력한다.
 * 같은 규칙은 스텝당 한 번만 발동한다(프롬프트가 반복 출력될 때 무한 응답 방지).
 */
export interface ExpectRule {
  /** 프롬프트를 알아볼 정규식 (예: "password", "\\[y/N\\]") */
  match: string
  /** 보낼 문자열 (개행은 자동으로 붙음). <...> 플레이스홀더 사용 가능 */
  send: string
  /** 화면/리포트에 send 값을 가리고 표시 (비밀번호용) */
  secret?: boolean
}

/**
 * 이전 스텝의 출력에서 값을 뽑아 다음 스텝의 <이름> 플레이스홀더로 넘기는 규칙.
 * 예: name="INSTANCE_IP", regex="inet (\\d+\\.\\d+\\.\\d+\\.\\d+)" → 다음 스텝에서 <INSTANCE_IP> 사용
 */
export interface CaptureRule {
  /** 저장할 변수 이름 (플레이스홀더 <이름> 으로 참조) */
  name: string
  /** 캡처 정규식 */
  regex: string
  /** 사용할 캡처 그룹 번호 (기본 1, 0 이면 매치 전체) */
  group?: number
}

/** 스텝이 실패했을 때 취할 동작 */
export type OnFailureAction =
  /** 이후 스텝을 실행하지 않고 전체 실행을 중단 (기본) */
  | 'stop'
  /** 실패로 기록하되 다음 스텝을 계속 진행 */
  | 'continue'
  /** onFailureCommand 를 실행한 뒤 중단 (롤백/로그수집 등) */
  | 'run'
  /**
   * onFailureCommand 로 원인을 고친 뒤 이 스텝을 **한 번 다시 실행**한다.
   * 성공하면 그대로 다음 스텝으로 진행하고, 그래도 실패하면 중단.
   * 예: apt update 가 DNS 문제로 실패 → resolvectl 로 DNS 지정 → apt update 재시도.
   */
  | 'retry'

/** 사용자가 앱 내에서 직접 추가한 시나리오(순서가 있는 여러 단계) */
export interface CustomScenarioStep {
  title: string
  command: string
  desc: string
  note?: string
  info?: string
  warn?: string
  code?: string
  /** 실행 결과 자동 판정 기준 (선택) */
  check?: CommandCheck
  /**
   * 이 스텝을 실행할 대상 '역할' 이름 (예: "LB", "client", "server").
   * 검증 실행 창에서 역할 → 실제 세션을 매핑한다. 비우면 기본 대상에서 실행.
   *
   * 쉼표로 여러 역할을 적으면 그 역할들에 매핑된 세션 **전부**에서 실행된다.
   *   "서버, 클라이언트" → 도구 설치처럼 양쪽에 다 필요한 스텝
   */
  target?: string
  /** 출력에서 값을 뽑아 이후 스텝의 플레이스홀더로 넘김 */
  capture?: CaptureRule[]
  /** 대화형 프롬프트 자동 응답 */
  expect?: ExpectRule[]
  /** 실패 시 동작 (기본 stop) */
  onFailure?: OnFailureAction
  /**
   * 대응 명령의 단계 설명 (선택). 명령을 최상위 `;` `&&` `||` 로 쪼갠 조각과 **순서대로 1:1**
   * 로 짝지어 검증 실행 창에 보여준다. 한 줄에 여러 동작을 이어 붙인 명령이 그냥 한 줄로
   * 뿌려지면 "무엇을 어떤 순서로 하는지" 를 읽을 수 없어서 붙였다.
   *
   * 비워두면 명령 조각만 번호를 붙여 보여준다 — **셸 텍스트에서 의도를 추측해 자동으로 만들지는
   * 않는다.** 틀린 설명이 그럴듯하게 박히는 것이 raw 명령어보다 나쁘다.
   */
  onFailureDesc?: string[]
  /** onFailure === 'run' 일 때 실행할 명령 (롤백 스크립트 등) */
  onFailureCommand?: string
  /**
   * 이 단계가 만든 변경을 되돌리는 명령 (선택).
   * 검증이 끝난 뒤 '원복 실행'을 누르면, **실제로 실행된 단계만** 골라 **역순으로** 돌린다.
   * 되돌릴 필요가 없는 단계(조회만 하는 명령, DNS/패키지 설치처럼 남겨둬도 되는 것)는 비워두면 된다.
   * 예: `sudo mkdir -p /mnt/config` → `sudo rmdir /mnt/config`
   */
  undo?: string
}
export interface CustomScenario {
  id: string
  solution: string
  title: string
  summary: string
  steps: CustomScenarioStep[]
  /**
   * 입력값을 '역할의 접속 주소'로 자동 채우는 규칙. 예: { "Target_IP": "서버" }
   *
   * 역할(서버/클라이언트)을 나눠 세션을 지정해 놓고 그 서버 IP 를 또 손으로 입력하게 하면
   * 앞뒤가 안 맞는다. 여기에 적어두면 역할 매핑에서 고른 세션의 주소가 바로 들어간다.
   * 사용자가 직접 입력한 값이 있으면 그쪽이 우선한다.
   */
  roleValues?: Record<string, string>
  /** 같은 카테고리 안에서의 표시 순서 — CustomPresetCommand.order 와 동일한 규칙 */
  order?: number
}

/**
 * 사용자 정의 프리셋·시나리오 내보내기 파일 형식.
 *
 * **둘을 한 파일에 담는다.** 따로 내보내면 파일이 두 개가 되고, 팀원에게 줄 때 한쪽을
 * 빼먹는다(받는 쪽도 두 번 가져와야 한다). 어느 한쪽이 비어 있어도 정상이다.
 */
export interface CustomItemsBundle {
  /** 형식 버전 — 나중에 구조가 바뀌면 이 값으로 갈라 읽는다 */
  version: 1
  /** 어디서 온 파일인지 알아보기 위한 정보. 가져오기 판단에는 쓰지 않는다 */
  exportedAt?: string
  appVersion?: string
  presets: CustomPresetCommand[]
  scenarios: CustomScenario[]
}

/** customItems:import 결과 — 무엇이 들어왔고 무엇이 버려졌는지 사용자에게 그대로 보여준다 */
export interface CustomItemsImportResult {
  ok: boolean
  canceled?: boolean
  error?: string
  /** 새로 추가된 수 */
  addedPresets: number
  addedScenarios: number
  /** 같은 id 가 이미 있어 덮어쓴 수 (같은 파일을 두 번 가져와도 중복이 생기지 않는다) */
  replaced: number
  /** 필수 항목이 없거나 형식이 틀려 건너뛴 수 */
  skipped: number
  /** 건너뛴 이유 — 사용자가 원본 파일을 고칠 수 있도록 구체적으로 남긴다 */
  warnings: string[]
}

// ─────────────────────────────────────────────────────────────
// Kubernetes ConfigMap 보기 / 수정
//
// 왜 파일 뷰어에 붙이면서도 별도 타입으로 두는가 —
// ConfigMap 은 **문서가 아니라 키-값 맵**이다(실제 운영 cm 에 키가 110 개인 것을 봤다).
// 파일처럼 텍스트 한 덩어리로 다루면 YAML 들여쓰기 하나에 전체가 흔들리고, 값의 인용(따옴표)을
// 사람이 관리해야 한다. 그래서 값은 문자열 맵으로 주고받고, 쓰기는 **바꾼 키만** 보낸다.
//
// `kubectl edit` 을 쓰지 않는 이유: 대화형 에디터를 띄우는 명령이라 exec 로는 동작하지 않는다.
// 그리고 kubectl edit 은 문법이 깨지면 반영을 거부해 주지만, 우리가 textarea 를 주면 그 안전장치가
// 없다 — 그래서 YAML 전문은 **읽기 전용**으로만 보여준다.
// ─────────────────────────────────────────────────────────────

/** 목록에 뜨는 ConfigMap 한 건 */
export interface ConfigMapRef {
  name: string
  /** data 키 개수 (kubectl 의 DATA 컬럼) */
  keys: number
  age: string
}

/** 선택한 ConfigMap 의 내용 */
export interface ConfigMapDetail {
  namespace: string
  name: string
  /** 문자열 키-값. ConfigMap 의 data 는 값이 모두 문자열이어야 한다(그래서 타입 걱정이 없다) */
  data: Record<string, string>
  /**
   * binaryData 의 키 이름들. 값은 base64 라 이 화면에서 편집하지 않는다 —
   * 목록에만 드러내고 '이 화면에서 수정 불가' 로 표시한다(조용히 빠지면 없는 줄 안다).
   */
  binaryKeys: string[]
  /**
   * 불러온 시점의 resourceVersion. 적용 직전에 다시 읽어 **값이 그대로인지 확인**한다.
   * 그 사이 남이(또는 GitOps 가) 바꿨으면 덮어쓰지 않고 알린다.
   */
  resourceVersion: string
  creationTimestamp: string
}

/** k8s:patchConfigMap 결과 */
export interface ConfigMapPatchResult {
  ok: boolean
  /** 불러온 뒤 다른 곳에서 바뀌어 적용하지 않았다 — 사용자가 다시 불러와 확인해야 한다 */
  conflict?: boolean
  error?: string
  /** 적용된 키 수 */
  applied?: number
  /** 남긴 백업 파일 경로 (로컬 userData) */
  backupPath?: string
  /** 새 resourceVersion — 이어서 더 고칠 수 있게 돌려준다 */
  resourceVersion?: string
}

/**
 * 백업 한 건. **내 PC(userData)에 남긴다** — 그 서버가 아니다.
 * ConfigMap 은 클러스터 객체라 '마침 kubectl 이 있던 호스트' 에 두면 이력이 호스트별로 흩어지고,
 * `/var/tmp` 는 systemd-tmpfiles 가 청소하는 곳이라 백업 장소로 부적합하다.
 * 값에 토큰·비밀번호가 그대로 들어 있으므로 safeStorage 로 암호화해 `.dat` 로 쓴다(평문 금지).
 * 복원용 평문은 사용자가 '내보내기' 를 눌렀을 때만 만든다.
 */
/**
 * 백업을 만든 환경 — **어느 클러스터를 고쳤는지**.
 *
 * 같은 이름의 네임스페이스·ConfigMap 이 환경마다 있다(개발/운영의 `boot-factory/boot-factory-auth-env`).
 * 이 값이 없으면 이력에서 둘을 구분할 수 없고, 내보내 `kubectl apply -f` 할 때 **다른 환경의
 * YAML 을 복원**할 수 있다. 그래서 표시용이 아니라 저장 폴더를 가르는 키로도 쓴다.
 */
export interface CmBackupOrigin {
  /** SSH 접속 대상(IP·호스트명) — 사용자가 바꾸지 않는 정체 */
  host?: string
  /**
   * `kubectl config current-context`.
   * 한 점프 서버에서 kubeconfig 컨텍스트만 바꿔 여러 클러스터를 다루므로 host 만으로는 부족하다.
   */
  context?: string
  /** 세션 별칭 "운영-306ha (10.20.30.41)" — 사람이 알아보는 이름. 바뀔 수 있어 키로는 쓰지 않는다 */
  alias?: string
  /** 접속 계정 */
  user?: string
}

export interface ConfigMapBackup {
  /** 파일명에서 뽑은 저장 시각 (epoch ms) */
  at: number
  file: string
  namespace: string
  name: string
  sizeBytes: number
  /**
   * 저장 폴더 이름. 환경이 다르면 폴더도 다르므로 (namespace, name) 만으로는 파일을 찾을 수 없다 —
   * 내보내기는 이 값으로 찾는다.
   */
  dir: string
  /** v2.6.0 이전 백업에는 없다(그때는 환경을 기록하지 않았다). 없으면 '환경 미기록'으로 보여준다 */
  origin?: CmBackupOrigin
}

// ─────────────────────────────────────────────────────────────
// 서비스 포털 응답 감시 (가용성 검증 중 "포털이 언제 다시 쓸 수 있게 되는가")
//
// 왜 페이지가 아니라 API 인가:
//   포털은 SPA 라서 백엔드가 전멸해도 istio 가 HTML/JS 껍데기는 200 으로 내려준다.
//   그걸 재면 실제보다 한참 이른 시각이 '복구'로 기록된다. 페이지를 그릴 때 실제로
//   부르는 API 를 재야 의미가 있다 — 브라우저 개발자도구 Network 탭에 찍히는 그 요청들.
// ─────────────────────────────────────────────────────────────

/** 응답 본문에 대한 정상 조건 하나 */
export interface PortalCheck {
  /**
   * 응답 JSON 안의 위치. 점/대괄호 표기.
   *   ""            → 본문 전체
   *   "content"     → { content: [...] } 의 배열
   *   "data.items"  · "rows[0].status"
   * JSON 이 아니면(HTML 등) 본문 문자열 자체를 대상으로 본다.
   */
  path: string
  /**
   * nonEmptyArray  배열이고 1개 이상          — 목록 API 의 기본값
   * exists         값이 있고 null 이 아님
   * gte            숫자로 읽어 value 이상
   * contains       문자열에 value 포함
   * notContains    문자열에 value 없음        — 에러 문구 배제용
   * regex          value 를 정규식으로 매칭
   */
  op: 'nonEmptyArray' | 'exists' | 'gte' | 'contains' | 'notContains' | 'regex'
  value?: string
}

/** 감시 대상 하나 = 포털 페이지가 부르는 API 한 건 */
export interface PortalTarget {
  id: string
  /** 화면에 보일 이름 — "인스턴스 목록", "대시보드 요약" 처럼 페이지 기준으로 */
  name: string
  /** 같은 페이지에서 부르는 것들을 묶는 이름 — "인스턴스 상세" 등 */
  group?: string
  enabled: boolean
  method: 'GET' | 'POST' | 'HEAD'
  /** baseUrl 뒤에 붙일 경로. `http` 로 시작하면 그 주소를 그대로 쓴다(다른 도메인 감시용) */
  path: string
  /** POST 본문 (JSON 문자열) */
  body?: string
  /** 이 대상에만 추가로 붙일 헤더 */
  headers?: Record<string, string>
  /** 로그인 토큰을 붙일지 — 로그인 페이지 자체는 false */
  auth: boolean
  /** 정상으로 볼 HTTP 상태 (비우면 200) */
  expectStatus?: number[]
  /** 본문 정상 조건 — 전부 통과해야 정상. 비우면 상태 코드만 본다 */
  checks?: PortalCheck[]
  /** 이 대상만 연속 성공 횟수를 다르게 (비우면 전역값) */
  successStreak?: number
  /** 늦게 복구되는 게 정상인 대상에 남기는 메모 (예: "Thanos 스크랩 주기만큼 지연") */
  note?: string
}

/** 토큰 발급 방식 */
export interface PortalAuth {
  /**
   * login  아이디/비밀번호로 로그인 API 호출 — 기본이자 유일하게 오래 버티는 방식
   * token  발급받은 access token 을 직접 붙여넣음 — 로그인 API 를 아직 모를 때 잠깐 확인용
   * none   토큰 없이 감시 (공개 페이지만)
   *
   * 비밀번호를 프런트에서 암호화해 보내는 포털이라면 (개발자도구 Payload 에
   * `"password":"NjEzODQz…="` 처럼 찍히면) **그 암호문을 그대로 붙여넣으면 된다.**
   * AES-CBC 는 복호화에 필요한 IV 를 암호문 앞에 동봉하므로, 캡처한 값을 다시 보내도
   * 서버는 매번 같은 비밀번호로 복호화한다. 비밀번호를 바꾸기 전까지 계속 통한다.
   *
   * 없앤 방식 — 다시 만들지 말 것:
   *   browser  앱 안에 로그인 창을 띄워 세션 쿠키를 읽는 방식. CONTRABASS 포털은 토큰이
   *            만료되면 로그인 화면으로 떨어지며 쿠키를 통째로 지운다. 창 새로고침도,
   *            재발급 API 를 창 안에서 호출하는 것도 새 토큰을 주지 않았다(HTTP 200, 토큰 불변).
   *   refresh  refresh token 으로 재발급. 이 포털의 /token/verify/refresh 는 `{authenticated}`
   *            만 답하고 토큰을 주지 않는다. 재발급 API 가 생기면 그때 다시 만든다.
   */
  mode: 'none' | 'token' | 'login'

  /** mode='token' 일 때 직접 넣은 값 */
  token?: string
  /** mode='login' — 로그인 API 경로/본문 템플릿. 본문의 {{id}} {{pw}} 가 치환된다 */
  loginPath?: string
  loginBody?: string
  username?: string
  /** 저장 시 safeStorage 로 암호화된다 (평문으로 파일에 남지 않는다) */
  password?: string

  /**
   * ── 2차 인증(MFA) ────────────────────────────────────────
   *
   * 로그인 한 번으로 끝나지 않고 **인증번호 6자리를 다시 묻는** 포털이 있다. 그런 곳은
   * 요청이 두 번이다: 로그인 → (중간 토큰/세션) → 인증번호 확인 → 그때 진짜 토큰.
   *
   * 인증번호가 본문에 같이 실려 한 번에 끝나는 포털이라면 여기를 비워 두고
   * `loginBody` 에 칸을 하나 더 적으면 된다 — 본문은 적은 그대로 나간다.
   *
   * **고정 인증번호에만 쓸 수 있다.** 30초마다 바뀌는 진짜 OTP 는 우리가 만들어 낼 수
   * 없으므로(비밀키가 있어야 한다), 검증 환경에서 코드를 고정해 둔 경우만 해당한다.
   * 하는지 안 하는지는 아래 `mfaEnabled` 스위치가 정한다.
   */
  /**
   * 2차 인증을 쓸지. **경로를 지우지 않고 끄고 켜기 위한 스위치다.**
   *
   * 처음에는 `mfaPath` 가 비었는지로만 판단했는데, 환경마다 경로·본문·중간 값 위치가
   * 고정이라 끌 때마다 지웠다가 켤 때 다시 적어야 했다(사용자 지적). 값은 그대로 두고
   * 이 스위치만 내린다.
   *
   * 그다음에도 `경로 && 스위치` 로 보다가 한 번 더 걸렸다 — 경로가 빈 설정에서는 '켜기'
   * 를 눌러도 화면이 그대로여서 버튼이 죽은 것처럼 보였다. **지금은 스위치가 곧 상태다**
   * (`mfaEnabledOf`). 대신 켤 때 빈 칸을 기본값으로 채우고, 켜 놓고 빈 칸이 남으면 그
   * 사실을 화면과 로그인 문구에서 짚는다.
   *
   * `undefined` 는 **예전 설정**이다 — 그때는 경로가 채워져 있으면 켠 것으로 본다.
   * 그래야 이 값을 모르는 채 저장된 설정이 조용히 꺼지지 않는다.
   * 새 기본값은 **꺼짐**이다(2차 인증이 없는 환경이 아직 있다).
   */
  mfaEnabled?: boolean
  /** 인증번호를 확인하는 2단계 경로 (POST). 기본값은 portal.ts 의 MFA_DEFAULTS */
  mfaPath?: string
  /** 1단계 응답에서 중간 토큰을 꺼낼 위치. 쿠키로만 이어지는 포털이면 비워 둔다 */
  mfaTokenPath?: string
  /** 2단계 요청 본문. {{otp}} {{mfaToken}} {{id}} 가 치환된다 */
  mfaBody?: string
  /** 고정 인증번호 (예: 123456) */
  otp?: string

  /** 응답에서 access token 을 꺼낼 위치. 예: "accessToken", "data.accessToken" */
  tokenPath?: string
  /** 토큰을 실을 헤더 이름과 형식 */
  header?: string
  headerFormat?: string
  /** 같은 토큰을 쿠키로도 보내야 하는 포털이면 쿠키 이름 (예: accessToken) */
  cookieName?: string
  /**
   * 토큰을 미리 다시 받아오는 주기(분). 0/빈값이면 만료를 겪은 뒤에만(401) 재발급한다.
   *
   * 401 자동 재발급만으로도 대개 충분하지만, 만료 직후의 한 주기가 '비정상' 으로 한 번
   * 찍히면서 연속 성공 카운트가 초기화된다. 토큰 수명을 아는 포털이라면 그보다 짧게
   * 잡아 두는 편이 측정이 깔끔하다. (예: 수명 10분 → 8)
   */
  reissueMinutes?: number
  /**
   * 응답 본문에 이 문구가 있으면 HTTP 상태와 무관하게 '토큰 만료'로 본다.
   *
   * 포털에 따라 토큰이 죽어도 HTTP 200 에 에러 봉투만 담아 주는 경우가 있다.
   * 그러면 401 감지가 안 걸려 재발급이 영영 안 돌고, 전 구간이 비정상으로 남는다.
   * 예: CONTRABASS 는 `{"status":"TOKEN_NOT_VERIFY","returnCode":604,…}` 를 준다.
   */
  expiredBodyMatch?: string
}

export interface PortalConfig {
  /** 예: https://306ha.bf.okestro.cloud — 도메인이 바뀌면 여기만 고치면 된다 */
  baseUrl: string
  /** 사내 자체서명 인증서를 쓰는 포털이면 켠다 */
  insecureTLS: boolean
  auth: PortalAuth
  intervalSec: number
  timeoutMs: number
  /**
   * 몇 번 연속으로 정상이어야 '복구'로 인정할지.
   * 1 로 두면 안 된다 — 페일오버 중에는 레플리카 한 대만 살아나 200 이 한 번 튀었다가
   * 다시 503 이 되는 일이 흔하고, 그 첫 200 을 복구 시각으로 적으면 실제보다 이르다.
   */
  successStreak: number
  targets: PortalTarget[]
}

/** main 프로세스가 실제 HTTP 요청을 하고 돌려주는 결과 */
export interface PortalHttpResult {
  ok: boolean
  status?: number
  /** 소문자 키로 정규화된 응답 헤더 */
  headers?: Record<string, string>
  /**
   * Set-Cookie 를 **쪼개지 않은 원본 그대로**.
   *
   * `headers['set-cookie']` 는 여러 줄을 ', ' 로 이어 붙인 값이라 다시 가를 수 없다 —
   * 쿠키 속성에 쉼표가 들어가기 때문이다(`Expires=Wed, 21 Oct …`). 2차 인증처럼 1단계
   * 세션을 2단계로 물려줘야 하는 곳에서는 원본이 필요하다.
   */
  setCookies?: string[]
  body?: string
  /** 요청 시작 → 본문 수신 완료까지 */
  latencyMs?: number
  /** X-Envoy-Upstream-Service-Time — istio 가 느린 건지 백엔드가 느린 건지 가른다 */
  upstreamMs?: number
  error?: string
  timedOut?: boolean
}


// ─────────────────────────────────────────────────────────────
// 성능 테스트 (Locust) — 부하는 **이 PC 에서** 발생시키고 대상만 세션에서 가져온다.
//
// 왜 로컬 발생인가: 이 앱은 SSH 도구지만, 부하 발생기를 원격에 올리면 그 서버에 파이썬을
// 설치하고 방화벽을 열어야 한다. "지금 이 서비스가 얼마나 받아내는가" 를 보려는 것이므로
// 내 PC → 대상 이 가장 빨리 답이 나온다. 대상이 사설망이면 이미 있는 포트 포워딩을 쓴다.
//
// 왜 Locust 인가: 돌고 있는 동안의 대시보드를 http(127.0.0.1)로 띄워 준다 — 그래서 앱 안
// iframe 이 개발·배포에서 똑같이 동작한다. JMeter 리포트는 file:// 이라 dev 에서 막힌다.
//
// **JMeter 는 뺐다가(2026-09-04) 같은 날 되살렸다.** 뺀 이유는 절반이 겉돌아서였다 —
// 폼으로 .jmx 를 만들어 줄 수 없고(GUI 로 만드는 XML), 실행 중 대시보드가 없어 시계열·
// 워밍업·계단식이 빠진다고 보았다. 되살린 이유는 **이미 .jmx 자산이 있는 팀에게는 그
// 절반이라도 값이 있기 때문**이다(사용자 판단). 대신 겉도는 자리를 숨기지 않고 그때그때
// 이유를 적는다 — '없는 기능을 회색으로 두고 왜인지 말하지 않는 것' 이 원래 문제였다.
//
// **그 뒤 시계열·워밍업은 되게 만들었다(2026-09-05).** "JMeter 는 초 단위 이력이 없다" 는
// 사실이 아니었다 — 대시보드가 쓰는 statistics.json 이 합계만 담고 있었을 뿐, 원본
// `result.jtl` 은 요청마다 timeStamp·elapsed 를 남긴다. 그것을 초 단위로 접어 Locust 이력
// CSV 와 **같은 칸 이름**으로 내놓는다(electron/jtl.ts). 그래서 그래프·워밍업 제외·판정이
// 도구를 구분하지 않는다. 아직 못 하는 것은 **실행 중 화면**(JMeter 는 웹 UI 가 없다)과
// **계단식**(스레드 수는 계획 파일이 정한다) 둘뿐이다.
// ─────────────────────────────────────────────────────────────

/** 성능 테스트 실행 환경 점검 결과 — 없는 것을 **무엇을 하면 되는지**와 함께 돌려준다 */
export interface PerfEnvStatus {
  ok: boolean
  /** 찾은 실행 방법 (표시용): `locust` · `python -m locust` · 사용자가 지정한 경로 */
  how?: string
  /** locust --version 첫 줄 */
  version?: string
  /** 무엇이 없는지 (사람이 읽는 문장) */
  problem?: string
  /** 무엇을 하면 되는지 (설치 명령 등) */
  hint?: string
}

/** 시나리오의 한 단계 — 요청 하나 */
export interface PerfStep {
  /** 통계에 찍힐 이름. 비우면 경로를 쓴다(쿼리스트링이 다른 요청을 한 줄로 묶을 때 유용) */
  name?: string
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  path: string
  /** 본문 (GET·DELETE 면 무시) */
  body?: string
  /** 이 단계만의 헤더 (공통 헤더에 덮어쓴다) */
  headers?: Record<string, string>
  /**
   * 상대 비율. 목록 조회 10 : 생성 1 처럼 실제 트래픽 모양을 흉내낸다.
   * `order: 'sequential'` 이면 무시된다(순서대로 한 번씩 돌므로).
   */
  weight: number
}

/** 폼으로 만드는 시나리오 — locustfile.py 를 앱이 생성한다 */
export interface PerfFormScenario {
  kind: 'form'
  /**
   * 단계들.
   *
   * 예전 형식(2.8.0)은 `paths`+`method` 하나뿐이라 "목록 → 상세 → 생성" 같은 흐름을 못 만들고
   * 비율도 줄 수 없었다. 새 형식은 단계마다 메서드·본문·헤더·비율을 갖는다.
   * 예전 회차를 그대로 읽어야 하므로 옛 칸도 남겨 두고 `normalizeFormScenario` 로 합쳐 쓴다.
   */
  steps?: PerfStep[]
  /**
   * `weighted` — 비율대로 무작위 선택(각 사용자가 계속 아무 단계나 고른다).
   * `sequential` — 한 사용자가 1→2→3 순서대로 돈다. 로그인 후 조회처럼 앞 단계가 있어야
   *   뒤가 되는 흐름에 쓴다.
   */
  order?: 'weighted' | 'sequential'
  /** 모든 단계에 붙는 공통 헤더 (인증 토큰 같은 것) */
  commonHeaders?: Record<string, string>
  /**
   * 실패한 응답의 본문을 표본으로 남길지.
   *
   * Locust 는 실패를 "HTTPError('503 …')" 같은 한 줄로만 남긴다. 그런데 인프라에서는 그
   * 본문이 게이트웨이 오류 페이지인지 애플리케이션 오류인지가 원인을 가른다.
   */
  captureFailures?: boolean
  /** 요청 사이 대기 (초) — 실사용자 흉내. 0,0 이면 쉬지 않고 때린다 */
  waitMinSec: number
  waitMaxSec: number

  // ── 예전 형식 (읽기 전용) ──────────────────────────────────
  /** @deprecated 2.8.0 형식. `steps` 로 옮겨 읽는다 */
  paths?: string[]
  /** @deprecated 2.8.0 형식 */
  method?: 'GET' | 'POST'
  /** @deprecated 2.8.0 형식 */
  body?: string
  /** @deprecated 2.8.0 형식 */
  headers?: Record<string, string>
}

/**
 * 예전·현재 형식을 하나로 합쳐 읽는다.
 *
 * **왜 shared-types 에 함수가 있나**: 메인(locustfile 생성)과 렌더러(화면 표시)가 똑같은
 * 규칙으로 읽어야 한다. 한쪽에만 두면 다른 쪽이 옛 회차를 다르게 해석해, 화면에 보이는
 * 시나리오와 실제로 돌아간 시나리오가 어긋난다.
 */
export function normalizeFormScenario(sc: PerfFormScenario): {
  steps: PerfStep[]
  order: 'weighted' | 'sequential'
  commonHeaders: Record<string, string>
  waitMinSec: number
  waitMaxSec: number
  captureFailures: boolean
} {
  const wMin = Math.max(0, sc.waitMinSec ?? 0)
  const wMax = Math.max(wMin, sc.waitMaxSec ?? 0)
  if (sc.steps && sc.steps.length) {
    return {
      steps: sc.steps
        .map((st) => ({ ...st, path: (st.path ?? '').trim(), weight: Math.max(1, Math.round(st.weight || 1)) }))
        .filter((st) => st.path),
      order: sc.order ?? 'weighted',
      commonHeaders: sc.commonHeaders ?? {},
      waitMinSec: wMin,
      waitMaxSec: wMax,
      captureFailures: !!sc.captureFailures,
    }
  }
  // 예전 형식: 경로마다 같은 메서드·본문, 비율 균등
  const paths = (sc.paths ?? []).map((x) => (x ?? '').trim()).filter(Boolean)
  return {
    steps: (paths.length ? paths : ['/']).map((path) => ({
      method: sc.method ?? 'GET',
      path,
      body: sc.body,
      weight: 1,
    })),
    order: 'weighted',
    commonHeaders: sc.headers ?? {},
    waitMinSec: wMin,
    waitMaxSec: wMax,
    captureFailures: false,
  }
}

/** 사용자가 직접 쓴 locustfile.py */
export interface PerfFileScenario {
  kind: 'file'
  path: string
}

/**
 * 어느 도구로 돌릴지.
 *
 * Locust 가 기본이다(실행 중 대시보드가 http 라 앱 안에 끼워지고, 사전조건이 pip 하나다).
 * JMeter 는 **이미 .jmx 자산이 있는 팀**을 위한 길이다 — Java 가 필요하고, 시나리오를 폼으로
 * 만들어 줄 수 없으며(.jmx 는 GUI 로 만드는 XML), 실행 중 화면이 없다.
 */
export type PerfTool = 'locust' | 'jmeter'

export interface PerfRunConfig {
  /** 없으면 locust (2.8.0 회차 호환) */
  tool?: PerfTool
  /** 대상을 가져온 세션 (표시·기록용. 부하는 로컬에서 나간다) */
  sessionId?: string
  sessionLabel?: string
  targetUrl: string
  users: number
  spawnRate: number
  durationSec: number
  /**
   * 판정 기준. **없으면 초록 PASS 를 띄우지 않는다** — 측정값만 보여준다.
   * (verdict.ts 의 3-상태 규칙과 같은 이유: 기준 없는 초록은 근거 없는 안심이다)
   */
  p50ThresholdMs?: number
  p95ThresholdMs?: number
  p99ThresholdMs?: number
  errorRateThresholdPct?: number
  /**
   * 판정에서 뺄 앞부분(초).
   *
   * 사용자가 붙는 동안(램프업)은 응답이 느리게 나오고 그 값이 전체 p95 를 끌어올린다.
   * "안정된 뒤에 기준을 만족하는가" 를 보려면 그 구간을 빼야 한다. 뺄 때는 초 단위 이력
   * (run_stats_history.csv)의 **구간 p95 중 최댓값**으로 판정한다 — 백분위는 평균처럼
   * 다시 합칠 수 없으므로 '구간 최댓값' 이라고 화면에도 그대로 적는다.
   */
  warmupSec?: number
  scenario: PerfFormScenario | PerfFileScenario
  /** 자체 서명 인증서를 무시할지 (사내 인프라는 대개 필요) */
  insecureTls?: boolean
  /**
   * 계단식 부하 — 한계점을 찾을 때 쓴다.
   *
   * 비어 있으면 `users`/`spawnRate`/`durationSec` 로 평평하게 돈다. 값이 있으면 Locust 의
   * LoadTestShape 을 만들어 넣고, 그때는 `-u/-r/-t` 를 넘기지 않는다(Locust 가 무시하면서
   * 경고를 내므로 애초에 주지 않는다).
   */
  stages?: { users: number; spawnRate: number; holdSec: number }[]
  /**
   * 이 PC 에서 몇 개 프로세스로 나눠 돌릴지 (`--processes`).
   *
   * 파이썬 한 프로세스는 코어 하나만 쓴다(GIL). 부하가 커지면 **대상이 아니라 내 PC 가**
   * 먼저 한계에 걸리는데, 그때 나온 응답 시간은 서버 성능이 아니다. 코어를 나눠 쓰면 그
   * 천장을 올릴 수 있다. 1 이면 넘기지 않는다.
   */
  processes?: number
  /**
   * 다른 PC 를 워커로 붙일 개수 (`--master --expect-workers N`).
   *
   * 앱은 master 만 띄우고 **워커는 사람이 다른 PC 에서 직접 실행한다** — 우리가 남의 PC 에
   * 파이썬을 깔고 프로세스를 띄울 수는 없다. 그래서 붙일 명령을 화면에 그대로 보여준다.
   */
  expectWorkers?: number
}

/**
 * 저장해 두는 검증 설정 (시나리오 + 부하 + 기준).
 *
 * 같은 검증을 다음 주에 또 돌리고, 다른 사람에게도 넘겨야 한다. 프리셋·시나리오와 같은
 * 방식(userData JSON + 내보내기/가져오기)으로 둔다 — 빌드 없이 늘릴 수 있게.
 */
export interface PerfPreset {
  id: string
  name: string
  /** 만든/고친 시각 */
  savedAt: number
  /** 대상 주소는 환경마다 달라 저장하지 않는다(세션에서 다시 채운다) */
  config: Omit<PerfRunConfig, 'sessionId' | 'sessionLabel' | 'targetUrl'>
}

/** 회차 하나 — userData/perf-runs/<id>/run.json */
export interface PerfRunMeta {
  id: string
  startedAt: number
  endedAt?: number
  config: PerfRunConfig
  exitCode?: number
  /** 사용자가 중지시켰는가 — 중간에 끊긴 수치를 '결과' 로 읽지 않도록 남긴다 */
  canceled?: boolean
  /** 돌고 있는 동안의 대시보드 주소 (종료 후에는 안 열린다) */
  webUrl?: string
  /** 종료 후 자체 HTML 리포트 */
  reportPath?: string
  /** locust --csv 접두어 — `<prefix>_stats.csv` 등 */
  csvPrefix?: string
  /** 실행에 쓴 locustfile 경로 (폼으로 만든 것도 여기 남는다) */
  scenarioPath?: string
  /**
   * 사람이 붙인 이름·메모.
   *
   * 회차가 쌓이면 시각만으로는 못 찾는다 — "게이트웨이 튜닝 전/후" 같은 한마디가 있어야
   * 나중에 비교할 짝을 고를 수 있다. 실행이 끝난 뒤에도 고칠 수 있어야 하므로 별도 IPC 로 쓴다.
   */
  label?: string
  memo?: string
}

/** 회차 + 통계 원본 — 요약 계산은 렌더러(src/lib/perfParse)가 한다 */
export interface PerfRunRecord {
  meta: PerfRunMeta
  /** `<prefix>_stats.csv` 내용. 없으면(중지·실패) 없음 */
  statsCsv?: string
  /** `<prefix>_failures.csv` 내용. 실패가 없으면 파일 자체가 없다 */
  failuresCsv?: string
  /** JMeter 회차의 `report/statistics.json` 내용 */
  jmeterStatsJson?: string
}

/**
 * 회차 보관 기준.
 *
 * 회차 하나가 리포트 950KB + CSV 몇 개다. 100번 돌리면 100MB 가 쌓이는데, 정작 사람이
 * 되돌아보는 것은 최근 몇 회차다. 세션 로그와 같은 방식(개수·기간 둘 중 하나라도 넘으면
 * 정리)으로 두되, 기본값은 더 넉넉하게 잡는다 — 성능 회차는 하루에 몇 번 돌리는 것이지
 * 세션 로그처럼 계속 쌓이는 것이 아니다.
 */
export interface PerfRetention {
  maxRuns: number
  retentionDays: number
}

/** perf:log 이벤트 — 100ms 씩 묶어서 온다(줄마다 보내면 렌더러가 멎는다) */
export interface PerfLogEvent {
  runId: string
  /** locust 는 진행 로그를 stderr 로 낸다 — 그것만으로 오류라고 볼 수 없어 출처를 남긴다 */
  stream: 'stdout' | 'stderr'
  text: string
}

/** perf:done 이벤트 */
export interface PerfDoneEvent {
  runId: string
  exitCode?: number
  canceled?: boolean
  error?: string
}
