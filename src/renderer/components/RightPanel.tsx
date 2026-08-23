import { useState, type ReactNode } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  ListTodo, FolderOpen, FileText, Globe, ChevronRight,
  CheckCircle2, Circle, ExternalLink, X, Plus, Hash
} from 'lucide-react'
import ErrorBoundary from './ErrorBoundary'

/* ================================================================
 * TRAE 风格右侧面板 — 代办/上下文/文件/联网搜索
 * ================================================================ */

interface RightPanelProps {
  onClose?: () => void
}

/* ---- 面板数据接口 ---- */
interface TodoItem {
  id: string
  text: string
  done: boolean
}

interface ContextRef {
  id: string
  type: 'file' | 'folder' | 'code'
  label: string
  path: string
}

interface FileRef {
  id: string
  name: string
  type: 'image' | 'document' | 'code' | 'other'
  size?: string
}

interface WebResult {
  id: string
  title: string
  url: string
  snippet: string
}

/* ---- 初始化数据（从会话状态动态加载） ---- */
const INIT_TODOS: TodoItem[] = []
const INIT_CONTEXTS: ContextRef[] = []
const INIT_FILES: FileRef[] = []

/* ---- 面板区块组件 ---- */
function PanelSection({
  icon, title, count, defaultOpen = true, children,
}: {
  icon: ReactNode; title: string; count?: number; defaultOpen?: boolean; children: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div style={{ marginBottom: 2 }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          display: 'flex', alignItems: 'center', gap: 6, width: '100%',
          padding: '7px 10px', borderRadius: 'var(--radius-sm)',
          color: 'var(--text-secondary)', fontSize: 12, fontWeight: 600,
          transition: 'background 120ms', cursor: 'pointer',
          letterSpacing: '0.02em',
        }}
        onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
        onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
      >
        <span style={{ display: 'flex', color: 'var(--text-tertiary)' }}>{icon}</span>
        <span style={{ flex: 1, textAlign: 'left' }}>{title}</span>
        {count !== undefined && (
          <span style={{
            fontSize: 10, color: 'var(--text-tertiary)', background: 'var(--bg-hover)',
            padding: '1px 6px', borderRadius: 'var(--radius-full)', fontWeight: 500,
          }}>{count}</span>
        )}
        <motion.span animate={{ rotate: open ? 90 : 0 }} transition={{ duration: 0.15 }}
          style={{ display: 'flex', color: 'var(--text-tertiary)' }}>
          <ChevronRight size={12} />
        </motion.span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
            style={{ overflow: 'hidden' }}
          >
            <div style={{ padding: '2px 4px 4px 16px' }}>{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

/* ---- 代办事项项 ---- */
function TodoRow({ item, onToggle }: { item: TodoItem; onToggle: (id: string) => void }) {
  return (
    <div
      onClick={() => onToggle(item.id)}
      style={{
        display: 'flex', alignItems: 'flex-start', gap: 8, padding: '5px 6px',
        borderRadius: 'var(--radius-sm)', cursor: 'pointer',
        transition: 'background 120ms',
      }}
      onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
      onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
    >
      {item.done ? (
        <CheckCircle2 size={14} style={{ color: 'var(--success)', flexShrink: 0, marginTop: 1 }} />
      ) : (
        <Circle size={14} style={{ color: 'var(--text-tertiary)', flexShrink: 0, marginTop: 1 }} />
      )}
      <span style={{
        fontSize: 12, lineHeight: 1.5, flex: 1,
        color: item.done ? 'var(--text-tertiary)' : 'var(--text-primary)',
        textDecoration: item.done ? 'line-through' : 'none',
      }}>
        {item.text}
      </span>
    </div>
  )
}

/* ---- 上下文引用项 ---- */
function ContextRow({ item }: { item: ContextRef }) {
  const icon = item.type === 'folder'
    ? <FolderOpen size={12} />
    : item.type === 'code'
      ? <Hash size={12} />
      : <FileText size={12} />
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 6, padding: '5px 6px',
      borderRadius: 'var(--radius-sm)', fontSize: 12, color: 'var(--text-secondary)',
      transition: 'background 120ms',
    }}
      onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
      onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
    >
      <span style={{ display: 'flex', color: 'var(--accent)', flexShrink: 0 }}>{icon}</span>
      <span style={{ fontWeight: 500, flexShrink: 0 }}>#{item.type}</span>
      <span style={{ color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {item.label}
      </span>
      <span style={{ color: 'var(--text-tertiary)', fontSize: 10, flexShrink: 0, marginLeft: 'auto' }}>
        {item.path}
      </span>
    </div>
  )
}

/* ---- 文件引用项 ---- */
function FileRow({ item }: { item: FileRef }) {
  const colors: Record<string, string> = {
    image: 'var(--info)',
    document: 'var(--warning)',
    code: 'var(--accent)',
    other: 'var(--text-tertiary)',
  }
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 6, padding: '5px 6px',
      borderRadius: 'var(--radius-sm)', fontSize: 12, color: 'var(--text-secondary)',
      transition: 'background 120ms',
    }}
      onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
      onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
    >
      <FileText size={12} style={{ color: colors[item.type] || 'var(--text-tertiary)', flexShrink: 0 }} />
      <span style={{ color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
        {item.name}
      </span>
      {item.size && (
        <span style={{ color: 'var(--text-tertiary)', fontSize: 10, flexShrink: 0 }}>{item.size}</span>
      )}
    </div>
  )
}

