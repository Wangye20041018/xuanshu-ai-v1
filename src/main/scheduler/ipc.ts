/**
 * 智能模型调度系统 — IPC 注册
 *
 * 渲染层「模型调度面板」与调度中枢之间的桥接。
 * 遵循 IPC 三方闭环：preload 白名单(IpcChannels) + 本文件 handler + 渲染层调用。
 *
 * 通道清单：
 * - scheduler:classify       任务识别（纯识别，不执行）
 * - scheduler:decide         调度决策（选模型+计算分层，不加载）
 * - scheduler:run            完整调度（识别→选模型→加载→推理→回退）
 * - scheduler:get-history    调度记录列表
 * - scheduler:clear-history  清空调度记录
 * - scheduler:get-profiles   模型画像列表
 * - scheduler:update-profile 更新单个画像
 * - scheduler:reset-profiles 重置画像为默认
 * - scheduler:get-config     读取调度配置
 * - scheduler:set-config     更新调度配置
 * - scheduler:get-status     聚合状态（UI 首屏加载用）
 *
 * 返回契约：所有 handler 一律返回「裸数据」（成功时直接 return 数据，失败时 throw）。
 * preload 的 invokeSafe 已统一包装 { ok, data? , error? }，主进程不得再套一层
 * { ok, data }，否则渲染层 res.data 会拿到嵌套对象导致 undefined 崩溃。
 *
 * @module scheduler/ipc
 */

import { ipcMain } from 'electron'
import { logger } from '../../shared/logger'
import { scheduler } from './index'
import { profileManager } from './profiles'
import type { ModelProfile, SchedulerTaskType } from './types'

export function setupSchedulerHandlers(): void {
  /* ---- 任务识别（纯识别）---- */
  ipcMain.handle('scheduler:classify', (_e, text: string) => {
    try {
      return scheduler.classify(String(text || ''))
    } catch (err: any) {
      throw new Error(err?.message || 'scheduler:classify 失败')
    }
  })

  /* ---- 调度决策（选模型 + 分层计算，不加载）---- */
  ipcMain.handle('scheduler:decide', async (_e, text: string, taskType?: SchedulerTaskType) => {
    try {
      return await scheduler.decide(String(text || ''), taskType)
    } catch (err: any) {
      throw new Error(err?.message || 'scheduler:decide 失败')
    }
  })

  /* ---- 完整调度（识别→选模型→加载→推理→回退）---- */
  ipcMain.handle('scheduler:run', async (_e, text: string, opts?: { taskType?: SchedulerTaskType; temperature?: number; maxTokens?: number }) => {
    try {
      return await scheduler.run(String(text || ''), opts)
    } catch (err: any) {
      throw new Error(err?.message || 'scheduler:run 失败')
    }
  })

  /* ---- 调度记录 ---- */
  ipcMain.handle('scheduler:get-history', () => {
    try {
      return scheduler.getHistory()
    } catch (err: any) {
      throw new Error(err?.message || 'scheduler:get-history 失败')
    }
  })

  ipcMain.handle('scheduler:clear-history', () => {
    try {
      scheduler.clearHistory()
      return true
    } catch (err: any) {
      throw new Error(err?.message || 'scheduler:clear-history 失败')
    }
  })

  /* ---- 模型画像 ---- */
  ipcMain.handle('scheduler:get-profiles', (): ModelProfile[] => {
    try {
      profileManager.invalidate()
      return profileManager.list()
    } catch (err: any) {
      throw new Error(err?.message || 'scheduler:get-profiles 失败')
    }
  })

  ipcMain.handle('scheduler:update-profile', (_e, id: string, patch: Partial<Omit<ModelProfile, 'id'>>): ModelProfile => {
    try {
      const result = profileManager.update(String(id), patch || {})
      if (!result.success) throw new Error(result.error || '画像更新失败')
      return result.profile as ModelProfile
    } catch (err: any) {
      throw new Error(err?.message || 'scheduler:update-profile 失败')
    }
  })

  ipcMain.handle('scheduler:reset-profiles', (): ModelProfile[] => {
    try {
      profileManager.reset()
      return profileManager.list()
    } catch (err: any) {
      throw new Error(err?.message || 'scheduler:reset-profiles 失败')
    }
  })

  /* ---- 调度配置 ---- */
  ipcMain.handle('scheduler:get-config', () => {
    try {
      scheduler.loadConfig()
      return scheduler.getConfig()
    } catch (err: any) {
      throw new Error(err?.message || 'scheduler:get-config 失败')
    }
  })

  ipcMain.handle('scheduler:set-config', async (_e, patch: Record<string, unknown>) => {
    try {
      return await scheduler.setConfig(patch || {})
    } catch (err: any) {
      throw new Error(err?.message || 'scheduler:set-config 失败')
    }
  })

  /* ---- 聚合状态（UI 首屏）---- */
  ipcMain.handle('scheduler:get-status', () => {
    try {
      scheduler.loadConfig()
      return {
        config: scheduler.getConfig(),
        history: scheduler.getHistory(),
        profiles: profileManager.list(),
      }
    } catch (err: any) {
      throw new Error(err?.message || 'scheduler:get-status 失败')
    }
  })

  logger.info('[Scheduler] IPC handlers registered')
}
