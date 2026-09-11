import { app } from 'electron'
import { join } from 'path'
import {existsSync, readFileSync, writeFileSync} from 'fs'
import { createHash } from 'crypto'
import { logger } from '../../shared/logger'

type MemoryType = 'conversation' | 'preference' | 'fact' | 'experience'

interface Vector {
  id: string
  text: string
  metadata: {
    type: MemoryType | 'knowledge'
    tags: string[]
    timestamp?: number
    source?: string
    memoryId?: string
    namespace?: string
  }
  embedding: number[]
}

interface SearchResult {
  id: string
  text: string
  metadata: Vector['metadata']
  score: number
}

/** LRU 缓存节点 */
interface CacheEntry {
  key: string
  results: SearchResult[]
  prev: CacheEntry | null
  next: CacheEntry | null
}

export class LRUCache {
  private map = new Map<string, CacheEntry>()
  private head: CacheEntry | null = null
  private tail: CacheEntry | null = null
  private capacity: number

  constructor(capacity: number = 64) {
    this.capacity = capacity
  }

  get(key: string): SearchResult[] | null {
    const entry = this.map.get(key)
    if (!entry) return null
    this.moveToHead(entry)
    return entry.results
  }

  set(key: string, results: SearchResult[]): void {
    const existing = this.map.get(key)
    if (existing) {
      existing.results = results
      this.moveToHead(existing)
      return
    }

    const entry: CacheEntry = { key, results, prev: null, next: null }
    this.map.set(key, entry)
    this.addToHead(entry)

    while (this.map.size > this.capacity) {
      this.removeLRU()
    }
  }

  private moveToHead(entry: CacheEntry): void {
    if (entry === this.head) return
    this.removeNode(entry)
    this.addToHead(entry)
  }

  private addToHead(entry: CacheEntry): void {
    entry.next = this.head
    entry.prev = null
    if (this.head) this.head.prev = entry
    this.head = entry
    if (!this.tail) this.tail = entry
  }

  private removeNode(entry: CacheEntry): void {
    if (entry.prev) entry.prev.next = entry.next
    if (entry.next) entry.next.prev = entry.prev
    if (entry === this.head) this.head = entry.next
    if (entry === this.tail) this.tail = entry.prev
  }

  private removeLRU(): void {
    if (!this.tail) return
    this.map.delete(this.tail.key)
    this.removeNode(this.tail)
  }
}

export class VectorStore {
  private vectors: Map<string, Vector> = new Map()
  private indexPath: string | null = null
  private initialized: boolean = false
  private pendingWrites: number = 0
  private saveTimer: NodeJS.Timeout | null = null
  private static readonly BATCH_SIZE = 20
  private static readonly FLUSH_INTERVAL = 5000
  private static readonly MAX_VECTORS = 50000

  /** B4.4: LRU 缓存最近查询结�?*/
  private searchCache = new LRUCache(64)

  /** B4.4: 并行计算的分块大�?*/
  private static readonly PARALLEL_CHUNK_SIZE = 1000

  /** B4.4: 粗筛选阈�?*/
  private static readonly COARSE_FILTER_THRESHOLD = 20000

  /** B4.4: 粗筛选使用的�?N �?*/
  private static readonly COARSE_FILTER_DIMS = 32

  /** B4.4: 性能日志阈�?(ms) */
  private static readonly PERF_WARN_THRESHOLD_MS = 100

  constructor() {
    // 延迟初始化，等待 app ready
  }

  initialize(): void {
    if (this.initialized) return
    const dataPath = app.getPath('userData')
    this.indexPath = join(dataPath, 'vector-store.json')
    this.load()
    this.initialized = true
  }

  private getIndexPath(): string {
    if (!this.indexPath) {
      this.initialize()
    }
    return this.indexPath!
  }

  private load(): void {
    try {
      const indexPath = this.getIndexPath()
      if (existsSync(indexPath)) {
        const data = JSON.parse(readFileSync(indexPath, 'utf-8'))
        if (data._version === 1) {
          this.vectors = new Map(data.vectors || [])
        } else {
          logger.warn(`Unsupported vector store version: ${data._version}, starting fresh`)
        }
      }
    } catch (error) {
      logger.error('Failed to load vector store:', error)
    }
  }

