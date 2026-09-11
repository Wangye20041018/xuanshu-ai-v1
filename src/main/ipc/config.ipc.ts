import Store from 'electron-store'
import { ipcMain, app, BrowserWindow } from 'electron'
import path from 'path'
import fs from 'fs'
import { logger } from '../../shared/logger'
import { encrypt, decrypt, mask } from '../secure/secure-store'
import { validateSender } from '../utils/ipc-guard'
import { DEFAULT_SYSTEM_PROMPT, DEFAULT_USER_PROFILE } from '../../shared/default-persona'

interface AppConfig {
  theme: 'dark' | 'light'
  voice: {
    voicePack: string
    speed: number
    pitch: number
    volume: number
  }
  wakeWord: string
  wakeWordEnabled: boolean
  wakeWordSensitivity: number
  phoneSyncEnabled: boolean
  phoneChannels: Record<string, boolean>
  providers: ProviderConfig[]
  activeProvider: string
  activeModel: string
  autoUpdate: boolean
  sendStats: boolean
  autoStart: boolean
  defaultModelId: string
  systemPrompt: string
  userProfile: string
  webSearchEnabled: boolean
  cloudApiKey: string
  cloudApiUrl: string
  cloudModelName: string
  voiceExitWord: string
  voiceExitConfirmWords: string
  voiceExitCancelWords: string
  voiceExitConfirmTTS: string
  voiceContinuousMode: boolean
  startupModelId: string
  visionProvider: string
  orbTheme: string
  orbSize: number
  floatingBallEnabled: boolean
  floatingBallSnapToEdge: boolean
  floatingBallVoiceId: string
  floatingBallWakeMode: string
  floatingBallAutoStart: boolean
  orbEnabled: boolean
  voiceprint?: any
  controlGlowEnabled: boolean
  controlGlowBrightness: number
  controlGlowColor: string
  controlGlowIntensity: number
  intentEnabled: boolean
  /** MTP 自动识别开关（默认 true：架构支持 MTP 且型号含 MTP 的模型自动启用 MTP 参数） */
  mtpAutoEnable?: boolean
  /** 视觉 2B 纯内存推理兜底开关（默认 true：SGLang 不可用时自动切本地 CPU 后端跑 Qwen2-VL-2B） */
  visionCpuFallback?: boolean
}

interface ProviderConfig {
  id: string
  name: string
  type: string
  baseUrl?: string
  apiKey?: string
  models: string[]
}

/*
 * ALLOWED_CONFIG_KEYS — 配置键白名单
 *
 * 【活跃使用】Settings 页 / Home 页 / wake 服务有真实消费的键
 *   基础设置：autoUpdate, sendStats, autoStart
 *   提示词/画像：systemPrompt, userProfile
 *   语音退出：voiceExitWord, voiceExitConfirmWords, voiceExitCancelWords, voiceExitConfirmTTS
 *   语音持续模式：voiceContinuousMode
 *   云端配置：cloudApiKey, cloudApiUrl, cloudModelName, skillCombo
 *   声纹/降噪/球体：voiceprintId, noiseFilterOn, noiseLevel, orbTheme, orbSize
 *   模型/启动：defaultModelId, startupModelId, providers, activeProvider, modelConfig, visionProvider
 *   系统级：theme, voice, appVersion
 *
 * 【预留（规划中）】Settings 页面当前用组件 state 管理，不走 electron-store
 *   语音唤醒：wakeWord, wakeWordEnabled, wakeWordSensitivity
 *   手机同步：phoneSyncEnabled, phoneChannels
 *   模型切换：activeModel
 *
 * 这些键保留在白名单中，避免已有用户的 store 数据丢失。
 * 后续功能落地时应逐步迁移到规范路径（state ↔ electron-store 双向同步）。
 */
