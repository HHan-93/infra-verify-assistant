import type { PodEvent, PodInfo } from '../../electron/shared-types'
import { podDisplayStatus } from './podStatus'

/**
 * 파드 이벤트를 **사람이 바로 읽을 수 있는 모양**으로 바꾼다 — 펼친 행의 '한 줄 결론 · 단계 · 경고 해석'.
 *
 * 원문을 시간순으로 늘어놓기만 했더니(2.11.x 첫 판) 읽기 어려웠다:
 *  - 같은 초에 몰린 이벤트가 섞여 Started 가 Pulling 보다 위에 왔다
 *  - 이미 풀린 FailedScheduling 이 주황으로 가장 눈에 띄어 '지금 문제' 처럼 보였다
 *  - 15줄 중 14줄이 정상 과정(받기·생성·시작)이었다
 *
 * 판단 기준 — 이 저장소의 다른 판정과 같은 결:
 *  - **확신할 수 없으면 해결됨으로 내리지 않는다.** 경고가 '지난 것' 이 되는 길은 둘뿐이다.
 *    (a) 파드가 지금 정상(모든 컨테이너 Ready, 또는 완료)이다.
 *    (b) 배치·이미지·볼륨 단계에서 그 경고 **뒤에** 같은 단계의 성공 이벤트가 왔다.
 *    시작·상태검사 단계에는 (b)를 쓰지 않는다 — CrashLoop 는 BackOff 뒤에 Started 가 매번 다시 온다.
 *  - **기록 없음 ≠ 정상.** 쿠버네티스는 이벤트를 보통 1시간 뒤 지운다. 이벤트가 없으면 '없다' 고만 말한다.
 *  - 해석 사전에 없는 원인은 원문 그대로 둔다 — 모르는 것을 지어내지 않는다.
 */

export type EventStage = 'schedule' | 'volume' | 'image' | 'start' | 'probe' | 'stop' | 'other'

export const STAGE_ORDER: EventStage[] = ['schedule', 'volume', 'image', 'start', 'probe', 'stop', 'other']

export const STAGE_LABEL: Record<EventStage, string> = {
  schedule: '배치',
  volume: '볼륨',
  image: '이미지',
  start: '생성·시작',
  probe: '상태 검사',
  stop: '종료',
  other: '기타',
}

/** 성공을 뜻하는 이벤트 — 같은 단계의 앞선 경고를 '해결됨' 으로 돌릴 수 있는 것 */
const SUCCESS_REASONS = new Set(['Scheduled', 'Pulled', 'SuccessfulAttachVolume', 'Created', 'Started'])
/** 경고 해결을 이벤트 순서로 판정해도 되는 단계 — 시작·상태검사는 반복되는 실패라 순서로는 못 가른다 */
const SEQUENCE_RESOLVABLE = new Set<EventStage>(['schedule', 'volume', 'image'])

export function stageOf(e: PodEvent): EventStage {
  const r = e.reason
  const m = e.message
  if (r === 'Scheduled' || r === 'FailedScheduling' || r === 'Preempted' || r === 'NotTriggerScaleUp') return 'schedule'
  if (/Volume|Mount/.test(r)) return 'volume'
  if (r === 'Pulling' || r === 'Pulled' || r === 'ErrImagePull' || r === 'ImagePullBackOff' || r === 'InspectFailed' ||
      r === 'ErrImageNeverPull')
    return 'image'
  // Failed · BackOff 는 이미지 쪽과 컨테이너 쪽이 같은 이름을 쓴다 — 메시지로 가른다
  if ((r === 'Failed' || r === 'BackOff') && /pull|image/i.test(m)) return 'image'
  if (r === 'Created' || r === 'Started' || r === 'Failed' || r === 'BackOff' || r === 'FailedCreatePodSandBox' ||
      r === 'SandboxChanged' || r === 'FailedCreatePodContainer')
    return 'start'
  if (r === 'Unhealthy' || r === 'ProbeWarning') return 'probe'
  if (r === 'Killing' || r === 'Evicted' || r === 'OOMKilling' || r === 'Preempting' || r === 'FailedKillPod' ||
      r === 'NodeNotReady' || r === 'TaintManagerEviction')
    return 'stop'
  return 'other'
}

