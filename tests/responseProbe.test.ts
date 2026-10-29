// 응답 측정 — 대상 해석 · 시작 명령 · 폴링 해석 · 요약 · 자동 종료 · HTTP 판정 · 스크립트 문법
import { spawnSync } from 'node:child_process'
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test, eq, ok } from './harness'
import {
  PROBE_SCRIPT,
  DEFAULT_PROBE,
  parseTargets,
  rowsToText,
  textToRows,
  buildStartCmd,
  parsePoll,
  summarize,
  shouldAutoStop,
  codeMatches,
  httpSpec,
  specValid,
  fmtGapText,
  fileStem,
  parseNovaServers,
  type ProbeEvent,
  type ProbeLast,
} from '../src/lib/responseProbe'

test('대상 — HTTP: IP·포트·경로, 셸 문자 거절', () => {
  const r = parseTargets("web-01 10.0.0.1\n10.0.0.2:8080/health\nhttp://x'y")
  eq(r.targets.map((t) => t.url), ['http://10.0.0.1', 'http://10.0.0.2:8080/health'])
  eq(r.errors.length, 1)
})
test('대상 — TCP 는 포트 필수, Ping 은 호스트만', () => {
  const t = parseTargets('db 10.0.0.1:3306\n10.0.0.2', 'tcp')
  eq([t.targets.map((x) => x.url), t.errors], [['tcp://10.0.0.1:3306'], ['TCP (포트) 는 포트 입력이 필수입니다.']])
  eq(parseTargets('vm 10.0.0.1:80\nhttp://h.local/x', 'icmp').targets.map((x) => x.url), ['icmp://10.0.0.1', 'icmp://h.local'])
})
test('수동 입력 ↔ 자유 형식 왕복', () => {
  const rows = textToRows('db 10.0.0.1:3306', 'tcp').rows
  eq([rows[0].port, rowsToText(rows, 'tcp')], ['3306', 'db 10.0.0.1:3306'])
})
test('시작 명령 인자 — 방식·연속 실패·최대 시간·리다이렉트·Host', () => {
  const c = { ...DEFAULT_PROBE, expectSpec: '200,3xx', follow: true, hostHeader: 'portal.example.com', targets: [{ name: 'a', url: 'http://x/' }] }
  ok(buildStartCmd('1', c).includes("probe.sh 1 2 3 200,3xx http 2 10800 1 'portal.example.com' 'http://x/'"))
  ok(buildStartCmd('1', { ...c, hostHeader: "a'b" }).includes("10800 1 '' 'http://x/'"), '셸 문자가 든 Host 헤더는 버린다')
  ok(buildStartCmd('1', { ...DEFAULT_PROBE, mode: 'tcp', targets: [{ name: 'd', url: 'tcp://10.0.0.1:22' }] }).includes("OPEN tcp 2 10800 0 '' '10.0.0.1:22'"))
})
test('HTTP 정상 코드 지정', () => {
  const c = { ...DEFAULT_PROBE, expectSpec: '200, 3XX' }
  eq(httpSpec(c), '200,3xx')
  eq([codeMatches('302', c), codeMatches('200', c), codeMatches('503', c), codeMatches('000', c)], [true, true, false, false])
  eq([specValid('2xx'), specValid('2x'), specValid('abc'), specValid('')], [true, false, false, true])
})
test('폴링 해석 — 마지막 이벤트 줄을 잃지 않고, 덜 쓴 줄은 다음에', () => {
  const p = parsePoll('0 1792000001000 200 3 0 1\nQT_EV\n1792000000000,0,200,ready,1791999998000\n1792000000500,0,000,outage,1792000000500\n\nQT_ALIVE\nyes\n')
  eq([p.events.length, p.alive, p.last.length], [2, true, 1])
  const q = parsePoll('QT_EV\n1792000000000,0,200,rea\nQT_ALIVE\nyes\n')
  eq([q.events.length, q.consumed], [0, 0])
})
test('폴링 해석 — 최대 시간으로 끝난 것과 그냥 멈춘 것을 가른다', () => {
  const x = parsePoll('QT_EV\n\nQT_ALIVE\nno\nQT_EXPIRED 1792000001800\n')
  eq([x.alive, x.expiredAt], [false, 1792000001800])
  const y = parsePoll('QT_EV\n\nQT_ALIVE\nno\n')
  eq([y.alive, y.expiredAt], [false, null])
})

const T = Date.parse('2026-10-23T14:19:52+09:00')
const cfg10 = { ...DEFAULT_PROBE, targets: Array.from({ length: 10 }, (_, i) => ({ name: `web-${i}`, url: `http://10.0.0.${i}` })) }
const down = [1, 2, 4, 6, 7, 9]
const O = T + 71000
const rec = (i: number) => O + 180000 + i * 4000
const base: ProbeEvent[] = cfg10.targets.map((_, i) => ({ at: T + 3000, idx: i, code: '200', kind: 'ready', base: T + 1000 }))
down.forEach((i) => base.push({ at: O + i * 300, idx: i, code: '000', kind: 'outage', base: O + i * 300 }))
const all: ProbeEvent[] = [...base, ...down.map((i) => ({ at: rec(i) + 2000, idx: i, code: '200', kind: 'recovered' as const, base: rec(i), outageStart: O + i * 300 }))]
const last = (h: number, out: (i: number) => boolean): ProbeLast[] =>
  cfg10.targets.map((_, i) => ({ idx: i, at: h, code: out(i) ? '000' : '200', streak: out(i) ? 0 : 5, outage: out(i), ready: true }))

