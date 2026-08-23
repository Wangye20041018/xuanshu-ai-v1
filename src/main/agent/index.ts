/* ============================================================
 * Agent 统一框架 — 主入口
 * 导出所有公开接口
 * ============================================================ */

import { ipcMain } from 'electron'
import { logger } from '../../shared/logger'

export { ToolRegistry, toolRegistry } from './tool-registry'
export { ReActAgent } from './react-loop'
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

  logger.debug('[Agent] setupAgentHandlers registered')
}
