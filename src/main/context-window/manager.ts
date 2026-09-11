/**
 * 上下文窗口管理器
 *
 * 四层上下文结构：
 *   L0 — 系统层（固定，system prompt）
 *   L1 — 记忆层（从向量存储检索注入的长期记忆）
 *   L2 — 历史层（滑动窗口 + 可压缩的对话历史）
 *   L3 — 当前层（固定，当前轮次用户消息）
 *
 * L2 历史消息占总窗口超过 50% 时，标记 needCompression 供压缩器介入。
 */

// tiktoken 为可选依赖，不存在时使用字符估算兜底
let tiktokenModule: any = null;
try {
  tiktokenModule = require('tiktoken');
} catch {
  // tiktoken not installed, will use fallback heuristic
}
import { createLogger } from '../../shared/logger';
import type { CompressionStats, ConversationCompressor, LocalInferenceFn } from './compressor';
import { memorySkeleton, sessionSummaryStore } from './structured-memory';

const logger = createLogger('ContextWindowManager');

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

export interface ContextLayer {
  name: string;
  tokens: number;
  content: string;
  /** 0-10，数字越大越不能裁剪 */
  priority: number;
  /** 该层是否可以被裁剪/压缩 */
  trimmable: boolean;
}

export interface ContextStats {
  systemTokens: number;
  memoryTokens: number;
  historyTokens: number;
  currentTokens: number;
  /** 当前上下文已用总 token 数（system+memory+history+current） */
  usedTokens: number;
  totalTokens: number;
  /** 上下文窗口上限 token 数（已按模型 contextSize/显存预算对齐） */
  maxTokens: number;
  /** 当前轮输入 token 数（L3 当前层） */
  currentInputTokens: number;
  /** 历史压缩比例 0-1，未压缩时为 0 */
  compressionRatio: number;
  /** 已压缩的对话轮次数量 */
  compressedRounds: number;
}

export interface BuildContextResult {
  messages: ChatMessage[];
  stats: ContextStats;
  needCompression: boolean;
}

export interface AutoCompressConfig {
  /** 触发压缩的上下文占用阈值（0-1，默认 0.7 = 70%） */
  threshold: number;
  /** 压缩时保留最近 N 轮对话不压缩 */
  keepRecent: number;
  /** 是否全时段启用压缩（true=所有场景，false=仅代码/长文档场景） */
  alwaysOn: boolean;
}

export interface CompressTriggerResult {
  triggered: boolean;
  /** 压缩后的消息列表（未触发时返回原列表） */
  messages: ChatMessage[];
  /** 压缩统计（未触发时为 null） */
  stats?: CompressionStats;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface MemoryItem {
  id: string;
  content: string;
  score?: number;
}

// ---------------------------------------------------------------------------
// 上下文窗口管理器
// ---------------------------------------------------------------------------

export class ContextWindowManager {
  private maxTokens: number;
  private tokenizer: any;
  private stats: ContextStats;
  /** 标记是否需要压缩 */
  private needCompression: boolean = false;
  /** 自动压缩配置 */
  private autoCompressConfig: AutoCompressConfig;

  constructor(maxTokens: number = 128_000) {
    this.maxTokens = maxTokens;
    if (tiktokenModule) {
    this.tokenizer = tiktokenModule.encoding_for_model('gpt-4');
  } else {
    this.tokenizer = null;
    logger.info('tiktoken 未安装，使用字符计数估算 token 数');
  }
    this.stats = this.emptyStats();
    this.autoCompressConfig = {
      threshold: 0.7,
      keepRecent: 4,
      alwaysOn: true,
    };
    logger.info(`ContextWindowManager created. maxTokens=${maxTokens}`);
  }

  // -------------------------------------------------------------------------
  // 构建上下文
  // -------------------------------------------------------------------------

