/* ============================================================
 * 统一工具注册中心
 * 将所有分散的工具（插件引擎、动态操作、搜索、视觉、知识库、语音）
 * 注册到统一的 ToolRegistry，供 Agent 调用
 * ============================================================ */

import { ToolDefinition, ToolResult } from './types'
import { logger } from '../../shared/logger'

export class ToolRegistry {
  private tools: Map<string, ToolDefinition> = new Map()
  private stats: Map<string, { calls: number; errors: number; totalDuration: number }> = new Map()

  /** 注册单个工具 */
  register(tool: ToolDefinition): void {
    if (this.tools.has(tool.name)) {
      logger.warn(`[ToolRegistry] 工具 "${tool.name}" 已存在，将被覆盖`)
    }
    this.tools.set(tool.name, tool)
    this.stats.set(tool.name, { calls: 0, errors: 0, totalDuration: 0 })
    logger.info(`[ToolRegistry] 注册工具: ${tool.name} (${tool.category})`)
  }

  /** 批量注册 */
  registerAll(tools: ToolDefinition[]): void {
    for (const tool of tools) {
      this.register(tool)
    }
  }

  /** 获取单个工具 */
  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name)
  }

  /** 获取所有工具 */
  getAll(): ToolDefinition[] {
    return Array.from(this.tools.values())
  }

  /** 获取所有已启用工具（可指定子集 ids 过滤） */
  getEnabled(ids?: string[]): ToolDefinition[] {
    if (!ids) return this.getAll()
    const set = new Set(ids)
    return this.getAll().filter(t => set.has(t.name))
  }

  /** 按分类获取工具 */
  getByCategory(category: ToolDefinition['category']): ToolDefinition[] {
    return this.getAll().filter(t => t.category === category)
  }

  /** 获取 Function Calling 格式的工具列表（注入到 LLM 请求），可指定子集 */
  getFunctionCallingTools(ids?: string[]): Array<{
    type: 'function'
    function: {
      name: string
      description: string
      parameters: ToolDefinition['parameters']
    }
  }> {
    return this.getEnabled(ids).map(tool => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }))
  }

  /** 执行工具 */
  async execute(name: string, params: Record<string, unknown>): Promise<ToolResult> {
    const tool = this.tools.get(name)
    if (!tool) {
      return { success: false, error: `工具 "${name}" 不存在` }
    }

    const startTime = Date.now()
    const stat = this.stats.get(name)!

    try {
      const result = await tool.execute(params)
      const duration = Date.now() - startTime
      stat.calls++
      stat.totalDuration += duration
      return { ...result, duration }
    } catch (err) {
      const duration = Date.now() - startTime
      stat.errors++
      stat.totalDuration += duration
      logger.error(`[ToolRegistry] 工具 "${name}" 执行失败:`, err)
      return { success: false, error: String(err), duration }
    }
  }

  /** 获取工具统计 */
  getStats(): Array<{ name: string; category: string; calls: number; errors: number; avgDuration: number }> {
    return this.getAll().map(tool => {
      const stat = this.stats.get(tool.name)!
      return {
        name: tool.name,
        category: tool.category,
        calls: stat.calls,
        errors: stat.errors,
        avgDuration: stat.calls > 0 ? Math.round(stat.totalDuration / stat.calls) : 0,
      }
    })
  }

  /** 移除工具 */
  unregister(name: string): boolean {
    this.stats.delete(name)
    return this.tools.delete(name)
  }

  /** 工具数量 */
  get size(): number {
    return this.tools.size
  }

  /** 清空 */
  clear(): void {
    this.tools.clear()
    this.stats.clear()
  }
}

// 全局单例
export const toolRegistry = new ToolRegistry()

/* ============================================================
 * 工具注册 deps
 * ============================================================ */

interface ToolDeps {
  dynamicOperationEngine?: any
  knowledgeGraph?: any
  vectorStore?: any
  voiceEngine?: any
  internetSearch?: any
}

