import Anthropic from '@anthropic-ai/sdk'
import { GoogleGenAI } from '@google/genai'
import OpenAI from 'openai'
import type { AIProvider, ChatMessage } from './shared-types'

// ─────────────────────────────────────────────────────────────
// AI 프로바이더 추상화
//  - provider 별로 다른 SDK 를 쓰지만, 동일한 onText 콜백으로 스트리밍 텍스트를 흘려보낸다.
//  - 메인 프로세스(main.ts)는 streamChat 한 함수만 호출하면 된다.
// ─────────────────────────────────────────────────────────────

export interface StreamChatOptions {
  provider: AIProvider
  apiKey: string
  model: string
  system: string
  messages: ChatMessage[]
  /** 응답 텍스트 조각이 생성될 때마다 호출 */
  onText: (text: string) => void
}

export async function streamChat(opts: StreamChatOptions): Promise<void> {
  switch (opts.provider) {
    case 'anthropic':
      return streamAnthropic(opts)
    case 'gemini':
      return streamGemini(opts)
    case 'openai':
      return streamOpenAI(opts)
    default:
      throw new Error(`지원하지 않는 프로바이더: ${opts.provider}`)
  }
}

// ── Anthropic (Claude) ────────────────────────────────────────
/**
 * adaptive thinking 을 받는 모델인가 — Opus/Sonnet 4.6 이상, 그리고 5 세대부터.
 * 예전에는 모든 모델에 무조건 붙여 보내, 기본 목록에 있는 claude-haiku-4-5(와 '불러오기' 로 받은
 * 옛 모델)를 고르면 **모든 요청이 400 으로 실패**했다. 모르는 이름은 붙이지 않는 쪽으로 둔다 —
 * 생각 없이 답하는 것은 실패보다 낫다.
 */
function supportsAdaptiveThinking(model: string): boolean {
  const m = /claude-([a-z]+)-(\d+)(?:-(\d+))?/i.exec(model)
  if (!m) return false
  const family = m[1].toLowerCase()
  const major = Number(m[2])
  const minor = m[3] !== undefined && m[3].length <= 2 ? Number(m[3]) : 0
  if (major >= 5) return true
  if (major === 4 && minor >= 6) return family !== 'haiku'
  return false
}

async function streamAnthropic({ apiKey, model, system, messages, onText }: StreamChatOptions) {
  const client = new Anthropic({ apiKey })
  // 긴 입력/출력 대비 스트리밍. 복잡한 분석이므로 받는 모델이면 adaptive thinking 활성화.
  // 생각에 쓰는 토큰도 max_tokens 에서 나가므로, 켤 때는 넉넉히 둔다 — 4096 이면 상세 분석이
  // 생각만 하다 텍스트 없이 끝나 빈 답이 남았다.
  const thinking = supportsAdaptiveThinking(model)
  const stream = client.messages.stream({
    model,
    max_tokens: thinking ? 16000 : 4096,
    ...(thinking ? { thinking: { type: 'adaptive' as const } } : {}),
    system,
    messages,
  })
  stream.on('text', (delta) => onText(delta))
  const final = await stream.finalMessage()
  // 길이 한도로 잘렸으면 조용히 끝내지 않고 밝힌다 — 잘린 분석을 다 읽은 결론으로 오해하지 않게
  if (final.stop_reason === 'max_tokens') onText('\n\n_(응답이 길이 한도에서 잘렸습니다)_')
}

// ── Google (Gemini) ───────────────────────────────────────────
async function streamGemini({ apiKey, model, system, messages, onText }: StreamChatOptions) {
  const ai = new GoogleGenAI({ apiKey })
  const stream = await ai.models.generateContentStream({
    model,
    // Gemini 는 assistant 역할을 'model' 로 표현
    contents: messages.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    })),
    config: { systemInstruction: system },
  })
  for await (const chunk of stream) {
    const text = chunk.text
    if (text) onText(text)
  }
}

// ── OpenAI (GPT) ──────────────────────────────────────────────
async function streamOpenAI({ apiKey, model, system, messages, onText }: StreamChatOptions) {
  const client = new OpenAI({ apiKey })
  const stream = await client.chat.completions.create({
    model,
    stream: true,
    messages: [
      { role: 'system', content: system },
      ...messages.map((m) => ({ role: m.role, content: m.content })),
    ],
  })
  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content
    if (delta) onText(delta)
  }
}

// ─────────────────────────────────────────────────────────────
// 키로 실제 사용 가능한 모델 목록 조회
//  - 잘못된 키면 여기서 인증 오류가 발생(상위에서 메시지 표시)
// ─────────────────────────────────────────────────────────────
export async function listModels(provider: AIProvider, apiKey: string): Promise<string[]> {
  switch (provider) {
    case 'anthropic': {
      const client = new Anthropic({ apiKey })
      const out: string[] = []
      for await (const m of client.models.list()) out.push(m.id)
      return out
    }
    case 'openai': {
      const client = new OpenAI({ apiKey })
      const out: string[] = []
      for await (const m of client.models.list()) out.push(m.id)
      // 채팅 계열(gpt*, o1/o3/o4*, chatgpt*)만 추려서 정렬
      return out
        .filter((id) => /^(gpt|chatgpt)/.test(id) || /^o\d/.test(id))
        .sort()
    }
    case 'gemini': {
      const ai = new GoogleGenAI({ apiKey })
      const out: string[] = []
      const pager = await ai.models.list()
      for await (const m of pager) {
        const name = (m.name ?? '').replace(/^models\//, '')
        // generateContent 를 지원하는 모델만(임베딩/이미지 등 제외)
        const methods =
          (m as { supportedActions?: string[] }).supportedActions ??
          (m as { supportedGenerationMethods?: string[] }).supportedGenerationMethods
        if (name && (!methods || methods.includes('generateContent'))) out.push(name)
      }
      return out
    }
    default:
      return []
  }
}
