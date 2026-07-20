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
import { randomUUID } from 'node:crypto'
import { createWriteStream, type WriteStream } from 'node:fs'
import { writeFile, readFile, unlink, mkdir, stat, appendFile, readdir, rm } from 'node:fs/promises'
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
  type ProfileImportResult,
  type CustomPresetCommand,
  type CustomScenario,
  type LogIndexEntry,
  type LogRetentionSettings,
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
  /** 리플레이용 타이밍 기록 스트림 (log:start 와 함께 시작/종료, 앱 관리 폴더에 저장) */
  logCastStream?: WriteStream
  logId?: string
  logStartedAt?: number
  // ── 자동 재접속용 ──
  lastConfig?: SSHConfig // 마지막 접속 설정 (재접속에 재사용)
  wasConnected?: boolean // 쉘까지 한 번이라도 연결됐는지
  hadError?: boolean // 연결 중 오류(네트워크/keepalive) 발생 여부
  userClosed?: boolean // 사용자가 직접 끊었는지 (재접속 안 함)
  reconnecting?: boolean // 자동 재접속 루프 진행 중
  /** 실시간 로그 뷰어(tail -f) 채널 — 세션당 1개만 유지, 새로 시작하면 기존 것을 닫는다 */
  logTailStream?: ClientChannel
  logTailId?: string
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

