/**
 * 검증 전 파드 분산 점검 — 노드 하나를 내렸을 때 **워크로드가 통째로 끊기지 않게** 레플리카가 노드별로 나뉘어 있는가.
 *
 * 2026-10-26 epoxy 환경: boot-factory(auth·gateway·host)가 anti-affinity **preferred** + topologySpread ScheduleAnyway 라
 * manager1 장애 때 둘 다 manager2 로 갔고, manager1 이 돌아와도 다시 나뉘지 않아(쿠버네티스는 떠 있는 파드를 옮기지 않는다)
 * 다음 회차에 manager2 를 내리자 포털이 통째로 끊겼다. 이전 환경(master03)은 **required** 라 장애 중 대체 파드가 Pending 으로
 * 기다리다 노드가 돌아오면 거기 떠 자동으로 다시 나뉘었다(사용자: 이게 맞다). 그 차이를 시작 전에 보여 준다.
 *
 * 판정(나쁜 것이 앞):
 *  - stacked : 지금 Running 레플리카가 전부 한 노드에 있다 — 그 노드를 내리면 끊긴다(❌, 시작 전 확인 창)
 *  - none    : 분산 규칙이 없다(⚠)
 *  - soft    : 권장 규칙(preferred · ScheduleAnyway)만 — 장애 뒤 몰리면 descheduler 없이는 그대로 남는다(⚠)
 *  - ok      : 필수 규칙(required anti-affinity · DoNotSchedule)이 있고 지금도 나뉘어 있다(✅)
 *  - single  : 레플리카 1개 — 나눌 것이 없다(회색, 문제 수에 넣지 않는다)
 */

export type SpreadRule = 'required' | 'preferred' | 'none'
export type SpreadVerdict = 'stacked' | 'none' | 'soft' | 'ok' | 'single'

export interface SpreadWorkload {
  ns: string
  kind: 'Deployment' | 'StatefulSet'
  name: string
  replicas: number
  /** anti-affinity(호스트 기준) */
  anti: SpreadRule
  /** topologySpreadConstraints(호스트 기준) — required = DoNotSchedule, preferred = ScheduleAnyway */
  spread: SpreadRule
  /** 지금 Running 인(지워지는 중이 아닌) 파드의 노드별 개수 */
  placement: Record<string, number>
  verdict: SpreadVerdict
}

const HOST_KEY = 'kubernetes.io/hostname'

type Json = Record<string, unknown>
const arr = (v: unknown): Json[] => (Array.isArray(v) ? (v as Json[]) : [])
const obj = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {})

/** 템플릿의 호스트 기준 anti-affinity · topologySpread 규칙 */
export function spreadRules(spec: Json): { anti: SpreadRule; spread: SpreadRule } {
  const pod = obj(obj(obj(spec.template).spec))
  const anti = obj(obj(pod.affinity).podAntiAffinity)
  const req = arr(anti.requiredDuringSchedulingIgnoredDuringExecution).some((t) => t.topologyKey === HOST_KEY)
  const pref = arr(anti.preferredDuringSchedulingIgnoredDuringExecution).some((t) => obj(t.podAffinityTerm).topologyKey === HOST_KEY)
  const tsc = arr(pod.topologySpreadConstraints).filter((t) => t.topologyKey === HOST_KEY)
  return {
    anti: req ? 'required' : pref ? 'preferred' : 'none',
    spread: tsc.some((t) => t.whenUnsatisfiable === 'DoNotSchedule') ? 'required' : tsc.length ? 'preferred' : 'none',
  }
}

/** 규칙 + 지금 배치 → 판정 */
export function spreadVerdict(w: Pick<SpreadWorkload, 'replicas' | 'anti' | 'spread' | 'placement'>): SpreadVerdict {
  if (w.replicas <= 1) return 'single'
  const nodes = Object.entries(w.placement).filter(([, n]) => n > 0)
  const running = nodes.reduce((a, [, n]) => a + n, 0)
  // Running 이 2개 이상인데 노드가 하나뿐 — 규칙과 무관하게 지금 그 노드가 단일 장애점이다
  if (running >= 2 && nodes.length === 1) return 'stacked'
  if (w.anti === 'required' || w.spread === 'required') return 'ok'
  if (w.anti === 'preferred' || w.spread === 'preferred') return 'soft'
  return 'none'
}

