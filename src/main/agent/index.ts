/* ============================================================
 * Agent 统一框架 — 主入口
 * 导出所有公开接口
 * ============================================================ */

import { ipcMain } from 'electron'
import { logger } from '../../shared/logger'
import { agentStore } from './agent-store'
import type { AgentDefinition } from '../../shared/agent-types'

export { ToolRegistry, toolRegistry } from './tool-registry'
export { ReActAgent } from './react-loop'
export { agentStore } from './agent-store'
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

  logger.debug('[Agent] setupAgentHandlers registered')
}
