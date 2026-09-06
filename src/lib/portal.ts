/**
 * 서비스 포털 응답 감시 — 판정 로직.
 *
 * UI 와 IPC 에서 완전히 분리해 둔다. "언제 복구됐다고 볼 것인가" 가 이 기능의 전부라
 * 그 판단만은 눈이 아니라 테스트로 확인할 수 있어야 한다.
 */
import type { PortalCheck, PortalConfig, PortalHttpResult, PortalTarget } from '../../electron/shared-types'

export type { PortalCheck, PortalConfig, PortalHttpResult, PortalTarget }

// ── JSON 경로 ─────────────────────────────────────────────────

/**
 * `content` · `data.items` · `rows[0].status` 형태의 경로로 값을 꺼낸다.
 * 경로가 비면 루트를 그대로 돌려준다.
 */
export function jsonAt(root: unknown, path: string): unknown {
  const p = (path ?? '').trim()
  if (!p) return root
  let cur: unknown = root
  // a.b[0].c → ['a','b','0','c']
  for (const seg of p.replace(/\[(\d+)\]/g, '.$1').split('.')) {
    if (!seg) continue
    if (cur === null || cur === undefined) return undefined
    if (Array.isArray(cur)) {
      const i = Number(seg)
      if (!Number.isInteger(i)) return undefined
      cur = cur[i]
    } else if (typeof cur === 'object') {
      cur = (cur as Record<string, unknown>)[seg]
    } else {
      return undefined
    }
  }
  return cur
}

/** 본문을 JSON 으로 읽어본다. 실패하면 null (HTML 응답 등) */
export function parseBody(body: string | undefined): unknown | null {
  const t = (body ?? '').trim()
  if (!t) return null
  if (t[0] !== '{' && t[0] !== '[') return null
  try {
    return JSON.parse(t)
  } catch {
    return null
  }
}

// ── 정상 조건 ─────────────────────────────────────────────────

/** 사람이 읽을 값 요약 — 실패 사유에 붙인다 */
function brief(v: unknown): string {
  if (v === undefined) return '(없음)'
  if (v === null) return 'null'
  if (Array.isArray(v)) return `배열 ${v.length}개`
  if (typeof v === 'object') return `객체 {${Object.keys(v as object).slice(0, 3).join(', ')}…}`
  const s = String(v)
  return s.length > 60 ? s.slice(0, 60) + '…' : s
}

/**
 * 조건 하나를 사람 말로 (설정 화면의 배지·요약, 실패 사유에서 같이 쓴다).
 *
 * `대상 · 조건` 형태로 적는다. 예전에는 `data 이(가) 1개 이상인 배열` 처럼 한 문장으로 썼는데
 *   · 경로가 영문이라 조사를 고를 수 없어 `이(가)` 를 그대로 노출해야 했고
 *   · `응답 본문 에` 처럼 띄어쓰기가 어긋났으며
 *   · 목록 배지에서 잘리면 무엇에 대한 조건인지부터 사라졌다.
 * 가운뎃점으로 끊으면 조사가 필요 없고, 앞부분(대상)이 먼저 읽힌다.
 */
export function describeCheck(c: PortalCheck): string {
  const where = c.path ? `${c.path}` : '응답 본문'
  switch (c.op) {
    case 'nonEmptyArray':
      return `${where} · 항목 1개 이상`
    case 'exists':
      return `${where} · 값 있음`
    case 'gte':
      return `${where} · ${c.value ?? 0} 이상`
    case 'contains':
      return `${where} · "${c.value ?? ''}" 포함`
    case 'notContains':
      return `${where} · "${c.value ?? ''}" 없음`
    case 'regex':
      return `${where} · 정규식 /${c.value ?? ''}/ 일치`
  }
}