/**
 * `kubectl get deploy,sts -A -o json` + 파드 배치 줄(`NS NAME NODE PHASE DELETING OWNERKIND OWNER`, custom-columns) → 워크로드별 판정.
 * 파드 → 워크로드 연결은 ownerReferences 로 한다 — Deployment 파드의 주인은 ReplicaSet(`<deploy>-<hash>`)이라 마지막 조각을 뗀다.
 * 이름 모양으로 추측하지 않는다(같은 접두어의 다른 워크로드를 섞지 않게).
 */
export function parseSpread(ctrlJson: string, podLines: string, namespaces: string[]): SpreadWorkload[] | null {
  let items: Json[]
  try {
    items = arr(obj(JSON.parse(ctrlJson)).items)
  } catch {
    return null
  }
  const want = new Set(namespaces)
  const placement = new Map<string, Record<string, number>>()
  for (const l of podLines.split('\n')) {
    const c = l.trim().split(/\s+/)
    if (c.length < 7) continue
    const [ns, , node, phase, deleting, ownerKind, owner] = c
    if (!want.has(ns) || phase !== 'Running' || deleting !== '<none>' || node === '<none>') continue
    const ctrl = ownerKind === 'ReplicaSet' ? `Deployment/${owner.replace(/-[a-z0-9]{6,10}$/, '')}` : ownerKind === 'StatefulSet' ? `StatefulSet/${owner}` : ''
    if (!ctrl) continue
    const key = `${ns}/${ctrl}`
    const p = placement.get(key) ?? {}
    p[node] = (p[node] ?? 0) + 1
    placement.set(key, p)
  }
  const out: SpreadWorkload[] = []
  for (const it of items) {
    const kind = it.kind === 'StatefulSet' ? 'StatefulSet' : it.kind === 'Deployment' ? 'Deployment' : null
    const meta = obj(it.metadata)
    const ns = String(meta.namespace ?? '')
    if (!kind || !want.has(ns)) continue
    const spec = obj(it.spec)
    const name = String(meta.name ?? '')
    const replicas = typeof spec.replicas === 'number' ? spec.replicas : 1
    const rules = spreadRules(spec)
    const pl = placement.get(`${ns}/${kind}/${name}`) ?? {}
    const w = { ns, kind, name, replicas, ...rules, placement: pl } as Omit<SpreadWorkload, 'verdict'>
    out.push({ ...w, verdict: spreadVerdict(w) })
  }
  const order: Record<SpreadVerdict, number> = { stacked: 0, none: 1, soft: 2, ok: 3, single: 4 }
  return out.sort((a, b) => a.ns.localeCompare(b.ns) || order[a.verdict] - order[b.verdict] || a.name.localeCompare(b.name))
}

/** 점검 명령 — 컨트롤러 JSON · 파드 배치 · descheduler 유무를 구분자로 한 번에 */
export const SPREAD_CMD =
  "kubectl get deploy,sts -A -o json --request-timeout=15s 2>/dev/null; echo '__QT_PODS__'; " +
  "kubectl get pods -A --no-headers --request-timeout=15s -o custom-columns='NS:.metadata.namespace,NAME:.metadata.name,NODE:.spec.nodeName,PHASE:.status.phase,DEL:.metadata.deletionTimestamp,OK:.metadata.ownerReferences[0].kind,OWNER:.metadata.ownerReferences[0].name' 2>/dev/null; " +
  "echo '__QT_DESCHED__'; kubectl get deploy,cronjob -A --no-headers --request-timeout=10s 2>/dev/null | grep -ci descheduler"

export function splitSpreadOutput(out: string): { ctrl: string; pods: string; descheduler: boolean | null } {
  const [ctrl, rest = ''] = out.split('__QT_PODS__')
  const [pods, d = ''] = rest.split('__QT_DESCHED__')
  const n = parseInt(d.trim(), 10)
  return { ctrl: ctrl.trim(), pods, descheduler: Number.isNaN(n) ? null : n > 0 }
}
