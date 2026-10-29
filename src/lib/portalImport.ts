/**
 * 포털 API 한꺼번에 가져오기 — 브라우저 개발자도구의 '모두 cURL 로 복사' 또는 HAR 파일에서 감시할 API 를 골라낸다.
 *
 * 왜: API 마다 cURL 붙여넣기 → 시험 → 조건 고르기 → 추가를 되풀이하면 20개에 손이 80번 간다(사용자 지적 10-28).
 * 화면 하나를 열고 그 화면이 부른 요청을 통째로 가져오면 한 번이다. 다만 통째로 넣으면 이미지 · 스크립트 · 분석 수집 ·
 * CORS 사전 요청까지 섞이므로 **감시할 만한 것만 미리 골라 두고**, 사람은 체크만 고친다.
 *
 * 토큰 · 쿠키는 저장하지 않는다(headersFromCurl 과 같은 규칙) — 감시할 때 로그인으로 새로 붙인다.
 */
import type { PortalCheck, PortalConfig, PortalTarget } from '../../electron/shared-types'
import { headersFromCurl, looksLikeErrorValue, parseCurl, pathFromUrl, suggestArrayPaths, suggestValueChecks } from './portal'

/** 붙여넣은 글 · HAR 에서 읽은 요청 하나 */
export interface RawRequest {
  method: string
  url: string
  headers: Record<string, string>
  body?: string
  /** HAR 에만 있다 — 브라우저가 받은 응답 */
  resp?: { status: number; mime?: string; text?: string }
  /** HAR 의 _resourceType (xhr · fetch · script · image …) — Chrome 만 넣는다 */
  resourceType?: string
}

/**
 * '모두 cURL 로 복사' 글을 요청마다 자른다. Chrome 은 bash 형식을 ` ;\n` 으로, cmd 형식을 ` &\r\n` 으로 잇는다.
 * 줄 맨 앞의 `curl ` 에서만 자른다 — 본문(JSON) 안의 'curl' 글자에서 자르지 않게.
 */
export function splitCurls(text: string): string[] {
  return (text ?? '')
    .split(/\r?\n(?=\s*curl\s)/i)
    .map((s) => s.trim().replace(/\s*[;&]\s*$/, '').trim())
    .filter((s) => /^curl\s/i.test(s))
}

export function parseCurlAll(text: string): { reqs: RawRequest[]; bad: number } {
  const parts = splitCurls(text)
  const reqs: RawRequest[] = []
  let bad = 0
  for (const p of parts) {
    const c = parseCurl(p)
    if (c) reqs.push({ method: c.method, url: c.url, headers: c.headers, body: c.body })
    else bad++
  }
  return { reqs, bad }
}

/** HAR(JSON) 에서 요청을 읽는다. 형식이 아니면 null */
export function parseHar(text: string): RawRequest[] | null {
  let j: unknown
  try {
    j = JSON.parse(text)
  } catch {
    return null
  }
  const entries = (j as { log?: { entries?: unknown[] } })?.log?.entries
  if (!Array.isArray(entries)) return null
  const out: RawRequest[] = []
  for (const e of entries as Record<string, any>[]) {
    const rq = e?.request
    if (!rq?.url || !rq?.method) continue
    const headers: Record<string, string> = {}
    for (const h of rq.headers ?? []) if (h?.name && !String(h.name).startsWith(':')) headers[h.name] = String(h.value ?? '')
    const rs = e.response
    out.push({
      method: String(rq.method).toUpperCase(),
      url: String(rq.url),
      headers,
      body: rq.postData?.text || undefined,
      resp: rs && typeof rs.status === 'number' ? { status: rs.status, mime: rs.content?.mimeType, text: rs.content?.text } : undefined,
      resourceType: typeof e._resourceType === 'string' ? e._resourceType : undefined,
    })
  }
  return out
}

export type SkipReason = '정적 파일' | '중복' | '사전 요청' | '외부 주소' | '이미 등록됨' | '화면 주소' | '변경 요청' | '로그인 요청'

