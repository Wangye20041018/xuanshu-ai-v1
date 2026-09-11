import { motion } from 'framer-motion'
import { ArrowLeft, Layers } from 'lucide-react'
import { COLORS, containerVariants, itemVariants } from '../../shared/theme'
import SettingsSoftwareLibrary from '../Settings/SettingsSoftwareLibrary'

/**
 * 软件库独立页
 * 从设置页移出的软件相关功能（软件库 / 软件状态 / 技能包联动）集中于此，
 * 使设置页保持精简。
 */
export default function SoftwareLibraryPage() {
  return (
    <motion.div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        backgroundColor: COLORS.bg,
        color: COLORS.textPrimary,
      }}
      variants={containerVariants}
      initial="hidden"
      animate="visible"
    >
      <motion.div
        variants={itemVariants}
        style={{
          padding: '20px 32px',
          borderBottom: `1px solid ${COLORS.cardBorder}`,
          display: 'flex',
          alignItems: 'center',
          gap: 14,
        }}
      >
        <motion.button
          aria-label="返回上一页"
          whileHover={{ scale: 1.08 }}
          whileTap={{ scale: 0.92 }}
          onClick={() => window.history.back()}
          style={{
            width: 34,
            height: 34,
            borderRadius: '10px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(255,255,255,0.04)',
            border: `1px solid ${COLORS.cardBorder}`,
            color: COLORS.textSecondary,
            cursor: 'pointer',
            transition: 'all 0.2s ease',
          }}
        >
          <ArrowLeft size={16} />
        </motion.button>
        <Layers size={18} color={COLORS.accent} />
        <h2 style={{ fontSize: 17, fontWeight: 600 }}>软件库</h2>
      </motion.div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 32px' }}>
        <SettingsSoftwareLibrary />
      </div>
    </motion.div>
  )
}