  private flushSave(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    this.save()
    this.pendingWrites = 0
  }

  private save(): void {
    try {
      const indexPath = this.getIndexPath()
      const data = {
        _version: 1,
        vectors: Array.from(this.vectors.entries())
      }
      writeFileSync(indexPath, JSON.stringify(data, null, 2))
    } catch (error) {
      logger.error('Failed to save vector store:', error)
    }
  }

  add(id: string, text: string, embedding: number[], metadata: Vector['metadata']): void {
    if (this.vectors.size >= VectorStore.MAX_VECTORS) {
      const oldestKey = this.vectors.keys().next().value
      if (oldestKey) {
        this.vectors.delete(oldestKey)
      }
    }
    this.vectors.set(id, { id, text, metadata, embedding })

    // B4.4: 写入时清理缓存（数据已变�?
    this.searchCache = new LRUCache(64)

    this.pendingWrites++
    if (this.pendingWrites >= VectorStore.BATCH_SIZE) {
      this.flushSave()
    } else if (!this.saveTimer) {
      this.saveTimer = setTimeout(() => this.flushSave(), VectorStore.FLUSH_INTERVAL)
    }
  }

  /** B4.4: 构建缓存 key */
  private buildCacheKey(embedding: number[], topK: number, type?: string, namespace?: string): string {
    const hash = createHash('md5')
    // 使用�?32 �?+ topK + type 生成 key
    const sample = embedding.slice(0, VectorStore.COARSE_FILTER_DIMS)
    hash.update(sample.join(','))
    hash.update(`|${topK}`)
    if (type) hash.update(`|${type}`)
    if (namespace) hash.update(`|ns:${namespace}`)
    return hash.digest('hex')
  }

  search(queryEmbedding: number[], topK: number = 5, namespace?: string): SearchResult[] {
    const cacheKey = this.buildCacheKey(queryEmbedding, topK, undefined, namespace)
    const cached = this.searchCache.get(cacheKey)
    if (cached) return cached

    const startTime = performance.now()

    const vectorArray = Array.from(this.vectors.values()).filter(v =>
      namespace === undefined || namespace === '' ? true : v.metadata.namespace === namespace
    )
    const results = this.computeSimilarities(queryEmbedding, vectorArray, topK)

    const elapsed = performance.now() - startTime
    if (elapsed > VectorStore.PERF_WARN_THRESHOLD_MS) {
      logger.warn(`[VectorStore] search took ${elapsed.toFixed(1)}ms with ${this.vectors.size} vectors (topK=${topK}${namespace ? `, ns=${namespace}` : ''})`)
    }

    this.searchCache.set(cacheKey, results)
    return results
  }

  searchByType(type: MemoryType | 'knowledge', queryEmbedding: number[], topK: number = 5, namespace?: string): SearchResult[] {
    const cacheKey = this.buildCacheKey(queryEmbedding, topK, type, namespace)
    const cached = this.searchCache.get(cacheKey)
    if (cached) return cached

    const startTime = performance.now()

    const filtered = Array.from(this.vectors.values()).filter(v => {
      if (v.metadata.type !== type) return false
      if (namespace !== undefined && namespace !== '' && v.metadata.namespace !== namespace) return false
      return true
    })
    const results = this.computeSimilarities(queryEmbedding, filtered, topK)

    const elapsed = performance.now() - startTime
    if (elapsed > VectorStore.PERF_WARN_THRESHOLD_MS) {
      logger.warn(`[VectorStore] searchByType(${type}) took ${elapsed.toFixed(1)}ms with ${filtered.length} filtered vectors (topK=${topK})`)
    }

    this.searchCache.set(cacheKey, results)
    return results
  }

