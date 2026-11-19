/**
 * 검증 전 Valkey(Redis) 클러스터 마스터 배치 점검(2026-11-18 사용자 요청).
 *
 * 파드 분산 점검은 '파드가 노드별로 나뉘었나' 만 본다. valkey-cluster 6개는 노드 3대에 2개씩 늘 나뉘어 있어 '필수 분산' 으로 나오지만,
 * 노드 장애 뒤 페일오버로 **마스터가 한 노드에 몰려** 있으면 그 노드를 내리는 다음 회차에 마스터 여러 개가 한꺼번에 페일오버한다.
 * 현장에서는 maintenance 크론잡(5분마다)이 다시 나누므로, 다음 회차 시작 전에 나뉘었는지만 보면 된다.
 *
 * 읽는 곳: valkey 파드의 /data/nodes.conf — `CLUSTER NODES` 와 같은 형식이고 페일오버로 역할이 바뀌면 바로 다시 쓴다.
 *  - valkey-cli CLUSTER NODES 는 비밀번호가 필요하다(이 환경은 파드 환경변수에도 없어 앱에 비밀번호를 둬야 했다. 레포가 공개라 코드에 못 넣는다).
 *    파일은 비밀번호 없이 읽힌다. 2026-11-18 같은 파드에서 두 출력의 마스터 · 슬롯이 같은 것을 확인했다.
 *  - 그 노드가 본 구성이라 네트워크가 갈라진 동안은 다를 수 있다 — 시작 전(클러스터 정상) 점검이라 쓴다.
 * 대상은 이름을 고정하지 않는다: 설정한 네임스페이스의 StatefulSet 중 컨테이너 이미지에 valkey · redis 가 들어간 것.
 *
 * 판정(나쁜 것이 앞):
 *  - stacked : 슬롯을 가진 마스터 2개 이상이 한 노드에 — 그 노드를 내리면 한꺼번에 페일오버(시작 전 확인 창)
 *  - same    : 마스터와 그 레플리카가 같은 노드 — 그 노드를 내리면 그 슬롯 범위를 받을 곳이 없다(시작 전 확인 창)
 *  - ok      : 둘 다 아님
 *  - error   : 읽지 못함(조회 실패 ≠ 장애 — 시작을 막지 않는다)
 */

export interface ValkeyPod {
  pod: string
  node: string
  ip: string
}

export interface ValkeySet {
  ns: string
  name: string
  /** exec 할 컨테이너(이미지가 valkey · redis 인 것) */
  container: string
  /** Running 이고 지워지는 중이 아닌 파드 */
  pods: ValkeyPod[]
}

export interface ValkeyNode {
  id: string
  /** nodes.conf 의 주소 칸에서 읽은 파드 이름(없으면 IP) */
  pod: string
  ip: string
  role: 'master' | 'replica'
  /** 레플리카의 마스터 id */
  masterId: string | null
  slots: string
  /** fail · fail? 등 상태 깃발(myself · master · slave 를 뺀 나머지) */
  flags: string[]
}

export interface ValkeyMasterRow {
  pod: string
  node: string | null
  slots: string
  flags: string[]
  replicas: { pod: string; node: string | null; flags: string[] }[]
  /** 이 마스터가 몰린 노드에 있다 */
  stacked: boolean
  /** 이 마스터의 레플리카 중 같은 노드에 있는 것이 있다 */
  same: boolean
}

export interface ValkeyCheck {
  ns: string
  name: string
  verdict: 'stacked' | 'same' | 'ok' | 'error'
  /** 읽은 파드 */
  from?: string
  error?: string
  masters: ValkeyMasterRow[]
  /** 마스터 2개 이상이 있는 노드 → 개수 */
  stackedNodes: { node: string; count: number }[]
  /** 노드를 알 수 없는 줄(파드 목록에 없는 이름 · IP) — 판정에 넣지 않는다 */
  unknown: string[]
  /** 같은 네임스페이스에서 이름에 이 StatefulSet 이름이 들어간 크론잡(재배치 배치) */
  cron: { name: string; last: number | null; schedule: string }[]
}

type Json = Record<string, unknown>
const arr = (v: unknown): Json[] => (Array.isArray(v) ? (v as Json[]) : [])
const obj = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {})

/** 쿠버네티스 이름으로 쓸 수 있는 글자만 — 셸 명령에 그대로 넣으므로 다른 글자가 있으면 그 대상은 건너뛴다 */
const K8S_NAME = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/

/**
 * 분산 점검이 이미 받은 컨트롤러 JSON · 파드 줄에서 valkey StatefulSet 을 찾는다.
 * 파드 줄 = `NS NAME NODE PHASE DELETING OWNERKIND OWNER [IP]`(SPREAD_CMD). IP 칸이 없던 출력이면 IP 는 빈칸.
 */
