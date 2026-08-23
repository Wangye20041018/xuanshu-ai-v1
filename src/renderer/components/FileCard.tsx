import { motion } from 'framer-motion'
import { FileText, Video, Music } from 'lucide-react'

interface FileCardProps {
  path: string
  variant?: 'file' | 'video' | 'audio'
}

/**
 * 文件/视频卡片：深色圆角卡片风格，hover 微动效。
 * 用于消息流中渲染 [文件:path] / [视频:path] 占位引用。
 */
export default function FileCard({ path, variant = 'file' }: FileCardProps) {
  const fileName = path.split(/[\\/]/).pop() || path
  const dir = path.includes('/') || path.includes('\\')
    ? path.replace(/[\\/][^\\/]+$/, '')
    : '本地文件'
  const Icon = variant === 'video' ? Video : variant === 'audio' ? Music : FileText

  if (variant === 'audio') {
    return (
      <motion.div
        whileHover={{ scale: 1.02, borderColor: 'var(--border-strong)' }}
        transition={{ duration: 0.2 }}
        style={{
          marginTop: 6,
          padding: '12px 16px',
          borderRadius: 'var(--radius-md)',
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border-subtle)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
          <div
            style={{
              width: 36, height: 36,
              borderRadius: 'var(--radius-sm)',
              background: 'var(--bg-hover)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: 'var(--brand-light)',
              flexShrink: 0,
            }}
          >
            <Music size={18} />
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 500, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {fileName}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {dir}
            </div>
          </div>
        </div>
        <audio controls style={{ width: '100%', maxWidth: 400, borderRadius: 'var(--radius-sm)' }}>
          <source src={`local-file://${path.replace(/\\/g, '/')}`} />
        </audio>
      </motion.div>
    )
  }

  return (
    <motion.div
      whileHover={{ scale: 1.02, borderColor: 'var(--border-strong)' }}
      transition={{ duration: 0.2 }}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        marginTop: 6,
        padding: '12px 16px',
        borderRadius: 'var(--radius-md)',
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border-subtle)',
        cursor: 'default',
      }}
    >
      <div
        style={{
          width: 36,
          height: 36,
          borderRadius: 'var(--radius-sm)',
          background: 'var(--bg-hover)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--brand-light)',
          flexShrink: 0,
        }}
      >
        <Icon size={18} />
      </div>
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            fontSize: 14,
            fontWeight: 500,
            color: 'var(--text-primary)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {fileName}
        </div>
        <div
          style={{
            fontSize: 12,
            color: 'var(--text-tertiary)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {dir}
        </div>
      </div>
    </motion.div>
  )
}
