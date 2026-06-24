import { app, BrowserWindow, ipcMain, dialog, shell, safeStorage } from 'electron'
import path from 'node:path'
import os from 'node:os'
import { writeFile, readFile, unlink } from 'node:fs/promises'
import { Client, type ClientChannel } from 'ssh2'
import * as pty from 'node-pty'
import { streamChat, listModels } from './ai-providers'
import {
  PROVIDER_INFO,
  ANALYSIS_STYLES,
  type SSHConfig,
  type ConnectResult,
  type SSHStatusEvent,
  type AIRequest,
  type SavedProfile,
  type AIProvider,
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
  connecting: boolean // 연결 진행 중에는 로컬 셸 자동 시작 억제
}

const sessions = new Map<string, Session>()

/** 세션 조회 — 없으면 생성 */
function getSession(id: string): Session {
  let s = sessions.get(id)
  if (!s) {
    s = { id, client: null, shellStream: null, localPty: null, connecting: false }
    sessions.set(id, s)
  }
  return s
}

/** sudo -S 에 시도할 비밀번호 후보 (명시 입력 → 캐시 → 접속 비밀번호 순, 중복/빈값 제거) */
function sudoPwCandidates(s: Session, explicit?: string): string[] {
  return [...new Set([explicit, s.sudoPassword, s.lastPassword].filter((p): p is string => !!p))]
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
    s.localPty.onData((d) =>
      mainWindow?.webContents.send('terminal:data', { sessionId: s.id, data: d }),
    )
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
    width: 1440,
    height: 900,
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

/** 해당 세션의 SSH 연결 정리 (로컬 셸은 건드리지 않음) */
function cleanupConnection(s: Session) {
  s.shellStream?.end()
  s.shellStream = null
  s.client?.end()
  s.client = null
  s.lastPassword = undefined
  s.sudoPassword = undefined
}

// ── IPC: SSH 연결 요청 ─────────────────────────────────────────
// 렌더러 → 메인.  접속 후 인터랙티브 쉘(shell)을 열고,
// 쉘의 출력 데이터를 'terminal:data' 채널로 (sessionId 와 함께) 렌더러에 전달한다.
ipcMain.handle(
  'ssh:connect',
  async (_evt, sessionId: string, config: SSHConfig): Promise<ConnectResult> => {
    const s = getSession(sessionId)
    // 연결 진행 중 표시 + 로컬 셸 정리(원격으로 전환)
    s.connecting = true
    killLocalShell(s)
    // 이전 연결이 있으면 정리
    cleanupConnection(s)

    s.lastPassword = config.password || undefined

    return new Promise<ConnectResult>((resolve) => {
      const conn = new Client()
      s.client = conn

      conn
        .on('ready', () => {
          sendStatus(sessionId, {
            status: 'connected',
            message: `${config.username}@${config.host} 연결됨`,
          })

          // 인터랙티브 쉘 오픈 (PTY 포함)
          conn.shell({ term: 'xterm-256color' }, (err, stream) => {
            if (err) {
              sendStatus(sessionId, { status: 'error', message: `쉘 오픈 실패: ${err.message}` })
              resolve({ success: false, message: err.message })
              return
            }

            s.shellStream = stream

            // 서버 → 터미널: 쉘 출력 데이터를 렌더러로 전달
            stream.on('data', (data: Buffer) => {
              mainWindow?.webContents.send('terminal:data', {
                sessionId,
                data: data.toString('utf-8'),
              })
            })
            stream.stderr.on('data', (data: Buffer) => {
              mainWindow?.webContents.send('terminal:data', {
                sessionId,
                data: data.toString('utf-8'),
              })
            })
            stream.on('close', () => {
              sendStatus(sessionId, { status: 'closed', message: '쉘 세션 종료' })
              cleanupConnection(s)
              startLocalShell(s) // 원격 종료 → 로컬 셸로 복귀
            })

            s.connecting = false
            resolve({ success: true, message: '연결 성공' })
          })
        })
        .on('error', (err) => {
          s.connecting = false
          sendStatus(sessionId, { status: 'error', message: err.message })
          startLocalShell(s) // 연결 실패 → 로컬 셸 복귀
          resolve({ success: false, message: err.message })
        })
        .on('close', () => {
          sendStatus(sessionId, { status: 'closed', message: '연결 종료됨' })
          if (!s.connecting) startLocalShell(s) // 전환 중이 아니면 로컬 복귀
        })

      sendStatus(sessionId, { status: 'connecting', message: `${config.host} 연결 시도 중...` })

      // 비밀번호 / 개인키 인증 모두 지원
      conn.connect({
        host: config.host,
        port: config.port,
        username: config.username,
        password: config.password,
        privateKey: config.privateKey,
        passphrase: config.passphrase,
        readyTimeout: 20000,
        // 죽은 세션(서버측 종료/타임아웃)을 감지하기 위한 keepalive.
        // 15초마다 probe, 3회 무응답이면 연결을 끊고 'close' 이벤트 발생.
        keepaliveInterval: 15000,
        keepaliveCountMax: 3,
      })
    })
  },
)

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
  cleanupConnection(s)
  sendStatus(sessionId, { status: 'closed', message: '사용자 요청으로 연결 종료' })
  startLocalShell(s) // 연결 해제 → 로컬 셸로 복귀
})

// ── IPC: 세션 닫기 (탭 제거) — 연결/로컬셸 모두 정리 ──────────────
ipcMain.on('session:close', (_evt, sessionId: string) => {
  const s = sessions.get(sessionId)
  if (!s) return
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

// 저장된 접속 기록 목록
ipcMain.handle('profiles:list', async () => readProfiles())

// 프로필 추가/갱신 (최근 사용을 맨 앞으로)
ipcMain.handle('profiles:upsert', async (_evt, profile: SavedProfile) => {
  const list = (await readProfiles()).filter((p) => profileKey(p) !== profileKey(profile))
  list.unshift(profile)
  await writeProfiles(list)
  return list
})

// 특정 프로필 삭제 (key = host:port:username)
ipcMain.handle('profiles:delete', async (_evt, key: string) => {
  const list = (await readProfiles()).filter((p) => profileKey(p) !== key)
  await writeProfiles(list)
  return list
})

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

// 파일 쓰기(저장) — 저장 전 자동 백업(.bak.타임스탬프) → SFTP → sudo tee 폴백
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

    // 0) 저장 전 원본 자동 백업 → 같은 폴더의 .ivk_backups/ 안에 모음 (실패 시 저장 중단)
    //    파일명 규칙: <원본파일명>_<YYYYMMDDHHMMSS>
    const d = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    const ts =
      `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
      `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
    const slash = payload.path.lastIndexOf('/')
    const dir = slash > 0 ? payload.path.slice(0, slash) : '.'
    const base = payload.path.slice(slash + 1)
    const backupDir = `${dir}/.ivk_backups`
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

// ── 앱 라이프사이클 ────────────────────────────────────────────
app.whenReady().then(createWindow)

app.on('window-all-closed', () => {
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
