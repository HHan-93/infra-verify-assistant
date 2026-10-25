/**
 * 가용성 검증의 **증적** — 툴이 관측한 시각 말고, 클러스터가 **스스로 남긴 기록**을 읽는 파서들.
 *
 * 상태보드의 마일스톤은 "툴이 몇 초마다 물어봐서 처음 본 시각" 이다. 제출용 증적으로는 그것만으로
 * 부족하다 — 툴 바깥에서 같은 사실을 확인할 근거가 있어야 한다. 그 근거가 셋이다.
 *  - pacemaker : `crm_mon -1 -t` 의 리소스 동작 이력(`last-rc-change`) — VIP·리소스가 새 노드에서 start 된 시각
 *  - k8s       : 파드의 `Ready` 조건 `lastTransitionTime` · 이벤트 — 대체 파드가 서비스 가능해진 시각
 *  - masakari  : engine 로그의 `exits with status: finished` 줄(판정에 쓴 바로 그 줄)
 *
 * 판정은 여기서 하지 않는다. 마일스톤 시각은 지금처럼 툴 관측으로 두고, 이 값들은 **나란히 보여 줄 근거**다.
 * (서버 기록으로 판정을 바꾸면 서버 시계·이력 정리(`pcs resource cleanup`)에 판정이 흔들린다)
 */

// ── pacemaker 리소스 역할 ─────────────────────────────────────

export interface PcsResource {
  /** pacemaker 리소스 이름 (예: int_vip, haproxy) */
  name: string
  /** 리소스 에이전트 (예: `ocf:heartbeat:IPaddr2`, `systemd:haproxy`) */
  agent: string
  /** systemd 리소스면 그 유닛 이름 — 데몬 표의 행과 잇는 열쇠 (`systemd:openstack-exporter` → `openstack-exporter`) */
  unit?: string
  /** 속한 리소스 그룹 이름 */
  group?: string
  /**
   * 이 리소스가 **주(master)로 도는 노드** — 일반 리소스는 Started 노드, promotable 은 Promoted 노드.
   * 비어 있으면 지금 어디서도 확정적으로 돌지 않는다(Stopped · 전환 중 · FAILED).
   */
  owners: string[]
  /** promotable 리소스의 보조(slave) 노드 — 일반 리소스는 비어 있다(나머지 노드는 '대기') */
  standbys: string[]
  /** 원문 상태 단어 (Started / Stopped / FAILED / Starting …) */
  state: string
}
export interface PcsRoles {
  /** pacemaker DC(Designated Controller) 노드 — 클러스터 결정을 내리는 노드 */
  dc: string
  resources: PcsResource[]
}

const BULLET = String.raw`^[ \t]*(?:\*[ \t]*)?`
const NODE_TOKEN = /^[A-Za-z0-9][\w.-]*$/

/**
 * `pcs status` / `crm_mon -1` 출력에서 DC 와 리소스별 실행 노드를 읽는다.
 *
 * 실제 출력(pacemaker 2.1.6, 2026-10-22 contrabass 클러스터) 기준:
 * ```
 *   * Current DC: contrabass03 (3) (version 2.1.6-…) - MIXED-VERSION partition with quorum
 *   * Resource Group: openstack:
 *     * int_vip   (ocf:heartbeat:IPaddr2):         Started contrabass01
 *     * haproxy   (systemd:haproxy):       Started contrabass01
 *   * thanos-compact-timer        (systemd:thanos-compact.timer):  Started contrabass02
 * ```
 * promotable clone(`Promoted: [ a ]` / `Unpromoted: [ b c ]`, 옛 `Masters:`/`Slaves:`)은 이 클러스터에 없어
 * 실제 출력으로 확인하지 못했다 — pacemaker 문서 형식대로 읽되, 노드 이름은 호출부가 **알려진 노드 목록과
 * 교차 검증**한다(`pcs status` 서식 변화로 `[` 를 노드명으로 잡아 가짜 VIP 이동을 찍은 전례).
 */
