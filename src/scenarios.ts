// 작업 시나리오(플레이북) — 순서가 있는 명령어 흐름.
// 명령어_편집.md 에서 자동 생성됨. <...> 플레이스홀더는 실행 대신 "입력".

export interface ScenarioStep {
  title: string
  command: string
  desc: string
  note?: string
}

export interface Scenario {
  id: string
  solution: string
  title: string
  summary: string
  steps: ScenarioStep[]
}

export const SCENARIOS: Scenario[] = [
  {
    "id": "scn1",
    "solution": "공통 · 스토리지",
    "title": "디스크 마운트 및 fstab 영구 등록",
    "summary": "새로 추가한 디스크를 포맷·마운트하고, /etc/fstab 에 등록해 재부팅 후에도 마운트가 유지되도록 합니다.",
    "steps": [
      {
        "title": "현재 디스크/파티션 확인",
        "command": "lsblk -f",
        "desc": "연결된 디스크와 파일시스템을 확인합니다. 새로 추가한 디스크(예: /dev/vdb)가 마운트/포맷 안 된 상태로 보이는지 확인하세요."
      },
      {
        "title": "파일시스템 생성",
        "command": "sudo mkfs.ext4 /dev/<DISK>",
        "desc": "새 디스크에 ext4 파일시스템을 만듭니다. <DISK> 는 1단계에서 확인한 장치명(vdb 등)으로 바꾸세요.",
        "note": "⚠️ 해당 디스크의 기존 데이터가 모두 삭제됩니다. 이미 포맷된 디스크라면 이 단계는 건너뜁니다."
      },
      {
        "title": "마운트할 폴더 생성",
        "command": "sudo mkdir -p /mnt/data",
        "desc": "디스크를 연결할 디렉토리를 만듭니다. -p 옵션으로 상위 경로까지 한 번에 생성됩니다."
      },
      {
        "title": "디스크 마운트",
        "command": "sudo mount /dev/<DISK> /mnt/data",
        "desc": "디스크를 위에서 만든 폴더에 임시로 마운트합니다."
      },
      {
        "title": "마운트 확인",
        "command": "df -h /mnt/data",
        "desc": "용량이 표시되면 정상적으로 마운트된 것입니다. `lsblk -f` 로도 마운트 지점을 확인할 수 있습니다."
      },
      {
        "title": "UUID 확인",
        "command": "sudo blkid /dev/<DISK>",
        "desc": "fstab 등록에 사용할 디스크 고유 UUID 를 확인합니다."
      },
      {
        "title": "fstab 등록",
        "command": "echo 'UUID=<UUID>  /mnt/data  ext4  defaults  0  2' | sudo tee -a /etc/fstab",
        "desc": "재부팅 후에도 자동 마운트되도록 /etc/fstab 에 등록합니다. <UUID> 를 6단계에서 확인한 값으로 바꾸세요.",
        "note": "상단 [설정파일] 버튼으로 /etc/fstab 을 직접 열어 편집할 수도 있습니다."
      },
      {
        "title": "fstab 검증 및 적용",
        "command": "sudo mount -a",
        "desc": "fstab 의 문법 오류를 검사하고 전체 항목을 다시 마운트합니다. 오류 메시지가 없으면 정상입니다.",
        "note": "⚠️ 오류가 나면 fstab 항목이 잘못된 것입니다 — 재부팅 전에 반드시 수정하세요(부팅 실패 방지)."
      }
    ]
  },
  {
    "id": "scn2",
    "solution": "공통 · 스토리지",
    "title": "마운트 해제 및 fstab 정리",
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
        "note": "상단 [설정파일] 버튼으로 편집하는 것이 더 편하고 안전합니다."
      }
    ]
  },
  {
    "id": "scn3",
    "solution": "공통 · 스토리지",
    "title": "LVM 구성 및 무중단 용량 확장",
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
    "id": "scn4",
    "solution": "OpenStack",
    "title": "인스턴스 부팅 실패 진단",
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
    "id": "scn5",
    "solution": "Ceph",
    "title": "OSD Down 트러블슈팅",
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
  {
    "id": "scn6",
    "solution": "Kubernetes",
    "title": "파드 CrashLoopBackOff 진단",
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
  {
    "id": "scn7",
    "solution": "리눅스 기초",
    "title": "신규 사용자 생성 및 sudo 권한 부여",
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
  {
    "id": "scn8",
    "solution": "공통 · 네트워크",
    "title": "네트워크 인터페이스 조작 및 DNS 설정",
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
    "solution": "공통 · 네트워크",
    "title": "포트 통신 확인 및 SSH 접근 제어",
    "summary": "로컬 리슨 포트와 타겟 서버 포트 통신을 점검하고, SSH config 로 키 기반 접속을 구성합니다.",
    "steps": [
      {
        "title": "도구 설치 (필요 시)",
        "command": "sudo apt install -y netcat-openbsd",
        "desc": "포트 점검용 nc(netcat) 를 설치합니다. 이미 있으면 건너뜁니다.",
        "note": "RHEL/CentOS 계열은 `sudo dnf install -y nmap-ncat`"
      },
      {
        "title": "로컬 리슨 포트 확인",
        "command": "ss -tunlp",
        "desc": "현재 서버가 어떤 TCP/UDP 포트를 어떤 프로세스로 리슨 중인지 확인합니다."
      },
      {
        "title": "타겟 포트 통신 체크",
        "command": "nc -zv <Target_IP> <Port>",
        "desc": "대상 서버의 특정 포트로 연결이 되는지 확인합니다(TCP). UDP 는 -u 옵션 추가."
      },
      {
        "title": "SSH config 구성",
        "command": "vi ~/.ssh/config",
        "desc": "Host 별칭, HostName, User, Port, IdentityFile(키 경로) 를 등록해 접속을 단순화합니다.",
        "note": "예) Host myserver / HostName 10.0.0.5 / User ubuntu / IdentityFile ~/.ssh/id_rsa"
      },
      {
        "title": "키 기반 접속 테스트",
        "command": "ssh <별칭>",
        "desc": "위에서 등록한 별칭으로 접속해 키 기반 로그인이 되는지 확인합니다."
      }
    ]
  },
  {
    "id": "perf-stress-cpu",
    "solution": "성능 · 부하검증",
    "title": "stress-ng — CPU 부하",
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
        "command": "stress-ng --cpu 4 --timeout 60s",
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
    "solution": "성능 · 부하검증",
    "title": "stress-ng — 메모리 부하",
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
        "command": "stress-ng --vm 2 --vm-bytes 1G --timeout 60s",
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
    "solution": "성능 · 부하검증",
    "title": "stress-ng — CPU & 메모리 부하",
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
        "command": "stress-ng --cpu 4 --vm 2 --vm-bytes 1G --timeout 60s",
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
    "solution": "성능 · 부하검증",
    "title": "iperf3 — 네트워크 대역폭(BW)",
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
    "solution": "성능 · 부하검증",
    "title": "fio — 랜덤 IOPS",
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
        "command": "fio --name=randwrite --ioengine=libaio --iodepth=32 --rw=randwrite --bs=4k --direct=1 --size=1G --numjobs=1 --runtime=60 --group_reporting",
        "desc": "4k 블록 랜덤 쓰기 IOPS/지연 측정."
      },
      {
        "title": "랜덤 읽기 IOPS",
        "command": "fio --name=randread --ioengine=libaio --iodepth=32 --rw=randread --bs=4k --direct=1 --size=1G --numjobs=1 --runtime=60 --group_reporting",
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
    "solution": "성능 · 부하검증",
    "title": "fio — 순차 대역폭(BW)",
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
        "command": "fio --name=seqread --ioengine=libaio --iodepth=32 --rw=read --bs=1m --direct=1 --size=1G --numjobs=1 --runtime=60 --group_reporting",
        "desc": "1M 블록 순차 읽기 처리량 측정."
      },
      {
        "title": "순차 쓰기 대역폭",
        "command": "fio --name=seqwrite --ioengine=libaio --iodepth=32 --rw=write --bs=1m --direct=1 --size=1G --numjobs=1 --runtime=60 --group_reporting",
        "desc": "1M 블록 순차 쓰기 처리량 측정."
      },
      {
        "title": "테스트 파일 정리",
        "command": "rm -f seqread.* seqwrite.*",
        "desc": "fio 가 생성한 테스트 파일 삭제."
      }
    ]
  },
  {
    "id": "scn12",
    "solution": "공통 · 시스템",
    "title": "커널 파라미터(Sysctl) 튜닝",
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
    "solution": "공통 · 시스템",
    "title": "프로세스 장애 유발 및 로그 추적",
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
  }
]
