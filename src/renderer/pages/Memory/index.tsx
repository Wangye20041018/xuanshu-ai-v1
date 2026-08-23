import { useState, useEffect, useRef, useCallback } from 'react'

import { motion, AnimatePresence } from 'framer-motion'
import { HEX_COLORS, COLORS, containerVariants, itemVariants } from '../../shared/theme'

import { Search, Trash2, Clock, Database, Brain, MessageSquare, Heart, Lightbulb, X, Info, ChevronDown } from 'lucide-react'


import { CONFIG_KEYS } from '../../../shared/config-keys'
import { logger } from '../../../shared/logger'
import ErrorBoundary from '../../components/ErrorBoundary'
import { showToast } from '../../components/Toast'
import type { ConfigData } from '../../../shared/ipc-types'

/* ==================== Ã¥Â¿ÂÃ¨ÂÂ¨Ã¦Â¥Â¼Ã¦Â°ÂÃ¨ÂÂ«Ã¦ÂÂ¢Ã¦Â°ÂÃ¥ÂºÂÃ¨ÂÂ·Ã§ÂÂ²Ã©Â¹Â¿Ã¨ÂÂ£ ==================== */

interface MemoryItem {

  id: string

  content: string

  type: 'conversation' | 'preference' | 'fact'

  timestamp: number

  tags: string[]

  score?: number

}

interface RAGStats {

  total: number

  memories: number

  knowledge: number

}

/* ==================== Ã§ÂÂ«Ã¥ÂºÂÃ¦ÂÂ®Ã§ÂÂ«Ã¥ÂºÂÃ©ÂÂÃ§ÂÂ²Ã§Â¦ÂÃ©ÂÂÃ¨ÂÂ½Ã¨ÂÂ£Ã¨ÂÂ¦ ==================== */

const statContainerVariants = {

  hidden: { opacity: 0 },

  visible: {

    opacity: 1,

    transition: {

      staggerChildren: 0.1,

      delayChildren: 0.1,

    },

  },

}

const statItemVariants = {

  hidden: { opacity: 0, y: 16, scale: 0.96 },

  visible: {

    opacity: 1,

    y: 0,

    scale: 1,

    transition: { duration: 0.5, ease: [0.4, 0, 0.2, 1] },

  },

}

/* ==================== é¾èå´µç»å¬ç³é±æä»´è¹æ¬ä¼£é±Â¤å¹æ£°å®åé¼å°ä»§é±Ñå°é±ï½æª?==================== */

const typeConfig: Record<string, { label: string; color: string; icon: React.ReactNode }> = {

  conversation: {

    label: '对话',

    color: COLORS.accent,

    icon: <MessageSquare size={12} />,

  },

  preference: {

    label: '偏好',

    color: COLORS.accent2,

    icon: <Heart size={12} />,

  },

  fact: {

    label: '知识',

    color: COLORS.warning,

    icon: <Lightbulb size={12} />,

  },

}

/* ==================== Ã§ÂÂ«Ã§ÂÂÃ¥Â¨ÂÃ¥Â¿ÂÃ¨ÂÂÃ¨ÂÂÃ¦Â°ÂÃ¥Â½ÂÃ©Â¹Â¿Ã¨ÂÂ½Ã©ÂÂÃ¨ÂÂ´ ==================== */

