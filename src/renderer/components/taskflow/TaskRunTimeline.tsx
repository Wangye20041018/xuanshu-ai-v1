/**
 * TaskRunTimeline —— 一次任务运行的顶层过程面板
 * 直接订阅 taskRunStore：状态概括行 + 工具调用聚合过程行 + 步骤时间线。
 * 无步骤也无工具时不渲染。挂载点见对话流（批次2）。
 */
import { Loader2, CheckCircle2, AlertTriangle } from 'lucide-react'
import { useTaskRunStore } from '../../store/taskRunStore'
import ToolCallLine from './ToolCallLine'
import TaskStepTimeline from './TaskStepTimeline'

export default function TaskRunTimeline() {
  const run = useTaskRunStore((s) => s.run)
  if (!run) {return null}

  const hasSteps = run.steps.length > 0
  const hasTools = run.tools.length > 0
  if (!hasSteps && !hasTools) {return null}

  const hasFailed = run.steps.some((s) => s.status === 'failed') || run.tools.some((t) => t.status === 'error')

  return (
    <div
      style={{
        width: '100%',
        margin: '4px 0 12px',
        padding: '10px 12px 8px',
        borderRadius: 'var(--radius-2xl)',
        background: 'var(--bg-surface)',
        border: '1px solid var(--border-subtle)',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
      }}
    >
      {/* 状态概括行 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, height: 22, fontSize: 12, fontWeight: 500 }}>
        {run.active ? (
          <>
            <Loader2 size={13} className="animate-spin" style={{ color: 'var(--status-running)' }} />
            <span style={{ color: 'var(--status-running)' }}>任务进行中</span>
          </>
        ) : hasFailed ? (
          <>
            <AlertTriangle size={13} style={{ color: 'var(--status-failed)' }} />
            <span style={{ color: 'var(--status-failed)' }}>任务存在失败步骤</span>
          </>
        ) : (
          <>
            <CheckCircle2 size={13} style={{ color: 'var(--status-done)' }} />
            <span style={{ color: 'var(--status-done)' }}>任务完成</span>
          </>
        )}
      </div>

      {hasTools && <ToolCallLine tools={run.tools} />}
      {hasSteps && <TaskStepTimeline steps={run.steps} />}
    </div>
  )
}
