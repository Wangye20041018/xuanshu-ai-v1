// @deprecated v11.3 - switch-case 任务类型分发已迁移到 Agent 统一框架
// 保留各独立操作方法，但 dispatch 逻辑标记为 deprecated
import { app, ipcMain } from 'electron'
import { join } from 'path'
import {existsSync, readFileSync} from 'fs'
import { pythonRuntime } from '../runtime/python'
import { visionModel } from '../vision'
import { logger } from '../../shared/logger'

// 操作超时常量
const STEP_TIMEOUT_MS = 30000
// @ts-expect-error TS6133 - MAX_RETRIES reserved for future use
const MAX_RETRIES = 3

// C-01 修复：Python 脚本参数通过环境变量安全传递，杜绝字符串拼接命令注入
// 脚本内使用 __XUANSHU_DESC__ 变量读取用户描述，不再将描述直接嵌入 Python 源码
const PY_DESC_LOADER = 'import os, json\n__XUANSHU_DESC__ = json.loads(os.environ.get("XUANSHU_DESCRIPTION", "\\"\\""))\n'

/** C-01 修复：构造 runScript 的 env 参数，将用户描述以 JSON 字符串安全传递 */
function descEnv(description: string): { env: Record<string, string> } {
  return { env: { XUANSHU_DESCRIPTION: JSON.stringify(description) } }
}

interface TaskStep {
  id: string
  type: 'ppt' | 'browser' | 'file' | 'chat' | 'command' | 'vision' | 'email' | 'video' | 'audio' | 'document' | 'system'
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

class SystemOperationEngine {
  private tasks: Map<string, SystemTask> = new Map()
  // @ts-expect-error TS6133 - currentTask reserved for future use
  private currentTask: SystemTask | null = null
  // @ts-expect-error TS6133 - maxRetryCount reserved for future use
  private maxRetryCount: number = 3
  private operationHistory: Map<string, { success: boolean; error?: string; timestamp: number }> = new Map()

  async executeTask(task: SystemTask): Promise<SystemTask> {
    this.tasks.set(task.id, task)
    this.currentTask = task
    task.status = 'running'

    for (let i = 0; i < task.steps.length; i++) {
      const step = task.steps[i]
      step.status = 'running'

      let success = false
      let attempts = 0

      while (!success && attempts < step.maxRetries) {
        try {
          // 每步加 30s 超时
          const stepPromise = (async () => {
            // @deprecated v11.3 - switch-case 任务类型分发已迁移到 Agent 统一框架
            switch (step.type) {
              case 'ppt':
                step.result = await this.createPPT(step.description)
                break
              case 'browser':
                step.result = await this.browserAutomation(step.description)
                break
              case 'file':
                step.result = await this.fileOperation(step.description)
                break
              case 'chat':
                step.result = await this.chatOperation(step.description)
                break
              case 'command':
                step.result = await this.executeCommand(step.description)
                break
              case 'vision':
                step.result = await this.visionAnalysis(step.description)
                break
              case 'email':
                step.result = await this.sendEmail(step.description)
                break
              case 'video':
                step.result = await this.videoOperation(step.description)
                break
              case 'audio':
                step.result = await this.audioOperation(step.description)
                break
              case 'document':
                step.result = await this.documentOperation(step.description)
                break
              case 'system':
                step.result = await this.systemOperation(step.description)
                break
            }
          })()

          await Promise.race([
            stepPromise,
            new Promise<void>((_, reject) =>
              setTimeout(() => reject(new Error(`步骤超时 (${STEP_TIMEOUT_MS / 1000}s)`)), STEP_TIMEOUT_MS)
            )
          ])
          success = true
          step.status = 'completed'
        } catch (error) {
          attempts++
          step.retryCount = attempts
          
          if (attempts >= step.maxRetries) {
            step.status = 'error'
            step.error = String(error)
            task.status = 'error'
            this.recordOperation(step.id, false, String(error))
            break
          }
          
          await this.delay(attempts * 2000)
        }
      }

      if (step.status === 'error') {
        break
      }
      
      this.recordOperation(step.id, true)
      
      await this.notifyProgress(task.id, i + 1, task.steps.length)
    }

    if (task.status !== 'error') {
      task.status = 'completed'
      task.completedAt = Date.now()
    }

    this.currentTask = null
    return task
  }

