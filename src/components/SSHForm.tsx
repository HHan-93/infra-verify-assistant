import { useEffect, useState } from 'react'
import {
  Server,
  Plug,
  PlugZap,
  Loader2,
  ChevronDown,
  ChevronUp,
  History,
  X,
  Trash2,
  Eye,
  EyeOff,
} from 'lucide-react'
import type { SSHConfig, SavedProfile } from '../../electron/shared-types'

/** 같은 서버 식별 키 (메인의 profileKey와 동일 규칙) */
const profileKey = (p: SavedProfile) => `${p.host}:${p.port}:${p.username}`

type AuthMethod = 'password' | 'key'

interface SSHFormProps {
  /** 이 폼이 제어하는 세션(탭) ID */
  sessionId: string
  /** 'connecting' | 'connected' | 'closed' | 'error' | 'idle' */
  status: string
  /** 연결 성공 시 호출 (탭 제목 표시용으로 host 전달) */
  onConnected: (host?: string) => void
  onError: (msg: string) => void
}

/**
 * 좌측 상단 SSH 접속 정보 입력 폼.
 *  - IP / Port / User / 인증(비밀번호 or 개인키) 입력 후 '연결'
 *  - window.electronAPI.sshConnect 로 메인 프로세스에 접속 요청 (sessionId 별)
 */
