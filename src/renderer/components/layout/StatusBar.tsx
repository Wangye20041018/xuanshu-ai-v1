import { useState, useEffect } from 'react'
import { Cpu, MemoryStickIcon as Memory, HardDrive, Globe, WifiOff } from 'lucide-react'
import RouteStatusIndicator from '../RouteStatusIndicator'
import { logger } from '../../../shared/logger'

interface PerfStats {
  cpu: { usage: number; cores: number }
  memory: { used: number; total: number; free: number }
  gpu: { usage: number; memoryUsed: number; memoryTotal: number; name?: string }
}

function StatusBar() {
  const [stats, setStats] = useState<PerfStats>({
    cpu: { usage: 0, cores: 0 },
    memory: { used: 0, total: 32, free: 32 },
    gpu: { usage: 0, memoryUsed: 0, memoryTotal: 6144 },
  })
  const [isOnline, setIsOnline] = useState<boolean | null>(null)

  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | null = null
    // 修复：组件卸载后异步请求可能才返回，此时 setState 会触发
    // 「unmounted component 上更新状态」的内存泄漏告警。
    let cancelled = false

    const fetch = async () => {
      if (!window.api || cancelled) return
      try {
        const d = await window.api.invoke<PerfStats>('device:stats').catch(() => null)
        if (d && !cancelled) {
          setStats({
            cpu: typeof d.cpu === 'object' && d.cpu !== null ? d.cpu : { usage: typeof d.cpu === 'number' ? d.cpu : 0, cores: 0 },
            memory: d.memory || { used: 0, total: 32, free: 32 },
            gpu: d.gpu || { usage: 0, memoryUsed: 0, memoryTotal: 6144 },
          })
        }
      } catch (e) { logger.error('[StatusBar] 获取系统状态失败:', e) }
      if (cancelled) return
      try {
        const s = await window.api.invoke<{ online: boolean }>('search:get-status')
        if (s && !cancelled) setIsOnline(s.online)
      } catch (e) {
        logger.error('[StatusBar] 获取搜索状态失败:', e)
        if (!cancelled) setIsOnline(false)
      }
    }

    const stopPolling = () => {
      if (interval) { clearInterval(interval); interval = null }
    }
    const startPolling = () => {
      if (cancelled) return
      // 修复：保证幂等 —— 若 visibilitychange 在可见状态下重复派发，
      // 不先清理会丢失旧 interval 引用，导致定时器泄漏与重复轮询。
      stopPolling()
      fetch()
      interval = setInterval(fetch, 10000)
    }

    startPolling()
    const handleVisibility = () => {
      if (document.hidden) { stopPolling() }
      else { startPolling() }
    }
    document.addEventListener('visibilitychange', handleVisibility)

    return () => {
      cancelled = true
      stopPolling()
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [])

  const cpu = stats.cpu?.usage ?? 0
  const mem = stats.memory.total > 0 ? Math.round((stats.memory.used / stats.memory.total) * 100) : 0
  const gpuMem = stats.gpu.memoryTotal > 0 ? Math.round((stats.gpu.memoryUsed / stats.gpu.memoryTotal) * 100) : 0

  const barColor = (v: number) => v > 80 ? 'var(--danger)' : v > 50 ? 'var(--warning)' : 'var(--brand)'

  const Stat = ({ icon, value, pct }: { icon: React.ReactNode; value: string; pct: number }) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
      {icon}
      <div style={{ width: 36, height: 3, borderRadius: 2, background: 'var(--bg-active)', overflow: 'hidden' }}>
        <div style={{ width: `${Math.min(pct, 100)}%`, height: '100%', borderRadius: 2, background: barColor(pct), transition: 'width 0.8s ease' }} />
      </div>
      <span>{value}</span>
    </div>
  )

  return (
    <div className="app-statusbar">
      <Stat icon={<Cpu size={11} />} value={`${cpu}%`} pct={cpu} />
      <Stat icon={<Memory size={11} />} value={`${stats.memory.used?.toFixed(0) ?? '0'}/${stats.memory.total?.toFixed(0) ?? '0'}G`} pct={mem} />
      <Stat icon={<HardDrive size={11} />} value={stats.gpu.memoryTotal > 0 ? `${gpuMem}%` : '不可用'} pct={gpuMem} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        {isOnline ? <Globe size={11} style={{ color: 'var(--brand)' }} /> : <WifiOff size={11} />}
        <span style={{ color: isOnline ? 'var(--brand)' : 'var(--text-tertiary)' }}>
          {isOnline === null ? '-' : isOnline ? '在线' : '离线'}
        </span>
      </div>
      <RouteStatusIndicator />
    </div>
  )
}

export default StatusBar
