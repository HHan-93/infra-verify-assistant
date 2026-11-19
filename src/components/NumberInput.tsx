import { useEffect, useState } from 'react'

/**
 * 숫자 칸 — 치는 동안은 글자 그대로 두고, 칸을 떠날 때(Enter · 바깥 클릭) 범위로 맞춰 반영한다. Esc 는 되돌림.
 * 예전엔 칠 때마다 최솟값으로 맞춰 응답 제한 시간 1000 에서 0 을 지우면 곧바로 1000 으로 되돌아가, 끝에 0 을 덧붙이는 것밖에
 * 못 했다(2026-11-09 사용자 지적: 30초 · 60초로 바꾸고 싶었다). 확인 주기 · 연속 성공 횟수도 지우면 1 로 튀었다.
 * 2026-11-16 응답 측정에서도 같은 증상(지워지지 않고 입력이 잘 안 됨 — 사용자 지적)이라 포털 감시에만 있던 것을 공용으로 옮겼다.
 * 칠 때마다 범위로 맞추는 onChange 를 새로 만들지 말고 이것을 쓸 것.
 */
export function NumberInput({
  value,
  min,
  max,
  step,
  onCommit,
  className,
  disabled,
  title,
}: {
  value: number
  min: number
  max?: number
  step?: number
  onCommit: (v: number) => void
  className?: string
  disabled?: boolean
  title?: string
}) {
  const [v, setV] = useState(String(value))
  useEffect(() => setV(String(value)), [value])
  const commit = () => {
    const n = Number(v)
    // step 이 1 이상(정수 칸)이면 여기서 반올림한다 — 부모가 반올림해 값이 그대로면 칸에 2.4 가 남았다(코드 리뷰 11-10)
    const c0 = Number.isFinite(n) && v.trim() !== '' ? Math.min(max ?? Infinity, Math.max(min, n)) : value
    const c = (step ?? 1) >= 1 ? Math.round(c0) : c0
    setV(String(c))
    if (c !== value) onCommit(c)
  }
  return (
    <input
      type="number"
      min={min}
      max={max}
      step={step}
      className={className}
      disabled={disabled}
      title={title}
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        if (e.key === 'Escape') setV(String(value))
      }}
    />
  )
}