function DetailModal({ memory, onClose, onSave }: { memory: MemoryItem; onClose: () => void; onSave: (id: string, data: { content: string; tags: string[] }) => void }) {

  const config = typeConfig[memory.type] || typeConfig.fact
  const [isEditing, setIsEditing] = useState(false)
  const [editContent, setEditContent] = useState(memory.content)
  const [editTags, setEditTags] = useState(memory.tags.join(', '))

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEditing])

  const handleSave = () => {
    const tags = editTags.split(',').map(t => t.trim()).filter(Boolean)
    onSave(memory.id, { content: editContent, tags })
    setIsEditing(false)
  }

  const handleCancel = () => {
    setEditContent(memory.content)
    setEditTags(memory.tags.join(', '))
    setIsEditing(false)
  }

  const handleClose = () => {
    setIsEditing(false)
    onClose()
  }

  return (

    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.25 }}
      style={{ position: 'fixed', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, backgroundColor: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(10px)' }}
      onClick={handleClose}
    >

      <motion.div
        initial={{ opacity: 0, scale: 0.88, y: 30 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.88, y: 30 }}
        transition={{ duration: 0.35, ease: [0.4, 0, 0.2, 1] }}
        onClick={(e) => e.stopPropagation()}
        style={{ width: 600, maxHeight: '80vh', overflow: 'auto', padding: 28, borderRadius: 'var(--radius-2xl)', background: 'rgba(20,20,30,0.96)', border: `1px solid ${COLORS.cardBorder}`, boxShadow: '0 25px 70px rgba(0,0,0,0.55), 0 0 40px rgba(0,0,0,0.3)' }}
      >

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>

            <motion.div
              whileHover={{ scale: 1.08 }}
              style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', fontSize: 12, fontWeight: 500, borderRadius: '9999px', background: `${config.color}20`, color: config.color, border: `1px solid ${config.color}35`, boxShadow: `0 0 12px ${config.color}15` }}
            >
              {config.icon}
              {config.label}
            </motion.div>

            {memory.score !== undefined && (
              <motion.span
                animate={{
                  boxShadow: [
                    `0 0 0px ${HEX_COLORS.warning}00`,
                    `0 0 12px ${HEX_COLORS.warning}20`,
                  ],
                }}
                transition={{ duration: 1.8, repeat: Infinity, repeatType: 'reverse' }}
style={{ padding: '4px 12px', fontSize: 12, fontWeight: 500, borderRadius: '9999px', background: `${HEX_COLORS.warning}12`, color: COLORS.warning, border: `1px solid ${HEX_COLORS.warning}25` }}
              >
                相关度 {Math.round(memory.score * 100)}%
              </motion.span>
            )}

          </div>

          <motion.button
            whileHover={{ scale: 1.12, rotate: 90, boxShadow: `0 0 16px rgba(255,255,255,0.1)` }}
            whileTap={{ scale: 0.88 }}
            onClick={handleClose}
style={{ minHeight: 36, minWidth: 36, display: 'flex', alignItems: 'center', justifyContent: 'center', color: COLORS.textMuted, background: COLORS.cardBg, borderRadius: 'var(--radius-2xl)', cursor: 'pointer', border: 'none' }}
          >
            <X size={16} />
          </motion.button>

        </div>

        {/* Timestamp + Source */}
        <div
          style={{ display: 'flex', alignItems: 'center', gap: 16, fontSize: 12, marginBottom: 20, color: COLORS.textMuted }}
        >
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Clock size={12} />
            {new Date(memory.timestamp).toLocaleString()}
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Database size={12} />
            来源：{memory.type === 'conversation' ? '对话记录' : memory.type === 'preference' ? '偏好学习' : '知识提取'}
          </span>
        </div>

        {/* Content - editable */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.15, duration: 0.4 }}
          style={{ marginBottom: 20 }}
        >
          <label style={{ display: 'block', fontSize: 12, color: COLORS.textSecondary, marginBottom: 8 }}>
            记忆原文
          </label>
          {isEditing ? (
            <textarea
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              rows={6}
              style={{
                width: '100%', padding: '14px 16px',
                borderRadius: 'var(--radius-2xl)',
                background: COLORS.cardBg,
                border: `1px solid ${COLORS.cardBorder}`,
                color: COLORS.textPrimary,
                fontSize: 14, lineHeight: 1.7,
                outline: 'none',
                boxSizing: 'border-box',
                fontFamily: 'inherit',
                resize: 'vertical',
              }}
            />
          ) : (
            <div
              style={{ padding: 20, fontSize: 14, lineHeight: 1.7, borderRadius: 'var(--radius-2xl)', background: COLORS.cardBg, border: `1px solid ${COLORS.cardBorder}`, color: COLORS.textPrimary }}
            >
              {memory.content}
            </div>
          )}
        </motion.div>

        {/* Tags - editable */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.25 }}
          style={{ marginBottom: 20 }}
        >
          <label style={{ display: 'block', fontSize: 12, color: COLORS.textSecondary, marginBottom: 8 }}>
            标签（逗号分隔）
          </label>
          {isEditing ? (
            <input
              value={editTags}
              onChange={(e) => setEditTags(e.target.value)}
              placeholder="输入标签，逗号分隔..."
              style={{
                width: '100%', padding: '12px 16px',
                borderRadius: 'var(--radius-lg)',
                background: COLORS.cardBg,
                border: `1px solid ${COLORS.cardBorder}`,
                color: COLORS.textPrimary,
                fontSize: 13,
                outline: 'none',
                boxSizing: 'border-box',
                fontFamily: 'inherit',
              }}
            />
          ) : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
              {memory.tags.length > 0 ? memory.tags.map((tag) => (
                <motion.span
                  key={tag}
                  whileHover={{ scale: 1.06, boxShadow: `0 0 12px ${HEX_COLORS.accent}15` }}
                  style={{ padding: '4px 12px', fontSize: 12, borderRadius: '9999px', background: COLORS.cardBg, border: `1px solid ${COLORS.cardBorder}`, color: COLORS.textSecondary, transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)' }}
                >
                  {tag}
                </motion.span>
              )) : (
                <span style={{ fontSize: 12, color: COLORS.textMuted }}>暂无标签</span>
              )}
            </div>
          )}
        </motion.div>

        {/* Action Buttons */}
        <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end', marginTop: 8 }}>
          {isEditing ? (
            <>
              <motion.button
                whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }}
                onClick={handleCancel}
                style={{
                  padding: '10px 20px', borderRadius: 'var(--radius-lg)', cursor: 'pointer', fontFamily: 'inherit',
                  background: 'transparent', border: `1px solid ${COLORS.cardBorder}`,
                  color: COLORS.textSecondary, fontSize: 13, fontWeight: 500,
                }}
              >
                取消
              </motion.button>
              <motion.button
                whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }}
                onClick={handleSave}
                style={{
                  padding: '10px 24px', borderRadius: 'var(--radius-lg)', cursor: 'pointer', fontFamily: 'inherit',
                  background: COLORS.accent, border: 'none', color: '#fff', fontSize: 13, fontWeight: 600,
                }}
              >
                保存
              </motion.button>
            </>
          ) : (
            <motion.button
              whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }}
              onClick={() => setIsEditing(true)}
              style={{
                padding: '10px 24px', borderRadius: 'var(--radius-lg)', cursor: 'pointer', fontFamily: 'inherit',
                background: COLORS.accent, border: 'none', color: '#fff', fontSize: 13, fontWeight: 600,
              }}
            >
              编辑
            </motion.button>
          )}
        </div>

      </motion.div>

    </motion.div>

  )

}
/* ==================== Ã¥Â¿ÂÃ§Â¢ÂÃ¨ÂÂÃ¦Â°ÂÃ¨ÂÂÃ¨ÂÂ£Ã§ÂÂ«Ã©Â©Â´Ã¨ÂÂ¸Ã¦Â°ÂÃ¦Â½ÂÃ¥Â¨ÂÃ¥Â¿ÂÃ¨ÂÂºÃ©ÂÂÃ¨ÂÂ½Ã§Â¦ÂÃ¨ÂÂÃ§ÂÂ²Ã§Â¦Â?==================== */