function evalCheck(c: PortalCheck, json: unknown | null, rawBody: string): { ok: boolean; reason?: string } {
  // JSON 이 아니면 본문 문자열을 대상으로 본다 — 로그인 페이지 HTML 같은 대상도 감시할 수 있게.
  const target = json === null ? rawBody : jsonAt(json, c.path)
  const asText = typeof target === 'string' ? target : target === undefined ? '' : JSON.stringify(target)
  const fail = (why: string) => ({ ok: false, reason: `${describeCheck(c)} — ${why}` })

  switch (c.op) {
    case 'nonEmptyArray':
      if (!Array.isArray(target)) return fail(`배열이 아님 (${brief(target)})`)
      // 이게 이 기능의 핵심이다. 200 인데 빈 배열이 오는 구간이 반드시 있다 —
      // DB 는 붙었는데 nova 가 아직 인스턴스를 못 읽는 상태. 화면엔 "인스턴스 없음" 이 뜨고
      // 그건 복구가 아니다.
      return target.length > 0 ? { ok: true } : fail('비어 있음 (데이터가 아직 안 올라옴)')
    case 'exists':
      return target !== undefined && target !== null ? { ok: true } : fail('값 없음')
    case 'gte': {
      const n = Number(typeof target === 'string' ? target.trim() : target)
      const want = Number(c.value ?? 0)
      if (Number.isNaN(n)) return fail(`숫자로 읽을 수 없음 (${brief(target)})`)
      return n >= want ? { ok: true } : fail(`실제 ${n}`)
    }
    case 'contains':
      return asText.includes(c.value ?? '') ? { ok: true } : fail('없음')
    case 'notContains':
      return !asText.includes(c.value ?? '') ? { ok: true } : fail('발견됨')
    case 'regex': {
      let re: RegExp
      try {
        re = new RegExp(c.value ?? '')
      } catch {
        return fail('정규식이 올바르지 않음')
      }
      return re.test(asText) ? { ok: true } : fail('일치하지 않음')
    }
  }
}

/**
 * 오류 응답 본문에서 사람이 읽을 문구를 뽑는다.
 * 서버마다 담는 자리가 달라(Spring 은 error/message, 이 포털은 status/message) 흔한 자리를 훑는다.
 */
export function errorDetail(body: string | undefined): string {
  const json = parseBody(body)
  if (json && typeof json === 'object') {
    for (const k of ['message', 'error', 'error_description', 'detail', 'status']) {
      const v = (json as Record<string, unknown>)[k]
      if (typeof v === 'string' && v.trim() && v.trim().toUpperCase() !== 'OK') return v.trim()
    }
    // JSON 은 읽혔는데 쓸 만한 문구가 없다 → 원문을 그대로 붙이지 않는다.
    // (아래 평문 처리로 흘려보내면 JSON 한 줄이 통째로 사유에 박힌다)
    return ''
  }
  // JSON 이 아니면 첫 줄만 (HTML 오류 페이지가 통째로 들어오는 것을 막는다)
  const first = (body ?? '').trim().split('\n')[0]
  if (!first || /^\s*</.test(first)) return ''
  return first.length > 120 ? first.slice(0, 120) + '…' : first
}

export interface Judgement {
  ok: boolean
  /** 인증이 만료/거부된 상태 — 재로그인 후 한 번 더 시도할지 판단에 쓴다 */
  authExpired: boolean
  reasons: string[]
}

/**
 * 응답 하나를 정상/비정상으로 판정한다.
 * 상태 코드만 보지 않는 이유는 evalCheck 의 nonEmptyArray 주석 참고.
 */
export function judgeResponse(target: PortalTarget, r: PortalHttpResult, expiredBodyMatch?: string): Judgement {
  if (!r.ok) {
    return { ok: false, authExpired: false, reasons: [r.timedOut ? (r.error ?? '응답 시간 초과') : `요청 실패 — ${r.error ?? '알 수 없음'}`] }
  }
  const status = r.status ?? 0
  const want = target.expectStatus?.length ? target.expectStatus : [200]

  // 상태 코드보다 먼저 본다. 토큰이 죽었는데 HTTP 200 + 에러 봉투를 주는 포털이 있어서,
  // 여기서 안 잡으면 재발급이 안 돌고 전 구간이 비정상으로 남는다.
  const marker = expiredBodyMatch?.trim()
  if (marker && target.auth && (r.body ?? '').includes(marker)) {
    return { ok: false, authExpired: true, reasons: [`응답에 "${marker}" — 토큰이 유효하지 않습니다 (재발급 후 재시도)`] }
  }
  // 401/403 은 '포털이 죽었다' 와 원인이 다르다. 인증 서비스가 아직 안 떠서 토큰을 못 받는
  // 구간도 "아직 정상이 아니다" 의 일부이므로, 정상으로 세지는 않되 원인은 따로 표시한다.
  const authExpired = (status === 401 || status === 403) && !want.includes(status)
  if (!want.includes(status)) {
    // 서버가 남긴 오류 문구를 사유에 끌어올린다.
    // 감시 중에는 응답 본문이 화면에 안 보이므로, 여기 없으면 "HTTP 400" 만 남아
    // 무엇이 잘못됐는지 알 수 없다(설정을 고쳐야 하는 경우인지조차 구분이 안 된다).
    const detail = errorDetail(r.body)
    return {
      ok: false,
      authExpired,
      reasons: [
        (authExpired ? `HTTP ${status} — 인증 거부 (토큰 만료/인증 서비스 미기동)` : `HTTP ${status} (기대: ${want.join(', ')})`) +
          (detail ? ` — ${detail}` : ''),
      ],
    }
  }
  const checks = target.checks ?? []
  if (!checks.length) return { ok: true, authExpired: false, reasons: [] }

  const json = parseBody(r.body)

  /**
   * JSON 을 기대했는데 HTML 이 왔다 = 거의 항상 **API 가 아니라 페이지 주소**를 넣은 것이다.
   * 이게 이 기능에서 제일 흔한 설정 실수이고, 동시에 제일 위험하다:
   * SPA 껍데기는 백엔드가 전멸해도 200 으로 내려오므로, 조건을 안 걸어두면 "정상" 으로 찍힌다.
   * 조건에 걸려 실패로 나오더라도 사유가 "배열이 아님" 뿐이면 사람이 원인을 못 찾는다.
   */
  const isHtml = /^\s*(<!doctype html|<html[\s>])/i.test(r.body ?? '')
  const wantsJson = checks.some((c) => c.path.trim())
  if (isHtml && wantsJson) {
    return {
      ok: false,
      authExpired: false,
      reasons: [
        'JSON 이 아니라 HTML 페이지가 왔습니다 — 화면 주소가 아니라 그 화면이 부르는 API 주소를 넣으세요. ' +
          '(개발자도구 Network → Fetch/XHR 에 찍히는 요청의 경로)',
      ],
    }
  }

  const reasons: string[] = []
  for (const c of checks) {
    const v = evalCheck(c, json, r.body ?? '')
    if (!v.ok && v.reason) reasons.push(v.reason)
  }
  return { ok: reasons.length === 0, authExpired: false, reasons }
}

