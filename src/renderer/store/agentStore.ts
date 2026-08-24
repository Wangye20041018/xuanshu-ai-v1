/**
 * agentStore — 智能体工作台状态（zustand）
 *
 * 智能体列表/创建/运行监控。数据真源在主进程（agent-store / userData/agents），
 * 本 store 只做内存态缓存与 IPC 桥接。
 *
 * @module renderer/store/agentStore
 */

import { create } from 'zustand'
import type {
  AgentDefinition,
  AgentCreatePreview,
  AgentRunEvent,
} from '../../shared/agent-types'

export interface AgentToolInfo {
  name: string
  description: string
  category: string
  dangerous: boolean
}

export interface PersonaInfo {
  id: string
  name: string
  icon?: string
  description?: string
  color?: string
  preferred_tier?: string
}

interface AgentState {
  agents: AgentDefinition[]
  personas: PersonaInfo[]
  tools: AgentToolInfo[]
  loading: boolean
  creating: boolean
  preview: AgentCreatePreview | null
  runningAgentId: string | null
  events: AgentRunEvent[]
  error: string | null

  loadAgents: () => Promise<void>
  loadPersonas: () => Promise<void>
  loadTools: () => Promise<void>
  createRequest: (requirement: string) => Promise<AgentCreatePreview | null>
  confirmCreate: () => Promise<AgentDefinition | null>
  cancelCreate: () => void
  saveAgent: (def: AgentDefinition) => Promise<void>
  deleteAgent: (id: string) => Promise<void>
  runAgent: (agentId: string, messages: Array<{ role: 'user' | 'assistant'; content: string }>) => Promise<void>
  stopAgent: () => Promise<void>
  clearEvents: () => void
}

const api = typeof window !== 'undefined' ? (window as any).api : undefined

export const useAgentStore = create<AgentState>((set, get) => ({
  agents: [],
  personas: [],
  tools: [],
  loading: false,
  creating: false,
  preview: null,
  runningAgentId: null,
  events: [],
  error: null,

  loadAgents: async () => {
    set({ loading: true, error: null })
    try {
      const res = await api?.invoke?.('agent:list')
      if (res?.success) {
        set({ agents: (res.data || []) as AgentDefinition[] })
      } else {
        set({ error: res?.error || '加载智能体失败' })
      }
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) })
    } finally {
      set({ loading: false })
    }
  },

  loadPersonas: async () => {
    try {
      const res = await api?.invoke?.('agent:list-personas')
      if (res?.success) set({ personas: (res.data || []) as PersonaInfo[] })
    } catch {
      /* 静默失败，创建时再提示 */
    }
  },

  loadTools: async () => {
    try {
      const res = await api?.invoke?.('agent:list-tools')
      if (res?.success) set({ tools: (res.data || []) as AgentToolInfo[] })
    } catch {
      /* 静默失败 */
    }
  },

  createRequest: async (requirement) => {
    set({ creating: true, error: null })
    try {
      const res = await api?.invoke?.('agent:create-request', requirement)
      if (res?.success && res.data) {
        set({ preview: res.data as AgentCreatePreview })
        return res.data as AgentCreatePreview
      }
      set({ error: res?.error || 'AI 生成失败' })
      return null
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) })
      return null
    } finally {
      set({ creating: false })
    }
  },

  confirmCreate: async () => {
    const preview = get().preview
    if (!preview) return null
    set({ creating: true, error: null })
    try {
      const confirmed = { ...preview, confirmed: true }
      const res = await api?.invoke?.('agent:create-confirm', confirmed)
      if (res?.success && res.data) {
        set({ preview: null })
        await get().loadAgents()
        return res.data as AgentDefinition
      }
      set({ error: res?.error || '创建失败' })
      return null
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) })
      return null
    } finally {
      set({ creating: false })
    }
  },

  cancelCreate: () => set({ preview: null }),

  saveAgent: async (def) => {
    set({ error: null })
    try {
      const res = await api?.invoke?.('agent:save', def)
      if (!res?.success) set({ error: res?.error || '保存失败' })
      else await get().loadAgents()
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) })
    }
  },

  deleteAgent: async (id) => {
    set({ error: null })
    try {
      const res = await api?.invoke?.('agent:delete', id)
      if (!res?.success) set({ error: res?.error || '删除失败' })
      else await get().loadAgents()
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) })
    }
  },

  runAgent: async (agentId, messages) => {
    set({ runningAgentId: agentId, events: [], error: null })
    try {
      await api?.invoke?.('agent:run', { agentId, messages })
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) })
    } finally {
      if (get().runningAgentId === agentId) set({ runningAgentId: null })
    }
  },

  stopAgent: async () => {
    const id = get().runningAgentId
    if (!id) return
    try {
      await api?.invoke?.('agent:stop', id)
    } catch {
      /* ignore */
    }
    set({ runningAgentId: null })
  },

  clearEvents: () => set({ events: [] }),
}))

/** 向 store 追加一条运行事件（由页面监听 agent:event 后调用） */
export function pushAgentEvent(agentId: string, ev: AgentRunEvent): void {
  useAgentStore.setState((state) => ({
    runningAgentId: state.runningAgentId || agentId,
    events: [...state.events, ev].slice(-200),
  }))
}
