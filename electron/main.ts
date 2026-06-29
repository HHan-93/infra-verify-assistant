import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  safeStorage,
  clipboard,
  nativeImage,
} from 'electron'
import path from 'node:path'
import os from 'node:os'
import net from 'node:net'
import { createWriteStream, type WriteStream } from 'node:fs'
import { writeFile, readFile, unlink, mkdir } from 'node:fs/promises'
import { Client, type ClientChannel, type SFTPWrapper } from 'ssh2'
import * as pty from 'node-pty'
import { streamChat, listModels } from './ai-providers'
import { AGENT_SCRIPT } from './agent-script'
import {
  PROVIDER_INFO,
  ANALYSIS_STYLES,
  type SSHConfig,
  type ConnectResult,
  type SSHStatusEvent,
  type AIRequest,
  type SavedProfile,
  type AIProvider,
  type MetricSample,
  type MonitorStartOptions,
} from './shared-types'

// ─────────────────────────────────────────────────────────────
// Electron 메인 프로세스
//  - BrowserWindow 생성 및 렌더러(React) 로드
//  - ssh2 를 이용한 SSH 통신 (IPC 로 렌더러와 양방향 통신)
// ─────────────────────────────────────────────────────────────

let mainWindow: BrowserWindow | null = null

// ── 다중 세션 관리 ─────────────────────────────────────────────
// 각 터미널 탭 = 하나의 Session. sessionId 로 구분해 독립적으로 관리한다.
interface Session {
  id: string
  client: Client | null
  shellStream: ClientChannel | null
  localPty: pty.IPty | null // SSH 미연결 시 로컬 셸(cmd/bash)
  /** 비밀번호 인증 시 root 파일 접근용 sudo -S 후보 (메모리 한정) */
  lastPassword?: string
  /** 설정파일 뷰어에서 입력한 sudo 비밀번호 캐시 (키 인증/비번 불일치 대비) */
  sudoPassword?: string
  /** 파일 탐색기용 SFTP 핸들 (세션당 1개 재사용 → 채널 누수 방지) */
  sftp?: SFTPWrapper
  /** 점프 호스트(Bastion) 경유 시의 게이트웨이 클라이언트 */
  jumpClient?: Client | null
  /** 활성 포트 포워딩(터널) 목록 */
  forwards: ForwardEntry[]
  /** 원격 포워딩 'tcp connection' 핸들러 부착 여부 */
  remoteHandlerAttached?: boolean
  connecting: boolean // 연결 진행 중에는 로컬 셸 자동 시작 억제
  /** 세션 로그 파일 스트림 (켜져 있으면 모든 출력 기록) */
  logStream?: WriteStream
  // ── 자동 재접속용 ──
  lastConfig?: SSHConfig // 마지막 접속 설정 (재접속에 재사용)
  wasConnected?: boolean // 쉘까지 한 번이라도 연결됐는지
  hadError?: boolean // 연결 중 오류(네트워크/keepalive) 발생 여부
  userClosed?: boolean // 사용자가 직접 끊었는지 (재접속 안 함)
  reconnecting?: boolean // 자동 재접속 루프 진행 중
}

/** 포트 포워딩 항목 */
interface ForwardEntry {
  id: string
  type: 'local' | 'remote'
  /** 로컬: 바인드 주소 / 원격: 로컬 목적지 주소 */
  localHost: string
  localPort: number
  /** 로컬: 원격 목적지 / 원격: 원격 바인드 주소 */
  remoteHost: string
  remotePort: number
  server?: net.Server // local 포워딩 시 로컬 리스너
}

const sessions = new Map<string, Session>()

/** 세션 조회 — 없으면 생성 */
function getSession(id: string): Session {
  let s = sessions.get(id)
  if (!s) {
    s = { id, client: null, shellStream: null, localPty: null, forwards: [], connecting: false }
    sessions.set(id, s)
  }
  return s
}

/** sudo -S 에 시도할 비밀번호 후보 (명시 입력 → 캐시 → 접속 비밀번호 순, 중복/빈값 제거) */
function sudoPwCandidates(s: Session, explicit?: string): string[] {
  return [...new Set([explicit, s.sudoPassword, s.lastPassword].filter((p): p is string => !!p))]
}

/** 터미널 출력 → 렌더러 전송 + (로깅 중이면) 파일 기록 */
function pushOutput(s: Session, data: string) {
  mainWindow?.webContents.send('terminal:data', { sessionId: s.id, data })
  if (s.logStream) {
    try {
      s.logStream.write(data)
    } catch {
      /* 스트림 오류 무시 */
    }
  }
}

// ── 로컬 셸(node-pty) ─────────────────────────────────────────
// SSH 미연결 시 터미널을 로컬 셸(cmd/bash)로 사용. SSH 연결되면 원격으로 전환.
function startLocalShell(s: Session) {
  if (s.localPty || s.shellStream || s.connecting) return
  const shell =
    process.platform === 'win32'
      ? process.env.COMSPEC || 'cmd.exe'
      : process.env.SHELL || '/bin/bash'
  try {
    s.localPty = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: os.homedir(),
      env: process.env as Record<string, string>,
    })
    s.localPty.onData((d) => pushOutput(s, d))
    s.localPty.onExit(() => {
      s.localPty = null
    })
  } catch (err) {
    mainWindow?.webContents.send('terminal:data', {
      sessionId: s.id,
      data: `\r\n\x1b[1;31m로컬 셸 시작 실패: ${err instanceof Error ? err.message : String(err)}\x1b[0m\r\n`,
    })
  }
}

function killLocalShell(s: Session) {
  s.localPty?.kill()
  s.localPty = null
}

