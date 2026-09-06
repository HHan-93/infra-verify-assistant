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

/**
 * 회차 하나의 **한 줄 결과.**
 *
 * 개요 표에서 눈으로 훑는 값이라 셋으로만 나눈다. `미완` 을 따로 두는 이유는 이 앱의 규칙
 * 그대로다 — **근거 없이 초록을 띄우지 않는다.** 수동 확인이 남았거나 중단된 회차는 실패는
 * 아니지만 '정상' 도 아니다. 그걸 정상으로 칠하면 아무도 그 회차를 다시 안 본다.
 */
export function runVerdict(r: {
  counts: ScenarioRunCounts
  stopped?: boolean
}): { key: 'fail' | 'incomplete' | 'pass'; label: string } {
  if (r.counts.fail + r.counts.error > 0) return { key: 'fail', label: '실패' }
  if (r.stopped || r.counts.waiting + r.counts.pending > 0) return { key: 'incomplete', label: '미완' }
  return { key: 'pass', label: '정상' }
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

export function buildBundleMd(input: ScenarioRunDetail[], opts: BundleOptions = {}): string {
  const runs = chrono(input)
  const now = opts.now ?? Date.now()
  // 제목은 사람이 정한다 — HTML 과 같은 규칙(안 적으면 시나리오 이름으로 만든다)
  const title = opts.title?.trim() || defaultBundleTitle(runs)
  if (!runs.length) return `# ${title}\n\n고른 회차가 없습니다.`
  const L: string[] = []

  L.push(`# ${title}`)
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

  L.push('## 개요')
  L.push('')
  L.push('| No | 회차 | 시나리오 | 결과 | 정상 | 실패 | 실행오류 | 수동대기 | 건너뜀 | 미실행 | 소요 |')
  L.push('|---|---|---|---|---|---|---|---|---|---|---|')
  runs.forEach((r, i) => {
    L.push(
      `| ${i + 1} | ${runStamp(r.startedAt)}${r.stopped ? ' (중단)' : ''} | ${r.title} | ` +
        `${runVerdict(r).label} | ${r.counts.pass} | ${r.counts.fail} | ` +
        `${r.counts.error} | ${r.counts.waiting} | ${r.counts.skip} | ${r.counts.pending} | ` +
        `${durText(r.endedAt - r.startedAt)} |`,
    )
  })
  L.push('')

  if (sameScenario(runs) && runs.length > 1) {
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

/**
 * 화면 설계의 근거 — 다른 검증 리포트들이 공통으로 하는 것을 따랐다.
 *
 *  · **맨 위에 결론부터** (Lighthouse·Allure). 읽는 사람은 대개 "그래서 됐나?" 하나를
 *    보러 온다. 큰 숫자 넉 장과 한 줄 판정을 먼저 놓고, 근거는 아래에 둔다.
 *  · **한 줄에 색 막대** (Allure·pytest-html). 표에 숫자만 있으면 회차끼리 비교가 눈에
 *    안 들어온다. 스텝 구성을 가로 막대로 그려 두면 "이 회차는 절반이 빨갛다" 가 보인다.
 *  · **색만으로 말하지 않는다.** 판정은 색 + 글자를 함께 쓴다(인쇄·색약·흑백 복사).
 *  · **제목은 사람이 정한다.** 'CONTRABASS V3.0.6 시나리오 수행' 처럼 무엇을 검증한
 *    문서인지는 우리가 지을 수 없다. 안 적으면 시나리오 이름으로 만든다.
 *  · **자바스크립트 없음**(탭·펼치기 모두 CSS). 메일·파일서버·인쇄로 돌아다니는 문서라
 *    스크립트가 막히면 사람은 '리포트가 깨졌다' 로 읽는다.
 */

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** 판정 한 칸 — 색 + 글자. 색만으로는 흑백 인쇄에서 사라진다 */
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

/** 스텝 구성 막대 — 회차 한 줄을 눈으로 비교하게 만드는 장치 */
function bar(c: ScenarioRunCounts): string {
  const total = c.pass + c.fail + c.error + c.info + c.skip + c.waiting + c.pending
  if (!total) return '<span class="bar empty"></span>'
  const seg = (n: number, k: string, label: string) =>
    n ? `<i class="s-${k}" style="width:${((n / total) * 100).toFixed(2)}%" title="${label} ${n}"></i>` : ''
  return (
    '<span class="bar">' +
    seg(c.pass, 'pass', '정상') +
    seg(c.info, 'info', '실행됨') +
    seg(c.fail, 'fail', '실패') +
    seg(c.error, 'error', '실행오류') +
    seg(c.waiting, 'wait', '수동대기') +
    seg(c.skip, 'skip', '건너뜀') +
    seg(c.pending, 'pending', '미실행') +
    '</span>'
  )
}

/** 제목을 안 적었을 때 쓸 이름 — 무엇을 몇 번 돌린 문서인지까지만 */
export function defaultBundleTitle(runs: ScenarioRunDetail[]): string {
  if (!runs.length) return '시나리오 검증 리포트'
  const one = sameScenario(runs)
  return one ? `${runs[0].title} 시나리오 수행` : `시나리오 검증 ${runs.length}회차`
}

export interface BundleOptions {
  /** 문서 제목 — 사람이 정한다 (예: 'CONTRABASS V3.0.6 시나리오 수행') */
  title?: string
  now?: number
}

export function buildBundleHtml(input: ScenarioRunDetail[], opts: BundleOptions = {}): string {
  const runs = chrono(input)
  const now = opts.now ?? Date.now()
  const title = opts.title?.trim() || defaultBundleTitle(runs)
  const targets = [...new Set(runs.flatMap((r) => r.targets))]
  const grid = sameScenario(runs) && runs.length > 1 ? stepGrid(runs) : []
  const always = grid.filter((row) => row.cells.every((c) => c && BAD.includes(c.effective)))
  const verdicts = runs.map((r) => runVerdict(r))
  const nFail = verdicts.filter((v) => v.key === 'fail').length
  const nIncomplete = verdicts.filter((v) => v.key === 'incomplete').length
  const nPass = verdicts.filter((v) => v.key === 'pass').length
  // 문서 전체의 한 줄 결론 — 읽는 사람이 가장 먼저 찾는 문장이다
  const headline =
    runs.length === 0
      ? { key: 'none', text: '회차가 없습니다' }
      : nFail > 0
        ? { key: 'fail', text: `회차 ${runs.length}개 중 ${nFail}개에서 실패가 있습니다` }
        : nIncomplete > 0
          ? { key: 'incomplete', text: `실패는 없지만 ${nIncomplete}개 회차에 확인이 남아 있습니다` }
          : { key: 'pass', text: `회차 ${runs.length}개 모두 기준을 만족했습니다` }

  const stat = (label: string, value: string | number, kind = '') =>
    `<div class="stat ${kind}"><b>${value}</b><span>${label}</span></div>`

  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  /* 외부 자원을 쓰지 않는다 — 메일 첨부·망 밖에서도 그대로 보여야 한다.
     밝은 배경인 이유는 이 문서가 앱 화면이 아니라 인쇄·전달되는 제출물이기 때문이다. */
  :root {
    --ink:#1b2130; --ink-2:#48546a; --ink-3:#75818f;
    --line:#e2e6ee; --line-2:#eef1f6; --paper:#ffffff; --bg:#f4f6fa;
    --pass:#0f766e; --pass-bg:#e9f8f4;
    --fail:#c02626; --fail-bg:#fdeeee;
    --warn:#a16207; --warn-bg:#fdf6e7;
    --info:#4b5563; --accent:#2563eb;
  }
  * { box-sizing:border-box }
  html { -webkit-text-size-adjust:100% }
  body { margin:0; background:var(--bg); color:var(--ink);
         font:13.5px/1.7 -apple-system, "Segoe UI", "Malgun Gothic", "맑은 고딕", system-ui, sans-serif }
  .wrap { max-width:1180px; margin:0 auto; padding:0 24px 40px }

  /* 머리 — 스크롤해도 무슨 문서인지 잃지 않게 붙여 둔다 */
  header { position:sticky; top:0; z-index:5; background:var(--paper); border-bottom:1px solid var(--line) }
  header .wrap { padding-top:14px; padding-bottom:12px }
  .brand { font-size:11px; letter-spacing:.14em; text-transform:uppercase; color:var(--ink-3) }
  h1 { font-size:21px; line-height:1.35; margin:3px 0 6px; font-weight:700; letter-spacing:-.01em }
  .sub { font-size:11.5px; color:var(--ink-3) }
  .sub b { color:var(--ink-2); font-weight:600 }

  /* 결론 — 맨 위에 한 줄 */
  .headline { display:flex; align-items:center; gap:9px; margin:16px 0 12px; padding:11px 14px;
              border-radius:9px; border:1px solid var(--line); background:var(--paper); font-size:14px; font-weight:600 }
  .headline.k-fail { border-color:#f3c9c9; background:var(--fail-bg); color:var(--fail) }
  .headline.k-incomplete { border-color:#eedcae; background:var(--warn-bg); color:var(--warn) }
  .headline.k-pass { border-color:#bfe6dc; background:var(--pass-bg); color:var(--pass) }
  .headline .dot { width:9px; height:9px; border-radius:99px; background:currentColor; flex:none }

  .stats { display:grid; grid-template-columns:repeat(4, 1fr); gap:10px; margin-bottom:14px }
  .stat { background:var(--paper); border:1px solid var(--line); border-radius:9px; padding:11px 13px }
  .stat b { display:block; font-size:23px; line-height:1.2; font-weight:700; letter-spacing:-.02em }
  .stat span { font-size:11px; color:var(--ink-3) }
  .stat.k-fail b { color:var(--fail) } .stat.k-pass b { color:var(--pass) } .stat.k-warn b { color:var(--warn) }

  .card { background:var(--paper); border:1px solid var(--line); border-radius:10px; padding:16px 18px; margin-bottom:14px }
  h2 { font-size:14.5px; margin:0 0 10px; font-weight:700; letter-spacing:-.01em }
  h2 .hint { font-weight:400; font-size:11px; color:var(--ink-3); margin-left:8px }
  h3 { font-size:13.5px; margin:0 0 8px; font-weight:700 }
  h3 .meta { font-weight:400; font-size:11px; color:var(--ink-3); margin-left:6px }

  .note { font-size:11.5px; color:var(--ink-3); line-height:1.75 }
  .banner { margin:0 0 10px; padding:9px 12px; border-radius:8px; font-size:12px; line-height:1.7;
            border:1px solid #eedcae; background:var(--warn-bg); color:#7a4d06 }
  .banner.k-fail { border-color:#f3c9c9; background:var(--fail-bg); color:#8f1d1d }
  .banner b { font-weight:700 }

  /* 좁은 화면에서는 **표만** 옆으로 밀린다. 감싸지 않으면 문서 전체가 옆으로 밀려
     제목·결론까지 화면 밖으로 나간다(375px 에서 실제로 그랬다). */
  .tw { overflow-x:auto; -webkit-overflow-scrolling:touch }
  table { border-collapse:collapse; width:100%; font-size:12.5px }
  .tw > table { min-width:max-content }
  th, td { text-align:left; padding:7px 9px; border-bottom:1px solid var(--line-2); vertical-align:top }
  /* 표 머리를 붙여 두지 않는다 — 페이지 머리가 이미 붙어 있어서, 둘이 겹치면 표 머리가
     그 뒤로 숨는다. 표는 길어야 스텝 열몇 줄이라 붙여 둘 값도 크지 않다. */
  thead th { font-size:11px; font-weight:600; color:var(--ink-3); background:#fafbfd;
             border-bottom:1px solid var(--line); white-space:nowrap }
  tbody tr:last-child td { border-bottom:0 }
  tbody tr:hover { background:#fafbfd }
  td.num { text-align:right; font-variant-numeric:tabular-nums; color:var(--ink-2) }
  td.dim, .dim { color:var(--ink-3); font-size:11.5px }
  td.none { color:#b6bdc9 }
  td.good { color:var(--pass) } td.bad { color:var(--fail); font-weight:600; background:var(--fail-bg) }
  td.wait { color:var(--warn) }
  sup { font-size:9px; color:var(--ink-3); margin-left:2px; font-weight:400 }

  /* 판정 알약 — 색 + 글자를 함께 쓴다(흑백 인쇄·색약에서도 읽혀야 한다) */
  .pill { display:inline-block; padding:1.5px 9px; border-radius:99px; font-size:11px; font-weight:700;
          border:1px solid transparent; white-space:nowrap }
  .pill.k-pass { color:var(--pass); background:var(--pass-bg); border-color:#bfe6dc }
  .pill.k-fail { color:var(--fail); background:var(--fail-bg); border-color:#f3c9c9 }
  .pill.k-incomplete { color:var(--warn); background:var(--warn-bg); border-color:#eedcae }

  /* 스텝 구성 막대 */
  .bar { display:flex; width:132px; height:7px; border-radius:99px; overflow:hidden; background:#eef1f6 }
  .bar.empty { background:#eef1f6 }
  .bar i { display:block; height:100% }
  .s-pass { background:#2aa88b } .s-info { background:#8fc7bb } .s-fail { background:#d94b4b }
  .s-error { background:#a32020 } .s-wait { background:#e0a93c } .s-skip { background:#b3a6d8 }
  .s-pending { background:#cfd6e0 }
  .legend { display:flex; flex-wrap:wrap; gap:12px; margin-top:9px; font-size:11px; color:var(--ink-3) }
  .legend span { display:inline-flex; align-items:center; gap:5px }
  .legend i { width:9px; height:9px; border-radius:2px; display:inline-block }

  /*
    회차 탭 — **자바스크립트 없이** 라디오 + label 로 만든다.
    (라디오는 화면 밖으로 숨기되 display:none 은 쓰지 않는다 — 키보드로 못 고르게 된다)
  */
  .tabs > input, .raws { position:absolute; opacity:0; width:0; height:0 }
  .tabbar { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:-1px }
  .tabbar label { display:inline-flex; align-items:center; gap:7px; cursor:pointer; user-select:none;
                  border:1px solid var(--line); border-bottom-color:transparent; border-radius:9px 9px 0 0;
                  background:#f7f9fc; padding:7px 13px; font-size:12px; color:var(--ink-2) }
  .tabbar label:hover { background:#eef2f8; color:var(--ink) }
  .tabbar label b { font-weight:700; color:var(--ink-3) }
  .panels > section { display:none; background:var(--paper); border:1px solid var(--line); border-radius:0 10px 10px 10px;
                      padding:16px 18px }
  .panels > section > h3:first-child { margin-top:0 }

  /* 리포트 원문 — 접어 두고 필요할 때만 편다. 펴 두면 스텝 표가 안 보인다 */
  .rawbtn { display:inline-block; margin-top:14px; cursor:pointer; user-select:none; font-size:11.5px;
            color:var(--accent); border:1px solid #cfdcf7; background:#f3f7ff; border-radius:7px; padding:5px 11px }
  .rawbtn:hover { background:#e7effd }
  .rawbox { display:none; margin-top:9px }
  .raws:checked ~ .rawbox { display:block }
  .raws:checked ~ .rawbtn { background:#e7effd }
  pre { background:#fbfcfe; border:1px solid var(--line); border-radius:8px; padding:12px 14px; margin:0;
        font:11.5px/1.65 ui-monospace, Consolas, "D2Coding", monospace; color:#2b3444;
        white-space:pre-wrap; word-break:break-all; overflow-x:auto }

  .top { display:inline-block; margin-top:14px; font-size:11px; color:var(--ink-3); text-decoration:none }
  .top:hover { color:var(--accent) }
  footer { color:var(--ink-3); font-size:11px; line-height:1.8; padding:16px 0 0; border-top:1px solid var(--line); margin-top:8px }

  @media (max-width:820px) {
    .stats { grid-template-columns:repeat(2, 1fr) }
    .wrap { padding:0 14px 30px }
  }

  /* 인쇄 — 탭과 접힘은 화면에서만 쓸모가 있다. 종이에는 전부 펼쳐 나와야 회차가 빠지지 않는다 */
  @media print {
    body { background:#fff }
    header { position:static }
    .tabbar, .rawbtn, .top { display:none !important }
    .card, .panels > section { border-color:#d7dce6; break-inside:avoid }
    .panels > section { display:block !important; border-radius:10px; margin-bottom:12px }
    .rawbox { display:block !important }
    .tw { overflow:visible }
  }
${Array.from({ length: 60 }, (_, i) =>
  `  #tab${i}:checked ~ .tabbar label[for="tab${i}"] { background:var(--paper); color:var(--ink); font-weight:600; border-bottom-color:var(--paper) }\n` +
  `  #tab${i}:checked ~ .panels > #panel${i} { display:block }`,
).join('\n')}
</style></head><body>
<header>
  <div class="wrap">
    <div class="brand">Q-Term 검증 리포트</div>
    <h1 id="top">${esc(title)}</h1>
    <div class="sub">
      회차 <b>${runs.length}개</b>${
        runs.length
          ? ` · ${esc(runStamp(runs[0].startedAt))} ~ ${esc(runStamp(runs[runs.length - 1].startedAt))}`
          : ''
      }${targets.length ? ` · 대상 <b>${esc(targets.join(' · '))}</b>` : ''} · 뽑은 시각 ${esc(runStamp(now))}
    </div>
  </div>
</header>

<div class="wrap">
  <div class="headline k-${headline.key}"><span class="dot"></span>${esc(headline.text)}</div>

  <div class="stats">
    ${stat('회차', runs.length)}
    ${stat('정상 회차', nPass, 'k-pass')}
    ${stat('실패 회차', nFail, 'k-fail')}
    ${stat('확인 남음', nIncomplete, 'k-warn')}
  </div>

  ${
    always.length
      ? `<div class="banner k-fail"><b>모든 회차에서 실패한 스텝</b> — ${always
          .map((r) => esc(r.title))
          .join(' · ')}<br>회차를 거듭해도 같은 곳에서 실패한다는 뜻입니다. 여기서부터 보십시오.</div>`
      : ''
  }
  ${
    runs.some((r) => r.stopped)
      ? `<div class="banner"><b>중단된 회차가 있습니다</b> — ${runs
          .filter((r) => r.stopped)
          .map((r) => esc(runStamp(r.startedAt)) + (r.stoppedAt ? ` (${r.stoppedAt}번에서)` : ''))
          .join(' · ')}. 그 뒤 스텝은 <b>미실행</b>이며 정상도 실패도 아닙니다.</div>`
      : ''
  }
  ${
    runs.some((r) => r.compatShell)
      ? '<div class="banner">일부 회차는 <b>호환 모드(exec)</b>로 실행됐습니다 — cd 유지·대화형 응답·타임아웃 중단이 제한됩니다.</div>'
      : ''
  }

  <div class="card">
    <h2>개요<span class="hint">회차 하나가 한 줄입니다. 막대는 그 회차의 스텝 구성입니다.</span></h2>
    <div class="tw"><table>
      <thead>
        <tr><th>No</th><th>시나리오</th><th>실행 시각</th><th>결과</th><th>스텝 구성</th>
        <th>정상</th><th>실패</th><th>실행오류</th><th>수동대기</th><th>건너뜀</th><th>미실행</th><th>소요</th></tr>
      </thead>
      <tbody>
        ${runs
          .map((r, i) => {
            const v = verdicts[i]
            return `<tr>
          <td class="num">${i + 1}</td>
          <td>${esc(r.title)}</td>
          <td>${esc(runStamp(r.startedAt))}${r.stopped ? ' <sup>중단</sup>' : ''}</td>
          <td><span class="pill k-${v.key}">${v.label}</span></td>
          <td>${bar(r.counts)}</td>
          <td class="num">${r.counts.pass}</td>
          <td class="num${r.counts.fail ? ' bad' : ''}">${r.counts.fail}</td>
          <td class="num${r.counts.error ? ' bad' : ''}">${r.counts.error}</td>
          <td class="num">${r.counts.waiting}</td>
          <td class="num">${r.counts.skip}</td>
          <td class="num">${r.counts.pending}</td>
          <td class="dim">${esc(durText(r.endedAt - r.startedAt))}</td>
        </tr>`
          })
          .join('')}
      </tbody>
    </table></div>
    <div class="legend">
      <span><i class="s-pass"></i>정상</span><span><i class="s-info"></i>실행됨</span>
      <span><i class="s-fail"></i>실패</span><span><i class="s-error"></i>실행오류</span>
      <span><i class="s-wait"></i>수동대기</span><span><i class="s-skip"></i>건너뜀</span>
      <span><i class="s-pending"></i>미실행</span>
    </div>
  </div>

  ${
    grid.length
      ? `<div class="card">
    <h2>스텝별 추이<span class="hint">스텝은 번호가 아니라 제목으로 맞춥니다 — 중간에 스텝을 끼워 넣어도 짝이 밀리지 않게</span></h2>
    <div class="tw"><table>
      <thead><tr><th>스텝</th>${runs
        .map((r, i) => `<th>${i + 1}. ${esc(runStamp(r.startedAt).slice(5))}</th>`)
        .join('')}</tr></thead>
      <tbody>
        ${grid.map((row) => `<tr><td>${esc(row.title)}</td>${row.cells.map(cell).join('')}</tr>`).join('')}
      </tbody>
    </table></div>
    <div class="note">칸이 <b>—</b> 인 것은 그 회차에 없던 스텝입니다(시나리오를 고친 뒤 돌렸을 때).</div>
  </div>`
      : ''
  }

  <h2 style="margin:18px 0 10px">회차 상세<span class="hint">탭을 눌러 회차를 바꿉니다 · 인쇄하면 전부 펼쳐집니다</span></h2>
  <div class="tabs">
    ${runs.map((_, i) => `<input type="radio" name="run" id="tab${i}"${i === 0 ? ' checked' : ''}>`).join('')}
    <div class="tabbar">
      ${runs
        .map(
          (r, i) =>
            `<label for="tab${i}"><b>${i + 1}</b> ${esc(runStamp(r.startedAt))} <span class="pill k-${
              verdicts[i].key
            }">${verdicts[i].label}</span></label>`,
        )
        .join('')}
    </div>
    <div class="panels">
      ${runs
        .map(
          (r, i) => `<section id="panel${i}">
        <h3>${i + 1}. ${esc(r.title)}<span class="meta">${esc(runStamp(r.startedAt))} · ${esc(
          durText(r.endedAt - r.startedAt),
        )} · ${esc(countsText(r.counts))}${r.targets.length ? ` · 대상 ${esc(r.targets.join(' · '))}` : ''}</span></h3>
        ${
          r.stopped
            ? `<div class="banner">${
                r.stoppedAt ? `${r.stoppedAt}번에서 ` : ''
              }중단된 회차입니다 — 그 뒤 스텝은 <b>미실행</b>이며 정상도 실패도 아닙니다.</div>`
            : ''
        }
        ${
          r.steps.length
            ? `<div class="tw"><table class="steps">
          <thead><tr><th>#</th><th>스텝</th><th>판정</th><th>대상</th><th>판정 근거</th></tr></thead>
          <tbody>
          ${r.steps
            .map(
              (st) => `<tr>
            <td class="num">${st.index + 1}</td>
            <td>${esc(st.title)}</td>
            ${cell(st)}
            <td class="dim">${esc(st.sessionName ?? '')}</td>
            <td class="dim">${esc((st.reasons ?? []).join(', '))}${
              typeof st.code === 'number' ? `${(st.reasons ?? []).length ? ' · ' : ''}종료 코드 ${st.code}` : ''
            }${st.retried ? ' · 대응 후 재실행' : ''}</td>
          </tr>`,
            )
            .join('')}
          </tbody>
        </table></div>`
            : '<div class="note">이 회차에는 스텝 기록이 없습니다.</div>'
        }
        <input type="checkbox" class="raws" id="raw${i}">
        <label class="rawbtn" for="raw${i}">리포트 원문 보기 — 명령 · 출력 · 판정 근거</label>
        <div class="rawbox"><pre>${esc(r.reportMd.trim())}</pre></div>
        <br><a class="top" href="#top">↑ 맨 위로</a>
      </section>`,
        )
        .join('')}
    </div>
  </div>

  <footer>
    Q-Term 시나리오 검증 이력에서 뽑았습니다. 회차 상세의 <b>리포트 원문</b>은 그때 만든 것을 그대로 실었고,
    비밀번호·토큰은 저장 시점에 가려졌습니다.<br>
    탭과 펼치기는 자바스크립트 없이 동작합니다 — <b>인쇄하면 모든 회차와 원문이 펼쳐집니다.</b>
  </footer>
</div>
</body></html>`
}
