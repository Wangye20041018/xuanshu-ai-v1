/* ============================================================
 * 联网搜索模块 — web-search/index.ts
 *
 * 统一导出接口，供 IPC handler 和渲染端调用。
 * ============================================================ */

export { SEARCH_ENGINE_POOL, getEngineById, getEnginesByRegion, selectEnginesForQuery, getNextUserAgent } from './search-engine'
export type { SearchEngine } from './search-engine'

export { aggregateSearch } from './search-aggregator'
export type { UnifiedSearchResult, AggregationResult } from './search-aggregator'

export { searchViaBrowser } from './browser-search'
export type { SearchResult, BrowserSearchOptions } from './browser-search'
