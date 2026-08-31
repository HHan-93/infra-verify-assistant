import { useEffect, useMemo, useRef, useState } from 'react'
import {
  X,
  CheckSquare,
  Search,
  Trash2,
  Play,
  Pause,
  RotateCcw,
  FileText,
  Clapperboard,
  ChevronUp,
  ChevronDown,
  Settings,
  Download,
} from 'lucide-react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { LogEntryDetail, LogIndexEntry, LogRetentionSettings } from '../../electron/shared-types'
import ConfirmDialog from './ConfirmDialog'
import { renderLogLine } from '../lib/logDisplay'

interface LogViewerProps {
  onClose: () => void
}

type Mode = 'text' | 'replay'

function fmtDate(ms: number): string {
  const d = new Date(ms)
  return d.toLocaleString('ko-KR', { hour12: false })
}
function fmtDuration(startMs: number, endMs?: number): string {
  const sec = Math.max(0, Math.round(((endMs ?? Date.now()) - startMs) / 1000))
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  return h > 0 ? `${h}시간 ${m}분` : m > 0 ? `${m}분 ${s}초` : `${s}초`
}
function fmtSize(bytes?: number): string {
  if (bytes === undefined) return '크기 모름'
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}
const p2 = (n: number) => String(n).padStart(2, '0')
/**
 * 목록용 시각 — 오늘/어제는 그렇게 부른다.
 * `2026. 8. 7. 14시 23분 14초` 는 한 줄을 다 먹으면서도 "언제쯤인지" 가 바로 안 온다.
 * 정확한 값이 필요할 때를 위해 툴팁에는 전체 시각(fmtDate)을 그대로 남긴다.
 */
function fmtRelDate(ms: number): string {
  const d = new Date(ms)
  const now = new Date()
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  const y = new Date(now)
  y.setDate(now.getDate() - 1)
  const hm = `${p2(d.getHours())}:${p2(d.getMinutes())}`
  if (sameDay(d, now)) return `오늘 ${hm}`
  if (sameDay(d, y)) return `어제 ${hm}`
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}.${d.getDate()} ${hm}`
  return `${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()} ${hm}`
}
/** 재생 위치 표시 — 0:07 / 1:04 */
function fmtClock(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(sec / 60)}:${p2(sec % 60)}`
}
function daysLeft(startedAt: number, retentionDays: number): number {
  const ageMs = Date.now() - startedAt
  return Math.ceil(retentionDays - ageMs / (24 * 60 * 60 * 1000))
}

const SPEEDS = [1, 2, 4, 8] as const