export function parsePcsRoles(out: string): PcsRoles {
  const dcM = out.match(/Current DC:[ \t]*(\S+)/i)
  const dc = dcM && NODE_TOKEN.test(dcM[1]) && dcM[1].toUpperCase() !== 'NONE' ? dcM[1] : ''
  const resources: PcsResource[] = []
  const lines = out.split('\n')
  let group: string | undefined
  let groupIndent = -1
  let clone: PcsResource | undefined
  let cloneIndent = -1
  const indentOf = (l: string) => l.length - l.replace(/^[ \t*]+/, '').length
  for (const line of lines) {
    if (!line.trim()) continue
    const ind = indentOf(line)
    if (group !== undefined && ind <= groupIndent) group = undefined
    if (clone && ind <= cloneIndent) clone = undefined
    const g = line.match(new RegExp(BULLET + String.raw`Resource Group:[ \t]*([^\s:]+):?`, 'i'))
    if (g) {
      group = g[1]
      groupIndent = ind
      continue
    }
    // Clone Set: galera-clone [galera] (promotable):
    const cs = line.match(new RegExp(BULLET + String.raw`Clone Set:[ \t]*([^\s:]+)(?:[ \t]+\[([^\]]+)\])?([^\n]*)`, 'i'))
    if (cs) {
      clone = { name: cs[2] || cs[1], agent: '', owners: [], standbys: [], state: '', group }
      cloneIndent = ind
      resources.push(clone)
      continue
    }
    if (clone) {
      const role = line.match(new RegExp(BULLET + String.raw`(Promoted|Masters|Unpromoted|Slaves|Started|Stopped)[ \t]*:[ \t]*\[([^\]]*)\]`, 'i'))
      if (role) {
        const nodes = role[2].trim().split(/\s+/).filter((n) => NODE_TOKEN.test(n))
        const r = role[1].toLowerCase()
        if (r === 'promoted' || r === 'masters') {
          clone.owners.push(...nodes)
          clone.state = 'Promoted'
        } else if (r === 'unpromoted' || r === 'slaves') clone.standbys.push(...nodes)
        continue
      }
    }
    // 일반 리소스 한 줄:  name (class:provider:type): State node [(flags)]
    const pr = line.match(new RegExp(BULLET + String.raw`([A-Za-z0-9_.\-]+)[ \t]+\(([^()\s]+)\):[ \t]+([A-Za-z]+)(?:[ \t]+(\S+))?`))
    if (!pr || clone) continue
    const [, name, agent, state, node] = pr
    const started = /^(Started|Promoted|Master)$/i.test(state)
    const owner = started && node && NODE_TOKEN.test(node) ? node : ''
    resources.push({
      name,
      agent,
      unit: agent.toLowerCase().startsWith('systemd:') ? agent.slice('systemd:'.length) : undefined,
      group,
      owners: owner ? [owner] : [],
      standbys: [],
      state,
    })
  }
  // promotable 이 아닌 clone(모든 노드 Started)은 주/보조가 없다 — 역할 표시에서 뺀다
  return { dc, resources: resources.filter((r) => r.agent || r.owners.length || r.standbys.length) }
}

// ── crm_mon -1 -t : 리소스 동작 이력 ──────────────────────────

export interface CrmOp {
  node: string
  resource: string
  /** start / stop / monitor / probe / promote / demote … */
  op: string
  /** 원문 시각 (호스트 로컬 표기, 예: `Wed Oct 14 10:42:56 2026`) */
  raw: string
  rc: number
  rcText: string
}

/**
 * `crm_mon -1 -t` 의 Operations 절을 읽는다(실제 출력 기준):
 * ```
 * Operations:
 *   * Node: contrabass01:
 *     * int_vip: migration-threshold=1000000:
 *       * (11) start: last-rc-change="Wed Oct 14 10:42:56 2026" exec-time="60ms" queue-time="0ms" rc=0 (ok)
 * ```
 */
export function parseCrmOps(out: string): CrmOp[] {
  const ops: CrmOp[] = []
  const at = out.search(/^Operations:/m)
  if (at < 0) return ops
  let node = ''
  let resource = ''
  for (const line of out.slice(at).split('\n')) {
    const n = line.match(new RegExp(BULLET + String.raw`Node:[ \t]*([^\s:]+):?`))
    if (n) {
      node = n[1]
      resource = ''
      continue
    }
    const o = line.match(new RegExp(BULLET + String.raw`\(\d+\)[ \t]+([\w-]+):[^\n]*?last-rc-change="([^"]+)"[^\n]*?rc=(-?\d+)(?:[ \t]+\(([^)]*)\))?`))
    if (o && node && resource) {
      ops.push({ node, resource, op: o[1], raw: o[2], rc: parseInt(o[3], 10), rcText: o[4] ?? '' })
      continue
    }
    // 리소스 머리줄 — unique clone 인스턴스(`foo:0:`)도 받는다. 못 읽은 머리줄이 나오면 이름을 비워,
    // 그 아래 동작을 **앞 리소스(int_vip 등)의 것으로 잘못 붙이지** 않게 한다
    const r = line.match(new RegExp(BULLET + String.raw`([A-Za-z0-9_.\-]+(?::\d+)?):[ \t]*(?:migration-threshold|fail-count|$)`))
    if (r && node) resource = r[1].replace(/:\d+$/, '')
    else if (node && /^[ \t]*\*[ \t]*[^(\s][^\n]*:[ \t]*/.test(line) && !/\(\d+\)/.test(line)) resource = ''
  }
  return ops
}

const MONTHS: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 }
/**
 * `Wed Oct 14 10:42:56 2026` 같은 호스트 로컬 표기를 **이 PC 의 로컬 시각으로 그대로 읽은** epoch ms.
 * 호스트 시간대·시계 차이는 호출부가 delta 로 뺀다(마사카리 로그와 같은 방식).
 */
