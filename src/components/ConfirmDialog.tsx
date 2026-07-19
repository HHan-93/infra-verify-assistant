interface ConfirmDialogProps {
  title: string
  message: string
  confirmLabel?: string
  onConfirm: () => void
  onCancel: () => void
}

/**
 * 네이티브 confirm()은 OS가 그리는 팝업이라 다크 테마와 안 어울리고 스타일링도 불가능 —
 * 삭제 등 위험한 동작 확인에 쓰는 공용 다크 테마 모달.
 */
export default function ConfirmDialog({
  title,
  message,
  confirmLabel = '삭제',
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-sm rounded-lg border border-white/10 bg-panel p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-2 text-sm font-semibold text-gray-100">{title}</div>
        <p className="whitespace-pre-line text-[13px] leading-relaxed text-gray-200">{message}</p>
        <div className="mt-3 flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="rounded-md border border-white/10 bg-panel-light px-3 py-1.5 text-xs text-gray-200 hover:bg-white/10"
          >
            취소
          </button>
          <button
            autoFocus
            onClick={onConfirm}
            className="rounded-md bg-red-600/80 px-3 py-1.5 text-xs text-white hover:bg-red-500"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
