import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  SSHConfig,
  ConnectResult,
  SSHStatusEvent,
  AIRequest,
  AIStreamEvent,
  SavedProfile,
  AIProvider,
} from './shared-types'

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
}

contextBridge.exposeInMainWorld('electronAPI', electronAPI)

// 렌더러 TS 에서 window.electronAPI 타입 추론에 사용
export type ElectronAPI = typeof electronAPI
