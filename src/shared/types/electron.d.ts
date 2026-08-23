/**
 * 编译期 IPC 通道类型检查
 *
 * 所有 window.api.invoke() / send() / on() 的 channel 参数
 * 必须使用 preload/index.ts 中 IpcChannels 的字面量类型。
 * 任何未注册的通道都会在编译时暴露为 TS 错误，无需人工审计。
 */
import type { IpcChannels } from '../../preload/index'

declare global {
  interface Window {
    api: {
      invoke: <T = unknown>(channel: IpcChannels, ...args: unknown[]) => Promise<T>
      invokeWithTimeout: <T = unknown>(channel: IpcChannels, timeoutMs: number, ...args: unknown[]) => Promise<T>
      send: (channel: IpcChannels, ...args: unknown[]) => void
      on: (channel: IpcChannels, callback: (event: import('electron').IpcRendererEvent, ...args: unknown[]) => void) => () => void
      once: (channel: IpcChannels, callback: (...args: unknown[]) => void) => void
      removeAllListeners: (channel: IpcChannels) => void
      // TTS 相关（渲染进程直接调用，不走 IPC）
      speechSynthesis: SpeechSynthesis
      SpeechSynthesisUtterance: typeof SpeechSynthesisUtterance
      speak: (text: string, options?: { pitch?: number; rate?: number; volume?: number; lang?: string }) => Promise<void>
      stopSpeaking: () => void
      pauseSpeaking: () => void
      resumeSpeaking: () => void
      onTtsEvent: (callback: (event: string, data?: unknown) => void) => () => void
      SpeechRecognition?: typeof SpeechRecognition
      webkitSpeechRecognition?: typeof SpeechRecognition
    }
  }
}

// SpeechRecognition 浏览器 API 类型声明
interface SpeechRecognition extends EventTarget {
  continuous: boolean
  interimResults: boolean
  lang: string
  onresult: ((event: SpeechRecognitionEvent) => void) | null
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null
  onend: (() => void) | null
  start(): void
  stop(): void
  abort(): void
}

interface SpeechRecognitionEvent extends Event {
  results: SpeechRecognitionResultList
}

interface SpeechRecognitionErrorEvent extends Event {
  error: string
  message: string
}

declare var SpeechRecognition: {
  prototype: SpeechRecognition
  new(): SpeechRecognition
}

declare var webkitSpeechRecognition: {
  prototype: SpeechRecognition
  new(): SpeechRecognition
}

export {}