export interface ImportCandidate {
  key: string
  method: PortalTarget['method']
  /** 실제로 부를 경로(쿼리 포함) — baseUrl 기준. 다른 호스트면 절대 주소 */
  path: string
  /** 묶어 보이는 경로 — id 자리를 {id} 로 */
  shape: string
  name: string
  headers?: Record<string, string>
  body?: string
  /** 처음에 체크해 둘지 */
  pick: boolean
  skip?: SkipReason
  /** 응답(HAR 에 있거나 일괄 시험으로 받은 것) */
  resp?: { status?: number; ms?: number; error?: string }
  /** 응답이 정상이라 미리 정한 기준 — 응답이 오류면 비운다 */
  expectStatus?: number[]
  checks?: PortalCheck[]
  /** 응답이 오류라 기준을 못 정함 */
  respBad?: boolean
  /** 오류로 본 까닭(예: `returnMessage = COMMON_BAD_REQUEST`) */
  respWhy?: string
  /** 처음에 체크하지 않은 까닭(POST 처럼 자동으로 부르면 안 되는 것) — 사람이 보고 고른다 */
  caution?: string
}

const STATIC_EXT = /\.(js|mjs|css|map|png|jpe?g|gif|svg|ico|webp|avif|woff2?|ttf|eot|otf|mp4|webm|html?|txt|json5?)$/i
const STATIC_MIME = /^(image|font|video|audio)\/|javascript|text\/css|text\/html/i
/**
 * 같은 API 인지 가르는 열쇠 — 경로 모양 + **쿼리**(쪽수 · 정렬 · 캐시 깨기 값만 뺀다). 처음엔 쿼리를 통째로 버려서
 * `/y?type=cpu` 와 `/y?type=mem` 처럼 다른 위젯을 부르는 두 요청 중 하나가 '중복' 으로 빠졌다(코드 점검 10-29).
 */
const NOISE_QUERY = /^(page|size|limit|offset|sort|order|_|t|ts|timestamp|nocache|cachebust)$/i
export function apiKey(method: string, pathOrUrl: string): string {
  const q = pathOrUrl.includes('?') ? pathOrUrl.slice(pathOrUrl.indexOf('?') + 1) : ''
  const kept = q
    .split('&')
    .map((kv) => kv.split('=')[0])
    .filter((k) => k && !NOISE_QUERY.test(decodeURIComponentSafe(k)))
    .sort()
  return `${method} ${pathShape(pathOrUrl)}${kept.length ? `?${kept.map((k) => `${k}=${new URLSearchParams(q).get(decodeURIComponentSafe(k)) ?? ''}`).join('&')}` : ''}`
}
const decodeURIComponentSafe = (s: string) => {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}
/** 로그인 · 토큰 · 인증 같은 요청 — 비밀번호를 본문에 싣고, 주기적으로 다시 부르면 계정이 잠길 수도 있다 */
const LOGIN_PATH = /(^|\/)(login|logout|signin|signout|sso|token|oauth|auth|mfa|otp|session)(\/|$|[-_?])/i

const ID_SEG = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d+|[0-9a-f]{16,})$/i
/**
 * 긴 토큰형 id(base64url 등). **숫자가 섞여야** id 로 본다 — 처음엔 길이(24자 이상)만 봤더니
 * `hypervisor-storage-backend` · `system-event-notification` 같은 긴 API 이름이 {id} 가 되어
 * 서로 다른 API 가 '중복' 으로 빠지고 이름도 '… 상세' 로 잘못 붙었다(10-29, 대시보드 9개 중 7개만 잡힘).
 */
const TOKEN_SEG = /^[A-Za-z0-9_-]{24,}$/

/** 경로의 id 자리(UUID · 숫자 · 긴 hex · 숫자 섞인 긴 토큰)를 {id} 로 — 같은 API 를 다른 id 로 여러 번 부른 것을 하나로 본다 */
export function pathShape(path: string): string {
  const [p] = path.split('?')
  return p
    .split('/')
    .map((seg) => (seg && (ID_SEG.test(seg) || (TOKEN_SEG.test(seg) && /\d/.test(seg))) ? '{id}' : seg))
    .join('/')
}

/** 경로에서 이름 후보 — 마지막 의미 있는 조각. id 로 끝나면 '… 상세' */
export function nameFromPath(path: string): string {
  const segs = pathShape(path).split('/').filter(Boolean)
  if (!segs.length) return '새 대상'
  const last = segs[segs.length - 1]
  if (last === '{id}') {
    const prev = segs.slice(0, -1).reverse().find((s) => s !== '{id}')
    return prev ? `${prev} 상세` : '상세'
  }
  return last
}

