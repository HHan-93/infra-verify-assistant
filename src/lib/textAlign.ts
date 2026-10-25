/**
 * 탭으로 나눈 표 줄을 고정폭 글꼴에서 열이 맞도록 공백으로 채운다(증적 원문 표시용 — 저장 원문은 탭 그대로).
 *
 * 탭은 8칸 단위로 끊기므로 파드 이름처럼 길이가 들쭉날쭉한 열이 오면 줄마다 다음 열의 시작이 어긋났다.
 * 탭이 든 줄이 **연달아 있는 구간**을 한 표로 보고 그 구간 안에서 열 너비를 잰다. 한글은 고정폭 글꼴에서
 * 두 칸을 차지하므로 너비를 2 로 센다(그러지 않으면 'READY(전환)' 같은 머리글 뒤가 밀린다).
 */
export function displayWidth(s: string): number {
  let w = 0
  for (const ch of s) w += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1
  return w
}

export function alignTabBlocks(lines: string[], gap = 2): string[] {
  const out = [...lines]
  let i = 0
  while (i < lines.length) {
    if (!lines[i].includes('\t')) {
      i++
      continue
    }
    let j = i
    while (j < lines.length && lines[j].includes('\t')) j++
    const rows = lines.slice(i, j).map((l) => l.split('\t'))
    const widths: number[] = []
    for (const r of rows) r.forEach((c, k) => (widths[k] = Math.max(widths[k] ?? 0, displayWidth(c))))
    rows.forEach((r, k) => {
      out[i + k] = r
        .map((c, ci) => (ci === r.length - 1 ? c : c + ' '.repeat(widths[ci] - displayWidth(c) + gap)))
        .join('')
    })
    i = j
  }
  return out
}
