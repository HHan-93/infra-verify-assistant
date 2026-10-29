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