/** 터미널 출력 → 렌더러 전송 + (로깅 중이면) 파일 기록 + (리플레이 녹화 중이면) 타이밍 포함 JSONL 기록 */
function pushOutput(s: Session, data: string) {
  mainWindow?.webContents.send('terminal:data', { sessionId: s.id, data })
  if (s.logStream) {
    try {
      s.logStream.write(data)
    } catch {
      /* 스트림 오류 무시 */
    }
  }
  if (s.logCastStream && s.logStartedAt !== undefined) {
    try {
      s.logCastStream.write(JSON.stringify({ t: Date.now() - s.logStartedAt, d: data }) + '\n')
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

// ─────────────────────────────────────────────────────────────
// 세션 로그 인덱스 — 로그 뷰어(목록/검색/리플레이)를 위한 메타데이터.
// 실제 평문 로그는 사용자가 고른 위치에, 리플레이용 타이밍 기록(.jsonl)은
// userData/session-logs 에 앱이 직접 관리한다.
// ─────────────────────────────────────────────────────────────
const logIndexPath = () => path.join(app.getPath('userData'), 'session-logs-index.json')
const logCastDir = () => path.join(app.getPath('userData'), 'session-logs')

async function readLogIndex(): Promise<LogIndexEntry[]> {
  try {
    const arr = JSON.parse(await readFile(logIndexPath(), 'utf-8'))
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}
async function writeLogIndex(list: LogIndexEntry[]): Promise<void> {
  await writeFile(logIndexPath(), JSON.stringify(list, null, 2), 'utf-8')
}
async function upsertLogIndex(entry: LogIndexEntry): Promise<void> {
  const list = await readLogIndex()
  const idx = list.findIndex((e) => e.id === entry.id)
  if (idx >= 0) list[idx] = entry
  else list.unshift(entry)
  await writeLogIndex(list)
}

// 세션 로그(.cast.jsonl)는 세션마다 하나씩 계속 쌓이므로, 보관기간과 개수 상한을 둘 다 넘는
// 항목은 자동으로 정리한다 — 기록 중인(아직 endedAt 없는) 세션은 건드리지 않는다.
// (평문 로그 파일은 사용자가 직접 고른 위치에 저장되므로 앱이 자동 삭제하지 않는다.)
// 기본값은 로그뷰어에서 사용자가 조회/변경 가능(logRetentionSettingsPath 에 저장).
const DEFAULT_LOG_RETENTION_DAYS = 30
const DEFAULT_LOG_MAX_ENTRIES = 50
const logRetentionSettingsPath = () => path.join(app.getPath('userData'), 'log-retention-settings.json')

async function readLogRetentionSettings(): Promise<LogRetentionSettings> {
  try {
    const raw = JSON.parse(await readFile(logRetentionSettingsPath(), 'utf-8'))
    const retentionDays = Number(raw.retentionDays)
    const maxEntries = Number(raw.maxEntries)
    return {
      retentionDays: Number.isFinite(retentionDays) && retentionDays > 0 ? retentionDays : DEFAULT_LOG_RETENTION_DAYS,
      maxEntries: Number.isFinite(maxEntries) && maxEntries > 0 ? maxEntries : DEFAULT_LOG_MAX_ENTRIES,
    }
  } catch {
    return { retentionDays: DEFAULT_LOG_RETENTION_DAYS, maxEntries: DEFAULT_LOG_MAX_ENTRIES }
  }
}
async function writeLogRetentionSettings(settings: LogRetentionSettings): Promise<void> {
  await writeFile(logRetentionSettingsPath(), JSON.stringify(settings, null, 2), 'utf-8')
}

ipcMain.handle('logs:getRetentionSettings', () => readLogRetentionSettings())
ipcMain.handle('logs:setRetentionSettings', async (_evt, settings: LogRetentionSettings) => {
  const clamped: LogRetentionSettings = {
    retentionDays: Math.max(1, Math.round(settings.retentionDays)),
    maxEntries: Math.max(1, Math.round(settings.maxEntries)),
  }
  await writeLogRetentionSettings(clamped)
  await trimSessionLogs()
  return clamped
})

async function trimSessionLogs(): Promise<void> {
  const { retentionDays, maxEntries } = await readLogRetentionSettings()
  const list = await readLogIndex()
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000
  const active = list.filter((e) => !e.endedAt)
  const finished = [...list.filter((e) => e.endedAt)].sort((a, b) => b.startedAt - a.startedAt)
  const kept: LogIndexEntry[] = []
  const dropped: LogIndexEntry[] = []
  finished.forEach((e, idx) => {
    if (idx < maxEntries && e.startedAt >= cutoff) kept.push(e)
    else dropped.push(e)
  })
  if (!dropped.length) return
  await Promise.all(dropped.map((e) => unlink(e.castPath).catch(() => {})))
  await writeLogIndex([...active, ...kept])
}

/** 스트림 종료 + 인덱스에 종료시각/파일크기 반영 (best-effort, 실패해도 세션 종료를 막지 않음) */
async function finalizeLogSession(s: Session): Promise<void> {
  const id = s.logId
  s.logCastStream?.end()
  s.logCastStream = undefined
  if (!id) return
  try {
    const list = await readLogIndex()
    const entry = list.find((e) => e.id === id)
    if (entry) {
      entry.endedAt = Date.now()
      try {
        entry.sizeBytes = (await stat(entry.castPath)).size
      } catch {
        /* 무시 */
      }
      await writeLogIndex(list)
    }
  } catch {
    /* 무시 */
  }
  void trimSessionLogs()
  s.logId = undefined
  s.logStartedAt = undefined
}

// 세션 로그 기록 시작 (저장 위치 선택) — 평문 로그 + 리플레이용 타이밍 기록을 함께 시작
ipcMain.handle(
  'log:start',
  async (_evt, { sessionId, host, label }: { sessionId: string; host?: string; label?: string }) => {
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

      const id = randomUUID()
      await mkdir(logCastDir(), { recursive: true })
      const castPath = path.join(logCastDir(), `${id}.cast.jsonl`)
      s.logCastStream = createWriteStream(castPath, { flags: 'a' })
      s.logId = id
      s.logStartedAt = Date.now()
      await upsertLogIndex({
        id,
        host: host || sessionId,
        label,
        path: r.filePath,
        castPath,
        startedAt: s.logStartedAt,
      })

      return { ok: true, path: r.filePath }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  },
)

// 세션 로그 기록 중지
ipcMain.handle('log:stop', async (_evt, { sessionId }: { sessionId: string }) => {
  const s = getSession(sessionId)
  if (s.logStream) {
    try {
      s.logStream.end(`\n===== 로그 종료 ${new Date().toISOString()} =====\n`)
    } catch {
      /* 무시 */
    }
    s.logStream = undefined
  }
  await finalizeLogSession(s)
  return { ok: true }
})

// 저장된 세션 로그 목록 (최신순)
ipcMain.handle('logs:list', async () => {
  const list = await readLogIndex()
  return [...list].sort((a, b) => b.startedAt - a.startedAt)
})

// 평문 로그 내용 읽기 (뷰어/검색용) — 너무 크면 앞부분만 잘라 반환
ipcMain.handle('logs:read', async (_evt, id: string) => {
  const entry = (await readLogIndex()).find((e) => e.id === id)
  if (!entry) return { ok: false, error: '로그를 찾을 수 없습니다.' }
  try {
    const MAX = 5 * 1024 * 1024 // 5MB
    const buf = await readFile(entry.path, 'utf-8')
    const truncated = buf.length > MAX
    return { ok: true, content: truncated ? buf.slice(0, MAX) : buf, truncated }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
})

// 리플레이용 타이밍 기록(JSONL) 읽기
ipcMain.handle('logs:readCast', async (_evt, id: string) => {
  const entry = (await readLogIndex()).find((e) => e.id === id)
  if (!entry) return { ok: false, error: '로그를 찾을 수 없습니다.' }
  try {
    const raw = await readFile(entry.castPath, 'utf-8')
    const frames = raw
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as { t: number; d: string }
        } catch {
          return null
        }
      })
      .filter((f): f is { t: number; d: string } => f !== null)
    return { ok: true, frames }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
})

// 세션 로그 삭제 (인덱스 + 리플레이 기록 파일. 사용자가 고른 평문 로그 원본은 남겨둠)
ipcMain.handle('logs:delete', async (_evt, id: string) => {
  const list = await readLogIndex()
  const entry = list.find((e) => e.id === id)
  if (entry) {
    try {
      await unlink(entry.castPath)
    } catch {
      /* 무시 */
    }
  }
  await writeLogIndex(list.filter((e) => e.id !== id))
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
  void finalizeLogSession(s)
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

// 분석 리포트를 PDF로 저장 — 렌더러가 만든 정적 HTML을 숨김 창에 로드 후 printToPDF (새 의존성 불필요)
ipcMain.handle(
  'report:savePdf',
  async (_evt, payload: { html: string; defaultName: string }) => {
    const result = await dialog.showSaveDialog(mainWindow!, {
      title: '분석 리포트 PDF로 저장',
      defaultPath: payload.defaultName,
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    })
    if (result.canceled || !result.filePath) {
      return { saved: false }
    }
    const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } })
    try {
      await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(payload.html))
      const pdf = await win.webContents.printToPDF({ printBackground: true, pageSize: 'A4' })
      await writeFile(result.filePath, pdf)
      return { saved: true, path: result.filePath }
    } catch (err) {
      return { saved: false, error: err instanceof Error ? err.message : String(err) }
    } finally {
      win.destroy()
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

// ── 프로필 가져오기(CSV/JSON) ────────────────────────────────────
//  - 업로드된 파일은 메모리에서만 파싱하며 어디에도 복사/로그하지 않는다.
//  - 결과로 반환되는 오류/경고 메시지에는 값이 아닌 필드명/행 번호만 담는다.

/** RFC4180 스타일 CSV 파서. 따옴표로 감싼 필드 내 콤마·줄바꿈·이스케이프된 큰따옴표("")를 지원 */
function parseCSV(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let i = 0
  const pushField = () => {
    row.push(field)
    field = ''
  }
  const pushRow = () => {
    pushField()
    rows.push(row)
    row = []
  }
  while (i < text.length) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        inQuotes = false
        i++
        continue
      }
      field += c
      i++
      continue
    }
    if (c === '"') {
      inQuotes = true
      i++
      continue
    }
    if (c === ',') {
      pushField()
      i++
      continue
    }
    if (c === '\r') {
      i++
      continue
    }
    if (c === '\n') {
      pushRow()
      i++
      continue
    }
    field += c
    i++
  }
  if (field.length > 0 || row.length > 0) pushRow()
  return rows.filter((r) => !(r.length === 1 && r[0] === ''))
}

/** CSV 헤더 + 한 행을 소문자 컬럼명 → 값 레코드로 변환 (컬럼 순서 무관) */
function csvRecordFromRow(header: string[], row: string[]): Record<string, string> {
  const rec: Record<string, string> = {}
  header.forEach((h, idx) => {
    const key = h.trim().toLowerCase()
    if (key) rec[key] = (row[idx] ?? '').trim()
  })
  return rec
}

/**
 * CSV/JSON 공통 검증·보정 — 필수 필드(host/port/username) 누락 시 error 반환.
 * authMethod 가 없거나 유효하지 않으면 privateKey/password 유무로 추론한다.
 */
function normalizeImportedProfile(
  raw: Record<string, unknown>,
  rowLabel: string,
): { profile?: SavedProfile; error?: string } {
  const host = typeof raw.host === 'string' ? raw.host.trim() : ''
  const port = raw.port === undefined || raw.port === null ? '' : String(raw.port).trim()
  const username = typeof raw.username === 'string' ? raw.username.trim() : ''
  if (!host || !port || !username) {
    return { error: `${rowLabel}: host/port/username 중 누락된 값이 있습니다.` }
  }
  const password = typeof raw.password === 'string' ? raw.password : ''
  const privateKey = typeof raw.privateKey === 'string' ? raw.privateKey : ''
  let authMethod = raw.authMethod
  if (authMethod !== 'password' && authMethod !== 'key' && authMethod !== 'agent') {
    authMethod = privateKey ? 'key' : password ? 'password' : 'agent'
  }
  const profile: SavedProfile = {
    host,
    port,
    username,
    authMethod: authMethod as SavedProfile['authMethod'],
    password,
    privateKey,
    passphrase: typeof raw.passphrase === 'string' ? raw.passphrase : '',
    label: typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : undefined,
    group: typeof raw.group === 'string' && raw.group.trim() ? raw.group.trim() : undefined,
    startup: typeof raw.startup === 'string' && raw.startup ? raw.startup : undefined,
    color: typeof raw.color === 'string' && raw.color.trim() ? raw.color.trim() : undefined,
    jump: raw.jump && typeof raw.jump === 'object' ? (raw.jump as SavedProfile['jump']) : undefined,
  }
  return { profile }
}

/** CSV 전용: keyPath 컬럼이 있으면 파일을 읽어 privateKey 로 채운다 (읽기 실패는 경고로만 처리) */
async function csvRowToProfile(
  rec: Record<string, string>,
  rowLabel: string,
): Promise<{ profile?: SavedProfile; error?: string; warning?: string }> {
  let privateKey = ''
  let warning: string | undefined
  // 앱이 내보낸 CSV 는 키 내용이 privateKey 컬럼에 그대로 들어있음 — 파일 경로(keyPath)보다 우선
  if (rec['privatekey']) {
    privateKey = rec['privatekey']
  } else {
    const keyPath = rec['keypath']
    if (keyPath) {
      try {
        privateKey = await readFile(keyPath, 'utf-8')
      } catch {
        warning = `${rowLabel}: 키 파일을 읽을 수 없습니다 (${keyPath}) — 개인키 없이 가져왔습니다.`
      }
    }
  }
  const { profile, error } = normalizeImportedProfile(
    {
      host: rec['host'],
      port: rec['port'],
      username: rec['username'],
      authMethod: rec['authmethod'],
      password: rec['password'],
      privateKey,
      passphrase: rec['passphrase'],
      label: rec['label'],
      group: rec['group'],
      startup: rec['startup'],
      color: rec['color'],
    },
    rowLabel,
  )
  return { profile, error, warning }
}

/** JSON 전용: 원소가 SavedProfile 필드와 1:1 대응한다고 가정, port 숫자값만 문자열로 보정 */
function jsonElementToProfile(raw: unknown, rowLabel: string): { profile?: SavedProfile; error?: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: `${rowLabel}: 객체가 아닙니다.` }
  }
  const r = raw as Record<string, unknown>
  return normalizeImportedProfile(
    { ...r, port: r.port === undefined || r.port === null ? '' : String(r.port) },
    rowLabel,
  )
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

