import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ListChecks,
  X,
  Play,
  Loader2,
  ChevronDown,
  ChevronRight,
  Check,
  Ban,
  SkipForward,
  ClipboardCopy,
  Save,
  ScanText,
  Info,
  Square,
  Pause,
  Pencil,
  Server,
  Variable,
  MessageSquareReply,
  RotateCcw,
  AlertTriangle,
} from 'lucide-react'
import type { CommandCheck, CaptureRule, ExpectRule, OnFailureAction } from '../../electron/shared-types'
import { judgeOutput, hasCheck, type Verdict } from '../lib/verdict'
import { extractPlaceholders, fillPlaceholders, hasPlaceholder } from '../lib/placeholder'
import { maskForExport } from '../lib/mask'
import type { ScenarioRunDetail, ScenarioRunStep } from '../../electron/shared-types'
import { splitShell, opLabel } from '../lib/shellSplit'

export interface RunnerStep {
  title: string
  command: string
  desc?: string
  warn?: string
  check?: CommandCheck
  /** 이 스텝을 실행할 '역할' 이름 (실행 창에서 역할 → 세션 매핑). 비우면 기본 대상 */
  target?: string
  /** 출력에서 값을 뽑아 이후 스텝의 <이름> 플레이스홀더로 넘김 */
  capture?: CaptureRule[]
  /** 대화형 프롬프트 자동 응답 */
  expect?: ExpectRule[]
  /** 실패 시 동작 (기본 stop) */
  onFailure?: OnFailureAction
  /** onFailure==='run' 일 때 실행할 명령 */
  onFailureCommand?: string
  /** 대응 명령의 단계 설명 — 명령 조각과 순서대로 짝지어 보여준다 (scenarios.ts 주석 참고) */
  onFailureDesc?: string[]
  /** 이 스텝이 만든 변경을 되돌리는 명령 (검증 후 '원복 실행'에서 역순 수행) */
  undo?: string
}
export interface RunnerScenario {
  /**
   * 시나리오 id — **이력에서 같은 시나리오의 회차끼리 묶는 기준**이다.
   * 없으면 제목으로 묶는다(옛 호출부·임시 시나리오). 제목을 고치면 그 뒤 회차가 다른 줄로
   * 갈리지만, id 를 안 주는 쪽에서 할 수 있는 최선이다.
   */
  id?: string
  title: string
  summary: string
  steps: RunnerStep[]
  /**
   * 입력값 ← 역할의 접속 주소. 예: { "Target_IP": "서버" }
   * 역할을 나눠 세션을 지정해 놓고 그 주소를 또 손으로 넣게 하면 앞뒤가 안 맞는다.
   */
  roleValues?: Record<string, string>
}
interface RunTarget {
  id: string
  name: string
  /**
   * 저장된 프로필 키(host:port:username). 대상 지정을 다음에 열 때도 복원하는 데 쓴다.
   * 세션 id 는 앱을 껐다 켜면 다른 서버에 재할당될 수 있어 영속 키로 쓸 수 없다.
   */
  profileKey?: string
}

// ── 대상 지정 영속화 ───────────────────────────────────────────
// 같은 시나리오를 여러 번 돌리는 게 검증 작업의 기본이라, 역할·스텝별 대상을 매번 다시
// 고르게 하면 안 된다. 시나리오 제목별로 저장하고 다음에 열 때 복원한다.
const TARGETS_KEY = 'scenario_runner_targets_v1'
interface SavedTargets {
  /** 역할 이름 → 프로필 키 */
  roles: Record<string, string>
  /**
   * "스텝번호|스텝제목" → 프로필 키 목록 (제목이 바뀌면 무효 — 시나리오가 편집된 것).
   * 한 스텝을 여러 세션에서 돌릴 수 있어 배열이다. 예전 버전은 문자열 하나였으므로 읽을 때 보정한다.
   */
  steps: Record<string, string[]>
}
function loadTargets(scenarioTitle: string): SavedTargets {
  try {
    const all = JSON.parse(localStorage.getItem(TARGETS_KEY) ?? '{}') as Record<string, SavedTargets>
    const t = all[scenarioTitle]
    if (t && typeof t === 'object') {
      // 구버전(스텝당 키 하나)을 배열로 승격 — 저장해 둔 지정이 조용히 사라지지 않게
      const steps: Record<string, string[]> = {}
      for (const [k, v] of Object.entries(t.steps ?? {})) {
        if (Array.isArray(v)) steps[k] = v.filter(Boolean)
        else if (typeof v === 'string' && v) steps[k] = [v]
      }
      return { roles: t.roles ?? {}, steps }
    }
  } catch {
    /* 손상됐으면 빈 값으로 시작 */
  }
  return { roles: {}, steps: {} }
}
function saveTargets(scenarioTitle: string, t: SavedTargets): void {
  try {
    const all = JSON.parse(localStorage.getItem(TARGETS_KEY) ?? '{}') as Record<string, SavedTargets>
    all[scenarioTitle] = t
    localStorage.setItem(TARGETS_KEY, JSON.stringify(all))
  } catch {
    /* 용량 초과 등은 무시 — 편의 기능이라 검증 자체를 막지 않는다 */
  }
}
/** 스텝 저장 키 — 인덱스만 쓰면 시나리오를 편집해 순서가 바뀌었을 때 엉뚱한 스텝에 붙는다 */
const stepKeyOf = (idx: number, title: string) => `${idx}|${title}`
/** "별칭 (10.0.0.1)" → "별칭" — 스텝 행의 좁은 드롭다운에 넣을 짧은 이름 */
const svcShort = (n: string) => n.split(' (')[0]

/**
 * 네이티브 select 의 펼침 목록은 OS/브라우저가 그린다 — select 배경이 투명하거나 반투명이면
 * Windows Chromium 이 흰 바탕을 쓰고 밝은 글자가 얹혀 글씨가 안 보인다.
 * 그래서 select 와 option 모두에 '불투명한' 색을 직접 지정한다.
 */
const OPT_STYLE = { backgroundColor: '#2a2a3c', color: '#e5e7eb' } as const

interface ScenarioRunnerProps {
  scenario: RunnerScenario
  sessions: RunTarget[]
  defaultSessionId?: string
  onClose: () => void
  /** 리포트를 AI 패널로 보내 분석 (스트리밍 중이면 false) */
  onAnalyze?: (text: string) => boolean
}

type StepStatus = 'pending' | 'running' | 'ran' | 'error'

/**
 * 한 스텝을 한 대상에서 실행한 결과.
 * 스텝이 여러 세션을 대상으로 할 수 있어(패키지 설치처럼 모든 노드에 필요한 작업),
 * 결과를 대상별로 따로 보관한다 — A 는 성공 B 는 실패인 경우를 뭉개면 안 되기 때문.
 */
interface StepRun {
  sessionName: string
  out?: string
  err?: string
  code?: number
  verdict?: Verdict
  reasons?: string[]
  /** 실행 자체가 실패(미연결/셸 오류)했을 때의 메시지 */
  error?: string
  timedOut?: boolean
  replied?: string[]
}
interface StepResult {
  status: StepStatus
  out?: string
  err?: string
  code?: number
  verdict?: Verdict
  reasons?: string[]
  /** 사람이 직접 지정한 판정(자동 판정을 덮어씀, 안내 스텝의 유일한 판정 수단) */
  manual?: 'pass' | 'fail' | 'skip'
  /** 실제로 실행된 대상 세션 이름 (여러 대상이면 쉼표로 이어붙임) */
  sessionName?: string
  /** 대상별 실행 결과 — 대상이 하나여도 채워진다(리포트/표시 공통 경로) */
  runs?: StepRun[]
  /** 대응 명령으로 고친 뒤 재실행했는지 (리포트에 남긴다) */
  retried?: boolean
  /** 자동 응답한 대화형 프롬프트 요약 */
  replied?: string[]
  /** 이 스텝에서 뽑아낸 변수 */
  captured?: Record<string, string>
  /** 뽑지 못한 변수(정규식 불일치 등) */
  captureMisses?: string[]
  /** 실패 시 실행한 대응 명령의 결과 */
  failureRun?: { command: string; out: string; code?: number }
}

/** 스텝의 최종 판정 — 수동 지정이 있으면 그것, 없으면 자동 판정 */
type Effective = 'pass' | 'fail' | 'info' | 'skip' | 'manual-wait' | 'pending' | 'error'
function effectiveOf(step: RunnerStep, r: StepResult | undefined): Effective {
  if (r?.manual === 'skip') return 'skip'
  if (r?.manual === 'pass') return 'pass'
  if (r?.manual === 'fail') return 'fail'
  if (r?.verdict) return r.verdict
  // 실행을 시도했는데 오류로 끝난 스텝(연결 끊김/타임아웃 등)은 verdict 가 없다.
  // 이걸 'pending' 으로 두면 리포트에 "대기(미실행)" 로 찍혀 '아직 안 돌린 것' 과 구별되지 않고
  // 실패 카운트에서도 빠진다 — 검증 산출물로서 치명적이라 별도 상태로 구분한다.
  if (r?.status === 'error') return 'error'
  // 명령이 없는 안내 스텝은 사람이 판정해야 함
  if (!step.command.trim()) return 'manual-wait'
  return 'pending'
}

const EFFECTIVE_META: Record<Effective, { label: string; cls: string }> = {
  pass: { label: '정상', cls: 'bg-emerald-500/20 text-emerald-300' },
  fail: { label: '실패', cls: 'bg-red-500/25 text-red-300' },
  info: { label: '실행됨', cls: 'bg-emerald-500/10 text-emerald-300/80' },
  skip: { label: '건너뜀', cls: 'bg-violet-500/20 text-violet-300' },
  'manual-wait': { label: '수동 확인', cls: 'bg-sky-500/20 text-sky-300' },
  pending: { label: '대기', cls: 'bg-white/10 text-gray-500' },
  error: { label: '실행 오류', cls: 'bg-red-500/25 text-red-300' },
}

// <...> 플레이스홀더 — 검증 실행 전에 값을 한 번 받아 명령에 치환한다(VIP 등).
// 규칙은 프리셋/시나리오 편집기와 공유한다 (src/lib/placeholder.ts)
const hasUnfilled = hasPlaceholder

/**
 * 사람이 화면 앞에 앉아 있어야 하는 명령 — '전체 실행'에서 자동으로 돌리지 않는다.
 *
 * 왜: htop 을 러너가 돌리면 45초를 붙잡고 있다가 Ctrl+C 로 끊기고, 남는 건 전체화면 UI
 * 한 프레임이 뭉개진 출력뿐이다. 그런데 판정은 '실행됨' 이 붙는다 — 아무것도 검증하지
 * 않았는데 검증한 것처럼 리포트에 남는 게 이 도구에서 가장 나쁜 결과다.
 *
 * 개별 '실행' 버튼으로는 그대로 돌릴 수 있다. 그건 사용자가 보고 누른 것이므로 막지 않는다.
 */
