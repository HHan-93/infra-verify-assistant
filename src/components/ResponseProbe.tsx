import { useEffect, useMemo, useRef, useState } from 'react'
import { Radar, X, Minus, Maximize2, Play, Square, Download, Loader2, History, Trash2, FileText, Plus } from 'lucide-react'
import ConfirmDialog from './ConfirmDialog'
import { notifyOs } from '../lib/notify'
import { maskForExport } from '../lib/mask'
import {
  DEFAULT_PROBE,
  emptyRow,
  rowsToText,
  shouldAutoStop,
  buildProbeHtml,
  outageReason,
  modeText,
  codeText,
  specValid,
  parseNovaServers,
  parseHypervisors,
  type NovaServer,
  displayAddr,
  type ProbeMode,
  textToRows,
  buildPollCmd,
  buildStartCmd,
  buildStopCmd,
  parsePoll,
  parseTargets,
  probeDir,
  summarize,
  type ProbeConfig,
  type ProbeLast,
  type ProbeRun,
  type ProbeSummary,
  type TargetRow,
} from '../lib/responseProbe'

/**
 * 응답 측정 — 노드를 죽였을 때 evacuation 되는 VM 의 서비스가 끊긴 순간부터 다시 정상이 될 때까지를 잰다.
 * 판정·스크립트는 src/lib/responseProbe.ts. 여기는 화면과 클라이언트 VM(측정을 실행하는 서버)과의 왕복만 맡는다.
 *
 * 가용성 상태보드와 **같은 시간에** 돌린다는 전제다 — 그래서 최소화해도 측정이 계속되고, 창을 닫아도 측정은
 * 서버에서 이어진다(다시 열면 이어 붙는다). 상태보드 타임라인에는 기록하지 않는다(사용자 결정).
 */

interface ProbeSession {
  id: string
  name: string
  connected: boolean
  /** 재시작 뒤에도 같은 서버를 찾기 위한 안정 키 — 세션 id 는 재시작하면 바뀐다 */
  profileKey?: string
}

const CFG_KEY = 'response_probe_cfg_v1'
const ACTIVE_KEY = 'response_probe_active_v1'
const HIST_KEY = 'response_probe_runs_v1'
/** 방식(HTTP·TCP·Ping)마다 최근 몇 회를 보관할지 — 한 방식만 많이 돌려도 다른 방식 기록이 밀려나지 않게 따로 센다 */
const HIST_MAX = 30
/** 저장한 대상 세트 — 'com01 VM' · 'com02 VM' 처럼 롤링 대상별로 바꿔 쓴다 */
const SETS_KEY = 'response_probe_sets_v1'
interface ProbeSet {
  name: string
  mode: ProbeMode
  inputTab: 'form' | 'text'
  rows: TargetRow[]
  text: string
  savedAt: number
}
const POLL_MS = 1000
const POLL_TIMEOUT_MS = 8000

interface ActiveState {
  run: ProbeRun
  profileKey?: string
  sessionId: string
  offset: number
}

const loadJson = <T,>(k: string, fb: T): T => {
  try {
    const raw = localStorage.getItem(k)
    return raw ? (JSON.parse(raw) as T) : fb
  } catch {
    return fb
  }
}
const saveJson = (k: string, v: unknown) => {
  try {
    if (v == null) localStorage.removeItem(k)
    else localStorage.setItem(k, JSON.stringify(v))
  } catch {
    /* 용량 초과 등 — 측정은 서버에서 계속된다 */
  }
}

const p2 = (n: number) => String(n).padStart(2, '0')
const fmtClock = (t: number) => {
  const d = new Date(t)
  return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`
}
const fmtDateTime = (t: number) => {
  const d = new Date(t)
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${fmtClock(t)}`
}
/** 순단 — 초 단위 소수 한 자리(1분 넘으면 분:초) */
const fmtGap = (ms: number) => {
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}초`
  const r = Math.round(s) // 반올림을 먼저 — 119.6초가 '1분 60초' 로 찍혔다
  return `${Math.floor(r / 60)}분 ${String(r % 60).padStart(2, '0')}초`
}

/** 진행 중 경과 — 정수 초(1분 넘으면 분:초). 소수점을 보이면 조회 간격 흔들림이 그대로 드러난다 */
const fmtWhole = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  return s < 60 ? `${s}초` : `${Math.floor(s / 60)}분 ${String(s % 60).padStart(2, '0')}초`
}

/** 셸 출력 하나를 시간 제한 걸고 받는다 — 클라이언트 VM 이 느려도 화면이 멈추지 않게 */
async function runWithTimeout(
  sid: string,
  cmd: string,
  ms: number,
  /** 이미 보낸 실행에 시간 제한만 걸 때 */
  pending?: Promise<{ ok: boolean; code?: number; out?: string; err?: string; error?: string }>,
) {
  let timer: ReturnType<typeof setTimeout> | undefined
  const to = new Promise<{ ok: false; error: string; timedOut: true }>((res) => {
    timer = setTimeout(() => res({ ok: false, error: '응답 시간 초과', timedOut: true }), ms)
  })
  try {
    return await Promise.race([pending ?? window.electronAPI.sessionRun(sid, cmd), to])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function buildMarkdown(run: ProbeRun, sum: ProbeSummary): string {
  const L: string[] = []
  const cell = (v: unknown) => String(v ?? '').replace(/\|/g, '\\|')
  L.push(`# 응답 측정 — ${run.label || run.host} (${fmtDateTime(run.startedAt)})`, '')
  L.push(
    `- 클라이언트 VM: ${run.host} · 기록 위치: \`${run.dir}\` (events.csv · checks.csv)`,
    `- 방식: ${modeText(run.config)}${run.tcpTool ? ` (${run.tcpTool === 'nc' ? 'nc -z' : 'bash /dev/tcp'})` : ''} · 주기 ${run.config.intervalSec}초 · 타임아웃 ${run.config.timeoutSec}초 · 연속 ${run.config.needOk}회면 복구`,
    `- 측정: ${fmtDateTime(run.startedAt)} ~ ${run.stoppedAt ? fmtDateTime(run.stoppedAt) : '진행 중'}`,
    `- 첫 끊김: ${sum.firstOutage ? fmtDateTime(sum.firstOutage) : '-'}`,
    `- 끊긴 대상이 모두 복구: ${sum.allRecovered ? fmtDateTime(sum.allRecovered) : sum.firstOutage ? '아직 아님' : '-'}${sum.firstOutage && sum.allRecovered ? ` (첫 끊김부터 ${fmtGap(sum.allRecovered - sum.firstOutage)})` : ''}`,
    `- 가장 긴 순단: ${sum.maxGap != null ? fmtGap(sum.maxGap) : '-'}`,
    '',
  )
  L.push('## 대상별', '', '| 대상 | 주소 | 끊김 | 복구 첫 성공 시간 | 순단 | 끊김 횟수 |', '|---|---|---|---|---|---|')
  for (const t of sum.targets) {
    if (!t.outages.length) {
      L.push(`| ${cell(t.name)} | ${cell(displayAddr(t.url))} | - | - | ${t.ready ? '끊김 없음' : '처음부터 응답 없음'} | 0 |`)
      continue
    }
    t.outages.forEach((o, i) =>
      L.push(
        `| ${i ? '' : cell(t.name)} | ${i ? '' : cell(displayAddr(t.url))} | ${fmtDateTime(o.start)} | ${o.end ? fmtDateTime(o.end) : '복구 안 됨'} | ${o.end ? fmtGap(o.end - o.start) : '-'} | ${i ? '' : t.outages.length} |`,
      ),
    )
  }
  L.push('', '## 타임라인 원문 (클라이언트 VM events.csv)', '', '~~~~text')
  for (const e of run.events)
    L.push(`${e.at},${e.idx},${e.code},${e.kind},${e.base}${e.outageStart ? ',' + e.outageStart : ''}  # ${fmtDateTime(e.at)} ${run.config.targets[e.idx]?.name ?? ''}`)
  L.push('~~~~', '', '> 시각은 클라이언트 VM 의 시계 기준입니다. 복구는 연속 정상이 시작된 첫 성공 시각입니다.')
  return L.join('\n')
}

/**
 * 노드 VM 불러오기 — 컴퓨트 노드 위의 VM 을 Nova 에서 받아 **체크 목록**으로 보여 주고, 고른 것만 대상에 넣는다.
 * 노드에 VM 이 50대여도 다 넣고 지우는 게 아니라 필요한 10대만 고른다(사용자 요청). OpenStack CLI 가 되는 세션과
 * openrc 가 필요하다(--all-projects · --host 는 관리자 권한).
 */
