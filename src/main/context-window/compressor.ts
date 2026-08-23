/**
 * 对话压缩器
 *
 * 将较早的对话消息压缩为结构化摘要，释放上下文窗口空间。
 * - 使用当前加载的本地模型做摘要推理
 * - 每个摘要目标 50-100 tokens
 * - 保留最近 N 轮对话不被压缩
 */

import { createLogger } from '../../shared/logger';
import type { ChatMessage } from './manager';

const logger = createLogger('ConversationCompressor');

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

export interface CompressionResult {
  /** 压缩后的完整消息列表（摘要 + 未压缩的最近消息） */
  compressedMessages: ChatMessage[];
  /** 统计 */
  stats: CompressionStats;
}

export interface CompressionStats {
  /** 压缩前 token 数（被压缩部分） */
  originalTokens: number;
  /** 压缩后 token 数（摘要） */
  compressedTokens: number;
  /** 节省比例，0-1 */
  savedPercent: number;
  /** 被压缩的轮次数 */
  compressedRounds: number;
  /** 保留未压缩的轮次数 */
  keptRounds: number;
}

// ---------------------------------------------------------------------------
// LLM 调用接口（由外部注入）
// ---------------------------------------------------------------------------

export type LocalInferenceFn = (
  messages: ChatMessage[],
  options?: { maxTokens?: number; temperature?: number },
) => Promise<string>;

// ---------------------------------------------------------------------------
// 压缩器
// ---------------------------------------------------------------------------

export class ConversationCompressor {
  /** 摘要目标最大 tokens */
  private readonly MAX_SUMMARY_TOKENS = 100;

  /** 内部简易 token 估算（英文 ~4 char/token，中文 ~1.5 char/token） */
  private estimateTokens(text: string): number {
    if (!text) return 0;
    const chineseCount = (text.match(/[\u4e00-\u9fff]/g) || []).length;
    const otherCount = text.length - chineseCount;
    return Math.ceil(chineseCount / 1.5 + otherCount / 4);
  }

  // -------------------------------------------------------------------------
  // 主入口
  // -------------------------------------------------------------------------

  /**
   * @param messages    原始消息列表
   * @param keepRecent  保留最近 N 轮对话不被压缩
   * @param inferFn     本地模型推理函数
   */
  async compress(
    messages: ChatMessage[],
    keepRecent: number,
    inferFn: LocalInferenceFn,
  ): Promise<CompressionResult> {
    if (messages.length === 0) {
      logger.info('No messages to compress.');
      return {
        compressedMessages: [],
        stats: this.emptyStats(),
      };
    }

    // 分离需要压缩和保留的消息
    const rounds = this.groupByRounds(messages);

    if (rounds.length <= keepRecent) {
      logger.info(
        `Only ${rounds.length} round(s), fewer than keepRecent=${keepRecent}, no compression needed.`,
      );
      return {
        compressedMessages: messages,
        stats: {
          ...this.emptyStats(),
          keptRounds: rounds.length,
        },
      };
    }

    const toCompress = rounds.slice(0, rounds.length - keepRecent);
    const toKeep = rounds.slice(rounds.length - keepRecent);

    // 拼接需要压缩的消息文本
    const compressText = toCompress
      .flat()
      .map((m) => `[${m.role}]: ${m.content}`)
      .join('\n');

    const originalTokens = this.estimateTokens(compressText);

    logger.info(
      `Compressing ${toCompress.length} round(s) (${originalTokens} estimated tokens), keeping ${toKeep.length}.`,
    );

    // 构建摘要 prompt
    const summaryPrompt = this.buildSummaryPrompt(messages);

    // 调用本地模型生成摘要
    const summaryContent = await inferFn(
      [
        {
          role: 'system',
          content:
            'You are a concise conversation summarizer. Produce a dense factual summary in the original language of the conversation. Do not add commentary.',
        },
        { role: 'user', content: summaryPrompt },
      ],
      { maxTokens: this.MAX_SUMMARY_TOKENS, temperature: 0.2 },
    );

    const compressedTokens = this.estimateTokens(summaryContent);
    const savedPercent =
      originalTokens > 0
        ? Math.round(((originalTokens - compressedTokens) / originalTokens) * 100) / 100
        : 0;

    logger.info(
      `Compression done: ${originalTokens}t -> ${compressedTokens}t (saved ${(savedPercent * 100).toFixed(1)}%)`,
    );

    // 组装压缩后的消息列表：
    // 摘要作为 system 消息注入，后跟保留的最近消息
    const compressedMessages: ChatMessage[] = [
      {
        role: 'system',
        content: `[Conversation Summary]: ${summaryContent}`,
      },
      ...toKeep.flat(),
    ];

    return {
      compressedMessages,
      stats: {
        originalTokens,
        compressedTokens,
        savedPercent,
        compressedRounds: toCompress.length,
        keptRounds: toKeep.length,
      },
    };
  }

  // -------------------------------------------------------------------------
  // 摘要 Prompt 构建
  // -------------------------------------------------------------------------

  buildSummaryPrompt(messages: ChatMessage[]): string {
    const transcript = messages
      .map((m) => `[${m.role}]: ${m.content}`)
      .join('\n\n');

    return `Summarize the following conversation in 50-100 tokens. Capture:
- The user's main requests and goals
- Key decisions made
- Important facts, entities, or code mentioned
- Any unresolved questions

Keep the summary in the same language(s) as the conversation below.

Conversation:
${transcript}`;
  }

  // -------------------------------------------------------------------------
  // 轮次分组
  // -------------------------------------------------------------------------

  /**
   * 按 user-assistant 交替对消息分组。
   * 每一轮以 user 消息开头，可能包含后续的 assistant 消息。
   */
  private groupByRounds(messages: ChatMessage[]): ChatMessage[][] {
    const rounds: ChatMessage[][] = [];
    let current: ChatMessage[] = [];

    for (const msg of messages) {
      if (msg.role === 'user' && current.length > 0) {
        rounds.push(current);
        current = [];
      }
      current.push(msg);
    }
    if (current.length > 0) {
      rounds.push(current);
    }

    return rounds;
  }

  // -------------------------------------------------------------------------
  // 工具
  // -------------------------------------------------------------------------

  private emptyStats(): CompressionStats {
    return {
      originalTokens: 0,
      compressedTokens: 0,
      savedPercent: 0,
      compressedRounds: 0,
      keptRounds: 0,
    };
  }
}
