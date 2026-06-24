import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { DEFAULT_SESSION_ID } from '../session'

/** App 에서 ref 로 호출할 수 있는 터미널 명령 */
export interface TerminalHandle {
  /** 사용자가 드래그로 선택한 텍스트 */
  getSelection: () => string
  /** 최근 출력(스크롤백 포함, 기본 최근 200줄)을 ANSI 없이 추출 */
  getRecentOutput: (maxLines?: number) => string
  /** 명령어를 터미널(SSH 쉘)에 입력하고 실행 */
  runCommand: (cmd: string) => void
  /** 명령어를 실행하지 않고 입력만 (플레이스홀더 수정용) */
  insertCommand: (cmd: string) => void
  /** 컨테이너 크기 변경 후 터미널을 다시 맞춤(refit) */
  fit: () => void
  /** 터미널에 키보드 포커스 */
  focus: () => void
  /** 시스템 알림 한 줄 출력 (예: 연결 종료) */
  writeNotice: (text: string) => void
  /** 터미널 화면 초기화 (새 연결 시작 시) */
  reset: () => void
}

/**
 * 좌측 하단 xterm.js 터미널.
 *  - 서버 출력(onTerminalData) → term.write
 *  - 사용자 입력(term.onData) → window.electronAPI.sendInput
 *  - 창 크기 변경 시 FitAddon 으로 반응형 리사이즈 + 서버 PTY 동기화
 *  - 명령어 결과 캡처(getSelection / getRecentOutput)는 AI 분석에 사용
 */
interface TerminalViewProps {
  /** 이 터미널이 속한 세션 ID (생략 시 기본 세션) */
  sessionId?: string
  /** 키 입력 처리 위임 (브로드캐스트 등). 없으면 자기 세션으로만 전송 */
  onData?: (sessionId: string, data: string) => void
}

const TerminalView = forwardRef<TerminalHandle, TerminalViewProps>((props, ref) => {
  const sessionId = props.sessionId ?? DEFAULT_SESSION_ID
  // onData 는 매 렌더 새로 들어올 수 있어 ref 로 최신값 유지 (mount effect 클로저 고정 회피)
  const onDataRef = useRef(props.onData)
  useEffect(() => {
    onDataRef.current = props.onData
  }, [props.onData])
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)

  // 레이아웃이 안정된 다음 프레임에 fit (높이/너비 변경 직후 호출용)
  const safeFit = () => {
    requestAnimationFrame(() => {
      try {
        fitAddonRef.current?.fit()
      } catch {
        /* 컨테이너가 아직 0 크기일 때 무시 */
      }
    })
  }

  // App 에서 호출 가능한 메서드 노출
  useImperativeHandle(ref, () => ({
    getSelection: () => termRef.current?.getSelection() ?? '',
    getRecentOutput: (maxLines = 200) => {
      const term = termRef.current
      if (!term) return ''
      const buf = term.buffer.active
      const total = buf.length // 스크롤백 포함 전체 줄 수
      const start = Math.max(0, total - maxLines)
      const lines: string[] = []
      for (let i = start; i < total; i++) {
        lines.push(buf.getLine(i)?.translateToString(true) ?? '')
      }
      // 끝쪽 빈 줄 제거
      return lines.join('\n').replace(/\n+$/, '')
    },
    runCommand: (cmd: string) => {
      // PTY 에서는 Enter 가 캐리지 리턴(\r)
      window.electronAPI.sendInput(sessionId, cmd + '\r')
      termRef.current?.focus()
    },
    insertCommand: (cmd: string) => {
      // 실행하지 않고 입력만 → 사용자가 <...> 를 채운 뒤 Enter
      window.electronAPI.sendInput(sessionId, cmd)
      termRef.current?.focus()
    },
    fit: () => safeFit(),
    focus: () => termRef.current?.focus(),
    writeNotice: (text: string) => {
      // 노란색으로 한 줄 강조 출력
      termRef.current?.writeln(`\r\n\x1b[1;33m*** ${text} ***\x1b[0m`)
    },
    reset: () => termRef.current?.reset(),
  }))

  useEffect(() => {
    if (!containerRef.current) return

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'Consolas, "D2Coding", "Courier New", monospace',
      fontSize: 13,
      scrollback: 5000,
      theme: {
        background: '#1e1e2e',
        foreground: '#cdd6f4',
        cursor: '#f5e0dc',
      },
    })
    termRef.current = term

    const fitAddon = new FitAddon()
    fitAddonRef.current = fitAddon
    term.loadAddon(fitAddon)
    term.open(containerRef.current)
    fitAddon.fit()

    term.writeln('\x1b[1;34m=== Infra Verify Assistant Terminal ===\x1b[0m')
    term.writeln('로컬 셸입니다. 좌측 상단에서 SSH 접속 시 원격으로 전환됩니다.\r\n')

    // 사용자 입력 → 위임 핸들러(브로드캐스트) 있으면 그쪽, 없으면 자기 세션
    const inputDisposable = term.onData((data) => {
      if (onDataRef.current) onDataRef.current(sessionId, data)
      else window.electronAPI.sendInput(sessionId, data)
    })

    // 서버/로컬 출력 → 터미널 출력 (자기 세션의 데이터만 write)
    const offData = window.electronAPI.onTerminalData((sid, data) => {
      if (sid === sessionId) term.write(data)
    })

    // 터미널 크기 변경 시 PTY 크기 동기화
    const resizeDisposable = term.onResize(({ cols, rows }) => {
      window.electronAPI.resize(sessionId, cols, rows)
    })

    // 컨테이너 크기 변화에 반응하여 fit() 재실행 (반응형)
    const resizeObserver = new ResizeObserver(() => safeFit())
    resizeObserver.observe(containerRef.current)

    // 메인에 터미널 준비 완료 알림 → 미연결 시 로컬 셸 시작
    window.electronAPI.terminalReady(sessionId)

    return () => {
      resizeObserver.disconnect()
      inputDisposable.dispose()
      resizeDisposable.dispose()
      offData()
      term.dispose()
      termRef.current = null
    }
  }, [])

  // absolute inset-0: flex 부모 안에서 정확한 크기를 가져 fit 계산이 어긋나지 않음.
  // 오른쪽 패딩 0 → xterm 스크롤바가 패널 우측 끝에 붙어 프리셋 스크롤바와 정렬됨.
  return (
    <div
      ref={containerRef}
      className="absolute inset-0 overflow-hidden bg-panel pl-1"
    />
  )
})

TerminalView.displayName = 'TerminalView'

export default TerminalView
