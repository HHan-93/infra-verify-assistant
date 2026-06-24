import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron/simple'

// vite-plugin-electron 을 사용하면 `vite` (= npm run dev) 한 번으로
// 1) React 렌더러 dev 서버 기동, 2) Electron 메인/프리로드 번들 빌드,
// 3) Electron 앱 자동 실행까지 모두 처리됩니다.
export default defineConfig(({ command }) => ({
  // 패키징(설치본) 시 file:// 로 로드되므로 상대경로(./) 필수.
  // 개발 서버(serve)에서는 절대경로(/) 사용.
  base: command === 'serve' ? '/' : './',
  plugins: [
    react(),
    electron({
      // ── Electron 메인 프로세스 ──────────────────────────────
      main: {
        entry: 'electron/main.ts',
        vite: {
          build: {
            // CJS(.js)로 고정 출력 → package.json 의 "main": "dist-electron/main.js" 와 일치
            rollupOptions: {
              // ssh2(네이티브 모듈) / @anthropic-ai/sdk(대형 의존성)는 번들에 포함하지 않고
              // 런타임에 node_modules 에서 require 하도록 external 처리
              external: ['ssh2', '@anthropic-ai/sdk', '@google/genai', 'openai', 'node-pty'],
              output: { format: 'cjs', entryFileNames: 'main.js' },
            },
          },
        },
      },
      // ── 프리로드 스크립트 (contextBridge 로 안전하게 API 노출) ──
      preload: {
        input: 'electron/preload.ts',
        vite: {
          build: {
            rollupOptions: {
              output: { format: 'cjs', entryFileNames: 'preload.js' },
            },
          },
        },
      },
    }),
  ],
}))