const ALLOWED_CONFIG_KEYS = new Set([
  // ===== 活跃使用 =====
  'autoUpdate', 'sendStats', 'autoStart',
  'systemPrompt', 'userProfile',
  'cloudApiKey', 'cloudApiUrl', 'cloudModelName', 'skillCombo',
  'voice', 'theme',
  'activeProvider', 'providers',
  'defaultModelId', 'appVersion',
  'voiceExitWord', 'voiceExitConfirmWords', 'voiceExitCancelWords',
  'voiceExitConfirmTTS', 'voiceContinuousMode',
  'startupModelId',
  'visionProvider',
  'modelConfig',
  'cloudApiModels',
  'cloudModels',
  'orbTheme',
  'orbSize',
  'floatingBallEnabled',
  'floatingBallSnapToEdge',
  'floatingBallVoiceId',
  'floatingBallWakeMode',
  'floatingBallAutoStart',
  'orbEnabled',
  'tandemConfig',
  'modelRegistry',
  'webSearchEnabled',
  'homeQuickActions',
  'selfModifyWriteEnabled',
  // ===== 智能体操作系统 · 控制电脑发光特效 =====
  'controlGlowEnabled',
  'controlGlowBrightness',
  'controlGlowColor',
  'controlGlowIntensity',
  // ===== 手势意图引擎 =====
  'intentEnabled',
  // ===== 推理链路开关（MTP 自动识别 / 视觉 CPU 兜底） =====
  'mtpAutoEnable',
  'visionCpuFallback',
  // ===== 预留（规划中）=====
  'wakeWord', 'wakeWordEnabled', 'wakeWordSensitivity',
  'phoneSyncEnabled', 'phoneChannels',
  'activeModel',
])

let store: Store<AppConfig> | null = null

/** 读取完整应用配置（未初始化时先初始化 store） */
export function getAppConfig(): AppConfig | null {
  if (!store) initStore()
  return store ? (store.store as AppConfig) : null
}

function initStore(): void {
  // 使用 userData 目录而非 exe 目录，确保安装后配置可写
  let appDataPath = app.getPath('userData')
  
  // 非ASCII路径回退：electron-store 在中文用户名下可能失败
  if (/[^\x00-\x7F]/.test(appDataPath)) {
    const fallbackDir = path.join(app.getPath('home'), '.xuanshu-config')
    try {
      if (!fs.existsSync(fallbackDir)) {
        fs.mkdirSync(fallbackDir, { recursive: true })
      }
      appDataPath = fallbackDir
      logger.warn('[Config] 检测到非ASCII用户路径，已回退到:', fallbackDir)
    } catch {
      logger.error('[Config] 回退路径创建失败，仍使用原始路径')
    }
  }
  
  // 确保目录存在
  if (!fs.existsSync(appDataPath)) {
    fs.mkdirSync(appDataPath, { recursive: true })
  }
  
  store = new Store<AppConfig>({
    cwd: appDataPath,
    name: 'config',
    defaults: {
      theme: 'dark',
      voice: {
        voicePack: 'default',
        speed: 1,
        pitch: 1,
        volume: 1
      },
      wakeWord: '玄枢',
      wakeWordEnabled: false,
      wakeWordSensitivity: 50,
      phoneSyncEnabled: false,
      intentEnabled: false,
      phoneChannels: {
        voice: true,
        text: true,
        notification: true,
        screen: false,
        control: false,
        data: true
      },
      providers: [],
      activeProvider: '',
      activeModel: '',
      autoUpdate: true,
      sendStats: false,
      autoStart: false,
      defaultModelId: '',
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      userProfile: DEFAULT_USER_PROFILE,
      webSearchEnabled: true,
      cloudApiKey: '',
      cloudApiUrl: '',
      cloudModelName: '',
      voiceExitWord: '退出',
      voiceExitConfirmWords: '确认退出,是的',
      voiceExitCancelWords: '取消,不要',
      voiceExitConfirmTTS: '确认退出语音模式吗？',
      voiceContinuousMode: true,
      startupModelId: '',
      visionProvider: '',
      orbTheme: 'default',
      orbSize: 220,
      floatingBallEnabled: false,
      floatingBallSnapToEdge: true,
      floatingBallVoiceId: 'xuanxu_warm_female',
      floatingBallWakeMode: 'click',
      floatingBallAutoStart: false,
      orbEnabled: false,
      // 智能体操作系统 · 发光特效默认开启 + 可调
      controlGlowEnabled: true,
      controlGlowBrightness: 0.8,
      controlGlowColor: 'blueviolet',
      controlGlowIntensity: 0.7,
    }
  })
}

