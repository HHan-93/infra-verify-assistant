import { useEffect, useRef, useState } from 'react'
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronUp,
  ClipboardPaste,
  ShieldCheck,
  HelpCircle,
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
  cookieHeaderFrom,
  fillTemplate,
  suggestStringPaths,
  parseBody,
  parseCurl,
  pathFromUrl,
  suggestArrayPaths,
  suggestValueChecks,
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
   * 인증 설정을 고치면 시험 결과를 버린다.
   *
   * 결과를 남겨 두면 계정이나 경로를 바꾼 뒤에도 '인증 준비됨' 초록 줄이 그대로 떠 있어서,
   * **지금 설정으로 되는지 확인하지 않은 것을 확인한 것처럼** 보이게 된다. 이 앱에서 초록은
   * 근거가 있을 때만 띄운다.
   */
  const authSig = JSON.stringify(cfg?.auth ?? null)
  useEffect(() => {
    setLoginTest(null)
  }, [authSig])
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
   * 접힘/펼침 — **여는 것은 사람만 한다.**
   *
   * 대상이 5개면 펼친 패널이 화면 절반을 먹어 주인공인 'Host — 전원 상태' 가 아래로 밀린다.
   * 그래서 평소엔 접힌 한 줄로 둔다.
   *
   * 비정상이 생기면 자동으로 펼치게 해봤는데 **그게 더 나빴다.** 롤링 검증 중에는 대상이
   * 깨졌다 붙었다를 반복하고, 그때마다 패널이 열리고 접히며 화면 전체가 위아래로 움직인다.
   * 지켜보는 사람에게는 그게 장애 정보보다 훨씬 방해가 된다.
   * 대신 접힌 한 줄을 **빨갛게 물들이고 '펼쳐서 확인' 을 붙인다** — 알림은 눈에 띄게,
   * 화면은 가만히.
   */
  const [open, setOpen] = useState(false)

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

  /**
   * 응답에서 값을 못 찾았을 때 **어디에 무엇이 있는지 짚어 준다.**
   *
   * "찾지 못했습니다" 로 끝내면 개발자도구를 다시 열어 응답을 뒤져야 한다. 후보 경로를
   * 그 자리에 적어 주면 대개 그중 하나를 그대로 복사해 넣으면 끝난다.
   */
  const pathHint = (body: string | undefined): string => {
    const cands = suggestStringPaths(body)
    if (cands.length) return `응답에 있는 값: ${cands.map((x) => `${x.path} = ${x.value}`).join(' · ')}`
    const peek = (body ?? '').trim().slice(0, 200)
    return peek ? `받은 응답: ${peek}` : '응답이 비어 있습니다.'
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

    let r = await window.electronAPI.portalRequest({
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

    /**
     * ── 2차 인증 ──────────────────────────────────────────
     *
     * 로그인 뒤 인증번호를 다시 묻는 포털이 있다. 그런 곳의 1단계 응답에는 **아직 진짜
     * 토큰이 없다** — 중간 토큰이나 세션 쿠키만 있고, 인증번호를 확인해야 토큰을 준다.
     * 그래서 여기서 한 번 더 보내고, 그 응답을 아래 토큰 추출로 넘긴다.
     *
     * 둘 다 물려준다 — 중간 토큰을 본문으로 받는 포털도 있고 쿠키로만 잇는 포털도 있어서,
     * 어느 쪽인지 사람이 알아내게 하기보다 둘 다 실어 보내는 편이 실패가 적다.
     *
     * 1단계가 400/401 이면 여기까지 오지 않는다(아래 상태 검사가 먼저 걸린다).
     */
    if (a.mfaPath?.trim()) {
      if ((r.status ?? 0) >= 400) {
        setAuthNote(`로그인 HTTP ${r.status} — 2차 인증까지 가지 못했습니다 (계정·비밀번호를 확인하세요)`)
        return ''
      }
      const mfaToken = String(jsonAt(parseBody(r.body), a.mfaTokenPath ?? '') ?? '')
      if (a.mfaTokenPath?.trim() && !mfaToken) {
        setAuthNote(
          `1단계 응답에서 중간 값을 찾지 못했습니다 (적어 둔 위치: ${a.mfaTokenPath}). ` + pathHint(r.body),
        )
        return ''
      }
      const cookie = cookieHeaderFrom(r.setCookies)
      r = await window.electronAPI.portalRequest({
        url: urlOf(c, a.mfaPath),
        method: 'POST',
        headers: { ...headers, ...(cookie ? { Cookie: cookie } : {}) },
        body: fillTemplate(a.mfaBody ?? '', {
          id: a.username ?? '',
          otp: a.otp ?? '',
          mfaToken,
        }),
        timeoutMs: c.timeoutMs,
        insecure: c.insecureTLS,
      })
      if (!r.ok) {
        setAuthNote(`2차 인증 요청 실패 — ${r.error ?? '알 수 없음'}`)
        return ''
      }
      if ((r.status ?? 0) >= 400) {
        setAuthNote(
          `2차 인증 HTTP ${r.status} — 인증번호나 요청 본문을 확인하세요 (받은 응답: ${(r.body ?? '')
            .trim()
            .slice(0, 200)})`,
        )
        return ''
      }
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
      setAuthNote(
        `${a.mfaPath?.trim() ? '2차 인증' : '로그인'} 응답에서 토큰을 찾지 못했습니다 ` +
          `(적어 둔 위치: ${c.auth.tokenPath || '(비어 있음)'}). ` +
          pathHint(r.body),
      )
      return ''
    }
    setAuthNote(`${label}${a.mfaPath?.trim() ? '·2차 인증' : ''} 성공 — 토큰 갱신 ${fmtClock(Date.now())}`)
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
    Record<
      string,
      {
        ok: boolean
        at: number
        lines: string[]
        detail?: string[]
        /** 배열이 있는 자리 (항목 1개 이상 조건용) */
        suggest?: { path: string; count: number }[]
        /** 상태 문구가 있는 자리 (목록이 원래 비어 있을 수 있는 응답용) */
        suggestValues?: { path: string; value: string }[]
      }
    >
  >({})
  /**
   * 대상 설정이 바뀌면 그 대상의 시험 결과를 버린다.
   *
   * 추천 경로 버튼을 눌러 조건을 넣은 직후에도 위에는 **바꾸기 전에 받은** `정상으로 판정됩니다 /
   * 정상 조건 0개 모두 통과` 가 그대로 떠 있었다. 지금 설정으로 확인한 적이 없는데 확인한 것처럼
   * 보인다 — 인증 시험과 같은 규칙이다. 초록은 근거가 있을 때만 띄운다.
   */
  const targetSigsRef = useRef<Record<string, string>>({})
  useEffect(() => {
    const next: Record<string, string> = {}
    const changed: string[] = []
    for (const t of cfg?.targets ?? []) {
      const sig = targetSig(t)
      next[t.id] = sig
      if (targetSigsRef.current[t.id] !== undefined && targetSigsRef.current[t.id] !== sig) changed.push(t.id)
    }
    targetSigsRef.current = next
    if (changed.length)
      setTestResult((m) => {
        const n = { ...m }
        for (const id of changed) delete n[id]
        return n
      })
  }, [cfg])

  const testTarget = async (t: PortalTarget) => {
    const c = cfgRef.current
    if (!c) return
    // 시험이 도는 동안 사용자가 그 대상을 고칠 수 있다. 그때 돌아온 결과는 **다른 설정의 결과**이므로
    // 화면에 올리지 않는다 — 올리면 고친 뒤인데 고치기 전 판정이 초록으로 떠 있게 된다.
    const sigAtStart = targetSig(t)
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
      /**
       * 배열 후보를 언제 제안할까.
       *  · 조건이 있는데 실패했다 → 경로를 잘못 잡았을 가능성이 크다(원래 목적)
       *  · **조건이 아예 없다** → 시험은 200 만 보고 '정상' 이라 답하지만 그건 감시가 아니다.
       *    이때야말로 "이 응답에는 여기 목록이 있다" 를 보여줘야 조건을 만들 수 있다.
       */
      const wantSuggest = (t.checks ?? []).length === 0 || (!j.ok && (t.checks ?? []).some((c) => c.op === 'nonEmptyArray'))
      // 비어 있는 배열은 후보가 아니다. `data (0개)` 를 눌러도 `항목 1개 이상` 은 그대로 실패한다 —
      // 고치라고 내민 것이 고쳐지지 않는 값이면 사람을 헤매게 만든다.
      const suggest = wantSuggest ? suggestArrayPaths(r.body).filter((a) => a.count > 0) : []
      // 쓸 만한 목록이 하나도 없으면 '이 응답은 원래 0건일 수 있다' 는 쪽을 의심해야 한다.
      // 그때 필요한 것은 다른 경로가 아니라 **다른 조건**이다.
      const suggestValues = wantSuggest && suggest.length === 0 ? suggestValueChecks(r.body) : []
      const body = (r.body ?? '').trim()
      if (body) detail.push('', '응답 앞부분:', body.slice(0, 400) + (body.length > 400 ? '…' : ''))
      const now = cfgRef.current?.targets.find((x) => x.id === t.id)
      if (!now || targetSig(now) !== sigAtStart) return // 시험 중에 설정이 바뀌었다
      setTestResult((m) => ({
        ...m,
        [t.id]: {
          ok: j.ok,
          at: Date.now(),
          lines,
          detail,
          suggest: suggest.length ? suggest : undefined,
          suggestValues: suggestValues.length ? suggestValues : undefined,
        },
      }))
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
  /** 접혀 있는데 비정상이 있는 상태 — 패널을 여는 대신 이걸로 알린다 */
  const alert = bad.length > 0 && !open
  const spotSt = spot ? states[spot.id] : undefined
  const recovered = active
    .map((t) => ({ name: t.name, at: states[t.id]?.recoveredAt ?? null }))
    .filter((x): x is { name: string; at: number } => x.at !== null)
    .sort((a, b) => b.at - a.at)[0]

  return (
    <div
      className={
        'mb-3 rounded-lg border ' +
        // 접혀 있어도 비정상은 한눈에 보여야 한다 — 패널을 여는 대신 테두리·배경으로 알린다.
        (alert ? 'border-red-500/50 bg-red-500/[0.07]' : 'border-white/10 bg-panel-light/40')
      }
    >
      {/* 헤더 */}
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          onClick={() => setOpen((v) => !v)}
          className={'flex items-center gap-1.5 text-[13px] font-medium ' + (alert ? 'text-red-200' : 'text-gray-100')}
        >
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
            {/* 자동으로 펼치지 않는 대신 '여기를 누르면 된다' 를 명시한다 — 화면은 사람이 누를 때만 움직인다 */}
            {bad.length > 0 && (
              <button
                onClick={() => setOpen(true)}
                title={bad.map((t) => t.name).join(' · ')}
                className="flex shrink-0 items-center gap-1 rounded bg-red-500/25 px-1.5 py-0.5 font-medium text-red-200 hover:bg-red-500/40"
              >
                <AlertTriangle size={10} /> {bad.length}개 비정상 — 펼쳐서 확인
              </button>
            )}
            {spot && spotSt?.last && (
              <span className={`truncate ${spotSt.last.ok ? 'text-gray-500' : 'text-red-300'}`}>
                · {spot.name} {spotSt.last.status ? `${spotSt.last.status}` : '응답없음'}
                {spotSt.last.latencyMs !== undefined && ` · ${spotSt.last.latencyMs}ms`}
              </span>
            )}
            {/* 장애가 진행 중인데 지난 복구 시각을 같이 띄우면 지금 상태를 헷갈리게 한다 — 깨진 게 있으면 감춘다 */}
            {recovered && bad.length === 0 && (
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

/** 띠가 덮고 있는 시간 구간 — 줄 끝 라벨은 폭이 고정이라 짧게 적고, 긴 설명은 툴팁으로 준다 */
function spanLabel(recent: { at: number }[]): string {
  if (recent.length < 2) return `${recent.length}회`
  const sec = Math.round((recent[recent.length - 1].at - recent[0].at) / 1000)
  const span = sec < 60 ? `${sec}초` : `${Math.floor(sec / 60)}분 ${sec % 60}초`
  return `${span} · ${recent.length}회`
}

/**
 * 관측을 **같은 상태끼리 하나의 구간으로 합친다.**
 *
 * 예전에는 관측 한 건마다 작은 칸을 하나씩 그렸다(최대 180칸). 정상일 때 그 180칸이 말해 주는
 * 것은 "다 정상" 하나뿐인데 화면 폭을 전부 쓰고, 대상이 다섯이면 그 격자가 다섯 줄이 된다.
 * 촘촘한 격자가 불편하다는 이야기도 있었다(사람에 따라 실제로 그렇다).
 *
 * 합치면 정상 구간은 띠 하나가 되고 **깨진 구간만 자국으로 남는다** — 129칸 중 빨간 칸을
 * 찾는 것보다 그쪽이 눈에 먼저 들어온다. 페일오버 중 200 이 한 번 튀었다 다시 503 이 되는
 * 것도 빨강-초록-빨강 세 덩어리로 그대로 보인다(이 그래프의 존재 이유다).
 *
 * 폭은 '관측 수' 가 아니라 **그 구간이 덮은 시간**에 비례시킨다 — 알고 싶은 것은
 * "몇 회 실패했나" 보다 "몇 초 동안 깨져 있었나" 다.
 */
interface ObsRun {
  ok: boolean
  from: number
  to: number
  count: number
  /** 이 구간이 덮은 시간(ms). 마지막 구간은 관측 하나뿐일 수 있어 최소 폭을 보장한다 */
  ms: number
}
function mergeRuns(recent: { at: number; ok: boolean }[], intervalSec: number): ObsRun[] {
  const step = Math.max(1, intervalSec) * 1000
  const runs: ObsRun[] = []
  for (const r of recent) {
    const last = runs[runs.length - 1]
    if (last && last.ok === r.ok) {
      last.to = r.at
      last.count++
      last.ms += step
    } else {
      runs.push({ ok: r.ok, from: r.at, to: r.at, count: 1, ms: step })
    }
  }
  return runs
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
  const runs = mergeRuns(state.recent, cfg.intervalSec)
  const failCount = state.recent.filter((r) => !r.ok).length
  const lastFailAt = [...state.recent].reverse().find((r) => !r.ok)?.at ?? null

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

      {/* 최근 관측 — 같은 상태끼리 합친 띠. 페일오버 중의 깜빡임은 그대로 자국으로 남는다 */}
      {state.recent.length > 0 && (
        <div className="mt-1.5 flex items-center gap-2">
          {/* 띠는 고정 폭이 아니라 **남는 폭에 맞춰** 늘고 줄어든다. 창 폭 전환(1120/1560px)이나
              우측 패널이 열릴 때 줄이 넘치지 않게 하려는 것 — 고정 픽셀로 두면 좁아진 순간 잘린다.

              높이는 **모든 줄이 같다.** 한때 '깨진 적 없는 줄은 얇게' 로 두었는데, 줄마다 굵기가
              다른 것이 의도된 신호가 아니라 **그리다 만 것처럼** 보였다. 상태는 색과 눈금으로
              말하고, 굵기는 말하지 않는다. */}
          <div className="flex h-2.5 min-w-0 flex-1 overflow-hidden rounded-full bg-white/[0.06]">
            {runs.map((r, i) => (
              <div
                key={i}
                style={{ flexGrow: r.ms, flexBasis: 0 }}
                title={`${fmtClock(r.from)}${r.count > 1 ? ` ~ ${fmtClock(r.to)}` : ''} ${r.ok ? '정상' : '비정상'} (${r.count}회)`}
                className={
                  // 실패 구간은 색만으로 구분하지 않는다 — 위쪽에 밝은 눈금을 함께 둔다
                  r.ok ? 'bg-emerald-500/70' : 'border-t-2 border-red-300 bg-red-500/80'
                }
              />
            ))}
          </div>
          {/*
            **폭을 고정한다.** 예전에는 글자 수만큼 자리를 차지해, 실패한 줄만 라벨이 길어지고
            그만큼 띠가 짧아졌다 — 줄마다 띠 끝이 어긋나 그리다 만 것처럼 보였다.
            자리를 고정하면 여러 줄의 띠가 같은 지점에서 끝나 서로 비교된다(원래 목적이 그것이다).
            길어지는 부분(마지막 실패 시각)은 툴팁으로 옮긴다.
          */}
          <span
            className="w-[168px] shrink-0 truncate text-right text-[10px] text-gray-500"
            title={
              `${cfg.intervalSec}초마다 확인 · 최근 ${spanLabel(state.recent)}` +
              (failCount > 0
                ? ` · 실패 ${failCount}회 (마지막 ${lastFailAt !== null ? fmtClock(lastFailAt) : '—'})`
                : ' · 실패 없음')
            }
          >
            {/* 확인 주기는 보드 헤더(⟳ 1초 갱신)에 이미 있다 — 줄마다 되풀이하면 자리만 먹는다 */}
            최근 {spanLabel(state.recent)}
            {failCount > 0 ? <span className="text-red-300/90">{' · '}실패 {failCount}</span> : ' · 실패 없음'}
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
            className={`${inputCls} h-20 w-full font-mono`}
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
// 드롭다운 문구는 describeCheck 가 만드는 문장과 같은 말을 쓴다 —
// 고를 때와 배지에 찍힐 때 표현이 다르면 같은 조건인지 알아보기 어렵다.
/**
 * 대상의 '판정에 영향을 주는' 부분만 뽑은 서명.
 * 이름·묶음·메모를 고쳤다고 시험 결과를 버릴 이유는 없다 — 그것들은 판정과 무관하다.
 */
function targetSig(t: PortalTarget): string {
  return JSON.stringify({ p: t.path, m: t.method, b: t.body, h: t.headers, e: t.expectStatus, c: t.checks, a: t.auth })
}

const CHECK_OPS: { v: PortalCheck['op']; label: string; needsValue: boolean }[] = [
  { v: 'nonEmptyArray', label: '항목 1개 이상 (목록)', needsValue: false },
  { v: 'exists', label: '값 있음', needsValue: false },
  { v: 'gte', label: '숫자가 ~ 이상', needsValue: true },
  { v: 'contains', label: '문자열 포함', needsValue: true },
  { v: 'notContains', label: '문자열 없음', needsValue: true },
  { v: 'regex', label: '정규식 일치', needsValue: true },
]

/**
 * 입력칸 공용 클래스. **폭은 여기서 정하지 않는다.**
 *
 * 예전에는 앞에 `w-full` 이 있었는데, 그러면 `${inputCls} w-48` 처럼 좁게 쓰려는 곳에서
 * 생성된 CSS 의 `.w-full` 이 뒤에 정의돼 이겨버린다(클래스를 쓴 순서는 우선순위와 무관하다).
 * 헤더 편집 줄에서 이름 칸이 100% 를 먹고 값 칸이 몇 픽셀로 찌그러진 것이 그 결과였다.
 * 시나리오 편집기에서 같은 원인으로 고급 설정이 가로로 넘친 전례가 있다.
 */
const inputCls = 'rounded border border-white/10 bg-black/30 px-2 py-1 text-[11px] text-gray-200 outline-none focus:border-blue-500/50'
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
  testResult: Record<
    string,
    {
      ok: boolean
      at: number
      lines: string[]
      detail?: string[]
      suggest?: { path: string; count: number }[]
      suggestValues?: { path: string; value: string }[]
    }
  >
  /** 추천 경로를 눌러 반영한 뒤, 그 안내를 지운다 */
  onClearSuggest: (id: string) => void
  onTestLogin: () => void
  loginTesting: boolean
  loginTest: { ok: boolean; text: string } | null
}) {
  const [expanded, setExpanded] = useState<string | null>(null)
  /** 시험 결과의 '자세히' 를 펼친 대상 */
  const [detailOpen, setDetailOpen] = useState<string | null>(null)
  /**
   * 인증 칸을 펼쳐 둘지.
   *
   * 로그인 시험이 통과하면 접는다 — 이 단계에서 사람이 할 일이 끝났다는 신호가 필요하고,
   * 아래 '감시 대상' 까지 가는 스크롤도 그만큼 짧아진다. 다시 펼치는 것은 사람만 한다.
   */
  const [authOpen, setAuthOpen] = useState(true)
  /** 거의 건드리지 않는 칸(전송 방식·본문 템플릿·만료 대응)은 접어 둔다 — 기본값으로 대개 동작한다 */
  const [advOpen, setAdvOpen] = useState(false)
  /** 대상별 '고급' 을 펼친 것 — 묶음·연속 성공·상태 코드·토큰·본문·헤더·메모 */
  const [advTarget, setAdvTarget] = useState<string | null>(null)
  /** 목록 위의 cURL 붙여넣기 상자 (새 대상을 만드는 가장 확실한 길) */
  const [curlNew, setCurlNew] = useState<string | null>(null)
  const [curlErr, setCurlErr] = useState('')
  useEffect(() => {
    if (loginTest?.ok) setAuthOpen(false)
  }, [loginTest?.ok])
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

  /**
   * 브라우저에서 복사한 cURL 로 **새 대상을 바로 만든다.**
   *
   * 예전에는 대상을 먼저 추가하고 펼쳐야 붙여넣는 칸이 나왔다 — 순서가 거꾸로다. 사람이 하는
   * 일은 "개발자도구에서 이 요청을 복사했다" 로 시작한다.
   * 이름은 경로의 마지막 조각으로 채워 둔다(빈 이름보다 낫고, 어차피 바로 고칠 수 있다).
   */
  const addFromCurl = (text: string) => {
    const parsed = parseCurl(text)
    if (!parsed) {
      setCurlErr("cURL 로 읽지 못했습니다 — 개발자도구 Network 에서 요청을 우클릭 → 'Copy as cURL' 한 내용을 그대로 붙여넣으세요.")
      return
    }
    const headers = headersFromCurl(parsed.headers)
    const path = pathFromUrl(cfg, parsed.url)
    const last = path.split('?')[0].split('/').filter(Boolean).slice(-1)[0]
    const t: PortalTarget = {
      id: newTargetId(),
      name: last || '새 대상',
      group: '',
      enabled: true,
      method: (parsed.method === 'POST' ? 'POST' : parsed.method === 'HEAD' ? 'HEAD' : 'GET') as PortalTarget['method'],
      path,
      headers: Object.keys(headers).length ? headers : undefined,
      body: parsed.body,
      auth: true,
      expectStatus: [200],
      checks: [],
    }
    onChange({ ...cfg, targets: [...cfg.targets, t] })
    setExpanded(t.id)
    setCurlNew(null)
    setCurlErr('')
  }

  /** 접힌 줄에 다는 조건 요약 — 무엇을 정상으로 보는지가 목록에서 보여야 한다 */
  const checkSummary = (t: PortalTarget) => {
    const cs = t.checks ?? []
    if (!cs.length) return null
    const first = describeCheck(cs[0])
    return cs.length > 1 ? `${first} 외 ${cs.length - 1}` : first
  }

  return (
    <div className="space-y-3 px-3 pb-3">
      {/* 어디까지 됐는지 — 스크롤하지 않고 알 수 있어야 한다(칸이 많아 아래가 잘 안 보인다) */}
      <div className="grid grid-cols-4 gap-1.5">
        {[
          {
            n: '1',
            t: '포털 주소',
            v: cfg.baseUrl.trim() ? cfg.baseUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '') : '미입력',
            ok: !!cfg.baseUrl.trim(),
          },
          {
            n: '2',
            t: '인증',
            v:
              cfg.auth.mode === 'none'
                ? '없음'
                : loginTest?.ok
                  ? '준비됨'
                  : cfg.auth.mode === 'token'
                    ? '토큰 직접 입력'
                    : '시험 필요',
            ok: cfg.auth.mode === 'none' || !!loginTest?.ok,
          },
          {
            n: '3',
            t: '감시 대상',
            v: `${cfg.targets.filter((t) => t.enabled && (t.path ?? '').trim()).length}개 활성`,
            ok: cfg.targets.some((t) => t.enabled && (t.path ?? '').trim()),
          },
          { n: '4', t: '판정 기준', v: `${cfg.intervalSec}초 · 연속 ${cfg.successStreak}회`, ok: true },
        ].map((st) => (
          <div
            key={st.n}
            className={
              'min-w-0 rounded border px-2 py-1.5 ' +
              (st.ok ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-amber-500/40 bg-amber-500/5')
            }
          >
            <div className="text-[10px] text-gray-500">
              {st.n} · {st.t}
            </div>
            <div className={'truncate text-[11px] ' + (st.ok ? 'text-emerald-200/90' : 'text-amber-200')} title={st.v}>
              {st.v}
            </div>
          </div>
        ))}
      </div>

      {/* 접속 */}
      <div className="rounded border border-white/10 bg-black/20 p-2.5">
        <div className="mb-2 text-[11px] font-medium text-gray-300">포털 주소</div>
        <div className="grid grid-cols-[1fr_auto] gap-2">
          <div>
            <div className={labelCls}>기본 주소 — 도메인이 바뀌면 여기만 고치면 됩니다</div>
            <input
              className={
                inputCls + ' w-full' + (cfg.baseUrl.trim() ? '' : ' border-amber-500/60 bg-amber-500/5')
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
          {cfg.auth.mode === 'login' && loginTest?.ok && !authOpen && (
            <button
              onClick={() => setAuthOpen(true)}
              className="ml-auto flex items-center gap-1 rounded border border-white/10 px-2 py-0.5 text-[10.5px] text-gray-400 hover:bg-white/5"
            >
              펼치기 <ChevronDown size={11} />
            </button>
          )}
        </div>
        {cfg.auth.mode === 'token' && (
          <>
            <div className={labelCls}>
              개발자도구에서 복사한 토큰. 만료되면 감시가 멈추므로, 로그인 API 경로를 아직 모를 때 잠깐
              확인하는 용도로만 쓰세요 — 긴 검증에는 위 <b className="text-gray-400">아이디/비밀번호 로그인</b> 을 쓰세요.
            </div>
            <input className={`${inputCls} w-full`} value={cfg.auth.token ?? ''} onChange={(e) => setAuth({ token: e.target.value })} />
          </>
        )}
        {cfg.auth.mode === 'login' && (
          <div className="space-y-1.5">
            {/* 통과 뒤에는 한 줄 요약만 — 이 단계에서 할 일이 끝났다는 신호 */}
            {loginTest?.ok && !authOpen ? (
              <div className="flex items-center gap-2 rounded border border-emerald-500/40 bg-emerald-500/10 px-2 py-1.5 text-[11px] text-emerald-200">
                <ShieldCheck size={12} className="shrink-0" />
                <span className="shrink-0 font-medium">인증 준비됨</span>
                <span className="min-w-0 truncate text-emerald-200/80" title={loginTest.text}>
                  {cfg.auth.username}
                  {(cfg.auth.reissueMinutes ?? 0) > 0 ? ` · ${cfg.auth.reissueMinutes}분마다 미리 재발급` : ''}
                  {' · 만료되면 즉시 다시 받아옵니다'}
                </span>
              </div>
            ) : (
              <>
                {/* 이 안내는 아직 통과하지 못한 동안에만 값어치가 있다 */}
                {looksEncrypted(cfg.auth.password ?? '') && !loginTest?.ok && (
                  <div className="rounded border border-sky-500/40 bg-sky-500/10 px-2 py-1.5 text-[10.5px] leading-relaxed text-sky-200">
                    비밀번호 칸의 값이 <b>암호화된 문자열처럼</b> 보입니다 — 개발자도구 Payload 에서 그대로 옮기신
                    것이라면 대개 <b>그대로 다시 보내도 통합니다</b>(AES-CBC 는 복호화에 필요한 값을 암호문 안에
                    같이 담아 보내기 때문입니다). 아래 <b>'로그인 시험'</b> 으로 확인하세요.
                  </div>
                )}
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <div className={labelCls}>로그인 API 경로</div>
                    <input className={`${inputCls} w-full`} value={cfg.auth.loginPath ?? ''} onChange={(e) => setAuth({ loginPath: e.target.value })} />
                  </div>
                  <div>
                    <div className={labelCls} title="응답 JSON 안에서 토큰이 있는 자리. 예: data.accessToken">
                      토큰 위치 <HelpCircle size={9} className="mb-px inline text-gray-600" />
                    </div>
                    <input className={`${inputCls} w-full`} value={cfg.auth.tokenPath ?? ''} placeholder="accessToken 또는 data.token" onChange={(e) => setAuth({ tokenPath: e.target.value })} />
                  </div>
                  <div>
                    <div className={labelCls}>계정</div>
                    <input className={`${inputCls} w-full`} value={cfg.auth.username ?? ''} onChange={(e) => setAuth({ username: e.target.value })} />
                  </div>
                  <div>
                    <div className={labelCls}>
                      비밀번호 <span className="text-gray-600">· OS 키체인에 암호화 저장</span>
                    </div>
                    <input type="password" className={`${inputCls} w-full`} value={cfg.auth.password ?? ''} onChange={(e) => setAuth({ password: e.target.value })} />
                  </div>
                </div>

                {/* 이 설정이 실제로 토큰을 받아오는지가 '끊김 없는 감시' 의 전제다 */}
                <div className="flex items-center gap-2">
                  <button
                    disabled={loginTesting}
                    onClick={onTestLogin}
                    className="flex items-center gap-1 rounded border border-white/10 px-2 py-0.5 text-[11px] text-gray-200 hover:bg-white/5 disabled:opacity-40"
                  >
                    <RefreshCw size={11} className={loginTesting ? 'animate-spin' : ''} /> 로그인 시험
                  </button>
                  <span className="text-[10px] text-gray-500">되면 이 칸들은 한 줄로 접힙니다</span>
                  <button
                    onClick={() => setAdvOpen((v) => !v)}
                    className="ml-auto flex items-center gap-1 rounded border border-white/10 px-2 py-0.5 text-[10.5px] text-gray-400 hover:bg-white/5"
                  >
                    고급 설정 {advOpen ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
                  </button>
                </div>
              </>
            )}

            {/* 실패는 접지 않는다 — 사유가 곧 다음에 할 일이다 */}
            {loginTest && !loginTest.ok && (
              <div className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-[10.5px] leading-relaxed text-amber-200">
                <b>로그인 시험 실패</b> — {loginTest.text}
              </div>
            )}
            {loginTest?.ok && authOpen && (
              <div className="rounded border border-emerald-500/40 bg-emerald-500/10 px-2 py-1.5 text-[10.5px] leading-relaxed text-emerald-200">
                <b>로그인 시험</b> — {loginTest.text}
              </div>
            )}

            {/* ── 고급 설정 — 기본값으로 대개 그대로 둔다 ── */}
            {advOpen && (
              <div className="mt-1 space-y-2 rounded border border-white/10 bg-black/20 p-2">
                <div className="grid grid-cols-2 gap-2">
                  <div className="col-span-2">
                    {/* MFA 를 쓰는 포털이 있다 — 바꾼 것은 없고, 원래 되는 것을 적어 둔다.
                        본문은 통째로 그대로 나가므로 인증번호 칸을 하나 더 적으면 그만이다.
                        (한 번에 끝나는 로그인만 해당한다 — 로그인 뒤 인증번호를 다시 물어보는
                        2단계 방식은 요청이 두 번이라 지금 구조로는 안 된다) */}
                    <div
                      className={labelCls}
                      title="{{id}} / {{pw}} 가 위 계정·비밀번호로 치환됩니다. 그 밖의 칸은 적은 그대로 나갑니다 — MFA 라면 인증번호 칸을 그냥 추가하세요"
                    >
                      로그인 요청 본문 <HelpCircle size={9} className="mb-px inline text-gray-600" />
                    </div>
                    <input className={`${inputCls} w-full`} value={cfg.auth.loginBody ?? ''} onChange={(e) => setAuth({ loginBody: e.target.value })} />
                    <p className="mt-0.5 text-[10px] leading-relaxed text-gray-600">
                      <span className="text-gray-500">{'{{id}}'}</span> ·{' '}
                      <span className="text-gray-500">{'{{pw}}'}</span> 만 치환되고 나머지는 적은 그대로 나갑니다.
                      인증번호를 <span className="text-gray-500">한 번에 같이 보내는</span> 포털이면 여기에 칸을 하나
                      더 적으면 됩니다 —{' '}
                      <span className="font-mono text-gray-500">{'{"userId":"{{id}}","password":"{{pw}}","otpCode":"123456"}'}</span>
                      <br />
                      로그인한 뒤 인증번호를 <span className="text-gray-500">다시 묻는</span> 포털이면 아래 2차 인증을
                      채우세요.
                    </p>
                  </div>

                  {/*
                    ── 2차 인증 ───────────────────────────────────────
                    로그인 뒤 6자리를 다시 묻는 포털용. 경로를 비워 두면 아예 하지 않으므로,
                    쓰지 않는 사람에게는 칸 네 개가 늘어날 뿐 동작은 그대로다.

                    **고정 인증번호에만 쓸 수 있다** — 30초마다 바뀌는 진짜 OTP 는 비밀키가
                    있어야 만들 수 있고, 우리는 그것을 받지 않는다. 검증 환경에서 코드를
                    고정해 둔 경우를 위한 자리라는 것을 화면에도 적어 둔다.
                  */}
                  <div className="col-span-2 rounded border border-white/10 bg-black/20 p-2">
                    <div className="mb-1 flex items-center gap-1.5">
                      <span className="text-[11px] font-medium text-gray-300">2차 인증 (MFA)</span>
                      <span className="text-[10px] text-gray-600">
                        {cfg.auth.mfaPath?.trim() ? '켜짐' : '경로를 비워 두면 하지 않습니다'}
                      </span>
                    </div>
                    <p className="mb-1.5 text-[10px] leading-relaxed text-gray-600">
                      로그인 → 인증번호 확인 → 그때 토큰을 주는 포털용입니다. 1단계 응답의{' '}
                      <span className="text-gray-500">중간 토큰과 세션 쿠키를 둘 다</span> 2단계로 물려줍니다.
                      <br />
                      <span className="text-amber-300/70">
                        번호가 30초마다 바뀌거나 메일로 새로 오는 방식에는 쓸 수 없습니다 — 검증 환경에서 고정해
                        둔 번호만 됩니다. 재발급 주기마다 1·2단계를 다시 밟으므로, 실제 포털이라면 그때마다 인증
                        메일이 나갑니다.
                      </span>
                    </p>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <div className={labelCls} title="인증번호를 확인하는 API 경로 (POST)">
                          2차 인증 경로 <HelpCircle size={9} className="mb-px inline text-gray-600" />
                        </div>
                        <input
                          className={`${inputCls} w-full`}
                          placeholder="/v1/bootfactory/api/mfa/issue"
                          value={cfg.auth.mfaPath ?? ''}
                          onChange={(e) => setAuth({ mfaPath: e.target.value })}
                        />
                      </div>
                      <div>
                        <div className={labelCls} title="고정된 6자리 인증번호">
                          인증번호 <HelpCircle size={9} className="mb-px inline text-gray-600" />
                        </div>
                        <input
                          className={`${inputCls} w-full font-mono`}
                          placeholder="123456"
                          value={cfg.auth.otp ?? ''}
                          onChange={(e) => setAuth({ otp: e.target.value })}
                        />
                      </div>
                      <div className="col-span-2">
                        <div
                          className={labelCls}
                          title="1단계 응답에서 중간 토큰을 꺼낼 위치. 쿠키로만 잇는 포털이면 비워 두세요"
                        >
                          1단계 중간 토큰 위치 <HelpCircle size={9} className="mb-px inline text-gray-600" />
                        </div>
                        <input
                          className={`${inputCls} w-full font-mono`}
                          placeholder="data.otpSessionUuid (쿠키로만 이어지면 비워 두세요)"
                          value={cfg.auth.mfaTokenPath ?? ''}
                          onChange={(e) => setAuth({ mfaTokenPath: e.target.value })}
                        />
                      </div>
                      <div className="col-span-2">
                        <div className={labelCls} title="{{otp}} {{mfaToken}} {{id}} 가 치환됩니다">
                          2차 인증 요청 본문 <HelpCircle size={9} className="mb-px inline text-gray-600" />
                        </div>
                        <input
                          className={`${inputCls} w-full font-mono`}
                          placeholder={'{"otpCode":"{{otp}}","otpSessionUuid":"{{mfaToken}}"}'}
                          value={cfg.auth.mfaBody ?? ''}
                          onChange={(e) => setAuth({ mfaBody: e.target.value })}
                        />
                        <p className="mt-0.5 text-[10px] leading-relaxed text-gray-600">
                          <span className="text-gray-500">{'{{otp}}'}</span> ·{' '}
                          <span className="text-gray-500">{'{{mfaToken}}'}</span> ·{' '}
                          <span className="text-gray-500">{'{{id}}'}</span> 가 치환됩니다. 토큰은 위{' '}
                          <span className="text-gray-500">토큰 위치</span> 로 2단계 응답에서 꺼냅니다 — 1단계가
                          아니라 <span className="text-gray-500">2단계</span> 응답 기준입니다.
                        </p>
                      </div>
                    </div>
                  </div>
                  <div>
                    <div className={labelCls}>토큰 헤더 이름</div>
                    <input className={`${inputCls} w-full`} value={cfg.auth.header ?? ''} onChange={(e) => setAuth({ header: e.target.value })} />
                  </div>
                  <div>
                    <div className={labelCls}>헤더 형식</div>
                    <input className={`${inputCls} w-full`} value={cfg.auth.headerFormat ?? ''} placeholder="Bearer {token}" onChange={(e) => setAuth({ headerFormat: e.target.value })} />
                  </div>
                  <div className="col-span-2">
                    <div className={labelCls}>쿠키 이름 <span className="text-gray-600">· 토큰을 쿠키로도 보내야 할 때만</span></div>
                    <input className={`${inputCls} w-full`} value={cfg.auth.cookieName ?? ''} placeholder="accessToken" onChange={(e) => setAuth({ cookieName: e.target.value })} />
                  </div>
                  <div>
                    <div className={labelCls} title="0 이면 만료된 뒤(401)에만 재발급합니다. 토큰 수명이 10분이면 8 정도">
                      선제 재발급 (분) <HelpCircle size={9} className="mb-px inline text-gray-600" />
                    </div>
                    <input
                      type="number"
                      min={0}
                      className={`${inputCls} w-full`}
                      value={cfg.auth.reissueMinutes ?? 0}
                      onChange={(e) => setAuth({ reissueMinutes: Math.max(0, Number(e.target.value) || 0) })}
                    />
                  </div>
                  <div>
                    <div className={labelCls} title="토큰이 죽었는데도 HTTP 200 에 에러 봉투만 주는 포털에서 만료를 잡아냅니다">
                      만료를 뜻하는 응답 문구 <HelpCircle size={9} className="mb-px inline text-gray-600" />
                    </div>
                    <input
                      className={`${inputCls} w-full`}
                      value={cfg.auth.expiredBodyMatch ?? ''}
                      placeholder="TOKEN_NOT_VERIFY"
                      onChange={(e) => setAuth({ expiredBodyMatch: e.target.value })}
                    />
                  </div>
                </div>
                <p className="text-[10.5px] leading-relaxed text-gray-500">
                  401 이 오면 이 설정과 무관하게 항상 자동 재발급하고 한 번 더 시도합니다. 재로그인까지 실패하면
                  그대로 비정상으로 기록합니다 — 인증 서비스가 안 떠 있는 것도 "아직 정상이 아니다" 의 일부입니다.
                </p>
              </div>
            )}
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
              className={`${inputCls} w-full`}
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
              className={`${inputCls} w-full`}
              value={cfg.timeoutMs}
              onChange={(e) => set({ timeoutMs: Math.max(1000, Number(e.target.value) || 1000) })}
            />
          </div>
          <div>
            <div className={labelCls}>연속 성공 횟수</div>
            <input
              type="number"
              min={1}
              className={`${inputCls} w-full`}
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
          <span className="shrink-0 text-[11px] font-medium text-gray-300">감시 대상</span>
          <span className="shrink-0 text-[10.5px] text-gray-500">
            {cfg.targets.filter((t) => t.enabled && (t.path ?? '').trim()).length}개 활성
            {cfg.targets.filter((t) => t.enabled && (t.path ?? '').trim() && !(t.checks ?? []).length).length > 0 && (
              <span className="text-amber-300/90">
                {' · '}
                {cfg.targets.filter((t) => t.enabled && (t.path ?? '').trim() && !(t.checks ?? []).length).length}개는 본문 조건 없음
              </span>
            )}
          </span>
          <button
            onClick={() => {
              setCurlNew(curlNew === null ? '' : null)
              setCurlErr('')
            }}
            className="ml-auto flex shrink-0 items-center gap-1 rounded border border-white/10 px-2 py-0.5 text-[11px] text-gray-300 hover:bg-white/5"
          >
            <ClipboardPaste size={11} /> cURL 로 추가
          </button>
          <button onClick={addTarget} className="flex shrink-0 items-center gap-1 rounded border border-white/10 px-2 py-0.5 text-[11px] text-gray-300 hover:bg-white/5">
            <Plus size={11} /> 대상 추가
          </button>
        </div>
        {/* 새 대상을 만드는 가장 확실한 길 — 브라우저가 실제로 보낸 요청을 통째로 가져온다 */}
        {curlNew !== null && (
          <div className="mb-2 rounded border border-blue-500/30 bg-blue-500/5 p-2">
            <div className={labelCls}>
              개발자도구 Network 에서 요청 우클릭 → <b className="text-gray-300">Copy as cURL</b> 한 내용을 붙여넣으세요
              (헤더·본문까지 그대로 가져옵니다. 토큰·쿠키는 매번 새로 붙이므로 저장하지 않습니다)
            </div>
            <textarea
              className={`${inputCls} mt-1 h-16 w-full font-mono`}
              value={curlNew}
              autoFocus
              placeholder="curl 'https://…' -H 'accept: application/json' …"
              onChange={(e) => {
                setCurlNew(e.target.value)
                setCurlErr('')
              }}
            />
            {curlErr && <p className="mt-1 text-[10.5px] text-amber-300">{curlErr}</p>}
            <div className="mt-1 flex items-center gap-2">
              <button
                onClick={() => addFromCurl(curlNew)}
                className="rounded border border-white/10 px-2 py-0.5 text-[11px] text-gray-200 hover:bg-white/5"
              >
                대상으로 만들기
              </button>
              <button
                onClick={() => {
                  setCurlNew(null)
                  setCurlErr('')
                }}
                className="rounded border border-white/10 px-2 py-0.5 text-[11px] text-gray-400 hover:bg-white/5"
              >
                취소
              </button>
            </div>
          </div>
        )}
        <div className="space-y-1.5">
          {cfg.targets.map((t) => {
            const isOpen = expanded === t.id
            const res = testResult[t.id]
            return (
              <div
                key={t.id}
                className={
                  'rounded border bg-black/20 ' +
                  // 조건이 없으면 상태 코드만 보고 정상으로 친다 — SPA 껍데기는 백엔드가 죽어도 200 이라
                  // 그 사실이 목록에서 보여야 한다(끄라는 게 아니라 의도한 것인지 알아보게)
                  (t.enabled && (t.path ?? '').trim() && !(t.checks ?? []).length
                    ? 'border-amber-500/40'
                    : 'border-white/10')
                }
              >
                <div className="flex items-center gap-2 px-2 py-1.5">
                  <input type="checkbox" checked={t.enabled} onChange={(e) => setTarget(t.id, { enabled: e.target.checked })} title="감시 켜기/끄기" />
                  <button onClick={() => setExpanded(isOpen ? null : t.id)} className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
                    {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    <span className="shrink-0 text-[11.5px] text-gray-200">{t.name || '(이름 없음)'}</span>
                    <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-gray-500">
                      {t.method} {t.path || '경로 미입력'}
                    </span>
                    {/* 무엇을 정상으로 보는지 · 마지막 시험이 어땠는지 — 펼치지 않고 알 수 있어야 한다 */}
                    {checkSummary(t) ? (
                      <span
                        className="shrink-0 truncate rounded bg-white/5 px-1.5 text-[10px] text-gray-400"
                        title={(t.checks ?? []).map(describeCheck).join(' · 그리고 ')}
                      >
                        {checkSummary(t)}
                      </span>
                    ) : (
                      (t.path ?? '').trim() && (
                        <span
                          className="shrink-0 whitespace-nowrap rounded bg-amber-500/15 px-1.5 text-[10px] text-amber-300"
                          title="본문 조건이 없어 200 이면 정상으로 칩니다. 화면·정적 응답은 백엔드가 죽어도 200 이 오므로, 이 대상만으로는 복구를 판단하면 안 됩니다. 시험을 눌러 보면 이 응답 안의 목록을 찾아 조건 후보로 제안합니다"
                        >
                          200 이면 정상 (본문 안 봄)
                        </span>
                      )
                    )}
                    {res && (
                      <span
                        className={
                          'shrink-0 whitespace-nowrap text-[10px] ' + (res.ok ? 'text-emerald-300/90' : 'text-red-300/90')
                        }
                      >
                        {fmtClock(res.at)} {res.ok ? '정상' : '비정상'}
                      </span>
                    )}
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

                {/* 접혀 있을 때는 줄 끝 배지로 충분하다. 다만 **실패는 접지 않는다** — 사유가 곧 다음에 할 일이다 */}
                {res && (isOpen || !res.ok) && (
                  <div className={`mx-2 mb-2 rounded border px-2 py-1.5 text-[10.5px] ${res.ok ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200' : 'border-red-500/30 bg-red-500/10 text-red-200'}`}>
                    <div className="mb-0.5 flex items-center gap-1 font-medium">
                      {res.ok ? <Check size={11} /> : <AlertTriangle size={11} />}
                      {res.ok ? '정상으로 판정됩니다' : '비정상으로 판정됩니다'}
                    </div>
                    {/* 경로를 손으로 고쳐 쓰라고 하면 어디를 고치라는 건지 헷갈린다 — 눌러서 바로 반영한다 */}
                    {res.suggest && (
                      <div className="mb-1.5 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-amber-100">
                        <div className="mb-1">
                          {(t.checks ?? []).length === 0 ? (
                            <>
                              이 응답에는 <b>목록</b>이 들어 있습니다. 눌러서 <b>정상 조건</b>으로 추가하세요 — 지금은
                              조건이 없어 <b>200 이면 정상</b>으로 칩니다.
                            </>
                          ) : (
                            <>이 응답에서 <b>목록</b>이 있는 곳입니다. 눌러서 아래 <b>정상 조건</b>의 경로를 바꾸세요.</>
                          )}
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
                    {/*
                      목록이 원래 비어 있을 수 있는 응답이다. 경로를 바꿔 봐야 소용없고, 조건 자체를
                      바꿔야 한다 — 백엔드가 실제로 답을 만들었다는 신호(응답 봉투의 상태 문구)를 본다.
                    */}
                    {res.suggestValues && (
                      <div className="mb-1.5 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-amber-100">
                        <div className="mb-1">
                          이 응답에는 <b>항목이 있는 목록이 없습니다</b>. 원래 0건일 수 있는 응답이라면
                          <b> 항목 1개 이상</b> 대신 아래 조건이 맞습니다 — 백엔드가 답을 만들었을 때만 나오는
                          문구라, 게이트웨이 오류 페이지나 화면 껍데기는 통과하지 못합니다.
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          {res.suggestValues.map((v) => (
                            <button
                              key={v.path}
                              onClick={() => {
                                // 목록 조건은 이 응답에서 성립할 수 없으므로 그 자리를 대신한다
                                const rest = (t.checks ?? []).filter((c) => c.op !== 'nonEmptyArray')
                                setTarget(t.id, { checks: [...rest, { path: v.path, op: 'contains', value: v.value }] })
                                onClearSuggest(t.id)
                              }}
                              className="rounded border border-amber-400/50 bg-amber-500/20 px-2 py-0.5 font-mono text-[10.5px] text-amber-50 hover:bg-amber-500/40"
                            >
                              {v.path} · "{v.value}" 포함
                            </button>
                          ))}
                        </div>
                        <div className="mt-1 text-[10px] text-amber-200/80">
                          누르면 기존 <b>항목 1개 이상</b> 조건을 대신합니다. 바꾼 뒤 <b>⟳ 시험</b>으로 확인하세요.
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
                    {/* ── 1 · 무엇을 부르나 ── */}
                    <div className="text-[10px] uppercase tracking-wide text-gray-500">1 · 무엇을 부르나</div>
                    <div>
                      <div className={labelCls}>이름 — 화면에 이 이름으로 보입니다</div>
                      <input className={`${inputCls} w-full`} value={t.name} onChange={(e) => setTarget(t.id, { name: e.target.value })} />
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
                          className={`${inputCls} w-full`}
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
                    <CurlImport cfg={cfg} onApply={(p) => setTarget(t.id, p)} />

                    {/* ── 2 · 무엇을 정상으로 볼까 (판정의 핵심이라 위로 올린다) ── */}
                    <div className="text-[10px] uppercase tracking-wide text-gray-500 pt-1">2 · 무엇을 정상으로 볼까</div>
                    {/* 정상 조건 */}
                    <div>
                      <div className="mb-1 flex items-center gap-2">
                        <span className={labelCls}>
                          정상 조건 — 전부 통과해야 정상. <b className="text-gray-400">비우면 응답 본문을 보지 않고 200 이면 정상</b>으로 칩니다
                        </span>
                        <button
                          onClick={() => setTarget(t.id, { checks: [...(t.checks ?? []), { path: '', op: 'nonEmptyArray' }] })}
                          className="ml-auto flex items-center gap-1 rounded border border-white/10 px-1.5 py-0.5 text-[10.5px] text-gray-300 hover:bg-white/5"
                        >
                          <Plus size={10} /> 조건
                        </button>
                      </div>
                      {(t.checks ?? []).length === 0 && (
                        <p className="text-[10.5px] text-amber-300/80">
                          지금은 <b>200 이면 정상</b>입니다. 목록을 주는 API 라면{' '}
                          <span className="text-gray-300">content · 항목 1개 이상</span> 을 넣으세요 — DB 는 붙었는데 백엔드가
                          아직 데이터를 못 읽어 <b>200 인데 빈 목록</b>이 오는 구간이 반드시 있고, 그건 복구가 아닙니다.
                          <br />
                          어떤 경로를 넣을지 모르겠으면 <b>⟳ 시험</b>을 누르세요 — 이 응답 안의 목록을 찾아 제안합니다.
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
                    {/* ── 3 · 고급 — 대개 기본값 그대로 둔다 ── */}
                    <button
                      onClick={() => setAdvTarget(advTarget === t.id ? null : t.id)}
                      className="flex w-full items-center gap-1.5 pt-1 text-left text-[10px] uppercase tracking-wide text-gray-500 hover:text-gray-300"
                    >
                      {advTarget === t.id ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                      3 · 고급
                      <span className="normal-case tracking-normal text-gray-600">
                        — 묶음 · 연속 성공 · 상태 코드 · 본문 · 헤더 · 메모
                      </span>
                    </button>
                    {advTarget === t.id && (
                      <div className="space-y-2 rounded border border-white/10 bg-black/20 p-2">
                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            <div className={labelCls}>페이지 묶음 (같은 이름끼리 모아 표시)</div>
                            <input className={`${inputCls} w-full`} value={t.group ?? ''} placeholder="인스턴스 상세" onChange={(e) => setTarget(t.id, { group: e.target.value })} />
                          </div>
                          <div>
                            <div className={labelCls}>연속 성공 (비우면 전체 설정값)</div>
                            <input
                              type="number"
                              min={1}
                              className={`${inputCls} w-full`}
                              value={t.successStreak ?? ''}
                              placeholder={String(cfg.successStreak)}
                              onChange={(e) => setTarget(t.id, { successStreak: e.target.value ? Math.max(1, Number(e.target.value)) : undefined })}
                            />
                          </div>
                        </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <div className={labelCls}>정상 HTTP 상태 (쉼표)</div>
                        <input
                          className={`${inputCls} w-full`}
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
                        <input className={`${inputCls} w-full`} value={t.note ?? ''} onChange={(e) => setTarget(t.id, { note: e.target.value })} />
                      </div>
                    </div>

                    {t.method === 'POST' && (
                      <div>
                        <div className={labelCls}>요청 본문 (JSON)</div>
                        <textarea className={`${inputCls} h-14 w-full font-mono`} value={t.body ?? ''} onChange={(e) => setTarget(t.id, { body: e.target.value })} />
                      </div>
                    )}
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
                              className={`${inputCls} min-w-0 flex-1`}
                              value={v}
                              placeholder="값 (예: application/json)"
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

                      </div>
                    )}

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
