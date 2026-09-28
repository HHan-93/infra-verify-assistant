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

/** 표 칸에 들어갈 값 — `|` 하나가 표를 통째로 어긋나게 한다(시나리오 제목은 자유 문자열이다) */
const mdCell = (s: string) => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')

/**
 * 리포트 원문의 제목 단계만 내린다 — **코드 블록 안은 건드리지 않는다.**
 *
 * 원문에는 명령 출력이 ``` 로 묶여 들어 있고, 거기에도 `# ...` 로 시작하는 줄이 있다
 * (주석·프롬프트). 줄 단위로 일괄 치환하면 그 출력이 바뀌어 버려서, '그때 만든 리포트를
 * 그대로 싣는다' 는 이 파일의 규칙을 스스로 깬다.
 */
function shiftHeadings(md: string): string {
  let fence = false
  return md
    .split('\n')
    .map((line) => {
      if (/^\s*```/.test(line)) {
        fence = !fence
        return line
      }
      return fence ? line : line.replace(/^(#{1,3}) /, '###$1 ')
    })
    .join('\n')
}

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
  /**
   * 짝을 맞추는 열쇠 — 제목 + **그 회차에서 몇 번째로 나온 같은 제목인가.**
   *
   * 제목만 쓰면 같은 이름의 스텝이 둘 있는 시나리오에서 뒤엣것이 통째로 사라진다(사용자
   * 정의 시나리오는 '상태 확인' 을 앞뒤로 두 번 두는 일이 흔하다). 그러면 두 번째의 실패가
   * 격자에서도, '모든 회차에서 실패한 스텝' 경고에서도 빠진다 — 이 리포트의 핵심 신호가
   * 조용히 없어지는 것이라 번호를 함께 센다.
   */
  const keyed = (r: ScenarioRunDetail) => {
    const nth = new Map<string, number>()
    return r.steps.map((st) => {
      const n = (nth.get(st.title) ?? 0) + 1
      nth.set(st.title, n)
      return { key: `${st.title}\u0000${n}`, title: st.title, step: st }
    })
  }
  const byRun = runs.map(keyed)
  const order: { key: string; title: string }[] = []
  const seen = new Set<string>()
  // 가장 최근 회차의 순서를 기준으로 삼는다 — 지금 쓰는 시나리오의 모양이다
  const recentFirst = runs.map((r, i) => ({ r, rows: byRun[i] })).sort((a, b) => b.r.startedAt - a.r.startedAt)
  for (const { rows } of recentFirst) {
    for (const row of rows) {
      if (seen.has(row.key)) continue
      seen.add(row.key)
      order.push({ key: row.key, title: row.title })
    }
  }
  return order.map(({ key, title }) => ({
    title,
    cells: byRun.map((rows) => rows.find((row) => row.key === key)?.step ?? null),
  }))
}

/**
 * 회차 하나의 **한 줄 결과.**
 *
 * 개요 표에서 눈으로 훑는 값이라 셋으로만 나눈다 — **실패 / 정상 / 그 외.** 그 외(중단 ·
 * 판정 없음)를 남겨 두는 이유는 이 앱의 규칙 그대로다: **근거 없이 초록을 띄우지 않는다.**
 * 끝까지 돌지 않았거나 판정된 스텝이 하나도 없는 회차를 정상으로 칠하면 아무도 그 회차를
 * 다시 안 본다. 반대로 사람 확인이 남은 것만으로는 막지 않는다(아래 주석).
 */
export function runVerdict(r: {
  counts: ScenarioRunCounts
  stopped?: boolean
}): { key: 'fail' | 'incomplete' | 'pass'; label: string } {
  if (r.counts.fail + r.counts.error > 0) return { key: 'fail', label: '실패' }
  /**
   * 중단된 회차는 정상으로 치지 않는다 — 끝까지 돌지 않았으니 '전부 만족했다' 고 말할 근거가 없다.
   *
   * 반대로 **수동대기(명령이 없는 안내 스텝)는 더 이상 막지 않는다.** 예전에는 막았는데,
   * 그러면 "LNB 에서 인스턴스를 생성하세요" 같은 안내가 하나라도 있는 시나리오는 사람이
   * 스텝마다 체크를 눌러 주지 않는 한 **영원히 정상이 될 수 없었다**(사용자 지적). 그건
   * 검증 결과가 아니라 체크를 눌렀는지를 재는 것이다. 남은 수는 개요 막대와 회차 칩에
   * 그대로 보이므로 사실이 감춰지지도 않는다.
   */
  if (r.stopped) return { key: 'incomplete', label: '중단' }
  /**
   * **명령과 기준이 있는데 돌지 않은 스텝(미실행)이 남았으면 정상으로 치지 않는다.**
   *
   * 예전에는 이 수를 보지 않아, 전체 실행이 manualOnly 로 비켜 간 재부팅 → '재부팅 후 마운트
   * 유지 확인' 을 **한 번도 돌리지 않은 회차가 '정상 · 모두 기준을 만족' 으로 남았다.** 그 시나리오의
   * 요점이 바로 그 확인인데, 확인한 적 없는 것이 확인된 것으로 기록된 셈이다. 대화형이라 뺀 스텝,
   * 입력값이 없어 건너뛴 스텝도 같다.
   *
   * 위의 수동대기(명령이 없는 안내 스텝 — counts.waiting)와는 다르다. 그쪽은 러너가 돌릴 것이
   * 애초에 없고, 이쪽은 돌릴 것이 있는데 안 돌았다. 사람이 일부러 뺀 것이면 '건너뜀' 을 눌러
   * 그 결정을 기록하면 된다(skip 은 여기 세지 않는다).
   */
  if (r.counts.pending > 0) return { key: 'incomplete', label: '미실행 남음' }
  /**
   * **판정된 스텝이 하나도 없으면 초록을 띄우지 않는다.**
   *
   * `info`(실행됨)는 '돌긴 했는데 정상 조건이 없어 판정하지 않았다' 는 뜻이다(verdict.ts 의
   * 3-상태). `df -h` · `ceph -s` 처럼 보기만 하는 스텝으로 이뤄진 시나리오는 전부 info 로
   * 끝나는데, 그걸 '정상' 으로 칠하면 **아무것도 검증하지 않은 회차가 초록 제출물이 된다.**
   * 이 저장소가 verdict.ts 에서 지키는 규칙(기준이 없으면 PASS 없음)을 리포트에서 뒤집지
   * 않는다. 건너뛴 것만 있는 회차도 같다.
   */
  if (r.counts.pass === 0) return { key: 'incomplete', label: '판정 없음' }
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
      `| ${i + 1} | ${runStamp(r.startedAt)}${r.stopped ? ' (중단)' : ''} | ${mdCell(r.title)} | ` +
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
        `| ${mdCell(row.title)} | ` +
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
    L.push(shiftHeadings(r.reportMd).trim())
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

/**
 * 스텝 한 줄의 '판정 근거' 문구.
 *
 * 종료 코드를 무조건 덧붙이면 **같은 말이 두 번 나온다** — 러너의 판정 근거에 이미
 * '종료 코드 0' 이 들어 있는 경우가 흔하다(실제 회차에서 `종료 코드 0, 출력에 위험 키워드
 * 없음 · 종료 코드 0` 로 찍혔다). 근거가 이미 말하고 있으면 덧붙이지 않는다.
 */
export function reasonText(st: ScenarioRunStep): string {
  const parts = [...(st.reasons ?? [])]
  const said = parts.some((r) => /종료\s*코드/.test(r))
  if (typeof st.code === 'number' && !said) parts.push(`종료 코드 ${st.code}`)
  if (st.retried) parts.push('대응 후 재실행')
  return parts.join(' · ')
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
  /** 사람이 눈으로 봐야 하는 스텝 수 — 회차 판정은 막지 않지만 남았다는 사실은 말한다 */
  const nWait = runs.reduce((a, r) => a + r.counts.waiting, 0)
  // 문서 전체의 한 줄 결론 — 읽는 사람이 가장 먼저 찾는 문장이다
  const headline =
    runs.length === 0
      ? { key: 'none', text: '회차가 없습니다' }
      : nFail > 0
        ? { key: 'fail', text: `회차 ${runs.length}개 중 ${nFail}개에서 실패가 있습니다` }
        : nIncomplete > 0
          ? {
              key: 'incomplete',
              text: `실패는 없지만 ${nIncomplete}개 회차는 정상으로 볼 수 없습니다 (중단 · 미실행 스텝 남음 · 판정 기준 없음)`,
            }
          : { key: 'pass', text: `회차 ${runs.length}개 모두 기준을 만족했습니다` }

  const kpi = (label: string, value: string | number, kind = '') =>
    `<div class="kpi ${kind}"><b>${value}</b><span>${label}</span></div>`

  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  /* 외부 자원을 쓰지 않는다 — 메일 첨부·망 밖에서도 그대로 보여야 한다.
     본문이 밝은 배경인 이유는 이 문서가 앱 화면이 아니라 인쇄·전달되는 제출물이기 때문이다. */
  :root {
    --ink:#1b2130; --ink-2:#48546a; --ink-3:#75818f;
    --line:#e2e6ee; --line-2:#eef1f6; --paper:#ffffff; --bg:#f4f6fa;
    --pass:#0f766e; --pass-bg:#e9f8f4;
    --fail:#c02626; --fail-bg:#fdeeee;
    --warn:#a16207; --warn-bg:#fdf6e7;
    --accent:#2563eb;
  }
  * { box-sizing:border-box }
  html { -webkit-text-size-adjust:100% }
  body { margin:0; background:var(--bg); color:var(--ink);
         font:13.5px/1.7 -apple-system, "Segoe UI", "Malgun Gothic", "맑은 고딕", system-ui, sans-serif }
  .wrap { max-width:1120px; margin:0 auto; padding:0 24px }

  /*
    머리 — 어두운 띠 하나에 '무슨 문서인지'와 '결론 숫자'를 몰아 둔다.
    붙여 두지(sticky) 않는다: 아래 회차 카드를 펼치면 화면이 좁아지는데, 그 상태에서
    머리까지 자리를 먹으면 정작 봐야 할 표가 안 보인다. 결론은 어차피 맨 위에 있다.
  */
  .top { background:linear-gradient(180deg,#1e2534,#252d3f); color:#fff; padding:26px 0 24px }
  .brand { font-size:10.5px; letter-spacing:.16em; text-transform:uppercase; color:#8e9ab0 }
  h1 { font-size:24px; line-height:1.3; margin:7px 0 5px; font-weight:700; letter-spacing:-.015em }
  .sub { font-size:12px; color:#9aa5ba; margin:0 }
  .sub b { color:#d7dee9; font-weight:600 }
  .kpis { display:grid; grid-template-columns:repeat(4,1fr); gap:11px; margin-top:20px }
  .kpi { background:rgba(255,255,255,.07); border:1px solid rgba(255,255,255,.1);
         border-radius:10px; padding:12px 15px }
  .kpi b { display:block; font-size:25px; line-height:1.15; font-weight:700; letter-spacing:-.02em;
           font-variant-numeric:tabular-nums }
  .kpi span { font-size:11.5px; color:#9aa5ba }
  .kpi.k-pass b { color:#6fdcb0 } .kpi.k-fail b { color:#ff9494 } .kpi.k-warn b { color:#f0c674 }

  .body { padding:22px 0 44px }

  /* 결론 — 본문 첫 줄 */
  .headline { display:flex; align-items:center; gap:9px; margin:0 0 14px; padding:11px 14px;
              border-radius:9px; border:1px solid var(--line); background:var(--paper); font-size:14px; font-weight:600 }
  .headline.k-fail { border-color:#f3c9c9; background:var(--fail-bg); color:var(--fail) }
  .headline.k-incomplete { border-color:#eedcae; background:var(--warn-bg); color:var(--warn) }
  .headline.k-pass { border-color:#bfe6dc; background:var(--pass-bg); color:var(--pass) }
  .headline .dot { width:9px; height:9px; border-radius:99px; background:currentColor; flex:none }

  .card { background:var(--paper); border:1px solid var(--line); border-radius:10px; padding:16px 18px; margin-bottom:14px }
  h2 { font-size:14.5px; margin:0 0 10px; font-weight:700; letter-spacing:-.01em }
  h2 .hint { font-weight:400; font-size:11px; color:var(--ink-3); margin-left:8px }

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
    회차 카드 — **자바스크립트 없이** 체크박스 + label 로 펼친다.
    <details> 를 쓰지 않는 이유: 브라우저 기본 스타일이 닫힌 내용을 감춰서 인쇄할 때
    CSS 로 강제로 펼 수가 없다. 종이에는 모든 회차가 펼쳐져 나와야 한다.
    (체크박스는 화면 밖으로 숨기되 display:none 은 쓰지 않는다 — 키보드로 못 고르게 된다)
  */
  .rt, .raws { position:absolute; opacity:0; width:0; height:0 }
  .run { position:relative; background:var(--paper); border:1px solid var(--line); border-radius:10px;
         margin-bottom:10px; overflow:hidden }
  .run::before { content:""; position:absolute; left:0; top:0; bottom:0; width:4px; background:#cfd6e0 }
  .run.k-pass::before { background:#2aa88b }
  .run.k-fail::before { background:#d94b4b }
  .run.k-incomplete::before { background:#e0a93c }
  .rhead { display:flex; align-items:center; gap:13px; padding:13px 16px 13px 20px; cursor:pointer; user-select:none }
  .rhead:hover { background:#fafbfd }
  .rno { font-variant-numeric:tabular-nums; color:var(--ink-3); font-size:12px; flex:none }
  .rttl { flex:1; min-width:0 }
  .rttl b { display:block; font-size:13.5px; font-weight:650 }
  .rttl span { font-size:11.5px; color:var(--ink-3) }
  .rhead .bar { flex:none }
  .chev { color:var(--ink-3); font-size:10px; flex:none; transition:transform .15s }
  .rt:checked ~ .rhead .chev { transform:rotate(180deg) }
  .rbody { display:none; border-top:1px solid var(--line-2); padding:14px 16px 16px 20px }
  .rt:checked ~ .rbody { display:block }
  .chips { display:flex; flex-wrap:wrap; gap:8px; margin-bottom:12px }
  .chip { font-size:11.5px; color:var(--ink-3); background:#f6f8fb; border:1px solid var(--line-2);
          border-radius:7px; padding:3px 9px }
  .chip b { color:var(--ink); font-weight:650 }
  .chip.k-fail b { color:var(--fail) }

  /* 리포트 원문 — 스텝 표 **위**에 둔다. 아래에 두면 긴 표를 다 내려야 보여서 있는 줄을 모른다 */
  .rawbtn { display:inline-block; margin-bottom:12px; cursor:pointer; user-select:none; font-size:11.5px;
            color:var(--accent); border:1px solid #cfdcf7; background:#f3f7ff; border-radius:7px; padding:5px 11px }
  .rawbtn:hover { background:#e7effd }
  .rawbox { display:none; margin:0 0 14px }
  .raws:checked ~ .rawbox { display:block }
  .raws:checked ~ .rawbtn { background:#e7effd }
  pre { background:#fbfcfe; border:1px solid var(--line); border-radius:8px; padding:12px 14px; margin:0;
        font:11.5px/1.65 ui-monospace, Consolas, "D2Coding", monospace; color:#2b3444;
        white-space:pre-wrap; word-break:break-all; overflow-x:auto; max-height:520px; overflow-y:auto }
  footer { color:var(--ink-3); font-size:11px; line-height:1.8; padding:16px 0 0; border-top:1px solid var(--line); margin-top:14px }

  @media (max-width:820px) {
    .kpis { grid-template-columns:repeat(2, 1fr) }
    .wrap { padding:0 14px }
    .rhead .bar { display:none }
  }

  /* 인쇄 — 펼침은 화면에서만 쓸모가 있다. 종이에는 전부 펼쳐 나와야 회차가 빠지지 않는다 */
  @media print {
    body { background:#fff }
    .top { background:#fff !important; color:#000; padding-bottom:10px; border-bottom:2px solid #1b2130 }
    .brand, .sub { color:#555 !important } .sub b { color:#000 !important }
    .kpi { background:#fff !important; border-color:#d7dce6 !important }
    .kpi span { color:#555 !important }
    .kpi b, .kpi.k-pass b, .kpi.k-fail b, .kpi.k-warn b { color:#000 !important }
    .rawbtn, .chev { display:none !important }
    .card, .run { border-color:#d7dce6; break-inside:avoid }
    .rbody, .rawbox { display:block !important }
    pre { max-height:none; overflow:visible }
    .tw { overflow:visible }
  }
</style></head><body>
<div class="top"><div class="wrap">
  <div class="brand">Q-Term 검증 리포트</div>
  <h1 id="top">${esc(title)}</h1>
  <p class="sub">
    회차 <b>${runs.length}개</b>${
      runs.length
        ? ` · ${esc(runStamp(runs[0].startedAt))} ~ ${esc(runStamp(runs[runs.length - 1].startedAt))}`
        : ''
    }${targets.length ? ` · 대상 <b>${esc(targets.join(' · '))}</b>` : ''} · 뽑은 시각 ${esc(runStamp(now))}
  </p>
  <div class="kpis">
    ${kpi('회차', runs.length)}
    ${kpi('정상', nPass, 'k-pass')}
    ${kpi('실패', nFail, 'k-fail')}
    ${kpi('사람이 볼 스텝', nWait, 'k-warn')}
  </div>
</div></div>

<div class="body"><div class="wrap">
  <div class="headline k-${headline.key}"><span class="dot"></span>${esc(headline.text)}</div>

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
        <th>정상</th><th>실패</th><th>소요</th></tr>
      </thead>
      <tbody>
        ${runs
          .map((r, i) => {
            const v = verdicts[i]
            const bad = r.counts.fail + r.counts.error
            return `<tr>
          <td class="num">${i + 1}</td>
          <td>${esc(r.title)}</td>
          <td>${esc(runStamp(r.startedAt))}${r.stopped ? ' <sup>중단</sup>' : ''}</td>
          <td><span class="pill k-${v.key}">${v.label}</span></td>
          <td>${bar(r.counts)}</td>
          <td class="num">${r.counts.pass}</td>
          <td class="num${bad ? ' bad' : ''}">${bad}</td>
          <td class="dim">${esc(durText(r.endedAt - r.startedAt))}</td>
        </tr>`
          })
          .join('')}
      </tbody>
    </table></div>
    <div class="legend">
      <span><i class="s-pass"></i>정상</span><span><i class="s-info"></i>실행됨</span>
      <span><i class="s-fail"></i>실패</span><span><i class="s-error"></i>실행오류</span>
      <span><i class="s-wait"></i>수동 확인</span><span><i class="s-skip"></i>건너뜀</span>
      <span><i class="s-pending"></i>미실행</span>
    </div>
    <div class="note">실패 칸은 <b>실패 + 실행오류</b>를 합한 수입니다. 나머지 구성은 막대에 있습니다(칸에 마우스를 올리면 수가 나옵니다).</div>
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

  <h2 style="margin:18px 0 10px">회차 상세<span class="hint">카드를 눌러 펼칩니다 · 실패한 회차는 펼쳐 두었습니다 · 인쇄하면 전부 펼쳐집니다</span></h2>
  ${runs
    .map((r, i) => {
      const v = verdicts[i]
      const bad = r.counts.fail + r.counts.error
      return `<div class="run k-${v.key}">
    ${/* 실패한 회차는 펼쳐 둔다 — 문서를 여는 이유가 대개 그것이다 */ ''}
    <input type="checkbox" class="rt" id="r${i}"${v.key === 'fail' ? ' checked' : ''}>
    <label class="rhead" for="r${i}">
      <span class="rno">${i + 1}</span>
      <span class="rttl"><b>${esc(r.title)}</b><span>${esc(runStamp(r.startedAt))} · ${esc(
        durText(r.endedAt - r.startedAt),
      )}${r.targets.length ? ` · 대상 ${esc(r.targets.join(' · '))}` : ''}</span></span>
      ${bar(r.counts)}
      <span class="pill k-${v.key}">${v.label}</span>
      <span class="chev">▼</span>
    </label>
    <div class="rbody">
      ${
        r.stopped
          ? `<div class="banner">${
              r.stoppedAt ? `${r.stoppedAt}번에서 ` : ''
            }중단된 회차입니다 — 그 뒤 스텝은 <b>미실행</b>이며 정상도 실패도 아닙니다.</div>`
          : ''
      }
      <div class="chips">
        <span class="chip">정상 <b>${r.counts.pass}</b></span>
        <span class="chip${bad ? ' k-fail' : ''}">실패 <b>${bad}</b></span>
        <span class="chip">실행됨 <b>${r.counts.info}</b></span>
        <span class="chip">사람이 볼 것 <b>${r.counts.waiting}</b></span>
        <span class="chip">건너뜀 <b>${r.counts.skip}</b></span>
        <span class="chip">미실행 <b>${r.counts.pending}</b></span>
      </div>
      <input type="checkbox" class="raws" id="raw${i}">
      <label class="rawbtn" for="raw${i}">리포트 원문 보기 — 명령 · 출력 · 판정 근거</label>
      <div class="rawbox"><pre>${esc(r.reportMd.trim())}</pre></div>
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
          <td class="dim">${esc(reasonText(st))}</td>
        </tr>`,
          )
          .join('')}
        </tbody>
      </table></div>`
          : '<div class="note">이 회차에는 스텝 기록이 없습니다.</div>'
      }
    </div>
  </div>`
    })
    .join('')}

  <footer>
    Q-Term 시나리오 검증 이력에서 뽑았습니다. 회차마다 <b>리포트 원문</b>(명령·출력)을 그대로 실었고,
    비밀번호·토큰은 저장 시점에 가려졌습니다.<br>
    <b>사람이 볼 스텝</b>은 명령이 없는 안내 단계입니다 — 자동으로 판정할 것이 없어 회차 결과를 좌우하지 않습니다.<br>
    펼치기는 자바스크립트 없이 동작합니다 — <b>인쇄하면 모든 회차와 원문이 펼쳐집니다.</b>
  </footer>
</div></div>
</body></html>`
}

// ── 저장된 리포트 원문에서 스텝별 명령·출력 꺼내기 ──────────────

/** 스텝 하나의 '무엇을 실행했고 무엇이 나왔나' */
export interface StepBody {
  /** 실제로 나간 명령 (값이 채워진 상태) */
  command?: string
  /** 출력 덩어리 — 대상이 여럿이면 대상마다 하나씩 */
  outputs: { label: string; text: string }[]
}

/**
 * 회차의 리포트 원문(reportMd)에서 스텝별 **명령과 출력**을 꺼낸다.
 *
 * **왜 다시 파싱하나**: 회차 요약(ScenarioRunStep)에는 판정과 근거만 있고 출력이 없다.
 * 그런데 사람이 이력에서 정말 보고 싶은 것은 "무엇을 실행했고 무엇이 나왔나" 다 —
 * `종료 코드 0` 같은 판정 근거만으로는 알 수 없다(사용자 지적).
 *
 * 출력을 요약에도 따로 저장하지 않는 이유는 **같은 것을 두 군데 두지 않기 위해서**다.
 * 원문은 이미 마스킹을 거쳐 저장돼 있고, 그걸 정본으로 삼으면 옛 회차도 그대로 보인다.
 * (저장 형식을 바꿨다면 지금까지 쌓인 회차는 영영 출력 없이 남았을 것이다)
 *
 * 형식은 ScenarioRunner.buildReport 가 만든다 — 그쪽을 고치면 여기도 같이 고쳐야 한다.
 */
export function parseReportSteps(md: string): Map<number, StepBody> {
  const out = new Map<number, StepBody>()
  if (!md?.trim()) return out
  // `## 3. 제목  [정상]` 로 시작하는 덩어리로 자른다
  const heads = [...md.matchAll(/^## (\d+)\. /gm)]
  for (let i = 0; i < heads.length; i++) {
    const idx = Number(heads[i][1]) - 1
    if (!Number.isInteger(idx) || idx < 0) continue
    const start = heads[i].index ?? 0
    const end = i + 1 < heads.length ? (heads[i + 1].index ?? md.length) : md.length
    const sec = md.slice(start, end)
    const body: StepBody = { outputs: [] }
    // 명령 — 머리 바로 아래의 ``` 블록 중 `$ ` 로 시작하는 것
    const cmd = /```\n\$ ([\s\S]*?)\n```/.exec(sec)
    if (cmd) body.command = cmd[1].trim()
    // 출력 — <details><summary>…</summary> 안의 ``` 블록 (대상마다 하나씩 나올 수 있다)
    for (const m of sec.matchAll(/<summary>([^<]*)<\/summary>\s*```\n([\s\S]*?)\n```/g)) {
      const text = m[2]
      if (text.trim()) body.outputs.push({ label: m[1].trim(), text })
    }
    out.set(idx, body)
  }
  return out
}
