/**
 * context-manager 类型定义（v1.0）
 *
 * 上下文压缩模块：滑动窗口 + nomic-embed 向量检索 → 拼装 → 推理
 */

/** 标准化消息格式（对齐 OpenAI ChatML） */
export interface ContextMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
  /** 消息唯一标识（用于向量检索去重） */
  id?: string
  /** 时间戳（用于滑动窗口排序） */
  timestamp?: number
}

/** 向量检索命中结果 */
export interface SearchResult {
  /** 命中的消息 */
  message: ContextMessage
  /** 余弦相似度分数（0~1） */
  score: number
  /** 在原始历史中的索引位置 */
  index: number
}

/** 拼装器配置 */
export interface AssemblyConfig {
  /** 滑动窗口保留最近 N 轮对话（默认 10） */
  windowSize: number
  /** 向量检索召回 top-K 条（默认 5） */
  retrievalTopK: number
  /** 最大上下文 token 数（≤ n_ctx） */
  maxTokens: number
  /** 系统提示词 */
  systemPrompt?: string
}

/** 拼装结果 */
export interface AssemblyResult {
  /** 最终拼装的消息列表 */
  messages: ContextMessage[]
  /** 召回的历史片段数 */
  retrievedCount: number
  /** 窗口内轮数 */
  windowRounds: number
  /** 估算总 token 数 */
  estimatedTokens: number
  /** 是否触发截断 */
  truncated: boolean
}

/** 嵌入向量（nomic-embed 输出 768 维） */
export type EmbeddingVector = number[]

/** 嵌入器配置 */
export interface EmbedderConfig {
  /** nomic-embed 模型路径 */
  modelPath: string
  /** 嵌入维度（nomic-embed-text-v1.5 = 768） */
  dimensions: number
  /** 最大批量大小 */
  maxBatchSize: number
}

/** 向量存储条目 */
export interface VectorEntry {
  id: string
  message: ContextMessage
  embedding: EmbeddingVector
  index: number
  timestamp: number
}

/** 上下文管理器状态（供外部查询） */
export interface ContextManagerState {
  historySize: number
  vectorStoreSize: number
  windowSize: number
  retrievalTopK: number
  lastAssemblyTime: number
}
