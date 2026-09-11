/**
 * TaskStepTimeline —— 任务步骤竖向清单（StepItem 序列，圆点间以引导线相连）
 */
import type { StepView } from './types'
import StepItem from './StepItem'

export default function TaskStepTimeline({ steps }: { steps: Array<StepView> }) {
  if (steps.length === 0) {return null}
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {steps.map((s, i) => (
        <StepItem key={s.stepId} step={s} isLast={i === steps.length - 1} />
      ))}
    </div>
  )
}
