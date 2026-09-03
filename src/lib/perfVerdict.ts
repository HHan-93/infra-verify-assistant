// 성능 결과 판정 — verdict.ts 와 같은 3-상태 규칙을 따른다.
//
// **기준이 없으면 초록 PASS 를 띄우지 않는다.** 부하를 걸어 숫자를 얻은 것과 "이 정도면
// 된다" 는 판단은 다른 일이고, 후자는 사람이 정해야 한다. p95 380ms 가 통과인지 실패인지는
// 서비스마다 다르다 — 기준을 안 적었으면 `측정값만` 으로 남긴다.
//
// 중지한 회차는 아예 판정하지 않는다. 5분 걸 예정이던 부하를 30초에 끊고 얻은 p95 를
// '통과' 로 적으면, 나중에 그 표를 보는 사람이 5분치 결과로 읽는다.

import { worstP95After, type PerfHistoryPoint, type PerfSummary } from './perfParse'

export type PerfTone = 'pass' | 'fail' | 'info'

export interface PerfVerdict {
  tone: PerfTone
  label: string
  /** 무엇을 보고 그렇게 판단했는지 — 한 줄씩 */
  reasons: string[]
}

export interface PerfThresholds {
  p50ThresholdMs?: number
  p95ThresholdMs?: number
  p99ThresholdMs?: number
  errorRateThresholdPct?: number
  /** 앞부분 몇 초를 판정에서 뺄지 (램프업 구간) */
  warmupSec?: number
}

export function perfVerdict(
  summary: PerfSummary | null,
  th: PerfThresholds,
  opts: { canceled?: boolean; exitCode?: number; history?: PerfHistoryPoint[] } = {},
): PerfVerdict {
  if (opts.canceled) {
    return {
      tone: 'info',
      label: '중지됨 — 판정 안 함',
      reasons: ['예정한 시간을 다 돌지 않았습니다. 중간까지의 수치는 전체 결과로 볼 수 없습니다.'],
    }
  }
  if (!summary) {
    return {
      tone: 'info',
      label: '결과 없음',
      reasons:
        opts.exitCode !== undefined && opts.exitCode !== 0
          ? [`부하 도구가 오류로 끝났습니다 (종료 코드 ${opts.exitCode}). 로그를 확인하세요.`]
          : ['통계 파일이 없습니다. 실행이 시작되지 못했을 수 있습니다.'],
    }
  }

  const reasons: string[] = []
  const checks: boolean[] = []

  /**
   * 워밍업을 뺄 때는 **구간 p95 중 최댓값**으로 p95 를 판정한다.
   * 백분위는 다시 합칠 수 없으므로 전체 p95 에서 앞부분만 걷어낼 방법이 없다 — 대신 남은
   * 구간들의 최악값을 쓴다(더 보수적이라 거짓 통과가 없다). 화면에도 그렇게 적는다.
   */
  const warmup = th.warmupSec && th.warmupSec > 0 ? th.warmupSec : 0
  const warmP95 = warmup > 0 && opts.history ? worstP95After(opts.history, warmup) : undefined
  const p95Used = warmP95 ?? summary.p95Ms
  const p95Label = warmP95 !== undefined ? `워밍업 ${warmup}초 제외 구간 p95 최대` : 'p95'
  if (warmup > 0 && warmP95 === undefined) {
    reasons.push(`워밍업 ${warmup}초를 빼려 했지만 초 단위 이력이 없어 전체 값으로 판정했습니다.`)
  }

  const pctChecks: [string, number | undefined, number | undefined][] = [
    ['p50', summary.p50Ms, th.p50ThresholdMs],
    [p95Label, p95Used, th.p95ThresholdMs],
    ['p99', summary.p99Ms, th.p99ThresholdMs],
  ]
  for (const [label, value, limit] of pctChecks) {
    if (limit === undefined) continue
    if (value === undefined) {
      reasons.push(`${label} 기준을 적었지만 통계에 그 값이 없습니다.`)
      continue
    }
    const ok = value <= limit
    checks.push(ok)
    reasons.push(`${label} ${Math.round(value)}ms ${ok ? '≤' : '>'} 기준 ${limit}ms — ${ok ? '통과' : '초과'}`)
  }
  if (th.errorRateThresholdPct !== undefined) {
    const ok = summary.failRatePct <= th.errorRateThresholdPct
    checks.push(ok)
    reasons.push(
      `실패율 ${summary.failRatePct.toFixed(2)}% ${ok ? '≤' : '>'} 기준 ${th.errorRateThresholdPct}% — ${
        ok ? '통과' : '초과'
      }`,
    )
  }

  if (checks.length === 0) {
    // 기준이 없을 때도 **분명히 잘못된 것**은 말해 준다. 이것은 초록/빨강 판정이 아니라 사실이다.
    if (summary.requests === 0) {
      return {
        tone: 'info',
        label: '요청이 없었음',
        reasons: ['한 건도 보내지 못했습니다. 대상 주소·경로·인증을 확인하세요.'],
      }
    }
    if (summary.failures === summary.requests) {
      return {
        tone: 'info',
        label: '전부 실패',
        reasons: [`${summary.requests}건 모두 실패했습니다. 로그의 오류 내용을 확인하세요.`],
      }
    }
    return {
      tone: 'info',
      label: '측정값만 (기준 없음)',
      reasons: ['통과·실패를 가리려면 p95 또는 실패율 기준을 적어 주세요.'],
    }
  }

  const allOk = checks.every(Boolean)
  return {
    tone: allOk ? 'pass' : 'fail',
    label: allOk ? '기준 통과' : '기준 초과',
    reasons,
  }
}
