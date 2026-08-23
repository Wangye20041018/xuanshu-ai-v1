/**
 * 核心模块接口层 — 解耦模块间单例隐式依赖
 * 
 * 所有跨模块引用应通过此接口定义约束，而非直接 import 具体实现类。
 * 各模块实现类需实现对应接口，并在 index.ts 注册时注入。
 *
 * @module interfaces
 * @since v10.1.2
 */

// ---- 模型管理 ----

export interface ModelInfo {
  id: string
  name: string
  type: 'main' | 'vision' | 'embedding'
  file: string
  size: number
  status: 'installed' | 'not_installed' | 'downloading' | 'error'
  gpuLayers?: number
  tier?: 'fast' | 'quality' | 'vision'
  progress?: number
  description?: string
}

export interface IModelManager {
  getCurrentModel(): ModelInfo | null
  getModel(id: string): ModelInfo | undefined
  getAllModels(): ModelInfo[]
  loadModel(id: string): Promise<boolean>
  unloadModel(id: string): void
  scanResourceModels(): ModelInfo[]
  isModelLoaded(id: string): boolean
}

// ---- 推理引擎 ----

export interface IInferenceEngine {
  chat(modelId: string, message: string, options?: ChatOptions): Promise<ChatResponse>
  chatStream(modelId: string, message: string, options?: ChatOptions): AsyncGenerator<string>
  isReady(): boolean
  getStats(): InferenceStats
  unload(): void
}

export interface ChatOptions {
  systemPrompt?: string
  temperature?: number
  maxTokens?: number
  topP?: number
  history?: ChatMessage[]
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatResponse {
  content: string
  tokensUsed: number
  finishReason: 'stop' | 'length' | 'abort'
}

export interface InferenceStats {
  totalTokens: number
  tokensPerSecond: number
  elapsedMs: number
}

// ---- 语音引擎 ----

export interface IVoiceEngine {
  speak(text: string, voiceId?: string): Promise<{ success: boolean; audioPath?: string }>
  getVoices(): Promise<VoiceInfo[]>
  getSettings(): VoiceSettings
  cloneVoice(audioBase64: string): Promise<{ success: boolean; voiceId?: string }>
  deleteVoice(id: string): boolean
}

export interface VoiceInfo {
  id: string
  name: string
  type: 'preset' | 'cloned' | 'system'
  language: string
  gender?: 'male' | 'female'
  embeddingPath?: string
}

export interface VoiceSettings {
  currentVoiceId: string
  speed: number
  pitch: number
  volume: number
}

// ---- Python 运行时 ----

export interface IPythonRuntime {
  initialize(): Promise<PythonEnv | null>
  reinitialize(): Promise<PythonEnv | null>
  isReady(): boolean
  getPath(): string | null
  execute(script: string): Promise<string>
  getEnv(): PythonEnv | null
}

export interface PythonEnv {
  path: string
  version: string
  packages: string[]
  ready: boolean
}

// ---- 权限管理 ----

export interface IPermissionManager {
  check(permission: string): boolean
  grant(permission: string): void
  revoke(permission: string): void
  list(): string[]
}

// ---- 对话管理 ----

export interface IChatSession {
  id: string
  title: string
  modelId: string
  personaId: string
  messages: ChatMessage[]
  createdAt: number
  updatedAt: number
}

export interface IChatManager {
  createSession(modelId: string, personaId?: string): IChatSession
  getSession(id: string): IChatSession | undefined
  listSessions(): IChatSession[]
  deleteSession(id: string): void
  addMessage(sessionId: string, message: ChatMessage): void
  sendMessage(sessionId: string, content: string): Promise<ChatResponse>
}