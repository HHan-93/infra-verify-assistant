/**
 * 파드 로그 이상 감시(사용자 요청 10-28) — 판정 로직.
 *
 * 왜: 파드 표가 전부 Running 인데도 서비스가 깨져 있는 경우가 있다. 10-28 contrabass03 DOWN 때 boot-factory 6/6 Running 인데
 * 로그에는 `Cannot reconnect to [valkey-cluster-0.valkey-cluster.dataplatform…]` 가 5초마다 찍혔다(원인은 DNS 무응답).
 * 네임스페이스마다 파드가 수십 개라 사람이 어느 로그를 볼지 모른다 — 보드가 1분마다 훑어 **새로 생긴 오류**만 짚는다.
 *
 * 방식: kubectl 서버에서 파드마다 최근 N초 로그를 받아 오류 단어로 거른 줄만 가져온다(stern · Loki 에 기대지 않는다 —
 * epoxy 환경엔 둘 다 없다). 같은 오류는 '서명'(시각 · 숫자 · IP · id 를 지운 문장)으로 묶어 센다.
 * '평소에도 나는 오류' 는 감시를 켠 뒤 처음 몇 분을 기준선으로 떠서 걸러 낸다 — 늘 WARN 을 찍는 앱 때문에 화면이 빨개지면 안 된다.
 */

/** grep -E -i 패턴. **작은따옴표를 넣지 말 것** — 셸 변수에 작은따옴표로 담는다 */
export const LOG_PATTERN = [
  '\\b(error|fatal|critical|severe|panic|warn|warning)\\b',
  'exception',
  'caused by',
  'traceback',
  'timed? ?out',
  'refused',
  'unreachable',
  'no route to host',
  'connection reset',
  'failed to resolve',
  'unknownhost',
  'could not resolve',
  'oomkilled',
  'out of memory',
  '^[EWF][0-9]{4} ', // klog: E1028 12:00:00.000000 …
].join('|')

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
const ereEscape = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export interface ScanCmdOpts {
  namespaces: string[]
  sinceSec: number
  /** 재시작한 파드 — 죽기 직전 컨테이너 로그(--previous)도 본다(CrashLoop 의 이유는 거기 있다) */
  prev?: { ns: string; pod: string }[]
  /** 사용자가 더한 단어(글자 그대로 찾는다) */
  extraWords?: string[]
  perPod?: number
  parallel?: number
}

/** 파드 하나 · 훑기 전체의 제한 시간(초). 전체는 session:run 의 60초 강제 종료(EXEC_HARD_MS)보다 짧아야 끝 표시(@@QTEND)가 온다 */
export const SCAN_POD_SEC = 12
export const SCAN_ALL_SEC = 40

/**
 * 한 번 훑는 명령. Running 파드만(Pending 은 로그가 없다). 파드마다 `@@QTPOD ns pod rc` 머리줄을 찍고 걸러진 줄을 잇는다.
 * kubectl logs 가 실패하면(노드가 죽어 kubelet 에 못 붙는 등) **걸러 보지 않는다** — 'error dialing backend' 같은 kubectl 오류 문구가
 * 앱의 오류로 잡히면 안 된다(조회 실패 ≠ 장애). 대신 `@@QTERR` 로 사유 한 줄만 남긴다.
 *
 * 코드 점검(10-29)으로 고친 것 — 다시 되돌리지 말 것:
 *  - **파드마다 임시 파일에 쓰고 끝에 차례로 cat 한다.** 처음엔 xargs -P 의 자식들이 같은 파이프에 바로 썼는데, 머리줄 · 줄 · @@QTERR 가
 *    각각 따로 쓰여 다른 파드의 것과 섞였다(B 머리줄 뒤에 A 의 줄이 붙어 B 의 오류로 잡힘, cut 의 블록 출력은 줄 가운데서도 섞임).
 *  - **NotReady 노드 위 파드는 읽지 않는다.** 그 파드도 phase 는 Running 이라 목록에 들어오는데, kubectl logs 가 kubelet 에 못 붙어
 *    제한 시간까지 걸렸다. 그런 파드가 열 몇 개면 훑기 전체가 60초(exec 강제 종료)를 넘겨 **노드가 죽어 있는 동안 내내** 훑기가
 *    실패했다 — 이 기능이 있어야 할 바로 그 구간이다. '노드 NotReady' 로 조회 불가에 넣는다.
 *  - 파드 하나 12초 · 전체 40초. 전체가 끊기면 @@QTCUT 을 남기고 읽은 것까지는 쓴다.
 *  - --previous 도 같은 병렬 목록에 넣는다(예전엔 끝에 하나씩 차례로 돌아 시간을 더 먹었다).
 *  - `grep -m N`(처음 N줄) 대신 `tail -n N`(마지막 N줄) — 시끄러운 파드는 오래된 줄 · INFO 잡음이 몫을 채워 구간 끝의 새 오류가 잘렸다.
 *  - **kubectl 의 stderr 는 로그와 섞지 않는다**(`2>"$QT_D/e/…"`, 실패했을 때 사유로만 읽는다. 하위 폴더라 끝의 `cat "$QT_D"/*` 에 섞이지 않는다). 처음엔 `2>&1` 이었는데, 노드가 죽어
 *    metrics-server 같은 aggregated API 가 사라지면 kubectl 이 `E1029 … memcache.go] couldn't get resource list` 를 stderr 에 찍고도
 *    rc 0 으로 끝난다. 그 줄이 klog 오류 꼴이라 워크로드마다 가짜 '검증 뒤 새 오류' 가 됐다(코드 검토 10-29).
 */
