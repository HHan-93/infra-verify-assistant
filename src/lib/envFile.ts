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
  /** 따옴표와 **줄 끝 주석**을 뗀 값 */
  value: string
  /** 원문에 붙어 있던 따옴표(`"` `'`) — 저장할 때 그대로 다시 붙인다 */
  quote: string
  /**
   * 값 뒤에 붙어 있던 것 — `MFA_USE=false # 2단계 인증` 의 ` # 2단계 인증` 부분.
   * 앞 공백까지 **원문 그대로** 들고 있다가 저장할 때 다시 붙인다.
   *
   * 떼어 두지 않으면 값이 `false # 2단계 인증` 이 된다. 그러면 (1) true/false 드롭다운이
   * 안 뜨고 — 가이드가 특히 조심하라던 값이 자유 입력칸이 된다 — (2) 값만 고치려다
   * **주석이 통째로 사라지고** (3) `URL="a" # b` 처럼 뒤에 뭐가 붙으면 따옴표 판정까지
   * 어긋난다. 이 파일 머리말의 "주석·따옴표는 건드리지 않는다" 를 스스로 어기던 자리다.
   */
  comment: string
  /** 0-기반 줄 번호 */
  line: number
}

/**
 * `KEY=` 뒤의 원문을 값 · 따옴표 · 줄 끝 주석으로 가른다.
 *
 * 가르는 기준은 **공백 뒤의 `#`** 이다(dotenv · docker compose 가 쓰는 규칙).
 * `PASS=a#b` 처럼 공백 없이 붙은 `#` 은 값의 일부다 — 실제로 그렇게 읽히므로 그 편이 맞다.
 * 따옴표로 시작하면 **닫는 따옴표를 먼저 찾고** 그 뒤를 주석 자리로 본다.
 *
 * 뒤에 붙은 것이 주석 모양이 아니면(`KEY="a" b`) 가르지 않고 통째로 값으로 둔다 —
 * 모르는 것을 아는 척 쪼개면 저장할 때 원문과 달라진다.
 *
 * **어느 쪽으로 갈라도 저장할 때 그대로 다시 붙이므로 글자가 없어지지는 않는다.**
 */
function splitValue(raw: string): { value: string; quote: string; comment: string } {
  const plain = { value: raw, quote: '', comment: '' }
  const isTrailer = (t: string) => t === '' || /^\s*$/.test(t) || /^\s+#/.test(t)

  const q = raw[0]
  if (q === '"' || q === "'") {
    const end = raw.indexOf(q, 1)
    if (end > 0) {
      const rest = raw.slice(end + 1)
      if (isTrailer(rest)) return { value: raw.slice(1, end), quote: q, comment: rest }
    }
    return plain // 닫는 따옴표가 없거나 뒤에 엉뚱한 게 붙었다 — 손대지 않는다
  }

  const m = /^(.*?)(\s+#.*)$/.exec(raw)
  return m ? { value: m[1], quote: '', comment: m[2] } : plain
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
    rows.push({ key: m[1], ...splitValue(m[2]), line: i })
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
  // 주석은 원문 그대로 다시 붙인다 — 값만 고치러 온 사람이 주석을 지우게 두지 않는다
  lines[row.line] = `${row.key}=${row.quote}${next}${row.quote}${row.comment}`
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
  /**
   * 비교도 표시도 **주석까지 포함한 값**으로 한다.
   *
   * 값만 비교하면 원문 보기에서 주석만 고친 것이 "바뀌는 것 0건" 으로 나온다 — 파일은
   * 바뀌는데 확인창은 안 바뀐다고 말하는 셈이다. 주석이 없는 파일에서는 예전과 같다.
   */
  const map = (s: string) => {
    const m = new Map<string, string>()
    for (const r of parseEnvRows(s)) m.set(r.key, r.value + r.comment)
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
