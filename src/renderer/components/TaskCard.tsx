import { useState } from 'react'
import { ChevronRight, Plus, Square } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'

/* ============================================================
 * TaskCard — 任务执行卡片
 *
 * 渲染结构（参考 AI 任务卡片截图）：
 *   ┌────────────────────────────────────────────┐
 *   │ ● 任务标题（带 › 箭头，可展开/收起详情） 状态 │
 *   │ 单行当前动作摘要（超长省略）                  │
 *   │ 当前阶段名                    60%            │
 *   │ ▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░   │
 *   │ [ + 追加消息 ]  [ ■ 结束任务 ]               │
 *   └────────────────────────────────────────────┘
 *
 * 消息数据格式（assistant 消息 content 为 JSON 字符串）：
 *   {"_task":true, taskId?, title, stage, progress, summary, detail?, status?}
 * ============================================================ */

export interface TaskCardData {
  _task: true
  taskId?: string
  title: string
  /** 当前阶段名 */
  stage: string
  /** 进度百分比 0-100 */
  progress: number
  /** 单行当前动作摘要 */
  summary: string
  /** 展开后的详情文本（可选） */
  detail?: string
  /** 任务状态 */
  status?: 'running' | 'completed' | 'error' | 'cancelled'
}

interface TaskCardProps {
  task: TaskCardData
  /** 追加消息回调（向任务追加指令） */
  onAppend?: (task: TaskCardData) => void
  /** 结束任务回调（终止任务） */
  onEnd?: (task: TaskCardData) => void
}

const STATUS_META: Record<string, { color: string; label: string }> = {
  running: { color: 'var(--brand)', label: '执行中' },
  completed: { color: '#22c55e', label: '已完成' },
  error: { color: '#ef4444', label: '失败' },
  cancelled: { color: 'var(--text-tertiary)', label: '已取消' },
}

export default function TaskCard({ task, onAppend, onEnd }: TaskCardProps) {
  const [expanded, setExpanded] = useState(false)
  const status = task.status || 'running'
  const meta = STATUS_META[status] || STATUS_META.running
  const progress = Math.max(0, Math.min(100, Number(task.progress) || 0))
  const done = status === 'completed' || status === 'cancelled'

  return (
    <div
      style={{
        borderRadius: 'var(--radius-2xl)',
        background: 'rgba(40,40,42,0.55)',
        border: '1px solid var(--border-card)',
        backdropFilter: 'blur(10px)',
        WebkitBackdropFilter: 'blur(10px)',
        overflow: 'hidden',
        maxWidth: '100%',
        boxShadow: 'var(--shadow-sm)',
      }}
    >
      {/* 标题行（点击展开/收起详情） */}
      <div
        onClick={() => setExpanded(!expanded)}
        style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '12px 16px', cursor: 'pointer', userSelect: 'none',
        }}
      >
        <span
          style={{
            width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
            background: meta.color, boxShadow: `0 0 8px ${meta.color}66`,
          }}
        />
        <span
          style={{
            flex: 1, fontSize: 14, fontWeight: 600, color: 'var(--text-primary)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}
        >
          {task.title}
        </span>
        <span style={{ fontSize: 11, color: meta.color, flexShrink: 0 }}>{meta.label}</span>
        <motion.span
          animate={{ rotate: expanded ? 90 : 0 }}
          transition={{ duration: 0.2 }}
          style={{ display: 'flex', color: 'var(--text-tertiary)', flexShrink: 0 }}
        >
          <ChevronRight size={16} />
        </motion.span>
      </div>

      {/* 单行动作摘要 */}
      <div style={{ padding: '0 16px 10px' }}>
        <div
          style={{
            fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}
        >
          {task.summary}
        </div>
      </div>

      {/* 阶段进度条 */}
      <div style={{ padding: '0 16px 12px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <span style={{ fontSize: 12, color: 'var(--text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginRight: 8 }}>
            {task.stage}
          </span>
          <span style={{ fontSize: 12, color: 'var(--text-secondary)', fontWeight: 600, flexShrink: 0 }}>
            {Math.round(progress)}%
          </span>
        </div>
        <div style={{ height: 4, borderRadius: 999, background: 'var(--bg-hover)', overflow: 'hidden' }}>
          <motion.div
            initial={{ width: 0 }}
            animate={{ width: `${progress}%` }}
            transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
            style={{ height: '100%', borderRadius: 999, background: meta.color }}
          />
        </div>
      </div>

      {/* 展开详情 */}
      <AnimatePresence initial={false}>
        {expanded && task.detail && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
            style={{ overflow: 'hidden' }}
          >
            <div
              style={{
                margin: '0 16px 12px', padding: '10px 12px',
                borderRadius: 'var(--radius-md)', background: 'var(--bg-base)',
                border: '1px solid var(--border-subtle)',
                fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6,
                whiteSpace: 'pre-wrap', maxHeight: 200, overflowY: 'auto',
              }}
            >
              {task.detail}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 底部操作按钮（任务结束后隐藏） */}
      {!done && (
        <div style={{ display: 'flex', gap: 8, padding: '10px 16px 12px', borderTop: '1px solid var(--border-subtle)' }}>
          <button
            onClick={() => onAppend?.(task)}
            style={{
              flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
              padding: '7px 12px', borderRadius: 'var(--radius-lg)', cursor: 'pointer',
              background: 'var(--bg-hover)', border: '1px solid var(--border-default)',
              color: 'var(--text-primary)', fontSize: 12, fontWeight: 500,
            }}
          >
            <Plus size={14} /> 追加消息
          </button>
          <button
            onClick={() => onEnd?.(task)}
            style={{
              flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
              padding: '7px 12px', borderRadius: 'var(--radius-lg)', cursor: 'pointer',
              background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.35)',
              color: '#f87171', fontSize: 12, fontWeight: 500,
            }}
          >
            <Square size={12} /> 结束任务
          </button>
        </div>
      )}
    </div>
  )
}
