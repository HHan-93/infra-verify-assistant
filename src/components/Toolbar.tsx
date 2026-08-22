import type { ReactNode } from 'react'
import {
  LayoutList,
  ListChecks,
  ScanText,
  ChevronDown,
  ChevronUp,
  FileCode,
  FolderTree,
  Network,
  Circle,
  Settings,
  HeartPulse,
  SquareTerminal,
  ScrollText,
  Activity,
} from 'lucide-react'

interface ToolbarProps {
  showPresets: boolean
  onTogglePresets: () => void
  showScenarios: boolean
  onToggleScenarios: () => void
  /** 설정 관리 창 열기 */
  onOpenFiles: () => void
  /** 원격 파일 탐색기 열기 */
  onOpenExplorer: () => void
  /** 포트 포워딩(터널) 관리 열기 */
  onOpenTunnels: () => void
  /** 다중 호스트 실행 열기 */
  onOpenMultiRun: () => void
  /** 세션 로그 뷰어(목록/검색/리플레이) 열기 */
  onOpenLogViewer: () => void
  /** 실시간 로그(tail -f) 뷰어 열기 */
  onOpenLiveLog: () => void
  /** 활성 세션 로그 기록 여부 */
  logging: boolean
  /** 로그 기록 토글 */
  onToggleLog: () => void
  /** 외형 설정 열기 */
  onOpenSettings: () => void
  /** 가용성 검증 상태보드 열기 */
  onOpenStatusBoard: () => void
  /** 터미널에서 선택한 영역을 AI 분석 */
  onAnalyzeSelection: () => void
}

/**
 * 터미널 상단 도구막대.
 *  - 좌: 명령어 프리셋 패널 토글
 *  - 우: 출력 결과를 우측 AI 패널로 보내 분석
 */
