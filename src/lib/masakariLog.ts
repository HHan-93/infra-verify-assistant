/**
 * 상태보드 — masakari-engine 로그로 evacuation 이 **어디까지 왔는가** 를 판정한다(StatusBoard 에서 옮겨 왔다 — 검사하려고).
 *
 * 알림(notification) 하나의 끝은 `Notification <uuid> exits with status: <상태>.` 한 줄이다. 상태는
 * finished · error · failed · ignored 다. 예전에는 finished 만 보고 나머지는 못 본 척해서,
 * 2026-10-26 검증에서 con02 엔진이 keystone 500 으로 `error` 로 끝낸 알림이 **끝까지 '진행 중'** 으로 남았다
 * (masakari 는 error 알림을 주기적으로 다시 집어 가고, 그때는 con03 엔진이 이어받았다). 끝난 상태를 그대로 보여 준다.
 */

import { stripAnsi } from './ansi'

export const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
// masakari-engine 의 인스턴스 단위 evacuation 호출 로그 (예: "Call evacuate command for instance <uuid> on host ...")
const EVAC_RE = new RegExp(`evacuate\\s+command\\s+for\\s+instance\\s+(${UUID})`, 'gi')
const EXIT_RE = new RegExp(`Notification\\s+(${UUID})\\s+exits\\s+with\\s+status:\\s*([a-z_]+)`, 'i')
const PROCESSING_RE = /Processing\s+notification/i
// 'Processing notification <id> of type: COMPUTE_HOST' — 알림 종류. evacuation 은 COMPUTE_HOST(호스트 장애) 알림만이다
const TYPE_RE = new RegExp(`Processing\\s+notification\\s+(${UUID})\\s+of\\s+type:\\s*([A-Z_]+)`, 'i')

/**
 * 상태보드가 엔진 로그를 줄일 때 쓰는 grep -iE 패턴. 판정에 필요한 줄만 남긴다.
 * failure · exceptions. 은 2026-10-27 에 더했다: evacuation 전 첫 단계(DisableComputeServiceTask)가 Nova API 503 으로 실패했는데,
 * 실패한 Task 줄과 예외 줄이 grep 에 안 걸려 사유가 'Failed to execute host failure flow' 뿐이었다(VM 이동 실패처럼 읽혔다).
 * sh -c '…' 안에 들어가므로 작은따옴표를 쓰지 않는다.
 */
export const MASAKARI_GREP = 'evacuat|finish|complet|notification|failure|exceptions\\.'

