/**
 * 控制电脑细粒度工具 — 把 visual-agent 的裸通道封装为 ReAct 工具
 *
 * 工具清单（均标 dangerous，执行前走人工确认门 / 白名单闸）：
 *   click_at / double_click_at / right_click_at / type_text / press_keys /
 *   drag_at / scroll_at / take_screenshot
 *
 * 与粗粒度 `control_computer`（视觉代理整任务）的关系：
 *   control_computer = 一次「截图→视觉识别→多步操作」的完整代理任务；
 *   本模块 = 单步原子操作，供智能体按需精确控制。
 *
 * @module main/agent/control-tools
 */

import { toolRegistry } from './tool-registry'
import { logger } from '../../shared/logger'
import { notifyControlStart, notifyControlFinish } from '../control-state'

/** 单步控制确认门：委托 visualAgent.confirmSingleAction（原生弹窗） */
async function confirmAction(label: string, detail: string): Promise<boolean> {
  try {
    const { visualAgent } = await import('../visual-agent')
    return await visualAgent.confirmSingleAction(label, detail)
  } catch (e) {
    logger.warn(`[ControlTools] 确认门异常，拒绝执行: ${e instanceof Error ? e.message : String(e)}`)
    return false
  }
}

/** 包装控制动作：开始/结束广播（驱动 overlay），异常统一收敛为失败结果 */
async function withControl<T>(
  detail: string,
  fn: () => Promise<T>,
): Promise<{ success: boolean; data?: T; error?: string }> {
  notifyControlStart(detail)
  try {
    const data = await fn()
    return { success: true, data }
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) }
  } finally {
    notifyControlFinish()
  }
}

/**
 * 注册控制电脑细粒度工具。
 * 由 modules.register 在启动时（registerAllTools 之后）调用。
 */