export default function Toolbar({
  showPresets,
  onTogglePresets,
  showScenarios,
  onToggleScenarios,
  onOpenFiles,
  onOpenExplorer,
  onOpenTunnels,
  onOpenMultiRun,
  onOpenLogViewer,
  onOpenLiveLog,
  logging,
  onToggleLog,
  onOpenSettings,
  onOpenStatusBoard,
  onAnalyzeSelection,
}: ToolbarProps) {
  return (
    <div className="flex items-center gap-1.5 overflow-x-auto whitespace-nowrap border-b border-white/10 bg-panel px-3 py-2">
      {/* 명령 입력 (라벨 유지) */}
      <button
        onClick={onTogglePresets}
        title="자주 쓰는 단일 명령어 모음"
        className={
          'flex shrink-0 items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs transition ' +
          (showPresets
            ? 'border-blue-500/50 bg-blue-600/20 text-blue-100'
            : 'border-white/10 bg-panel-light text-gray-200 hover:bg-white/10')
        }
      >
        <LayoutList size={14} />
        프리셋 명령어
        {showPresets ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
      </button>

      <button
        onClick={onToggleScenarios}
        title="순서가 있는 작업 흐름 명령어"
        className={
          'flex shrink-0 items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs transition ' +
          (showScenarios
            ? 'border-blue-500/50 bg-blue-600/20 text-blue-100'
            : 'border-white/10 bg-panel-light text-gray-200 hover:bg-white/10')
        }
      >
        <ListChecks size={14} />
        시나리오
        {showScenarios ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
      </button>

      <Divider />

      {/* 원격 도구 (아이콘) */}
      <IconBtn onClick={onOpenFiles} title="설정 관리 — 서버 설정파일 · 파드 ConfigMap">
        <FileCode size={15} />
      </IconBtn>
      <IconBtn onClick={onOpenExplorer} title="원격 파일 탐색기 (SFTP)">
        <FolderTree size={15} />
      </IconBtn>
      <IconBtn onClick={onOpenTunnels} title="포트 포워딩 (터널)" anchor="tunnel">
        <Network size={15} />
      </IconBtn>

      {/* 분석 + 유틸 (우측) */}
      <div className="ml-auto flex items-center gap-1.5">
        <button
          onClick={onOpenStatusBoard}
          data-statusboard-btn
          title="가용성 검증 상태보드 (host/VIP·masakari·Ceph·파드 실시간 상태)"
          className="flex shrink-0 items-center gap-1 rounded-md border border-white/10 bg-panel-light px-2 py-1 text-xs text-gray-200 hover:bg-white/10"
        >
          <HeartPulse size={14} className="text-blue-300" />
          가용성 상태보드
        </button>
        <button
          onClick={onAnalyzeSelection}
          title="드래그로 선택한 텍스트를 AI 분석"
          className="flex shrink-0 items-center gap-1 rounded-md border border-white/10 bg-panel-light px-2 py-1 text-xs text-gray-200 hover:bg-white/10"
        >
          <ScanText size={14} className="text-blue-300" />
          선택 세션 AI 분석
        </button>
        <button
          onClick={onOpenMultiRun}
          title="여러 세션에 명령 1회 실행 후 결과 표로 수집"
          className="flex shrink-0 items-center gap-1 rounded-md border border-white/10 bg-panel-light px-2 py-1 text-xs text-gray-200 hover:bg-white/10"
        >
          <SquareTerminal size={14} />
          다중 실행
        </button>

        <Divider />

        {/* 로그: 실시간 로깅 → 녹화(토글) → 녹화 뷰어 */}
        <button
          onClick={onOpenLiveLog}
          title="실시간 로그 보기 (tail -f / kubectl logs -f)"
          className="flex shrink-0 items-center gap-1 rounded-md border border-white/10 bg-panel-light px-2 py-1 text-xs text-gray-200 hover:bg-white/10"
        >
          <Activity size={14} />
          실시간 로깅
        </button>
        <button
          onClick={onToggleLog}
          title={logging ? '세션 로그 녹화 중지' : '세션 로그를 파일로 녹화'}
          className={
            'flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-xs transition ' +
            (logging
              ? 'border-red-500/50 bg-red-600/20 text-red-200'
              : 'border-white/10 bg-panel-light text-gray-200 hover:bg-white/10')
          }
        >
          <Circle size={10} className={logging ? 'fill-current text-red-400' : ''} />
          {logging ? '녹화 중' : '녹화'}
        </button>
        <button
          onClick={onOpenLogViewer}
          title="녹화된 세션 로그 검색/리플레이"
          className="flex shrink-0 items-center gap-1 rounded-md border border-white/10 bg-panel-light px-2 py-1 text-xs text-gray-200 hover:bg-white/10"
        >
          <ScrollText size={14} />
          녹화 뷰어
        </button>
        <IconBtn onClick={onOpenSettings} title="앱 설정 (글꼴·테마·데이터 폴더)">
          <Settings size={15} />
        </IconBtn>
      </div>
    </div>
  )
}

/** 그룹 구분선 */
function Divider() {
  return <span className="mx-0.5 h-5 w-px shrink-0 bg-white/15" />
}

/** 아이콘 전용 툴바 버튼 (툴팁 필수) */
function IconBtn({
  onClick,
  title,
  active,
  activeColor = 'blue',
  anchor,
  children,
}: {
  onClick: () => void
  title: string
  active?: boolean
  activeColor?: 'blue' | 'red'
  /** 다른 UI(상태보드 최소화 칩)가 이 버튼을 기준으로 위치를 잡을 수 있게 하는 앵커 식별자 */
  anchor?: string
  children: ReactNode
}) {
  const activeCls =
    activeColor === 'red'
      ? 'border-red-500/50 bg-red-600/20 text-red-200'
      : 'border-blue-500/50 bg-blue-600/20 text-blue-100'
  return (
    <button
      onClick={onClick}
      title={title}
      data-anchor={anchor}
      className={
        'flex shrink-0 items-center rounded-md border p-1.5 text-gray-200 transition ' +
        (active ? activeCls : 'border-white/10 bg-panel-light hover:bg-white/10')
      }
    >
      {children}
    </button>
  )
}
