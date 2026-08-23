import { SearchResult, SearchEngineAdapter, EngineSearchOptions } from './types'
import { createProxyAgent } from '../utils/proxy-resolver'

/** 创建带超时的 fetch（10秒），注入系统代理 */
function fetchWithTimeout(url: string, options: RequestInit = {}, timeoutMs: number = 10000): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  const signal = options.signal
    ? (() => {
        const combined = new AbortController()
        options.signal!.addEventListener('abort', () => combined.abort())
        controller.signal.addEventListener('abort', () => combined.abort())
        return combined.signal
      })()
    : controller.signal

  const agent = createProxyAgent()
  const fetchOptions: RequestInit & { dispatcher?: any } = { ...options, signal }
  if (agent) fetchOptions.dispatcher = agent

  return fetch(url, fetchOptions as RequestInit).finally(() => clearTimeout(timeout))
}

/** Bing 搜索引擎 */
export const bingEngine: SearchEngineAdapter = {
  id: 'bing',
  name: 'Bing',
  async search(query: string, options: EngineSearchOptions = {}): Promise<SearchResult[]> {
    const count = options.count || 10
    const language = options.language || 'zh-CN'
    const apiKey = options.apiKey || process.env.BING_API_KEY || ''

    const url = `https://api.bing.microsoft.com/v7.0/search?q=${encodeURIComponent(query)}&count=${count}&mkt=${language}`

    const response = await fetchWithTimeout(url, {
      headers: { 'Ocp-Apim-Subscription-Key': apiKey }
    })

    if (!response.ok) {
      return []
    }

    const data = await response.json()

    const results: SearchResult[] = (data.webPages?.value || []).map((item: any) => ({
      title: item.name || '',
      url: item.url || '',
      snippet: item.snippet || ''
    }))

    return results
  }
}

/** SerpAPI 搜索引擎 */
export const serpapiEngine: SearchEngineAdapter = {
  id: 'serpapi',
  name: 'SerpAPI',
  async search(query: string, options: EngineSearchOptions = {}): Promise<SearchResult[]> {
    const count = options.count || 10
    const language = options.language || 'zh-CN'
    const apiKey = options.apiKey || process.env.SERPAPI_KEY || ''

    const url = `https://serpapi.com/search?q=${encodeURIComponent(query)}&num=${count}&hl=${language}&api_key=${apiKey}`

    const response = await fetchWithTimeout(url)

    if (!response.ok) {
      return []
    }

    const data = await response.json()

    const results: SearchResult[] = (data.organic_results || []).map((item: any) => ({
      title: item.title || '',
      url: item.link || '',
      snippet: item.snippet || ''
    }))

    return results
  }
}

/** Google 搜索引擎（HTML 抓取） */
export const googleEngine: SearchEngineAdapter = {
  id: 'google',
  name: 'Google',
  async search(query: string, options: EngineSearchOptions = {}): Promise<SearchResult[]> {
    const count = Math.min(options.count || 10, 20)
    const language = options.language || 'zh-CN'

    const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&num=${count}&hl=${language}`

    const response = await fetchWithTimeout(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
      }
    })

    if (!response.ok) {
      return []
    }

    const html = await response.text()
    return parseGoogleResults(html)
  }
}

function parseGoogleResults(html: string): SearchResult[] {
  const results: SearchResult[] = []

  // 使用多个正则模式以适应 Google 搜索结果的不同结构
  // 模式1: 标准结果块
  const blockRegex = /<div[^>]*class="[^"]*g[^"]*"[^>]*>[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/gi
  let match: RegExpExecArray | null

  while ((match = blockRegex.exec(html)) !== null && results.length < 10) {
    const block = match[0]
    const titleMatch = /<h3[^>]*>([\s\S]*?)<\/h3>/i.exec(block)
    const urlMatch = /<a[^>]*href="(https?:\/\/[^"]+)"/i.exec(block)
    const snippetMatch = /<span[^>]*>([\s\S]*?)<\/span>/i.exec(block)

    if (titleMatch && urlMatch) {
      const title = titleMatch[1].replace(/<[^>]+>/g, '').trim()
      const url = urlMatch[1]
      const snippet = snippetMatch ? snippetMatch[1].replace(/<[^>]+>/g, '').trim() : ''

      if (title && url && !results.some(r => r.url === url)) {
        results.push({ title, url, snippet })
      }
    }
  }

  // 如果上面没匹配到，尝试更简单的模式
  if (results.length === 0) {
    const simpleRegex = /<h3[^>]*>([^<]*)<\/h3>[\s\S]*?href="(https?:\/\/[^"]+)"/gi
    while ((match = simpleRegex.exec(html)) !== null && results.length < 10) {
      results.push({
        title: match[1].replace(/<[^>]+>/g, '').trim(),
        url: match[2],
        snippet: ''
      })
    }
  }

  return results
}

/** DuckDuckGo 搜索引擎（HTML 抓取） */
export const duckduckgoEngine: SearchEngineAdapter = {
  id: 'duckduckgo',
  name: 'DuckDuckGo',
  async search(query: string, options: EngineSearchOptions = {}): Promise<SearchResult[]> {
    const count = options.count || 10

    const url = `https://html.duckduckgo.com/html?q=${encodeURIComponent(query)}`

    const response = await fetchWithTimeout(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    })

    if (!response.ok) {
      return []
    }

    const html = await response.text()
    return parseDuckDuckGoResults(html, count)
  }
}

function parseDuckDuckGoResults(html: string, count: number): SearchResult[] {
  const results: SearchResult[] = []

  // 模式1: result__a 和 result__snippet
  const regex1 = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi
  let match: RegExpExecArray | null

  while ((match = regex1.exec(html)) !== null && results.length < count) {
    const title = match[2].replace(/<[^>]+>/g, '').trim()
    const url = match[1]
    const snippet = match[3].replace(/<[^>]+>/g, '').trim()

    if (title && url) {
      results.push({ title, url, snippet })
    }
  }

  // 模式2: 更宽松的匹配
  if (results.length === 0) {
    const regex2 = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/gi
    while ((match = regex2.exec(html)) !== null && results.length < count) {
      results.push({
        title: match[2].trim(),
        url: match[1],
        snippet: ''
      })
    }
  }

  return results
}

/** SearXNG 搜索引擎（自托管实例） */
export const searxngEngine: SearchEngineAdapter = {
  id: 'searxng',
  name: 'SearXNG',
  async search(query: string, options: EngineSearchOptions = {}): Promise<SearchResult[]> {
    const count = options.count || 10
    // SearXNG 实例 URL，可通过环境变量配置
    const baseUrl = options.apiKey || process.env.SEARXNG_URL || 'https://searx.be'

    const url = `${baseUrl}/search?q=${encodeURIComponent(query)}&format=json&categories=general&pageno=1`

    const response = await fetchWithTimeout(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    })

    if (!response.ok) {
      return []
    }

    const data = await response.json()

    const results: SearchResult[] = (data.results || [])
      .slice(0, count)
      .map((item: any) => ({
        title: item.title || '',
        url: item.url || '',
        snippet: item.content || item.snippet || ''
      }))

    return results
  }
}

/** 所有搜索引擎列表（按优先级排序） */
export const allEngines: SearchEngineAdapter[] = [
  bingEngine,
  serpapiEngine,
  googleEngine,
  duckduckgoEngine,
  searxngEngine
]