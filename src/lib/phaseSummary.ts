/**
 * 그룹 리포트 '차수별 요약' 의 이슈 · 원인 · 조치(팀) · 결과 표(2026-11-16 사용자 결정 · 목업 phase-c-mock 시안 C).
 * 예전에는 차수마다 한 칸에 '이슈' 목록과 '팀별 조치' 목록을 따로 늘어놓아, 어느 조치가 어느 이슈를 해결했는지 읽을 수 없었다(사용자 지적).
 * 조치마다 관련 이슈(issueIds)를 고르게 하고, 이 파일이 그것으로 표의 줄을 짠다. 화면(React)과 떨어진 순수 함수라 tests 에서 확인한다.
 *
 * 줄 짜는 규칙(사용자 확인):
 *  - 같은 이슈 묶음에 같은 팀이 한 조치는 한 칸으로 합친다 — 팀 라벨 한 번, 조치는 글머리표로. 따로 적었어도 같이 한 조치다(1회차 4번 사례)
 *  - 조치 하나가 이슈 여럿을 해결했고 그 이슈들에 다른 조치가 없으면, 이슈를 붙여 놓고 원인 · 조치 · 결과 칸을 합친다
 *  - 이슈 하나에 다른 팀 조치가 여럿이면 이슈 칸을 합치고 조치를 줄마다 나눈다
 *  - 위 둘로 못 짜는 얽힌 경우는 조치를 이슈 줄마다 다시 싣는다(번호 표시 없이 — 표로 나뉘어 있어 충분하다는 사용자 판단)
 *  - 관련 이슈를 고르지 않은 조치는 차수 마지막 '공통 조치' 줄로
 *  - NO 는 표 위에서 아래로 1 부터 이어서(차수를 넘어 이어짐 — 사용자 요청). 그래서 묶음 때문에 뒤의 이슈가 앞으로 당겨지면 번호도 보이는 순서를 따른다
 */

export type ActResult = 'done' | 'ok' | 'repro' | 'wip' | 'none'

export interface SumIssue {
  id: string
  text: string
}
export interface SumAction {
  id: string
  team: string
  text: string
  /** 원인 — 조치마다 적는다(이슈 설명과 따로). 비면 '-' */
  cause?: string
  /** 이 조치가 해결한 이슈 id. 비거나 없으면 공통 조치 */
  issueIds?: string[]
  result?: ActResult
}

/** 조치 칸 한 덩어리 — 같은 팀 · 같은 이슈 묶음의 조치를 합친 것 */
export interface ActGroup {
  team: string
  issueIds: string[]
  /** 글머리표 하나 = 조치 한 줄, subs = 그 아래 '-' 줄 */
  items: ActItem[]
  /** 서로 다른 원인만 — 두 조치에 다른 원인이 적혔으면 둘 다 싣는다 */
  causes: string[]
  /** 덜 끝난 쪽(RESULT_RANK). 모두 표시 안 함이면 none */
  result: ActResult
}
export interface ActItem {
  text: string
  subs: string[]
}

/** 한 이슈 칸 — 첫 줄이 제목, 나머지가 설명(앞의 '-' 는 떼고 다시 붙여 그린다) */
export interface IssueView {
  id: string
  title: string
  lines: string[]
}

/**
 * 표의 한 덩어리.
 *  - kind 'issues': 이슈 여럿(같은 조치로 묶임) + 조치 칸 하나(rowspan = 이슈 수). acts 가 비면 조치 없는 이슈 하나
 *  - kind 'acts'  : 이슈 하나 + 조치 여럿(이슈 칸 rowspan = 조치 수)
 *  - kind 'common': 관련 이슈 없는 조치들(이슈 칸 '공통 조치')
 */
export type SumBlock =
  | { kind: 'issues'; issues: IssueView[]; act: ActGroup | null }
  | { kind: 'acts'; issue: IssueView; acts: ActGroup[] }
  | { kind: 'common'; acts: ActGroup[] }

/**
 * 결과를 합칠 때 '덜 끝난 쪽' 순서 — 하나라도 재현됨이면 재현됨, 그다음 확인 중(사용자 확인: 하나라도 확인 중이면 확인 중).
 * 표시 안 함(none)은 다른 값이 있으면 무시한다(밝히지 않은 것을 '끝났다' 로 읽히게 하지 않으려고 맨 뒤).
 */
const RESULT_RANK: ActResult[] = ['repro', 'wip', 'done', 'ok', 'none']
export function mergeResult(rs: (ActResult | undefined)[]): ActResult {
  const have = new Set(rs.map((r) => r ?? 'none'))
  return RESULT_RANK.find((r) => have.has(r)) ?? 'none'
}

