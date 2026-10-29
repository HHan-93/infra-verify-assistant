/// <reference types="vite/client" />
import type { ElectronAPI } from '../electron/preload'

// 프리로드에서 contextBridge 로 노출한 API 의 타입을 window 에 연결
declare global {
  /** vite.config.ts define — package.json 의 version */
  const __APP_VERSION__: string
  interface Window {
    electronAPI: ElectronAPI
  }
}

export {}
