/**
 * 主题/外观共享模块
 *
 * 职责：
 *   1. 主题色切换（预设 5 色 + 自定义色）→ 改写 --brand / --accent 系列 CSS 变量。
 *   2. 外观改造配置中心（第2批-4 自我改造真实化）：
 *      - 背景风格（dark / light / gradient）→ 写入 data-bg
 *      - 圆角密度（sharp / default / rounded）→ 写入 data-radius
 *      - UI 重组（侧边栏 / 状态栏 / 标题栏显隐）→ 写入 data-ui-*
 *   3. 持久化到 localStorage（xuanshu-appearance），启动时恢复。
 *
 * 设计：预览时只改 CSS（不落盘），"一键应用"时再持久化并更新生效。
 * 所有页面通过 var(--token) 引用 Design Tokens，因此此处改写全局即时生效。
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

/** 背景风格选项 */
export const BG_OPTIONS = [
  { id: 'dark', label: '深邃暗色', desc: '玄枢默认 · 中性实底' },
  { id: 'light', label: '明亮浅色', desc: '清爽明亮 · 适合白天' },
  { id: 'gradient', label: '深空渐变', desc: '紫蓝渐晕 · 深邃质感' },
  { id: 'glass', label: '磨砂玻璃', desc: '全局半透明磨砂 · 高光内描边' },
] as const
export type BgId = typeof BG_OPTIONS[number]['id']

/** 圆角密度选项 */
export const RADIUS_OPTIONS = [
  { id: 'sharp', label: '锐利', desc: '更紧凑、更硬朗' },
  { id: 'default', label: '标准', desc: '玄枢默认圆角' },
  { id: 'rounded', label: '圆润', desc: '更大圆角、更柔和' },
] as const
export type RadiusId = typeof RADIUS_OPTIONS[number]['id']

/** UI 重组：可显隐模块 */
export const UI_MODULES = [
  { id: 'sidebar', label: '侧边栏', desc: '左侧功能导航栏' },
  { id: 'statusbar', label: '底部状态栏', desc: 'CPU/内存/GPU/网络/时间' },
  { id: 'titlebar', label: '顶部标题栏', desc: '窗口标题与拖拽区域' },
] as const
export type UiModuleId = typeof UI_MODULES[number]['id']

/** 完整外观配置 */
export interface AppearanceConfig {
  themeColor: string
  bg: BgId
  radius: RadiusId
  ui: Record<UiModuleId, boolean> // true=显示
}

export const THEME_STORAGE_KEY = 'xuanshu-theme-color'
export const APPEARANCE_STORAGE_KEY = 'xuanshu-appearance'

/** 默认外观配置 */
export const DEFAULT_APPEARANCE: AppearanceConfig = {
  themeColor: 'silver',
  bg: 'dark',
  radius: 'default',
  ui: { sidebar: true, statusbar: true, titlebar: true },
}

function readStorage(key: string): string | null {
  try { return localStorage.getItem(key) } catch { return null }
}
function writeStorage(key: string, value: string): void {
  try { localStorage.setItem(key, value) } catch { /* 忽略 */ }
}

/** 读取已保存的主题色 id（无则返回默认银灰） */
export function getSavedThemeId(): string {
  return readStorage(THEME_STORAGE_KEY) || DEFAULT_APPEARANCE.themeColor
}

/**
 * 应用主题色到全局 CSS 变量（含持久化）。
 * 支持预设 id 或任意十六进制色（自定义主题色）。
 * 幂等：重复调用仅重设 CSS 变量，无副作用。
 */
