/**
 * 성능 검증 결과를 **제출용 한 장**으로 만든다.
 *
 * ── 왜 따로 만드나
 * 지금까지 "리포트" 는 Locust·JMeter 가 만든 문서 맨 앞에 우리 판정 조각을 얹은 것이었다.
 * 그 문서는 도구마다 생김새가 다르고(JMeter 는 폴더 통째, Locust 는 한 파일), 영어이며,
 * **우리가 아는 것을 담지 못한다** — 어떤 세션을 상대로 무슨 조건에서 돌렸는지, 같은
 * 시간대 대상 서버의 CPU·메모리가 어땠는지는 도구가 모르는 정보다. 검수 자리에 내는 것은
 * 대개 후자다.
 *
 * 그래서 우리 데이터만으로 **자체 완결 HTML 한 장**을 만든다.
 *
 * ── 규칙
 * - 바깥을 물어보지 않는다. 그래프는 인라인 SVG 로 직접 그린다(차트 라이브러리·폰트·CDN
 *   모두 없음). 사내망에 첨부하거나 메일에 붙여도 그대로 열린다.
 * - 밝은 배경으로 고정한다. 인쇄·PDF 로 내보내는 것이 이 문서의 용도다.
 * - 나가는 문서이므로 **마스킹을 건다** — 실패 본문에 토큰이 섞여 나오는 일이 실제로 있다.
 *   마스킹 함수는 밖에서 주입한다(화면·AI 전송과 같은 규칙을 쓰기 위해).
 * - 판정 기준이 없으면 초록을 띄우지 않는다(verdict.ts 와 같은 3-상태 규칙을 그대로 받는다).
 */

export interface OnePagerSeriesPoint {
  sec: number
  users?: number
  rps?: number
  failsPerSec?: number
  p50Ms?: number
  p95Ms?: number
}

export interface OnePagerInput {
  /** 'Locust' · 'JMeter' */
  toolLabel: string
  runLabel?: string
  memo?: string
  startedAt: number
  endedAt?: number
  canceled?: boolean
  exitCode?: number
  targetUrl: string
  sessionLabel?: string
  /** '사용자 50명 · 5명/초 · 3분' 처럼 이미 문장으로 만들어 넘긴다 */
  loadText: string
  /** 시나리오 단계 설명 — 'GET /v3/servers (비율 10)' 같은 줄 */
  scenarioLines: string[]
  scenarioNote?: string
  criteriaText: string
  verdict: { tone: 'pass' | 'fail' | 'info'; label: string; reasons: string[] }
  summary?: {
    requests: number
    failures: number
    failRatePct: number
    rps: number
    avgMs: number
    p50Ms?: number
    p95Ms?: number
    p99Ms?: number
    maxMs?: number
    avgContentBytes?: number
    perEndpoint: { name: string; requests: number; failures: number; avgMs: number; p95Ms?: number }[]
  }
  history: OnePagerSeriesPoint[]
  server: { sec: number; cpu?: number; mem?: number }[]
  serverNote?: string
  failures: { name: string; error: string; count: number }[]
  failureKinds: { label: string; count: number }[]
  samples: { t: number; name: string; code: number | null; error: string; body: string }[]
  /** 그래프에 점선으로 그릴 기준값 */
  p95ThresholdMs?: number
  /** 회차 폴더 경로 — '원본은 어디 있나' 를 문서에도 남긴다 */
  folderPath?: string
  mask: (s: string) => string
}

const esc = (v: unknown): string =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

