import {app, shell} from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, unlinkSync } from 'fs'
import { exec, spawn } from 'child_process'
import { promisify } from 'util'
import { POWERSHELL_EXE } from '../utils/powershell'
import { pythonRuntime } from '../runtime/python'
import { visionModel } from '../vision'
import { createSandbox } from './sandbox'
import { logger } from '../../shared/logger'

const execAsync = promisify(exec)

// C-05 修复：spawn + shell:false + 参数数组执行，杜绝 cmd.exe 元字符注入
function runSpawn(exe: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* 已退出 */ }
      if (!settled) { settled = true; reject(new Error('命令执行超时')) }
    }, 10_000)
    child.stdout.on('data', (d: Buffer) => { if (stdout.length < 2 * 1024 * 1024) stdout += d.toString() })
    child.stderr.on('data', (d: Buffer) => { if (stderr.length < 2 * 1024 * 1024) stderr += d.toString() })
    child.on('close', (code: number) => {
      clearTimeout(timer)
      if (settled) return
      settled = true
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(stderr || `Exit code: ${code}`))
    })
    child.on('error', (err: Error) => {
      clearTimeout(timer)
      if (!settled) { settled = true; reject(err) }
    })
  })
}

/* ==================== 插件接口定义 ==================== */

export interface Plugin {
  id: string
  name: string
  description: string
  version: string
  icon: string
  enabled: boolean
  createdAt: number
  /** SGLang Function Calling 工具描述 */
  toolDefinition: {
    type: 'function'
    function: {
      name: string
      description: string
      parameters: {
        type: 'object'
        properties: Record<string, { type: string; description: string }>
        required: string[]
      }
    }
  }
}

export interface PluginExecuteResult {
  success: boolean
  data?: any
  error?: string
}

export interface PluginStatus {
  total: number
  enabled: number
  disabled: number
  plugins: Plugin[]
}

/* ==================== 插件引擎核心 ==================== */

class PluginEngine {
  private plugins: Map<string, Plugin> = new Map()
  private pluginDir: string | null = null
  private initialized: boolean = false

  constructor() {
    // 延迟初始化
  }

  initialize(): void {
    if (this.initialized) return
    try {
      this.pluginDir = join(app.getPath('userData'), 'plugins')
      mkdirSync(this.pluginDir, { recursive: true })
      this.loadBuiltinPlugins()
      this.loadCustomPlugins()
      this.initialized = true
    } catch (error) {
      logger.error('PluginEngine initialize error:', error)
    }
  }

  private getPluginDir(): string {
    if (!this.pluginDir) {
      this.initialize()
    }
    return this.pluginDir!
  }

  /* ==================== 内置 8 个插件 ==================== */

