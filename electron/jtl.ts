/**
 * JMeter 결과 파일(JTL)을 **초 단위 이력**으로 접는다.
 *
 * ── 왜 필요했나
 * JMeter 회차에는 "시간에 따라 어떻게 됐는지"가 없었다. 그래서 화면에서 시간 그래프도,
 * 워밍업 제외도 못 쓰게 막아 두고 "JMeter 는 초 단위 이력을 남기지 않습니다" 라고 적어
 * 두었는데 **그건 사실이 아니었다.** JMeter 가 만드는 대시보드(statistics.json)가 합계만
 * 담고 있을 뿐, 원본 JTL 은 요청 한 건마다 `timeStamp,elapsed,...` 를 그대로 남긴다.
 * 즉 재료는 처음부터 있었다.
 *
 * ── 왜 Locust 이력 CSV 모양으로 내놓나
 * 화면·판정·그래프가 이미 `run_stats_history.csv`(Locust) 를 읽어 돌아간다. 여기서 같은
 * 모양으로 내놓으면 그 아래 전부를 손대지 않아도 JMeter 회차가 같은 길을 탄다 —
 * `parseLocustHistory` · `worstP95After` · 판정 · Recharts 까지.
 *
 * ── 왜 줄 단위로 받나
 * 30분 실행이면 JTL 이 수십만 줄, 수십 MB 가 된다. 통째로 읽어 IPC 로 실어 보내면 창이
 * 멎는다. 그래서 메인에서 파일을 흘려 읽으며 한 줄씩 넣고, 접힌 결과(초당 한 줄)만
 * 내보낸다.
 *
 * ── 백분위를 다시 합치지 않는다
 * p95 는 평균처럼 합칠 수 없으므로 **구간(1초)마다 그 구간의 표본으로 직접 계산**한다.
 * 판정은 이 구간 p95 들의 최댓값을 쓴다(`worstP95After`) — "안정된 뒤 어느 순간에도 이
 * 값 이하였다" 는 더 보수적인 주장이라 거짓 통과가 생기지 않는다.
 */

/**
 * 따옴표를 아는 CSV 한 줄 분리기.
 *
 * `src/lib/perfParse.ts` 에도 같은 것이 있지만 가져다 쓰지 않는다 — 렌더러 쪽 모듈을
 * 메인 프로세스가 끌어오면 의존 방향이 뒤집히고, 그쪽이 shared-types 를 다시 물고 온다.
 * 열댓 줄을 두 번 두는 편이 낫다. (JMeter 는 라벨에 쉼표가 들어가면 따옴표로 감싸므로,
 * 단순 split 으로는 뒤 칸이 통째로 한 칸씩 밀린다.)
 */
function splitCsv(line: string): string[] {
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

function pct(sorted: number[], p: number): number {
  if (!sorted.length) return 0
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[i]
}

type Bucket = {
  /** 이 초에 끝난 요청 수 (표본을 버려도 이 수는 줄지 않는다) */
  count: number
  /** 응답 시간(ms) 표본 — 백분위 계산용, 상한까지만 모은다 */
  samples: number[]
  fails: number
  /** 그 순간 살아 있던 스레드 수 중 최댓값 = Locust 의 '사용자 수' 에 해당 */
  users: number
}

/**
 * 구간마다 표본을 몇 개까지 들고 있을지.
 *
 * p95 를 정확히 내려면 그 초의 표본이 다 있어야 하는데, 초당 수만 건이 나오는 실행에서는
 * 그것만으로 메모리가 수백 MB가 된다. 1초에 2만 건이면 p95 는 이미 충분히 안정적이라
 * 여기서 끊는다(넘치면 버리고, 버린 건수는 요청 수·실패 수에는 그대로 센다).
 */
const MAX_SAMPLES_PER_SEC = 20000

/**
 * JTL 줄들을 Locust 이력 CSV 문자열로 접는다.
 *
 * 첫 줄은 헤더여야 한다(JMeter 기본값 `print_field_names=true`). 헤더가 없거나 필요한
 * 칸이 없으면 빈 문자열을 돌려준다 — 화면은 "이력 없음" 으로 그리면 된다. (구형 설정의
 * XML JTL 도 헤더를 못 찾으므로 같은 길로 빠진다.)
 */
export async function jtlLinesToHistoryCsv(lines: Iterable<string> | AsyncIterable<string>): Promise<string> {
  let iTime = -1
  let iElapsed = -1
  let iSuccess = -1
  let iThreads = -1
  let headerSeen = false
  const buckets = new Map<number, Bucket>()

  // for-await 로 받는다 — 메인은 readline(비동기), 검사 스크립트는 배열(동기)을 넘긴다
  for await (const raw of lines) {
    const line = raw.replace(/\r+$/, '')
    if (!line.trim()) continue
    if (!headerSeen) {
      const h = splitCsv(line).map((x) => x.trim().toLowerCase())
      iTime = h.indexOf('timestamp')
      iElapsed = h.indexOf('elapsed')
      iSuccess = h.indexOf('success')
      iThreads = h.indexOf('allthreads')
      headerSeen = true
      if (iTime < 0 || iElapsed < 0) return ''
      continue
    }
    const c = splitCsv(line)
    const ts = Number(c[iTime])
    const el = Number(c[iElapsed])
    if (!Number.isFinite(ts) || !Number.isFinite(el)) continue
    const sec = Math.floor(ts / 1000)
    let b = buckets.get(sec)
    if (!b) {
      b = { count: 0, samples: [], fails: 0, users: 0 }
      buckets.set(sec, b)
    }
    b.count++
    // 상한을 넘은 표본은 버린다 — 건수(count)는 위에서 이미 셌으므로 초당 요청 수는 맞는다
    if (b.samples.length < MAX_SAMPLES_PER_SEC) b.samples.push(el)
    if (iSuccess >= 0 && (c[iSuccess] ?? '').trim().toLowerCase() !== 'true') b.fails++
    if (iThreads >= 0) {
      const th = Number(c[iThreads])
      if (Number.isFinite(th) && th > b.users) b.users = th
    }
  }

  if (!buckets.size) return ''
  const secs = [...buckets.keys()].sort((a, b) => a - b)
  const rows = secs.map((sec) => {
    const b = buckets.get(sec)!
    const sorted = b.samples.slice().sort((x, y) => x - y)
    return [
      String(sec),
      String(b.users),
      String(b.count),
      String(b.fails),
      String(Math.round(pct(sorted, 50))),
      String(Math.round(pct(sorted, 95))),
      'Aggregated',
    ].join(',')
  })
  // 칸 이름을 Locust 것과 같게 둔다 — 읽는 쪽(parseLocustHistory)이 이름으로 찾는다
  return ['Timestamp,User Count,Requests/s,Failures/s,50%,95%,Name', ...rows].join('\n') + '\n'
}
