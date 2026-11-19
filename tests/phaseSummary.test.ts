// 그룹 리포트 차수별 요약 — 이슈 · 원인 · 조치 · 결과 표의 줄 짜기(실제 그룹 리포트에 적힌 사전 점검 · 1회차 내용 꼴)
import { test, eq, ok } from './harness'
import { actionItems, issueView, layoutPhase, mergeResult, type SumAction, type SumIssue } from '../src/lib/phaseSummary'

test('조치 글 — 일반 줄은 글머리표, - 줄은 바로 위 조치의 세부', () => {
  eq(
    actionItems('파드 분산 배치 적용\n- boot-factory, contrabass 네임스페이스\n  - podAntiAffinity 설정\n\n클러스터 생성 시 master ID 지정'),
    [
      { text: '파드 분산 배치 적용', subs: ['boot-factory, contrabass 네임스페이스', 'podAntiAffinity 설정'] },
      { text: '클러스터 생성 시 master ID 지정', subs: [] },
    ],
  )
  // 첫 줄부터 - 면 그 줄을 조치로 올린다(제목 없는 세부가 되지 않게)
  eq(actionItems('- haproxy timeout 조정 (3600s -> 60s)'), [{ text: 'haproxy timeout 조정 (3600s -> 60s)', subs: [] }])
})

test('이슈 글 — 첫 줄 제목, 나머지 설명(앞 - 뗌)', () => {
  eq(issueView({ id: 'a', text: '마사카리 실패\n- VM 11대 중 5대 실패' }), { id: 'a', title: '마사카리 실패', lines: ['VM 11대 중 5대 실패'] })
})

test('결과 합치기 — 덜 끝난 쪽, 표시 안 함은 다른 값이 있으면 무시', () => {
  eq(mergeResult(['done', 'wip']), 'wip')
  eq(mergeResult(['done', 'repro', 'wip']), 'repro')
  eq(mergeResult(['none', 'done']), 'done')
  eq(mergeResult([undefined, 'none']), 'none')
})

test('사전 점검 — 조치 하나가 이슈 둘을 해결하면 이슈를 붙이고 조치 칸 하나', () => {
  const issues: SumIssue[] = [
    { id: 'i1', text: '마사카리 실패\n- VM 11대 중 5대 실패' },
    { id: 'i3', text: 'Manager VM OOM 발생' },
    { id: 'i2', text: '마사카리 실패\n- VM 11대 중 7대 실패' },
  ]
  const actions: SumAction[] = [
    { id: 'a1', team: 'Expert팀', cause: 'api 가 shutdown 된 호스트로 요청', text: 'haproxy timeout 조정', issueIds: ['i2', 'i1'], result: 'done' },
    { id: 'a2', team: '라이프싸이클팀', text: '파드 분산 배치 적용', issueIds: ['i3'], result: 'done' },
    { id: 'a3', team: 'Expert팀', text: 'Masakari 로그 레벨 DEBUG', result: 'wip' },
  ]
  const b = layoutPhase(issues, actions)
  eq(b.map((x) => x.kind), ['issues', 'issues', 'common'])
  // 뒤에 적은 i2 가 i1 옆으로 당겨진다(조치 기준으로 붙임), 이슈 id 순서는 적은 순서
  ok(b[0].kind === 'issues' && b[0].issues.map((x) => x.id).join() === 'i1,i2' && b[0].act?.causes[0] === 'api 가 shutdown 된 호스트로 요청', '묶음')
  ok(b[1].kind === 'issues' && b[1].issues[0].id === 'i3' && b[1].act?.team === '라이프싸이클팀', 'OOM')
  ok(b[2].kind === 'common' && b[2].acts[0].result === 'wip', '공통')
})

test('1회차 4번 — 같은 이슈에 같은 팀이 따로 적은 조치 둘은 한 칸(글머리표 둘), 원인 하나', () => {
  const issues: SumIssue[] = [{ id: 'p', text: '포털 로그인 시 500 에러' }, { id: 'n', text: 'nova conductor 응답 없음' }]
  const actions: SumAction[] = [
    { id: 'a1', team: '라이프싸이클팀', cause: 'DHCP 도메인 수신 차단 설정 누락', text: 'openstacklocal false 옵션 변경', issueIds: ['p'], result: 'done' },
    { id: 'a2', team: '라이프싸이클 팀', text: 'master ID 지정해 replica 배정\n- Pod 대기 5분 타임아웃 추가', issueIds: ['p'], result: 'done' },
  ]
  const b = layoutPhase(issues, actions)
  eq(b.length, 2)
  const g = b[0].kind === 'issues' ? b[0].act : null
  eq(g?.items.map((x) => x.text), ['openstacklocal false 옵션 변경', 'master ID 지정해 replica 배정'])
  eq(g?.causes, ['DHCP 도메인 수신 차단 설정 누락'])
  // 조치 없는 이슈는 조치 칸이 비어 있다('-')
  ok(b[1].kind === 'issues' && b[1].act === null, '조치 없음')
})

test('이슈 하나에 다른 팀 조치 둘 — 이슈 칸 합치고 조치는 줄마다', () => {
  const b = layoutPhase([{ id: 'p', text: '포털 지연' }], [
    { id: 'a', team: 'Expert팀', text: 'haproxy 조정', issueIds: ['p'] },
    { id: 'b', team: '라이프싸이클팀', text: 'coredns 정리', issueIds: ['p'] },
  ])
  ok(b.length === 1 && b[0].kind === 'acts' && b[0].acts.length === 2, '나눔')
})

test('얽힌 경우 — 합칠 수 없으면 조치를 이슈 줄마다 다시 싣는다, 지운 이슈를 가리키는 id 는 버린다', () => {
  const issues: SumIssue[] = [{ id: 'x', text: 'A' }, { id: 'y', text: 'B' }, { id: 'z', text: 'C' }]
  const b = layoutPhase(issues, [
    { id: 'a', team: 'T1', text: '조치 1', issueIds: ['x', 'y'] },
    { id: 'b', team: 'T2', text: '조치 2', issueIds: ['y', 'z', 'gone'] },
  ])
  // x: 조치 1 만(하지만 조치 1 이 묶은 y 에 조치 2 도 있어 합치지 못함) → x 한 줄, y 조치 둘, z 조치 2
  eq(b.map((x) => x.kind), ['issues', 'acts', 'issues'])
  ok(b[0].kind === 'issues' && b[0].act?.team === 'T1', 'x')
  ok(b[2].kind === 'issues' && b[2].act?.team === 'T2' && b[2].act.issueIds.join() === 'y,z', 'z')
})
