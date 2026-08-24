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

export { ToolRegistry, toolRegistry } from './tool-registry'
export { ReActAgent } from './react-loop'
export { agentStore } from './agent-store'
export { runAgent, stopAgent, stopAllAgents, isAgentRunning } from './agent-runtime'
export { registerControlTools } from './control-tools'
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
      const { personaLoader } = await import('../persona-loader')
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
      }))
      return { success: true, data }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  logger.debug('[Agent] setupAgentHandlers registered')
}