/**
 * 응답으로 정상 기준을 미리 정한다. 오류 응답이면 **정하지 않는다** — 오류를 정상 기준으로 삼으면 서버가 고쳐질수록
 * 빨개진다(looksLikeErrorValue 주석). 목록 응답이면 '항목 1개 이상' 을, 아니면 상태 코드만 본다.
 */
export function criteriaFrom(
  status: number | undefined,
  body: string | undefined,
  /** 요청 경로 — 이벤트 · 알람처럼 비어도 정상인 목록인지 가리는 데 쓴다 */
  path?: string,
): { expectStatus?: number[]; checks?: PortalCheck[]; bad: boolean; why?: string } {
  if (status == null || status < 200 || status >= 300) return { bad: true, why: status == null ? '응답 없음' : `HTTP ${status}` }
  const arr = suggestArrayPaths(body).filter((a) => a.count > 0)
  /*
   * 이벤트 · 알람 · 알림 · 이력 목록은 **평소에 비어 있는 게 정상**이다. 시험할 때 마침 항목이 있었다고 '항목 1개 이상' 을 걸면,
   * 문제가 없어 목록이 빈 순간 화면이 비정상이 된다 — 서버가 건강할수록 빨개진다(looksLikeErrorValue 와 같은 함정, 코드 점검 10-29:
   * 대시보드의 system-event-notification 이 그 꼴로 들어갔다). 그런 목록은 항목 수를 보지 않고 응답 코드 · 오류 문구만 본다.
   */
  // 낱말 단위로 본다(코드 검토 10-29) — 글자 일부로 보면 catalog · dialog 가 log 에, prevent 가 event 에 걸렸다. 작업 · 큐 목록도
  // 평소에 비는 게 정상이라 더했다(롤링 중 작업 목록이 비면 멀쩡한데 빨개진다)
  const emptyOk = (p: string) => pathWords(p).some((w) => EMPTY_OK_WORD.test(w))
  // 200 인데 본문이 오류 문구(예: returnMessage: COMMON_BAD_REQUEST)면 기준으로 쓰지 않는다. 목록이 있어도 먼저 본다 —
  // 예전엔 목록을 먼저 봐서 '오류 문구 + 목록' 응답에 기준이 붙었다.
  // 어느 값 때문인지 같이 돌려준다 — '200 인데 왜 오류냐' 를 사람이 본문을 열지 않고 판단하게(10-29 지적)
  const values = suggestValueChecks(body)
  const hit = values.find((v) => looksLikeErrorValue(v.value))
  if (hit) return { bad: true, why: `${hit.path} = ${hit.value}` }
  /*
   * 기준을 두 겹으로(사용자 요청 10-29: 'HTTP 200 만 · 항목 1개 이상 하나는 약해 보인다').
   *  ① 앱 상태 문구 — 이 포털은 문제가 있어도 HTTP 는 200 을 주고 본문에 returnMessage: COMMON_BAD_REQUEST 같은 문구를 넣는다.
   *     시험 응답의 정상 문구(success · COMMON_OK)를 '포함' 조건으로 건다. 숫자가 섞인 문구(건수 등)는 요청마다 달라 쓰지 않는다
   *  ② 내용 — 목록이면 항목 1개 이상(이벤트류 제외), 목록이 없으면 주요 값이 있는지(200 인데 data: null 인 빈 껍데기를 잡는다)
   * 개수 기준(3개 이상 등)은 넣지 않는다 — 노드를 내리면 정상인데도 개수가 줄 수 있다.
   */
  const checks: PortalCheck[] = []
  /*
   * 상태 문구는 **봉투(최상위) 값만** 본다. 예전엔 깊이 2까지 봐서 상세 API 의 data.status: ACTIVE(VM · 노드의 상태)가 '정상 문구' 가
   * 됐다 — 노드를 내리면 그 VM 이 evacuate 중 REBUILD 가 되어 포털은 멀쩡한데 화면이 빨갛고, 화면 복구 시각이 VM 복구 시각으로
   * 늦어진다(코드 검토 10-29). status 꼴 필드는 값도 정상 꼴(OK · SUCCESS 등)일 때만 — 봉투 없이 자원을 그대로 주는 API 도 있다.
   */
  const top = values.filter((v) => !v.path.includes('.') && !/\d/.test(v.value))
  const okMsg =
    top.find((v) => /(message|result)$/i.test(v.path)) ?? top.find((v) => /status$/i.test(v.path) && /^(ok|success|succeeded|true)$|_OK$|SUCCESS/i.test(v.value))
  if (okMsg) checks.push({ path: okMsg.path, op: 'contains', value: okMsg.value })
  const listOk = arr.filter((a) => !emptyOk(a.path))
  if (listOk.length && !emptyOk((path ?? '').split('?')[0])) checks.push({ path: listOk[0].path, op: 'nonEmptyArray' })
  else if (!arr.length) {
    const key = keyField(body)
    if (key) checks.push({ path: key, op: 'exists' })
  }
  return { expectStatus: [status], checks, bad: false }
}

