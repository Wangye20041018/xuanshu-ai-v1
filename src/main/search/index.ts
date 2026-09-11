﻿import { ipcMain } from 'electron'
import { allEngines } from './engines'
import { scrapeUrl, scrapeUrls } from './scraper'
import { createProxyAgent } from '../utils/proxy-resolver'
import { logger } from '../../shared/logger'
import {SearchResponse, WeatherResponse, ExchangeRateResponse, NewsResponse, NewsItem, ScrapedPage, FunctionTool, SearchContext} from './types'
import { aggregateSearch } from './web-search/search-aggregator'
import { SearchEngine, getEngineById, selectEnginesForQuery } from './web-search/search-engine'
import * as knowledgeGraphModule from '../knowledge-graph'
import * as ragModule from '../rag'
import * as embeddingModule from '../rag/embedding'

/** 创建带超时+代理的 fetch */
function fetchWithTimeout(url: string, options: RequestInit = {}, timeoutMs: number = 10000): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  const signal = options.signal
    ? (() => {
        const combined = new AbortController()
        const origSignal = options.signal as AbortSignal
        origSignal.addEventListener('abort', () => combined.abort())
        controller.signal.addEventListener('abort', () => combined.abort())
        return combined.signal
      })()
    : controller.signal

  // 传入代理 agent
  const agent = createProxyAgent()
  const fetchOptions: RequestInit & { dispatcher?: any } = { ...options, signal }
  if (agent) {
    fetchOptions.dispatcher = agent
  }

  return fetch(url, fetchOptions as RequestInit).finally(() => clearTimeout(timeout))
}

// ========== Function Calling 工具描述 ==========

const SEARCH_TOOLS: FunctionTool[] = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: '搜索互联网获取最新信息。当需要查询实时信息、最新新闻、事实核查、或任何模型知识截止日期之后的信息时使用。返回标题、链接与摘要列表。',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: '搜索关键词，使用简洁明确的关键词组合'
          },
          max_results: {
            type: 'number',
            description: '期望返回的结果数量，默认10'
          },
          count: {
            type: 'number',
            description: '期望返回的结果数量（max_results 的兼容别名），默认10'
          },
          language: {
            type: 'string',
            description: '搜索语言代码，如 zh-CN, en-US',
            enum: ['zh-CN', 'en-US', 'ja-JP']
          }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'fetch_webpage',
      description: '抓取指定网页的完整内容，包括标题、正文和链接。用于深入阅读搜索结果中的页面。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '要抓取的网页 URL' }
        },
        required: ['url']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: '获取指定城市的实时天气信息，包括温度、天气状况、湿度、风速等。',
      parameters: {
        type: 'object',
        properties: { city: { type: 'string', description: '城市名称，如 "北京", "Tokyo", "London"' } },
        required: ['city']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_exchange_rate',
      description: '获取实时汇率信息。',
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'string', description: '源货币代码' },
          to: { type: 'string', description: '目标货币代码' }
        },
        required: ['from', 'to']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_news',
      description: '搜索最新新闻。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '新闻搜索关键词' },
          count: { type: 'number', description: '期望返回的新闻数量，默认5' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_current_time',
      description: '获取当前日期、时间和时区信息。',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  }
]

// ========== InternetSearch 单例 ==========

class InternetSearch {
  private online: boolean = true
  private searchContexts: Map<string, SearchContext> = new Map()

  setOnline(online: boolean): void {
    this.online = online
  }

  getStatus(): { online: boolean; timestamp: number } {
    return { online: this.online, timestamp: Date.now() }
  }

  getTools(): FunctionTool[] {
    return SEARCH_TOOLS
  }

  getSearchContext(query: string): SearchContext | undefined {
    return this.searchContexts.get(query)
  }

  // ========== 多引擎搜索 ==========

  async search(query: string, options: {
    count?: number
    language?: string
    type?: 'web' | 'image' | 'news'
  } = {}): Promise<SearchResponse> {
    if (!this.online) {
      return { results: [], total: 0, provider: 'offline' }
    }

    const count = options.count || 10
    const language = options.language || 'zh-CN'

    for (const engine of allEngines) {
      try {
        const results = await engine.search(query, { count, language })
        if (results.length > 0) {
          return { results, total: results.length, provider: engine.id }
        }
      } catch (e) {
        // 记录引擎名+错误
        logger.warn(`[Search] 引擎 ${engine.id} 失败:`, e)
        continue
      }
    }

    return { results: [], total: 0, provider: 'none' }
  }

