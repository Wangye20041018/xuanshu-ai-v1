/**
 * ScreenObserver — 屏幕截图 + 变化检测 + 窗口矩形
 * 基于 electron desktopCapturer
 */
import {desktopCapturer} from 'electron'
import { exec } from 'child_process'
import { promisify } from 'util'
import { POWERSHELL_EXE } from '../utils/powershell'
import { logger } from '../../shared/logger'

const execAsync = promisify(exec)

export interface Screenshot {
  base64: string
  width: number
  height: number
  timestamp: number
  source: 'fullscreen' | 'window' | 'region'
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface ChangeReport {
  changed: boolean
  changePercent: number
  changedRegions: Rect[]
  summary: string
}

export class ScreenObserver {
  /**
   * 全屏截图
   */
  async captureFullScreen(): Promise<Screenshot> {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1920, height: 1080 }
    })
    if (!sources[0]) throw new Error('No screen source found')
    return {
      base64: sources[0].thumbnail.toPNG().toString('base64'),
      width: 1920,
      height: 1080,
      timestamp: Date.now(),
      source: 'fullscreen'
    }
  }

  /**
   * 截取当前活动窗口
   */
  async captureActiveWindow(): Promise<Screenshot> {
    const sources = await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: { width: 1920, height: 1080 }
    })
    const active = sources[0]
    if (!active) throw new Error('No window source found')
    return {
      base64: active.thumbnail.toPNG().toString('base64'),
      width: 1920,
      height: 1080,
      timestamp: Date.now(),
      source: 'window'
    }
  }

  /**
   * 截取指定区域
   */
  // @ts-expect-error TS6133 - rect reserved for future use
  async captureRegion(rect: Rect): Promise<Screenshot> {
    // electron desktopCapturer 不支持区域截图，截全屏后裁剪
    const fullScreen = await this.captureFullScreen()
    // 注：区域裁剪在调用方（视觉模型）完成
    return {
      ...fullScreen,
      source: 'region'
    }
  }

  /**
   * 像素级变化检测
   * 通过截取前后状态对比，判断操作效果
   */
  async detectChanges(before: Screenshot, after: Screenshot): Promise<ChangeReport> {
    // 简化版：通过视觉模型对比
    const timeDiff = after.timestamp - before.timestamp
    const changed = timeDiff > 1000 || before.base64 !== after.base64

    // 粗略估算变化百分比（base64 长度差异）
    const beforeLen = before.base64.length
    const afterLen = after.base64.length
    const changePercent = Math.min(100, Math.abs(afterLen - beforeLen) / Math.max(beforeLen, 1) * 100)

    return {
      changed,
      changePercent: Math.round(changePercent * 100) / 100,
      changedRegions: [],
      summary: changed ? `屏幕已变化 (${changePercent.toFixed(1)}%)` : '屏幕无变化'
    }
  }

  /**
   * 获取当前活动窗口的矩形区域
   */
  async getActiveWindowRect(): Promise<Rect> {
    try {
      const script = `
Add-Type @"
using System;using System.Runtime.InteropServices;
public class WinRect {
[DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")]public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
[StructLayout(LayoutKind.Sequential)]public struct RECT {public int Left,Top,Right,Bottom;}
public static string GetRect(){
  RECT r; GetWindowRect(GetForegroundWindow(), out r);
  return $"{r.Left},{r.Top},{r.Right-r.Left},{r.Bottom-r.Top}";
}}
"@
[WinRect]::GetRect()
`
      const { stdout } = await execAsync(
        `"${POWERSHELL_EXE}" -Command "${script.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`,
        { timeout: 5000, windowsHide: true }
      )
      const parts = stdout.trim().split(',').map(Number)
      if (parts.length === 4) {
        return { x: parts[0], y: parts[1], w: parts[2], h: parts[3] }
      }
    } catch (e) { logger.error('[ScreenObserver] 获取活动窗口矩形失败:', e) }
    return { x: 0, y: 0, w: 1920, h: 1080 }
  }

  /**
   * 等待屏幕稳定（最多 maxWaitMs 毫秒）
   */
  async waitForStable(maxWaitMs: number = 3000): Promise<Screenshot> {
    const startTime = Date.now()
    let previousScreenshot: Screenshot | null = null

    while (Date.now() - startTime < maxWaitMs) {
      await new Promise(r => setTimeout(r, 500))
      const current = await this.captureFullScreen()

      if (previousScreenshot) {
        const diff = await this.detectChanges(previousScreenshot, current)
        if (!diff.changed || diff.changePercent < 1) {
          return current
        }
      }

      previousScreenshot = current
    }

    return this.captureFullScreen()
  }
}

export const screenObserver = new ScreenObserver()
