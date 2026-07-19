/**
 * 내장(고정) 항목과 사용자 정의(이동 가능) 항목을 하나의 순서로 병합해 다루기 위한 헬퍼.
 * 내장 항목은 배열 인덱스(정수)를 암묵적 order 로 쓰고, 사용자 정의 항목은 그 사이 어디든
 * 끼워 넣을 수 있도록 소수 order 값을 가진다 — 두 이웃의 중간값을 잡는 "fractional indexing".
 * 이렇게 하면 다른 카테고리로 옮기거나 내장 항목들 사이에 끼워 넣는 것도 그냥 order 값
 * 하나만 계산해서 저장하면 되고, 전체 배열을 다시 쓸 필요가 없다.
 */
export interface Orderable {
  order: number
}

/** idx 에 있는 항목을 dir 방향으로 한 칸 넘기기 위한 새 order 값. 이동 불가면 null */
export function computeMoveOrder(merged: Orderable[], idx: number, dir: -1 | 1): number | null {
  const targetIdx = idx + dir
  if (targetIdx < 0 || targetIdx >= merged.length) return null
  const beyondIdx = targetIdx + dir
  const beyond = merged[beyondIdx]?.order
  const target = merged[targetIdx].order
  return beyond === undefined ? target + dir : (target + beyond) / 2
}

/** merged(정렬된 목록)의 beforeIdx 위치 "바로 앞"에 끼워 넣기 위한 order 값 (드래그앤드롭 드롭용) */
export function computeInsertBeforeOrder(merged: Orderable[], beforeIdx: number): number {
  const next = merged[beforeIdx]?.order
  const prev = merged[beforeIdx - 1]?.order
  if (next === undefined && prev === undefined) return 0
  if (next === undefined) return prev! + 1
  if (prev === undefined) return next - 1
  return (prev + next) / 2
}

/** merged 목록 맨 끝에 끼워 넣기 위한 order 값 (예: 다른 카테고리 헤더에 드롭) */
export function computeAppendOrder(merged: Orderable[]): number {
  const last = merged[merged.length - 1]?.order
  return last === undefined ? 0 : last + 1
}
