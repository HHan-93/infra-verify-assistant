/**
 * 상태보드 · 이력의 '파드 로그 이상' 목록을 보여 주는 꼴(2026-11-07 사용자 결정) — 저장된 기록 · 판정은 건드리지 않고 표시만 묶는다.
 *
 *  - 같은 문구 합치기: 네임스페이스 · 문구 · 종류가 같은 줄은 한 줄로(×n). 서명(podLogScan)이 조금씩 달라 따로 묶였어도 화면 문구가
 *    같으면 읽는 사람에게는 같은 일이 되풀이된 것으로 보였다(10-30 회차: '+04:10 contrabass-api-admin: 오류' 가 다섯 줄).
 *    펼치면 원래 줄이 그대로 있고 줄마다 [증적] 이 남는다.
 *  - 장애 기준 구간: 장애 시작 전 / 장애 시작 뒤 / 노드 UP 뒤. 증적 목차와 같은 기준(evidenceToc.evGroupOf)이다. 이 회차는 25건이 모두
 *    장애 주입(+06:56) 전에 난 것인데 목록만 봐서는 장애 때문인지 알 수 없었다. 합치기는 **같은 구간 안에서만** 한다 — 장애 전후에 같은
 *    문구가 나면 그 차이가 볼 거리라서.
 */
import { evGroupOf, type EvGroup } from './evidenceToc'

export interface LogIssueLike {
  at: number
  ns: string
  text: string
  level: 'error' | 'warn'
  pods: number
  key: string
  count?: number
  last?: number
}

export interface LogIssueRow<T extends LogIssueLike> {
  /** 합친 줄의 key(펼침 상태용) */
  id: string
  ns: string
  text: string
  level: 'error' | 'warn'
  /** 가장 이른 처음 */
  at: number
  /** 가장 늦은 마지막 */
  last: number | null
  /** 횟수 합(모르는 것만 있으면 null) */
  count: number | null
  /**
   * 파드 수 — 더하지 않고 가장 큰 값. 같은 파드가 여러 서명에 걸쳐 나오므로 더하면 실제보다 많아진다
   */
  pods: number
  /** 장애 기준 구간(장애 시작을 모르면 null) */
  seg: EvGroup | null
  items: T[]
}

export function mergeLogIssues<T extends LogIssueLike>(items: T[], base: number | null, upAt: number | null): LogIssueRow<T>[] {
  const segOf = (at: number): EvGroup | null => (base == null ? null : evGroupOf(at, base, upAt))
  const map = new Map<string, LogIssueRow<T>>()
  for (const x of [...items].sort((a, b) => a.at - b.at)) {
    const seg = segOf(x.at)
    const id = `${seg ?? '-'}\u0000${x.level}\u0000${x.ns}\u0000${x.text}`
    const r = map.get(id)
    if (!r) {
      map.set(id, { id, ns: x.ns, text: x.text, level: x.level, at: x.at, last: x.last ?? null, count: x.count ?? null, pods: x.pods, seg, items: [x] })
      continue
    }
    r.items.push(x)
    if (x.last != null) r.last = r.last == null ? x.last : Math.max(r.last, x.last)
    if (x.count != null) r.count = (r.count ?? 0) + x.count
    r.pods = Math.max(r.pods, x.pods)
  }
  return [...map.values()].sort((a, b) => (a.seg ?? 0) - (b.seg ?? 0) || a.at - b.at)
}

/**
 * 회차당 한도를 넘은 새 오류 종류를 센다 — 같은 종류는 훑을 때마다 다시 세지 않고, 처음 넘친 시각은 가장 이른 것으로.
 * 해시 목록에도 상한(maxKeys)이 있다 — 이것도 이력에 들어가므로. 바뀌었으면 true(저장할 계기).
 */
export function recordDropped(cur: { since: number; keys: string[] } | undefined, hash: string, at: number, maxKeys: number): { next: { since: number; keys: string[] }; changed: boolean } {
  const d = cur ?? { since: at, keys: [] }
  if (d.keys.includes(hash) || d.keys.length >= maxKeys) return { next: d, changed: !cur }
  return { next: { since: Math.min(d.since, at), keys: [...d.keys, hash] }, changed: true }
}