function fmtClock(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}년 ${p(d.getMonth() + 1)}월 ${p(d.getDate())}일 ${p(d.getHours())}시 ${p(d.getMinutes())}분`
}

function fmtMs(v?: number): string {
  if (v === undefined || !Number.isFinite(v)) return '–'
  return v >= 1000 ? `${(v / 1000).toFixed(2)}초` : `${Math.round(v)}ms`
}

function fmtInt(v?: number): string {
  if (v === undefined || !Number.isFinite(v)) return '–'
  return Math.round(v).toLocaleString()
}

function fmtDur(fromMs: number, toMs?: number): string {
  if (!toMs) return '–'
  const s = Math.max(0, Math.round((toMs - fromMs) / 1000))
  return s >= 60 ? `${Math.floor(s / 60)}분 ${s % 60}초` : `${s}초`
}

/**
 * 꺾은선 하나를 그린다.
 *
 * 라이브러리를 쓰지 않는 이유는 파일 하나로 끝나야 하기 때문이다(첨부·메일·오프라인).
 * 눈금은 최소만 — 0 / 최대, 그리고 가로축은 시작·중간·끝 세 곳이면 읽는 데 충분하다.
 */
function chart(
  series: { label: string; color: string; points: { x: number; y: number }[] }[],
  opts: { unit: string; threshold?: { y: number; label: string }; height?: number },
): string {
  const W = 640
  const H = opts.height ?? 150
  const L = 44 // 왼쪽 눈금 자리
  const R = 8
  const T = 10
  const B = 20
  const all = series.flatMap((s) => s.points)
  if (all.length < 2) return ''
  const xs = all.map((p) => p.x)
  const ys = all.map((p) => p.y)
  const xMax = Math.max(...xs, 1)
  /**
   * 세로 눈금은 **데이터에 맞춘다.**
   *
   * 기준선까지 담으려고 눈금을 늘리면, 여유 있게 통과한 회차에서 선이 바닥에 눌려붙어
   * 아무것도 안 보인다(실제로 그랬다). 기준선은 데이터의 1.6배까지만 따라가고, 그보다
   * 높으면 위쪽 가장자리에 붙여 '이 위 어딘가' 라고만 알린다 — 여유 있게 통과한 회차에서도
   * 선의 모양(어디서 튀었는지)이 보여야 한다.
   */
  const dataTop = Math.max(...ys, 1)
  const thY0 = opts.threshold?.y ?? 0
  const yTop = Math.max(dataTop * 1.15, Math.min(thY0 * 1.05, dataTop * 1.6))
  const px = (x: number) => L + (x / xMax) * (W - L - R)
  const py = (y: number) => T + (1 - y / yTop) * (H - T - B)

  const grid = [0, 0.5, 1]
    .map((f) => {
      const y = T + f * (H - T - B)
      const v = yTop * (1 - f)
      return (
        `<line x1="${L}" y1="${y.toFixed(1)}" x2="${W - R}" y2="${y.toFixed(1)}" stroke="#e8eaed" stroke-width="1"/>` +
        `<text x="${L - 6}" y="${(y + 3.5).toFixed(1)}" text-anchor="end" font-size="9" fill="#80868b">${
          v >= 100 ? Math.round(v) : v.toFixed(v >= 10 ? 0 : 1)
        }</text>`
      )
    })
    .join('')

  const xticks = [0, 0.5, 1]
    .map((f) => {
      const x = px(xMax * f)
      return `<text x="${x.toFixed(1)}" y="${H - 5}" text-anchor="${
        f === 0 ? 'start' : f === 1 ? 'end' : 'middle'
      }" font-size="9" fill="#80868b">${Math.round(xMax * f)}s</text>`
    })
    .join('')

  const lines = series
    .filter((s) => s.points.length > 1)
    .map(
      (s) =>
        `<polyline fill="none" stroke="${s.color}" stroke-width="1.6" stroke-linejoin="round" points="${s.points
          .map((p) => `${px(p.x).toFixed(1)},${py(p.y).toFixed(1)}`)
          .join(' ')}"/>`,
    )
    .join('')

  const clamped = thY0 > yTop
  const thY = Math.min(thY0, yTop)
  const th = opts.threshold
    ? `<line x1="${L}" y1="${py(thY).toFixed(1)}" x2="${W - R}" y2="${py(thY).toFixed(
        1,
      )}" stroke="#d93025" stroke-width="1" stroke-dasharray="4 3"/>` +
      `<text x="${W - R}" y="${(py(thY) + (clamped ? 10 : -4)).toFixed(
        1,
      )}" text-anchor="end" font-size="9" fill="#d93025">${esc(opts.threshold.label)}${
        clamped ? ' ↑ (눈금 밖)' : ''
      }</text>`
    : ''

  const legend = series
    .map(
      (s) =>
        `<span style="display:inline-flex;align-items:center;gap:4px;margin-right:12px">` +
        `<span style="width:10px;height:2px;background:${s.color};display:inline-block"></span>${esc(s.label)}</span>`,
    )
    .join('')

  return (
    `<div style="margin:6px 0 2px;font-size:11px;color:#5f6368">${legend}` +
    `<span style="color:#9aa0a6">단위 ${esc(opts.unit)} · 가로축 = 시작 후 초</span></div>` +
    `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" style="display:block">` +
    grid +
    th +
    lines +
    xticks +
    `</svg>`
  )
}