  /**
   * B4.4: 分块计算相似�?+ 粗筛�?
   * - 向量�?> COARSE_FILTER_THRESHOLD 时先做粗筛�?
   * - 然后分块计算精确余弦相似度（保留分块结构便于后续改为真正�?Parallel�?
   */
  private computeSimilarities(
    queryEmbedding: number[],
    vectorArray: Vector[],
    topK: number
  ): SearchResult[] {
    let candidates = vectorArray

    // 粗筛选：用前 32 维近似过�?
    if (vectorArray.length > VectorStore.COARSE_FILTER_THRESHOLD) {
      const coarseK = Math.min(vectorArray.length, Math.max(topK * 100, 5000))
      candidates = this.coarseFilter(queryEmbedding, vectorArray, coarseK)
    }

    // 分块计算精确相似�?
    const allResults: SearchResult[] = []
    const chunks = this.chunkArray(candidates, VectorStore.PARALLEL_CHUNK_SIZE)

    for (const chunk of chunks) {
      for (const vector of chunk) {
        const score = this.cosineSimilarity(queryEmbedding, vector.embedding)
        allResults.push({
          id: vector.id,
          text: vector.text,
          metadata: vector.metadata,
          score
        })
      }
    }

    return allResults
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
  }

  /** B4.4: 数组分块工具 */
  private chunkArray<T>(arr: T[], size: number): T[][] {
    const chunks: T[][] = []
    for (let i = 0; i < arr.length; i += size) {
      chunks.push(arr.slice(i, i + size))
    }
    return chunks
  }

  /**
   * B4.4: 粗筛�?�?基于�?COARSE_FILTER_DIMS 维计算近似余弦相似度
   * 选出 top coarseK 个候选，大幅减少精确计算�?
   */
  private coarseFilter(
    queryEmbedding: number[],
    vectorArray: Vector[],
    coarseK: number
  ): Vector[] {
    const queryPartial = queryEmbedding.slice(0, VectorStore.COARSE_FILTER_DIMS)

    // 预计�?queryPartial 的范�?
    let queryNorm = 0
    for (let i = 0; i < queryPartial.length; i++) {
      queryNorm += queryPartial[i] * queryPartial[i]
    }
    queryNorm = Math.sqrt(queryNorm)

    const scored: { vector: Vector; approxScore: number }[] = []

    for (const vector of vectorArray) {
      const embPartial = vector.embedding.slice(0, VectorStore.COARSE_FILTER_DIMS)
      let dotProduct = 0
      let vecNorm = 0

      for (let i = 0; i < embPartial.length; i++) {
        dotProduct += queryPartial[i] * embPartial[i]
        vecNorm += embPartial[i] * embPartial[i]
      }

      const denominator = queryNorm * Math.sqrt(vecNorm)
      const approxScore = denominator === 0 ? 0 : dotProduct / denominator
      scored.push({ vector, approxScore })
    }

    scored.sort((a, b) => b.approxScore - a.approxScore)
    return scored.slice(0, coarseK).map(s => s.vector)
  }

  delete(id: string): boolean {
    const result = this.vectors.delete(id)
    if (result) {
      // B4.4: 删除时清理缓�?
      this.searchCache = new LRUCache(64)

      this.pendingWrites++
      if (this.pendingWrites >= VectorStore.BATCH_SIZE) {
        this.flushSave()
      } else if (!this.saveTimer) {
        this.saveTimer = setTimeout(() => this.flushSave(), VectorStore.FLUSH_INTERVAL)
      }
    }
    return result
  }

  getById(id: string): Vector | undefined {
    return this.vectors.get(id)
  }

  getAll(): Vector[] {
    return Array.from(this.vectors.values())
  }

  getByType(type: MemoryType | 'knowledge'): Vector[] {
    return Array.from(this.vectors.values()).filter(v => v.metadata.type === type)
  }

  clear(): void {
    this.vectors.clear()
    this.searchCache = new LRUCache(64)
    this.flushSave()
  }

  count(): number {
    return this.vectors.size
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0

    let dotProduct = 0
    let normA = 0
    let normB = 0

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i]
      normA += a[i] * a[i]
      normB += b[i] * b[i]
    }

    const denominator = Math.sqrt(normA) * Math.sqrt(normB)
    if (denominator === 0) return 0

    return dotProduct / denominator
  }
}

export const vectorStore = new VectorStore()
export type { SearchResult, Vector, MemoryType }