export default function LogViewer({ onClose }: LogViewerProps) {
  const [entries, setEntries] = useState<LogIndexEntry[]>([])
  /** 파일에서 직접 확인한 것들(실제 크기·리플레이 가능 여부·첫 명령어) — 인덱스에는 없다 */
  const [details, setDetails] = useState<Record<string, LogEntryDetail>>({})
  /** 여러 개를 정리할 때만 켜는 모드. 평소에는 체크박스를 띄우지 않는다(한 개 고르는 게 기본이므로) */
  const [selectMode, setSelectMode] = useState(false)
  const [selection, setSelection] = useState<Set<string>>(new Set())
  const [confirmBulk, setConfirmBulk] = useState(false)
  const [listQuery, setListQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [mode, setMode] = useState<Mode>('text')
  const [confirmDeleteEntry, setConfirmDeleteEntry] = useState<LogIndexEntry | null>(null)
  const [retention, setRetention] = useState<LogRetentionSettings | null>(null)
  const [editingRetention, setEditingRetention] = useState(false)
  const [draftDays, setDraftDays] = useState('')
  const [draftEntries, setDraftEntries] = useState('')
  const [exporting, setExporting] = useState(false)
  const [exportNote, setExportNote] = useState<string | null>(null)
  const [savingRetention, setSavingRetention] = useState(false)

  const refresh = async () => {
    // 곁들이는 정보(첫 명령어·실제 크기)가 실패해도 목록은 떠야 한다 — 파일 하나 못 읽었다고
    // 뷰어가 빈 화면이 되면 정작 그 로그를 지우러 들어온 사람이 아무것도 못 한다.
    const [list, det] = await Promise.all([
      window.electronAPI.logsList(),
      window.electronAPI.logsDetails().catch(() => [] as LogEntryDetail[]),
    ])
    setEntries(list)
    setDetails(Object.fromEntries(det.map((d) => [d.id, d])))
  }

  useEffect(() => {
    void refresh()
    window.electronAPI.logsGetRetentionSettings().then(setRetention)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const saveRetention = async () => {
    const retentionDays = Number(draftDays)
    const maxEntries = Number(draftEntries)
    if (!Number.isFinite(retentionDays) || retentionDays < 1 || !Number.isFinite(maxEntries) || maxEntries < 1) return
    setSavingRetention(true)
    try {
      const saved = await window.electronAPI.logsSetRetentionSettings({ retentionDays, maxEntries })
      setRetention(saved)
      setEntries(await window.electronAPI.logsList())
      setEditingRetention(false)
    } finally {
      setSavingRetention(false)
    }
  }

  const filtered = useMemo(() => {
    const q = listQuery.trim().toLowerCase()
    if (!q) return entries
    return entries.filter(
      (e) =>
        e.host.toLowerCase().includes(q) ||
        (e.label ?? '').toLowerCase().includes(q) ||
        (details[e.id]?.firstCommand ?? '').toLowerCase().includes(q),
    )
  }, [entries, listQuery, details])

  const selected = entries.find((e) => e.id === selectedId) ?? null

  const deleteEntry = async (e: LogIndexEntry) => {
    await window.electronAPI.logsDelete(e.id)
    await refresh()
    if (selectedId === e.id) setSelectedId(null)
  }
  /** 선택한 것들을 지운다 — 하나씩 지우면 확인 창을 N번 넘겨야 한다 */
  const deleteSelected = async () => {
    const ids = [...selection]
    for (const id of ids) await window.electronAPI.logsDelete(id)
    await refresh()
    if (selectedId && ids.includes(selectedId)) setSelectedId(null)
    setSelection(new Set())
    setSelectMode(false)
  }
  const toggleSelect = (id: string) =>
    setSelection((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  // 요약(선택 전 화면) — 목록을 열자마자 "무엇이 얼마나 있는가" 는 답해 준다
  const summary = useMemo(() => {
    const det = entries.map((e) => details[e.id]).filter(Boolean) as LogEntryDetail[]
    return {
      total: entries.length,
      // 자동 정리가 지우는 것은 리플레이 기록 쪽이므로 둘 다 센다
      bytes: det.reduce((a, d) => a + (d.plainSize ?? 0) + (d.castSize ?? 0), 0),
      replayable: det.filter((d) => d.castExists).length,
      readable: det.filter((d) => d.plainExists).length,
      missing: det.filter((d) => !d.plainExists).length,
      oldest: entries.length ? Math.min(...entries.map((e) => e.startedAt)) : 0,
      newest: entries.length ? Math.max(...entries.map((e) => e.startedAt)) : 0,
    }
  }, [entries, details])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6">
      <div className="flex h-full max-h-[920px] w-[1600px] max-w-[97vw] overflow-hidden rounded-lg border border-white/10 bg-panel shadow-2xl">
        {/* 좌측: 로그 목록 */}
        <div className="flex w-64 shrink-0 flex-col border-r border-white/10">
          <div className="flex items-center gap-2 border-b border-white/10 px-2.5 py-1.5">
            <Search size={13} className="shrink-0 text-gray-500" />
            <input
              value={listQuery}
              onChange={(e) => setListQuery(e.target.value)}
              placeholder="호스트, 별칭 검색..."
              className="min-w-0 flex-1 bg-transparent text-[12px] text-gray-200 outline-none placeholder:text-gray-600"
            />
          </div>
          {/* 목록 머리 — 몇 개인지, 여러 개를 정리할지 */}
          <div className="flex items-center gap-2 border-b border-white/10 px-2.5 py-1 text-[10.5px] text-gray-500">
            <span className="min-w-0 flex-1 truncate">
              {listQuery.trim() ? `검색 결과 ${filtered.length}개` : `${entries.length}개`}
            </span>
            {/* 글자만 두었더니 버튼인 줄 몰랐다 — 테두리와 바탕을 줘서 누를 것임을 보인다 */}
            <button
              onClick={() => {
                setSelectMode((v) => !v)
                setSelection(new Set())
              }}
              title={selectMode ? '선택 모드를 끕니다' : '체크해서 여러 개를 한 번에 지웁니다'}
              className={
                'flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 ' +
                (selectMode
                  ? 'border-blue-500/50 bg-blue-600/30 text-blue-200'
                  : 'border-white/15 bg-panel-light text-gray-300 hover:border-white/25 hover:bg-white/10 hover:text-gray-100')
              }
            >
              {selectMode ? <X size={11} /> : <CheckSquare size={11} />}
              {selectMode ? '선택 끝' : '여러 개 정리'}
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-1.5">
            {filtered.length === 0 ? (
              <p className="py-6 text-center text-[12px] text-gray-500">
                {entries.length === 0 ? '기록된 세션 로그가 없습니다.' : '일치하는 로그가 없습니다.'}
              </p>
            ) : (
              <div className="space-y-1">
                {filtered.map((e) => {
                  const d = details[e.id]
                  // 보관 기간이 며칠 안 남았으면 목록에서 바로 밝힌다 — 좌하단 10px 회색 한 줄로는
                  // "곧 사라진다" 는 사실이 전달되지 않는다.
                  const left = retention && e.endedAt ? daysLeft(e.startedAt, retention.retentionDays) : null
                  const expiring = left !== null && left <= 3
                  // 배지는 색이 아니라 **말로** 구분한다. '원본 없음(노랑)' 과 '원본 없음(빨강)' 은
                  // 같은 글자라 색을 외우지 않으면 뜻이 안 오고, 무엇보다 사용자가 알고 싶은 것은
                  // 파일의 유무가 아니라 "이 줄로 무엇을 할 수 있는가" 다.
                  const avail = !d
                    ? null
                    : d.plainExists && d.castExists
                      ? null // 둘 다 됨 — 배지를 달 이유가 없다
                      : d.plainExists
                        ? { text: '텍스트만', cls: 'bg-white/10 text-gray-300', tip: '리플레이 기록이 없어 텍스트로만 볼 수 있습니다' }
                        : d.castExists
                          ? {
                              text: '리플레이만',
                              cls: 'bg-amber-500/15 text-amber-200/90',
                              tip: `원본 로그 파일이 그 자리에 없어 텍스트로는 못 봅니다 (리플레이는 가능)\n${e.path}`,
                            }
                          : { text: '내용 없음', cls: 'bg-red-500/15 text-red-300', tip: `원본 로그도 리플레이 기록도 없습니다\n${e.path}` }
                  return (
                    <div
                      key={e.id}
                      className={
                        'group flex w-full items-start gap-1.5 rounded-md px-2 py-1.5 transition ' +
                        (e.id === selectedId ? 'bg-blue-600/30' : 'hover:bg-white/5')
                      }
                    >
                      {selectMode && (
                        <input
                          type="checkbox"
                          checked={selection.has(e.id)}
                          onChange={() => toggleSelect(e.id)}
                          className="mt-1 shrink-0"
                        />
                      )}
                      <button
                        onClick={() => {
                          if (selectMode) {
                            toggleSelect(e.id)
                            return
                          }
                          setSelectedId(e.id)
                          // 평문이 없으면 텍스트 탭은 실패한다 — 볼 수 있는 쪽으로 연다
                          setMode(!d?.plainExists && d?.castExists ? 'replay' : 'text')
                        }}
                        className="flex min-w-0 flex-1 flex-col items-start gap-0.5 text-left"
                      >
                        <div className="flex w-full items-center gap-1">
                          <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-gray-100">
                            {e.label || e.host}
                          </span>
                          {expiring && (
                            <span
                              title={`보관 기간(${retention?.retentionDays}일)이 지나면 자동 삭제됩니다`}
                              className="shrink-0 rounded bg-amber-500/20 px-1 text-[9.5px] text-amber-200"
                            >
                              {left !== null && left <= 0 ? '삭제 대상' : `D-${left}`}
                            </span>
                          )}
                          {avail && (
                            <span
                              title={avail.tip}
                              className={'shrink-0 whitespace-nowrap rounded px-1 text-[9.5px] ' + avail.cls}
                            >
                              {avail.text}
                            </span>
                          )}
                          {/* 둘 다 되는 줄에만 붙는다 — 배지가 있는 줄에 또 달면 같은 말을 두 번 한다 */}
                          {!avail && d?.castExists && (
                            <Clapperboard size={11} className="shrink-0 text-gray-500" aria-label="리플레이 가능" />
                          )}
                        </div>
                        {/* 그때 무슨 작업이었나 — 목록에서 답하지 못하면 결국 하나씩 열어보게 된다 */}
                        {d?.firstCommand && (
                          <span className="w-full truncate font-mono text-[10px] text-gray-400" title={d.firstCommand}>
                            $ {d.firstCommand}
                          </span>
                        )}
                        {/* 성격이 다른 둘을 가운뎃점으로만 이어 놓으니 한 덩어리로 뭉개져 읽혔다.
                            **언제**는 왼쪽, **얼마나**는 오른쪽 끝으로 갈라 놓는다(줄바꿈 없이). */}
                        <span className="mt-0.5 flex w-full items-baseline gap-2 whitespace-nowrap text-[10.5px]">
                          <span className="min-w-0 truncate text-gray-400" title={fmtDate(e.startedAt)}>
                            {fmtRelDate(e.startedAt)}
                          </span>
                          {!e.endedAt && <span className="shrink-0 text-emerald-400">기록중</span>}
                          <span className="ml-auto shrink-0 tabular-nums text-gray-500">
                            {fmtDuration(e.startedAt, e.endedAt)}
                            <span className="px-1 text-gray-700">|</span>
                            {fmtSize(d?.plainSize ?? d?.castSize ?? e.sizeBytes)}
                          </span>
                        </span>
                      </button>
                      {!selectMode && (
                        <button
                          onClick={() => setConfirmDeleteEntry(e)}
                          title="이 로그 삭제"
                          className="mt-0.5 shrink-0 rounded p-0.5 text-gray-600 hover:bg-white/10 hover:text-red-300 group-hover:text-gray-400"
                        >
                          <Trash2 size={12} />
                        </button>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {/* 선택 모드 — 고른 것들을 한 번에 */}
          {selectMode && (
            <div className="flex items-center gap-1.5 border-t border-white/10 px-2.5 py-1.5 text-[10.5px]">
              <span className="min-w-0 flex-1 truncate text-gray-400">{selection.size}개 선택</span>
              <button
                onClick={() => setSelection(new Set(filtered.map((e) => e.id)))}
                className="shrink-0 rounded px-1.5 py-0.5 text-gray-400 hover:bg-white/10"
              >
                {listQuery.trim() ? '검색 결과 전체' : '모두'}
              </button>
              <button
                onClick={() => setSelection(new Set())}
                disabled={selection.size === 0}
                className="shrink-0 rounded px-1.5 py-0.5 text-gray-400 hover:bg-white/10 disabled:opacity-40"
              >
                해제
              </button>
              <button
                onClick={() => setConfirmBulk(true)}
                disabled={selection.size === 0}
                className="shrink-0 rounded bg-red-600/70 px-2 py-0.5 text-white hover:bg-red-500 disabled:opacity-40"
              >
                삭제
              </button>
            </div>
          )}

          {/* 하단: 보관 정책 안내 + 인라인 설정 */}
          <div className="border-t border-white/10 px-2.5 py-1.5 text-[10px] text-gray-500">
            {retention && (
              <div className="flex items-center gap-1">
                {/* 임박한 삭제는 목록의 D- 배지가 말한다 — 여기서는 기준만 한 줄로 */}
                <span className="min-w-0 flex-1 truncate" title="둘 중 하나라도 넘으면 오래된 것부터 자동 삭제됩니다">
                  최근 {retention.maxEntries}개 · {retention.retentionDays}일까지 보관
                </span>
                <button
                  onClick={() => {
                    setDraftDays(String(retention.retentionDays))
                    setDraftEntries(String(retention.maxEntries))
                    setEditingRetention((v) => !v)
                  }}
                  title="보관 정책 설정"
                  className="shrink-0 rounded p-0.5 text-gray-500 hover:bg-white/10 hover:text-gray-300"
                >
                  <Settings size={12} />
                </button>
              </div>
            )}
            {editingRetention && retention && (
              <div className="mt-1.5 flex flex-col gap-1.5 rounded-md bg-panel-light p-1.5">
                <label className="flex items-center justify-between gap-2">
                  <span>보관기간(일)</span>
                  <input
                    type="number"
                    min={1}
                    value={draftDays}
                    onChange={(e) => setDraftDays(e.target.value)}
                    className="w-16 rounded border border-white/10 bg-black/30 px-1.5 py-0.5 text-right text-[11px] text-gray-100 outline-none focus:border-blue-500 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                  />
                </label>
                <label className="flex items-center justify-between gap-2">
                  <span>최대 개수</span>
                  <input
                    type="number"
                    min={1}
                    value={draftEntries}
                    onChange={(e) => setDraftEntries(e.target.value)}
                    className="w-16 rounded border border-white/10 bg-black/30 px-1.5 py-0.5 text-right text-[11px] text-gray-100 outline-none focus:border-blue-500 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                  />
                </label>
                <div className="flex justify-end gap-1.5 pt-0.5">
                  <button
                    onClick={() => setEditingRetention(false)}
                    className="rounded px-2 py-0.5 text-gray-400 hover:bg-white/10"
                  >
                    취소
                  </button>
                  <button
                    onClick={saveRetention}
                    disabled={savingRetention}
                    className="rounded bg-blue-600/80 px-2 py-0.5 text-white hover:bg-blue-500 disabled:opacity-40"
                  >
                    저장
                  </button>
                </div>
                <p className="text-[9px] text-gray-600">
                  둘 중 하나라도 넘으면 자동 삭제됩니다 (기록 중인 세션 제외).
                </p>
              </div>
            )}
          </div>
        </div>

        {/* 우측: 상세 (텍스트 보기 / 리플레이) */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-2 border-b border-white/10 px-3 py-1.5">
            <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-gray-100">
              {selected ? selected.label || selected.host : '세션 로그'}
            </span>
            {selected && (
              <div className="flex shrink-0 items-center gap-1 rounded-md bg-panel-light p-0.5">
                <button
                  onClick={() => setMode('text')}
                  className={
                    'flex items-center gap-1 rounded px-2 py-1 text-[11px] ' +
                    (mode === 'text' ? 'bg-blue-600/70 text-white' : 'text-gray-300 hover:bg-white/10')
                  }
                >
                  <FileText size={12} />
                  텍스트
                </button>
                <button
                  onClick={() => setMode('replay')}
                  className={
                    'flex items-center gap-1 rounded px-2 py-1 text-[11px] ' +
                    (mode === 'replay' ? 'bg-blue-600/70 text-white' : 'text-gray-300 hover:bg-white/10')
                  }
                >
                  <Clapperboard size={12} />
                  리플레이
                </button>
              </div>
            )}
            {selected && (
              <button
                onClick={async () => {
                  if (exporting) return
                  setExporting(true)
                  try {
                    const r = await window.electronAPI.logsExport(selected.id)
                    if (r.saved) {
                      setExportNote('저장됨')
                      setTimeout(() => setExportNote((n) => (n === '저장됨' ? null : n)), 2000)
                    } else if (r.error) {
                      setExportNote('실패')
                      setTimeout(() => setExportNote((n) => (n === '실패' ? null : n)), 2500)
                    }
                  } finally {
                    setExporting(false)
                  }
                }}
                disabled={exporting}
                title="이 세션 로그 원본 전체를 파일로 저장"
                className="flex shrink-0 items-center gap-1 rounded bg-panel-light px-2 py-1 text-[11px] text-gray-300 hover:bg-white/10 disabled:opacity-40"
              >
                <Download size={12} />
                {exportNote ?? '저장'}
              </button>
            )}
            <button onClick={onClose} title="닫기" className="shrink-0 text-gray-500 hover:text-gray-300">
              <X size={16} />
            </button>
          </div>

          {!selected ? (
            /* 로그를 고르기 전 — 넓은 화면을 "왼쪽에서 선택하세요" 한 줄로 두지 않는다.
               적어도 무엇이 얼마나 있는지는 여기서 답한다. */
            <div className="flex flex-1 items-center justify-center p-8">
              {entries.length === 0 ? (
                <p className="text-[12px] leading-relaxed text-gray-500">
                  기록된 세션 로그가 없습니다.
                  <br />
                  터미널 상단의 <span className="text-gray-300">녹화</span> 를 눌러 세션을 기록하면 여기 쌓입니다.
                </p>
              ) : (
                <div className="w-full max-w-2xl">
                  <div className="grid grid-cols-3 gap-2">
                    <div className="rounded-md border border-white/10 bg-panel-light/40 p-3">
                      <div className="text-[10.5px] text-gray-500">보관 중</div>
                      <div className="mt-0.5 text-xl font-medium text-gray-100">{summary.total}개</div>
                      <div className="mt-0.5 text-[10.5px] text-gray-500">{fmtSize(summary.bytes)} 차지</div>
                    </div>
                    <div className="rounded-md border border-white/10 bg-panel-light/40 p-3">
                      <div className="flex items-center gap-1 text-[10.5px] text-gray-500">
                        <Clapperboard size={11} /> 리플레이
                      </div>
                      <div className="mt-0.5 text-xl font-medium text-gray-100">{summary.replayable}개</div>
                      <div className="mt-0.5 text-[10.5px] text-gray-500">그때 화면 그대로 재생</div>
                    </div>
                    <div className="rounded-md border border-white/10 bg-panel-light/40 p-3">
                      <div className="flex items-center gap-1 text-[10.5px] text-gray-500">
                        <FileText size={11} /> 텍스트 보기
                      </div>
                      <div className="mt-0.5 text-xl font-medium text-gray-100">{summary.readable}개</div>
                      <div className="mt-0.5 text-[10.5px] text-gray-500">
                        {summary.missing > 0 ? (
                          <span className="text-amber-300/80">원본 옮겨짐 {summary.missing}개</span>
                        ) : (
                          '원본 파일 모두 있음'
                        )}
                      </div>
                    </div>
                  </div>
                  <p className="mt-2 text-[10.5px] text-gray-500">
                    {fmtRelDate(summary.oldest)} ~ {fmtRelDate(summary.newest)} 기록
                  </p>

                  <div className="mt-5 text-[10.5px] font-medium uppercase tracking-wide text-gray-500">최근</div>
                  <div className="mt-1.5 space-y-1.5">
                    {entries.slice(0, 4).map((e) => {
                      const d = details[e.id]
                      return (
                        <button
                          key={e.id}
                          onClick={() => {
                            setSelectedId(e.id)
                            setMode(!d?.plainExists && d?.castExists ? 'replay' : 'text')
                          }}
                          className="flex w-full items-center gap-3 rounded-md border border-white/10 bg-panel-light/20 px-3 py-2 text-left hover:border-white/20 hover:bg-white/5"
                        >
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5">
                              <span className="min-w-0 truncate text-[12.5px] text-gray-100">
                                {e.label || e.host}
                              </span>
                              {d?.castExists && <Clapperboard size={11} className="shrink-0 text-gray-500" />}
                            </div>
                            <div className="mt-0.5 truncate font-mono text-[10.5px] text-gray-500">
                              {d?.firstCommand ? `$ ${d.firstCommand}` : '기록된 명령을 찾지 못했습니다'}
                            </div>
                          </div>
                          <div className="shrink-0 text-right">
                            <div className="text-[10.5px] text-gray-400">{fmtRelDate(e.startedAt)}</div>
                            <div className="mt-0.5 text-[10.5px] text-gray-500">
                              {fmtDuration(e.startedAt, e.endedAt)} · {fmtSize(d?.plainSize ?? d?.castSize)}
                            </div>
                          </div>
                        </button>
                      )
                    })}
                  </div>

                  <p className="mt-4 text-[10.5px] leading-relaxed text-gray-600">
                    로그를 고르면 <span className="text-gray-400">텍스트</span> 로 훑거나{' '}
                    <span className="text-gray-400">리플레이</span> 로 그때 화면을 그대로 다시 볼 수 있습니다.
                    <span className="text-gray-400"> 저장</span> 은 원본 전체를 파일로 내보냅니다.
                  </p>
                </div>
              )}
            </div>
          ) : mode === 'text' ? (
            <LogTextView
              entry={selected}
              plainMissing={details[selected.id] ? !details[selected.id].plainExists : false}
              canReplay={!!details[selected.id]?.castExists}
              onReplay={() => setMode('replay')}
            />
          ) : (
            <LogReplayView entry={selected} />
          )}
        </div>
      </div>

      {confirmDeleteEntry && (
        <ConfirmDialog
          title="로그 삭제"
          // 전에는 "(원본 평문 로그 파일은 남아있습니다)" 만 적어, 정작 **무엇이 지워지는지**를
          // 읽고도 알 수 없었다. 지우는 것과 남는 것을 나란히 적는다.
          message={
            `"${confirmDeleteEntry.label || confirmDeleteEntry.host}" 를 목록에서 지울까요?\n\n` +
            `지워지는 것 — 목록 항목과 리플레이 기록(재생 불가)\n` +
            `남는 것 — 원본 로그 파일\n${confirmDeleteEntry.path}`
          }
          onCancel={() => setConfirmDeleteEntry(null)}
          onConfirm={() => {
            deleteEntry(confirmDeleteEntry)
            setConfirmDeleteEntry(null)
          }}
        />
      )}

      {confirmBulk && (
        <ConfirmDialog
          title={`로그 ${selection.size}개 삭제`}
          message={
            `선택한 ${selection.size}개를 목록에서 지울까요?\n\n` +
            `지워지는 것 — 목록 항목과 리플레이 기록(재생 불가)\n` +
            `남는 것 — 원본 로그 파일 (각자 저장한 위치에 그대로)`
          }
          onCancel={() => setConfirmBulk(false)}
          onConfirm={() => {
            void deleteSelected()
            setConfirmBulk(false)
          }}
        />
      )}
    </div>
  )
}

// ── 텍스트 보기 + 검색 ────────────────────────────────────────
function LogTextView({
  entry,
  plainMissing,
  canReplay,
  onReplay,
}: {
  entry: LogIndexEntry
  plainMissing: boolean
  canReplay: boolean
  onReplay: () => void
}) {
  const [content, setContent] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [truncated, setTruncated] = useState(false)
  const [query, setQuery] = useState('')
  const [matchIdx, setMatchIdx] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)
  const matchRefs = useRef<(HTMLElement | null)[]>([])

  useEffect(() => {
    setLoading(true)
    setError('')
    setQuery('')
    window.electronAPI.logsRead(entry.id).then((r) => {
      if (r.ok) {
        setContent(r.content ?? '')
        setTruncated(!!r.truncated)
      } else {
        setError(r.error ?? '로그를 불러오지 못했습니다.')
      }
      setLoading(false)
    })
  }, [entry.id])

  const lines = useMemo(() => content.split('\n'), [content])
  const trimmedQuery = query.trim().toLowerCase()

  const matchCount = useMemo(() => {
    if (!trimmedQuery) return 0
    return lines.reduce((acc, line) => acc + (line.toLowerCase().includes(trimmedQuery) ? 1 : 0), 0)
  }, [lines, trimmedQuery])

  useEffect(() => {
    matchRefs.current = []
    setMatchIdx(0)
  }, [trimmedQuery])

  useEffect(() => {
    if (!trimmedQuery || matchCount === 0) return
    const el = matchRefs.current[matchIdx]
    el?.scrollIntoView({ block: 'center' })
  }, [matchIdx, trimmedQuery, matchCount])

  const goNext = () => matchCount > 0 && setMatchIdx((i) => (i + 1) % matchCount)
  const goPrev = () => matchCount > 0 && setMatchIdx((i) => (i - 1 + matchCount) % matchCount)

  let matchSeen = -1

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-white/10 px-3 py-1.5">
        <Search size={12} className="shrink-0 text-gray-500" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.shiftKey ? goPrev() : goNext())
          }}
          placeholder="로그 내용 검색..."
          className="min-w-0 flex-1 bg-transparent text-[12px] text-gray-200 outline-none placeholder:text-gray-600"
        />
        {trimmedQuery && (
          <>
            <span className="shrink-0 text-[11px] text-gray-500">
              {matchCount > 0 ? `${matchIdx + 1}/${matchCount}` : '0/0'}
            </span>
            <button onClick={goPrev} className="shrink-0 rounded p-0.5 text-gray-400 hover:text-gray-200">
              <ChevronUp size={13} />
            </button>
            <button onClick={goNext} className="shrink-0 rounded p-0.5 text-gray-400 hover:text-gray-200">
              <ChevronDown size={13} />
            </button>
          </>
        )}
      </div>
      {truncated && (
        <div className="bg-amber-500/10 px-3 py-1 text-[11px] text-amber-300">
          로그가 너무 커서 앞부분 5MB만 표시합니다.
        </div>
      )}
      <div ref={containerRef} className="flex-1 overflow-auto bg-black/30 p-2.5 font-mono text-[11px] leading-relaxed">
        {loading ? (
          <p className="text-gray-500">불러오는 중...</p>
        ) : plainMissing ? (
          /* ENOENT 원문을 그대로 띄우면 앱이 고장 난 것처럼 보인다 — 무슨 일인지 말한다 */
          <div className="font-sans text-[12px] leading-relaxed text-gray-400">
            <p>
              원본 로그 파일이 그 자리에 없습니다. 저장할 때 고른 위치에서 옮겨졌거나 지워진 것 같습니다.
            </p>
            <p className="mt-1 break-all font-mono text-[11px] text-gray-600">{entry.path}</p>
            {canReplay && (
              <button
                onClick={onReplay}
                className="mt-3 rounded-md border border-white/10 bg-panel-light px-2.5 py-1 text-[11.5px] text-gray-200 hover:bg-white/10"
              >
                리플레이로 보기 — 그때 화면은 남아 있습니다
              </button>
            )}
          </div>
        ) : error ? (
          <p className="text-red-400">{error}</p>
        ) : (
          lines.map((line, i) => {
            const hasMatch = trimmedQuery && line.toLowerCase().includes(trimmedQuery)
            if (hasMatch) matchSeen++
            // ref 콜백은 커밋 시점에 실행돼 matchSeen 이 최종값이 되므로, 이 줄의 인덱스를 캡처해서 쓴다
            const seen = matchSeen
            const isCurrent = hasMatch && seen === matchIdx
            return (
              <div
                key={i}
                ref={(el) => {
                  if (hasMatch) matchRefs.current[seen] = el
                }}
                className={
                  'whitespace-pre-wrap break-all -mx-1 px-1 text-gray-300' +
                  (isCurrent
                    ? ' rounded ring-1 ring-yellow-400 bg-yellow-500/25'
                    : hasMatch
                      ? ' bg-yellow-500/10'
                      : '')
                }
              >
                {renderLogLine(line, hasMatch ? trimmedQuery : '')}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

// ── 리플레이 (xterm 재생) ─────────────────────────────────────
function LogReplayView({ entry }: { entry: LogIndexEntry }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const framesRef = useRef<{ t: number; d: string }[]>([])
  const idxRef = useRef(0)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const playingRef = useRef(false)
  const speedRef = useRef<number>(4)
  const anchorRef = useRef({ wallStart: 0, frameT: 0 })
  /** 기록의 첫 조각 시각 — 화면에 보이는 위치는 전부 이 값을 뺀 상대 시간이다 */
  const startTRef = useRef(0)
  const durationRef = useRef(0)
  /** 화면 갱신을 솎기 위한 마지막 표시 시각 */
  const lastUiTRef = useRef(0)
  /** 눈금을 끌기 시작할 때 재생 중이었는가 — 놓으면 그 상태로 되돌린다 */
  const wasPlayingRef = useRef(false)
  const scrubRef = useRef(0)

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(4)
  /**
   * 재생 위치(ms).
   *
   * 전에는 `1234/5678 조각` 으로 보여줬는데, 조각은 사람이 가늠할 수 있는 단위가 아니다
   * (한 조각이 1ms 일 수도 30초일 수도 있다). 시간으로 바꾸고 눈금으로 이동할 수 있게 했다.
   */
  const [posMs, setPosMs] = useState(0)
  const [durationMs, setDurationMs] = useState(0)

  const clearTimer = () => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = null
  }

  const scheduleNext = () => {
    const frames = framesRef.current
    if (!playingRef.current || idxRef.current >= frames.length) {
      if (idxRef.current >= frames.length) {
        playingRef.current = false
        setPlaying(false)
        setPosMs(durationRef.current)
      }
      return
    }
    const frame = frames[idxRef.current]
    const targetElapsed = (frame.t - anchorRef.current.frameT) / speedRef.current
    const wallElapsed = performance.now() - anchorRef.current.wallStart
    const delay = Math.max(0, targetElapsed - wallElapsed)
    timerRef.current = setTimeout(() => {
      termRef.current?.write(frame.d)
      idxRef.current++
      // 조각마다 상태를 바꾸면 초당 수백 번 다시 그린다 — 100ms 이상 진행했을 때만 올린다
      if (frame.t - lastUiTRef.current >= 100) {
        lastUiTRef.current = frame.t
        setPosMs(frame.t - startTRef.current)
      }
      scheduleNext()
    }, delay)
  }

  const play = () => {
    // 끝까지 본 뒤 다시 누르면 처음부터 — 아무 일도 일어나지 않는 버튼은 고장으로 읽힌다
    if (idxRef.current >= framesRef.current.length) {
      seekTo(0, true)
      return
    }
    playingRef.current = true
    setPlaying(true)
    anchorRef.current = { wallStart: performance.now(), frameT: framesRef.current[idxRef.current]?.t ?? 0 }
    scheduleNext()
  }
  const pause = () => {
    playingRef.current = false
    setPlaying(false)
    clearTimer()
  }
  const restart = () => seekTo(0, true)

  /**
   * 되감기·앞으로 감기.
   *
   * 터미널 화면은 그때까지의 출력이 쌓여 만들어진 상태라 "그 지점부터" 바로 쓸 수 없다.
   * 화면을 지우고 목표 시각까지의 조각을 한 번에 몰아 쓴다(사람 눈에는 즉시 이동).
   * 그래서 되감기가 앞으로 감기보다 느리지 않다.
   */
  const seekTo = (targetMs: number, resume = playingRef.current) => {
    const frames = framesRef.current
    if (!frames.length) return
    pause()
    const clamped = Math.max(0, Math.min(targetMs, durationRef.current))
    const targetT = startTRef.current + clamped
    let i = 0
    while (i < frames.length && frames[i].t <= targetT) i++
    termRef.current?.reset()
    if (i > 0) termRef.current?.write(frames.slice(0, i).map((f) => f.d).join(''))
    idxRef.current = i
    lastUiTRef.current = targetT
    setPosMs(clamped)
    if (resume && i < frames.length) play()
  }
  const changeSpeed = (v: number) => {
    speedRef.current = v
    setSpeed(v)
    if (playingRef.current) {
      clearTimer()
      anchorRef.current = { wallStart: performance.now(), frameT: framesRef.current[idxRef.current]?.t ?? 0 }
      scheduleNext()
    }
  }

  useEffect(() => {
    if (!containerRef.current) return
    const term = new Terminal({
      cursorBlink: false,
      disableStdin: true,
      fontFamily: 'Consolas, "D2Coding", "Courier New", monospace',
      fontSize: 12,
      scrollback: 20000,
      theme: { background: '#1e1e2e', foreground: '#cdd6f4', cursor: '#f5e0dc' },
    })
    const fitAddon = new FitAddon()
    fitAddonRef.current = fitAddon
    term.loadAddon(fitAddon)
    term.open(containerRef.current)
    termRef.current = term
    const safeFit = () => {
      requestAnimationFrame(() => {
        try {
          fitAddonRef.current?.fit()
        } catch {
          /* 컨테이너가 아직 0 크기일 때 무시 */
        }
      })
    }
    safeFit()

    const resizeObserver = new ResizeObserver(() => safeFit())
    resizeObserver.observe(containerRef.current)

    setLoading(true)
    setError('')
    window.electronAPI.logsReadCast(entry.id).then((r) => {
      if (r.ok && r.frames) {
        framesRef.current = r.frames
        startTRef.current = r.frames[0]?.t ?? 0
        durationRef.current = Math.max(0, (r.frames[r.frames.length - 1]?.t ?? 0) - startTRef.current)
        setDurationMs(durationRef.current)
        idxRef.current = 0
        lastUiTRef.current = startTRef.current
        setPosMs(0)
        setLoading(false)
        // 열자마자 재생하지 않는다 — 볼 준비가 되기 전에 4배속으로 흘러가 버렸다
      } else {
        setError(r.error ?? '리플레이 기록을 찾을 수 없습니다. (이 세션 로그는 리플레이를 지원하지 않을 수 있습니다)')
        setLoading(false)
      }
    })

    return () => {
      resizeObserver.disconnect()
      pause()
      term.dispose()
      termRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry.id])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-white/10 px-3 py-1.5">
        <button
          onClick={playing ? pause : play}
          disabled={loading || !!error}
          title={playing ? '일시정지' : '재생'}
          className="flex items-center gap-1 rounded bg-blue-600/80 px-2 py-1 text-[11px] text-white hover:bg-blue-500 disabled:opacity-40"
        >
          {playing ? <Pause size={12} /> : <Play size={12} />}
          {playing ? '일시정지' : '재생'}
        </button>
        <button
          onClick={restart}
          disabled={loading || !!error}
          title="처음부터"
          className="flex items-center gap-1 rounded px-1.5 py-1 text-[11px] text-gray-300 hover:bg-white/10 disabled:opacity-40"
        >
          <RotateCcw size={12} />
        </button>
        <div className="flex shrink-0 items-center gap-1">
          {SPEEDS.map((v) => (
            <button
              key={v}
              onClick={() => changeSpeed(v)}
              className={
                'rounded px-1.5 py-0.5 text-[11px] ' +
                (speed === v ? 'bg-blue-600/70 text-white' : 'text-gray-400 hover:bg-white/10')
              }
            >
              {v}x
            </button>
          ))}
        </div>
        {/* 눈금 — 끄는 동안에는 화면을 옮기지 않고, 놓을 때 한 번만 옮긴다 */}
        <input
          type="range"
          min={0}
          max={durationMs || 1}
          step={100}
          value={posMs}
          disabled={loading || !!error || durationMs === 0}
          onPointerDown={() => {
            wasPlayingRef.current = playingRef.current
            if (playingRef.current) pause()
          }}
          onChange={(e) => {
            scrubRef.current = Number(e.target.value)
            setPosMs(scrubRef.current)
          }}
          onKeyDown={() => {
            wasPlayingRef.current = playingRef.current
            if (playingRef.current) pause()
          }}
          onPointerUp={() => seekTo(scrubRef.current, wasPlayingRef.current)}
          onKeyUp={() => seekTo(scrubRef.current, wasPlayingRef.current)}
          className="min-w-0 flex-1 disabled:opacity-40"
        />
        <span className="shrink-0 font-mono text-[11px] text-gray-400">
          {fmtClock(posMs)} / {fmtClock(durationMs)}
        </span>
      </div>
      {!loading && !error && !playing && posMs === 0 && (
        <div className="bg-panel-light/40 px-3 py-1 text-[10.5px] text-gray-500">
          재생을 누르면 그때 화면이 그대로 다시 흐릅니다. 눈금을 끌어 특정 시점으로 갈 수 있습니다.
        </div>
      )}
      {error && <div className="bg-red-500/10 px-3 py-1 text-[11px] text-red-300">{error}</div>}
      <div className="min-h-0 flex-1 overflow-hidden bg-black/30 p-1.5" ref={containerRef} />
    </div>
  )
}
