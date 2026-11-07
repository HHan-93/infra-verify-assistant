// 포털 증적 나누기 · 연속 통과 기록 줄이기 · 목차 줄(포털 나눔 · 파드 로그 접기)
import { test, eq, ok } from './harness'
import { applyRunTruth, compactStreak, portalEvidenceView, portalStartAt } from '../src/lib/portalEvidence'
import { arrangeEvidence, tocEntries } from '../src/lib/evidenceToc'
import { portalStreakTable, type PortalEvent } from '../src/lib/portalPhases'
import type { BoardEvidenceItem } from '../electron/shared-types'

const T = (hms: string) => new Date(`2026-10-28T${hms}+09:00`).getTime()

// 10-28 2회차(contrabass02 down) 에 저장된 포털 증적의 사실 문구 그대로(옛 '페이지' 표기 · 다시 끊김 괄호 포함)
const portalItem = (tables: BoardEvidenceItem['tables'] = []): BoardEvidenceItem => ({
  key: 'portal',
  title: '포털 응답 기록',
  capturedAt: T('13:06:16'),
  host: 'Q-Term (이 PC)',
  command: '포털 감시',
  text: '',
  facts: [
    { label: '최초 끊김 (로그인 페이지)', at: T('12:47:48') },
    { label: '1차 정상화: 4개 페이지가 처음 모두 정상', at: T('12:49:26') },
    { label: '다시 끊김: 인스턴스 모니터링(CPU) (12:49:26 정상화 뒤)', at: T('12:58:15') },
    { label: '다시 끊김: 로그인 페이지 (12:49:26 정상화 뒤)', at: T('13:03:30') },
    { label: '최종 정상화: 그 뒤 다시 끊기지 않음', at: T('13:06:03') },
  ],
  table: { title: '페이지별', columns: ['페이지', '최초 끊김', '처음 정상화', '다시 끊김', '최종 정상화'], rows: [['로그인 페이지', '12:47:48', '12:49:26', '1회', '13:05:14']] },
  tables,
})

test('포털 증적의 사실 문구를 카드 · 순서로 나눈다(옛 페이지 표기 포함)', () => {
  const v = portalEvidenceView(portalItem())
  eq(v.first?.at, T('12:47:48'))
  eq(v.firstAll?.at, T('12:49:26'))
  eq(v.screens, 4)
  eq(v.flaps.length, 2)
  eq(v.final?.at, T('13:06:03'))
  eq(portalStartAt(v), T('12:47:48'))
  eq(v.facts.map((f) => f.role), ['first', 'firstAll', 'flap', 'flap', 'final'])
  // 1차 뒤 다시 끊김: 12:58:15 · 13:03:30 두 순간 → 2회, 화면 2건
  eq([v.flapTimes, v.flapRows], [2, 2])
})

test('같은 순간 끊긴 화면은 다시 끊김 한 번으로 센다(리포트 요약과 같은 셈)', () => {
  const it = portalItem()
  it.facts = [
    { label: '1차 정상화: 4개 화면이 처음 모두 정상', at: T('12:49:26') },
    { label: '다시 끊김: 로그인 페이지', at: T('13:03:30') },
    { label: '다시 끊김: 인스턴스 목록', at: T('13:03:31') },
    { label: '다시 끊김: 대시보드', at: T('13:03:41') },
  ]
  const v = portalEvidenceView(it)
  eq([v.flapTimes, v.flapRows], [2, 3])
})

test('이력이 모두 정상화면 증적에 굳은 미복구를 바로잡는다(10-28 2회차)', () => {
  const it = portalItem()
  // 2회차 증적: 최종 정상화 줄 없이 '아직 안 돌아온 화면' 이 남아 있었다
  it.facts = [
    ...(it.facts ?? []).filter((f) => !f.label.startsWith('최종')),
    { label: '아직 안 돌아온 화면', text: '인스턴스 목록' },
  ]
  const raw = portalEvidenceView(it)
  eq(raw.pending, '인스턴스 목록')
  eq(raw.final, undefined)
  const pages = { title: '', columns: ['화면', '최초 끊김', '처음 정상화', '다시 끊김', '최종 정상화'], rows: [['인스턴스 목록', '12:47:48', '12:49:26', '1회', '13:06:03']], bad: [false] }
  const v = applyRunTruth(raw, { pending: [], firstAll: T('12:49:26'), finalAll: T('13:06:03'), pages })
  eq(v.pending, undefined)
  eq(v.final?.at, T('13:06:03'))
  eq(v.facts.map((f) => f.role), ['first', 'firstAll', 'flap', 'flap', 'final'])
  eq(v.pages?.rows[0][4], '13:06:03')
  eq(v.pages?.title, '페이지별')
})

test('이력에 미복구가 남았으면 최종 정상화를 지운다', () => {
  const v = applyRunTruth(portalEvidenceView(portalItem()), { pending: ['대시보드'], firstAll: T('12:49:26'), finalAll: null })
  eq(v.final, undefined)
  eq(v.pending, '대시보드')
  eq(v.facts[v.facts.length - 1].role, 'pending')
})

