/**
 * 응답 측정 — 노드를 죽였을 때 그 위의 VM 서비스(nginx 등)가 **끊긴 순간부터 다시 200 OK 가 될 때까지**를 잰다.
 *
 * 측정은 Q-Term 이 아니라 **사용자가 고른 서버(측정 호스트)** 에서 돈다. Q-Term 은 스크립트를 올려 백그라운드로
 * 띄우고(nohup·setsid), 그 서버에 쌓이는 CSV 를 1초마다 읽어 화면에 보여 줄 뿐이다. 이렇게 한 이유:
 *  - 대상 VM 네트워크가 이 PC 에서는 안 닿는 경우가 많다(관리망 안쪽).
 *  - Q-Term·PC 가 꺼져도 측정은 이어진다 — 노드를 죽이는 동안 PC 쪽 사정으로 기록이 끊기면 안 된다.
 *  - 서버에 남은 CSV 자체가 **툴과 무관한 증적**이다.
 *
 * 판정은 상태보드·포털 감시와 같은 원칙이다.
 *  - 한 번 튄 200 은 복구가 아니다 — **연속 N회** 200 이어야 복구, 시각은 그 연속이 시작된 첫 성공.
 *  - 끊김은 '처음 정상(연속 N회)을 본 뒤' 의 첫 실패부터. 시작부터 응답이 없던 대상은 끊김으로 세지 않는다.
 *  - 시각은 요청을 **보내기 직전** — 응답이 없으면 curl 이 타임아웃까지 기다리므로 끝난 뒤 찍으면 그만큼 늦다.
 *  - 대상마다 따로(병렬) 돈다 — 한 루프에서 차례로 물으면 죽은 대상 하나가 타임아웃만큼 주기를 늘린다.
 * 시각은 **측정 호스트의 시계**(epoch ms)다. 화면에는 이 PC 시간대로 표시한다.
 *
 * 가용성 상태보드에는 기록하지 않는다(사용자 결정, 2026-10-22) — 따로 시작·중지하고 이력도 따로 둔다.
 */

/**
 * 측정 방식 — 회차 하나에 하나(대상 전부 같은 방식).
 *  - http : curl 로 상태 코드. 기대 코드(기본 200)면 정상
 *  - tcp  : 대상:포트 로 TCP 연결이 열리면 정상. bash 내장 /dev/tcp + timeout 이 기본이다 — nc 는 배포판마다
 *           옵션이 달라(구버전 ncat 은 -z 가 없어 **늘 실패**로 나온다) timeout 이 없을 때만 대신 쓴다
 *  - icmp : ping 한 번에 응답이 오면 정상
 */
export type ProbeMode = 'http' | 'tcp' | 'icmp'

/** 정상 HTTP 코드 지정 — `200` · `2xx` · `200,302` (x 는 아무 숫자). 비면 기대 코드 하나 */
const SPEC_RE = /^(\d{3}|\d[0-9x]{2})(,(\d{3}|\d[0-9x]{2}))*$/
export const httpSpec = (cfg: Pick<ProbeConfig, 'expectCode' | 'expectSpec'>) => {
  const raw = (cfg.expectSpec ?? '').replace(/\s+/g, '').toLowerCase()
  return raw && SPEC_RE.test(raw) ? raw : String(cfg.expectCode)
}
export const specValid = (spec: string) => !spec.trim() || SPEC_RE.test(spec.replace(/\s+/g, '').toLowerCase())

/** 스크립트가 '정상' 으로 볼 표식 — http 는 코드 지정(x 는 아무 숫자), tcp 는 OPEN, icmp 는 OK */
export const expectToken = (cfg: Pick<ProbeConfig, 'mode' | 'expectCode' | 'expectSpec'>) =>
  cfg.mode === 'tcp' ? 'OPEN' : cfg.mode === 'icmp' ? 'OK' : httpSpec(cfg)

/** 결과 표식이 정상인가 — 스크립트의 ok_code 와 같은 규칙 */
export function codeMatches(code: string, cfg: Pick<ProbeConfig, 'mode' | 'expectCode' | 'expectSpec'>): boolean {
  return expectToken(cfg)
    .split(',')
    .some((p) => p.length === code.length && [...p].every((ch, i) => ch === 'x' || ch === code[i]))
}

/** 리포트·화면에 적을 방식 이름 */
export const modeText = (cfg: Pick<ProbeConfig, 'mode' | 'expectCode' | 'expectSpec' | 'follow' | 'hostHeader'>) =>
  cfg.mode === 'tcp'
    ? 'TCP 포트 연결'
    : cfg.mode === 'icmp'
      ? 'Ping (ICMP)'
      : `HTTP ${httpSpec(cfg)}${cfg.follow ? ' · 리다이렉트 따라감' : ''}${cfg.hostHeader ? ` · Host ${cfg.hostHeader}` : ''}`

/** 결과 표식을 사람 말로(대상 칸 오른쪽 위) */
export const codeText = (code: string, mode: ProbeMode) =>
  mode === 'tcp' ? (code === 'OPEN' ? '열림' : '닫힘') : mode === 'icmp' ? (code === 'OK' ? '응답' : '없음') : code

