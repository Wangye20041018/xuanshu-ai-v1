import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron'

export type IpcChannels =
  | 'chat:send'
  | 'chat:stop'
  | 'chat:stream'
  | 'chat:ai-client-suggestion'
  | 'chat:context-stats'
  | 'config:get'
  | 'config:set'
  | 'llm:list-providers'
  | 'llm:test-provider'
  | 'llm:add-provider'
  | 'llm:update-provider'
  | 'llm:delete-provider'
  | 'llm:fetch-models'
  | 'llm:set-active-provider'
  | 'window:minimize'
  | 'window:close'
  | 'window:maximize'
  | 'window:is-maximized'
  | 'voice:list-voices'
  | 'voice:speak'
  | 'voice:get-voices'
  | 'voice:get-current'
  | 'voice:set-current'
  | 'voice:get-settings'
  | 'voice:tts-status'
  | 'voice:noise-filter-toggle'
  | 'wake:start'
  | 'wake:stop'
  | 'wake:status'
  | 'wake:set-config'
  | 'wake:auto-start'
  | 'wake:history'
  | 'floating-ball:tandem-mode'
  | 'floating-ball:snap-check'
  | 'floating-ball:unhide'
  | 'mobile:start-server'
  | 'mobile:stop-server'
  | 'mobile:set-pairing-code'
  | 'mobile:get-pairing-code'
  | 'mobile:on-message'
  | 'mobile:connection-status'
| 'mobile:server-status'
| 'mobile:pairing-code'
| 'mobile:connect-peer'
| 'mobile:disconnect-peer'
| 'mobile:list-peers'
| 'mobile:send-peer-data'
| 'mobile:broadcast-data'
| 'mobile:toggle-channel'
| 'mobile:set-config'
| 'mobile:known-devices'
| 'mobile:send-signaling'
  | 'search:query'
| 'search:list-engines'
| 'search:test-engine'
  | 'search:web-multi'
  | 'search:get-status'
  | 'model:list'
  | 'model:download'
  | 'model:download:progress'
  | 'model:health'
  | 'model:load-status'
  | 'plugin:list'
  | 'plugin:install'
  | 'plugin:store-list'
  | 'plugin:create'
  | 'plugin:delete'
  | 'plugin:toggle'
  | 'plugin:execute'
  | 'plugin:status'
  | 'plugin:tools'
  | 'plugin:register'
  | 'plugin:unregister'
  | 'plugin:toggle-auto'
  | 'plugin:generate-code'
  | 'plugin:generate'
  | 'memory:list'
  | 'memory:add'
  | 'memory:delete'
  | 'memory:search'
  | 'knowledge:list'
  | 'knowledge:add'
  | 'knowledge:delete'
  | 'knowledge:upload'
| 'knowledge:update'
  | 'knowledge:search'
  | 'knowledge:pending'
  | 'knowledge:auto-learn'
  | 'knowledge:ignore-pending'
  | 'sync:channel:list'
  | 'sync:channel:enable'
  | 'sync:channel:disable'
  | 'sync:status'
  | 'rag:add-memory'
  | 'rag:add-knowledge'
  | 'rag:search'
  | 'rag:search-memory'
  | 'rag:search-knowledge'
  | 'rag:delete'
  | 'rag:list-memories'
  | 'rag:list-knowledge'
  | 'rag:get-context'
  | 'rag:stats'
