import { Fragment, type ReactNode } from 'react'
import { maskForDisplay } from './mask'
import { getRules, RULE_COLOR_CLASS, type RuleColor } from './highlightRules'

// 로그 뷰어(LiveLogViewer/LogViewer) 공용 — 심각도 키워드 자동 색상 강조 + 검색어 하이라이트.
// 줄 전체를 물들이지 않고 "심각도 키워드 단어"에만 색/볼드를 입힌다(tailspin·journalctl 벤치마킹).
//
// 4개 버킷 · 도메인(pacemaker/galera/ceph/masakari/k8s) 토큰 포함:
//   🔴 위험(red)   : error 계열 + syslog emerg/alert/crit + ceph HEALTH_ERR
//                    + 파드 ImagePullBackOff·OOMKilled·Evicted·FailedMount 등
//   🟠 경고(amber) : warning 계열 + ceph HEALTH_WARN, rabbitmq partition
//                    + 파드 pending·Unhealthy·Restarting·DiskPressure 등
//   🟢 완료/정상(green): success/done/ready/healthy + ceph HEALTH_OK, galera Synced, pcs Started 등
//   🔵 진행/정보(blue) : masakari evacuate/recovery — 실패가 아닌 "복구 진행 중" 상태
//
// up/down/ok/active 같은 초빈출 단어는 매 줄 칠해져 노이즈가 되므로 일부러 제외했다(tailspin도 미포함).

// 각 버킷의 키워드(정규식 조각). 대소문자 무시(i). 여러 단어형은 (?:...)로 묶는다.
// ⚠ DANGER_WORDS 는 **색깔만 정하는 목록이 아니다.** 판정 기준이 없는 시나리오 스텝은
//   이 목록에 걸리면 곧바로 '실패' 로 판정된다(verdict.ts 의 dangerKeywordHit).
//   그래서 "나오면 거의 항상 진짜 문제" 인 낱말만 여기 둔다. 애매한 것은 WARNING 으로 —
//   경고는 화면 표시와 필터에만 쓰이고 판정을 바꾸지 않는다.
const DANGER_WORDS = [
  'error(?:s)?', 'err', 'fail(?:ed|ures?|s)?', 'critical', 'crit', 'fatal', 'panic', 'exception',
  'denied', 'refused', 'unreachable', 'unavailable', 'unable', 'cannot', 'could not',
  'emergency', 'emerg', 'alert', 'traceback', 'segfault', 'oom',
  'HEALTH_ERR', 'CrashLoopBackOff', 'NotReady',
  // ── 파드 로그·kubelet 이벤트에서만 보이는 것들 ─────────────────────────
  // 낙타표기라 위의 일반 낱말에 안 걸린다 — `fail(?:ed)?` 는 단어 경계를 요구하므로
  // "FailedMount" 의 Failed 는 매칭되지 않는다. 그래서 통째로 적는다.
  'ImagePullBackOff', 'ErrImagePull', 'ErrImageNeverPull', 'InvalidImageName',
  'CreateContainerConfigError', 'CreateContainerError', 'RunContainerError',
  'FailedScheduling', 'FailedMount', 'FailedAttachVolume', 'FailedCreatePodSandBox',
  'OOMKilled', 'Evicted', 'Unschedulable', 'NodeNotReady',
  // 컨테이너·API 통신이 끊겼을 때 파드 로그에 그대로 찍히는 문구들
  'deadline exceeded', 'no such host', 'connection reset', 'x509',
  'Forbidden', 'Unauthorized',
]
const WARNING_WORDS = [
  'warn(?:ings?)?', 'deprecated', 'degraded', 'disconnect(?:ed)?', 'timeout', 'timed out',
  'retry(?:ing)?', 'throttl(?:e|ed|ing)?', 'unmanaged', 'partition(?:ed|s)?', 'pending', 'backoff',
  'HEALTH_WARN',
  // ── 파드 쪽 — 한 번 나온다고 장애는 아니지만 눈에 띄어야 하는 것들 ─────
  //   Unhealthy : 프로브가 한 번 실패했을 때의 이벤트 이름 (계속 나오면 그때가 문제다)
  //   back-off  : 하이픈이 있어 위의 'backoff' 에 걸리지 않는다
  //   Restarting: 재기동 중일 뿐일 수도, 죽고 다시 뜨기를 반복하는 것일 수도 있다
  'Unhealthy', 'back-off', 'Restarting', 'SandboxChanged', 'Preempt(?:ed|ing)?',
  'DiskPressure', 'MemoryPressure', 'PIDPressure', 'Insufficient',
]
const DONE_WORDS = [
  'success', 'succeed(?:ed)?', 'done', 'complete(?:d)?', 'finish(?:ed|ing)?', 'ready', 'healthy',
  'synced', 'started', 'running', 'bound', 'passed',
  'HEALTH_OK',
  // 파드가 제대로 올라올 때의 이벤트 이름 — 위험/경고만 물들면 "잘 된 줄" 이 안 보인다
  'Scheduled', 'Pulled', 'SuccessfulCreate', 'SuccessfulAttachVolume',
]
const PROGRESS_WORDS = ['evacuat(?:e|ed|ing|ion)', 'recover(?:y|ing|ed)?']

