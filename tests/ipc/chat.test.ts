/**
 * tests/ipc/chat.test.ts
 * Chat IPC handler 消息处理链路单元测试
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
}

interface ChatRequest {
  id?: string
  messages: ChatMessage[]
  stream?: boolean
  model?: string
}

class ChatHandler {
  private streamControllers: Map<string, AbortController> = new Map()

  /** 验证消息格式 */
  validateRequest(request: ChatRequest): string | null {
    if (!request.messages || !Array.isArray(request.messages)) {
      return '消息列表不能为空'
    }
    if (request.messages.length === 0) {
      return '消息列表不能为空'
    }
    if (request.messages.length > 100) {
      return '消息数量不能超过 100 条'
    }
    for (const msg of request.messages) {
      if (typeof msg.content !== 'string') {
        return '消息内容必须为字符串'
      }
      if (msg.content.length > 131072) {
        return '单条消息不能超过 128KB'
      }
      if (!['user', 'assistant', 'system'].includes(msg.role)) {
        return `无效的消息角色: ${msg.role}`
      }
    }
    return null
  }

  /** 生成会话 ID */
  getSessionId(request: ChatRequest, fallback: string): string {
    return request.id || fallback
  }

  /** 注册流式控制器 */
  registerStream(sessionId: string): AbortController {
    const controller = new AbortController()
    this.streamControllers.set(sessionId, controller)
    return controller
  }

  /** 中止流式请求 */
  cancelStream(sessionId: string): boolean {
    const controller = this.streamControllers.get(sessionId)
    if (!controller) return false
    controller.abort()
    this.streamControllers.delete(sessionId)
    return true
  }

  /** 判断是否为流式请求 */
  isStreaming(sessionId: string): boolean {
    const controller = this.streamControllers.get(sessionId)
    return controller !== undefined && !controller.signal.aborted
  }

  /** 清理所有活跃流 */
  abortAllStreams(): number {
    let count = 0
    this.streamControllers.forEach((ctrl, sid) => {
      try { ctrl.abort() } catch { /* ignore */ }
      count++
    })
    this.streamControllers.clear()
    return count
  }

  /** 获取活跃流数量 */
  getActiveStreamCount(): number {
    let count = 0
    this.streamControllers.forEach(ctrl => {
      if (!ctrl.signal.aborted) count++
    })
    return count
  }
}

describe('Chat IPC Handler Logic', () => {
  let handler: ChatHandler

  const makeMsg = (role: ChatMessage['role'], content: string, id?: string): ChatMessage => ({
    id: id || `${role}-${Date.now()}`,
    role,
    content
  })

  beforeEach(() => {
    handler = new ChatHandler()
  })

  describe('validateRequest', () => {
    it('正常请求应验证通过', () => {
      const req: ChatRequest = {
        messages: [makeMsg('user', 'Hello')]
      }
      expect(handler.validateRequest(req)).toBeNull()
    })

    it('空消息列表应返回错误', () => {
      const req: ChatRequest = { messages: [] }
      expect(handler.validateRequest(req)).toBe('消息列表不能为空')
    })

    it('超过 100 条消息应返回错误', () => {
      const msgs = Array.from({ length: 101 }, (_, i) => makeMsg('user', `msg${i}`))
      const req: ChatRequest = { messages: msgs }
      expect(handler.validateRequest(req)).toBe('消息数量不能超过 100 条')
    })

    it('恰好 100 条消息应验证通过', () => {
      const msgs = Array.from({ length: 100 }, (_, i) => makeMsg('user', `msg${i}`))
      const req: ChatRequest = { messages: msgs }
      expect(handler.validateRequest(req)).toBeNull()
    })

    it('单条消息超过 128KB 应返回错误', () => {
      const req: ChatRequest = {
        messages: [makeMsg('user', 'x'.repeat(131073))]
      }
      const err = handler.validateRequest(req)
      expect(err).toBe('单条消息不能超过 128KB')
    })

    it('无效角色应返回错误', () => {
      const req: ChatRequest = {
        messages: [{ id: '1', role: 'bot' as any, content: 'test' }]
      }
      const err = handler.validateRequest(req)
      expect(err).toContain('无效的消息角色')
    })

    it('缺少 messages 字段应返回错误', () => {
      const req = {} as ChatRequest
      expect(handler.validateRequest(req)).toBe('消息列表不能为空')
    })

    it('multi-turn 对话应验证通过', () => {
      const req: ChatRequest = {
        messages: [
          makeMsg('system', 'You are helpful.'),
          makeMsg('user', 'What is AI?'),
          makeMsg('assistant', 'AI is...'),
          makeMsg('user', 'Tell me more.')
        ]
      }
      expect(handler.validateRequest(req)).toBeNull()
    })
  })

  describe('getSessionId', () => {
    it('有 ID 时返回请求 ID', () => {
      const req: ChatRequest = { id: 'abc123', messages: [] }
      expect(handler.getSessionId(req, 'fallback')).toBe('abc123')
    })

    it('无 ID 时返回 fallback', () => {
      const req: ChatRequest = { messages: [] }
      expect(handler.getSessionId(req, 'session-42')).toBe('session-42')
    })
  })

  describe('stream control', () => {
    it('registerStream 应创建新 AbortController', () => {
      const ctrl = handler.registerStream('sess-1')
      expect(ctrl).toBeDefined()
      expect(ctrl.signal.aborted).toBe(false)
      expect(handler.isStreaming('sess-1')).toBe(true)
    })

    it('cancelStream 应中止并移除控制器', () => {
      handler.registerStream('sess-2')
      const result = handler.cancelStream('sess-2')
      expect(result).toBe(true)
      expect(handler.isStreaming('sess-2')).toBe(false)
    })

    it('cancelStream 不存在的会话应返回 false', () => {
      expect(handler.cancelStream('ghost')).toBe(false)
    })

    it('abortAllStreams 应清理所有会话', () => {
      handler.registerStream('a')
      handler.registerStream('b')
      handler.registerStream('c')
      const count = handler.abortAllStreams()
      expect(count).toBe(3)
      expect(handler.getActiveStreamCount()).toBe(0)
    })
  })

  describe('getActiveStreamCount', () => {
    it('无活跃流时应返回 0', () => {
      expect(handler.getActiveStreamCount()).toBe(0)
    })

    it('有活跃流时应正确计数', () => {
      handler.registerStream('s1')
      handler.registerStream('s2')
      expect(handler.getActiveStreamCount()).toBe(2)
    })

    it('取消后活跃数应减少', () => {
      handler.registerStream('s1')
      handler.registerStream('s2')
      handler.cancelStream('s1')
      expect(handler.getActiveStreamCount()).toBe(1)
    })
  })
})