  async searchWithRAG(query: string, options: {
    count?: number
    language?: string
    scrapeTopK?: number
  } = {}): Promise<{
    searchResponse: SearchResponse
    scrapedPages: ScrapedPage[]
    knowledgeIds: string[]
  }> {
    const { count = 10, language = 'zh-CN', scrapeTopK = 3 } = options
    // 内层搜索优先复用 web-search 聚合器（httpFriendly 引擎无需 API key），失败再回退多引擎
    let searchResponse: SearchResponse = { results: [], total: 0, provider: 'none' }
    try {
      const engines = selectEnginesForQuery(query).filter((e: SearchEngine) => e.httpFriendly).slice(0, 2)
      if (engines.length > 0) {
        const agg = await aggregateSearch(query, engines, { timeoutPerEngine: 8000, maxResultsPerEngine: count })
        searchResponse = {
          results: agg.results.map((r: { title: string; url: string; snippet: string }) => ({
            title: r.title, url: r.url, snippet: r.snippet,
          })),
          total: agg.uniqueResults,
          provider: 'web-search',
        }
      }
    } catch (e) {
      logger.error('[Search] RAG 内部聚合搜索失败，回退多引擎:', e)
    }
    if (searchResponse.results.length === 0) {
      searchResponse = await this.search(query, { count, language })
    }
    const topUrls = searchResponse.results.slice(0, scrapeTopK).map(r => r.url)
    const scrapedPages = await scrapeUrls(topUrls)
    const validPages = scrapedPages.filter(p => p.text.length > 0)
    const knowledgeIds: string[] = []
    try {
      await this.storeToRAG(query, validPages, knowledgeIds)
    } catch (e) {
      logger.error('RAG store failed:', e)
    }
    const context: SearchContext = {
      query,
      searchResults: searchResponse.results,
      scrapedPages: validPages,
      knowledgeIds,
      timestamp: Date.now()
    }
    this.searchContexts.set(query, context)
    if (this.searchContexts.size > 100) {
      // 找到最旧的条目（按 timestamp 升序），而非依赖 Map 插入顺序
      let oldestKey = ''
      let oldestTime = Infinity
      for (const [k, v] of this.searchContexts) {
        if (v.timestamp < oldestTime) {
          oldestTime = v.timestamp
          oldestKey = k
        }
      }
      if (oldestKey) this.searchContexts.delete(oldestKey)
    }
    return { searchResponse, scrapedPages: validPages, knowledgeIds }
  }

