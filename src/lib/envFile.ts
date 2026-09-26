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
