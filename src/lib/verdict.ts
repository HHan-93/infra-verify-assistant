// 명령 실행 결과 자동 Pass/Fail 판정 — 3-상태(pass/fail/info).
//  - 명시적 기준(CommandCheck)이 있으면 그 기준으로 엄격 판정.
//  - 기준이 없으면 위험 키워드/종료코드로 "실패"만 감지하고, 아니면 "정보"(판정 안 함).
//    → df -h, lscpu 같은 단순 조회에 의미 없는 초록 PASS 를 띄우지 않기 위함.
import type { CommandCheck } from '../../electron/shared-types'
import { dangerKeywordHit } from './logDisplay'

export type Verdict = 'pass' | 'fail' | 'info'

export interface JudgeResult {
  verdict: Verdict
  /** 판정 근거(툴팁/리포트 표시용) */
  reasons: string[]
}

/** CommandCheck 에 실제 판정 기준이 하나라도 채워져 있는지 */
export function hasCheck(c?: CommandCheck | null): boolean {
  if (!c) return false
  return (
    (c.failContains?.some((s) => s.trim()) ?? false) ||
    (c.passContains?.some((s) => s.trim()) ?? false) ||
    !!c.passRegex?.trim() ||
    c.requireExitZero === true
  )
}

const includesCI = (text: string, needle: string) =>
  text.toLowerCase().includes(needle.toLowerCase())

/**
 * 출력(stdout/stderr)과 종료코드를 기준으로 판정.
 * @param code 종료 코드(모르면 undefined)
 */
export function judgeOutput(
  out: string | undefined,
  err: string | undefined,
  code: number | undefined,
  check?: CommandCheck | null,
): JudgeResult {
  const text = `${out ?? ''}\n${err ?? ''}`

  if (hasCheck(check)) {
    const c = check!
    const reasons: string[] = []

    // 1) 금지 문자열 — 하나라도 있으면 즉시 FAIL
    const hitFail = (c.failContains ?? []).filter((w) => w.trim() && includesCI(text, w))
    if (hitFail.length) {
      return { verdict: 'fail', reasons: hitFail.map((w) => `실패로 정한 문구가 나옴: "${w}"`) }
    }

    // 2) 종료코드 — 명시적으로 요구(requireExitZero === true)했을 때만 적용
    if (c.requireExitZero === true && typeof code === 'number' && code !== 0) {
      return { verdict: 'fail', reasons: [`명령이 오류로 끝남 (종료 코드 ${code})`] }
    }

    // 3) 필수 문자열 — 하나라도 없으면 FAIL
    const missing = (c.passContains ?? []).filter((w) => w.trim() && !includesCI(text, w))
    if (missing.length) {
      return { verdict: 'fail', reasons: missing.map((w) => `기대한 문구가 없음: "${w}"`) }
    }

    // 4) 정규식 — 불일치면 FAIL
    if (c.passRegex?.trim()) {
      let re: RegExp
      try {
        re = new RegExp(c.passRegex, 'i')
      } catch {
        return { verdict: 'fail', reasons: [`정규식 오류: /${c.passRegex}/`] }
      }
      if (!re.test(text)) {
        return { verdict: 'fail', reasons: [`기대한 형태와 다름 (정규식 /${c.passRegex}/)`] }
      }
      reasons.push(`기대한 형태와 맞음 (정규식 /${c.passRegex}/)`)
    }

    /**
     * 통과 근거는 **무엇을 기대했는지까지** 적는다.
     *
     * 예전에는 '필수 문자열 모두 존재' 였는데, 읽는 사람은 *무슨* 문자열인지 알 수 없어
     * 결국 시나리오 정의를 열어 봐야 했다. 리포트는 돌린 사람 말고 다른 사람이 읽는다.
     */
    const want = (c.passContains ?? []).filter((w) => w.trim())
    if (want.length)
      reasons.push(`기대한 문구가 모두 나옴: ${want.map((w) => `"${w}"`).join(', ')}`)
    if (c.requireExitZero === true && typeof code === 'number') reasons.push(`명령이 정상 종료 (코드 ${code})`)
    return { verdict: 'pass', reasons: reasons.length ? reasons : ['정한 기준을 모두 만족'] }
  }

  // 기준 없음 — 실패만 감지, 아니면 정보(판정 안 함).
  // 근거 문구는 '무엇을 보고 그렇게 판단했는지'를 적는다. 예전엔 '판정 기준 없음' 한 줄이라
  // 리포트를 봐도 이 스텝이 어떻게 통과했는지 알 수가 없었다.
  const hit = dangerKeywordHit(text)
  if (hit) {
    // 어떤 단어가 어느 줄에서 걸렸는지까지 남긴다 — 이게 없으면 긴 출력을 직접 뒤져야 한다.
    const line = hit.line.length > 160 ? hit.line.slice(0, 160) + '…' : hit.line
    return { verdict: 'fail', reasons: [`출력에 오류 문구 "${hit.word}" — ${line}`] }
  }
  if (typeof code === 'number' && code !== 0) {
    return { verdict: 'fail', reasons: [`명령이 오류로 끝남 (종료 코드 ${code})`] }
  }
  /**
   * **판정하지 않았다는 사실을 맨 앞에 말한다.**
   *
   * 예전 문구는 `종료 코드 0 · 출력에 위험 키워드 없음` 이었다. 뭔가 검사해서 통과한 것처럼
   * 읽히는데, 실제로는 **이 스텝에 정상 조건이 적혀 있지 않아 판정을 못 한 것**이다
   * (사용자 지적). 사실을 먼저 적고, 그래서 무엇까지 확인했는지를 괄호에 둔다.
   */
  const why = typeof code === 'number' ? `정상 조건이 없어 판정하지 않음 (명령은 정상 종료, 코드 ${code})` : '정상 조건이 없어 판정하지 않음'
  return { verdict: 'info', reasons: [why] }
}

/** 판정 결과 → 배지 표시용 메타(라벨/색 클래스). info 는 "명령은 정상 실행됐으나 판정 기준 없음". */
export function verdictBadge(v: Verdict): { label: string; cls: string } {
  switch (v) {
    case 'pass':
      return { label: '정상', cls: 'bg-emerald-500/20 text-emerald-300' }
    case 'fail':
      return { label: '실패', cls: 'bg-red-500/25 text-red-300' }
    default:
      // 명령이 정상 수행(exit 0, 위험 키워드 없음)됐으나 판정 기준이 없어 "검증됨"은 아님 —
      // 성공 계열(연한 초록)로 표시하되 밝은 초록 '정상'과 구분한다. UI 에서 ⓘ 아이콘을 덧붙인다.
      return { label: '실행됨', cls: 'bg-emerald-500/10 text-emerald-300/80' }
  }
}