  buildContext(
    messages: ChatMessage[],
    systemPrompt: string,
    memoryItems: MemoryItem[],
    structured?: { skeleton?: string; summaries?: string },
  ): BuildContextResult {
    this.needCompression = false;
    const layers: ContextLayer[] = [];

    // ---- L0：系统层（固定） ----
    const systemTokens = this.countTokens(systemPrompt);
    layers.push({
      name: 'L0-system',
      tokens: systemTokens,
      content: systemPrompt,
      priority: 10,
      trimmable: false,
    });

    // ---- L0.5：全局骨架层（MEMORY.md，结构化组包 · 上下文常驻内存注入） ----
    // 三层结构化组包第 1 层：全局骨架（工程/用户常驻记忆）。放内存，注入组包，不随压缩删除。
    const extraSystemContent: ChatMessage[] = [];
    if (structured?.skeleton) {
      // 精简重塑 v1：常驻骨架注入设字符上限，防止 MEMORY.md 长期累积挤占内存窗口
      const SKELETON_MAX_CHARS = 3000
      const rawSkeleton = structured.skeleton.length > SKELETON_MAX_CHARS
        ? structured.skeleton.slice(0, SKELETON_MAX_CHARS) + '…(骨架超限截断)'
        : structured.skeleton
      const skeletonText = `[Global Memory / MEMORY.md]:\n${rawSkeleton}`;
      const skeletonTokens = this.countTokens(skeletonText);
      layers.push({
        name: 'L0.5-global-memory',
        tokens: skeletonTokens,
        content: skeletonText,
        priority: 9,
        trimmable: false,
      });
      extraSystemContent.push({ role: 'system', content: skeletonText });
    }

    // ---- L0.6：会话摘要层（压缩触发摘要 + 运行记录，RAM 常驻注入） ----
    if (structured?.summaries) {
      // 精简重塑 v1：会话摘要注入上限，保留最近摘要、截断陈旧累积
      const SUMMARIES_MAX_CHARS = 2400
      const rawSummaries = structured.summaries.length > SUMMARIES_MAX_CHARS
        ? structured.summaries.slice(-SUMMARIES_MAX_CHARS) + '…(旧摘要超限截断)'
        : structured.summaries
      const summaryText = `[Session Summaries]:\n${rawSummaries}`;
      const summaryTokens = this.countTokens(summaryText);
      layers.push({
        name: 'L0.6-session-summary',
        tokens: summaryTokens,
        content: summaryText,
        priority: 7,
        trimmable: true, // 超阈兜底时可裁剪会话摘要层
      });
      extraSystemContent.push({ role: 'system', content: summaryText });
    }

    // ---- L1：记忆层 ----
    const memoryText = this.formatMemoryItems(memoryItems);
    const memoryTokens = this.countTokens(memoryText);
    layers.push({
      name: 'L1-memory',
      tokens: memoryTokens,
      content: memoryText,
      priority: 8,
      trimmable: true, // 紧急时可裁剪低分记忆
    });

    // ---- L2：历史层（滑动窗口） ----
    // 分离当前轮次与历史
    let currentMessages: ChatMessage[] = [];
    let historyMessages: ChatMessage[] = [];

    if (messages.length > 0) {
      // 最后一轮 user 消息视为 L3 当前层
      const lastUserIdx = this.findLastUserIndex(messages);
      if (lastUserIdx >= 0) {
        currentMessages = messages.slice(lastUserIdx);
        historyMessages = messages.slice(0, lastUserIdx);
      } else {
        // 没有 user 消息，全部放入历史
        historyMessages = messages;
      }
    }

    const historyText = this.formatMessages(historyMessages);
    const historyTokens = this.countTokens(historyText);
    layers.push({
      name: 'L2-history',
      tokens: historyTokens,
      content: historyText,
      priority: 5,
      trimmable: true,
    });

    // ---- L3：当前层（固定） ----
    const currentText = this.formatMessages(currentMessages);
    const currentTokens = this.countTokens(currentText);
    layers.push({
      name: 'L3-current',
      tokens: currentTokens,
      content: currentText,
      priority: 10,
      trimmable: false,
    });

    // ---- 统计 ----
    const extraSystemTokens = extraSystemContent.reduce((acc, m) => acc + this.countTokens(m.content), 0);
    const totalTokens = systemTokens + extraSystemTokens + memoryTokens + historyTokens + currentTokens;

    this.stats = {
      systemTokens: systemTokens + extraSystemTokens,
      memoryTokens,
      historyTokens,
      currentTokens,
      usedTokens: totalTokens,
      totalTokens,
      maxTokens: this.maxTokens,
      currentInputTokens: currentTokens,
      compressionRatio: 0,
      compressedRounds: 0,
    };

    // L2 历史占比超过 50% 时标记需要压缩
    if (totalTokens > 0 && historyTokens / totalTokens > 0.5) {
      this.needCompression = true;
      logger.info(
        `L2 history (${historyTokens}t, ${(historyTokens / totalTokens * 100).toFixed(1)}%) exceeds 50% threshold, compression needed.`,
      );
    }

    // 总 token 超过窗口上限
    if (totalTokens > this.maxTokens) {
      logger.warn(
        `Context total (${totalTokens}t) exceeds window limit (${this.maxTokens}t). ` +
        `Consider compressing L2 or trimming L1.`,
      );
    }

    logger.info(
      `Context built: L0=${systemTokens} L0.5/6=${extraSystemTokens} L1=${memoryTokens} L2=${historyTokens} L3=${currentTokens} total=${totalTokens}`,
    );

    return {
      messages: [
        { role: 'system', content: systemPrompt },
        ...extraSystemContent,
        ...this.wrapMemoryAsMessages(memoryItems),
        ...historyMessages,
        ...currentMessages,
      ],
      stats: this.stats,
      needCompression: this.needCompression,
    };
  }

