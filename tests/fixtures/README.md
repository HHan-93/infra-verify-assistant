# 검사 견본

**실제 장비에서 받은 출력**만 둔다 — 추측으로 만든 출력에 맞춘 파서는 현장에서 틀린다.

| 파일 | 출처 |
|---|---|
| `pcs-status-full.txt` | contrabass 클러스터 `pcs status --full` (pacemaker 2.1.6, 2026-10-22) |
| `crm_mon-t.txt` | 같은 클러스터 `crm_mon -1 -t` (Operations 절 — 일부 노드의 동작 줄은 줄여 둠) |
| `journal-corosync.txt` | `journalctl -u corosync -u pacemaker -o short-iso` — 노드를 번호(`host: 3`)로 적는다 |
| `nova-migration-list.json` | `openstack server migration list --type evacuation` 표(2026-10-22 con01 화면)를 JSON 열 이름으로 옮긴 것. 시각은 UTC |

새 형식을 만나면(버전 차이 등) 그 출력을 여기 더하고 검사를 추가한다.
