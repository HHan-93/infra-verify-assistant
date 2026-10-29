/**
 * 상태보드 — 복구 시간의 **기준 시각**을 서버 기록으로 잡을지(사용자 결정 (a), 2026-10-26).
 *
 * 17:53 회차에서 클러스터 저널의 노드 이탈 17:53:33 · pacemaker 의 int_vip start 17:53:38 인데 Q-Term 은 17:53:54 에 DOWN,
 * 17:53:55 에 VIP 이동을 봤다 — 상태보드 한 프레임이 Ceph·kubectl 타임아웃을 다 기다려야 끝나 pcs 조회도 밀렸다. 그 21초만큼
 * 모든 복구 시간이 **짧게(유리하게)** 나왔다. 서버가 스스로 남긴 시각이 믿을 만하면 그것을 쓰고, 도구 감지 시각은 참고로 둔다.
 *
 * 교차 검증(하나라도 어긋나면 도구 감지 시각): 검증 시작 이후 · 도구 감지보다 앞(같거나) · SRV_MAX_LEAD_MS 이내.
 * 너무 앞선 기록은 같은 사건이 아닐 수 있다(다른 노드의 이탈 줄을 집었거나, 검증 전에 한 번 흔들렸던 기록).
 */
export const SRV_MAX_LEAD_MS = 120_000

export interface DownLike {
  at: number
  source: 'pcs' | 'ssh' | 'pre'
  srvAt?: number
}
export interface VipLike {
  at: number
  pcmkAt?: number
}

/** DOWN 기준 시각 — 검증 전부터 죽어 있던 노드(pre)는 기준이 없다(null) */
export function downBaseOf(down: DownLike | undefined, t0?: number): { at: number; server: boolean } | null {
  if (!down || down.source === 'pre') return null
  const s = down.srvAt
  if (s != null && s <= down.at && down.at - s <= SRV_MAX_LEAD_MS && (t0 == null || s >= t0)) return { at: s, server: true }
  return { at: down.at, server: false }
}

/** VIP 이동 시각 — pacemaker 가 남긴 새 노드의 start 시각을 같은 원칙으로. DOWN(서버 기록)보다 한참 앞선 start 는 이번 일이 아니다 */
export function vipAtOf(vip: VipLike, down?: DownLike): { at: number; server: boolean } {
  const s = vip.pcmkAt
  const floor = down?.srvAt ?? down?.at ?? 0
  if (s != null && s <= vip.at && vip.at - s <= SRV_MAX_LEAD_MS && s >= floor - SRV_MAX_LEAD_MS) return { at: s, server: true }
  return { at: vip.at, server: false }
}
