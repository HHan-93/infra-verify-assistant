import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

/** 마크다운 리포트를 인쇄/PDF 저장용 정적 HTML 문서로 변환 (앱 다크 테마 대신 밝은 문서 스타일) */
export function buildReportHtml(content: string, title: string): string {
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const body = renderToStaticMarkup(<ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>)
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<title>${esc(title)}</title>
<style>
  body { font-family: "Malgun Gothic", "Segoe UI", -apple-system, sans-serif; color:#1f2937; line-height:1.6; padding:36px; max-width:800px; margin:0 auto; }
  h1,h2,h3 { color:#111827; margin-top:1.3em; margin-bottom:0.5em; }
  h1 { font-size:20px; border-bottom:2px solid #e5e7eb; padding-bottom:6px; }
  h2 { font-size:16px; }
  h3 { font-size:14px; }
  p { margin:0.6em 0; }
  ul, ol { padding-left:1.4em; }
  li { margin:0.2em 0; }
  code { background:#f3f4f6; padding:1px 4px; border-radius:3px; font-family:Consolas, monospace; font-size:0.9em; }
  pre { background:#f3f4f6; padding:10px 12px; border-radius:6px; overflow-x:auto; }
  pre code { background:none; padding:0; }
  table { border-collapse:collapse; width:100%; margin:0.8em 0; font-size:0.9em; }
  th, td { border:1px solid #d1d5db; padding:6px 8px; text-align:left; }
  th { background:#f3f4f6; }
  blockquote { border-left:3px solid #d1d5db; margin:0.8em 0; padding-left:12px; color:#6b7280; }
  hr { border:none; border-top:1px solid #e5e7eb; margin:1.2em 0; }
  .report-header { color:#6b7280; font-size:12px; margin-bottom:18px; }
</style>
</head>
<body>
  <div class="report-header">${esc(title)} · 생성: ${esc(new Date().toLocaleString('ko-KR'))}</div>
  ${body}
</body>
</html>`
}