function NovaPicker({
  sessions,
  defaultSid,
  rc,
  onRc,
  onAdd,
  onClose,
}: {
  sessions: ProbeSession[]
  defaultSid: string
  rc: string
  onRc: (v: string) => void
  onAdd: (vms: { name: string; ip: string }[]) => void
  onClose: () => void
}) {
  const connected = sessions.filter((s) => s.connected)
  const [sid, setSid] = useState(defaultSid || connected[0]?.id || '')
  const [host, setHost] = useState('')
  const [hosts, setHosts] = useState<string[]>([])
  const [vms, setVms] = useState<NovaServer[] | null>(null)
  const [pick, setPick] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const safe = (v: string) => /^[A-Za-z0-9._~\/\-]+$/.test(v)
  const os = (sub: string) => `bash -lc '. ${rc} 2>/dev/null; openstack ${sub} -f json'`
  const loadHosts = async () => {
    if (!sid) return setErr('세션을 고르세요')
    if (!safe(rc)) return setErr('openrc 경로에 쓸 수 없는 글자가 있습니다')
    setBusy(true)
    setErr('')
    const r = await runWithTimeout(sid, os('hypervisor list'), 30_000)
    const list = r.ok ? parseHypervisors(r.out ?? '') : null
    setBusy(false)
    if (!list) return setErr(`컴퓨트 호스트 목록을 받지 못했습니다 — openrc·권한을 확인하세요. ${((r.ok ? r.out : 'error' in r ? r.error : '') ?? '').trim().slice(0, 160)}`)
    setHosts(list)
    if (!host && list.length) setHost(list[0])
  }
  const loadVms = async () => {
    if (!sid) return setErr('세션을 고르세요')
    if (!safe(rc) || !safe(host)) return setErr('호스트 이름이나 openrc 경로에 쓸 수 없는 글자가 있습니다')
    setBusy(true)
    setErr('')
    const r = await runWithTimeout(sid, os(`server list --all-projects --host ${host} --limit -1 -c ID -c Name -c Status -c Networks`), 60_000)
    const list = r.ok ? parseNovaServers(r.out ?? '') : null
    setBusy(false)
    if (!list) return setErr(`VM 목록을 받지 못했습니다 — ${((r.ok ? r.out : 'error' in r ? r.error : '') ?? '').trim().slice(0, 200)}`)
    setVms(list)
    setPick(new Set())
  }
  const shown = (vms ?? []).filter((v) => {
    const q = filter.trim().toLowerCase()
    return !q || v.name.toLowerCase().includes(q) || v.ips.some((ip) => ip.includes(q))
  })
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-6">
      <div className="flex max-h-[80vh] w-[720px] max-w-[95vw] flex-col overflow-hidden rounded-lg border border-white/10 bg-panel shadow-2xl">
        <div className="flex items-center gap-2 border-b border-white/10 px-4 py-2.5">
          <span className="text-sm font-semibold text-gray-100">노드 VM 불러오기</span>
          <span className="text-[11px] text-gray-500">컴퓨트 노드 위 VM 중 잴 것만 골라 대상에 넣습니다</span>
          <button onClick={onClose} title="닫기" className="ml-auto rounded p-1 text-gray-400 hover:bg-white/10 hover:text-gray-200">
            <X size={16} />
          </button>
        </div>
        <div className="space-y-2 border-b border-white/10 p-4 text-[12px] text-gray-300">
          <div className="grid grid-cols-[110px_1fr] items-center gap-2">
            <span className="text-gray-400">OpenStack 세션</span>
            <select value={sid} onChange={(e) => setSid(e.target.value)} className="rounded border border-white/10 bg-panel-light px-2 py-1 text-[12px] text-gray-100">
              <option value="">세션 선택</option>
              {connected.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </select>
            <span className="text-gray-400">openrc</span>
            <input value={rc} onChange={(e) => onRc(e.target.value.trim())} placeholder="~/admin-openrc" className="rounded border border-white/10 bg-panel-light px-2 py-1 font-mono text-[12px] text-gray-100" />
            <span className="text-gray-400">컴퓨트 호스트</span>
            <div className="flex items-center gap-1.5">
              <input
                list="qt-hypervisors"
                value={host}
                onChange={(e) => setHost(e.target.value.trim())}
                placeholder="contrabass01"
                className="min-w-0 flex-1 rounded border border-white/10 bg-panel-light px-2 py-1 font-mono text-[12px] text-gray-100"
              />
              <datalist id="qt-hypervisors">
                {hosts.map((h) => (
                  <option key={h} value={h} />
                ))}
              </datalist>
              <button onClick={() => void loadHosts()} disabled={busy} className="rounded border border-white/10 px-2 py-1 text-[11.5px] hover:bg-white/10 disabled:opacity-40">
                호스트 목록
              </button>
              <button
                onClick={() => void loadVms()}
                disabled={busy || !host}
                className="rounded border border-blue-500/40 bg-blue-500/15 px-2 py-1 text-[11.5px] text-blue-100 hover:bg-blue-500/25 disabled:opacity-40"
              >
                {busy ? <Loader2 size={12} className="inline animate-spin" /> : 'VM 불러오기'}
              </button>
            </div>
          </div>
          {err && <div className="text-[11.5px] text-red-300">{err}</div>}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4 text-[12px]">
          {vms == null ? (
            <div className="text-gray-500">컴퓨트 호스트를 넣고 [VM 불러오기]를 누르세요.</div>
          ) : (
            <>
              <div className="mb-2 flex items-center gap-2">
                <input
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="이름 · IP 로 걸러 보기"
                  className="w-[220px] rounded border border-white/10 bg-panel-light px-2 py-1 text-[12px] text-gray-100"
                />
                <button onClick={() => setPick(new Set(shown.filter((v) => v.ips.length).map((v) => v.id)))} className="rounded border border-white/10 px-2 py-1 text-[11.5px] hover:bg-white/10">
                  보이는 것 전체 선택
                </button>
                <button onClick={() => setPick(new Set())} className="rounded border border-white/10 px-2 py-1 text-[11.5px] hover:bg-white/10">
                  선택 해제
                </button>
                <span className="ml-auto text-gray-500">
                  {vms.length}대 중 {pick.size}대 선택
                </span>
              </div>
              {shown.map((v) => (
                <label key={v.id} className={'flex items-center gap-2 rounded px-2 py-1 hover:bg-white/5 ' + (v.ips.length ? '' : 'opacity-50')}>
                  <input
                    type="checkbox"
                    disabled={!v.ips.length}
                    checked={pick.has(v.id)}
                    onChange={(e) =>
                      setPick((cur) => {
                        const n = new Set(cur)
                        if (e.target.checked) n.add(v.id)
                        else n.delete(v.id)
                        return n
                      })
                    }
                  />
                  <span className="w-[200px] truncate text-gray-100" title={v.id}>
                    {v.name}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-gray-300" title={v.ips.join(', ')}>
                    {v.ips.join(', ') || 'IP 없음'}
                  </span>
                  <span className={'text-[11px] ' + (v.status === 'ACTIVE' ? 'text-emerald-300' : 'text-amber-300')}>{v.status}</span>
                </label>
              ))}
            </>
          )}
        </div>
        <div className="flex items-center gap-2 border-t border-white/10 px-4 py-2.5 text-[11.5px] text-gray-500">
          <span>IP 가 여럿이면 첫 번째를 넣습니다 — 넣은 뒤 수동 입력 칸에서 바꿀 수 있습니다.</span>
          <button
            disabled={!pick.size}
            onClick={() => onAdd((vms ?? []).filter((v) => pick.has(v.id)).map((v) => ({ name: v.name, ip: v.ips[0] })))}
            className="ml-auto rounded-md bg-blue-600 px-3 py-1.5 text-[12px] font-medium text-white hover:bg-blue-500 disabled:opacity-40"
          >
            {pick.size}대 대상에 추가
          </button>
        </div>
      </div>
    </div>
  )
}