function ShimmerBar({ score }: { score: number }) {

  return (

    <div

      style={{ height: 10, overflow: 'hidden', position: 'relative', borderRadius: '9999px', background: 'rgba(255,255,255,0.06)' }}

    >

      <motion.div

        initial={{ width: 0 }}

        animate={{ width: `${Math.round(score * 100)}%` }}

        transition={{ duration: 0.8, ease: [0.4, 0, 0.2, 1], delay: 0.2 }}

        style={{ height: '100%', position: 'relative', borderRadius: '9999px', background: `linear-gradient(90deg, ${COLORS.warning}, ${COLORS.accent}, ${COLORS.warning})`, backgroundSize: '200% 100%' }}

      >

        <motion.div

          style={{ position: 'absolute', inset: 0, borderRadius: '9999px', background: 'linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.25) 50%, transparent 100%)', backgroundSize: '200% 100%' }}

          animate={{ backgroundPosition: ['200% 0', '-200% 0'] }}

          transition={{ duration: 2, repeat: Infinity, ease: 'linear' }}

        />

      </motion.div>

    </div>
  )

}

/* ==================== Ã§ÂÂ²Ã¨ÂµÂÃ§Â¦ÂÃ¨ÂÂ½Ã§Â¦ÂÃ¨ÂÂÃ§ÂÂ²Ã§Â¦Â?==================== */