| 'rag:clear'
| 'kg:add-entity'
| 'kg:update-entity'
| 'kg:delete-entity'
| 'kg:add-relation'
| 'kg:delete-relation'
| 'kg:get-entity'
| 'kg:search-entities'
| 'kg:get-relations'
| 'kg:query'
| 'kg:find-path'
| 'kg:extract-entities'
| 'kg:infer-relation'
| 'kg:stats'
| 'kg:export'
| 'kg:import'
| 'kg:clear'
| 'ollama:status'
  | 'ollama:start'
  | 'ollama:list-models'
  | 'ollama:pull-model'
  | 'ollama:create-model'
  | 'ollama:delete-model'
  | 'ollama:chat'
  | 'ollama:vision'
  | 'sglang:status'
  | 'sglang:start'
  | 'sglang:stop'
  | 'sglang:list-models'
  | 'sglang:load-model'
  | 'sglang:unload-model'
  | 'sglang:chat'
  | 'sglang:vision'
  | 'sglang:is-running'
  | 'vision:get-sources'
  | 'vision:capture-screen'
  | 'vision:capture-window'
  | 'vision:save-screenshot'
  | 'vision:analyze-screen'
  | 'vision:analyze-image'
  | 'vision:get-desktop-description'
  | 'system:control:get-desktop-info'
  | 'system:control:get-active-window'
  | 'system:control:take-screenshot'
  | 'system:control:execute-command'
  | 'desktop-automation:get-screen-size'
  | 'desktop-automation:get-virtual-screen'
  | 'desktop-automation:admin-status'
  | 'desktop-automation:find-window'
  | 'desktop-automation:find-windows'
  | 'desktop-automation:capture-window'
  | 'desktop-automation:click-at'
  | 'desktop-automation:type-text'
  | 'desktop-automation:send-keys'
  | 'desktop-automation:find-on-screen'
  | 'desktop-automation:open-app'
  | 'desktop-automation:get-active-window'
  | 'desktop-automation:show-desktop'
  | 'desktop-automation:lock-screen'
  | 'desktop-automation:set-volume'
  | 'desktop-automation:elevate-self'
  | 'desktop-automation:run-elevated'
  | 'desktop-automation:registry-read'
  | 'desktop-automation:registry-write'
  | 'desktop-automation:registry-delete'
  | 'desktop-automation:service-list'
  | 'desktop-automation:service-start'
  | 'desktop-automation:service-stop'
  | 'desktop-automation:service-status'
  | 'desktop-automation:env-var-set'
  | 'desktop-automation:process-kill'
  | 'desktop-automation:task-schedule'
  | 'desktop-automation:ocr-image'
  | 'diagnostics:export'
  | 'desktop-automation:status'
  | 'app:get-icon-path'
  | 'health:run'
  | 'health:fix'
  | 'vision:set-config'
  | 'vision:get-config'
  | 'vision:add-task'
  | 'vision:add-batch'
  | 'vision:get-task'
  | 'vision:get-all-tasks'
  | 'vision:get-pending-tasks'
  | 'vision:get-completed-tasks'
  | 'vision:cancel-task'
  | 'vision:clear-completed'
  | 'vision:clear-all'
  | 'model:pause-download'
  | 'model:resume-download'
  | 'model:cancel-download'
  | 'model:get-download-tasks'
  | 'model:import-gguf'
  | 'system:snapshot'
  | 'system:snapshots'
  | 'model:manager:register'
  | 'model:manager:load'
  | 'model:manager:unload'
  | 'model:manager:list'
  | 'model:manager:loaded'
  | 'model:manager:current'
  | 'model:manager:is-loaded'
  | 'model:manager:switch'
  | 'model:manager:stats'
  | 'model:manager:memory'
  | 'model:manager:gpu'
  | 'model:manager:update-usage'
  | 'model:manager:set-max-memory'
  | 'model:manager:runtime'
  | 'model:standby:load'
  | 'model:standby:unload'
  | 'model:standby:status'
  | 'model:standby:generate'
  | 'model:config'
  | 'model:save-config'
  | 'model:delete'
  | 'model:activate'
| 'model:active'
  | 'model:analyze-file'
  | 'model:set-default'
  | 'model:set-startup'
  | 'model:scan-local'
  | 'model:get-startup'
  | 'model-registry:list'
  | 'model-registry:add'
  | 'model-registry:remove'
  | 'model-registry:set-default'
  | 'model-registry:toggle-startup'
  | 'model-registry:toggle-standby'
  | 'model-registry:get-default'
  | 'model-registry:get-startup-models'
  | 'model-registry:update-runtime'
  | 'model-registry:restart-model'
  | 'model-registry:runtime-status'
| 'permission:get-status'
  | 'permission:check-all'
  | 'permission:request'
  | 'permission:request-all'
  | 'permission:show-dialog'
  | 'dialog:open'
  | 'app:launch'
  | 'cloud-quota:get'
  | 'cloud-quota:set-limit'
  | 'cloud-quota:reset'
  | 'cloud-quota:remote-balance'
  | 'local-ai:list'
  | 'local-ai:scan'
  | 'local-ai:suggest'
  | 'permission:is-admin'
  | 'permission:registry-check'
  | 'proxy:detect'
  | 'proxy:test'
  | 'proxy:refresh'
  | 'inference:gpu-status'
  | 'inference:cpu-load'
  | 'inference:cpu-generate'
  | 'inference:cpu-unload'
  | 'piper:needs-download'