const INTERACTIVE_RULES: { re: RegExp; why: string }[] = [
  { re: /(^|[|;&]\s*)(sudo\s+)?(htop|iotop|iftop|nmon|atop|glances)\b/i, why: '전체화면 모니터 — q 를 눌러야 끝납니다' },
  { re: /(^|[|;&]\s*)(sudo\s+)?top\b(?![^|;&]*\s-b)/i, why: '전체화면 모니터 — 배치 모드(-b)가 아니면 끝나지 않습니다' },
  { re: /(^|[|;&]\s*)(sudo\s+)?watch\b/i, why: '주기 반복 실행 — Ctrl+C 를 눌러야 끝납니다' },
  { re: /(^|[|;&]\s*)(sudo\s+)?(vi|vim|nano|emacs)\b/i, why: '편집기가 열립니다 — 저장·종료를 사람이 해야 합니다' },
  { re: /(^|[|;&]\s*)(sudo\s+)?(less|more)\b/i, why: '페이저가 열립니다 — q 를 눌러야 끝납니다' },
  { re: /\btail\b[^|;&]*(\s-[a-zA-Z]*[fF]\b|\s--follow\b)/i, why: '로그를 계속 따라갑니다 — 스스로 끝나지 않습니다' },
  { re: /journalctl[^|;&]*\s-f\b/i, why: '로그를 계속 따라갑니다 — 스스로 끝나지 않습니다' },
  { re: /(^|[|;&]\s*)(sudo\s+)?nc\s+(-\S+\s+)*-l/i, why: '포트 수신 대기 — 터미널을 점유합니다' },
  {
    re: /kubectl\s+(edit|attach|port-forward)\b|kubectl\s+exec\s+(-\S+\s+)*-\S*it\b/i,
    why: '대화형 kubectl — 사람이 조작해야 합니다',
  },
  { re: /(^|[|;&]\s*)(sudo\s+)?ping\s+(?![^|;&]*-c\s)/i, why: '횟수 제한(-c)이 없어 끝나지 않습니다' },
  // while true; do … done 처럼 사람이 Ctrl+C 로 끊어야 하는 감시 루프
  { re: /\bwhile\s+(true|:)\b|\buntil\s+false\b|\bfor\s*\(\(\s*;;/i, why: '무한 반복 — Ctrl+C 를 눌러야 끝납니다' },
  // 사용자 전환 — 새 셸이 열려서 이후 스텝이 그 셸 안에서 돌아버린다
  { re: /(^|[|;&]\s*)(sudo\s+)?su\s+(-|--login|\S)/i, why: '다른 계정 셸로 진입 — 이후 스텝이 그 셸에서 돌게 됩니다' },
  // adduser/passwd 는 이름·비밀번호를 되묻는다 (--disabled-password --gecos "" 를 준 경우는 제외)
  {
    re: /(^|[|;&]\s*)(sudo\s+)?adduser\b(?![^|;&]*--disabled-password)|(^|[|;&]\s*)(sudo\s+)?passwd\b/i,
    why: '이름·비밀번호를 되묻습니다 — 터미널에서 직접 입력해야 합니다',
  },
]
/** 대화형이면 그 이유, 아니면 null */
function interactiveReason(cmd: string): string | null {
  for (const r of INTERACTIVE_RULES) if (r.re.test(cmd)) return r.why
  return null
}

/**
 * [호환 모드 전용] 영속 셸을 못 열었을 때만 쓰는 cd 추적.
 * 독립 exec 는 cd 가 유지되지 않아 명령에서 cd 대상을 긁어 다음 스텝 앞에 붙여준다.
 * 파이프라인·서브셸이 섞이면 틀릴 수 있는 근사치라, 영속 셸이 열리면 이 경로는 쓰지 않는다.
 */
function extractCdTarget(cmd: string): string | null {
  const m = [...cmd.matchAll(/(?:^|&&|;)\s*cd\s+([^\s&;|]+)/g)]
  return m.length ? m[m.length - 1][1] : null
}
function resolveCwd(current: string, target: string): string {
  if (target.startsWith('/') || target.startsWith('~')) return target // 절대/홈 기준 → 교체
  return current ? `${current}/${target}` : target // 상대 → 이어붙임
}

/** 출력에서 값을 뽑아 이후 스텝의 플레이스홀더로 넘길 값들을 계산 */
function applyCaptures(rules: CaptureRule[] | undefined, text: string): { values: Record<string, string>; misses: string[] } {
  const values: Record<string, string> = {}
  const misses: string[] = []
  for (const c of rules ?? []) {
    if (!c.name?.trim() || !c.regex?.trim()) continue
    let re: RegExp
    try {
      re = new RegExp(c.regex, 'm')
    } catch {
      misses.push(`${c.name}(정규식 오류: /${c.regex}/)`)
      continue
    }
    const m = text.match(re)
    const v = m ? (c.group === 0 ? m[0] : m[c.group ?? 1]) : undefined
    if (v == null || v === '') misses.push(`${c.name}(매칭 없음: /${c.regex}/)`)
    else values[c.name] = v
  }
  return { values, misses }
}

// ── 스텝 제한 시간 ────────────────────────────────────────────
/**
 * 예전엔 45초 고정이었는데, 그게 검증을 조용히 망가뜨리고 있었다.
 *   · `stress-ng --cpu 4 --timeout 60s` → 45초에 Ctrl+C. stress-ng 는 SIGINT 를 받아
 *     "successful run completed in 44.61 secs" 를 찍고 **0 으로** 끝난다 → '정상' 으로 기록.
 *     60초 부하를 걸었다고 리포트에 남지만 실제로는 44.6초만 돌았다.
 *   · `apt-get update && apt-get install` 은 미러가 느리면 45초를 그냥 넘긴다.
 * 그래서 (1) 기본값을 사용자가 고르고, (2) 명령이 스스로 소요시간을 말하면 그만큼은 기다린다.
 */
const TIMEOUT_KEY = 'scenario_runner_timeout_v1'
const TIMEOUT_CHOICES = [60, 120, 300, 600, 1800] as const
const DEFAULT_TIMEOUT_SEC = 120
/** 패키지 설치·다운로드처럼 네트워크에 좌우되는 명령의 최소 제한 시간 */
const SLOW_CMD_RE = /\b(apt|apt-get|aptitude|yum|dnf|zypper|pip3?|npm|wget|curl|docker\s+(pull|build)|git\s+clone)\b/i
const SLOW_CMD_FLOOR_MS = 300_000

const toMs = (n: string, unit?: string) => {
  const v = parseInt(n, 10)
  const u = (unit ?? 's').toLowerCase()
  return v * (u === 'h' ? 3_600_000 : u === 'm' ? 60_000 : 1000)
}
/** 명령이 명시한 소요 시간(stress-ng --timeout 60s, fio --runtime, sleep 30 …) */
function declaredDurationMs(cmd: string): number {
  let max = 0
  const seen = (ms: number) => {
    if (ms > max) max = ms
  }
  for (const m of cmd.matchAll(/--(?:timeout|runtime|time)[=\s]+(\d+)([smh]?)\b/gi)) seen(toMs(m[1], m[2]))
  for (const m of cmd.matchAll(/\bsleep\s+(\d+)([smh]?)\b/gi)) seen(toMs(m[1], m[2]))
  for (const m of cmd.matchAll(/\s-t\s+(\d+)([smh]?)\b/gi)) seen(toMs(m[1], m[2]))
  return max
}
/**
 * 이 명령에 실제로 적용할 제한 시간.
 * 명령이 "60초 돌리겠다"고 말했으면 60초 + 여유를 준다 — 자기가 끝나기 전에 우리가 끊으면 안 된다.
 */
function timeoutForCmd(cmd: string, baseMs: number): number {
  const declared = declaredDurationMs(cmd)
  const floor = SLOW_CMD_RE.test(cmd) ? SLOW_CMD_FLOOR_MS : 0
  return Math.max(baseMs, declared ? declared + 30_000 : 0, floor)
}
const fmtDur = (ms: number) => (ms >= 60_000 ? `${Math.round(ms / 60_000)}분` : `${Math.round(ms / 1000)}초`)

/**
 * 시나리오 검증 러너 — 시나리오의 각 스텝을 대상 세션에서 순차 실행(session:run 캡처)하고
 * 자동 판정(verdict)한다. 명령이 없는 안내 스텝은 검증자가 통과/실패/건너뜀을 수동 지정.
 * 최종 결과는 요약 + 스텝별 리포트(Markdown)로 복사/저장한다.
 */
export default function ScenarioRunner({
  scenario,
  sessions,
  defaultSessionId,
  onClose,
  onAnalyze,
}: ScenarioRunnerProps) {
  const [targetId, setTargetId] = useState(
    defaultSessionId && sessions.some((s) => s.id === defaultSessionId)
      ? defaultSessionId
      : sessions[0]?.id ?? '',
  )
  // 실행 대상이 끊기거나 탭이 닫히면 targetId 가 유령이 되어, 셀렉트가 비고 모든 스텝이
  // "연결되어 있지 않습니다" 로 실패한다. 목록이 바뀌면 살아있는 세션으로 다시 맞춰준다.
  useEffect(() => {
    if (targetId && sessions.some((s) => s.id === targetId)) return
    setTargetId(sessions[0]?.id ?? '')
  }, [sessions, targetId])
  // (역할/스텝 대상은 프로필 키로 들고 있어 세션이 끊겼다 붙어도 자동으로 다시 해석된다 —
  //  id 기반이었다면 여기서 유령 매핑을 걷어내는 정리 로직이 필요했다)
  const [results, setResults] = useState<Record<number, StepResult>>({})
  /**
   * ── 이력(회차) ───────────────────────────────────────────
   * 가용성 검증은 노드를 죽였다 살리는 일이라 **다시 돌려서 남길 수가 없다.** 그런데 이
   * 창은 오래 '리포트를 그 자리에서 복사·저장' 만 할 수 있었고, 닫으면 결과가 사라졌다 —
   * 저장을 잊은 회차는 영영 없는 것이 됐다. 그래서 전체 실행마다 자동으로 남긴다.
   *
   * 회차 id 는 **전체 실행을 시작할 때** 만든다. 끝난 뒤에 사람이 '수동 확인' 을 판정하고
   * 원복을 돌리는데, 그때마다 새 회차를 만들면 한 번의 검증이 목록에 여러 줄로 남는다 —
   * 같은 id 로 갱신한다(메인의 scenarioRuns:save 가 id 로 덮어쓴다).
   */
  const runIdRef = useRef<string | null>(null)
  const runStartRef = useRef(0)
  /**
   * 검증이 **끝난** 시각. 저장할 때의 Date.now() 를 쓰면 안 된다 — 끝난 뒤 사람이 '수동
   * 확인' 을 판정하면 같은 회차를 다시 저장하는데, 그때 시각으로 덮으면 30초짜리 검증이
   * '1시간 12분' 으로 남는다(리포트의 소요 칸이 그대로 거짓말이 된다).
   */
  const runEndRef = useRef(0)
  const runStoppedRef = useRef<{ stopped: boolean; at?: number }>({ stopped: false })
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const [busy, setBusy] = useState(false)
  /**
   * 개별 '실행' 버튼으로 도는 스텝의 인덱스.
   * 영속 셸은 세션당 한 번에 명령 하나만 받으므로(두 번째는 "이전 명령이 아직 실행 중입니다"),
   * 개별 실행이 겹치지 않게 막는다. 전체 실행(busy)과 합쳐 'running' 으로 판단한다.
   */
  const [soloIdx, setSoloIdx] = useState<number | null>(null)
  const running = busy || soloIdx !== null
  const [notice, setNotice] = useState('')
  /** 상단 경고 배너에서 '변경 명령 전문'을 펼쳤는지 (기본은 접힘 — 대응 명령이 길다) */
  const [mutOpen, setMutOpen] = useState(false)
  /**
   * 실패 복구 진행 상황 — 어느 스텝이 지금 '조치 중'인지 '재시도 중'인지.
   * 이게 없으면 화면에는 스피너만 돌아서, 사용자는 그냥 오래 걸리는 줄 안다.
   */
  const [recovering, setRecovering] = useState<{ idx: number; phase: 'fix' | 'retry' } | null>(null)
  /** 스텝 하나에 허용할 기본 제한 시간(초). 명령이 스스로 더 긴 시간을 말하면 그쪽을 따른다. */
  const [baseTimeoutSec, setBaseTimeoutSec] = useState<number>(() => {
    const v = Number(localStorage.getItem(TIMEOUT_KEY))
    return Number.isFinite(v) && v > 0 ? v : DEFAULT_TIMEOUT_SEC
  })
  const baseTimeoutMs = baseTimeoutSec * 1000
  useEffect(() => {
    localStorage.setItem(TIMEOUT_KEY, String(baseTimeoutSec))
  }, [baseTimeoutSec])
  // 스텝별 "복사" 클릭 후 잠깐 체크 표시할 인덱스
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null)
  // 시나리오 전체에서 쓰인 <...> 플레이스홀더 목록 + 사용자가 채운 값
  const allPlaceholders = useMemo(() => {
    const s: string[] = []
    for (const step of scenario.steps)
      for (const p of extractPlaceholders(step.command)) if (!s.includes(p)) s.push(p)
    return s
  }, [scenario.steps])
  const [phValues, setPhValues] = useState<Record<string, string>>({})
  /**
   * 스텝별 입력값 재정의 — "번호|제목" → { 플레이스홀더: 값 }.
   *
   * 상단 '검증 입력값'은 시나리오 전체에 하나씩만 적용된다. 그런데 실제 검증은 그렇지 않다 —
   * 예를 들어 포트 통신 시나리오는 TCP / UDP / HTTP 를 각각 다른 포트로 확인하는데,
   * <Port> 가 하나뿐이면 네 스텝이 전부 같은 포트로 나가서 검증이 성립하지 않는다.
   * 그래서 스텝마다 값을 따로 줄 수 있게 하고, 지정하지 않은 스텝만 상단 값을 따른다.
   */
  const [stepPh, setStepPh] = useState<Record<string, Record<string, string>>>({})
  // 이전 스텝의 출력에서 뽑아낸 값 (capture) — 사용자가 입력한 값보다 우선한다(더 최신이므로)
  const [captured, setCaptured] = useState<Record<string, string>>({})
  const capturedRef = useRef<Record<string, string>>({})
  capturedRef.current = captured
  // 실행 창에서 즉석 수정한 명령 (이번 실행에만 적용 — 원본 시나리오는 건드리지 않는다)
  const [editedCmds, setEditedCmds] = useState<Record<number, string>>({})
  const [editingIdx, setEditingIdx] = useState<number | null>(null)
  /**
   * 대상 선택 팝오버 — 스텝 인덱스 + '화면 기준' 좌표.
   *
   * 예전엔 스텝 행 안에 absolute 로 붙였는데, 스텝 목록이 overflow-y-auto 스크롤 영역이라
   * 아래쪽 스텝에서 열면 팝오버가 컨테이너 경계에서 잘려 세션을 고를 수가 없었다.
   * position:fixed 는 조상의 overflow 에 잘리지 않으므로(중간에 transform 이 없다) 좌표를 직접 잡는다.
   */
  const [targetMenu, setTargetMenu] = useState<{ idx: number; left: number; top: number } | null>(null)
  /** 버튼 위치를 재서 팝오버를 띄운다 — 아래 공간이 모자라면 위로 뒤집는다 */
  const openTargetMenu = (idx: number, el: HTMLElement) => {
    const r = el.getBoundingClientRect()
    const W = 224 // w-56
    const H = Math.min(sessions.length * 28 + 64, Math.round(window.innerHeight * 0.6))
    const below = window.innerHeight - r.bottom - 8
    const top = below >= H ? r.bottom + 4 : Math.max(8, r.top - H - 4)
    const left = Math.min(Math.max(8, r.right - W), window.innerWidth - W - 8)
    setTargetMenu({ idx, left, top })
  }
  /** 입력값에 '세션 주소' 를 넣는 메뉴 (스텝 인덱스·제목·플레이스홀더 이름 + 화면 좌표) */
  const [phMenu, setPhMenu] = useState<{ idx: number; title: string; name: string; left: number; top: number } | null>(
    null,
  )
  const openPhMenu = (idx: number, title: string, name: string, el: HTMLElement) => {
    const r = el.getBoundingClientRect()
    const W = 288 // w-72
    const H = Math.min((sessions.length + scenario.steps.length) * 24 + 90, Math.round(window.innerHeight * 0.6))
    const top = window.innerHeight - r.bottom - 8 >= H ? r.bottom + 4 : Math.max(8, r.top - H - 4)
    const left = Math.min(Math.max(8, r.left - 40), window.innerWidth - W - 8)
    setPhMenu({ idx, title, name, left, top })
  }
  const [editDraft, setEditDraft] = useState('')
  /**
   * 대상 지정은 '세션 id' 가 아니라 '프로필 키' 로 들고 있는다.
   * 세션이 잠깐 끊겼다 다시 붙으면 id 가 바뀌는데, id 로 들고 있으면 유령이 되어
   * 그 역할/스텝이 전부 "연결되어 있지 않습니다" 로 실패한다. 키로 두면 자연히 다시 붙는다.
   *   roleKeys: 역할 이름 → 프로필 키   (시나리오에 target 이 정의된 경우)
   *   stepKeys: "번호|제목" → 프로필 키  (스텝에서 직접 고른 경우 — 내장 시나리오도 사용 가능)
   */
  const [roleKeys, setRoleKeys] = useState<Record<string, string>>(() => loadTargets(scenario.title).roles)
  const [stepKeys, setStepKeys] = useState<Record<string, string[]>>(() => loadTargets(scenario.title).steps)
  // 전체 실행 중단 요청
  const abortRef = useRef(false)
  /**
   * 일시정지 — **다음 스텝으로 넘어가기 직전**에만 멈춘다.
   *
   * 실행 중인 명령을 중간에 얼리지는 않는다(원격에서 이미 돌고 있는 것을 멈출 방법이 없고,
   * 반쯤 실행된 상태로 세워 두면 판정이 애매해진다). "여기까지 보고 다음으로 갈지 정하겠다" 가
   * 실제로 필요한 동작이라 스텝 경계에서 멈추는 것으로 충분하다.
   *
   * 중단(abort)과 다르다: 중단은 회차를 끝내고, 일시정지는 이어서 계속할 수 있다.
   */
  const pauseRef = useRef(false)
  const [paused, setPaused] = useState(false)
  /** 재개를 기다리는 쪽에 넘겨줄 resolve 들 */
  const resumeWaitersRef = useRef<(() => void)[]>([])
  /** '다음 스텝만' — 한 스텝을 돌고 다시 멈춘다 */
  const stepOnceRef = useRef(false)

  const wakeWaiters = () => {
    const list = resumeWaitersRef.current
    resumeWaitersRef.current = []
    for (const f of list) f()
  }
  const pauseRun = () => {
    pauseRef.current = true
    setPaused(true)
  }
  const resumeRun = () => {
    pauseRef.current = false
    setPaused(false)
    wakeWaiters()
  }
  /** 멈춘 상태에서 한 스텝만 진행 */
  const stepOnce = () => {
    stepOnceRef.current = true
    pauseRef.current = false
    setPaused(false)
    wakeWaiters()
  }
  /** 스텝 경계에서 호출 — 멈춰 있으면 재개(또는 중단)될 때까지 기다린다 */
  const waitIfPaused = async () => {
    while (pauseRef.current && !abortRef.current) {
      await new Promise<void>((res) => resumeWaitersRef.current.push(res))
    }
  }
  // 세션별 영속 셸 식별자 / 사용 가능 여부(false 면 호환 모드)
  const runnerBaseId = useRef(`run-${Date.now()}-${Math.floor(Math.random() * 1e6)}`)
  const shellOkRef = useRef<Record<string, boolean>>({})
  /**
   * 이 창에서 한 번이라도 셸을 연 세션들 — 창을 닫을 때 전부 반납하기 위해 따로 모은다.
   * shellOkRef 는 '전체 실행'마다 비워지므로, 그것만 보고 정리하면 이전 실행에서 쓰고
   * 이번엔 안 쓴 세션의 셸이 원격에 남는다.
   */
  const everOpenedRef = useRef<Set<string>>(new Set())
  // [호환 모드 전용] 세션별 작업 디렉토리
  const cwdRef = useRef<Record<string, string>>({})

  /**
   * 스텝의 target 은 역할 하나 또는 쉼표로 이어진 여러 역할이다.
   * 예: "서버"  /  "서버, 클라이언트"(도구 설치처럼 양쪽에 다 필요한 스텝)
   * 역할 이름에 쉼표를 쓰지 않는다는 전제 — 한글/영문 역할명에서는 문제가 없다.
   */
  const rolesOf = (target?: string): string[] =>
    (target ?? '')
      .split(',')
      .map((r) => r.trim())
      .filter(Boolean)

  /** 시나리오가 쓰는 역할 이름 목록 (중복 제거, 등장 순서 유지) */
  const roles = useMemo(() => {
    const s: string[] = []
    for (const st of scenario.steps) for (const t of rolesOf(st.target)) if (!s.includes(t)) s.push(t)
    return s
  }, [scenario.steps])

  /** capture 로 자동 채워지는 이름들 — 수동 입력 칸에서 빼고, 미입력 검사에서도 제외한다 */
  const captureNames = useMemo(() => {
    const s = new Set<string>()
    for (const st of scenario.steps) for (const c of st.capture ?? []) if (c.name?.trim()) s.add(c.name.trim())
    return s
  }, [scenario.steps])

  const targetName = sessions.find((s) => s.id === targetId)?.name ?? '(세션 없음)'
  const nameOfSession = (id: string) => sessions.find((s) => s.id === id)?.name ?? '(세션 없음)'

  /** 세션 id → 저장용 키 (프로필이 없는 임시 접속은 id 를 그대로 쓴다 — 이번 실행 동안만 유효) */
  const keyOfId = (id: string) => sessions.find((s) => s.id === id)?.profileKey || id
  /** 저장된 키 → 지금 열려 있는 세션 id. 그 서버를 아직 안 열었으면 빈 문자열 */
  const idOfKey = (key: string): string => {
    if (!key) return ''
    const byKey = sessions.find((s) => s.profileKey === key)
    if (byKey) return byKey.id
    return sessions.some((s) => s.id === key) ? key : ''
  }

  /**
   * 이 스텝을 실행할 세션 id.
   * 우선순위: ① 스텝에서 직접 고른 세션 → ② 시나리오 역할 매핑 → ③ 상단 기본 대상.
   * 지정한 세션이 지금 안 열려 있으면(idOfKey 가 빈 값) 조용히 다음 순위로 내려간다.
   */
  const sessionsForStep = (step: RunnerStep, idx: number): string[] => {
    const direct = (stepKeys[stepKeyOf(idx, step.title)] ?? []).map(idOfKey).filter(Boolean)
    if (direct.length) return Array.from(new Set(direct))
    // 역할이 여러 개면 그 역할들에 매핑된 세션 '전부' 에서 돌린다.
    // (도구 설치처럼 서버·클라이언트 양쪽에 필요한 스텝을 손으로 다중 선택하지 않아도 되게)
    const byRoles = rolesOf(step.target)
      .map((r) => idOfKey(roleKeys[r] ?? ''))
      .filter(Boolean)
    if (byRoles.length) return Array.from(new Set(byRoles))
    return targetId ? [targetId] : []
  }
  /** 이 스텝에 직접 지정된 세션 id 목록 (역할·기본 대상 제외) */
  const pinnedOf = (idx: number, title: string): string[] =>
    (stepKeys[stepKeyOf(idx, title)] ?? []).map(idOfKey).filter(Boolean)

  // ── 입력값을 '세션 IP' 에 묶기 ────────────────────────────────
  /**
   * 접속 주소(호스트/IP). 프로필 키가 `host:port:username` 이라 앞 조각이 그 주소다.
   * 임시 접속이라 키가 없으면 표시명 "별칭 (10.0.0.1)" 의 괄호 안을 쓴다.
   */
  const hostOfSession = (id: string): string => {
    const s = sessions.find((x) => x.id === id)
    if (!s) return ''
    if (s.profileKey) return s.profileKey.split(':')[0]
    return s.name.match(/\(([^)]+)\)\s*$/)?.[1] ?? s.name
  }
  const hostOfKey = (key: string): string => {
    const id = idOfKey(key)
    return id ? hostOfSession(id) : key.split(':')[0]
  }
  /**
   * 스텝 입력값은 그냥 문자열이지만, 아래 두 형태는 '참조'로 해석한다.
   *   `@step:<번호>` → 그 스텝의 대상 세션 주소   `@sid:<프로필키>` → 그 세션의 주소
   *
   * 왜 참조인가: iperf3 처럼 2번(서버)·3번(클라이언트)을 다른 세션에서 돌리는 시나리오에서,
   * 클라이언트가 접속할 주소는 '서버 스텝의 대상' 그 자체다. IP 를 손으로 적어두면
   * 나중에 서버 세션만 바꿨을 때 클라이언트가 옛 주소로 조용히 나간다 — 검증이 헛돈다.
   */
  const REF_STEP_RE = /^@step:(\d+)$/
  const REF_SID_RE = /^@sid:(.+)$/
  const resolveRef = (v: string): string => {
    const ms = REF_STEP_RE.exec(v)
    if (ms) {
      const i = Number(ms[1])
      const st = scenario.steps[i]
      if (!st) return ''
      const sid = sessionsForStep(st, i)[0]
      return sid ? hostOfSession(sid) : ''
    }
    const mk = REF_SID_RE.exec(v)
    if (mk) return hostOfKey(mk[1])
    return v
  }
  /** 참조 값이면 화면에 보여줄 라벨, 아니면 null */
  const refLabel = (v: string): { from: string; host: string } | null => {
    const ms = REF_STEP_RE.exec(v)
    if (ms) {
      const i = Number(ms[1])
      return { from: `${i + 1}번 대상`, host: resolveRef(v) }
    }
    const mk = REF_SID_RE.exec(v)
    if (mk) {
      const id = idOfKey(mk[1])
      return { from: id ? svcShort(nameOfSession(id)) : '저장된 세션', host: resolveRef(v) }
    }
    return null
  }

  /** 개별 고정된(= 대상을 바꿔도 안 따라가는) 스텝 번호 목록 */
  const pinnedSteps = useMemo(
    () => scenario.steps.map((st, i) => ((stepKeys[stepKeyOf(i, st.title)] ?? []).length ? i + 1 : 0)).filter(Boolean),
    [scenario.steps, stepKeys],
  )
  /** 개별 고정을 모두 해제 → 전 스텝이 상단 '대상'을 따라간다 */
  const clearStepPins = () => setStepKeys({})

  /** 스텝의 대상 세션 하나를 켜고 끈다 (여러 개 선택 가능) */
  const toggleStepTarget = (idx: number, title: string, sessionId: string) =>
    setStepKeys((m) => {
      const k = stepKeyOf(idx, title)
      const cur = (m[k] ?? []).map(idOfKey).filter(Boolean)
      const next = cur.includes(sessionId) ? cur.filter((x) => x !== sessionId) : [...cur, sessionId]
      const out = { ...m }
      if (next.length) out[k] = next.map(keyOfId)
      else delete out[k]
      return out
    })
  /** 이 스텝의 직접 지정을 모두 해제 (상단 '대상'을 따르게) */
  const clearStepTarget = (idx: number, title: string) =>
    setStepKeys((m) => {
      const out = { ...m }
      delete out[stepKeyOf(idx, title)]
      return out
    })

  // 대상 지정이 바뀔 때마다 시나리오 제목별로 저장 → 다음에 열면 그대로 복원된다
  useEffect(() => {
    saveTargets(scenario.title, { roles: roleKeys, steps: stepKeys })
  }, [scenario.title, roleKeys, stepKeys])

  /**
   * 실패 시 서버 상태를 바꾸는 '대응 명령'이 걸린 스텝들.
   * 실행 버튼을 누르기 전에 보여야 한다 — 시나리오를 만든 사람과 돌리는 사람이 다를 수 있고,
   * 테스트 인스턴스용으로 만든 시나리오가 운영 장비에서 그대로 돌아가는 게 가장 위험하다.
   */
  const mutatingSteps = useMemo(() => {
    const out: { i: number; kind: string; cmd: string; desc?: string[] }[] = []
    scenario.steps.forEach((st, i) => {
      const fix = st.onFailureCommand?.trim()
      if ((st.onFailure === 'run' || st.onFailure === 'retry') && fix)
        out.push({
          i,
          kind: st.onFailure === 'retry' ? '실패 시 실행 후 재시도' : '실패 시 실행',
          cmd: fix,
          desc: st.onFailureDesc,
        })
      const un = st.undo?.trim()
      if (un) out.push({ i, kind: '원복', cmd: un })
    })
    return out
  }, [scenario.steps])

  /** 저장돼 있지만 그 서버를 아직 안 열어 해석되지 않는 지정이 있는지 (조용히 기본 대상으로 도는 걸 알린다) */
  const unresolvedTargets = useMemo(() => {
    const out: string[] = []
    for (const [role, key] of Object.entries(roleKeys)) if (key && !idOfKey(key)) out.push(`역할 ${role}`)
    scenario.steps.forEach((st, i) => {
      const keys = stepKeys[stepKeyOf(i, st.title)] ?? []
      if (keys.length && keys.every((k) => !idOfKey(k))) out.push(`${i + 1}번 스텝`)
    })
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roleKeys, stepKeys, sessions, scenario.steps])
  /** 실행에 쓸 명령 — 인라인 수정본이 있으면 그것 */
  const commandOf = (idx: number) => editedCmds[idx] ?? scenario.steps[idx].command
  /**
   * 이 스텝에 적용할 값.
   * 우선순위: ① 스텝에 직접 넣은 값 → ② 앞 스텝에서 추출한 값 → ③ 상단 공통 입력값.
   * (스텝에 직접 넣은 값이 최우선인 이유는, 사용자가 그 스텝만 다르게 하려고 명시한 값이기 때문)
   */
  /**
   * 역할 매핑에서 자동으로 채워지는 입력값 — 시나리오가 선언한 { 입력값: 역할 } 기준.
   * 역할에 세션을 안 골랐으면 상단 기본 대상의 주소를 쓴다(그게 실제로 도는 곳이므로).
   */
  const roleAutoValues = useMemo(() => {
    const out: Record<string, string> = {}
    for (const [name, role] of Object.entries(scenario.roleValues ?? {})) {
      const sid = idOfKey(roleKeys[role] ?? '') || targetId
      const host = sid ? hostOfSession(sid) : ''
      if (host) out[name] = host
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scenario.roleValues, roleKeys, targetId, sessions])

  const valuesForStep = (idx: number, title: string) => {
    // 스텝 값만 참조(@step:/@sid:)일 수 있으므로 여기서 실제 주소로 푼다.
    // 풀리지 않으면 빈 문자열 → fillPlaceholders 가 <...> 를 그대로 남기고,
    // runStep 의 미입력 검사가 실행 전에 잡아준다(엉뚱한 주소로 나가지 않게).
    const own = stepPh[stepKeyOf(idx, title)] ?? {}
    const resolved: Record<string, string> = {}
    for (const [k, v] of Object.entries(own)) resolved[k] = resolveRef(v)
    // 우선순위: 역할 자동값(기본) < 상단 공통 입력 < 앞 스텝 추출값 < 스텝 직접 지정.
    // 빈 값은 덮어쓰지 않는다 — 안 그러면 사용자가 칸을 비워둔 순간 자동값까지 지워진다.
    const merged: Record<string, string> = {}
    for (const src of [roleAutoValues, phValues, capturedRef.current, resolved])
      for (const [k, v] of Object.entries(src)) if (v?.trim()) merged[k] = v
    return merged
  }
  /** 이 스텝이 실제로 쓰는 플레이스홀더 이름들 (캡처로 채워지는 건 입력받지 않는다) */
  const phOfStep = (idx: number) =>
    extractPlaceholders(commandOf(idx)).filter((p) => !captureNames.has(p))
  const setStepPhValue = (idx: number, title: string, name: string, v: string) =>
    setStepPh((m) => {
      const k = stepKeyOf(idx, title)
      const cur = { ...(m[k] ?? {}) }
      if (v) cur[name] = v
      else delete cur[name]
      const next = { ...m }
      if (Object.keys(cur).length) next[k] = cur
      else delete next[k]
      return next
    })

  /**
   * 대상 세션의 영속 셸을 확보한다.
   * 영속 셸이면 cd/환경변수가 유지되고 대화형 프롬프트에 답할 수 있으며,
   * 타임아웃 시 Ctrl+C 로 원격 프로세스를 실제로 중단시킨다(좀비 방지).
   * 서버가 shell 채널을 막아 실패하면 기존 exec 방식(호환 모드)으로 떨어진다.
   */
  const ensureShell = async (sid: string): Promise<boolean> => {
    if (!sid) return false
    if (shellOkRef.current[sid] !== undefined) return shellOkRef.current[sid]
    const r = await window.electronAPI.runnerOpen(sid, `${runnerBaseId.current}-${sid}`)
    shellOkRef.current[sid] = r.ok
    if (r.ok) everOpenedRef.current.add(sid)
    if (!r.ok) {
      setNotice(
        `${nameOfSession(sid)}: 영속 셸을 열지 못해 호환 모드로 실행합니다${r.error ? ` (${r.error})` : ''} — cd 유지·자동응답·타임아웃 중단이 제한됩니다.`,
      )
    }
    return r.ok
  }

  /** 실제 실행 — 영속 셸이면 셸로, 아니면 exec 로 */
  const execOn = async (
    sid: string,
    cmd: string,
    expect: ExpectRule[] | undefined,
  ): Promise<{ ok: boolean; code?: number; out?: string; err?: string; error?: string; timedOut?: boolean; replied?: string[] }> => {
    const runMs = timeoutForCmd(cmd, baseTimeoutMs)
    if (await ensureShell(sid)) {
      const r = await window.electronAPI.runnerExec(`${runnerBaseId.current}-${sid}`, cmd, expect, runMs)
      if (!r.ok) {
        // 셸이 죽었다는 뜻이다(연결 끊김 등). 열려 있다는 표시를 지워, 세션이 다시 붙으면
        // 다음 스텝에서 셸을 새로 연다 — 안 지우면 남은 스텝이 전부 같은 오류로 죽는다.
        delete shellOkRef.current[sid]
        return { ok: false, error: r.error ?? '검증용 셸 실행에 실패했습니다.' }
      }
      return {
        ok: true,
        // PTY 는 stdout/stderr 가 한 스트림으로 합쳐져 나온다 — 분리 표시는 호환 모드에서만 가능
        code: r.code,
        out: r.out,
        err: '',
        timedOut: r.timedOut,
        replied: r.replied,
      }
    }
    // ── 호환 모드 (exec) — cd 를 러너가 추적해 앞에 붙인다
    const cwd = cwdRef.current[sid] ?? ''
    const full = cwd ? `cd ${cwd} && ${cmd}` : cmd
    let timeoutId: ReturnType<typeof setTimeout> | undefined
    const r = await Promise.race([
      window.electronAPI.sessionRun(sid, full),
      new Promise<{ ok: false; error: string }>((resolve) => {
        timeoutId = setTimeout(
          () =>
            resolve({
              ok: false,
              error: `응답 시간 초과(${fmtDur(runMs)}) — 호환 모드에서는 원격 프로세스를 중단시킬 수 없어 서버에서 계속 실행 중일 수 있습니다. 터미널에서 확인 후 수동 판정하세요.`,
            }),
          runMs,
        )
      }),
    ])
    if (timeoutId) clearTimeout(timeoutId)
    if (r.ok && r.code === 0) {
      const cd = extractCdTarget(cmd)
      if (cd) cwdRef.current[sid] = resolveCwd(cwd, cd)
    }
    return r
  }
  const setRes = (idx: number, patch: Partial<StepResult>) =>
    setResults((prev) => ({ ...prev, [idx]: { ...prev[idx], ...patch } as StepResult }))
  const toggleExpand = (idx: number) =>
    setExpanded((s) => {
      const n = new Set(s)
      if (n.has(idx)) n.delete(idx)
      else n.add(idx)
      return n
    })

  /**
   * 개별 '실행' 버튼용 래퍼 — 동시에 두 스텝이 돌지 않도록 잠근다.
   * 잠금은 ref 로 건다: setState 는 비동기라 빠르게 두 번 누르면 두 핸들러가 모두
   * running=false 를 보고 통과해버린다.
   */
  const runLockRef = useRef(false)
  const runStepSolo = async (idx: number) => {
    if (runLockRef.current || busy) return
    runLockRef.current = true
    // 이전 '중단' 요청을 반드시 걷어낸다. 안 그러면 runStep 의 대상 루프가 첫 바퀴에서 바로 빠져나가
    // 아무것도 실행하지 않은 채 '실행됨' 으로 표시된다 — 안 돌았는데 돌았다고 하는 최악의 오표시.
    abortRef.current = false
    setSoloIdx(idx)
    try {
      await runStep(idx)
    } finally {
      runLockRef.current = false
      setSoloIdx(null)
    }
  }

  /**
   * 스텝 하나 실행. 대상이 여러 개면 대상마다 순차로 돌린다.
   * 반환값은 이 스텝의 종합 판정 — **하나라도 실패하면 실패**다.
   * (패키지 설치처럼 모든 노드에 성공해야 의미가 있는 작업이 대부분이라, 관대하게 볼 이유가 없다)
   */
  const runStep = async (idx: number): Promise<'pass' | 'fail' | 'info' | 'error' | 'skipped'> => {
    const step = scenario.steps[idx]
    const rawCmd = commandOf(idx)
    const sids = sessionsForStep(step, idx)
    if (!rawCmd.trim() || !sids.length) return 'skipped'
    const names = sids.map(nameOfSession).join(', ')
    const cmd = fillPlaceholders(rawCmd, valuesForStep(idx, step.title))
    // 값이 안 채워진 <...> 가 남아 있으면 실행하지 않고 안내 — 잘못된 명령이 나가는 것을 방지.
    if (hasUnfilled(cmd)) {
      const missing = extractPlaceholders(cmd)
      setRes(idx, {
        status: 'error',
        sessionName: names,
        runs: undefined,
        err:
          `입력값이 필요합니다: ${missing.map((p) => `<${p}>`).join(', ')}
` +
          (missing.some((p) => captureNames.has(p))
            ? '이 값은 앞 스텝의 출력에서 자동으로 채워집니다 — 앞 스텝을 먼저 실행하세요.'
            : "상단 '검증 입력값'에 값을 채운 뒤 다시 실행하세요."),
      })
      setExpanded((s) => new Set(s).add(idx))
      return 'error'
    }

    setRes(idx, { status: 'running', manual: undefined, sessionName: names, runs: undefined, retried: undefined })
    const expect = step.expect?.map((e) => ({ ...e, send: fillPlaceholders(e.send, valuesForStep(idx, step.title)) }))

    const runs: StepRun[] = []
    for (const sid of sids) {
      if (abortRef.current) break
      const nm = nameOfSession(sid)
      const r = await execOn(sid, cmd, expect)
      if (!r.ok) {
        runs.push({ sessionName: nm, error: r.error })
      } else if (r.timedOut) {
        // 출력이 하나도 없이 멈춘 경우는 '명령이 오래 걸린 것'과 원인이 다르다.
        // 대개 명령이 시작조차 못 하고 무언가를 기다리는 상황이라, 그쪽을 짚어준다.
        const silent = !(r.out ?? '').replace(/\^C/g, '').trim()
        runs.push({
          sessionName: nm,
          out: r.out,
          timedOut: true,
          error:
            `제한 시간(${fmtDur(timeoutForCmd(cmd, baseTimeoutMs))}) 초과 — 원격 프로세스에 Ctrl+C 를 보내 중단했습니다. ` +
            '명령이 끝까지 돌지 않았으므로 이 결과로 판정하면 안 됩니다. 상단에서 제한 시간을 늘려 다시 실행하세요.' +
            (silent
              ? '\n\n출력이 전혀 없었습니다. 명령이 실행되기 전에 멈춘 경우가 대부분입니다:\n' +
                '  · sudo 가 hostname 을 역조회하다 DNS 응답을 못 받아 대기 — 터미널에서 `time sudo -n true` 로 확인하세요\n' +
                '    (오래 걸리면 /etc/hosts 에 자기 hostname 을 추가하거나 DNS를 먼저 잡아야 합니다)\n' +
                '  · 네트워크 대기성 명령(curl/nc 등)이 응답을 못 받는 중\n' +
                '  · 대상 서버가 과부하 상태'
              : '\n터미널에서 확인 후 수동 판정하세요.'),
        })
      } else if (r.code === 253) {
        // 백엔드가 '아무도 답하지 않는 대화형 프롬프트'를 감지해 끊은 경우 —
        // 명령이 틀린 게 아니라 입력이 필요한 것이므로 그렇게 안내한다.
        runs.push({
          sessionName: nm,
          out: r.out,
          error:
            '입력을 기다리다 중단되었습니다. 이 스텝의 자동 응답(고급 설정)에 규칙을 추가하거나, ' +
            'sudo 라면 대상 서버에서 비밀번호 없이 실행되도록(NOPASSWD) 되어 있는지 확인하세요.',
        })
      } else {
        const j = judgeOutput(r.out, r.err, r.code, step.check)
        runs.push({
          sessionName: nm,
          out: r.out,
          err: r.err,
          code: r.code,
          verdict: j.verdict,
          reasons: j.reasons,
          replied: r.replied?.length ? r.replied : undefined,
        })
      }
      // 여러 대상 중 하나라도 실행 자체가 실패하면 나머지도 계속 돌린다 —
      // "어느 노드가 문제인지" 를 한 번에 보려면 전부 시도해봐야 한다.
    }

    // 한 대상도 돌지 못했으면(중단 등) '실행됨' 으로 기록하지 않는다 —
    // 안 돌린 것을 돌았다고 표시하는 게 검증 도구에서 가장 나쁜 오류다.
    if (!runs.length) {
      setRes(idx, { status: 'pending', sessionName: names, runs: undefined, verdict: undefined, out: undefined, err: undefined, code: undefined })
      return 'skipped'
    }

    // 종합 판정: 실행 실패가 있으면 error, 판정 실패가 있으면 fail, 전부 pass 면 pass, 그 외 info
    const anyError = runs.some((r) => r.error)
    const anyFail = runs.some((r) => r.verdict === 'fail')
    const allPass = runs.length > 0 && runs.every((r) => r.verdict === 'pass')
    const verdict: 'pass' | 'fail' | 'info' | 'error' = anyError ? 'error' : anyFail ? 'fail' : allPass ? 'pass' : 'info'

    // 값 추출 — 대상이 여럿이면 값이 여러 개가 되어 어느 것을 써야 할지 모호하다.
    // 조용히 아무거나 쓰면 이후 스텝이 엉뚱한 노드 값으로 돌아가므로, 첫 대상 기준임을 명시한다.
    const primary = runs[0]
    const cap = applyCaptures(step.capture, `${primary?.out ?? ''}
${primary?.err ?? ''}`)
    if (Object.keys(cap.values).length) {
      capturedRef.current = { ...capturedRef.current, ...cap.values }
      setCaptured(capturedRef.current)
    }
    const capMisses = [...cap.misses]
    if (sids.length > 1 && (step.capture?.length ?? 0) > 0) {
      capMisses.push(`대상이 ${sids.length}개라 첫 대상(${primary?.sessionName ?? '-'}) 출력에서만 추출했습니다`)
    }

    setRes(idx, {
      status: anyError ? 'error' : 'ran',
      runs,
      // 대상이 하나면 기존 표시 경로(out/err/code)도 그대로 채워 화면이 단순하게 유지되도록 한다
      out: sids.length === 1 ? primary?.out : undefined,
      err: sids.length === 1 ? (primary?.error ?? primary?.err) : undefined,
      code: sids.length === 1 ? primary?.code : undefined,
      verdict: anyError ? undefined : verdict === 'error' ? undefined : (verdict as Verdict),
      reasons: sids.length === 1 ? primary?.reasons : undefined,
      sessionName: names,
      replied: sids.length === 1 ? primary?.replied : undefined,
      captured: Object.keys(cap.values).length ? cap.values : undefined,
      captureMisses: capMisses.length ? capMisses : undefined,
    })
    if (verdict === 'fail' || verdict === 'error') setExpanded((s) => new Set(s).add(idx))
    return verdict
  }

  const runAll = async () => {
    if (!targetId) return
    // 새 회차 — 시각까지 담은 id 로 만들어 목록에서 시간순이 그대로 나온다
    runIdRef.current = `sr${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
    runStartRef.current = Date.now()
    runStoppedRef.current = { stopped: false }
    setBusy(true)
    abortRef.current = false
    // 지난 회차에서 멈춘 채로 끝났을 수 있다 — 새 실행은 항상 '진행 중' 으로 시작한다
    pauseRef.current = false
    stepOnceRef.current = false
    setPaused(false)
    shellOkRef.current = {} // 새 전체 실행은 셸을 새로 연다(이전 상태 초기화)
    cwdRef.current = {}
    capturedRef.current = {}
    setCaptured({})
    // 이전 회차의 원복 결과를 지운다. 안 지우면 2회차 실행 중에도 "원복됨" 배지와 상단
    // "원복 n/n" 이 그대로 남아, 방금 다시 만든 것을 이미 정리한 줄로 착각하게 된다.
    setUndoResults({})
    setUndoSkip(new Set())
    setNotice('')
    let skipped = 0
    let manualSkipped = 0
    let stoppedAt = -1
    const extras: string[] = []
    /** 대화형이라 자동 실행에서 뺀 스텝 번호 */
    const interactive: number[] = []
    for (let i = 0; i < scenario.steps.length; i++) {
      if (abortRef.current) {
        stoppedAt = i
        break
      }
      // 멈춰 있으면 여기서 기다린다 (스텝 경계)
      if (pauseRef.current) {
        setNotice(`일시정지 — ${i + 1}번 스텝 앞에서 멈췄습니다. '이어서' 또는 '다음 스텝만' 을 누르세요.`)
        await waitIfPaused()
        if (abortRef.current) {
          stoppedAt = i
          break
        }
        setNotice('')
      }
      const step = scenario.steps[i]
      const c = commandOf(i)
      if (!c.trim()) continue
      // 사용자가 수동으로 통과/실패/건너뜀을 지정한 스텝은 그 결정을 존중해 자동 실행하지 않는다.
      if (results[i]?.manual) {
        manualSkipped++
        continue
      }
      // htop/watch/vi 처럼 사람이 끝내야 하는 명령은 자동으로 돌리지 않는다.
      // 돌려봐야 제한 시간을 다 쓰고 끊긴 화면 조각만 남는데 판정은 '실행됨'이 붙는다.
      const why = interactiveReason(c)
      if (why) {
        interactive.push(i + 1)
        continue
      }
      // 캡처로 채워질 이름은 '미입력'으로 보지 않는다 (앞 스텝이 채워줄 값이므로)
      const pending = extractPlaceholders(fillPlaceholders(c, valuesForStep(i, step.title))).filter((p) => !captureNames.has(p))
      if (pending.length) {
        skipped++
        continue
      }
      let verdict = await runStep(i)
      // '다음 스텝만' 으로 들어온 경우 한 스텝을 마쳤으니 다시 멈춘다
      if (stepOnceRef.current) {
        stepOnceRef.current = false
        if (!abortRef.current) pauseRun()
      }

      if (verdict === 'fail' || verdict === 'error') {
        const action: OnFailureAction = step.onFailure ?? 'stop'
        const fix = step.onFailureCommand?.trim()

        if ((action === 'run' || action === 'retry') && fix) {
          // 실패 대응 명령을 이 스텝의 **모든 대상**에서 실행한다.
          // (예: apt update 가 DNS 문제로 실패 → 각 노드에 DNS 지정)
          const targets = sessionsForStep(step, i)
          const fc = fillPlaceholders(fix, valuesForStep(i, step.title))
          const outs: string[] = []
          let lastCode: number | undefined
          setRecovering({ idx: i, phase: 'fix' })
          for (const sid of targets) {
            const fr = await execOn(sid, fc, undefined)
            const body = fr.ok ? `${fr.out ?? ''}${fr.err ? `\n[stderr]\n${fr.err}` : ''}` : (fr.error ?? '')
            outs.push(targets.length > 1 ? `── ${nameOfSession(sid)} ──\n${body}` : body)
            if (fr.ok) lastCode = fr.code
          }
          const fixRecord = { command: fc, out: outs.join('\n\n'), code: lastCode }
          setRes(i, { failureRun: fixRecord })
          setExpanded((s) => new Set(s).add(i))

          if (action === 'retry') {
            // 원인을 고쳤다는 전제로 이 스텝을 **한 번만** 다시 돌린다.
            // 무한 재시도는 하지 않는다 — 고쳐지지 않는 원인이면 영영 돌게 된다.
            extras.push(`${i + 1}번 대응 명령 실행 후 재시도`)
            setRecovering({ idx: i, phase: 'retry' })
            verdict = await runStep(i)
            setRecovering(null)
            // runStep 이 결과를 새로 쓰므로 대응 명령 기록을 다시 붙인다(리포트에 남아야 한다)
            setRes(i, { retried: true, failureRun: fixRecord })
            if (verdict !== 'fail' && verdict !== 'error') continue // 복구 성공 → 다음 스텝
          } else {
            extras.push(`${i + 1}번 실패 대응 명령 실행됨`)
          }
          // '조치 중' 배지는 여기서 반드시 걷는다. retry 가 아닌 경로(대응 명령만 실행)에서
          // 안 걷으면 실행이 끝난 뒤에도 그 스텝에 "실패 — 원인 조치 중" 이 계속 붙어 있다.
          setRecovering(null)
        } else if (action === 'retry') {
          extras.push(`${i + 1}번 '재시도' 설정이지만 대응 명령이 비어 있어 중단`)
        }

        if (action !== 'continue') {
          stoppedAt = i
          break
        }
      }
    }
    setBusy(false)
    setRecovering(null) // 어떤 경로로 끝나든(중단 포함) 진행 배지는 남기지 않는다
    // 중단 여부는 이력에 반드시 남긴다 — 그 뒤 스텝은 '미실행' 이며 정상도 실패도 아니다
    runEndRef.current = Date.now()
    runStoppedRef.current = stoppedAt >= 0 ? { stopped: true, at: stoppedAt + 1 } : { stopped: false }
    const parts: string[] = []
    if (stoppedAt >= 0)
      parts.push(
        abortRef.current
          ? `사용자 중단 — ${stoppedAt + 1}번 이후 미실행`
          : `${stoppedAt + 1}번 실패로 중단 — 이후 스텝 미실행 (계속 진행하려면 스텝의 '실패 시' 설정을 '계속'으로)`,
      )
    if (extras.length) parts.push(extras.join(' · '))
    if (interactive.length)
      parts.push(
        `${interactive.join(', ')}번은 대화형 명령이라 자동 실행에서 제외 — 터미널에서 직접 확인한 뒤 수동으로 판정하세요`,
      )
    if (manualSkipped) parts.push(`수동 지정 ${manualSkipped}개는 그대로 유지`)
    if (skipped) parts.push(`입력값 미지정 ${skipped}개 건너뜀 — 상단 '검증 입력값'을 채우고 다시 실행`)
    setNotice(parts.join(' · '))
  }

  // ── 원복 (검증이 만든 변경 되돌리기) ──────────────────────────
  /**
   * 원복 대상 — **실제로 실행된** 스텝 중 원복 명령이 있는 것을 **역순**으로.
   *  · 실행 안 된 스텝은 되돌릴 것도 없으므로 자동 제외된다.
   *  · 실패한 스텝도 포함한다 — 부분적으로 만들어졌을 수 있고, 되돌리기가 실패해도 해가 없다.
   *    (반대로 성공했는데 안 되돌리면 잔여물이 남는다 → 안전한 쪽은 '시도한다')
   *  · 역순인 이유: mount 를 먼저 풀어야 mkdir 한 디렉토리를 지울 수 있다.
   */
  const undoTargets = useMemo(
    () =>
      scenario.steps
        // '실행됨' 의 기준은 결과 객체의 존재가 아니라 **명령이 실제로 나갔는지**다.
        // 입력값 미입력(error)·중단으로 한 대상도 못 돈 경우(pending)는 결과 칸만 채워질 뿐
        // 원격에는 아무것도 만들어지지 않았다. 그걸 원복 목록에 넣으면 하지도 않은 일을
        // 되돌린다며 명령이 나간다(예: 만든 적 없는 디렉토리에 umount/rmdir).
        .map((st, i) => {
          const r = results[i]
          const ran = !!r && r.status !== 'pending' && (r.status !== 'error' || !!r.runs?.length)
          return { i, step: st, undo: st.undo?.trim() ?? '', ran }
        })
        .filter((x) => x.undo && x.ran)
        .reverse(),
    [scenario.steps, results],
  )
  const [undoOpen, setUndoOpen] = useState(false)
  /** 확인 모달에서 체크 해제한 스텝 인덱스 */
  const [undoSkip, setUndoSkip] = useState<Set<number>>(new Set())
  /** 원복 결과 — 스텝 인덱스 → 대상별 결과 */
  const [undoResults, setUndoResults] = useState<
    Record<
      number,
      { command: string; runs: { sessionName: string; out: string; code?: number; ok: boolean; note?: string }[] }
    >
  >({})
  const [undoBusy, setUndoBusy] = useState(false)
  /** 원복 요약 — 몇 건 실행했고 그중 몇 건이 실패했는지 */
  const undoSummary = useMemo(() => {
    const vals = Object.values(undoResults)
    return { total: vals.length, failed: vals.filter((v) => v.runs.some((r) => !r.ok)).length }
  }, [undoResults])

  /** 원복 실행 — 역순으로, 하나가 실패해도 나머지는 계속 진행한다 */
  const runUndo = async () => {
    const list = undoTargets.filter((t) => !undoSkip.has(t.i))
    if (!list.length) return
    setUndoOpen(false)
    setUndoBusy(true)
    // 원복은 이전 '중단' 요청과 무관하게 끝까지 수행해야 한다 (잔여물을 남기지 않는 게 목적)
    abortRef.current = false
    setNotice('')
    const done: typeof undoResults = {}
    for (const t of list) {
      const cmd = fillPlaceholders(t.undo, valuesForStep(t.i, t.step.title))
      const runs: { sessionName: string; out: string; code?: number; ok: boolean; note?: string }[] = []
      /**
       * 값이 안 채워진 <...> 가 남은 원복 명령은 **절대 실행하지 않는다.**
       * 셸에서 `<` 는 입력 리다이렉션이라 `umount <MOUNT>` 가 "No such file or directory" 로 끝나는데,
       * 그 문구가 아래 '이미 정리됨' 규칙에 걸려 아무것도 안 했는데 성공으로 표시된다.
       */
      if (hasUnfilled(cmd)) {
        for (const sid of sessionsForStep(t.step, t.i))
          runs.push({
            sessionName: nameOfSession(sid),
            out: `원복 명령에 값이 채워지지 않은 항목이 있어 실행하지 않았습니다: ${extractPlaceholders(cmd).map((p) => `<${p}>`).join(', ')}\n$ ${cmd}`,
            ok: false,
          })
        done[t.i] = { command: cmd, runs }
        setUndoResults({ ...done })
        setExpanded((e) => new Set(e).add(t.i))
        continue
      }
      // 그 스텝이 실제로 돌았던 세션들에서 되돌린다
      for (const sid of sessionsForStep(t.step, t.i)) {
        const r = await execOn(sid, cmd, undefined)
        const body = r.ok ? `${r.out ?? ''}${r.err ? `\n[stderr]\n${r.err}` : ''}` : (r.error ?? '')
        /**
         * 원복은 '이미 정리된 상태'가 흔하다 — umount 한 걸 또 umount, 없는 디렉토리 rmdir 등.
         * 그건 목표(원래 상태로 돌아감)를 이미 만족한 것이라 실패로 볼 이유가 없다.
         *
         * 다만 이 예외는 좁게 잡는다. 예전엔 `not found` 까지 넣었는데, 그러면
         * `systemctl start foo` → "Unit foo.service not found" 처럼 **되돌리기에 실패한 것**까지
         * 성공으로 삼켜버린다. 파일/마운트가 '이미 없다'는 표현만 인정한다.
         */
        const already = /not mounted|not currently mounted|no such file or directory/i.test(body)
        const ok = !!r.ok && !r.timedOut && (r.code === 0 || already)
        runs.push({
          sessionName: nameOfSession(sid),
          out: body,
          code: r.ok ? r.code : undefined,
          ok,
          note: ok && r.code !== 0 ? '이미 정리된 상태 (되돌릴 것이 없음)' : undefined,
        })
      }
      done[t.i] = { command: cmd, runs }
      setUndoResults({ ...done })
      // 결과를 사용자가 찾아 들어가게 두지 않는다 — 원복한 스텝은 바로 펼쳐 보여준다
      setExpanded((e) => new Set(e).add(t.i))
    }
    setUndoBusy(false)
    const failed = Object.values(done).filter((d) => d.runs.some((r) => !r.ok)).length
    setNotice(
      failed
        ? `원복 ${list.length}건 중 ${failed}건 실패 — 각 스텝을 펼쳐 확인하고 남은 것은 직접 정리하세요.`
        : `원복 ${list.length}건 완료 — 검증 시작 전 상태로 되돌렸습니다.`,
    )
  }

  /** 실행 중단 — 현재 명령에 Ctrl+C 를 보내고 이후 스텝을 실행하지 않는다 */
  const abortRun = () => {
    abortRef.current = true
    // 일시정지로 기다리는 중이었다면 깨워야 루프가 빠져나간다 (안 깨우면 영영 멈춰 있다)
    pauseRef.current = false
    stepOnceRef.current = false
    setPaused(false)
    wakeWaiters()
    setNotice('중단 요청됨 — 실행 중인 명령을 중단합니다…')
    for (const [sid, ok] of Object.entries(shellOkRef.current)) {
      if (ok) void window.electronAPI.runnerInterrupt(`${runnerBaseId.current}-${sid}`)
    }
  }

  // 창을 닫을 때 열어둔 영속 셸을 반드시 반납한다 (원격에 셸 채널이 남지 않도록)
  useEffect(() => {
    const base = runnerBaseId.current
    const opened = everOpenedRef.current
    return () => {
      // 일시정지로 멈춰 있는 채 창을 닫으면 실행 루프가 영영 깨어나지 못한 채 남는다.
      // 셸은 아래에서 반납하므로 이어서 돌 수도 없다 — 중단으로 끝내고 대기 중인 쪽을 깨운다.
      abortRef.current = true
      pauseRef.current = false
      wakeWaiters()
      for (const sid of opened) void window.electronAPI.runnerClose(`${base}-${sid}`)
    }
  }, [])

  const setManual = (idx: number, v: 'pass' | 'fail' | 'skip') =>
    setRes(idx, { manual: results[idx]?.manual === v ? undefined : v })

  const summary = useMemo(() => {
    let pass = 0, fail = 0, info = 0, skip = 0, waiting = 0, pending = 0, error = 0
    scenario.steps.forEach((step, idx) => {
      const e = effectiveOf(step, results[idx])
      if (e === 'pass') pass++
      else if (e === 'fail') fail++
      // 실행 오류는 '미실행' 이 아니라 별도로 세고, 리포트/배지에 따로 표시한다
      else if (e === 'error') error++
      else if (e === 'info') info++
      else if (e === 'skip') skip++
      else if (e === 'manual-wait') waiting++
      else pending++
    })
    return { pass, fail, info, skip, waiting, pending, error }
  }, [scenario.steps, results])

  const buildReport = (): string => {
    const now = new Date().toLocaleString('ko-KR', { hour12: false })
    const lines: string[] = []
    lines.push(`# 시나리오 검증 리포트: ${scenario.title}`)
    lines.push('')
    lines.push(`- 기본 대상 세션: ${targetName}`)
    if (roles.length)
      lines.push(
        `- 역할 매핑: ${roles.map((r) => `${r} → ${idOfKey(roleKeys[r] ?? '') ? nameOfSession(idOfKey(roleKeys[r])) : '(기본 대상)'}`).join(' · ')}`,
      )
    // 스텝에서 직접 고른 대상도 남긴다 — 어느 인스턴스에서 돌렸는지가 결과 해석의 전제다
    const directs = scenario.steps
      .map((st, i) => ({ i, names: pinnedOf(i, st.title).map(nameOfSession) }))
      .filter((x) => x.names.length)
    if (directs.length)
      lines.push(
        `- 스텝 개별 대상: ${directs.map((d) => `${d.i + 1}번 → ${d.names.join(' + ')}`).join(' · ')}`,
      )
    lines.push(`- 실행 시각: ${now}`)
    const shellModes = Object.entries(shellOkRef.current)
    if (shellModes.some(([, ok]) => !ok))
      lines.push(
        `- ⚠ 실행 모드: 일부 세션에서 영속 셸을 열지 못해 호환 모드(exec)로 실행됨 — cd 유지·대화형 응답·타임아웃 중단이 제한됩니다`,
      )
    lines.push(
      `- 결과 요약: 정상 ${summary.pass} · 실패 ${summary.fail} · 실행오류 ${summary.error} · 실행됨 ${summary.info} · 건너뜀 ${summary.skip} · 수동대기 ${summary.waiting} · 미실행 ${summary.pending}`,
    )
    lines.push('')
    scenario.steps.forEach((step, idx) => {
      const r = results[idx]
      const e = effectiveOf(step, r)
      const meta = EFFECTIVE_META[e]
      lines.push(`## ${idx + 1}. ${step.title}  [${meta.label}${r?.manual ? ' (수동)' : ''}]`)
      // 무엇을 확인한 스텝인지 — 리포트는 돌린 사람 말고 다른 사람이 읽는다
      if (step.desc?.trim()) lines.push(step.desc.trim())
      if (step.warn?.trim()) lines.push(`> ⚠ ${step.warn.trim()}`)
      const cmd = commandOf(idx)
      if (cmd.trim()) lines.push('```\n$ ' + fillPlaceholders(cmd, valuesForStep(idx, step.title)) + '\n```')
      // 스텝마다 대상이 다를 수 있으므로 어디서 돌았는지 반드시 남긴다
      if (r?.sessionName) lines.push(`- 실행 대상: ${r.sessionName}${step.target ? ` (역할: ${step.target})` : ''}`)
      if (editedCmds[idx] != null) lines.push(`- ⚠ 이 스텝은 실행 창에서 즉석 수정된 명령으로 실행되었습니다 (원본과 다름)`)
      if (r?.reasons?.length) lines.push(`- 판정 근거: ${r.reasons.join(', ')}`)
      if (typeof r?.code === 'number') lines.push(`- 종료 코드: ${r.code}`)
      if (r?.retried) lines.push(`- ⚠ 실패 후 대응 명령을 실행하고 이 스텝을 다시 실행했습니다`)
      if (r?.replied?.length) lines.push(`- 자동 응답: ${r.replied.join(' · ')}`)
      // 대상이 여럿이면 대상별 결과를 각각 남긴다 — 어느 노드가 실패했는지가 핵심 정보다
      if ((r?.runs?.length ?? 0) > 1) {
        for (const run of r!.runs!) {
          const label = run.error ? '오류' : run.verdict === 'fail' ? '실패' : run.verdict === 'pass' ? '정상' : '실행됨'
          lines.push(`- **${run.sessionName}** [${label}]${typeof run.code === 'number' ? ` · 종료 코드 ${run.code}` : ''}`)
          if (run.reasons?.length) lines.push(`  - 판정 근거: ${run.reasons.join(', ')}`)
          const rb =
            (run.error ? '⚠ ' + run.error + '\n' : '') + (run.out || '') + (run.err ? '\n[stderr]\n' + run.err : '')
          if (rb.trim()) {
            const body = rb.length > 2000 ? rb.slice(0, 2000) + '\n…(생략)' : rb
            lines.push(
              '  <details><summary>' + run.sessionName + ' 출력</summary>\n\n```\n' + body + '\n```\n  </details>',
            )
          }
        }
      }
      if (r?.captured && Object.keys(r.captured).length)
        lines.push(`- 추출된 값: ${Object.entries(r.captured).map(([k, v]) => `${k}=${v}`).join(', ')}`)
      if (r?.captureMisses?.length) lines.push(`- ⚠ 추출 실패: ${r.captureMisses.join(', ')}`)
      if (r?.failureRun) {
        lines.push(`- 실패 대응 명령: \`${r.failureRun.command}\`${typeof r.failureRun.code === 'number' ? ` (종료 코드 ${r.failureRun.code})` : ''}`)
        if (r.failureRun.out.trim())
          lines.push('<details><summary>실패 대응 명령 출력</summary>\n\n```\n' + r.failureRun.out.slice(0, 2000) + '\n```\n</details>')
      }
      const body = (r?.out || '') + (r?.err ? `\n[stderr]\n${r.err}` : '')
      if (body.trim()) {
        const trimmed = body.length > 2000 ? body.slice(0, 2000) + '\n…(생략)' : body
        lines.push('<details><summary>출력</summary>\n\n```\n' + trimmed + '\n```\n</details>')
      }
      lines.push('')
    })

    // 원복 결과 — 검증이 만든 변경을 되돌렸는지, 남은 게 있는지는 다음 회차에 영향을 주므로 반드시 남긴다
    const undone = Object.entries(undoResults)
    if (undone.length) {
      const failedCnt = undone.filter(([, v]) => v.runs.some((r) => !r.ok)).length
      lines.push('## 원복 (검증 중 만든 변경 되돌리기)')
      lines.push('')
      lines.push(`- ${undone.length}건 실행 · 실패 ${failedCnt}건 (실행 역순으로 수행)`)
      for (const [idxStr, v] of undone) {
        const i = Number(idxStr)
        const title = scenario.steps[i]?.title ?? ''
        for (const r of v.runs) {
          lines.push(`- ${i + 1}번 ${title} → \`${v.command}\` [${r.ok ? '성공' : '실패'}] (${r.sessionName}${typeof r.code === 'number' ? ` · 종료 ${r.code}` : ''})`)
          if (!r.ok && r.out.trim())
            lines.push('  ```\n  ' + r.out.slice(0, 800).split('\n').join('\n  ') + '\n  ```')
        }
      }
      if (failedCnt) lines.push('', '> ⚠ 원복에 실패한 항목이 있습니다. 대상 서버에 잔여물이 남아 있을 수 있으니 직접 확인하세요.')
      lines.push('')
    }

    // 리포트 저장/복사/AI 전송 공통 출구 — 설정 ON 시 민감정보(비밀번호/토큰/키) 마스킹
    return maskForExport(lines.join('\n'))
  }

  const copyReport = async () => {
    try {
      await navigator.clipboard.writeText(buildReport())
      setNotice('리포트를 클립보드에 복사했습니다.')
    } catch {
      setNotice('클립보드 복사에 실패했습니다.')
    }
  }
  const saveReport = async () => {
    const r = await window.electronAPI.saveReport({
      defaultName: `검증리포트_${scenario.title}.md`.replace(/[\\/:*?"<>|]/g, '_'),
      content: buildReport(),
    })
    if (r.saved) setNotice(`저장됨: ${r.path}`)
    else if (r.error) setNotice(r.error)
  }
  /**
   * 회차를 이력에 남긴다.
   *
   * **왜 effect 로 하는가**: runAll 안에서 바로 저장하면 그 순간의 `results` 는 아직 갱신
   * 전이다(스텝마다 setState 로 쌓는다). busy 가 내려간 뒤의 렌더에서 저장해야 마지막
   * 스텝까지 들어간다. 끝난 뒤 사람이 수동 판정·원복을 하면 같은 id 로 다시 저장한다.
   */
  useEffect(() => {
    const id = runIdRef.current
    if (!id || busy) return
    // 눌린 대로 매번 쓰지 않는다 — 수동 판정을 연달아 누르면 파일을 그만큼 다시 쓴다
    const timer = setTimeout(() => {
      const steps: ScenarioRunStep[] = scenario.steps.map((st, i) => {
        const r = results[i]
        return {
          index: i,
          title: st.title,
          effective: effectiveOf(st, r),
          ...(r?.manual ? { manual: true } : {}),
          ...(r?.sessionName ? { sessionName: r.sessionName } : {}),
          ...(r?.reasons?.length ? { reasons: r.reasons } : {}),
          ...(typeof r?.code === 'number' ? { code: r.code } : {}),
          ...(r?.retried ? { retried: true } : {}),
        }
      })
      // 어느 서버에서 돌았는지가 결과 해석의 전제다 — 스텝별 대상까지 모아 둔다
      const targets = [...new Set(steps.flatMap((st) => (st.sessionName ?? '').split(', ').filter(Boolean)))]
      const detail: ScenarioRunDetail = {
        id,
        scenarioId: scenario.id ?? scenario.title,
        title: scenario.title,
        startedAt: runStartRef.current,
        // 다시 저장해도 끝난 시각은 그대로 (위 runEndRef 주석)
        endedAt: runEndRef.current || Date.now(),
        targets: targets.length ? targets : [targetName],
        stepCount: scenario.steps.length,
        counts: summary,
        ...(runStoppedRef.current.stopped
          ? { stopped: true, ...(runStoppedRef.current.at ? { stoppedAt: runStoppedRef.current.at } : {}) }
          : {}),
        ...(Object.values(shellOkRef.current).some((ok) => !ok) ? { compatShell: true } : {}),
        steps,
        // 리포트는 마스킹을 거친 것이다(buildReport 의 출구) — 저장본도 같은 규칙을 따른다
        reportMd: buildReport(),
      }
      void window.electronAPI.scenarioRunsSave(detail).then((r) => {
        // 이력 저장이 실패해도 검증은 끝난 상태다. 조용히 넘기지 않고 사유는 남긴다.
        if (!r.ok) setNotice(`이력 저장 실패: ${r.error ?? '알 수 없음'} — 리포트는 아래 [저장]으로 남기세요.`)
      })
    }, 1200)
    return () => clearTimeout(timer)
    // buildReport 는 매 렌더 새로 만들어지는 함수라 의존성에 넣지 않는다(넣으면 매 렌더 저장한다)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, results, undoResults, scenario])

  const analyzeReport = () => {
    if (!onAnalyze) return
    const started = onAnalyze(
      `다음은 인프라 검증 시나리오 실행 리포트입니다. 실패/이상 항목을 중심으로 원인과 조치를 정리해 주세요.\n\n${buildReport()}`,
    )
    setNotice(started ? '' : 'AI가 이미 다른 응답을 생성하는 중입니다. 잠시 후 다시 시도하세요.')
  }

  // 스텝 하나의 실행 결과(출력값)만 복사 — 명령/판정근거/출력을 포함, 내보내기와 동일하게 마스킹
  const copyStep = async (idx: number) => {
    const r = results[idx]
    const body = (r?.out || '') + (r?.err ? `\n[stderr]\n${r.err}` : '')
    const parts: string[] = []
    const cmd = commandOf(idx)
    if (cmd.trim()) parts.push('$ ' + fillPlaceholders(cmd, valuesForStep(idx, scenario.steps[idx].title)))
    if (r?.sessionName) parts.push(`# 실행 대상: ${r.sessionName}`)
    if (r?.reasons?.length) parts.push(`# 판정 근거: ${r.reasons.join(', ')}`)
    if (typeof r?.code === 'number') parts.push(`# 종료 코드: ${r.code}`)
    if (r?.status === 'error') parts.push(`⚠ ${r.err}`)
    else if (body.trim()) parts.push(body)
    try {
      await navigator.clipboard.writeText(maskForExport(parts.join('\n')))
      setCopiedIdx(idx)
      setTimeout(() => setCopiedIdx((c) => (c === idx ? null : c)), 1200)
    } catch {
      setNotice('클립보드 복사에 실패했습니다.')
    }
  }

  const anyRun = Object.keys(results).length > 0

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-8">
      {/* 원복 확인 — 무엇을 어떤 순서로 되돌릴지 보여준 뒤에만 실행한다 */}
      {undoOpen && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-8"
        >
          <div
            className="flex max-h-[80vh] w-[640px] max-w-[94vw] flex-col overflow-hidden rounded-lg border border-white/10 bg-panel shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 border-b border-white/10 px-4 py-2.5">
              <RotateCcw size={15} className="text-amber-300" />
              <span className="text-sm font-semibold text-gray-100">검증 중 만든 변경 되돌리기</span>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              <p className="mb-3 text-[12px] leading-relaxed text-gray-300">
                실제로 실행된 스텝만 <strong>역순으로</strong> 되돌립니다. 하나가 실패해도 나머지는 계속 진행합니다.
                <br />
                <span className="text-gray-500">
                  조회만 하는 스텝, DNS 설정·패키지 설치처럼 원복 명령을 비워둔 스텝은 목록에 없습니다.
                </span>
              </p>
              <div className="space-y-1.5">
                {undoTargets.map((t) => {
                  const on = !undoSkip.has(t.i)
                  return (
                    <button
                      key={t.i}
                      onClick={() =>
                        setUndoSkip((s) => {
                          const n = new Set(s)
                          if (n.has(t.i)) n.delete(t.i)
                          else n.add(t.i)
                          return n
                        })
                      }
                      className={
                        'flex w-full items-start gap-2 rounded-md border p-2 text-left ' +
                        (on ? 'border-amber-500/40 bg-amber-500/10' : 'border-white/10 bg-panel-light opacity-60')
                      }
                    >
                      <span
                        className={
                          'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border ' +
                          (on ? 'border-amber-400 bg-amber-500/30' : 'border-white/25')
                        }
                      >
                        {on && <Check size={11} className="text-amber-200" />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5 text-[12px] text-gray-100">
                          <span className="text-gray-500">{t.i + 1}번</span>
                          <span className="truncate">{t.step.title}</span>
                          <span className="ml-auto shrink-0 text-[10.5px] text-sky-300">
                            {sessionsForStep(t.step, t.i).map(nameOfSession).map(svcShort).join(', ')}
                          </span>
                        </span>
                        <code className="mt-0.5 block break-all font-mono text-[11px] text-amber-100/90">
                          $ {fillPlaceholders(t.undo, valuesForStep(t.i, t.step.title))}
                        </code>
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>
            <div className="flex items-center gap-2 border-t border-white/10 px-4 py-2.5">
              <span className="text-[11px] text-gray-500">
                {undoTargets.length - undoSkip.size}건 실행 · {undoSkip.size}건 제외
              </span>
              <div className="ml-auto flex gap-2">
                <button
                  onClick={() => setUndoOpen(false)}
                  className="rounded-md border border-white/10 bg-panel-light px-3 py-1.5 text-xs text-gray-200 hover:bg-white/10"
                >
                  취소
                </button>
                <button
                  onClick={runUndo}
                  disabled={undoTargets.length === undoSkip.size}
                  className="rounded-md bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-500 disabled:opacity-40"
                >
                  원복 실행
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      {/* 입력값 ← 세션 주소 연결 메뉴. 스크롤 영역에 잘리지 않게 화면 좌표로 띄운다. */}
      {phMenu && (
        <>
          <div className="fixed inset-0 z-[55]" onClick={() => setPhMenu(null)} />
          <div
            style={{ left: phMenu.left, top: phMenu.top }}
            onClick={(e) => e.stopPropagation()}
            className="fixed z-[56] max-h-[60vh] w-72 overflow-y-auto rounded-md border border-white/15 bg-panel-light p-1 shadow-2xl"
          >
            <div className="px-2 py-1 text-[10px] text-gray-400">
              <span className="font-mono text-amber-200">&lt;{phMenu.name}&gt;</span> 에 넣을 주소
            </div>
            <div className="px-2 pb-1 text-[9.5px] leading-relaxed text-gray-500">
              아래에서 고르면 그 대상의 접속 주소를 따라갑니다 — 대상을 바꾸면 이 값도 같이 바뀝니다.
            </div>
            {/* ① 다른 스텝의 대상 — iperf3 서버/클라이언트처럼 '앞 스텝을 돌린 노드' 를 가리키는 경우 */}
            {scenario.steps
              .map((st, i) => ({ st, i }))
              .filter(({ st, i }) => i !== phMenu.idx && !!st.command.trim() && sessionsForStep(st, i).length > 0)
              .map(({ st, i }) => {
                const sid = sessionsForStep(st, i)[0]
                return (
                  <button
                    key={`s${i}`}
                    onClick={() => {
                      setStepPhValue(phMenu.idx, phMenu.title, phMenu.name, `@step:${i}`)
                      setPhMenu(null)
                    }}
                    className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-[11px] text-gray-300 hover:bg-white/10"
                  >
                    <span className="shrink-0 text-sky-300">{i + 1}번</span>
                    <span className="min-w-0 flex-1 truncate">{st.title}</span>
                    <span className="shrink-0 font-mono text-[10px] text-sky-200">{hostOfSession(sid)}</span>
                  </button>
                )
              })}
            <div className="mt-1 border-t border-white/10 px-2 pt-1 text-[9.5px] text-gray-500">연결된 세션 직접 지정</div>
            {sessions.map((sx) => (
              <button
                key={sx.id}
                onClick={() => {
                  setStepPhValue(phMenu.idx, phMenu.title, phMenu.name, `@sid:${keyOfId(sx.id)}`)
                  setPhMenu(null)
                }}
                className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-[11px] text-gray-300 hover:bg-white/10"
              >
                <Server size={10} className="shrink-0 text-gray-500" />
                <span className="min-w-0 flex-1 truncate">{svcShort(sx.name)}</span>
                <span className="shrink-0 font-mono text-[10px] text-gray-400">{hostOfSession(sx.id)}</span>
              </button>
            ))}
            <button
              onClick={() => {
                setStepPhValue(phMenu.idx, phMenu.title, phMenu.name, '')
                setPhMenu(null)
              }}
              className="mt-1 w-full rounded border-t border-white/10 px-2 py-1 text-left text-[10.5px] text-gray-400 hover:bg-white/10"
            >
              연결 해제 — 직접 입력으로
            </button>
          </div>
        </>
      )}
      <div
        className="flex h-[85vh] w-[1100px] max-w-[96vw] flex-col overflow-hidden rounded-lg border border-white/10 bg-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 헤더 */}
        <div className="flex items-center gap-2 border-b border-white/10 px-4 py-2.5">
          <ListChecks size={16} className="text-blue-400" />
          <span className="truncate text-sm font-semibold text-gray-100">시나리오 검증 · {scenario.title}</span>
          <button onClick={onClose} className="ml-auto rounded p-1 text-gray-400 hover:bg-white/10 hover:text-gray-200">
            <X size={16} />
          </button>
        </div>

        {/* 실행 바 */}
        <div className="flex flex-wrap items-center gap-2 border-b border-white/10 px-4 py-2">
          <span className="text-[11px] text-gray-400">대상</span>
          <select
            value={targetId}
            onChange={(e) => setTargetId(e.target.value)}
            disabled={running || sessions.length === 0}
            style={OPT_STYLE}
            className="rounded border border-white/10 px-2 py-1 text-[12px] focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50"
          >
            {sessions.length === 0 && (
              <option value="" style={OPT_STYLE}>
                연결된 세션 없음
              </option>
            )}
            {sessions.map((s) => (
              <option key={s.id} value={s.id} style={OPT_STYLE}>
                {s.name}
              </option>
            ))}
          </select>
          {/* 개별 고정된 스텝이 있으면 '대상을 바꿔도 저 스텝들은 안 따라간다'는 걸 반드시 알려야 한다.
              안 그러면 대상만 바꾸고 전체 실행했다가 엉뚱한 노드에서 도는 걸 뒤늦게 발견한다. */}
          {pinnedSteps.length > 0 && (
            <span className="flex items-center gap-1 text-[11px]">
              <span
                title={`${pinnedSteps.join(', ')}번 스텝은 세션이 개별 지정돼 있어 '대상'을 바꿔도 따라가지 않습니다.`}
                className="rounded bg-sky-500/20 px-1.5 py-0.5 font-medium text-sky-200"
              >
                {pinnedSteps.length}개 스텝 개별 지정
              </span>
              <button
                onClick={clearStepPins}
                disabled={running}
                title="개별 지정을 모두 해제해 전 스텝이 위 '대상'을 따르게 합니다"
                className="rounded border border-white/10 px-1.5 py-0.5 text-[10.5px] text-gray-300 hover:bg-white/10 disabled:opacity-40"
              >
                모두 기본으로
              </button>
            </span>
          )}
          {/* 제한 시간 — 짧으면 명령이 끝나기 전에 Ctrl+C 로 끊겨 '가짜 성공'이 된다.
              (stress-ng --timeout 60s 를 45초 제한으로 돌리던 게 정확히 그 사고였다) */}
          <label className="flex items-center gap-1 text-[11px] text-gray-400">
            <span title="스텝 하나에 허용할 시간. 명령이 스스로 더 긴 시간을 지정하면(예: --timeout 60s) 그만큼 자동으로 늘려 잡습니다.">
              제한
            </span>
            <select
              value={baseTimeoutSec}
              onChange={(e) => setBaseTimeoutSec(Number(e.target.value))}
              disabled={running}
              style={OPT_STYLE}
              className="rounded border border-white/10 px-1.5 py-0.5 text-[11px] outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50"
            >
              {TIMEOUT_CHOICES.map((s) => (
                <option key={s} value={s} style={OPT_STYLE}>
                  {fmtDur(s * 1000)}
                </option>
              ))}
            </select>
          </label>
          <button
            onClick={runAll}
            disabled={running || !targetId}
            className="flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50"
          >
            {busy ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />} 전체 실행
          </button>
          {running &&
            (paused ? (
              <>
                <button
                  onClick={resumeRun}
                  title="남은 스텝을 이어서 실행합니다"
                  className="flex items-center gap-1 rounded-md border border-blue-500/40 bg-blue-500/10 px-2 py-1 text-xs font-medium text-blue-200 hover:bg-blue-500/20"
                >
                  <Play size={12} /> 이어서
                </button>
                <button
                  onClick={stepOnce}
                  title="다음 스텝 하나만 실행하고 다시 멈춥니다"
                  className="flex items-center gap-1 rounded-md border border-white/15 bg-panel-light px-2 py-1 text-xs font-medium text-gray-200 hover:bg-white/10"
                >
                  <SkipForward size={12} /> 다음 스텝만
                </button>
              </>
            ) : (
              <button
                onClick={pauseRun}
                title="지금 실행 중인 스텝을 끝낸 뒤 다음 스텝 앞에서 멈춥니다"
                className="flex items-center gap-1 rounded-md border border-white/15 bg-panel-light px-2 py-1 text-xs font-medium text-gray-200 hover:bg-white/10"
              >
                <Pause size={12} /> 일시정지
              </button>
            ))}
          {running && (
            <button
              onClick={abortRun}
              title="실행 중인 명령에 Ctrl+C 를 보내고 이후 스텝을 중단합니다"
              className="flex items-center gap-1 rounded-md border border-red-500/40 bg-red-500/10 px-2 py-1 text-xs font-medium text-red-300 hover:bg-red-500/20"
            >
              <Square size={12} /> 중단
            </button>
          )}

          {/* 요약 */}
          {anyRun && (
            <div className="flex items-center gap-1.5 text-[11px]">
              <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-emerald-300">정상 {summary.pass}</span>
              <span className="rounded bg-red-500/15 px-1.5 py-0.5 text-red-300">실패 {summary.fail}</span>
              {summary.error > 0 && (
                <span className="rounded bg-red-500/15 px-1.5 py-0.5 text-red-300">실행오류 {summary.error}</span>
              )}
              {summary.info > 0 && (
                <span className="flex items-center gap-0.5 text-emerald-300/70">
                  <Info size={11} /> 실행됨 {summary.info}
                </span>
              )}
              {summary.waiting > 0 && <span className="text-sky-300">수동대기 {summary.waiting}</span>}
            </div>
          )}
          {/* 원복 요약 — 몇 건 되돌렸고 몇 건 실패했는지 상단에서 바로 보이게 */}
          {undoSummary.total > 0 && (
            <span
              title={undoSummary.failed ? '실패한 항목은 해당 스텝을 펼쳐 출력을 확인하세요' : '모두 정상적으로 되돌렸습니다'}
              className={
                'flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium ' +
                (undoSummary.failed ? 'bg-red-500/20 text-red-300' : 'bg-emerald-500/20 text-emerald-300')
              }
            >
              <RotateCcw size={11} />
              원복 {undoSummary.total - undoSummary.failed}/{undoSummary.total}
              {undoSummary.failed > 0 && ` · 실패 ${undoSummary.failed}`}
            </span>
          )}

          {/* 리포트 액션 */}
          <div className="ml-auto flex items-center gap-1.5">
            {undoTargets.length > 0 && (
              <button
                onClick={() => {
                  setUndoSkip(new Set())
                  setUndoOpen(true)
                }}
                disabled={running || undoBusy}
                title="검증 중 만든 변경을 되돌립니다 (실행된 스텝만, 역순)"
                className="flex items-center gap-1 rounded-md border border-amber-500/50 bg-amber-500/10 px-2 py-1 text-xs font-medium text-amber-200 hover:bg-amber-500/20 disabled:opacity-40"
              >
                {undoBusy ? <Loader2 size={13} className="animate-spin" /> : <RotateCcw size={13} />} 원복 실행 (
                {undoTargets.length})
              </button>
            )}
            {onAnalyze && (
              <button
                onClick={analyzeReport}
                disabled={!anyRun}
                title="리포트를 AI로 분석"
                className="flex items-center gap-1 rounded-md border border-white/10 bg-panel-light px-2 py-1 text-xs text-gray-200 hover:bg-white/10 disabled:opacity-40"
              >
                <ScanText size={13} className="text-blue-300" /> AI 분석
              </button>
            )}
            <button
              onClick={copyReport}
              disabled={!anyRun}
              className="flex items-center gap-1 rounded-md border border-white/10 bg-panel-light px-2 py-1 text-xs text-gray-200 hover:bg-white/10 disabled:opacity-40"
            >
              <ClipboardCopy size={13} /> 복사
            </button>
            <button
              onClick={saveReport}
              disabled={!anyRun}
              className="flex items-center gap-1 rounded-md border border-white/10 bg-panel-light px-2 py-1 text-xs text-gray-200 hover:bg-white/10 disabled:opacity-40"
            >
              <Save size={13} /> 저장
            </button>
          </div>
        </div>
        {notice && <div className="bg-blue-500/10 px-4 py-1 text-[11px] text-blue-200">{notice}</div>}
        {/* 실행 전에 반드시 보여야 하는 경고 — 이 시나리오는 실패 시 서버 설정을 바꾼다 */}
        {mutatingSteps.length > 0 && (
          <div className="flex items-start gap-2 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-[11px] leading-relaxed text-amber-200">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            <div className="min-w-0">
              <strong>이 시나리오는 실패 시 대상 서버의 설정을 변경합니다</strong> — 테스트용으로 만든 인스턴스에서만
              실행하세요.
              {/* 되돌리는 방법은 '다 돌리고 난 뒤'가 아니라 실행 전에 알려줘야 한다.
                  원복 명령이 하나라도 있는 시나리오에서만 띄운다. */}
              {mutatingSteps.some((m) => m.kind === '원복') && (
                <div className="mt-1 flex items-center gap-1 text-amber-100">
                  <RotateCcw size={11} className="shrink-0" />
                  <span>
                    테스트 실행 후 되돌리려면 우측 상단의 <strong>&apos;원복 실행&apos;</strong> 버튼을 누르세요 — 실제로
                    실행된 스텝만 역순으로 되돌립니다.
                  </span>
                </div>
              )}
              {/* 명령 전문은 접어둔다 — 대응 명령이 길면(DNS 점검+저장소+갱신) 배너가 화면을 잡아먹고,
                  정작 읽어야 할 '어떤 스텝이 무엇을 바꾸는가' 가 묻힌다. 요약만 보이고 필요할 때 편다. */}
              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-amber-200/85">
                {mutatingSteps.map((m) => (
                  <span key={`${m.i}-${m.kind}`} title={m.cmd}>
                    <span className="text-amber-300">{m.i + 1}번</span> {m.kind}
                  </span>
                ))}
                <button
                  onClick={() => setMutOpen((v) => !v)}
                  className="flex items-center gap-0.5 rounded border border-amber-500/40 px-1.5 text-[10.5px] text-amber-200 hover:bg-amber-500/20"
                >
                  {mutOpen ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                  {mutOpen ? '명령 접기' : '명령 보기'}
                </button>
              </div>
              {mutOpen && (
                <div className="mt-1 space-y-1.5 border-l-2 border-amber-500/40 pl-2 text-amber-200/85">
                  {mutatingSteps.map((m) => {
                    /**
                     * 한 줄에 여러 동작이 이어 붙은 명령은 단계로 펴서 보여준다.
                     * 조각이 하나뿐이면(대개 원복 명령: `sudo rmdir /mnt/backup`) 번호를 붙이지 않는다 —
                     * '1단계'만 달린 목록은 읽는 사람에게 아무것도 더 알려주지 않는다.
                     */
                    const segs = splitShell(m.cmd)
                    const head = (
                      <span className="text-amber-300">
                        {m.i + 1}번 {m.kind}
                      </span>
                    )
                    if (segs.length < 2)
                      return (
                        <div key={`${m.i}-${m.kind}`}>
                          {head}
                          <span className="mx-1 text-amber-300/60">:</span>
                          <code className="break-all font-mono text-[10.5px] text-amber-100/90">{m.cmd}</code>
                        </div>
                      )
                    return (
                      <div key={`${m.i}-${m.kind}`}>
                        <div>
                          {head}
                          <span className="ml-1 text-amber-200/70">— {segs.length}단계로 실행합니다</span>
                        </div>
                        <ol className="mt-0.5 space-y-0.5">
                          {segs.map((sg, k) => (
                            <li key={k} className="flex gap-1.5">
                              <span className="w-8 shrink-0 text-right text-amber-300/70">{k + 1}단계</span>
                              <span className="min-w-0">
                                {/* 작성자가 적어둔 설명이 있으면 그것을 제목으로 — 없으면 명령만 보여준다 */}
                                {m.desc?.[k] && <span className="text-amber-100">{m.desc[k]}</span>}
                                {opLabel(sg.op) && (
                                  <span className="ml-1 text-amber-300/60">({opLabel(sg.op)})</span>
                                )}
                                <code className="ml-1 break-all font-mono text-[10.5px] text-amber-100/70">
                                  {sg.cmd}
                                </code>
                              </span>
                            </li>
                          ))}
                        </ol>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        )}
        {/* 저장된 대상 지정이 아직 안 연 서버를 가리키면, 조용히 기본 대상에서 돌지 않도록 알린다 */}
        {unresolvedTargets.length > 0 && (
          <div className="bg-amber-500/10 px-4 py-1 text-[11px] text-amber-200">
            지난 실행에서 지정했던 대상 중 <strong>아직 접속하지 않은 세션</strong>이 있습니다 ({unresolvedTargets.join(', ')}) — 해당
            세션을 연결하면 자동으로 복원되고, 그전까지는 기본 대상에서 실행됩니다.
          </div>
        )}

        {/* 역할 → 세션 매핑 — 스텝마다 다른 노드에서 돌려야 하는 시나리오(LB/client/server 등)용 */}
        {roles.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-b border-white/10 bg-sky-500/5 px-4 py-2">
            <span className="flex items-center gap-1 text-[11px] font-medium text-sky-300">
              <Server size={12} /> 역할별 대상
            </span>
            {roles.map((role) => (
              <label key={role} className="flex items-center gap-1 text-[11px] text-gray-400">
                <span className="rounded bg-sky-500/20 px-1.5 py-0.5 font-medium text-sky-200">{role}</span>
                <select
                  value={idOfKey(roleKeys[role] ?? '')}
                  onChange={(e) =>
                    setRoleKeys((m) => {
                      const next = { ...m }
                      if (e.target.value) next[role] = keyOfId(e.target.value)
                      else delete next[role]
                      return next
                    })
                  }
                  disabled={running}
                  style={OPT_STYLE}
                  className="rounded border border-white/10 px-1.5 py-0.5 text-[11px] outline-none focus:ring-1 focus:ring-sky-500 disabled:opacity-50"
                >
                  <option value="" style={OPT_STYLE}>
                    기본 대상 사용
                  </option>
                  {sessions.map((s) => (
                    <option key={s.id} value={s.id} style={OPT_STYLE}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
            ))}
            <span className="text-[10px] text-gray-500">지정하지 않은 역할은 상단 '대상' 세션에서 실행됩니다.</span>
          </div>
        )}

        {/* 검증 입력값 — <...> 플레이스홀더 값을 실행 전에 한 번 받아 모든 스텝에 치환.
            앞 스텝 출력에서 자동으로 뽑히는(capture) 이름은 입력받지 않고 결과만 보여준다. */}
        {allPlaceholders.some((p) => !captureNames.has(p)) && (
          <div className="flex flex-wrap items-center gap-2 border-b border-white/10 bg-amber-500/5 px-4 py-2">
            <span className="text-[11px] font-medium text-amber-300">검증 입력값</span>
            {allPlaceholders
              .filter((p) => !captureNames.has(p))
              .map((p) => {
                const fromRole = scenario.roleValues?.[p]
                const auto = roleAutoValues[p]
                return (
                  <label key={p} className="flex items-center gap-1 text-[11px] text-gray-400">
                    <span className="font-mono text-amber-200/90">&lt;{p}&gt;</span>
                    {/* 역할에서 자동으로 들어가는 값 — 손으로 또 넣게 하지 않는다 */}
                    {fromRole && (
                      <span
                        title={`'${fromRole}' 역할로 지정한 세션의 접속 주소가 자동으로 들어갑니다. 역할 대상을 바꾸면 이 값도 같이 바뀝니다.`}
                        className="flex items-center gap-1 rounded border border-sky-500/50 bg-sky-500/10 px-1.5 py-0.5 text-[10.5px]"
                      >
                        <Server size={9} className="shrink-0 text-sky-300" />
                        <span className="text-sky-200/90">{fromRole}</span>
                        <span className={auto ? 'font-mono text-sky-100' : 'text-red-300'}>{auto || '대상 미지정'}</span>
                      </span>
                    )}
                    <input
                      value={phValues[p] ?? ''}
                      onChange={(e) => setPhValues((v) => ({ ...v, [p]: e.target.value }))}
                      placeholder={fromRole ? '직접 입력 시 우선' : '값 입력'}
                      className="w-40 rounded border border-white/10 bg-panel-light px-2 py-0.5 text-[11px] text-gray-100 outline-none placeholder:text-gray-600 focus:ring-1 focus:ring-amber-500"
                    />
                  </label>
                )
              })}
            <span className="text-[10px] text-gray-500">
              전 스텝 공통값입니다. 스텝마다 다르게 줘야 하면(TCP/UDP 포트 등) 각 스텝의 칸에 직접 입력하세요.
            </span>
          </div>
        )}

        {/* 자동 추출된 변수 — 앞 스텝의 출력에서 뽑아 다음 스텝에 넘어가는 값들 */}
        {captureNames.size > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-b border-white/10 bg-violet-500/5 px-4 py-1.5">
            <span className="flex items-center gap-1 text-[11px] font-medium text-violet-300">
              <Variable size={12} /> 자동 추출 값
            </span>
            {[...captureNames].map((n) => (
              <span key={n} className="flex items-center gap-1 text-[11px]">
                <span className="font-mono text-violet-200/90">&lt;{n}&gt;</span>
                {captured[n] ? (
                  <span className="rounded bg-violet-500/20 px-1.5 py-0.5 font-mono text-violet-100">{captured[n]}</span>
                ) : (
                  <span className="text-gray-600">아직 없음</span>
                )}
              </span>
            ))}
            <span className="text-[10px] text-gray-500">앞 스텝의 출력에서 자동으로 채워집니다.</span>
          </div>
        )}

        {/* 스텝 목록 — 팝오버가 화면 좌표 고정이라, 스크롤하면 버튼과 어긋나므로 닫는다 */}
        <div
          className="min-h-0 flex-1 overflow-y-auto p-3"
          onScroll={() => {
            if (targetMenu) setTargetMenu(null)
            if (phMenu) setPhMenu(null)
          }}
        >
          <ul className="space-y-1.5">
            {scenario.steps.map((step, idx) => {
              const r = results[idx]
              const e = effectiveOf(step, r)
              const meta = EFFECTIVE_META[e]
              const isCmd = !!commandOf(idx).trim()
              // 이 스텝에 직접 지정된 대상들 (없으면 역할/기본 대상을 따름)
              const pinnedNow = pinnedOf(idx, step.title)
              const open = expanded.has(idx)
              const body = (r?.out || '') + (r?.err ? `\n[stderr]\n${r.err}` : '')
              // 펼칠 내용이 있는지 — 출력 외에 대상/자동응답/추출값/실패대응도 펼침 영역에 들어간다
              const hasDetail =
                !!body.trim() ||
                !!r?.reasons?.length ||
                !!r?.sessionName ||
                !!r?.replied?.length ||
                !!r?.captureMisses?.length ||
                !!r?.failureRun ||
                !!undoResults[idx] ||
                !!(r?.captured && Object.keys(r.captured).length)
              return (
                <li key={idx} className="overflow-hidden rounded-md border border-white/10">
                  <div className="flex items-center gap-2 bg-panel-light px-2.5 py-1.5">
                    <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-blue-600/40 text-[11px] font-semibold text-blue-100">
                      {idx + 1}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-[13px] font-medium text-gray-100">{step.title}</span>
                        {step.target && (
                          <span
                            title={`이 스텝은 '${step.target}' 역할로 지정된 세션에서 실행됩니다`}
                            className="shrink-0 rounded bg-sky-500/20 px-1.5 py-0.5 text-[10px] font-medium text-sky-200"
                          >
                            {step.target}
                          </span>
                        )}
                        {step.expect?.length ? (
                          <span title="대화형 프롬프트 자동 응답 규칙이 있습니다" className="shrink-0 text-emerald-300/70">
                            <MessageSquareReply size={11} />
                          </span>
                        ) : null}
                        {step.capture?.length ? (
                          <span
                            title={`출력에서 값 추출: ${step.capture.map((c) => c.name).join(', ')}`}
                            className="shrink-0 text-violet-300/70"
                          >
                            <Variable size={11} />
                          </span>
                        ) : null}
                        {/* 자동 실행에서 빠지는 스텝임을 '돌리기 전에' 알려야 한다 —
                            안 그러면 전체 실행 후 왜 이 스텝만 '대기'인지 알 수 없다. */}
                        {isCmd &&
                          (() => {
                            const why = interactiveReason(commandOf(idx))
                            return why ? (
                              <span
                                title={`${why}\n'전체 실행'에서는 건너뜁니다. 터미널에서 직접 확인한 뒤 수동으로 판정하세요.\n(오른쪽 '실행' 버튼을 누르면 그래도 실행합니다)`}
                                className="shrink-0 rounded bg-violet-500/20 px-1.5 py-0.5 text-[10px] font-medium text-violet-200"
                              >
                                대화형 · 자동 실행 제외
                              </span>
                            ) : null
                          })()}
                        {/* 지금 이 스텝을 복구하는 중이라는 것을 말해준다 — 스피너만 돌면 그냥 느린 줄 안다 */}
                        {recovering?.idx === idx && (
                          <span className="flex shrink-0 items-center gap-1 rounded bg-amber-500/25 px-1.5 py-0.5 text-[10px] font-medium text-amber-100">
                            <Loader2 size={9} className="animate-spin" />
                            {recovering.phase === 'fix' ? '실패 — 원인 조치 중' : '조치 완료 — 재시도 중'}
                          </span>
                        )}
                        {step.onFailure === 'continue' && (
                          <span className="shrink-0 text-[10px] text-gray-500">실패해도 계속</span>
                        )}
                        {(step.onFailure === 'run' || step.onFailure === 'retry') && (
                          <span
                            title={`실패 시 이 명령으로 서버 설정을 바꿉니다 — 테스트 인스턴스에서만 사용하세요\n$ ${step.onFailureCommand ?? '(비어 있음)'}`}
                            className="flex shrink-0 items-center gap-0.5 rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] text-amber-200"
                          >
                            <AlertTriangle size={9} />
                            {step.onFailure === 'retry' ? '실패 시 조치 후 재시도' : '실패 시 대응 명령'}
                          </span>
                        )}
                        {/* 원복 결과 — 펼치지 않아도 성공/실패가 보여야 한다 */}
                        {undoResults[idx] &&
                          (() => {
                            const rs = undoResults[idx].runs
                            const bad = rs.filter((x) => !x.ok).length
                            return (
                              <span
                                title={
                                  '원복 명령: ' +
                                  undoResults[idx].command +
                                  '\n' +
                                  rs
                                    .map(
                                      (x) =>
                                        x.sessionName +
                                        ': ' +
                                        (x.ok ? '성공' : '실패') +
                                        (typeof x.code === 'number' ? ' (종료 ' + x.code + ')' : ''),
                                    )
                                    .join('\n')
                                }
                                className={
                                  'flex shrink-0 items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] font-medium ' +
                                  (bad ? 'bg-red-500/25 text-red-300' : 'bg-emerald-500/20 text-emerald-300')
                                }
                              >
                                <RotateCcw size={9} />
                                {bad ? `원복 실패${rs.length > 1 ? ` ${bad}/${rs.length}` : ''}` : '원복됨'}
                              </span>
                            )
                          })()}
                        {step.undo?.trim() && !undoResults[idx] && (
                          <span
                            title={`검증 후 '원복 실행' 시 되돌립니다
$ ${step.undo}`}
                            className="flex shrink-0 items-center gap-0.5 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-200/90"
                          >
                            <RotateCcw size={9} /> 원복 있음
                          </span>
                        )}
                        {editedCmds[idx] != null && (
                          <span title="이번 실행에만 적용된 수정 명령" className="shrink-0 rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] text-amber-200">
                            수정됨
                          </span>
                        )}
                      </div>
                      {isCmd ? (
                        <>
                          <code className="block truncate font-mono text-[10px] text-pink-200/80">{commandOf(idx)}</code>
                          {/* 이 스텝이 무엇을 확인하는지 — 한 줄로 줄이고 전문은 툴팁에.
                              모든 스텝에 desc 가 있어 전문을 다 펼치면 목록이 두 배로 길어진다. */}
                          {step.desc?.trim() && (
                            <div title={step.desc} className="truncate text-[10px] leading-relaxed text-gray-500">
                              {step.desc}
                            </div>
                          )}
                        </>
                      ) : (
                        /* 안내 스텝은 '무엇을 해야 하는지'가 곧 desc 다. 이걸 안 보여주면
                           검증자가 시나리오 화면으로 되돌아가야만 판정할 수 있다. */
                        <div className="text-[10.5px] leading-relaxed text-sky-200/90">
                          <span className="mr-1 rounded bg-sky-500/20 px-1 py-0.5 text-[9.5px] text-sky-300">수동</span>
                          {step.desc?.trim() || '안내 스텝 (수동 확인)'}
                        </div>
                      )}
                      {/* 실행 전에 반드시 읽어야 하는 주의사항 — vi 가 열린다, 터미널을 점유한다 등.
                          이걸 못 보면 그 스텝이 왜 45초 타임아웃 나는지 알 방법이 없다. 접지 않는다. */}
                      {step.warn?.trim() && (
                        <div className="mt-1 flex items-start gap-1 rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-1 text-[10px] leading-relaxed text-amber-200">
                          <AlertTriangle size={10} className="mt-0.5 shrink-0" />
                          <span className="min-w-0">{step.warn}</span>
                        </div>
                      )}
                      {/* 스텝별 입력값 — TCP/UDP/HTTP 처럼 같은 <Port> 라도 스텝마다 값이 달라야 하는
                          경우가 많다. 비워두면 상단 공통 입력값을 그대로 쓴다. */}
                      {isCmd && phOfStep(idx).length > 0 && (
                        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                          {phOfStep(idx).map((p) => {
                            const own = stepPh[stepKeyOf(idx, step.title)]?.[p] ?? ''
                            const ref = refLabel(own)
                            const common = phValues[p]?.trim() ?? ''
                            const hint = common ? `공통: ${common}` : '값 입력'
                            // 칸 너비를 내용에 맞춘다 — IP 는 "공통: 10.255.42.236" 처럼 길어서 고정폭이면 잘리고,
                            // 포트는 짧아서 고정폭이면 낭비다. (한글은 폭이 넓어 +3 만큼 여유를 준다)
                            const width = `${Math.min(26, Math.max(9, Math.max(own.length + 1, hint.length + 3)))}ch`
                            return (
                              <span key={p} className="flex items-center gap-1 text-[10px]">
                                <span className={own ? 'font-mono text-amber-200' : 'font-mono text-gray-500'}>&lt;{p}&gt;</span>
                                {/* 세션 주소를 참조하는 값 — 직접 고친 문자열이 아니라 '어디를 가리키는지'를 보여준다 */}
                                {ref ? (
                                  <span
                                    title={`${ref.from} 의 접속 주소를 따라갑니다. 그 대상을 바꾸면 이 값도 같이 바뀝니다.`}
                                    className="flex items-center gap-1 rounded border border-sky-500/50 bg-sky-500/10 px-1.5 py-0.5"
                                  >
                                    <Server size={9} className="shrink-0 text-sky-300" />
                                    <span className="text-sky-200/90">{ref.from}</span>
                                    <span className={ref.host ? 'font-mono text-sky-100' : 'text-red-300'}>
                                      {ref.host || '대상 미지정'}
                                    </span>
                                    <button
                                      onClick={() => setStepPhValue(idx, step.title, p, '')}
                                      disabled={running}
                                      title="연결 해제 (직접 입력으로)"
                                      className="rounded text-sky-300/70 hover:bg-white/10 hover:text-sky-100 disabled:opacity-40"
                                    >
                                      <X size={9} />
                                    </button>
                                  </span>
                                ) : (
                                <input
                                  value={own}
                                  onChange={(ev) => setStepPhValue(idx, step.title, p, ev.target.value)}
                                  disabled={running}
                                  placeholder={hint}
                                  style={{ width }}
                                  title={
                                    own
                                      ? `이 스텝에만 적용되는 값: ${own} (상단 공통 입력값 무시)`
                                      : common
                                        ? `비어 있으면 상단 공통값 "${common}" 을 사용합니다`
                                        : `비어 있으면 상단 '검증 입력값'을 사용합니다`
                                  }
                                  className={
                                    'rounded border px-1.5 py-0.5 font-mono text-[10px] outline-none placeholder:text-gray-500 disabled:opacity-50 ' +
                                    (own
                                      ? 'border-amber-500/50 bg-amber-500/10 text-amber-100'
                                      : 'border-white/10 bg-panel text-gray-200')
                                  }
                                />
                                )}
                                {/* 세션 주소 넣기 — iperf3 처럼 '상대 노드 주소' 가 필요한 스텝용 */}
                                <button
                                  onClick={(ev) => openPhMenu(idx, step.title, p, ev.currentTarget)}
                                  disabled={running}
                                  title="다른 스텝의 대상 주소나 세션 주소를 넣습니다"
                                  className="rounded p-0.5 text-gray-500 hover:bg-white/10 hover:text-sky-300 disabled:opacity-40"
                                >
                                  <Server size={10} />
                                </button>
                              </span>
                            )
                          })}
                        </div>
                      )}
                    </div>

                    {r?.status === 'running' ? (
                      <Loader2 size={14} className="shrink-0 animate-spin text-gray-400" />
                    ) : r?.status === 'error' ? (
                      <span className="shrink-0 rounded bg-red-500/20 px-1.5 text-[10px] text-red-300">오류</span>
                    ) : (
                      <span className={'flex shrink-0 items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] font-medium ' + meta.cls}>
                        {e === 'info' && <Info size={10} />}
                        {meta.label}
                        {r?.manual ? ' ·수동' : ''}
                      </span>
                    )}

                    {/* 수동 판정 */}
                    <div className="flex shrink-0 items-center gap-0.5">
                      <button
                        onClick={() => setManual(idx, 'pass')}
                        title="수동: 통과"
                        className={
                          'rounded p-1 hover:bg-emerald-500/20 ' +
                          (r?.manual === 'pass' ? 'text-emerald-300' : 'text-gray-500')
                        }
                      >
                        <Check size={13} />
                      </button>
                      <button
                        onClick={() => setManual(idx, 'fail')}
                        title="수동: 실패"
                        className={
                          'rounded p-1 hover:bg-red-500/20 ' +
                          (r?.manual === 'fail' ? 'text-red-300' : 'text-gray-500')
                        }
                      >
                        <Ban size={13} />
                      </button>
                      <button
                        onClick={() => setManual(idx, 'skip')}
                        title="수동: 건너뜀"
                        className={
                          'rounded p-1 hover:bg-violet-500/20 ' +
                          (r?.manual === 'skip' ? 'text-violet-300' : 'text-gray-500')
                        }
                      >
                        <SkipForward size={13} />
                      </button>
                    </div>

                    {/* 스텝별 대상 세션 — 여러 개 선택 가능.
                        인스턴스 A/B 를 오가는 검증(nc 포트 확인)도, 모든 노드에 같은 작업을
                        해야 하는 경우(패키지 설치)도 여기서 처리한다. */}
                    {isCmd && sessions.length > 1 && (
                      <div className="relative shrink-0">
                        <button
                          onClick={(ev) =>
                            targetMenu?.idx === idx ? setTargetMenu(null) : openTargetMenu(idx, ev.currentTarget)
                          }
                          disabled={running}
                          title={`실행 대상: ${sessionsForStep(step, idx).map(nameOfSession).join(', ') || '(없음)'}`}
                          className={
                            'flex w-[132px] items-center gap-1 truncate rounded border bg-panel-light px-1.5 py-0.5 text-[10.5px] disabled:opacity-50 ' +
                            (pinnedNow.length
                              ? 'border-sky-400/70 font-medium text-sky-300'
                              : 'border-white/10 text-gray-400 hover:border-white/25')
                          }
                        >
                          <Server size={10} className="shrink-0" />
                          <span className="truncate">
                            {pinnedNow.length === 0
                              ? step.target
                                ? `역할 ${rolesOf(step.target).join(' + ')}`
                                : `대상 세션: ${svcShort(targetName)}`
                              : pinnedNow.length === 1
                                ? svcShort(nameOfSession(pinnedNow[0]))
                                : `${svcShort(nameOfSession(pinnedNow[0]))} 외 ${pinnedNow.length - 1}`}
                          </span>
                          <ChevronDown size={10} className="ml-auto shrink-0" />
                        </button>
                        {targetMenu?.idx === idx && (
                          <>
                            {/* 바깥 클릭으로 닫기 */}
                            <div className="fixed inset-0 z-[55]" onClick={() => setTargetMenu(null)} />
                            {/* fixed + 실측 좌표 — 스크롤 컨테이너에 잘리지 않는다. 세션이 많으면 자체 스크롤. */}
                            <div
                              style={{ left: targetMenu.left, top: targetMenu.top }}
                              className="fixed z-[56] max-h-[60vh] w-56 overflow-y-auto rounded-md border border-white/15 bg-panel-light p-1 shadow-2xl"
                            >
                              <div className="px-2 py-1 text-[10px] text-gray-500">
                                이 스텝을 실행할 세션 (여러 개 선택 가능)
                              </div>
                              {sessions.map((sx) => {
                                const on = pinnedNow.includes(sx.id)
                                return (
                                  <button
                                    key={sx.id}
                                    onClick={() => toggleStepTarget(idx, step.title, sx.id)}
                                    className={
                                      'flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-[11px] hover:bg-white/10 ' +
                                      (on ? 'text-sky-200' : 'text-gray-300')
                                    }
                                  >
                                    <span
                                      className={
                                        'flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm border ' +
                                        (on ? 'border-sky-400 bg-sky-500/30' : 'border-white/25')
                                      }
                                    >
                                      {on && <Check size={10} className="text-sky-200" />}
                                    </span>
                                    <span className="truncate">{sx.name}</span>
                                  </button>
                                )
                              })}
                              <button
                                onClick={() => {
                                  clearStepTarget(idx, step.title)
                                  setTargetMenu(null)
                                }}
                                className="mt-1 w-full rounded border-t border-white/10 px-2 py-1 text-left text-[10.5px] text-gray-400 hover:bg-white/10"
                              >
                                지정 해제 — 상단 &apos;대상&apos;을 따름
                              </button>
                            </div>
                          </>
                        )}
                      </div>
                    )}

                    {isCmd && (
                      <button
                        onClick={() => {
                          setEditingIdx(editingIdx === idx ? null : idx)
                          setEditDraft(commandOf(idx))
                        }}
                        disabled={running}
                        title="명령어를 즉석에서 수정 (이번 실행에만 적용)"
                        className={
                          'shrink-0 rounded p-1 hover:bg-white/10 disabled:opacity-40 ' +
                          (editingIdx === idx ? 'text-amber-300' : 'text-gray-500')
                        }
                      >
                        <Pencil size={13} />
                      </button>
                    )}
                    {isCmd && (
                      <button
                        onClick={() => runStepSolo(idx)}
                        disabled={running || !targetId}
                        title="이 스텝만 실행"
                        className="flex shrink-0 items-center gap-1 rounded bg-blue-600/80 px-2 py-1 text-[11px] text-white hover:bg-blue-500 disabled:opacity-40"
                      >
                        <Play size={11} /> 실행
                      </button>
                    )}
                    {hasDetail && (
                      <button
                        onClick={() => toggleExpand(idx)}
                        className="shrink-0 rounded p-1 text-gray-400 hover:bg-white/10"
                      >
                        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      </button>
                    )}
                  </div>

                  {/* 인라인 편집 — 실패한 스텝을 시나리오 편집 패널로 돌아가지 않고 바로 고쳐 재실행.
                      수정본은 이번 실행에만 적용되고 원본 시나리오는 그대로 둔다(리포트에 '수정됨' 표기). */}
                  {editingIdx === idx && (
                    <div className="border-t border-white/5 bg-amber-500/5 p-2">
                      <textarea
                        value={editDraft}
                        onChange={(ev) => setEditDraft(ev.target.value)}
                        onKeyDown={(ev) => {
                          if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
                            ev.preventDefault()
                            const v = editDraft.trim()
                            setEditedCmds((m) => ({ ...m, [idx]: v }))
                            setEditingIdx(null)
                            setTimeout(() => void runStepSolo(idx), 0)
                          }
                          if (ev.key === 'Escape') setEditingIdx(null)
                        }}
                        rows={Math.min(6, Math.max(2, editDraft.split('\n').length))}
                        spellCheck={false}
                        className="w-full resize-y rounded border border-amber-500/30 bg-[#1e1e2e] px-2 py-1.5 font-mono text-[11px] text-gray-100 outline-none focus:ring-1 focus:ring-amber-500"
                      />
                      <div className="mt-1.5 flex items-center gap-1.5">
                        <button
                          onClick={() => {
                            const v = editDraft.trim()
                            setEditedCmds((m) => ({ ...m, [idx]: v }))
                            setEditingIdx(null)
                            setTimeout(() => void runStepSolo(idx), 0)
                          }}
                          disabled={running || !editDraft.trim()}
                          className="flex items-center gap-1 rounded bg-blue-600 px-2 py-1 text-[11px] text-white hover:bg-blue-500 disabled:opacity-40"
                        >
                          <Play size={11} /> 저장 후 재실행
                        </button>
                        <button
                          onClick={() => {
                            setEditedCmds((m) => ({ ...m, [idx]: editDraft.trim() }))
                            setEditingIdx(null)
                          }}
                          disabled={!editDraft.trim()}
                          className="rounded border border-white/10 bg-panel-light px-2 py-1 text-[11px] text-gray-200 hover:bg-white/10 disabled:opacity-40"
                        >
                          저장만
                        </button>
                        {editedCmds[idx] != null && (
                          <button
                            onClick={() => {
                              setEditedCmds((m) => {
                                const n = { ...m }
                                delete n[idx]
                                return n
                              })
                              setEditDraft(scenario.steps[idx].command)
                            }}
                            title="원본 시나리오의 명령으로 되돌리기"
                            className="flex items-center gap-1 rounded border border-white/10 bg-panel-light px-2 py-1 text-[11px] text-gray-300 hover:bg-white/10"
                          >
                            <RotateCcw size={11} /> 원본으로
                          </button>
                        )}
                        <button onClick={() => setEditingIdx(null)} className="rounded px-2 py-1 text-[11px] text-gray-400 hover:bg-white/10">
                          취소
                        </button>
                        <span className="ml-auto text-[10px] text-gray-500">Ctrl+Enter 저장 후 재실행 · Esc 취소</span>
                      </div>
                    </div>
                  )}

                  {step.check && hasCheck(step.check) && (
                    <div className="border-t border-white/5 bg-black/10 px-2.5 py-1 text-[10px] text-gray-500">
                      판정 기준:
                      {step.check.failContains?.length ? ` 실패=[${step.check.failContains.join(', ')}]` : ''}
                      {step.check.passContains?.length ? ` 정상=[${step.check.passContains.join(', ')}]` : ''}
                      {step.check.passRegex ? ` 정규식=/${step.check.passRegex}/` : ''}
                      {step.check.requireExitZero ? ' exit0요구' : ''}
                    </div>
                  )}

                  {open && (
                    <div className="border-t border-white/5">
                      {r?.sessionName && (
                        <div className="bg-black/20 px-3 py-1 text-[10px] text-gray-400">
                          실행 대상: <span className="text-gray-300">{r.sessionName}</span>
                          {r.retried && <span className="ml-2 text-amber-300">· 대응 명령 실행 후 재시도됨</span>}
                        </div>
                      )}
                      {/* 대상이 여럿이면 어느 노드가 문제인지 한눈에 보여야 한다 — 대상별로 나눠 표시 */}
                      {(r?.runs?.length ?? 0) > 1 && (
                        <div className="divide-y divide-white/5 border-y border-white/5">
                          {r!.runs!.map((run, ri) => {
                            const bad = !!run.error || run.verdict === 'fail'
                            const runBody = (run.out || '') + (run.err ? `\n[stderr]\n${run.err}` : '')
                            return (
                              <div key={ri} className="px-3 py-1.5">
                                <div className="flex items-center gap-2 text-[10px]">
                                  <span
                                    className={
                                      'rounded px-1.5 py-0.5 font-medium ' +
                                      (bad ? 'bg-red-500/20 text-red-300' : 'bg-emerald-500/15 text-emerald-300')
                                    }
                                  >
                                    {run.error ? '오류' : run.verdict === 'fail' ? '실패' : run.verdict === 'pass' ? '정상' : '실행됨'}
                                  </span>
                                  <span className="truncate text-gray-300">{run.sessionName}</span>
                                  {typeof run.code === 'number' && <span className="text-gray-500">종료 {run.code}</span>}
                                  {run.reasons?.length ? <span className="truncate text-gray-500">{run.reasons.join(', ')}</span> : null}
                                </div>
                                <pre className="mt-1 max-h-36 overflow-auto whitespace-pre-wrap break-all rounded bg-[#1e1e2e] px-2 py-1 font-mono text-[10.5px] text-gray-200">
                                  {run.error ? `⚠ ${run.error}${runBody.trim() ? `\n${runBody}` : ''}` : runBody.trim() || '(출력 없음)'}
                                </pre>
                              </div>
                            )
                          })}
                        </div>
                      )}
                      {r?.replied?.length ? (
                        <div className="bg-black/20 px-3 py-1 text-[10px] text-emerald-300/80">
                          자동 응답: {r.replied.join(' · ')}
                        </div>
                      ) : null}
                      {r?.captured && Object.keys(r.captured).length ? (
                        <div className="bg-black/20 px-3 py-1 text-[10px] text-violet-300/90">
                          추출된 값:{' '}
                          {Object.entries(r.captured).map(([k, v]) => (
                            <span key={k} className="mr-2 font-mono">
                              {k}={v}
                            </span>
                          ))}
                        </div>
                      ) : null}
                      {r?.captureMisses?.length ? (
                        <div className="bg-amber-500/10 px-3 py-1 text-[10px] text-amber-300">
                          ⚠ 값 추출 실패: {r.captureMisses.join(', ')} — 이후 스텝에서 해당 플레이스홀더가 비어 있게 됩니다.
                        </div>
                      ) : null}
                      {r?.reasons?.length ? (
                        <div className="bg-black/20 px-3 py-1 text-[10px] text-gray-400">
                          판정 근거: {r.reasons.join(', ')}
                        </div>
                      ) : null}
                      {/* 이 스텝을 되돌린 결과 */}
                      {undoResults[idx] && (
                        <div className="border-t border-amber-500/20 bg-amber-500/5 px-3 py-1.5">
                          <div className="mb-1 flex items-center gap-1.5 text-[10px] text-amber-300">
                            <RotateCcw size={11} /> 원복 실행됨
                            {undoResults[idx].runs.some((x) => !x.ok) && (
                              <span className="rounded bg-red-500/20 px-1.5 text-red-300">일부 실패</span>
                            )}
                          </div>
                          <code className="block break-all font-mono text-[10px] text-amber-100/90">
                            $ {undoResults[idx].command}
                          </code>
                          {undoResults[idx].runs.map((x, k) => (
                            <div key={k} className="mt-1">
                              <div className="text-[10px]">
                                <span className={x.ok ? 'text-emerald-300' : 'text-red-300'}>{x.ok ? '성공' : '실패'}</span>
                                <span className="ml-1.5 text-gray-400">{x.sessionName}</span>
                                {typeof x.code === 'number' && <span className="ml-1.5 text-gray-500">종료 {x.code}</span>}
                                {x.note && <span className="ml-1.5 text-gray-400">{x.note}</span>}
                              </div>
                              {x.out.trim() && (
                                <pre className="mt-0.5 max-h-24 overflow-auto whitespace-pre-wrap break-all rounded bg-black/30 px-2 py-1 font-mono text-[10px] text-gray-300">
                                  {x.out}
                                </pre>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                      {r?.failureRun && (
                        <div className="border-t border-amber-500/20 bg-amber-500/5 px-3 py-1.5">
                          <div className="mb-1 text-[10px] text-amber-300">
                            실패 대응 명령 실행됨
                            {typeof r.failureRun.code === 'number' ? ` · 종료 코드 ${r.failureRun.code}` : ''}
                          </div>
                          <code className="block truncate font-mono text-[10px] text-pink-200/80">$ {r.failureRun.command}</code>
                          {r.failureRun.out.trim() && (
                            <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded bg-black/30 px-2 py-1 font-mono text-[10px] text-gray-300">
                              {r.failureRun.out}
                            </pre>
                          )}
                        </div>
                      )}
                      <div className="relative">
                        {(body.trim() || r?.status === 'error') && (
                          <button
                            onClick={() => copyStep(idx)}
                            title="이 단계 실행 결과 복사"
                            className="absolute right-2 top-2 z-10 flex items-center gap-1 rounded border border-white/10 bg-panel-light/90 px-1.5 py-0.5 text-[10px] text-gray-200 hover:bg-white/10"
                          >
                            {copiedIdx === idx ? (
                              <>
                                <Check size={11} className="text-emerald-300" /> 복사됨
                              </>
                            ) : (
                              <>
                                <ClipboardCopy size={11} /> 복사
                              </>
                            )}
                          </button>
                        )}
                        <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-all bg-[#1e1e2e] px-3 py-2 pr-16 font-mono text-[11px] text-gray-200">
                          {/* 오류일 때도 그때까지 받은 출력을 함께 보여준다 —
                              멈추기 직전 화면에 원인(예: sudo 비밀번호 프롬프트)이 그대로 남아 있다. */}
                          {r?.status === 'error'
                            ? `⚠ ${r.err ?? '실행 오류'}` + (r.out?.trim() ? `\n\n─── 중단 시점까지의 출력 ───\n${r.out}` : '')
                            : body.trim() || '(출력 없음)'}
                        </pre>
                      </div>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        </div>
      </div>
    </div>
  )
}
