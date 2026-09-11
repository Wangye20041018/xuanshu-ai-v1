/**
 * COLORS — CSS 变量别名（渲染层唯一真源）
 *
 * 值均为 `var(--token)` 字符串，随 globals.css 的 Design Tokens 与主题色
 * （applyTheme 动态改写 --brand 系列）切换。适用于 React 内联 style、framer-motion
 * 的 style/boxShadow 等 CSS 上下文。
 *
 * ⚠️ 注意：`var()` 不能参与十六进制 alpha 拼接（如 `${COLORS.accent}18`），
 * 这类场景请使用下方 HEX_COLORS。
 */
export const COLORS = {
  accent: 'var(--accent)',
  accent2: 'var(--accent2)',
  purple: 'var(--accent-dark)',
  violet: 'var(--violet)',
  bg: 'var(--bg-base)',
  cardBg: 'var(--bg-elevated)',
  cardBorder: 'var(--border-card)',
  cardBorderHover: 'var(--border-strong-hover)',
  textPrimary: 'var(--text-primary)',
  textSecondary: 'var(--text-secondary)',
  textMuted: 'var(--text-muted)',
  success: 'var(--success)',
  successAlt: 'var(--success-alt)',
  danger: 'var(--danger)',
  dangerAlt: 'var(--danger-alt)',
  warning: 'var(--warning)',
  warningAlt: 'var(--warning-alt)',
  cyan: 'var(--info)',
  brand: 'var(--brand)',
  brandLight: 'var(--brand-light)',
  brandDim: 'var(--brand-dim)',
  accentLight: 'var(--accent-light)',
  accentDim: 'var(--accent-dim-strong)',
  successDim: 'var(--success-dim)',
  dangerDim: 'var(--danger-dim)',
  warningDim: 'var(--warning-dim)',
  violetDim: 'var(--violet-dim)',
  // v3 任务运行状态语义色（UI-1 步骤 / UI-2 工具行）
  statusPending: 'var(--status-pending)',
  statusRunning: 'var(--status-running)',
  statusRunningDim: 'var(--status-running-dim)',
  statusDone: 'var(--status-done)',
  statusDoneDim: 'var(--status-done-dim)',
  statusFailed: 'var(--status-failed)',
  statusFailedDim: 'var(--status-failed-dim)',
  statusWarn: 'var(--status-warn)',
} as const

/**
 * HEX_COLORS — 纯十六进制/rgba 字面量
 *
 * 供主进程（无 DOM，不能吃 var()）、canvas、颜色计算、以及
 * `${HEX_COLORS.xxx}NN` 十六进制 alpha 拼接等非 CSS 上下文使用。
 */
export const HEX_COLORS = {
  accent: '#b0b0ba',
  accent2: '#a6a6b0',
  purple: '#8a8a96',
  violet: '#8b5cf6',
  violetLight: '#a78bfa',
  blue: '#3b82f6',
  bg: '#1a1b1d',
  cardBg: '#27282c',
  cardBorder: 'rgba(255,255,255,0.06)',
  cardBorderHover: 'rgba(255,255,255,0.14)',
  textPrimary: '#e8e8ec',
  textSecondary: '#a6a6b0',
  textMuted: '#7e7e88',
  success: '#10b981',
  successAlt: '#22c55e',
  danger: '#d4706a',
  dangerAlt: '#ef4444',
  warning: '#f59e0b',
  warningAlt: '#d97706',
  cyan: '#06b6d4',
  brand: '#b0b0ba',
  brandLight: '#c8c8d0',
  brandDim: 'rgba(176,176,186,0.12)',
  accentLight: '#c8c8d0',
  accentDim: 'rgba(176,176,186,0.12)',
  successDim: 'rgba(16,185,129,0.08)',
  dangerDim: 'rgba(212,112,106,0.08)',
  warningDim: 'rgba(245,158,11,0.10)',
  violetDim: 'rgba(139,92,246,0.12)',
  // v3 任务运行状态语义色（字面量，供内联 alpha 拼接，值与 globals.css 一一对应）
  statusPending: '#7e7e88',
  statusRunning: '#4b8ef1',
  statusRunningDim: 'rgba(75,142,241,0.14)',
  statusDone: '#3fb97b',
  statusDoneDim: 'rgba(63,185,123,0.14)',
  statusFailed: '#ef4444',
  statusFailedDim: 'rgba(239,68,68,0.12)',
  statusWarn: '#f59e0b',
} as const

export const containerVariants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { staggerChildren: 0.08, delayChildren: 0.05 } },
}

export const itemVariants = {
  hidden: { opacity: 0, y: 20 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.4, ease: [0.4, 0, 0.2, 1] } },
}

export const listItemVariants = {
  hidden: { opacity: 0, x: -12 },
  visible: { opacity: 1, x: 0, transition: { duration: 0.35, ease: [0.4, 0, 0.2, 1] } },
}

// M-20 修复：删除重复的 THEME_OPTIONS（与 renderer/theme.ts 重复且无人引用），统一从 renderer/theme.ts 导出
