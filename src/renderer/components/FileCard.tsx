import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { FileText, Video, Music, PlayCircle, ChevronDown, ExternalLink } from 'lucide-react'

interface FileCardProps {
  path: string
  variant?: 'file' | 'video' | 'audio'
}

/**
 * 文件/视频/音频卡片：深色圆角卡片风格，hover 微动效。
 * 用于消息流中渲染 [文件:path] / [视频:path] / [音频:path] 占位引用。
 * 视频卡片支持点击展开内嵌播放器。
 */
export default function FileCard({ path, variant = 'file' }: FileCardProps) {
  const [expanded, setExpanded] = useState(false)
  const fileName = path.split(/[\\/]/).pop() || path
  const dir = path.includes('/') || path.includes('\\')
    ? path.replace(/[\\/][^\\/]+$/, '')
    : '本地文件'
  const Icon = variant === 'video' ? Video : variant === 'audio' ? Music : FileText

  const src =
    path.startsWith('http://') || path.startsWith('https://')
      ? path
      : `local-file://${path.replace(/\\/g, '/')}`

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
          <source src={src} />
        </audio>
      </motion.div>
    )
  }

  if (variant === 'video') {
    return (
      <motion.div
        whileHover={{ scale: 1.02, borderColor: 'var(--border-strong)' }}
        transition={{ duration: 0.2 }}
        style={{
          marginTop: 6,
          borderRadius: 'var(--radius-md)',
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border-subtle)',
          overflow: 'hidden',
        }}
      >
        <div
          onClick={() => setExpanded(!expanded)}
          style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', cursor: 'pointer' }}
          title={expanded ? '收起播放器' : '点击播放视频'}
        >
          <div
            style={{
              position: 'relative',
              width: 36, height: 36,
              borderRadius: 'var(--radius-sm)',
              background: 'var(--bg-hover)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: 'var(--brand-light)',
              flexShrink: 0,
            }}
          >
            <Video size={18} />
            {!expanded && (
              <PlayCircle size={20} style={{ position: 'absolute', right: -6, bottom: -6, color: 'var(--brand)', background: 'var(--bg-elevated)', borderRadius: '50%' }} />
            )}
          </div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 14, fontWeight: 500, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {fileName}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {dir}
            </div>
          </div>
          <ChevronDown size={16} style={{ color: 'var(--text-tertiary)', transform: expanded ? 'rotate(180deg)' : undefined, transition: 'transform .2s', flexShrink: 0 }} />
        </div>
        <AnimatePresence>
          {expanded && (
            <motion.div
              initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.25 }}
              style={{ borderTop: '1px solid var(--border-subtle)' }}
            >
              <video
                controls
                style={{ display: 'block', width: '100%', maxHeight: 380, background: '#000' }}
                onClick={(e) => e.stopPropagation()}
              >
                <source src={src} />
                您的浏览器不支持视频播放
              </video>
              <div style={{ padding: '8px 12px', display: 'flex', justifyContent: 'flex-end' }}>
                <a
                  href={src}
                  target="_blank"
                  rel="noreferrer"
                  style={{ fontSize: 12, color: 'var(--text-tertiary)', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 4 }}
                >
                  <ExternalLink size={12} /> 新窗口打开
                </a>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
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