// 로컬 디렉토리 재귀 업로드 (로컬 → 원격) — 원격에 같은 이름의 하위 트리를 그대로 재현
async function putDirRecursive(sftp: SFTPWrapper, localDir: string, remoteDir: string, sessionId: string) {
  await new Promise<void>((res) => sftp.mkdir(remoteDir, () => res())) // 이미 있으면 실패하지만 best-effort 로 무시
  for (const ent of await readdir(localDir, { withFileTypes: true })) {
    const lp = path.join(localDir, ent.name)
    const rp = rjoin(remoteDir, ent.name)
    if (ent.isDirectory()) await putDirRecursive(sftp, lp, rp, sessionId)
    else if (ent.isFile())
      await new Promise<void>((res, rej) =>
        sftp.fastPut(lp, rp, { step: (t, _c, tot) => sendProgress(sessionId, ent.name, t, tot) }, (e) =>
          e ? rej(e) : res(),
        ),
      )
  }
}

// 로컬 파일 탐색기(듀얼패인 좌측) — 지정 경로 목록, 없으면 홈 디렉토리
ipcMain.handle('local:list', async (_evt, { path: dirPath }: { path?: string }) => {
  try {
    const cwd = dirPath && dirPath.length ? dirPath : os.homedir()
    const list = await readdir(cwd, { withFileTypes: true })
    const entries = await Promise.all(
      list.map(async (ent) => {
        const full = path.join(cwd, ent.name)
        const type = ent.isDirectory() ? ('dir' as const) : ent.isSymbolicLink() ? ('link' as const) : ('file' as const)
        try {
          const st = await stat(full)
          return { name: ent.name, path: full, type, size: st.size, mtime: Math.floor(st.mtimeMs / 1000) }
        } catch {
          return { name: ent.name, path: full, type, size: 0, mtime: 0 }
        }
      }),
    )
    entries.sort((a, b) => {
      if (a.type === 'dir' && b.type !== 'dir') return -1
      if (a.type !== 'dir' && b.type === 'dir') return 1
      return a.name.localeCompare(b.name)
    })
    return { ok: true, path: cwd, parent: path.dirname(cwd), entries }
  } catch (e) {
    return { ok: false, error: errMsg(e) }
  }
})

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

