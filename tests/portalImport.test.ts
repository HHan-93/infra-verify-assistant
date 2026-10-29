// 포털 화면 묶음 · API 한꺼번에 가져오기(모두 cURL 로 복사 · HAR) · 설정 내보내기
import { test, eq, ok } from './harness'
import { applyObservation, emptyTargetState, screenObservation, screensOf, screenNeeded, normalizeConfig, type PortalTarget } from '../src/lib/portal'
import { splitCurls, parseCurlAll, parseHar, buildCandidates, pathShape, nameFromPath, criteriaFrom, exportPortalConfig, mergePortalConfig } from '../src/lib/portalImport'

const T = (p: Partial<PortalTarget>): PortalTarget => ({ id: p.name ?? 'x', name: 'x', enabled: true, method: 'GET', path: '/a', auth: true, ...p })
const cfg = (targets: PortalTarget[] = []) => ({ ...normalizeConfig(null), baseUrl: 'https://portal.example.com', targets })

test('화면 — 묶음이 없으면 대상 이름이 곧 화면(옛 설정은 API 하나 = 화면 하나)', () => {
  const s = screensOf([T({ name: '로그인' }), T({ name: '서버 목록', group: '인스턴스' }), T({ name: 'flavor', group: '인스턴스' })])
  eq(s.map((x) => [x.name, x.targets.length]), [['로그인', 1], ['인스턴스', 2]])
})

test('화면 — 부가 API 는 판정에서 빠지고, 전부 부가면 전부 핵심', () => {
  const s = screensOf([T({ name: 'a', group: 'S' }), T({ name: 'cpu', group: 'S', optional: true }), T({ name: 'z', group: 'Z', optional: true })])
  eq(s[0].core.map((t) => t.name), ['a'])
  eq(s[1].core.map((t) => t.name), ['z'])
  eq(screenNeeded(s[0], { ...cfg(), successStreak: 3 }), 3)
})

test('화면 관측 — 핵심 API 가 모두 정상이어야 정상, 사유에 어느 API 인지', () => {
  const o = screenObservation([
    { t: T({ name: '서버 목록' }), obs: { at: 1, ok: true, status: 200, latencyMs: 80, reasons: [] } },
    { t: T({ name: 'flavor' }), obs: { at: 2, ok: false, status: 503, latencyMs: 40, reasons: ['HTTP 503 (기대: 200)'] } },
  ])
  eq([o.ok, o.status, o.at, o.latencyMs], [false, 503, 2, 80])
  eq(o.reasons, ['flavor: HTTP 503 (기대: 200)'])
})

test('화면 관측에도 연속 N회 규칙 — 한 API 가 한 번 튀어도 화면이 다시 끊기지 않음', () => {
  let st = emptyTargetState()
  const ok1 = (at: number) => ({ at, ok: true, reasons: [] })
  const bad = (at: number) => ({ at, ok: false, reasons: ['x'] })
  for (const o of [bad(1), ok1(2), ok1(3), ok1(4)]) st = applyObservation(st, o, 3)
  eq(st.recoveredAt, 2)
  st = applyObservation(st, bad(5), 3)
  eq(st.recoveredAt, 2, '실패 한 번으로는 취소하지 않는다')
})

test('모두 cURL 로 복사 — bash · cmd 형식을 요청마다 자름, 본문 속 curl 글자에서는 안 자름', () => {
  const bash = `curl 'https://portal.example.com/api/v1/servers' -H 'accept: application/json' ;\ncurl 'https://portal.example.com/api/v1/search' --data-raw '{"q":"curl x"}' ;\n`
  eq(splitCurls(bash).length, 2)
  const cmd = `curl ^"https://portal.example.com/api/v1/a^" -H ^"accept: */*^" &\r\ncurl ^"https://portal.example.com/api/v1/b^"`
  eq(splitCurls(cmd).length, 2)
  const r = parseCurlAll(bash)
  eq([r.reqs.length, r.reqs[1].method, r.bad], [2, 'POST', 0])
})

