// 작업 시나리오(플레이북) — 순서가 있는 명령어 흐름.
// 명령어_편집.md 에서 자동 생성됨. <...> 플레이스홀더는 실행 대신 "입력".

export interface ScenarioStep {
  title: string
  command: string
  desc: string
  note?: string
  /** 파란 안내 박스 (공통 적용 범위, 참고 정보 등) */
  info?: string
  /** 빨간 경고 박스 (Enter 여러 번 필요 등, 다음 단계 실행 전 주의) */
  warn?: string
  /** 아코디언 코드 예시 (conf 파일 등 긴 입력 내용) */
  code?: string
}

export interface Scenario {
  id: string
  solution: string
  title: string
  summary: string
  steps: ScenarioStep[]
}

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
        "command": "lsblk -f",
        "desc": "LABEL 컬럼에 config-2 가 표시된 장치를 확인합니다. 보통 sr0(CD-ROM 형태)로 연결됩니다.",
        "note": "config-2 라벨이 보이지 않으면 인스턴스 생성 시 설정 드라이브 옵션이 활성화되지 않은 것입니다."
      },
      {
        "title": "마운트 포인트 생성",
        "command": "sudo mkdir -p /mnt/config",
        "desc": "설정 드라이브를 연결할 디렉토리를 생성합니다."
      },
      {
        "title": "설정 드라이브 마운트",
        "command": "sudo mount /dev/sr0 /mnt/config",
        "desc": "config-2 장치를 /mnt/config 에 마운트합니다. lsblk에서 확인한 장치명이 sr0 가 아닌 경우 해당 이름으로 교체하세요."
      },
      {
        "title": "파일 구조 확인",
        "command": "ls -R /mnt/config",
        "desc": "설정 드라이브 내부의 전체 파일·디렉토리 목록을 확인합니다. openstack/latest/ 하위에 meta_data.json, network_data.json, user_data 등이 있어야 합니다."
      },
      {
        "title": "메타데이터 조회",
        "command": "cat /mnt/config/openstack/latest/meta_data.json | python3 -m json.tool",
        "desc": "인스턴스 ID(uuid), 호스트 네임, 키 페어 이름 등 인스턴스 기본 정보를 확인합니다. python3 -m json.tool 로 들여쓰기 정렬해 출력합니다.",
        "note": "jq 가 설치된 경우: jq . /mnt/config/openstack/latest/meta_data.json"
      },
      {
        "title": "네트워크 데이터 조회",
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
        "note": "포털 항목명 → 실제 메타데이터 키\n디스크 Read IOPS   → quota:disk_read_iops_sec\n디스크 Write IOPS  → quota:disk_write_iops_sec\n디스크 Read BYTES  → quota:disk_read_bytes_sec\n디스크 Write BYTES → quota:disk_write_bytes_sec\n\n예시: Read IOPS = 50, Write IOPS = 50, Read BYTES = 10485760(10MB/s), Write BYTES = 10485760(10MB/s)\n\n⚠ TOTAL IOPS / TOTAL BYTES는 개별 Read·Write 키와 동시에 설정하면 인스턴스 생성 오류가 발생합니다. TOTAL 항목은 Read·Write 키 없이 별도로 설정하세요.\n디스크 TOTAL IOPS  → quota:disk_total_iops_sec\n디스크 TOTAL BYTES → quota:disk_total_bytes_sec"
      },
      {
        "title": "인스턴스 생성",
        "command": "",
        "desc": "LNB > 컴퓨트 > 인스턴스 생성 시 위에서 만든 QoS 적용 인스턴스 유형을 선택하여 생성합니다.",
        "note": "인스턴스 유형 QoS는 인스턴스 생성 시점에 적용됩니다. 이후 인스턴스 유형을 변경해도 기존 인스턴스에는 반영되지 않습니다."
      },
      {
        "title": "인스턴스 별칭 확인",
        "command": "virsh list --all",
        "desc": "하이퍼바이저 호스트에서 실행합니다. Name 컬럼에 표시되는 instance_alias 형태의 별칭을 확인합니다.",
        "info": "virsh는 OpenStack 인스턴스 UUID가 아닌 libvirt 도메인 별칭(instance_alias)으로 조회해야 합니다.\n포털의 인스턴스 이름과 다르므로 반드시 virsh list --all 로 별칭을 먼저 확인하세요."
      },
      {
        "title": "하이퍼바이저 호스트에서 적용 확인",
        "command": "virsh dumpxml <instance_alias> | grep -A 10 iotune",
        "desc": "위에서 확인한 인스턴스 별칭(instance_alias)으로 실행합니다. <iotune> 블록에 read_iops_sec, write_iops_sec 등이 설정값대로 출력되어야 합니다.",
        "info": "이 명령어는 인스턴스 터미널이 아닌, 해당 인스턴스가 배치된 컴퓨트 노드(하이퍼바이저 호스트)에서 실행해야 합니다."
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
        "command": "sudo apt update",
        "desc": "fio 패키지 설치 전 저장소를 업데이트합니다.",
        "note": "업데이트가 실패하면 DNS 설정을 확인하세요. nameserver가 없으면 외부 패키지 서버에 접근할 수 없습니다.\n확인: cat /etc/resolv.conf\n미설정 시: netplan 또는 /etc/resolv.conf에 nameserver를 추가 후 적용하세요."
      },
      {
        "title": "fio 및 libaio 설치",
        "command": "sudo apt install -y fio libaio1t64 || sudo apt install -y fio libaio1",
        "desc": "디스크 성능 테스트 도구 fio와 비동기 I/O 라이브러리 libaio를 설치합니다. Ubuntu 24.04+는 libaio1t64, 이전 버전은 libaio1을 사용합니다."
      },
      {
        "title": "IOPS 쓰기 테스트",
        "command": "sudo fio --name=qos-randwrite --rw=randwrite --bs=4k --direct=1 --ioengine=libaio --iodepth=32 --size=100M --runtime=30 --filename=/tmp/fio-test --group_reporting",
        "desc": "무작위 4K 쓰기로 IOPS를 측정합니다. write_iops_sec 제한값 부근에서 수렴하는지 확인합니다.",
        "info": "--direct=1: 페이지 캐시를 우회하여 디스크 QoS가 직접 측정됩니다.\n--ioengine=libaio: 비동기 I/O 엔진으로 iodepth=32가 실제로 동작합니다."
      },
      {
        "title": "IOPS 읽기 테스트",
        "command": "sudo fio --name=qos-randread --rw=randread --bs=4k --direct=1 --ioengine=libaio --iodepth=32 --size=100M --runtime=30 --filename=/tmp/fio-test --group_reporting",
        "desc": "무작위 4K 읽기로 IOPS를 측정합니다. read_iops_sec 제한값 부근에서 수렴하는지 확인합니다."
      },
      {
        "title": "대역폭 쓰기 테스트",
        "command": "sudo fio --name=qos-write-bw --rw=write --bs=1m --direct=1 --ioengine=libaio --iodepth=32 --size=500M --runtime=30 --filename=/tmp/fio-test --group_reporting",
        "desc": "순차 1MB 쓰기로 대역폭을 측정합니다. write_bytes_sec 제한값(예: 10MB/s) 부근에서 수렴하는지 확인합니다."
      },
      {
        "title": "대역폭 읽기 테스트",
        "command": "sudo fio --name=qos-read-bw --rw=read --bs=1m --direct=1 --ioengine=libaio --iodepth=32 --size=500M --runtime=30 --filename=/tmp/fio-test --group_reporting",
        "desc": "순차 1MB 읽기로 대역폭을 측정합니다. read_bytes_sec 제한값 부근에서 수렴하는지 확인합니다."
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
        "command": "virsh list --all",
        "desc": "하이퍼바이저 호스트에서 실행합니다. Name 컬럼에 표시되는 instance_alias 형태의 별칭을 확인합니다.",
        "info": "virsh는 OpenStack 인스턴스 UUID가 아닌 libvirt 도메인 별칭(instance_alias)으로 조회해야 합니다.\n포털의 인스턴스 이름과 다르므로 반드시 virsh list --all 로 별칭을 먼저 확인하세요."
      },
      {
        "title": "하이퍼바이저 호스트에서 적용 확인",
        "command": "virsh dumpxml <instance_alias> | grep -A 10 bandwidth",
        "desc": "위에서 확인한 인스턴스 별칭(instance_alias)으로 실행합니다. <interface> 내 <bandwidth> 블록에 inbound/outbound average, peak, burst 값이 출력되어야 합니다.",
        "info": "이 명령어는 인스턴스 터미널이 아닌, 해당 인스턴스가 배치된 컴퓨트 노드(하이퍼바이저 호스트)에서 실행해야 합니다."
      },
      {
        "title": "iperf3 서버 구성 (별도 인스턴스)",
        "command": "sudo apt update && sudo apt install -y iperf3 && iperf3 -s",
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
        "command": "sudo apt update",
        "desc": "iperf3 패키지 설치 전 저장소를 업데이트합니다.",
        "note": "업데이트가 실패하면 DNS 설정을 확인하세요. nameserver가 없으면 외부 패키지 서버에 접근할 수 없습니다.\n확인: cat /etc/resolv.conf\n미설정 시: netplan 또는 /etc/resolv.conf에 nameserver를 추가 후 적용하세요."
      },
      {
        "title": "iperf3 설치",
        "command": "sudo apt install -y iperf3",
        "desc": "네트워크 대역폭 측정 도구 iperf3를 설치합니다."
      },
      {
        "title": "아웃바운드(업로드) 대역폭 테스트",
        "command": "iperf3 -c <iperf3-server-ip> -t 30 -i 5",
        "desc": "인스턴스에서 서버 방향(아웃바운드)으로 30초간 대역폭을 측정합니다.",
        "info": "【결과 확인】 출력 하단 '- - -' 구분선 아래 sender 줄의 Bitrate 열을 확인하세요.\n  [5] 0.00-30.01 sec  30.5 MBytes  8.53 Mbits/sec  sender  ← 이 값\n\nvif_outbound_average(KBps) × 8 = 제한 Mbps 와 근접하면 정상입니다.\n예: outbound_average=1024 KBps → 약 8 Mbps\n※ QoS는 KBps(킬로바이트/초), iperf3는 Mbps(메가비트/초) 단위이므로 × 8로 환산합니다. (1 Byte = 8 bit)\n\n구간별 Bitrate가 초반에 높다가 이후 수렴하는 것은 burst 소진 후 average 제한이 걸린 정상 동작입니다."
      },
      {
        "title": "인바운드(다운로드) 대역폭 테스트",
        "command": "iperf3 -c <iperf3-server-ip> -t 30 -i 5 -R",
        "desc": "-R 플래그로 트래픽 방향을 역전(서버 → 이 인스턴스)하여 인바운드 대역폭을 측정합니다.",
        "info": "【결과 확인】 출력 하단 '- - -' 구분선 아래 sender 줄의 Bitrate 열을 확인하세요.\n  [5] 0.00-30.01 sec  30.5 MBytes  8.53 Mbits/sec  sender  ← 이 값\n\nvif_inbound_average(KBps) × 8 = 제한 Mbps 와 근접하면 정상입니다.\n예: inbound_average=1024 KBps → 약 8 Mbps\n※ QoS는 KBps(킬로바이트/초), iperf3는 Mbps(메가비트/초) 단위이므로 × 8로 환산합니다. (1 Byte = 8 bit)\n\n-R(Reverse): 서버 → 이 인스턴스 방향으로 전송하므로 인바운드 QoS 제한이 측정됩니다."
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
        "command": "sudo apt-get update",
        "desc": "nginx 설치 전 패키지 목록을 최신화합니다. 인스턴스 2대 모두 수행하세요.",
        "note": "업데이트가 실패하면 DNS 설정을 확인하세요. nameserver가 없으면 외부 패키지 서버에 접근할 수 없습니다.\n확인: cat /etc/resolv.conf\n미설정 시: netplan 또는 /etc/resolv.conf에 nameserver를 추가 후 적용하세요."
      },
      {
        "title": "nginx 설치",
        "command": "sudo apt install -y nginx",
        "desc": "웹서버(nginx)를 설치합니다. 인스턴스 2대 모두 수행하세요."
      },
      {
        "title": "로드밸런서 생성",
        "command": "",
        "desc": "LNB 영역에서 VPC > 로드밸런서로 이동해 로드밸런서를 생성합니다.",
        "note": "Step1 기본 정보: 인스턴스에 할당한 인터페이스의 세그먼트를 선택하세요.\nStep2 리스너: 프로토콜 HTTP를 선택하세요.\nStep3 풀: 알고리즘 ROUND_ROBIN, 프로토콜 HTTP를 선택하세요.\nStep4 풀 멤버: 인스턴스 2대를 등록하고 포트를 80으로 설정하세요. (임계치 사용 여부: 미사용)\nStep5 헬스 체크: 타입 HTTP를 선택하세요."
      },
      {
        "title": "ROUND ROBIN 통신 확인",
        "command": "curl http://<vip>",
        "desc": "로드밸런서 VIP로 curl 요청을 반복해 인스턴스 간 순차적 통신(ROUND ROBIN)을 확인합니다.",
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
        "command": "mkdir ssl-certs && cd ssl-certs",
        "desc": "인증서 파일을 한곳에 모아 관리하기 위해 작업 디렉토리를 생성하고 이동합니다."
      },
      {
        "title": "Root CA 키 생성",
        "command": "openssl genrsa -out ca.key 2048",
        "desc": "Root CA 서명에 사용할 RSA 2048비트 개인 키를 생성합니다."
      },
      {
        "title": "CA 키 권한 제한",
        "command": "chmod 600 ca.key",
        "desc": "CA 개인 키를 소유자만 읽을 수 있도록 권한을 제한합니다."
      },
      {
        "title": "ca.conf 파일 작성",
        "command": "cat > ca.conf << 'EOF'\n[ req ]\ndefault_bits            = 2048\ndefault_md              = sha1\ndefault_keyfile         = ca.key\ndistinguished_name      = req_distinguished_name\nextensions              = v3_ca\nreq_extensions          = v3_ca\n\n[ v3_ca ]\nbasicConstraints        = critical, CA:TRUE, pathlen:0\nsubjectKeyIdentifier    = hash\nkeyUsage                = keyCertSign, cRLSign\nnsCertType              = sslCA, emailCA, objCA\n\n[ req_distinguished_name ]\ncountryName             = Country Name (2 letter code)\ncountryName_default     = KR\ncountryName_min         = 2\ncountryName_max         = 2\n\norganizationName        = Organization Name (eg, company)\norganizationName_default = Example Inc.\n\ncommonName              = Common Name (eg, your name or your server's hostname)\ncommonName_default      = Example Root CA\ncommonName_max          = 64\nEOF",
        "desc": "Root CA 인증서 생성에 필요한 설정 파일을 heredoc으로 바로 작성합니다. vi 진입 없이 '실행' 버튼으로 파일이 즉시 생성됩니다.",
        "code": "[ req ]\ndefault_bits            = 2048\ndefault_md              = sha1\ndefault_keyfile         = ca.key\ndistinguished_name      = req_distinguished_name\nextensions              = v3_ca\nreq_extensions          = v3_ca\n\n[ v3_ca ]\nbasicConstraints        = critical, CA:TRUE, pathlen:0\nsubjectKeyIdentifier    = hash\nkeyUsage                = keyCertSign, cRLSign\nnsCertType              = sslCA, emailCA, objCA\n\n[ req_distinguished_name ]\ncountryName             = Country Name (2 letter code)\ncountryName_default     = KR\ncountryName_min         = 2\ncountryName_max         = 2\n\norganizationName        = Organization Name (eg, company)\norganizationName_default = Example Inc.\n\ncommonName              = Common Name (eg, your name or your server's hostname)\ncommonName_default      = Example Root CA\ncommonName_max          = 64"
      },
      {
        "title": "Root CA CSR 생성",
        "command": "openssl req -new -sha256 -key ca.key -config ca.conf -out ca.csr",
        "desc": "ca.conf의 기본값이 자동 적용됩니다. 입력 프롬프트가 나타나면 Enter를 눌러 기본값으로 진행합니다.",
        "warn": "실행 후 필드별 입력 프롬프트가 순서대로 나타납니다. 프롬프트가 모두 끝나 프롬프트(ubuntu@...$)로 돌아올 때까지 Enter를 여러 번 눌러야 합니다. 다음 단계를 성급하게 실행하지 마세요."
      },
      {
        "title": "Root CA 인증서 생성",
        "command": "openssl x509 -req -sha256 -days 3650 -extensions v3_ca -set_serial 1 -in ca.csr -signkey ca.key -extfile ca.conf -out ca.crt",
        "desc": "CSR을 자가 서명하여 유효기간 10년의 Root CA 인증서(ca.crt)를 생성합니다."
      },
      {
        "title": "서비스 키 생성",
        "command": "openssl genrsa -out service.key 2048",
        "desc": "로드밸런서 SSL에 사용할 서비스 인증서의 개인 키를 생성합니다."
      },
      {
        "title": "서비스 키 권한 제한",
        "command": "chmod 600 service.key",
        "desc": "서비스 개인 키를 소유자만 읽을 수 있도록 권한을 제한합니다."
      },
      {
        "title": "service.conf 파일 작성",
        "command": "cat > service.conf << 'EOF'\n[ req ]\ndefault_bits            = 2048\ndefault_md              = sha1\ndefault_keyfile         = ca.key\ndistinguished_name      = req_distinguished_name\nextensions              = v3_user\n\n[ v3_user ]\nbasicConstraints        = CA:FALSE\nauthorityKeyIdentifier  = keyid,issuer\nsubjectKeyIdentifier    = hash\nkeyUsage                = nonRepudiation, digitalSignature, keyEncipherment\nextendedKeyUsage        = serverAuth,clientAuth\nsubjectAltName          = @alt_names\n\n[ alt_names ]\nIP.1 = <로드밸런서 VIP>\n\n[ req_distinguished_name ]\ncountryName             = Country Name (2 letter code)\ncountryName_default     = KR\ncountryName_min         = 2\ncountryName_max         = 2\n\norganizationName        = Organization Name (eg, company)\norganizationName_default = Example Inc.\n\norganizationalUnitName  = Organizational Unit Name (eg, section)\norganizationalUnitName_default = Example Project\n\ncommonName              = Common Name (eg, your name or your server's hostname)\ncommonName_default      = <로드밸런서 VIP>\ncommonName_max          = 64\nEOF",
        "desc": "서비스 인증서 생성에 필요한 설정 파일을 heredoc으로 작성합니다. '입력' 버튼을 누르면 VIP 값을 한 번 입력받아 IP.1과 commonName_default 두 곳에 자동으로 채워 넣고 실행합니다.",
        "code": "[ req ]\ndefault_bits            = 2048\ndefault_md              = sha1\ndefault_keyfile         = ca.key\ndistinguished_name      = req_distinguished_name\nextensions              = v3_user\n\n[ v3_user ]\nbasicConstraints        = CA:FALSE\nauthorityKeyIdentifier  = keyid,issuer\nsubjectKeyIdentifier    = hash\nkeyUsage                = nonRepudiation, digitalSignature, keyEncipherment\nextendedKeyUsage        = serverAuth,clientAuth\nsubjectAltName          = @alt_names\n\n[ alt_names ]\nIP.1 = <로드밸런서 VIP>\n\n[ req_distinguished_name ]\ncountryName             = Country Name (2 letter code)\ncountryName_default     = KR\ncountryName_min         = 2\ncountryName_max         = 2\n\norganizationName        = Organization Name (eg, company)\norganizationName_default = Example Inc.\n\norganizationalUnitName  = Organizational Unit Name (eg, section)\norganizationalUnitName_default = Example Project\n\ncommonName              = Common Name (eg, your name or your server's hostname)\ncommonName_default      = <로드밸런서 VIP>\ncommonName_max          = 64"
      },
      {
        "title": "서비스 CSR 생성",
        "command": "openssl req -new -sha256 -key service.key -config service.conf -out service.csr",
        "desc": "service.conf의 기본값이 자동 적용됩니다. 입력 프롬프트에서 Enter를 눌러 기본값으로 진행합니다.",
        "warn": "실행 후 필드별 입력 프롬프트가 순서대로 나타납니다. 프롬프트가 모두 끝나 프롬프트(ubuntu@...$)로 돌아올 때까지 Enter를 여러 번 눌러야 합니다. 다음 단계를 성급하게 실행하지 마세요."
      },
      {
        "title": "서비스 인증서 서명 (Root CA로 서명)",
        "command": "openssl x509 -req -sha256 -days 1825 -extensions v3_user -in service.csr -CA ca.crt -CAcreateserial -CAkey ca.key -extfile service.conf -out service.crt",
        "desc": "Root CA로 서비스 CSR에 서명하여 유효기간 5년의 서비스 인증서(service.crt)를 생성합니다."
      },
      {
        "title": "PKCS#12 형식으로 변환",
        "command": "openssl pkcs12 -export -out service.p12 -inkey service.key -in service.crt -certfile ca.crt",
        "desc": "서비스 키 + 서비스 인증서 + CA 인증서를 하나의 PKCS#12(.p12) 파일로 묶습니다. export 비밀번호 입력 시 Enter를 눌러 빈 값으로 설정해도 됩니다.",
        "note": "OpenStack LB는 PKCS#12를 Base64로 인코딩한 값을 요구합니다.",
        "warn": "실행 후 'Enter Export Password:'와 'Verifying - Enter Export Password:' 두 번의 입력 프롬프트가 나타납니다. 두 번 모두 Enter를 눌러 프롬프트로 돌아온 뒤 다음 단계를 진행하세요."
      },
      {
        "title": "Base64 인코딩",
        "command": "base64 service.p12 > service.p12.base64",
        "desc": "PKCS#12 바이너리 파일을 Base64 텍스트로 인코딩합니다."
      },
      {
        "title": "생성 파일 목록 확인",
        "command": "ls -l",
        "desc": "ca.key, ca.crt, service.key, service.crt, service.p12, service.p12.base64 파일이 모두 생성되었는지 확인합니다."
      },
      {
        "title": "Base64 파일 내용 출력 및 복사",
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
        "desc": "클라이언트용 인스턴스에 SSH로 접속합니다. 앞서 생성한 ca.crt 파일이 해당 인스턴스에 있어야 합니다. scp 등으로 미리 전송하세요."
      },
      {
        "title": "CA 인증서 시스템에 복사",
        "command": "cp -r ca.crt /usr/local/share/ca-certificates/",
        "desc": "Root CA 인증서를 시스템 인증서 저장소에 복사합니다."
      },
      {
        "title": "시스템 인증서 업데이트",
        "command": "sudo update-ca-certificates",
        "desc": "시스템 CA 인증서 목록을 갱신합니다. 'Updating certificates in /etc/ssl/certs...' 메시지와 함께 1 added 가 출력되면 정상입니다."
      },
      {
        "title": "HTTPS 통신 확인",
        "command": "curl -v --cacert /usr/local/share/ca-certificates/ca.crt https://<로드밸런서 VIP>",
        "desc": "로드밸런서 VIP로 HTTPS 요청을 보냅니다. SSL 핸드셰이크가 성공하고 풀 멤버의 HTTP 응답 본문이 반환되면 정상입니다.",
        "note": "응답에서 'SSL connection using TLS...' 및 'Server certificate' 정보가 출력되면 인증서가 올바르게 적용된 것입니다."
      }
    ]
  },
  {
    "id": "scn-nc-port-check",
    "solution": "OpenStack",
    "title": "[네트워크] nc 포트 연결 상태 체크 동작 확인",
    "summary": "nc(netcat)로 VM 간 포트 연결 상태를 실시간으로 확인하며, Live 및 Cold 마이그레이션 중 통신 중단 여부를 검증합니다.",
    "steps": [
      {
        "title": "인스턴스 A, B 생성",
        "command": "",
        "desc": "LNB 영역에서 컴퓨트 > 인스턴스로 이동해 인스턴스를 2대 생성합니다. 인스턴스 A는 nc 포트 수신 대기 역할, 인스턴스 B는 A로 포트 연결 테스트를 수행하는 역할입니다. 두 인스턴스는 동일 네트워크 대역에 위치해야 합니다."
      },
      {
        "title": "인스턴스 A에 터미널 접속",
        "command": "",
        "desc": "인스턴스 A에 SSH로 접속합니다. OpenStack 포털의 웹 콘솔 또는 이 앱의 SSH 연결을 사용하세요."
      },
      {
        "title": "패키지 목록 업데이트",
        "command": "sudo apt update",
        "desc": "netcat 설치에 앞서 패키지 목록을 최신화합니다.",
        "note": "업데이트가 실패하면 DNS 설정을 확인하세요. nameserver가 없으면 외부 패키지 서버에 접근할 수 없습니다.\n확인: cat /etc/resolv.conf\n미설정 시: netplan 또는 /etc/resolv.conf에 nameserver를 추가 후 적용하세요."
      },
      {
        "title": "netcat 설치",
        "command": "sudo apt install -y netcat",
        "desc": "포트 연결 테스트에 사용할 netcat을 설치합니다.",
        "note": "RHEL/CentOS 계열: yum install -y nmap-ncat"
      },
      {
        "title": "포트 수신 대기 시작 (인스턴스 A)",
        "command": "nc -l -p <포트번호>",
        "desc": "인스턴스 A에서 지정한 포트로 수신 대기 상태로 진입합니다. 다른 VM이 해당 포트로 연결을 시도하면 응답합니다.",
        "info": "포트 번호 예시: 9999 (SSH 22 대신 임의 포트 권장). 이 명령은 터미널을 점유하므로 별도 탭/창을 사용하세요."
      },
      {
        "title": "포트 연결 일회성 확인 (인스턴스 B 또는 다른 터미널)",
        "command": "nc -zv <인스턴스A_IP> <포트번호>",
        "desc": "인스턴스 B 또는 동일 네트워크의 다른 서버에서 인스턴스 A IP로 포트 연결을 시도합니다.",
        "note": "성공 시: Connection to <IP> <port> port [tcp] succeeded!\n실패 시: nc: connect to <IP> port <port> (tcp) failed: Connection refused"
      },
      {
        "title": "지속 통신 루프 시작",
        "command": "while true; do nc -zv <인스턴스A_IP> <포트번호>; sleep 1; done",
        "desc": "1초 간격으로 포트 연결을 반복 시도합니다. 마이그레이션 진행 중 통신이 끊기는지 실시간으로 관찰합니다.",
        "info": "루프를 실행한 상태로 다음 마이그레이션 단계를 진행합니다. 종료: Ctrl+C"
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
        "title": "마이그레이션 완료 후 호스트 변경 확인",
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
        "desc": "인스턴스 A가 재시작된 후 포트 연결이 재개되는지 확인합니다. 마이그레이션 중에는 통신이 끊기고, 재시작 완료 후 succeeded! 메시지가 출력되면 재연결 성공입니다.",
        "note": "인스턴스 A에서 nc -l -p <포트> 를 다시 실행한 뒤 확인하세요."
      },
      {
        "title": "마이그레이션 완료 후 호스트 변경 확인",
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
        "command": "sudo ip link set <IFACE> down",
        "desc": "특정 인터페이스를 내립니다. <IFACE> 는 eth1 등 대상 인터페이스명으로 바꾸세요.",
        "note": "⚠️ SSH 로 접속 중인 인터페이스를 내리면 연결이 끊깁니다. 관리용이 아닌 NIC 에만 사용하세요."
      },
      {
        "title": "인터페이스 활성화",
        "command": "sudo ip link set <IFACE> up",
        "desc": "내렸던 인터페이스를 다시 올립니다."
      },
      {
        "title": "Netplan 설정 편집",
        "command": "sudo vi /etc/netplan/50-cloud-init.yaml",
        "desc": "IP 주소, 게이트웨이, nameservers(DNS) 를 설정합니다. (Ubuntu 기준)",
        "info": "vi 편집기 사용법: i → 입력 모드 시작 → 수정 → ESC → :wq! Enter (저장 후 종료) | 저장 없이 나가려면 :q! Enter",
        "note": "상단 [설정 파일 뷰어] 버튼으로 편집하는 것이 안전합니다. YAML 은 들여쓰기(공백 2칸)에 민감합니다. 50-cloud-init.yaml 파일은 다른 파일로 대체될 수 있습니다. 파일명을 확인하세요."
      },
      {
        "title": "Netplan 적용",
        "command": "sudo netplan apply",
        "desc": "변경한 Netplan 설정을 적용합니다.",
        "note": "⚠️ 설정 오류 시 네트워크가 끊길 수 있습니다. 원격 작업이면 먼저 `sudo netplan try`(120초 후 자동 롤백)로 검증하세요."
      },
      {
        "title": "외부 통신 확인",
        "command": "ping -c 4 google.com",
        "desc": "DNS 이름 해석과 외부 인터넷 도달 여부를 한 번에 확인합니다."
      }
    ]
  },
  {
    "id": "scn9",
    "solution": "OpenStack",
    "title": "[네트워크] 포트 통신 동작 확인",
    "summary": "서버의 리슨 포트 현황을 파악하고 nc, nmap 등을 활용해 대상 서버의 TCP/UDP 포트 통신을 다각도로 검증합니다.",
    "steps": [
      {
        "title": "도구 설치 (필요 시)",
        "command": "sudo apt install -y netcat-openbsd nmap",
        "desc": "포트 점검용 nc(netcat)와 nmap을 설치합니다.",
        "note": "RHEL/CentOS 계열은 sudo dnf install -y nmap-ncat nmap"
      },
      {
        "title": "로컬 리슨 포트 확인",
        "command": "ss -tunlp",
        "desc": "현재 서버가 어떤 TCP/UDP 포트를 어떤 프로세스로 리슨 중인지 확인합니다. LISTEN 상태의 포트와 연결된 프로세스명을 함께 확인하세요."
      },
      {
        "title": "방화벽 상태 확인",
        "command": "sudo ufw status",
        "desc": "UFW 방화벽 활성화 여부와 허용/차단 규칙을 확인합니다. 포트가 열려있어도 방화벽이 막고 있으면 통신이 차단됩니다.",
        "note": "iptables 기반 환경은 sudo iptables -L -n --line-numbers"
      },
      {
        "title": "TCP 포트 통신 확인",
        "command": "nc -zv <Target_IP> <Port>",
        "desc": "대상 서버의 특정 TCP 포트로 연결이 되는지 확인합니다. 'Connection succeeded' 출력이면 정상 통신입니다."
      },
      {
        "title": "UDP 포트 통신 확인",
        "command": "nc -uzv <Target_IP> <Port>",
        "desc": "대상 서버의 특정 UDP 포트 통신을 확인합니다.",
        "note": "UDP는 연결 지향이 아니므로 무응답이 정상인 경우도 있습니다. 결과 해석에 주의하세요."
      },
      {
        "title": "nmap 포트 상태 확인",
        "command": "nmap -p <Port> <Target_IP>",
        "desc": "대상 IP의 포트 상태(open / closed / filtered)를 확인합니다. 범위 지정 시 -p 80-443 형식 사용.",
        "note": "nmap -p- <Target_IP> 로 전체 65535 포트 스캔 가능 (시간 소요)"
      },
      {
        "title": "HTTP 포트 응답 확인",
        "command": "curl -Iv http://<Target_IP>:<Port>",
        "desc": "HTTP 서비스가 동작하는 포트에 실제 응답과 헤더 정보를 확인합니다. 응답 코드(200, 301 등)로 서비스 정상 여부를 판단합니다."
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
        "command": "sudo apt-get update",
        "desc": "ceph-common 설치 전 패키지 목록을 최신화합니다.",
        "note": "업데이트가 실패하면 DNS 설정을 확인하세요. nameserver가 없으면 외부 패키지 서버에 접근할 수 없습니다.\n확인: cat /etc/resolv.conf\n미설정 시: netplan 또는 /etc/resolv.conf에 nameserver를 추가 후 적용하세요."
      },
      {
        "title": "Ceph 클라이언트 설치",
        "command": "sudo apt install -y ceph-common",
        "desc": "CephFS 마운트에 필요한 ceph-common 패키지를 설치합니다.",
        "note": "RHEL/CentOS 계열은 sudo dnf install -y ceph-common"
      },
      {
        "title": "ceph.conf 생성",
        "command": "vi /etc/ceph/ceph.conf",
        "desc": "호스트에 설정된 ceph.conf 내용을 참고해 클라이언트용 설정 파일을 생성합니다.",
        "info": "vi 편집기 사용법: i → 입력 모드 시작 → 수정 → ESC → :wq! Enter (저장 후 종료) | 저장 없이 나가려면 :q! Enter",
        "note": "입력 예시:\n[global]\nmon_host = 10.255.41.1, 10.255.41.3, 10.255.41.2"
      },
      {
        "title": "키링 파일 생성",
        "command": "vi /etc/ceph/ceph.client.<액세스 경로>.keyring",
        "desc": "액세스 규칙 생성 시 발급된 액세스 키를 사용해 클라이언트 키링 파일을 생성합니다.",
        "info": "vi 편집기 사용법: i → 입력 모드 시작 → 수정 → ESC → :wq! Enter (저장 후 종료) | 저장 없이 나가려면 :q! Enter",
        "note": "입력 예시:\n[client.meta]\nkey = AQB30kFqxghVCRAA5Tvsspfv4VBTyE4BKcc32w=="
      },
      {
        "title": "마운트 포인트 생성",
        "command": "mkdir -p /mnt/data",
        "desc": "CephFS를 마운트할 디렉토리를 생성합니다."
      },
      {
        "title": "CephFS 마운트",
        "command": "sudo mount -t ceph <추출위치> /mnt/data -o name=<액세스 경로>,secret=<액세스 키>,mds_namespace=cephfs",
        "desc": "공유파일 상세에서 확인한 추출위치를 입력해 CephFS를 마운트합니다. name은 액세스 경로(예: meta), secret은 액세스 키 값을 입력하세요."
      },
      {
        "title": "마운트 확인",
        "command": "df -h",
        "desc": "/mnt/data 항목이 표시되면 정상적으로 마운트된 것입니다."
      },
      {
        "title": "파일 쓰기 테스트",
        "command": "echo \"Test\" > /mnt/data/test.txt",
        "desc": "read-write 규칙이면 정상 쓰기됩니다. read-only 규칙이면 'Read-only file system' 오류가 출력되어 RO 정책이 정상 동작함을 확인할 수 있습니다."
      },
      {
        "title": "파일 읽기 테스트",
        "command": "cat /mnt/data/test.txt",
        "desc": "파일 내용(Test)이 출력되면 읽기 동작이 정상입니다."
      },
      {
        "title": "마운트 해제",
        "command": "sudo umount /mnt/data",
        "desc": "테스트 완료 후 마운트를 해제합니다."
      },
      {
        "title": "해제 확인",
        "command": "df -h",
        "desc": "/mnt/data 항목이 사라졌으면 정상적으로 해제된 것입니다."
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
        "command": "mkdir -p /mnt/data",
        "desc": "디스크를 연결할 마운트 포인트를 생성합니다."
      },
      {
        "title": "디스크 마운트",
        "command": "sudo mount /dev/<DISK> /mnt/data",
        "desc": "파티션을 마운트 포인트에 연결합니다. <DISK>에는 파티션 장치명을 입력하세요. (예: vdb1)"
      },
      {
        "title": "마운트 확인",
        "command": "df -h /mnt/data",
        "desc": "용량이 표시되면 정상적으로 마운트된 것입니다."
      },
      {
        "title": "데이터 쓰기 및 보존 확인 (공통 적용 구간)",
        "command": "",
        "desc": "마운트된 경로에 테스트 데이터를 기록하고 용량 변화를 확인합니다.",
        "info": "아래 시나리오에서 공통으로 활용 가능한 구간입니다.\n• 인스턴스 스냅샷 / 볼륨 스냅샷으로 생성된 인스턴스 데이터 보존 확인\n• 볼륨 백업으로 복원된 볼륨 데이터 보존 확인\n• 인스턴스 복제 및 증분 백업 복원 데이터 보존 확인"
      },
      {
        "title": "테스트 데이터 쓰기 (dd)",
        "command": "sudo dd if=/dev/zero of=/mnt/data/testfile bs=10k count=1000",
        "desc": "마운트된 경로에 10MB(10k × 1000)의 빈 데이터 파일을 생성합니다. 용량을 늘리려면 count 값을 조정하세요. (count=10000 → 100MB)"
      },
      {
        "title": "용량 변화 확인",
        "command": "df -h /mnt/data",
        "desc": "데이터 쓰기 전후의 사용 용량을 비교합니다. Used 수치가 늘었으면 데이터가 정상적으로 기록된 것입니다."
      },
      {
        "title": "파일 및 디렉토리 상태 확인",
        "command": "du -sh /mnt/data && ls -lh /mnt/data",
        "desc": "디렉토리 총 사용량과 내부 파일 목록 및 크기를 확인합니다."
      },
      {
        "title": "UUID 확인",
        "command": "blkid /dev/<DISK>",
        "desc": "fstab 등록에 사용할 파티션의 UUID를 확인합니다."
      },
      {
        "title": "fstab 자동 마운트 등록",
        "command": "echo 'UUID=<UUID> /mnt/data ext4 defaults 0 2' | sudo tee -a /etc/fstab",
        "desc": "재부팅 후에도 자동 마운트 되도록 /etc/fstab에 등록합니다. <UUID>는 앞 단계에서 확인한 UUID를 입력하세요."
      },
      {
        "title": "fstab 문법 검사 및 재마운트",
        "command": "sudo mount -a",
        "desc": "fstab 설정의 문법 오류를 검사하고 전체 항목을 다시 마운트합니다. 오류 없이 완료되면 설정이 정상입니다.",
        "note": "⚠ 오류가 나면 fstab 항목이 잘못된 것입니다. 재부팅 전에 반드시 수정하세요."
      },
      {
        "title": "재부팅",
        "command": "reboot",
        "desc": "재부팅 후 자동 마운트 여부를 확인합니다."
      },
      {
        "title": "마운트 유지 확인",
        "command": "df -h",
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
        "desc": "빈 볼륨에 ext4 파일시스템을 생성합니다. <DISK>에는 장치명을 입력하세요. (예: vdb)",
        "note": "⚠ 해당 볼륨의 기존 데이터가 모두 삭제됩니다. 데이터를 보존해야 한다면 '파티션 있는 경우' 시나리오를 이용하세요."
      },
      {
        "title": "마운트 폴더 생성",
        "command": "mkdir -p /mnt/data",
        "desc": "디스크를 연결할 마운트 포인트를 생성합니다."
      },
      {
        "title": "디스크 마운트",
        "command": "sudo mount /dev/<DISK> /mnt/data",
        "desc": "볼륨을 마운트 포인트에 연결합니다."
      },
      {
        "title": "마운트 확인",
        "command": "df -h /mnt/data",
        "desc": "용량이 표시되면 정상적으로 마운트된 것입니다."
      },
      {
        "title": "데이터 쓰기 및 보존 확인 (공통 적용 구간)",
        "command": "",
        "desc": "마운트된 경로에 테스트 데이터를 기록하고 용량 변화를 확인합니다.",
        "info": "아래 시나리오에서 공통으로 활용 가능한 구간입니다.\n• 인스턴스 스냅샷 / 볼륨 스냅샷으로 생성된 인스턴스 데이터 보존 확인\n• 볼륨 백업으로 복원된 볼륨 데이터 보존 확인\n• 인스턴스 복제 및 증분 백업 복원 데이터 보존 확인"
      },
      {
        "title": "테스트 데이터 쓰기 (dd)",
        "command": "sudo dd if=/dev/zero of=/mnt/data/testfile bs=10k count=1000",
        "desc": "마운트된 경로에 10MB(10k × 1000)의 빈 데이터 파일을 생성합니다. 용량을 늘리려면 count 값을 조정하세요. (count=10000 → 100MB)"
      },
      {
        "title": "용량 변화 확인",
        "command": "df -h /mnt/data",
        "desc": "데이터 쓰기 전후의 사용 용량을 비교합니다. Used 수치가 늘었으면 데이터가 정상적으로 기록된 것입니다."
      },
      {
        "title": "파일 및 디렉토리 상태 확인",
        "command": "du -sh /mnt/data && ls -lh /mnt/data",
        "desc": "디렉토리 총 사용량과 내부 파일 목록 및 크기를 확인합니다."
      },
      {
        "title": "UUID 확인",
        "command": "blkid /dev/<DISK>",
        "desc": "fstab 등록에 사용할 볼륨의 UUID를 확인합니다."
      },
      {
        "title": "fstab 자동 마운트 등록",
        "command": "echo 'UUID=<UUID> /mnt/data ext4 defaults 0 2' | sudo tee -a /etc/fstab",
        "desc": "재부팅 후에도 자동 마운트 되도록 /etc/fstab에 등록합니다. <UUID>는 앞 단계에서 확인한 UUID를 입력하세요."
      },
      {
        "title": "fstab 문법 검사 및 재마운트",
        "command": "sudo mount -a",
        "desc": "fstab 설정의 문법 오류를 검사하고 전체 항목을 다시 마운트합니다.",
        "note": "⚠ 오류가 나면 fstab 항목이 잘못된 것입니다. 재부팅 전에 반드시 수정하세요."
      },
      {
        "title": "재부팅",
        "command": "reboot",
        "desc": "재부팅 후 자동 마운트 여부를 확인합니다."
      },
      {
        "title": "마운트 유지 확인",
        "command": "df -h",
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
        "command": "sudo lsof /mnt/data",
        "desc": "해당 경로를 사용 중인 프로세스가 있으면 마운트 해제가 실패합니다. 결과가 있으면 종료 후 진행하세요."
      },
      {
        "title": "마운트 해제",
        "command": "sudo umount /mnt/data",
        "desc": "디스크 마운트를 해제합니다.",
        "note": "\"target is busy\" 오류 시 1단계로 돌아가 점유 프로세스를 정리하세요."
      },
      {
        "title": "해제 확인",
        "command": "lsblk -f",
        "desc": "/mnt/data 마운트 지점이 사라졌는지 확인합니다."
      },
      {
        "title": "fstab 등록 제거",
        "command": "sudo vi /etc/fstab",
        "desc": "영구적으로 분리하려면 fstab 에서 해당 디스크 줄을 삭제합니다. 안 지우면 재부팅 시 다시 마운트를 시도합니다.",
        "info": "vi 편집기 사용법: i → 입력 모드 시작 → 수정 → ESC → :wq! Enter (저장 후 종료) | 저장 없이 나가려면 :q! Enter",
        "note": "상단 [설정파일] 버튼으로 편집하는 것이 더 편하고 안전합니다."
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
        "command": "sudo apt install -y lvm2",
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
        "desc": "디스크를 LVM 물리 볼륨으로 초기화합니다.",
        "note": "⚠️ 해당 디스크의 기존 데이터가 삭제됩니다."
      },
      {
        "title": "볼륨 그룹(VG) 생성",
        "command": "sudo vgcreate data_vg /dev/<DISK>",
        "desc": "PV 들을 묶는 볼륨 그룹 data_vg 를 만듭니다."
      },
      {
        "title": "논리 볼륨(LV) 생성",
        "command": "sudo lvcreate -l 100%FREE -n data_lv data_vg",
        "desc": "VG 의 남은 공간 전부로 논리 볼륨 data_lv 를 만듭니다."
      },
      {
        "title": "파일시스템 생성",
        "command": "sudo mkfs.xfs /dev/data_vg/data_lv",
        "desc": "LV 에 xfs 파일시스템을 만듭니다. (ext4 를 쓰려면 mkfs.ext4)"
      },
      {
        "title": "마운트",
        "command": "sudo mkdir -p /mnt/data && sudo mount /dev/data_vg/data_lv /mnt/data",
        "desc": "마운트 디렉토리를 만들고 LV 를 마운트합니다."
      },
      {
        "title": "(확장) VG 에 디스크 추가",
        "command": "sudo vgextend data_vg /dev/<NEW_DISK>",
        "desc": "용량이 부족해지면 새 디스크를 PV 로 만든 뒤 VG 에 추가합니다. (먼저 pvcreate 필요)"
      },
      {
        "title": "(확장) LV 용량 확장",
        "command": "sudo lvextend -l +100%FREE /dev/data_vg/data_lv",
        "desc": "VG 의 늘어난 공간만큼 LV 를 확장합니다(무중단)."
      },
      {
        "title": "(확장) 파일시스템 온라인 리사이즈",
        "command": "sudo xfs_growfs /mnt/data",
        "desc": "마운트된 상태에서 파일시스템을 확장합니다. xfs 는 xfs_growfs, ext4 는 resize2fs 사용."
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
        "command": "virsh list --all",
        "desc": "하이퍼바이저 호스트에서 실행합니다. Name 컬럼에 표시되는 instance_alias를 확인합니다.",
        "info": "virsh는 OpenStack 인스턴스 UUID가 아닌 libvirt 도메인 별칭(instance_alias)으로 조회해야 합니다.\n포털의 인스턴스 이름과 다르므로 반드시 virsh list --all 로 별칭을 먼저 확인하세요."
      },
      {
        "title": "QoS 적용 여부 확인 (인스턴스 배치 호스트)",
        "command": "virsh dumpxml <instance_alias> | grep -E -A 5 \"bandwidth|iotune\"",
        "desc": "위에서 확인한 인스턴스 별칭으로 실행합니다. 인스턴스가 배치된 컴퓨트 호스트에서 실행해야 합니다.",
        "info": "이 명령어는 인스턴스 터미널이 아닌, 해당 인스턴스가 배치된 컴퓨트 호스트(하이퍼바이저)에 접속해서 실행해야 합니다.\n정상 적용 시 아래와 같이 iotune 블록에 설정값이 출력됩니다:\n  <read_bytes_sec>10485760</read_bytes_sec>\n  <write_bytes_sec>10485760</write_bytes_sec>\n  <read_iops_sec>50</read_iops_sec>\n  <write_iops_sec>50</write_iops_sec>"
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
        "command": "sudo apt update",
        "desc": "fio 설치 전 패키지 목록을 최신화합니다.",
        "note": "업데이트가 실패하면 DNS 설정을 확인하세요. nameserver가 없으면 외부 패키지 서버에 접근할 수 없습니다.\n확인: cat /etc/resolv.conf\n미설정 시: netplan 또는 /etc/resolv.conf에 nameserver를 추가 후 적용하세요."
      },
      {
        "title": "fio 및 libaio 설치",
        "command": "sudo apt install -y fio libaio1t64 || sudo apt install -y fio libaio1",
        "desc": "I/O 벤치마크 도구 fio와 비동기 I/O 라이브러리(libaio)를 함께 설치합니다. libaio가 없으면 fio가 동기 모드로 폴백되어 IOPS를 제대로 측정할 수 없습니다.",
        "note": "Ubuntu 24.04+는 libaio1t64, 22.04 이하는 libaio1 패키지명을 사용합니다. || 로 두 버전을 순서대로 시도합니다.\nRHEL/CentOS 계열: sudo dnf install -y fio libaio"
      },
      {
        "title": "쓰기 IOPS 제한 확인",
        "command": "sudo fio --name=qos-randwrite --rw=randwrite --bs=4k --direct=1 --ioengine=libaio --iodepth=32 --size=100M --runtime=30 --filename=/tmp/fio-test --group_reporting",
        "desc": "4k 블록 랜덤 쓰기 30초 수행. 결과의 IOPS 값이 QoS 설정치(50)에 근접하면 정상입니다.",
        "info": "--direct=1 로 OS 캐시를 건너뛰고, --ioengine=libaio --iodepth=32 로 충분한 I/O 요청을 동시에 발행해야 QoS 제한치(50 IOPS)까지 실제로 도달할 수 있습니다."
      },
      {
        "title": "읽기 IOPS 제한 확인",
        "command": "sudo fio --name=qos-randread --rw=randread --bs=4k --direct=1 --ioengine=libaio --iodepth=32 --size=100M --runtime=30 --filename=/tmp/fio-test --group_reporting",
        "desc": "4k 블록 랜덤 읽기 30초 수행. 결과의 IOPS 값이 50 근처로 제한되면 read_iops_sec 적용 확인입니다."
      },
      {
        "title": "쓰기 대역폭 제한 확인",
        "command": "sudo fio --name=qos-write-bw --rw=write --bs=1m --direct=1 --ioengine=libaio --iodepth=32 --size=100M --runtime=30 --filename=/tmp/fio-test --group_reporting",
        "desc": "1M 블록 순차 쓰기 30초 수행. 결과의 BW 값이 약 10 MiB/s(10485760 bytes/s)로 제한되면 write_bytes_sec 적용 확인입니다."
      },
      {
        "title": "읽기 대역폭 제한 확인",
        "command": "sudo fio --name=qos-read-bw --rw=read --bs=1m --direct=1 --ioengine=libaio --iodepth=32 --size=100M --runtime=30 --filename=/tmp/fio-test --group_reporting",
        "desc": "1M 블록 순차 읽기 30초 수행. 결과의 BW 값이 약 10 MiB/s로 제한되면 read_bytes_sec 적용 확인입니다."
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
        "command": "lspci | grep -i nvidia",
        "desc": "PCI 버스에 NVIDIA GPU가 인식됐는지 확인합니다. 출력이 없으면 GPU 패스스루(PCI Passthrough) 설정을 확인하세요."
      },
      {
        "title": "패키지 업데이트",
        "command": "sudo apt update",
        "desc": "패키지 목록을 최신화합니다.",
        "note": "업데이트가 실패하면 DNS 설정을 확인하세요. nameserver가 없으면 외부 패키지 서버에 접근할 수 없습니다.\n확인: cat /etc/resolv.conf\n미설정 시: netplan 또는 /etc/resolv.conf에 nameserver를 추가 후 적용하세요."
      },
      {
        "title": "커널 헤더 및 빌드 도구 설치",
        "command": "sudo apt install -y build-essential dkms linux-headers-$(uname -r)",
        "desc": "드라이버 컴파일에 필요한 커널 헤더와 빌드 도구를 설치합니다."
      },
      {
        "title": "권장 드라이버 버전 확인",
        "command": "ubuntu-drivers devices",
        "desc": "시스템 GPU에 맞는 권장 NVIDIA 드라이버 버전을 확인합니다.",
        "note": "ubuntu-drivers 명령이 없으면 sudo apt install -y ubuntu-drivers-common 먼저 실행하세요."
      },
      {
        "title": "드라이버 설치",
        "command": "sudo ubuntu-drivers install",
        "desc": "권장 드라이버를 자동으로 설치합니다. 특정 버전을 지정하려면 sudo apt install -y nvidia-driver-<버전> 형식으로 사용하세요."
      },
      {
        "title": "재부팅",
        "command": "sudo reboot",
        "desc": "드라이버 로드를 위해 재부팅합니다."
      },
      {
        "title": "드라이버 동작 확인",
        "command": "nvidia-smi",
        "desc": "GPU 상태, 드라이버 버전, CUDA 버전, 메모리 사용량을 확인합니다. 출력이 정상이면 드라이버 설치가 완료된 것입니다."
      },
      {
        "title": "GPU 상세 정보 조회",
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
        "desc": "GPU 이름과 현재 MIG 모드 상태를 조회합니다. MIG는 NVIDIA A100, H100 등 Ampere 아키텍처 이상에서 지원됩니다.",
        "note": "Disabled 상태이면 다음 단계에서 활성화합니다. N/A로 출력되면 해당 GPU는 MIG를 지원하지 않습니다."
      },
      {
        "title": "MIG 모드 활성화",
        "command": "sudo nvidia-smi -mig 1",
        "desc": "GPU에 MIG 모드를 활성화합니다. 적용을 위해 이후 재부팅이 필요합니다."
      },
      {
        "title": "재부팅",
        "command": "sudo reboot",
        "desc": "MIG 모드 변경 사항을 적용하기 위해 재부팅합니다."
      },
      {
        "title": "MIG 활성화 확인",
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
        "command": "sudo nvidia-smi mig -dci && sudo nvidia-smi mig -dgi",
        "desc": "컴퓨트 인스턴스(CI)를 먼저 삭제한 뒤 GPU 인스턴스(GI)를 삭제합니다. 삭제 순서를 반드시 지켜야 합니다."
      },
      {
        "title": "MIG 모드 비활성화 (필요 시)",
        "command": "sudo nvidia-smi -mig 0",
        "desc": "MIG 모드를 비활성화합니다. 적용을 위해 재부팅이 필요합니다.",
        "note": "MIG 인스턴스가 남아있으면 비활성화가 거부됩니다. 먼저 모든 GI/CI를 삭제하세요."
      }
    ]
  },

  // ───────────────────────── 성능 · 부하 ─────────────────────────

  {
    "id": "perf-stress-cpu",
    "solution": "성능 · 부하",
    "title": "[부하] stress-ng — CPU",
    "summary": "CPU 코어에 인위적 부하를 주고 모니터링합니다. (수치는 환경에 맞게 조절)",
    "steps": [
      {
        "title": "도구 설치 (필요 시)",
        "command": "sudo apt install -y stress-ng htop",
        "desc": "부하/모니터링 도구 설치.",
        "note": "RHEL/CentOS 계열은 `sudo dnf install -y stress-ng htop` (EPEL 필요할 수 있음)"
      },
      {
        "title": "CPU 부하 발생",
        "command": "sudo stress-ng --cpu 4 --timeout 60s",
        "desc": "CPU 코어 4개에 60초 동안 부하."
      },
      {
        "title": "실시간 모니터링",
        "command": "htop",
        "desc": "코어별 CPU 사용률을 실시간 확인. (종료: q)"
      }
    ]
  },
  {
    "id": "perf-stress-mem",
    "solution": "성능 · 부하",
    "title": "[부하] stress-ng — 메모리",
    "summary": "메모리(RAM)에 인위적 부하를 주고 모니터링합니다.",
    "steps": [
      {
        "title": "도구 설치 (필요 시)",
        "command": "sudo apt install -y stress-ng htop",
        "desc": "부하/모니터링 도구 설치.",
        "note": "RHEL/CentOS 계열은 `sudo dnf install -y stress-ng htop` (EPEL 필요할 수 있음)"
      },
      {
        "title": "메모리 부하 발생",
        "command": "sudo stress-ng --vm 2 --vm-bytes 1G --timeout 60s",
        "desc": "가상 메모리 워커 2개 ×1GB(총 2GB)를 60초 동안 점유."
      },
      {
        "title": "실시간 모니터링",
        "command": "watch -n 1 'free -h'",
        "desc": "메모리/스왑 사용량을 1초마다 갱신하며 확인. (종료: Ctrl+C)"
      }
    ]
  },
  {
    "id": "perf-stress-cpumem",
    "solution": "성능 · 부하",
    "title": "[부하] stress-ng — CPU & 메모리",
    "summary": "CPU와 메모리에 동시에 부하를 주고 모니터링합니다(알람/스케일링 검증).",
    "steps": [
      {
        "title": "도구 설치 (필요 시)",
        "command": "sudo apt install -y stress-ng htop",
        "desc": "부하/모니터링 도구 설치.",
        "note": "RHEL/CentOS 계열은 `sudo dnf install -y stress-ng htop` (EPEL 필요할 수 있음)"
      },
      {
        "title": "CPU+메모리 부하 발생",
        "command": "sudo stress-ng --cpu 4 --vm 2 --vm-bytes 1G --timeout 60s",
        "desc": "CPU 4코어 + 메모리 2GB를 60초 동안 동시 부하."
      },
      {
        "title": "실시간 모니터링",
        "command": "htop",
        "desc": "CPU/메모리/프로세스를 실시간 관찰. (종료: q)"
      }
    ]
  },
  {
    "id": "perf-iperf3-bw",
    "solution": "성능 · 부하",
    "title": "[부하] iperf3 — 네트워크 대역폭(BW)",
    "summary": "두 노드 간 TCP 실효 대역폭을 측정합니다. (서버/클라이언트 각각 실행)",
    "steps": [
      {
        "title": "도구 설치 (필요 시)",
        "command": "sudo apt install -y iperf3",
        "desc": "iperf3 설치.",
        "note": "RHEL/CentOS 계열은 `sudo dnf install -y iperf3`"
      },
      {
        "title": "[서버] 리슨 대기",
        "command": "iperf3 -s -D",
        "desc": "한쪽 노드에서 iperf3 서버를 백그라운드로 띄웁니다."
      },
      {
        "title": "[클라이언트] 대역폭 측정",
        "command": "iperf3 -c <SERVER_IP> -t 60 -P 4",
        "desc": "다른 노드에서 60초간 4개 병렬 스트림으로 TCP 최대 실효 대역폭 측정."
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
        "command": "sudo apt install -y fio",
        "desc": "I/O 벤치마크 도구 fio 설치.",
        "note": "RHEL/CentOS 계열은 `sudo dnf install -y fio`"
      },
      {
        "title": "대상 볼륨으로 이동",
        "command": "cd /mnt/data",
        "desc": "테스트할 마운트 볼륨 경로로 이동.",
        "note": "⚠️ 운영 데이터가 있는 경로는 피하세요. 테스트 파일이 생성됩니다."
      },
      {
        "title": "랜덤 쓰기 IOPS",
        "command": "sudo fio --name=randwrite --ioengine=libaio --iodepth=32 --rw=randwrite --bs=4k --direct=1 --size=1G --numjobs=1 --runtime=60 --group_reporting",
        "desc": "4k 블록 랜덤 쓰기 IOPS/지연 측정."
      },
      {
        "title": "랜덤 읽기 IOPS",
        "command": "sudo fio --name=randread --ioengine=libaio --iodepth=32 --rw=randread --bs=4k --direct=1 --size=1G --numjobs=1 --runtime=60 --group_reporting",
        "desc": "4k 블록 랜덤 읽기 IOPS/지연 측정."
      },
      {
        "title": "테스트 파일 정리",
        "command": "rm -f randwrite.* randread.*",
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
        "command": "sudo apt install -y fio",
        "desc": "I/O 벤치마크 도구 fio 설치.",
        "note": "RHEL/CentOS 계열은 `sudo dnf install -y fio`"
      },
      {
        "title": "대상 볼륨으로 이동",
        "command": "cd /mnt/data",
        "desc": "테스트할 마운트 볼륨 경로로 이동.",
        "note": "⚠️ 운영 데이터가 있는 경로는 피하세요. 테스트 파일이 생성됩니다."
      },
      {
        "title": "순차 읽기 대역폭",
        "command": "sudo fio --name=seqread --ioengine=libaio --iodepth=32 --rw=read --bs=1m --direct=1 --size=1G --numjobs=1 --runtime=60 --group_reporting",
        "desc": "1M 블록 순차 읽기 처리량 측정."
      },
      {
        "title": "순차 쓰기 대역폭",
        "command": "sudo fio --name=seqwrite --ioengine=libaio --iodepth=32 --rw=write --bs=1m --direct=1 --size=1G --numjobs=1 --runtime=60 --group_reporting",
        "desc": "1M 블록 순차 쓰기 처리량 측정."
      },
      {
        "title": "테스트 파일 정리",
        "command": "rm -f seqread.* seqwrite.*",
        "desc": "fio 가 생성한 테스트 파일 삭제."
      }
    ]
  },

  // ───────────────────────── Ceph ─────────────────────────

  {
    "id": "scn5",
    "solution": "Ceph",
    "title": "[관리] OSD Down 트러블 슈팅 체크 요소 확인",
    "summary": "HEALTH_WARN/ERR 와 함께 OSD 가 down 되었을 때, 원인 파악부터 재기동·복구 확인까지 진행합니다.",
    "steps": [
      {
        "title": "클러스터 상태 확인",
        "command": "ceph -s",
        "desc": "HEALTH 상태와 down/out 된 OSD 수, PG 상태를 한눈에 확인합니다."
      },
      {
        "title": "헬스 상세 확인",
        "command": "ceph health detail",
        "desc": "어떤 OSD/PG 가 문제인지 구체적인 원인을 확인합니다."
      },
      {
        "title": "OSD 트리에서 down 식별",
        "command": "ceph osd tree",
        "desc": "down 또는 out 상태인 OSD 의 ID 와 위치(호스트)를 식별합니다."
      },
      {
        "title": "크래시 이력 확인",
        "command": "ceph crash ls",
        "desc": "최근 비정상 종료된 데몬이 있는지 확인합니다."
      },
      {
        "title": "OSD 로그 확인",
        "command": "tail -n 200 /var/log/ceph/ceph-osd.<OSD_ID>.log",
        "desc": "문제 OSD 의 로그에서 다운 원인(디스크 오류, OOM 등)을 확인합니다."
      },
      {
        "title": "OSD 데몬 재시작",
        "command": "sudo systemctl restart ceph-osd@<OSD_ID>",
        "desc": "해당 OSD 데몬을 재기동합니다.",
        "note": "⚠️ 디스크 하드웨어 장애가 의심되면 재시작 전에 디스크 상태(SMART 등)를 먼저 점검하세요."
      },
      {
        "title": "복구 진행 감시",
        "command": "watch -n 5 'ceph -s'",
        "desc": "OSD 가 up 으로 전환되고 복구(recovery/backfill)가 진행·완료되는지 실시간 감시합니다. (종료: Ctrl+C)"
      }
    ]
  },

  // ───────────────────────── Kubernetes ─────────────────────────

  {
    "id": "scn6",
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
        "command": "sudo adduser <사용자명>",
        "desc": "홈 디렉토리와 비밀번호를 설정하며 계정을 만듭니다. 실행하면 대화형 프롬프트가 나오니 안내에 따라 입력하세요."
      },
      {
        "title": "sudo 권한 부여",
        "command": "sudo usermod -aG sudo <사용자명>",
        "desc": "사용자를 sudo 그룹에 추가해 관리자 명령을 쓸 수 있게 합니다.",
        "note": "RHEL/CentOS 계열은 sudo 대신 wheel 그룹을 사용합니다 (usermod -aG wheel)."
      },
      {
        "title": "그룹 확인",
        "command": "id <사용자명>",
        "desc": "해당 계정이 sudo(또는 wheel) 그룹에 포함됐는지 확인합니다."
      },
      {
        "title": "계정 전환 테스트",
        "command": "su - <사용자명>",
        "desc": "새 계정으로 전환해 로그인이 되는지 테스트합니다. (원래 계정으로 돌아오기: exit)"
      }
    ]
  },

  // ───────────────────────── etc ─────────────────────────

  {
    "id": "scn4",
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
        "command": "virsh list --all",
        "desc": "컴퓨트 노드에 접속해 KVM/QEMU 레벨에서 도메인(VM) 상태를 직접 확인합니다."
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
        "command": "sysctl -a | grep tcp",
        "desc": "현재 적용된 TCP 관련 커널 파라미터 값을 확인합니다."
      },
      {
        "title": "sysctl.conf 편집",
        "command": "sudo vi /etc/sysctl.conf",
        "desc": "예: net.ipv4.tcp_tw_reuse=1, net.core.somaxconn=1024 등 튜닝 값을 추가합니다.",
        "info": "vi 편집기 사용법: i → 입력 모드 시작 → 수정 → ESC → :wq! Enter (저장 후 종료) | 저장 없이 나가려면 :q! Enter",
        "note": "상단 [설정파일] 버튼으로 편집 권장. 의미를 모르는 값은 추가하지 마세요."
      },
      {
        "title": "즉시 적용",
        "command": "sudo sysctl -p",
        "desc": "sysctl.conf 의 변경분을 즉시 커널에 적용합니다."
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
        "command": "sudo kill -9 <PID>",
        "desc": "프로세스를 강제 종료해 장애 상황을 유발합니다.",
        "note": "⚠️ 운영 중인 서비스에는 사용하지 마세요. 테스트/검증 환경에서만 진행하세요."
      },
      {
        "title": "자동 복구 확인",
        "command": "systemctl status <서비스명>",
        "desc": "systemd 의 Restart 설정에 따라 서비스가 자동 재시작됐는지 확인합니다."
      },
      {
        "title": "서비스 로그 추적",
        "command": "journalctl -u <서비스명> -f",
        "desc": "해당 서비스의 재시작/크래시 로그를 실시간으로 추적합니다. (종료: Ctrl+C)"
      },
      {
        "title": "시스템 로그 추적",
        "command": "tail -f /var/log/syslog",
        "desc": "전체 시스템 로그를 실시간 추적합니다. (RHEL 계열은 /var/log/messages)"
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
        "command": "sudo apt install -y qemu-utils",
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
        "desc": "볼륨이 정상 연결됐는지 확인합니다. vda(OS 디스크) 외에 vdb 등 추가 디스크가 표시되면 정상입니다. 이후 단계에서 해당 디스크명을 사용합니다."
      },
      {
        "title": "저장용 디스크 포맷",
        "command": "sudo mkfs.ext4 /dev/vdb",
        "desc": "이미지 파일을 저장할 추가 디스크(vdb)를 ext4로 포맷합니다. lsblk에서 확인한 디스크명으로 교체하세요.",
        "note": "⚠️ vda는 OS 디스크입니다. 반드시 추가 연결한 디스크(vdb 등)에만 포맷을 진행하세요."
      },
      {
        "title": "마운트 포인트 생성",
        "command": "mkdir -p /mnt/backup",
        "desc": "저장용 디스크를 마운트할 디렉토리를 생성합니다."
      },
      {
        "title": "저장용 디스크 마운트",
        "command": "sudo mount /dev/vdb /mnt/backup",
        "desc": "/mnt/backup에 저장용 디스크를 마운트합니다. 이후 생성되는 이미지 파일이 이 경로에 저장됩니다."
      },
      {
        "title": "vda 디스크를 qcow2 이미지로 변환",
        "command": "sudo qemu-img convert -O qcow2 /dev/vda /mnt/backup/ubuntu_image.qcow2",
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
        "command": "sudo qemu-img convert -c -O qcow2 /mnt/backup/ubuntu_image.qcow2 /mnt/backup/ubuntu_image_compressed.qcow2",
        "desc": "생성된 이미지에 압축을 적용해 파일 크기를 줄입니다. 다운로드 시간을 단축하려면 이 단계를 먼저 진행하세요.",
        "note": "압축 옵션(-c)은 변환 시간이 더 걸리지만 파일 크기를 크게 줄여줍니다. 원본 이미지는 삭제해 공간을 확보할 수 있습니다."
      },
      {
        "title": "이미지 파일 확인",
        "command": "qemu-img info /mnt/backup/ubuntu_image.qcow2",
        "desc": "생성된 이미지 파일의 포맷·가상 크기·실제 디스크 크기를 확인합니다."
      },
      {
        "title": "로컬로 다운로드",
        "command": "scp <username>@<원격_IP>:/mnt/backup/ubuntu_image.qcow2 ./",
        "desc": "scp 명령어로 로컬에 직접 다운로드하거나, 이 앱의 파일 탐색기에서 /mnt/backup 경로로 이동 후 파일을 다운로드할 수 있습니다.",
        "info": "파일 크기가 클 경우 다운로드 시간이 상당히 소요됩니다. 파일 탐색기를 이용하면 진행률 표시줄로 상태를 확인할 수 있습니다."
      }
    ]
  }
]