// 원격 디렉토리 트리 전체에서 파일명 재귀 검색(대소문자 무시 부분일치) — 너무 커지면 멈추도록
// 스캔 개수/결과 개수 모두 상한을 둔다. 권한 없어 못 여는 하위 폴더는 건너뛰고 계속 진행.
const SFTP_SEARCH_SCAN_LIMIT = 20000
const SFTP_SEARCH_MAX_RESULTS = 500
ipcMain.handle(
  'sftp:search',
  async (_evt, { sessionId, root, query }: { sessionId: string; root: string; query: string }) => {
    const s = getSession(sessionId)
    if (!s.client) return { ok: false, error: '연결되어 있지 않습니다.' }
    const q = query.trim().toLowerCase()
    if (!q) return { ok: true, results: [], truncated: false }
    try {
      const sftp = await getSftp(s)
      const results: { path: string; name: string; type: 'dir' | 'file' | 'link' }[] = []
      let scanned = 0
      let truncated = false
      const walk = async (dir: string): Promise<void> => {
        if (truncated) return
        let entries: import('ssh2').FileEntry[]
        try {
          entries = await sftpReaddir(sftp, dir)
        } catch {
          return // 권한 없음 등은 건너뜀
        }
        for (const it of entries) {
          if (truncated) return
          if (it.filename === '.' || it.filename === '..') continue
          scanned++
          if (scanned > SFTP_SEARCH_SCAN_LIMIT) {
            truncated = true
            return
          }
          const lead = it.longname?.[0]
          const type = lead === 'd' ? ('dir' as const) : lead === 'l' ? ('link' as const) : ('file' as const)
          const full = rjoin(dir, it.filename)
          if (it.filename.toLowerCase().includes(q)) {
            results.push({ path: full, name: it.filename, type })
            if (results.length >= SFTP_SEARCH_MAX_RESULTS) {
              truncated = true
              return
            }
          }
          if (type === 'dir') await walk(full)
        }
      }
      await walk(root)
      return { ok: true, results, truncated }
    } catch (e) {
      return { ok: false, error: errMsg(e) }
    }
  },
)

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
        const st = await stat(lp)
        if (st.isDirectory()) await putDirRecursive(sftp, lp, rjoin(remoteDir, base), sessionId)
        else
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

// 다중 선택 일괄 다운로드 (원격 → 지정된 로컬 폴더, 대화상자 없음 — 듀얼패인에서 사용)
ipcMain.handle(
  'sftp:downloadPaths',
  async (
    _evt,
    {
      sessionId,
      items,
      localDir,
    }: { sessionId: string; items: { path: string; name: string; isDir: boolean }[]; localDir: string },
  ) => {
    const s = getSession(sessionId)
    if (!s.client) return { ok: false, error: '연결되어 있지 않습니다.' }
    try {
      const sftp = await getSftp(s)
      const downloaded: string[] = []
      for (const it of items) {
        const lc = path.join(localDir, it.name)
        if (it.isDir) await getDirRecursive(sftp, it.path, lc)
        else
          await new Promise<void>((res, rej) =>
            sftp.fastGet(it.path, lc, { step: (t, _c, tot) => sendProgress(sessionId, it.name, t, tot) }, (e) =>
              e ? rej(e) : res(),
            ),
          )
        downloaded.push(it.name)
      }
      return { ok: true, downloaded }
    } catch (e) {
      return { ok: false, error: errMsg(e) }
    }
  },
)

// 다중 선택 일괄 삭제 (원격)
ipcMain.handle(
  'sftp:deletePaths',
  async (_evt, { sessionId, items }: { sessionId: string; items: { path: string; isDir: boolean }[] }) => {
    const s = getSession(sessionId)
    try {
      const sftp = await getSftp(s)
      for (const it of items) await rmrf(sftp, it.path, it.isDir)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: errMsg(e) }
    }
  },
)

