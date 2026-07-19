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
  GitCompare,
  Layers,
  SquareTerminal,
  ScrollText,
  Activity,
} from 'lucide-react'

interface ToolbarProps {
  showPresets: boolean
  onTogglePresets: () => void
  showScenarios: boolean
  onToggleScenarios: () => void
  /** 설정파일 뷰어 열기 */
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
  /** 노드 간 출력 비교 */
  onCompareNodes: () => void
  /** 터미널에서 선택한 영역을 AI 분석 */
  onAnalyzeSelection: () => void
  /** 연결된 모든 세션 출력을 한 번에 AI 분석 */
  onAnalyzeAll: () => void
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
  onCompareNodes,
  onAnalyzeSelection,
  onAnalyzeAll,
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
      <IconBtn onClick={onOpenFiles} title="설정 파일 뷰어 (SFTP)">
        <FileCode size={15} />
      </IconBtn>
      <IconBtn onClick={onOpenExplorer} title="원격 파일 탐색기 (SFTP)">
        <FolderTree size={15} />
      </IconBtn>
      <IconBtn onClick={onOpenTunnels} title="포트 포워딩 (터널)">
        <Network size={15} />
      </IconBtn>

      {/* 분석 + 유틸 (우측) */}
      <div className="ml-auto flex items-center gap-1.5">
        <button
          onClick={onAnalyzeSelection}
          title="드래그로 선택한 텍스트를 AI 분석"
          className="flex shrink-0 items-center gap-1 rounded-md border border-white/10 bg-panel-light px-2 py-1 text-xs text-gray-200 hover:bg-white/10"
        >
          <ScanText size={14} className="text-blue-300" />
          선택 AI 분석
        </button>
        <button
          onClick={onAnalyzeAll}
          title="연결된 모든 세션 출력을 한 번에 AI 분석 (클러스터 진단)"
          className="flex shrink-0 items-center gap-1 rounded-md border border-white/10 bg-panel-light px-2 py-1 text-xs text-gray-200 hover:bg-white/10"
        >
          <Layers size={14} className="text-blue-300" />
          전체 세션 AI 분석
        </button>
        <button
          onClick={onOpenMultiRun}
          title="여러 세션에 명령 1회 실행 후 결과 표로 수집"
          className="flex shrink-0 items-center gap-1 rounded-md border border-white/10 bg-panel-light px-2 py-1 text-xs text-gray-200 hover:bg-white/10"
        >
          <SquareTerminal size={14} />
          다중 실행
        </button>
        <button
          onClick={onCompareNodes}
          title="노드(세션) 간 출력 비교 (diff)"
          className="flex shrink-0 items-center gap-1 rounded-md border border-white/10 bg-panel-light px-2 py-1 text-xs text-gray-200 hover:bg-white/10"
        >
          <GitCompare size={14} />
          세션 비교
        </button>

        <Divider />

        {/* 유틸 */}
        <button
          onClick={onToggleLog}
          title={logging ? '세션 로그 기록 중지' : '세션 로그 파일로 기록'}
          className={
            'flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-xs transition ' +
            (logging
              ? 'border-red-500/50 bg-red-600/20 text-red-200'
              : 'border-white/10 bg-panel-light text-gray-200 hover:bg-white/10')
          }
        >
          <Circle size={10} className={logging ? 'fill-current text-red-400' : ''} />
          {logging ? '기록 중' : '로깅'}
        </button>
        <IconBtn onClick={onOpenLiveLog} title="실시간 로그 (tail -f)">
          <Activity size={15} />
        </IconBtn>
        <IconBtn onClick={onOpenLogViewer} title="세션 로그 뷰어 (검색/리플레이)">
          <ScrollText size={15} />
        </IconBtn>
        <IconBtn onClick={onOpenSettings} title="외형 설정 (글꼴/테마)">
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
  children,
}: {
  onClick: () => void
  title: string
  active?: boolean
  activeColor?: 'blue' | 'red'
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
      className={
        'flex shrink-0 items-center rounded-md border p-1.5 text-gray-200 transition ' +
        (active ? activeCls : 'border-white/10 bg-panel-light hover:bg-white/10')
      }
    >
      {children}
    </button>
  )
}
