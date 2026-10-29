/**
 * 상태보드 — 네임스페이스 파드 복구를 **언제 확정하는가**.
 *
 * 한 프레임만 보고 찍으면 재생성 중 잠깐 Ready 가 됐다 다시 빠지는 파드에 이른 복구가 찍힌다. 워크로드도 네임스페이스
 * 전체 완료도 **연속 2프레임** 정상이어야 확정하고, 시각은 처음 정상으로 본 프레임이다(Ceph 와 같은 기준).
 * '비정상 워크로드' 는 호출부가 파드 행(노드 NotReady 행 제외)과 컨트롤러 Ready 수를 합쳐 넘긴다.
 */

export const POD_CONFIRM_FRAMES = 2

export interface PodCand {
  /** 비정상이었다가 정상으로 보이기 시작한 워크로드 — 처음 정상으로 본 시각, 연속 프레임 수 */
  workloads: Map<string, { at: number; hits: number }>
  /** 네임스페이스 전체가 비정상 0 으로 보이기 시작한 시각, 연속 프레임 수 */
  done: { at: number; hits: number } | null
  /** 완료로 확정된 뒤 아직 다시 깨지지 않았다 — 이때 비정상이 생기면 '다시 비정상' 후보다 */
  complete?: boolean
  /** 완료 뒤 비정상으로 보이기 시작한 시각, 연속 프레임 수 */
  broken?: { at: number; hits: number } | null
}

export const newPodCand = (): PodCand => ({ workloads: new Map(), done: null, complete: false, broken: null })
export const podCandPending = (c: PodCand | undefined) => !!c && (c.workloads.size > 0 || !!c.done || !!c.broken)

/**
 * 한 프레임 진행. prev = 직전 프레임의 비정상 워크로드(처음 보는 네임스페이스면 undefined), bad = 이번 프레임.
 * 확정된 워크로드 복구와 네임스페이스 완료 시각, 그리고 **완료 뒤 다시 비정상** 이 된 시각을 돌려준다. cand 는 제자리에서 바뀐다.
 *
 * '다시 비정상' 도 들어올 때와 같은 기준 — 연속 2프레임이어야 확정하고 시각은 첫 비정상 프레임이다. 예전에는 완료 뒤에
 * 깨진 것을 아무 데도 남기지 않아, 서비스가 다 내려간 네임스페이스가 끝까지 '완료' 로 보였다(2026-10-26).
 */
export function stepPodRecovery(
  cand: PodCand,
  prev: Set<string> | undefined,
  bad: Set<string>,
  now: number,
): { recovered: { workload: string; at: number }[]; doneAt: number | null; brokenAt: number | null } {
  let brokenAt: number | null = null
  if (cand.complete) {
    if (bad.size > 0) {
      if (!cand.broken) cand.broken = { at: now, hits: 0 }
      cand.broken.hits++
      if (cand.broken.hits >= POD_CONFIRM_FRAMES) {
        brokenAt = cand.broken.at
        cand.broken = null
        cand.complete = false
      }
    } else cand.broken = null
  }
  const recovered: { workload: string; at: number }[] = []
  for (const w of bad) cand.workloads.delete(w) // 다시 깨졌다 — 후보에서 뺀다
  if (prev) for (const w of prev) if (!bad.has(w) && !cand.workloads.has(w)) cand.workloads.set(w, { at: now, hits: 0 })
  for (const [w, v] of cand.workloads) {
    v.hits++
    if (v.hits >= POD_CONFIRM_FRAMES) {
      recovered.push({ workload: w, at: v.at })
      cand.workloads.delete(w)
    }
  }
  let doneAt: number | null = null
  if (bad.size > 0) cand.done = null
  // 완료 상태에서 한 프레임 튄 비정상은 '다시 비정상' 도 아니고 새 완료도 아니다 — 확정된 완료가 그대로 이어진다
  else if (!cand.complete && (cand.done || (prev && prev.size > 0))) {
    if (!cand.done) cand.done = { at: now, hits: 0 }
    cand.done.hits++
    // 워크로드 후보가 남아 있으면(아직 확정 전) 네임스페이스 완료도 미룬다
    if (cand.done.hits >= POD_CONFIRM_FRAMES && cand.workloads.size === 0) {
      doneAt = cand.done.at
      cand.done = null
      cand.complete = true
    }
  }
  return { recovered, doneAt, brokenAt }
}
