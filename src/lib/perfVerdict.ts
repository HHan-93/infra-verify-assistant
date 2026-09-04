// 성능 결과 판정 — verdict.ts 와 같은 3-상태 규칙을 따른다.
//
// **기준이 없으면 초록 PASS 를 띄우지 않는다.** 부하를 걸어 숫자를 얻은 것과 "이 정도면
// 된다" 는 판단은 다른 일이고, 후자는 사람이 정해야 한다. p95 380ms 가 통과인지 실패인지는
// 서비스마다 다르다 — 기준을 안 적었으면 `측정값만` 으로 남긴다.
//
// 중지한 회차는 아예 판정하지 않는다. 5분 걸 예정이던 부하를 30초에 끊고 얻은 p95 를
// '통과' 로 적으면, 나중에 그 표를 보는 사람이 5분치 결과로 읽는다.

import {
  FAILURE_KIND_LABEL,
  summarizeFailureKinds,
  unreachableRatio,
  worstP95After,
  type PerfFailure,
  type PerfHistoryPoint,
  type PerfSummary,
} from './perfParse'

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
  opts: {
    canceled?: boolean
    exitCode?: number
    history?: PerfHistoryPoint[]
    failures?: PerfFailure[]
    /** 어디를 때렸는지 — 주소 때문에 실패한 경우 무엇을 고치면 되는지 짚어 주기 위해 */
    targetUrl?: string
  } = {},
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
   * **닿지도 못한 실패**가 대부분이면 그 사실을 맨 앞에 말한다.
   *
   * '실패 100%' 만 보면 서버가 무너진 것으로 읽히지만, 연결 거부·타임아웃은 HTTP 요청을
   * 보내보기 전에 끝난 것이다. 그때 화면의 p95 는 서버 응답 시간이 아니라 **연결이 끊기기까지
   * 걸린 시간**이라, 그대로 두면 "서버가 2초나 걸린다" 는 거짓 결론이 나온다.
   */
  const fails = opts.failures ?? []
  const unreachable = unreachableRatio(fails)
  const kinds = summarizeFailureKinds(fails)
  const kindLine = kinds.length
    ? kinds.map((k) => `${FAILURE_KIND_LABEL[k.kind]} ${k.count.toLocaleString()}건`).join(' · ')
    : ''
  const cannotReach = summary.failRatePct >= 99.9 && unreachable >= 0.9
  const url = (opts.targetUrl ?? '').trim()
  const refusedOnHttps =
    /^https:\/\//i.test(url) && !/:\d+/.test(url.replace(/^https:\/\//i, '')) &&
    kinds.some((k) => k.kind === 'connect')
  const httpsHint = refusedOnHttps
    ? `이 주소는 443 포트로 갑니다. 웹 서버가 TLS 설정 없이 떠 있으면 80 만 열려 있으니 ` +
      `${url.replace(/^https:/i, 'http:')} 로 먼저 해 보세요.`
    : ''
  if (cannotReach) {
    return {
      tone: 'info',
      label: '서비스에 닿지 못했습니다 — 성능을 잰 것이 아닙니다',
      reasons: [
        kindLine,
        '요청이 서버에 도달하지 못했습니다. 화면의 응답 시간은 서버 성능이 아니라 연결이 끊기기까지 걸린 시간입니다.',
        '주소와 포트를 확인하세요 — https:// 는 443, http:// 는 80 이 기본이라 서비스 포트를 직접 적어야 하는 경우가 많습니다.',
        // 가장 흔한 한 가지는 여기서 바로 짚어 준다. nginx·아파치는 TLS 를 따로 설정하지
        // 않으면 80 만 열려 있어서, https:// 로 적으면 443 에서 연결이 거부된다.
        httpsHint,
        '사내망에서만 열려 있는 서비스라면 포트 포워딩으로 로컬 포트를 연 뒤 그 주소로 거세요.',
      ].filter(Boolean),
    }
  }
  if (unreachable > 0 && unreachable < 0.9 && fails.length) {
    reasons.push(
      `실패 중 ${Math.round(unreachable * 100)}% 는 서버에 닿지 못한 것입니다(${kindLine}) — 그만큼은 서버 성능이 아닙니다.`,
    )
  } else if (kindLine) {
    reasons.push(`실패 내용: ${kindLine}`)
  }

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
        reasons: [
          `${summary.requests}건 모두 실패했습니다.`,
          kindLine ? `실패 내용: ${kindLine}` : '아래 실패 내용에서 원인을 확인하세요.',
        ],
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
