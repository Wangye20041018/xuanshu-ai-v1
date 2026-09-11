/**
 * UIA 定位层（v10.2，P1-2）—— 主入口
 *
 * 高层封装：按文本/automationId 查找标准控件并返回屏幕中心坐标。
 * 作为电脑操控的【首选】路径（零显存）：命中标准控件即直接拿坐标执行点击/输入；
 * 未命中（小众软件/游戏/UWP）由调用方回退视觉识别（接 VL-7B / Qwen2-VL-2B 视觉）。
 */

import { ipcMain } from 'electron'
import { uiaLocate, UIAControl, UIACriteria } from './locator'

class UIALocator {
  /**
   * 按控件文本（名称）模糊查找控件
   */
  async findControlByText(text: string): Promise<UIAControl | null> {
    if (!text) return null
    return uiaLocate({ partialText: text })
  }

  /**
   * 按控件名称精确查找
   */
  async findControlByName(name: string): Promise<UIAControl | null> {
    if (!name) return null
    return uiaLocate({ name })
  }

  /**
   * 按 AutomationId 查找（最稳定，ID 通常唯一）
   */
  async findControlById(automationId: string): Promise<UIAControl | null> {
    if (!automationId) return null
    return uiaLocate({ automationId })
  }

  /**
   * 按控件类型查找（如 Button / Edit / ComboBox）
   */
  async findControlByType(controlType: string): Promise<UIAControl | null> {
    if (!controlType) return null
    return uiaLocate({ controlType })
  }

  /**
   * 通用查找（任意条件）
   */
  async locate(criteria: UIACriteria): Promise<UIAControl | null> {
    return uiaLocate(criteria)
  }
}

export const uiaLocator = new UIALocator()

/**
 * 注册 UIA IPC 通道（命名空间 uia:*，见架构 §10 对齐点）
 */
export function setupUIAHandlers(): void {
  ipcMain.handle('uia:locate', async (_e, criteria: UIACriteria) => {
    try {
      return await uiaLocator.locate(criteria || {})
    } catch {
      return null
    }
  })
  ipcMain.handle('uia:find-text', async (_e, text: string) => {
    try {
      return await uiaLocator.findControlByText(text || '')
    } catch {
      return null
    }
  })
}
