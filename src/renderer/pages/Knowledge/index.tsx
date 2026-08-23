import { useState, useEffect, useRef, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Search, Trash2, Upload, Sparkles, Clock, Folder, FileText, Database, X, Eye, Globe, BookOpen, Loader2, CheckCircle2, AlertCircle } from 'lucide-react'
import { HEX_COLORS, COLORS, containerVariants, itemVariants, listItemVariants } from '../../shared/theme'

import { logger } from '../../../shared/logger'
import ErrorBoundary from '../../components/ErrorBoundary'
import { ErrorDisplay } from '../../components/ErrorDisplay'
import { useTranslation } from '../../i18n'
import { FocusTrap } from '../../components/a11y'
import { showToast } from '../../components/Toast'

/* ============================================================
 * Interfaces
 * ============================================================ */
interface KnowledgeDoc {
  id: string
  title: string
  type: 'file' | 'folder' | 'web'
  tags: string[]
  createdAt: number
  source: string
  content?: string
  score?: number
}

interface RAGStats {
  total: number
  memories: number
  knowledge: number
}

interface KnowledgeStats {
  totalDocuments: number
  totalVectors: number
  lastUpdated: number
  documents: KnowledgeDoc[]
}

interface PendingKnowledge {
  id: string
  title: string
  sourceConversation: string
  createdAt: number
}

type LearnStatus = 'idle' | 'searching' | 'validating' | 'generating' | 'done' | 'error'

/* ============================================================
 * Design Tokens
 * ============================================================ */
const statItemVariants = {
  hidden: { opacity: 0, scale: 0.96 },
  visible: { opacity: 1, scale: 1, transition: { duration: 0.35, ease: [0.4, 0, 0.2, 1] } },
}

/* ============================================================
 * Tag Color
 * ============================================================ */
function getTagColor(index: number): string[] {
  const palette = [
    [COLORS.accent, `${HEX_COLORS.accent}15`],
    [COLORS.accent2, `${COLORS.accent2}15`],
    [COLORS.cyan, `${HEX_COLORS.cyan}15`],
    [COLORS.warning, `${HEX_COLORS.warning}15`],
  ]
  return palette[index % palette.length]
}

/* ============================================================
 * Overlay Style
 * ============================================================ */
const overlayStyle: React.CSSProperties = {
  background: 'rgba(10,10,15,0.65)',
  backdropFilter: 'blur(12px)',
}

/* ============================================================
 * Main Component
 * ============================================================ */
