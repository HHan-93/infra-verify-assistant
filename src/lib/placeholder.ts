// 명령어 안의 `<입력값>` 자리표시자 — 프리셋/시나리오/검증 러너가 같은 규칙을 쓴다.
//
// **문자 집합을 좁게 잡는 이유**
// 예전 규칙은 `<` 와 `>` 사이에 아무 문자나 허용했다(`/<([^<>\n]+)>/`). 그런데 명령어에는
// 셸·awk 문법으로 들어간 `<` 와 `>` 가 흔하다. 실제로 이런 일이 있었다.
//
//   awk '... for(i=0;i<int(v/5);i++) ... printf("\n부하 전 %d%% ->  ...")'
//                     ^ 여기서 시작해                        ^ 여기까지가
//   통째로 "입력값 이름"으로 잡혀, 멀쩡한 스텝이 "입력값이 필요합니다"로 실행을 거부했다.
//
// 입력값 이름은 영문·한글·숫자와 `_ - . :` 공백 정도면 충분하므로 셸 문법 문자는 전부 뺀다.
// 길이도 40자로 제한한다 — 그보다 긴 것은 이름이 아니라 코드다.
// (heredoc `<< 'EOF'` 는 `<` 가 연속이라 자연히 제외된다)
const PH_BODY = "[^<>\\n(){}\\[\\];\"'`$=%*+\\\\|&,/!?]{1,40}"

/** 전역 매칭용 — 매번 새로 만든다(lastIndex 공유 사고 방지) */
export const placeholderRe = (): RegExp => new RegExp(`<(${PH_BODY})>`, 'g')

/** 아직 값이 안 채워진 `<...>` 가 남아 있는지 */
export const hasPlaceholder = (cmd: string): boolean => new RegExp(`<${PH_BODY}>`).test(cmd)

/** 등장 순서대로 중복 없이 이름만 추출 */
export function extractPlaceholders(cmd: string): string[] {
  const found: string[] = []
  for (const m of cmd.matchAll(placeholderRe())) if (!found.includes(m[1])) found.push(m[1])
  return found
}

/** 값이 있는 것만 치환 — 빈 값은 `<이름>` 그대로 남겨 '아직 미입력'임이 드러나게 한다 */
export function fillPlaceholders(cmd: string, values: Record<string, string>): string {
  return cmd.replace(placeholderRe(), (full, key: string) => (values[key]?.trim() ? values[key] : full))
}
