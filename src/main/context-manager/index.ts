/**
 * 上下文管理器（v1.0）
 *
 * 职责：
 *  1. 滑动窗口：保留最近 N 轮对话全文（默认 N=10）
 *  2. 向量检索：用 nomic-embed 对历史消息做嵌入，查询时召回 top-5 相关片段
 *  3. 拼装器：合并「召回片段 + 最近 N 轮 + 当前消息」，总 token 数 ≤ n_ctx
 *  4. 对接 model-manager 的推理接口
 */

import {
  ContextMessage,
  SearchResult,
  AssemblyConfig,
  AssemblyResult,
  VectorEntry,
  ContextManagerState,
} from './types'
import { nomicEmbedder, cosineSimilarity } from './embedder'
import { logger } from '../../shared/logger'
import { app } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'

/** 默认拼装配置 */
const DEFAULT_CONFIG: AssemblyConfig = {
  windowSize: 10,
  retrievalTopK: 5,
  maxTokens: 8192,
}

export class ContextManager {
  private config: AssemblyConfig
  /** 向量存储（按时间排序的嵌入向量 + 消息） */
  private vectorStore: VectorEntry[] = []
  /** 对话历史（全部消息，包括已生成嵌入的） */
  private history: ContextMessage[] = []
  /** 消息计数器 */
  private messageCounter: number = 0
  /** 上次拼装时间 */
  private lastAssemblyTime: number = 0
  /** 已嵌入的最大索引（防止重复嵌入） */
  private lastEmbeddedIndex: number = -1
  /** 持久化路径（userData/context-manager/history.json） */
  private historyPath: string | null = null
  /** 落盘防抖定时器 */
  private saveTimer: NodeJS.Timeout | null = null
  private static readonly SAVE_DEBOUNCE_MS = 1500
  private static readonly PERSIST_VERSION = 1

