// 위험 명령 판별 — OpenStack 정합성 점검 프리셋(조회 전용)은 걸리지 않고, DB 를 바꾸는 것만 걸리는지
import { test, eq, ok } from './harness'
import { dangerReason } from '../src/lib/dangerCmd'
import { PRESETS } from '../src/presets'

test('정합성 점검 프리셋은 하나도 위험으로 걸리지 않는다(deleted · updated_at 컬럼 포함)', () => {
  const sol = PRESETS.find((s) => s.solution === 'OpenStack 정합성 점검')
  ok(sol, '솔루션이 있어야 함')
  const hit: string[] = []
  for (const g of sol!.subgroups) for (const c of g.commands) if (c.command && dangerReason(c.command)) hit.push(c.label)
  eq(hit, [])
})

test('DB 값을 바꾸는 쿼리는 걸린다', () => {
  ok(dangerReason(`mysql -u root -e "USE cinder; UPDATE quota_usages SET deleted=1 WHERE id=297;"`), 'UPDATE')
  ok(dangerReason(`mysql -u root -e "DELETE FROM cinder.reservations WHERE deleted=0;"`), 'DELETE')
  ok(dangerReason(`mysql -e "drop table x;"`), 'DROP 소문자')
})

test('DB 조회는 걸리지 않는다', () => {
  eq(dangerReason(`mysql -u root -e "SELECT id, updated_at FROM volumes WHERE deleted=0;"`), null)
  eq(dangerReason(`mysql -u root -e "SHOW DATABASES;"`), null)
})

test('*-manage 는 바꾸는 것만 걸린다', () => {
  ok(dangerReason('cinder-manage quota sync --project-id abc'), 'quota sync')
  eq(dangerReason('cinder-manage quota check --project-id abc'), null)
  eq(dangerReason('nova-manage placement audit --verbose'), null)
  ok(dangerReason('nova-manage placement audit --verbose --delete'), 'audit --delete')
  eq(dangerReason('nova-manage placement heal_allocations --dry-run --verbose'), null)
  ok(dangerReason('nova-manage placement heal_allocations --verbose'), 'heal 실제')
  ok(dangerReason('nova-manage db archive_deleted_rows --until-complete'), 'archive')
})

test('DB 권한 · 계정 변경은 걸리고, 권한 조회는 걸리지 않는다', () => {
  ok(dangerReason(`mysql -u root -e "GRANT ALL PRIVILEGES ON nova.* TO 'nova'@'%';"`), 'GRANT')
  ok(dangerReason(`mysql -u root -e "REVOKE SELECT ON cinder.* FROM 'x'@'%';"`), 'REVOKE')
  ok(dangerReason(`mysql -u root -e "DROP USER 'x'@'%';"`), 'DROP USER')
  ok(dangerReason(`mysql -u root -e "CREATE USER 'x'@'%' IDENTIFIED BY 'p';"`), 'CREATE USER')
  ok(dangerReason(`mysql -u root -e "SET PASSWORD FOR 'x'@'%' = PASSWORD('p');"`), 'SET PASSWORD')
  eq(dangerReason(`mysql -u root -e "SHOW GRANTS FOR 'nova'@'%';"`), null)
  eq(dangerReason(`mysql -u root -e "SELECT user, host FROM mysql.user;"`), null)
})
