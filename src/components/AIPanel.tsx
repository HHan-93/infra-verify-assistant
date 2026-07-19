import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react'
import {
  Sparkles,
  Send,
  Settings,
  KeyRound,
  Loader2,
  Trash2,
  FileDown,
  FileText,
  Copy,
  Check,
  RefreshCw,
  PanelRightClose,
  Terminal,
  CornerDownLeft,
  Play,
} from 'lucide-react'
import {
  PROVIDER_INFO,
  ANALYSIS_STYLES,
  type AIProvider,
  type AnalysisStyle,
} from '../../electron/shared-types'
import Markdown from './Markdown'
import { buildReportHtml } from '../lib/reportHtml'

/** App 에서 ref 로 호출: 터미널 출력 텍스트를 분석 요청 */
export interface AIPanelHandle {
  analyze: (context: string, question?: string) => void
}

interface ChatItem {
  id: string
  role: 'user' | 'assistant'
  content: string
  /** 'command' 면 명령어 생성 모드의 응답 — 일반 markdown 대신 명령어 카드로 렌더링 */
  mode?: 'command'
}

/** "명령어 생성" 모드 응답을 COMMAND:/설명: 고정 형식에서 파싱 (스트리밍 도중에도 부분 매치 허용) */
function parseCommandCard(content: string): { command: string; explain: string } | null {
  const m = content.match(/COMMAND:\s*(.+)/)
  if (!m) return null
  const explainMatch = content.match(/설명:\s*([\s\S]*)/)
  return { command: m[1].trim(), explain: explainMatch ? explainMatch[1].trim() : '' }
}

/** 프로바이더별 사용자 설정 (키 + 모델) */
interface ProviderConfig {
  key: string
  model: string
}
type ConfigMap = Record<AIProvider, ProviderConfig>

const PROVIDERS: AIProvider[] = ['anthropic', 'gemini', 'openai']
const CONFIG_STORAGE = 'ai_config'
const LEGACY_KEY_STORAGE = 'anthropic_api_key' // 구버전 단일 키 마이그레이션용
const MESSAGES_STORAGE = 'ai_chat_history'
// localStorage 용량 제한을 고려해 최근 N개까지만 보관 (그 이전은 자연스럽게 잘려나감)
const MAX_STORED_MESSAGES = 200

/** 앱 재시작 후에도 대화가 이어지도록, 초기 상태 자체를 localStorage 에서 복원 */
function loadStoredMessages(): ChatItem[] {
  try {
    const raw = localStorage.getItem(MESSAGES_STORAGE)
    if (raw) {
      const arr = JSON.parse(raw)
      if (Array.isArray(arr)) return arr as ChatItem[]
    }
  } catch {
    /* 손상된 기록 무시 */
  }
  return []
}

const emptyConfigs = (): ConfigMap => ({
  anthropic: { key: '', model: '' },
  gemini: { key: '', model: '' },
  openai: { key: '', model: '' },
})

/**
 * 우측 AI 분석 패널.
 *  - 프로바이더(Claude / Gemini / OpenAI) 선택 + 프로바이더별 키·모델 설정
 *  - 메인 프로세스를 통해 선택한 프로바이더로 스트리밍 호출
 *  - 터미널 출력(선택/최근)을 받아 분석하거나, 자유 질문 가능
 */
interface AIPanelProps {
  onClose?: () => void
  /** 명령어 생성 모드 카드의 "입력"/"실행" 버튼 — 활성 세션(또는 브로드캐스트 대상)에 전달 */
  onRunCommand?: (cmd: string, execute: boolean) => void
}