| 'piper:download'
| 'piper:download-models'
  | 'tandem:load-config'
  | 'tandem:get-config'
  | 'tandem:start-server'
  | 'tandem:stop-server'
  | 'tandem:stop-all'
  | 'tandem:switch-model'
  | 'tandem:status'
  | 'tandem:status-change'
  | 'tandem:query'
  | 'tandem:dual-answer'
  | 'tandem:partner-answer'
  | 'tandem:mentor-answer'
  | 'tandem:debate-answer'
  | 'tandem:chat'
  | 'floating-ball:open'
  | 'floating-ball:hide'
  | 'floating-ball:toggle'
  | 'floating-ball:show-panel'
  | 'floating-ball:open-main'
  | 'search:index-directory'
| 'search:query-files'
| 'search:index-file'
| 'search:delete-file'
| 'search:index-stats'
  | 'voice:clone:start'
  | 'voice:clone:list'
  | 'voice:clone:delete'
  | 'voice:clone:test'
  | 'visual:capture'
  | 'visual:capture-window'
  | 'visual:analyze'
  | 'visual:click'
  | 'visual:double-click'
  | 'visual:right-click'
  | 'visual:type'
  | 'visual:press-keys'
  | 'visual:drag'
  | 'visual:scroll'
  | 'visual:get-state'
  | 'visual:cancel'
  | 'visual:execute-task'
  | 'skill-pack:list'
  | 'skill-pack:match'
  | 'skill-pack:execute'
  | 'skill-pack:learned-list'
  | 'skill-pack:learned-remove'
  | 'skill-pack:learned-set-enabled'
  | 'context:fusion'
  | 'ppt:create'
  | 'voice:clone:presets'
  | 'voice:preview'
  | 'voice:delete-voice'
  | 'voice:speech-input'
  | 'voice:speech-audio'
  | 'wake:recognized-text'
  | 'wake:voice-input'
  | 'voiceprint:status'
  | 'voiceprint:enroll'
  | 'voiceprint:verify'
  | 'voiceprint:clear'
  | 'voiceprint:delete-sample'
  | 'voiceprint:noise-check'
  | 'voiceprint:noise-filter'
  | 'voiceprint:noise-level'
  | 'voiceprint:mfcc-status'
  | 'floating-ball:action'
  | 'floating-ball:show-subtitle'
  | 'floating-ball:hide-subtitle'
  | 'model:check-disk'
  | 'model:check-network'
  | 'model:list-refresh'
  | 'router:state'
  | 'router:toast'
  | 'router:get-state'
  | 'control:state'
  | 'persona:list'
  | 'persona:get'
  | 'persona:tier'
| 'personalization:learn'
| 'personalization:get-preference'
| 'personalization:set-preference'
| 'personalization:get-habits'
| 'personalization:get-suggested-tasks'
| 'personalization:get-suggested-commands'
| 'personalization:get-personas'
| 'personalization:get-persona'
| 'personalization:set-persona'
| 'personalization:get-current-persona'
| 'personalization:add-persona'
| 'personalization:update-persona'
| 'personalization:get-hints'
| 'personalization:set-learning'
| 'personalization:reset'
| 'personalization:export'
| 'personalization:import'
| 'uia:locate'
  | 'uia:find-text'
  | 'config:reset'
  | 'automation:save'
