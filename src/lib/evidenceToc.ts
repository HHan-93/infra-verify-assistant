/**
 * 증적 원문 리포트의 목차 — 증적을 '노드 DOWN 이전 · 노드 DOWN 이후 · 노드 UP 이후' 로 묶고 사건 시각 순으로 늘어놓는다.
 *
 * 2026-11-07 사용자 결정(목업 확인). 증적 원문 파일은 머리 카드 → 타임라인 → 증적 14개가 한 줄로 이어지고 증적 하나가
 * 수백 줄이라(Ceph 두 개만 600줄) 원하는 구간을 찾으려면 계속 내려야 했다. 왼쪽에 고정 목차를 두고 누르면 그 증적으로 간다.
 *
 * 묶음은 **증적 제목이 아니라 시각**으로 가른다 — 장애 시작 전 / 장애 시작부터 노드 복귀 전 / 노드 복귀부터.
 * 그래서 회차 중간에 누른 [분산 점검] 도 누른 때에 맞는 묶음에 들어간다(장애 중이면 DOWN 이후, 노드가 돌아온 뒤면 UP 이후).
 * 처음 목업은 '장애 직후 · 복구 이정표 · 노드 복귀 이후' 였는데, Masakari 를 따로 떼면 같은 장애 구간이 둘로 갈려 DOWN 이후에 넣었고,
 * 검증 전 분산 상태는 비교의 기준선이라 장애 뒤 기록과 섞지 않게 DOWN 이전으로 뺐다.
 */
import type { BoardEvidenceItem } from '../../electron/shared-types'

/** 같은 순간의 Ceph 데이터 복구 + HEALTH_OK 를 합친 증적의 key */
export const CEPH_MERGED_KEY = 'ceph+cephHealthy'

/**
 * Ceph 데이터 복구(`ceph`)와 HEALTH_OK(`cephHealthy`)가 **같은 순간**이면 증적 하나로 합친다(2026-11-07 사용자 결정).
 *
 * 둘은 다른 상태다 — 복제가 끝나도 clock skew 같은 경고가 남으면 HEALTH_OK 는 한참 뒤에 온다. 그래서 판정 · 리포트 숫자는 그대로
 * 두 개이고, 여기서는 **증적 표시만** 합친다. 같은 순간이면 1초 간격으로 같은 `ceph log last 1000` 을 두 번 떠서 원문 약 300줄이
 * 거의 그대로 두 번 들어갔다(10-28 1회차: 두 근거 줄이 같은 11:10:34). 타임라인 요약이 이미 한 줄로 묶는 기준(sameMs)과 같다.
 *
 * 합치지 않는 경우: 시각이 다르다(갈라졌다는 것 자체가 봐야 할 정보) · 다른 서버에서 떴다 · 근거 줄이 한쪽에 없다 ·
 * 나중 원문에 앞 근거 줄이 없다(로그가 밀려 사라짐). 이때 합치면 근거 줄 하나를 잃는다.
 * 합친 것은 나중에 뜬 HEALTH_OK 원문을 쓰고, 두 근거 줄을 모두 진하게 칠한다(focus 앞 두 개).
 */
export function mergeSameCeph(items: BoardEvidenceItem[], cephAt: number | null, healthyAt: number | null, sameMs: number): BoardEvidenceItem[] {
  if (cephAt == null || healthyAt == null || Math.abs(healthyAt - cephAt) > sameMs) return items
  const a = items.find((x) => x.key === 'ceph')
  const b = items.find((x) => x.key === 'cephHealthy')
  const fa = a?.focus?.[0]
  const fb = b?.focus?.[0]
  if (!a || !b || !fa || !fb || a.host !== b.host || !b.text.includes(fa)) return items
  const focus = [fa, fb, ...(a.focus ?? []).slice(1), ...(b.focus ?? []).slice(1)].filter((f, i, arr) => f && arr.indexOf(f) === i)
  const facts = [...(a.facts ?? []), ...(b.facts ?? []).filter((f) => !(a.facts ?? []).some((x) => x.label === f.label && x.at === f.at && x.text === f.text))]
  const merged: BoardEvidenceItem = {
    ...b,
    key: CEPH_MERGED_KEY,
    title: 'Ceph 데이터 복구 · HEALTH_OK: 클러스터 로그',
    verifyCmd: 'ceph log last 1000 | grep -iE "health check cleared|now healthy"',
    focus,
    facts,
  }
  const out: BoardEvidenceItem[] = []
  for (const x of items) {
    if (x === a) out.push(merged)
    else if (x !== b) out.push(x)
  }
  return out
}

