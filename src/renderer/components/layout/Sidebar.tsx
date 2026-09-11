import { useState, useCallback, useEffect, useRef } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { motion } from 'framer-motion'
import {
  MessageSquare, Settings, Brain, BookOpen,
  Zap, Monitor, ChevronLeft, ChevronRight, Wrench, Bot, Layers,
} from 'lucide-react'
import { useTranslation } from '../../i18n'

interface NavItem {
  id: string
  labelKey: string
  icon: React.ReactNode
  path: string
}

interface NavSection {
  labelKey: string
  items: Array<NavItem>
}

const NAV_SECTIONS: Array<NavSection> = [
  {
    labelKey: 'sidebar.section.features',
    items: [
      { id: 'home', labelKey: 'sidebar.home', icon: <MessageSquare size={18} />, path: '/' },
    ],
  },
  {
    labelKey: 'sidebar.section.system',
    items: [
      { id: 'model', labelKey: 'sidebar.model', icon: <Monitor size={18} />, path: '/model' },
      { id: 'memory', labelKey: 'sidebar.memory', icon: <Brain size={18} />, path: '/memory' },
      { id: 'knowledge', labelKey: 'sidebar.knowledge', icon: <BookOpen size={18} />, path: '/knowledge' },
      { id: 'automation', labelKey: 'sidebar.automation', icon: <Zap size={18} />, path: '/automation' },
      { id: 'selfmodify', labelKey: 'sidebar.selfModify', icon: <Wrench size={18} />, path: '/self-modify' },
      { id: 'agents', labelKey: 'sidebar.agents', icon: <Bot size={18} />, path: '/agents' },
      { id: 'softwareLibrary', labelKey: 'sidebar.softwareLibrary', icon: <Layers size={18} />, path: '/software' },
    ],
  },
]

