import { useState, useEffect, useMemo, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Search, Zap, X, Sparkles, ArrowLeft, Check, Trash2,
  Loader2, AlertCircle, Upload, Store, Package, Filter,
  Code, Layout, Server, FileSearch, PenTool, BookOpen, BarChart3, PieChart,
  Palette, Target, Container, Shield,
  Smartphone, Gamepad2, Cpu, Database,
  Languages, Clapperboard, GraduationCap,
  Brain, TrendingUp, Map,
  Film, Box,
  Cloud, Activity, Wifi,
  Lock, Coins,
  Scale, Lightbulb,
  GitMerge,
} from 'lucide-react'
import { skillKey } from '../../../shared/config-keys'
import { HEX_COLORS, COLORS, containerVariants, itemVariants } from '../../shared/theme'
import { logger } from '../../../shared/logger'
import ErrorBoundary from '../../components/ErrorBoundary'
import { FocusTrap } from '../../components/a11y'
import { showToast as showGlobalToast } from '../../components/Toast'
import { EmptyState } from '../../components/EmptyState'
import { LoadingSkeleton } from '../../components/LoadingSkeleton'
import { useTranslation } from '../../i18n'
import type { ConfigData } from '../../../shared/ipc-types'
import {
  EXPERTS,
  CATEGORY_LABELS,
  type Expert,
} from '../../../shared/experts'

/* ============================================================
 * 类型定义
 * ============================================================ */
interface SkillState {
  enabled: boolean
}

interface PluginInfo {
  id: string
  name: string
  description: string
  version: string
  icon: string
  enabled: boolean
  createdAt: number
  toolDefinition?: {
    type: 'function'
    function: { name: string; description: string; parameters: Record<string, unknown> }
  }
}

/* ============================================================
 * Lucide 图标映射
 * ============================================================ */
const ICON_MAP: Record<string, any> = {
  Code, Layout, Server, FileSearch, PenTool, BookOpen,
  BarChart3, PieChart, Palette, Target, Container, Shield,
  Smartphone, Gamepad2, Cpu, Database,
  Languages, Clapperboard, GraduationCap,
  Brain, TrendingUp, Map,
  Film, Box,
  Cloud, Activity, Wifi,
  Lock, Coins,
  Scale, Lightbulb,
}

function ExpertIcon({ icon, size = 20 }: { icon: string; size?: number }) {
  const IconComp = ICON_MAP[icon]
  if (!IconComp) return <span style={{ fontSize: size }}>?</span>
  return <IconComp size={size} />
}

/* ============================================================
 * Toggle 开关组件
 * ============================================================ */
function Toggle({ checked, onChange }: { checked: boolean; onChange: () => void }) {
  const w = 38, h = 20, dotSize = 14, dotTop = 3
  return (
    <motion.button
      onClick={onChange}
      whileTap={{ scale: 0.92 }}
      animate={checked ? { boxShadow: `0 0 14px ${HEX_COLORS.accent}40` } : { boxShadow: 'none' }}
      style={{
        width: w, height: h, borderRadius: 9999,
        backgroundColor: checked ? COLORS.accent : 'rgba(255,255,255,0.10)',
        position: 'relative', flexShrink: 0, border: 'none', cursor: 'pointer',
        transition: 'background-color 0.3s ease',
      }}
    >
      <motion.span
        animate={{ left: checked ? w - dotSize - 3 : 3, scale: checked ? 1.05 : 1 }}
        transition={{ type: 'spring', stiffness: 600, damping: 28 }}
        style={{
          position: 'absolute', top: dotTop,
          width: dotSize, height: dotSize, borderRadius: '50%',
          backgroundColor: '#fff', boxShadow: '0 1px 4px rgba(0,0,0,0.3)',
        }}
      />
    </motion.button>
  )
}

/* ============================================================
 * 主组件
 * ============================================================ */