export function buildScanCmd(o: ScanCmdOpts): string {
  const pat = [LOG_PATTERN, ...(o.extraWords ?? []).filter((w) => w.trim()).map((w) => ereEscape(w.trim()))].join('|')
  const per = Math.max(10, o.perPod ?? 100)
  const par = Math.max(1, o.parallel ?? 6)
  const since = Math.max(10, Math.round(o.sinceSec))
  const nss = o.namespaces.map(shq).join(' ')
  // $0 ns · $1 pod · $2 cur|prev. 파드 이름은 DNS-1123 이라 '__' 가 없다 — 파일 이름 구분자로 쓴다
  const one =
    `f="$QT_D/$0__$1__$2"; ` +
    `if [ "$2" = prev ]; then { echo "@@QTPREV $0 $1"; timeout ${SCAN_POD_SEC} kubectl logs -n "$0" "$1" --all-containers --previous --timestamps --tail=300 2>/dev/null | grep -E -i -e "$QT_PAT" | tail -n ${per} | cut -c1-800; } > "$f"; exit 0; fi; ` +
    `out=$(timeout ${SCAN_POD_SEC} kubectl logs -n "$0" "$1" --all-containers --timestamps --since=${since}s --tail=3000 2>"$QT_D/e/$0__$1"); rc=$?; ` +
    `{ echo "@@QTPOD $0 $1 $rc"; ` +
    `if [ $rc -eq 0 ]; then printf '%s\\n' "$out" | grep -E -i -e "$QT_PAT" | tail -n ${per} | cut -c1-800; ` +
    `else echo "@@QTERR $(head -n 1 "$QT_D/e/$0__$1" | cut -c1-200)"; fi; } > "$f"`
  const prevList = (o.prev ?? []).map((p) => `echo ${shq(`${p.ns} ${p.pod} prev`)}`).join('; ')
  // NotReady 노드 위 Running 파드 — 읽지 않고 조회 불가 기록만 파일로 남긴다(awk 의 > 파일, 열린 파일이 쌓이지 않게 close)
  const listAwk =
    `$2=="Running"{ if (index(bad, " " $3 " ")) { f = d "/" ns "__" $1 "__skip"; ` +
    `printf "@@QTPOD %s %s 1\\n@@QTERR 노드 %s NotReady: 로그를 읽지 않음\\n", ns, $1, $3 > f; close(f) } else print ns " " $1 " cur" }`
  return (
    `export QT_PAT=${shq(pat)}; QT_D=$(mktemp -d 2>/dev/null || echo "/tmp/qtscan.$$"); mkdir -p "$QT_D/e"; export QT_D; ` +
    `bad=" $(kubectl get nodes --no-headers 2>/dev/null | awk '$2 !~ /^Ready/ {print $1}' | tr '\\n' ' ') "; ` +
    `{ for ns in ${nss}; do kubectl get pods -n "$ns" --no-headers -o custom-columns=N:.metadata.name,P:.status.phase,H:.spec.nodeName 2>/dev/null ` +
    `| awk -v ns="$ns" -v d="$QT_D" -v bad="$bad" ${shq(listAwk)}; done; ${prevList ? `${prevList}; ` : ''}} ` +
    `| timeout ${SCAN_ALL_SEC} xargs -r -P ${par} -L 1 sh -c ${shq(one)}; ` +
    `[ $? -eq 124 ] && echo "@@QTCUT"; ` +
    `cat "$QT_D"/* 2>/dev/null; rm -rf "$QT_D"; ` +
    `echo "@@QTEND"`
  )
}

