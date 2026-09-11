/* ============================================================
 * 浏览器操控搜索 — browser-search.ts
 *
 * 核心原则：优先通过 Playwright 操控本地浏览器实例进行搜索，
 * 捕获真实渲染的搜索结果。Playwright 不可用时回退到 HTTP 直接请求。
 *
 * 职责：
 *   1. 启动/复用本地浏览器实例
 *   2. 打开搜索引擎页面，执行搜索
 *   3. 解析搜索结果 DOM
 *   4. User-Agent 轮换 + 反检测
 * ============================================================ */

import { SearchEngine, getNextUserAgent } from './search-engine'
import { exec } from 'child_process'
import { promisify } from 'util'
import { logger } from '../../../shared/logger'
import { createProxyAgent } from '../../utils/proxy-resolver'

const execAsync = promisify(exec)

/* ---- 类型定义 ---- */

export interface SearchResult {
  title: string
  url: string
  snippet: string
  engine: string
  rank: number
}

export interface BrowserSearchOptions {
  timeout: number
  maxResults: number
}

/* ---- Playwright 检测 ---- */

let playwrightAvailable: boolean | null = null
// v2: playwright 包存在但 chromium 浏览器二进制缺失时，launch 必然失败。
// 失败一次后缓存标记，后续直接走 HTTP 回退，避免每次聚合查询都重复尝试 launch 拖慢主链路。
let playwrightLaunchBroken = false

async function checkPlaywright(): Promise<boolean> {
  if (playwrightLaunchBroken) return false
  if (playwrightAvailable !== null) return playwrightAvailable
  try {
    // 检查 playwright 是否已安装
    await execAsync('npx playwright --version', { timeout: 5000 })
    playwrightAvailable = true
  } catch {
    // 尝试安装
    try {
      logger.debug('[BrowserSearch] Playwright 未安装，正在自动安装...')
      await execAsync('npm install playwright', { timeout: 60000 })
      await execAsync('npx playwright install chromium', { timeout: 120000 })
      playwrightAvailable = true
      logger.debug('[BrowserSearch] Playwright 安装完成')
    } catch (installErr) {
      logger.warn('[BrowserSearch] Playwright 安装失败，回退到 HTTP 模式:', installErr)
      playwrightAvailable = false
    }
  }
  return playwrightAvailable
}

/* ---- 浏览器搜索实现 ---- */

async function searchWithPlaywright(
  engine: SearchEngine,
  query: string,
  options: BrowserSearchOptions,
): Promise<SearchResult[]> {
  // 动态导入 playwright
  let playwright: any
  try {
    playwright = require('playwright')
  } catch {
    try {
      // @ts-ignore TS2307 — playwright may not be installed
      playwright = await import('playwright')
    } catch (importErr) {
      logger.error('[BrowserSearch] 无法加载 playwright 模块:', importErr)
      return []
    }
  }
  const { chromium } = playwright

  // v2: chromium 浏览器二进制缺失时 launch 必然失败。失败一次即缓存标记，
  // 后续所有引擎直接回退 HTTP，拒绝每次聚合都重复等待 launch 失败耗时长链路。
  let browser: any
  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-blink-features=AutomationControlled',
      ],
    })
  } catch (launchErr) {
    playwrightLaunchBroken = true
    playwrightAvailable = false
    logger.warn(
      `[BrowserSearch] chromium.launch 失败（${engine.name}），本次起回退 HTTP 模式:`,
      (launchErr as Error)?.message,
    )
    return []
  }

  const context = await browser.newContext({
    userAgent: getNextUserAgent(),
    viewport: { width: 1920, height: 1080 },
    locale: engine.region === 'china' ? 'zh-CN' : 'en-US',
    // 模拟真实浏览器行为
    extraHTTPHeaders: {
      'Accept-Language': engine.region === 'china' ? 'zh-CN,zh;q=0.9' : 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    },
  })

  const page = await context.newPage()

  // 注入反检测脚本
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false })
    // @ts-ignore
    window.chrome = { runtime: {} }
  })

  try {
    const searchUrl = engine.buildSearchUrl(query)
    await page.goto(searchUrl, {
      waitUntil: 'domcontentloaded',
      timeout: options.timeout,
    })

    // 等待搜索结果加载（不同引擎 DOM 选择器不同）
    await waitForResults(page, engine)

    // 提取搜索结果
    const results = await extractResults(page, engine, options.maxResults)
    return results
  } catch (err) {
    logger.error(`[BrowserSearch] Playwright 搜索 ${engine.name} 失败:`, err)
    return []
  } finally {
    await browser.close()
  }
}