// ── 연속 성공 판정 ────────────────────────────────────────────

export interface TargetState {
  /** 지금까지 연속 몇 번 정상이었는지 (실패하면 0으로) */
  streak: number
  /** 연속 기준을 채워 '복구' 로 확정된 시각. 한 번 정해지면 바꾸지 않는다 */
  recoveredAt: number | null
  /** 이번 회차에 한 번이라도 비정상을 본 적이 있는지 */
  everFailed: boolean
  /** 마지막 관측 */
  last?: { at: number; ok: boolean; status?: number; latencyMs?: number; upstreamMs?: number; reasons: string[] }
  /** 최근 관측 이력 (막대 그래프용, 오래된 것부터) */
  recent: { at: number; ok: boolean }[]
}

export const emptyTargetState = (): TargetState => ({ streak: 0, recoveredAt: null, everFailed: false, recent: [] })

/**
 * 막대 그래프에 남길 최근 관측 수.
 *
 * 60 이었을 때는 1초 주기에서 **딱 1분**만 보였다. 화면이 금방 가득 차고 그때부터 왼쪽이
 * 잘려 나가서, 사용자 눈에는 "중간에서 끊긴다" 로 보인다. 페일오버 구간을 통째로 보려면
 * 몇 분은 남아 있어야 한다. 관측 하나가 { at, ok } 뿐이라 300개도 메모리 부담이 없다.
 */
export const RECENT_MAX = 300

export function streakNeeded(target: PortalTarget, cfg: PortalConfig): number {
  const n = target.successStreak ?? cfg.successStreak
  return Math.max(1, Math.floor(n || 1))
}

/**
 * 관측 한 건을 상태에 반영한다.
 *
 * 복구 시각을 '연속 N회를 채운 순간'이 아니라 **그 연속이 시작된 첫 성공 시각**으로 잡는다.
 * 사람이 알고 싶은 건 "언제부터 정상이었나" 이지 "언제 확신했나" 가 아니다.
 * (5초 주기 · 연속 3회면 확정 시점은 실제보다 10초 늦다 — 그대로 적으면 안 된다)
 */
export function applyObservation(
  prev: TargetState,
  obs: { at: number; ok: boolean; status?: number; latencyMs?: number; upstreamMs?: number; reasons: string[] },
  needed: number,
): TargetState {
  const streak = obs.ok ? prev.streak + 1 : 0
  const recent = [...prev.recent, { at: obs.at, ok: obs.ok }].slice(-RECENT_MAX)
  let recoveredAt = prev.recoveredAt
  if (recoveredAt === null && streak >= needed) {
    // 연속 구간의 첫 관측 시각을 되짚는다. 뒤에서부터 성공만 세어 needed 번째가 그 시작점.
    let seen = 0
    for (let i = recent.length - 1; i >= 0; i--) {
      if (!recent[i].ok) break
      seen++
      if (seen === needed) {
        recoveredAt = recent[i].at
        break
      }
    }
    if (recoveredAt === null) recoveredAt = obs.at // 이력이 잘린 경우의 안전값
  }
  return {
    streak,
    recoveredAt,
    everFailed: prev.everFailed || !obs.ok,
    last: obs,
    recent,
  }
}

