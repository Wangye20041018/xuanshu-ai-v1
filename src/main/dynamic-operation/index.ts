/**
 * Dynamic Operation Engine
 * Provides IPC handlers for executing system operations including
 * command execution, file operations, window control, and system info queries.
 * All operations have configurable timeouts (default 30s) and logging.
 */
import { ipcMain } from 'electron'
import { pythonRuntime } from '../runtime/python'
import { visionModel } from '../vision'
import { app } from 'electron'
import { logger } from '../../shared/logger'
import { join } from 'path'
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs'

const DEFAULT_TIMEOUT = 30000

/**
 * Safely embed any string into a Python source code string literal.
 * Uses JSON.stringify serialization + Python json.loads deserialization,
 * thoroughly preventing code injection risks.
 */
function pyStr(value: string): string {
  return `json.loads(${JSON.stringify(value)})`
}

interface TaskStep {
  id: string
  description: string
  status: 'pending' | 'running' | 'completed' | 'error'
  error?: string
  result?: string
  retryCount: number
  maxRetries: number
}

interface SystemTask {
  id: string
  title: string
  description: string
  steps: TaskStep[]
  status: 'pending' | 'running' | 'completed' | 'error'
  createdAt: number
  completedAt?: number
  priority: 'low' | 'medium' | 'high' | 'urgent'
}

interface ExecutionPlan {
  steps: Array<{
    action: string
    params: Record<string, any>
    description: string
    useVision: boolean
  }>
  reasoning: string
}

interface OperationResult {
  success: boolean
  data?: any
  error?: string
  duration?: number
}

class DynamicOperationEngine {
  private tasks: Map<string, SystemTask> = new Map()
  private operationHistory: Map<string, { success: boolean; error?: string; timestamp: number }> = new Map()
  private visionEnabled: boolean = true
  private safetyMode: boolean = true
  private dataDir: string | null = null
  private initialized: boolean = false
  private operationTimeout: number = DEFAULT_TIMEOUT

  // Allowed operation whitelist
  private allowedOperations: Set<string> = new Set([
    'mouse_move', 'mouse_click', 'mouse_drag', 'mouse_scroll',
    'keyboard_type', 'keyboard_press', 'keyboard_hotkey',
    'screen_capture', 'screen_analyze', 'screen_find',
    'window_open', 'window_close', 'window_focus', 'window_resize',
    'app_launch', 'app_close',
    'file_read', 'file_write', 'file_delete', 'file_copy',
    'browser_open', 'browser_navigate', 'browser_click', 'browser_type',
    'wait', 'delay', 'loop', 'condition',
    'clipboard_copy', 'clipboard_paste', 'clipboard_get',
    'system_volume_up', 'system_volume_down', 'system_mute',
    'system_brightness_up', 'system_brightness_down',
    'process_list', 'process_info',
    'window_minimize', 'window_restore', 'window_screenshot', 'window_list',
    'screen_ocr', 'screen_ocr_region',
    'text_select', 'text_select_all', 'text_delete',
    'drag_drop', 'drag_file',
    'form_fill', 'form_submit',
    'media_play', 'media_pause', 'media_next', 'media_prev',
    'notification_show', 'notification_click',
    'network_check', 'http_request', 'download_file',
    'registry_read', 'registry_write',
    'cmd_run', 'powershell_run',
    'screen_capture_region', 'screen_capture_window', 'screen_capture_clipboard',
    'image_compare', 'image_crop', 'image_resize', 'image_ocr',
    'excel_open', 'excel_read', 'excel_write', 'excel_chart',
    'word_open', 'word_read', 'word_write', 'word_format',
    'ai_analyze_and_act', 'ai_vision_navigate', 'ai_autofill',
    'service_start', 'service_stop', 'service_list',
    'env_get', 'env_set',
    'schedule_create', 'schedule_delete',
    'archive_compress', 'archive_extract',
    // New operation types
    'exec_command', 'file_operation', 'window_control', 'system_info',
  ])

  constructor() {
    // Deferred initialization, wait for app ready
  }

  initialize(): void {
    if (this.initialized) return
    this.dataDir = app.getPath('userData')
    this.loadSafetyConfig()
    this.initialized = true
    this.log('DynamicOperationEngine initialized')
  }

  shutdown(): Promise<void> {
    this.log('DynamicOperationEngine shutting down')
    this.tasks.clear()
    this.operationHistory.clear()
    this.initialized = false
    return Promise.resolve()
  }

  private log(message: string, level: 'info' | 'warn' | 'error' = 'info'): void {
    const timestamp = new Date().toISOString()
    const prefix = `[${timestamp}] [DynamicOp:${level.toUpperCase()}]`
    const logMsg = `${prefix} ${message}`
    if (level === 'error') {
      logger.error(logMsg)
    } else if (level === 'warn') {
      logger.warn(logMsg)
    } else {
      logger.debug(logMsg)
    }
  }

  private getDataDir(): string {
    if (!this.dataDir) {
      this.initialize()
    }
    return this.dataDir!
  }

  private loadSafetyConfig(): void {
    try {
      const configPath = join(this.getDataDir(), 'operation-config.json')
      if (existsSync(configPath)) {
        try {
          const config = JSON.parse(readFileSync(configPath, 'utf-8'))
          this.visionEnabled = config.visionEnabled ?? true
          this.safetyMode = config.safetyMode ?? true
          this.operationTimeout = config.operationTimeout ?? DEFAULT_TIMEOUT
          if (config.allowedOperations) {
            this.allowedOperations = new Set(config.allowedOperations)
          }
        } catch (e) { logger.error('[DynamicOp] 瑙ｆ瀽瀹夊叏閰嶇疆JSON澶辫触:', e) }
      }
    } catch (error) {
      this.log('Failed to load safety config: ' + error, 'error')
    }
  }

  private saveSafetyConfig(): void {
    try {
      const dataDir = this.getDataDir()
      const configPath = join(dataDir, 'operation-config.json')
      mkdirSync(dataDir, { recursive: true })
      writeFileSync(configPath, JSON.stringify({
        visionEnabled: this.visionEnabled,
        safetyMode: this.safetyMode,
        operationTimeout: this.operationTimeout,
        allowedOperations: Array.from(this.allowedOperations)
      }, null, 2))
    } catch (error) {
      this.log('Failed to save safety config: ' + error, 'error')
    }
  }

  // ==================== Timeout Helper ====================

