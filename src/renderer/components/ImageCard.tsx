import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Image as ImageIcon, Download, X, ZoomIn } from 'lucide-react'

interface ImageCardProps {
  path: string
}

/**
 * 图片卡片：深色圆角卡片，加载失败时回退为占位图标。
 * 用于消息流中渲染 [图片:path] 占位引用。支持点击放大预览与保存到本地。
 */
export default function ImageCard({ path }: ImageCardProps) {
  const [errored, setErrored] = useState(false)
  const [preview, setPreview] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savedMsg, setSavedMsg] = useState<string | null>(null)
  const src =
    path.startsWith('http://') || path.startsWith('https://')
      ? path
      : `local-file://${path.replace(/\\/g, '/')}`
  const fileName = path.split(/[\\/]/).pop() || path

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPreview(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const handleSave = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!window.api) return
    setSaving(true)
    try {
      const res = await window.api.invoke<{ success: boolean; canceled?: boolean; error?: string }>('app:save-file', { source: path, defaultName: fileName })
      if (res?.success) {
        setSavedMsg('已保存')
        setTimeout(() => setSavedMsg(null), 2000)
      } else if (res?.canceled) {
        // 用户取消保存，无需提示
      } else {
        setSavedMsg(res?.error || '保存失败')
        setTimeout(() => setSavedMsg(null), 3000)
      }
    } catch {
      setSavedMsg('保存失败')
      setTimeout(() => setSavedMsg(null), 3000)
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
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
          <div style={{ position: 'relative', cursor: 'zoom-in' }} onClick={() => setPreview(true)}>
            <img
              src={src}
              alt={fileName}
              onError={() => setErrored(true)}
              style={{ display: 'block', width: '100%', maxHeight: 220, objectFit: 'cover' }}
            />
            <div
              style={{
                position: 'absolute', right: 8, top: 8,
                display: 'flex', gap: 6, opacity: 0, transition: 'opacity .15s',
                background: 'rgba(20,20,22,0.62)', borderRadius: 8, padding: 4,
                backdropFilter: 'blur(3px)',
              }}
              className="img-card-actions"
            >
              <button
                onClick={handleSave}
                disabled={saving}
                title="保存到本地"
                aria-label="保存图片"
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#fff', padding: 4, display: 'flex', alignItems: 'center' }}
              >
                <Download size={14} />
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); setPreview(true) }}
                title="放大预览"
                aria-label="放大预览"
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#fff', padding: 4, display: 'flex', alignItems: 'center' }}
              >
                <ZoomIn size={14} />
              </button>
            </div>
          </div>
        )}
        <div style={{ padding: '6px 12px', fontSize: 12, color: 'var(--text-tertiary)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{fileName}</span>
          {savedMsg && <span style={{ color: 'var(--success)', fontSize: 11, flexShrink: 0 }}>{savedMsg}</span>}
        </div>
      </motion.div>

      {/* 放大预览浮层 */}
      <AnimatePresence>
        {preview && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            onClick={() => setPreview(false)}
            style={{
              position: 'fixed', inset: 0, zIndex: 999,
              background: 'rgba(10,10,12,0.82)', backdropFilter: 'blur(6px)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'zoom-out',
            }}
          >
            <button
              onClick={(e) => { e.stopPropagation(); setPreview(false) }}
              aria-label="关闭预览"
              style={{
                position: 'absolute', top: 18, right: 18, width: 36, height: 36, borderRadius: '50%',
                background: 'rgba(255,255,255,0.12)', border: 'none', cursor: 'pointer',
                color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}
            ><X size={18} /></button>
            <img
              src={src}
              alt={fileName}
              onClick={(e) => e.stopPropagation()}
              style={{ maxWidth: '88vw', maxHeight: '86vh', objectFit: 'contain', borderRadius: 10, boxShadow: '0 20px 80px rgba(0,0,0,0.6)' }}
            />
            <button
              onClick={handleSave}
              style={{
                position: 'absolute', bottom: 24, left: '50%', transform: 'translateX(-50%)',
                padding: '8px 20px', borderRadius: 20, background: 'rgba(255,255,255,0.14)',
                border: '1px solid rgba(255,255,255,0.25)', color: '#fff', cursor: 'pointer',
                fontSize: 13, display: 'flex', alignItems: 'center', gap: 6,
              }}
            ><Download size={14} /> 保存图片</button>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}