/** 대상 하나의 표시 상태 */
export type TargetPhase = 'ok' | 'recovered' | 'fail' | 'waiting'

export function phaseOf(st: TargetState, needed: number): TargetPhase {
  if (!st.last) return 'waiting'
  if (!st.last.ok) return 'fail'
  if (st.streak >= needed) return st.everFailed ? 'recovered' : 'ok'
  return 'waiting' // 정상이지만 아직 연속 기준 미달
}

// ── 요청 조립 ─────────────────────────────────────────────────

/** baseUrl + path. path 가 http 로 시작하면 그대로 쓴다(다른 도메인도 감시할 수 있게) */
export function urlOf(cfg: PortalConfig, path: string): string {
  const p = (path ?? '').trim()
  if (/^https?:\/\//i.test(p)) return p
  const base = (cfg.baseUrl ?? '').trim().replace(/\/+$/, '')
  return base + (p.startsWith('/') ? p : '/' + p)
}

/**
 * 브라우저가 늘 붙여 보내는 출처 헤더.
 * 우리는 브라우저가 아니라 이게 빠지는데, 포털/게이트웨이에 따라 Origin·Referer 가 없는 요청을
 * 거부하거나 다르게 취급한다(스크린샷의 응답도 `Access-Control-Allow-Origin` 을 특정 출처로 준다).
 * 값이 포털 자기 자신이라 항상 동일 출처 — 붙여서 나빠질 일이 없다.
 */
export function originHeaders(cfg: PortalConfig): Record<string, string> {
  const base = (cfg.baseUrl ?? '').trim().replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(base)) return {}
  return { Origin: base, Referer: base + '/' }
}

/** 이 대상에 실어 보낼 헤더 (토큰 포함) */
export function headersFor(cfg: PortalConfig, t: PortalTarget, token: string): Record<string, string> {
  const h: Record<string, string> = {
    Accept: 'application/json, text/plain, */*',
    ...originHeaders(cfg),
    ...(t.headers ?? {}),
  }
  if (t.body && !Object.keys(h).some((k) => k.toLowerCase() === 'content-type')) {
    h['Content-Type'] = 'application/json'
  }
  if (t.auth && token) {
    const name = cfg.auth.header?.trim() || 'Authorization'
    const fmt = cfg.auth.headerFormat?.trim() || 'Bearer {token}'
    h[name] = fmt.replace('{token}', token)
    if (cfg.auth.cookieName?.trim()) {
      const c = `${cfg.auth.cookieName.trim()}=${token}`
      h['Cookie'] = h['Cookie'] ? `${h['Cookie']}; ${c}` : c
    }
  }
  return h
}

/** 로그인 본문 템플릿 채우기 — 값은 JSON 문자열로 안전하게 넣는다 */
export function fillLoginBody(tpl: string, id: string, pw: string): string {
  return fillTemplate(tpl, { id, pw })
}

/**
 * 본문 템플릿의 `{{이름}}` 을 값으로 바꾼다.
 *
 * 값은 **JSON 문자열 안에 들어갈 수 있게** 이스케이프한다 — 비밀번호에 따옴표나 역슬래시가
 * 들어 있으면 그대로 넣는 순간 본문이 JSON 이 아니게 된다(그러면 포털은 400 을 주고, 화면에는
 * "계정이 거부되었습니다" 로 보여 엉뚱한 데를 뒤지게 된다).
 *
 * 이름을 모르는 자리표시자는 **그대로 둔다.** 지우면 `{"otp":""}` 같은 그럴듯한 본문이
 * 만들어져 왜 거부되는지 알 수 없다 — 남아 있으면 화면에서 바로 눈에 띈다.
 */
export function fillTemplate(tpl: string, vars: Record<string, string | undefined>): string {
  const esc = (v: string) => JSON.stringify(v).slice(1, -1)
  return (tpl ?? '').replace(/\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g, (whole, key: string) => {
    const v = vars[key]
    return v === undefined ? whole : esc(v)
  })
}

/**
 * 1단계 응답의 Set-Cookie 를 2단계 요청에 실을 `Cookie` 헤더로 바꾼다.
 *
 * 2차 인증은 중간 토큰을 본문으로 주는 포털도 있고 **세션 쿠키로만 잇는 포털도** 있다.
 * 후자는 쿠키를 안 물려주면 2단계에서 "세션이 없습니다" 로 떨어진다. 속성(Path·Expires·
 * HttpOnly…)은 버리고 `이름=값` 만 남긴다 — 우리가 브라우저 노릇을 할 필요는 없다.
 */