test('요약 — 첫 끊김 · 모두 복구 · 최장 순단', () => {
  const s = summarize(cfg10, all, [])
  eq([s.firstOutage, s.allRecovered, s.maxGap], [O + 300, rec(9), rec(9) - (O + 2700)])
})
test('자동 종료 — 하나라도 끊겨 있으면 계속, 복구 + 10초 뒤 종료, 끊김 전에는 안 함', () => {
  const l1 = last(rec(9) + 60000, (i) => i === 9)
  ok(!shouldAutoStop(cfg10, summarize(cfg10, all.filter((e) => !(e.kind === 'recovered' && e.idx === 9)), l1), l1))
  const l2 = last(rec(9) + 5000, () => false)
  ok(!shouldAutoStop(cfg10, summarize(cfg10, all, l2), l2), '5초는 이르다')
  const l3 = last(rec(9) + 12000, () => false)
  ok(shouldAutoStop(cfg10, summarize(cfg10, all, l3), l3), '12초면 종료')
  const l4 = last(T + 600000, () => false)
  ok(!shouldAutoStop(cfg10, summarize(cfg10, base.filter((e) => e.kind === 'ready'), l4), l4), '끊김 전')
  ok(!shouldAutoStop({ ...cfg10, autoStop: false }, summarize(cfg10, all, l3), l3), '자동 종료 끔')
})
test('순단 표기 — 1분 60초가 되지 않는다', () => eq([fmtGapText(119_600), fmtGapText(49_500)], ['2분 00초', '49.5초']))
test('Nova VM 목록 — Networks 문자열·객체 둘 다', () => {
  const v = parseNovaServers(
    JSON.stringify([
      { ID: 'b', Name: 'web-02', Status: 'ACTIVE', Networks: { net1: ['10.0.0.6', '172.24.4.9'] } },
      { ID: 'a', Name: 'web-01', Status: 'ACTIVE', Networks: 'net1=10.0.0.5, 172.24.4.10' },
    ]),
  )
  eq(v?.map((x) => `${x.name}:${x.ips[0]}`), ['web-01:10.0.0.5', 'web-02:10.0.0.6'])
  eq(parseNovaServers('Policy doesn\'t allow'), null)
})

// 스크립트 — bash 문법과 판정(가짜 curl 로 정해진 응답 순서): 한 번 튄 실패 무시 · 연속 2회 실패 = 끊김(시각은 첫 실패) · 3xx 정상
test('측정 스크립트 — 문법 · 판정 · 최대 시간', () => {
  const bash = spawnSync('bash', ['--version'], { encoding: 'utf8' })
  if (bash.status !== 0) return // bash 가 없는 PC 에서는 건너뛴다
  const dir = mkdtempSync(path.join(tmpdir(), 'qterm-probe-'))
  try {
    writeFileSync(path.join(dir, 'probe.sh'), PROBE_SCRIPT)
    eq(spawnSync('bash', ['-n', path.join(dir, 'probe.sh')]).status, 0, 'bash -n')
    writeFileSync(path.join(dir, 'codes'), ['302', '302', '302', '000', '302', '302', '302', '000', '000', '000', '302', '302', '302', '302'].join('\n') + '\n')
    writeFileSync(
      path.join(dir, 'curl'),
      '#!/bin/bash\nd="$(dirname "$0")"\ni=$(cat "$d/n" 2>/dev/null || echo 0); i=$((i + 1)); echo $i > "$d/n"\nc=$(sed -n "${i}p" "$d/codes"); echo -n "${c:-302}"\n',
    )
    const env = { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}` }
    spawnSync('chmod', ['+x', path.join(dir, 'curl')])
    // 최대 시간은 넉넉히 — 18초였을 때 Windows bash 가 느린 날(요청 한 번이 1초를 넘김) 13번째 요청 전에 끝나 '복구' 가 빠졌다(3번에 1번꼴)
    const r = spawnSync('bash', ['./probe.sh', '1', '1', '3', '200,3xx', 'http', '2', '30', '0', '', 'http://x/'], { cwd: dir, env, encoding: 'utf8', timeout: 60000 })
    eq(r.status, 0, '최대 시간이 지나면 스스로 끝난다')
    const ev = spawnSync('cat', ['events.csv'], { cwd: dir, encoding: 'utf8' }).stdout.trim().split('\n').map((l) => l.split(','))
    eq(ev.map((e) => e[3]), ['ready', 'outage', 'recovered'], '튄 실패(4번째)는 무시, 8~10번째에서 끊김')
    const checks = spawnSync('cat', ['checks.csv'], { cwd: dir, encoding: 'utf8' }).stdout.trim().split('\n').map((l) => l.split(','))
    eq(ev[1][4], checks[7][0], '끊김 시각 = 연속 실패의 첫 실패(8번째 요청)')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('저장 파일 이름 — 회차 이름을 넣되 파일 이름에 못 쓰는 글자는 - 로', () => {
  const run = { startedAt: new Date('2026-10-28T10:51:23').getTime() } as Parameters<typeof fileStem>[1]
  eq(fileStem('응답측정결과', run), '응답측정결과_20261028_1051')
  eq(fileStem('응답측정결과', { ...run, label: 'contrabass01 DOWN 1차' }), '응답측정결과_contrabass01-DOWN-1차_20261028_1051')
  eq(fileStem('응답측정', { ...run, label: 'a/b:c*?"<>| d' }), '응답측정_a-b-c-d_20261028_1051')
  // 전부 못 쓰는 글자면 날짜만
  eq(fileStem('응답측정', { ...run, label: '///' }), '응답측정_20261028_1051')
})
