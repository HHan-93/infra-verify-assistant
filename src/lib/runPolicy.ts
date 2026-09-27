// 검증 러너가 '무엇을 자동으로 돌려도 되는가 · 얼마나 기다려야 하는가' 를 정하는 규칙.
//
// UI 에서 떼어 둔 이유는 verdict.ts 와 같다 — 이것도 판정이다. 여기서 틀리면 돌지 않은
// 스텝이 '대기' 로 남거나(대화형 오판), 잘 돌던 명령이 '제한 시간 초과' 라는 **실패로**
// 기록된다(제한 시간 오판). 둘 다 "실제로 일어난 일" 과 다른 기록을 남기는 쪽이다.
import type { ExpectRule } from '../../electron/shared-types'

// ── 스텝 제한 시간 ────────────────────────────────────────────
/**
 * 예전엔 45초 고정이었는데, 그게 검증을 조용히 망가뜨리고 있었다.
 *   · `stress-ng --cpu 4 --timeout 60s` → 45초에 Ctrl+C. stress-ng 는 SIGINT 를 받아
 *     "successful run completed in 44.61 secs" 를 찍고 **0 으로** 끝난다 → '정상' 으로 기록.
 *     60초 부하를 걸었다고 리포트에 남지만 실제로는 44.6초만 돌았다.
 *   · `apt-get update && apt-get install` 은 미러가 느리면 45초를 그냥 넘긴다.
 * 그래서 (1) 기본값을 사용자가 고르고, (2) 명령이 스스로 소요시간을 말하면 그만큼은 기다린다.
 */
export const TIMEOUT_KEY = 'scenario_runner_timeout_v1'
export const TIMEOUT_CHOICES = [60, 120, 300, 600, 1800] as const
export const DEFAULT_TIMEOUT_SEC = 120
/**
 * 패키지 설치·다운로드처럼 **네트워크에 좌우되는** 명령의 최소 제한 시간.
 *
 * `docker … up` 과 `docker run` 도 여기 넣었다. `-f <파일>` 같은 옵션이 끼어도 걸리게 해 둔다
 * (`docker compose -f app.yml pull`). 이름에 pull 이 없을 뿐 **처음이면 이미지를
 * 내려받는다** — wg-easy 나 nginx 를 받는 동안 120초가 지나면 러너가 Ctrl+C 를 보내고
 * '제한 시간 초과' 로 남긴다. 느린 것이 실패로 기록되는 것은 이 도구에서 가장 나쁜 종류의
 * 오답이다(조회 실패 ≠ 장애와 같은 이야기). compose 가 끼어도 걸리게 `\s+\S*\s*` 를 둔다.
 */
export const SLOW_CMD_RE =
  /\b(apt|apt-get|aptitude|yum|dnf|zypper|pip3?|npm|wget|curl|git\s+clone|docker(\s+compose)?(\s+-{1,2}[\w-]+(=\S+)?(\s+[^-\s]\S*)?)*\s+(pull|build|up|run))\b/i
const SLOW_CMD_FLOOR_MS = 300_000

/**
 * **디스크 이미지를 통째로 읽고 쓰는** 명령의 최소 제한 시간 (30분).
 *
 * 네트워크와는 규모가 다르다 — `qemu-img convert -O qcow2 /dev/vda …` 는 루트 디스크
 * 전부를 옮기는 것이라 수십 분이 걸리고, scn-qcow2-image 의 설명도 "수 분~수십 분" 이라고
 * 적어 두었다. 그런데 제한은 기본값 2분이었다: **시나리오가 스스로 오래 걸린다고 써 놓은
 * 일을, 러너가 그 시간이 되기 한참 전에 끊고 실패로 기록**하고 있었다.
 * 그래도 끝나지 않으면 사람이 '중단' 을 누른다 — 화면에 남은 시간이 계속 보인다.
 */
export const IMAGE_CMD_RE = /\bqemu-img\s+(convert|dd)\b/i
const IMAGE_CMD_FLOOR_MS = 1_800_000

const toMs = (n: string, unit?: string) => {
  const v = parseInt(n, 10)
  const u = (unit ?? 's').toLowerCase()
  return v * (u === 'h' ? 3_600_000 : u === 'm' ? 60_000 : 1000)
}
/**
 * 반복 루프가 **몇 번 도는가** — `for i in $(seq 1 120)` 의 120.
 *
 * 이걸 안 보면 감시 루프가 제 시간을 못 받는다. seq 1 120 + sleep 1 짜리 스텝은 실제로
 * 120초를 넘게 도는데, 선언으로 잡히는 것은 sleep 1 하나뿐이라 제한이 기본값 120초 그대로였다.
 * **끝나기 직전에 잘려 마지막 '관찰 종료' 문구를 못 찍고, 하필 그 문구가 판정 기준이라
 * 언제나 실패**했다(scn-nc-port-check 7번 — 마이그레이션 무중단 확인, 사용자 확인).
 */