  private loadBuiltinPlugins(): void {
    const builtinPlugins: Plugin[] = [
      {
        id: 'web-search',
        name: '网页搜索',
        description: '打开浏览器搜索，自动联网搜索相关信息，为回答提供实时数据支持',
        version: '1.0.0',
        icon: 'search',
        enabled: true,
        createdAt: Date.now(),
        toolDefinition: {
          type: 'function',
          function: {
            name: 'web_search',
            description: '在浏览器中搜索指定关键词，获取实时网络信息',
            parameters: {
              type: 'object',
              properties: {
                query: { type: 'string', description: '搜索关键词' },
                engine: { type: 'string', description: '搜索引擎，可选: google, bing, baidu' }
              },
              required: ['query']
            }
          }
        }
      },
      {
        id: 'file-manager',
        name: '文件管理',
        description: '快速浏览、创建、编辑电脑上的文件和文件夹',
        version: '1.0.0',
        icon: 'folder',
        enabled: true,
        createdAt: Date.now(),
        toolDefinition: {
          type: 'function',
          function: {
            name: 'file_manager',
            description: '管理本地文件系统，包括创建、读取、写入、删除文件和文件夹',
            parameters: {
              type: 'object',
              properties: {
                action: { type: 'string', description: '操作类型: read, write, delete, list, create_dir' },
                path: { type: 'string', description: '文件或文件夹路径' },
                content: { type: 'string', description: '写入内容（write操作时使用）' }
              },
              required: ['action', 'path']
            }
          }
        }
      },
      {
        id: 'code-executor',
        name: '代码执行',
        description: '执行 Python 代码片段，运行计算和分析任务',
        version: '1.0.0',
        icon: 'code',
        enabled: true,
        createdAt: Date.now(),
        toolDefinition: {
          type: 'function',
          function: {
            name: 'code_executor',
            description: '在Python运行时中执行代码片段，返回执行结果',
            parameters: {
              type: 'object',
              properties: {
                code: { type: 'string', description: '要执行的Python代码' },
                timeout: { type: 'number', description: '超时时间（秒），默认30秒' }
              },
              required: ['code']
            }
          }
        }
      },
      {
        id: 'translator',
        name: '翻译',
        description: '文本翻译，支持中英日韩等多语言互译',
        version: '1.0.0',
        icon: 'globe',
        enabled: false,
        createdAt: Date.now(),
        toolDefinition: {
          type: 'function',
          function: {
            name: 'translator',
            description: '将文本翻译为目标语言',
            parameters: {
              type: 'object',
              properties: {
                text: { type: 'string', description: '要翻译的文本' },
                source_lang: { type: 'string', description: '源语言代码，如 zh, en, ja, ko' },
                target_lang: { type: 'string', description: '目标语言代码，如 zh, en, ja, ko' }
              },
              required: ['text', 'target_lang']
            }
          }
        }
      },
      {
        id: 'note-taker',
        name: '笔记',
        description: '创建、读取和管理笔记，支持 Markdown 格式',
        version: '1.0.0',
        icon: 'edit',
        enabled: true,
        createdAt: Date.now(),
        toolDefinition: {
          type: 'function',
          function: {
            name: 'note_taker',
            description: '创建或读取笔记，支持Markdown格式',
            parameters: {
              type: 'object',
              properties: {
                action: { type: 'string', description: '操作类型: create, read, list, delete' },
                title: { type: 'string', description: '笔记标题' },
                content: { type: 'string', description: '笔记内容（create时使用）' }
              },
              required: ['action']
            }
          }
        }
      },
      {
        id: 'scheduler',
        name: '日程',
        description: '管理日程和提醒，设置定时任务',
        version: '1.0.0',
        icon: 'calendar',
        enabled: false,
        createdAt: Date.now(),
        toolDefinition: {
          type: 'function',
          function: {
            name: 'scheduler',
            description: '创建和管理日程提醒',
            parameters: {
              type: 'object',
              properties: {
                action: { type: 'string', description: '操作类型: create, list, delete' },
                title: { type: 'string', description: '日程标题' },
                time: { type: 'string', description: '日程时间，格式: YYYY-MM-DD HH:mm' },
                description: { type: 'string', description: '日程详细描述' }
              },
              required: ['action']
            }
          }
        }
      },
      {
        id: 'system-control',
        name: '系统控制',
        description: '调用系统操作：获取桌面信息、活动窗口、截图、执行命令',
        version: '1.0.0',
        icon: 'monitor',
        enabled: true,
        createdAt: Date.now(),
        toolDefinition: {
          type: 'function',
          function: {
            name: 'system_control',
            description: '控制系统操作，包括获取桌面信息、活动窗口、截图、执行系统命令',
            parameters: {
              type: 'object',
              properties: {
                action: { type: 'string', description: '操作类型: get_desktop_info, get_active_window, take_screenshot, execute_command' },
                command: { type: 'string', description: 'execute_command时的命令（仅白名单命令）' }
              },
              required: ['action']
            }
          }
        }
      },
      {
        id: 'image-processor',
        name: '图片处理',
        description: '图片分析、OCR识别、元素定位',
        version: '1.0.0',
        icon: 'image',
        enabled: false,
        createdAt: Date.now(),
        toolDefinition: {
          type: 'function',
          function: {
            name: 'image_processor',
            description: '分析图片内容，包括OCR文字识别、元素定位、内容描述',
            parameters: {
              type: 'object',
              properties: {
                action: { type: 'string', description: '操作类型: analyze, ocr, locate' },
                image_base64: { type: 'string', description: 'base64编码的图片数据' },
                prompt: { type: 'string', description: '分析提示词（analyze时使用）' },
                target: { type: 'string', description: '目标元素描述（locate时使用）' }
              },
              required: ['action', 'image_base64']
            }
          }
        }
      }
    ]

    builtinPlugins.forEach(plugin => {
      this.plugins.set(plugin.id, plugin)
    })
  }

