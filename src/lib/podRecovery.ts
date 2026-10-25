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
}

export const newPodCand = (): PodCand => ({ workloads: new Map(), done: null })
export const podCandPending = (c: PodCand | undefined) => !!c && (c.workloads.size > 0 || !!c.done)

/**
 * 한 프레임 진행. prev = 직전 프레임의 비정상 워크로드(처음 보는 네임스페이스면 undefined), bad = 이번 프레임.
 * 확정된 워크로드 복구와 네임스페이스 완료 시각을 돌려준다. cand 는 제자리에서 바뀐다.
 */
export function stepPodRecovery(
  cand: PodCand,
  prev: Set<string> | undefined,
  bad: Set<string>,
  now: number,
): { recovered: { workload: string; at: number }[]; doneAt: number | null } {
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
  else if (cand.done || (prev && prev.size > 0)) {
    if (!cand.done) cand.done = { at: now, hits: 0 }
    cand.done.hits++
    // 워크로드 후보가 남아 있으면(아직 확정 전) 네임스페이스 완료도 미룬다
    if (cand.done.hits >= POD_CONFIRM_FRAMES && cand.workloads.size === 0) {
      doneAt = cand.done.at
      cand.done = null
    }
  }
  return { recovered, doneAt }
}
