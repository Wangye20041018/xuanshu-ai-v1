/* ============================================================
 * MCP 工具注册 — mcp-tools.ts
 *
 * 将 MCP 浏览器器官暴露为智能体可调用的统一工具层工具
 * （browser_navigate / browser_snapshot / browser_click /
 *  browser_type / browser_press / browser_scroll /
 *  browser_back / browser_screenshot / mcp_list_servers）。
 *
 * 由 tool-registry.registerAllTools 调用（A-1 接入点）。
 * ============================================================ */

import { ToolDefinition } from '../agent/types'
import { toolRegistry } from '../agent/tool-registry'
import { browserMcpEngine } from './browser-mcp'
import { mcpManager } from './mcp-manager'
import { logger } from '../../shared/logger'
import { app, dialog, BrowserWindow } from 'electron'
import { join } from 'path'
import { mkdirSync } from 'fs'
import { authorization } from '../permission/authorization'

/** 浏览器工具公共参数：selector 定位约定 */
const SEL_DESC =
  '元素定位：支持 CSS 选择器（如 #search-input、button.submit），或 "@文本" 按页面文本定位（如 @登录）。'

/** 把浏览器引擎调用封装为 ToolResult */
function wrap<T>(fn: () => Promise<T>): Promise<{ success: boolean; data?: T; error?: string }> {
  return fn()
    .then((data) => ({ success: true, data }))
    .catch((e) => ({ success: false, error: String(e && e.message ? e.message : e) }))
}

