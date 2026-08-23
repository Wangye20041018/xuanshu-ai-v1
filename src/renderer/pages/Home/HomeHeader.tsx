import { useEffect, useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { COLORS } from '../../shared/theme'
import { useTranslation } from '../../i18n'
import { EmptyState } from '../../components/EmptyState'
import { getGreeting, getGreetingPeriodKey } from './messageRender'

const EXAMPLE_PROMPTS = [
  { icon: '📄', text: '把桌面文件整理归类' },
  { icon: '🔍', text: '帮我找 E 盘里的发票' },
  { icon: '🎬', text: '做一份 10 页 PPT' },
  { icon: '⚡', text: '打开超算模式' },
]

interface HomeHeaderProps {
  onPick?: (text: string) => void
}

export default function HomeHeader({ onPick }: HomeHeaderProps) {
  const { t } = useTranslation()

  // 跨时段边界自动刷新问候语（如 11:59→12:00 由「上午好」切为「中午好」）
  const [periodKey, setPeriodKey] = useState(() => getGreetingPeriodKey())
  useEffect(() => {
    const interval = setInterval(() => {
      setPeriodKey((prev) => {
        const next = getGreetingPeriodKey()
        return next === prev ? prev : next
      })
    }, 30_000)
    return () => clearInterval(interval)
  }, [])

  // 语言切换或时段变化时重新计算问候语
  const greeting = useMemo(() => getGreeting(t), [t, periodKey])

  return (
    <motion.div
      key="welcome-header"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, y: -16 }}
      style={{ margin: 'auto', width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center' }}
    >
      {/* 问候区（空态统一组件 + i18n 副标题） */}
      <motion.div
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.7, delay: 0.1, ease: [0.16, 1, 0.3, 1] }}
        style={{ marginBottom: 8, position: 'relative' }}
      >
        <EmptyState
          title={greeting}
          description={t('chat.emptyState')}
        />
      </motion.div>

      {/* 示例引导：点击即发送 */}
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, delay: 0.35 }}
        style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'center', maxWidth: 420, marginTop: 28 }}
      >
        {EXAMPLE_PROMPTS.map((p) => (
          <button
            key={p.text}
            onClick={() => onPick?.(p.text)}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '8px 14px', borderRadius: 999, cursor: 'pointer',
              background: 'rgba(255,255,255,0.05)', border: `1px solid ${COLORS.cardBorder}`,
              color: COLORS.textSecondary, fontSize: 13, fontFamily: '"PingFang SC", system-ui, sans-serif',
              transition: 'all 0.2s',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.1)'; e.currentTarget.style.color = COLORS.textPrimary }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.05)'; e.currentTarget.style.color = COLORS.textSecondary }}
          >
            <span style={{ fontSize: 14 }}>{p.icon}</span>
            {p.text}
          </button>
        ))}
      </motion.div>
    </motion.div>
  )
}
