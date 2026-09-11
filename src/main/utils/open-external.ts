/**
 * 外部浏览器打开工具（浏览器功能移除后的"联网借用 Edge"能力）
 *
 * 内置浏览器功能已整体移除，联网动作改由系统默认浏览器 / 本机 Edge 承接：
 * - openInBrowser(url)   : 走 shell.openExternal 交给系统默认浏览器
 * - openInEdge(url)      : 优先调用本机 Edge（msedge.exe），缺失时回退 openInBrowser
 * - setupOpenExternalHandlers() : 注册 IPC 'browser:open-external' 供 renderer/agent 调用
 *
 */
import { ipcMain, shell, app } from 'electron'
import path from 'path'
import fs from 'fs'
import { spawn } from 'child_process'
import { createLogger } from '../../shared/logger'

const logger = createLogger('OpenExternal')

const EDGE_CANDIDATES = (): string[] => {
  const pf = process.env['PROGRAMFILES'] || path.join(process.env['SystemDrive'] || 'C:', 'Program Files')
  const pf86 = process.env['PROGRAMFILES(X86)'] || path.join(process.env['SystemDrive'] || 'C:', 'Program Files (x86)')
  const lr = process.env['LOCALAPPDATA'] || path.join(app.getPath('userData'), '..', '..', 'Local')
  const edge = path.join('Microsoft', 'Edge', 'Application', 'msedge.exe')
  return [
    path.join(pf, edge),
    path.join(pf86, edge),
    path.join(lr, edge),
    path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ]
}

function assertHttpUrl(url: string): string {
  const u = String(url || '').trim()
  if (!/^https?:\/\//i.test(u)) {
    throw new Error(`仅支持 http/https 链接，收到: ${u.slice(0, 64)}`)
  }
  return u
}

/** 打开系统默认浏览器 */
export async function openInBrowser(url: string): Promise<void> {
  const u = assertHttpUrl(url)
  await shell.openExternal(u)
  logger.info(`[openInBrowser] 已交给系统默认浏览器: ${u}`)
}

/** 优先用本机 Edge 打开（内置浏览器移除后的主路径） */
export async function openInEdge(url: string): Promise<void> {
  const u = assertHttpUrl(url)
  for (const exe of EDGE_CANDIDATES()) {
    try {
      if (fs.existsSync(exe)) {
        const child = spawn(exe, [u], { detached: true, stdio: 'ignore' })
        child.unref()
        logger.info(`[openInEdge] 已用 ${exe} 打开: ${u}`)
        return
      }
    } catch {
      /* 尝试下一个候选 */
    }
  }
  await openInBrowser(u)
}

/** 打开外部浏览器（默认走本机 Edge，可切换系统默认） */
export function openInExternalBrowser(url: string, prefer: 'edge' | 'default' = 'edge'): Promise<void> {
  return prefer === 'edge' ? openInEdge(url) : openInBrowser(url)
}

/** 注册 IPC 'browser:open-external'（renderer / agent 联网入口） */
export function setupOpenExternalHandlers(): void {
  ipcMain.handle('browser:open-external', async (_e, payload) => {
    try {
      const url = payload?.url
      if (!url) return { success: false, error: '缺少 url 参数' }
      const prefer: 'edge' | 'default' = payload?.prefer === 'default' ? 'default' : 'edge'
      await openInExternalBrowser(String(url), prefer)
      return { success: true }
    } catch (err) {
      logger.warn(`[open-external] 打开失败: ${String(err)}`)
      return { success: false, error: String(err) }
    }
  })
}