// portalStreakTable 이 만든 표를 그대로 넣어 꼴이 맞물리는지 본다
const poll = (at: number, ok: boolean, ms: number, status = ok ? 200 : 503) => ({
  at,
  ok,
  apis: [
    { name: 'GET /api/v1/instances', ok, status, ms },
    { name: 'GET /api/v1/projects', ok: true, status: 200, ms: ms + 10 },
  ],
})
const upEvent = (start: string, tag: string) => {
  const t = T(start)
  const e: PortalEvent = {
    at: t + 1000,
    name: '인스턴스 목록',
    kind: 'up',
    confirmAt: t + 10_000,
    n: 3,
    streak: [poll(t, false, 20), poll(t + 1000, true, 77), poll(t + 2000, true, 51), poll(t + 3000, true, 64)],
  } as PortalEvent
  return portalStreakTable(e, tag)
}

test('연속 통과 기록은 API 마다 한 줄로 줄인다(앞 실패 · n/n · 응답 범위 · 중앙값)', () => {
  const tb = upEvent('12:49:25', '1차 정상화를 채운 화면')
  ok(tb, '표가 만들어져야 함')
  const c = compactStreak(tb!)
  ok(c, '줄일 수 있어야 함')
  eq(c!.columns, ['핵심 API (2개)', '앞(실패)', '연속 통과', '응답 시간', '중앙값'])
  eq(c!.rows[0], ['GET /api/v1/instances', '✗ 503', '✓ 3/3', '51 ~ 77ms', '64ms'])
  eq(c!.rows[1][1].startsWith('✓'), true)
  eq(c!.bad, [false, false])
})

test("'-' 칸(그 주기에 API 없음)은 실패로 세지 않는다", () => {
  const c = compactStreak({
    title: 't',
    columns: ['핵심 API', '1', '2', '3'],
    rows: [
      ['요청 시각', '12:00:01', '12:00:02', '12:00:03'],
      ['GET /a', '✓ 10ms', '-', '✓ 30ms'],
    ],
  })
  eq(c!.rows[0].slice(1), ['-', '✓ 2/2', '10 ~ 30ms', '30ms'])
  eq(c!.bad, [false])
})

test('꼴이 다른 표는 줄이지 않는다', () => {
  eq(compactStreak({ title: 'x', columns: ['화면', 'a'], rows: [['a', 'b']] }), null)
})

test('1차 · 최종 표를 제목으로 가른다', () => {
  const v = portalEvidenceView(portalItem([upEvent('12:49:25', '1차 정상화를 채운 화면')!, upEvent('13:06:02', '최종 정상화')!, upEvent('12:58:28', '')!]))
  eq(v.streaks.map((s) => s.role), ['first', 'final', ''])
})

test('목차: 포털은 시각마다 나뉘어 각자 묶음에 들고, 파드 로그 이상은 묶음마다 한 줄로 접힌다', () => {
  const base = T('12:45:36')
  const up = T('12:58:34')
  const items: BoardEvidenceItem[] = [
    { key: 'down', title: '호스트 DOWN: contrabass02', capturedAt: T('12:47:50'), host: '', command: '', text: '' },
    portalItem(),
    { key: 'podlog:1', title: 'monitoring 파드 로그: connection refused', capturedAt: T('12:50:00'), host: '', command: '', text: '' },
    { key: 'podlog:2', title: 'ceph 파드 로그: timeout', capturedAt: T('12:52:00'), host: '', command: '', text: '' },
    { key: 'masakari', title: 'Masakari evacuation 완료 · VM 10대', capturedAt: T('12:57:00'), host: '', command: '', text: '' },
    { key: 'podlog:0', title: 'cilium 파드 로그: before', capturedAt: T('12:40:00'), host: '', command: '', text: '' },
  ]
  const arr = arrangeEvidence(items, (it) => (it.key === 'portal' ? T('12:47:48') : it.key === 'down' ? T('12:47:38') : null), base, up)
  const e = tocEntries(arr, base, up, { masaDone: true, portal: portalEvidenceView })
  eq(
    e.map((x) => [x.label, x.grp, x.part, x.tone]),
    [
      ['cilium · before', 0, '', ''],
      ['호스트 DOWN: contrabass02', 1, '', 'kd'],
      ['포털 최초 끊김', 1, '', ''],
      ['포털 1차 정상화 (4/4 화면)', 1, 'firstAll', 'kr'],
      ['파드 로그 이상 2건', 1, '', ''],
      ['Masakari evacuation 완료 · VM 10대', 1, '', 'kr'],
      ['포털 다시 끊김 2회', 1, 'flap', ''],
      ['포털 최종 정상화 (4/4 화면)', 2, 'final', 'dim'],
    ],
  )
  eq(e[4].fold?.map((x) => x.label), ['monitoring · connection refused', 'ceph · timeout'])
})
