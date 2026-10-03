import type { PodInfo } from '../../electron/shared-types'

export type PodTone = 'ok' | 'warn' | 'bad' | 'done'

/** 기다리는 중일 뿐 실패는 아닌 대기 원인 — 이것 말고는 대기 원인이 곧 장애다 */
const TRANSIENT = new Set(['ContainerCreating', 'PodInitializing'])

/**
 * 파드 한 줄의 표시 상태 — kubectl get pods 의 STATUS 컬럼과 같은 우선순위로 고른다.
 *
 * phase 를 그대로 쓰지 않는 이유: 컨테이너가 CrashLoopBackOff 로 계속 죽어도 phase 는
 * Running 으로 남는다. 그걸 초록으로 그리면 죽어 가는 파드가 정상으로 보인다 — 이 앱에서
 * 가장 피해야 할 '거짓 정상' 이다. 그래서 초록(ok)은 **Running 이면서 모든 컨테이너가 Ready**
 * 일 때만 준다. Running 인데 Ready 가 덜 찼으면 warn 이다.
 */
export function podDisplayStatus(p: PodInfo): { label: string; tone: PodTone } {
  if (p.terminating) return { label: 'Terminating', tone: 'warn' }
  if (p.initStatus) {
    const progress = /^\d+\/\d+$/.test(p.initStatus)
    return { label: `Init:${p.initStatus}`, tone: progress || TRANSIENT.has(p.initStatus) ? 'warn' : 'bad' }
  }
  if (p.waitingReason) return { label: p.waitingReason, tone: TRANSIENT.has(p.waitingReason) ? 'warn' : 'bad' }
  if (p.phase === 'Succeeded') return { label: p.terminatedReason || 'Completed', tone: 'done' }
  if (p.terminatedReason) return { label: p.terminatedReason, tone: p.terminatedReason === 'Completed' ? 'done' : 'bad' }
  if (p.statusReason) return { label: p.statusReason, tone: 'bad' }
  if (p.phase === 'Running')
    return {
      label: 'Running',
      tone: p.totalContainers > 0 && p.readyCount === p.totalContainers ? 'ok' : 'warn',
    }
  if (p.phase === 'Pending') return { label: 'Pending', tone: 'warn' }
  return { label: p.phase, tone: 'bad' }
}
