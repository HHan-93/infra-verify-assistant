import type { PodInfo } from '../../electron/shared-types'
import { podDisplayStatus } from './podStatus'

/**
 * 파드 재시작 한 건의 진행 — "누른 뒤 몇 초 만에 새 파드가 Ready 가 되었는가" 를 잰다.
 *
 * 이 앱의 본업(언제 복구되는가를 잰다)을 파드 하나 단위로 옮긴 것이라 같은 규칙을 따른다.
 * - **한 번 튄 Ready 는 복구가 아니다.** 연속 READY_STREAK 번 관측돼야 확정하고, 확정 시각은
 *   그 연속의 **첫 관측** 시각으로 찍는다(마지막 관측으로 찍으면 확인하느라 기다린 시간이 더해진다).
 * - **조회 실패는 관측이 아니다.** 실패한 회차에는 stepRestart 를 부르지 않는다 — 목록이 비어
 *   보인다고 '옛 파드가 사라졌다' 로 찍으면 안 된다.
 * - 시각은 epoch ms(이 PC 시계)로 들고, 서버 시계로 찍힌 생성 시각과 비교할 때만 skew 를 더한다.
 *
 * 관측은 목록을 받을 때만 일어나므로 잰 값은 **갱신 간격만큼 늦게** 잡힐 수 있다(1초 자동 갱신이면
 * 1~2초). 화면에 '약' 을 붙이는 이유다.
 */
export interface RestartTrack {
  /** 추적 한 건의 키 — 같은 파드를 두 번 재시작해도 갈리게 시각을 붙인다 */
  id: string
  namespace: string
  oldName: string
  oldUid?: string
  generateName?: string
  /** 삭제를 요청한 시각(이 PC 시계) */
  startedAt: number
  /** 같은 순간의 서버 시계 — 새 파드 생성 시각과 비교하는 기준 */
  startedServerMs: number
  /** 옛 파드가 목록에서 사라진 것을 처음 본 시각 */
  oldGoneAt?: number
  /** 옛 파드가 Terminating 으로 보이는 중인가 */
  oldTerminating?: boolean
  newName?: string
  newSeenAt?: number
  /** 지금 이어지고 있는 Ready 연속 관측의 첫 시각과 횟수 */
  streakSince?: number
  streak: number
  /** 확정된 Ready 시각 = 연속 관측의 첫 시각 */
  readyAt?: number
  /** 제한 시간 안에 Ready 가 안 됨 */
  timedOut?: boolean
}

export const READY_STREAK = 2
/** 이만큼 지나도 Ready 가 안 되면 추적을 '시간 초과' 로 닫는다 — 영원히 '대기 중' 으로 남지 않게 */
export const TRACK_TIMEOUT_MS = 10 * 60_000
/**
 * 새 파드 생성 시각이 '삭제 요청 시각' 보다 이만큼 이르더라도 새 파드로 본다 — skew 를 못 잰 호스트
 * (date 가 %3N 을 모름)나 돌아오는 지연으로 생기는 오차 몫. ReplicaSet 의 다른 복제본은 보통
 * 몇 시간~며칠 전에 생겼으므로 이 정도 여유로는 섞이지 않는다.
 */
const CREATED_SLACK_MS = 5_000

export function startRestartTrack(p: PodInfo, now: number, skewMs: number): RestartTrack {
  return {
    id: `${p.namespace}/${p.name}@${now}`,
    namespace: p.namespace,
    oldName: p.name,
    oldUid: p.uid,
    generateName: p.generateName,
    startedAt: now,
    startedServerMs: now + skewMs,
    streak: 0,
  }
}

/** 이 목록에서 옛 파드를 대신하는 새 파드 — StatefulSet 은 같은 이름·다른 uid, 나머지는 같은 generateName */
export function findReplacement(t: RestartTrack, pods: PodInfo[]): PodInfo | undefined {
  // 한 번 정한 짝은 이름으로 계속 따라간다(그 사이 또 다른 파드가 생겨도 갈아타지 않게)
  if (t.newName) return pods.find((p) => p.name === t.newName && p.uid !== t.oldUid)
  const cands = pods.filter(
    (p) =>
      p.uid !== t.oldUid &&
      (p.name === t.oldName || (!!t.generateName && p.generateName === t.generateName)) &&
      p.createdAtMs !== undefined &&
      p.createdAtMs >= t.startedServerMs - CREATED_SLACK_MS,
  )
  // 여러 개면 가장 먼저 생긴 것 — 컨트롤러가 이 삭제에 대응해 만든 첫 파드다
  return cands.sort((a, b) => (a.createdAtMs ?? 0) - (b.createdAtMs ?? 0))[0]
}

/** 목록 한 번을 관측으로 반영한다 — 조회가 **성공한** 목록에만 부를 것 */
export function stepRestartTrack(t: RestartTrack, pods: PodInfo[], now: number): RestartTrack {
  if (t.readyAt !== undefined || t.timedOut) return t
  const next: RestartTrack = { ...t }
  const old = pods.find((p) => (t.oldUid ? p.uid === t.oldUid : p.name === t.oldName))
  next.oldTerminating = !!old?.terminating
  if (!old && next.oldGoneAt === undefined) next.oldGoneAt = now

  const nw = findReplacement(t, pods)
  if (nw) {
    if (!next.newName) {
      next.newName = nw.name
      next.newSeenAt = now
    }
    if (podDisplayStatus(nw).tone === 'ok') {
      next.streak = t.streak + 1
      next.streakSince = t.streakSince ?? now
      if (next.streak >= READY_STREAK) next.readyAt = next.streakSince
    } else {
      next.streak = 0
      next.streakSince = undefined
    }
  } else {
    // 짝으로 정했던 새 파드가 사라졌다(그것마저 죽어 다시 만들어지는 중) — 처음부터 다시 찾는다
    if (t.newName) {
      next.newName = undefined
      next.newSeenAt = undefined
    }
    next.streak = 0
    next.streakSince = undefined
  }
  if (next.readyAt === undefined && now - t.startedAt > TRACK_TIMEOUT_MS) next.timedOut = true
  return next
}