// 세션 간(원격→원격) 직접 전송 — 진짜 SFTP-to-SFTP 스트리밍 primitive 는 없어서, OS 임시 폴더를
// 경유해 "원본에서 다운로드 → 대상에 업로드" 두 단계로 처리한다(기존 fastGet/fastPut·재귀 함수 재사용).
ipcMain.handle(
  'sftp:relayTransfer',
  async (
    _evt,
    {
      fromSessionId,
      toSessionId,
      items,
      toDir,
    }: {
      fromSessionId: string
      toSessionId: string
      items: { path: string; name: string; isDir: boolean }[]
      toDir: string
    },
  ) => {
    const fromS = getSession(fromSessionId)
    const toS = getSession(toSessionId)
    if (!fromS.client) return { ok: false, error: '원본 세션이 연결되어 있지 않습니다.' }
    if (!toS.client) return { ok: false, error: '대상 세션이 연결되어 있지 않습니다.' }
    const tmpRoot = path.join(os.tmpdir(), `ivk-relay-${randomUUID()}`)
    try {
      await mkdir(tmpRoot, { recursive: true })
      const fromSftp = await getSftp(fromS)
      const toSftp = await getSftp(toS)
      const transferred: string[] = []
      for (const it of items) {
        const tmpLocal = path.join(tmpRoot, it.name)
        if (it.isDir) {
          await getDirRecursive(fromSftp, it.path, tmpLocal)
          await putDirRecursive(toSftp, tmpLocal, rjoin(toDir, it.name), toSessionId)
        } else {
          await new Promise<void>((res, rej) =>
            fromSftp.fastGet(
              it.path,
              tmpLocal,
              { step: (t, _c, tot) => sendProgress(fromSessionId, `${it.name} (받는 중)`, t, tot) },
              (e) => (e ? rej(e) : res()),
            ),
          )
          await new Promise<void>((res, rej) =>
            toSftp.fastPut(
              tmpLocal,
              rjoin(toDir, it.name),
              { step: (t, _c, tot) => sendProgress(toSessionId, `${it.name} (보내는 중)`, t, tot) },
              (e) => (e ? rej(e) : res()),
            ),
          )
        }
        transferred.push(it.name)
      }
      return { ok: true, transferred }
    } catch (e) {
      return { ok: false, error: errMsg(e) }
    } finally {
      rm(tmpRoot, { recursive: true, force: true }).catch(() => {})
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
// 자동 저장(연결 시 SSHForm)은 label/group/jump/startup 을 안 주므로, 기존에 지정된
// 값이 있으면 보존한다(preserveMeta, 기본값 true). 반면 사이드바 편집 모달의 명시적
// 저장은 preserveMeta:false 로 호출해, 사용자가 필드를 일부러 비웠을 때 그대로 반영한다.
ipcMain.handle(
  'profiles:upsert',
  async (_evt, profile: SavedProfile, opts?: { preserveMeta?: boolean }) => {
    const preserveMeta = opts?.preserveMeta ?? true
    const all = await readProfiles()
    const idx = all.findIndex((p) => profileKey(p) === profileKey(profile))
    const existing = idx >= 0 ? all[idx] : undefined
    const merged: SavedProfile = preserveMeta
      ? {
          ...profile,
          label: profile.label ?? existing?.label,
          group: profile.group ?? existing?.group,
          jump: profile.jump ?? existing?.jump,
          startup: profile.startup ?? existing?.startup,
        }
      : { ...profile }
    // 기존 프로필은 사이드바에서 드래그로 정한 순서를 그대로 유지한 채 갱신 (자동 저장 때문에 순서가 흐트러지지 않도록)
    const list = [...all]
    if (idx >= 0) list[idx] = merged
    else list.unshift(merged) // 신규 프로필만 맨 앞에 추가
    await writeProfiles(list)
    return list
  },
)

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
// 사용자 정의 프리셋 / 시나리오
//  - 내장 PRESETS/SCENARIOS(src/presets.ts, src/scenarios.ts)는 코드에 하드코딩되어
//    빌드 없이는 추가할 수 없음 → 런타임에 추가/편집 가능한 목록을 별도 JSON 파일로 관리하고,
//    렌더러에서 내장 목록과 병합해 표시한다. 비밀정보가 아니므로 암호화하지 않음.
// ─────────────────────────────────────────────────────────────

const customPresetsPath = () => path.join(app.getPath('userData'), 'custom-presets.json')
const customScenariosPath = () => path.join(app.getPath('userData'), 'custom-scenarios.json')

async function readCustomPresets(): Promise<CustomPresetCommand[]> {
  try {
    const arr = JSON.parse(await readFile(customPresetsPath(), 'utf-8'))
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}
async function writeCustomPresets(list: CustomPresetCommand[]): Promise<void> {
  await writeFile(customPresetsPath(), JSON.stringify(list, null, 2), 'utf-8')
}
async function readCustomScenarios(): Promise<CustomScenario[]> {
  try {
    const arr = JSON.parse(await readFile(customScenariosPath(), 'utf-8'))
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}
async function writeCustomScenarios(list: CustomScenario[]): Promise<void> {
  await writeFile(customScenariosPath(), JSON.stringify(list, null, 2), 'utf-8')
}

ipcMain.handle('customPresets:list', async () => readCustomPresets())
ipcMain.handle('customPresets:upsert', async (_evt, item: CustomPresetCommand) => {
  const list = await readCustomPresets()
  const isNew = !item.id || !list.some((p) => p.id === item.id)
  // 신규 항목은 생성 시각을 기본 순서로 사용 — 내장 명령어는 배열 인덱스(작은 정수)를 암묵적
  // 순서로 쓰므로, 훨씬 큰 타임스탬프 값이면 자연히 맨 뒤로 붙는다. 위치 이동은 order 값을
  // 직접 지정해서 다시 upsert 하는 방식으로 처리(별도 재정렬 API 불필요).
  const withId: CustomPresetCommand = {
    ...item,
    id: item.id || randomUUID(),
    order: item.order ?? (isNew ? Date.now() : undefined),
  }
  const idx = list.findIndex((p) => p.id === withId.id)
  if (idx >= 0) list[idx] = withId
  else list.push(withId)
  await writeCustomPresets(list)
  return list
})
ipcMain.handle('customPresets:delete', async (_evt, id: string) => {
  const list = (await readCustomPresets()).filter((p) => p.id !== id)
  await writeCustomPresets(list)
  return list
})

ipcMain.handle('customScenarios:list', async () => readCustomScenarios())
ipcMain.handle('customScenarios:upsert', async (_evt, item: CustomScenario) => {
  const list = await readCustomScenarios()
  const isNew = !item.id || !list.some((s) => s.id === item.id)
  const withId: CustomScenario = {
    ...item,
    id: item.id || randomUUID(),
    order: item.order ?? (isNew ? Date.now() : undefined),
  }
  const idx = list.findIndex((s) => s.id === withId.id)
  if (idx >= 0) list[idx] = withId
  else list.push(withId)
  await writeCustomScenarios(list)
  return list
})
ipcMain.handle('customScenarios:delete', async (_evt, id: string) => {
  const list = (await readCustomScenarios()).filter((s) => s.id !== id)
  await writeCustomScenarios(list)
  return list
})

// CSV/JSON 파일에서 세션 프로필 일괄 가져오기 — 사이드바 목록에 추가만 하며 자동 연결은 하지 않는다.
// 기존 프로필과 host:port:username 이 겹치거나 같은 파일 내에서 중복되면 건너뛴다.
ipcMain.handle('profiles:import', async (): Promise<ProfileImportResult> => {
  const r = await dialog.showOpenDialog(mainWindow ?? undefined!, {
    properties: ['openFile'],
    title: '세션 프로필 가져오기 (CSV/JSON)',
    filters: [{ name: 'CSV/JSON', extensions: ['csv', 'json'] }],
  })
  if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true }
  const filePath = r.filePaths[0]

  let text: string
  try {
    text = await readFile(filePath, 'utf-8')
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }

  const errors: string[] = []
  const warnings: string[] = []
  const candidates: SavedProfile[] = []
  const ext = filePath.toLowerCase().split('.').pop()

  if (ext === 'json') {
    let arr: unknown
    try {
      arr = JSON.parse(text)
    } catch (e) {
      return { ok: false, error: `JSON 파싱 실패: ${e instanceof Error ? e.message : String(e)}` }
    }
    if (!Array.isArray(arr)) return { ok: false, error: 'JSON 최상위 값은 배열이어야 합니다.' }
    arr.forEach((el, idx) => {
      const host = el && typeof el === 'object' ? (el as Record<string, unknown>).host : undefined
      if (typeof host === 'string' && host.startsWith('#')) return // 안내용 예시 항목은 건너뜀
      const { profile, error } = jsonElementToProfile(el, `${idx + 1}번째 항목`)
      if (error) errors.push(error)
      else if (profile) candidates.push(profile)
    })
  } else {
    const rows = parseCSV(text)
    if (!rows.length) return { ok: false, error: 'CSV 파일에 내용이 없습니다.' }
    const header = rows[0]
    for (let i = 1; i < rows.length; i++) {
      const rowLabel = `${i + 1}행`
      const rec = csvRecordFromRow(header, rows[i])
      if (Object.values(rec).every((v) => !v)) continue // 완전히 빈 행은 건너뜀
      if (rec['host']?.startsWith('#')) continue // 예시/안내 행(내보내기·템플릿에 포함)은 건너뜀
      const { profile, error, warning } = await csvRowToProfile(rec, rowLabel)
      if (error) errors.push(error)
      else if (profile) candidates.push(profile)
      if (warning) warnings.push(warning)
    }
  }

  const existing = await readProfiles()
  const seen = new Set(existing.map(profileKey))
  const added: SavedProfile[] = []
  let skippedCount = 0
  for (const profile of candidates) {
    const key = profileKey(profile)
    if (seen.has(key)) {
      skippedCount++
      continue
    }
    seen.add(key)
    added.push(profile)
  }

  const list = added.length ? [...existing, ...added] : existing
  if (added.length) await writeProfiles(list)

  return {
    ok: true,
    addedCount: added.length,
    skippedCount,
    errorCount: errors.length,
    warnings,
    errors,
    list,
  }
})

const CSV_IMPORT_TEMPLATE =
  'host,port,username,authMethod,password,keyPath,label,group\n' +
  '#예시,22(기본 SSH 포트),접속계정,password 또는 key,password 방식이면 비밀번호 입력,key 방식이면 개인키 "파일 경로" 입력,화면에 표시할 별칭(선택),묶어볼 그룹명(선택)\n' +
  '203.0.113.10,22,admin,password,mypassword,,Node1,Prod\n' +
  '203.0.113.11,22,deploy,key,,C:\\Users\\me\\.ssh\\id_rsa,Node2,Prod\n'

// host 가 '#' 로 시작하는 항목은 안내용 예시일 뿐이며 CSV/JSON 가져오기 시 자동으로 건너뛴다.
const JSON_GUIDE_ENTRY = {
  host: '#예시 — 실제로 가져오지 않음',
  port: '22 (기본 SSH 포트)',
  username: '접속계정',
  authMethod: 'password 또는 key 또는 agent',
  password: 'password 방식이면 비밀번호',
  privateKey: 'key 방식이면 개인키 전체 내용',
  passphrase: '개인키 암호(선택)',
  label: '화면에 표시할 별칭(선택)',
  group: '묶어볼 그룹명(선택)',
  startup: '접속 후 자동 실행할 명령어(선택)',
  color: '태그 색상 hex 예: #22c55e(선택)',
}

const JSON_IMPORT_TEMPLATE = JSON.stringify(
  [
    JSON_GUIDE_ENTRY,
    {
      host: '203.0.113.10',
      port: '22',
      username: 'admin',
      authMethod: 'password',
      password: 'mypassword',
      label: 'Node1',
      group: 'Prod',
    },
    {
      host: '203.0.113.11',
      port: '22',
      username: 'deploy',
      authMethod: 'password',
      password: 'mypassword2',
      label: 'Node2',
      group: 'Prod',
    },
  ],
  null,
  2,
)

// 엑셀은 BOM 없는 UTF-8 텍스트를 시스템 로케일(한글 Windows는 CP949)로 오인해 한글을 깨뜨리므로 BOM을 붙인다.
const BOM = '﻿'

// 가져오기 양식 예시 파일 저장 (사용자가 업로드 전에 형식을 확인/채워넣을 수 있도록)
ipcMain.handle('profiles:saveTemplate', async (_evt, format: 'csv' | 'json') => {
  const isCsv = format === 'csv'
  const r = await dialog.showSaveDialog(mainWindow ?? undefined!, {
    title: '세션 프로필 가져오기 템플릿 저장',
    defaultPath: isCsv ? 'session-profiles-template.csv' : 'session-profiles-template.json',
    filters: [{ name: isCsv ? 'CSV' : 'JSON', extensions: [isCsv ? 'csv' : 'json'] }],
  })
  if (r.canceled || !r.filePath) return { saved: false }
  try {
    await writeFile(r.filePath, BOM + (isCsv ? CSV_IMPORT_TEMPLATE : JSON_IMPORT_TEMPLATE), 'utf-8')
    return { saved: true, path: r.filePath }
  } catch (e) {
    return { saved: false, error: e instanceof Error ? e.message : String(e) }
  }
})

/** RFC4180 스타일 CSV 필드 이스케이프 — 콤마/줄바꿈/큰따옴표 포함 시 따옴표로 감싸고 내부 따옴표는 중복 */
function csvEscape(v: string): string {
  if (/[",\n\r]/.test(v)) return '"' + v.replace(/"/g, '""') + '"'
  return v
}

// 현재 저장된 전체 프로필을 CSV/JSON 으로 내보내기 — 가져오기와 동일한 컬럼 구조라 다시 가져올 수 있음.
// 개인키/비밀번호가 평문으로 포함되므로 파일 취급에 주의하라고 렌더러에서 안내한다.
ipcMain.handle('profiles:export', async (_evt, format: 'csv' | 'json') => {
  const isCsv = format === 'csv'
  const stamp = new Date().toISOString().slice(0, 10)
  const r = await dialog.showSaveDialog(mainWindow ?? undefined!, {
    title: '세션 프로필 내보내기',
    defaultPath: isCsv ? `session-profiles-${stamp}.csv` : `session-profiles-${stamp}.json`,
    filters: [{ name: isCsv ? 'CSV' : 'JSON', extensions: [isCsv ? 'csv' : 'json'] }],
  })
  if (r.canceled || !r.filePath) return { saved: false }
  try {
    const list = await readProfiles()
    if (isCsv) {
      const header = ['host', 'port', 'username', 'authMethod', 'password', 'privateKey', 'passphrase', 'label', 'group', 'startup', 'color']
      // 각 컬럼에 어떤 값을 넣는지 보여주는 안내 행 — host 가 '#' 로 시작하면 가져오기 시 건너뛴다.
      const guideRow = [
        '#예시',
        '22(기본 SSH 포트)',
        '접속계정',
        'password 또는 key 또는 agent',
        'password 방식이면 비밀번호',
        'key 방식이면 개인키 전체 내용',
        '개인키 암호(선택)',
        '화면에 표시할 별칭(선택)',
        '묶어볼 그룹명(선택)',
        '접속 후 자동 실행할 명령어(선택)',
        '태그 색상 hex 예: #22c55e(선택)',
      ].map(csvEscape)
      const rows = list.map((p) =>
        header.map((h) => csvEscape(String((p as unknown as Record<string, unknown>)[h] ?? ''))).join(','),
      )
      await writeFile(r.filePath, BOM + [header.join(','), guideRow.join(','), ...rows].join('\n') + '\n', 'utf-8')
    } else {
      await writeFile(r.filePath, BOM + JSON.stringify([JSON_GUIDE_ENTRY, ...list], null, 2), 'utf-8')
    }
    return { saved: true, path: r.filePath, count: list.length }
  } catch (e) {
    return { saved: false, error: e instanceof Error ? e.message : String(e) }
  }
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

// ── 실시간 로그 뷰어 (tail -f) ──────────────────────────────────
// 일반 exec(execCapture)는 종료(close)돼야 resolve 되므로 tail -f 처럼 끝나지 않는 명령엔 못 쓴다.
// 채널을 계속 열어두고 데이터가 올 때마다 logtail:data 이벤트로 흘려보내는 전용 스트리밍 실행기.
ipcMain.handle(
  'logtail:start',
  async (
    _evt,
    { sessionId, path: filePath, sudoPassword }: { sessionId: string; path: string; sudoPassword?: string },
  ) => {
    const s = getSession(sessionId)
    const client = s.client
    if (!client) return { ok: false, error: '연결되어 있지 않습니다.' }
    // 같은 세션에서 이전에 보던 tail 이 있으면 먼저 정리(세션당 하나만 유지)
    if (s.logTailStream) {
      try {
        s.logTailStream.close()
      } catch {
        /* 무시 */
      }
      s.logTailStream = undefined
      s.logTailId = undefined
    }
    const tailId = randomUUID()
    const q = shQuote(filePath)
    const usePty = !!sudoPassword
    const cmd = usePty ? `sudo -S -p '' tail -f -n 200 ${q}` : `tail -f -n 200 ${q}`

    return new Promise<{ ok: boolean; tailId?: string; needSudoPassword?: boolean; error?: string }>((resolve) => {
      const onStream = (err: Error | undefined, stream: ClientChannel) => {
        if (err) return resolve({ ok: false, error: err.message })
        let earlyText = '' // 시작 후 잠깐(grace) 동안의 출력 — 즉시 실패(권한없음/파일없음) 판별용
        let settled = false
        const forward = (data: string) => {
          mainWindow?.webContents.send('logtail:data', { sessionId, tailId, data })
        }
        stream.on('data', (d: Buffer) => {
          const text = d.toString('utf-8')
          if (!settled) earlyText += text
          else forward(text)
        })
        if (!usePty) {
          // PTY 모드는 stdout/stderr 가 한 스트림으로 합쳐지므로 별도 처리 불필요
          stream.stderr.on('data', (d: Buffer) => {
            const text = d.toString('utf-8')
            if (!settled) earlyText += text
            else forward(text)
          })
        }
        stream.on('close', () => {
          if (s.logTailStream === stream) {
            s.logTailStream = undefined
            s.logTailId = undefined
          }
          if (!settled) {
            settled = true
            if (/permission denied/i.test(earlyText)) resolve({ ok: false, needSudoPassword: true })
            else resolve({ ok: false, error: earlyText.trim() || '로그 스트림이 즉시 종료되었습니다.' })
            return
          }
          mainWindow?.webContents.send('logtail:closed', { sessionId, tailId })
        })
        // grace 기간 동안 안 죽고 살아있으면 정상적으로 흐르고 있는 것으로 간주
        setTimeout(() => {
          if (settled) return
          settled = true
          s.logTailStream = stream
          s.logTailId = tailId
          if (earlyText) forward(earlyText) // 오류가 아니었으므로 grace 기간 중 출력도 그대로 전달
          resolve({ ok: true, tailId })
        }, 700)
      }
      if (usePty) client.exec(cmd, { pty: true }, onStream)
      else client.exec(cmd, onStream)
    })
  },
)

ipcMain.handle('logtail:stop', async (_evt, { sessionId }: { sessionId: string }) => {
  const s = getSession(sessionId)
  if (s.logTailStream) {
    try {
      s.logTailStream.close()
    } catch {
      /* 무시 */
    }
    s.logTailStream = undefined
    s.logTailId = undefined
  }
  return { ok: true }
})

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

// ── 모니터링 이력 장기 보관 (앱 로컬) ──────────────────────────
// 서버 데몬은 최근 1시간치만 들고 있어(READ_LINES 제한), 그 이상의 추세 비교를 위해
// 앱이 호스트별로 수신한 샘플을 로컬 JSONL 로 누적 저장한다. 파일이 무한정 커지지
// 않도록 일정 주기마다 보관기간(7일)이 지난 샘플을 잘라낸다.
const METRICS_HISTORY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const metricsHistoryDir = () => path.join(app.getPath('userData'), 'metrics-history')
const sanitizeHost = (host: string) => host.replace(/[^a-zA-Z0-9.-]/g, '_')
const metricsHistoryPath = (host: string) => path.join(metricsHistoryDir(), `${sanitizeHost(host)}.jsonl`)
const historyAppendCounts = new Map<string, number>()

async function trimMetricsHistory(host: string): Promise<void> {
  const p = metricsHistoryPath(host)
  try {
    const raw = await readFile(p, 'utf-8')
    const cutoff = (Date.now() - METRICS_HISTORY_RETENTION_MS) / 1000
    const kept = raw
      .split('\n')
      .filter(Boolean)
      .filter((line) => {
        try {
          return (JSON.parse(line) as MetricSample).ts >= cutoff
        } catch {
          return false
        }
      })
    await writeFile(p, kept.length ? kept.join('\n') + '\n' : '', 'utf-8')
  } catch {
    /* 파일 없음 등은 무시 */
  }
}

/** 실패해도 실시간 모니터링에 영향 없도록 best-effort 로 로컬 이력에 추가 */
async function appendMetricsHistory(sample: MetricSample): Promise<void> {
  try {
    await mkdir(metricsHistoryDir(), { recursive: true })
    await appendFile(metricsHistoryPath(sample.host), JSON.stringify(sample) + '\n', 'utf-8')
    const n = (historyAppendCounts.get(sample.host) ?? 0) + 1
    historyAppendCounts.set(sample.host, n)
    if (n % 200 === 0) await trimMetricsHistory(sample.host)
  } catch {
    /* 무시 */
  }
}

// 호스트의 로컬 저장 이력 조회 (기간 지정, ms) — Dashboard 의 6h/24h/7d 범위 선택용
ipcMain.handle('monitor:history', async (_evt, { host, sinceMs }: { host: string; sinceMs: number }) => {
  try {
    const raw = await readFile(metricsHistoryPath(host), 'utf-8')
    const cutoff = sinceMs / 1000
    const samples = raw
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as MetricSample
        } catch {
          return null
        }
      })
      .filter((s): s is MetricSample => s !== null && s.ts >= cutoff)
    return { ok: true, samples }
  } catch {
    return { ok: true, samples: [] as MetricSample[] }
  }
})

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
        void appendMetricsHistory(sample)
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

// 전체 프로세스 목록(온디맨드) — 상시 데몬(top-10 폴링)과 무관하게, 사용자가 프로세스 뷰를
// 열었을 때만 한 번 더 fresh 하게 조회한다. 상시 오버헤드를 늘리지 않기 위해 폴링 주기에는 넣지 않음.
ipcMain.handle('monitor:listProcesses', async (_evt, { sessionId }: { sessionId: string }) => {
  const client = sessions.get(sessionId)?.client
  if (!client) return { ok: false, error: 'SSH 연결이 없습니다.' }
  try {
    // comm 대신 args 로 전체 명령행까지 확보 — 마지막 필드라 공백 포함해도 split 개수만 맞춰주면 됨
    const r = await execCapture(
      client,
      `ps -eo pid=,comm=,pcpu=,pmem=,args= --sort=-%cpu 2>/dev/null | head -n 300`,
    )
    const procs = r.out
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const m = line.match(/^(\d+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)\s+(.*)$/)
        if (!m) return null
        return { pid: Number(m[1]), name: m[2], cpu: Number(m[3]), mem: Number(m[4]), command: m[5] }
      })
      .filter((p): p is { pid: number; name: string; cpu: number; mem: number; command: string } => !!p)
    return { ok: true, procs }
  } catch (e) {
    return { ok: false, error: cleanErrorMessage(e) }
  }
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
  void trimSessionLogs()
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
