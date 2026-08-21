import { useRef, useState } from 'react'
import { MoreHorizontal, Download, Upload, Loader2 } from 'lucide-react'
import type { CustomItemsImportResult } from '../../electron/shared-types'

/**
 * 사용자 정의 프리셋·시나리오 내보내기 / 가져오기 메뉴.
 *
 * 프리셋 패널과 시나리오 패널 **양쪽에 같은 것이 필요해서** 컴포넌트로 뽑았다.
 * 내보내기·가져오기는 두 목록을 한 파일로 함께 다루므로(파일 하나에 presets·scenarios)
 * 어느 패널에서 눌러도 결과가 같다 — 패널마다 다르게 만들 이유가 없다.
 *
 * 버튼을 두 개(내보내기·가져오기) 나란히 두지 않고 메뉴로 접은 이유:
 * 검색칸이 있는 그 줄은 이미 빽빽해서, 버튼이 늘면 정작 검색칸이 좁아진다.
 */
export default function CustomItemsMenu({ onImported }: { onImported: () => void }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  /** 내보내기 결과는 한 줄로 충분하고, 가져오기 결과는 건수·건너뛴 이유가 있어 모달로 보여준다 */
  const [note, setNote] = useState('')
  const [result, setResult] = useState<CustomItemsImportResult | null>(null)

  const btnRef = useRef<HTMLButtonElement>(null)
  /**
   * 메뉴 위치를 버튼 좌표로 계산해 `position: fixed` 로 띄운다.
   *
   * absolute 로 두면 안 된다 — 이 패널을 감싼 영역에 `overflow-hidden` 이 걸려 있어(App.tsx
   * 의 패널 높이 래퍼), 패널을 낮게 줄여 놓으면 메뉴가 잘려서 아예 안 보인다.
   */
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null)
  const toggle = () => {
    if (open) {
      setOpen(false)
      return
    }
    const r = btnRef.current?.getBoundingClientRect()
    if (r) setPos({ top: r.bottom + 4, right: Math.max(4, window.innerWidth - r.right) })
    setOpen(true)
  }

  const doExport = async () => {
    setOpen(false)
    setBusy(true)
    const r = await window.electronAPI.customItemsExport()
    setBusy(false)
    if (r.error) setNote(r.error)
    else if (r.saved) setNote(`내보냈습니다 — 프리셋 ${r.presets ?? 0}개 · 시나리오 ${r.scenarios ?? 0}개`)
    // 취소는 아무 말도 하지 않는다 (사용자가 스스로 닫은 것이다)
  }

  const doImport = async () => {
    setOpen(false)
    setBusy(true)
    const r = await window.electronAPI.customItemsImport()
    setBusy(false)
    if (r.canceled) return
    setResult(r)
    // 실패해도 목록을 다시 읽는다 — 프리셋은 들어갔는데 시나리오에서 실패한 경우가 있다
    onImported()
  }

  return (
    <>
      <button
        ref={btnRef}
        onClick={toggle}
        disabled={busy}
        title="내보내기 · 가져오기"
        className="shrink-0 rounded px-1 py-0.5 text-gray-500 hover:bg-white/10 hover:text-gray-300 disabled:opacity-40"
      >
        {busy ? <Loader2 size={13} className="animate-spin" /> : <MoreHorizontal size={14} />}
      </button>

      {open && pos && (
        <>
          {/* 바깥을 누르면 닫힌다 — 메뉴만 위에 둔다 */}
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            style={{ top: pos.top, right: pos.right }}
            className="fixed z-50 w-[200px] overflow-hidden rounded-md border border-white/10 bg-panel shadow-xl"
          >
            <button
              onClick={doExport}
              className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12px] text-gray-200 hover:bg-white/10"
            >
              <Download size={12} className="shrink-0 text-gray-400" />
              내보내기 (JSON)
            </button>
            <button
              onClick={doImport}
              className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12px] text-gray-200 hover:bg-white/10"
            >
              <Upload size={12} className="shrink-0 text-gray-400" />
              가져오기 (병합)
            </button>
            <p className="border-t border-white/10 px-2.5 py-1.5 text-[10.5px] leading-relaxed text-gray-500">
              프리셋·시나리오를 한 파일로 다룹니다. 가져오기는 기존 항목을 지우지 않습니다.
            </p>
          </div>
        </>
      )}

      {/* 내보내기 알림 */}
      {note && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-6"
        >
          <div
            className="w-full max-w-sm rounded-lg border border-white/10 bg-panel p-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="text-[13px] leading-relaxed text-gray-200">{note}</p>
            <p className="mt-2 text-[11px] leading-relaxed text-amber-300/80">
              명령어에 비밀번호가 들어 있으면 그대로 저장됩니다 — 파일 취급에 주의하세요.
            </p>
            <div className="mt-3 flex justify-end">
              <button
                autoFocus
                onClick={() => setNote('')}
                className="rounded bg-blue-600/80 px-3 py-1.5 text-xs text-white hover:bg-blue-500"
              >
                확인
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 가져오기 결과 — 세션 프로필 가져오기 결과창과 같은 형식 */}
      {result && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-6"
        >
          <div
            className="w-full max-w-md rounded-lg border border-white/10 bg-panel p-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 text-sm font-semibold text-gray-100">가져오기 결과</div>
            {result.ok ? (
              <>
                <p className="text-[13px] leading-relaxed text-gray-300">
                  프리셋 <span className="font-semibold text-emerald-400">{result.addedPresets}</span>개 · 시나리오{' '}
                  <span className="font-semibold text-emerald-400">{result.addedScenarios}</span>개 추가 · 덮어씀{' '}
                  <span className="font-semibold text-blue-300">{result.replaced}</span>건 · 건너뜀{' '}
                  <span className="font-semibold text-amber-400">{result.skipped}</span>건
                </p>
                {result.replaced > 0 && (
                  <p className="mt-1.5 text-[11px] leading-relaxed text-gray-500">
                    같은 항목(id)이 이미 있어 최신 내용으로 덮어썼습니다. 목록에서의 위치는 그대로 둡니다.
                  </p>
                )}
                {result.warnings.length > 0 && (
                  <div className="mt-2 max-h-40 space-y-1 overflow-y-auto rounded border border-white/10 bg-black/20 p-2">
                    {result.warnings.map((w, i) => (
                      <p key={i} className="text-[11px] leading-relaxed text-gray-400">
                        {w}
                      </p>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <p className="text-[13px] leading-relaxed text-red-300">{result.error ?? '가져오기에 실패했습니다.'}</p>
            )}
            <div className="mt-3 flex justify-end">
              <button
                autoFocus
                onClick={() => setResult(null)}
                className="rounded bg-blue-600/80 px-3 py-1.5 text-xs text-white hover:bg-blue-500"
              >
                확인
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