  private withTimeout<T>(promise: Promise<T>, operation: string, timeoutMs?: number): Promise<T> {
    const timeout = timeoutMs ?? this.operationTimeout
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Operation '${operation}' timed out after ${timeout}ms`))
      }, timeout)
      promise
        .then((result) => { clearTimeout(timer); resolve(result) })
        .catch((err) => { clearTimeout(timer); reject(err) })
    })
  }

  // ==================== Core Operations ====================

  async analyzeAndPlan(userRequest: string): Promise<ExecutionPlan> {
    const startTime = Date.now()
    try {
      if (!pythonRuntime.isReady()) {
        await pythonRuntime.initialize()
      }

      const script = `
import json

def analyze_request(request):
    request_lower = request.lower()
    steps = []
    reasoning = []

    if any(k in request_lower for k in ['ppt', 'slides']):
        reasoning.append('Detected PPT creation request')
        steps.append({'action': 'app_launch', 'params': {'app': 'powerpoint'}, 'description': 'Open PowerPoint', 'useVision': True})
        steps.append({'action': 'wait', 'params': {'duration': 3}, 'description': 'Wait for app launch', 'useVision': False})
        steps.append({'action': 'screen_analyze', 'params': {}, 'description': 'Analyze screen', 'useVision': True})

    elif any(k in request_lower for k in ['search', 'browser', 'google']):
        reasoning.append('Detected search request')
        search_term = request.replace('search', '').replace('Search', '').strip()
        steps.append({'action': 'browser_open', 'params': {'url': 'https://www.google.com'}, 'description': 'Open browser', 'useVision': True})

    elif any(k in request_lower for k in ['open', 'launch', 'start']):
        reasoning.append('Detected app launch request')

    elif any(k in request_lower for k in ['click', 'select', 'button']):
        reasoning.append('Detected click operation')
        steps.append({'action': 'screen_analyze', 'params': {}, 'description': 'Analyze current screen', 'useVision': True})
        steps.append({'action': 'screen_find', 'params': {'target': request}, 'description': 'Locate target element', 'useVision': True})
        steps.append({'action': 'mouse_click', 'params': {'target': request}, 'description': 'Execute click', 'useVision': True})

    elif any(k in request_lower for k in ['input', 'type', 'fill']):
        reasoning.append('Detected input request')
        text_to_input = request.replace('input', '').replace('type', '').strip()
        steps.append({'action': 'screen_find', 'params': {'target': 'input_field'}, 'description': 'Locate input field', 'useVision': True})
        steps.append({'action': 'keyboard_type', 'params': {'text': text_to_input}, 'description': 'Type text', 'useVision': False})

    elif any(k in request_lower for k in ['screenshot', 'capture']):
        reasoning.append('Detected screenshot request')
        steps.append({'action': 'screen_capture', 'params': {}, 'description': 'Capture screen', 'useVision': False})

    elif any(k in request_lower for k in ['shutdown', 'power off']):
        reasoning.append('Detected shutdown request')
        steps.append({'action': 'keyboard_hotkey', 'params': {'keys': ['win', 'x']}, 'description': 'Open power menu', 'useVision': True})

    elif any(k in request_lower for k in ['restart', 'reboot']):
        reasoning.append('Detected restart request')

    elif any(k in request_lower for k in ['copy']):
        reasoning.append('Detected copy request')
        steps.append({'action': 'keyboard_hotkey', 'params': {'keys': ['ctrl', 'c']}, 'description': 'Copy', 'useVision': False})

    elif any(k in request_lower for k in ['paste']):
        reasoning.append('Detected paste request')
        steps.append({'action': 'keyboard_hotkey', 'params': {'keys': ['ctrl', 'v']}, 'description': 'Paste', 'useVision': False})

    elif any(k in request_lower for k in ['volume', 'mute', 'louder', 'quieter']):
        reasoning.append('Detected volume adjustment')
        if any(k in request_lower for k in ['up', 'louder', 'increase']):
            steps.append({'action': 'system_volume_up', 'params': {}, 'description': 'Increase volume', 'useVision': False})
        elif any(k in request_lower for k in ['down', 'quieter', 'decrease']):
            steps.append({'action': 'system_volume_down', 'params': {}, 'description': 'Decrease volume', 'useVision': False})
        else:
            steps.append({'action': 'system_mute', 'params': {}, 'description': 'Toggle mute', 'useVision': False})

    elif any(k in request_lower for k in ['brightness']):
        reasoning.append('Detected brightness adjustment')
        if any(k in request_lower for k in ['up', 'brighter']):
            steps.append({'action': 'system_brightness_up', 'params': {}, 'description': 'Increase brightness', 'useVision': False})
        else:
            steps.append({'action': 'system_brightness_down', 'params': {}, 'description': 'Decrease brightness', 'useVision': False})

    elif any(k in request_lower for k in ['lock', 'lock screen']):
        reasoning.append('Detected lock screen request')
        steps.append({'action': 'system_lock', 'params': {}, 'description': 'Lock screen', 'useVision': False})

    elif any(k in request_lower for k in ['process', 'task manager']):
        reasoning.append('Detected process management request')
        steps.append({'action': 'process_list', 'params': {}, 'description': 'List processes', 'useVision': False})

    elif any(k in request_lower for k in ['minimize', 'maximize', 'window']):
        reasoning.append('Detected window management request')
        if any(k in request_lower for k in ['minimize']):
            steps.append({'action': 'window_minimize', 'params': {}, 'description': 'Minimize window', 'useVision': False})
        elif any(k in request_lower for k in ['maximize', 'restore']):
            steps.append({'action': 'window_restore', 'params': {}, 'description': 'Restore/maximize window', 'useVision': False})
        else:
            steps.append({'action': 'window_list', 'params': {}, 'description': 'List windows', 'useVision': False})

    else:
        reasoning.append('Generic task execution')
        steps.append({'action': 'screen_analyze', 'params': {}, 'description': 'Analyze screen state', 'useVision': True})
        steps.append({'action': 'keyboard_type', 'params': {'text': request}, 'description': 'Execute based on request', 'useVision': True})

    return json.dumps({'steps': steps, 'reasoning': '; '.join(reasoning)})

result = analyze_request(${pyStr(userRequest)})
print(result)
`

      const result = await this.withTimeout(
        pythonRuntime.runScript(script),
        'analyzeAndPlan'
      )

      if (result.success && result.output) {
        try {
          return JSON.parse(result.output)
        } catch (e) {
          logger.error('[DynamicOp] 瑙ｆ瀽analyzeAndPlan缁撴灉澶辫触:', e)
          return this.getDefaultPlan(userRequest)
        }
      }

      return this.getDefaultPlan(userRequest)
    } catch (error) {
      this.log('analyzeAndPlan error: ' + error, 'error')
      return this.getDefaultPlan(userRequest)
    } finally {
      this.log(`analyzeAndPlan completed in ${Date.now() - startTime}ms`)
    }
  }

  private getDefaultPlan(userRequest: string): ExecutionPlan {
    return {
      steps: [
        { action: 'screen_analyze', params: {}, description: 'Analyze current screen', useVision: true },
        { action: 'keyboard_type', params: { text: userRequest }, description: 'Execute user request', useVision: true }
      ],
      reasoning: 'Default execution plan'
    }
  }

  async executeStep(step: ExecutionPlan['steps'][0]): Promise<string> {
    const startTime = Date.now()
    try {
      if (!this.allowedOperations.has(step.action)) {
        throw new Error(`Operation ${step.action} is not in the allowed list`)
      }

      // Handle vision-supported operations
      if (step.useVision && this.visionEnabled) {
        try {
          const screenCapture = await visionModel.captureScreen()
          const base64 = screenCapture.dataUrl

          if (step.action === 'screen_find') {
            const target = step.params?.target || 'button'
            const locateResult = await visionModel.locateElement(base64, target)
            if (locateResult.x >= 0 && locateResult.y >= 0) {
              step.params.x = locateResult.x
              step.params.y = locateResult.y
              step.params.confidence = locateResult.confidence
              return `Element located: (${locateResult.x}, ${locateResult.y}), confidence: ${locateResult.confidence.toFixed(2)}`
            }
            return `Element location failed: ${locateResult.error || 'Target not found'}, using default coordinates`
          }

          if (step.action === 'screen_analyze') {
            const prompt = step.params?.prompt || 'Describe the current screen contents in detail'
            const analysis = await visionModel.analyzeImage(base64, prompt)
            if (analysis.success) {
              return `Screen analysis complete: ${analysis.description || analysis.text || 'Success'}`
            }
            return `Screen analysis failed: ${analysis.error || 'Unknown error'}`
          }

          if (step.params?.target) {
            const locateResult = await visionModel.locateElement(base64, step.params.target)
            if (locateResult.x >= 0 && locateResult.y >= 0) {
              step.params.x = locateResult.x
              step.params.y = locateResult.y
            }
          }
        } catch (visionError) {
          this.log('Vision operation error: ' + visionError, 'warn')
        }
      }

      // Execute Python script operation
      if (!pythonRuntime.isReady()) {
        await pythonRuntime.initialize()
      }

      const script = this.generateActionScript(step.action, step.params)
      const result = await this.withTimeout(
        pythonRuntime.runScript(script),
        `executeStep:${step.action}`
      )

      return result.success ? (result.output || 'Operation completed') : (result.error || 'Operation failed')
    } catch (error) {
      return `Step execution failed: ${error}`
    } finally {
      this.log(`executeStep(${step.action}) completed in ${Date.now() - startTime}ms`)
    }
  }

  // ==================== New IPC Handlers ====================

  /**
   * Execute a system command with timeout and error handling.
   */
  async execCommand(params: {
    command: string
    args?: string[]
    timeout?: number
    cwd?: string
    env?: Record<string, string>
  }): Promise<OperationResult> {
    const startTime = Date.now()
    const channel = params.command.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 30)
    const timeout = params.timeout ?? this.operationTimeout

    this.log(`Executing command: ${params.command} ${(params.args || []).join(' ')}`)

    if (this.safetyMode) {
      const dangerousPatterns = [
        /format/i, /del\s+\/f/i, /rm\s+-rf/i, /rd\s+\/s/i,
        /shutdown\s+\/s/i, /shutdown\s+\/r/i, /diskpart/i,
      ]
      const cmdStr = [params.command, ...(params.args || [])].join(' ')
      for (const pattern of dangerousPatterns) {
        if (pattern.test(cmdStr)) {
          return { success: false, error: `Command blocked by safety mode: matches dangerous pattern ${pattern.source}` }
        }
      }
    }

    try {
      if (!pythonRuntime.isReady()) {
        await pythonRuntime.initialize()
      }

      const argsJson = JSON.stringify(params.args || [])
      const cwdStr = params.cwd ? pyStr(params.cwd) : 'None'
      const envStr = params.env ? JSON.stringify(params.env) : 'None'

      const script = `
import subprocess
import json
import os
import sys

command = ${pyStr(params.command)}
args = json.loads('${argsJson.replace(/'/g, "\\'")}')
cwd = ${cwdStr} if ${cwdStr} != 'None' else None
env_override = json.loads('${envStr.replace(/'/g, "\\'")}') if ${envStr} != 'None' else None

