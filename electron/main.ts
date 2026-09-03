import {
  app,
  BrowserWindow,
  Notification,
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
import { spawn, type ChildProcess } from 'node:child_process'
import { writeFile, readFile, unlink, mkdir, stat, appendFile, readdir, rm, copyFile, rename, open } from 'node:fs/promises'
// 스트림 청크 경계에서 멀티바이트(한글) 문자가 잘려 �로 깨지는 것을 막는다
import { StringDecoder } from 'node:string_decoder'
import { Client, type ClientChannel, type SFTPWrapper } from 'ssh2'
import * as pty from 'node-pty'
import { streamChat, listModels } from './ai-providers'
import { AGENT_SCRIPT } from './agent-script'
import { portalRequest } from './portal-http'
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
  type CustomScenarioStep,
  type CustomItemsBundle,
  type CustomItemsImportResult,
  type ConfigMapRef,
  type ConfigMapDetail,
  type ConfigMapPatchResult,
  type ConfigMapBackup,
  type CmBackupOrigin,
  type CommandCheck,
  type CaptureRule,
  type OnFailureAction,
  type LogIndexEntry,
  type LogEntryDetail,
  type PerfEnvStatus,
  type PerfRunConfig,
  type PerfRunMeta,
  type PerfRunRecord,
  type LogRetentionSettings,
  type LogTailTarget,
  type ExpectRule,
  type PortalConfig,
  type PortalHttpResult,
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
  /**
   * 연결 세대 번호. ssh:connect(사용자가 이 칸에 새로 접속) 때마다 증가시킨다.
   * 자동 재접속 루프는 시작 시점의 값을 들고 있다가 매 단계에서 비교해, 값이 달라졌으면
   * (=사용자가 그 사이 다른 서버로 붙었으면) 즉시 중단한다. 없으면 백오프 대기가 끝난 루프가
   * 사용자가 방금 연결한 세션을 끊고 '예전 호스트'로 갈아치운다 — 화면 표시와 실제 접속 서버가
   * 어긋나는 가장 위험한 상황.
   */
  connectEpoch?: number
  /** 실시간 로그 뷰어(tail -f / kubectl logs -f) 채널들 — tailId 로 구분해 세션당 여러 개
   *  동시에 유지 가능(듀얼 패널에서 같은 세션의 다른 로그 두 개를 동시에 볼 수 있도록). */
  logTailStreams?: Map<string, ClientChannel>
  /** 렌더러 xterm 이 보고한 최신 PTY 크기 — SSH 셸을 열 때 초기 크기로 사용해야
   *  원격 화면이 실제 터미널 크기와 맞는다(안 그러면 기본 80x24 로 열려 vi 등이 반토막 남). */
  ptySize?: { cols: number; rows: number }
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
    // 이전(원격) 세션의 프롬프트 잔상이 로컬 셸 배너와 겹쳐 보이지 않도록 화면+스크롤백을 지운 뒤,
    // 지금 입력이 원격이 아니라 내 PC에서 실행됨을 명확히 알리는 경고 배너를 먼저 출력한다.
    mainWindow?.webContents.send('terminal:data', {
      sessionId: s.id,
      data:
        '\x1b[2J\x1b[3J\x1b[H' +
        '\x1b[1;33m*** 로컬 셸로 전환됨 — 원격 아님. 명령은 내 PC에서 실행됩니다 ***\x1b[0m\r\n',
    })
    s.localPty = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: s.ptySize?.cols ?? 80,
      rows: s.ptySize?.rows ?? 24,
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

// 파일은 있는데 못 읽은 상태. 이때 빈 맵을 저장해 버리면 지금까지 신뢰한 호스트 키가 전부
// 사라지고(= 호스트 키 변경/중간자 경고가 조용히 꺼짐), 원본 파일까지 덮여 복구도 불가능하다.
// 그래서 이 상태에서는 '읽기 실패'를 기억해 두고 저장을 아예 하지 않는다.
let knownHostsLoadFailed = false

async function loadKnownHosts(): Promise<Record<string, string>> {
  if (knownHosts) return knownHosts
  let raw: string | null = null
  try {
    raw = await readFile(knownHostsPath(), 'utf-8')
  } catch {
    raw = null // 파일 없음 = 최초 실행 (정상)
  }
  if (raw === null) {
    knownHosts = {}
    return knownHosts
  }
  try {
    const json = decryptStr(raw)
    if (!json) throw new Error('복호화 불가')
    knownHosts = JSON.parse(json) as Record<string, string>
  } catch (e) {
    knownHostsLoadFailed = true
    knownHosts = {}
    console.warn(
      '[ssh] known-hosts 를 읽지 못했습니다. 이번 실행에서는 호스트 키를 저장하지 않습니다(기존 파일 보존):',
      e,
    )
  }
  return knownHosts
}

/** 원자적 + 직렬화 저장. 동시에 여러 세션이 접속하면 예전엔 같은 파일에 병렬로 써서 깨졌다. */
function saveKnownHosts() {
  if (!knownHosts || knownHostsLoadFailed) return // 읽기 실패 상태면 기존 파일을 덮지 않는다
  const snapshot = JSON.stringify(knownHosts)
  void withStoreLock('knownHosts', () => writeFileAtomic(knownHostsPath(), encryptStr(snapshot))).catch((e) =>
    console.warn('[ssh] known-hosts 저장 실패:', e),
  )
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
  // 실시간 로그 tail 채널들 — client.end() 로 전부 끊기지만, 참조는 명시적으로 비운다
  s.logTailStreams?.clear()
  s.client?.end()
  s.client = null
  s.jumpClient?.end()
  s.jumpClient = null
  s.lastPassword = undefined
  s.sudoPassword = undefined
}

// ── SSH 연결 (재사용 가능 함수: 최초 접속 + 자동 재접속 공용) ──────
const RECONNECT_MAX = 5
// 렌더러의 "작업 중 끊기면 자동 재연결" 설정과 동기화 — 꺼져 있으면 백엔드도 재접속하지 않고 로컬 셸로 폴백한다.
let autoReconnectEnabled = true
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

function connectSession(sessionId: string, config: SSHConfig): Promise<ConnectResult> {
  const s = getSession(sessionId)
  s.connecting = true
  s.wasConnected = false
  s.hadError = false
  killLocalShell(s)
  // 재연결(이미 연결돼 있던 셀에 다른 호스트를 드롭 등): 기존 연결을 끊자마자 곧바로 새 핸드셰이크를
  // 시작하면 기존 소켓이 완전히 닫히기 전이라 새 연결이 read ECONNRESET 으로 실패하고 로컬 셸로 튕긴다.
  // → 기존 클라이언트를 잡아두고, 그 'close' 이후(또는 짧은 폴백 후)에 새 연결을 시작한다.
  const oldClient = s.client
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
          const win = s.ptySize
            ? { term: 'xterm-256color', cols: s.ptySize.cols, rows: s.ptySize.rows }
            : { term: 'xterm-256color' }
          conn.shell(win, (err, stream) => {
            if (err) {
              sendStatus(sessionId, { status: 'error', message: `쉘 오픈 실패: ${err.message}` })
              resolve({ success: false, message: err.message })
              return
            }
            s.shellStream = stream
            s.wasConnected = true
            // 로컬 셸 잔상이 원격 프롬프트와 겹치지 않게 화면+스크롤백을 지운 뒤 원격 출력 시작.
            mainWindow?.webContents.send('terminal:data', {
              sessionId: s.id,
              data: '\x1b[2J\x1b[3J\x1b[H',
            })
            // 이 연결(conn)이 이미 새 연결로 교체됐으면(끊기는 중인 옛 스트림) 잔여 출력을 버린다 —
            // 안 그러면 죽는 스트림의 마지막 프롬프트가 새 로컬 셸 화면에 덧그려진다.
            // 청크는 SSH 패킷 경계(~32KB)에서 잘리므로, 한글 등 멀티바이트 문자가 경계에 걸치면
            // chunk 단위 toString 은 양쪽 다 �로 깨뜨린다. 그 깨진 문자열이 세션 로그·리플레이
            // 기록에도 그대로 저장돼 영구 손상이 된다. StringDecoder 가 잘린 바이트를 물고 있다가
            // 다음 청크와 이어붙여 준다.
            const outDec = new StringDecoder('utf8')
            const errDec = new StringDecoder('utf8')
            stream.on('data', (data: Buffer) => {
              if (s.client !== conn) return
              pushOutput(s, outDec.write(data))
            })
            stream.stderr.on('data', (data: Buffer) => {
              if (s.client !== conn) return
              pushOutput(s, errDec.write(data))
            })
            stream.on('close', () => {
              // 채널 종료 → 연결 종료 유도 (나머지 정리/재접속 판단은 client 'close' 가 담당).
              // 단, 이 스트림이 이미 교체된(옛) 연결의 것이면 새 연결을 끊지 않도록 가드.
              if (s.client === conn) s.client.end()
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
          // 이미 새 연결로 교체된 옛 연결의 늦은 에러는 무시 (새 연결 상태를 덮어쓰지 않도록)
          if (s.client !== conn) return
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
          // 이미 새 연결로 교체된 옛 연결의 늦은 close 는 무시 — 안 그러면 이 핸들러가
          // cleanupConnection 으로 갓 맺은 새 연결(s.client)을 끊고 상태를 'closed' 로
          // 덮어써, 드래그-드롭 재연결 시 "기존만 끊기고 새 연결은 안 되는" 문제가 생긴다.
          if (s.client !== conn) {
            return
          }
          if (s.reconnecting) return // 재접속 루프가 제어 중
          const shouldReconnect = autoReconnectEnabled && !!(s.wasConnected && s.hadError && !s.userClosed && s.lastConfig)
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
        // 짧은 네트워크 끊김(VPN 재협상, 패킷 유실 등)에도 곧바로 재접속 루프(노란불)로 안 빠지도록
        // 허용 폭을 넓힘 — 15초 * 3회(45초) → 15초 * 6회(90초). 실제 연결이 끊긴 경우는 여전히 감지됨.
        keepaliveInterval: 15000,
        keepaliveCountMax: 6,
      })
    }

    // 실제 새 연결 시작 — 기존 연결이 있었다면 그 소켓이 닫힌 뒤에 실행(ECONNRESET 방지).
    const begin = () => {
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
        // 짧은 네트워크 끊김(VPN 재협상, 패킷 유실 등)에도 곧바로 재접속 루프(노란불)로 안 빠지도록
        // 허용 폭을 넓힘 — 15초 * 3회(45초) → 15초 * 6회(90초). 실제 연결이 끊긴 경우는 여전히 감지됨.
        keepaliveInterval: 15000,
        keepaliveCountMax: 6,
      })
    } else {
      sendStatus(sessionId, { status: 'connecting', message: `${config.host} 연결 시도 중...` })
      connectTarget()
    }
    }

    if (oldClient) {
      // 기존 소켓이 완전히 닫힌 뒤 새 연결 시작. close 가 안 오는 경우를 대비해 250ms 폴백.
      sendStatus(sessionId, { status: 'connecting', message: '이전 연결 정리 중...' })
      let started = false
      const go = () => {
        if (started) return
        started = true
        begin()
      }
      oldClient.once('close', go)
      setTimeout(go, 250)
    } else {
      begin()
    }
  })
}

// 예기치 않은 끊김 시 자동 재접속 (백오프, 최대 RECONNECT_MAX 회)
async function attemptReconnect(sessionId: string) {
  const s = getSession(sessionId)
  if (!s.lastConfig || s.reconnecting) return
  s.reconnecting = true
  const cfg = s.lastConfig
  // connectSession 의 cleanupConnection 이 s.forwards 를 비우기 전에, 열려있던 터널 설정을 스냅샷 → 재접속 성공 후 복원
  const savedForwards: AddForwardOpts[] = s.forwards.map((f) => ({
    type: f.type,
    localHost: f.localHost,
    localPort: f.localPort,
    remoteHost: f.remoteHost,
    remotePort: f.remotePort,
  }))
  // 이 루프가 담당하는 '세대'. 도중에 사용자가 새로 연결하면 값이 바뀌어 루프를 접는다.
  const epoch = s.connectEpoch ?? 0
  const superseded = () => (s.connectEpoch ?? 0) !== epoch
  for (let i = 1; i <= RECONNECT_MAX; i++) {
    if (s.userClosed || superseded()) break
    sendStatus(sessionId, {
      status: 'connecting',
      message: `연결이 끊겼습니다 — 자동 재접속 ${i}/${RECONNECT_MAX}...`,
    })
    await delay(Math.min(1500 * i, 6000))
    // 대기 중에 사용자가 이 칸에 다른 서버를 붙였을 수 있다 → 그 연결을 건드리지 않고 종료
    if (s.userClosed || superseded()) break
    const r = await connectSession(sessionId, cfg)
    if (r.success) {
      s.reconnecting = false
      // 끊기기 전 열어둔 포트포워딩(터널) 재생성 (개별 실패는 무시)
      for (const fw of savedForwards) {
        try {
          await addForward(getSession(sessionId), fw)
        } catch {
          /* 무시 */
        }
      }
      return
    }
  }
  s.reconnecting = false
  // superseded 면 사용자가 이미 새 연결을 만든 상태다. 여기서 error 를 쏘거나 로컬 셸로 되돌리면
  // 멀쩡히 연결된 세션을 망가뜨린다.
  if (!s.userClosed && !superseded()) {
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
    // 세대 증가 → 진행 중인 자동 재접속 루프는 다음 체크에서 스스로 물러난다
    s.connectEpoch = (s.connectEpoch ?? 0) + 1
    await loadKnownHosts()
    try {
      return await connectSession(sessionId, config)
    } catch (e) {
      // ssh2 는 개인키 파싱/passphrase 오류 때 connect() 에서 동기 throw 한다. 여기서 안 잡으면
      // 렌더러는 아무 응답도 못 받아 "연결 중..." 에서 영구히 멈추고, 기존 연결 교체 경로에서는
      // 메인 프로세스 uncaught exception 이 된다.
      const message = e instanceof Error ? e.message : String(e)
      sendStatus(sessionId, { status: 'error', message })
      return { success: false, message }
    }
  },
)

// 렌더러의 자동 재연결 토글을 백엔드에 반영 (꺼지면 백엔드 attemptReconnect 도 중단)
ipcMain.on('ssh:setAutoReconnect', (_evt, enabled: boolean) => {
  autoReconnectEnabled = !!enabled
})

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

// 인덱스를 잃으면 녹화 파일(.cast.jsonl)이 목록에서 사라져 사실상 못 찾게 되므로
// 락 + 원자적 쓰기 + 엄격한 읽기를 적용한다. LOG_LOCK 을 잡은 채 다시 잡으면 교착되므로,
// 락 안에서 부를 용도의 *Unlocked 함수를 따로 둔다.
const LOG_LOCK = 'logIndex'
async function readLogIndex(): Promise<LogIndexEntry[]> {
  return readJsonArrayStore<LogIndexEntry>(logIndexPath())
}
async function writeLogIndex(list: LogIndexEntry[]): Promise<void> {
  await writeFileAtomic(logIndexPath(), JSON.stringify(list, null, 2))
}
async function upsertLogIndexUnlocked(entry: LogIndexEntry): Promise<void> {
  const list = await readLogIndex()
  const idx = list.findIndex((e) => e.id === entry.id)
  if (idx >= 0) list[idx] = entry
  else list.unshift(entry)
  await writeLogIndex(list)
}
async function upsertLogIndex(entry: LogIndexEntry): Promise<void> {
  return withStoreLock(LOG_LOCK, () => upsertLogIndexUnlocked(entry))
}

// 세션 로그(.cast.jsonl)는 세션마다 하나씩 계속 쌓이므로, 보관기간과 개수 상한을 둘 다 넘는
// 항목은 자동으로 정리한다 — 기록 중인(아직 endedAt 없는) 세션은 건드리지 않는다.
// (평문 로그 파일은 사용자가 직접 고른 위치에 저장되므로 앱이 자동 삭제하지 않는다.)
// 기본값은 로그뷰어에서 사용자가 조회/변경 가능(logRetentionSettingsPath 에 저장).
const DEFAULT_LOG_RETENTION_DAYS = 30
const DEFAULT_LOG_MAX_ENTRIES = 50
const logRetentionSettingsPath = () => path.join(app.getPath('userData'), 'log-retention-settings.json')

const DEFAULT_LOG_RETENTION: LogRetentionSettings = {
  retentionDays: DEFAULT_LOG_RETENTION_DAYS,
  maxEntries: DEFAULT_LOG_MAX_ENTRIES,
}

/**
 * 보관 설정 읽기 — 정리(삭제) 판단에 쓰이므로 절대 조용히 기본값으로 되돌리면 안 된다.
 * 사용자가 "500개/365일 보관"으로 늘려놨는데 파일이 손상돼 기본값(50개/30일)으로 읽히면,
 * 자동 정리가 남겨야 할 녹화 파일을 영구 삭제해 버린다. 그래서 파일이 있는데 이상하면 throw.
 */
async function readLogRetentionSettings(): Promise<LogRetentionSettings> {
  let raw: string
  try {
    raw = await readFile(logRetentionSettingsPath(), 'utf-8')
  } catch {
    return { ...DEFAULT_LOG_RETENTION } // 아직 설정한 적 없음 (정상)
  }
  const parsed = JSON.parse(raw)
  const retentionDays = Number(parsed?.retentionDays)
  const maxEntries = Number(parsed?.maxEntries)
  if (!(Number.isFinite(retentionDays) && retentionDays > 0 && Number.isFinite(maxEntries) && maxEntries > 0)) {
    throw new Error('log-retention-settings.json: 보관 설정 값이 올바르지 않습니다 (파일 손상 가능성)')
  }
  return { retentionDays, maxEntries }
}
/** 화면 표시 전용 — 못 읽으면 기본값을 보여준다(여기서는 아무것도 삭제하지 않으므로 안전). */
async function readLogRetentionSettingsForDisplay(): Promise<LogRetentionSettings> {
  try {
    return await readLogRetentionSettings()
  } catch {
    return { ...DEFAULT_LOG_RETENTION }
  }
}
async function writeLogRetentionSettings(settings: LogRetentionSettings): Promise<void> {
  await writeFileAtomic(logRetentionSettingsPath(), JSON.stringify(settings, null, 2))
}

