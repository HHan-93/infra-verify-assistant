import { useEffect, useMemo, useState } from 'react'
import { X, Search, RefreshCw, Loader2, ArrowUpDown } from 'lucide-react'

interface ProcInfo {
  pid: number
  name: string
  cpu: number
  mem: number
  command: string
}

interface ProcessListModalProps {
  sessionId: string
  onClose: () => void
}

type SortKey = 'pid' | 'name' | 'cpu' | 'mem'

const COLUMNS: { key: SortKey; label: string; align: 'left' | 'right' }[] = [
  { key: 'pid', label: 'PID', align: 'left' },
  { key: 'name', label: '이름', align: 'left' },
  { key: 'cpu', label: 'CPU%', align: 'right' },
  { key: 'mem', label: 'MEM%', align: 'right' },
]

/**
 * htop 스타일 전체 프로세스 뷰 — Dashboard 의 "상위 프로세스(top-5/10)" 상시 폴링과 별개로,
 * 이 모달을 열 때만 `ps` 전체를 온디맨드로 한 번 더 조회한다(상시 오버헤드 증가 방지).
 */
export default function ProcessListModal({ sessionId, onClose }: ProcessListModalProps) {
  const [procs, setProcs] = useState<ProcInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [sortKey, setSortKey] = useState<SortKey>('cpu')
  const [sortDesc, setSortDesc] = useState(true)
  const [killingPids, setKillingPids] = useState<Set<number>>(new Set())

  const load = async () => {
    setLoading(true)
    setError('')
    const r = await window.electronAPI.monitorListProcesses(sessionId)
    setLoading(false)
    if (r.ok) setProcs(r.procs ?? [])
    else setError(r.error || '프로세스 목록을 불러오지 못했습니다.')
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) setSortDesc((v) => !v)
    else {
      setSortKey(key)
      setSortDesc(true)
    }
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = q
      ? procs.filter(
          (p) =>
            p.name.toLowerCase().includes(q) ||
            p.command.toLowerCase().includes(q) ||
            String(p.pid).includes(q),
        )
      : procs
    const sorted = [...list].sort((a, b) => {
      const av = a[sortKey]
      const bv = b[sortKey]
      const cmp = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv))
      return sortDesc ? -cmp : cmp
    })
    return sorted
  }, [procs, query, sortKey, sortDesc])

  const killProc = async (pid: number) => {
    setKillingPids((prev) => new Set(prev).add(pid))
    await window.electronAPI.monitorKillProc(sessionId, pid)
    setKillingPids((prev) => {
      const s = new Set(prev)
      s.delete(pid)
      return s
    })
    load()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-8" onClick={onClose}>
      <div
        className="flex h-[75vh] w-[720px] max-w-[94vw] flex-col overflow-hidden rounded-lg border border-white/10 bg-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-white/10 px-4 py-2.5">
          <span className="text-sm font-semibold text-gray-100">전체 프로세스</span>
          <span className="text-[11px] text-gray-500">{filtered.length}/{procs.length}개</span>
          <div className="relative ml-3 flex-1">
            <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-500" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="이름, PID, 명령행 검색..."
              className="w-full rounded-md border border-white/10 bg-panel-light py-1 pl-7 pr-2 text-xs text-gray-200 outline-none placeholder:text-gray-600 focus:ring-1 focus:ring-blue-500"
            />
          </div>
          <button
            onClick={load}
            disabled={loading}
            title="새로고침"
            className="rounded p-1 text-gray-400 hover:bg-white/10 hover:text-gray-200 disabled:opacity-40"
          >
            {loading ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
          </button>
          <button onClick={onClose} className="rounded p-1 text-gray-400 hover:bg-white/10 hover:text-gray-200">
            <X size={16} />
          </button>
        </div>

        {error && <div className="bg-red-500/10 px-4 py-1 text-[11px] text-red-300">{error}</div>}

        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-panel text-gray-500">
              <tr>
                {COLUMNS.map((c) => (
                  <th
                    key={c.key}
                    onClick={() => toggleSort(c.key)}
                    className={
                      'cursor-pointer select-none px-2 py-1.5 font-medium hover:text-gray-300 ' +
                      (c.align === 'right' ? 'text-right' : 'text-left')
                    }
                  >
                    <span className="inline-flex items-center gap-0.5">
                      {c.label}
                      {sortKey === c.key ? (
                        <ArrowUpDown size={10} className={sortDesc ? '' : 'rotate-180'} />
                      ) : (
                        <ArrowUpDown size={10} className="opacity-20" />
                      )}
                    </span>
                  </th>
                ))}
                <th className="px-2 py-1.5 text-left font-medium">명령행</th>
                <th className="w-8" />
              </tr>
            </thead>
            <tbody>
              {!loading && filtered.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-6 text-center text-gray-500">
                    {procs.length === 0 ? '데이터 없음' : '일치하는 프로세스가 없습니다.'}
                  </td>
                </tr>
              )}
              {filtered.map((p) => (
                <tr key={p.pid} className="group border-t border-white/5 hover:bg-white/5">
                  <td className="px-2 py-1 text-gray-400">{p.pid}</td>
                  <td className="max-w-[140px] truncate px-2 py-1">{p.name}</td>
                  <td className="px-2 py-1 text-right">{p.cpu}</td>
                  <td className="px-2 py-1 text-right">{p.mem}</td>
                  <td className="max-w-[240px] truncate px-2 py-1 font-mono text-[10px] text-gray-500" title={p.command}>
                    {p.command}
                  </td>
                  <td className="px-2 py-1 text-right">
                    <button
                      onClick={() => killProc(p.pid)}
                      disabled={killingPids.has(p.pid)}
                      title={`PID ${p.pid} (${p.name}) 프로세스 종료`}
                      className="rounded p-0.5 text-gray-600 opacity-0 transition-opacity hover:bg-rose-500/20 hover:text-rose-400 group-hover:opacity-100 disabled:opacity-30"
                    >
                      {killingPids.has(p.pid) ? <Loader2 size={11} className="animate-spin" /> : <X size={11} />}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
