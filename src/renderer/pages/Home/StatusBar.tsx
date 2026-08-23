import { ChevronRight, PanelRight, Cpu, Loader2 } from 'lucide-react'
import { HEX_COLORS, COLORS } from '../../shared/theme'
import { motion } from 'framer-motion'

interface StatusBarProps {
  historyOpen: boolean
  setHistoryOpen: (v: boolean) => void
  panelOpen: boolean
  setPanelOpen: (v: boolean) => void
  modelHealthy: boolean
  modelName: string | null
  modelLoading?: boolean
  modelLoadingName?: string | null
}

export default function StatusBar({
  historyOpen,
  setHistoryOpen,
  panelOpen,
  setPanelOpen,
  modelHealthy,
  modelName,
  modelLoading = false,
  modelLoadingName = null,
}: StatusBarProps) {
  return (
    <>
      {/* 历史折叠按钮 */}
      {!historyOpen && (
        <motion.button
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.95 }}
          onClick={() => setHistoryOpen(true)}
          title="展开历史对话"
          style={{
            position: 'absolute', top: 12, left: 12, zIndex: 20,
            width: 32, height: 32, borderRadius: 'var(--radius-md)',
            background: 'var(--bg-card)', border: '1px solid var(--border-subtle)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: 'var(--text-tertiary)', cursor: 'pointer',
            backdropFilter: 'blur(8px)',
          }}
        >
          <ChevronRight size={16} />
        </motion.button>
      )}

      {/* 模型健康指示 — P0-3: 实时反映引擎加载状态；体验优化：加载中显示「正在加载模型…」 */}
      <motion.div
        initial={{ opacity: 0, scale: 0.8 }}
        animate={{ opacity: 1, scale: 1 }}
        title={
          modelLoading
            ? `正在加载模型${modelLoadingName ? `：${modelLoadingName}` : ''}…`
            : modelHealthy
              ? `模型引擎就绪: ${modelName ?? '未知'}`
              : '模型引擎未就绪 — 请在模型设置中导入并加载模型'
        }
        style={{
          position: 'absolute', top: 12, right: 92, zIndex: 20,
          height: 32, padding: '0 10px', borderRadius: 'var(--radius-md)',
          background: modelLoading ? COLORS.warningDim : modelHealthy ? COLORS.successDim : COLORS.dangerDim,
          border: `1px solid ${modelLoading ? 'rgba(245,158,11,0.25)' : modelHealthy ? 'rgba(16,185,129,0.15)' : 'rgba(239,68,68,0.2)'}`,
          display: 'flex', alignItems: 'center', gap: 6,
          cursor: 'default', backdropFilter: 'blur(8px)',
        }}
      >
        {modelLoading ? (
          <motion.div
            animate={{ rotate: 360 }}
            transition={{ repeat: Infinity, duration: 1, ease: 'linear' }}
            style={{ display: 'flex', color: COLORS.warning }}
          >
            <Loader2 size={13} />
          </motion.div>
        ) : (
          <div style={{
            width: 7, height: 7, borderRadius: '50%',
            background: modelHealthy ? COLORS.success : COLORS.dangerAlt,
            boxShadow: `0 0 6px ${modelHealthy ? 'rgba(16,185,129,0.5)' : 'rgba(239,68,68,0.5)'}`,
            flexShrink: 0,
          }} />
        )}
        <Cpu size={13} style={{ color: modelLoading ? COLORS.warning : modelHealthy ? COLORS.success : COLORS.dangerAlt, opacity: 0.8, flexShrink: 0 }} />
        <span style={{
          fontSize: 11,
          color: modelLoading ? `${HEX_COLORS.warning}d9` : modelHealthy ? `${HEX_COLORS.success}b3` : `${HEX_COLORS.dangerAlt}b3`,
          maxWidth: 110, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {modelLoading ? `正在加载模型${modelLoadingName ? `：${modelLoadingName}` : ''}…` : (modelHealthy && modelName ? modelName : '模型未就绪')}
        </span>
      </motion.div>

      {/* 右侧面板按钮 */}
      <motion.button
        whileHover={{ scale: 1.05 }}
        whileTap={{ scale: 0.95 }}
        onClick={() => setPanelOpen(!panelOpen)}
        title={panelOpen ? '收起工作面板' : '展开工作面板'}
        style={{
          position: 'absolute', top: 12, right: 12, zIndex: 20,
          width: 32, height: 32, borderRadius: 'var(--radius-md)',
          background: 'var(--bg-card)', border: '1px solid var(--border-subtle)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: 'var(--text-tertiary)', cursor: 'pointer',
          backdropFilter: 'blur(8px)',
        }}
      >
        <PanelRight size={16} />
      </motion.button>
    </>
  )
}
