/* ============================================================
 * MCP 管理器 — mcp-manager.ts
 *
 * 统一管理 MCP server 的注册表与生命周期：
 *  - 内置浏览器 MCP（builtin-browser，Playwright 实现）
 *  - 社区 MCP server（stdio 协议，预留对接，可动态注册）
 *
 * 提供 list / status 查询，供 UI 与智能体使用（A-1）。
 * ============================================================ */

import { McpServerInfo, RemoteMcpServerConfig } from './mcp-types'
import { browserMcpEngine } from './browser-mcp'
import { logger } from '../../shared/logger'

class McpManager {
  private servers = new Map<string, McpServerInfo>()
  private remoteConfigs = new Map<string, RemoteMcpServerConfig>()

  constructor() {
    // 注册内置浏览器 MCP 器官
    this.servers.set('builtin-browser', {
      id: 'builtin-browser',
      name: '内置浏览器 (Playwright)',
      type: 'builtin',
      status: 'registered',
      toolPrefix: 'browser_',
      detail: '基于 Playwright 的无头 Chromium，供智能体浏览/点击/输入/截图',
    })
  }

  /** 注册社区 MCP server 配置 */
  registerRemote(config: RemoteMcpServerConfig): void {
    this.remoteConfigs.set(config.id, config)
    if (config.enabled) {
      this.servers.set(config.id, {
        id: config.id,
        name: config.name,
        type: 'remote',
        status: 'connected',
        toolPrefix: config.id.replace(/^.*-/, '') + '_',
        detail: `命令: ${config.command.join(' ')}`,
      })
    }
  }

  /** 移除社区 server */
  unregisterRemote(id: string): void {
    this.remoteConfigs.delete(id)
    this.servers.delete(id)
  }

  /** 查询全部 server 信息（浏览器状态实时刷新） */
  list(): McpServerInfo[] {
    const info = this.servers.get('builtin-browser')!
    info.status = browserMcpEngine.isRunning() ? 'connected' : 'registered'
    info.detail = browserMcpEngine.isRunning()
      ? `浏览器运行中: ${browserMcpEngine.currentTitle || '(空白页)'}`
      : '浏览器空闲（首次调用时自动启动）'
    return Array.from(this.servers.values())
  }

  /** 关闭内置浏览器 */
  async shutdown(): Promise<void> {
    await browserMcpEngine.close()
    logger.info('[McpManager] 全部 MCP 资源已释放')
  }
}

/** 全局单例 */
export const mcpManager = new McpManager()
