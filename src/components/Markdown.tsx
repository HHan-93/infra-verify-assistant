import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

/**
 * AI 응답용 마크다운 렌더러 (다크 테마).
 *  - GFM(표, 체크박스, 취소선 등) 지원
 *  - 코드블록 가로 스크롤, 인라인 코드 강조
 *  - 링크는 기본 브라우저로 열기(Electron shell), 앱 네비게이션 방지
 */

const components: Components = {
  h1: ({ children }) => <h1 className="mb-2 mt-1 text-base font-bold text-gray-100">{children}</h1>,
  h2: ({ children }) => <h2 className="mb-1.5 mt-2 text-sm font-bold text-gray-100">{children}</h2>,
  h3: ({ children }) => <h3 className="mb-1 mt-2 text-[13px] font-semibold text-gray-200">{children}</h3>,
  p: ({ children }) => <p className="my-1.5 leading-relaxed">{children}</p>,
  ul: ({ children }) => <ul className="my-1.5 list-disc space-y-0.5 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="my-1.5 list-decimal space-y-0.5 pl-5">{children}</ol>,
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  strong: ({ children }) => <strong className="font-semibold text-white">{children}</strong>,
  em: ({ children }) => <em className="italic text-gray-200">{children}</em>,
  a: ({ children, href }) => (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault()
        if (href) window.electronAPI.openExternal(href)
      }}
      className="text-blue-400 underline hover:text-blue-300"
    >
      {children}
    </a>
  ),
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-white/20 pl-3 text-gray-400">{children}</blockquote>
  ),
  hr: () => <hr className="my-3 border-white/10" />,
  pre: ({ children }) => (
    <pre className="my-2 overflow-x-auto rounded-md bg-black/40 p-2 text-xs leading-relaxed">
      {children}
    </pre>
  ),
  code: ({ className, children }) => {
    const text = String(children)
    const isBlock = (className?.startsWith('language-') ?? false) || text.includes('\n')
    if (isBlock) {
      // <pre> 가 컨테이너 스타일을 담당하므로 여기선 폰트만
      return <code className="font-mono text-gray-100">{children}</code>
    }
    return (
      <code className="rounded bg-black/40 px-1 py-0.5 font-mono text-[12px] text-pink-200">
        {children}
      </code>
    )
  },
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table className="w-full border-collapse text-xs">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-white/15 bg-white/5 px-2 py-1 text-left font-semibold">{children}</th>
  ),
  td: ({ children }) => <td className="border border-white/15 px-2 py-1">{children}</td>,
}

export default function Markdown({ content }: { content: string }) {
  return (
    <div className="text-[13px] text-gray-100">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  )
}