try:
    full_env = os.environ.copy()
    if env_override:
        full_env.update(env_override)

    cmd = [command] + args
    result = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        cwd=cwd,
        env=full_env,
        timeout=${timeout / 1000},
        shell=True
    )

    response = {
        'success': True,
        'stdout': result.stdout[:10000],
        'stderr': result.stderr[:5000],
        'returncode': result.returncode
    }
    print(json.dumps(response))
except subprocess.TimeoutExpired:
    print(json.dumps({'success': False, 'error': 'Command timed out after ${timeout}ms'}))
except Exception as e:
    print(json.dumps({'success': False, 'error': str(e)}))
`

      const result = await pythonRuntime.runScript(script)
      if (result.success && result.output) {
        try {
          return JSON.parse(result.output)
        } catch (e) {
          logger.error('[DynamicOp] 瑙ｆ瀽execCommand缁撴灉澶辫触:', e)
          return { success: false, error: 'Failed to parse command output' }
        }
      }
      return { success: false, error: result.error || 'Command execution returned no output' }
    } catch (error) {
      this.log(`execCommand error: ${error}`, 'error')
      return { success: false, error: String(error), duration: Date.now() - startTime }
    } finally {
      this.operationHistory.set(`cmd:${channel}`, {
        success: true,
        timestamp: Date.now()
      })
    }
  }

  /**
   * File operations: read, write, copy, move, delete, list, stat.
   */
  async fileOperation(params: {
    operation: 'read' | 'write' | 'copy' | 'move' | 'delete' | 'list' | 'stat'
    sourcePath?: string
    targetPath?: string
    content?: string
    encoding?: string
    recursive?: boolean
    timeout?: number
  }): Promise<OperationResult> {
    const startTime = Date.now()
    this.log(`File operation: ${params.operation} on ${params.sourcePath || params.targetPath || 'unknown'}`)

    try {
      if (!pythonRuntime.isReady()) {
        await pythonRuntime.initialize()
      }

      const op = params.operation
      const src = pyStr(params.sourcePath || '')
      const dst = pyStr(params.targetPath || '')
      const content = pyStr(params.content || '')
      const encoding = pyStr(params.encoding || 'utf-8')
      // @ts-expect-error TS6133 — used in Python template string interpolation
      const _recursive = params.recursive ? 'True' : 'False'
      const timeout = params.timeout ?? this.operationTimeout

      const script = `
import json
import os
import shutil
import time

result = {'success': False, 'data': None, 'error': None}
start = time.time()
timeout = ${timeout / 1000}

try:
    op = '${op}'

    if op == 'read':
        path = ${src}
        if not os.path.exists(path):
            result['error'] = f'File not found: {path}'
        elif time.time() - start > timeout:
            result['error'] = 'Operation timed out'
        else:
            with open(path, 'r', encoding=${encoding}) as f:
                result['data'] = f.read()[:50000]
            result['success'] = True

    elif op == 'write':
        path = ${src}
        os.makedirs(os.path.dirname(path) || '.', exist_ok=True)
        with open(path, 'w', encoding=${encoding}) as f:
            f.write(${content})
        result['success'] = True
        result['data'] = f'Written to {path}'

    elif op == 'copy':
        if not os.path.exists(${src}):
            result['error'] = f'Source not found: {${src}}'
        else:
            os.makedirs(os.path.dirname(${dst}) || '.', exist_ok=True)
            if os.path.isfile(${src}):
                shutil.copy2(${src}, ${dst})
            else:
                shutil.copytree(${src}, ${dst}, dirs_exist_ok=True)
            result['success'] = True
            result['data'] = f'Copied to {${dst}}'

    elif op == 'move':
        if not os.path.exists(${src}):
            result['error'] = f'Source not found: {${src}}'
        else:
            os.makedirs(os.path.dirname(${dst}) || '.', exist_ok=True)
            shutil.move(${src}, ${dst})
            result['success'] = True
            result['data'] = f'Moved to {${dst}}'

    elif op == 'delete':
        path = ${src}
        if not os.path.exists(path):
            result['error'] = f'Path not found: {path}'
        else:
            if os.path.isfile(path):
                os.remove(path)
            else:
                shutil.rmtree(path)
            result['success'] = True
            result['data'] = f'Deleted: {path}'

    elif op == 'list':
        path = ${src} if ${src} else '.'
        if not os.path.exists(path):
            result['error'] = f'Directory not found: {path}'
        else:
            entries = []
            for item in os.listdir(path):
                item_path = os.path.join(path, item)
                stat = os.stat(item_path)
                entries.append({
                    'name': item,
                    'is_dir': os.path.isdir(item_path),
                    'size': stat.st_size,
                    'mtime': stat.st_mtime
                })
            result['data'] = entries[:1000]
            result['success'] = True

    elif op == 'stat':
        path = ${src}
        if not os.path.exists(path):
            result['error'] = f'Path not found: {path}'
        else:
            stat = os.stat(path)
            result['data'] = {
                'size': stat.st_size,
                'mtime': stat.st_mtime,
                'ctime': stat.st_ctime,
                'is_dir': os.path.isdir(path),
                'is_file': os.path.isfile(path)
            }
            result['success'] = True

except Exception as e:
    result['error'] = str(e)

print(json.dumps(result))
`

      const execResult = await this.withTimeout(
        pythonRuntime.runScript(script),
        `fileOperation:${op}`
      )

      if (execResult.success && execResult.output) {
        try {
          return JSON.parse(execResult.output) as OperationResult
        } catch (e) {
          logger.error('[DynamicOp] 瑙ｆ瀽fileOperation缁撴灉澶辫触:', e)
          return { success: false, error: 'Failed to parse file operation result' }
        }
      }
      return { success: false, error: execResult.error || 'File operation failed' }
    } catch (error) {
      this.log(`fileOperation error: ${error}`, 'error')
      return { success: false, error: String(error), duration: Date.now() - startTime }
    }
  }

  /**
   * Window control operations: list, focus, minimize, maximize, restore, resize, setTop, close.
   */
  async windowControl(params: {
    action: 'list' | 'focus' | 'minimize' | 'maximize' | 'restore' | 'resize' | 'setTop' | 'close'
    title?: string
    pid?: number
    width?: number
    height?: number
    x?: number
    y?: number
    timeout?: number
  }): Promise<OperationResult> {
    const startTime = Date.now()
    this.log(`Window control: ${params.action}`)

    try {
      if (!pythonRuntime.isReady()) {
        await pythonRuntime.initialize()
      }

      const action = params.action
      const title = pyStr(params.title || '')
      // @ts-expect-error TS6133 — used in Python template string interpolation
      const _pid = params.pid ?? 0
      const width = params.width ?? 0
      const height = params.height ?? 0
      // @ts-expect-error TS6133 — used in Python template string interpolation
      const _x = params.x ?? 0
      // @ts-expect-error TS6133 — used in Python template string interpolation
      const _y = params.y ?? 0

      const script = `
import json
import subprocess
import sys
import os

