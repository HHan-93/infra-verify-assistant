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
    system: `당신은 리눅스/유닉스 쉘 명령어 전문가입니다. 사용자의 자연어 요청을 실행 가능한 쉘 명령어 한 줄로 변환하세요.
반드시 아래 형식으로만 답하고, 다른 텍스트·코드블록·마크다운은 절대 추가하지 마세요.
COMMAND: <명령어>
설명: <한국어로 한 줄 설명>
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

/** 세션 로그(.cast.jsonl) 자동 정리 기준 — 렌더러(로그뷰어)에서 조회/변경 가능 */
export interface LogRetentionSettings {
  retentionDays: number
  maxEntries: number
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
  /**
   * 같은 하위분류 안에서의 표시 순서. 내장 명령어는 배열 인덱스(0,1,2..)를 암묵적 순서로 쓰고,
   * 사용자 정의 항목은 이 값으로 그 사이 어디든 끼워 넣을 수 있음(소수점 사용, 두 이웃의 중간값).
   * 미지정 시 생성 시각(ms)을 사용해 내장 항목들보다 항상 뒤로 감.
   */
  order?: number
}

/** 사용자가 앱 내에서 직접 추가한 시나리오(순서가 있는 여러 단계) */
export interface CustomScenarioStep {
  title: string
  command: string
  desc: string
  note?: string
  info?: string
  warn?: string
  code?: string
}
export interface CustomScenario {
  id: string
  solution: string
  title: string
  summary: string
  steps: CustomScenarioStep[]
  /** 같은 카테고리 안에서의 표시 순서 — CustomPresetCommand.order 와 동일한 규칙 */
  order?: number
}