/** 평소에 비어 있는 게 정상인 목록의 낱말(앞부분 일치 · log 만 통째로 — login 이 걸리지 않게) */
const EMPTY_OK_WORD = /^(event|alarm|alert|noti|histor|audit|logs?$|warn|error|fail|incident|message|task|job|migration|pending|queue)/
/** 경로를 낱말로 — '/', '.', '-', '_' 와 camelCase 경계에서 끊어 소문자로 */
export function pathWords(p: string): string[] {
  return p
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase())
}

/** 목록이 없는 응답의 주요 값 — data(없으면 최상위) 아래 첫 '이름 같은' 값. id · 시각 · 설명 · 경로 · 여부 값은 비어도 정상일 수 있어 뺀다 */
function keyField(body: string | undefined): string | null {
  let j: unknown
  try {
    j = JSON.parse(body ?? '')
  } catch {
    return null
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return null
  const root = j as Record<string, unknown>
  const data = root.data
  const [obj, prefix] = data && typeof data === 'object' && !Array.isArray(data) ? [data as Record<string, unknown>, 'data.'] : [root, '']
  const SKIP = /(^|_)id$|Id$|uuid|time|date|desc|path|yn$|Yn$|^return|message|status|code/i
  const prefer = Object.entries(obj).find(([k, v]) => /name|title/i.test(k) && typeof v === 'string' && v.trim())
  const any = Object.entries(obj).find(([k, v]) => !SKIP.test(k) && ((typeof v === 'string' && v.trim()) || typeof v === 'number'))
  const hit = prefer ?? any
  return hit ? `${prefix}${hit[0]}` : null
}

/** 받은 요청들을 감시 후보로 정리한다. 순서는 브라우저가 부른 순서 그대로 */
export function buildCandidates(reqs: RawRequest[], cfg: PortalConfig): ImportCandidate[] {
  let baseHost = ''
  try {
    baseHost = new URL(cfg.baseUrl.trim()).host
  } catch {
    // 포털 주소를 아직 안 넣었으면 가장 많이 부른 호스트를 포털로 본다
    const count = new Map<string, number>()
    for (const r of reqs) {
      try {
        const h = new URL(r.url).host
        count.set(h, (count.get(h) ?? 0) + 1)
      } catch {
        /* 무시 */
      }
    }
    baseHost = [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? ''
  }
  const have = new Set(cfg.targets.map((t) => apiKey(t.method, t.path)))
  const seen = new Set<string>()
  const out: ImportCandidate[] = []
  reqs.forEach((r, i) => {
    let u: URL | null = null
    try {
      u = new URL(r.url)
    } catch {
      return
    }
    /*
     * 방식 — GET · HEAD 는 그대로. PUT · PATCH · DELETE 는 감시로 되풀이하면 데이터를 바꾸므로 빼 둔다(예전엔 GET 으로 바꿔 넣어
     * 다른 요청이 됐다). POST 는 조회용(검색 · 목록)도 많아 넣을 수는 있게 두되 **처음엔 체크하지 않고 자동 시험도 하지 않는다** —
     * [정리하기] 한 번에 캡처한 재부팅 · 생성 요청이 바로 나가고, 추가하면 주기마다 되풀이됐다(코드 점검 10-29).
     */
    const write = ['PUT', 'PATCH', 'DELETE'].includes(r.method)
    const method = (['GET', 'POST', 'HEAD'].includes(r.method) ? r.method : r.method === 'OPTIONS' ? 'OPTIONS' : 'GET') as PortalTarget['method'] | 'OPTIONS'
    const path = pathFromUrl(cfg, r.url)
    const shape = pathShape(u.host === baseHost ? u.pathname : r.url)
    const key = apiKey(write ? r.method : method, u.host === baseHost ? u.pathname + u.search : r.url)
    let skip: SkipReason | undefined
    if (method === 'OPTIONS') skip = '사전 요청'
    else if (write) skip = '변경 요청'
    // 로그인 POST 만 뺀다(본문에 비밀번호) — GET 로그인 화면 경로(sso/login-route)는 감시 대상으로 쓸 수 있다
    else if (method === 'POST' && LOGIN_PATH.test(u.pathname)) skip = '로그인 요청'
    else if (baseHost && u.host !== baseHost) skip = '외부 주소'
    else if (
      STATIC_EXT.test(u.pathname) ||
      (r.resp?.mime && STATIC_MIME.test(r.resp.mime)) ||
      (r.resourceType && !['xhr', 'fetch'].includes(r.resourceType) && r.resourceType !== 'other')
    )
      skip = r.resourceType === 'document' || /text\/html/i.test(r.resp?.mime ?? '') ? '화면 주소' : '정적 파일'
    else if (have.has(key)) skip = '이미 등록됨'
    else if (seen.has(key)) skip = '중복'
    if (!skip) seen.add(key)
    const crit = r.resp ? criteriaFrom(r.resp.status, r.resp.text, u.pathname) : null
    const headers = headersFromCurl(r.headers)
    const caution = !skip && method === 'POST' ? 'POST 는 데이터를 바꾸는 요청일 수 있어 체크하지 않았습니다. 조회용이면 체크하세요' : undefined
    out.push({
      key: `${key}#${i}`,
      method: method === 'OPTIONS' ? 'GET' : method,
      path,
      shape,
      name: nameFromPath(u.pathname),
      headers: Object.keys(headers).length ? headers : undefined,
      body: method === 'POST' ? r.body : undefined,
      pick: !skip && !caution && !(crit?.bad ?? false),
      caution,
      skip,
      resp: r.resp ? { status: r.resp.status } : undefined,
      expectStatus: crit?.expectStatus,
      checks: crit?.checks,
      respBad: crit?.bad || undefined,
      respWhy: crit?.why,
    })
  })
  return out
}

/** 고른 후보를 감시 대상으로 — 화면 이름은 group 에 */
export function candidateToTarget(c: ImportCandidate, screen: string, id: string): PortalTarget {
  return {
    id,
    name: c.name,
    group: screen.trim() || undefined,
    enabled: true,
    method: c.method,
    path: c.path,
    headers: c.headers,
    body: c.body,
    auth: true,
    expectStatus: c.expectStatus?.length ? c.expectStatus : [200],
    checks: c.checks ?? [],
  }
}

/**
 * 설정 내보내기 — 팀원이 같은 화면 · API 목록을 다시 등록하지 않게. **비밀번호 · 토큰은 빼고** 내보낸다
 * (파일은 메신저 · 메일로 돌기 쉽다). 계정(아이디)도 사람마다 다르니 뺀다. 가져올 때 각자 넣는다.
 */
export function exportPortalConfig(cfg: PortalConfig): string {
  const auth = { ...cfg.auth } as Record<string, unknown>
  for (const k of ['username', 'password', 'token', 'otp', 'refreshToken']) delete auth[k]
  // 로그인 본문 틀에 OTP · 비밀번호를 글자로 박아 둔 경우(틀 칸 {{…}} 이 아닌 값)도 비운다
  for (const k of ['loginBody', 'mfaBody', 'refreshBody']) if (typeof auth[k] === 'string') auth[k] = scrubSecrets(auth[k] as string)
  // API 마다 붙인 헤더 중 토큰 · 세션 · 키처럼 보이는 것도 뺀다 — cURL 에서 Authorization · Cookie 는 이미 버리지만,
  // 포털이 쓰는 사내 헤더(X-Auth-Token 등)는 그대로 남아 있을 수 있다
  const targets = cfg.targets.map((t) => {
    // 본문(로그인 POST 의 비밀번호) · 쿼리(?access_token=) 의 비밀 값도 비운다 — 헤더 이름만 보면 이것들이 그대로 나갔다(코드 점검 10-29)
    const base = { ...t, path: scrubQuery(t.path), body: t.body ? scrubSecrets(t.body) : t.body }
    if (!t.headers) return base
    const headers = Object.fromEntries(Object.entries(t.headers).filter(([k]) => !SECRET_HEADER.test(k)))
    return { ...base, headers: Object.keys(headers).length ? headers : undefined }
  })
  return JSON.stringify({ kind: 'qterm-portal-watch', version: 1, config: { ...cfg, auth, targets } }, null, 2)
}
const SECRET_HEADER = /token|auth|session|secret|cookie|api[-_]?key|password/i
const SECRET_KEY = /pass(word|wd)?|pwd|secret|token|otp|credential|api[-_]?key|session/i
/** 틀 칸({{pw}})은 남기고 글자로 들어 있는 비밀 값만 비운다 */
const isTemplate = (v: unknown) => typeof v === 'string' && /^\{\{\w+\}\}$/.test(v.trim())
export function scrubSecrets(text: string): string {
  try {
    const j = JSON.parse(text)
    const walk = (v: unknown): unknown =>
      Array.isArray(v)
        ? v.map(walk)
        : v && typeof v === 'object'
          ? Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, SECRET_KEY.test(k) && typeof x !== 'object' && !isTemplate(x) ? '' : walk(x)]))
          : v
    return JSON.stringify(walk(j))
  } catch {
    // JSON 이 아니면 a=b&c=d 꼴 · "key":"value" 꼴(틀 칸이 섞여 JSON 이 아닌 경우)을 글자로
    return text
      .replace(/("([^"]*)"\s*:\s*)"([^"]*)"/g, (m, pre: string, k: string, v: string) => (SECRET_KEY.test(k) && !isTemplate(v) ? `${pre}""` : m))
      .replace(/(^|&)([^=&]+)=([^&]*)/g, (m, a: string, k: string) => (SECRET_KEY.test(k) ? `${a}${k}=` : m))
  }
}
function scrubQuery(path: string): string {
  const i = path.indexOf('?')
  if (i < 0) return path
  return path.slice(0, i + 1) + path.slice(i + 1).replace(/(^|&)([^=&]+)=([^&]*)/g, (m, a: string, k: string) => (SECRET_KEY.test(decodeURIComponentSafe(k)) ? `${a}${k}=` : m))
}

