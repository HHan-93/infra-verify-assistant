import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import {
  Server,
  Plug,
  PlugZap,
  Loader2,
  ChevronDown,
  ChevronUp,
  Eye,
  EyeOff,
  FileKey,
} from 'lucide-react'
import type { SSHConfig, SavedProfile, JumpProfile } from '../../electron/shared-types'

type AuthMethod = 'password' | 'key' | 'agent'

/** App 에서 ref 로 호출 — 사이드바 더블클릭 등으로 특정 프로필 즉시 연결 */
export interface SSHFormHandle {
  connectProfile: (p: SavedProfile) => void
  /** 빠른 연결: 폼에 host/port/user 채우고 펼침 (인증은 사용자가 완료) */
  prefill: (v: { host: string; port?: string; user?: string }) => void
}

interface SSHFormProps {
  /** 이 폼이 제어하는 세션(탭) ID */
  sessionId: string
  /** 'connecting' | 'connected' | 'closed' | 'error' | 'idle' */
  status: string
  /** 저장된 프로필 목록 (App 이 소유) — 최초 1회 자동 채움에 사용 */
  profiles: SavedProfile[]
  /** 연결 성공 시 호출 (탭 제목/연결표시용으로 프로필 전달) */
  onConnected: (p: SavedProfile) => void
  onError: (msg: string) => void
  /** 연결 시 자동 저장으로 프로필 목록이 바뀌면 App 에 알림 */
  onProfilesChanged: (list: SavedProfile[]) => void
}

/**
 * 좌측 상단 SSH 접속 정보 입력 폼.
 *  - IP / Port / User / 인증(비밀번호 or 개인키) 입력 후 '연결'
 *  - 저장된 접속 기록 관리는 좌측 세션 사이드바로 이관됨
 */