  private async delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  private recordOperation(id: string, success: boolean, error?: string): void {
    this.operationHistory.set(id, { success, error, timestamp: Date.now() })
  }

  private async notifyProgress(taskId: string, current: number, total: number): Promise<void> {
    const task = this.tasks.get(taskId)
    if (task) {
      const { ipcMain } = require('electron')
      ipcMain.emit('system:operation:progress', {
        taskId,
        progress: (current / total) * 100,
        currentStep: current,
        totalSteps: total,
        status: task.status
      })
    }
  }

  private async createPPT(description: string): Promise<string> {
    if (!pythonRuntime.isReady()) {
      await pythonRuntime.initialize()
    }

    const script = `
${PY_DESC_LOADER}import os
import json
from pptx import Presentation
from pptx.util import Inches, Pt
from pptx.enum.text import PP_ALIGN
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.slide import PP_LAYOUT

def create_presentation(prompt):
    prs = Presentation()
    
    title_layout = prs.slide_layouts[0]
    slide = prs.slides.add_slide(title_layout)
    title = slide.shapes.title
    subtitle = slide.placeholders[1]
    title.text = "AI 智能演示文稿"
    subtitle.text = prompt
    
    bg = slide.background
    fill = bg.fill
    fill.solid()
    fill.fore_color.rgb = RGBColor(30, 30, 50)
    
    title.text_frame.paragraphs[0].font.color.rgb = RGBColor(255, 255, 255)
    subtitle.text_frame.paragraphs[0].font.color.rgb = RGBColor(200, 200, 200)
    
    content_layout = prs.slide_layouts[1]
    
    sections = [
        {"title": "项目概述", "points": ["项目背景", "核心目标", "预期成果"]},
        {"title": "技术架构", "points": ["系统架构", "核心模块", "技术栈"]},
        {"title": "实施方案", "points": ["阶段规划", "关键路径", "资源需求"]},
        {"title": "进度安排", "points": ["时间节点", "里程碑", "风险控制"]},
        {"title": "团队介绍", "points": ["核心成员", "分工协作", "专业能力"]},
        {"title": "预算明细", "points": ["人力成本", "硬件投入", "其他支出"]},
        {"title": "风险评估", "points": ["技术风险", "市场风险", "应对策略"]},
        {"title": "结语", "points": ["总结回顾", "未来展望", "致谢"]}
    ]
    
    for section in sections:
        slide = prs.slides.add_slide(content_layout)
        title_shape = slide.shapes.title
        body_shape = slide.placeholders[1]
        
        title_shape.text = section["title"]
        title_shape.text_frame.paragraphs[0].font.size = Pt(32)
        title_shape.text_frame.paragraphs[0].font.color.rgb = RGBColor(0, 122, 204)
        
        tf = body_shape.text_frame
        tf.clear()
        
        for point in section["points"]:
            p = tf.add_paragraph()
            p.text = point
            p.font.size = Pt(20)
            p.font.color.rgb = RGBColor(60, 60, 60)
            p.level = 0
    
    blank_layout = prs.slide_layouts[6]
    slide = prs.slides.add_slide(blank_layout)
    
    shapes = slide.shapes
    left = top = width = height = Inches(1)
    
    for i in range(5):
        shape = shapes.add_shape(MSO_SHAPE.RECTANGLE, left + i*Inches(1.2), top, width, height)
        shape.fill.solid()
        shape.fill.fore_color.rgb = RGBColor(0, 122, 204 + i*20)
        shape.line.fill.background()
    
    output_dir = os.path.expanduser("~/Documents")
    os.makedirs(output_dir, exist_ok=True)
    output_path = os.path.join(output_dir, f"AI_Presentation_{os.getpid()}.pptx")
    prs.save(output_path)
    
    return output_path

result = create_presentation(__XUANSHU_DESC__)
print(result)
`

    const result = await pythonRuntime.runScript(script, [], descEnv(description))
    return result.success ? result.output || 'PPT创建成功' : result.error || 'PPT创建失败'
  }

