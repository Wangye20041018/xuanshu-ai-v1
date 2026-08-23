/**
 * IPC 返回值类型定义
 * 替代 invoke<any>() 模式，提供编译期类型安全
 */
export interface ConfigData {
  autoUpdate: boolean
  sendStats: boolean
  autoStart: boolean
  systemPrompt: string
  userProfile: string
  voiceExitWord: string
  voiceExitConfirmWords: string
  voiceExitCancelWords: string
  voiceExitConfirmTTS: string
  voiceContinuousMode: boolean
  appVersion: string
  electronVersion: string
  buildDate?: string
  cloudApiKey: string
  cloudApiUrl: string
  cloudModelName: string
  defaultModelId: string
  startupModelId: string
  orbTheme: string
  orbSize: number
  floatingBallEnabled: boolean
  orbEnabled: boolean
  webSearchEnabled: boolean
  voiceprintId?: string
  noiseFilterOn?: boolean
  noiseLevel?: number
}

export interface ModelRegistryEntry {
  id: string
  name: string
  modelPath: string
}

export interface TandemStatusItem {
  status: string
  [key: string]: unknown
}

export interface TandemConfig {
  models?: Array<{ id: string; [key: string]: unknown }>
  [key: string]: unknown
}

export interface PermissionItem {
  id: string
  name: string
  granted: boolean
}

export interface PermissionStatus {
  permissions: PermissionItem[]
  allGranted: boolean
  requiredGranted: boolean
}
