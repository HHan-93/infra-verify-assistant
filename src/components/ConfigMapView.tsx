import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Search,
  Download,
  Loader2,
  Eye,
  EyeOff,
  Pencil,
  RotateCcw,
  AlertTriangle,
  Check,
  FileCode,
  History,
  ExternalLink,
  Server,
} from 'lucide-react'
import type { ConfigMapDetail, ConfigMapRef, ConfigMapBackup, CmBackupOrigin } from '../../electron/shared-types'
import { isSecretKey, maskedValue } from '../lib/cmSecret'

/**
 * 설정 관리 창의 **파드 ConfigMap 모드**.
 *
 * 파일(SFTP) 모드와 셋이 다르다.
 *  1) ConfigMap 은 문서가 아니라 **키-값 맵**이다(운영 cm 에 키가 110 개인 것을 봤다). 그래서
 *     YAML 한 덩어리를 편집하게 하지 않고 표에서 값 하나씩 고친다 — 인용(따옴표)·들여쓰기를
 *     사람이 관리할 필요가 없어진다.
 *  2) 여러 값을 고쳐도 **적용 전까지 클러스터에 아무것도 보내지 않는다.** 대기 목록에 쌓아 두고
 *     한 번에 patch 한다 — 중간 상태가 생기지 않고, 재기동이 걸린 환경이라면 롤아웃도 한 번이다.
 *  3) YAML 전문은 **읽기 전용**이다. `kubectl edit` 은 문법이 깨지면 반영을 거부해 주지만
 *     우리 textarea 에는 그 안전장치가 없다. 편집 수단을 두 개 주면 위험한 쪽이 쓰인다.
 */