ipcMain.handle('logs:getRetentionSettings', () => readLogRetentionSettingsForDisplay())
ipcMain.handle('logs:setRetentionSettings', async (_evt, settings: LogRetentionSettings) => {
  const clamped: LogRetentionSettings = {
    retentionDays: Math.max(1, Math.round(settings.retentionDays)),
    maxEntries: Math.max(1, Math.round(settings.maxEntries)),
  }
  await writeLogRetentionSettings(clamped)
  await trimSessionLogs()
  return clamped
})

/** 실제 정리 본체 — 반드시 LOG_LOCK 을 잡은 상태에서 호출할 것 */
async function trimSessionLogsUnlocked(): Promise<void> {
  let retentionDays: number
  let maxEntries: number
  let list: LogIndexEntry[]
  try {
    ;({ retentionDays, maxEntries } = await readLogRetentionSettings())
    list = await readLogIndex()
  } catch (e) {
    // 설정/인덱스를 못 읽는 상태에서 정리를 강행하면 남겨야 할 녹화를 지운다. 이번 회차는 건너뛴다.
    console.warn('[logs] 보관 정리 건너뜀 (설정/인덱스 읽기 실패):', e)
    return
  }
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
async function trimSessionLogs(): Promise<void> {
  return withStoreLock(LOG_LOCK, trimSessionLogsUnlocked)
}

/** 스트림 종료 + 인덱스에 종료시각/파일크기 반영 (best-effort, 실패해도 세션 종료를 막지 않음) */
async function finalizeLogSession(s: Session): Promise<void> {
  const id = s.logId
  s.logCastStream?.end()
  s.logCastStream = undefined
  if (!id) return
  // "탭 전체 닫기"는 세션마다 이 함수를 동시에 부른다. 락 없이 read→수정→write 하면 서로의
  // 종료시각 기록을 덮어써 endedAt 없는 유령 항목이 남고, 그 항목은 이후 영영 정리되지 않는다.
  await withStoreLock(LOG_LOCK, async () => {
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
      /* 무시 — 세션 종료 자체를 막지 않는다 */
    }
    await trimSessionLogsUnlocked() // 이미 락 안이므로 Unlocked 판을 부른다(재진입 교착 방지)
  })
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
      // WriteStream 의 'error' 는 비동기로 발생하므로 try/catch 로 못 잡는다. 리스너가 없으면
      // 디스크 가득참·USB 분리 같은 상황에서 uncaughtException 으로 앱 전체가 즉사하고,
      // 그 순간 열려 있던 모든 SSH 세션이 함께 날아간다. 기록만 조용히 중단하도록 처리한다.
      const onStreamError = (what: string) => (e: unknown) => {
        console.warn(`[logs] ${what} 기록 중단:`, e)
        s.logStream = undefined
        s.logCastStream = undefined
        sendStatus(sessionId, { status: 'error', message: `세션 로그 기록이 중단되었습니다 (${what})` })
      }
      s.logStream = createWriteStream(r.filePath, { flags: 'a' })
      s.logStream.on('error', onStreamError('평문 로그'))
      s.logStream.write(`\n===== 로그 시작 ${new Date().toISOString()} =====\n`)

      const id = randomUUID()
      await mkdir(logCastDir(), { recursive: true })
      const castPath = path.join(logCastDir(), `${id}.cast.jsonl`)
      s.logCastStream = createWriteStream(castPath, { flags: 'a' })
      s.logCastStream.on('error', onStreamError('리플레이 기록'))
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

/**
 * 목록에 곁들일 실물 정보.
 *
 * 목록이 "host · 시각 · 14초 · 10.7KB" 뿐이라 **그때 무슨 작업을 했는지** 알 수 없어, 결국
 * 하나씩 열어봐야 했다. 로그 앞부분에서 첫 명령어를 뽑아 그 답을 목록에 올린다.
 *
 * 앞 64KB 만 읽는다 — 목록을 열 때마다 전부 읽으면 큰 로그에서 창이 멎는다. 첫 명령어가
 * 그보다 뒤에 있으면 미리보기를 포기한다(틀린 값을 보여주는 것보다 없는 편이 낫다).
 */
const CMD_SCAN_BYTES = 64 * 1024
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)|\r/g

/**
 * 백스페이스를 화면처럼 적용한다.
 *
 * 기록에는 사람이 친 그대로가 남는다 — 오타를 지우면 `dfsasdfdf -h` 같은 줄이 되고, 셸이
 * 지우기를 `\b \b` 로 내보내므로 그 셋을 순서대로 적용해야 화면에 보였던 `df -h` 가 나온다.
 * 실제 녹화 파일로 확인한 것이라 없애면 미리보기가 다시 깨진다.
 */
function applyBackspaces(line: string): string {
  const out: string[] = []
  for (const ch of line) {
    if (ch === '\b' || ch === '\x7f') out.pop()
    else out.push(ch)
  }
  return out.join('')
}

