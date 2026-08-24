/**
 * 内置浏览器 — WebContentsView 标签页管理
 *
 * 选型：WebContentsView（Electron 32，BrowserView 已废弃、webview 有 RCE 面）。
 *  - 每个标签页独立 session partition，隔离登录态（与主应用 session 分离）。
 *  - 渲染层只发指令、收状态，主进程全权控制导航/加载/执行 JS。
 *  - 安全拦截：外链在新标签打开、非法 scheme 拒绝、下载统一到下载目录。
 *
 * @module main/browser/browser-manager
 */

import { WebContentsView, BrowserWindow, app } from 'electron'
import fs from 'fs'
import path from 'path'
import { logger } from '../../shared/logger'

export interface BrowserTab {
  id: string
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
}

interface TabRecord {
  id: string
  view: WebContentsView
  url: string
  title: string
  loading: boolean
}

/** 允许的协议（浏览器导航白名单，拒绝 file:// 等危险 scheme） */
function isAllowedScheme(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'about:'
  } catch {
    return false
  }
}

/** 从任意 URL 提取首页地址（作为新标签默认页） */
function normalizeUrl(input: string): string {
  const s = String(input || '').trim()
  if (!s) return 'https://www.baidu.com'
  if (/^(https?:\/\/)/i.test(s)) return s
  if (/^about:/i.test(s)) return s
  // 无协议：补 https；含点视为域名，否则视为搜索词交给搜索引擎
  if (s.includes('.') && !s.includes(' ')) return `https://${s}`
  return `https://www.baidu.com/s?wd=${encodeURIComponent(s)}`
}

class BrowserManager {
  private tabs: Map<string, TabRecord> = new Map()
  private activeTabId: string | null = null
  private order: string[] = []
  private bounds = { x: 0, y: 0, width: 800, height: 600 }

  /** 获取主窗口（懒加载，窗口销毁时返回 null） */
  private getWindow(): BrowserWindow | null {
    const win = BrowserWindow.getAllWindows()[0]
    return win && !win.isDestroyed() ? win : null
  }

