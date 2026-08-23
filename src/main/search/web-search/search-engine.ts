/* ============================================================
 * 搜索引擎池 — search-engine.ts
 *
 * 10 个搜索引擎定义 + 搜索 URL 构建 + User-Agent 轮换池
 * 核心原则：优先本地浏览器，多引擎交叉验证
 * ============================================================ */

export interface SearchEngine {
  id: string
  name: string
  region: 'global' | 'china' | 'academic'
  baseUrl: string
  /** 构建搜索 URL */
  buildSearchUrl: (query: string) => string
  /** 是否支持直接 HTTP 抓取 (部分引擎反爬严格，需走浏览器) */
  httpFriendly: boolean
  /** 权重：用于结果评分 */
  weight: number
  /** 描述 */
  description: string
}

export const SEARCH_ENGINE_POOL: SearchEngine[] = [
  {
    id: 'google',
    name: 'Google',
    region: 'global',
    baseUrl: 'https://www.google.com',
    buildSearchUrl: (q: string) =>
      `https://www.google.com/search?q=${encodeURIComponent(q)}&hl=en`,
    httpFriendly: false,
    weight: 1.0,
    description: '全球最大搜索引擎，结果质量最高',
  },
  {
    id: 'bing',
    name: 'Bing',
    region: 'global',
    baseUrl: 'https://www.bing.com',
    buildSearchUrl: (q: string) =>
      `https://www.bing.com/search?q=${encodeURIComponent(q)}`,
    httpFriendly: true,
    weight: 0.9,
    description: '微软旗下，与GPT集成，英文结果优秀',
  },
  {
    id: 'duckduckgo',
    name: 'DuckDuckGo',
    region: 'global',
    baseUrl: 'https://duckduckgo.com',
    buildSearchUrl: (q: string) =>
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`,
    httpFriendly: true,
    weight: 0.7,
    description: '隐私优先，无个性化偏差',
  },
  {
    id: 'baidu',
    name: '百度',
    region: 'china',
    baseUrl: 'https://www.baidu.com',
    buildSearchUrl: (q: string) =>
      `https://www.baidu.com/s?wd=${encodeURIComponent(q)}`,
    httpFriendly: false,
    weight: 0.8,
    description: '中文搜索最强，中文资料覆盖最全',
  },
  {
    id: 'sogou',
    name: '搜狗',
    region: 'china',
    baseUrl: 'https://www.sogou.com',
    buildSearchUrl: (q: string) =>
      `https://www.sogou.com/web?query=${encodeURIComponent(q)}`,
    httpFriendly: false,
    weight: 0.6,
    description: '微信/知乎内容整合',
  },
  {
    id: '360search',
    name: '360 搜索',
    region: 'china',
    baseUrl: 'https://www.so.com',
    buildSearchUrl: (q: string) =>
      `https://www.so.com/s?q=${encodeURIComponent(q)}`,
    httpFriendly: false,
    weight: 0.55,
    description: '中文综合搜索',
  },
  {
    id: 'metaso',
    name: '秘塔 AI 搜索',
    region: 'china',
    baseUrl: 'https://metaso.cn',
    buildSearchUrl: (q: string) =>
      `https://metaso.cn/?q=${encodeURIComponent(q)}`,
    httpFriendly: false,
    weight: 0.7,
    description: 'AI 增强搜索，总结+来源引用',
  },
  {
    id: 'bing-international',
    name: 'Bing 国际版',
    region: 'global',
    baseUrl: 'https://www.bing.com',
    buildSearchUrl: (q: string) =>
      `https://www.bing.com/search?q=${encodeURIComponent(q)}&cc=us&setlang=en`,
    httpFriendly: true,
    weight: 0.85,
    description: 'Bing 美国区，英文结果更纯',
  },
  {
    id: 'google-scholar',
    name: 'Google Scholar',
    region: 'academic',
    baseUrl: 'https://scholar.google.com',
    buildSearchUrl: (q: string) =>
      `https://scholar.google.com/scholar?q=${encodeURIComponent(q)}`,
    httpFriendly: false,
    weight: 0.9,
    description: '学术论文/引用搜索',
  },
  {
    id: 'perplexity',
    name: 'Perplexity',
    region: 'global',
    baseUrl: 'https://www.perplexity.ai',
    buildSearchUrl: (q: string) =>
      `https://www.perplexity.ai/search?q=${encodeURIComponent(q)}`,
    httpFriendly: false,
    weight: 0.85,
    description: 'AI 驱动搜索，多源整合',
  },
]

/* ---- User-Agent 轮换池 ---- */

const UA_POOL = [
  // Chrome on Windows
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  // Chrome on macOS
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  // Edge on Windows
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
  // Firefox on Windows
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0',
  // Safari on macOS
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  // Brave
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
]

let uaIndex = 0

export function getNextUserAgent(): string {
  const ua = UA_POOL[uaIndex % UA_POOL.length]
  uaIndex++
  return ua
}

export function getEngineById(id: string): SearchEngine | undefined {
  return SEARCH_ENGINE_POOL.find(e => e.id === id)
}

export function getEnginesByRegion(region: 'global' | 'china' | 'academic'): SearchEngine[] {
  return SEARCH_ENGINE_POOL.filter(e => e.region === region)
}

/** 根据查询语言智能选择引擎集合 */
export function selectEnginesForQuery(query: string): SearchEngine[] {
  const hasChinese = /[\u4e00-\u9fff]/.test(query)
  if (hasChinese) {
    // 中文查询：百度+搜狗+360+Google+秘塔+Bing
    return SEARCH_ENGINE_POOL.filter(e =>
      ['baidu', 'sogou', '360search', 'google', 'metaso', 'bing', 'duckduckgo'].includes(e.id),
    )
  }
  // 英文查询：Google+Bing+DuckDuckGo+Perplexity+Bing国际版
  return SEARCH_ENGINE_POOL.filter(e =>
    ['google', 'bing', 'duckduckgo', 'perplexity', 'bing-international', 'google-scholar'].includes(e.id),
  )
}
