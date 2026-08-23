interface ChatMessage {
  id: string
  content: string
  isUser: boolean
  timestamp: number
}

interface Conversation {
  id: string
  title: string
  messages: ChatMessage[]
  createdAt: number
}

interface ProviderConfig {
  id: string
  name: string
  type: 'openai' | 'anthropic' | 'google' | 'ollama' | 'custom'
  baseUrl?: string
  apiKey?: string
  models: string[]
}

interface VoiceConfig {
  voicePack: string
  speed: number
  pitch: number
  volume: number
}

interface AppConfig {
  theme: 'dark' | 'light'
  providers: ProviderConfig[]
  voice: VoiceConfig
  wakeWord: string
  wakeWordEnabled: boolean
  wakeWordSensitivity: number
  phoneSyncEnabled: boolean
}

export type { ChatMessage, Conversation, ProviderConfig, VoiceConfig, AppConfig }
