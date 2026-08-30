// 다중 실행 결과를 **같은 출력끼리 묶기** 위한 유틸.
//
// 다중 실행을 쓰는 진짜 이유는 "어느 노드만 다른가" 다. 그런데 결과가 노드별로 나열되기만 하면
// 5개 출력을 사람이 눈으로 대조해야 하고, 노드가 늘수록 그 일이 불가능해진다.
//
// 묶기 전에 **노드마다 당연히 다른 값**을 지워야 한다(시각·자기 호스트명·PID). 안 지우면 전부
// "서로 다름" 으로 갈라져 묶기 자체가 무의미해진다. 반대로 너무 많이 지우면 진짜 차이가 사라진다 —
// 그래서 지우는 것은 좁게 잡고, **무엇을 무시했는지 화면에 밝힌다**(사람이 판단할 수 있게).

/** 정규화에서 무시한 것 — 화면에 그대로 보여준다 */
export type IgnoredKind = 'time' | 'host' | 'pid'

export const IGNORED_LABEL: Record<IgnoredKind, string> = {
  time: '시각',
  host: '호스트명',
  pid: 'PID',
}

// 2026-08-30 18:40:12 / 2026-08-30T18:40:12.123Z / Aug 30 18:40:12 / 18:40:12
const TS_RE =
  /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?\b|\b[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\b|\b\d{2}:\d{2}:\d{2}\b/g
// pid 1234 / PID=1234 / [pid 1234]
const PID_RE = /\bpid[\s=:]+\d+/gi

/**
 * 노드마다 다를 수밖에 없는 값을 자리표시자로 바꾼다.
 *
 * `hostAliases` 는 그 결과를 낸 세션의 이름·호스트다. 자기 호스트명이 출력에 박혀 있으면
 * (`con1 systemd[1]: ...`) 그것만으로 전부 다른 출력이 된다.
 */
export function normalizeOutput(text: string, hostAliases: string[] = []): { text: string; ignored: IgnoredKind[] } {
  const ignored = new Set<IgnoredKind>()
  let out = (text ?? '').replace(/\r/g, '')

  const before = out
  out = out.replace(TS_RE, '<시각>')
  if (out !== before) ignored.add('time')

  const beforePid = out
  out = out.replace(PID_RE, 'pid <PID>')
  if (out !== beforePid) ignored.add('pid')

  for (const raw of hostAliases) {
    const alias = (raw ?? '').trim()
    // 두 글자 이하는 바꾸지 않는다 — 우연히 겹쳐 멀쩡한 출력을 훼손한다
    if (alias.length < 3) continue
    const re = new RegExp(alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')
    const beforeHost = out
    out = out.replace(re, '<호스트>')
    if (out !== beforeHost) ignored.add('host')
  }

  // 줄 끝 공백과 앞뒤 빈 줄만 정리한다(들여쓰기는 의미가 있으므로 건드리지 않는다)
  out = out
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/^\n+|\n+$/g, '')

  return { text: out, ignored: [...ignored] }
}

export interface OutputGroup<T> {
  /** 정규화된 출력 — 묶는 기준 */
  key: string
  /** 이 그룹에 속한 항목들 (입력 순서 유지) */
  items: T[]
  /** 대표로 보여줄 원문 (첫 항목의 것) */
  sample: string
  /** 이 그룹을 만들 때 무시한 것들 */
  ignored: IgnoredKind[]
}

/**
 * 같은 출력끼리 묶는다. **큰 그룹이 앞에** 온다 — 다수가 기준이고 소수가 이상 신호다.
 * 크기가 같으면 입력 순서를 지킨다(같은 실행을 두 번 보면 순서가 뒤집히지 않게).
 */
export function groupOutputs<T>(
  entries: { item: T; text: string; hostAliases?: string[] }[],
): OutputGroup<T>[] {
  const map = new Map<string, OutputGroup<T>>()
  const order: string[] = []
  for (const e of entries) {
    const n = normalizeOutput(e.text, e.hostAliases ?? [])
    const g = map.get(n.text)
    if (g) {
      g.items.push(e.item)
      for (const k of n.ignored) if (!g.ignored.includes(k)) g.ignored.push(k)
    } else {
      map.set(n.text, { key: n.text, items: [e.item], sample: e.text, ignored: [...n.ignored] })
      order.push(n.text)
    }
  }
  const groups = order.map((k) => map.get(k) as OutputGroup<T>)
  return groups
    .map((g, i) => ({ g, i }))
    .sort((a, b) => b.g.items.length - a.g.items.length || a.i - b.i)
    .map((x) => x.g)
}

export interface DiffLine {
  kind: 'same' | 'add' | 'del'
  text: string
}

/**
 * 줄 단위 차이 (기준 → 대상).
 *
 * 다수 그룹과 다른 그룹을 비교해 **다른 줄만** 보여주기 위한 것이다. 전체 출력을 나란히 놓으면
 * 결국 사람이 눈으로 대조하게 되고, 그러면 묶은 의미가 없다.
 *
 * LCS 로 공통 부분을 찾는다. 출력이 수천 줄이면 비용이 커지므로 상한을 두고, 넘으면 비교를
 * 포기한다(전체 보기로 안내). 어설프게 자른 비교 결과가 '차이 없음' 으로 보이는 것이 더 나쁘다.
 */
export const DIFF_MAX_LINES = 400

export function diffLines(base: string, target: string): DiffLine[] | null {
  const a = (base ?? '').split('\n')
  const b = (target ?? '').split('\n')
  if (a.length > DIFF_MAX_LINES || b.length > DIFF_MAX_LINES) return null

  // LCS 길이 표
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i] })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ kind: 'del', text: a[i] })
      i++
    } else {
      out.push({ kind: 'add', text: b[j] })
      j++
    }
  }
  while (i < a.length) out.push({ kind: 'del', text: a[i++] })
  while (j < b.length) out.push({ kind: 'add', text: b[j++] })
  return out
}

/** 한 줄짜리 짧은 출력인가 — 이런 것은 묶는 것보다 표로 나란히 놓는 편이 낫다 */
export function isShortOutput(text: string, maxChars = 120): boolean {
  const t = (text ?? '').trim()
  return t.length > 0 && t.length <= maxChars && !t.includes('\n')
}
