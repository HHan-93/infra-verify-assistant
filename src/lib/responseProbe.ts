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
  /**
   * 장애 노드 — 대상 VM 을 모아 두고 내릴 노드(2026-11-15 사용자 결정: 리포트 측정 구성 · 회차를 장애 노드별로 묶는 데 쓴다).
   * [노드 VM 불러오기] 로 넣으면 그 컴퓨트 호스트가 들어가고, 사람이 고칠 수 있다. 측정 판정에는 쓰지 않는다
   */
  failNode?: string
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
# Q-Term 응답 측정: 대상마다 병렬로 응답(HTTP 코드 · TCP 연결 · ping)을 재고, 끊김·복구를 events.csv 에 남긴다.
# events.csv : epoch_ms,대상번호,결과,이벤트(ready|outage|recovered),기준시각_ms[,끊김시작_ms]
# checks.csv : epoch_ms,대상번호,결과   (모든 요청): 결과: HTTP 코드 / OPEN / OK, 실패는 000
D="$(cd "$(dirname "$0")" && pwd)"
INTERVAL=$1; TIMEOUT=$2; NEED=$3; EXPECT=$4; MODE=$5; NEEDF=$6; MAXSEC=$7; FOLLOW=$8; HOSTHDR=$9; shift 9
HTTP_ARGS=(-k -s -o /dev/null -w '%{http_code}' --connect-timeout "$TIMEOUT" --max-time "$TIMEOUT")
[ "$FOLLOW" = 1 ] && HTTP_ARGS+=(-L)
[ -n "$HOSTHDR" ] && HTTP_ARGS+=(-H "Host: $HOSTHDR")
# 정상 표식: EXPECT 는 쉼표로 여러 개, x 는 아무 글자(2xx). glob 을 쓰지 않으려고 한 글자씩 견준다
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
  local lim
  while :; do
    # 최대 시간은 maxsec 파일에서 매번 다시 읽는다. 측정 중 [+30분] 연장이 끊김 없이 이어지게(파일이 없으면 인자 값).
    # cat 을 쓰면 주기마다 프로세스가 하나 더 떠 1초 주기가 밀린다(검사에서 걸렸다). 셸 내장 read 로 읽는다
    read -r lim 2>/dev/null < "$D/maxsec" || lim=$MAXSEC
    [ $(( $(date +%s) - START )) -lt "\${lim:-$MAXSEC}" ] || break
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
        errors.push(`${li + 1}번째 줄: 주소로 읽을 수 없습니다. ${line}`)
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
      errors.push(`${li + 1}번째 줄: 주소로 읽을 수 없습니다. ${line}`)
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
          `else echo 'QT_ERR -z 를 지원하는 nc 도, timeout 도 없습니다. TCP 연결을 잴 수 없습니다'; exit 1; fi`,
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
    `: > events.csv; : > checks.csv; echo ${maxSec} > maxsec`,
    ...(mode === 'tcp' ? [`echo "$QT_TCP" > tcp_tool; echo "QT_TOOL $QT_TCP"`] : []),
    `setsid nohup bash ./probe.sh ${args.join(' ')} ${targetArgs.join(' ')} > run.log 2>&1 < /dev/null &`,
    `echo $! > pid`,
    `echo "QT_STARTED $(cat pid)"`,
  ].join('\n')
}

/**
 * 1초마다 읽는 명령 — 대상별 마지막 상태 + events.csv 의 새 부분 + 살아 있는지 + (끝났다면) 최대 시간으로 끝났는지.
 * 스크립트는 최대 시간이 다 되면 run.log 에 `QT_EXPIRED <ms>` 를 남기고 스스로 끝난다. 예전에는 이걸 읽지 않아, 설정대로
 * 30분에 끝난 것을 '프로세스가 멈췄다(재부팅?)' 는 오류로 보여 주고 경과 시간만 계속 올렸다(2026-10-26 사용자 지적).
 */
export function buildPollCmd(runId: string, eventsOffset: number): string {
  const dir = probeDir(runId)
  return `cd ${dir} 2>/dev/null || { echo QT_NODIR; exit 0; }; cat t*.last 2>/dev/null; echo QT_EV; tail -c +${eventsOffset + 1} events.csv 2>/dev/null; echo; echo QT_ALIVE; kill -0 "$(cat pid 2>/dev/null)" 2>/dev/null && echo yes || echo no; grep -h QT_EXPIRED run.log 2>/dev/null | tail -n 1`
}

/**
 * 측정 중 최대 시간을 늘린다 — 스크립트가 maxsec 파일을 매 주기 다시 읽는다. 이 기능 전의 스크립트(2.13.0)는 파일을 읽지 않아
 * 늘려도 소용이 없으므로 그때는 QT_OLD 로 알린다(조용히 '늘렸다' 고 하면 그 시각에 측정이 끊겨 놀란다).
 */
export function buildExtendCmd(runId: string, maxSec: number): string {
  const dir = probeDir(runId)
  return `cd ${dir} 2>/dev/null || { echo QT_NODIR; exit 0; }; grep -q maxsec probe.sh || { echo QT_OLD; exit 0; }; echo ${Math.max(60, Math.floor(maxSec))} > maxsec && echo QT_OK`
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
  /** 최대 측정 시간이 다 돼 스크립트가 스스로 끝낸 시각(클라이언트 VM 시계) — 비정상 중단과 가른다 */
  expiredAt: number | null
} {
  if (/^QT_NODIR/m.test(out)) return { noDir: true, last: [], events: [], consumed: 0, alive: false, expiredAt: null }
  const evAt = out.indexOf('QT_EV\n')
  const aliveAt = out.lastIndexOf('\nQT_ALIVE\n')
  const head = evAt >= 0 ? out.slice(0, evAt) : ''
  // 폴링 명령이 덧붙인 개행(echo)은 바로 아래 '\nQT_ALIVE' 의 앞 개행이라 slice 에서 이미 빠진다.
  // 여기서 끝 개행을 한 번 더 지우면 마지막 이벤트 줄이 '덜 쓰인 줄' 로 보여 버려졌다 — 중지 직전 조회에서는 영영 빠졌다
  const evText = evAt >= 0 ? out.slice(evAt + 'QT_EV\n'.length, aliveAt >= 0 ? aliveAt : undefined) : ''
  const tail = aliveAt >= 0 ? out.slice(aliveAt + '\nQT_ALIVE\n'.length) : ''
  const aliveWord = tail.trim().split('\n')[0]?.trim() ?? ''
  const exp = tail.match(/QT_EXPIRED (\d{10,16})/)
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
    expiredAt: exp ? +exp[1] : null,
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
  /**
   * 어떻게 끝났나 — auto: 모두 복구돼 자동 종료 · manual: [측정 중지] · max_time: 최대 측정 시간 도달(서버가 스스로 끝냄).
   * max_time 인데 끊긴 채인 대상은 '그 시간 안에 복구 안 됨' 으로 확정이다 — 리포트가 그 사실을 따로 적는다.
   */
  endReason?: 'auto' | 'manual' | 'max_time'
  events: ProbeEvent[]
  label?: string
  /**
   * 측정이 끝난 뒤 Nova 에서 읽은 대상 VM 위치(대상 번호 → 호스트) — 리포트의 evacuation 그림. 조회만 한다.
   * 장애 노드 · OpenStack 조회 세션이 없거나 읽기에 실패하면 비고(locErr 에 이유), 리포트는 '위치 모름' 으로 그린다
   */
  vmHosts?: Record<number, string>
  locErr?: string
  /** 사람이 단 판정 의견(ProbeOpinion 주석) */
  opinion?: ProbeOpinion
}

/**
 * 회차 판정 의견(2026-11-16 사용자 결정 · 목업 probe-note-mock): 툴 판정(RTO)만으로는 '왜 실패인가' 가 남지 않았다.
 * 3회차 1세트(contrabass02)는 10대가 모두 돌아왔지만 2대가 Masakari 재시도로 20분 만에 돌아와, 회차 이름 끝에 '- 실패' 를 붙이는 것밖에
 * 적을 곳이 없었다. 사람이 판정(통과 · 실패 · 참고)과 글을 달고, 리포트는 **사람 판정과 툴 판정을 둘 다** 보인다(사용자 결정 —
 * RTO 안에 들었어도 사람이 실패로 볼 수 있고, 그 반대도 있다. 한쪽으로 덮지 않는다).
 * 글은 첫 줄이 요약(종합 리포트 목록에 실림), 다음 줄부터 '-' 로 세부. 리포트에 실을 때 마스킹은 리포트 전체에 거는 maskForExport 가 한다
 */