function Sidebar() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const location = useLocation()
  // 折叠状态持久化（发布整改第一批）：初始值读取 localStorage，保持用户上次的折叠选择
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem('xuanshu:sidebarCollapsed') === '1' } catch { return false }
  })
  const [locked, setLocked] = useState(false)
  const [activeId, setActiveId] = useState('home')
  const targetPathRef = useRef<string | null>(null)

  useEffect(() => {
    try { localStorage.setItem('xuanshu:sidebarCollapsed', collapsed ? '1' : '0') } catch { /* 存储不可用则忽略 */ }
  }, [collapsed])

  useEffect(() => {
    for (const section of NAV_SECTIONS) {
      const item = section.items.find(i => i.path === location.pathname)
      if (item) { setActiveId(item.id); return }
    }
    if (location.pathname === '/settings') {setActiveId('settings')}
  }, [location.pathname])

  useEffect(() => {
    if (targetPathRef.current && location.pathname === targetPathRef.current) {
      setLocked(false)
      targetPathRef.current = null
    }
  }, [location.pathname])

  const handleNav = useCallback((item: NavItem) => {
    if (locked) {return}
    setLocked(true)
    setActiveId(item.id)
    if (location.pathname === item.path) {
      setLocked(false)
      return
    }
    targetPathRef.current = item.path
    navigate(item.path)
  }, [navigate, locked, location.pathname])

  // v3 仿Trae：侧栏收窄弱化（宽度与 globals --sidebar-* 对齐）
  const currentWidth = collapsed ? 56 : 220

  return (
    <motion.div
      className="app-sidebar"
      animate={{ width: currentWidth }}
      transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
      style={{
        background: 'var(--bg-surface)',
        borderRight: '1px solid var(--border-subtle)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      {/* Logo Area */}
      <div style={{
        height: 40, display: 'flex', alignItems: 'center',
        padding: '0 14px', gap: 10, flexShrink: 0,
      }}>
        {!collapsed && (
          <motion.span
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text-primary)', letterSpacing: '0.02em' }}
          >
            {t('common.appName')}
          </motion.span>
        )}
      </div>

      {/* Navigation */}
      <nav aria-label={t('accessibility.mainNavigation')} style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', padding: '4px 8px' }}>
        {NAV_SECTIONS.map((section) => (
          <div key={section.labelKey} style={{ marginBottom: 4 }}>
            {!collapsed && (
              <div style={{
                fontSize: 10, fontWeight: 500, color: 'var(--text-disabled)',
                padding: '8px 12px 4px', letterSpacing: '0.06em', textTransform: 'uppercase',
              }}>
                {t(section.labelKey)}
              </div>
            )}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
              {section.items.map((item) => {
                const isActive = activeId === item.id
                const label = t(item.labelKey)
                return (
                  <motion.button
                    key={item.id}
                    whileTap={{ scale: 0.97 }}
                    onClick={() => handleNav(item)}
                    title={collapsed ? label : undefined}
                    aria-label={label}
                    aria-current={isActive ? 'page' : undefined}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      height: 34,
                      padding: collapsed ? '0' : '0 12px',
                      borderRadius: 'var(--radius-md)',
                      // v3 仿Trae：激活态不用底色/描边，改用左侧蓝色指示条
                      background: 'transparent',
                      color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
                      fontSize: 13,
                      fontWeight: isActive ? 500 : 400,
                      transition: 'background 150ms ease, color 150ms ease',
                      justifyContent: collapsed ? 'center' : 'flex-start',
                      width: '100%',
                      position: 'relative',
                      border: '1px solid transparent',
                      whiteSpace: 'nowrap',
                    }}
                    onMouseEnter={(e) => {
                      if (!isActive) {
                        e.currentTarget.style.background = 'var(--bg-hover)'
                        e.currentTarget.style.color = 'var(--text-primary)'
                      }
                    }}
                    onMouseLeave={(e) => {
                      if (!isActive) {
                        e.currentTarget.style.background = 'transparent'
                        e.currentTarget.style.color = 'var(--text-secondary)'
                      }
                    }}
                  >
                    {isActive && (
                      <span aria-hidden style={{
                        position: 'absolute', left: 2, top: '50%', transform: 'translateY(-50%)',
                        width: 2, height: 16, borderRadius: 1, background: 'var(--status-running)',
                      }} />
                    )}
                    <span style={{ flexShrink: 0, display: 'flex', opacity: isActive ? 1 : 0.82 }}>{item.icon}</span>
                    {!collapsed && (
                      <motion.span
                        initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                        className="truncate"
                      >
                        {label}
                      </motion.span>
                    )}
                  </motion.button>
                )
              })}
            </div>
          </div>
        ))}
      </nav>

      {/* Bottom: Collapse Toggle + Settings */}
      <div style={{ padding: '8px', borderTop: '1px solid var(--border-subtle)' }}>
        <motion.button
          whileTap={{ scale: 0.95 }}
          onClick={() => setCollapsed(!collapsed)}
          aria-label={collapsed ? t('accessibility.expandMenu') : t('accessibility.collapseMenu')}
          style={{
            width: '100%', height: 32, display: 'flex', alignItems: 'center',
            justifyContent: 'center', borderRadius: 'var(--radius-md)',
            color: 'var(--text-tertiary)', transition: 'all 150ms',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)'; e.currentTarget.style.color = 'var(--text-secondary)' }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-tertiary)' }}
        >
          {collapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
        </motion.button>

        <motion.button
          whileTap={{ scale: 0.97 }}
          onClick={() => handleNav({ id: 'settings', labelKey: 'sidebar.settings', icon: <Settings size={18} />, path: '/settings' })}
          title={collapsed ? t('sidebar.settings') : undefined}
          aria-label={t('sidebar.settings')}
          style={{
            width: '100%', height: 34, display: 'flex', alignItems: 'center',
            gap: 10, padding: collapsed ? '0' : '0 12px',
            borderRadius: 'var(--radius-md)',
            justifyContent: collapsed ? 'center' : 'flex-start',
            color: activeId === 'settings' ? 'var(--text-primary)' : 'var(--text-secondary)',
            background: 'transparent',
            fontSize: 13, fontWeight: activeId === 'settings' ? 500 : 400,
            transition: 'background 150ms, color 150ms',
            marginTop: 4, position: 'relative',
          }}
          onMouseEnter={(e) => { if (activeId !== 'settings') {e.currentTarget.style.background = 'var(--bg-hover)'} }}
          onMouseLeave={(e) => { if (activeId !== 'settings') {e.currentTarget.style.background = 'transparent'} }}
        >
          {activeId === 'settings' && (
            <span aria-hidden style={{
              position: 'absolute', left: 2, top: '50%', transform: 'translateY(-50%)',
              width: 2, height: 16, borderRadius: 1, background: 'var(--status-running)',
            }} />
          )}
          <Settings size={18} style={{ opacity: activeId === 'settings' ? 1 : 0.82 } as React.CSSProperties} />
          {!collapsed && <span>{t('sidebar.settings')}</span>}
        </motion.button>
      </div>
    </motion.div>
  )
}

export default Sidebar