function createWindow() {
  mainWindow = new BrowserWindow({
    // 사이드바 + 터미널 + AI 패널이 줄바꿈 없이 한 번에 보이는 기본 크기
    width: 1800,
    height: 1000,
    minWidth: 1280,
    minHeight: 720,
    backgroundColor: '#1e1e2e',
    webPreferences: {
      // 프리로드에서 contextBridge 로만 API 를 노출 → 보안 강화
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  // 개발 모드: Vite dev 서버 / 프로덕션: 빌드된 정적 파일
  // (개발자 도구는 자동으로 열지 않음 — 필요 시 F12 또는 Ctrl+Shift+I 로 토글)
  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

/** 렌더러로 연결 상태 이벤트 전송 */
function sendStatus(sessionId: string, event: Omit<SSHStatusEvent, 'sessionId'>) {
  mainWindow?.webContents.send('ssh:status', { sessionId, ...event })
}

// ── 호스트 키 검증 (TOFU: 최초 접속 시 신뢰·저장, 이후 변경 감지) ──
const knownHostsPath = () => path.join(app.getPath('userData'), 'known-hosts.dat')
let knownHosts: Record<string, string> | null = null // "host:port" → sha256 hex
const pendingHostKey: Record<string, string> = {} // 변경 감지 시 신뢰 대기 중인 새 키
const hostKeyId = (host: string, port: number) => `${host}:${port}`

async function loadKnownHosts(): Promise<Record<string, string>> {
  if (knownHosts) return knownHosts
  try {
    const json = decryptStr(await readFile(knownHostsPath(), 'utf-8'))
    knownHosts = json ? (JSON.parse(json) as Record<string, string>) : {}
  } catch {
    knownHosts = {}
  }
  return knownHosts
}
function saveKnownHosts() {
  if (knownHosts) void writeFile(knownHostsPath(), encryptStr(JSON.stringify(knownHosts)), 'utf-8')
}

/** SSH 에이전트 소켓/파이프 경로 해석 (없으면 undefined) */
function agentPath(): string | undefined {
  if (process.env.SSH_AUTH_SOCK) return process.env.SSH_AUTH_SOCK
  if (process.platform === 'win32') return '\\\\.\\pipe\\openssh-ssh-agent'
  return undefined
}

/** 특정 호스트용 TOFU 검증기 (최초 저장, 이후 변경 시 거부+대기) */
function makeHostVerifier(host: string, port: number) {
  const id = hostKeyId(host, port)
  return (hashedKey: string): boolean => {
    const known = knownHosts![id]
    if (!known) {
      knownHosts![id] = hashedKey
      saveKnownHosts()
      return true
    }
    if (known === hashedKey) return true
    pendingHostKey[id] = hashedKey
    return false
  }
}

/** 해당 세션의 SSH 연결 정리 (로컬 셸은 건드리지 않음) */
function cleanupConnection(s: Session) {
  // 모니터 리더만 멈춘다(서버 데몬은 그대로 두어 재접속 시 resume). 배포 플래그 리셋.
  stopMonitorReader(s.id)
  const mon = monitors.get(s.id)
  if (mon) mon.deployed = false
  s.shellStream?.end()
  s.shellStream = null
  // 활성 터널 정리
  for (const f of s.forwards) {
    try {
      f.server?.close()
    } catch {
      /* 무시 */
    }
  }
  s.forwards = []
  s.remoteHandlerAttached = false
  try {
    s.sftp?.end()
  } catch {
    /* 이미 닫힘 */
  }
  s.sftp = undefined
  s.client?.end()
  s.client = null
  s.jumpClient?.end()
  s.jumpClient = null
  s.lastPassword = undefined
  s.sudoPassword = undefined
}

// ── SSH 연결 (재사용 가능 함수: 최초 접속 + 자동 재접속 공용) ──────
const RECONNECT_MAX = 5
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

function connectSession(sessionId: string, config: SSHConfig): Promise<ConnectResult> {
  const s = getSession(sessionId)
  s.connecting = true
  s.wasConnected = false
  s.hadError = false
  killLocalShell(s)
  cleanupConnection(s)
  s.lastConfig = config
  s.lastPassword = config.password || undefined
  const targetId = hostKeyId(config.host, config.port)

  return new Promise<ConnectResult>((resolve) => {
    // 대상 서버에 연결 (sock 이 있으면 점프 호스트 경유)
    const connectTarget = (sock?: ClientChannel) => {
      const conn = new Client()
      s.client = conn

      conn
        .on('ready', () => {
          sendStatus(sessionId, {
            status: 'connected',
            message: `${config.username}@${config.host} 연결됨${sock ? ' (점프 경유)' : ''}`,
          })
          conn.shell({ term: 'xterm-256color' }, (err, stream) => {
            if (err) {
              sendStatus(sessionId, { status: 'error', message: `쉘 오픈 실패: ${err.message}` })
              resolve({ success: false, message: err.message })
              return
            }
            s.shellStream = stream
            s.wasConnected = true
            stream.on('data', (data: Buffer) => pushOutput(s, data.toString('utf-8')))
            stream.stderr.on('data', (data: Buffer) => pushOutput(s, data.toString('utf-8')))
            stream.on('close', () => {
              // 채널 종료 → 연결 종료 유도 (나머지 정리/재접속 판단은 client 'close' 가 담당)
              s.client?.end()
            })
            // 접속 후 자동 실행 명령 (프롬프트가 뜬 뒤 전송)
            if (config.startup && config.startup.trim()) {
              setTimeout(() => {
                for (const c of config.startup!.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)) {
                  stream.write(c + '\n')
                }
              }, 500)
            }
            s.connecting = false
            resolve({ success: true, message: '연결 성공' })
          })
        })
        .on('error', (err) => {
          s.connecting = false
          s.hadError = true
          const changed = !!pendingHostKey[targetId]
          const message = changed
            ? '⚠ 호스트 키가 이전과 다릅니다 (보안 경고). 서버가 재설치되었거나 중간자 공격일 수 있습니다.'
            : err.message
          sendStatus(sessionId, { status: 'error', message })
          resolve({ success: false, message, hostKeyChanged: changed })
        })
        .on('close', () => {
          if (s.reconnecting) return // 재접속 루프가 제어 중
          const shouldReconnect = !!(s.wasConnected && s.hadError && !s.userClosed && s.lastConfig)
          sendStatus(sessionId, {
            status: 'closed',
            message: shouldReconnect ? '연결이 끊겼습니다.' : '연결 종료됨',
          })
          if (shouldReconnect) {
            void attemptReconnect(sessionId)
          } else {
            cleanupConnection(s)
            if (!s.connecting) startLocalShell(s)
          }
        })

      conn.connect({
        sock,
        host: config.host,
        port: config.port,
        username: config.username,
        password: config.password,
        privateKey: config.privateKey,
        passphrase: config.passphrase,
        agent: config.useAgent ? agentPath() : undefined,
        readyTimeout: 20000,
        hostHash: 'sha256',
        hostVerifier: makeHostVerifier(config.host, config.port),
        keepaliveInterval: 15000,
        keepaliveCountMax: 3,
      })
    }

    if (config.jump) {
      // 점프 호스트 먼저 연결 → forwardOut 으로 대상까지 터널 후 connectTarget
      const jump = config.jump
      const jumpId = hostKeyId(jump.host, jump.port)
      const jc = new Client()
      s.jumpClient = jc
      sendStatus(sessionId, { status: 'connecting', message: `점프 호스트 ${jump.host} 연결 중...` })
      jc
        .on('ready', () => {
          sendStatus(sessionId, { status: 'connecting', message: `${config.host} 로 터널 생성 중...` })
          jc.forwardOut('127.0.0.1', 0, config.host, config.port, (err, stream) => {
            if (err) {
              s.connecting = false
              s.hadError = true
              sendStatus(sessionId, { status: 'error', message: `점프 터널 실패: ${err.message}` })
              if (!s.reconnecting) startLocalShell(s)
              resolve({ success: false, message: `점프 터널 실패: ${err.message}` })
              return
            }
            connectTarget(stream)
          })
        })
        .on('error', (err) => {
          s.connecting = false
          s.hadError = true
          const changed = !!pendingHostKey[jumpId]
          const message = changed
            ? '⚠ 점프 호스트의 키가 이전과 다릅니다 (보안 경고).'
            : `점프 호스트 연결 실패: ${err.message}`
          sendStatus(sessionId, { status: 'error', message })
          if (!s.reconnecting) startLocalShell(s)
          resolve({ success: false, message, hostKeyChanged: changed })
        })
      jc.connect({
        host: jump.host,
        port: jump.port,
        username: jump.username,
        password: jump.password,
        privateKey: jump.privateKey,
        passphrase: jump.passphrase,
        agent: jump.useAgent ? agentPath() : undefined,
        readyTimeout: 20000,
        hostHash: 'sha256',
        hostVerifier: makeHostVerifier(jump.host, jump.port),
        keepaliveInterval: 15000,
        keepaliveCountMax: 3,
      })
    } else {
      sendStatus(sessionId, { status: 'connecting', message: `${config.host} 연결 시도 중...` })
      connectTarget()
    }
  })
}

// 예기치 않은 끊김 시 자동 재접속 (백오프, 최대 RECONNECT_MAX 회)
async function attemptReconnect(sessionId: string) {
  const s = getSession(sessionId)
  if (!s.lastConfig || s.reconnecting) return
  s.reconnecting = true
  const cfg = s.lastConfig
  for (let i = 1; i <= RECONNECT_MAX; i++) {
    if (s.userClosed) break
    sendStatus(sessionId, {
      status: 'connecting',
      message: `연결이 끊겼습니다 — 자동 재접속 ${i}/${RECONNECT_MAX}...`,
    })
    await delay(Math.min(1500 * i, 6000))
    if (s.userClosed) break
    const r = await connectSession(sessionId, cfg)
    if (r.success) {
      s.reconnecting = false
      return
    }
  }
  s.reconnecting = false
  if (!s.userClosed) {
    sendStatus(sessionId, { status: 'error', message: '자동 재접속 실패. 수동으로 다시 연결하세요.' })
    const s2 = getSession(sessionId)
    cleanupConnection(s2)
    startLocalShell(s2)
  }
}

// ── IPC: SSH 연결 요청 ─────────────────────────────────────────
ipcMain.handle(
  'ssh:connect',
  async (_evt, sessionId: string, config: SSHConfig): Promise<ConnectResult> => {
    const s = getSession(sessionId)
    s.userClosed = false // 새 연결 시도 → 사용자 종료 플래그 해제
    s.reconnecting = false
    await loadKnownHosts()
    return connectSession(sessionId, config)
  },
)

// 변경된 호스트 키를 신뢰(덮어쓰기) — 사용자가 경고 확인 후 재접속할 때.
// 직전 접속에서 거부된 키(대상/점프 포함)를 모두 커밋한다.
ipcMain.handle('ssh:trustHost', async () => {
  const map = await loadKnownHosts()
  const ids = Object.keys(pendingHostKey)
  if (ids.length) {
    for (const id of ids) {
      map[id] = pendingHostKey[id]
      delete pendingHostKey[id]
    }
    saveKnownHosts()
  }
  return { ok: true }
})

// 세션 로그 기록 시작 (저장 위치 선택)
ipcMain.handle('log:start', async (_evt, { sessionId }: { sessionId: string }) => {
  const s = getSession(sessionId)
  if (s.logStream) return { ok: true, alreadyLogging: true }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const r = await dialog.showSaveDialog(mainWindow ?? undefined!, {
    defaultPath: `session-${sessionId}-${stamp}.log`,
    title: '세션 로그 저장 위치',
  })
  if (r.canceled || !r.filePath) return { ok: false, canceled: true }
  try {
    s.logStream = createWriteStream(r.filePath, { flags: 'a' })
    s.logStream.write(`\n===== 로그 시작 ${new Date().toISOString()} =====\n`)
    return { ok: true, path: r.filePath }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
})

// 세션 로그 기록 중지
ipcMain.handle('log:stop', (_evt, { sessionId }: { sessionId: string }) => {
  const s = getSession(sessionId)
  if (s.logStream) {
    try {
      s.logStream.end(`\n===== 로그 종료 ${new Date().toISOString()} =====\n`)
    } catch {
      /* 무시 */
    }
    s.logStream = undefined
  }
  return { ok: true }
})

// 개인키 파일 선택 → 내용 반환 (폼/모달에서 붙여넣기 대체)
ipcMain.handle('ssh:pickKeyFile', async () => {
  const r = await dialog.showOpenDialog(mainWindow ?? undefined!, {
    properties: ['openFile'],
    title: '개인키 파일 선택',
  })
  if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true }
  try {
    const content = await readFile(r.filePaths[0], 'utf-8')
    return { ok: true, content, name: r.filePaths[0].split(/[\\/]/).pop() || 'key' }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
})

// ── IPC: 터미널 입력 — SSH 연결 시 원격 쉘, 아니면 로컬 셸로 ──────
ipcMain.on('terminal:input', (_evt, sessionId: string, data: string) => {
  const s = getSession(sessionId)
  if (s.shellStream) s.shellStream.write(data)
  else s.localPty?.write(data)
})

// ── IPC: 터미널 리사이즈 (활성 대상 PTY 크기 동기화) ──────────────
ipcMain.on('terminal:resize', (_evt, sessionId: string, size: { cols: number; rows: number }) => {
  const s = getSession(sessionId)
  if (s.shellStream) s.shellStream.setWindow(size.rows, size.cols, 0, 0)
  else s.localPty?.resize(Math.max(1, size.cols), Math.max(1, size.rows))
})

// ── IPC: 렌더러 터미널 준비됨 → 미연결이면 로컬 셸 시작 ──────────
ipcMain.on('terminal:ready', (_evt, sessionId: string) => {
  const s = getSession(sessionId)
  if (!s.shellStream) startLocalShell(s)
})

// ── IPC: 연결 종료 요청 ────────────────────────────────────────
ipcMain.on('ssh:disconnect', (_evt, sessionId: string) => {
  const s = getSession(sessionId)
  s.userClosed = true // 사용자 종료 → 자동 재접속 안 함
  s.reconnecting = false
  cleanupConnection(s)
  sendStatus(sessionId, { status: 'closed', message: '사용자 요청으로 연결 종료' })
  startLocalShell(s) // 연결 해제 → 로컬 셸로 복귀
})

// ── IPC: 세션 닫기 (탭 제거) — 연결/로컬셸 모두 정리 ──────────────
ipcMain.on('session:close', (_evt, sessionId: string) => {
  const s = sessions.get(sessionId)
  if (!s) return
  s.userClosed = true // 탭 종료 → 자동 재접속 안 함
  s.reconnecting = false
  try {
    s.logStream?.end()
  } catch {
    /* 무시 */
  }
  s.logStream = undefined
  cleanupConnection(s)
  killLocalShell(s)
  sessions.delete(sessionId)
})

// ─────────────────────────────────────────────────────────────
// AI 분석 (Claude API)
//  - 렌더러가 보낸 대화 히스토리를 Claude(claude-opus-4-8)로 스트리밍 요청
//  - 응답 토큰을 'ai:delta' 로 실시간 전달, 완료 시 'ai:done', 오류 시 'ai:error'
//  - API 키는 메인 프로세스에서만 다뤄 렌더러/번들 노출을 최소화
// ─────────────────────────────────────────────────────────────

ipcMain.on('ai:start', async (_evt, req: AIRequest) => {
  const info = PROVIDER_INFO[req.provider]
  // UI 입력 키 우선, 없으면 프로바이더별 환경변수 폴백
  const apiKey = req.apiKey || (info ? process.env[info.envVar] : undefined)
  if (!info) {
    mainWindow?.webContents.send('ai:error', {
      requestId: req.requestId,
      error: `지원하지 않는 프로바이더: ${req.provider}`,
    })
    return
  }
  if (!apiKey) {
    mainWindow?.webContents.send('ai:error', {
      requestId: req.requestId,
      error: `${info.label} API 키가 없습니다. 우측 패널의 설정(⚙)에서 키를 입력하세요. (또는 환경변수 ${info.envVar})`,
    })
    return
  }

  // 과부하(529)/레이트리밋(429)/일시오류는 응답 전이면 자동 재시도
  const MAX_RETRY = 3
  let attempt = 0
  let emittedAny = false // 텍스트가 한 글자라도 나왔으면 재시도 금지(중복 방지)
  while (true) {
    try {
      await streamChat({
        provider: req.provider,
        apiKey,
        model: req.model || info.defaultModel,
        system: ANALYSIS_STYLES[req.style ?? 'detailed'].system,
        messages: req.messages,
        // 텍스트 조각만 렌더러로 전달 (thinking 등 내부 블록 제외)
        onText: (text) => {
          emittedAny = true
          mainWindow?.webContents.send('ai:delta', { requestId: req.requestId, text })
        },
      })
      mainWindow?.webContents.send('ai:done', { requestId: req.requestId })
      return
    } catch (err) {
      // 아직 출력 전 + 재시도 가능 오류 + 횟수 남음 → 백오프 후 재시도(조용히)
      if (!emittedAny && attempt < MAX_RETRY && isRetryableAIError(err)) {
        attempt++
        console.log(`[ai] 재시도 ${attempt}/${MAX_RETRY} (${cleanErrorMessage(err)})`)
        await new Promise((r) => setTimeout(r, 700 * attempt))
        continue
      }
      mainWindow?.webContents.send('ai:error', {
        requestId: req.requestId,
        error: friendlyAIError(err, attempt),
      })
      return
    }
  }
})

/** 과부하/레이트리밋/일시 서버오류 등 "잠시 후 재시도"로 풀릴 수 있는 오류인지 */
function isRetryableAIError(err: unknown): boolean {
  const status = (err as { status?: number; statusCode?: number })?.status ?? (err as { statusCode?: number })?.statusCode
  if (status === 429 || status === 500 || status === 502 || status === 503 || status === 529) return true
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase()
  return /overloaded|high demand|rate.?limit|temporar|try again|unavailable|timeout|529|503/.test(msg)
}

/** 과부하 등으로 최종 실패 시 사용자 친화적 안내 추가 */
function friendlyAIError(err: unknown, retried: number): string {
  const base = cleanErrorMessage(err)
  if (isRetryableAIError(err)) {
    return (
      `${base}\n\n` +
      `AI 서버가 일시적으로 혼잡합니다${retried ? ` (자동 ${retried}회 재시도함)` : ''}. ` +
      `잠시 후 다시 시도하거나, 설정(⚙)에서 다른 모델(예: sonnet) 또는 프로바이더로 바꿔보세요.`
    )
  }
  return base
}

// 키로 사용 가능한 모델 목록 조회
ipcMain.handle(
  'ai:listModels',
  async (_evt, req: { provider: AIProvider; apiKey?: string }) => {
    const info = PROVIDER_INFO[req.provider]
    const apiKey = req.apiKey || (info ? process.env[info.envVar] : undefined)
    if (!apiKey) return { ok: false, error: 'API 키를 먼저 입력하세요.' }
    try {
      const models = await listModels(req.provider, apiKey)
      return { ok: true, models }
    } catch (err) {
      return { ok: false, error: cleanErrorMessage(err) }
    }
  },
)

/**
 * 프로바이더 SDK 오류 메시지를 사람이 읽기 쉽게 정리.
 *  - 일부 SDK(예: Gemini)는 error.message 에 JSON 문자열을 통째로 담는다.
 *    중첩 JSON 을 풀어 가장 안쪽의 message 만 추출한다.
 */
function cleanErrorMessage(err: unknown): string {
  let msg = err instanceof Error ? err.message : String(err)
  for (let i = 0; i < 3; i++) {
    const t = msg.trim()
    if (!t.startsWith('{')) break
    try {
      const obj = JSON.parse(t)
      const inner = obj?.error?.message ?? obj?.message
      if (typeof inner === 'string' && inner !== msg) {
        msg = inner
        continue
      }
    } catch {
      /* JSON 이 아니면 그대로 사용 */
    }
    break
  }
  return msg
}

// ─────────────────────────────────────────────────────────────
// 리포트 저장 / 외부 링크
// ─────────────────────────────────────────────────────────────

// 분석 리포트를 파일로 저장 (네이티브 저장 다이얼로그)
ipcMain.handle(
  'report:save',
  async (_evt, payload: { defaultName: string; content: string }) => {
    const result = await dialog.showSaveDialog(mainWindow!, {
      title: '분석 리포트 저장',
      defaultPath: payload.defaultName,
      filters: [
        { name: 'Markdown', extensions: ['md'] },
        { name: 'Text', extensions: ['txt'] },
      ],
    })
    if (result.canceled || !result.filePath) {
      return { saved: false }
    }
    try {
      await writeFile(result.filePath, payload.content, 'utf-8')
      return { saved: true, path: result.filePath }
    } catch (err) {
      return { saved: false, error: err instanceof Error ? err.message : String(err) }
    }
  },
)

// 링크를 기본 브라우저로 열기 (앱 창 네비게이션 방지)
ipcMain.on('shell:openExternal', (_evt, url: string) => {
  if (/^https?:\/\//i.test(url)) shell.openExternal(url)
})

// ─────────────────────────────────────────────────────────────
// SSH 접속 정보 저장 (다음 실행 시 자동 채움)
//  - safeStorage(OS 키체인/DPAPI)로 암호화하여 userData 에 저장.
//    같은 OS 사용자만 복호화 가능 → 팀원 배포 시 각자 로컬에서 안전.
//  - 암호화 불가 환경에서는 base64(raw)로 저장(파일 접근 시 노출 가능).
// ─────────────────────────────────────────────────────────────

const profilesPath = () => path.join(app.getPath('userData'), 'ssh-profiles.dat')
const legacyProfilePath = () => path.join(app.getPath('userData'), 'ssh-profile.dat')

// 같은 서버를 식별하는 키 (재접속 시 중복 대신 갱신)
const profileKey = (p: SavedProfile) => `${p.host}:${p.port}:${p.username}`

function encryptStr(json: string): string {
  return safeStorage.isEncryptionAvailable()
    ? 'enc:' + safeStorage.encryptString(json).toString('base64')
    : 'raw:' + Buffer.from(json, 'utf-8').toString('base64')
}
function decryptStr(raw: string): string | null {
  if (raw.startsWith('enc:')) {
    if (!safeStorage.isEncryptionAvailable()) return null
    return safeStorage.decryptString(Buffer.from(raw.slice(4), 'base64'))
  }
  if (raw.startsWith('raw:')) return Buffer.from(raw.slice(4), 'base64').toString('utf-8')
  return null
}

async function readProfiles(): Promise<SavedProfile[]> {
  // 새 목록 파일 우선
  try {
    const json = decryptStr(await readFile(profilesPath(), 'utf-8'))
    if (json) {
      const arr = JSON.parse(json)
      if (Array.isArray(arr)) return arr as SavedProfile[]
    }
  } catch {
    /* 파일 없음 */
  }
  // 구버전 단일 프로필 → 목록으로 마이그레이션
  try {
    const json = decryptStr(await readFile(legacyProfilePath(), 'utf-8'))
    if (json) return [JSON.parse(json) as SavedProfile]
  } catch {
    /* 파일 없음 */
  }
  return []
}

async function writeProfiles(list: SavedProfile[]): Promise<void> {
  await writeFile(profilesPath(), encryptStr(JSON.stringify(list)), 'utf-8')
}

// 시스템 클립보드 텍스트 읽기 (터미널 Ctrl+V 붙여넣기용)
ipcMain.handle('clipboard:read', () => clipboard.readText())

// 다중 호스트 실행 — 별도 exec 채널로 명령 1회 실행 후 결과 캡처 (인터랙티브 셸 비오염)
ipcMain.handle('session:run', async (_evt, { sessionId, cmd }: { sessionId: string; cmd: string }) => {
  const s = getSession(sessionId)
  if (!s.client) return { ok: false, error: '연결되어 있지 않습니다.' }
  try {
    const r = await execCapture(s.client, cmd)
    return { ok: true, code: r.code, out: r.out, err: r.err }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
})

// ── 파일 탐색기 (SFTP) ─────────────────────────────────────────
/** 세션당 SFTP 핸들 확보(없으면 열고 캐시, 닫히면 자동 해제) */
function getSftp(s: Session): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => {
    if (!s.client) return reject(new Error('연결되어 있지 않습니다.'))
    if (s.sftp) return resolve(s.sftp)
    s.client.sftp((err, sftp) => {
      if (err) return reject(err)
      s.sftp = sftp
      const drop = () => {
        if (s.sftp === sftp) s.sftp = undefined
      }
      sftp.on('close', drop)
      sftp.on('error', drop)
      resolve(sftp)
    })
  })
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))
// POSIX 경로 결합 (원격은 항상 '/')
const rjoin = (dir: string, name: string) => (dir.endsWith('/') ? dir + name : dir + '/' + name)

// SFTP 프로미스 헬퍼
const sftpReaddir = (sftp: SFTPWrapper, p: string) =>
  new Promise<import('ssh2').FileEntry[]>((res, rej) => sftp.readdir(p, (e, l) => (e ? rej(e) : res(l))))

// 재귀 삭제 (디렉토리/파일)
async function rmrf(sftp: SFTPWrapper, p: string, isDir: boolean) {
  if (!isDir) {
    await new Promise<void>((res, rej) => sftp.unlink(p, (e) => (e ? rej(e) : res())))
    return
  }
  for (const it of await sftpReaddir(sftp, p)) {
    const child = rjoin(p, it.filename)
    await rmrf(sftp, child, it.longname?.[0] === 'd')
  }
  await new Promise<void>((res, rej) => sftp.rmdir(p, (e) => (e ? rej(e) : res())))
}

// 재귀 다운로드 (원격 디렉토리 → 로컬)
async function getDirRecursive(sftp: SFTPWrapper, remote: string, localDir: string) {
  await mkdir(localDir, { recursive: true })
  for (const it of await sftpReaddir(sftp, remote)) {
    const rc = rjoin(remote, it.filename)
    const lc = path.join(localDir, it.filename)
    if (it.longname?.[0] === 'd') await getDirRecursive(sftp, rc, lc)
    else if (it.longname?.[0] === '-')
      await new Promise<void>((res, rej) => sftp.fastGet(rc, lc, (e) => (e ? rej(e) : res())))
    // 심볼릭 링크 등은 건너뜀
  }
}

// 디렉토리 목록 (path 없으면 홈으로)
ipcMain.handle('sftp:list', async (_evt, { sessionId, path: dirPath }: { sessionId: string; path?: string }) => {
  const s = getSession(sessionId)
  try {
    const sftp = await getSftp(s)
    const cwd =
      dirPath && dirPath.length
        ? dirPath
        : await new Promise<string>((res, rej) =>
            sftp.realpath('.', (e, p) => (e ? rej(e) : res(p))),
          )
    const list = await new Promise<import('ssh2').FileEntry[]>((res, rej) =>
      sftp.readdir(cwd, (e, l) => (e ? rej(e) : res(l))),
    )
    const entries = list
      .map((it) => {
        const lead = it.longname?.[0]
        const type = lead === 'd' ? 'dir' : lead === 'l' ? 'link' : 'file'
        return { name: it.filename, type, size: it.attrs.size, mtime: it.attrs.mtime }
      })
      .filter((e) => e.name !== '.' && e.name !== '..')
      .sort((a, b) => {
        if (a.type === 'dir' && b.type !== 'dir') return -1
        if (a.type !== 'dir' && b.type === 'dir') return 1
        return a.name.localeCompare(b.name)
      })
    return { ok: true, path: cwd, entries }
  } catch (e) {
    return { ok: false, error: errMsg(e) }
  }
})

// 파일 다운로드 (원격 → 로컬, 저장 위치 선택)
ipcMain.handle(
  'sftp:download',
  async (_evt, { sessionId, remotePath, name }: { sessionId: string; remotePath: string; name: string }) => {
    const s = getSession(sessionId)
    if (!s.client) return { ok: false, error: '연결되어 있지 않습니다.' }
    const r = await dialog.showSaveDialog(mainWindow ?? undefined!, { defaultPath: name })
    if (r.canceled || !r.filePath) return { ok: false, canceled: true }
    try {
      const sftp = await getSftp(s)
      await new Promise<void>((res, rej) =>
        sftp.fastGet(
          remotePath,
          r.filePath as string,
          { step: (t, _c, tot) => sendProgress(sessionId, name, t, tot) },
          (e) => (e ? rej(e) : res()),
        ),
      )
      return { ok: true, localPath: r.filePath }
    } catch (e) {
      return { ok: false, error: errMsg(e) }
    }
  },
)

// 전송 진행률 전송 헬퍼
const sendProgress = (sessionId: string, name: string, transferred: number, total: number) =>
  mainWindow?.webContents.send('sftp:progress', {
    sessionId,
    name,
    pct: total ? Math.round((transferred / total) * 100) : 0,
  })

// 파일 권한 변경 (chmod)
ipcMain.handle(
  'sftp:chmod',
  async (_evt, { sessionId, path: p, mode }: { sessionId: string; path: string; mode: number }) => {
    const s = getSession(sessionId)
    if (!s.client) return { ok: false, error: '연결되어 있지 않습니다.' }
    try {
      const sftp = await getSftp(s)
      await new Promise<void>((res, rej) => sftp.chmod(p, mode, (e) => (e ? rej(e) : res())))
      return { ok: true }
    } catch (e) {
      return { ok: false, error: errMsg(e) }
    }
  },
)

// 파일 업로드 (로컬 → 원격). localPaths 없으면 파일 선택 대화상자.
ipcMain.handle(
  'sftp:upload',
  async (
    _evt,
    { sessionId, remoteDir, localPaths }: { sessionId: string; remoteDir: string; localPaths?: string[] },
  ) => {
    const s = getSession(sessionId)
    if (!s.client) return { ok: false, error: '연결되어 있지 않습니다.' }
    let paths = localPaths
    if (!paths || !paths.length) {
      const r = await dialog.showOpenDialog(mainWindow ?? undefined!, {
        properties: ['openFile', 'multiSelections'],
      })
      if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true }
      paths = r.filePaths
    }
    try {
      const sftp = await getSftp(s)
      const uploaded: string[] = []
      for (const lp of paths) {
        const base = lp.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'file'
        await new Promise<void>((res, rej) =>
          sftp.fastPut(
            lp,
            rjoin(remoteDir, base),
            { step: (t, _c, tot) => sendProgress(sessionId, base, t, tot) },
            (e) => (e ? rej(e) : res()),
          ),
        )
        uploaded.push(base)
      }
      return { ok: true, uploaded }
    } catch (e) {
      return { ok: false, error: errMsg(e) }
    }
  },
)

// ── 포트 포워딩 (터널링) ───────────────────────────────────────
const fwView = (f: ForwardEntry) => ({
  id: f.id,
  type: f.type,
  localHost: f.localHost,
  localPort: f.localPort,
  remoteHost: f.remoteHost,
  remotePort: f.remotePort,
})
let fwSeq = 0

// 원격 포워딩 연결 라우팅 핸들러 (세션당 1회 부착)
function ensureRemoteHandler(s: Session) {
  if (s.remoteHandlerAttached || !s.client) return
  s.remoteHandlerAttached = true
  s.client.on('tcp connection', (info, accept) => {
    const f = s.forwards.find((x) => x.type === 'remote' && x.remotePort === info.destPort)
    if (!f) return
    const stream = accept()
    const socket = net.connect(f.localPort, f.localHost || '127.0.0.1')
    socket.on('error', () => stream.end())
    stream.on('error', () => socket.end())
    socket.pipe(stream).pipe(socket)
  })
}

ipcMain.handle('tunnel:list', (_evt, { sessionId }: { sessionId: string }) => {
  return { ok: true, forwards: getSession(sessionId).forwards.map(fwView) }
})

ipcMain.handle(
  'tunnel:add',
  async (
    _evt,
    {
      sessionId,
      type,
      localHost,
      localPort,
      remoteHost,
      remotePort,
    }: {
      sessionId: string
      type: 'local' | 'remote'
      localHost: string
      localPort: number
      remoteHost: string
      remotePort: number
    },
  ) => {
    const s = getSession(sessionId)
    if (!s.client) return { ok: false, error: '연결되어 있지 않습니다.' }
    const id = `fw${++fwSeq}`
    if (type === 'local') {
      // 로컬 포트로 들어온 연결을 원격(remoteHost:remotePort)으로 터널
      const server = net.createServer((socket) => {
        s.client!.forwardOut(
          socket.remoteAddress || '127.0.0.1',
          socket.remotePort || 0,
          remoteHost,
          remotePort,
          (err, stream) => {
            if (err) {
              socket.destroy()
              return
            }
            socket.pipe(stream).pipe(socket)
          },
        )
      })
      return await new Promise((resolve) => {
        server.once('error', (e: Error) => resolve({ ok: false, error: e.message }))
        server.listen(localPort, localHost || '127.0.0.1', () => {
          s.forwards.push({ id, type, localHost: localHost || '127.0.0.1', localPort, remoteHost, remotePort, server })
          resolve({ ok: true, id })
        })
      })
    } else {
      // 원격 포트로 들어온 연결을 로컬(localHost:localPort)으로 전달
      return await new Promise((resolve) => {
        s.client!.forwardIn(remoteHost || '127.0.0.1', remotePort, (err) => {
          if (err) {
            resolve({ ok: false, error: err.message })
            return
          }
          s.forwards.push({ id, type, localHost: localHost || '127.0.0.1', localPort, remoteHost: remoteHost || '127.0.0.1', remotePort })
          ensureRemoteHandler(s)
          resolve({ ok: true, id })
        })
      })
    }
  },
)

ipcMain.handle('tunnel:remove', (_evt, { sessionId, id }: { sessionId: string; id: string }) => {
  const s = getSession(sessionId)
  const f = s.forwards.find((x) => x.id === id)
  if (!f) return { ok: true }
  if (f.type === 'local') {
    try {
      f.server?.close()
    } catch {
      /* 무시 */
    }
  } else {
    try {
      s.client?.unforwardIn(f.remoteHost || '127.0.0.1', f.remotePort)
    } catch {
      /* 무시 */
    }
  }
  s.forwards = s.forwards.filter((x) => x.id !== id)
  return { ok: true }
})

// 드래그-아웃 (원격 → OS): 임시폴더로 내려받은 뒤 네이티브 드래그 시작.
// dragstart 제스처에서 호출되며, 작은~중간 파일에서 매끄럽게 동작.
const DRAG_ICON = nativeImage.createFromDataURL(
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAOElEQVR42u3OMQEAAAgDoJnc6BpjDyRgcrZ1qkBhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWHxWniH7QGB0AXr8gAAAABJRU5ErkJggg==',
)
ipcMain.on(
  'sftp:startDrag',
  async (evt, { sessionId, remotePath, name }: { sessionId: string; remotePath: string; name: string }) => {
    const s = getSession(sessionId)
    if (!s.client) return
    try {
      const sftp = await getSftp(s)
      const tmp = path.join(app.getPath('temp'), `ivf-${Date.now()}-${name}`)
      await new Promise<void>((res, rej) => sftp.fastGet(remotePath, tmp, (e) => (e ? rej(e) : res())))
      evt.sender.startDrag({ file: tmp, icon: DRAG_ICON })
    } catch {
      /* 드래그-아웃 실패 시 무시 (다운로드 버튼으로 대체 가능) */
    }
  },
)

// 새 폴더
ipcMain.handle('sftp:mkdir', async (_evt, { sessionId, path: p }: { sessionId: string; path: string }) => {
  const s = getSession(sessionId)
  try {
    const sftp = await getSftp(s)
    await new Promise<void>((res, rej) => sftp.mkdir(p, (e) => (e ? rej(e) : res())))
    return { ok: true }
  } catch (e) {
    return { ok: false, error: errMsg(e) }
  }
})

// 이름 변경 / 이동
ipcMain.handle(
  'sftp:rename',
  async (_evt, { sessionId, from, to }: { sessionId: string; from: string; to: string }) => {
    const s = getSession(sessionId)
    try {
      const sftp = await getSftp(s)
      await new Promise<void>((res, rej) => sftp.rename(from, to, (e) => (e ? rej(e) : res())))
      return { ok: true }
    } catch (e) {
      return { ok: false, error: errMsg(e) }
    }
  },
)

// 삭제 (파일/디렉토리 재귀)
ipcMain.handle(
  'sftp:delete',
  async (_evt, { sessionId, path: p, isDir }: { sessionId: string; path: string; isDir: boolean }) => {
    const s = getSession(sessionId)
    try {
      const sftp = await getSftp(s)
      await rmrf(sftp, p, isDir)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: errMsg(e) }
    }
  },
)

// 폴더 통째 다운로드 (저장할 상위 폴더 선택 → 재귀)
ipcMain.handle(
  'sftp:downloadDir',
  async (_evt, { sessionId, remotePath, name }: { sessionId: string; remotePath: string; name: string }) => {
    const s = getSession(sessionId)
    if (!s.client) return { ok: false, error: '연결되어 있지 않습니다.' }
    const r = await dialog.showOpenDialog(mainWindow ?? undefined!, {
      properties: ['openDirectory', 'createDirectory'],
      title: `'${name}' 폴더를 저장할 위치 선택`,
    })
    if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true }
    try {
      const sftp = await getSftp(s)
      await getDirRecursive(sftp, remotePath, path.join(r.filePaths[0], name))
      return { ok: true, localPath: path.join(r.filePaths[0], name) }
    } catch (e) {
      return { ok: false, error: errMsg(e) }
    }
  },
)