  // -------------------------------------------------------------------------
  // 结构化组包入口（三层：全局骨架 MEMORY.md + 会话摘要 + 当前窗口）
  // -------------------------------------------------------------------------

  /**
   * 构建结构化上下文：自动从 RAM 常驻层（memorySkeleton / sessionSummaryStore）取
   * 全局骨架 + 会话摘要，作为 L0.5/L0.6 注入 buildContext。
   * 调用方负责确保 structuredMemory 已初始化（initStructuredMemory）。
   */
  buildStructuredContext(
    messages: ChatMessage[],
    systemPrompt: string,
    memoryItems: MemoryItem[],
  ): BuildContextResult {
    const skeleton = memorySkeleton.getSkeleton();
    const summaries = sessionSummaryStore.composeInjection();
    return this.buildContext(messages, systemPrompt, memoryItems, {
      skeleton: skeleton || undefined,
      summaries: summaries || undefined,
    });
  }

  // -------------------------------------------------------------------------
  // Token 计数
  // -------------------------------------------------------------------------

  countTokens(text: string): number {
    if (!text) return 0;
    try {
      // tiktoken 编码结果的长度即为 token 数
      const encoded = this.tokenizer.encode(text);
      return encoded.length;
    } catch {
      // 粗略回退：英文 ~4 char/token，中文 ~1.5 char/token
      const chineseCount = (text.match(/[\u4e00-\u9fff]/g) || []).length;
      const otherCount = text.length - chineseCount;
      return Math.ceil(chineseCount / 1.5 + otherCount / 4);
    }
  }

  // -------------------------------------------------------------------------
  // 统计查询
  // -------------------------------------------------------------------------

  getStats(): ContextStats {
    return { ...this.stats };
  }

  getNeedCompression(): boolean {
    return this.needCompression;
  }

  // -------------------------------------------------------------------------
  // 设置
  // -------------------------------------------------------------------------

  setMaxTokens(n: number): void {
    this.maxTokens = n;
    logger.info(`Context window max tokens set to ${n}`);
  }

  // -------------------------------------------------------------------------
  // 自动压缩触发
  // -------------------------------------------------------------------------

  /**
   * 更新自动压缩配置
   */
  updateAutoCompressConfig(config: Partial<AutoCompressConfig>): void {
    this.autoCompressConfig = { ...this.autoCompressConfig, ...config };
    logger.info(
      `AutoCompress config updated: threshold=${this.autoCompressConfig.threshold}, ` +
      `keepRecent=${this.autoCompressConfig.keepRecent}, alwaysOn=${this.autoCompressConfig.alwaysOn}`,
    );
  }

