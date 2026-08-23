/**
 * keyboard-workflow.ts — WPS 演示生成工作流（生成式）
 *
 * 背景：6GB 显存仅够 9B 主模型（-ngl 88/99），视觉引擎（SGLang:30000）无法常驻，
 *      视觉识别闭环不可用；且 WPS 为自绘控件，SendKeys/剪贴板对编辑区填充与
 *      另存为对话框均不可靠（实测 Ctrl+A/Ctrl+V/中文输入无效）。
 *
 * 方案：改用 pptxgenjs 直接生成 .pptx 文件（OOXML 标准格式，WPS 原生支持），
 *      再启动 WPS 演示程序打开该文件，按需 F5 放映预览。全程不依赖屏幕识别，
 *      不依赖 WPS UI 焦点，稳定可靠。
 */
import { spawn } from 'child_process'
import { exec } from 'child_process'
import { promisify } from 'util'
import { existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import PptxGenJS from 'pptxgenjs'
import { interactionExecutor } from '../visual-agent/interaction-executor'
import { logger } from '../../shared/logger'
import type { PptOutline } from './index'

const execAsync = promisify(exec)
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** WPS 演示(wpp.exe) 候选路径 */
const WPP_CANDIDATES = [
  'D:\\应用\\WPS Office\\WPS Office\\12.1.0.28043\\office6\\wpp.exe',
  'C:\\Program Files\\WPS Office\\WPS Office\\office6\\wpp.exe',
  'C:\\Program Files (x86)\\WPS Office\\WPS Office\\office6\\wpp.exe',
  join(process.env.LOCALAPPDATA || '', 'Kingsoft\\WPS Office\\office6\\wpp.exe'),
]

export interface KeyboardWorkflowResult {
  success: boolean
  savedPath?: string
  error?: string
}

/** 文件名非法字符清洗 */
function sanitizeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim() || '未命名演示'
}

/** 定位 wpp.exe（候选路径 → 注册表 App Paths） */
async function findWppPath(): Promise<string | null> {
  for (const p of WPP_CANDIDATES) {
    if (p && existsSync(p)) return p
  }
  try {
    const ps = "$v = Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\wpp.exe' -ErrorAction SilentlyContinue; if ($v) { $v.'(default)' }"
    const { stdout } = await execAsync(`"${process.env.SYSTEMROOT || 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -Command "${ps}"`, {
      timeout: 5000,
      windowsHide: true,
    })
    const p = stdout.trim()
    if (p && existsSync(p)) return p
  } catch (e) {
    logger.debug(`[PptFlow] 注册表查询 wpp.exe 失败: ${e}`)
  }
  return null
}

/** 激活 WPS 窗口（AppActivate，用于放映预览前置） */
async function focusWpsWindow(): Promise<boolean> {
  try {
    const ps = [
      "Add-Type -AssemblyName Microsoft.VisualBasic",
      "$p = Get-Process wpp,wps -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -ne '' } | Select-Object -First 1",
      "if ($p) { [Microsoft.VisualBasic.Interaction]::AppActivate($p.Id) | Out-Null; 'OK' } else { 'NONE' }",
    ].join('; ')
    const { stdout } = await execAsync(
      `"${process.env.SYSTEMROOT || 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -Command "${ps}"`,
      { timeout: 8000, windowsHide: true }
    )
    return stdout.includes('OK')
  } catch {
    return false
  }
}

/** 主题色板（电影质感深蓝金风格） */
const THEME = {
  primary: '0F2A5C', // 深藏蓝
  accent: 'D4A017',  // 金色
  dark: '1E293B',
  gray: '94A3B8',
  bg: 'F8FAFC',
  white: 'FFFFFF',
  soft: 'DBEAFE',
}