  private async storeToRAG(query: string, pages: ScrapedPage[], knowledgeIds: string[]): Promise<void> {
    let knowledgeGraph: any = null
    let vectorStore: any = null
    let splitText: ((text: string, chunkSize?: number, overlap?: number) => string[]) | null = null
    let getEmbedding: ((text: string) => Promise<{ embedding: number[] }>) | null = null

    try {
      const kg = knowledgeGraphModule
      knowledgeGraph = kg.knowledgeGraph
    } catch (e) { logger.error('[Search] knowledge-graph import failed:', e) }
    try {
      const rag = ragModule
      vectorStore = rag.vectorStore
    } catch (e) { logger.error('[Search] rag import failed:', e) }
    try {
      const emb = embeddingModule
      splitText = emb.splitText
      getEmbedding = emb.getEmbedding
    } catch (e) { logger.error('[Search] rag/embedding import failed:', e) }

    for (const page of pages) {
      if (knowledgeGraph) {
        try {
          const entity = knowledgeGraph.addEntity({
            name: page.title || page.url,
            type: 'concept',
            properties: { url: page.url, source: 'web_search', query },
            aliases: [page.url],
            description: page.text.substring(0, 200),
            confidence: 0.7
          })
          knowledgeIds.push(entity.id)
        } catch (e) { logger.error('[Search] knowledge-graph addEntity failed:', e) }
      }
      if (vectorStore && splitText) {
        try {
          const chunks = splitText(page.text, 500, 50)
          for (const chunk of chunks) {
            let embedding: number[] = []
            if (getEmbedding) {
              try {
                const result = await getEmbedding(chunk)
                embedding = result.embedding
              } catch (e) {
                logger.error('[Search] getEmbedding failed:', e);
                embedding = new Array(384).fill(0).map((_, i) => Math.sin(i * 0.1) * 0.01)
              }
            }
            const id = `search-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
            vectorStore.add(id, chunk, embedding, { type: 'knowledge', tags: ['web_search', query], source: page.url })
            knowledgeIds.push(id)
          }
        } catch (e) { logger.error('[Search] vectorStore add failed:', e) }
      }
    }
  }

  async fetchUrl(url: string): Promise<ScrapedPage> {
    if (!this.online) { return { title: '', url, text: '', links: [] } }
    return await scrapeUrl(url)
  }

  async getWeather(city: string): Promise<WeatherResponse> {
    if (!this.online) { return { temperature: '未知', condition: '未知', city } }
    try {
      const url = `https://wttr.in/${encodeURIComponent(city)}?format=j1`
      const response = await fetchWithTimeout(url)
      if (!response.ok) { return { temperature: '未知', condition: '未知', city } }
      const data = await response.json()
      const current = data.current_condition?.[0]
      return {
        temperature: current?.temp_C ? `${current.temp_C}°C` : '未知',
        condition: current?.weatherDesc?.[0]?.value || '未知',
        city,
        humidity: current?.humidity ? `${current.humidity}%` : undefined,
        windSpeed: current?.windspeedKmph ? `${current.windspeedKmph} km/h` : undefined
      }
    } catch (e) { logger.error('[Search] getWeather failed:', e); return { temperature: '未知', condition: '未知', city } }
  }

  async getExchangeRate(from: string, to: string): Promise<ExchangeRateResponse> {
    if (!this.online) { return { base: from, target: to, rate: 0, timestamp: Date.now() } }
    try {
      const url = `https://api.exchangerate-api.com/v4/latest/${encodeURIComponent(from.toUpperCase())}`
      const response = await fetchWithTimeout(url)
      if (!response.ok) { return { base: from, target: to, rate: 0, timestamp: Date.now() } }
      const data = await response.json()
      return { base: from.toUpperCase(), target: to.toUpperCase(), rate: data.rates?.[to.toUpperCase()] || 0, timestamp: Date.now() }
    } catch (e) { logger.error('[Search] getExchangeRate failed:', e); return { base: from, target: to, rate: 0, timestamp: Date.now() } }
  }

  async getNews(query: string, count: number = 5): Promise<NewsResponse> {
    if (!this.online) { return { articles: [], total: 0 } }
    try {
      const searchResults = await this.search(`${query} 新闻`, { count: Math.min(count * 2, 20), language: 'zh-CN' })
      const articles: NewsItem[] = searchResults.results
        .filter(r => {
          const lower = (r.title + r.snippet).toLowerCase()
          return ['新闻', 'news', '报道', '最新', '今天', '刚刚', '突发'].some(kw => lower.includes(kw))
        })
        .slice(0, count)
        .map(r => {
          let hostname = r.url
          try { hostname = new URL(r.url).hostname } catch (e) { logger.error('[Search] URL parse failed:', e); /* URL 解析失败，使用原始 URL 作为回退 */ }
          return { title: r.title, url: r.url, snippet: r.snippet, source: hostname, publishedAt: new Date().toISOString() }
        })
      if (articles.length < count) {
        const remaining = searchResults.results
          .filter(r => !articles.some(a => a.url === r.url))
          .slice(0, count - articles.length)
          .map(r => {
            let hostname = r.url
            try { hostname = new URL(r.url).hostname } catch (e) { logger.error('[Search] URL parse failed:', e); /* URL 解析失败，使用原始 URL 作为回退 */ }
            return { title: r.title, url: r.url, snippet: r.snippet, source: hostname, publishedAt: new Date().toISOString() }
          })
        articles.push(...remaining)
      }
      return { articles, total: articles.length }
    } catch (e) { logger.error('[Search] getNews failed:', e); return { articles: [], total: 0 } }
  }

  async getCurrentTime(): Promise<{ time: string; date: string; timezone: string; timestamp: number }> {
    const now = new Date()
    return {
      time: now.toLocaleTimeString('zh-CN'),
      date: now.toLocaleDateString('zh-CN'),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      timestamp: now.getTime()
    }
  }
}

export const internetSearch = new InternetSearch()

// ========== IPC Handlers ==========

export function setupSearchHandlers(): void {
  ipcMain.handle('search:query', async (_event, query: string, options?: {
    count?: number; language?: string; type?: 'web' | 'image' | 'news'
  }) => {
    try { return await internetSearch.search(query, options) }
    catch (error) { logger.error('search:query error:', error); return { results: [], total: 0, provider: 'error' } }
  })

  ipcMain.handle('search:time', async () => {
    try { return await internetSearch.getCurrentTime() }
    catch (error) { logger.error('search:time error:', error); return { time: '未知', date: '未知', timezone: '未知', timestamp: 0 } }
  })

  ipcMain.handle('search:weather', async (_event, city: string) => {
    try { return await internetSearch.getWeather(city) }
    catch (error) { logger.error('search:weather error:', error); return { temperature: '未知', condition: '未知', city } }
  })

  ipcMain.handle('search:fetch-url', async (_event, url: string) => {
    try { return await internetSearch.fetchUrl(url) }
    catch (error) { logger.error('search:fetch-url error:', error); return { title: '', url, text: '', links: [] } }
  })

  ipcMain.handle('search:set-online', async (_event, online: boolean) => {
    try { internetSearch.setOnline(online); return { success: true, online } }
    catch (error) { logger.error('search:set-online error:', error); return { success: false, error: String(error) } }
  })

  ipcMain.handle('search:get-status', async () => {
    try { return internetSearch.getStatus() }
    catch (error) { logger.error('search:get-status error:', error); return { online: false, timestamp: Date.now() } }
  })

  ipcMain.handle('search:list-engines', async () => {
    try { return allEngines.map(e => ({ id: e.id, name: e.name })) }
    catch (error) { logger.error('search:list-engines error:', error); return [] }
  })

  ipcMain.handle('search:test-engine', async (_event, engineConfig: { id: string; name: string; baseUrl: string; apiKey?: string }) => {
    try {
      const baseUrl = (engineConfig.baseUrl || 'https://www.bing.com').replace(/\/+$/, '')
      const engine: SearchEngine = {
        id: engineConfig.id || 'custom',
        name: engineConfig.name || engineConfig.id || '自定义引擎',
        region: 'global',
        baseUrl,
        buildSearchUrl: (q: string) => `${baseUrl}/search?q=${encodeURIComponent(q)}`,
        httpFriendly: true,
        weight: 0.5,
        description: '自定义测试引擎',
      }
      const result = await aggregateSearch('test', [engine], { timeoutPerEngine: 8000, maxResultsPerEngine: 5 })
      return { success: true, resultCount: result.uniqueResults || 0, engineName: engine.name }
    } catch (error) {
      logger.error('search:test-engine error:', error)
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('search:get-tools', async () => {
    try { return internetSearch.getTools() }
    catch (error) { logger.error('search:get-tools error:', error); return [] }
  })

  ipcMain.handle('search:exchange-rate', async (_event, from: string, to: string) => {
    try { return await internetSearch.getExchangeRate(from, to) }
    catch (error) { logger.error('search:exchange-rate error:', error); return { base: from, target: to, rate: 0, timestamp: Date.now() } }
  })

  ipcMain.handle('search:news', async (_event, query: string, count?: number) => {
    try { return await internetSearch.getNews(query, count) }
    catch (error) { logger.error('search:news error:', error); return { articles: [], total: 0 } }
  })

  ipcMain.handle('search:rag-search', async (_event, query: string, options?: {
    count?: number; language?: string; scrapeTopK?: number
  }) => {
    try { return await internetSearch.searchWithRAG(query, options) }
    catch (error) { logger.error('search:rag-search error:', error); return { searchResponse: { results: [], total: 0, provider: 'error' }, scrapedPages: [], knowledgeIds: [] } }
  })

  ipcMain.handle('search:get-context', async (_event, query: string) => {
    try { return internetSearch.getSearchContext(query) || null }
    catch (error) { logger.error('search:get-context error:', error); return null }
  })

  // ============ 多引擎联网搜索（WebSearch 模块） ============
  ipcMain.handle('search:web-multi', async (_event, params: { query: string; engines: string[] }) => {
    try {
      const engines = params.engines
        .map((id: string) => getEngineById(id))
        .filter(Boolean) as SearchEngine[]

      if (engines.length === 0) {
        return { results: [], error: '无有效搜索引擎' }
      }

      const result = await aggregateSearch(params.query, engines)
      return result
    } catch (error) {
      logger.error('search:web-multi error:', error)
      return { results: [], error: String(error), uniqueResults: 0 }
    }
  })
}