/** 진하게 칠할 근거 줄 수 — 합친 Ceph 증적만 둘(데이터 복구 · HEALTH_OK) */
export const strongFocusCount = (it: BoardEvidenceItem): number => (it.key === CEPH_MERGED_KEY ? 2 : 1)

/** 타임라인 줄의 증적 key → 리포트에 실제로 있는 증적 key(합쳐졌으면 합친 것) */
export function resolveEvKey(ev: string, keys: Set<string>): string | null {
  if (keys.has(ev)) return ev
  if ((ev === 'ceph' || ev === 'cephHealthy') && keys.has(CEPH_MERGED_KEY)) return CEPH_MERGED_KEY
  return null
}

export const EV_GROUP_LABEL = ['노드 DOWN 이전', '노드 DOWN 이후', '노드 UP 이후'] as const
export type EvGroup = 0 | 1 | 2

/**
 * 장애 시작보다 이만큼 안쪽으로 앞선 것은 장애의 결과로 본다. 장애 시작이 DOWN 감지(저널 첫 줄)면 VIP 이동 · 포털 첫 끊김이
 * 서버 시계 반올림으로 1초 앞서 찍혔고(10-30 회차), 그대로 가르면 장애 결과가 'DOWN 이전' 에 들어갔다.
 */
export const EV_BEFORE_SLACK_MS = 15_000

/** 사건 시각으로 묶음을 가른다. upAt 이 없으면(노드가 아직 안 돌아옴) UP 이후 묶음은 없다 */
export function evGroupOf(at: number, base: number, upAt: number | null): EvGroup {
  if (at < base - EV_BEFORE_SLACK_MS) return 0
  if (upAt != null && at >= upAt) return 2
  return 1
}

export interface ArrangedEv {
  it: BoardEvidenceItem
  /** 사건 시각(타임라인 시각) — 없으면 떠 온 시각 */
  at: number
  grp: EvGroup
}

/**
 * 증적을 사건 시각 순으로 늘어놓고 묶음을 붙인다. 저장 순서는 '떠 온 순서' 라 파드처럼 한꺼번에 뜬 것은 타임라인과 순서가 달랐다.
 * 같은 시각이면 저장 순서를 지킨다(정렬이 안정적).
 */
export function arrangeEvidence(items: BoardEvidenceItem[], eventAt: (it: BoardEvidenceItem) => number | null, base: number, upAt: number | null): ArrangedEv[] {
  return items
    .map((it, i) => ({ it, i, at: eventAt(it) ?? it.capturedAt }))
    .sort((x, y) => x.at - y.at || x.i - y.i)
    // 검증 전 분산 점검은 시각과 상관없이 DOWN 이전 — 장애 주입 시각을 BMC 시계로 넣은 회차(10-28 2회차)는 주입이
    // 검증 시작보다 57초 앞서 찍혀, 시각으로만 가르면 '검증 전' 이 DOWN 이후에 들어갔다
    .map(({ it, at }) => ({ it, at, grp: it.key === 'spread' ? 0 : evGroupOf(at, base, upAt) }))
}

export interface TocEntry {
  at: number
  grp: EvGroup
  /** 가리키는 증적 key */
  key: string
  /** 포털 증적 안의 자리 — 최초 끊김(맨 위) · 1차 정상화 · 다시 끊김 · 최종 정상화 */
  part: '' | 'firstAll' | 'flap' | 'final'
  label: string
  tone: '' | 'kd' | 'kr' | 'dim'
  portal?: boolean
  /** 접은 묶음(파드 로그 이상)의 항목들 */
  fold?: TocEntry[]
}