export function cookieHeaderFrom(setCookies: string[] | undefined): string {
  const pairs: string[] = []
  const seen = new Set<string>()
  for (const line of setCookies ?? []) {
    const first = String(line).split(';')[0].trim()
    const eq = first.indexOf('=')
    if (eq <= 0) continue
    const name = first.slice(0, eq).trim()
    if (!name || seen.has(name)) continue
    seen.add(name)
    pairs.push(first)
  }
  return pairs.join('; ')
}

/**
 * 비밀번호가 프런트에서 암호화돼 나가는지 대충 가늠한다.
 * 사람이 실수하기 제일 쉬운 지점이라(평문인 줄 알고 계정/비번을 넣고 왜 안 되는지 헤맴)
 * 설정 화면에서 미리 짚어주기 위한 힌트 — 확정 판정이 아니다.
 */
export function looksEncrypted(value: string): boolean {
  const v = (value ?? '').trim()
  if (v.length < 24) return false
  // base64 스러운가 (길이가 4의 배수이고 base64 문자만)
  return /^[A-Za-z0-9+/]+={0,2}$/.test(v) && v.length % 4 === 0
}

/**
 * JWT 의 만료 시각(ms). 서명은 검증하지 않는다 — 우리는 '언제 죽는지'만 알면 된다.
 *
 * 토큰 수명이 짧은 포털에서는 이게 보이느냐 아니냐가 크다. 안 보이면 감시가 멈춘 뒤에야
 * 만료를 알게 되고, 그 구간은 '포털이 죽었던 것' 과 구분이 안 된다.
 */
export function jwtExpMs(token: string): number | null {
  const parts = (token ?? '').split('.')
  if (parts.length < 2) return null
  try {
    // base64url → base64
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const json = JSON.parse(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)))
    const exp = (json as { exp?: unknown }).exp
    return typeof exp === 'number' && exp > 0 ? exp * 1000 : null
  } catch {
    return null
  }
}

/**
 * 응답 본문에서 '배열인 자리'를 찾아 경로로 돌려준다.
 *
 * 목록 API 의 배열이 어디 담기는지는 포털마다 다르다(`content` · `data` · `data.items` …).
 * 조건 경로를 잘못 넣으면 "배열이 아님" 만 뜨고, 맞는 경로를 찾으려면 응답을 눈으로 뒤져야 한다.
 * 그 한 단계를 없앤다.
 */
export function suggestArrayPaths(body: string | undefined, maxDepth = 3): { path: string; count: number }[] {
  const root = parseBody(body)
  if (!root || typeof root !== 'object') return []
  const found: { path: string; count: number }[] = []
  const walk = (node: unknown, path: string, depth: number) => {
    if (found.length >= 8 || depth > maxDepth) return
    if (Array.isArray(node)) {
      found.push({ path: path || '(본문 전체)', count: node.length })
      return // 배열 안까지는 들어가지 않는다 — 항목마다 같은 경로가 쏟아진다
    }
    if (!node || typeof node !== 'object') return
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      walk(v, path ? `${path}.${k}` : k, depth + 1)
    }
  }
  walk(root, '', 0)
  return found.sort((a, b) => b.count - a.count)
}

/**
 * 응답에서 **'값' 조건으로 쓸 만한 자리**를 찾는다 — `returnMessage: "COMMON_OK"` 같은 것.
 *
 * 왜 필요한가: 목록 API 인 줄 알고 `항목 1개 이상` 을 걸었는데 그 목록이 **원래 0건일 수 있는**
 * 응답이 있다(시스템 이벤트 알림처럼). 그러면 장애가 아닌데 계속 비정상으로 찍힌다.
 * 이때 필요한 것은 "백엔드가 실제로 답을 만들었는가" 이고, 그 신호가 응답 봉투의 상태 문구다 —
 * 게이트웨이 오류 페이지나 SPA 껍데기에는 그 문구가 없다.
 *
 * 키 이름으로 고른다(값으로 고르면 우연히 비슷한 문자열을 집는다). 너무 긴 값은 버린다 —
 * 조건에 박아 두면 서버가 문구를 조금만 바꿔도 깨진다.
 */
export function suggestValueChecks(body: string | undefined, maxDepth = 2): { path: string; value: string }[] {
  const root = parseBody(body)
  if (!root || typeof root !== 'object') return []
  const KEY_RE = /(message|status|code|result|state)$/i
  const found: { path: string; value: string }[] = []
  const walk = (node: unknown, path: string, depth: number) => {
    if (found.length >= 4 || depth > maxDepth || !node || typeof node !== 'object' || Array.isArray(node)) return
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      const p = path ? `${path}.${k}` : k
      if ((typeof v === 'string' || typeof v === 'number') && KEY_RE.test(k)) {
        const val = String(v).trim()
        // 숫자만 있는 값(returnCode: "200")은 상태 코드 조건과 겹친다 — 문구 쪽을 우선한다
        if (val && val.length <= 40) found.push({ path: p, value: val })
      } else if (v && typeof v === 'object') {
        walk(v, p, depth + 1)
      }
    }
  }
  walk(root, '', 0)
  return found.sort((a, b) => Number(/^\d+$/.test(a.value)) - Number(/^\d+$/.test(b.value))).slice(0, 4)
}

