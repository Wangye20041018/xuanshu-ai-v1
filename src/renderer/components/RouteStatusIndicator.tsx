/**
 * 路由状态指示器（v10.2，P1-4）
 *
 * 常驻状态栏的三态灯 + 模型切换 toast：
 *   🟢 对话态（VL-7B 常驻）  🟡 质量态（Qwen2-VL-2B）  🔵 视觉态（VL-7B 自带视觉，方案X）
 *
 * 数据来自主进程 task-router 广播的 'router:state' / 'router:toast'。
 * 视觉态（方案X）不提示"模型切换"，仅提示"视觉已就绪"（由主进程控制 toast 文案）。
 */

import { useEffect, useState } from 'react'
import { logger } from '../../shared/logger'
import { showToast } from './Toast'

type GpuState = 'main' | 'quality' | 'vision' | null

interface RouterState {
  gpuType: GpuState
  tier: string
  reason: string
  ts: number
}

function RouteStatusIndicator() {
  const [state, setState] = useState<RouterState>({ gpuType: 'main', tier: 'fast', reason: '', ts: 0 })

  useEffect(() => {
    if (!window.api) return
    const offState = window.api.on('router:state', ((_e: unknown, s: RouterState) => setState(s)) as any)
    const offToast = window.api.on('router:toast', (((_e: unknown, t: { message: string }) => {
      // 统一转发到全局 Toast（去除本地重复实现的底部提示条）
      if (t?.message) showToast('info', t.message)
    }) as any))
    // 拉取一次当前真实状态，避免首帧显示写死默认值
    window.api.invoke('router:get-state').then((s: any) => {
      if (s && s.gpuType !== undefined) {
        setState({ gpuType: s.gpuType, tier: s.tier || 'fast', reason: '', ts: Date.now() })
      }
    }).catch((e) => { logger.error(`[RouteStatus] 获取路由状态失败: ${e}`) })
    return () => {
      offState()
      offToast()
    }
  }, [])

  // 方案X：vision 任务 gpuType 恒为 'main'（VL-7B 常驻），但 payload 带 tier:'vision'，
  // 故以 state.tier 为首要判定依据，tier==='vision' 一律显示视觉态；
  // 其余情况回退到 gpuType（fast/quality 仍按主/质量态显示 🟢/🟡）。
  const active = state.tier === 'vision' ? 'vision' : (state.gpuType || 'main')
  const glyph = active === 'quality' ? '🟡' : active === 'vision' ? '🔵' : '🟢'
  const label = active === 'quality' ? '质量态' : active === 'vision' ? '视觉态' : '对话态'
  const hint =
    active === 'quality'
      ? 'Qwen2-VL-2B · ~50–65 tok/s'
      : active === 'vision'
      ? 'VL-7B 视觉 · 零驱逐'
      : 'VL-7B · 40–60 tok/s'

  return (
    <>
      <div
        title={`${label} · ${hint}${state.reason ? '\n' + state.reason : ''}`}
        style={{ display: 'flex', alignItems: 'center', gap: 4, marginLeft: 10, WebkitAppRegion: 'no-drag' } as any}
      >
        <span style={{ fontSize: 11, lineHeight: 1 }}>{glyph}</span>
        <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{label}</span>
      </div>
    </>
  )
}

export default RouteStatusIndicator