test('경로 모양 · 이름 — id 자리는 {id}, id 로 끝나면 상세', () => {
  eq(pathShape('/api/v1/quotas/8f3a2c1e-1b2c-4d5e-8f90-123456789abc?x=1'), '/api/v1/quotas/{id}')
  eq(pathShape('/api/v1/servers/12345/ports'), '/api/v1/servers/{id}/ports')
  eq(nameFromPath('/api/v1/quotas/8f3a2c1e-1b2c-4d5e-8f90-123456789abc'), 'quotas 상세')
  eq(nameFromPath('/v1/contrabass/admin/compute/servers'), 'servers')
  // 긴 API 이름은 id 가 아님(대시보드 화면 9개 중 2개가 '중복' 으로 빠졌던 것)
  eq(pathShape('/v1/contrabass/admin/dashboard/compute/servers/hypervisor-storage-backend'), '/v1/contrabass/admin/dashboard/compute/servers/hypervisor-storage-backend')
  eq(nameFromPath('/v1/contrabass/admin/dashboard/system-event-notification'), 'system-event-notification')
  eq(pathShape('/api/v1/share/aB3dE5fG7hJ9kL1mN3pQ5rS7tU'), '/api/v1/share/{id}', '숫자 섞인 긴 토큰은 id')
})

test('기준 미리 정하기 — 목록이면 항목 1개 이상, 오류 응답이면 정하지 않음', () => {
  eq(criteriaFrom(200, '{"content":[{"id":1}]}'), { expectStatus: [200], checks: [{ path: 'content', op: 'nonEmptyArray' }], bad: false })
  eq(criteriaFrom(500, '{"error":"x"}').bad, true)
  eq(criteriaFrom(200, '{"returnCode":"9999","returnMessage":"COMMON_BAD_REQUEST"}').bad, true)
  eq(criteriaFrom(200, '{"returnMessage":"COMMON_BAD_REQUEST"}').why, 'returnMessage = COMMON_BAD_REQUEST', '왜 오류로 봤는지')
  eq(criteriaFrom(200, '{"total":3}'), { expectStatus: [200], checks: [{ path: 'total', op: 'exists' }], bad: false })
})

test('HAR — XHR 만 남기고 정적 · 사전 요청 · 외부 · 중복 · 이미 등록됨은 빼 둠, 쿠키 · 토큰 버림', () => {
  const e = (method: string, url: string, type: string, status = 200, mime = 'application/json', text = '{"data":[1]}') => ({
    request: { method, url, headers: [{ name: 'Authorization', value: 'Bearer x' }, { name: 'Cookie', value: 'a=b' }, { name: 'accept-language', value: 'ko' }, { name: ':authority', value: 'x' }] },
    response: { status, content: { mimeType: mime, text } },
    _resourceType: type,
  })
  const har = JSON.stringify({
    log: {
      entries: [
        e('GET', 'https://portal.example.com/main.js', 'script', 200, 'application/javascript', ''),
        e('OPTIONS', 'https://portal.example.com/api/v1/servers', 'preflight'),
        e('GET', 'https://portal.example.com/api/v1/servers?page=0', 'xhr'),
        e('GET', 'https://portal.example.com/api/v1/servers?page=1', 'xhr'),
        e('GET', 'https://collect.example.net/t', 'fetch'),
        e('GET', 'https://portal.example.com/api/v1/notice/count', 'fetch', 500, 'application/json', '{"error":"x"}'),
        e('GET', 'https://portal.example.com/api/v1/login-info', 'xhr'),
      ],
    },
  })
  const reqs = parseHar(har)
  ok(reqs, 'HAR 로 읽혀야 함')
  const c = buildCandidates(reqs!, cfg([T({ name: '로그인 정보', path: '/api/v1/login-info' })]))
  eq(c.map((x) => x.skip ?? (x.pick ? '고름' : '안 고름')), ['정적 파일', '사전 요청', '고름', '중복', '외부 주소', '안 고름', '이미 등록됨'])
  eq(c[2].headers, { 'accept-language': 'ko' })
  eq([c[2].path, c[2].checks], ['/api/v1/servers?page=0', [{ path: 'data', op: 'nonEmptyArray' }]])
  eq(c[5].respBad, true)
  eq(parseHar('not json'), null)
})

