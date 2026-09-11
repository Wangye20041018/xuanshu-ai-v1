import { ChevronRight, Plus } from 'lucide-react'
import { motion } from 'framer-motion'

interface StatusBarProps {
  historyOpen: boolean
  setHistoryOpen: (v: boolean) => void
  onNewChat?: () => void
}

// v3：首页顶部工具条 —— 去玻璃模糊 / 去紫渐变 / 去辉光，统一实底克制
export default function StatusBar({
  historyOpen,
  setHistoryOpen,
  onNewChat,
}: StatusBarProps) {
  const iconBtn: React.CSSProperties = {
    position: 'absolute', top: 12, zIndex: 20,
    width: 32, height: 32, borderRadius: 'var(--radius-md)',
    background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    color: 'var(--text-tertiary)', cursor: 'pointer',
  }

  return (
    <>
      {/* 历史折叠按钮 */}
      {!historyOpen && (
        <motion.button
          whileHover={{ color: 'var(--text-secondary)', background: 'var(--bg-hover)' }}
          whileTap={{ scale: 0.96 }}
          onClick={() => setHistoryOpen(true)}
          title="展开历史对话"
          style={{ ...iconBtn, left: 12 }}
        >
          <ChevronRight size={15} strokeWidth={1.8} />
        </motion.button>
      )}

      {/* 新建会话主入口：进行蓝实底，无渐变 / 无辉光 */}
      {onNewChat && (
        <motion.button
          whileHover={{ filter: 'brightness(1.08)' }}
          whileTap={{ scale: 0.97 }}
          onClick={onNewChat}
          title="新建会话"
          style={{
            position: 'absolute', top: 12, right: 52,
            zIndex: 20, height: 32,
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '0 14px', borderRadius: 'var(--radius-md)', cursor: 'pointer',
            background: 'var(--status-running)',
            border: 'none',
            color: '#fff', fontFamily: 'inherit', fontSize: 12.5, fontWeight: 600,
            boxShadow: 'none',
            letterSpacing: 0.3,
          }}
        >
          <Plus size={14} strokeWidth={2} />
          新建会话
        </motion.button>
      )}

      {/* 右侧工作面板入口已移除（发布整改第一批）：不再提供展开工作面板按钮 */}
    </>
  )
}