function table(rows: [string, string][]): string {
  return (
    `<table style="border-collapse:collapse;font-size:12.5px;width:100%">` +
    rows
      .map(
        ([k, v]) =>
          `<tr><td style="padding:4px 14px 4px 0;color:#5f6368;white-space:nowrap;vertical-align:top;width:1%">${esc(
            k,
          )}</td><td style="padding:4px 0;color:#202124">${v}</td></tr>`,
      )
      .join('') +
    `</table>`
  )
}

function section(title: string, inner: string): string {
  if (!inner) return ''
  return (
    `<section style="margin:18px 0 0;break-inside:avoid">` +
    `<h2 style="font-size:12px;font-weight:600;color:#5f6368;letter-spacing:.04em;margin:0 0 6px;` +
    `padding-bottom:4px;border-bottom:1px solid #e8eaed">${esc(title)}</h2>${inner}</section>`
  )
}

export function buildOnePager(i: OnePagerInput): string {
  const tone =
    i.verdict.tone === 'pass'
      ? { fg: '#137333', bg: '#e6f4ea', bd: '#ceead6' }
      : i.verdict.tone === 'fail'
        ? { fg: '#b3261e', bg: '#fce8e6', bd: '#f6cbc7' }
        : { fg: '#5f6368', bg: '#f1f3f4', bd: '#e0e2e4' }

  const s = i.summary
  const head =
    `<div style="display:flex;align-items:baseline;gap:8px;flex-wrap:wrap">` +
    `<span style="font-size:18px;font-weight:600;color:#202124">성능 검증 결과</span>` +
    `<span style="font-size:12px;color:#80868b">Q-Term · ${esc(i.toolLabel)}</span></div>` +
    (i.runLabel ? `<div style="font-size:14px;color:#202124;margin-top:2px">${esc(i.runLabel)}</div>` : '') +
    `<div style="font-size:12px;color:#5f6368;margin-top:2px">${esc(fmtClock(i.startedAt))} 시작 · ${esc(
      fmtDur(i.startedAt, i.endedAt),
    )} 실행</div>`

  const verdictBox =
    `<div style="margin-top:12px;padding:10px 12px;border:1px solid ${tone.bd};background:${tone.bg};border-radius:8px">` +
    `<div style="font-size:15px;font-weight:600;color:${tone.fg}">${esc(i.verdict.label)}</div>` +
    (i.verdict.reasons.length
      ? `<ul style="margin:6px 0 0;padding-left:18px;font-size:12.5px;color:#3c4043">` +
        i.verdict.reasons.map((r) => `<li style="margin:1px 0">${esc(r)}</li>`).join('') +
        `</ul>`
      : '') +
    (i.canceled
      ? `<div style="margin-top:6px;font-size:12px;color:#a1590e">사람이 중지한 회차입니다 — 계획한 시간을 채우지 않았습니다.</div>`
      : '') +
    `</div>` +
    (i.memo ? `<p style="margin:8px 0 0;font-size:12.5px;color:#3c4043">${esc(i.memo)}</p>` : '')

  const condition = section(
    '조건',
    table([
      ['대상', esc(i.targetUrl) || '<span style="color:#9aa0a6">계획 파일이 정함</span>'],
      ...(i.sessionLabel ? ([['대상 세션', esc(i.sessionLabel)]] as [string, string][]) : []),
      ['부하', esc(i.loadText)],
      [
        '시나리오',
        i.scenarioLines.length
          ? i.scenarioLines.map((l) => esc(l)).join('<br>') +
            (i.scenarioNote ? `<div style="color:#80868b;margin-top:2px">${esc(i.scenarioNote)}</div>` : '')
          : '<span style="color:#9aa0a6">–</span>',
      ],
      ['판정 기준', esc(i.criteriaText)],
    ]),
  )

  const nums = s
    ? section(
        '결과',
        `<div style="display:flex;flex-wrap:wrap;gap:8px">` +
          (
            [
              ['총 요청', fmtInt(s.requests)],
              ['실패', `${fmtInt(s.failures)} (${s.failRatePct.toFixed(2)}%)`],
              ['초당 요청', fmtInt(s.rps)],
              ['p50', fmtMs(s.p50Ms)],
              ['p95', fmtMs(s.p95Ms)],
              ['p99', fmtMs(s.p99Ms)],
              ['최대', fmtMs(s.maxMs)],
              ['평균', fmtMs(s.avgMs)],
            ] as [string, string][]
          )
            .map(
              ([k, v]) =>
                `<div style="flex:1 1 90px;min-width:90px;border:1px solid #e8eaed;border-radius:6px;padding:6px 8px">` +
                `<div style="font-size:10.5px;color:#80868b">${esc(k)}</div>` +
                `<div style="font-size:15px;color:#202124;margin-top:1px">${esc(v)}</div></div>`,
            )
            .join('') +
          `</div>`,
      )
    : section(
        '결과',
        `<p style="font-size:12.5px;color:#80868b;margin:0">집계가 남지 않았습니다 (중지되었거나 실행이 실패했습니다).</p>`,
      )

  const hasHist = i.history.length > 1
  const timeCharts = hasHist
    ? section(
        '시간에 따라',
        chart(
          [
            { label: 'p95', color: '#1a73e8', points: i.history.filter((p) => p.p95Ms !== undefined).map((p) => ({ x: p.sec, y: p.p95Ms as number })) },
            { label: 'p50', color: '#9aa0a6', points: i.history.filter((p) => p.p50Ms !== undefined).map((p) => ({ x: p.sec, y: p.p50Ms as number })) },
          ].filter((x) => x.points.length > 1),
          {
            unit: 'ms',
            threshold: i.p95ThresholdMs ? { y: i.p95ThresholdMs, label: `기준 ${i.p95ThresholdMs}ms` } : undefined,
          },
        ) +
          chart(
            [
              { label: '초당 요청(건)', color: '#137333', points: i.history.map((p) => ({ x: p.sec, y: p.rps ?? 0 })) },
              { label: '초당 실패(건)', color: '#d93025', points: i.history.map((p) => ({ x: p.sec, y: p.failsPerSec ?? 0 })) },
              { label: '사용자(명)', color: '#a142f4', points: i.history.map((p) => ({ x: p.sec, y: p.users ?? 0 })) },
            ],
            // 건수와 인원을 한 눈금에 얹는다 — 둘 다 '개수' 라 크기가 비슷하고, 인원을
            // 따로 떼면 그래프만 늘어난다. 정확한 값은 위 표에 있다.
            { unit: '건 · 명 (같은 눈금)', height: 130 },
          ),
      )
    : ''

  const serverChart = i.server.length > 1
    ? section(
        '같은 시간대 대상 서버',
        chart(
          [
            { label: 'CPU', color: '#e37400', points: i.server.filter((p) => p.cpu !== undefined).map((p) => ({ x: p.sec, y: p.cpu as number })) },
            { label: '메모리', color: '#1a73e8', points: i.server.filter((p) => p.mem !== undefined).map((p) => ({ x: p.sec, y: p.mem as number })) },
          ].filter((x) => x.points.length > 1),
          { unit: '%', height: 130 },
        ) +
          `<p style="margin:4px 0 0;font-size:11px;color:#80868b">응답이 느려진 구간과 자원 사용이 겹치는지 보세요 — 겹치지 않으면 병목은 이 서버 밖(게이트웨이·DB·네트워크)입니다.</p>`,
      )
    : i.serverNote
      ? section('같은 시간대 대상 서버', `<p style="margin:0;font-size:12px;color:#80868b">${esc(i.serverNote)}</p>`)
      : ''

  const endpoints =
    s && s.perEndpoint.length > 1
      ? section(
          '요청별',
          `<table style="border-collapse:collapse;font-size:12px;width:100%">` +
            `<tr style="color:#80868b;text-align:left">` +
            ['요청', '건수', '실패', '평균', 'p95']
              .map(
                (h, n) =>
                  `<th style="padding:3px 8px 3px 0;font-weight:500;text-align:${n === 0 ? 'left' : 'right'}">${esc(h)}</th>`,
              )
              .join('') +
            `</tr>` +
            s.perEndpoint
              .map(
                (e) =>
                  `<tr style="border-top:1px solid #f1f3f4">` +
                  `<td style="padding:3px 8px 3px 0;color:#202124">${esc(e.name)}</td>` +
                  `<td style="padding:3px 0;text-align:right;color:#3c4043">${fmtInt(e.requests)}</td>` +
                  `<td style="padding:3px 0;text-align:right;color:${e.failures ? '#b3261e' : '#3c4043'}">${fmtInt(
                    e.failures,
                  )}</td>` +
                  `<td style="padding:3px 0;text-align:right;color:#3c4043">${fmtMs(e.avgMs)}</td>` +
                  `<td style="padding:3px 0;text-align:right;color:#3c4043">${fmtMs(e.p95Ms)}</td></tr>`,
              )
              .join('') +
            `</table>`,
        )
      : ''

  const failBlock =
    i.failures.length || i.failureKinds.length
      ? section(
          '실패',
          (i.failureKinds.length
            ? `<div style="margin-bottom:6px;font-size:12.5px;color:#3c4043">` +
              i.failureKinds
                .map(
                  (k) =>
                    `<span style="display:inline-block;margin-right:10px">${esc(k.label)} <b>${fmtInt(
                      k.count,
                    )}</b></span>`,
                )
                .join('') +
              `</div>`
            : '') +
            (i.failures.length
              ? `<table style="border-collapse:collapse;font-size:12px;width:100%">` +
                i.failures
                  .slice(0, 10)
                  .map(
                    (f) =>
                      `<tr style="border-top:1px solid #f1f3f4">` +
                      `<td style="padding:3px 8px 3px 0;color:#5f6368;white-space:nowrap">${esc(f.name)}</td>` +
                      `<td style="padding:3px 8px 3px 0;color:#202124">${esc(i.mask(f.error))}</td>` +
                      `<td style="padding:3px 0;text-align:right;color:#3c4043;white-space:nowrap">${fmtInt(
                        f.count,
                      )}</td></tr>`,
                  )
                  .join('') +
                `</table>`
              : ''),
        )
      : ''

  const sampleBlock = i.samples.length
    ? section(
        '실패 응답 표본',
        i.samples
          .slice(0, 5)
          .map(
            (sp) =>
              `<div style="margin-bottom:6px">` +
              `<div style="font-size:11.5px;color:#5f6368">${esc(sp.name)}${
                sp.code ? ` · HTTP ${esc(sp.code)}` : ''
              }</div>` +
              `<pre style="margin:2px 0 0;padding:6px 8px;background:#f8f9fa;border:1px solid #e8eaed;border-radius:4px;` +
              `font-size:11px;color:#3c4043;white-space:pre-wrap;word-break:break-all;max-height:120px;overflow:hidden">${esc(
                i.mask(sp.body || sp.error).slice(0, 600),
              )}</pre></div>`,
          )
          .join(''),
      )
    : ''

  const foot =
    `<footer style="margin-top:22px;padding-top:8px;border-top:1px solid #e8eaed;font-size:11px;color:#80868b">` +
    `${esc(i.toolLabel)} 로 측정 · 부하는 검증자 PC 에서 발생시켰습니다 (대상 서버에는 아무것도 설치하지 않았습니다).` +
    (i.folderPath ? `<br>원본 결과 파일: ${esc(i.folderPath)}` : '') +
    `<br>문서 생성 ${esc(fmtClock(Date.now()))}` +
    `</footer>`

  return (
    `<!doctype html><html lang="ko"><head><meta charset="utf-8">` +
    `<title>성능 검증 결과 — ${esc(i.runLabel || fmtClock(i.startedAt))}</title>` +
    `<style>` +
    `body{margin:0;background:#f1f3f4;font-family:system-ui,'Malgun Gothic','Apple SD Gothic Neo',sans-serif;` +
    `-webkit-print-color-adjust:exact;print-color-adjust:exact}` +
    `main{max-width:820px;margin:0 auto;padding:28px 32px;background:#fff;min-height:100vh;` +
    `box-shadow:0 0 0 1px #e0e2e4}` +
    `@media print{body{background:#fff}main{box-shadow:none;padding:0;max-width:none}}` +
    `</style></head><body><main>` +
    head +
    verdictBox +
    condition +
    nums +
    timeCharts +
    serverChart +
    endpoints +
    failBlock +
    sampleBlock +
    foot +
    `</main></body></html>`
  )
}
