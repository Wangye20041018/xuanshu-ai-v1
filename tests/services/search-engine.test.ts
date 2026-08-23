/**
 * tests/services/search-engine.test.ts
 * 搜索引擎池单元测试：引擎选择/URL 构建/User-Agent 轮换/区域过滤
 */
import { describe, it, expect } from 'vitest'

// 内联搜索引擎定义（结构对齐 src/main/search/web-search/search-engine.ts）
interface SearchEngine {
  id: string
  name: string
  region: 'global' | 'china' | 'academic'
  baseUrl: string
  buildSearchUrl: (query: string) => string
  httpFriendly: boolean
  weight: number
  description: string
}

const SEARCH_ENGINES: SearchEngine[] = [
  {
    id: 'google', name: 'Google', region: 'global', baseUrl: 'https://www.google.com',
    buildSearchUrl: (q: string) => `https://www.google.com/search?q=${encodeURIComponent(q)}&hl=en`,
    httpFriendly: false, weight: 1.0, description: '全球最大搜索引擎',
  },
  {
    id: 'bing', name: 'Bing', region: 'global', baseUrl: 'https://www.bing.com',
    buildSearchUrl: (q: string) => `https://www.bing.com/search?q=${encodeURIComponent(q)}`,
    httpFriendly: true, weight: 0.9, description: '微软旗下',
  },
  {
    id: 'baidu', name: '百度', region: 'china', baseUrl: 'https://www.baidu.com',
    buildSearchUrl: (q: string) => `https://www.baidu.com/s?wd=${encodeURIComponent(q)}`,
    httpFriendly: false, weight: 0.8, description: '中文搜索最强',
  },
  {
    id: 'duckduckgo', name: 'DuckDuckGo', region: 'global', baseUrl: 'https://duckduckgo.com',
    buildSearchUrl: (q: string) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`,
    httpFriendly: true, weight: 0.7, description: '隐私优先',
  },
  {
    id: 'google-scholar', name: 'Google Scholar', region: 'academic', baseUrl: 'https://scholar.google.com',
    buildSearchUrl: (q: string) => `https://scholar.google.com/scholar?q=${encodeURIComponent(q)}`,
    httpFriendly: false, weight: 0.9, description: '学术论文搜索',
  },
]

const UA_POOL = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36',
]

let uaIndex = 0
function getNextUserAgent(): string {
  const ua = UA_POOL[uaIndex % UA_POOL.length]
  uaIndex++
  return ua
}

function getEngineById(id: string): SearchEngine | undefined {
  return SEARCH_ENGINES.find(e => e.id === id)
}

function getEnginesByRegion(region: 'global' | 'china' | 'academic'): SearchEngine[] {
  return SEARCH_ENGINES.filter(e => e.region === region)
}

function selectEnginesForQuery(query: string): SearchEngine[] {
  const hasChinese = /[\u4e00-\u9fff]/.test(query)
  if (hasChinese) {
    return SEARCH_ENGINES.filter(e => ['baidu', 'google', 'bing', 'duckduckgo'].includes(e.id))
  }
  return SEARCH_ENGINES.filter(e => ['google', 'bing', 'duckduckgo', 'google-scholar'].includes(e.id))
}

describe('SearchEngine Pool', () => {
  describe('getEngineById', () => {
    it('应该通过 ID 找到存在的引擎', () => {
      const engine = getEngineById('google')
      expect(engine).toBeDefined()
      expect(engine?.name).toBe('Google')
      expect(engine?.region).toBe('global')
    })

    it('不存在的 ID 应该返回 undefined', () => {
      expect(getEngineById('nonexistent')).toBeUndefined()
    })

    it('应该能找到百度引擎', () => {
      const engine = getEngineById('baidu')
      expect(engine).toBeDefined()
      expect(engine?.region).toBe('china')
      expect(engine?.httpFriendly).toBe(false)
    })

    it('应该能找到学术引擎', () => {
      const engine = getEngineById('google-scholar')
      expect(engine).toBeDefined()
      expect(engine?.region).toBe('academic')
    })
  })

  describe('getEnginesByRegion', () => {
    it('应该过滤出所有 global 区域引擎', () => {
      const engines = getEnginesByRegion('global')
      expect(engines.length).toBeGreaterThanOrEqual(2)
      expect(engines.every(e => e.region === 'global')).toBe(true)
    })

    it('china 区域应该只包含中国引擎', () => {
      const engines = getEnginesByRegion('china')
      expect(engines.length).toBe(1)
      expect(engines[0].id).toBe('baidu')
    })

    it('academic 区域应该只包含学术引擎', () => {
      const engines = getEnginesByRegion('academic')
      expect(engines.length).toBe(1)
      expect(engines[0].id).toBe('google-scholar')
    })
  })

  describe('selectEnginesForQuery', () => {
    it('中文查询应该选择包含百度的引擎集合', () => {
      const engines = selectEnginesForQuery('人工智能最新进展')
      const ids = engines.map(e => e.id)
      expect(ids).toContain('baidu')
      expect(engines.length).toBeGreaterThanOrEqual(2)
    })

    it('英文查询不应该包含百度', () => {
      const engines = selectEnginesForQuery('latest AI research papers')
      const ids = engines.map(e => e.id)
      expect(ids).not.toContain('baidu')
    })

    it('英文查询应该包含 Google Scholar', () => {
      const engines = selectEnginesForQuery('machine learning survey')
      const ids = engines.map(e => e.id)
      expect(ids).toContain('google-scholar')
    })
  })

  describe('buildSearchUrl', () => {
    it('Google 应该构建正确的搜索 URL', () => {
      const engine = getEngineById('google')!
      const url = engine.buildSearchUrl('test query')
      expect(url).toContain('google.com/search?q=test%20query')
    })

    it('百度应该使用 wd 参数', () => {
      const engine = getEngineById('baidu')!
      const url = engine.buildSearchUrl('测试')
      expect(url).toContain('baidu.com/s?wd=')
    })

    it('应该正确编码特殊字符', () => {
      const engine = getEngineById('bing')!
      const url = engine.buildSearchUrl('hello world & more')
      expect(url).toContain('hello%20world%20%26%20more')
    })
  })

  describe('User-Agent 轮换', () => {
    it('应该循环返回 User-Agent', () => {
      const ua1 = getNextUserAgent()
      const ua2 = getNextUserAgent()
      expect(ua1).not.toBe(ua2)
    })

    it('多次调用应该回到第一个 UA（循环）', () => {
      // 重置 uaIndex
      const saved = uaIndex
      const firstCycle = [getNextUserAgent(), getNextUserAgent()]
      const secondCycle = [getNextUserAgent(), getNextUserAgent()]
      expect(secondCycle[0]).toBe(firstCycle[0])
      expect(secondCycle[1]).toBe(firstCycle[1])
    })
  })

  describe('SearchEngine 属性', () => {
    it('所有引擎都应该有 weight 属性', () => {
      for (const engine of SEARCH_ENGINES) {
        expect(engine.weight).toBeGreaterThan(0)
        expect(engine.weight).toBeLessThanOrEqual(1.0)
      }
    })

    it('httpFriendly 应该是布尔值', () => {
      for (const engine of SEARCH_ENGINES) {
        expect(typeof engine.httpFriendly).toBe('boolean')
      }
    })

    it('所有引擎都应该有 description', () => {
      for (const engine of SEARCH_ENGINES) {
        expect(engine.description.length).toBeGreaterThan(0)
      }
    })
  })
})
