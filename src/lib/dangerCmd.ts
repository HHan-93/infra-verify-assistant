/**
 * 되돌리기 어렵거나 서비스를 멈추는 명령인가 — 프리셋을 누른 즉시 실행하기 전에 한 번 묻는 기준.
 *
 * 프리셋은 '누르면 그 세션 터미널에서 바로 실행' 이라, `cat list.txt | xargs -I {} rm -rf {}` 같은
 * **문법 예시**까지 클릭 한 번에 돌았다. 동시 입력(브로드캐스트) 중이면 모든 세션에서 돈다.
 * 모든 프리셋에 확인을 붙이면 조회 명령까지 매번 눌러야 해서 확인창을 습관처럼 넘기게 되므로,
 * 여기 걸리는 것에만 붙인다. 판정은 '지우기 · 끄기 · 죽이기 · 밀어내기' 동사만 본다 —
 * 조회(get·list·status)는 걸지 않는다.
 *
 * 최상위 `;` `&&` `|` 로 이어진 어느 조각이든 걸리면 위험으로 본다(`… | xargs rm -rf`).
 */
const RULES: [RegExp, string][] = [
  [/\brm\s+(-[a-zA-Z]*[rRf][a-zA-Z]*\s+)+/, '파일 삭제(rm -r/-f)'],
  [/\bxargs\b[^|;&]*\brm\b/, 'xargs 로 여러 파일 삭제'],
  // find 에 붙은 것만 — `kubectl drain --delete-emptydir-data` 의 '-delete' 를 잡지 않게
  [/\bfind\b[^|;&]*(-exec\s+rm\b|\s-delete\b)/, 'find 로 찾은 파일 삭제'],
  [/\b(reboot|poweroff|halt|shutdown)\b/, '서버 재부팅·종료'],
  [/\binit\s+[06]\b/, '서버 재부팅·종료'],
  [/\bkubectl\b[^|;&]*\b(delete|drain|cordon|scale\s+[^|;&]*--replicas[= ]0)\b/, '쿠버네티스 리소스 삭제·노드 비우기'],
  [/\bdocker\b[^|;&]*\b(rm|rmi|stop|kill|system\s+prune|volume\s+rm)\b/, '컨테이너 중지·삭제'],
  [/\bkill\s+-(9|KILL|s\s+KILL)\b|\bpkill\b|\bkillall\b/, '프로세스 강제 종료'],
  [/\bmkfs(\.\w+)?\b|\bwipefs\b|\bdd\s+[^|;&]*\bof=/, '디스크 포맷·덮어쓰기'],
  [/\bsystemctl\s+(stop|restart|disable|mask|kill)\b/, '서비스 중지·재시작'],
  [/\bvirsh\s+(destroy|undefine)\b/, 'VM 강제 종료·삭제'],
  [/\bopenstack\b[^|;&]*\b(delete|purge)\b/, 'OpenStack 리소스 삭제'],
  [/\bceph\b[^|;&]*\b(osd\s+(out|down|purge|destroy|rm)|pool\s+(delete|rm))\b/, 'Ceph OSD·풀 제거'],
  [/\bpcs\b[^|;&]*\b(node\s+standby|cluster\s+stop|resource\s+(disable|delete))\b/, 'Pacemaker 노드·리소스 중지'],
  [/\b(truncate|shred)\b/, '파일 내용 지우기'],
  [/\biptables\s+(-F|--flush)\b/, '방화벽 규칙 비우기'],
  // DB 는 조회(SELECT·SHOW)만 걸지 않는다. OpenStack 정합성 점검 프리셋을 조회 전용으로 넣으면서(2026-11-06)
  // 사용자가 같은 꼴로 UPDATE·DELETE 를 프리셋에 추가해도 한 번은 묻게 했다. 'deleted' · 'updated_at' 컬럼은
  // 단어 경계와 뒤따르는 FROM·INTO 로 걸러진다(`DELETE FROM` 만, `deleted=0` 은 아님).
  [/\b(mysql|mariadb|psql)\b[^|]*\b(UPDATE\s+\S+\s+SET|DELETE\s+FROM|DROP\s+(TABLE|DATABASE|SCHEMA|INDEX)|TRUNCATE\s+TABLE|ALTER\s+TABLE|INSERT\s+INTO|REPLACE\s+INTO)\b/i, 'DB 값 변경·삭제'],
  // 권한 · 계정 변경도 한 번 묻는다(2026-11-07 사용자 결정) — 데이터는 그대로여도 서비스 계정 권한이 바뀌면 그 서비스가 DB 에 못 붙는다
  [/\b(mysql|mariadb|psql)\b[^|]*\b(GRANT\s|REVOKE\s|(CREATE|DROP|ALTER|RENAME)\s+USER\b|SET\s+PASSWORD\b|FLUSH\s+PRIVILEGES\b)/i, 'DB 권한 · 계정 변경'],
  // *-manage 중 DB 값을 바꾸는 것. 조회인 quota check · placement audit(--delete 없이) · heal_allocations --dry-run 은 걸지 않는다
  [/\bcinder-manage\b[^|;&]*\bquota\s+sync\b/, 'Cinder 쿼터 사용량 다시 쓰기'],
  [/\bnova-manage\b[^|;&]*\bplacement\s+audit\b[^|;&]*--delete\b/, 'Placement 할당 삭제'],
  [/\bnova-manage\b[^|;&]*\bplacement\s+heal_allocations\b(?![^|;&]*--dry-run)/, 'Placement 할당 다시 쓰기'],
  [/\b(nova|cinder|glance|masakari)-manage\b[^|;&]*\b(archive_deleted_rows|purge)\b/, '삭제 행 정리(DB 에서 지움)'],
]

/** 위험하면 그 이유(사람 말), 아니면 null */
export function dangerReason(command: string): string | null {
  const c = command.replace(/\s+/g, ' ')
  for (const [re, why] of RULES) if (re.test(c)) return why
  return null
}
