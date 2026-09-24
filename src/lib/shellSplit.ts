// 셸 한 줄 명령을 '최상위 구분자'로 쪼개 사람이 읽을 단계로 만든다.
//
// 왜 필요한가 — 시나리오의 '실패 시 조치'·'원복' 명령은 한 줄에 여러 동작을 이어 붙인 경우가
// 많다. 화면에 그 한 줄을 그대로 뿌리면 두 줄로 줄바꿈된 문자열 덩어리가 되어, 정작 "무엇을
// 어떤 순서로 하는가"를 읽을 수 없다.
//
// **정규식으로 쪼개면 안 된다.** 실제 데이터에 이런 게 들어 있다:
//   getent hosts … || sudo resolvectl dns "$(ip route show default | awk '{print $5; exit}')" …
//                                                                            ↑ 따옴표 안의 `;`
// `;` 를 그냥 split 하면 awk 스크립트가 반토막 나 엉뚱한 단계가 만들어진다. `$( … )` 안의
// 구분자도 같은 문제다. 그래서 따옴표 상태와 괄호 깊이를 추적하며 **최상위에서만** 자른다.

/** 쪼갠 조각 하나 */
export interface ShellSegment {
  /** 명령 텍스트 (앞뒤 공백 제거) */
  cmd: string
  /**
   * 이 조각을 **앞 조각과 잇는** 연산자. 첫 조각은 undefined.
   *  `;` 순서대로 · `&&` 앞이 성공하면 · `||` 앞이 실패하면
   * 화면에서 "실패하면 이걸 한다" 를 설명할 때 이 값이 근거가 된다.
   */
  op?: ';' | '&&' | '||'
}

/**
 * 최상위 `;` · `&&` · `||` 로 쪼갠다. 따옴표(`'` `"`) 안과 `$( )` · `( )` · `` ` `` 안은 건드리지 않는다.
 * 쪼갤 것이 없으면 조각 1개(원문)를 돌려준다 — 호출부는 길이로 '나눌 가치가 있는지' 판단한다.
 */
export function splitShell(cmd: string): ShellSegment[] {
  const out: ShellSegment[] = []
  let buf = ''
  let pendingOp: ShellSegment['op'] | undefined
  let quote: "'" | '"' | '`' | null = null
  let depth = 0 // $( ) 와 ( ) 중첩 깊이

  const push = () => {
    const t = buf.trim()
    if (t) out.push(pendingOp ? { cmd: t, op: pendingOp } : { cmd: t })
    buf = ''
  }

  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]
    const next = cmd[i + 1]

    // 백슬래시 이스케이프는 다음 문자를 그대로 통과시킨다 (작은따옴표 안에서는 이스케이프가 없다)
    if (c === '\\' && quote !== "'" && next !== undefined) {
      buf += c + next
      i++
      continue
    }
    if (quote) {
      buf += c
      if (c === quote) quote = null
      continue
    }
    // heredoc 본문은 통째로 한 덩어리다.
    //   cat > f << 'EOF'
    //   a; b          ← 이 `;` 는 셸 구분자가 아니라 파일 내용이다
    //   EOF
    // 따옴표·괄호만 추적하던 때는 여기서 잘라 "cat > f << 'EOF'\na" 와 "b\nEOF" 라는
    // 엉뚱한 두 단계를 만들었다. 구분자 줄을 찾아 그때까지를 한 번에 삼킨다.
    // 끝 구분자를 못 찾으면 heredoc 이 아니라고 보고 그냥 흘린다 — `$((a << b))` 같은
    // 시프트 연산을 heredoc 으로 오인해 나머지를 통째로 먹어 버리지 않기 위해서다.
    if (c === '<' && next === '<') {
      const head = /^<<-?\s*(?:'([^']*)'|"([^"]*)"|([A-Za-z_][A-Za-z0-9_]*))/.exec(cmd.slice(i))
      const delim = head ? (head[1] ?? head[2] ?? head[3]) : ''
      if (delim) {
        const esc = delim.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const end = new RegExp(`\\n[ \\t]*${esc}[ \\t]*(?:\\n|$)`).exec(cmd.slice(i + head![0].length))
        if (end) {
          const take = head![0].length + end.index + end[0].length
          buf += cmd.slice(i, i + take)
          i += take - 1
          continue
        }
      }
    }
    if (c === "'" || c === '"' || c === '`') {
      buf += c
      quote = c
      continue
    }
    if (c === '(') {
      depth++
      buf += c
      continue
    }
    if (c === ')') {
      if (depth > 0) depth--
      buf += c
      continue
    }
    if (depth === 0) {
      if (c === ';') {
        push()
        pendingOp = ';'
        continue
      }
      if ((c === '&' || c === '|') && next === c) {
        push()
        pendingOp = c === '&' ? '&&' : '||'
        i++
        continue
      }
    }
    buf += c
  }
  push()
  // 전부 공백이었으면 원문을 한 조각으로 (빈 목록을 돌려주면 호출부가 명령을 잃는다)
  return out.length ? out : [{ cmd: cmd.trim() }]
}

/** 연산자를 사람 말로 — 단계 목록에서 앞 단계와의 관계를 밝힌다 */
export function opLabel(op: ShellSegment['op']): string {
  if (op === '&&') return '성공하면'
  if (op === '||') return '실패하면'
  return ''
}
