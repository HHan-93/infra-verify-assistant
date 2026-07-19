// 단일 명령어 프리셋 (카테고리 → 하위분류 → 명령어).
// 명령어_편집.md 에서 자동 생성됨. <...> 플레이스홀더는 앱에서 실행 대신 "입력".

export interface PresetCommand {
  label: string
  command: string
  desc: string
}

export interface PresetSubGroup {
  name: string
  commands: PresetCommand[]
}

export interface PresetGroup {
  solution: string
  subgroups: PresetSubGroup[]
}

export const PRESETS: PresetGroup[] = [
  {
    "solution": "OpenStack",
    "subgroups": [
      {
        "name": "컴퓨트 (Nova)",
        "commands": [
          {
            "label": "컴퓨트 서비스 상태",
            "command": "openstack compute service list",
            "desc": "Nova 데몬(compute, scheduler, conductor) 활성 상태 확인"
          },
          {
            "label": "컴퓨트 노드 제어(차단)",
            "command": "openstack compute service set --disable --disable-reason \"QA_Test\" <HOST> nova-compute",
            "desc": "특정 컴퓨트 노드 스케줄링 일시 차단 (유지보수/검증용)"
          },
          {
            "label": "인스턴스 목록(전체)",
            "command": "openstack server list --all-projects --long",
            "desc": "전체 프로젝트의 VM 상태 및 배치된 물리 호스트 노드 조회"
          },
          {
            "label": "ERROR 인스턴스 검색",
            "command": "openstack server list --all-projects --status ERROR",
            "desc": "생성 실패하거나 오류 상태에 빠진 VM만 정확히 필터링"
          },
          {
            "label": "인스턴스 상세 정보",
            "command": "openstack server show <SERVER_ID>",
            "desc": "VM의 생성 시간, 네트워크, 보안 그룹, 배치 호스트 상세 메타데이터"
          },
          {
            "label": "인스턴스 콘솔 로그",
            "command": "openstack console log show <SERVER_ID>",
            "desc": "커널 패닉, 부팅 에러 등 VM 초기화 콘솔 로그 확인"
          },
          {
            "label": "인스턴스 액션 기록",
            "command": "openstack server event list <SERVER_ID>",
            "desc": "VM에 수행된 API 요청(생성/재부팅/마이그레이션) 이력 추적"
          },
          {
            "label": "VM 상태 ACTIVE 변경",
            "command": "openstack server set --state active <VM_ID>",
            "desc": "ERROR 등 비정상 상태로 멈춘 VM의 DB 상태값만 ACTIVE로 강제 수정 (실제 동작 이상 시 하드 리부트 병행)"
          },
          {
            "label": "VM 하드 리부트 진행",
            "command": "openstack server reboot --hard <VM_ID>",
            "desc": "하이퍼바이저 레벨에서 강제 전원 재투입(콜드 리부트). 소프트 리부트로 응답 없는 VM 복구용"
          },
          {
            "label": "VM 소프트 리부트 진행",
            "command": "openstack server reboot --soft <VM_ID>",
            "desc": "OS에 정상 종료 신호를 보내는 일반 재부팅 (게스트 OS가 응답 가능할 때)"
          },
          {
            "label": "하이퍼바이저 리소스",
            "command": "openstack hypervisor list --long",
            "desc": "각 물리 노드별 vCPU, RAM, 로컬 디스크 사용량 및 할당량"
          },
          {
            "label": "셀(Cell) 호스트 갱신",
            "command": "nova-manage cell_v2 discover_hosts",
            "desc": "신규 노드 증설 직후 컨트롤 플레인에 새 호스트를 즉시 인식시킴"
          },
          {
            "label": "라이브 마이그레이션",
            "command": "openstack server migrate <SERVER_ID> --live-migration",
            "desc": "다운타임 없이 VM을 다른 컴퓨트 노드로 실시간 이동"
          },
          {
            "label": "마이그레이션 상태",
            "command": "openstack server migration list",
            "desc": "마이그레이션 진행률 및 성공/실패 여부 확인"
          }
        ]
      },
      {
        "name": "네트워크 (Neutron·OVS)",
        "commands": [
          {
            "label": "네트워크 에이전트",
            "command": "openstack network agent list",
            "desc": "L3/DHCP 에이전트의 alive 상태 및 호스트 매핑 확인"
          },
          {
            "label": "네트워크 리스트 상세 조회",
            "command": "openstack network list --long",
            "desc": "내부/외부 네트워크, 서브넷 매핑, MTU 및 Provider 정보"
          },
          {
            "label": "서브넷 목록 조회",
            "command": "openstack subnet list",
            "desc": "각 네트워크에 종속된 서브넷의 IP 대역(CIDR) 할당 현황 및 DHCP 활성화 여부 확인"
          },
          {
            "label": "가상 포트 상세",
            "command": "openstack port show <PORT_ID>",
            "desc": "VM 가상 포트의 MAC, 바인딩 호스트, ACTIVE/DOWN 상태"
          },
          {
            "label": "Floating IP 할당",
            "command": "openstack floating ip list",
            "desc": "외부 통신용 Public IP의 할당 및 연결 포트 상태 점검"
          },
          {
            "label": "보안 그룹 룰 상세",
            "command": "openstack security group rule list",
            "desc": "Ingress/Egress 포트, 프로토콜, 타겟 IP 대역 룰 확인"
          },
          {
            "label": "OVS 브릿지 상태",
            "command": "ovs-vsctl show",
            "desc": "Open vSwitch의 br-int, br-ex, br-tun 브릿지 및 포트 매핑"
          },
          {
            "label": "OVS 오픈플로우 룰",
            "command": "ovs-ofctl dump-flows br-int",
            "desc": "VM 간 통신 및 보안 룰이 적용된 OVS OpenFlow 플로우 덤프"
          }
        ]
      },
      {
        "name": "스토리지 (Cinder)",
        "commands": [
          {
            "label": "볼륨 목록(전체)",
            "command": "openstack volume list --all-projects --long",
            "desc": "전체 볼륨 상태(in-use/available/error) 및 연결된 인스턴스"
          },
          {
            "label": "볼륨 상세 정보",
            "command": "openstack volume show <VOLUME_ID>",
            "desc": "볼륨 생성 실패 시 백엔드 스토리지 매핑 및 에러 코드 분석"
          },
          {
            "label": "볼륨 백업 리스트",
            "command": "openstack volume backup list",
            "desc": "Cinder를 통해 생성된 볼륨 백업 이미지 및 상태 확인"
          },
          {
            "label": "볼륨 용량 확장",
            "command": "openstack volume extend <VOLUME_ID> <NEW_SIZE>",
            "desc": "기존에 생성된 Cinder 블록 스토리지 볼륨의 크기를 지정한 용량(GB)으로 온라인 확장"
          }
        ]
      },
      {
        "name": "이미지 (Glance)",
        "commands": [
          {
            "label": "이미지 목록(전체)",
            "command": "openstack image list --long",
            "desc": "OS 이미지 상태, 포맷(qcow2/raw), 크기, 가시성 조회"
          },
          {
            "label": "신규 이미지 업로드",
            "command": "openstack image create --file <FILE_PATH> --disk-format qcow2 --container-format bare --public <IMAGE_NAME>",
            "desc": "로컬에 준비된 qcow2 등 OS 이미지 파일을 Glance 서비스에 신규 등록(public)"
          }
        ]
      },
      {
        "name": "메시지큐·DB",
        "commands": [
          {
            "label": "RabbitMQ 클러스터",
            "command": "rabbitmqctl cluster_status",
            "desc": "메시지 큐 노드 상태 및 파티션(네트워크 단절) 발생 여부"
          },
          {
            "label": "메시지 큐 적체 확인",
            "command": "rabbitmqctl list_queues | grep -v ' 0'",
            "desc": "처리되지 못하고 큐에 쌓여있는 데드레터 메시지 목록 확인"
          },
          {
            "label": "MariaDB 갤러라 상태",
            "command": "mysql -u root -e \"SHOW STATUS LIKE 'wsrep_cluster_size';\"",
            "desc": "DB 이중화(Galera) 노드 개수 및 클러스터 싱크 정상 여부"
          }
        ]
      },
      {
        "name": "인증·쿼터 (Keystone)",
        "commands": [
          {
            "label": "엔드포인트 URL 점검",
            "command": "openstack endpoint list",
            "desc": "전체 서비스의 public, internal, admin API 엔드포인트 매핑"
          },
          {
            "label": "프로젝트/테넌트 목록",
            "command": "openstack project list",
            "desc": "클러스터 내 구성된 전체 프로젝트 및 도메인 확인"
          },
          {
            "label": "유저 권한 매핑",
            "command": "openstack role assignment list --names",
            "desc": "특정 유저가 어느 프로젝트에서 admin/member 권한을 가지는지 조회"
          },
          {
            "label": "테넌트 리소스 쿼터",
            "command": "openstack quota show --default",
            "desc": "프로젝트별 최대 생성 가능한 VM, 볼륨, IP 제한량 조회"
          }
        ]
      },
      {
        "name": "하이퍼바이저 (Libvirt)",
        "commands": [
          {
            "label": "호스트 KVM VM 상태",
            "command": "virsh list --all",
            "desc": "컴퓨트 노드 쉘에서 하이퍼바이저 레벨의 실제 VM 구동 상태 조회"
          },
          {
            "label": "인스턴스 상태",
            "command": "virsh dominfo <INSTANCE_ALIAS>",
            "desc": "인스턴스의 CPU, 메모리, 상태 등을 조회"
          },
          {
            "label": "VM 디스크 매핑 확인",
            "command": "virsh domblklist <INSTANCE_NAME>",
            "desc": "VM에 매핑된 실제 블록 디바이스(RBD 경로 등) 식별"
          },
          {
            "label": "xml 설정 파일 직접 확인",
            "command": "virsh dumpxml <INSTANCE_ALIAS>",
            "desc": "인스턴스에 적용된 모든 설정(네트워크, 디스크, CPU, 메모리 등)을 원본 XML 형태로 조회"
          }
        ]
      },
      {
        "name": "컨트롤러 HA (Pacemaker)",
        "commands": [
          {
            "label": "클러스터 전체 상태",
            "command": "pcs status",
            "desc": "노드·리소스 상태와 VIP가 어느 노드에서 running 중인지 한눈에 확인"
          },
          {
            "label": "리소스 상태만 압축 조회",
            "command": "pcs status resources",
            "desc": "VIP 등 각 리소스별 현재 실행 노드만 간결하게 확인"
          },
          {
            "label": "클러스터 상세 상태",
            "command": "pcs status --full",
            "desc": "fail count 등을 포함한 노드·리소스 상세 상태 확인"
          }
        ]
      },
      {
        "name": "로그",
        "commands": [
          {
            "label": "Nova 에러 로그",
            "command": "tail -n 100 /var/log/nova/nova-api.log | grep -i error",
            "desc": "VM 생성 실패 시 가장 먼저 확인할 Nova API 최근 에러 로그"
          },
          {
            "label": "Neutron 에러 로그",
            "command": "tail -n 100 /var/log/neutron/neutron-server.log | grep -i error",
            "desc": "네트워크/포트 바인딩 실패 시 원인 파악용 에러 로그"
          },
          {
            "label": "Cinder 에러 로그",
            "command": "tail -n 100 /var/log/cinder/cinder-volume.log | grep -i error",
            "desc": "볼륨 생성 및 연결 실패 시 스토리지 연동 에러 로그"
          }
        ]
      }
    ]
  },
  {
    "solution": "Ceph",
    "subgroups": [
      {
        "name": "클러스터",
        "commands": [
          {
            "label": "클러스터 요약(s)",
            "command": "ceph -s",
            "desc": "HEALTH, MON/OSD, PG, 용량 상태를 확인하는 최우선 점검 명령"
          },
          {
            "label": "클러스터 헬스 상세",
            "command": "ceph health detail",
            "desc": "WARN/ERR 발생 시 크래시 데몬이나 손상된 PG 등 근본 원인 출력"
          },
          {
            "label": "실시간 이벤트(w)",
            "command": "ceph -w",
            "desc": "PG 변경, OSD Up/Down, 리밸런싱 등 실시간 모니터링 (종료: Ctrl+C)"
          },
          {
            "label": "MON 쿼럼 상태",
            "command": "ceph quorum_status --format json-pretty",
            "desc": "모니터 노드 선출 상태 및 쿼럼 정상 형성 딥다이브 (JSON)"
          },
          {
            "label": "MGR 모듈 상태",
            "command": "ceph mgr module ls",
            "desc": "Dashboard, Prometheus 익스포터 등 활성화된 MGR 플러그인 상태"
          },
          {
            "label": "데몬 컨테이너 목록",
            "command": "ceph orch ps",
            "desc": "Cephadm 오케스트레이터로 배포된 OSD/MON/MGR 데몬 컨테이너 상태"
          },
          {
            "label": "클러스터 에러 로그",
            "command": "tail -n 200 /var/log/ceph/ceph.log | grep -iE 'err|warn'",
            "desc": "최근 200줄 로그에서 클러스터 에러와 경고 알람만 필터링"
          }
        ]
      },
      {
        "name": "OSD",
        "commands": [
          {
            "label": "OSD 트리/가중치",
            "command": "ceph osd tree",
            "desc": "CRUSH 맵 기반 호스트 노드별 OSD 트리와 weight, up/down 상태"
          },
          {
            "label": "OSD 트리 JSON",
            "command": "ceph osd tree -f json-pretty",
            "desc": "OSD 구성도를 JSON으로 출력하여 파싱/자동화 스크립트 연동"
          },
          {
            "label": "디스크 사용률(OSD)",
            "command": "ceph osd df",
            "desc": "OSD별 물리 디스크 사용량, 여유 공간, 데이터 분산 편차(variance)"
          },
          {
            "label": "PG 오토스케일 상태",
            "command": "ceph osd pool autoscale-status",
            "desc": "각 풀별 데이터 타겟 사이즈 대비 현재 PG 개수의 적절성 및 자동 확장 데몬의 동작 상태 확인"
          },
          {
            "label": "OSD 데몬 성능 지연",
            "command": "ceph osd perf",
            "desc": "각 OSD의 commit/apply 지연 시간(Latency) 추적 (느린 디스크 색출)"
          },
          {
            "label": "자동 아웃(Out) 방지",
            "command": "ceph osd set noout",
            "desc": "노드 재부팅/점검 전 OSD가 Out되어 불필요한 리밸런싱이 발생하지 않도록 홀드"
          },
          {
            "label": "자동 아웃 방지 해제",
            "command": "ceph osd unset noout",
            "desc": "점검 완료 후 noout 플래그 해제하여 정상 관리 상태 복구"
          },
          {
            "label": "강제 딥 스크럽",
            "command": "ceph osd scrub <OSD_ID>",
            "desc": "특정 OSD 데이터 정합성 검사(Scrub) 강제 수행 예약"
          },
          {
            "label": "OSD 크래시 기록",
            "command": "ceph crash ls",
            "desc": "비정상 종료되거나 크래시된 OSD 데몬 이력 확인"
          },
          {
            "label": "크래시 알람 초기화",
            "command": "ceph crash archive-all",
            "desc": "확인이 끝난 크래시 로그를 보관 처리하여 클러스터 경고 알람 해제"
          }
        ]
      },
      {
        "name": "PG",
        "commands": [
          {
            "label": "PG 통계 요약",
            "command": "ceph pg stat",
            "desc": "PG 맵 버전 및 클라이언트 Read/Write IOPS, Throughput 요약"
          },
          {
            "label": "비정상(Stuck) PG",
            "command": "ceph pg dump_stuck inactive",
            "desc": "데이터 I/O 처리가 멈춰있는(stuck) Placement Group 확인"
          },
          {
            "label": "복구중(Degraded) PG",
            "command": "ceph pg dump_stuck degraded",
            "desc": "노드/OSD 장애로 데이터 리플리케이션이 진행 중인 PG 확인"
          },
          {
            "label": "손상된 PG 수동 복구",
            "command": "ceph pg repair <PG_ID>",
            "desc": "Inconsistent 에러가 뜬 특정 PG에 대해 수동 복구 커맨드 전송"
          }
        ]
      },
      {
        "name": "풀/RADOS",
        "commands": [
          {
            "label": "풀 리스트 상세",
            "command": "ceph osd pool ls detail",
            "desc": "전체 풀의 size, min_size, crush rule, pg_num 등 세부 설정값"
          },
          {
            "label": "풀별 용량(ceph df)",
            "command": "ceph df detail",
            "desc": "풀별 사용량, 가용량 및 저장된 오브젝트 수 요약"
          },
          {
            "label": "논리적 데이터 용량",
            "command": "rados df",
            "desc": "풀에 저장된 객체 수, 크기 및 논리/물리적 데이터 사용률 분석"
          },
          {
            "label": "풀 실시간 I/O 부하",
            "command": "ceph osd pool stats",
            "desc": "각 풀에서 발생하는 실시간 Client Read/Write I/O 모니터링"
          },
          {
            "label": "RADOS 성능 벤치마크",
            "command": "rados bench -p <POOL_NAME> 60 write --no-cleanup",
            "desc": "특정 풀 대상 60초 쓰기 부하 테스트로 Throughput/IOPS 성능 한계 검증"
          },
          {
            "label": "저장된 오브젝트 리스트",
            "command": "rados -p <POOL_NAME> ls",
            "desc": "특정 풀에 저장된 오브젝트 청크 리스트 실제 조회 (데이터 유실 검증)"
          },
          {
            "label": "오브젝트 OSD 추적",
            "command": "ceph osd map <POOL_NAME> <OBJECT>",
            "desc": "특정 파일(오브젝트)이 실제 어느 OSD에 나뉘어 저장되는지 매핑 추적"
          }
        ]
      },
      {
        "name": "블록 (RBD)",
        "commands": [
          {
            "label": "RBD 이미지 리스트",
            "command": "rbd ls -p <POOL_NAME>",
            "desc": "풀에 생성된 블록 디바이스(VM 디스크 등) 이미지 조회"
          },
          {
            "label": "RBD 이미지 상세",
            "command": "rbd info <IMAGE_NAME> -p <POOL_NAME>",
            "desc": "RBD 이미지 실제 크기, 객체 크기(기본 4M), 포맷, Lock 상태"
          },
          {
            "label": "RBD 스냅샷 생성",
            "command": "rbd snap create <POOL_NAME>/<IMAGE_NAME>@<SNAP_NAME>",
            "desc": "특정 블록 디바이스의 현재 상태를 스냅샷으로 즉각 보존하여 데이터 백업 및 롤백 지점 확보"
          },
          {
            "label": "삭제 대기 중인 RBD",
            "command": "rbd trash ls -p <POOL_NAME>",
            "desc": "삭제 명령 수신 후 백그라운드 정리 대기 중인 이미지 목록"
          },
          {
            "label": "RBD 직접 마운트",
            "command": "rbd map <IMAGE_NAME> -p <POOL_NAME>",
            "desc": "특정 RBD 이미지를 클라이언트(호스트) 블록 디바이스로 직접 맵핑"
          }
        ]
      },
      {
        "name": "CephFS/RGW",
        "commands": [
          {
            "label": "CephFS MDS 상태",
            "command": "ceph mds stat",
            "desc": "파일시스템 메타데이터 서버의 Active/Standby 상태 및 랭크"
          },
          {
            "label": "CephFS 상세 상태",
            "command": "ceph fs status",
            "desc": "MDS 메모리 사용량, 연결된 클라이언트 수 등 파일시스템 종합 헬스"
          },
          {
            "label": "오브젝트 사용자 목록",
            "command": "radosgw-admin user list",
            "desc": "S3/Swift용 RADOS Gateway에 등록된 유저 식별자 리스트"
          }
        ]
      },
      {
        "name": "인증·설정·성능",
        "commands": [
          {
            "label": "클라이언트 키링 상세",
            "command": "ceph auth get client.admin",
            "desc": "admin 등 클라이언트의 인증 키(Keyring) 값 및 접근 권한 출력"
          },
          {
            "label": "성능 카운터 덤프",
            "command": "ceph daemon osd.<OSD_ID> perf dump",
            "desc": "데몬 소켓 통신으로 내부 성능 카운터/지연 시간 통계 딥다이브 추출"
          },
          {
            "label": "런타임 동적 설정 확인",
            "command": "ceph config show-with-defaults osd.<OSD_ID>",
            "desc": "특정 데몬의 메모리에 로드된 현재 런타임 설정값 전체 확인"
          }
        ]
      }
    ]
  },
  {
    "solution": "Kubernetes",
    "subgroups": [
      {
        "name": "노드 (Node)",
        "commands": [
          {
            "label": "노드 목록",
            "command": "kubectl get nodes",
            "desc": "클러스터에 등록된 전체 노드명과 Ready 상태만 간략히 확인"
          },
          {
            "label": "노드 상태 및 IP",
            "command": "kubectl get nodes -o wide",
            "desc": "워커/마스터 노드의 Ready 상태, 내부 IP, 커널 및 런타임 버전"
          },
          {
            "label": "노드 상세 리소스",
            "command": "kubectl describe nodes",
            "desc": "노드 Taint, 스케줄링된 파드, CPU/Mem 요청(Request) 및 제한량"
          },
          {
            "label": "노드 테인트(Taint) 확인",
            "command": "kubectl get nodes -o jsonpath='{range .items[*]}{.metadata.name}{\"\\t\"}{.spec.taints}{\"\\n\"}{end}'",
            "desc": "파드 스케줄링을 막는 오염(Taint) 설정값만 추출하여 원인 분석"
          },
          {
            "label": "노드 안전 퇴출(Drain)",
            "command": "kubectl drain <NODE_NAME> --ignore-daemonsets --delete-emptydir-data",
            "desc": "유지보수 전 실행 중인 파드를 다른 노드로 안전하게 대피(Eviction)"
          },
          {
            "label": "스케줄링 일시 차단",
            "command": "kubectl cordon <NODE_NAME>",
            "desc": "파드 대피 없이 해당 노드에 신규 파드가 생성되는 것만 막음"
          }
        ]
      },
      {
        "name": "파드 (Pod)",
        "commands": [
          {
            "label": "네임스페이스 목록",
            "command": "kubectl get namespaces",
            "desc": "클러스터에 생성된 전체 네임스페이스와 상태(Active/Terminating) 확인"
          },
          {
            "label": "전체 파드 목록(요약)",
            "command": "kubectl get pods -A",
            "desc": "모든 네임스페이스의 파드명과 상태(STATUS)만 간략히 조회"
          },
          {
            "label": "전체 파드 목록",
            "command": "kubectl get pods -A -o wide",
            "desc": "모든 네임스페이스 파드의 상태, 배치된 노드, 할당 IP 조회"
          },
          {
            "label": "비정상 파드 필터링",
            "command": "kubectl get pods -A --field-selector=status.phase!=Running",
            "desc": "Pending, Error, Crash 상태인 결함 파드만 정확하게 필터링"
          },
          {
            "label": "파드 상세 분석",
            "command": "kubectl describe pod <POD_NAME> -n <NAMESPACE>",
            "desc": "ImagePullBackOff, 스케줄링 실패 사유 등 파드 상세 이벤트 로그"
          },
          {
            "label": "파드 강제 삭제(재생성 유도)",
            "command": "kubectl delete pod -n <NAMESPACE> <POD_NAME>",
            "desc": "문제 있는 파드를 삭제해 컨트롤러(Deployment/ReplicaSet)가 새 파드로 즉시 재생성하도록 유도 (강제 재시작 용도)"
          },
          {
            "label": "파드 상태 실시간 감시(Watch)",
            "command": "kubectl get pods -w",
            "desc": "파드의 생성, 종료, 에러(Crash) 등 상태 변화 이벤트를 실시간 스트림으로 모니터링"
          },
          {
            "label": "특정 네임스페이스 파드 감시(watch)",
            "command": "watch kubectl get pod -n <NAMESPACE> -o wide",
            "desc": "watch 명령으로 지정 네임스페이스의 파드 상태·배치 노드를 주기적으로 갱신하며 관찰"
          },
          {
            "label": "라벨 기준 파드 조회",
            "command": "kubectl get pods -l app=<APP_NAME> -n <NAMESPACE>",
            "desc": "특정 라벨(예: 앱 이름)을 가진 파드 그룹만 모아서 조회"
          },
          {
            "label": "노드 리소스 사용량",
            "command": "kubectl top nodes",
            "desc": "노드의 현재 CPU/메모리 실제 사용량(Metrics Server 기반)"
          },
          {
            "label": "파드 리소스 사용량",
            "command": "kubectl top pods -A",
            "desc": "파드의 현재 CPU/메모리 실제 사용량(Metrics Server 기반)"
          },
          {
            "label": "파드 로그 조회",
            "command": "kubectl logs -n <NAMESPACE> <POD_NAME>",
            "desc": "파드(컨테이너) 표준출력 로그 스냅샷 조회 — 애플리케이션 에러 확인 1순위"
          },
          {
            "label": "파드 로그 실시간 스트리밍",
            "command": "kubectl logs -f -n <NAMESPACE> <POD_NAME>",
            "desc": "tail -f 방식으로 로그를 실시간 스트리밍 (Ctrl+C 종료)"
          },
          {
            "label": "컨테이너 지정 로그 조회",
            "command": "kubectl logs -n <NAMESPACE> <POD_NAME> -c <CONTAINER_NAME>",
            "desc": "사이드카 등 파드 내 컨테이너가 여러 개일 때 특정 컨테이너의 로그만 지정 조회"
          },
          {
            "label": "크래시 이전 로그",
            "command": "kubectl logs <POD_NAME> -n <NAMESPACE> --previous",
            "desc": "컨테이너가 죽었을 때 재시작 직전 컨테이너가 남긴 에러 로그 추출"
          },
          {
            "label": "파드 내부 쉘 접속",
            "command": "kubectl exec -it <POD_NAME> -n <NAMESPACE> -- /bin/sh",
            "desc": "파드 컨테이너 내부에 직접 접근하여 설정/네트워크 상태 검증"
          },
          {
            "label": "파드 내부 파일 복사",
            "command": "kubectl cp <NAMESPACE>/<POD_NAME>:<PATH> <LOCAL_PATH>",
            "desc": "컨테이너 안의 힙 덤프, 로그 등 디버깅 파일을 로컬로 복사"
          },
          {
            "label": "전체 리소스 일괄 조회",
            "command": "kubectl get all -n <NAMESPACE>",
            "desc": "특정 네임스페이스의 Pod, Service, Deployment, ReplicaSet 일괄"
          }
        ]
      },
      {
        "name": "네트워크",
        "commands": [
          {
            "label": "서비스 엔드포인트",
            "command": "kubectl get endpoints -A",
            "desc": "Service와 실제 Pod IP 매핑이 정상적으로 로드밸런싱 되는지 검증"
          },
          {
            "label": "Ingress 라우팅 룰",
            "command": "kubectl get ingress -A",
            "desc": "외부 트래픽을 내부 서비스로 연결하는 도메인 및 Path 라우팅 룰"
          },
          {
            "label": "DNS 질의 테스트",
            "command": "kubectl run -i --tty --rm debug --image=busybox --restart=Never -- nslookup kubernetes.default",
            "desc": "임시 파드를 생성해 CoreDNS의 클러스터 내부 네임 레졸루션 점검"
          },
          {
            "label": "로컬 포트 포워딩",
            "command": "kubectl port-forward svc/<SVC_NAME> <LOCAL_PORT>:<SVC_PORT>",
            "desc": "외부 노출이 없는 백엔드 서비스 UI/API를 로컬 PC 포트로 임시 연결"
          }
        ]
      },
      {
        "name": "스토리지",
        "commands": [
          {
            "label": "PV/PVC 상태 맵",
            "command": "kubectl get pv,pvc -A",
            "desc": "프로비저닝된 물리 볼륨(PV)과 파드의 볼륨 클레임(PVC) Bound 상태"
          },
          {
            "label": "스토리지 클래스",
            "command": "kubectl get sc",
            "desc": "CSI 프로바이더(Ceph RBD/CephFS 등) 볼륨 동적 프로비저닝 설정"
          }
        ]
      },
      {
        "name": "워크로드/배포",
        "commands": [
          {
            "label": "디플로이먼트 상태",
            "command": "kubectl get deployments -A",
            "desc": "요구 레플리카 수와 실제 동작 중인 파드 수가 일치하는지 정합성 확인"
          },
          {
            "label": "롤아웃 히스토리",
            "command": "kubectl rollout history deployment/<NAME> -n <NAMESPACE>",
            "desc": "앱 버전 업데이트 이력 및 리비전 넘버 확인"
          },
          {
            "label": "디플로이먼트 롤백",
            "command": "kubectl rollout undo deployment/<NAME> -n <NAMESPACE>",
            "desc": "신규 배포 결함 시 직전의 정상 리비전 파드로 즉시 롤백"
          },
          {
            "label": "파드 스케일링",
            "command": "kubectl scale deployment <NAME> --replicas=<NUM> -n <NAMESPACE>",
            "desc": "수동으로 파드 개수를 늘리거나 줄여 부하 대응 및 동작 검증"
          },
          {
            "label": "재배포(Restart)",
            "command": "kubectl rollout restart deployment/<NAME> -n <NAMESPACE>",
            "desc": "기존 파드를 하나씩 재생성하여 ConfigMap 등 변경 설정 갱신"
          },
          {
            "label": "Helm 릴리스 목록",
            "command": "helm list -A",
            "desc": "Helm 차트로 배포된 서비스의 버전, 상태(deployed/failed) 확인"
          },
          {
            "label": "Helm 주입 변수 덤프",
            "command": "helm get values <RELEASE_NAME> -n <NAMESPACE>",
            "desc": "차트 배포 시 사용자가 주입한 values.yaml 커스텀 설정값 전체 출력"
          }
        ]
      },
      {
        "name": "관리·설정",
        "commands": [
          {
            "label": "API 지원 리소스",
            "command": "kubectl api-resources",
            "desc": "현재 클러스터에 등록된 전체 CRD 및 기본 객체 단축어(Shortnames)"
          },
          {
            "label": "컴포넌트 헬스",
            "command": "kubectl get componentstatuses",
            "desc": "etcd, 스케줄러, 컨트롤러 등 마스터 노드 핵심 컴포넌트 헬스 체크"
          },
          {
            "label": "RBAC 권한 디버깅",
            "command": "kubectl auth can-i create pods --as=system:serviceaccount:<NS>:<SA_NAME>",
            "desc": "특정 서비스 어카운트가 파드 생성 등의 권한을 보유했는지 테스트"
          },
          {
            "label": "컨피그맵/시크릿 조회",
            "command": "kubectl get cm,secret -A",
            "desc": "파드에 주입되는 환경변수, 설정 파일 및 암호화 인증 데이터 목록"
          },
          {
            "label": "전체 이벤트 추적",
            "command": "kubectl get events -A --sort-by='.lastTimestamp'",
            "desc": "시간순으로 발생한 클러스터 내 모든 에러/경고/상태 변경 이벤트"
          }
        ]
      },
      {
        "name": "로그",
        "commands": [
          {
            "label": "kubelet 로그 스트림",
            "command": "journalctl -u kubelet -f",
            "desc": "물리 노드의 kubelet 데몬 로그 추적 (파드 생성 실패 원인, Ctrl+C)"
          },
          {
            "label": "containerd 로그",
            "command": "journalctl -u containerd -n 100 --no-pager",
            "desc": "컨테이너 런타임의 이미지 풀링 실패나 구동 에러 로그 100줄"
          }
        ]
      }
    ]
  },
  {
    "solution": "시스템·부하검증",
    "subgroups": [
      {
        "name": "시스템/프로세스",
        "commands": [
          {
            "label": "상위 프로세스(top)",
            "command": "top -b -n 1 | head -n 20",
            "desc": "시스템 자원을 과다 점유하는 상위 20개 프로세스 스냅샷"
          },
          {
            "label": "시스템 메모리 사용량",
            "command": "free -h",
            "desc": "전체 RAM 및 Swap 메모리의 총량, 사용량, 그리고 리눅스 캐시(buff/cache) 여유분 조회"
          },
          {
            "label": "통합 실시간 뷰(dstat)",
            "command": "dstat -cdngy 1",
            "desc": "1초 단위로 CPU, 디스크 I/O, 네트워크 대역폭, 페이징 종합 출력 (Ctrl+C)"
          },
          {
            "label": "커널 패닉/OOM(dmesg)",
            "command": "dmesg -T --level=err,crit,alert,emerg",
            "desc": "OOM Killer, 디스크 배드섹터 등 치명적인 커널 로그만 추출"
          },
          {
            "label": "디스크 I/O 병목(iostat)",
            "command": "iostat -xz 1 5",
            "desc": "블록 디바이스별 Read/Write 속도와 await(지연) 5회 측정"
          },
          {
            "label": "CPU 누적 부하(sar)",
            "command": "sar -u 1 5",
            "desc": "sysstat 기반 CPU 사용량 1초 간격 5회 측정"
          },
          {
            "label": "네트워크 부하(sar)",
            "command": "sar -n DEV 1 5",
            "desc": "sysstat 기반 인터페이스별 네트워크 사용량 5회 측정"
          },
          {
            "label": "페이징/IO Wait(vmstat)",
            "command": "vmstat 1 5",
            "desc": "메모리 스왑(si/so) 상태와 디스크 지연으로 인한 대기(wa) 추적"
          },
          {
            "label": "점유 디렉토리 추적(lsof)",
            "command": "lsof +D /var/log",
            "desc": "특정 디렉토리를 점유하여 삭제를 막는 프로세스 식별"
          },
          {
            "label": "포트 점유 추적(lsof)",
            "command": "lsof -i :80",
            "desc": "특정 포트를 점유 중인 프로세스 식별"
          },
          {
            "label": "부팅 세션 에러 로그",
            "command": "journalctl -p 3 -xb",
            "desc": "현재 부팅 세션에서 발생한 Error 등급(-p 3) 이상의 시스템 로그"
          },
          {
            "label": "런타임 커널 변수",
            "command": "sysctl -a | grep -i 'net.ipv4\\|vm.swappiness'",
            "desc": "메모리 스왑 빈도 및 TCP 네트워크 튜닝 설정 적용 여부"
          },
          {
            "label": "캐시 강제 반환(테스트)",
            "command": "sync; echo 3 > /proc/sys/vm/drop_caches",
            "desc": "임계치 테스트를 위해 PageCache/inode 캐시를 비워 가용 메모리 확보"
          }
        ]
      },
      {
        "name": "부하 테스트",
        "commands": [
          {
            "label": "CPU/메모리 부하 유도",
            "command": "stress-ng --cpu 8 --vm 4 --vm-bytes 2G --timeout 120s",
            "desc": "알람 연동 테스트를 위한 2분간 CPU 점유 및 8GB 램 할당 부하"
          },
          {
            "label": "디스크 스토리지 부하",
            "command": "stress-ng --hdd 2 --hdd-bytes 10G --timeout 60s",
            "desc": "60초간 대용량 Read/Write를 발생시켜 스토리지 컨트롤러 병목 유도"
          },
          {
            "label": "대역폭 테스트(서버)",
            "command": "iperf3 -s -D",
            "desc": "랙 간 대역폭/지연 측정을 위한 iperf3 백그라운드 리슨 대기"
          },
          {
            "label": "대역폭 테스트(클라)",
            "command": "iperf3 -c <SERVER_IP> -t 60 -P 4",
            "desc": "60초간 4개 병렬 스레드로 타겟 노드와의 TCP 최대 실효 대역폭 측정"
          }
        ]
      },
      {
        "name": "네트워크",
        "commands": [
          {
            "label": "패킷 캡처(tcpdump)",
            "command": "tcpdump -i any port 80 -n -c 100",
            "desc": "특정 포트로 인입되는 패킷 헤더와 출발지 IP 100개 캡처"
          },
          {
            "label": "TCP 소켓/포트(ss)",
            "command": "ss -tunlpo",
            "desc": "서버의 TCP/UDP 리슨 포트, 바인딩 프로세스, 타이머 상태 출력"
          },
          {
            "label": "TIME_WAIT 소켓 점검",
            "command": "netstat -nat | grep TIME_WAIT | wc -l",
            "desc": "연결 종료 후 남은 잔여 소켓 수를 카운트하여 커널 튜닝 판단"
          },
          {
            "label": "라우팅 테이블",
            "command": "ip route show",
            "desc": "디폴트 게이트웨이 및 대역별 패킷 우회 라우팅 인터페이스 검증"
          },
          {
            "label": "NIC 이중화(Bonding)",
            "command": "cat /proc/net/bonding/bond0",
            "desc": "LACP 등 본딩 포트의 Active 상태 및 링크 장애 조치(MII) 여부"
          },
          {
            "label": "랜카드 하드웨어 스펙",
            "command": "ethtool eth0",
            "desc": "물리 랜카드 지원 속도(10G/40G), Duplex 상태 및 Link up 확인"
          },
          {
            "label": "실시간 라우팅 지연(mtr)",
            "command": "mtr <TARGET_IP>",
            "desc": "Ping+Traceroute 결합으로 목적지까지 구간별 패킷 손실률 추적"
          },
          {
            "label": "DNS 도메인 쿼리(dig)",
            "command": "dig @<DNS_IP> <DOMAIN> +short",
            "desc": "특정 네임서버를 지정하여 도메인의 A/CNAME 응답 직접 검증"
          }
        ]
      },
      {
        "name": "디스크·하드웨어",
        "commands": [
          {
            "label": "물리 디스크 파티션",
            "command": "lsblk -f",
            "desc": "노드 장착 디스크 블록 구조, UUID, 파일시스템 타입(XFS/EXT4) 매핑"
          },
          {
            "label": "디스크/Inode 사용률",
            "command": "df -iTh",
            "desc": "디스크 여유 공간 + 작은 파일 과다로 인한 Inode 고갈 여부 점검"
          },
          {
            "label": "대용량 디렉토리 색출",
            "command": "du -sh /var/* | sort -rh | head -10",
            "desc": "특정 파티션에서 용량을 가장 많이 차지하는 하위 폴더 10개 추출"
          },
          {
            "label": "CPU/NUMA 스펙",
            "command": "lscpu",
            "desc": "물리 코어, 쓰레드, NUMA 노드 매핑 및 가상화(VT-x) 지원 유무"
          },
          {
            "label": "물리 메모리(RAM) 스펙",
            "command": "dmidecode -t memory | grep -i 'size\\|speed'",
            "desc": "메인보드 뱅크에 장착된 램 모듈의 개별 크기와 동작 클럭"
          },
          {
            "label": "방화벽(Iptables) 룰",
            "command": "iptables -L -n -v | head -n 30",
            "desc": "커널 레벨 패킷 필터링 룰의 Drop/Accept 카운트 확인"
          }
        ]
      }
    ]
  },
  {
    "solution": "리눅스 코어",
    "subgroups": [
      {
        "name": "이동·파일 기본",
        "commands": [
          {
            "label": "현재 위치 확인",
            "command": "pwd",
            "desc": "지금 내가 있는 디렉토리의 전체 경로 출력"
          },
          {
            "label": "폴더 이동",
            "command": "cd <경로>",
            "desc": "지정 폴더로 이동 (.. 상위, ~ 홈)"
          },
          {
            "label": "파일/폴더 목록 상세",
            "command": "ls -alh",
            "desc": "숨김 파일 포함 권한, 소유자, 크기를 읽기 쉬운 단위로 출력"
          },
          {
            "label": "폴더 생성",
            "command": "mkdir -p <폴더명>",
            "desc": "중간 경로(상위 폴더)까지 한 번에 새 폴더 생성"
          },
          {
            "label": "하위 파일 전체 검색",
            "command": "find /var/log -name \"*.log\" -type f",
            "desc": "경로 아래 .log 확장자 파일을 재귀적으로 검색"
          },
          {
            "label": "검색 후 일괄 삭제",
            "command": "find /tmp -name \"*.tmp\" -mtime +7 -exec rm -f {} \\;",
            "desc": "7일 이상 지난 .tmp 찌꺼기 파일을 찾아 일괄 삭제"
          },
          {
            "label": "파일/폴더 복사",
            "command": "cp -r <원본> <대상>",
            "desc": "파일이나 폴더(-r)를 다른 위치로 복사"
          },
          {
            "label": "이동/이름 변경",
            "command": "mv <원본> <대상>",
            "desc": "파일·폴더를 옮기거나 이름 변경 (같은 명령으로 둘 다)"
          },
          {
            "label": "삭제(주의)",
            "command": "rm -ri <대상>",
            "desc": "확인하며(-i) 폴더 포함(-r) 영구 삭제 — 되돌릴 수 없으니 주의"
          },
          {
            "label": "심볼릭 링크 생성",
            "command": "ln -s <원본_경로> <링크_이름>",
            "desc": "복잡한 경로나 파일에 대한 바로가기(소프트 링크)를 생성하여 쉘 접근성을 단순화"
          }
        ]
      },
      {
        "name": "내용·텍스트 처리",
        "commands": [
          {
            "label": "파일 내용 출력",
            "command": "cat <파일명>",
            "desc": "짧은 텍스트 파일 내용 전체를 화면에 출력"
          },
          {
            "label": "명령어 주기적 반복 실행",
            "command": "watch -n 1 <명령어>",
            "desc": "특정 명령어(예: ls, df, kubectl get 등)를 1초 주기로 반복 실행하여 결과 변화를 화면에 실시간 갱신"
          },
          {
            "label": "대용량 파일 페이징",
            "command": "less <파일명>",
            "desc": "대용량 로그를 멈춤 없이 위/아래로 스크롤 열람 (q 종료)"
          },
          {
            "label": "로그 실시간 모니터링",
            "command": "tail -f <파일명>",
            "desc": "실시간으로 추가되는 로그를 꼬리 물며 확인 (Ctrl+C 종료)"
          },
          {
            "label": "단어 검색(grep)",
            "command": "grep -i \"error\" <파일명>",
            "desc": "대소문자 무시(-i)하고 \"error\"가 포함된 모든 줄 필터링"
          },
          {
            "label": "열 파싱(awk)",
            "command": "awk '{print $1, $9}' access.log",
            "desc": "공백 기준으로 로그를 쪼개 1번째(IP)·9번째(상태코드) 열만 추출"
          },
          {
            "label": "라인 구간 출력(sed)",
            "command": "sed -n '100,200p' server.log",
            "desc": "수십만 줄 중 정확히 100~200번 줄 사이만 잘라내기"
          },
          {
            "label": "파이프 반복(xargs)",
            "command": "cat list.txt | xargs -I {} rm -rf {}",
            "desc": "앞 명령의 목록 결과를 하나씩 뒤 명령으로 넘겨 대량 작업"
          }
        ]
      },
      {
        "name": "압축·전송",
        "commands": [
          {
            "label": "폴더 압축(tar.gz)",
            "command": "tar -czvf backup.tar.gz /etc/",
            "desc": "폴더를 하나의 파일로 묶고 gzip으로 용량 압축"
          },
          {
            "label": "압축 해제",
            "command": "tar -xzvf backup.tar.gz -C /tmp/",
            "desc": "tar.gz를 지정 경로(/tmp/)에 원본 구조 그대로 해제"
          },
          {
            "label": "웹 파일 다운로드",
            "command": "curl -O <URL>",
            "desc": "외부/내부 레포에서 스크립트·바이너리 다운로드 (또는 wget <URL>)"
          },
          {
            "label": "원격 안전 복사(scp)",
            "command": "scp <파일명> user@<IP>:<경로>",
            "desc": "SSH로 다른 서버에 설정 파일 등을 안전하게 전송"
          },
          {
            "label": "디렉토리 동기화(rsync)",
            "command": "rsync -avz /data/ /backup/",
            "desc": "변경된 파일만 식별해 증분 백업 — 복제 시간 단축"
          }
        ]
      },
      {
        "name": "권한·프로세스",
        "commands": [
          {
            "label": "권한(퍼미션) 변경",
            "command": "chmod 755 <스크립트.sh>",
            "desc": "실행(x) 권한을 부여하여 쉘에서 구동 가능하게 변경"
          },
          {
            "label": "소유권 갱신",
            "command": "chown -R user:group <폴더명>",
            "desc": "폴더와 하위 전체의 소유자/그룹을 일괄 변경"
          },
          {
            "label": "백그라운드 실행",
            "command": "nohup <명령어> &",
            "desc": "터미널을 닫아도 백그라운드 스크립트가 죽지 않고 유지"
          },
          {
            "label": "프로세스 PID 검색",
            "command": "ps aux | grep <데몬명>",
            "desc": "실행 중인 서비스의 유저, CPU/메모리율 및 PID 검색"
          },
          {
            "label": "프로세스 강제 종료",
            "command": "kill -9 <PID>",
            "desc": "응답이 멈춘(좀비) 프로세스를 PID 기반으로 강제 Kill"
          }
        ]
      },
      {
        "name": "서비스·패키지",
        "commands": [
          {
            "label": "서비스 상태",
            "command": "systemctl status <서비스명>",
            "desc": "systemd 데몬(sshd, nginx 등)의 활성/에러/중지 상태 상세"
          },
          {
            "label": "서비스 자동 시작 등록",
            "command": "systemctl enable --now <서비스명>",
            "desc": "즉시 시작 + 재부팅 시 자동으로 올라오게 등록"
          },
          {
            "label": "패키지 갱신(Ubuntu)",
            "command": "apt update",
            "desc": "레포지토리에서 설치 가능한 최신 패키지 정보 갱신"
          },
          {
            "label": "패키지 갱신(RHEL)",
            "command": "dnf check-update",
            "desc": "RHEL 계열 최신 패키지 버전/의존성 갱신"
          },
          {
            "label": "프로그램 설치",
            "command": "apt install -y <패키지>",
            "desc": "터미널 툴(htop, vim 등) 설치 (-y로 묻지 않고 진행)"
          },
          {
            "label": "프로그램 제거",
            "command": "apt remove <패키지>",
            "desc": "불필요한 패키지 제거"
          },
          {
            "label": "설치 검색(Ubuntu)",
            "command": "dpkg -l | grep <이름>",
            "desc": "해당 라이브러리/툴이 설치되어 있는지 로컬 DB 검색"
          },
          {
            "label": "설치 검색(RHEL)",
            "command": "rpm -qa | grep <이름>",
            "desc": "RHEL 계열에서 설치된 패키지 검색"
          }
        ]
      },
      {
        "name": "도움말·기록",
        "commands": [
          {
            "label": "명령어 매뉴얼",
            "command": "man <명령어>",
            "desc": "명령어의 옵션 플래그와 사용 예제 공식 매뉴얼 (q 종료)"
          },
          {
            "label": "명령어 위치 추적",
            "command": "which <명령어>",
            "desc": "PATH에 등록된 실행 파일의 실제 바이너리 절대 경로 확인"
          },
          {
            "label": "이전 명령어 기록",
            "command": "history | grep <키워드>",
            "desc": "과거 입력했던 긴 명령어를 다시 찾아서 재사용"
          }
        ]
      }
    ]
  }
]