  private async browserAutomation(description: string): Promise<string> {
    if (!pythonRuntime.isReady()) {
      await pythonRuntime.initialize()
    }

    const script = `
${PY_DESC_LOADER}import os
import time
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.chrome.options import Options
from webdriver_manager.chrome import ChromeDriverManager

def setup_driver():
    options = Options()
    options.add_argument("--start-maximized")
    options.add_argument("--disable-notifications")
    options.add_argument("--disable-infobars")
    options.add_argument("--disable-blink-features=AutomationControlled")
    options.add_experimental_option("excludeSwitches", ["enable-automation"])
    options.add_experimental_option("useAutomationExtension", False)
    
    driver = webdriver.Chrome(service=Service(ChromeDriverManager().install()), options=options)
    driver.execute_script("Object.defineProperty(navigator, 'webdriver', {get: () => undefined})")
    
    return driver

def search_google(query):
    driver = setup_driver()
    
    try:
        driver.get("https://www.google.com")
        
        WebDriverWait(driver, 10).until(
            EC.presence_of_element_located((By.NAME, "q"))
        )
        
        search_box = driver.find_element(By.NAME, "q")
        search_box.send_keys(query)
        search_box.submit()
        
        WebDriverWait(driver, 10).until(
            EC.presence_of_element_located((By.ID, "search"))
        )
        
        results = driver.find_elements(By.CSS_SELECTOR, "h3")
        titles = [result.text for result in results[:5] if result.text]
        
        time.sleep(2)
        driver.quit()
        
        return json.dumps({"success": True, "results": titles})
    except Exception as e:
        driver.quit()
        return json.dumps({"success": False, "error": str(e)})

import json
result = search_google(__XUANSHU_DESC__)
print(result)
`

    const result = await pythonRuntime.runScript(script, [], descEnv(description))
    return result.success ? result.output || '浏览器自动化完成' : result.error || '浏览器自动化失败'
  }

  private async fileOperation(description: string): Promise<string> {
    if (!pythonRuntime.isReady()) {
      await pythonRuntime.initialize()
    }

    const script = `
${PY_DESC_LOADER}import os
import shutil
import json

def execute_file_operation(description):
    results = []
    description = description.lower()
    
    if "创建" in description or "新建" in description:
        if "文件夹" in description or "目录" in description:
            new_dir = os.path.expanduser("~/Documents/AI_Created")
            os.makedirs(new_dir, exist_ok=True)
            results.append(f"已创建文件夹: {new_dir}")
        else:
            new_file = os.path.expanduser("~/Documents/AI_Created.txt")
            with open(new_file, "w", encoding="utf-8") as f:
                f.write("此文件由AI创建\\n")
                f.write(f"创建时间: {os.path.getctime(new_file)}\\n")
                f.write(f"描述: {description}\\n")
            results.append(f"已创建文件: {new_file}")
    
    if "删除" in description or "清理" in description:
        trash_dir = os.path.expanduser("~/Documents/AI_Trash")
        os.makedirs(trash_dir, exist_ok=True)
        
        if "临时文件" in description:
            temp_files = [f for f in os.listdir(os.path.expanduser("~/Documents")) if f.startswith("AI_")]
            for f in temp_files[:5]:
                src = os.path.expanduser(f"~/Documents/{f}")
                dst = os.path.join(trash_dir, f)
                if os.path.exists(src):
                    shutil.move(src, dst)
                    results.append(f"已清理: {f}")
        else:
            results.append(f"清理目录已准备: {trash_dir}")
    
    if "复制" in description or "备份" in description:
        src_dir = os.path.expanduser("~/Documents")
        dst_dir = os.path.expanduser("~/Documents/AI_Backup")
        os.makedirs(dst_dir, exist_ok=True)
        
        files_to_copy = [f for f in os.listdir(src_dir) if f.endswith(".txt") or f.endswith(".md")][:3]
        for f in files_to_copy:
            src = os.path.join(src_dir, f)
            dst = os.path.join(dst_dir, f)
            shutil.copy2(src, dst)
            results.append(f"已备份: {f}")
    
    if "列出" in description or "显示" in description:
        target_dir = os.path.expanduser("~/Documents")
        files = os.listdir(target_dir)[:10]
        results.append(f"目录内容 ({target_dir}):")
        results.extend(files)
    
    return json.dumps({"success": True, "results": results})

import json
result = execute_file_operation(__XUANSHU_DESC__)
print(result)
`

    const result = await pythonRuntime.runScript(script, [], descEnv(description))
    return result.success ? result.output || '文件操作完成' : result.error || '文件操作失败'
  }

