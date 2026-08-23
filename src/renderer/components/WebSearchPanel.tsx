import { useState } from 'react'
import { motion } from 'framer-motion'
import { Search, Loader } from 'lucide-react'
import { HEX_COLORS, COLORS, itemVariants } from '../shared/theme'
import { logger } from '../../shared/logger'

interface WebSearchResult {
  title: string
  url: string
  snippet: string
  sourceEngines: string[]
  sourceCount: number
  qualityScore: number
  isAuthority: boolean
}

/* ============================================================
 * 联网搜索面板组件
 * ============================================================ */
export default function WebSearchPanel() {
  /* ----- 搜索引擎配置 ----- */
  interface EngineConfig {
    apiKey: string
    enabled: boolean
    rateLimit: number    // 每分钟请求限制
    baseUrl: string
    verified: boolean | null   // null=未测试, true=成功, false=失败
  }

  const defaultEngines = [
    { id: 'google', name: 'Google', region: '全球', defaultBaseUrl: 'https://www.googleapis.com/customsearch/v1' },
    { id: 'bing', name: 'Bing', region: '全球', defaultBaseUrl: 'https://api.bing.microsoft.com/v7.0/search' },
    { id: 'baidu', name: '百度', region: '中国', defaultBaseUrl: 'https://api.baidu.com/search' },
  ]

  const moreEngines = [
    { id: 'duckduckgo', name: 'DuckDuckGo', region: '全球', defaultBaseUrl: '' },
    { id: 'sogou', name: '搜狗', region: '中国', defaultBaseUrl: '' },
    { id: '360search', name: '360搜索', region: '中国', defaultBaseUrl: '' },
    { id: 'metaso', name: '秘塔AI', region: '中国', defaultBaseUrl: '' },
    { id: 'bing-international', name: 'Bing国际版', region: '全球', defaultBaseUrl: 'https://api.bing.microsoft.com/v7.0/search' },
    { id: 'google-scholar', name: 'Google学术', region: '学术', defaultBaseUrl: 'https://www.googleapis.com/customsearch/v1' },
    { id: 'perplexity', name: 'Perplexity', region: '全球', defaultBaseUrl: 'https://api.perplexity.ai' },
  ]

  const allEngines = [...defaultEngines, ...moreEngines]

  const [engineConfigs, setEngineConfigs] = useState<Record<string, EngineConfig>>(() => {
    const initial: Record<string, EngineConfig> = {}
    for (const eng of allEngines) {
      initial[eng.id] = { apiKey: '', enabled: false, rateLimit: 10, baseUrl: eng.defaultBaseUrl, verified: null }
    }
    return initial
  })

  const [activeEngineId, setActiveEngineId] = useState<string | null>(null)
  const [showMore, setShowMore] = useState(false)
  const [testingEngine, setTestingEngine] = useState<string | null>(null)

  /* ----- 搜索功能 ----- */
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [results, setResults] = useState<WebSearchResult[]>([])
  const [engineStats, setEngineStats] = useState<{ engineId: string; engineName: string; resultCount: number; success: boolean }[]>([])
  const [searchMsg, setSearchMsg] = useState('')

  const updateEngineConfig = (engineId: string, patch: Partial<EngineConfig>) => {
    setEngineConfigs(prev => ({ ...prev, [engineId]: { ...prev[engineId], ...patch } }))
  }

  const testConnection = async (engineId: string) => {
    setTestingEngine(engineId)
    const cfg = engineConfigs[engineId]
    try {
      if (window.api && cfg.apiKey.trim()) {
        const result = await window.api.invoke('search:test-engine', { engineId, apiKey: cfg.apiKey, baseUrl: cfg.baseUrl })
        updateEngineConfig(engineId, { verified: (result as any)?.success === true })
      } else if (!cfg.apiKey.trim()) {
        updateEngineConfig(engineId, { verified: false })
      } else {
        // 浏览器开发模式：无后端时跳过连接测试，标记为待验证
        updateEngineConfig(engineId, { verified: false })
      }
    } catch {
      updateEngineConfig(engineId, { verified: false })
    }
    setTestingEngine(null)
  }

  const doSearch = async () => {
    if (!query.trim()) return
    const enabledEngines = allEngines.filter(e => engineConfigs[e.id]?.enabled)
    if (enabledEngines.length === 0) {
      setSearchMsg('请至少配置并启用一个搜索引擎')
      return
    }
    setSearching(true)
    setSearchMsg('')
    setResults([])
    try {
      if (window.api) {
        const result = await window.api.invoke('search:web-multi', {
          query,
          engines: enabledEngines.map(e => e.id),
          engineConfigs: enabledEngines.reduce((acc, e) => {
            acc[e.id] = { apiKey: engineConfigs[e.id].apiKey, baseUrl: engineConfigs[e.id].baseUrl }
            return acc
          }, {} as Record<string, any>)
        })
        if ((result as any)?.results) {
          setResults((result as any).results.map((r: any) => ({
            title: r.title, url: r.url, snippet: r.snippet,
            sourceEngines: r.sourceEngines || [], sourceCount: r.sourceCount || 0,
            qualityScore: r.qualityScore || 0, isAuthority: r.isAuthority || false,
          })))
          setEngineStats((result as any).engineStats || [])
          setSearchMsg(`${(result as any).uniqueResults} 个去重结果，${(result as any).totalEnginesSearched} 个引擎参与，耗时 ${(result as any).searchTimeMs}ms`)
        } else {
          setSearchMsg('未获得搜索结果')
        }
      } else {
        setSearchMsg('搜索功能需要后端 API 支持')
      }
    } catch (e) {
      logger.error('[WebSearch] 搜索失败:', e)
      setSearchMsg('搜索失败: ' + String(e))
    }
    setSearching(false)
  }

  const configuredCount = allEngines.filter(e => engineConfigs[e.id]?.enabled).length

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* ===== 搜索引擎配置面板 ===== */}
      <motion.div
        variants={itemVariants}
        style={{
          background: COLORS.cardBg, border: `1px solid ${COLORS.cardBorder}`,
          borderRadius: 'var(--radius-2xl)', padding: '20px 24px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Search size={16} color={COLORS.accent} />
            <h3 style={{ fontSize: 14, fontWeight: 600, color: COLORS.textPrimary, margin: 0 }}>
              搜索引擎配置
            </h3>
          </div>
          <span style={{ fontSize: 12, color: COLORS.textMuted }}>
            已启用 {configuredCount}/{allEngines.length}
          </span>
        </div>

        {/* 默认引擎标签行 */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {defaultEngines.map(eng => {
            const cfg = engineConfigs[eng.id]
            const isActive = activeEngineId === eng.id
            const isConfigured = cfg?.enabled && cfg?.verified === true
            return (
              <motion.button
                key={eng.id}
                whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }}
                onClick={() => setActiveEngineId(isActive ? null : eng.id)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '8px 16px', borderRadius: 12, cursor: 'pointer',
                  fontFamily: 'inherit', fontSize: 13, fontWeight: isActive ? 600 : 500,
                  border: isActive ? `1px solid ${COLORS.accent}` : `1px solid ${COLORS.cardBorder}`,
                  background: isActive ? `${HEX_COLORS.accent}15` : 'rgba(255,255,255,0.02)',
                  color: isActive ? COLORS.accent : COLORS.textSecondary,
                  transition: 'all 0.2s',
                }}
              >
                {/* 状态指示灯 */}
                <span style={{
                  width: 8, height: 8, borderRadius: '50%',
                  background: isConfigured ? COLORS.success : 'rgba(255,255,255,0.15)',
                  boxShadow: isConfigured ? '0 0 6px rgba(16,185,129,0.4)' : 'none',
                  flexShrink: 0,
                }} />
                {eng.name}
                <span style={{ fontSize: 10, color: COLORS.textMuted, fontWeight: 400 }}>
                  {eng.region}
                </span>
              </motion.button>
            )
          })}

          {/* 更多引擎展开按钮 */}
          <motion.button
            whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }}
            onClick={() => setShowMore(!showMore)}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '8px 16px', borderRadius: 12, cursor: 'pointer',
              fontFamily: 'inherit', fontSize: 13, fontWeight: 500,
              border: `1px solid ${COLORS.cardBorder}`,
              background: 'rgba(255,255,255,0.02)',
              color: COLORS.textMuted,
              transition: 'all 0.2s',
            }}
          >
            {showMore ? '收起' : '更多引擎'}
            <span style={{ fontSize: 16, lineHeight: 1 }}>
              {showMore ? '\u2212' : '+'}
            </span>
          </motion.button>
        </div>

        {/* 更多引擎展开区 */}
        {showMore && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            transition={{ duration: 0.25 }}
            style={{ marginTop: 12, display: 'flex', flexWrap: 'wrap', gap: 8, overflow: 'hidden' }}
          >
            {moreEngines.map(eng => {
              const cfg = engineConfigs[eng.id]
              const isActive = activeEngineId === eng.id
              const isConfigured = cfg?.enabled && cfg?.verified === true
              return (
                <motion.button
                  key={eng.id}
                  whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }}
                  onClick={() => setActiveEngineId(isActive ? null : eng.id)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '8px 16px', borderRadius: 12, cursor: 'pointer',
                    fontFamily: 'inherit', fontSize: 13, fontWeight: isActive ? 600 : 500,
                    border: isActive ? `1px solid ${COLORS.accent}` : `1px solid ${COLORS.cardBorder}`,
                    background: isActive ? `${HEX_COLORS.accent}15` : 'rgba(255,255,255,0.02)',
                    color: isActive ? COLORS.accent : COLORS.textSecondary,
                    transition: 'all 0.2s',
                  }}
                >
                  <span style={{
                    width: 8, height: 8, borderRadius: '50%',
                    background: isConfigured ? COLORS.success : 'rgba(255,255,255,0.15)',
                    boxShadow: isConfigured ? '0 0 6px rgba(16,185,129,0.4)' : 'none',
                    flexShrink: 0,
                  }} />
                  {eng.name}
                </motion.button>
              )
            })}
          </motion.div>
        )}
      </motion.div>

      {/* ===== 引擎配置详情面板 ===== */}
      {activeEngineId && (() => {
        const eng = allEngines.find(e => e.id === activeEngineId)!
        const cfg = engineConfigs[activeEngineId]
        return (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2 }}
            style={{
              background: COLORS.cardBg, border: `1px solid ${COLORS.cardBorder}`,
              borderRadius: 'var(--radius-2xl)', padding: '20px 24px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{
                  width: 10, height: 10, borderRadius: '50%',
                  background: (cfg?.enabled && cfg?.verified === true) ? COLORS.success : 'rgba(255,255,255,0.15)',
                  boxShadow: (cfg?.enabled && cfg?.verified === true) ? '0 0 8px rgba(16,185,129,0.4)' : 'none',
                }} />
                <span style={{ fontSize: 15, fontWeight: 600, color: COLORS.textPrimary }}>{eng.name}</span>
                <span style={{ fontSize: 11, color: COLORS.textMuted, padding: '2px 8px', borderRadius: 6, background: 'rgba(255,255,255,0.04)' }}>
                  {eng.region}
                </span>
              </div>
              {/* 启用开关 */}
              <button
                onClick={() => updateEngineConfig(activeEngineId, { enabled: !cfg?.enabled })}
                role="switch"
                aria-checked={!!cfg?.enabled}
                aria-label={cfg?.enabled ? `禁用 ${eng.name}` : `启用 ${eng.name}`}
                style={{
                  position: 'relative', width: 44, height: 24, borderRadius: 9999,
                  cursor: 'pointer', border: 'none',
                  background: cfg?.enabled ? COLORS.success : 'rgba(255,255,255,0.1)',
                  transition: 'background 0.3s',
                }}
              >
                <motion.span
                  animate={{ left: cfg?.enabled ? 24 : 3 }}
                  transition={{ type: 'spring', stiffness: 600, damping: 28 }}
                  style={{
                    position: 'absolute', top: 3, width: 18, height: 18, borderRadius: '50%',
                    background: '#fff', boxShadow: '0 2px 6px rgba(0,0,0,0.35)',
                  }}
                />
              </button>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px 20px' }}>
              {/* API Key */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label style={{ fontSize: 12, color: COLORS.textSecondary }}>API Key</label>
                <div style={{ display: 'flex', gap: 6 }}>
                  <input
                    type="password"
                    value={cfg?.apiKey || ''}
                    onChange={(e) => updateEngineConfig(activeEngineId, { apiKey: e.target.value, verified: null })}
                    placeholder={eng.id === 'duckduckgo' || eng.id === 'sogou' || eng.id === '360search' ? '无需 API Key' : '输入 API Key...'}
                    style={{
                      flex: 1, padding: '10px 14px', borderRadius: 12,
                      background: 'rgba(255,255,255,0.03)', border: `1px solid ${COLORS.cardBorder}`,
                      color: COLORS.textPrimary, fontSize: 13, outline: 'none', fontFamily: 'var(--font-mono)',
                    }}
                    onFocus={(e) => { e.currentTarget.style.borderColor = 'var(--border-focus)' }}
                    onBlur={(e) => { e.currentTarget.style.borderColor = 'var(--border-default)' }}
                  />
                </div>
              </div>

              {/* Base URL */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label style={{ fontSize: 12, color: COLORS.textSecondary }}>Base URL</label>
                <input
                  type="text"
                  value={cfg?.baseUrl || ''}
                  onChange={(e) => updateEngineConfig(activeEngineId, { baseUrl: e.target.value })}
                  placeholder={eng.defaultBaseUrl || '默认无需配置'}
                  style={{
                    padding: '10px 14px', borderRadius: 12,
                    background: 'rgba(255,255,255,0.03)', border: `1px solid ${COLORS.cardBorder}`,
                    color: COLORS.textPrimary, fontSize: 13, outline: 'none', fontFamily: 'var(--font-mono)',
                  }}
                  onFocus={(e) => { e.currentTarget.style.borderColor = 'var(--border-focus)' }}
                  onBlur={(e) => { e.currentTarget.style.borderColor = 'var(--border-default)' }}
                />
              </div>

              {/* 请求限制 */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label style={{ fontSize: 12, color: COLORS.textSecondary }}>每分钟请求限制</label>
                <input
                  type="number"
                  min={1} max={60}
                  value={cfg?.rateLimit || 10}
                  onChange={(e) => updateEngineConfig(activeEngineId, { rateLimit: parseInt(e.target.value) || 10 })}
                  style={{
                    padding: '10px 14px', borderRadius: 12,
                    background: 'rgba(255,255,255,0.03)', border: `1px solid ${COLORS.cardBorder}`,
                    color: COLORS.textPrimary, fontSize: 13, outline: 'none', fontFamily: 'var(--font-mono)',
                  }}
                  onFocus={(e) => { e.currentTarget.style.borderColor = 'var(--border-focus)' }}
                  onBlur={(e) => { e.currentTarget.style.borderColor = 'var(--border-default)' }}
                />
              </div>

              {/* 测试连接按钮 */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, justifyContent: 'flex-end' }}>
                <motion.button
                  whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }}
                  onClick={() => testConnection(activeEngineId)}
                  disabled={testingEngine === activeEngineId}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                    padding: '10px 20px', borderRadius: 12, cursor: testingEngine === activeEngineId ? 'not-allowed' : 'pointer',
                    fontFamily: 'inherit', fontSize: 13, fontWeight: 600,
                    background: testingEngine === activeEngineId ? COLORS.textMuted : COLORS.accent,
                    border: 'none', color: '#1a1a1c',
                    opacity: testingEngine === activeEngineId ? 0.5 : 1,
                  }}
                >
                  {testingEngine === activeEngineId ? (
                    <><Loader size={14} style={{ animation: 'spin 1s linear infinite' }} /> 测试中...</>
                  ) : '测试连接'}
                </motion.button>

                {/* 验证结果 */}
                {cfg?.verified === true && (
                  <span style={{ fontSize: 11, color: COLORS.success, marginTop: 2 }}>连接成功，API 可用</span>
                )}
                {cfg?.verified === false && (
                  <span style={{ fontSize: 11, color: COLORS.danger, marginTop: 2 }}>连接失败，请检查 API Key 和 Base URL</span>
                )}
              </div>
            </div>
          </motion.div>
        )
      })()}

      {/* ===== 分隔线 ===== */}
      <div style={{ borderTop: `1px solid ${COLORS.cardBorder}`, margin: '4px 0' }} />

      {/* ===== 搜索栏 ===== */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <input
          type="text"
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') doSearch() }}
          placeholder="输入搜索关键词..."
          style={{
            flex: 1, padding: '10px 16px', borderRadius: 12,
            border: `1px solid ${COLORS.cardBorder}`, background: COLORS.cardBg,
            color: COLORS.textPrimary, fontSize: 14, outline: 'none',
            fontFamily: 'inherit',
          }}
        />
        <motion.button
          whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }}
          onClick={doSearch}
          disabled={searching}
          style={{
            padding: '10px 24px', borderRadius: 12, cursor: 'pointer', fontFamily: 'inherit',
            background: COLORS.accent, border: 'none', color: '#1a1a1c',
            fontSize: 13, fontWeight: 600, opacity: searching ? 0.5 : 1,
          }}
        >
          {searching ? '搜索中...' : '多引擎搜索'}
        </motion.button>
      </div>

      {/* 引擎统计 */}
      {engineStats.length > 0 && (
        <div style={{
          background: COLORS.cardBg, border: `1px solid ${COLORS.cardBorder}`,
          borderRadius: 12, padding: '14px 16px',
        }}>
          <div style={{ fontSize: 12, color: COLORS.textSecondary, marginBottom: 10, fontWeight: 600 }}>
            各引擎状态
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {engineStats.map(es => (
              <div key={es.engineId} style={{
                padding: '4px 10px', borderRadius: 6, fontSize: 11,
                background: es.success ? 'rgba(16,185,129,0.08)' : 'rgba(212,112,106,0.08)',
                color: es.success ? COLORS.success : COLORS.danger,
                border: `1px solid ${es.success ? 'rgba(16,185,129,0.2)' : 'rgba(212,112,106,0.2)'}`,
              }}>
                {es.engineName} ({es.resultCount})
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 搜索消息 */}
      {searchMsg && (
        <div style={{ fontSize: 13, color: COLORS.textSecondary, padding: '8px 0' }}>
          {searchMsg}
        </div>
      )}

      {/* 搜索结果 */}
      {results.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ fontSize: 11, color: COLORS.textMuted, marginBottom: 6 }}>
            {results.filter(r => r.sourceCount >= 2).length} 条被多个引擎交叉验证
            {results.filter(r => r.isAuthority).length > 0 && `，${results.filter(r => r.isAuthority).length} 条来自权威源`}
          </div>

          {results.map((r) => (
            <a
              key={r.url || `${r.title}-${r.snippet?.slice(0, 24)}`}
              href={r.url}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: 'block', padding: '14px 16px', borderRadius: 12,
                background: 'rgba(255,255,255,0.02)', border: `1px solid ${r.isAuthority ? 'rgba(16,185,129,0.15)' : COLORS.cardBorder}`,
                textDecoration: 'none', color: 'inherit',
                transition: 'all 0.2s',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 500, color: r.isAuthority ? COLORS.success : COLORS.textPrimary, marginBottom: 4 }}>
                    {r.title}
                  </div>
                  {r.snippet && (
                    <div style={{ fontSize: 12, color: COLORS.textSecondary, lineHeight: 1.5, marginBottom: 6 }}>
                      {r.snippet.length > 200 ? r.snippet.substring(0, 200) + '...' : r.snippet}
                    </div>
                  )}
                  <div style={{ fontSize: 11, color: COLORS.textMuted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {r.url}
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                  {r.sourceCount >= 2 && (
                    <span style={{
                      fontSize: 11, padding: '2px 8px', borderRadius: 6,
                      background: 'rgba(59,130,246,0.1)', color: '#3b82f6',
                    }}>
                      {r.sourceCount} 引擎
                    </span>
                  )}
                  <span style={{
                    fontSize: 11, padding: '2px 8px', borderRadius: 6,
                    background: r.qualityScore >= 70 ? 'rgba(16,185,129,0.1)' :
                               r.qualityScore >= 40 ? 'rgba(245,158,11,0.1)' : 'rgba(212,112,106,0.08)',
                    color: r.qualityScore >= 70 ? COLORS.success :
                           r.qualityScore >= 40 ? '#f59e0b' : COLORS.danger,
                  }}>
                    {r.qualityScore}分
                  </span>
                  {r.isAuthority && (
                    <span style={{
                      fontSize: 11, padding: '2px 8px', borderRadius: 6,
                      background: 'rgba(16,185,129,0.12)', color: COLORS.success,
                    }}>
                      权威
                    </span>
                  )}
                </div>
              </div>
            </a>
          ))}
        </div>
      )}

      {/* 说明 */}
      <div style={{
        background: 'rgba(255,255,255,0.02)', border: `1px solid ${COLORS.cardBorder}`,
        borderRadius: 12, padding: '16px',
      }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: COLORS.textPrimary, marginBottom: 8 }}>
          使用说明
        </div>
        <div style={{ fontSize: 12, color: COLORS.textSecondary, lineHeight: 1.6 }}>
          上方标签点击可配置各搜索引擎的 API Key 和请求参数。配置完成后启用开关并测试连接，
          即可在搜索时自动使用已启用的引擎。支持多引擎并行查询，结果自动去重合并和交叉验证排序。
        </div>
      </div>
    </div>
  )
}
