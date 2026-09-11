import { useState, useRef, useEffect, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { COLORS } from '../shared/theme'

/* ============================================================
 * 上下文统计类型（与 chatStore 对齐）
 * ============================================================ */
export interface ContextStats {
  totalTokens: number
  usedTokens: number
  systemTokens?: number
  memoryTokens?: number
  historyTokens?: number
  compressedRounds: number
  compressionRatio: number
  currentInputTokens?: number
  compressMode?: 'smart' | 'aggressive'
  compressThreshold?: number
}

/* ============================================================
 * Popover 组件（增强版：支持 hover + click 打开，稳健定位）
 * ============================================================ */
function Popover({ children, content }: { children: React.ReactNode; content: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const openTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [pos, setPos] = useState({ top: 0, left: 0, above: true })

  // 点击外部关闭
  useEffect(() => {
    if (!open) return
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node) &&
          popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  // 打开时与窗口尺寸变化时动态测量实际弹层尺寸，上下/左右空间判断，防止任何方向溢出
  const calcPosition = useCallback(() => {
    if (!ref.current) return
    const rect = ref.current.getBoundingClientRect()
    const popoverWidth = popoverRef.current?.offsetWidth || 340
    const popoverHeight = popoverRef.current?.offsetHeight || 280
    const margin = 12

    const topSpace = rect.top
    const bottomSpace = window.innerHeight - rect.bottom
    // 优先放入空间足够的一侧；两侧都不足时选择空间更大一侧
    const canAbove = topSpace >= popoverHeight + margin
    const canBelow = bottomSpace >= popoverHeight + margin
    const showAbove = canAbove ? (!canBelow || topSpace >= bottomSpace) : canBelow ? false : topSpace >= bottomSpace

    const top = showAbove ? rect.top - margin - popoverHeight : rect.bottom + margin

    // 水平方向：默认相对锚点居中，但保证不超出视口左右边界
    const centerX = rect.left + rect.width / 2
    const left = Math.max(
      popoverWidth / 2 + margin,
      Math.min(centerX, window.innerWidth - popoverWidth / 2 - margin)
    )

    setPos({ top, left, above: showAbove })
  }, [])

  useEffect(() => {
    if (!open) return
    calcPosition()
    window.addEventListener('resize', calcPosition)
    return () => window.removeEventListener('resize', calcPosition)
  }, [open, calcPosition])

  const handleMouseEnter = () => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
    calcPosition()
    // 短延迟防止误触
    openTimerRef.current = setTimeout(() => setOpen(true), 80)
  }

  const handleMouseLeave = () => {
    if (openTimerRef.current) {
      clearTimeout(openTimerRef.current)
      openTimerRef.current = null
    }
    closeTimerRef.current = setTimeout(() => setOpen(false), 200)
  }

  const handleClick = () => {
    if (openTimerRef.current) clearTimeout(openTimerRef.current)
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
    calcPosition()
    setOpen(prev => !prev)
  }

  useEffect(() => {
    return () => {
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
      if (openTimerRef.current) clearTimeout(openTimerRef.current)
    }
  }, [])

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-flex' }}>
      <div
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        onClick={handleClick}
        style={{ cursor: 'pointer', display: 'flex', alignItems: 'center' }}
        title="点击查看上下文使用详情"
      >
        {children}
      </div>
      <AnimatePresence>
        {open && (
          <motion.div
            ref={popoverRef}
            initial={{ opacity: 0, y: pos.above ? 8 : -8, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: pos.above ? 8 : -8, scale: 0.96 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
            onMouseEnter={() => {
              if (closeTimerRef.current) {
                clearTimeout(closeTimerRef.current)
                closeTimerRef.current = null
              }
            }}
            onMouseLeave={() => {
              closeTimerRef.current = setTimeout(() => setOpen(false), 200)
            }}
            style={{
              position: 'fixed', top: pos.top, left: pos.left,
              transform: pos.above ? 'translate(-50%, -100%)' : 'translate(-50%, 0)',
              minWidth: 300, maxWidth: 380,
              background: COLORS.cardBg, borderRadius: 16,
              border: '1px solid rgba(255,255,255,0.12)',
              padding: '18px 20px', zIndex: 99999,
              boxShadow: '0 16px 48px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.06)',
              pointerEvents: 'auto',
            }}
          >
            {content}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

/* ============================================================
 * ContextIndicator 组件
 * ============================================================ */
export default function ContextIndicator({ stats }: { stats?: ContextStats | null }) {
  // 使用传入的 stats 或默认值，确保所有字段非 undefined。
  // 默认值一律为 0：无真实推送数据时显示 0%（待采集闪烁），严禁写死上限/伪 tokens 制造假显示。
  const data: Required<ContextStats> = {
    totalTokens: stats?.totalTokens ?? 0,
    usedTokens: stats?.usedTokens ?? 0,
    systemTokens: stats?.systemTokens ?? 0,
    memoryTokens: stats?.memoryTokens ?? 0,
    historyTokens: stats?.historyTokens ?? (stats?.usedTokens ?? 0),
    compressedRounds: stats?.compressedRounds ?? 0,
    compressionRatio: stats?.compressionRatio ?? 0,
    currentInputTokens: stats?.currentInputTokens ?? 0,
    compressMode: stats?.compressMode ?? 'smart',
    compressThreshold: stats?.compressThreshold ?? 75,
  }

  const pct = data.totalTokens > 0 ? data.usedTokens / data.totalTokens : 0

  let color: string
  if (pct > 0.8) color = COLORS.danger
  else if (pct > 0.5) color = COLORS.warning
  else color = COLORS.success

  const circumference = 2 * Math.PI * 9
  const offset = circumference * (1 - Math.min(pct, 1))

  const popoverContent = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: COLORS.textPrimary, marginBottom: 2 }}>
        上下文窗口
      </div>

      <Row label="系统提示词" value={data.systemTokens.toLocaleString()} />
      <Row label="检索记忆" value={data.memoryTokens.toLocaleString()} />

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: 12, color: COLORS.textSecondary }}>对话历史</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 12, color: COLORS.textPrimary, fontVariantNumeric: 'tabular-nums' }}>
            {data.historyTokens.toLocaleString()}
          </span>
          {data.compressedRounds > 0 && (
            <span style={{
              fontSize: 10, padding: '1px 6px', borderRadius: 6,
              background: 'rgba(16,185,129,0.12)', color: COLORS.success,
            }}>
              已压缩 {data.compressedRounds} 轮 节省 {data.compressionRatio}%
            </span>
          )}
        </div>
      </div>

      <Row label="当前输入" value={data.currentInputTokens.toLocaleString()} />

      <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 8, marginTop: 2 }} />

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: 12, color: COLORS.textSecondary }}>总计</span>
        <span style={{ fontSize: 13, fontWeight: 600, color: color, fontVariantNumeric: 'tabular-nums' }}>
          {data.usedTokens.toLocaleString()} / {data.totalTokens.toLocaleString()} tokens
        </span>
      </div>

      <div style={{ display: 'flex', gap: 16, fontSize: 11, color: COLORS.textMuted }}>
        <span>压缩模式：<span style={{ color: COLORS.textPrimary }}>{data.compressMode === 'smart' ? '智能' : '激进'}</span></span>
        <span>阈值：<span style={{ color: COLORS.textPrimary }}>{data.compressThreshold}%</span></span>
      </div>
    </div>
  )

  return (
    <Popover content={popoverContent}>
      <motion.div
        whileHover={{ scale: 1.15 }}
        animate={pct < 0.01 ? { opacity: [0.6, 1, 0.6] } : {}}
        transition={pct < 0.01 ? { duration: 2.5, repeat: Infinity, ease: 'easeInOut' } : {}}
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      >
        <svg width="26" height="26" viewBox="0 0 24 24" style={{ display: 'block', flexShrink: 0, filter: 'drop-shadow(0 0 3px rgba(255,255,255,0.08))' }}>
          {/* 背景圆环 */}
          <circle cx="12" cy="12" r="9" fill="none" stroke="rgba(255,255,255,0.28)" strokeWidth="2.5" />
          {/* 填充圆环 */}
          <motion.circle
            cx="12" cy="12" r="9"
            fill="none"
            stroke={color}
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeDasharray={circumference}
            initial={{ strokeDashoffset: circumference }}
            animate={{ strokeDashoffset: offset }}
            transition={{ duration: 0.6, ease: 'easeOut' }}
            transform="rotate(-90 12 12)"
          />
          {/* 使用率文字 */}
          <text x="12" y="15.5" textAnchor="middle" fontSize="7.5" fontWeight="700" fill={COLORS.textPrimary} style={{ fontFamily: 'system-ui, sans-serif' }}>
            {Math.round(pct * 100)}%
          </text>
        </svg>
      </motion.div>
    </Popover>
  )
}

/* ============================================================
 * 内部行组件
 * ============================================================ */
function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <span style={{ fontSize: 12, color: COLORS.textSecondary }}>{label}</span>
      <span style={{ fontSize: 12, color: COLORS.textPrimary, fontVariantNumeric: 'tabular-nums' }}>{value}</span>
    </div>
  )
}
