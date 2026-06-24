import {
  LayoutList,
  ListChecks,
  ScanText,
  Sparkles,
  ChevronDown,
  ChevronUp,
  FileCode,
} from 'lucide-react'

interface ToolbarProps {
  showPresets: boolean
  onTogglePresets: () => void
  showScenarios: boolean
  onToggleScenarios: () => void
  /** 설정파일 뷰어 열기 */
  onOpenFiles: () => void
  /** 터미널에서 선택한 영역을 AI 분석 */
  onAnalyzeSelection: () => void
  /** 최근 출력 전체를 AI 분석 */
  onAnalyzeRecent: () => void
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
  onAnalyzeSelection,
  onAnalyzeRecent,
}: ToolbarProps) {
  return (
    <div className="flex items-center gap-2 border-b border-white/10 bg-panel px-3 py-2">
      <button
        onClick={onTogglePresets}
        className={
          'flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs transition ' +
          (showPresets
            ? 'border-blue-500/50 bg-blue-600/20 text-blue-100'
            : 'border-white/10 bg-panel-light text-gray-200 hover:bg-white/10')
        }
      >
        <LayoutList size={14} />
        단일 프리셋 명령어
        {showPresets ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
      </button>

      <button
        onClick={onToggleScenarios}
        className={
          'flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs transition ' +
          (showScenarios
            ? 'border-blue-500/50 bg-blue-600/20 text-blue-100'
            : 'border-white/10 bg-panel-light text-gray-200 hover:bg-white/10')
        }
      >
        <ListChecks size={14} />
        시나리오 흐름 명령어
        {showScenarios ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
      </button>

      <button
        onClick={onOpenFiles}
        title="설정파일 뷰어 (SFTP)"
        className="flex items-center gap-1.5 rounded-md border border-white/10 bg-panel-light px-2.5 py-1 text-xs text-gray-200 hover:bg-white/10"
      >
        <FileCode size={14} />
        설정 파일 뷰어
      </button>

      <div className="ml-auto flex items-center gap-1.5">
        <button
          onClick={onAnalyzeSelection}
          title="터미널에서 드래그로 선택한 텍스트를 AI 분석"
          className="flex items-center gap-1 rounded-md border border-white/10 bg-panel-light px-2 py-1 text-xs text-gray-200 hover:bg-white/10"
        >
          <ScanText size={13} className="text-blue-300" />
          선택 분석
        </button>
        <button
          onClick={onAnalyzeRecent}
          title="최근 터미널 출력을 AI 분석"
          className="flex items-center gap-1 rounded-md border border-white/10 bg-blue-600/80 px-2 py-1 text-xs text-white hover:bg-blue-500"
        >
          <Sparkles size={13} />
          최근 출력 분석
        </button>
      </div>
    </div>
  )
}