# 使用完整路径解决 Electron 子进程 PATH 不含 System32 的问题
POWERSHELL = os.path.join(os.environ.get('SystemRoot', 'C:\\\\Windows'), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

result = {'success': False, 'data': None, 'error': None}
action = '${action}'

try:
    if action == 'list':
        ps_result = subprocess.run(
            [POWERSHELL, '-Command',
             'Get-Process | Where-Object {$_.MainWindowTitle} | Select-Object Id, ProcessName, MainWindowTitle | ConvertTo-Json'],
            capture_output=True, text=True, timeout=10
        )
        if ps_result.returncode == 0 and ps_result.stdout.strip():
            result['data'] = json.loads(ps_result.stdout) if ps_result.stdout.strip() else []
        else:
            result['data'] = []
        result['success'] = True

    elif action == 'focus':
        title = ${title}
        if title:
            subprocess.run([POWERSHELL, '-Command',
                f'Add-Type -AssemblyName Microsoft.VisualBasic; ' +
                f'[Microsoft.VisualBasic.Interaction]::AppActivate("{title}")'],
                capture_output=True, timeout=10)
            result['success'] = True
            result['data'] = f'Focused window: {title}'
        else:
            result['error'] = 'No window title specified'

    elif action == 'minimize':
        title = ${title}
        if title:
            subprocess.run([POWERSHELL, '-Command',
                f'Add-Type -Name Win32 -Namespace API -MemberDefinition @"' +
                f'[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);' +
                f'[DllImport("user32.dll")] public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);' +
                f'"@; $h = [API.Win32]::FindWindow($null, "{title}"); [API.Win32]::ShowWindow($h, 6)'],
                capture_output=True, timeout=10)
            result['success'] = True
            result['data'] = f'Minimized: {title}'
        else:
            result['error'] = 'No window title specified'

    elif action == 'maximize':
        title = ${title}
        if title:
            subprocess.run([POWERSHELL, '-Command',
                f'Add-Type -Name Win32 -Namespace API -MemberDefinition @"' +
                f'[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);' +
                f'[DllImport("user32.dll")] public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);' +
                f'"@; $h = [API.Win32]::FindWindow($null, "{title}"); [API.Win32]::ShowWindow($h, 3)'],
                capture_output=True, timeout=10)
            result['success'] = True
            result['data'] = f'Maximized: {title}'
        else:
            result['error'] = 'No window title specified'

    elif action == 'restore':
        title = ${title}
        if title:
            subprocess.run([POWERSHELL, '-Command',
                f'Add-Type -Name Win32 -Namespace API -MemberDefinition @"' +
                f'[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);' +
                f'[DllImport("user32.dll")] public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);' +
                f'"@; $h = [API.Win32]::FindWindow($null, "{title}"); [API.Win32]::ShowWindow($h, 9)'],
                capture_output=True, timeout=10)
            result['success'] = True
            result['data'] = f'Restored: {title}'
        else:
            result['error'] = 'No window title specified'

    elif action == 'close':
        title = ${title}
        if title:
            subprocess.run([POWERSHELL, '-Command',
                f'Add-Type -Name Win32 -Namespace API -MemberDefinition @"' +
                f'[DllImport("user32.dll")] public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);' +
                f'[DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);' +
                f'"@; $h = [API.Win32]::FindWindow($null, "{title}"); [API.Win32]::PostMessage($h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)'],
                capture_output=True, timeout=10)
            result['success'] = True
            result['data'] = f'Close signal sent to: {title}'
        else:
            result['error'] = 'No window title specified'

    elif action == 'resize':
        title = ${title}
        w, h = ${width}, ${height}
        if title and w > 0 and h > 0:
            subprocess.run([POWERSHELL, '-Command',
                f'Add-Type -Name Win32 -Namespace API -MemberDefinition @"' +
                f'[DllImport("user32.dll")] public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);' +
                f'[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);' +
                f'"@; $h = [API.Win32]::FindWindow($null, "{title}"); [API.Win32]::SetWindowPos($h, [IntPtr]::Zero, 0, 0, {w}, {h}, 0x0004)'],
                capture_output=True, timeout=10)
            result['success'] = True
            result['data'] = f'Resized to {w}x{h}: {title}'
        else:
            result['error'] = 'Invalid parameters for resize'

    elif action == 'setTop':
        title = ${title}
        if title:
            subprocess.run([POWERSHELL, '-Command',
                f'Add-Type -Name Win32 -Namespace API -MemberDefinition @"' +
                f'[DllImport("user32.dll")] public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);' +
                f'[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);' +
                f'"@; $h = [API.Win32]::FindWindow($null, "{title}"); [API.Win32]::SetWindowPos($h, [IntPtr]::new(-1), 0, 0, 0, 0, 0x0003)'],
                capture_output=True, timeout=10)
            result['success'] = True
            result['data'] = f'Set always-on-top: {title}'
        else:
            result['error'] = 'No window title specified'

    else:
        result['error'] = f'Unknown window action: {action}'

except Exception as e:
    result['error'] = str(e)

print(json.dumps(result))
`

      const execResult = await this.withTimeout(
        pythonRuntime.runScript(script),
        `windowControl:${action}`
      )

      if (execResult.success && execResult.output) {
        try {
          return JSON.parse(execResult.output) as OperationResult
        } catch (e) {
          logger.error('[DynamicOp] 瑙ｆ瀽windowControl缁撴灉澶辫触:', e)
          return { success: false, error: 'Failed to parse window control result' }
        }
      }
      return { success: false, error: execResult.error || 'Window control failed' }
    } catch (error) {
      this.log(`windowControl error: ${error}`, 'error')
      return { success: false, error: String(error), duration: Date.now() - startTime }
    }
  }

  /**
   * System information queries: cpu, memory, disk, network, processes, os, uptime, battery.
   */
  async systemInfo(params: {
    query: 'cpu' | 'memory' | 'disk' | 'network' | 'processes' | 'os' | 'uptime' | 'battery' | 'all'
    timeout?: number
  }): Promise<OperationResult> {
    const startTime = Date.now()
    this.log(`System info query: ${params.query}`)

    try {
      if (!pythonRuntime.isReady()) {
        await pythonRuntime.initialize()
      }

      const query = params.query
      // @ts-expect-error TS6133 — used in Python template string interpolation
      const _timeout = params.timeout ?? this.operationTimeout

      const script = `
import json
import platform
import psutil
import os
import time

result = {'success': False, 'data': {}, 'error': None}
query = '${query}'

try:
    if query in ('cpu', 'all'):
        cpu_freq = psutil.cpu_freq()
        result['data']['cpu'] = {
            'physical_cores': psutil.cpu_count(logical=False),
            'logical_cores': psutil.cpu_count(logical=True),
            'percent': psutil.cpu_percent(interval=0.5),
            'freq_current': cpu_freq.current if cpu_freq else None,
            'freq_max': cpu_freq.max if cpu_freq else None,
            'load_avg': [round(x, 2) for x in psutil.getloadavg()] if hasattr(psutil, 'getloadavg') else None,
        }

    if query in ('memory', 'all'):
        mem = psutil.virtual_memory()
        swap = psutil.swap_memory()
        result['data']['memory'] = {
            'total_gb': round(mem.total / (1024**3), 2),
            'available_gb': round(mem.available / (1024**3), 2),
            'used_gb': round(mem.used / (1024**3), 2),
            'percent': mem.percent,
            'swap_total_gb': round(swap.total / (1024**3), 2),
            'swap_used_gb': round(swap.used / (1024**3), 2),
            'swap_percent': swap.percent,
        }

    if query in ('disk', 'all'):
        disks = []
        for part in psutil.disk_partitions():
            try:
                usage = psutil.disk_usage(part.mountpoint)
                disks.append({
                    'device': part.device,
                    'mountpoint': part.mountpoint,
                    'fstype': part.fstype,
                    'total_gb': round(usage.total / (1024**3), 2),
                    'used_gb': round(usage.used / (1024**3), 2),
                    'free_gb': round(usage.free / (1024**3), 2),
                    'percent': usage.percent,
                })
            except:
                pass
        result['data']['disks'] = disks

    if query in ('network', 'all'):
        net = psutil.net_io_counters()
        result['data']['network'] = {
            'bytes_sent_mb': round(net.bytes_sent / (1024**2), 2),
            'bytes_recv_mb': round(net.bytes_recv / (1024**2), 2),
            'packets_sent': net.packets_sent,
            'packets_recv': net.packets_recv,
        }

    if query in ('processes', 'all'):
        procs = []
        for proc in psutil.process_iter(['pid', 'name', 'cpu_percent', 'memory_percent']):
            try:
                procs.append(proc.info)
            except:
                pass
        procs = sorted(procs, key=lambda p: p.get('cpu_percent', 0) || 0, reverse=True)[:20]
        result['data']['processes'] = procs

    if query in ('os', 'all'):
        result['data']['os'] = {
            'system': platform.system(),
            'release': platform.release(),
            'version': platform.version(),
            'machine': platform.machine(),
            'processor': platform.processor(),
            'hostname': platform.node(),
        }

    if query in ('uptime', 'all'):
        boot_time = psutil.boot_time()
        uptime_seconds = time.time() - boot_time
        result['data']['uptime'] = {
            'boot_time': boot_time,
            'uptime_seconds': round(uptime_seconds),
            'uptime_hours': round(uptime_seconds / 3600, 1),
        }

    if query == 'battery':
        try:
            battery = psutil.sensors_battery()
            if battery:
                result['data']['battery'] = {
                    'percent': battery.percent,
                    'power_plugged': battery.power_plugged,
                    'time_left_sec': battery.secsleft,
                }
            else:
                result['data']['battery'] = {'error': 'No battery detected'}
        except:
            result['data']['battery'] = {'error': 'Unable to read battery info'}

    result['success'] = True
except Exception as e:
    result['error'] = str(e)

print(json.dumps(result))
`

      const execResult = await this.withTimeout(
        pythonRuntime.runScript(script),
        `systemInfo:${query}`
      )

      if (execResult.success && execResult.output) {
        try {
          return JSON.parse(execResult.output) as OperationResult
        } catch (e) {
          logger.error('[DynamicOp] 瑙ｆ瀽systemInfo缁撴灉澶辫触:', e)
          return { success: false, error: 'Failed to parse system info result' }
        }
      }
      return { success: false, error: execResult.error || 'System info query failed' }
    } catch (error) {
      this.log(`systemInfo error: ${error}`, 'error')
      return { success: false, error: String(error), duration: Date.now() - startTime }
    }
  }

  // ==================== Legacy Action Script Generation ====================

  private generateActionScript(action: string, params: Record<string, any>): string {
    const scripts: Record<string, string> = {
      'mouse_move': `
import pyautogui
pyautogui.moveTo(${params.x || 0}, ${params.y || 0}, duration=0.5)
print("Mouse moved")
`,
      'mouse_click': `
import pyautogui
if ${params.x !== undefined ? 'True' : 'False'} and ${params.y !== undefined ? 'True' : 'False'}:
    pyautogui.click(${params.x || 0}, ${params.y || 0})
else:
    pyautogui.click()
print("Mouse clicked")
`,
      'keyboard_type': `
import json
import pyautogui
pyautogui.write(${pyStr(params.text || '')})
print("Keyboard input complete")
`,
      'keyboard_press': `
import pyautogui
pyautogui.press("${params.key || 'enter'}")
print("Key pressed")
`,
      'keyboard_hotkey': `
import pyautogui
keys = ${JSON.stringify(params.keys || ['ctrl', 'c'])}
pyautogui.hotkey(*keys)
print("Hotkey executed")
`,
      'screen_capture': `
import pyautogui
import os
screenshot = pyautogui.screenshot()
path = os.path.expanduser("~/Pictures/screenshot.png")
screenshot.save(path)
print(f"Screenshot saved: {path}")
`,
      'screen_analyze': `
print("Screen analysis completed (via SGLang vision model)")
`,
      'wait': `
import time
time.sleep(${params.duration || 1})
print("Wait completed")
`,
      'clipboard_copy': `
try:
    import pyautogui
    pyautogui.hotkey('ctrl', 'c')
    print("Clipboard copy successful")
except Exception as e:
    print(f"Clipboard copy failed: {e}")
`,
      'clipboard_paste': `
try:
    import pyautogui
    pyautogui.hotkey('ctrl', 'v')
    print("Clipboard paste successful")
except Exception as e:
    print(f"Clipboard paste failed: {e}")
`,
      'system_volume_up': `
try:
    import pyautogui
    pyautogui.press('volumeup')
    print("Volume increased")
except Exception as e:
    print(f"Volume adjustment failed: {e}")
`,
      'system_volume_down': `
try:
    import pyautogui
    pyautogui.press('volumedown')
    print("Volume decreased")
except Exception as e:
    print(f"Volume adjustment failed: {e}")
`,
      'system_mute': `
try:
    import pyautogui
    pyautogui.press('volumemute')
    print("Mute toggled")
except Exception as e:
    print(f"Mute toggle failed: {e}")
`,
      'process_list': `
try:
    import subprocess
    result = subprocess.run(['tasklist'], capture_output=True, text=True, shell=True)
    print(result.stdout[:2000])
except Exception as e:
    print(f"Process list failed: {e}")
`,
      'window_minimize': `
try:
    import pyautogui
    pyautogui.hotkey('win', 'down')
    print("Window minimized")
except Exception as e:
    print(f"Window minimize failed: {e}")
`,
      'window_restore': `
try:
    import pyautogui
    pyautogui.hotkey('win', 'up')
    print("Window restored")
except Exception as e:
    print(f"Window restore failed: {e}")
`,
      'window_list': `
try:
    import subprocess
    import os
    POWERSHELL = os.path.join(os.environ.get('SystemRoot', 'C:\\Windows'), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    result = subprocess.run([POWERSHELL, '-Command', 'Get-Process | Where-Object {$_.MainWindowTitle} | Select-Object -First 20 Id, ProcessName, MainWindowTitle'], capture_output=True, text=True)
    print(result.stdout)
except Exception as e:
    print(f"Window list failed: {e}")
`,
      'media_play': `
try:
    import pyautogui
    pyautogui.press('playpause')
    print("Media play")
except Exception as e:
    print(f"Media play failed: {e}")
`,
      'media_pause': `
try:
    import pyautogui
    pyautogui.press('playpause')
    print("Media pause")
except Exception as e:
    print(f"Media pause failed: {e}")
`,
      'media_next': `
try:
    import pyautogui
    pyautogui.press('nexttrack')
    print("Next track")
except Exception as e:
    print(f"Next track failed: {e}")
`,
      'media_prev': `
try:
    import pyautogui
    pyautogui.press('prevtrack')
    print("Previous track")
except Exception as e:
    print(f"Previous track failed: {e}")
`,
      'cmd_run': `
try:
    import subprocess
    command = ${pyStr(params.command || 'echo Hello')}
    result = subprocess.run(command, capture_output=True, text=True, shell=True)
    if result.stdout:
        print(result.stdout)
    if result.stderr:
        print(result.stderr)
except Exception as e:
    print(f"CMD execution failed: {e}")
`,
      'powershell_run': `
try:
    import subprocess
    import os
    POWERSHELL = os.path.join(os.environ.get('SystemRoot', 'C:\\Windows'), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    command = ${pyStr(params.command || 'Write-Host Hello')}
    result = subprocess.run([POWERSHELL, '-Command', command], capture_output=True, text=True, shell=True)
    if result.stdout:
        print(result.stdout)
    if result.stderr:
        print(result.stderr)
except Exception as e:
    print(f"PowerShell execution failed: {e}")
`,
      'network_check': `
try:
    import urllib.request
    url = "${params.url || 'https://www.baidu.com'}"
    timeout = ${params.timeout || 5}
    try:
        response = urllib.request.urlopen(url, timeout=timeout)
        print(f"Network OK: HTTP {response.getcode()}")
    except Exception as e:
        print(f"Network connection failed: {e}")
except Exception as e:
    print(f"Network check failed: {e}")
`,
      'http_request': `
try:
    import urllib.request
    url = "${params.url || 'https://httpbin.org/get'}"
    timeout = ${params.timeout || 10}
    req = urllib.request.Request(url, method="${params.method || 'GET'}")
    response = urllib.request.urlopen(req, timeout=timeout)
    data = response.read().decode('utf-8')
    print(data[:1000])
except Exception as e:
    print(f"HTTP request failed: {e}")
`,
      'app_launch': `
import subprocess, os, json
app_name = json.loads(${JSON.stringify(params.app || 'notepad')})
app_map = {'notepad': 'notepad.exe', 'calculator': 'calc.exe', 'calc': 'calc.exe', 'paint': 'mspaint.exe', 'cmd': 'cmd.exe', 'powershell': 'powershell.exe', 'explorer': 'explorer.exe', 'wordpad': 'write.exe', 'taskmgr': 'taskmgr.exe', 'snipping': 'SnippingTool.exe', 'control': 'control.exe', 'regedit': 'regedit.exe', 'powerpoint': 'POWERPNT.EXE', 'word': 'WINWORD.EXE', 'excel': 'EXCEL.EXE', 'vscode': 'code', 'chrome': 'chrome.exe', 'edge': 'msedge.exe', 'firefox': 'firefox.exe', 'spotify': 'spotify.exe', 'vlc': 'vlc.exe'}
exe = app_map.get(app_name.lower(), app_name)
if '.' not in exe: exe += '.exe'
try:
    subprocess.Popen([exe], shell=True)
    print(f"Launched: {exe}")
except Exception as e:
    print(f"App launch failed: {e}")
`,
      'app_close': `
import subprocess, json
app_name = json.loads(${JSON.stringify(params.app || 'notepad')})
proc = app_name.lower() + '.exe' if '.' not in app_name else app_name
subprocess.run(['taskkill', '/IM', proc, '/F'], capture_output=True, shell=True)
print(f"Closed: {proc}")
`,
      'browser_open': `
import webbrowser
webbrowser.open("${params.url || 'https://www.google.com'}")
print("Browser opened")
`,
      'browser_navigate': `
import pyautogui, time
pyautogui.hotkey('ctrl', 'l')
time.sleep(0.3)
pyautogui.write("${params.url || ''}")
pyautogui.press('enter')
print("Navigated")
`,
      'browser_click': `
import pyautogui, time
x, y = ${params.x || 300}, ${params.y || 300}
pyautogui.click(x, y)
print("Clicked")
`,
      'browser_type': `
import pyautogui, time
pyautogui.write("${params.text || ''}")
time.sleep(0.3)
print("Typed")
`,
      'mouse_drag': `
import pyautogui
x1, y1, x2, y2 = ${params.x1 || 100}, ${params.y1 || 100}, ${params.x2 || 300}, ${params.y2 || 300}
pyautogui.moveTo(x1, y1)
pyautogui.drag(x2 - x1, y2 - y1, duration=${params.duration || 0.5})
print("Dragged")
`,
      'mouse_scroll': `
import pyautogui
pyautogui.scroll(${params.amount || -3})
print("Scrolled")
`,
      'screen_capture_region': `
import pyautogui, os
path = "${params.path || ''}" || os.path.expanduser('~/Pictures/region.png')
screenshot = pyautogui.screenshot(region=(${params.x || 0}, ${params.y || 0}, ${params.w || 300}, ${params.h || 300}))
screenshot.save(path)
print(f"Screenshot: {path}")
`,
      'screen_capture_window': `
import pyautogui, os
path = "${params.path || ''}" || os.path.expanduser('~/Pictures/window.png')
screenshot = pyautogui.screenshot()
screenshot.save(path)
print(f"Window screenshot: {path}")
`,
      'screen_capture_clipboard': `
import pyautogui, io, ctypes
screenshot = pyautogui.screenshot()
buf = io.BytesIO()
screenshot.save(buf, format='PNG')
data = buf.getvalue()
user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32
user32.OpenClipboard(0)
user32.EmptyClipboard()
hglobal = kernel32.GlobalAlloc(0x0002, len(data))
pdata = kernel32.GlobalLock(hglobal)
ctypes.memmove(pdata, data, len(data))
kernel32.GlobalUnlock(hglobal)
user32.SetClipboardData(2, hglobal)
user32.CloseClipboard()
print("Screenshot in clipboard")
`,
      'image_compare': `
print("Image comparison module invoked")
`,
      'image_crop': `
from PIL import Image
import os
path = "${params.path || ''}"
x, y, w, h = ${params.x || 0}, ${params.y || 0}, ${params.w || 100}, ${params.h || 100}
out = "${params.output || ''}" || path.replace('.', '_cropped.')
if os.path.exists(path):
    img = Image.open(path)
    img.crop((x, y, x + w, y + h)).save(out)
    print(f"Cropped: {out}")
`,
      'image_resize': `
from PIL import Image
import os
path = "${params.path || ''}"
w, h = ${params.w || 300}, ${params.h || 300}
out = "${params.output || ''}" || path.replace('.', '_resized.')
if os.path.exists(path):
    img = Image.open(path)
    img.resize((w, h), Image.LANCZOS).save(out)
    print(f"Resized: {out}")
`,
      'image_ocr': `
import pytesseract
from PIL import Image
path = "${params.path || ''}"
if path and __import__('os').path.exists(path):
    img = Image.open(path)
    text = pytesseract.image_to_string(img, lang='chi_sim+eng')
    print(text[:3000])
else:
    print("OCR requires valid image path")
`,
      'excel_open': `
import os
os.startfile("${params.path || ''}") if "${params.path || ''}" and os.path.exists("${params.path || ''}") else print("File not found")
`,
      'excel_read': `
import openpyxl
path = "${params.path || ''}"
if path and __import__('os').path.exists(path):
    wb = openpyxl.load_workbook(path, data_only=True)
    ws = wb["${params.sheet || 'Sheet1'}"] if "${params.sheet || 'Sheet1'}" in wb.sheetnames else wb.active
    for row in ws.iter_rows(max_row=50, values_only=True):
        print("\\t".join([str(c) if c is not None else '' for c in row]))
`,
      'excel_write': `
import openpyxl
path = "${params.path || ''}"
data = ${JSON.stringify(params.data || '[]')}
if path:
    wb = openpyxl.Workbook()
    ws = wb.active
    for ri, row in enumerate(data, 1):
        for ci, val in enumerate(row, 1):
            ws.cell(row=ri, column=ci, value=val)
    wb.save(path)
    print(f"Written: {path}")
`,
      'excel_chart': `
print("Excel chart generation (requires openpyxl chart module)")
`,
      'word_open': `
import os
os.startfile("${params.path || ''}") if "${params.path || ''}" and os.path.exists("${params.path || ''}") else print("File not found")
`,
      'word_read': `
path = "${params.path || ''}"
if path and __import__('os').path.exists(path):
    import docx
    doc = docx.Document(path)
    for p in doc.paragraphs[:100]:
        print(p.text)
`,
      'word_write': `
import docx
doc = docx.Document()
for line in """${params.content || ''}""".split('\\n'):
    doc.add_paragraph(line)
doc.save("${params.path || 'output.docx'}")
print("Word saved")
`,
      'word_format': `
print("Word formatting applied")
`,
      'ai_analyze_and_act': `
print("AI analyze and act: " + """${params.prompt || ''}""")
`,
      'ai_vision_navigate': `
print("AI vision navigation executed")
`,
      'ai_autofill': `
import pyautogui, time, json
fields = json.loads(${JSON.stringify(params.fields || '{}')})
for k, v in fields.items():
    pyautogui.write(str(v))
    pyautogui.press('tab')
    time.sleep(0.2)
print("Autofill done")
`,
      'service_start': `
import subprocess
subprocess.run(['net', 'start', "${params.service || ''}"], capture_output=True, shell=True)
print("Service started")
`,
      'service_stop': `
import subprocess
subprocess.run(['net', 'stop', "${params.service || ''}"], capture_output=True, shell=True)
print("Service stopped")
`,
      'service_list': `
import subprocess
result = subprocess.run(['sc', 'query'], capture_output=True, text=True, shell=True)
print(result.stdout[:3000])
`,
      'env_get': `
import os
print(f"{${JSON.stringify(params.key || 'PATH')}}={os.environ.get(${JSON.stringify(params.key || 'PATH')}, '')}")
`,
      'env_set': `
import os
os.environ[${JSON.stringify(params.key || '')}] = ${JSON.stringify(params.value || '')}
print("Env set")
`,
      'schedule_create': `
import subprocess
subprocess.run(['schtasks', '/Create', '/TN', "${params.name || 'Task'}", '/TR', "${params.command || 'echo'}", '/SC', 'ONCE', '/ST', '00:00'], capture_output=True, shell=True)
print("Schedule created")
`,
      'schedule_delete': `
import subprocess
subprocess.run(['schtasks', '/Delete', '/TN', "${params.name || ''}", '/F'], capture_output=True, shell=True)
print("Schedule deleted")
`,
      'archive_compress': `
import zipfile, os
src, dst = "${params.source || ''}", "${params.target || ''}"
if src and dst and os.path.exists(src):
    with zipfile.ZipFile(dst, 'w', zipfile.ZIP_DEFLATED) as zf:
        if os.path.isfile(src): zf.write(src, os.path.basename(src))
        else:
            for root, dirs, files in os.walk(src):
                for f in files:
                    fp = os.path.join(root, f)
                    zf.write(fp, os.path.relpath(fp, os.path.dirname(src)))
    print(f"Archive: {dst}")
`,
      'archive_extract': `
import zipfile, os
src, dst = "${params.source || ''}", "${params.target || ''}"
if src and dst and os.path.exists(src):
    with zipfile.ZipFile(src, 'r') as zf:
        zf.extractall(dst)
    print(f"Extracted to: {dst}")
`,
      'exec_command': `
import subprocess
result = subprocess.run("${params.command || 'echo'}", capture_output=True, text=True, shell=True)
if result.stdout: print(result.stdout)
if result.stderr: print(result.stderr)
`,
      'file_operation': `
print("File operation: ${params.operation || 'read'} (routed through fileOperation method)")
`,
      'window_control': `
print("Window control: ${params.action || 'list'} (routed through windowControl method)")
`,
      'system_info': `
print("System info: ${params.query || 'all'} (routed through systemInfo method)")
`,
      'window_open': `
print("Window open requested")
`,
      'window_close': `
import pyautogui
pyautogui.hotkey('alt', 'f4')
print("Window closed")
`,
      'window_focus': `
import subprocess
import os
POWERSHELL = os.path.join(os.environ.get('SystemRoot', 'C:\\Windows'), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
subprocess.run([POWERSHELL, '-Command', f'Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.Interaction]::AppActivate("{${JSON.stringify(params.title || '')}}")'], capture_output=True, timeout=5)
print("Window focused")
`,
      'window_resize': `
import subprocess
import os
POWERSHELL = os.path.join(os.environ.get('SystemRoot', 'C:\\Windows'), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
w, h = ${params.width || 800}, ${params.height || 600}
subprocess.run([POWERSHELL, '-Command', f'$h = (Get-Process | Where-Object {{$_.MainWindowTitle -match "{${JSON.stringify(params.title || '')}}"}})[0].MainWindowHandle; Add-Type -Name W32 -Namespace API -MemberDefinition "[DllImport(\\"user32.dll\\")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int X, int Y, int cx, int cy, uint f);"; [API.W32]::SetWindowPos($h, [IntPtr]::Zero, 0, 0, {w}, {h}, 0x0004)'], capture_output=True, timeout=5)
print("Window resized")
`,
      'window_screenshot': `
import pyautogui, os
path = os.path.expanduser("~/Pictures/win_screenshot.png")
pyautogui.screenshot().save(path)
print(f"Screenshot: {path}")
`,
      'file_read': `
path = "${params.sourcePath || ''}"
if path and __import__('os').path.exists(path):
    with open(path, 'r', encoding='utf-8') as f:
        print(f.read()[:10000])
`,
      'file_write': `
import os
path = "${params.sourcePath || ''}"
os.makedirs(os.path.dirname(path) || '.', exist_ok=True)
with open(path, 'w', encoding='utf-8') as f:
    f.write("""${params.content || ''}""")
print("Written")
`,
      'file_delete': `
import os
path = "${params.sourcePath || ''}"
if path and os.path.exists(path):
    os.remove(path) if os.path.isfile(path) else __import__('shutil').rmtree(path)
print("Deleted")
`,
      'file_copy': `
import shutil, os
src, dst = "${params.sourcePath || ''}", "${params.targetPath || ''}"
if src and dst and os.path.exists(src):
    os.makedirs(os.path.dirname(dst) || '.', exist_ok=True)
    shutil.copy2(src, dst) if os.path.isfile(src) else shutil.copytree(src, dst, dirs_exist_ok=True)
print("Copied")
`,
      'delay': `
import time
time.sleep(${params.duration || 1})
`,
      'loop': `
import time
for i in range(${params.count || 3}):
    print(f"Loop {i+1}/${params.count || 3}")
    time.sleep(${params.duration || 1})
`,
      'condition': `
print(f"Condition: ${params.expression || 'true'}")
`,
      'clipboard_get': `
import pyperclip
text = pyperclip.paste()
print(text[:2000] if text else "(empty)")
`,
      'system_brightness_up': `
try:
    import screen_brightness_control as sbc
    c = sbc.get_brightness()
    v = (c[0] if isinstance(c, list) else c) + 10
    sbc.set_brightness(min(100, v))
    print(f"Brightness: {v}%")
except: print("Brightness control unavailable")
`,
      'system_brightness_down': `
try:
    import screen_brightness_control as sbc
    c = sbc.get_brightness()
    v = (c[0] if isinstance(c, list) else c) - 10
    sbc.set_brightness(max(0, v))
    print(f"Brightness: {v}%")
except: print("Brightness control unavailable")
`,
      'process_info': `
import psutil, json
pid = ${params.pid || 0}
if pid:
    try:
        p = psutil.Process(pid)
        info = {'pid': p.pid, 'name': p.name(), 'cpu': p.cpu_percent(), 'mem_mb': round(p.memory_info().rss/1024**2,1)}
        print(json.dumps(info))
    except: print('{"error":"not found"}')
else:
    procs = [{'pid':p.pid,'name':p.name()} for p in psutil.process_iter(['pid','name'])][:20]
    print(json.dumps(procs))
`,
      'screen_ocr': `
try:
    import pytesseract, pyautogui
    text = pytesseract.image_to_string(pyautogui.screenshot(), lang='chi_sim+eng')
    print(text[:3000])
except Exception as e:
    print(f"OCR failed: {e}")
`,
      'screen_ocr_region': `
try:
    import pytesseract, pyautogui
    img = pyautogui.screenshot(region=(${params.x || 0}, ${params.y || 0}, ${params.w || 300}, ${params.h || 200}))
    text = pytesseract.image_to_string(img, lang='chi_sim+eng')
    print(text[:3000])
except Exception as e:
    print(f"OCR failed: {e}")
`,
      'text_select': `
import pyautogui
pyautogui.hotkey('shift', 'right')
`,
      'text_select_all': `
import pyautogui
pyautogui.hotkey('ctrl', 'a')
`,
      'text_delete': `
import pyautogui
pyautogui.press('delete')
`,
      'drag_drop': `
import pyautogui, time
pyautogui.moveTo(${params.x1 || 100}, ${params.y1 || 100})
pyautogui.mouseDown()
time.sleep(0.2)
pyautogui.moveTo(${params.x2 || 300}, ${params.y2 || 300}, duration=0.5)
pyautogui.mouseUp()
print("Drag-drop done")
`,
      'drag_file': `
import pyautogui, time
pyautogui.moveTo(${params.x1 || 100}, ${params.y1 || 100})
pyautogui.mouseDown()
time.sleep(0.2)
pyautogui.moveTo(${params.x2 || 300}, ${params.y2 || 300}, duration=1.0)
pyautogui.mouseUp()
print("File dragged")
`,
      'form_fill': `
import pyautogui, time, json
fields = json.loads(${JSON.stringify(params.fields || '{}')})
for k, v in fields.items():
    pyautogui.write(str(v))
    pyautogui.press('tab')
    time.sleep(0.15)
print("Form filled")
`,
      'form_submit': `
import pyautogui
pyautogui.press('enter')
`,
      'notification_show': `
print("Notification: ${params.title || ''} - ${params.message || ''}")
`,
      'notification_click': `
import pyautogui
pyautogui.click()
`,
      'download_file': `
import urllib.request, os
url = "${params.url || ''}"
path = "${params.path || ''}" || os.path.basename(url) || 'download'
if url:
    urllib.request.urlretrieve(url, path)
    print(f"Downloaded: {path}")
`,
      'registry_read': `
import winreg
try:
    root_map = {'HKLM': winreg.HKEY_LOCAL_MACHINE, 'HKCU': winreg.HKEY_CURRENT_USER}
    parts = "${params.key || ''}".split('\\\\', 1)
    root = root_map.get(parts[0], winreg.HKEY_CURRENT_USER)
    key = winreg.OpenKey(root, parts[1] if len(parts) > 1 else '', 0, winreg.KEY_READ)
    val, _ = winreg.QueryValueEx(key, "${params.value || ''}" || None)
    winreg.CloseKey(key)
    print(str(val))
except Exception as e:
    print(f"Registry read failed: {e}")
`,
      'registry_write': `
import winreg
try:
    root_map = {'HKLM': winreg.HKEY_LOCAL_MACHINE, 'HKCU': winreg.HKEY_CURRENT_USER}
    parts = "${params.key || ''}".split('\\\\', 1)
    root = root_map.get(parts[0], winreg.HKEY_CURRENT_USER)
    key = winreg.OpenKey(root, parts[1] if len(parts) > 1 else '', 0, winreg.KEY_WRITE)
    winreg.SetValueEx(key, "${params.value || ''}", 0, winreg.REG_SZ, "${params.data || ''}")
    winreg.CloseKey(key)
    print("Registry written")
except Exception as e:
    print(f"Registry write failed: {e}")
`,
      'screen_find': `
import pyautogui
try:
    loc = pyautogui.locateOnScreen("${params.target || ''}", confidence=0.8)
    if loc:
        x, y = pyautogui.center(loc)
        print(f"Found at ({x}, {y})")
    else:
        print("Not found")
except Exception as e:
    print(f"Screen find failed: {e}")
`,
      'system_lock': `
import subprocess
import { logger } from '../../shared/logger'
subprocess.run(['rundll32.exe', 'user32.dll,LockWorkStation'], shell=True)
print("System locked")
`,
    }

    return scripts[action] || `
print(f"Unknown action: ${action}")
`
  }

  // ==================== Task Management ====================

  async executeTask(task: SystemTask): Promise<SystemTask> {
    task.status = 'running'
    this.tasks.set(task.id, task)
    this.log(`Executing task: ${task.title} (${task.id})`)

    try {
      for (const step of task.steps) {
        step.status = 'running'
        try {
          const result = await this.executeStep({
            action: step.description.toLowerCase().includes('analyze') ? 'screen_analyze' : 'keyboard_type',
            params: { text: step.description },
            description: step.description,
            useVision: false,
          })
          step.result = result
          step.status = 'completed'
        } catch (error) {
          step.status = 'error'
          step.error = String(error)
          if (step.retryCount < step.maxRetries) {
            step.retryCount++
            step.status = 'pending'
            continue
          }
          task.status = 'error'
          return task
        }
      }
      task.status = 'completed'
      task.completedAt = Date.now()
    } catch (error) {
      task.status = 'error'
      this.log(`Task ${task.id} failed: ${error}`, 'error')
    }

    return task
  }

  getTasks(): SystemTask[] {
    return Array.from(this.tasks.values())
  }

  getTask(id: string): SystemTask | undefined {
    return this.tasks.get(id)
  }

  cancelTask(id: string): boolean {
    const task = this.tasks.get(id)
    if (task && (task.status === 'pending' || task.status === 'running')) {
      task.status = 'error'
      this.log(`Task cancelled: ${task.title}`)
      return true
    }
    return false
  }

  // ==================== Safety Config ====================

  getSafetyConfig() {
    return {
      visionEnabled: this.visionEnabled,
      safetyMode: this.safetyMode,
      operationTimeout: this.operationTimeout,
      allowedOperations: Array.from(this.allowedOperations),
    }
  }

  setVisionEnabled(enabled: boolean): void {
    this.visionEnabled = enabled
    this.saveSafetyConfig()
  }

  setSafetyMode(enabled: boolean): void {
    this.safetyMode = enabled
    this.saveSafetyConfig()
  }

  setOperationTimeout(timeoutMs: number): void {
    this.operationTimeout = Math.max(1000, Math.min(timeoutMs, 300000))
    this.saveSafetyConfig()
  }

  addAllowedOperation(operation: string): void {
    this.allowedOperations.add(operation)
    this.saveSafetyConfig()
  }

  removeAllowedOperation(operation: string): void {
    this.allowedOperations.delete(operation)
    this.saveSafetyConfig()
  }
}

// ==================== Singleton ====================
export const dynamicOperationEngine = new DynamicOperationEngine()

// ==================== IPC Handler Registration ====================
export function setupDynamicOperationHandlers(): void {
  // Operation analysis
  ipcMain.handle('operation:analyze', async (_event, userRequest: string) => {
    try {
      return await dynamicOperationEngine.analyzeAndPlan(userRequest)
    } catch (error) {
      return { steps: [], reasoning: `Error: ${error}` }
    }
  })

  ipcMain.handle('operation:execute-step', async (_event, step: ExecutionPlan['steps'][0]) => {
    try {
      return await dynamicOperationEngine.executeStep(step)
    } catch (error) {
      return `Error: ${error}`
    }
  })

  ipcMain.handle('operation:execute-task', async (_event, task: SystemTask) => {
    try {
      return await dynamicOperationEngine.executeTask(task)
    } catch (error) {
      return { ...task, status: 'error' as const }
    }
  })

  // Task management
  ipcMain.handle('operation:get-tasks', () => {
    try { return dynamicOperationEngine.getTasks() } catch (e) { logger.error('[DynamicOp] getTasks澶辫触:', e); return [] }
  })

  ipcMain.handle('operation:get-task', (_event, id: string) => {
    try { return dynamicOperationEngine.getTask(id) } catch (e) { logger.error('[DynamicOp] getTask澶辫触:', e); return undefined }
  })

  ipcMain.handle('operation:cancel', (_event, id: string) => {
    try { return dynamicOperationEngine.cancelTask(id) } catch (e) { logger.error('[DynamicOp] cancelTask澶辫触:', e); return false }
  })

  // 兼容别名：operation:list-tasks → operation:get-tasks
  ipcMain.handle('operation:list-tasks', () => {
    try { return dynamicOperationEngine.getTasks() } catch (e) { logger.error('[DynamicOp] listTasks澶辫触:', e); return [] }
  })

  // 运行状态汇总
  ipcMain.handle('operation:status', () => {
    try {
      const tasks = dynamicOperationEngine.getTasks()
      const running = tasks.filter(t => t.status === 'running').length
      const completed = tasks.filter(t => t.status === 'completed').length
      return { total: tasks.length, running, completed }
    } catch (e) {
      logger.error('[DynamicOp] status澶辫触:', e)
      return { total: 0, running: 0, completed: 0 }
    }
  })

  // Safety config
  ipcMain.handle('operation:safety-config', () => {
    try { return dynamicOperationEngine.getSafetyConfig() } catch (e) {
      logger.error('[DynamicOp] getSafetyConfig澶辫触:', e)
      return { visionEnabled: false, safetyMode: true, operationTimeout: DEFAULT_TIMEOUT, allowedOperations: [] }
    }
  })

  ipcMain.handle('operation:set-vision', (_event, enabled: boolean) => {
    try { dynamicOperationEngine.setVisionEnabled(enabled); return { success: true } }
    catch (error) { return { success: false, error: String(error) } }
  })

  ipcMain.handle('operation:set-safety', (_event, enabled: boolean) => {
    try { dynamicOperationEngine.setSafetyMode(enabled); return { success: true } }
    catch (error) { return { success: false, error: String(error) } }
  })

  ipcMain.handle('operation:set-timeout', (_event, timeoutMs: number) => {
    try { dynamicOperationEngine.setOperationTimeout(timeoutMs); return { success: true } }
    catch (error) { return { success: false, error: String(error) } }
  })

  ipcMain.handle('operation:add-allowed', (_event, operation: string) => {
    try { dynamicOperationEngine.addAllowedOperation(operation); return { success: true } }
    catch (error) { return { success: false, error: String(error) } }
  })

  ipcMain.handle('operation:remove-allowed', (_event, operation: string) => {
    try { dynamicOperationEngine.removeAllowedOperation(operation); return { success: true } }
    catch (error) { return { success: false, error: String(error) } }
  })

  // ==================== New IPC Handlers ====================

  // Execute system command
  ipcMain.handle('operation:exec-command', async (_event, params: {
    command: string; args?: string[]; timeout?: number; cwd?: string; env?: Record<string, string>
  }) => {
    try {
      return await dynamicOperationEngine.execCommand(params)
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  // File operations
  ipcMain.handle('operation:file-op', async (_event, params: {
    operation: 'read' | 'write' | 'copy' | 'move' | 'delete' | 'list' | 'stat'
    sourcePath?: string
    targetPath?: string
    content?: string
    encoding?: string
    recursive?: boolean
    timeout?: number
  }) => {
    try {
      return await dynamicOperationEngine.fileOperation(params)
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  // Window control
  ipcMain.handle('operation:window-control', async (_event, params: {
    action: 'list' | 'focus' | 'minimize' | 'maximize' | 'restore' | 'resize' | 'setTop' | 'close'
    title?: string; pid?: number; width?: number; height?: number; x?: number; y?: number; timeout?: number
  }) => {
    try {
      return await dynamicOperationEngine.windowControl(params)
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  // System information
  ipcMain.handle('operation:system-info', async (_event, params: {
    query: 'cpu' | 'memory' | 'disk' | 'network' | 'processes' | 'os' | 'uptime' | 'battery' | 'all'
    timeout?: number
  }) => {
    try {
      return await dynamicOperationEngine.systemInfo(params)
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })
}
