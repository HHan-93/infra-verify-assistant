import { useEffect, useRef, useState } from 'react'
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Loader2,
  Plus,
  RefreshCw,
  Settings,
  Trash2,
  X,
} from 'lucide-react'
import {
  applyObservation,
  defaultPortalConfig,
  describeCheck,
  emptyTargetState,
  fillLoginBody,
  headersFor,
  jwtExpMs,
  looksEncrypted,
  jsonAt,
  judgeResponse,
  newTargetId,
  headersFromCurl,
  normalizeConfig,
  originHeaders,
  parseBody,
  parseCurl,
  pathFromUrl,
  suggestArrayPaths,
  phaseOf,
  streakNeeded,
  urlOf,
  type PortalCheck,
  type PortalConfig,
  type PortalTarget,
  type TargetState,
} from '../lib/portal'

/**
 * 서비스 포털 응답 감시 패널.
 *
 * 상태보드(노드/VIP/Ceph/파드)와 **같은 회차** 안에서 돌면서, 포털 각 페이지가 부르는 API 가
 * 언제 다시 실데이터를 200 으로 돌려주는지를 잰다. 그 시각이 상태보드 복구 타임라인에 합류한다.
 */

export interface PortalMilestone {
  at: number
  name: string
  group?: string
  /** 이 시각을 확정지은 연속 성공 횟수 — 타임라인에 근거로 같이 적는다 */
  streak: number
}

interface Props {
  /** 상태보드 검증이 돌고 있는지 — 여기에 맞춰 감시를 켜고 끈다 */
  running: boolean
  /** 이번 회차 시작 시각 (경과시간 표시 기준) */
  t0: number
  /**
   * 노드 DOWN 을 인지한 시각. null 이면 아직 아무도 안 죽었다는 뜻.
   *
   * 감시는 평상시에도 돌지만 **타임라인에는 이 시각 이후의 복구만** 올린다.
   * 안 그러면 장애와 무관한 순간적인 흔들림까지 '복구'로 찍혀 타임라인이 지저분해지고,
   * 정작 이번 장애에서 언제 살아났는지가 묻힌다.
   */
  downAt: number | null
  /** 복구가 확정된 대상을 상위(상태보드 타임라인)로 올린다 */
  onMilestones: (list: PortalMilestone[]) => void
}