/** 로그 줄 앞머리의 타임스탬프(YYYY-MM-DD HH:MM:SS)를 (호스트 로컬로) 파싱 → epoch ms (없으면 null) */
export function lineTs(l: string): number | null {
  const m = l.match(/(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/)
  if (!m) return null
  const t = new Date(`${m[1]}T${m[2]}`).getTime()
  return Number.isNaN(t) ? null : t
}

/**
 * idle = evacuation 로그가 아예 없는 상태. '아직 아무 일 없음' 과 '지금 처리 중' 은 사람이 할 일이 다르다.
 * error  = 이 엔진이 알림을 **실패로 끝냈다**. masakari 가 주기적으로 다시 집어 가므로(다른 엔진일 수 있다) 끝이 아니다.
 * failed = 재시도까지 다 쓰고 **실패로 확정**됐다. 사람이 손대야 한다.
 */
export type MasakariState = 'finished' | 'progress' | 'idle' | 'unknown' | 'error' | 'failed'

export interface MasakariParse {
  state: MasakariState
  detail: string
  /** 이 로그에서 evacuation 대상으로 잡힌 인스턴스 수 */
  evac: number
  /** 그 인스턴스 id — 여러 엔진이 같은 알림을 이어받으면 노드별 대수를 합칠 때 겹친 것을 한 번만 센다 */
  uuids: string[]
  /** finished/error/failed 가 로그에 찍힌 시각(호스트 시계 → delta 로 보정한 절대시각) */
  at?: number
  /** 판정 근거가 된 줄 — 증적 화면이 이 줄로 스크롤해 강조한다 */
  line?: string
  /** error/failed 로 끝난 알림의 status 원문 */
  status?: string
  /** 왜 실패했나 — 같은 로그에서 읽은 짧은 요약(예: 'VM 11대 중 7대 옮기지 못함 · 1대 evacuation 확인 시간 초과(608초)') */
  reason?: string
  /** 옮기지 못한 VM 수 — `Failed to evacuate instances '<id>,…'` 목록의 개수(타임라인 · 리포트의 '실패 N대') */
  failedVms?: number
  /** reason 의 짧은 꼴 — 타임라인 요약 한 줄에 들어가게(예: 'Nova API 503, VM 이동 시도 없음') */
  brief?: string
}

/** masakari host_failure flow 의 Task 이름 → 사람이 읽는 단계. 모르는 Task 는 이름 그대로 */
const TASK_KO: Record<string, string> = {
  DisableComputeServiceTask: '서비스 비활성화 단계',
  PrepareHAEnabledInstancesTask: '대상 VM 조회 단계',
  EvacuateInstancesTask: 'VM 이동 단계',
}
/** 예외 모듈 → 어느 API 가 실패했나. TRACE 줄의 `novaclient.exceptions.ClientException: … (HTTP 503)` 에서 읽는다 */
const API_KO: [RegExp, string][] = [
  [/^novaclient$/i, 'Nova API'],
  [/^keystone(auth1|client)$/i, 'Keystone'],
  [/^neutronclient$/i, 'Neutron API'],
  [/^glanceclient$/i, 'Glance API'],
  [/^cinderclient$/i, 'Cinder API'],
]

/**
 * 어느 단계에서 무엇 때문에 멈췄나 — 마지막으로 FAILURE 가 된 Task 와 마지막 API 예외.
 * 실제 문구(2026-10-27 con02): `Task 'DisableComputeServiceTask' (<id>) transitioned into state 'FAILURE' from state 'RUNNING'`,
 * `TRACE … novaclient.exceptions.ClientException: Unknown Error (HTTP 503)`. 10-26 con02 는 HTTP 코드 없이
 * `ClientException: Unexpected API Error.` 였다 — 그때는 '오류' 로 적는다.
 */
export function failStage(lines: string[]): { task?: string; step?: string; cause?: string } {
  let task: string | undefined
  let cause: string | undefined
  for (const l of lines) {
    const t = /Task '(\w+)' \([^)]*\) transitioned into state 'FAILURE'/.exec(l)
    if (t) task = t[1]
    const e = /\b(\w+)\.exceptions\.[\w.]+:\s*(.*)$/.exec(l)
    const api = e ? API_KO.find(([re]) => re.test(e[1]))?.[1] : undefined
    if (e && api) {
      const http = /\(HTTP (\d{3})\)/.exec(e[2])
      cause = `${api} ${http ? http[1] : '오류'}`
    }
  }
  return { task, step: task ? (TASK_KO[task] ?? task) : undefined, cause }
}

/**
 * 실패 이유를 로그에서 짧게 뽑는다 — '실패' 만 보이면 결국 로그를 열어야 했다(사용자 요청). 끝난 줄 **앞**의 줄만 본다.
 * 실제 문구(2026-10-26 con03): `Timeout for instance '<id>' evacuation.: … Looping call timed out after 601.42 seconds`,
 * `Failed to process notification '<id>'. Reason: Failed to evacuate instances '<id>,<id>,…' from host 'contrabass01'`.
 * con02 의 keystone 500 은 TRACE 줄에만 있어 조회(grep)에 안 잡힌다 — 그때는 Reason 문구의 앞부분을 쓴다.
 */
/** 옮기지 못한 VM id — 같은 알림을 여러 번 처리했으면 마지막 시도의 목록 */
export function failedInstances(lines: string[]): string[] {
  let ids: string[] = []
  for (const l of lines) {
    const m = /Failed to evacuate instances '([^']+)'/i.exec(l)
    if (m) ids = m[1].split(',').map((x) => x.trim()).filter(Boolean)
  }
  return ids
}

/**
 * total — 이 엔진이 evacuate 를 건 VM 수. 함께 적어 '몇 대 중 몇 대' 가 보이게 한다(사용자 요청 — 'VM 7대 옮기지 못함' 만으로는
 * 전체가 몇 대였는지 로그를 다시 봐야 했다).
 */