function loopCount(cmd: string): number {
  let n = 0
  for (const m of cmd.matchAll(/\bseq\s+(?:(\d+)\s+)?(\d+)\b/g)) {
    const c = m[1] ? Number(m[2]) - Number(m[1]) + 1 : Number(m[2])
    if (c > n) n = c
  }
  return n
}
/**
 * 한 바퀴에 **명령 자체가 붙잡는 시간** — nc -w 1 · curl --max-time 3 · ping -W 2.
 *
 * 잘 붙을 때는 0 에 가깝지만 끊긴 구간에서는 이 시간을 꽉 채운다. 끊김을 보려고 돌리는
 * 루프이므로 **끊겼을 때를 기준으로** 잡는다 — 잘 될 때만 계산하면 정작 장애가 난
 * 회차에서 시간이 모자라 잘린다.
 */
function perTryMs(cmd: string): number {
  let max = 0
  for (const m of cmd.matchAll(/(?:--max-time|--connect-timeout)[=\s]+(\d+)|\s-[wW]\s+(\d+)\b/g)) {
    const v = Number(m[1] ?? m[2]) * 1000
    if (v > max) max = v
  }
  return max
}

/** 명령이 명시한 소요 시간(stress-ng --timeout 60s, fio --runtime, sleep 30, 반복 루프 …) */
export function declaredDurationMs(cmd: string): number {
  let max = 0
  const seen = (ms: number) => {
    if (ms > max) max = ms
  }
  for (const m of cmd.matchAll(/--(?:timeout|runtime|time)[=\s]+(\d+)([smh]?)\b/gi)) seen(toMs(m[1], m[2]))
  for (const m of cmd.matchAll(/\bsleep\s+(\d+)([smh]?)\b/gi)) seen(toMs(m[1], m[2]))
  for (const m of cmd.matchAll(/\s-t\s+(\d+)([smh]?)\b/gi)) seen(toMs(m[1], m[2]))
  // 반복 루프 — (한 바퀴의 sleep + 명령이 붙잡는 시간) × 도는 횟수.
  // 루프 밖 sleep 까지 한 바퀴로 세어 넉넉해질 수는 있으나, 넉넉한 쪽이 안전하다.
  // 모자라면 멀쩡한 스텝이 '제한 시간 초과' 로 남고, 남으면 사람이 '중단' 을 누르면 된다.
  const loops = loopCount(cmd)
  if (loops > 1) seen(loops * (max + perTryMs(cmd)))
  return max
}
/**
 * 이 명령에 실제로 적용할 제한 시간.
 * 명령이 "60초 돌리겠다"고 말했으면 60초 + 여유를 준다 — 자기가 끝나기 전에 우리가 끊으면 안 된다.
 */
export function timeoutForCmd(cmd: string, baseMs: number): number {
  const declared = declaredDurationMs(cmd)
  const floor = Math.max(
    SLOW_CMD_RE.test(cmd) ? SLOW_CMD_FLOOR_MS : 0,
    IMAGE_CMD_RE.test(cmd) ? IMAGE_CMD_FLOOR_MS : 0,
  )
  return Math.max(baseMs, declared ? declared + 30_000 : 0, floor)
}

/**
 * 사람이 화면 앞에 앉아 있어야 하는 명령 — '전체 실행'에서 자동으로 돌리지 않는다.
 *
 * 왜: htop 을 러너가 돌리면 45초를 붙잡고 있다가 Ctrl+C 로 끊기고, 남는 건 전체화면 UI
 * 한 프레임이 뭉개진 출력뿐이다. 그런데 판정은 '실행됨' 이 붙는다 — 아무것도 검증하지
 * 않았는데 검증한 것처럼 리포트에 남는 게 이 도구에서 가장 나쁜 결과다.
 *
 * 개별 '실행' 버튼으로는 그대로 돌릴 수 있다. 그건 사용자가 보고 누른 것이므로 막지 않는다.
 */
