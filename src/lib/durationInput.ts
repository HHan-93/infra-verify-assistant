/**
 * 사람이 적은 시간(목표 복구 시간 등) → 초.
 *
 * 받는 형식: `1:30` · `1분 30초` · `1분` · `30초` · `90`(숫자만 = 초) · `1m30s` · `2.5분`.
 * 예전에는 숫자만 모아 읽어서 `1분 30초` 가 '130초' 가 됐다 — 단위마다 따로 읽는다.
 *
 * 반환: 빈 칸·0 이면 `undefined`(판정 안 함), 읽을 수 없으면 `null`(호출한 쪽이 직전 값을 지킨다 —
 * 오타 하나에 목표가 조용히 지워지면 그 항목이 판정에서 빠진 것을 모른 채 리포트가 나간다).
 */
export function parseDurationInput(v: string): number | undefined | null {
  const t = v.trim().toLowerCase()
  if (!t) return undefined
  const c = t.match(/^(\d+):(\d{1,2})$/)
  if (c) return +c[2] >= 60 ? null : +c[1] * 60 + +c[2] || undefined
  const m = t.match(/^(?:(\d+(?:\.\d+)?)\s*(?:분|m|min)\s*)?(?:(\d+(?:\.\d+)?)\s*(?:초|s|sec)?)?$/)
  if (!m || (m[1] == null && m[2] == null)) return null
  const sec = (m[1] ? parseFloat(m[1]) * 60 : 0) + (m[2] ? parseFloat(m[2]) : 0)
  if (!Number.isFinite(sec)) return null
  // 0 은 '판정하지 않음' 으로 읽는다 — 목표 0초는 모든 회차를 불합격으로 만들어, 끄려고 0 을 넣은 사람이
  // 리포트의 '0/N 합격' 을 보고서야 알게 된다(검토 지적). 끄는 방법은 비우는 것과 같다.
  return Math.round(sec) === 0 ? undefined : Math.round(sec)
}

/**
 * 걸린 시간(ms) → 리포트 표기. `42초` · `8분 02초` · `1시간 05분`.
 *
 * 리포트는 예전에 `08:02` 로 적었는데, 바로 옆 'DOWN 감지 14:51:06' 같은 **시각** 과 생김새가 같아 '8시 2분인가' 로 읽혔다
 * (사용자 지적 10-27). 단위를 글자로 붙여 시각(hh:mm:ss)과 꼴로 갈라지게 한다. 1시간을 넘으면 초는 뺀다 — 그 길이에서
 * 초는 의미가 없고, 비교표 칸을 넘친다. 음수(DOWN 감지보다 먼저 관측)는 0 으로 자르지 않고 '−' 를 붙인다.
 * 화면 타임라인의 '+mm:ss'(검증 시작 후 경과 열)는 그대로 둔다 — 열 머리가 경과임을 말하고, 자릿수가 맞아야 세로로 읽힌다.
 */
export function fmtDuration(ms: number): string {
  if (ms < 0) return `−${fmtDuration(-ms)}`
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}초`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}분 ${String(s % 60).padStart(2, '0')}초`
  return `${Math.floor(m / 60)}시간 ${String(m % 60).padStart(2, '0')}분`
}
