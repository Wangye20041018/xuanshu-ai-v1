/* ============================================================
 * 搜索引擎聚合器 — search-aggregator.ts
 *
 * 职责：
 *   1. 并行发起多引擎查询
 *   2. 收集结果并标准化
 *   3. 去重合并（URL + 标题相似度）
 *   4. 交叉验证排序（多引擎共识加分 + 权威源加分）
 * ============================================================ */

import { SearchEngine } from './search-engine'
import { searchViaBrowser, SearchResult as BrowserSearchResult } from './browser-search'
import { logger } from '../../../shared/logger'

/* ---- 类型定义 ---- */

export interface UnifiedSearchResult {
  title: string
  url: string
  snippet: string
  /** 来源引擎列表 */
  sourceEngines: string[]
  /** 来源数（越多越可信） */
  sourceCount: number
  /** 质量评分 (0-100) */
  qualityScore: number
  /** 权威源标记 */
  isAuthority: boolean
  /** 权威源类型 */
  authorityType?: 'academic' | 'official' | 'encyclopedia' | 'government' | 'opensource'
  /** 原始排名（各引擎中最高排名） */
  bestRank: number
}

export interface AggregationResult {
  query: string
  totalEnginesSearched: number
  totalRawResults: number
  uniqueResults: number
  results: UnifiedSearchResult[]
  searchTimeMs: number
  engineStats: {
    engineId: string
    engineName: string
    resultCount: number
    success: boolean
    error?: string
  }[]
}

/* ---- 质量评分 ---- */

const AUTHORITY_DOMAINS: [RegExp, UnifiedSearchResult['authorityType']][] = [
  [/\.gov(\.|$)/, 'government'],
  [/\.edu(\.|$)/, 'academic'],
  [/wikipedia\.org/, 'encyclopedia'],
  [/github\.com/, 'opensource'],
  [/arxiv\.org/, 'academic'],
  [/scholar\.google/, 'academic'],
  [/semanticscholar\.org/, 'academic'],
  [/acm\.org/, 'academic'],
  [/ieee\.org/, 'academic'],
  [/nature\.com/, 'academic'],
  [/science\.org/, 'academic'],
  [/pypi\.org/, 'opensource'],
  [/npmjs\.com/, 'opensource'],
  [/huggingface\.co/, 'opensource'],
  [/modelscope\.cn/, 'opensource'],
]

function detectAuthority(url: string): { isAuthority: boolean; type?: UnifiedSearchResult['authorityType'] } {
  try {
    const hostname = new URL(url).hostname
    for (const [pattern, type] of AUTHORITY_DOMAINS) {
      if (pattern.test(hostname) || pattern.test(url)) {
        return { isAuthority: true, type }
      }
    }
  } catch {
    // 无效 URL
  }
  return { isAuthority: false }
}

/* ---- 去重合并 ---- */

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url)
    // 去除尾部斜杠、常见追踪参数
    u.searchParams.delete('utm_source')
    u.searchParams.delete('utm_medium')
    u.searchParams.delete('utm_campaign')
    u.searchParams.delete('utm_content')
    u.searchParams.delete('ref')
    u.searchParams.delete('referrer')
    u.hash = ''
    let path = u.pathname.replace(/\/$/, '')
    return `${u.origin}${path}${u.search}`
  } catch {
    return url
  }
}

/** 标题相似度 (简单 Jaccard) */
// @ts-ignore TS6133 - reserved
function titleSimilarity(a: string, b: string): number {
  const tokensA = new Set(a.toLowerCase().split(/\s+/).filter(t => t.length > 1))
  const tokensB = new Set(b.toLowerCase().split(/\s+/).filter(t => t.length > 1))
  if (tokensA.size === 0 || tokensB.size === 0) return 0
  const intersection = new Set([...tokensA].filter(t => tokensB.has(t)))
  const union = new Set([...tokensA, ...tokensB])
  return intersection.size / union.size
}

interface RawEntry {
  title: string
  url: string
  snippet: string
  engine: string
  rank: number
}