test('설정 내보내기 — 아이디 · 비밀번호 · 토큰 없이, 가져오면 API 만 더함(같은 것은 건너뜀)', () => {
  const src = { ...cfg([T({ name: 'a', path: '/api/a', headers: { 'X-Auth-Token': 'tok1', 'accept-language': 'ko' } }), T({ name: 'b', path: '/api/b' })]), auth: { ...normalizeConfig(null).auth, username: 'me', password: 'pw', token: 't' } }
  const text = exportPortalConfig(src)
  ok(!/"pw"|"me"|"t"|tok1/.test(text), '비밀 값이 들어가면 안 됨')
  ok(text.includes('accept-language'), '보통 헤더는 남김')
  const mine = { ...cfg([T({ name: 'a', path: '/api/a' })]), auth: { ...normalizeConfig(null).auth, username: 'you', password: 'mine' } }
  let n = 0
  const r = mergePortalConfig(mine, text, () => `n${n++}`)!
  eq([r.added, r.skipped, r.next.targets.length, r.next.auth.username, r.next.auth.password], [1, 1, 2, 'you', 'mine'])
  eq(mergePortalConfig(mine, '{"x":1}', () => 'z'), null)
})

test('코드 점검 10-29 — Chrome cmd 형식(^") · bash $\'…\' 본문을 읽음', () => {
  // Chrome escapeStringWin \uaf34 \uadf8\ub300\ub85c(String.raw \u2014 \ubc31\uc2ac\ub798\uc2dc\ub97c \uae00\uc790\ub85c)
  const cmd = String.raw`curl ^"https://portal.example.com/api/v1/a?x=1^" ^` + '\r\n' + String.raw`  -H ^"accept: */*^" ^` + '\r\n' + String.raw`  --data-raw ^"^{^\^"name^\^":^\^"it's^\^"^}^"`
  const r = parseCurlAll(cmd)
  eq([r.bad, r.reqs[0]?.url, r.reqs[0]?.headers['accept'], r.reqs[0]?.body], [0, 'https://portal.example.com/api/v1/a?x=1', '*/*', '{"name":"it\'s"}'])
  const bash = String.raw`curl 'https://portal.example.com/api/v1/b' -H 'content-type: application/json' --data-raw $'{"name":"it\'s","ko":"\ud55c"}'`
  eq(parseCurlAll(bash).reqs[0]?.body, '{"name":"it\'s","ko":"한"}')
  // 작은따옴표 안의 \ 는 글자 그대로(JSON 의 \" 를 지우지 않음)
  eq(parseCurlAll(`curl 'https://portal.example.com/c' --data-raw '{"a":"b\\"c"}'`).reqs[0]?.body, '{"a":"b\\"c"}')
})

test('코드 점검 10-29 — POST 는 체크하지 않고, PUT · DELETE · 로그인 POST 는 빼 둠, 쿼리가 다르면 다른 API', () => {
  const rq = (method: string, path: string) => ({ method, url: `https://portal.example.com${path}`, headers: {} })
  const c = buildCandidates([rq('GET', '/api/y?type=cpu'), rq('GET', '/api/y?type=mem&page=2'), rq('POST', '/api/search'), rq('DELETE', '/api/x/1'), rq('POST', '/api/token/issue'), rq('GET', '/api/sso/login-route')], cfg())
  eq(c.map((x) => x.skip ?? (x.pick ? '고름' : '안 고름')), ['고름', '고름', '안 고름', '변경 요청', '로그인 요청', '고름'])
  ok(!!c[2].caution, 'POST 는 까닭을 밝힘')
})

test('코드 점검 10-29 — 내보내기는 본문 · 쿼리 · 로그인 틀의 비밀 값도 비움(틀 칸은 남김)', () => {
  const src = {
    ...cfg([T({ name: 'login', method: 'POST', path: '/api/a?access_token=abc&size=10', body: '{"userId":"admin","password":"s3cr3t"}' })]),
    auth: { ...normalizeConfig(null).auth, loginBody: '{"userId":"{{id}}","password":"{{pw}}","otpCode":"123456"}' },
  }
  const text = exportPortalConfig(src)
  ok(!/s3cr3t|abc|123456/.test(text), '비밀 값이 남으면 안 됨')
  ok(text.includes('{{pw}}') && text.includes('size=10'), '틀 칸 · 보통 쿼리는 남김')
})