export default function Knowledge() {
  const { t } = useTranslation()
  const [docs, setDocs] = useState<KnowledgeDoc[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [isSearching, setIsSearching] = useState(false)
  const [selectedDoc, setSelectedDoc] = useState<KnowledgeDoc | null>(null)
  const [isEditingDoc, setIsEditingDoc] = useState(false)
  const [editDocTitle, setEditDocTitle] = useState('')
  const [editDocContent, setEditDocContent] = useState('')
  const [editDocTags, setEditDocTags] = useState('')
  const [editDocSource, setEditDocSource] = useState('')
  const [showAddModal, setShowAddModal] = useState(false)
  const [newDoc, setNewDoc] = useState({ title: '', content: '', tags: '' })
  const [stats, setStats] = useState<RAGStats>({ total: 0, memories: 0, knowledge: 0 })
  const [isDeleting, setIsDeleting] = useState(false)
  const [isAdding, setIsAdding] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  /* ------ Pending Knowledge ------ */
  const [pendingItems, setPendingItems] = useState<PendingKnowledge[]>([])
  const [learnStatus, setLearnStatus] = useState<Record<string, LearnStatus>>({})
  const [learnResults, setLearnResults] = useState<Record<string, { confidence: number; sourceCount: number }>>({})

  useEffect(() => {
    return () => { if (searchTimerRef.current) clearTimeout(searchTimerRef.current) }
  }, [])

  /* ------ Load Docs ------ */
  const loadDocs = useCallback(async () => {
    if (!window.api) return
    try {
      setLoadError(null)
      const result = await window.api.invoke<KnowledgeStats | null>('knowledge:list')
      if (result) {
        setDocs(result.documents ?? [])
        setStats({ total: result.totalVectors ?? 0, memories: 0, knowledge: result.totalDocuments ?? 0 })
      }
    } catch (e) { logger.error('[Knowledge] 加载文档失败:', e); setLoadError(String(e)) }
  }, [])

  useEffect(() => { loadDocs() }, [loadDocs])

  /* ------ Load Pending ------ */
  useEffect(() => {
    async function loadPending() {
      if (!window.api) return
      try {
        const items = await window.api.invoke<PendingKnowledge[]>('knowledge:pending')
        if (items) setPendingItems(items)
      } catch (e) { logger.error('[Knowledge] 加载待学习知识点失败:', e) }
    }
    loadPending()
  }, [])

  /* ------ Auto-Learn ------ */
  const handleAutoLearn = async (item: PendingKnowledge) => {
    if (!window.api || learnStatus[item.id] === 'searching' || learnStatus[item.id] === 'validating' || learnStatus[item.id] === 'generating') return
    setLearnStatus(prev => ({ ...prev, [item.id]: 'searching' }))
    try {
      // Simulate progress through intermediate states
      await new Promise(resolve => setTimeout(resolve, 800))
      setLearnStatus(prev => ({ ...prev, [item.id]: 'validating' }))
      await new Promise(resolve => setTimeout(resolve, 800))
      setLearnStatus(prev => ({ ...prev, [item.id]: 'generating' }))

      const result = await window.api.invoke<{ id: string; confidence: number; sourceCount: number; error?: string }>(
        'knowledge:auto-learn',
        { topic: item.title, sourceConversation: item.sourceConversation, pendingId: item.id }
      )

      if (result && !result.error) {
        setLearnStatus(prev => ({ ...prev, [item.id]: 'done' }))
        setLearnResults(prev => ({ ...prev, [item.id]: { confidence: result.confidence, sourceCount: result.sourceCount } }))
        // Remove from pending
        setPendingItems(prev => prev.filter(p => p.id !== item.id))
        // Refresh doc list
        const refreshed = await window.api.invoke<KnowledgeStats | null>('knowledge:list')
        if (refreshed) {
          setDocs(refreshed.documents ?? [])
          setStats({ total: refreshed.totalVectors ?? 0, memories: 0, knowledge: refreshed.totalDocuments ?? 0 })
        }
      } else {
        setLearnStatus(prev => ({ ...prev, [item.id]: 'error' }))
      }
    } catch (e) {
      logger.error('[Knowledge] auto-learn error:', e)
      setLearnStatus(prev => ({ ...prev, [item.id]: 'error' }))
    }
  }

  /* ------ Ignore Pending ------ */
  const handleIgnorePending = async (item: PendingKnowledge) => {
    if (window.api) {
      try { await window.api.invoke('knowledge:ignore-pending', item.id) } catch (e) { logger.error('[Knowledge] ignore-pending error:', e); showToast('error', '操作失败，请稍后重试'); return }
    }
    setPendingItems(prev => prev.filter(p => p.id !== item.id))
  }

  /* ------ Search ------ */
  const handleSearch = useCallback(() => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    searchTimerRef.current = setTimeout(async () => {
      if (!searchQuery.trim()) {
        setIsSearching(false)
        return
      }
      setIsSearching(true)
      if (window.api) {
        try {
          const result = await window.api.invoke<any[]>('knowledge:search', searchQuery, 20)
          if (result) {
            setDocs(result.map((r: any) => ({
              id: r.id,
              title: r.text ?? r.title ?? r.metadata?.title ?? 'Untitled',
              type: r.type ?? r.metadata?.type ?? 'file',
              tags: r.tags ?? r.metadata?.tags ?? [],
              createdAt: r.createdAt ?? r.metadata?.createdAt ?? r.timestamp ?? r.metadata?.timestamp ?? Date.now(),
              source: r.source ?? r.metadata?.source ?? '',
              content: r.content ?? r.metadata?.content,
              score: r.score ?? r._score ?? r.metadata?.score,
            })))
          }
        } catch (e) {
          logger.error('[Knowledge] search error:', e)
          setDocs(prev => prev.filter(d => d.title.toLowerCase().includes(searchQuery.toLowerCase())))
        }
      } else {
        setDocs(prev => prev.filter(d => d.title.toLowerCase().includes(searchQuery.toLowerCase())))
      }
    }, 300)
  }, [searchQuery])

  /* ------ Handle Delete ------ */
  const handleDelete = async (id: string) => {
    if (isDeleting) return
    setIsDeleting(true)
    setSelectedDoc(null)
    if (window.api) {
      try {
        await window.api.invoke('knowledge:delete', id)
        setDocs(prev => prev.filter(d => d.id !== id))
      } catch (e) {
        logger.error('[Knowledge] delete error:', e)
        showToast('error', '删除知识失败，请稍后重试')
      }
    } else {
      setDocs(prev => prev.filter(d => d.id !== id))
    }
    setIsDeleting(false)
  }

  /* ------ Handle Add ------ */
  const handleAdd = async () => {
    if (!newDoc.title.trim() || isAdding) return
    setIsAdding(true)
    const tags = newDoc.tags.split(',').map(t => t.trim()).filter(Boolean)
    const id = Date.now().toString()
    const doc: KnowledgeDoc = {
      id,
      title: newDoc.title,
      type: 'file',
      tags,
      createdAt: Date.now(),
      source: 'manual',
      content: newDoc.content,
    }
    if (window.api) {
      try {
        await window.api.invoke('knowledge:add', doc.title, doc.content, tags)
      } catch (e) {
        logger.error('[Knowledge] upload error:', e)
        showToast('error', '添加知识失败，请稍后重试')
        setIsAdding(false)
        return
      }
    }
    setDocs(prev => [doc, ...prev])
    setNewDoc({ title: '', content: '', tags: '' })
    setShowAddModal(false)
    setIsAdding(false)
  }


  /* ------ Handle Update Doc ------ */
  const handleUpdateDoc = async () => {
    if (!selectedDoc) return
    const tags = editDocTags.split(',').map(t => t.trim()).filter(Boolean)
    const updated: KnowledgeDoc = {
      ...selectedDoc,
      title: editDocTitle.trim() || selectedDoc.title,
      content: editDocContent,
      tags,
      source: editDocSource.trim() || selectedDoc.source,
    }
    if (window.api) {
      try {
        await window.api.invoke('knowledge:update', selectedDoc.id, updated.title, updated.content, tags, updated.source)
      } catch (e) {
        logger.error('[Knowledge] update error:', e)
        showToast('error', '更新知识失败，请稍后重试')
        return
      }
    }
    setDocs(prev => prev.map(d => d.id === selectedDoc.id ? updated : d))
    setIsEditingDoc(false)
  }

  /* ------ Open Doc Detail (init edit fields) ------ */
  const openDocDetail = (doc: KnowledgeDoc) => {
    setSelectedDoc(doc)
    setIsEditingDoc(false)
    setEditDocTitle(doc.title)
    setEditDocContent(doc.content ?? '')
    setEditDocTags(doc.tags.join(', '))
    setEditDocSource(doc.source)
  }

  return (
    <ErrorBoundary>
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', background: COLORS.bg, padding: '20px', minHeight: 0, overflow: 'auto' }}>
      {loadError && (
        <ErrorDisplay
          {...({ error: loadError, onRetry: () => { setLoadError(null); loadDocs() }, variant: 'banner' } as any)}
        />
      )}
      <motion.div variants={containerVariants} initial="hidden" animate="visible" style={{ display: 'flex', flexDirection: 'column', gap: '20px', maxWidth: 1200, margin: '0 auto', width: '100%' }}>

        {/* Header */}
        <motion.div variants={itemVariants} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h2 style={{ fontFamily: 'var(--font-heading)', fontSize: 'var(--text-3xl)', fontWeight: 600, color: COLORS.textPrimary, margin: 0, letterSpacing: 'var(--tracking-tight)', lineHeight: 'var(--leading-tight)' }}>知识库</h2>
            <p style={{ fontSize: '0.85rem', color: COLORS.textMuted, margin: '4px 0 0' }}>
              管理你的知识文档，搜索并增强 RAG
            </p>
          </div>
          <motion.button
            whileHover={{ scale: 1.04 }} whileTap={{ scale: 0.96 }}
            onClick={() => setShowAddModal(true)}
            style={{
              display: 'flex', alignItems: 'center', gap: 8, padding: '10px 24px',
              borderRadius: 'var(--radius-2xl)', cursor: 'pointer', fontFamily: 'inherit',
              background: COLORS.accent, border: 'none', color: '#fff', fontSize: 13, fontWeight: 600,
            }}
          >
            <Upload size={15} /> {t('knowledge.addToBase')}
          </motion.button>
        </motion.div>

        {/* Stats Row */}
        <motion.div variants={itemVariants} style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16 }}>
          {([
            { icon: <FileText size={17} />, label: '文档数', value: docs.length.toLocaleString(), color: COLORS.accent },
            { icon: <Database size={17} />, label: '向量数', value: stats.total.toLocaleString(), color: COLORS.cyan },
            { icon: <Clock size={17} />, label: '最近更新', value: (stats as any).lastUpdated ? new Date((stats as any).lastUpdated).toLocaleDateString() : '暂无', color: COLORS.successAlt },
          ]).map(stat => (
            <motion.div
              key={stat.label}
              variants={statItemVariants}
              whileHover={{ borderColor: COLORS.cardBorderHover, boxShadow: 'var(--shadow-card-hover)' }}
              style={{
                background: COLORS.cardBg, border: '1px solid ' + COLORS.cardBorder,
                borderRadius: 'var(--radius-2xl)', padding: '18px 22px',
                display: 'flex', flexDirection: 'column', gap: 6,
                boxShadow: 'var(--shadow-card)',
                transition: 'all 0.35s cubic-bezier(0.4, 0, 0.2, 1)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ color: stat.color, display: 'flex' }}>{stat.icon}</span>
                <span style={{ fontSize: 12, color: COLORS.textSecondary }}>{stat.label}</span>
              </div>
              <span style={{ fontSize: 24, fontWeight: 600, color: COLORS.textPrimary, fontVariantNumeric: 'tabular-nums' }}>
                {stat.value}
              </span>
            </motion.div>
          ))}
        </motion.div>

        {/* Smart Organize */}
        <AnimatePresence>
          {pendingItems.length > 0 && (
            <motion.div
              variants={itemVariants}
              initial="hidden"
              animate="visible"
              exit="hidden"
              style={{
                background: COLORS.cardBg,
                border: `1px solid ${HEX_COLORS.accent}30`,
                borderRadius: 'var(--radius-2xl)',
                padding: '20px 24px',
                boxShadow: 'var(--shadow-card)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
                <BookOpen size={18} style={{ color: COLORS.accent }} />
                <span style={{ fontSize: 14, fontWeight: 600, color: COLORS.textPrimary }}>
                  玄枢检测到 {pendingItems.length} 个待学习知识点
                </span>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {pendingItems.map((item) => {
                  const status = learnStatus[item.id] || 'idle'
                  const result = learnResults[item.id]
                  return (
                    <div
                      key={item.id}
                      style={{
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                        padding: '12px 16px', borderRadius: 'var(--radius-lg)',
                        background: 'rgba(0,0,0,0.15)',
                        border: `1px solid ${COLORS.cardBorder}`,
                        gap: 16,
                      }}
                    >
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontSize: 13, fontWeight: 500, color: COLORS.textPrimary, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {item.title}
                        </div>
                        <div style={{ fontSize: 11, color: COLORS.textMuted, marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          来源：{item.sourceConversation}
                        </div>
                      </div>

                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                        {status === 'done' && result && (
                          <span style={{ fontSize: 11, color: COLORS.success, display: 'flex', alignItems: 'center', gap: 4 }}>
                            <CheckCircle2 size={13} />
                            {result.confidence ? `${(result.confidence * 100).toFixed(0)}% 置信度` : '完成'}
                          </span>
                        )}
                        {status === 'error' && (
                          <span style={{ fontSize: 11, color: COLORS.danger, display: 'flex', alignItems: 'center', gap: 4 }}>
                            <AlertCircle size={13} /> 失败
                          </span>
                        )}
                        {(status === 'searching' || status === 'validating' || status === 'generating') && (
                          <AnimatePresence mode="wait">
                            <motion.span
                              key={status}
                              initial={{ opacity: 0, x: -8 }}
                              animate={{ opacity: 1, x: 0 }}
                              exit={{ opacity: 0, x: 8 }}
                              transition={{ duration: 0.25 }}
                              style={{ fontSize: 11, color: COLORS.accent, display: 'flex', alignItems: 'center', gap: 4 }}
                            >
                              <motion.span
                                animate={{ rotate: 360 }}
                                transition={{ repeat: Infinity, duration: 1, ease: 'linear' }}
                                style={{ display: 'flex' }}
                              >
                                <Loader2 size={13} />
                              </motion.span>
                              {status === 'searching' ? '搜集资料中...' : status === 'validating' ? '交叉验证中...' : '生成知识包...'}
                            </motion.span>
                          </AnimatePresence>
                        )}

                        {status === 'idle' && (
                          <>
                            <motion.button
                              whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }}
                              onClick={() => handleAutoLearn(item)}
                              style={{
                                display: 'flex', alignItems: 'center', gap: 4,
                                padding: '7px 16px', borderRadius: 'var(--radius-lg)',
                                cursor: 'pointer', fontFamily: 'inherit',
                                background: COLORS.accent, border: 'none',
                                color: '#fff', fontSize: 12, fontWeight: 500,
                              }}
                            >
                              <Sparkles size={13} /> 学习
                            </motion.button>
                            <motion.button
                              whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }}
                              onClick={() => handleIgnorePending(item)}
                              style={{
                                padding: '7px 14px', borderRadius: 'var(--radius-lg)',
                                cursor: 'pointer', fontFamily: 'inherit',
                                background: 'transparent', border: `1px solid ${COLORS.cardBorder}`,
                                color: COLORS.textSecondary, fontSize: 12, fontWeight: 500,
                              }}
                            >
                              忽略
                            </motion.button>
                          </>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Search Bar */}
        <motion.div variants={itemVariants} style={{ display: 'flex', gap: 12 }}>
          <div style={{ flex: 1, position: 'relative' }}>
            <Search size={17} style={{ position: 'absolute', left: 16, top: '50%', transform: 'translateY(-50%)', color: COLORS.textMuted }} />
            <input
              value={searchQuery}
              onChange={(e) => { setSearchQuery(e.target.value); handleSearch() }}
              onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
              placeholder="搜索知识库..."
              style={{
                width: '100%', padding: '12px 16px 12px 44px', borderRadius: 'var(--radius-lg)',
                border: '1px solid ' + COLORS.cardBorder, background: COLORS.cardBg,
                color: COLORS.textPrimary, fontSize: 13, outline: 'none',
                boxSizing: 'border-box', fontFamily: 'inherit',
                resize: 'none',
              }}
            />
          </div>
          <motion.button
            whileHover={{ scale: 1.04 }} whileTap={{ scale: 0.96 }}
            onClick={handleSearch}
            style={{
              padding: '10px 20px', borderRadius: 'var(--radius-lg)', cursor: 'pointer', fontFamily: 'inherit',
              background: COLORS.accent, border: 'none', color: '#fff', fontSize: 13, fontWeight: 500,
              display: 'flex', alignItems: 'center', gap: 6,
            }}
          >
            <Search size={15} /> 搜索
          </motion.button>
          {isSearching && (
            <motion.button
              whileHover={{ scale: 1.04 }} whileTap={{ scale: 0.96 }}
              onClick={() => { setSearchQuery(''); setIsSearching(false); }}
              style={{
                padding: '10px 16px', borderRadius: 'var(--radius-lg)', cursor: 'pointer', fontFamily: 'inherit',
                background: 'transparent', border: '1px solid ' + COLORS.cardBorder,
                color: COLORS.textSecondary, fontSize: 13, fontWeight: 500,
                display: 'flex', alignItems: 'center', gap: 6,
              }}
            >
              <X size={15} /> 清除
            </motion.button>
          )}
        </motion.div>

        {/* Document List */}
        <motion.div variants={itemVariants}>
          <h3 style={{ fontSize: '1rem', fontWeight: 600, color: COLORS.textPrimary, margin: '0 0 14px' }}>
            {isSearching ? '搜索结果' : '已导入文档'}
          </h3>

          {docs.length === 0 && (
            <motion.div
              initial={{ opacity: 0, y: 24 }}
              animate={{ opacity: 1, y: 0 }}
              style={{
                background: COLORS.cardBg, border: '1px solid ' + COLORS.cardBorder,
                borderRadius: 'var(--radius-2xl)', padding: '28px', textAlign: 'center',
                boxShadow: 'var(--shadow-card)',
              }}
            >
              <Search size={32} style={{ color: COLORS.textMuted, opacity: 0.4 }} />
              <p style={{ color: COLORS.textSecondary, marginTop: 12 }}>未找到文档。添加知识以增强 RAG。</p>
              <p style={{ color: COLORS.textMuted, fontSize: 12, marginTop: 4 }}>
                点击「添加知识」或导入文件/文件夹开始使用
              </p>
            </motion.div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <AnimatePresence>
              {docs.map((doc, _i) => (
                <motion.div
                  key={doc.id}
                  variants={listItemVariants}
                  initial="hidden"
                  animate="visible"
                  exit={{ opacity: 0, x: -20, transition: { duration: 0.2 } }}
                  layout
                  whileHover={{ borderColor: COLORS.cardBorderHover, boxShadow: 'var(--shadow-card-hover)' }}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '14px 20px', borderRadius: 'var(--radius-2xl)',
                    background: COLORS.cardBg,
                    border: '1px solid ' + COLORS.cardBorder,
                    boxShadow: 'var(--shadow-card)',
                    cursor: 'pointer',
                    gap: 16,
                    transition: 'all 0.35s cubic-bezier(0.4, 0, 0.2, 1)',
                  }}
                  onClick={() => openDocDetail(doc)}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
                    <span style={{ display: 'flex', color: doc.type === 'folder' ? COLORS.warning : doc.type === 'web' ? COLORS.cyan : COLORS.accent2 }}>
                      {doc.type === 'folder' ? <Folder size={17} /> : doc.type === 'web' ? <Globe size={17} /> : <FileText size={17} />}
                    </span>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 500, color: COLORS.textPrimary, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{doc.title}</div>
                      <div style={{ display: 'flex', gap: 6, marginTop: 3, flexWrap: 'wrap' }}>
                        {doc.tags.map((tag, j) => {
                          const [tc, bg] = getTagColor(j)
                          return (
                            <span key={j} style={{
                              fontSize: 10, padding: '2px 8px', borderRadius: 9999,
                              background: bg, color: tc,
                              whiteSpace: 'nowrap',
                            }}>{tag}</span>
                          )
                        })}
                      </div>
                    </div>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
                    {doc.score !== undefined && (
                      <span style={{ fontSize: 11, color: COLORS.textMuted, fontVariantNumeric: 'tabular-nums' }}>
                        相关度：{(doc.score * 100).toFixed(0)}%
                      </span>
                    )}
                    <span style={{ fontSize: 11, color: COLORS.textMuted, fontVariantNumeric: 'tabular-nums' }}>
                      {new Date(doc.createdAt).toLocaleDateString()}
                    </span>
                    <motion.button
                      whileHover={{ scale: 1.15 }}
                      whileTap={{ scale: 0.9 }}
                      onClick={(e) => { e.stopPropagation(); openDocDetail(doc); }}
                      style={{
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        width: 30, height: 30, borderRadius: 10,
                        background: 'transparent', border: 'none', cursor: 'pointer',
                        color: COLORS.textMuted,
                      }}
                    >
                      <Eye size={15} />
                    </motion.button>
                  </div>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        </motion.div>

      </motion.div>

      {/* 添加知识 Modal */}
      <AnimatePresence>
        {showAddModal && (
          <FocusTrap active={!!showAddModal}>
          <motion.div
            initial="hidden"
            animate="visible"
            exit="hidden"
            variants={containerVariants}
            style={{
              position: 'fixed', inset: 0, zIndex: 9999,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              ...overlayStyle,
            }}
          >
            <motion.div
              variants={itemVariants}
              style={{
                background: COLORS.cardBg, borderRadius: 'var(--radius-2xl)', padding: '28px 32px',
                border: '1px solid ' + COLORS.cardBorder,
                maxWidth: 480, width: '90%',
                display: 'flex', flexDirection: 'column', gap: 16,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h3 style={{ color: COLORS.textPrimary, fontSize: 16, fontWeight: 600, margin: 0 }}>添加知识</h3>
                <motion.button
                  whileHover={{ scale: 1.1 }} whileTap={{ scale: 0.9 }}
                  onClick={() => setShowAddModal(false)}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    width: 30, height: 30, borderRadius: 10,
                    background: 'transparent', border: 'none', cursor: 'pointer',
                    color: COLORS.textMuted,
                  }}
                >
                  <X size={18} />
                </motion.button>
              </div>

              {/* Title */}
              <div>
                <label style={{ display: 'block', fontSize: 12, color: COLORS.textSecondary, marginBottom: 6 }}>标题</label>
                <input
                  value={newDoc.title}
                  onChange={(e) => setNewDoc(prev => ({ ...prev, title: e.target.value }))}
                  placeholder="输入知识标题..."
                  style={{
                    width: '100%', padding: '10px 14px', borderRadius: 'var(--radius-lg)',
                    border: '1px solid ' + COLORS.cardBorder, background: 'rgba(0,0,0,0.25)',
                    color: COLORS.textPrimary, fontSize: 13, outline: 'none',
                    boxSizing: 'border-box', fontFamily: 'inherit',
                    resize: 'none',
                  }}
                />
              </div>

              {/* Content */}
              <div>
                <label style={{ display: 'block', fontSize: 12, color: COLORS.textSecondary, marginBottom: 6 }}>内容</label>
                <textarea
                  value={newDoc.content}
                  onChange={(e) => setNewDoc(prev => ({ ...prev, content: e.target.value }))}
                  placeholder="输入知识内容..."
                  rows={5}
                  style={{
                    width: '100%', padding: '10px 14px', borderRadius: 'var(--radius-lg)',
                    border: '1px solid ' + COLORS.cardBorder, background: 'rgba(0,0,0,0.25)',
                    color: COLORS.textPrimary, fontSize: 13, outline: 'none',
                    boxSizing: 'border-box', fontFamily: 'inherit',
                    lineHeight: 1.65, resize: 'vertical',
                  }}
                />
              </div>

              {/* 标签 */}
              <div>
                <label style={{ display: 'block', fontSize: 12, color: COLORS.textSecondary, marginBottom: 6 }}>标签（逗号分隔）</label>
                <input
                  value={newDoc.tags}
                  onChange={(e) => setNewDoc(prev => ({ ...prev, tags: e.target.value }))}
                  placeholder="研究, 机器学习, 论文"
                  style={{
                    width: '100%', padding: '10px 14px', borderRadius: 'var(--radius-lg)',
                    border: '1px solid ' + COLORS.cardBorder, background: 'rgba(0,0,0,0.25)',
                    color: COLORS.textPrimary, fontSize: 13, outline: 'none',
                    boxSizing: 'border-box', fontFamily: 'inherit',
                  }}
                />
              </div>

              {/* Buttons */}
              <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end', marginTop: 4 }}>
                <motion.button
                  whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }}
                  onClick={() => setShowAddModal(false)}
                  style={{
                    padding: '10px 20px', borderRadius: 'var(--radius-lg)', cursor: 'pointer', fontFamily: 'inherit',
                    background: 'transparent', border: '1px solid ' + COLORS.cardBorder,
                    color: COLORS.textSecondary, fontSize: 13, fontWeight: 500,
                  }}
                >
                  取消
                </motion.button>
                <motion.button
                  whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }}
                  onClick={handleAdd}
                  style={{
                    padding: '10px 24px', borderRadius: 'var(--radius-lg)', cursor: 'pointer', fontFamily: 'inherit',
                    background: COLORS.accent, border: 'none', color: '#fff', fontSize: 13, fontWeight: 600,
                  }}
                >
                  添加
                </motion.button>
              </div>
            </motion.div>
          </motion.div>
          </FocusTrap>
        )}
      </AnimatePresence>

      {/* Detail Modal */}
      <AnimatePresence>
        {selectedDoc && (
          <FocusTrap active={!!selectedDoc}>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            style={{
              position: 'fixed', inset: 0, zIndex: 9999,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              ...overlayStyle,
            }}
            onClick={() => { setIsEditingDoc(false); setSelectedDoc(null) }}
          >
            <motion.div
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              onClick={(e) => e.stopPropagation()}
              style={{
                background: COLORS.cardBg, borderRadius: 'var(--radius-2xl)', padding: '28px 32px',
                border: '1px solid ' + COLORS.cardBorder,
                maxWidth: 600, width: '90%', maxHeight: '80vh', overflow: 'auto',
                display: 'flex', flexDirection: 'column', gap: 16,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h3 style={{ color: COLORS.textPrimary, fontSize: 16, fontWeight: 600, margin: 0 }}>
                  {isEditingDoc ? '编辑知识' : '知识详情'}
                </h3>
                <button
                  onClick={() => { setIsEditingDoc(false); setSelectedDoc(null) }}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    width: 30, height: 30, borderRadius: 10,
                    background: 'transparent', border: 'none', cursor: 'pointer',
                    color: COLORS.textMuted,
                  }}
                >
                  <X size={18} />
                </button>
              </div>

              {/* Title */}
              <div>
                <label style={{ display: 'block', fontSize: 12, color: COLORS.textSecondary, marginBottom: 6 }}>标题</label>
                {isEditingDoc ? (
                  <input
                    value={editDocTitle}
                    onChange={(e) => setEditDocTitle(e.target.value)}
                    style={{
                      width: '100%', padding: '10px 14px', borderRadius: 'var(--radius-lg)',
                      border: '1px solid ' + COLORS.cardBorder, background: 'rgba(0,0,0,0.25)',
                      color: COLORS.textPrimary, fontSize: 13, outline: 'none',
                      boxSizing: 'border-box', fontFamily: 'inherit',
                    }}
                  />
                ) : (
                  <p style={{ color: COLORS.textPrimary, margin: '4px 0 0', fontSize: 14 }}>{selectedDoc.title}</p>
                )}
              </div>

              {/* Content */}
              <div>
                <label style={{ display: 'block', fontSize: 12, color: COLORS.textSecondary, marginBottom: 6 }}>内容</label>
                {isEditingDoc ? (
                  <textarea
                    value={editDocContent}
                    onChange={(e) => setEditDocContent(e.target.value)}
                    rows={5}
                    style={{
                      width: '100%', padding: '10px 14px', borderRadius: 'var(--radius-lg)',
                      border: '1px solid ' + COLORS.cardBorder, background: 'rgba(0,0,0,0.25)',
                      color: COLORS.textPrimary, fontSize: 13, outline: 'none',
                      boxSizing: 'border-box', fontFamily: 'inherit',
                      lineHeight: 1.65, resize: 'vertical',
                    }}
                  />
                ) : (
                  <p style={{ color: COLORS.textSecondary, margin: '4px 0 0', fontSize: 13, lineHeight: 1.65, whiteSpace: 'pre-wrap' }}>
                    {selectedDoc.content || '（无内容）'}
                  </p>
                )}
              </div>

              {/* Tags */}
              <div>
                <label style={{ display: 'block', fontSize: 12, color: COLORS.textSecondary, marginBottom: 6 }}>标签（逗号分隔）</label>
                {isEditingDoc ? (
                  <input
                    value={editDocTags}
                    onChange={(e) => setEditDocTags(e.target.value)}
                    placeholder="研究, 机器学习, 论文"
                    style={{
                      width: '100%', padding: '10px 14px', borderRadius: 'var(--radius-lg)',
                      border: '1px solid ' + COLORS.cardBorder, background: 'rgba(0,0,0,0.25)',
                      color: COLORS.textPrimary, fontSize: 13, outline: 'none',
                      boxSizing: 'border-box', fontFamily: 'inherit',
                    }}
                  />
                ) : (
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {selectedDoc.tags.map((tag, j) => {
                      const [tc, bg] = getTagColor(j)
                      return (
                        <span key={j} style={{
                          fontSize: 11, padding: '4px 12px', borderRadius: 9999,
                          background: bg, color: tc,
                        }}>{tag}</span>
                      )
                    })}
                  </div>
                )}
              </div>

              {/* Source + Type + Created */}
              <div style={{ display: 'flex', gap: 32, flexWrap: 'wrap' }}>
                <div>
                  <label style={{ fontSize: 12, color: COLORS.textSecondary }}>类型</label>
                  <p style={{ color: COLORS.textPrimary, margin: '4px 0 0' }}>{selectedDoc.type}</p>
                </div>
                <div>
                  <label style={{ fontSize: 12, color: COLORS.textSecondary }}>来源</label>
                  {isEditingDoc ? (
                    <input
                      value={editDocSource}
                      onChange={(e) => setEditDocSource(e.target.value)}
                      style={{
                        width: 160, padding: '6px 10px', borderRadius: 'var(--radius-lg)',
                        border: '1px solid ' + COLORS.cardBorder, background: 'rgba(0,0,0,0.25)',
                        color: COLORS.textPrimary, fontSize: 12, outline: 'none',
                        boxSizing: 'border-box', fontFamily: 'inherit',
                      }}
                    />
                  ) : (
                    <p style={{ color: COLORS.textPrimary, margin: '4px 0 0' }}>{selectedDoc.source || '-'}</p>
                  )}
                </div>
                <div>
                  <label style={{ fontSize: 12, color: COLORS.textSecondary }}>创建时间</label>
                  <p style={{ color: COLORS.textPrimary, margin: '4px 0 0' }}>
                    {new Date(selectedDoc.createdAt).toLocaleString()}
                  </p>
                </div>
              </div>

              {/* Learning Status */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 12, color: COLORS.textSecondary }}>学习状态：</span>
                <span style={{
                  fontSize: 11, padding: '4px 12px', borderRadius: 9999,
                  background: selectedDoc.content ? `${HEX_COLORS.accent}15` : `${HEX_COLORS.textMuted}15`,
                  color: selectedDoc.content ? COLORS.accent : COLORS.textMuted,
                  border: selectedDoc.content ? `1px solid ${HEX_COLORS.accent}30` : `1px solid ${HEX_COLORS.textMuted}30`,
                }}>
                  {selectedDoc.content ? '已索引' : '待索引'}
                </span>
              </div>

              {/* Action Buttons */}
              <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end', marginTop: 4 }}>
                {isEditingDoc ? (
                  <>
                    <motion.button
                      whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }}
                      onClick={() => setIsEditingDoc(false)}
                      style={{
                        padding: '10px 20px', borderRadius: 'var(--radius-lg)', cursor: 'pointer', fontFamily: 'inherit',
                        background: 'transparent', border: '1px solid ' + COLORS.cardBorder,
                        color: COLORS.textSecondary, fontSize: 13, fontWeight: 500,
                      }}
                    >
                      取消
                    </motion.button>
                    <motion.button
                      whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }}
                      onClick={handleUpdateDoc}
                      style={{
                        padding: '10px 24px', borderRadius: 'var(--radius-lg)', cursor: 'pointer', fontFamily: 'inherit',
                        background: COLORS.accent, border: 'none', color: '#fff', fontSize: 13, fontWeight: 600,
                      }}
                    >
                      保存
                    </motion.button>
                  </>
                ) : (
                  <>
                    <motion.button
                      whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }}
                      onClick={() => handleDelete(selectedDoc.id)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 6,
                        padding: '10px 20px', borderRadius: 'var(--radius-lg)', cursor: 'pointer', fontFamily: 'inherit',
                        background: `${HEX_COLORS.danger}15`, border: `1px solid ${HEX_COLORS.danger}30`,
                        color: COLORS.danger, fontSize: 13, fontWeight: 500,
                      }}
                    >
                      <Trash2 size={14} /> 删除
                    </motion.button>
                    <motion.button
                      whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }}
                      onClick={() => setIsEditingDoc(true)}
                      style={{
                        padding: '10px 24px', borderRadius: 'var(--radius-lg)', cursor: 'pointer', fontFamily: 'inherit',
                        background: COLORS.accent, border: 'none', color: '#fff', fontSize: 13, fontWeight: 600,
                      }}
                    >
                      编辑
                    </motion.button>
                  </>
                )}
              </div>
            </motion.div>
          </motion.div>
          </FocusTrap>
        )}
      </AnimatePresence>
    </div>
    </ErrorBoundary>
  )
}
