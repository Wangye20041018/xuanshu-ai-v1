import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { AnimatePresence } from 'framer-motion'
import { useChatStore } from '../../store/chatStore'
import { useTaskRunEvents } from '../../hooks/useTaskRunEvents'
import ErrorBoundary from '../../components/ErrorBoundary'
import { Logger } from '../../../shared/logger'
import { HEX_COLORS, COLORS } from '../../shared/theme'
// #修复1 人设预设打底：system 为空时兜底注入默认身份（贾维斯×星期五×真人级伙伴桌面助手）
import { buildDefaultSystemContent } from '../../../shared/default-persona'

import HomeHeader from './HomeHeader'
import ChatPanel, { type AttachmentItem } from './ChatPanel'
import StatusBar from './StatusBar'
import type { TaskCardData } from '../../components/TaskCard'

/* ========== 错误文案友好化（用户体验：避免抛英文/堆栈） ========== */
function formatErrorText(raw: string): string {
  if (!raw) return '请求失败，请稍后重试。'
  const lower = raw.toLowerCase()
  if (/econnrefused|connection refused|connect refused|address in use|111\b/.test(lower)) {
    return '无法连接到模型引擎（连接被拒绝）。请确认模型已在模型设置页加载并处于运行状态，然后重试。'
  }
  if (/timeout|timed out|超时|abort/.test(lower)) {
    return '模型响应超时。若多次出现，请尝试切换更轻量的模型或减少上下文长度。'
  }
  if (/fetch failed|enetunreach|eai_again|econnreset|network|getaddrinfo|无法访问|断网/.test(lower)) {
    return '网络请求失败，请检查网络连接后重试。'
  }
  if (/no handler|not registered/.test(lower)) {
    return '该功能暂不可用（内部通道未注册），请重启应用后重试。'
  }
  if (/not loaded|未加载|no model|no available model|模型.*未就绪/.test(lower)) {
    return '模型尚未加载。请前往模型设置页加载模型后重试。'
  }
  if (/api[_-]?key|unauthorized|401|403|invalid.*credential/.test(lower)) {
    return 'API Key 无效或未授权。请前往模型设置页检查并更新 API Key。'
  }
  return `请求失败：${raw}`
}

