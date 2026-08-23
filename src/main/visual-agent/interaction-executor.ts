/**
 * InteractionExecutor — 鼠标/键盘模拟
 * 使用 user32.dll P/Invoke + PowerShell SendKeys
 */
import { exec } from 'child_process'
import { promisify } from 'util'
import {clipboard} from 'electron'
import { logger } from '../../shared/logger'
import { POWERSHELL_EXE } from '../utils/powershell'

const execAsync = promisify(exec)

export type MouseButton = 'left' | 'right' | 'middle'

export interface Point {
  x: number
  y: number
}

export interface ElementCondition {
  type?: string
  labelPattern?: string
  timeout?: number
}

export class InteractionExecutor {
  /**
   * 左键点击指定坐标
   */
  async clickAt(x: number, y: number, button: MouseButton = 'left'): Promise<boolean> {
    try {
      const ps = this.buildClickScript(x, y, button)
      await execAsync(`"${POWERSHELL_EXE}" -NoProfile -Command "${ps}"`, { timeout: 5000, windowsHide: true })
      await this.delay(100)
      return true
    } catch (e: any) {
      logger.error(`[Interaction] clickAt(${x},${y}) failed:`, e.message)
      return false
    }
  }

  /**
   * 双击
   */
  async doubleClickAt(x: number, y: number): Promise<boolean> {
    await this.clickAt(x, y)
    await this.delay(50)
    return await this.clickAt(x, y)
  }

  /**
   * 右键点击
   */
  async rightClickAt(x: number, y: number): Promise<boolean> {
    return await this.clickAt(x, y, 'right')
  }

  /**
   * 拖拽
   */
  async drag(from: Point, to: Point): Promise<boolean> {
    try {
      const ps = this.buildDragScript(from.x, from.y, to.x, to.y)
      await execAsync(`"${POWERSHELL_EXE}" -NoProfile -Command "${ps}"`, { timeout: 10000, windowsHide: true })
      return true
    } catch (e) {
      logger.error('[InteractionExecutor] 拖拽操作失败:', e)
      return false
    }
  }

  /**
   * 滚动
   */
  async scrollAt(x: number, y: number, delta: number): Promise<boolean> {
    try {
      const ps = this.buildScrollScript(x, y, delta)
      await execAsync(`"${POWERSHELL_EXE}" -NoProfile -Command "${ps}"`, { timeout: 5000, windowsHide: true })
      return true
    } catch (e) {
      logger.error('[InteractionExecutor] 滚动操作失败:', e)
      return false
    }
  }

  /**
   * 输入文本（使用 SendKeys）
   *
   * SECURITY: 文本经 Base64 编码后传入 PowerShell 再解码，
   * 任意字符（含 `"` `'` `$` `%` 换行等）都无法突破外层 -Command 引号注入命令。
   */
  async typeText(text: string): Promise<boolean> {
    try {
      // 转义 SendKeys 特殊字符（仅影响 SendKeys 语义，不涉及命令注入）
      const escaped = text
        .replace(/\+/g, '{+}')
        .replace(/\^/g, '{^}')
        .replace(/\%/g, '{%}')
        .replace(/\~/g, '{~}')
        .replace(/\(/g, '{(}')
        .replace(/\)/g, '{)}')
        .replace(/\{/g, '{{}')
        .replace(/\}/g, '{}}')

      await this.sendKeysEncoded(escaped)
      return true
    } catch (e) {
      logger.error('[InteractionExecutor] 文本输入失败:', e)
      return false
    }
  }

