/* ============================================================
 * MCP 浏览器器官 — browser-mcp.ts
 *
 * 将 Playwright 操控的本地 Chromium 封装为 MCP 风格工具集，
 * 供智能体经统一 ToolRegistry 调度（A-1 浏览器 MCP 化）。
 *
 * 参考 browser-search.ts 的 playwright 用法（require 动态加载、
 * chromium.launch + newContext + newPage 反检测）。
 * 浏览器实例按需懒启动、带会话状态（保留当前页面），
 * 空闲超时自动关闭以释放显存/内存。
 * ============================================================ */

import { BrowserSnapshotItem } from './mcp-types'
import { logger } from '../../shared/logger'

/** 空闲自动关闭阈值（毫秒） */
const IDLE_CLOSE_MS = 5 * 60 * 1000

/** 单次操作默认超时（毫秒） */
const OP_TIMEOUT_MS = 30_000

/** 供 LLM 定位元素的 CSS 选择器，最多返回条数 */
const MAX_SNAPSHOT_LINKS = 60
const MAX_SNAPSHOT_TEXT = 2000

class BrowserMcpEngine {
  private browser: any = null
  private page: any = null
  private context: any = null
  private idleTimer: NodeJS.Timeout | null = null
  private _currentUrl = ''
  private _currentTitle = ''

  /** 懒加载 playwright（兼容 ESM/CJS） */
  private async loadPlaywright(): Promise<any> {
    try {
      return require('playwright')
    } catch {
      // @ts-ignore
      return await import('playwright')
    }
  }