/**
 * 내보낸 파일 읽기 → 지금 설정에 **API 를 더한다**(같은 방식 · 경로는 건너뜀). 포털 주소 · 인증은 지금 것이 비어 있을 때만 채운다 —
 * 남의 파일이 내 계정 설정을 덮으면 안 된다.
 */
export function mergePortalConfig(cur: PortalConfig, text: string, newId: () => string): { next: PortalConfig; added: number; skipped: number } | null {
  let j: any
  try {
    j = JSON.parse(text)
  } catch {
    return null
  }
  const inc: PortalConfig | undefined = j?.kind === 'qterm-portal-watch' ? j.config : undefined
  if (!inc || !Array.isArray(inc.targets)) return null
  const have = new Set(cur.targets.map((t) => apiKey(t.method, t.path)))
  let added = 0
  let skipped = 0
  const targets = [...cur.targets]
  for (const t of inc.targets) {
    const k = apiKey(t.method, t.path ?? '')
    if (!t.path || have.has(k)) {
      skipped++
      continue
    }
    have.add(k)
    targets.push({ ...t, id: newId() })
    added++
  }
  const next: PortalConfig = {
    ...cur,
    baseUrl: cur.baseUrl.trim() ? cur.baseUrl : (inc.baseUrl ?? ''),
    auth: cur.auth.loginPath || cur.auth.username ? cur.auth : { ...cur.auth, ...inc.auth, password: cur.auth.password, token: cur.auth.token, otp: cur.auth.otp },
    targets,
  }
  return { next, added, skipped }
}
