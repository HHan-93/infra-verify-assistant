/**
 * Ceph 카드 · [상세 보기] 창에서 보여 주는 말(2026-11-07 사용자 결정, 목업). 판정(마일스톤)은 건드리지 않는다.
 */

export type CephHealth = 'OK' | 'WARN' | 'ERR' | 'unknown'

/**
 * 카드 맨 아래 한 줄 — **이번 검증에서 복구를 실제로 봤는지**(peak > 0)로 말을 가른다.
 * 예전엔 HEALTH_OK · 남은 것 0 이면 늘 '복구 완료', 아니면 늘 '리밸런스 진행 중' 이었다. 검증 전 평상시에도 '복구 완료' 가 떴고,
 * mon 디스크 여유 부족(MON_DISK_LOW)처럼 복제와 무관한 경고만 있는데 degraded · misplaced 0 · 진행률 100% 옆에 '리밸런스 진행 중' 이 떴다
 * (11-07 캡처). 복구를 본 적 없으면 '정상' · '복제와 무관한 경고', 본 뒤면 '복구 완료' · '다른 경고 남음'.
 */
export function cephNote(health: CephHealth, remain: number, peak: number): string {
  if (health === 'unknown') return '조회 실패 (권한/명령 확인)'
  if (remain > 0) return '리밸런스 진행 중'
  const seen = peak > 0
  if (health === 'OK') return seen ? 'HEALTH_OK · 복구 완료' : 'HEALTH_OK · 정상'
  return seen ? '데이터 복구 완료 · 다른 경고 남음 (위 사유)' : '데이터 정상 · 복제와 무관한 경고 있음 (위 사유)'
}

const p2 = (n: number) => String(n).padStart(2, '0')
const fmt = (t: number) => {
  const d = new Date(t)
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`
}

/**
 * `ceph log last` 줄의 앞 시각(UTC · `2026-10-28T02:10:34.042868+0000`)을 이 PC 시간대로 바꾼다. 시간대가 붙어 있어 절대 시각이라
 * 호스트 시계 보정은 필요 없다(서버가 찍은 시각 그대로). 꼴이 다른 줄은 손대지 않는다.
 */
export function cephLogLocal(text: string): string {
  return text
    .split('\n')
    .map((l) => {
      const m = l.match(/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.\d+)?([+-]\d\d):?(\d\d)\s?(.*)$/)
      if (!m) return l
      const t = Date.parse(`${m[1]}${m[2]}:${m[3]}`)
      return Number.isNaN(t) ? l : `${fmt(t)}  ${m[4]}`
    })
    .join('\n')
}

/** 칠할 줄 — 경고 · 오류(클러스터 로그의 [WRN] · [ERR], health detail 의 [WRN] · [ERR], ceph -s 의 health 아래) */
export const cephLineHot = (l: string): boolean => /\[(WRN|ERR)\]|HEALTH_(WARN|ERR)/.test(l)

/**
 * 클러스터 로그에서 칠할 줄 — **상태가 바뀐 줄만**. 복구 중에는 거의 모든 줄이 `[WRN] Health check update` 라 [WRN] 을 다 칠하면
 * 아무것도 눈에 띄지 않았다(10-28 1회차 로그로 확인). 경고 시작(Health check failed) · 오류는 노랑, 해소(cleared · now healthy)는 초록.
 */
export function cephLogTone(l: string): 'bad' | 'good' | '' {
  if (/Health check cleared|Cluster is now healthy|overall HEALTH_OK/i.test(l)) return 'good'
  if (/Health check failed|\[ERR\]/.test(l)) return 'bad'
  return ''
}

/**
 * 자주 나오는 경고 코드의 뜻 — health detail 아래 한 줄씩. 모르는 코드는 붙이지 않는다(원문만).
 * 뜻은 Ceph 문서의 health check 설명을 검증 맥락으로 줄인 것이다.
 */
const HINTS: Record<string, string> = {
  MON_DISK_LOW: 'mon 데이터가 있는 디스크의 여유가 30% 아래입니다(5% 아래면 HEALTH_ERR). OSD 용량과는 별개입니다.',
  MON_DISK_CRIT: 'mon 데이터 디스크 여유가 5% 아래입니다. 더 줄면 mon 이 멈출 수 있습니다.',
  MON_DOWN: '모니터 하나 이상이 quorum 밖에 있습니다(노드를 내렸으면 당연히 뜹니다).',
  MON_CLOCK_SKEW: '모니터 사이 시계가 어긋났습니다. NTP(chrony) 동기화를 확인하세요. 데이터 복제와는 무관합니다.',
  OSD_DOWN: 'OSD 가 down 입니다(노드를 내렸으면 그 노드의 OSD).',
  OSD_HOST_DOWN: '호스트 하나의 OSD 가 모두 down 입니다.',
  OSD_NEARFULL: 'OSD 사용량이 nearfull 비율을 넘었습니다. 복구 중 다른 OSD 로 데이터가 몰리면 full 이 될 수 있습니다.',
  OSD_FULL: 'OSD 가 full 이라 쓰기가 막힙니다.',
  POOL_NEARFULL: '풀 사용량이 한도에 가깝습니다.',
  PG_DEGRADED: '복제본이 모자란 PG 가 있습니다(복구가 진행되면 줄어듭니다).',
  PG_AVAILABILITY: '읽기 · 쓰기를 못 하는 PG 가 있습니다(peering · down). 서비스에 바로 영향이 있습니다.',
  OBJECT_MISPLACED: '제자리가 아닌 오브젝트가 있습니다(재배치 중, 데이터 손실은 아님).',
  RECENT_CRASH: '최근 데몬이 죽은 기록이 있습니다. ceph crash ls 로 무엇이 언제 죽었는지 확인합니다.',
  SLOW_OPS: '응답이 늦은 요청이 쌓였습니다(복구 부하 · 디스크 지연).',
}

export function cephHints(text: string): { code: string; desc: string }[] {
  const codes = Array.from(new Set([...text.matchAll(/\b([A-Z][A-Z0-9]+(?:_[A-Z0-9]+)+)\b/g)].map((m) => m[1])))
  return codes.filter((c) => HINTS[c]).map((code) => ({ code, desc: HINTS[code] }))
}
