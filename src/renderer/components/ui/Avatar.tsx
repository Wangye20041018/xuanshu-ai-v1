import { COLORS } from '../../shared/theme'

/**
 * Avatar — 全局头像组件（U-1/A-2 修复）
 * 三态：emoji / 首字渐变 / 图片。color 字段用于头像底色与 accent。
 * 统一贯穿 智能体卡片 / 聊天 / 语音 / 设置 等页面。
 */
export default function Avatar({
  icon, name, color, size = 36,
}: {
  icon?: string
  name?: string
  color?: string
  size?: number
}) {
  const bg = color || COLORS.brand
  const radius = Math.round(size * 0.3)
  const fontSize = Math.round(size * 0.42)

  // 有 emoji 图标：渐变底 + emoji
  if (icon) {
    return (
      <div style={{
        width: size, height: size, borderRadius: radius, flexShrink: 0,
        background: `linear-gradient(135deg, ${bg}40, ${bg}22)`,
        border: `1px solid ${bg}45`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize, color: COLORS.textPrimary,
      }} title={name}>
        {icon}
      </div>
    )
  }

  // 无图标：首字渐变（中文取首字符，英文取首字母）
  const initial = (name || '?').trim().slice(0, 1).toUpperCase()
  return (
    <div style={{
      width: size, height: size, borderRadius: radius, flexShrink: 0,
      background: `linear-gradient(135deg, ${bg}, ${bg}88)`,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize, fontWeight: 700, color: '#fff',
    }} title={name}>
      {initial}
    </div>
  )
}