function Memory() {

  const [memories, setMemories] = useState<MemoryItem[]>([])

  const [searchQuery, setSearchQuery] = useState('')

  const [filterType, setFilterType] = useState<'all' | 'conversation' | 'preference' | 'fact'>('all')

  const [isSearching, setIsSearching] = useState(false)

  const [isDeleting, setIsDeleting] = useState(false)

  const [stats, setStats] = useState<RAGStats>({ total: 0, memories: 0, knowledge: 0 })

  const [detailMemory, setDetailMemory] = useState<MemoryItem | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  /* ---------- 系统提示词和用户画像 ---------- */
  const [systemPrompt, setSystemPrompt] = useState('')
  const [userProfile, setUserProfile] = useState('')
  const [sysSettingsExpanded, setSysSettingsExpanded] = useState(false)

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const scheduleConfigSave = useCallback((key: string, value: unknown) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      window.api?.invoke('config:set', key, value).catch((e) => { logger.error('[Memory] 保存配置失败', e) })
    }, 800)
  }, [])

  useEffect(() => {

    loadMemories().catch((e) => { logger.error('[Memory] 加载记忆失败', e) })

    loadStats().catch((e) => { logger.error('[Memory] 加载统计失败:', e) })

    // 加载系统提示词和用户画像
    const loadSysConfig = async () => {
      try {
        if (window.api) {
          const config = await window.api.invoke<Partial<ConfigData>>('config:get')
          if (config) {
            if (config.systemPrompt) setSystemPrompt(config.systemPrompt)
            if (config.userProfile) setUserProfile(config.userProfile)
          }
        }
      } catch (err) { logger.error('加载系统配置失败:', err) }
    }
    loadSysConfig()

  }, [])

  /* ---------- IPC Ã§ÂÂ«Ã¦ÂÂ³Ã¨ÂÂÃ¨ÂÂ½Ã¨ÂÂ°Ã§Â¯ÂÃ¨ÂÂÃ¥Â½ÂÃ¨ÂÂ¢Ã§ÂÂ²Ã©Â©Â´Ã¨ÂÂºÃ¥Â¿ÂÃ¨ÂÂ¦Ã¨ÂÂÃ§ÂÂ²Ã¨ÂµÂÃ¨ÂÂ§Ã¦Â°ÂÃ¨ÂÂ«Ã¨ÂÂµÃ¨ÂÂÃ¥Â½ÂÃ¨ÂÂ£ ---------- */

  const loadMemories = async () => {
    try {
      if (window.api) {
        const result = await window.api.invoke<MemoryItem[]>('rag:list-memories')
        setMemories(result.map((m: MemoryItem & { metadata?: { tags?: string[]; timestamp?: number; type?: string } }) => ({
          id: m.id,
          content: m.content || (m as any).text || '',
          type: (m.type || m.metadata?.type || 'fact') as MemoryItem['type'],
          timestamp: m.timestamp || m.metadata?.timestamp || Date.now(),
          tags: m.tags || m.metadata?.tags || []
        })))
        setLoadError(null)
      }
    } catch (error) {
      logger.error('Failed to load memories:', error)
      setLoadError('加载记忆失败，请检查服务是否正常运行')
    }
  }

  const loadStats = async () => {

    try {

      if (window.api) {

        const result = await window.api.invoke<RAGStats>('rag:stats')

        setStats(result)

      }

    } catch (error) {

      logger.error('Failed to load stats:', error)

    }

  }

  const handleSearch = async () => {

    if (isSearching) return

    if (!searchQuery.trim()) {

      loadMemories()

      return

    }

    setIsSearching(true)

    try {

      if (window.api) {

        const result = await window.api.invoke<MemoryItem[]>('rag:search-memory', searchQuery, 20)

        setMemories(result.map((r) => ({
          id: r.id,
          content: r.content || (r as any).text || '',
          type: (r.type || (r as any).metadata?.type || 'fact') as MemoryItem['type'],
          timestamp: r.timestamp || (r as any).metadata?.timestamp || (r as any).createdAt || (r as any).metadata?.createdAt || Date.now(),
          tags: r.tags || (r as any).metadata?.tags || [],
          score: r.score ?? (r as any)._score ?? (r as any).metadata?.score
        })))

      }

    } catch (error) {

      logger.error('Failed to search:', error)

    } finally {

      setIsSearching(false)

    }

  }

  const handleDelete = async (id: string) => {

    if (isDeleting) return

    setIsDeleting(true)

    try {

      if (window.api) {

        await window.api.invoke('rag:delete', id)

        setMemories(memories.filter((m) => m.id !== id))

        loadStats()

      }

    } catch (error) {

      logger.error('Failed to delete:', error)

      showToast('error', '删除记忆失败，请稍后重试')

    } finally {

      setIsDeleting(false)

    }

  }

  const handleUpdateMemory = async (id: string, data: { content: string; tags: string[] }) => {
    if (!window.api || !detailMemory) return
    try {
      // Deduplication check: skip if identical content already exists (excluding current item)
      const duplicate = memories.find(
        (m) => m.id !== id && m.content === data.content && m.type === detailMemory.type
      )
      if (duplicate) {
        // Remove the old item and point to the duplicate instead
        await window.api.invoke('rag:delete', id)
        setMemories(memories.map((m) => (m.id === id ? { ...duplicate } : m)))
        setDetailMemory(null)
        loadStats()
        return
      }

      // Add new memory FIRST; if it fails, old data is preserved
      const result = await window.api.invoke('rag:add-memory', {
        content: data.content,
        type: detailMemory.type,
        tags: data.tags,
      })
      // Only delete the old memory after a successful add
      if (result && (result as any).id) {
        await window.api.invoke('rag:delete', id)
      }
      setMemories(memories.map((m) => (m.id === id ? { ...m, content: data.content, tags: data.tags, id: (result as any)?.id || id } : m)))
      setDetailMemory(null)
      loadStats()
    } catch (error) {
      logger.error('Failed to update memory:', error)
    }
  }

  /* ---------- Ã§ÂÂ«Ã©Â©Â´Ã¨ÂÂ¡Ã¥Â¿ÂÃ§Â¦ÂÃ©ÂÂ ---------- */

  const filteredMemories = memories.filter((m) => {

    if (filterType !== 'all' && m.type !== filterType) return false

    return true

  })

  /* ==================== è¹æ¬ç¥©éå¿ç¹é±è°ä¼?==================== */

  return (
    <ErrorBoundary>
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, backgroundColor: COLORS.bg }}>

      {/* ==================== Ã¨ÂÂÃ©ÂÂÃ©ÂÂ²Ã¨ÂÂÃ¨ÂÂÃ§Â¯ÂÃ¨ÂÂ½Ã§Â¦ÂÃ¨ÂÂ¼Ã§ÂÂ«Ã¥ÂºÂÃ©ÂÂÃ¦Â°ÂÃ¨ÂÂ¦?==================== */}

      <motion.div

        initial={{ opacity: 0, y: -12 }}

        animate={{ opacity: 1, y: 0 }}

        transition={{ duration: 0.55, ease: [0.4, 0, 0.2, 1] }}

        style={{ padding: '28px 32px 12px 32px' }}

      >

        {/* é¼å´æ®çº°å²å¯é±åç¯è¹æ¬ä¼£é±Â¤å¯é¨å®ä¼?*/}

        <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 24 }}>

          <motion.div

            whileHover={{ scale: 1.1, rotate: 5 }}