/** 주소를 화면용으로 — tcp://·icmp:// 접두는 떼고 보인다 */
export const displayAddr = (url: string) => url.replace(/^(tcp|icmp):\/\//i, '')

export interface ProbeTarget {
  name: string
  url: string
}

export interface ProbeConfig {
  mode: ProbeMode
  targets: ProbeTarget[]
  intervalSec: number
  timeoutSec: number
  /** 연속 몇 번 정상이어야 복구(또는 첫 정상)로 볼지 */
  needOk: number
  /** 정상으로 볼 HTTP 상태(옛 설정) — expectSpec 이 비면 이 값 하나 */
  expectCode: number
  /**
   * 정상 코드 지정 — `200` · `2xx` · `200,302`. 로그인 페이지로 302 를 주는 서비스처럼 200 하나로는 늘 '끊김' 인 대상을 위해.
   */
  expectSpec?: string
  /** 리다이렉트를 따라가 최종 응답 코드로 판정한다(curl -L) */
  follow?: boolean
  /** Host 헤더 — 한 IP 에 이름으로 나뉜 사이트(nginx 가상 호스트) 중 하나를 고를 때 */
  hostHeader?: string
  /**
   * 끊겼던 대상이 **모두** 복구되면 측정을 스스로 끝낸다. 1대든 10대든 마지막 VM 이 돌아온 순간이 측정의 끝이다
   * (사용자 요청). 사람이 지켜보다 [중지] 를 누르면 그만큼 기록이 길어지고, 깜빡 잊으면 서버에서 계속 돈다.
   */
  autoStop: boolean
  /**
   * 연속 몇 번 실패해야 끊김으로 볼지. 처음엔 실패 **한 번**으로 끊김을 확정했는데, 노드를 죽이기 전에 curl 타임아웃·
   * ping 유실이 한 번만 나도 '끊김 → 복구' 가 생겨 자동 종료가 장애를 넣기도 전에 걸렸다(검토 지적). 포털 감시와 같은
   * 원칙 — 들어갈 때도 나올 때도 연속을 요구한다. 끊김 시작 시각은 그 연속의 **첫 실패**로 되짚는다.
   */
  needFail: number
  /**
   * 최대 측정 시간(분). 클라이언트 VM 에서 도는 스크립트는 Q-Term 이 꺼져도 계속 돌므로, 세션이 끊긴 채 [중지] 를
   * 못 보내면 영원히 돌며 /tmp 를 채웠다(검토 지적). 이 시간이 지나면 서버에서 스스로 멈춘다.
   */
  maxMin: number
  /**
   * 자동 종료 전에 더 지켜볼 시간(초). 모두 복구된 직후에 다시 흔들리는 대상(failback·재스케줄)이 있으면
   * 끝내지 않고 이어 간다 — '한 번 돌아온 것' 을 끝으로 보지 않는다.
   */
  settleSec: number
}

export const DEFAULT_PROBE: Omit<ProbeConfig, 'targets'> = {
  mode: 'http',
  intervalSec: 1,
  timeoutSec: 2,
  needOk: 3,
  expectCode: 200,
  autoStop: true,
  settleSec: 10,
  needFail: 2,
  maxMin: 180,
}

/** 클라이언트 VM 에 올리는 스크립트 — 인자: 주기 타임아웃 연속횟수 기대표식 방식 대상... */
export const PROBE_SCRIPT = `#!/bin/bash
# Q-Term 응답 측정 — 대상마다 병렬로 응답(HTTP 코드 · TCP 연결 · ping)을 재고, 끊김·복구를 events.csv 에 남긴다.
# events.csv : epoch_ms,대상번호,결과,이벤트(ready|outage|recovered),기준시각_ms[,끊김시작_ms]
# checks.csv : epoch_ms,대상번호,결과   (모든 요청) — 결과: HTTP 코드 / OPEN / OK, 실패는 000
D="$(cd "$(dirname "$0")" && pwd)"
INTERVAL=$1; TIMEOUT=$2; NEED=$3; EXPECT=$4; MODE=$5; NEEDF=$6; MAXSEC=$7; FOLLOW=$8; HOSTHDR=$9; shift 9
HTTP_ARGS=(-k -s -o /dev/null -w '%{http_code}' --connect-timeout "$TIMEOUT" --max-time "$TIMEOUT")
[ "$FOLLOW" = 1 ] && HTTP_ARGS+=(-L)
[ -n "$HOSTHDR" ] && HTTP_ARGS+=(-H "Host: $HOSTHDR")
# 정상 표식 — EXPECT 는 쉼표로 여러 개, x 는 아무 글자(2xx). glob 을 쓰지 않으려고 한 글자씩 견준다
ok_code() {
  local IFS=, p j m
  for p in $EXPECT; do
    [ \${#p} -eq \${#1} ] || continue
    m=1
    for ((j = 0; j < \${#p}; j++)); do
      [ "\${p:j:1}" = x ] || [ "\${p:j:1}" = "\${1:j:1}" ] || { m=0; break; }
    done
    [ $m = 1 ] && return 0
  done
  return 1
}
START=$(date +%s)
TCP_TOOL=$(cat "$D/tcp_tool" 2>/dev/null)
now_ms() { date +%s%3N; }
check() {
  case "$MODE" in
    tcp)
      local h p
      h=\${1%:*}; p=\${1##*:}
      if [ "$TCP_TOOL" = nc ]; then
        nc -z -w "$TIMEOUT" "$h" "$p" >/dev/null 2>&1 && echo OPEN || echo 000
      else
        timeout "$TIMEOUT" bash -c "exec 3<>/dev/tcp/$h/$p" >/dev/null 2>&1 && echo OPEN || echo 000
      fi ;;
    icmp)
      ping -c 1 -W "$TIMEOUT" "$1" >/dev/null 2>&1 && echo OK || echo 000 ;;
    *)
      local c; c=$(curl "\${HTTP_ARGS[@]}" "$1" 2>/dev/null)
      echo "\${c:-000}" ;;
  esac
}
watch_one() {
  local i=$1 url=$2 had=0 out=0 out_ms=0 streak=0 sstart=0 fails=0 fstart=0
  while [ $(( $(date +%s) - START )) -lt "$MAXSEC" ]; do
    local t; t=$(now_ms)
    local code; code=$(check "$url")
    [ -z "$code" ] && code=000
    if ok_code "$code"; then
      fails=0
      [ $streak -eq 0 ] && sstart=$t
      streak=$((streak + 1))
      if [ $had -eq 0 ] && [ $streak -ge $NEED ]; then had=1; echo "$t,$i,$code,ready,$sstart" >> "$D/events.csv"; fi
      if [ $out -eq 1 ] && [ $streak -ge $NEED ]; then out=0; echo "$t,$i,$code,recovered,$sstart,$out_ms" >> "$D/events.csv"; fi
    else
      streak=0
      fails=$((fails + 1)); [ $fails -eq 1 ] && fstart=$t
      if [ $had -eq 1 ] && [ $out -eq 0 ] && [ $fails -ge "$NEEDF" ]; then out=1; out_ms=$fstart; echo "$t,$i,$code,outage,$fstart" >> "$D/events.csv"; fi
    fi
    echo "$t,$i,$code" >> "$D/checks.csv"
    printf '%s %s %s %s %s %s\\n' "$i" "$t" "$code" "$streak" "$out" "$had" > "$D/t$i.tmp" && mv -f "$D/t$i.tmp" "$D/t$i.last"
    local el=$(( $(now_ms) - t ))
    local sl=$(( INTERVAL * 1000 - el ))
    [ $sl -gt 0 ] && sleep "$(awk "BEGIN{printf \\"%.3f\\", $sl/1000}")"
  done
}
i=0
for u in "$@"; do watch_one "$i" "$u" & i=$((i + 1)); done
wait
echo "QT_EXPIRED $(date +%s%3N)" >> "$D/run.log"
`

/** 셸 작은따옴표로 감싸도 안전한 URL 만 받는다 — 측정 호스트에서 그대로 실행되는 인자다 */
const URL_RE = /^https?:\/\/[A-Za-z0-9.\-_:[\]]+(?::\d+)?(?:\/[A-Za-z0-9._~\-/?=&%+#:@!$,;*()]*)?$/

/**
 * 대상 목록 — 한 줄에 하나. `URL`, `IP`, `IP:포트`, `이름 URL` 모두 받는다(IP 만 쓰면 http://IP).
 * 작은따옴표·공백 같은 셸 문자가 든 URL 은 거절한다.
 */
/** TCP·Ping 대상 호스트 — 셸에 그대로 넘어가므로 글자를 좁힌다(IPv6 는 아직 받지 않는다) */
const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9.\-_]*$/

export function parseTargets(text: string, mode: ProbeMode = 'http'): { targets: ProbeTarget[]; errors: string[] } {
  const targets: ProbeTarget[] = []
  const errors: string[] = []
  const seen = new Set<string>()
  text.split(/\r?\n/).forEach((raw, li) => {
    const line = raw.trim()
    if (!line || line.startsWith('#')) return
    const parts = line.split(/\s+/)
    let name = ''
    let u = parts[0]
    if (parts.length >= 2) {
      name = parts.slice(0, -1).join(' ')
      u = parts[parts.length - 1]
    }
    if (mode === 'tcp' || mode === 'icmp') {
      // 다른 방식에서 넘어온 주소(http://IP/경로)도 받아 호스트만 쓴다
      const bare = u.replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, '')
      const m = bare.match(/^(.+?)(?::(\d{1,5}))?$/)
      const host = m?.[1] ?? ''
      const port = m?.[2]
      if (!HOST_RE.test(host)) {
        errors.push(`${li + 1}번째 줄: 주소로 읽을 수 없습니다 — ${line}`)
        return
      }
      if (mode === 'tcp' && (!port || +port < 1 || +port > 65535)) {
        // 짧게 — 수동 입력에서는 줄 번호·원문이 오히려 헷갈렸다(사용자 지적). 빨간 칸이 어느 행인지 보여 준다
        errors.push('TCP (포트) 는 포트 입력이 필수입니다.')
        return
      }
      const url = mode === 'tcp' ? `tcp://${host}:${port}` : `icmp://${host}`
      if (seen.has(url)) return
      seen.add(url)
      targets.push({ name: name || displayAddr(url), url })
      return
    }
    if (!/^https?:\/\//i.test(u)) u = `http://${u}`
    if (!URL_RE.test(u)) {
      errors.push(`${li + 1}번째 줄: 주소로 읽을 수 없습니다 — ${line}`)
      return
    }
    if (seen.has(u)) return
    seen.add(u)
    targets.push({ name: name || u.replace(/^https?:\/\//i, '').replace(/\/$/, ''), url: u })
  })
  return { targets, errors }
}

/**
 * 입력 칸 방식의 한 행 — 이름 · IP(또는 호스트명) · 포트 · 경로. 자유 입력(한 줄에 하나)과 서로 바꿀 수 있다.
 * 포트를 비우면 http 기본 80, https 기본 443.
 */
export interface TargetRow {
  name: string
  host: string
  port: string
  path: string
  https: boolean
}

export const emptyRow = (): TargetRow => ({ name: '', host: '', port: '', path: '', https: false })

/** 행 → 자유 입력 한 줄(`이름 주소`) — 비어 있는 행은 건너뛴다. TCP 는 호스트:포트, Ping 은 호스트만 */
export function rowsToText(rows: TargetRow[], mode: ProbeMode = 'http'): string {
  return rows
    .filter((r) => r.host.trim())
    .map((r) => {
      const port = r.port.trim()
      const path = r.path.trim()
      const url =
        mode === 'tcp'
          ? `${r.host.trim()}${port ? `:${port}` : ''}`
          : mode === 'icmp'
            ? r.host.trim()
            : `${r.https ? 'https' : 'http'}://${r.host.trim()}${port ? `:${port}` : ''}${path ? (path.startsWith('/') ? path : `/${path}`) : ''}`
      const name = r.name.trim()
      return name ? `${name} ${url}` : url
    })
    .join('\n')
}

/** 자유 입력 → 행. 읽을 수 없는 줄은 버리지 않고 오류로 돌려준다(바꾸면서 조용히 사라지면 안 된다) */
export function textToRows(text: string, mode: ProbeMode = 'http'): { rows: TargetRow[]; errors: string[] } {
  const { targets, errors } = parseTargets(text, mode)
  const rows = targets.map((t) => {
    const m = t.url.match(/^(https?|tcp|icmp):\/\/(\[[^\]]+\]|[^/:]+)(?::(\d+))?(\/.*)?$/i)
    const nameIsAuto = t.name === t.url.replace(/^[a-z]+:\/\//i, '').replace(/\/$/, '')
    return {
      name: nameIsAuto ? '' : t.name,
      host: m?.[2] ?? t.url,
      port: m?.[3] ?? '',
      path: m?.[4] && m[4] !== '/' ? m[4] : '',
      https: (m?.[1] ?? '').toLowerCase() === 'https',
    }
  })
  return { rows, errors }
}

const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

/** 측정 디렉터리 — 회차 id 로 만든다(숫자·문자만) */
export const probeDir = (runId: string) => `/tmp/qterm-probe/${runId.replace(/[^\w-]/g, '')}`

/** 스크립트를 올리고 백그라운드로 띄운다. 마지막 줄에 `QT_STARTED <pid>` */
export function buildStartCmd(runId: string, cfg: ProbeConfig): string {
  const dir = probeDir(runId)
  const nums = [cfg.intervalSec, cfg.timeoutSec, cfg.needOk].map((n) => String(Math.max(1, Math.floor(n))))
  const mode: ProbeMode = cfg.mode === 'tcp' || cfg.mode === 'icmp' ? cfg.mode : 'http'
  const needFail = String(Math.max(1, Math.floor(cfg.needFail || 1)))
  const maxSec = String(Math.max(60, Math.floor((cfg.maxMin || 180) * 60)))
  const hostHdr = mode === 'http' && cfg.hostHeader && /^[A-Za-z0-9.\-:]+$/.test(cfg.hostHeader) ? cfg.hostHeader : ''
  const args = [
    ...nums,
    expectToken({ mode, expectCode: Math.floor(cfg.expectCode), expectSpec: cfg.expectSpec }),
    mode,
    needFail,
    maxSec,
    mode === 'http' && cfg.follow ? '1' : '0',
    sq(hostHdr),
  ]
  // 스크립트에 넘기는 대상 — http 는 URL, tcp 는 호스트:포트, icmp 는 호스트
  const targetArgs = cfg.targets.map((t) => sq(mode === 'http' ? t.url : displayAddr(t.url)))
  /**
   * TCP 도구 — nc 를 먼저 쓴다(사용자 요청: 증적에 'nc 로 확인' 이 남는 편이 낫다). 단 구버전 ncat 처럼 **-z 가 없는 nc**
   * 로 재면 열린 포트도 전부 '닫힘' 이 된다 — 도움말에 -z 가 있는지 먼저 보고, 없으면 bash /dev/tcp(+timeout)로 잰다.
   * 고른 도구는 측정 디렉터리의 tcp_tool 에 남기고(스크립트가 읽는다) 시작 응답으로 Q-Term 에도 알린다.
   */
  const need =
    mode === 'tcp'
      ? [
          `if command -v nc >/dev/null 2>&1 && nc -h 2>&1 | grep -q -- '-z'; then QT_TCP=nc`,
          `elif command -v timeout >/dev/null 2>&1; then QT_TCP=devtcp`,
          `else echo 'QT_ERR -z 를 지원하는 nc 도, timeout 도 없습니다 — TCP 연결을 잴 수 없습니다'; exit 1; fi`,
        ].join('\n')
      : mode === 'icmp'
        ? `command -v ping >/dev/null 2>&1 || { echo 'QT_ERR ping 이 없습니다'; exit 1; }`
        : `command -v curl >/dev/null 2>&1 || { echo 'QT_ERR curl 이 없습니다'; exit 1; }`
  return [
    need,
    `date +%s%3N | grep -q N && { echo 'QT_ERR date 가 밀리초(%3N)를 지원하지 않습니다'; exit 1; }`,
    `mkdir -p ${dir} && cd ${dir} || { echo 'QT_ERR 디렉터리를 만들 수 없습니다'; exit 1; }`,
    `cat > probe.sh <<'QT_PROBE_EOF'\n${PROBE_SCRIPT}QT_PROBE_EOF`,
    `chmod +x probe.sh`,
    `: > events.csv; : > checks.csv`,
    ...(mode === 'tcp' ? [`echo "$QT_TCP" > tcp_tool; echo "QT_TOOL $QT_TCP"`] : []),
    `setsid nohup bash ./probe.sh ${args.join(' ')} ${targetArgs.join(' ')} > run.log 2>&1 < /dev/null &`,
    `echo $! > pid`,
    `echo "QT_STARTED $(cat pid)"`,
  ].join('\n')
}

/** 1초마다 읽는 명령 — 대상별 마지막 상태 + events.csv 의 새 부분 + 살아 있는지 */
export function buildPollCmd(runId: string, eventsOffset: number): string {
  const dir = probeDir(runId)
  return `cd ${dir} 2>/dev/null || { echo QT_NODIR; exit 0; }; cat t*.last 2>/dev/null; echo QT_EV; tail -c +${eventsOffset + 1} events.csv 2>/dev/null; echo; echo QT_ALIVE; kill -0 "$(cat pid 2>/dev/null)" 2>/dev/null && echo yes || echo no`
}

/** 측정 프로세스 그룹을 내린다 — 대상별 하위 셸까지 함께 */
export function buildStopCmd(runId: string): string {
  const dir = probeDir(runId)
  // 내렸는지 확인해 알린다 — 예전엔 늘 QT_STOPPED 를 찍어, 못 내린 측정이 '끝난 것' 으로 남았다
  return `cd ${dir} 2>/dev/null && p=$(cat pid 2>/dev/null) && [ -n "$p" ] && { kill -TERM -- -"$p" 2>/dev/null || kill -TERM "$p" 2>/dev/null; sleep 0.3; kill -KILL -- -"$p" 2>/dev/null; true; }; if [ -n "$p" ] && kill -0 "$p" 2>/dev/null; then echo QT_STILL_RUNNING; else echo QT_STOPPED; fi`
}

export interface ProbeLast {
  idx: number
  at: number
  code: string
  streak: number
  outage: boolean
  ready: boolean
}
export interface ProbeEvent {
  at: number
  idx: number
  code: string
  kind: 'ready' | 'outage' | 'recovered'
  /** ready/recovered: 연속 정상이 시작된 첫 성공 · outage: 끊김 시작 */
  base: number
  /** recovered: 그 끊김이 시작된 시각 */
  outageStart?: number
}

/**
 * 폴링 출력 해석. `eventsText` 는 바이트 오프셋을 넘기기 위해 그대로 돌려준다 — 마지막 줄이 아직 덜 쓰였으면
 * (개행 없음) 그 줄은 다음 번에 다시 읽도록 오프셋에서 뺀다.
 */
export function parsePoll(out: string): {
  noDir: boolean
  last: ProbeLast[]
  events: ProbeEvent[]
  consumed: number
  alive: boolean | null
} {
  if (/^QT_NODIR/m.test(out)) return { noDir: true, last: [], events: [], consumed: 0, alive: false }
  const evAt = out.indexOf('QT_EV\n')
  const aliveAt = out.lastIndexOf('\nQT_ALIVE\n')
  const head = evAt >= 0 ? out.slice(0, evAt) : ''
  // 폴링 명령이 덧붙인 개행(echo)은 바로 아래 '\nQT_ALIVE' 의 앞 개행이라 slice 에서 이미 빠진다.
  // 여기서 끝 개행을 한 번 더 지우면 마지막 이벤트 줄이 '덜 쓰인 줄' 로 보여 버려졌다 — 중지 직전 조회에서는 영영 빠졌다
  const evText = evAt >= 0 ? out.slice(evAt + 'QT_EV\n'.length, aliveAt >= 0 ? aliveAt : undefined) : ''
  const aliveWord = aliveAt >= 0 ? out.slice(aliveAt + '\nQT_ALIVE\n'.length).trim() : ''
  const last: ProbeLast[] = []
  for (const l of head.split('\n')) {
    const m = l.trim().match(/^(\d+) (\d{10,16}) ([A-Za-z0-9]{2,6}) (\d+) ([01]) ([01])$/)
    if (m) last.push({ idx: +m[1], at: +m[2], code: m[3], streak: +m[4], outage: m[5] === '1', ready: m[6] === '1' })
  }
  // 완성된 줄(개행으로 끝난 것)만 쓴다
  const lastNl = evText.lastIndexOf('\n')
  const complete = lastNl >= 0 ? evText.slice(0, lastNl + 1) : ''
  const events: ProbeEvent[] = []
  for (const l of complete.split('\n')) {
    const p = l.trim().split(',')
    if (p.length < 5 || !/^\d{10,16}$/.test(p[0])) continue
    const kind = p[3] as ProbeEvent['kind']
    if (kind !== 'ready' && kind !== 'outage' && kind !== 'recovered') continue
    events.push({ at: +p[0], idx: +p[1], code: p[2], kind, base: +p[4], outageStart: p[5] ? +p[5] : undefined })
  }
  return {
    noDir: false,
    last,
    events,
    consumed: new TextEncoder().encode(complete).length,
    alive: aliveWord === 'yes' ? true : aliveWord === 'no' ? false : null,
  }
}

export interface TargetSummary {
  idx: number
  name: string
  url: string
  /** 처음 정상(연속 N회)을 확인했나 — 아니면 끊김을 세지 않는다 */
  ready: boolean
  outages: { start: number; end: number | null }[]
  /** 지금 상태 */
  state: 'waiting' | 'ok' | 'down' | 'recovering' | 'never'
  lastCode: string
  lastAt: number | null
  streak: number
}
export interface ProbeSummary {
  targets: TargetSummary[]
  /** 처음 끊긴 시각(어느 대상이든) */
  firstOutage: number | null
  /** 끊겼던 대상이 **모두** 복구된 시각(가장 늦은 복구) — 하나라도 아직 끊겨 있으면 null */
  allRecovered: number | null
  /** 가장 긴 순단(ms) */
  maxGap: number | null
  okCount: number
  downCount: number
}

export function summarize(cfg: ProbeConfig, events: ProbeEvent[], last: ProbeLast[]): ProbeSummary {
  const targets: TargetSummary[] = cfg.targets.map((t, idx) => {
    const ev = events.filter((e) => e.idx === idx).sort((a, b) => a.at - b.at)
    const ready = ev.some((e) => e.kind === 'ready')
    const outages: { start: number; end: number | null }[] = []
    for (const e of ev) {
      if (e.kind === 'outage') outages.push({ start: e.base, end: null })
      else if (e.kind === 'recovered') {
        const o = [...outages].reverse().find((x) => x.end == null)
        if (o) o.end = e.base
        else if (e.outageStart) outages.push({ start: e.outageStart, end: e.base })
      }
    }
    const l = last.find((x) => x.idx === idx)
    // 끊김 이벤트 줄이 아직 덜 읽혔어도(쓰는 중) 스크립트가 남긴 '지금 끊김' 표시가 있으면 끊긴 것으로 본다
    const open = outages.some((o) => o.end == null) || !!l?.outage
    const state: TargetSummary['state'] = !l
      ? 'waiting'
      : !ready && !l.ready
        ? codeMatches(l.code, cfg)
          ? 'waiting'
          : 'never'
        : open
          ? codeMatches(l.code, cfg)
            ? 'recovering'
            : 'down'
          : 'ok'
    return { idx, name: t.name, url: t.url, ready: ready || !!l?.ready, outages, state, lastCode: l?.code ?? '-', lastAt: l?.at ?? null, streak: l?.streak ?? 0 }
  })
  const starts = targets.flatMap((t) => t.outages.map((o) => o.start))
  const anyOpen = targets.some((t) => t.outages.some((o) => o.end == null))
  const ends = targets.flatMap((t) => t.outages.map((o) => o.end).filter((x): x is number => x != null))
  const gaps = targets.flatMap((t) => t.outages.filter((o) => o.end != null).map((o) => (o.end as number) - o.start))
  return {
    targets,
    firstOutage: starts.length ? Math.min(...starts) : null,
    allRecovered: starts.length && !anyOpen ? Math.max(...ends) : null,
    maxGap: gaps.length ? Math.max(...gaps) : null,
    okCount: targets.filter((t) => t.state === 'ok').length,
    downCount: targets.filter((t) => t.state === 'down' || t.state === 'recovering').length,
  }
}

/** 회차 기록 — 이 PC 에 남긴다(측정 호스트의 CSV 는 그 서버에 그대로 남는다) */
export interface ProbeRun {
  id: string
  startedAt: number
  stoppedAt: number | null
  host: string
  /** 클라이언트 VM 의 접속 프로필 키 — 표시 이름이 바뀌어도 원문 CSV 를 받을 세션을 찾는다 */
  hostKey?: string
  dir: string
  config: ProbeConfig
  /** TCP 를 잰 도구 — 'nc'(nc -z) 또는 'devtcp'(bash /dev/tcp). 증적에 남긴다 */
  tcpTool?: 'nc' | 'devtcp'
  /** 마지막으로 받은 클라이언트 VM 시각 — 리포트의 '끝' 을 PC 시계가 아니라 서버 시계로 잡는다 */
  hostEndAt?: number
  /** 중지할 때 서버의 측정 프로세스를 내리지 못했다(세션 끊김·응답 없음) — 리포트에 밝힌다 */
  stopFailed?: boolean
  /** 원문(checks.csv)을 이 PC(userData/response-probe-raw)에 받아 뒀다 */
  rawSaved?: boolean
  events: ProbeEvent[]
  label?: string
}

/**
 * 자동 종료할 때인가 — 끊김이 한 번이라도 있었고, 끊겼던 대상이 모두 복구됐고, 지금 끊겨 있거나 복구 확인 중인
 * 대상이 없고, 마지막 복구 뒤로 settle 만큼 지났을 때. '지났다' 는 **클라이언트 VM 시계**(마지막 조회 시각)로 잰다 —
 * 복구 시각이 그 서버 시계라 PC 시계와 섞으면 시계 차이만큼 일찍·늦게 끝난다.
 */
export function shouldAutoStop(cfg: ProbeConfig, sum: ProbeSummary, last: ProbeLast[]): boolean {
  if (!cfg.autoStop || sum.firstOutage == null || sum.allRecovered == null) return false
  if (sum.targets.some((t) => t.state === 'down' || t.state === 'recovering')) return false
  const hostNow = last.length ? Math.max(...last.map((l) => l.at)) : 0
  return hostNow - sum.allRecovered >= Math.max(0, cfg.settleSec) * 1000
}

const he = (v: unknown) =>
  String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const p2 = (n: number) => String(n).padStart(2, '0')
const clk = (t: number) => {
  const d = new Date(t)
  return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`
}
const dt = (t: number) => {
  const d = new Date(t)
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${clk(t)}`
}
/**
 * 끊김 사유를 사람 말로. curl 은 연결 실패·타임아웃이면 상태 코드 대신 000 을 낸다 — 'HTTP 000' 은 무슨 뜻인지
 * 알 수 없어(사용자 지적) '응답 없음' 으로 적는다. 서버가 답은 했는데 기대 코드가 아니면 그 코드를 밝힌다.
 */
export const outageReason = (code: string, mode: ProbeMode = 'http') =>
  code === '000' || !code ? (mode === 'tcp' ? '연결 안 됨' : '응답 없음') : `HTTP ${code} 응답`

export const fmtGapText = (ms: number) => {
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}초`
  // 반올림을 먼저 — 119.6초가 '1분 60초' 로 찍혔다
  const r = Math.round(s)
  return `${Math.floor(r / 60)}분 ${p2(r % 60)}초`
}

/**
 * 측정 한 회차의 HTML 리포트 — 인터넷 없이 열리는 한 파일(CSS 내장, 스크립트 없음). 가용성 검증 리포트와 같은 모양.
 * 구성: 머리 → 주요 수치 → 요약 문장 → 대상별 끊김 구간(막대) → 대상별 표 → 이벤트 원문 → 읽는 법.
 */
export function buildProbeHtml(run: ProbeRun, sum: ProbeSummary): string {
  const failed = sum.targets.filter((x) => x.outages.length)
  const span = sum.firstOutage && sum.allRecovered ? sum.allRecovered - sum.firstOutage : null
  // 범위는 모두 **클라이언트 VM 시계**로 — 끊김·복구 시각이 그 시계라 PC 시계(startedAt·stoppedAt)와 섞으면 시계 차이만큼
  // 막대가 밀리거나 한쪽으로 몰렸다(검토 지적)
  const evTimes = run.events.flatMap((e) => [e.at, e.base])
  const hostStart = evTimes.length ? Math.min(...evTimes) : run.startedAt
  const end = run.hostEndAt ?? (evTimes.length ? Math.max(...evTimes) : run.stoppedAt ?? Date.now())
  // 막대 범위 — 첫 끊김 30초 전부터 마지막 복구 30초 뒤까지(끊김이 없으면 측정 전체)
  const lo = sum.firstOutage ? Math.max(hostStart, sum.firstOutage - 30_000) : hostStart
  const hi = sum.allRecovered ? Math.min(end, sum.allRecovered + 30_000) : end
  const W = Math.max(1, hi - lo)
  const pct = (x: number) => (((Math.min(hi, Math.max(lo, x)) - lo) / W) * 100).toFixed(2)
  const H: string[] = []
  H.push(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>응답 측정 결과</title>
<style>
:root{--fg:#1b2430;--mut:#5b6675;--line:#dfe3ea;--soft:#f5f7fa;--brand:#1f3a68;--acc:#2f6fdc;--ok:#13804b;--okbg:#e3f6ec;--warn:#a15c00;--warnbg:#fff4dd;--bad:#c62f2f;--badbg:#fdeaea}
*{box-sizing:border-box}body{font-family:"Pretendard","Segoe UI","Malgun Gothic","Apple SD Gothic Neo",sans-serif;color:var(--fg);margin:0;background:#eef1f5;font-size:13px;line-height:1.6}
.page{max-width:1120px;margin:0 auto;padding:0 24px 48px}
header{background:linear-gradient(135deg,#1f3a68,#2f6fdc);color:#fff;padding:28px 24px 26px}header .in{max-width:1072px;margin:0 auto}
header h1{margin:0;font-size:24px}header .meta{opacity:.85;margin-top:6px}
.kpis{display:grid;grid-template-columns:repeat(5,1fr);gap:12px;margin:-18px 0 8px}
.kpi{background:#fff;border-radius:12px;padding:12px 14px;box-shadow:0 1px 3px rgba(20,30,50,.08);border-top:3px solid var(--acc)}
.kpi span{display:block;color:var(--mut);font-size:12px}.kpi b{display:block;font-size:21px;font-variant-numeric:tabular-nums}.kpi.ok{border-top-color:var(--ok)}.kpi.bad{border-top-color:var(--bad)}
section{background:#fff;border-radius:14px;box-shadow:0 1px 3px rgba(20,30,50,.08);padding:18px 20px;margin-top:16px}
h2{font-size:16px;margin:0 0 12px;padding-bottom:8px;border-bottom:2px solid var(--soft);color:var(--brand)}
ul.sum{list-style:none;margin:0;padding:0;display:grid;gap:6px}ul.sum li{padding:8px 12px;border-radius:8px;background:var(--soft);border-left:4px solid var(--acc)}ul.sum li.ok{background:var(--okbg);border-left-color:var(--ok)}ul.sum li.warn{background:var(--warnbg);border-left-color:var(--warn)}
table{border-collapse:separate;border-spacing:0;width:100%;border:1px solid var(--line);border-radius:10px;overflow:hidden}
th{background:#eef2f8;font-weight:600;font-size:12px;padding:8px;text-align:center;border-bottom:1px solid var(--line)}td{padding:7px 8px;border-bottom:1px solid var(--line);text-align:center;font-variant-numeric:tabular-nums}
tr:last-child td{border-bottom:0}td.l{text-align:left}tbody tr:nth-child(even) td{background:#fafbfd}
.lead{font-size:12.5px;color:var(--mut);margin:0 0 12px}.lead b{color:var(--fg)}
.flow{display:grid;grid-template-columns:120px 1fr 190px;gap:8px 14px;align-items:center;font-size:12px}
.fh{color:var(--mut);font-size:11.5px;font-weight:600}
.lane{position:relative;height:30px}
.track{position:absolute;inset:4px 0;background:var(--okbg);border-radius:6px}
.grid{position:absolute;top:0;bottom:0;width:0;border-left:1px solid rgba(20,30,50,.07)}
.out{position:absolute;top:4px;bottom:4px;background:#e5534b;border-radius:5px;color:#fff;font-size:11px;font-weight:600;display:flex;align-items:center;justify-content:center;white-space:nowrap;overflow:hidden;min-width:3px}
.mark{position:absolute;top:-2px;bottom:-2px;width:0;border-left:2px dashed}
.mark.first{border-color:#c62f2f}.mark.done{border-color:#13804b}
.marks{position:relative;height:34px}
.mlab{position:absolute;bottom:2px;transform:translateX(-50%);font-size:11px;font-weight:600;white-space:nowrap;padding:1px 6px;border-radius:4px}
.mlab.first{background:var(--badbg);color:var(--bad)}.mlab.done{background:var(--okbg);color:var(--ok)}
.axis{position:relative;height:18px}
.tick{position:absolute;transform:translateX(-50%);font-size:11px;color:var(--mut);white-space:nowrap}
.rt{font-size:11.5px;line-height:1.4}.rt b{font-size:13px}
.legend{display:flex;flex-wrap:wrap;gap:14px;font-size:12px;color:var(--mut);margin-top:12px}
.legend i{display:inline-block;width:18px;height:10px;border-radius:3px;margin-right:5px;vertical-align:-1px}
.mut{color:var(--mut)}code,.pre{font-family:Consolas,"D2Coding",monospace;font-size:11.5px}.pre{background:#f6f8fb;border:1px solid var(--line);border-radius:8px;padding:8px;white-space:pre-wrap;max-height:420px;overflow:auto}
.bad{color:var(--bad)}.okc{color:var(--ok)}
@media print{body{background:#fff}section,.kpi{box-shadow:none;border:1px solid var(--line)}.pre{max-height:none}header{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
</style></head><body>`)
  H.push(`<header><div class="in"><h1>응답 측정 결과${run.label ? ` — ${he(run.label)}` : ''}</h1><div class="meta">${he(dt(run.startedAt))} ~ ${run.stoppedAt ? he(dt(run.stoppedAt)) : '진행 중'} · 클라이언트 VM ${he(run.host)} · ${he(modeText(run.config))}${run.tcpTool ? ` (${run.tcpTool === 'nc' ? 'nc -z' : 'bash /dev/tcp'})` : ''} · 주기 ${run.config.intervalSec}초 · 연속 ${run.config.needOk}회면 복구</div></div></header><div class="page">`)
  const k = (cls: string, label: string, v: string) => `<div class="kpi ${cls}"><span>${label}</span><b>${v}</b></div>`
  H.push(
    `<div class="kpis">${k('', '대상', `${sum.targets.length}대`)}${k(failed.length ? 'bad' : 'ok', '끊겼던 대상', `${failed.length}대`)}${k('', '첫 끊김', sum.firstOutage ? clk(sum.firstOutage) : '-')}${k('ok', '모두 복구', sum.allRecovered ? clk(sum.allRecovered) : sum.firstOutage ? '복구 안 됨' : '-')}${k('', '첫 끊김 → 모두 복구', span != null ? fmtGapText(span) : '-')}</div>`,
  )
  const S: string[] = []
  if (!failed.length) S.push(`<li class="ok">측정하는 동안 끊긴 대상이 없습니다 (${sum.targets.length}대 모두 정상 유지).</li>`)
  else {
    S.push(`<li>${sum.targets.length}대 중 <b>${failed.length}대</b>가 끊겼습니다 — 첫 끊김 ${he(dt(sum.firstOutage as number))}.</li>`)
    if (span != null)
      S.push(`<li class="ok">끊겼던 대상이 <b>모두 복구</b>된 시각 ${he(dt(sum.allRecovered as number))} — 첫 끊김부터 <b>${fmtGapText(span)}</b>.</li>`)
    else S.push(`<li class="warn">측정을 끝낼 때까지 복구되지 않은 대상이 있습니다 — ${he(failed.filter((x) => x.outages.some((o) => o.end == null)).map((x) => x.name).join(', '))}.</li>`)
    if (sum.maxGap != null) {
      const worst = failed.reduce((a, b) => (Math.max(...b.outages.map((o) => (o.end ?? end) - o.start)) > Math.max(...a.outages.map((o) => (o.end ?? end) - o.start)) ? b : a))
      S.push(`<li>가장 긴 순단 <b>${fmtGapText(sum.maxGap)}</b> — ${he(worst.name)}.</li>`)
    }
    const multi = failed.filter((x) => x.outages.length > 1)
    if (multi.length) S.push(`<li class="warn">두 번 이상 끊긴 대상 ${multi.length}대 — ${he(multi.map((x) => `${x.name}(${x.outages.length}회)`).join(', '))}.</li>`)
  }
  const never = sum.targets.filter((x) => !x.ready)
  if (run.stopFailed)
    S.push(`<li class="warn">측정을 끝낼 때 클라이언트 VM 의 측정 프로세스를 내리지 못했습니다 — 서버에서 직접 정리하세요(<code>${he(run.dir)}</code>, 최대 ${run.config.maxMin ?? 180}분 뒤 스스로 멈춤).</li>`)
  if (never.length) S.push(`<li class="warn">처음부터 정상을 확인하지 못한 대상 ${never.length}대(끊김을 세지 않음) — ${he(never.map((x) => x.name).join(', '))}.</li>`)
  H.push(`<section><h2>요약</h2><ul class="sum">${S.join('')}</ul></section>`)

  /**
   * 대상별 끊김 구간 — 처음엔 막대와 시각 셋만 있어 무엇을 보라는 건지 알기 어려웠다(사용자 지적).
   * 왼쪽→오른쪽이 시간 흐름이라는 것, 빨간 구간이 '응답이 없던 시간' 이라는 것, 첫 끊김·모두 복구가 언제인지를
   * 그림 위에 직접 적는다. 막대 안에 그 구간의 순단을, 오른쪽에 끊김 → 복구 시각을 같이 둔다.
   */
  const STEPS = [5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600].map((x) => x * 1000)
  const step = STEPS.find((x) => W / x <= 8) ?? 3_600_000
  const ticks: number[] = []
  for (let t = Math.ceil(lo / step) * step; t <= hi; t += step) ticks.push(t)
  const gridLines = ticks.map((t) => `<span class="grid" style="left:${pct(t)}%"></span>`).join('')
  const markLines =
    (sum.firstOutage ? `<span class="mark first" style="left:${pct(sum.firstOutage)}%"></span>` : '') +
    (sum.allRecovered ? `<span class="mark done" style="left:${pct(sum.allRecovered)}%"></span>` : '')
  H.push(`<section><h2>대상별 끊김 구간</h2>`)
  H.push(
    `<p class="lead">왼쪽에서 오른쪽으로 시간이 흐릅니다. <b>빨간 구간</b>이 그 대상이 응답하지 않은 시간이고, 막대 안 숫자가 그 길이(순단)입니다.` +
      (sum.firstOutage && sum.allRecovered
        ? ` <b>첫 끊김 ${clk(sum.firstOutage)}</b> 부터 <b>모두 복구 ${clk(sum.allRecovered)}</b> 까지 <b>${fmtGapText(sum.allRecovered - sum.firstOutage)}</b> 걸렸습니다.`
        : '') +
      `</p>`,
  )
  H.push(`<div class="flow"><div class="fh">대상</div><div class="marks">`)
  if (sum.firstOutage) H.push(`<span class="mlab first" style="left:${pct(sum.firstOutage)}%">첫 끊김 ${clk(sum.firstOutage)}</span>`)
  if (sum.allRecovered) H.push(`<span class="mlab done" style="left:${pct(sum.allRecovered)}%">모두 복구 ${clk(sum.allRecovered)}</span>`)
  H.push(`</div><div class="fh">끊김 → 복구 · 순단</div>`)
  for (const x of sum.targets) {
    const bars = x.outages
      .map((o) => {
        const w = +pct(o.end ?? end) - +pct(o.start)
        const label = w >= 9 ? (o.end ? fmtGapText(o.end - o.start) : '복구 안 됨') : ''
        return `<span class="out" title="${clk(o.start)} → ${o.end ? clk(o.end) : '복구 안 됨'}" style="left:${pct(o.start)}%;width:${w.toFixed(2)}%">${label}</span>`
      })
      .join('')
    const right = x.outages.length
      ? x.outages
          .map(
            (o) =>
              `<div class="rt"><span class="mut">${clk(o.start)} → ${o.end ? clk(o.end) : '복구 안 됨'}</span><br><b class="bad">${o.end ? fmtGapText(o.end - o.start) : '-'}</b></div>`,
          )
          .join('')
      : `<div class="rt"><b class="okc">${x.ready ? '끊김 없음' : '응답 없음'}</b></div>`
    H.push(`<div>${he(x.name)}</div><div class="lane"><div class="track"></div>${gridLines}${bars}${markLines}</div><div>${right}</div>`)
  }
  H.push(`<div></div><div class="axis">${ticks.map((t) => `<span class="tick" style="left:${pct(t)}%">${clk(t)}</span>`).join('')}</div><div></div></div>`)
  H.push(
    `<div class="legend"><span><i style="background:var(--okbg);border:1px solid #bfe3cc"></i>정상 응답</span><span><i style="background:#e5534b"></i>응답 없음(끊김)</span><span><i style="border-left:2px dashed #c62f2f;width:2px;border-radius:0"></i>첫 끊김</span><span><i style="border-left:2px dashed #13804b;width:2px;border-radius:0"></i>모두 복구</span><span>그림 범위: 첫 끊김 30초 전 ~ 마지막 복구 30초 뒤</span></div></section>`,
  )

  H.push(`<section><h2>대상별 기록</h2><table><thead><tr><th>대상</th><th>주소</th><th>끊김</th><th>복구 첫 성공 시간</th><th>순단</th><th>끊김 횟수</th></tr></thead><tbody>`)
  for (const x of sum.targets) {
    if (!x.outages.length) {
      H.push(`<tr><td class="l">${he(x.name)}</td><td class="l"><code>${he(displayAddr(x.url))}</code></td><td>-</td><td>-</td><td class="okc">${x.ready ? '끊김 없음' : '응답 없음'}</td><td>0</td></tr>`)
      continue
    }
    x.outages.forEach((o, i) =>
      H.push(
        `<tr><td class="l">${i ? '' : he(x.name)}</td><td class="l">${i ? '' : `<code>${he(displayAddr(x.url))}</code>`}</td><td>${clk(o.start)}</td><td>${o.end ? clk(o.end) : '<span class="bad">복구 안 됨</span>'}</td><td class="bad">${o.end ? fmtGapText(o.end - o.start) : '-'}</td><td>${i ? '' : x.outages.length}</td></tr>`,
      ),
    )
  }
  H.push(`</tbody></table></section>`)
  const evText = run.events
    .map((e) => `${dt(e.at)}  ${run.config.targets[e.idx]?.name ?? e.idx}  ${e.kind === 'ready' ? '첫 정상 확인' : e.kind === 'outage' ? `끊김 (${outageReason(e.code, run.config.mode)})` : `복구 첫 성공 시간(${clk(e.base)})${e.outageStart ? ` · 순단 ${fmtGapText(e.base - e.outageStart)}` : ''}`}   # ${e.at},${e.idx},${e.code},${e.kind},${e.base}${e.outageStart ? ',' + e.outageStart : ''}`)
    .join('\n')
  H.push(`<section><h2>타임라인 (원문)</h2><p class="mut" style="font-size:12px;margin:0 0 6px">클라이언트 VM <code>${he(run.dir)}/events.csv</code> — 모든 요청 기록은 같은 곳의 checks.csv</p><div class="pre">${he(evText) || '(없음)'}</div></section>`)
  H.push(`<section><h2>읽는 법</h2><ul class="sum"><li>끊김 = 처음 정상(연속 ${run.config.needOk}회)을 확인한 뒤의 첫 실패. 복구 = 다시 연속 ${run.config.needOk}회 정상(${he(modeText(run.config))})이 된 연속의 <b>첫 성공 시각</b>(한 번 튄 성공은 복구로 세지 않음).</li><li>시각은 클라이언트 VM 의 시계이며, 요청을 보내기 직전에 찍었습니다(타임아웃만큼 늦게 찍히지 않음). 응답이 없는 동안은 요청이 타임아웃까지 기다리므로 끊김·복구 시각의 오차는 최대 약 ${Math.max(run.config.intervalSec, run.config.timeoutSec)}초입니다. 끊김은 연속 ${run.config.needFail ?? 1}회 실패부터이고, 시각은 그 첫 실패입니다.</li></ul></section></div></body></html>`)
  return H.join('\n')
}

// ── 노드 VM 불러오기 (Nova) ──────────────────────────────────

export interface NovaServer {
  id: string
  name: string
  status: string
  /** IPv4 주소들 — 첫 번째를 대상으로 쓴다 */
  ips: string[]
}

/**
 * `openstack server list --all-projects --host <노드> -f json -c ID -c Name -c Status -c Networks` → VM 목록.
 * Networks 는 CLI 버전에 따라 `"net1=10.0.0.5, 172.24.4.10; net2=…"` 문자열이거나 `{"net1": ["10.0.0.5", …]}` 객체다 — 둘 다 받는다.
 * JSON 배열이 아니면 null(조회 실패 ≠ VM 없음).
 */
export function parseNovaServers(json: string): NovaServer[] | null {
  let arr: unknown
  try {
    arr = JSON.parse(json)
  } catch {
    return null
  }
  if (!Array.isArray(arr)) return null
  const v4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g
  return arr
    .map((raw) => {
      const r = raw as Record<string, unknown>
      const nets = r['Networks']
      const text = typeof nets === 'string' ? nets : nets && typeof nets === 'object' ? JSON.stringify(nets) : ''
      return {
        id: String(r['ID'] ?? ''),
        name: String(r['Name'] ?? ''),
        status: String(r['Status'] ?? ''),
        ips: Array.from(new Set(text.match(v4) ?? [])),
      }
    })
    .filter((x) => x.id)
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** `openstack hypervisor list -f json` → 컴퓨트 호스트 이름들(없으면 빈 배열, 실패면 null) */
export function parseHypervisors(json: string): string[] | null {
  let arr: unknown
  try {
    arr = JSON.parse(json)
  } catch {
    return null
  }
  if (!Array.isArray(arr)) return null
  return Array.from(
    new Set(arr.map((r) => String((r as Record<string, unknown>)['Hypervisor Hostname'] ?? '')).filter(Boolean)),
  ).sort()
}
