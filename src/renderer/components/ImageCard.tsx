import { useState } from 'react'
import { motion } from 'framer-motion'
import { Image as ImageIcon } from 'lucide-react'

interface ImageCardProps {
  path: string
}

/**
 * 图片缩略卡片：深色圆角卡片，加载失败时回退为占位图标。
 * 用于消息流中渲染 [图片:path] 占位引用。
 */
export default function ImageCard({ path }: ImageCardProps) {
  const [errored, setErrored] = useState(false)
  const src =
    path.startsWith('http://') || path.startsWith('https://')
      ? path
      : `local-file://${path.replace(/\\/g, '/')}`
  const fileName = path.split(/[\\/]/).pop() || path

  return (
    <motion.div
      whileHover={{ scale: 1.02 }}
      transition={{ duration: 0.2 }}
      style={{
        marginTop: 6,
        borderRadius: 'var(--radius-md)',
        overflow: 'hidden',
        border: '1px solid var(--border-subtle)',
        background: 'var(--bg-elevated)',
      }}
    >
      {errored ? (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 6,
            padding: '24px',
            color: 'var(--text-tertiary)',
          }}
        >
          <ImageIcon size={24} />
          <span style={{ fontSize: 12 }}>{fileName}</span>
        </div>
      ) : (
        <img
          src={src}
          alt={fileName}
          onError={() => setErrored(true)}
          style={{ display: 'block', width: '100%', maxHeight: 220, objectFit: 'cover' }}
        />
      )}
      <div style={{ padding: '6px 12px', fontSize: 12, color: 'var(--text-tertiary)' }}>{fileName}</div>
    </motion.div>
  )
}
