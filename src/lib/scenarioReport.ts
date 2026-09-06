import type { ScenarioRunCounts, ScenarioRunDetail, ScenarioRunStep } from '../../electron/shared-types'

/**
 * 시나리오 검증 **묶음 리포트** — 고른 회차 여러 개를 한 문서로.
 *
 * 왜 필요한가: 한 회차만 보면 "실패 2건" 이 전부다. 세 회차를 나란히 놓으면 **같은 스텝이
 * 계속 실패하는지**(고쳐지지 않은 것) 아니면 **그때만 그랬는지**(재현되지 않는 것)가 갈린다.
 * 지금까지는 그걸 보려고 저장해 둔 리포트 파일 세 개를 사람이 눈으로 맞춰 봤다.
 *
 * 규칙:
 *  · **회차 상세는 그때 만든 리포트 원문(reportMd)을 그대로 이어 붙인다.** 다시 조립하면
 *    그 자리에서 복사해 본 것과 나중에 뽑은 것이 달라진다. 마스킹도 그때 이미 적용됐다.
 *  · 앞장에 붙이는 것은 **요약 표와 스텝 격자** 둘뿐이다. 판정을 여기서 새로 만들지 않는다 —
 *    이 파일은 보관된 판정을 배치할 뿐이고, 판정은 러너가 그때 내린 것이 정본이다.
 *  · HTML 은 외부 자원을 쓰지 않는다(오프라인·첨부 전달). 인쇄를 생각해 밝은 배경이다.
 */

/** 판정 표기 — 화면(EFFECTIVE_META)과 같은 말을 쓴다. 리포트만 다른 낱말을 쓰면 대조가 안 된다 */
const LABEL: Record<ScenarioRunStep['effective'], string> = {
  pass: '정상',
  fail: '실패',
  info: '실행됨',
  skip: '건너뜀',
  'manual-wait': '수동 확인',
  pending: '미실행',
  error: '실행 오류',
}

/** 격자에서 눈에 걸려야 하는 판정 — 실패·실행오류만 색을 준다 */
const BAD: ScenarioRunStep['effective'][] = ['fail', 'error']

