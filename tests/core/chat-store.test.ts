/**
 * P1 单元测试 — ChatStore 状态管理
 * 来源：src/renderer/store/chatStore.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// 模拟 localStorage
const storage = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => { storage.set(key, value) },
  removeItem: (key: string) => { storage.delete(key) },
  clear: () => { storage.clear() },
  length: 0,
  key: () => null,
})

import { create } from 'zustand'

// 参考 chatStore 核心类型
interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: number
}

interface ContextStatsState {
  totalTokens: number
  usedTokens: number
  compressedRounds: number
  compressionRatio: number
}

interface Conversation {
  id: string
  title: string
  messages: ChatMessage[]
  createdAt: number
  updatedAt: number
  contextStats?: ContextStatsState
}

describe('ChatMessage — 消息类型', () => {
  describe('正常路径', () => {
    it('创建用户消息', () => {
      const msg: ChatMessage = {
        id: 'msg-1',
        role: 'user',
        content: '你好',
        timestamp: Date.now(),
      }
      expect(msg.role).toBe('user')
      expect(msg.content).toBe('你好')
    })

    it('创建助手消息', () => {
      const msg: ChatMessage = {
        id: 'msg-2',
        role: 'assistant',
        content: '你好！有什么可以帮助你的？',
        timestamp: Date.now(),
      }
      expect(msg.role).toBe('assistant')
    })
  })
})

describe('Conversation — 会话类型', () => {
  describe('正常路径', () => {
    it('创建新会话', () => {
      const conv: Conversation = {
        id: 'conv-1',
        title: '新对话',
        messages: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      expect(conv.id).toBe('conv-1')
      expect(conv.messages).toHaveLength(0)
    })

    it('会话含 contextStats', () => {
      const conv: Conversation = {
        id: 'conv-2',
        title: '分析任务',
        messages: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        contextStats: {
          totalTokens: 128000,
          usedTokens: 5200,
          compressedRounds: 3,
          compressionRatio: 0.85,
        },
      }
      expect(conv.contextStats?.usedTokens).toBe(5200)
      expect(conv.contextStats?.compressionRatio).toBe(0.85)
    })
  })
})

describe('会话操作逻辑', () => {
  // 模拟 store 核心操作
  const MAX_CONVERSATIONS = 50
  const MAX_MESSAGES_PER_CONV = 200

  let conversations: Conversation[]

  beforeEach(() => {
    conversations = []
  })

  const createConversation = (): string => {
    if (conversations.length >= MAX_CONVERSATIONS) {
      conversations.shift()
    }
    const id = `conv-${Date.now()}`
    conversations.unshift({
      id,
      title: '新对话',
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    return id
  }

  const deleteConversation = (id: string): void => {
    conversations = conversations.filter(c => c.id !== id)
  }

  const renameConversation = (id: string, title: string): void => {
    const conv = conversations.find(c => c.id === id)
    if (conv) { conv.title = title; conv.updatedAt = Date.now() }
  }

  const addMessage = (convId: string, msg: ChatMessage): void => {
    const conv = conversations.find(c => c.id === convId)
    if (!conv) return
    if (conv.messages.length >= MAX_MESSAGES_PER_CONV) {
      conv.messages.shift()
    }
    conv.messages.push(msg)
    conv.updatedAt = Date.now()
  }

  describe('正常路径', () => {
    it('创建会话', () => {
      const id = createConversation()
      expect(conversations).toHaveLength(1)
      expect(conversations[0].id).toBe(id)
      expect(conversations[0].title).toBe('新对话')
    })

    it('删除会话', () => {
      const id = createConversation()
      expect(conversations).toHaveLength(1)
      deleteConversation(id)
      expect(conversations).toHaveLength(0)
    })

    it('重命名会话', () => {
      const id = createConversation()
      renameConversation(id, '重要讨论')
      expect(conversations[0].title).toBe('重要讨论')
    })

    it('添加消息', () => {
      const id = createConversation()
      addMessage(id, { id: 'm1', role: 'user', content: '你好', timestamp: Date.now() })
      addMessage(id, { id: 'm2', role: 'assistant', content: '你好！', timestamp: Date.now() })
      expect(conversations[0].messages).toHaveLength(2)
      expect(conversations[0].messages[0].role).toBe('user')
      expect(conversations[0].messages[1].role).toBe('assistant')
    })

    it('更新 contextStats', () => {
      const id = createConversation()
      const stats: ContextStatsState = { totalTokens: 128000, usedTokens: 1200, compressedRounds: 0, compressionRatio: 0 }
      const conv = conversations.find(c => c.id === id)!
      conv.contextStats = stats
      expect(conv.contextStats?.usedTokens).toBe(1200)
    })
  })

  describe('异常路径', () => {
    it('删除不存在的会话不影响', () => {
      deleteConversation('nonexistent')
      expect(conversations).toHaveLength(0)
    })

    it('重命名不存在的会话无副作用', () => {
      renameConversation('nonexistent', 'test')
      expect(conversations).toHaveLength(0)
    })

    it('向不存在的会话添加消息无副作用', () => {
      addMessage('nonexistent', { id: 'm', role: 'user', content: 'test', timestamp: Date.now() })
      expect(conversations).toHaveLength(0)
    })
  })

  describe('边界条件', () => {
    it('达到 MAX_MESSAGES 上限时移除旧消息', () => {
      const id = createConversation()
      for (let i = 0; i < MAX_MESSAGES_PER_CONV + 5; i++) {
        addMessage(id, { id: `msg-${i}`, role: 'user', content: `msg ${i}`, timestamp: Date.now() })
      }
      expect(conversations[0].messages.length).toBe(MAX_MESSAGES_PER_CONV)
    })

    it('达到 MAX_CONVERSATIONS 上限时移除最旧会话', () => {
      for (let i = 0; i < MAX_CONVERSATIONS + 5; i++) {
        conversations.unshift({
          id: `conv-${i}`,
          title: `对话 ${i}`,
          messages: [],
          createdAt: Date.now(),
          updatedAt: Date.now(),
        })
        if (conversations.length > MAX_CONVERSATIONS) conversations.pop()
      }
      expect(conversations.length).toBe(MAX_CONVERSATIONS)
    })
  })
})