async function waitForResults(page: any, engine: SearchEngine): Promise<void> {
  const selectors: Record<string, string> = {
    google: '#search .g, div[data-sokoban-container]',
    bing: '#b_results .b_algo, .b_result',
    'bing-international': '#b_results .b_algo, .b_result',
    duckduckgo: '.result, .results--main .result',
    baidu: '.result, .c-container',
    sogou: '.results .result, .rb',
    '360search': '.res-list .resitem, .result',
    metaso: '.result-item, .search-result',
  }

  const selector = selectors[engine.id] || '.result, [class*="result"]'
  try {
    await page.waitForSelector(selector, { timeout: 8000 })
  } catch {
    // 超时也继续，可能页面结构不同
  }
}

async function extractResults(
  page: any,
  engine: SearchEngine,
  maxResults: number,
): Promise<SearchResult[]> {
  const extractors: Record<string, string> = {
    google: `() => {
      const items = document.querySelectorAll('#search .g, div[data-sokoban-container]')
      return Array.from(items).slice(0, ${maxResults}).map(el => {
        const link = el.querySelector('a[href^="http"]')
        const title = el.querySelector('h3')
        const snippet = el.querySelector('[data-sncf], .VwiC3b, span')
        return {
          title: title?.textContent?.trim() || '',
          url: link?.href || '',
          snippet: snippet?.textContent?.trim() || '',
        }
      })
    }`,
    bing: `() => {
      const items = document.querySelectorAll('#b_results .b_algo')
      return Array.from(items).slice(0, ${maxResults}).map(el => {
        const link = el.querySelector('a[href^="http"]')
        const title = el.querySelector('h2')
        const snippet = el.querySelector('.b_caption p, .b_lineclamp2')
        return {
          title: title?.textContent?.trim() || '',
          url: link?.href || '',
          snippet: snippet?.textContent?.trim() || '',
        }
      })
    }`,
    duckduckgo: `() => {
      const items = document.querySelectorAll('.result, .results--main .result')
      return Array.from(items).slice(0, ${maxResults}).map(el => {
        const link = el.querySelector('a[href^="http"]')
        const title = el.querySelector('h2, .result__title')
        const snippet = el.querySelector('.result__snippet, .result__body')
        return {
          title: title?.textContent?.trim() || '',
          url: link?.href || '',
          snippet: snippet?.textContent?.trim() || '',
        }
      })
    }`,
    baidu: `() => {
      const items = document.querySelectorAll('.result, .c-container')
      return Array.from(items).slice(0, ${maxResults}).map(el => {
        const link = el.querySelector('a[href^="http"]')
        const title = el.querySelector('h3, .t')
        const snippet = el.querySelector('.c-abstract, .c-span-last')
        return {
          title: title?.textContent?.trim() || '',
          url: link?.href || '',
          snippet: snippet?.textContent?.trim() || '',
        }
      })
    }`,
  }

  // 通用提取器
  const genericExtractor = `() => {
    const items = document.querySelectorAll('.result, [class*="result"], [class*="search-result"], li[class*="item"], article')
    return Array.from(items).slice(0, ${maxResults}).map(el => {
      const link = el.querySelector('a[href^="http"]')
      const title = el.querySelector('h1, h2, h3, [class*="title"]')
      const snippet = el.querySelector('p, [class*="snippet"], [class*="desc"]')
      return {
        title: title?.textContent?.trim() || '',
        url: link?.href || '',
        snippet: snippet?.textContent?.trim() || el.textContent?.trim().substring(0, 200) || '',
      }
    }).filter(r => r.url)
  }`

  const jsExtractor = extractors[engine.id] || genericExtractor

  try {
    const results = await page.evaluate(jsExtractor)
    return (results as any[]).map((r, idx) => ({
      title: r.title,
      url: r.url,
      snippet: r.snippet,
      engine: engine.id,
      rank: idx + 1,
    }))
  } catch (err) {
    logger.error(`[BrowserSearch] 提取 ${engine.name} 结果失败:`, err)
    return []
  }
}

/* ---- HTTP 直连抓取（回退方案） ---- */