/**
 * 목차 줄 — 리포트 · 툴 증적 창이 같이 쓴다(2026-11-07 사용자 결정).
 *  - 포털 증적은 하나지만 목차에는 시각마다 나눠 넣는다: 최초 끊김 · 1차 정상화 · 다시 끊김 n회 · 최종 정상화. 각자 그 시각의 묶음에 든다
 *    ('포털 응답 기록' 한 줄로는 1차 정상화가 어디 있는지 알 수 없었다)
 *  - 파드 로그 이상은 **묶음마다** 한 줄('파드 로그 이상 n건')로 접는다 — 10-30 회차는 25개라 목차가 그것으로 덮였다. 그 묶음의 맨 처음 것의
 *    시각에 둔다. 처음엔 전체를 한 줄로 접어 첫 건의 시각(장애 전)에 뒀더니 장애 뒤에 난 것까지 'DOWN 이전' 아래로 읽혔다(코드 점검 11-07)
 *  - 다시 끊김 횟수는 리포트 요약과 같은 셈(1차 정상화 뒤 · 같은 순간 끊긴 화면은 한 번, portalEvidence flapTimes)
 */
export function tocEntries(
  arr: ArrangedEv[],
  base: number,
  upAt: number | null,
  opts: { masaDone: boolean; portal: (it: BoardEvidenceItem) => { first?: { at: number }; firstAll?: { at: number }; flaps: { at: number }[]; flapTimes: number; final?: { at: number }; screens: number | null } },
): TocEntry[] {
  const out: TocEntry[] = []
  const logs: TocEntry[][] = [[], [], []]
  const g = (at: number) => evGroupOf(at, base, upAt)
  for (const x of arr) {
    const it = x.it
    if (it.key === 'portal') {
      const v = opts.portal(it)
      const n = v.screens != null ? ` (${v.screens}/${v.screens} 화면)` : ''
      const subs: TocEntry[] = []
      const add = (at: number, part: TocEntry['part'], label: string, kr = false) => {
        const grp = g(at)
        subs.push({ at, grp, key: it.key, part, label, tone: kr ? 'kr' : grp === 2 ? 'dim' : '', portal: true })
      }
      if (v.first) add(v.first.at, '', '포털 최초 끊김')
      if (v.firstAll) add(v.firstAll.at, 'firstAll', `포털 1차 정상화${n}`, true)
      const after = v.flaps.find((f) => !v.firstAll || f.at > v.firstAll.at)
      if (v.flapTimes && after) add(after.at, 'flap', `포털 다시 끊김 ${v.flapTimes}회`)
      if (v.final) add(v.final.at, 'final', `포털 최종 정상화${n}`)
      if (!subs.length) add(x.at, '', '포털 응답 기록')
      out.push(...subs)
      continue
    }
    const tone: TocEntry['tone'] = it.key === 'down' ? 'kd' : it.key === 'masakari' && opts.masaDone ? 'kr' : x.grp === 2 ? 'dim' : ''
    const e: TocEntry = { at: x.at, grp: x.grp, key: it.key, part: '', label: tocLabel(it, x.grp), tone }
    if (it.key.startsWith('podlog:')) logs[x.grp].push({ ...e, label: podLogLabel(it) })
    else out.push(e)
  }
  for (const ls of logs) {
    if (ls.length === 1) out.push(ls[0])
    else if (ls.length > 1) out.push({ ...ls[0], label: `파드 로그 이상 ${ls.length}건`, tone: '', fold: ls })
  }
  return out.map((e, i) => ({ e, i })).sort((a, b) => a.e.at - b.e.at || a.i - b.i).map(({ e }) => e)
}

/** 파드 로그 이상 증적의 짧은 이름 — '<ns> 파드 로그: <요지>' → '<ns> · <요지>' */
export const podLogLabel = (it: BoardEvidenceItem): string => it.title.replace(/^(\S+) 파드 로그: /, '$1 · ')

/**
 * 목차에 적을 짧은 이름 — 본문 제목은 그대로 두고 목차만 줄인다. 시각은 목차 앞칸에 있으므로 제목 끝의 시각은 빼고,
 * 이름이 같은 [분산 점검] 증적끼리는 언제 뜬 것인지 꼬리로 가른다(검증 전 것은 제목이 이미 '검증 전').
 */
export function tocLabel(it: BoardEvidenceItem, grp: EvGroup): string {
  if (it.key.startsWith('spread:')) return `파드 분산 상태 (${grp === 2 ? '노드 UP 뒤' : grp === 1 ? '장애 중' : '장애 전'})`
  return it.title.replace(/:\s*클러스터 (로그|기록)$/, '')
}