export function findValkeySets(ctrlJson: string, podLines: string, namespaces: string[]): ValkeySet[] {
  let items: Json[]
  try {
    items = arr(obj(JSON.parse(ctrlJson)).items)
  } catch {
    return []
  }
  const want = new Set(namespaces)
  const out: ValkeySet[] = []
  for (const it of items) {
    if (it.kind !== 'StatefulSet') continue
    const meta = obj(it.metadata)
    const ns = String(meta.namespace ?? '')
    const name = String(meta.name ?? '')
    if (!want.has(ns) || !K8S_NAME.test(ns) || !K8S_NAME.test(name)) continue
    const containers = arr(obj(obj(obj(it.spec).template).spec).containers)
    // 메트릭 사이드카(redis_exporter 등)도 이미지에 redis 가 들어가 — 그 컨테이너가 앞에 있으면 거기로 exec 해 nodes.conf 를 못 찾는다(코드 리뷰)
    const c = containers.find((x) => {
      const img = String(x.image ?? '')
      return /valkey|redis/i.test(img) && !/exporter|metrics/i.test(img)
    })
    const container = String(c?.name ?? '')
    if (!c || !K8S_NAME.test(container)) continue
    out.push({ ns, name, container, pods: [] })
  }
  if (!out.length) return out
  for (const l of podLines.split('\n')) {
    const col = l.trim().split(/\s+/)
    if (col.length < 7) continue
    const [ns, pod, node, phase, deleting, ownerKind, owner, ip = ''] = col
    if (phase !== 'Running' || deleting !== '<none>' || node === '<none>' || ownerKind !== 'StatefulSet') continue
    const set = out.find((s) => s.ns === ns && s.name === owner)
    if (set && K8S_NAME.test(pod)) set.pods.push({ pod, node, ip: ip === '<none>' ? '' : ip })
  }
  return out.filter((s) => s.pods.length > 0)
}

/**
 * 읽기 명령 — 서로 다른 노드의 파드를 최대 3개 차례로 시도한다(첫 파드가 죽은 노드에 있으면 exec 가 시간 초과로 끝난다).
 * 데이터 폴더가 /data 가 아닌 차트도 있어 없으면 nodes.conf 를 찾는다. 같은 네임스페이스의 크론잡 목록도 함께 받는다.
 */
export function valkeyCmd(set: ValkeySet): string {
  const tried = new Set<string>()
  const picks: string[] = []
  for (const p of set.pods) {
    if (tried.has(p.node)) continue
    tried.add(p.node)
    picks.push(p.pod)
    if (picks.length >= 3) break
  }
  const read = `sh -c 'cat /data/nodes.conf 2>/dev/null || cat "$(find / -xdev -name nodes.conf 2>/dev/null | head -1)"'`
  return (
    `for p in ${picks.join(' ')}; do o=$(kubectl -n ${set.ns} exec "$p" -c ${set.container} --request-timeout=12s -- ${read} 2>/dev/null) && [ -n "$o" ] && { echo "__QT_FROM__ $p"; echo "$o"; break; }; done; ` +
    `echo '__QT_CJ__'; kubectl -n ${set.ns} get cronjob --no-headers --request-timeout=10s -o custom-columns='N:.metadata.name,L:.status.lastScheduleTime,S:.spec.schedule' 2>/dev/null`
  )
}

/** nodes.conf(또는 CLUSTER NODES) 줄 → 노드 목록. `vars` 줄 · 깨진 줄은 건너뛴다 */
export function parseNodesConf(text: string): ValkeyNode[] {
  const out: ValkeyNode[] = []
  for (const l of text.split('\n')) {
    const c = l.trim().split(/\s+/)
    if (c.length < 8 || c[0] === 'vars' || !/^[0-9a-f]{40}$/.test(c[0])) continue
    const flags = c[2].split(',')
    const role = flags.includes('master') ? 'master' : flags.includes('slave') ? 'replica' : null
    if (!role || flags.includes('noaddr')) continue
    // 주소 = ip:port@cport[,hostname] — hostname 은 '<파드>.<헤드리스 서비스>.<ns>.svc…' 라 첫 조각이 파드 이름
    const [addr, host = ''] = c[1].split(',')
    const ip = addr.replace(/:\d+(@\d+)?$/, '')
    out.push({
      id: c[0],
      pod: host.split('.')[0] || ip,
      ip,
      role,
      masterId: role === 'replica' && c[3] !== '-' ? c[3] : null,
      slots: c.slice(8).join(' '),
      flags: flags.filter((f) => !['myself', 'master', 'slave'].includes(f)),
    })
  }
  return out
}

