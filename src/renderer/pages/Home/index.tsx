import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { AnimatePresence } from 'framer-motion'
import { useChatStore } from '../../store/chatStore'
import RightPanel from '../../components/RightPanel'
import TaskProgressOverlay from '../../components/TaskProgressOverlay'
import ErrorBoundary from '../../components/ErrorBoundary'
import { Logger } from '../../../shared/logger'
import { HEX_COLORS, COLORS } from '../../shared/theme'
import type { ModelRegistryEntry, TandemConfig, TandemStatusItem } from '../../../shared/ipc-types'

import HomeHeader from './HomeHeader'
import QuickActions from './QuickActions'
import ChatPanel from './ChatPanel'
import StatusBar from './StatusBar'
import type { TandemMode } from './messageRender'
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

  /* ------ 状态 ------ */
  const [input, setInput] = useState('')
  const [isStreaming, setStreaming] = useState(false)
  const [isFocused, setIsFocused] = useState(false)
  const [isRecording, setIsRecording] = useState(false)
  const [speakingId, setSpeakingId] = useState<string | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [panelOpen, setPanelOpen] = useState(false)
  const [editingConvId, setEditingConvId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [voiceContinuousMode, setVoiceContinuousMode] = useState(true)
  const [tandemMode, setTandemMode] = useState<TandemMode | null>(null)
  const [defaultModel, setDefaultModel] = useState<{ id: string; name: string; modelPath: string } | null>(null)
  const [modelHealthy, setModelHealthy] = useState(false) // P0-3: 模型引擎实际健康状态
  const [modelLoading, setModelLoading] = useState(false) // 体验优化：模型加载中（供「正在加载模型…」提示）
  const [modelLoadingName, setModelLoadingName] = useState<string | null>(null)
  const [aiSuggestion, setAiSuggestion] = useState<{ reason: string; clients: { name: string; exePath: string; version?: string }[] } | null>(null)

  const contextStats = useMemo(() => {
    const conv = conversations.find(c => c.id === currentConversationId)
    if (conv?.contextStats) return conv.contextStats
    const msgCount = messages.length
    const estimatedTokens = msgCount > 0 ? msgCount * 200 + 850 : 0
    return { totalTokens: 128000, usedTokens: estimatedTokens, compressedRounds: 0, compressionRatio: 0 }
  }, [conversations, currentConversationId, messages.length])

  const recognitionRef = useRef<any>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const streamCleanupRef = useRef<(() => void) | null>(null)

  // P0-1: 流状态管理 — 使用 ref 替代闭包变量，确保跨渲染周期可靠，并支持超时保护
  const streamStateRef = useRef({
    streamFinished: false,
    invokeFinished: false,
    assistantId: '',
  })
  const streamTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const manualStopRef = useRef(false)
  const audioStreamRef = useRef<MediaStream | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const voiceprintBufferRef = useRef<Float32Array>(new Float32Array(0))
  const voiceprintWriteIdxRef = useRef(0)
  const voiceContinuousModeRef = useRef(true) // P2-6: ref 同步，避免 handleSend 闭包过期

  // P2-6: 同步 voiceContinuousMode 到 ref，避免 handleSend 闭包过期
  useEffect(() => { voiceContinuousModeRef.current = voiceContinuousMode }, [voiceContinuousMode])

  /* ------ Effects ------ */
  useEffect(() => {
    if (window.api) {
      window.api.invoke('floating-ball:tandem-mode', !!tandemMode).catch((e) => { hlog.asyncError('tandemModeSync', e) })
    }
  }, [tandemMode])

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
          if (h?.modelName) setDefaultModel(prev => prev ?? { id: '', name: h.modelName!, modelPath: '' })
        })
        .catch(() => { if (!cancelled) setModelHealthy(false) })
    }
    checkHealth()
    const interval = setInterval(checkHealth, 5_000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [])

  // 体验优化：监听主进程模型加载状态广播（loading/ready/error），用于「正在加载模型…」友好提示
  useEffect(() => {
    if (!window.api?.on) return
    const unsub = window.api.on('model:load-status', (_event: any, data: any) => {
      if (!data || typeof data.status !== 'string') return
      if (data.status === 'loading') {
        setModelLoading(true)
        setModelLoadingName(data.modelName ?? null)
      } else {
        setModelLoading(false)
        if (data.status === 'ready' && data.modelName) setModelLoadingName(data.modelName ?? null)
      }
    })
    return () => { try { unsub() } catch { /* 非关键操作，失败可安全忽略 */ } }
  }, [])

  // M-19 修复：ensureSession 仅在挂载时执行一次，避免引用变化导致无限循环
  useEffect(() => { ensureSession() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (window.api) {
      window.api.invoke<boolean>('config:get', 'voiceContinuousMode').then(v => {
        if (typeof v === 'boolean') setVoiceContinuousMode(v)
      }).catch((e) => { hlog.asyncError('getVoiceContinuousConfig', e) })
    }
  }, [])

  useEffect(() => {
    if (!window.api?.on) return
    const unsub = window.api.on('chat:context-stats', (_event: any, stats: any) => {
      if (stats && currentConversationId) {
        updateContextStats(currentConversationId, {
          totalTokens: stats.totalTokens ?? 128000,
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
      try { recognitionRef.current?.stop() } catch (e) { hlog.asyncError('cleanupRecognition', e) }
      if (streamCleanupRef.current) streamCleanupRef.current()
      if (audioRef.current) { audioRef.current.pause(); audioRef.current = null }
    }
  }, [])

  /* ------ Handlers ------ */

  const handleSend = useCallback(async (overrideText?: string) => {
    if (isStreaming && !overrideText) return
    const text = (overrideText ?? input).trim()
    if (!text) return

    // P0-3: 模型预检 — 引擎未就绪时阻止发送并提示
    if (!tandemMode && !modelHealthy) {
      // M-18 修复：消息 ID 使用 crypto.randomUUID() 避免 Date.now() 碰撞
      addMessage({ id: crypto.randomUUID(), role: 'user' as const, content: text, timestamp: Date.now() })
      setInput('')
      const warnId = crypto.randomUUID()
      addMessage({ id: warnId, role: 'assistant' as const, content: '模型引擎尚未就绪，无法响应。请在模型设置页中导入模型并等待加载完成后再发送消息。', timestamp: Date.now() })
      return
    }

    // M-18 修复：消息 ID 使用 crypto.randomUUID() 避免 Date.now() 碰撞
    const userMessage = { id: crypto.randomUUID(), role: 'user' as const, content: text, timestamp: Date.now() }
    addMessage(userMessage)
    setInput('')
    setStreaming(true)
    const assistantId = crypto.randomUUID()
    const assistantMessage = { id: assistantId, role: 'assistant' as const, content: '', timestamp: Date.now() }
    addMessage(assistantMessage)

    if (voiceContinuousModeRef.current && recognitionRef.current) {
      try { recognitionRef.current.stop() } catch { /* 非关键操作，失败可安全忽略 */ }
    // 非关键操作，失败可安全忽略
    }

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
      if (voiceContinuousModeRef.current && !manualStopRef.current) {
        setTimeout(() => {
          try {
            const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
            recognitionRef.current = new SR()
            recognitionRef.current.continuous = true
            recognitionRef.current.interimResults = true
            recognitionRef.current.lang = 'zh-CN'
            recognitionRef.current.onresult = async (e: any) => {
              const transcript = Array.from(e.results).map((r: any) => r[0].transcript).join('')
              setInput(transcript)
              if (speakingId && audioRef.current) { audioRef.current.pause(); audioRef.current = null; setSpeakingId(null) }
              const latestResult = e.results[e.results.length - 1]
              const text = latestResult[0]?.transcript?.trim()
              if (text && window.api) {
                const ringBuf = voiceprintBufferRef.current
                if (ringBuf && ringBuf.length > 0) {
                  const writeIdx = voiceprintWriteIdxRef.current
                  const ordered = new Float32Array(ringBuf.length)
                  for (let i = 0; i < ringBuf.length; i++) ordered[i] = ringBuf[(writeIdx + i) % ringBuf.length]
                  window.api.send('voice:speech-audio', ordered)
                }
                window.api.send('wake:recognized-text', text)
                window.api.send('wake:voice-input')
                window.api.send('floating-ball:show-subtitle', text)
                try {
                  const { parseVoiceCommand, handleVoiceCommand } = await import('../../utils/voice-commands')
                  const cmd = parseVoiceCommand(text)
                  if (cmd) { handleVoiceCommand(cmd, speakCommandFeedback); setInput(''); return }
                } catch { /* 非关键操作，失败可安全忽略 */ }
              }
            }
            recognitionRef.current.onend = () => {
              if (window.api) window.api.send('floating-ball:hide-subtitle')
              if (voiceContinuousModeRef.current && !manualStopRef.current) {
                setTimeout(() => { try { recognitionRef.current?.start() } catch { setIsRecording(false) } }, 500)
              } else { setIsRecording(false) }
            }
            recognitionRef.current.onerror = () => setIsRecording(false)
            recognitionRef.current.start()
            setIsRecording(true)
          } catch { setIsRecording(false) }
        }, 800)
      }
    }

    // P0-1: 120 秒超时保护 — 模型引擎卡死时强制结束，防止 UI 永久阻塞
    streamTimeoutRef.current = setTimeout(() => {
      hlog.error(`handleSend timeout — forcing stream finish for assistant:${assistantId}`)
      ss.streamFinished = true
      ss.invokeFinished = true
      if (streamCleanupRef.current) { streamCleanupRef.current(); streamCleanupRef.current = null }
      tryFinish()
    }, 120_000)

    try {
      if (window.api) {
        if (tandemMode) {
          let running = false
          try {
            const status = await window.api.invoke<any[]>('tandem:status')
            if (status && status.filter((s: any) => s.status === 'running').length >= 2) running = true
          } catch { /* 非关键操作，失败可安全忽略 */ }

          if (!running) {
            // 自动启动：尝试用已注册模型拉起两个联动服务器，避免用户必须手动配置
            try {
              let cfg = await window.api.invoke<TandemConfig | null>('tandem:get-config')
              let modelList: any[] = []
              if (cfg && Array.isArray(cfg.models) && cfg.models.length >= 2 && (cfg.models as any[]).every(m => m.modelPath)) {
                modelList = cfg.models as any[]
              } else {
                const registryModels = await window.api.invoke<ModelRegistryEntry[]>('model-registry:list')
                if (registryModels && registryModels.length >= 2) {
                  const def = (registryModels as any[]).find((m: any) => m.isDefault) || registryModels[0]
                  const second = registryModels.find(m => m.id !== def.id) || registryModels[1]
                  modelList = [
                    {
                      id: def.id, name: def.name, modelPath: def.modelPath, port: 8080,
                      gpuLayers: 28, contextSize: 4096, mode: 'gpu', temperature: 0.7, maxTokens: 2048,
                    },
                    {
                      id: second.id, name: second.name, modelPath: second.modelPath, port: 8081,
                      gpuLayers: 0, contextSize: 2048, mode: 'cpu', temperature: 0.7, maxTokens: 2048,
                    },
                  ]
                  cfg = { models: modelList, hardwareLimit: { maxVRAM_MB: 5600, maxThreads: 8 }, defaultMode: tandemMode as any }
                  await window.api.invoke('tandem:load-config', cfg)
                }
              }
              // 逐个启动未运行的服务器；GPU 被占用时自动降级 CPU 重试
              for (const m of modelList.slice(0, 2)) {
                const cur = await window.api.invoke<any[]>('tandem:status')
                if (cur && cur.find((s: any) => s.modelId === m.id && s.status === 'running')) continue
                let res = await window.api.invoke<any>('tandem:start-server', m)
                if (!res?.success && res?.error && String(res.error).includes('GPU')) {
                  res = await window.api.invoke<any>('tandem:start-server', { ...m, mode: 'cpu', gpuLayers: 0 })
                }
              }
              const status2 = await window.api.invoke<any[]>('tandem:status')
              if (status2 && status2.filter((s: any) => s.status === 'running').length >= 2) running = true
            } catch { /* 自动启动失败走下方提示 */ }
          }

          if (!running) {
            updateMessage(assistantId, `[超算模式] 模型服务器未就绪（自动启动失败）。请在模型设置页「联动模式」中手动启动两个模型服务器（6GB 显存建议 1 个 GPU + 1 个 CPU 小模型）。`)
            ss.invokeFinished = true; tryFinish(); return
          }

          try {
            const config = await window.api.invoke<TandemConfig>('tandem:get-config')
            let modelAId = config?.models?.[0]?.id
            let modelBId = config?.models?.[1]?.id

            if (!modelAId || !modelBId) {
              const registryModels = await window.api.invoke<ModelRegistryEntry[]>('model-registry:list')
              if (registryModels && registryModels.length >= 2) { modelAId = registryModels[0].id; modelBId = registryModels[1].id }
              else if (registryModels && registryModels.length === 1 && defaultModel) {
                updateMessage(assistantId, `[超算模式] 仅接入 1 个模型（${registryModels[0].name}），超算联动需要至少 2 个模型。请在模型设置页接入更多模型。`)
                ss.invokeFinished = true; tryFinish(); return
              } else {
                updateMessage(assistantId, `[超算模式] 未接入模型，请在模型设置页导入模型并设为默认。`)
                ss.invokeFinished = true; tryFinish(); return
              }
            }

            const result = await window.api.invoke<TandemStatusItem>('tandem:chat', tandemMode, text, modelAId, modelBId)
            if (result.error) { updateMessage(assistantId, `[联动错误] ${result.error}`) }
            else if (result.success) { updateMessage(assistantId, JSON.stringify({ _tandem: true, mode: tandemMode, ...result })) }
            else { updateMessage(assistantId, `[联动模式] 未知响应`) }
          } catch (e) { updateMessage(assistantId, `[联动错误] ${(e as Error)?.message || String(e)}`) }
          ss.invokeFinished = true; tryFinish(); return
        }

        const latestMessages = useChatStore.getState().messages.filter(m => m.id !== assistantId && m.content !== undefined)
        // 记录发起流的会话 id：流式事件按 sessionId 路由，会话切换后内容仍写回原会话
        const streamConvId = useChatStore.getState().currentConversationId || undefined
        let systemContent = ''
        try {
          const sysPrompt = await window.api.invoke<string>('config:get', 'systemPrompt')
          const userProfile = await window.api.invoke<string>('config:get', 'userProfile')
          if (sysPrompt) systemContent += sysPrompt + '\n\n'
          if (userProfile) systemContent += `[用户画像]\n${userProfile}`
        } catch { /* 非关键操作，失败可安全忽略 */ }

        const rawMessages = latestMessages.map(m => ({ role: m.role, content: m.content }))
        let finalMessages = systemContent
          ? [{ role: 'system' as const, content: systemContent }, ...rawMessages]
          : rawMessages

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
              const current = (streamConvId ? useChatStore.getState().conversations.find(c => c.id === streamConvId)?.messages : useChatStore.getState().messages)?.find(m => m.id === assistantId)
              if (current && !current.content) {
                useChatStore.getState().updateMessage(assistantId, data.chunk, streamConvId)
              }
            }
            ss.streamFinished = true
            if (streamCleanupRef.current) { streamCleanupRef.current(); streamCleanupRef.current = null }
            tryFinish()
            return
          }
          useChatStore.getState().updateMessage(assistantId,
            ((streamConvId ? useChatStore.getState().conversations.find(c => c.id === streamConvId)?.messages : useChatStore.getState().messages)?.find(m => m.id === assistantId)?.content || '') + data.chunk, streamConvId)
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
          messages: finalMessages, stream: true, id: streamConvId })
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
      updateMessage(assistantId, `发送失败: ${formatErrorText(errMsg)}`)
    } finally {
      // P0-1: 保证所有路径（含异常）均标记流完成并清理
      ss.invokeFinished = true
      ss.streamFinished = true
      if (streamCleanupRef.current) { streamCleanupRef.current(); streamCleanupRef.current = null }
      tryFinish()
    }
  }, [input, isStreaming, tandemMode, modelHealthy, addMessage, updateMessage, setStreaming])

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

  const handleSpeakMessage = useCallback(async (msgId: string, text: string) => {
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

  // 语音命令执行失败时的语音反馈（避免静默失败，用户无感知）
  const speakCommandFeedback = useCallback(async (text: string) => {
    try {
      if (audioRef.current) { audioRef.current.pause(); audioRef.current = null }
      try { speechSynthesis.cancel() } catch (e) { hlog.asyncError('speakFeedback_cancel', e) }
      if (window.api) {
        const result = await window.api.invoke<{ success?: boolean; audioPath?: string }>('voice:speak', text)
        if (result && result.success && result.audioPath) {
          const audio = new Audio(); audioRef.current = audio
          audio.src = `local-file://${result.audioPath.replace(/\\/g, '/')}`
          await audio.play()
          return
        }
      }
      const utterance = new SpeechSynthesisUtterance(text); utterance.lang = 'zh-CN'
      speechSynthesis.speak(utterance)
    } catch (e) { hlog.asyncError('speakFeedback', e) }
  }, [])

  const startRecording = useCallback(async () => {
    if (isRecording || recognitionRef.current) return
    manualStopRef.current = false
    try {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        audioStreamRef.current = stream
        try {
          const audioCtx = new AudioContext({ sampleRate: 16000 }); audioContextRef.current = audioCtx
          const source = audioCtx.createMediaStreamSource(stream)
          const bufSize = audioCtx.sampleRate * 2; const ringBuf = new Float32Array(bufSize); let writeIdx = 0
          const processor = audioCtx.createScriptProcessor(4096, 1, 1)
          processor.onaudioprocess = (ev: AudioProcessingEvent) => {
            const input = ev.inputBuffer.getChannelData(0)
            for (let i = 0; i < input.length; i++) { ringBuf[writeIdx] = input[i]; writeIdx = (writeIdx + 1) % bufSize }
          }
          source.connect(processor); processor.connect(audioCtx.destination)
          voiceprintBufferRef.current = ringBuf; voiceprintWriteIdxRef.current = writeIdx
        } catch { /* 非关键操作，失败可安全忽略 */ }
      } catch (e) { hlog.asyncError('micPermission', e) }
      const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
      if (!SR) return
      recognitionRef.current = new SR()
      recognitionRef.current.continuous = true; recognitionRef.current.interimResults = true; recognitionRef.current.lang = 'zh-CN'
      recognitionRef.current.onresult = (e: any) => {
        const transcript = Array.from(e.results).map((r: any) => r[0].transcript).join('')
        setInput(transcript)
        if (speakingId && audioRef.current) { audioRef.current.pause(); audioRef.current = null; setSpeakingId(null) }
        const latestResult = e.results[e.results.length - 1]; const text = latestResult[0]?.transcript?.trim()
        if (text && window.api) {
          const ringBuf = voiceprintBufferRef.current
          if (ringBuf && ringBuf.length > 0) {
            const writeIdx = voiceprintWriteIdxRef.current; const ordered = new Float32Array(ringBuf.length)
            for (let i = 0; i < ringBuf.length; i++) ordered[i] = ringBuf[(writeIdx + i) % ringBuf.length]
            window.api.send('voice:speech-audio', ordered)
          }
          window.api.send('wake:recognized-text', text); window.api.send('wake:voice-input')
          window.api.send('floating-ball:show-subtitle', text)
          import('../../utils/voice-commands').then(({ parseVoiceCommand, handleVoiceCommand }) => {
            const cmd = parseVoiceCommand(text); if (cmd) { handleVoiceCommand(cmd, speakCommandFeedback); setInput('') }
          }).catch((e) => { hlog.asyncError('voiceCommands', e) })
        }
      }
      recognitionRef.current.onend = () => {
        if (window.api) window.api.send('floating-ball:hide-subtitle')
        if (voiceContinuousMode && !manualStopRef.current) { setTimeout(() => { try { recognitionRef.current?.start() } catch { setIsRecording(false) } }, 500) }
        else { setIsRecording(false) }
      }
      recognitionRef.current.onerror = () => {
        if (voiceContinuousMode && !manualStopRef.current) { setTimeout(() => { try { recognitionRef.current?.start() } catch { setIsRecording(false) } }, 1000) }
        else { setIsRecording(false) }
      }
      recognitionRef.current.start(); setIsRecording(true)
    } catch { setIsRecording(false) }
  }, [isRecording, voiceContinuousMode, speakingId])

  const stopRecording = useCallback(() => {
    manualStopRef.current = true
    try { recognitionRef.current?.stop() } catch (e) { hlog.asyncError('stopRecording', e) }
    finally { setIsRecording(false) }
  }, [])

  const handleSwitchConv = useCallback((id: string) => { switchConversation(id); setHistoryOpen(false) }, [switchConversation])

  const hasMessages = messages.length > 0

  return (
    <ErrorBoundary>
      <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'relative', background: 'var(--bg-base)' }}>
        <StatusBar
          historyOpen={historyOpen} setHistoryOpen={setHistoryOpen}
          panelOpen={panelOpen} setPanelOpen={setPanelOpen}
          modelHealthy={modelHealthy}
          modelName={defaultModel?.name ?? null}
          modelLoading={modelLoading}
          modelLoadingName={modelLoadingName}
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
          isRecording={isRecording}
          isFocused={isFocused}
          setIsFocused={setIsFocused}
          handleSend={handleSend}
          handleStop={handleStop}
          startRecording={startRecording}
          stopRecording={stopRecording}
          handleSpeakMessage={handleSpeakMessage}
          tandemMode={tandemMode}
          setTandemMode={setTandemMode}
          onTaskAppend={handleTaskAppend}
          onTaskEnd={handleTaskEnd}
          contextStats={contextStats}
          historyOpen={historyOpen}
          setHistoryOpen={setHistoryOpen}
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
                <HomeHeader onPick={(text) => { setInput(text); handleSend(text) }} />
                <QuickActions setInput={setInput} />
              </div>
            </div>
          )}
        </AnimatePresence>
      </div>

      <AnimatePresence>
        {panelOpen && <RightPanel onClose={() => setPanelOpen(false)} />}
      </AnimatePresence>

      <TaskProgressOverlay />
    </ErrorBoundary>
  )
}