function firstCommandOf(text: string): string | undefined {
  for (const line of text.replace(ANSI_RE, '').split('\n')) {
    const raw = applyBackspaces(line)
    // 프롬프트 뒤에 붙은 입력만 뽑는다: `[root@con01 ~]# ceph -s`, `user@host:~$ ls`
    // 프롬프트 형태를 요구하는 이유는, 그러지 않으면 출력 아무 줄이나 명령어로 잡히기 때문이다.
    const m = raw.match(/^\s*(?:\[[^\]]{1,60}\]|[\w.-]+@[\w.-]+:[^\s#$]*)\s*[#$]\s+(\S.*)$/)
    const cmd = m?.[1]?.trim()
    if (!cmd) continue
    // 끝맺음·화면 정리는 "무슨 작업이었나" 의 답이 아니다
    if (/^(exit|logout|clear|ll|ls)$/.test(cmd)) continue
    // 긴 명령은 잘라서 준다 — 못 찾은 것으로 취급하면 정작 중요한 한 줄을 놓친다
    return cmd.length > 90 ? cmd.slice(0, 90) + '…' : cmd
  }
  return undefined
}

/** 파일 앞부분만 읽어 첫 명령어를 뽑는다 (읽기 실패는 '미리보기 없음'으로 삼킨다) */
async function firstCommandFromHead(
  filePath: string,
  size: number,
  toText: (raw: string) => string,
): Promise<string | undefined> {
  try {
    const fh = await open(filePath, 'r')
    try {
      const len = Math.min(CMD_SCAN_BYTES, size || CMD_SCAN_BYTES)
      const buf = Buffer.alloc(len)
      const { bytesRead } = await fh.read(buf, 0, len, 0)
      return firstCommandOf(toText(buf.subarray(0, bytesRead).toString('utf-8')))
    } finally {
      await fh.close()
    }
  } catch {
    return undefined
  }
}

/** .cast.jsonl 앞부분 → 터미널에 찍혔던 문자열. 마지막 줄은 잘렸을 수 있으므로 버린다 */
function castHeadToText(raw: string): string {
  const lines = raw.split('\n')
  lines.pop()
  return lines
    .map((line) => {
      try {
        return (JSON.parse(line) as { d?: string }).d ?? ''
      } catch {
        return ''
      }
    })
    .join('')
}

ipcMain.handle('logs:details', async (): Promise<LogEntryDetail[]> => {
  const list = await readLogIndex()
  const out: LogEntryDetail[] = []
  for (const e of list) {
    const d: LogEntryDetail = { id: e.id, plainExists: false, castExists: false }
    try {
      const st = await stat(e.path)
      d.plainExists = true
      d.plainSize = st.size
    } catch {
      /* 옮겼거나 지웠다 — 목록에서 그 사실을 밝힌다 */
    }
    try {
      const cst = await stat(e.castPath)
      // 0바이트는 '있는' 것이 아니다 — 배지를 달아 두면 눌러도 아무 일이 없어 고장으로 읽힌다
      d.castExists = cst.size > 0
      d.castSize = cst.size
    } catch {
      /* 리플레이 기록 없음 */
    }
    // 평문이 우선이지만, 사용자가 그 파일을 옮기거나 지워도 리플레이 기록에는 같은 출력이 남아
    // 있다. 평문이 없다고 미리보기를 포기하면 정작 "원본 없음" 인 항목만 아무 정보도 없는
    // 빈 줄이 된다 — 그런 항목일수록 무엇이었는지 알아야 지울지 말지 판단할 수 있다.
    if (d.plainExists && (d.plainSize ?? 0) > 0) {
      d.firstCommand = await firstCommandFromHead(e.path, d.plainSize ?? 0, (t) => t)
    }
    if (!d.firstCommand && d.castExists && (d.castSize ?? 0) > 0) {
      d.firstCommand = await firstCommandFromHead(e.castPath, d.castSize ?? 0, castHeadToText)
    }
    out.push(d)
  }
  return out
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

// 세션 로그 원본 전체를 파일로 저장 (5MB 미리보기 제한 없이 원본 그대로 복사).
ipcMain.handle('logs:export', async (_evt, id: string) => {
  const entry = (await readLogIndex()).find((e) => e.id === id)
  if (!entry) return { saved: false, error: '로그를 찾을 수 없습니다.' }
  const base = (entry.label || entry.host || 'session-log').replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '')
  const d = new Date(entry.startedAt || Date.now())
  const p2 = (n: number) => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}`
  const result = await dialog.showSaveDialog(mainWindow!, {
    title: '세션 로그 저장',
    defaultPath: `sessionlog_${base || 'log'}_${stamp}.log`,
    filters: [
      { name: 'Log', extensions: ['log'] },
      { name: 'Text', extensions: ['txt'] },
      { name: 'Markdown', extensions: ['md'] },
    ],
  })
  if (result.canceled || !result.filePath) return { saved: false }
  try {
    // 원본 바이트 그대로 복사 — utf-8 문자열로 읽어 재인코딩하면 비-UTF-8 바이트가 U+FFFD 로 손상된다.
    await copyFile(entry.path, result.filePath)
    return { saved: true, path: result.filePath }
  } catch (e) {
    return { saved: false, error: e instanceof Error ? e.message : String(e) }
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
ipcMain.handle('logs:delete', async (_evt, id: string) =>
  withStoreLock(LOG_LOCK, async () => {
    // readLogIndex 가 실패하면 여기서 throw 되어 삭제가 중단된다 — 예전엔 [] 로 뭉개진 뒤
    // 그 빈 목록이 저장돼 로그 하나 지우려다 인덱스 전체가 날아갔다.
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
  }),
)

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
  // 최신 크기를 기억 — 아직 셸이 없을 때(로컬 셸/연결 전) 값도 저장해두면, 이후 SSH 셸을
  // 열 때 이 크기로 생성돼 원격 화면이 실제 터미널과 맞게 된다.
  s.ptySize = { cols: Math.max(1, size.cols), rows: Math.max(1, size.rows) }
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
  // 모니터 상태도 함께 버린다 — 안 지우면 탭이 사라진 뒤에도 항목이 남아 메모리에 쌓이고,
  // 같은 세션 id 로 다시 붙었을 때 이전 배포 플래그를 재사용해 에이전트 재배포를 건너뛴다.
  monitors.delete(sessionId)
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
/**
 * OS 알림 (Windows 알림 센터 토스트 / macOS 알림).
 *
 * 왜 메인에서 띄우나: 렌더러의 Notification 은 창이 최소화·백그라운드일 때 브라우저 정책에
 * 걸릴 수 있고, 앱 이름·클릭 처리도 메인이 정확하다. 검증은 10분 넘게 걸리는 일이라
 * **창을 보고 있지 않을 때 알려주는 것**이 이 기능의 전부다.
 *
 * 알림을 눌렀을 때 창을 앞으로 가져온다 — 알림만 보고 무슨 일인지 알 수 없으니 화면으로 데려간다.
 */
ipcMain.handle('app:notify', async (_evt, { title, body }: { title: string; body: string }) => {
  if (!Notification.isSupported()) return { ok: false, error: '이 OS 에서는 알림을 지원하지 않습니다.' }
  try {
    const n = new Notification({ title: title.slice(0, 120), body: body.slice(0, 300) })
    n.on('click', () => {
      if (!mainWindow) return
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    })
    n.show()
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
})

ipcMain.on('shell:openExternal', (_evt, url: string) => {
  if (/^https?:\/\//i.test(url)) shell.openExternal(url)
})

// ─────────────────────────────────────────────────────────────
// 설정·데이터가 저장되는 폴더(userData). 프리셋·시나리오·접속 프로필·세션 로그가 여기 있고,
// **설치 폴더 밖이라 앱을 재설치해도 지워지지 않는다** — 그 사실을 사용자가 눈으로 확인할 수
// 있게 경로를 문자열로도 돌려준다(백업 스크립트에 붙여 쓸 수 있어야 한다).
ipcMain.handle('app:userDataPath', () => app.getPath('userData'))
ipcMain.handle('app:openUserData', async () => {
  // openPath 는 실패 사유를 문자열로 돌려준다 (빈 문자열이면 성공)
  const err = await shell.openPath(app.getPath('userData'))
  return { ok: !err, error: err || undefined }
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

// ── 파일 저장소 공통 유틸 ────────────────────────────────────────
// 아래 세 가지가 함께 없으면 저장 파일이 통째로 날아간다. 실제로 그렇게 저장된 세션 25개 중
// 21개를 잃었다. 새 저장소를 추가할 때도 이 세 가지를 반드시 같이 쓸 것.
//   1) withStoreLock  — read→수정→write 가 겹치지 않도록 파일별로 직렬화
//   2) writeFileAtomic — 임시파일+rename. '반쯤 쓰인 파일'을 남이 읽는 상황 자체를 없앰
//   3) readJson*Store — '파일 없음'과 '파일은 있는데 못 읽음'을 구분. 후자를 기본값으로
//      뭉개면 호출자가 그 기본값을 그대로 저장해 기존 데이터를 전부 덮어쓴다.

/** 경로(또는 논리 키)별 직렬화 락 — 같은 저장소를 건드리는 작업을 한 줄로 세운다. */
const storeChains = new Map<string, Promise<unknown>>()
function withStoreLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = storeChains.get(key) ?? Promise.resolve()
  // 앞선 작업이 실패해도 체인이 끊기지 않도록 성공/실패 모두 이어서 실행한다.
  const run = prev.then(fn, fn)
  storeChains.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  )
  return run
}

/** 임시 파일에 쓰고 rename 으로 교체 — 쓰는 도중에 읽어도 이전 내용이 온전히 보인다. */
async function writeFileAtomic(dest: string, data: string): Promise<void> {
  const tmp = `${dest}.tmp`
  await writeFile(tmp, data, 'utf-8')
  await rename(tmp, dest)
}

/**
 * JSON 배열 저장소 읽기.
 *  - 파일이 아직 없으면 [] (정상 초기 상태)
 *  - 파일은 있는데 파싱이 안 되면 throw — 절대 [] 로 뭉개지 않는다.
 *    (뭉개면 호출자가 [] 에 한 건 추가한 목록을 저장해 나머지를 전부 삭제해 버린다)
 */
async function readJsonArrayStore<T>(filePath: string): Promise<T[]> {
  let raw: string
  try {
    raw = await readFile(filePath, 'utf-8')
  } catch {
    return [] // 아직 파일 없음
  }
  const arr = JSON.parse(raw)
  if (!Array.isArray(arr)) throw new Error(`${path.basename(filePath)}: 배열이 아닙니다 (파일 손상 가능성)`)
  return arr as T[]
}

/** 프로필 저장소 락 (기존 호출부 유지용 얇은 래퍼) */
function withProfilesLock<T>(fn: () => Promise<T>): Promise<T> {
  return withStoreLock('profiles', fn)
}

async function readProfiles(): Promise<SavedProfile[]> {
  // 새 목록 파일 우선
  let raw: string | null = null
  try {
    raw = await readFile(profilesPath(), 'utf-8')
  } catch {
    raw = null // 파일 자체가 없음 → 아래 구버전 마이그레이션 경로로
  }
  if (raw !== null) {
    const json = decryptStr(raw)
    if (json) {
      const arr = JSON.parse(json)
      if (Array.isArray(arr)) return arr as SavedProfile[]
    }
    // 파일은 있는데 복호화/파싱이 안 되는 상태. 여기서 빈 목록이나 구버전 1건으로 '성공' 처리하면,
    // 호출자가 그 짧은 목록을 그대로 다시 write 해서 저장된 세션이 전부 날아간다.
    // 조용히 뭉개지 말고 실패시켜, 최소한 기존 파일을 덮어쓰지는 않도록 한다.
    throw new Error('저장된 세션 목록을 읽을 수 없습니다 (파일 손상 가능성)')
  }
  // 구버전 단일 프로필 → 목록으로 마이그레이션 (새 목록 파일이 아예 없을 때만)
  try {
    const json = decryptStr(await readFile(legacyProfilePath(), 'utf-8'))
    if (json) return [JSON.parse(json) as SavedProfile]
  } catch {
    /* 파일 없음 */
  }
  return []
}

async function writeProfiles(list: SavedProfile[]): Promise<void> {
  await writeFileAtomic(profilesPath(), encryptStr(JSON.stringify(list)))
}

// ── 프로필 가져오기(CSV/JSON) ────────────────────────────────────
//  - 업로드된 파일은 메모리에서만 파싱하며 어디에도 복사/로그하지 않는다.
//  - 결과로 반환되는 오류/경고 메시지에는 값이 아닌 필드명/행 번호만 담는다.

/**
 * 업로드된 CSV/JSON 텍스트 디코딩 — 인코딩 자동 판별.
 * 한국어 Windows 의 Excel 은 "CSV(쉼표로 분리)"로 저장하면 UTF-8 이 아니라 CP949(=euc-kr 확장)로 쓴다.
 * 이걸 UTF-8 로 읽으면 한글 별칭/폴더명이 전부 깨진 문자로 들어온다. BOM 을 먼저 보고, 없으면
 * UTF-8 로 엄격 디코딩을 시도한 뒤 실패할 때만 CP949 로 재해석한다(영문만 있는 파일은 그대로 UTF-8).
 */
function decodeTextFile(buf: Buffer): string {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.subarray(3).toString('utf-8') // UTF-8 BOM — 내보내기/템플릿이 붙이는 형태
  }
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2))
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2))
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf)
  } catch {
    // UTF-8 로 성립하지 않는 바이트열 → CP949 로 간주 (TextDecoder 의 'euc-kr' 라벨이 CP949 디코더)
    try {
      return new TextDecoder('euc-kr').decode(buf)
    } catch {
      return buf.toString('utf-8')
    }
  }
}

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
      // 따옴표는 '필드 맨 앞'에서만 인용 시작으로 본다. 필드 중간의 따옴표(예: 손으로 적은
      // 비밀번호 my"pass)를 인용 시작으로 해석하면, 닫는 따옴표가 없어 이후의 쉼표·줄바꿈을
      // 전부 삼켜 그 아래 행이 통째로 사라진다(오류도 안 나고 조용히 누락).
      if (field === '') {
        inQuotes = true
        i++
        continue
      }
      field += c
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

// 비밀·본문 성격의 값은 앞뒤 공백까지 그대로 살려야 한다. 비밀번호 끝의 공백 한 칸을 임의로
// 지우면 가져온 뒤 인증만 계속 실패하고 원인을 찾기 어렵고, 개인키는 끝 줄바꿈이 잘린다.
const CSV_VERBATIM_KEYS = new Set(['password', 'passphrase', 'privatekey', 'startup'])

/** CSV 헤더 + 한 행을 소문자 컬럼명 → 값 레코드로 변환 (컬럼 순서 무관) */
function csvRecordFromRow(header: string[], row: string[]): Record<string, string> {
  const rec: Record<string, string> = {}
  header.forEach((h, idx) => {
    const key = h.trim().toLowerCase()
    if (!key) return
    const raw = row[idx] ?? ''
    rec[key] = CSV_VERBATIM_KEYS.has(key) ? raw : raw.trim()
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
  // 점프호스트는 JSON 문자열 컬럼으로 왕복한다. 깨져 있으면 그 항목만 점프 없이 가져오고 경고.
  let jump: unknown
  if (rec['jump']) {
    try {
      jump = JSON.parse(rec['jump'])
    } catch {
      warning = `${rowLabel}: 점프호스트 정보를 읽을 수 없습니다 — 점프호스트 없이 가져왔습니다.`
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
      ...(jump && typeof jump === 'object' ? { jump } : {}),
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
  // 심링크는 '가리키는 대상'이 아니라 링크 자체만 지운다.
  // 호출자가 준 isDir 은 stat 기반(=링크를 따라간 결과)이라, 디렉토리 심링크를 지우려 하면
  // 원본 폴더로 들어가 내용물을 전부 삭제해 버린다. 그리고 마지막 rmdir 만 실패해서 화면엔
  // "삭제 실패" 만 뜨므로 사용자는 데이터가 날아간 걸 알지도 못한다 → lstat 으로 직접 확인.
  const isLink = await new Promise<boolean>((res) =>
    sftp.lstat(p, (e, st) => res(!e && typeof st?.isSymbolicLink === 'function' && st.isSymbolicLink())),
  )
  if (isLink || !isDir) {
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

type AddForwardOpts = {
  type: 'local' | 'remote'
  localHost: string
  localPort: number
  remoteHost: string
  remotePort: number
}
// 포트포워딩(터널) 1개 생성 — tunnel:add 핸들러와 자동 재연결 후 복원에서 공용으로 사용
async function addForward(s: Session, o: AddForwardOpts): Promise<{ ok: boolean; id?: string; error?: string }> {
  if (!s.client) return { ok: false, error: '연결되어 있지 않습니다.' }
  const id = `fw${++fwSeq}`
  const localHost = o.localHost || '127.0.0.1'
  if (o.type === 'local') {
    // 로컬 포트로 들어온 연결을 원격(remoteHost:remotePort)으로 터널
    const server = net.createServer((socket) => {
      s.client!.forwardOut(socket.remoteAddress || '127.0.0.1', socket.remotePort || 0, o.remoteHost, o.remotePort, (err, stream) => {
        if (err) {
          socket.destroy()
          return
        }
        socket.pipe(stream).pipe(socket)
      })
    })
    return await new Promise((resolve) => {
      server.once('error', (e: Error) => resolve({ ok: false, error: e.message }))
      server.listen(o.localPort, localHost, () => {
        s.forwards.push({ id, type: o.type, localHost, localPort: o.localPort, remoteHost: o.remoteHost, remotePort: o.remotePort, server })
        resolve({ ok: true, id })
      })
    })
  } else {
    // 원격 포트로 들어온 연결을 로컬(localHost:localPort)으로 전달
    return await new Promise((resolve) => {
      s.client!.forwardIn(o.remoteHost || '127.0.0.1', o.remotePort, (err) => {
        if (err) {
          resolve({ ok: false, error: err.message })
          return
        }
        s.forwards.push({ id, type: o.type, localHost, localPort: o.localPort, remoteHost: o.remoteHost || '127.0.0.1', remotePort: o.remotePort })
        ensureRemoteHandler(s)
        resolve({ ok: true, id })
      })
    })
  }
}

ipcMain.handle('tunnel:add', async (_evt, o: AddForwardOpts & { sessionId: string }) => {
  return addForward(getSession(o.sessionId), o)
})

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
  async (_evt, profile: SavedProfile, opts?: { preserveMeta?: boolean }) =>
    withProfilesLock(async () => {
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
            color: profile.color ?? existing?.color,
          }
        : { ...profile }
      // 기존 프로필은 사이드바에서 드래그로 정한 순서를 그대로 유지한 채 갱신 (자동 저장 때문에 순서가 흐트러지지 않도록)
      const list = [...all]
      if (idx >= 0) list[idx] = merged
      else list.unshift(merged) // 신규 프로필만 맨 앞에 추가
      await writeProfiles(list)
      return list
    }),
)

// 특정 프로필 삭제 (key = host:port:username)
ipcMain.handle('profiles:delete', async (_evt, key: string) =>
  withProfilesLock(async () => {
    const list = (await readProfiles()).filter((p) => profileKey(p) !== key)
    await writeProfiles(list)
    return list
  }),
)

// 여러 프로필 일괄 삭제 (폴더 전체 삭제 등) — 한 번의 읽기/쓰기로 처리해 부분 삭제 상태가 남지 않게 한다.
ipcMain.handle('profiles:deleteMany', async (_evt, keys: string[]) =>
  withProfilesLock(async () => {
    const all = await readProfiles()
    if (!Array.isArray(keys) || !keys.length) return all
    const drop = new Set(keys)
    const list = all.filter((p) => !drop.has(profileKey(p)))
    if (list.length !== all.length) await writeProfiles(list)
    return list
  }),
)

// 전체 프로필 순서/그룹 일괄 반영 (사이드바 드래그 재정렬용)
ipcMain.handle('profiles:reorder', async (_evt, list: SavedProfile[]) =>
  withProfilesLock(async () => {
    if (Array.isArray(list)) await writeProfiles(list)
    return readProfiles()
  }),
)

// 폴더(그룹) 이름 일괄 변경 — 순서 보존, 빈 이름이면 그룹 해제
ipcMain.handle(
  'profiles:renameGroup',
  async (_evt, { from, to }: { from: string; to: string }) =>
    withProfilesLock(async () => {
      const target = to.trim() || undefined
      const list = (await readProfiles()).map((p) =>
        (p.group?.trim() ?? '') === from ? { ...p, group: target } : p,
      )
      await writeProfiles(list)
      return list
    }),
)

// 전체 기록 삭제
ipcMain.handle('profiles:clear', async () =>
  // 락 밖에서 지우면, 이미 읽기를 끝낸 자동저장(upsert)이 그 뒤에 rename 으로 목록을 되살려
  // "전체 삭제"가 조용히 무효가 된다.
  withProfilesLock(async () => {
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
  }),
)

// ─────────────────────────────────────────────────────────────
// 사용자 정의 프리셋 / 시나리오
//  - 내장 PRESETS/SCENARIOS(src/presets.ts, src/scenarios.ts)는 코드에 하드코딩되어
//    빌드 없이는 추가할 수 없음 → 런타임에 추가/편집 가능한 목록을 별도 JSON 파일로 관리하고,
//    렌더러에서 내장 목록과 병합해 표시한다. 비밀정보가 아니므로 암호화하지 않음.
// ─────────────────────────────────────────────────────────────

const customPresetsPath = () => path.join(app.getPath('userData'), 'custom-presets.json')
const customScenariosPath = () => path.join(app.getPath('userData'), 'custom-scenarios.json')

// 사용자가 직접 만든 항목이라 잃으면 복구 수단이 없다 → 락 + 원자적 쓰기 + 엄격한 읽기 필수.
async function readCustomPresets(): Promise<CustomPresetCommand[]> {
  return readJsonArrayStore<CustomPresetCommand>(customPresetsPath())
}
async function writeCustomPresets(list: CustomPresetCommand[]): Promise<void> {
  await writeFileAtomic(customPresetsPath(), JSON.stringify(list, null, 2))
}
async function readCustomScenarios(): Promise<CustomScenario[]> {
  return readJsonArrayStore<CustomScenario>(customScenariosPath())
}
async function writeCustomScenarios(list: CustomScenario[]): Promise<void> {
  await writeFileAtomic(customScenariosPath(), JSON.stringify(list, null, 2))
}

ipcMain.handle('customPresets:list', async () => readCustomPresets())
ipcMain.handle('customPresets:upsert', async (_evt, item: CustomPresetCommand) =>
  withStoreLock('customPresets', async () => {
    const list = await readCustomPresets()
    const isNew = !item.id || !list.some((p) => p.id === item.id)
    // 신규 항목은 생성 시각을 기본 순서로 사용 — 내장 명령어는 배열 인덱스(작은 정수)를 암묵적
    // 순서로 쓰므로, 훨씬 큰 타임스탬프 값이면 자연히 맨 뒤로 붙는다. 위치 이동은 order 값을
    // 직접 지정해서 다시 upsert 하는 방식으로 처리(별도 재정렬 API 불필요).
    const existingOrder = isNew ? undefined : list.find((p) => p.id === item.id)?.order
    const withId: CustomPresetCommand = {
      ...item,
      id: item.id || randomUUID(),
      order: item.order ?? (isNew ? Date.now() : existingOrder),
    }
    const idx = list.findIndex((p) => p.id === withId.id)
    if (idx >= 0) list[idx] = withId
    else list.push(withId)
    await writeCustomPresets(list)
    return list
  }),
)
ipcMain.handle('customPresets:delete', async (_evt, id: string) =>
  withStoreLock('customPresets', async () => {
    const list = (await readCustomPresets()).filter((p) => p.id !== id)
    await writeCustomPresets(list)
    return list
  }),
)

ipcMain.handle('customScenarios:list', async () => readCustomScenarios())
ipcMain.handle('customScenarios:upsert', async (_evt, item: CustomScenario) =>
  withStoreLock('customScenarios', async () => {
    const list = await readCustomScenarios()
    const isNew = !item.id || !list.some((s) => s.id === item.id)
    const existingOrder = isNew ? undefined : list.find((s) => s.id === item.id)?.order
    const withId: CustomScenario = {
      ...item,
      id: item.id || randomUUID(),
      order: item.order ?? (isNew ? Date.now() : existingOrder),
    }
    const idx = list.findIndex((s) => s.id === withId.id)
    if (idx >= 0) list[idx] = withId
    else list.push(withId)
    await writeCustomScenarios(list)
    return list
  }),
)
ipcMain.handle('customScenarios:delete', async (_evt, id: string) =>
  withStoreLock('customScenarios', async () => {
    const list = (await readCustomScenarios()).filter((s) => s.id !== id)
    await writeCustomScenarios(list)
    return list
  }),
)

// ── 사용자 정의 항목 내보내기 / 가져오기 ─────────────────────────
//
// 앱에서 손으로 만든 항목이라 잃으면 복구 수단이 없고, 팀원에게 넘길 방법도 userData 폴더의
// JSON 을 직접 복사하는 것뿐이었다.
//
// 두 가지를 지킨다.
//  1) **한 파일에 프리셋·시나리오를 함께** 담는다. 따로 내보내면 넘길 때 한쪽을 빼먹는다.
//  2) 가져오기는 **병합**이다. 통째로 교체하면 받는 쪽이 자기 항목을 잃는다.
//     들어온 id 는 그대로 유지한다 — 같은 파일을 두 번 가져와도 중복이 생기지 않고(같은 id 를
//     덮어쓴다), 보낸 쪽이 고쳐 다시 보낸 파일도 새로 추가되지 않고 갱신된다.

/** 문자열 필드 정리. 문자열이 아니면 빈 값 — 낯선 타입이 그대로 저장되는 것을 막는다 */
const cleanStr = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
const cleanStrArr = (v: unknown): string[] | undefined => {
  if (!Array.isArray(v)) return undefined
  const out = v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim())
  return out.length ? out : undefined
}
/**
 * **자리 순서가 의미를 갖는** 문자열 배열 정리 (예: onFailureDesc).
 *
 * cleanStrArr 을 쓰면 안 된다 — 그건 빈 값을 걸러내므로 `['DNS 확인', '', '저장소 추가']` 가
 * `['DNS 확인', '저장소 추가']` 로 줄어들어 **설명이 한 칸씩 밀려 엉뚱한 단계에 붙는다.**
 * 여기서는 빈 칸을 그대로 남기고, 전부 비어 있을 때만 없는 것으로 본다.
 */
const cleanStrArrKeepGaps = (v: unknown): string[] | undefined => {
  if (!Array.isArray(v)) return undefined
  const out = v.map((x) => (typeof x === 'string' ? x.trim() : ''))
  return out.some(Boolean) ? out : undefined
}
/** 정규식이 실제로 컴파일되는지 — 깨진 정규식을 저장하면 그 항목을 쓸 때마다 터진다 */
const compiles = (src: string): boolean => {
  try {
    new RegExp(src)
    return true
  } catch {
    return false
  }
}
/** 판정 기준 정리 — passRegex 가 깨져 있으면 그 필드만 버리고 나머지는 살린다 */
function cleanCheck(v: unknown): CommandCheck | undefined {
  if (!v || typeof v !== 'object') return undefined
  const o = v as Record<string, unknown>
  const failContains = cleanStrArr(o.failContains)
  const passContains = cleanStrArr(o.passContains)
  const rx = cleanStr(o.passRegex)
  const passRegex = rx && compiles(rx) ? rx : undefined
  const requireExitZero = typeof o.requireExitZero === 'boolean' ? o.requireExitZero : undefined
  if (!failContains && !passContains && !passRegex && requireExitZero === undefined) return undefined
  return {
    ...(failContains ? { failContains } : {}),
    ...(passContains ? { passContains } : {}),
    ...(passRegex ? { passRegex } : {}),
    ...(requireExitZero !== undefined ? { requireExitZero } : {}),
  }
}
function cleanCapture(v: unknown): CaptureRule[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out: CaptureRule[] = []
  for (const rv of v) {
    if (!rv || typeof rv !== 'object') continue
    const r = rv as Record<string, unknown>
    const name = cleanStr(r.name)
    const regex = cleanStr(r.regex)
    if (!name || !regex || !compiles(regex)) continue
    const group = typeof r.group === 'number' && Number.isFinite(r.group) ? r.group : undefined
    out.push({ name, regex, ...(group !== undefined ? { group } : {}) })
  }
  return out.length ? out : undefined
}
function cleanExpect(v: unknown): ExpectRule[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out: ExpectRule[] = []
  for (const rv of v) {
    if (!rv || typeof rv !== 'object') continue
    const r = rv as Record<string, unknown>
    const match = cleanStr(r.match)
    if (!match || !compiles(match)) continue
    // send 는 **trim 하지 않는다** — 비밀번호나 공백이 의미 있는 응답이 잘려 나간다.
    // 빈 문자열도 유효하다(엔터만 보내는 응답).
    const send = typeof r.send === 'string' ? r.send : ''
    out.push({ match, send, ...(r.secret === true ? { secret: true } : {}) })
  }
  return out.length ? out : undefined
}
const FAIL_ACTIONS: OnFailureAction[] = ['stop', 'continue', 'run', 'retry']

function cleanPreset(v: unknown): CustomPresetCommand | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const solution = cleanStr(o.solution)
  const subgroup = cleanStr(o.subgroup)
  const label = cleanStr(o.label)
  const command = cleanStr(o.command)
  if (!solution || !subgroup || !label || !command) return null
  const check = cleanCheck(o.check)
  // 낯선 필드는 버린다 — 다음 버전에서 의미가 생길 값이 조용히 섞여 들어오면 추적이 어렵다
  return {
    id: cleanStr(o.id) || randomUUID(),
    solution,
    subgroup,
    label,
    command,
    desc: cleanStr(o.desc),
    ...(check ? { check } : {}),
  }
}

function cleanScenario(v: unknown): CustomScenario | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const solution = cleanStr(o.solution)
  const title = cleanStr(o.title)
  const steps: CustomScenarioStep[] = []
  for (const sv of Array.isArray(o.steps) ? o.steps : []) {
    if (!sv || typeof sv !== 'object') continue
    const s = sv as Record<string, unknown>
    const stepTitle = cleanStr(s.title)
    const command = cleanStr(s.command)
    if (!stepTitle || !command) continue
    const check = cleanCheck(s.check)
    const capture = cleanCapture(s.capture)
    const expect = cleanExpect(s.expect)
    const onFailureRaw = cleanStr(s.onFailure) as OnFailureAction
    const onFailure = FAIL_ACTIONS.includes(onFailureRaw) ? onFailureRaw : undefined
    steps.push({
      title: stepTitle,
      command,
      desc: cleanStr(s.desc),
      ...(cleanStr(s.note) ? { note: cleanStr(s.note) } : {}),
      ...(cleanStr(s.info) ? { info: cleanStr(s.info) } : {}),
      ...(cleanStr(s.warn) ? { warn: cleanStr(s.warn) } : {}),
      ...(cleanStr(s.code) ? { code: cleanStr(s.code) } : {}),
      ...(cleanStr(s.target) ? { target: cleanStr(s.target) } : {}),
      ...(check ? { check } : {}),
      ...(capture ? { capture } : {}),
      ...(expect ? { expect } : {}),
      ...(onFailure ? { onFailure } : {}),
      ...(cleanStrArrKeepGaps(s.onFailureDesc)
        ? { onFailureDesc: cleanStrArrKeepGaps(s.onFailureDesc) }
        : {}),
      ...(cleanStr(s.onFailureCommand) ? { onFailureCommand: cleanStr(s.onFailureCommand) } : {}),
      ...(cleanStr(s.undo) ? { undo: cleanStr(s.undo) } : {}),
    })
  }
  // 스텝이 하나도 없는 시나리오는 실행할 수 없으므로 받지 않는다
  if (!solution || !title || steps.length === 0) return null
  let roleValues: Record<string, string> | undefined
  if (o.roleValues && typeof o.roleValues === 'object') {
    const rv: Record<string, string> = {}
    for (const [k, val] of Object.entries(o.roleValues as Record<string, unknown>))
      if (cleanStr(k) && typeof val === 'string') rv[cleanStr(k)] = val
    if (Object.keys(rv).length) roleValues = rv
  }
  return {
    id: cleanStr(o.id) || randomUUID(),
    solution,
    title,
    summary: cleanStr(o.summary),
    steps,
    ...(roleValues ? { roleValues } : {}),
  }
}

ipcMain.handle('customItems:export', async () => {
  const [presets, scenarios] = await Promise.all([readCustomPresets(), readCustomScenarios()])
  if (presets.length === 0 && scenarios.length === 0)
    return { saved: false, error: '내보낼 사용자 정의 항목이 없습니다.' }
  const stamp = new Date().toISOString().slice(0, 10)
  const r = await dialog.showSaveDialog(mainWindow ?? undefined!, {
    title: '사용자 정의 프리셋·시나리오 내보내기',
    defaultPath: 'qterm-custom-' + stamp + '.json',
    filters: [{ name: 'JSON', extensions: ['json'] }],
  })
  if (r.canceled || !r.filePath) return { saved: false }
  const bundle: CustomItemsBundle = {
    version: 1,
    exportedAt: new Date().toISOString(),
    appVersion: app.getVersion(),
    presets,
    scenarios,
  }
  try {
    // BOM 은 붙이지 않는다 — 이 파일은 엑셀이 아니라 이 앱이 다시 읽는다(프로필 CSV 와 다른 점)
    await writeFile(r.filePath, JSON.stringify(bundle, null, 2), 'utf-8')
    return { saved: true, path: r.filePath, presets: presets.length, scenarios: scenarios.length }
  } catch (e) {
    return { saved: false, error: e instanceof Error ? e.message : String(e) }
  }
})

ipcMain.handle('customItems:import', async (): Promise<CustomItemsImportResult> => {
  const zero = { addedPresets: 0, addedScenarios: 0, replaced: 0, skipped: 0, warnings: [] as string[] }
  const r = await dialog.showOpenDialog(mainWindow ?? undefined!, {
    properties: ['openFile'],
    title: '사용자 정의 프리셋·시나리오 가져오기',
    filters: [{ name: 'JSON', extensions: ['json'] }],
  })
  if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true, ...zero }

  let bundle: CustomItemsBundle
  try {
    const raw = await readFile(r.filePaths[0], 'utf-8')
    // 다른 도구를 거쳐 온 파일에 BOM 이 붙어 있으면 JSON.parse 가 그대로 실패한다
    bundle = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw)
  } catch (e) {
    return {
      ok: false,
      error: '파일을 읽지 못했습니다: ' + (e instanceof Error ? e.message : String(e)),
      ...zero,
    }
  }
  if (
    !bundle ||
    typeof bundle !== 'object' ||
    (!Array.isArray(bundle.presets) && !Array.isArray(bundle.scenarios))
  )
    return {
      ok: false,
      error: '이 앱에서 내보낸 파일이 아닙니다 (presets · scenarios 를 찾을 수 없습니다).',
      ...zero,
    }

  const warnings: string[] = []
  let addedPresets = 0
  let addedScenarios = 0
  let replaced = 0
  let skipped = 0
  // 새 항목의 order — 내장 항목은 배열 인덱스(작은 정수)를 쓰므로 타임스탬프면 자연히 맨 뒤로
  // 붙는다. seq 를 더해 파일에 담긴 순서가 그대로 유지되게 한다(같은 ms 에 몰려 섞이는 것 방지).
  const base = Date.now()
  let seq = 0
  /** 건너뛴 이유는 앞의 몇 건만 남긴다 — 수십 줄을 띄워도 사용자가 읽지 않는다 */
  const warn = (m: string) => {
    if (warnings.length < 8) warnings.push(m)
  }

  try {
    await withStoreLock('customPresets', async () => {
      const list = await readCustomPresets()
      for (const rawItem of (Array.isArray(bundle.presets) ? bundle.presets : []) as unknown[]) {
        const item = cleanPreset(rawItem)
        if (!item) {
          skipped++
          warn(
            '프리셋 건너뜀 — 분류·이름·명령어 중 빈 값: ' +
              (cleanStr((rawItem as Record<string, unknown>)?.label) || '(이름 없음)'),
          )
          continue
        }
        const idx = list.findIndex((x) => x.id === item.id)
        if (idx >= 0) {
          // 덮어쓸 때 순서는 **이쪽 것을 유지**한다 — 남의 파일이 내 목록 배치를 흔들지 않게
          list[idx] = { ...item, order: list[idx].order }
          replaced++
        } else {
          list.push({ ...item, order: base + seq++ })
          addedPresets++
        }
      }
      await writeCustomPresets(list)
    })

    await withStoreLock('customScenarios', async () => {
      const list = await readCustomScenarios()
      for (const rawItem of (Array.isArray(bundle.scenarios) ? bundle.scenarios : []) as unknown[]) {
        const item = cleanScenario(rawItem)
        if (!item) {
          skipped++
          warn(
            '시나리오 건너뜀 — 분류·제목이 없거나 실행할 스텝이 없음: ' +
              (cleanStr((rawItem as Record<string, unknown>)?.title) || '(이름 없음)'),
          )
          continue
        }
        const idx = list.findIndex((x) => x.id === item.id)
        if (idx >= 0) {
          list[idx] = { ...item, order: list[idx].order }
          replaced++
        } else {
          list.push({ ...item, order: base + seq++ })
          addedScenarios++
        }
      }
      await writeCustomScenarios(list)
    })
  } catch (e) {
    // 저장소가 손상돼 읽기가 실패한 경우 — 절대 빈 목록으로 덮어쓰지 않고 그대로 알린다
    return { ok: false, error: e instanceof Error ? e.message : String(e), ...zero }
  }

  return { ok: true, addedPresets, addedScenarios, replaced, skipped, warnings }
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
    text = decodeTextFile(await readFile(filePath))
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
      // 내보내기/템플릿은 엑셀 호환용 BOM(U+FEFF)을 앞에 붙이므로, JSON.parse 전에 제거한다(안 하면 파싱 실패).
      arr = JSON.parse(text.replace(/^﻿/, ''))
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

  // 읽기~쓰기를 한 덩어리로 잠가, 동시에 들어온 자동저장이 가져온 항목을 덮어쓰지 않게 한다.
  const { added, skippedCount, list } = await withProfilesLock(async () => {
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
    return { added, skippedCount, list }
  })

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
      // jump(점프호스트)는 객체라 컬럼 하나에 JSON 으로 담는다. 예전엔 아예 빠져 있어서
      // CSV 로 내보냈다 되가져오면 점프호스트가 조용히 사라진 채 연결이 실패했다.
      const header = ['host', 'port', 'username', 'authMethod', 'password', 'privateKey', 'passphrase', 'label', 'group', 'startup', 'color', 'jump']
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
        '점프호스트 JSON(선택) 예: {"host":"10.0.0.1","port":"22","username":"root","password":"..."}',
      ].map(csvEscape)
      const rows = list.map((p) =>
        header
          .map((h) => {
            const v = (p as unknown as Record<string, unknown>)[h]
            if (v == null) return csvEscape('')
            // 객체(jump)는 JSON 문자열로 직렬화 — String(obj) 는 "[object Object]" 가 되어 값이 사라진다
            return csvEscape(typeof v === 'object' ? JSON.stringify(v) : String(v))
          })
          .join(','),
      )
      await writeFile(r.filePath, BOM + [header.join(','), guideRow.join(','), ...rows].join('\n') + '\n', 'utf-8')
    } else {
      // JSON 에는 BOM 을 붙이지 않는다 — 앞에 U+FEFF 가 있으면 jq/python json.load 등
      // 표준 파서가 전부 실패한다(BOM 은 엑셀 대응이 필요한 CSV 에만 의미가 있다).
      await writeFile(r.filePath, JSON.stringify([JSON_GUIDE_ENTRY, ...list], null, 2), 'utf-8')
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
/**
 * 한 SSH 연결에서 **동시에 열어 두는 exec 채널 수 제한.**
 *
 * 왜 필요한가 — `session:run` 은 호출마다 새 exec 채널을 연다. 상태보드 폴링은 한 세션에
 * 여러 건을 병렬로 던진다(파드 조회만 해도 `kubectl get nodes` 1 + 네임스페이스 N).
 * 여기에 ceph·서비스 데몬·OpenStack 조회가 겹치면 순간 동시 채널이 10개를 넘고,
 * OpenSSH 기본값(`MaxSessions 10`)에 걸린 요청은 이렇게 실패한다:
 *
 *     (SSH) Channel open failure: open failed
 *
 * 이게 화면에서는 "그 네임스페이스 조회 실패 = 확인 불가" 로 보인다 — 실제로는 파드가 아니라
 * **채널을 못 얻은 것**이라, 멀쩡한 대상이 간헐적으로 장애처럼 찍힌다.
 *
 * 그래서 연결별로 슬롯을 두고 초과분은 큐에 세운다. 총 처리량은 거의 그대로다(어차피 서버가
 * 동시에 그만큼밖에 안 받는다) — 실패가 대기로 바뀌는 것이다.
 */
const EXEC_LIMIT = 4
/**
 * 슬롯을 붙잡고 안 놓는 명령을 끊는 상한. 이게 없으면 죽은 노드를 향한 조회 하나가 채널을
 * 영구 점유해, 그 세션의 이후 모든 조회가 큐에서 굶는다(렌더러는 12초에 손을 떼지만
 * 메인 프로세스의 채널은 그대로 열려 있다).
 */
const EXEC_HARD_MS = 60_000
const execSlots = new WeakMap<Client, { active: number; queue: (() => void)[] }>()
function acquireExecSlot(client: Client): Promise<() => void> {
  let s = execSlots.get(client)
  if (!s) {
    s = { active: 0, queue: [] }
    execSlots.set(client, s)
  }
  const slot = s
  const release = () => {
    slot.active--
    slot.queue.shift()?.()
  }
  if (slot.active < EXEC_LIMIT) {
    slot.active++
    return Promise.resolve(release)
  }
  return new Promise((resolve) => {
    slot.queue.push(() => {
      slot.active++
      resolve(release)
    })
  })
}

/** exec 실행 본체 (슬롯 관리는 아래 execCapture 가 한다) */
function execCaptureRaw(
  client: Client,
  cmd: string,
  stdin?: string,
): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    client.exec(cmd, (err, stream) => {
      if (err) return reject(err)
      let out = ''
      let errOut = ''
      // 멀티바이트 문자가 청크 경계에 걸려 깨지지 않도록 StringDecoder 사용 (아래 다른 스트림들도 동일)
      const oDec = new StringDecoder('utf8')
      const eDec = new StringDecoder('utf8')
      const tid = setTimeout(() => {
        // 채널을 닫아 슬롯을 돌려준다 — 원격 프로세스가 남더라도 이 연결을 막지는 않게 한다
        try {
          stream.close()
        } catch {
          /* 이미 닫혔으면 무시 */
        }
        reject(new Error(`명령이 ${EXEC_HARD_MS / 1000}초 안에 끝나지 않아 채널을 닫았습니다`))
      }, EXEC_HARD_MS)
      stream.on('data', (d: Buffer) => (out += oDec.write(d)))
      stream.stderr.on('data', (d: Buffer) => (errOut += eDec.write(d)))
      // 시그널로 죽거나 채널이 강제로 끊기면 ssh2 는 code=null 을 준다. 이걸 0(성공)으로
      // 뭉개면 OOM·연결끊김으로 중단된 명령이 검증 리포트에 '정상'으로 기록된다 → 실패로 본다.
      stream.on('close', (code: number | null, signal?: string) => {
        clearTimeout(tid)
        resolve({
          code: code ?? (signal ? 128 : 255),
          out,
          err: errOut + (code == null ? `\n[프로세스가 비정상 종료되었습니다${signal ? ` (signal ${signal})` : ''}]` : ''),
        })
      })
      stream.end(stdin ?? '')
    })
  })
}

/** exec 실행 — 연결별 동시 채널 수를 지키며 실행한다(위 EXEC_LIMIT 주석 참고) */
async function execCapture(
  client: Client,
  cmd: string,
  stdin?: string,
): Promise<{ code: number; out: string; err: string }> {
  const release = await acquireExecSlot(client)
  try {
    return await execCaptureRaw(client, cmd, stdin)
  } finally {
    release()
  }
}

// ── 시나리오 검증용 영속 셸 (Runner Shell) ───────────────────────
/**
 * 시나리오 검증 러너 전용, '유지되는' 셸 채널.
 *
 * 왜 필요한가 — 기존에는 스텝마다 exec 채널을 새로 열었는데, 그 방식은 세 가지가 동시에 깨진다.
 *   1) `cd` 가 다음 스텝에 안 남는다 (정규식으로 cd 를 긁어 앞에 붙이는 땜질을 하고 있었고,
 *      파이프라인이나 서브셸이 섞이면 그 추출이 틀린다)
 *   2) export 한 환경변수도 안 남는다
 *   3) sudo 비밀번호·y/n 같은 대화형 프롬프트에 답할 수단이 없다
 *   4) 타임아웃 시 클라이언트만 손을 떼서, 원격에는 stress-ng/iperf3 가 좀비로 남는다
 *
 * 해결 — 검증 시작 시 PTY 셸을 하나 열어두고 명령을 순차로 밀어 넣는다.
 *   · cd/환경변수가 자연히 유지된다
 *   · 프롬프트가 뜨면 expect 규칙으로 응답을 써 넣을 수 있다
 *   · 타임아웃 시 Ctrl+C(0x03) 를 보내면 PTY 가 포그라운드 프로세스 그룹에 진짜 SIGINT 를 준다
 *
 * 종료 코드는 어떻게 아는가 — 셸에 밀어 넣는 방식은 exec 와 달리 exit status 를 안 준다.
 * 그래서 명령 뒤에 `printf '<마커>:%d:' "$?"` 를 붙여 출력에서 되읽는다(센티넬).
 * 마커에는 실행마다 다른 난수를 넣어, 사용자 명령이 우연히 같은 문자열을 출력해도 겹치지 않게 한다.
 */
interface RunnerShell {
  stream: ClientChannel
  /** 이 러너의 고유 마커 토큰 */
  token: string
  /** 아직 소비되지 않은 출력 버퍼 */
  buf: string
  /** 현재 실행 중인 명령의 대기자 (없으면 유휴) */
  waiter?: {
    marker: string
    /** dead 가 채워지면 '명령의 종료코드' 가 아니라 '셸이 죽었다'는 뜻이다 */
    resolve: (r: { code: number; out: string; dead?: string }) => void
    /** 이미 발동한 expect 규칙 인덱스 (프롬프트 반복 시 중복 응답 방지) */
    fired: Set<number>
    expect: ExpectRule[]
    /** 자동응답으로 실제 보낸 내용 요약 (리포트 표시용) */
    replied: string[]
    /** sudo 비밀번호를 이미 보냈는지 (반복 전송 방지) */
    sudoSent?: boolean
    /** 응답 없는 대화형 프롬프트를 감지해 걸어둔 타이머 */
    stuckTimer?: ReturnType<typeof setTimeout>
  }
  /** 이 세션의 로그인 비밀번호 — sudo 프롬프트 자동 응답에만 쓰고 렌더러로는 절대 내보내지 않는다 */
  password?: string
  decoder: StringDecoder
  closed: boolean
}

/**
 * 입력을 기다리는 대화형 프롬프트 패턴 (출력 '끝' 에 있을 때만 의미가 있다).
 * 이걸 못 알아채면 셸이 조용히 45초를 기다렸다가 "응답 시간 초과" 로 끝나서,
 * 사용자는 명령이 틀린 줄 알고 엉뚱한 데를 뒤지게 된다.
 */
const SUDO_PROMPT_RE = /\[sudo\] password for [^\n:]*:\s*$|^password( for [^\n:]*)?:\s*$/im
const ANY_PROMPT_RE =
  /(\[sudo\] password for [^\n:]*:|password( for [^\n:]*)?:|passphrase[^\n:]*:|\[y\/n\]|\[Y\/n\]|\(yes\/no[^)]*\)|Do you want to continue\?|Are you sure[^\n]*\?)\s*$/i
/** 프롬프트를 감지한 뒤 아무도 답하지 않으면 이만큼 기다렸다가 포기한다 */
const PROMPT_STUCK_MS = 2500
const runnerShells = new Map<string, RunnerShell>() // runnerId → shell
/** 한 명령의 출력 버퍼 상한 — 넘으면 앞부분을 버린다(센티넬은 끝에 오므로 판정에 지장 없음) */
const RUNNER_BUF_MAX = 4 * 1024 * 1024
const RUNNER_BUF_KEEP = 2 * 1024 * 1024

/** PTY 가 섞어 넣는 ANSI/커서 제어 시퀀스 제거 (센티넬 매칭과 출력 가독성 확보) */
// eslint-disable-next-line no-control-regex
const CTRL_SEQ_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-B]|[\x00\x07\x08\x0b\x0c\x0e\x0f]/g
const stripCtrl = (s: string) => s.replace(CTRL_SEQ_RE, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')

/** 러너 셸 열기 — PTY 셸을 띄우고 프롬프트/에코를 끈 뒤 준비될 때까지 기다린다 */
function openRunnerShell(
  client: Client,
  runnerId: string,
  password?: string,
): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    // 넓은 창 — 폭이 좁으면 셸이 긴 명령줄을 접어 출력에 섞어 넣는다
    client.shell({ term: 'dumb', rows: 200, cols: 512 }, (err, stream) => {
      if (err) return resolve({ ok: false, error: err.message })
      const token = randomUUID().replace(/-/g, '').slice(0, 12)
      const sh: RunnerShell = { stream, token, buf: '', decoder: new StringDecoder('utf8'), closed: false, password }
      runnerShells.set(runnerId, sh)

      const onChunk = (d: Buffer) => {
        sh.buf += sh.decoder.write(d)
        // 출력이 아주 큰 명령(대용량 로그 tail 등)에서 버퍼가 무한히 커지지 않게 앞쪽을 잘라낸다.
        // 센티넬은 항상 끝에 오므로 앞을 버려도 종료코드 판정에는 영향이 없다.
        if (sh.buf.length > RUNNER_BUF_MAX) {
          sh.buf = '…(앞부분 생략)\n' + sh.buf.slice(-RUNNER_BUF_KEEP)
        }
        pumpRunner(sh)
      }
      stream.on('data', onChunk)
      // PTY 셸은 stderr 도 같은 스트림으로 오지만, 서버 설정에 따라 분리될 수 있어 둘 다 받는다
      stream.stderr?.on('data', onChunk)
      const finish = () => {
        sh.closed = true
        // 대기 중인 명령이 있으면 실패로 깨워 러너가 영영 멈추지 않게 한다.
        // 이건 명령이 255 로 끝난 게 아니라 '중간에 연결이 끊긴' 것이므로 dead 로 구분한다 —
        // 노드를 재부팅하는 스텝에서 늘 일어나는 일이고, 종료코드로 위장하면 '검증 실패' 로 찍힌다.
        sh.waiter?.resolve({
          code: 255,
          out: sh.buf,
          dead: '명령 실행 중 세션 연결이 끊겼습니다 (노드 재부팅/네트워크 단절).',
        })
        sh.waiter = undefined
        // 이 셸이 아직 그 id 의 '현역'일 때만 지운다.
        // 재시작(runner:open)은 옛 셸에 exit 를 보내고 곧바로 새 셸을 같은 id 로 등록하는데,
        // 옛 셸의 close 이벤트는 그 뒤에 도착한다. 무조건 delete 하면 **방금 연 새 셸**이
        // 맵에서 사라져, 2회차 전체 실행이 전부 "검증용 셸이 닫혔습니다" 로 죽는다.
        if (runnerShells.get(runnerId) === sh) runnerShells.delete(runnerId)
      }
      stream.on('close', finish)
      stream.on('error', finish)

      // 프롬프트/에코/색상을 없애 출력에 잡음이 안 섞이게 한다.
      //  - stty -echo: 우리가 써 넣은 명령이 그대로 되돌아오는 것을 막음(센티넬 오탐 방지)
      //  - PS1/PROMPT_COMMAND 제거: 프롬프트 문자열이 출력에 끼는 것 방지
      //  - PS2 도 반드시 비운다: 명령을 `{ …여러 줄… } ; printf` 한 덩어리로 보내기 때문에 셸이
      //    닫는 `}` 를 기다리며 계속 프롬프트("> ")를 찍는다. 그게 매 스텝 출력 맨 앞에
      //    "> > " 로 섞여 나온다(사용자가 실제 화면에서 발견).
      stream.write(
        `PS1=''; PS2=''; PS3=''; PS4=''; PROMPT_COMMAND=''; unset LS_COLORS; stty -echo 2>/dev/null; export TERM=dumb\n`,
      )
      // 준비 완료를 센티넬로 확인 — 여기서 센티넬이 안 돌아오면 이 셸로는 종료코드를 읽을 수 없다.
      // (POSIX 가 아닌 셸, printf 없음, 프롬프트 억제 실패 등) 그런 셸을 ok 로 넘기면 이후 모든
      // 스텝이 45초씩 타임아웃되므로, 여기서 실패로 처리해 exec 호환 모드로 떨어뜨린다.
      runnerExec(runnerId, 'true', [], 15000)
        .then((r) => {
          if (r.timedOut) {
            closeRunnerShell(runnerId)
            return resolve({ ok: false, error: '셸이 응답하지 않습니다(종료코드 확인 실패).' })
          }
          if (r.code === 255) {
            closeRunnerShell(runnerId)
            return resolve({ ok: false, error: '셸이 즉시 종료되었습니다.' })
          }
          resolve({ ok: true })
        })
        .catch((e) => {
          closeRunnerShell(runnerId)
          resolve({ ok: false, error: e instanceof Error ? e.message : String(e) })
        })
    })
  })
}

/** 버퍼를 훑어 (1) expect 자동응답, (2) 센티넬 도착 여부를 처리 */
function pumpRunner(sh: RunnerShell): void {
  const w = sh.waiter
  if (!w) return
  const clean = stripCtrl(sh.buf)

  // 1) 대화형 프롬프트 자동 응답 — 아직 안 쓴 규칙만, 한 번씩
  w.expect.forEach((rule, i) => {
    if (w.fired.has(i) || !rule.match) return
    let re: RegExp
    try {
      re = new RegExp(rule.match, 'i')
    } catch {
      w.fired.add(i) // 잘못된 정규식은 조용히 건너뛴다(매 청크마다 예외가 나지 않도록)
      return
    }
    if (!re.test(clean)) return
    w.fired.add(i)
    w.replied.push(`${rule.match} → ${rule.secret ? '••••••' : rule.send}`)
    sh.stream.write(rule.send + '\n')
  })

  // 2) 센티넬 도착 확인 — `<marker>:<코드>:`
  const m = clean.match(new RegExp(`${w.marker}:(-?\\d+):`))
  if (m) {
    if (w.stuckTimer) clearTimeout(w.stuckTimer)
    const out = clean.slice(0, m.index).replace(/\n+$/, '')
    sh.buf = ''
    sh.waiter = undefined
    w.resolve({ code: parseInt(m[1], 10), out })
    return
  }

  // 3) 아직 센티넬이 안 왔다 — 입력을 기다리는 프롬프트에 걸린 건 아닌지 확인한다.
  //    (프롬프트는 개행 없이 줄 끝에 머무르므로 '버퍼 끝' 기준으로 본다)
  const tail = clean.slice(-300)

  // sudo 비밀번호는 이 세션에 로그인할 때 쓴 그 비밀번호로 자동 응답한다.
  // 같은 호스트에 같은 계정으로 보내는 것이라 새로 노출되는 정보가 없고,
  // 이게 없으면 sudo 가 들어간 스텝은 전부 타임아웃으로 죽는다.
  if (!w.sudoSent && sh.password && SUDO_PROMPT_RE.test(tail)) {
    w.sudoSent = true
    w.replied.push('[sudo] password → ••••••')
    sh.stream.write(sh.password + '\n')
    if (w.stuckTimer) {
      clearTimeout(w.stuckTimer)
      w.stuckTimer = undefined
    }
    return
  }

  if (ANY_PROMPT_RE.test(tail)) {
    // 아무도 답하지 않는 프롬프트 — 잠깐 기다렸다가 확실해지면 명확한 메시지로 끝낸다.
    // 45초 타임아웃까지 끌면 사용자는 "명령이 잘못됐나" 하고 엉뚱한 데를 뒤지게 된다.
    if (w.stuckTimer) return
    w.stuckTimer = setTimeout(() => {
      if (sh.waiter !== w) return
      const prompt = (stripCtrl(sh.buf).match(ANY_PROMPT_RE)?.[0] ?? '').trim()
      try {
        sh.stream.write('\x03') // 프롬프트에서 빠져나오기
      } catch {
        /* 이미 닫힘 */
      }
      const body = stripCtrl(sh.buf).replace(/\n+$/, '')
      sh.buf = ''
      sh.waiter = undefined
      w.resolve({
        code: 253,
        out: `${body}\n\n[입력 대기 상태로 멈춰 있어 중단했습니다 — 프롬프트: "${prompt}"]`,
      })
    }, PROMPT_STUCK_MS)
    return
  }

  // 프롬프트가 사라졌으면(출력이 더 나왔으면) 걸어둔 타이머는 취소
  if (w.stuckTimer) {
    clearTimeout(w.stuckTimer)
    w.stuckTimer = undefined
  }
}

/**
 * 러너 셸에서 명령 하나 실행.
 * 타임아웃 시 Ctrl+C 를 보내 원격 프로세스를 실제로 중단시킨다(좀비 방지) — 이게 exec 방식과의 결정적 차이.
 */
async function runnerExec(
  runnerId: string,
  cmd: string,
  expect: ExpectRule[],
  timeoutMs: number,
): Promise<{ code: number; out: string; timedOut?: boolean; replied: string[]; dead?: string }> {
  const sh = runnerShells.get(runnerId)
  // '셸이 죽었다' 는 명령의 실행 결과가 아니다. 종료코드처럼 돌려주면 렌더러가 이를 정상 실행으로
  // 보고 "종료 코드 255 → 실패" 로 판정해버린다. 노드를 재부팅하는 시나리오에서는 반드시 일어나는
  // 상황이라, 이후 모든 스텝이 '검증 실패' 로 찍혀 리포트를 통째로 못 믿게 된다. 별도 신호로 구분한다.
  if (!sh || sh.closed)
    return { code: 255, out: '', replied: [], dead: '검증용 셸이 닫혔습니다 — 세션 연결이 끊겼을 수 있습니다.' }
  if (sh.waiter) return { code: 255, out: '', replied: [], dead: '이 세션에서 이전 명령이 아직 실행 중입니다.' }

  const seq = Math.floor(Math.random() * 1e9)
  const marker = `__QT_${sh.token}_${seq}__`
  sh.buf = ''

  // 자동응답 기록은 waiter 가 비워진 뒤에도 읽어야 하므로 바깥에 붙잡아 둔다
  const replied: string[] = []
  const result = await new Promise<{ code: number; out: string; timedOut?: boolean; dead?: string }>((resolve) => {
    const w = { marker, resolve, fired: new Set<number>(), expect, replied }
    sh.waiter = w
    /**
     * 타임아웃이 발동해 Ctrl+C 를 보냈는지.
     *
     * 이걸 안 들고 있으면 아주 잘못된 결과가 나온다 — htop 처럼 SIGINT 를 받고 **0 으로**
     * 곱게 끝나는 명령은, Ctrl+C 직후 센티넬이 돌아오면서 "종료 코드 0 · 정상 실행" 으로
     * 기록된다. 45초를 붙잡고 있다가 강제로 끊긴 것을 성공이라고 말하는 셈이다.
     */
    let interrupted = false
    const timer = setTimeout(() => {
      if (sh.waiter !== w) return
      interrupted = true
      // Ctrl+C → PTY 가 포그라운드 프로세스 그룹에 SIGINT. 그 뒤 센티넬이 오면 정상 회수된다.
      try {
        sh.stream.write('\x03')
      } catch {
        /* 채널이 이미 죽었으면 무시 */
      }
      // SIGINT 로도 안 죽는 명령이 있으므로 잠깐 더 기다렸다가 강제로 깬다
      setTimeout(() => {
        if (sh.waiter !== w) return
        sh.waiter = undefined
        resolve({ code: 254, out: stripCtrl(sh.buf), timedOut: true })
      }, 2000)
    }, timeoutMs)
    // resolve 를 감싸 타이머 정리. 중단시킨 뒤에 돌아온 결과는 종료코드가 0 이더라도
    // '시간 초과로 끊은 것' 으로 표시한다 — 그 사실이 결과 해석의 전제다.
    w.resolve = (r) => {
      clearTimeout(timer)
      resolve(interrupted ? { ...r, timedOut: true } : r)
    }
    /**
     * 명령과 종료코드 센티넬을 `{ ... } ; printf` 한 덩어리로 보낸다.
     *
     * 예전에는 명령 줄과 printf 줄을 따로 보냈는데, 그러면 **stdin 을 읽는 명령이
     * printf 줄을 자기 입력으로 먹어버린다.** sudo 비밀번호 프롬프트가 대표적이다 —
     * 비밀번호 대신 printf 문장이 들어가고, 센티넬은 영영 실행되지 않아 45초 타임아웃이 난다.
     *
     * 중괄호 그룹은 셸이 닫는 `}` 까지 **다 읽은 뒤에** 실행하므로, 명령이 도는 시점에는
     * 입력 버퍼가 비어 있어 프롬프트가 정상적으로 사용자(=우리 자동응답)를 기다린다.
     * 서브셸이 아니라서 cd/export 가 다음 스텝까지 그대로 유지되는 것도 그대로다.
     */
    sh.stream.write(`{\n${cmd}\n} ; printf '\\n${marker}:%d:\\n' "$?"\n`)
  })

  return { ...result, replied }
}

function closeRunnerShell(runnerId: string): void {
  const sh = runnerShells.get(runnerId)
  if (!sh) return
  sh.closed = true
  try {
    sh.stream.write('\x03')
    sh.stream.end('exit\n')
  } catch {
    /* 이미 닫힘 */
  }
  runnerShells.delete(runnerId)
}

ipcMain.handle('runner:open', async (_evt, { sessionId, runnerId }: { sessionId: string; runnerId: string }) => {
  const s = getSession(sessionId)
  if (!s.client) return { ok: false, error: '연결되어 있지 않습니다.' }
  closeRunnerShell(runnerId) // 재시작 시 이전 셸 정리
  // sudo 프롬프트 자동 응답에 쓸 로그인 비밀번호를 셸에 붙여둔다(렌더러로는 나가지 않는다)
  return await openRunnerShell(s.client, runnerId, s.lastConfig?.password)
})

ipcMain.handle(
  'runner:exec',
  async (
    _evt,
    { runnerId, cmd, expect, timeoutMs }: { runnerId: string; cmd: string; expect?: ExpectRule[]; timeoutMs?: number },
  ) => {
    const r = await runnerExec(runnerId, cmd, expect ?? [], Math.min(Math.max(timeoutMs ?? 45000, 1000), 600000))
    // 셸 자체가 없거나 죽은 경우는 '실행 실패' 로 올린다 — 명령의 종료코드로 위장하면 안 된다
    if (r.dead) return { ok: false, error: r.dead }
    return { ok: true, ...r }
  },
)

ipcMain.handle('runner:interrupt', async (_evt, { runnerId }: { runnerId: string }) => {
  const sh = runnerShells.get(runnerId)
  if (!sh || sh.closed) return { ok: false, error: '셸이 열려 있지 않습니다.' }
  try {
    sh.stream.write('\x03')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
})

ipcMain.handle('runner:close', async (_evt, { runnerId }: { runnerId: string }) => {
  closeRunnerShell(runnerId)
  return { ok: true }
})

// ─────────────────────────────────────────────────────────────
// 서비스 포털 응답 감시 — HTTP 요청은 **메인 프로세스**에서 한다.
// (요청 함수 자체는 electron 비의존 모듈로 분리해 따로 검증한다 — portal-http.ts)
// ─────────────────────────────────────────────────────────────

ipcMain.handle(
  'portal:request',
  async (
    _evt,
    p: { url: string; method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number; insecure?: boolean },
  ): Promise<PortalHttpResult> => {
    try {
      return await portalRequest({
        url: p.url,
        method: p.method ?? 'GET',
        headers: p.headers ?? {},
        body: p.body,
        timeoutMs: Math.min(Math.max(p.timeoutMs ?? 10000, 1000), 120000),
        insecure: !!p.insecure,
      })
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  },
)

// ── 포털 감시 설정 저장 ────────────────────────────────────────
// 비밀번호가 들어가므로 SSH 프로필과 같은 규칙을 그대로 따른다:
// safeStorage 로 암호화 + 파일 락 + 원자적 쓰기.
const portalCfgPath = () => path.join(app.getPath('userData'), 'portal-watch.dat')

ipcMain.handle('portal:getConfig', async (): Promise<PortalConfig | null> => {
  return withStoreLock('portal', async () => {
    let raw: string
    try {
      raw = await readFile(portalCfgPath(), 'utf-8')
    } catch {
      return null // 아직 설정한 적 없음
    }
    const dec = decryptStr(raw)
    if (dec === null) return null
    try {
      return JSON.parse(dec) as PortalConfig
    } catch {
      // 파일은 있는데 못 읽는 경우 — null 을 주면 렌더러가 기본값을 저장해 덮어쓸 수 있으므로
      // 여기서는 던져서 '읽기 실패' 를 분명히 알린다.
      throw new Error('포털 감시 설정 파일을 읽을 수 없습니다 (손상 가능성).')
    }
  })
})

ipcMain.handle('portal:setConfig', async (_evt, cfg: PortalConfig) => {
  return withStoreLock('portal', async () => {
    await writeFileAtomic(portalCfgPath(), encryptStr(JSON.stringify(cfg)))
    return { ok: true }
  })
})

// ── 포털 로그인 창(삭제됨) ─────────────────────────
//
// 앞서는 앱 안에 브라우저 창을 띄워 포털에 로그인하고 그 세션 쿠키를 토큰으로 썼다.
// CONTRABASS 포털은 토큰이 만료되면 로그인 화면으로 떨어지며 쿠키를 통째로 지워서,
// 창 새로고침도 재발급 API 호출도 새 토큰을 주지 않았다(HTTP 200, 토큰 불변). 11분이면 죽는다.
// 지금은 아이디/비밀번호 로그인(portal:request 로 로그인 API 호출)만 쓴다.

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
        return reject(err)
      }
      let data = ''
      const dec = new StringDecoder('utf8')
      stream.on('data', (chunk: Buffer) => (data += dec.write(chunk)))
      stream.on('close', (code: number | null) => {
        resolve({ code: code ?? 0, data: data + dec.end() })
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

// ── 실시간 로그 뷰어 (tail -f / kubectl logs -f) ──────────────────
// 일반 exec(execCapture)는 종료(close)돼야 resolve 되므로 tail -f 처럼 끝나지 않는 명령엔 못 쓴다.
// 채널을 계속 열어두고 데이터가 올 때마다 logtail:data 이벤트로 흘려보내는 전용 스트리밍 실행기.
// target 종류(파일/파드)에 따라 명령만 다르고, 스트리밍 배관(그레이스 판정/전달/종료처리)은 공용이다.
function buildTailCommand(target: LogTailTarget, usePty: boolean, tailLines = 200): string {
  // 초기 로드 줄 수 — "이전 로그 더 보기"로 늘려 재시작할 수 있게 파라미터화(과도한 값 방지 상한).
  const n = Math.min(Math.max(Math.floor(tailLines) || 200, 1), 50000)
  if (target.kind === 'file') {
    const q = shQuote(target.path)
    return usePty ? `sudo -S -p '' tail -f -n ${n} ${q}` : `tail -f -n ${n} ${q}`
  }
  const podQ = shQuote(target.pod)
  const nsQ = shQuote(target.namespace)
  const containerFlag = target.container ? ` -c ${shQuote(target.container)}` : ''
  return `kubectl logs -f --tail=${n} ${podQ} -n ${nsQ}${containerFlag}`
}

ipcMain.handle(
  'logtail:start',
  async (
    _evt,
    {
      sessionId,
      target,
      sudoPassword,
      tailLines,
    }: { sessionId: string; target: LogTailTarget; sudoPassword?: string; tailLines?: number },
  ) => {
    const s = getSession(sessionId)
    const client = s.client
    if (!client) return { ok: false, error: '연결되어 있지 않습니다.' }
    const tailId = randomUUID()
    // sudo(PTY) 는 파일 tail 에서 권한 문제가 있을 때만 쓴다 — kubectl logs 는 대상이 아님
    const usePty = target.kind === 'file' && !!sudoPassword
    const cmd = buildTailCommand(target, usePty, tailLines)

    return new Promise<{ ok: boolean; tailId?: string; needSudoPassword?: boolean; error?: string }>((resolve) => {
      const onStream = (err: Error | undefined, stream: ClientChannel) => {
        if (err) return resolve({ ok: false, error: err.message })
        // grace 기간이 끝나기 전에 뷰어가 닫혀 logtail:stop 이 먼저 호출되면(빠르게 닫은 경우),
        // 등록이 안 되어 있어 stop 이 아무 것도 못 닫고 조용히 무시되던 문제가 있었다.
        // grace 기간을 기다리지 않고 채널을 얻는 즉시 등록해서, stop 이 언제 오든 바로 닫히게 한다.
        if (!s.logTailStreams) s.logTailStreams = new Map()
        s.logTailStreams.set(tailId, stream)
        let earlyText = '' // 시작 후 잠깐(grace) 동안의 출력 — 즉시 실패(권한없음/파일없음) 판별용
        let settled = false
        const forward = (data: string) => {
          mainWindow?.webContents.send('logtail:data', { sessionId, tailId, data })
        }
        // 로그는 길고 한글이 섞이기 쉬워 청크 경계 깨짐이 특히 잘 보인다 → StringDecoder 필수
        const tailOutDec = new StringDecoder('utf8')
        const tailErrDec = new StringDecoder('utf8')
        stream.on('data', (d: Buffer) => {
          const text = tailOutDec.write(d)
          if (!text) return
          if (!settled) earlyText += text
          else forward(text)
        })
        if (!usePty) {
          // PTY 모드는 stdout/stderr 가 한 스트림으로 합쳐지므로 별도 처리 불필요
          stream.stderr.on('data', (d: Buffer) => {
            const text = tailErrDec.write(d)
            if (!text) return
            if (!settled) earlyText += text
            else forward(text)
          })
        }
        stream.on('close', () => {
          if (s.logTailStreams?.get(tailId) === stream) s.logTailStreams.delete(tailId)
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
          if (earlyText) forward(earlyText) // 오류가 아니었으므로 grace 기간 중 출력도 그대로 전달
          resolve({ ok: true, tailId })
        }, 700)
      }
      if (usePty) client.exec(cmd, { pty: true }, onStream)
      else client.exec(cmd, onStream)
    })
  },
)

ipcMain.handle('logtail:stop', async (_evt, { sessionId, tailId }: { sessionId: string; tailId: string }) => {
  const s = getSession(sessionId)
  const stream = s.logTailStreams?.get(tailId)
  if (stream) {
    try {
      stream.close()
    } catch {
      /* 무시 */
    }
    s.logTailStreams?.delete(tailId)
  }
  return { ok: true }
})

// ── TCP 포트 열림 확인 ────────────────────────────────────────
/**
 * 지정 host:port 로 TCP 연결만 시도해보고 즉시 끊는다(가용성 검증 상태보드 전용).
 *
 * 용도: IPMI 로 전원을 내린 노드를 다시 올렸을 때 SSH(22) 가 살아났는지 감시.
 * 살아있는 다른 노드에서 `nc` 를 돌리는 방법도 있지만, '죽은 노드를 감시하려고
 * 멀쩡한 노드에 명령을 쏘는' 구조가 되어 검증 대상에 영향을 준다. PC 에서 직접 확인한다.
 *
 * 연결에 성공해도 아무 데이터도 주고받지 않고 바로 destroy 하므로 부작용이 없다.
 */
ipcMain.handle(
  'net:probeTcp',
  async (_evt, { host, port, timeoutMs }: { host: string; port: number; timeoutMs?: number }) => {
    if (!host || !Number.isFinite(port)) return { ok: false, open: false, error: '주소가 올바르지 않습니다.' }
    const limit = Math.min(Math.max(timeoutMs ?? 3000, 500), 15000)
    const open = await new Promise<boolean>((resolve) => {
      const sock = new net.Socket()
      let settled = false
      const finish = (v: boolean) => {
        if (settled) return
        settled = true
        sock.destroy()
        resolve(v)
      }
      sock.setTimeout(limit)
      sock.once('connect', () => finish(true))
      sock.once('timeout', () => finish(false))
      sock.once('error', () => finish(false))
      try {
        sock.connect(port, host)
      } catch {
        finish(false)
      }
    })
    return { ok: true, open }
  },
)

// ── Kubernetes 파드 로그용 탐색 (네임스페이스/파드/컨테이너 목록) ──────
// kubectl 이 없거나 클러스터 접근 권한이 없으면 kubectl 자체 에러 메시지를 그대로 보여준다.
ipcMain.handle('k8s:listNamespaces', async (_evt, { sessionId }: { sessionId: string }) => {
  const client = sessions.get(sessionId)?.client
  if (!client) return { ok: false, error: 'SSH 연결이 없습니다.' }
  try {
    const r = await execCapture(client, `kubectl get ns --no-headers -o custom-columns=:metadata.name 2>&1`)
    if (r.code !== 0) return { ok: false, error: r.out.trim() || '네임스페이스 조회 실패' }
    return { ok: true, namespaces: r.out.split('\n').map((s) => s.trim()).filter(Boolean) }
  } catch (e) {
    return { ok: false, error: cleanErrorMessage(e) }
  }
})

ipcMain.handle(
  'k8s:listPods',
  async (_evt, { sessionId, namespace }: { sessionId: string; namespace: string }) => {
    const client = sessions.get(sessionId)?.client
    if (!client) return { ok: false, error: 'SSH 연결이 없습니다.' }
    try {
      const r = await execCapture(
        client,
        `kubectl get pods -n ${shQuote(namespace)} --no-headers -o custom-columns=:metadata.name 2>&1`,
      )
      if (r.code !== 0) return { ok: false, error: r.out.trim() || '파드 조회 실패' }
      return { ok: true, pods: r.out.split('\n').map((s) => s.trim()).filter(Boolean) }
    } catch (e) {
      return { ok: false, error: cleanErrorMessage(e) }
    }
  },
)

ipcMain.handle(
  'k8s:listContainers',
  async (
    _evt,
    { sessionId, namespace, pod }: { sessionId: string; namespace: string; pod: string },
  ) => {
    const client = sessions.get(sessionId)?.client
    if (!client) return { ok: false, error: 'SSH 연결이 없습니다.' }
    try {
      const r = await execCapture(
        client,
        `kubectl get pod ${shQuote(pod)} -n ${shQuote(namespace)} -o jsonpath='{.spec.containers[*].name}' 2>&1`,
      )
      if (r.code !== 0) return { ok: false, error: r.out.trim() || '컨테이너 조회 실패' }
      return { ok: true, containers: r.out.trim().split(/\s+/).filter(Boolean) }
    } catch (e) {
      return { ok: false, error: cleanErrorMessage(e) }
    }
  },
)

// 설정파일 백업을 모으는 고정 베이스 경로 (원본 디렉토리를 더럽히지 않도록 분리).
// 이 아래에 원본 경로 구조를 그대로 미러링해 저장한다. (변경하려면 이 값만 수정)
// ── Kubernetes ConfigMap 보기 / 수정 ──────────────────────────────
//
// 설정파일 뷰어의 'ConfigMap 모드' 백엔드. 파일(SFTP) 경로와 다른 점이 셋이다.
//  1) 쓰기는 **바꾼 키만** `kubectl patch --type merge` 로 보낸다. 나머지 키는 요청에 들어가지도
//     않으므로 실수로 지워지지 않는다. 여러 키를 고쳐도 **한 번만** 보낸다(중간 상태·중복 롤아웃 방지).
//  2) 적용 직전에 resourceVersion 을 다시 읽어 그 사이 바뀌었으면 **적용하지 않는다.**
//  3) 백업은 그 서버가 아니라 **내 PC(userData)** 에 남긴다. ConfigMap 은 클러스터 객체라
//     kubectl 이 있던 호스트에 두면 이력이 흩어지고, /var/tmp 는 청소되는 곳이다.

const cmBackupDir = () => path.join(app.getPath('userData'), 'configmap-backups')
/** 폴더명에 쓸 수 있는 글자만 남긴다 (k8s 이름은 소문자·숫자·`-`·`.` 뿐이지만 host·context 는 아니다) */
const cmSeg = (v: string) => ((v ?? '').trim().replace(/[^a-zA-Z0-9._-]/g, '_') || '-')

/**
 * 백업 폴더명 = `host~context~namespace~name`.
 *
 * **환경(host·context)을 키에 넣는 이유**: 예전에는 `ns__name` 만 썼다. 그러면 개발/운영의
 * 같은 이름 ConfigMap 백업이 한 폴더에 섞여서
 *   · 보관 개수 정리가 **다른 환경의 백업을 지우고**
 *   · 이력에서 어느 클러스터의 것인지 구분할 수 없고
 *   · 내보내 apply 할 때 **다른 환경의 YAML 을 복원**할 수 있었다.
 *
 * 구분자가 `~` 인 이유: cmSeg 가 허용하는 글자에 `~` 가 없으므로 **항상 4조각으로 쪼개진다.**
 * `__` 를 쓰면 cmSeg 가 만든 `__`(연속된 특수문자)와 구분되지 않는다.
 */
const cmBackupKey = (origin: CmBackupOrigin, ns: string, name: string) =>
  [cmSeg(origin.host ?? ''), cmSeg(origin.context ?? ''), cmSeg(ns), cmSeg(name)].join('~')

/**
 * 폴더명에서 (namespace, name) 을 되읽는다.
 * `~` 가 없는 폴더는 v2.6.0 이전에 만든 `ns__name` 이다 — 버리지 않고 환경 미기록으로 읽는다.
 */
function cmParseDir(dir: string): { namespace: string; name: string } | null {
  if (dir.includes('~')) {
    const p = dir.split('~')
    if (p.length !== 4 || !p[2] || !p[3]) return null
    return { namespace: p[2], name: p[3] }
  }
  const sep = dir.indexOf('__')
  if (sep <= 0) return null // 우리가 만든 폴더가 아니다
  return { namespace: dir.slice(0, sep), name: dir.slice(sep + 2) }
}

/**
 * 백업마다 환경을 적어 두는 사이드카(`<stamp>.json`). 평문이다.
 *
 * host·별칭·컨텍스트·계정은 비밀이 아니고(비밀은 `.dat` 안의 값이다), 평문이면
 * **safeStorage 로 `.dat` 를 못 읽는 상황(다른 OS 사용자)에서도 "어느 환경이었는지" 는 남는다.**
 * 목록을 그릴 때마다 20개를 복호화하지 않아도 되는 것도 이유다.
 */
const cmMetaName = (datFile: string) => datFile.replace(/\.dat$/, '.json')

async function cmReadOrigin(dir: string, datFile: string): Promise<CmBackupOrigin | undefined> {
  try {
    const raw = await readFile(path.join(dir, cmMetaName(datFile)), 'utf-8')
    const o = JSON.parse(raw) as CmBackupOrigin
    if (!o || typeof o !== 'object') return undefined
    // 폴더명에서 유추하지 않는다 — cmSeg 를 거친 값은 원본이 아니다(`a@b` → `a_b`)
    return { host: o.host, context: o.context, alias: o.alias, user: o.user }
  } catch {
    return undefined // v2.6.0 이전 백업 또는 사이드카 유실
  }
}

/** cm 하나당 보관 개수 — 무한정 쌓이지 않게. 오래된 것부터 지운다 */
const CM_BACKUP_KEEP = 20

/**
 * 지금 이 세션이 가리키는 환경.
 *
 * context 조회는 **실패해도 막지 않는다** — kubeconfig 가 없거나 권한이 없는 서버도 있고,
 * 그렇다고 백업·적용을 못 하게 만들면 안 된다. 못 읽으면 host 만으로 폴더를 가른다.
 * (별칭은 렌더러가 가진 값이라 인자로 받는다 — 메인에는 탭 이름이 없다)
 */
async function cmOriginOf(sessionId: string, alias?: string): Promise<CmBackupOrigin> {
  const s = sessions.get(sessionId)
  const origin: CmBackupOrigin = {
    host: s?.lastConfig?.host,
    user: s?.lastConfig?.username,
    alias: alias?.trim() || undefined,
  }
  if (s?.client) {
    const r = await execCapture(s.client, 'kubectl config current-context 2>/dev/null').catch(() => null)
    const ctx = (r?.out ?? '').trim()
    // 한 줄짜리 컨텍스트 이름만 받는다. 오류 문구가 섞여 오면 환경 이름으로 쓰면 안 된다.
    if (r?.code === 0 && ctx && !ctx.includes('\n') && ctx.length <= 253) origin.context = ctx
  }
  return origin
}

/** kubectl 을 그 세션에서 실행 — 실패 메시지는 kubectl 원문을 그대로 올린다(권한·컨텍스트 문제를 감추지 않는다) */
async function kubectlJson(
  sessionId: string,
  args: string,
): Promise<{ ok: true; json: unknown } | { ok: false; error: string }> {
  const client = sessions.get(sessionId)?.client
  if (!client) return { ok: false, error: 'SSH 연결이 없습니다.' }
  const r = await execCapture(client, `kubectl ${args} 2>&1`)
  const out = (r.out ?? '').trim()
  if (r.code !== 0) return { ok: false, error: out || 'kubectl 실행 실패' }
  try {
    return { ok: true, json: JSON.parse(out) }
  } catch {
    // JSON 을 기대했는데 아닌 경우 = kubectl 이 에러 문구만 뱉은 것. 앞부분을 그대로 보여준다.
    return { ok: false, error: out.slice(0, 300) || '응답을 해석할 수 없습니다.' }
  }
}

ipcMain.handle('k8s:listConfigMaps', async (_evt, { sessionId, namespace }: { sessionId: string; namespace: string }) => {
  const client = sessions.get(sessionId)?.client
  if (!client) return { ok: false, error: 'SSH 연결이 없습니다.' }
  try {
    // NAME DATA AGE 세 컬럼. custom-columns 로 고정해 서식 변화에 흔들리지 않게 한다.
    const r = await execCapture(
      client,
      `kubectl get cm -n ${shQuote(namespace)} --no-headers -o custom-columns=:metadata.name,:metadata.creationTimestamp 2>&1`,
    )
    const out = (r.out ?? '').trim()
    if (r.code !== 0) return { ok: false, error: out || 'ConfigMap 조회 실패' }
    const items: ConfigMapRef[] = []
    for (const line of out.split('\n')) {
      const cols = line.trim().split(/\s+/)
      if (cols.length < 2) continue
      // 이름 형태가 아니면 kubectl 에러 문구다 (뽑은 값을 형태로 교차 검증)
      if (!/^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/.test(cols[0])) continue
      items.push({ name: cols[0], keys: 0, age: cols[1] })
    }
    return { ok: true, items }
  } catch (e) {
    return { ok: false, error: cleanErrorMessage(e) }
  }
})

ipcMain.handle(
  'k8s:getConfigMap',
  async (_evt, { sessionId, namespace, name }: { sessionId: string; namespace: string; name: string }) => {
    try {
      // -o json 으로 받는다. YAML 을 직접 파싱하면 들여쓰기·인용 규칙을 우리가 다시 구현해야 한다.
      const r = await kubectlJson(sessionId, `get cm ${shQuote(name)} -n ${shQuote(namespace)} -o json`)
      if (!r.ok) return { ok: false, error: r.error }
      const o = r.json as {
        metadata?: { resourceVersion?: string; creationTimestamp?: string }
        data?: Record<string, unknown>
        binaryData?: Record<string, unknown>
      }
      const data: Record<string, string> = {}
      for (const [k, v] of Object.entries(o.data ?? {})) if (typeof v === 'string') data[k] = v
      const detail: ConfigMapDetail = {
        namespace,
        name,
        data,
        binaryKeys: Object.keys(o.binaryData ?? {}),
        resourceVersion: o.metadata?.resourceVersion ?? '',
        creationTimestamp: o.metadata?.creationTimestamp ?? '',
      }
      return { ok: true, detail }
    } catch (e) {
      return { ok: false, error: cleanErrorMessage(e) }
    }
  },
)

/** 읽기 전용 YAML 전문 — 편집은 하지 않는다(kubectl edit 과 달리 우리 화면엔 문법 검증이 없다) */
ipcMain.handle(
  'k8s:getConfigMapYaml',
  async (_evt, { sessionId, namespace, name }: { sessionId: string; namespace: string; name: string }) => {
    const client = sessions.get(sessionId)?.client
    if (!client) return { ok: false, error: 'SSH 연결이 없습니다.' }
    try {
      const r = await execCapture(client, `kubectl get cm ${shQuote(name)} -n ${shQuote(namespace)} -o yaml 2>&1`)
      const out = r.out ?? ''
      if (r.code !== 0) return { ok: false, error: out.trim() || 'YAML 조회 실패' }
      return { ok: true, yaml: out }
    } catch (e) {
      return { ok: false, error: cleanErrorMessage(e) }
    }
  },
)

ipcMain.handle(
  'k8s:patchConfigMap',
  async (
    _evt,
    payload: {
      sessionId: string
      namespace: string
      name: string
      /** 바꿀 키만. 값은 문자열(ConfigMap data 는 전부 문자열이어야 한다) */
      changes: Record<string, string>
      /** 불러온 시점의 resourceVersion — 이 값이 달라졌으면 적용하지 않는다 */
      baseResourceVersion: string
      /** 세션 별칭(표시용). 백업 이력에서 "어느 세션에서 고쳤는지" 를 답하기 위해 함께 남긴다 */
      alias?: string
    },
  ): Promise<ConfigMapPatchResult> => {
    const { sessionId, namespace, name, changes, baseResourceVersion, alias } = payload
    const keys = Object.keys(changes)
    if (keys.length === 0) return { ok: false, error: '변경할 항목이 없습니다.' }
    const client = sessions.get(sessionId)?.client
    if (!client) return { ok: false, error: 'SSH 연결이 없습니다.' }
    try {
      // 0) 환경(host·kubectl context)을 **먼저** 읽는다.
      //    원본 YAML 을 읽은 뒤에 하면 그 kubectl 호출만큼 '조회 → patch' 사이가 벌어져
      //    남이 끼어들 창이 넓어진다. 이 값은 조회 결과와 무관하므로 앞에서 구해도 된다.
      const origin = await cmOriginOf(sessionId, alias)

      // 1) 적용 직전 원본 YAML 확보 — 백업과 충돌 검사를 같은 스냅샷으로 한다
      const cur = await execCapture(client, `kubectl get cm ${shQuote(name)} -n ${shQuote(namespace)} -o yaml 2>&1`)
      const yaml = cur.out ?? ''
      if (cur.code !== 0) return { ok: false, error: (yaml.trim() || '원본 조회 실패') }
      // resourceVersion 은 YAML 에서 뽑는다(별도 조회를 또 하면 그 사이가 다시 벌어진다)
      const rvLine = yaml.split('\n').find((l) => l.trim().startsWith('resourceVersion:'))
      const nowRv = rvLine ? rvLine.split(':')[1].trim().replace(/"/g, '') : ''
      if (baseResourceVersion && nowRv && nowRv !== baseResourceVersion)
        return {
          ok: false,
          conflict: true,
          error: `불러온 뒤 이 ConfigMap 이 바뀌었습니다 (resourceVersion ${baseResourceVersion} → ${nowRv}). 다시 불러와 확인하세요.`,
        }

      // 2) 백업을 **먼저** 남긴다. 실패하면 적용하지 않는다 — 되돌릴 수단 없이 클러스터를 바꾸지 않는다.
      //    (파일 저장도 같은 규칙이다: 백업 실패 시 저장 중단)
      //    환경(host·context)까지 폴더에 넣어 다른 클러스터의 백업과 섞이지 않게 한다.
      const dir = path.join(cmBackupDir(), cmBackupKey(origin, namespace, name))
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const backupPath = path.join(dir, `${stamp}.dat`)
      try {
        await mkdir(dir, { recursive: true })
        // 값에 토큰·비밀번호가 그대로 들어 있다 → 평문으로 두지 않는다
        await writeFileAtomic(backupPath, encryptStr(yaml))
        // 환경 사이드카는 실패해도 적용을 막지 않는다 — 되돌릴 YAML 은 이미 남았고,
        // 여기서 중단하면 '표시용 정보' 때문에 변경을 못 하게 된다. 그 백업만 미기록으로 보인다.
        await writeFileAtomic(path.join(dir, cmMetaName(`${stamp}.dat`)), JSON.stringify(origin)).catch(
          () => undefined,
        )
      } catch (e) {
        return { ok: false, error: '백업에 실패해 적용하지 않았습니다: ' + cleanErrorMessage(e) }
      }

      // 3) 바꾼 키만 한 번에 보낸다. --type merge 는 data 안의 키를 병합하므로 나머지는 그대로 남는다.
      const patch = JSON.stringify({ data: changes })
      const r = await execCapture(
        client,
        `kubectl patch cm ${shQuote(name)} -n ${shQuote(namespace)} --type merge -p ${shQuote(patch)} 2>&1`,
      )
      const out = (r.out ?? '').trim()
      if (r.code !== 0) return { ok: false, error: out || 'patch 실패', backupPath }

      // 4) 보관 개수 초과분 정리 (오래된 것부터)
      try {
        const files = (await readdir(dir)).filter((f) => f.endsWith('.dat')).sort()
        for (const f of files.slice(0, Math.max(0, files.length - CM_BACKUP_KEEP))) {
          await unlink(path.join(dir, f)).catch(() => undefined)
          await unlink(path.join(dir, cmMetaName(f))).catch(() => undefined) // 사이드카를 남기면 고아가 쌓인다
        }
      } catch {
        /* 정리 실패는 적용 결과에 영향을 주지 않는다 */
      }

      const after = await execCapture(
        client,
        `kubectl get cm ${shQuote(name)} -n ${shQuote(namespace)} -o jsonpath={.metadata.resourceVersion} 2>&1`,
      )
      return {
        ok: true,
        applied: keys.length,
        backupPath,
        resourceVersion: after.code === 0 ? (after.out ?? '').trim() : undefined,
      }
    } catch (e) {
      return { ok: false, error: cleanErrorMessage(e) }
    }
  },
)

/**
 * 백업 폴더 전체를 훑어 목록을 만든다. 한 ConfigMap 만 볼 때도 **폴더 하나만 보지 않는다** —
 * 같은 ns/이름의 백업이 환경마다 다른 폴더에 있으므로, 그것을 모아 환경 라벨과 함께 보여줘야
 * "어디를 고쳤는지" 가 드러난다.
 */
async function cmScanBackups(only?: { namespace: string; name: string }): Promise<ConfigMapBackup[]> {
  const base = cmBackupDir()
  const out: ConfigMapBackup[] = []
  let dirs: string[]
  try {
    dirs = await readdir(base)
  } catch {
    return out // 폴더가 아직 없는 것은 오류가 아니다
  }
  for (const d of dirs) {
    const parsed = cmParseDir(d)
    if (!parsed) continue
    if (only && (parsed.namespace !== only.namespace || parsed.name !== only.name)) continue
    let files: string[]
    try {
      files = (await readdir(path.join(base, d))).filter((f) => f.endsWith('.dat'))
    } catch {
      continue
    }
    for (const f of files) {
      const st = await stat(path.join(base, d, f)).catch(() => null)
      // 파일을 쓴 시각이 곧 백업 시각이다 — 파일명을 되파싱하지 않는다
      out.push({
        at: st?.mtimeMs ?? 0,
        file: f,
        namespace: parsed.namespace,
        name: parsed.name,
        sizeBytes: st?.size ?? 0,
        dir: d,
        origin: await cmReadOrigin(path.join(base, d), f),
      })
    }
  }
  return out.sort((a, b) => b.at - a.at)
}

/** 백업 이력 — 되돌릴 것을 고르기 위한 목록 (이 ConfigMap, 모든 환경) */
ipcMain.handle('k8s:cmBackupList', async (_evt, { namespace, name }: { namespace: string; name: string }) => {
  return { ok: true, items: await cmScanBackups({ namespace, name }) }
})

/**
 * **모든** ConfigMap 의 백업을 한 목록으로. "최근에 내가 어디를 바꿨지" 를 답하기 위한 것이라
 * cm 별로 묶지 않고 시각 역순으로 준다.
 */
ipcMain.handle('k8s:cmBackupListAll', async () => {
  const out = await cmScanBackups()
  // 화면에 200 건 넘게 뿌릴 이유가 없다. 잘렸다는 사실은 개수로 드러난다(configMaps · items.length)
  return { ok: true, items: out.slice(0, 200), configMaps: new Set(out.map((b) => `${b.namespace}/${b.name}`)).size }
})

/** 지금 세션이 가리키는 환경 — 이력의 백업이 '다른 환경의 것'인지 화면에서 가리기 위해 쓴다 */
ipcMain.handle('k8s:cmEnv', async (_evt, { sessionId, alias }: { sessionId: string; alias?: string }) => {
  return { ok: true, origin: await cmOriginOf(sessionId, alias) }
})

/**
 * 백업을 평문 YAML 로 내보낸다. **평문이 되는 순간은 사용자가 명시적으로 고른 이 시점뿐이다** —
 * 되돌리려면 결국 평문이 필요하지만, 그 파일을 어디에 둘지는 사용자가 정해야 한다.
 */
ipcMain.handle(
  'k8s:cmBackupExport',
  async (_evt, { dir, file, name }: { dir: string; file: string; name: string }) => {
    // 경로 조작 방어 — 폴더명·파일명만 받는다(둘 다 목록이 돌려준 값 그대로여야 한다)
    const bad = (v: string) => !v || v.includes('/') || v.includes('\\') || v.includes('..')
    if (bad(file) || bad(dir)) return { saved: false, error: '잘못된 경로입니다.' }
    const src = path.join(cmBackupDir(), dir, file)
    let yaml: string
    try {
      yaml = decryptStr(await readFile(src, 'utf-8')) ?? ''
      if (!yaml) return { saved: false, error: '백업을 복호화할 수 없습니다 (다른 OS 사용자가 만든 파일일 수 있습니다).' }
    } catch (e) {
      return { saved: false, error: cleanErrorMessage(e) }
    }
    const r = await dialog.showSaveDialog(mainWindow ?? undefined!, {
      title: 'ConfigMap 백업 내보내기',
      defaultPath: `${name}-${file.replace(/\.dat$/, '')}.yaml`,
      filters: [{ name: 'YAML', extensions: ['yaml', 'yml'] }],
    })
    if (r.canceled || !r.filePath) return { saved: false }
    try {
      await writeFile(r.filePath, yaml, 'utf-8')
      return { saved: true, path: r.filePath }
    } catch (e) {
      return { saved: false, error: cleanErrorMessage(e) }
    }
  },
)


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

    // 3) 실패 롤백 — 위의 쓰기 경로(SFTP 직접쓰기 / tee / cat >) 는 모두 '열면서 잘라내기'라,
    //    중간에 끊기면 원본이 0바이트나 반쪽짜리로 남는다. /etc 설정 파일에서는 치명적이므로
    //    백업이 있으면 되돌린다. (백업이 없으면 cp 가 그냥 실패하고 끝 — 부작용 없음)
    let restored = false
    if (bk.ok || up.ok) {
      const rb = await execEscalatedNoStdin(
        s,
        (pfx) => `${pfx}cp -a -- ${shQuote(backupPath)} ${q}`,
        sudoPw,
      )
      restored = rb.ok
    }

    const noSudo = lastErr.includes('sudo 권한이 없습니다')
    const rollbackNote = restored
      ? ' 원본은 백업본으로 되돌렸습니다.'
      : bk.ok || up.ok
        ? ` 원본 복구에 실패했습니다 — 백업본을 직접 확인하세요: ${backupPath}`
        : ''
    return {
      ok: false,
      needSudoPassword: !noSudo,
      restored,
      backupPath: bk.ok || up.ok ? backupPath : undefined,
      error:
        (noSudo ? lastErr : `저장 실패(권한). ${lastErr || 'sudo 비밀번호를 입력해 다시 시도하세요.'}`) +
        rollbackNote,
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

/**
 * 락 키 — 같은 호스트의 append 와 trim 을 한 줄로 세운다.
 *
 * 둘이 겹치면 trim 이 읽은 뒤 쓰기 전에 들어온 append 가 통째로 사라진다(read-modify-write).
 * 다른 저장소들과 같은 규칙을 여기에도 적용한다.
 */
const metricsLockKey = (host: string) => `metrics:${sanitizeHost(host)}`

/** 락을 이미 쥔 쪽에서 부르는 본체 — 안에서 다시 락을 잡으면 자기 차례를 기다리다 멈춘다 */
async function trimMetricsHistoryLocked(host: string): Promise<void> {
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
    // 임시 파일 → rename. 그냥 덮어쓰면 쓰는 도중 앱이 죽었을 때 이력이 반토막 난다
    await writeFileAtomic(p, kept.length ? kept.join('\n') + '\n' : '')
  } catch {
    /* 파일 없음 등은 무시 */
  }
}

/** 실패해도 실시간 모니터링에 영향 없도록 best-effort 로 로컬 이력에 추가 */
async function appendMetricsHistory(sample: MetricSample): Promise<void> {
  try {
    await mkdir(metricsHistoryDir(), { recursive: true })
    const key = metricsLockKey(sample.host)
    await withStoreLock(key, () =>
      appendFile(metricsHistoryPath(sample.host), JSON.stringify(sample) + '\n', 'utf-8'),
    )
    const n = (historyAppendCounts.get(sample.host) ?? 0) + 1
    historyAppendCounts.set(sample.host, n)
    // 정리는 **락을 놓은 뒤** 다시 잡는다 — 위 락 안에서 부르면 자기 차례를 기다리다 멈춘다
    if (n % 200 === 0) await withStoreLock(key, () => trimMetricsHistoryLocked(sample.host))
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

// 특정 프로세스 kill (SIGTERM → 잠깐 대기 후에도 살아있으면 SIGKILL).
// 참고: `kill pid`는 신호 전달에 성공하기만 하면 exit 0 을 반환하므로(프로세스가 실제로 죽는지는
// 안 기다림), SIGTERM 을 트랩/무시하는 프로세스에도 "성공"으로 오판할 수 있었다. 마지막에
// kill -0 으로 실제 생존 여부를 확인해 그 결과를 그대로 반환한다.
ipcMain.handle(
  'monitor:killProc',
  async (_evt, { sessionId, pid }: { sessionId: string; pid: number }) => {
    const client = sessions.get(sessionId)?.client
    if (!client) return { ok: false, error: 'SSH 연결이 없습니다.' }
    try {
      const r = await execCapture(
        client,
        `kill ${pid} 2>/dev/null; sleep 0.3; ` +
          `if kill -0 ${pid} 2>/dev/null; then kill -9 ${pid} 2>/dev/null; sleep 0.2; fi; ` +
          `kill -0 ${pid} 2>/dev/null && echo ALIVE || echo DEAD`,
      )
      if (/ALIVE/.test(r.out)) {
        return { ok: false, error: '프로세스를 종료하지 못했습니다 (권한 부족이거나 신호를 무시하는 프로세스일 수 있습니다).' }
      }
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

// ─────────────────────────────────────────────────────────────
// 성능 테스트 (Locust) — 부하는 이 PC 에서, 대상만 세션에서 가져온다.
//
// 실행 한 번에 요건이 다 채워지는 명령 조합을 쓴다:
//   locust -f <file> --host <url> -u <n> -r <n> -t <s>
//          --autostart --autoquit 3            ← 사람이 웹 UI 에서 시작을 안 눌러도 되게
//          --html <report> --csv <prefix>      ← 종료 후 리포트·통계
//          --web-host 127.0.0.1 --web-port <p> ← 돌고 있는 동안의 대시보드(앱 안 iframe)
//
// `--headless` 는 쓰지 않는다 — 그러면 대시보드가 안 뜬다. `--autostart` 가 그 자리를 메운다.
// 웹 주소를 127.0.0.1 로 묶는 이유는 부하 도구의 조작 화면이 사내망에 열리지 않게 하는 것이다.
// ─────────────────────────────────────────────────────────────
const perfRunsDir = () => path.join(app.getPath('userData'), 'perf-runs')
const perfSettingsPath = () => path.join(app.getPath('userData'), 'perf-settings.json')

interface PerfSettings {
  /** 사용자가 직접 지정한 locust 실행 파일 경로 (PATH 에 없을 때) */
  locustPath?: string
}
async function readPerfSettings(): Promise<PerfSettings> {
  try {
    const raw = JSON.parse(await readFile(perfSettingsPath(), 'utf-8'))
    return typeof raw?.locustPath === 'string' ? { locustPath: raw.locustPath } : {}
  } catch {
    return {}
  }
}

/** 실행 중인 성능 테스트 (동시에 하나만 — 두 개를 돌리면 서로의 부하가 결과를 오염시킨다) */
interface PerfRun {
  meta: PerfRunMeta
  child: ChildProcess
  dir: string
  /** 100ms 배칭 버퍼 — 줄마다 IPC 를 보내면 렌더러가 멎는다 */
  pending: { stdout: string; stderr: string }
  flushTimer?: ReturnType<typeof setTimeout>
  decoders: { stdout: StringDecoder; stderr: StringDecoder }
  finished: boolean
}
let perfRun: PerfRun | null = null

/** `locust --version` 을 실제로 실행해 본다 — 파일이 있는지만 보면 파이썬이 깨진 경우를 놓친다 */
function tryVersion(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    let out = ''
    let done = false
    const finish = (v: string | null) => {
      if (done) return
      done = true
      resolve(v)
    }
    try {
      const child = spawn(cmd, args, { windowsHide: true })
      child.stdout?.on('data', (b: Buffer) => (out += b.toString('utf-8')))
      child.stderr?.on('data', (b: Buffer) => (out += b.toString('utf-8')))
      child.on('error', () => finish(null))
      child.on('close', (code) => finish(code === 0 && /locust/i.test(out) ? out.trim().split('\n')[0] : null))
      setTimeout(() => {
        try {
          child.kill()
        } catch {
          /* 무시 */
        }
        finish(null)
      }, 8000)
    } catch {
      finish(null)
    }
  })
}

const PERF_INSTALL_HINT =
  'Python 3.9 이상을 설치한 뒤 명령 프롬프트에서 `pip install locust` 를 실행하세요. ' +
  '설치했는데도 안 잡히면 아래에서 locust 실행 파일 경로를 직접 지정할 수 있습니다.'

/**
 * 환경 점검.
 *
 * 없는 것을 "실패" 로만 알리지 않는다 — **무엇이 없고 무엇을 하면 되는지**를 같이 돌려준다.
 * 이 앱을 쓰는 사람은 파이썬 환경 담당이 아니라 인프라 검증 담당이다.
 */
ipcMain.handle('perf:env', async (): Promise<PerfEnvStatus> => {
  const { locustPath } = await readPerfSettings()
  if (locustPath) {
    const v = await tryVersion(locustPath, ['--version'])
    if (v) return { ok: true, how: locustPath, version: v }
    return {
      ok: false,
      problem: `지정한 경로로 locust 를 실행할 수 없습니다: ${locustPath}`,
      hint: '경로를 다시 지정하거나 비워 두면 PATH 에서 찾습니다.',
    }
  }
  const direct = await tryVersion('locust', ['--version'])
  if (direct) return { ok: true, how: 'locust (PATH)', version: direct }

  // pip 로 설치했는데 스크립트 폴더가 PATH 에 없는 경우가 흔하다 — 모듈로 한 번 더 시도한다
  for (const py of ['python', 'python3', 'py']) {
    const viaModule = await tryVersion(py, ['-m', 'locust', '--version'])
    if (viaModule) return { ok: true, how: `${py} -m locust`, version: viaModule }
  }
  const anyPython = await (async () => {
    for (const py of ['python', 'python3', 'py']) {
      const v = await new Promise<string | null>((resolve) => {
        try {
          const c = spawn(py, ['--version'], { windowsHide: true })
          let o = ''
          c.stdout?.on('data', (b: Buffer) => (o += b.toString()))
          c.stderr?.on('data', (b: Buffer) => (o += b.toString()))
          c.on('error', () => resolve(null))
          c.on('close', (code) => resolve(code === 0 ? o.trim().split('\n')[0] : null))
        } catch {
          resolve(null)
        }
      })
      if (v) return v
    }
    return null
  })()

  return {
    ok: false,
    problem: anyPython
      ? `${anyPython} 는 있지만 locust 가 설치돼 있지 않습니다.`
      : 'Python 과 locust 를 찾을 수 없습니다.',
    hint: anyPython ? '명령 프롬프트에서 `pip install locust` 를 실행하세요.' : PERF_INSTALL_HINT,
  }
})

ipcMain.handle('perf:setLocustPath', async (_evt, p: string | null) => {
  await writeFileAtomic(perfSettingsPath(), JSON.stringify({ locustPath: p || undefined }, null, 2))
  return { ok: true }
})
ipcMain.handle('perf:getLocustPath', async () => (await readPerfSettings()).locustPath ?? '')

/** 파이썬 문자열 리터럴로 안전하게 (따옴표·역슬래시·개행이 코드를 깨뜨리지 않게) */
const pyStr = (v: string) => JSON.stringify(String(v ?? ''))

/**
 * 폼 입력 → locustfile.py.
 *
 * 명령어(와 파이썬)를 몰라도 한 번은 돌려볼 수 있어야 한다는 판단이다. 생성한 파일은 회차
 * 폴더에 그대로 남기므로, 사람이 열어 고친 뒤 '파일 고르기' 로 다시 쓸 수 있다.
 */
function buildLocustfile(cfg: PerfRunConfig): string {
  const sc = cfg.scenario
  if (sc.kind !== 'form') return ''
  // 먼저 다듬고 나서 앞의 `/` 를 붙인다 — 순서를 바꾸면 `'  /health  '` 가 `'/  /health  '` 가 된다
  const paths = sc.paths
    .map((x) => (x ?? '').trim())
    .filter(Boolean)
    .map((x) => (x.startsWith('/') ? x : '/' + x))
  const targets = paths.length ? paths : ['/']
  const headers = Object.entries(sc.headers ?? {}).filter(([k]) => k.trim())
  const wMin = Math.max(0, sc.waitMinSec)
  const wMax = Math.max(wMin, sc.waitMaxSec)

  const tasks = targets
    .map((t, i) => {
      const nameArg = `name=${pyStr(t)}`
      const hdrArg = headers.length ? ', headers=HEADERS' : ''
      if (sc.method === 'POST') {
        const bodyArg = sc.body?.trim() ? `, data=${pyStr(sc.body)}` : ''
        return [
          `    @task`,
          `    def t${i}(self):`,
          `        self.client.post(${pyStr(t)}, ${nameArg}${bodyArg}${hdrArg})`,
        ].join('\n')
      }
      return [`    @task`, `    def t${i}(self):`, `        self.client.get(${pyStr(t)}, ${nameArg}${hdrArg})`].join(
        '\n',
      )
    })
    .join('\n\n')

  // 빈 줄을 filter 로 걸러내지 않는다 — 사람이 열어서 고칠 파일이므로 줄 간격이 남아야 한다.
  // (예전에 `.filter(l => l !== '')` 로 조건부 줄을 지우려다 의도한 빈 줄까지 다 먹었다.)
  const out: string[] = [
    '# Q-Term 이 폼 입력으로 만든 파일입니다.',
    '# 폼에서 다시 만들면 덮어씁니다 — 직접 고친 내용을 지키려면 다른 이름으로 저장한 뒤',
    "# '파일 고르기' 로 선택하세요.",
    'from locust import HttpUser, task, between',
    '',
  ]
  if (headers.length) {
    out.push('HEADERS = {' + headers.map(([k, v]) => `${pyStr(k)}: ${pyStr(v)}`).join(', ') + '}', '')
  }
  out.push('', 'class QTermUser(HttpUser):', `    wait_time = between(${wMin}, ${wMax})`)
  if (cfg.insecureTls) {
    out.push(
      '',
      '    def on_start(self):',
      '        # 사내 인프라의 자체 서명 인증서를 무시한다 (설정에서 켠 경우에만)',
      '        self.client.verify = False',
    )
  }
  out.push('', tasks, '')
  return out.join('\n')
}

/** 비어 있는 TCP 포트 찾기 — 8089 가 이미 쓰이고 있으면 대시보드가 안 뜬다 */
function findFreePort(start: number): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.once('error', () => resolve(start < start + 20 ? findFreePort(start + 1) : start))
    srv.once('listening', () => {
      const port = (srv.address() as net.AddressInfo).port
      srv.close(() => resolve(port))
    })
    srv.listen(start, '127.0.0.1')
  })
}

/**
 * 프로세스 트리를 죽인다.
 *
 * Windows 에서 `child.kill()` 은 자식을 남긴다 — locust 는 파이썬 런처를 거쳐 뜨는 경우가
 * 있어 껍데기만 죽고 부하가 계속 나간다. 그건 "중지를 눌렀는데 서비스가 계속 맞는" 상황이다.
 */
function killTree(child: ChildProcess): void {
  const pid = child.pid
  if (!pid) return
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
    } catch {
      try {
        child.kill()
      } catch {
        /* 무시 */
      }
    }
  } else {
    try {
      process.kill(-pid, 'SIGTERM')
    } catch {
      try {
        child.kill('SIGTERM')
      } catch {
        /* 무시 */
      }
    }
  }
}

function perfFlush(run: PerfRun): void {
  const { stdout, stderr } = run.pending
  run.pending = { stdout: '', stderr: '' }
  run.flushTimer = undefined
  if (stdout) mainWindow?.webContents.send('perf:log', { runId: run.meta.id, stream: 'stdout', text: stdout })
  if (stderr) mainWindow?.webContents.send('perf:log', { runId: run.meta.id, stream: 'stderr', text: stderr })
}
function perfPush(run: PerfRun, stream: 'stdout' | 'stderr', text: string): void {
  run.pending[stream] += text
  if (!run.flushTimer) run.flushTimer = setTimeout(() => perfFlush(run), 100)
}

async function writeRunMeta(dir: string, meta: PerfRunMeta): Promise<void> {
  await writeFileAtomic(path.join(dir, 'run.json'), JSON.stringify(meta, null, 2))
}

ipcMain.handle('perf:start', async (_evt, cfg: PerfRunConfig) => {
  if (perfRun && !perfRun.finished) {
    return { ok: false, error: '이미 성능 테스트가 돌고 있습니다. 먼저 중지하세요.' }
  }
  const { locustPath } = await readPerfSettings()
  // 실행 방법을 여기서 다시 정한다 — 점검 결과를 렌더러가 들고 오는 구조로 만들면
  // 그 사이에 환경이 바뀐 경우를 못 잡는다.
  let cmd = locustPath || 'locust'
  let baseArgs: string[] = []
  if (!locustPath) {
    const direct = await tryVersion('locust', ['--version'])
    if (!direct) {
      let found = false
      for (const py of ['python', 'python3', 'py']) {
        if (await tryVersion(py, ['-m', 'locust', '--version'])) {
          cmd = py
          baseArgs = ['-m', 'locust']
          found = true
          break
        }
      }
      if (!found) return { ok: false, error: 'locust 를 찾을 수 없습니다. 환경 점검을 먼저 확인하세요.' }
    }
  }

  const id = randomUUID()
  const dir = path.join(perfRunsDir(), id)
  await mkdir(dir, { recursive: true })

  // 시나리오 파일 준비
  let scenarioPath: string
  if (cfg.scenario.kind === 'file') {
    scenarioPath = cfg.scenario.path
    try {
      await stat(scenarioPath)
    } catch {
      return { ok: false, error: `시나리오 파일을 찾을 수 없습니다: ${scenarioPath}` }
    }
  } else {
    scenarioPath = path.join(dir, 'locustfile.py')
    await writeFileAtomic(scenarioPath, buildLocustfile(cfg))
  }

  const port = await findFreePort(8089)
  const csvPrefix = path.join(dir, 'run')
  const reportPath = path.join(dir, 'report.html')
  const args = [
    ...baseArgs,
    '-f',
    scenarioPath,
    '--host',
    cfg.targetUrl,
    '-u',
    String(Math.max(1, Math.round(cfg.users))),
    '-r',
    String(Math.max(1, Math.round(cfg.spawnRate))),
    '-t',
    `${Math.max(1, Math.round(cfg.durationSec))}s`,
    '--autostart',
    // 끝나고 바로 죽이면 웹 UI 가 사라져 마지막 화면을 못 본다. 3초 여유.
    '--autoquit',
    '3',
    '--html',
    reportPath,
    '--csv',
    csvPrefix,
    '--web-host',
    '127.0.0.1',
    '--web-port',
    String(port),
  ]

  const meta: PerfRunMeta = {
    id,
    startedAt: Date.now(),
    config: cfg,
    webUrl: `http://127.0.0.1:${port}`,
    reportPath,
    csvPrefix,
    scenarioPath,
  }
  await writeRunMeta(dir, meta)

  let child: ChildProcess
  try {
    child = spawn(cmd, args, {
      cwd: dir,
      windowsHide: true,
      // 유니코드 출력이 물음표로 깨지지 않게
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
      detached: process.platform !== 'win32',
    })
  } catch (e) {
    return { ok: false, error: cleanErrorMessage(e) }
  }

  const run: PerfRun = {
    meta,
    child,
    dir,
    pending: { stdout: '', stderr: '' },
    decoders: { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') },
    finished: false,
  }
  perfRun = run

  child.stdout?.on('data', (b: Buffer) => perfPush(run, 'stdout', run.decoders.stdout.write(b)))
  child.stderr?.on('data', (b: Buffer) => perfPush(run, 'stderr', run.decoders.stderr.write(b)))
  child.on('error', (err) => {
    perfPush(run, 'stderr', `\n[실행 실패] ${cleanErrorMessage(err)}\n`)
  })
  child.on('close', async (code) => {
    if (run.finished) return
    run.finished = true
    if (run.flushTimer) clearTimeout(run.flushTimer)
    perfFlush(run)
    run.meta.endedAt = Date.now()
    run.meta.exitCode = code ?? undefined
    await writeRunMeta(run.dir, run.meta).catch(() => {})
    mainWindow?.webContents.send('perf:done', {
      runId: run.meta.id,
      exitCode: code ?? undefined,
      canceled: run.meta.canceled,
    })
  })

  return { ok: true, meta }
})

