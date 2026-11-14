# 검사 견본

**실제 장비에서 받은 출력**만 둔다 — 추측으로 만든 출력에 맞춘 파서는 현장에서 틀린다.

| 파일 | 출처 |
|---|---|
| `pcs-status-full.txt` | contrabass 클러스터 `pcs status --full` (pacemaker 2.1.6, 2026-10-22) |
| `crm_mon-t.txt` | 같은 클러스터 `crm_mon -1 -t` (Operations 절 — 일부 노드의 동작 줄은 줄여 둠) |
| `journal-corosync.txt` | `journalctl -u corosync -u pacemaker -o short-iso` — 노드를 번호(`host: 3`)로 적는다 |
| `masakari-engine-error.log` | 2026-10-26 con02 `masakari-engine.log` — keystone 500 으로 알림을 `status: error` 로 끝냄(TRACE 줄은 줄여 둠, ANSI 색 제거) |
| `masakari-engine-503.log` | 2026-10-27 con02 — con03 이 error 로 끝낸 알림을 주기 작업이 다시 집어 `DisableComputeServiceTask` 에서 Nova API 503 → error · failed(VM 이동 시도 없음). 화면 캡처에서 옮겨 적음, TRACE 는 앞뒤 몇 줄만 |
| `masakari-engine-fail-1830.log` | 같은 날 18:30 con03 — 두 번째 회차의 실패(7대 못 옮김 · 1대 확인 시간 초과 608초) 줄만 |
| `masakari-engine-retry.log` | 같은 날 con03 — error 난 알림을 이어받아 evacuate(11대 중 앞 3대만 둠) → 16:20 VM 한 대 evacuation 시간 초과(601초)로 `error` 와 `failed`(periodic task) 가 잇달아 찍힘 |
| `nova-migration-list.json` | `openstack server migration list --type evacuation` 표(2026-10-22 con01 화면)를 JSON 열 이름으로 옮긴 것. 시각은 UTC |
| `podlog-bootfactory-valkey-dns.log` | 2026-10-28 epoxy boot-factory 파드 로그(사용자가 붙여 줌) — valkey DNS 조회 시간 초과 WARN + 스택. 스택 가운데 줄은 줄여 둠, 클러스터 DNS IP 는 10.0.0.10 으로 가림 |

새 형식을 만나면(버전 차이 등) 그 출력을 여기 더하고 검사를 추가한다.

## 환경 구성도(envmap-*) — 2026-11-14 epoxy(Rocky 9.6 CIQ · Epoxy · Ceph 19.2.3 · k8s v1.34) 사용자가 붙여 준 출력

IP 는 모두 가렸다: 관리 · Ceph 망 앞 두 자리는 `10.99.`, NTP 서버 IP 는 `192.0.2.10`, 이름은 `ntp.example.net` 으로 바꿨다. 각 파일의 `@@QT:구역@@` 줄은 수집 스크립트(src/lib/envMap.ts)가 찍는 구분 줄로, 사용자가 명령마다 따로 돌린 출력을 그 자리에 넣었다.

| 파일 | 출처 |
|---|---|
| `envmap-node1.txt` · `envmap-node4.txt` | 노드1(믹스드) · 노드4(컴퓨트) — hostname · os-release · uname · nproc/free/lscpu · `ip -br -4 addr` · running 유닛(받은 것은 grep 으로 거른 목록, 노드1 은 ceph 유닛 일부 줄임) · chronyc |
| `envmap-ctrl.txt` | contrabass01 `pcs status` · `rabbitmqctl cluster_status`(Listeners · Feature flags 절 줄임) · `mysql -e "SHOW STATUS …wsrep…"`(표 꼴) |
| `envmap-openstack.json` | `openstack … -f json` 출력을 열쇠별로 모음 — server list(44대 중 Epoxy_* 13대 + 상관없는 VM 4대만), hypervisor · flavor(일부) · compute service(일부) · segment host list. **segment list 는 표로만 받아** JSON 열 이름으로 옮겼다 |
| `envmap-ceph.txt` | contrabass02 `ceph -s -f json`(servicemap 비움) · `ceph orch ps -f json`(필드 줄임) · `ceph node ls` · `ceph osd pool ls detail -f json`(11개 중 3개 · 필드 줄임). `ceph osd tree -f json` 은 받지 못해 없다(장치 종류가 비는 경우) |
| `envmap-k8s.txt` | epoxy-master-2 `kubectl version` · `get nodes -o wide` · 파드 custom-columns(154줄 중 종류별로 골라 줄임) · DaemonSet(`get deploy,sts,ds` 표의 ds 줄을 `get ds -A --no-headers` 꼴로) — 이때 노드3 위 두 k8s 노드가 NotReady 였다 |
