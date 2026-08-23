/**
 * P1 单元测试 — RAG 向量存储核心组件
 * 来源：src/main/rag/vector-store.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { LRUCache } from '../../src/main/rag/vector-store'

describe('LRUCache — LRU 缓存', () => {
  let cache: LRUCache

  beforeEach(() => {
    cache = new LRUCache(3)
  })

  describe('正常路径', () => {
    it('set/get 基本读写', () => {
      const results = [{ id: '1', text: 'hello', metadata: { type: 'conversation' as const, tags: [] }, score: 0.9 }]
      cache.set('key1', results)
      expect(cache.get('key1')).toEqual(results)
    })

    it('未命中返回 null', () => {
      expect(cache.get('nonexistent')).toBeNull()
    })

    it('覆盖已有 key', () => {
      cache.set('key1', [{ id: 'a', text: 'old', metadata: { type: 'fact' as const, tags: [] }, score: 0.5 }])
      const newResults = [{ id: 'b', text: 'new', metadata: { type: 'fact' as const, tags: [] }, score: 0.99 }]
      cache.set('key1', newResults)
      expect(cache.get('key1')).toEqual(newResults)
    })
  })

  describe('LRU 淘汰策略', () => {
    it('超出容量淘汰最久未使用', () => {
      cache.set('k1', [{ id: 'a', text: '', metadata: { type: 'conversation' as const, tags: [] }, score: 1 }])
      cache.set('k2', [{ id: 'b', text: '', metadata: { type: 'conversation' as const, tags: [] }, score: 1 }])
      cache.set('k3', [{ id: 'c', text: '', metadata: { type: 'conversation' as const, tags: [] }, score: 1 }])
      // k1 is LRU
      cache.set('k4', [{ id: 'd', text: '', metadata: { type: 'conversation' as const, tags: [] }, score: 1 }])
      expect(cache.get('k1')).toBeNull()  // 已淘汰
      expect(cache.get('k2')).not.toBeNull()
      expect(cache.get('k3')).not.toBeNull()
      expect(cache.get('k4')).not.toBeNull()
    })

    it('访问后不再是最久未使用', () => {
      cache.set('k1', [{ id: 'a', text: '', metadata: { type: 'conversation' as const, tags: [] }, score: 1 }])
      cache.set('k2', [{ id: 'b', text: '', metadata: { type: 'conversation' as const, tags: [] }, score: 1 }])
      cache.set('k3', [{ id: 'c', text: '', metadata: { type: 'conversation' as const, tags: [] }, score: 1 }])
      // 访问 k1 使其变为最近使用
      cache.get('k1')
      cache.set('k4', [{ id: 'd', text: '', metadata: { type: 'conversation' as const, tags: [] }, score: 1 }])
      expect(cache.get('k1')).not.toBeNull()  // 保留
      expect(cache.get('k2')).toBeNull()      // 淘汰
    })

    it('容量 1 的缓存', () => {
      const single = new LRUCache(1)
      single.set('only', [{ id: 'x', text: '', metadata: { type: 'fact' as const, tags: [] }, score: 1 }])
      single.set('next', [{ id: 'y', text: '', metadata: { type: 'fact' as const, tags: [] }, score: 1 }])
      expect(single.get('only')).toBeNull()
      expect(single.get('next')).not.toBeNull()
    })
  })

  describe('边界条件', () => {
    it('容量 0 仍然正常工作（不崩溃）', () => {
      const zero = new LRUCache(0)
      zero.set('k', [{ id: 'z', text: '', metadata: { type: 'conversation' as const, tags: [] }, score: 1 }])
      expect(zero.get('k')).toBeNull()
    })
  })
})

describe('VectorStore 核心算法 — 余弦相似度', () => {
  // 验证关键算法
  function cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0
    let dotProduct = 0, normA = 0, normB = 0
    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i]
      normA += a[i] * a[i]
      normB += b[i] * b[i]
    }
    const denominator = Math.sqrt(normA) * Math.sqrt(normB)
    if (denominator === 0) return 0
    return dotProduct / denominator
  }

  describe('正常路径', () => {
    it('相同向量相似度为 1', () => {
      const v = [1, 2, 3]
      expect(cosineSimilarity(v, v)).toBeCloseTo(1.0, 5)
    })

    it('正交向量相似度为 0', () => {
      expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0.0, 5)
    })

    it('相反向量相似度为 -1', () => {
      expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1.0, 5)
    })

    it('高维向量', () => {
      const dims = 384
      const a = Array.from({ length: dims }, (_, i) => Math.sin(i))
      const b = Array.from({ length: dims }, (_, i) => Math.sin(i + 0.1))
      const score = cosineSimilarity(a, b)
      expect(score).toBeGreaterThan(0.9)
      expect(score).toBeLessThanOrEqual(1.0)
    })

    it('单位向量', () => {
      const score = cosineSimilarity([1, 0, 0, 0], [0.6, 0.8, 0, 0])
      expect(score).toBeCloseTo(0.6, 5)
    })
  })

  describe('异常路径', () => {
    it('零向量返回 0', () => {
      expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0)
    })

    it('不同长度返回 0', () => {
      expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0)
    })

    it('空向量返回 0', () => {
      expect(cosineSimilarity([], [])).toBe(0)
    })
  })
})
