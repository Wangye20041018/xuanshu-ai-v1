import { useEffect, useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { useTranslation } from '../../i18n'
import { EmptyState } from '../../components/EmptyState'
import { getGreeting, getGreetingPeriodKey } from './messageRender'

export default function HomeHeader() {
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
    </motion.div>
  )
}