  constructor(config?: Partial<AssemblyConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /* ==========================================================
   * 公共接口
   * ========================================================== */

  /**
   * 添加消息到历史（推理完成后调用，保存助手回复）
   */
  addMessage(message: ContextMessage): void {
    const enriched: ContextMessage = {
      ...message,
      id: message.id || `msg_${++this.messageCounter}`,
      timestamp: message.timestamp || Date.now(),
    }
    this.history.push(enriched)
    this.scheduleSave()
  }

  /**
   * 批量添加消息
   */
  addMessages(messages: ContextMessage[]): void {
    for (const msg of messages) {
      this.addMessage(msg)
    }
  }

  /**
   * 核心方法：拼装上下文
   *
   * 流程：
   *  1. 将新的用户消息嵌入
   *  2. 对未嵌入的历史消息批量嵌入
   *  3. 检索 top-K 相关历史片段
   *  4. 取最近 N 轮滑动窗口
   *  5. 合并：系统提示词 → 检索片段 → 最近 N 轮 → 当前消息
   *  6. token 预算控制
   *
   * @param currentMessage 当前用户消息
   * @param systemPrompt  系统提示词（可选，覆盖配置中的默认值）
   */
  async assemble(
    currentMessage: ContextMessage,
    systemPrompt?: string
  ): Promise<AssemblyResult> {

    // 1. 确保当前消息已嵌入（用于检索查询）
    const queryEmbedding = await this.embedMessage(currentMessage)

    // 2. 对未嵌入的历史消息批量嵌入
    await this.embedPendingMessages()

    // 3. 检索 top-K 相关片段
    const retrieved = await this.retrieve(queryEmbedding)

    // 4. 滑动窗口：最近 N 轮
    const windowMsgs = this.getWindowMessages()

    // 5. 合并拼装
    const finalMessages = this.merge(
      currentMessage,
      retrieved,
      windowMsgs,
      systemPrompt || this.config.systemPrompt
    )

    // 6. token 预算控制
    const truncated = this.truncateIfNeeded(finalMessages)

    this.lastAssemblyTime = Date.now()

    // 估算 token 数（粗略：中文 ~2 字符/token，英文 ~4 字符/token）
    const estimatedTokens = finalMessages.reduce(
      (sum, m) => sum + Math.ceil(m.content.length / 2.5),
      0
    )

    return {
      messages: finalMessages,
      retrievedCount: retrieved.length,
      windowRounds: Math.ceil(windowMsgs.length / 2),
      estimatedTokens,
      truncated,
    }
  }

  /**
   * 直接检索（不拼装，用于调试）
   */
  async search(query: string, topK: number = 5): Promise<SearchResult[]> {
    const embedding = await nomicEmbedder.embed(query)
    return this.retrieve(embedding, topK)
  }

  /**
   * 清空历史
   */
  clear(): void {
    this.history = []
    this.vectorStore = []
    this.lastEmbeddedIndex = -1
    this.messageCounter = 0
    this.persistNow()
  }

  /* ==========================================================
   * 持久化（跨会话恢复）
   * ========================================================== */

  /**
   * 初始化持久化：加载历史对话（重启后跨会话恢复）。
   * 由主进程模块注册阶段调用，应用启动后立即生效。
   */
  initialize(): void {
    try {
      const dir = join(app.getPath('userData'), 'context-manager')
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      this.historyPath = join(dir, 'history.json')
      this.loadPersisted()
    } catch (e) {
      logger.error('[ContextManager] initialize 失败:', e)
    }
  }

  /**
   * 从磁盘恢复历史对话（仅文本；向量在下次 assemble 时按需重建嵌入）
   */
  private loadPersisted(): void {
    try {
      if (!this.historyPath || !existsSync(this.historyPath)) return
      const raw = JSON.parse(readFileSync(this.historyPath, 'utf-8'))
      if (!raw || raw._version !== ContextManager.PERSIST_VERSION) {
        logger.warn('[ContextManager] 持久化版本不兼容，重置历史')
        return
      }
      if (Array.isArray(raw.history)) {
        this.history = raw.history
        this.messageCounter = this.history.length
        this.lastEmbeddedIndex = -1
        logger.info(`[ContextManager] 已恢复 ${this.history.length} 条历史对话（跨会话持久化）`)
      }
    } catch (e) {
      logger.error('[ContextManager] 加载历史失败:', e)
    }
  }

  /**
   * 立即落盘
   */
  private persistNow(): void {
    try {
      if (!this.historyPath) {
        this.initialize()
        if (!this.historyPath) return
      }
      const data = {
        _version: ContextManager.PERSIST_VERSION,
        savedAt: Date.now(),
        history: this.history,
      }
      writeFileSync(this.historyPath, JSON.stringify(data, null, 2))
    } catch (e) {
      logger.error('[ContextManager] 保存历史失败:', e)
    }
  }

  /**
   * 防抖落盘（批量添加时避免频繁写盘）
   */
  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.persistNow()
    }, ContextManager.SAVE_DEBOUNCE_MS)
  }

  /**
   * 获取管理器状态
   */
  getState(): ContextManagerState {
    return {
      historySize: this.history.length,
      vectorStoreSize: this.vectorStore.length,
      windowSize: this.config.windowSize,
      retrievalTopK: this.config.retrievalTopK,
      lastAssemblyTime: this.lastAssemblyTime,
    }
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<AssemblyConfig>): void {
    this.config = { ...this.config, ...config }
  }

  /* ==========================================================
   * 内部方法
   * ========================================================== */

  /**
   * 嵌入单条消息（如果已有缓存则用缓存，否则新建）
   */
  private async embedMessage(message: ContextMessage): Promise<number[]> {
    // 先检查向量存储中是否已有
    const existing = this.vectorStore.find(
      (e) => e.message.id === message.id && e.message.content === message.content
    )
    if (existing) return existing.embedding

    // 新建嵌入
    const embedding = await nomicEmbedder.embed(message.content)
    const entry: VectorEntry = {
      id: message.id || `msg_${Date.now()}`,
      message,
      embedding,
      index: this.history.length,
      timestamp: message.timestamp || Date.now(),
    }
    this.vectorStore.push(entry)
    return embedding
  }

  /**
   * 批量嵌入未处理的历史消息
   */
  private async embedPendingMessages(): Promise<void> {
    const pending = this.history.slice(this.lastEmbeddedIndex + 1)
    if (pending.length === 0) return

    const texts = pending.map((m) => m.content)
    try {
      const embeddings = await nomicEmbedder.batchEmbed(texts)
      for (let i = 0; i < pending.length; i++) {
        const msg = pending[i]
        const entry: VectorEntry = {
          id: msg.id || `msg_${this.messageCounter + i + 1}`,
          message: msg,
          embedding: embeddings[i],
          index: this.lastEmbeddedIndex + 1 + i,
          timestamp: msg.timestamp || Date.now(),
        }
        this.vectorStore.push(entry)
      }
      this.lastEmbeddedIndex = this.history.length - 1
      logger.debug(`[ContextManager] 批量嵌入完成: ${pending.length} 条消息`)
    } catch (error) {
      logger.error('[ContextManager] 批量嵌入失败:', error)
    }
  }

  /**
   * 向量检索：余弦相似度排序 + top-K
   */
  private retrieve(
    queryEmbedding: number[],
    topK?: number
  ): SearchResult[] {
    const k = topK || this.config.retrievalTopK
    if (this.vectorStore.length === 0) return []

    const scored: SearchResult[] = this.vectorStore.map((entry) => ({
      message: entry.message,
      score: cosineSimilarity(queryEmbedding, entry.embedding),
      index: entry.index,
    }))

    // 按分数降序排序
    scored.sort((a, b) => b.score - a.score)

    // 去重：相同内容只保留最高分
    const seen = new Set<string>()
    const deduped: SearchResult[] = []
    for (const item of scored) {
      const key = item.message.content.slice(0, 100)
      if (!seen.has(key)) {
        seen.add(key)
        deduped.push(item)
        if (deduped.length >= k) break
      }
    }

    return deduped
  }

  /**
   * 滑动窗口：取最近 N 轮对话
   * 一轮 = user + assistant 配对
   */
  private getWindowMessages(): ContextMessage[] {
    const n = this.config.windowSize
    // 从最后往前找 N 个 user 消息
    const userIndices: number[] = []
    for (let i = this.history.length - 1; i >= 0 && userIndices.length < n; i--) {
      if (this.history[i].role === 'user') {
        userIndices.push(i)
      }
    }

    if (userIndices.length === 0) return []

    // 最早保留的 user 索引
    const earliestUserIdx = userIndices[userIndices.length - 1]
    // 从该 user 开始的所有后续消息（包括 assistant 回复）
    return this.history.slice(earliestUserIdx)
  }

  /**
   * 合并：系统提示词 → 检索片段 → 最近 N 轮 → 当前消息
   */
  private merge(
    currentMessage: ContextMessage,
    retrieved: SearchResult[],
    windowMsgs: ContextMessage[],
    systemPrompt?: string
  ): ContextMessage[] {
    const result: ContextMessage[] = []

    // 1. 系统提示词
    if (systemPrompt) {
      result.push({ role: 'system', content: systemPrompt })
    }

    // 2. 检索到的历史片段（作为 system 注入上下文）
    if (retrieved.length > 0) {
      const retrievedText = retrieved
        .map(
          (r, i) =>
            `[历史片段${i + 1} 相似度:${r.score.toFixed(3)}] ${r.message.role}: ${r.message.content}`
        )
        .join('\n')
      result.push({
        role: 'system',
        content: `以下是从历史对话中检索到的相关内容，供参考：\n${retrievedText}`,
      })
    }

    // 3. 最近 N 轮窗口（去重：排除已出现在检索结果中的消息）
    const retrievedIds = new Set(retrieved.map((r) => r.message.id))
    const filteredWindow = windowMsgs.filter((m) => !retrievedIds.has(m.id))
    result.push(...filteredWindow)

    // 4. 当前消息
    result.push(currentMessage)

    return result
  }

  /**
   * Token 预算控制：超过 maxTokens 时从最早的消息开始截断
   * 简单估算：中文 ~2.5 字符/token
   */
  private truncateIfNeeded(messages: ContextMessage[]): boolean {
    const maxChars = this.config.maxTokens * 2.5
    let totalChars = 0
    const keepFrom: number[] = []

    // 从后往前累加，保留尽可能多的最新消息
    for (let i = messages.length - 1; i >= 0; i--) {
      const msgChars = messages[i].content.length
      if (totalChars + msgChars <= maxChars) {
        totalChars += msgChars
        keepFrom.unshift(i)
      } else {
        // 如果当前消息是 system 且是第一条，强制保留
        if (i === 0 && messages[i].role === 'system') {
          keepFrom.unshift(i)
        }
        break
      }
    }

    if (keepFrom.length < messages.length) {
      const removed = messages.length - keepFrom.length
      // 原地截断（保留 keepFrom 索引的条目）
      const kept = keepFrom.map((i) => messages[i])
      messages.length = 0
      messages.push(...kept)
      logger.debug(`[ContextManager] Token 预算截断: 移除 ${removed} 条消息`)
      return true
    }

    return false
  }
}

/** 默认单例 */
export const contextManager = new ContextManager()