  /** 确保浏览器实例已启动 */
  private async ensureBrowser(): Promise<void> {
    if (this.browser && this.browser.isConnected()) return

    const pw = await this.loadPlaywright()
    const { chromium } = pw

    this.browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-blink-features=AutomationControlled',
      ],
    })

    this.context = await this.browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      viewport: { width: 1366, height: 768 },
      locale: 'zh-CN',
      extraHTTPHeaders: {
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      },
    })

    this.page = await this.context.newPage()
    // 反检测
    await this.page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false })
      // @ts-ignore
      window.chrome = { runtime: {} }
    })

    logger.info('[McpBrowser] 浏览器实例已启动 (headless chromium)')
    this.touch()
  }

  /** 刷新空闲计时器 */
  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      this.close().catch(() => {})
    }, IDLE_CLOSE_MS)
  }

  /** 关闭浏览器 */
  async close(): Promise<void> {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null }
    try { if (this.browser) await this.browser.close() } catch { /* ignore */ }
    this.browser = null
    this.context = null
    this.page = null
    logger.info('[McpBrowser] 浏览器实例已关闭')
  }

  /** 是否已启动 */
  isRunning(): boolean {
    return !!(this.browser && this.browser.isConnected() && this.page)
  }

  get currentUrl(): string { return this._currentUrl }
  get currentTitle(): string { return this._currentTitle }

  /** 导航到 URL */
  async navigate(url: string, waitUntil: string = 'domcontentloaded'): Promise<{ url: string; title: string }> {
    await this.ensureBrowser()
    const normalized = /^https?:\/\//i.test(url) ? url : `https://${url}`
    await this.page.goto(normalized, { waitUntil, timeout: OP_TIMEOUT_MS })
    await this.page.waitForLoadState('domcontentloaded').catch(() => {})
    this._currentUrl = this.page.url()
    this._currentTitle = await this.page.title().catch(() => '')
    this.touch()
    return { url: this._currentUrl, title: this._currentTitle }
  }

  /** 提取页面快照（链接/按钮/输入框/标题/正文摘要） */
  async snapshot(maxLinks: number = MAX_SNAPSHOT_LINKS, maxText: number = MAX_SNAPSHOT_TEXT): Promise<{
    url: string
    title: string
    items: BrowserSnapshotItem[]
    bodyPreview: string
  }> {
    await this.ensureBrowser()
    const snap = await this.page.evaluate(
      (opts: { maxLinks: number; maxText: number }) => {
        const { maxLinks, maxText } = opts
        const out: BrowserSnapshotItem[] = []
        const push = (t: BrowserSnapshotItem) => { if (t.text && out.length < maxLinks) out.push(t) }

        document.querySelectorAll('a[href]').forEach((a) => {
          const text = (a.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 120)
          const href = (a as HTMLAnchorElement).href
          if (text && href && !href.startsWith('javascript:')) push({ type: 'link', text, selector: '', href })
        })
        document.querySelectorAll('button, [role="button"]').forEach((b) => {
          const text = (b.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80)
          if (text) push({ type: 'button', text, selector: '' })
        })
        document.querySelectorAll('input, textarea, select').forEach((i) => {
          const name = (i as HTMLInputElement).name || (i as HTMLInputElement).placeholder || i.id || ''
          if (name) push({ type: 'input', text: name.slice(0, 80), selector: '' })
        })
        document.querySelectorAll('h1,h2,h3').forEach((h) => {
          const text = (h.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 100)
          if (text) push({ type: 'heading', text, selector: '' })
        })

        const body = (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, maxText)
        return { items: out, bodyPreview: body }
      },
      { maxLinks, maxText },
    )
    this._currentUrl = this.page.url()
    this._currentTitle = await this.page.title().catch(() => '')
    this.touch()
    return { url: this._currentUrl, title: this._currentTitle, items: snap.items, bodyPreview: snap.bodyPreview }
  }

  /** 解析选择器：支持 CSS 选择器或 @文本 定位 */
  private async resolveSelector(selector: string): Promise<any> {
    await this.ensureBrowser()
    const s = selector.trim()
    if (s.startsWith('@')) {
      const text = s.slice(1).trim()
      const byText = this.page.getByText(text, { exact: false }).first()
      if (await byText.count()) return byText
      return this.page.getByRole('link', { name: text }).first()
    }
    return this.page.locator(s).first()
  }

  /** 点击元素 */
  async click(selector: string): Promise<{ clicked: boolean; url?: string }> {
    await this.ensureBrowser()
    const loc = await this.resolveSelector(selector)
    await loc.click({ timeout: OP_TIMEOUT_MS })
    await this.page.waitForTimeout(400)
    this._currentUrl = this.page.url()
    this.touch()
    return { clicked: true, url: this._currentUrl }
  }

  /** 输入文本（可选先清空） */
  async type(selector: string, text: string, clear: boolean = true): Promise<{ typed: boolean }> {
    await this.ensureBrowser()
    const loc = await this.resolveSelector(selector)
    if (clear) await loc.fill('')
    await loc.fill(text, { timeout: OP_TIMEOUT_MS })
    this.touch()
    return { typed: true }
  }

  /** 按键盘键（如 Enter / Escape / Tab） */
  async press(selector: string | null, key: string): Promise<{ pressed: boolean }> {
    await this.ensureBrowser()
    if (selector) {
      const loc = await this.resolveSelector(selector)
      await loc.press(key, { timeout: OP_TIMEOUT_MS })
    } else {
      await this.page.keyboard.press(key)
    }
    await this.page.waitForTimeout(300)
    this._currentUrl = this.page.url()
    this.touch()
    return { pressed: true }
  }

  /** 滚动页面 */
  async scroll(direction: 'up' | 'down' | 'top' | 'bottom', amount: number = 600): Promise<{ scrolled: boolean }> {
    await this.ensureBrowser()
    const deltaY = direction === 'up' ? -amount : direction === 'down' ? amount : direction === 'top' ? -99999 : 99999
    await this.page.evaluate((dy: number) => window.scrollBy(0, dy), deltaY)
    this.touch()
    return { scrolled: true }
  }

  /** 返回上一页 */
  async back(): Promise<{ url: string }> {
    await this.ensureBrowser()
    await this.page.goBack({ timeout: OP_TIMEOUT_MS }).catch(() => {})
    this._currentUrl = this.page.url()
    this._currentTitle = await this.page.title().catch(() => '')
    this.touch()
    return { url: this._currentUrl }
  }

  /** 截图并保存到指定路径（返回文件路径） */
  async screenshot(savePath: string): Promise<{ path: string; ok: boolean }> {
    await this.ensureBrowser()
    await this.page.screenshot({ path: savePath, fullPage: false })
    this.touch()
    return { path: savePath, ok: true }
  }

  /**
   * 执行任意 JavaScript（browser_evaluate 深度开放）
   *
   * #26 操控能力深度开放：允许智能体在当前页面上下文注入任意 JS/DOM 操作。
   * 安全约束（保留底线）：
   *   - 仅限当前已打开页面的 window/document 上下文，不越权访问本地文件系统
   *     （headless 页面天然无本地特权）。
   *   - 授权级别：browser-evaluate 要求 L2（需确认），由工具层 confirm 门拦截，
   *     且每次执行均写入 authorization 操作日志。
   *   - 结果需可 JSON 序列化，避免返回不可序列化对象导致协议异常。
   */
  async evaluate(
    expression: string,
    arg?: unknown,
  ): Promise<{ result: unknown; url: string; title: string }> {
    await this.ensureBrowser()
    let raw: unknown
    if (arg !== undefined) {
      raw = await this.page.evaluate(expression, arg)
    } else {
      raw = await this.page.evaluate(expression)
    }
    // 序列化保护：仅返回可 JSON 化的结果
    let result: unknown = raw
    try {
      JSON.stringify(raw)
    } catch {
      result = String(raw)
    }
    this._currentUrl = this.page.url()
    this._currentTitle = await this.page.title().catch(() => '')
    this.touch()
    return { result, url: this._currentUrl, title: this._currentTitle }
  }
}

/** 全局单例浏览器引擎 */
export const browserMcpEngine = new BrowserMcpEngine()
