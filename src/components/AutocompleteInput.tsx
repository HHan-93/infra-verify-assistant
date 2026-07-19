import { useEffect, useRef, useState } from 'react'
import { Plus } from 'lucide-react'

interface AutocompleteInputProps {
  value: string
  onChange: (v: string) => void
  options: string[]
  placeholder?: string
  className: string
  /** 새 값 추가 시 표시할 안내 문구의 대상 (예: "카테고리", "하위분류") */
  newLabel?: string
}

/**
 * 자유 입력 + 기존 값 자동완성 드롭다운.
 * 네이티브 <input list><datalist> 은 OS/브라우저가 그리는 팝업이라 다크 테마에서
 * 흰 배경으로 튀어 CSS 로 손댈 수 없음 — 직접 그리는 드롭다운으로 대체.
 *
 * 값을 입력하지 않았거나(포커스 직후 기본값 그대로) 이미 있는 항목과 정확히 같으면
 * 전체 목록을 보여준다 — 그렇지 않으면 "지금 있는 항목 중 이 글자를 포함하는 것"만
 * 남아 대부분 안 보이는 것처럼 느껴짐(기본값이 채워진 채로 열 때 특히).
 * 목록에 없는 값을 입력 중이면 "새로 추가" 안내를 보여줘 새 카테고리/하위분류를
 * 만들 수 있다는 걸 명확히 드러낸다.
 */
export default function AutocompleteInput({
  value,
  onChange,
  options,
  placeholder,
  className,
  newLabel = '항목',
}: AutocompleteInputProps) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const trimmed = value.trim()
  const exactMatch = options.some((o) => o === value)
  const matches =
    !trimmed || exactMatch
      ? options
      : options.filter((o) => o.toLowerCase().includes(trimmed.toLowerCase()))
  const showCreateHint = trimmed && !options.some((o) => o.toLowerCase() === trimmed.toLowerCase())

  useEffect(() => {
    const onDocMouseDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocMouseDown)
    return () => document.removeEventListener('mousedown', onDocMouseDown)
  }, [])

  return (
    <div ref={wrapRef} className="relative">
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={(e) => {
          setOpen(true)
          e.target.select()
        }}
        placeholder={placeholder}
        className={className}
      />
      {open && (matches.length > 0 || showCreateHint) && (
        <div className="absolute z-10 mt-1 max-h-48 w-full overflow-y-auto rounded-md border border-white/10 bg-panel-light shadow-lg">
          {showCreateHint && (
            <div className="flex items-center gap-1.5 border-b border-white/10 px-2.5 py-1.5 text-[11px] text-emerald-400">
              <Plus size={12} />
              &quot;{trimmed}&quot;(을)를 새 {newLabel}(으)로 추가
            </div>
          )}
          {matches.map((o) => (
            <button
              key={o}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onChange(o)
                setOpen(false)
              }}
              className={
                'block w-full truncate px-2.5 py-1.5 text-left text-[12px] hover:bg-white/10 ' +
                (o === value ? 'bg-blue-600/20 text-blue-100' : 'text-gray-200')
              }
            >
              {o}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