export interface ScanPod {
  ns: string
  pod: string
  /** --previous 로 읽은 것(재시작 전 컨테이너) */
  prev?: boolean
  /** 로그를 못 읽음 — 사유 */
  err?: string
  lines: { ts: number | null; text: string }[]
}

/** kubectl --timestamps 의 앞머리(RFC3339, 나노초까지) */
const TS_RE = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(\.\d+)?(Z|[+-]\d\d:\d\d)\s?(.*)$/
export function splitTs(line: string): { ts: number | null; text: string } {
  const m = TS_RE.exec(line)
  if (!m) return { ts: null, text: line }
  const frac = (m[2] ?? '').slice(0, 4) // 밀리초까지만 — Date.parse 가 나노초를 못 읽는 경우가 있다
  const t = Date.parse(`${m[1]}${frac}${m[3]}`)
  return { ts: Number.isNaN(t) ? null : t, text: m[4] }
}

/** complete: 끝 표시까지 받음 · cut: 전체 제한 시간에 걸려 일부 파드는 못 읽음(읽은 것은 쓴다) */
export function parseScan(out: string): { pods: ScanPod[]; complete: boolean; cut: boolean } {
  const pods: ScanPod[] = []
  let cur: ScanPod | null = null
  let complete = false
  let cut = false
  for (const raw of (out ?? '').split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line === '@@QTCUT') {
      cut = true
      cur = null
      continue
    }
    if (line.startsWith('@@QTPOD ')) {
      const [, ns, pod, rc] = line.split(' ')
      cur = { ns, pod, lines: [] }
      if (rc && rc !== '0') cur.err = '로그를 읽지 못함'
      pods.push(cur)
      continue
    }
    if (line.startsWith('@@QTPREV ')) {
      const [, ns, pod] = line.split(' ')
      cur = { ns, pod, prev: true, lines: [] }
      pods.push(cur)
      continue
    }
    if (line.startsWith('@@QTERR')) {
      if (cur) cur.err = line.slice(8).trim() || '로그를 읽지 못함'
      continue
    }
    if (line === '@@QTEND') {
      complete = true
      cur = null
      continue
    }
    if (!cur || !line.trim()) continue
    cur.lines.push(splitTs(line))
  }
  return { pods, complete, cut }
}

