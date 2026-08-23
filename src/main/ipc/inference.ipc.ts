/* ============================================================
 * 推理引擎 IPC — GPU 检测 + CPU 推理回退 + 角色推理设备配置
 * ============================================================ */

import { ipcMain } from 'electron'
import { isGpuAvailable, cpuInferenceEngine } from '../inference/cpu-engine'
import { logger } from '../../shared/logger'


export function setupInferenceHandlers(): void {
  /* ------ GPU 状态检测 ------ */
  ipcMain.handle('inference:gpu-status', async () => {
    try {
      return await isGpuAvailable()
    } catch (e) {
      logger.error('inference:gpu-status 内部错误:', e)
      return { available: false, vramMB: 0, reason: 'GPU检测遇到内部错误' }
    }
  })

  /* ------ CPU 推理：加载模型 ------ */
  ipcMain.handle('inference:cpu-load', async (_event, modelPath: string) => {
    try {
      return await cpuInferenceEngine.loadModel({ modelPath })
    } catch (e: any) {
      return { success: false, error: 'CPU 推理引擎内部错误' }
    }
  })

  /* ------ CPU 推理：生成文本 ------ */
  ipcMain.handle('inference:cpu-generate', async (_event, prompt: string, options?: { maxTokens?: number; temperature?: number }) => {
    // 输入校验：prompt 长度限制
    if (typeof prompt !== 'string' || prompt.length > 131072) {
      return { success: false, error: 'Prompt 不能超过 128KB' }
    }
    try {
      const result = await cpuInferenceEngine.generate(prompt, options)
      return { success: true, text: result }
    } catch (e: any) {
      return { success: false, error: 'CPU 推理引擎内部错误' }
    }
  })

  /* ------ CPU 推理：卸载模型 ------ */
  ipcMain.handle('inference:cpu-unload', async () => {
    try {
      await cpuInferenceEngine.unload()
      return { success: true }
    } catch (e: any) {
      return { success: false, error: 'CPU 推理引擎内部错误' }
    }
  })




}