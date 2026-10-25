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
