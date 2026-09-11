/**
 * ToolCallLine —— 工具调用「过程行」（仿 Trae：聚合为一行、可展开）
 * 折叠态：进行中 spinner / 完成统计；展开态：逐条列出工具标签 + 参数摘要 + 状态小图标。
 * 后端无 callId，列表数据来自 taskRunStore 的 LIFO 配对结果。
 */
import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Loader2, Check, X, ChevronDown, Wrench } from 'lucide-react'
import { toolLabel, type ToolCallView } from './types'

function ToolStateIcon({ status }: { status: ToolCallView['status'] }) {
  if (status === 'start') {return <Loader2 size={12} className="animate-spin" style={{ color: 'var(--status-running)' }} />}
  if (status === 'error') {return <X size={12} style={{ color: 'var(--status-failed)' }} />}
  return <Check size={12} style={{ color: 'var(--status-done)' }} />
}

export default function ToolCallLine({ tools }: { tools: Array<ToolCallView> }) {
  const [expanded, setExpanded] = useState(false)
  if (tools.length === 0) {return null}

  const running = tools.filter((t) => t.status === 'start').length
  const errored = tools.filter((t) => t.status === 'error').length
  const done = tools.filter((t) => t.status === 'done').length
  const busy = running > 0

  // 折叠态聚合摘要
  const summary = busy
    ? `正在调用工具… 已完成 ${done} 项${running ? ` · 进行中 ${running}` : ''}`
    : `已调用 ${done + errored} 项工具${errored ? ` · ${errored} 项失败` : ''}`

  return (
    <div style={{ borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
      <button
        onClick={() => setExpanded((v) => !v)}
        style={{
          width: '100%',
          height: 'var(--proc-line-h)',
          display: 'flex',
          alignItems: 'center',
          gap: 7,
          padding: '0 8px',
          background: expanded ? 'var(--bg-hover)' : 'transparent',
          border: 'none',
          borderRadius: 'var(--radius-md)',
          cursor: 'pointer',
          color: errored && !busy ? 'var(--text-secondary)' : 'var(--text-tertiary)',
          fontSize: 13,
          textAlign: 'left',
        }}
        onMouseEnter={(e) => { if (!expanded) {e.currentTarget.style.background = 'var(--bg-hover)'} }}
        onMouseLeave={(e) => { if (!expanded) {e.currentTarget.style.background = 'transparent'} }}
      >
        {busy
          ? <Loader2 size={13} className="animate-spin" style={{ color: 'var(--status-running)', flexShrink: 0 }} />
          : errored
            ? <Wrench size={13} style={{ color: 'var(--status-failed)', flexShrink: 0 }} />
            : <Wrench size={13} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />}
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {summary}
        </span>
        <ChevronDown
          size={13}
          style={{ flexShrink: 0, transition: 'transform 160ms ease', transform: expanded ? 'rotate(180deg)' : 'none' }}
        />
      </button>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
            style={{ overflow: 'hidden' }}
          >
            <div style={{ display: 'flex', flexDirection: 'column', padding: '2px 8px 4px' }}>
              {tools.map((t) => (
                <div
                  key={t.uid}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 7,
                    minHeight: 24,
                    fontSize: 12.5,
                  }}
                >
                  <span style={{ flexShrink: 0, display: 'inline-flex' }}>
                    <ToolStateIcon status={t.status} />
                  </span>
                  <span style={{ flexShrink: 0, color: 'var(--text-secondary)', fontWeight: 500 }}>
                    {toolLabel(t.tool)}
                  </span>
                  <span
                    style={{
                      flex: 1,
                      minWidth: 0,
                      color: 'var(--text-tertiary)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                    title={t.argsSummary}
                  >
                    {t.argsSummary}
                  </span>
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