ipcMain.handle('perf:cancel', async () => {
  if (!perfRun || perfRun.finished) return { ok: false, error: '돌고 있는 테스트가 없습니다.' }
  // 중지한 회차는 그 사실을 남긴다 — 중간에 끊긴 수치를 '결과' 로 읽으면 안 된다
  perfRun.meta.canceled = true
  await writeRunMeta(perfRun.dir, perfRun.meta).catch(() => {})
  killTree(perfRun.child)
  return { ok: true }
})

/** 회차 목록 (최신순) + 통계 CSV 원본. 요약 계산은 렌더러(src/lib/perfParse)가 한다 */
ipcMain.handle('perf:list', async (): Promise<PerfRunRecord[]> => {
  let ids: string[]
  try {
    ids = await readdir(perfRunsDir())
  } catch {
    return []
  }
  const out: PerfRunRecord[] = []
  for (const id of ids) {
    try {
      const dir = path.join(perfRunsDir(), id)
      const meta = JSON.parse(await readFile(path.join(dir, 'run.json'), 'utf-8')) as PerfRunMeta
      let statsCsv: string | undefined
      try {
        statsCsv = await readFile(path.join(dir, 'run_stats.csv'), 'utf-8')
      } catch {
        /* 중지·실패한 회차는 통계가 없다 */
      }
      out.push({ meta, statsCsv })
    } catch {
      /* 손상된 폴더는 건너뛴다 */
    }
  }
  return out.sort((a, b) => b.meta.startedAt - a.meta.startedAt)
})