export const INTERACTIVE_RULES: {
  re: RegExp
  why: string
  /**
   * **expect 가 답해 주면 자동으로 돌려도 되는 규칙.**
   *
   * 프롬프트를 되묻는 것이 문제인 규칙(adduser·passwd)만 여기에 해당한다. 러너 셸은
   * expect 로 프롬프트에 자동 응답할 수 있으므로, 스텝이 그 답을 적어 두었다면 사람이
   * 앞에 앉아 있을 이유가 없다. 실제로 scn7 '사용자 생성' 은 `--gecos ""` 로 이름 질문을
   * 없애고 비밀번호 둘을 expect 로 답하게 해 두고도 이 규칙에 걸려 전체 실행에서 빠졌다 —
   * 시나리오가 "expect 로 자동 응답합니다" 라고 적어 둔 것과 러너의 동작이 달랐다.
   *
   * 전체화면(htop)·끝나지 않는 명령(watch, tail -f)·다른 셸 진입(su, vi)에는 붙이지 않는다.
   * 그것들은 프롬프트 문제가 아니라 expect 로 해결되지 않는다.
   */
  expectCanAnswer?: boolean
}[] = [
  { re: /(^|[|;&]\s*)(sudo\s+)?(htop|iotop|iftop|nmon|atop|glances)\b/i, why: '전체화면 모니터 — q 를 눌러야 끝납니다' },
  { re: /(^|[|;&]\s*)(sudo\s+)?top\b(?![^|;&]*\s-b)/i, why: '전체화면 모니터 — 배치 모드(-b)가 아니면 끝나지 않습니다' },
  { re: /(^|[|;&]\s*)(sudo\s+)?watch\b/i, why: '주기 반복 실행 — Ctrl+C 를 눌러야 끝납니다' },
  { re: /(^|[|;&]\s*)(sudo\s+)?(vi|vim|nano|emacs)\b/i, why: '편집기가 열립니다 — 저장·종료를 사람이 해야 합니다' },
  { re: /(^|[|;&]\s*)(sudo\s+)?(less|more)\b/i, why: '페이저가 열립니다 — q 를 눌러야 끝납니다' },
  { re: /\btail\b[^|;&]*(\s-[a-zA-Z]*[fF]\b|\s--follow\b)/i, why: '로그를 계속 따라갑니다 — 스스로 끝나지 않습니다' },
  { re: /journalctl[^|;&]*\s-f\b/i, why: '로그를 계속 따라갑니다 — 스스로 끝나지 않습니다' },
  { re: /(^|[|;&]\s*)(sudo\s+)?nc\s+(-\S+\s+)*-l/i, why: '포트 수신 대기 — 터미널을 점유합니다' },
  {
    re: /kubectl\s+(edit|attach|port-forward)\b|kubectl\s+exec\s+(-\S+\s+)*-\S*it\b/i,
    why: '대화형 kubectl — 사람이 조작해야 합니다',
  },
  { re: /(^|[|;&]\s*)(sudo\s+)?ping\s+(?![^|;&]*-c\s)/i, why: '횟수 제한(-c)이 없어 끝나지 않습니다' },
  // while true; do … done 처럼 사람이 Ctrl+C 로 끊어야 하는 감시 루프
  { re: /\bwhile\s+(true|:)\b|\buntil\s+false\b|\bfor\s*\(\(\s*;;/i, why: '무한 반복 — Ctrl+C 를 눌러야 끝납니다' },
  // 사용자 전환 — 새 셸이 열려서 이후 스텝이 그 셸 안에서 돌아버린다
  { re: /(^|[|;&]\s*)(sudo\s+)?su\s+(-|--login|\S)/i, why: '다른 계정 셸로 진입 — 이후 스텝이 그 셸에서 돌게 됩니다' },
  // adduser/passwd 는 이름·비밀번호를 되묻는다 (--disabled-password --gecos "" 를 준 경우는 제외)
  {
    re: /(^|[|;&]\s*)(sudo\s+)?adduser\b(?![^|;&]*--disabled-password)|(^|[|;&]\s*)(sudo\s+)?passwd\b/i,
    why: '이름·비밀번호를 되묻습니다 — 터미널에서 직접 입력해야 합니다',
    expectCanAnswer: true,
  },
]
/**
 * `timeout 30 tail -f …` 처럼 **스스로 끝나도록 시간을 걸어 둔** 명령인지.
 *
 * 이걸 안 보면 `tail -f`·`journalctl -f` 규칙에 걸려 전체 실행에서 빠지는데, 정작 그
 * 스텝들은 "30초 동안 추적합니다" 라며 timeout 으로 끊어 둔 것이다(scn13 4·5). 끝나는
 * 명령을 "끝나지 않는다" 며 건너뛰면 돌릴 수 있는 스텝이 이유 없이 '대기' 로 남는다.
 * `timeout` 뒤에 **시간이 오는** 형태만 인정한다 — 옵션만 있고 시간이 없으면 안 끊긴다.
 */
const BOUNDED_RE = /\btimeout\s+(-\S+\s+)*\d+[smhd]?\s/i

/** 대화형이면 그 이유, 아니면 null. expect 가 답할 수 있는 프롬프트는 대화형으로 보지 않는다. */
export function interactiveReason(cmd: string, expect?: ExpectRule[]): string | null {
  for (const r of INTERACTIVE_RULES) {
    if (!r.re.test(cmd)) continue
    if (r.expectCanAnswer && (expect?.length ?? 0) > 0) continue
    if (BOUNDED_RE.test(cmd)) continue
    return r.why
  }
  return null
}