| 'automation:delete'
| 'automation:toggle'
| 'automation:start'
| 'automation:stop'
| 'automation:execute'
| 'automation:classify'
| 'automation:list'
  | 'external-ai:generate-image'
  | 'external-ai:quota'
  | 'external-ai:providers'
  | 'external-ai:settings'
  | 'external-ai:update-settings'
  | 'external-ai:history'
  | 'external-ai:clear-history'
  | 'operation:analyze'
  | 'operation:execute-task'
  | 'operation:cancel'
  | 'operation:list-tasks'
  | 'operation:get-task'
  | 'operation:status'
  | 'python:initialize'
  | 'python:run'
  | 'python:status'
  | 'python:ping'
  | 'python:get-script'
  | 'device:profile'
  | 'device:config'
  | 'device:update-config'
  | 'device:should-throttle'
  | 'device:recommended-models'
  | 'device:start-monitoring'
  | 'device:stop-monitoring'
  | 'device:optimize-power'
  | 'device:memory-estimate'
  | 'search:time'
  | 'search:weather'
  | 'search:fetch-url'
  | 'search:set-online'
  | 'search:get-tools'
  | 'search:exchange-rate'
  | 'search:news'
  | 'search:rag-search'
  | 'search:get-context'
  | 'vision:capture'
  | 'vision:analyze'
  | 'vision:locate'
  | 'vision:read-text'
  | 'vision:verify'
  | 'vision:status'
  | 'vision:set-base-url'
  | 'vision:set-resolution'
  | 'vision:capture-region'
  | 'vision:analyze-batch'
  | 'vision:preload'
  | 'vision:template-match'
  | 'vision:cache-stats'
  | 'vision:clear-cache'
  | 'permission:fix'
  | 'permission:fix-all'
  | 'permission:get-detail'
  | 'permission:status'
  | 'router:request-tier'
  | 'model:manager:delete'
  | 'floating-ball:screenshot-ready'
  | 'floating-ball:start-voice-note'
  | 'floating-ball:start-quick-note'
  | 'floating-ball:ocr-result'
  | 'floating-ball:translate'
  | 'floating-ball:add-reminder'
  | 'model:downloaded'
  | 'vision:task-update'
  | 'voice:discussion:started'
  | 'voice:discussion:stopped'
  | 'wake:detected'
  | 'wake:renderer-status'
  | 'tts:speak'
  | 'tts:stop'
  | 'tts:pause'
  | 'tts:resume'
  | 'device:stats'
  | 'app:ready'
  | 'perf:fps-report'
  | 'perf:get-stats'
  // v2.3 摄像头追踪
  | 'camera:start'
  | 'camera:stop'
  | 'camera:state'
  | 'camera:gesture'
  | 'camera:frame'
  | 'audio:start'
  | 'audio:stop'
  | 'audio:state'
  | 'context:start'
  | 'context:snapshot'
  | 'context:dominant'
  | 'context:set-proactivity'
  | 'context:set-privacy'
  | 'context:profile'
  | 'context:weekly-report'
  | 'context:point-at:set'
  | 'context:point-at:state'
  | 'context:point-at:trigger'
  | 'context:point-at'
  | 'context:attention'
  | 'emotion:detect'
  | 'emotion:get-state'
  | 'emotion:observe'
  | 'emotion:state'
  | 'floating-ball:get-state'
  | 'floating-ball:voice-command'
  | 'floating-ball:set-tandem'
  | 'backup:export'
  | 'backup:import'
  | 'backup:get-info'
  | 'backup:restore-localstorage'
  | 'self-modify:get-capabilities'
  | 'self-modify:list-files'
  | 'self-modify:read-file'
  | 'self-modify:generate'
  | 'self-modify:preview-diff'
  | 'self-modify:apply'
  | 'self-modify:rollback'
  | 'self-modify:list-snapshots'
  | 'self-modify:progress'
  // ===== 智能体操作系统（Agent OS） =====
  | 'agent:list'
  | 'agent:get'
  | 'agent:save'
  | 'agent:delete'
  | 'agent:create-request'
  | 'agent:create-confirm'
  | 'agent:run'
  | 'agent:stop'
  | 'agent:event'
  | 'agent:list-personas'
  | 'agent:list-tools'
  | 'agent:whitelist-list'
  | 'agent:whitelist-add'
  | 'agent:whitelist-remove'
  | 'agent:panic'
  | 'swarm:plan'
  | 'swarm:run'
  | 'swarm:status'
  | 'swarm:event'
  | 'browser:create-tab'
  | 'browser:close-tab'
  | 'browser:switch-tab'
  | 'browser:navigate'
  | 'browser:go-back'
  | 'browser:go-forward'
  | 'browser:reload'
  | 'browser:list-tabs'
  | 'browser:extract-content'
  | 'browser:screenshot'
  | 'browser:add-bookmark'
  | 'browser:list-bookmarks'
  | 'browser:remove-bookmark'
  | 'browser:event'

export const TTS_CHANNELS = {
  SPEAK: 'tts:speak' as const,
  STOP: 'tts:stop' as const,
  PAUSE: 'tts:pause' as const,
  RESUME: 'tts:resume' as const,
} as const

type Callback = (event: IpcRendererEvent, ...args: unknown[]) => void