ipcMain.handle('perf:delete', async (_evt, id: string) => {
  if (perfRun && !perfRun.finished && perfRun.meta.id === id) {
    return { ok: false, error: '돌고 있는 회차는 지울 수 없습니다.' }
  }
  // 경로 조립에 id 를 그대로 쓰지 않는다 — 상위 경로 탈출을 막는다
  if (!/^[0-9a-f-]{36}$/i.test(id)) return { ok: false, error: '잘못된 회차 id' }
  await rm(path.join(perfRunsDir(), id), { recursive: true, force: true })
  return { ok: true }
})

/**
 * 종료 후 리포트를 **별도 창**으로 띄운다.
 *
 * iframe 을 쓰지 않는 이유: 렌더러 출처가 dev 는 http://localhost, 배포는 file:// 이라
 * `file://` 리포트를 끼우면 개발 중에는 Chromium 이 막는다(= 개발 중 확인 불가). 돌고 있는
 * 동안의 대시보드는 http 라서 iframe 으로 들어가고, 정적 리포트만 이 창을 쓴다.
 */
ipcMain.handle('perf:openReport', async (_evt, id: string) => {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return { ok: false, error: '잘못된 회차 id' }
  const file = path.join(perfRunsDir(), id, 'report.html')
  try {
    await stat(file)
  } catch {
    return { ok: false, error: '리포트 파일이 없습니다. (중지된 회차이거나 실행이 실패했습니다)' }
  }
  const win = new BrowserWindow({
    width: 1200,
    height: 900,
    title: '성능 테스트 리포트',
    backgroundColor: '#ffffff',
    // 리포트는 우리가 만든 문서가 아니다 — 어떤 API 도 주지 않는다
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  })
  win.setMenuBarVisibility(false)
  await win.loadFile(file)
  return { ok: true }
})

