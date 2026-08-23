import { useRef, useState, useEffect, useCallback } from 'react'
import { Mic, ChevronLeft, ArrowUp, MessageSquare, Trash2, X, Check, Pencil, Plus, Volume2, Copy, Paperclip, Globe } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import type { TandemMode } from './messageRender'
import {
  parseMessageContent, renderInlineFormatted, messageVariants,
  CodeWindow, TableCard, UserAvatar, TypingDots, TandemResultCard,
} from './messageRender'
import FileCard from '../../components/FileCard'
import ImageCard from '../../components/ImageCard'
import ModelSwitcher from '../../components/ModelSwitcher'
import ContextIndicator from '../../components/ContextIndicator'
import TaskCard, { type TaskCardData } from '../../components/TaskCard'

interface ChatMessageItem {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp?: number
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
  isRecording: boolean
  isFocused: boolean
  setIsFocused: (v: boolean) => void
  handleSend: () => void
  handleStop: () => void
  startRecording: () => void
  stopRecording: () => void
  handleSpeakMessage: (msgId: string, text: string) => void
  tandemMode: TandemMode | null
  setTandemMode: (m: TandemMode | null) => void
  onTaskAppend?: (task: TaskCardData) => void
  onTaskEnd?: (task: TaskCardData) => void
  contextStats: ContextStats
  historyOpen: boolean
  setHistoryOpen: (v: boolean) => void
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
    input, setInput, isRecording, isFocused, setIsFocused,
    handleSend, handleStop, startRecording, stopRecording,
    handleSpeakMessage,
    tandemMode, setTandemMode, contextStats,
    onTaskAppend, onTaskEnd,
    historyOpen, setHistoryOpen,
    conversations, currentConversationId,
    createConversation, switchConversation, deleteConversation,
    editingConvId, editTitle, setEditTitle,
    handleStartRename, handleConfirmRename, handleCancelRename,
  } = props

  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  // 复制反馈：短暂显示「已复制」；删除二次确认：避免误触破坏性操作
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null)
  // 用户是否贴近消息列表底部（用于智能自动滚动：贴近时跟随新消息，上翻阅读时不被强制拉回）
  const [isNearBottom, setIsNearBottom] = useState(true)
  // 拖拽文件悬停高亮：给用户明确的「可拖入」反馈
  const [dragOver, setDragOver] = useState(false)
  // 联网搜索开关：开启后发送消息时自动补充实时搜索结果作为上下文
  const [webSearchEnabled, setWebSearchEnabled] = useState(false)

  // 读取联网搜索开关配置
  useEffect(() => {
    if (!window.api) return
    window.api.invoke<boolean>('config:get', 'webSearchEnabled')
      .then((v: any) => { if (typeof v === 'boolean') setWebSearchEnabled(v) })
      .catch(() => { /* 忽略：首次启动无配置时保持默认关闭 */ })
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
          if (block.type === 'code') return <CodeWindow key={idx} code={block.code} language={block.language} />
          if (block.type === 'table') return <TableCard key={idx} headers={block.headers} rows={block.rows} />
          if (block.type === 'image') return <ImageCard key={idx} path={block.path} />
          if (block.type === 'file') return <FileCard key={idx} path={block.path} />
          if (block.type === 'video') return <FileCard key={idx} path={block.path} variant="video" />
          // 错误消息友好化展示：错误前缀用危险色区分，方便用户一眼识别并定位恢复路径
          const isErrorText = /^(错误|发送失败|\[联动错误\]|请求失败)/.test(block.text)
          return (
            <p key={idx} style={{
              margin: '4px 0', lineHeight: 1.6,
              color: isErrorText ? 'var(--danger)' : undefined,
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
          marginBottom: 16,
          // AI 消息：头像在左，纯文本无气泡；用户消息：气泡在左，头像在右
          flexDirection: 'row',
          justifyContent: isUser ? 'flex-end' : 'flex-start',
          paddingLeft: isUser ? 40 : 0,
          paddingRight: isUser ? 0 : 40,
        }}
      >
        {!isUser && <UserAvatar />}
        <div
          style={{
            flex: isUser ? '0 1 auto' : '1',
            padding: isUser ? '12px 16px' : '4px 0',
            borderRadius: isUser ? 'var(--radius-lg)' : undefined,
            background: isUser ? 'var(--brand-dim)' : 'transparent',
            border: isUser ? '1px solid var(--border-focus)' : 'none',
            maxWidth: '75%',
            wordBreak: 'break-word',
            position: 'relative',
          }}
        >
          {renderedContent}
          {/* 消息操作：AI 消息提供复制/播报；用户消息提供复制（体验优化：消息操作可用性） */}
          <div style={{ marginTop: 6, display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
            <button
              onClick={() => handleCopy(msg.id, msg.content)}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: copiedId === msg.id ? 'var(--brand)' : 'var(--text-tertiary)', padding: '2px 4px' }}
              title={copiedId === msg.id ? '已复制' : '复制'}
              aria-label={copiedId === msg.id ? '已复制' : '复制消息'}
            >{copiedId === msg.id ? <Check size={14} /> : <Copy size={14} />}</button>
            {!isUser && (
              <button
                onClick={() => handleSpeakMessage(msg.id, msg.content)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: speakingId === msg.id ? 'var(--brand)' : 'var(--text-tertiary)', padding: '2px 4px' }}
                title="播报"
                aria-label="播报消息"
              ><Volume2 size={14} /></button>
            )}
          </div>
        </div>
        {isUser && <UserAvatar />}
      </motion.div>
    )
  }

  const renderMessages = () => (
    <div ref={scrollContainerRef} onScroll={handleScroll} style={{ flex: 1, overflowY: 'auto', padding: '16px 20px' }}>
      <AnimatePresence initial={false}>
        {messages.map(renderMessage)}
      </AnimatePresence>
      {isStreaming && messages.length > 0 && messages[messages.length - 1].role === 'assistant' && !messages[messages.length - 1].content && (
        <div style={{ display: 'flex', gap: 10, paddingRight: 40 }}>
          <UserAvatar />
          <TypingDots />
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
          transition={{ type: 'spring', damping: 25 }}
          style={{
            position: 'absolute', left: 0, top: 0, bottom: 0, width: 300,
            background: 'var(--bg-elevated)', borderRight: '1px solid var(--border-default)',
            zIndex: 20, display: 'flex', flexDirection: 'column',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', borderBottom: '1px solid var(--border-default)' }}>
            <span style={{ fontWeight: 600, fontSize: 15 }}>对话历史</span>
            <button onClick={() => setHistoryOpen(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-tertiary)' }} aria-label="关闭历史面板"><X size={18} /></button>
          </div>
          <div style={{ padding: '8px 12px' }}>
            <button
              onClick={createConversation}
              style={{
                width: '100%', padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 8,
                background: 'var(--bg-hover)', border: '1px solid var(--border-default)', borderRadius: 'var(--radius-md)',
                cursor: 'pointer', color: 'var(--text-secondary)', fontSize: 13,
              }}
            >
              <Plus size={16} /> 新建对话
            </button>
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: '8px 12px' }}>
            {conversations.length === 0 ? (
              <div style={{ padding: '32px 12px', textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 13 }}>
                暂无历史对话
              </div>
            ) : conversations.map(conv => (
              <div
                key={conv.id}
                onClick={() => switchConversation(conv.id)}
                style={{
                  padding: '10px 12px', borderRadius: 'var(--radius-md)', cursor: 'pointer',
                  marginBottom: 4, display: 'flex', alignItems: 'center', gap: 8,
                  background: conv.id === currentConversationId ? 'var(--bg-hover)' : 'transparent',
                  color: conv.id === currentConversationId ? 'var(--text-primary)' : 'var(--text-secondary)',
                }}
              >
                <MessageSquare size={15} style={{ flexShrink: 0 }} />
                {editingConvId === conv.id ? (
                  <div style={{ flex: 1, display: 'flex', gap: 6 }}>
                    <input
                      value={editTitle}
                      onChange={(e) => setEditTitle(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && handleConfirmRename(conv.id)}
                      style={{ flex: 1, padding: '2px 6px', borderRadius: 4, border: '1px solid var(--border-focus)', background: 'var(--bg-base)', fontSize: 13 }}
                      autoFocus
                    />
                    <button onClick={() => handleConfirmRename(conv.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--brand)' }}><Check size={14} /></button>
                    <button onClick={handleCancelRename} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-tertiary)' }}><X size={14} /></button>
                  </div>
                ) : (
                  <>
                    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13 }}>{conv.title}</span>
                      <span style={{ fontSize: 11, color: 'var(--text-tertiary)', opacity: 0.8 }}>{formatRelativeTime(conv.updatedAt ?? conv.createdAt ?? conv.timestamp)}</span>
                    </div>
                    <button
                      onClick={(e) => { e.stopPropagation(); handleStartRename(conv.id, conv.title) }}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-tertiary)', opacity: 0.5, padding: '2px' }}
                    ><Pencil size={12} /></button>
                    <button
                      onClick={(e) => { e.stopPropagation(); handleDeleteClick(conv.id) }}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: pendingDeleteId === conv.id ? 'var(--danger)' : 'var(--text-tertiary)', opacity: pendingDeleteId === conv.id ? 1 : 0.5, padding: '2px' }}
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

  // 将拖拽/粘贴的文件追加为输入中的引用标记（函数式 setInput，避免闭包过期导致多文件丢失）
  const appendFileMark = useCallback((file: File) => {
    const path = (file as any).path || file.name
    const type = file.type
    const mark = type.startsWith('image/') ? `[图片: ${path}]`
      : type.startsWith('audio/') ? `[音频: ${path}]`
      : type.startsWith('video/') ? `[视频: ${path}]`
      : `[文件: ${path}]`
    setInput(prev => prev ? `${prev}\n${mark}` : mark)
  }, [setInput])

  const inputBar = (
    <div
      style={{ maxWidth: 860, margin: '0 auto', width: '100%' }}
      onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setDragOver(true) }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault(); e.stopPropagation(); setDragOver(false)
        const files = Array.from(e.dataTransfer?.files ?? [])
        files.forEach(appendFileMark)
      }}
      onPaste={(e) => {
        const items = e.clipboardData?.items
        if (!items) return
        let pastedAny = false
        for (let i = 0; i < items.length; i++) {
          const item = items[i]
          if (item.kind === 'file') {
            const file = item.getAsFile()
            if (file) { appendFileMark(file); pastedAny = true }
          }
        }
        if (pastedAny) e.preventDefault()
      }}
    >
      <motion.div
        animate={{
          borderColor: isFocused ? 'var(--border-focus)' : dragOver ? 'var(--accent)' : 'var(--border-default)',
          boxShadow: isFocused
            ? '0 0 0 3px var(--accent-dim), var(--accent-glow), var(--shadow-card)'
            : dragOver
              ? '0 0 0 3px rgba(176,176,186,0.14), var(--accent-glow), var(--shadow-card)'
              : 'var(--shadow-card)',
        }}
        transition={{ duration: 0.18, ease: 'easeOut' }}
        style={{
          position: 'relative',
          display: 'flex', flexDirection: 'column',
          // 玻璃/金属质感：顶部渐变高光 + 内描边 + 柔和阴影
          background: 'linear-gradient(180deg, rgba(255,255,255,0.05) 0%, rgba(255,255,255,0.015) 60%, rgba(255,255,255,0.03) 100%), var(--bg-elevated)',
          border: '1px solid var(--border-default)',
          borderRadius: 'var(--radius-20)',
          boxShadow: 'var(--inset-hi-strong), var(--shadow-card)',
          overflow: 'hidden',
        }}
      >
        {/* 拖拽文件悬停：精致高亮浮层（虚线框 + 图标 + 提示），松开即引用文件 */}
        <AnimatePresence>
          {dragOver && (
            <motion.div
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              style={{
                position: 'absolute', inset: 0, zIndex: 5, pointerEvents: 'none',
                display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8,
                background: 'rgba(26,26,28,0.78)',
                backdropFilter: 'blur(4px)',
                borderRadius: 'var(--radius-20)',
                boxShadow: 'inset 0 0 0 1px var(--accent)',
                margin: 4,
              }}
            >
              <div style={{ width: 42, height: 42, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--accent-dim)', color: 'var(--accent-light)' }}>
                <Paperclip size={18} />
              </div>
              <div style={{ fontSize: 13, color: 'var(--text-primary)', fontWeight: 500 }}>松开以将文件添加到消息</div>
              <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>支持图片、音频、视频与文档</div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* 主输入行：语音 / 输入区 / 超算模式 / 发送（停止） */}
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, padding: '14px 14px 4px' }}>
          <motion.button
            onClick={isRecording ? stopRecording : startRecording}
            whileHover={{ scale: 1.04 }} whileTap={{ scale: 0.94 }}
            title={isRecording ? '停止录音' : '语音输入'}
            aria-label={isRecording ? '停止录音' : '语音输入'}
            style={{
              position: 'relative',
              width: 38, height: 38, borderRadius: '50%', flexShrink: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: isRecording ? 'var(--danger)' : 'var(--bg-hover)',
              color: isRecording ? '#fff' : 'var(--text-secondary)', cursor: 'pointer',
              border: isRecording ? 'none' : '1px solid var(--border-default)',
              transition: 'background 0.15s ease, color 0.15s ease, border-color 0.15s ease',
            }}
          >
            {isRecording && (
              <span style={{
                position: 'absolute', inset: -3, borderRadius: '50%',
                border: '1px solid rgba(212,112,106,0.55)',
                animation: 'rip 1.6s ease-out infinite',
              }} />
            )}
            <Mic size={16} />
          </motion.button>

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
            placeholder={
              tandemMode
                ? `${tandemMode === 'dual' ? '双答' : tandemMode === 'partner' ? '搭档' : tandemMode === 'mentor' ? '师徒' : '辩论'}模式 - 输入消息…`
                : '输入消息，与玄枢开始对话…'
            }
            className="input"
            style={{
              flex: 1, minHeight: 40, maxHeight: 120,
              background: 'transparent', border: 'none', outline: 'none', resize: 'none',
              boxShadow: 'none',
              fontSize: 15, padding: '9px 6px', lineHeight: 1.6, overflowY: 'auto',
              color: 'var(--text-primary)',
              caretColor: 'var(--accent)',
            }}
          />

          <button
            onClick={() => setTandemMode(tandemMode ? null : 'dual')}
            title="超算模式"
            aria-label="超算模式"
            style={{
              width: 36, height: 36, borderRadius: '50%', flexShrink: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: tandemMode ? 'var(--brand-dim)' : 'var(--bg-hover)',
              color: tandemMode ? 'var(--brand)' : 'var(--text-tertiary)', cursor: 'pointer',
              border: tandemMode ? '1px solid var(--border-focus)' : '1px solid transparent',
              fontSize: 12, fontWeight: 600,
              transition: 'background 0.15s ease, color 0.15s ease, border-color 0.15s ease',
            }}
          >
            超算
          </button>

          {/* 联网搜索开关 */}
          <button
            onClick={toggleWebSearch}
            title={webSearchEnabled ? '关闭联网搜索' : '开启联网搜索'}
            aria-label={webSearchEnabled ? '关闭联网搜索' : '开启联网搜索'}
            style={{
              width: 36, height: 36, borderRadius: '50%', flexShrink: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: webSearchEnabled ? 'var(--brand-dim)' : 'var(--bg-hover)',
              color: webSearchEnabled ? 'var(--brand)' : 'var(--text-tertiary)', cursor: 'pointer',
              border: webSearchEnabled ? '1px solid var(--border-focus)' : '1px solid transparent',
              transition: 'background 0.15s ease, color 0.15s ease, border-color 0.15s ease',
            }}
          >
            <Globe size={16} />
          </button>

          <motion.button
            onClick={isStreaming ? handleStop : handleSend}
            whileHover={input.trim() && !isStreaming ? { scale: 1.06 } : undefined}
            whileTap={input.trim() || isStreaming ? { scale: 0.94 } : undefined}
            disabled={!input.trim() && !isStreaming}
            title={isStreaming ? '停止生成' : (input.trim() ? '发送' : '请输入消息')}
            aria-label={isStreaming ? '停止生成' : '发送消息'}
            style={{
              width: 40, height: 40, borderRadius: '50%', flexShrink: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: isStreaming ? 'var(--danger)' : (input.trim() ? 'var(--brand)' : 'var(--bg-hover)'),
              color: isStreaming ? '#fff' : (input.trim() ? '#1a1a1c' : 'var(--text-tertiary)'),
              cursor: (input.trim() || isStreaming) ? 'pointer' : 'default',
              border: 'none',
              boxShadow: isStreaming
                ? '0 0 0 3px rgba(212,112,106,0.18), 0 4px 14px rgba(212,112,106,0.25)'
                : (input.trim() ? '0 0 0 3px var(--accent-dim), 0 4px 14px rgba(176,176,186,0.28)' : 'none'),
              transition: 'background 0.15s ease, box-shadow 0.2s ease',
            }}
          >
            {isStreaming
              ? <div style={{ width: 13, height: 13, background: '#fff', borderRadius: 3, animation: 'pulse-soft 1.2s ease-in-out infinite' }} />
              : <ArrowUp size={18} strokeWidth={2.2} />}
          </motion.button>
        </div>

        {/* 辅助行：快捷键提示（左） / 上下文用量（右） */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '4px 16px 10px' }}>
          <span style={{ fontSize: 12, color: 'var(--text-secondary)', fontWeight: 500, userSelect: 'none', whiteSpace: 'nowrap', letterSpacing: 0.2 }}>
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

      {messages.length > 0 ? renderMessages() : (
        <div style={{ flex: 1 }} />
      )}

      <div style={{ padding: '14px 20px 18px', display: 'flex', justifyContent: 'center' }}>
        {inputBar}
      </div>
    </div>
  )
}