/** 한 버킷 단어목록 → 토큰 전체일치 판정용 정규식(^...$, 대소문자 무시) */
const bucketMatcher = (words: string[]) => new RegExp(`^(?:${words.join('|')})$`, 'i')
const DANGER_RE = bucketMatcher(DANGER_WORDS)
const WARNING_RE = bucketMatcher(WARNING_WORDS)
const DONE_RE = bucketMatcher(DONE_WORDS)
const PROGRESS_RE = bucketMatcher(PROGRESS_WORDS)

// 내장 심각도 키워드 전체 — 사용자 규칙과 합쳐 동적 토큰 정규식을 만든다(hlCache 참조).
const ALL_WORDS = [...DANGER_WORDS, ...WARNING_WORDS, ...DONE_WORDS, ...PROGRESS_WORDS]

// ── 사용자 정의 하이라이트 규칙 통합 (동적 캐시) ──
// 내장 키워드 + 사용자 규칙 단어를 합쳐 토큰 정규식을 만든다. 규칙 변경 시에만 재빌드.
let _hlCache: { tokenRe: RegExp; userColors: Map<string, RuleColor> } | null = null
function hlCache(): { tokenRe: RegExp; userColors: Map<string, RuleColor> } {
  if (_hlCache) return _hlCache
  const rules = getRules().filter((r) => r.enabled && r.term.trim())
  const escaped = rules.map((r) => r.term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const combined = [...ALL_WORDS, ...escaped]
  const tokenRe = new RegExp(`\\b(${combined.join('|')})\\b`, 'gi')
  const userColors = new Map<string, RuleColor>()
  for (const r of rules) userColors.set(r.term.toLowerCase(), r.color)
  _hlCache = { tokenRe, userColors }
  return _hlCache
}
if (typeof window !== 'undefined') {
  window.addEventListener('highlight-rules-changed', () => {
    _hlCache = null
  })
}

// "키워드가 텍스트 어딘가에 있는지" 판정용(자동 Pass/Fail 판정 + 로그 레벨 필터에 재사용).
const DANGER_LINE_RE = new RegExp(`\\b(${DANGER_WORDS.join('|')})\\b`, 'i')
const WARNING_LINE_RE = new RegExp(`\\b(${WARNING_WORDS.join('|')})\\b`, 'i')
const DONE_LINE_RE = new RegExp(`\\b(${DONE_WORDS.join('|')})\\b`, 'i')
const PROGRESS_LINE_RE = new RegExp(`\\b(${PROGRESS_WORDS.join('|')})\\b`, 'i')

// "0개 = 정상" 표현은 위험으로 보지 않는다. fio 는 작업 헤더에 `err= 0`(오류 0개=성공),
// smartctl/iperf 등도 `errors=0`, `0 errors`, `failures: 0` 처럼 정상인데 위험 단어를 포함한다.
// 이런 "위험단어 + 0" / "0(또는 no) + 위험단어" 패턴을 제거한 뒤에 위험 여부를 판정한다.
const ZERO_COUNT_RE =
  /\b(?:err(?:ors?)?|fail(?:ed|ures?|s)?|exceptions?|denied|refused|dropped)\s*[:=]?\s*0+\b|\b(?:0+|no)\s+(?:err(?:ors?)?|fail(?:ed|ures?|s)?|exceptions?)\b/gi
const stripZeroCounts = (text: string): string => text.replace(ZERO_COUNT_RE, ' ')

/** 텍스트에 위험 키워드가 하나라도 있으면 true (단, "err= 0" 등 0개=정상 표현은 제외) */
export function hasDangerKeyword(text: string): boolean {
  return DANGER_LINE_RE.test(stripZeroCounts(text))
}
/**
 * 위험 키워드에 걸린 '단어와 그 줄'. 판정 근거를 쓸 때 쓴다.
 * "위험 키워드 감지" 라고만 하면 사용자가 긴 출력을 직접 뒤져야 한다 —
 * 어떤 단어가 어느 줄에서 걸렸는지까지 말해줘야 바로 원인으로 갈 수 있다.
 */
export function dangerKeywordHit(text: string): { word: string; line: string } | null {
  for (const raw of text.split('\n')) {
    const m = DANGER_LINE_RE.exec(stripZeroCounts(raw))
    if (m) return { word: m[1], line: raw.trim() }
  }
  return null
}
/** 텍스트에 경고 키워드가 하나라도 있으면 true */
export function hasWarningKeyword(text: string): boolean {
  return WARNING_LINE_RE.test(text)
}

/** 로그 필터용 줄 분류 — 가장 심각한 버킷 우선(위험>경고>완료>진행>기타) */
export type LineBucket = 'danger' | 'warn' | 'done' | 'progress' | 'plain'
export function lineBucket(line: string): LineBucket {
  if (DANGER_LINE_RE.test(stripZeroCounts(line))) return 'danger'
  if (WARNING_LINE_RE.test(line)) return 'warn'
  if (DONE_LINE_RE.test(line)) return 'done'
  if (PROGRESS_LINE_RE.test(line)) return 'progress'
  return 'plain'
}

/** 한 키워드 토큰의 색상 클래스 — 내장 버킷(위험>경고>완료>진행) 우선, 없으면 사용자 규칙 */
function tokenSeverityClass(word: string): string {
  if (DANGER_RE.test(word)) return 'font-semibold text-red-400'
  if (WARNING_RE.test(word)) return 'font-semibold text-amber-400'
  if (DONE_RE.test(word)) return 'font-semibold text-emerald-400'
  if (PROGRESS_RE.test(word)) return 'font-semibold text-sky-400'
  const uc = hlCache().userColors.get(word.toLowerCase())
  return uc ? RULE_COLOR_CLASS[uc] : ''
}

/**
 * (구) 줄 전체 색상 클래스 — 참고용. 현재 뷰어는 renderLogLine 으로 키워드 단어만 강조한다.
 */
export function lineSeverityClass(line: string): string {
  if (DANGER_RE.test(line)) return 'text-red-300'
  if (WARNING_RE.test(line)) return 'text-amber-300'
  if (DONE_RE.test(line)) return 'text-emerald-300'
  return 'text-gray-300'
}

/** 대소문자 구분 없이 일치하는 부분을 <mark>로 강조 (특수문자 이스케이프 포함) */
export function highlightMatches(text: string, query: string): ReactNode {
  if (!query) return text
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const parts = text.split(new RegExp(`(${escaped})`, 'gi'))
  return parts.map((part, i) =>
    part.toLowerCase() === query.toLowerCase() ? (
      <mark key={i} className="rounded bg-yellow-500/40 text-inherit">
        {part}
      </mark>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    ),
  )
}

/**
 * 로그 한 줄을 렌더 — 줄 전체를 물들이지 않고 "심각도 키워드 단어"에만 색/볼드를 입힌다.
 * (예: `[WARNING] ... Error: ...` → WARNING 은 주황, Error 는 빨강, 나머지는 기본색)
 * 검색어(query)가 있으면 각 조각 위에 노란 하이라이트를 겹쳐 적용한다.
 */
export function renderLogLine(rawLine: string, query = ''): ReactNode {
  // 화면 마스킹 설정이 켜져 있으면 표시 전에 민감정보(비밀번호/토큰/키)를 가린다.
  const line = maskForDisplay(rawLine)
  if (!line) return query ? highlightMatches(line, query) : line || ' '
  // 캡처 그룹이 하나이므로 split 결과는 [일반, 키워드, 일반, 키워드, ...] 로 홀수 인덱스가 키워드.
  // 내장 키워드 + 사용자 규칙 단어를 포함한 동적 토큰 정규식으로 분리한다.
  const segments = line.split(hlCache().tokenRe)
  return segments.map((seg, i) => {
    if (seg === '') return null
    const inner = query ? highlightMatches(seg, query) : seg
    const cls = i % 2 === 1 ? tokenSeverityClass(seg) : ''
    return cls ? (
      <span key={i} className={cls}>
        {inner}
      </span>
    ) : (
      <Fragment key={i}>{inner}</Fragment>
    )
  })
}