/** 用 pptxgenjs 生成演示文稿文件 */
async function generatePptx(outline: PptOutline, topic: string, targetPath: string): Promise<boolean> {
  const pptx = new PptxGenJS()
  pptx.layout = 'LAYOUT_WIDE' // 16:9
  pptx.author = '玄枢AI'
  pptx.title = outline.title
  pptx.subject = topic
  pptx.company = '玄枢AI'

  const fontFace = 'Microsoft YaHei'

  // 封面页
  const cover = pptx.addSlide()
  cover.background = { color: THEME.primary }
  cover.addText(outline.title, {
    x: 0.8, y: 1.5, w: 11.4, h: 1.7,
    fontSize: 42, bold: true, color: THEME.white,
    align: 'center', fontFace,
  })
  cover.addShape(pptx.ShapeType.line, { x: 3.6, y: 3.35, w: 5.8, h: 0.02, line: { color: THEME.accent, width: 2 } })
  cover.addText(topic, {
    x: 1.5, y: 3.7, w: 10, h: 1.0,
    fontSize: 22, color: THEME.soft, align: 'center', fontFace,
  })
  cover.addText('玄枢AI · 本地智能生成', {
    x: 1.5, y: 5.4, w: 10, h: 0.6,
    fontSize: 13, color: THEME.gray, align: 'center', fontFace,
  })

  // 内容页：标题 + 金色下划线 + 要点列表
  for (let i = 0; i < outline.slides.length; i++) {
    const slide = outline.slides[i]
    const s = pptx.addSlide()
    s.background = { color: THEME.bg }
    s.addText(`0${i + 1}`, {
      x: 0.6, y: 0.35, w: 1.2, h: 0.9,
      fontSize: 30, bold: true, color: THEME.accent, fontFace,
    })
    s.addText(slide.title, {
      x: 1.7, y: 0.4, w: 10.3, h: 0.9,
      fontSize: 28, bold: true, color: THEME.primary, fontFace,
    })
    s.addShape(pptx.ShapeType.rect, { x: 1.7, y: 1.35, w: 2.4, h: 0.07, fill: { color: THEME.accent } })
    s.addText(slide.bullets.join('\n'), {
      x: 0.8, y: 1.8, w: 11.4, h: 4.3,
      fontSize: 18, color: THEME.dark, fontFace,
      bullet: { code: '2022' },
      paraSpaceAfter: 16,
      lineSpacingMultiple: 1.35,
      valign: 'top',
    })
    s.addText(`第 ${i + 1} 页 / 共 ${outline.slides.length} 页`, {
      x: 8.8, y: 6.6, w: 3.2, h: 0.5,
      fontSize: 11, color: THEME.gray, align: 'right', fontFace,
    })
  }

  await pptx.writeFile({ fileName: targetPath })
  return existsSync(targetPath)
}

/**
 * 生成式演示工作流主入口：生成 pptx → WPS 打开 → 可选 F5 预览
 */
export async function runKeyboardWorkflow(
  outline: PptOutline,
  topic: string,
  preview: boolean
): Promise<KeyboardWorkflowResult> {
  try {
    // 1. 计算目标路径（去重）
    const docsDir = join(homedir(), 'Documents')
    const fileName = sanitizeFileName(outline.title)
    let target = join(docsDir, `${fileName}.pptx`)
    let suffix = 2
    while (existsSync(target)) {
      target = join(docsDir, `${fileName}-${suffix}.pptx`)
      suffix++
    }

    // 2. 生成 pptx 文件
    const ok = await generatePptx(outline, topic, target)
    if (!ok) {
      return { success: false, error: 'PPTX 文件生成失败' }
    }
    logger.info(`[PptFlow][Gen] 已生成演示文稿: ${target}`)

    // 3. 定位并启动 WPS 打开该文件
    const wppPath = await findWppPath()
    if (!wppPath) {
      return { success: false, error: '未找到 WPS 演示程序(wpp.exe)，请确认已安装 WPS Office' }
    }
    spawn(wppPath, [target], { detached: false, stdio: 'ignore' })
    logger.info(`[PptFlow][Gen] 已启动 WPS 打开: ${target}`)
    await sleep(4000)

    // 4. 放映预览
    if (preview) {
      const focused = await focusWpsWindow()
      if (focused) {
        await interactionExecutor.pressKeys('F5')
        await sleep(3000)
        await interactionExecutor.pressKeys('Escape')
      }
    }

    return { success: true, savedPath: target }
  } catch (e: any) {
    logger.error(`[PptFlow][Gen] 流程异常: ${e}`)
    return { success: false, error: String(e) }
  }
}
