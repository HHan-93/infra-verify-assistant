// 세션 비교(NodeDiff)용 LCS 기반 줄 단위 diff.
// 기존에는 줄 번호를 그대로 맞춰서 비교했는데, 그러면 어느 한 줄이라도 위아래로 밀리면
// (프롬프트 길이 차이, 빈 줄 하나 차이 등) 그 지점 이후 모든 줄이 "다르다"고 나와버린다.
// LCS(최장 공통 부분수열)로 실제 대응되는 줄을 찾아 정렬해야, 진짜 달라진 줄만 정확히 잡힌다.

interface RawOp {
  type: 'same' | 'add' | 'del'
  aLine?: string
  bLine?: string
}

/** 표준 LCS DP + 역추적으로 a→b 변환 시퀀스(same/add/del)를 만든다. */
function diffLinesRaw(a: string[], b: string[]): RawOp[] {
  const n = a.length
  const m = b.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const ops: RawOp[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: 'same', aLine: a[i], bLine: b[j] })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: 'del', aLine: a[i] })
      i++
    } else {
      ops.push({ type: 'add', bLine: b[j] })
      j++
    }
  }
  while (i < n) {
    ops.push({ type: 'del', aLine: a[i] })
    i++
  }
  while (j < m) {
    ops.push({ type: 'add', bLine: b[j] })
    j++
  }
  return ops
}

export type DiffOp =
  | { type: 'same'; aLine: string; bLine: string }
  | { type: 'del'; aLine: string }
  | { type: 'add'; bLine: string }
  | { type: 'replace'; aLine: string; bLine: string }

/** 인접한 del 묶음 + add 묶음을 "치환(replace)"으로 짝지어, 한 줄만 바뀐 경우를
 *  del 한 줄 + add 한 줄이 아니라 replace 한 줄로 표시되게 한다. */
function groupReplaces(raw: RawOp[]): DiffOp[] {
  const result: DiffOp[] = []
  let i = 0
  while (i < raw.length) {
    const op = raw[i]
    if (op.type === 'same') {
      result.push(op as DiffOp)
      i++
      continue
    }
    let j = i
    const dels: RawOp[] = []
    while (j < raw.length && raw[j].type === 'del') {
      dels.push(raw[j])
      j++
    }
    const adds: RawOp[] = []
    while (j < raw.length && raw[j].type === 'add') {
      adds.push(raw[j])
      j++
    }
    const pairCount = Math.min(dels.length, adds.length)
    for (let k = 0; k < pairCount; k++) {
      result.push({ type: 'replace', aLine: dels[k].aLine!, bLine: adds[k].bLine! })
    }
    for (let k = pairCount; k < dels.length; k++) result.push({ type: 'del', aLine: dels[k].aLine! })
    for (let k = pairCount; k < adds.length; k++) result.push({ type: 'add', bLine: adds[k].bLine! })
    i = j
  }
  return result
}

export function diffLines(a: string[], b: string[]): DiffOp[] {
  return groupReplaces(diffLinesRaw(a, b))
}

export interface DiffRow {
  /** 기준(첫 번째) 세션 기준 줄 번호 — 다른 세션에만 있는 삽입 줄이면 null */
  refIdx: number | null
  /** sources 순서와 동일 — 그 세션에 대응 줄이 없으면 null */
  cells: (string | null)[]
  differs: boolean
}

/** 여러 세션의 줄 목록을 첫 번째 세션을 기준으로 정렬해 표 형태(행) 로 만든다.
 *  첫 번째 세션을 기준(anchor)으로 삼아 나머지 각 세션을 개별적으로 LCS 정렬한 뒤,
 *  기준 줄 위치를 축으로 다시 하나의 표로 합친다. */
export function buildDiffRows(sourcesLines: string[][]): DiffRow[] {
  if (sourcesLines.length === 0) return []
  const ref = sourcesLines[0]
  const others = sourcesLines.slice(1)
  const opsPerSource = others.map((lines) => diffLines(ref, lines))
  const cursors = opsPerSource.map(() => 0)
  const rows: DiffRow[] = []

  for (let r = 0; r <= ref.length; r++) {
    // 기준 줄 r 앞에 끼어드는(다른 세션에만 있는) 삽입 줄을 먼저 뽑아낸다.
    for (let si = 0; si < others.length; si++) {
      const ops = opsPerSource[si]
      while (cursors[si] < ops.length && ops[cursors[si]].type === 'add') {
        const op = ops[cursors[si]] as { type: 'add'; bLine: string }
        const cells: (string | null)[] = new Array(sourcesLines.length).fill(null)
        cells[si + 1] = op.bLine
        rows.push({ refIdx: null, cells, differs: true })
        cursors[si]++
      }
    }
    if (r === ref.length) break // 기준 줄이 더 없으면(끝에 붙은 삽입 줄만 처리하고) 종료
    const cells: (string | null)[] = new Array(sourcesLines.length).fill(null)
    cells[0] = ref[r]
    let differs = false
    for (let si = 0; si < others.length; si++) {
      const ops = opsPerSource[si]
      const op = ops[cursors[si]]
      cursors[si]++
      if (!op) {
        differs = true
        continue
      }
      if (op.type === 'same') cells[si + 1] = op.bLine
      else if (op.type === 'del') differs = true
      else if (op.type === 'replace') {
        cells[si + 1] = op.bLine
        differs = true
      }
    }
    rows.push({ refIdx: r, cells, differs })
  }
  return rows
}
