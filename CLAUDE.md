# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 이 앱이 하는 일

**Q-Term** (`productName`, appId `com.okestro.infraverify`) — OpenStack / Ceph / Kubernetes / CONTRABASS / SDS+ 인프라를 **검증·트러블슈팅하는 엔지니어용 SSH 데스크톱 도구**. Electron + React + xterm.js.

단순 SSH 클라이언트가 아니다. 실제 용도는 **가용성 검증**(노드를 강제로 죽이고 "언제 무엇이 복구되는가"를 자동으로 재는 것)이며, 상태보드·포털 감시·시나리오 러너가 그 목적에 맞춰 만들어져 있다. 그래서 이 코드베이스에서 가장 중요한 것은 UI 가 아니라 **판정의 정확성**이다 — 복구 시각을 실제보다 이르게 찍거나, 조회 실패를 장애로 착각하는 것이 이 앱의 치명적 버그다.

## 명령어

```bash
npm run dev        # vite + Electron 메인/프리로드 번들 + Electron 자동 실행 (한 번으로 전부)
npm run lint       # tsc --noEmit — 이 저장소의 유일한 자동 검증 수단
npm run build      # tsc --noEmit && vite build
npm run dist       # Windows 설치본(nsis) + portable → release/
npm run dist:dir   # 패키징 없이 폴더로만 (빠른 확인용)
```

- **테스트 프레임워크가 없다.** vitest/jest 설정도, 테스트 파일도 없다. 변경 검증은 `npm run lint` + 실제 앱 실행이 전부이므로, 판정 로직을 고쳤으면 **앱에서 그 시나리오를 직접 돌려 확인**해야 한다. (`src/lib/portal.ts` 는 "테스트로 확인할 수 있어야 한다"는 의도로 UI·IPC 와 분리돼 있으나 아직 하네스가 없다.)
- **macOS 빌드는 로컬에서 하지 않는다** — [.github/workflows/build-mac.yml](.github/workflows/build-mac.yml) 의 `macos-latest` 러너에서 universal `.dmg`/`.zip` 을 미서명(`CSC_IDENTITY_AUTO_DISCOVERY: false`)으로 만든다. 트리거는 Actions 수동 실행 · `main` 푸시 · `v*` 태그(태그면 Release 에 자동 첨부). **`main` 에 푸시하면 Mac 빌드가 돈다는 점을 유의**할 것.
- `npm run dev` 를 콘솔 없는 백그라운드 프로세스로 띄우면 node-pty 가 `AttachConsole failed` 로 죽는다(Windows ConPTY). 로컬 터미널 탭(PTY)까지 확인해야 하면 **실제 터미널에서** 실행할 것.

## 구조

### 프로세스 경계

| | 역할 |
|---|---|
| [electron/main.ts](electron/main.ts) (~3.8k줄) | ssh2 SSH·SFTP, node-pty 로컬 셸, 파일 영속화, AI API 호출, 포트포워딩, 메트릭 수집. IPC 핸들러 약 80개 |
| [electron/shared-types.ts](electron/shared-types.ts) | **메인↔렌더러 계약.** 새 기능은 대개 여기 타입부터 추가한다. 타입 위의 주석이 설계 근거를 담고 있어 읽을 값이 있다 |
| [electron/preload.ts](electron/preload.ts) | contextBridge — 렌더러는 여기 노출된 API 로만 메인에 접근 |
| [src/App.tsx](src/App.tsx) (~2.7k줄) | 세션(탭)·레이아웃·전역 상태의 단일 소유자. 모든 패널이 그 자식 |

IPC 이름은 `도메인:동작` 규칙이다 — `ssh:*` `terminal:*` `sftp:*`/`local:*` `tunnel:*` `monitor:*` `logtail:*`/`k8s:*`(파드 로그 탐색 + ConfigMap 조회·patch + 파드 상세 조회·재시작) `log:*`/`logs:*` `profiles:*` `customPresets:*`/`customScenarios:*` `runner:*` `portal:*` `customItems:*`(내보내기·가져오기) `app:*`(userData 경로·폴더 열기) `ai:start`. 스트리밍은 요청(`handle`) + 이벤트(`ai:delta`/`ai:done`/`ai:error`, `monitor:sample`, `terminal:data`) 조합.