  /** 创建新标签页 */
  createTab(url?: string): BrowserTab {
    const id = `tab-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    const win = this.getWindow()
    if (!win) {
      throw new Error('无可用窗口')
    }
    const partition = `persist:agent-browser-${id}`
    const view = new WebContentsView({
      webPreferences: {
        partition,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    })
    view.setBounds(this.bounds)
    win.contentView.addChildView(view)
    view.setVisible(false)

    const record: TabRecord = {
      id,
      view,
      url: 'about:blank',
      title: '新标签页',
      loading: false,
    }
    this.tabs.set(id, record)
    this.order.push(id)

    this.attachSecurityHandlers(record)
    this.attachNavigationHandlers(record)

    // 激活并加载
    this.switchTab(id)
    if (url) this.navigate(id, url)

    return this.toTab(record)
  }

  /** 关闭标签页 */
  closeTab(id: string): boolean {
    const rec = this.tabs.get(id)
    if (!rec) return false
    try {
      this.detachView(rec.view)
    } catch (e) {
      logger.warn(`[Browser] 移除 view 失败: ${e instanceof Error ? e.message : String(e)}`)
    }
    this.tabs.delete(id)
    this.order = this.order.filter((t) => t !== id)
    if (this.activeTabId === id) {
      const next = this.order[this.order.length - 1]
      this.activeTabId = next || null
      if (next) this.showView(this.tabs.get(next)!)
    }
    return true
  }

  /** 切换激活标签页 */
  switchTab(id: string): BrowserTab | null {
    const rec = this.tabs.get(id)
    if (!rec) return null
    // 隐藏当前
    if (this.activeTabId && this.activeTabId !== id) {
      const cur = this.tabs.get(this.activeTabId)
      if (cur) this.hideView(cur)
    }
    this.activeTabId = id
    this.showView(rec)
    return this.toTab(rec)
  }

  /** 导航 */
  navigate(id: string, url: string): BrowserTab | null {
    const rec = this.tabs.get(id)
    if (!rec) return null
    const target = normalizeUrl(url)
    if (!isAllowedScheme(target)) {
      logger.warn(`[Browser] 拒绝导航到非法协议: ${target}`)
      return this.toTab(rec)
    }
    rec.view.webContents.loadURL(target).catch((e) => {
      logger.warn(`[Browser] 加载失败 ${target}: ${e instanceof Error ? e.message : String(e)}`)
    })
    rec.url = target
    rec.loading = true
    return this.toTab(rec)
  }

  goBack(id: string): void {
    const rec = this.tabs.get(id)
    if (rec && rec.view.webContents.navigationHistory.canGoBack()) rec.view.webContents.navigationHistory.goBack()
  }

  goForward(id: string): void {
    const rec = this.tabs.get(id)
    if (rec && rec.view.webContents.navigationHistory.canGoForward()) rec.view.webContents.navigationHistory.goForward()
  }

  reload(id: string): void {
    const rec = this.tabs.get(id)
    rec?.view.webContents.reload()
  }

  /** 列出所有标签页 */
  listTabs(): BrowserTab[] {
    return this.order.map((id) => {
      const rec = this.tabs.get(id)
      return rec ? this.toTab(rec) : ({ id, url: '', title: '', loading: false, canGoBack: false, canGoForward: false } as BrowserTab)
    })
  }

  /** 获取当前激活标签页 */
  activeTab(): BrowserTab | null {
    if (!this.activeTabId) return null
    const rec = this.tabs.get(this.activeTabId)
    return rec ? this.toTab(rec) : null
  }

  /** 设置内容区 bounds（渲染层测量容器后上报） */
  setBounds(bounds: { x: number; y: number; width: number; height: number }): void {
    this.bounds = { ...bounds }
    const rec = this.activeTabId ? this.tabs.get(this.activeTabId) : null
    if (rec) rec.view.setBounds(this.bounds)
  }

  /** 提取当前页正文（喂给 AI） */
  async extractContent(id: string): Promise<{ success: boolean; data?: { title: string; url: string; text: string }; error?: string }> {
    const rec = this.tabs.get(id)
    if (!rec) return { success: false, error: '标签页不存在' }
    try {
      const result = await rec.view.webContents.executeJavaScript(`(() => {
        const clone = document.body ? document.body.cloneNode(true) : null;
        // 移除脚本/样式/导航等噪声
        if (clone) {
          ['script','style','noscript','svg','nav','footer','header','aside','iframe'].forEach(tag => {
            clone.querySelectorAll(tag).forEach(n => n.remove());
          });
        }
        const text = clone ? clone.innerText : document.body?.innerText || '';
        return { title: document.title, text: text.slice(0, 20000) };
      })()`)
      return {
        success: true,
        data: { title: result?.title || rec.title, url: rec.url, text: String(result?.text || '').slice(0, 20000) },
      }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  /** 截图当前页（返回 base64 PNG） */
  async screenshot(id: string): Promise<{ success: boolean; data?: { dataUrl: string }; error?: string }> {
    const rec = this.tabs.get(id)
    if (!rec) return { success: false, error: '标签页不存在' }
    try {
      const image = await rec.view.webContents.capturePage()
      return { success: true, data: { dataUrl: image.toDataURL() } }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  /** 销毁所有标签页（窗口关闭时调用） */
  destroyAll(): void {
    for (const rec of this.tabs.values()) {
      try {
        this.detachView(rec.view)
        if (!rec.view.webContents.isDestroyed()) rec.view.webContents.close()
      } catch {
        /* ignore */
      }
    }
    this.tabs.clear()
    this.order = []
    this.activeTabId = null
  }

  /* ==================== 内部辅助 ==================== */

  private toTab(rec: TabRecord): BrowserTab {
    const nav = rec.view.webContents.navigationHistory
    return {
      id: rec.id,
      url: rec.url,
      title: rec.title,
      loading: rec.loading,
      canGoBack: nav.canGoBack(),
      canGoForward: nav.canGoForward(),
    }
  }

  private showView(rec: TabRecord): void {
    try {
      rec.view.setBounds(this.bounds)
      rec.view.setVisible(true)
    } catch (e) {
      logger.warn(`[Browser] 显示 view 失败: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  private hideView(rec: TabRecord): void {
    try {
      rec.view.setVisible(false)
    } catch {
      /* ignore */
    }
  }

  private detachView(view: WebContentsView): void {
    const win = this.getWindow()
    if (win) {
      try {
        win.contentView.removeChildView(view)
      } catch {
        /* ignore */
      }
    }
    if (!view.webContents.isDestroyed()) {
      try {
        view.webContents.close()
      } catch {
        /* ignore */
      }
    }
  }

  /** 安全拦截：新窗口打开为新标签、非法 scheme 拒绝 */
  private attachSecurityHandlers(rec: TabRecord): void {
    rec.view.webContents.setWindowOpenHandler(({ url }) => {
      if (isAllowedScheme(url)) {
        setImmediate(() => {
          try {
            this.createTab(url)
          } catch {
            /* ignore */
          }
        })
      }
      return { action: 'deny' }
    })

    rec.view.webContents.on('will-navigate', (event, url) => {
      if (!isAllowedScheme(url)) {
        event.preventDefault()
        logger.warn(`[Browser] 已拦截非法导航: ${url}`)
      }
    })

    // 下载统一交系统下载目录（防止静默落盘到任意路径）
    try {
      rec.view.webContents.session.on('will-download', (event, item) => {
        const dir = path.join(app.getPath('downloads'), 'xuanshu-browser')
        try {
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
          item.setSavePath(path.join(dir, item.getFilename()))
        } catch {
          event.preventDefault()
        }
      })
    } catch {
      /* ignore */
    }
  }

  private attachNavigationHandlers(rec: TabRecord): void {
    rec.view.webContents.on('did-start-loading', () => {
      rec.loading = true
      this.broadcast()
    })
    rec.view.webContents.on('did-stop-loading', () => {
      rec.loading = false
      this.broadcast()
    })
    rec.view.webContents.on('page-title-updated', (_e, title) => {
      rec.title = title
      this.broadcast()
    })
    rec.view.webContents.on('did-navigate', (_e, url) => {
      rec.url = url
      this.broadcast()
    })
    rec.view.webContents.on('did-navigate-in-page', (_e, url) => {
      rec.url = url
      this.broadcast()
    })
  }

  /** 广播标签页状态变化到渲染层 */
  private broadcast(): void {
    try {
      const win = this.getWindow()
      if (win && !win.isDestroyed()) {
        win.webContents.send('browser:event', { tabs: this.listTabs(), activeTabId: this.activeTabId })
      }
    } catch {
      /* ignore */
    }
  }
}

/** 全局单例 */
export const browserManager = new BrowserManager()