/** 줄의 성격 — head: 오류 · 경고 줄 / attach: 앞 오류에 딸린 원인 줄(Caused by · 예외 클래스) / drop: INFO 인데 단어만 걸린 것 */
export function classify(text: string): 'error' | 'warn' | 'attach' | 'drop' {
  const t = text.trim()
  if (/^caused by\b/i.test(t) || /^[\w.$]+(?:Exception|Error)(?::|$)/.test(t)) return 'attach'
  if (/^\s*at\s+[\w.$<>]+\(/.test(text) || /^\s*\.\.\. \d+ more/.test(text)) return 'drop'
  // 첫 수준 표기가 판단 기준 — 'INFO ... timeout=5s' 처럼 단어만 걸린 정상 줄은 버린다.
  // 수준 단어는 **대문자**(WARN · ERROR) · 대괄호([error]) · level= 꼴만 본다 — 'Failed to load info: timeout' 의 info 를
  // 수준으로 읽어 오류 줄을 버리면 안 된다
  const lv =
    /\b(TRACE|DEBUG|INFO|NOTICE|WARN(?:ING)?|ERROR|ERR|FATAL|CRIT(?:ICAL)?|SEVERE|PANIC)\b/.exec(t)?.[1] ??
    /\[(trace|debug|info|notice|warn(?:ing)?|error|err|fatal|crit(?:ical)?|panic)\]/i.exec(t)?.[1] ??
    /\blevel"?\s*[=:]\s*"?(\w+)/i.exec(t)?.[1] ??
    /^([EWIF])\d{4} /.exec(t)?.[1]
  if (lv) {
    const u = lv.toUpperCase()
    if (/^(TRACE|DEBUG|INFO|NOTICE|I)$/.test(u)) return 'drop'
    if (/^(WARN|WARNING|W)$/.test(u)) return 'warn'
    return 'error'
  }
  return /exception|traceback|panic|out of memory|oomkilled/i.test(t) ? 'error' : 'warn'
}

/** 서명 — 시각 · 숫자 · IP · id 를 지운 문장. 같은 오류가 다른 파드 · 다른 시각에 나도 한 묶음이 된다 */
export function signature(text: string): string {
  return (
    text
      .replace(/\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:[.,]\d+)?(?:Z|[+-]\d\d:?\d\d)?/g, '')
      .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>')
      .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, '<ip>')
      .replace(/\b[0-9a-f]{12,}\b/gi, '<id>')
      // 파드 이름의 꼬리(-5b7fd5d98b-fqrz9 · -8p42h)와 숫자 섞인 긴 토큰(요청 · 추적 id) — 남기면 줄마다 서명이 달라
      // 같은 오류가 묶음 수십 개로 흩어지고 묶음이 끝없이 늘었다(코드 점검 10-29)
      .replace(/-[a-z0-9]{8,10}-[a-z0-9]{5}\b/g, '-<pod>')
      .replace(/\b(?=[A-Za-z0-9_]*\d)(?=[A-Za-z0-9_]*[A-Za-z])[A-Za-z0-9_]{16,}\b/g, '<id>')
      .replace(/\d+/g, '#')
  )
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240)
}

/** 파드 이름 → 워크로드 이름(Deployment 의 해시 · DaemonSet 의 꼬리를 뗀다). 파드가 다시 떠 이름이 바뀌어도 같은 묶음 */
export function workloadOf(pod: string): string {
  // Deployment 꼴로 떼었으면 거기서 끝 — 둘을 잇달아 적용하면 boot-factory-agent-7d9f8c6b5-abcde 가 'boot-factory' 가 되어
  // 이웃 워크로드와 한 묶음이 됐다(코드 점검 10-29). 5글자 꼬리는 DaemonSet 꼴일 때만
  const dep = /-[a-z0-9]{8,10}-[a-z0-9]{5}$/
  return dep.test(pod) ? pod.replace(dep, '') : pod.replace(/-[a-z0-9]{5}$/, '')
}

const KINDS: [RegExp, string][] = [
  [/failed to resolve|unknownhost|could not resolve|no such host|nxdomain|dnsname|name or service not known|temporary failure in name resolution/i, 'DNS 조회 실패'],
  [/refused/i, '연결 거부'],
  [/timed? ?out|deadline exceeded/i, '시간 초과'],
  [/connection reset|broken pipe|\beof\b/i, '연결 끊김'],
  [/no route to host|unreachable/i, '대상에 닿지 않음'],
  [/\b401\b|\b403\b|unauthori[sz]ed|forbidden/i, '인증 실패'],
  [/oomkilled|out of memory/i, '메모리 부족'],
]