style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 40, height: 40, background: `${HEX_COLORS.accent}15`, border: `1px solid ${HEX_COLORS.accent}25`, borderRadius: 'var(--radius-2xl)' }}

          >

            <Brain size={19} style={{ color: COLORS.accent }} />

          </motion.div>

          <div>

            <h2 style={{ fontSize: 26, fontWeight: 800, color: COLORS.textPrimary, margin: 0, letterSpacing: '-0.02em' }}>

              记忆管理

            </h2>

            <p style={{ fontSize: 12, color: COLORS.textMuted, margin: '2px 0 0', opacity: 0.7 }}>

              RAG 知识库 · 智能记忆管理

            </p>

          </div>

        </div>

        {/* 统计面板 */}

        <motion.div

          variants={statContainerVariants}

          initial="hidden"

          animate="visible"

          style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: '24px', marginBottom: 24 }}

        >

          {[

            { label: 'RAG 统计', value: stats.total, color: COLORS.accent, icon: <Database size={17} /> },

            { label: '对话记忆', value: stats.memories, color: COLORS.accent, icon: <MessageSquare size={17} /> },

            { label: '知识记忆', value: stats.knowledge, color: COLORS.warning, icon: <Lightbulb size={17} /> },

          ].map((stat) => (

            <motion.div

              key={stat.label}

              variants={statItemVariants}

              whileHover={{

                borderColor: `${stat.color}50`,

                boxShadow: `0 8px 36px rgba(0,0,0,0.5), 0 0 28px ${stat.color}15`,

                y: -3,

              }}

              style={{ padding: '20px', borderRadius: 'var(--radius-2xl)', background: COLORS.cardBg, border: `1px solid ${COLORS.cardBorder}`, boxShadow: '0 8px 32px rgba(0,0,0,0.4), 0 2px 0 rgba(255,255,255,0.02) inset', backdropFilter: 'blur(20px)', transition: 'all 0.35s cubic-bezier(0.4, 0, 0.2, 1)', cursor: 'default' }}

            >

              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>

                <span style={{ color: COLORS.textMuted, fontSize: 12 }}>

                  {stat.label}

                </span>

                <motion.span

                  whileHover={{ scale: 1.15, rotate: 5 }}

                  style={{ color: stat.color, transition: 'all 0.3s' }}

                >

                  {stat.icon}

                </motion.span>

              </div>

              <span style={{ fontSize: 24, fontWeight: 700, color: COLORS.textPrimary }}>

                {stat.value}

              </span>

            </motion.div>

          ))}

        </motion.div>

      </motion.div>

      {/* ==================== è¹æ¬ä¼é±ç¡å¹æ¥¹æ³ç¯è¹æ¬ä¼£?==================== */}

      <motion.div

        initial={{ opacity: 0, y: 12 }}

        animate={{ opacity: 1, y: 0 }}

        transition={{ duration: 0.55, delay: 0.15, ease: [0.4, 0, 0.2, 1] }}

        style={{ padding: '24px 32px', marginTop: 16 }}

      >

        <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>

          {/* è¹æ¬ä¼é±ç¡å¹æ¥¹æ³ç¯è¹æ¬æ®?*/}

          <div style={{ position: 'relative', flex: '1 1 280px', minWidth: 200, maxWidth: 500 }}>

            <Search

              size={16}

              style={{ position: 'absolute', left: 16, top: '50%', transform: 'translateY(-50%)', color: COLORS.textMuted }}

            />

            <input

              type="text"

              value={searchQuery}

              onChange={(e) => setSearchQuery(e.target.value)}

              onKeyDown={(e) => e.key === 'Enter' && handleSearch()}

              placeholder="搜索 RAG 记忆库..."

              style={{

                width: '100%',

                height: 42,

                padding: '0 16px 0 44px',

                borderRadius: 'var(--radius-2xl)',

                background: 'rgba(255,255,255,0.04)',

                border: `1px solid ${COLORS.cardBorder}`,

                color: COLORS.textPrimary,

                fontSize: 14,

                outline: 'none',

                transition: 'all 0.35s cubic-bezier(0.4, 0, 0.2, 1)',

                boxSizing: 'border-box',

              }}

              onFocus={(e) => {

                e.currentTarget.style.borderColor = COLORS.accent

                e.currentTarget.style.boxShadow = `0 0 0 4px ${HEX_COLORS.accent}12, 0 0 28px ${HEX_COLORS.accent}15`

              }}

              onBlur={(e) => {

                e.currentTarget.style.borderColor = COLORS.cardBorder

                e.currentTarget.style.boxShadow = 'none'

              }}

            />

          </div>

          {/* Ã¥Â¿ÂÃ¨ÂÂ¬Ã¨ÂÂ¹Ã¨ÂÂ½Ã©ÂºÂÃ¥ÂÂÃ¥Â¿ÂÃ¨ÂÂ¦Ã¨ÂÂ£Ã¨ÂÂÃ¨ÂÂ®Ã¥ÂºÂ */}

          

  

          {/* Ã¨ÂÂ½Ã¥ÂÂ¤Ã§Â¦ÂÃ¦Â°ÂÃ¨ÂÂ»Ã¨ÂÂ¥Ã¨ÂÂ½Ã©Â¢ÂÃ¨ÂÂ¸Ã¨ÂÂÃ¨ÂÂÃ¨ÂÂ£Ã§ÂÂ²Ã¨ÂµÂÃ¨ÂÂ¥Ã¥Â¿ÂÃ¨ÂÂ¥?*/}

          <select

            value={filterType}

            onChange={(e) => setFilterType(e.target.value as typeof filterType)}

            style={{

              minHeight: 44,

              padding: '0 40px 0 16px',

              borderRadius: 'var(--radius-2xl)',

              background: 'rgba(255,255,255,0.04)',

              border: `1px solid ${COLORS.cardBorder}`,

              color: COLORS.textSecondary,

              fontSize: 14,

              outline: 'none',

              cursor: 'pointer',

              transition: 'all 0.35s cubic-bezier(0.4, 0, 0.2, 1)',

              boxSizing: 'border-box',

            }}

          >

            <option value="all">全部</option>

            <option value="conversation">对话记忆</option>

            <option value="preference">偏好记忆</option>

            <option value="fact">知识记忆</option>

          </select>

        </div>

      </motion.div>

      {/* ==================== Ã§ÂÂ«Ã¥ÂºÂÃ¦ÂÂ³Ã¦Â°ÂÃ©Â©Â´Ã¨ÂÂ Ã¦Â°ÂÃ¨ÂÂ¢Ã¨ÂÂ´Ã§ÂÂ«Ã©ÂÂÃ§Â¯ÂÃ¨ÂÂÃ¥Â½ÂÃ¨ÂÂ¢Ã¦Â°ÂÃ¨ÂÂ«Ã¨ÂÂ¦Ã¦Â°ÂÃ¨ÂÂ¢Ã¨ÂÂ´Ã¦Â°ÂÃ¨ÂÂ§Ã©ÂÂÃ¨ÂÂ½Ã¨ÂÂ£Ã¨ÂÂ¡Ã¨ÂÂ½Ã©ÂÂÃ¨ÂÂ­Ã¥Â¿ÂÃ¨ÂÂ½Ã¥Â½ÂÃ¨ÂÂÃ¥Â½ÂÃ¨ÂÂ£ ==================== */}

      <div style={{ flex: 1, overflow: 'auto', padding: '0 32px 32px 32px' }}>

        <motion.div

          variants={containerVariants}

          initial="hidden"

          animate="visible"

          style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '20px' }}

        >

          <AnimatePresence mode="wait">

            {filteredMemories.map((memory) => {

              const config = typeConfig[memory.type] || typeConfig.fact

              return (

                <motion.div

                  key={memory.id}

                  variants={itemVariants}

                  whileHover={{

                    y: -5,

                    borderColor: COLORS.cardBorderHover,

                    boxShadow: '0 12px 40px rgba(0,0,0,0.35), 0 0 0 1px rgba(255,255,255,0.04)',

                  }}

                  style={{ padding: 28, cursor: 'pointer', position: 'relative', overflow: 'hidden', borderRadius: 'var(--radius-2xl)', background: COLORS.cardBg, border: `1px solid ${COLORS.cardBorder}`, boxShadow: '0 8px 32px rgba(0,0,0,0.35), 0 2px 0 rgba(255,255,255,0.01) inset', backdropFilter: 'blur(20px)', transition: 'all 0.35s cubic-bezier(0.4, 0, 0.2, 1)' }}

                  onClick={() => setDetailMemory(memory)}

                >

                  {/* Ã¨ÂÂÃ©ÂÂÃ©ÂÂ²Ã¨ÂÂÃ¨ÂÂÃ§Â¯ÂÃ¨ÂÂÃ¥Â½ÂÃ¨ÂÂ·Ã¨ÂÂ½Ã¥ÂÂ¤Ã§Â¦ÂÃ¦Â°ÂÃ¨ÂÂ»Ã¨ÂÂ¥Ã¥Â¿ÂÃ¨ÂÂ½Ã¨ÂÂ¡Ã¨ÂÂ½Ã©Â¢Â?+ Ã¥Â¿ÂÃ¨ÂÂ¯Ã¨ÂÂ§Ã§ÂÂ²Ã©ÂÂÃ¨ÂÂ¹Ã¥Â¿ÂÃ¨ÂÂ¦Ã¨ÂÂ£Ã¨ÂÂÃ¨ÂÂ®Ã¥ÂºÂ */}

                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>

                    <motion.div

                      whileHover={{

                        scale: 1.06,

                        boxShadow: `0 0 16px ${config.color}20`,

                      }}

                      style={{

                        display: 'flex', alignItems: 'center', gap: 8,

                        padding: '8px 16px', fontSize: 13, fontWeight: 500,

                        borderRadius: '9999px',

                        background: `${config.color}20`,

                        color: config.color,

                        border: `1px solid ${config.color}35`,

                        transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',

                      }}

                    >

                      {config.icon}

                      {config.label}

                    </motion.div>

                    <motion.button

whileHover={{ scale: 1.18, boxShadow: `0 0 12px ${HEX_COLORS.dangerAlt}40` }}

                      whileTap={{ scale: 0.85 }}

                      onClick={(e) => {

                        e.stopPropagation()

                        handleDelete(memory.id)

                      }}

                      style={{ padding: 8, opacity: 0, minHeight: 36, minWidth: 36, display: 'flex', alignItems: 'center', justifyContent: 'center', color: COLORS.textMuted, background: COLORS.cardBg, borderRadius: 'var(--radius-2xl)', border: 'none', cursor: 'pointer', transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)' }}

                      onMouseEnter={(e) => {

                        e.currentTarget.style.color = COLORS.dangerAlt

e.currentTarget.style.background = COLORS.dangerDim

                      }}

                      onMouseLeave={(e) => {

                        e.currentTarget.style.color = COLORS.textMuted

                        e.currentTarget.style.background = COLORS.cardBg

                      }}

                    >

                      <Trash2 size={14} />

                    </motion.button>

                  </div>

                  {/* å§æ¹ä»¸æ¥£è¯å¯é±ç»ä»¹å§æ´ç¶æ¿å­å°æ¤¹ç£ä¼å§æ´ç¶æ¿å«ç¹é±æ´ªæ®?*/}

                  {memory.score !== undefined && (

                    <div style={{ marginBottom: 8 }}>

                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>

                        <span style={{ fontSize: 12, color: COLORS.textMuted }}>

                          相关度                         </span>

                        <span style={{ fontSize: 12, fontWeight: 500, color: COLORS.warning }}>

                          {Math.round(memory.score * 100)}%

                        </span>

                      </div>

                      <ShimmerBar score={memory.score} />

                    </div>

                  )}

                  {/* å§æ¹ä»©é±ç¸ç³æ´æ°ç®è¹æ¬ä¼é±çµå°æ¿å®ä» */}

                <p

                  style={{ fontSize: 15, lineHeight: 1.8, color: COLORS.textSecondary, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical' }}

                >

                    {memory.content}

                  </p>

                  {/* Ã¦Â°ÂÃ¦Â½ÂÃ¨ÂÂ²Ã¨ÂÂÃ¨ÂÂÃ§Â¯ÂÃ¨ÂÂÃ¥Â½ÂÃ¨ÂÂ·Ã¥Â¿ÂÃ¨ÂÂ½Ã¨ÂÂ¡Ã¨ÂÂ½Ã©Â¢Â?+ è¹æ¬ä¼éè¶å¯é±æ®ç°?*/}

                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>

                    {memory.tags.length > 0 && (

<div style={{ display: 'flex', alignItems: 'center', gap: 8, overflow: 'hidden' }}>

                        {memory.tags.slice(0, 2).map((tag) => (

                          <motion.span

                            key={tag}

                            whileHover={{

                              scale: 1.06,

                              borderColor: `${HEX_COLORS.accent}30`,

                              boxShadow: `0 0 10px ${HEX_COLORS.accent}10`,

                            }}

style={{ padding: '2px 10px', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 90, borderRadius: '9999px', background: COLORS.cardBg, border: `1px solid ${COLORS.cardBorder}`, color: COLORS.textMuted, transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)' }}

                          >

                            {tag}

                          </motion.span>

                        ))}

                        {memory.tags.length > 2 && (

                          <span style={{ fontSize: 12, color: COLORS.textMuted }}>

                            +{memory.tags.length - 2}

                          </span>

                        )}

                      </div>

                    )}

                    <div

                      style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, marginLeft: 'auto', color: COLORS.textMuted }}

                    >

                      <Clock size={11} />

                      {new Date(memory.timestamp).toLocaleDateString()}

                    </div>

                  </div>

                </motion.div>

              )

            })}

          </AnimatePresence>

        </motion.div>

        {/* empty / error state */}
        {loadError ? (
          <motion.div
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '96px 0' }}
          >
            <motion.div
              animate={{ y: [0, -6, 0] }}
              transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut' }}
style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 64, height: 64, marginBottom: 24, background: `${HEX_COLORS.danger}10`, borderRadius: 'var(--radius-2xl)' }}
            >
              <X size={32} style={{ color: COLORS.danger, opacity: 0.6 }} />
            </motion.div>
            <p style={{ fontWeight: 500, color: COLORS.danger }}>
              {loadError}
            </p>
            <button
              onClick={() => { setLoadError(null); loadMemories(); }}
              style={{ fontSize: 14, marginTop: 16, padding: '8px 16px', cursor: 'pointer', color: COLORS.accent, border: `1px solid ${HEX_COLORS.accent}40`, borderRadius: 'var(--radius-lg)', background: 'transparent' }}
            >
              重试
            </button>
          </motion.div>
        ) : filteredMemories.length === 0 && (
          <motion.div
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '96px 0' }}
          >
            <motion.div
              animate={{ y: [0, -6, 0] }}
              transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut' }}
