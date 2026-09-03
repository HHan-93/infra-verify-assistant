// Locust 결과 읽기 — **판정에 쓰는 숫자는 여기서만 만든다.**
//
// 출처가 셋이고 쓰임이 다르다.
//  - 끝난 뒤의 `run_stats.csv`      → 확정값. 판정은 이것으로만 한다.
//  - 돌고 있는 동안 `/stats/requests` → 진행 중 표시. 웹 UI 가 쓰는 것과 같은 값이다.
//  - 콘솔 출력                       → 위 요청이 안 될 때의 보루.
//
// 콘솔 표 파싱은 서식이 바뀌면 깨진다(Locust 판마다 열이 늘었다 줄었다 한다). 그래서
// **모양이 정확히 맞을 때만** 값을 받아들이고, 아니면 조용히 버린다 — 값 하나를 놓치는
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
  /** 응답 본문 평균 크기(byte) — 대역폭을 어림하는 데 쓴다 */
  avgContentBytes?: number
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

/** 돌고 있는 동안의 값 */
export interface PerfLive {
  requests?: number
  failures?: number
  rps?: number
  avgMs?: number
  p95Ms?: number
  /** 지금 붙어 있는 가상 사용자 수 */
  users?: number
}

/**
 * Locust 웹 UI 가 쓰는 `/stats/requests` 응답 읽기.
 *
 * 콘솔 표를 파싱하는 것보다 이쪽이 정본이다 — 웹 UI 를 띄우는 실행에서는 Locust 가 주기
 * 통계를 콘솔에 안 찍고(그래서 화면 숫자가 계속 '–' 였다), 서식이 판마다 바뀌지도 않는다.
 * 콘솔 파서는 이 요청이 실패할 때를 위한 보루로 남긴다.
 *
 * 합계는 `stats` 배열의 `Aggregated` 행에 있다. 그 행이 없으면 아무것도 주장하지 않는다.
 */
export function parseStatsApi(json: unknown): PerfLive {
  const j = (json ?? {}) as Record<string, unknown>
  const rows = Array.isArray(j.stats) ? (j.stats as Record<string, unknown>[]) : []
  const agg = rows.find((r) => String(r.name) === 'Aggregated')
  const n = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

  // 진행 중 백분위는 최근 구간 기준으로 따로 온다. 없으면(초반) 합계 행의 값을 쓴다.
  const pct = (j.current_response_time_percentiles ?? {}) as Record<string, unknown>
  const p95 = n(pct['response_time_percentile_0.95']) ?? n(agg?.['response_time_percentile_0.95'])

  const requests = n(agg?.num_requests)
  const failures = n(agg?.num_failures)
  return {
    requests,
    failures,
    rps: n(j.total_rps) ?? n(agg?.total_rps),
    avgMs: n(agg?.avg_response_time),
    p95Ms: p95,
    users: n(j.user_count),
  }
}

/**
 * 깨진 오류 문구 다듬기.
 *
 * 2.8.0 까지는 Locust 를 UTF-8 모드로 띄우지 않아, 윈도우가 **시스템 인코딩(CP949)** 으로
 * 낸 소켓 오류 메시지가 그대로 CSV 에 들어갔다. 그런 회차는 지금 읽어도 되살릴 수 없다
 * (바이트가 이미 U+FFFD 로 뭉개진 채 우리에게 온다).
 *
 * 그래도 **앞부분(오류 종류와 코드)은 멀쩡하다** — `ConnectionRefusedError(10061, '[WinError
 * 10061] …')`. 읽을 수 있는 데까지만 남기고 뒤는 잘라 그 사실을 밝힌다. 알아볼 수 없는
 * 글자를 그대로 늘어놓는 것보다, 무엇이 왜 안 보이는지 말하는 편이 낫다.
 */