// 저장된 접속 기록 목록
ipcMain.handle('profiles:list', async () => readProfiles())

// 프로필 추가/갱신 (최근 사용을 맨 앞으로).
// 자동 저장(연결 시)은 label/group 을 안 주므로, 기존에 지정된 값이 있으면 보존한다.
ipcMain.handle('profiles:upsert', async (_evt, profile: SavedProfile) => {
  const all = await readProfiles()
  const existing = all.find((p) => profileKey(p) === profileKey(profile))
  const merged: SavedProfile = {
    ...profile,
    label: profile.label ?? existing?.label,
    group: profile.group ?? existing?.group,
    jump: profile.jump ?? existing?.jump,
    startup: profile.startup ?? existing?.startup,
  }
  const list = all.filter((p) => profileKey(p) !== profileKey(profile))
  list.unshift(merged)
  await writeProfiles(list)
  return list
})

// 특정 프로필 삭제 (key = host:port:username)
ipcMain.handle('profiles:delete', async (_evt, key: string) => {
  const list = (await readProfiles()).filter((p) => profileKey(p) !== key)
  await writeProfiles(list)
  return list
})

// 전체 프로필 순서/그룹 일괄 반영 (사이드바 드래그 재정렬용)
ipcMain.handle('profiles:reorder', async (_evt, list: SavedProfile[]) => {
  if (Array.isArray(list)) await writeProfiles(list)
  return readProfiles()
})

