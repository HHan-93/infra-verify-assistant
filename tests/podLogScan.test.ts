// 파드 로그 이상 감시 — 줄 성격 · 서명 · 연결 대상 · 훑은 결과 쌓기 · 기준선 · 합친 보기
import { test, eq, ok, fixture } from './harness'
import {
  buildScanCmd,
  buildFetchCmd,
  buildLogView,
  classify,
  emptyLogWatch,
  extractTarget,
  groupHeadline,
  mergeScan,
  newInRun,
  parseScan,
  signature,
  splitTs,
  workloadOf,
} from '../src/lib/podLogScan'

const raw = fixture('podlog-bootfactory-valkey-dns.log').split('\n')
const T0 = Date.parse('2026-10-28T05:52:51.000Z')

test('줄 성격 — WARN 은 경고, 예외 클래스 · Caused by 는 딸린 줄, 스택 · INFO 는 버림', () => {
  const head = splitTs(raw[0]).text
  eq(classify(head), 'warn')
  eq(classify(raw[2]), 'attach')
  eq(classify(raw[3]), 'drop')
  eq(classify(raw[7]), 'attach')
  eq(classify('2026-10-28 INFO  Reconnected to valkey timeout=5s'), 'drop')
  eq(classify('E1028 05:52:51.000000 1 reflector.go:1] failed to list'), 'error')
  eq(classify('{"level":"error","msg":"x"}'), 'error')
  eq(classify('Failed to load info: connection timed out'), 'warn', '문장 속 info 는 수준이 아님')
  eq(classify('2026/10/28 05:52:51 [error] 7#7: upstream timed out'), 'error')
})

test('서명 — 시각 · 숫자 · IP 를 지워 다른 시각 · 다른 스레드의 같은 오류가 한 묶음', () => {
  const a = signature(splitTs(raw[0]).text)
  const b = signature('2026-10-28T05:53:21.101Z  WARN 1 --- [bootfactory] [llEventLoop-4-1] i.l.core.protocol.ConnectionWatchdog     : Cannot reconnect to [valkey-cluster-0.valkey-cluster.dataplatform.svc.cluster.local/<unresolved>:6379]: Failed to resolve \'valkey-cluster-0.valkey-cluster.dataplatform.svc.cluster.local\' [A(1)] and search domain query for configured domains failed as well: [boot-factory.svc.cluster.local, svc.cluster.local, cluster.local, default.svc.cluster.local, openstacklocal]')
  eq(a, b)
  ok(!/\d/.test(a), '숫자가 남으면 안 됨')
})

test('연결 대상 — svc DNS 이름은 ns/서비스, 종류는 DNS 조회 실패', () => {
  eq(extractTarget(splitTs(raw[0]).text), { target: 'dataplatform/valkey-cluster', kind: 'DNS 조회 실패' })
  eq(extractTarget('dial tcp 10.0.0.5:5432: connect: connection refused'), { target: '10.0.0.5:5432', kind: '연결 거부' })
  eq(extractTarget('ERROR at DnsResolveContext.java:1150 calling db-proxy.internal:3306 refused').target, 'db-proxy.internal:3306', '소스 파일:줄은 대상이 아님')
})

test('워크로드 이름 — Deployment 해시 · DaemonSet 꼬리를 떼고 StatefulSet 번호는 둠', () => {
  eq(workloadOf('boot-factory-auth-5b7fd5d98b-fqrz9'), 'boot-factory-auth')
  eq(workloadOf('cilium-8p42h'), 'cilium')
  eq(workloadOf('valkey-cluster-0'), 'valkey-cluster-0')
})

const scanOut = (lines: string[], pod = 'boot-factory-auth-5b7fd5d98b-fqrz9') => ['@@QTPOD boot-factory ' + pod + ' 0', ...lines, '@@QTEND'].join('\n')

test('훑은 결과 — 머리줄 · 딸린 원인(Caused by) · 실패한 파드는 조회 불가로', () => {
  const out = [
    '@@QTPOD boot-factory boot-factory-auth-5b7fd5d98b-fqrz9 0',
    raw[0],
    '2026-10-28T05:52:51.624Z ' + raw[2],
    '2026-10-28T05:52:51.624Z ' + raw[7],
    '@@QTPOD dataplatform okestro-db-pxc-2 1',
    '@@QTERR Error from server: error dialing backend: dial tcp: i/o timeout',
    '@@QTEND',
  ].join('\n')
  const p = parseScan(out)
  eq([p.complete, p.pods.length, p.pods[0].lines.length, p.pods[1].err], [true, 2, 3, 'Error from server: error dialing backend: dial tcp: i/o timeout'])
  const r = mergeScan(emptyLogWatch(), p.pods, { now: T0, baselineBefore: 0 })
  eq(r.state.groups.length, 1)
  const g = r.state.groups[0]
  eq([g.workload, g.level, g.count, g.target, g.kind], ['boot-factory-auth', 'error', 1, 'dataplatform/valkey-cluster', 'DNS 조회 실패'])
  ok(g.cause?.startsWith('Caused by: io.netty.resolver.dns.DnsNameResolverTimeoutException'), '원인은 가장 깊은 Caused by')
  eq(r.state.unreadable.map((x) => x.pod), ['okestro-db-pxc-2'])
  eq(groupHeadline(g), 'boot-factory-auth → dataplatform/valkey-cluster 연결 실패 (DNS 조회 실패)')
})