/**
 * 지금 2차 인증을 쓰는 상태인가 — **판단은 한 곳에서만 한다.**
 *
 * 화면과 로그인 코드가 각자 판단하면 "화면에는 켜짐인데 로그인은 한 번만 보내는" 어긋남이
 * 생긴다. 규칙은 둘이다:
 *   · 스위치가 명시돼 있으면 그대로 따른다
 *   · 없으면(예전 설정) 경로가 채워졌는지로 본다 — 조용히 꺼지지 않게
 * 그리고 어느 쪽이든 **경로가 없으면 켤 수 없다** (보낼 곳이 없다).
 */
export function mfaEnabledOf(a: { mfaEnabled?: boolean; mfaPath?: string }): boolean {
  const path = !!a.mfaPath?.trim()
  return path && (a.mfaEnabled ?? true)
}

/**
 * 응답 JSON 안의 **문자열 값들이 어느 경로에 있는지** 훑어 준다.
 *
 * 토큰 위치를 잘못 적었을 때 "찾지 못했습니다" 로 끝내면, 사람이 개발자도구를 다시 열어
 * 응답을 뒤져야 한다. 그럴 필요 없이 **후보 경로를 그 자리에 적어 주는** 편이 낫다 —
 * 대개 그중 하나를 그대로 복사하면 끝난다. (suggestValueChecks 와 같은 발상)
 *
 * 값은 짧게 줄여 보여준다. 토큰 자체가 길기 때문에 그대로 붙이면 문구가 화면을 덮는다.
 */
export function suggestStringPaths(body: string | undefined, maxDepth = 3): { path: string; value: string }[] {
  const root = parseBody(body)
  if (!root || typeof root !== 'object') return []
  const found: { path: string; value: string }[] = []
  const walk = (node: unknown, path: string, depth: number) => {
    if (found.length >= 8 || depth > maxDepth || !node || typeof node !== 'object') return
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      const pth = path ? `${path}.${k}` : k
      if (typeof v === 'string' && v.trim()) {
        found.push({ path: pth, value: v.length > 28 ? v.slice(0, 28) + '…' : v })
      } else if (v && typeof v === 'object') {
        walk(v, pth, depth + 1)
      }
    }
  }
  walk(root, '', 0)
  return found.slice(0, 8)
}

// ── 브라우저 요청 그대로 가져오기 (cURL) ────────────────────────

/**
 * 개발자도구의 `Copy as cURL` 결과를 잘라 읽는다.
 *
 * 왜 필요한가: 브라우저에서는 200 인데 우리가 보내면 400 이 나는 일이 생긴다. 원인은 대개
 * 눈에 안 보이는 헤더 하나다. 그걸 하나씩 짚어 맞추는 건 답이 없어서, 브라우저가 실제로 보낸
 * 요청을 통째로 가져오는 쪽이 확실하다.
 *
 * bash 형식(작은따옴표 · `\` 줄바꿈)과 Windows cmd 형식(큰따옴표 · `^` 줄바꿈)을 모두 받는다.
 */
