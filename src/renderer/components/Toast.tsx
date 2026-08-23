import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { CheckCircle, XCircle, AlertCircle, Info, X } from 'lucide-react'

type ToastType = 'success' | 'error' | 'warning' | 'info'

interface Toast {
  id: number
  type: ToastType
  message: string
}

// M-17 修复：模块级订阅器替代单个可变闭包，避免多实例竞态与内存泄漏
type ToastListener = (type: ToastType, message: string) => void
const listeners = new Set<ToastListener>()

export function showToast(type: ToastType, message: string) {
  listeners.forEach(listener => listener(type, message))
}

// 监听 preload `invokeSafe` 派发的 IPC 失败事件，统一转为全局 toast，
// 避免各列表页 IPC 失败静默、用户无感知。
if (typeof window !== 'undefined') {
  window.addEventListener('xuanshu:ipc-error', ((e: Event) => {
    const detail = (e as CustomEvent).detail as { channel?: string; message?: string } | undefined
    if (detail?.message) {
      showToast('error', detail.channel ? `[${detail.channel}] ${detail.message}` : detail.message)
    }
  }) as EventListener)
}

export function ToastContainer() {
  const [toasts, setToasts] = useState<Toast[]>([])

  useEffect(() => {
    // 追踪所有自动关闭定时器，卸载时统一清理，避免卸载后仍 setState
    const timers = new Set<ReturnType<typeof setTimeout>>()
    const listener: ToastListener = (type, message) => {
      const toast = { id: Date.now() + Math.random(), type, message }
      setToasts(prev => [...prev, toast])
      const timer = setTimeout(() => {
        timers.delete(timer)
        setToasts(prev => prev.filter(t => t.id !== toast.id))
      }, 4000)
      timers.add(timer)
    }
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
      timers.forEach(t => clearTimeout(t))
      timers.clear()
    }
  }, [])
  
  const icons: Record<ToastType, React.ReactNode> = {
    success: <CheckCircle size={16} color="#10b981" />,
    error: <XCircle size={16} color="#ef4444" />,
    warning: <AlertCircle size={16} color="#f59e0b" />,
    info: <Info size={16} color="#b0b0ba" />,
  }
  
  const colors: Record<ToastType, string> = {
    success: '#10b981', error: '#ef4444', warning: '#f59e0b', info: '#b0b0ba',
  }
  
  return (
    <div style={{ position: 'fixed', top: 60, right: 20, zIndex: 99999, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <AnimatePresence>
        {toasts.map(toast => (
          <motion.div
            key={toast.id}
            initial={{ opacity: 0, x: 100, scale: 0.9 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            exit={{ opacity: 0, x: 100, scale: 0.9 }}
            transition={{ duration: 0.25 }}
            style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '12px 18px', borderRadius: 14,
              background: 'rgba(0,0,0,0.85)', border: `1px solid ${colors[toast.type]}40`,
              color: '#e4e8ee', fontSize: 13, maxWidth: 340,
              boxShadow: `0 8px 32px rgba(0,0,0,0.5), 0 0 4px ${colors[toast.type]}20`,
              backdropFilter: 'blur(20px)',
            }}
          >
            {icons[toast.type]}
            <span style={{ flex: 1 }}>{toast.message}</span>
            <button onClick={() => setToasts(prev => prev.filter(t => t.id !== toast.id))} style={{ border: 'none', background: 'none', color: 'rgba(255,255,255,0.3)', cursor: 'pointer', padding: 2 }}>
              <X size={14} />
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  )
}
