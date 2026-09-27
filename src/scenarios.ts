// 작업 시나리오(플레이북) — 순서가 있는 명령어 흐름.
// 명령어_편집.md 에서 자동 생성됨. <...> 플레이스홀더는 실행 대신 "입력".

import type { CommandCheck, CaptureRule, ExpectRule, OnFailureAction } from '../electron/shared-types'

export interface ScenarioStep {
  title: string
  command: string
  desc: string
  note?: string
  /** 파란 안내 박스 (공통 적용 범위, 참고 정보 등) */
  info?: string
  /** 빨간 경고 박스 (Enter 여러 번 필요 등, 다음 단계 실행 전 주의) */
  warn?: string
  /**
   * 실행한 뒤 **터미널에서 사람이 직접 입력**해야 끝나는 단계 (vi 편집기, 포트 점유 후 Ctrl+C,
   * 비밀번호 프롬프트 등). 목록의 버튼을 '실행·입력' 으로 표시한다.
   *
   * 예전에는 warn 이 있으면 입력이 필요하다고 **추측**했다. 그런데 warn 은 "데이터가 모두
   * 지워집니다" 같은 파괴적 동작 경고에도 쓰는 필드라, 입력을 전혀 받지 않는 단계에까지
   * '실행·입력' 이 붙었다. 받지도 않을 입력을 예고하는 것은 이 앱이 피해야 할 거짓 신호다.
   */
  needsInput?: boolean
  /**
   * **'전체 실행' 에서 돌리지 않는다.** 개별 '실행' 버튼으로는 그대로 돌아간다.
   *
   * 대화형이라서가 아니라, **사람이 조건을 보고 결정해야 하는 단계**라서 뺀다.
   * 지금 붙어 있는 곳은 두 종류다.
   *   · 검증 뒤 정리 — `rm -rf /var/lib/docker` 처럼 **이 시나리오가 만들지 않은 것까지**
   *     지운다. 스텝 설명 자체가 "다른 컨테이너가 돌고 있다면 실행하지 마세요" 라는
   *     조건을 달고 있는데, 러너는 그 조건을 판단할 수 없다. 조건을 못 보는 쪽이
   *     파괴적 명령을 자동으로 돌리면 안 된다(저장소 규칙: 파괴적 동작에는 대상 확인).
   *   · 내 PC 에서 하는 일 — `scp 원격:파일 ./` 처럼 **원격 셸에서 돌리면 뜻이 없는** 명령.
   *
   * needsInput 과는 다르다. 그쪽은 "돌리면 터미널에서 사람이 입력해야 끝난다" 는 사실이고,
   * 이쪽은 "돌릴지 말지를 사람이 정해야 한다" 는 판단이다. 둘을 한 이름으로 묶지 않는다.
   */
  manualOnly?: boolean
  /** 아코디언 코드 예시 (conf 파일 등 긴 입력 내용) */
  code?: string
  /** 실행 결과 자동 판정 기준 (선택) */
  check?: CommandCheck
  /**
   * 아래 4개는 검증 실행(러너) 전용 옵션 — CustomScenarioStep 과 같은 의미다.
   * 내장 시나리오는 대부분 쓰지 않지만, 사용자 정의 시나리오가 같은 타입으로 병합되므로 함께 둔다.
   */
  /**
   * 이 단계를 실행할 '역할' 이름 (실행 창에서 역할 → 세션 매핑).
   * 쉼표로 여러 역할을 적으면 그 역할들에 매핑된 세션 **전부**에서 실행된다.
   *   "서버"            → 서버 세션에서만
   *   "서버, 클라이언트"  → 양쪽 모두 (도구 설치처럼 둘 다 필요한 단계)
   */
  target?: string
  /** 출력에서 값을 뽑아 이후 단계의 <이름> 으로 전달 */
  capture?: CaptureRule[]
  /** 대화형 프롬프트 자동 응답 */
  expect?: ExpectRule[]
  /** 실패 시 동작 (기본 stop) */
  onFailure?: OnFailureAction
  /**
   * 위 대응 명령의 단계 설명 (선택). 명령을 최상위 구분자로 쪼갠 조각과 순서대로 짝지어
   * 화면에 보여준다. 없으면 명령 조각만 번호를 붙여 보여준다 — 셸 텍스트에서 의도를
   * 추측해 자동으로 만들지는 않는다(틀린 설명이 그럴듯하게 박히는 게 더 나쁘다).
   */
  onFailureDesc?: string[]
  /** onFailure==='run' 일 때 실행할 명령 */
  onFailureCommand?: string
  /** 이 단계가 만든 변경을 되돌리는 명령 (검증 후 '원복 실행'에서 역순 수행) */
  undo?: string
}

export interface Scenario {
  id: string
  solution: string
  title: string
  summary: string
  steps: ScenarioStep[]
  /**
   * 입력값을 '역할의 접속 주소'로 자동 채우는 규칙. 예: { "Target_IP": "서버" }
   * 역할별 대상에서 고른 세션의 주소가 그대로 들어간다(직접 입력하면 그쪽이 우선).
   */
  roleValues?: Record<string, string>
  /**
   * **진단형** — 정상/실패를 자동으로 가리지 않는 시나리오.
   *
   * '부팅 실패 진단' 처럼 *이미 무언가 잘못된 뒤에* 원인을 좁히는 시나리오는 통과 기준이
   * 없는 것이 맞다. `openstack server show` 의 출력에 무엇이 나와야 정상인지는 사람이 읽고
   * 판단할 일이지, 문구로 못 박을 수 있는 것이 아니다.
   *
   * 그런데 기준이 없으면 회차 판정이 늘 '판정 없음' 으로 남는다. 그것이 사실이긴 하지만,
   * **빠뜨린 것과 원래 그런 것이 화면에서 구분되지 않는다.** 그래서 시나리오 쪽에서 미리
   * 밝힌다 — 판정을 초록으로 바꾸지는 않는다(기준 없이 통과를 띄우지 않는다는 원칙 그대로).
   */
  diagnostic?: boolean
}

/**
 * apt 저장소가 막혔을 때의 표준 대응. **여러 시나리오가 같은 명령을 리터럴로 복붙**하고 있었다 —
 * 한 번 고치려면 그 전부를 고쳐야 했고, 설명을 붙이려면 또 전부에 붙여야 했다. 여기 한 곳에 둔다.
 */
/**
 * apt 를 **사람 없이** 돌리기 위한 앞머리.
 *
 * 러너는 영속 PTY 라, 원격이 무언가를 물으면 아무도 답하지 않은 채 제한 시간까지 멈춰 있다.
 * apt 가 그렇게 멈추는 길이 셋이다 —
 *   · needrestart   — "다시 시작할 서비스를 고르세요" 전체 화면 대화상자 (Ubuntu 22.04+)
 *   · 설정 파일 충돌 — `*** file (Y/I/N/O/D/Z) [default=N] ?`
 *   · dpkg 잠금      — unattended-upgrades 가 물고 있으면 "Waiting for cache lock" 을 끝없이 찍는다
 *
 * 앞의 둘은 **묻지 않게** 하고, 마지막은 기다리는 한도를 정해 **분명한 실패로 끝나게** 한다.
 * 끝없이 도는 것보다 2분 뒤 이유를 말하며 실패하는 편이 낫다 — 재시도는 러너가 한다.
 * (`sudo env` 를 쓰는 이유: `sudo VAR=v cmd` 는 sudo 설정에 따라 막히는 곳이 있다)
 */
const APT = 'sudo env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a apt-get -q -o DPkg::Lock::Timeout=120'

const APT_FIX =
  "getent hosts archive.ubuntu.com >/dev/null 2>&1 || sudo resolvectl dns \"$(ip route show default | awk '{print $5; exit}')\" 8.8.8.8 1.1.1.1 2>/dev/null; sudo add-apt-repository -y universe 2>/dev/null; sudo apt-get update -q"
/**
 * 위 명령의 단계 설명. splitShell 이 쪼갠 조각과 **순서대로 1:1** 로 짝지어 화면에 나란히 보여준다.
 * 조각을 늘리거나 순서를 바꾸면 이 목록도 같이 고쳐야 한다.
 */
