import { useCallback, useEffect, useState } from 'react'
import type { MetricSample } from '../../electron/shared-types'

// 5초 간격 x 720 = 1시간치 화면 보관 (서버 데몬과 동일)
const MAX_POINTS = 720

/**
 * 서버 모니터링 상태 훅 (세션별).
 *  - 메인이 보내는 메트릭 샘플 중 이 sessionId 것만 구독해 링버퍼로 관리
 *  - start/stop 으로 해당 세션의 서버 데몬 + 메인 리더를 제어
 *  - resumeIfRunning: 재접속/탭전환 직후 데몬이 살아있으면 자동으로 다시 붙음
 */
export function useMonitor(sessionId: string) {
  const [history, setHistory] = useState<MetricSample[]>([])
  const [running, setRunning] = useState(false)
  const [resumed, setResumed] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const latest = history[history.length - 1] ?? null

  // 이 세션의 샘플/에러만 구독 (sessionId 변경 시 재구독 + 이력 초기화)
  useEffect(() => {
    setHistory([])
    const offSample = window.electronAPI.onMonitorSample((e) => {
      if (e.sessionId !== sessionId) return
      setError(null)
      setHistory((prev) => {
        // 재접속 backfill 중복 방지: 이미 있는 ts 이하면 건너뜀
        if (prev.length && e.sample.ts <= prev[prev.length - 1].ts) return prev
        const next = [...prev, e.sample]
        return next.length > MAX_POINTS ? next.slice(-MAX_POINTS) : next
      })
    })
    const offError = window.electronAPI.onMonitorError((e) => {
      if (e.sessionId === sessionId) setError(e.error)
    })
    return () => {
      offSample()
      offError()
    }
  }, [sessionId])

  const start = useCallback(
    async (intervalMs = 5000) => {
      setError(null)
      // history 는 유지 — 재접속 후 backfill 이 ts 중복 제거로 자연스럽게 이어짐
      const r = await window.electronAPI.monitorStart(sessionId, { intervalMs })
      if (r.ok) {
        setRunning(true)
        setResumed(!!r.resumed)
      } else {
        setError(r.error ?? '시작 실패')
      }
      return r
    },
    [sessionId],
  )

  const stop = useCallback(async () => {
    await window.electronAPI.monitorStop(sessionId)
    setRunning(false)
    setResumed(false)
  }, [sessionId])

  const clear = useCallback(() => setHistory([]), [])

  // 세션 끊김 등 UI 상태만 초기화 (IPC 호출 없이, 서버 데몬은 그대로)
  const resetState = useCallback(() => {
    setRunning(false)
    setResumed(false)
    setError(null)
  }, [])

  // 재접속/탭전환 직후 데몬이 살아있으면 자동으로 리더 재개(+이력 backfill)
  const resumeIfRunning = useCallback(async () => {
    const { running: up } = await window.electronAPI.monitorStatus(sessionId)
    if (up) await start()
    else setRunning(false)
    return up
  }, [sessionId, start])

  return { history, latest, running, resumed, error, start, stop, clear, resetState, resumeIfRunning }
}

/** 최근 샘플들을 AI 리포트용 요약 텍스트로 변환 */
export function formatForReport(history: MetricSample[]): string {
  if (!history.length) return '수집된 데이터가 없습니다.'
  const last = history[history.length - 1]
  const avg = (sel: (s: MetricSample) => number) =>
    (history.reduce((a, s) => a + sel(s), 0) / history.length).toFixed(1)
  const max = (sel: (s: MetricSample) => number) => Math.max(...history.map(sel)).toFixed(1)

  return [
    `다음은 서버 [${last.host}]에서 최근 ${history.length}개 샘플(약 ${Math.round(
      (history.length * 5) / 60,
    )}분)간 수집한 시스템 메트릭입니다. 현재 상태를 요약하고 이상 징후와 권장 조치를 분석해 주세요.`,
    '',
    '## 현재값',
    `- CPU: ${last.cpu}% (평균 ${avg((s) => s.cpu)}%, 최대 ${max((s) => s.cpu)}%)`,
    `- Memory: ${last.mem.pct}% 사용 (${last.mem.used}/${last.mem.total} MB, 평균 ${avg(
      (s) => s.mem.pct,
    )}%)`,
    `- Disk(/): ${last.disk.pct}% 사용 (${last.disk.used}/${last.disk.total} GB)`,
    `- Load: ${last.load.join(' / ')} (1/5/15분)`,
    `- Uptime: ${Math.floor(last.uptime / 3600)}시간`,
    ...(last.net
      ? [`- Network: Rx ${last.net.rxMBs} MB/s, Tx ${last.net.txMBs} MB/s`]
      : []),
    '',
    '## 상위 프로세스(CPU)',
    ...last.procs.map((p) => `- ${p.name} (pid ${p.pid}): CPU ${p.cpu}%, MEM ${p.mem}%`),
  ].join('\n')
}
