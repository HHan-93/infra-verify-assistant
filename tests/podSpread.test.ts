// 검증 전 파드 분산 점검 — 규칙 읽기와 판정. 규칙 모양은 2026-10-27 두 환경의 실제 조회 결과
// (epoxy: preferred hostname + ScheduleAnyway / master03: required hostname + ScheduleAnyway)를 그대로 옮긴 것이다
import { test, eq } from './harness'
import { parseSpread, spreadVerdict, splitSpreadOutput } from '../src/lib/podSpread'

const deploy = (name: string, anti: 'required' | 'preferred' | 'none', ns = 'boot-factory', replicas = 2) => ({
  kind: 'Deployment',
  metadata: { name, namespace: ns },
  spec: {
    replicas,
    template: {
      spec: {
        affinity:
          anti === 'required'
            ? { podAntiAffinity: { requiredDuringSchedulingIgnoredDuringExecution: [{ topologyKey: 'kubernetes.io/hostname' }] } }
            : anti === 'preferred'
              ? { podAntiAffinity: { preferredDuringSchedulingIgnoredDuringExecution: [{ weight: 100, podAffinityTerm: { topologyKey: 'kubernetes.io/hostname' } }] } }
              : undefined,
        topologySpreadConstraints: [{ topologyKey: 'kubernetes.io/hostname', whenUnsatisfiable: 'ScheduleAnyway', maxSkew: 1 }],
      },
    },
  },
})
const pod = (name: string, rs: string, node: string, phase = 'Running', del = '<none>', ns = 'boot-factory') =>
  `${ns}   ${name}   ${node}   ${phase}   ${del}   ReplicaSet   ${rs}`

test('epoxy — preferred 인데 두 레플리카가 manager2 에만: 몰림', () => {
  const ctrl = JSON.stringify({ items: [deploy('boot-factory-auth', 'preferred')] })
  const pods = [
    pod('boot-factory-auth-674ccd4f7b-6cchp', 'boot-factory-auth-674ccd4f7b', 'epoxy-manager2'),
    pod('boot-factory-auth-674ccd4f7b-9bpwj', 'boot-factory-auth-674ccd4f7b', 'epoxy-manager2'),
    pod('boot-factory-auth-674ccd4f7b-j65sr', 'boot-factory-auth-674ccd4f7b', 'epoxy-manager1', 'Running', '2026-10-26T09:00:00Z'),
  ].join('\n')
  const r = parseSpread(ctrl, pods, ['boot-factory'])
  eq(r?.map((w) => [w.anti, w.spread, w.verdict, w.placement]), [['preferred', 'preferred', 'stacked', { 'epoxy-manager2': 2 }]])
})

test('master03 — required 이고 나뉘어 있으면 ok · preferred 로 나뉘어 있으면 soft', () => {
  eq(spreadVerdict({ replicas: 2, anti: 'required', spread: 'preferred', placement: { m1: 1, m2: 1 } }), 'ok')
  eq(spreadVerdict({ replicas: 2, anti: 'preferred', spread: 'preferred', placement: { m1: 1, m2: 1 } }), 'soft')
  eq(spreadVerdict({ replicas: 2, anti: 'none', spread: 'none', placement: { m1: 1, m2: 1 } }), 'none')
})

test('레플리카 1개는 single · 장애 중 1개만 Running 이면 몰림이 아니다', () => {
  eq(spreadVerdict({ replicas: 1, anti: 'none', spread: 'none', placement: { m1: 1 } }), 'single')
  eq(spreadVerdict({ replicas: 2, anti: 'required', spread: 'none', placement: { m2: 1 } }), 'ok')
})

test('고르지 않은 네임스페이스 · 다른 워크로드의 파드는 섞지 않는다', () => {
  const ctrl = JSON.stringify({ items: [deploy('api', 'none', 'a'), deploy('api-admin', 'none', 'a'), deploy('x', 'none', 'b')] })
  const pods = [pod('api-5d8f9c7b6d-aaaaa', 'api-5d8f9c7b6d', 'n1', 'Running', '<none>', 'a'), pod('api-admin-7f6b5c4d3e-bbbbb', 'api-admin-7f6b5c4d3e', 'n2', 'Running', '<none>', 'a')].join('\n')
  const r = parseSpread(ctrl, pods, ['a'])
  eq(r?.map((w) => `${w.name}:${JSON.stringify(w.placement)}`), ['api:{"n1":1}', 'api-admin:{"n2":1}'])
})

test('출력 나누기 · JSON 이 아니면 null(조회 실패 ≠ 문제 없음)', () => {
  eq(splitSpreadOutput('{"items":[]}\n__QT_PODS__\nx\n__QT_DESCHED__\n0\n').descheduler, false)
  eq(parseSpread('error: the server has asked for the client to provide credentials', '', ['a']), null)
})