/** 注册联网搜索工具：复用 internetSearch.getTools() 的 function-calling schema */
function registerSearchTools(internetSearch: any): void {
  const fts: Array<{ function: { name: string; description: string; parameters: any } }> =
    (internetSearch.getTools && internetSearch.getTools()) || []

  const executors: Record<string, (params: Record<string, unknown>) => Promise<ToolResult>> = {
    web_search: async (p) => ({
      success: true,
      data: await internetSearch.search(String(p.query || ''), {
        count: Number(p.count) || 10,
        language: String(p.language || 'zh-CN'),
      }),
    }),
    fetch_webpage: async (p) => ({
      success: true,
      data: await internetSearch.fetchUrl(String(p.url || '')),
    }),
    get_weather: async (p) => ({
      success: true,
      data: await internetSearch.getWeather(String(p.city || '')),
    }),
    get_exchange_rate: async (p) => ({
      success: true,
      data: await internetSearch.getExchangeRate(String(p.from || ''), String(p.to || '')),
    }),
    get_news: async (p) => ({
      success: true,
      data: await internetSearch.getNews(String(p.query || ''), Number(p.count) || 5),
    }),
    get_current_time: async () => ({
      success: true,
      data: await internetSearch.getCurrentTime(),
    }),
  }

  for (const ft of fts) {
    const { name, description, parameters } = ft.function || {}
    const executor = name ? executors[name] : undefined
    if (!name || !executor) continue
    toolRegistry.register({ name, description, category: 'search', parameters, execute: executor })
  }

  // RAG 搜索（联网搜索 + 抓取正文 + 存入本地知识库）
  if (typeof internetSearch.searchWithRAG === 'function') {
    toolRegistry.register({
      name: 'search_with_rag',
      description: '联网搜索并抓取相关网页正文，将结果写入本地知识库（RAG），返回搜索结果与已入库的知识片段。',
      category: 'search',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词' },
          count: { type: 'number', description: '结果数量，默认 10' },
        },
        required: ['query'],
      },
      execute: async (p) => ({
        success: true,
        data: await internetSearch.searchWithRAG(String(p.query || ''), {
          count: Number(p.count) || 10,
        }),
      }),
    })
  }
}

/** 注册记忆检索工具：文本 → 嵌入向量 → vectorStore 检索 */
function registerMemoryTools(vectorStore: any): void {
  const embedQuery = async (text: string): Promise<number[]> => {
    const { getEmbedding } = await import('../rag/embedding')
    const { embedding } = await getEmbedding(text)
    return embedding
  }

  toolRegistry.register({
    name: 'search_memories',
    description: '语义检索本地记忆（对话/偏好/事实），返回与查询最相关的内容片段。',
    category: 'knowledge',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索查询' },
        topK: { type: 'number', description: '返回条数，默认 5' },
      },
      required: ['query'],
    },
    execute: async (p) => {
      try {
        const embedding = await embedQuery(String(p.query || ''))
        const results = vectorStore.search(embedding, Number(p.topK) || 5)
        return { success: true, data: results }
      } catch (e) {
        return { success: false, error: String(e) }
      }
    },
  })

  toolRegistry.register({
    name: 'search_memories_by_type',
    description: '按类型（conversation/preference/fact/knowledge）语义检索本地记忆。',
    category: 'knowledge',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索查询' },
        type: { type: 'string', description: '记忆类型', enum: ['conversation', 'preference', 'fact', 'knowledge'] },
        topK: { type: 'number', description: '返回条数，默认 5' },
      },
      required: ['query', 'type'],
    },
    execute: async (p) => {
      try {
        const embedding = await embedQuery(String(p.query || ''))
        const results = vectorStore.searchByType(String(p.type || 'fact'), embedding, Number(p.topK) || 5)
        return { success: true, data: results }
      } catch (e) {
        return { success: false, error: String(e) }
      }
    },
  })
}

/**
 * 注册所有 ReAct 工具（由 modules.register 在启动时调用）。
 * 依赖各模块的既有能力；无干净可调用导出方法的模块跳过对应工具。
 */
