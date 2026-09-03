import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import type {
  SSHConfig,
  ConnectResult,
  SSHStatusEvent,
  AIRequest,
  AIStreamEvent,
  SavedProfile,
  AIProvider,
  MonitorStartOptions,
  MonitorSampleEvent,
  MonitorErrorEvent,
  ProfileImportResult,
  CustomPresetCommand,
  CustomScenario,
  CustomItemsImportResult,
  ConfigMapRef,
  ConfigMapDetail,
  ConfigMapPatchResult,
  ConfigMapBackup,
  CmBackupOrigin,
  LogIndexEntry,
  LogEntryDetail,
  PerfDoneEvent,
  PerfEnvStatus,
  PerfLogEvent,
  PerfRunConfig,
  PerfRunMeta,
  PerfRunRecord,
  LogRetentionSettings,
  MetricSample,
  LogTailTarget,
  ExpectRule,
  PortalConfig,
  PortalHttpResult,
} from './shared-types'

/** 활성 포트 포워딩 항목 (렌더러 표시용) */
export interface ForwardView {
  id: string
  type: 'local' | 'remote'
  localHost: string
  localPort: number
  remoteHost: string
  remotePort: number
}

// ─────────────────────────────────────────────────────────────
// 프리로드 스크립트
//  - 렌더러(React)에서 직접 Node/ipcRenderer 에 접근하지 못하도록 하고,
//    필요한 기능만 window.electronAPI 로 안전하게 노출한다. (contextBridge)
// ─────────────────────────────────────────────────────────────

