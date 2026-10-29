/**
 * 원격 로그의 터미널 색 코드 지우기 — 실시간 로그 화면과 masakari 판정이 **같은 규칙**을 쓴다(예전엔 세 벌이 있었고 지우는
 * 범위가 서로 달랐다 — 코드 검토 지적).
 *
 * 1) 정상적인 ESC 시퀀스(`\x1b[01;36m`, OSC 등)
 * 2) **ESC 가 떨어져 나간 SGR 조각**(`[01;35m` `[00m`) — 2026-10-26 masakari-engine.log 를 실시간 로그로 보니 줄마다 이게 글자로
 *    남아 있었다(로그 수집 단계에서 ESC 만 걸러진 것으로 보인다). 일반 글자를 지우지 않게 좁게 잡는다: 대괄호 안이 숫자·`;`
 *    뿐이고 `m` 으로 끝나며 바로 뒤가 `]` 가 아니어야 한다 — `[5m]`(5분) 같은 표기는 남는다.
 */
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g
// 숫자를 반드시 요구한다 — 빈 `[m` 까지 받으면 `[mysql]` 의 `[m` 이 지워졌다
const BARE_SGR_RE = /\[\d{1,3}(?:;\d{1,3})*m(?!\])/g

export const stripAnsi = (s: string) => s.replace(ANSI_RE, '').replace(BARE_SGR_RE, '')
