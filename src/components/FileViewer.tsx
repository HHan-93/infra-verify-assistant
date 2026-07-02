import { useEffect, useState } from 'react'
import {
  FileCode,
  Download,
  Save,
  Sparkles,
  X,
  Loader2,
  RotateCw,
  Pencil,
  Lock,
  Eye,
  EyeOff,
  AlertCircle,
} from 'lucide-react'

const APPLY_REQUIRED: { pattern: RegExp; command: string; desc: string }[] = [
  { pattern: /\/etc\/netplan\//,     command: 'sudo netplan apply',                      desc: '저장만으로는 네트워크 설정이 반영되지 않습니다. 터미널에서 netplan apply를 실행해야 적용됩니다.' },
  { pattern: /\/etc\/sysctl\.conf$/, command: 'sudo sysctl -p',                          desc: '저장만으로는 커널 파라미터가 반영되지 않습니다. 터미널에서 sysctl -p를 실행해야 적용됩니다.' },
  { pattern: /\/etc\/fstab$/,        command: 'sudo mount -a',                           desc: '저장만으로는 마운트 설정이 반영되지 않습니다. 터미널에서 mount -a를 실행하거나 재부팅해야 적용됩니다.' },
  { pattern: /\/etc\/resolv\.conf$/, command: 'sudo systemctl restart systemd-resolved', desc: '저장만으로는 DNS 설정이 반영되지 않습니다. 터미널에서 systemd-resolved를 재시작해야 적용됩니다.' },
]

interface FileViewerProps {
  /** SFTP 대상 세션(활성 탭) ID */
  sessionId: string
  connected: boolean
  /** 처음 열 때 자동으로 불러올 경로 (선택) */
  initialPath?: string
  onClose: () => void
  /** 파일 내용을 AI 분석으로 전달 */
  onAnalyze: (text: string) => void
}

/** 자주 보는 환경설정 파일 빠른 선택 (카테고리별) */
const PATH_GROUPS: { group: string; paths: string[] }[] = [
  {
    group: 'OpenStack',
    paths: [
      '/etc/nova/nova.conf',
      '/etc/neutron/neutron.conf',
      '/etc/neutron/plugins/ml2/ml2_conf.ini',
      '/etc/neutron/l3_agent.ini',
      '/etc/cinder/cinder.conf',
      '/etc/glance/glance-api.conf',
      '/etc/keystone/keystone.conf',
      '/etc/heat/heat.conf',
      '/etc/rabbitmq/rabbitmq.conf',
    ],
  },
  {
    group: 'Ceph',
    paths: ['/etc/ceph/ceph.conf', '/etc/ceph/ceph.client.admin.keyring', '/etc/ceph/rbdmap'],
  },
  {
    group: 'Kubernetes',
    paths: [
      '/etc/kubernetes/manifests/kube-apiserver.yaml',
      '/etc/kubernetes/manifests/kube-controller-manager.yaml',
      '/etc/kubernetes/manifests/kube-scheduler.yaml',
      '/etc/kubernetes/manifests/etcd.yaml',
      '/var/lib/kubelet/config.yaml',
      '/etc/kubernetes/admin.conf',
      '/etc/containerd/config.toml',
    ],
  },
  {
    group: '네트워크',
    paths: [
      '/etc/netplan/00-installer-config.yaml',
      '/etc/netplan/50-cloud-init.yaml',
      '/etc/network/interfaces',
      '/etc/NetworkManager/NetworkManager.conf',
      '/etc/hosts',
      '/etc/hostname',
      '/etc/resolv.conf',
      '/etc/systemd/resolved.conf',
      '/etc/nsswitch.conf',
    ],
  },
  {
    group: '시간 동기화(NTP)',
    paths: ['/etc/chrony/chrony.conf', '/etc/chrony.conf', '/etc/ntp.conf'],
  },
  {
    group: '시스템',
    paths: [
      '/etc/fstab',
      '/etc/sysctl.conf',
      '/etc/security/limits.conf',
      '/etc/security/access.conf',
      '/etc/ssh/sshd_config',
      '/etc/selinux/config',
      '/etc/default/grub',
      '/etc/logrotate.conf',
      '/etc/os-release',
      '/etc/crontab',
    ],
  },
  {
    group: '서비스/패키지',
    paths: [
      '/etc/docker/daemon.json',
      '/etc/haproxy/haproxy.cfg',
      '/etc/apt/sources.list',
      '/etc/firewalld/firewalld.conf',
    ],
  },
]

/**
 * SFTP 기반 설정파일 뷰어/편집기 (모달).
 *  - 경로 입력/빠른선택 → 불러오기(읽기)
 *  - 편집 후 저장(쓰기)
 *  - 내용을 우측 AI 패널로 보내 분석
 */
export default function FileViewer({
  sessionId,
  connected,
  initialPath,
  onClose,
  onAnalyze,
}: FileViewerProps) {
  const [path, setPath] = useState(initialPath ?? '')
  const [content, setContent] = useState('')
  const [original, setOriginal] = useState('') // 편집 취소 시 되돌릴 원본
  const [loaded, setLoaded] = useState(false)
  const [loading, setLoading] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [editing, setEditing] = useState(false) // 기본 읽기 전용, '편집' 눌러야 수정 가능
  const [confirmOpen, setConfirmOpen] = useState(false) // 저장 확인창
  const [msg, setMsg] = useState('')
  // sudo 비밀번호: 키 인증/비NOPASSWD 환경에서 root 파일 접근 시 입력받아 세션 동안 캐시
  const [sudoPw, setSudoPw] = useState('')
  const [pwOpen, setPwOpen] = useState(false) // 비밀번호 입력창
  const [pwInput, setPwInput] = useState('')
  const [pwAction, setPwAction] = useState<'read' | 'write' | null>(null)
  const [showPw, setShowPw] = useState(false) // 비밀번호 표시(눈금) 토글
  const [applyNotice, setApplyNotice] = useState<{ command: string; desc: string } | null>(null)

  // 잘못 저장하면 시스템에 치명적인 파일 (강한 경고 대상)
  const RISKY = [/\/etc\/fstab/, /\/etc\/netplan\//, /sshd_config/, /\/etc\/sudoers/, /grub/, /\/boot\//]
  const isRisky = (p: string) => RISKY.some((r) => r.test(p))

  // 백업 경로 미리보기 (메인의 BACKUP_BASE 규칙과 동일하게 표시)
  const BACKUP_BASE = '/var/tmp/ivk-backups'
  const backupPreview = (p: string) => {
    const slash = p.lastIndexOf('/')
    const dir = slash > 0 ? p.slice(0, slash) : ''
    const base = slash >= 0 ? p.slice(slash + 1) : p
    return `${BACKUP_BASE}${dir.startsWith('/') ? dir : '/' + dir}/${base}_<날짜시각>`
  }

  const load = async (p: string, pw?: string) => {
    if (!p.trim()) return
    if (!connected) {
      setMsg('SSH 연결이 필요합니다.')
      return
    }
    setLoading(true)
    setMsg('')
    // 이전 파일 내용이 남아 다른 파일처럼 보이는 것 방지 (실패/팝업 시 화면 비움)
    setContent('')
    setOriginal('')
    setLoaded(false)
    setDirty(false)
    const res = await window.electronAPI.sftpRead(
      sessionId,
      p.trim(),
      (pw ?? sudoPw) || undefined,
    )
    setLoading(false)
    if (res.ok) {
      setContent(res.content ?? '')
      setOriginal(res.content ?? '')
      setLoaded(true)
      setDirty(false)
      setEditing(false) // 새로 불러오면 읽기 전용으로 시작
      setMsg(`${res.viaSudo ? '불러옴 (sudo)' : '불러옴'}: ${p.trim()}`)
    } else if (res.needSudoPassword) {
      // root 권한 필요 → sudo 비밀번호 입력 요청
      setPwAction('read')
      setPwInput('')
      setShowPw(false)
      setPwOpen(true)
      setMsg(`${res.error ?? ''} (sudo 비밀번호 입력 필요)`)
    } else {
      setMsg(`불러오기 실패: ${res.error}`)
    }
  }

  // 처음 열릴 때 initialPath 자동 로드
  useEffect(() => {
    if (initialPath) load(initialPath)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 저장 버튼 → 앱 내부 확인창 열기 (네이티브 confirm 은 Electron 포커스 버그가 있어 사용하지 않음)
  const requestSave = () => {
    if (!loaded || !dirty) return
    setConfirmOpen(true)
  }

  const doSave = async (pw?: string) => {
    setConfirmOpen(false)
    const p = path.trim()
    const res = await window.electronAPI.sftpWrite(
      sessionId,
      p,
      content,
      (pw ?? sudoPw) || undefined,
    )
    if (res.ok) {
      setOriginal(content) // 저장 성공분을 새 원본으로
      setDirty(false)
      setEditing(false) // 저장 후 읽기 전용으로 복귀
      const bak = res.backupPath ? ` · 백업: ${res.backupPath}` : ''
      setMsg(`${res.viaSudo ? '저장됨 (sudo)' : '저장됨'}: ${p}${bak}`)
      const match = APPLY_REQUIRED.find(a => a.pattern.test(p))
      if (match) setApplyNotice(match)
    } else if (res.needSudoPassword) {
      setPwAction('write')
      setPwInput('')
      setShowPw(false)
      setPwOpen(true)
      setMsg(`${res.error ?? ''} (sudo 비밀번호 입력 필요)`)
    } else {
      setMsg(`저장 실패: ${res.error}`)
    }
  }

  // 비밀번호 입력창 확인 → 캐시 후 원래 동작 재시도
  const submitSudoPw = () => {
    const pw = pwInput
    setSudoPw(pw)
    setPwOpen(false)
    if (pwAction === 'read') load(path, pw)
    else if (pwAction === 'write') doSave(pw)
    setPwAction(null)
  }

  // 편집 취소: 변경 폐기 + 읽기 전용 복귀
  const cancelEdit = () => {
    setContent(original)
    setDirty(false)
    setEditing(false)
  }

  const analyze = () => {
    if (!content) return
    onAnalyze(`설정파일 ${path.trim()} 의 내용을 분석해 주세요:\n\n${content}`)
    onClose()
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      onClick={onClose}
    >
      <div
        className="relative flex h-[82vh] w-full max-w-4xl flex-col overflow-hidden rounded-lg border border-white/10 bg-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 헤더 */}
        <div className="flex items-center gap-2 border-b border-white/10 px-4 py-3">
          <FileCode size={18} className="text-blue-400" />
          <span className="text-sm font-semibold text-gray-100">설정파일 뷰어 (SFTP)</span>
          {dirty && <span className="text-[11px] text-amber-300">● 수정됨</span>}
          <button
            onClick={onClose}
            className="ml-auto rounded p-1 text-gray-400 hover:bg-white/10 hover:text-gray-200"
          >
            <X size={16} />
          </button>
        </div>

        {/* 경로 입력 줄 */}
        <div className="flex items-center gap-2 border-b border-white/10 px-4 py-2">
          <input
            value={path}
            onChange={(e) => setPath(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && load(path)}
            placeholder="/etc/nova/nova.conf"
            className="flex-1 rounded-md border border-white/10 bg-panel-light px-2.5 py-1.5 font-mono text-xs text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
          <select
            value=""
            onChange={(e) => {
              if (e.target.value) {
                setPath(e.target.value)
                load(e.target.value)
              }
            }}
            className="max-w-[200px] rounded-md border border-white/10 bg-panel-light px-2 py-1.5 text-xs text-gray-300 focus:outline-none"
            title="자주 보는 설정파일"
          >
            <option value="">빠른 선택…</option>
            {PATH_GROUPS.map((g) => (
              <optgroup key={g.group} label={g.group}>
                {g.paths.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <button
            onClick={() => load(path)}
            disabled={!path.trim() || loading}
            className="flex items-center gap-1 rounded-md bg-blue-600 px-3 py-1.5 text-xs text-white hover:bg-blue-500 disabled:opacity-50"
          >
            {loading ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
            불러오기
          </button>
        </div>

        {/* 내용 (기본 읽기 전용 → '편집' 눌러야 수정) */}
        <div className="min-h-0 flex-1 p-2">
          <textarea
            value={content}
            readOnly={!editing}
            onChange={(e) => {
              setContent(e.target.value)
              setDirty(true)
            }}
            spellCheck={false}
            placeholder={
              connected
                ? '경로를 입력하고 불러오기를 누르세요.'
                : 'SSH 연결 후 사용할 수 있습니다.'
            }
            className={
              'h-full w-full resize-none rounded-md bg-[#11111b] p-3 font-mono text-xs leading-relaxed focus:outline-none ' +
              (editing ? 'text-gray-100 ring-1 ring-amber-500/40' : 'text-gray-300 cursor-default')
            }
          />
        </div>

        {/* 하단 액션 */}
        <div className="flex items-center gap-2 border-t border-white/10 px-4 py-2.5">
          {/* 메시지: min-w-0 + truncate 로 길어도 한 줄 유지하며 버튼 공간 확보 */}
          <span className="min-w-0 flex-1 truncate text-[11px] text-gray-400" title={msg}>
            {msg}
          </span>
          {/* 버튼 그룹: shrink-0 + 각 버튼 whitespace-nowrap 로 세로 줄바꿈 방지 */}
          <div className="flex shrink-0 items-center gap-2">
            <button
              onClick={() => load(path)}
              disabled={!loaded || loading}
              title="서버에서 다시 불러오기"
              className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md border border-white/10 bg-panel-light px-2.5 py-1.5 text-xs text-gray-200 hover:bg-white/10 disabled:opacity-50"
            >
              <RotateCw size={13} />
              새로고침
            </button>
            <button
              onClick={analyze}
              disabled={!content}
              className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md border border-purple-400/40 bg-purple-600/30 px-2.5 py-1.5 text-xs text-purple-100 hover:bg-purple-600/50 disabled:opacity-50"
            >
              <Sparkles size={13} />
              AI 분석
            </button>

            {/* 읽기 전용일 땐 [편집], 편집 중일 땐 [취소]+[저장] */}
            {!editing ? (
              <button
                onClick={() => setEditing(true)}
                disabled={!loaded}
                title="편집 모드로 전환"
                className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md border border-white/10 bg-panel-light px-2.5 py-1.5 text-xs text-gray-200 hover:bg-white/10 disabled:opacity-50"
              >
                <Pencil size={13} />
                편집
              </button>
            ) : (
              <>
                <button
                  onClick={cancelEdit}
                  title="변경 취소 후 읽기 전용으로"
                  className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md border border-white/10 bg-panel-light px-2.5 py-1.5 text-xs text-gray-200 hover:bg-white/10"
                >
                  <Lock size={13} />
                  취소
                </button>
                <button
                  onClick={requestSave}
                  disabled={!dirty}
                  title="SFTP로 원격 파일에 저장 (자동 백업)"
                  className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md bg-blue-600 px-3 py-1.5 text-xs text-white hover:bg-blue-500 disabled:opacity-50"
                >
                  <Save size={13} />
                  저장
                </button>
              </>
            )}
          </div>
        </div>

        {/* 저장 확인 (앱 내부 다이얼로그 — 네이티브 confirm 미사용) */}
        {confirmOpen && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/60 p-6">
            <div className="w-full max-w-md rounded-lg border border-white/10 bg-panel p-4 shadow-2xl">
              <div className="mb-2 text-sm font-semibold text-gray-100">저장 확인</div>
              {isRisky(path.trim()) && (
                <p className="mb-2 rounded bg-red-500/15 px-2 py-1.5 text-[12px] leading-relaxed text-red-300">
                  ⚠️ 위험: 이 파일을 잘못 저장하면 부팅 / 네트워크 / SSH 접속이 끊길 수 있습니다.
                </p>
              )}
              <p className="text-[12px] leading-relaxed text-gray-300">
                원격 파일을 덮어씁니다. <b>원본 폴더는 건드리지 않고</b>, 저장 직전 원본을 아래 별도
                경로로 자동 백업합니다. (원본 디렉토리 구조를 그대로 미러링)
              </p>
              <div className="mt-1.5 break-all font-mono text-[11px] leading-relaxed">
                <div className="text-gray-400">원본: {path.trim()}</div>
                <div className="text-blue-300/90">백업: {backupPreview(path.trim())}</div>
              </div>
              <div className="mt-3 flex justify-end gap-2">
                <button
                  onClick={() => setConfirmOpen(false)}
                  className="rounded-md border border-white/10 bg-panel-light px-3 py-1.5 text-xs text-gray-200 hover:bg-white/10"
                >
                  취소
                </button>
                <button
                  onClick={() => doSave()}
                  className="rounded-md bg-blue-600 px-3 py-1.5 text-xs text-white hover:bg-blue-500"
                >
                  저장 진행
                </button>
              </div>
            </div>
          </div>
        )}

        {/* apply 필요 안내 */}
        {applyNotice && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/60 p-6">
            <div className="w-full max-w-md rounded-lg border border-amber-500/30 bg-panel p-4 shadow-2xl">
              <div className="mb-3 flex items-center gap-2">
                <AlertCircle size={16} className="shrink-0 text-amber-400" />
                <span className="text-sm font-semibold text-amber-200">저장 완료 — 추가 적용 필요</span>
              </div>
              <p className="mb-3 text-[12px] leading-relaxed text-amber-300/80">{applyNotice.desc}</p>
              <code className="block rounded bg-black/40 px-3 py-2 font-mono text-[12px] text-amber-100">
                {applyNotice.command}
              </code>
              <div className="mt-4 flex justify-end">
                <button
                  onClick={() => setApplyNotice(null)}
                  className="rounded-md bg-amber-500/20 px-4 py-1.5 text-xs font-medium text-amber-200 hover:bg-amber-500/30"
                >
                  확인
                </button>
              </div>
            </div>
          </div>
        )}

        {/* sudo 비밀번호 입력 (root 파일 접근 시) */}
        {pwOpen && (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/60 p-6">
            <div className="w-full max-w-md rounded-lg border border-white/10 bg-panel p-4 shadow-2xl">
              <div className="mb-2 text-sm font-semibold text-gray-100">sudo 비밀번호</div>
              <p className="mb-3 text-[12px] leading-relaxed text-gray-300">
                이 파일은 root 권한이 필요합니다. 현재 접속 계정의 <b>sudo 비밀번호</b>를 입력하면
                {pwAction === 'write' ? ' 저장' : ' 읽기'}을 다시 시도합니다. (이 세션 동안만 메모리에
                보관)
              </p>
              <div className="relative">
                <input
                  type={showPw ? 'text' : 'password'}
                  autoFocus
                  value={pwInput}
                  onChange={(e) => setPwInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') submitSudoPw()
                    if (e.key === 'Escape') {
                      setPwOpen(false)
                      setPwAction(null)
                    }
                  }}
                  placeholder="sudo 비밀번호"
                  className="w-full rounded-md border border-white/10 bg-panel-light px-2.5 py-1.5 pr-9 font-mono text-xs text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
                <button
                  type="button"
                  onClick={() => setShowPw((v) => !v)}
                  title={showPw ? '비밀번호 숨기기' : '비밀번호 표시'}
                  className="absolute inset-y-0 right-0 flex items-center px-2.5 text-gray-400 hover:text-gray-200"
                >
                  {showPw ? <Eye size={15} /> : <EyeOff size={15} />}
                </button>
              </div>
              <div className="mt-3 flex justify-end gap-2">
                <button
                  onClick={() => {
                    setPwOpen(false)
                    setPwAction(null)
                  }}
                  className="rounded-md border border-white/10 bg-panel-light px-3 py-1.5 text-xs text-gray-200 hover:bg-white/10"
                >
                  취소
                </button>
                <button
                  onClick={submitSudoPw}
                  disabled={!pwInput}
                  className="rounded-md bg-blue-600 px-3 py-1.5 text-xs text-white hover:bg-blue-500 disabled:opacity-40"
                >
                  확인 후 재시도
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