export function tidyFailureText(text: string): string {
  const s = (text ?? '').replace(/\uFFFD/g, '\uFFFD')
  if (!s.includes('\uFFFD')) return s
  const head = s.slice(0, s.indexOf('\uFFFD')).replace(/[\s'"(,]+$/, '')
  return `${head} … (오류 문구가 깨져 읽을 수 없습니다 — 2.8.0 이전 방식으로 기록된 회차입니다)`
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
  const lines = (csv ?? '').split(/\r*\n/).filter((l) => l.trim())
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
  const iSize = idx('Average Content Size')
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
    avgContentBytes: iSize >= 0 ? num(agg[iSize]) : undefined,
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
  for (const raw of (text ?? '').split(/\r*\n/)) {
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

export interface PerfFailure {
  /** `GET /v3` */
  name: string
  /** 응답 코드나 예외 문구 그대로 */
  error: string
  count: number
}

/**
 * `run_failures.csv` → 실패 목록 (많은 것부터).
 *
 * 인프라 검증에서는 실패율 숫자보다 **무엇이 실패했는가**가 먼저다 — 503 인지, 연결
 * 타임아웃인지, 인증 만료인지에 따라 볼 곳이 달라진다. 그래서 요약에 같이 올린다.
 * 열 이름은 `Method,Name,Error,Occurrences`.
 */
export function parseLocustFailures(csv: string): PerfFailure[] {
  const lines = (csv ?? '').split(/\r*\n/).filter((l) => l.trim())
  if (lines.length < 2) return []
  const header = splitCsvLine(lines[0]).map((h) => h.trim().toLowerCase())
  const iMethod = header.indexOf('method')
  const iName = header.indexOf('name')
  const iError = header.indexOf('error')
  const iCount = header.indexOf('occurrences')
  if (iName < 0 || iError < 0) return []
  return lines
    .slice(1)
    .map((line) => {
      const c = splitCsvLine(line)
      const n = Number(String(c[iCount] ?? '').trim())
      return {
        name: [(c[iMethod] ?? '').trim(), (c[iName] ?? '').trim()].filter(Boolean).join(' '),
        error: tidyFailureText((c[iError] ?? '').trim()),
        count: Number.isFinite(n) ? n : 0,
      }
    })
    .filter((f) => f.error || f.name)
    .sort((a, b) => b.count - a.count)
}


export interface PerfHistoryPoint {
  /** 절대 시각(epoch ms) — 저장은 늘 절대값으로, 표시할 때만 상대로 바꾼다 */
  t: number
  /** 시작 기준 경과 초 (그래프 가로축) */
  sec: number
  users: number
  rps: number
  failsPerSec: number
  p50Ms?: number
  p95Ms?: number
}

/**
 * `run_stats_history.csv` → 초 단위 이력.
 *
 * 한 줄이 1초다. 열 이름은 `Timestamp,User Count,Type,Name,Requests/s,Failures/s,50%,…`
 * 이고 **Timestamp 는 epoch 초**다(우리 규칙대로 ms 로 바꿔 담는다).
 *
 * 시작 직후 백분위 칸은 `N/A` 로 온다 — 0 으로 바꾸면 그래프가 바닥에서 시작하는 거짓
 * 모양이 되므로 값 없음으로 둔다(recharts 는 끊어 그린다).
 */
export function parseLocustHistory(csv: string): PerfHistoryPoint[] {
  const lines = (csv ?? '').split(/\r*\n/).filter((l) => l.trim())
  if (lines.length < 2) return []
  const header = splitCsvLine(lines[0]).map((h) => h.trim())
  const idx = (name: string) => header.findIndex((h) => h.toLowerCase() === name.toLowerCase())
  const iT = idx('Timestamp')
  const iName = idx('Name')
  const iUsers = idx('User Count')
  const iRps = idx('Requests/s')
  const iFail = idx('Failures/s')
  const i50 = idx('50%')
  const i95 = idx('95%')
  if (iT < 0) return []

  const pts: PerfHistoryPoint[] = []
  for (const line of lines.slice(1)) {
    const c = splitCsvLine(line)
    // 요청별 행이 섞여 오는 판도 있다 — 합계만 쓴다
    if (iName >= 0 && (c[iName] ?? '').trim() !== 'Aggregated') continue
    const sec = num(c[iT])
    if (sec === undefined) continue
    pts.push({
      t: sec * 1000,
      sec: 0,
      users: num(c[iUsers]) ?? 0,
      rps: num(c[iRps]) ?? 0,
      failsPerSec: iFail >= 0 ? (num(c[iFail]) ?? 0) : 0,
      p50Ms: i50 >= 0 ? num(c[i50]) : undefined,
      p95Ms: i95 >= 0 ? num(c[i95]) : undefined,
    })
  }
  if (!pts.length) return []
  const t0 = pts[0].t
  return pts.map((p) => ({ ...p, sec: Math.round((p.t - t0) / 1000) }))
}

/**
 * 워밍업 이후 **구간 p95 중 최댓값**.
 *
 * 백분위는 평균처럼 다시 합칠 수 없다. 그래서 "앞 N초를 뺀 전체 p95" 를 계산하는 대신,
 * 남은 구간들의 p95 중 가장 나쁜 값을 쓴다 — "안정된 뒤 어느 순간에도 이 값 이하였다" 는
 * 더 보수적인(= 거짓 통과가 없는) 주장이 된다.
 */
export function worstP95After(history: PerfHistoryPoint[], warmupSec: number): number | undefined {
  const after = history.filter((p) => p.sec >= warmupSec && p.p95Ms !== undefined && p.rps > 0)
  if (!after.length) return undefined
  return Math.max(...after.map((p) => p.p95Ms as number))
}


/**
 * JMeter 대시보드의 `statistics.json` → 요약.
 *
 * `jmeter -n -t plan.jmx -l result.jtl -e -o report/` 가 만드는 파일이다. 원본 JTL 은 표본
 * 한 줄씩이라 수백만 줄이 될 수 있어 우리가 직접 백분위를 계산하지 않는다 — JMeter 가 이미
 * 집계해 둔 것을 읽는다.
 *
 * **백분위 칸 이름이 값을 말해 주지 않는다**: `pct1/pct2/pct3` 는 jmeter.properties 의
 * `aggregate_rpt_pct1/2/3` 설정을 따르고 기본값이 90/95/99 다. 그래서 pct2→p95, pct3→p99 로
 * 읽되 p50 은 없는 것으로 둔다(중앙값 칸이 없다). 설정을 바꾼 환경에서는 값이 밀릴 수 있어
 * 요약에 '기본 설정 기준' 이라고 밝힌다.
 */
export function parseJmeterStatistics(json: unknown): PerfSummary | null {
  const j = (json ?? {}) as Record<string, unknown>
  const n = (v: unknown): number | undefined => {
    const x = Number(v)
    return Number.isFinite(x) ? x : undefined
  }
  const total = j.Total as Record<string, unknown> | undefined
  if (!total) return null
  const requests = n(total.sampleCount) ?? 0
  const failures = n(total.errorCount) ?? 0
  const perEndpoint: PerfEndpointStat[] = Object.entries(j)
    .filter(([k]) => k !== 'Total')
    .map(([k, v]) => {
      const row = (v ?? {}) as Record<string, unknown>
      return {
        name: String(row.transaction ?? k),
        requests: n(row.sampleCount) ?? 0,
        failures: n(row.errorCount) ?? 0,
        avgMs: n(row.meanResTime) ?? 0,
        p95Ms: n(row.pct2ResTime),
      }
    })
  return {
    requests,
    failures,
    failRatePct: n(total.errorPct) ?? (requests > 0 ? (failures / requests) * 100 : 0),
    rps: n(total.throughput) ?? 0,
    avgMs: n(total.meanResTime) ?? 0,
    p50Ms: undefined,
    p95Ms: n(total.pct2ResTime),
    p99Ms: n(total.pct3ResTime),
    maxMs: n(total.maxResTime),
    avgContentBytes:
      n(total.receivedKBytesPerSec) !== undefined && (n(total.throughput) ?? 0) > 0
        ? ((n(total.receivedKBytesPerSec) as number) * 1024) / (n(total.throughput) as number)
        : undefined,
    perEndpoint,
  }
}

/**
 * JMeter 콘솔의 주기 요약 한 줄에서 진행 상황을 뽑는다.
 *
 * `summary +  12345 in 00:00:30 =  411.5/s Avg:    24 Min:     3 Max:   300 Err:     0 (0.00%)`
 * 형태다. `summary =` 로 시작하는 누적 줄이 더 쓸모 있어 그쪽을 우선한다.
 */
export function parseJmeterConsole(text: string): PerfLive {
  const live: PerfLive = {}
  for (const raw of (text ?? '').split(/\r*\n/)) {
    const line = raw.trim()
    if (!/^summary [+=]/.test(line)) continue
    const cumulative = line.startsWith('summary =')
    const m = line.match(
      /summary [+=]\s+([\d,]+) in [\d:]+ =\s+([\d.]+)\/s Avg:\s+([\d.]+).*?Err:\s+([\d,]+)/,
    )
    if (!m) continue
    const pick = {
      requests: Number(m[1].replace(/,/g, '')),
      rps: Number(m[2]),
      avgMs: Number(m[3]),
      failures: Number(m[4].replace(/,/g, '')),
    }
    // 누적 줄이 있으면 그것으로 덮는다(구간 줄은 그 30초만의 값이다)
    if (cumulative || live.requests === undefined) Object.assign(live, pick)
  }
  return live
}