export default function Skills() {
  const { t: _t } = useTranslation()
  const [searchQuery, setSearchQuery] = useState('')
  const [skillStates, setSkillStates] = useState<Record<string, SkillState>>({})
  const [isLoading, setIsLoading] = useState(true)

  /* 插件池状态 */
  const [plugins, setPlugins] = useState<PluginInfo[]>([])
  const [pluginsLoading, setPluginsLoading] = useState(true)
  const [pluginsError, setPluginsError] = useState<string | null>(null)
  const [executingPluginId, setExecutingPluginId] = useState<string | null>(null)
  const [pluginCategoryFilter, setPluginCategoryFilter] = useState('all')

  /* 插件商店模态框 */
  const [showStoreModal, setShowStoreModal] = useState(false)

  /* ========== 加载技能状态 ========== */
  useEffect(() => {
    const load = async () => {
      setIsLoading(true)
      try {
        if (window.api) {
          const states: Record<string, SkillState> = {}
          for (const expert of EXPERTS) {
            const saved = await window.api.invoke<Partial<ConfigData>>('config:get', skillKey(expert.id)).catch(() => null) as any
            states[expert.id] = {
              enabled: saved?.enabled ?? false,
            }
          }
          setSkillStates(states)
        }
      } catch (error) {
        logger.warn('[Plugins] 加载技能状态失败:', error instanceof Error ? error.message : String(error))
        const fallback: Record<string, SkillState> = {}
        for (const expert of EXPERTS) {
          fallback[expert.id] = { enabled: false }
        }
        setSkillStates(fallback)
      } finally {
        setIsLoading(false)
      }
    }
    load()
  }, [])

  /* ========== Toast 辅助函数（委托到全局 Toast，保持 (message, type) 调用序兼容） ========== */
  const showToast = useCallback((message: string, type: 'success' | 'error' | 'info' = 'info') => {
    showGlobalToast(type, message)
  }, [])

  /* ========== 加载插件池 ========== */
  const loadPlugins = useCallback(async () => {
    setPluginsLoading(true)
    setPluginsError(null)
    try {
      if (!window.api) {
        // 浏览器 dev server 模式，无 Electron IPC
        setPlugins([])
        return
      }
      const list = await window.api.invoke<PluginInfo[]>('plugin:list')
      setPlugins(Array.isArray(list) ? list : [])
    } catch (error) {
      logger.error('Failed to load plugins:', error)
      setPluginsError('插件列表加载失败')
    } finally {
      setPluginsLoading(false)
    }
  }, [])

  useEffect(() => {
    loadPlugins()
  }, [loadPlugins])

  /* ========== 切换专家启用状态 ========== */
  const toggleSkill = useCallback(async (expertId: string) => {
    const current = skillStates[expertId]
    if (!current) return
    const newEnabled = !current.enabled
    setSkillStates(prev => ({ ...prev, [expertId]: { enabled: newEnabled } }))
    try {
      if (window.api) {
        await window.api.invoke('config:set', skillKey(expertId), { enabled: newEnabled })
        await window.api.invoke('plugin:toggle', expertId).catch((e) => {
          logger.error('[Plugins] 切换插件失败:', e)
        })
      }
    } catch (error) {
      logger.error('Failed to toggle expert:', error)
    }
  }, [skillStates])

  /* ========== 点击专家卡片执行 ========== */
  const executeSkill = useCallback(async (expertId: string) => {
    setExecutingPluginId(expertId)
    try {
      if (!window.api) {
        showToast('请在 Electron 环境中运行此功能', 'error')
        return
      }
      const result = await window.api.invoke<{ success: boolean; data?: unknown; error?: string }>(
        'plugin:execute', expertId, { action: 'run' }
      )
      const name = EXPERTS.find(e => e.id === expertId)?.name || expertId
      if (result?.success) {
        showToast(`「${name}」执行成功`, 'success')
      } else {
        showToast(result?.error || '执行失败', 'error')
      }
    } catch (error) {
      logger.error('Failed to execute expert:', error)
      showToast('执行异常，请稍后重试', 'error')
    } finally {
      setExecutingPluginId(null)
    }
  }, [showToast])

  /* ========== 切换插件池插件状态 ========== */
  const togglePoolPlugin = useCallback(async (pluginId: string) => {
    setPlugins(prev => prev.map(p =>
      p.id === pluginId ? { ...p, enabled: !p.enabled } : p
    ))
    try {
      if (!window.api) {
        showToast('请在 Electron 环境中运行此功能', 'error')
        return
      }
      const result = await window.api.invoke<{ success: boolean; error?: string }>('plugin:toggle', pluginId)
      if (!result?.success) {
        setPlugins(prev => prev.map(p =>
          p.id === pluginId ? { ...p, enabled: !p.enabled } : p
        ))
        showToast('插件状态切换失败', 'error')
      }
    } catch (error) {
      logger.error('Failed to toggle pool plugin:', error)
      setPlugins(prev => prev.map(p =>
        p.id === pluginId ? { ...p, enabled: !p.enabled } : p
      ))
      showToast('插件状态切换异常', 'error')
    }
  }, [showToast])

  /* ========== 卸载插件池插件 ========== */
  const unregisterPoolPlugin = useCallback(async (pluginId: string) => {
    const plugin = plugins.find(p => p.id === pluginId)
    if (!plugin) return
    try {
      if (!window.api) {
        showToast('请在 Electron 环境中运行此功能', 'error')
        return
      }
      const result = await window.api.invoke<{ success: boolean; error?: string }>('plugin:unregister', pluginId)
      if (result?.success) {
        setPlugins(prev => prev.filter(p => p.id !== pluginId))
        showToast(`已卸载「${plugin.name}」`, 'success')
      } else {
        showToast(result?.error || '卸载失败', 'error')
      }
    } catch (error) {
      logger.error('Failed to unregister plugin:', error)
      showToast('卸载异常，请稍后重试', 'error')
    }
  }, [plugins, showToast])

  /* ========== 从本地安装插件 ========== */
  const installLocalPlugin = useCallback(async () => {
    try {
      if (!window.api) {
        showToast('请在 Electron 环境中运行此功能', 'error')
        return
      }
      const result = await window.api.invoke<{ filePaths: string[] }>('dialog:open', {
        filters: [{ name: '插件文件', extensions: ['plugin', 'zip'] }],
        properties: ['openFile'],
      })
      if (result?.filePaths?.length) {
        const installResult = await window.api.invoke<{ success: boolean; error?: string }>(
          'plugin:install', result.filePaths[0]
        )
        if (installResult?.success) {
          showToast('插件安装成功', 'success')
          loadPlugins()
        } else {
          showToast(installResult?.error || '安装失败', 'error')
        }
      }
    } catch (error) {
      logger.error('Failed to install plugin:', error)
      showToast('安装异常', 'error')
    }
  }, [showToast, loadPlugins])

  /* ========== 打开插件商店 ========== */
  const openPluginStore = useCallback(async () => {
    if (!window?.api) {
      setShowStoreModal(true)
      return
    }
    try {
      const result = await window.api.invoke<{ success?: boolean; data?: unknown; error?: string; storeUnavailable?: boolean }>('plugin:store-list')
      if (result?.storeUnavailable) {
        showToast('插件商店未开通', 'info')
        setShowStoreModal(true)
      } else if (result?.success) {
        showToast('插件商店数据已获取', 'success')
      } else {
        setShowStoreModal(true)
      }
    } catch (error) {
      logger.error('Failed to open plugin store:', error)
      setShowStoreModal(true)
    }
  }, [showToast])

  /* ========== 计算统计数据 ========== */
  const stats = useMemo(() => {
    const total = EXPERTS.length
    const active = EXPERTS.filter(e => skillStates[e.id]?.enabled).length
    // 可用组合：已启用专家数（每个专家已是完整配套）
    const combos = active
    return { total, active, combos }
  }, [skillStates])

  /* ========== 搜索过滤 ========== */
  const filteredExperts = useMemo(() => {
    if (!searchQuery.trim()) return EXPERTS
    const q = searchQuery.toLowerCase()
    return EXPERTS.filter(e =>
      e.name.toLowerCase().includes(q) ||
      e.description.toLowerCase().includes(q) ||
      e.coder.name.toLowerCase().includes(q) ||
      CATEGORY_LABELS[e.category].includes(q)
    )
  }, [searchQuery])

  /* ========== 按分类分组 ========== */
  const categories = useMemo(() => {
    const map: Record<string, Expert[]> = {}
    for (const expert of filteredExperts) {
      const key = expert.category
      if (!map[key]) map[key] = []
      map[key].push(expert)
    }
    return map
  }, [filteredExperts])

  /* ========== 插件分类过滤 ========== */
  const filteredPlugins = useMemo(() => {
    if (pluginCategoryFilter === 'all') return plugins
    return plugins.filter(p => {
      if (pluginCategoryFilter === 'system') return p.id.startsWith('system-') || p.id.startsWith('file-')
      if (pluginCategoryFilter === 'tool') return p.id.startsWith('code-') || p.id.startsWith('web-') || p.id.startsWith('image-')
      if (pluginCategoryFilter === 'content') return p.id.startsWith('translator') || p.id.startsWith('note-') || p.id.startsWith('scheduler')
      return !(p.id.startsWith('system-') || p.id.startsWith('file-') || p.id.startsWith('code-') || p.id.startsWith('web-') || p.id.startsWith('image-') || p.id.startsWith('translator') || p.id.startsWith('note-') || p.id.startsWith('scheduler'))
    })
  }, [plugins, pluginCategoryFilter])

  if (isLoading) {
    return (
      <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <LoadingSkeleton variant="list" lines={6} loadingText="加载专家团" />
      </div>
    )
  }

  return (
    <ErrorBoundary>
    <motion.div
      variants={containerVariants}
      initial="hidden"
      animate="visible"
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: COLORS.bg,
        overflow: 'hidden',
        position: 'relative',
      }}
    >
      {/* ==================== 页面标题栏 ==================== */}
      <motion.div
        variants={itemVariants}
        style={{
          padding: '16px 24px',
          borderBottom: `1px solid ${COLORS.cardBorder}`,
          display: 'flex', alignItems: 'center', gap: 14, flexShrink: 0,
        }}
      >
        <motion.button
          whileHover={{ scale: 1.08 }}
          whileTap={{ scale: 0.92 }}
          onClick={() => window.history.back()}
          style={{
            width: 34, height: 34, borderRadius: 10,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'rgba(255,255,255,0.04)',
            border: `1px solid ${COLORS.cardBorder}`,
            color: COLORS.textSecondary, cursor: 'pointer',
          }}
        >
          <ArrowLeft size={16} />
        </motion.button>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Sparkles size={18} style={{ color: COLORS.accent }} />
          <h2 style={{ fontSize: 17, fontWeight: 600, color: COLORS.textPrimary, margin: 0 }}>
            专家团
          </h2>
        </div>
      </motion.div>

      {/* ==================== 内容滚动区 ==================== */}
      <div style={{ flex: 1, overflow: 'auto', padding: '20px 24px' }}>
        <div style={{ maxWidth: 1100, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 20 }}>

          {/* ===== 顶部统计卡片 ===== */}
          <motion.div
            variants={itemVariants}
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(3, 1fr)',
              gap: 12,
            }}
          >
            {[
              { label: '专家总数', value: stats.total, icon: <Zap size={16} />, color: COLORS.accent },
              { label: '已启用', value: stats.active, icon: <Check size={16} />, color: COLORS.success },
              { label: '可用组合', value: stats.combos, icon: <GitMerge size={16} />, color: COLORS.accent2 },
            ].map(item => (
              <motion.div
                key={item.label}
                whileHover={{ y: -2, borderColor: COLORS.cardBorderHover }}
                style={{
                  padding: '18px 20px',
                  borderRadius: 'var(--radius-2xl)',
                  background: COLORS.cardBg,
                  border: `1px solid ${COLORS.cardBorder}`,
                  display: 'flex', alignItems: 'center', gap: 14,
                  transition: 'all 0.3s ease',
                }}
              >
                <div style={{
                  width: 40, height: 40, borderRadius: 12,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: `${item.color}15`, color: item.color,
                }}>
                  {item.icon}
                </div>
                <div>
                  <div style={{ fontSize: 13, color: COLORS.textMuted }}>{item.label}</div>
                  <div style={{ fontSize: 22, fontWeight: 700, color: COLORS.textPrimary, lineHeight: 1.2 }}>
                    {item.value}
                  </div>
                </div>
              </motion.div>
            ))}
          </motion.div>

          {/* ===== 搜索框 ===== */}
          <motion.div variants={itemVariants}>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '10px 16px',
              borderRadius: 'var(--radius-lg)',
              background: COLORS.cardBg,
              border: `1px solid ${COLORS.cardBorder}`,
              transition: 'border-color 0.3s ease',
            }}>
              <Search size={16} style={{ color: COLORS.textMuted, flexShrink: 0 }} />
              <input
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder="搜索专家、编码器或领域..."
                style={{
                  flex: 1, background: 'none', border: 'none', outline: 'none',
                  fontSize: 14, color: COLORS.textPrimary, fontFamily: 'inherit',
                }}
              />
              {searchQuery && (
                <motion.button
                  initial={{ opacity: 0, scale: 0.8 }}
                  animate={{ opacity: 1, scale: 1 }}
                  onClick={() => setSearchQuery('')}
                  style={{
                    background: 'none', border: 'none', cursor: 'pointer',
                    color: COLORS.textMuted, padding: 2,
                  }}
                >
                  <X size={14} />
                </motion.button>
              )}
            </div>
          </motion.div>

          {/* ===== 专家卡片网格（按分类分组） ===== */}
          {Object.entries(categories).map(([categoryKey, experts]) => (
            <motion.div key={categoryKey} variants={itemVariants}>
              {/* 分类标题 */}
              <div style={{
                display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14,
              }}>
                <div style={{
                  width: 6, height: 20, borderRadius: 3,
                  background: COLORS.accent,
                }} />
                <span style={{
                  fontSize: 14, fontWeight: 600, color: COLORS.textSecondary,
                  textTransform: 'uppercase', letterSpacing: '0.05em',
                }}>
                  {CATEGORY_LABELS[categoryKey as Expert['category']] || categoryKey}
                </span>
                <span style={{ fontSize: 12, color: COLORS.textMuted }}>
                  {experts.length} 位专家
                </span>
              </div>

              {/* 卡片网格 */}
              <motion.div
                variants={containerVariants}
                initial="hidden"
                animate="visible"
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
                  gap: 24,
                }}
              >
                {experts.map(expert => {
                  const state = skillStates[expert.id]
                  const enabled = state?.enabled ?? false
                  const isExecuting = executingPluginId === expert.id
                  return (
                    <motion.div
                      key={expert.id}
                      variants={itemVariants}
                      layout
                      whileHover={{ y: -3, borderColor: enabled ? `${HEX_COLORS.accent}50` : COLORS.cardBorderHover }}
                      onClick={() => { if (!isExecuting) executeSkill(expert.id) }}
                      style={{
                        padding: 20,
                        borderRadius: 'var(--radius-2xl)',
                        background: COLORS.cardBg,
                        border: `1px solid ${enabled ? `${HEX_COLORS.accent}40` : COLORS.cardBorder}`,
                        transition: 'all 0.3s ease',
                        position: 'relative',
                        cursor: isExecuting ? 'wait' : 'pointer',
                        opacity: isExecuting ? 0.7 : 1,
                      }}
                    >
                      {/* 执行中动画 */}
                      {isExecuting && (
                        <motion.div
                          animate={{ rotate: 360 }}
                          transition={{ repeat: Infinity, duration: 1, ease: 'linear' }}
                          style={{
                            position: 'absolute', top: 14, right: 14,
                            width: 18, height: 18, color: COLORS.accent,
                          }}
                        >
                          <Loader2 size={18} />
                        </motion.div>
                      )}

                      {/* 头部：图标 + 开关 */}
                      <div style={{
                        display: 'flex', alignItems: 'flex-start',
                        justifyContent: 'space-between', marginBottom: 14,
                      }}>
                        <div style={{
                          width: 44, height: 44, borderRadius: 12,
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          background: enabled ? `${HEX_COLORS.accent}15` : 'rgba(255,255,255,0.04)',
                          color: enabled ? COLORS.accent : COLORS.textSecondary,
                          transition: 'all 0.3s ease',
                        }}>
                          <ExpertIcon icon={expert.icon} size={22} />
                        </div>
                        <Toggle checked={enabled} onChange={() => toggleSkill(expert.id)} />
                      </div>

                      {/* 名称 + 分类标签 */}
                      <div style={{
                        display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6,
                      }}>
                        <span style={{
                          fontSize: 15, fontWeight: 600, color: COLORS.textPrimary,
                        }}>
                          {expert.name}
                        </span>
                        <span style={{
                          padding: '2px 8px', borderRadius: 6,
                          fontSize: 10, fontWeight: 500,
                          background: `${HEX_COLORS.accent}12`,
                          color: COLORS.accent,
                          border: `1px solid ${HEX_COLORS.accent}20`,
                          whiteSpace: 'nowrap',
                        }}>
                          {CATEGORY_LABELS[expert.category]}
                        </span>
                      </div>

                      {/* 描述 */}
                      <div style={{
                        fontSize: 13, color: COLORS.textMuted,
                        lineHeight: 1.55, marginBottom: 12,
                      }}>
                        {expert.description}
                      </div>

                      {/* 配套编码器 */}
                      <div style={{
                        padding: '10px 14px',
                        borderRadius: 10,
                        background: 'rgba(255,255,255,0.02)',
                        border: `1px solid ${COLORS.cardBorder}`,
                      }}>
                        <div style={{
                          fontSize: 10, fontWeight: 600, color: COLORS.textMuted,
                          textTransform: 'uppercase', letterSpacing: '0.05em',
                          marginBottom: 4,
                        }}>
                          配套编码器
                        </div>
                        <div style={{
                          fontSize: 13, fontWeight: 500, color: COLORS.textSecondary,
                        }}>
                          {expert.coder.name}
                        </div>
                        <div style={{
                          fontSize: 11, color: COLORS.textMuted,
                          lineHeight: 1.45, marginTop: 3,
                          display: '-webkit-box',
                          WebkitLineClamp: 2,
                          WebkitBoxOrient: 'vertical',
                          overflow: 'hidden',
                        }}>
                          {expert.coder.systemPrompt}
                        </div>
                      </div>
                    </motion.div>
                  )
                })}
              </motion.div>
            </motion.div>
          ))}

          {/* 空结果 */}
          {Object.keys(categories).length === 0 && searchQuery && (
            <motion.div
              variants={itemVariants}
              style={{
                textAlign: 'center', padding: 48,
                color: COLORS.textMuted, fontSize: 14,
              }}
            >
              没有找到包含「{searchQuery}」的专家
            </motion.div>
          )}

          {/* ===== 插件池 ===== */}
          <motion.div
            variants={itemVariants}
            style={{
              padding: '24px',
              borderRadius: 'var(--radius-2xl)',
              background: COLORS.cardBg,
              border: `1px solid ${COLORS.cardBorder}`,
            }}
          >
            {/* 头部：标题 + 操作区 */}
            <div style={{
              display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 12,
              marginBottom: 18,
            }}>
              <div style={{
                width: 34, height: 34, borderRadius: 10,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: `${HEX_COLORS.accent}15`, color: COLORS.accent,
              }}>
                <Package size={16} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 16, fontWeight: 600, color: COLORS.textPrimary }}>
                  插件池
                </div>
                <div style={{ fontSize: 13, color: COLORS.textMuted, marginTop: 2 }}>
                  已安装的功能插件
                </div>
              </div>
              {!pluginsLoading && !pluginsError && (
                <span style={{ fontSize: 12, color: COLORS.textMuted }}>
                  {plugins.filter(p => p.enabled).length}/{plugins.length} 已启用
                </span>
              )}
            </div>

            {/* 操作按钮栏 */}
            <div style={{
              display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18, flexWrap: 'wrap',
            }}>
              <motion.button
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.96 }}
                onClick={installLocalPlugin}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '8px 16px', borderRadius: 10,
                  background: `${HEX_COLORS.accent}12`, border: `1px solid ${HEX_COLORS.accent}25`,
                  color: COLORS.accent, fontSize: 13, fontWeight: 500,
                  cursor: 'pointer', fontFamily: 'inherit',
                }}
              >
                <Upload size={14} />
                从本地安装
              </motion.button>
              <motion.button
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.96 }}
                onClick={openPluginStore}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '8px 16px', borderRadius: 10,
                  background: 'rgba(255,255,255,0.04)', border: `1px solid ${COLORS.cardBorder}`,
                  color: COLORS.textSecondary, fontSize: 13, fontWeight: 500,
                  cursor: 'pointer', fontFamily: 'inherit',
                }}
              >
                <Store size={14} />
                插件商店
              </motion.button>

              {/* 分类过滤 */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
                <Filter size={14} style={{ color: COLORS.textMuted }} />
                {[
                  { key: 'all', label: '全部' },
                  { key: 'system', label: '系统' },
                  { key: 'tool', label: '工具' },
                  { key: 'content', label: '内容' },
                  { key: 'custom', label: '自定义' },
                ].map(cat => (
                  <motion.button
                    key={cat.key}
                    whileHover={{ scale: 1.04 }}
                    whileTap={{ scale: 0.94 }}
                    onClick={() => setPluginCategoryFilter(cat.key)}
                    style={{
                      padding: '5px 12px', borderRadius: 8,
                      border: 'none',
                      background: pluginCategoryFilter === cat.key ? `${HEX_COLORS.accent}18` : 'transparent',
                      color: pluginCategoryFilter === cat.key ? COLORS.accent : COLORS.textMuted,
                      fontSize: 12, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit',
                      transition: 'all 0.2s ease',
                    }}
                  >
                    {cat.label}
                  </motion.button>
                ))}
              </div>
            </div>

            {/* 加载状态 */}
            {pluginsLoading && (
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
                padding: 40, color: COLORS.textMuted, fontSize: 13,
              }}>
                <motion.span
                  animate={{ rotate: 360 }}
                  transition={{ repeat: Infinity, duration: 1, ease: 'linear' }}
                  style={{ display: 'flex' }}
                >
                  <Loader2 size={18} />
                </motion.span>
                正在加载插件列表...
              </div>
            )}

            {/* 错误状态 */}
            {!pluginsLoading && pluginsError && (
              <div style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '12px 16px', borderRadius: 12,
                background: 'rgba(239,68,68,0.08)', color: '#ef4444', fontSize: 13,
              }}>
                <AlertCircle size={16} />
                <span>{pluginsError}</span>
                <motion.button
                  whileHover={{ scale: 1.05 }}
                  whileTap={{ scale: 0.95 }}
                  onClick={loadPlugins}
                  style={{
                    marginLeft: 'auto', padding: '4px 12px', borderRadius: 8,
                    border: '1px solid rgba(239,68,68,0.3)', background: 'transparent',
                    color: '#ef4444', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit',
                  }}
                >
                  重试
                </motion.button>
              </div>
            )}

            {/* 空状态 */}
            {!pluginsLoading && !pluginsError && filteredPlugins.length === 0 && (
              <EmptyState
                title={pluginCategoryFilter === 'all' ? '暂无已安装的插件' : '该分类下暂无插件'}
                description="可通过「从本地安装」按钮添加自定义插件"
              />
            )}

            {/* 插件卡片网格 */}
            {!pluginsLoading && !pluginsError && filteredPlugins.length > 0 && (
              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
                gap: 16,
              }}>
                {filteredPlugins.map(plugin => (
                  <motion.div
                    key={plugin.id}
                    whileHover={{ y: -3, borderColor: plugin.enabled ? `${HEX_COLORS.accent}50` : COLORS.cardBorderHover }}
                    style={{
                      padding: 18,
                      borderRadius: 16,
                      background: COLORS.bg,
                      border: `1px solid ${plugin.enabled ? `${HEX_COLORS.accent}25` : COLORS.cardBorder}`,
                      transition: 'all 0.3s ease',
                      position: 'relative',
                    }}
                  >
                    {/* 头部：名称 + 开关 */}
                    <div style={{
                      display: 'flex', alignItems: 'flex-start',
                      justifyContent: 'space-between', marginBottom: 10,
                    }}>
                      <div>
                        <div style={{
                          fontSize: 14, fontWeight: 600, color: COLORS.textPrimary,
                          marginBottom: 3,
                        }}>
                          {plugin.name}
                        </div>
                        <span style={{
                          fontSize: 11, color: COLORS.textMuted,
                          padding: '2px 8px', borderRadius: 6,
                          background: 'rgba(255,255,255,0.03)',
                          border: `1px solid ${COLORS.cardBorder}`,
                        }}>
                          v{plugin.version || '1.0.0'}
                        </span>
                      </div>
                      <Toggle
                        checked={plugin.enabled}
                        onChange={() => togglePoolPlugin(plugin.id)}
                      />
                    </div>

                    {/* 描述 */}
                    <div style={{
                      fontSize: 12, color: COLORS.textMuted,
                      lineHeight: 1.55, marginBottom: 12,
                    }}>
                      {plugin.description || '暂无描述'}
                    </div>

                    {/* 底部：作者 + 卸载 */}
                    <div style={{
                      display: 'flex', alignItems: 'center',
                      justifyContent: 'space-between',
                    }}>
                      <span style={{ fontSize: 11, color: COLORS.textMuted }}>
                        {(plugin as any).author ? `作者: ${(plugin as any).author}` : ''}
                      </span>
                      <motion.button
                        whileHover={{ scale: 1.08, color: '#ef4444' }}
                        whileTap={{ scale: 0.9 }}
                        onClick={() => unregisterPoolPlugin(plugin.id)}
                        aria-label={`卸载插件: ${plugin.name}`}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 4,
                          padding: '4px 10px', borderRadius: 8,
                          border: `1px solid ${COLORS.cardBorder}`,
                          background: 'transparent',
                          color: COLORS.textMuted, fontSize: 11,
                          cursor: 'pointer', fontFamily: 'inherit',
                        }}
                      >
                        <Trash2 size={12} />
                        卸载
                      </motion.button>
                    </div>
                  </motion.div>
                ))}
              </div>
            )}
          </motion.div>
        </div>
      </div>

      {/* ==================== 插件商店模态框 ==================== */}
      <AnimatePresence>
        {showStoreModal && (
          <FocusTrap active={!!showStoreModal}>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            style={{
              position: 'fixed', inset: 0, zIndex: 9999,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'rgba(10,10,15,0.65)', backdropFilter: 'blur(12px)',
            }}
            onClick={() => setShowStoreModal(false)}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.92, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.92, y: 20 }}
              onClick={(e) => e.stopPropagation()}
              style={{
                background: COLORS.cardBg, border: `1px solid ${COLORS.cardBorder}`,
                borderRadius: 'var(--radius-2xl)', padding: '36px 32px',
                maxWidth: 420, width: '90%',
                display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 20,
                boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
              }}
            >
              <motion.div
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                transition={{ type: 'spring', stiffness: 300, damping: 20, delay: 0.1 }}
                style={{
                  width: 64, height: 64, borderRadius: 20,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: `${HEX_COLORS.accent}15`, color: COLORS.accent,
                }}
              >
                <Store size={30} />
              </motion.div>
              <div style={{ textAlign: 'center' }}>
                <h3 style={{
                  fontSize: 17, fontWeight: 600, color: COLORS.textPrimary,
                  margin: '0 0 8px',
                }}>
                  插件商店即将上线
                </h3>
                <p style={{
                  fontSize: 13, color: COLORS.textMuted,
                  lineHeight: 1.6, margin: 0,
                }}>
                  我们正在努力建设中，敬请期待更丰富的插件生态。
                  <br />
                  您仍可通过「从本地安装」按钮添加自定义插件。
                </p>
              </div>
              <motion.button
                whileHover={{ scale: 1.03 }}
                whileTap={{ scale: 0.97 }}
                onClick={() => setShowStoreModal(false)}
                style={{
                  padding: '10px 32px', borderRadius: 12, cursor: 'pointer',
                  fontFamily: 'inherit', fontSize: 13, fontWeight: 600,
                  background: COLORS.accent, border: 'none', color: '#fff',
                }}
              >
                知道了
              </motion.button>
            </motion.div>
          </motion.div>
          </FocusTrap>
        )}
      </AnimatePresence>
    </motion.div>
      </ErrorBoundary>
  )
}