export function applyTheme(themeIdOrColor: string, persist = true): void {
  if (persist) writeStorage(THEME_STORAGE_KEY, themeIdOrColor)
  const opt = THEME_OPTIONS.find(t => t.id === themeIdOrColor)
  const color = opt ? opt.color : /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(themeIdOrColor) ? themeIdOrColor : null
  if (!color) return
  const root = document.documentElement.style
  root.setProperty('--brand', color)
  root.setProperty('--brand-light', color)
  root.setProperty('--brand-dark', color)
  root.setProperty('--brand-dim', color + '1f')
  root.setProperty('--brand-glow', `0 0 24px ${color}33`)
  root.setProperty('--brand-glow-lg', `0 0 40px ${color}40`)
  root.setProperty('--accent', color)
  root.setProperty('--accent-light', lighten(color, 18))
  root.setProperty('--accent-dark', darken(color, 22))
  root.setProperty('--accent-dim', color + '1f')
  root.setProperty('--accent-dim-strong', color + '22')
  root.setProperty('--accent-glow', `0 0 24px ${color}2e`)
  root.setProperty('--accent-glow-lg', `0 0 40px ${color}36`)
  root.setProperty('--border-focus', color)
}

/* ---- 颜色工具 ---- */
function hexToRgb(hex: string): [number, number, number] {
  let h = hex.replace('#', '')
  if (h.length === 3) h = h.split('').map(c => c + c).join('')
  const n = parseInt(h, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
function lighten(hex: string, amt: number): string {
  const [r, g, b] = hexToRgb(hex)
  const f = (v: number) => Math.round(v + (255 - v) * (amt / 100))
  return `#${[f(r), f(g), f(b)].map(v => v.toString(16).padStart(2, '0')).join('')}`
}
function darken(hex: string, amt: number): string {
  const [r, g, b] = hexToRgb(hex)
  const f = (v: number) => Math.round(v * (1 - amt / 100))
  return `#${[f(r), f(g), f(b)].map(v => v.toString(16).padStart(2, '0')).join('')}`
}

/* ---- 外观改造配置中心 ---- */

/** 读取完整外观配置（启动时恢复） */
export function loadAppearance(): AppearanceConfig {
  try {
    const raw = readStorage(APPEARANCE_STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<AppearanceConfig>
      return {
        themeColor: parsed.themeColor || DEFAULT_APPEARANCE.themeColor,
        bg: (['dark', 'light', 'gradient', 'glass'] as BgId[]).includes(parsed.bg as BgId) ? parsed.bg as BgId : DEFAULT_APPEARANCE.bg,
        radius: (['sharp', 'default', 'rounded'] as RadiusId[]).includes(parsed.radius as RadiusId) ? parsed.radius as RadiusId : DEFAULT_APPEARANCE.radius,
        ui: {
          sidebar: parsed.ui?.sidebar ?? true,
          statusbar: parsed.ui?.statusbar ?? true,
          titlebar: parsed.ui?.titlebar ?? true,
        },
      }
    }
  } catch { /* 损坏则用默认 */ }
  return DEFAULT_APPEARANCE
}

/**
 * 应用外观配置到全局（实时预览：persist=false 时不落盘）。
 * 同时写入 data-bg / data-radius / data-ui-* 到 <html>。
 */
export function applyAppearance(cfg: AppearanceConfig, persist = true): void {
  if (persist) writeStorage(APPEARANCE_STORAGE_KEY, JSON.stringify(cfg))
  const root = document.documentElement
  applyTheme(cfg.themeColor, false)
  root.setAttribute('data-bg', cfg.bg)
  root.setAttribute('data-radius', cfg.radius)
  root.setAttribute('data-ui-sidebar', cfg.ui.sidebar ? 'visible' : 'hidden')
  root.setAttribute('data-ui-statusbar', cfg.ui.statusbar ? 'visible' : 'hidden')
  root.setAttribute('data-ui-titlebar', cfg.ui.titlebar ? 'visible' : 'hidden')
}

/** 在应用启动时恢复已保存的外观配置（无 document 时静默跳过） */
export function applyAppearanceOnBoot(): void {
  if (typeof document === 'undefined') return
  applyAppearance(loadAppearance(), false)
}

/** 兼容旧入口：仅恢复主题色（保持历史行为） */
export function applyThemeOnBoot(): void {
  if (typeof document === 'undefined') return
  applyTheme(getSavedThemeId(), false)
}