async function searchWithHttp(
  engine: SearchEngine,
  query: string,
  options: BrowserSearchOptions,
): Promise<SearchResult[]> {
  // 仅支持 httpFriendly 的引擎
  if (!engine.httpFriendly) return []

  try {
    const searchUrl = engine.buildSearchUrl(query)
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), options.timeout)
    const agent = createProxyAgent()
    const fetchOptions: RequestInit & { dispatcher?: any } = {
      headers: {
        'User-Agent': getNextUserAgent(),
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': engine.region === 'china' ? 'zh-CN,zh;q=0.9' : 'en-US,en;q=0.9',
      },
      signal: controller.signal,
    }
    if (agent) fetchOptions.dispatcher = agent

    const resp = await fetch(searchUrl, fetchOptions as RequestInit)
    clearTimeout(timeoutId)

    if (!resp.ok) return []

    const html = await resp.text()

    // 简单正则提取（回退方案精度较低）
    const results = extractResultsFromHtml(html, engine, options.maxResults)
    return results
  } catch (err) {
    logger.error(`[BrowserSearch] HTTP 搜索 ${engine.name} 失败:`, err)
    return []
  }
}

/** 剥离 HTML 标签，压缩空白 */
function stripHtmlTags(text: string): string {
  return text
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;|&#0183;|&ensp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 通用兜底提取：<a> 链接 + 标题（标题含嵌套标签时跳过，防止脏数据） */
function extractResultsFromHtml(
  html: string,
  engine: SearchEngine,
  maxResults: number,
): SearchResult[] {
  const results: SearchResult[] = []

  // 块级解析优先：按 <li class="b_algo"> 提取 Bing 真实结果
  // Bing 标题常含 <strong> 等嵌套标签，<a> 内层文本正则无法直接取标题，
  // 需先切块再剥标签（含摘要 b_caption）。
  const algoBlockRegex = /<li class="b_algo"[^>]*>([\s\S]*?)<\/li>/gi
  const algoBlocks = [...html.matchAll(algoBlockRegex)]

  if (algoBlocks.length > 0) {
    for (const blockMatch of algoBlocks) {
      if (results.length >= maxResults) break
      const block = blockMatch[1]
      // 优先取 <h2> 内的结果链接（标题）；无 h2 时退化为块内首个外链
      const h2Match = /<h2[^>]*>([\s\S]*?)<\/h2>/i.exec(block)
      const anchorSource = h2Match ? h2Match[1] : block
      const linkMatch = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(anchorSource)
      if (!linkMatch) continue
      const url = linkMatch[1]
      const title = stripHtmlTags(linkMatch[2])
      // 跳过导航/广告/空标题
      if (
        title.length < 3 ||
        url.includes('google.com/search') ||
        url.includes('bing.com/ck/') ||
        url.includes('duckduckgo.com/') ||
        url.includes('ad.') ||
        url.includes('/ads/') ||
        url.includes('bing.com/')
      ) continue
      const captionMatch = /class="b_caption"[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i.exec(block)
      const snippet = captionMatch ? stripHtmlTags(captionMatch[1]) : ''
      results.push({
        title,
        url,
        snippet,
        engine: engine.id,
        rank: results.length + 1,
      })
    }
    if (results.length > 0) return results
  }

  // 通用正则兜底：提取链接 + 标题（仅适用于标题为纯文本的情况）
  const linkRegex = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([^<]+)<\/a>/gi
  const matches = html.matchAll(linkRegex)

  let count = 0
  for (const match of matches) {
    if (count >= maxResults) break
    const url = match[1]
    const title = match[2].replace(/<[^>]+>/g, '').trim()
    // 过滤导航链接、广告链接
    if (
      title.length < 3 ||
      url.includes('google.com/search') ||
      url.includes('bing.com/') ||
      url.includes('duckduckgo.com/') ||
      url.includes('ad.') ||
      url.includes('/ads/')
    ) continue

    results.push({
      title,
      url,
      snippet: '',
      engine: engine.id,
      rank: count + 1,
    })
    count++
  }

  return results
}

/* ============================================================
 * 主搜索入口
 * ============================================================ */

export async function searchViaBrowser(
  engine: SearchEngine,
  query: string,
  options: BrowserSearchOptions,
): Promise<SearchResult[]> {
  // Perplexity 和 Google Scholar 需要特殊处理（模拟用户操作流程）
  if (engine.id === 'perplexity' || engine.id === 'google-scholar' || engine.id === 'metaso') {
    // 这些引擎反爬严格，必须走浏览器
    const hasPW = await checkPlaywright()
    if (!hasPW) {
      logger.warn(`[BrowserSearch] ${engine.name} 需要 Playwright 但不可用，跳过`)
      return []
    }
    return searchWithPlaywright(engine, query, options)
  }

  // 优先尝试 HTTP（轻量引擎）
  if (engine.httpFriendly) {
    const httpResults = await searchWithHttp(engine, query, options)
    if (httpResults.length > 0) return httpResults
  }

  // HTTP 不可用或无结果，回退浏览器
  const hasPW = await checkPlaywright()
  if (hasPW) {
    return searchWithPlaywright(engine, query, options)
  }

  return []
}
