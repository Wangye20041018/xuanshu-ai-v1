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
  floatingBallSnapToEdge: boolean
  floatingBallVoiceId: string
  floatingBallWakeMode: string
  floatingBallAutoStart: boolean
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

/* ============================================================
 * 智能体操作系统（Agent OS）IPC 返回值类型
 * 复用 shared/agent-types 的共享 schema
 * ============================================================ */

export interface AgentListResult {
  success: boolean
  data?: import('./agent-types').AgentDefinition[]
  error?: string
}

export interface AgentGetResult {
  success: boolean
  data?: import('./agent-types').AgentDefinition
  error?: string
}

export interface AgentSaveResult {
  success: boolean
  data?: import('./agent-types').AgentDefinition
  error?: string
}

export interface AgentCreatePreviewResult {
  success: boolean
  data?: import('./agent-types').AgentCreatePreview
  error?: string
}

export interface AgentWhitelistResult {
  success: boolean
  data?: import('./agent-types').WhitelistEntry[]
  error?: string
}

export interface SwarmPlanResult {
  success: boolean
  data?: import('./agent-types').SwarmTask
  error?: string
}

export interface SwarmRunResult {
  success: boolean
  data?: import('./agent-types').SwarmResult
  error?: string
}

export interface GlowConfig {
  controlGlowEnabled: boolean
  controlGlowBrightness: number
  controlGlowColor: string
  controlGlowIntensity: number
}