// 폴더(그룹) 이름 일괄 변경 — 순서 보존, 빈 이름이면 그룹 해제
ipcMain.handle(
  'profiles:renameGroup',
  async (_evt, { from, to }: { from: string; to: string }) => {
    const target = to.trim() || undefined
    const list = (await readProfiles()).map((p) =>
      (p.group?.trim() ?? '') === from ? { ...p, group: target } : p,
    )
    await writeProfiles(list)
    return list
  },
)

// 전체 기록 삭제
ipcMain.handle('profiles:clear', async () => {
  try {
    await unlink(profilesPath())
  } catch {
    /* 없음 */
  }
  try {
    await unlink(legacyProfilePath())
  } catch {
    /* 없음 */
  }
  return []
})

// ─────────────────────────────────────────────────────────────
// SFTP 파일 읽기/쓰기 (설정파일 뷰어용)
//  - 1차: SFTP(로그인 사용자 권한). 2차: 권한 부족 시 sudo(cat/tee)로 폴백.
//    sudo 는 NOPASSWD 거나, 비밀번호 인증 접속이면 그 비밀번호를 -S 로 주입해 사용.
// ─────────────────────────────────────────────────────────────

/** 셸 인자용 작은따옴표 이스케이프 */
const shQuote = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'"

/** exec 로 명령 실행하고 stdout/stderr/exit code 수집 (stdin 옵션) */
function execCapture(
  client: Client,
  cmd: string,
  stdin?: string,
): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    client.exec(cmd, (err, stream) => {
      if (err) return reject(err)
      let out = ''
      let errOut = ''
      stream.on('data', (d: Buffer) => (out += d.toString('utf-8')))
      stream.stderr.on('data', (d: Buffer) => (errOut += d.toString('utf-8')))
      stream.on('close', (code: number | null) =>
        resolve({ code: code ?? 0, out, err: errOut }),
      )
      stream.end(stdin ?? '')
    })
  })
}

