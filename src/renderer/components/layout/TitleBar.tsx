import { useState, useEffect, useCallback } from 'react'
import { useLocation } from 'react-router-dom'
import { motion } from 'framer-motion'
import { Minus, Square, X, Copy } from 'lucide-react'
import { logger } from '../../../shared/logger'

// v3 极简顶栏：左侧当前视图名（纯展示，不新增后端能力），右侧窗口控制
const PATH_TITLES: Record<string, string> = {
  '/': '对话',
  '/model': '模型',
  '/memory': '记忆',
  '/knowledge': '知识库',
  '/settings': '设置',
  '/automation': '自动化',
  '/self-modify': '自我改造',
  '/agents': '智能体',
  '/software': '软件库',
}

function TitleBar() {
  const location = useLocation()
  const [isMaximized, setIsMaximized] = useState(false)

  useEffect(() => {
    const check = async () => {
      if (window.api) {
        try { setIsMaximized(!!(await window.api.invoke<boolean>('window:is-maximized'))) } catch (e) { logger.error('[TitleBar] 检查最大化状态失败:', e) }
      }
    }
    void check()
    const handler = () => { void check() }
    window.addEventListener('resize', handler)
    return () => window.removeEventListener('resize', handler)
  }, [])

  const minimize = useCallback(() => { window.api?.invoke('window:minimize').catch((e) => logger.error('[TitleBar] 最小化窗口失败:', e)) }, [])
  const maximize = useCallback(() => {
    window.api?.invoke<boolean>('window:maximize').then((isMax) => {
      setIsMaximized(isMax ?? false)
    }).catch((e) => logger.error('[TitleBar] 最大化窗口失败:', e))
  }, [])
  const close = useCallback(() => { window.api?.invoke('window:close').catch((e) => logger.error('[TitleBar] 关闭窗口失败:', e)) }, [])

  const btnBase: React.CSSProperties = {
    width: 32, height: 32, borderRadius: 'var(--radius-sm)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    color: 'var(--text-tertiary)', transition: 'all 120ms ease',
    WebkitAppRegion: 'no-drag',
  } as React.CSSProperties

  const pageTitle = PATH_TITLES[location.pathname] ?? ''

  return (
    <div className="app-titlebar" style={{ background: 'var(--bg-surface)', borderBottom: '1px solid var(--border-subtle)' }}>
      {/* Left: 当前视图名（极简、纯展示） */}
      <div style={{ display: 'flex', alignItems: 'center', minWidth: 120, height: '100%' }}>
        <span style={{
          fontSize: 12.5, fontWeight: 500, color: 'var(--text-secondary)', letterSpacing: '0.02em',
          WebkitAppRegion: 'no-drag',
        } as React.CSSProperties}>
          {pageTitle}
        </span>
      </div>

      {/* Middle: 可拖拽留白 */}
      <div style={{ flex: 1, alignSelf: 'stretch' }} />

      {/* Right: Window controls */}
      <div style={{ display: 'flex', gap: 2, WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        <motion.button whileHover={{ background: 'var(--bg-hover)', color: 'var(--text-secondary)' }} whileTap={{ scale: 0.9 }} onClick={minimize} style={btnBase} title="最小化">
          <Minus size={14} strokeWidth={1.5} />
        </motion.button>
        <motion.button whileHover={{ background: 'var(--bg-hover)', color: 'var(--text-secondary)' }} whileTap={{ scale: 0.9 }} onClick={maximize} style={btnBase} title={isMaximized ? '还原' : '最大化'}>
          {isMaximized ? <Copy size={12} strokeWidth={1.5} style={{ transform: 'rotate(180deg)' }} /> : <Square size={12} strokeWidth={1.5} />}
        </motion.button>
        <motion.button whileHover={{ background: 'rgba(239,68,68,0.12)', color: 'var(--status-failed)' }} whileTap={{ scale: 0.9 }} onClick={close} style={btnBase} title="关闭">
          <X size={14} strokeWidth={1.5} />
        </motion.button>
      </div>
    </div>
  )
}

export default TitleBar
