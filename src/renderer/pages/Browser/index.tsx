import { useCallback, useEffect, useRef } from 'react'
import { motion } from 'framer-motion'
import {
  ArrowLeft, ArrowRight, RotateCw, Plus, Star, StarOff, Globe, X, Bookmark as BookmarkIcon,
} from 'lucide-react'
import { COLORS, HEX_COLORS } from '../../shared/theme'
import ErrorBoundary from '../../components/ErrorBoundary'
import { useBrowserStore } from '../../store/browserStore'

function Browser() {
  const tabs = useBrowserStore((s) => s.tabs)
  const activeTabId = useBrowserStore((s) => s.activeTabId)
  const bookmarks = useBrowserStore((s) => s.bookmarks)
  const urlInput = useBrowserStore((s) => s.urlInput)
  const setTabs = useBrowserStore((s) => s.setTabs)
  const setUrlInput = useBrowserStore((s) => s.setUrlInput)
  const createTab = useBrowserStore((s) => s.createTab)
  const closeTab = useBrowserStore((s) => s.closeTab)
  const switchTab = useBrowserStore((s) => s.switchTab)
  const navigate = useBrowserStore((s) => s.navigate)
  const goBack = useBrowserStore((s) => s.goBack)
  const goForward = useBrowserStore((s) => s.goForward)
  const reload = useBrowserStore((s) => s.reload)
  const loadTabs = useBrowserStore((s) => s.loadTabs)
  const loadBookmarks = useBrowserStore((s) => s.loadBookmarks)
  const addBookmark = useBrowserStore((s) => s.addBookmark)
  const removeBookmark = useBrowserStore((s) => s.removeBookmark)

  const contentRef = useRef<HTMLDivElement | null>(null)

  // 上报内容区 bounds（主进程据此定位 WebContentsView）
  const reportBounds = useCallback(() => {
    const el = contentRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    ;(window as any).api?.invoke?.('browser:set-bounds', {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    })
  }, [])

  useEffect(() => {
    void loadTabs()
    void loadBookmarks()
  }, [loadTabs, loadBookmarks])

  // 首次挂载若无标签则创建一个
  useEffect(() => {
    const timer = setTimeout(() => {
      if (tabs.length === 0) void createTab()
    }, 100)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 订阅 browser:event（主进程导航/加载状态变化）
  useEffect(() => {
    const win = window as any
    if (!win.api?.on) return
    const unsub = win.api.on('browser:event', (payload: { tabs: unknown[]; activeTabId: string | null }) => {
      if (payload?.tabs) {
        setTabs(payload.tabs as never, payload.activeTabId || null)
      }
    })
    return () => unsub?.()
  }, [setTabs])

  // 监听容器尺寸变化，持续上报 bounds
  useEffect(() => {
    const el = contentRef.current
    if (!el) return
    reportBounds()
    const ro = new ResizeObserver(() => reportBounds())
    ro.observe(el)
    return () => ro.disconnect()
  }, [reportBounds])

  const active = tabs.find((t) => t.id === activeTabId)
  const isBookmarked = !!active && bookmarks.some((b) => b.url === active.url)

  const handleNavigate = () => {
    if (urlInput.trim()) void navigate(urlInput.trim())
  }

  return (
    <ErrorBoundary>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, backgroundColor: COLORS.bg }}>
        {/* 工具栏 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 16px', borderBottom: `1px solid ${COLORS.cardBorder}` }}>
          <IconBtn onClick={goBack} disabled={!active?.canGoBack} title="后退"><ArrowLeft size={16} /></IconBtn>
          <IconBtn onClick={goForward} disabled={!active?.canGoForward} title="前进"><ArrowRight size={16} /></IconBtn>
          <IconBtn onClick={reload} title="刷新"><RotateCw size={15} /></IconBtn>

          <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', borderRadius: 'var(--radius-lg)', background: 'rgba(255,255,255,0.04)', border: `1px solid ${COLORS.cardBorder}` }}>
            <Globe size={14} style={{ color: COLORS.textMuted, flexShrink: 0 }} />
            <input
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleNavigate() }}
              placeholder="输入网址或搜索…"
              style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: COLORS.textPrimary, fontSize: 13 }}
            />
          </div>

          <IconBtn onClick={() => { if (active) { isBookmarked ? removeBookmark(active.url) : addBookmark(active.url, active.title) } }} title={isBookmarked ? '取消书签' : '加入书签'}>
            {isBookmarked ? <Star size={16} style={{ color: COLORS.warning }} /> : <StarOff size={16} />}
          </IconBtn>
          <motion.button whileHover={{ scale: 1.04 }} whileTap={{ scale: 0.96 }} onClick={() => createTab()}
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 14px', borderRadius: 'var(--radius-lg)', background: COLORS.accent, border: 'none', color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
            <Plus size={14} /> 新标签
          </motion.button>
        </div>

        {/* 标签栏 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '6px 12px 0', overflowX: 'auto', borderBottom: `1px solid ${COLORS.cardBorder}` }}>
          {tabs.map((t) => {
            const isActive = t.id === activeTabId
            return (
              <div key={t.id} onClick={() => switchTab(t.id)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, maxWidth: 200,
                  padding: '8px 12px', borderRadius: 'var(--radius-md) 8px 0 0', cursor: 'pointer',
                  background: isActive ? COLORS.cardBg : 'transparent',
                  border: `1px solid ${isActive ? COLORS.cardBorder : 'transparent'}`,
                  borderBottom: isActive ? 'none' : `1px solid ${COLORS.cardBorder}`,
                  color: isActive ? COLORS.textPrimary : COLORS.textMuted, fontSize: 12, whiteSpace: 'nowrap',
                }}>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 150 }}>
                  {t.loading ? '加载中…' : t.title || t.url || '新标签页'}
                </span>
                <button onClick={(e) => { e.stopPropagation(); closeTab(t.id) }}
                  style={{ background: 'transparent', border: 'none', color: COLORS.textMuted, cursor: 'pointer', padding: 0, display: 'flex' }}>
                  <X size={13} />
                </button>
              </div>
            )
          })}
        </div>

        {/* 书签栏 */}
        {bookmarks.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 16px', overflowX: 'auto', borderBottom: `1px solid ${COLORS.cardBorder}` }}>
            <BookmarkIcon size={13} style={{ color: COLORS.textMuted }} />
            {bookmarks.slice(0, 12).map((b) => (
              <span key={b.url} onClick={() => navigate(b.url)}
                style={{ padding: '3px 10px', borderRadius: '9999px', background: 'rgba(255,255,255,0.03)', border: `1px solid ${COLORS.cardBorder}`, color: COLORS.textSecondary, fontSize: 11, cursor: 'pointer', whiteSpace: 'nowrap' }}>
                {b.title || b.url}
              </span>
            ))}
          </div>
        )}

        {/* 内容区（WebContentsView 覆盖在此之上） */}
        <div ref={contentRef} style={{ flex: 1, minHeight: 0, position: 'relative', background: 'rgba(255,255,255,0.02)' }} />

        {tabs.length === 0 && (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: COLORS.textMuted }}>
            <Globe size={40} style={{ opacity: 0.3, marginBottom: 12 }} />
            <div style={{ fontSize: 14 }}>内置浏览器</div>
          </div>
        )}
      </div>
    </ErrorBoundary>
  )
}

function IconBtn({ children, onClick, disabled, title }: { children: React.ReactNode; onClick: () => void; disabled?: boolean; title?: string }) {
  return (
    <button
      onClick={onClick} disabled={disabled} title={title}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 32,
        borderRadius: 'var(--radius-md)', background: 'transparent', border: 'none',
        color: disabled ? HEX_COLORS.textMuted : COLORS.textSecondary, cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.4 : 1,
      }}
      onMouseEnter={(e) => { if (!disabled) e.currentTarget.style.background = 'rgba(255,255,255,0.06)' }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
    >
      {children}
    </button>
  )
}

export default Browser