export default function ConfigMapView({
  sessionId,
  connected,
  fontSize,
  sessionLabel,
}: {
  sessionId: string
  connected: boolean
  /** 파일 모드와 같은 글꼴 크기를 쓴다 (뷰어 상단에서 조절) */
  fontSize: number
  /** 탭에 보이는 세션 이름 "별칭 (IP)" — 백업 이력에 "어느 세션에서 고쳤는지" 로 남는다 */
  sessionLabel?: string
}) {
  const [namespaces, setNamespaces] = useState<string[]>([])
  const [ns, setNs] = useState('')
  const [cms, setCms] = useState<ConfigMapRef[]>([])
  const [name, setName] = useState('')
  const [detail, setDetail] = useState<ConfigMapDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [msg, setMsg] = useState('')

  /** 대기 중인 변경 — 키 → 새 값. 적용 전까지 여기에만 있다 */
  const [pending, setPending] = useState<Record<string, string>>({})
  /** 지금 편집 중인 키와 입력값 */
  const [editKey, setEditKey] = useState<string | null>(null)
  const [editVal, setEditVal] = useState('')
  const editRef = useRef<HTMLInputElement>(null)

  const [query, setQuery] = useState('')
  const [maskOn, setMaskOn] = useState(true)
  /** 사용자가 눈 아이콘으로 직접 펼친 키 (가리기가 켜져 있어도 이건 보인다) */
  const [revealed, setRevealed] = useState<Set<string>>(new Set())
  const [onlyChanged, setOnlyChanged] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [applying, setApplying] = useState(false)
  const [yamlOpen, setYamlOpen] = useState(false)
  const [yaml, setYaml] = useState('')
  const [backups, setBackups] = useState<ConfigMapBackup[] | null>(null)
  /**
   * 대상을 바꾸려는 요청. 대기 중인 변경이 있으면 바로 옮기지 않고 이걸 세워 물어본다.
   * (조용히 버리면 사용자가 고쳐 둔 값이 사라진 것도 모르고 지나간다)
   */
  const [navTo, setNavTo] = useState<{ kind: 'ns' | 'cm' | 'target'; value: string; ns?: string } | null>(null)
  /** 백업 이력 범위 — 'one' 은 지금 열어 둔 것, 'all' 은 최근에 무엇을 바꿨는지 */
  const [bkScope, setBkScope] = useState<'one' | 'all'>('one')
  /** 'all' 일 때의 ConfigMap 개수 (몇 곳을 건드렸는지) */
  const [bkCms, setBkCms] = useState<number | null>(null)
  /**
   * 지금 세션이 가리키는 환경(host · kubectl context).
   * 이력의 백업이 **다른 클러스터의 것**인지 가려내는 기준이다 — 같은 이름의 cm 이 환경마다
   * 있으므로, 이것 없이는 내보내기 버튼 옆에서 잘못된 YAML 을 고를 수 있다.
   */
  const [env, setEnv] = useState<CmBackupOrigin | null>(null)

  // 네임스페이스 목록은 세션이 붙어 있을 때 한 번만
  useEffect(() => {
    if (!connected) return
    window.electronAPI.k8sListNamespaces(sessionId).then((r) => {
      if (r.ok && r.namespaces) setNamespaces(r.namespaces)
      else setMsg(r.error ?? '네임스페이스를 가져오지 못했습니다.')
    })
    // 환경은 조회에 실패해도 그냥 비워 둔다 — 그러면 '다른 환경' 경고만 뜨지 않고 나머지는 그대로 쓴다
    window.electronAPI.k8sCmEnv(sessionId, sessionLabel).then((r) => setEnv(r.origin ?? null))
    // sessionLabel 은 탭 이름이라 사용자가 바꿀 수 있지만, 그때마다 다시 물을 이유는 없다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, connected])

  const loadCms = async (namespace: string) => {
    setNs(namespace)
    setCms([])
    setName('')
    /**
     * 옛 ConfigMap 의 내용을 **반드시 비운다.**
     *
     * 예전에는 detail 을 그대로 뒀는데, 네임스페이스만 바꾸면 화면에는 새 네임스페이스가 선택된
     * 채 이전 cm 의 키-값 표가 남았다. 표시만 헷갈리는 게 아니다 — 대기 중인 변경도 함께 남아서,
     * 그 상태로 적용을 누르면 patch 가 **화면에 없는 옛 cm 으로** 나간다.
     */
    clearLoaded()
    if (!namespace) return
    setLoading(true)
    const r = await window.electronAPI.k8sListConfigMaps(sessionId, namespace)
    setLoading(false)
    if (r.ok && r.items) {
      setCms(r.items)
      setMsg(`${namespace}: ConfigMap ${r.items.length}개`)
    } else setMsg(r.error ?? 'ConfigMap 목록 조회 실패')
  }

  /** 불러온 내용과 그에 딸린 상태를 한꺼번에 비운다 — 하나만 빼먹으면 옛 값이 남는다 */
  const clearLoaded = () => {
    setDetail(null)
    setPending({})
    setEditKey(null)
    setRevealed(new Set())
    setYamlOpen(false)
    setYaml('')
    setBackups(null)
    setQuery('')
    setOnlyChanged(false)
  }

  /** 대상 변경 요청 — 대기 중인 변경이 있으면 먼저 물어본다 */
  const requestNav = (kind: 'ns' | 'cm' | 'target', value: string, targetNs?: string) => {
    if (dirty) {
      setNavTo({ kind, value, ns: targetNs })
      return
    }
    doNav(kind, value, targetNs)
  }
  const doNav = (kind: 'ns' | 'cm' | 'target', value: string, targetNs?: string) => {
    if (kind === 'ns') {
      loadCms(value)
      return
    }
    if (kind === 'cm') {
      setName(value)
      load(value)
      return
    }
    // 'target' — 다른 네임스페이스의 cm 으로 바로 이동(백업 이력의 '열기')
    const nextNs = targetNs ?? ns
    setNs(nextNs)
    setName(value)
    load(value, nextNs)
    // 목록도 그 네임스페이스로 맞춰 둔다(선택 상자가 비어 보이지 않게)
    window.electronAPI.k8sListConfigMaps(sessionId, nextNs).then((r) => {
      if (r.ok && r.items) setCms(r.items)
    })
  }

  const load = async (cmName: string, nsArg?: string) => {
    // 백업 이력에서 '열기' 로 들어오면 ns 상태가 아직 갱신되지 않았을 수 있어 인자를 우선한다
    const useNs = nsArg ?? ns
    if (!useNs || !cmName) return
    setLoading(true)
    clearLoaded()
    const r = await window.electronAPI.k8sGetConfigMap(sessionId, useNs, cmName)
    setLoading(false)
    if (r.ok && r.detail) {
      setDetail(r.detail)
      setMsg(`불러옴: ${useNs}/${cmName} · 키 ${Object.keys(r.detail.data).length}개`)
    } else {
      setDetail(null)
      setMsg(r.error ?? '조회 실패')
    }
  }

  const rows = useMemo(() => {
    if (!detail) return []
    const q = query.trim().toLowerCase()
    return Object.keys(detail.data)
      .sort()
      .filter((k) => {
        if (onlyChanged && pending[k] === undefined) return false
        if (!q) return true
        // 키와 값 둘 다에서 찾는다 — 값으로 키를 되짚는 일이 잦다
        return k.toLowerCase().includes(q) || detail.data[k].toLowerCase().includes(q)
      })
  }, [detail, query, onlyChanged, pending])

  const pendingKeys = Object.keys(pending)
  const dirty = pendingKeys.length > 0

  const startEdit = (k: string) => {
    setEditKey(k)
    setEditVal(pending[k] ?? detail?.data[k] ?? '')
    setTimeout(() => editRef.current?.focus(), 0)
  }
  const commitEdit = () => {
    if (!editKey || !detail) return
    const original = detail.data[editKey] ?? ''
    setPending((p) => {
      const next = { ...p }
      // 원래 값으로 되돌려 놓았으면 변경 목록에서 빼는 게 맞다 (없는 변경을 보내지 않는다)
      if (editVal === original) delete next[editKey]
      else next[editKey] = editVal
      return next
    })
    setEditKey(null)
  }
  const revert = (k: string) =>
    setPending((p) => {
      const next = { ...p }
      delete next[k]
      return next
    })

  const apply = async () => {
    if (!detail) return
    setApplying(true)
    const r = await window.electronAPI.k8sPatchConfigMap({
      sessionId,
      namespace: detail.namespace,
      name: detail.name,
      changes: pending,
      baseResourceVersion: detail.resourceVersion,
      alias: sessionLabel,
    })
    setApplying(false)
    setConfirmOpen(false)
    if (r.ok) {
      // 적용된 값을 화면에도 반영한다 — 다시 불러오지 않아도 지금 상태가 맞게 보이도록
      setDetail({
        ...detail,
        data: { ...detail.data, ...pending },
        resourceVersion: r.resourceVersion ?? detail.resourceVersion,
      })
      setPending({})
      setMsg(`적용 완료 — ${r.applied}건. 백업: ${r.backupPath ?? '(없음)'}`)
    } else {
      setMsg((r.conflict ? '적용하지 않았습니다 — ' : '적용 실패: ') + (r.error ?? ''))
    }
  }

  const showYaml = async () => {
    if (!detail) return
    setYamlOpen(true)
    if (yaml) return
    const r = await window.electronAPI.k8sGetConfigMapYaml(sessionId, detail.namespace, detail.name)
    setYaml(r.ok ? (r.yaml ?? '') : `조회 실패: ${r.error ?? ''}`)
  }
  const loadBackups = async (scope: 'one' | 'all') => {
    setBkScope(scope)
    if (scope === 'all') {
      const r = await window.electronAPI.k8sCmBackupListAll()
      setBkCms(r.configMaps ?? 0)
      setBackups(r.items ?? [])
      return
    }
    if (!detail) return
    setBkCms(null)
    const r = await window.electronAPI.k8sCmBackupList(detail.namespace, detail.name)
    setBackups(r.items ?? [])
  }

  /**
   * 이 백업이 **지금 접속한 환경**에서 만든 것인가.
   *
   * 아는 값만 비교한다 — host·context 를 모르는 옛 백업(또는 kubeconfig 를 못 읽은 세션)을
   * '다른 환경'으로 몰면 경고가 상시로 떠서 정작 진짜 경고가 안 읽힌다.
   * 반대로 host 는 같은데 context 가 다르면 **다른 클러스터다**(같은 점프 서버에서 갈아탄 경우).
   */
  const sameEnv = (o?: CmBackupOrigin) => {
    if (!o || !env) return true
    const hostKnown = !!o.host && !!env.host
    const ctxKnown = !!o.context && !!env.context
    if (!hostKnown && !ctxKnown) return true
    if (hostKnown && o.host !== env.host) return false
    if (ctxKnown && o.context !== env.context) return false
    return true
  }
  /** 별칭이 있으면 별칭("이름 (IP)" 형태라 host 를 또 붙이지 않는다), 없으면 host */
  const envName = (o?: CmBackupOrigin) => o?.alias?.trim() || o?.host || ''

  const valueOf = (k: string) => pending[k] ?? detail?.data[k] ?? ''
  const hidden = (k: string) => maskOn && isSecretKey(k) && !revealed.has(k)
  const mono = { fontFamily: 'inherit', fontSize: `${fontSize}px` }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 대상 선택 */}
      <div className="flex items-center gap-1.5 border-b border-white/10 px-4 py-2">
        <span className="shrink-0 text-[11px] text-gray-400">네임스페이스</span>
        <select
          value={ns}
          onChange={(e) => requestNav('ns', e.target.value)}
          disabled={!connected}
          className="w-[150px] shrink-0 rounded-md border border-white/10 bg-panel-light px-2 py-1 font-mono text-[12px] text-gray-100 focus:outline-none disabled:opacity-40"
        >
          <option value="">선택…</option>
          {namespaces.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        <span className="shrink-0 text-[11px] text-gray-400">ConfigMap</span>
        <select
          value={name}
          onChange={(e) => requestNav('cm', e.target.value)}
          disabled={!ns || cms.length === 0}
          className="min-w-0 flex-1 rounded-md border border-white/10 bg-panel-light px-2 py-1 font-mono text-[12px] text-gray-100 focus:outline-none disabled:opacity-40"
        >
          <option value="">{cms.length ? '선택…' : '네임스페이스를 먼저 고르세요'}</option>
          {cms.map((c) => (
            <option key={c.name} value={c.name}>
              {c.name}
            </option>
          ))}
        </select>
        {loading && <Loader2 size={14} className="shrink-0 animate-spin text-gray-400" />}
        {dirty && (
          <>
            <button
              onClick={() => setPending({})}
              className="shrink-0 whitespace-nowrap rounded-md border border-white/10 bg-panel-light px-2 py-1 text-[11px] text-gray-300 hover:bg-white/10"
            >
              되돌리기
            </button>
            <button
              onClick={() => setConfirmOpen(true)}
              className="shrink-0 whitespace-nowrap rounded-md bg-blue-600 px-2.5 py-1 text-[11px] text-white hover:bg-blue-500"
            >
              변경 {pendingKeys.length}건 적용
            </button>
          </>
        )}
      </div>

      {/* 검색 · 표시 옵션 */}
      {detail && (
        <div className="flex items-center gap-2 border-b border-white/10 px-4 py-1.5">
          <Search size={12} className="shrink-0 text-gray-500" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="키·값 검색"
            className="min-w-0 flex-1 bg-transparent text-[12px] text-gray-200 outline-none placeholder:text-gray-600"
          />
          <span className="shrink-0 text-[11px] text-gray-500">
            {rows.length}/{Object.keys(detail.data).length}
          </span>
          <button
            onClick={() => setMaskOn((v) => !v)}
            title="비밀번호·토큰처럼 보이는 키의 값을 가립니다"
            className={
              'flex shrink-0 items-center gap-1 whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] ' +
              (maskOn ? 'bg-amber-500/20 text-amber-300' : 'text-gray-400 hover:bg-white/10')
            }
          >
            {maskOn ? <EyeOff size={12} /> : <Eye size={12} />} 값 가리기
          </button>
          <button
            onClick={() => setOnlyChanged((v) => !v)}
            className={
              'shrink-0 whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] ' +
              (onlyChanged ? 'bg-emerald-500/20 text-emerald-300' : 'text-gray-400 hover:bg-white/10')
            }
          >
            변경만 보기
          </button>
          <button
            onClick={showYaml}
            className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] text-gray-400 hover:bg-white/10"
          >
            <FileCode size={12} /> YAML 전문
          </button>
        </div>
      )}

      {/* 표 */}
      <div className="min-h-0 flex-1 overflow-auto px-4 py-2">
        {!detail ? (
          <p className="text-[12px] text-gray-500">
            {connected
              ? '네임스페이스와 ConfigMap 을 고르면 키-값이 표로 나옵니다.'
              : 'SSH 연결 후 사용할 수 있습니다. (kubectl 이 있는 서버여야 합니다)'}
          </p>
        ) : yamlOpen ? (
          <>
            <div className="mb-1.5 flex items-center gap-2">
              <span className="text-[11px] text-gray-400">YAML 전문 — 읽기 전용</span>
              <button
                onClick={() => setYamlOpen(false)}
                className="rounded px-1.5 py-0.5 text-[11px] text-gray-400 hover:bg-white/10"
              >
                표로 돌아가기
              </button>
            </div>
            <pre
              style={mono}
              className="whitespace-pre rounded-md bg-[#11111b] p-3 font-mono leading-relaxed text-gray-300"
            >
              {yaml || '불러오는 중…'}
            </pre>
          </>
        ) : (
          <div className="font-mono" style={mono}>
            {detail.binaryKeys.length > 0 && (
              <p className="mb-2 rounded bg-white/[0.04] px-2 py-1 text-[11px] text-gray-400">
                binaryData 키 {detail.binaryKeys.length}개는 이 화면에서 수정할 수 없습니다 —{' '}
                {detail.binaryKeys.join(', ')}
              </p>
            )}
            {rows.map((k) => {
              const changed = pending[k] !== undefined
              const editing = editKey === k
              return (
                <div
                  key={k}
                  className={
                    'flex items-center gap-2 px-2 py-1.5 ' +
                    (changed
                      ? 'border-l-2 border-emerald-400 bg-emerald-500/10'
                      : editing
                        ? 'border-l-2 border-blue-400 bg-blue-500/10'
                        : 'border-b border-white/5')
                  }
                >
                  <span className="w-[240px] shrink-0 truncate text-emerald-200/90" title={k}>
                    {k}
                  </span>
                  {editing ? (
                    <>
                      <input
                        ref={editRef}
                        value={editVal}
                        onChange={(e) => setEditVal(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') commitEdit()
                          if (e.key === 'Escape') setEditKey(null)
                        }}
                        className="min-w-0 flex-1 rounded border border-blue-500/60 bg-[#11111b] px-2 py-0.5 text-gray-100 outline-none"
                      />
                      <span className="shrink-0 whitespace-nowrap text-[10.5px] text-gray-500">
                        Enter 확정 · Esc 취소
                      </span>
                      <button onClick={commitEdit} className="shrink-0 rounded p-0.5 text-emerald-300 hover:bg-white/10">
                        <Check size={13} />
                      </button>
                    </>
                  ) : (
                    <>
                      {changed && (
                        <span className="shrink-0 text-gray-500 line-through" title={detail.data[k]}>
                          {hidden(k) ? maskedValue() : detail.data[k]}
                        </span>
                      )}
                      <span
                        className={'min-w-0 flex-1 truncate ' + (changed ? 'text-emerald-200' : 'text-gray-100')}
                        title={hidden(k) ? '값이 가려져 있습니다' : valueOf(k)}
                      >
                        {hidden(k) ? maskedValue() : valueOf(k)}
                      </span>
                      {isSecretKey(k) && maskOn && (
                        <button
                          onClick={() =>
                            setRevealed((s) => {
                              const n = new Set(s)
                              if (n.has(k)) n.delete(k)
                              else n.add(k)
                              return n
                            })
                          }
                          title="이 값만 잠깐 보기"
                          className="shrink-0 rounded p-0.5 text-gray-500 hover:bg-white/10 hover:text-gray-300"
                        >
                          {revealed.has(k) ? <EyeOff size={12} /> : <Eye size={12} />}
                        </button>
                      )}
                      {changed ? (
                        <button
                          onClick={() => revert(k)}
                          title="이 변경만 되돌리기"
                          className="shrink-0 rounded p-0.5 text-gray-400 hover:bg-white/10 hover:text-gray-200"
                        >
                          <RotateCcw size={13} />
                        </button>
                      ) : (
                        <button
                          onClick={() => startEdit(k)}
                          title="값 수정"
                          className="shrink-0 rounded p-0.5 text-gray-500 hover:bg-white/10 hover:text-gray-200"
                        >
                          <Pencil size={13} />
                        </button>
                      )}
                    </>
                  )}
                </div>
              )
            })}
            {rows.length === 0 && <p className="text-[12px] text-gray-500">검색 결과가 없습니다.</p>}
          </div>
        )}
      </div>

      {/* 상태줄 */}
      <div className="flex items-center gap-2 border-t border-white/10 px-4 py-2">
        <span className="min-w-0 flex-1 truncate text-[11px] text-gray-400" title={msg}>
          {dirty ? '적용 전까지 클러스터에 아무것도 보내지 않습니다' : msg}
        </span>
        <button
          onClick={() => loadBackups(detail ? 'one' : 'all')}
          className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md border border-white/10 bg-panel-light px-2 py-1 text-[11px] text-gray-200 hover:bg-white/10"
        >
          <History size={12} /> 백업 이력
        </button>
        {detail && (
          <span className="shrink-0 font-mono text-[10.5px] text-gray-600">rv {detail.resourceVersion}</span>
        )}
      </div>

      {/* 대상을 바꾸기 전 확인 — 대기 중인 변경을 조용히 버리지 않는다 */}
      {navTo && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-8">
          <div className="w-full max-w-sm rounded-lg border border-white/10 bg-panel p-4 shadow-2xl">
            <div className="mb-2 text-sm font-semibold text-gray-100">적용하지 않은 변경이 있습니다</div>
            <p className="text-[12px] leading-relaxed text-gray-300">
              대기 중인 변경 <b className="text-emerald-300">{pendingKeys.length}건</b>이 아직 적용되지 않았습니다.
              {navTo.kind === 'ns' ? ' 네임스페이스' : ' ConfigMap'}을 바꾸면 그 변경은 사라집니다.
            </p>
            <div className="mt-3 flex justify-end gap-2">
              <button
                onClick={() => setNavTo(null)}
                className="rounded-md border border-white/10 bg-panel-light px-3 py-1.5 text-xs text-gray-200 hover:bg-white/10"
              >
                취소 (여기 머무르기)
              </button>
              <button
                onClick={() => {
                  const t = navTo
                  setNavTo(null)
                  doNav(t.kind, t.value, t.ns)
                }}
                className="rounded-md bg-blue-600 px-3 py-1.5 text-xs text-white hover:bg-blue-500"
              >
                변경 버리고 이동
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 백업 이력 */}
      {backups && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-8">
          <div className="flex max-h-[70vh] w-full max-w-3xl flex-col rounded-lg border border-white/10 bg-panel p-4 shadow-2xl">
            <div className="mb-1 flex items-center gap-2">
              <History size={15} className="shrink-0 text-blue-400" />
              <span className="shrink-0 text-sm font-semibold text-gray-100">백업 이력</span>
              {/* 범위 전환 — '이 ConfigMap만' 은 지금 보던 것의 이력, '전체' 는 최근에 무엇을 바꿨는지 */}
              <div className="flex shrink-0 items-center gap-0.5 rounded-md bg-black/30 p-0.5">
                {(['one', 'all'] as const).map((sc) => (
                  <button
                    key={sc}
                    onClick={() => loadBackups(sc)}
                    disabled={sc === 'one' && !detail}
                    className={
                      'whitespace-nowrap rounded px-2.5 py-0.5 text-[11px] disabled:opacity-40 ' +
                      (bkScope === sc ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-gray-200')
                    }
                  >
                    {sc === 'one' ? '이 ConfigMap만' : '전체'}
                  </button>
                ))}
              </div>
              {bkScope === 'one' && detail && (
                <span className="min-w-0 truncate font-mono text-[12px] text-emerald-200/90">
                  {detail.namespace} / {detail.name}
                </span>
              )}
              <span className="ml-auto shrink-0 whitespace-nowrap text-[11px] text-gray-500">
                {bkScope === 'all' && bkCms !== null ? `ConfigMap ${bkCms}개 · ` : ''}
                {backups.length}건
              </span>
            </div>
            <p className="mb-1.5 text-[10.5px] leading-relaxed text-gray-400">
              적용 직전 YAML 전문을 <b className="text-gray-300">내 PC</b>에 암호화해 남깁니다(그 서버가 아닙니다).
              ConfigMap 당 최근 20개까지 보관하며, <b className="text-gray-300">환경(서버·컨텍스트)별로 따로</b> 셉니다.
            </p>
            {/* 무엇과 비교해 '다른 환경'이라고 하는지 밝힌다 — 기준이 안 보이면 경고를 믿을 수 없다 */}
            <p className="mb-2.5 flex items-center gap-1.5 text-[10.5px] text-gray-500">
              <Server size={10} className="shrink-0" />
              지금 세션:
              <span className="text-gray-300">{envName(env ?? undefined) || '(확인 불가)'}</span>
              {env?.context && <span className="font-mono text-gray-400">ctx {env.context}</span>}
            </p>
            <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto">
              {backups.length === 0 ? (
                <p className="text-[12px] text-gray-500">
                  {bkScope === 'all'
                    ? '아직 백업이 없습니다 (적용을 한 번도 하지 않았습니다).'
                    : '이 ConfigMap 에는 아직 백업이 없습니다.'}
                </p>
              ) : (
                backups.map((b) => {
                  const isOpen = detail?.namespace === b.namespace && detail?.name === b.name
                  const foreign = !sameEnv(b.origin)
                  return (
                    <div
                      key={`${b.dir}/${b.file}`}
                      className={
                        'px-2 py-1.5 ' +
                        (isOpen && bkScope === 'all'
                          ? 'border-l-2 border-blue-400 bg-blue-500/10'
                          : 'border-b border-white/5')
                      }
                    >
                    <div className="flex items-center gap-2">
                      <span className="shrink-0 whitespace-nowrap text-[12px] text-gray-200">
                        {new Date(b.at).toLocaleString()}
                      </span>
                      <span
                        className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-gray-400"
                        title={`${b.namespace} / ${b.name}`}
                      >
                        {b.namespace}/{b.name}
                      </span>
                      {isOpen && bkScope === 'all' && (
                        <span className="shrink-0 whitespace-nowrap rounded bg-blue-600/80 px-1.5 py-0.5 text-[10px] text-white">
                          지금 열림
                        </span>
                      )}
                      <span className="shrink-0 whitespace-nowrap text-[11px] text-gray-500">
                        {(b.sizeBytes / 1024).toFixed(1)}KB
                      </span>
                      {!isOpen && (
                        <button
                          onClick={() => {
                            setBackups(null)
                            // 대기 중인 변경이 있으면 requestNav 가 먼저 물어본다
                            requestNav('target', b.name, b.namespace)
                          }}
                          title="이 ConfigMap 을 열어서 지금 값과 비교하기"
                          className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded border border-white/10 px-2 py-0.5 text-[11px] text-gray-200 hover:bg-white/10"
                        >
                          <ExternalLink size={11} /> 열기
                        </button>
                      )}
                      <button
                        onClick={async () => {
                          const r = await window.electronAPI.k8sCmBackupExport(b.dir, b.file, b.name)
                          if (r.error) setMsg(r.error)
                          else if (r.saved) setMsg(`내보냈습니다: ${r.path}`)
                        }}
                        title={
                          foreign
                            ? '지금 접속한 환경과 다른 클러스터의 백업입니다 — apply 대상을 확인하세요'
                            : '평문 YAML 로 저장 (kubectl apply -f 로 되돌릴 때 사용)'
                        }
                        className={
                          'flex shrink-0 items-center gap-1 whitespace-nowrap rounded border px-2 py-0.5 text-[11px] hover:bg-white/10 ' +
                          (foreign ? 'border-amber-500/50 text-amber-200' : 'border-white/10 text-gray-200')
                        }
                      >
                        <Download size={11} /> YAML 내보내기
                      </button>
                    </div>
                    {/*
                      어느 환경에서 만든 백업인가. 같은 이름의 ConfigMap 이 환경마다 있어서, 이게
                      없으면 이력에서 개발/운영이 구분되지 않고 내보내 apply 할 때 잘못된 것을 고른다.
                      v2.6.0 이전 백업에는 기록이 없다 — 그 사실을 감추지 않고 그대로 밝힌다.
                    */}
                    <div className="mt-0.5 flex items-center gap-1.5 pl-0.5 text-[10.5px]">
                      {b.origin && (b.origin.host || b.origin.context || b.origin.alias) ? (
                        <>
                          <Server size={10} className="shrink-0 text-gray-500" />
                          <span className="min-w-0 max-w-[45%] truncate text-gray-300" title={b.origin.host}>
                            {envName(b.origin)}
                          </span>
                          {b.origin.context && (
                            <span
                              className="min-w-0 truncate rounded bg-white/5 px-1.5 font-mono text-[10px] text-gray-400"
                              title={`kubectl context: ${b.origin.context}`}
                            >
                              ctx {b.origin.context}
                            </span>
                          )}
                          {foreign && (
                            <span className="flex shrink-0 items-center gap-1 whitespace-nowrap text-amber-300">
                              <AlertTriangle size={10} /> 지금 세션과 다른 환경
                            </span>
                          )}
                        </>
                      ) : (
                        <span className="text-gray-600" title="v2.6.0 이전에 만든 백업입니다 — 그때는 환경을 기록하지 않았습니다">
                          환경 미기록
                        </span>
                      )}
                    </div>
                    </div>
                  )
                })
              )}
            </div>
            <div className="mt-3 flex items-center gap-2 border-t border-white/10 pt-2.5">
              <span className="min-w-0 flex-1 text-[10.5px] text-gray-500">
                되돌리려면 내보낸 뒤 <span className="font-mono">kubectl apply -f</span>
              </span>
              <button
                onClick={() => setBackups(null)}
                className="shrink-0 rounded-md bg-blue-600 px-3 py-1.5 text-xs text-white hover:bg-blue-500"
              >
                닫기
              </button>
            </div>
          </div>
        </div>
      )}
      {/* 적용 확인 — 무엇이 나가는지 전부 보여준다 */}
      {confirmOpen && detail && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-8">
          <div className="flex max-h-[80vh] w-full max-w-2xl flex-col rounded-lg border border-white/10 bg-panel p-4 shadow-2xl">
            <div className="mb-0.5 text-sm font-semibold text-gray-100">
              {pendingKeys.length}건을 한 번에 적용합니다
            </div>
            <p className="mb-3 text-[11px] text-gray-400">
              {detail.namespace} / {detail.name} · 나머지{' '}
              {Object.keys(detail.data).length - pendingKeys.length}개 키는 요청에 포함되지 않습니다
            </p>

            <div className="mb-2.5 max-h-48 space-y-0.5 overflow-y-auto rounded bg-black/30 p-2 font-mono text-[11.5px]">
              {pendingKeys.map((k) => (
                <div key={k} className="flex items-center gap-2">
                  <span className="w-[220px] shrink-0 truncate text-emerald-200/90">{k}</span>
                  <span className="shrink-0 text-gray-500 line-through">
                    {isSecretKey(k) ? maskedValue() : detail.data[k]}
                  </span>
                  <span className="shrink-0 text-emerald-400">→</span>
                  <span className="min-w-0 flex-1 truncate text-emerald-200">
                    {isSecretKey(k) ? maskedValue() : pending[k]}
                  </span>
                </div>
              ))}
            </div>

            <div className="mb-2.5 rounded bg-black/40 px-2.5 py-2">
              <div className="mb-1 text-[10.5px] text-gray-500">실행될 명령 — 한 번만 나갑니다</div>
              <code className="block break-all font-mono text-[11px] leading-relaxed text-green-300/85">
                {`kubectl patch cm ${detail.name} -n ${detail.namespace} --type merge -p '${JSON.stringify({
                  data: Object.fromEntries(pendingKeys.map((k) => [k, isSecretKey(k) ? '••••' : pending[k]])),
                })}'`}
              </code>
            </div>

            <div className="mb-3 flex items-start gap-1.5 rounded border border-amber-500/40 bg-amber-500/10 px-2.5 py-2 text-[11px] leading-relaxed text-amber-200">
              <AlertTriangle size={12} className="mt-0.5 shrink-0" />
              <span>
                변경 전 YAML 전문을 <b>내 PC</b>에 암호화해 먼저 남깁니다 — 백업이 실패하면 적용하지 않습니다. 불러온
                뒤 이 ConfigMap 이 바뀌었으면(resourceVersion {detail.resourceVersion}) 적용하지 않고 알려드립니다.
              </span>
            </div>

            <div className="flex justify-end gap-2">
              <button
                onClick={() => setConfirmOpen(false)}
                className="rounded-md border border-white/10 bg-panel-light px-3 py-1.5 text-xs text-gray-200 hover:bg-white/10"
              >
                취소
              </button>
              <button
                onClick={apply}
                disabled={applying}
                className="flex items-center gap-1 rounded-md bg-blue-600 px-3 py-1.5 text-xs text-white hover:bg-blue-500 disabled:opacity-50"
              >
                {applying && <Loader2 size={12} className="animate-spin" />}
                {pendingKeys.length}건 적용
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