test('겹친 구간의 같은 줄은 한 번만, 기준선에 있던 오류는 새 오류가 아님', () => {
  const p1 = parseScan(scanOut([raw[0]])).pods
  const a = mergeScan(emptyLogWatch(), p1, { now: T0, baselineBefore: T0 + 60_000 })
  eq([a.newGroups.length, a.state.groups[0].baseline], [0, true])
  // 같은 줄을 다시 받음(겹친 구간) + 새 시각의 같은 오류 + 다른 파드
  const again = parseScan(scanOut([raw[0], raw[0].replace('05:52:51.623Z', '05:53:21.623Z')])).pods
  const other = parseScan(scanOut([raw[0]], 'boot-factory-auth-5b7fd5d98b-n8c69')).pods
  const b = mergeScan(a.state, [...again, ...other], { now: T0 + 60_000, baselineBefore: T0 + 30_000 })
  eq([b.newGroups.length, b.state.groups[0].count, b.state.groups[0].pods.length], [0, 3, 2])
  // 기준선이 닫힌 뒤 처음 보는 오류만 새 오류
  const c = mergeScan(b.state, parseScan(scanOut(['2026-10-28T05:54:00.000Z ERROR 1 --- [x] DB: Connection refused (db.dataplatform.svc:3306)'])).pods, { now: T0 + 120_000, baselineBefore: T0 + 30_000 })
  eq(c.newGroups.map((g) => g.kind), ['연결 거부'])
  // 기준선은 줄의 시각으로 가른다 — 검증 중에 다시 열어 5분을 거슬러 받아도 검증 뒤 오류는 새 오류
  const d = mergeScan(emptyLogWatch(), parseScan(scanOut([raw[0]])).pods, { now: T0 + 300_000, baselineBefore: T0 - 1000 })
  eq(d.newGroups.length, 1)
})

test('무시 문구', () => {
  const r = mergeScan(emptyLogWatch(), parseScan(scanOut([raw[0]])).pods, { now: T0, baselineBefore: 0, ignore: ['ConnectionWatchdog'] })
  eq(r.state.groups.length, 0)
})

test('훑기 명령 — 실패한 kubectl 출력은 거르지 않고, 사용자 단어는 글자 그대로', () => {
  const cmd = buildScanCmd({ namespaces: ['boot-factory', 'dataplatform'], sinceSec: 70, extraWords: ['a.b(c)'] })
  ok(cmd.includes("for ns in 'boot-factory' 'dataplatform'"), '네임스페이스')
  ok(cmd.includes('--since=70s'), '구간')
  ok(cmd.includes('if [ $rc -eq 0 ]'), '실패 출력은 grep 하지 않음')
  ok(cmd.includes('a\\.b\\(c\\)'), '정규식 특수문자 이스케이프')
  ok(cmd.trim().endsWith('echo "@@QTEND"'), '끝 표시')
})

test('합친 창 받기 — 끝에서 n줄(tail)이 아니라 오류 시각부터, 마지막 오류 뒤는 잘라 냄', () => {
  const cmd = buildFetchCmd('boot-factory', ['gw-a'], T0 - 60_000, T0 + 60_000)
  ok(cmd.includes('--since-time=2026-10-28T05:51:51.000Z'), '시작 시각')
  ok(!cmd.includes('--tail'), '시끄러운 파드에서 오류 줄이 잘려 나가던 tail 은 쓰지 않음')
  ok(cmd.includes('-v to=') && cmd.includes('2026-10-28T05:53:51.000Z'), '끝 시각')
  ok(cmd.includes('xargs -r -P 6') && cmd.includes('timeout 40 xargs'), '병렬 · 전체 제한 시간(죽은 노드 위 파드 몇 개로 60초 강제 종료에 닿지 않게)')
  ok(cmd.includes('head -n 4000'), '줄 수 한도는 앞에서')
})

