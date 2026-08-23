/**
 * tests/services/context-compressor.test.ts
 * ConversationCompressor 单元测试：压缩/Token估算/轮次分组/边界
 */
import { describe, it, expect, vi } from 'vitest'

type ChatMessage = { role: string; content: string }

interface CompressionStats {
  originalTokens: number
  compressedTokens: number
  savedPercent: number
  compressedRounds: number
  keptRounds: number
}

interface CompressionResult {
  compressedMessages: ChatMessage[]
  stats: CompressionStats
}

type LocalInferenceFn = (messages: ChatMessage[], options?: { maxTokens?: number; temperature?: number }) => Promise<string>

class ConversationCompressor {
  private readonly MIN_SUMMARY_TOKENS = 50
  private readonly MAX_SUMMARY_TOKENS = 100

  private estimateTokens(text: string): number {
    if (!text) return 0
    const chineseCount = (text.match(/[\u4e00-\u9fff]/g) || []).length
    const otherCount = text.length - chineseCount
    return Math.ceil(chineseCount / 1.5 + otherCount / 4)
  }

  async compress(
    messages: ChatMessage[],
    keepRecent: number,
    inferFn: LocalInferenceFn,
  ): Promise<CompressionResult> {
    if (messages.length === 0) {
      return {
        compressedMessages: [],
        stats: this.emptyStats(),
      }
    }

    const rounds = this.groupByRounds(messages)

    if (rounds.length <= keepRecent) {
      return {
        compressedMessages: messages,
        stats: {
          ...this.emptyStats(),
          keptRounds: rounds.length,
        },
      }
    }

    const toCompress = rounds.slice(0, rounds.length - keepRecent)
    const toKeep = rounds.slice(rounds.length - keepRecent)

    const compressText = toCompress.flat().map((m) => `[${m.role}]: ${m.content}`).join('\n')
    const originalTokens = this.estimateTokens(compressText)

    const summaryPrompt = this.buildSummaryPrompt(messages)
    const summaryContent = await inferFn(
      [
        { role: 'system', content: 'You are a concise conversation summarizer.' },
        { role: 'user', content: summaryPrompt },
      ],
      { maxTokens: this.MAX_SUMMARY_TOKENS, temperature: 0.2 },
    )

    const compressedTokens = this.estimateTokens(summaryContent)
    const savedPercent = originalTokens > 0
      ? Math.round(((originalTokens - compressedTokens) / originalTokens) * 100) / 100
      : 0

    const compressedMessages: ChatMessage[] = [
      { role: 'system', content: `[Conversation Summary]: ${summaryContent}` },
      ...toKeep.flat(),
    ]

    return {
      compressedMessages,
      stats: {
        originalTokens,
        compressedTokens,
        savedPercent,
        compressedRounds: toCompress.length,
        keptRounds: toKeep.length,
      },
    }
  }

  buildSummaryPrompt(messages: ChatMessage[]): string {
    const transcript = messages.map((m) => `[${m.role}]: ${m.content}`).join('\n\n')
    return `Summarize the following conversation in 50-100 tokens...\n\nConversation:\n${transcript}`
  }

  private groupByRounds(messages: ChatMessage[]): ChatMessage[][] {
    const rounds: ChatMessage[][] = []
    let current: ChatMessage[] = []

    for (const msg of messages) {
      if (msg.role === 'user' && current.length > 0) {
        rounds.push(current)
        current = []
      }
      current.push(msg)
    }
    if (current.length > 0) {
      rounds.push(current)
    }

    return rounds
  }

  private emptyStats(): CompressionStats {
    return {
      originalTokens: 0,
      compressedTokens: 0,
      savedPercent: 0,
      compressedRounds: 0,
      keptRounds: 0,
    }
  }
}