test('코드 점검 10-29 — 이벤트 · 알람 목록은 비어도 정상이라 항목 수를 걸지 않음 · 화면 끊김 시각은 먼저 실패한 API', () => {
  eq(criteriaFrom(200, '{"data":[{"id":1}]}', '/v1/contrabass/admin/dashboard/system-event-notification'), { expectStatus: [200], checks: [], bad: false })
  eq(criteriaFrom(200, '{"data":{"alarms":[1],"servers":[2]}}', '/api/summary').checks, [{ path: 'data.servers', op: 'nonEmptyArray' }])
  const o = screenObservation([
    { t: T({ name: 'a' }), obs: { at: 10, ok: false, reasons: ['x'] } },
    { t: T({ name: 'b' }), obs: { at: 30, ok: true, reasons: [] } },
  ])
  eq(o.at, 10)
})

test('10-29 사용자 확인 — 상태 숫자 1 은 오류가 아님(solution-info), HTTP 코드 꼴만 판단', () => {
  const body = '{"returnCode":"200","returnMessage":"success","data":{"id":"","name":"Contrabass","status":1,"externalYn":0},"status":null}'
  eq(criteriaFrom(200, body, '/v1/contrabass/admin/dashboard/solution-info'), {
    expectStatus: [200],
    checks: [
      { path: 'returnMessage', op: 'contains', value: 'success' },
      { path: 'data.name', op: 'exists' },
    ],
    bad: false,
  })
  // 목록 응답도 정상 문구를 함께 건다 · 오류 문구가 있으면 목록이 있어도 기준을 정하지 않는다
  eq(criteriaFrom(200, '{"returnMessage":"COMMON_OK","data":{"pools":[{"id":1}]}}', '/api/pools').checks, [
    { path: 'returnMessage', op: 'contains', value: 'COMMON_OK' },
    { path: 'data.pools', op: 'nonEmptyArray' },
  ])
  eq(criteriaFrom(200, '{"returnMessage":"COMMON_BAD_REQUEST","data":{"pools":[{"id":1}]}}', '/api/pools').bad, true)
  eq(criteriaFrom(200, '{"returnCode":"500","returnMessage":"x"}').bad, true)
})

test('코드 검토 10-29 — 자원의 상태값은 정상 문구로 안 씀 · 비어도 정상인 목록은 낱말 단위', () => {
  // 상세 API 의 data.status: ACTIVE 는 VM 상태라 evacuate 중 바뀐다 — 기준에 넣으면 포털이 멀쩡해도 빨개진다
  eq(criteriaFrom(200, '{"data":{"name":"vm1","status":"ACTIVE"}}', '/api/servers/1').checks, [{ path: 'data.name', op: 'exists' }])
  // 봉투의 정상 꼴 status 는 쓴다, 자원 꼴(ACTIVE)은 최상위여도 안 씀
  eq(criteriaFrom(200, '{"status":"SUCCESS","items":[1]}', '/api/x').checks[0], { path: 'status', op: 'contains', value: 'SUCCESS' })
  ok(!criteriaFrom(200, '{"status":"ACTIVE","name":"vm1"}', '/api/servers/1').checks.some((c) => c.path === 'status'))
  // catalog · dialog 는 log 가 아니다 → 항목 1개 이상을 건다
  eq(criteriaFrom(200, '{"data":[{"id":1}]}', '/api/service-catalog').checks, [{ path: 'data', op: 'nonEmptyArray' }])
  // 작업 · 큐 · camelCase 이벤트 목록은 비어도 정상
  eq(criteriaFrom(200, '{"data":[{"id":1}]}', '/api/tasks').checks, [])
  eq(criteriaFrom(200, '{"data":{"systemEvents":[1],"hosts":[2]}}', '/api/summary').checks, [{ path: 'data.hosts', op: 'nonEmptyArray' }])
  // login 은 log 가 아니다
  eq(criteriaFrom(200, '{"data":[{"id":1}]}', '/api/login-history-x').checks, [])
})
