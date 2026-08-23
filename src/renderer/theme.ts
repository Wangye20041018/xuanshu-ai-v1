/**
 * 主题色共享模块
 *
 * 抽离自 Settings 页：主题色选择需要全局生效（含应用启动时恢复），
 * 因此将色值表与 CSS 变量应用逻辑独立为共享模块，App 启动时与 Settings 页共用。
 *
 * @module renderer/theme
 */

export const THEME_OPTIONS = [
  { id: 'red', label: '朱红', color: '#ef4444' },
  { id: 'yellow', label: '明黄', color: '#eab308' },
  { id: 'green', label: '翠绿', color: '#22c55e' },
  { id: 'silver', label: '银灰', color: '#b0b0ba' },
  { id: 'graphite', label: '石墨', color: '#8a8a96' },
] as const

export type ThemeId = typeof THEME_OPTIONS[number]['id']

export const THEME_STORAGE_KEY = 'xuanshu-theme-color'

/** 读取已保存的主题色 id（无则返回默认银灰） */
export function getSavedThemeId(): string {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY) || 'silver'
  } catch {
    return 'silver'
  }
}

/**
 * 应用主题色到全局 CSS 变量并持久化。
 * 幂等：重复调用仅重设 CSS 变量，无副作用。
 */
export function applyTheme(themeId: string): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, themeId)
  } catch { /* localStorage 不可用时仅应用样式 */ }
  const opt = THEME_OPTIONS.find(t => t.id === themeId)
  if (!opt) return
  const root = document.documentElement.style
  root.setProperty('--brand', opt.color)
  root.setProperty('--brand-light', opt.color)
  root.setProperty('--brand-dark', opt.color)
  root.setProperty('--brand-dim', opt.color + '1f')
  root.setProperty('--brand-glow', `0 0 24px ${opt.color}33`)
  root.setProperty('--brand-glow-lg', `0 0 40px ${opt.color}40`)
  root.setProperty('--border-focus', opt.color)
}

/** 在应用启动时恢复已保存的主题色（浏览器无 document 时静默跳过） */
export function applyThemeOnBoot(): void {
  if (typeof document === 'undefined') return
  applyTheme(getSavedThemeId())
}