const AIPanel = forwardRef<AIPanelHandle, AIPanelProps>(({ onClose, onRunCommand }, ref) => {
  const [messages, setMessages] = useState<ChatItem[]>(loadStoredMessages)
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  // 일반 대화 / 명령어 생성 모드 — 명령어 생성은 analysisStyle 설정과 무관하게 'shellgen' 스타일 강제
  const [chatMode, setChatMode] = useState<'chat' | 'command'>('chat')

  const [provider, setProvider] = useState<AIProvider>('gemini')
  const [configs, setConfigs] = useState<ConfigMap>(emptyConfigs)
  const [analysisStyle, setAnalysisStyle] = useState<AnalysisStyle>('detailed')
  const [showCustomModel, setShowCustomModel] = useState(false)
  // 키로 실제 조회한 모델 목록 (프로바이더별, 메모리 보관)
  const [fetchedModels, setFetchedModels] = useState<Partial<Record<AIProvider, string[]>>>({})
  const [modelLoading, setModelLoading] = useState(false)
  const [modelMsg, setModelMsg] = useState('')
  const [copiedId, setCopiedId] = useState<string | null>(null)
  // 길게 들어온 사용자 메시지(터미널 출력 등) 펼침 여부
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [saveMsg, setSaveMsg] = useState<string>('')
  const loadedRef = useRef(false)

  // 스트리밍 응답을 올바른 메시지에 누적하기 위한 추적용 ref
  const activeReqRef = useRef<string | null>(null)
  const activeAssistantRef = useRef<string | null>(null)
  const messagesRef = useRef<ChatItem[]>([])
  const configRef = useRef({ provider, configs, analysisStyle })
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    messagesRef.current = messages
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [messages])

  // 대화 히스토리 자동 저장 — 스트리밍 도중 토큰마다 쓰지 않도록 완료 후에만 반영
  useEffect(() => {
    if (streaming) return
    try {
      localStorage.setItem(MESSAGES_STORAGE, JSON.stringify(messages.slice(-MAX_STORED_MESSAGES)))
    } catch {
      /* 저장 공간 부족 등은 무시 — 대화는 계속 가능 */
    }
  }, [messages, streaming])

  useEffect(() => {
    configRef.current = { provider, configs, analysisStyle }
  }, [provider, configs, analysisStyle])

  // 저장된 설정 로드 (+ 구버전 단일 Anthropic 키 마이그레이션)
  useEffect(() => {
    try {
      const raw = localStorage.getItem(CONFIG_STORAGE)
      if (raw) {
        const parsed = JSON.parse(raw) as {
          provider: AIProvider
          configs: ConfigMap
          analysisStyle?: AnalysisStyle
        }
        if (parsed.provider) setProvider(parsed.provider)
        if (parsed.configs) setConfigs({ ...emptyConfigs(), ...parsed.configs })
        if (parsed.analysisStyle) setAnalysisStyle(parsed.analysisStyle)
      } else {
        const legacy = localStorage.getItem(LEGACY_KEY_STORAGE)
        if (legacy) setConfigs((c) => ({ ...c, anthropic: { ...c.anthropic, key: legacy } }))
      }
    } catch {
      /* 손상된 설정 무시 */
    }
    loadedRef.current = true
  }, [])

  // 변경 시 자동 저장 (로드 완료 이후에만)
  useEffect(() => {
    if (!loadedRef.current) return
    localStorage.setItem(CONFIG_STORAGE, JSON.stringify({ provider, configs, analysisStyle }))
  }, [provider, configs, analysisStyle])

  // 메인 프로세스 스트리밍 이벤트 구독 (마운트 시 1회)
  useEffect(() => {
    const offDelta = window.electronAPI.onAiDelta((e) => {
      if (e.requestId !== activeReqRef.current) return
      setMessages((prev) =>
        prev.map((m) =>
          m.id === activeAssistantRef.current
            ? { ...m, content: m.content + (e.text ?? '') }
            : m,
        ),
      )
    })
    const offDone = window.electronAPI.onAiDone((e) => {
      if (e.requestId !== activeReqRef.current) return
      setStreaming(false)
      activeReqRef.current = null
    })
    const offError = window.electronAPI.onAiError((e) => {
      if (e.requestId !== activeReqRef.current) return
      setMessages((prev) =>
        prev.map((m) =>
          m.id === activeAssistantRef.current
            ? { ...m, content: (m.content ? m.content + '\n\n' : '') + '⚠️ ' + (e.error ?? '오류 발생') }
            : m,
        ),
      )
      setStreaming(false)
      activeReqRef.current = null
    })
    return () => {
      offDelta()
      offDone()
      offError()
    }
  }, [])

  // 대화 히스토리를 메인으로 보내 스트리밍 시작
  const startStream = (
    history: ChatItem[],
    styleOverride?: AnalysisStyle,
    assistantMode?: 'command',
  ) => {
    const { provider: p, configs: c, analysisStyle: style } = configRef.current
    const requestId = crypto.randomUUID()
    const assistantId = crypto.randomUUID()
    activeReqRef.current = requestId
    activeAssistantRef.current = assistantId
    setMessages([...history, { id: assistantId, role: 'assistant', content: '', mode: assistantMode }])
    setStreaming(true)
    window.electronAPI.aiSend({
      requestId,
      provider: p,
      model: c[p].model || undefined, // 비우면 메인에서 프로바이더 기본 모델 사용
      style: styleOverride ?? style,
      apiKey: c[p].key || undefined,
      messages: history.map((m) => ({ role: m.role, content: m.content })),
    })
  }

  const submit = (text: string, mode: 'chat' | 'command' = 'chat') => {
    const trimmed = text.trim()
    if (!trimmed || streaming) return
    const userMsg: ChatItem = { id: crypto.randomUUID(), role: 'user', content: trimmed }
    if (mode === 'command') startStream([...messagesRef.current, userMsg], 'shellgen', 'command')
    else startStream([...messagesRef.current, userMsg])
  }

  // App(터미널 도구막대)에서 호출 — submit() 과 동일하게 이미 스트리밍 중이면 무시.
  // (없으면 이전 요청의 activeReqRef/activeAssistantRef 를 덮어써서 이전 메시지가
  // 응답을 영영 못 받고 "…"/"명령어 생성 중" 상태로 멈춰버림)
  useImperativeHandle(ref, () => ({
    analyze: (context: string, question?: string) => {
      if (streaming) return
      // 이 핸들은 항상 '일반 대화' 형식(자유 서술)으로 응답을 생성한다 — 명령어 생성
      // 탭이 켜진 채로 호출되면 탭 표시와 실제 응답 형식이 어긋나 보이므로 탭도 맞춰준다.
      setChatMode('chat')
      const ctx = context.trim()
      if (!ctx) {
        submit('터미널 출력이 비어 있습니다. (선택 영역이 없거나 출력이 없음)')
        return
      }
      if (question) {
        const userMsg: ChatItem = {
          id: crypto.randomUUID(),
          role: 'user',
          content: `다음 터미널 출력에 대해 답해 주세요.\n\n질문: ${question}\n\n\`\`\`\n${ctx}\n\`\`\``,
        }
        startStream([...messagesRef.current, userMsg], 'free')
      } else {
        submit(`다음 터미널 출력을 분석해 주세요:\n\n\`\`\`\n${ctx}\n\`\`\``)
      }
    },
  }))

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit(input, chatMode)
      setInput('')
    }
  }

  // 긴 사용자 메시지 판별/토글 (터미널 원문이 통째로 들어오면 기본 접힘)
  const isLongUser = (text: string) => text.split('\n').length > 12 || text.length > 700
  const toggleExpand = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  // 클립보드 복사 (+ 짧은 피드백)
  const copyMessage = async (item: ChatItem) => {
    try {
      await navigator.clipboard.writeText(item.content)
      setCopiedId(item.id)
      setTimeout(() => setCopiedId((id) => (id === item.id ? null : id)), 1500)
    } catch {
      /* 클립보드 접근 실패 무시 */
    }
  }

  // 대화 전체를 Markdown 리포트로 직렬화
  const buildReport = (): string => {
    const now = new Date()
    const stamp = now.toLocaleString('ko-KR')
    const lines = [
      '# 인프라 검증 분석 리포트',
      '',
      `- 생성 시각: ${stamp}`,
      `- AI 모델: ${PROVIDER_INFO[provider].label}`,
      `- 모델 버전: ${configs[provider].model || PROVIDER_INFO[provider].defaultModel}`,
      '',
      '---',
      '',
    ]
    messages.forEach((m, i) => {
      lines.push(`## ${i + 1}. ${m.role === 'user' ? '🧑 사용자' : '🤖 AI 분석'}`)
      lines.push('')
      lines.push(m.content)
      lines.push('')
    })
    return lines.join('\n')
  }

  // 파일명용 타임스탬프 (YYYYMMDD-HHmm)
  const fileStamp = (): string => {
    const d = new Date()
    const p = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
  }

  const handleSaveReport = async () => {
    if (messages.length === 0) {
      setSaveMsg('저장할 대화가 없습니다.')
      setTimeout(() => setSaveMsg(''), 2000)
      return
    }
    const res = await window.electronAPI.saveReport({
      defaultName: `infra-report-${fileStamp()}.md`,
      content: buildReport(),
    })
    if (res.saved) setSaveMsg(`저장됨: ${res.path}`)
    else if (res.error) setSaveMsg(`저장 실패: ${res.error}`)
    else setSaveMsg('') // 취소
    if (res.saved) setTimeout(() => setSaveMsg(''), 4000)
  }

  const handleSavePdfReport = async () => {
    if (messages.length === 0) {
      setSaveMsg('저장할 대화가 없습니다.')
      setTimeout(() => setSaveMsg(''), 2000)
      return
    }
    const html = buildReportHtml(buildReport(), '인프라 검증 분석 리포트')
    const res = await window.electronAPI.saveReportPdf({
      html,
      defaultName: `infra-report-${fileStamp()}.pdf`,
    })
    if (res.saved) setSaveMsg(`저장됨: ${res.path}`)
    else if (res.error) setSaveMsg(`저장 실패: ${res.error}`)
    else setSaveMsg('')
    if (res.saved) setTimeout(() => setSaveMsg(''), 4000)
  }

  const cur = configs[provider]
  const curInfo = PROVIDER_INFO[provider]
  const updateCur = (patch: Partial<ProviderConfig>) =>
    setConfigs((prev) => ({ ...prev, [provider]: { ...prev[provider], ...patch } }))

  // 모델 목록: 키로 조회한 게 있으면 그걸, 없으면 기본 후보 목록
  const modelOptions = fetchedModels[provider] ?? curInfo.models
  const CUSTOM_MODEL = '__custom__'
  const isCustomModel = !!cur.model && !modelOptions.includes(cur.model)
  const customMode = showCustomModel || isCustomModel
  const resolvedModel = cur.model || curInfo.defaultModel
  const selectValue = customMode
    ? CUSTOM_MODEL
    : modelOptions.includes(resolvedModel)
      ? resolvedModel
      : modelOptions[0]

  // 입력한 키로 실제 사용 가능한 모델 목록 조회
  const loadModels = async () => {
    setModelLoading(true)
    setModelMsg('')
    const res = await window.electronAPI.aiListModels(provider, cur.key || undefined)
    setModelLoading(false)
    if (res.ok && res.models) {
      setFetchedModels((prev) => ({ ...prev, [provider]: res.models }))
      setShowCustomModel(false)
      setModelMsg(`${res.models.length}개 모델 확인됨`)
    } else {
      setModelMsg(`불러오기 실패: ${res.error}`)
    }
  }

  return (
    <div className="flex h-full flex-col bg-[#181825] text-gray-200">
      {/* 헤더 */}
      <div className="flex items-center gap-2 border-b border-white/10 px-4 py-3">
        {onClose && (
          <button
            onClick={onClose}
            title="AI 패널 닫기"
            className="-ml-1 rounded p-1 text-gray-400 hover:bg-white/10 hover:text-gray-200"
          >
            <PanelRightClose size={16} />
          </button>
        )}
        <Sparkles size={18} className="shrink-0 text-purple-400" />
        <span className="shrink-0 text-sm font-semibold">AI 분석 패널</span>
        <span className="min-w-0 flex-1 truncate text-[11px] text-gray-500">
          {curInfo.label} · {cur.model || curInfo.defaultModel}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <button
            onClick={handleSaveReport}
            title="대화를 Markdown 리포트로 저장"
            className="rounded p-1 text-gray-400 hover:bg-white/10 hover:text-gray-200"
          >
            <FileDown size={15} />
          </button>
          <button
            onClick={handleSavePdfReport}
            title="대화를 PDF 리포트로 저장"
            className="rounded p-1 text-gray-400 hover:bg-white/10 hover:text-gray-200"
          >
            <FileText size={15} />
          </button>
          <button
            onClick={() => setMessages([])}
            title="대화 초기화"
            className="rounded p-1 text-gray-400 hover:bg-white/10 hover:text-gray-200"
          >
            <Trash2 size={15} />
          </button>
          <button
            onClick={() => setShowSettings((v) => !v)}
            title="AI 모델 / API 키 설정"
            className={
              'rounded p-1 hover:bg-white/10 ' +
              (cur.key ? 'text-gray-400 hover:text-gray-200' : 'text-amber-400')
            }
          >
            <Settings size={15} />
          </button>
        </div>
      </div>

      {/* 일반 대화 / 명령어 생성 모드 */}
      <div className="flex items-center gap-1 border-b border-white/10 bg-panel px-2 py-1.5">
        <button
          onClick={() => setChatMode('chat')}
          className={
            'flex flex-1 items-center justify-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition ' +
            (chatMode === 'chat' ? 'bg-blue-600/30 text-blue-100' : 'text-gray-400 hover:bg-white/5')
          }
        >
          <Sparkles size={12} /> 일반 대화
        </button>
        <button
          onClick={() => setChatMode('command')}
          className={
            'flex flex-1 items-center justify-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition ' +
            (chatMode === 'command' ? 'bg-blue-600/30 text-blue-100' : 'text-gray-400 hover:bg-white/5')
          }
        >
          <Terminal size={12} /> 명령어 생성
        </button>
      </div>

      {/* 프로바이더 / API 키 설정 */}
      {showSettings && (
        <div className="space-y-2 border-b border-white/10 bg-panel p-3">
          <div>
            <label className="mb-1 block text-[11px] text-gray-400">AI 모델</label>
            <select
              value={provider}
              onChange={(e) => {
                setProvider(e.target.value as AIProvider)
                setShowCustomModel(false)
              }}
              className="w-full rounded-md border border-white/10 bg-panel-light px-2 py-1 text-xs text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              {PROVIDERS.map((p) => (
                <option key={p} value={p}>
                  {PROVIDER_INFO[p].label}
                  {configs[p].key ? ' ✓' : ''}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="mb-1 flex items-center gap-1 text-[11px] text-gray-400">
              <KeyRound size={12} /> API 키
            </label>
            <input
              type="password"
              value={cur.key}
              onChange={(e) => updateCur({ key: e.target.value })}
              placeholder={curInfo.keyHint}
              className="w-full rounded-md border border-white/10 bg-panel-light px-2 py-1 text-xs text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            <a
              href={curInfo.apiKeyUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-1 block text-right text-[10px] text-blue-400/70 hover:text-blue-300"
            >
              API 키 발급 →
            </a>
          </div>

          <div>
            <label className="mb-1 flex items-center gap-1 text-[11px] text-gray-400">
              모델 버전
              {fetchedModels[provider] && (
                <span className="text-green-400">· 키로 확인됨</span>
              )}
            </label>
            <div className="flex gap-2">
              <select
                value={selectValue}
                onChange={(e) => {
                  if (e.target.value === CUSTOM_MODEL) {
                    setShowCustomModel(true)
                    if (!isCustomModel) updateCur({ model: '' }) // 직접 입력 시작 시 비움
                  } else {
                    setShowCustomModel(false)
                    updateCur({ model: e.target.value })
                  }
                }}
                className="min-w-0 flex-1 rounded-md border border-white/10 bg-panel-light px-2 py-1 text-xs text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
              >
                {modelOptions.map((m) => (
                  <option key={m} value={m}>
                    {m}
                    {m === curInfo.defaultModel ? ' (기본)' : ''}
                  </option>
                ))}
                <option value={CUSTOM_MODEL}>직접 입력…</option>
              </select>
              <button
                onClick={loadModels}
                disabled={modelLoading}
                title="입력한 API 키로 사용 가능한 모델 목록 불러오기"
                className="flex shrink-0 items-center gap-1 rounded-md border border-white/10 bg-panel-light px-2 py-1 text-xs text-gray-200 hover:bg-white/10 disabled:opacity-50"
              >
                {modelLoading ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <RefreshCw size={13} />
                )}
                불러오기
              </button>
            </div>
            {customMode && (
              <input
                type="text"
                value={cur.model}
                onChange={(e) => updateCur({ model: e.target.value })}
                placeholder={`예: ${curInfo.defaultModel}`}
                className="mt-1.5 w-full rounded-md border border-white/10 bg-panel-light px-2 py-1 font-mono text-xs text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            )}
            <p className="mt-1 text-[10px] text-gray-500">
              {modelMsg || '“불러오기”로 이 키가 실제 쓸 수 있는 모델만 목록에 채울 수 있어요.'}
            </p>
          </div>

          <div>
            <label className="mb-1 block text-[11px] text-gray-400">분석 스타일</label>
            <select
              value={analysisStyle}
              onChange={(e) => setAnalysisStyle(e.target.value as AnalysisStyle)}
              className="w-full rounded-md border border-white/10 bg-panel-light px-2 py-1 text-xs text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              {(Object.keys(ANALYSIS_STYLES) as AnalysisStyle[])
                .filter((k) => k !== 'shellgen') // 명령어 생성 모드 전용 내부 스타일 — 일반 설정에는 노출 안 함
                .map((k) => (
                  <option key={k} value={k}>
                    {ANALYSIS_STYLES[k].label}
                  </option>
                ))}
            </select>
            <p className="mt-1 text-[10px] text-gray-500">{ANALYSIS_STYLES[analysisStyle].hint}</p>
          </div>

          <p className="text-[10px] text-gray-500">
            키·모델은 이 PC 의 localStorage 에 자동 저장되며, 요청 시에만 메인 프로세스로 전달됩니다.
            AI 모델별로 키를 따로 보관합니다.
          </p>
        </div>
      )}

      {/* 메시지 영역 */}
      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto p-4 text-sm">
        {messages.length === 0 && (
          <div className="rounded-lg bg-panel-light p-3 text-gray-300">
            AI 응답 패널입니다. 🤖
            <br />
            <span className="text-xs text-gray-500">
              터미널 출력을 <b>선택 분석</b> / <b>최근 출력 분석</b> 하거나, 아래에 직접 질문을 입력하세요.
            </span>
          </div>
        )}
        {messages.map((m) => (
          <div
            key={m.id}
            className={
              'group relative ' +
              (m.role === 'user'
                ? 'ml-6 rounded-lg bg-blue-600/20 p-3'
                : 'mr-2 rounded-lg bg-panel-light p-3')
            }
          >
            <div className="mb-1 flex items-center text-[10px] font-semibold uppercase tracking-wide text-gray-500">
              {m.role === 'user' ? '나' : 'AI'}
              {/* 복사 버튼 (내용이 있을 때만) */}
              {m.content && (
                <button
                  onClick={() => copyMessage(m)}
                  title="복사"
                  className="ml-auto rounded p-0.5 text-gray-500 opacity-0 transition hover:bg-white/10 hover:text-gray-200 group-hover:opacity-100"
                >
                  {copiedId === m.id ? (
                    <Check size={13} className="text-green-400" />
                  ) : (
                    <Copy size={13} />
                  )}
                </button>
              )}
            </div>
            <div className="break-words">
              {m.role === 'assistant' && m.mode === 'command' ? (
                // 명령어 생성 모드: COMMAND:/설명: 고정 형식을 파싱해 카드로 표시
                (() => {
                  const card = parseCommandCard(m.content)
                  if (!card) {
                    return <span className="text-gray-500">{streaming ? '명령어 생성 중…' : m.content}</span>
                  }
                  const stillStreaming = streaming && activeAssistantRef.current === m.id
                  return (
                    <div className="space-y-2">
                      <code className="block break-all rounded-md bg-black/40 px-2.5 py-1.5 font-mono text-[12px] text-pink-200">
                        {card.command}
                      </code>
                      {card.explain && <p className="text-[12px] text-gray-400">{card.explain}</p>}
                      {!stillStreaming && (
                        <div className="flex gap-2">
                          <button
                            onClick={() => onRunCommand?.(card.command, false)}
                            disabled={!onRunCommand}
                            title="터미널에 입력만(실행 안 함) — 확인 후 직접 Enter"
                            className="flex items-center gap-1 rounded bg-panel px-2.5 py-1 text-[11px] text-gray-200 hover:bg-white/10 disabled:opacity-40"
                          >
                            <CornerDownLeft size={12} /> 입력
                          </button>
                          <button
                            onClick={() => onRunCommand?.(card.command, true)}
                            disabled={!onRunCommand}
                            title="터미널에서 바로 실행"
                            className="flex items-center gap-1 rounded bg-blue-600/80 px-2.5 py-1 text-[11px] text-white hover:bg-blue-500 disabled:opacity-40"
                          >
                            <Play size={11} /> 실행
                          </button>
                        </div>
                      )}
                    </div>
                  )
                })()
              ) : m.role === 'assistant' ? (
                // AI 답변: 높이 제한 없이 전체 표시 (패널 전체 스크롤만 사용)
                m.content ? (
                  <Markdown content={m.content} />
                ) : (
                  <span className="text-gray-500">{streaming ? '…' : ''}</span>
                )
              ) : (
                // 사용자 메시지: 너무 길면 접고 '더보기' 토글
                (() => {
                  const long = isLongUser(m.content)
                  const open = expanded.has(m.id)
                  return (
                    <>
                      <div
                        className={
                          'whitespace-pre-wrap font-sans text-[13px] leading-relaxed text-gray-100 ' +
                          (long && !open ? 'max-h-32 overflow-hidden' : '')
                        }
                      >
                        {m.content}
                      </div>
                      {long && (
                        <button
                          onClick={() => toggleExpand(m.id)}
                          className="mt-1 text-[11px] font-medium text-blue-300 hover:text-blue-200"
                        >
                          {open ? '접기 ▲' : '⋯ 더보기 ▼'}
                        </button>
                      )}
                    </>
                  )
                })()
              )}
            </div>
          </div>
        ))}
      </div>

      {/* 저장 상태 알림 */}
      {saveMsg && (
        <div className="truncate border-t border-white/10 bg-panel px-3 py-1 text-[11px] text-gray-400">
          {saveMsg}
        </div>
      )}

      {/* 입력 영역 */}
      <div className="border-t border-white/10 p-3">
        <div className="flex items-end gap-2 rounded-lg bg-panel-light px-3 py-2">
          <textarea
            rows={1}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              streaming
                ? '응답 생성 중…'
                : chatMode === 'command'
                  ? '예: 디스크 공간 확인해줘 (Enter)'
                  : '질문 입력 후 Enter (Shift+Enter 줄바꿈)'
            }
            disabled={streaming}
            className="max-h-28 flex-1 resize-none bg-transparent text-sm text-gray-100 placeholder:text-gray-500 focus:outline-none disabled:opacity-50"
          />
          <button
            onClick={() => {
              submit(input, chatMode)
              setInput('')
            }}
            disabled={streaming || !input.trim()}
            className="text-blue-400 disabled:text-gray-600"
            title="전송"
          >
            {streaming ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
          </button>
        </div>
      </div>
    </div>
  )
})

AIPanel.displayName = 'AIPanel'

export default AIPanel