export function registerControlTools(): void {
  // ===== 鼠标点击 =====
  toolRegistry.register({
    name: 'click_at',
    description: '在屏幕指定坐标 (x, y) 单击鼠标左键。用于精确点击屏幕元素。',
    category: 'system',
    dangerous: true,
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number', description: '屏幕 X 坐标' },
        y: { type: 'number', description: '屏幕 Y 坐标' },
      },
      required: ['x', 'y'],
    },
    confirm: (p) => confirmAction('点击', `坐标 (${p.x}, ${p.y})`),
    execute: async (p) => {
      const x = Number(p.x)
      const y = Number(p.y)
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return { success: false, error: '坐标参数非法' }
      }
      return withControl(`点击坐标 (${x}, ${y})`, async () => {
        const { interactionExecutor } = await import('../visual-agent/interaction-executor')
        const ok = await interactionExecutor.clickAt(x, y)
        return ok ? { x, y } : { x, y, failed: true }
      })
    },
  })

  // ===== 双击 =====
  toolRegistry.register({
    name: 'double_click_at',
    description: '在屏幕指定坐标 (x, y) 双击鼠标左键。',
    category: 'system',
    dangerous: true,
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number', description: '屏幕 X 坐标' },
        y: { type: 'number', description: '屏幕 Y 坐标' },
      },
      required: ['x', 'y'],
    },
    confirm: (p) => confirmAction('双击', `坐标 (${p.x}, ${p.y})`),
    execute: async (p) => {
      const x = Number(p.x)
      const y = Number(p.y)
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return { success: false, error: '坐标参数非法' }
      }
      return withControl(`双击坐标 (${x}, ${y})`, async () => {
        const { interactionExecutor } = await import('../visual-agent/interaction-executor')
        const ok = await interactionExecutor.doubleClickAt(x, y)
        return ok ? { x, y } : { x, y, failed: true }
      })
    },
  })

  // ===== 右键 =====
  toolRegistry.register({
    name: 'right_click_at',
    description: '在屏幕指定坐标 (x, y) 单击鼠标右键（呼出上下文菜单）。',
    category: 'system',
    dangerous: true,
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number', description: '屏幕 X 坐标' },
        y: { type: 'number', description: '屏幕 Y 坐标' },
      },
      required: ['x', 'y'],
    },
    confirm: (p) => confirmAction('右键点击', `坐标 (${p.x}, ${p.y})`),
    execute: async (p) => {
      const x = Number(p.x)
      const y = Number(p.y)
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return { success: false, error: '坐标参数非法' }
      }
      return withControl(`右键点击坐标 (${x}, ${y})`, async () => {
        const { interactionExecutor } = await import('../visual-agent/interaction-executor')
        const ok = await interactionExecutor.rightClickAt(x, y)
        return ok ? { x, y } : { x, y, failed: true }
      })
    },
  })

  // ===== 键盘输入 =====
  toolRegistry.register({
    name: 'type_text',
    description: '在当前焦点输入框输入文本（模拟键盘逐字输入）。',
    category: 'system',
    dangerous: true,
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要输入的文本' },
      },
      required: ['text'],
    },
    confirm: (p) => confirmAction('键盘输入', `文本：${String(p.text || '').slice(0, 40)}`),
    execute: async (p) => {
      const text = String(p.text || '')
      if (!text) return { success: false, error: '文本不能为空' }
      return withControl(`输入文本（${text.length} 字符）`, async () => {
        const { interactionExecutor } = await import('../visual-agent/interaction-executor')
        const ok = await interactionExecutor.typeText(text)
        return ok ? { length: text.length } : { length: text.length, failed: true }
      })
    },
  })

  // ===== 快捷键 =====
  toolRegistry.register({
    name: 'press_keys',
    description: '发送按键组合（如 ctrl+c、alt+f4、enter 等）。',
    category: 'system',
    dangerous: true,
    parameters: {
      type: 'object',
      properties: {
        keys: { type: 'string', description: '按键组合，如 "ctrl+c" / "enter" / "alt+f4"' },
      },
      required: ['keys'],
    },
    confirm: (p) => confirmAction('发送按键', `按键：${String(p.keys || '')}`),
    execute: async (p) => {
      const keys = String(p.keys || '')
      if (!keys) return { success: false, error: '按键不能为空' }
      return withControl(`发送按键 ${keys}`, async () => {
        const { interactionExecutor } = await import('../visual-agent/interaction-executor')
        const ok = await interactionExecutor.pressKeys(keys)
        return ok ? { keys } : { keys, failed: true }
      })
    },
  })

  // ===== 拖拽 =====
  toolRegistry.register({
    name: 'drag_at',
    description: '从 (fromX, fromY) 拖拽到 (toX, toY)。',
    category: 'system',
    dangerous: true,
    parameters: {
      type: 'object',
      properties: {
        fromX: { type: 'number', description: '起点 X 坐标' },
        fromY: { type: 'number', description: '起点 Y 坐标' },
        toX: { type: 'number', description: '终点 X 坐标' },
        toY: { type: 'number', description: '终点 Y 坐标' },
      },
      required: ['fromX', 'fromY', 'toX', 'toY'],
    },
    confirm: (p) => confirmAction('拖拽', `(${p.fromX}, ${p.fromY}) → (${p.toX}, ${p.toY})`),
    execute: async (p) => {
      const fromX = Number(p.fromX)
      const fromY = Number(p.fromY)
      const toX = Number(p.toX)
      const toY = Number(p.toY)
      if ([fromX, fromY, toX, toY].some((v) => !Number.isFinite(v))) {
        return { success: false, error: '坐标参数非法' }
      }
      return withControl(`拖拽 (${fromX}, ${fromY}) → (${toX}, ${toY})`, async () => {
        const { interactionExecutor } = await import('../visual-agent/interaction-executor')
        const ok = await interactionExecutor.drag({ x: fromX, y: fromY }, { x: toX, y: toY })
        return ok ? { fromX, fromY, toX, toY } : { fromX, fromY, toX, toY, failed: true }
      })
    },
  })

  // ===== 滚动 =====
  toolRegistry.register({
    name: 'scroll_at',
    description: '在 (x, y) 处滚动鼠标滚轮，delta 为正向下、负向上。',
    category: 'system',
    dangerous: true,
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number', description: '屏幕 X 坐标' },
        y: { type: 'number', description: '屏幕 Y 坐标' },
        delta: { type: 'number', description: '滚动增量（正下负上）' },
      },
      required: ['x', 'y', 'delta'],
    },
    confirm: (p) => confirmAction('滚动', `坐标 (${p.x}, ${p.y}) 增量 ${p.delta}`),
    execute: async (p) => {
      const x = Number(p.x)
      const y = Number(p.y)
      const delta = Number(p.delta)
      if ([x, y, delta].some((v) => !Number.isFinite(v))) {
        return { success: false, error: '参数非法' }
      }
      return withControl(`滚动 (${x}, ${y}) 增量 ${delta}`, async () => {
        const { interactionExecutor } = await import('../visual-agent/interaction-executor')
        const ok = await interactionExecutor.scrollAt(x, y, delta)
        return ok ? { x, y, delta } : { x, y, delta, failed: true }
      })
    },
  })

  // ===== 截图（非破坏性，只返回元信息，避免把 base64 塞进上下文） =====
  toolRegistry.register({
    name: 'take_screenshot',
    description: '截取当前全屏，返回截图尺寸与时间戳（不含图片数据，用于确认屏幕状态）。',
    category: 'system',
    dangerous: false,
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async () => {
      return withControl('截取屏幕', async () => {
        const { screenObserver } = await import('../visual-agent/screen-observer')
        const shot = await screenObserver.captureFullScreen()
        return { width: shot.width, height: shot.height, timestamp: shot.timestamp, source: shot.source }
      })
    },
  })

  logger.info(`[ControlTools] 已注册 ${8} 个细粒度控制工具`)
}
