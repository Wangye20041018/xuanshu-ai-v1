import { create } from 'zustand'
import { persist, createJSONStorage, type StateStorage } from 'zustand/middleware'

const MAX_CONVERSATIONS = 50
const MAX_MESSAGES_PER_CONV = 200

/** 去抖存储包装器：延迟写入 localStorage，避免高频状态变更导致频繁磁盘 I/O */
function createDebouncedStorage(base: Storage, delayMs = 1000): StateStorage & { flush: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null
  let pending = new Map<string, string>()

  const storage: StateStorage & { flush: () => void } = {
    getItem(name) {
      // 读取时优先返回待写入的最新值
      return Promise.resolve(pending.get(name) ?? base.getItem(name))
    },
    setItem(name, value) {
      pending.set(name, value)
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        storage.flush()
      }, delayMs)
    },
    removeItem(name) {
      pending.delete(name)
      try { base.removeItem(name) } catch { /* ignore */ }
    },
    flush() {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      if (pending.size === 0) return
      pending.forEach((val, key) => {
        try { base.setItem(key, val) } catch { /* quota exceeded */ }
      })
      pending.clear()
    },
  }
  return storage
}

/**
 * 会话持久化 storage（模块级单例）。
 * beforeunload 时立即 flush，避免去抖窗口内关闭应用导致最近数据丢失。
 * 使用内存 fallback，避免在非浏览器环境（测试/SSR）直接访问 localStorage 抛错。
 */
const memoryStorage: Storage = {
  get length() { return 0 },
  clear() {},
  getItem() { return null },
  key() { return null },
  removeItem() {},
  setItem() {},
}

function resolveBaseStorage(): Storage {
  if (typeof window === 'undefined' || typeof localStorage === 'undefined') return memoryStorage
  try {
    // 探测 localStorage 可用性（隐私模式下访问可能抛异常）
    const k = '__xuanshu_probe__'
    localStorage.setItem(k, '1')
    localStorage.removeItem(k)
    return localStorage
  } catch {
    return memoryStorage
  }
}

const chatStorage = createDebouncedStorage(resolveBaseStorage(), 1000)
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => chatStorage.flush())
}

/**
 * 立即将去抖窗口内的待写状态落盘到 localStorage。
 * 备份导出前调用，确保 getItem 读到的是最新会话数据。
 */
export function flushChatStore(): void {
  chatStorage.flush()
}

/**
 * 备份导入后由主进程广播调用：将备份中的会话数据写回 localStorage 并触发 rehydrate。
 */
export function rehydrateChatStore(json: string): void {
  try {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('xuanshu-chat-store', json)
    }
  } catch { /* quota exceeded 或隐私模式，忽略 */ }
  try {
    void useChatStore.persist.rehydrate()
  } catch (e) {
    console.error('[chatStore] rehydrate failed:', e)
  }
}

interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  /** M-3 修复：推理过程（reasoning_content）独立存储，UI 折叠展示 */
  reasoning?: string
  timestamp: number
  /** A批7：生成统计（真实可算，非 mock）。tokenEstimate 为按字符数估算（UI 标注「约」），elapsedMs 为前端真实计时 */
  tokenEstimate?: number
  elapsedMs?: number
  charCount?: number
  /** F批：附件（图片/文件）由文本标记升级为真实内容数组附件，前端缩略渲染 + 发送时构造 multi-part parts */
  files?: Array<{ path: string; type: string; name?: string }>
}

/** 流式结束后由前端计算并写入的单条消息生成统计 */
export interface MessageMeta {
  tokenEstimate?: number
  elapsedMs?: number
  charCount?: number
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

interface ChatState {
  // 当前会话
  messages: ChatMessage[]
  isLoading: boolean
  isStreaming: boolean
  currentConversationId: string | null

  // P0-2: hydration 完成标记，用于确保会话恢复在数据加载后执行
  _hydrated: boolean

  // 多会话管理
  conversations: Conversation[]

  addMessage: (message: ChatMessage) => void
  updateMessage: (id: string, content: string, conversationId?: string, reasoning?: string) => void
  updateMessageMeta: (id: string, meta: MessageMeta, conversationId?: string) => void
  setLoading: (loading: boolean) => void
  setStreaming: (streaming: boolean) => void
  clearMessages: () => void