/** 같은 초에 몰린 이벤트를 가를 때 쓰는 단계 안 순서(받기 → 받음 → 생성 → 시작) */
const REASON_RANK: Record<string, number> = { Scheduled: 0, Pulling: 1, Pulled: 2, Created: 3, Started: 4 }

/** 시간 흐름대로(오래된 것 → 최근) — 같은 시각이면 단계 순서, 그다음 처음 발생 시각 */
export function orderEvents(events: PodEvent[]): PodEvent[] {
  return [...events].sort((a, b) => {
    const t = (a.atMs ?? 0) - (b.atMs ?? 0)
    if (t) return t
    const s = STAGE_ORDER.indexOf(stageOf(a)) - STAGE_ORDER.indexOf(stageOf(b))
    if (s) return s
    const rr = (REASON_RANK[a.reason] ?? 9) - (REASON_RANK[b.reason] ?? 9)
    if (rr) return rr
    return (a.firstAtMs ?? 0) - (b.firstAtMs ?? 0)
  })
}

/** FailedScheduling 의 "0/8 nodes are available: 2 node(s) didn't match …" 를 풀어 쓴다 */
const SCHED_PHRASES: [RegExp, string][] = [
  [/didn't match pod anti-affinity/i, '안티어피니티(같은 파드끼리 떨어뜨리기) 조건에 걸림'],
  [/didn't match pod affinity/i, '어피니티(특정 파드와 붙이기) 조건에 안 맞음'],
  [/didn't match Pod's node affinity\/selector|didn't match node selector/i, '노드 선택 조건(nodeSelector·affinity)에 안 맞음'],
  [/had untolerated taint|had taint/i, '허용하지 않은 taint 가 있음'],
  [/were unschedulable|unschedulable/i, '배치 금지(cordon) 상태'],
  [/Insufficient cpu/i, 'CPU 부족'],
  [/Insufficient memory/i, '메모리 부족'],
  [/Insufficient ephemeral-storage/i, '임시 디스크 부족'],
  [/Insufficient/i, '자원 부족'],
  [/volume node affinity conflict/i, '볼륨이 있는 노드와 맞지 않음'],
  [/didn't have free ports/i, '요청한 호스트 포트가 이미 쓰임'],
  [/Too many pods/i, '노드의 파드 수 한도 초과'],
  [/not ready|NotReady/i, '노드가 준비 안 됨'],
]

export function explainScheduling(message: string): string[] | null {
  const m = /(\d+)\/(\d+) nodes are available:\s*(.*?)(?:\s*preemption:|$)/is.exec(message)
  if (!m) return null
  const [, avail, total, rest] = m
  const lines = [`노드 ${total}개 중 놓을 수 있는 곳 ${avail}개`]
  const re = /(\d+)\s+(.+?)(?=,\s*\d+\s|\.\s*$|$)/g
  let x: RegExpExecArray | null
  while ((x = re.exec(rest.trim()))) {
    const phrase = x[2].replace(/\.$/, '')
    const ko = SCHED_PHRASES.find(([p]) => p.test(phrase))?.[1]
    // 사전에 없는 문구는 원문 그대로 — 지어내지 않는다
    lines.push(`${x[1]}개: ${ko ?? phrase}`)
  }
  // 하나도 못 풀었으면 해석을 내놓지 않는다(원문을 보게)
  return lines.length > 1 ? lines : null
}

export interface EventExplain {
  /** 사람 말로 된 제목 */
  title: string
  /** 어디를 봐야 하나 */
  hint?: string
  /** 원문을 풀어 쓴 줄들(FailedScheduling 의 노드 사정 등) */
  detail?: string[]
}

/** 정상 이벤트의 한국어 이름 — 원문 목록에서 쓴다 */
const NORMAL_TITLE: Record<string, string> = {
  Scheduled: '노드에 배치됨',
  Pulling: '이미지 받는 중',
  Pulled: '이미지 받음',
  Created: '컨테이너 생성',
  Started: '컨테이너 시작',
  Killing: '컨테이너 종료',
  SuccessfulAttachVolume: '볼륨 붙음',
  SandboxChanged: '파드 샌드박스 다시 만듦',
}

export function explainEvent(e: PodEvent): EventExplain {
  const r = e.reason
  const m = e.message
  const stage = stageOf(e)
  switch (r) {
    case 'FailedScheduling':
      return {
        title: '놓을 노드를 찾지 못함',
        hint: '노드 자원 · taint · affinity 조건',
        detail: explainScheduling(m) ?? undefined,
      }
    case 'FailedMount':
    case 'FailedAttachVolume':
    case 'FailedMapVolume':
      return { title: '볼륨을 붙이지 못함', hint: 'PVC 상태 · 스토리지(Ceph 등) · 다른 노드에 붙어 있는지' }
    case 'ErrImagePull':
    case 'ImagePullBackOff':
    case 'InspectFailed':
    case 'ErrImageNeverPull':
      return { title: '이미지를 받지 못함', hint: '이미지 주소·태그 · 레지스트리 접근(인증·네트워크)' }
    case 'Unhealthy': {
      const kind = /^Liveness/i.test(m) ? 'liveness' : /^Readiness/i.test(m) ? 'readiness' : /^Startup/i.test(m) ? 'startup' : ''
      const what =
        kind === 'liveness'
          ? '실패가 이어지면 컨테이너를 죽이고 다시 띄운다'
          : kind === 'readiness'
            ? '실패하는 동안 서비스 트래픽에서 빠진다'
            : ''
      return {
        title: `상태 검사 실패${kind ? `(${kind})` : ''}${what ? `: ${what}` : ''}`,
        hint: '검사 경로·포트가 응답하는지 · 기동 시간보다 검사가 이르지 않은지',
      }
    }
    case 'ProbeWarning':
      return { title: '상태 검사 경고', hint: '검사 응답 내용' }
    case 'FailedCreatePodSandBox':
      return { title: '파드 네트워크(샌드박스)를 만들지 못함', hint: 'CNI(네트워크 플러그인) · 노드 상태' }
    case 'FailedCreatePodContainer':
      return { title: '컨테이너를 만들지 못함', hint: '메시지의 오류 문구' }
    case 'Evicted':
      return { title: '노드 자원 압박으로 쫓겨남', hint: '노드의 디스크·메모리 사용량' }
    case 'OOMKilling':
      return { title: '메모리 한도 초과로 종료', hint: 'limits.memory · 메모리 사용 추이' }
    case 'Preempted':
    case 'Preempting':
      return { title: '우선순위가 높은 파드에 밀려남', hint: 'PriorityClass · 노드 자원' }
    case 'NodeNotReady':
      return { title: '노드가 응답하지 않음', hint: '노드 상태(kubelet · 네트워크)' }
    case 'FailedKillPod':
      return { title: '컨테이너를 종료하지 못함', hint: '노드 런타임(containerd) 상태' }
    case 'TaintManagerEviction':
      return { title: '노드 taint 로 내보내짐', hint: '노드 taint · tolerations' }
    case 'NotTriggerScaleUp':
      return { title: '자동 확장으로도 놓을 노드가 없음', hint: '노드 그룹 · 자원 요청량' }
    case 'BackOff':
      return stage === 'image'
        ? { title: '이미지 받기 재시도 대기', hint: '이미지 주소·태그 · 레지스트리 접근' }
        : { title: '컨테이너가 계속 죽어 재시작 대기 중', hint: "아래 컨테이너 표의 '직전 종료' 사유 · 컨테이너 로그" }
    case 'Failed':
      return stage === 'image'
        ? { title: '이미지를 받지 못함', hint: '이미지 주소·태그 · 레지스트리 접근(인증·네트워크)' }
        : { title: '컨테이너를 시작하지 못함', hint: '메시지의 Error 문구(명령 · 설정 · 권한 · 참조하는 ConfigMap/Secret)' }
  }
  return { title: NORMAL_TITLE[r] ?? r }
}

export type StageState = 'ok' | 'warn' | 'past' | 'none'

export interface StageSummary {
  stage: EventStage
  state: StageState
  /** 단계 아래 작은 글씨 — "3개 받음" · "manager-2" · "1차 실패 후 성공" */
  notes: string[]
  /** 그 단계 마지막 이벤트 시각(서버 시계) */
  lastAtMs?: number
}

export interface AnnotatedWarning {
  event: PodEvent
  stage: EventStage
  explain: EventExplain
  /** 해결됐다면 무엇으로 — '지금은 정상' 또는 그 뒤의 성공 이벤트 */
  resolvedBy?: { kind: 'healthy' } | { kind: 'event'; reason: string; atMs?: number }
}

export type HeadlineTone = 'ok' | 'progress' | 'bad' | 'done'

export interface PodEventAnalysis {
  headline: { tone: HeadlineTone; text: string; hint?: string }
  stages: StageSummary[]
  current: AnnotatedWarning[]
  past: AnnotatedWarning[]
  ordered: PodEvent[]
}

/** 지금 상태(이벤트가 아니라 컨테이너 상태)에서 바로 말할 수 있는 원인과 볼 곳 */
const STATUS_HINT: Record<string, string> = {
  CrashLoopBackOff: "컨테이너가 계속 죽고 있음: 아래 컨테이너 표의 '직전 종료' 사유와 로그를 보세요",
  ImagePullBackOff: '이미지를 받지 못함: 이미지 주소·태그·레지스트리 접근',
  ErrImagePull: '이미지를 받지 못함: 이미지 주소·태그·레지스트리 접근',
  CreateContainerConfigError: '설정 참조 오류: 없는 ConfigMap/Secret 키를 참조하는지 컨테이너 메시지 확인',
  CreateContainerError: '컨테이너 생성 오류: 컨테이너 메시지 확인',
  InvalidImageName: '이미지 이름 형식이 잘못됨',
  OOMKilled: '메모리 한도 초과로 종료: limits.memory',
  Error: '컨테이너가 오류로 종료: 종료 코드와 로그',
  Evicted: '노드 자원 압박으로 쫓겨남: 노드 디스크·메모리',
  ContainerCreating: '컨테이너 만드는 중: 오래 머물면 볼륨·네트워크 이벤트를 보세요',
  PodInitializing: 'init 컨테이너가 도는 중',
  Terminating: '종료 중: 오래 머물면 finalizer 나 노드 상태를 보세요',
  Pending: '배치·준비 대기 중: 아래 배치 단계를 보세요',
}

function fmtCount(e: PodEvent): string {
  return e.count > 1 ? ` (${e.count}회)` : ''
}

export function analyzePodEvents(pod: PodInfo, events: PodEvent[]): PodEventAnalysis {
  const ordered = orderEvents(events)
  const st = podDisplayStatus(pod)
  const healthy = st.tone === 'ok' || st.tone === 'done'

  const warnings: AnnotatedWarning[] = ordered
    .filter((e) => e.type === 'Warning')
    .map((e) => {
      const stage = stageOf(e)
      let resolvedBy: AnnotatedWarning['resolvedBy']
      if (healthy) resolvedBy = { kind: 'healthy' }
      else if (SEQUENCE_RESOLVABLE.has(stage)) {
        const later = ordered.find(
          (o) =>
            o.type !== 'Warning' &&
            SUCCESS_REASONS.has(o.reason) &&
            stageOf(o) === stage &&
            (o.atMs ?? 0) > (e.atMs ?? 0) &&
            // 컨테이너가 다르면 그 컨테이너의 성공이 이 경고를 풀지 않는다(이미지 A 실패 뒤 이미지 B 받음)
            (!e.container || !o.container || o.container === e.container),
        )
        if (later) resolvedBy = { kind: 'event', reason: later.reason, atMs: later.atMs }
      }
      return { event: e, stage, explain: explainEvent(e), resolvedBy }
    })
  const current = warnings.filter((w) => !w.resolvedBy).reverse() // 지금 경고는 최근 것부터
  const past = warnings.filter((w) => w.resolvedBy)

  // ── 단계 요약
  const stages: StageSummary[] = []
  for (const stage of STAGE_ORDER) {
    const evs = ordered.filter((e) => stageOf(e) === stage)
    if (evs.length === 0) continue
    const hasCurrent = current.some((w) => w.stage === stage)
    const hasPast = past.some((w) => w.stage === stage)
    const notes: string[] = []
    if (stage === 'schedule') {
      const sch = evs.filter((e) => e.reason === 'Scheduled').pop()
      const node = sch && /\bto\s+(\S+)\s*$/.exec(sch.message)?.[1]
      if (node) notes.push(node)
    }
    if (stage === 'image') {
      const pulled = new Set(evs.filter((e) => e.reason === 'Pulled').map((e) => e.container ?? e.message))
      if (pulled.size) notes.push(`${pulled.size}개 받음`)
    }
    if (stage === 'start') {
      const started = new Set(evs.filter((e) => e.reason === 'Started').map((e) => e.container ?? e.message))
      if (started.size) notes.push(`컨테이너 ${started.size}개 시작`)
    }
    if (hasPast && !hasCurrent) notes.push(stage === 'schedule' || stage === 'image' || stage === 'volume' ? '실패 후 성공' : '지난 경고 있음')
    const warnCount = current.filter((w) => w.stage === stage).reduce((n, w) => n + w.event.count, 0)
    if (hasCurrent) notes.push(`경고 ${warnCount}회`)
    stages.push({
      stage,
      state: hasCurrent ? 'warn' : hasPast ? 'past' : 'ok',
      notes,
      lastAtMs: evs[evs.length - 1].atMs,
    })
  }

  // ── 한 줄 결론
  let headline: PodEventAnalysis['headline']
  const top = current[0]
  const topText = top ? `${top.explain.title}${fmtCount(top.event)}` : undefined
  if (st.tone === 'done') {
    headline = { tone: 'done', text: `완료됨: ${st.label}` }
  } else if (healthy) {
    headline = {
      tone: 'ok',
      text: past.length ? `정상: 지난 경고 ${past.length}건은 지금은 해결됨` : '정상: 지금 경고 없음',
    }
  } else if (st.tone === 'bad') {
    const key = pod.waitingReason ?? pod.terminatedReason ?? pod.statusReason ?? st.label
    headline = {
      tone: 'bad',
      text: `지금 문제: ${st.label}${topText ? ` · ${topText}` : ''}`,
      hint: (st.label.startsWith('Init:') ? 'init 컨테이너 단계에서 멈춤: 아래 init 컨테이너의 상태 · ' : '') +
        (STATUS_HINT[key] ?? top?.explain.hint ?? '아래 경고와 컨테이너 상태'),
    }
  } else {
    // 진행 중(Pending · ContainerCreating · Ready 덜 참 · Terminating)
    const key = pod.terminating ? 'Terminating' : pod.waitingReason ?? (pod.initStatus ? 'PodInitializing' : pod.phase)
    headline = {
      tone: 'progress',
      text: `진행 중: ${st.label}${topText ? ` · ${topText}` : ''}`,
      hint: top?.explain.hint ? `${top.explain.title}: ${top.explain.hint}` : STATUS_HINT[key],
    }
  }
  return { headline, stages, current, past, ordered }
}