  private loadCustomPlugins(): void {
    try {
      const pluginDir = this.getPluginDir()
      const customFile = join(pluginDir, 'custom-plugins.json')
      if (existsSync(customFile)) {
        const customPlugins: Plugin[] = JSON.parse(readFileSync(customFile, 'utf-8'))
        customPlugins.forEach(plugin => {
          if (!this.plugins.has(plugin.id)) {
            this.plugins.set(plugin.id, plugin)
          }
        })
      }
    } catch (error) {
      logger.error('loadCustomPlugins error:', error)
    }
  }

  private saveCustomPlugins(): void {
    try {
      const pluginDir = this.getPluginDir()
      const customFile = join(pluginDir, 'custom-plugins.json')
      const customPlugins = Array.from(this.plugins.values()).filter(p => !this.isBuiltin(p.id))
      writeFileSync(customFile, JSON.stringify(customPlugins, null, 2))
    } catch (error) {
      logger.error('saveCustomPlugins error:', error)
    }
  }

  private isBuiltin(id: string): boolean {
    const builtinIds = ['web-search', 'file-manager', 'code-executor', 'translator', 'note-taker', 'scheduler', 'system-control', 'image-processor']
    return builtinIds.includes(id)
  }

  /* ==================== 插件执行 ==================== */

  async executePlugin(pluginId: string, params: Record<string, any>): Promise<PluginExecuteResult> {
    try {
      const plugin = this.plugins.get(pluginId)
      if (!plugin) {
        return { success: false, error: `插件不存在: ${pluginId}` }
      }

      if (!plugin.enabled) {
        return { success: false, error: `插件未启用: ${plugin.name}` }
      }

      // AI 生成的插件通过沙箱执行
      if (pluginId.startsWith('ai-')) {
        return await this.executeGeneratedPlugin(pluginId, params)
      }

      switch (pluginId) {
        case 'web-search':
          return await this.executeWebSearch(params)
        case 'file-manager':
          return await this.executeFileManager(params)
        case 'code-executor':
          return await this.executeCodeExecutor(params)
        case 'translator':
          return await this.executeTranslator(params)
        case 'note-taker':
          return await this.executeNoteTaker(params)
        case 'scheduler':
          return await this.executeScheduler(params)
        case 'system-control':
          return await this.executeSystemControl(params)
        case 'image-processor':
          return await this.executeImageProcessor(params)
        default:
          return { success: false, error: `未知插件: ${pluginId}` }
      }
    } catch (error) {
      return { success: false, error: `插件执行失败: ${error}` }
    }
  }

  /* ==================== 各插件执行逻辑 ==================== */

  private async executeWebSearch(params: Record<string, any>): Promise<PluginExecuteResult> {
    try {
      const query = params.query || ''
      const engine = params.engine || 'google'
      const urls: Record<string, string> = {
        google: `https://www.google.com/search?q=${encodeURIComponent(query)}`,
        bing: `https://www.bing.com/search?q=${encodeURIComponent(query)}`,
        baidu: `https://www.baidu.com/s?wd=${encodeURIComponent(query)}`
      }
      const url = urls[engine] || urls.google
      await shell.openExternal(url)
      return { success: true, data: { url, query, engine } }
    } catch (error) {
      return { success: false, error: `网页搜索失败: ${error}` }
    }
  }

  private executeFileManager(params: Record<string, any>): PluginExecuteResult {
    try {
      const action = params.action
      const filePath = params.path || ''
      // C-03 修复：路径白名单沙箱，禁止读写删除白名单目录之外的文件
      const safePath = this.validateFileManagerPath(filePath)

      switch (action) {
        case 'read': {
          if (!existsSync(safePath)) {
            return { success: false, error: `文件不存在: ${safePath}` }
          }
          const content = readFileSync(safePath, 'utf-8')
          return { success: true, data: { content, path: safePath } }
        }
        case 'write': {
          const dir = require('path').dirname(safePath)
          mkdirSync(dir, { recursive: true })
          writeFileSync(safePath, params.content || '', 'utf-8')
          return { success: true, data: { path: safePath, written: true } }
        }
        case 'delete': {
          if (existsSync(safePath)) {
            unlinkSync(safePath)
            return { success: true, data: { path: safePath, deleted: true } }
          }
          return { success: false, error: `文件不存在: ${safePath}` }
        }
        case 'list': {
          const dirPath = safePath
          if (!existsSync(dirPath)) {
            return { success: false, error: `目录不存在: ${dirPath}` }
          }
          const items = readdirSync(dirPath)
          return { success: true, data: { path: dirPath, items } }
        }
        case 'create_dir': {
          mkdirSync(safePath, { recursive: true })
          return { success: true, data: { path: safePath, created: true } }
        }
        default:
          return { success: false, error: `未知操作: ${action}` }
      }
    } catch (error) {
      return { success: false, error: `文件管理失败: ${error}` }
    }
  }

