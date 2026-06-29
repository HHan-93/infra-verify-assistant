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

  // 세션 로그 기록 시작/중지
  logStart: (
    sessionId: string,
  ): Promise<{ ok: boolean; path?: string; alreadyLogging?: boolean; canceled?: boolean; error?: string }> =>
    ipcRenderer.invoke('log:start', { sessionId }),
  logStop: (sessionId: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('log:stop', { sessionId }),

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
  profilesUpsert: (profile: SavedProfile): Promise<SavedProfile[]> =>
    ipcRenderer.invoke('profiles:upsert', profile),
  profilesDelete: (key: string): Promise<SavedProfile[]> =>
    ipcRenderer.invoke('profiles:delete', key),
  profilesClear: (): Promise<SavedProfile[]> => ipcRenderer.invoke('profiles:clear'),
  profilesRenameGroup: (from: string, to: string): Promise<SavedProfile[]> =>
    ipcRenderer.invoke('profiles:renameGroup', { from, to }),
  profilesReorder: (list: SavedProfile[]): Promise<SavedProfile[]> =>
    ipcRenderer.invoke('profiles:reorder', list),

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