/** SFTP 직접 읽기 (Promise). 사용 후 반드시 sftp.end() 로 채널 반납(누수 방지) */
function sftpReadDirect(
  client: Client,
  filePath: string,
): Promise<{ ok: boolean; content?: string; error?: string }> {
  return new Promise((resolve) => {
    client.sftp((err, sftp) => {
      if (err) return resolve({ ok: false, error: err.message })
      sftp.readFile(filePath, (e, data) => {
        sftp.end() // SFTP 채널 닫기 (MaxSessions 초과로 인한 "Channel open failure" 방지)
        if (e) return resolve({ ok: false, error: e.message })
        resolve({ ok: true, content: data.toString('utf-8') })
      })
    })
  })
}

// PTY 기반 sudo 실행 — requiretty 설정/비-PTY stdin 거부 환경 회피용.
//  - PTY 모드에서는 stdout/stderr 가 합쳐지므로, 호출측에서 마커로 본문을 분리한다.
//  - 비밀번호는 PTY 에 직접 써 넣는다(sudo 가 에코를 끄므로 출력에 남지 않음).
const MARK_A = '__IVK_OUT_A_5b2e__'
const MARK_B = '__IVK_OUT_B_5b2e__'

function execSudoPty(
  client: Client,
  innerSh: string,
  password: string,
): Promise<{ code: number; data: string }> {
  return new Promise((resolve, reject) => {
    client.exec(`sudo -S -p '' sh -c ${shQuote(innerSh)}`, { pty: true }, (err, stream) => {
      if (err) {
        console.error('[sudo-pty] exec error:', err.message)
        return reject(err)
      }
      let data = ''
      stream.on('data', (chunk: Buffer) => (data += chunk.toString('utf-8')))
      stream.on('close', (code: number | null) => {
        // 디버그: 종료코드 + 마커 외 노이즈(주로 sudo 에러)만 일부 기록 (파일내용/비번 제외)
        const noise = data.replace(MARK_A, '').replace(MARK_B, '').slice(0, 200)
        console.log(`[sudo-pty] close code=${code} noise=${JSON.stringify(noise)}`)
        resolve({ code: code ?? 0, data })
      })
      // sudo 프롬프트가 준비될 약간의 여유를 준 뒤 비밀번호 주입
      setTimeout(() => {
        try {
          stream.write(password + '\n')
        } catch {
          /* 스트림이 이미 닫힘 */
        }
      }, 150)
    })
  })
}