  /** C-03：校验 file-manager 插件路径，仅允许用户目录/文档/下载/桌面白名单根下的路径 */
  private validateFileManagerPath(requestedPath: string): string {
    const pathMod = require('path') as any
    const allowedRoots = [
      app.getPath('userData'),
      app.getPath('documents'),
      app.getPath('downloads'),
      app.getPath('desktop'),
    ].map(r => pathMod.resolve(r).toLowerCase())

    const target = (requestedPath || app.getPath('userData'))
    const resolved = pathMod.resolve(target)
    if (resolved.includes('\0')) {
      throw new Error('Invalid path')
    }
    const isAllowed = allowedRoots.some(root =>
      resolved.toLowerCase() === root ||
      resolved.toLowerCase().startsWith(root + pathMod.sep)
    )
    if (!isAllowed) {
      throw new Error('Access denied: path outside allowed directories')
    }
    return resolved
  }

  private async executeCodeExecutor(params: Record<string, any>): Promise<PluginExecuteResult> {
    try {
      const code = params.code || ''
      // @ts-expect-error TS6133 - timeout reserved for future use
      const timeout = params.timeout || 30

      if (!pythonRuntime.isReady()) {
        await pythonRuntime.initialize()
      }

      const script = `
${code}
`

      const result = await pythonRuntime.runScript(script)

      if (result.success) {
        return { success: true, data: { output: result.output || '', error: result.error || '' } }
      } else {
        return { success: false, error: result.error || '执行失败' }
      }
    } catch (error) {
      return { success: false, error: `代码执行失败: ${error}` }
    }
  }

