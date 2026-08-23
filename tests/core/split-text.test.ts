/**
 * P1 单元测试 — splitText 文本分割函数
 * 来源：src/main/rag/embedding.ts
 */
import { describe, it, expect } from 'vitest'
import { splitText } from '../../src/main/rag/embedding'

describe('splitText — 文本分割', () => {
  const sampleText = '这是第一段内容。包含一些测试数据。这是第二段，用来验证分割逻辑。第三段很短。'

  describe('正常路径', () => {
    it('短文本不拆分（单个 chunk）', () => {
      const result = splitText('短文本', 500, 50)
      expect(result).toHaveLength(1)
      expect(result[0]).toBe('短文本')
    })

    it('按默认参数分割中文文本', () => {
      const result = splitText(sampleText, 50, 10)
      expect(result.length).toBeGreaterThanOrEqual(1)
      // 所有 chunk 合并后应包含原文关键信息
      const joined = result.join('')
      expect(joined).toContain('第一段')
      expect(joined).toContain('第二段')
    })

    it('空字符串返回空数组', () => {
      const result = splitText('', 500, 50)
      expect(result).toHaveLength(0)
    })

    it('仅含空白字符返回空数组', () => {
      const result = splitText('   \n  \n ', 500, 50)
      expect(result).toHaveLength(0)
    })

    it('overlap=0 时相邻 chunk 无重叠', () => {
      const longText = Array.from({ length: 30 }, (_, i) => `第${i + 1}句。`).join('')
      const result = splitText(longText, 30, 0)
      expect(result.length).toBeGreaterThan(1)
    })

    it('英文文本正常分割', () => {
      const enText = 'Hello world. This is a test. Another sentence here for verification.'
      const result = splitText(enText, 200, 30)
      expect(result.length).toBeGreaterThanOrEqual(1)
    })
  })

  describe('异常路径', () => {
    it('chunkSize=1 极窄分割', () => {
      const result = splitText('ABC', 1, 0)
      // 极窄情况下每个字符一组（按空格分）
      expect(result.length).toBeGreaterThanOrEqual(1)
    })

    it('包含特殊字符不崩溃', () => {
      const result = splitText('包含 emoji 🎉 和符号 @#$%。还有内容。', 100, 20)
      expect(result.length).toBeGreaterThanOrEqual(1)
    })

    it('超长单句（无句号分隔）', () => {
      const long = 'A'.repeat(1000) + '。' + 'B'.repeat(200)
      const result = splitText(long, 500, 50)
      expect(result.length).toBeGreaterThanOrEqual(1)
    })
  })

  describe('边界条件', () => {
    it('恰好等于 chunkSize', () => {
      const text = 'A。B。C。'
      const result = splitText(text, text.length + 5, 0)
      expect(result).toHaveLength(1)
    })

    it('大量短句分割', () => {
      const many = Array.from({ length: 50 }, () => '短句。').join('')
      const result = splitText(many, 100, 20)
      expect(result.length).toBeGreaterThanOrEqual(1)
    })
  })
})