let readSeq = 0

/** sudo 로 파일을 읽는 원격 셸 명령 생성.
 *  - cat 성공 시:  MARK_A + "OK:" + base64(파일)        + MARK_B
 *  - cat 실패 시:  MARK_A + "ERR:" + cat의 에러메시지     + MARK_B
 *  - sudo 인증 실패 시: sh -c 자체가 실행되지 않아 마커가 전혀 없음
 *  덕분에 "인증 실패 / 파일 없음·권한없음 / 정상" 을 명확히 구분한다. */
function buildReadCmd(filePath: string): string {
  const q = shQuote(filePath)
  const tmp = `/tmp/.ivkr_${process.pid}_${readSeq++}`
  const tq = shQuote(tmp)
  const eq = shQuote(tmp + '.err')
  return (
    `cat -- ${q} > ${tq} 2> ${eq}; rc=$?; ` +
    `printf %s ${shQuote(MARK_A)}; ` +
    `if [ $rc -eq 0 ]; then printf OK:; base64 < ${tq}; else printf ERR:; cat ${eq}; fi; ` +
    `printf %s ${shQuote(MARK_B)}; rm -f ${tq} ${eq}; exit $rc`
  )
}

type ReadParse =
  | { authed: false } // sudo 인증/실행 실패 → 다음 비밀번호 후보로
  | { authed: true; ok: true; content: string } // 정상 읽기
  | { authed: true; ok: false; fileErr: string } // sudo는 됐으나 파일 자체 오류

/** buildReadCmd 출력(비-PTY stdout 또는 PTY 합본)을 해석 */
function parseReadOutput(data: string): ReadParse {
  const a = data.indexOf(MARK_A)
  if (a < 0) return { authed: false }
  const b = data.indexOf(MARK_B, a + MARK_A.length)
  const seg = (b < 0 ? data.slice(a + MARK_A.length) : data.slice(a + MARK_A.length, b)).replace(
    /^\s+/,
    '',
  )
  if (seg.startsWith('OK:')) {
    const b64 = seg.slice(3).replace(/[^A-Za-z0-9+/=]/g, '')
    try {
      return { authed: true, ok: true, content: Buffer.from(b64, 'base64').toString('utf-8') }
    } catch {
      return { authed: true, ok: false, fileErr: 'base64 디코드 실패' }
    }
  }
  if (seg.startsWith('ERR:')) {
    const m = seg.slice(4).trim().split('\n').pop() || '파일을 읽을 수 없습니다'
    return { authed: true, ok: false, fileErr: m.replace(/^cat:\s*/, '').trim() }
  }
  return { authed: true, ok: false, fileErr: '알 수 없는 응답' }
}

/** 주어진 내용을 원격 경로에 SFTP 로 직접 기록(로그인 사용자 권한) — /tmp 임시파일 업로드용.
 *  사용 후 반드시 sftp.end() 로 채널 반납(누수 방지) */
function sftpWriteDirect(
  client: Client,
  path: string,
  content: string,
): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    client.sftp((err, sftp) => {
      if (err) return resolve({ ok: false, error: err.message })
      sftp.writeFile(path, content, (e) => {
        sftp.end() // SFTP 채널 닫기 (채널 누수 방지)
        if (e) return resolve({ ok: false, error: e.message })
        resolve({ ok: true })
      })
    })
  })
}