### 명령 실행 경로가 셋이다 — 섞지 말 것

1. **터미널 탭** — 사용자가 직접 타이핑. SSH 연결이면 원격 셸, 아니면 node-pty 로컬 셸.
2. **`session:run`** — 일회성 exec. 상태보드·대시보드 같은 폴링이 쓴다. 셸 상태가 남지 않는다.
3. **러너 셸(`runner:*`)** — 시나리오 검증용 **영속 PTY**. `cd`·환경변수가 스텝 사이에 유지되고, `expect`(대화형 프롬프트 자동응답)와 `capture`(출력→다음 스텝 플레이스홀더)가 여기서만 동작한다.

### 판정 로직은 UI 에서 분리돼 있다

`src/lib/` 는 "무엇을 정상으로 볼 것인가"를 담는 곳이다. 컴포넌트에 판정을 새로 심지 말고 여기에 둘 것.

- [verdict.ts](src/lib/verdict.ts) — 3-상태(pass/fail/**info**). 기준(`CommandCheck`)이 없으면 초록 PASS 를 띄우지 않는다. `df -h` 에 "통과"를 붙이지 않기 위한 의도적 설계다.
- [portal.ts](src/lib/portal.ts) — 포털 응답 정상 판정.
- [mask.ts](src/lib/mask.ts) — 비밀번호·토큰·키·IP 마스킹. **로그 표시 / 리포트 저장 / AI 외부 전송 세 경로에 공통 적용**된다. 값만 가리고 키 이름은 남긴다.
- [placeholder.ts](src/lib/placeholder.ts) — 명령어 안 `<입력값>` 규칙. 문자 집합을 좁게 잡은 이유가 주석에 있다(셸 리다이렉션 `>` 오인 방지).
- [shellSplit.ts](src/lib/shellSplit.ts) — 한 줄 명령을 최상위 `;` `&&` `||` 로 쪼개 단계로 보여주기 위한 분리기. 따옴표·`$( )` 안은 건드리지 않는다(`awk '{print $5; exit}'` 를 반토막 내지 않으려면 정규식 split 으로는 안 된다).
- [shellFormat.ts](src/lib/shellFormat.ts) — 긴 셸 한 줄을 **보여줄 때만** 줄로 나눠 들여쓴다(원복 확인창 등). 실행에는 원문을 그대로 쓴다. 최상위 `;` 로만 쪼개고(`&&` `||` 는 한 동작이라 붙여 둔다), 끝나면 공백·`;` 를 뺀 문자열이 원문과 같은지 확인해 다르면 원문을 돌려준다 — 모양을 못 잡을지언정 글자가 바뀌지는 않는다.
- [runPolicy.ts](src/lib/runPolicy.ts) — 검증 러너가 **무엇을 자동으로 돌려도 되는가 · 얼마나 기다리는가**. 대화형(htop·vi)은 전체 실행에서 빼되 `timeout <시간>` 으로 묶였거나 expect 가 프롬프트에 답하는 것은 돌린다. `manualOnly` 스텝(검증 뒤 정리처럼 조건을 사람이 봐야 하는 것)도 뺀다. 제한 시간은 네트워크 의존 5분·디스크 이미지 30분이 바닥 — 느린 것이 '제한 시간 초과' 라는 **실패로** 기록되면 안 된다.
- [orderedMerge.ts](src/lib/orderedMerge.ts) — 내장 항목(배열 인덱스) + 사용자 정의(소수 `order`) fractional indexing 병합.
- [paneTree.ts](src/lib/paneTree.ts) — tmux 식 재귀 분할 이진 트리(고정 2/4분할이 아니다).
- [logDisplay.tsx](src/lib/logDisplay.tsx) / [highlightRules.ts](src/lib/highlightRules.ts) — 심각도 4버킷 색상 + 사용자 하이라이트. 줄 전체가 아니라 키워드 단어만 물들인다.

### 영속화

메인 프로세스가 `app.getPath('userData')` 에 저장한다. **`.dat` = `safeStorage` 암호화**(같은 OS 사용자만 복호화 — 팀 배포 시 각자 로컬에서 안전), `.json` = 평문(비밀정보 아님).

`ssh-profiles.dat` · `known-hosts.dat`(TOFU) · `portal-watch.dat` / `custom-presets.json` · `custom-scenarios.json` · `session-logs-index.json` · `log-retention-settings.json` · `session-logs/`(리플레이용 `.cast.jsonl`) · `metrics-history/` · `configmap-backups/`(ConfigMap 적용 직전 YAML, `.dat` 암호화·cm 당 20개) · `scenario-runs/`(시나리오 검증 회차 — 목록 `index.json` + 회차별 `<id>.json`. 리포트 원문은 마스킹을 거친 뒤 저장된다) · `scenario-run-retention.json`(회차 보관 한도 — 기본 90일·200회차, 이력 창에서 변경. **손상 시 조용히 기본값으로 되돌리지 않는다** — 늘려 둔 한도가 기본값으로 읽히면 자동 정리가 남겨야 할 회차를 지운다)

**폴더 이름이 `Q-Term` 이 아니라 `infra-verify-assistant` 다** — 이게 정상이다. `build.productName` 은 exe·설치본 이름만 정하고, 런타임 앱 이름(=userData 폴더명)은 package.json 최상위 `name` 을 쓴다. Q-Term 은 나중에 붙인 표시명일 뿐이다. **최상위에 `productName` 을 추가하거나 `name` 을 바꾸면 userData 경로가 옮겨가면서 사용자의 프리셋·시나리오·접속 프로필이 전부 사라진 것처럼 보인다** — 리브랜딩 정리를 하다 건드리기 쉬운 곳이니 손대지 말 것. dev 와 설치본이 같은 폴더를 공유한다는 점도 같이 기억할 것(dev 에서 지우면 설치본에서도 지워진다).

**쓰기 규칙**: 임시 파일 → `rename` 교체 + **경로별 직렬화 락**. 여러 세션이 같은 저장소를 동시에 건드려 파일이 깨진 전례가 있어서 도입됐다. 새 저장소를 추가할 때도 이 유틸을 쓸 것.

렌더러 쪽 UI 설정은 `localStorage`(`term_theme` `ai_config` `session_restore` `highlight_rules` 등).

### 프리셋 / 시나리오 데이터

[src/presets.ts](src/presets.ts)(231개 단일 명령어) · [src/scenarios.ts](src/scenarios.ts)(다단계 시나리오)가 **내장 목록**이고, 사용자가 앱에서 추가한 것은 userData JSON 에 따로 저장돼 **런타임에 병합**된다(빌드 없이 추가 가능하게 하려는 설계).

**단일 명령어는 [명령어_프리셋.md](명령어_프리셋.md) 가 원본이다.** 거기서 고치고 `npm run presets:ts` 를 돌리면 presets.ts 에 반영되고, 반대 방향은 `npm run presets:md`, 어긋났는지 확인은 `npm run presets:check` 다([scripts/presets-md.mjs](scripts/presets-md.mjs)). 왕복이 무손실인 것을 확인하고 넣었다 — 한쪽만 고쳐 두 벌이 갈라지던 문제를 막으려는 것이다.

옛 `명령어_편집.md` 는 **손대지 않은 채 남겨 둔 참고 자료**다(프리셋 + 시나리오 두 문서가 한 파일에 붙어 있고 들여쓰기에 탭·공백이 섞여 있다). 2026-09-05 에 전수 대조한 결과 그 안의 명령은 presets.ts·scenarios.ts 에 모두 들어 있다 — 새로 얻을 것은 없으니 이 파일을 다시 원본으로 삼지 말 것. `cli.md` 도 같은 성격의 옛 산출물이다.

## 이 코드베이스의 규칙

**주석이 결정의 기록이다.** 이 저장소의 주석은 "무엇을 하는지"가 아니라 **왜 이렇게 했는지 / 무엇을 시도했다 버렸는지**를 적는다. 특히 `PortalAuth` 의 "없앤 방식 — 다시 만들지 말 것"(browser 쿠키 방식, refresh 토큰 방식과 각각의 실패 이유) 같은 블록은 **재도입 금지 표시**다. 코드를 고칠 때 이 형식을 유지하고, 어떤 판단을 뒤집을 때는 그 이유를 같은 밀도로 남길 것. 주석·UI 문구는 한국어다.

되풀이해서 나타나는 판단 기준:

- **조회 실패 ≠ 장애.** 폴링이 타임아웃했을 때 빈 결과로 덮으면 행·열이 사라져 "서비스가 없어졌다"로 읽힌다. 직전 값을 유지하고 "몇 초 전 값"이라는 사실만 화면에 밝힌다(stale 표시). 진행률·초록 표시도 그 프레임에서는 그리지 않는다.
- **한 번 튄 성공은 복구가 아니다.** 페일오버 중에는 200 이 한 번 튀었다 다시 503 이 된다. 연속 성공(`successStreak`)을 요구하고, 마일스톤도 연속 관측을 요구한다. `successStreak: 1` 은 쓰지 말 것.
- **시각은 절대 epoch ms 로 보관**하고 표시할 때만 변환한다. 원격 로그에서 시각을 뽑을 때는 호스트 시계 오차(`delta`)를 빼서 같은 기준으로 맞춘다 — 그러지 않으면 마일스톤이 '발견 시각'으로 찍힌다.
- **모달은 배경 클릭으로 닫지 않는다.** 닫는 것은 X · 닫기 · 취소 버튼뿐이다. 불러온 파일·입력 중인 값이 손이 스친 클릭에 사라지면 처음부터 다시 해야 한다(상태보드는 원래 이 규칙이었고, 2026-08 에 나머지 모달 23곳을 여기에 맞췄다). **예외는 작은 드롭다운 메뉴** — 닫기 버튼이 없으므로 바깥 클릭이 유일한 취소 수단이다.
- **화면이 저절로 움직이지 않게 한다.** 장애 감지 시 패널을 자동으로 펼치는 기능은 넣었다가 제거했다(롤링 검증 중 열고 접히기를 반복해 장애 정보보다 방해됐다). 알림은 눈에 띄게, 화면은 가만히 — 여는 것은 사람만.
- **오류 응답을 정상 기준으로 삼지 않는다.** 시험 때 받은 응답의 상태 문구를 그대로 정상 조건에 넣는 추천 버튼이 있는데, 그때 온 것이 오류면 `returnMessage 에 COMMON_BAD_REQUEST 포함` 이 '정상' 이 되어 **서버가 고쳐질수록 빨개진다**(실제로 200·37ms 인 대상이 계속 비정상이었다). `looksLikeErrorValue` 로 오류 문구는 권하지 않고, 이미 굳은 조건은 화면에서 짚어 사람이 뒤집게 한다.
- **비슷한 두 상태를 한 이름으로 묶지 않는다.** 예: Ceph 는 `ceph`(degraded·misplaced 0 = 데이터 복제 완료)와 `cephHealthy`(HEALTH_OK)를 분리한다. 복제와 무관한 경고(clock skew 등)가 남으면 전자만 만족해도 클러스터는 정상이 아니다.
- **정규식으로 CLI 출력을 파싱할 때는 서식 변화를 가정한다.** `pcs status` 의 `Started con02` / `Started: [ con02 ]` 처럼 형태가 바뀌며 `[` 를 노드명으로 잡아 가짜 이벤트를 찍은 전례가 있다. 뽑은 값이 **알려진 목록에 있는지 교차 검증**할 것.
- **파괴적 동작에는 대상 확인을 붙인다.** 세션 id 를 재사용하지 않는 이유(재시작 후 '이전 실행의 다른 서버'를 같은 세션으로 착각), 원복(`undo`)은 실제로 실행된 스텝만 역순으로 되돌리는 것 등이 같은 맥락이다.

## 빌드 시 주의

`ssh2` · `node-pty` · AI SDK 3종은 번들에 넣지 않고 런타임 `require` 한다(vite.config.ts `external`), 그리고 `node-pty`·`ssh2` 는 `asarUnpack` 대상이다 — 네이티브 모듈이라 asar 안에서 로드되지 않는다. 이 목록을 건드리면 패키징된 앱에서만 깨지므로 `npm run dist` 로 확인할 것.
