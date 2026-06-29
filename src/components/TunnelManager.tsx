import { useCallback, useEffect, useState } from 'react'
import { Network, Plus, Trash2, X, ArrowRight, Loader2 } from 'lucide-react'
import type { ForwardView } from '../../electron/preload'

interface TunnelManagerProps {
  sessionId: string
  connected: boolean
  onClose: () => void
}

type FwType = 'local' | 'remote'

/**
 * 포트 포워딩(터널) 관리 모달.
 *  - 로컬 포워딩: 로컬 포트로 들어온 연결을 원격 목적지로 (원격 서비스를 localhost 로 접근)
 *  - 원격 포워딩: 원격 포트로 들어온 연결을 로컬 목적지로
 */
export default function TunnelManager({ sessionId, connected, onClose }: TunnelManagerProps) {
  const [forwards, setForwards] = useState<ForwardView[]>([])
  const [type, setType] = useState<FwType>('local')
  const [localHost, setLocalHost] = useState('127.0.0.1')
  const [localPort, setLocalPort] = useState('')
  const [remoteHost, setRemoteHost] = useState('127.0.0.1')
  const [remotePort, setRemotePort] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    const r = await window.electronAPI.tunnelList(sessionId)
    if (r.ok) setForwards(r.forwards ?? [])
  }, [sessionId])

  useEffect(() => {
    if (connected) refresh()
  }, [connected, refresh])

  const add = async () => {
    setError('')
    const lp = Number(localPort)
    const rp = Number(remotePort)
    if (!rp || (type === 'local' && !lp) || (type === 'remote' && !rp)) {
      setError('포트를 올바르게 입력하세요.')
      return
    }
    setBusy(true)
    const r = await window.electronAPI.tunnelAdd({
      sessionId,
      type,
      localHost: localHost.trim() || '127.0.0.1',
      localPort: lp,
      remoteHost: remoteHost.trim() || '127.0.0.1',
      remotePort: rp,
    })
    setBusy(false)
    if (r.ok) {
      setLocalPort('')
      setRemotePort('')
      refresh()
    } else {
      setError(r.error || '터널 생성 실패')
    }
  }

  const remove = async (id: string) => {
    await window.electronAPI.tunnelRemove(sessionId, id)
    refresh()
  }

  const inputCls =
    'rounded-md border border-white/10 bg-panel-light px-2 py-1 text-sm text-gray-100 ' +
    'placeholder:text-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-500'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-8" onClick={onClose}>
      <div
        className="flex max-h-[80vh] w-[720px] max-w-[94vw] flex-col overflow-hidden rounded-lg border border-white/10 bg-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-white/10 px-4 py-2.5">
          <Network size={16} className="text-blue-400" />
          <span className="text-sm font-semibold text-gray-100">포트 포워딩 (터널)</span>
          <button
            onClick={onClose}
            className="ml-auto rounded p-1 text-gray-400 hover:bg-white/10 hover:text-gray-200"
          >
            <X size={16} />
          </button>
        </div>

        {!connected ? (
          <div className="flex flex-1 items-center justify-center py-10 text-sm text-gray-500">
            세션에 SSH 연결 후 사용할 수 있습니다.
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            {/* 추가 폼 */}
            <div className="space-y-3 border-b border-white/10 p-4">
              <div className="flex gap-4 text-xs text-gray-300">
                <label className="flex items-center gap-1.5">
                  <input type="radio" checked={type === 'local'} onChange={() => setType('local')} />
                  로컬 포워딩 <span className="text-gray-500">(원격 서비스를 localhost로)</span>
                </label>
                <label className="flex items-center gap-1.5">
                  <input type="radio" checked={type === 'remote'} onChange={() => setType('remote')} />
                  원격 포워딩
                </label>
              </div>

              {/* 출발(위) → 도착(아래) */}
              <div className="space-y-2">
                <div>
                  <label className="mb-1 block text-[11px] text-gray-400">
                    {type === 'local' ? '로컬 바인드 (내 PC에서 열 주소)' : '로컬 목적지 (내 PC 서비스)'}
                  </label>
                  <div className="flex gap-2">
                    <input
                      className={inputCls + ' min-w-0 flex-1'}
                      placeholder="127.0.0.1"
                      value={localHost}
                      onChange={(e) => setLocalHost(e.target.value)}
                    />
                    <input
                      className={inputCls + ' w-24 shrink-0'}
                      placeholder="포트"
                      value={localPort}
                      onChange={(e) => setLocalPort(e.target.value)}
                    />
                  </div>
                </div>

                <div className="flex items-center gap-1 pl-0.5 text-[10px] text-gray-500">
                  <ArrowRight size={13} className="rotate-90" /> 위 주소로 들어온 연결을 아래로 전달
                </div>

                <div>
                  <label className="mb-1 block text-[11px] text-gray-400">
                    {type === 'local' ? '원격 목적지 (서버에서 접근할 주소)' : '원격 바인드 (서버에서 열 주소)'}
                  </label>
                  <div className="flex gap-2">
                    <input
                      className={inputCls + ' min-w-0 flex-1'}
                      placeholder={type === 'local' ? 'localhost / 서비스IP' : '0.0.0.0'}
                      value={remoteHost}
                      onChange={(e) => setRemoteHost(e.target.value)}
                    />
                    <input
                      className={inputCls + ' w-24 shrink-0'}
                      placeholder="포트"
                      value={remotePort}
                      onChange={(e) => setRemotePort(e.target.value)}
                    />
                  </div>
                </div>
              </div>

              {error && <div className="text-[11px] text-red-300">{error}</div>}

              <button
                onClick={add}
                disabled={busy}
                className="flex w-full items-center justify-center gap-1.5 rounded-md bg-blue-600 py-1.5 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50"
              >
                {busy ? <Loader2 size={13} className="animate-spin" /> : <Plus size={14} />} 터널 추가
              </button>

              <div className="rounded-md bg-white/5 px-2.5 py-1.5 text-[10px] leading-relaxed text-gray-500">
                {type === 'local'
                  ? '예) 로컬 8080 ↦ 원격 127.0.0.1:80 → 브라우저에서 localhost:8080 으로 원격 웹 접근'
                  : '예) 원격 9000 ↦ 로컬 127.0.0.1:3000 → 원격에서 localhost:9000 으로 내 PC 서비스 접근'}
              </div>
            </div>

            {/* 활성 목록 */}
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {forwards.length === 0 ? (
                <div className="px-2 py-6 text-center text-xs text-gray-500">활성 터널이 없습니다.</div>
              ) : (
                <ul className="space-y-1">
                  {forwards.map((f) => (
                    <li
                      key={f.id}
                      className="flex items-center gap-2 rounded-md border border-white/10 bg-panel-light px-2.5 py-1.5"
                    >
                      <span
                        className={
                          'rounded px-1.5 py-0.5 text-[10px] ' +
                          (f.type === 'local' ? 'bg-blue-500/20 text-blue-200' : 'bg-amber-500/20 text-amber-200')
                        }
                      >
                        {f.type === 'local' ? '로컬' : '원격'}
                      </span>
                      <span className="flex-1 truncate font-mono text-[12px] text-gray-200">
                        {f.type === 'local'
                          ? `${f.localHost}:${f.localPort}  ↦  ${f.remoteHost}:${f.remotePort}`
                          : `원격:${f.remotePort}  ↦  ${f.localHost}:${f.localPort}`}
                      </span>
                      <button
                        onClick={() => remove(f.id)}
                        title="터널 제거"
                        className="rounded p-1 text-gray-500 hover:bg-white/10 hover:text-red-300"
                      >
                        <Trash2 size={13} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
