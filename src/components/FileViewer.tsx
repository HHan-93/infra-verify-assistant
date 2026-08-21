import { useEffect, useMemo, useRef, useState } from 'react'
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
  Search,
  ChevronUp,
  ChevronDown,
  Minus,
  Plus,
} from 'lucide-react'

const APPLY_REQUIRED: { pattern: RegExp; command: string; desc: string }[] = [
  { pattern: /\/etc\/netplan\//,     command: 'sudo netplan apply',                      desc: '저장만으로는 네트워크 설정이 반영되지 않습니다. 터미널에서 netplan apply를 실행해야 적용됩니다.' },
  { pattern: /\/etc\/sysctl\.conf$/, command: 'sudo sysctl -p',                          desc: '저장만으로는 커널 파라미터가 반영되지 않습니다. 터미널에서 sysctl -p를 실행해야 적용됩니다.' },
  { pattern: /\/etc\/fstab$/,        command: 'sudo mount -a',                           desc: '저장만으로는 마운트 설정이 반영되지 않습니다. 터미널에서 mount -a를 실행하거나 재부팅해야 적용됩니다.' },
  { pattern: /\/etc\/resolv\.conf$/, command: 'sudo systemctl restart systemd-resolved', desc: '저장만으로는 DNS 설정이 반영되지 않습니다. 터미널에서 systemd-resolved를 재시작해야 적용됩니다.' },
  // ── OpenStack / HA / 메시징·DB — 설정 저장 후 해당 서비스 재시작 필요 ──
  { pattern: /\/etc\/masakari-monitors\//, command: 'sudo systemctl restart masakari-*', desc: 'masakari-monitors 설정은 저장만으로 반영되지 않습니다. 관련 데몬을 재시작해야 적용됩니다. (배포판에 따라 유닛명 상이)' },
  { pattern: /\/etc\/masakari\//,   command: 'sudo systemctl restart masakari-engine masakari-api', desc: 'masakari 설정은 저장만으로 반영되지 않습니다. masakari-engine/api를 재시작해야 적용됩니다. (RHEL: openstack-masakari-*)' },
  { pattern: /\/etc\/nova\//,       command: 'sudo systemctl restart nova-*',        desc: 'nova 설정은 저장만으로 반영되지 않습니다. 노드 역할에 맞는 nova 서비스를 재시작하세요. (compute: nova-compute, controller: nova-api·conductor·scheduler / RHEL: openstack-nova-*)' },
  { pattern: /\/etc\/neutron\//,    command: 'sudo systemctl restart neutron-*',     desc: 'neutron 설정은 저장만으로 반영되지 않습니다. 관련 neutron 에이전트/서비스를 재시작하세요.' },
  { pattern: /\/etc\/cinder\//,     command: 'sudo systemctl restart cinder-*',      desc: 'cinder 설정은 저장만으로 반영되지 않습니다. cinder 서비스를 재시작하세요.' },
  { pattern: /\/etc\/glance\//,     command: 'sudo systemctl restart glance-*',      desc: 'glance 설정은 저장만으로 반영되지 않습니다. glance 서비스를 재시작하세요.' },
  { pattern: /\/etc\/keystone\//,   command: 'sudo systemctl restart apache2',       desc: 'keystone 은 보통 웹서버(wsgi)로 구동됩니다. 저장 후 웹서버를 재시작하세요. (RHEL: httpd)' },
  { pattern: /\/etc\/placement\//,  command: 'sudo systemctl restart apache2',       desc: 'placement 는 보통 웹서버(wsgi)로 구동됩니다. 저장 후 웹서버를 재시작하세요. (RHEL: httpd)' },
  { pattern: /\/etc\/octavia\//,    command: 'sudo systemctl restart octavia-*',     desc: 'octavia(로드밸런서) 설정은 저장만으로 반영되지 않습니다. octavia 서비스를 재시작하세요.' },
  { pattern: /\/etc\/barbican\//,   command: 'sudo systemctl restart barbican-*',    desc: 'barbican 설정은 저장만으로 반영되지 않습니다. barbican 서비스를 재시작하세요.' },
  { pattern: /\/etc\/heat\//,       command: 'sudo systemctl restart heat-*',        desc: 'heat 설정은 저장만으로 반영되지 않습니다. heat 서비스를 재시작하세요.' },
  { pattern: /\/etc\/rabbitmq\//,   command: 'sudo systemctl restart rabbitmq-server', desc: 'RabbitMQ 설정은 저장만으로 반영되지 않습니다. rabbitmq-server 를 재시작하세요. (클러스터는 재시작 순서 주의)' },
  { pattern: /(my\.cnf|galera\.cnf|-server\.cnf)$/, command: 'sudo systemctl restart mariadb', desc: 'DB 설정은 저장만으로 반영되지 않습니다. mariadb(또는 mysql)를 재시작하세요. Galera 클러스터는 재시작 순서/부트스트랩에 특히 주의하세요.' },
  { pattern: /\/etc\/corosync\//,   command: 'sudo systemctl restart corosync pacemaker', desc: 'corosync/pacemaker 설정은 저장만으로 반영되지 않습니다. 클러스터 영향이 크므로 노드별 순서에 주의해 재시작하세요.' },
]

/**
 * 설정파일 본문 글꼴 — 터미널(Consolas 우선)과 일부러 다르게 잡는다.
 * conf 는 `key = value` 정렬과 한글 주석이 섞여 있어, 0/O·1/l/I 가 구분되고 한글 글립이
 * 있는 글꼴이 앞에 와야 읽힌다. 설치돼 있는 첫 글꼴이 쓰이므로 없는 환경에서도 안전하다.
 */
const CONF_FONT = "'Cascadia Mono', 'JetBrains Mono', Consolas, 'D2Coding', 'Malgun Gothic', monospace"
/** 줄간격 배수 — 검색 스크롤 위치 계산이 이 값에 의존하므로 실제 CSS 와 반드시 같아야 한다 */
const LINE_RATIO = 1.6
const FONT_KEY = 'fileviewer_font_size'
/** 검색 매치 상한 — 큰 파일에서 한 글자만 입력했을 때 전부 모으느라 멈추는 것을 막는다 */
const MAX_MATCHES = 5000

interface FileViewerProps {
  /** SFTP 대상 세션(활성 탭) ID */
  sessionId: string
  connected: boolean
  /** 처음 열 때 자동으로 불러올 경로 (선택) */
  initialPath?: string
  onClose: () => void
  /** 파일 내용을 AI 분석으로 전달. AI 패널이 이미 스트리밍 중이면 무시되고 false 를 반환한다. */
  onAnalyze: (text: string) => boolean
}

/** 자주 보는 환경설정 파일 빠른 선택 (카테고리별) */
const PATH_GROUPS: { group: string; paths: string[] }[] = [
  {
    group: 'OpenStack 코어',
    paths: [
      '/etc/nova/nova.conf',
      '/etc/nova/nova-compute.conf',
      '/etc/nova/api-paste.ini',
      '/etc/neutron/neutron.conf',
      '/etc/neutron/plugins/ml2/ml2_conf.ini',
      '/etc/neutron/plugins/ml2/openvswitch_agent.ini',
      '/etc/neutron/l3_agent.ini',
      '/etc/neutron/dhcp_agent.ini',
      '/etc/neutron/metadata_agent.ini',
      '/etc/cinder/cinder.conf',
      '/etc/glance/glance-api.conf',
      '/etc/keystone/keystone.conf',
      '/etc/placement/placement.conf',
      '/etc/heat/heat.conf',
    ],
  },
  {
    group: 'OpenStack 부가(LB/보안/대시보드)',
    paths: [
      '/etc/octavia/octavia.conf',
      '/etc/barbican/barbican.conf',
      '/etc/designate/designate.conf',
      '/etc/manila/manila.conf',
      '/etc/openstack-dashboard/local_settings',
      '/etc/openstack-dashboard/local_settings.py',
    ],
  },
  {
    group: '고가용성(Masakari/Pacemaker)',
    paths: [
      '/etc/masakari/masakari.conf',
      '/etc/masakari-monitors/masakarimonitors.conf',
      '/etc/masakari/masakari-monitors.conf',
      '/etc/corosync/corosync.conf',
      '/etc/pacemaker/pcmk-init.conf',
    ],
  },
  {
    group: '메시징/DB(RabbitMQ/Galera)',
    paths: [
      '/etc/rabbitmq/rabbitmq.conf',
      '/etc/rabbitmq/rabbitmq-env.conf',
      '/etc/rabbitmq/advanced.config',
      '/etc/my.cnf',
      '/etc/mysql/my.cnf',
      '/etc/mysql/mariadb.conf.d/50-server.cnf',
      '/etc/mysql/mariadb.conf.d/60-galera.cnf',
      '/etc/mysql/conf.d/galera.cnf',
    ],
  },
  {
    group: 'Ceph',
    paths: [
      '/etc/ceph/ceph.conf',
      '/etc/ceph/ceph.client.admin.keyring',
      '/etc/ceph/rbdmap',
      '/var/lib/ceph/bootstrap-osd/ceph.keyring',
    ],
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
  // ── 본문 글꼴 크기 ─────────────────────────────────────────
  // 기본 12px 은 conf 를 오래 들여다보기에 작았다. 13px 로 올리고 눈에 맞게 조절할 수 있게 한다.
  // 터미널 글꼴 크기(term_font_size)와 별개로 기억한다 — 보는 목적이 다르다.
  const [fontSize, setFontSize] = useState(() => Number(localStorage.getItem(FONT_KEY)) || 13)
  const changeFontSize = (n: number) => {
    const v = Math.max(10, Math.min(28, n))
    setFontSize(v)
    localStorage.setItem(FONT_KEY, String(v))
  }
  // ── 검색 ───────────────────────────────────────────────────
  const [query, setQuery] = useState('')
  /** -1 = 아직 이동 전(개수만 표시) */
  const [matchIdx, setMatchIdx] = useState(-1)
  const taRef = useRef<HTMLTextAreaElement>(null)

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

  // ── 검색 · 섹션 이동 ───────────────────────────────────────
  // textarea 는 DOM 트리가 아니라 값 하나라서 매치마다 하이라이트를 씌울 수 없다. 그래서
  // '선택 영역(selection) + 스크롤' 로 현재 매치를 가리킨다. 이때 **포커스는 옮기지 않는다** —
  // 옮기면 첫 Enter 에 포커스가 본문으로 넘어가 다음 매치로 넘어갈 수 없고, 편집 모드에서는
  // 그 Enter 가 본문에 개행으로 들어간다.
  const needle = query.trim().toLowerCase()
  const matches = useMemo(() => {
    if (!needle) return []
    const hay = content.toLowerCase()
    const out: number[] = []
    for (
      let i = hay.indexOf(needle);
      i !== -1 && out.length < MAX_MATCHES;
      i = hay.indexOf(needle, i + needle.length)
    )
      out.push(i)
    return out
  }, [content, needle])
  /**
   * `[section]` 헤더 목록. **줄 전체가 대괄호 한 쌍인 줄만** 인정한다 —
   * 값 안에 들어간 대괄호(`filters = [a, b]`)를 섹션으로 잡으면 목록이 쓰레기가 된다.
   */
  const sections = useMemo(() => {
    const out: { name: string; at: number }[] = []
    const re = /^[ \t]*\[([^\]\n]+)\][ \t]*$/gm
    for (let m = re.exec(content); m; m = re.exec(content)) out.push({ name: m[1], at: m.index })
    return out
  }, [content])
  /**
   * 검색어가 바뀌면 '이동 전' 상태로 되돌린다. 검색어 자체는 지우지 않는다 —
   * 같은 키를 파일 여러 개에서 확인하는 일이 잦다.
   *
   * **content 를 의존성에 넣으면 안 된다** — 편집 모드에서 한 글자 칠 때마다 현재 매치 위치가
   * 초기화돼, 3번째 매치를 보다 값을 고치면 다시 첫 매치부터 넘겨야 했다.
   * 새 파일을 불러올 때의 초기화는 load() 가 직접 한다.
   */
  useEffect(() => setMatchIdx(-1), [needle])

  /** offset 이 속한 섹션 이름 (섹션 밖이면 빈 문자열) */
  const sectionOf = (offset: number) => {
    let name = ''
    for (const s of sections) {
      if (s.at > offset) break
      name = s.name
    }
    return name
  }
  const lineOf = (offset: number) => content.slice(0, offset).split('\n').length

  /** 해당 범위를 선택하고 화면 가운데로 스크롤 */
  const jumpTo = (start: number, len: number, place: 'center' | 'top' = 'center') => {
    const ta = taRef.current
    if (!ta) return
    ta.setSelectionRange(start, start + len)
    const lh = fontSize * LINE_RATIO
    const y = (lineOf(start) - 1) * lh
    ta.scrollTop = Math.max(0, place === 'center' ? y - ta.clientHeight / 2 : y - lh)
  }
  const go = (dir: 1 | -1) => {
    if (matches.length === 0) return
    // 아직 이동 전(-1)이면 방향에 따라 첫/마지막 매치부터 시작한다
    const next =
      matchIdx < 0
        ? dir === 1
          ? 0
          : matches.length - 1
        : (matchIdx + dir + matches.length) % matches.length
    // 스크롤은 아래 useEffect 한 곳에서만 한다 (모드별로 방법이 다르다)
    setMatchIdx(next)
  }
  /** 섹션 헤더로 이동 — 아래 키 목록을 봐야 하므로 가운데가 아니라 위쪽에 붙인다 */
  const jumpSection = (at: number) => {
    const nl = content.indexOf('\n', at)
    if (editing) {
      jumpTo(at, (nl === -1 ? content.length : nl) - at, 'top')
      return
    }
    // 읽기 모드에는 textarea 가 없다. 줄 높이가 일정하므로(whitespace-pre) 줄번호 × 줄높이로 맞는다
    const el = viewRef.current
    if (el) el.scrollTop = Math.max(0, (lineOf(at) - 1) * lineH - lineH)
  }

  /**
   * 읽기 모드 렌더링용 줄 배열과 각 줄의 시작 offset.
   *
   * 검색 매치는 파일 전체 기준 offset 으로 갖고 있으므로(섹션·줄번호 표시가 그 값을 쓴다),
   * 줄 단위로 그릴 때도 같은 기준을 유지해야 '지금 매치'가 어느 것인지 정확히 갈린다.
   */
  const lines = useMemo(() => content.split('\n'), [content])
  const lineStarts = useMemo(() => {
    let acc = 0
    return lines.map((l) => {
      const at = acc
      acc += l.length + 1 // 개행 1자
      return at
    })
  }, [lines])
  /** 지금 보고 있는 매치의 절대 offset (-1 = 아직 이동 전) */
  const curOffset = matchIdx >= 0 && matchIdx < matches.length ? matches[matchIdx] : -1
  const curRef = useRef<HTMLElement | null>(null)
  const viewRef = useRef<HTMLDivElement>(null)
  const lineH = fontSize * LINE_RATIO

  /**
   * 현재 매치로 스크롤.
   *  - 읽기 모드: 실제 DOM 요소가 있으니 그걸 화면 가운데로 옮긴다(정확하다).
   *  - 편집 모드: textarea 라 요소가 없다 → 선택 영역 + 줄 높이 계산으로 옮긴다.
   */
  useEffect(() => {
    if (curOffset < 0) return
    if (editing) jumpTo(curOffset, needle.length)
    else curRef.current?.scrollIntoView({ block: 'center' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [curOffset, editing])

  /**
   * 한 줄을 그린다. 검색어가 있으면 매치마다 배경색을 입히고, **지금 매치만 더 진하게** 칠한다.
   *
   * 예전에는 읽기 모드도 textarea 였다. textarea 는 값 하나라서 매치에 하이라이트를 씌울 DOM 이
   * 없고, '선택 영역' 으로 가리키는 게 최선이었다. 그런데 포커스가 검색칸에 있는 동안 Chromium 이
   * 선택을 옅게 그려, **찾아놓고도 화면에서 눈으로 다시 찾아야 했다.** 그래서 읽기 모드는 줄 단위
   * 렌더링으로 바꿨다. 편집 모드는 입력이 되어야 하므로 그대로 textarea 다.
   */
  const renderLine = (line: string, idx: number) => {
    if (!needle || !line) return line
    const lower = line.toLowerCase()
    const out: (string | JSX.Element)[] = []
    let from = 0
    for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, at + needle.length)) {
      if (at > from) out.push(line.slice(from, at))
      const isCur = lineStarts[idx] + at === curOffset
      out.push(
        <mark
          key={at}
          ref={isCur ? (el) => (curRef.current = el) : undefined}
          className={isCur ? 'rounded-sm bg-amber-400 text-black' : 'rounded-sm bg-yellow-500/25 text-yellow-100'}
        >
          {line.slice(at, at + needle.length)}
        </mark>,
      )
      from = at + needle.length
    }
    if (from < line.length) out.push(line.slice(from))
    return out
  }

  /**
   * 그려둔 줄 목록.
   *
   * conf 는 주석까지 합쳐 수천 줄이 흔하다. 메모하지 않으면 **경로 입력칸에 한 글자 칠 때마다**
   * (또는 하단 메시지가 바뀔 때마다) 그 수천 줄이 전부 다시 그려진다. 실제로 다시 그려야 하는
   * 것은 내용·검색어·현재 매치·글꼴 크기가 바뀔 때뿐이다.
   */
  const rows = useMemo(
    () =>
      editing
        ? null // 편집 모드에는 textarea 만 그려진다 — 안 쓰는 수천 줄을 키 입력마다 만들 이유가 없다
        : lines.map((line, i) => (
            <div key={i} className="flex" style={{ height: lineH }}>
              {/* 줄번호 — 검색 결과가 '몇 번째 줄'로 표시되므로 실제 줄과 맞춰볼 수 있어야 한다.
                  가로로 스크롤해도 따라가도록 왼쪽에 고정한다 */}
              <span
                // z-10 필수 — sticky 만으로는 쌓임 순서가 정해지지 않아, 가로로 스크롤하면 본문
            // 글자가 줄번호 위로 지나가며 겹쳐 보인다(DOM 순서상 본문이 뒤에 오기 때문)
            className="sticky left-0 z-10 shrink-0 select-none border-r border-white/5 bg-[#11111b] pl-3 pr-3 text-right text-gray-600"
                // Tailwind 는 box-sizing: border-box 라 지정 폭 안에 패딩(pl-3+pr-3=1.5rem)이
                // 포함된다 — 자릿수만 주면 숫자가 눌리므로 패딩을 더해 준다
                style={{ width: `calc(${String(lines.length).length}ch + 1.5rem)` }}
              >
                {i + 1}
              </span>
              <span className="whitespace-pre">{renderLine(line, i)}</span>
            </div>
          )),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lines, needle, curOffset, lineH, editing],
  )

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
    setMatchIdx(-1) // 다른 파일의 매치 위치가 남지 않게
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
    const started = onAnalyze(`설정파일 ${path.trim()} 의 내용을 분석해 주세요:\n\n${content}`)
    // AI 패널이 이미 스트리밍 중이면 요청이 조용히 무시되므로, 그 경우 뷰어를 닫지 않고
    // 안내만 남겨 사용자가 요청이 유실된 줄 모르고 넘어가지 않게 한다.
    if (!started) {
      setMsg('AI가 이미 다른 응답을 생성하는 중입니다. 잠시 후 다시 시도하세요.')
      return
    }
    onClose()
  }

  return (
    // 배경 클릭으로 닫지 않는다 — 불러온 파일과 편집 중인 내용이 사라진다(ConfirmDialog 주석 참고)
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6">
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

        {/* 검색 · 섹션 이동 · 글꼴 크기 — 불러온 뒤에만 보인다 */}
        {loaded && (
          <div className="flex items-center gap-1.5 border-b border-white/10 px-4 py-1.5">
            <Search size={12} className="shrink-0 text-gray-500" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.shiftKey ? go(-1) : go(1)
              }}
              placeholder="키·값 검색 (Enter 다음 · Shift+Enter 이전)"
              className="min-w-0 flex-1 bg-transparent text-[12px] text-gray-200 outline-none placeholder:text-gray-600"
            />
            {needle && (
              <>
                <span className="shrink-0 text-[11px] text-gray-500">
                  {matches.length === 0
                    ? '없음'
                    : matchIdx < 0
                      ? `${matches.length}개${matches.length >= MAX_MATCHES ? '+' : ''}`
                      : `${matchIdx + 1}/${matches.length}`}
                </span>
                <button
                  onClick={() => go(-1)}
                  disabled={matches.length === 0}
                  title="이전 (Shift+Enter)"
                  className="shrink-0 rounded p-0.5 text-gray-400 hover:text-gray-200 disabled:opacity-30"
                >
                  <ChevronUp size={13} />
                </button>
                <button
                  onClick={() => go(1)}
                  disabled={matches.length === 0}
                  title="다음 (Enter)"
                  className="shrink-0 rounded p-0.5 text-gray-400 hover:text-gray-200 disabled:opacity-30"
                >
                  <ChevronDown size={13} />
                </button>
                {/* 찾은 값이 '어느 섹션' 것인지 — conf 는 같은 키가 섹션마다 또 나온다 */}
                {matchIdx >= 0 && (
                  <span className="max-w-[240px] shrink-0 truncate text-[11px] text-blue-300">
                    {sectionOf(matches[matchIdx])
                      ? `[${sectionOf(matches[matchIdx])}]`
                      : '(섹션 밖)'}{' '}
                    · {lineOf(matches[matchIdx])}번째 줄
                  </span>
                )}
              </>
            )}
            {sections.length > 0 && (
              <select
                value=""
                onChange={(e) => e.target.value !== '' && jumpSection(Number(e.target.value))}
                title="섹션으로 이동"
                className="max-w-[150px] shrink-0 rounded border border-white/10 bg-panel-light px-1.5 py-0.5 text-[11px] text-gray-300 focus:outline-none"
              >
                <option value="">섹션 {sections.length}개…</option>
                {sections.map((s, i) => (
                  <option key={`${s.at}-${i}`} value={s.at}>
                    [{s.name}]
                  </option>
                ))}
              </select>
            )}
            <div
              className="flex shrink-0 items-center gap-0.5 border-l border-white/10 pl-1.5"
              title="본문 글꼴 크기 (Ctrl+휠)"
            >
              <button
                onClick={() => changeFontSize(fontSize - 1)}
                className="rounded p-0.5 text-gray-400 hover:text-gray-200"
              >
                <Minus size={12} />
              </button>
              <span className="w-[30px] text-center text-[11px] tabular-nums text-gray-400">{fontSize}px</span>
              <button
                onClick={() => changeFontSize(fontSize + 1)}
                className="rounded p-0.5 text-gray-400 hover:text-gray-200"
              >
                <Plus size={12} />
              </button>
            </div>
          </div>
        )}

        {/* 내용 (기본 읽기 전용 → '편집' 눌러야 수정) */}
        <div className="min-h-0 flex-1 p-2">
          {editing ? (
            <textarea
              ref={taRef}
              value={content}
              onChange={(e) => {
                setContent(e.target.value)
                setDirty(true)
              }}
              spellCheck={false}
              onWheel={(e) => {
                // Ctrl+휠 확대/축소 — 에디터에서 기대하는 동작이고, '작아서 안 보인다'가 원래 불만이었다
                if (!e.ctrlKey) return
                e.preventDefault()
                changeFontSize(fontSize + (e.deltaY < 0 ? 1 : -1))
              }}
              // 글꼴 크기·줄간격은 검색 스크롤 계산(jumpTo)과 같은 값을 써야 하므로 inline style 로 둔다
              style={{
                fontFamily: CONF_FONT,
                fontSize: `${fontSize}px`,
                lineHeight: `${lineH.toFixed(2)}px`,
                tabSize: 4,
              }}
              className="conf-view h-full w-full resize-none rounded-md bg-[#11111b] p-3 text-gray-100 ring-1 ring-amber-500/40 focus:outline-none"
            />
          ) : (
            /* 읽기 모드 — 매치에 배경색을 입히려면 줄 단위 DOM 이 필요하다(위 renderLine 주석 참고).
               줄바꿈을 하지 않고(whitespace-pre) 가로로 스크롤한다: 줄 높이가 일정해야 섹션 이동의
               스크롤 계산이 맞고, conf 는 `key = value` 정렬이 유지되는 편이 읽기 쉽다. */
            <div
              ref={viewRef}
              onWheel={(e) => {
                if (!e.ctrlKey) return
                e.preventDefault()
                changeFontSize(fontSize + (e.deltaY < 0 ? 1 : -1))
              }}
              style={{ fontFamily: CONF_FONT, fontSize: `${fontSize}px`, lineHeight: `${lineH.toFixed(2)}px`, tabSize: 4 }}
              className="h-full w-full overflow-auto rounded-md bg-[#11111b] py-3 pr-3 text-gray-300"
            >
              {!loaded ? (
                <span className="block pl-3 text-gray-600">
                  {connected ? '경로를 입력하고 불러오기를 누르세요.' : 'SSH 연결 후 사용할 수 있습니다.'}
                </span>
              ) : (
                rows
              )}
            </div>
          )}
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
