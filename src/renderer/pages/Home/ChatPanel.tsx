import { useRef, useState, useEffect, useCallback } from 'react'
import { ChevronLeft, ArrowUp, MessageSquare, Trash2, X, Check, Pencil, Plus, Volume2, Copy, Paperclip, Globe, FileDown, Pause, Play, Square, Loader2, Image as ImageIcon } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  parseMessageContent, renderInlineFormatted, messageVariants,
  CodeWindow, TableCard, UserAvatar, TandemResultCard, ReasoningBlock, MarkdownHeading,
} from './messageRender'
import FileCard from '../../components/FileCard'
import ImageCard from '../../components/ImageCard'
import ModelSwitcher from '../../components/ModelSwitcher'
import ContextIndicator from '../../components/ContextIndicator'
import TaskCard, { type TaskCardData } from '../../components/TaskCard'
import TaskRunTimeline from '../../components/taskflow/TaskRunTimeline'
import { COLORS, HEX_COLORS } from '../../shared/theme'

interface ChatMessageItem {
  id: string
  role: 'user' | 'assistant'
  content: string
  reasoning?: string
  timestamp?: number
  // A批7：生成统计（真实可算，UI 以「约」标注 token 估算）
  tokenEstimate?: number
  elapsedMs?: number
  charCount?: number
  // F批：用户消息附件（真实路径，来源 getPathForFile），发送时构造 multi-part 内容数组
  files?: Array<{ path: string; type: string; name?: string }>
}

/** F批：输入区待发送附件（拖拽/粘贴进入，发送前暂存展示缩略） */
export interface AttachmentItem {
  id: string
  path: string
  type: 'image' | 'file'
  name: string
  mime?: string
}

// A批7：把真实生成统计排版为紧凑徽标串（token 为字符数估算，标注「约」；耗时/速度由真实计时得出）
function formatStatBadge(m: ChatMessageItem): string | null {
  if (m.elapsedMs == null && m.tokenEstimate == null) return null
  const parts: string[] = []
  if (m.tokenEstimate != null) parts.push(`约 ${m.tokenEstimate} tokens`)
  if (m.elapsedMs != null) parts.push(`${(m.elapsedMs / 1000).toFixed(1)}s`)
  if (m.tokenEstimate != null && m.elapsedMs != null && m.elapsedMs > 0) {
    parts.push(`~${Math.round(m.tokenEstimate / (m.elapsedMs / 1000))} tok/s`)
  }
  if (m.charCount != null) parts.push(`${m.charCount} 字`)
  return parts.join(' · ')
}

interface Conversation {
  id: string
  title: string
  timestamp?: number
  createdAt?: number
  updatedAt?: number
  contextStats?: { totalTokens: number; usedTokens: number; compressedRounds: number; compressionRatio: number }
}

interface ContextStats {
  totalTokens: number
  usedTokens: number
  compressedRounds: number
  compressionRatio: number
}

interface ChatPanelProps {
  messages: ChatMessageItem[]
  isStreaming: boolean
  speakingId: string | null
  input: string
  setInput: React.Dispatch<React.SetStateAction<string>>
  isFocused: boolean
  setIsFocused: (v: boolean) => void
  handleSend: () => void
  handleStop: () => void
  handleSpeakMessage: (msgId: string, text: string) => void
  speakingPaused: boolean
  togglePauseSpeaking: () => void
  stopSpeaking: () => void
  onTaskAppend?: (task: TaskCardData) => void
  onTaskEnd?: (task: TaskCardData) => void
  contextStats: ContextStats | null
  historyOpen: boolean
  setHistoryOpen: (v: boolean) => void
  // F批：输入区附件（拖拽/粘贴暂存，发送前展示缩略与移除）
  attachments: AttachmentItem[]
  onAddAttachments: (files: File[]) => void
  onRemoveAttachment: (id: string) => void
  conversations: Conversation[]
  currentConversationId: string | null
  createConversation: () => void
  switchConversation: (id: string) => void
  deleteConversation: (id: string) => void
  editingConvId: string | null
  editTitle: string
  setEditTitle: (v: string) => void
  handleStartRename: (id: string, title: string) => void
  handleConfirmRename: (id: string) => void
  handleCancelRename: () => void
}

