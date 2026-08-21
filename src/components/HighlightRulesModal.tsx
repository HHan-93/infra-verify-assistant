import { useEffect, useState } from 'react'
import { Highlighter, X, Plus, Trash2 } from 'lucide-react'
import {
  getRules,
  addRule,
  updateRule,
  deleteRule,
  RULE_COLOR_CLASS,
  RULE_COLOR_SWATCH,
  type HighlightRule,
  type RuleColor,
} from '../lib/highlightRules'

const COLORS: RuleColor[] = ['red', 'amber', 'emerald', 'sky', 'violet', 'pink']

/**
 * 로그 하이라이트 규칙 관리 — 사용자가 원하는 키워드에 색을 지정해,
 * 실시간/녹화 로그 뷰어에서 내장 심각도 키워드와 함께 강조되게 한다.
 */
export default function HighlightRulesModal({ onClose }: { onClose: () => void }) {
  const [rules, setRules] = useState<HighlightRule[]>(() => getRules())
  const [term, setTerm] = useState('')
  const [color, setColor] = useState<RuleColor>('sky')

  useEffect(() => {
    const refresh = () => setRules(getRules())
    window.addEventListener('highlight-rules-changed', refresh)
    return () => window.removeEventListener('highlight-rules-changed', refresh)
  }, [])

  const add = () => {
    if (!term.trim()) return
    addRule(term, color)
    setTerm('')
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-8">
      <div
        className="flex max-h-[80vh] w-[560px] max-w-[94vw] flex-col overflow-hidden rounded-lg border border-white/10 bg-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-white/10 px-4 py-2.5">
          <Highlighter size={16} className="text-blue-400" />
          <span className="text-sm font-semibold text-gray-100">로그 하이라이트 규칙</span>
          <span className="text-[11px] text-gray-500">{rules.length}개</span>
          <button
            onClick={onClose}
            className="ml-auto rounded p-1 text-gray-400 hover:bg-white/10 hover:text-gray-200"
          >
            <X size={16} />
          </button>
        </div>

        {/* 추가 폼 */}
        <div className="flex items-center gap-2 border-b border-white/10 px-4 py-2">
          <input
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') add()
            }}
            placeholder="강조할 키워드 (예: OSD, tenant-A, reboot)"
            className="min-w-0 flex-1 rounded-md border border-white/10 bg-panel-light px-2.5 py-1.5 text-sm text-gray-100 placeholder:text-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
          <div className="flex shrink-0 items-center gap-1">
            {COLORS.map((c) => (
              <button
                key={c}
                onClick={() => setColor(c)}
                title={c}
                className={
                  'h-5 w-5 rounded-full ' +
                  RULE_COLOR_SWATCH[c] +
                  (color === c ? ' ring-2 ring-white/70' : ' opacity-60 hover:opacity-100')
                }
              />
            ))}
          </div>
          <button
            onClick={add}
            disabled={!term.trim()}
            className="flex shrink-0 items-center gap-1 rounded-md bg-blue-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50"
          >
            <Plus size={14} /> 추가
          </button>
        </div>

        {/* 규칙 목록 */}
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {rules.length === 0 ? (
            <div className="px-2 py-8 text-center text-xs text-gray-500">
              규칙이 없습니다. 위에서 키워드와 색을 골라 추가하세요.
              <br />
              추가한 키워드는 실시간·녹화 로그에서 지정한 색으로 강조됩니다.
            </div>
          ) : (
            <ul className="space-y-1">
              {rules.map((r) => (
                <li
                  key={r.id}
                  className="flex items-center gap-2 rounded-md border border-white/10 bg-panel-light px-2.5 py-1.5"
                >
                  <input
                    type="checkbox"
                    checked={r.enabled}
                    onChange={(e) => updateRule(r.id, { enabled: e.target.checked })}
                    title={r.enabled ? '사용 중' : '사용 안 함'}
                  />
                  <span className={'flex-1 truncate font-mono text-sm ' + (r.enabled ? RULE_COLOR_CLASS[r.color] : 'text-gray-500 line-through')}>
                    {r.term}
                  </span>
                  <div className="flex shrink-0 items-center gap-1">
                    {COLORS.map((c) => (
                      <button
                        key={c}
                        onClick={() => updateRule(r.id, { color: c })}
                        title={c}
                        className={
                          'h-4 w-4 rounded-full ' +
                          RULE_COLOR_SWATCH[c] +
                          (r.color === c ? ' ring-2 ring-white/70' : ' opacity-50 hover:opacity-100')
                        }
                      />
                    ))}
                  </div>
                  <button
                    onClick={() => deleteRule(r.id)}
                    title="삭제"
                    className="shrink-0 rounded p-1 text-gray-500 hover:bg-red-500/15 hover:text-red-300"
                  >
                    <Trash2 size={13} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="border-t border-white/10 px-4 py-1.5 text-[10px] text-gray-500">
          내장 심각도 키워드(error/warning/success…)가 항상 우선하고, 사용자 규칙은 그 외 단어에 적용됩니다 · 단어 단위·대소문자 무시
        </div>
      </div>
    </div>
  )
}