  /**
   * 按快捷键
   */
  async pressKeys(keys: string): Promise<boolean> {
    try {
      // 转换常见快捷键格式
      const sendKeysFormat = keys
        .replace(/Ctrl\+/g, '^')
        .replace(/Alt\+/g, '%')
        .replace(/Shift\+/g, '+')
        .replace(/Win\+/g, '({LWIN})')
        .replace(/Enter/g, '{ENTER}')
        .replace(/Escape/g, '{ESC}')
        .replace(/Tab/g, '{TAB}')
        .replace(/Space/g, ' ')
        .replace(/Delete/g, '{DELETE}')
        .replace(/Backspace/g, '{BS}')
        .replace(/F1/g, '{F1}')
        .replace(/F2/g, '{F2}')
        .replace(/F3/g, '{F3}')
        .replace(/F4/g, '{F4}')
        .replace(/F5/g, '{F5}')
        .replace(/F6/g, '{F6}')
        .replace(/F7/g, '{F7}')
        .replace(/F8/g, '{F8}')
        .replace(/F9/g, '{F9}')
        .replace(/F10/g, '{F10}')
        .replace(/F11/g, '{F11}')
        .replace(/F12/g, '{F12}')
        .replace(/Left/g, '{LEFT}')
        .replace(/Right/g, '{RIGHT}')
        .replace(/Up/g, '{UP}')
        .replace(/Down/g, '{DOWN}')
        .replace(/PageUp/g, '{PGUP}')
        .replace(/PageDown/g, '{PGDN}')
        .replace(/Home/g, '{HOME}')
        .replace(/End/g, '{END}')
        .replace(/PrintScreen/g, '{PRTSC}')
        .replace(/VolumeUp/g, '{VOLUME_UP}')
        .replace(/VolumeDown/g, '{VOLUME_DOWN}')
        .replace(/BrightnessUp/g, '{BRIGHTNESS_UP}')
        .replace(/BrightnessDown/g, '{BRIGHTNESS_DOWN}')

      await this.sendKeysEncoded(sendKeysFormat)
      await this.delay(200)
      return true
    } catch (e) {
      logger.error('[InteractionExecutor] 按键操作失败:', e)
      return false
    }
  }

  /**
   * 通过 Base64 传递 SendKeys 文本，避免命令注入。
   * PowerShell 侧：-EncodedCommand 或解码后调用 SendWait。
   */
  private async sendKeysEncoded(sendKeys: string): Promise<void> {
    const encoded = Buffer.from(sendKeys, 'utf8').toString('base64')
    // 使用 -EncodedCommand 执行 UTF-16LE Base64 脚本（PowerShell 原生要求），
    // 避免文本中的任何字符进入命令行参数解析。
    const script = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait([System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${encoded}')))`
    const encodedCommand = Buffer.from(script, 'utf16le').toString('base64')
    await execAsync(`"${POWERSHELL_EXE}" -NoProfile -EncodedCommand "${encodedCommand}"`, { timeout: 5000, windowsHide: true })
  }

  /**
   * 读取剪贴板
   */
  async clipboardRead(): Promise<string> {
    try {
      return clipboard.readText()
    } catch (e) {
      logger.error('[InteractionExecutor] 剪贴板读取失败:', e)
      return ''
    }
  }

  /**
   * 写入剪贴板
   */
  async clipboardWrite(text: string): Promise<boolean> {
    try {
      clipboard.writeText(text)
      return true
    } catch (e) {
      logger.error('[InteractionExecutor] 剪贴板写入失败:', e)
      return false
    }
  }

  /**
   * 等待元素出现（轮询截图+识别）
   */
  async waitForElement(
    condition: ElementCondition,
    timeout: number,
    captureFn: () => Promise<string>,
    recognizeFn: (base64: string) => Promise<Array<{ type: string; label: string; confidence: number }>>
  ): Promise<{ type: string; label: string; confidence: number } | null> {
    const startTime = Date.now()

    while (Date.now() - startTime < timeout) {
      try {
        const base64 = await captureFn()
        const elements = await recognizeFn(base64)

        for (const el of elements) {
          if (condition.type && el.type !== condition.type) continue
          if (condition.labelPattern) {
            const patterns = condition.labelPattern.split('|')
            if (!patterns.some(p => el.label.toLowerCase().includes(p.trim().toLowerCase()))) continue
          }
          return el
        }
      } catch (e) { logger.error('[InteractionExecutor] 等待元素检测失败:', e) }

      await this.delay(1000)
    }

    return null
  }

  /* ---------- 内部实现 ---------- */

  private buildClickScript(x: number, y: number, button: MouseButton): string {
    const btnFlag = button === 'right' ? '0x0008 | 0x0010' : button === 'middle' ? '0x0020 | 0x0040' : '0x0002 | 0x0004'
    return `
Add-Type -TypeDefinition @'
using System;using System.Runtime.InteropServices;
public class MouseOps{
[DllImport("user32.dll")]public static extern bool SetCursorPos(int x,int y);
[DllImport("user32.dll")]public static extern void mouse_event(uint dwFlags,int dx,int dy,uint dwData,int dwExtraInfo);
public static void Click(int x,int y,uint downFlag,uint upFlag){
SetCursorPos(x,y);System.Threading.Thread.Sleep(10);
mouse_event(downFlag,0,0,0,0);System.Threading.Thread.Sleep(15);
mouse_event(upFlag,0,0,0,0);System.Threading.Thread.Sleep(10);
}
}
'@
[MouseOps]::Click(${x},${y},${btnFlag.split('|')[0].trim()},${btnFlag.split('|')[1]?.trim() || btnFlag.split('|')[0].trim()})
`
  }

  private buildDragScript(x1: number, y1: number, x2: number, y2: number): string {
    const steps = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1), 1)
    const stepX = (x2 - x1) / steps
    const stepY = (y2 - y1) / steps

    return `
Add-Type -TypeDefinition @'
using System;using System.Runtime.InteropServices;
public class DragOps{
[DllImport("user32.dll")]public static extern bool SetCursorPos(int x,int y);
[DllImport("user32.dll")]public static extern void mouse_event(uint dwFlags,int dx,int dy,uint dwData,int dwExtraInfo);
public static void Drag(int x,int y){SetCursorPos(x,y);mouse_event(0x0002,0,0,0,0);}
public static void Release(int x,int y){SetCursorPos(x,y);mouse_event(0x0004,0,0,0,0);}
}
'@
[DragOps]::Drag(${x1},${y1})
@(1..${steps}) | ForEach-Object {
  $i = $_
  $cx = [int](${x1} + ${stepX} * $i)
  $cy = [int](${y1} + ${stepY} * $i)
  [DragOps]::Drag($cx,$cy)
  Start-Sleep -Milliseconds 5
}
[DragOps]::Release(${x2},${y2})
`
  }