/** 무엇에 연결이 안 되는지 — svc DNS 이름이면 'ns/서비스', 아니면 '호스트:포트' */
export function extractTarget(text: string): { target?: string; kind?: string } {
  const kind = KINDS.find(([re]) => re.test(text))?.[1]
  const svc = /\b([a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+)\.svc(?:\.cluster\.local)?\b/i.exec(text)
  if (svc) {
    const parts = svc[1].split('.')
    const ns = parts[parts.length - 1]
    const name = parts.length >= 2 ? parts[parts.length - 2] : parts[0]
    return { target: `${ns}/${name}`, kind }
  }
  // 소스 파일:줄(DnsResolveContext.java:1150)은 호스트:포트가 아니다
  const hp = [...text.matchAll(/\b((?:\d{1,3}\.){3}\d{1,3}|[a-z][\w-]*(?:\.[\w-]+)+):(\d{2,5})\b/gi)].find(
    (m) => !/\.(java|kt|scala|go|py|js|ts|rb|cs|cpp|c|h)$/i.test(m[1]),
  )
  return { target: hp ? `${hp[1]}:${hp[2]}` : undefined, kind }
}

export interface LogGroup {
  key: string
  ns: string
  workload: string
  sig: string
  /** 대표 줄(처음 본 원문) */
  sample: string
  level: 'error' | 'warn'
  pods: string[]
  count: number
  first: number
  last: number
  /** 딸린 원인(가장 깊은 Caused by) */
  cause?: string
  target?: string
  kind?: string
  /** 기준선(감시를 켠 뒤 처음 몇 분)에 이미 있던 것 — '평소에도 나는 오류' */
  baseline: boolean
  /** 이번 검증(runSince) 뒤 처음 본 줄의 시각 · 그 뒤 횟수 · 검증 시작 전 마지막으로 본 줄의 시각 — 회차마다 '새 오류' 를 가른다 */
  sinceRun?: number
  countRun?: number
  lastBefore?: number
}

export interface LogWatchState {
  groups: LogGroup[]
  /** 같은 줄을 두 번 세지 않게(훑는 구간이 겹친다) — 키 → 그 줄의 시각 */
  seen: Map<string, number>
  /** 로그를 못 읽은 파드(죽은 노드 위 등) — '오류 없음' 이 아니다 */
  unreadable: { ns: string; pod: string; err: string }[]
  lastAt: number
  pods: number
  /** sinceRun · countRun 을 잰 기준(검증 시작, 노드 시계) — 바뀌면 다시 잰다 */
  runSince: number | null
}

export const emptyLogWatch = (): LogWatchState => ({ groups: [], seen: new Map(), unreadable: [], lastAt: 0, pods: 0, runSince: null })

/** 검증 시작 전 이만큼 안에 났던 오류는 그 회차의 새 오류가 아니다(이미 나고 있던 것) */
export const RUN_QUIET_MS = 5 * 60_000
/** 줄 시각 중복 판단을 기억하는 길이 — 실패 뒤 넓혀 받는 구간(최대 15분)보다 길어야 같은 줄을 두 번 세지 않는다 */
const SEEN_KEEP_MS = 20 * 60_000
/** 묶음 수 상한 — 오래 띄워 둔 보드에서 끝없이 늘지 않게, 넘으면 마지막으로 본 지 오래된 것부터 버린다 */
const MAX_GROUPS = 400

/**
 * 이 묶음이 **이번 검증의 새 오류**인가(코드 점검 10-29). 예전엔 묶음이 처음 생길 때 한 번만 '새것' 을 정해서, 롤링 검증 2회차에
 * 1회차와 같은 오류(valkey DNS)가 다시 나도 이미 있는 묶음이라 2회차 기록 · 리포트가 비었다.
 * 지금: 검증 시작 뒤에 났고, 평소 오류(기준선)가 아니고, 시작 전 5분 안에는 나지 않던 것. 시작 전에도 나고 있던 오류는 그 회차가 만든 것이 아니다.
 */
export function newInRun(g: LogGroup, runSince: number): boolean {
  // sinceRun >= runSince: 앞 회차 기준으로 쌓인 묶음(다음 훑기 전이라 아직 안 바뀐 것)을 이번 회차의 새 오류로 읽지 않게(코드 검토 10-29)
  return g.sinceRun != null && g.sinceRun >= runSince && !g.baseline && !(g.lastBefore != null && g.lastBefore >= runSince - RUN_QUIET_MS)
}

/** 연결 실패로 볼 종류 — 이런 경고는 오류로 올린다(앱이 WARN 으로 찍어도 서비스는 깨져 있다: 10-28 valkey DNS 가 WARN 이었다) */
const CONNECT_FAIL = new Set(['DNS 조회 실패', '연결 거부', '대상에 닿지 않음', '시간 초과'])
const promote = (g: LogGroup) => {
  if (g.level === 'warn' && g.target && g.kind && CONNECT_FAIL.has(g.kind)) g.level = 'error'
}

const hash = (s: string) => {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return h.toString(36)
}

/**
 * 한 번 훑은 결과를 쌓는다. 새로 생긴 묶음(기준선 밖)은 newGroups 로 돌려준다 — 타임라인 · 증적에 한 번만 올리게.
 * baselineBefore: 이 시각 전에 처음 나온 오류는 '평소' — 감시를 켠 뒤 5분, 검증을 시작했으면 그 시각.
 * 켜고 끄는 여부가 아니라 **줄의 시각**으로 가른다: 검증 중에 상태보드를 다시 열면 첫 훑기가 5분을 거슬러 받는데, 그 안의 검증 뒤
 * 오류까지 '평소' 로 삼키면 안 된다.
 * ignore: 무시 문구(글자 그대로 포함되면 버림). words: 사용자가 더한 단어 — 걸린 줄은 수준과 상관없이 오류(INFO 라고 버리지 않는다).
 * runSince: 검증 시작(줄과 같은 노드 시계) — 묶음마다 그 뒤 처음 본 시각 · 횟수 · 그 전 마지막 시각을 잰다(newInRun).
 */
export function mergeScan(
  st: LogWatchState,
  pods: ScanPod[],
  o: { now: number; baselineBefore: number; ignore?: string[]; words?: string[]; runSince?: number | null },
): { state: LogWatchState; newGroups: LogGroup[] } {
  const runSince = o.runSince ?? null
  const reset = runSince !== st.runSince
  const groups = new Map(
    st.groups.map((g) => {
      const c = { ...g, pods: [...g.pods] }
      // 검증 기준이 바뀌었으면 회차 값을 다시 잰다 — 지금까지 본 것은 모두 그 회차 '전' 이다
      if (reset) {
        c.sinceRun = undefined
        c.countRun = 0
        c.lastBefore = runSince != null && g.last < runSince ? g.last : undefined
      }
      return [g.key, c]
    }),
  )
  const seen = new Map(st.seen)
  const created: LogGroup[] = []
  const ignore = (o.ignore ?? []).map((w) => w.trim()).filter(Boolean)
  const words = (o.words ?? []).map((w) => w.trim().toLowerCase()).filter(Boolean)
  for (const p of pods) {
    if (p.err) continue
    const wl = workloadOf(p.pod)
    let head: LogGroup | null = null
    let headTs = 0
    for (const ln of p.lines) {
      const ts = ln.ts ?? o.now
      let kind = classify(ln.text)
      if (kind !== 'attach' && words.length && words.some((w) => ln.text.toLowerCase().includes(w))) kind = 'error'
      if (kind === 'drop') continue
      if (ignore.some((w) => ln.text.includes(w))) continue
      const k = `${p.pod}|${ln.ts ?? ''}|${hash(ln.text)}`
      const dup = seen.has(k)
      seen.set(k, ts)
      if (kind === 'attach') {
        // 앞 오류 줄에 딸린 원인 — 같은 순간(2초 안)에 찍힌 것만 붙인다
        if (head && Math.abs(ts - headTs) <= 2000) {
          if (/^caused by/i.test(ln.text.trim()) || !head.cause) head.cause = ln.text.trim().slice(0, 300)
          if (!head.target || !head.kind) {
            const t = extractTarget(ln.text)
            head.target ??= t.target
            head.kind ??= t.kind
            promote(head)
          }
        }
        continue
      }
      const sig = signature(ln.text)
      const key = `${p.ns}|${wl}|${sig}`
      let g = groups.get(key)
      if (!g) {
        const t = extractTarget(ln.text)
        // baseline 은 아래에서 이 훑기의 가장 이른 줄로 정한다(줄 순서는 파드 · 컨테이너마다 시간순이 아니다)
        g = { key, ns: p.ns, workload: wl, sig, sample: ln.text.trim().slice(0, 400), level: kind, pods: [], count: 0, first: ts, last: ts, target: t.target, kind: t.kind, baseline: false, countRun: 0 }
        promote(g)
        groups.set(key, g)
        created.push(g)
      }
      if (kind === 'error') g.level = 'error'
      head = g
      headTs = ts
      if (dup) continue
      g.count++
      g.first = Math.min(g.first, ts)
      g.last = Math.max(g.last, ts)
      if (!g.pods.includes(p.pod)) g.pods.push(p.pod)
      if (runSince != null) {
        if (ts >= runSince) {
          g.sinceRun = g.sinceRun == null ? ts : Math.min(g.sinceRun, ts)
          g.countRun = (g.countRun ?? 0) + 1
        } else g.lastBefore = g.lastBefore == null ? ts : Math.max(g.lastBefore, ts)
      }
    }
  }
  // 새 묶음의 평소 여부 — 처음 만난 줄이 아니라 이 훑기에서 본 가장 이른 줄로(코드 점검 10-29: 컨테이너 순서대로 읽으면 늦은 줄이 먼저 온다)
  const newGroups: LogGroup[] = []
  for (const g of created) {
    g.baseline = g.first < o.baselineBefore
    if (!g.baseline) newGroups.push(g)
  }
  for (const [k, t] of seen) if (t < o.now - SEEN_KEEP_MS) seen.delete(k)
  let list = [...groups.values()]
  if (list.length > MAX_GROUPS) list = list.sort((a, b) => b.last - a.last).slice(0, MAX_GROUPS)
  return {
    state: {
      groups: list,
      seen,
      unreadable: pods.filter((p) => p.err).map((p) => ({ ns: p.ns, pod: p.pod, err: p.err! })),
      lastAt: o.now,
      pods: pods.filter((p) => !p.prev).length,
      runSince,
    },
    newGroups,
  }
}

/** 한 줄 요약 — 'boot-factory → dataplatform/valkey-cluster 연결 실패 (DNS 조회 실패)' */
export function groupHeadline(g: LogGroup): string {
  if (g.target) return `${g.workload} → ${g.target} 연결 실패${g.kind ? ` (${g.kind})` : ''}`
  return `${g.workload}: ${g.kind ?? (g.level === 'error' ? '오류' : '경고')}`
}

// ── 합친 로그 보기 ─────────────────────────────────────────────

/** 합친 창이 파드 하나에서 받는 최대 줄 수 */
export const FETCH_MAX_LINES = 4000

/**
 * 파드 여러 개의 로그를 그대로 받아 오는 명령(합친 창용) — 걸러 내지 않는다(앞뒤 줄 · 스택이 필요하다).
 *
 * **오류 시각부터 앞으로** 받는다: `--since-time=<from>` 에서 시작해 `to` 를 넘는 줄은 awk 로 자르고, 줄 수는 head 로 앞에서 끊는다.
 * 처음엔 `--since=<지금까지 초> --tail=3000` 이었는데 tail 은 **끝에서** 3000줄이라, 요청마다 접근 로그를 찍는 gateway 처럼
 * 시끄러운 파드는 몇 분 사이에 3000줄이 넘어 정작 오류 줄이 잘려 나갔다('이 오류만' 이 0줄 · 10-29 boot-factory-gateway).
 * 시각 비교는 RFC3339(UTC 'Z') 문자열 비교다 — kubectl --timestamps 의 앞머리와 같은 꼴이라 사전순 = 시간순이고,
 * 기준이 kubelet 이 붙인 시각이라 감시가 받은 줄의 시각(group.first · last)과 같은 시계다.
 *
 * 파드는 **병렬로** 받아 파드마다 임시 파일에 쓰고, 끝에 고른 순서대로 붙인다(훑기와 같은 방식). 처음엔 차례로 받았는데, 같은 워크로드
 * 파드(DaemonSet 이면 열 개 넘게) 중 죽은 노드 위 파드가 몇 개만 섞여도 파드마다 12초씩 걸려 60초 강제 종료에 닿았고, 그러면
 * 이미 받은 파드까지 모두 잃고 '로그를 받지 못했습니다' 만 남았다(코드 검토 10-29). 전체 40초에 끊기면 @@QTCUT, 받은 것은 쓴다.
 */
export function buildFetchCmd(ns: string, pods: string[], fromMs: number, toMs: number, maxLines = FETCH_MAX_LINES): string {
  const from = new Date(fromMs).toISOString()
  const to = new Date(toMs).toISOString()
  // $0 = 파드. exit 로 끊지 않고 거른다 — --all-containers 는 컨테이너별로 이어 붙여 시각이 다시 앞으로 돌아가고,
  // 'Error from server …' 같은 kubectl 문구(시각 없음)도 보여 줘야 한다(2>&1). {4} 는 mawk 가 못 읽어 풀어 쓴다
  const one =
    `{ echo "@@QTPOD ${ns} $0 0"; timeout ${SCAN_POD_SEC} kubectl logs -n ${shq(ns)} "$0" --all-containers --timestamps --since-time=${from} 2>&1 ` +
    `| awk -v to=${shq(to)} '!($1 ~ /^[0-9][0-9][0-9][0-9]-/ && $1 > to)' | head -n ${maxLines} | cut -c1-2000; } > "$QT_D/$0"`
  return (
    `QT_D=$(mktemp -d 2>/dev/null || echo "/tmp/qtfetch.$$"); mkdir -p "$QT_D"; export QT_D; ` +
    `printf '%s\\n' ${pods.map(shq).join(' ')} | timeout ${SCAN_ALL_SEC} xargs -r -P 6 -L 1 sh -c ${shq(one)}; ` +
    `[ $? -eq 124 ] && echo "@@QTCUT"; ` +
    `for p in ${pods.map(shq).join(' ')}; do cat "$QT_D/$p" 2>/dev/null; done; rm -rf "$QT_D"; echo "@@QTEND"`
  )
}

export interface ViewEntry {
  pod: string
  ts: number | null
  text: string
  /** match: 이 오류 줄 / line: 그 밖의 줄 */
  kind: 'match' | 'line'
  /** 접힌 스택 · 딸린 줄 */
  fold?: { n: number; cause?: string; lines: string[] }
  /** 같은 줄 반복 — 몇 번 더 · 마지막 시각 */
  repeat?: { n: number; until: number | null }
}

/**
 * 합친 보기. mode: match = 이 오류 줄만 / ctx = 그 앞뒤 5줄 포함 / all = 전부.
 * 스택(들여쓴 at …, Caused by, 예외 클래스 줄)은 앞 줄 밑으로 접고, 같은 파드에서 같은 오류가 잇따르면 한 줄로 줄인다.
 */
export function buildLogView(perPod: { pod: string; lines: { ts: number | null; text: string }[] }[], sig: string | null, mode: 'match' | 'ctx' | 'all', ctxN = 5): ViewEntry[] {
  const out: ViewEntry[] = []
  for (const p of perPod) {
    // 1) 스택 접기
    const items: ViewEntry[] = []
    for (const ln of p.lines) {
      const isStack = /^\s+(at |\.\.\. \d+)/.test(ln.text) || /^\s*caused by\b/i.test(ln.text) || (/^[\w.$]+(?:Exception|Error):/.test(ln.text.trim()) && items.length > 0)
      const last = items[items.length - 1]
      if (isStack && last) {
        last.fold ??= { n: 0, lines: [] }
        last.fold.n++
        last.fold.lines.push(ln.text)
        if (/^\s*caused by/i.test(ln.text)) last.fold.cause = ln.text.trim().replace(/^caused by:\s*/i, '').slice(0, 200)
        continue
      }
      const isMatch = !!sig && classify(ln.text) !== 'drop' && signature(ln.text) === sig
      items.push({ pod: p.pod, ts: ln.ts, text: ln.text, kind: isMatch ? 'match' : 'line' })
    }
    // 2) 보일 줄 고르기
    let keep: boolean[]
    if (mode === 'all' || !sig) keep = items.map(() => true)
    else if (mode === 'match') keep = items.map((x) => x.kind === 'match')
    else {
      keep = items.map(() => false)
      items.forEach((x, i) => {
        if (x.kind !== 'match') return
        for (let j = Math.max(0, i - ctxN); j <= Math.min(items.length - 1, i + ctxN); j++) keep[j] = true
      })
    }
    // 3) 같은 오류가 잇따르면 한 줄로
    let prev: ViewEntry | null = null
    items.forEach((x, i) => {
      if (!keep[i]) {
        prev = null
        return
      }
      if (prev && x.kind === 'match' && prev.kind === 'match') {
        prev.repeat = { n: (prev.repeat?.n ?? 0) + 1, until: x.ts }
        return
      }
      out.push(x)
      prev = x
    })
  }
  return out.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0))
}
