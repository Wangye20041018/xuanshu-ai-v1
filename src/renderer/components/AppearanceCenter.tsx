/**
 * 界面改造配置中心（第2批-4 自我改造真实化）
 *
 * 提供真实可用的"自我改造"配置中心：
 *   - 主题重组：主题色（预设 + 自定义色）、背景风格（深邃暗色/明亮浅色/深空渐变）、
 *               圆角密度（锐利/标准/圆润）——修改后实时预览。
 *   - UI 重组：侧边栏 / 底部状态栏 / 顶部标题栏 显隐开关。
 *   - 一键应用：持久化并全局生效（写入 localStorage，App 启动时恢复）。
 *   - 恢复默认：一键还原玄枢默认外观。
 *
 * 预览机制：applyAppearance(cfg, false) 只改 CSS 不落盘；
 * "一键应用"时 applyAppearance(cfg, true) 持久化。
 *
 * @module renderer/components/AppearanceCenter
 */
import { useEffect, useState, type ReactNode } from 'react'
import { motion } from 'framer-motion'
import { Palette, Layout, Check, RotateCcw, Sparkles, PanelLeft, PanelBottom, PanelsTopLeft } from 'lucide-react'
import { COLORS, HEX_COLORS } from '../shared/theme'
import {
  THEME_OPTIONS, BG_OPTIONS, RADIUS_OPTIONS, UI_MODULES,
  type AppearanceConfig, type BgId, type RadiusId, type UiModuleId,
  DEFAULT_APPEARANCE, loadAppearance, applyAppearance,
} from '../theme'
import ErrorBoundary from './ErrorBoundary'

const UI_ICONS: Record<UiModuleId, ReactNode> = {
  sidebar: <PanelLeft size={14} />,
  statusbar: <PanelBottom size={14} />,
  titlebar: <PanelsTopLeft size={14} />,
}

/** 开关组件 */
function MiniToggle({ checked, onChange }: { checked: boolean; onChange: () => void }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={onChange}
      style={{
        width: 38, height: 20, borderRadius: 999, position: 'relative', border: 'none', cursor: 'pointer',
        background: checked ? COLORS.accent : 'rgba(255,255,255,0.12)',
        transition: 'background 200ms',
      }}
    >
      <span style={{
        position: 'absolute', top: 3, left: checked ? 20 : 3, width: 14, height: 14, borderRadius: '50%',
        background: '#fff', boxShadow: '0 1px 4px rgba(0,0,0,0.35)', transition: 'left 200ms',
      }} />
    </button>
  )
}

/** 单选色块 */
function ColorDot({ color, active, onClick, label }: { color: string; active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={`主题色 ${label}`}
      style={{
        width: 28, height: 28, borderRadius: '50%', background: color, border: 'none', cursor: 'pointer',
        outline: active ? `2px solid ${color}` : '1px solid rgba(255,255,255,0.18)',
        outlineOffset: 3, transition: 'transform 120ms', flexShrink: 0,
      }}
      onMouseEnter={(e) => e.currentTarget.style.transform = 'scale(1.12)'}
      onMouseLeave={(e) => e.currentTarget.style.transform = 'scale(1)'}
    />
  )
}

/** 选项按钮 */
function OptionBtn({ active, onClick, label, desc }: { active: boolean; onClick: () => void; label: string; desc: string }) {
  return (
    <button
      onClick={onClick}
      style={{
        flex: 1, textAlign: 'left', padding: '9px 12px', borderRadius: 10, cursor: 'pointer',
        background: active ? `${HEX_COLORS.accent}18` : 'rgba(255,255,255,0.03)',
        border: `1px solid ${active ? `${HEX_COLORS.accent}66` : COLORS.cardBorder}`,
        transition: 'all 150ms', fontFamily: 'inherit',
      }}
    >
      <div style={{ fontSize: 12.5, fontWeight: 600, color: active ? COLORS.accent : COLORS.textPrimary }}>{label}</div>
      <div style={{ fontSize: 10.5, color: COLORS.textMuted, marginTop: 2 }}>{desc}</div>
    </button>
  )
}