export function registerMcpTools(): void {
  const tools: ToolDefinition[] = [
    {
      name: 'browser_navigate',
      description:
        'MCP 浏览器：打开指定 URL 并加载页面（自动补全 https://）。' +
        '返回当前页面地址与标题。适合开始浏览任务。',
      category: 'operation',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '要打开的网址，如 https://www.baidu.com' },
          waitUntil: {
            type: 'string',
            description: '等待策略，默认 domcontentloaded',
            enum: ['domcontentloaded', 'load', 'networkidle'],
            default: 'domcontentloaded',
          },
        },
        required: ['url'],
      },
      execute: async (p) => wrap(() => browserMcpEngine.navigate(String(p.url), String(p.waitUntil || 'domcontentloaded'))),
    },
    {
      name: 'browser_snapshot',
      description:
        'MCP 浏览器：提取当前页面的结构化快照（标题、链接、按钮、输入框、正文摘要），' +
        '供智能体理解页面内容以决定下一步操作。',
      category: 'operation',
      parameters: {
        type: 'object',
        properties: {
          maxLinks: { type: 'number', description: '最多返回的链接/按钮条目数，默认 60' },
        },
        required: [],
      },
      execute: async (p) => wrap(() => browserMcpEngine.snapshot(Number(p.maxLinks) || 60)),
    },
    {
      name: 'browser_click',
      description: `MCP 浏览器：点击页面上的元素。${SEL_DESC}`,
      category: 'operation',
      parameters: {
        type: 'object',
        properties: { selector: { type: 'string', description: SEL_DESC } },
        required: ['selector'],
      },
      execute: async (p) => wrap(() => browserMcpEngine.click(String(p.selector))),
    },
    {
      name: 'browser_type',
      description: `MCP 浏览器：在输入框中输入文本（默认先清空再输入）。${SEL_DESC}`,
      category: 'operation',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: SEL_DESC },
          text: { type: 'string', description: '要输入的文本内容' },
          clear: { type: 'boolean', description: '是否先清空原内容，默认 true' },
        },
        required: ['selector', 'text'],
      },
      execute: async (p) =>
        wrap(() => browserMcpEngine.type(String(p.selector), String(p.text), p.clear !== false)),
    },
    {
      name: 'browser_press',
      description:
        'MCP 浏览器：按键盘键（Enter/Escape/Tab/ArrowDown 等）。' +
        '用于提交表单、关闭弹窗、选择下拉项。selector 可选，不传则对当前页面全局按键。',
      category: 'operation',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: '按键名，如 Enter / Escape / Tab / ArrowDown' },
          selector: { type: 'string', description: '可选，焦点所在元素定位' },
        },
        required: ['key'],
      },
      execute: async (p) => wrap(() => browserMcpEngine.press(p.selector ? String(p.selector) : null, String(p.key))),
    },
    {
      name: 'browser_scroll',
      description: 'MCP 浏览器：滚动当前页面（up/down/top/bottom）。',
      category: 'operation',
      parameters: {
        type: 'object',
        properties: {
          direction: { type: 'string', description: '滚动方向', enum: ['up', 'down', 'top', 'bottom'] },
          amount: { type: 'number', description: '滚动像素，默认 600（top/bottom 忽略）' },
        },
        required: ['direction'],
      },
      execute: async (p) =>
        wrap(() => browserMcpEngine.scroll(String(p.direction) as any, Number(p.amount) || 600)),
    },
    {
      name: 'browser_back',
      description: 'MCP 浏览器：返回上一页。',
      category: 'operation',
      parameters: { type: 'object', properties: {}, required: [] },
      execute: async () => wrap(() => browserMcpEngine.back()),
    },
    {
      name: 'browser_screenshot',
      description: 'MCP 浏览器：对当前页面截图并保存为 PNG，返回截图文件路径。',
      category: 'operation',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '可选，保存路径；不传则保存到用户目录 McpScreenshots/' },
        },
        required: [],
      },
      execute: async (p) => {
        return wrap(async () => {
          const base = p.path
            ? String(p.path)
            : join(app.getPath('pictures'), 'McpScreenshots', `mcp_${Date.now()}.png`)
          mkdirSync(require('path').dirname(base), { recursive: true })
          return browserMcpEngine.screenshot(base)
        })
      },
    },
    {
      name: 'mcp_list_servers',
      description: '列出当前已注册的 MCP server（内置浏览器 / 社区 server）及其状态。',
      category: 'system',
      parameters: { type: 'object', properties: {}, required: [] },
      execute: async () => ({ success: true, data: mcpManager.list() }),
    },
    {
      name: 'browser_evaluate',
      description:
        'MCP 浏览器：在当前页面执行任意 JavaScript 并返回结果（#26 深度开放能力）。' +
        '可用于读取/修改 DOM、调用页面 API、提取复杂数据等 snapshot 无法覆盖的场景。' +
        '⚠️ 危险工具：执行任意 JS 可能改变页面状态或触发页面内操作，执行前需人工确认。',
      category: 'operation',
      dangerous: true,
      parameters: {
        type: 'object',
        properties: {
          expression: { type: 'string', description: '要执行的 JavaScript 代码，如 document.title 或 "document.querySelector(\'#search\').value = \'x\'"' },
          arg: { type: 'string', description: '可选，传入代码的参数（代码中可用第一个形参引用，如 (arg) => ...）' },
        },
        required: ['expression'],
      },
      confirm: async (p) => {
        // 分级授权检查：browser-evaluate 要求 L2（需确认）
        const access = authorization.canAccess('browser-evaluate', 'tool', 'browser_evaluate')
        if (!access.allowed) {
          logger.warn(`[McpTools] browser_evaluate 被分级授权拦截（当前 L${authorization.getLevel()}）`)
          authorization.log({
            channel: 'browser', action: 'browser-evaluate',
            level: access.level, decision: 'blocked',
            detail: `授权级别不足 (L${authorization.getLevel()})，需 L${access.level}`,
          })
          return false
        }
        const expr = String(p?.expression || '').slice(0, 400)
        const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
        if (!win || win.isDestroyed()) return false
        try {
          const { response } = await dialog.showMessageBox(win, {
            type: 'warning',
            title: '浏览器深度控制确认',
            message: '玄枢即将在当前网页执行一段 JavaScript',
            detail: `代码：${expr}\n\n该操作可在页面内读取或修改任意内容（如点击、填表、跳转）。如非本人发起，请点击取消。`,
            buttons: ['允许', '取消'],
            defaultId: 1,
            cancelId: 1,
          })
          if (response !== 0) {
            authorization.log({ channel: 'browser', action: 'browser-evaluate', decision: 'deny', detail: '用户取消' })
            return false
          }
          return true
        } catch {
          return false
        }
      },
      execute: async (p) => {
        const expression = String(p?.expression || '')
        if (!expression.trim()) return { success: false, error: 'expression 不能为空' }
        const res = await wrap(() => browserMcpEngine.evaluate(expression, p?.arg))
        authorization.log({
          channel: 'browser', action: 'browser-evaluate', decision: 'allow',
          detail: `执行 JS: ${expression.slice(0, 200)}`,
        })
        return res
      },
    },
  ]

  toolRegistry.registerAll(tools)
  logger.info(`[McpTools] MCP 工具注册完成，共 ${tools.length} 个 (browser_* + mcp_list_servers)`)
}

/** 应用退出时释放 MCP 浏览器资源 */
export async function shutdownMcp(): Promise<void> {
  await mcpManager.shutdown()
}