const electronAPI = {
  // SSH 연결 (Promise 로 결과 반환). sessionId 로 탭 구분.
  sshConnect: (sessionId: string, config: SSHConfig): Promise<ConnectResult> =>
    ipcRenderer.invoke('ssh:connect', sessionId, config),

  // SSH 연결 종료
  sshDisconnect: (sessionId: string): void => ipcRenderer.send('ssh:disconnect', sessionId),

  // 자동 재연결 토글을 백엔드에 반영 (꺼지면 백엔드 재접속도 중단)
  sshSetAutoReconnect: (enabled: boolean): void => ipcRenderer.send('ssh:setAutoReconnect', enabled),

  // 변경된 호스트 키 신뢰(덮어쓰기) 후 재접속용
  sshTrustHost: (host: string, port: number): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('ssh:trustHost', { host, port }),

  // 개인키 파일 선택 → 내용 반환
  sshPickKeyFile: (): Promise<{ ok: boolean; content?: string; name?: string; canceled?: boolean; error?: string }> =>
    ipcRenderer.invoke('ssh:pickKeyFile'),

  // 다중 호스트 실행 (별도 exec 채널 결과 캡처)
  sessionRun: (
    sessionId: string,
    cmd: string,
  ): Promise<{ ok: boolean; code?: number; out?: string; err?: string; error?: string }> =>
    ipcRenderer.invoke('session:run', { sessionId, cmd }),

  // 세션 로그 기록 시작/중지 (host/label 은 로그 목록 표시용 메타데이터)
  logStart: (
    sessionId: string,
    meta?: { host?: string; label?: string },
  ): Promise<{ ok: boolean; path?: string; alreadyLogging?: boolean; canceled?: boolean; error?: string }> =>
    ipcRenderer.invoke('log:start', { sessionId, host: meta?.host, label: meta?.label }),
  logStop: (sessionId: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('log:stop', { sessionId }),

  // ── 세션 로그 뷰어(목록/검색/리플레이) ───────────────────────
  logsList: (): Promise<LogIndexEntry[]> => ipcRenderer.invoke('logs:list'),
  logsDetails: (): Promise<LogEntryDetail[]> => ipcRenderer.invoke('logs:details'),
  logsRead: (id: string): Promise<{ ok: boolean; content?: string; truncated?: boolean; error?: string }> =>
    ipcRenderer.invoke('logs:read', id),
  logsReadCast: (
    id: string,
  ): Promise<{ ok: boolean; frames?: { t: number; d: string }[]; error?: string }> =>
    ipcRenderer.invoke('logs:readCast', id),
  logsDelete: (id: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('logs:delete', id),
  logsExport: (id: string): Promise<{ saved: boolean; path?: string; error?: string }> =>
    ipcRenderer.invoke('logs:export', id),
  logsGetRetentionSettings: (): Promise<LogRetentionSettings> => ipcRenderer.invoke('logs:getRetentionSettings'),

  // ── 성능 테스트 (Locust, 로컬 부하) ─────────────────────────
  perfEnv: (): Promise<PerfEnvStatus> => ipcRenderer.invoke('perf:env'),
  perfGetLocustPath: (): Promise<string> => ipcRenderer.invoke('perf:getLocustPath'),
  perfSetLocustPath: (p: string | null): Promise<{ ok: boolean }> => ipcRenderer.invoke('perf:setLocustPath', p),
  perfStart: (cfg: PerfRunConfig): Promise<{ ok: boolean; meta?: PerfRunMeta; error?: string }> =>
    ipcRenderer.invoke('perf:start', cfg),
  perfCancel: (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('perf:cancel'),
  perfList: (): Promise<PerfRunRecord[]> => ipcRenderer.invoke('perf:list'),
  perfDelete: (id: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('perf:delete', id),
  perfOpenReport: (id: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('perf:openReport', id),
  perfOpenFolder: (id: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('perf:openFolder', id),
  perfPickScenario: (): Promise<{ path: string }> => ipcRenderer.invoke('perf:pickScenario'),
  perfPreviewScenario: (cfg: PerfRunConfig): Promise<{ text: string }> =>
    ipcRenderer.invoke('perf:previewScenario', cfg),
  perfSaveReport: (id: string): Promise<{ saved: boolean; path?: string; error?: string }> =>
    ipcRenderer.invoke('perf:saveReport', id),
  perfSaveCsv: (id: string): Promise<{ saved: boolean; path?: string; error?: string }> =>
    ipcRenderer.invoke('perf:saveCsv', id),
  perfReadHistory: (id: string): Promise<{ ok: boolean; csv?: string; error?: string }> =>
    ipcRenderer.invoke('perf:readHistory', id),
  onPerfLog: (cb: (e: PerfLogEvent) => void): (() => void) => {
    const h = (_e: unknown, d: PerfLogEvent) => cb(d)
    ipcRenderer.on('perf:log', h)
    return () => ipcRenderer.removeListener('perf:log', h)
  },
  onPerfDone: (cb: (e: PerfDoneEvent) => void): (() => void) => {
    const h = (_e: unknown, d: PerfDoneEvent) => cb(d)
    ipcRenderer.on('perf:done', h)
    return () => ipcRenderer.removeListener('perf:done', h)
  },
  logsSetRetentionSettings: (settings: LogRetentionSettings): Promise<LogRetentionSettings> =>
    ipcRenderer.invoke('logs:setRetentionSettings', settings),

  // 세션(탭) 완전 종료 — 연결/로컬셸 정리 후 세션 제거
  sessionClose: (sessionId: string): void => ipcRenderer.send('session:close', sessionId),

  // 터미널 입력(키) → 서버
  sendInput: (sessionId: string, data: string): void =>
    ipcRenderer.send('terminal:input', sessionId, data),

  // 터미널 크기 변경 → 서버 PTY 동기화
  resize: (sessionId: string, cols: number, rows: number): void =>
    ipcRenderer.send('terminal:resize', sessionId, { cols, rows }),

  // 터미널 준비 완료 알림 (미연결 시 메인이 로컬 셸 시작)
  terminalReady: (sessionId: string): void => ipcRenderer.send('terminal:ready', sessionId),

  // 서버 출력 데이터 수신 (xterm 에 write). 해제 함수를 반환.
  onTerminalData: (callback: (sessionId: string, data: string) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, payload: { sessionId: string; data: string }) =>
      callback(payload.sessionId, payload.data)
    ipcRenderer.on('terminal:data', listener)
    return () => ipcRenderer.removeListener('terminal:data', listener)
  },

  // 연결 상태 변화 수신. 해제 함수를 반환.
  onStatus: (callback: (event: SSHStatusEvent) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, event: SSHStatusEvent) => callback(event)
    ipcRenderer.on('ssh:status', listener)
    return () => ipcRenderer.removeListener('ssh:status', listener)
  },

  // ── AI 분석 ──────────────────────────────────────────────────
  // 대화 히스토리를 메인 프로세스로 보내 Claude 스트리밍 분석 시작
  aiSend: (req: AIRequest): void => ipcRenderer.send('ai:start', req),

  // 키로 사용 가능한 모델 목록 조회
  aiListModels: (
    provider: AIProvider,
    apiKey?: string,
  ): Promise<{ ok: boolean; models?: string[]; error?: string }> =>
    ipcRenderer.invoke('ai:listModels', { provider, apiKey }),

  // 응답 토큰(델타) 수신. 해제 함수를 반환.
  onAiDelta: (callback: (event: AIStreamEvent) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, event: AIStreamEvent) => callback(event)
    ipcRenderer.on('ai:delta', listener)
    return () => ipcRenderer.removeListener('ai:delta', listener)
  },

  // 응답 완료 수신.
  onAiDone: (callback: (event: AIStreamEvent) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, event: AIStreamEvent) => callback(event)
    ipcRenderer.on('ai:done', listener)
    return () => ipcRenderer.removeListener('ai:done', listener)
  },

  // 오류 수신.
  onAiError: (callback: (event: AIStreamEvent) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, event: AIStreamEvent) => callback(event)
    ipcRenderer.on('ai:error', listener)
    return () => ipcRenderer.removeListener('ai:error', listener)
  },

  // ── 리포트 / 외부 링크 ──────────────────────────────────────
  // 분석 리포트를 파일로 저장 (저장 다이얼로그). 결과 반환.
  saveReport: (payload: {
    defaultName: string
    content: string
  }): Promise<{ saved: boolean; path?: string; error?: string }> =>
    ipcRenderer.invoke('report:save', payload),
  saveReportPdf: (payload: {
    html: string
    defaultName: string
  }): Promise<{ saved: boolean; path?: string; error?: string }> =>
    ipcRenderer.invoke('report:savePdf', payload),

  /** OS 알림 — 검증 중 장애 감지·복구 완료를 창 밖에서 알려준다 */
  notify: (title: string, body: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('app:notify', { title, body }),

  // 링크를 기본 브라우저로 열기
  openExternal: (url: string): void => ipcRenderer.send('shell:openExternal', url),

  // ── SFTP 파일 (설정파일 뷰어) ────────────────────────────────
  sftpRead: (
    sessionId: string,
    path: string,
    sudoPassword?: string,
  ): Promise<{
    ok: boolean
    content?: string
    error?: string
    viaSudo?: boolean
    needSudoPassword?: boolean
  }> => ipcRenderer.invoke('sftp:read', sessionId, path, sudoPassword),
  sftpWrite: (
    sessionId: string,
    path: string,
    content: string,
    sudoPassword?: string,
  ): Promise<{
    ok: boolean
    error?: string
    viaSudo?: boolean
    backupPath?: string
    needSudoPassword?: boolean
  }> => ipcRenderer.invoke('sftp:write', { sessionId, path, content, sudoPassword }),

  // ── SSH 접속 기록(프로필) 관리 — 암호화 저장 ─────────────────
  profilesList: (): Promise<SavedProfile[]> => ipcRenderer.invoke('profiles:list'),
  profilesUpsert: (profile: SavedProfile, opts?: { preserveMeta?: boolean }): Promise<SavedProfile[]> =>
    ipcRenderer.invoke('profiles:upsert', profile, opts),
  profilesDelete: (key: string): Promise<SavedProfile[]> =>
    ipcRenderer.invoke('profiles:delete', key),
  /** 여러 세션 한 번에 삭제 (폴더 전체 삭제 등) — 한 번의 쓰기로 처리 */
  profilesDeleteMany: (keys: string[]): Promise<SavedProfile[]> =>
    ipcRenderer.invoke('profiles:deleteMany', keys),
  profilesClear: (): Promise<SavedProfile[]> => ipcRenderer.invoke('profiles:clear'),
  profilesRenameGroup: (from: string, to: string): Promise<SavedProfile[]> =>
    ipcRenderer.invoke('profiles:renameGroup', { from, to }),
  profilesReorder: (list: SavedProfile[]): Promise<SavedProfile[]> =>
    ipcRenderer.invoke('profiles:reorder', list),
  profilesImport: (): Promise<ProfileImportResult> => ipcRenderer.invoke('profiles:import'),
  profilesSaveTemplate: (
    format: 'csv' | 'json',
  ): Promise<{ saved: boolean; path?: string; error?: string }> =>
    ipcRenderer.invoke('profiles:saveTemplate', format),
  profilesExport: (
    format: 'csv' | 'json',
  ): Promise<{ saved: boolean; path?: string; count?: number; error?: string }> =>
    ipcRenderer.invoke('profiles:export', format),

  // ── 사용자 정의 프리셋 / 시나리오 (런타임 추가·편집) ─────────
  customPresetsList: (): Promise<CustomPresetCommand[]> => ipcRenderer.invoke('customPresets:list'),
  customPresetsUpsert: (item: CustomPresetCommand): Promise<CustomPresetCommand[]> =>
    ipcRenderer.invoke('customPresets:upsert', item),
  customPresetsDelete: (id: string): Promise<CustomPresetCommand[]> =>
    ipcRenderer.invoke('customPresets:delete', id),
  customScenariosList: (): Promise<CustomScenario[]> => ipcRenderer.invoke('customScenarios:list'),
  customScenariosUpsert: (item: CustomScenario): Promise<CustomScenario[]> =>
    ipcRenderer.invoke('customScenarios:upsert', item),
  customScenariosDelete: (id: string): Promise<CustomScenario[]> =>
    ipcRenderer.invoke('customScenarios:delete', id),
  /** 프리셋·시나리오를 한 파일(JSON)로 내보내기 — 팀원에게 넘기거나 백업용 */
  customItemsExport: (): Promise<{
    saved: boolean
    path?: string
    presets?: number
    scenarios?: number
    error?: string
  }> => ipcRenderer.invoke('customItems:export'),
  /** 내보낸 파일 가져오기 — 교체가 아니라 병합이다(같은 id 는 덮어쓰고 없으면 추가) */
  customItemsImport: (): Promise<CustomItemsImportResult> => ipcRenderer.invoke('customItems:import'),

  // ── 앱 데이터 폴더 ────────────────────────────────────────
  /** 설정·프리셋·프로필이 저장되는 폴더 경로 (설치 폴더 밖이라 재설치해도 남는다) */
  userDataPath: (): Promise<string> => ipcRenderer.invoke('app:userDataPath'),
  /** 그 폴더를 탐색기로 열기 */
  openUserData: (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('app:openUserData'),

  // ── 클립보드 ─────────────────────────────────────────────
  /** 시스템 클립보드 텍스트 읽기 (터미널 Ctrl+V 붙여넣기용) */
  clipboardReadText: (): Promise<string> => ipcRenderer.invoke('clipboard:read'),

  // ── 파일 탐색기 (SFTP) ───────────────────────────────────
  sftpList: (
    sessionId: string,
    path?: string,
  ): Promise<{
    ok: boolean
    path?: string
    entries?: { name: string; type: 'dir' | 'file' | 'link'; size: number; mtime: number }[]
    error?: string
  }> => ipcRenderer.invoke('sftp:list', { sessionId, path }),
  /** 원격 디렉토리 트리 전체에서 파일명 재귀 검색(대소문자 무시 부분일치) */
  sftpSearch: (
    sessionId: string,
    root: string,
    query: string,
  ): Promise<{
    ok: boolean
    results?: { path: string; name: string; type: 'dir' | 'file' | 'link' }[]
    truncated?: boolean
    error?: string
  }> => ipcRenderer.invoke('sftp:search', { sessionId, root, query }),
  sftpDownload: (
    sessionId: string,
    remotePath: string,
    name: string,
  ): Promise<{ ok: boolean; localPath?: string; canceled?: boolean; error?: string }> =>
    ipcRenderer.invoke('sftp:download', { sessionId, remotePath, name }),
  sftpUpload: (
    sessionId: string,
    remoteDir: string,
    localPaths?: string[],
  ): Promise<{ ok: boolean; uploaded?: string[]; canceled?: boolean; error?: string }> =>
    ipcRenderer.invoke('sftp:upload', { sessionId, remoteDir, localPaths }),
  /** 드롭된 File 의 로컬 절대경로 (Electron) — OS→앱 업로드용 */
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),
  /** 원격 파일을 OS로 드래그-아웃 시작 (dragstart 에서 호출) */
  startFileDrag: (sessionId: string, remotePath: string, name: string): void =>
    ipcRenderer.send('sftp:startDrag', { sessionId, remotePath, name }),
  /** 로컬 디렉토리 목록 (파일 탐색기 듀얼패인 좌측) */
  localList: (
    path?: string,
  ): Promise<{
    ok: boolean
    path?: string
    parent?: string
    entries?: { name: string; path: string; type: 'dir' | 'file' | 'link'; size: number; mtime: number }[]
    error?: string
  }> => ipcRenderer.invoke('local:list', { path }),
  /** 다중 선택 일괄 다운로드 — 대화상자 없이 지정된 로컬 폴더로 바로 받음(듀얼패인용) */
  sftpDownloadPaths: (
    sessionId: string,
    items: { path: string; name: string; isDir: boolean }[],
    localDir: string,
  ): Promise<{ ok: boolean; downloaded?: string[]; error?: string }> =>
    ipcRenderer.invoke('sftp:downloadPaths', { sessionId, items, localDir }),
  /** 다중 선택 일괄 삭제(원격) */
  sftpDeletePaths: (
    sessionId: string,
    items: { path: string; isDir: boolean }[],
  ): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('sftp:deletePaths', { sessionId, items }),
  /** 세션 간(원격→원격) 직접 전송 — 앱이 임시 로컬 폴더를 경유해 중계 */
  sftpRelayTransfer: (
    fromSessionId: string,
    toSessionId: string,
    items: { path: string; name: string; isDir: boolean }[],
    toDir: string,
  ): Promise<{ ok: boolean; transferred?: string[]; error?: string }> =>
    ipcRenderer.invoke('sftp:relayTransfer', { fromSessionId, toSessionId, items, toDir }),

  // ── 포트 포워딩 (터널링) ─────────────────────────────────
  tunnelList: (
    sessionId: string,
  ): Promise<{ ok: boolean; forwards?: ForwardView[] }> => ipcRenderer.invoke('tunnel:list', { sessionId }),
  tunnelAdd: (params: {
    sessionId: string
    type: 'local' | 'remote'
    localHost: string
    localPort: number
    remoteHost: string
    remotePort: number
  }): Promise<{ ok: boolean; id?: string; error?: string }> => ipcRenderer.invoke('tunnel:add', params),
  tunnelRemove: (sessionId: string, id: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('tunnel:remove', { sessionId, id }),
  sftpMkdir: (sessionId: string, path: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('sftp:mkdir', { sessionId, path }),
  sftpRename: (sessionId: string, from: string, to: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('sftp:rename', { sessionId, from, to }),
  sftpDelete: (
    sessionId: string,
    path: string,
    isDir: boolean,
  ): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('sftp:delete', { sessionId, path, isDir }),
  sftpDownloadDir: (
    sessionId: string,
    remotePath: string,
    name: string,
  ): Promise<{ ok: boolean; localPath?: string; canceled?: boolean; error?: string }> =>
    ipcRenderer.invoke('sftp:downloadDir', { sessionId, remotePath, name }),
  sftpChmod: (
    sessionId: string,
    path: string,
    mode: number,
  ): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('sftp:chmod', { sessionId, path, mode }),
  /** SFTP 전송 진행률 이벤트 구독 */
  onSftpProgress: (
    cb: (d: { sessionId: string; name: string; pct: number }) => void,
  ): (() => void) => {
    const h = (_e: IpcRendererEvent, d: { sessionId: string; name: string; pct: number }) => cb(d)
    ipcRenderer.on('sftp:progress', h)
    return () => ipcRenderer.removeListener('sftp:progress', h)
  },

  // ── 실시간 로그 뷰어 (tail -f / kubectl logs -f) ───────────────
  // 세션당 여러 tailId 를 동시에 유지할 수 있어(듀얼 패널), stop 은 tailId 로 특정 스트림만 끊는다.
  logtailStart: (
    sessionId: string,
    target: LogTailTarget,
    sudoPassword?: string,
    tailLines?: number,
  ): Promise<{ ok: boolean; tailId?: string; needSudoPassword?: boolean; error?: string }> =>
    ipcRenderer.invoke('logtail:start', { sessionId, target, sudoPassword, tailLines }),
  logtailStop: (sessionId: string, tailId: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('logtail:stop', { sessionId, tailId }),
  onLogtailData: (cb: (d: { sessionId: string; tailId: string; data: string }) => void): (() => void) => {
    const h = (_e: IpcRendererEvent, d: { sessionId: string; tailId: string; data: string }) => cb(d)
    ipcRenderer.on('logtail:data', h)
    return () => ipcRenderer.removeListener('logtail:data', h)
  },
  onLogtailClosed: (cb: (d: { sessionId: string; tailId: string }) => void): (() => void) => {
    const h = (_e: IpcRendererEvent, d: { sessionId: string; tailId: string }) => cb(d)
    ipcRenderer.on('logtail:closed', h)
    return () => ipcRenderer.removeListener('logtail:closed', h)
  },

  // ── 시나리오 검증용 영속 셸 (cd/환경변수 유지 · 대화형 응답 · 타임아웃 시 Ctrl+C) ──
  runnerOpen: (sessionId: string, runnerId: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('runner:open', { sessionId, runnerId }),
  runnerExec: (
    runnerId: string,
    cmd: string,
    expect?: ExpectRule[],
    timeoutMs?: number,
    // ok:false 는 '셸이 닫혔다/이미 실행 중' 처럼 명령을 아예 못 돌린 경우 — 종료코드가 없다
  ): Promise<{ ok: boolean; error?: string; code?: number; out?: string; timedOut?: boolean; replied?: string[] }> =>
    ipcRenderer.invoke('runner:exec', { runnerId, cmd, expect, timeoutMs }),
  runnerInterrupt: (runnerId: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('runner:interrupt', { runnerId }),
  runnerClose: (runnerId: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('runner:close', { runnerId }),

  // ── 서비스 포털 응답 감시 ──
  // 요청 자체는 메인에서 한다(CORS·자체서명 인증서·응답 헤더 때문에 렌더러 fetch 로는 불가).
  portalRequest: (p: {
    url: string
    method?: string
    headers?: Record<string, string>
    body?: string
    timeoutMs?: number
    insecure?: boolean
  }): Promise<PortalHttpResult> => ipcRenderer.invoke('portal:request', p),
  portalGetConfig: (): Promise<PortalConfig | null> => ipcRenderer.invoke('portal:getConfig'),
  portalSetConfig: (cfg: PortalConfig): Promise<{ ok: boolean }> => ipcRenderer.invoke('portal:setConfig', cfg),

  // ── TCP 포트 열림 확인 (IPMI 재기동 후 SSH 부활 감시용) ──
  netProbeTcp: (host: string, port: number, timeoutMs?: number): Promise<{ ok: boolean; open: boolean; error?: string }> =>
    ipcRenderer.invoke('net:probeTcp', { host, port, timeoutMs }),

  // ── Kubernetes 파드 로그 탐색 (네임스페이스/파드/컨테이너 목록) ──
  k8sListNamespaces: (sessionId: string): Promise<{ ok: boolean; namespaces?: string[]; error?: string }> =>
    ipcRenderer.invoke('k8s:listNamespaces', { sessionId }),
  k8sListPods: (
    sessionId: string,
    namespace: string,
  ): Promise<{ ok: boolean; pods?: string[]; error?: string }> =>
    ipcRenderer.invoke('k8s:listPods', { sessionId, namespace }),
  // ── ConfigMap 보기 / 수정 (설정 뷰어의 ConfigMap 모드) ──────
  k8sListConfigMaps: (
    sessionId: string,
    namespace: string,
  ): Promise<{ ok: boolean; items?: ConfigMapRef[]; error?: string }> =>
    ipcRenderer.invoke('k8s:listConfigMaps', { sessionId, namespace }),
  k8sGetConfigMap: (
    sessionId: string,
    namespace: string,
    name: string,
  ): Promise<{ ok: boolean; detail?: ConfigMapDetail; error?: string }> =>
    ipcRenderer.invoke('k8s:getConfigMap', { sessionId, namespace, name }),
  /** 읽기 전용 YAML 전문 */
  k8sGetConfigMapYaml: (
    sessionId: string,
    namespace: string,
    name: string,
  ): Promise<{ ok: boolean; yaml?: string; error?: string }> =>
    ipcRenderer.invoke('k8s:getConfigMapYaml', { sessionId, namespace, name }),
  /** 바꾼 키만 한 번에 적용 — 백업 후 patch, resourceVersion 이 바뀌었으면 적용하지 않는다 */
  k8sPatchConfigMap: (payload: {
    sessionId: string
    namespace: string
    name: string
    changes: Record<string, string>
    baseResourceVersion: string
    /** 세션 별칭 — 백업 이력에 "어느 세션에서 고쳤는지" 로 남는다 */
    alias?: string
  }): Promise<ConfigMapPatchResult> => ipcRenderer.invoke('k8s:patchConfigMap', payload),
  /** 지금 세션이 가리키는 환경(host·kubectl context) — 이력에서 다른 환경을 가려내는 데 쓴다 */
  k8sCmEnv: (sessionId: string, alias?: string): Promise<{ ok: boolean; origin?: CmBackupOrigin }> =>
    ipcRenderer.invoke('k8s:cmEnv', { sessionId, alias }),
  /** 백업 이력 (내 PC userData 에 암호화 저장된 것) */
  k8sCmBackupList: (
    namespace: string,
    name: string,
  ): Promise<{ ok: boolean; items?: ConfigMapBackup[]; error?: string }> =>
    ipcRenderer.invoke('k8s:cmBackupList', { namespace, name }),
  /** 모든 ConfigMap 의 백업을 시각 역순으로 (최근에 무엇을 바꿨는지 보기) */
  k8sCmBackupListAll: (): Promise<{ ok: boolean; items?: ConfigMapBackup[]; configMaps?: number; error?: string }> =>
    ipcRenderer.invoke('k8s:cmBackupListAll'),
  /** 백업을 평문 YAML 로 내보내기 (복원용) */
  /** dir 은 목록이 돌려준 저장 폴더명 — 환경마다 폴더가 달라 (namespace, name) 만으로는 못 찾는다 */
  k8sCmBackupExport: (
    dir: string,
    file: string,
    name: string,
  ): Promise<{ saved: boolean; path?: string; error?: string }> =>
    ipcRenderer.invoke('k8s:cmBackupExport', { dir, file, name }),

  k8sListContainers: (
    sessionId: string,
    namespace: string,
    pod: string,
  ): Promise<{ ok: boolean; containers?: string[]; error?: string }> =>
    ipcRenderer.invoke('k8s:listContainers', { sessionId, namespace, pod }),

  // ── 서버 모니터링(상시 데몬, 세션별) ─────────────────────────
  // 수집 시작: 에이전트 배포(필요시) + 데몬 기동 + 증분 리더 시작
  monitorStart: (
    sessionId: string,
    opts?: MonitorStartOptions,
  ): Promise<{ ok: boolean; resumed?: boolean; error?: string }> =>
    ipcRenderer.invoke('monitor:start', { sessionId, opts }),
  // 수집 완전 종료 (서버 데몬까지 kill)
  monitorStop: (sessionId: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('monitor:stop', { sessionId }),
  // 데몬 생존 여부 조회 (재접속 직후 resume 판단용)
  monitorStatus: (sessionId: string): Promise<{ running: boolean }> =>
    ipcRenderer.invoke('monitor:status', { sessionId }),
  // 앱 종료 시 데몬 kill 여부 설정 (토글 변경/로드 시 메인과 동기화)
  monitorSetKillOnExit: (value: boolean): void =>
    ipcRenderer.send('monitor:setKillOnExit', value),
  // 원격 프로세스 kill (SIGTERM → SIGKILL)
  monitorKillProc: (sessionId: string, pid: number): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('monitor:killProc', { sessionId, pid }),
  /** 전체 프로세스 목록(온디맨드, ps 전체 재조회) — 상시 폴링과 별개 */
  monitorListProcesses: (
    sessionId: string,
  ): Promise<{
    ok: boolean
    procs?: { pid: number; name: string; cpu: number; mem: number; command: string }[]
    error?: string
  }> => ipcRenderer.invoke('monitor:listProcesses', { sessionId }),
  // 로컬에 장기 보관된 이력 조회 (호스트명 기준, 6h/24h/7d 등 실시간 버퍼보다 긴 범위용)
  monitorHistory: (host: string, sinceMs: number): Promise<{ ok: boolean; samples?: MetricSample[] }> =>
    ipcRenderer.invoke('monitor:history', { host, sinceMs }),

  // 새 메트릭 샘플 수신 (sessionId 포함). 해제 함수 반환.
  onMonitorSample: (callback: (e: MonitorSampleEvent) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, e: MonitorSampleEvent) => callback(e)
    ipcRenderer.on('monitor:sample', listener)
    return () => ipcRenderer.removeListener('monitor:sample', listener)
  },
  // 수집 오류 수신. 해제 함수 반환.
  onMonitorError: (callback: (e: MonitorErrorEvent) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, e: MonitorErrorEvent) => callback(e)
    ipcRenderer.on('monitor:error', listener)
    return () => ipcRenderer.removeListener('monitor:error', listener)
  },
}

contextBridge.exposeInMainWorld('electronAPI', electronAPI)

// 렌더러 TS 에서 window.electronAPI 타입 추론에 사용
export type ElectronAPI = typeof electronAPI