export default function AppearanceCenter() {
  const [cfg, setCfg] = useState<AppearanceConfig>(DEFAULT_APPEARANCE)
  const [applied, setApplied] = useState(false)

  useEffect(() => {
    // 初始载入已保存配置并应用（保持一致）
    const saved = loadAppearance()
    setCfg(saved)
    applyAppearance(saved, false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** 任何变更 → 实时预览（不落盘） */
  const preview = (next: AppearanceConfig) => {
    setCfg(next)
    applyAppearance(next, false)
    setApplied(false)
  }

  /** 一键应用：持久化并生效 */
  const handleApply = () => {
    applyAppearance(cfg, true)
    setApplied(true)
  }

  /** 恢复默认 */
  const handleReset = () => {
    preview(DEFAULT_APPEARANCE)
    applyAppearance(DEFAULT_APPEARANCE, true)
    setApplied(true)
  }

  return (
    <ErrorBoundary>
      <div style={{
        display: 'flex', flexDirection: 'column', gap: 16,
        padding: '18px 20px', borderRadius: 'var(--radius-2xl)',
        background: COLORS.cardBg, border: `1px solid ${COLORS.cardBorder}`,
      }}>
        {/* 头部 */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{
              width: 36, height: 36, borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: `${HEX_COLORS.accent}1a`, color: COLORS.accent,
            }}>
              <Palette size={18} />
            </span>
            <div>
              <div style={{ fontSize: 15, fontWeight: 600, color: COLORS.textPrimary, display: 'flex', alignItems: 'center', gap: 6 }}>
                界面改造 <Sparkles size={13} style={{ color: COLORS.accent }} />
              </div>
              <div style={{ fontSize: 11, color: COLORS.textMuted, marginTop: 2 }}>
                主题重组 + UI 重组 · 修改即实时预览，一键应用持久化全局生效
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <motion.button whileTap={{ scale: 0.96 }} onClick={handleReset}
              style={{
                display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px', borderRadius: 10,
                border: `1px solid ${COLORS.cardBorder}`, background: 'transparent', color: COLORS.textSecondary,
                fontSize: 12, cursor: 'pointer', fontFamily: 'inherit',
              }}>
              <RotateCcw size={13} /> 恢复默认
            </motion.button>
            <motion.button whileTap={{ scale: 0.96 }} onClick={handleApply}
              style={{
                display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', borderRadius: 10,
                border: 'none', background: COLORS.accent, color: '#0d0d0f',
                fontSize: 12.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
              }}>
              <Check size={14} /> 一键应用
            </motion.button>
          </div>
        </div>

        {/* 主题重组 */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {/* 主题色 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <span style={{ width: 64, fontSize: 12, color: COLORS.textSecondary, flexShrink: 0 }}>主题色</span>
            {THEME_OPTIONS.map(t => (
              <ColorDot key={t.id} color={t.color} label={t.label}
                active={cfg.themeColor === t.color}
                onClick={() => preview({ ...cfg, themeColor: t.color })} />
            ))}
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 12, color: COLORS.textMuted }}>
              <input
                type="color"
                value={/^#[0-9a-fA-F]{6}$/.test(cfg.themeColor) ? cfg.themeColor : '#b0b0ba'}
                onChange={(e) => preview({ ...cfg, themeColor: e.target.value })}
                style={{ width: 30, height: 28, border: 'none', background: 'transparent', cursor: 'pointer', padding: 0 }}
              />
              自定义
            </label>
          </div>

          {/* 背景风格 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ width: 64, fontSize: 12, color: COLORS.textSecondary, flexShrink: 0 }}>背景风格</span>
            <div style={{ flex: 1, display: 'flex', gap: 8 }}>
              {BG_OPTIONS.map(b => (
                <OptionBtn key={b.id} active={cfg.bg === b.id} label={b.label} desc={b.desc}
                  onClick={() => preview({ ...cfg, bg: b.id as BgId })} />
              ))}
            </div>
          </div>

          {/* 圆角密度 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ width: 64, fontSize: 12, color: COLORS.textSecondary, flexShrink: 0 }}>圆角密度</span>
            <div style={{ flex: 1, display: 'flex', gap: 8 }}>
              {RADIUS_OPTIONS.map(r => (
                <OptionBtn key={r.id} active={cfg.radius === r.id} label={r.label} desc={r.desc}
                  onClick={() => preview({ ...cfg, radius: r.id as RadiusId })} />
              ))}
            </div>
          </div>
        </div>

        {/* UI 重组 */}
        <div style={{
          paddingTop: 14, borderTop: `1px dashed ${COLORS.cardBorder}`,
          display: 'flex', flexDirection: 'column', gap: 8,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, fontWeight: 600, color: COLORS.textPrimary }}>
            <Layout size={14} style={{ color: COLORS.accent }} /> UI 重组 · 模块显隐
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {UI_MODULES.map(m => (
              <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 8px', borderRadius: 10, background: 'rgba(255,255,255,0.02)' }}>
                <span style={{ display: 'flex', color: COLORS.textMuted }}>{UI_ICONS[m.id]}</span>
                <span style={{ flex: 1, fontSize: 12.5, color: COLORS.textPrimary }}>{m.label}</span>
                <span style={{ fontSize: 10.5, color: COLORS.textMuted }}>{m.desc}</span>
                <MiniToggle
                  checked={cfg.ui[m.id]}
                  onChange={() => preview({ ...cfg, ui: { ...cfg.ui, [m.id]: !cfg.ui[m.id] } })}
                />
              </div>
            ))}
          </div>
        </div>

        {/* 状态提示 */}
        <div style={{ fontSize: 11, color: applied ? COLORS.success : COLORS.textMuted, display: 'flex', alignItems: 'center', gap: 6 }}>
          {applied
            ? <><Check size={12} /> 已应用并持久化，重启后自动恢复</>
            : <>当前为实时预览，点击「一键应用」后持久化全局生效</>}
        </div>
      </div>
    </ErrorBoundary>
  )
}