export function parseCtimeLocal(s: string): number | null {
  const m = s.trim().match(/^(?:\w{3}\s+)?(\w{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/)
  if (!m) return null
  const mon = MONTHS[m[1].toLowerCase()]
  if (mon === undefined) return null
  const t = new Date(+m[6], mon, +m[2], +m[3], +m[4], +m[5]).getTime()
  return Number.isNaN(t) ? null : t
}

// ── k8s : 파드 Ready 시각 ─────────────────────────────────────

export interface PodFact {
  name: string
  node: string
  phase: string
  /** 파드 생성 (= 대체 파드가 만들어진 시각) */
  createdAt: number | null
  /** 컨테이너 중 가장 늦게 시작한 시각 */
  startedAt: number | null
  /** Ready 조건이 지금 값으로 바뀐 시각 — ready 가 true 면 '서비스 가능해진 시각' */
  readyAt: number | null
  ready: boolean
  restarts: number
  deleting: boolean
}

const iso = (v: unknown): number | null => {
  if (typeof v !== 'string' || !v) return null
  const t = Date.parse(v)
  return Number.isNaN(t) ? null : t
}

/** `kubectl get pods -o json` → 파드별 시각. 형식이 다르면 빈 배열(증적이 없을 뿐, 판정과 무관). */
export function podFactsFromJson(json: string): PodFact[] {
  let doc: { items?: unknown[] }
  try {
    doc = JSON.parse(json)
  } catch {
    return []
  }
  const out: PodFact[] = []
  for (const it of Array.isArray(doc.items) ? doc.items : []) {
    const p = it as {
      metadata?: { name?: string; creationTimestamp?: string; deletionTimestamp?: string }
      spec?: { nodeName?: string }
      status?: {
        phase?: string
        conditions?: { type?: string; status?: string; lastTransitionTime?: string }[]
        containerStatuses?: { restartCount?: number; state?: { running?: { startedAt?: string } } }[]
      }
    }
    if (!p.metadata?.name) continue
    const readyCond = (p.status?.conditions ?? []).find((c) => c.type === 'Ready')
    const cs = p.status?.containerStatuses ?? []
    const starts = cs.map((c) => iso(c.state?.running?.startedAt)).filter((t): t is number => t !== null)
    out.push({
      name: p.metadata.name,
      node: p.spec?.nodeName ?? '',
      phase: p.status?.phase ?? '',
      createdAt: iso(p.metadata.creationTimestamp),
      startedAt: starts.length ? Math.max(...starts) : null,
      readyAt: iso(readyCond?.lastTransitionTime),
      ready: readyCond?.status === 'True',
      restarts: cs.reduce((a, c) => a + (c.restartCount ?? 0), 0),
      deleting: !!p.metadata.deletionTimestamp,
    })
  }
  return out
}

// ── 로그 줄 앞머리 시각 ──────────────────────────────────────

/**
 * `2026-10-22T14:20:07+0900 host corosync[…]` (journalctl -o short-iso) · `2026-10-22T15:03:40.123456+0900 mon.a …`
 * (ceph log) · `2026-10-22 14:55:10` (uptime -s) 처럼 **줄 맨 앞**의 시각을 읽는다.
 * 시간대가 붙어 있으면 그대로 절대시각(tz=true), 없으면 PC 로컬로 읽은 값이라 호출부가 호스트 보정값을 뺀다.
 * Date.parse 는 `+0900` 처럼 콜론 없는 오프셋을 받지 않아 `+09:00` 으로 고친다(소수 초는 ms 까지만).
 */
export function parseLogTime(s: string): { ms: number; tz: boolean } | null {
  const m = s.trim().match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(\.\d+)?([+-]\d{2}:?\d{2}|Z)?/)
  if (!m) return null
  const frac = m[3] ? m[3].slice(0, 4) : ''
  let tz = m[4] ?? ''
  if (tz && tz !== 'Z' && !tz.includes(':')) tz = tz.slice(0, 3) + ':' + tz.slice(3)
  const t = Date.parse(`${m[1]}T${m[2]}${frac}${tz}`)
  return Number.isNaN(t) ? null : { ms: t, tz: !!tz }
}

// ── Nova evacuation 기록 ─────────────────────────────────────

export interface EvacMigration {
  id: string
  /** 옮겨진 VM */
  server: string
  src: string
  dest: string
  status: string
  /** 시작(Created At) · 마지막 갱신(Updated At ≒ 완료) — epoch ms */
  createdAt: number
  updatedAt: number
  /** 끝났나(성공·실패 모두) — 아니면 아직 옮기는 중 */
  done: boolean
  failed: boolean
}

/** Nova 의 시각은 시간대 표기 없는 UTC(`2026-08-12T07:54:05.000000`)다 — Z 를 붙여 읽는다 */
const novaUtc = (v: unknown): number | null => {
  if (typeof v !== 'string' || !v) return null
  const m = v.trim().match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/)
  if (!m) return null
  const t = Date.parse(`${m[1]}T${m[2]}${m[3] ? m[3].slice(0, 4) : ''}${m[4] ? (m[4] === 'Z' || m[4].includes(':') ? m[4] : m[4].slice(0, 3) + ':' + m[4].slice(3)) : 'Z'}`)
  return Number.isNaN(t) ? null : t
}