  /**
   * 解析聊天应用的可执行文件路径（多层级优先级）：
   * 1. APP resources/apps/applications.json 用户自定义清单
   * 2. 系统常见安装目录扫描（PROGRAMFILES / PROGRAMFILES(X86)）
   * 3. 内置默认相对路径（如 %APPDATA% 下的微信）
   */
  private resolveChatAppPaths(appName: string): string[] {
    const paths: string[] = []

    // ---- 第1层：resources/apps/applications.json 用户自定义清单 ----
    const resourcesDir = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'resources')
    const manifestPath = join(resourcesDir, 'apps', 'applications.json')
    try {
      if (existsSync(manifestPath)) {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'))
        if (manifest[appName] && Array.isArray(manifest[appName])) {
          for (const p of manifest[appName]) {
            if (typeof p === 'string') paths.push(p)
          }
        }
      }
    } catch (e) {
      logger.error('[SystemOperationEngine] 读取应用清单失败:', e)
    }

    // ---- 第2层：系统常见安装目录扫描 ----
    const programFilesDirs: string[] = []
    const pf = process.env.PROGRAMFILES
    const pfx86 = process.env['PROGRAMFILES(X86)']
    if (pf) programFilesDirs.push(pf)
    if (pfx86) programFilesDirs.push(pfx86)

    // ---- 第3层：内置默认相对路径 ----
    const appData = process.env.APPDATA || ''

    const builtInPaths: Record<string, string[]> = {
      wechat: [
        ...programFilesDirs.map(d => join(d, 'Tencent', 'WeChat', 'WeChat.exe')),
        appData ? join(appData, 'Tencent', 'WeChat', 'WeChat.exe') : '',
      ],
      qq: [
        ...programFilesDirs.map(d => join(d, 'Tencent', 'QQ', 'Bin', 'QQ.exe')),
      ],
      dingtalk: [
        ...programFilesDirs.map(d => join(d, 'DingDing', 'DingTalk.exe')),
      ],
    }

    for (const p of (builtInPaths[appName] || [])) {
      if (p) paths.push(p)
    }

    // 去重并过滤空值
    return [...new Set(paths.filter(Boolean))]
  }

  private async chatOperation(description: string): Promise<string> {
    if (!pythonRuntime.isReady()) {
      await pythonRuntime.initialize()
    }

    // 在 TypeScript 层解析应用路径（而非 Python 脚本内硬编码）
    const appName = description.toLowerCase()
    const resolvedPaths = this.resolveChatAppPaths(appName)

    const script = `
${PY_DESC_LOADER}import subprocess
import os
import json

app_name = __XUANSHU_DESC__.lower()
app_paths = ${JSON.stringify(resolvedPaths)}

found = False
for path in app_paths:
    if os.path.exists(path):
        subprocess.Popen([path])
        print(json.dumps({"success": True, "app": app_name, "path": path}))
        found = True
        break

if not found:
    print(json.dumps({"success": False, "error": f"{app_name} not found"}))
`

    const result = await pythonRuntime.runScript(script, [], descEnv(description))
    return result.success ? result.output || '聊天软件操作完成' : result.error || '聊天软件操作失败'
  }