const fmtClock = (ms: number) => {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
const fmtElapsed = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s}초` : `${Math.floor(s / 60)}분 ${s % 60}초`
}

export default function PortalPanel({ running, t0, downAt, onMilestones }: Props) {
  const [cfg, setCfg] = useState<PortalConfig | null>(null)
  const [view, setView] = useState<'board' | 'config'>('board')
  const [states, setStates] = useState<Record<string, TargetState>>({})
  const [notice, setNotice] = useState('')
  const [authNote, setAuthNoteState] = useState('')
  /** 설정 화면에서는 인증 줄이 안 보인다 — 시험 버튼이 그 사유를 그 자리에 보여주려면 즉시 읽을 값이 필요하다 */
  const authNoteRef = useRef('')
  const setAuthNote = (s: string) => {
    authNoteRef.current = s
    setAuthNoteState(s)
  }
  const [loginTest, setLoginTest] = useState<{ ok: boolean; text: string } | null>(null)
  const [loginTesting, setLoginTesting] = useState(false)
  /**
   * 토큰 갱신 이력. 접힌 줄에서도 "갱신이 돌고 있다"를 한눈에 보이게 하려는 것 —
   * 이게 안 보이면 몇 분마다 패널을 펼쳐 인증 줄의 시각을 눈으로 비교해야 한다.
   */
  const [tokenStat, setTokenStat] = useState<{ count: number; lastAt: number; gapMs: number | null }>({
    count: 0,
    lastAt: 0,
    gapMs: null,
  })
  /** 접힌 줄에서 어느 대상을 비추고 있는지 — 3초마다 넘어간다 */
  const [spotIdx, setSpotIdx] = useState(0)
  useEffect(() => {
    // 3초는 한 줄을 읽고 넘어가기에 알맞은 간격이다. 더 짧으면 눈이 못 따라간다.
    const t = setInterval(() => setSpotIdx((n) => n + 1), 3000)
    return () => clearInterval(t)
  }, [])
  /**
   * 접힘/펼침.
   *
   * 예전에는 검증이 시작되면 무조건 펼쳤는데, 대상이 5개면 화면 절반을 먹어
   * 정작 주인공인 'Host — 전원 상태' 가 아래로 밀렸다. 그래서 평소엔 접힌 한 줄로 두고
   * **비정상이 하나라도 생기면 스스로 펼친다.** 사용자가 직접 연 건 건드리지 않는다.
   */
  const [open, setOpen] = useState(false)
  /** 자동으로 펼친 적이 있는지 — 사용자가 도로 접으면 같은 장애로 또 열지 않는다 */
  const autoOpenedRef = useRef(false)
  useEffect(() => {
    if (!running) {
      autoOpenedRef.current = false
      return
    }
    if (autoOpenedRef.current) return
    if (Object.values(states).some((st) => st.last && !st.last.ok)) {
      autoOpenedRef.current = true
      setOpen(true)
    }
  }, [running, states])

  const cfgRef = useRef<PortalConfig | null>(null)
  cfgRef.current = cfg
  const statesRef = useRef<Record<string, TargetState>>({})
  const runningRef = useRef(false)
  const mountedRef = useRef(true)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const tokenRef = useRef('')
  /** 토큰을 받아온 시각 — 선제 재발급 주기 계산용 */
  const tokenAtRef = useRef(0)
  /** 동시에 여러 대상이 401 을 받아도 재로그인은 한 번만 — 로그인 폭주 방지 */
  const loginRef = useRef<Promise<string> | null>(null)
  // 폴링은 타이머로 돌아 props 를 옛 값으로 붙잡고 있다 — ref 로 지금 값을 읽는다
  const downAtRef = useRef<number | null>(downAt)
  downAtRef.current = downAt
  const onMilestonesRef = useRef(onMilestones)
  onMilestonesRef.current = onMilestones

  // ── 설정 로드/저장 ────────────────────────────────────────────
  useEffect(() => {
    mountedRef.current = true
    void (async () => {
      try {
        const saved = await window.electronAPI.portalGetConfig()
        if (mountedRef.current) setCfg(normalizeConfig(saved))
      } catch (e) {
        // 파일이 손상된 경우 — 기본값으로 덮어쓰지 않는다. 사용자가 보고 판단하게 알린다.
        if (mountedRef.current) {
          setCfg(defaultPortalConfig())
          setNotice(`저장된 감시 설정을 읽지 못했습니다 (${e instanceof Error ? e.message : String(e)}). 기본값으로 시작합니다 — 저장하면 덮어씁니다.`)
        }
      }
    })()
    return () => {
      mountedRef.current = false
      runningRef.current = false
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  const save = async (next: PortalConfig) => {
    setCfg(next)
    try {
      await window.electronAPI.portalSetConfig(next)
    } catch (e) {
      setNotice(`설정 저장 실패: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // ── 토큰 ─────────────────────────────────────────────────────
  /** 토큰을 받아온다(로그인 또는 재발급). 실패하면 빈 문자열 + 사유를 남긴다 */
  const doLogin = async (c: PortalConfig): Promise<string> => {
    const a = c.auth
    if (a.mode === 'none') return ''
    if (a.mode === 'token') return a.token?.trim() ?? ''

    if (!a.username || !a.password || !a.loginPath) {
      setAuthNote('로그인 정보가 비어 있습니다 — 설정에서 계정/경로를 채우세요')
      return ''
    }
    const label = '로그인'
    const method = 'POST'
    const url = urlOf(c, a.loginPath)
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...originHeaders(c),
    }
    const body = fillLoginBody(a.loginBody ?? '', a.username, a.password)

    const r = await window.electronAPI.portalRequest({
      url,
      method,
      headers,
      body,
      timeoutMs: c.timeoutMs,
      insecure: c.insecureTLS,
    })
    if (!r.ok) {
      setAuthNote(`${label} 요청 실패 — ${r.error ?? '알 수 없음'}`)
      return ''
    }
    if ((r.status ?? 0) >= 400) {
      // 404/405 는 '서비스가 안 떴다' 가 아니라 '주소가 틀렸다' 다. 뭉뚱그리면 엉뚱한 데를 뒤지게 된다.
      const misroute =
        r.status === 404
          ? `${label} HTTP 404 — 그런 경로가 없습니다. 개발자도구 Network 에서 실제 로그인 요청의 경로를 확인해 그대로 넣으세요.`
          : r.status === 405
            ? `${label} HTTP 405 — 이 경로는 ${method} 를 받지 않습니다. 경로가 틀렸을 가능성이 큽니다 — 개발자도구 Network 에서 로그인 버튼을 눌렀을 때 나가는 요청의 경로·메서드를 그대로 넣으세요.`
            : r.status === 401 || r.status === 403
              ? `${label} HTTP ${r.status} — 계정이나 비밀번호가 거부되었습니다. 비밀번호는 개발자도구 Payload 의 값(암호화된 문자열이면 그대로)이어야 합니다.`
              : ''
      // 검증 중이라면 그 외의 오류는 관측값이기도 하다 — 인증 서비스가 아직 안 떴다는 뜻.
      setAuthNote(misroute || `${label} HTTP ${r.status} — 인증 서비스가 아직 정상이 아닐 수 있습니다`)
      return ''
    }
    const json = parseBody(r.body)
    const tok = jsonAt(json, c.auth.tokenPath ?? '')
    if (typeof tok !== 'string' || !tok.trim()) {
      // 경로만 알려주면 "그래서 뭐가 왔는데?" 를 확인하러 또 개발자도구를 열어야 한다.
      // 온 것을 그대로 보여주면 대개 그 자리에서 원인이 보인다.
      const body = (r.body ?? '').trim()
      const peek = body ? ` · 받은 응답: ${body.slice(0, 200)}${body.length > 200 ? '…' : ''}` : ''
      setAuthNote(
        `응답에서 토큰을 찾지 못했습니다 (경로: ${c.auth.tokenPath || '(비어 있음)'}) — 설정에서 토큰 위치를 확인하세요${peek}`,
      )
      return ''
    }
    setAuthNote(`${label} 성공 — 토큰 갱신 ${fmtClock(Date.now())}`)
    return tok.trim()
  }

  /**
   * '로그인 시험' — 지금 이 설정으로 토큰을 받아올 수 있는지 그 자리에서 확인한다.
   * 이게 되면 토큰이 만료돼도 401 을 받은 그 주기 안에서 다시 받아 재전송하므로 감시가 끊기지 않는다.
   */
  const testLogin = async () => {
    const c = cfgRef.current
    if (!c) return
    setLoginTesting(true)
    setLoginTest(null)
    try {
      const tok = await doLogin(c)
      if (tok) {
        const exp = jwtExpMs(tok)
        const left = exp ? Math.round((exp - Date.now()) / 60000) : null
        setLoginTest({
          ok: true,
          text: `토큰을 받았습니다 (${tok.length}자${left === null ? '' : ` · 수명 약 ${left}분`}) — 만료돼도 그 자리에서 다시 받아오므로 감시가 끊기지 않습니다.`,
        })
      } else {
        setLoginTest({ ok: false, text: authNoteRef.current || '토큰을 받지 못했습니다.' })
      }
    } catch (e) {
      setLoginTest({ ok: false, text: e instanceof Error ? e.message : String(e) })
    } finally {
      setLoginTesting(false)
    }
  }

  /** 재로그인 — 여러 호출이 겹쳐도 실제 요청은 한 번만 나간다 */
  const refreshToken = (c: PortalConfig): Promise<string> => {
    if (!loginRef.current) {
      const hadToken = tokenAtRef.current > 0
      const prevAt = tokenAtRef.current
      loginRef.current = doLogin(c).then((t) => {
        tokenRef.current = t
        const now = t ? Date.now() : 0
        // 최초 로그인은 '갱신' 이 아니다. 두 번째부터 세야 "몇 번 갈아끼웠나" 가 맞는 말이 된다.
        if (t && hadToken) {
          setTokenStat((s) => ({ count: s.count + 1, lastAt: now, gapMs: prevAt ? now - prevAt : s.gapMs }))
        } else if (t) {
          setTokenStat((s) => ({ ...s, lastAt: now }))
        }
        tokenAtRef.current = now
        loginRef.current = null
        return t
      })
    }
    return loginRef.current
  }

  // ── 대상 하나 관측 ────────────────────────────────────────────
  const probe = async (c: PortalConfig, t: PortalTarget) => {
    const send = (token: string) =>
      window.electronAPI.portalRequest({
        url: urlOf(c, t.path),
        method: t.method,
        headers: headersFor(c, t, token),
        body: t.body,
        timeoutMs: c.timeoutMs,
        insecure: c.insecureTLS,
      })

    const used = tokenRef.current
    let r = await send(used)
    let j = judgeResponse(t, r, c.auth.expiredBodyMatch)
    // 토큰이 만료됐을 뿐이면 새로 받아 한 번만 더 시도한다.
    // (재발급까지 실패하면 그건 그대로 '아직 정상 아님' 으로 기록된다 — 감춰선 안 되는 신호)
    if (j.authExpired && t.auth && c.auth.mode !== 'none') {
      const tok = await refreshToken(c)
      // 값이 그대로면 같은 401 을 한 번 더 받을 뿐이다 — 재시도는 토큰이 실제로 바뀌었을 때만.
      if (tok && tok !== used) {
        r = await send(tok)
        j = judgeResponse(t, r, c.auth.expiredBodyMatch)
      }
      // 직접 붙여넣은 토큰은 다시 받아봐야 같은 값이라 계속 401 이다.
      // 사유를 안 짚어주면 사용자는 경로나 조건을 의심하며 엉뚱한 데를 뒤진다.
      if (j.authExpired && c.auth.mode === 'token') {
        setAuthNote('붙여넣은 access token 이 만료되었습니다 — 아이디/비밀번호 로그인 모드로 바꾸면 자동으로 다시 받아옵니다')
      }
    }
    return { r, j }
  }

  // ── 폴링 루프 ────────────────────────────────────────────────
  const pollOnce = async () => {
    const c = cfgRef.current
    if (!c) return
    const targets = c.targets.filter((t) => t.enabled && (t.path ?? '').trim())
    if (!targets.length) return
    if (c.auth.mode !== 'none') {
      const ageLimit = Math.max(0, c.auth.reissueMinutes ?? 0) * 60_000
      const stale = ageLimit > 0 && tokenAtRef.current > 0 && Date.now() - tokenAtRef.current >= ageLimit
      // 만료를 겪고 나서 고치면 그 한 주기가 비정상으로 찍혀 연속 카운트가 초기화된다.
      // 수명을 아는 포털이면 그 전에 미리 갈아끼운다.
      // 설정한 주기와 별개로, 토큰 안에 적힌 만료 시각이 코앞이면 그것만으로도 갈아끼운다 —
      // 주기를 잘못 잡아둬도 만료로 한 구간이 통째로 날아가지는 않게.
      const exp = jwtExpMs(tokenRef.current)
      const nearExp = !!exp && exp - Date.now() <= Math.max(ageLimit, 60_000)
      if (!tokenRef.current || stale || nearExp) await refreshToken(c)
    }

    const results = await Promise.all(
      targets.map(async (t) => {
        try {
          const { r, j } = await probe(c, t)
          return {
            t,
            obs: {
              at: Date.now(),
              ok: j.ok,
              status: r.status,
              latencyMs: r.latencyMs,
              upstreamMs: r.upstreamMs,
              reasons: j.reasons,
            },
          }
        } catch (e) {
          return {
            t,
            obs: { at: Date.now(), ok: false, reasons: [e instanceof Error ? e.message : String(e)], status: undefined, latencyMs: undefined, upstreamMs: undefined },
          }
        }
      }),
    )
    if (!mountedRef.current || !runningRef.current) return

    const next = { ...statesRef.current }
    const newlyRecovered: PortalMilestone[] = []
    for (const { t, obs } of results) {
      const before = next[t.id] ?? emptyTargetState()
      const needed = streakNeeded(t, c)
      const raw = applyObservation(before, obs, needed)
      // 복구 시각도, '한 번 깨진 적 있음'도 **장애 안에서만** 뜻이 있다.
      // 아무도 안 죽었는데 이 둘을 채우면 화면 곳곳이 평상시에도 '복구' 라고 말한다(실제로 그랬다).
      //   · recoveredAt → 헤더 요약·대상 행의 복구 시각·타임라인
      //   · everFailed  → 대상 배지가 '정상'이 아니라 '복구됨'으로 뜬다 (phaseOf)
      // 여기서 한 번에 막아야 세 곳이 저절로 같은 말을 한다.
      const after = downAtRef.current === null ? { ...raw, recoveredAt: null, everFailed: false } : raw
      next[t.id] = after
      // 타임라인에 올리는 건 **노드가 죽은 뒤** 확정된 것만이다(위 downAt 주석 참고).
      // 아무도 안 죽었으면 감시는 계속 돌지만 타임라인은 건드리지 않는다.
      if (downAtRef.current !== null && before.recoveredAt === null && after.recoveredAt !== null) {
        newlyRecovered.push({ at: after.recoveredAt, name: t.name, group: t.group, streak: needed })
      }
    }
    statesRef.current = next
    setStates(next)
    if (newlyRecovered.length) onMilestonesRef.current(newlyRecovered)
  }

  const loop = async () => {
    if (!runningRef.current) return
    try {
      await pollOnce()
    } catch {
      /* 한 주기 실패로 감시가 멈추면 안 된다 — 다음 주기에 재시도 */
    }
    if (runningRef.current) {
      timerRef.current = setTimeout(loop, Math.max(1, cfgRef.current?.intervalSec ?? 5) * 1000)
    }
  }

  /**
   * 노드가 죽은 순간 연속 카운트를 0으로 되돌린다.
   *
   * 안 그러면 죽기 전에 이미 쌓아 둔 성공이 그대로 이어져, DOWN 되자마자 "연속 10회 달성" 으로
   * 찍히고 복구 시각이 장애 이전으로 되짚어진다. 'N회 연속' 은 장애 이후부터 세어야 뜻이 있다.
   * 막대(recent)는 남겨 둔다 — 장애 전후를 눈으로 비교하는 게 이 그래프의 쓸모다.
   */
  useEffect(() => {
    if (downAt === null) return
    const reset: Record<string, TargetState> = {}
    for (const [id, st] of Object.entries(statesRef.current)) {
      reset[id] = { ...st, streak: 0, recoveredAt: null, everFailed: false }
    }
    statesRef.current = reset
    setStates(reset)
  }, [downAt])

  // 상태보드 검증 시작/중지에 맞춰 켜고 끈다
  useEffect(() => {
    if (running && cfg) {
      // 새 회차 — 이전 회차의 연속카운트/복구시각을 들고 가면 안 된다
      statesRef.current = {}
      setStates({})
      tokenRef.current = ''
      tokenAtRef.current = 0
      loginRef.current = null
      setTokenStat({ count: 0, lastAt: 0, gapMs: null })
      setAuthNote('')
      runningRef.current = true
      void loop()
    } else {
      runningRef.current = false
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = null
    }
    return () => {
      runningRef.current = false
      if (timerRef.current) clearTimeout(timerRef.current)
    }
    // cfg 는 '설정을 아직 못 읽었을 때' 만 의미가 있다 — 매 편집마다 회차를 리셋하지 않도록 id 만 본다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, !!cfg])

  // ── 단건 시험 (설정 화면에서 "이 경로가 맞나?" 를 바로 확인) ───
  const [testing, setTesting] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<
    Record<string, { ok: boolean; lines: string[]; detail?: string[]; suggest?: { path: string; count: number }[] }>
  >({})
  const testTarget = async (t: PortalTarget) => {
    const c = cfgRef.current
    if (!c) return
    setTesting(t.id)
    try {
      // 시험은 항상 새 토큰으로 — 설정을 고치고 눌렀는데 낡은 토큰으로 나가면
      // 방금 고친 값이 맞는지 알 수 없다.
      if (t.auth && c.auth.mode !== 'none') await refreshToken(c)
      const { r, j } = await probe(c, t)
      // 잘 되면 한 줄이면 충분하다. 진단에 필요한 것들(주소·토큰·응답 원문)은 접어 두고,
      // 막혔을 때만 펼쳐 보게 한다 — 성공했는데 화면 가득 코드가 쏟아지면 읽을 게 뭔지 알 수 없다.
      const lines: string[] = []
      if (r.ok) {
        lines.push(`HTTP ${r.status} · ${r.latencyMs}ms${r.upstreamMs !== undefined ? ` (백엔드 ${r.upstreamMs}ms)` : ''}`)
      } else {
        lines.push(`요청 실패 — ${r.error ?? '알 수 없음'}`)
      }
      if (j.reasons.length) lines.push(...j.reasons)
      else if (j.ok) lines.push(`정상 조건 ${(t.checks ?? []).length}개 모두 통과`)

      const detail: string[] = [`${t.method} ${urlOf(c, t.path)}`]
      // 401 이 났을 때 "토큰을 못 받은 것" 과 "받았는데 거부된 것" 은 고칠 곳이 다르다.
      if (t.auth && c.auth.mode !== 'none') {
        detail.push(
          tokenRef.current
            ? `토큰: 발급됨 (${tokenRef.current.length}자, 앞 12자 ${tokenRef.current.slice(0, 12)}…)`
            : '토큰: 발급 실패 — 로그인 경로·본문·토큰 위치를 먼저 고치세요',
        )
      }
      // 조건 경로가 안 맞아 실패했을 때, 이 응답에서 배열이 실제로 어디 있는지 짚어준다.
      // (포털마다 content · data · data.items 로 제각각이라 눈으로 찾게 두면 시간이 걸린다)
      const suggest =
        !j.ok && (t.checks ?? []).some((c) => c.op === 'nonEmptyArray') ? suggestArrayPaths(r.body) : []
      const body = (r.body ?? '').trim()
      if (body) detail.push('', '응답 앞부분:', body.slice(0, 400) + (body.length > 400 ? '…' : ''))
      setTestResult((m) => ({ ...m, [t.id]: { ok: j.ok, lines, detail, suggest: suggest.length ? suggest : undefined } }))
    } finally {
      setTesting(null)
    }
  }

  if (!cfg) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-panel-light/40 p-3 text-[12px] text-gray-400">
        <Loader2 size={14} className="animate-spin" /> 포털 감시 설정을 읽는 중…
      </div>
    )
  }

  const active = cfg.targets.filter((t) => t.enabled && (t.path ?? '').trim())
  const configured = !!cfg.baseUrl.trim() && active.length > 0
  // 접힌 줄에 담을 요약. 이 패널은 상태보드의 주인공(Host 전원 상태)을 밀어내면 안 되므로,
  // 평소엔 '점 + 몇/몇' 한 줄로 줄이고 봐야 할 때만 펼친다.
  const okCount = active.filter((t) => states[t.id]?.last?.ok).length
  const seen = active.filter((t) => states[t.id]?.last).length
  const bad = active.filter((t) => states[t.id]?.last && !states[t.id].last!.ok)
  // 문제가 있으면 그쪽만 보여준다. 정상일 때만 전체를 돌아가며 비춘다 —
  // 깨진 대상이 몇 초 뒤 다른 대상으로 넘어가 버리면 정작 봐야 할 걸 놓친다.
  const spotlightPool = bad.length > 0 ? bad : active
  const spot = spotlightPool[spotIdx % spotlightPool.length]
  const spotSt = spot ? states[spot.id] : undefined
  const recovered = active
    .map((t) => ({ name: t.name, at: states[t.id]?.recoveredAt ?? null }))
    .filter((x): x is { name: string; at: number } => x.at !== null)
    .sort((a, b) => b.at - a.at)[0]

  return (
    <div className="mb-3 rounded-lg border border-white/10 bg-panel-light/40">
      {/* 헤더 */}
      <div className="flex items-center gap-2 px-3 py-2">
        <button onClick={() => setOpen((v) => !v)} className="flex items-center gap-1.5 text-[13px] font-medium text-gray-100">
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          서비스 포털 응답
        </button>
        {!configured ? (
          <span className="text-[11px] text-amber-300/80">주소와 대상을 설정하면 검증 시작과 함께 감시합니다</span>
        ) : open || seen === 0 ? (
          <span className="text-[11px] text-gray-500">
            {active.length}개 대상 · {cfg.intervalSec}초 주기 · 연속 {cfg.successStreak}회 정상이면 복구
          </span>
        ) : (
          // 접힌 상태 — 점(전체) + 몇/몇 + 번갈아 비추는 대상 하나 + 토큰 갱신
          <span className="flex min-w-0 items-center gap-2 text-[11px]">
            <span className="flex items-center gap-1">
              {active.map((t) => (
                <span
                  key={t.id}
                  title={`${t.name} — ${states[t.id]?.last?.ok ? '정상' : '비정상'}`}
                  className={`h-2 w-2 rounded-full ${states[t.id]?.last?.ok ? 'bg-emerald-500' : 'bg-red-500'}`}
                />
              ))}
            </span>
            <span className={okCount === seen ? 'text-gray-400' : 'text-red-300'}>
              {okCount}/{active.length} 정상
            </span>
            {spot && spotSt?.last && (
              <span className={`truncate ${spotSt.last.ok ? 'text-gray-500' : 'text-red-300'}`}>
                · {spot.name} {spotSt.last.status ? `${spotSt.last.status}` : '응답없음'}
                {spotSt.last.latencyMs !== undefined && ` · ${spotSt.last.latencyMs}ms`}
              </span>
            )}
            {recovered && (
              <span className="truncate text-violet-300/90">
                · {recovered.name} {fmtClock(recovered.at)} 복구
              </span>
            )}
            {tokenStat.count > 0 && (
              <span
                className="shrink-0 text-gray-500"
                title={`마지막 갱신 ${fmtClock(tokenStat.lastAt)}`}
              >
                · 토큰 갱신 {tokenStat.count}회
                {tokenStat.gapMs ? ` (${Math.round(tokenStat.gapMs / 60000)}분 주기)` : ''}
              </span>
            )}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          {running && configured && <span className="flex items-center gap-1 text-[11px] text-blue-300"><Loader2 size={11} className="animate-spin" /> 감시 중</span>}
          <button
            onClick={() => setView((v) => (v === 'config' ? 'board' : 'config'))}
            className="flex items-center gap-1 rounded border border-white/10 px-2 py-1 text-[11px] text-gray-300 hover:bg-white/5"
          >
            <Settings size={11} /> {view === 'config' ? '상태 보기' : '설정'}
          </button>
        </div>
      </div>

      {open && (notice || authNote) && (
        <div className="mx-3 mb-2 rounded border border-white/10 bg-black/20 px-2 py-1.5 text-[11px] text-gray-400">
          {notice && <div className="text-amber-300/90">{notice}</div>}
          {authNote && (
            <div>
              인증: {authNote}
              {tokenStat.count > 0 && (
                <span className="text-gray-500">
                  {' '}
                  · 갱신 {tokenStat.count}회
                  {tokenStat.gapMs ? ` (${Math.round(tokenStat.gapMs / 60000)}분 주기)` : ''}
                </span>
              )}
            </div>
          )}
        </div>
      )}

      {open &&
        (view === 'config' ? (
          <ConfigView
            cfg={cfg}
            onChange={save}
            onTest={testTarget}
            testing={testing}
            testResult={testResult}
            onClearSuggest={(id) => setTestResult((m) => ({ ...m, [id]: { ...m[id], suggest: undefined } }))}
            onTestLogin={() => void testLogin()}
            loginTesting={loginTesting}
            loginTest={loginTest}
          />
        ) : (
          <BoardView cfg={cfg} states={states} t0={t0} running={running} />
        ))}
    </div>
  )
}

// ── 상태 보기 ───────────────────────────────────────────────────
function BoardView({
  cfg,
  states,
  t0,
  running,
}: {
  cfg: PortalConfig
  states: Record<string, TargetState>
  t0: number
  running: boolean
}) {
  const targets = cfg.targets.filter((t) => t.enabled && (t.path ?? '').trim())
  if (!targets.length) {
    return <div className="px-3 pb-3 text-[11px] text-gray-500">감시할 대상이 없습니다 — 설정에서 추가하세요.</div>
  }
  // 페이지(group) 별로 묶어 보여준다 — 사람이 "인스턴스 상세가 언제 열리나" 로 생각하기 때문
  const groups: { name: string; items: PortalTarget[] }[] = []
  for (const t of targets) {
    const g = t.group?.trim() || '기타'
    const found = groups.find((x) => x.name === g)
    if (found) found.items.push(t)
    else groups.push({ name: g, items: [t] })
  }

  return (
    <div className="space-y-2 px-3 pb-3">
      {groups.map((g) => (
        <div key={g.name} className="rounded border border-white/10 bg-black/20">
          <div className="border-b border-white/5 px-2.5 py-1.5 text-[11px] font-medium text-gray-300">{g.name}</div>
          <div className="divide-y divide-white/5">
            {g.items.map((t) => (
              <TargetRow key={t.id} t={t} cfg={cfg} st={states[t.id]} t0={t0} running={running} />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

/**
 * 한 줄에 그릴 막대 수 상한.
 *
 * 막대는 폭에 맞춰 늘어나되 하나당 6px 을 넘지 않는다. 그래서 이 값이 곧 '줄이 채워지는 폭'이다 —
 * 100개면 최대 700px 밖에 못 채워, 넓은 보드(1560px)에서는 막대 뒤가 통째로 비어
 * 줄이 중간에 끊긴 것처럼 보였다. 180개면 좁은 창에서도 5px, 넓은 창에서도 6px 로 가득 찬다.
 * 덤으로 보이는 이력도 늘어난다(1초 주기에서 최근 3분).
 */
const BAR_MAX = 180

/** 막대가 덮고 있는 시간 구간을 사람 말로 */
function spanLabel(recent: { at: number }[]): string {
  if (recent.length < 2) return `${recent.length}회`
  const sec = Math.round((recent[recent.length - 1].at - recent[0].at) / 1000)
  const span = sec < 60 ? `${sec}초` : `${Math.floor(sec / 60)}분 ${sec % 60}초`
  return `최근 ${span} (${recent.length}회)`
}

const PHASE_STYLE: Record<string, { cls: string; label: string }> = {
  ok: { cls: 'bg-emerald-500/20 text-emerald-300', label: '정상' },
  recovered: { cls: 'bg-emerald-500/20 text-emerald-300', label: '복구됨' },
  fail: { cls: 'bg-red-500/20 text-red-300', label: '비정상' },
  waiting: { cls: 'bg-gray-500/20 text-gray-300', label: '확인 중' },
}

function TargetRow({
  t,
  cfg,
  st,
  t0,
  running,
}: {
  t: PortalTarget
  cfg: PortalConfig
  st?: TargetState
  t0: number
  running: boolean
}) {
  const needed = streakNeeded(t, cfg)
  const state = st ?? emptyTargetState()
  const phase = phaseOf(state, needed)
  const style = PHASE_STYLE[phase]
  const last = state.last
  const bars = state.recent.slice(-BAR_MAX)

  return (
    <div className="px-2.5 py-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className={`rounded px-1.5 py-0.5 text-[10px] ${style.cls}`}>{style.label}</span>
        <span className="text-[12px] text-gray-200">{t.name}</span>
        {last && (
          <span className="text-[11px] text-gray-500">
            HTTP {last.status ?? '—'}
            {last.latencyMs !== undefined && ` · ${last.latencyMs}ms`}
            {last.upstreamMs !== undefined && ` (백엔드 ${last.upstreamMs}ms)`}
          </span>
        )}
        {/* 연속 카운트 — '왜 아직 복구가 아닌지' 가 여기서 바로 보인다 */}
        {phase === 'waiting' && last?.ok && (
          <span className="text-[11px] text-amber-300/90">
            연속 {state.streak}/{needed} — 기준을 채우면 복구로 확정
          </span>
        )}
        {state.recoveredAt !== null && (
          <span className="ml-auto text-[11px] text-emerald-300">
            {fmtClock(state.recoveredAt)}
            {t0 > 0 && <span className="text-gray-500"> (시작 +{fmtElapsed(state.recoveredAt - t0)})</span>}
          </span>
        )}
      </div>

      {/* 최근 관측 막대 — 페일오버 중의 깜빡임이 눈에 보이게.
          가로가 가득 차면 오래된 것부터 밀려난다. 그게 '끊긴 것'으로 보이지 않게
          어느 구간을 보고 있는지 옆에 적는다. */}
      {state.recent.length > 0 && (
        <div className="mt-1.5 flex items-center gap-2">
          {/* 막대는 고정 폭이 아니라 **남는 폭에 맞춰** 늘고 줄어든다.
              창 폭 전환(1120/1560px)이나 우측 패널이 열릴 때 줄이 넘치지 않게 하려는 것 —
              고정 픽셀로 두면 좁아진 순간 잘려 나간다. */}
          {/* 옅은 바탕 띠 — 막대가 폭을 다 못 채워도 줄이 우측 시각까지 이어져 보이게 한다 */}
          <div className="flex min-w-0 flex-1 items-end gap-[1px] overflow-hidden rounded-sm bg-white/[0.04] px-px py-px">
            {bars.map((r, i) => (
              <span
                key={i}
                title={`${fmtClock(r.at)} ${r.ok ? '정상' : '비정상'}`}
                className={`h-3 min-w-[2px] max-w-[6px] flex-1 rounded-sm ${r.ok ? 'bg-emerald-500/70' : 'bg-red-500/70'}`}
              />
            ))}
          </div>
          <span className="shrink-0 whitespace-nowrap text-[10px] text-gray-500">
            {spanLabel(bars)}
            {state.recent.length > BAR_MAX && ' · 이전은 밀려남'}
          </span>
        </div>
      )}

      {last && !last.ok && last.reasons.length > 0 && (
        <ul className="mt-1 space-y-0.5 text-[11px] text-red-300/90">
          {last.reasons.map((r, i) => (
            <li key={i}>· {r}</li>
          ))}
        </ul>
      )}
      {t.note && <p className="mt-1 text-[10.5px] text-gray-500">{t.note}</p>}
      {!running && !last && <p className="mt-1 text-[11px] text-gray-500">검증을 시작하면 감시합니다.</p>}
    </div>
  )
}

// ── 브라우저 요청 그대로 가져오기 ────────────────────────────────
function CurlImport({ cfg, onApply }: { cfg: PortalConfig; onApply: (p: Partial<PortalTarget>) => void }) {
  // 접어두면 못 찾고 경로 칸에 붙여넣게 된다(실제로 그랬다). 펼친 채로 시작한다.
  const [open, setOpen] = useState(true)
  const [text, setText] = useState('')
  const [msg, setMsg] = useState('')

  const apply = () => {
    const parsed = parseCurl(text)
    if (!parsed) {
      setMsg('cURL 명령을 읽지 못했습니다 — 개발자도구에서 복사한 내용을 그대로 붙여넣으세요.')
      return
    }
    const headers = headersFromCurl(parsed.headers)
    onApply({
      method: (parsed.method === 'POST' ? 'POST' : parsed.method === 'HEAD' ? 'HEAD' : 'GET') as PortalTarget['method'],
      path: pathFromUrl(cfg, parsed.url),
      headers: Object.keys(headers).length ? headers : undefined,
      body: parsed.body,
    })
    const dropped = Object.keys(parsed.headers).length - Object.keys(headers).length
    setMsg(
      `적용했습니다 — 헤더 ${Object.keys(headers).length}개 가져옴` +
        (dropped > 0 ? `, ${dropped}개 제외(토큰·쿠키 등은 감시할 때마다 새로 붙입니다)` : ''),
    )
    setText('')
  }

  return (
    <div className="rounded border border-blue-500/30 bg-blue-500/5 px-2 py-1.5">
      <button onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-1.5 text-left text-[11px] text-blue-200">
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        브라우저 요청 그대로 가져오기 (cURL 붙여넣기)
        <span className="text-[10px] text-gray-500">브라우저에선 되는데 여기선 400/403 이 날 때</span>
      </button>
      {open && (
        <div className="mt-1.5 space-y-1.5">
          <p className="text-[10.5px] leading-relaxed text-gray-400">
            개발자도구 <b>Network</b> 에서 그 요청을 <b>우클릭 → Copy → Copy as cURL</b> 한 뒤 아래에 붙여넣고
            적용하세요. 경로·방식·헤더를 브라우저가 보낸 그대로 가져옵니다. 토큰·쿠키와 도메인이 박힌
            헤더(Origin·Referer)는 빼고 가져오며, 감시할 때마다 지금 설정된 포털 주소로 새로 붙입니다 —
            그래야 다른 환경으로 옮겨도 그대로 씁니다.
          </p>
          <p className="rounded border border-white/10 bg-black/20 px-2 py-1 text-[10.5px] leading-relaxed text-gray-400">
            💡 <b className="text-gray-300">아래 '경로' 칸에 그대로 붙여넣어도 자동으로 인식합니다.</b> 이 상자를
            찾지 못했을 때를 위한 것이니 편한 쪽을 쓰세요.
          </p>
          <textarea
            className={`${inputCls} h-20 font-mono`}
            value={text}
            placeholder="curl 'https://...' -H 'accept: application/json' ..."
            onChange={(e) => setText(e.target.value)}
          />
          <div className="flex items-center gap-2">
            <button
              onClick={apply}
              disabled={!text.trim()}
              className="rounded border border-white/10 bg-blue-600/30 px-2 py-0.5 text-[11px] text-blue-100 hover:bg-blue-600/50 disabled:opacity-40"
            >
              적용
            </button>
            {msg && <span className="text-[10.5px] text-gray-400">{msg}</span>}
          </div>
        </div>
      )}
    </div>
  )
}

// ── 설정 ────────────────────────────────────────────────────────
const CHECK_OPS: { v: PortalCheck['op']; label: string; needsValue: boolean }[] = [
  { v: 'nonEmptyArray', label: '배열이 1개 이상', needsValue: false },
  { v: 'exists', label: '값이 있음', needsValue: false },
  { v: 'gte', label: '숫자가 ≥', needsValue: true },
  { v: 'contains', label: '문자열 포함', needsValue: true },
  { v: 'notContains', label: '문자열 없음', needsValue: true },
  { v: 'regex', label: '정규식 일치', needsValue: true },
]

const inputCls = 'w-full rounded border border-white/10 bg-black/30 px-2 py-1 text-[11px] text-gray-200 outline-none focus:border-blue-500/50'
const labelCls = 'text-[10.5px] text-gray-500'

function ConfigView({
  cfg,
  onChange,
  onTest,
  testing,
  testResult,
  onClearSuggest,
  onTestLogin,
  loginTesting,
  loginTest,
}: {
  cfg: PortalConfig
  onChange: (c: PortalConfig) => void
  onTest: (t: PortalTarget) => void
  testing: string | null
  testResult: Record<string, { ok: boolean; lines: string[]; detail?: string[]; suggest?: { path: string; count: number }[] }>
  /** 추천 경로를 눌러 반영한 뒤, 그 안내를 지운다 */
  onClearSuggest: (id: string) => void
  onTestLogin: () => void
  loginTesting: boolean
  loginTest: { ok: boolean; text: string } | null
}) {
  const [expanded, setExpanded] = useState<string | null>(null)
  /** 시험 결과의 '자세히' 를 펼친 대상 */
  const [detailOpen, setDetailOpen] = useState<string | null>(null)
  const set = (p: Partial<PortalConfig>) => onChange({ ...cfg, ...p })
  const setAuth = (p: Partial<PortalConfig['auth']>) => onChange({ ...cfg, auth: { ...cfg.auth, ...p } })
  const setTarget = (id: string, p: Partial<PortalTarget>) =>
    onChange({ ...cfg, targets: cfg.targets.map((t) => (t.id === id ? { ...t, ...p } : t)) })
  const addTarget = () => {
    const t: PortalTarget = {
      id: newTargetId(),
      name: '새 대상',
      group: '',
      enabled: true,
      method: 'GET',
      path: '',
      auth: true,
      expectStatus: [200],
      checks: [],
    }
    onChange({ ...cfg, targets: [...cfg.targets, t] })
    setExpanded(t.id)
  }
  const removeTarget = (id: string) => onChange({ ...cfg, targets: cfg.targets.filter((t) => t.id !== id) })

  return (
    <div className="space-y-3 px-3 pb-3">
      {/* 접속 */}
      <div className="rounded border border-white/10 bg-black/20 p-2.5">
        <div className="mb-2 text-[11px] font-medium text-gray-300">포털 주소</div>
        <div className="grid grid-cols-[1fr_auto] gap-2">
          <div>
            <div className={labelCls}>기본 주소 — 도메인이 바뀌면 여기만 고치면 됩니다</div>
            <input
              className={
                inputCls + (cfg.baseUrl.trim() ? '' : ' border-amber-500/60 bg-amber-500/5')
              }
              value={cfg.baseUrl}
              // 실제 쓸 법한 주소를 예시로 두면 '이미 입력된 값' 으로 착각한다(사용자가 실제로 그랬다).
              // 예시임이 한눈에 보이는 문구로 둔다.
              placeholder="여기에 포털 주소를 입력하세요 (예: https://포털주소)"
              onChange={(e) => set({ baseUrl: e.target.value })}
            />
            {!cfg.baseUrl.trim() && (
              <p className="mt-1 text-[10.5px] text-amber-300">
                주소가 비어 있습니다 — 위 칸의 회색 글씨는 예시일 뿐 입력된 값이 아닙니다. 주소를 넣어야 아래
                로그인 창·시험 버튼이 동작합니다.
              </p>
            )}
          </div>
          <label className="flex items-end gap-1.5 pb-1 text-[11px] text-gray-400">
            <input type="checkbox" checked={cfg.insecureTLS} onChange={(e) => set({ insecureTLS: e.target.checked })} />
            사내 인증서 검증 건너뛰기
          </label>
        </div>
      </div>

      {/* 인증 */}
      <div className="rounded border border-white/10 bg-black/20 p-2.5">
        <div className="mb-1.5 flex items-center gap-2">
          <span className="text-[11px] font-medium text-gray-300">인증</span>
          <select
            className="rounded border border-white/10 bg-black/30 px-1.5 py-0.5 text-[11px] text-gray-200"
            value={cfg.auth.mode}
            onChange={(e) => setAuth({ mode: e.target.value as PortalConfig['auth']['mode'] })}
          >
            <option value="login">아이디/비밀번호 로그인 (권장)</option>
            <option value="token">access token 직접 입력</option>
            <option value="none">인증 없음</option>
          </select>
        </div>
        {cfg.auth.mode === 'token' && (
          <>
            <div className={labelCls}>
              개발자도구에서 복사한 토큰. 만료되면 감시가 멈추므로, 로그인 API 경로를 아직 모를 때 잠깐
              확인하는 용도로만 쓰세요 — 긴 검증에는 위 <b className="text-gray-400">아이디/비밀번호 로그인</b> 을 쓰세요.
            </div>
            <input className={inputCls} value={cfg.auth.token ?? ''} onChange={(e) => setAuth({ token: e.target.value })} />
          </>
        )}
        {cfg.auth.mode === 'login' && (
          <div className="space-y-1.5">
            <p className="text-[10.5px] text-gray-500">
              401 이 오면 자동으로 다시 로그인해 한 번 더 시도합니다. 재로그인까지 실패하면 그대로 비정상으로
              기록합니다 — 인증 서비스가 안 떠 있는 것도 "아직 정상이 아니다" 의 일부이기 때문입니다.
            </p>
            {looksEncrypted(cfg.auth.password ?? '') && (
              <div className="rounded border border-sky-500/40 bg-sky-500/10 px-2 py-1.5 text-[10.5px] leading-relaxed text-sky-200">
                비밀번호 칸의 값이 <b>암호화된 문자열처럼</b> 보입니다 — 개발자도구 Payload 에서 그대로 옮기신
                것이라면 대개 <b>그대로 다시 보내도 통합니다</b>. 암호화 방식(AES-CBC)은 복호화에 필요한 값을
                암호문 안에 같이 담아 보내기 때문입니다. 아래 <b>'로그인 시험'</b> 으로 지금 확인하세요 — 되면
                토큰이 만료돼도 즉시 다시 받아오므로 감시가 끊기지 않습니다.
              </div>
            )}
            <div className="grid grid-cols-2 gap-2">
              <div>
                <div className={labelCls}>로그인 API 경로</div>
                <input className={inputCls} value={cfg.auth.loginPath ?? ''} onChange={(e) => setAuth({ loginPath: e.target.value })} />
              </div>
              <div>
                <div className={labelCls}>토큰 위치 (응답 JSON 경로)</div>
                <input className={inputCls} value={cfg.auth.tokenPath ?? ''} placeholder="accessToken 또는 data.token" onChange={(e) => setAuth({ tokenPath: e.target.value })} />
              </div>
              <div>
                <div className={labelCls}>계정</div>
                <input className={inputCls} value={cfg.auth.username ?? ''} onChange={(e) => setAuth({ username: e.target.value })} />
              </div>
              <div>
                <div className={labelCls}>비밀번호 (OS 키체인으로 암호화 저장)</div>
                <input type="password" className={inputCls} value={cfg.auth.password ?? ''} onChange={(e) => setAuth({ password: e.target.value })} />
              </div>
              <div className="col-span-2">
                <div className={labelCls}>로그인 요청 본문 — {'{{id}}'} / {'{{pw}}'} 가 위 값으로 치환됩니다</div>
                <input className={inputCls} value={cfg.auth.loginBody ?? ''} onChange={(e) => setAuth({ loginBody: e.target.value })} />
              </div>
              <div>
                <div className={labelCls}>토큰 헤더 이름</div>
                <input className={inputCls} value={cfg.auth.header ?? ''} onChange={(e) => setAuth({ header: e.target.value })} />
              </div>
              <div>
                <div className={labelCls}>헤더 형식</div>
                <input className={inputCls} value={cfg.auth.headerFormat ?? ''} placeholder="Bearer {token}" onChange={(e) => setAuth({ headerFormat: e.target.value })} />
              </div>
              <div className="col-span-2">
                <div className={labelCls}>쿠키 이름 (토큰을 쿠키로도 보내야 하면. 안 쓰면 비워두세요)</div>
                <input className={inputCls} value={cfg.auth.cookieName ?? ''} placeholder="accessToken" onChange={(e) => setAuth({ cookieName: e.target.value })} />
              </div>
            </div>

            {/* 이 설정이 실제로 토큰을 받아오는지가 '끊김 없는 감시' 의 전제다 — 대상 시험과 별개로 여기서 바로 확인한다 */}
            <div className="flex items-center gap-2">
              <button
                disabled={loginTesting}
                onClick={onTestLogin}
                className="flex items-center gap-1 rounded border border-white/10 px-2 py-0.5 text-[11px] text-gray-200 hover:bg-white/5 disabled:opacity-40"
              >
                <RefreshCw size={11} className={loginTesting ? 'animate-spin' : ''} /> 로그인 시험
              </button>
              <span className="text-[10px] text-gray-500">지금 이 설정으로 토큰을 받아올 수 있는지 확인합니다</span>
            </div>
            {loginTest && (
              <div
                className={`rounded border px-2 py-1.5 text-[10.5px] leading-relaxed ${
                  loginTest.ok ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200' : 'border-amber-500/40 bg-amber-500/10 text-amber-200'
                }`}
              >
                <b>로그인 시험</b> — {loginTest.text}
              </div>
            )}

            {/* ── 토큰 만료 대응 ── */}
            <div className="mt-1 rounded border border-white/10 bg-black/20 p-2">
              <div className="mb-1 text-[11px] font-medium text-gray-300">토큰 만료 대응</div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <div className={labelCls}>선제 재발급 주기 (분) — 0 이면 만료된 뒤에만 재발급</div>
                  <input
                    type="number"
                    min={0}
                    className={inputCls}
                    value={cfg.auth.reissueMinutes ?? 0}
                    onChange={(e) => setAuth({ reissueMinutes: Math.max(0, Number(e.target.value) || 0) })}
                  />
                </div>
                <div>
                  <div className={labelCls}>만료를 뜻하는 응답 문구 (HTTP 200 으로 오는 경우 대비)</div>
                  <input
                    className={inputCls}
                    value={cfg.auth.expiredBodyMatch ?? ''}
                    placeholder="TOKEN_NOT_VERIFY"
                    onChange={(e) => setAuth({ expiredBodyMatch: e.target.value })}
                  />
                </div>
              </div>
              <p className="mt-1 text-[10.5px] text-gray-500">
                401 이 오면 이 설정과 무관하게 항상 자동 재발급합니다. 위 두 칸은 그것만으로 부족할 때 씁니다 —
                <b className="text-gray-400"> 주기</b>는 만료 순간 한 주기가 비정상으로 찍혀 연속 카운트가 초기화되는 걸 막고(토큰
                수명이 10분이면 8 정도), <b className="text-gray-400">응답 문구</b>는 토큰이 죽었는데도 HTTP 200 에 에러
                봉투만 담아 주는 포털에서 만료를 잡아냅니다.
              </p>
            </div>
          </div>
        )}
      </div>

      {/* 판정 기준 */}
      <div className="rounded border border-white/10 bg-black/20 p-2.5">
        <div className="mb-1.5 text-[11px] font-medium text-gray-300">판정 기준</div>
        <div className="grid grid-cols-3 gap-2">
          <div>
            <div className={labelCls}>확인 주기 (초)</div>
            <input
              type="number"
              min={1}
              className={inputCls}
              value={cfg.intervalSec}
              onChange={(e) => set({ intervalSec: Math.max(1, Number(e.target.value) || 1) })}
            />
          </div>
          <div>
            <div className={labelCls}>응답 제한 시간 (ms)</div>
            <input
              type="number"
              min={1000}
              step={500}
              className={inputCls}
              value={cfg.timeoutMs}
              onChange={(e) => set({ timeoutMs: Math.max(1000, Number(e.target.value) || 1000) })}
            />
          </div>
          <div>
            <div className={labelCls}>연속 성공 횟수</div>
            <input
              type="number"
              min={1}
              className={inputCls}
              value={cfg.successStreak}
              onChange={(e) => set({ successStreak: Math.max(1, Number(e.target.value) || 1) })}
            />
          </div>
        </div>
        <p className="mt-1.5 text-[10.5px] text-gray-500">
          페일오버 중에는 레플리카 한 대만 살아나 200 이 한 번 튀었다가 다시 503 이 되는 일이 흔합니다. 그 첫 200 을
          복구 시각으로 적으면 실제보다 이릅니다. 복구 시각은 <b className="text-gray-400">연속 구간의 첫 성공 시각</b>으로
          기록되므로, 이 값을 올려도 시각이 뒤로 밀리지 않습니다.
        </p>
      </div>

      {/* 대상 */}
      <div className="rounded border border-white/10 bg-black/20 p-2.5">
        <div className="mb-1.5 flex items-center gap-2">
          <span className="text-[11px] font-medium text-gray-300">감시 대상</span>
          <span className="text-[10.5px] text-gray-500">
            브라우저 개발자도구 → Network 에서 그 페이지가 부르는 요청의 경로를 그대로 넣으세요
          </span>
          <button onClick={addTarget} className="ml-auto flex items-center gap-1 rounded border border-white/10 px-2 py-0.5 text-[11px] text-gray-300 hover:bg-white/5">
            <Plus size={11} /> 대상 추가
          </button>
        </div>
        <div className="space-y-1.5">
          {cfg.targets.map((t) => {
            const isOpen = expanded === t.id
            const res = testResult[t.id]
            return (
              <div key={t.id} className="rounded border border-white/10 bg-black/20">
                <div className="flex items-center gap-2 px-2 py-1.5">
                  <input type="checkbox" checked={t.enabled} onChange={(e) => setTarget(t.id, { enabled: e.target.checked })} title="감시 켜기/끄기" />
                  <button onClick={() => setExpanded(isOpen ? null : t.id)} className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
                    {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    <span className="text-[11.5px] text-gray-200">{t.name || '(이름 없음)'}</span>
                    <span className="truncate text-[10.5px] text-gray-500">
                      {t.method} {t.path || '경로 미입력'}
                    </span>
                  </button>
                  <button
                    onClick={() => onTest(t)}
                    disabled={testing === t.id || !t.path.trim()}
                    className="flex items-center gap-1 rounded border border-white/10 px-1.5 py-0.5 text-[10.5px] text-gray-300 hover:bg-white/5 disabled:opacity-40"
                  >
                    {testing === t.id ? <Loader2 size={10} className="animate-spin" /> : <RefreshCw size={10} />} 시험
                  </button>
                  <button onClick={() => removeTarget(t.id)} className="rounded p-1 text-gray-500 hover:bg-white/5 hover:text-red-300" title="삭제">
                    <Trash2 size={11} />
                  </button>
                </div>

                {res && (
                  <div className={`mx-2 mb-2 rounded border px-2 py-1.5 text-[10.5px] ${res.ok ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200' : 'border-red-500/30 bg-red-500/10 text-red-200'}`}>
                    <div className="mb-0.5 flex items-center gap-1 font-medium">
                      {res.ok ? <Check size={11} /> : <AlertTriangle size={11} />}
                      {res.ok ? '정상으로 판정됩니다' : '비정상으로 판정됩니다'}
                    </div>
                    {/* 경로를 손으로 고쳐 쓰라고 하면 어디를 고치라는 건지 헷갈린다 — 눌러서 바로 반영한다 */}
                    {res.suggest && (
                      <div className="mb-1.5 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-amber-100">
                        <div className="mb-1">
                          이 응답에서 <b>배열</b>이 있는 곳입니다. 눌러서 아래 <b>정상 조건</b>의 경로를 바꾸세요.
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          {res.suggest.map((s) => (
                            <button
                              key={s.path}
                              onClick={() => {
                                const checks = [...(t.checks ?? [])]
                                const i = checks.findIndex((c) => c.op === 'nonEmptyArray')
                                const path = s.path === '(본문 전체)' ? '' : s.path
                                if (i >= 0) checks[i] = { ...checks[i], path }
                                else checks.push({ path, op: 'nonEmptyArray' })
                                setTarget(t.id, { checks })
                                onClearSuggest(t.id)
                              }}
                              className="rounded border border-amber-400/50 bg-amber-500/20 px-2 py-0.5 font-mono text-[10.5px] text-amber-50 hover:bg-amber-500/40"
                            >
                              {s.path} ({s.count}개)
                            </button>
                          ))}
                        </div>
                        <div className="mt-1 text-[10px] text-amber-200/80">
                          바꾼 뒤 <b>⟳ 시험</b>을 다시 누르면 통과 여부를 확인할 수 있습니다.
                        </div>
                      </div>
                    )}
                    {res.lines.map((line, i) => (
                      <div key={i} className="break-all opacity-90">
                        {line}
                      </div>
                    ))}
                    {/* 주소·토큰·응답 원문은 막혔을 때만 필요하다 — 평소엔 접어 둔다 */}
                    {res.detail && res.detail.length > 0 && (
                      <>
                        <button
                          onClick={() => setDetailOpen(detailOpen === t.id ? null : t.id)}
                          className="mt-1 text-[10px] underline decoration-dotted underline-offset-2 opacity-70 hover:opacity-100"
                        >
                          {detailOpen === t.id ? '자세히 접기' : '자세히 (주소 · 토큰 · 응답 원문)'}
                        </button>
                        {detailOpen === t.id && (
                          <pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap break-all rounded bg-black/30 p-1.5 font-mono text-[10px] opacity-90">
                            {res.detail.join('\n')}
                          </pre>
                        )}
                      </>
                    )}
                  </div>
                )}

                {isOpen && (
                  <div className="space-y-2 border-t border-white/5 px-2 py-2">
                    <CurlImport cfg={cfg} onApply={(p) => setTarget(t.id, p)} />
                    <div className="grid grid-cols-3 gap-2">
                      <div>
                        <div className={labelCls}>이름</div>
                        <input className={inputCls} value={t.name} onChange={(e) => setTarget(t.id, { name: e.target.value })} />
                      </div>
                      <div>
                        <div className={labelCls}>페이지 묶음 (같은 이름끼리 모아 표시)</div>
                        <input className={inputCls} value={t.group ?? ''} placeholder="인스턴스 상세" onChange={(e) => setTarget(t.id, { group: e.target.value })} />
                      </div>
                      <div>
                        <div className={labelCls}>연속 성공 (비우면 전체 설정값)</div>
                        <input
                          type="number"
                          min={1}
                          className={inputCls}
                          value={t.successStreak ?? ''}
                          placeholder={String(cfg.successStreak)}
                          onChange={(e) => setTarget(t.id, { successStreak: e.target.value ? Math.max(1, Number(e.target.value)) : undefined })}
                        />
                      </div>
                    </div>
                    <div className="grid grid-cols-[auto_1fr_auto] gap-2">
                      <div>
                        <div className={labelCls}>방식</div>
                        <select
                          className="rounded border border-white/10 bg-black/30 px-1.5 py-1 text-[11px] text-gray-200"
                          value={t.method}
                          onChange={(e) => setTarget(t.id, { method: e.target.value as PortalTarget['method'] })}
                        >
                          <option>GET</option>
                          <option>POST</option>
                          <option>HEAD</option>
                        </select>
                      </div>
                      <div>
                        <div className={labelCls}>
                          <b className="text-amber-300/90">API</b> 경로 — 화면 주소가 아니라 그 화면이 부르는 요청
                          (개발자도구 Network → Fetch/XHR) · <span className="text-blue-300/90">cURL 을 붙여넣어도 알아서 읽습니다</span>
                        </div>
                        <input
                          className={inputCls}
                          value={t.path}
                          placeholder="예: /v1/contrabass/admin/compute/servers?size=2000&page=0"
                          onChange={(e) => {
                            // cURL 을 여기 붙여넣는 일이 잦다(전용 상자가 접혀 있어 눈에 안 띈다).
                            // 틀렸다고 막는 대신 그대로 알아듣는다.
                            const parsed = parseCurl(e.target.value)
                            if (parsed) {
                              const headers = headersFromCurl(parsed.headers)
                              setTarget(t.id, {
                                method: (parsed.method === 'POST' ? 'POST' : parsed.method === 'HEAD' ? 'HEAD' : 'GET') as PortalTarget['method'],
                                path: pathFromUrl(cfg, parsed.url),
                                headers: Object.keys(headers).length ? headers : undefined,
                                body: parsed.body,
                              })
                              return
                            }
                            setTarget(t.id, { path: e.target.value })
                          }}
                        />
                        {/^\/?(?!v\d|api\b)[a-z-]+\/[a-z-]+/i.test(t.path.trim()) && !/\?|\/v\d|\/api\b/i.test(t.path) && (
                          <p className="mt-0.5 text-[10.5px] text-amber-300/90">
                            화면 주소처럼 보입니다. 그 화면을 열었을 때 Network 에 찍히는 요청 경로를 넣어야 합니다 —
                            페이지 주소는 백엔드가 죽어도 200 이 옵니다.
                          </p>
                        )}
                      </div>
                      <label className="flex items-end gap-1 pb-1 text-[10.5px] text-gray-400">
                        <input type="checkbox" checked={t.auth} onChange={(e) => setTarget(t.id, { auth: e.target.checked })} />
                        토큰 첨부
                      </label>
                    </div>
                    {t.method === 'POST' && (
                      <div>
                        <div className={labelCls}>요청 본문 (JSON)</div>
                        <textarea className={`${inputCls} h-14 font-mono`} value={t.body ?? ''} onChange={(e) => setTarget(t.id, { body: e.target.value })} />
                      </div>
                    )}
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <div className={labelCls}>정상 HTTP 상태 (쉼표)</div>
                        <input
                          className={inputCls}
                          value={(t.expectStatus ?? [200]).join(', ')}
                          onChange={(e) =>
                            setTarget(t.id, {
                              expectStatus: e.target.value
                                .split(',')
                                .map((x) => parseInt(x.trim(), 10))
                                .filter((n) => !Number.isNaN(n)),
                            })
                          }
                        />
                      </div>
                      <div>
                        <div className={labelCls}>메모 (기대 지연 등)</div>
                        <input className={inputCls} value={t.note ?? ''} onChange={(e) => setTarget(t.id, { note: e.target.value })} />
                      </div>
                    </div>

                    {/* 추가 헤더 — cURL 로 가져온 것도 여기 쌓인다. 뭘 보내는지 보여야 원인을 짚을 수 있다 */}
                    <div>
                      <div className="mb-1 flex items-center gap-2">
                        <span className={labelCls}>추가 헤더</span>
                        <button
                          onClick={() => setTarget(t.id, { headers: { ...(t.headers ?? {}), '': '' } })}
                          className="ml-auto flex items-center gap-1 rounded border border-white/10 px-1.5 py-0.5 text-[10.5px] text-gray-300 hover:bg-white/5"
                        >
                          <Plus size={10} /> 헤더
                        </button>
                      </div>
                      <div className="space-y-1">
                        {Object.entries(t.headers ?? {}).map(([k, v], i) => (
                          <div key={i} className="flex items-center gap-1.5">
                            <input
                              className={`${inputCls} w-48`}
                              value={k}
                              placeholder="헤더 이름"
                              onChange={(e) => {
                                const next: Record<string, string> = {}
                                for (const [kk, vv] of Object.entries(t.headers ?? {})) next[kk === k ? e.target.value : kk] = vv
                                setTarget(t.id, { headers: next })
                              }}
                            />
                            <input
                              className={`${inputCls} flex-1`}
                              value={v}
                              placeholder="값"
                              onChange={(e) => setTarget(t.id, { headers: { ...(t.headers ?? {}), [k]: e.target.value } })}
                            />
                            <button
                              onClick={() => {
                                const next = { ...(t.headers ?? {}) }
                                delete next[k]
                                setTarget(t.id, { headers: Object.keys(next).length ? next : undefined })
                              }}
                              className="rounded p-1 text-gray-500 hover:bg-white/5 hover:text-red-300"
                            >
                              <X size={11} />
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* 정상 조건 */}
                    <div>
                      <div className="mb-1 flex items-center gap-2">
                        <span className={labelCls}>정상 조건 — 전부 통과해야 정상. 비우면 상태 코드만 봅니다</span>
                        <button
                          onClick={() => setTarget(t.id, { checks: [...(t.checks ?? []), { path: '', op: 'nonEmptyArray' }] })}
                          className="ml-auto flex items-center gap-1 rounded border border-white/10 px-1.5 py-0.5 text-[10.5px] text-gray-300 hover:bg-white/5"
                        >
                          <Plus size={10} /> 조건
                        </button>
                      </div>
                      {(t.checks ?? []).length === 0 && (
                        <p className="text-[10.5px] text-amber-300/80">
                          조건이 없으면 200 만 보고 정상으로 칩니다. 목록 API 라면{' '}
                          <span className="text-gray-300">content · 배열이 1개 이상</span> 을 넣으세요 — 200 인데 빈 배열이
                          오는 구간이 반드시 있습니다.
                        </p>
                      )}
                      <div className="space-y-1">
                        {(t.checks ?? []).map((c, i) => {
                          const op = CHECK_OPS.find((o) => o.v === c.op)
                          const upd = (p: Partial<PortalCheck>) =>
                            setTarget(t.id, { checks: (t.checks ?? []).map((x, j) => (i === j ? { ...x, ...p } : x)) })
                          return (
                            <div key={i} className="flex items-center gap-1.5">
                              <input
                                className={`${inputCls} flex-1`}
                                value={c.path}
                                placeholder="JSON 경로 (비우면 본문 전체) 예: content"
                                onChange={(e) => upd({ path: e.target.value })}
                              />
                              <select
                                className="rounded border border-white/10 bg-black/30 px-1.5 py-1 text-[11px] text-gray-200"
                                value={c.op}
                                onChange={(e) => upd({ op: e.target.value as PortalCheck['op'] })}
                              >
                                {CHECK_OPS.map((o) => (
                                  <option key={o.v} value={o.v}>
                                    {o.label}
                                  </option>
                                ))}
                              </select>
                              {op?.needsValue && (
                                <input className={`${inputCls} w-32`} value={c.value ?? ''} placeholder="값" onChange={(e) => upd({ value: e.target.value })} />
                              )}
                              <button
                                onClick={() => setTarget(t.id, { checks: (t.checks ?? []).filter((_, j) => j !== i) })}
                                className="rounded p-1 text-gray-500 hover:bg-white/5 hover:text-red-300"
                              >
                                <X size={11} />
                              </button>
                            </div>
                          )
                        })}
                      </div>
                      {(t.checks ?? []).length > 0 && (
                        <p className="mt-1 text-[10.5px] text-gray-500">
                          판정: {(t.checks ?? []).map(describeCheck).join(' · 그리고 ')}
                        </p>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