/**
 * `openstack server migration list --type evacuation -f json` → 이 회차(sinceMs 이후 생성)의 VM 별 기록.
 * 실제 표 출력(2026-10-22 con01) 열: Id · UUID · Source Node · Dest Node · Source Compute · Dest Compute · Dest Host ·
 * Status(completed) · Server UUID · Type(evacuation) · Created At · Updated At. JSON 키는 이 열 이름과 같다.
 * 같은 VM 이 여러 번 옮겨졌으면(재시도) 가장 늦게 생성된 레코드를 쓴다.
 * JSON 배열로 읽히지 않으면 **null** — 인증 실패·CLI 오류 문구를 '기록 없음([])' 으로 뭉개지 않는다(조회 실패 ≠ 없음).
 */
export function parseEvacMigrations(json: string, sinceMs: number): EvacMigration[] | null {
  let arr: unknown
  try {
    arr = JSON.parse(json)
  } catch {
    return null
  }
  if (!Array.isArray(arr)) return null
  const byServer = new Map<string, EvacMigration>()
  for (const raw of arr) {
    const r = raw as Record<string, unknown>
    const type = String(r['Type'] ?? r['Migration Type'] ?? 'evacuation').toLowerCase()
    if (type && !type.includes('evacuat')) continue
    const server = String(r['Server UUID'] ?? r['Instance UUID'] ?? '')
    const createdAt = novaUtc(r['Created At'])
    const updatedAt = novaUtc(r['Updated At']) ?? createdAt
    if (!server || createdAt == null || updatedAt == null || createdAt < sinceMs) continue
    const status = String(r['Status'] ?? '').toLowerCase()
    const failed = /error|fail/.test(status)
    const m: EvacMigration = {
      id: String(r['Id'] ?? r['UUID'] ?? ''),
      server,
      src: String(r['Source Compute'] ?? r['Source Node'] ?? ''),
      dest: String(r['Dest Compute'] ?? r['Dest Node'] ?? r['Dest Host'] ?? ''),
      status,
      createdAt,
      updatedAt,
      done: failed || /^(completed|done|finished|confirmed)$/.test(status),
      failed,
    }
    const cur = byServer.get(server)
    if (!cur || cur.createdAt < createdAt) byServer.set(server, m)
  }
  return [...byServer.values()].sort((a, b) => a.createdAt - b.createdAt)
}

// ── k8s 워크로드 Ready 수 ─────────────────────────────────────

export interface ControllerStat {
  kind: 'Deployment' | 'StatefulSet'
  name: string
  /** 원하는 수(spec.replicas, 없으면 1) */
  replicas: number
  /** Ready 수(status.readyReplicas, 없으면 0) */
  ready: number
}

/**
 * `kubectl get deploy,sts -n ns -o json` → 워크로드별 원하는 수·Ready 수. 읽지 못하면 **null**(조회 실패 ≠ 정상).
 * 파드 행만 보면 놓치는 것 — 죽은 노드 위에 멈춘 StatefulSet 파드, 아직 생성되지 않은 레플리카 — 을 이 숫자로 잡는다.
 */
export function parseControllers(json: string): ControllerStat[] | null {
  let doc: { items?: unknown[] }
  try {
    doc = JSON.parse(json)
  } catch {
    return null
  }
  if (!doc || !Array.isArray(doc.items)) return null
  const out: ControllerStat[] = []
  for (const it of doc.items) {
    const x = it as { kind?: string; metadata?: { name?: string }; spec?: { replicas?: number }; status?: { readyReplicas?: number } }
    if ((x.kind !== 'Deployment' && x.kind !== 'StatefulSet') || !x.metadata?.name) continue
    out.push({
      kind: x.kind,
      name: x.metadata.name,
      replicas: typeof x.spec?.replicas === 'number' ? x.spec.replicas : 1,
      ready: typeof x.status?.readyReplicas === 'number' ? x.status.readyReplicas : 0,
    })
  }
  return out
}