const api = {
  invoke: <T = unknown>(channel: IpcChannels, ...args: unknown[]): Promise<T> => {
    // M-01 修复：Promise.race 结束后清理超时定时器，避免高频调用累积未清理定时器
    let timeoutId: ReturnType<typeof setTimeout> | undefined
    const invokePromise = ipcRenderer.invoke(channel, ...args)
    const timeoutPromise = new Promise<T>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error(`IPC 调用超时: ${channel} (30s)`)), 30000)
    })
    return Promise.race([invokePromise, timeoutPromise]).finally(() => clearTimeout(timeoutId)) as Promise<T>
  },

  invokeWithTimeout: <T = unknown>(channel: IpcChannels, timeoutMs: number, ...args: unknown[]): Promise<T> => {
    // M-01 修复：Promise.race 结束后清理超时定时器
    let timeoutId: ReturnType<typeof setTimeout> | undefined
    const invokePromise = ipcRenderer.invoke(channel, ...args)
    const timeoutPromise = new Promise<T>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error(`IPC 调用超时: ${channel} (${timeoutMs}ms)`)), timeoutMs)
    })
    return Promise.race([invokePromise, timeoutPromise]).finally(() => clearTimeout(timeoutId)) as Promise<T>
  },

  /**
   * 安全 invoke：失败不抛出，统一返回 { ok, data?, error? }，
   * 并派发 DOM 事件通知渲染层展示全局 toast（避免各页面静默失败）。
   * 注意：不改变既有 invoke 语义，仅新增一层可选的失败统一提示入口。
   */
  invokeSafe: async <T = unknown>(channel: IpcChannels, ...args: unknown[]): Promise<{ ok: boolean; data?: T; error?: string }> => {
    let timeoutId: ReturnType<typeof setTimeout> | undefined
    const invokePromise = ipcRenderer.invoke(channel, ...args)
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error(`IPC 调用超时: ${channel} (30s)`)), 30000)
    })
    try {
      const data = (await Promise.race([invokePromise, timeoutPromise])) as T
      return { ok: true, data }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      try {
        window.dispatchEvent(new CustomEvent('xuanshu:ipc-error', { detail: { channel, message } }))
      } catch {
        /* 忽略派发失败 */
      }
      return { ok: false, error: message }
    } finally {
      clearTimeout(timeoutId)
    }
  },

  send: (channel: IpcChannels, ...args: unknown[]): void => {
    ipcRenderer.send(channel, ...args)
  },

  on: (channel: IpcChannels, callback: Callback): (() => void) => {
    const subscription = (_event: IpcRendererEvent, ...args: unknown[]) => callback(_event, ...args)
    ipcRenderer.on(channel, subscription)
    return () => {
      ipcRenderer.removeListener(channel, subscription)
    }
  },

  once: (channel: IpcChannels, callback: Callback): void => {
    ipcRenderer.once(channel, callback)
  },

  removeAllListeners: (channel: IpcChannels): void => {
    ipcRenderer.removeAllListeners(channel)
  },

  // FIX: 暴露语音合成功能，直接在渲染进程调用（主进程无DOM）
  speechSynthesis: window.speechSynthesis,
  SpeechSynthesisUtterance: window.SpeechSynthesisUtterance,

  // FIX: TTS 辅助方法，渲染进程直接调用
  speak: (text: string, options?: { pitch?: number; rate?: number; volume?: number; lang?: string }): Promise<void> => {
    return new Promise((resolve, reject) => {
      if (!window.speechSynthesis) {
        reject(new Error('Speech synthesis not supported'))
        return
      }
      const utterance = new window.SpeechSynthesisUtterance(text)
      utterance.lang = options?.lang || 'zh-CN'
      if (options?.pitch !== undefined) utterance.pitch = options.pitch
      if (options?.rate !== undefined) utterance.rate = options.rate
      if (options?.volume !== undefined) utterance.volume = options.volume
      utterance.onend = () => resolve()
      utterance.onerror = (e) => reject(e)
      window.speechSynthesis.speak(utterance)
    })
  },

  stopSpeaking: (): void => {
    window.speechSynthesis?.cancel()
  },

  pauseSpeaking: (): void => {
    window.speechSynthesis?.pause()
  },

  resumeSpeaking: (): void => {
    window.speechSynthesis?.resume()
  },

  // FIX: 监听主进程广播的TTS事件（兼容旧IPC调用方式）
  onTtsEvent: (callback: (event: string, data?: unknown) => void): (() => void) => {
    const handlers: Record<string, (event: IpcRendererEvent, data?: unknown) => void> = {
      [TTS_CHANNELS.SPEAK]: (_e, data) => callback('speak', data),
      [TTS_CHANNELS.STOP]: () => callback('stop'),
      [TTS_CHANNELS.PAUSE]: () => callback('pause'),
      [TTS_CHANNELS.RESUME]: () => callback('resume'),
    }
    Object.entries(handlers).forEach(([channel, handler]) => {
      ipcRenderer.on(channel, handler)
    })
    return () => {
      Object.entries(handlers).forEach(([channel, handler]) => {
        ipcRenderer.removeListener(channel, handler)
      })
    }
  },
}

contextBridge.exposeInMainWorld('api', api)

export type ElectronApi = typeof api