export function parseCurl(text: string): { url: string; method: string; headers: Record<string, string>; body?: string } | null {
  const src = (text ?? '')
    .replace(/\\\r?\n/g, ' ') // bash 줄바꿈
    .replace(/\^\r?\n/g, ' ') // cmd 줄바꿈
    .trim()
  if (!/^curl\b/i.test(src)) return null

  // 따옴표를 존중하며 토큰으로 자른다
  const tokens: string[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++
      continue
    }
    if (c === "'" || c === '"') {
      const quote = c
      let out = ''
      i++
      while (i < src.length && src[i] !== quote) {
        // cmd 형식은 큰따옴표 안의 `""` 를 escape 로 쓴다
        if (quote === '"' && src[i] === '"' && src[i + 1] === '"') {
          out += '"'
          i += 2
          continue
        }
        if (src[i] === '\\' && i + 1 < src.length) {
          out += src[i + 1]
          i += 2
          continue
        }
        out += src[i++]
      }
      i++ // 닫는 따옴표
      tokens.push(out)
      continue
    }
    let out = ''
    while (i < src.length && !/\s/.test(src[i])) out += src[i++]
    tokens.push(out)
  }

  let url = ''
  let method = ''
  let body: string | undefined
  const headers: Record<string, string> = {}
  for (let t = 1; t < tokens.length; t++) {
    const tok = tokens[t]
    if (tok === '-H' || tok === '--header') {
      const h = tokens[++t] ?? ''
      const idx = h.indexOf(':')
      if (idx > 0) {
        const name = h.slice(0, idx).trim()
        // HTTP/2 의사 헤더(:authority 등)는 우리가 보낼 수 없다
        if (!name.startsWith(':')) headers[name] = h.slice(idx + 1).trim()
      }
      continue
    }
    if (tok === '-X' || tok === '--request') {
      method = (tokens[++t] ?? '').toUpperCase()
      continue
    }
    if (tok === '-d' || tok === '--data' || tok === '--data-raw' || tok === '--data-binary') {
      body = tokens[++t] ?? ''
      continue
    }
    if (tok === '-b' || tok === '--cookie') {
      headers['Cookie'] = tokens[++t] ?? ''
      continue
    }
    // 값이 따라오지만 우리가 쓰지 않는 옵션들은 값까지 건너뛴다
    if (['-A', '--user-agent', '-e', '--referer', '-u', '--user', '--max-time', '--connect-timeout'].includes(tok)) {
      const v = tokens[++t] ?? ''
      if (tok === '-A' || tok === '--user-agent') headers['User-Agent'] = v
      if (tok === '-e' || tok === '--referer') headers['Referer'] = v
      continue
    }
    if (tok.startsWith('-')) continue // --compressed, --insecure 등 값 없는 옵션
    if (!url && /^https?:\/\//i.test(tok)) url = tok
  }
  if (!url) return null
  return { url, method: method || (body ? 'POST' : 'GET'), headers, body }
}

/**
 * cURL 에서 읽은 헤더 중 **감시 대상에 저장하면 안 되는 것**들.
 * 토큰·쿠키는 우리가 매번 새로 붙이므로, 붙여넣기 시점의 값을 굳혀두면 곧 만료돼 401 이 된다.
 * 나머지(Accept-Language, X-Requested-With, 사내 커스텀 헤더 등)는 그대로 살린다 —
 * 브라우저에서만 되고 우리가 하면 안 되는 원인이 대개 그쪽에 있다.
 */
const CURL_DROP = new Set([
  'authorization',
  'cookie',
  'host',
  // Origin/Referer 는 **포털 주소에서 계산**한다. cURL 시점의 값을 굳혀두면
  // 다른 환경(도메인만 다른 같은 포털)으로 옮겼을 때 옛 도메인이 그대로 나가 거부된다.
  // 대상 헤더가 계산값을 덮어쓰는 구조라 특히 위험하다.
  'origin',
  'referer',
  'content-length',
  'accept-encoding', // 압축 협상은 우리 쪽에서 하지 않는다
  'connection',
  'sec-fetch-dest',
  'sec-fetch-mode',
  'sec-fetch-site',
  'sec-fetch-user',
  'priority',
])

export function headersFromCurl(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) {
    if (!CURL_DROP.has(k.toLowerCase())) out[k] = v
  }
  return out
}

/** 절대 URL 을 baseUrl 기준 경로로 (같은 호스트면 경로만, 아니면 절대 주소 그대로) */
export function pathFromUrl(cfg: PortalConfig, absUrl: string): string {
  try {
    const u = new URL(absUrl)
    const base = new URL((cfg.baseUrl ?? '').trim() || 'https://x.invalid')
    if (u.host === base.host) return u.pathname + u.search
    return absUrl
  } catch {
    return absUrl
  }
}

// ── 기본 설정 ─────────────────────────────────────────────────

let seq = 0
export const newTargetId = () => `pt${Date.now().toString(36)}${(seq++).toString(36)}`

/**
 * 기본값 — CONTRABASS 포털 기준으로 채워 두되 전부 화면에서 고칠 수 있다.
 * 도메인·경로·정상조건 어느 것도 코드에 박아두지 않는다.
 */