export function registerAllTools(deps: ToolDeps = {}): void {
  const { dynamicOperationEngine, knowledgeGraph, vectorStore, voiceEngine, internetSearch } = deps

  // ===== 搜索类 =====
  if (internetSearch) {
    try { registerSearchTools(internetSearch) } catch (e) { logger.warn('[ToolRegistry] 搜索工具注册失败:', e) }
  }

  // ===== 知识图谱类 =====
  if (knowledgeGraph) {
    if (typeof knowledgeGraph.query === 'function') {
      toolRegistry.register({
        name: 'query_knowledge_graph',
        description: '查询本地知识图谱，返回与关键词相关的实体与关系。',
        category: 'knowledge',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string', description: '查询关键词' } },
          required: ['query'],
        },
        execute: async (p) => {
          try { return { success: true, data: knowledgeGraph.query(String(p.query || '')) } }
          catch (e) { return { success: false, error: String(e) } }
        },
      })
    }
    if (typeof knowledgeGraph.searchEntities === 'function') {
      toolRegistry.register({
        name: 'search_entities',
        description: '在知识图谱中按名称/别名模糊搜索实体。',
        category: 'knowledge',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '实体名称或别名' },
            type: { type: 'string', description: '实体类型（可选）' },
            limit: { type: 'number', description: '返回条数，默认 20' },
          },
          required: ['query'],
        },
        execute: async (p) => {
          try {
            const data = knowledgeGraph.searchEntities(String(p.query || ''), {
              type: p.type ? String(p.type) : undefined,
              limit: Number(p.limit) || 20,
            })
            return { success: true, data }
          } catch (e) { return { success: false, error: String(e) } }
        },
      })
    }
  }

  // ===== 记忆检索类 =====
  if (vectorStore) {
    try { registerMemoryTools(vectorStore) } catch (e) { logger.warn('[ToolRegistry] 记忆工具注册失败:', e) }
  }

  // ===== 视觉/桌面控制类（危险工具：内部已有 confirmExecute 人工确认门） =====
  toolRegistry.register({
    name: 'control_computer',
    description: '驱动电脑执行视觉自动化任务（截图→视觉识别→鼠标/键盘操作），可打开应用、点击、输入文本等。',
    category: 'vision',
    dangerous: true,
    parameters: {
      type: 'object',
      properties: {
        intent: { type: 'string', description: '要完成的操作目标，如「打开记事本并输入 hello」' },
        maxSteps: { type: 'number', description: '最大执行步数，默认 20' },
      },
      required: ['intent'],
    },
    execute: async (p) => {
      try {
        // 延迟导入，避免循环依赖与启动期重模块加载
        const { visualAgent } = await import('../visual-agent')
        const res = await visualAgent.executeTask({
          id: `tool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          intent: String(p.intent || ''),
          maxSteps: Number(p.maxSteps) || 20,
        })
        return { success: res.success, data: res, error: res.error || undefined }
      } catch (e) {
        return { success: false, error: String(e) }
      }
    },
  })

  // ===== 任务分析类 =====
  if (dynamicOperationEngine && typeof dynamicOperationEngine.analyzeAndPlan === 'function') {
    toolRegistry.register({
      name: 'analyze_task',
      description: '分析用户需求，生成分步执行计划（供桌面自动化任务使用）。',
      category: 'operation',
      parameters: {
        type: 'object',
        properties: { request: { type: 'string', description: '用户需求描述' } },
        required: ['request'],
      },
      execute: async (p) => {
        try {
          const plan = await dynamicOperationEngine.analyzeAndPlan(String(p.request || ''))
          return { success: true, data: plan }
        } catch (e) { return { success: false, error: String(e) } }
      },
    })
  }

  // ===== 语音类 =====
  if (voiceEngine && typeof voiceEngine.synthesize === 'function') {
    toolRegistry.register({
      name: 'speak',
      description: '将文本转换为语音并播放。',
      category: 'voice',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', description: '要朗读的文本' } },
        required: ['text'],
      },
      execute: async (p) => {
        try {
          await voiceEngine.synthesize(String(p.text || ''))
          return { success: true }
        } catch (e) { return { success: false, error: String(e) } }
      },
    })
  }

  // ===== 自我改造只读工具（ReAct 侧仅开放只读，写操作走流程页人工确认） =====
  try { registerSelfModifyReadonlyTools() } catch (e) { logger.warn('[ToolRegistry] 自我改造只读工具注册失败:', e) }

  logger.info(`[ToolRegistry] 工具注册完成，共 ${toolRegistry.size} 个`)
}

/**
 * 注册自我改造的 3 个只读工具（category: 'system'）。
 * 仅允许"列文件 / 读源码 / 预览 diff"，不开放任何写操作给 ReAct 自动循环。
 */
function registerSelfModifyReadonlyTools(): void {
  toolRegistry.register({
    name: 'self_modify_list_files',
    description: '列出自我改造白名单目录内的源码文件清单（只读，不修改任何文件）。可选传 dir 限定子目录。',
    category: 'system',
    parameters: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: '可选，限定子目录，如 src/renderer/pages' },
      },
      required: [],
    },
    execute: async (p) => {
      try {
        const { selfModifyService } = await import('../self-modify/self-modify.service')
        return { success: true, data: selfModifyService.listFiles(p.dir ? String(p.dir) : undefined) }
      } catch (e) {
        return { success: false, error: String(e) }
      }
    },
  })

  toolRegistry.register({
    name: 'self_modify_read_file',
    description: '读取白名单内单个源码文件内容（只读），返回内容与截断标记。',
    category: 'system',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对仓库根的文件路径，如 src/renderer/pages/Home/index.tsx' },
      },
      required: ['path'],
    },
    execute: async (p) => {
      try {
        const { selfModifyService } = await import('../self-modify/self-modify.service')
        return { success: true, data: selfModifyService.readFile(String(p.path || '')) }
      } catch (e) {
        return { success: false, error: String(e) }
      }
    },
  })

  toolRegistry.register({
    name: 'self_modify_preview_diff',
    description: '对给定变更集生成 diff 预览（只生成 diff，不写入文件），返回增删行与风险级别。',
    category: 'system',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: '改动摘要' },
        files: { type: 'array', description: '变更文件列表 [{path, content, mode}]' },
      },
      required: ['files'],
    },
    execute: async (p) => {
      try {
        const { selfModifyService } = await import('../self-modify/self-modify.service')
        const files = Array.isArray(p.files)
          ? (p.files as Array<{ path?: unknown; content?: unknown; mode?: unknown }>).map((f) => ({
              path: String(f.path || ''),
              content: String(f.content || ''),
              mode: (f.mode === 'patch' ? 'patch' : 'overwrite') as 'patch' | 'overwrite',
            }))
          : []
        const { result, error } = selfModifyService.previewDiff({
          summary: String(p.summary || ''),
          files,
        })
        if (error) return { success: false, error }
        return { success: true, data: result }
      } catch (e) {
        return { success: false, error: String(e) }
      }
    },
  })
}