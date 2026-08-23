/**
 * RAG IPC Handlers — 检索增强生成
 *
 * 基于向量存储 (VectorStore) 提供文档索引和语义检索能力。
 * 支持：
 * - rag:search — 语义搜索文档片段
 * - rag:add-document — 添加文档到索引
 * - rag:remove-document — 移除文档
 * - rag:rebuild-index — 重建索引
 * - rag:count — 查询索引条目数
 * - rag:get-document — 按 ID 获取文档
 *
 * @module ipc/rag
 */

import { ipcMain } from 'electron'
import { vectorStore } from '../rag/vector-store'
import { logger } from '../../shared/logger'

const MODULE_NAME = 'RAG'

export function setupRAGHandlers(): void {
  // 确保 VectorStore 已初始化
  try {
    vectorStore.initialize()
  } catch (e) {
    logger.error(`[${MODULE_NAME}] VectorStore 初始化失败:`, e)
  }

  // rag:search — 语义搜索
  ipcMain.handle('rag:search', async (_event, params: {
    embedding: number[]
    topK?: number
    type?: 'conversation' | 'preference' | 'fact' | 'knowledge'
  }) => {
    try {
      if (!params?.embedding || !Array.isArray(params.embedding) || params.embedding.length === 0) {
        return { success: false, error: 'embedding 参数无效：需要非空数值数组' }
      }
      const topK = params.topK ?? 5
      const results = params.type
        ? vectorStore.searchByType(params.type, params.embedding, topK)
        : vectorStore.search(params.embedding, topK)
      return { success: true, results, total: vectorStore.count() }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.error(`[${MODULE_NAME}] rag:search 失败:`, msg)
      return { success: false, error: msg }
    }
  })

  // rag:add-document — 添加文档到向量索引
  ipcMain.handle('rag:add-document', async (_event, params: {
    id: string
    text: string
    embedding: number[]
    metadata: {
      type: 'conversation' | 'preference' | 'fact' | 'knowledge'
      tags?: string[]
      timestamp?: number
      source?: string
      memoryId?: string
    }
  }) => {
    try {
      if (!params?.id || !params?.text || !params?.embedding) {
        return { success: false, error: '缺少必填字段: id / text / embedding' }
      }
      vectorStore.add(
        params.id,
        params.text,
        params.embedding,
        {
          type: params.metadata?.type ?? 'knowledge',
          tags: params.metadata?.tags ?? [],
          timestamp: params.metadata?.timestamp ?? Date.now(),
          source: params.metadata?.source,
          memoryId: params.metadata?.memoryId,
        },
      )
      return { success: true, id: params.id, count: vectorStore.count() }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.error(`[${MODULE_NAME}] rag:add-document 失败:`, msg)
      return { success: false, error: msg }
    }
  })

  // rag:remove-document — 移除文档
  ipcMain.handle('rag:remove-document', async (_event, params: { id: string }) => {
    try {
      if (!params?.id) {
        return { success: false, error: '缺少 id 参数' }
      }
      const removed = vectorStore.delete(params.id)
      return { success: removed, id: params.id, count: vectorStore.count() }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.error(`[${MODULE_NAME}] rag:remove-document 失败:`, msg)
      return { success: false, error: msg }
    }
  })

  // rag:rebuild-index — 重建索引（清空后重新初始化）
  ipcMain.handle('rag:rebuild-index', async () => {
    try {
      const previousCount = vectorStore.count()
      vectorStore.clear()
      // 触发 persist 刷新
      try { vectorStore.initialize() } catch { /* 已初始化则跳过 */ }
      return {
        success: true,
        previousCount,
        currentCount: vectorStore.count(),
        message: `索引已重建（清空 ${previousCount} 条记录）`,
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.error(`[${MODULE_NAME}] rag:rebuild-index 失败:`, msg)
      return { success: false, error: msg }
    }
  })

  // rag:count — 查询索引条目数
  ipcMain.handle('rag:count', async () => {
    return { success: true, count: vectorStore.count() }
  })

  // rag:get-document — 按 ID 获取文档
  ipcMain.handle('rag:get-document', async (_event, params: { id: string }) => {
    try {
      if (!params?.id) {
        return { success: false, error: '缺少 id 参数' }
      }
      const doc = vectorStore.getById(params.id)
      if (!doc) {
        return { success: false, error: `文档 ${params.id} 未找到` }
      }
      return { success: true, document: doc }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.error(`[${MODULE_NAME}] rag:get-document 失败:`, msg)
      return { success: false, error: msg }
    }
  })

  logger.info(`[${MODULE_NAME}] RAG IPC handlers registered (6 handlers)`)
}