  private async executeCommand(description: string): Promise<string> {
    if (!pythonRuntime.isReady()) {
      await pythonRuntime.initialize()
    }

    const script = `
${PY_DESC_LOADER}import subprocess
import shlex
import json

def run_command(command):
    try:
        # C-02 修复：shell=False + shlex.split，杜绝 shell 元字符注入
        args = shlex.split(command, posix=False)
        if not args:
            return json.dumps({"success": False, "error": "Empty command"})
        result = subprocess.run(args, shell=False, capture_output=True, text=True, timeout=30)
        return json.dumps({
            "success": result.returncode == 0,
            "stdout": result.stdout[:1000],
            "stderr": result.stderr[:1000],
            "returncode": result.returncode
        })
    except subprocess.TimeoutExpired:
        return json.dumps({"success": False, "error": "Command timed out"})
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)})

import json
result = run_command(__XUANSHU_DESC__)
print(result)
`

    const result = await pythonRuntime.runScript(script, [], descEnv(description))
    return result.success ? result.output || '命令执行完成' : result.error || '命令执行失败'
  }

  // @ts-expect-error TS6133 - description reserved for future use
  private async visionAnalysis(description: string): Promise<string> {
    const screenshot = await visionModel.captureScreen()
    const analysis = await visionModel.analyzeImage(screenshot.dataUrl)
    return JSON.stringify(analysis)
  }

  private async sendEmail(description: string): Promise<string> {
    if (!pythonRuntime.isReady()) {
      await pythonRuntime.initialize()
    }

    const script = `
${PY_DESC_LOADER}import smtplib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
import json

def send_email(description):
    try:
        msg = MIMEMultipart()
        msg['From'] = "ai@xuanshu.com"
        msg['To'] = "user@example.com"
        msg['Subject'] = "AI Generated Email"
        
        body = f"这是一封由AI自动发送的邮件。\\n\\n内容描述: {description}"
        msg.attach(MIMEText(body, 'plain'))
        
        return json.dumps({"success": True, "message": "邮件发送任务已准备"})
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)})

import json
result = send_email(__XUANSHU_DESC__)
print(result)
`

    const result = await pythonRuntime.runScript(script, [], descEnv(description))
    return result.success ? result.output || '邮件发送完成' : result.error || '邮件发送失败'
  }

  private async videoOperation(description: string): Promise<string> {
    if (!pythonRuntime.isReady()) {
      await pythonRuntime.initialize()
    }

    const script = `
${PY_DESC_LOADER}import os
import json

def video_operation(description):
    results = []
    
    if "录制" in description:
        results.append("屏幕录制功能已准备")
    if "剪辑" in description:
        results.append("视频剪辑功能已准备")
    if "下载" in description:
        results.append("视频下载功能已准备")
    
    return json.dumps({"success": True, "results": results})

import json
result = video_operation(__XUANSHU_DESC__)
print(result)
`

    const result = await pythonRuntime.runScript(script, [], descEnv(description))
    return result.success ? result.output || '视频操作完成' : result.error || '视频操作失败'
  }