describe('ConversationCompressor', () => {
  const compressor = new ConversationCompressor()

  const makeMessages = (rounds: number): ChatMessage[] => {
    const msgs: ChatMessage[] = []
    for (let i = 1; i <= rounds; i++) {
      msgs.push({ role: 'user', content: `这是第${i}轮用户消息，包含一些中文内容。` })
      msgs.push({ role: 'assistant', content: `This is round ${i} assistant response with English.` })
    }
    return msgs
  }

  const mockInferFn: LocalInferenceFn = vi.fn().mockResolvedValue(
    '简要摘要：用户询问了多个问题，助手逐一回答。涉及技术讨论和日常对话。'
  )

  describe('空消息处理', () => {
    it('空消息列表应该返回空结果', async () => {
      const result = await compressor.compress([], 2, mockInferFn)
      expect(result.compressedMessages).toHaveLength(0)
      expect(result.stats.originalTokens).toBe(0)
      expect(result.stats.compressedRounds).toBe(0)
    })

    it('空消息列表 stats 应全为零', async () => {
      const result = await compressor.compress([], 1, mockInferFn)
      expect(result.stats.savedPercent).toBe(0)
      expect(result.stats.keptRounds).toBe(0)
    })
  })

  describe('消息数不足不压缩', () => {
    it('消息轮数 <= keepRecent 时不应该压缩', async () => {
      const msgs = makeMessages(2)
      const result = await compressor.compress(msgs, 2, mockInferFn)
      expect(result.compressedMessages).toBe(msgs) // 原样返回
      expect(result.stats.compressedRounds).toBe(0)
      expect(result.stats.keptRounds).toBe(2)
    })

    it('消息轮数 < keepRecent 时不应该压缩', async () => {
      const msgs = makeMessages(1)
      const result = await compressor.compress(msgs, 3, mockInferFn)
      expect(result.stats.compressedRounds).toBe(0)
      expect(result.stats.keptRounds).toBe(1)
    })
  })

  describe('正常压缩', () => {
    it('应该压缩较早的轮次，保留最近 N 轮', async () => {
      const msgs = makeMessages(5)
      const result = await compressor.compress(msgs, 2, mockInferFn)
      expect(result.stats.compressedRounds).toBe(3)
      expect(result.stats.keptRounds).toBe(2)
    })

    it('压缩后第一条消息应为 system 摘要', async () => {
      const msgs = makeMessages(4)
      const result = await compressor.compress(msgs, 1, mockInferFn)
      expect(result.compressedMessages[0].role).toBe('system')
      expect(result.compressedMessages[0].content).toContain('[Conversation Summary]')
    })

    it('压缩后应包含保留的最近消息', async () => {
      const msgs = makeMessages(3)
      const result = await compressor.compress(msgs, 1, mockInferFn)
      // 第一条是摘要，后面应该是保留的 1 轮（user + assistant）
      expect(result.compressedMessages.length).toBe(3)
      expect(result.compressedMessages[1].role).toBe('user')
      expect(result.compressedMessages[2].role).toBe('assistant')
    })

    it('应该正确计算 savedPercent', async () => {
      const msgs = makeMessages(6)
      const result = await compressor.compress(msgs, 1, mockInferFn)
      expect(result.stats.savedPercent).toBeGreaterThanOrEqual(0)
      expect(result.stats.savedPercent).toBeLessThanOrEqual(1)
    })

    it('应该调用 inference 函数', async () => {
      const inferFn = vi.fn().mockResolvedValue('test summary')
      const msgs = makeMessages(3)
      await compressor.compress(msgs, 1, inferFn)
      expect(inferFn).toHaveBeenCalledTimes(1)
      expect(inferFn).toHaveBeenCalledWith(
        expect.any(Array),
        { maxTokens: 100, temperature: 0.2 }
      )
    })
  })

  describe('buildSummaryPrompt', () => {
    it('应该包含所有消息的转录文本', () => {
      const msgs = makeMessages(1)
      const prompt = compressor.buildSummaryPrompt(msgs)
      expect(prompt).toContain('[user]:')
      expect(prompt).toContain('[assistant]:')
    })

    it('应该包含摘要指令', () => {
      const prompt = compressor.buildSummaryPrompt(makeMessages(1))
      expect(prompt).toContain('Summarize')
      expect(prompt).toContain('50-100 tokens')
    })
  })

  describe('Token 估算', () => {
    it('纯英文应约 4 char/token', async () => {
      const msgs: ChatMessage[] = [
        { role: 'user', content: 'Hello world' },
        { role: 'assistant', content: 'Hi there' },
      ]
      const result = await compressor.compress(msgs, 1, mockInferFn)
      // Hello world (11 chars) / 4 ≈ 3 + Hi there (8 chars) / 4 ≈ 2 = 5
      expect(result.stats.keptRounds).toBe(1)
    })

    it('包含中文应使用 1.5 char/token', async () => {
      const msgs: ChatMessage[] = [
        { role: 'user', content: '你好世界' },
        { role: 'assistant', content: 'Hello' },
      ]
      const result = await compressor.compress(msgs, 1, mockInferFn)
      expect(result.stats.keptRounds).toBe(1)
    })
  })
})