const APT_FIX_DESC = [
  'DNS 확인 — archive.ubuntu.com 이름 조회가 되는지 본다',
  'DNS 임시 변경 — 조회가 실패했으면 현재 인터페이스에 8.8.8.8 · 1.1.1.1 을 붙인다',
  'universe 저장소 추가',
  '패키지 목록 갱신 후 재시도',
]
export const SCENARIOS: Scenario[] = [

  // ───────────────────────── OpenStack ─────────────────────────

  {
    "id": "scn-config-drive",
    "solution": "OpenStack",
    "title": "[컴퓨트] 인스턴스 설정 드라이브 확인",
    "summary": "설정 드라이브(Config Drive) 옵션으로 생성된 인스턴스에서 메타데이터·네트워크·사용자 스크립트를 직접 조회합니다.",
    "steps": [
      {
        "title": "인스턴스 생성 (설정 드라이브 활성화)",
        "command": "",
        "desc": "LNB 영역에서 컴퓨트 > 인스턴스로 이동해 인스턴스를 생성합니다. 생성 옵션에서 '설정 드라이브(Config Drive)' 체크박스를 반드시 선택하세요.",
        "note": "설정 드라이브는 인스턴스 생성 시점에만 활성화할 수 있습니다. 기존 인스턴스에 소급 적용은 불가합니다."
      },
      {
        "title": "인스턴스 터미널 접속",
        "command": "",
        "desc": "생성된 인스턴스에 SSH 또는 대시보드 콘솔로 접속합니다."
      },
      {
        "title": "설정 드라이브 장치 확인",
        "check": {"passContains":["config-2"]},
        "command": "lsblk -f",
        "desc": "LABEL 컬럼에 config-2 가 표시된 장치를 확인합니다. 보통 sr0(CD-ROM 형태)로 연결됩니다.",
        "note": "config-2 라벨이 보이지 않으면 인스턴스 생성 시 설정 드라이브 옵션이 활성화되지 않은 것입니다."
      },
      {
        "title": "마운트 포인트 생성",
        "command": "sudo mkdir -p /mnt/config",
        "check": { "requireExitZero": true },
        "undo": "sudo rmdir /mnt/config",
        "desc": "설정 드라이브를 연결할 디렉토리를 생성합니다."
      },
      {
        "title": "마운트 포인트 생성 확인",
        "command": "ls -ld /mnt/config",
        "check": { "passContains": ["/mnt/config"], "requireExitZero": true },
        "desc": "디렉토리가 실제로 만들어졌는지 확인합니다. 마운트 전이라 비어 있는 것이 정상입니다."
      },
      {
        "title": "설정 드라이브 마운트",
        "command": "DEV=$(lsblk -o NAME,LABEL -nr | awk '$2==\"config-2\"{print \"/dev/\"$1; exit}'); echo \"장치: ${DEV:-못 찾음}\"; if [ -n \"$DEV\" ]; then sudo mount \"$DEV\" /mnt/config && echo '마운트되었습니다'; else echo '주의 — config-2 라벨을 가진 장치를 찾지 못했습니다'; fi",
        "check": { "passContains": ["마운트되었습니다"], "failContains": ["주의 —", "wrong fs type"] },
        "undo": "sudo umount /mnt/config",
        "desc": "config-2 라벨이 붙은 장치를 찾아 /mnt/config 에 마운트합니다. 장치명을 자동으로 찾으므로 sr0 가 아니어도 됩니다.",
        "info": "설정 드라이브의 장치 이름은 환경마다 다릅니다 (/dev/sr0 · /dev/sr1 …).\n그래서 이름을 박아 두지 않고 config-2 라벨로 찾습니다 — 손으로 고쳐 넣을 것이 없습니다."
      },
      {
        "title": "마운트 상태 확인",
        "command": "findmnt /mnt/config; df -h /mnt/config",
        "check": { "passContains": ["/mnt/config"], "requireExitZero": true },
        "desc": "실제로 마운트됐는지 확인합니다. findmnt 에 /dev/sr0 → /mnt/config 항목이 보이고, df -h 에 iso9660 용량이 잡혀야 정상입니다.",
        "note": "findmnt 결과가 비어 있으면 mount 명령이 조용히 실패한 것입니다. dmesg | tail 로 원인을 확인하세요."
      },
      {
        "title": "파일 구조 확인",
        "check": {"passContains":["openstack"],"requireExitZero":true},
        "command": "ls -R /mnt/config",
        "desc": "설정 드라이브 안의 파일·디렉토리 목록을 봅니다.\nopenstack/latest/ 아래에 meta_data.json · network_data.json · user_data 가 있어야 합니다."
      },
      {
        "title": "메타데이터 조회",
        "check": {"passContains":["uuid"],"requireExitZero":true},
        "command": "cat /mnt/config/openstack/latest/meta_data.json | python3 -m json.tool",
        "desc": "인스턴스 ID(uuid), 호스트 네임, 키 페어 이름 등 인스턴스 기본 정보를 확인합니다. python3 -m json.tool 로 들여쓰기 정렬해 출력합니다.",
        "note": "jq 가 설치된 경우: jq . /mnt/config/openstack/latest/meta_data.json"
      },
      {
        "title": "네트워크 데이터 조회",
        "check": {"passRegex":"\"(links|networks)\"","requireExitZero":true},
        "command": "cat /mnt/config/openstack/latest/network_data.json | python3 -m json.tool",
        "desc": "인터페이스별 IP 주소, 서브넷 마스크, 게이트웨이, DNS 등 네트워크 구성 정보를 확인합니다. python3 -m json.tool 로 정렬해 출력합니다.",
        "note": "jq 가 설치된 경우: jq . /mnt/config/openstack/latest/network_data.json"
      },
      {
        "title": "사용자 스크립트 조회",
        "command": "cat /mnt/config/openstack/latest/user_data && echo",
        "desc": "인스턴스 생성 시 입력한 cloud-init 사용자 스크립트 내용을 확인합니다. 비어 있으면 입력하지 않은 것입니다.",
        "info": "마지막 줄에 개행이 없는 파일을 cat 하면 프롬프트가 같은 줄에 붙어 보일 수 있습니다. && echo 를 붙이면 항상 줄바꿈 후 프롬프트가 표시됩니다."
      }
    ]
  },

  {
    "id": "scn-flavor-disk-qos",
    "solution": "OpenStack",
    "title": "[컴퓨트] 인스턴스 유형 디스크 QoS 적용 확인",
    "summary": "인스턴스 유형(Flavor)에 디스크 QoS를 설정하고, fio로 IOPS·대역폭 제한이 실제 적용되는지 확인합니다. 볼륨 기반이 아닌 루트 디스크(Ephemeral) 기준입니다.",
    "steps": [
      {
        "title": "인스턴스 유형 생성",
        "command": "",
        "desc": "LNB > 기본 설정 > 인스턴스 유형으로 이동해 인스턴스 유형을 생성합니다. 루트 디스크 용량(볼륨 기반이 아닌 Ephemeral)을 설정하세요.",
        "note": "볼륨 기반 인스턴스는 루트 디스크 QoS가 볼륨 타입 QoS 정책을 따릅니다. 인스턴스 유형 QoS는 Ephemeral 디스크에 적용됩니다."
      },
      {
        "title": "디스크 QoS 설정",
        "command": "",
        "desc": "인스턴스 유형 편집 > QoS 관리 > 디스크 그룹에서 제한할 항목의 키와 값을 입력합니다.",
        "note": "포털 항목명 → 실제 메타데이터 키\n디스크 Read IOPS   → quota:disk_read_iops_sec\n디스크 Write IOPS  → quota:disk_write_iops_sec\n디스크 Read BYTES  → quota:disk_read_bytes_sec\n디스크 Write BYTES → quota:disk_write_bytes_sec\n\n예시: Read IOPS = 50, Write IOPS = 50, Read BYTES = 10485760(10MB/s), Write BYTES = 10485760(10MB/s)\n\n⚠ TOTAL IOPS / TOTAL BYTES 는 개별 Read·Write 키와 함께 설정하면 인스턴스 생성 오류가 납니다.\n   TOTAL 항목은 Read·Write 키 없이 따로 설정하세요.\n디스크 TOTAL IOPS  → quota:disk_total_iops_sec\n디스크 TOTAL BYTES → quota:disk_total_bytes_sec"
      },
      {
        "title": "인스턴스 생성",
        "command": "",
        "desc": "LNB > 컴퓨트 > 인스턴스 생성 시 위에서 만든 QoS 적용 인스턴스 유형을 선택하여 생성합니다.",
        "note": "인스턴스 유형 QoS는 인스턴스 생성 시점에 적용됩니다. 이후 인스턴스 유형을 변경해도 기존 인스턴스에는 반영되지 않습니다."
      },
      {
        "title": "인스턴스 별칭 확인",
        "target": "하이퍼바이저",
        "command": "echo '별칭  |  인스턴스 이름  |  상태'; sudo virsh list --all | tail -n +3 | while read -r id d state rest; do [ -n \"$d\" ] || continue; n=$(sudo virsh dumpxml \"$d\" 2>/dev/null | grep -o 'nova:name>[^<]*' | head -1 | cut -c11-); echo \"$d  |  ${n:-(이름 없음)}  |  $state $rest\"; done | tee /tmp/qterm-doms.txt; [ -s /tmp/qterm-doms.txt ] || echo '주의 — 이 호스트에 libvirt 도메인이 없습니다 (컴퓨트 노드가 맞는지 확인하세요)'; rm -f /tmp/qterm-doms.txt",
        "check": { "failContains": ["주의 —"] },
        "desc": "하이퍼바이저 호스트에서 실행합니다. 별칭(instance-xxxx) 옆에 포털의 인스턴스 이름을 함께 보여주므로, 어느 것이 내 인스턴스인지 바로 가릅니다.",
        "info": "virsh 는 OpenStack UUID 가 아니라 libvirt 도메인 별칭으로 조회합니다.\n별칭만 늘어놓으면 어느 것이 내 것인지 알 수 없어서, nova 가 도메인 XML 에 심어 둔 이름을 함께 읽어 붙였습니다.\n\n찾는 이름이 안 보이면 그 인스턴스는 다른 컴퓨트 노드에 있습니다 — 위 역할별 대상에서 그 노드를 고르세요."
      },
      {
        "title": "하이퍼바이저 호스트에서 적용 확인",
        "target": "하이퍼바이저",
        "command": "A='<instance_alias>'; X=/tmp/qterm-dom.xml; D=/tmp/qterm-disk.txt; if ! command -v virsh > /dev/null; then echo '주의 — 이 서버에 virsh 가 없습니다 (컴퓨트 노드가 아닙니다)'; elif sudo virsh dumpxml \"$A\" > $X 2>/dev/null; then echo \"[대상] $A  —  $(grep -o 'nova:name>[^<]*' $X | head -1 | cut -c11-)\"; echo '[루트 디스크]'; awk 'index($0,\"<disk \")>0{b=1} b{print} index($0,\"</disk>\")>0{b=0}' $X > $D; grep -E '<disk |<source |<target dev' $D | head -14; R=$(grep \"device='disk'\" $D | head -1); case \"$R\" in *\"type='file'\"*) echo '  -> 루트가 Ephemeral(로컬 파일)입니다 — 인스턴스 유형 디스크 QoS 대상이 맞습니다';; *) echo '  -> 루트가 볼륨입니다 — 인스턴스 유형의 디스크 QoS 는 여기에 걸리지 않습니다. [스토리지] 볼륨 타입 디스크 QoS 시나리오로 확인하세요';; esac; echo '[iotune]'; if grep -q iotune $X; then grep -A 8 iotune $X | grep -E 'iotune|_sec'; else echo '주의 — iotune 블록이 없습니다 (QoS 가 이 인스턴스에 걸려 있지 않습니다)'; echo '  · 인스턴스 유형에 QoS 를 나중에 넣었다면 — 설정은 인스턴스를 만들 때 박힙니다. 이미 떠 있는 것에는 적용되지 않으니 다시 만드세요'; fi; else echo \"주의 — 이 호스트에 $A 도메인이 없습니다 (인스턴스가 다른 컴퓨트 노드에 있을 수 있습니다)\"; fi; rm -f $X $D",
        "check": { "passContains": ["iotune"], "passRegex": "(read|write)_(iops|bytes)_sec", "failContains": ["주의 —"] },
        "onFailure": "continue",
        "desc": "앞 단계에서 확인한 별칭으로 실행합니다. <iotune> 블록에 read_iops_sec · write_iops_sec 등이 설정값대로 나와야 합니다.\n루트 디스크가 Ephemeral 인지 볼륨인지 먼저 단정해 주고, iotune 이 없으면 왜 없는지도 짚어 줍니다.",
        "info": "이 명령은 인스턴스 안이 아니라 그 인스턴스가 떠 있는 컴퓨트 노드에서 돌려야 합니다.\n\n여기서 실패해도 검증은 멈추지 않습니다.\n제한이 안 걸린 fio 숫자도 증거라서, 뒤 단계까지 재 보고 나서 판단하는 편이 낫습니다."
      },
      {
        "title": "인스턴스 터미널 접속",
        "command": "",
        "desc": "QoS가 적용된 인스턴스에 SSH 또는 대시보드 콘솔로 접속합니다."
      },
      {
        "title": "디스크 장치 확인",
        "command": "lsblk",
        "desc": "루트 디스크 장치를 확인합니다. Ephemeral 디스크는 보통 /dev/vda로 마운트됩니다."
      },
      {
        "title": "패키지 저장소 업데이트",
        "command": `${APT} update`,
        "check": { "failContains": ["Err:", "Failed to fetch", "Could not resolve", "Temporary failure resolving"], "passContains": ["Reading package lists"] },
        "desc": "fio 패키지 설치 전 저장소를 업데이트합니다.",
        "note": "업데이트가 실패하면 DNS 설정을 확인하세요. nameserver가 없으면 외부 패키지 서버에 접근할 수 없습니다.\n확인: cat /etc/resolv.conf\n미설정 시: netplan 또는 /etc/resolv.conf에 nameserver를 추가 후 적용하세요."
      },
      {
        "title": "fio 및 libaio 설치",
        "command": `${APT} install -y fio libaio1t64 || ${APT} install -y fio libaio1`,
        "onFailure": "retry",
        "onFailureCommand": APT_FIX,
        "onFailureDesc": APT_FIX_DESC,
        "check": { "requireExitZero": true, "failContains": ["Unable to locate package", "has no installation candidate"] },
        "desc": "디스크 성능 테스트 도구 fio와 비동기 I/O 라이브러리 libaio를 설치합니다. Ubuntu 24.04+는 libaio1t64, 이전 버전은 libaio1을 사용합니다."
      },
      {
        "title": "IOPS 쓰기 테스트",
        "command": "sudo fio --name=qos-randwrite --rw=randwrite --bs=4k --direct=1 --ioengine=libaio --iodepth=32 --size=100M --runtime=30 --filename=/tmp/fio-test --group_reporting",
        "check": { "passContains": ["Run status group"] },
        "desc": "무작위 4K 쓰기로 IOPS 를 측정합니다. write_iops_sec 제한값 부근에서 수렴하면 정상입니다.\n결과에서 볼 것 — write: 줄의 IOPS=(초당 처리 횟수)와 BW=(대역폭). 아래 lat 은 지연 시간이라 작을수록 좋습니다.",
        "info": "--direct=1: 페이지 캐시를 우회하여 디스크 QoS가 직접 측정됩니다.\n--ioengine=libaio: 비동기 I/O 엔진으로 iodepth=32가 실제로 동작합니다."
      },
      {
        "title": "IOPS 읽기 테스트",
        "command": "sudo fio --name=qos-randread --rw=randread --bs=4k --direct=1 --ioengine=libaio --iodepth=32 --size=100M --runtime=30 --filename=/tmp/fio-test --group_reporting",
        "check": { "passContains": ["Run status group"] },
        "desc": "무작위 4K 읽기로 IOPS 를 측정합니다. read_iops_sec 제한값 부근에서 수렴하면 정상입니다.\n결과에서 볼 것 — read: 줄의 IOPS= 와 BW=. QoS 를 걸었다면 설정한 상한 근처에서 멈춰야 합니다."
      },
      {
        "title": "대역폭 쓰기 테스트",
        "command": "sudo fio --name=qos-write-bw --rw=write --bs=1m --direct=1 --ioengine=libaio --iodepth=32 --size=500M --runtime=30 --filename=/tmp/fio-test --group_reporting",
        "check": { "passContains": ["Run status group"] },
        "desc": "순차 1MB 쓰기로 대역폭을 측정합니다. write_bytes_sec 제한값(예: 10MB/s) 부근에서 수렴하면 정상입니다.\n결과에서 볼 것 — write: 줄의 BW= 값. 큰 블록이라 IOPS 보다 BW 가 핵심입니다."
      },
      {
        "title": "대역폭 읽기 테스트",
        "command": "sudo fio --name=qos-read-bw --rw=read --bs=1m --direct=1 --ioengine=libaio --iodepth=32 --size=500M --runtime=30 --filename=/tmp/fio-test --group_reporting",
        "check": { "passContains": ["Run status group"] },
        "desc": "순차 1MB 읽기로 대역폭을 측정합니다. read_bytes_sec 제한값 부근에서 수렴하면 정상입니다.\n결과에서 볼 것 — read: 줄의 BW= 값. 큰 블록이라 IOPS 보다 BW 가 핵심입니다."
      },
      {
        "title": "테스트 파일 정리",
        "command": "sudo rm -f /tmp/fio-test",
        "desc": "fio가 생성한 테스트 파일을 삭제합니다."
      }
    ]
  },

  {
    "id": "scn-flavor-network-qos",
    "solution": "OpenStack",
    "title": "[컴퓨트] 인스턴스 유형 네트워크 QoS 적용 확인",
    "summary": "인스턴스 유형(Flavor)에 네트워크 QoS를 설정하고, iperf3로 인바운드·아웃바운드 대역폭 제한이 실제 적용되는지 확인합니다.",
    "steps": [
      {
        "title": "인스턴스 유형 생성",
        "command": "",
        "desc": "LNB > 기본 설정 > 인스턴스 유형으로 이동해 인스턴스 유형을 생성합니다.",
        "info": "네트워크 QoS는 VIF(가상 네트워크 인터페이스)에 적용되므로 루트 디스크 타입(Ephemeral/볼륨)에 관계없이 동작합니다."
      },
      {
        "title": "네트워크 QoS 설정",
        "command": "",
        "desc": "인스턴스 유형 편집 > QoS 관리 > 네트워크 그룹에서 제한할 항목의 키와 값을 입력합니다.",
        "note": "포털 항목명 → 실제 메타데이터 키\nInbound 평균 대역폭   → quota:vif_inbound_average  (단위: KBps)\nInbound 피크 대역폭   → quota:vif_inbound_peak     (단위: KBps)\nInbound 최대 허용량   → quota:vif_inbound_burst    (단위: KB)\nOutbound 평균 대역폭  → quota:vif_outbound_average (단위: KBps)\nOutbound 피크 대역폭  → quota:vif_outbound_peak    (단위: KBps)\nOutbound 최대 허용량  → quota:vif_outbound_burst   (단위: KB)\n\n예시: Inbound 평균=1024, 피크=2048, 최대허용량=512 / Outbound 동일"
      },
      {
        "title": "인스턴스 생성",
        "command": "",
        "desc": "LNB > 컴퓨트 > 인스턴스 생성 시 위에서 만든 QoS 적용 인스턴스 유형을 선택하여 생성합니다.",
        "note": "인스턴스 유형 QoS는 인스턴스 생성 시점에 적용됩니다. 이후 인스턴스 유형을 변경해도 기존 인스턴스에는 반영되지 않습니다."
      },
      {
        "title": "인스턴스 별칭 확인",
        "target": "하이퍼바이저",
        "command": "echo '별칭  |  인스턴스 이름  |  상태'; sudo virsh list --all | tail -n +3 | while read -r id d state rest; do [ -n \"$d\" ] || continue; n=$(sudo virsh dumpxml \"$d\" 2>/dev/null | grep -o 'nova:name>[^<]*' | head -1 | cut -c11-); echo \"$d  |  ${n:-(이름 없음)}  |  $state $rest\"; done | tee /tmp/qterm-doms.txt; [ -s /tmp/qterm-doms.txt ] || echo '주의 — 이 호스트에 libvirt 도메인이 없습니다 (컴퓨트 노드가 맞는지 확인하세요)'; rm -f /tmp/qterm-doms.txt",
        "check": { "failContains": ["주의 —"] },
        "desc": "하이퍼바이저 호스트에서 실행합니다. 별칭(instance-xxxx) 옆에 포털의 인스턴스 이름을 함께 보여주므로, 어느 것이 내 인스턴스인지 바로 가릅니다.",
        "info": "virsh 는 OpenStack UUID 가 아니라 libvirt 도메인 별칭으로 조회합니다.\n별칭만 늘어놓으면 어느 것이 내 것인지 알 수 없어서, nova 가 도메인 XML 에 심어 둔 이름을 함께 읽어 붙였습니다.\n\n찾는 이름이 안 보이면 그 인스턴스는 다른 컴퓨트 노드에 있습니다 — 위 역할별 대상에서 그 노드를 고르세요."
      },
      {
        "title": "하이퍼바이저 호스트에서 적용 확인",
        "target": "하이퍼바이저",
        "command": "A='<instance_alias>'; X=/tmp/qterm-dom.xml; D=/tmp/qterm-disk.txt; if ! command -v virsh > /dev/null; then echo '주의 — 이 서버에 virsh 가 없습니다 (컴퓨트 노드가 아닙니다)'; elif sudo virsh dumpxml \"$A\" > $X 2>/dev/null; then echo \"[대상] $A  —  $(grep -o 'nova:name>[^<]*' $X | head -1 | cut -c11-)\"; echo '[인터페이스]'; awk 'index($0,\"<interface \")>0{b=1} b{print} index($0,\"</interface>\")>0{b=0}' $X | grep -E '<interface |<mac |<target dev' | head -14; echo '[bandwidth]'; if grep -q bandwidth $X; then grep -A 8 bandwidth $X | grep -E 'bandwidth|inbound|outbound'; else echo '주의 — bandwidth 블록이 없습니다 (QoS 가 이 인스턴스에 걸려 있지 않습니다)'; echo '  · 인스턴스 유형에 QoS 를 나중에 넣었다면 — 설정은 인스턴스를 만들 때 박힙니다. 이미 떠 있는 것에는 적용되지 않으니 다시 만드세요'; echo '  · 포트나 네트워크 쪽 QoS 정책으로 걸었다면 여기가 아니라 neutron QoS 정책에서 확인하세요'; fi; else echo \"주의 — 이 호스트에 $A 도메인이 없습니다 (인스턴스가 다른 컴퓨트 노드에 있을 수 있습니다)\"; fi; rm -f $X $D",
        "check": { "passContains": ["bandwidth"], "passRegex": "inbound|outbound", "failContains": ["주의 —"] },
        "onFailure": "continue",
        "desc": "앞 단계에서 확인한 별칭으로 실행합니다. <interface> 안의 <bandwidth> 블록에 inbound/outbound 의 average · peak · burst 값이 나와야 합니다.\n못 찾으면 왜 못 찾았는지(도메인 없음 · QoS 미적용 · neutron 쪽 정책)를 함께 알려 줍니다.",
        "info": "이 명령은 인스턴스 안이 아니라 그 인스턴스가 떠 있는 컴퓨트 노드에서 돌려야 합니다.\n\n여기서 실패해도 검증은 멈추지 않습니다.\n제한이 안 걸린 iperf3 숫자도 증거라서, 뒤 단계까지 재 보고 나서 판단하는 편이 낫습니다."
      },
      {
        "title": "iperf3 서버 구성 (별도 인스턴스)",
        "target": "iperf3 서버",
        "command": `${APT} update && ${APT} install -y iperf3 && iperf3 -s -D`,
        "undo": "pkill -f 'iperf3 -s' || echo 'iperf3 서버가 떠 있지 않습니다 (이미 정리됨)'",
        "onFailure": "retry",
        "onFailureCommand": APT_FIX,
        "onFailureDesc": APT_FIX_DESC,
        "check": { "requireExitZero": true, "failContains": ["Unable to locate package", "has no installation candidate"] },
        "desc": "QoS가 적용되지 않은 별도 인스턴스(또는 외부 서버)에서 실행합니다. iperf3 서버가 준비되어야 테스트 대상 인스턴스에서 연결할 수 있습니다.",
        "info": "서버 역할 인스턴스는 네트워크 QoS가 없어야 정확한 측정이 가능합니다.\niperf3 서버 기본 포트는 5201입니다. 보안 그룹에서 해당 포트가 허용되어야 합니다."
      },
      {
        "title": "테스트 인스턴스 터미널 접속",
        "command": "",
        "desc": "QoS가 적용된 인스턴스에 SSH 또는 대시보드 콘솔로 접속합니다."
      },
      {
        "title": "패키지 저장소 업데이트",
        "command": `${APT} update`,
        "check": { "failContains": ["Err:", "Failed to fetch", "Could not resolve", "Temporary failure resolving"], "passContains": ["Reading package lists"] },
        "desc": "iperf3 패키지 설치 전 저장소를 업데이트합니다.",
        "note": "업데이트가 실패하면 DNS 설정을 확인하세요. nameserver가 없으면 외부 패키지 서버에 접근할 수 없습니다.\n확인: cat /etc/resolv.conf\n미설정 시: netplan 또는 /etc/resolv.conf에 nameserver를 추가 후 적용하세요."
      },
      {
        "title": "iperf3 설치",
        "command": `${APT} install -y iperf3`,
        "onFailure": "retry",
        "onFailureCommand": APT_FIX,
        "onFailureDesc": APT_FIX_DESC,
        "check": { "requireExitZero": true, "failContains": ["Unable to locate package", "has no installation candidate"] },
        "desc": "네트워크 대역폭 측정 도구 iperf3를 설치합니다."
      },
      {
        "title": "아웃바운드(업로드) 대역폭 테스트",
        "command": "iperf3 -c <iperf3-server-ip> -t 30 -i 5",
        "check": { "failContains": ["unable to connect", "Connection refused", "No route to host"], "passContains": ["iperf Done"] },
        "desc": "인스턴스에서 서버 방향(아웃바운드)으로 30초간 대역폭을 측정합니다. 결과에서 볼 것 — 맨 아래 receiver 줄의 Bitrate. QoS 를 걸었다면 설정한 상한 근처에서 멈춰야 정상입니다.",
        "info": "【결과 확인】\n출력 아래 '- - -' 선 밑에 sender 와 receiver 두 줄이 나옵니다.\n실제로 전달된 속도는 receiver 줄입니다 (sender 는 보낸 쪽이 버퍼에 넣은 양이라 조금 크게 나옵니다).\n  [5] 0.00-30.01 sec  30.5 MBytes  8.53 Mbits/sec  receiver  ← 이 값\n\nvif_outbound_average(KBps) × 8 = 제한 Mbps 와 근접하면 정상입니다.\n예: outbound_average=1024 KBps → 약 8 Mbps\n※ QoS 는 KBps, iperf3 는 Mbps 라 × 8 로 환산합니다 (1 Byte = 8 bit).\n\n구간별 Bitrate 가 초반에 높다가 수렴하는 것은 burst 를 다 쓴 뒤 average 제한이 걸린 정상 동작입니다."
      },
      {
        "title": "인바운드(다운로드) 대역폭 테스트",
        "command": "iperf3 -c <iperf3-server-ip> -t 30 -i 5 -R",
        "check": { "failContains": ["unable to connect", "Connection refused", "No route to host"], "passContains": ["iperf Done"] },
        "desc": "-R 로 방향을 뒤집어(서버 → 이 인스턴스) 인바운드 대역폭을 측정합니다.\n결과에서 볼 것 — 맨 아래 receiver 줄의 Bitrate. QoS 를 걸었다면 상한 근처에서 멈춰야 정상입니다.",
        "info": "【결과 확인】\n출력 아래 '- - -' 선 밑에 sender 와 receiver 두 줄이 나옵니다.\n-R 이라 보내는 쪽이 서버, 받는 쪽이 이 인스턴스입니다 — 인바운드 제한이 걸리는 것은 receiver 줄입니다.\n  [5] 0.00-30.01 sec  30.5 MBytes  8.53 Mbits/sec  receiver  ← 이 값\n\nvif_inbound_average(KBps) × 8 = 제한 Mbps 와 근접하면 정상입니다.\n예: inbound_average=1024 KBps → 약 8 Mbps\n※ QoS 는 KBps, iperf3 는 Mbps 라 × 8 로 환산합니다 (1 Byte = 8 bit)."
      }
    ]
  },

  {
    "id": "scn-lb-roundrobin",
    "solution": "OpenStack",
    "title": "[네트워크] 로드밸런서 알고리즘(ROUND ROBIN) 동작 확인",
    "summary": "인스턴스 2대에 nginx를 설치하고 로드밸런서(ROUND_ROBIN)를 생성해 VIP로 순차 통신이 이루어지는지 검증합니다.",
    "steps": [
      {
        "title": "인스턴스 2대 생성",
        "command": "",
        "desc": "LNB 영역에서 컴퓨트 > 인스턴스로 이동해 인스턴스 2대를 생성하세요. 각 인스턴스에 동일한 세그먼트의 인터페이스를 할당하세요."
      },
      {
        "title": "인스턴스 터미널 접속",
        "command": "",
        "desc": "생성된 인스턴스 2대 각각의 터미널에 접속하세요. SSH 또는 대시보드 콘솔을 이용하세요."
      },
      {
        "title": "패키지 업데이트",
        "command": `${APT} update`,
        "check": { "requireExitZero": true },
        "desc": "nginx 설치 전 패키지 목록을 최신화합니다. 인스턴스 2대 모두 수행하세요.",
        "note": "업데이트가 실패하면 DNS 설정을 확인하세요. nameserver가 없으면 외부 패키지 서버에 접근할 수 없습니다.\n확인: cat /etc/resolv.conf\n미설정 시: netplan 또는 /etc/resolv.conf에 nameserver를 추가 후 적용하세요."
      },
      {
        "title": "nginx 설치",
        "command": `${APT} install -y nginx`,
        "onFailure": "retry",
        "onFailureCommand": APT_FIX,
        "onFailureDesc": APT_FIX_DESC,
        "check": { "requireExitZero": true, "failContains": ["Unable to locate package", "has no installation candidate"] },
        "desc": "웹서버(nginx)를 설치합니다. 인스턴스 2대 모두 수행하세요."
      },
      {
        "title": "서버별 응답 내용 구분",
        "command": "hostname | sudo tee /var/www/html/index.html && curl -s --max-time 3 http://127.0.0.1/",
        "check": { "requireExitZero": true },
        "desc": "각 인스턴스가 자기 호스트명을 응답하도록 index.html 을 만듭니다. 인스턴스 2대 모두 수행하세요.",
        "info": "이 단계가 없으면 두 대가 똑같은 nginx 기본 페이지를 돌려줍니다.\nVIP 로 요청했을 때 어느 쪽이 응답했는지 구분할 수 없어, ROUND ROBIN 이 도는지 확인할 방법이 없습니다.",
        "undo": "sudo rm -f /var/www/html/index.html"
      },
      {
        "title": "로드밸런서 생성",
        "command": "",
        "desc": "LNB 영역에서 VPC > 로드밸런서로 이동해 로드밸런서를 생성합니다.",
        "note": "Step1 기본 정보: 인스턴스에 할당한 인터페이스의 세그먼트를 선택하세요.\nStep2 리스너: 프로토콜 HTTP를 선택하세요.\nStep3 풀: 알고리즘 ROUND_ROBIN, 프로토콜 HTTP를 선택하세요.\nStep4 풀 멤버: 인스턴스 2대를 등록하고 포트를 80으로 설정하세요. (임계치 사용 여부: 미사용)\nStep5 헬스 체크: 타입 HTTP를 선택하세요."
      },
      {
        "title": "ROUND ROBIN 통신 확인",
        "command": "for i in $(seq 1 10); do curl -s --max-time 3 http://<VIP>/; done | sort | uniq -c > /tmp/qterm-lb.txt; cat /tmp/qterm-lb.txt; N=$(wc -l < /tmp/qterm-lb.txt); rm -f /tmp/qterm-lb.txt; if [ \"$N\" -ge 2 ]; then echo \"서로 다른 응답 $N 종 — 분산되고 있습니다\"; else echo '주의 — 응답이 한 종류뿐입니다 (분산되지 않음)'; fi",
        "check": { "passContains": ["분산되고 있습니다"], "failContains": ["주의 —"] },
        "desc": "VIP 로 10번 요청해 어느 서버가 몇 번 응답했는지 셉니다. 앞 단계에서 호스트명을 넣어 두었으므로 응답 종류가 2가지로 갈리면 ROUND ROBIN 이 도는 것입니다.",
        "info": "출력의 맨 앞 숫자가 그 응답을 받은 횟수입니다. ROUND ROBIN 이면 10번 중 5:5 에 가깝게 나뉩니다. 한쪽으로 크게 치우치면 풀 멤버 하나가 헬스 체크에서 빠졌는지 확인하세요.",
        "note": "로드밸런서와 통신이 되는 대역의 인스턴스 또는 풀 멤버 인스턴스에서 실행하세요."
      }
    ]
  },
  {
    "id": "scn-lb-ssl",
    "solution": "OpenStack",
    "title": "[네트워크] 로드밸런서 SSL 통신 확인 (VM 간 통신)",
    "summary": "Root CA 인증서를 직접 생성하고 서비스 인증서에 서명한 뒤, OpenStack LB에 SSL을 적용해 HTTPS 종단 간 통신을 검증합니다.",
    "steps": [
      {
        "title": "로드밸런서 생성",
        "command": "",
        "desc": "LNB 영역에서 네트워크 > 로드밸런서로 이동 후 로드밸런서를 생성합니다. 리스너·풀·풀 멤버·헬스 체크는 이 단계에서 생성하지 않아도 됩니다.",
        "note": "VIP 주소는 이후 서비스 인증서 SAN(Subject Alternative Name) 및 curl 테스트에 사용되므로 반드시 메모해 두세요."
      },
      {
        "title": "인스턴스 2대 생성",
        "command": "",
        "desc": "1대는 풀 멤버용 웹서버(HTTP 응답), 1대는 클라이언트용으로 생성합니다. 두 인스턴스 모두 로드밸런서와 동일 네트워크에 배치합니다."
      },
      {
        "title": "[클라이언트 인스턴스] 작업 디렉토리 생성",
        "check": {"requireExitZero":true},
        "command": "mkdir -p ssl-certs && cd ssl-certs",
        "undo": "cd ~ && rm -rf ~/ssl-certs",
        "desc": "인증서 파일을 한곳에 모아 관리하기 위해 작업 디렉토리를 생성하고 이동합니다. (-p 로 이미 존재해도 오류 없이 이동)",
        "note": "원복하면 ~/ssl-certs 를 통째로 지웁니다 (CA 개인키 · 서비스 키 · p12 포함).\n이름이 고정이라, 검증 전부터 같은 이름의 디렉토리를 쓰고 있었다면 그것도 함께 사라집니다.\n남겨야 할 것이 있으면 원복 창에서 이 항목의 체크를 해제하세요."
      },
      {
        "title": "작업 디렉토리 확인",
        "command": "pwd; ls -la",
        "check": { "passContains": ["ssl-certs"], "requireExitZero": true },
        "desc": "현재 위치가 ssl-certs 인지 확인합니다. 이후 인증서 파일들이 모두 이 디렉토리에 생성됩니다.",
        "note": "검증 실행 창에서는 각 스텝이 같은 셸에서 이어져 실행되므로 cd 가 유지됩니다."
      },
      {
        "title": "Root CA 키 생성",
        "check": {"requireExitZero":true},
        "command": "openssl genrsa -out ca.key 2048",
        "desc": "Root CA 서명에 사용할 RSA 2048비트 개인 키를 생성합니다."
      },
      {
        "title": "CA 키 권한 제한",
        "check": {"requireExitZero":true},
        "command": "chmod 600 ca.key",
        "desc": "CA 개인 키를 소유자만 읽을 수 있도록 권한을 제한합니다."
      },
      {
        "title": "ca.key 권한 확인",
        "command": "ls -l ca.key",
        "check": { "passContains": ["-rw-------"], "requireExitZero": true },
        "desc": "개인키 권한이 600(소유자만 읽기/쓰기)인지 확인합니다. 권한이 열려 있으면 일부 도구가 키 사용을 거부합니다."
      },
      {
        "title": "ca.conf 파일 작성",
        "check": {"requireExitZero":true},
        "command": "cat > ca.conf << 'EOF'\n[ req ]\ndefault_bits            = 2048\ndefault_md              = sha1\ndefault_keyfile         = ca.key\ndistinguished_name      = req_distinguished_name\nextensions              = v3_ca\nreq_extensions          = v3_ca\n\n[ v3_ca ]\nbasicConstraints        = critical, CA:TRUE, pathlen:0\nsubjectKeyIdentifier    = hash\nkeyUsage                = keyCertSign, cRLSign\nnsCertType              = sslCA, emailCA, objCA\n\n[ req_distinguished_name ]\ncountryName             = Country Name (2 letter code)\ncountryName_default     = KR\ncountryName_min         = 2\ncountryName_max         = 2\n\norganizationName        = Organization Name (eg, company)\norganizationName_default = Example Inc.\n\ncommonName              = Common Name (eg, your name or your server's hostname)\ncommonName_default      = Example Root CA\ncommonName_max          = 64\nEOF",
        "desc": "Root CA 인증서 생성에 필요한 설정 파일을 heredoc으로 바로 작성합니다. vi 진입 없이 '실행' 버튼으로 파일이 즉시 생성됩니다.",
        "code": "[ req ]\ndefault_bits            = 2048\ndefault_md              = sha1\ndefault_keyfile         = ca.key\ndistinguished_name      = req_distinguished_name\nextensions              = v3_ca\nreq_extensions          = v3_ca\n\n[ v3_ca ]\nbasicConstraints        = critical, CA:TRUE, pathlen:0\nsubjectKeyIdentifier    = hash\nkeyUsage                = keyCertSign, cRLSign\nnsCertType              = sslCA, emailCA, objCA\n\n[ req_distinguished_name ]\ncountryName             = Country Name (2 letter code)\ncountryName_default     = KR\ncountryName_min         = 2\ncountryName_max         = 2\n\norganizationName        = Organization Name (eg, company)\norganizationName_default = Example Inc.\n\ncommonName              = Common Name (eg, your name or your server's hostname)\ncommonName_default      = Example Root CA\ncommonName_max          = 64"
      },
      {
        "title": "Root CA CSR 생성",
        "check": {"requireExitZero":true},
        "command": "openssl req -new -sha256 -key ca.key -config ca.conf -out ca.csr -batch",
        "desc": "-batch 옵션으로 ca.conf의 기본값을 그대로 사용해 비대화형으로 생성합니다. (Enter 입력 불필요 — 검증 실행에서도 자동 처리)"
      },
      {
        "title": "Root CA 인증서 생성",
        "check": {"requireExitZero":true},
        "command": "openssl x509 -req -sha256 -days 3650 -extensions v3_ca -set_serial 1 -in ca.csr -signkey ca.key -extfile ca.conf -out ca.crt",
        "desc": "CSR을 자가 서명하여 유효기간 10년의 Root CA 인증서(ca.crt)를 생성합니다."
      },
      {
        "title": "서비스 키 생성",
        "check": {"requireExitZero":true},
        "command": "openssl genrsa -out service.key 2048",
        "desc": "로드밸런서 SSL에 사용할 서비스 인증서의 개인 키를 생성합니다."
      },
      {
        "title": "서비스 키 권한 제한",
        "check": {"requireExitZero":true},
        "command": "chmod 600 service.key",
        "desc": "서비스 개인 키를 소유자만 읽을 수 있도록 권한을 제한합니다."
      },
      {
        "title": "service.key 권한 확인",
        "command": "ls -l service.key",
        "check": { "passContains": ["-rw-------"], "requireExitZero": true },
        "desc": "개인키 권한이 600(소유자만 읽기/쓰기)인지 확인합니다. 권한이 열려 있으면 일부 도구가 키 사용을 거부합니다."
      },
      {
        "title": "service.conf 파일 작성",
        "check": {"requireExitZero":true},
        "command": "cat > service.conf << 'EOF'\n[ req ]\ndefault_bits            = 2048\ndefault_md              = sha1\ndefault_keyfile         = ca.key\ndistinguished_name      = req_distinguished_name\nextensions              = v3_user\n\n[ v3_user ]\nbasicConstraints        = CA:FALSE\nauthorityKeyIdentifier  = keyid,issuer\nsubjectKeyIdentifier    = hash\nkeyUsage                = nonRepudiation, digitalSignature, keyEncipherment\nextendedKeyUsage        = serverAuth,clientAuth\nsubjectAltName          = @alt_names\n\n[ alt_names ]\nIP.1 = <로드밸런서 VIP>\n\n[ req_distinguished_name ]\ncountryName             = Country Name (2 letter code)\ncountryName_default     = KR\ncountryName_min         = 2\ncountryName_max         = 2\n\norganizationName        = Organization Name (eg, company)\norganizationName_default = Example Inc.\n\norganizationalUnitName  = Organizational Unit Name (eg, section)\norganizationalUnitName_default = Example Project\n\ncommonName              = Common Name (eg, your name or your server's hostname)\ncommonName_default      = <로드밸런서 VIP>\ncommonName_max          = 64\nEOF",
        "desc": "서비스 인증서 생성에 필요한 설정 파일을 만듭니다.\n'입력' 버튼을 누르면 VIP 를 한 번 받아 IP.1 과 commonName_default 두 곳에 채워 넣고 실행합니다.",
        "code": "[ req ]\ndefault_bits            = 2048\ndefault_md              = sha1\ndefault_keyfile         = ca.key\ndistinguished_name      = req_distinguished_name\nextensions              = v3_user\n\n[ v3_user ]\nbasicConstraints        = CA:FALSE\nauthorityKeyIdentifier  = keyid,issuer\nsubjectKeyIdentifier    = hash\nkeyUsage                = nonRepudiation, digitalSignature, keyEncipherment\nextendedKeyUsage        = serverAuth,clientAuth\nsubjectAltName          = @alt_names\n\n[ alt_names ]\nIP.1 = <로드밸런서 VIP>\n\n[ req_distinguished_name ]\ncountryName             = Country Name (2 letter code)\ncountryName_default     = KR\ncountryName_min         = 2\ncountryName_max         = 2\n\norganizationName        = Organization Name (eg, company)\norganizationName_default = Example Inc.\n\norganizationalUnitName  = Organizational Unit Name (eg, section)\norganizationalUnitName_default = Example Project\n\ncommonName              = Common Name (eg, your name or your server's hostname)\ncommonName_default      = <로드밸런서 VIP>\ncommonName_max          = 64"
      },
      {
        "title": "서비스 CSR 생성",
        "check": {"requireExitZero":true},
        "command": "openssl req -new -sha256 -key service.key -config service.conf -out service.csr -batch",
        "desc": "-batch 옵션으로 service.conf의 기본값(VIP 포함)을 그대로 사용해 비대화형으로 생성합니다. (Enter 입력 불필요 — 검증 실행에서도 자동 처리)"
      },
      {
        "title": "서비스 인증서 서명 (Root CA로 서명)",
        "check": {"requireExitZero":true},
        "command": "openssl x509 -req -sha256 -days 1825 -extensions v3_user -in service.csr -CA ca.crt -CAcreateserial -CAkey ca.key -extfile service.conf -out service.crt",
        "desc": "Root CA로 서비스 CSR에 서명하여 유효기간 5년의 서비스 인증서(service.crt)를 생성합니다."
      },
      {
        "title": "PKCS#12 형식으로 변환",
        "check": {"requireExitZero":true},
        "command": "openssl pkcs12 -export -passout pass: -out service.p12 -inkey service.key -in service.crt -certfile ca.crt",
        "desc": "서비스 키 + 서비스 인증서 + CA 인증서를 하나의 PKCS#12(.p12) 파일로 묶습니다.\n-passout pass: 로 export 비밀번호를 빈 값으로 두어 Enter 입력 없이 끝납니다.",
        "note": "OpenStack LB는 PKCS#12를 Base64로 인코딩한 값을 요구합니다."
      },
      {
        "title": "Base64 인코딩",
        "check": {"requireExitZero":true},
        "command": "base64 service.p12 > service.p12.base64",
        "desc": "PKCS#12 바이너리 파일을 Base64 텍스트로 인코딩합니다."
      },
      {
        "title": "생성 파일 목록 확인",
        "command": "ls -l",
        "check": {
          "requireExitZero": true,
          "passContains": ["ca.key", "ca.crt", "service.key", "service.crt", "service.p12", "service.p12.base64"]
        },
        "desc": "ca.key, ca.crt, service.key, service.crt, service.p12, service.p12.base64 파일이 모두 생성되었는지 확인합니다."
      },
      {
        "title": "Base64 파일 내용 출력 및 복사",
        "check": {"requireExitZero":true},
        "command": "cat service.p12.base64",
        "desc": "출력된 Base64 문자열 전체를 복사합니다. 다음 단계에서 대시보드에 붙여넣기합니다."
      },
      {
        "title": "SSL 인증서 등록",
        "command": "",
        "desc": "LNB 영역에서 관리 > SSL 인증서로 이동 후 [직접입력] 탭을 선택합니다. 복사한 Base64 값을 PKCS12 데이터 필드에 붙여넣고 저장합니다."
      },
      {
        "title": "리스너 및 풀 생성",
        "command": "",
        "desc": "생성한 로드밸런서에서 리스너와 풀을 순서대로 추가합니다.",
        "note": "Step1 리스너: 프로토콜 TERMINATED_HTTPS, 등록한 SSL 인증서 선택\nStep2 풀: 프로토콜 HTTP\nStep3 풀 멤버: 풀 멤버용 인스턴스 1대, 포트 80\nStep4 헬스 체크: 타입 HTTP"
      },
      {
        "title": "[클라이언트 인스턴스] 터미널 접속",
        "command": "",
        "desc": "인증서를 만든 그 클라이언트 인스턴스에서 이어서 진행합니다. 앞 단계에서 ~/ssl-certs 에 ca.crt 를 이미 만들어 두었으므로 따로 옮길 것이 없습니다.",
        "info": "인증서를 다른 장비에서 만들었다면 그때만 scp 등으로 ca.crt 를 이 인스턴스로 옮기세요."
      },
      {
        "title": "CA 인증서 시스템에 복사",
        "check": {"requireExitZero":true},
        "command": "sudo cp ca.crt /usr/local/share/ca-certificates/",
        "undo": "sudo rm -f /usr/local/share/ca-certificates/ca.crt && sudo update-ca-certificates --fresh",
        "desc": "Root CA 인증서를 시스템 인증서 저장소에 복사합니다. (ca.crt 가 있는 디렉토리에서 실행 — 시스템 경로 쓰기라 sudo 필요)"
      },
      {
        "title": "시스템 인증서 업데이트",
        "command": "sudo update-ca-certificates",
        "check": { "requireExitZero": true },
        "desc": "시스템 CA 인증서 목록을 갱신합니다. 처음 넣을 때는 '1 added' 가 나오고, 이미 등록돼 있으면 '0 added' 가 나옵니다 — 둘 다 정상입니다.",
        "note": "'0 added' 를 실패로 보지 않습니다. 같은 인증서를 두 번 넣는 것이 오류는 아니기 때문입니다(재실행에서 그렇게 나옵니다)."
      },
      {
        "title": "HTTPS 통신 확인",
        "command": "curl -v --cacert /usr/local/share/ca-certificates/ca.crt https://<로드밸런서 VIP>",
        "check": {
          "requireExitZero": true,
          "failContains": [
            "SSL certificate problem",
            "unable to get local issuer",
            "self signed certificate",
            "Connection refused",
            "Could not resolve host"
          ]
        },
        "desc": "로드밸런서 VIP로 HTTPS 요청을 보냅니다. SSL 핸드셰이크가 성공하고 풀 멤버의 HTTP 응답 본문이 반환되면 정상입니다.",
        "note": "응답에서 'SSL connection using TLS...' 및 'Server certificate' 정보가 출력되면 인증서가 올바르게 적용된 것입니다."
      }
    ]
  },
  {
    "id": "scn-nc-port-check",
    "roleValues": {"인스턴스A_IP":"인스턴스 A"},
    "solution": "OpenStack",
    "title": "[네트워크] nc 포트 연결 상태 체크 동작 확인",
    "summary": "nc(netcat)로 VM 간 포트 연결 상태를 실시간으로 확인하며, Live 및 Cold 마이그레이션 중 통신 중단 여부를 검증합니다.",
    "steps": [
      {
        "title": "인스턴스 A, B 생성",
        "command": "",
        "desc": "LNB 에서 컴퓨트 > 인스턴스로 가서 인스턴스를 2대 만듭니다.\n· A — nc 로 포트를 열고 기다리는 쪽\n· B — A 로 연결해 보는 쪽\n두 인스턴스는 같은 네트워크 대역에 있어야 합니다."
      },
      {
        "title": "인스턴스 A에 터미널 접속",
        "command": "",
        "desc": "인스턴스 A에 SSH로 접속합니다. OpenStack 포털의 웹 콘솔 또는 이 앱의 SSH 연결을 사용하세요."
      },
      {
        "title": "패키지 목록 업데이트",
        "command": `${APT} update`,
        "check": { "failContains": ["Err:", "Failed to fetch", "Could not resolve", "Temporary failure resolving"], "passContains": ["Reading package lists"] },
        "desc": "netcat 설치에 앞서 패키지 목록을 최신화합니다.",
        "note": "업데이트가 실패하면 DNS 설정을 확인하세요. nameserver가 없으면 외부 패키지 서버에 접근할 수 없습니다.\n확인: cat /etc/resolv.conf\n미설정 시: netplan 또는 /etc/resolv.conf에 nameserver를 추가 후 적용하세요."
      },
      {
        "title": "netcat 설치",
        "command": `${APT} install -y netcat-openbsd`,
        "onFailure": "retry",
        "onFailureCommand": APT_FIX,
        "onFailureDesc": APT_FIX_DESC,
        "check": { "requireExitZero": true, "failContains": ["Unable to locate package", "has no installation candidate"] },
        "desc": "포트 연결 테스트에 사용할 netcat을 설치합니다.",
        "note": "RHEL/CentOS 계열: yum install -y nmap-ncat"
      },
      {
        "title": "포트 수신 대기 시작 (인스턴스 A)",
        "target": "인스턴스 A",
        "command": "(nohup nc -l -k <포트번호> >/dev/null 2>&1 &); sleep 1; ss -tlnp 2>/dev/null | grep -q ':<포트번호> ' && echo '수신 대기 중입니다' || echo '주의 — 리스너가 뜨지 않았습니다'",
        "check": { "passContains": ["수신 대기 중입니다"], "failContains": ["주의 —"] },
        "undo": "pkill -f 'nc -l -k <포트번호>' || echo '수신 대기 프로세스가 없습니다 (이미 정리됨)'",
        "warn": "이 단계는 포트를 열어 둡니다. 시험이 끝나면 반드시 원복으로 정리하세요.",
        "desc": "인스턴스 A에서 지정한 포트를 백그라운드로 수신 대기시킵니다. 터미널을 점유하지 않으므로 다음 단계로 바로 넘어갈 수 있습니다.",
        "info": "포트 번호 예시: 9999 (SSH 22 대신 임의 포트 권장). -k 는 연결이 끊겨도 계속 수신하는 옵션이라 반복 시험에 맞습니다.\n끝나면 이 시나리오의 원복으로 정리됩니다 — 남겨 두면 그 포트를 계속 점유합니다."
      },
      {
        "title": "포트 연결 일회성 확인 (인스턴스 B 또는 다른 터미널)",
        "target": "인스턴스 B",
        "command": "nc -zv <인스턴스A_IP> <포트번호>",
        "check": { "passContains": ["succeeded"], "failContains": ["Connection refused", "No route to host", "timed out"] },
        "desc": "인스턴스 B 또는 동일 네트워크의 다른 서버에서 인스턴스 A IP로 포트 연결을 시도합니다.",
        "note": "성공 시: Connection to <IP> <port> port [tcp] succeeded!\n실패 시: nc: connect to <IP> port <port> (tcp) failed: Connection refused"
      },
      {
        "title": "지속 통신 루프 시작",
        "target": "인스턴스 B",
        "command": "L=/tmp/qterm-loop.txt; : > $L; for i in $(seq 1 120); do T=$(date +%H:%M:%S); if M=$(nc -zv -w 1 <인스턴스A_IP> <포트번호> 2>&1); then R=OK; else R=\"FAIL  $(echo \"$M\" | tail -1)\"; fi; echo \"$T $R\" | tee -a $L; sleep 1; done; awk '{n++; if($2==\"OK\"){s++; c=0} else {f++; c++; if(c>mx)mx=c; if(first==\"\")first=$1}} END{print \"--- 관찰 종료: \" n \"회 시도 · 성공 \" s+0 \" · 끊김 \" f+0; if(f+0==0) print \"끊김 없음 — 통신이 유지되었습니다\"; else print \"주의 — 통신이 끊긴 구간이 있습니다 (가장 긴 끊김 \" mx \"초, 첫 끊김 \" first \")\"}' $L; rm -f $L",
        "check": { "passContains": ["끊김 없음"], "failContains": ["주의 —"] },
        "desc": "1초 간격으로 120초 동안 포트 연결을 반복합니다. 끝나면 끊긴 횟수와 가장 긴 끊김 길이를 스스로 세어 알려 줍니다.",
        "warn": "이 루프는 2분 동안 돕니다. 시작하자마자 포털에서 다음 단계(마이그레이션)를 거세요.\n루프가 끝난 뒤에 걸면 아무것도 관찰되지 않습니다.",
        "info": "결과에서 볼 것 — 맨 아래 두 줄입니다.\n· 관찰 종료: 120회 시도 · 성공 N · 끊김 M\n· 끊김 없음(무중단) 이거나, 주의 — … (가장 긴 끊김 N초, 첫 끊김 시각)\n\n위의 시각별 줄은 그대로 남습니다. 어느 구간에서 끊겼는지 리포트에서 짚을 때 씁니다.\n마이그레이션이 2분보다 오래 걸리면 이 단계를 이어서 다시 실행하세요.\n끝나지 않는 while 루프를 쓰지 않는 이유는, 그러면 검증 실행이 제한 시간까지 멈춘 채 아무 기록도 남기지 못하기 때문입니다."
      },
      {
        "title": "[Live] 인스턴스 A Live 마이그레이션 실행",
        "command": "",
        "desc": "포털에서 인스턴스 A를 선택해 Live 마이그레이션을 실행합니다. 인스턴스 전원은 Running 상태를 유지한 채 다른 하이퍼바이저로 이동합니다.",
        "info": "Live 마이그레이션 중에는 무중단 사양 변경과 동일하게 통신이 유지되어야 합니다. B 콘솔 루프에서 succeeded!가 끊기지 않으면 무중단 검증 성공입니다."
      },
      {
        "title": "Live 마이그레이션 중 통신 상태 확인",
        "command": "",
        "desc": "인스턴스 B의 루프 출력을 확인합니다. succeeded! 메시지가 계속 출력되면 통신이 유지된 것입니다.",
        "note": "정상(무중단) 시: Connection to <IP> <port> port [tcp] succeeded! 가 끊기지 않음\n중단 발생 시: nc: connect to <IP> port <port> (tcp) failed: Connection refused 가 일시 출력"
      },
      {
        "title": "[Live] 마이그레이션 완료 후 호스트 변경 확인",
        "command": "",
        "desc": "포털에서 인스턴스 A 상세 페이지로 이동해 마이그레이션 전과 다른 하이퍼바이저 호스트로 변경되었는지 확인합니다."
      },
      {
        "title": "[Cold] Cold 마이그레이션 실행",
        "command": "",
        "desc": "포털에서 인스턴스 A를 선택해 Cold 마이그레이션을 실행합니다. 전원 종료와 재시작은 마이그레이션 과정에서 자동으로 처리됩니다.",
        "info": "Cold 마이그레이션은 RESIZE → VERIFY_RESIZE → ACTIVE 단계를 자동으로 거칩니다. 이 과정에서 통신이 끊겼다가 재시작 후 다시 연결되는 동작을 아래 단계에서 확인합니다."
      },
      {
        "title": "Cold 마이그레이션 후 통신 재연결 확인",
        "command": "nc -zv <인스턴스A_IP> <포트번호>",
        "check": { "passContains": ["succeeded"], "failContains": ["Connection refused", "No route to host", "timed out"] },
        "desc": "인스턴스 A가 재시작된 후 포트 연결이 재개되는지 확인합니다. 마이그레이션 중에는 통신이 끊기고, 재시작 완료 후 succeeded! 메시지가 출력되면 재연결 성공입니다.",
        "note": "인스턴스 A에서 nc -l -p <포트> 를 다시 실행한 뒤 확인하세요."
      },
      {
        "title": "[Cold] 마이그레이션 완료 후 호스트 변경 확인",
        "command": "",
        "desc": "포털에서 인스턴스 A 상세 페이지로 이동해 마이그레이션 전과 다른 하이퍼바이저 호스트로 변경되었는지 확인합니다."
      }
    ]
  },
  {
    "id": "scn8",
    "solution": "OpenStack",
    "title": "[네트워크] 인터페이스 및 DNS 설정 동작 확인",
    "summary": "인터페이스 상태를 확인하고, 활성/비활성을 제어한 뒤 Netplan 으로 IP/DNS 를 설정하고 외부 통신을 확인합니다.",
    "steps": [
      {
        "title": "인터페이스 상태 확인",
        "command": "ip link show",
        "desc": "모든 네트워크 인터페이스(NIC)의 이름과 UP/DOWN 상태를 확인합니다."
      },
      {
        "title": "인터페이스 비활성화",
        "check": {"requireExitZero":true},
        "command": "sudo ip link set <IFACE> down",
        "undo": "sudo ip link set <IFACE> up",
        "warn": "SSH 접속에 쓰는 인터페이스를 내리면 즉시 연결이 끊기고 콘솔로만 복구할 수 있습니다. 대상 인터페이스가 접속 경로가 아닌지 반드시 확인하세요.",
        "desc": "특정 인터페이스를 내립니다. <IFACE> 는 eth1 등 대상 인터페이스명으로 바꾸세요.",
        "note": "⚠️ SSH 로 접속 중인 인터페이스를 내리면 연결이 끊깁니다. 관리용이 아닌 NIC 에만 사용하세요."
      },
      {
        "title": "인터페이스 활성화",
        "check": {"requireExitZero":true},
        "command": "sudo ip link set <IFACE> up",
        "desc": "내렸던 인터페이스를 다시 올립니다."
      },
      {
        "title": "Netplan 설정 편집",
        "command": "sudo vi /etc/netplan/50-cloud-init.yaml",
        "needsInput": true,
        "warn": "실행 시 vi 편집기가 열립니다. i(입력 모드)로 수정 → ESC → :wq! 로 저장·종료한 뒤 다음 단계를 진행하세요.",
        "desc": "IP 주소, 게이트웨이, nameservers(DNS) 를 설정합니다. (Ubuntu 기준)",
        "info": "vi 편집기 사용법: i → 입력 모드 시작 → 수정 → ESC → :wq! Enter (저장 후 종료) | 저장 없이 나가려면 :q! Enter",
        "note": "상단 [설정 파일 뷰어] 버튼으로 편집하는 것이 안전합니다.\nYAML 은 들여쓰기(공백 2칸)에 민감합니다.\n50-cloud-init.yaml 은 다른 이름의 파일로 대체돼 있을 수 있으니 파일명을 확인하세요."
      },
      {
        "title": "Netplan 적용",
        "check": {"requireExitZero":true},
        "command": "sudo netplan apply",
        "warn": "설정이 잘못되면 네트워크가 끊겨 SSH로 되돌릴 수 없습니다. 콘솔 접근 수단을 확보한 뒤 진행하세요.",
        "desc": "변경한 Netplan 설정을 적용합니다.",
        "note": "⚠️ 설정 오류 시 네트워크가 끊길 수 있습니다. 원격 작업이면 먼저 `sudo netplan try`(120초 후 자동 롤백)로 검증하세요."
      },
      {
        "title": "외부 통신 확인",
        "command": "ping -c 4 google.com",
        "check": {
          "requireExitZero": true,
          "failContains": [
            "100% packet loss",
            "Name or service not known",
            "Temporary failure in name resolution",
            "Destination Host Unreachable",
            "Network is unreachable"
          ]
        },
        "desc": "DNS 이름 해석과 외부 인터넷 도달 여부를 한 번에 확인합니다.",
        "note": "이름 해석 실패와 도달 실패를 따로 짚습니다 — 'Name or service not known' 은 DNS 문제, '100% packet loss' 는 경로·방화벽 문제입니다."
      }
    ]
  },
  {
    "id": "scn9",
    "solution": "OpenStack",
    "title": "[네트워크] 포트 통신 동작 확인",
    "summary": "서버에 테스트 포트를 직접 열어 수신 대기시킨 뒤, 클라이언트에서 TCP·UDP·HTTP 통신이 되는지 확인하고 마지막에 정리합니다.",
    "roleValues": { "Target_IP": "서버" },
    "steps": [
      {
        "title": "도구 설치 (서버·클라이언트 양쪽)",
        "command": `${APT} update && ${APT} install -y netcat-openbsd nmap`,
        "target": "서버, 클라이언트",
        "onFailure": "retry",
        "onFailureCommand": APT_FIX,
        "onFailureDesc": APT_FIX_DESC,
        "check": { "requireExitZero": true, "failContains": ["Unable to locate package", "has no installation candidate"] },
        "desc": "포트 점검용 nc(netcat)와 nmap 을 설치합니다. 역할별 대상에서 고른 서버·클라이언트 두 세션에서 함께 실행되므로 따로 고를 필요가 없습니다.",
        "note": "RHEL/CentOS 계열은 sudo dnf install -y nmap-ncat nmap"
      },
      {
        "title": "[서버] 테스트 포트 열기 (TCP 15001 · UDP 15002 · HTTP 18080)",
        "command": "(nohup nc -l -k 15001 >/dev/null 2>&1 &); (nohup nc -u -l 15002 >/dev/null 2>&1 &); (cd /tmp && nohup python3 -m http.server 18080 >/dev/null 2>&1 &); sleep 2; echo '테스트 리스너 3개를 띄웠습니다 (TCP 15001 / UDP 15002 / HTTP 18080)'",
        "target": "서버",
        "check": { "requireExitZero": true, "passContains": ["띄웠습니다"] },
        "undo": "pkill -f 'nc -l -k 15001'; pkill -f 'nc -u -l 15002'; pkill -f 'http.server 18080'; true",
        "desc": "받아줄 쪽이 없으면 뒤의 통신 확인은 무조건 실패합니다. 그래서 여기서 직접 포트를 열어 수신 대기시킵니다. 1024 이상 포트라 root 권한 없이 뜨고, 실제 서비스 포트와도 겹치지 않습니다.",
        "note": "포트 번호를 바꾸려면 연필 버튼으로 이 단계와 아래 확인 단계들을 함께 고치세요. HTTP 리스너는 python3 기본 모듈을 씁니다."
      },
      {
        "title": "[서버] 포트가 실제로 열렸는지 확인",
        "command": "sudo ss -tunlp 2>/dev/null | grep -E ':15001|:15002|:18080' || ss -tunlp | grep -E ':15001|:15002|:18080'",
        "target": "서버",
        "check": { "passContains": ["15001", "15002", "18080"] },
        "desc": "결과에서 볼 것 — 세 줄이 모두 보여야 합니다.\ntcp LISTEN 15001 / udp UNCONN 15002 / tcp LISTEN 18080\n하나라도 없으면 앞 단계에서 리스너가 못 뜬 것입니다.",
        "note": "UDP 는 LISTEN 이 아니라 UNCONN 으로 표시되는 것이 정상입니다."
      },
      {
        "title": "[서버] 방화벽 상태 확인",
        "command": "sudo ufw status",
        "target": "서버",
        "desc": "결과에서 볼 것 — Status 가 inactive 면 방화벽은 통과입니다.\nactive 인데 15001/15002/18080 허용 규칙이 없으면 다음 단계가 실패합니다 — sudo ufw allow 15001 처럼 열어 주세요.",
        "note": "iptables 기반 환경은 sudo iptables -L -n --line-numbers"
      },
      {
        "title": "[클라이언트] TCP 포트 통신 확인",
        "command": "nc -zv -w 5 <Target_IP> 15001",
        "target": "클라이언트",
        "check": { "passContains": ["succeeded"] },
        "desc": "결과에서 볼 것 — 'Connection to ... succeeded!' 문구입니다.\n<Target_IP> 는 서버 스텝의 대상 주소와 같으니, 아래 입력칸의 서버 아이콘을 눌러 '2번 대상'을 고르세요.",
        "note": "Connection refused 면 리스너가 죽은 것이고, timed out 이면 방화벽/보안그룹이 막고 있는 것입니다."
      },
      {
        "title": "[클라이언트] UDP 포트 통신 확인",
        "command": "nc -uzv -w 5 <Target_IP> 15002",
        "target": "클라이언트",
        "check": { "passContains": ["succeeded"] },
        "desc": "결과에서 볼 것 — TCP 와 같은 'succeeded' 문구입니다.",
        "note": "UDP 는 응답이 없어도 succeeded 로 보일 수 있습니다. 확실히 하려면 앞 단계에서 리스너가 UNCONN 으로 떠 있는지 먼저 확인하세요."
      },
      {
        "title": "[클라이언트] nmap 포트 상태 확인",
        "command": "nmap -p 15001,18080 <Target_IP>",
        "target": "클라이언트",
        "check": { "passContains": ["open"] },
        "desc": "결과에서 볼 것 — 두 포트가 모두 open 이어야 합니다. closed 는 리스너가 없는 것, filtered 는 방화벽이 막은 것입니다.",
        "note": "UDP 스캔(-sU)은 root 권한이 필요하고 느려서 여기서는 TCP 만 봅니다."
      },
      {
        "title": "[클라이언트] HTTP 응답 확인",
        "command": "curl -Iv --max-time 10 http://<Target_IP>:18080/",
        "target": "클라이언트",
        // '200' 만 찾으면 Content-Length: 1200 같은 숫자에도 통과한다 — 응답 줄에서 본다
        "check": { "passRegex": "HTTP/[0-9.]+ 200" },
        "desc": "결과에서 볼 것 — 'HTTP/1.0 200 OK' 응답 코드입니다. 포트가 열린 것을 넘어 실제로 서비스가 응답하는지까지 확인하는 단계입니다."
      },
      {
        "title": "[서버] 테스트 포트 정리",
        "command": "pkill -f 'nc -l -k 15001'; pkill -f 'nc -u -l 15002'; pkill -f 'http.server 18080'; sleep 1; ss -tunlp 2>/dev/null | grep -E ':15001|:15002|:18080' || echo '테스트 리스너가 모두 정리되었습니다'",
        "target": "서버",
        "check": { "passContains": ["정리되었습니다"] },
        "desc": "결과에서 볼 것 — '모두 정리되었습니다' 문구입니다. 포트 목록이 대신 보이면 아직 남은 리스너가 있는 것이니 다시 실행하세요.",
        "note": "이 단계를 건너뛰었다면 상단 '원복 실행' 버튼으로도 정리됩니다."
      }
    ]
  },
  {
    "id": "scn-manila-cephfs",
    "solution": "OpenStack",
    "title": "[스토리지] 공유 파일 엑세스 규칙 RW/RO 동작 확인",
    "summary": "CephFS 공유파일 생성 후 액세스 규칙(read-write/read-only)을 생성하고, 인스턴스에서 마운트해 파일 쓰기·읽기 동작을 검증합니다.",
    "steps": [
      {
        "title": "공유파일 생성",
        "command": "",
        "desc": "LNB 영역에서 스토리지 > 공유파일로 이동해 공유파일을 생성합니다. 프로토콜은 CEPHFS를 선택하세요."
      },
      {
        "title": "액세스 규칙 생성",
        "command": "",
        "desc": "생성한 공유파일 상세 페이지의 '액세스 규칙' 탭에서 규칙을 생성합니다. 액세스 유형: cephx / 액세스 레벨: read-write 또는 read-only / 액세스 경로: ex. meta",
        "note": "Manila 서비스에 Ceph 제어 권한이 없을 수 있습니다. 이 경우 호스트에서 ceph auth ls 명령으로 기 생성된 계정을 확인해 테스트하세요. (예: client.meta)"
      },
      {
        "title": "테스트 인스턴스 접속",
        "command": "",
        "desc": "SSH 또는 대시보드 콘솔로 CephFS 마운트 테스트를 수행할 인스턴스에 접속합니다."
      },
      {
        "title": "패키지 업데이트",
        "command": `${APT} update`,
        "check": { "requireExitZero": true },
        "desc": "ceph-common 설치 전 패키지 목록을 최신화합니다.",
        "note": "업데이트가 실패하면 DNS 설정을 확인하세요. nameserver가 없으면 외부 패키지 서버에 접근할 수 없습니다.\n확인: cat /etc/resolv.conf\n미설정 시: netplan 또는 /etc/resolv.conf에 nameserver를 추가 후 적용하세요."
      },
      {
        "title": "Ceph 클라이언트 설치",
        "command": `${APT} install -y ceph-common`,
        "onFailure": "retry",
        "onFailureCommand": APT_FIX,
        "onFailureDesc": APT_FIX_DESC,
        "check": { "requireExitZero": true, "failContains": ["Unable to locate package", "has no installation candidate"] },
        "desc": "CephFS 마운트에 필요한 ceph-common 패키지를 설치합니다.",
        "note": "RHEL/CentOS 계열은 sudo dnf install -y ceph-common"
      },
      {
        "title": "ceph.conf 생성",
        "command": "sudo vi /etc/ceph/ceph.conf",
        "needsInput": true,
        "warn": "실행 시 vi 편집기가 열립니다. i(입력 모드)로 수정 → ESC → :wq! 로 저장·종료한 뒤 다음 단계를 진행하세요.",
        "desc": "호스트에 설정된 ceph.conf 내용을 참고해 클라이언트용 설정 파일을 생성합니다.",
        "info": "vi 편집기 사용법: i → 입력 모드 시작 → 수정 → ESC → :wq! Enter (저장 후 종료) | 저장 없이 나가려면 :q! Enter",
        "note": "입력 예시:\n[global]\nmon_host = 10.255.41.1, 10.255.41.3, 10.255.41.2"
      },
      {
        "title": "키링 파일 생성",
        "command": "sudo vi /etc/ceph/ceph.client.<액세스 경로>.keyring",
        "needsInput": true,
        "warn": "'입력'으로 경로 값을 채운 뒤 실행하면 vi 편집기가 열립니다. i(입력 모드)로 수정 → ESC → :wq! 로 저장·종료한 뒤 다음 단계를 진행하세요.",
        "desc": "액세스 규칙 생성 시 발급된 액세스 키를 사용해 클라이언트 키링 파일을 생성합니다.",
        "info": "vi 편집기 사용법: i → 입력 모드 시작 → 수정 → ESC → :wq! Enter (저장 후 종료) | 저장 없이 나가려면 :q! Enter",
        "note": "입력 예시:\n[client.meta]\nkey = AQB30kFqxghVCRAA5Tvsspfv4VBTyE4BKcc32w=="
      },
      {
        "title": "마운트 포인트 생성",
        "command": "sudo mkdir -p /mnt/data",
        "check": { "requireExitZero": true },
        "undo": "sudo rmdir /mnt/data",
        "desc": "CephFS를 마운트할 디렉토리를 생성합니다."
      },
      {
        "title": "마운트 포인트 생성 확인",
        "command": "ls -ld /mnt/data",
        "check": { "passContains": ["/mnt/data"], "requireExitZero": true },
        "desc": "디렉토리가 실제로 만들어졌는지 확인합니다."
      },
      {
        "title": "CephFS 마운트",
        "command": "sudo mount -t ceph <추출위치> /mnt/data -o name=<액세스 경로>,secret=<액세스 키>,mds_namespace=cephfs && mountpoint -q /mnt/data && echo '마운트되었습니다' && df -h /mnt/data",
        "check": { "requireExitZero": true, "passContains": ["마운트되었습니다"] },
        "undo": "sudo umount /mnt/data || echo '/mnt/data 가 이미 해제되어 있습니다'",
        "desc": "공유파일 상세에서 확인한 추출위치를 입력해 CephFS를 마운트합니다. name은 액세스 경로(예: meta), secret은 액세스 키 값을 입력하세요."
      },
      {
        "title": "마운트 확인",
        "command": "df -h",
        "check": { "requireExitZero": true, "passContains": ["/mnt/data"] },
        "desc": "/mnt/data 항목이 표시되면 정상적으로 마운트된 것입니다."
      },
      {
        "title": "파일 쓰기 테스트",
        "check": {"passContains":["Test"],"requireExitZero":true},
        "command": "echo \"Test\" | sudo tee /mnt/data/test.txt",
        "desc": "read-write 규칙이면 정상 쓰기됩니다. read-only 규칙이면 'Read-only file system' 오류가 출력되어 RO 정책이 정상 동작함을 확인할 수 있습니다.",
        "note": "자동 판정하지 않습니다 — 이 시나리오는 RW·RO 두 규칙을 모두 다루므로, 쓰기 성공과 쓰기 거부가 **둘 다 정상**일 수 있습니다. 어느 규칙으로 걸었는지 보고 사람이 판정하세요."
      },
      {
        "title": "파일 읽기 테스트",
        "check": {"passContains":["Test"],"requireExitZero":true},
        "command": "cat /mnt/data/test.txt",
        "desc": "파일 내용(Test)이 출력되면 읽기 동작이 정상입니다."
      },
      {
        "title": "마운트 해제",
        "check": {"requireExitZero":true},
        "command": "sudo umount /mnt/data",
        "desc": "테스트 완료 후 마운트를 해제합니다."
      },
      {
        "title": "해제 확인",
        "command": "df -h",
        "check": { "requireExitZero": true, "failContains": ["/mnt/data"] },
        "desc": "/mnt/data 항목이 사라졌으면 정상적으로 해제된 것입니다.",
        "note": "여기서는 목록에 남아 있는 것이 실패입니다 — 앞의 마운트 확인과 정반대 기준입니다."
      }
    ]
  },
  {
    "id": "scn-disk-with-partition",
    "solution": "OpenStack",
    "title": "[스토리지] 디스크 마운트 및 데이터 확인 (파티션 있는 경우)",
    "summary": "파티션이 구성된 볼륨을 마운트하고 재부팅 후에도 자동 마운트 되도록 /etc/fstab에 등록합니다. 기존 데이터를 유지한 채 진행합니다.",
    "steps": [
      {
        "title": "인스턴스 생성",
        "command": "",
        "desc": "LNB 영역에서 컴퓨트 > 인스턴스로 이동해 인스턴스를 생성하세요."
      },
      {
        "title": "인스턴스 터미널 접속",
        "command": "",
        "desc": "생성된 인스턴스 터미널에 SSH 또는 대시보드 콘솔로 접속하세요."
      },
      {
        "title": "파티션 확인",
        "command": "lsblk",
        "desc": "연결된 디스크와 파티션 구성을 확인합니다. 파티션이 구성된 디스크를 확인하세요. (예: vdb → vdb1)"
      },
      {
        "title": "마운트 폴더 생성",
        "command": "sudo mkdir -p /mnt/data",
        "check": { "requireExitZero": true },
        "undo": "sudo rmdir /mnt/data",
        "desc": "디스크를 연결할 마운트 포인트를 생성합니다."
      },
      {
        "title": "마운트 폴더 생성 확인",
        "command": "ls -ld /mnt/data",
        "check": { "passContains": ["/mnt/data"], "requireExitZero": true },
        "desc": "디렉토리가 실제로 만들어졌는지 확인합니다."
      },
      {
        "title": "디스크 마운트",
        "check": {"requireExitZero":true},
        "command": "sudo mount /dev/<DISK> /mnt/data",
        "undo": "sudo umount /mnt/data",
        "desc": "파티션을 마운트 포인트에 연결합니다. <DISK>에는 파티션 장치명을 입력하세요. (예: vdb1)"
      },
      {
        "title": "마운트 확인",
        "command": "df -h /mnt/data",
        "check": { "requireExitZero": true, "passContains": ["/mnt/data"] },
        "desc": "용량이 표시되면 정상적으로 마운트된 것입니다.",
        "note": "마운트되지 않았으면 df 는 그 경로를 품은 파일시스템(대개 /)을 대신 보여 줍니다 — 출력에 /mnt/data 가 없으면 마운트가 안 된 것입니다."
      },
      {
        "title": "데이터 쓰기 및 보존 확인 (공통 적용 구간)",
        "command": "",
        "desc": "마운트된 경로에 테스트 데이터를 기록하고 용량 변화를 확인합니다.",
        "info": "아래 시나리오에서 공통으로 활용 가능한 구간입니다.\n• 인스턴스 스냅샷 / 볼륨 스냅샷으로 생성된 인스턴스 데이터 보존 확인\n• 볼륨 백업으로 복원된 볼륨 데이터 보존 확인\n• 인스턴스 복제 및 증분 백업 복원 데이터 보존 확인"
      },
      {
        "title": "테스트 데이터 쓰기 (dd)",
        "check": {"passContains":["records out"],"requireExitZero":true},
        "command": "sudo dd if=/dev/zero of=/mnt/data/testfile bs=10k count=1000",
        "undo": "sudo rm -f /mnt/data/testfile",
        "desc": "마운트된 경로에 10MB(10k × 1000)의 빈 데이터 파일을 생성합니다. 용량을 늘리려면 count 값을 조정하세요. (count=10000 → 100MB)"
      },
      {
        "title": "용량 변화 확인",
        "command": "df -h /mnt/data",
        "desc": "데이터 쓰기 전후의 사용 용량을 비교합니다. Used 수치가 늘었으면 데이터가 정상적으로 기록된 것입니다."
      },
      {
        "title": "파일 및 디렉토리 상태 확인",
        "command": "sudo du -sh /mnt/data && ls -lh /mnt/data",
        "desc": "디렉토리 총 사용량과 내부 파일 목록 및 크기를 확인합니다."
      },
      {
        "title": "UUID 확인",
        "check": {"passContains":["UUID="]},
        "command": "sudo blkid /dev/<DISK>",
        "capture": [
          { "name": "UUID", "regex": "\\bUUID=\"([^\"]+)\"" },
          // PTTYPE(파티션 테이블 종류)이 아니라 파일시스템 종류다 — 낱말 경계 덕에 PTTYPE= 에는 안 걸린다
          { "name": "FSTYPE", "regex": "\\bTYPE=\"([^\"]+)\"" }
        ],
        "desc": "fstab 등록에 사용할 파티션의 UUID와 파일시스템 종류를 확인합니다. 여기서 뽑은 값이 다음 단계의 <UUID>·<FSTYPE>에 자동으로 들어갑니다.",
        "note": "정규식이 PARTUUID가 아니라 파일시스템 UUID를 잡습니다. 둘을 바꿔 쓰면 다음 부팅에서 emergency mode로 빠집니다."
      },
      {
        "title": "fstab 자동 마운트 등록",
        "check": {"passContains":["/mnt/data"],"requireExitZero":true},
        // 이미 있던 파티션이라 ext4 라는 보장이 없다 — xfs 인데 ext4 로 적으면 다음 단계
        // mount -a 가 'wrong fs type' 으로 막히고, 왜인지는 fstab 을 열어 봐야 안다
        "command": "echo 'UUID=<UUID> /mnt/data <FSTYPE> defaults 0 2' | sudo tee -a /etc/fstab",
        "undo": "sudo cp -a /etc/fstab /etc/fstab.qterm.bak && sudo sed -i '/UUID=<UUID>/d' /etc/fstab && echo '--- 되돌린 뒤 /etc/fstab ---' && cat /etc/fstab",
        "warn": "fstab 을 잘못 쓰면 다음 부팅에서 emergency mode 로 빠집니다. 다음 단계의 findmnt --verify 로 반드시 검증한 뒤 재부팅하세요.",
        "desc": "재부팅 후에도 자동 마운트 되도록 /etc/fstab에 등록합니다. <UUID>와 <FSTYPE>는 앞 단계(blkid)의 출력에서 자동으로 채워집니다.",
        "note": "원복하면 이 UUID 가 들어간 줄을 /etc/fstab 에서 지웁니다.\n지우기 전 원본을 /etc/fstab.qterm.bak 으로 복사해 두므로,\n같은 UUID 를 쓰던 기존 줄이 있었다면 백업에서 되살리세요."
      },
      {
        "title": "fstab 문법 검사 및 재마운트",
        "command": "sudo mount -a",
        "check": { "requireExitZero": true, "failContains": ["can't find", "unknown filesystem", "wrong fs type", "no such"] },
        "desc": "fstab 설정의 문법 오류를 검사하고 전체 항목을 다시 마운트합니다. 오류 없이 완료되면 설정이 정상입니다.",
        "note": "⚠ 오류가 나면 fstab 항목이 잘못된 것입니다. 재부팅 전에 반드시 수정하세요."
      },
      {
        "title": "fstab 항목 검증 및 마운트 확인",
        "command": "sudo findmnt --verify --verbose; findmnt /mnt/data; df -h /mnt/data",
        "check": { "passContains": ["/mnt/data"], "failContains": ["unreachable", "not exist"], "requireExitZero": true },
        "desc": "재부팅 전에 fstab 항목이 실제로 유효한지 확인합니다. findmnt --verify 는 존재하지 않는 장치/경로를 미리 잡아줍니다.",
        "warn": "⚠ 여기서 오류가 나면 재부팅 시 부팅이 emergency mode 로 빠질 수 있습니다. 반드시 수정한 뒤 다음 단계(재부팅)로 넘어가세요."
      },
      {
        "title": "재부팅",
        "command": "sudo reboot",
        "warn": "재부팅하면 SSH 세션이 끊깁니다. 검증 실행은 여기서 '실행 오류 — 연결 끊김'으로 멈추며, 부팅이 끝나 자동 재연결된 뒤 다음 단계를 개별 실행하세요.",
        "desc": "재부팅 후 자동 마운트 여부를 확인합니다."
      },
      {
        "title": "마운트 유지 확인",
        "command": "df -h",
        "check": { "requireExitZero": true, "passContains": ["/mnt/data"] },
        "desc": "/mnt/data 항목이 표시되면 재부팅 후에도 자동 마운트가 정상적으로 동작하는 것입니다."
      }
    ]
  },
  {
    "id": "scn-disk-no-partition",
    "solution": "OpenStack",
    "title": "[스토리지] 디스크 마운트 및 데이터 확인 (빈 볼륨인 경우)",
    "summary": "파티션이 없는 빈 볼륨에 파일시스템을 생성하고 마운트한 뒤 재부팅 후에도 자동 마운트 되도록 /etc/fstab에 등록합니다.",
    "steps": [
      {
        "title": "인스턴스 생성",
        "command": "",
        "desc": "LNB 영역에서 컴퓨트 > 인스턴스로 이동해 인스턴스를 생성하세요."
      },
      {
        "title": "인스턴스 터미널 접속",
        "command": "",
        "desc": "생성된 인스턴스 터미널에 SSH 또는 대시보드 콘솔로 접속하세요."
      },
      {
        "title": "볼륨 확인",
        "command": "lsblk",
        "desc": "연결된 볼륨을 확인합니다. 파티션 없이 디스크 장치 자체만 표시되는 항목을 확인하세요. (예: vdb — 하위 파티션 없음)"
      },
      {
        "title": "파일시스템 생성",
        "command": "sudo mkfs.ext4 /dev/<DISK>",
        "expect": [{ "match": "Proceed anyway", "send": "y" }],
        "warn": "지정한 장치의 데이터가 모두 지워집니다. 앞 단계 lsblk 출력에서 장치명이 맞는지 다시 확인하세요.",
        "check": { "requireExitZero": true },
        "desc": "빈 볼륨에 ext4 파일시스템을 생성합니다. <DISK>에는 장치명을 입력하세요. (예: vdb)",
        "note": "⚠ 해당 볼륨의 기존 데이터가 모두 삭제됩니다. 데이터를 보존해야 한다면 '파티션 있는 경우' 시나리오를 이용하세요."
      },
      {
        "title": "파일시스템 생성 확인",
        "command": "sudo blkid /dev/<DISK>; lsblk -f /dev/<DISK>",
        "check": { "passContains": ["ext4"], "requireExitZero": true },
        "desc": "TYPE=\"ext4\" 와 UUID 가 표시되는지 확인합니다. 다음 단계 fstab 등록에 이 UUID 를 사용합니다.",
        "note": "출력이 비어 있으면 포맷이 적용되지 않은 것입니다. 장치명을 다시 확인하세요."
      },
      {
        "title": "마운트 폴더 생성",
        "command": "sudo mkdir -p /mnt/data",
        "check": { "requireExitZero": true },
        "undo": "sudo rmdir /mnt/data",
        "desc": "디스크를 연결할 마운트 포인트를 생성합니다."
      },
      {
        "title": "마운트 폴더 생성 확인",
        "command": "ls -ld /mnt/data",
        "check": { "passContains": ["/mnt/data"], "requireExitZero": true },
        "desc": "디렉토리가 실제로 만들어졌는지 확인합니다."
      },
      {
        "title": "디스크 마운트",
        "check": {"requireExitZero":true},
        "command": "sudo mount /dev/<DISK> /mnt/data",
        "undo": "sudo umount /mnt/data",
        "desc": "볼륨을 마운트 포인트에 연결합니다."
      },
      {
        "title": "마운트 확인",
        "command": "df -h /mnt/data",
        "check": { "requireExitZero": true, "passContains": ["/mnt/data"] },
        "desc": "용량이 표시되면 정상적으로 마운트된 것입니다.",
        "note": "마운트되지 않았으면 df 는 그 경로를 품은 파일시스템(대개 /)을 대신 보여 줍니다 — 출력에 /mnt/data 가 없으면 마운트가 안 된 것입니다."
      },
      {
        "title": "데이터 쓰기 및 보존 확인 (공통 적용 구간)",
        "command": "",
        "desc": "마운트된 경로에 테스트 데이터를 기록하고 용량 변화를 확인합니다.",
        "info": "아래 시나리오에서 공통으로 활용 가능한 구간입니다.\n• 인스턴스 스냅샷 / 볼륨 스냅샷으로 생성된 인스턴스 데이터 보존 확인\n• 볼륨 백업으로 복원된 볼륨 데이터 보존 확인\n• 인스턴스 복제 및 증분 백업 복원 데이터 보존 확인"
      },
      {
        "title": "테스트 데이터 쓰기 (dd)",
        "check": {"passContains":["records out"],"requireExitZero":true},
        "command": "sudo dd if=/dev/zero of=/mnt/data/testfile bs=10k count=1000",
        "undo": "sudo rm -f /mnt/data/testfile",
        "desc": "마운트된 경로에 10MB(10k × 1000)의 빈 데이터 파일을 생성합니다. 용량을 늘리려면 count 값을 조정하세요. (count=10000 → 100MB)"
      },
      {
        "title": "용량 변화 확인",
        "command": "df -h /mnt/data",
        "desc": "데이터 쓰기 전후의 사용 용량을 비교합니다. Used 수치가 늘었으면 데이터가 정상적으로 기록된 것입니다."
      },
      {
        "title": "파일 및 디렉토리 상태 확인",
        "command": "sudo du -sh /mnt/data && ls -lh /mnt/data",
        "desc": "디렉토리 총 사용량과 내부 파일 목록 및 크기를 확인합니다."
      },
      {
        "title": "UUID 확인",
        "check": {"passContains":["UUID="]},
        "command": "sudo blkid /dev/<DISK>",
        "capture": [{ "name": "UUID", "regex": "\\bUUID=\"([^\"]+)\"" }],
        "desc": "fstab 등록에 사용할 볼륨의 UUID를 확인합니다. 여기서 뽑은 값이 다음 단계의 <UUID>에 자동으로 들어갑니다.",
        "note": "정규식이 PARTUUID가 아니라 파일시스템 UUID를 잡습니다. 둘을 바꿔 쓰면 다음 부팅에서 emergency mode로 빠집니다."
      },
      {
        "title": "fstab 자동 마운트 등록",
        "check": {"passContains":["/mnt/data"],"requireExitZero":true},
        "command": "echo 'UUID=<UUID> /mnt/data ext4 defaults 0 2' | sudo tee -a /etc/fstab",
        "undo": "sudo cp -a /etc/fstab /etc/fstab.qterm.bak && sudo sed -i '/UUID=<UUID>/d' /etc/fstab && echo '--- 되돌린 뒤 /etc/fstab ---' && cat /etc/fstab",
        "warn": "fstab 을 잘못 쓰면 다음 부팅에서 emergency mode 로 빠집니다. 다음 단계의 findmnt --verify 로 반드시 검증한 뒤 재부팅하세요.",
        "desc": "재부팅 후에도 자동 마운트 되도록 /etc/fstab에 등록합니다. <UUID>는 앞 단계(blkid)의 출력에서 자동으로 채워집니다.",
        "note": "원복하면 이 UUID 가 들어간 줄을 /etc/fstab 에서 지웁니다.\n지우기 전 원본을 /etc/fstab.qterm.bak 으로 복사해 두므로,\n같은 UUID 를 쓰던 기존 줄이 있었다면 백업에서 되살리세요."
      },
      {
        "title": "fstab 문법 검사 및 재마운트",
        "command": "sudo mount -a",
        "check": { "requireExitZero": true, "failContains": ["can't find", "unknown filesystem", "wrong fs type", "no such"] },
        "desc": "fstab 설정의 문법 오류를 검사하고 전체 항목을 다시 마운트합니다.",
        "note": "⚠ 오류가 나면 fstab 항목이 잘못된 것입니다. 재부팅 전에 반드시 수정하세요."
      },
      {
        "title": "fstab 항목 검증 및 마운트 확인",
        "command": "sudo findmnt --verify --verbose; findmnt /mnt/data; df -h /mnt/data",
        "check": { "passContains": ["/mnt/data"], "failContains": ["unreachable", "not exist"], "requireExitZero": true },
        "desc": "재부팅 전에 fstab 항목이 실제로 유효한지 확인합니다. findmnt --verify 는 존재하지 않는 장치/경로를 미리 잡아줍니다.",
        "warn": "⚠ 여기서 오류가 나면 재부팅 시 부팅이 emergency mode 로 빠질 수 있습니다. 반드시 수정한 뒤 다음 단계(재부팅)로 넘어가세요."
      },
      {
        "title": "재부팅",
        "command": "sudo reboot",
        "warn": "재부팅하면 SSH 세션이 끊깁니다. 검증 실행은 여기서 '실행 오류 — 연결 끊김'으로 멈추며, 부팅이 끝나 자동 재연결된 뒤 다음 단계를 개별 실행하세요.",
        "desc": "재부팅 후 자동 마운트 여부를 확인합니다."
      },
      {
        "title": "마운트 유지 확인",
        "command": "df -h",
        "check": { "requireExitZero": true, "passContains": ["/mnt/data"] },
        "desc": "/mnt/data 항목이 표시되면 재부팅 후에도 자동 마운트가 정상적으로 동작하는 것입니다."
      }
    ]
  },
  {
    "id": "scn2",
    "solution": "OpenStack",
    "title": "[스토리지] 마운트 해제 및 fstab 정리",
    "summary": "디스크 마운트를 해제하고, fstab 등록을 제거해 영구적으로 분리합니다.",
    "steps": [
      {
        "title": "사용 중인 프로세스 확인",
        "command": "sudo lsof /mnt/data 2>/dev/null || sudo fuser -vm /mnt/data 2>&1 || echo '사용 중인 프로세스 없음 (또는 lsof/fuser 미설치)'",
        "desc": "해당 경로를 사용 중인 프로세스가 있으면 마운트 해제가 실패합니다. 결과가 있으면 종료 후 진행하세요."
      },
      {
        "title": "마운트 해제",
        "check": {"requireExitZero":true},
        "command": "sudo umount /mnt/data",
        "desc": "디스크 마운트를 해제합니다.",
        "note": "\"target is busy\" 오류 시 1단계로 돌아가 점유 프로세스를 정리하세요."
      },
      {
        "title": "해제 확인",
        "check": {"failContains":["/mnt/data"]},
        "command": "lsblk -f",
        "desc": "/mnt/data 마운트 지점이 사라졌는지 확인합니다."
      },
      {
        "title": "fstab 등록 제거",
        "command": "sudo vi /etc/fstab",
        "needsInput": true,
        "warn": "실행 시 vi 편집기가 열립니다. i(입력 모드)로 수정 → ESC → :wq! 로 저장·종료한 뒤 다음 단계를 진행하세요. fstab 오작성 시 부팅 실패에 주의하세요.",
        "desc": "영구적으로 분리하려면 fstab 에서 해당 디스크 줄을 삭제합니다. 안 지우면 재부팅 시 다시 마운트를 시도합니다.",
        "info": "vi 편집기 사용법: i → 입력 모드 시작 → 수정 → ESC → :wq! Enter (저장 후 종료) | 저장 없이 나가려면 :q! Enter",
        "note": "상단 [설정파일] 버튼으로 편집하는 것이 더 편하고 안전합니다."
      },
      {
        "title": "fstab 정리 결과 검증",
        "command": "cat /etc/fstab; sudo findmnt --verify --verbose",
        "check": { "failContains": ["unreachable", "not exist", "parse error"], "requireExitZero": true },
        "desc": "제거한 항목이 실제로 빠졌는지 확인하고, 남은 fstab 항목이 모두 유효한지 검사합니다.",
        "warn": "⚠ 이 단계를 건너뛰면 다음 재부팅 때 없는 장치를 마운트하려다 부팅이 emergency mode 로 빠질 수 있습니다."
      },
      {
        "title": "재마운트 시험",
        "command": "sudo mount -a && echo FSTAB_OK",
        "check": { "passContains": ["FSTAB_OK"], "requireExitZero": true },
        "desc": "정리된 fstab 으로 전체 재마운트를 시험합니다. 오류 없이 FSTAB_OK 가 출력되면 재부팅해도 안전합니다."
      }
    ]
  },
  {
    "id": "scn3",
    "solution": "OpenStack",
    "title": "[스토리지] LVM 구성 동작 확인",
    "summary": "PV/VG/LV 를 생성해 마운트한 뒤, 디스크를 추가해 무중단으로 용량을 확장하고 파일시스템을 온라인 리사이즈합니다.",
    "steps": [
      {
        "title": "도구 설치 (필요 시)",
        "command": `${APT} update && ${APT} install -y lvm2 xfsprogs`,
        "onFailure": "retry",
        "onFailureCommand": APT_FIX,
        "onFailureDesc": APT_FIX_DESC,
        "check": { "requireExitZero": true, "failContains": ["Unable to locate package", "has no installation candidate"] },
        "desc": "LVM 관리 도구를 설치합니다(대개 기본 설치되어 있음).",
        "note": "RHEL/CentOS 계열은 `sudo dnf install -y lvm2`"
      },
      {
        "title": "디스크 인식 확인",
        "command": "lsblk",
        "desc": "LVM 으로 구성할 새 디스크(vdc 등)가 인식됐는지 확인합니다."
      },
      {
        "title": "물리 볼륨(PV) 생성",
        "command": "sudo pvcreate /dev/<DISK>",
        "undo": "sudo pvremove -y /dev/<DISK>",
        "expect": [
          { "match": "Wipe it", "send": "y" },
          { "match": "Really INITIALIZE", "send": "y" }
        ],
        "check": { "requireExitZero": true },
        "desc": "디스크를 LVM 물리 볼륨으로 초기화합니다.",
        "note": "⚠️ 해당 디스크의 기존 데이터가 삭제됩니다. 이전 검증에서 만든 파일시스템이 남아 있으면 pvcreate 가 \"Wipe it? [y/n]\" 을 묻는데, 여기서 자동으로 y 를 보냅니다.",
        "warn": "이 단계부터는 디스크 구조를 바꿉니다. 검증이 끝나면 우측 상단 [원복 실행] 이 lvremove → vgremove → pvremove 순서로 되돌립니다."
      },
      {
        "title": "PV 생성 확인",
        "command": "sudo pvs; sudo pvdisplay /dev/<DISK>",
        "check": { "passContains": ["/dev/"], "requireExitZero": true },
        "desc": "물리 볼륨 목록에 방금 만든 디스크가 보이는지 확인합니다. PSize(전체 크기)와 PFree(여유)가 정상 표기돼야 합니다."
      },
      {
        "title": "볼륨 그룹(VG) 생성",
        "command": "sudo vgcreate data_vg /dev/<DISK>",
        "undo": "sudo vgremove -y data_vg",
        "check": { "requireExitZero": true },
        "desc": "PV 들을 묶는 볼륨 그룹 data_vg 를 만듭니다."
      },
      {
        "title": "VG 생성 확인",
        "command": "sudo vgs; sudo vgdisplay data_vg",
        "check": { "passContains": ["data_vg"], "requireExitZero": true },
        "desc": "볼륨 그룹 data_vg 가 만들어졌는지, 용량(VSize/VFree)이 기대한 값인지 확인합니다."
      },
      {
        "title": "논리 볼륨(LV) 생성",
        "command": "sudo lvcreate -l 100%FREE -n data_lv data_vg",
        "undo": "sudo umount /mnt/data 2>/dev/null; sudo lvremove -y data_vg/data_lv",
        "check": { "requireExitZero": true },
        "desc": "VG 의 남은 공간 전부로 논리 볼륨 data_lv 를 만듭니다."
      },
      {
        "title": "LV 생성 확인",
        "command": "sudo lvs; lsblk /dev/data_vg/data_lv",
        "check": { "passContains": ["data_lv"], "requireExitZero": true },
        "desc": "논리 볼륨 data_lv 와 크기(LSize)를 확인합니다. 이 값이 다음 단계 확장 전 기준값이 됩니다."
      },
      {
        "title": "파일시스템 생성",
        "command": "sudo mkfs.xfs /dev/data_vg/data_lv",
        "warn": "방금 만든 논리 볼륨을 포맷합니다. 기존 데이터가 있는 LV 를 지정하지 않았는지 확인하세요.",
        "check": { "requireExitZero": true },
        "desc": "LV 에 xfs 파일시스템을 만듭니다. (ext4 를 쓰려면 mkfs.ext4)"
      },
      {
        "title": "파일시스템 생성 확인",
        "command": "sudo blkid /dev/data_vg/data_lv; lsblk -f /dev/data_vg/data_lv",
        "check": { "passContains": ["xfs"], "requireExitZero": true },
        "desc": "TYPE=\"xfs\" 와 UUID 가 보이는지 확인합니다. 비어 있으면 포맷이 실패한 것입니다."
      },
      {
        "title": "마운트",
        "command": "sudo mkdir -p /mnt/data && sudo mount /dev/data_vg/data_lv /mnt/data",
        "check": { "requireExitZero": true },
        "undo": "sudo umount /mnt/data 2>/dev/null; sudo rmdir /mnt/data",
        "desc": "마운트 디렉토리를 만들고 LV 를 마운트합니다."
      },
      {
        "title": "마운트 및 용량 확인 (확장 전 기준값)",
        "command": "findmnt /mnt/data; df -h /mnt/data",
        "check": { "passContains": ["/mnt/data"], "requireExitZero": true },
        "desc": "마운트 여부와 현재 용량을 확인합니다. 여기서 본 Size 값이 아래 확장 단계의 비교 기준입니다.",
        "note": "확장 전후 df -h 의 Size 가 달라지는 것이 이 시나리오의 최종 확인 포인트입니다."
      },
      {
        "title": "(확장) VG 에 디스크 추가",
        "command": "sudo vgextend data_vg /dev/<NEW_DISK>",
        "expect": [
          { "match": "Wipe it", "send": "y" },
          { "match": "Really INITIALIZE", "send": "y" }
        ],
        "note": "원복은 VG · LV · PV(첫 디스크)까지 되돌립니다.\n확장용 디스크는 VG 제거 뒤에도 PV 표식이 남으니,\n완전히 비우려면 sudo pvremove -y /dev/<NEW_DISK> 를 직접 실행하세요.",
        "check": { "requireExitZero": true },
        "desc": "용량이 부족해지면 새 디스크를 VG 에 추가합니다.\n<NEW_DISK> 에는 아직 아무 데도 쓰지 않은 빈 디스크(예: vdc)를 적으세요.\npvcreate 를 따로 할 필요 없이 vgextend 가 PV 초기화까지 함께 합니다.",
        "warn": "지정한 디스크의 기존 데이터는 지워집니다. 이전에 쓰던 흔적이 남아 있으면 3번과 같은 \"Wipe it? [y/n]\" 을 묻는데, 여기서도 자동으로 y 를 보냅니다."
      },
      {
        "title": "(확장) VG 확장 확인",
        "command": "sudo vgs data_vg; sudo pvs",
        "check": { "passContains": ["data_vg"], "requireExitZero": true },
        "desc": "VFree(여유 공간)가 추가한 디스크 크기만큼 늘었는지 확인합니다. 늘지 않았으면 vgextend 가 반영되지 않은 것입니다."
      },
      {
        "title": "(확장) LV 용량 확장",
        "command": "sudo lvextend -l +100%FREE /dev/data_vg/data_lv",
        "check": { "requireExitZero": true },
        "desc": "VG 의 늘어난 공간만큼 LV 를 확장합니다(무중단)."
      },
      {
        "title": "(확장) LV 확장 확인",
        "command": "sudo lvs data_vg/data_lv",
        "check": { "passContains": ["data_lv"], "requireExitZero": true },
        "desc": "LSize 가 커졌는지 확인합니다. 이 시점에는 아직 파일시스템 크기(df)는 그대로인 것이 정상입니다.",
        "info": "LV 는 커졌지만 파일시스템은 아직 예전 크기입니다. 다음 단계의 온라인 리사이즈까지 마쳐야 실제 사용 가능 용량이 늘어납니다."
      },
      {
        "title": "(확장) 파일시스템 온라인 리사이즈",
        "command": "sudo xfs_growfs /mnt/data",
        "check": { "requireExitZero": true },
        "desc": "마운트된 상태에서 파일시스템을 확장합니다. xfs 는 xfs_growfs, ext4 는 resize2fs 사용."
      },
      {
        "title": "(확장) 최종 용량 반영 확인",
        "command": "df -h /mnt/data; sudo lvs data_vg/data_lv; findmnt /mnt/data",
        "check": { "passContains": ["/mnt/data"], "requireExitZero": true },
        "desc": "이 시나리오의 최종 확인 지점입니다. df -h 의 Size 가 확장 전보다 커졌고, LSize 와 비슷한 값이어야 성공입니다.",
        "note": "df 값이 그대로면 파일시스템 리사이즈가 반영되지 않은 것입니다. xfs 가 아닌 ext4 라면 resize2fs /dev/data_vg/data_lv 를 사용하세요.",
        "info": "마운트가 유지된 채로 용량이 늘어났다면 무중단 확장이 정상 동작한 것입니다."
      }
    ]
  },

  {
    "id": "scn-volume-qos",
    "solution": "OpenStack",
    "title": "[스토리지] 볼륨 타입 디스크 QoS 적용 확인",
    "summary": "볼륨 타입에 QoS Specs를 연결하고 인스턴스 디스크에 IOPS·대역폭 제한이 실제로 적용되는지 fio로 검증합니다.",
    "steps": [
      {
        "title": "볼륨 타입 생성",
        "command": "",
        "desc": "LNB 영역에서 스토리지 > 볼륨 타입으로 이동해 새 볼륨 타입을 생성합니다."
      },
      {
        "title": "QoS Specs 생성",
        "command": "",
        "desc": "스토리지 > QoS Specs에서 QoS를 생성하고 아래 4개의 키/값을 추가합니다.",
        "note": "키(Key) / 값(Value) 형식으로 입력하세요:\n  key: write_iops_sec   value: 50\n  key: read_iops_sec    value: 50\n  key: read_bytes_sec   value: 10485760\n  key: write_bytes_sec  value: 10485760"
      },
      {
        "title": "QoS를 볼륨 타입에 연결",
        "command": "",
        "desc": "QoS Specs 목록에서 생성한 QoS를 선택 후 '볼륨 타입 연결(Associate)'을 클릭해 앞 단계에서 만든 볼륨 타입과 연결합니다."
      },
      {
        "title": "인스턴스 생성 (볼륨 타입 지정)",
        "command": "",
        "desc": "컴퓨트 > 인스턴스 생성 > Step2 소스 설정에서 볼륨 타입을 앞 단계에서 생성한 QoS 적용 볼륨 타입으로 지정 후 인스턴스를 생성합니다.",
        "note": "볼륨 타입은 인스턴스 생성 시점에만 지정 가능합니다. 기존 인스턴스에 소급 적용은 불가합니다."
      },
      {
        "title": "인스턴스 별칭 확인",
        "target": "하이퍼바이저",
        "command": "echo '별칭  |  인스턴스 이름  |  상태'; sudo virsh list --all | tail -n +3 | while read -r id d state rest; do [ -n \"$d\" ] || continue; n=$(sudo virsh dumpxml \"$d\" 2>/dev/null | grep -o 'nova:name>[^<]*' | head -1 | cut -c11-); echo \"$d  |  ${n:-(이름 없음)}  |  $state $rest\"; done | tee /tmp/qterm-doms.txt; [ -s /tmp/qterm-doms.txt ] || echo '주의 — 이 호스트에 libvirt 도메인이 없습니다 (컴퓨트 노드가 맞는지 확인하세요)'; rm -f /tmp/qterm-doms.txt",
        "check": { "failContains": ["주의 —"] },
        "desc": "하이퍼바이저 호스트에서 실행합니다. 별칭(instance-xxxx) 옆에 포털의 인스턴스 이름을 함께 보여주므로, 어느 것이 내 인스턴스인지 바로 가릅니다.",
        "info": "virsh 는 OpenStack UUID 가 아니라 libvirt 도메인 별칭으로 조회합니다.\n별칭만 늘어놓으면 어느 것이 내 것인지 알 수 없어서, nova 가 도메인 XML 에 심어 둔 이름을 함께 읽어 붙였습니다.\n\n찾는 이름이 안 보이면 그 인스턴스는 다른 컴퓨트 노드에 있습니다 — 위 역할별 대상에서 그 노드를 고르세요."
      },
      {
        "title": "QoS 적용 여부 확인 (인스턴스 배치 호스트)",
        "target": "하이퍼바이저",
        "command": "A='<instance_alias>'; X=/tmp/qterm-dom.xml; D=/tmp/qterm-disk.txt; if ! command -v virsh > /dev/null; then echo '주의 — 이 서버에 virsh 가 없습니다 (컴퓨트 노드가 아닙니다)'; elif sudo virsh dumpxml \"$A\" > $X 2>/dev/null; then echo \"[대상] $A  —  $(grep -o 'nova:name>[^<]*' $X | head -1 | cut -c11-)\"; echo '[루트 디스크]'; awk 'index($0,\"<disk \")>0{b=1} b{print} index($0,\"</disk>\")>0{b=0}' $X > $D; grep -E '<disk |<source |<target dev' $D | head -14; R=$(grep \"device='disk'\" $D | head -1); case \"$R\" in *\"type='file'\"*) echo '  -> 루트가 Ephemeral(로컬 파일)입니다 — 볼륨 타입 QoS 대상이 아닙니다. [컴퓨트] 인스턴스 유형 디스크 QoS 시나리오로 확인하세요';; *) echo '  -> 루트가 볼륨입니다 — 볼륨 타입 QoS 대상이 맞습니다';; esac; echo '[iotune]'; if grep -q iotune $X; then grep -A 8 iotune $X | grep -E 'iotune|_sec'; else echo '주의 — iotune 블록이 없습니다 (QoS 가 이 인스턴스에 걸려 있지 않습니다)'; echo '  · QoS 를 볼륨 타입에 연결(Associate)했는지 확인하세요'; echo '  · 연결하기 전에 만든 볼륨에는 적용되지 않습니다 — 볼륨을 다시 만들어 인스턴스를 생성하세요'; echo '  · QoS Specs 의 consumer 가 front-end(또는 both)여야 여기 iotune 으로 보입니다. back-end 면 스토리지가 직접 거는 것이라 도메인 XML 에는 안 나옵니다'; fi; else echo \"주의 — 이 호스트에 $A 도메인이 없습니다 (인스턴스가 다른 컴퓨트 노드에 있을 수 있습니다)\"; fi; rm -f $X $D",
        "check": { "passContains": ["iotune"], "passRegex": "(read|write)_(iops|bytes)_sec", "failContains": ["주의 —"] },
        "onFailure": "continue",
        "desc": "앞 단계에서 확인한 별칭으로 실행합니다. 인스턴스가 배치된 컴퓨트 호스트에서 실행해야 합니다.\n루트가 볼륨이 맞는지 먼저 단정해 주고, iotune 이 없으면 왜 없는지(볼륨 타입 미연결 · consumer 가 back-end · 연결 전에 만든 볼륨)도 짚어 줍니다.",
        "info": "정상 적용 시 iotune 블록에 설정값이 나옵니다:\n  <read_bytes_sec>10485760</read_bytes_sec>\n  <write_bytes_sec>10485760</write_bytes_sec>\n  <read_iops_sec>50</read_iops_sec>\n  <write_iops_sec>50</write_iops_sec>\n\n여기서 실패해도 검증은 멈추지 않습니다 — 제한이 안 걸린 fio 숫자도 증거입니다."
      },
      {
        "title": "인스턴스 터미널 접속",
        "command": "",
        "desc": "생성된 인스턴스에 SSH 또는 대시보드 콘솔로 접속합니다."
      },
      {
        "title": "디스크 확인",
        "command": "lsblk",
        "desc": "루트 디스크(vda)가 정상 연결됐는지 확인합니다. 이후 단계에서 이 디스크에 대해 QoS 제한을 측정합니다."
      },
      {
        "title": "패키지 목록 업데이트",
        "command": `${APT} update`,
        "check": { "failContains": ["Err:", "Failed to fetch", "Could not resolve", "Temporary failure resolving"], "passContains": ["Reading package lists"] },
        "desc": "fio 설치 전 패키지 목록을 최신화합니다.",
        "note": "업데이트가 실패하면 DNS 설정을 확인하세요. nameserver가 없으면 외부 패키지 서버에 접근할 수 없습니다.\n확인: cat /etc/resolv.conf\n미설정 시: netplan 또는 /etc/resolv.conf에 nameserver를 추가 후 적용하세요."
      },
      {
        "title": "fio 및 libaio 설치",
        "command": `${APT} install -y fio libaio1t64 || ${APT} install -y fio libaio1`,
        "onFailure": "retry",
        "onFailureCommand": APT_FIX,
        "onFailureDesc": APT_FIX_DESC,
        "check": { "requireExitZero": true, "failContains": ["Unable to locate package", "has no installation candidate"] },
        "desc": "I/O 벤치마크 도구 fio와 비동기 I/O 라이브러리(libaio)를 함께 설치합니다. libaio가 없으면 fio가 동기 모드로 폴백되어 IOPS를 제대로 측정할 수 없습니다.",
        "note": "Ubuntu 24.04+는 libaio1t64, 22.04 이하는 libaio1 패키지명을 사용합니다. || 로 두 버전을 순서대로 시도합니다.\nRHEL/CentOS 계열: sudo dnf install -y fio libaio"
      },
      {
        "title": "쓰기 IOPS 제한 확인",
        "command": "sudo fio --name=qos-randwrite --rw=randwrite --bs=4k --direct=1 --ioengine=libaio --iodepth=32 --size=100M --runtime=30 --filename=/tmp/fio-test --group_reporting",
        "check": { "passContains": ["Run status group"] },
        "desc": "4k 블록 랜덤 쓰기 30초. IOPS 가 QoS 설정치(50)에 근접하면 정상입니다.\n결과에서 볼 것 — write: 줄의 IOPS=(초당 처리 횟수)와 BW=(대역폭). 아래 lat 은 지연 시간이라 작을수록 좋습니다.",
        "info": "--direct=1 로 OS 캐시를 건너뜁니다.\n--ioengine=libaio --iodepth=32 로 I/O 를 동시에 충분히 보내야 QoS 제한치(50 IOPS)까지 실제로 닿습니다."
      },
      {
        "title": "읽기 IOPS 제한 확인",
        "command": "sudo fio --name=qos-randread --rw=randread --bs=4k --direct=1 --ioengine=libaio --iodepth=32 --size=100M --runtime=30 --filename=/tmp/fio-test --group_reporting",
        "check": { "passContains": ["Run status group"] },
        "desc": "4k 블록 랜덤 읽기 30초. IOPS 가 50 근처로 제한되면 read_iops_sec 이 걸린 것입니다.\n결과에서 볼 것 — read: 줄의 IOPS= 와 BW=. QoS 를 걸었다면 상한 근처에서 멈춰야 정상입니다."
      },
      {
        "title": "쓰기 대역폭 제한 확인",
        "command": "sudo fio --name=qos-write-bw --rw=write --bs=1m --direct=1 --ioengine=libaio --iodepth=32 --size=100M --runtime=30 --filename=/tmp/fio-test --group_reporting",
        "check": { "passContains": ["Run status group"] },
        "desc": "1M 블록 순차 쓰기 30초. BW 가 약 10 MiB/s 로 제한되면 write_bytes_sec 이 걸린 것입니다.\n결과에서 볼 것 — write: 줄의 BW= 값. 큰 블록이라 IOPS 보다 BW 가 핵심입니다."
      },
      {
        "title": "읽기 대역폭 제한 확인",
        "command": "sudo fio --name=qos-read-bw --rw=read --bs=1m --direct=1 --ioengine=libaio --iodepth=32 --size=100M --runtime=30 --filename=/tmp/fio-test --group_reporting",
        "check": { "passContains": ["Run status group"] },
        "desc": "1M 블록 순차 읽기 30초. BW 가 약 10 MiB/s 로 제한되면 read_bytes_sec 이 걸린 것입니다.\n결과에서 볼 것 — read: 줄의 BW= 값. 큰 블록이라 IOPS 보다 BW 가 핵심입니다."
      },
      {
        "title": "테스트 파일 정리",
        "command": "sudo rm -f /tmp/fio-test",
        "desc": "fio가 생성한 테스트 파일을 삭제합니다."
      }
    ]
  },

  {
    "id": "scn-gpu-driver",
    "solution": "OpenStack",
    "title": "[GPU] 드라이버 설치 및 동작 확인",
    "summary": "NVIDIA GPU가 연결된 인스턴스에 드라이버를 설치하고 nvidia-smi로 정상 동작을 확인합니다. (Ubuntu 기준)",
    "steps": [
      {
        "title": "인스턴스 접속",
        "command": "",
        "desc": "GPU가 할당된 인스턴스 터미널에 SSH 또는 대시보드 콘솔로 접속하세요."
      },
      {
        "title": "GPU 인식 확인",
        "check": {"passRegex":"NVIDIA"},
        "command": "lspci | grep -i nvidia",
        "desc": "PCI 버스에 NVIDIA GPU가 인식됐는지 확인합니다. 출력이 없으면 GPU 패스스루(PCI Passthrough) 설정을 확인하세요."
      },
      {
        "title": "패키지 업데이트",
        "command": `${APT} update`,
        "check": { "failContains": ["Err:", "Failed to fetch", "Could not resolve", "Temporary failure resolving"], "passContains": ["Reading package lists"] },
        "desc": "패키지 목록을 최신화합니다.",
        "note": "업데이트가 실패하면 DNS 설정을 확인하세요. nameserver가 없으면 외부 패키지 서버에 접근할 수 없습니다.\n확인: cat /etc/resolv.conf\n미설정 시: netplan 또는 /etc/resolv.conf에 nameserver를 추가 후 적용하세요."
      },
      {
        "title": "커널 헤더 및 빌드 도구 설치",
        "command": `${APT} install -y build-essential dkms linux-headers-$(uname -r)`,
        "onFailure": "retry",
        "onFailureCommand": APT_FIX,
        "onFailureDesc": APT_FIX_DESC,
        "check": { "requireExitZero": true, "failContains": ["Unable to locate package", "has no installation candidate"] },
        "desc": "드라이버 컴파일에 필요한 커널 헤더와 빌드 도구를 설치합니다."
      },
      {
        "title": "권장 드라이버 버전 확인",
        "check": {"passContains":["recommended"]},
        "command": "ubuntu-drivers devices",
        "desc": "시스템 GPU에 맞는 권장 NVIDIA 드라이버 버전을 확인합니다.",
        "note": "ubuntu-drivers 명령이 없으면 sudo apt install -y ubuntu-drivers-common 먼저 실행하세요."
      },
      {
        "title": "드라이버 설치",
        "check": {"requireExitZero":true},
        "command": "sudo ubuntu-drivers install",
        "desc": "권장 드라이버를 자동으로 설치합니다. 특정 버전을 지정하려면 sudo apt install -y nvidia-driver-<버전> 형식으로 사용하세요."
      },
      {
        "title": "재부팅",
        "command": "sudo reboot",
        "warn": "재부팅하면 SSH 세션이 끊깁니다. 검증 실행은 여기서 '실행 오류 — 연결 끊김'으로 멈추며, 부팅이 끝나 자동 재연결된 뒤 다음 단계를 개별 실행하세요.",
        "desc": "드라이버 로드를 위해 재부팅합니다."
      },
      {
        "title": "드라이버 동작 확인",
        "check": {"passContains":["Driver Version"]},
        "command": "nvidia-smi",
        "desc": "GPU 상태, 드라이버 버전, CUDA 버전, 메모리 사용량을 확인합니다. 출력이 정상이면 드라이버 설치가 완료된 것입니다."
      },
      {
        "title": "GPU 상세 정보 조회",
        "check": {"passContains":["driver_version"]},
        "command": "nvidia-smi --query-gpu=name,driver_version,memory.total,temperature.gpu,compute_mode --format=csv",
        "desc": "GPU 이름, 드라이버 버전, 전체 메모리, 온도, 컴퓨트 모드를 CSV 형식으로 조회합니다."
      }
    ]
  },
  {
    "id": "scn-gpu-mig",
    "solution": "OpenStack",
    "title": "[GPU] MIG 구성 및 조회 동작 확인",
    "summary": "NVIDIA A100/H100 GPU의 MIG(Multi-Instance GPU) 모드를 활성화하고 인스턴스를 생성·조회합니다.",
    "steps": [
      {
        "title": "MIG 지원 여부 확인",
        "command": "nvidia-smi --query-gpu=name,mig.mode.current --format=csv,noheader",
        "check": { "requireExitZero": true, "failContains": ["N/A"] },
        "desc": "GPU 이름과 현재 MIG 모드 상태를 조회합니다. MIG는 NVIDIA A100, H100 등 Ampere 아키텍처 이상에서 지원됩니다.",
        "note": "Disabled 상태이면 다음 단계에서 활성화합니다. N/A로 출력되면 해당 GPU는 MIG를 지원하지 않습니다."
      },
      {
        "title": "MIG 모드 활성화",
        "command": "sudo nvidia-smi -mig 1",
        "warn": "MIG 모드 전환은 재부팅이 필요하고, 해당 GPU 를 쓰는 워크로드가 있으면 중단됩니다.",
        "desc": "GPU에 MIG 모드를 활성화합니다. 적용을 위해 이후 재부팅이 필요합니다."
      },
      {
        "title": "재부팅",
        "command": "sudo reboot",
        "warn": "재부팅하면 SSH 세션이 끊깁니다. 검증 실행은 여기서 '실행 오류 — 연결 끊김'으로 멈추며, 부팅이 끝나 자동 재연결된 뒤 다음 단계를 개별 실행하세요.",
        "desc": "MIG 모드 변경 사항을 적용하기 위해 재부팅합니다."
      },
      {
        "title": "MIG 활성화 확인",
        "check": {"passContains":["Enabled"]},
        "command": "nvidia-smi -q | grep -i \"mig mode\"",
        "desc": "'MIG Mode: Enabled' 출력이 확인되면 MIG 모드가 정상 활성화된 것입니다."
      },
      {
        "title": "GPU 인스턴스 프로파일 조회",
        "command": "nvidia-smi mig -lgip",
        "desc": "생성 가능한 GPU Instance Profile(GIP) 목록을 조회합니다. Profile ID와 슬라이스 구성(메모리, SM 수)을 확인하세요.",
        "note": "A100 80GB 기준 예시: 1g.10gb(ID=19), 2g.20gb(ID=14), 3g.40gb(ID=9), 4g.40gb(ID=5), 7g.80gb(ID=0)"
      },
      {
        "title": "GPU 인스턴스(GI) 생성",
        "check": {"passContains":["Successfully created"]},
        "command": "sudo nvidia-smi mig -cgi <PROFILE_ID> -C",
        "desc": "지정한 프로파일 ID로 GPU 인스턴스를 생성하고 -C 옵션으로 컴퓨트 인스턴스(CI)도 함께 생성합니다. 쉼표로 구분해 여러 개 생성 가능합니다. (예: -cgi 9,9 → 2개 생성)",
        "note": "프로파일 조합은 GPU 전체 슬라이스(7g)를 초과할 수 없습니다."
      },
      {
        "title": "GPU 인스턴스 목록 조회",
        "command": "nvidia-smi mig -lgi",
        "desc": "생성된 GPU 인스턴스(GI)의 ID, 프로파일, 메모리 크기를 확인합니다."
      },
      {
        "title": "컴퓨트 인스턴스 목록 조회",
        "command": "nvidia-smi mig -lci",
        "desc": "각 GPU 인스턴스 내 컴퓨트 인스턴스(CI) 목록과 SM 구성을 확인합니다."
      },
      {
        "title": "전체 MIG 계층 구조 확인",
        "command": "nvidia-smi -L",
        "desc": "GPU → GPU Instance → Compute Instance 전체 계층 구조를 출력합니다. UUID도 함께 확인할 수 있습니다."
      },
      {
        "title": "MIG 인스턴스 삭제 (초기화)",
        "check": {"passContains":["Successfully destroyed"]},
        "command": "sudo nvidia-smi mig -dci && sudo nvidia-smi mig -dgi",
        "desc": "컴퓨트 인스턴스(CI)를 먼저 삭제한 뒤 GPU 인스턴스(GI)를 삭제합니다. 삭제 순서를 반드시 지켜야 합니다."
      },
      {
        "title": "MIG 인스턴스 삭제 확인",
        "command": "nvidia-smi mig -lgi; nvidia-smi mig -lci",
        "check": { "failContains": ["Error", "Failed"] },
        "desc": "GI/CI 목록이 비었는지 확인합니다. 'No MIG-enabled devices found' 또는 빈 목록이면 정상 삭제된 것입니다."
      },
      {
        "title": "MIG 모드 비활성화 (필요 시)",
        "command": "sudo nvidia-smi -mig 0",
        "warn": "MIG 인스턴스를 모두 삭제한 뒤에만 성공합니다. 앞 단계(-dci/-dgi)를 먼저 수행하세요.",
        "desc": "MIG 모드를 비활성화합니다. 적용을 위해 재부팅이 필요합니다.",
        "note": "MIG 인스턴스가 남아있으면 비활성화가 거부됩니다. 먼저 모든 GI/CI를 삭제하세요."
      }
      ,{
        "title": "MIG 모드 비활성화 확인",
        "command": "nvidia-smi --query-gpu=name,mig.mode.current --format=csv,noheader",
        "check": { "passContains": ["Disabled"] },
        "desc": "mig.mode.current 가 Disabled 로 바뀌었는지 확인합니다. 여전히 Enabled 면 재부팅이 필요합니다.",
        "note": "MIG 모드 전환은 재부팅해야 반영되는 경우가 많습니다."
      }
    ]
  },

  // ───────────────────────── 성능 · 부하 ─────────────────────────

  {
    "id": "perf-stress-cpu",
    "solution": "성능 · 부하",
    "title": "[부하] stress-ng — CPU",
    "summary": "부하 전 기준값을 기록하고, CPU에 부하를 준 뒤 실제로 사용률이 올랐는지 수치로 확인합니다.",
    "steps": [
      {
        "title": "부하 전 CPU 사용률 확인",
        "command": "echo \"코어 수: $(nproc)개\"; echo \"모델: $(grep -m1 'model name' /proc/cpuinfo | cut -d: -f2- | sed 's/^ *//')\"; echo; echo '지금 CPU 사용률 (1초 간격 3회):'; vmstat 1 3 | awk 'NR>3{ printf(\"  %d%%\\n\", $13+0) }'",
        "check": { "requireExitZero": true },
        "desc": "결과에서 볼 것 — 맨 아래 'CPU 사용률' 숫자입니다. 보통 아무것도 안 돌면 0~5% 입니다. 이 값이 부하를 준 뒤와 비교할 출발점입니다.",
        "note": "여기서부터 이미 사용률이 높다면 다른 작업이 돌고 있는 것이니, 부하 검증 결과가 부정확해집니다."
      },
      {
        "title": "도구 설치 (필요 시)",
        "command": `${APT} update && ${APT} install -y stress-ng htop`,
        "onFailure": "retry",
        "onFailureCommand": APT_FIX,
        "onFailureDesc": APT_FIX_DESC,
        "check": { "requireExitZero": true, "failContains": ["Unable to locate package", "has no installation candidate"] },
        "desc": "부하 도구 stress-ng 와, 눈으로 볼 때 쓸 htop 설치.",
        "note": "RHEL/CentOS 계열은 `sudo dnf install -y stress-ng htop` (EPEL 필요할 수 있음)"
      },
      {
        "title": "부하 중 실시간 관찰 준비 (선택)",
        "command": "",
        "desc": "부하가 걸리는 동안 눈으로 보려면 다른 터미널 탭에서 htop 을 띄워 두세요. 다음 단계의 부하 명령은 60초 동안 터미널을 점유하므로 같은 세션에서는 동시에 볼 수 없습니다.",
        "note": "수치 확인은 다음 단계에서 vmstat 이 자동으로 기록하므로, 이 단계를 건너뛰어도 검증에는 지장이 없습니다."
      },
      {
        "title": "CPU 부하 발생 (60초)",
        "command": "(vmstat 5 16 > /tmp/qterm-stress.log 2>&1 &); sleep 6; sudo stress-ng --cpu 4 --timeout 60s --metrics-brief",
        "undo": "sudo rm -f /tmp/qterm-stress.log",
        "check": { "requireExitZero": true, "passContains": ["successful run completed"] },
        "desc": "CPU 코어 4개에 60초 부하. 뒤에서 vmstat 이 5초 간격으로 부하 전·중·후를 함께 기록합니다.",
        "note": "부하 전 구간을 남기려고 6초 기다렸다가 시작합니다. 코어 수는 환경에 맞게 --cpu 값을 조절하세요."
      },
      {
        "title": "부하 결과 확인 (전 → 중 → 후)",
        "command": "sleep 16; echo 'CPU 사용률 (5초 간격, 위에서 아래로 시간 순)'; echo; awk 'NR>3{ v=$13+0; n++; if(n==1) first=v; last=v; if(v>mx) mx=v; b=\"\"; for(i=0;i<int(v/5);i++) b=b \"#\"; printf(\"  %3d%%  %s\\n\", v, b) } END{ printf(\"\\n부하 전 %d%%  ->  부하 중 최고 %d%%  ->  부하 후 %d%%\\n판정: CPU %s\\n\", first, mx, last, (mx>=50 ? \"정상\" : \"미달\")) }' /tmp/qterm-stress.log; rm -f /tmp/qterm-stress.log",
        "check": { "passContains": ["판정: CPU 정상"] },
        "desc": "결과에서 볼 것 — 맨 아래 한 줄입니다.\n'부하 중 최고'가 50% 이상이면 부하가 실제로 걸린 것으로 판정합니다.\n위 막대는 시간에 따른 CPU 사용률이라, 올랐다 내려온 모양이 눈으로도 보입니다.",
        "note": "부하 전과 부하 후가 비슷하게 낮고 가운데만 높으면 정상입니다."
      }
    ]
  },
  {
    "id": "perf-stress-mem",
    "solution": "성능 · 부하",
    "title": "[부하] stress-ng — 메모리",
    "summary": "부하 전 여유 메모리를 기록하고, 메모리를 점유시킨 뒤 실제로 줄었다가 회수되는지 확인합니다.",
    "steps": [
      {
        "title": "부하 전 메모리 확인",
        "command": "awk '/MemTotal/{ t=$2 } /MemAvailable/{ a=$2 } END{ printf(\"전체 메모리      %.2f GB\\n지금 쓸 수 있는  %.2f GB\\n\", t/1048576, a/1048576) }' /proc/meminfo; echo; free -h",
        "check": { "requireExitZero": true },
        "desc": "결과에서 볼 것 — '지금 쓸 수 있는' 메모리 숫자입니다. 다음 단계에서 2GB 를 점유시키므로 이 값이 2GB 보다 커야 합니다.",
        "note": "2GB 보다 작으면 다음 단계의 --vm-bytes 값을 낮춰 진행하세요. 그냥 진행하면 다른 프로세스가 강제 종료될 수 있습니다."
      },
      {
        "title": "도구 설치 (필요 시)",
        "command": `${APT} update && ${APT} install -y stress-ng htop`,
        "onFailure": "retry",
        "onFailureCommand": APT_FIX,
        "onFailureDesc": APT_FIX_DESC,
        "check": { "requireExitZero": true, "failContains": ["Unable to locate package", "has no installation candidate"] },
        "desc": "부하 도구 stress-ng 와, 눈으로 볼 때 쓸 htop 설치.",
        "note": "RHEL/CentOS 계열은 `sudo dnf install -y stress-ng htop` (EPEL 필요할 수 있음)"
      },
      {
        "title": "부하 중 실시간 관찰 준비 (선택)",
        "command": "",
        "desc": "부하가 걸리는 동안 눈으로 보려면 다른 터미널 탭에서 htop 또는 watch -n 1 'free -h' 를 띄워 두세요. 다음 단계의 부하 명령은 60초 동안 터미널을 점유합니다.",
        "note": "수치 확인은 다음 단계에서 vmstat 이 자동으로 기록하므로, 이 단계를 건너뛰어도 검증에는 지장이 없습니다."
      },
      {
        "title": "메모리 부하 발생 (60초)",
        "command": "(vmstat 5 16 > /tmp/qterm-stress.log 2>&1 &); sleep 6; sudo stress-ng --vm 2 --vm-bytes 1G --vm-keep --timeout 60s --metrics-brief",
        "undo": "sudo rm -f /tmp/qterm-stress.log",
        "check": { "requireExitZero": true, "passContains": ["successful run completed"] },
        "desc": "가상 메모리 워커 2개 ×1GB(총 2GB)를 60초 동안 점유. 뒤에서 vmstat 이 여유 메모리 변화를 기록합니다.",
        "warn": "여유 메모리보다 큰 값을 주면 OOM Killer 가 다른 프로세스를 죽일 수 있습니다. 앞 단계의 MemAvailable 을 확인하고 --vm-bytes 를 조절하세요."
      },
      {
        "title": "부하 결과 확인 (전 → 중 → 후)",
        "command": "sleep 16; echo '메모리 사용 증가량 (5초 간격, 위에서 아래로 시간 순 · 막대 1칸 = 0.1GB)'; echo; awk 'NR>3{ m=$4/1048576; n++; if(n==1) fm=m; lm=m; if(mn==0 || mn>m) mn=m; d=fm-m; b=\"\"; for(i=0;i<int(d*10);i++) b=b \"#\"; printf(\"  %+6.2f GB  %s\\n\", d, b) } END{ printf(\"\\n쓸 수 있는 메모리   부하 전 %.2fGB  ->  부하 중 최저 %.2fGB  ->  부하 후 %.2fGB\\n점유된 메모리 최대 %.2fGB\\n판정: 메모리 %s\\n\", fm, mn, lm, fm-mn, (fm-mn>=1 ? \"정상\" : \"미달\")) }' /tmp/qterm-stress.log; rm -f /tmp/qterm-stress.log",
        "check": { "passContains": ["판정: 메모리 정상"] },
        "desc": "결과에서 볼 것 — 맨 아래 '판정: 메모리' 한 줄입니다. 점유량이 1GB 이상이면 정상입니다.\n위 막대는 부하 전 대비 얼마나 더 쓰는지라, 부하 구간에서 길어졌다가 끝나면 사라져야 합니다.",
        "note": "'부하 후' 값이 '부하 전'과 비슷하게 돌아왔으면 메모리가 정상 회수된 것입니다. 안 돌아왔다면 누수를 의심할 수 있습니다."
      }
    ]
  },
  {
    "id": "perf-stress-cpumem",
    "solution": "성능 · 부하",
    "title": "[부하] stress-ng — CPU & 메모리",
    "summary": "부하 전 CPU·메모리를 함께 기록하고, 동시에 부하를 준 뒤 두 값이 모두 움직였는지 확인합니다(알람/스케일링 검증).",
    "steps": [
      {
        "title": "부하 전 CPU·메모리 확인",
        "command": "echo \"코어 수: $(nproc)개\"; awk '/MemTotal/{ t=$2 } /MemAvailable/{ a=$2 } END{ printf(\"전체 메모리      %.2f GB\\n지금 쓸 수 있는  %.2f GB\\n\", t/1048576, a/1048576) }' /proc/meminfo; echo; echo '지금 CPU 사용률 (1초 간격 3회):'; vmstat 1 3 | awk 'NR>3{ printf(\"  %d%%\\n\", $13+0) }'",
        "check": { "requireExitZero": true },
        "desc": "결과에서 볼 것 — 'CPU 사용률'과 '지금 쓸 수 있는' 메모리 두 숫자입니다. 부하를 준 뒤 이 둘과 비교합니다. 알람 임계치를 검증한다면 이 값이 출발점입니다.",
        "note": "쓸 수 있는 메모리가 2GB 보다 작으면 다음 단계의 --vm-bytes 값을 낮춰 진행하세요."
      },
      {
        "title": "도구 설치 (필요 시)",
        "command": `${APT} update && ${APT} install -y stress-ng htop`,
        "onFailure": "retry",
        "onFailureCommand": APT_FIX,
        "onFailureDesc": APT_FIX_DESC,
        "check": { "requireExitZero": true, "failContains": ["Unable to locate package", "has no installation candidate"] },
        "desc": "부하 도구 stress-ng 와, 눈으로 볼 때 쓸 htop 설치.",
        "note": "RHEL/CentOS 계열은 `sudo dnf install -y stress-ng htop` (EPEL 필요할 수 있음)"
      },
      {
        "title": "부하 중 실시간 관찰 준비 (선택)",
        "command": "",
        "desc": "부하가 걸리는 동안 눈으로 보려면 다른 터미널 탭에서 htop 을 띄워 두세요. 다음 단계의 부하 명령은 60초 동안 터미널을 점유합니다.",
        "note": "수치 확인은 다음 단계에서 vmstat 이 자동으로 기록하므로, 이 단계를 건너뛰어도 검증에는 지장이 없습니다."
      },
      {
        "title": "CPU+메모리 동시 부하 발생 (60초)",
        "command": "(vmstat 5 16 > /tmp/qterm-stress.log 2>&1 &); sleep 6; sudo stress-ng --cpu 4 --vm 2 --vm-bytes 1G --vm-keep --timeout 60s --metrics-brief",
        "undo": "sudo rm -f /tmp/qterm-stress.log",
        "check": { "requireExitZero": true, "passContains": ["successful run completed"] },
        "desc": "CPU 4코어 + 메모리 2GB 를 60초 동안 동시 부하. 뒤에서 vmstat 이 CPU·메모리 변화를 함께 기록합니다.",
        "warn": "여유 메모리보다 큰 값을 주면 OOM Killer 가 다른 프로세스를 죽일 수 있습니다. 앞 단계의 free 출력을 확인하고 --vm-bytes 를 조절하세요."
      },
      {
        "title": "부하 결과 확인 (전 → 중 → 후)",
        "command": "sleep 16; echo 'CPU 사용률 / 메모리 사용 증가량 (5초 간격, 위에서 아래로 시간 순)'; echo; awk 'NR>3{ c=$13+0; m=$4/1048576; n++; if(n==1){ fc=c; fm=m } lc=c; lm=m; if(c>mx) mx=c; if(mn==0 || mn>m) mn=m; d=fm-m; b=\"\"; for(i=0;i<int(c/5);i++) b=b \"#\"; printf(\"  CPU %3d%%  %-20s  메모리 %+6.2f GB\\n\", c, b, d) } END{ printf(\"\\nCPU      부하 전 %d%%  ->  부하 중 최고 %d%%  ->  부하 후 %d%%\\n메모리   부하 전 %.2fGB  ->  부하 중 최저 %.2fGB  ->  부하 후 %.2fGB\\n점유된 메모리 최대 %.2fGB\\n판정: CPU %s / 메모리 %s\\n\", fc, mx, lc, fm, mn, lm, fm-mn, (mx>=50 ? \"정상\" : \"미달\"), (fm-mn>=1 ? \"정상\" : \"미달\")) }' /tmp/qterm-stress.log; rm -f /tmp/qterm-stress.log",
        "check": { "passContains": ["판정: CPU 정상 / 메모리 정상"] },
        "desc": "결과에서 볼 것 — 맨 아래 '판정' 한 줄입니다.\nCPU 50% 이상 · 메모리 1GB 이상 점유, 둘 다 만족해야 통과입니다.\n막대는 CPU, 오른쪽 숫자는 부하 전 대비 메모리 증가량입니다.",
        "note": "부하 전과 부하 후가 비슷하게 돌아왔으면 자원이 정상 회수된 것입니다."
      }
    ]
  },
  {
    "id": "perf-iperf3-bw",
    "solution": "성능 · 부하",
    "title": "[부하] iperf3 — 네트워크 대역폭(BW)",
    "summary": "두 노드 간 TCP 실효 대역폭을 측정합니다. 역할별 대상에서 서버·클라이언트 세션을 고르면 접속 주소는 자동으로 채워집니다.",
    "roleValues": { "SERVER_IP": "서버" },
    "steps": [
      {
        "title": "도구 설치 (서버·클라이언트 양쪽)",
        "command": `${APT} update && ${APT} install -y iperf3`,
        "target": "서버, 클라이언트",
        "onFailure": "retry",
        "onFailureCommand": APT_FIX,
        "onFailureDesc": APT_FIX_DESC,
        "check": { "requireExitZero": true, "failContains": ["Unable to locate package", "has no installation candidate"] },
        "desc": "iperf3 를 설치합니다. 역할별 대상에서 고른 서버·클라이언트 두 세션에서 함께 실행되므로 따로 고를 필요가 없습니다.",
        "note": "RHEL/CentOS 계열은 `sudo dnf install -y iperf3`"
      },
      {
        "title": "[서버] 리슨 대기 시작",
        "command": "iperf3 -s -D; sleep 1; ss -tlnp 2>/dev/null | grep :5201 || echo 'iperf3 서버가 뜨지 않았습니다'",
        "target": "서버",
        "check": { "passContains": ["5201"], "failContains": ["뜨지 않았습니다"] },
        "undo": "pkill -f 'iperf3 -s'; true",
        "desc": "결과에서 볼 것 — 5201 포트가 LISTEN 으로 보여야 합니다. -D 는 백그라운드 실행이라 터미널을 점유하지 않습니다.",
        "note": "이미 떠 있으면 'Address already in use' 가 나올 수 있는데, 5201 이 보이면 정상입니다."
      },
      {
        "title": "[클라이언트] 대역폭 측정",
        "command": "iperf3 -c <SERVER_IP> -t 60 -P 4",
        "target": "클라이언트",
        "check": { "failContains": ["unable to connect", "Connection refused", "No route to host"], "passContains": ["iperf Done"] },
        "desc": "60초간 4개 병렬 스트림으로 TCP 실효 대역폭을 잽니다.\n결과에서 볼 것 — 맨 아래 [SUM] … receiver 줄의 Bitrate. sender 가 아니라 receiver 줄입니다.",
        "note": "<SERVER_IP> 는 '서버' 역할로 고른 세션의 주소가 자동으로 들어갑니다."
      },
      {
        "title": "[서버] 리슨 종료",
        "command": "pkill -f 'iperf3 -s'; sleep 1; ss -tlnp 2>/dev/null | grep :5201 || echo 'iperf3 서버를 정리했습니다'",
        "target": "서버",
        "check": { "passContains": ["정리했습니다"] },
        "desc": "결과에서 볼 것 — '정리했습니다' 문구입니다. 측정이 끝난 뒤 서버를 남겨두면 5201 포트를 계속 점유합니다."
      }
    ]
  },
  {
    "id": "perf-fio-iops",
    "solution": "성능 · 부하",
    "title": "[부하] fio — IOPS",
    "summary": "4k 랜덤 읽기/쓰기로 디스크 IOPS와 지연(Latency)을 측정합니다.",
    "steps": [
      {
        "title": "도구 설치 (필요 시)",
        "command": `${APT} update && ${APT} install -y fio`,
        "onFailure": "retry",
        "onFailureCommand": APT_FIX,
        "onFailureDesc": APT_FIX_DESC,
        "check": { "requireExitZero": true, "failContains": ["Unable to locate package", "has no installation candidate"] },
        "desc": "I/O 벤치마크 도구 fio 설치.",
        "note": "RHEL/CentOS 계열은 `sudo dnf install -y fio`"
      },
      {
        "title": "대상 볼륨으로 이동",
        "command": "sudo mkdir -p /mnt/data && cd /mnt/data && df -h /mnt/data && { mountpoint -q /mnt/data && echo '별도 볼륨이 마운트되어 있습니다' || echo '주의 — /mnt/data 는 별도 마운트가 아닙니다 (루트 디스크의 폴더)'; }",
        "undo": "mountpoint -q /mnt/data && echo '마운트된 볼륨이라 폴더를 지우지 않습니다' || sudo rmdir /mnt/data",
        "check": {
          "requireExitZero": true,
          "passContains": ["마운트되어 있습니다"],
          "failContains": ["별도 마운트가 아닙니다"]
        },
        "desc": "테스트할 마운트 볼륨 경로로 이동하고, 그 경로가 정말 별도 볼륨인지 확인합니다.",
        "note": "⚠️ 운영 데이터가 있는 경로는 피하세요 — 테스트 파일이 생깁니다.\n\n여기서 실패하면 fio 가 루트 디스크를 재게 됩니다.\n그 숫자를 볼륨 성능으로 적으면 값 자체가 틀린 것이라 여기서 멈춥니다.\n· 볼륨을 먼저 마운트하거나 (디스크 마운트 시나리오)\n· 정말 루트 디스크를 재려는 것이면 이 스텝을 '정상'으로 직접 지정하고 진행하세요"
      },
      {
        "title": "랜덤 쓰기 IOPS",
        "command": "sudo fio --name=randwrite --ioengine=libaio --iodepth=32 --rw=randwrite --bs=4k --direct=1 --size=1G --numjobs=1 --runtime=60 --group_reporting",
        "undo": "sudo rm -f /mnt/data/randwrite.*",
        "check": { "passContains": ["Run status group"] },
        "desc": "4k 블록 랜덤 쓰기의 IOPS·지연을 잽니다.\n결과에서 볼 것 — write: 줄의 IOPS=(초당 처리 횟수)와 BW=(대역폭). 아래 lat 은 지연 시간이라 작을수록 좋습니다."
      },
      {
        "title": "랜덤 읽기 IOPS",
        "command": "sudo fio --name=randread --ioengine=libaio --iodepth=32 --rw=randread --bs=4k --direct=1 --size=1G --numjobs=1 --runtime=60 --group_reporting",
        "undo": "sudo rm -f /mnt/data/randread.*",
        "check": { "passContains": ["Run status group"] },
        "desc": "4k 블록 랜덤 읽기의 IOPS·지연을 잽니다.\n결과에서 볼 것 — read: 줄의 IOPS= 와 BW=. QoS 를 걸었다면 상한 근처에서 멈춰야 정상입니다."
      },
      {
        "title": "테스트 파일 정리",
        "command": "sudo rm -f randwrite.* randread.*",
        "desc": "fio 가 생성한 테스트 파일 삭제."
      }
    ]
  },
  {
    "id": "perf-fio-bw",
    "solution": "성능 · 부하",
    "title": "[부하] fio — 대역폭(BW)",
    "summary": "1M 순차 읽기/쓰기로 디스크 처리량(Throughput)을 측정합니다.",
    "steps": [
      {
        "title": "도구 설치 (필요 시)",
        "command": `${APT} update && ${APT} install -y fio`,
        "onFailure": "retry",
        "onFailureCommand": APT_FIX,
        "onFailureDesc": APT_FIX_DESC,
        "check": { "requireExitZero": true, "failContains": ["Unable to locate package", "has no installation candidate"] },
        "desc": "I/O 벤치마크 도구 fio 설치.",
        "note": "RHEL/CentOS 계열은 `sudo dnf install -y fio`"
      },
      {
        "title": "대상 볼륨으로 이동",
        "command": "sudo mkdir -p /mnt/data && cd /mnt/data && df -h /mnt/data && { mountpoint -q /mnt/data && echo '별도 볼륨이 마운트되어 있습니다' || echo '주의 — /mnt/data 는 별도 마운트가 아닙니다 (루트 디스크의 폴더)'; }",
        "undo": "mountpoint -q /mnt/data && echo '마운트된 볼륨이라 폴더를 지우지 않습니다' || sudo rmdir /mnt/data",
        "check": {
          "requireExitZero": true,
          "passContains": ["마운트되어 있습니다"],
          "failContains": ["별도 마운트가 아닙니다"]
        },
        "desc": "테스트할 마운트 볼륨 경로로 이동하고, 그 경로가 정말 별도 볼륨인지 확인합니다.",
        "note": "⚠️ 운영 데이터가 있는 경로는 피하세요 — 테스트 파일이 생깁니다.\n\n여기서 실패하면 fio 가 루트 디스크를 재게 됩니다.\n그 숫자를 볼륨 성능으로 적으면 값 자체가 틀린 것이라 여기서 멈춥니다.\n· 볼륨을 먼저 마운트하거나 (디스크 마운트 시나리오)\n· 정말 루트 디스크를 재려는 것이면 이 스텝을 '정상'으로 직접 지정하고 진행하세요"
      },
      {
        "title": "순차 읽기 대역폭",
        "command": "sudo fio --name=seqread --ioengine=libaio --iodepth=32 --rw=read --bs=1m --direct=1 --size=1G --numjobs=1 --runtime=60 --group_reporting",
        "undo": "sudo rm -f /mnt/data/seqread.*",
        "check": { "passContains": ["Run status group"] },
        "desc": "1M 블록 순차 읽기 처리량 측정. 결과에서 볼 것 — read: 줄의 BW= 값(초당 몇 MB 를 읽는지). 큰 블록이라 IOPS 보다 BW 가 핵심입니다."
      },
      {
        "title": "순차 쓰기 대역폭",
        "command": "sudo fio --name=seqwrite --ioengine=libaio --iodepth=32 --rw=write --bs=1m --direct=1 --size=1G --numjobs=1 --runtime=60 --group_reporting",
        "undo": "sudo rm -f /mnt/data/seqwrite.*",
        "check": { "passContains": ["Run status group"] },
        "desc": "1M 블록 순차 쓰기 처리량 측정. 결과에서 볼 것 — write: 줄의 BW= 값(초당 몇 MB 를 쓰는지). 큰 블록이라 IOPS 보다 BW 가 핵심입니다."
      },
      {
        "title": "테스트 파일 정리",
        "command": "sudo rm -f seqread.* seqwrite.*",
        "desc": "fio 가 생성한 테스트 파일 삭제."
      }
    ]
  },

  // ───────────────────────── Ceph ─────────────────────────

  {
    "id": "scn5",
    "diagnostic": true,
    "solution": "Ceph",
    "title": "[관리] OSD Down 트러블 슈팅 체크 요소 확인",
    "summary": "HEALTH_WARN/ERR 와 함께 OSD 가 down 되었을 때, 원인 파악부터 재기동·복구 확인까지 진행합니다.",
    "steps": [
      {
        "title": "클러스터 상태 확인",
        "command": "sudo ceph -s",
        "desc": "지금 클러스터가 어떤 상태인지 한눈에 봅니다. 이 시나리오를 여는 상황이면 대개 HEALTH_WARN 이고, 그것이 여기서 확인할 내용입니다.",
        "info": "결과에서 볼 것 — 위에서 아래로 세 가지입니다.\n· health — HEALTH_OK / WARN / ERR 과 그 아래 딸린 사유 줄\n· osd: N osds: M up — up 숫자가 전체보다 적으면 그 차이가 down 된 개수입니다\n· pgs — degraded · misplaced 가 보이면 데이터 복제가 아직 안 끝난 것입니다\n\nHEALTH_OK 로 돌아왔는데 pgs 에 degraded/misplaced 가 남아 있으면 아직 복구 중입니다.\n마지막 단계에서 그 숫자가 줄어드는지 봅니다.",
        "note": "여기에 '정상 조건' 을 붙이지 않는다.\n예전에는 passContains: HEALTH_OK 였는데, OSD 가 down 이라서 여는 시나리오에 대고 \"HEALTH_OK 가 아니면 실패\" 라고 한 셈이었다.\n그 실패가 전체 실행을 1번에서 끊어, 정작 봐야 할 2~5번 증거를 한 번도 못 모으게 했다.\n지금 상태를 보여 주는 것이 이 스텝의 일이고, 정상인지는 아래 6~8번(조치와 그 결과)에서 가린다."
      },
      {
        "title": "헬스 상세 확인",
        "command": "sudo ceph health detail",
        "desc": "어떤 OSD/PG 가 문제인지 구체적인 원인을 확인합니다."
      },
      {
        "title": "OSD 트리에서 down 식별",
        "command": "sudo ceph osd tree",
        "desc": "down 또는 out 상태인 OSD 의 ID 와 위치(호스트)를 식별합니다."
      },
      {
        "title": "크래시 이력 확인",
        "command": "sudo ceph crash ls",
        "desc": "최근 비정상 종료된 데몬이 있는지 확인합니다."
      },
      {
        "title": "OSD 로그 확인",
        "command": "sudo tail -n 200 /var/log/ceph/ceph-osd.<OSD_ID>.log",
        "desc": "문제 OSD 의 로그에서 다운 원인(디스크 오류, OOM 등)을 확인합니다."
      },
      {
        "title": "OSD 데몬 재시작",
        "check": {"requireExitZero":true},
        "command": "sudo systemctl restart ceph-osd@<OSD_ID>",
        "desc": "해당 OSD 데몬을 재기동합니다.",
        "note": "⚠️ 디스크 하드웨어 장애가 의심되면 재시작 전에 디스크 상태(SMART 등)를 먼저 점검하세요."
      },
      {
        "title": "OSD 데몬 상태 확인",
        "command": "sudo systemctl is-active ceph-osd@<OSD_ID>; sudo systemctl status ceph-osd@<OSD_ID> --no-pager -n 20",
        "check": { "passContains": ["active"], "failContains": ["failed", "inactive"] },
        "desc": "재시작한 OSD 데몬이 실제로 올라왔는지 확인합니다. active (running) 이어야 정상입니다."
      },
      {
        "title": "OSD 트리 재확인",
        "command": "sudo ceph osd tree",
        "check": { "failContains": ["down"] },
        "desc": "해당 OSD 가 up 으로 돌아왔는지 확인합니다. 여전히 down 이면 로그를 다시 확인해야 합니다."
      },
      {
        "title": "복구 진행 감시",
        "command": "for i in $(seq 1 12); do date +%H:%M:%S; sudo ceph -s | sed -n '1,12p'; echo; sleep 5; done; echo '--- 60초 관찰 종료'",
        "desc": "OSD 가 up 으로 전환되고 복구(recovery/backfill)가 진행되는지 60초 동안 5초 간격으로 관찰합니다. 시각이 함께 찍히므로 복구가 줄어드는 추세인지 리포트에서도 확인됩니다.",
        "info": "검증 실행에서는 끝나지 않는 명령을 쓸 수 없어 시간을 끊어 두었습니다.\n더 오래 지켜보려면 이 단계를 여러 번 실행하거나, 터미널에서 watch -n 5 'sudo ceph -s' 를 쓰세요."
      }
    ]
  },

  // ───────────────────────── Kubernetes ─────────────────────────

  {
    "id": "scn6",
    "diagnostic": true,
    "solution": "Kubernetes",
    "title": "[워크로드] 파드 CrashLoopBackOff 진단",
    "summary": "파드가 계속 재시작(CrashLoopBackOff)될 때, 이벤트와 로그로 원인을 찾아냅니다.",
    "steps": [
      {
        "title": "비정상 파드 찾기",
        "command": "kubectl get pods -A --field-selector=status.phase!=Running",
        "desc": "Running 이 아닌 파드와 그 네임스페이스를 식별합니다."
      },
      {
        "title": "파드 상세/이벤트 확인",
        "command": "kubectl describe pod <POD_NAME> -n <NAMESPACE>",
        "desc": "하단 Events 에서 이미지 풀 실패, 마운트 실패, OOMKilled 등 원인 단서를 확인합니다."
      },
      {
        "title": "현재 로그 확인",
        "command": "kubectl logs <POD_NAME> -n <NAMESPACE>",
        "desc": "현재 컨테이너의 애플리케이션 로그에서 에러를 확인합니다."
      },
      {
        "title": "직전 컨테이너 로그",
        "command": "kubectl logs <POD_NAME> -n <NAMESPACE> --previous",
        "desc": "죽기 직전 컨테이너의 로그를 확인합니다 (크래시 직접 원인 파악)."
      },
      {
        "title": "노드 리소스 확인",
        "command": "kubectl top nodes",
        "desc": "노드의 CPU/메모리 부족(특히 OOM)으로 인한 재시작인지 확인합니다."
      },
      {
        "title": "설정 수정 후 재배포",
        "check": {"passContains":["restarted"],"requireExitZero":true},
        "command": "kubectl rollout restart deployment/<NAME> -n <NAMESPACE>",
        "desc": "원인을 수정(이미지/리소스/설정)한 뒤 무중단으로 파드를 재생성합니다."
      }
    ]
  },

  // ───────────────────────── 리눅스 기초 ─────────────────────────

  {
    "id": "scn7",
    "solution": "리눅스 기초",
    "title": "[기초] 신규 사용자 생성 및 sudo 권한 부여",
    "summary": "새 로그인 계정을 만들고 관리자(sudo) 권한을 부여한 뒤 확인합니다.",
    "steps": [
      {
        "title": "사용자 생성",
        "check": {"requireExitZero":true},
        "command": "sudo adduser --gecos \"\" <사용자명>",
        "expect": [
          { "match": "Retype new password", "send": "<비밀번호>", "secret": true },
          { "match": "New password", "send": "<비밀번호>", "secret": true }
        ],
        "undo": "sudo deluser --remove-home <사용자명>",
        "warn": "위 '검증 입력값' 에 <사용자명> 과 <비밀번호> 를 채운 뒤 실행하세요. 비밀번호 프롬프트는 자동으로 응답하며, 입력한 값은 화면·리포트에 가려서 남습니다.",
        "desc": "홈 디렉토리와 함께 계정을 만듭니다. --gecos \"\" 로 이름·전화 질문을 건너뛰므로 남는 대화형 질문은 비밀번호 둘뿐이고, 그건 expect 로 자동 응답합니다."
      },
      {
        "title": "계정 생성 확인",
        "command": "getent passwd <사용자명>; ls -ld /home/<사용자명>",
        "check": { "passContains": ["/home/"], "requireExitZero": true },
        "desc": "계정이 /etc/passwd 에 등록되고 홈 디렉토리가 만들어졌는지 확인합니다."
      },
      {
        "title": "sudo 권한 부여",
        "check": {"requireExitZero":true},
        "command": "sudo usermod -aG sudo <사용자명>",
        "undo": "sudo deluser <사용자명> sudo",
        "desc": "사용자를 sudo 그룹에 추가해 관리자 명령을 쓸 수 있게 합니다.",
        "note": "RHEL/CentOS 계열은 sudo 대신 wheel 그룹을 사용합니다 (usermod -aG wheel)."
      },
      {
        "title": "그룹 확인",
        "check": {"passContains":["sudo"],"requireExitZero":true},
        "command": "id <사용자명>",
        "desc": "해당 계정이 sudo(또는 wheel) 그룹에 포함됐는지 확인합니다."
      },
      {
        "title": "sudo 권한 실제 확인",
        "command": "sudo -l -U <사용자명>",
        "check": { "passContains": ["ALL"], "requireExitZero": true },
        "desc": "그룹에 속한 것과 실제로 sudo 를 쓸 수 있는 것은 다릅니다. sudoers 정책까지 반영된 결과를 확인합니다.",
        "note": "'may run the following commands' 아래 (ALL : ALL) ALL 이 보이면 정상입니다."
      },
      {
        "title": "계정 전환 테스트",
        "command": "su - <사용자명>",
        "needsInput": true,
        "warn": "'입력'으로 사용자명을 채운 뒤 실행하면 대상 계정의 비밀번호를 물어봅니다. 이후 해당 사용자 쉘로 전환되므로, 다음 단계로 넘어가기 전 반드시 'exit' 로 원래 계정으로 돌아오세요.",
        "desc": "새 계정으로 전환해 로그인이 되는지 테스트합니다. (원래 계정으로 돌아오기: exit)"
      }
    ]
  },

  // ───────────────────────── etc ─────────────────────────

  {
    "id": "scn-wireguard-vpn",
    "solution": "구축 · 배포",
    "title": "[VPN] WireGuard 서버 구축 및 클라이언트 발급",
    "summary": "밖에 있는 사람이 유동 IP 하나로 사설망 안의 VM 에 접속하게 만듭니다.\n서버 구축(wg-easy 컨테이너) → 계정 발급 → 클라이언트 설치·등록·활성화 → 접근 확인 순서입니다.",
    "steps": [
      {
        "title": "OS·커널 확인",
        "command": ". /etc/os-release && echo \"$PRETTY_NAME\" && uname -r && sudo modprobe wireguard 2>/dev/null; [ -d /sys/module/wireguard ] && echo '커널 모듈 적재됨' || echo '아직 적재 안 됨 (컨테이너가 기동하며 올립니다)'",
        "desc": "기준 환경은 Ubuntu 24.04 입니다. 커널 5.6 이상이면 WireGuard 가 커널에 들어 있어 따로 설치하지 않아도 됩니다.",
        "info": "'아직 적재 안 됨' 이 나와도 문제가 아닙니다.\nwg-easy 컨테이너가 기동하면서 직접 올립니다 (SYS_MODULE 권한 + /lib/modules 마운트)."
      },
      {
        "title": "클라이언트가 접속할 주소 정하기",
        "command": "echo '[이 VM 에 붙은 주소]'; ip -4 addr show scope global | awk '/inet /{print \"   \", $2, \"(\" $NF \")\"}'; echo; echo '[밖으로 나갈 때 보이는 주소 — 참고용, 그대로 쓰지 말 것]'; curl -s --max-time 5 ifconfig.me && echo || echo '   (조회 실패 — 폐쇄망이면 정상)'",
        "desc": "다음 단계 INIT_HOST 에 넣을 주소를 정합니다. 기준은 하나 — 밖에 있는 클라이언트가 실제로 닿는 주소입니다.",
        "info": "대부분 이런 구성입니다\n· VM 은 사설 IP 를 갖고, 거기에 유동(floating) IP 가 붙어 있습니다\n· 그러면 엔드포인트는 그 유동 IP 입니다\n· 유동 IP 는 VM 안에서 보이지 않습니다 — 포털이나 openstack server show 로 확인하세요\n\n그 밖의 경우\n· 앞단 공유기·방화벽에서 포트포워딩한다면 → 그 장비의 주소\n· 클라이언트가 같은 사내망 안에만 있다면 → VM 의 사설 IP 그대로\n\n[밖으로 나갈 때 보이는 주소] 는 쓰지 마세요\n이 VM 이 인터넷으로 나갈 때 쓰는 출발지 주소(SNAT)일 뿐입니다.\n들어오는 연결이 그 주소로 닿는다는 보장이 없습니다.\n\n같이 적어 둘 것 — 접근하려는 VM 들의 사설 대역 (예: 192.168.50.0/24)\n뒤에서 '터널로 보낼 대역' 으로 씁니다. 이 서버가 붙어 있는 대역과 달라도 됩니다.",
        "warn": "주소가 틀려도 설정 파일은 멀쩡히 만들어지고 컨테이너도 잘 뜹니다.\n클라이언트에서 handshake 만 안 돼서 원인을 찾기 어렵습니다 — 여기서 확실히 정하세요."
      },
      {
        "title": "패키지 저장소 업데이트",
        "command": `${APT} update`,
        "onFailure": "retry",
        "onFailureCommand": APT_FIX,
        "onFailureDesc": APT_FIX_DESC,
        "check": { "failContains": ["Err:", "Failed to fetch", "Could not resolve", "Temporary failure resolving"], "passContains": ["Reading package lists"] },
        "desc": "Docker 설치 전에 저장소를 갱신합니다."
      },
      {
        "title": "Docker 저장소 키 등록",
        "command": `${APT} install -y ca-certificates curl && sudo install -m 0755 -d /etc/apt/keyrings && sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc && sudo chmod a+r /etc/apt/keyrings/docker.asc && ls -l /etc/apt/keyrings/docker.asc`,
        "check": { "requireExitZero": true, "passContains": ["docker.asc"] },
        "desc": "Docker 공식 apt 저장소의 GPG 키를 내려받습니다.",
        "undo": "sudo rm -f /etc/apt/keyrings/docker.asc"
      },
      {
        "title": "Docker 저장소 추가",
        "command": `echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null && ${APT} update && echo '저장소 등록 완료'`,
        "check": { "passContains": ["저장소 등록 완료"], "failContains": ["Err:", "Failed to fetch"] },
        "desc": "현재 배포판 코드명(24.04 는 noble)에 맞는 Docker 저장소를 등록합니다.",
        "undo": "sudo rm -f /etc/apt/sources.list.d/docker.list && sudo apt-get update -q"
      },
      {
        "title": "Docker 설치",
        "command": `if [ ! -f /etc/apt/sources.list.d/docker.list ]; then echo '중단 — Docker 저장소가 등록되지 않았습니다. 앞 단계 "Docker 저장소 추가" 를 먼저 실행하세요'; else ${APT} install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin; fi`,
        "onFailure": "retry",
        "onFailureCommand": APT_FIX,
        "onFailureDesc": APT_FIX_DESC,
        "check": { "requireExitZero": true, "failContains": ["중단 —", "Unable to locate package", "has no installation candidate"] },
        "desc": "Docker 엔진과 compose 플러그인을 설치합니다.",
        "undo": "sudo apt-get purge -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin && sudo apt-get autoremove -y"
      },
      {
        "title": "Docker 동작 확인",
        "command": "sudo systemctl is-active docker && sudo docker version --format 'server {{.Server.Version}}' && sudo docker compose version",
        "check": { "requireExitZero": true, "passContains": ["active"] },
        "desc": "데몬이 떠 있고 compose 플러그인이 붙었는지 봅니다."
      },
      {
        "title": "wg-easy 설정 파일 작성",
        "command": "sudo mkdir -p /opt/wg-easy && cd /opt/wg-easy && sudo tee docker-compose.yml > /dev/null << 'EOF'\nservices:\n  wg-easy:\n    image: ghcr.io/wg-easy/wg-easy:15\n    container_name: wg-easy\n    restart: unless-stopped\n    cap_add:\n      - NET_ADMIN\n      - SYS_MODULE\n    sysctls:\n      - net.ipv4.ip_forward=1\n      - net.ipv4.conf.all.src_valid_mark=1\n    environment:\n      - INIT_ENABLED=true\n      - INIT_USERNAME=<관리자ID>\n      - INIT_PASSWORD=<관리자비밀번호>\n      - INIT_HOST=<접속주소>\n      - INIT_PORT=51820\n      - INIT_DNS=1.1.1.1,8.8.8.8\n      - INIT_IPV4_CIDR=10.8.0.0/24\n      - PORT=51821\n      - HOST=0.0.0.0\n      - INSECURE=true\n    ports:\n      - \"51820:51820/udp\"\n      - \"51821:51821/tcp\"\n    volumes:\n      - ./wireguard-config:/etc/wireguard\n      - /lib/modules:/lib/modules:ro\nEOF\nif sudo grep -q '<[^>]*>' docker-compose.yml; then echo '중단 — 채우지 않은 입력값이 남아 있습니다'; sudo grep -n '<[^>]*>' docker-compose.yml; else echo '설정 파일 작성 완료'; sudo grep -n 'image:\\|INIT_HOST\\|INIT_USERNAME' docker-compose.yml; fi",
        "check": { "passContains": ["설정 파일 작성 완료"], "failContains": ["중단 —"] },
        "desc": "wg-easy 15 버전 설정을 만듭니다. 원 문서는 저장소를 clone 한 뒤 이 파일을 덮어쓰지만, 실제로 쓰이는 것은 이 파일 하나입니다.",
        "info": "채울 값\n· 관리자ID · 관리자비밀번호 — WebUI 로그인 계정 (비밀번호는 12자 이상)\n· 접속주소 — 앞 단계에서 정한, 클라이언트가 닿는 주소\n\nINIT_IPV4_CIDR (10.8.0.0/24) 은 클라이언트에게 나눠 줄 VPN 전용 대역입니다.\n접속할 사설 대역이나 클라이언트의 집·사무실 대역과 겹치면 경로가 꼬이니 다른 대역으로 바꾸세요.\n\n원 문서와 다른 점\n· WG_ALLOWED_IPS 줄을 뺐습니다 — 14 버전 변수라 15 에서는 무시됩니다(실측).\n  터널로 보낼 대역은 뒤의 '터널로 보낼 대역 정하기' 단계에서 정합니다.\n· IPv6 설정을 뺐습니다 — 테넌트 네트워크에 IPv6 가 없으면 컨테이너가 기동하지 못합니다.",
        "warn": "비밀번호가 이 설정 파일에 평문으로 들어갑니다.\n검증 리포트에서는 가려지지만 서버의 /opt/wg-easy/docker-compose.yml 에는 그대로 남습니다.",
        "undo": "sudo rm -rf /opt/wg-easy"
      },
      {
        "title": "컨테이너 기동",
        "command": "cd /opt/wg-easy && sudo docker compose up -d && sleep 8 && sudo docker compose ps",
        "check": { "requireExitZero": true, "passContains": ["wg-easy"] },
        "desc": "이미지를 내려받고 컨테이너를 띄웁니다. 처음이면 이미지 내려받기에 시간이 걸립니다.",
        "undo": "cd /opt/wg-easy && sudo docker compose down -v"
      },
      {
        "title": "컨테이너 상태 확인",
        "command": "sudo docker ps -a --filter name=wg-easy --format '{{.Names}} | {{.Status}} | {{.Ports}}'",
        "check": { "passContains": ["Up"], "failContains": ["Restarting", "Exited", "Created"] },
        "desc": "Up 상태이고 51820/udp · 51821/tcp 가 매핑돼 있어야 정상입니다.",
        "info": "Restarting 이 반복되면 설정 오류입니다. 다음 단계의 로그에서 이유를 봅니다."
      },
      {
        "title": "기동 로그 확인",
        "command": "sudo docker logs --tail 40 wg-easy",
        "check": { "failContains": ["EADDRINUSE", "permission denied", "operation not permitted"] },
        "desc": "기동 과정에서 막힌 것이 없는지 봅니다.",
        "info": "자주 나오는 실패\n· EADDRINUSE — 51820/51821 을 다른 프로세스가 이미 쓰고 있음\n· operation not permitted — 커널 모듈 접근 실패. cap_add 의 SYS_MODULE 이나 /lib/modules 마운트가 빠졌는지 확인"
      },
      {
        "title": "포트 리스닝 확인",
        "command": "sudo ss -lntup | grep -E '51820|51821' || echo '주의 — 51820/51821 리스닝이 없습니다'",
        "check": { "passContains": ["51821"], "failContains": ["주의 —"] },
        "desc": "서버 자신이 두 포트를 열고 있는지 확인합니다.",
        "note": "여기까지는 인스턴스 안쪽입니다. 클라이언트가 붙으려면 보안그룹·방화벽에서도 열려 있어야 합니다.\n\n51820/UDP — VPN 터널 (필수). TCP 로 열면 WebUI 는 보이는데 터널만 안 붙어, 원인을 찾기 어려워집니다.\n51821/TCP — 관리 WebUI. 구축이 끝나면 관리자 대역으로 좁히는 것을 권합니다."
      },
      {
        "title": "WebUI 응답 확인",
        "command": "curl -s -o /dev/null -w 'WebUI 응답 코드: %{http_code}\\n' http://127.0.0.1:51821/",
        "check": { "passRegex": "응답 코드: (200|30[0-9])" },
        "desc": "관리 화면이 응답하는지 서버 안에서 먼저 확인합니다. 로그인 화면으로 넘기느라 30x 가 나올 수 있고, 그것도 정상입니다.",
        "info": "INSECURE=true 라 http 로 응답합니다. 외부에 그대로 노출하지 말고, 앞단에 리버스 프록시나 방화벽을 두세요."
      },
      {
        "title": "서버가 목표 사설 대역에 닿는지 확인",
        "command": "echo '[이 서버에 붙은 주소]'; ip -4 addr show scope global | awk '/inet /{print \"   \", $2, \"(\" $NF \")\"}'; echo; echo '[대상 VM 으로 가는 경로]'; ip route get <대상VM_IP> 2>&1 | head -2; echo; echo '[도달 확인]'; ping -c 2 -W 2 <대상VM_IP> > /dev/null 2>&1 && echo '   닿습니다' || echo '   주의 — 닿지 않습니다'",
        "check": { "passContains": ["닿습니다"], "failContains": ["주의 —"] },
        "desc": "접근할 사설 대역의 VM 을 하나 골라, 이 서버에서 거기로 갈 수 있는지 봅니다.",
        "info": "닿는 길은 둘입니다.\n· 그 네트워크의 포트를 이 VM 에 직접 붙이기 (openstack server add port)\n  [이 서버에 붙은 주소] 에 그 대역이 함께 보이면 된 것입니다.\n· 라우터를 통해 가기\n  [대상 VM 으로 가는 경로] 출력의 via 주소가 그 라우터입니다.\n\n닿기만 하면 전달은 wg-easy 가 합니다.\n클라이언트 트래픽을 이 서버 주소로 NAT 해서 내보내므로,\n대상 VM 쪽에 10.8.0.0/24 로 돌아오는 경로를 따로 넣지 않아도 됩니다.",
        "warn": "여기서 닿지 않는데 그냥 진행하면, 클라이언트는 핸드셰이크까지 잘 되고 나서\n'연결은 됐는데 아무 데도 안 되는' 상태가 됩니다.\n원인을 찾기 가장 어려운 모양이니 이 단계에서 해결하고 넘어가세요.",
        "note": "ping 이 막힌 환경이면 닿아도 '주의' 로 나옵니다.\n그때는 [대상 VM 으로 가는 경로] 에 경로가 잡히는지,\n또는 nc -zv 대상IP 22 같은 포트 확인으로 판단하세요."
      },
      {
        "title": "터널로 보낼 대역 정하기 (관리 패널 → 구성)",
        "command": "",
        "desc": "관리 패널 → 구성 에서 두 값을 확인합니다. 건너뛰면 기본값이 전체 터널이라 클라이언트의 인터넷과 기존 VPN 이 끊깁니다.",
        "info": "한국어 UI 기준입니다 (영문이면 Admin Panel → Config).\n\n볼 값 두 개\n· 호스트 — 앞에서 정한 엔드포인트(보통 유동 IP)가 들어가 있어야 합니다\n· 허용된 IP — 클라이언트가 이 터널로 보낼 대역. 기본값은 0.0.0.0/0 과 ::/0 입니다\n\n사설망 접근이 목적이라면\n그 두 줄을 지우고 접근하려는 대역만 넣으세요 (예: 192.168.50.0/24).\n앞 단계에서 닿는 것을 확인한 그 대역입니다.\n여러 대역이면 추가 버튼으로 줄을 늘리고, 맨 아래 저장을 누릅니다.\n\n· 사설 대역만 적음(스플릿 터널) — 그 대역만 VPN 으로. 인터넷과 회사 VPN 은 그대로\n· 0.0.0.0/0(전체 터널) — 모든 트래픽이 VPN 서버를 거침. 출발지 IP 를 바꾸려는 경우만\nIPv6 를 쓰지 않으면 ::/0 도 지우는 편이 안전합니다.",
        "warn": "0.0.0.0/0 은 엔드포인트로 가는 경로까지 터널 안에 넣습니다.\n그 경로가 다른 VPN(예: FortiClient) 위에 얹혀 있었다면 그 VPN 이 끊기면서\n서버에 닿을 길 자체가 사라져 핸드셰이크가 영영 안 됩니다. 실제로 겪은 사고입니다."
      },
      {
        "title": "사용자(클라이언트) 계정 발급",
        "command": "",
        "desc": "클라이언트 화면에서 새로 만들기를 눌러 사용자를 추가합니다. 10.8.0.x 주소가 하나 배정됩니다.",
        "info": "추가한 줄의 오른쪽 아이콘 — QR 코드 · 설정 파일(.conf) 내려받기 · 비활성화 · 삭제\n\n사람마다, 또는 기기마다 하나씩 만드는 것이 원칙입니다.\n하나를 여러 기기에 나눠 쓰면 접속이 서로 밀어내고, 누가 무엇을 썼는지도 구분되지 않습니다.\n기기별 송수신 통계와 마지막 접속 시각도 이 목록에서 봅니다."
      },
      {
        "title": "클라이언트 프로그램 설치·등록·활성화",
        "command": "",
        "desc": "설정 파일을 받는 것만으로는 연결되지 않습니다. 단말에 WireGuard 클라이언트를 깔고, 받은 파일을 등록한 뒤, 활성화를 눌러야 붙습니다.",
        "note": "1) 설치 — https://www.wireguard.com/install 에서 단말에 맞는 것을 받습니다 (Windows · macOS · Linux · Android · iOS)\n2) 등록\n   · PC — 터널 추가 → 파일에서 추가 → 내려받은 .conf 선택\n   · 휴대폰 — 앱에서 + → QR 코드 스캔\n3) 활성화 — 터널을 고르고 활성화를 누릅니다. 이걸 눌러야 실제로 연결됩니다.",
        "info": "활성화한 뒤 클라이언트 화면에서 볼 것\n· 주소 — 10.8.0.x/32 가 잡혀 있는지\n· 엔드포인트 — 앞에서 정한 엔드포인트:51820 인지\n· 허용된 IP — 앞 단계에서 정한 대역이 들어와 있는지 (0.0.0.0/0 이면 전체 터널입니다)\n· 전송 — 보내기와 받기가 **둘 다** 올라가야 정상입니다"
      },
      {
        "title": "서버에서 연결 상태 확인",
        "command": "sudo docker exec wg-easy wg show",
        "check": { "passContains": ["interface"], "failContains": ["No such container"] },
        "desc": "발급한 클라이언트가 peer 로 잡히는지 봅니다.",
        "warn": "클라이언트에서 '보내기'만 올라가고 '받기'가 0 이면 핸드셰이크가 안 된 것입니다.\n순서대로 보세요.\n① 허용된 IP 가 0.0.0.0/0 이라 엔드포인트로 가는 경로까지 터널에 들어갔는지\n② 51820/UDP 가 열려 있는지 (TCP 아님)\n③ 엔드포인트 주소가 그 단말에서 실제로 닿는 주소인지"
      },
      {
        "title": "클라이언트에서 통신 확인",
        "command": "",
        "desc": "활성화한 단말에서 확인합니다. 여기까지 되면 구축이 끝난 것입니다.",
        "note": "1) 배정 주소 — 10.8.0.x 를 받았는지 (ipconfig / ip addr)\n2) 사설망 접근 — 목표였던 사설 대역의 VM 에 ping 또는 ssh 가 되는지. 이게 이 VPN 의 본래 목적입니다\n3) 기존 경로 유지 — 인터넷과 회사 VPN 이 그대로인지. 스플릿 터널이면 그대로여야 합니다\n4) 전체 터널로 만든 경우에만 — VPN 끄고 curl ifconfig.me, 켜고 다시 재어 값이 서버 쪽 주소로 바뀌는지",
        "info": "'외부 통신' 은 방향에 따라 담당이 다릅니다 — 헷갈리기 쉬운 부분입니다.\n· 클라이언트 → 사설 VM 접근 — 이 VPN 이 하는 일입니다\n· 사설 VM → 인터넷 — 이 VPN 과 무관합니다.\n  OpenStack 라우터의 SNAT 이나 그 VM 에 붙인 유동 IP 가 해 줍니다.\n  터널을 뚫는다고 사설 VM 이 인터넷에 나갈 수 있게 되지는 않습니다.\n\n2) 가 안 될 때 볼 곳\n· 사설 대역이 '허용된 IP' 에 들어 있는지\n· 앞의 '서버가 목표 사설 대역에 닿는지 확인' 이 통과했는지\n· 대상 VM 의 보안그룹이 VPN 서버 주소에서 오는 접속을 허용하는지"
      },
      {
        "title": "Docker 제거 (선택 — 검증 후 정리)",
        "manualOnly": true,
        "command": `if [ -d /opt/wg-easy ]; then (cd /opt/wg-easy && sudo docker compose down -v) || true; fi; cd /; ${APT} purge -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin; ${APT} autoremove -y; sudo rm -rf /opt/wg-easy /var/lib/docker /var/lib/containerd; sudo rm -f /etc/apt/sources.list.d/docker.list /etc/apt/keyrings/docker.asc; ${APT} update; echo '--- 정리 결과'; command -v docker > /dev/null && echo '주의 — docker 명령이 아직 있습니다' || echo 'docker 명령 없음'; [ -d /var/lib/docker ] && echo '주의 — /var/lib/docker 가 남아 있습니다' || echo '/var/lib/docker 없음'`,
        "check": { "passContains": ["docker 명령 없음", "/var/lib/docker 없음"], "failContains": ["주의 —"] },
        "desc": "검증이 끝나고 이 VM 을 원래대로 돌릴 때만 실행합니다. 컨테이너를 내리고 Docker 패키지·데이터·저장소 등록까지 한 번에 걷어냅니다.",
        "warn": "이 VM 의 모든 컨테이너와 이미지가 사라집니다 — /var/lib/docker 를 통째로 지웁니다.\n이 시나리오로 만든 것 말고 다른 컨테이너가 돌고 있다면 실행하지 마세요. VPN 도 끊깁니다.",
        "info": "하는 일 순서\n1) wg-easy 컨테이너·볼륨 내리기 (compose down -v)\n2) Docker 패키지 purge + autoremove\n3) /opt/wg-easy · /var/lib/docker · /var/lib/containerd 삭제\n4) Docker apt 저장소와 GPG 키 삭제 후 apt 갱신\n5) docker 명령과 /var/lib/docker 가 정말 없어졌는지 확인\n\nVPN 만 내리고 Docker 는 남기려면 이 단계 대신 아래만 실행하세요.\ncd /opt/wg-easy && sudo docker compose down -v"
      }
    ]
  },

  {
    "id": "scn-docker-app-deploy",
    "solution": "구축 · 배포",
    "title": "[컨테이너] Docker 설치 및 애플리케이션 배포·운영 확인",
    "summary": "일반 VM 에 Docker 를 설치하고 애플리케이션 컨테이너를 올립니다.\n서비스 응답 → 로그 → 재기동 → 자동 복구 → 새 버전 배포까지 차례로 확인합니다.",
    "steps": [
      {
        "title": "OS·자원 확인",
        "command": ". /etc/os-release && echo \"$PRETTY_NAME\"; uname -r; echo \"CPU: $(nproc) core\"; free -h | awk 'NR==2{print \"메모리: \" $2 \" (여유 \" $7 \")\"}'; df -h / | awk 'NR==2{print \"루트 여유: \" $4}'",
        "desc": "컨테이너를 올릴 VM 의 기본 자원을 봅니다.",
        "info": "이미지와 레이어는 /var/lib/docker 아래에 쌓입니다.\n루트 여유가 5GB 미만이면 이미지를 내려받다 막힐 수 있습니다."
      },
      {
        "title": "패키지 저장소 업데이트",
        "command": `${APT} update`,
        "onFailure": "retry",
        "onFailureCommand": APT_FIX,
        "onFailureDesc": APT_FIX_DESC,
        "check": { "failContains": ["Err:", "Failed to fetch", "Could not resolve", "Temporary failure resolving"], "passContains": ["Reading package lists"] },
        "desc": "Docker 설치 전에 저장소를 갱신합니다."
      },
      {
        "title": "Docker 저장소 키 등록",
        "command": `${APT} install -y ca-certificates curl && sudo install -m 0755 -d /etc/apt/keyrings && sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc && sudo chmod a+r /etc/apt/keyrings/docker.asc && ls -l /etc/apt/keyrings/docker.asc`,
        "check": { "requireExitZero": true, "passContains": ["docker.asc"] },
        "desc": "Docker 공식 apt 저장소의 GPG 키를 내려받습니다.",
        "undo": "sudo rm -f /etc/apt/keyrings/docker.asc"
      },
      {
        "title": "Docker 저장소 추가",
        "command": `echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null && ${APT} update && echo '저장소 등록 완료'`,
        "check": { "passContains": ["저장소 등록 완료"], "failContains": ["Err:", "Failed to fetch"] },
        "desc": "현재 배포판 코드명에 맞는 Docker 저장소를 등록합니다.",
        "undo": "sudo rm -f /etc/apt/sources.list.d/docker.list && sudo apt-get update -q"
      },
      {
        "title": "Docker 설치",
        "command": `if [ ! -f /etc/apt/sources.list.d/docker.list ]; then echo '중단 — Docker 저장소가 등록되지 않았습니다. 앞 단계 "Docker 저장소 추가" 를 먼저 실행하세요'; else ${APT} install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin; fi`,
        "onFailure": "retry",
        "onFailureCommand": APT_FIX,
        "onFailureDesc": APT_FIX_DESC,
        "check": { "requireExitZero": true, "failContains": ["중단 —", "Unable to locate package", "has no installation candidate"] },
        "desc": "Docker 엔진과 compose 플러그인을 설치합니다.",
        "undo": "sudo apt-get purge -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin && sudo apt-get autoremove -y"
      },
      {
        "title": "Docker 동작 확인",
        "command": "sudo systemctl is-active docker && sudo docker run --rm hello-world",
        "check": { "requireExitZero": true, "passContains": ["Hello from Docker"] },
        "desc": "데몬이 떠 있는지, 이미지를 내려받아 컨테이너를 돌릴 수 있는지까지 한 번에 확인합니다.",
        "info": "여기서 막히면 대개 외부 레지스트리(registry-1.docker.io)로 못 나가는 것입니다.\n폐쇄망이면 사내 레지스트리를 /etc/docker/daemon.json 에 등록해야 합니다.",
        "undo": "sudo docker image rm -f hello-world"
      },
      {
        "title": "현재 사용자로 docker 쓰기",
        "command": "sudo usermod -aG docker $USER && echo \"$USER 를 docker 그룹에 넣었습니다\"",
        "check": { "requireExitZero": true, "passContains": ["docker 그룹에 넣었습니다"] },
        "desc": "sudo 없이 docker 를 쓰려면 docker 그룹에 들어가야 합니다.",
        "info": "지금 접속에는 반영되지 않습니다 — 다시 로그인해야 적용됩니다.\n그래서 이 시나리오의 나머지 단계는 계속 sudo 를 붙입니다.",
        "warn": "docker 그룹은 사실상 root 권한입니다 — 호스트 파일시스템을 컨테이너로 마운트할 수 있습니다.\n필요한 사람에게만 주세요.",
        "undo": "sudo gpasswd -d $USER docker"
      },
      {
        "title": "배포할 애플리케이션 준비",
        "command": "sudo mkdir -p /opt/qterm-app/html && cd /opt/qterm-app && echo 'QTerm 배포 확인 / 배포 버전: v1' | sudo tee html/index.html > /dev/null && sudo tee docker-compose.yml > /dev/null << 'EOF'\nservices:\n  app:\n    image: nginx:1.27-alpine\n    container_name: qterm-app\n    restart: unless-stopped\n    ports:\n      - \"<서비스포트>:80\"\n    volumes:\n      - ./html:/usr/share/nginx/html:ro\n    healthcheck:\n      test: [\"CMD\", \"wget\", \"-qO-\", \"http://localhost/\"]\n      interval: 10s\n      timeout: 3s\n      retries: 3\n      start_period: 5s\nEOF\nif sudo grep -q '<[^>]*>' docker-compose.yml; then echo '중단 — 채우지 않은 입력값이 남아 있습니다'; sudo grep -n '<[^>]*>' docker-compose.yml; else echo '설정 파일 작성 완료'; ls -l /opt/qterm-app /opt/qterm-app/html; fi",
        "check": { "passContains": ["설정 파일 작성 완료"], "failContains": ["중단 —"] },
        "desc": "nginx 컨테이너와 그 안에 띄울 index.html 을 만듭니다. 내용에 버전 문자열을 넣어, 뒤에서 새 배포가 반영됐는지 눈으로 확인합니다.",
        "info": "· 서비스포트 — 호스트에서 쓸 포트 (예: 8080). 이미 쓰는 포트를 넣으면 기동이 실패합니다\n· healthcheck 를 붙여 두어 docker ps 의 Status 에 (healthy) 가 표시됩니다",
        "undo": "sudo rm -rf /opt/qterm-app"
      },
      {
        "title": "컨테이너 기동",
        "command": "cd /opt/qterm-app && sudo docker compose up -d && sleep 8 && sudo docker compose ps",
        "check": { "requireExitZero": true, "passContains": ["qterm-app"] },
        "desc": "이미지를 내려받고 컨테이너를 띄웁니다.",
        "undo": "cd /opt/qterm-app && sudo docker compose down"
      },
      {
        "title": "상태·헬스 확인",
        "command": "sudo docker ps -a --filter name=qterm-app --format '{{.Names}} | {{.Status}}'",
        "check": { "passContains": ["healthy"], "failContains": ["Exited", "Restarting"] },
        "desc": "Status 에 (healthy) 가 나와야 정상입니다.",
        "info": "start_period(5초) 안이면 (health: starting) 으로 보입니다.\n그럴 때는 10초쯤 뒤에 이 단계를 다시 실행하세요."
      },
      {
        "title": "서비스 응답 확인",
        "command": "curl -s -o /dev/null -w '응답 코드: %{http_code} / 소요 %{time_total}s\\n' http://127.0.0.1:<서비스포트>/ && curl -s http://127.0.0.1:<서비스포트>/",
        "check": { "passContains": ["응답 코드: 200", "배포 버전: v1"] },
        "desc": "컨테이너가 떠 있는 것과 서비스가 응답하는 것은 다릅니다. 실제로 내용이 내려오는지까지 봅니다.",
        "info": "외부에서도 확인하려면 보안그룹에 서비스포트를 열고,\n다른 장비에서 curl http://접속주소:포트/ 로 확인하세요."
      },
      {
        "title": "로그 확인",
        "command": "sudo docker logs --tail 30 qterm-app",
        "check": { "failContains": ["emerg", "cannot load", "bind() to"] },
        "desc": "접근 로그와 오류 로그를 봅니다. 앞 단계의 curl 요청이 접근 로그에 남아 있어야 합니다.",
        "info": "bind() to 0.0.0.0:80 failed — 컨테이너 안 포트 충돌\nemerg — nginx 설정 오류"
      },
      {
        "title": "자원 사용 확인",
        "check": {"passContains":["qterm-app"]},
        "command": "sudo docker stats --no-stream --format '{{.Name}} | CPU {{.CPUPerc}} | MEM {{.MemUsage}} | NET {{.NetIO}}'",
        "desc": "컨테이너가 쓰는 CPU·메모리를 한 번만 찍어 봅니다. 배포 직후 기준값으로 남겨 두면 나중에 비교하기 좋습니다.",
        "info": "--no-stream 을 빼면 화면이 계속 갱신되어 단계가 끝나지 않습니다.\n시나리오에서는 반드시 붙여야 합니다."
      },
      {
        "title": "재기동 확인",
        "command": "cd /opt/qterm-app && sudo docker compose restart && sleep 8 && sudo docker ps --filter name=qterm-app --format '{{.Names}} | {{.Status}}' && curl -s -o /dev/null -w '재기동 후 응답 코드: %{http_code}\\n' http://127.0.0.1:<서비스포트>/",
        "check": { "passContains": ["재기동 후 응답 코드: 200"], "failContains": ["Exited"] },
        "desc": "계획된 재기동입니다. 내린 뒤 다시 올라오고 서비스가 그대로 응답하는지 봅니다."
      },
      {
        "title": "강제 종료 후 자동 복구 확인",
        "command": "echo '[컨테이너 안에서 주 프로세스 종료]'; sudo docker exec qterm-app sh -c 'kill -TERM 1' 2>&1 | head -2; sleep 15; echo '[상태]'; sudo docker ps -a --filter name=qterm-app --format '{{.Names}} | {{.Status}}'; echo '[서비스]'; curl -s -o /dev/null -w '복구 후 응답 코드: %{http_code}\\n' http://127.0.0.1:<서비스포트>/",
        "check": { "passContains": ["복구 후 응답 코드: 200"], "failContains": ["Exited"] },
        "desc": "계획되지 않은 종료입니다. 컨테이너 안에서 주 프로세스를 죽여, 서비스가 저절로 돌아오는지 봅니다.",
        "warn": "운영 중인 컨테이너에는 하지 마세요. 이 단계는 시험용 qterm-app 만 대상으로 합니다.",
        "info": "왜 docker kill 이 아닌가\n밖에서 docker kill · docker stop 으로 죽이면 Docker 는 '사람이 일부러 내린 것' 으로 보고\nrestart 정책을 건너뜁니다(공식 문서). 컨테이너는 죽은 채 남고 응답 코드가 000 이 됩니다.\n장애를 흉내 내려면 컨테이너 안에서 프로세스가 죽어야 합니다.\nPID 1 에 SIGKILL 은 커널이 무시하므로(네임스페이스 init 보호), nginx 가 처리하는 SIGTERM 을 씁니다.\n\n복구가 안 되면\n· 정책 확인 — sudo docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' qterm-app\n· 되살리기 — sudo docker start qterm-app",
        "note": "restart 정책은 컨테이너가 10초 이상 정상으로 떠 있어야 무장됩니다.\n기동 직후 바로 돌리면 복구되지 않을 수 있으니, 앞 단계를 순서대로 거친 뒤 실행하세요."
      },
      {
        "title": "호스트 재부팅 후 자동 기동",
        "command": "",
        "desc": "껐다 켜도 컨테이너가 스스로 올라오는지는 실제 재부팅으로만 확인됩니다. 연결이 끊기므로 시나리오 안에서는 돌리지 않습니다.",
        "note": "재부팅        sudo reboot\n다시 접속한 뒤  sudo docker ps --filter name=qterm-app\n도커 자동 기동  systemctl is-enabled docker   (enabled 여야 함)"
      },
      {
        "title": "새 버전 배포 확인",
        "command": "cd /opt/qterm-app && echo 'QTerm 배포 확인 / 배포 버전: v2' | sudo tee html/index.html > /dev/null && sudo docker compose pull && sudo docker compose up -d --force-recreate && sleep 8 && curl -s http://127.0.0.1:<서비스포트>/",
        "check": { "passContains": ["배포 버전: v2"] },
        "desc": "내용을 바꾸고 다시 배포해, 새 버전이 실제로 반영되는지 봅니다. 운영에서는 이미지 태그를 올린 뒤 같은 명령을 씁니다.",
        "info": "v1 이 그대로 나오면 브라우저·프록시 캐시가 아니라 컨테이너가 옛 내용을 들고 있는 것입니다.\n--force-recreate 없이 up -d 만 하면 바뀐 게 없다고 보고 그대로 두는 경우가 있습니다."
      },
      {
        "title": "시험 컨테이너 정리",
        "command": "if [ -d /opt/qterm-app ]; then (cd /opt/qterm-app && sudo docker compose down); fi; echo '--- 남은 컨테이너 확인'; N=$(sudo docker ps -a --filter name=qterm-app --format '{{.Names}}' | wc -l); if [ \"$N\" = \"0\" ]; then echo '정리 완료 — 남은 컨테이너 없음'; else echo \"주의 — 아직 $N 개 남아 있습니다\"; sudo docker ps -a --filter name=qterm-app; fi",
        "check": { "passContains": ["정리 완료 — 남은 컨테이너 없음"], "failContains": ["주의 —"] },
        "desc": "시험 컨테이너를 내립니다. 목록에 qterm-app 이 남지 않아야 정상입니다.",
        "info": "· 이미지까지 지우기 — sudo docker image rm nginx:1.27-alpine\n· 안 쓰는 것을 한 번에 치우기 — sudo docker system prune -a (다른 이미지도 지우니 주의)"
      },
      {
        "title": "Docker 제거 (선택 — 검증 후 정리)",
        "manualOnly": true,
        "command": `if [ -d /opt/qterm-app ]; then (cd /opt/qterm-app && sudo docker compose down -v) || true; fi; cd /; ${APT} purge -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin; ${APT} autoremove -y; sudo rm -rf /opt/qterm-app /var/lib/docker /var/lib/containerd; sudo rm -f /etc/apt/sources.list.d/docker.list /etc/apt/keyrings/docker.asc; sudo gpasswd -d $USER docker 2>/dev/null || true; ${APT} update; echo '--- 정리 결과'; command -v docker > /dev/null && echo '주의 — docker 명령이 아직 있습니다' || echo 'docker 명령 없음'; [ -d /var/lib/docker ] && echo '주의 — /var/lib/docker 가 남아 있습니다' || echo '/var/lib/docker 없음'`,
        "check": { "passContains": ["docker 명령 없음", "/var/lib/docker 없음"], "failContains": ["주의 —"] },
        "desc": "검증이 끝나고 이 VM 을 원래대로 돌릴 때만 실행합니다. 앞 단계가 컨테이너만 내렸다면, 여기서 Docker 패키지·데이터·저장소 등록까지 걷어냅니다.",
        "warn": "이 VM 의 모든 컨테이너와 이미지가 사라집니다 — /var/lib/docker 를 통째로 지웁니다.\n이 시나리오로 만든 것 말고 다른 컨테이너가 돌고 있다면 실행하지 마세요.",
        "info": "하는 일 순서\n1) qterm-app 컨테이너·볼륨 내리기 (compose down -v)\n2) Docker 패키지 purge + autoremove\n3) /opt/qterm-app · /var/lib/docker · /var/lib/containerd 삭제\n4) Docker apt 저장소와 GPG 키 삭제, docker 그룹에서 현재 사용자 빼기\n5) docker 명령과 /var/lib/docker 가 정말 없어졌는지 확인\n\n컨테이너만 내리고 Docker 는 남기려면 이 단계 대신 앞의 '시험 컨테이너 정리' 까지만 하세요."
      }
    ]
  },

  {
    "id": "scn4",
    "diagnostic": true,
    "solution": "etc",
    "title": "[공통] 인스턴스 부팅 실패 진단",
    "summary": "VM 이 ERROR 상태이거나 부팅되지 않을 때, 원인을 단계적으로 좁혀 나갑니다.",
    "steps": [
      {
        "title": "인스턴스 상태 확인",
        "command": "openstack server list --all-projects --long",
        "desc": "ERROR 또는 비정상 상태인 인스턴스와 그 ID 를 확인합니다."
      },
      {
        "title": "인스턴스 상세 확인",
        "command": "openstack server show <SERVER_ID>",
        "desc": "fault 메시지, 배치된 호스트, 전원 상태 등 상세 정보를 확인합니다."
      },
      {
        "title": "콘솔 로그 확인",
        "command": "openstack console log show <SERVER_ID>",
        "desc": "커널 패닉, 파일시스템 오류 등 게스트 OS 의 부팅 콘솔 로그를 확인합니다."
      },
      {
        "title": "컴퓨트 서비스 상태",
        "command": "openstack compute service list",
        "desc": "배치된 노드의 nova-compute 가 down 되어 스케줄링이 막혔는지 확인합니다."
      },
      {
        "title": "하이퍼바이저 리소스",
        "command": "openstack hypervisor list --long",
        "desc": "vCPU/RAM 부족으로 스케줄링이 실패했는지 가용 리소스를 확인합니다."
      },
      {
        "title": "컴퓨트 노드에서 직접 확인",
        "command": "echo '별칭  |  인스턴스 이름  |  상태'; sudo virsh list --all | tail -n +3 | while read -r id d state rest; do [ -n \"$d\" ] || continue; n=$(sudo virsh dumpxml \"$d\" 2>/dev/null | grep -o 'nova:name>[^<]*' | head -1 | cut -c11-); echo \"$d  |  ${n:-(이름 없음)}  |  $state $rest\"; done | tee /tmp/qterm-doms.txt; [ -s /tmp/qterm-doms.txt ] || echo '주의 — 이 호스트에 libvirt 도메인이 없습니다 (컴퓨트 노드가 맞는지 확인하세요)'; rm -f /tmp/qterm-doms.txt",
        "check": { "failContains": ["주의 —"] },
        "desc": "컴퓨트 노드에 접속해 KVM/QEMU 레벨에서 도메인(VM) 상태를 직접 확인합니다. 별칭 옆에 포털의 인스턴스 이름을 함께 보여줍니다.",
        "info": "포털에서는 ACTIVE 인데 여기서 shut off 면 하이퍼바이저 쪽에서 죽은 것입니다.\n아예 목록에 없으면 이 노드에 스케줄링되지 않았거나 다른 노드로 옮겨간 것입니다."
      }
    ]
  },
  {
    "id": "scn12",
    "solution": "etc",
    "title": "[공통] 커널 파라미터(Sysctl) 튜닝",
    "summary": "현재 커널 값을 조회하고 sysctl.conf 에서 네트워크/소켓 파라미터를 수정한 뒤 적용·확인합니다.",
    "steps": [
      {
        "title": "현재 값 조회",
        "command": "sudo sysctl -a | grep tcp",
        "desc": "현재 적용된 TCP 관련 커널 파라미터 값을 확인합니다."
      },
      {
        "title": "sysctl.conf 편집",
        "command": "sudo vi /etc/sysctl.conf",
        "needsInput": true,
        "warn": "실행 시 vi 편집기가 열립니다. i(입력 모드)로 수정 → ESC → :wq! 로 저장·종료한 뒤 다음 단계를 진행하세요.",
        "desc": "예: net.ipv4.tcp_tw_reuse=1, net.core.somaxconn=1024 등 튜닝 값을 추가합니다.",
        "info": "vi 편집기 사용법: i → 입력 모드 시작 → 수정 → ESC → :wq! Enter (저장 후 종료) | 저장 없이 나가려면 :q! Enter",
        "note": "상단 [설정파일] 버튼으로 편집 권장. 의미를 모르는 값은 추가하지 마세요."
      },
      {
        "title": "즉시 적용",
        "check": {"requireExitZero":true},
        "command": "sudo sysctl -p",
        "desc": "sysctl.conf 의 변경분을 즉시 커널에 적용합니다.",
        "note": "원복 대상이 아닙니다 — 무엇을 어떻게 바꿨는지는 앞 단계에서 사람이 편집한 내용이라 도구가 알 수 없습니다.\n되돌리려면 /etc/sysctl.conf 에서 추가한 줄을 지우고 이 명령을 다시 실행하세요."
      },
      {
        "title": "반영 확인",
        "command": "sysctl net.ipv4.tcp_tw_reuse",
        "desc": "변경한 개별 파라미터가 실제로 적용됐는지 확인합니다."
      }
    ]
  },
  {
    "id": "scn13",
    "solution": "etc",
    "title": "[공통] 프로세스 장애 유발 및 로그 추적",
    "summary": "데몬을 강제 종료해 systemd 자동 복구 동작을 확인하고, 시스템 로그에서 원인을 추적합니다. (테스트 환경 권장)",
    "steps": [
      {
        "title": "프로세스 PID 확인",
        "command": "ps aux | grep <서비스명>",
        "desc": "대상 데몬의 PID 를 확인합니다. (예: nginx, sshd)"
      },
      {
        "title": "강제 종료",
        "check": {"requireExitZero":true},
        "command": "sudo kill -9 <PID>",
        "warn": "프로세스를 강제 종료합니다. 운영 중인 서비스의 PID 를 넣으면 실제 장애가 발생하니 테스트 대상인지 확인하세요.",
        "desc": "프로세스를 강제 종료해 장애 상황을 유발합니다.",
        "note": "⚠️ 운영 중인 서비스에는 사용하지 마세요. 테스트/검증 환경에서만 진행하세요."
      },
      {
        "title": "자동 복구 확인",
        "command": "systemctl status <서비스명>",
        "desc": "systemd 의 Restart 설정에 따라 서비스가 자동 재시작됐는지 확인합니다.",
        "check": { "passRegex": "active \\(running\\)", "failContains": ["failed", "inactive"] }
      },
      {
        "title": "서비스 로그 추적",
        "command": "sudo timeout 30 journalctl -u <서비스명> -f; echo '--- 30초 추적 종료'",
        "desc": "해당 서비스의 재시작·크래시 로그를 30초 동안 추적합니다.",
        "info": "계속 지켜보려면 터미널에서 sudo journalctl -u 서비스명 -f 를 직접 쓰세요(종료는 Ctrl+C). 검증 실행에서는 끝나지 않는 명령을 쓸 수 없어 시간을 끊어 두었습니다."
      },
      {
        "title": "시스템 로그 추적",
        "command": "sudo timeout 30 tail -f /var/log/syslog; echo '--- 30초 추적 종료'",
        "desc": "전체 시스템 로그를 30초 동안 추적합니다. (RHEL 계열은 /var/log/messages)",
        "info": "계속 지켜보려면 터미널에서 sudo tail -f /var/log/syslog 를 직접 쓰세요(종료는 Ctrl+C)."
      }
    ]
  },
  {
    "id": "scn-qcow2-image",
    "solution": "etc",
    "title": "[공통] 이미지(qcow2) 생성 및 다운로드",
    "summary": "서비스·패키지 설정이 완료된 인스턴스를 qcow2 포맷 이미지로 변환해 로컬로 다운로드합니다. 백업 또는 템플릿 이미지 생성 시 활용합니다.",
    "steps": [
      {
        "title": "서비스·패키지 설정 완료 확인",
        "command": "",
        "desc": "이미지로 굳히기 전, 인스턴스에서 필요한 서비스 설치 및 패키지·설정 구성이 모두 완료됐는지 확인합니다. 이 시점 이후의 변경사항은 이미지에 포함됩니다.",
        "info": "이후 모든 명령어는 sudo 권한(root 또는 sudo 가능한 계정)에서 실행합니다. root 계정이 아닌 경우 각 명령어 앞에 sudo를 붙이세요."
      },
      {
        "title": "qemu-img 설치",
        "command": `${APT} update && ${APT} install -y qemu-utils`,
        "onFailure": "retry",
        "onFailureCommand": APT_FIX,
        "onFailureDesc": APT_FIX_DESC,
        "check": { "requireExitZero": true, "failContains": ["Unable to locate package", "has no installation candidate"] },
        "desc": "qcow2 이미지 변환에 필요한 qemu-img 도구를 설치합니다.",
        "note": "RHEL/CentOS 계열: sudo yum install -y qemu-img"
      },
      {
        "title": "추가 디스크 생성 및 연결",
        "command": "",
        "desc": "포털에서 빈 볼륨(Block Storage)을 생성한 뒤 인스턴스에 연결합니다. 이미지 파일을 저장할 공간으로 사용되므로 OS 디스크(vda) 크기 이상으로 생성하세요.",
        "note": "볼륨 생성: 스토리지 > 볼륨 > 볼륨 생성 → 인스턴스에 연결"
      },
      {
        "title": "연결된 디스크 목록 확인",
        "command": "lsblk",
        "check": { "requireExitZero": true, "passContains": ["vdb"] },
        "desc": "볼륨이 정상 연결됐는지 확인합니다. vda(OS 디스크) 외에 vdb 등 추가 디스크가 표시되면 정상입니다. 이후 단계에서 해당 디스크명을 사용합니다.",
        "note": "이 시나리오는 뒤에서 /dev/vdb 를 그대로 포맷합니다 — 여기서 vdb 가 안 보이면 더 진행하면 안 됩니다."
      },
      {
        "title": "저장용 디스크 포맷",
        "check": {"requireExitZero":true},
        "command": "sudo mkfs.ext4 /dev/vdb",
        "expect": [{ "match": "Proceed anyway", "send": "y" }],
        "warn": "/dev/vdb 의 데이터가 모두 지워집니다. 새로 붙인 빈 디스크가 맞는지 앞 단계 lsblk 로 확인하세요.",
        "desc": "이미지 파일을 저장할 추가 디스크(vdb)를 ext4로 포맷합니다. lsblk에서 확인한 디스크명으로 교체하세요.",
        "note": "⚠️ vda는 OS 디스크입니다. 반드시 추가 연결한 디스크(vdb 등)에만 포맷을 진행하세요."
      },
      {
        "title": "포맷 결과 확인",
        "command": "sudo blkid /dev/vdb; lsblk -f /dev/vdb",
        "check": { "passContains": ["ext4"], "requireExitZero": true },
        "desc": "포맷이 실제로 적용됐는지 확인합니다. TYPE=\"ext4\" 와 UUID 가 보여야 정상입니다."
      },
      {
        "title": "마운트 포인트 생성",
        "command": "sudo mkdir -p /mnt/backup",
        "check": { "requireExitZero": true },
        "undo": "sudo rmdir /mnt/backup",
        "desc": "저장용 디스크를 마운트할 디렉토리를 생성합니다."
      },
      {
        "title": "마운트 포인트 생성 확인",
        "command": "ls -ld /mnt/backup",
        "check": { "passContains": ["/mnt/backup"], "requireExitZero": true },
        "desc": "디렉토리가 실제로 만들어졌는지 확인합니다."
      },
      {
        "title": "저장용 디스크 마운트",
        "command": "sudo mount /dev/vdb /mnt/backup",
        "check": { "requireExitZero": true, "failContains": ["wrong fs type", "does not exist"] },
        "undo": "sudo umount /mnt/backup",
        "desc": "/mnt/backup에 저장용 디스크를 마운트합니다. 이후 생성되는 이미지 파일이 이 경로에 저장됩니다."
      },
      {
        "title": "마운트 상태 및 여유 용량 확인",
        "command": "findmnt /mnt/backup; df -h /mnt/backup",
        "check": { "passContains": ["/mnt/backup"], "requireExitZero": true },
        "desc": "마운트 여부와 함께 남은 용량을 확인합니다. 다음 단계에서 OS 디스크 전체를 이미지로 뜨므로, vda 크기보다 여유 공간이 커야 합니다.",
        "warn": "여유 공간이 부족하면 변환이 중간에 실패합니다. df -h 의 Avail 값을 반드시 확인하세요."
      },
      {
        "title": "vda 디스크를 qcow2 이미지로 변환",
        "check": {"requireExitZero":true},
        "command": "sudo qemu-img convert -O qcow2 /dev/vda /mnt/backup/ubuntu_image.qcow2",
        "undo": "sudo rm -f /mnt/backup/ubuntu_image.qcow2",
        "desc": "OS 디스크(vda) 전체를 qcow2 포맷 이미지 파일로 변환합니다. 디스크 용량에 따라 수 분~수십 분 소요됩니다.",
        "info": "변환 중 인스턴스를 사용하면 이미지가 불일치 상태가 될 수 있습니다. 가능하면 서비스를 중지한 상태에서 진행하세요."
      },
      {
        "title": "변환 진행 상태 확인 (다른 터미널에서)",
        "command": "ls -lh /mnt/backup/ubuntu_image.qcow2",
        "desc": "변환 명령은 완료까지 출력이 없습니다. 다른 터미널 탭에서 이 명령을 반복 실행해 파일 크기가 증가하는지 확인하세요. 크기 증가가 멈추면 변환 완료입니다."
      },
      {
        "title": "이미지 압축 변환 (선택)",
        "check": {"requireExitZero":true},
        "command": "sudo qemu-img convert -c -O qcow2 /mnt/backup/ubuntu_image.qcow2 /mnt/backup/ubuntu_image_compressed.qcow2",
        "undo": "sudo rm -f /mnt/backup/ubuntu_image_compressed.qcow2",
        "desc": "생성된 이미지에 압축을 적용해 파일 크기를 줄입니다. 다운로드 시간을 단축하려면 이 단계를 먼저 진행하세요.",
        "note": "압축 옵션(-c)은 변환 시간이 더 걸리지만 파일 크기를 크게 줄여줍니다. 원본 이미지는 삭제해 공간을 확보할 수 있습니다."
      },
      {
        "title": "압축 결과 크기 비교",
        "command": "ls -lh /mnt/backup/*.qcow2; df -h /mnt/backup",
        "check": { "passContains": ["qcow2"], "requireExitZero": true },
        "desc": "원본과 압축본의 파일 크기를 나란히 확인합니다. 압축본이 원본보다 작아야 정상입니다.",
        "note": "압축본 크기가 0 이거나 원본과 같으면 변환이 실패한 것입니다. 남은 용량(df)도 함께 확인하세요."
      },
      {
        "title": "이미지 파일 확인",
        "check": {"passContains":["file format: qcow2"]},
        "command": "qemu-img info /mnt/backup/ubuntu_image.qcow2",
        "desc": "생성된 이미지 파일의 포맷·가상 크기·실제 디스크 크기를 확인합니다."
      },
      {
        "title": "로컬로 다운로드",
        "command": "scp <username>@<원격_IP>:/mnt/backup/ubuntu_image.qcow2 ./",
        "manualOnly": true,
        "desc": "이 명령은 **내 PC 의 터미널**에서 실행하는 것입니다. 검증 실행이 쓰는 원격 셸에서 돌리면 그 서버가 자기 자신에게 접속하려 들어 아무 소용이 없습니다.\n더 쉬운 방법은 이 앱의 파일 탐색기로 /mnt/backup 에 들어가 파일을 내려받는 것입니다.",
        "info": "파일 크기가 클 경우 다운로드 시간이 상당히 소요됩니다. 파일 탐색기를 이용하면 진행률 표시줄로 상태를 확인할 수 있습니다."
      }
    ]
  }
]