  private async audioOperation(description: string): Promise<string> {
    if (!pythonRuntime.isReady()) {
      await pythonRuntime.initialize()
    }

    const script = `
${PY_DESC_LOADER}import json

def audio_operation(description):
    results = []
    
    if "播放" in description:
        results.append("音频播放功能已准备")
    if "录制" in description:
        results.append("音频录制功能已准备")
    if "转换" in description:
        results.append("音频格式转换功能已准备")
    
    return json.dumps({"success": True, "results": results})

import json
result = audio_operation(__XUANSHU_DESC__)
print(result)
`

    const result = await pythonRuntime.runScript(script, [], descEnv(description))
    return result.success ? result.output || '音频操作完成' : result.error || '音频操作失败'
  }

  private async documentOperation(description: string): Promise<string> {
    if (!pythonRuntime.isReady()) {
      await pythonRuntime.initialize()
    }

    const script = `
${PY_DESC_LOADER}import os
import docx
from docx.shared import Pt
from docx.enum.text import WD_ALIGN_PARAGRAPH
import json

def create_document(description):
    doc = docx.Document()
    
    title = doc.add_heading('AI 智能文档', 0)
    title.alignment = WD_ALIGN_PARAGRAPH.CENTER
    
    doc.add_paragraph(f'文档描述: {description}')
    doc.add_paragraph('')
    
    sections = [
        '一、项目背景',
        '二、核心内容',
        '三、详细说明',
        '四、总结与展望'
    ]
    
    for section in sections:
        doc.add_heading(section, level=1)
        doc.add_paragraph(f'这是{section}的详细内容...')
    
    output_path = os.path.expanduser("~/Documents/AI_Document.docx")
    doc.save(output_path)
    
    return json.dumps({"success": True, "path": output_path})

import json
result = create_document(__XUANSHU_DESC__)
print(result)
`

    const result = await pythonRuntime.runScript(script, [], descEnv(description))
    return result.success ? result.output || '文档操作完成' : result.error || '文档操作失败'
  }

  private async systemOperation(description: string): Promise<string> {
    if (!pythonRuntime.isReady()) {
      await pythonRuntime.initialize()
    }

    const script = `
${PY_DESC_LOADER}import os
import subprocess
import json

def system_operation(description):
    results = []
    
    if "重启" in description:
        results.append("系统重启任务已准备")
    if "关机" in description:
        results.append("系统关机任务已准备")
    if "睡眠" in description:
        results.append("系统睡眠任务已准备")
    if "清理" in description:
        try:
            subprocess.run(["cleanmgr", "/sagerun:1"], shell=False, capture_output=True)
            results.append("系统清理已执行")
        except:
            results.append("系统清理功能已准备")
    
    return json.dumps({"success": True, "results": results})

import json
result = system_operation(__XUANSHU_DESC__)
print(result)
`

    const result = await pythonRuntime.runScript(script, [], descEnv(description))
    return result.success ? result.output || '系统操作完成' : result.error || '系统操作失败'
  }

  getTasks(): SystemTask[] {
    return Array.from(this.tasks.values())
  }

  getTask(id: string): SystemTask | undefined {
    return this.tasks.get(id)
  }

  cancelTask(id: string): boolean {
    const task = this.tasks.get(id)
    if (!task) return false
    task.status = 'error'
    return true
  }

  getOperationHistory(): Array<{ id: string; success: boolean; error?: string; timestamp: number }> {
    return Array.from(this.operationHistory.entries()).map(([id, data]) => ({ id, ...data }))
  }
}

export const systemOperationEngine = new SystemOperationEngine()

export function setupSystemOperationHandlers(): void {
  ipcMain.handle('system:operation:execute', async (_event, task: SystemTask) => {
    return await systemOperationEngine.executeTask(task)
  })

  ipcMain.handle('system:operation:get-tasks', () => {
    return systemOperationEngine.getTasks()
  })

  ipcMain.handle('system:operation:get-task', (_event, id: string) => {
    return systemOperationEngine.getTask(id)
  })

  ipcMain.handle('system:operation:cancel', (_event, id: string) => {
    return systemOperationEngine.cancelTask(id)
  })

  ipcMain.handle('system:operation:history', () => {
    return systemOperationEngine.getOperationHistory()
  })
}