  private buildScrollScript(x: number, y: number, delta: number): string {
    // @ts-expect-error TS6133 - direction reserved for future use
    const direction = delta > 0 ? 0x0800 : -0x0800 // WHEEL_DELTA
    const absDelta = Math.abs(delta)
    return `
Add-Type -TypeDefinition @'
using System;using System.Runtime.InteropServices;
public class ScrollOps{
[DllImport("user32.dll")]public static extern bool SetCursorPos(int x,int y);
[DllImport("user32.dll")]public static extern void mouse_event(uint dwFlags,int dx,int dy,uint dwData,int dwExtraInfo);
public static void Scroll(int x,int y,int delta){
SetCursorPos(x,y);System.Threading.Thread.Sleep(10);
mouse_event(0x0800,0,0,(uint)delta,0);
}
}
'@
[ScrollOps]::Scroll(${x},${y},${absDelta})
`
  }

  /**
   * 执行AI引擎的动作决策（通用入口）
   */
  async execute(decision: { action: string; target?: { x: number; y: number }; text?: string; keys?: string; duration?: number }): Promise<boolean> {
    logger.debug(`[InteractionExecutor] 执行: ${decision.action}`, decision.target ? `坐标(${decision.target.x},${decision.target.y})` : '')
    switch (decision.action) {
      case 'click':
      case 'right_click':
      case 'double_click': {
        if (decision.target) {
          if (decision.action === 'click') return await this.clickAt(decision.target.x, decision.target.y)
          if (decision.action === 'right_click') return await this.rightClickAt(decision.target.x, decision.target.y)
          if (decision.action === 'double_click') return await this.doubleClickAt(decision.target.x, decision.target.y)
        }
        return false
      }
      case 'type': {
        if (decision.text) return await this.typeText(decision.text)
        return false
      }
      case 'press_keys': {
        if (decision.keys) return await this.pressKeys(decision.keys)
        return false
      }
      case 'scroll': {
        if (decision.target && decision.duration) {
          return await this.scrollAt(decision.target.x, decision.target.y, decision.duration)
        }
        return false
      }
      case 'drag': {
        if (decision.target) {
          return await this.drag(
            { x: decision.target.x, y: decision.target.y },
            { x: decision.target.x + 100, y: decision.target.y + 100 }
          )
        }
        return false
      }
      case 'wait': {
        await this.delay(decision.duration || 1000)
        return true
      }
      case 'screenshot':
      case 'done':
      case 'retry':
        return true
      default:
        await this.delay(500)
        return true
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }
}

export const interactionExecutor = new InteractionExecutor()
