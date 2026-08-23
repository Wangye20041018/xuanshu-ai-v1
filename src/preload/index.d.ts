import { electronAPI } from '@electron-toolkit/preload'

declare global {
  interface Window {
    api: {
      invoke: <T = unknown>(channel: import('./index').IpcChannels, ...args: unknown[]) => Promise<T>
      invokeWithTimeout: <T = unknown>(channel: import('./index').IpcChannels, timeoutMs: number, ...args: unknown[]) => Promise<T>
      invokeSafe: <T = unknown>(channel: import('./index').IpcChannels, ...args: unknown[]) => Promise<{ ok: boolean; data?: T; error?: string }>
      send: (channel: import('./index').IpcChannels, ...args: unknown[]) => void
      on: (channel: import('./index').IpcChannels, callback: (event: import('electron').IpcRendererEvent, ...args: unknown[]) => void) => () => void
      once: (channel: import('./index').IpcChannels, callback: (...args: unknown[]) => void) => void
      removeAllListeners: (channel: import('./index').IpcChannels) => void
      // TTS 相关
      speechSynthesis: SpeechSynthesis
      SpeechSynthesisUtterance: typeof SpeechSynthesisUtterance
      speak: (text: string, options?: { pitch?: number; rate?: number; volume?: number; lang?: string }) => Promise<void>
      stopSpeaking: () => void
      pauseSpeaking: () => void
      resumeSpeaking: () => void
      onTtsEvent: (callback: (event: string, data?: unknown) => void) => () => void
    }
  }
}
