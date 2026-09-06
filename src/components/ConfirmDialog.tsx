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
    // 배경(어두운 영역)을 눌러도 닫지 않는다 — 이 앱의 모든 모달이 같은 규칙이다.
    // 설정 관리 창처럼 불러온 내용·입력하던 값이 있는 창이 손이 스친 클릭 한 번에 닫혀
    // 처음부터 다시 하게 되는 일이 잦았다. 닫는 것은 X · 닫기 · 취소 버튼으로만.
    //
    // **확인 창은 늘 맨 앞이어야 한다(z-[70]).** 이 앱에는 창 위에 뜨는 창이 있다(z-[60]) —
    // 성능 검증의 회차 창에서 삭제를 누르면 확인 창이 z-50 이라 그 뒤에 깔려, 누른 사람에게는
    // 아무 일도 안 일어난 것처럼 보였다. 무엇을 지울지 묻는 창이 가려지는 것은 그 자체로 위험하다.
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-6">
      <div
        className="w-full max-w-sm rounded-lg border border-white/10 bg-panel p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-2 text-sm font-semibold text-gray-100">{title}</div>
        {/* break-words 가 없으면 공백 없는 긴 경로가 상자를 뚫고 나간다 (삭제 확인이 경로를 보여준다) */}
        <p className="whitespace-pre-line break-words text-[13px] leading-relaxed text-gray-200">{message}</p>
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