  // 多会话操作
  ensureSession: () => void
  createConversation: () => string
  switchConversation: (id: string) => void
  deleteConversation: (id: string) => void
  renameConversation: (id: string, title: string) => void
  updateContextStats: (conversationId: string, stats: ContextStatsState) => void
}

export const useChatStore = create<ChatState>()(
  persist(
    (set, get) => ({
      messages: [],
      isLoading: false,
      isStreaming: false,
      currentConversationId: null,
      _hydrated: false,
      conversations: [],

      addMessage: (message) =>
        set((state) => {
          const newMessages = [...state.messages, message].slice(-MAX_MESSAGES_PER_CONV)
          let conversations = state.conversations.map(c =>
            c.id === state.currentConversationId
              ? { ...c, messages: newMessages, updatedAt: Date.now(), title: c.title === '新对话' && message.role === 'user' ? message.content.slice(0, 20) + (message.content.length > 20 ? '...' : '') : c.title }
              : c
          )
          // 容量保护：超出上限则裁减最旧对话
          const totalMessages = conversations.reduce((sum, c) => sum + c.messages.length, 0)
          if (totalMessages > MAX_CONVERSATIONS * MAX_MESSAGES_PER_CONV * 2) {
            const sorted = [...conversations].sort((a, b) => a.updatedAt - b.updatedAt)
            const keepCount = Math.ceil(sorted.length / 2)
            conversations = sorted.slice(-keepCount)
          }
          return { messages: newMessages, conversations }
        }),

      updateMessage: (id, content, conversationId?, reasoning?) =>
        set((state) => {
          const targetId = conversationId ?? state.currentConversationId
          // 流式回复可能发生在会话切换后：按目标会话写入，避免切走后内容丢失或错位
          if (targetId && targetId !== state.currentConversationId) {
            const conversations = state.conversations.map(c =>
              c.id === targetId
                ? { ...c, messages: c.messages.map((m) => (m.id === id ? { ...m, content, ...(reasoning !== undefined ? { reasoning } : {}) } : m)), updatedAt: Date.now() }
                : c
            )
            return { conversations }
          }
          const newMessages = state.messages.map((m) =>
            m.id === id ? { ...m, content, ...(reasoning !== undefined ? { reasoning } : {}) } : m
          )
          const conversations = state.conversations.map(c =>
            c.id === state.currentConversationId ? { ...c, messages: newMessages, updatedAt: Date.now() } : c
          )
          return { messages: newMessages, conversations }
        }),

      updateMessageMeta: (id, meta, conversationId?) =>
        set((state) => {
          const targetId = conversationId ?? state.currentConversationId
          // 生成统计（token/耗时）同样按目标会话路由，与 updateMessage 逻辑保持一致
          if (targetId && targetId !== state.currentConversationId) {
            const conversations = state.conversations.map(c =>
              c.id === targetId
                ? { ...c, messages: c.messages.map((m) => (m.id === id ? { ...m, ...meta } : m)) }
                : c
            )
            return { conversations }
          }
          const newMessages = state.messages.map((m) => (m.id === id ? { ...m, ...meta } : m))
          const conversations = state.conversations.map(c =>
            c.id === state.currentConversationId ? { ...c, messages: newMessages } : c
          )
          return { messages: newMessages, conversations }
        }),

      setLoading: (loading) => set({ isLoading: loading }),
      setStreaming: (streaming) => set({ isStreaming: streaming }),

      clearMessages: () =>
        set((state) => ({
          messages: [],
          // 同步清空持久化会话中的消息，避免重启/切换后旧消息“复活”
          conversations: state.conversations.map((c) =>
            c.id === state.currentConversationId
              ? { ...c, messages: [], updatedAt: Date.now() }
              : c
          ),
        })),

      // 启动时调用：等待 hydration 完成后恢复会话。hydration 未完成时直接返回（回调会再次调用）
      ensureSession: () => {
        const state = get()
        // P0-2: hydration 未完成时跳过，避免在数据恢复前创建空会话
        if (!state._hydrated) return

        const { currentConversationId, conversations } = state
        if (currentConversationId) {
          // P0-2: 恢复持久化的会话消息到顶层 messages
          const conv = conversations.find(c => c.id === currentConversationId)
          if (conv) {
            set({ messages: [...conv.messages], isStreaming: false })
            return
          }
        }
        // 无有效会话时创建新会话
        const id = `conv-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
        const conv: Conversation = { id, title: '新对话', messages: [], createdAt: Date.now(), updatedAt: Date.now() }
        set({
          conversations: [conv, ...conversations],
          currentConversationId: id,
          messages: [],
        })
      },

      createConversation: () => {
        const id = `conv-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
        const conv: Conversation = { id, title: '新对话', messages: [], createdAt: Date.now(), updatedAt: Date.now() }
        set((state) => {
          let conversations = [conv, ...state.conversations].slice(0, MAX_CONVERSATIONS)
          // 容量保护：超出上限则裁减最旧对话
          const totalMessages = conversations.reduce((sum, c) => sum + c.messages.length, 0)
          if (totalMessages > MAX_CONVERSATIONS * MAX_MESSAGES_PER_CONV * 2) {
            const sorted = [...conversations].sort((a, b) => a.updatedAt - b.updatedAt)
            const keepCount = Math.ceil(sorted.length / 2)
            conversations = sorted.slice(-keepCount)
          }
          return {
            conversations,
            currentConversationId: id,
            messages: [],
          }
        })
        return id
      },

      switchConversation: (id) => {
        const conv = get().conversations.find(c => c.id === id)
        if (conv) {
          set({ currentConversationId: id, messages: [...conv.messages], isStreaming: false })
        }
      },

      deleteConversation: (id) =>
        set((state) => {
          const conversations = state.conversations.filter(c => c.id !== id)
          if (state.currentConversationId === id) {
            const first = conversations[0]
            return { conversations, currentConversationId: first?.id ?? null, messages: first?.messages ?? [] }
          }
          return { conversations }
        }),

      renameConversation: (id, title) =>
        set((state) => ({
          conversations: state.conversations.map(c => c.id === id ? { ...c, title } : c)
        })),

      updateContextStats: (conversationId, stats) =>
        set((state) => ({
          conversations: state.conversations.map(c =>
            c.id === conversationId ? { ...c, contextStats: stats } : c
          ),
        })),
    }),
    {
      name: 'xuanshu-chat-store',
      storage: createJSONStorage(() => chatStorage),
      partialize: (state) => ({
        conversations: state.conversations,
        currentConversationId: state.currentConversationId,
      }),
      // P0-2: 标记 hydration 完成，确保 ensureSession 在数据恢复后再执行
      onRehydrateStorage: () => {
        return (_state, error) => {
          if (error) {
            console.error('[chatStore] rehydration failed:', error)
          }
          useChatStore.setState({ _hydrated: true })
          // P0-2: hydration 完成后立即恢复或创建会话
          useChatStore.getState().ensureSession()
        }
      },
    }
  )
)