/** 相对时间（体验优化：历史列表不再只显示标题，可感知新旧） */
function formatRelativeTime(ts?: number): string {
  if (!ts) return ''
  const diff = Date.now() - ts
  const min = Math.floor(diff / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min}分钟前`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h}小时前`
  const d = Math.floor(h / 24)
  if (d === 1) return '昨天'
  if (d < 7) return `${d}天前`
  const dt = new Date(ts)
  return `${dt.getMonth() + 1}月${dt.getDate()}日`
}

export default function ChatPanel(props: ChatPanelProps) {
  const {
    messages, isStreaming, speakingId,
    input, setInput, isFocused, setIsFocused,
    handleSend, handleStop,
    handleSpeakMessage, speakingPaused, togglePauseSpeaking, stopSpeaking,
    contextStats,
    onTaskAppend, onTaskEnd,
    historyOpen, setHistoryOpen,
    conversations, currentConversationId,
    createConversation, switchConversation, deleteConversation,
    editingConvId, editTitle, setEditTitle,
    handleStartRename, handleConfirmRename, handleCancelRename,
    attachments, onAddAttachments, onRemoveAttachment,
  } = props

  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  // 复制反馈：短暂显示「已复制」；删除二次确认：避免误触破坏性操作
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null)
  // 导出菜单：记录当前展开导出菜单的消息 id；导出中状态避免重复点击
  const [exportMenuId, setExportMenuId] = useState<string | null>(null)
  const [exportingId, setExportingId] = useState<string | null>(null)
  // 用户是否贴近消息列表底部（用于智能自动滚动：贴近时跟随新消息，上翻阅读时不被强制拉回）
  const [isNearBottom, setIsNearBottom] = useState(true)
  // 拖拽文件悬停高亮：给用户明确的「可拖入」反馈
  const [dragOver, setDragOver] = useState(false)
  // 联网搜索开关：开启后发送消息时自动补充实时搜索结果作为上下文
  // #修复4 意图化联网：默认开启，后端按意图判定触发搜索，无结果静默降级本地推理
  const [webSearchEnabled, setWebSearchEnabled] = useState(true)

  // 读取联网搜索开关配置
  useEffect(() => {
    if (!window.api) return
    window.api.invoke<boolean>('config:get', 'webSearchEnabled')
      .then((v: any) => { if (typeof v === 'boolean') setWebSearchEnabled(v) })
      .catch(() => { /* 忽略：首次启动无配置时保持默认开启 */ })
  }, [])

  // 切换联网搜索开关并持久化
  const toggleWebSearch = useCallback(async () => {
    const next = !webSearchEnabled
    setWebSearchEnabled(next)
    try {
      if (window.api) await window.api.invoke('config:set', 'webSearchEnabled', next)
    } catch { /* 忽略 */ }
  }, [webSearchEnabled])

  // 体验优化：切换会话（或首次进入）后自动聚焦输入框，可直接打字
  useEffect(() => {
    inputRef.current?.focus()
  }, [currentConversationId])

  // 输入框高度自适应：单行到 4 行内自动扩展，清空后复位
  const autoResize = useCallback((el: HTMLTextAreaElement) => {
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`
  }, [])

  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    autoResize(el)
  }, [input, autoResize])

  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current
    if (!el) return
    const threshold = 120
    setIsNearBottom(el.scrollHeight - el.scrollTop - el.clientHeight < threshold)
  }, [])

  // 消息变化（含流式输出）时自动滚动到底部：
  // - 仅当用户贴近底部时才跟随，避免上翻阅读历史被强制拉回；
  // - 流式输出期间直接赋值 scrollTop（无平滑动画），防止每 token 触发 smooth 跳动
  useEffect(() => {
    const el = scrollContainerRef.current
    if (!el || !isNearBottom) return
    el.scrollTop = el.scrollHeight
  }, [messages, isStreaming, historyOpen, isNearBottom])

  // 删除二次确认超时复位
  useEffect(() => {
    if (!pendingDeleteId) return
    const t = setTimeout(() => setPendingDeleteId(null), 3000)
    return () => clearTimeout(t)
  }, [pendingDeleteId])

  // 历史抽屉 ESC 关闭
  useEffect(() => {
    if (!historyOpen) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setHistoryOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [historyOpen, setHistoryOpen])

  const handleCopy = async (msgId: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopiedId(msgId)
      setTimeout(() => setCopiedId(v => (v === msgId ? null : v)), 1500)
    } catch {
      /* 剪贴板不可用时静默忽略 */
    }
  }

  // 一键导出回复为文档（Word / Markdown / PDF），调用主进程弹保存对话框落盘
  const handleExport = async (msgId: string, text: string, format: 'md' | 'docx' | 'pdf') => {
    if (!window.api) return
    setExportingId(msgId)
    setExportMenuId(null)
    try {
      const firstLine = text.split('\n').find(l => l.trim() && !l.trim().startsWith('#'))?.trim() || '玄枢AI回复'
      const res = await window.api.invoke<{ success: boolean; canceled?: boolean; error?: string }>('chat:export-document', {
        text,
        title: firstLine.slice(0, 30),
        format,
      })
      if (res?.success) {
        setCopiedId(msgId) // 复用复制成功提示区展示「已导出」
        setTimeout(() => setCopiedId(v => (v === msgId ? null : v)), 2500)
      }
    } catch {
      /* 忽略：保存对话框取消或失败 */
    } finally {
      setExportingId(null)
    }
  }

  const handleDeleteClick = (id: string) => {
    if (pendingDeleteId === id) {
      deleteConversation(id)
      setPendingDeleteId(null)
    } else {
      setPendingDeleteId(id)
    }
  }

  const renderMessage = (msg: ChatMessageItem) => {
    const isUser = msg.role === 'user'
    // 检测联动模式结果
    const isTandem = !isUser && msg.content.startsWith('{"_tandem":true')
    // 检测任务执行卡片
    const isTask = !isUser && msg.content.startsWith('{"_task":true')

    const parseTaskData = (content: string): TaskCardData => {
      try {
        const parsed = JSON.parse(content)
        if (parsed?._task) return parsed as TaskCardData
      } catch { /* fallthrough */ }
      return { _task: true, title: '任务', stage: '', progress: 0, summary: content }
    }

    const renderedContent = isTandem ? (
      <TandemResultCard content={msg.content} />
    ) : isTask ? (
      <TaskCard task={parseTaskData(msg.content)} onAppend={onTaskAppend} onEnd={onTaskEnd} />
    ) : (
      (() => {
        const blocks = parseMessageContent(msg.content)
        return blocks.map((block, idx) => {
          if (block.type === 'heading') return <MarkdownHeading key={idx} level={block.level} text={block.text} />
          if (block.type === 'code') return <CodeWindow key={idx} code={block.code} language={block.language} />
          if (block.type === 'table') return <TableCard key={idx} headers={block.headers} rows={block.rows} />
          if (block.type === 'image') return <ImageCard key={idx} path={block.path} />
          if (block.type === 'file') return <FileCard key={idx} path={block.path} />
          if (block.type === 'video') return <FileCard key={idx} path={block.path} variant="video" />
          // 错误消息友好化展示：错误前缀用危险色区分，方便用户一眼识别并定位恢复路径
          const isErrorText = /^(错误|发送失败|\[联动错误\]|请求失败)/.test(block.text)
          return (
            <p key={idx} style={{
              // v3 仿Trae：AI 叙述正文松弛可读（15.5/1.7），无气泡
              margin: '6px 0',
              fontSize: 'var(--text-prose)',
              lineHeight: 'var(--leading-prose)',
              color: isErrorText ? 'var(--status-failed)' : undefined,
            }}>
              {renderInlineFormatted(block.text)}
            </p>
          )
        })
      })()
    )

    return (
      <motion.div
        key={msg.id}
        variants={messageVariants}
        initial="hidden"
        animate="visible"
        exit="exit"
        style={{
          display: 'flex',
          gap: 10,
          marginBottom: 20,
          // AI 消息：头像在左，纯文本无气泡；用户消息：轻量胶囊在左，头像在右
          flexDirection: 'row',
          justifyContent: isUser ? 'flex-end' : 'flex-start',
          paddingLeft: isUser ? 40 : 0,
          paddingRight: isUser ? 0 : 40,
        }}
      >
        {!isUser && <UserAvatar />}
        <div style={{
          flex: isUser ? '0 1 auto' : '1',
          display: 'flex',
          flexDirection: 'column',
          alignItems: isUser ? 'flex-end' : 'stretch',
          minWidth: 0,
          maxWidth: '75%',
        }}>
          <div
            style={{
              padding: isUser ? '10px 14px' : '4px 0',
              borderRadius: isUser ? 'var(--radius-2xl)' : undefined,
              // v3：用户消息轻量胶囊（实底抬升面 + 极弱边框），不用品牌色描边
              background: isUser ? 'var(--bg-elevated)' : 'transparent',
              border: isUser ? '1px solid var(--border-subtle)' : 'none',
              wordBreak: 'break-word',
              position: 'relative',
              alignSelf: isUser ? 'flex-end' : 'stretch',
              width: isUser ? 'auto' : '100%',
            }}
          >
            {!isUser && !isTandem && !isTask && <ReasoningBlock text={msg.reasoning} streaming={isStreaming && messages[messages.length - 1]?.id === msg.id} />}
            {renderedContent}
            {/* F批：用户消息附件（真实内容数组，非文本标记） — 图片/文件缩略渲染 */}
            {isUser && msg.files && msg.files.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
                {msg.files.map((f, fi) =>
                  f.type.startsWith('image/')
                    ? <ImageCard key={fi} path={f.path} />
                    : <FileCard key={fi} path={f.path} />
                )}
              </div>
            )}
            {/* AI 消息操作行：复制/导出/播报 + A批7 生成统计徽标（约N tokens · 真实耗时 · 速度 · 字数） */}
            {!isUser && (
              <div style={{ marginTop: 6, display: 'flex', gap: 4, justifyContent: 'flex-end', alignItems: 'center', flexWrap: 'wrap' }}>
                {formatStatBadge(msg) && (
                  <span style={{ marginRight: 4, fontSize: 10.5, color: 'var(--text-tertiary)', opacity: 0.78, display: 'inline-flex', alignItems: 'center', gap: 3, lineHeight: 1 }}>
                    {formatStatBadge(msg)}
                  </span>
                )}
                <button
                  onClick={() => handleCopy(msg.id, msg.content)}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: copiedId === msg.id ? 'var(--status-running)' : 'var(--text-tertiary)', padding: '2px 4px' }}
                  title={copiedId === msg.id ? '已复制' : '复制'}
                  aria-label={copiedId === msg.id ? '已复制' : '复制消息'}
                >{copiedId === msg.id ? <Check size={14} /> : <Copy size={14} />}</button>
                <button
                  onClick={() => setExportMenuId(exportMenuId === msg.id ? null : msg.id)}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: exportMenuId === msg.id ? 'var(--status-running)' : 'var(--text-tertiary)', padding: '2px 4px', display: 'inline-flex', alignItems: 'center', gap: 3 }}
                  title="导出为文档"
                  aria-label="导出为文档"
                ><FileDown size={14} />{exportingId === msg.id && <span style={{ fontSize: 10 }}>导出中…</span>}</button>
                {exportMenuId === msg.id && (
                  <span style={{ display: 'inline-flex', gap: 2, alignItems: 'center', background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', borderRadius: 8, padding: '2px 4px' }}>
                    {([
                      ['docx', 'Word'],
                      ['md', 'Markdown'],
                      ['pdf', 'PDF'],
                    ] as const).map(([fmt, label]) => (
                      <button
                        key={fmt}
                        onClick={() => handleExport(msg.id, msg.content, fmt)}
                        disabled={exportingId === msg.id}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', fontSize: 11, padding: '2px 6px', borderRadius: 5 }}
                      >{label}</button>
                    ))}
                  </span>
                )}
                <button
                  onClick={() => handleSpeakMessage(msg.id, msg.content)}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: speakingId === msg.id ? 'var(--status-running)' : 'var(--text-tertiary)', padding: '2px 4px' }}
                  title="播报"
                  aria-label="播报消息"
                ><Volume2 size={14} /></button>
                {speakingId === msg.id && (
                  <>
                    <button
                      onClick={togglePauseSpeaking}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', padding: '2px 4px' }}
                      title={speakingPaused ? '继续朗读' : '暂停朗读'}
                      aria-label={speakingPaused ? '继续朗读' : '暂停朗读'}
                    >{speakingPaused ? <Play size={14} /> : <Pause size={14} />}</button>
                    <button
                      onClick={stopSpeaking}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', padding: '2px 4px' }}
                      title="停止朗读"
                      aria-label="停止朗读"
                    ><Square size={14} /></button>
                  </>
                )}
              </div>
            )}
          </div>
          {/* A批7：用户消息复制按钮移到气泡下方，与时间戳对称成行（不再占气泡内空间） */}
          {isUser && (
            <div style={{ marginTop: 5, display: 'flex', alignItems: 'center', gap: 6 }}>
              {msg.timestamp ? (
                <span style={{ fontSize: 11, color: 'var(--text-tertiary)', opacity: 0.72, lineHeight: 1 }}>
                  {new Date(msg.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
                </span>
              ) : null}
              <button
                onClick={() => handleCopy(msg.id, msg.content)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: copiedId === msg.id ? 'var(--status-running)' : 'var(--text-tertiary)', padding: '2px 4px', display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11 }}
                title={copiedId === msg.id ? '已复制' : '复制'}
                aria-label={copiedId === msg.id ? '已复制' : '复制消息'}
              >{copiedId === msg.id ? <Check size={13} /> : <Copy size={13} />}{copiedId === msg.id ? ' 已复制' : ' 复制'}</button>
            </div>
          )}
        </div>
        {isUser && <UserAvatar role="user" />}
      </motion.div>
    )
  }

  const renderMessages = () => (
    <div ref={scrollContainerRef} onScroll={handleScroll} style={{ flex: 1, overflowY: 'auto', padding: '20px 20px 8px' }}>
      <AnimatePresence initial={false}>
        {messages.map(renderMessage)}
      </AnimatePresence>
      {/* 任务步骤/工具调用过程时间线（订阅 taskRunStore，无过程时不渲染），右侧与 AI 正文列对齐 */}
      <div style={{ paddingRight: 40 }}>
        <TaskRunTimeline />
      </div>
      {/* v3：等待首个 token 时用蓝色 spinner + 文案，替代拟物三跳点 */}
      {isStreaming && messages.length > 0 && messages[messages.length - 1].role === 'assistant' && !messages[messages.length - 1].content && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingRight: 40, color: 'var(--text-tertiary)' }}>
          <Loader2 size={14} className="animate-spin" style={{ color: 'var(--status-running)' }} />
          <span style={{ fontSize: 13 }}>正在思考…</span>
        </div>
      )}
    </div>
  )

  const renderHistory = () => (
    <AnimatePresence>
      {historyOpen && (
        <motion.div
          initial={{ x: -320 }}
          animate={{ x: 0 }}
          exit={{ x: -320 }}
          transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
          style={{
            position: 'absolute', left: 0, top: 0, bottom: 0, width: 300,
            // v3：历史抽屉去紫蓝渐变/重边框/模糊，统一实底 + 极弱边框
            background: 'var(--bg-surface)',
            borderRight: '1px solid var(--border-default)',
            borderRadius: '0 12px 12px 0',
            boxShadow: 'var(--shadow-lg)',
            zIndex: 20, display: 'flex', flexDirection: 'column',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 16px', height: 52, flexShrink: 0, borderBottom: `1px solid ${COLORS.cardBorder}` }}>
            <span style={{ fontWeight: 600, fontSize: 13.5, color: COLORS.textPrimary, display: 'flex', alignItems: 'center', gap: 8 }}>
              <MessageSquare size={14} color={COLORS.accent} />
              对话历史
            </span>
            <button onClick={() => setHistoryOpen(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: COLORS.textMuted, width: 26, height: 26, borderRadius: 8 }} aria-label="关闭历史面板"><X size={15} /></button>
          </div>
          <div style={{ padding: '8px 12px' }}>
            <button
              onClick={createConversation}
              style={{
                width: '100%', padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 8,
                background: 'var(--bg-hover)', border: `1px solid ${HEX_COLORS.accent}44`, borderRadius: 10,
                cursor: 'pointer', color: COLORS.textPrimary, fontSize: 13, fontFamily: 'inherit',
              }}
            >
              <Plus size={16} /> 新建对话
            </button>
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: '8px 12px' }}>
            {conversations.length === 0 ? (
              <div style={{ padding: '32px 12px', textAlign: 'center', color: COLORS.textMuted, fontSize: 13 }}>
                暂无历史对话
              </div>
            ) : conversations.map(conv => (
              <div
                key={conv.id}
                onClick={() => switchConversation(conv.id)}
                style={{
                  padding: '10px 12px', borderRadius: 10, cursor: 'pointer',
                  marginBottom: 4, display: 'flex', alignItems: 'center', gap: 8,
                  background: conv.id === currentConversationId ? 'var(--bg-hover)' : 'transparent',
                  color: conv.id === currentConversationId ? COLORS.textPrimary : COLORS.textSecondary,
                  transition: 'background 120ms',
                }}
              >
                <MessageSquare size={15} style={{ flexShrink: 0, color: conv.id === currentConversationId ? COLORS.accent : COLORS.textMuted }} />
                {editingConvId === conv.id ? (
                  <div style={{ flex: 1, display: 'flex', gap: 6 }}>
                    <input
                      value={editTitle}
                      onChange={(e) => setEditTitle(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && handleConfirmRename(conv.id)}
                      style={{ flex: 1, padding: '2px 6px', borderRadius: 4, border: '1px solid var(--border-default)', background: 'var(--bg-base)', fontSize: 13, color: COLORS.textPrimary }}
                      autoFocus
                    />
                    <button onClick={() => handleConfirmRename(conv.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: COLORS.accent }}><Check size={14} /></button>
                    <button onClick={handleCancelRename} style={{ background: 'none', border: 'none', cursor: 'pointer', color: COLORS.textMuted }}><X size={14} /></button>
                  </div>
                ) : (
                  <>
                    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13, color: 'inherit' }}>{conv.title}</span>
                      <span style={{ fontSize: 11, color: COLORS.textMuted, opacity: 0.8 }}>{formatRelativeTime(conv.updatedAt ?? conv.createdAt ?? conv.timestamp)}</span>
                    </div>
                    <button
                      onClick={(e) => { e.stopPropagation(); handleStartRename(conv.id, conv.title) }}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: COLORS.textMuted, opacity: 0.5, padding: '2px' }}
                    ><Pencil size={12} /></button>
                    <button
                      onClick={(e) => { e.stopPropagation(); handleDeleteClick(conv.id) }}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: pendingDeleteId === conv.id ? COLORS.danger : COLORS.textMuted, opacity: pendingDeleteId === conv.id ? 1 : 0.5, padding: '2px' }}
                      title={pendingDeleteId === conv.id ? '再次点击确认删除' : '删除对话'}
                    >{pendingDeleteId === conv.id ? <span style={{ fontSize: 12, fontWeight: 600 }}>确认?</span> : <Trash2 size={12} />}</button>
                  </>
                )}
              </div>
            ))}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )

  // F批：拖拽/粘贴的文件统一交给 Home 侧转真实路径并暂存为附件（替换旧「[图片:path] 文本标记」方案）
  const collectFiles = (files: File[]) => {
    if (!files.length) return
    onAddAttachments(files)
  }

  const inputBar = (
    <div
      style={{ maxWidth: 'var(--taskflow-max)', margin: '0 auto', width: '100%' }}
      onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setDragOver(true) }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault(); e.stopPropagation(); setDragOver(false)
        const files = Array.from(e.dataTransfer?.files ?? [])
        collectFiles(files)
      }}
      onPaste={(e) => {
        const items = e.clipboardData?.items
        if (!items) return
        let pastedAny = false
        for (let i = 0; i < items.length; i++) {
          const item = items[i]
          if (item.kind === 'file') {
            const file = item.getAsFile()
            if (file) { collectFiles([file]); pastedAny = true }
          }
        }
        if (pastedAny) e.preventDefault()
      }}
    >
      <motion.div
        animate={{
          // v3：聚焦/拖入用蓝色（进行色），不再用银灰 glow
          borderColor: isFocused || dragOver ? 'var(--status-running)' : 'var(--border-default)',
          boxShadow: isFocused || dragOver ? '0 0 0 3px var(--status-running-dim)' : '0 0 0 0 transparent',
        }}
        transition={{ duration: 0.18, ease: 'easeOut' }}
        style={{
          position: 'relative',
          display: 'flex', flexDirection: 'column',
          // v3 去玻璃化：实底抬升面，不要线性渐变/内高光/辉光
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border-default)',
          borderRadius: 'var(--radius-2xl)',
          overflow: 'hidden',
        }}
      >
        {/* 拖拽文件悬停：明确高亮浮层（虚线框 + 图标 + 提示），松开即引用文件 */}
        <AnimatePresence>
          {dragOver && (
            <motion.div
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              style={{
                position: 'absolute', inset: 0, zIndex: 5, pointerEvents: 'none',
                display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8,
                background: 'rgba(26,27,29,0.82)',
                borderRadius: 'var(--radius-2xl)',
                boxShadow: 'inset 0 0 0 1px var(--status-running)',
                margin: 4,
              }}
            >
              <div style={{ width: 42, height: 42, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--status-running-dim)', color: 'var(--status-running)' }}>
                <Paperclip size={18} />
              </div>
              <div style={{ fontSize: 13, color: 'var(--text-primary)', fontWeight: 500 }}>松开以将文件添加到消息</div>
              <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>支持图片、音频、视频与文档</div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* F批：待发送附件暂存条（真实文件缩略，可逐条移除） */}
        {attachments.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: '6px 14px 0' }}>
            {attachments.map(a => (
              <div key={a.id} style={{
                position: 'relative',
                display: 'flex', alignItems: 'center', gap: 6,
                background: 'var(--bg-hover)', border: '1px solid var(--border-subtle)', borderRadius: 8,
                padding: '4px 6px', minWidth: 0, maxWidth: 240,
              }}>
                <div style={{ flexShrink: 0, width: 22, height: 22, borderRadius: 5, overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-elevated)', color: 'var(--text-tertiary)' }}>
                  {a.type === 'image' ? <ImageIcon size={13} /> : <Paperclip size={13} />}
                </div>
                <span style={{ fontSize: 11.5, color: 'var(--text-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={a.path}>{a.name}</span>
                <button
                  onClick={() => onRemoveAttachment(a.id)}
                  title="移除附件"
                  aria-label="移除附件"
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-tertiary)', padding: 0, display: 'inline-flex', flexShrink: 0 }}
                ><X size={13} /></button>
              </div>
            ))}
          </div>
        )}

        {/* 主输入行：输入区 / 联网搜索 / 发送（停止） */}
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, padding: '14px 14px 4px' }}>
          <textarea
            ref={inputRef}
            value={input}
            aria-label="输入消息"
            rows={1}
            onChange={(e) => { setInput(e.target.value); autoResize(e.target) }}
            onKeyDown={(e) => {
              // Enter 发送；Shift+Enter 换行；IME 组合输入（中文选词）时的 Enter 不触发发送
              if (e.key === 'Enter' && !e.shiftKey && !(e.nativeEvent as any).isComposing) {
                e.preventDefault()
                handleSend()
              }
            }}
            onFocus={() => setIsFocused(true)} onBlur={() => setIsFocused(false)}
            placeholder={'输入消息，与玄枢开始对话…'}
            className="input"
            style={{
              flex: 1, minHeight: 40, maxHeight: 120,
              background: 'transparent', border: 'none', outline: 'none', resize: 'none',
              boxShadow: 'none',
              fontSize: 15, padding: '9px 6px', lineHeight: 1.6, overflowY: 'auto',
              color: 'var(--text-primary)',
              caretColor: 'var(--status-running)',
            }}
          />

          {/* 联网搜索开关 */}
          <button
            onClick={toggleWebSearch}
            title={webSearchEnabled ? '关闭联网搜索' : '开启联网搜索'}
            aria-label={webSearchEnabled ? '关闭联网搜索' : '开启联网搜索'}
            style={{
              width: 36, height: 36, borderRadius: '50%', flexShrink: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: webSearchEnabled ? 'var(--accent-dim)' : 'var(--bg-hover)',
              color: webSearchEnabled ? 'var(--accent-light)' : 'var(--text-tertiary)', cursor: 'pointer',
              border: webSearchEnabled ? '1px solid var(--border-default)' : '1px solid transparent',
              transition: 'background 0.15s ease, color 0.15s ease, border-color 0.15s ease',
            }}
          >
            <Globe size={16} />
          </button>

          <button
            onClick={() => (isStreaming ? handleStop() : handleSend())}
            disabled={!input.trim() && !isStreaming}
            title={isStreaming ? '停止生成' : (input.trim() ? '发送' : '请输入消息')}
            aria-label={isStreaming ? '停止生成' : '发送消息'}
            style={{
              width: 40, height: 40, borderRadius: '50%', flexShrink: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: isStreaming ? 'var(--status-failed)' : (input.trim() ? 'var(--accent)' : 'var(--bg-hover)'),
              color: isStreaming ? '#fff' : (input.trim() ? '#1a1b1d' : 'var(--text-tertiary)'),
              cursor: (input.trim() || isStreaming) ? 'pointer' : 'default',
              border: 'none',
              boxShadow: 'none',
              transition: 'background 0.15s ease, transform 0.1s ease',
            }}
            onMouseDown={(e) => {
              if ((input.trim() || isStreaming)) {
                const el = e.currentTarget as HTMLButtonElement;
                el.style.transform = 'scale(0.94)';
              }
            }}
            onMouseUp={(e) => { (e.currentTarget as HTMLButtonElement).style.transform = ''; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.transform = ''; }}
          >
            {isStreaming
              ? <div style={{ width: 13, height: 13, background: '#fff', borderRadius: 3, animation: 'pulse-soft 1.2s ease-in-out infinite' }} />
              : <ArrowUp size={18} strokeWidth={2.2} />}
          </button>
        </div>

        {/* 辅助行：快捷键提示（左） / 上下文用量（右） */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '4px 16px 10px' }}>
          <span style={{ fontSize: 12, color: 'var(--text-tertiary)', fontWeight: 500, userSelect: 'none', whiteSpace: 'nowrap', letterSpacing: 0.2 }}>
            Enter 发送 · Shift+Enter 换行 · 支持拖入文件
          </span>
          <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center' }}>
            <ContextIndicator stats={contextStats} />
          </div>
        </div>
      </motion.div>
    </div>
  )

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', position: 'relative', overflow: 'hidden' }}>
      {renderHistory()}
      <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 36, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', zIndex: 5 }}>
        <motion.button
          onClick={() => setHistoryOpen(!historyOpen)}
          whileHover={{ scale: 1.1 }}
          aria-label={historyOpen ? '关闭历史面板' : '打开历史面板'}
          style={{
            width: 28, height: 28, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: historyOpen ? 'var(--bg-hover)' : 'transparent', color: 'var(--text-tertiary)',
            cursor: 'pointer', border: 'none',
          }}
        >
          <ChevronLeft size={18} style={{ transform: historyOpen ? 'rotate(180deg)' : undefined }} />
        </motion.button>
      </div>

      {/* 当前推理模型切换器：本地模型切换 + 本地/云端状态入口 */}
      <div style={{ padding: '10px 20px 0', display: 'flex', justifyContent: 'center', flexShrink: 0 }}>
        <ModelSwitcher />
      </div>

      {/* 中央内容区：稳定外层，消息列表/空态在内部切换，避免切换模型/首个消息时面板上下跳变 */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        {messages.length > 0 ? renderMessages() : (
          <div style={{ flex: 1 }} />
        )}
      </div>

      <div style={{ padding: '14px 20px 18px', display: 'flex', justifyContent: 'center' }}>
        {inputBar}
      </div>
    </div>
  )
}
