/**
 * tests/ipc/model.test.ts
 * Model IPC handler 逻辑单元测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock 数据结构
interface ModelInfo {
  id: string
  name: string
  type: 'main' | 'vision' | 'embedding'
  path: string
  size: number
  status: 'idle' | 'loading' | 'loaded' | 'error'
  gpuLayers?: number
}

class ModelManager {
  private models: Map<string, ModelInfo> = new Map()

  registerModel(info: ModelInfo): boolean {
    if (this.models.has(info.id)) {
      return false // 已存在
    }
    this.models.set(info.id, { ...info, status: 'idle' })
    return true
  }

  listModels(): ModelInfo[] {
    return Array.from(this.models.values())
  }

  getModel(id: string): ModelInfo | undefined {
    return this.models.get(id)
  }

  loadModel(id: string): boolean {
    const model = this.models.get(id)
    if (!model) return false
    if (model.status === 'loaded') return true
    model.status = 'loading'
    // 模拟加载成功
    model.status = 'loaded'
    return true
  }

  unloadModel(id: string): boolean {
    const model = this.models.get(id)
    if (!model) return false
    model.status = 'idle'
    return true
  }

  getLoadedModel(): ModelInfo | undefined {
    return Array.from(this.models.values()).find(m => m.status === 'loaded')
  }

  removeModel(id: string): boolean {
    return this.models.delete(id)
  }

  getModelCount(): number {
    return this.models.size
  }
}

describe('Model IPC Handler Logic', () => {
  let manager: ModelManager

  const makeModel = (overrides?: Partial<ModelInfo>): ModelInfo => ({
    id: 'test-model',
    name: 'Test Model',
    type: 'main',
    path: '/models/test.gguf',
    size: 1024,
    status: 'idle',
    ...overrides
  })

  beforeEach(() => {
    manager = new ModelManager()
  })

  describe('registerModel', () => {
    it('应该成功注册新模型', () => {
      const result = manager.registerModel(makeModel())
      expect(result).toBe(true)
      expect(manager.getModelCount()).toBe(1)
    })

    it('重复 ID 注册应返回 false', () => {
      manager.registerModel(makeModel({ id: 'dup' }))
      const result = manager.registerModel(makeModel({ id: 'dup', name: 'Updated' }))
      expect(result).toBe(false)
    })

    it('注册后模型状态应为 idle', () => {
      manager.registerModel(makeModel())
      const model = manager.getModel('test-model')
      expect(model?.status).toBe('idle')
    })

    it('应该支持不同类型的模型注册', () => {
      manager.registerModel(makeModel({ id: 'v1', type: 'vision' }))
      manager.registerModel(makeModel({ id: 'e1', type: 'embedding' }))
      manager.registerModel(makeModel({ id: 'm1', type: 'main' }))
      expect(manager.getModelCount()).toBe(3)
    })
  })

  describe('loadModel', () => {
    it('应该成功加载已注册的模型', () => {
      manager.registerModel(makeModel())
      const result = manager.loadModel('test-model')
      expect(result).toBe(true)
      expect(manager.getModel('test-model')?.status).toBe('loaded')
    })

    it('加载不存在的模型应返回 false', () => {
      const result = manager.loadModel('nonexistent')
      expect(result).toBe(false)
    })

    it('已加载的模型再次加载应返回 true', () => {
      manager.registerModel(makeModel())
      manager.loadModel('test-model')
      const result = manager.loadModel('test-model')
      expect(result).toBe(true)
    })

    it('getLoadedModel 应返回已加载模型', () => {
      manager.registerModel(makeModel({ id: 'm1' }))
      manager.registerModel(makeModel({ id: 'm2', type: 'vision' }))
      manager.loadModel('m1')
      const loaded = manager.getLoadedModel()
      expect(loaded?.id).toBe('m1')
    })
  })

  describe('unloadModel', () => {
    it('应该成功卸载已加载模型', () => {
      manager.registerModel(makeModel())
      manager.loadModel('test-model')
      const result = manager.unloadModel('test-model')
      expect(result).toBe(true)
      expect(manager.getModel('test-model')?.status).toBe('idle')
    })

    it('卸载不存在的模型应返回 false', () => {
      expect(manager.unloadModel('ghost')).toBe(false)
    })

    it('卸载后 getLoadedModel 应返回 undefined', () => {
      manager.registerModel(makeModel())
      manager.loadModel('test-model')
      manager.unloadModel('test-model')
      expect(manager.getLoadedModel()).toBeUndefined()
    })
  })

  describe('listModels', () => {
    it('空管理器应返回空列表', () => {
      expect(manager.listModels()).toEqual([])
    })

    it('应返回所有注册模型', () => {
      manager.registerModel(makeModel({ id: 'a' }))
      manager.registerModel(makeModel({ id: 'b', type: 'vision' }))
      manager.registerModel(makeModel({ id: 'c', type: 'embedding' }))
      expect(manager.listModels()).toHaveLength(3)
    })
  })

  describe('removeModel', () => {
    it('应成功删除模型', () => {
      manager.registerModel(makeModel())
      expect(manager.removeModel('test-model')).toBe(true)
      expect(manager.getModelCount()).toBe(0)
    })

    it('删除不存在的模型应返回 false', () => {
      expect(manager.removeModel('ghost')).toBe(false)
    })
  })

  describe('边界情况', () => {
    it('连续注册-加载-卸载-删除应保持状态一致', () => {
      manager.registerModel(makeModel({ id: 'lifecycle' }))
      expect(manager.getModelCount()).toBe(1)

      manager.loadModel('lifecycle')
      expect(manager.getModel('lifecycle')?.status).toBe('loaded')

      manager.unloadModel('lifecycle')
      expect(manager.getModel('lifecycle')?.status).toBe('idle')

      manager.removeModel('lifecycle')
      expect(manager.getModelCount()).toBe(0)
    })

    it('GPU layers 配置应正确存储', () => {
      manager.registerModel(makeModel({ id: 'gpu-model', gpuLayers: 99 }))
      const model = manager.getModel('gpu-model')
      expect(model?.gpuLayers).toBe(99)
    })
  })
})
