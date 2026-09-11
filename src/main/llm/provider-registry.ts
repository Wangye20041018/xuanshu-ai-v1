import { LLMProvider, SGLangProvider, OpenAIProvider, OllamaProvider, AnthropicProvider, LocalCPUProvider } from './provider'
import { LocalGPUProvider } from './local-gpu-provider'
import { logger } from '../../shared/logger'

class ProviderRegistry {
  private providers: Map<string, LLMProvider> = new Map()

  registerProvider(provider: LLMProvider): void {
    if (this.providers.has(provider.id)) {
      logger.warn(`[ProviderRegistry] 覆盖已存在的 Provider: ${provider.id}`)
      // 非关键操作，失败可安全忽略
      try { this.removeProvider(provider.id) } catch { /* ignore */ }
    }
    this.providers.set(provider.id, provider)
  }

  getProvider(id: string): LLMProvider | undefined {
    return this.providers.get(id)
  }

  listProviders(): LLMProvider[] {
    return Array.from(this.providers.values())
  }

  createProvider(config: {
    id: string
    name: string
    type: string
    baseUrl?: string
    apiKey?: string
    model?: string
  }): LLMProvider {
    switch (config.type) {
      case 'sglang':
        return new SGLangProvider({
          id: config.id,
          name: config.name,
          baseUrl: config.baseUrl || 'http://localhost:30000',
          model: config.model || 'llama3'
        })

      case 'openai':
        return new OpenAIProvider({
          id: config.id,
          name: config.name,
          baseUrl: config.baseUrl || 'https://api.openai.com/v1',
          apiKey: config.apiKey || '',
          model: config.model || 'gpt-4'
        })

      case 'ollama':
        return new OllamaProvider({
          id: config.id,
          name: config.name,
          baseUrl: config.baseUrl || 'http://localhost:11434',
          model: config.model || 'llama3'
        })

      case 'anthropic':
        return new AnthropicProvider({
          id: config.id,
          name: config.name,
          baseUrl: config.baseUrl || 'https://api.anthropic.com',
          apiKey: config.apiKey || '',
          model: config.model || 'claude-3-opus-20240229'
        })

      case 'localcpu':
        return new LocalCPUProvider({
          id: config.id,
          name: config.name,
        })

      case 'localgpu':
        // v10.2 质量档（Qwen2-VL-2B）经 node-llama-cpp 全量加载的 provider
        return new LocalGPUProvider({
          id: config.id,
          name: config.name,
        })

      default:
        throw new Error(`Unknown provider type: ${config.type}`)
    }
  }

  removeProvider(id: string): boolean {
    return this.providers.delete(id)
  }

  hasProvider(id: string): boolean {
    return this.providers.has(id)
  }
}

export const LLMProviderRegistry = new ProviderRegistry()