const two = (n: number) => String(n).padStart(2, '0')
/** 회차 이름에 쓰는 시각 — 같은 날 여러 회차가 있으므로 분까지 */
export function runStamp(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`
}

/** 걸린 시간 — '4분 12초' */
export function durText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(s / 60)
  return m > 0 ? `${m}분 ${two(s % 60)}초` : `${s}초`
}

export function countsText(c: ScenarioRunCounts): string {
  const parts: [string, number][] = [
    ['정상', c.pass],
    ['실패', c.fail],
    ['실행오류', c.error],
    ['실행됨', c.info],
    ['건너뜀', c.skip],
    ['수동대기', c.waiting],
    ['미실행', c.pending],
  ]
  // 0 인 항목은 적지 않는다 — 일곱 개를 늘어놓으면 실패 건수가 그 안에 묻힌다
  const shown = parts.filter(([, n]) => n > 0)
  return shown.length ? shown.map(([k, n]) => `${k} ${n}`).join(' · ') : '결과 없음'
}

/**
 * 스텝 격자 — 행이 스텝, 열이 회차.
 *
 * 회차마다 시나리오가 편집돼 스텝 수가 다를 수 있다. 그래서 **번호가 아니라 제목**으로 맞춘다
 * (번호로 맞추면 스텝 하나를 중간에 끼워 넣은 순간 그 뒤 전부가 엉뚱한 짝이 된다). 제목이
 * 같은 것이 없으면 그 회차 칸은 비운다.
 */
export function stepGrid(runs: ScenarioRunDetail[]): { title: string; cells: (ScenarioRunStep | null)[] }[] {
  const order: string[] = []
  const seen = new Set<string>()
  // 가장 최근 회차의 순서를 기준으로 삼는다 — 지금 쓰는 시나리오의 모양이다
  for (const r of [...runs].sort((a, b) => b.startedAt - a.startedAt)) {
    for (const st of r.steps) {
      if (seen.has(st.title)) continue
      seen.add(st.title)
      order.push(st.title)
    }
  }
  return order.map((title) => ({
    title,
    cells: runs.map((r) => r.steps.find((st) => st.title === title) ?? null),
  }))
}

/** 회차를 시간순(오래된 것 → 최근)으로. 추이는 왼쪽에서 오른쪽으로 읽는 것이 자연스럽다 */
function chrono(runs: ScenarioRunDetail[]): ScenarioRunDetail[] {
  return [...runs].sort((a, b) => a.startedAt - b.startedAt)
}

/** 고른 회차가 모두 같은 시나리오인가 — 아니면 격자를 그리지 않는다(제목이 겹칠 이유가 없다) */
export function sameScenario(runs: ScenarioRunDetail[]): boolean {
  return runs.length > 0 && runs.every((r) => r.scenarioId === runs[0].scenarioId)
}

// ── Markdown ────────────────────────────────────────────────────

export function buildBundleMd(input: ScenarioRunDetail[], now = Date.now()): string {
  const runs = chrono(input)
  if (!runs.length) return '# 시나리오 검증 묶음 리포트\n\n고른 회차가 없습니다.'
  const one = sameScenario(runs)
  const L: string[] = []

  L.push(`# 시나리오 검증 묶음 리포트${one ? `: ${runs[runs.length - 1].title}` : ''}`)
  L.push('')
  L.push(`- 회차 ${runs.length}개 (${runs.map((r) => runStamp(r.startedAt)).join(' · ')})`)
  const targets = [...new Set(runs.flatMap((r) => r.targets))]
  if (targets.length) L.push(`- 대상: ${targets.join(' · ')}`)
  L.push(`- 뽑은 시각: ${runStamp(now)}`)
  if (runs.some((r) => r.stopped)) {
    L.push(
      `- ⚠ 중단된 회차가 있습니다 — ${runs
        .filter((r) => r.stopped)
        .map((r) => `${runStamp(r.startedAt)}(${r.stoppedAt ? `${r.stoppedAt}번에서` : '중단'})`)
        .join(' · ')}. 그 뒤 스텝은 **미실행**이며 정상도 실패도 아닙니다.`,
    )
  }
  if (runs.some((r) => r.compatShell)) {
    L.push('- ⚠ 일부 회차는 호환 모드(exec)로 실행됐습니다 — cd 유지·대화형 응답·타임아웃 중단이 제한됩니다.')
  }
  L.push('')

  L.push('## 회차별 요약')
  L.push('')
  L.push('| 회차 | 시나리오 | 정상 | 실패 | 실행오류 | 수동대기 | 건너뜀 | 미실행 | 소요 |')
  L.push('|---|---|---|---|---|---|---|---|---|')
  for (const r of runs) {
    L.push(
      `| ${runStamp(r.startedAt)}${r.stopped ? ' (중단)' : ''} | ${r.title} | ${r.counts.pass} | ${r.counts.fail} | ` +
        `${r.counts.error} | ${r.counts.waiting} | ${r.counts.skip} | ${r.counts.pending} | ` +
        `${durText(r.endedAt - r.startedAt)} |`,
    )
  }
  L.push('')

  if (one && runs.length > 1) {
    const grid = stepGrid(runs)
    L.push('## 스텝별 추이')
    L.push('')
    L.push(`| 스텝 | ${runs.map((r) => runStamp(r.startedAt).slice(5)).join(' | ')} | |`)
    L.push(`|---|${runs.map(() => '---').join('|')}|---|`)
    for (const row of grid) {
      // 계속 실패한 스텝은 표 안에서 바로 보이게 표시한다 — 이 리포트의 핵심 정보다
      const bads = row.cells.filter((c) => c && BAD.includes(c.effective)).length
      const mark = bads === runs.length ? ' ← 계속 실패' : bads > 0 ? '' : ''
      L.push(
        `| ${row.title} | ` +
          row.cells.map((c) => (c ? LABEL[c.effective] + (c.manual ? '(수동)' : '') : '—')).join(' | ') +
          ` |${mark} |`,
      )
    }
    L.push('')
    const always = grid.filter((row) => row.cells.every((c) => c && BAD.includes(c.effective)))
    if (always.length) {
      L.push(`> 모든 회차에서 실패한 스텝: ${always.map((r) => r.title).join(' · ')}`)
      L.push('')
    }
  }

  L.push('## 회차 상세')
  L.push('')
  for (const r of runs) {
    L.push(`### ${runStamp(r.startedAt)} — ${r.title}`)
    L.push('')
    /**
     * 그때 만든 리포트를 그대로 붙인다. 제목 단계만 **세 칸 내린다** —
     * 회차 제목이 `###` 이므로 원문의 `#`(리포트 제목)가 `####`, `##`(스텝)가 `#####` 가 되어
     * 이 문서의 목차 안에 제대로 들어간다. 한 칸만 내리면 원문 제목이 '회차별 요약' 과 같은
     * 단계가 되어, 목차에서 회차 상세가 최상위 절로 튀어나온다.
     */
    L.push(r.reportMd.replace(/^(#{1,3}) /gm, '###$1 ').trim())
    L.push('')
  }
  return L.join('\n')
}

// ── HTML (제출용 한 장) ─────────────────────────────────────────

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** 판정 한 칸 — 색은 실패 계열에만 준다 */
function cell(c: ScenarioRunStep | null): string {
  if (!c) return '<td class="none">—</td>'
  const cls = BAD.includes(c.effective)
    ? 'bad'
    : c.effective === 'pass'
      ? 'good'
      : c.effective === 'manual-wait' || c.effective === 'pending'
        ? 'wait'
        : ''
  return `<td class="${cls}">${LABEL[c.effective]}${c.manual ? '<sup>수동</sup>' : ''}</td>`
}

export function buildBundleHtml(input: ScenarioRunDetail[], now = Date.now()): string {
  const runs = chrono(input)
  const one = sameScenario(runs)
  const title = `시나리오 검증 묶음 리포트${one && runs.length ? ` — ${runs[runs.length - 1].title}` : ''}`
  const targets = [...new Set(runs.flatMap((r) => r.targets))]
  const grid = one && runs.length > 1 ? stepGrid(runs) : []
  const always = grid.filter((row) => row.cells.every((c) => c && BAD.includes(c.effective)))

  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<title>${esc(title)}</title>
<style>
  /* 외부 자원을 쓰지 않는다 — 메일로 첨부하거나 망 밖에서 열어도 그대로 보여야 한다.
     인쇄를 생각해 밝은 배경이다(앱은 어둡지만 이 문서는 제출물이다). */
  body { font: 13px/1.7 "Malgun Gothic", "맑은 고딕", system-ui, sans-serif; color:#1f2430; background:#fff;
         margin:0; padding:28px 32px; max-width:1100px }
  h1 { font-size:19px; margin:0 0 4px }
  h2 { font-size:15px; margin:26px 0 8px; padding-bottom:4px; border-bottom:1px solid #e3e6ec }
  h3 { font-size:13.5px; margin:18px 0 6px; color:#333b4a }
  .meta { color:#5b6577; font-size:11.5px; line-height:1.9 }
  .warn { margin:10px 0; padding:8px 11px; border-left:3px solid #d97706; background:#fffbeb; font-size:12px }
  .lede { margin:10px 0 0; padding:8px 11px; border-left:3px solid #dc2626; background:#fef2f2; font-size:12px }
  table { border-collapse:collapse; width:100%; margin:8px 0 4px; font-size:12px }
  th, td { border:1px solid #e3e6ec; padding:4px 8px; text-align:left }
  th { background:#f6f7f9; color:#4b5563; font-weight:600; white-space:nowrap }
  td.num { text-align:right }
  td.bad { background:#fef2f2; color:#b91c1c; font-weight:600 }
  td.good { color:#047857 }
  td.wait { color:#0369a1 }
  td.none { color:#9aa3b2 }
  sup { font-size:9px; color:#6b7280; margin-left:2px }
  pre { background:#f7f8fa; border:1px solid #e3e6ec; border-radius:5px; padding:10px 12px;
        font:11.5px/1.6 Consolas, monospace; white-space:pre-wrap; word-break:break-all; overflow-x:auto }
  .foot { margin-top:26px; padding-top:8px; border-top:1px solid #e3e6ec; color:#8b93a1; font-size:11px }
</style></head><body>
<h1>${esc(title)}</h1>
<div class="meta">
  회차 ${runs.length}개${runs.length ? ` · ${esc(runStamp(runs[0].startedAt))} ~ ${esc(runStamp(runs[runs.length - 1].startedAt))}` : ''}<br>
  ${targets.length ? `대상 ${esc(targets.join(' · '))}<br>` : ''}
  뽑은 시각 ${esc(runStamp(now))}
</div>
${
  runs.some((r) => r.stopped)
    ? `<div class="warn"><b>중단된 회차가 있습니다</b> — ${runs
        .filter((r) => r.stopped)
        .map((r) => esc(runStamp(r.startedAt)) + (r.stoppedAt ? ` (${r.stoppedAt}번에서)` : ''))
        .join(' · ')}. 그 뒤 스텝은 <b>미실행</b>이며 정상도 실패도 아닙니다.</div>`
    : ''
}
${
  runs.some((r) => r.compatShell)
    ? '<div class="warn">일부 회차는 <b>호환 모드(exec)</b>로 실행됐습니다 — cd 유지·대화형 응답·타임아웃 중단이 제한됩니다.</div>'
    : ''
}
${
  always.length
    ? `<div class="lede"><b>모든 회차에서 실패한 스텝</b> — ${always.map((r) => esc(r.title)).join(' · ')}<br>
       회차를 거듭해도 같은 곳에서 실패한다는 뜻입니다. 여기서부터 보십시오.</div>`
    : ''
}

<h2>회차별 요약</h2>
<table>
  <tr><th>회차</th><th>시나리오</th><th>정상</th><th>실패</th><th>실행오류</th><th>수동대기</th><th>건너뜀</th><th>미실행</th><th>소요</th></tr>
  ${runs
    .map(
      (r) => `<tr>
    <td>${esc(runStamp(r.startedAt))}${r.stopped ? ' <sup>중단</sup>' : ''}</td>
    <td>${esc(r.title)}</td>
    <td class="num">${r.counts.pass}</td>
    <td class="num${r.counts.fail ? ' bad' : ''}">${r.counts.fail}</td>
    <td class="num${r.counts.error ? ' bad' : ''}">${r.counts.error}</td>
    <td class="num">${r.counts.waiting}</td>
    <td class="num">${r.counts.skip}</td>
    <td class="num">${r.counts.pending}</td>
    <td>${esc(durText(r.endedAt - r.startedAt))}</td>
  </tr>`,
    )
    .join('')}
</table>

${
  grid.length
    ? `<h2>스텝별 추이</h2>
<table>
  <tr><th>스텝</th>${runs.map((r) => `<th>${esc(runStamp(r.startedAt).slice(5))}</th>`).join('')}</tr>
  ${grid.map((row) => `<tr><td>${esc(row.title)}</td>${row.cells.map(cell).join('')}</tr>`).join('')}
</table>
<div class="meta">칸이 <b>—</b> 인 것은 그 회차에 없던 스텝입니다(시나리오를 고친 뒤 돌렸을 때).</div>`
    : ''
}

<h2>회차 상세</h2>
${runs
  .map(
    (r) => `<h3>${esc(runStamp(r.startedAt))} — ${esc(r.title)} <span class="meta">(${esc(countsText(r.counts))})</span></h3>
<pre>${esc(r.reportMd.trim())}</pre>`,
  )
  .join('')}

<div class="foot">Q-Term 시나리오 검증 이력에서 뽑았습니다. 회차 상세는 그때 만든 리포트 원문이며, 비밀번호·토큰은 저장 시점에 가려졌습니다.</div>
</body></html>`
}