/* ---- 联网搜索项 ---- */
function WebRow({ item }: { item: WebResult }) {
  return (
    <a
      href={item.url}
      target="_blank"
      rel="noopener noreferrer"
      style={{
        display: 'block', padding: '6px', borderRadius: 'var(--radius-sm)',
        textDecoration: 'none', color: 'inherit',
        transition: 'background 120ms',
      }}
      onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
      onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 4 }}>
        <Globe size={12} style={{ color: 'var(--info)', flexShrink: 0, marginTop: 2 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {item.title}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-tertiary)', lineHeight: 1.4, overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
            {item.snippet}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 2, marginTop: 2, fontSize: 10, color: 'var(--text-tertiary)' }}>
            <ExternalLink size={10} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.url}</span>
          </div>
        </div>
      </div>
    </a>
  )
}

/* ---- 空状态 ---- */
function EmptyHint({ text }: { text: string }) {
  return (
    <div style={{ padding: '8px 6px', fontSize: 11, color: 'var(--text-tertiary)', fontStyle: 'italic' }}>
      {text}
    </div>
  )
}

/* ================================================================
 * 主组件
 * ================================================================ */
export default function RightPanel({ onClose }: RightPanelProps) {
  const [todos, setTodos] = useState<TodoItem[]>(INIT_TODOS)
  const [contexts] = useState<ContextRef[]>(INIT_CONTEXTS)
  const [files] = useState<FileRef[]>(INIT_FILES)
  const [webResults] = useState<WebResult[]>([])

  const toggleTodo = (id: string) => {
    setTodos(prev => prev.map(t => t.id === id ? { ...t, done: !t.done } : t))
  }

  const doneCount = todos.filter(t => t.done).length
  const todoCount = todos.length

  return (
    <ErrorBoundary>
    <motion.aside
      initial={{ width: 0, opacity: 0 }}
      animate={{ width: 300, opacity: 1 }}
      exit={{ width: 0, opacity: 0 }}
      transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
      style={{
        flexShrink: 0,
        overflow: 'hidden',
        height: '100%',
        background: 'var(--bg-surface)',
        borderLeft: '1px solid var(--border-subtle)',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div style={{ width: 300, height: '100%', display: 'flex', flexDirection: 'column' }}>
        {/* 头部 */}
        <div style={{
          height: 44, flexShrink: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '0 12px',
          borderBottom: '1px solid var(--border-subtle)',
        }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
            工作面板
          </span>
          <button
            onClick={onClose}
            style={{
              width: 26, height: 26, borderRadius: 'var(--radius-sm)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: 'var(--text-tertiary)', cursor: 'pointer',
              fontSize: 16, lineHeight: 1,
              transition: 'background 120ms',
            }}
            onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
          >
            <X size={14} />
          </button>
        </div>

        {/* 内容区 */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '6px 8px' }}>
          {/* 代办事项 ---- TRAE 风格 */}
          <PanelSection
            icon={<ListTodo size={13} />}
            title="任务清单"
            count={todoCount > 0 ? `${doneCount}/${todoCount}` : undefined as any}
          >
            {todos.length === 0 ? (
              <EmptyHint text="暂无任务，AI 将在此展示工作进度" />
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                {todos.map(item => (
                  <TodoRow key={item.id} item={item} onToggle={toggleTodo} />
                ))}
              </div>
            )}
          </PanelSection>

          {/* 上下文引用 ---- TRAE 风格 #file #folder */}
          <PanelSection
            icon={<Hash size={13} />}
            title="上下文引用"
            count={contexts.length}
            defaultOpen={contexts.length > 0}
          >
            {contexts.length === 0 ? (
              <EmptyHint text="发送消息时可引用文件或文件夹" />
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                {contexts.map(ctx => (
                  <ContextRow key={ctx.id} item={ctx} />
                ))}
              </div>
            )}
          </PanelSection>

          {/* 文件引用 ---- TRAE 风格 */}
          <PanelSection
            icon={<FileText size={13} />}
            title="附件文件"
            count={files.length}
            defaultOpen={files.length > 0}
          >
            {files.length === 0 ? (
              <EmptyHint text="拖拽或粘贴文件到对话框" />
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                {files.map(f => (
                  <FileRow key={f.id} item={f} />
                ))}
              </div>
            )}
          </PanelSection>

          {/* 联网搜索 ---- TRAE 风格 */}
          <PanelSection
            icon={<Globe size={13} />}
            title="联网搜索"
            count={webResults.length}
            defaultOpen={webResults.length > 0}
          >
            {webResults.length === 0 ? (
              <EmptyHint text="开启联网搜索后，搜索结果将显示在此处" />
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {webResults.map(w => (
                  <WebRow key={w.id} item={w} />
                ))}
              </div>
            )}
          </PanelSection>
        </div>

        {/* 底部：添加任务按钮 */}
        <div style={{
          padding: '8px 12px',
          borderTop: '1px solid var(--border-subtle)',
          flexShrink: 0,
        }}>
          <button
            onClick={() => {
              const newId = Date.now().toString()
              setTodos(prev => [...prev, { id: newId, text: '新任务', done: false }])
            }}
            style={{
              display: 'flex', alignItems: 'center', gap: 6, width: '100%',
              padding: '6px 10px', borderRadius: 'var(--radius-md)',
              fontSize: 12, color: 'var(--text-secondary)',
              background: 'transparent', border: '1px dashed var(--border-default)',
              cursor: 'pointer', transition: 'all 120ms',
            }}
            onMouseEnter={e => {
              e.currentTarget.style.borderColor = 'var(--border-strong)'
              e.currentTarget.style.color = 'var(--text-primary)'
              e.currentTarget.style.background = 'var(--bg-hover)'
            }}
            onMouseLeave={e => {
              e.currentTarget.style.borderColor = 'var(--border-default)'
              e.currentTarget.style.color = 'var(--text-secondary)'
              e.currentTarget.style.background = 'transparent'
            }}
          >
            <Plus size={12} />
            <span>添加任务</span>
          </button>
        </div>
      </div>
    </motion.aside>
    </ErrorBoundary>
  )
}