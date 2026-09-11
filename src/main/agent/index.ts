/* ============================================================
 * Agent 统一框架 — 主入口
 * 导出所有公开接口
 * ============================================================ */

import { ipcMain } from 'electron'
import { logger } from '../../shared/logger'
import { agentStore } from './agent-store'
import { runAgent, stopAgent } from './agent-runtime'
import { toolRegistry } from './tool-registry'
import type { AgentDefinition, AgentRunEvent, AgentRunRequest } from '../../shared/agent-types'
import { personaLoader } from '../persona-loader'

export { ToolRegistry, toolRegistry } from './tool-registry'
export { ReActAgent } from './react-loop'
export { agentStore } from './agent-store'
export { runAgent, stopAgent, stopAllAgents, isAgentRunning } from './agent-runtime'
export { registerControlTools } from './control-tools'
export { createAgentPreview, confirmCreateAgent } from './agent-factory'
export { setupPanicStop, teardownPanicStop, triggerPanicStop, setupPanicHandlers } from './panic-stop'
export type {
  IAgent,
  AgentInput,
  AgentEvent,
  AgentState,
  AgentConfig,
  AgentStats,
  ToolDefinition,
  ToolParameter,
  ToolResult,
} from './types'
export type {
  AgentDefinition,
  AgentMemoryConfig,
  AgentModelConfig,
  AgentPersonaOverride,
} from './agent-types'

export function setupVisualAgentHandlers(): void {
  ipcMain.handle('visual-agent:status', async () => {
    return { status: 'active', message: 'Visual agent module is available' }
  })

  logger.debug('[Agent] setupVisualAgentHandlers registered')
}

export function setupAgentHandlers(): void {
  ipcMain.handle('agent:status', async () => {
    return { status: 'active', message: 'Agent framework is initialized' }
  })

  // ===== 智能体存储 CRUD（T01） =====
  ipcMain.handle('agent:list', async () => {
    return { success: true, data: agentStore.list() }
  })

  ipcMain.handle('agent:get', async (_event, id: string) => {
    const data = agentStore.get(String(id || ''))
    if (!data) return { success: false, error: '智能体不存在' }
    return { success: true, data }
  })

  ipcMain.handle('agent:save', async (_event, def: AgentDefinition) => {
    return agentStore.save(def)
  })

  ipcMain.handle('agent:delete', async (_event, id: string) => {
    return agentStore.delete(String(id || ''))
  })

  // ===== 智能体运行时（T02） =====
  ipcMain.handle('agent:run', async (event, req: AgentRunRequest) => {
    const sender = event.sender
    const sendEvent = (ev: AgentRunEvent): void => {
      try {
        if (!sender.isDestroyed()) sender.send('agent:event', { agentId: req?.agentId, ...ev })
      } catch {
        /* pipe broken */
      }
    }
    await runAgent(req, sendEvent)
    return { success: true }
  })

  ipcMain.handle('agent:stop', async (_event, agentId: string) => {
    stopAgent(String(agentId || ''))
    return { success: true }
  })

  ipcMain.handle('agent:list-personas', async () => {
    try {
      return { success: true, data: personaLoader.listPersonas() }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('agent:list-tools', async () => {
    try {
      const data = toolRegistry.getAll().map((t) => ({
        name: t.name,
        description: t.description,
        category: t.category,
        dangerous: !!t.dangerous,
        // §8 权限分级与副作用（显式缺失时按 dangerous 推断，供豆包权限设置 UI 展示）
        permissionLevel: t.permissionLevel ?? (t.dangerous ? 'danger' : 'read') as 'read' | 'act' | 'danger',
        sideEffect: t.sideEffect ?? (t.dangerous ? 'irreversible' : 'none') as 'none' | 'mutate' | 'irreversible',
      }))
      return { success: true, data }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  // ===== 动态创建（T03） =====
  ipcMain.handle('agent:create-request', async (_event, requirement: string) => {
    const { createAgentPreview } = await import('./agent-factory')
    return createAgentPreview(String(requirement || ''))
  })

  ipcMain.handle('agent:create-confirm', async (_event, preview: import('../../shared/agent-types').AgentCreatePreview) => {
    const { confirmCreateAgent } = await import('./agent-factory')
    return confirmCreateAgent(preview)
  })

  // ===== 施工蓝本 §5：二十智能体清单（manifest 纯数据，供豆包 UI 消费） =====
  ipcMain.handle('agent:list-manifests', async () => {
    try {
      const { getAgentManifests } = await import('./agent-manifests')
      return { success: true, data: getAgentManifests() }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('agent:get-manifest', async (_event, id: string) => {
    try {
      const { getManifestById } = await import('./agent-manifests')
      const data = getManifestById(String(id || ''))
      if (!data) return { success: false, error: '清单不存在' }
      return { success: true, data }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('agent:seed-manifests', async () => {
    try {
      const { ensureManifestAgents } = await import('./preset-agents')
      const count = ensureManifestAgents()
      return { success: true, data: { seeded: count } }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  // ===== §12:AI 总调度（MetaConductor）IPC =====
  ipcMain.handle('meta:apps-list', async () => {
    try {
      const { metaConductor } = await import('./meta-conductor')
      return { success: true, data: metaConductor.list() }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('meta:apps-register', async (_event, input: Record<string, unknown>) => {
    try {
      const { metaConductor } = await import('./meta-conductor')
      const key = String(input?.key || '').trim()
      const name = String(input?.name || '').trim()
      if (!key) return { success: false, error: 'key 必填' }
      const splitList = (v: unknown): string[] =>
        (typeof v === 'string' ? v : Array.isArray(v) ? v.join(',') : '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      const data = metaConductor.register({
        key,
        name: name || key,
        rootPath: input?.rootPath ? String(input.rootPath) : undefined,
        strengths: splitList(input?.strengths),
        ownedDomains: splitList(input?.ownedDomains),
        briefPath: input?.briefPath ? String(input.briefPath) : undefined,
        notes: input?.notes ? String(input.notes) : undefined,
      })
      return { success: true, data }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('meta:apps-unregister', async (_event, key: string) => {
    try {
      const { metaConductor } = await import('./meta-conductor')
      return { success: metaConductor.unregister(String(key || '')) }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('meta:apps-inflight', async () => {
    try {
      const { metaConductor } = await import('./meta-conductor')
      return { success: true, data: metaConductor.inflightInfo() }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  // ===== 控制白名单（T03） =====
  ipcMain.handle('agent:whitelist-list', async () => {
    try {
      const { controlWhitelist } = await import('../permission/control-whitelist')
      return { success: true, data: controlWhitelist.list() }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('agent:whitelist-add', async (_event, args: { toolName: string; scope?: 'tool' | 'category'; category?: string }) => {
    try {
      const { controlWhitelist } = await import('../permission/control-whitelist')
      const ok = controlWhitelist.add(String(args?.toolName || ''), args?.scope ?? 'tool', args?.category)
      return { success: ok }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('agent:whitelist-remove', async (_event, toolName: string) => {
    try {
      const { controlWhitelist } = await import('../permission/control-whitelist')
      const ok = controlWhitelist.remove(String(toolName || ''))
      return { success: ok }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  logger.debug('[Agent] setupAgentHandlers registered')
}
