/**
 * StepDot —— 任务步骤四态圆点（仿 Trae，18px、无发光）
 * pending 空心灰圈 / running 蓝色 Loader2 旋转 / done 淡绿底绿勾 / failed 淡红底红叉
 */
import { Loader2, Check, X } from 'lucide-react'
import type { StepStatus } from './types'

const DOT = 18

export default function StepDot({ status }: { status: StepStatus }) {
  const base: React.CSSProperties = {
    width: DOT,
    height: DOT,
    borderRadius: '50%',
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  }

  if (status === 'running') {
    return (
      <span style={{ ...base, background: 'var(--status-running-dim)' }}>
        <Loader2 size={13} className="animate-spin" style={{ color: 'var(--status-running)' }} />
      </span>
    )
  }
  if (status === 'done') {
    return (
      <span style={{ ...base, background: 'var(--status-done-dim)' }}>
        <Check size={12} strokeWidth={2.6} style={{ color: 'var(--status-done)' }} />
      </span>
    )
  }
  if (status === 'failed') {
    return (
      <span style={{ ...base, background: 'var(--status-failed-dim)' }}>
        <X size={12} strokeWidth={2.6} style={{ color: 'var(--status-failed)' }} />
      </span>
    )
  }
  // pending：空心灰圈
  return (
    <span style={{ ...base, background: 'transparent', border: '1.5px solid var(--status-pending)' }} />
  )
}