  private async executeTranslator(params: Record<string, any>): Promise<PluginExecuteResult> {
    try {
      const text = params.text || ''
      const targetLang = params.target_lang || 'en'
      const sourceLang = params.source_lang || 'auto'

      // 通过 SGLang API 调用 LLM 进行翻译
      const url = 'http://localhost:30000/v1/chat/completions'
      const body = {
        model: 'qwen2-7b',
        messages: [
          {
            role: 'system',
            content: `你是一个翻译助手。将用户输入的文本翻译成目标语言。只返回翻译结果，不要包含任何解释。`
          },
          {
            role: 'user',
            content: `请将以下文本翻译成${targetLang}（源语言：${sourceLang}）：\n\n${text}`
          }
        ],
        max_tokens: 1024,
        temperature: 0.3
      }

      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 15000)

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal
      })

      clearTimeout(timeoutId)

      if (!response.ok) {
        return { success: false, error: `翻译API错误: ${response.status}` }
      }

      const data = await response.json() as any
      const translated = data.choices?.[0]?.message?.content || ''

      return { success: true, data: { original: text, translated, source_lang: sourceLang, target_lang: targetLang } }
    } catch (error) {
      return { success: false, error: `翻译失败: ${error}` }
    }
  }

  private async executeNoteTaker(params: Record<string, any>): Promise<PluginExecuteResult> {
    try {
      const action = params.action
      const noteDir = join(this.getPluginDir(), 'notes')
      mkdirSync(noteDir, { recursive: true })

      switch (action) {
        case 'create': {
          const title = params.title || `note-${Date.now()}`
          const content = params.content || ''
          const fileName = `${title.replace(/[<>:"/\\|?*]/g, '_')}.md`
          const filePath = join(noteDir, fileName)
          writeFileSync(filePath, content, 'utf-8')
          return { success: true, data: { title, path: filePath, created: true } }
        }
        case 'read': {
          const title = params.title || ''
          const fileName = `${title.replace(/[<>:"/\\|?*]/g, '_')}.md`
          const filePath = join(noteDir, fileName)
          if (!existsSync(filePath)) {
            return { success: false, error: `笔记不存在: ${title}` }
          }
          const content = readFileSync(filePath, 'utf-8')
          return { success: true, data: { title, content, path: filePath } }
        }
        case 'list': {
          const files = readdirSync(noteDir).filter(f => f.endsWith('.md'))
          return { success: true, data: { notes: files.map(f => f.replace('.md', '')) } }
        }
        case 'delete': {
          const title = params.title || ''
          const fileName = `${title.replace(/[<>:"/\\|?*]/g, '_')}.md`
          const filePath = join(noteDir, fileName)
          if (existsSync(filePath)) {
            unlinkSync(filePath)
            return { success: true, data: { title, deleted: true } }
          }
          return { success: false, error: `笔记不存在: ${title}` }
        }
        default:
          return { success: false, error: `未知操作: ${action}` }
      }
    } catch (error) {
      return { success: false, error: `笔记操作失败: ${error}` }
    }
  }

  private async executeScheduler(params: Record<string, any>): Promise<PluginExecuteResult> {
    try {
      const action = params.action
      const scheduleDir = join(this.getPluginDir(), 'schedules')
      mkdirSync(scheduleDir, { recursive: true })

      switch (action) {
        case 'create': {
          const title = params.title || `schedule-${Date.now()}`
          const time = params.time || new Date().toISOString()
          const description = params.description || ''
          const schedule = { title, time, description, createdAt: Date.now() }
          const filePath = join(scheduleDir, `${title.replace(/[<>:"/\\|?*]/g, '_')}.json`)
          writeFileSync(filePath, JSON.stringify(schedule, null, 2))
          return { success: true, data: schedule }
        }
        case 'list': {
          const files = readdirSync(scheduleDir).filter(f => f.endsWith('.json'))
          const schedules = files.map(f => {
            const content = readFileSync(join(scheduleDir, f), 'utf-8')
            return JSON.parse(content)
          })
          return { success: true, data: { schedules } }
        }
        case 'delete': {
          const title = params.title || ''
          const filePath = join(scheduleDir, `${title.replace(/[<>:"/\\|?*]/g, '_')}.json`)
          if (existsSync(filePath)) {
            unlinkSync(filePath)
            return { success: true, data: { title, deleted: true } }
          }
          return { success: false, error: `日程不存在: ${title}` }
        }
        default:
          return { success: false, error: `未知操作: ${action}` }
      }
    } catch (error) {
      return { success: false, error: `日程操作失败: ${error}` }
    }
  }

  private async executeSystemControl(params: Record<string, any>): Promise<PluginExecuteResult> {
    try {
      const action = params.action

      switch (action) {
        case 'get_desktop_info': {
          const { BrowserWindow } = require('electron')
          const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
          if (win) {
            const primaryDisplay = win.getPrimaryDisplay()
            return {
              success: true,
              data: {
                width: primaryDisplay.size.width,
                height: primaryDisplay.size.height,
                scaleFactor: primaryDisplay.scaleFactor
              }
            }
          }
          return { success: true, data: { width: 1920, height: 1080, scaleFactor: 1 } }
        }
        case 'get_active_window': {
          try {
            const { stdout } = await execAsync(
              `"${POWERSHELL_EXE}" -Command "Get-Process | Where-Object {$_.MainWindowTitle -ne ''} | Select-Object -First 1 -ExpandProperty MainWindowTitle"`,
              { timeout: 3000 }
            )
            return { success: true, data: { title: stdout.trim(), process: '' } }
          } catch (e) {
            logger.error('[PluginEngine] 获取活动窗口失败:', e)
            return { success: true, data: { title: '', process: '' } }
          }
        }
        case 'take_screenshot': {
          try {
            const capture = await visionModel.captureScreen()
            return { success: true, data: { screenshot: capture.dataUrl } }
          } catch (error) {
            return { success: false, error: `截图失败: ${error}` }
          }
        }
        case 'execute_command': {
          // C-05 修复：改为 spawn + 参数数组 + 严格白名单参数校验，
          // 不再用 exec + shell 字符串拼接（原实现可被 & | ; % ^ 等元字符注入任意命令）。
          const command = (params.command || '').trim()
          const [cmdKey, ...cmdArgs] = command.split(/\s+/)

          switch (cmdKey) {
            case 'open-url': {
              const url = cmdArgs.join('')
              if (!/^https?:\/\/[^\s]+$/i.test(url)) {
                return { success: false, error: '仅允许 http/https 链接' }
              }
              await shell.openExternal(url)
              return { success: true, data: { output: `已打开: ${url}` } }
            }
            case 'get-system-info': {
              const { stdout, stderr } = await runSpawn('systeminfo', [])
              return { success: true, data: { output: stdout || stderr } }
            }
            case 'get-disk-space': {
              const { stdout, stderr } = await runSpawn(POWERSHELL_EXE, [
                '-NoProfile', '-Command',
                'Get-CimInstance Win32_LogicalDisk | Select-Object Caption,Size,FreeSpace | Format-Table -AutoSize',
              ])
              return { success: true, data: { output: stdout || stderr } }
            }
            case 'check-port': {
              const port = cmdArgs[0] || ''
              if (!/^\d{1,5}$/.test(port)) {
                return { success: false, error: '仅允许数字端口' }
              }
              const { stdout } = await runSpawn('netstat', ['-ano'])
              const lines = stdout
                .split(/\r?\n/)
                .filter(l => l.includes(`:${port}`) && /LISTENING|ESTABLISHED/.test(l))
              return { success: true, data: { output: lines.join('\n') || `未找到端口 ${port} 的监听/连接` } }
            }
            default:
              return { success: false, error: '命令不在白名单中' }
          }
        }
        default:
          return { success: false, error: `未知操作: ${action}` }
      }
    } catch (error) {
      return { success: false, error: `系统控制失败: ${error}` }
    }
  }

  private async executeImageProcessor(params: Record<string, any>): Promise<PluginExecuteResult> {
    try {
      const action = params.action
      const imageBase64 = params.image_base64 || ''

      if (!imageBase64) {
        return { success: false, error: '缺少图片数据' }
      }

      switch (action) {
        case 'analyze': {
          const prompt = params.prompt || '请详细描述这张图片的内容'
          const result = await visionModel.analyzeImage(imageBase64, prompt)
          return { success: result.success, data: result }
        }
        case 'ocr': {
          const text = await visionModel.readTextFromScreen(imageBase64)
          return { success: true, data: { text } }
        }
        case 'locate': {
          const target = params.target || 'button'
          const result = await visionModel.locateElement(imageBase64, target)
          return { success: result.x >= 0, data: result }
        }
        default:
          return { success: false, error: `未知操作: ${action}` }
      }
    } catch (error) {
      return { success: false, error: `图片处理失败: ${error}` }
    }
  }

  /* ==================== 插件管理接口 ==================== */

  listPlugins(): Plugin[] {
    try {
      return Array.from(this.plugins.values())
    } catch (error) {
      return []
    }
  }

  togglePlugin(pluginId: string): boolean {
    try {
      const plugin = this.plugins.get(pluginId)
      if (!plugin) return false
      plugin.enabled = !plugin.enabled
      if (!this.isBuiltin(pluginId)) {
        this.saveCustomPlugins()
      }
      return true
    } catch (error) {
      return false
    }
  }

  getPluginStatus(): PluginStatus {
    try {
      const plugins = Array.from(this.plugins.values())
      const enabled = plugins.filter(p => p.enabled).length
      const disabled = plugins.length - enabled
      return { total: plugins.length, enabled, disabled, plugins }
    } catch (error) {
      return { total: 0, enabled: 0, disabled: 0, plugins: [] }
    }
  }

  /**
   * 获取 SGLang Function Calling 格式的工具列表
   */
  getToolDefinitions(): Array<Plugin['toolDefinition']> {
    try {
      return Array.from(this.plugins.values())
        .filter(p => p.enabled)
        .map(p => p.toolDefinition)
    } catch (error) {
      return []
    }
  }

  /**
   * 注册自定义插件
   */
  registerPlugin(plugin: Plugin): boolean {
    try {
      if (this.plugins.has(plugin.id)) {
        return false
      }
      this.plugins.set(plugin.id, plugin)
      this.saveCustomPlugins()
      return true
    } catch (error) {
      return false
    }
  }

  /**
   * 从本地文件安装插件
   * - .json / .plugin：解析为插件描述对象并注册
   * - 其它格式（.js / .ts / .zip 等）：返回明确错误
   */
  async installFromFile(filePath: string): Promise<{ success: boolean; plugin?: Plugin; error?: string }> {
    try {
      if (!filePath || typeof filePath !== 'string') {
        return { success: false, error: '缺少插件文件路径' }
      }
      if (!existsSync(filePath)) {
        return { success: false, error: `文件不存在: ${filePath}` }
      }

      const ext = filePath.split('.').pop()?.toLowerCase() || ''
      if (ext !== 'json' && ext !== 'plugin') {
        return { success: false, error: '暂支持 JSON 插件描述文件（.json / .plugin）' }
      }

      let data: any
      try {
        data = JSON.parse(readFileSync(filePath, 'utf-8'))
      } catch (e) {
        return { success: false, error: 'JSON 解析失败，请确认文件内容为有效的插件描述 JSON' }
      }

      if (!data || typeof data !== 'object') {
        return { success: false, error: '插件描述格式不正确' }
      }

      const rawName: string = String(data.name || '').trim()
      const plugin: Plugin = {
        id: String(data.id || `custom-${Date.now()}`),
        name: rawName || '未命名插件',
        description: String(data.description || ''),
        version: String(data.version || '1.0.0'),
        icon: String(data.icon || 'zap'),
        enabled: false,
        createdAt: typeof data.createdAt === 'number' ? data.createdAt : Date.now(),
        toolDefinition: data.toolDefinition || {
          type: 'function',
          function: {
            name: (rawName || 'plugin').replace(/\s+/g, '_').toLowerCase(),
            description: String(data.description || ''),
            parameters: { type: 'object', properties: {}, required: [] }
          }
        }
      }

      const registered = this.registerPlugin(plugin)
      if (!registered) {
        return { success: false, error: `插件 ID 已存在: ${plugin.id}` }
      }
      return { success: true, plugin }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  }

  /**
   * 卸载插件
   */
  unregisterPlugin(pluginId: string): boolean {
    try {
      if (this.isBuiltin(pluginId)) {
        return false // 不能卸载内置插件
      }
      const deleted = this.plugins.delete(pluginId)
      if (deleted) {
        this.saveCustomPlugins()
        // 删除沙箱代码
        this.deleteGeneratedPluginCode(pluginId)
      }
      return deleted
    } catch (error) {
      return false
    }
  }

  /* ==================== AI 动态插件生成 ==================== */

  /**
   * AI 动态生成插件（通过 SGLang 生成代码和工具定义）
   * 无数量限制，按需生成
   */
  async generatePlugin(requirements: string): Promise<{ success: boolean; plugin?: Plugin; error?: string }> {
    try {
      const prompt = `你是一个插件生成器。根据用户需求，生成一个可执行的 JavaScript 插件函数及其工具定义。

要求：
1. 生成一个可以被 sandbox 安全执行的 async 函数
2. code 字段必须是完整的可执行 JavaScript 代码，函数签名：async function(params) { ... }
3. 函数内部可使用 fetch、console.log、JSON、Math 等标准 API，不能使用 require/import
4. toolDefinition 必须符合 OpenAI Function Calling 格式

用户需求：${requirements}

请返回纯 JSON（不要 markdown 标记）：
{
  "name": "插件名称",
  "description": "插件功能描述",
  "code": "async function(params) { ... }",
  "toolDefinition": {
    "type": "function",
    "function": {
      "name": "function_name",
      "description": "功能描述",
      "parameters": {
        "type": "object",
        "properties": { "param1": { "type": "string", "description": "参数描述" } },
        "required": ["param1"]
      }
    }
  }
}`

      const result = await this.callSGLangForGeneration(prompt)
      if (!result.success) {
        return { success: false, error: result.error || 'AI 生成插件失败' }
      }

      const generated = result.data
      const pluginId = `ai-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`
      const funcName = (generated.name || 'ai_plugin').replace(/\s+/g, '_').toLowerCase()

      const newPlugin: Plugin = {
        id: pluginId,
        name: generated.name || 'AI 插件',
        description: generated.description || requirements,
        version: '1.0.0',
        icon: 'zap',
        enabled: true,
        createdAt: Date.now(),
        toolDefinition: generated.toolDefinition || {
          type: 'function',
          function: {
            name: funcName,
            description: generated.description || requirements,
            parameters: { type: 'object', properties: {}, required: [] }
          }
        }
      }

      // 保存插件代码到沙箱目录
      this.saveGeneratedPluginCode(pluginId, generated.code || '')

      // 注册插件
      this.plugins.set(pluginId, newPlugin)
      this.saveCustomPlugins()

      return { success: true, plugin: newPlugin }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  }

  /**
   * 执行 AI 生成的插件（沙箱安全执行）
   */
  async executeGeneratedPlugin(pluginId: string, params: Record<string, any>): Promise<PluginExecuteResult> {
    try {
      const plugin = this.plugins.get(pluginId)
      if (!plugin) {
        return { success: false, error: `插件不存在: ${pluginId}` }
      }

      if (!plugin.enabled) {
        return { success: false, error: `插件未启用: ${plugin.name}` }
      }

      // 读取插件代码
      const code = this.loadGeneratedPluginCode(pluginId)
      if (!code) {
        return { success: false, error: `插件代码不存在: ${pluginId}` }
      }

      // 沙箱执行
      const sandbox = createSandbox({ timeout: 30000 })
      const result = await sandbox.execute(code, params)
      return result
    } catch (error) {
      return { success: false, error: `插件执行失败: ${error}` }
    }
  }

  /* ==================== 私有方法：AI 生成辅助 ==================== */

  private async callSGLangForGeneration(prompt: string): Promise<{ success: boolean; data?: any; error?: string }> {
    try {
      const url = 'http://localhost:30000/v1/chat/completions'
      const body = {
        model: 'default',
        messages: [
          { role: 'system', content: '你是一个 JSON 输出专家，只返回有效的 JSON 对象，不要包含 markdown 标记或额外解释。' },
          { role: 'user', content: prompt }
        ],
        max_tokens: 2048,
        temperature: 0.3,
        response_format: { type: 'json_object' }
      }

      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 30000)

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal
      })

      clearTimeout(timeoutId)

      if (!response.ok) {
        return { success: false, error: `SGLang API 错误: ${response.status}` }
      }

      const data = await response.json() as any
      const content = data.choices?.[0]?.message?.content || ''
      
      // 尝试解析 JSON
      let parsed: any
      try {
        // 清理可能的 markdown 标记
        const cleaned = content.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim()
        parsed = JSON.parse(cleaned)
      } catch {
        // 尝试从内容中提取 JSON
        const jsonMatch = content.match(/\{[\s\S]*\}/)
        if (jsonMatch) {
          parsed = JSON.parse(jsonMatch[0])
        } else {
          return { success: false, error: '无法解析 AI 生成的插件' }
        }
      }

      return { success: true, data: parsed }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  }

  private getGeneratedPluginsDir(): string {
    const dir = join(this.getPluginDir(), 'generated')
    try {
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
      }
    } catch (e) { logger.error('[PluginEngine] 创建生成插件目录失败:', e) }
    return dir
  }

  private saveGeneratedPluginCode(pluginId: string, code: string): void {
    try {
      const dir = this.getGeneratedPluginsDir()
      const filePath = join(dir, `${pluginId}.js`)
      writeFileSync(filePath, code, 'utf-8')
    } catch (error) {
      logger.error('saveGeneratedPluginCode error:', error)
    }
  }

  private loadGeneratedPluginCode(pluginId: string): string | null {
    try {
      const dir = this.getGeneratedPluginsDir()
      const filePath = join(dir, `${pluginId}.js`)
      if (existsSync(filePath)) {
        return readFileSync(filePath, 'utf-8')
      }
    } catch (error) {
      logger.error('loadGeneratedPluginCode error:', error)
    }
    return null
  }

  private deleteGeneratedPluginCode(pluginId: string): void {
    try {
      const dir = this.getGeneratedPluginsDir()
      const filePath = join(dir, `${pluginId}.js`)
      if (existsSync(filePath)) {
        unlinkSync(filePath)
      }
    } catch (error) {
      logger.error('deleteGeneratedPluginCode error:', error)
    }
  }
}

export const pluginEngine = new PluginEngine()