const SSHForm = forwardRef<SSHFormHandle, SSHFormProps>(function SSHForm(
  { sessionId, status, profiles, onConnected, onError, onProfilesChanged },
  ref,
) {
  const [host, setHost] = useState('')
  const [port, setPort] = useState('22')
  const [username, setUsername] = useState('root')
  const [authMethod, setAuthMethod] = useState<AuthMethod>('password')
  const [password, setPassword] = useState('')
  const [privateKey, setPrivateKey] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [remember, setRemember] = useState(true)
  // 점프 호스트(Bastion) — 등록/편집 모달에서 설정, 폼에서는 보존·전달만
  const [jump, setJump] = useState<JumpProfile | undefined>(undefined)
  // 접속 후 자동 실행 명령 (등록/편집 모달에서 설정, 폼에서는 보존·전달)
  const [startup, setStartup] = useState<string | undefined>(undefined)

  // 실제로 연결된 프로필 (헤더 요약 표시용)
  const [connectedProfile, setConnectedProfile] = useState<SavedProfile | null>(null)
  // 연결/해제 전 확인(Y/N) 옵션 (기본 ON)
  const [confirmActions, setConfirmActions] = useState(true)
  // 연결/해제 확인용 다이얼로그
  const [pending, setPending] = useState<{
    message: string
    label: string
    danger?: boolean
    onYes: () => void
  } | null>(null)
  // 비밀번호/패스프레이즈 표시 토글
  const [showPw, setShowPw] = useState(false)

  const isBusy = status === 'connecting'
  const isConnected = status === 'connected'

  // 연결되면 접고, 끊기면 펼침 + 실제 연결 프로필 해제
  const [collapsed, setCollapsed] = useState(false)
  useEffect(() => {
    setCollapsed(status === 'connected')
    if (status === 'closed' || status === 'error' || status === 'idle') {
      setConnectedProfile(null)
    }
  }, [status])

  // 확인옵션 로드 (앱 시작 시 1회)
  useEffect(() => {
    const storedConfirm = localStorage.getItem('ssh_confirm_actions')
    if (storedConfirm !== null) setConfirmActions(storedConfirm === '1')
  }, [])

  // 최초 1회: 비어있는 폼을 가장 최근 프로필로 자동 채움
  const initFilledRef = useRef(false)
  useEffect(() => {
    if (initFilledRef.current) return
    if (profiles.length && !host && !isConnected) {
      fillForm(profiles[0])
      initFilledRef.current = true
    } else if (profiles.length === 0) {
      initFilledRef.current = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profiles])

  const toggleConfirmActions = (v: boolean) => {
    setConfirmActions(v)
    localStorage.setItem('ssh_confirm_actions', v ? '1' : '0')
  }

  // 프로필 값을 폼에 채움
  const fillForm = (p: SavedProfile) => {
    setHost(p.host)
    setPort(p.port)
    setUsername(p.username)
    setAuthMethod(p.authMethod)
    setPassword(p.password)
    setPrivateKey(p.privateKey)
    setPassphrase(p.passphrase)
    setJump(p.jump)
    setStartup(p.startup)
  }

  /** 폼 현재 값 → 프로필 객체 */
  const formProfile = (): SavedProfile => ({
    host: host.trim(),
    port,
    username: username.trim(),
    authMethod,
    password,
    privateKey,
    passphrase,
    jump,
    startup,
  })

  /** 인증 방식 → config 필드 */
  const authFields = (m: AuthMethod, password: string, privateKey: string, passphrase: string) =>
    m === 'password'
      ? { password }
      : m === 'key'
        ? { privateKey, passphrase: passphrase || undefined }
        : { useAgent: true }

  /** 점프 프로필 → config */
  const jumpToConfig = (j: JumpProfile): SSHConfig => ({
    host: j.host.trim(),
    port: Number(j.port) || 22,
    username: j.username.trim(),
    ...authFields(j.authMethod, j.password, j.privateKey, j.passphrase),
  })

  /** 프로필 → 접속 config */
  const toConfig = (p: SavedProfile): SSHConfig => ({
    host: p.host.trim(),
    port: Number(p.port) || 22,
    username: p.username.trim(),
    ...authFields(p.authMethod, p.password, p.privateKey, p.passphrase),
    ...(p.startup && p.startup.trim() ? { startup: p.startup } : {}),
    ...(p.jump && p.jump.host.trim() ? { jump: jumpToConfig(p.jump) } : {}),
  })

  /** 실제 연결 (폼/사이드바 공용). 연결 중이면 메인이 기존 세션을 정리하고 새로 연결 */
  const connect = async (p: SavedProfile) => {
    const result = await window.electronAPI.sshConnect(sessionId, toConfig(p))
    if (result.success) {
      if (remember) onProfilesChanged(await window.electronAPI.profilesUpsert(p))
      setConnectedProfile(p)
      onConnected(p)
    } else if (result.hostKeyChanged) {
      // 호스트 키 변경 경고 → 신뢰 후 재접속 확인
      setPending({
        message:
          '⚠ 이 서버의 호스트 키가 이전에 저장된 것과 다릅니다.\n서버 재설치라면 정상이지만, 중간자 공격일 수도 있습니다.\n신뢰하고 다시 접속할까요?',
        label: '신뢰 후 재접속',
        danger: true,
        onYes: async () => {
          await window.electronAPI.sshTrustHost(p.host.trim(), Number(p.port) || 22)
          connect(p)
        },
      })
    } else {
      onError(result.message)
    }
  }

  // 사이드바 더블클릭 → 폼 채우고 즉시 연결
  useImperativeHandle(ref, () => ({
    connectProfile: (p: SavedProfile) => {
      fillForm(p)
      connect(p)
    },
    prefill: ({ host, port, user }) => {
      setHost(host)
      if (port) setPort(port)
      if (user) setUsername(user)
      setCollapsed(false)
    },
  }))

  const handleConnect = () => {
    if (!host.trim()) {
      onError('IP/호스트를 입력하세요.')
      return
    }
    if (confirmActions) {
      setPending({
        message: `${host.trim()}:${port} 에 SSH 연결할까요?`,
        label: '연결',
        onYes: () => connect(formProfile()),
      })
    } else {
      connect(formProfile())
    }
  }

  const handleDisconnect = () => {
    if (confirmActions) {
      setPending({
        message: '현재 SSH 연결을 해제할까요?',
        label: '연결 해제',
        danger: true,
        onYes: () => window.electronAPI.sshDisconnect(sessionId),
      })
    } else {
      window.electronAPI.sshDisconnect(sessionId)
    }
  }

  const inputCls =
    'w-full rounded-md bg-panel-light border border-white/10 px-2.5 py-1.5 text-sm text-gray-100 ' +
    'placeholder:text-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50'

  return (
    <div className="border-b border-white/10 bg-panel text-gray-200">
      {/* 헤더 (클릭 시 펼침/접힘 토글) */}
      <div
        onClick={() => setCollapsed((v) => !v)}
        className="flex cursor-pointer select-none items-center gap-2 px-3 py-2.5 text-sm font-semibold text-gray-100 hover:bg-white/5"
      >
        <Server size={16} className="text-blue-400" />
        SSH 접속 정보
        {/* 접힌 채 연결된 상태면 실제 연결 서버 요약 표시 */}
        {collapsed && isConnected && connectedProfile && (
          <span className="truncate font-mono text-[12px] font-normal text-gray-400">
            {connectedProfile.username}@{connectedProfile.host}:{connectedProfile.port}
          </span>
        )}
        <span
          className={
            'ml-auto rounded-full px-2 py-0.5 text-[11px] font-normal ' +
            (isConnected
              ? 'bg-green-500/20 text-green-300'
              : status === 'error'
                ? 'bg-red-500/20 text-red-300'
                : 'bg-gray-500/20 text-gray-300')
          }
        >
          {statusLabel(status)}
        </span>
        {/* 접힌 채 연결됨이면 헤더에서 바로 연결 해제 */}
        {collapsed && isConnected && (
          <button
            onClick={(e) => {
              e.stopPropagation()
              handleDisconnect()
            }}
            title="연결 해제"
            className="rounded p-1 text-red-300 hover:bg-red-500/20"
          >
            <PlugZap size={15} />
          </button>
        )}
        {collapsed ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
      </div>

      {/* 본문 (접히면 숨김) */}
      {collapsed ? null : (
        <div className="px-3 pb-3">
          <div className="grid grid-cols-12 gap-2">
            <div className="col-span-7">
              <label className="mb-0.5 block text-[11px] text-gray-400">IP / 호스트</label>
              <input
                className={inputCls}
                placeholder="192.168.0.10"
                value={host}
                onChange={(e) => setHost(e.target.value)}
                disabled={isConnected}
              />
            </div>
            <div className="col-span-2">
              <label className="mb-0.5 block text-[11px] text-gray-400">Port</label>
              <input
                className={inputCls}
                value={port}
                onChange={(e) => setPort(e.target.value)}
                disabled={isConnected}
              />
            </div>
            <div className="col-span-3">
              <label className="mb-0.5 block text-[11px] text-gray-400">User</label>
              <input
                className={inputCls}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                disabled={isConnected}
              />
            </div>
          </div>

          {/* 인증 방식 선택 */}
          <div className="mt-2 flex gap-3 text-xs text-gray-300">
            <label className="flex items-center gap-1">
              <input
                type="radio"
                checked={authMethod === 'password'}
                onChange={() => setAuthMethod('password')}
                disabled={isConnected}
              />
              비밀번호
            </label>
            <label className="flex items-center gap-1">
              <input
                type="radio"
                checked={authMethod === 'key'}
                onChange={() => setAuthMethod('key')}
                disabled={isConnected}
              />
              개인키(Key)
            </label>
            <label className="flex items-center gap-1">
              <input
                type="radio"
                checked={authMethod === 'agent'}
                onChange={() => setAuthMethod('agent')}
                disabled={isConnected}
              />
              SSH 에이전트
            </label>
          </div>

          <div className="mt-2">
            {authMethod === 'agent' ? (
              <div className="rounded-md bg-white/5 px-2.5 py-2 text-[11px] leading-relaxed text-gray-400">
                OS의 SSH 에이전트(Pageant / OpenSSH agent)에 등록된 키로 인증합니다. 비밀번호·키
                입력이 필요 없습니다.
              </div>
            ) : authMethod === 'password' ? (
              <div className="relative">
                <input
                  type={showPw ? 'text' : 'password'}
                  className={inputCls + ' pr-9'}
                  placeholder="Password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={isConnected}
                />
                <button
                  type="button"
                  tabIndex={-1}
                  onClick={() => setShowPw((v) => !v)}
                  title={showPw ? '숨기기' : '표시'}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-200"
                >
                  {showPw ? <Eye size={15} /> : <EyeOff size={15} />}
                </button>
              </div>
            ) : (
              <div className="space-y-2">
                <button
                  type="button"
                  onClick={async () => {
                    const r = await window.electronAPI.sshPickKeyFile()
                    if (r.ok && r.content) setPrivateKey(r.content)
                  }}
                  disabled={isConnected}
                  className="flex items-center gap-1 rounded-md border border-white/10 bg-panel-light px-2 py-1 text-[11px] text-gray-200 hover:bg-white/10 disabled:opacity-50"
                >
                  <FileKey size={12} /> 키 파일 불러오기
                </button>
                <textarea
                  className={inputCls + ' h-20 resize-none font-mono text-xs'}
                  placeholder="-----BEGIN OPENSSH PRIVATE KEY----- ... (또는 위 버튼으로 파일 선택)"
                  value={privateKey}
                  onChange={(e) => setPrivateKey(e.target.value)}
                  disabled={isConnected}
                />
                <div className="relative">
                  <input
                    type={showPw ? 'text' : 'password'}
                    className={inputCls + ' pr-9'}
                    placeholder="Passphrase (선택)"
                    value={passphrase}
                    onChange={(e) => setPassphrase(e.target.value)}
                    disabled={isConnected}
                  />
                  <button
                    type="button"
                    tabIndex={-1}
                    onClick={() => setShowPw((v) => !v)}
                    title={showPw ? '숨기기' : '표시'}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-200"
                  >
                    {showPw ? <Eye size={15} /> : <EyeOff size={15} />}
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* 점프 호스트 표시 (편집은 세션 등록/편집 모달에서) */}
          {jump && jump.host.trim() && (
            <div className="mt-2 flex items-center gap-1.5 rounded-md bg-blue-500/10 px-2 py-1 text-[11px] text-blue-200">
              <span>↪ 점프 경유:</span>
              <span className="font-mono">
                {jump.username}@{jump.host}:{jump.port}
              </span>
            </div>
          )}

          {/* 접속 정보 기억하기 */}
          <label className="mt-2 flex items-center gap-1.5 text-xs text-gray-300">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
              disabled={isConnected}
            />
            연결 시 세션 목록에 저장 (이 PC, 암호화)
          </label>

          {/* 연결/해제 전 확인(Y/N) 옵션 */}
          <label className="mt-1 flex items-center gap-1.5 text-xs text-gray-300">
            <input
              type="checkbox"
              checked={confirmActions}
              onChange={(e) => toggleConfirmActions(e.target.checked)}
            />
            연결 / 연결 해제 전 확인 묻기
          </label>

          <div className="mt-3">
            {!isConnected ? (
              <button
                onClick={handleConnect}
                disabled={isBusy}
                className="flex w-full items-center justify-center gap-2 rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-60"
              >
                {isBusy ? <Loader2 size={16} className="animate-spin" /> : <Plug size={16} />}
                {isBusy ? '연결 중...' : '연결'}
              </button>
            ) : (
              <button
                onClick={handleDisconnect}
                className="flex w-full items-center justify-center gap-2 rounded-md bg-red-600/80 px-3 py-2 text-sm font-medium text-white hover:bg-red-500"
              >
                <PlugZap size={16} />
                연결 해제
              </button>
            )}
          </div>
        </div>
      )}

      {/* 연결/해제 확인 (Y/N 옵션이 켜진 경우) */}
      {pending && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
          onClick={() => setPending(null)}
        >
          <div
            className="w-full max-w-sm rounded-lg border border-white/10 bg-panel p-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-2 text-sm font-semibold text-gray-100">확인</div>
            <p className="whitespace-pre-line text-[13px] leading-relaxed text-gray-200">{pending.message}</p>
            <div className="mt-3 flex justify-end gap-2">
              <button
                onClick={() => setPending(null)}
                className="rounded-md border border-white/10 bg-panel-light px-3 py-1.5 text-xs text-gray-200 hover:bg-white/10"
              >
                아니오
              </button>
              <button
                onClick={() => {
                  const fn = pending.onYes
                  setPending(null)
                  fn()
                }}
                className={
                  'rounded-md px-3 py-1.5 text-xs text-white ' +
                  (pending.danger ? 'bg-red-600/80 hover:bg-red-500' : 'bg-blue-600 hover:bg-blue-500')
                }
              >
                예 · {pending.label}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
})

export default SSHForm

function statusLabel(status: string): string {
  switch (status) {
    case 'connecting':
      return '연결 중'
    case 'connected':
      return '연결됨'
    case 'error':
      return '오류'
    case 'closed':
      return '연결 해제'
    default:
      return '대기'
  }
}
