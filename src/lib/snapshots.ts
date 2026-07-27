// 출력 스냅샷 — 명령 출력(또는 세션 출력)을 "시점" 단위로 저장해 두고,
// 나중에 같은 대상의 현재 출력과 diff 하여 "작업 전/후" 변화를 확인한다.
// (노드 간 비교 NodeDiff 와 함께, 시점 간 비교를 담당)
//
// 저장소: localStorage 'output_snapshots' (최근순, 최대 50건).

export interface OutputSnapshot {
  id: string
  label: string
  ts: number // epoch ms
  lines: string[]
}

const KEY = 'output_snapshots'
const MAX = 50

let _seq = 0
function genId(ts: number): string {
  _seq = (_seq + 1) % 100000
  return `snap-${ts}-${_seq}`
}

export function getSnapshots(): OutputSnapshot[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

function save(list: OutputSnapshot[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX)))
  } catch {
    /* 용량 초과 무시 */
  }
  window.dispatchEvent(new Event('snapshots-changed'))
}

/** 출력 스냅샷 1건 저장 (최근이 맨 앞). 반환값은 저장된 스냅샷. */
export function saveSnapshot(label: string, lines: string[]): OutputSnapshot {
  const ts = Date.now()
  const snap: OutputSnapshot = { id: genId(ts), label: label.trim() || '스냅샷', ts, lines }
  save([snap, ...getSnapshots()])
  return snap
}

export function deleteSnapshot(id: string): void {
  save(getSnapshots().filter((s) => s.id !== id))
}

export function clearSnapshots(): void {
  save([])
}
