/**
 * 内置浏览器 — 入口 + IPC Handler 注册
 *
 * 通道（browser:*）：
 *   create-tab / close-tab / switch-tab / navigate / go-back / go-forward / reload /
 *   list-tabs / extract-content / screenshot / set-bounds / add-bookmark / list-bookmarks / remove-bookmark
 *
 * @module main/browser
 */

import { ipcMain, app } from 'electron'
import fs from 'fs'
import path from 'path'
import { logger } from '../../shared/logger'
import { browserManager } from './browser-manager'

export { browserManager } from './browser-manager'
export type { BrowserTab } from './browser-manager'

/** 书签文件（userData/browser-bookmarks.json） */
function bookmarksPath(): string {
  return path.join(app.getPath('userData'), 'browser-bookmarks.json')
}

function readBookmarks(): Array<{ url: string; title: string; createdAt: number }> {
  try {
    const p = bookmarksPath()
    if (!fs.existsSync(p)) return []
    const parsed = JSON.parse(fs.readFileSync(p, 'utf-8'))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeBookmarks(list: Array<{ url: string; title: string; createdAt: number }>): boolean {
  try {
    fs.writeFileSync(bookmarksPath(), JSON.stringify(list, null, 2), 'utf-8')
    return true
  } catch (e) {
    logger.warn(`[Browser] 写入书签失败: ${e instanceof Error ? e.message : String(e)}`)
    return false
  }
}

export function setupBrowserHandlers(): void {
  ipcMain.handle('browser:create-tab', (_event, url?: string) => {
    try {
      return { success: true, data: browserManager.createTab(url ? String(url) : undefined) }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('browser:close-tab', (_event, id: string) => {
    return { success: browserManager.closeTab(String(id || '')) }
  })

  ipcMain.handle('browser:switch-tab', (_event, id: string) => {
    const tab = browserManager.switchTab(String(id || ''))
    return { success: !!tab, data: tab }
  })

  ipcMain.handle('browser:navigate', (_event, args: { id: string; url: string }) => {
    const tab = browserManager.navigate(String(args?.id || ''), String(args?.url || ''))
    return { success: !!tab, data: tab }
  })

  ipcMain.handle('browser:go-back', (_event, id: string) => {
    browserManager.goBack(String(id || ''))
    return { success: true }
  })

  ipcMain.handle('browser:go-forward', (_event, id: string) => {
    browserManager.goForward(String(id || ''))
    return { success: true }
  })

  ipcMain.handle('browser:reload', (_event, id: string) => {
    browserManager.reload(String(id || ''))
    return { success: true }
  })

  ipcMain.handle('browser:list-tabs', () => {
    return { success: true, data: browserManager.listTabs(), activeTabId: browserManager.activeTab()?.id || null }
  })

  ipcMain.handle('browser:set-bounds', (_event, bounds: { x: number; y: number; width: number; height: number }) => {
    if (bounds && Number.isFinite(bounds.x) && Number.isFinite(bounds.y)) {
      browserManager.setBounds(bounds)
    }
    return { success: true }
  })

  ipcMain.handle('browser:extract-content', async (_event, id: string) => {
    return browserManager.extractContent(String(id || ''))
  })

  ipcMain.handle('browser:screenshot', async (_event, id: string) => {
    return browserManager.screenshot(String(id || ''))
  })

  // ===== 书签 =====
  ipcMain.handle('browser:add-bookmark', (_event, bm: { url: string; title: string }) => {
    const list = readBookmarks()
    if (!bm?.url) return { success: false, error: 'URL 不能为空' }
    const existing = list.find((b) => b.url === bm.url)
    if (!existing) {
      list.unshift({ url: bm.url, title: bm.title || bm.url, createdAt: Date.now() })
    }
    return { success: writeBookmarks(list), data: list }
  })

  ipcMain.handle('browser:list-bookmarks', () => {
    return { success: true, data: readBookmarks() }
  })

  ipcMain.handle('browser:remove-bookmark', (_event, url: string) => {
    const list = readBookmarks().filter((b) => b.url !== url)
    return { success: writeBookmarks(list), data: list }
  })

  logger.debug('[Browser] setupBrowserHandlers registered')
}
