// 검증 그룹 차수별 환경 — 같은 환경 판단 · 바뀐 점 문장
import { test, eq, ok } from './harness'
import { envSame, envChanges, type DiffEnv } from '../src/lib/groupEnvDiff'

const base = (): DiffEnv => ({
  inject: 'IPMI 포털 접속 후 Power Down',
  notes: ['웹 서비스 VM 은 매 회차 옮겨 둔다'],
  nodes: [
    { label: '노드 1', host: 'contrabass01', controller: true, compute: true, vms: [{ name: 'master01', kind: 'k8s', evac: false }, { name: 'webserver01~10', count: 10, kind: 'web', evac: true }] },
    { label: '노드 2', host: 'contrabass02', controller: true, compute: true, vms: [{ name: 'master02', kind: 'k8s', evac: false }] },
    { label: '노드 4', host: 'contrabass04', controller: false, compute: true, vms: [] },
  ],
})

test('차수 환경 — id · 공백만 다르면 같은 환경, 메모가 다르면 다른 환경', () => {
  const a = base()
  const b = base()
  b.nodes[0].host = ' contrabass01 '
  ok(envSame(a, b), '공백')
  b.notes = ['다른 메모']
  ok(!envSame(a, b), '메모')
  ok(envSame(undefined, undefined) && !envSame(a, undefined), '없음')
})

test('차수 환경 — 바뀐 점: VM 이동 · 추가 · 뺌, 노드 호스트 · 추가, 장애 주입', () => {
  const b = base()
  const c = base()
  c.inject = '전원 케이블 분리'
  // webserver 를 노드 2 로, 노드 4 에 manager03 추가, master02 뺌
  const web = c.nodes[0].vms.pop()!
  c.nodes[1].vms = [web]
  c.nodes[2].vms.push({ name: 'manager03', kind: 'k8s', evac: false })
  c.nodes[0].host = 'contrabass11'
  c.nodes.push({ label: '노드 5', host: 'contrabass05', controller: false, compute: true, vms: [] })
  eq(envChanges(b, c), [
    '장애 주입: IPMI 포털 접속 후 Power Down → 전원 케이블 분리',
    '노드 1 호스트 contrabass01 → contrabass11',
    '노드 5(contrabass05) 추가',
    'webserver01~10 을 노드 1 → 노드 2 로',
    '노드 4 에 manager03 추가',
    '노드 2 의 master02 뺌',
  ])
  eq(envChanges(b, base()), [])
})
