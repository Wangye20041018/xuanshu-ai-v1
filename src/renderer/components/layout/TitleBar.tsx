import { useState, useEffect, useCallback } from 'react'
import { motion } from 'framer-motion'
import { Minus, Square, X, Copy } from 'lucide-react'
import { logger } from '../../../shared/logger'

function TitleBar() {
  const [isMaximized, setIsMaximized] = useState(false)

  useEffect(() => {
    const check = async () => {
      if (window.api) {
        try { setIsMaximized(!!(await window.api.invoke<boolean>('window:is-maximized'))) } catch (e) { logger.error('[TitleBar] 检查最大化状态失败:', e) }
      }
    }
    check()
    const handler = () => check()
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
  } as any

  return (
    <div className="app-titlebar" style={{ background: 'transparent', borderBottom: 'none' }}>
      {/* Left: spacer for sidebar alignment */}
      <div style={{ width: 100 }} />

      {/* Right: Window controls */}
      <div style={{ display: 'flex', gap: 2, WebkitAppRegion: 'no-drag' } as any}>
        <motion.button whileHover={{ background: 'var(--bg-hover)', color: 'var(--text-secondary)' }} whileTap={{ scale: 0.9 }} onClick={minimize} style={btnBase} title="最小化">
          <Minus size={14} strokeWidth={1.5} />
        </motion.button>
        <motion.button whileHover={{ background: 'var(--bg-hover)', color: 'var(--text-secondary)' }} whileTap={{ scale: 0.9 }} onClick={maximize} style={btnBase} title={isMaximized ? '还原' : '最大化'}>
          {isMaximized ? <Copy size={12} strokeWidth={1.5} style={{ transform: 'rotate(180deg)' }} /> : <Square size={12} strokeWidth={1.5} />}
        </motion.button>
        <motion.button whileHover={{ background: 'rgba(239,68,68,0.12)', color: 'var(--danger)' }} whileTap={{ scale: 0.9 }} onClick={close} style={btnBase} title="关闭">
          <X size={14} strokeWidth={1.5} />
        </motion.button>
      </div>
    </div>
  )
}

export default TitleBar