export function defaultPortalConfig(): PortalConfig {
  const t = (
    name: string,
    group: string,
    path: string,
    checks: PortalCheck[],
    extra: Partial<PortalTarget> = {},
  ): PortalTarget => ({
    id: newTargetId(),
    name,
    group,
    enabled: true,
    method: 'GET',
    path,
    auth: true,
    expectStatus: [200],
    checks,
    ...extra,
  })
  return {
    baseUrl: '',
    insecureTLS: true,
    auth: {
      // 아이디/비밀번호 로그인. 만료돼도 그 자리에서 다시 받아오므로 긴 검증에서 끊기지 않는다.
      // 비밀번호를 프런트가 암호화해 보내는 포털이라면, 개발자도구 Payload 의 암호문을
      // 그대로 붙여넣으면 된다 — AES-CBC 는 IV 를 암호문에 동봉하므로 재사용이 통한다.
      mode: 'login',
      // CONTRABASS 포털이 2차 인증으로 바뀌었다(2026-09). 로그인은 이제 세션만 열고,
      // 이메일로 온 인증번호를 확인해야 토큰이 나온다 — 그래서 요청이 두 번이다.
      //   1) /mfa/session  {userId, password}          → data.sessionUuid
      //   2) /mfa/issue    {otpCode, otpSessionUuid}   → data.accessToken
      // 예전 /token/issue 한 방 경로는 더 이상 토큰을 주지 않는다.
      //
      // **이름이 양쪽에서 다르다** — 1단계가 돌려주는 칸은 `sessionUuid` 인데, 2단계가
      // 받는 칸은 `otpSessionUuid` 다. 받은 곳의 이름으로 짐작해 적으면 틀린다(실제로
      // otpSessionUuid 로 적어 두었다가 "찾지 못했습니다" 를 만났다). 응답 기준으로 적는다.
      loginPath: '/v1/bootfactory/api/mfa/session',
      loginBody: '{"userId":"{{id}}","password":"{{pw}}"}',
      username: '',
      password: '',
      mfaEnabled: true,
      mfaPath: '/v1/bootfactory/api/mfa/issue',
      mfaTokenPath: 'data.sessionUuid',
      mfaBody: '{"otpCode":"{{otp}}","otpSessionUuid":"{{mfaToken}}"}',
      otp: '',
      tokenPath: 'data.accessToken',
      header: 'Authorization',
      headerFormat: 'Bearer {token}',
      cookieName: 'accessToken',
      // 수명이 11분이라 6분 남았을 때 미리 갈아끼운다 — 만료를 겪지 않는다.
      reissueMinutes: 6,
      expiredBodyMatch: 'TOKEN_NOT_VERIFY',
    },
    intervalSec: 5,
    timeoutMs: 10000,
    successStreak: 3,
    targets: [
      // 로그인 페이지는 토큰 없이도 떠야 한다 — 인증 서비스가 살았는지 보는 첫 신호.
      t('로그인 페이지', '로그인', '/', [{ path: '', op: 'notContains', value: '502 Bad Gateway' }], {
        auth: false,
        note: '정적 페이지라 백엔드가 죽어도 200 이 온다 — 이것만으로 복구를 판단하면 안 된다',
      }),
      t('인스턴스 목록', '인스턴스 목록', '/v1/contrabass/admin/compute/servers?size=1&page=0', [
        { path: 'content', op: 'nonEmptyArray' },
      ]),
      t('인스턴스 상세', '인스턴스 상세', '/v1/contrabass/admin/compute/servers?size=1&page=0', [
        { path: 'content', op: 'nonEmptyArray' },
      ]),
      t('모니터링 차트', '인스턴스 상세', '', [], {
        enabled: false,
        note: '개발자도구 Network 에서 차트가 부르는 요청을 확인해 경로를 채우세요. Prometheus/Thanos 계열이면 스크랩 주기만큼 늦게 복구되는 게 정상입니다',
      }),
      t('대시보드', '대시보드', '', [], {
        enabled: false,
        note: '개발자도구 Network 에서 대시보드 요약 API 경로를 확인해 채우세요',
      }),
    ],
  }
}

/** 저장된 설정을 읽을 때 빠진 필드를 메운다 (버전 올라가며 필드가 늘어도 깨지지 않게) */
export function normalizeConfig(raw: Partial<PortalConfig> | null): PortalConfig {
  const d = defaultPortalConfig()
  if (!raw) return d
  const auth = { ...d.auth, ...(raw.auth ?? {}) }
  // 없어진 방식(로그인 창·refresh token 재발급)으로 저장돼 있으면 로그인 모드로 되돌린다.
  // 안 그러면 드롭다운이 빈 값으로 뜨고 인증이 조용히 멈춘다.
  if (auth.mode !== 'login' && auth.mode !== 'token' && auth.mode !== 'none') auth.mode = 'login'
  return {
    baseUrl: raw.baseUrl ?? d.baseUrl,
    insecureTLS: raw.insecureTLS ?? d.insecureTLS,
    auth,
    intervalSec: Math.max(1, raw.intervalSec ?? d.intervalSec),
    timeoutMs: Math.max(1000, raw.timeoutMs ?? d.timeoutMs),
    successStreak: Math.max(1, raw.successStreak ?? d.successStreak),
    targets: (raw.targets ?? d.targets).map((t) => ({
      ...t,
      id: t.id || newTargetId(),
      enabled: t.enabled !== false,
      method: t.method ?? 'GET',
      auth: t.auth !== false,
      expectStatus: t.expectStatus?.length ? t.expectStatus : [200],
      checks: t.checks ?? [],
    })),
  }
}
