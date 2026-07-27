// 사용자 정의 하이라이트 규칙 — 기본 심각도 키워드(logDisplay) 위에, 사용자가 원하는
// 키워드에 색을 입힐 수 있게 한다. (lnav/Datadog 의 사용자 하이라이트 벤치마킹)
//
// 저장소: localStorage 'highlight_rules'. renderLogLine 이 매 렌더 시 참조(모듈 캐시).

export type RuleColor = 'red' | 'amber' | 'emerald' | 'sky' | 'violet' | 'pink'

export interface HighlightRule {
  id: string
  term: string // 강조할 문자열(대소문자 무시, 단어 단위 매칭)
  color: RuleColor
  enabled: boolean
}

export const RULE_COLOR_CLASS: Record<RuleColor, string> = {
  red: 'font-semibold text-red-400',
  amber: 'font-semibold text-amber-400',
  emerald: 'font-semibold text-emerald-400',
  sky: 'font-semibold text-sky-400',
  violet: 'font-semibold text-violet-400',
  pink: 'font-semibold text-pink-400',
}
export const RULE_COLOR_SWATCH: Record<RuleColor, string> = {
  red: 'bg-red-400',
  amber: 'bg-amber-400',
  emerald: 'bg-emerald-400',
  sky: 'bg-sky-400',
  violet: 'bg-violet-400',
  pink: 'bg-pink-400',
}

const KEY = 'highlight_rules'
let _seq = 0
function genId(): string {
  _seq = (_seq + 1) % 100000
  return `rule-${Date.now()}-${_seq}`
}

export function getRules(): HighlightRule[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

function save(list: HighlightRule[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list))
  } catch {
    /* 용량 초과 등 — 무시 (규칙은 소량이라 사실상 발생 안 함) */
  }
  window.dispatchEvent(new Event('highlight-rules-changed'))
}

export function addRule(term: string, color: RuleColor): HighlightRule | null {
  const t = term.trim()
  if (!t) return null
  const rule: HighlightRule = { id: genId(), term: t, color, enabled: true }
  save([...getRules(), rule])
  return rule
}
export function updateRule(id: string, patch: Partial<Omit<HighlightRule, 'id'>>): void {
  save(getRules().map((r) => (r.id === id ? { ...r, ...patch } : r)))
}
export function deleteRule(id: string): void {
  save(getRules().filter((r) => r.id !== id))
}
