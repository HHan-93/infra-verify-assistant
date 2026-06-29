import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
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
  /** 스크롤백에서 다음 일치 검색 */
  findNext: (term: string) => void
  /** 이전 일치 검색 */
  findPrevious: (term: string) => void
  /** 검색 하이라이트 해제 */
  clearSearch: () => void
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
  /** Ctrl+F — 검색바 열기 요청 */
  onFind?: () => void
  /** 외형: 글꼴 크기 */
  fontSize?: number
  /** 외형: 색상 테마 */
  theme?: { background: string; foreground: string; cursor: string }
  /** 그리드 셀 헤더(호스트 라벨)만큼 상단 여백 확보 */
  headerSpace?: boolean
  /** 출력 키워드 하이라이트(ERROR/WARN/OK 등) on/off */
  highlight?: boolean
}

// 출력 하이라이트 규칙 (키워드 → ANSI SGR 코드)
const HL_RULES: { re: RegExp; code: string }[] = [
  { re: /\b(ERROR|ERR|FAIL|FAILED|CRITICAL|FATAL|DENIED|REFUSED)\b/g, code: '1;31' },
  { re: /\b(WARN|WARNING)\b/g, code: '1;33' },
  { re: /\b(OK|SUCCESS|SUCCEEDED|PASS|PASSED|ACTIVE|RUNNING|DONE|ENABLED)\b/g, code: '1;32' },
]
function applyHighlight(s: string): string {
  let out = s
  for (const { re, code } of HL_RULES) out = out.replace(re, (m) => `\x1b[${code}m${m}\x1b[0m`)
  return out
}

const TerminalView = forwardRef<TerminalHandle, TerminalViewProps>((props, ref) => {
  const sessionId = props.sessionId ?? DEFAULT_SESSION_ID
  // onData 는 매 렌더 새로 들어올 수 있어 ref 로 최신값 유지 (mount effect 클로저 고정 회피)
  const onDataRef = useRef(props.onData)
  const onFindRef = useRef(props.onFind)
  const highlightRef = useRef(props.highlight)
  useEffect(() => {
    onDataRef.current = props.onData
    onFindRef.current = props.onFind
    highlightRef.current = props.highlight
  }, [props.onData, props.onFind, props.highlight])
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const searchAddonRef = useRef<SearchAddon | null>(null)

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
    findNext: (term: string) =>
      searchAddonRef.current?.findNext(term, { caseSensitive: false, decorations: undefined }),
    findPrevious: (term: string) =>
      searchAddonRef.current?.findPrevious(term, { caseSensitive: false }),
    clearSearch: () => searchAddonRef.current?.clearDecorations?.(),
  }))

  useEffect(() => {
    if (!containerRef.current) return

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'Consolas, "D2Coding", "Courier New", monospace',
      fontSize: props.fontSize ?? 13,
      scrollback: 5000,
      theme: props.theme ?? {
        background: '#1e1e2e',
        foreground: '#cdd6f4',
        cursor: '#f5e0dc',
      },
    })
    termRef.current = term

    const fitAddon = new FitAddon()
    fitAddonRef.current = fitAddon
    term.loadAddon(fitAddon)
    const searchAddon = new SearchAddon()
    searchAddonRef.current = searchAddon
    term.loadAddon(searchAddon)
    term.open(containerRef.current)
    fitAddon.fit()

    term.writeln('\x1b[1;34m=== Infra Verify Assistant Terminal ===\x1b[0m')
    term.writeln('로컬 셸입니다. 좌측 상단에서 SSH 접속 시 원격으로 전환됩니다.\r\n')

    // 입력 전송 (브로드캐스트 위임 있으면 그쪽, 없으면 자기 세션)
    const emitInput = (data: string) => {
      if (onDataRef.current) onDataRef.current(sessionId, data)
      else window.electronAPI.sendInput(sessionId, data)
    }

    // 사용자 입력 → 전송
    const inputDisposable = term.onData((data) => emitInput(data))

    // Ctrl+V 붙여넣기 / Ctrl+C 복사(선택 시) — xterm 기본 처리가 안 되는 Electron 대응
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true
      const mod = e.ctrlKey || e.metaKey
      if (mod && !e.shiftKey && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault()
        onFindRef.current?.()
        return false
      }
      if (mod && (e.key === 'v' || e.key === 'V')) {
        e.preventDefault()
        window.electronAPI
          .clipboardReadText()
          .then((text) => {
            if (text) emitInput(text)
          })
          .catch(() => {})
        return false
      }
      if (mod && (e.key === 'c' || e.key === 'C')) {
        // 선택 영역이 있으면 복사, 없으면 통과시켜 ^C(SIGINT) 전송
        const sel = term.getSelection()
        if (sel) {
          navigator.clipboard.writeText(sel).catch(() => {})
          term.clearSelection()
          e.preventDefault()
          return false
        }
      }
      return true
    })

    // 서버/로컬 출력 → 터미널 출력 (자기 세션의 데이터만 write)
    const offData = window.electronAPI.onTerminalData((sid, data) => {
      if (sid === sessionId) term.write(highlightRef.current ? applyHighlight(data) : data)
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

  // 외형 변경(폰트 크기/테마) 실시간 반영
  useEffect(() => {
    const t = termRef.current
    if (!t) return
    if (props.fontSize) t.options.fontSize = props.fontSize
    if (props.theme) t.options.theme = props.theme
    safeFit()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.fontSize, props.theme, props.headerSpace])

  // absolute inset-0: flex 부모 안에서 정확한 크기를 가져 fit 계산이 어긋나지 않음.
  // 오른쪽 패딩 0 → xterm 스크롤바가 패널 우측 끝에 붙어 프리셋 스크롤바와 정렬됨.
  return (
    <div
      ref={containerRef}
      className={
        'absolute bottom-0 left-0 right-0 overflow-hidden bg-panel pl-1 ' +
        (props.headerSpace ? 'top-[19px]' : 'top-0')
      }
    />
  )
})

TerminalView.displayName = 'TerminalView'

export default TerminalView