/**
 * 조치 글 → 글머리표 목록. '-' 로 시작하는 줄은 바로 위 조치의 세부, 그 밖의 줄은 새 조치(사용자 요청: 조치는 •, 아래는 -).
 * 첫 줄부터 '-' 면 빈 제목 조치에 세부만 붙지 않게 그 줄을 조치로 올린다. 줄 앞뒤 공백 · 빈 줄은 버린다
 */
export function actionItems(text: string): ActItem[] {
  const out: ActItem[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const sub = /^[-–·]\s*/.exec(line)
    if (sub && out.length) out[out.length - 1].subs.push(line.slice(sub[0].length))
    else out.push({ text: sub ? line.slice(sub[0].length) : line, subs: [] })
  }
  return out
}

export function issueView(x: SumIssue): IssueView {
  const ls = x.text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  return { id: x.id, title: (ls[0] ?? '').replace(/^[-–·]\s*/, ''), lines: ls.slice(1).map((l) => l.replace(/^[-–·]\s*/, '')) }
}

/** 팀 이름 비교용 — 'Expert 팀' 과 'Expert팀' 을 같은 팀으로 */
const teamKey = (t: string) => t.replace(/\s+/g, '').toLowerCase()

/**
 * 같은 팀 · 같은 관련 이슈 묶음끼리 합친다. 순서는 처음 나온 조치 자리. 지워진 이슈를 가리키는 id 는 버린다(남은 것이 없으면 공통)
 */
export function mergeActions(actions: SumAction[], issueIds: string[]): ActGroup[] {
  const known = new Set(issueIds)
  const groups = new Map<string, ActGroup & { results: (ActResult | undefined)[] }>()
  for (const a of actions) {
    const items = actionItems(a.text)
    if (!items.length) continue
    const ids = [...new Set((a.issueIds ?? []).filter((id) => known.has(id)))].sort((p, q) => issueIds.indexOf(p) - issueIds.indexOf(q))
    const team = a.team.trim() || '담당 팀'
    const key = `${teamKey(team)}\n${ids.join(',')}`
    let g = groups.get(key)
    if (!g) {
      g = { team, issueIds: ids, items: [], causes: [], result: 'none', results: [] }
      groups.set(key, g)
    }
    g.items.push(...items)
    const c = (a.cause ?? '').trim()
    if (c && !g.causes.includes(c)) g.causes.push(c)
    g.results.push(a.result)
  }
  return [...groups.values()].map(({ results, ...g }) => ({ ...g, result: mergeResult(results) }))
}

/**
 * 차수 하나의 표 덩어리를 짠다(파일 머리 규칙). 이슈는 적은 순서대로 훑고, 조치 하나로 묶인 이슈만 앞의 자리로 당겨 붙인다
 */
export function layoutPhase(issues: SumIssue[], actions: SumAction[]): SumBlock[] {
  const iss = issues.filter((x) => x.text.trim())
  const ids = iss.map((x) => x.id)
  const groups = mergeActions(actions, ids)
  const byIssue = new Map(ids.map((id) => [id, groups.filter((g) => g.issueIds.includes(id))]))
  const view = new Map(iss.map((x) => [x.id, issueView(x)]))
  const placed = new Set<string>()
  const out: SumBlock[] = []
  for (const id of ids) {
    if (placed.has(id)) continue
    const gs = byIssue.get(id) ?? []
    const g = gs[0]
    // 조치 하나가 이슈 여럿을 해결했고, 그 이슈들 모두 그 조치 하나만 가졌을 때만 이슈를 붙여 칸을 합친다
    if (gs.length === 1 && g.issueIds.length > 1 && g.issueIds.every((x) => !placed.has(x) && (byIssue.get(x) ?? []).length === 1)) {
      for (const x of g.issueIds) placed.add(x)
      out.push({ kind: 'issues', issues: g.issueIds.map((x) => view.get(x)!), act: g })
      continue
    }
    placed.add(id)
    if (gs.length <= 1) out.push({ kind: 'issues', issues: [view.get(id)!], act: g ?? null })
    else out.push({ kind: 'acts', issue: view.get(id)!, acts: gs })
  }
  const common = groups.filter((g) => !g.issueIds.length)
  if (common.length) out.push({ kind: 'common', acts: common })
  return out
}

/** 덩어리가 차지하는 줄 수 — 차수 칸 rowspan */
export const blockRows = (b: SumBlock) => (b.kind === 'issues' ? Math.max(1, b.issues.length) : b.acts.length)