test('합친 보기 —스택 접기, 원인, 같은 오류 반복을 한 줄로, 이 오류만 / 앞뒤 줄', () => {
  const sig = signature(splitTs(raw[0]).text)
  const lines = (shift: string) => [
    splitTs(raw[0].replace('05:52:51', shift)),
    { ts: null, text: raw[2] },
    { ts: null, text: raw[3] },
    { ts: null, text: raw[7] },
  ]
  const perPod = [
    {
      pod: 'auth-a',
      lines: [
        { ts: T0 - 5000, text: 'INFO started' },
        ...lines('05:52:51'),
        ...lines('05:53:21'),
        { ts: T0 + 60_000, text: 'INFO tick' },
      ],
    },
  ]
  const m = buildLogView(perPod, sig, 'match')
  eq(m.length, 1)
  eq([m[0].fold?.n, m[0].repeat?.n], [3, 1])
  ok(m[0].fold?.cause?.startsWith('io.netty.resolver.dns.DnsNameResolverTimeoutException'), '원인')
  const c = buildLogView(perPod, sig, 'ctx')
  eq(c.map((x) => x.kind), ['line', 'match', 'line'])
  eq(buildLogView(perPod, sig, 'all').length, 3)
})

test('코드 점검 10-29 — 이웃 워크로드를 합치지 않음 · 파드 꼬리 · 요청 id 는 서명에서 지움', () => {
  eq(workloadOf('boot-factory-agent-7d9f8c6b5-abcde'), 'boot-factory-agent')
  eq(workloadOf('nginx-proxy-6c8d7f9b4-x2k9z'), 'nginx-proxy')
  eq(signature('call to boot-factory-auth-5b7fd5d98b-fqrz9 failed req=aB3dE5fG7hJ9kL1mN3'), signature('call to boot-factory-auth-6c8d7f9b4c-x2k9z failed req=Zz9yY8xX7wW6vV5uU4'))
})

test('코드 점검 10-29 — 롤링 2회차에 같은 오류가 다시 나면 그 회차의 새 오류, 시작 전에도 나던 것은 아님', () => {
  const line = (t: string) => scanOut([`${t} ERROR 1 --- [x] DB: Connection refused (db.dataplatform.svc:3306)`])
  const r1 = T0 + 10 * 60_000
  // 1회차 검증 중에 처음 남
  let st = mergeScan(emptyLogWatch(), parseScan(line(new Date(r1 + 30_000).toISOString())).pods, { now: r1 + 60_000, baselineBefore: r1, runSince: r1 }).state
  eq(newInRun(st.groups[0], r1), true)
  // 1회차 끝(기준 없음) — 한참 뒤 2회차 시작, 그 뒤 다시 남 → 2회차의 새 오류(시작 전 5분 안에는 없었다)
  st = mergeScan(st, [], { now: r1 + 20 * 60_000, baselineBefore: r1, runSince: null }).state
  const r2 = r1 + 30 * 60_000
  st = mergeScan(st, parseScan(line(new Date(r2 + 20_000).toISOString())).pods, { now: r2 + 60_000, baselineBefore: r1, runSince: r2 }).state
  eq([newInRun(st.groups[0], r2), st.groups[0].countRun, st.groups[0].sinceRun], [true, 1, r2 + 20_000])
  // 3회차는 시작 1분 전에도 나고 있었음 → 그 회차가 만든 오류가 아님
  const r3 = r2 + 30 * 60_000
  st = mergeScan(st, parseScan([line(new Date(r3 - 60_000).toISOString()), line(new Date(r3 + 5_000).toISOString())].join('\n')).pods, { now: r3 + 60_000, baselineBefore: r1, runSince: r3 }).state
  eq(newInRun(st.groups[0], r3), false)
})

test('코드 점검 10-29 — 평소 여부는 이 훑기의 가장 이른 줄로(컨테이너 순서와 무관) · 사용자 단어는 INFO 여도 오류', () => {
  const out = scanOut([`2026-10-28T05:58:00.000Z WARN x timed out`, `2026-10-28T05:50:00.000Z WARN x timed out`])
  const r = mergeScan(emptyLogWatch(), parseScan(out).pods, { now: T0 + 600_000, baselineBefore: T0 })
  eq([r.state.groups[0].baseline, r.newGroups.length], [true, 0])
  const w = mergeScan(emptyLogWatch(), parseScan(scanOut(['2026-10-28T06:00:00.000Z INFO HikariPool-1 - Thread starvation'])).pods, { now: T0 + 600_000, baselineBefore: 0, words: ['HikariPool'] })
  eq(w.state.groups[0]?.level, 'error')
})

test('코드 점검 10-29 — 훑기 전체 제한 시간에 걸리면 cut, 읽은 파드는 그대로', () => {
  const p = parseScan(['@@QTCUT', '@@QTPOD ns a 0', '2026-10-28T05:52:51.000Z ERROR x', '@@QTEND'].join('\n'))
  eq([p.complete, p.cut, p.pods.length, p.pods[0].lines.length], [true, true, 1, 1])
  const cmd = buildScanCmd({ namespaces: ['ns'], sinceSec: 70 })
  ok(cmd.includes('mktemp -d') && cmd.includes('cat "$QT_D"/*'), '파드마다 파일에 쓰고 끝에 차례로')
  ok(cmd.includes('NotReady'), 'NotReady 노드 위 파드는 읽지 않음')
  ok(!/grep[^|]*-m /.test(cmd) && cmd.includes('tail -n 100'), '마지막 N줄')
})
