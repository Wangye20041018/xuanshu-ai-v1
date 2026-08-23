import { ipcMain } from 'electron'
import { vectorStore, type SearchResult, type Vector } from './vector-store'
import { getEmbedding, splitText } from './embedding'
import { addMemorySync, deleteMemorySync } from '../ipc/memory.ipc'
import { logger } from '../../shared/logger'

export { vectorStore }

/**
 * 语义检索对话记忆 + 知识库（供 chat 主链路注入上下文）。
 * chat.ipc 以 ragModule.searchContext?.(userMsg, { topK }) 调用；
 * 此前该导出缺失导致对话记忆检索静默失败（memoryItems 恒为空）。
 */
export async function searchContext(
  query: string,
  options: { topK?: number } = {}
): Promise<{ items: Array<{ id: string; content: string; score: number; type: string }> }> {
  try {
    const { embedding } = await getEmbedding(query)
    const results = vectorStore.search(embedding, options.topK ?? 5)
    return {
      items: results.map(r => ({
        id: r.id,
        content: r.text,
        score: r.score,
        type: r.metadata.type,
      })),
    }
  } catch (error) {
    logger.error('[RAG] searchContext failed:', error)
    return { items: [] }
  }
}

/** Memory 模块的三种类型 */
const MEMORY_TYPES = ['conversation', 'preference', 'fact'] as const

export function setupRAGHandlers(): void {
  ipcMain.handle('rag:add-memory', async (_event, content: string, tags: string[] = [], memoryType: 'conversation' | 'preference' | 'fact' = 'conversation') => {
    try {
      const chunks = splitText(content)
      const results = []

      // 先同步到 Memory 模块，获取 memoryId 用于后续删除同步
      let memoryId: string | null = null
      try {
        const mem = addMemorySync({
          content: content.substring(0, 500),
          type: memoryType,
          tags
        })
        memoryId = mem.id
      } catch (e) {
        logger.error('[RAG] 同步到Memory模块失败:', e)
      }

      for (const chunk of chunks) {
        const { embedding } = await getEmbedding(chunk)
        const id = `memory-${Date.now()}-${Math.random()}`
        vectorStore.add(id, chunk, embedding, {
          type: memoryType,
          tags,
          timestamp: Date.now(),
          memoryId: memoryId || undefined
        })
        results.push(id)
      }

      return { success: true, ids: results }
    } catch (error) {
      logger.error('Failed to add memory:', error)
      return { error: String(error) }
    }
  })

  ipcMain.handle('rag:add-knowledge', async (_event, content: string, tags: string[] = [], source?: string) => {
    try {
      const chunks = splitText(content)
      const results = []

      for (const chunk of chunks) {
        const { embedding } = await getEmbedding(chunk)
        const id = `knowledge-${Date.now()}-${Math.random()}`
        vectorStore.add(id, chunk, embedding, {
          type: 'knowledge',
          tags,
          source
        })
        results.push(id)
      }

      return { success: true, ids: results }
    } catch (error) {
      logger.error('Failed to add knowledge:', error)
      return { error: String(error) }
    }
  })

  ipcMain.handle('rag:search', async (_event, query: string, topK: number = 5) => {
    try {
      const { embedding } = await getEmbedding(query)
      const results = vectorStore.search(embedding, topK)
      return results
    } catch (error) {
      logger.error('Failed to search:', error)
      return []
    }
  })

  ipcMain.handle('rag:search-memory', async (_event, query: string, topK: number = 5) => {
    try {
      const { embedding } = await getEmbedding(query)
      // 跨所有 MemoryType 搜索（conversation / preference / fact）
      const results: SearchResult[] = []
      for (const mt of MEMORY_TYPES) {
        const partial = vectorStore.searchByType(mt, embedding, topK)
        results.push(...partial)
      }
      // 按 score 降序取 topK
      return results.sort((a, b) => b.score - a.score).slice(0, topK)
    } catch (error) {
      logger.error('Failed to search memory:', error)
      return []
    }
  })

  ipcMain.handle('rag:search-knowledge', async (_event, query: string, topK: number = 5) => {
    try {
      const { embedding } = await getEmbedding(query)
      const results = vectorStore.searchByType('knowledge', embedding, topK)
      return results
    } catch (error) {
      logger.error('Failed to search knowledge:', error)
      return []
    }
  })

  ipcMain.handle('rag:delete', (_event, id: string) => {
    try {
      // 删除前获取向量元数据，提取 memoryId
      const vector = vectorStore.getById(id)
      const memoryId = vector?.metadata?.memoryId

      const result = vectorStore.delete(id)

      // 同步删除 Memory 模块中的对应记录
      if (result && memoryId) {
        try {
          deleteMemorySync(memoryId)
        } catch (e) {
          logger.error('[RAG] 同步删除Memory失败:', e)
        }
      }

      return result
    } catch (error) {
      logger.error('rag:delete error:', error)
      return false
    }
  })

  ipcMain.handle('rag:list-memories', () => {
    try {
      // 跨所有 MemoryType 合并结果
      const all: Vector[] = []
      for (const mt of MEMORY_TYPES) {
        all.push(...vectorStore.getByType(mt))
      }
      return all.sort((a, b) => (b.metadata.timestamp || 0) - (a.metadata.timestamp || 0))
    } catch (error) {
      logger.error('rag:list-memories error:', error)
      return []
    }
  })

  ipcMain.handle('rag:list-knowledge', () => {
    try {
      return vectorStore.getByType('knowledge')
    } catch (error) {
      logger.error('rag:list-knowledge error:', error)
      return []
    }
  })

  ipcMain.handle('rag:get-context', async (_event, query: string, topK: number = 5) => {
    try {
      const { embedding } = await getEmbedding(query)
      const results = vectorStore.search(embedding, topK)

      const context = results
        .filter(r => r.score > 0.5)
        .map(r => `[${r.metadata.type}] ${r.text}`)
        .join('\n\n')

      return {
        context,
        sources: results.map(r => ({
          id: r.id,
          text: r.text.substring(0, 100) + '...',
          score: r.score,
          type: r.metadata.type
        }))
      }
    } catch (error) {
      logger.error('Failed to get context:', error)
      return { context: '', sources: [] }
    }
  })

  ipcMain.handle('rag:stats', () => {
    try {
      let memories = 0
      for (const mt of MEMORY_TYPES) {
        memories += vectorStore.getByType(mt).length
      }
      return {
        total: vectorStore.count(),
        memories,
        knowledge: vectorStore.getByType('knowledge').length
      }
    } catch (error) {
      logger.error('rag:stats error:', error)
      return { total: 0, memories: 0, knowledge: 0 }
    }
  })

  ipcMain.handle('rag:clear', () => {
    try {
      vectorStore.clear()
      return { success: true }
    } catch (error) {
      logger.error('rag:clear error:', error)
      return { success: false, error: String(error) }
    }
  })
}
