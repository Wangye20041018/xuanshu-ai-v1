/* ============================================================
 * MCP（Model Context Protocol）— 类型定义
 *
 * 设计说明：
 *  - 内置"浏览器 MCP 器官"：将 Playwright 操控的本地浏览器封装为
 *    MCP 风格工具集（browser_navigate / browser_snapshot / browser_click /
 *    browser_type / browser_scroll / browser_screenshot / browser_back / browser_close），
 *    注册进统一 ToolRegistry，供智能体经统一工具层调度（A-1）。
 *  - 社区 MCP server：预留 stdio 直连的 MCP Client 骨架，可对接
 *    filesystem / fetch / git 等社区 server（经 mcpManager 管理）。
 * ============================================================ */

/** MCP server 类型 */
export type McpServerType = 'builtin' | 'remote'

/** MCP server 健康状态 */
export type McpServerStatus = 'registered' | 'connected' | 'error'

/** MCP server 描述 */
export interface McpServerInfo {
  /** server 唯一 ID（如 builtin-browser / remote-filesystem） */
  id: string
  /** 显示名（如 内置浏览器 / 社区 filesystem） */
  name: string
  type: McpServerType
  status: McpServerStatus
  /** 该 server 暴露的工具名前缀（如 browser_ / fs_） */
  toolPrefix: string
  /** 备注/错误信息 */
  detail?: string
}

/** 社区 MCP server 连接配置（stdio 启动命令） */
export interface RemoteMcpServerConfig {
  id: string
  name: string
  /** 启动命令，如 ["npx", "-y", "@modelcontextprotocol/server-filesystem", "<dir>"] */
  command: string[]
  /** 环境变量（可选） */
  env?: Record<string, string>
  enabled: boolean
}

/** 浏览器 MCP 快照条目（供 LLM 理解页面） */
export interface BrowserSnapshotItem {
  type: 'link' | 'button' | 'input' | 'text' | 'heading'
  text: string
  selector: string
  href?: string
}