export type ProbeVerdict = 'none' | 'pass' | 'fail' | 'info'
export interface ProbeOpinion {
  verdict: ProbeVerdict
  text: string
  /** 마지막으로 고친 시각 */
  at: number
}
export const VERDICT_LABEL: Record<ProbeVerdict, string> = { none: '판정 안 함', pass: '통과', fail: '실패', info: '참고' }
/** 실을 것이 있는 의견인가 — 판정도 글도 없으면 리포트에서 뺀다 */
export const hasOpinion = (o?: ProbeOpinion): o is ProbeOpinion => !!o && (o.verdict !== 'none' || !!o.text.trim())
/** 의견 글 → 첫 줄(요약) · 나머지 줄(앞의 '-' 를 떼어 둔다, 그릴 때 다시 붙인다) */
export function opinionLines(text: string): { title: string; lines: string[] } {
  const ls = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  return { title: (ls[0] ?? '').replace(/^[-–·]\s*/, ''), lines: ls.slice(1).map((l) => l.replace(/^[-–·]\s*/, '')) }
}
/** 툴 판정(RTO) — 끊김이 있었고 모두 복구됐으면 시간으로, 미복구면 실패, 끊김이 없으면 판정할 것이 없다. 화면 · 리포트가 같이 쓴다 */
export function rtoVerdict(sum: ProbeSummary, rtoMin: number): { cls: 'ok' | 'bad' | ''; text: string; span: number | null } {
  const rto = Math.max(1, Math.round(rtoMin)) * 60_000
  const span = sum.firstOutage && sum.allRecovered ? sum.allRecovered - sum.firstOutage : null
  if (span != null) return { cls: span <= rto ? 'ok' : 'bad', text: span <= rto ? '통과' : '초과', span }
  return sum.firstOutage ? { cls: 'bad', text: '미복구', span: null } : { cls: '', text: '-', span: null }
}
const OP_CLS: Record<ProbeVerdict, string> = { none: '', pass: 'ok', fail: 'bad', info: '' }
/** 리포트의 판정 의견 상자 — 한 회차 리포트 · 종합 리포트 회차별 상세가 같이 쓴다 */
function opinionBox(o: ProbeOpinion, tool: string): string {
  const { title, lines } = opinionLines(o.text)
  const pill = o.verdict !== 'none' ? `<span class="pill ${OP_CLS[o.verdict]}">${VERDICT_LABEL[o.verdict]}</span>` : ''
  return `<div class="op ${OP_CLS[o.verdict]}"><div class="t">${pill}<b>판정 의견${title ? `: ${he(title)}` : ''}</b><span class="mut tl">툴 판정: ${he(tool)}</span></div>${lines.length ? `<div class="l">${lines.map((l) => `<div>- ${he(l)}</div>`).join('')}</div>` : ''}<div class="mut who">${he(dt(o.at).slice(0, 16))} 작성</div></div>`
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

/**
 * 저장 파일 이름 — 회차 이름이 있으면 넣는다(사용자 요청 10-28: 여러 회차를 받아 두면 날짜만으로는 어느 것인지 몰랐다).
 * Windows 파일 이름에 못 쓰는 글자 · 공백은 '-' 로, 너무 길면 자른다. 이름을 못 쓰게 되면(전부 금지 글자) 날짜만 쓴다.
 */
export const fileStem = (prefix: string, run: ProbeRun) => {
  const d = new Date(run.startedAt)
  const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}`
  const name = (run.label ?? '')
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 40)
  return name ? `${prefix}_${name}_${stamp}` : `${prefix}_${stamp}`
}
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

/** 응답 측정 리포트 공통 꾸밈 — 한 회차 · 종합 리포트가 같이 쓴다(가용성 검증 리포트와 같은 모양) */
const PROBE_CSS = `:root{--fg:#1b2430;--mut:#5b6675;--line:#dfe3ea;--soft:#f5f7fa;--brand:#1f3a68;--acc:#2f6fdc;--ok:#13804b;--okbg:#e3f6ec;--warn:#a15c00;--warnbg:#fff4dd;--bad:#c62f2f;--badbg:#fdeaea}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{font-family:"Pretendard","Segoe UI","Malgun Gothic","Apple SD Gothic Neo",sans-serif;color:var(--fg);margin:0;background:#eef1f5;font-size:13px;line-height:1.6}
.page{max-width:1120px;margin:0 auto;padding:0 24px 48px}
header{background:linear-gradient(135deg,#1f3a68,#2f6fdc);color:#fff;padding:28px 24px 26px}header .in{max-width:1072px;margin:0 auto}
header h1{margin:0;font-size:24px}header .meta{opacity:.85;margin-top:6px}
.kpis{display:grid;grid-template-columns:repeat(5,1fr);gap:12px;margin:-18px 0 8px}
.kpi{background:#fff;border-radius:12px;padding:12px 14px;box-shadow:0 1px 3px rgba(20,30,50,.08);border-top:3px solid var(--acc)}
.kpi span{display:block;color:var(--mut);font-size:12px}.kpi b{display:block;font-size:21px;font-variant-numeric:tabular-nums}.kpi small{display:block;color:var(--mut);font-size:11.5px}.kpi.ok{border-top-color:var(--ok)}.kpi.bad{border-top-color:var(--bad)}.kpi.warn{border-top-color:var(--warn)}
section{background:#fff;border-radius:14px;box-shadow:0 1px 3px rgba(20,30,50,.08);padding:18px 20px;margin-top:16px}
h2{font-size:16px;margin:0 0 12px;padding-bottom:8px;border-bottom:2px solid var(--soft);color:var(--brand)}
h3{font-size:13.5px;margin:16px 0 6px;color:var(--brand)}
ul.sum{list-style:none;margin:0;padding:0;display:grid;gap:6px}ul.sum li{padding:8px 12px;border-radius:8px;background:var(--soft);border-left:4px solid var(--acc)}ul.sum li.ok{background:var(--okbg);border-left-color:var(--ok)}ul.sum li.warn{background:var(--warnbg);border-left-color:var(--warn)}
table{border-collapse:separate;border-spacing:0;width:100%;border:1px solid var(--line);border-radius:10px;overflow:hidden}
th{background:#eef2f8;font-weight:600;font-size:12px;padding:8px;text-align:center;border-bottom:1px solid var(--line)}td{padding:7px 8px;border-bottom:1px solid var(--line);text-align:center;font-variant-numeric:tabular-nums}
tr:last-child td{border-bottom:0}td.l{text-align:left}tbody tr:nth-child(even) td{background:#fafbfd}
tr.avg td{background:#eef2f8!important;font-weight:700}
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
.bad{color:var(--bad)}.okc{color:var(--ok)}.best{color:var(--ok);font-weight:700}.worst{color:var(--warn);font-weight:700}
.cmpbar{display:grid;grid-template-columns:170px 1fr 92px;gap:6px 12px;align-items:center;font-size:12px}
.cb{position:relative;height:22px;background:var(--soft);border-radius:6px}.cb .f{position:absolute;left:0;top:5px;height:12px;border-radius:4px;background:#2f6fdc}.cb .f.worst{background:#e08a1e}.cb .f.open{background:repeating-linear-gradient(45deg,#e5534b 0 6px,#f19a95 6px 12px)}
.cb .g{position:absolute;top:1px;bottom:1px;width:0;border-left:2px solid #c62f2f}
table.heat td.h{font-weight:600}table.heat td.h0{color:#a0a8b5}table.heat .avg{white-space:nowrap;font-weight:700;background:#f5f7fa}
details.run{border:1px solid var(--line);border-radius:12px;margin:8px 0;background:#fff;scroll-margin-top:12px}
details.run>summary{list-style:none;cursor:pointer;padding:10px 14px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:13px}
details.run>summary::-webkit-details-marker{display:none}details.run>summary:before{content:'▸';color:var(--mut)}details.run[open]>summary:before{content:'▾'}
details.run[open]>summary{border-bottom:1px solid var(--line);background:var(--soft);border-radius:12px 12px 0 0}
.rb{padding:12px 16px 16px}.pill{border-radius:999px;padding:1px 9px;font-size:11.5px;background:var(--soft);color:var(--mut)}.pill.ok{background:var(--okbg);color:var(--ok)}.pill.bad{background:var(--badbg);color:var(--bad)}.pill.warn{background:var(--warnbg);color:var(--warn)}
a{color:var(--acc);text-decoration:none}a:hover{text-decoration:underline}
.op{background:#fff;border:1px solid var(--line);border-left:4px solid #9aa3af;border-radius:10px;padding:10px 14px;margin-top:12px}.op.bad{border-color:#f0c4c4;border-left-color:var(--bad);background:#fffafa}.op.ok{border-color:#bfe3cd;border-left-color:var(--ok);background:#f8fdf9}
.op .t{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.op .t .tl{margin-left:auto;font-size:11.5px}.op.bad .t b{color:#8a1f1f}
.op .l{margin-top:5px;line-height:1.65}.op .l div{padding-left:.85em;text-indent:-.85em}.op .who{font-size:11px;margin-top:5px}
ul.ops{list-style:none;margin:0;padding:0;display:grid;gap:6px}ul.ops li{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}ul.ops li .nm{min-width:200px}
@media print{body{background:#fff}section,.kpi{box-shadow:none;border:1px solid var(--line)}.pre{max-height:none}header{-webkit-print-color-adjust:exact;print-color-adjust:exact}details.run{break-inside:auto}}
@media (max-width:820px){.kpis{grid-template-columns:repeat(2,1fr)}.flow{grid-template-columns:90px 1fr 120px}.cmpbar{grid-template-columns:110px 1fr 70px}}`

/** 한 회차의 그림 범위 · 요약 · 끊김 구간 그림 · 대상별 표 — 한 회차 리포트와 종합 리포트의 회차별 상세가 같이 쓴다 */
function probeParts(run: ProbeRun, sum: ProbeSummary) {
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

  const S: string[] = []
  if (!failed.length) S.push(`<li class="ok">측정하는 동안 끊긴 대상이 없습니다 (${sum.targets.length}대 모두 정상 유지).</li>`)
  else {
    S.push(`<li>${sum.targets.length}대 중 <b>${failed.length}대</b>가 끊겼습니다. 첫 끊김 ${he(dt(sum.firstOutage as number))}.</li>`)
    if (span != null)
      S.push(`<li class="ok">끊겼던 대상이 <b>모두 복구</b>된 시각 ${he(dt(sum.allRecovered as number))}: 첫 끊김부터 <b>${fmtGapText(span)}</b>.</li>`)
    else {
      const open = failed.filter((x) => x.outages.some((o) => o.end == null))
      S.push(
        run.endReason === 'max_time'
          ? `<li class="warn"><b>최대 측정 시간(${run.config.maxMin ?? 180}분) 안에 복구되지 않은</b> 대상 ${open.length}대: ${he(open.map((x) => x.name).join(', '))}. 측정은 그 시간에 서버가 스스로 끝냈습니다.</li>`
          : `<li class="warn">측정을 끝낼 때까지 복구되지 않은 대상이 있습니다. ${he(open.map((x) => x.name).join(', '))}.</li>`,
      )
    }
    if (sum.maxGap != null) {
      const worst = failed.reduce((a, b) => (Math.max(...b.outages.map((o) => (o.end ?? end) - o.start)) > Math.max(...a.outages.map((o) => (o.end ?? end) - o.start)) ? b : a))
      S.push(`<li>가장 긴 순단 <b>${fmtGapText(sum.maxGap)}</b> ${he(worst.name)}.</li>`)
    }
    const multi = failed.filter((x) => x.outages.length > 1)
    if (multi.length) S.push(`<li class="warn">두 번 이상 끊긴 대상 ${multi.length}대: ${he(multi.map((x) => `${x.name}(${x.outages.length}회)`).join(', '))}.</li>`)
  }
  const never = sum.targets.filter((x) => !x.ready)
  if (run.stopFailed)
    S.push(`<li class="warn">측정을 끝낼 때 클라이언트 VM 의 측정 프로세스를 내리지 못했습니다. 서버에서 직접 정리하세요(<code>${he(run.dir)}</code>, 최대 ${run.config.maxMin ?? 180}분 뒤 스스로 멈춤).</li>`)
  if (never.length) S.push(`<li class="warn">처음부터 정상을 확인하지 못한 대상 ${never.length}대(끊김을 세지 않음): ${he(never.map((x) => x.name).join(', '))}.</li>`)

  /**
   * 대상별 끊김 구간 — 처음엔 막대와 시각 셋만 있어 무엇을 보라는 건지 알기 어려웠다(사용자 지적).
   * 왼쪽→오른쪽이 시간 흐름이라는 것, 빨간 구간이 '응답이 없던 시간' 이라는 것, 첫 끊김·모두 복구가 언제인지를
   * 그림 위에 직접 적는다. 막대 안에 그 구간의 순단을, 오른쪽에 끊김 → 복구 시각을 같이 둔다.
   */
  const F: string[] = []
  const STEPS = [5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600].map((x) => x * 1000)
  const step = STEPS.find((x) => W / x <= 8) ?? 3_600_000
  const ticks: number[] = []
  for (let t = Math.ceil(lo / step) * step; t <= hi; t += step) ticks.push(t)
  const gridLines = ticks.map((t) => `<span class="grid" style="left:${pct(t)}%"></span>`).join('')
  const markLines =
    (sum.firstOutage ? `<span class="mark first" style="left:${pct(sum.firstOutage)}%"></span>` : '') +
    (sum.allRecovered ? `<span class="mark done" style="left:${pct(sum.allRecovered)}%"></span>` : '')
  F.push(
    `<p class="lead">왼쪽에서 오른쪽으로 시간이 흐릅니다. <b>빨간 구간</b>이 그 대상이 응답하지 않은 시간이고, 막대 안 숫자가 그 길이(순단)입니다.` +
      (sum.firstOutage && sum.allRecovered
        ? ` <b>첫 끊김 ${clk(sum.firstOutage)}</b> 부터 <b>모두 복구 ${clk(sum.allRecovered)}</b> 까지 <b>${fmtGapText(sum.allRecovered - sum.firstOutage)}</b> 걸렸습니다.`
        : '') +
      `</p>`,
  )
  F.push(`<div class="flow"><div class="fh">대상</div><div class="marks">`)
  if (sum.firstOutage) F.push(`<span class="mlab first" style="left:${pct(sum.firstOutage)}%">첫 끊김 ${clk(sum.firstOutage)}</span>`)
  if (sum.allRecovered) F.push(`<span class="mlab done" style="left:${pct(sum.allRecovered)}%">모두 복구 ${clk(sum.allRecovered)}</span>`)
  F.push(`</div><div class="fh">끊김 → 복구 · 순단</div>`)
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
    F.push(`<div>${he(x.name)}</div><div class="lane"><div class="track"></div>${gridLines}${bars}${markLines}</div><div>${right}</div>`)
  }
  F.push(`<div></div><div class="axis">${ticks.map((t) => `<span class="tick" style="left:${pct(t)}%">${clk(t)}</span>`).join('')}</div><div></div></div>`)
  F.push(
    `<div class="legend"><span><i style="background:var(--okbg);border:1px solid #bfe3cc"></i>정상 응답</span><span><i style="background:#e5534b"></i>응답 없음(끊김)</span><span><i style="border-left:2px dashed #c62f2f;width:2px;border-radius:0"></i>첫 끊김</span><span><i style="border-left:2px dashed #13804b;width:2px;border-radius:0"></i>모두 복구</span><span>그림 범위: 첫 끊김 30초 전 ~ 마지막 복구 30초 뒤</span></div>`,
  )

  const T: string[] = [`<table><thead><tr><th>대상</th><th>주소</th><th>끊김</th><th>복구 첫 성공 시간</th><th>순단</th><th>끊김 횟수</th></tr></thead><tbody>`]
  for (const x of sum.targets) {
    if (!x.outages.length) {
      T.push(`<tr><td class="l">${he(x.name)}</td><td class="l"><code>${he(displayAddr(x.url))}</code></td><td>-</td><td>-</td><td class="okc">${x.ready ? '끊김 없음' : '응답 없음'}</td><td>0</td></tr>`)
      continue
    }
    x.outages.forEach((o, i) =>
      T.push(
        `<tr><td class="l">${i ? '' : he(x.name)}</td><td class="l">${i ? '' : `<code>${he(displayAddr(x.url))}</code>`}</td><td>${clk(o.start)}</td><td>${o.end ? clk(o.end) : '<span class="bad">복구 안 됨</span>'}</td><td class="bad">${o.end ? fmtGapText(o.end - o.start) : '-'}</td><td>${i ? '' : x.outages.length}</td></tr>`,
      ),
    )
  }
  T.push(`</tbody></table>`)
  return { failed, span, end, summary: S.join(''), flow: F.join('\n'), table: T.join('\n') }
}

/**
 * 2026-11-15 사용자 결정: 리포트 끝의 '참고사항'(끊김 · 복구 판정 기준 문단)은 뺐다. 그 기준은 맨 위 측정 구성의
 * 흐름(①~⑥) 단계 설명에 한 줄씩 옮겨, 받는 사람이 판정 기준을 그림과 같이 읽게 한다(probeTopo).
 */

/** 리포트 옵션 — RTO(목표 복구 시간)는 리포트를 뽑기 전에 사람이 정한다(2026-11-15 사용자 결정: 기본 10분) */
export interface ProbeReportOpts {
  rtoMin?: number
}
const rtoOf = (o?: ProbeReportOpts) => Math.max(1, Math.round(o?.rtoMin ?? 10)) * 60_000

/** 장애 노드별 색 — 구성도 · 복구 곡선 · 추이에서 같은 노드는 같은 색 */
const NODE_COLORS = ['#2f6fdc', '#8a4fd6', '#0f9a8a', '#d0661e', '#c23d7a', '#5a7a1a']
const failNodeOf = (r: ProbeRun) => r.config.failNode?.trim() || ''

/**
 * 대상 VM 마다 '노드 DOWN 뒤 몇 ms 에 돌아왔나'. 기준은 그 회차의 첫 끊김(노드 DOWN 이면 대상이 거의 동시에 끊긴다).
 *  - 끊긴 적 없는 대상은 0(처음부터 계속 응답)
 *  - 끝까지 복구되지 않았으면 null
 *  - 처음부터 정상을 확인하지 못한 대상(ready 아님)은 빼고 센다 — 끊김을 세지 않은 대상이라 복구도 알 수 없다
 * 여러 번 끊겼으면 **마지막 복구**로 잰다(다시 끊겼다 돌아온 것까지가 그 VM 의 복구).
 */
export function vmRecoveries(sum: ProbeSummary): { name: string; url: string; at: number | null }[] {
  const t0 = sum.firstOutage
  return sum.targets
    .filter((t) => t.ready)
    .map((t) => {
      if (!t.outages.length || t0 == null) return { name: t.name, url: t.url, at: 0 }
      const open = t.outages.some((o) => o.end == null)
      const end = Math.max(...t.outages.map((o) => o.end ?? 0))
      return { name: t.name, url: t.url, at: open ? null : Math.max(0, end - t0) }
    })
}

/** 정렬된 값의 백분위(가까운 순위) — 회차가 몇 개 안 될 때 보간으로 없는 값을 만들지 않는다 */
const pctOf = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]

/** `openstack server list --all-projects --long -c Name -c Host -c Networks -f json` → VM 이름 · 호스트 · IP. 실패면 null */
export function parseServerHosts(json: string): { name: string; host: string; ips: string[] }[] | null {
  let arr: unknown
  try {
    arr = JSON.parse(json)
  } catch {
    return null
  }
  if (!Array.isArray(arr)) return null
  const v4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g
  return arr.map((raw) => {
    const r = raw as Record<string, unknown>
    const nets = r['Networks']
    const text = typeof nets === 'string' ? nets : nets && typeof nets === 'object' ? JSON.stringify(nets) : ''
    return { name: String(r['Name'] ?? ''), host: String(r['Host'] ?? ''), ips: Array.from(new Set(text.match(v4) ?? [])) }
  })
}

/**
 * 대상 → 측정이 끝난 뒤 그 VM 이 있는 호스트. **IP 로** 맞춘다(대상 이름은 사람이 바꿀 수 있다). 같은 IP 를 가진 VM 이
 * 둘 이상이면(프로젝트가 달라 사설 IP 가 겹침) 맞추지 않는다 — 엉뚱한 VM 의 위치를 그리느니 '모름' 이 낫다.
 */
export function mapVmHosts(targets: ProbeTarget[], servers: { name: string; host: string; ips: string[] }[]): Record<number, string> {
  const out: Record<number, string> = {}
  targets.forEach((t, i) => {
    const ip = displayAddr(t.url).replace(/^https?:\/\//i, '').replace(/[:/].*$/, '')
    const hit = servers.filter((s) => s.ips.includes(ip) && s.host)
    if (hit.length === 1) out[i] = hit[0].host
  })
  return out
}

/** 리포트 추가 꾸밈 — 측정 구성 · 복구 곡선 · 가용성 점수 */
const TOPO_CSS = `.topo{display:grid;grid-template-columns:200px 92px minmax(0,1fr) 104px minmax(0,1fr);align-items:center}
.cvm{border:2px solid var(--brand);border-radius:12px;padding:12px 14px;background:#f3f6fc}.cvm .t{font-weight:700;color:var(--brand);font-size:14px}.cvm .ip{font-size:12px;color:var(--mut);word-break:break-all}
.cvm ul{margin:8px 0 0;padding:0;list-style:none;font-size:12px}.cvm li{padding:2px 0;border-top:1px dashed var(--line)}.cvm li b{display:inline-block;width:62px;color:var(--mut);font-weight:500}
.arr{position:relative;height:60px}.arr svg{width:100%;height:100%;overflow:visible}.arr .lb{position:absolute;left:0;right:0;top:-6px;text-align:center;font-size:11px;font-weight:700;line-height:1.3}
.ng{border:1px solid #c5cfdd;border-radius:10px;overflow:hidden;background:#fff}.ng .h{background:#e8eef7;padding:5px 12px;font-size:12.5px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}.ng .h b{color:var(--brand)}.ng .h em{margin-left:auto;font-style:normal;color:var(--mut);font-size:11.5px}
.ng .b{padding:8px 10px;display:flex;flex-wrap:wrap;gap:6px}.ng.down{border:2px solid #e39a9a}.ng.down .h{background:#fdeaea}.ng.down .h b{color:var(--bad)}.ng.to{border-color:#bfe3cc}.ng.to .h{background:#e3f6ec}.ng.to .h b{color:var(--ok)}
.pd{background:var(--bad);color:#fff;border-radius:999px;padding:0 8px;font-size:11px;font-weight:700}
.chip{border:1px solid #bcd0ef;background:#f2f7ff;border-radius:6px;padding:2px 8px;font-size:11.5px}
.chips{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:5px;padding:8px 10px}.chips .chip{display:flex;flex-direction:column;line-height:1.35;padding:4px 9px;min-width:0;overflow-wrap:anywhere}.chips .chip code{color:var(--mut);font-size:11px}
.fl{display:grid;gap:3px;margin:8px 10px 0;border:1px solid #f0c9c9;border-radius:8px;padding:6px 10px;font-size:12px}.fl span{display:flex;align-items:center;gap:7px}.fl i{width:8px;height:8px;border-radius:50%}.fl b{margin-left:auto;color:var(--bad)}
.tot{display:grid;gap:6px;padding:8px 10px}.tot>div{display:grid;grid-template-columns:minmax(0,1fr) 90px 50px;align-items:center;gap:8px;font-size:12px}.tot .bar{height:10px;background:#e3f6ec;border-radius:5px;overflow:hidden}.tot .bar i{display:block;height:100%;background:#13804b}
.steps{display:grid;grid-template-columns:repeat(6,1fr);margin-top:18px}
.st{position:relative;padding:10px 10px 10px 14px;background:var(--soft);border-top:3px solid var(--acc);font-size:12px;margin-right:14px;border-radius:0 0 8px 8px}
.st:after{content:'▶';position:absolute;right:-13px;top:14px;color:#9fb3d6;font-size:11px}.st:last-child:after{display:none}.st:last-child{margin-right:0}
.st b{display:block;font-size:12.5px;color:var(--brand)}.st span{color:var(--mut);font-size:11.5px;line-height:1.45;display:block;margin-top:3px}
.st.down{border-top-color:var(--bad)}.st.down b{color:var(--bad)}.st.up{border-top-color:var(--ok)}.st.up b{color:var(--ok)}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-top:10px}.stats div{background:var(--soft);border-radius:10px;padding:8px 12px}.stats span{display:block;font-size:11.5px;color:var(--mut)}.stats b{font-size:18px}.stats small{display:block;font-size:11px;color:var(--mut)}
.score{display:grid;grid-template-columns:130px 250px minmax(0,1fr);gap:20px;align-items:center}.score .bench{font-size:12px;color:var(--mut);margin-top:6px}
details.grp{border:1px solid var(--line);border-radius:10px;margin-top:10px}details.grp>summary{cursor:pointer;padding:9px 12px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}details.grp>summary b{color:var(--brand)}details.grp>div{padding:0 10px 6px}
details.top>summary{cursor:pointer;list-style:none;display:flex;align-items:center;gap:10px}details.top>summary::-webkit-details-marker{display:none}details.top>summary h2{margin:0;border:0;padding:0}details.top>summary:before{content:'▸';color:var(--mut)}details.top[open]>summary:before{content:'▾'}
.mv{display:grid;grid-template-columns:minmax(0,1fr) 70px minmax(0,1.3fr);gap:8px;align-items:center;margin:4px 0 10px}.mv .ar{font-size:11px;color:var(--ok);font-weight:700;text-align:center}
svg text{font-family:inherit}
@media print{details.top,details.grp{break-inside:auto}}
@media (max-width:820px){.topo{grid-template-columns:1fr}.arr{height:40px}.steps{grid-template-columns:1fr 1fr}.score,.stats{grid-template-columns:1fr 1fr}}`

const arrow = (w: number, color: string, dash: boolean, label: string, id: string) =>
  `<div class="arr"><div class="lb" style="color:${color}">${label}</div><svg viewBox="0 0 ${w} 60" preserveAspectRatio="none"><defs><marker id="${id}" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="${color}"/></marker></defs><line x1="4" y1="40" x2="${w - 6}" y2="40" stroke="${color}" stroke-width="2.5"${dash ? ' stroke-dasharray="6 4"' : ''} marker-end="url(#${id})"/></svg></div>`

/** 대상 VM → 측정 뒤 호스트별로 묶음(한 회차). 위치를 못 읽은 대상은 '위치 모름' */
function movedGroups(run: ProbeRun) {
  const g = new Map<string, string[]>()
  run.config.targets.forEach((t, i) => {
    const h = run.vmHosts?.[i] ?? ''
    g.set(h, [...(g.get(h) ?? []), t.name])
  })
  return [...g.entries()].sort((a, b) => (a[0] ? (b[0] ? a[0].localeCompare(b[0]) : -1) : 1))
}

/** 한 회차의 이동 그림(장애 노드 → evacuation → 옮겨 간 노드) — 한 회차 리포트 머리와 종합 리포트 회차 상세가 같이 쓴다 */
function moveFigure(run: ProbeRun) {
  const fn = failNodeOf(run)
  const groups = movedGroups(run)
  const known = groups.some(([h]) => h)
  const dest = !known
    ? `<div class="ng to"><div class="h"><b>남은 노드로 evacuation</b></div><div class="b mut" style="font-size:12px">${he(run.locErr ? `VM 위치를 읽지 못했습니다(${run.locErr})` : '측정이 끝난 뒤 VM 위치를 읽지 않았습니다(장애 노드 · OpenStack 조회 세션이 있어야 읽습니다)')}</div></div>`
    : `<div style="display:grid;gap:6px">${groups
        .map(
          ([h, names]) =>
            `<div class="ng ${h && h !== fn ? 'to' : ''}"><div class="h"><b>${he(h || '위치 모름')}</b>${h && h === fn ? '<span class="pd">장애 노드에 그대로</span>' : ''}<em>${names.length}대</em></div><div class="b">${names.map((n) => `<span class="chip">${he(n)}</span>`).join('')}</div></div>`,
        )
        .join('')}</div>`
  return { fn, dest }
}

/**
 * 측정 구성(2026-11-15 사용자 결정 · 목업 probe-final): 클라이언트 VM → (동시에 응답 요청) → 장애 노드(대상 VM) →
 * (Masakari evacuation) → 남은 노드. 대상 VM 을 한 노드에 모아 두고 그 노드를 내리는 검증이 대부분이라 그 모양으로 그린다.
 *  - 한 회차: 그 회차의 실제 이동(측정 끝에 Nova 에서 읽은 위치)
 *  - 여러 회차: 회차마다 장애 노드 · 이동한 노드가 달라 구조와 누적만(장애 노드별 회차 수 · 노드별로 옮겨 간 VM 수).
 *    회차별 실제 이동은 아래 회차별 상세에 있다
 * 판정 기준(예전 참고사항)은 ①~⑥ 단계 설명에 넣는다.
 */
function probeTopo(runs: ProbeRun[]): string {
  const first = runs[0]
  const c = first.config
  const sameSet = runs.every((r) => modeText(r.config) === modeText(c) && r.config.intervalSec === c.intervalSec && r.config.timeoutSec === c.timeoutSec && r.config.needOk === c.needOk)
  const hosts = [...new Set(runs.map((r) => r.host))]
  const tg: [string, string][] = []
  // 대상 VM — 이름 · 주소가 같으면 한 대(회차마다 같은 VM 을 잰다). 이름만 같고 주소가 다르면 다른 VM 으로 센다
  for (const r of runs) for (const t of r.config.targets) if (!tg.some(([n, a]) => n === t.name && a === displayAddr(t.url))) tg.push([t.name, displayAddr(t.url)])
  const nT = Math.max(...runs.map((r) => r.config.targets.length))
  const single = runs.length === 1
  let mid: string
  let right: string
  if (single) {
    const m = moveFigure(first)
    mid = `<div class="ng down"><div class="h"><b>${he(m.fn || '장애 노드(미지정)')}</b><span class="pd">Power Down</span><em>대상 VM ${tg.length}대</em></div><div class="chips">${[...tg].map(([n, a]) => `<span class="chip">${he(n)}<code>${he(a)}</code></span>`).join('')}</div></div>`
    right = m.dest
  } else {
    const byNode = new Map<string, number>()
    for (const r of runs) byNode.set(failNodeOf(r), (byNode.get(failNodeOf(r)) ?? 0) + 1)
    const nodes = [...byNode.keys()].sort((a, b) => (a ? (b ? a.localeCompare(b) : -1) : 1))
    const col = (n: string) => NODE_COLORS[nodes.filter(Boolean).indexOf(n) % NODE_COLORS.length] ?? '#9aa3af'
    mid = `<div class="ng down"><div class="h"><b>장애 노드</b><span class="pd">Power Down</span><em>회차마다 다름 · 대상 VM ${tg.length}대</em></div><div class="fl">${nodes
      .map((n) => `<span><i style="background:${n ? col(n) : '#9aa3af'}"></i>${he(n || '미지정')}<b>${byNode.get(n)}회</b></span>`)
      .join('')}</div><div class="chips">${[...tg].map(([n, a]) => `<span class="chip">${he(n)}<code>${he(a)}</code></span>`).join('')}</div></div>`
    const tot = new Map<string, number>()
    let read = 0
    for (const r of runs) {
      if (!r.vmHosts || !Object.keys(r.vmHosts).length) continue
      read++
      for (const h of Object.values(r.vmHosts)) if (h !== failNodeOf(r)) tot.set(h, (tot.get(h) ?? 0) + 1)
    }
    const mx = Math.max(1, ...tot.values())
    right = tot.size
      ? `<div class="ng to"><div class="h"><b>남은 노드로 evacuation</b><em>${read}회 누적</em></div><div class="tot">${[...tot]
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([h, n]) => `<div><span>${he(h)}</span><span class="bar"><i style="width:${((n / mx) * 100).toFixed(0)}%"></i></span><b style="text-align:right">${n}대</b></div>`)
          .join('')}<div style="grid-template-columns:1fr;color:var(--mut);font-size:11px">회차마다 옮겨 간 VM 을 노드별로 더한 수${read < runs.length ? ` · 위치를 읽은 ${read}/${runs.length}회만` : ''}</div></div></div>`
      : `<div class="ng to"><div class="h"><b>남은 노드로 evacuation</b></div><div class="b mut" style="font-size:12px">VM 위치를 읽은 회차가 없습니다(측정이 끝날 때 Nova 조회).</div></div>`
  }
  const n = c.needOk
  const steps = [
    ['', '① 측정 시작', `클라이언트 VM 에서 대상 VM ${nT}대에 동시에 응답 요청 시작(${c.intervalSec}초마다)`],
    ['', '② 정상 확인', `대상 VM 마다 연속 ${n}회 정상이면 감시 시작. 확인 못 한 VM 은 끊김을 세지 않음`],
    ['down', '③ 장애 주입', '대상 VM 이 있는 노드 Power Down'],
    ['down', '④ 응답 끊김', `노드 DOWN 으로 대상 VM 응답 끊김. 연속 ${c.needFail ?? 1}회 실패면 끊김, 시각은 그 첫 실패(요청 직전 시각이라 오차 최대 약 ${Math.max(c.intervalSec, c.timeoutSec)}초)`],
    ['up', '⑤ 복구', `Masakari evacuation 뒤 연속 ${n}회 정상이면 복구. 시각은 그 연속의 첫 성공(한 번 튄 성공은 세지 않음)`],
    ['up', '⑥ 측정 종료', `모든 대상 VM 이 연속 ${n}회 정상이면 측정 종료`],
  ]
  return `<section><h2>측정 구성</h2><p class="lead">대상 VM 을 한 노드에 모아 두고 그 노드를 내립니다. 클라이언트 VM 이 대상 VM 전부에 <b>동시에</b> 요청을 보내, VM 이 다른 노드로 evacuation 되어 다시 응답할 때까지를 VM 마다 잽니다.${sameSet ? '' : ' 회차마다 측정 설정이 달라 아래는 첫 회차 설정입니다.'}</p>
<div class="topo"><div class="cvm"><div class="t">클라이언트 VM</div><div class="ip">${he(hosts.join(', '))}</div><ul><li><b>방식</b>${he(modeText(c))}</li><li><b>주기</b>${c.intervalSec}초</li><li><b>타임아웃</b>${c.timeoutSec}초</li><li><b>복구 기준</b>연속 ${n}회 정상</li></ul></div>
${arrow(92, '#2f6fdc', false, `${nT}대에 동시에<br>응답 요청`, 'qa1')}${mid}${arrow(104, '#13804b', true, 'Masakari<br>evacuation', 'qa2')}${right}</div>
<div class="steps">${steps.map(([k, t, d]) => `<div class="st ${k}"><b>${t}</b><span>${he(d)}</span></div>`).join('')}</div></section>`
}

/** 회차 하나의 곡선 · 점수 재료 */
interface RunCalc {
  r: ProbeRun
  sum: ProbeSummary
  P: ReturnType<typeof probeParts>
  rec: { name: string; url: string; at: number | null }[]
}

/**
 * 복구 곡선(2026-11-15 사용자 결정 · 벤치마킹: 장애 실험 대시보드의 복구 시간 백분위 · 생존 곡선) — 회차 하나 = 계단 선 하나,
 * 계단 한 칸 = VM 한 대가 다시 응답한 순간. 가로는 그 회차의 첫 끊김(노드 DOWN) 뒤 경과. 굵은 선은 k 번째 복구 시각의 중앙값.
 */
function recoveryCurve(rows: RunCalc[], rto: number, color: (r: ProbeRun) => string): string {
  const use = rows.filter((x) => x.sum.firstOutage != null && x.rec.length)
  if (!use.length) return `<section><h2>복구 곡선</h2><p class="lead">끊김이 있었던 회차가 없어 그릴 것이 없습니다.</p></section>`
  const nMax = Math.max(...use.map((x) => x.rec.length))
  const allAt = use.flatMap((x) => x.rec.map((v) => v.at).filter((v): v is number => v != null))
  const xmax = Math.max(rto * 1.4, (Math.max(0, ...allAt) || 0) * 1.08)
  const W = 1040, H = 320, L = 52, R = 18, TP = 16, B = 34
  const X = (t: number) => L + (t / xmax) * (W - L - R)
  const Y = (n: number) => TP + (1 - n / nMax) * (H - TP - B)
  const mStep = [1, 2, 5, 10, 15, 30, 60].find((m) => xmax / 60_000 / m <= 15) ?? 60
  let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="복구 곡선">`
  for (let m = 0; m * 60_000 <= xmax; m += mStep) s += `<line x1="${X(m * 60_000)}" x2="${X(m * 60_000)}" y1="${TP}" y2="${H - B}" stroke="#eef1f5"/><text x="${X(m * 60_000)}" y="${H - B + 16}" font-size="10.5" text-anchor="middle" fill="#5b6675">${m}분</text>`
  const yStep = nMax <= 10 ? 2 : Math.ceil(nMax / 5)
  for (let k = 0; k <= nMax; k += yStep) s += `<line x1="${L}" x2="${W - R}" y1="${Y(k)}" y2="${Y(k)}" stroke="#eef1f5"/><text x="${L - 6}" y="${Y(k) + 4}" font-size="10.5" text-anchor="end" fill="#5b6675">${k}대</text>`
  s += `<rect x="${X(rto)}" y="${TP}" width="${Math.max(0, X(xmax) - X(rto))}" height="${H - TP - B}" fill="#fdeaea" opacity=".6"/><line x1="${X(rto)}" x2="${X(rto)}" y1="${TP}" y2="${H - B}" stroke="#c62f2f" stroke-width="2" stroke-dasharray="5 4"/><text x="${X(rto) + 6}" y="${TP + 12}" font-size="11" fill="#c62f2f" font-weight="700">RTO ${rto / 60_000}분</text>`
  const lineOf = (x: RunCalc) => {
    const v = x.rec.map((r) => r.at).filter((a): a is number => a != null).sort((a, b) => a - b)
    let d = `M${X(0)},${Y(0)}`
    v.forEach((t, k) => (d += ` H${X(t).toFixed(1)} V${Y(k + 1).toFixed(1)}`))
    return d + ` H${X(xmax)}`
  }
  const opaque = use.length <= 5 ? 0.75 : 0.25
  for (const x of use) {
    const open = x.rec.some((r) => r.at == null)
    s += `<path d="${lineOf(x)}" fill="none" stroke="${open ? '#c62f2f' : color(x.r)}" stroke-opacity="${open ? 0.85 : opaque}" stroke-width="${open ? 1.6 : 1.3}"><title>${he(runName(x.r))}</title></path>`
  }
  // k 번째 복구 시각의 중앙값 — 끝내 안 돌아온 VM 은 무한대로 둔다(미복구 회차를 빼면 곡선이 좋아 보인다).
  // 대상 수가 k 대보다 적은 회차는 그 칸에서 빼고 센다 — 정상을 확인 못 해 뺀 VM 을 '미복구' 로 세면 모두 돌아온 회차들이
  // '전부 복구: 복구 안 됨' 으로 찍혔다(코드 점검 11-15)
  const sortedAt = (x: RunCalc) => x.rec.map((r) => r.at ?? Infinity).sort((a, b) => a - b)
  const kth = (k: number) => use.map(sortedAt).filter((v) => v.length > k).map((v) => v[k]).sort((a, b) => a - b)
  const med: number[] = []
  for (let k = 0; k < nMax; k++) med.push(pctOf(kth(k), 0.5))
  // 숫자 칸(첫 VM · 절반 · 전부)은 회차마다 자기 대상 수로 — 첫째 · 가운데 · 마지막
  const perRun = (pick: (v: number[]) => number) => pctOf(use.map((x) => pick(sortedAt(x))).sort((a, b) => a - b), 0.5)
  const sFirst = perRun((v) => v[0])
  const sHalf = perRun((v) => v[Math.ceil(v.length / 2) - 1])
  const sAll = perRun((v) => v[v.length - 1])
  let md = `M${X(0)},${Y(0)}`
  for (let k = 0; k < nMax && Number.isFinite(med[k]); k++) md += ` H${X(med[k]).toFixed(1)} V${Y(k + 1).toFixed(1)}`
  if (use.length > 1) s += `<path d="${md}" fill="none" stroke="#1f3a68" stroke-width="3"/>`
  const half = Math.ceil(nMax / 2) - 1
  const pts: [number, number, string][] = [
    [med[0], 1, '첫 VM'],
    [med[half], half + 1, '절반'],
    [med[nMax - 1], nMax, '전부'],
  ]
  if (use.length > 1)
    for (const [t, k, l] of pts) if (Number.isFinite(t)) s += `<circle cx="${X(t)}" cy="${Y(k)}" r="5" fill="#1f3a68"/><text x="${X(t) + 8}" y="${Y(k) + (k === nMax ? 14 : -6)}" font-size="11.5" font-weight="700" fill="#1f3a68">${l} ${clkGap(t)}</text>`
  s += `<text x="${W - R}" y="${H - 3}" font-size="10.5" text-anchor="end" fill="#5b6675">첫 끊김(노드 DOWN) 뒤 경과</text></svg>`
  const stat = (lab: string, t: number, sub: string, cls = '') => `<div><span>${lab}</span><b class="${cls}">${Number.isFinite(t) ? fmtGapText(t) : '복구 안 됨'}</b><small>${sub}</small></div>`
  const spread = perRun((v) => (Number.isFinite(v[v.length - 1]) ? v[v.length - 1] - v[0] : Infinity))
  return `<section><h2>복구 곡선${use.length > 1 ? ` (${use.length}회 겹침)` : ''}</h2><p class="lead">선 하나가 한 회차입니다. 계단 한 칸 = VM 한 대가 다시 응답한 순간.${use.length > 1 ? ' <b>굵은 선이 중앙값</b>,' : ''} 빨간 선은 끝까지 복구되지 않은 회차, 빨간 영역은 RTO 를 넘긴 구간입니다.</p>${s}
<div class="stats">${stat('첫 VM 복구' + (use.length > 1 ? ' (중앙값)' : ''), sFirst, '노드 DOWN 감지 + evacuation 시작까지')}${stat('절반 복구' + (use.length > 1 ? ' (중앙값)' : ''), sHalf, '대상의 절반이 돌아온 시점')}${stat('전부 복구' + (use.length > 1 ? ' (중앙값, 미복구 회차 포함)' : ''), sAll, 'RTO 판정 기준', sAll > rto ? 'bad' : '')}${stat('첫 VM → 마지막 VM', spread, 'VM 을 차례로 옮기는 데 걸린 시간')}</div></section>`
}
const clkGap = (ms: number) => {
  const r = Math.round(ms / 1000)
  return `${Math.floor(r / 60)}:${p2(r % 60)}`
}

/**
 * 가용성 점수(벤치마킹: Gremlin 신뢰성 점수 · Litmus/Harness 프로브 성공 비율) — VM 한 대가 한 회차에 RTO 안에 다시 응답하면 통과.
 * 점수 = 통과 / (VM × 회차). 끊긴 적 없는 VM 은 통과, 처음부터 정상을 확인하지 못한 VM 은 세지 않는다.
 */
function scoreSection(rows: RunCalc[], rto: number, color: (r: ProbeRun) => string): string {
  // 끊김이 없었던 회차(장애를 넣기 전에 끝낸 회차 등)는 점수에 넣지 않는다 — 넣으면 모두 통과로 세어 점수가 부풀었다(코드 점검 11-15).
  // 정상을 확인한 VM 이 하나도 없는 회차도 뺀다
  const per = rows.filter((x) => x.sum.firstOutage != null && x.rec.length).map((x) => {
    const ok = x.rec.filter((v) => v.at != null && v.at <= rto).length
    return { x, ok, n: x.rec.length, bad: x.rec.filter((v) => v.at == null || v.at > rto).map((v) => v.name) }
  })
  const n = per.reduce((a, p) => a + p.n, 0)
  if (!n) return `<section><h2>가용성 점수</h2><p class="lead">끊김이 있었던 회차가 없어 점수를 낼 수 없습니다.</p></section>`
  const good = per.reduce((a, p) => a + p.ok, 0)
  const score = (good / n) * 100
  const misses = new Map<string, number>()
  for (const p of per) for (const b of p.bad) misses.set(b, (misses.get(b) ?? 0) + 1)
  const top = [...misses].sort((a, b) => b[1] - a[1]).slice(0, 3)
  const C = 2 * Math.PI * 48
  const W = 620, H = 150, L = 34, R = 10, TP = 12, B = 24
  const lo = Math.min(50, ...per.map((p) => Math.floor(((p.ok / p.n) * 100) / 10) * 10))
  const x = (k: number) => L + ((k + 0.5) * (W - L - R)) / per.length
  const y = (v: number) => TP + ((100 - v) / (100 - lo || 1)) * (H - TP - B)
  const sc = per.map((p) => (p.ok / p.n) * 100)
  let tr = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="회차별 점수 추이">`
  for (let v = 100; v >= lo; v -= 10) tr += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="#eef1f5"/><text x="${L - 5}" y="${y(v) + 4}" font-size="10" text-anchor="end" fill="#5b6675">${v}</text>`
  if (per.length > 1) tr += `<path d="${sc.map((v, k) => `${k ? 'L' : 'M'}${x(k).toFixed(1)},${y(v).toFixed(1)}`).join(' ')}" fill="none" stroke="#2f6fdc" stroke-width="2"/>`
  tr += sc
    .map(
      (v, k) =>
        `<circle cx="${x(k).toFixed(1)}" cy="${y(v).toFixed(1)}" r="${v < 100 ? 4 : 2.5}" fill="${v < 90 ? '#c62f2f' : v < 100 ? '#e7a33a' : color(per[k].x.r)}"><title>${he(runName(per[k].x.r))} · ${v.toFixed(0)}점</title></circle>` +
        (v < 100 && per.length <= 60 ? `<text x="${x(k).toFixed(1)}" y="${(y(v) + 15).toFixed(1)}" font-size="10" text-anchor="middle" fill="#c62f2f">${k + 1}</text>` : ''),
    )
    .join('')
  const every = Math.max(1, Math.ceil(per.length / 8))
  per.forEach((_, k) => {
    if (k % every === 0 || k === per.length - 1) tr += `<text x="${x(k).toFixed(1)}" y="${H - 6}" font-size="10" text-anchor="middle" fill="#5b6675">${k + 1}</text>`
  })
  tr += `</svg>`
  const passRuns = per.filter((p) => p.ok === p.n).length
  return `<section><h2>가용성 점수</h2><p class="lead">VM 한 대가 한 회차에 RTO(${rto / 60_000}분) 안에 다시 응답하면 통과로 셉니다. 점수 = 통과한 비율(VM × 회차 = ${n}번 중). 처음부터 정상을 확인하지 못한 VM 은 세지 않습니다.</p>
<div class="score"><svg viewBox="0 0 120 120" width="120" height="120"><circle cx="60" cy="60" r="48" fill="none" stroke="#eef1f5" stroke-width="12"/><circle cx="60" cy="60" r="48" fill="none" stroke="${score >= 95 ? '#13804b' : score >= 80 ? '#e7a33a' : '#c62f2f'}" stroke-width="12" stroke-dasharray="${((C * score) / 100).toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 60 60)" stroke-linecap="round"/><text x="60" y="58" text-anchor="middle" font-size="26" font-weight="800" fill="#1b2430">${score.toFixed(1)}</text><text x="60" y="78" text-anchor="middle" font-size="11" fill="#5b6675">/ 100</text></svg>
<div><div style="font-size:15px;font-weight:700">${n}번 중 ${good}번 통과</div>${top.length ? `<div class="bench">점수를 깎은 VM<br>${top.map(([nm, c]) => `· ${he(nm)}: ${c}번`).join('<br>')}${misses.size > 3 ? `<br>· 그 밖 ${n - good - top.reduce((a, b) => a + b[1], 0)}번` : ''}</div>` : '<div class="bench">모든 VM 이 매 회차 RTO 안에 돌아왔습니다.</div>'}<div class="bench">회차 전체 통과(모든 VM 이 RTO 안): ${passRuns}/${per.length}</div></div>
<div><div class="mut" style="font-size:11.5px">회차별 점수 추이 (그 회차에 RTO 안에 돌아온 VM 비율 × 100, 아래 숫자는 회차 순번)</div>${tr}</div></div></section>`
}

/**
 * 측정 한 회차의 HTML 리포트 — 인터넷 없이 열리는 한 파일(CSS 내장, 스크립트 없음). 가용성 검증 리포트와 같은 모양.
 * 구성: 머리 → 주요 수치(RTO 판정 포함) → 측정 구성(이 회차의 실제 이동) → 요약 문장 → 대상별 끊김 구간(막대) → 대상별 표 → 이벤트 원문.
 */
export function buildProbeHtml(run: ProbeRun, sum: ProbeSummary, opts?: ProbeReportOpts): string {
  const P = probeParts(run, sum)
  const rto = rtoOf(opts)
  const H: string[] = []
  H.push(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>응답 측정 결과</title>
<style>
${PROBE_CSS}
${TOPO_CSS}
</style></head><body>`)
  H.push(`<header><div class="in"><h1>응답 측정 결과${run.label ? `: ${he(run.label)}` : ''}</h1><div class="meta">${he(dt(run.startedAt))} ~ ${run.stoppedAt ? he(dt(run.stoppedAt)) : '진행 중'} · 클라이언트 VM ${he(run.host)} · ${he(modeText(run.config))}${run.tcpTool ? ` (${run.tcpTool === 'nc' ? 'nc -z' : 'bash /dev/tcp'})` : ''} · 주기 ${run.config.intervalSec}초 · 연속 ${run.config.needOk}회면 복구 · RTO ${rto / 60_000}분</div></div></header><div class="page">`)
  const k = (cls: string, label: string, v: string, sub = '') => `<div class="kpi ${cls}"><span>${label}</span><b>${v}</b>${sub ? `<small>${sub}</small>` : ''}</div>`
  const tv = rtoVerdict(sum, rto / 60_000)
  const verdict = [tv.cls, tv.text]
  H.push(
    `<div class="kpis">${k('', '대상', `${sum.targets.length}대`)}${k(P.failed.length ? 'bad' : 'ok', '끊겼던 대상', `${P.failed.length}대`)}${k('', '첫 끊김', sum.firstOutage ? clk(sum.firstOutage) : '-')}${k('ok', '모두 복구', sum.allRecovered ? clk(sum.allRecovered) : sum.firstOutage ? '복구 안 됨' : '-')}${k(verdict[0], `RTO ${rto / 60_000}분 판정`, verdict[1], P.span != null ? `첫 끊김 → 모두 복구 ${fmtGapText(P.span)}` : '')}</div>`,
  )
  // 판정 의견은 주요 수치 바로 아래(목업 위치) — 툴 판정을 옆에 함께 적는다
  if (hasOpinion(run.opinion)) H.push(opinionBox(run.opinion, `RTO ${rto / 60_000}분 ${tv.text}${tv.span != null ? ` (${fmtGapText(tv.span)})` : ''}`))
  H.push(probeTopo([run]))
  H.push(`<section><h2>요약</h2><ul class="sum">${P.summary}</ul></section>`)
  H.push(`<section><h2>대상별 끊김 구간</h2>${P.flow}</section>`)
  H.push(`<section><h2>대상별 기록</h2>${P.table}</section>`)
  const evText = run.events
    .map((e) => `${dt(e.at)}  ${run.config.targets[e.idx]?.name ?? e.idx}  ${e.kind === 'ready' ? '첫 정상 확인' : e.kind === 'outage' ? `끊김 (${outageReason(e.code, run.config.mode)})` : `복구 첫 성공 시간(${clk(e.base)})${e.outageStart ? ` · 순단 ${fmtGapText(e.base - e.outageStart)}` : ''}`}   # ${e.at},${e.idx},${e.code},${e.kind},${e.base}${e.outageStart ? ',' + e.outageStart : ''}`)
    .join('\n')
  H.push(`<section><h2>타임라인 (원문)</h2><p class="mut" style="font-size:12px;margin:0 0 6px">클라이언트 VM <code>${he(run.dir)}/events.csv</code> 모든 요청 기록은 같은 곳의 checks.csv</p><div class="pre">${he(evText) || '(없음)'}</div></section>`)
  H.push(`</div></body></html>`)
  return H.join('\n')
}

/** 회차 이름 — 이름이 없으면 시작 시각(목록과 같은 꼴) */
const runName = (r: ProbeRun) => r.label?.trim() || dt(r.startedAt).slice(5, 16)

/**
 * 여러 회차를 한 리포트로(2026-11-08 사용자 요청: 가용성 검증 리포트처럼 회차를 골라 · 전체로 통합해 뽑기).
 * 같은 방식(HTTP · TCP · Ping)으로 잰 회차만 받는다 — 목록이 방식별이라 섞이지 않는다.
 *
 * 2026-11-15 사용자 결정(목업 probe-final, 회차 수와 상관없이 이 모양 하나): 머리 → 주요 수치(회차 · RTO 통과 · 중앙값 · 가장 느림 · 미복구)
 * → 측정 구성 → 복구 곡선 → 가용성 점수 + 회차 점수 추이 → 회차별 상세(접힘, 장애 노드별로 묶음).
 * 예전의 회차 비교 표 · 회차별 막대 · 대상 × 회차 순단 표는 뺐다 — 회차가 30회를 넘으면 표가 옆 · 아래로 끝없이 길어졌다.
 * 복구 시간 = 첫 끊김부터 끊겼던 대상이 모두 복구될 때까지. 중앙값 · 가장 느림은 끝까지 복구된 회차만으로 낸다.
 */
export function buildProbeMultiHtml(runsIn: ProbeRun[], opts?: ProbeReportOpts): string {
  const rto = rtoOf(opts)
  const runs = [...runsIn].sort((a, b) => a.startedAt - b.startedAt)
  const rows: RunCalc[] = runs.map((r) => {
    const sum = summarize(r.config, r.events, [])
    return { r, sum, P: probeParts(r, sum), rec: vmRecoveries(sum) }
  })
  const failNodes = [...new Set(runs.map(failNodeOf).filter(Boolean))].sort((a, b) => a.localeCompare(b))
  const color = (r: ProbeRun) => (failNodeOf(r) ? NODE_COLORS[failNodes.indexOf(failNodeOf(r)) % NODE_COLORS.length] : '#9aa3af')
  const done = rows.filter((x) => x.P.span != null)
  const spans = done.map((x) => x.P.span as number).sort((a, b) => a - b)
  const worst = spans.length ? spans[spans.length - 1] : null
  const worstRow = worst != null ? done.find((x) => x.P.span === worst) : undefined
  const open = rows.filter((x) => x.P.failed.length && x.P.span == null)
  const judged = rows.filter((x) => x.sum.firstOutage != null)
  const pass = judged.filter((x) => x.P.span != null && x.P.span <= rto).length
  const first = runs[0]
  const last = runs[runs.length - 1]
  const cfg = first.config
  const setText = (c: ProbeConfig) => `${modeText(c)} · 주기 ${c.intervalSec}초 · 연속 ${c.needOk}회면 복구`
  const sameSet = runs.every((r) => setText(r.config) === setText(cfg) && (r.config.needFail ?? 1) === (cfg.needFail ?? 1) && r.config.timeoutSec === cfg.timeoutSec)
  const H: string[] = []
  H.push(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>응답 측정 종합 결과</title>
<style>
${PROBE_CSS}
${TOPO_CSS}
</style></head><body>`)
  H.push(
    `<header id="top"><div class="in"><h1>응답 측정 종합 결과</h1><div class="meta">${he(dt(first.startedAt))} ~ ${he(dt(last.stoppedAt ?? last.startedAt))} · ${runs.length}회차 · ${sameSet ? he(setText(cfg)) : '회차마다 측정 설정이 다름(각 회차 상세 참고)'} · RTO ${rto / 60_000}분</div></div></header><div class="page">`,
  )
  const k = (cls: string, label: string, v: string, sub = '') => `<div class="kpi ${cls}"><span>${label}</span><b>${v}</b>${sub ? `<small>${sub}</small>` : ''}</div>`
  H.push(
    `<div class="kpis">${k('', '회차', `${runs.length}회`, `${failNodes.length ? `장애 노드 ${failNodes.length}개 · ` : ''}대상 VM ${Math.max(...runs.map((r) => r.config.targets.length))}대`)}${k(judged.length && pass === judged.length ? 'ok' : 'warn', `RTO ${rto / 60_000}분 통과`, judged.length ? `${pass}/${judged.length}회` : '-', judged.length ? `통과율 ${((pass / judged.length) * 100).toFixed(1)}%` : '끊김이 있었던 회차 없음')}${k('', '중앙값', spans.length ? fmtGapText(pctOf(spans, 0.5)) : '-', spans.length > 1 ? `p90 ${fmtGapText(pctOf(spans, 0.9))} · 복구된 ${spans.length}회` : '첫 끊김 → 모두 복구')}${k('warn', '가장 느림', worst != null ? fmtGapText(worst) : '-', worstRow ? `${he(runName(worstRow.r))}${failNodeOf(worstRow.r) ? ` · ${he(failNodeOf(worstRow.r))}` : ''}` : '')}${k(open.length ? 'bad' : 'ok', '복구 안 된 회차', `${open.length}회`, open.length ? he(open.map((x) => runName(x.r)).join(', ')) : '모두 복구')}</div>`,
  )
  /*
   * 판정 의견 — 의견을 단 회차만 한 줄씩(판정 · 첫 줄 요약 · 툴 판정). 목업은 회차 표에 '판정' 열이었지만, 종합 리포트는 11-15 개편으로
   * 회차 표를 없앴다(회차가 많으면 끝없이 길어짐) — 그래서 주요 수치 아래 목록으로 두고, 전문은 회차별 상세에 싣는다
   */
  const ops = rows.map((x, i) => ({ x, i })).filter(({ x }) => hasOpinion(x.r.opinion))
  if (ops.length) {
    const cnt = (v: ProbeVerdict) => ops.filter(({ x }) => x.r.opinion?.verdict === v).length
    const tally = (['fail', 'pass', 'info'] as const).filter((v) => cnt(v)).map((v) => `${VERDICT_LABEL[v]} ${cnt(v)}회`).join(' · ')
    H.push(
      `<section><h2>판정 의견</h2><p class="lead">사람이 회차마다 단 판정입니다(${ops.length}회${tally ? ` · ${tally}` : ''}). 위 RTO 통과 수는 툴 판정(시간)만으로 셉니다. 전문은 회차별 상세에 있습니다.</p><ul class="ops">${ops
        .map(({ x, i }) => {
          const o = x.r.opinion as ProbeOpinion
          const tv = rtoVerdict(x.sum, rto / 60_000)
          return `<li>${o.verdict !== 'none' ? `<span class="pill ${OP_CLS[o.verdict]}">${VERDICT_LABEL[o.verdict]}</span>` : ''}<a class="nm" href="#run-${i + 1}">${i + 1}. ${he(runName(x.r))}</a><span>${he(opinionLines(o.text).title)}</span><span class="mut" style="margin-left:auto;font-size:11.5px">툴 판정: RTO ${tv.text}${tv.span != null ? ` (${fmtGapText(tv.span)})` : ''}</span></li>`
        })
        .join('')}</ul></section>`,
    )
  }
  H.push(probeTopo(runs))
  H.push(recoveryCurve(rows, rto, color))
  H.push(scoreSection(rows, rto, color))

  // 회차별 상세 — 통째로 접고, 안은 장애 노드별 묶음 → 회차(한 회차 리포트의 이동 그림 · 요약 · 끊김 구간 · 표)
  const groups = new Map<string, number[]>()
  rows.forEach((x, i) => groups.set(failNodeOf(x.r), [...(groups.get(failNodeOf(x.r)) ?? []), i]))
  const gKeys = [...groups.keys()].sort((a, b) => (a ? (b ? a.localeCompare(b) : -1) : 1))
  H.push(`<section><details class="top"><summary><h2>회차별 상세</h2><span class="mut">${runs.length}회 · 장애 노드별로 묶음 · 눌러서 펼치기</span></summary><p class="lead" style="margin-top:10px">회차를 누르면 그 회차의 이동 그림 · 요약 · 끊김 구간 · 대상별 기록이 열립니다(이벤트 원문은 한 회차 리포트 · CSV 에 있습니다).</p>`)
  for (const g of gKeys) {
    const idx = groups.get(g) as number[]
    const jd = idx.filter((i) => rows[i].sum.firstOutage != null)
    const ps = jd.filter((i) => rows[i].P.span != null && (rows[i].P.span as number) <= rto).length
    const op = idx.filter((i) => open.includes(rows[i])).length
    H.push(
      `<details class="grp"><summary><span style="color:${g ? color(rows[idx[0]].r) : '#9aa3af'}">●</span><b>${he(g ? `${g} 장애` : '장애 노드 미지정')}</b><span class="mut">${idx.length}회 · RTO 통과 ${ps}/${jd.length}</span>${op ? `<span class="pill bad">미복구 ${op}회</span>` : ''}</summary><div>`,
    )
    for (const i of idx) {
      const { r, sum, P } = rows[i]
      const pills = [
        P.failed.length ? `<span class="pill bad">끊긴 대상 ${P.failed.length}대</span>` : `<span class="pill ok">끊김 없음</span>`,
        P.span != null ? `<span class="pill ${P.span > rto ? 'warn' : 'ok'}">복구 ${fmtGapText(P.span)}${P.span > rto ? ' · RTO 초과' : ''}</span>` : sum.firstOutage ? `<span class="pill bad">미복구</span>` : '',
        sum.maxGap != null ? `<span class="pill">최장 순단 ${fmtGapText(sum.maxGap)}</span>` : '',
        hasOpinion(r.opinion) && r.opinion.verdict !== 'none' ? `<span class="pill ${OP_CLS[r.opinion.verdict]}">판정 의견: ${VERDICT_LABEL[r.opinion.verdict]}</span>` : '',
      ].join('')
      const tv = rtoVerdict(sum, rto / 60_000)
      const opBox = hasOpinion(r.opinion) ? opinionBox(r.opinion, `RTO ${rto / 60_000}분 ${tv.text}${tv.span != null ? ` (${fmtGapText(tv.span)})` : ''}`) : ''

      const m = moveFigure(r)
      const fig = `<div class="mv"><div class="ng down"><div class="h"><b>${he(m.fn || '장애 노드(미지정)')}</b><span class="pd">Power Down</span></div><div class="b">${r.config.targets.map((t) => `<span class="chip">${he(t.name)}</span>`).join('')}</div></div><div class="ar">evacuation<br>→</div>${m.dest}</div>`
      H.push(
        `<details class="run" id="run-${i + 1}"><summary><b>${i + 1}. ${he(runName(r))}</b><span class="mut">${he(dt(r.startedAt))} · 클라이언트 VM ${he(r.host)}${sameSet ? '' : ` · ${he(setText(r.config))}`}</span>${pills}</summary><div class="rb">${opBox}${fig}<ul class="sum">${P.summary}</ul><h3>대상별 끊김 구간</h3>${P.flow}<h3>대상별 기록</h3>${P.table}<p class="mut" style="font-size:12px;margin:8px 0 0">원문: 클라이언트 VM <code>${he(r.dir)}</code> (events.csv · checks.csv)</p></div></details>`,
      )
    }
    H.push(`</div></details>`)
  }
  H.push(`</details></section></div></body></html>`)
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
