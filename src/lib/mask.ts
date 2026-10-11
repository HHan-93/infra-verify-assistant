// 민감정보(비밀번호/토큰/키/IP) 자동 마스킹 공용 유틸.
//  - 로그 뷰어 표시, 검증 리포트 저장, AI(외부) 전송 텍스트에 공통 적용해
//    비밀번호·토큰·개인키가 화면/문서/외부로 새는 것을 방지한다.
//  - "값"만 가리고 키 이름(password= 등)은 남겨, 어떤 항목이 마스킹됐는지 맥락은 유지한다.
//
// 설계 원칙:
//  - 과도한 마스킹(멀쩡한 로그가 죄다 ●로 뒤덮임)을 피하려 "key=value / key: value" 형태의
//    민감 키에 한정하고, 그 외에는 명백한 시그니처(PEM 블록, Bearer 토큰)만 가린다.
//  - IP 마스킹은 기본 OFF (인프라 검증 로그에선 IP 자체가 확인 대상인 경우가 많음).

export interface MaskOptions {
  /** IP 주소(IPv4)도 마스킹할지 — 기본 false */
  ip?: boolean
}

const MASK = '••••••'

// 민감한 "키" 이름들 (password / token / secret / key 계열 + OpenStack/DB 관례).
// 대소문자 무시. key=value, key: value, key "value", --key value 모두 커버.
// 값을 가릴 "민감한 키" 이름들.
//  ⚠ 'auth' / 'pass' / 'connection' 같은 너무 흔한 단어는 제외했다 —
//    "pass: 45", "Connection: keep-alive", "auth = keystone" 같은 정상 로그가
//    마스킹돼 훼손되기 때문. (DB 접속문자열의 실제 비밀번호는 URL_CRED_RE 가 따로 가린다.)
const SECRET_KEYS = [
  'password', 'passwd', 'pwd',
  'secret', 'secret_key', 'secretkey',
  'token', 'access_token', 'auth_token', 'refresh_token', 'x-auth-token',
  'api_key', 'apikey', 'api-key',
  'authorization', 'credential', 'credentials',
  'private_key', 'privatekey',
  'admin_password', 'admin_pass', 'os_password', 'db_password', 'database_password',
  'rabbit_password', 'transport_url', 'password_hash',
  'memcache_secret_key', 'metadata_proxy_shared_secret', 'telemetry_secret',
  // 2026-10 점검에서 평문으로 나가던 것들:
  //  - kubeconfig 의 client-key-data(base64 로 감싼 개인키 전체) · Secret 의 tls.key · ssh-privatekey
  //  - aws_secret_access_key(`secret` 뒤에 `_access_key` 가 붙어 기존 규칙에 안 걸렸다) · passphrase · jwt
  //  - OpenStack 설치 가이드의 변수 관례 RABBIT_PASS · DEMO_PASS · NOVA_DBPASS — `_pass`/`dbpass` 로 끝나는 것만.
  //    `pass` 단독은 여전히 넣지 않는다(위 주석 — "pass: 45" 같은 정상 로그를 가린다)
  'client-key-data', 'tls.key', 'ssh-privatekey', 'secret_access_key', 'passphrase', 'jwt',
  '_pass', 'dbpass',
]