export function setupConfigHandlers(): void {
  if (!store) {
    initStore()
  }

  ipcMain.handle('config:get', (_event, key?: string) => {
    try {
      if (!store) return undefined
      if (key) {
        const raw = store.get(key)
        return sanitizeForRead(key, raw)
      }
      // S1 修复：脱敏 API Key（加密存储后仅显示掩码）
      const safeConfig = { ...store.store }
      if (safeConfig.cloudApiKey) {
        safeConfig.cloudApiKey = mask(decrypt(safeConfig.cloudApiKey))
      }
      if (Array.isArray((safeConfig as any).providers)) {
        (safeConfig as any).providers = (safeConfig as any).providers.map((p: any) => ({
          ...p,
          apiKey: p.apiKey ? mask(decrypt(p.apiKey)) : undefined,
        }))
      }
      // 注入运行时版本信息
      return {
        ...safeConfig,
        appVersion: app.getVersion(),
        electronVersion: process.versions.electron || 'unknown',
      }
    } catch (error) {
      // B1.4: store 损坏时自动创建空 store 并告警
      logger.warn('[Config] config:get 失败，store 可能已损坏，尝试重建空 store:', error)
      try {
        initStore()
        logger.warn('[Config] 空 store 已创建')
        if (key) return undefined
        return { appVersion: app.getVersion(), electronVersion: process.versions.electron || 'unknown' }
      } catch (rebuildErr) {
        logger.error('[Config] 重建空 store 也失败:', rebuildErr)
        return undefined
      }
    }
  })

  ipcMain.handle('config:set', (event, key: string, value: unknown) => {
    // S4 修复：IPC 调用来源鉴权
    if (!validateSender(event)) return { success: false, error: '未授权的 IPC 调用' }
    try {
      if (!store) return false
      // 白名单验证：只允许已知的配置键名（skill_ 前缀为插件技能动态配置键）
      if (!ALLOWED_CONFIG_KEYS.has(key) && !key.startsWith('skill_')) {
        logger.warn(`[Config] 拒绝写入未注册配置项: ${key}`)
        return { success: false, error: `不允许的配置项: ${key}` }
      }

      // S1 修复：写入前加密 API Key 字段
      const sanitized = sanitizeForStore(key, value)
      store.set(key, sanitized)

      // 云端 API 字段变更时同步到 engine/config.json
      if (key === 'cloudApiKey' || key === 'cloudApiUrl' || key === 'cloudModelName') {
        syncCloudToEngineConfig(store)
      }

      return true
    } catch (error) {
      // B1.4: 写入失败时尝试重建 store 文件并通知渲染进程
      const errMsg = error instanceof Error ? error.message : String(error)
      logger.warn(`[Config] config:set('${key}') 失败:`, errMsg)

      try {
        // 尝试重建 store（重新初始化）
        const allWindows = BrowserWindow.getAllWindows()
        if (allWindows.length > 0) {
          allWindows.forEach(win => {
            try { win.webContents.send('config:error', `配置写入失败: ${errMsg}，正在尝试重建配置文件...`) } catch { /* pipe broken */ }
          })
        }

        // 重建 store：先尝试 clear + 重新设置
        store!.clear()
        const sanitized = sanitizeForStore(key, value)
        store!.set(key, sanitized)
        logger.debug('[Config] store 重建成功，配置已恢复')

        if (allWindows.length > 0) {
          allWindows.forEach(win => {
            try { win.webContents.send('config:error', '配置文件已重建，请刷新页面') } catch { /* pipe broken */ }
          })
        }

        // 云端 API 字段变更时同步
        if (key === 'cloudApiKey' || key === 'cloudApiUrl' || key === 'cloudModelName') {
          syncCloudToEngineConfig(store!)
        }
        return true
      } catch (rebuildErr) {
        const rebuildMsg = rebuildErr instanceof Error ? rebuildErr.message : String(rebuildErr)
        logger.error(`[Config] store 重建也失败:`, rebuildMsg)

        const allWindows = BrowserWindow.getAllWindows()
        if (allWindows.length > 0) {
          allWindows.forEach(win => {
            try { win.webContents.send('config:error', `配置存储严重损坏，写入失败: ${rebuildMsg}`) } catch { /* pipe broken */ }
          })
        }

        // 重建失败时，尝试初始化一个全新的路径
        try {
          initStore()
          const freshSanitized = sanitizeForStore(key, value)
          store!.set(key, freshSanitized)
          logger.debug('[Config] 全新 store 初始化成功')
          return true
        } catch (freshErr) {
          logger.error('[Config] 全新 store 也失败:', freshErr)
          return false
        }
      }
    }
  })

  ipcMain.handle('config:reset', (event) => {
    // S4 修复：IPC 调用来源鉴权（防任意调用清空全部配置）
    if (!validateSender(event)) return { success: false, error: '未授权的 IPC 调用' }
    try {
      if (!store) return {}
      store.clear()
      return store.store
    } catch (error) {
      logger.error('config:reset error:', error)
      return {}
    }
  })

  /* ===== 模型默认/启动设定 ===== */
  ipcMain.handle('model:set-default', (event, modelId: string) => {
    // S4 修复：IPC 调用来源鉴权
    if (!validateSender(event)) return false
    try {
      if (!store) return false
      store.set('defaultModelId', modelId || '')
      return true
    } catch (error) {
      logger.error('model:set-default error:', error)
      return false
    }
  })

  ipcMain.handle('model:set-startup', (event, modelId: string | null) => {
    // S4 修复：IPC 调用来源鉴权
    if (!validateSender(event)) return false
    try {
      if (!store) return false
      store.set('startupModelId', modelId || '')
      return true
    } catch (error) {
      logger.error('model:set-startup error:', error)
      return false
    }
  })

  ipcMain.handle('model:get-startup', () => {
    try {
      if (!store) return null
      const id = store.get('startupModelId')
      return id || null
    } catch (error) {
      logger.error('model:get-startup error:', error)
      return null
    }
  })

  /* ===== S1 修复：安全凭证读取（仅供主进程内部使用） ===== */
  ipcMain.handle('config:get-secure', (event, key: string) => {
    // S4 修复：IPC 调用来源鉴权（防任意调用读取解密后的明文 API Key）
    if (!validateSender(event)) {
      logger.warn('[Config] config:get-secure 被未授权来源调用')
      return undefined
    }
    try {
      if (!store) return undefined
      const raw = store.get(key)
      // 返回解密后的真实值
      if (key === 'cloudApiKey') {
        return decrypt(raw as string | undefined)
      }
      if (key === 'providers') {
        const providers = raw as ProviderConfig[] | undefined
        if (!providers) return undefined
        return providers.map(p => ({
          ...p,
          apiKey: decrypt(p.apiKey),
        }))
      }
      return raw
    } catch (error) {
      logger.error('config:get-secure error:', error)
      return undefined
    }
  })
}