/** 읽은 출력 → 판정. out 은 valkeyCmd 의 출력 그대로 */
export function judgeValkey(set: ValkeySet, out: string, ok: boolean): ValkeyCheck {
  const [confPart, cjPart = ''] = out.split('__QT_CJ__')
  const from = /__QT_FROM__ (\S+)/.exec(confPart)?.[1]
  const cron = cjPart
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
    .filter((c) => c.length >= 2 && c[0].includes(set.name))
    .map(([name, last, ...sch]) => {
      const t = Date.parse(last)
      return { name, last: Number.isNaN(t) ? null : t, schedule: sch.join(' ') }
    })
  const base = { ns: set.ns, name: set.name, from, masters: [], stackedNodes: [], unknown: [], cron }
  const nodes = from ? parseNodesConf(confPart) : []
  const withSlots = nodes.filter((n) => n.role === 'master' && n.slots)
  if (!ok || !withSlots.length) return { ...base, verdict: 'error', error: from ? 'nodes.conf 에 마스터가 없습니다.' : '파드에서 nodes.conf 를 읽지 못했습니다.' }

  const nodeOf = (n: ValkeyNode): string | null =>
    set.pods.find((p) => p.pod === n.pod)?.node ?? (n.ip ? set.pods.find((p) => p.ip === n.ip)?.node : undefined) ?? null
  const unknown = nodes.filter((n) => !nodeOf(n)).map((n) => n.pod)
  const count = new Map<string, number>()
  for (const m of withSlots) {
    const node = nodeOf(m)
    if (node) count.set(node, (count.get(node) ?? 0) + 1)
  }
  const stackedNodes = [...count.entries()].filter(([, n]) => n > 1).map(([node, n]) => ({ node, count: n }))
  const masters: ValkeyMasterRow[] = withSlots
    .map((m) => {
      const node = nodeOf(m)
      const replicas = nodes.filter((r) => r.role === 'replica' && r.masterId === m.id).map((r) => ({ pod: r.pod, node: nodeOf(r), flags: r.flags }))
      return {
        pod: m.pod,
        node,
        slots: m.slots,
        flags: m.flags,
        replicas,
        stacked: !!node && (count.get(node) ?? 0) > 1,
        same: !!node && replicas.some((r) => r.node === node),
      }
    })
    // 슬롯 순서(0 부터) — 같은 클러스터를 회차마다 같은 순서로 본다
    .sort((a, b) => (parseInt(a.slots, 10) || 0) - (parseInt(b.slots, 10) || 0))
  const verdict = stackedNodes.length ? 'stacked' : masters.some((m) => m.same) ? 'same' : 'ok'
  return { ...base, verdict, masters, stackedNodes, unknown }
}

/** 시작 전 확인 창을 띄울 판정인가 */
export const valkeyBad = (v: ValkeyCheck) => v.verdict === 'stacked' || v.verdict === 'same'

/** 증적 원문 줄 — 탭으로 나뉜 표 + 한 줄 판정 */
export function valkeyEvidenceLines(v: ValkeyCheck): string[] {
  const head = `Valkey 마스터 배치: ${v.ns}/${v.name}`
  if (v.verdict === 'error') return [head, `확인 못 함. ${v.error ?? ''}`]
  return [
    `${head} (${v.from} 의 nodes.conf)`,
    'MASTER\tNODE\tSLOTS\tREPLICA\tREPLICA NODE\t판정',
    ...v.masters.map(
      (m) =>
        `${m.pod}\t${m.node ?? '?'}\t${m.slots}\t${m.replicas.map((r) => r.pod).join(', ') || '-'}\t${m.replicas.map((r) => r.node ?? '?').join(', ') || '-'}\t${m.stacked ? '마스터 몰림' : m.same ? '같은 노드' : '정상'}`,
    ),
    valkeySummary(v),
  ]
}

/** 한 줄 판정 문장 */
export function valkeySummary(v: ValkeyCheck): string {
  if (v.verdict === 'error') return `확인 못 함. ${v.error ?? ''}`
  const parts: string[] = []
  if (v.stackedNodes.length) parts.push(`마스터 몰림: ${v.stackedNodes.map((s) => `${s.node} 에 ${s.count}개`).join(', ')}`)
  const same = v.masters.filter((m) => m.same)
  if (same.length) parts.push(`마스터와 레플리카가 같은 노드 ${same.length}쌍(${same.map((m) => `${m.pod} · ${m.node}`).join(', ')})`)
  return parts.length ? parts.join(' · ') : '마스터 노드마다 1개 · 레플리카는 모두 다른 노드'
}