  /**
   * 检查是否需要自动压缩，并在满足条件时触发。
   *
   * 触发条件：
   *   1. alwaysOn = true（全时段启用），或当前场景为代码/长文档等重上下文场景
   *   2. 当前上下文 token 数 > maxTokens * threshold（默认 70%）
   *   3. L2 历史层 token 数超过 maxTokens * 0.4（至少 40% 窗口被历史占据）
   *
   * @param messages  当前消息列表
   * @param compressor 压缩器实例
   * @param inferFn    本地推理函数
   * @param isHeavyContext  是否处于重上下文场景（代码/长文档），alwaysOn=true 时忽略此参数
   */
  async checkAndCompress(
    messages: ChatMessage[],
    compressor: ConversationCompressor,
    inferFn: LocalInferenceFn,
    isHeavyContext: boolean = false,
  ): Promise<CompressTriggerResult> {
    const cfg = this.autoCompressConfig;

    // 全时段启用 OR 当前处于重上下文场景
    if (!cfg.alwaysOn && !isHeavyContext) {
      return { triggered: false, messages };
    }

    // 门控 1：总 token 是否接近上限
    const totalTokens = this.stats.totalTokens;
    const triggerTokens = Math.floor(this.maxTokens * cfg.threshold);
    if (totalTokens < triggerTokens) {
      logger.debug(
        `Skip autoCompress: totalTokens=${totalTokens} < trigger=${triggerTokens} ` +
        `(max=${this.maxTokens}, threshold=${cfg.threshold})`,
      );
      return { triggered: false, messages };
    }

    // 门控 2：历史层是否确实占了足够多的空间（避免空触发）
    const historyTokens = this.stats.historyTokens;
    const minHistoryThreshold = Math.floor(this.maxTokens * 0.4);
    if (historyTokens < minHistoryThreshold) {
      logger.debug(
        `Skip autoCompress: historyTokens=${historyTokens} < min=${minHistoryThreshold}`,
      );
      return { triggered: false, messages };
    }

    logger.warn(
      `AutoCompress triggered: total=${totalTokens}/${this.maxTokens} ` +
      `(${(totalTokens / this.maxTokens * 100).toFixed(1)}%), ` +
      `history=${historyTokens}t, threshold=${cfg.threshold}, keepRecent=${cfg.keepRecent}`,
    );

    // 执行压缩
    const result = await compressor.compress(messages, cfg.keepRecent, inferFn);

    logger.info(
      `AutoCompress done: ${result.stats.originalTokens}t -> ${result.stats.compressedTokens}t ` +
      `(saved ${(result.stats.savedPercent * 100).toFixed(1)}%), ` +
      `compressed ${result.stats.compressedRounds} round(s), kept ${result.stats.keptRounds}`,
    );

    // 更新内部统计
    this.stats.compressionRatio = result.stats.savedPercent;
    this.stats.compressedRounds += result.stats.compressedRounds;

    return {
      triggered: true,
      messages: result.compressedMessages,
      stats: result.stats,
    };
  }

  // -------------------------------------------------------------------------
  // 内部工具方法
  // -------------------------------------------------------------------------

  private emptyStats(): ContextStats {
    return {
      systemTokens: 0,
      memoryTokens: 0,
      historyTokens: 0,
      currentTokens: 0,
      usedTokens: 0,
      totalTokens: 0,
      maxTokens: this.maxTokens,
      currentInputTokens: 0,
      compressionRatio: 0,
      compressedRounds: 0,
    };
  }

  private findLastUserIndex(messages: ChatMessage[]): number {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') return i;
    }
    return -1;
  }

  private formatMessages(messages: ChatMessage[]): string {
    return messages
      .map((m) => `[${m.role}]: ${m.content}`)
      .join('\n');
  }

  private formatMemoryItems(items: MemoryItem[]): string {
    if (!items || items.length === 0) return '';
    return items
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .map((item) => `[memory id=${item.id} score=${item.score?.toFixed(2) ?? 'N/A'}]: ${item.content}`)
      .join('\n');
  }

  /**
   * 将记忆项包装为 system 消息注入（放在 system prompt 之后）
   */
  private wrapMemoryAsMessages(items: MemoryItem[]): ChatMessage[] {
    if (!items || items.length === 0) return [];
    const content = this.formatMemoryItems(items);
    if (!content) return [];
    return [{ role: 'system', content: `[Relevant Context]:\n${content}` }];
  }
}