function getStore(): Store<AppConfig> {
  if (!store) {
    initStore()
  }
  return store!
}

/**
 * S1 修复：写入前加密敏感字段（apiKey / cloudApiKey）
 */
function sanitizeForStore(key: string, value: unknown): unknown {
  if (key === 'cloudApiKey') {
    const encrypted = encrypt(value as string)
    return encrypted ?? value
  }
  if (key === 'providers' && Array.isArray(value)) {
    return (value as ProviderConfig[]).map(p => ({
      ...p,
      apiKey: p.apiKey ? (encrypt(p.apiKey) ?? p.apiKey) : undefined,
    }))
  }
  return value
}

/**
 * S1 修复：读取时解密敏感字段（供内部使用，如 config:get-secure）
 */
function sanitizeForRead(key: string, value: unknown): unknown {
  if (key === 'cloudApiKey') {
    return mask(decrypt(value as string))
  }
  if (key === 'providers' && Array.isArray(value)) {
    return (value as ProviderConfig[]).map(p => ({
      ...p,
      apiKey: p.apiKey ? mask(decrypt(p.apiKey)) : undefined,
    }))
  }
  return value
}

/**
 * 将云 API 配置同步到 engine/config.json（供 Python 后端读取）
 */
function syncCloudToEngineConfig(s: Store<AppConfig>): void {
  try {
    const engineConfigPath = path.join(app.getAppPath(), '..', 'engine', 'config.json')
    // 开发模式下 app.getAppPath() 可能指向 node_modules/electron/dist
    // 尝试多个候选路径
    const candidates = [
      engineConfigPath,
      path.join(process.env.XUANSHU_ENGINE_DIR || '', 'config.json'),
      path.join(app.getAppPath(), '..', '..', 'engine', 'config.json'),
      path.join(app.getPath('userData'), 'engine', 'config.json'),
    ]

    let configPath = ''
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        configPath = c
        break
      }
    }

    if (!configPath) {
      logger.warn('[config] 未找到 engine/config.json，跳过后端配置同步')
      return
    }

    const raw = fs.readFileSync(configPath, 'utf-8')
    const cfg = JSON.parse(raw)
    // S1 + C-12 修复：API Key 仅存于 safeStorage 加密存储，不再解密写入磁盘明文
    // Python 引擎不消费 XUANSHU_CLOUD_API_KEY（已确认），只同步非敏感字段与已配置标记
    cfg.cloud_api_url = s.get('cloudApiUrl', '')
    cfg.cloud_model_name = s.get('cloudModelName', '')
    const hasKey = !!s.get('cloudApiKey', '')
    cfg.cloud_api_key_configured = hasKey
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf-8')
    logger.debug('[config] 已同步云 API 配置到', configPath)
  } catch (e) {
    logger.error('[config] 同步 engine/config.json 失败:', e)
  }
}

export { store, initStore, getStore }