export default function ResponseProbe({ sessions, onClose }: { sessions: ProbeSession[]; onClose: () => void }) {
  const saved = loadJson<{
    hostKey?: string
    targetsText: string
    rows?: TargetRow[]
    inputTab?: 'form' | 'text'
    cfg: Omit<ProbeConfig, 'targets'>
  }>(CFG_KEY, {
    targetsText: '',
    cfg: DEFAULT_PROBE,
  })
  const [hostId, setHostId] = useState<string>(() => sessions.find((s) => s.profileKey && s.profileKey === saved.hostKey)?.id ?? '')
  const [targetsText, setTargetsText] = useState(saved.targetsText)
  /**
   * 대상 입력 방식 — 입력 칸(이름·IP·포트·경로를 칸마다) / 자유 입력(한 줄에 하나). 탭을 바꾸면 지금 내용을
   * 다른 쪽으로 옮겨 적는다(바꿨다고 입력이 사라지지 않게). 측정에는 지금 보이는 탭의 내용을 쓴다.
   */
  const [inputTab, setInputTab] = useState<'form' | 'text'>(saved.inputTab ?? 'form')
  const [rows, setRows] = useState<TargetRow[]>(() => (saved.rows?.length ? saved.rows : [emptyRow(), emptyRow(), emptyRow()]))
  const [cfg, setCfg] = useState<Omit<ProbeConfig, 'targets'>>({ ...DEFAULT_PROBE, ...saved.cfg })
  const [active, setActive] = useState<ActiveState | null>(() => loadJson<ActiveState | null>(ACTIVE_KEY, null))
  const [last, setLast] = useState<ProbeLast[]>([])
  const [alive, setAlive] = useState<boolean | null>(null)
  const [pollErr, setPollErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [minimized, setMinimized] = useState(false)
  /**
   * 최소화 칩 위치 — 상태보드 칩과 같은 방식(드래그로 옮김). 처음엔 우하단 고정이라 옮길 수 없었고, AI 패널 입력칸을
   * 가렸다(사용자 지적). 기본 자리는 상태보드 칩 **바로 아래** — 둘을 같이 띄우고 보는 일이 많아 한곳에 모은다.
   */
  const [chipPos, setChipPos] = useState<{ x: number; y: number } | null>(null)
  const chipDrag = useRef<{ dx: number; dy: number } | null>(null)
  const onChipDown = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button')) return // 버튼 클릭은 드래그 아님
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    chipDrag.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top }
    const move = (ev: MouseEvent) => {
      if (!chipDrag.current) return
      const x = Math.max(4, Math.min(window.innerWidth - rect.width - 4, ev.clientX - chipDrag.current.dx))
      const y = Math.max(4, Math.min(window.innerHeight - rect.height - 4, ev.clientY - chipDrag.current.dy))
      setChipPos({ x, y })
    }
    const up = () => {
      chipDrag.current = null
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }
  const minimize = () => {
    // 한 번 옮긴 자리는 지킨다 — 다시 접을 때마다 기본 자리로 튀면 옮긴 의미가 없다
    if (!chipPos) {
      const w = 220
      const board = document.querySelector('[data-anchor="board-chip"]') as HTMLElement | null
      const tunnel = document.querySelector('[data-anchor="tunnel"]') as HTMLElement | null
      if (board) {
        const r = board.getBoundingClientRect()
        setChipPos({ x: Math.max(4, Math.min(window.innerWidth - w - 4, r.left)), y: Math.min(window.innerHeight - 48, r.bottom + 6) })
      } else if (tunnel) {
        // 상태보드 칩이 없으면 상태보드가 접히는 자리(터널 버튼 오른쪽) 한 줄 아래 — 나중에 보드를 접어도 겹치지 않게
        const r = tunnel.getBoundingClientRect()
        setChipPos({ x: Math.max(4, Math.min(window.innerWidth - w - 4, r.right + 6)), y: r.top + 48 })
      }
    }
    setMinimized(true)
  }
  const [closeAsk, setCloseAsk] = useState(false)
  const [history, setHistory] = useState<ProbeRun[]>(() => loadJson<ProbeRun[]>(HIST_KEY, []))
  const [viewId, setViewId] = useState<string | null>(null)
  const [, tick] = useState(0)
  /**
   * 마지막 조회를 받은 PC 시각과 그때 클라이언트 VM 시계(가장 늦은 요청 시각)의 차이.
   * 'N초째' 를 PC 시계로 그냥 빼면 서버 시계 차이만큼 틀어지고, 조회가 끝날 때만 다시 그려 1.2초·1.5초처럼
   * 들쭉날쭉 올랐다(사용자 지적). 서버 기준으로 환산하고 1초마다 다시 그린다 — 초는 정수로.
   */
  const hostOffsetRef = useRef<number | null>(null)
  const activeRef = useRef(active)
  activeRef.current = active
  /** 서버에 보낸 폴링 중 아직 끝나지 않은 것 */
  const pollPendingRef = useRef<Promise<unknown> | null>(null)
  /** 마지막으로 받은 클라이언트 VM 시각(대상들 중 가장 늦은 요청) — 리포트의 끝 시각 */
  const hostLastAtRef = useRef<number | null>(null)
  /** 중지가 두 번 겹치지 않게 — 자동 종료와 사람이 누른 중지가 같은 순간에 올 수 있다 */
  const stoppingRef = useRef(false)

  const mode: ProbeMode = cfg.mode
  const parsed = useMemo(
    () => parseTargets(inputTab === 'form' ? rowsToText(rows, mode) : targetsText, mode),
    [inputTab, rows, targetsText, mode],
  )
  const switchTab = (to: 'form' | 'text') => {
    if (to === inputTab) return
    if (to === 'text') {
      const txt = rowsToText(rows, mode)
      if (txt) setTargetsText(txt)
    } else {
      const r = textToRows(targetsText, mode)
      if (r.rows.length) setRows([...r.rows, emptyRow()])
      if (r.errors.length) setMsg(`입력 칸으로 옮기지 못한 줄이 있습니다 — ${r.errors[0]}`)
    }
    setInputTab(to)
  }
  /** 입력 칸 열 — HTTP: 이름·IP·포트·경로·https / TCP: 이름·IP·포트 / Ping: 이름·IP */
  const gridCols =
    mode === 'http'
      ? 'grid-cols-[92px_1fr_56px_76px_40px_20px]'
      : mode === 'tcp'
        ? 'grid-cols-[110px_1fr_70px_20px]'
        : 'grid-cols-[120px_1fr_20px]'
  const setRow = (i: number, patch: Partial<TargetRow>) => setRows((rs) => rs.map((r, k) => (k === i ? { ...r, ...patch } : r)))
  /** IP 칸에 여러 줄을 붙여넣으면 줄마다 행을 만든다(10대를 하나씩 치지 않게) */
  const pasteHosts = (i: number, text: string): boolean => {
    const lines = text.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)
    if (lines.length < 2) return false
    setRows((rs) => {
      const next = [...rs]
      lines.forEach((h, k) => {
        const at = i + k
        if (at < next.length) next[at] = { ...next[at], host: h }
        else next.push({ ...emptyRow(), host: h })
      })
      return next
    })
    return true
  }
  const connected = sessions.filter((s) => s.connected)
  // 측정 중인 회차의 세션 — 재시작 뒤에는 같은 서버(profileKey)의 새 세션을 찾는다
  const activeSid = active
    ? sessions.find((s) => s.id === active.sessionId && s.connected)?.id ??
      sessions.find((s) => s.connected && active.profileKey && s.profileKey === active.profileKey)?.id ??
      ''
    : ''

  useEffect(() => {
    // 세션이 아직 열리지 않아 hostId 가 비었으면 기억해 둔 클라이언트 VM 을 지우지 않는다(검토 지적)
    const hostKey = sessions.find((s) => s.id === hostId)?.profileKey ?? (hostId ? undefined : saved.hostKey)
    saveJson(CFG_KEY, { hostKey, targetsText, rows, inputTab, cfg })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostId, targetsText, rows, inputTab, cfg])
  useEffect(() => saveJson(ACTIVE_KEY, active), [active])
  // 측정 중에는 1초마다 다시 그린다 — 'N초째' 가 조회 응답 간격(1.2초·1.5초)이 아니라 1초씩 오르게
  useEffect(() => {
    if (!active) return
    const iv = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(iv)
  }, [!!active])

  // 1초 폴링 — 직전 조회가 끝난 뒤 다음을 건다(겹치지 않게)
  useEffect(() => {
    if (!active || !activeSid) return
    let stop = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const loop = async () => {
      const a = activeRef.current
      if (stop || !a) return
      // 시간 제한은 화면만 풀어 줄 뿐 서버 쪽 실행은 남는다 — 앞 조회가 아직 돌고 있으면 기다렸다 보낸다.
      // 그러지 않으면 VM 이 멈춘 동안 9초마다 조회가 쌓여 실행 슬롯(연결당 4개)을 먹고, [중지] 도 줄을 섰다(검토 지적)
      if (pollPendingRef.current) await pollPendingRef.current.catch(() => {})
      if (stop) return
      const call = window.electronAPI.sessionRun(activeSid, buildPollCmd(a.run.id, a.offset))
      pollPendingRef.current = call
      void call.finally(() => {
        if (pollPendingRef.current === call) pollPendingRef.current = null
      })
      const r = await runWithTimeout(activeSid, '', POLL_TIMEOUT_MS, call)
      if (stop) return
      if (!r.ok) {
        // 조회 실패는 측정 중단이 아니다 — 서버에서는 계속 돌고 있다. 직전 화면을 두고 사실만 밝힌다
        setPollErr(`클라이언트 VM 조회 실패 — ${'error' in r ? r.error : ''} (측정은 서버에서 계속됩니다)`)
      } else {
        const p = parsePoll(r.out ?? '')
        if (p.noDir) setPollErr('측정 디렉터리가 없습니다 — 서버에서 지워졌거나 다른 서버입니다')
        else {
          setPollErr('')
          setLast(p.last)
          if (p.last.length) {
            const hostNow = Math.max(...p.last.map((x) => x.at))
            hostOffsetRef.current = Date.now() - hostNow
            hostLastAtRef.current = hostNow
          }
          setAlive(p.alive)
          if (p.events.length || p.consumed) {
            setActive((cur) =>
              cur && cur.run.id === a.run.id
                ? { ...cur, offset: cur.offset + p.consumed, run: { ...cur.run, events: [...cur.run.events, ...p.events] } }
                : cur,
            )
          }
        }
      }
      tick((n) => n + 1)
      timer = setTimeout(loop, POLL_MS)
    }
    void loop()
    return () => {
      stop = true
      if (timer) clearTimeout(timer)
    }
    // 회차가 바뀌거나 세션이 바뀔 때만 다시 건다(offset 변화로 매번 다시 걸지 않는다 — ref 로 읽는다)
  }, [active?.run.id, activeSid])

  const start = async () => {
    if (busy || active) return
    if (!hostId) return setMsg('클라이언트 VM 을 고르세요')
    if (!parsed.targets.length) return setMsg('대상을 하나 이상 넣으세요')
    if (parsed.errors.length) return setMsg(parsed.errors[0])
    if (mode === 'http' && !specValid(cfg.expectSpec ?? '')) return setMsg('정상 HTTP 코드는 200 · 2xx · 200,302 처럼 넣으세요')
    const config: ProbeConfig = { ...cfg, targets: parsed.targets }
    const id = String(Date.now())
    setBusy(true)
    setMsg('')
    try {
      const r = await runWithTimeout(hostId, buildStartCmd(id, config), 20_000)
      const out = r.ok ? r.out ?? '' : ''
      const err = out.match(/QT_ERR (.+)/)?.[1]
      if (!r.ok || err || !/QT_STARTED \d+/.test(out)) {
        setMsg(`시작하지 못했습니다 — ${err || ('error' in r ? r.error : '') || out.trim().slice(0, 200) || '응답 없음'}`)
        return
      }
      const tool = out.match(/QT_TOOL (nc|devtcp)/)?.[1] as 'nc' | 'devtcp' | undefined
      const host = sessions.find((s) => s.id === hostId)
      const run: ProbeRun = {
        id,
        startedAt: Date.now(),
        stoppedAt: null,
        host: host?.name ?? hostId,
        hostKey: host?.profileKey,
        tcpTool: tool,
        dir: probeDir(id),
        config,
        events: [],
      }
      setLast([])
      setAlive(true)
      setViewId(null)
      setActive({ run, profileKey: host?.profileKey, sessionId: hostId, offset: 0 })
    } finally {
      setBusy(false)
    }
  }

  /** 측정을 끝낸다 — 서버의 프로세스를 내리고, 남은 이벤트를 마저 읽어 회차를 이력에 남긴다 */
  const stop = async (auto = false) => {
    const a = activeRef.current
    if (!a || busy || stoppingRef.current) return
    stoppingRef.current = true
    setBusy(true)
    try {
      let events = a.run.events
      let stopFailed = false
      if (activeSid) {
        if (pollPendingRef.current) await Promise.race([pollPendingRef.current.catch(() => {}), new Promise((r) => setTimeout(r, 5000))])
        const k = await runWithTimeout(activeSid, buildStopCmd(a.run.id), 10_000)
        stopFailed = !k.ok || !/QT_STOPPED/.test(k.out ?? '')
        const r = await runWithTimeout(activeSid, buildPollCmd(a.run.id, a.offset), POLL_TIMEOUT_MS)
        if (r.ok) {
          const p = parsePoll(r.out ?? '')
          events = [...events, ...p.events]
          if (p.last.length) hostLastAtRef.current = Math.max(...p.last.map((x) => x.at))
        }
      } else stopFailed = true
      if (stopFailed)
        setMsg(
          `클라이언트 VM 의 측정 프로세스를 내리지 못했습니다 — 세션을 다시 연결해 ${a.run.dir} 의 pid 를 정리하세요(최대 ${a.run.config.maxMin ?? 180}분 뒤 스스로 멈춥니다)`,
        )
      /**
       * 원문(checks.csv)을 받아 이 PC 에 둔다 — 서버 /tmp 에만 있으면 재부팅·정리·VM 삭제로 사라진다(검토 지적).
       * 세션이 끊겼거나 받지 못하면 그 사실만 남기고 넘어간다(측정 결과 저장을 막지 않는다).
       */
      let rawSaved = false
      if (activeSid) {
        const raw = await runWithTimeout(activeSid, `cat ${a.run.dir}/checks.csv 2>/dev/null || echo QT_NOFILE`, 60_000)
        const body = raw.ok ? raw.out ?? '' : ''
        if (raw.ok && !body.startsWith('QT_NOFILE')) {
          const sv = await window.electronAPI.probeRawSave(a.run.id, body).catch(() => ({ ok: false }))
          rawSaved = sv.ok
        }
      }
      const run: ProbeRun = {
        ...a.run,
        events,
        stoppedAt: Date.now(),
        hostEndAt: hostLastAtRef.current ?? undefined,
        stopFailed: stopFailed || undefined,
        rawSaved: rawSaved || undefined,
      }
      const all = [run, ...history.filter((h) => h.id !== run.id)]
      const seenByMode: Record<string, number> = {}
      const next = all.filter((h) => {
        const m = h.config.mode ?? 'http'
        seenByMode[m] = (seenByMode[m] ?? 0) + 1
        return seenByMode[m] <= HIST_MAX
      })
      setHistory(next)
      saveJson(HIST_KEY, next)
      // 방식별 30회를 넘어 밀려난 회차의 원문도 지운다
      const dropped = all.filter((h) => !next.includes(h)).map((h) => h.id)
      if (dropped.length) void window.electronAPI.probeRawDelete(dropped)
      // 효과(useEffect)로 지우면 [중지하고 닫기] 에서 창이 먼저 사라져 기록이 남았다 — 다시 열면 끝난 회차가 '측정 중' 으로 되살아났다
      saveJson(ACTIVE_KEY, null)
      setActive(null)
      setViewId(run.id)
      if (auto) {
        const s = summarize(run.config, run.events, [])
        const span = s.firstOutage && s.allRecovered ? fmtGap(s.allRecovered - s.firstOutage) : ''
        setMsg(`끊겼던 대상이 모두 복구돼 측정을 자동으로 끝냈습니다${span ? ` — 첫 끊김부터 모두 복구까지 ${span}` : ''}`)
        notifyOs('응답 측정 종료', `끊겼던 대상 ${s.targets.filter((t) => t.outages.length).length}대 모두 복구${span ? ` · ${span}` : ''}`)
      }
    } finally {
      setBusy(false)
      stoppingRef.current = false
    }
  }

  const [sets, setSets] = useState<ProbeSet[]>(() => loadJson<ProbeSet[]>(SETS_KEY, []))
  const [setName, setSetName] = useState('')
  const [setPick, setSetPick] = useState('')
  const [setDelAsk, setSetDelAsk] = useState<string | null>(null)
  const [novaOpen, setNovaOpen] = useState(false)
  const [novaRc, setNovaRc] = useState(() => loadJson<string>('response_probe_nova_rc_v1', '~/admin-openrc'))
  const addFromNova = (vms: { name: string; ip: string }[]) => {
    // 빈 행은 버리고 뒤에 붙인다. 이미 있는 IP 는 다시 넣지 않는다
    const have = new Set(rows.map((r) => r.host.trim()).filter(Boolean))
    const keep = rows.filter((r) => r.host.trim() || r.name.trim())
    const add = vms.filter((v) => !have.has(v.ip)).map((v) => ({ ...emptyRow(), name: v.name, host: v.ip }))
    setRows([...keep, ...add, emptyRow()])
    setInputTab('form')
    setNovaOpen(false)
    setMsg(`${add.length}대를 대상에 넣었습니다${vms.length - add.length ? ` (이미 있는 ${vms.length - add.length}대 제외)` : ''}`)
  }
  const saveSet = () => {
    const name = setName.trim()
    if (!name) return setMsg('세트 이름을 넣으세요')
    if (!parsed.targets.length) return setMsg('저장할 대상이 없습니다')
    const item: ProbeSet = { name, mode, inputTab, rows, text: targetsText, savedAt: Date.now() }
    const exists = sets.some((x) => x.name === name)
    const next = [item, ...sets.filter((x) => x.name !== name)]
    setSets(next)
    saveJson(SETS_KEY, next)
    setSetPick(name)
    setMsg(exists ? `"${name}" 세트를 덮어썼습니다` : `"${name}" 세트를 저장했습니다 (${parsed.targets.length}개 대상)`)
  }
  const loadSet = (name: string) => {
    setSetPick(name)
    const x = sets.find((v) => v.name === name)
    if (!x) return
    setCfg((c) => ({ ...c, mode: x.mode }))
    setInputTab(x.inputTab)
    setRows(x.rows.length ? x.rows : [emptyRow()])
    setTargetsText(x.text)
    setSetName(x.name)
    setMsg(`"${x.name}" 세트를 불러왔습니다`)
  }

  /** 지난 측정 — 지금 고른 방식의 회차만(사용자 요청). 옛 기록은 방식이 없으면 HTTP 로 본다 */
  const modeHistory = history.filter((h) => (h.config.mode ?? 'http') === mode)
  const shown: ProbeRun | null =
    active?.run ?? modeHistory.find((h) => h.id === viewId) ?? null
  const sum = shown ? summarize(shown.config, shown.events, active ? last : []) : null
  const autoDue = !!active && !!sum && shouldAutoStop(active.run.config, sum, last)
  useEffect(() => {
    if (autoDue) void stop(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoDue])

  const exportMd = async (run: ProbeRun) => {
    const s = summarize(run.config, run.events, [])
    const d = new Date(run.startedAt)
    const name = `응답측정_${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}.md`
    const res = await window.electronAPI.saveReport({ defaultName: name, content: maskForExport(buildMarkdown(run, s)) })
    setMsg(res.saved ? `저장했습니다 — ${res.path ?? ''}` : res.error ? `저장 실패 — ${res.error}` : '')
  }
  const exportHtml = async (run: ProbeRun) => {
    const s = summarize(run.config, run.events, [])
    const d = new Date(run.startedAt)
    const name = `응답측정결과_${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}.html`
    const res = await window.electronAPI.saveReport({ defaultName: name, content: maskForExport(buildProbeHtml(run, s)), format: 'html' })
    setMsg(res.saved ? `저장했습니다 — ${res.path ?? ''}` : res.error ? `저장 실패 — ${res.error}` : '')
  }
  /** 서버에 남은 모든 요청 기록(checks.csv)을 받아 저장 — 원문 증적 */
  const exportCsv = async (run: ProbeRun) => {
    const header = `# 응답 측정 원문 — ${run.host}:${run.dir}/checks.csv (${modeText(run.config)})\n# epoch_ms,대상번호,결과(HTTP 코드 · OPEN · OK, 실패 000)  (대상: ${run.config.targets.map((t, i) => `${i}=${t.name}`).join(', ')})\n`
    // 이 PC 에 받아 둔 원문이 있으면 그것을 쓴다 — 서버가 꺼져 있어도 된다
    const local = await window.electronAPI.probeRawRead(run.id).catch(() => ({ ok: false as const }))
    if (local.ok && 'content' in local && local.content != null) {
      const res = await window.electronAPI.saveReport({ defaultName: `응답측정_원문_${run.id}.csv`, content: maskForExport(header + local.content), format: 'csv' })
      setMsg(res.saved ? `저장했습니다 — ${res.path ?? ''}` : res.error ? `저장 실패 — ${res.error}` : '')
      return
    }
    const sid =
      (run.hostKey ? sessions.find((s) => s.connected && s.profileKey === run.hostKey)?.id : undefined) ??
      sessions.find((s) => s.connected && s.name === run.host)?.id ??
      (active?.run.id === run.id ? activeSid : '')
    if (!sid) return setMsg('클라이언트 VM 세션이 연결돼 있어야 원문을 받을 수 있습니다')
    const r = await runWithTimeout(sid, `cat ${run.dir}/checks.csv 2>/dev/null || echo QT_NOFILE`, 30_000)
    const out = r.ok ? r.out ?? '' : ''
    if (!r.ok || out.startsWith('QT_NOFILE')) return setMsg('서버에서 checks.csv 를 찾지 못했습니다(/tmp 가 비워졌을 수 있습니다)')
    void window.electronAPI.probeRawSave(run.id, out) // 받은 김에 이 PC 에도 둔다
    const res = await window.electronAPI.saveReport({ defaultName: `응답측정_원문_${run.id}.csv`, content: maskForExport(header + out), format: 'csv' })
    setMsg(res.saved ? `저장했습니다 — ${res.path ?? ''}` : res.error ? `저장 실패 — ${res.error}` : '')
  }

  const requestClose = () => {
    if (active) setCloseAsk(true)
    else onClose()
  }

  const elapsed = active ? Date.now() - active.run.startedAt : 0
  const stateCls: Record<string, string> = {
    ok: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200',
    down: 'border-red-500/40 bg-red-500/15 text-red-200',
    recovering: 'border-amber-500/40 bg-amber-500/10 text-amber-200',
    never: 'border-white/10 bg-white/[0.03] text-gray-400',
    waiting: 'border-white/10 bg-white/[0.03] text-gray-400',
  }

  if (minimized)
    return (
      <div
        onMouseDown={onChipDown}
        style={chipPos ? { left: chipPos.x, top: chipPos.y } : { right: 16, bottom: 16 }}
        className="fixed z-50 flex cursor-move select-none items-center gap-2 rounded-lg border border-white/10 bg-panel px-3 py-2 shadow-2xl"
      >
        <Radar size={15} className="text-blue-400" />
        <span className="text-xs font-medium text-gray-100">응답 측정</span>
        {active && sum && (
          <span className={'rounded px-1.5 py-0.5 text-[10.5px] ' + (sum.downCount ? 'bg-red-500/20 text-red-200' : 'bg-emerald-500/15 text-emerald-200')}>
            정상 {sum.okCount}/{sum.targets.length}
          </span>
        )}
        {active && <Loader2 size={11} className="animate-spin text-gray-400" />}
        <button onClick={() => setMinimized(false)} title="펼치기" className="rounded p-1 text-gray-400 hover:bg-white/10 hover:text-gray-200">
          <Maximize2 size={14} />
        </button>
      </div>
    )

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6">
      <div className="flex h-[86vh] w-[1400px] max-w-[97vw] flex-col overflow-hidden rounded-lg border border-white/10 bg-panel shadow-2xl">
        <div className="flex items-center gap-2 border-b border-white/10 px-4 py-2.5">
          <Radar size={16} className="text-blue-400" />
          <span className="text-sm font-semibold text-gray-100">응답 측정</span>
          <span className="text-[11px] text-gray-500">서버의 HTTP · TCP · ICMP 응답을 측정합니다</span>
          {active && (
            <span className="ml-2 flex items-center gap-1 rounded bg-blue-500/15 px-2 py-0.5 text-[11px] text-blue-200">
              <Loader2 size={11} className="animate-spin" /> 측정 중 · {fmtGap(elapsed)}
              {alive === false && <span className="text-red-300"> · 서버의 측정이 멈춤</span>}
            </span>
          )}
          <button onClick={minimize} title="최소화 — 측정은 계속됩니다" className="ml-auto rounded p-1 text-gray-400 hover:bg-white/10 hover:text-gray-200">
            <Minus size={16} />
          </button>
          <button onClick={requestClose} title="닫기" className="rounded p-1 text-gray-400 hover:bg-white/10 hover:text-gray-200">
            <X size={16} />
          </button>
        </div>

        <div className="flex min-h-0 flex-1">
          {/* 왼쪽: 설정 + 이력 */}
          <div className="flex w-[470px] shrink-0 flex-col gap-3 overflow-y-auto border-r border-white/10 p-4 text-[12px] text-gray-300">
            <label className="block">
              <span className="mb-1 block text-gray-400" title="대상 서버에 요청을 보낼 서버 — 측정 스크립트가 여기서 돈다. 장애를 낼 노드는 고르지 마세요">
                클라이언트 VM
              </span>
              <select
                value={hostId}
                disabled={!!active}
                onChange={(e) => setHostId(e.target.value)}
                className="w-full rounded border border-white/10 bg-panel-light px-2 py-1 text-[12px] text-gray-100 disabled:opacity-60"
              >
                <option value="">세션 선택</option>
                {connected.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
            <div>
              <span className="mb-1 block text-gray-400">방식</span>
              <div className="inline-flex overflow-hidden rounded border border-white/15 text-[11.5px]">
                {(
                  [
                    ['http', 'HTTP (curl)', '상태 코드가 기대값(기본 200)이면 정상 — 웹 서비스(nginx·apache)'],
                    ['tcp', 'TCP (포트)', '대상:포트 로 연결이 열리면 정상 — DB·SSH 등 HTTP 가 아닌 서비스. bash /dev/tcp(없으면 nc)'],
                    ['icmp', 'Ping (ICMP)', 'ping 에 응답하면 정상 — VM 이 네트워크에 살아 있는지'],
                  ] as const
                ).map(([k, label, tip]) => (
                  <button
                    key={k}
                    disabled={!!active}
                    title={tip}
                    onClick={() => setCfg((c) => ({ ...c, mode: k }))}
                    className={'px-2.5 py-1 ' + (mode === k ? 'bg-blue-500/25 text-blue-100' : 'text-gray-400 hover:bg-white/5')}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <p className="mt-1 text-[10.5px] text-gray-500">
                {mode === 'http'
                  ? '웹 서비스 응답 — 상태 코드가 기대값이면 정상입니다.'
                  : mode === 'tcp'
                    ? '포트 연결 — 대상:포트 로 TCP 연결이 열리면 정상입니다(DB · SSH 등). 포트는 필수입니다.'
                    : 'Ping — ICMP 응답이 오면 정상입니다(VM 이 네트워크에 살아 있는지). 방화벽이 ICMP 를 막으면 늘 끊김으로 나옵니다.'}
              </p>
            </div>
            <div className="rounded border border-white/10 bg-white/[0.02] px-2 py-1.5">
              <div className="mb-1 text-[11px] text-gray-400">대상 세트 — 저장해 두고 불러 씁니다(방식 · 대상 목록)</div>
              <div className="flex items-center gap-1.5">
                <select
                  value={setPick}
                  disabled={!!active}
                  onChange={(e) => loadSet(e.target.value)}
                  className="min-w-0 flex-1 rounded border border-white/10 bg-panel-light px-1.5 py-1 text-[11.5px] text-gray-100 disabled:opacity-60"
                >
                  <option value="">{sets.length ? '불러올 세트 선택' : '저장한 세트 없음'}</option>
                  {sets.map((x) => (
                    <option key={x.name} value={x.name}>
                      {x.name} · {(x.mode === 'tcp' ? 'TCP' : x.mode === 'icmp' ? 'Ping' : 'HTTP')}
                    </option>
                  ))}
                </select>
                <button
                  disabled={!!active || !setPick}
                  onClick={() => setSetDelAsk(setPick)}
                  title="고른 세트 삭제"
                  className="rounded border border-white/10 p-1 text-gray-400 hover:bg-white/10 hover:text-gray-200 disabled:opacity-40"
                >
                  <Trash2 size={12} />
                </button>
              </div>
              <div className="mt-1 flex items-center gap-1.5">
                <input
                  value={setName}
                  disabled={!!active}
                  onChange={(e) => setSetName(e.target.value)}
                  placeholder="세트 이름 (예: com01 VM)"
                  className="min-w-0 flex-1 rounded border border-white/10 bg-panel-light px-1.5 py-1 text-[11.5px] text-gray-100 placeholder:text-gray-600 disabled:opacity-60"
                />
                <button
                  disabled={!!active}
                  onClick={saveSet}
                  title="지금 방식과 대상을 이 이름으로 저장(같은 이름이면 덮어씀)"
                  className="rounded border border-white/10 px-2 py-1 text-[11.5px] text-gray-200 hover:bg-white/10 disabled:opacity-40"
                >
                  저장
                </button>
              </div>
            </div>
            <div>
              <div className="mb-1 flex items-center gap-2">
                <span className="text-gray-400">대상</span>
                <div className="inline-flex overflow-hidden rounded border border-white/15 text-[11.5px]">
                  {(
                    [
                      ['form', '수동 입력'],
                      ['text', '자유 형식 입력'],
                    ] as const
                  ).map(([k, label]) => (
                    <button
                      key={k}
                      disabled={!!active}
                      onClick={() => switchTab(k)}
                      className={'px-2.5 py-1 ' + (inputTab === k ? 'bg-blue-500/25 text-blue-100' : 'text-gray-400 hover:bg-white/5')}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <button
                  disabled={!!active}
                  onClick={() => setNovaOpen(true)}
                  title="컴퓨트 노드 위 VM 을 Nova 에서 불러와 골라 넣기"
                  className="ml-auto rounded border border-white/10 px-1.5 py-0.5 text-[11px] text-gray-300 hover:bg-white/10 disabled:opacity-40"
                >
                  노드 VM 불러오기
                </button>
                <span className="text-[11px] text-gray-500">{parsed.targets.length}개 대상</span>
              </div>
              {inputTab === 'form' ? (
                <div className="rounded border border-white/10 bg-panel-light/40 p-1.5">
                  <div className={'mb-1 grid gap-1 px-0.5 text-[10.5px] text-gray-500 ' + gridCols}>
                    <span>이름</span>
                    <span>IP · 호스트</span>
                    {mode !== 'icmp' && <span>포트{mode === 'tcp' ? ' *' : ''}</span>}
                    {mode === 'http' && <span>경로</span>}
                    {mode === 'http' && <span title="https 로 요청">https</span>}
                    <span />
                  </div>
                  {rows.map((r, i) => (
                    <div key={i} className={'mb-1 grid items-center gap-1 ' + gridCols}>
                      <input
                        value={r.name}
                        disabled={!!active}
                        onChange={(e) => setRow(i, { name: e.target.value })}
                        placeholder={`web-${String(i + 1).padStart(2, '0')}`}
                        className="min-w-0 rounded border border-white/10 bg-panel-light px-1.5 py-1 text-[11.5px] text-gray-100 placeholder:text-gray-600 disabled:opacity-60"
                      />
                      <input
                        value={r.host}
                        disabled={!!active}
                        onChange={(e) => setRow(i, { host: e.target.value.trim() })}
                        onPaste={(e) => {
                          if (pasteHosts(i, e.clipboardData.getData('text'))) e.preventDefault()
                        }}
                        placeholder="10.255.42.55"
                        title="여러 줄을 붙여넣으면 줄마다 행이 생깁니다"
                        className="min-w-0 rounded border border-white/10 bg-panel-light px-1.5 py-1 font-mono text-[11.5px] text-gray-100 placeholder:text-gray-600 disabled:opacity-60"
                      />
                      {mode !== 'icmp' && (
                        <input
                          value={r.port}
                          disabled={!!active}
                          onChange={(e) => setRow(i, { port: e.target.value.replace(/[^0-9]/g, '').slice(0, 5) })}
                          placeholder={mode === 'tcp' ? '22' : r.https ? '443' : '80'}
                          className={
                            'min-w-0 rounded border bg-panel-light px-1.5 py-1 font-mono text-[11.5px] text-gray-100 placeholder:text-gray-600 disabled:opacity-60 ' +
                            (mode === 'tcp' && r.host.trim() && !r.port.trim() ? 'border-red-500/60' : 'border-white/10')
                          }
                        />
                      )}
                      {mode === 'http' && (
                        <input
                          value={r.path}
                          disabled={!!active}
                          onChange={(e) => setRow(i, { path: e.target.value.trim() })}
                          placeholder="/"
                          className="min-w-0 rounded border border-white/10 bg-panel-light px-1.5 py-1 font-mono text-[11.5px] text-gray-100 placeholder:text-gray-600 disabled:opacity-60"
                        />
                      )}
                      {mode === 'http' && (
                        <input
                          type="checkbox"
                          checked={r.https}
                          disabled={!!active}
                          onChange={(e) => setRow(i, { https: e.target.checked })}
                          className="justify-self-center"
                        />
                      )}
                      <button
                        disabled={!!active}
                        onClick={() => setRows((rs) => (rs.length > 1 ? rs.filter((_, k) => k !== i) : [emptyRow()]))}
                        title="이 행 삭제"
                        className="rounded p-0.5 text-gray-500 hover:bg-white/10 hover:text-gray-200 disabled:opacity-40"
                      >
                        <X size={12} />
                      </button>
                    </div>
                  ))}
                  <button
                    disabled={!!active}
                    onClick={() => setRows((rs) => [...rs, emptyRow()])}
                    className="mt-0.5 flex items-center gap-1 rounded px-1.5 py-0.5 text-[11.5px] text-gray-400 hover:bg-white/5 hover:text-gray-200 disabled:opacity-40"
                  >
                    <Plus size={12} /> 행 추가
                  </button>
                  <p className="mt-1 px-0.5 text-[10.5px] text-gray-500">
                    {mode === 'http'
                      ? '포트를 비우면 80(https 는 443). 경로를 비우면 / 로 요청합니다.'
                      : mode === 'tcp'
                        ? '포트는 필수입니다(예: SSH 22 · MySQL 3306 · PostgreSQL 5432).'
                        : 'IP 또는 호스트명만 넣습니다.'}
                  </p>
                </div>
              ) : (
                <>
                  <textarea
                    value={targetsText}
                    disabled={!!active}
                    onChange={(e) => setTargetsText(e.target.value)}
                    rows={9}
                    placeholder={
                      mode === 'tcp'
                        ? 'db-01 10.255.42.60:3306\nvm-02 10.255.42.61:22'
                        : mode === 'icmp'
                          ? 'vm-01 10.255.42.55\nvm-02 10.255.42.56'
                          : 'web-01 10.255.42.55\nweb-02 10.255.42.56:8080\nhttps://10.255.42.57/health'
                    }
                    className="w-full rounded border border-white/10 bg-panel-light px-2 py-1.5 font-mono text-[11.5px] text-gray-100 placeholder:text-gray-600 disabled:opacity-60"
                  />
                  <p className="text-[10.5px] text-gray-500">
                    한 줄에 하나 — `이름 주소` 또는 주소만.{' '}
                    {mode === 'http' ? 'IP 만 쓰면 http://IP(80번 포트)' : mode === 'tcp' ? '주소는 IP:포트' : '주소는 IP 또는 호스트명'}
                  </p>
                </>
              )}
              {parsed.errors.length > 0 && <p className="mt-1 text-[11px] text-red-300">{parsed.errors[0]}</p>}
            </div>
            <div className="grid grid-cols-2 gap-2">
              {(
                [
                  ['intervalSec', '주기(초)', 1, 60],
                  ['timeoutSec', '타임아웃(초)', 1, 30],
                  ['needOk', '연속 정상(회)', 1, 30],
                  ['needFail', '연속 실패(회)', 1, 30],
                  ['maxMin', '최대 측정(분)', 5, 1440],
                ] as const
              )
                .map(([k, label, min, max]) => (
                <label key={k} className="block">
                  <span className="mb-0.5 block text-[11px] text-gray-400">{label}</span>
                  <input
                    type="number"
                    min={min}
                    max={max}
                    value={cfg[k]}
                    disabled={!!active}
                    onChange={(e) => setCfg((c) => ({ ...c, [k]: Math.min(max, Math.max(min, Number(e.target.value) || min)) }))}
                    className="w-full rounded border border-white/10 bg-panel-light px-2 py-1 text-[12px] text-gray-100 disabled:opacity-60"
                  />
                </label>
              ))}
            </div>
            {mode === 'http' && (
              <div className="rounded border border-white/10 bg-white/[0.02] px-2 py-1.5">
                <div className="mb-1 text-[11px] text-gray-400">HTTP 판정</div>
                <div className="grid grid-cols-2 gap-2">
                  <label className="block">
                    <span className="mb-0.5 block text-[11px] text-gray-400">정상 HTTP 코드</span>
                    <input
                      value={cfg.expectSpec ?? String(cfg.expectCode)}
                      disabled={!!active}
                      onChange={(e) => setCfg((c) => ({ ...c, expectSpec: e.target.value }))}
                      placeholder="200 · 2xx · 200,302"
                      title="쉼표로 여러 개, x 는 아무 숫자(2xx = 200~299)"
                      className={
                        'w-full rounded border bg-panel-light px-2 py-1 font-mono text-[12px] text-gray-100 placeholder:text-gray-600 disabled:opacity-60 ' +
                        (specValid(cfg.expectSpec ?? '') ? 'border-white/10' : 'border-red-500/60')
                      }
                    />
                  </label>
                  <label className="block">
                    <span className="mb-0.5 block text-[11px] text-gray-400">Host 헤더 (선택)</span>
                    <input
                      value={cfg.hostHeader ?? ''}
                      disabled={!!active}
                      onChange={(e) => setCfg((c) => ({ ...c, hostHeader: e.target.value.trim() }))}
                      placeholder="portal.example.com"
                      title="한 IP 에 이름으로 나뉜 사이트(가상 호스트) 중 하나를 고를 때"
                      className="w-full rounded border border-white/10 bg-panel-light px-2 py-1 font-mono text-[12px] text-gray-100 placeholder:text-gray-600 disabled:opacity-60"
                    />
                  </label>
                </div>
                <label className="mt-1.5 flex items-center gap-2 text-[12px]">
                  <input
                    type="checkbox"
                    checked={!!cfg.follow}
                    disabled={!!active}
                    onChange={(e) => setCfg((c) => ({ ...c, follow: e.target.checked }))}
                  />
                  <span>리다이렉트 따라가기</span>
                  <span className="text-[11px] text-gray-500">— 301·302 를 따라가 최종 페이지 코드로 판정</span>
                </label>
              </div>
            )}
            <label className="flex items-center gap-2 text-[12px]">
              <input
                type="checkbox"
                checked={cfg.autoStop}
                disabled={!!active}
                onChange={(e) => setCfg((c) => ({ ...c, autoStop: e.target.checked }))}
              />
              <span>끊겼던 대상이 모두 복구되면 자동 종료</span>
              <input
                type="number"
                min={0}
                max={300}
                value={cfg.settleSec}
                disabled={!!active || !cfg.autoStop}
                onChange={(e) => setCfg((c) => ({ ...c, settleSec: Math.min(300, Math.max(0, Number(e.target.value) || 0)) }))}
                className="w-14 rounded border border-white/10 bg-panel-light px-1.5 py-0.5 text-[12px] text-gray-100 disabled:opacity-50"
              />
              <span className="text-gray-500">초 더 보고</span>
            </label>
            <p className="text-[11px] leading-relaxed text-gray-500">
              연속 {cfg.needFail}회 실패해야 끊김으로 셉니다(한 번 튄 실패는 무시, 끊김 시각은 그 첫 실패). 최대 {cfg.maxMin}분이 지나면
              서버에서 스스로 멈춥니다. 노드를 죽이기 <b className="text-gray-300">전에</b> 시작하세요 — 처음 정상(연속 {cfg.needOk}회)을 확인한 대상만 끊김을 셉니다.
              복구 시각은 연속 정상이 시작된 첫 성공입니다.
            </p>
            {!active ? (
              <button
                onClick={() => void start()}
                disabled={busy}
                className="flex items-center justify-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-[12.5px] font-medium text-white hover:bg-blue-500 disabled:opacity-50"
              >
                {busy ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />} 측정 시작
              </button>
            ) : (
              <button
                onClick={() => void stop()}
                disabled={busy}
                className="flex items-center justify-center gap-1.5 rounded-md bg-red-600/80 px-3 py-1.5 text-[12.5px] font-medium text-white hover:bg-red-500 disabled:opacity-50"
              >
                {busy ? <Loader2 size={14} className="animate-spin" /> : <Square size={14} />} 측정 중지
              </button>
            )}
            {msg && <div className="rounded bg-white/[0.04] px-2 py-1.5 text-[11.5px] text-gray-300">{msg}</div>}

            <div className="mt-2 border-t border-white/10 pt-3">
              <div className="mb-1 flex items-center gap-1.5 text-gray-400">
                <History size={13} /> 지난 측정 · {(mode === 'http' ? 'HTTP' : modeText({ mode, expectCode: cfg.expectCode }))} {modeHistory.length}회
                <span className="ml-auto text-[10.5px] text-gray-500">최근 {HIST_MAX}회 보관</span>
              </div>
              <p className="mb-1.5 text-[10.5px] leading-relaxed text-gray-500">
                지금 고른 방식으로 잰 회차만 보입니다(방식마다 최근 {HIST_MAX}회). 누르면 결과를 다시 열어 리포트·CSV 를 뽑을 수 있고,
                삭제해도 클라이언트 VM 의 /tmp/qterm-probe 기록은 남습니다.
              </p>
              {modeHistory.length === 0 && <div className="text-[11px] text-gray-500">아직 없습니다.</div>}
              {modeHistory.map((h) => {
                const s = summarize(h.config, h.events, [])
                return (
                  <div
                    key={h.id}
                    onClick={() => !active && setViewId(h.id)}
                    className={
                      'mb-1 flex cursor-pointer items-center gap-2 rounded border px-2 py-1.5 text-[11.5px] ' +
                      (viewId === h.id && !active ? 'border-blue-500/50 bg-blue-500/10' : 'border-white/10 hover:bg-white/5')
                    }
                  >
                    <span className="text-gray-200">{fmtDateTime(h.startedAt)}</span>
                    <span className="text-gray-500">{h.config.targets.length}대</span>
                    <span className="text-gray-400">{s.maxGap != null ? `최장 ${fmtGap(s.maxGap)}` : '끊김 없음'}</span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        const next = history.filter((x) => x.id !== h.id)
                        setHistory(next)
                        saveJson(HIST_KEY, next)
                        void window.electronAPI.probeRawDelete([h.id])
                        if (viewId === h.id) setViewId(null)
                      }}
                      title="이 기록 삭제 — 이 PC 에 받아 둔 원문도 지웁니다(클라이언트 VM 의 /tmp 기록은 남습니다)"
                      className="ml-auto rounded p-0.5 text-gray-500 hover:bg-white/10 hover:text-gray-200"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                )
              })}
            </div>
          </div>

          {/* 오른쪽: 대상 상태 · 요약 · 이벤트 */}
          <div className="min-w-0 flex-1 overflow-y-auto p-4">
            {!shown || !sum ? (
              <div className="flex h-full items-center justify-center text-[12.5px] text-gray-500">
                클라이언트 VM 과 대상을 정하고 [측정 시작]을 누르세요. 지난 측정은 왼쪽 목록에서 열 수 있습니다.
              </div>
            ) : (
              <>
                {pollErr && active && <div className="mb-3 rounded bg-amber-500/10 px-3 py-1.5 text-[11.5px] text-amber-200">{pollErr}</div>}
                {active && alive === false && (
                  <div className="mb-3 rounded bg-red-500/10 px-3 py-1.5 text-[11.5px] text-red-200">
                    클라이언트 VM 의 측정 프로세스가 멈췄습니다 — 최대 측정 시간({active.run.config.maxMin ?? 180}분)이 지났거나 서버가 재부팅됐을 수 있습니다.
                    이후는 기록되지 않습니다. [측정 중지]로 지금까지의 결과를 저장하세요.
                  </div>
                )}
                {active && !activeSid && (
                  <div className="mb-3 rounded bg-amber-500/10 px-3 py-1.5 text-[11.5px] text-amber-200">
                    클라이언트 VM({shown.host}) 세션이 연결돼 있지 않습니다 — 측정은 서버에서 계속 돌고 있고, 다시 연결하면 이어서 보여 줍니다.
                  </div>
                )}
                <div className="mb-3 flex flex-wrap items-center gap-2 text-[12px]">
                  <span className="text-gray-300">{fmtDateTime(shown.startedAt)}</span>
                  <span className="text-gray-500">클라이언트 VM {shown.host}</span>
                  <code className="text-[11px] text-gray-500">{shown.dir}</code>
                  {!active && (
                    <span className="ml-auto flex gap-1.5">
                      <button
                        onClick={() => void exportHtml(shown)}
                        title="요약 · 대상별 끊김 구간 막대 · 표 · 이벤트 원문이 담긴 HTML 한 파일(브라우저로 열고 인쇄)"
                        className="flex items-center gap-1 rounded border border-blue-500/40 bg-blue-500/15 px-2 py-1 text-[11.5px] text-blue-100 hover:bg-blue-500/25"
                      >
                        <FileText size={12} /> 리포트 (HTML)
                      </button>
                      <button
                        onClick={() => void exportMd(shown)}
                        className="flex items-center gap-1 rounded border border-white/10 px-2 py-1 text-[11.5px] text-gray-200 hover:bg-white/10"
                      >
                        <FileText size={12} /> 결과 저장 (Markdown)
                      </button>
                      <button
                        onClick={() => void exportCsv(shown)}
                        title="클라이언트 VM 에 남은 모든 요청 기록(checks.csv)을 받아 저장"
                        className="flex items-center gap-1 rounded border border-white/10 px-2 py-1 text-[11.5px] text-gray-200 hover:bg-white/10"
                      >
                        <Download size={12} /> 원문 CSV
                      </button>
                    </span>
                  )}
                </div>
                <div className="mb-3 grid grid-cols-4 gap-2">
                  {[
                    // 끝난 측정에는 '지금 상태' 가 없다 — 정상 0/10 처럼 읽히지 않게 끊겼던 대상 수를 보인다
                    active
                      ? ['정상', `${sum.okCount} / ${sum.targets.length}`]
                      : ['끊겼던 대상', `${sum.targets.filter((t) => t.outages.length).length} / ${sum.targets.length}`],
                    ['첫 끊김', sum.firstOutage ? fmtClock(sum.firstOutage) : '-'],
                    [
                      '끊긴 대상 모두 복구',
                      sum.allRecovered ? fmtClock(sum.allRecovered) : sum.firstOutage ? (active ? '측정 중' : '복구 안 됨') : '-',
                    ],
                    ['가장 긴 순단', sum.maxGap != null ? fmtGap(sum.maxGap) : '-'],
                  ].map(([k, v]) => (
                    <div key={k} className="rounded-lg bg-white/[0.04] px-3 py-2">
                      <div className="text-[11px] text-gray-500">{k}</div>
                      <div className="text-[18px] font-medium tabular-nums text-gray-100">{v}</div>
                    </div>
                  ))}
                </div>
                {sum.firstOutage && sum.allRecovered && (
                  <p className="mb-3 text-[12px] text-gray-400">
                    첫 끊김부터 모두 복구까지 <b className="text-gray-100">{fmtGap(sum.allRecovered - sum.firstOutage)}</b>
                  </p>
                )}
                <div className="mb-4 grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))' }}>
                  {sum.targets.map((t) => {
                    const openO = t.outages.find((o) => o.end == null)
                    const closed = t.outages.filter((o) => o.end != null)
                    const label = active
                      ? {
                          ok: t.outages.length ? '정상 (복구됨)' : '정상',
                          down: '끊김',
                          recovering: `복구 확인 중 ${t.streak}/${shown.config.needOk}`,
                          never: '처음부터 응답 없음',
                          waiting: '첫 정상 확인 중',
                        }[t.state]
                      : t.outages.length
                        ? openO
                          ? '복구 안 됨'
                          : '복구됨'
                        : t.ready
                          ? '끊김 없음'
                          : '응답 없음'
                    return (
                      <div key={t.idx} className={'rounded-lg border px-2.5 py-2 text-[11.5px] ' + (active ? stateCls[t.state] : 'border-white/10 bg-white/[0.03] text-gray-300')}>
                        <div className="flex items-center gap-1.5">
                          <b className="truncate font-medium" title={t.url}>
                            {t.name}
                          </b>
                          {active && <span className="ml-auto text-[10.5px] opacity-80">{codeText(t.lastCode, shown.config.mode)}</span>}
                        </div>
                        <div>{label}</div>
                        {openO && active && (
                          <div className="tabular-nums opacity-80">
                            {fmtWhole(Date.now() - (hostOffsetRef.current ?? 0) - openO.start)}째
                          </div>
                        )}
                        {/* 구간과 순단을 한 줄에 붙이면 칸 폭에서 접혀 읽기 어려웠다 — 두 줄로 고정한다 */}
                        {closed.map((o, i) => (
                          <div key={i} className="mt-0.5 tabular-nums opacity-85">
                            <div className="whitespace-nowrap">
                              {fmtClock(o.start)} → {fmtClock(o.end as number)}
                            </div>
                            <div className="whitespace-nowrap">순단 {fmtGap((o.end as number) - o.start)}</div>
                          </div>
                        ))}
                      </div>
                    )
                  })}
                </div>
                <div className="mb-1 text-[12px] text-gray-400">타임라인 (클라이언트 VM events.csv · 최신 순)</div>
                <div className="rounded-lg bg-black/30 p-2 font-mono text-[11px] leading-[1.6] text-gray-300">
                  {shown.events.length === 0 && <div className="text-gray-500">아직 없음</div>}
                  {[...shown.events].reverse().map((e, i) => (
                    <div key={i} className={e.kind === 'outage' ? 'text-red-300' : e.kind === 'recovered' ? 'text-emerald-300' : 'text-gray-400'}>
                      {fmtDateTime(e.at)} · {shown.config.targets[e.idx]?.name ?? e.idx} ·{' '}
                      {e.kind === 'ready'
                        ? `첫 정상 확인 (연속 ${shown.config.needOk}회, 첫 성공 ${fmtClock(e.base)})`
                        : e.kind === 'outage'
                          ? `끊김 (${outageReason(e.code, shown.config.mode)})`
                          : `복구 첫 성공 시간(${fmtClock(e.base)}) · 순단 ${e.outageStart ? fmtGap(e.base - e.outageStart) : '-'}`}
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
      {novaOpen && (
        <NovaPicker
          sessions={sessions}
          defaultSid={hostId}
          rc={novaRc}
          onRc={(v) => {
            setNovaRc(v)
            saveJson('response_probe_nova_rc_v1', v)
          }}
          onAdd={addFromNova}
          onClose={() => setNovaOpen(false)}
        />
      )}
      {setDelAsk && (
        <ConfirmDialog
          title="대상 세트 삭제"
          message={`"${setDelAsk}" 세트를 지울까요? 지금 입력돼 있는 대상은 그대로 남습니다.`}
          onConfirm={() => {
            const next = sets.filter((x) => x.name !== setDelAsk)
            setSets(next)
            saveJson(SETS_KEY, next)
            setSetPick('')
            setSetDelAsk(null)
          }}
          onCancel={() => setSetDelAsk(null)}
        />
      )}
      {closeAsk && (
        <ConfirmDialog
          title="측정 중입니다"
          message={
            '측정은 클라이언트 VM 에서 돌고 있습니다.\n' +
            '· 측정 중지하고 닫기 — 서버의 측정을 내리고 이력에 남깁니다\n' +
            '· 계속 측정하고 닫기 — 서버에서 계속 돌고, 다시 열면 이어서 보여 줍니다'
          }
          confirmLabel="측정 중지하고 닫기"
          onConfirm={() => {
            setCloseAsk(false)
            void stop().then(onClose)
          }}
          secondaryLabel="계속 측정하고 닫기"
          onSecondary={() => {
            setCloseAsk(false)
            onClose()
          }}
          onCancel={() => setCloseAsk(false)}
        />
      )}
    </div>
  )
}