export default function SSHForm({ sessionId, status, onConnected, onError }: SSHFormProps) {
  const [host, setHost] = useState('')
  const [port, setPort] = useState('22')
  const [username, setUsername] = useState('root')
  const [authMethod, setAuthMethod] = useState<AuthMethod>('password')
  const [password, setPassword] = useState('')
  const [privateKey, setPrivateKey] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [remember, setRemember] = useState(true)

  // 접속 기록(프로필 히스토리)
  const [profiles, setProfiles] = useState<SavedProfile[]>([])
  const [showHistory, setShowHistory] = useState(false)
  // 실제로 연결된 프로필 (헤더 요약/'연결중' 표시는 폼이 아니라 이 값 기준)
  const [connectedProfile, setConnectedProfile] = useState<SavedProfile | null>(null)
  // 연결 중 다른 프로필로 전환할지 확인할 대상
  const [switchTarget, setSwitchTarget] = useState<SavedProfile | null>(null)
  // 연결/해제 전 확인(Y/N) 옵션 (기본 ON)
  const [confirmActions, setConfirmActions] = useState(true)
  // 연결/해제 확인용 일반 다이얼로그
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
  const connectedKey = connectedProfile ? profileKey(connectedProfile) : null

  // 연결되면 접고, 끊기면 펼침 + 실제 연결 프로필 해제
  const [collapsed, setCollapsed] = useState(false)
  useEffect(() => {
    setCollapsed(status === 'connected')
    if (status === 'closed' || status === 'error' || status === 'idle') {
      setConnectedProfile(null)
    }
  }, [status])

  // 저장된 접속 기록 로드 + 가장 최근 프로필로 폼 자동 채움 + 확인옵션 로드 (앱 시작 시 1회)
  useEffect(() => {
    window.electronAPI.profilesList().then((list) => {
      setProfiles(list)
      if (list[0]) fillForm(list[0])
    })
    // 저장된 값이 있을 때만 반영 (없으면 기본 ON 유지)
    const storedConfirm = localStorage.getItem('ssh_confirm_actions')
    if (storedConfirm !== null) setConfirmActions(storedConfirm === '1')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
  })

  /** 프로필 → 접속 config */
  const toConfig = (p: SavedProfile): SSHConfig => ({
    host: p.host.trim(),
    port: Number(p.port) || 22,
    username: p.username.trim(),
    ...(p.authMethod === 'password'
      ? { password: p.password }
      : { privateKey: p.privateKey, passphrase: p.passphrase || undefined }),
  })

  /** 실제 연결 (폼/기록 공용). 연결 중이면 메인이 기존 세션을 정리하고 새로 연결 */
  const connect = async (p: SavedProfile) => {
    const result = await window.electronAPI.sshConnect(sessionId, toConfig(p))
    if (result.success) {
      if (remember) setProfiles(await window.electronAPI.profilesUpsert(p))
      setConnectedProfile(p)
      onConnected(p.host)
    } else {
      onError(result.message)
    }
  }

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

  // 기록에서 선택
  const loadProfile = (p: SavedProfile) => {
    setShowHistory(false)
    if (!isConnected) {
      // 미연결: 폼만 채우고 펼침
      fillForm(p)
      setCollapsed(false)
      return
    }
    if (connectedKey && profileKey(p) === connectedKey) return // 이미 이 서버에 연결됨
    setSwitchTarget(p) // 연결 중 + 다른 서버 → 전환 확인
  }

  // 전환 확정: 현재 연결을 끊고 선택 프로필로 재연결
  const confirmSwitch = async () => {
    const p = switchTarget
    setSwitchTarget(null)
    if (!p) return
    fillForm(p)
    await connect(p)
  }

  const deleteProfile = async (p: SavedProfile) => {
    setProfiles(await window.electronAPI.profilesDelete(profileKey(p)))
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

        {/* 접속 기록(히스토리) — 타이틀 바로 우측 */}
        <div className="relative" onClick={(e) => e.stopPropagation()}>
          <button
            onClick={() => setShowHistory((v) => !v)}
            title="접속 기록"
            className="flex items-center gap-1 rounded-md border border-white/10 bg-panel-light px-1.5 py-0.5 text-[11px] font-normal text-gray-300 hover:bg-white/10"
          >
            <History size={13} />
            기록
            {profiles.length > 0 && (
              <span className="rounded-full bg-blue-500/30 px-1 text-[10px] text-blue-100">
                {profiles.length}
              </span>
            )}
            <ChevronDown size={11} />
          </button>

          {showHistory && (
            <div className="absolute left-0 top-full z-30 mt-1 w-72 overflow-hidden rounded-md border border-white/10 bg-panel-light shadow-2xl">
              <div className="flex items-center border-b border-white/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-gray-500">
                접속 기록
                <button
                  onClick={() => setShowHistory(false)}
                  className="ml-auto rounded p-0.5 text-gray-400 hover:bg-white/10 hover:text-gray-200"
                >
                  <X size={12} />
                </button>
              </div>
              {profiles.length === 0 ? (
                <div className="px-3 py-3 text-xs text-gray-500">
                  저장된 기록이 없습니다. 연결 시 자동 저장됩니다.
                </div>
              ) : (
                <ul className="max-h-60 overflow-y-auto py-1">
                  {profiles.map((p) => (
                    <li
                      key={profileKey(p)}
                      className="group flex items-center gap-2 px-2 py-1.5 hover:bg-white/5"
                    >
                      <button
                        onClick={() => loadProfile(p)}
                        className="min-w-0 flex-1 text-left"
                        title={
                          profileKey(p) === connectedKey
                            ? '현재 연결된 서버'
                            : isConnected
                              ? '이 서버로 연결 전환'
                              : '이 접속 정보 불러오기'
                        }
                      >
                        <div className="flex items-center gap-1.5">
                          <span className="truncate font-mono text-[12px] text-gray-100">
                            {p.username}@{p.host}:{p.port}
                          </span>
                          {profileKey(p) === connectedKey && (
                            <span className="shrink-0 rounded-full bg-green-500/20 px-1.5 text-[10px] text-green-300">
                              ● 연결중
                            </span>
                          )}
                        </div>
                        <div className="text-[10px] text-gray-500">
                          {p.authMethod === 'key' ? '개인키' : '비밀번호'}
                        </div>
                      </button>
                      <button
                        onClick={() => deleteProfile(p)}
                        title="기록 삭제"
                        className="rounded p-1 text-gray-500 opacity-0 transition hover:bg-white/10 hover:text-red-300 group-hover:opacity-100"
                      >
                        <Trash2 size={13} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

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
      </div>

      <div className="mt-2">
        {authMethod === 'password' ? (
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
            <textarea
              className={inputCls + ' h-20 resize-none font-mono text-xs'}
              placeholder="-----BEGIN OPENSSH PRIVATE KEY----- ..."
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

      {/* 접속 정보 기억하기 */}
      <label className="mt-2 flex items-center gap-1.5 text-xs text-gray-300">
        <input
          type="checkbox"
          checked={remember}
          onChange={(e) => setRemember(e.target.checked)}
          disabled={isConnected}
        />
        연결 시 접속 기록에 저장 (이 PC, 암호화)
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
            <p className="text-[13px] leading-relaxed text-gray-200">{pending.message}</p>
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

      {/* 연결 전환 확인 (앱 내부 다이얼로그) */}
      {switchTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
          onClick={() => setSwitchTarget(null)}
        >
          <div
            className="w-full max-w-md rounded-lg border border-white/10 bg-panel p-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-2 text-sm font-semibold text-gray-100">연결 전환</div>
            <p className="text-[12px] leading-relaxed text-gray-300">
              현재{' '}
              <span className="font-mono text-gray-100">
                {connectedProfile
                  ? `${connectedProfile.username}@${connectedProfile.host}:${connectedProfile.port}`
                  : '서버'}
              </span>{' '}
              에 연결되어 있습니다. 이 연결을 끊고 아래 서버로 전환할까요?
            </p>
            <p className="mt-2 rounded bg-blue-500/10 px-2 py-1.5 font-mono text-[12px] text-blue-100">
              {switchTarget.username}@{switchTarget.host}:{switchTarget.port}
            </p>
            <div className="mt-3 flex justify-end gap-2">
              <button
                onClick={() => setSwitchTarget(null)}
                className="rounded-md border border-white/10 bg-panel-light px-3 py-1.5 text-xs text-gray-200 hover:bg-white/10"
              >
                취소
              </button>
              <button
                onClick={confirmSwitch}
                className="rounded-md bg-blue-600 px-3 py-1.5 text-xs text-white hover:bg-blue-500"
              >
                전환
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

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