// 파일 읽기 (SFTP → sudo cat 폴백)
//  - sudoPassword: 설정파일 뷰어에서 직접 입력받은 sudo 비밀번호(권한 부족 시 재시도용)
ipcMain.handle(
  'sftp:read',
  async (_evt, sessionId: string, filePath: string, sudoPassword?: string) => {
  const s = getSession(sessionId)
  const client = s.client
  if (!client) return { ok: false, error: 'SSH 연결이 없습니다. 먼저 연결하세요.' }

  // 1) SFTP 직접 읽기
  const direct = await sftpReadDirect(client, filePath)
  if (direct.ok) return direct

  const inner = buildReadCmd(filePath)
  // sudo 인증은 됐지만 파일 자체 오류(없음/권한)면 비밀번호 팝업 없이 즉시 반환
  const fileFail = (fileErr: string) => ({
    ok: false as const,
    needSudoPassword: false,
    error: `읽기 실패: ${fileErr}`,
  })

  // 2) sudo -n (NOPASSWD) — 비밀번호 없이
  try {
    const r = await execCapture(client, `sudo -n sh -c ${shQuote(inner)}`)
    const p = parseReadOutput(r.out)
    if (p.authed) {
      if (p.ok) return { ok: true, content: p.content, viaSudo: true }
      return fileFail(p.fileErr)
    }
  } catch {
    /* 다음 시도 */
  }

  // 3) sudo 비밀번호 주입 (입력값 → 캐시 → 접속 비밀번호 순). 후보마다 비-PTY → PTY 순 시도.
  const cands = sudoPwCandidates(s, sudoPassword)
  let lastErr = ''
  for (const pw of cands) {
    // 3-a) 비-PTY: echo pw | sudo -S sh -c (가장 가벼움)
    try {
      const r = await execCapture(client, `sudo -S -p '' sh -c ${shQuote(inner)}`, pw + '\n')
      const p = parseReadOutput(r.out)
      if (p.authed) {
        if (p.ok) {
          s.sudoPassword = pw
          return { ok: true, content: p.content, viaSudo: true }
        }
        return fileFail(p.fileErr)
      }
      if (r.err) lastErr = cleanSudoErr(r.err)
    } catch {
      /* 다음 단계 시도 */
    }
    // 3-b) PTY (requiretty 등 비-PTY 실패 환경 회피)
    try {
      const r = await execSudoPty(client, inner, pw)
      const p = parseReadOutput(r.data)
      if (p.authed) {
        if (p.ok) {
          s.sudoPassword = pw
          return { ok: true, content: p.content, viaSudo: true }
        }
        return fileFail(p.fileErr)
      }
      const e = cleanSudoErr(r.data)
      if (e) lastErr = e
    } catch {
      /* 다음 후보 시도 */
    }
  }
  const noSudo = lastErr.includes('sudo 권한이 없습니다')
  return {
    ok: false,
    needSudoPassword: !noSudo, // 비밀번호 입력으로 재시도 가능하면 true
    error: noSudo
      ? lastErr
      : lastErr
        ? `${lastErr} sudo 비밀번호를 입력해 다시 시도하세요.`
        : 'root 권한이 필요한 파일입니다. sudo 비밀번호를 입력하면 다시 시도합니다.',
  }
  },
)

/** stdin 없는 명령을 권한 단계별(plain → sudo -n → sudo -S)로 실행 */
async function execEscalatedNoStdin(
  s: Session,
  build: (sudoPrefix: string) => string,
  sudoPassword?: string,
): Promise<{ ok: boolean; err?: string }> {
  const client = s.client!
  try {
    const r = await execCapture(client, build(''))
    if (r.code === 0) return { ok: true }
  } catch {
    /* 다음 시도 */
  }
  try {
    const r = await execCapture(client, build('sudo -n '))
    if (r.code === 0) return { ok: true }
  } catch {
    /* 다음 시도 */
  }
  let lastErr = ''
  for (const pw of sudoPwCandidates(s, sudoPassword)) {
    try {
      const r = await execCapture(client, build("sudo -S -p '' "), pw + '\n')
      if (r.code === 0) {
        s.sudoPassword = pw
        return { ok: true }
      }
      if (r.err) lastErr = cleanSudoErr(r.err)
    } catch {
      /* 다음 후보 시도 */
    }
  }
  return { ok: false, err: lastErr || '권한 부족' }
}

// 설정파일 백업을 모으는 고정 베이스 경로 (원본 디렉토리를 더럽히지 않도록 분리).
// 이 아래에 원본 경로 구조를 그대로 미러링해 저장한다. (변경하려면 이 값만 수정)
const BACKUP_BASE = '/var/tmp/ivk-backups'

// 파일 쓰기(저장) — 저장 전 자동 백업(별도 베이스 경로) → SFTP → sudo tee 폴백
ipcMain.handle(
  'sftp:write',
  async (
    _evt,
    payload: { sessionId: string; path: string; content: string; sudoPassword?: string },
  ) => {
    const s = getSession(payload.sessionId)
    const client = s.client
    if (!client) return { ok: false, error: 'SSH 연결이 없습니다. 먼저 연결하세요.' }
    const sudoPw = payload.sudoPassword

    // 0) 저장 전 원본 자동 백업 → 고정 베이스(BACKUP_BASE) 아래에 원본 경로 구조 미러링
    //    예: /etc/nova/nova.conf → /var/tmp/ivk-backups/etc/nova/nova.conf_<YYYYMMDDHHMMSS>
    //    원본 디렉토리(/etc/nova 등)는 건드리지 않는다. (실패 시 저장 중단)
    const d = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    const ts =
      `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
      `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
    const slash = payload.path.lastIndexOf('/')
    const dir = slash > 0 ? payload.path.slice(0, slash) : '.'
    const base = payload.path.slice(slash + 1)
    const backupDir = `${BACKUP_BASE}${dir.startsWith('/') ? dir : '/' + dir}`
    const backupPath = `${backupDir}/${base}_${ts}`

    const q = shQuote(payload.path)
    let lastErr = ''

    // 1) 비-PTY 경로: 백업(폴더생성+복사) → 본문쓰기(SFTP직접 → sudo -n/-S tee)
    const mk = await execEscalatedNoStdin(s, (pfx) => `${pfx}mkdir -p ${shQuote(backupDir)}`, sudoPw)
    const bk = mk.ok
      ? await execEscalatedNoStdin(
          s,
          (pfx) => `${pfx}cp -a -- ${shQuote(payload.path)} ${shQuote(backupPath)}`,
          sudoPw,
        )
      : { ok: false, err: mk.err }
    if (bk.ok) {
      // 1-a) SFTP 직접 쓰기 (로그인 사용자가 파일 소유)
      const direct = await sftpWriteDirect(client, payload.path, payload.content)
      if (direct.ok) return { ok: true, backupPath }
      // 1-b) sudo -n tee (NOPASSWD)
      try {
        const r = await execCapture(client, `sudo -n tee -- ${q} > /dev/null`, payload.content)
        if (r.code === 0) return { ok: true, viaSudo: true, backupPath }
      } catch {
        /* 다음 시도 */
      }
      // 1-c) sudo -S tee (비밀번호 주입: 첫 줄=비밀번호, 이후=내용)
      for (const pw of sudoPwCandidates(s, sudoPw)) {
        try {
          const r = await execCapture(
            client,
            `sudo -S -p '' tee -- ${q} > /dev/null`,
            pw + '\n' + payload.content,
          )
          if (r.code === 0) {
            s.sudoPassword = pw
            return { ok: true, viaSudo: true, backupPath }
          }
          if (r.err) lastErr = cleanSudoErr(r.err)
        } catch {
          /* 다음 후보 시도 */
        }
      }
    } else if (bk.err) {
      lastErr = bk.err
    }

    // 2) PTY 올인원 폴백 (requiretty 등 비-PTY 실패 환경):
    //    /tmp 에 내용 업로드 → sudo PTY 로 [백업폴더생성 + 원본복사 + 덮어쓰기] 일괄 수행
    const tmp = `/tmp/.ivk_w_${ts}_${process.pid}`
    const up = await sftpWriteDirect(client, tmp, payload.content)
    if (up.ok) {
      const inner =
        `(mkdir -p ${shQuote(backupDir)} && cp -a -- ${q} ${shQuote(backupPath)} && ` +
        `cat ${shQuote(tmp)} > ${q}); rc=$?; rm -f ${shQuote(tmp)}; exit $rc`
      for (const pw of sudoPwCandidates(s, sudoPw)) {
        try {
          const r = await execSudoPty(client, inner, pw)
          if (r.code === 0) {
            s.sudoPassword = pw
            return { ok: true, viaSudo: true, backupPath }
          }
          const e = cleanSudoErr(r.data)
          if (e) lastErr = e
        } catch {
          /* 다음 후보 시도 */
        }
      }
    } else if (!lastErr) {
      lastErr = `임시파일 업로드 실패: ${up.error}`
    }

    const noSudo = lastErr.includes('sudo 권한이 없습니다')
    return {
      ok: false,
      needSudoPassword: !noSudo,
      error: noSudo
        ? lastErr
        : `저장 실패(권한). ${lastErr || 'sudo 비밀번호를 입력해 다시 시도하세요.'}`,
    }
  },
)