// key <구분자> value 형태에서 value 부분만 가린다.
//  구분자는 반드시 = 또는 : (앞뒤 공백 허용) — 공백만으로는 매칭하지 않는다.
//  (그렇지 않으면 "Connection refused", "auth failed" 처럼 흔한 단어 뒤의 일반 단어까지
//   가려져 멀쩡한 로그가 훼손된다. CLI 의 `--password value` 형태는 포기하는 대신 안전성 우선.)
//  값: 따옴표가 있으면 따옴표 안, 없으면 공백/콤마/세미콜론 전까지.
//  값: 따옴표로 감싼 경우 공백 포함 따옴표 안 전체, 아니면 공백/콤마/세미콜론 전까지.
//  (따옴표 값의 첫 토큰만 가리면 `password: "p@ss w0rd"` 에서 `w0rd` 가 새어나간다.)
const keyPattern = SECRET_KEYS.map((k) => k.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')).join('|')
//  키 **앞에 붙는 접두사**(`[a-z0-9_]*`)까지 한 덩어리로 본다.
//  (예전 `\b(password|...)` 는 `INIT_PASSWORD=...` 를 놓쳤다 — `_` 가 단어 문자라
//   `INIT_` 와 `PASSWORD` 사이에 단어 경계가 없다. 그래서 docker compose 의
//   `INIT_PASSWORD` · `MYSQL_ROOT_PASSWORD` 같은 환경변수가 리포트에 **평문으로** 남았다.
//   WireGuard 시나리오를 만들다 발견했다.)
//  접미사는 일부러 넣지 않았다 — `token_count=5` 같은 멀쩡한 값까지 가려 로그가 훼손된다.
//  꼭 필요한 것(`password_hash`)만 SECRET_KEYS 에 직접 적는다.
//  구분자 주변 공백은 **같은 줄 안으로** 묶는다(`[ \t]` — `\s` 가 아니다).
//  `\s` 는 줄바꿈까지 먹어서, YAML 의
//      secret:
//        secretName: my-tls
//  처럼 키만 있고 값이 다음 줄에 오는 자리에서 **다음 줄의 키 이름을 값으로 알고 가렸다.**
//  결과가 `•••••• my-tls` 였다 — 가려야 할 것(값)은 드러나고 남겨야 할 것(키)이 사라져,
//  이 파일이 세운 원칙과 정확히 반대로 동작했다. key=value 가 줄을 넘는 일은 없다.
//  키 **뒤의 닫는 따옴표**도 키에 붙여 본다 — JSON·파이썬 dict 의 `"password": "hunter2"`.
//  예전에는 키 바로 뒤에 `:` 가 와야 해서, 닫는 따옴표가 끼는 이 형태를 **하나도 못 잡았다.**
//  포털 API 응답·`openstack … -f json`·`kubectl -o json`·JSON 설정파일이 전부 이 모양이라,
//  입력창이 '가려서 보냅니다' 라고 말하는 동안 비밀번호가 AI 로 평문 전송되고 있었다.
//  따옴표는 키 쪽에 넣어 두어 치환 뒤에도 그대로 남는다(`"password": "••••••"`).
//  구분자에 `=>` 도 넣는다 — puppet/ruby hash 의 `"admin_password" => "hunter2"` 가 `=` 만 잡혀
//  `>` 를 값으로 가리고 진짜 값은 그대로 남겼다(`=•••••• "hunter2"`).
const KV_RE = new RegExp(
  `\\b([a-z0-9_]*(?:${keyPattern})["']?)([ \\t]*(?:=>|[:=])[ \\t]*)("[^"]*"|'[^']*'|[^'"\\s,;]+)`,
  'gi',
)

/**
 * OpenStack CLI 표 출력 `| password | hunter2 |` — 구분자가 `|` 라 KV 규칙에 안 걸렸다.
 * `openstack token issue` · `application credential create` 결과가 통째로 AI 로 나가던 자리다.
 * 첫 칸이 민감 키일 때 둘째 칸만 가린다(표 모양은 남긴다).
 */
const TABLE_ROW_RE = new RegExp(
  `^([ \\t]*\\|[ \\t]*[a-z0-9_]*(?:${keyPattern})[ \\t]*\\|[ \\t]*)([^|\\n]*?)([ \\t]*\\|)`,
  'gim',
)

/**
 * 쿠버네티스 env 의 두 줄 형태 — 값이 키 이름 줄이 아니라 다음 `value:` 줄에 있다.
 *   - name: DB_PASSWORD
 *     value: hunter2
 */
const K8S_ENV_RE = new RegExp(
  `(name:[ \\t]*["']?[a-z0-9_]*(?:${keyPattern})["']?[ \\t]*\\r?\\n[ \\t]*value:[ \\t]*)("[^"]*"|'[^']*'|\\S+)`,
  'gi',
)

/**
 * 키 이름 없이 값 모양만으로 알아보는 비밀.
 *  - Ceph keyring 의 `key = AQB…==` — `key` 를 키 이름에 넣으면 온갖 정상 로그가 가려지므로(ssh key,
 *    primary key …) 값 모양으로 잡는다. Ceph 비밀은 늘 `AQ` 로 시작하는 40자 base64 다.
 *  - Keystone Fernet 토큰 `gAAAAAB…` — `openstack token issue` 표의 `| id |` 칸에 들어 있다.
 */
const CEPH_KEY_RE = /\bAQ[A-Za-z0-9+/]{36,38}==/g
const FERNET_RE = /\bgAAAAAB[A-Za-z0-9_-]{40,}={0,2}/g

/**
 * 잘린 PEM 개인키 — BEGIN 과 END 가 둘 다 있어야 잡던 블록 규칙을 빠져나가는 경우.
 * 최근 200줄 창이 블록 가운데서 시작하거나(END 만 남음), `head` 로 앞부분만 찍었을 때(BEGIN 만 남음).
 */
const PEM_BEGIN_ONLY_RE = /(-----BEGIN [^-]*PRIVATE KEY-----)((?:\r?\n[A-Za-z0-9+/=]{16,})+)/g
const PEM_END_RE = /-----END [^-]*PRIVATE KEY-----/g
const B64_LINE_RE = /^[A-Za-z0-9+/=]{40,}$/

/**
 * END 만 남은 개인키 — END 줄에서 **거꾸로** 올라가며 base64 줄을 가린다.
 * 처음엔 정규식 `((?:^base64{40,}\n)+)END` 로 했는데, END 가 없는 긴 base64 덩어리(인증서 묶음
 * `cat ca-bundle.crt` 3,500줄)에서 줄마다 처음부터 다시 훑어 **8,000줄에 20초** 가 걸렸다 — 리포트
 * 저장·복사·AI 전송 때마다 화면이 멈췄다. END 줄이 있을 때만, 그 앞만 본다.
 */
function maskPemEndOnly(text: string): string {
  if (!text.includes('PRIVATE KEY-----')) return text
  const lines = text.split('\n')
  let changed = false
  for (let i = 0; i < lines.length; i++) {
    PEM_END_RE.lastIndex = 0
    if (!PEM_END_RE.test(lines[i])) continue
    let j = i - 1
    while (j >= 0 && B64_LINE_RE.test(lines[j].replace(/\r$/, ''))) j--
    if (j < i - 1) {
      lines.splice(j + 1, i - 1 - j, MASK)
      i = j + 2
      changed = true
    }
  }
  return changed ? lines.join('\n') : text
}

// transport_url 등 URL 안의 자격증명: scheme://user:PASSWORD@host
const URL_CRED_RE = /(\b[a-z][a-z0-9+.\-]*:\/\/[^:/\s]+:)([^@/\s]+)(@)/gi

// PEM 개인키 블록 전체
const PEM_RE = /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g

/**
 * `Authorization: Bearer <토큰>` 의 토큰.
 *
 * Basic·Digest 도 같이 본다 — Basic 은 user:pass 를 base64 로 담고 있어 그대로 풀린다.
 * base64 문자(+ / =)까지 값으로 센다.
 *
 * 규칙이 둘이다. 2.10.0 에서는 하나(`/\b(Bearer|Basic|Digest)\s+토큰/gi`)였는데, 문맥 없이
 * 대소문자를 무시해 **일반 문장의 다음 낱말을 가렸다** — `Running basic health checks` →
 * `basic •••••• checks`, `image digest sha256:…` → `digest ••••••:…`. 리포트와 AI 로 가는
 * 글이 훼손되고 '가림 N건' 도 부풀었다.
 *  - AUTH_HEADER_RE: `Authorization:` / `Proxy-Authorization:` 뒤라면 토큰 모양을 따지지 않고 가린다.
 *    헤더 문맥이 확실하므로 짧은 Basic 값(`dXNlcjpwYXNz` — 숫자가 없다)도 놓치면 안 된다.
 *  - AUTH_BARE_RE: 헤더 이름 없이 `Bearer <토큰>` 만 있는 자리(로그 줄·curl 조각). 이때는 **토큰처럼
 *    생긴 것만** — 16자 이상이고 숫자나 `. _ - + / =` 가 하나는 있어야 한다. JWT·Keystone 토큰은
 *    늘 이 조건을 넘고, `health`·`mismatch`·`token` 같은 낱말은 넘지 못한다. Digest 는 여기서 뺐다 —
 *    Digest 인증값은 `username="…"` 형태라 이 규칙으로는 어차피 못 가리고, 'image digest' 만 걸린다.
 */
const AUTH_SCHEME_WORDS = ['Bearer', 'Basic', 'Digest']
const AUTH_HEADER_RE = /\b((?:proxy-)?authorization["']?[ \t]*[:=][ \t]*["']?)(Bearer|Basic|Digest)([ \t]+)([A-Za-z0-9._\-+/=]+)/gi
const AUTH_BARE_RE = /\b(Bearer|Basic)(\s+)((?=[A-Za-z0-9._\-+/=]*[0-9._\-+/=])[A-Za-z0-9._\-+/=]{16,})/gi
/** KV 가 이 낱말을 '값' 으로 알고 가리지 않게 — 진짜 값은 바로 위에서 이미 가렸다 */
const AUTH_SCHEME_ONLY_RE = new RegExp(`^(${AUTH_SCHEME_WORDS.join('|')})$`, 'i')

// IPv4 (옵션)
const IPV4_RE = /\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g

/** 한 줄/블록 텍스트에서 민감정보를 마스킹한 새 문자열을 반환한다. */
export function maskSecrets(text: string, opts: MaskOptions = {}): string {
  if (!text) return text
  let out = text

  // 1) PEM 개인키 블록 통째로
  out = out.replace(PEM_RE, '-----BEGIN PRIVATE KEY-----\n' + MASK + '\n-----END PRIVATE KEY-----')
  out = out.replace(PEM_BEGIN_ONLY_RE, (_m, head) => `${head}\n${MASK}`)
  out = maskPemEndOnly(out)
  out = out.replace(CEPH_KEY_RE, MASK)
  out = out.replace(FERNET_RE, MASK)
  out = out.replace(TABLE_ROW_RE, (_m, head, _val, tail) => `${head}${MASK}${tail}`)
  out = out.replace(K8S_ENV_RE, (_m, head, val) => {
    const q = val[0]
    return q === '"' || q === "'" ? `${head}${q}${MASK}${q}` : `${head}${MASK}`
  })

  // 2) URL 내 자격증명 (password 부분만)
  out = out.replace(URL_CRED_RE, (_m, pre, _pw, at) => `${pre}${MASK}${at}`)

  /**
   * 3) 인증 헤더의 토큰 — **KV 보다 먼저** 가린다.
   *
   * 순서가 거꾸로였다. KV 가 `authorization` 을 먼저 잡아 값으로 `Bearer` 한 낱말만
   * 가리고 끝났고(`Authorization: •••••• eyJhbGciOi…`), 그러면 뒤에 오는 **진짜 토큰이
   * 그대로 남았다.** 게다가 `Bearer` 가 사라져 이 규칙도 더는 걸리지 않았다 —
   * 가장 흔한 형태의 토큰이 세 경로(화면·리포트·AI) 모두로 그대로 나가고 있었다.
   */
  out = out.replace(AUTH_HEADER_RE, (_m, head, scheme, sp) => `${head}${scheme}${sp}${MASK}`)
  out = out.replace(AUTH_BARE_RE, (_m, scheme, sp) => `${scheme}${sp}${MASK}`)

  // 4) key=value / key: value (따옴표로 감싼 값은 따옴표를 남기고 안쪽 전체를 가림)
  out = out.replace(KV_RE, (_m, key, sep, val) => {
    // `Authorization: Bearer ••••••` 의 `Bearer` — 인증 방식 이름이지 비밀이 아니다.
    // 키 이름을 남기는 것과 같은 이유로 남긴다(무엇이 가려졌는지 읽을 수 있어야 한다).
    if (AUTH_SCHEME_ONLY_RE.test(val)) return `${key}${sep}${val}`
    // 값이 `{` `[` 로 시작하면 비밀 자체가 아니라 그 아래 구조다 — Keystone 인증 JSON 의
    // `"password": {"user": …}` 를 가리면 구조가 깨지고(`"password": ••••••"user"`) 정작 안쪽 값은
    // 안쪽 규칙이 따로 가린다
    // 값 자리가 여는 괄호 **하나뿐**일 때만이다(값이 다음 칸에서 시작하는 구조). `password=[x]` 처럼
    // 괄호로 시작하는 평범한 값까지 넘기면 그게 샌다
    if (val === '{' || val === '[') return `${key}${sep}${val}`
    // 참·거짓·없음 같은 설정값은 비밀이 아니다 — `use_jwt=true` 를 가리면 설정이 안 읽힌다
    if (/^(true|false|yes|no|on|off|null|none)$/i.test(val)) return `${key}${sep}${val}`
    // 소문자 `…_pass` 에 숫자만 오면 카운터다(`tests_pass: 45`). 비밀번호 변수는 관례상 대문자
    // (RABBIT_PASS)이거나 숫자만으로 되어 있지 않다
    if (/_pass["']?$/.test(key) && /^\d+$/.test(val)) return `${key}${sep}${val}`
    const q = val[0]
    if ((q === '"' || q === "'") && val.length >= 2 && val[val.length - 1] === q) {
      return `${key}${sep}${q}${MASK}${q}`
    }
    return `${key}${sep}${MASK}`
  })

  // 5) IP (옵션) — 마지막 옥텟만 남기고 앞 3옥텟 마스킹 (형태는 유지)
  if (opts.ip) {
    out = out.replace(IPV4_RE, (_m, _a, _b, _c, d) => `•••.•••.•••.${d}`)
  }

  return out
}

/** 여러 줄 배열을 각각 마스킹 (로그 뷰어 라인 배열용) */
export function maskLines(lines: string[], opts: MaskOptions = {}): string[] {
  return lines.map((l) => maskSecrets(l, opts))
}

// ── 전역 설정 (localStorage) ─────────────────────────────────────────────
// prop 드릴링 없이 여러 컴포넌트가 공유하도록 localStorage 를 단일 소스로 사용.
//  - mask_secrets_report : 리포트 저장/AI 전송 시 마스킹 (기본 ON — 외부 유출 방지)
//  - mask_secrets_ip     : IP도 마스킹 (기본 OFF)
const REPORT_KEY = 'mask_secrets_report'
const IP_KEY = 'mask_secrets_ip'
const DISPLAY_KEY = 'mask_secrets_display'

// 설정값 캐시 — maskForDisplay 가 로그 줄마다(최대 5000줄×매 렌더) 호출되므로
// 매번 localStorage 를 읽지 않도록 캐시하고, set* 시에만 무효화한다.
let _flags: { report: boolean; display: boolean; ip: boolean } | null = null
function flags(): { report: boolean; display: boolean; ip: boolean } {
  if (_flags) return _flags
  _flags = {
    report: localStorage.getItem(REPORT_KEY) !== '0', // 기본 ON
    display: localStorage.getItem(DISPLAY_KEY) === '1', // 기본 OFF
    ip: localStorage.getItem(IP_KEY) === '1', // 기본 OFF
  }
  return _flags
}

export function maskDisplayEnabled(): boolean {
  return flags().display
}
export function setMaskDisplayEnabled(on: boolean): void {
  localStorage.setItem(DISPLAY_KEY, on ? '1' : '0')
  _flags = null
}
/** 로그 뷰어 표시용 — 화면 마스킹 설정 ON 시에만 마스킹 (IP는 별도 설정) */
export function maskForDisplay(text: string): string {
  const f = flags()
  if (!f.display) return text
  return maskSecrets(text, { ip: f.ip })
}

export function maskReportEnabled(): boolean {
  return flags().report
}
export function setMaskReportEnabled(on: boolean): void {
  localStorage.setItem(REPORT_KEY, on ? '1' : '0')
  _flags = null
}
export function maskIpEnabled(): boolean {
  return flags().ip
}
export function setMaskIpEnabled(on: boolean): void {
  localStorage.setItem(IP_KEY, on ? '1' : '0')
  _flags = null
}

/** 리포트/AI 전송용 — 설정이 켜져 있을 때만 마스킹 (IP는 별도 설정) */
export function maskForExport(text: string): string {
  const f = flags()
  if (!f.report) return text
  return maskSecrets(text, { ip: f.ip })
}

/**
 * **AI(외부 API) 로 나가는 텍스트** 마스킹.
 *
 * 스위치는 리포트 저장과 같은 것을 쓴다 — 설정 화면이 "리포트 저장·AI 전송 시 … 가리기" 라는
 * 한 줄로 약속하고 있기 때문이다. 이름을 따로 둔 이유는 호출부에서 **어느 경로가 외부로
 * 나가는지** 가 보여야 해서다(리포트는 내 디스크, 이쪽은 남의 서버).
 *
 * 화면(대화 기록)에는 원문을 그대로 둔다. 사용자가 자기가 붙여넣은 것을 못 알아보면 안 된다.
 */
export function maskForAI(text: string): string {
  return maskForExport(text)
}

/** 텍스트에 마스킹 대상이 하나라도 있는지 (배지/안내 표시용, 실제 치환은 하지 않음) */
export function hasSecrets(text: string): boolean {
  if (!text) return false
  // 전역(/g) 정규식은 .test() 가 lastIndex 를 전진시키므로 매 호출 초기화 (PEM 포함)
  KV_RE.lastIndex = 0
  URL_CRED_RE.lastIndex = 0
  AUTH_HEADER_RE.lastIndex = 0
  AUTH_BARE_RE.lastIndex = 0
  PEM_RE.lastIndex = 0
  return KV_RE.test(text) || URL_CRED_RE.test(text) || AUTH_HEADER_RE.test(text) || AUTH_BARE_RE.test(text) || PEM_RE.test(text)
}
