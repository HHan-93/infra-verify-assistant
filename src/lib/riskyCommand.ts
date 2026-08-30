/**
 * **여러 대에 한 번에 보내기 전에** 되묻어야 하는 명령인지.
 *
 * 다중 실행은 명령 하나를 선택한 노드 전부에 동시에 보낸다. 한 대에서 하면 실수로 끝나는 것이
 * 여기서는 클러스터 전체가 된다(`reboot` 을 컨트롤러 3대에 동시에 보내는 것 같은 일).
 * 설정파일 저장에는 이미 위험 경고가 있는데 정작 파급이 큰 이쪽에는 없었다.
 *
 * 판단은 **명령 문자열**로 한다(출력으로 하는 verdict.ts 의 위험 키워드와 다르다).
 * 넓게 잡지 않는다 — 매번 확인창이 뜨면 사람은 읽지 않고 누른다. 되돌리기 어렵거나
 * 서비스가 끊기는 것만 잡는다.
 */
export interface RiskyHit {
  /** 무엇이 걸렸는지 (확인창에 그대로 보여준다) */
  what: string
  /** 왜 위험한지 — 사람이 판단할 근거 */
  why: string
}

const RULES: { re: RegExp; what: string; why: string }[] = [
  { re: /\breboot\b|\bshutdown\b|\bhalt\b|\bpoweroff\b|\binit\s+[06]\b/i, what: '재기동/전원 종료', why: '대상 노드가 모두 동시에 내려갑니다' },
  { re: /\brm\s+(-[a-z]*[rf][a-z]*\s+)+/i, what: '재귀/강제 삭제 (rm -rf)', why: '되돌릴 수 없습니다' },
  { re: /\bmkfs(\.|\s)|\bdd\s+if=|\bfdisk\b|\bwipefs\b/i, what: '디스크 포맷/직접 쓰기', why: '데이터가 사라집니다' },
  { re: /systemctl\s+(stop|disable|mask|restart)\b/i, what: '서비스 중지/재시작', why: '그 서비스가 대상 노드에서 동시에 끊깁니다' },
  { re: /\b(kill|pkill|killall)\s+-9\b|\bkillall\b/i, what: '프로세스 강제 종료', why: '작업 중인 프로세스가 정리 없이 죽습니다' },
  { re: /\bpcs\s+(cluster\s+)?(stop|standby|destroy)\b|\bcrm\b.*\bstop\b/i, what: 'Pacemaker 클러스터 조작', why: 'HA 구성이 동시에 흔들립니다' },
  { re: /\bceph\b.*\b(osd\s+(down|out|stop)|mon\s+remove)\b/i, what: 'Ceph OSD/MON 조작', why: '데이터 복제 상태가 바뀝니다' },
  { re: /kubectl\s+(delete|drain|cordon)\b/i, what: 'kubectl delete/drain/cordon', why: '워크로드가 옮겨지거나 사라집니다' },
  { re: /\biptables\b|\bnmcli\b.*\b(down|delete)\b|\bifdown\b|ip\s+link\s+set\s+\S+\s+down/i, what: '네트워크 차단/인터페이스 down', why: 'SSH 접속 자체가 끊길 수 있습니다' },
  { re: />\s*\/etc\/|\btee\s+\/etc\/|\btruncate\b/i, what: '시스템 설정파일 덮어쓰기', why: '백업 없이 원본이 지워집니다' },
]

/** 걸린 규칙들. 비어 있으면 확인 없이 실행해도 되는 명령이다 */
export function riskyCommand(cmd: string): RiskyHit[] {
  const c = (cmd ?? '').trim()
  if (!c) return []
  const hits: RiskyHit[] = []
  for (const r of RULES) if (r.re.test(c)) hits.push({ what: r.what, why: r.why })
  return hits
}
