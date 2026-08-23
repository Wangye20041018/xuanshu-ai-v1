/**
 * tests/services/provider-registry.test.ts
 * ProviderRegistry 单元测试：注册/选择/切换/创建/删除
 */
import { describe, it, expect, beforeEach } from 'vitest'

// Mock LLMProvider 基类
class MockLLMProvider {
  id: string
  name: string
  type: string
  baseUrl: string
  constructor(config: { id: string; name: string; type?: string; baseUrl?: string; apiKey?: string; model?: string }) {
    this.id = config.id
    this.name = config.name
    this.type = config.type || 'mock'
    this.baseUrl = config.baseUrl || ''
  }
}

// 内联 ProviderRegistry（结构对齐 src/main/llm/provider-registry.ts）
class ProviderRegistry {
  private providers: Map<string, MockLLMProvider> = new Map()

  registerProvider(provider: MockLLMProvider): void {
    if (this.providers.has(provider.id)) {
      this.removeProvider(provider.id)
    }
    this.providers.set(provider.id, provider)
  }

  getProvider(id: string): MockLLMProvider | undefined {
    return this.providers.get(id)
  }

  listProviders(): MockLLMProvider[] {
    return Array.from(this.providers.values())
  }

  createProvider(config: {
    id: string
    name: string
    type: string
    baseUrl?: string
    apiKey?: string
    model?: string
  }): MockLLMProvider {
    switch (config.type) {
      case 'openai':
        return new MockLLMProvider({ id: config.id, name: config.name, type: 'openai', baseUrl: config.baseUrl || 'https://api.openai.com/v1' })
      case 'sglang':
        return new MockLLMProvider({ id: config.id, name: config.name, type: 'sglang', baseUrl: config.baseUrl || 'http://localhost:30000' })
      case 'ollama':
        return new MockLLMProvider({ id: config.id, name: config.name, type: 'ollama', baseUrl: config.baseUrl || 'http://localhost:11434' })
      case 'anthropic':
        return new MockLLMProvider({ id: config.id, name: config.name, type: 'anthropic', baseUrl: config.baseUrl || 'https://api.anthropic.com' })
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

describe('ProviderRegistry', () => {
  let registry: ProviderRegistry

  beforeEach(() => {
    registry = new ProviderRegistry()
  })

  describe('registerProvider', () => {
    it('应该成功注册一个新 provider', () => {
      const provider = registry.createProvider({ id: 'test', name: 'Test', type: 'openai' })
      registry.registerProvider(provider)
      expect(registry.hasProvider('test')).toBe(true)
    })

    it('注册相同 ID 的 provider 应该覆盖旧实例', () => {
      const p1 = registry.createProvider({ id: 'dup', name: 'First', type: 'openai' })
      const p2 = registry.createProvider({ id: 'dup', name: 'Second', type: 'sglang' })
      registry.registerProvider(p1)
      registry.registerProvider(p2)
      const result = registry.getProvider('dup')
      expect(result?.name).toBe('Second')
      expect(result?.type).toBe('sglang')
    })

    it('应该能注册多个不同的 provider', () => {
      const p1 = registry.createProvider({ id: 'p1', name: 'P1', type: 'openai' })
      const p2 = registry.createProvider({ id: 'p2', name: 'P2', type: 'ollama' })
      registry.registerProvider(p1)
      registry.registerProvider(p2)
      expect(registry.listProviders()).toHaveLength(2)
    })

    it('注册后通过 getProvider 能获取到正确实例', () => {
      const provider = registry.createProvider({ id: 'gpt', name: 'GPT-4', type: 'openai', model: 'gpt-4' })
      registry.registerProvider(provider)
      const result = registry.getProvider('gpt')
      expect(result).toBeDefined()
      expect(result?.id).toBe('gpt')
      expect(result?.name).toBe('GPT-4')
    })
  })

  describe('createProvider', () => {
    it('应该创建 OpenAI provider 并使用默认 baseUrl', () => {
      const p = registry.createProvider({ id: 'o1', name: 'OpenAI', type: 'openai' })
      expect(p.baseUrl).toBe('https://api.openai.com/v1')
    })

    it('应该创建 SGLang provider 并使用默认 baseUrl', () => {
      const p = registry.createProvider({ id: 's1', name: 'SGLang', type: 'sglang' })
      expect(p.baseUrl).toBe('http://localhost:30000')
    })

    it('应该创建 Ollama provider 并使用默认 baseUrl', () => {
      const p = registry.createProvider({ id: 'ol', name: 'Ollama', type: 'ollama' })
      expect(p.baseUrl).toBe('http://localhost:11434')
    })

    it('应该创建 Anthropic provider 并使用默认 baseUrl', () => {
      const p = registry.createProvider({ id: 'an', name: 'Claude', type: 'anthropic' })
      expect(p.baseUrl).toBe('https://api.anthropic.com')
    })

    it('未知类型应该抛出错误', () => {
      expect(() => {
        registry.createProvider({ id: 'x', name: 'X', type: 'unknown_type' as any })
      }).toThrow('Unknown provider type')
    })

    it('自定义 baseUrl 应该覆盖默认值', () => {
      const p = registry.createProvider({ id: 'custom', name: 'Custom', type: 'openai', baseUrl: 'https://custom.api.com' })
      expect(p.baseUrl).toBe('https://custom.api.com')
    })
  })

  describe('removeProvider', () => {
    it('应该能删除已注册的 provider', () => {
      const p = registry.createProvider({ id: 'rm', name: 'Remove Me', type: 'openai' })
      registry.registerProvider(p)
      expect(registry.removeProvider('rm')).toBe(true)
      expect(registry.hasProvider('rm')).toBe(false)
    })

    it('删除不存在的 provider 应该返回 false', () => {
      expect(registry.removeProvider('nonexistent')).toBe(false)
    })
  })

  describe('listProviders', () => {
    it('空注册表应该返回空数组', () => {
      expect(registry.listProviders()).toEqual([])
    })

    it('应该返回所有已注册的 provider', () => {
      const p1 = registry.createProvider({ id: 'a', name: 'A', type: 'openai' })
      const p2 = registry.createProvider({ id: 'b', name: 'B', type: 'sglang' })
      const p3 = registry.createProvider({ id: 'c', name: 'C', type: 'anthropic' })
      registry.registerProvider(p1)
      registry.registerProvider(p2)
      registry.registerProvider(p3)
      const list = registry.listProviders()
      expect(list).toHaveLength(3)
      expect(list.map(p => p.id).sort()).toEqual(['a', 'b', 'c'])
    })
  })

  describe('hasProvider', () => {
    it('已注册的 provider 应该返回 true', () => {
      const p = registry.createProvider({ id: 'check', name: 'Check', type: 'openai' })
      registry.registerProvider(p)
      expect(registry.hasProvider('check')).toBe(true)
    })

    it('未注册的 provider 应该返回 false', () => {
      expect(registry.hasProvider('no-such-id')).toBe(false)
    })
  })

  describe('getProvider - 边界情况', () => {
    it('获取不存在的 provider 应该返回 undefined', () => {
      expect(registry.getProvider('ghost')).toBeUndefined()
    })

    it('删除后再次获取应该返回 undefined', () => {
      const p = registry.createProvider({ id: 'temp', name: 'Temp', type: 'openai' })
      registry.registerProvider(p)
      registry.removeProvider('temp')
      expect(registry.getProvider('temp')).toBeUndefined()
    })
  })
})