style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 64, height: 64, marginBottom: 24, background: `${HEX_COLORS.accent}10`, borderRadius: 'var(--radius-2xl)' }}
            >
              <Brain size={32} style={{ color: COLORS.accent, opacity: 0.4 }} />
            </motion.div>
            <p style={{ fontWeight: 500, color: COLORS.textSecondary }}>
              暂无记忆
            </p>
            <p style={{ fontSize: 14, marginTop: 12, color: COLORS.textMuted }}>
              开始与 AI 对话后，系统会自动记录重要信息
            </p>
          </motion.div>
        )}

      </div>

      {/* ==================== Ã§ÂÂ«Ã§ÂÂÃ¥Â¨ÂÃ¥Â¿ÂÃ¨ÂÂÃ¨ÂÂÃ¦Â°ÂÃ¥Â½ÂÃ©Â¹Â¿Ã¨ÂÂ½Ã©ÂÂÃ¨ÂÂ´ ==================== */}

      <AnimatePresence>

        {detailMemory && (

          <DetailModal memory={detailMemory} onClose={() => setDetailMemory(null)} onSave={handleUpdateMemory} />

        )}

      </AnimatePresence>

      {/* ==================== 系统设置分区 ==================== */}
      <div style={{ marginTop: 32, borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 24 }}>
        <motion.div
          whileHover={{ borderColor: 'rgba(255,255,255,0.12)' }}
          onClick={() => setSysSettingsExpanded(!sysSettingsExpanded)}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '14px 20px', borderRadius: 'var(--radius-2xl)',
            background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)',
            cursor: 'pointer', transition: 'all 0.3s',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{
              width: 36, height: 36, borderRadius: '14px',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'rgba(255,255,255,0.04)', color: COLORS.accent,
            }}>
              <Info size={18} />
            </div>
            <div>
              <div style={{ fontSize: 14, fontWeight: 500, color: COLORS.textPrimary }}>系统设置</div>
              <div style={{ fontSize: 12, color: COLORS.textMuted, marginTop: 2 }}>
                系统提示词 &middot; 用户画像
              </div>
            </div>
          </div>
          <motion.div
            animate={{ rotate: sysSettingsExpanded ? 180 : 0 }}
            transition={{ duration: 0.25 }}
            style={{ color: COLORS.textMuted }}
          >
            <ChevronDown size={18} />
          </motion.div>
        </motion.div>

        <AnimatePresence>
          {sysSettingsExpanded && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.3, ease: 'easeOut' }}
              style={{ overflow: 'hidden' }}
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: 24, paddingTop: 24 }}>
                {/* 系统提示词 */}
                <motion.div
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.1 }}
                  style={{
                    padding: '24px 28px', borderRadius: 'var(--radius-2xl)',
                    border: '1px solid rgba(255,255,255,0.06)',
                    background: 'rgba(255,255,255,0.015)',
                    borderLeft: '3px solid rgba(255,255,255,0.3)',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20 }}>
                    <Info size={16} style={{ color: COLORS.accent }} />
                    <span style={{ fontSize: 14, fontWeight: 500, color: COLORS.textPrimary }}>系统提示词</span>
                  </div>
                  <p style={{ fontSize: 13, color: COLORS.textSecondary, lineHeight: 1.6, margin: '0 0 12px' }}>
                    设置 AI 助手的系统级行为指令
                  </p>
                  <textarea
                    value={systemPrompt}
                    onChange={(e) => {
                      const val = e.target.value
                      setSystemPrompt(val)
                      scheduleConfigSave(CONFIG_KEYS.SYSTEM_PROMPT, val)
                    }}
                    placeholder="例如：你是一位专业的编程助手，擅长 TypeScript 和 React..."
                    rows={4}
                    style={{
                      background: 'rgba(255,255,255,0.03)',
                      border: '1px solid rgba(255,255,255,0.08)',
                      borderRadius: '12px', padding: '12px',
                      color: 'rgba(255,255,255,0.85)', fontSize: 'var(--text-base)',
                      fontFamily: 'inherit', outline: 'none', width: '100%',
                      boxSizing: 'border-box', resize: 'vertical', lineHeight: 1.6,
                    }}
                    onFocus={(e) => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.2)' }}
                    onBlur={(e) => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)' }}
                  />
                </motion.div>

                {/* 用户画像 */}
                <motion.div
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.2 }}
                  style={{
                    padding: '24px 28px', borderRadius: 'var(--radius-2xl)',
                    border: '1px solid rgba(255,255,255,0.06)',
                    background: 'rgba(255,255,255,0.015)',
                    borderLeft: '3px solid rgba(166,166,176,0.5)',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20 }}>
                    <Info size={16} style={{ color: COLORS.accent }} />
                    <span style={{ fontSize: 14, fontWeight: 500, color: COLORS.textPrimary }}>用户画像</span>
                  </div>
                  <p style={{ fontSize: 13, color: COLORS.textSecondary, lineHeight: 1.6, margin: '0 0 12px' }}>
                    描述你的身份、偏好和背景，让 AI 更了解你
                  </p>
                  <textarea
                    value={userProfile}
                    onChange={(e) => {
                      const val = e.target.value
                      setUserProfile(val)
                      scheduleConfigSave(CONFIG_KEYS.USER_PROFILE, val)
                    }}
                    placeholder="例如：我是全栈开发者，偏好函数式编程，日常使用 TypeScript 和 React..."
                    rows={6}
                    style={{
                      background: 'rgba(255,255,255,0.03)',
                      border: '1px solid rgba(255,255,255,0.08)',
                      borderRadius: '12px', padding: '12px',
                      color: 'rgba(255,255,255,0.85)', fontSize: 'var(--text-base)',
                      fontFamily: 'inherit', outline: 'none', width: '100%',
                      boxSizing: 'border-box', resize: 'vertical', lineHeight: 1.6,
                    }}
                    onFocus={(e) => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.2)' }}
                    onBlur={(e) => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)' }}
                  />
                </motion.div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

    </div>

    </ErrorBoundary>
  )

}

export default Memory

