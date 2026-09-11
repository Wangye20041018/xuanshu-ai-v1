/**
 * StepItem —— 单条任务步骤行（高 34，左圆点列 22px + 1px 竖向引导线）
 * 标题颜色随状态弱化；running 显示实时 detail，failed 显示红色 detail。
 */
import type { StepView } from './types'
import StepDot from './StepDot'

const TITLE_COLOR: Record<StepView['status'], string> = {
  pending: 'var(--text-tertiary)',
  running: 'var(--text-primary)',
  done: 'var(--text-secondary)',
  failed: 'var(--status-failed)',
}

export default function StepItem({ step, isLast }: { step: StepView; isLast: boolean }) {
  const showDetail = !!step.detail && (step.status === 'failed' || step.status === 'running')

  return (
    <div style={{ display: 'flex', gap: 8, minHeight: 'var(--step-row-h)', position: 'relative' }}>
      {/* 圆点列：居中圆点 + 连接下一项的竖向引导线 */}
      <div style={{ width: 22, flexShrink: 0, display: 'flex', justifyContent: 'center', position: 'relative' }}>
        <StepDot status={step.status} />
        {!isLast && (
          <span
            aria-hidden
            style={{
              position: 'absolute',
              left: '50%',
              top: 17,
              bottom: -2,
              width: 1,
              transform: 'translateX(-0.5px)',
              background: 'var(--border-default)',
            }}
          />
        )}
      </div>

      <div style={{ flex: 1, minWidth: 0, paddingBottom: 6 }}>
        <div
          style={{
            fontSize: 13,
            lineHeight: '18px',
            fontWeight: step.status === 'running' ? 500 : 400,
            color: TITLE_COLOR[step.status],
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={step.title}
        >
          {step.title}
        </div>
        {showDetail && (
          <div
            style={{
              marginTop: 2,
              fontSize: 11.5,
              lineHeight: 1.5,
              color: step.status === 'failed' ? 'var(--status-failed)' : 'var(--text-tertiary)',
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
            }}
          >
            {step.detail}
          </div>
        )}
      </div>
    </div>
  )
}
