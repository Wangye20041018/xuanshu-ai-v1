/** 搜索结果 */
export interface SearchResult {
  title: string
  url: string
  snippet: string
  thumbnail?: string
}

/** 搜索响应 */
export interface SearchResponse {
  results: SearchResult[]
  total: number
  provider: string
}

/** 搜索引擎适配器 */
export interface SearchEngineAdapter {
  id: string
  name: string
  search(query: string, options?: EngineSearchOptions): Promise<SearchResult[]>
}

/** 搜索选项 */
export interface EngineSearchOptions {
  count?: number
  language?: string
  apiKey?: string
}

/** 抓取到的网页内容 */
export interface ScrapedPage {
  title: string
  url: string
  text: string
  links: string[]
  favicon?: string
}

/** Function Calling 工具描述 */
export interface FunctionTool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: {
      type: 'object'
      properties: Record<string, {
        type: string
        description: string
        enum?: string[]
      }>
      required: string[]
    }
  }
}

/** 汇率响应 */
export interface ExchangeRateResponse {
  base: string
  target: string
  rate: number
  timestamp: number
}

/** 天气响应 */
export interface WeatherResponse {
  temperature: string
  condition: string
  city: string
  humidity?: string
  windSpeed?: string
}

/** 新闻条目 */
export interface NewsItem {
  title: string
  url: string
  snippet: string
  source: string
  publishedAt: string
}

/** 新闻响应 */
export interface NewsResponse {
  articles: NewsItem[]
  total: number
}

/** 搜索上下文（RAG 增强） */
export interface SearchContext {
  query: string
  searchResults: SearchResult[]
  scrapedPages: ScrapedPage[]
  knowledgeIds: string[]
  timestamp: number
}