// Locust 결과 읽기 — **판정에 쓰는 숫자는 여기서만 만든다.**
//
// 두 출처가 있다.
//  - 끝난 뒤의 `run_stats.csv`  → 확정값. 백분위까지 다 있다.
//  - 돌고 있는 동안의 콘솔 출력 → 어림값. 사람이 "지금 어떤지" 보기 위한 것.
//
// 콘솔 표 파싱은 서식이 바뀌면 깨진다(Locust 판마다 열이 늘었다 줄었다 한다). 그래서
// **모양이 정확히 맞을 때만** 값을 받아들이고, 아니면 조용히 버린다 — 어림값 하나를 놓치는
// 것이 엉뚱한 수치를 화면에 띄우는 것보다 낫다. 확정값은 늘 CSV 에서 다시 계산한다.

export interface PerfEndpointStat {
  name: string
  requests: number
  failures: number
  avgMs: number
  p95Ms?: number
}

export interface PerfSummary {
  requests: number
  failures: number
  /** 실패율(%) — 요청이 0이면 0 */
  failRatePct: number
  rps: number
  avgMs: number
  p50Ms?: number
  p95Ms?: number
  p99Ms?: number
  maxMs?: number
  perEndpoint: PerfEndpointStat[]
}

/** 돌고 있는 동안의 어림값 (콘솔 표에서 뽑는다) */
export interface PerfLive {
  requests?: number
  failures?: number
  rps?: number
  avgMs?: number
  p95Ms?: number
}

/** 쉼표 구분 한 줄 — 따옴표 안의 쉼표는 자르지 않는다 (`Name` 에 쿼리스트링이 들어온다) */
export function splitCsvLine(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"'
          i++
        } else quoted = false
      } else cur += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') {
      out.push(cur)
      cur = ''
    } else cur += ch
  }
  out.push(cur)
  return out
}

const num = (v: string | undefined): number | undefined => {
  if (v === undefined) return undefined
  const n = Number(String(v).trim())
  return Number.isFinite(n) ? n : undefined
}

/**
 * `run_stats.csv` → 요약.
 *
 * Locust 는 마지막 줄에 `Name` 이 `Aggregated` 인 합계 행을 넣는다. 그 행이 없으면
 * (실행이 중간에 끊겨 헤더만 남은 경우) **합계를 직접 더하지 않고 없음으로 돌려준다** —
 * 부분 집계를 전체인 척 보여주면 판정이 거짓이 된다.
 */
export function parseLocustStats(csv: string): PerfSummary | null {
  const lines = (csv ?? '').split(/\r?\n/).filter((l) => l.trim())
  if (lines.length < 2) return null
  const header = splitCsvLine(lines[0]).map((h) => h.trim())
  const idx = (name: string) => header.findIndex((h) => h.toLowerCase() === name.toLowerCase())

  const iName = idx('Name')
  const iType = idx('Type')
  const iReq = idx('Request Count')
  const iFail = idx('Failure Count')
  const iAvg = idx('Average Response Time')
  const iMax = idx('Max Response Time')
  const iRps = idx('Requests/s')
  const i50 = idx('50%')
  const i95 = idx('95%')
  const i99 = idx('99%')
  if (iName < 0 || iReq < 0) return null

  let agg: string[] | null = null
  const rows: string[][] = []
  for (const line of lines.slice(1)) {
    const c = splitCsvLine(line)
    if ((c[iName] ?? '').trim() === 'Aggregated') agg = c
    else if ((c[iName] ?? '').trim()) rows.push(c)
  }
  if (!agg) return null

  const requests = num(agg[iReq]) ?? 0
  const failures = num(agg[iFail]) ?? 0
  return {
    requests,
    failures,
    failRatePct: requests > 0 ? (failures / requests) * 100 : 0,
    rps: num(agg[iRps]) ?? 0,
    avgMs: num(agg[iAvg]) ?? 0,
    p50Ms: i50 >= 0 ? num(agg[i50]) : undefined,
    p95Ms: i95 >= 0 ? num(agg[i95]) : undefined,
    p99Ms: i99 >= 0 ? num(agg[i99]) : undefined,
    maxMs: iMax >= 0 ? num(agg[iMax]) : undefined,
    perEndpoint: rows.map((c) => ({
      name: [(c[iType] ?? '').trim(), (c[iName] ?? '').trim()].filter(Boolean).join(' '),
      requests: num(c[iReq]) ?? 0,
      failures: num(c[iFail]) ?? 0,
      avgMs: num(c[iAvg]) ?? 0,
      p95Ms: i95 >= 0 ? num(c[i95]) : undefined,
    })),
  }
}

/**
 * 콘솔 출력에서 어림값 뽑기.
 *
 * Locust 는 두 종류의 표를 주기적으로 찍는데, 둘 다 합계 행의 이름이 `Aggregated` 다.
 *  1) 통계 표 — 요청수·실패수·평균·최소·최대·중앙값·초당요청
 *  2) 백분위 표 — 50% 66% 75% 80% 90% 95% 98% 99% 99.9% 99.99% 100% 요청수
 * 열 개수로 둘을 가른다. 어느 쪽도 아니면 버린다.
 */
export function parseLocustConsole(text: string): PerfLive {
  const live: PerfLive = {}
  for (const raw of (text ?? '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line.startsWith('Aggregated')) continue
    // `17(0.20%)` 처럼 붙어 나오는 실패 표기를 분리한다
    const cells = line
      .replace(/\|/g, ' ')
      .replace(/\((\d+(?:\.\d+)?)%\)/g, ' ')
      .split(/\s+/)
      .slice(1)
    const nums = cells.map((c) => Number(c.replace(/,/g, ''))).filter((n) => Number.isFinite(n))

    // 백분위 표: 11개 백분위 + 요청수 = 12개
    if (nums.length === 12) {
      live.p95Ms = nums[5]
      live.requests = nums[11]
      continue
    }
    // 통계 표: 요청수 실패수 평균 최소 최대 중앙값 초당요청 초당실패 = 8개
    if (nums.length === 8) {
      live.requests = nums[0]
      live.failures = nums[1]
      live.avgMs = nums[2]
      live.rps = nums[6]
    }
  }
  return live
}
