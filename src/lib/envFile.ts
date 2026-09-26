// `KEY=VALUE` 만 늘어선 설정 파일(.env)을 **값만 안전하게** 고치기 위한 규칙.
//
// 왜 필요한가 — 경량(도커) 구성의 설정은 ConfigMap 이 아니라 호스트의 평범한 파일이다.
//   ~/contrabass_bf_306_lite/product-config/boot-factory-auth/cm.env
// 가이드 문서가 vi 대신 `sed -i` 를 권하는데, 그 이유가 "vi 로 고치다 기존 값을 안 지우고
// 붙여 `truefalse` 가 된다" 는 실수다. 값 칸을 따로 주면 그 실수 자체가 생기지 않는다.
//
// **줄 전체를 다시 쓰지 않는다.** 고친 줄 하나만 갈아 끼우고 주석·빈 줄·순서·따옴표는
// 건드리지 않는다 — 설정 파일에서 "내가 안 건드린 곳이 바뀌어 있는 것"이 가장 나쁘다.

export interface EnvRow {
  key: string
  /** 따옴표를 뗀 값 */
  value: string
  /** 원문에 붙어 있던 따옴표(`"` `'`) — 저장할 때 그대로 다시 붙인다 */
  quote: string
  /** 0-기반 줄 번호 */
  line: number
}

/**
 * `KEY=VALUE` 줄만 뽑는다.
 *
 * 주석(`#`)과 들여쓴 줄은 건너뛴다 — `  # KEY=값` 같은 주석 처리된 설정을 살아 있는 값으로
 * 보여주면, 고쳤는데 아무 일도 안 일어나는 상황이 된다.
 */
export function parseEnvRows(content: string): EnvRow[] {
  const rows: EnvRow[] = []
  content.split('\n').forEach((l, i) => {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(l)
    if (!m) return
    const raw = m[2]
    const q =
      raw.length >= 2 && (raw[0] === '"' || raw[0] === "'") && raw[raw.length - 1] === raw[0] ? raw[0] : ''
    rows.push({ key: m[1], value: q ? raw.slice(1, -1) : raw, quote: q, line: i })
  })
  return rows
}

/**
 * 이 파일을 키-값으로 다룰 수 있는가.
 *
 * 확장자만 보지 않는다 — 이름이 `.env` 가 아니어도 같은 모양인 파일이 있고, 반대로 `.env`
 * 인데 내용이 다를 수도 있다. **내용이 실제로 그 모양일 때만** 참이다.
 * `nova.conf` 처럼 `[section]` 과 `key = value`(공백 있음)가 섞인 파일은 걸리지 않는다.
 */
export function isEnvLike(content: string, rows: EnvRow[] = parseEnvRows(content)): boolean {
  const meaningful = content.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'))
  return meaningful.length >= 3 && rows.length >= Math.ceil(meaningful.length * 0.7)
}

/** 그 줄만 갈아 끼운 새 내용을 돌려준다. 줄 번호가 맞지 않으면 원문 그대로 돌려준다 */
export function replaceEnvValue(content: string, row: EnvRow, next: string): string {
  const lines = content.split('\n')
  if (lines[row.line] === undefined) return content
  lines[row.line] = `${row.key}=${row.quote}${next}${row.quote}`
  return lines.join('\n')
}

// ── 무엇이 바뀌는지 ────────────────────────────────────────────
//
// 저장은 파일을 통째로 덮어쓴다. 그래서 "무엇이 바뀌는가" 를 말해 주지 않으면, 40개 중 셋을
// 고친 사람도 자기가 고친 게 그 셋뿐인지 확인할 길이 없다. ConfigMap 탭은 적용 전에
// `키 · 옛값 → 새값` 을 보여주는데, 파일 쪽만 백업 경로만 띄우고 있었다.

export interface EnvChange {
  key: string
  /** 'changed' 는 값이 바뀐 것, 'added'·'removed' 는 줄 자체가 생기거나 없어진 것 */
  kind: 'changed' | 'added' | 'removed'
  from: string
  to: string
}

/** 두 내용의 **키 단위** 차이. 같은 키가 여러 번 나오면 마지막 것을 기준으로 본다 */
export function diffEnv(before: string, after: string): EnvChange[] {
  const map = (s: string) => {
    const m = new Map<string, string>()
    for (const r of parseEnvRows(s)) m.set(r.key, r.value)
    return m
  }
  const a = map(before)
  const b = map(after)
  const out: EnvChange[] = []
  for (const [k, v] of b) {
    if (!a.has(k)) out.push({ key: k, kind: 'added', from: '', to: v })
    else if (a.get(k) !== v) out.push({ key: k, kind: 'changed', from: a.get(k) ?? '', to: v })
  }
  for (const [k, v] of a) if (!b.has(k)) out.push({ key: k, kind: 'removed', from: v, to: '' })
  return out
}

export interface LineChange {
  kind: 'added' | 'removed'
  text: string
}

/**
 * 키-값이 아닌 파일(`nova.conf` 등)의 줄 단위 차이.
 *
 * 정교한 diff 가 아니다 — **무엇이 들어오고 무엇이 빠지는지**만 센다. 줄 하나를 끼워 넣으면
 * 그 아래가 전부 밀리는데, 위치를 맞춰 보여주려다 "40줄이 바뀝니다" 같은 거짓 경고를 내는
 * 것보다 낫다. 옮겨 적기만 한 줄은 양쪽에서 상쇄돼 아예 안 나온다.
 */
export function diffLines(before: string, after: string): LineChange[] {
  const count = (s: string) => {
    const m = new Map<string, number>()
    for (const l of s.split('\n')) m.set(l, (m.get(l) ?? 0) + 1)
    return m
  }
  const a = count(before)
  const b = count(after)
  const out: LineChange[] = []
  for (const [l, n] of b) {
    const extra = n - (a.get(l) ?? 0)
    for (let i = 0; i < extra; i++) if (l.trim()) out.push({ kind: 'added', text: l })
  }
  for (const [l, n] of a) {
    const gone = n - (b.get(l) ?? 0)
    for (let i = 0; i < gone; i++) if (l.trim()) out.push({ kind: 'removed', text: l })
  }
  return out
}
