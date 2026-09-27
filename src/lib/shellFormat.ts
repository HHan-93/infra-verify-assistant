// 긴 셸 한 줄을 **읽기 좋게 줄로 나눠 보여주기** 위한 정리기.
//
// ⚠ **표시 전용이다.** 실행에는 원문 문자열을 그대로 쓴다. 여기서 만든 것을 돌리지 말 것 —
//   포맷이 틀려도 화면만 이상해야지, 서버에서 다른 명령이 돌면 안 된다.
//
// 왜 필요한가 — 원복 확인창이 `if … then … elif … else … fi` 가 줄줄이 붙은 한 덩어리를
// 그대로 흘려 보여줬다. 지우기 전에 "무엇을 지우는가" 를 읽으라고 띄우는 창인데, 정작
// 읽을 수가 없었다(사용자 지적).
//
// 쪼개는 기준은 **최상위 `;` 하나뿐**이다. `&&` `||` 는 한 동작으로 읽히므로 붙여 둔다
// (`sudo umount … || break`). 따옴표·`$( )` 안은 건드리지 않는다 — shellSplit.ts 와 같은 이유로
// 정규식 split 으로는 안 된다(`awk '{print $5; exit}'` 를 반토막 내지 않으려면).

/** 최상위 `;` 로 자른 조각들. `;;`(case 구분자)는 한 덩어리로 둔다 */
function splitBySemicolon(cmd: string): string[] {
  const out: string[] = []
  let buf = ''
  let quote: "'" | '"' | '' = ''
  let depth = 0 // $( ) · ` ` 중첩
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]
    if (quote) {
      buf += c
      if (c === quote) quote = ''
      continue
    }
    if (c === "'" || c === '"') {
      quote = c
      buf += c
      continue
    }
    if (c === '$' && cmd[i + 1] === '(') {
      depth++
      buf += '$('
      i++
      continue
    }
    if (c === '`') {
      depth = depth ? depth - 1 : 1
      buf += c
      continue
    }
    if (c === ')' && depth > 0) {
      depth--
      buf += c
      continue
    }
    if (c === ';' && depth === 0) {
      if (cmd[i + 1] === ';') {
        // case 의 `;;` — 조각을 끊고 그 자체를 한 조각으로
        if (buf.trim()) out.push(buf.trim())
        out.push(';;')
        buf = ''
        i++
        continue
      }
      if (buf.trim()) out.push(buf.trim())
      buf = ''
      continue
    }
    buf += c
  }
  if (buf.trim()) out.push(buf.trim())
  return out
}

/** 첫 낱말이 w 면 나머지를 돌려준다 (`do mountpoint …` → `mountpoint …`) */
function after(seg: string, w: string): string | null {
  if (seg === w) return ''
  return seg.startsWith(w + ' ') ? seg.slice(w.length + 1).trim() : null
}

const IND = '  '

/**
 * 표시용으로 줄을 나누고 들여쓴다.
 *
 * **글자를 잃지 않는다** — 마지막에 공백과 `;` 를 뺀 문자열이 원문과 같은지 확인하고,
 * 다르면 원문을 그대로 돌려준다. 모양을 못 잡는 명령이 있더라도 내용이 바뀌는 일은 없다.
 */
export function formatShell(cmd: string): string {
  const src = cmd.trim()
  if (!src) return src
  // 짧으면 굳이 나누지 않는다 — 한 줄로 읽히는 것을 억지로 세 줄 만들 이유가 없다
  if (src.length <= 80 && !/\b(then|do)\b/.test(src)) return src

  const lines: string[] = []
  let depth = 0
  const push = (s: string) => lines.push(IND.repeat(Math.max(0, depth)) + s)
  /** 앞 줄 끝에 `; then` 처럼 이어 붙인다 */
  const appendToLast = (s: string) => {
    if (!lines.length) push(s)
    else lines[lines.length - 1] += '; ' + s
  }

  const queue = splitBySemicolon(src)
  while (queue.length) {
    let seg = queue.shift() as string
    if (!seg) continue

    // 블록을 여는 말 — 앞 줄에 붙이고 한 칸 들어간다
    let opened = false
    for (const w of ['then', 'do']) {
      const rest = after(seg, w)
      if (rest === null) continue
      appendToLast(w)
      depth++
      opened = true
      if (rest) queue.unshift(rest)
      break
    }
    if (opened) continue

    // 블록을 닫는 말
    if (seg === 'fi' || seg === 'done' || seg === 'esac') {
      depth--
      push(seg)
      continue
    }
    if (seg === ';;') {
      depth--
      push(';;')
      continue
    }
    // 가운데 말 — 한 칸 나왔다가 다시 들어간다
    for (const w of ['else', 'elif']) {
      const rest = after(seg, w)
      if (rest === null) continue
      depth--
      if (w === 'else') {
        push('else')
        depth++
        if (rest) queue.unshift(rest)
      } else {
        // elif 는 뒤에 오는 `then` 이 다시 들여쓴다
        push(rest ? `elif ${rest}` : 'elif')
      }
      seg = ''
      break
    }
    if (!seg) continue
    push(seg)
  }

  const out = lines.join('\n')
  const norm = (s: string) => s.replace(/[\s;]+/g, '')
  return norm(out) === norm(src) ? out : src
}