export function failReason(lines: string[], total = 0): string | undefined {
  const parts: string[] = []
  const failedIds = failedInstances(lines)
  if (failedIds.length) parts.push(total >= failedIds.length ? `VM ${total}대 중 ${failedIds.length}대 옮기지 못함` : `VM ${failedIds.length}대 옮기지 못함`)
  const timeouts = new Map<string, number>()
  for (const l of lines) {
    const m = new RegExp(`Timeout for instance '(${UUID})' evacuation.*?after ([\\d.]+) seconds`, 'i').exec(l)
    if (m) timeouts.set(m[1].toLowerCase(), Math.round(parseFloat(m[2])))
  }
  if (timeouts.size) parts.push(`${timeouts.size}대 evacuation 확인 시간 초과(${Math.max(...timeouts.values())}초)`)
  if (!parts.length) {
    // VM 을 옮기다 실패한 게 아니면 어느 단계에서 무엇 때문에 멈췄는지 — 'evacuation 실패' 로 읽히지 않게(사용자 지적 10-27)
    const { step, cause } = failStage(lines)
    if (step || cause) {
      parts.push(step && cause ? `${step}에서 ${cause}` : step ? `${step}에서 실패` : (cause as string))
      if (total === 0) parts.push('VM 이동 시도 없음')
      return parts.join(' · ')
    }
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = /Reason:\s*([^.:'"]{4,80})/i.exec(lines[i])
      if (m) return m[1].trim()
    }
    return undefined
  }
  return parts.join(' · ')
}

/** failReason 의 짧은 꼴 — 타임라인 요약 한 줄용. VM 을 옮기다 실패했으면 그 문장 그대로, 아니면 원인만('Nova API 503, VM 이동 시도 없음') */
export function failBrief(lines: string[], total = 0): string | undefined {
  if (failedInstances(lines).length || lines.some((l) => /Timeout for instance/i.test(l))) return failReason(lines, total)
  const { step, cause } = failStage(lines)
  const head = cause ?? (step ? `${step}에서 실패` : undefined)
  if (!head) return failReason(lines, total)
  return total === 0 ? `${head}, VM 이동 시도 없음` : head
}

/**
 * masakari-engine.log 에서 T0 이후 로그만 보고 판정 + 인스턴스 수.
 * (이전 라운드의 finished 이력이 섞이지 않도록 반드시 T0 이후로 필터)
 * delta: 로그 타임스탬프(호스트 로컬 표기)를 PC-로컬로 파싱했을 때와 절대시각의 차이(ms).
 *   host 가 UTC 등 다른 TZ 여도 이 값으로 보정해 T0(절대시각) 비교가 맞도록 한다.
 */
export function parseMasakari(out: string, t0: number, delta: number): MasakariParse {
  const all = stripAnsi(out).split('\n').filter(Boolean)
  const recent = all.filter((l) => {
    const ts = lineTs(l)
    return ts != null && ts - delta >= t0
  })
  // 검증 시작 이후의 로그가 한 줄도 없다 = 아직 아무 일도 안 일어났다. '진행 중'이 아니다.
  if (!recent.length) return { state: 'idle', detail: '검증 시작 후 evacuation 로그 없음', evac: 0, uuids: [] }
  const uuids = new Set<string>()
  for (const l of recent) {
    let m: RegExpExecArray | null
    EVAC_RE.lastIndex = 0
    while ((m = EVAC_RE.exec(l)) !== null) uuids.add(m[1].toLowerCase())
  }
  /**
   * 정확한 패턴이 안 잡히면(masakari 버전마다 문구가 다르다) evacuat 줄에서 **'instance' 바로 뒤의 UUID** 만 줍는다.
   *
   * 여기에 함정이 셋 있었다:
   *  1) masakari 로그는 **모든 줄 앞머리에 요청 id(`req-<uuid>`)** 를 붙인다. 그걸 세면 줄 수만큼 대수가 뛴다.
   *  2) 한 줄에서 첫 UUID 하나만 집었더니 그게 바로 req id 였다.
   *  3) (2026-10-26) req 만 지우고 '그 줄의 UUID 전부' 를 모았더니 `Flow 'instance_evacuate_engine' (<flow id>)
   *     transitioned into state 'REVERTED'` 의 **flow id** 가 VM 1대로 세졌다 — evacuate 를 한 대도 못 한 엔진이 '1대'.
   *     taskflow 의 flow·task id 는 어디에나 붙으므로, 인스턴스라고 적힌 자리의 UUID 만 믿는다.
   */
  if (uuids.size === 0) {
    const INST_RE = new RegExp(`instance(?:_id|_uuid)?[\\s:='"]+(${UUID})`, 'gi')
    for (const l of recent) {
      if (!/evacuat/i.test(l)) continue
      for (const m of l.matchAll(INST_RE)) uuids.add(m[1].toLowerCase())
    }
  }
  const evac = uuids.size
  const ids = [...uuids]
  /**
   * 호스트 장애가 아닌 알림(PROCESS · VM)은 evacuation 이 아니다 — 프로세스 재시작 알림 하나가 검증 시작 뒤에 처리되거나
   * 실패하면, 아무 노드도 안 죽었는데 카드가 '진행 중'·'실패' 가 되고 종합 판정이 '복구 진행 중' 에 묶였다(코드 검토 지적).
   * 그 알림의 'finished' 를 evacuation 완료로 읽는 것도 같은 잘못이다. 종류가 로그에 찍힌 알림만 가려내고, 종류를 모르는
   * 알림(처리 시작 줄이 tail 밖으로 밀린 경우 등)은 예전처럼 받는다 — 모르는 것을 버리면 진짜 evacuation 을 놓친다.
   */
  const typeOf = new Map<string, string>()
  for (const l of recent) {
    const m = TYPE_RE.exec(l)
    if (m) typeOf.set(m[1].toLowerCase(), m[2].toUpperCase())
  }
  const otherType = (id: string) => {
    const t = typeOf.get(id.toLowerCase())
    return !!t && t !== 'COMPUTE_HOST'
  }
  const hostProcessing = (l: string) => PROCESSING_RE.test(l) && !otherType(TYPE_RE.exec(l)?.[1] ?? '')
  // 알림이 실제로 끝난 줄만 본다 ("Notification <uuid> exits with status: finished.")
  //   중복 스킵 WARNING("...current status ... in db is 'finished'")이나 "Processing notification..." 은 끝이 아님.
  const exits = recent
    .map((l) => {
      const m = EXIT_RE.exec(l)
      return m && !otherType(m[1]) ? { line: l, status: m[2].toLowerCase(), ts: lineTs(l) } : null
    })
    .filter((x): x is { line: string; status: string; ts: number | null } => !!x)
  // 가장 이른 완료 줄을 고른다 — 그 줄의 타임스탬프가 '언제 끝났나' 의 답이다.
  // (some() 으로 존재만 확인하면 시각을 잃어버려, 마일스톤이 '발견 시각' 으로 찍힌다)
  const finished = exits.find((x) => x.status === 'finished')
  if (finished) {
    return {
      state: 'finished',
      detail: evac ? `evacuation 완료 · ${evac}대` : 'evacuation 완료',
      evac,
      uuids: ids,
      // delta 를 빼서 호스트 로컬 표기를 절대시각으로 되돌린다(t0 비교와 같은 기준).
      at: finished.ts != null ? finished.ts - delta : undefined,
      line: finished.line,
    }
  }
  /**
   * 마지막으로 끝난 알림이 error/failed 인데, **그 뒤에 이 엔진이 다시 처리를 시작하지 않았으면** 그 상태로 본다.
   * 뒤에 'Processing notification' 이 또 있으면 이 엔진이 재시도 중이다 — 진행 중.
   */
  const last = exits[exits.length - 1]
  if (last) {
    const lastIdx = recent.lastIndexOf(last.line)
    const retried = recent.slice(lastIdx + 1).some(hostProcessing)
    if (!retried) {
      const failed = last.status === 'failed'
      /**
       * 이유는 **마지막 처리 시도** 의 줄에서만 — 같은 알림을 몇 번 다시 처리하면 앞 시도의 시간 초과까지 세어 대수가 부풀었다.
       * 마지막 'Processing notification' 부터 끝난 줄까지. 그 줄이 tail 밖으로 밀렸으면 처음부터.
       */
      let from = 0
      for (let i = lastIdx; i >= 0; i--)
        if (hostProcessing(recent[i])) {
          from = i
          break
        }
      const attempt = recent.slice(from, lastIdx + 1)
      const reason = failReason(attempt, evac)
      const brief = failBrief(attempt, evac)
      const failedVms = failedInstances(attempt).length || undefined
      return {
        state: failed ? 'failed' : 'error',
        // 'evacuation 실패' 라고 쓰지 않는다 — VM 을 옮기기 전 단계에서 멈춘 것도 그렇게 읽혔다(10-27)
        detail: failed
          ? `재시도까지 실패 (status: failed)${reason ? ` · ${reason}` : evac ? ` · ${evac}대 시도` : ''}`
          : `1차 시도 실패 (status: ${last.status})${reason ? ` · ${reason}` : evac ? ` · ${evac}대 시도` : ''}. masakari 가 한 번 더 시도함`,
        evac,
        uuids: ids,
        at: last.ts != null ? last.ts - delta : undefined,
        line: last.line,
        status: last.status,
        reason,
        brief,
        failedVms,
      }
    }
  }
  // 처리할 알림이 하나도 안 잡혔으면 '진행 중'이 아니라 '아직 아무 일 없음'이다
  if (evac === 0 && !recent.some(hostProcessing))
    return { state: 'idle', detail: '검증 시작 후 evacuation 로그 없음', evac, uuids: ids }
  return { state: 'progress', detail: evac ? `진행 중 · ${evac}대 처리` : '진행 중 · 알림 처리 시작', evac, uuids: ids }
}
