/**
 * 검증 그룹 환경 비교(2026-11-16 사용자 결정 · 목업 env-flex-mock): 차수마다 환경을 따로 적을 수 있게 되면서
 *  - 리포트 창 미리보기 · 리포트 본문에서 '같은 환경인가' 로 차수를 묶고(envSame)
 *  - 그룹 기본 환경과 다른 곳을 '바뀐 점' 으로 자동으로 적는다(envChanges). 사람이 적는 메모(notes)는 비교하지 않는다
 * 화면 컴포넌트의 GroupEnv 와 같은 꼴만 받는다(id 는 비교에서 뺀다 — 복사하면 id 가 새로 생겨도 같은 환경이다).
 */
export interface DiffVm {
  name: string
  count?: number
  real?: string[]
  kind: string
  evac: boolean
}
export interface DiffNode {
  label: string
  host: string
  controller: boolean
  compute: boolean
  vms: DiffVm[]
}
export interface DiffEnv {
  inject: string
  nodes: DiffNode[]
  notes: string[]
}

/** 비교용 꼴 — id 를 빼고 앞뒤 공백을 지운다. 메모도 같이 넣는다(메모만 다른 차수는 리포트에서 따로 실어야 하므로) */
const norm = (e: DiffEnv | undefined) =>
  e
    ? JSON.stringify({
        i: e.inject.trim(),
        t: e.notes.map((x) => x.trim()).filter(Boolean),
        n: e.nodes.map((n) => ({
          l: n.label.trim(),
          h: n.host.trim(),
          c: !!n.controller,
          p: !!n.compute,
          v: n.vms.map((v) => ({ n: v.name.trim(), c: v.count && v.count > 1 ? v.count : 1, r: (v.real ?? []).map((x) => x.trim()).filter(Boolean), k: v.kind, e: !!v.evac })),
        })),
      })
    : ''

/** 두 환경이 리포트에서 같은 그림인가 */
export const envSame = (a: DiffEnv | undefined, b: DiffEnv | undefined) => norm(a) === norm(b)

/**
 * 기준(그룹 기본) 대비 바뀐 점 — 사람이 읽는 짧은 문장 목록. 노드는 표준 이름(노드 1)으로, VM 은 표준 이름으로 맞춘다.
 * 노드 추가 · 없어짐 · 호스트 · 역할 변경, VM 이동 · 추가 · 뺌 · 대수 · 종류 · evacuation 대상 변경, 장애 주입 변경.
 */
export function envChanges(base: DiffEnv | undefined, cur: DiffEnv | undefined): string[] {
  if (!cur) return []
  const out: string[] = []
  const b = base ?? { inject: '', nodes: [], notes: [] }
  if (b.inject.trim() !== cur.inject.trim()) out.push(`장애 주입: ${b.inject.trim() || '없음'} → ${cur.inject.trim() || '없음'}`)
  const role = (n: DiffNode) => [n.controller ? '컨트롤러' : '', n.compute ? '컴퓨트' : ''].filter(Boolean).join(' · ') || '역할 없음'
  for (const n of cur.nodes) {
    const o = b.nodes.find((x) => x.label.trim() === n.label.trim())
    if (!o) {
      out.push(`${n.label.trim()}${n.host.trim() ? `(${n.host.trim()})` : ''} 추가`)
      continue
    }
    if (o.host.trim() !== n.host.trim()) out.push(`${n.label.trim()} 호스트 ${o.host.trim() || '없음'} → ${n.host.trim() || '없음'}`)
    if (role(o) !== role(n)) out.push(`${n.label.trim()} 역할 ${role(o)} → ${role(n)}`)
  }
  for (const o of b.nodes) if (!cur.nodes.some((x) => x.label.trim() === o.label.trim())) out.push(`${o.label.trim()} 없음`)
  // VM — 표준 이름으로 어느 노드에 있었나
  const where = (e: DiffEnv) => {
    const m = new Map<string, { node: string; vm: DiffVm }>()
    for (const n of e.nodes) for (const v of n.vms) if (v.name.trim() && !m.has(v.name.trim())) m.set(v.name.trim(), { node: n.label.trim(), vm: v })
    return m
  }
  const wb = where(b)
  const wc = where(cur)
  const cnt = (v: DiffVm) => (v.count && v.count > 1 ? v.count : 1)
  for (const [name, c] of wc) {
    const o = wb.get(name)
    if (!o) {
      out.push(`${c.node} 에 ${name} 추가`)
      continue
    }
    if (o.node !== c.node) out.push(`${name} 을 ${o.node} → ${c.node} 로`)
    if (cnt(o.vm) !== cnt(c.vm)) out.push(`${name} ${cnt(o.vm)}대 → ${cnt(c.vm)}대`)
    if (o.vm.evac !== c.vm.evac) out.push(`${name} evacuation 대상 ${c.vm.evac ? '추가' : '해제'}`)
    if (o.vm.kind !== c.vm.kind) out.push(`${name} 종류 바뀜`)
  }
  for (const [name, o] of wb) if (!wc.has(name)) out.push(`${o.node} 의 ${name} 뺌`)
  return out
}