function dedupAndMerge(rawResults: RawEntry[]): UnifiedSearchResult[] {
  const groups: Map<string, RawEntry[]> = new Map()
  const normalizedMap: Map<string, string> = new Map()

  for (const entry of rawResults) {
    const norm = normalizeUrl(entry.url)
    // 查找是否有相似 URL（外部搜索引擎数据不可信，畸形 URL 需隔离防护）
    let groupKey = norm
    for (const [existingNorm, existingGroupKey] of normalizedMap) {
      try {
        const existingUrl = new URL(existingNorm)
        const currentUrl = new URL(norm)
        if (existingUrl.origin === currentUrl.origin) {
          const pathMatch = existingUrl.pathname.substring(0, 30) === currentUrl.pathname.substring(0, 30)
          if (pathMatch) {
            groupKey = existingGroupKey
            break
          }
        }
      } catch {
        // 非法 URL（如裸文本/javascript: 等），跳过相似度匹配，按独立条目处理
        break
      }
    }
    normalizedMap.set(norm, groupKey)

    if (!groups.has(groupKey)) groups.set(groupKey, [])
    groups.get(groupKey)!.push(entry)
  }

  const merged: UnifiedSearchResult[] = []

  for (const [_, entries] of groups) {
    // 取最佳标题（最长的非空标题）
    const best = entries.reduce((a, b) =>
      (a.title?.length || 0) > (b.title?.length || 0) ? a : b,
    )

    const engines = [...new Set(entries.map(e => e.engine))]
    const bestRank = Math.min(...entries.map(e => e.rank))

    const { isAuthority, type: authorityType } = detectAuthority(best.url)

    // 质量评分
    let score = 0
    // 多引擎共识 (最多 6 分)
    score += Math.min(engines.length, 6) * 10
    // 权威源 (30 分)
    if (isAuthority) score += 30
    // 排名靠前 (最高 10 分)
    score += Math.max(0, 10 - bestRank)
    // 摘要长度（有实际内容）
    if (best.snippet && best.snippet.length > 50) score += 5

    merged.push({
      title: best.title || 'Untitled',
      url: best.url,
      snippet: best.snippet || '',
      sourceEngines: engines,
      sourceCount: engines.length,
      qualityScore: Math.min(score, 100),
      isAuthority,
      authorityType,
      bestRank,
    })
  }

  // 按质量评分排序
  merged.sort((a, b) => b.qualityScore - a.qualityScore)

  return merged
}

/* ============================================================
 * 主聚合函数
 * ============================================================ */

export async function aggregateSearch(
  query: string,
  engines: SearchEngine[],
  options?: {
    timeoutPerEngine?: number
    maxResultsPerEngine?: number
  },
): Promise<AggregationResult> {
  const timeoutMs = options?.timeoutPerEngine ?? 15000
  const maxResults = options?.maxResultsPerEngine ?? 10
  const startTime = Date.now()

  // 并行发起所有引擎查询
  const enginePromises = engines.map(async (engine) => {
    // @ts-ignore TS6133 - reserved
    const engineStart = Date.now()
    try {
      const results: BrowserSearchResult[] = await searchViaBrowser(engine, query, {
        timeout: timeoutMs,
        maxResults,
      })

      return {
        engineId: engine.id,
        engineName: engine.name,
        resultCount: results.length,
        success: true,
        rawEntries: results.map((r, idx) => ({
          title: r.title,
          url: r.url,
          snippet: r.snippet,
          engine: engine.id,
          rank: idx + 1,
        })),
      }
    } catch (err) {
      logger.error(`[SearchAggregator] ${engine.name} 查询失败:`, err)
      return {
        engineId: engine.id,
        engineName: engine.name,
        resultCount: 0,
        success: false,
        error: String(err),
        rawEntries: [],
      }
    }
  })

  const engineResults = await Promise.all(enginePromises)

  // 合并所有原始结果
  const allRawEntries: RawEntry[] = []
  for (const er of engineResults) {
    allRawEntries.push(...(er.rawEntries || []))
  }

  // 去重合并排序
  const unifiedResults = dedupAndMerge(allRawEntries)

  const elapsed = Date.now() - startTime

  return {
    query,
    totalEnginesSearched: engines.length,
    totalRawResults: allRawEntries.length,
    uniqueResults: unifiedResults.length,
    results: unifiedResults,
    searchTimeMs: elapsed,
    engineStats: engineResults.map(er => ({
      engineId: er.engineId,
      engineName: er.engineName,
      resultCount: er.resultCount,
      success: er.success,
      error: er.error,
    })),
  }
}