/** sudo 표준에러에서 핵심 메시지만 정리 */
function cleanSudoErr(err: string): string {
  const t = err.trim()
  if (/incorrect password|a password is required|sudo:.*password/i.test(t))
    return 'sudo 비밀번호 인증 실패 — NOPASSWD가 아니거나 접속 비밀번호와 sudo 비밀번호가 다릅니다.'
  if (/not allowed|may not run sudo|not in the sudoers/i.test(t))
    return '이 계정은 sudo 권한이 없습니다.'
  return t.split('\n').slice(-1)[0] || '권한 오류'
}

// ─────────────────────────────────────────────────────────────
// 서버 모니터링 (상시 데몬 방식, 세션별)
//  - 에이전트 스크립트를 SFTP 로 업로드 → nohup 으로 데몬 기동(연결 끊겨도 생존)
//  - 데몬은 metrics.jsonl 에 주기적으로 append. 메인은 tail 로 증분 수거하여
//    ts 가 새 샘플만 렌더러로 전달(중복 방지). 재접속 시 최근 이력 자동 backfill.
//  - 세션(터미널 탭)마다 독립적으로 동작한다.
// ─────────────────────────────────────────────────────────────

const AGENT_DIR = '/tmp/.ivk-agent'
const AGENT_PATH = `${AGENT_DIR}/collect.sh`
const AGENT_PID = `${AGENT_DIR}/agent.pid`
const DATA_PATH = `${AGENT_DIR}/metrics.jsonl`
const READ_LINES = 720 // 한 번에 훑을 tail 줄 수 (5초×720 = 1시간치)

interface MonitorState {
  deployed: boolean
  active: boolean
  timer: NodeJS.Timeout | null
  lastTs: number // 이미 렌더러로 보낸 마지막 샘플 시각(중복 방지)
}
const monitors = new Map<string, MonitorState>()
function getMonitor(id: string): MonitorState {
  let m = monitors.get(id)
  if (!m) {
    m = { deployed: false, active: false, timer: null, lastTs: 0 }
    monitors.set(id, m)
  }
  return m
}

// 앱 종료 시 서버 데몬을 kill 할지 여부 (렌더러 설정 → 종료 핸들러에서 사용)
let killDaemonOnExit = false

/** 에이전트 배포: 디렉터리 생성 → SFTP 업로드 → 실행권한 */
async function deployAgent(client: Client): Promise<{ ok: boolean; error?: string }> {
  try {
    await execCapture(client, `mkdir -p ${shQuote(AGENT_DIR)}`)
    const w = await sftpWriteDirect(client, AGENT_PATH, AGENT_SCRIPT)
    if (!w.ok) return { ok: false, error: w.error }
    await execCapture(client, `chmod 0755 ${shQuote(AGENT_PATH)}`)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: cleanErrorMessage(e) }
  }
}

/** 서버에 데몬이 살아있는지 확인 */
async function isDaemonRunning(client: Client): Promise<boolean> {
  try {
    const r = await execCapture(
      client,
      `[ -f ${shQuote(AGENT_PID)} ] && kill -0 $(cat ${shQuote(AGENT_PID)}) 2>/dev/null && echo up || echo down`,
    )
    return r.out.trim() === 'up'
  } catch {
    return false
  }
}

/** 데몬 기동 (nohup 으로 SSH 채널과 분리 → 연결 끊겨도 생존) */
async function startDaemon(client: Client, intervalSec: number): Promise<void> {
  await execCapture(
    client,
    `nohup bash ${shQuote(AGENT_PATH)} daemon ${intervalSec} </dev/null >/dev/null 2>&1 &`,
  )
}

/** 데몬 종료 (PID kill + 잔존 프로세스 정리) */
async function stopDaemon(client: Client): Promise<void> {
  await execCapture(
    client,
    `bash ${shQuote(AGENT_PATH)} stop 2>/dev/null; pkill -f 'collect.sh daemon' 2>/dev/null; true`,
  )
}


/** metrics.jsonl 증분 수거 — ts 가 새 것만 렌더러로 전달 */
async function readNewSamples(sessionId: string) {
  const m = monitors.get(sessionId)
  if (!m?.active) return
  const client = sessions.get(sessionId)?.client
  if (!client) return
  try {
    const r = await execCapture(client, `tail -n ${READ_LINES} ${shQuote(DATA_PATH)} 2>/dev/null`)
    for (const line of r.out.split('\n')) {
      const t = line.trim()
      if (!t) continue
      let sample: MetricSample
      try {
        sample = JSON.parse(t) as MetricSample
      } catch {
        continue // 쓰는 도중 잘린 줄은 건너뜀
      }
      if (sample.ts > m.lastTs) {
        m.lastTs = sample.ts
        mainWindow?.webContents.send('monitor:sample', { sessionId, sample })
      }
    }
  } catch (e) {
    mainWindow?.webContents.send('monitor:error', { sessionId, error: cleanErrorMessage(e) })
  }
}

/** 리더 루프 — 겹침 방지를 위해 setInterval 대신 자기재귀 setTimeout */
function monitorReaderLoop(sessionId: string, readMs: number) {
  const m = monitors.get(sessionId)
  if (!m?.active) return
  readNewSamples(sessionId).finally(() => {
    const cur = monitors.get(sessionId)
    if (cur?.active) cur.timer = setTimeout(() => monitorReaderLoop(sessionId, readMs), readMs)
  })
}

function stopMonitorReader(sessionId: string) {
  const m = monitors.get(sessionId)
  if (!m) return
  m.active = false
  if (m.timer) clearTimeout(m.timer)
  m.timer = null
}

// 수집 시작: 배포(필요시) → 데몬 기동(없으면) → 리더 시작
ipcMain.handle(
  'monitor:start',
  async (_evt, { sessionId, opts }: { sessionId: string; opts?: MonitorStartOptions }) => {
    const client = sessions.get(sessionId)?.client
    if (!client) return { ok: false, error: 'SSH 연결이 없습니다.' }
    const m = getMonitor(sessionId)
    if (!m.deployed) {
      const d = await deployAgent(client)
      if (!d.ok) return d
      m.deployed = true
    }
    const intervalSec = Math.max(2, Math.round((opts?.intervalMs ?? 5000) / 1000))
    const alreadyUp = await isDaemonRunning(client)
    if (!alreadyUp) await startDaemon(client, intervalSec)

    // 리더 (재)시작 — tail 로 최근 이력 자동 backfill
    m.lastTs = 0
    stopMonitorReader(sessionId)
    m.active = true
    monitorReaderLoop(sessionId, intervalSec * 1000)
    return { ok: true, resumed: alreadyUp }
  },
)

// 수집 완전 종료 (데몬까지 kill)
ipcMain.handle('monitor:stop', async (_evt, { sessionId }: { sessionId: string }) => {
  stopMonitorReader(sessionId)
  const client = sessions.get(sessionId)?.client
  if (client) await stopDaemon(client)
  return { ok: true }
})

// 특정 프로세스 kill (SIGTERM → 실패 시 SIGKILL)
ipcMain.handle(
  'monitor:killProc',
  async (_evt, { sessionId, pid }: { sessionId: string; pid: number }) => {
    const client = sessions.get(sessionId)?.client
    if (!client) return { ok: false, error: 'SSH 연결이 없습니다.' }
    try {
      await execCapture(client, `kill ${pid} 2>/dev/null || kill -9 ${pid} 2>/dev/null; true`)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: cleanErrorMessage(e) }
    }
  },
)

// 데몬 생존 여부 (재접속 직후 UI 표시용)
ipcMain.handle('monitor:status', async (_evt, { sessionId }: { sessionId: string }) => {
  const client = sessions.get(sessionId)?.client
  if (!client) return { running: false }
  return { running: await isDaemonRunning(client) }
})

// 앱 종료 시 데몬 kill 여부 설정 (렌더러에서 토글 변경 시 동기화)
ipcMain.on('monitor:setKillOnExit', (_evt, value: boolean) => {
  killDaemonOnExit = !!value
})

// ── 앱 라이프사이클 ────────────────────────────────────────────
app.whenReady().then(() => {
  createWindow()
  // 패키징된 빌드에서만 자동 업데이트 확인 (GitHub Releases 의 latest.yml 기준)
  if (app.isPackaged) {
    import('electron-updater')
      .then(({ autoUpdater }) => {
        autoUpdater.autoDownload = true
        autoUpdater.checkForUpdatesAndNotify().catch(() => {})
      })
      .catch(() => {})
  }
})

app.on('window-all-closed', async () => {
  // 옵션이 켜져 있으면, 연결을 정리하기 전에 살아있는 각 세션의 서버 데몬을 종료.
  if (killDaemonOnExit) {
    await Promise.all(
      [...sessions.values()]
        .filter((s) => s.client)
        .map((s) => stopDaemon(s.client!).catch(() => {})),
    )
  }
  // 모든 세션의 SSH 연결/로컬 셸 정리
  for (const s of sessions.values()) {
    cleanupConnection(s)
    killLocalShell(s)
  }
  sessions.clear()
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