ipcMain.handle('perf:openFolder', async (_evt, id: string) => {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return { ok: false, error: '잘못된 회차 id' }
  await shell.openPath(path.join(perfRunsDir(), id))
  return { ok: true }
})

/** 시나리오 파일 고르기 */
ipcMain.handle('perf:pickScenario', async () => {
  const r = await dialog.showOpenDialog(mainWindow!, {
    title: 'locustfile 선택',
    filters: [{ name: 'Python', extensions: ['py'] }],
    properties: ['openFile'],
  })
  if (r.canceled || !r.filePaths[0]) return { path: '' }
  return { path: r.filePaths[0] }
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
  // 기록 중인 세션 로그를 제대로 마무리한다. 이걸 안 하면 인덱스에 endedAt 이 없는 '기록중'
  // 유령 항목이 남아 자동 보관 정리에서 영구 제외되고(계속 쌓임), 평문 로그 끝부분도 유실된다.
  await Promise.all(
    [...sessions.values()].map(async (s) => {
      try {
        s.logStream?.end()
      } catch {
        /* 무시 */
      }
      s.logStream = undefined
      await finalizeLogSession(s).catch(() => {})
    }),
  )
  // 모든 세션의 SSH 연결/로컬 셸 정리
  for (const s of sessions.values()) {
    cleanupConnection(s)
    killLocalShell(s)
    // 재접속 루프가 창 종료 후에도 살아 getSession 으로 세션을 되살리는 것을 막는다
    s.userClosed = true
    s.reconnecting = false
  }
  sessions.clear()
  monitors.clear()
  // 부하는 별도 프로세스라 창을 닫아도 계속 돈다 — 창을 닫았는데 서비스가 계속 맞는 것을 막는다
  if (perfRun && !perfRun.finished) {
    perfRun.meta.canceled = true
    killTree(perfRun.child)
  }
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