/* ========== Home 编排组件 ========== */
export default function Home() {
  const hlog = new Logger('Home')
  const {
    messages, conversations, currentConversationId,
    addMessage, updateMessage, createConversation, switchConversation,
    deleteConversation, renameConversation, updateContextStats,
    ensureSession,
  } = useChatStore()

  // 订阅任务步骤/工具调用过程事件（全局一次），归并进非持久化 taskRunStore 供任务时间线渲染
  useTaskRunEvents()

  /* ------ 状态 ------ */
  const [input, setInput] = useState('')
  const [isStreaming, setStreaming] = useState(false)
  const [isFocused, setIsFocused] = useState(false)
  const [speakingId, setSpeakingId] = useState<string | null>(null)
  // P4 语音重构：逐条朗读的暂停/继续状态（暂停作用于 audioRef / speechSynthesis）
  const [speakingPaused, setSpeakingPaused] = useState(false)
  const speakingPausedRef = useRef(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [editingConvId, setEditingConvId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  // F批：输入区待发送附件（拖拽/粘贴暂存），发送时构造真实内容数组消息
  const [attachments, setAttachments] = useState<AttachmentItem[]>([])
  const attachmentsRef = useRef<AttachmentItem[]>([])
  useEffect(() => { attachmentsRef.current = attachments }, [attachments])
  const [modelHealthy, setModelHealthy] = useState(false) // P0-3: 模型引擎实际健康状态
  const [aiSuggestion, setAiSuggestion] = useState<{ reason: string; clients: { name: string; exePath: string; version?: string }[] } | null>(null)

  // 上下文用量面板：只消费主进程 chat:context-stats 推送的真实数据（manager.buildContext 计算后经 chat.ipc.ts 映射推送）。
  // 未推送时返回空对象，ContextIndicator 显示 0%（无假数值/写死上限），严禁本地估算制造假显示。
  const contextStats = useMemo(() => {
    const conv = conversations.find(c => c.id === currentConversationId)
    return conv?.contextStats ?? null
  }, [conversations, currentConversationId])

  const audioRef = useRef<HTMLAudioElement | null>(null)
  const streamCleanupRef = useRef<(() => void) | null>(null)

  // P0-1: 流状态管理 — 使用 ref 替代闭包变量，确保跨渲染周期可靠，并支持超时保护
  const streamStateRef = useRef({
    streamFinished: false,
    invokeFinished: false,
    assistantId: '',
  })
  const streamTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const speakMsgRef = useRef<(msgId: string, text: string) => void>(() => {}) // P4: 供 tryFinish 自动朗读引用（handleSpeakMessage 定义在其后）

  /* ------ Effects ------ */

  // P0-3: 模型引擎健康检查 — 启动时检查 + 周期轮询（5s），追踪实际加载状态
  useEffect(() => {
    // 修复：加入 cancelled 标志，避免组件卸载后异步回调仍调用 setState
    let cancelled = false
    const checkHealth = () => {
      if (!window.api || cancelled) return
      window.api.invoke<{ healthy: boolean; reason: string; modelName: string | null }>('model:health')
        .then(h => {
          if (cancelled) return
          setModelHealthy(!!h?.healthy)
        })
        .catch(() => { if (!cancelled) setModelHealthy(false) })
    }
    checkHealth()
    const interval = setInterval(checkHealth, 5_000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [])

  // M-19 修复：ensureSession 仅在挂载时执行一次，避免引用变化导致无限循环
  useEffect(() => { ensureSession() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!window.api?.on) return
    const unsub = window.api.on('chat:context-stats', (_event: any, stats: any) => {
      if (stats && currentConversationId) {
        updateContextStats(currentConversationId, {
          totalTokens: stats.totalTokens ?? 0,
          usedTokens: stats.usedTokens ?? 0,
          compressedRounds: stats.compressedRounds ?? 0,
          compressionRatio: stats.compressionRatio ?? 0,
        })
      }
    })
    return () => { try { unsub() } catch { /* 非关键操作，失败可安全忽略 */ } }
  }, [currentConversationId, updateContextStats])

  useEffect(() => {
    return () => {
      if (streamCleanupRef.current) streamCleanupRef.current()
      if (audioRef.current) { audioRef.current.pause(); audioRef.current = null }
    }
  }, [])

  /* ------ Handlers ------ */

  // F批：拖拽/粘贴文件 → 转真实绝对路径（复用 A批15 getPathForFile）→ 暂存为附件，同名去重
  const addAttachments = useCallback((files: File[]) => {
    const items: AttachmentItem[] = files.map(f => {
      const path = window.api?.getPathForFile?.(f) || (f as any).path || f.name
      return {
        id: crypto.randomUUID(), path,
        type: (f.type && f.type.startsWith('image/')) ? 'image' : 'file',
        name: f.name, mime: f.type || undefined,
      }
    })
    setAttachments(prev => {
      const seen = new Set(prev.map(a => a.path))
      return [...prev, ...items.filter(a => !seen.has(a.path))]
    })
  }, [])

  const removeAttachment = useCallback((id: string) => {
    setAttachments(prev => prev.filter(a => a.id !== id))
  }, [])

  const handleSend = useCallback(async (overrideText?: string) => {
    const text = (overrideText ?? input).trim()
    // F批：附件（拖拽/粘贴的真实文件）与文本均计入发送条件——允许「纯图片/纯文件」消息
    const pendingFiles = attachmentsRef.current
    if (!text && pendingFiles.length === 0) return

    // D11: AI 生成/思考中允许「追加指令」——生成中/思考中可直接接着发，追加进会话。
    // 先终止当前流（已生成内容已随 rAF flush 落盘保留），再以完整会话上下文 + 新指令快速续一轮，
    // 复用 handleStop 同款清理（内联避免声明顺序依赖），避免双流并发竞态。
    if (isStreaming && !overrideText) {
      if (streamCleanupRef.current) { streamCleanupRef.current(); streamCleanupRef.current = null }
      if (streamTimeoutRef.current) { clearTimeout(streamTimeoutRef.current); streamTimeoutRef.current = null }
      streamStateRef.current.streamFinished = true
      streamStateRef.current.invokeFinished = true
      try { if (window.api) await window.api.invoke('chat:stop', useChatStore.getState().currentConversationId || undefined) } catch (e) { hlog.asyncError('handleSend-stop', e) }
      return handleSend(text)
    }

    // P0-3: 模型预检 — 引擎未就绪时阻止发送并提示
    if (!modelHealthy) {
      // M-18 修复：消息 ID 使用 crypto.randomUUID() 避免 Date.now() 碰撞
      const warnFiles = pendingFiles.map(f => ({ path: f.path, type: f.mime || f.type, name: f.name }))
      addMessage({ id: crypto.randomUUID(), role: 'user' as const, content: text, timestamp: Date.now(), files: warnFiles.length ? warnFiles : undefined })
      setInput('')
      setAttachments([])
      const warnId = crypto.randomUUID()
      addMessage({ id: warnId, role: 'assistant' as const, content: '模型引擎尚未就绪，无法响应。请在模型设置页中导入模型并等待加载完成后再发送消息。', timestamp: Date.now() })
      return
    }

    // M-18 修复：消息 ID 使用 crypto.randomUUID() 避免 Date.now() 碰撞
    // F批：真实内容数组附件随用户消息一起入会话（main 侧 extractTextContent 已兼容内容数组）
    const userFiles = pendingFiles.map(f => ({ path: f.path, type: f.mime || f.type, name: f.name }))
    const userMessage = {
      id: crypto.randomUUID(), role: 'user' as const, content: text, timestamp: Date.now(),
      files: userFiles.length ? userFiles : undefined,
    }
    addMessage(userMessage)
    setInput('')
    setAttachments([])
    setStreaming(true)
    const assistantId = crypto.randomUUID()
    const assistantMessage = { id: assistantId, role: 'assistant' as const, content: '', timestamp: Date.now() }
    // A批8：流式输出 rAF 合帧 —— 正文/推理先在闭包内全量累积（覆盖式写入天然防重复），
    // 每个动画帧最多写一次 store，token 密集也不丢字、不卡 UI；done/stop/超时/异常均强制落盘。
    // A批7：startAt 记录真实首帧时间，flush 后按真实字符数估算 token（UI 标注「约」）并计算耗时与速度。
    // 记录发起流的会话 id：流式事件按 sessionId 路由，会话切换后内容仍写回原会话
    const streamConvId = useChatStore.getState().currentConversationId || undefined
    const startAt = Date.now()
    let accContent = ''
    let accReasoning = ''
    let accRafId: number | null = null
    let accRafDirty = false
    const flushAcc = () => {
      if (accRafId !== null) { cancelAnimationFrame(accRafId); accRafId = null }
      accRafDirty = false
      if (!accContent && !accReasoning) return
      useChatStore.getState().updateMessage(assistantId, accContent, streamConvId, accReasoning)
    }
    const scheduleFlush = () => {
      if (accRafDirty) return
      accRafDirty = true
      accRafId = requestAnimationFrame(() => {
        accRafId = null
        accRafDirty = false
        useChatStore.getState().updateMessage(assistantId, accContent, streamConvId, accReasoning)
      })
    }
    // 仅记录「确有内容」的生成统计；token 为基于真实字符数的估算值，UI 会以「约」标注
    const recordMeta = () => {
      if (!accContent && !accReasoning) return
      const charCount = accContent.length
      const tokenEstimate = Math.max(1, Math.round(charCount * 0.75))
      const elapsedMs = Date.now() - startAt
      useChatStore.getState().updateMessageMeta(assistantId, { tokenEstimate, elapsedMs, charCount }, streamConvId)
    }
    addMessage(assistantMessage)

    if (streamCleanupRef.current) { streamCleanupRef.current(); streamCleanupRef.current = null }

    // P0-1: 每次发送前重置流状态，使用 ref 确保跨渲染周期可靠
    const ss = streamStateRef.current
    ss.streamFinished = false
    ss.invokeFinished = false
    ss.assistantId = assistantId
    if (streamTimeoutRef.current) { clearTimeout(streamTimeoutRef.current); streamTimeoutRef.current = null }

    /**
     * 尝试结束流。仅当 (streamFinished && invokeFinished) 或超时触发。
     * 超时保护：120 秒后强制结束，防止模型引擎卡死导致 UI 永久阻塞。
     */
    const tryFinish = () => {
      if (streamTimeoutRef.current) { clearTimeout(streamTimeoutRef.current); streamTimeoutRef.current = null }
      if (!ss.streamFinished || !ss.invokeFinished) return
      setStreaming(false)
      // P4 语音重构：autoSpeak 开启时，回复完成后自动朗读最终文本
      if (window.api) {
        window.api.invoke<{ autoSpeak?: boolean }>('voice:get-settings')
          .then((gs) => {
            if (gs && gs.autoSpeak) {
              const finalText = useChatStore.getState().messages.find(m => m.id === assistantId)?.content
              if (finalText && finalText.trim()) speakMsgRef.current(assistantId, finalText)
            }
          })
          .catch(() => { /* 非关键操作，失败可安全忽略 */ })
      }
    }

    // P0-1: 120 秒超时保护 — 模型引擎卡死时强制结束，防止 UI 永久阻塞
    streamTimeoutRef.current = setTimeout(() => {
      hlog.error(`handleSend timeout — forcing stream finish for assistant:${assistantId}`)
      flushAcc()
      recordMeta()
      ss.streamFinished = true
      ss.invokeFinished = true
      if (streamCleanupRef.current) { streamCleanupRef.current(); streamCleanupRef.current = null }
      tryFinish()
    }, 120_000)

    try {
      if (window.api) {
        const latestMessages = useChatStore.getState().messages.filter(m => m.id !== assistantId && m.content !== undefined)
        let systemContent = ''
        try {
          const sysPrompt = await window.api.invoke<string>('config:get', 'systemPrompt')
          const userProfile = await window.api.invoke<string>('config:get', 'userProfile')
          if (sysPrompt) systemContent += sysPrompt + '\n\n'
          if (userProfile) systemContent += `[用户画像]\n${userProfile}`
        } catch { /* 非关键操作，失败可安全忽略 */ }

        // #修复1 人设预设打底：config 中无 systemPrompt/userProfile 时兜底注入默认身份，
        // 保证无论加载/更换任何模型（流水盘 GGUF），请求都带单条 system，模型始终知道自己是谁
        if (!systemContent.trim()) {
          systemContent = buildDefaultSystemContent()
        }

        // F批/B5-2续（方案02 Step1）：识图根因修复 —— 发送链路构造「内容数组」真实图片消息。
        // 把最新一条含 [图片: path] 占位标记的用户消息解析为 OpenAI 多模态分段
        // [{type:'text',text}, {type:'image_url',image_url:{url}}]，
        // 让 main 端 buildRouteSignal.hasImage 识别到真实图片并触发 swapToVision 看图分支；
        // 历史消息保持 string，避免上下文构建/生成器被无谓数组污染。
        const parseImageMarkToParts = (content: string): Array<{ type: string; text?: string; image_url?: { url: string } }> => {
          const parts: Array<{ type: string; text?: string; image_url?: { url: string } }> = []
          let last = 0
          const re = /\[图片:\s*([^\]]+)\]/g
          let it: RegExpExecArray | null
          while ((it = re.exec(content))) {
            const before = content.slice(last, it.index)
            if (before.trim()) parts.push({ type: 'text', text: before })
            const path = it[1].trim()
            if (path) parts.push({ type: 'image_url', image_url: { url: path } })
            last = it.index + it[0].length
          }
          const tail = content.slice(last)
          if (tail.trim()) parts.push({ type: 'text', text: tail })
          return parts
        }
        const rawMessages = latestMessages.map((m, idx) => {
          const c = m.content
          const isLastUser = idx === latestMessages.length - 1 && m.role === 'user'
          // F批：附件消息优先 —— 由真实文件数组直接构造 OpenAI multi-part 内容数组，
          // 图片 → image_url、其余 → text 文件引用；main 端 buildRouteSignal.hasImage 据此切看图分支
          if (isLastUser && Array.isArray((m as any).files) && (m as any).files.length > 0) {
            const parts: Array<{ type: string; text?: string; image_url?: { url: string } }> = []
            if (c.trim()) parts.push({ type: 'text', text: c })
            for (const f of (m as any).files) {
              const ftype: string = f.type || ''
              if (ftype.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp)$/i.test(f.path || '')) {
                parts.push({ type: 'image_url', image_url: { url: f.path } })
              } else {
                parts.push({ type: 'text', text: `[文件] ${f.name || f.path}: ${f.path}` })
              }
            }
            return { role: m.role, content: parts }
          }
          if (!isLastUser || typeof c !== 'string' || !/\[图片:\s*[^\]]+\]/.test(c)) {
            return { role: m.role, content: c }
          }
          const parts = parseImageMarkToParts(c)
          return parts.length > 0 ? { role: m.role, content: parts } : { role: m.role, content: c }
        })
        let finalMessages = [
          { role: 'system' as const, content: systemContent },
          ...rawMessages,
        ]

        // #修复2 工具能力注入：发送时携带已注册工具名白名单，
        // 后端 toolRegistry 白名单校验后组装完整 schema 透传 provider，与具体模型无关
        let toolWhitelist: string[] = []
        try {
          const listRes = await window.api.invoke<any>('agent:list-tools')
          if (listRes && listRes.success && Array.isArray(listRes.data)) {
            toolWhitelist = listRes.data.map((t: any) => t.name).filter(Boolean)
          }
        } catch { /* 工具清单拉取失败时后端默认全量注入 */ }

        // 联网搜索开关：开启时自动补充实时搜索结果作为模型参考上下文
        if (text.trim()) {
          try {
            const webSearchOn = await window.api.invoke<boolean>('config:get', 'webSearchEnabled')
            if (webSearchOn) {
              const engines = await window.api.invoke<any[]>('search:list-engines')
              const engineIds = (engines || []).slice(0, 3).map((e: any) => e.id).filter(Boolean)
              if (engineIds.length > 0) {
                const searchRes = await window.api.invoke<any>('search:web-multi', { query: text, engines: engineIds })
                const results = searchRes?.results || []
                if (results.length > 0) {
                  const searchText = results
                    .slice(0, 6)
                    .map((r: any, i: number) => `${i + 1}. ${r.title || ''}${r.url ? ` (${r.url})` : ''}\n${(r.snippet || r.content || '').slice(0, 300)}`)
                    .join('\n\n')
                  const searchSystem = `[联网搜索结果]（实时信息，供回答参考，引用时标注来源）\n${searchText}`
                  finalMessages = [{ role: 'system' as const, content: searchSystem }, ...finalMessages]
                }
              }
            }
          } catch { /* 搜索失败不影响正常对话 */ }
        }

        const unsubStream = window.api.on('chat:stream', (_event: any, data: any) => {
          // 会话路由：事件带 sessionId 且与发起流会话不一致时，丢弃（防止旧流污染新会话）
          if (data.sessionId && streamConvId && data.sessionId !== streamConvId) return
          if (data.done) {
            // 处理 Hybrid 路径在 done:true 中携带的内容
            if (data.chunk) {
              accContent = accContent ? accContent + data.chunk : data.chunk
            }
            // 「只有思考没有回答」发布级兜底：流正常结束、正文为空但思考存在时，
            // 说明思考型模型只输出了 reasoning 未产出 content —— 不把思考串为正文，
            // 思考仍仅保留在「深度思考」折叠区；正文写入明确提示避免空白/悬浮
            if (!accContent && accReasoning) {
              accContent = '**[模型仅返回了思考过程，未生成回答正文。]**\n\n请点击上方「深度思考」查看推理内容；如频繁出现，可在模型设置中关闭「深度思考」开关后重试。'
            }
            // 结束：取消未执行的帧，把最终完整内容一次性落 store（不丢字）
            flushAcc()
            recordMeta()
            ss.streamFinished = true
            if (streamCleanupRef.current) { streamCleanupRef.current(); streamCleanupRef.current = null }
            tryFinish()
            return
          }
          // M-3 / A批8：推理流与正文流独立累积，rAF 合帧（每帧最多一次写入），覆盖式全量不重复
          if (data.kind === 'reasoning') {
            accReasoning += data.chunk || ''
            scheduleFlush()
            return
          }
          accContent += data.chunk || ''
          scheduleFlush()
        })
        // v12.2 任务前扫描建议：复杂任务未走云端时，主进程推送本机 AI 客户端建议
        const unsubSuggest = window.api.on('chat:ai-client-suggestion', (_e: any, data: any) => {
          if (data.sessionId && streamConvId && data.sessionId !== streamConvId) return
          if (data.clients && data.clients.length > 0) {
            setAiSuggestion({ reason: data.reason || '', clients: data.clients })
          }
        })
        streamCleanupRef.current = () => { unsubStream(); unsubSuggest() }

        const result = await window.api.invoke<{ content?: string; error?: string; success?: boolean; stopped?: boolean }>('chat:send', {
          messages: finalMessages, stream: true, id: streamConvId, tools: toolWhitelist })
        if (result.error && result.stopped !== true) { updateMessage(assistantId, `错误: ${formatErrorText(result.error)}`) }
        else if (result.content) { const current = useChatStore.getState().messages.find(m => m.id === assistantId); if (current && !current.content) updateMessage(assistantId, result.content) }
      } else {
        await new Promise(r => setTimeout(r, 1500))
        updateMessage(assistantId, '正在连接本地模型引擎，请稍后再试。若长时间无响应，请前往模型设置页检查模型状态。')
        setStreaming(false)
      }
    } catch (error: any) {
      hlog.asyncError('handleSend', error)
      const errMsg = error?.message || error?.toString?.() || '未知错误'
      // 错误提示并入已累积内容（已产出部分回复时不丢），再统一落盘
      const errText = `发送失败: ${formatErrorText(errMsg)}`
      accContent = accContent ? `${accContent}\n\n${errText}` : errText
      flushAcc()
    } finally {
      // P0-1: 保证所有路径（含异常）均标记流完成并清理
      // A批8：异常/中止路径也把已累积的完整内容落 store，确保不丢字
      flushAcc()
      recordMeta()
      ss.invokeFinished = true
      ss.streamFinished = true
      if (streamCleanupRef.current) { streamCleanupRef.current(); streamCleanupRef.current = null }
      tryFinish()
    }
  }, [input, isStreaming, modelHealthy, addMessage, updateMessage, setStreaming])

  const handleStop = useCallback(async () => {
    if (!isStreaming) return
    // P0-1: 手动停止时清理所有流状态，防止残留
    if (streamCleanupRef.current) { streamCleanupRef.current(); streamCleanupRef.current = null }
    if (streamTimeoutRef.current) { clearTimeout(streamTimeoutRef.current); streamTimeoutRef.current = null }
    streamStateRef.current.streamFinished = true
    streamStateRef.current.invokeFinished = true
    try { if (window.api) await window.api.invoke('chat:stop', useChatStore.getState().currentConversationId || undefined) } catch (e) { hlog.asyncError('handleStop', e) }
    finally { setStreaming(false) }
  }, [isStreaming, setStreaming])

  // TaskCard 交互：追加消息 — 向任务追加指令，作为新消息发送
  const handleTaskAppend = useCallback((task: TaskCardData) => {
    handleSend(`继续任务「${task.title}」：请继续执行当前任务，汇报最新进展。`)
  }, [handleSend])

  // TaskCard 交互：结束任务 — 先等待当前流停止，再发送终止指令（避免 chat:stop 与新消息竞态）
  const handleTaskEnd = useCallback(async (task: TaskCardData) => {
    if (isStreaming) { await handleStop() }
    handleSend(`[结束任务] ${task.title}：请立即停止当前任务，汇总已完成进度并汇报结果。`)
  }, [handleSend, handleStop, isStreaming])

  const handleStartRename = useCallback((id: string, currentTitle: string) => { setEditingConvId(id); setEditTitle(currentTitle) }, [])
  const handleConfirmRename = useCallback((id: string) => { if (editTitle.trim()) renameConversation(id, editTitle.trim()); setEditingConvId(null); setEditTitle('') }, [editTitle, renameConversation])
  const handleCancelRename = useCallback(() => { setEditingConvId(null); setEditTitle('') }, [])

  // P4 语音重构：逐条朗读暂停/继续（作用于 audioRef 与 speechSynthesis）
  const togglePauseSpeaking = useCallback(() => {
    const nextPaused = !speakingPausedRef.current
    speakingPausedRef.current = nextPaused
    setSpeakingPaused(nextPaused)
    if (audioRef.current) {
      try { if (nextPaused) { audioRef.current.pause() } else { void audioRef.current.play() } } catch { /* ignore */ }
    }
    try { if (nextPaused) { window.speechSynthesis?.pause() } else { window.speechSynthesis?.resume() } } catch { /* ignore */ }
  }, [])

  // P4 语音重构：逐条朗读停止
  const stopSpeaking = useCallback(() => {
    speakingPausedRef.current = false
    setSpeakingPaused(false)
    if (audioRef.current) { try { audioRef.current.pause() } catch { /* ignore */ } audioRef.current = null }
    try { window.speechSynthesis?.cancel() } catch { /* ignore */ }
    setSpeakingId(null)
  }, [setSpeakingId])

  const handleSpeakMessage = useCallback(async (msgId: string, text: string) => {
    speakingPausedRef.current = false
    setSpeakingPaused(false)
    if (audioRef.current) { audioRef.current.pause(); audioRef.current = null }
    try { speechSynthesis.cancel() } catch (e) { hlog.asyncError('handleSpeak_cancel', e) }
    setSpeakingId(msgId)
    try {
      if (window.api) {
        let voiceId: string | undefined
        try { const voiceSettings = await window.api.invoke<{ currentVoiceId?: string }>('voice:get-current'); voiceId = voiceSettings?.currentVoiceId } catch { /* 非关键操作，失败可安全忽略 */ }
        const result = await window.api.invoke<{ success: boolean; audioPath?: string }>('voice:speak', text, voiceId)
        if (result && result.success && result.audioPath) {
          const audio = new Audio(); audioRef.current = audio
          audio.src = `local-file://${result.audioPath.replace(/\\/g, '/')}`
          audio.onended = () => setSpeakingId(null); audio.onerror = () => setSpeakingId(null)
          await audio.play()
        } else {
          const utterance = new SpeechSynthesisUtterance(text); utterance.lang = 'zh-CN'
          utterance.onend = () => setSpeakingId(null); utterance.onerror = () => setSpeakingId(null)
          speechSynthesis.speak(utterance)
        }
      }
    } catch (e) { hlog.asyncError('handleSpeak_tts', e); setSpeakingId(null) }
  }, [setSpeakingId])

  // P4: 保持 speakMsgRef 指向最新 handleSpeakMessage，供 handleSend.tryFinish 自动朗读调用
  useEffect(() => { speakMsgRef.current = handleSpeakMessage }, [handleSpeakMessage])

  // P4 语音重构：朗读快捷键（Alt+R 朗读选中文本/最后一条AI回复、Alt+P 暂停/继续、Esc 停止朗读）
  const ttsKeyRef = useRef<{ pause: () => void; stop: () => void }>({ pause: () => {}, stop: () => {} })
  useEffect(() => { ttsKeyRef.current = { pause: togglePauseSpeaking, stop: stopSpeaking } })
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      const isTyping = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      if (e.altKey && e.code === 'KeyR' && !e.ctrlKey && !e.shiftKey) {
        e.preventDefault()
        const sel = (window.getSelection()?.toString() || '').trim()
        if (sel) {
          speakMsgRef.current('selection', sel)
        } else {
          const lastAi = [...messages].reverse().find((m) => m.role === 'assistant' && m.content)
          if (lastAi) speakMsgRef.current(lastAi.id, lastAi.content)
        }
        return
      }
      if (e.altKey && e.code === 'KeyP' && !e.ctrlKey && !e.shiftKey) {
        e.preventDefault()
        ttsKeyRef.current.pause()
        return
      }
      if (e.code === 'Escape' && !isTyping) {
        ttsKeyRef.current.stop()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [messages])


  const handleSwitchConv = useCallback((id: string) => { switchConversation(id); setHistoryOpen(false) }, [switchConversation])

  const hasMessages = messages.length > 0

  return (
    <ErrorBoundary>
      <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'relative', background: 'var(--bg-base)' }}>
        <StatusBar
          historyOpen={historyOpen} setHistoryOpen={setHistoryOpen}
          onNewChat={() => createConversation()}
        />

        {/* v12.2 AI 客户端建议条：复杂任务未走云端时展示，可一键打开本机 AI 客户端接管推理 */}
        <AnimatePresence>
          {aiSuggestion && (
            <div style={{
              position: 'absolute', top: 8, left: '50%', transform: 'translateX(-50%)',
              zIndex: 50, maxWidth: 640, width: 'calc(100% - 48px)',
              background: 'rgba(24,26,35,0.96)', border: `1px solid ${HEX_COLORS.blue}44`,
              borderRadius: 14, padding: '12px 14px', boxShadow: '0 8px 32px rgba(0,0,0,0.35)',
              backdropFilter: 'blur(10px)',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 8 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: COLORS.accent, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ width: 7, height: 7, borderRadius: '50%', background: COLORS.accent, display: 'inline-block' }} />
                  复杂任务未走云端{aiSuggestion.reason ? `（${aiSuggestion.reason}）` : ''}
                </span>
                <button onClick={() => setAiSuggestion(null)} style={{
                  background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(255,255,255,0.5)',
                  fontSize: 13, padding: 2, fontFamily: 'inherit',
                }}>忽略</button>
              </div>
              <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.65)', marginBottom: 8 }}>
                可指定以下本机 AI 客户端接管本次超大任务推理，玄枢将把任务结果回传
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {aiSuggestion.clients.map(c => (
                  <button key={c.exePath} onClick={() => {
                    window.api?.invoke('app:launch', c.exePath).catch(() => {})
                    setAiSuggestion(null)
                  }} style={{
                    padding: '6px 12px', borderRadius: 9, cursor: 'pointer', fontFamily: 'inherit', fontSize: 12,
                    background: COLORS.accentDim, border: `1px solid ${HEX_COLORS.accent}60`, color: COLORS.accentLight,
                  }}>{c.name}</button>
                ))}
              </div>
            </div>
          )}
        </AnimatePresence>

        <ChatPanel
          messages={messages}
          isStreaming={isStreaming}
          speakingId={speakingId}
          input={input}
          setInput={setInput}
          isFocused={isFocused}
          setIsFocused={setIsFocused}
          handleSend={handleSend}
          handleStop={handleStop}
          handleSpeakMessage={handleSpeakMessage}
          speakingPaused={speakingPaused}
          togglePauseSpeaking={togglePauseSpeaking}
          stopSpeaking={stopSpeaking}
          onTaskAppend={handleTaskAppend}
          onTaskEnd={handleTaskEnd}
          contextStats={contextStats}
          historyOpen={historyOpen}
          setHistoryOpen={setHistoryOpen}
          attachments={attachments}
          onAddAttachments={addAttachments}
          onRemoveAttachment={removeAttachment}
          conversations={conversations}
          currentConversationId={currentConversationId}
          createConversation={createConversation}
          switchConversation={handleSwitchConv}
          deleteConversation={deleteConversation}
          editingConvId={editingConvId}
          editTitle={editTitle}
          setEditTitle={setEditTitle}
          handleStartRename={handleStartRename}
          handleConfirmRename={handleConfirmRename}
          handleCancelRename={handleCancelRename}
        />

        <AnimatePresence>
          {!hasMessages && (
            <div style={{
              position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
              pointerEvents: 'none', zIndex: 1,
            }}>
              <div style={{ pointerEvents: 'auto', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                <HomeHeader />
              </div>
            </div>
          )}
        </AnimatePresence>
      </div>

      {/* 工作面板已移除（发布整改第一批）：删除 RightPanel 渲染与入口 */}
    </ErrorBoundary>
  )
}
