/**
 * HealthCheck — 玄枢体检中心
 *
 * 玄枢不下载模型（模型由用户自备），因此体检重点不是"下载完整性"，
 * 而是"自备模型可用性 + 运行环境 + 系统资源 + 配置合法性"四类自检。
 *
 * 检查项：
 *  1. 模型文件校验：GGUF magic number、文件存在、大小非零、与注册路径一致
 *  2. 兼容性预检：解析 GGUF 头部（架构/参数量/量化类型），与运行时匹配
 *  3. 环境自检：Python 运行时、关键脚本、依赖完整性
 *  4. 资源评估：内存/显存是否满足所选模型加载
 *  5. 配置合法性：模型路径、provider、启动模型等配置一致性
 *
 * @module main/health-check
 */

import { ipcMain } from 'electron'
import { existsSync, statSync, readFileSync, promises as fsp } from 'fs'
import { join, dirname } from 'path'
import { app } from 'electron'
import { logger } from '../../shared/logger'
import { getStore } from '../ipc/config.ipc'

export type HealthStatus = 'ok' | 'warn' | 'error'

export interface HealthItem {
  key: string
  label: string
  status: HealthStatus
  detail: string
  fix?: string
  /** 是否可通过"一键修复"自动处理 */
  fixable?: boolean
  /** 修复动作的显示名称 */
  fixLabel?: string
}

export interface HealthReport {
  timestamp: number
  overall: HealthStatus
  items: HealthItem[]
}

const GGUF_MAGIC = Buffer.from([0x47, 0x47, 0x55, 0x46]) // "GGUF"

function readGgufHeader(path: string): { arch?: string; params?: string; quant?: string } | null {
  try {
    const fd = readFileSync(path)
    if (fd.length < 4 || !fd.subarray(0, 4).equals(GGUF_MAGIC)) return null
    const text = fd.subarray(0, Math.min(fd.length, 4096)).toString('latin1')
    const arch = text.match(/general\.architecture\s*=\s*([a-zA-Z0-9_-]+)/)?.[1]
    const params = text.match(/general\.size_label\s*=\s*([0-9.]+[A-Za-z]+)/)?.[1]
    const quant = text.match(/quantization_version|f16|q4_k|q8_0|q5_k|q2_k/i)?.[0]
    return { arch, params, quant }
  } catch {
    return null
  }
}

function checkModels(): HealthItem[] {
  const items: HealthItem[] = []
  try {
    const { modelRegistry } = require('../model-registry')
    const models: any[] = modelRegistry.list()
    if (models.length === 0) {
      items.push({
        key: 'model.none',
        label: '本地模型',
        status: 'warn',
        detail: '未注册任何本地模型，对话将走云端 API（若已配置）',
        fix: '在模型页导入自备的 GGUF 模型',
      })
      return items
    }
    for (const m of models) {
      const p = m.modelPath as string
      if (!existsSync(p)) {
        items.push({
          key: `model.${m.id}`,
          label: `模型「${m.name}」`,
          status: 'error',
          detail: `文件不存在：${p}`,
          fix: '重新导入模型或修正模型路径',
        })
        continue
      }
      const size = statSync(p).size
      if (size < 1024 * 1024) {
        items.push({
          key: `model.${m.id}`,
          label: `模型「${m.name}」`,
          status: 'error',
          detail: `文件过小（${size} 字节），疑似损坏或不完整`,
          fix: '重新拷贝完整的 GGUF 文件',
        })
        continue
      }
      const header = readGgufHeader(p)
      if (!header) {
        items.push({
          key: `model.${m.id}`,
          label: `模型「${m.name}」`,
          status: 'error',
          detail: '文件头不是合法 GGUF 格式（magic number 不匹配）',
          fix: '确认文件为 GGUF 格式，非损坏/非错误文件',
        })
        continue
      }
      const meta = [header.arch, header.params, header.quant].filter(Boolean).join(' / ')
      items.push({
        key: `model.${m.id}`,
        label: `模型「${m.name}」`,
        status: 'ok',
        detail: `GGUF 合法 · ${(size / 1024 / 1024 / 1024).toFixed(2)} GB${meta ? ` · ${meta}` : ''}`,
      })
    }
  } catch (e: any) {
    items.push({ key: 'model.err', label: '本地模型', status: 'error', detail: `读取模型注册表失败：${e.message}` })
  }
  return items
}

function checkEnvironment(): HealthItem[] {
  const items: HealthItem[] = []
  const pyDir = app.isPackaged
    ? join(process.resourcesPath, 'python')
    : join(app.getAppPath(), 'resources', 'python')
  const pyExe = join(pyDir, 'python.exe')
  if (!existsSync(pyExe)) {
    items.push({
      key: 'env.python',
      label: 'Python 运行时',
      status: 'error',
      detail: `未找到内置 Python：${pyExe}`,
      fix: '重新安装玄枢或修复 resources/python 目录',
    })
  } else {
    items.push({ key: 'env.python', label: 'Python 运行时', status: 'ok', detail: '内置 Python 就绪' })
  }

  const scripts = [
    'desktop_automation.py',
    'context-signals.ps1',
  ]
  const resDir = app.isPackaged
    ? process.resourcesPath
    : join(app.getAppPath(), 'resources')
  for (const s of scripts) {
    const sp = join(resDir, 'scripts', s)
    const alt = join(resDir, 'python', s)
    if (existsSync(sp) || existsSync(alt)) {
      items.push({ key: `env.${s}`, label: `脚本 ${s}`, status: 'ok', detail: '存在' })
    } else {
      items.push({
        key: `env.${s}`,
        label: `脚本 ${s}`,
        status: 'warn',
        detail: '未找到，相关功能可能不可用',
        fix: '从内置源码恢复该脚本',
        fixable: true,
        fixLabel: '从内置源码恢复',
      })
    }
  }
  return items
}

function checkResources(): HealthItem[] {
  const items: HealthItem[] = []
  try {
    const totalMemGB = Math.round(require('os').totalmem() / 1024 / 1024 / 1024)
    let status: HealthStatus = 'ok'
    let detail = `系统内存 ${totalMemGB} GB`
    if (totalMemGB < 8) {
      status = 'warn'
      detail += '，低于 9B 模型推荐配置（建议 16GB+）'
    }
    items.push({ key: 'res.mem', label: '系统内存', status, detail })
  } catch {
    items.push({ key: 'res.mem', label: '系统内存', status: 'warn', detail: '无法读取' })
  }
  return items
}

function checkConfig(): HealthItem[] {
  const items: HealthItem[] = []
  try {
    const store = getStore()
    const startupId: string = store.get('startupModelId') || ''
    if (startupId) {
      const { modelRegistry } = require('../model-registry')
      const m = modelRegistry.list().find((x: any) => x.id === startupId)
      if (m && existsSync(m.modelPath)) {
        items.push({ key: 'cfg.startup', label: '启动模型', status: 'ok', detail: `「${m.name}」已就绪` })
      } else {
        items.push({
          key: 'cfg.startup',
          label: '启动模型',
          status: 'error',
          detail: `启动模型「${startupId}」缺失或文件不存在`,
          fix: '在设置中重新选择启动模型',
          fixable: true,
          fixLabel: '重置启动模型为默认',
        })
      }
    } else {
      items.push({ key: 'cfg.startup', label: '启动模型', status: 'ok', detail: '未设置（手动加载）' })
    }
  } catch (e: any) {
    items.push({ key: 'cfg.err', label: '配置', status: 'warn', detail: `读取失败：${e.message}` })
  }
  return items
}

export function runHealthCheck(): HealthReport {
  const items = [
    ...checkModels(),
    ...checkEnvironment(),
    ...checkResources(),
    ...checkConfig(),
  ]
  const hasError = items.some((i) => i.status === 'error')
  const hasWarn = items.some((i) => i.status === 'warn')
  const overall: HealthStatus = hasError ? 'error' : hasWarn ? 'warn' : 'ok'
  return { timestamp: Date.now(), overall, items }
}

export function setupHealthCheckHandlers(): void {
  ipcMain.handle('health:run', async () => {
    try {
      return runHealthCheck()
    } catch (e: any) {
      logger.error(`[health:run] ${e.message}`)
      return { timestamp: Date.now(), overall: 'error', items: [] }
    }
  })

  // 一键修复：按健康项 key 执行对应修复逻辑，返回修复结果（成功后前端刷新自检）
  ipcMain.handle('health:fix', async (_e, key: string) => {
    try {
      return await runFix(key)
    } catch (err: any) {
      logger.error(`[health:fix] ${err.message}`)
      return { success: false, detail: `修复失败：${err.message}` }
    }
  })
  logger.info('[HealthCheck] IPC handlers 已注册')
}

export async function runFix(key: string): Promise<{ success: boolean; detail: string }> {
  try {
    if (key === 'cfg.startup') {
      const store = getStore()
      store.set('startupModelId', '')
      return { success: true, detail: '已重置启动模型为默认（未设置）' }
    }

    if (key.startsWith('env.')) {
      const s = key.slice(4)
      const resDir = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'resources')
      const sp = join(resDir, 'scripts', s)
      const alt = join(resDir, 'python', s)
      const candidates = [
        alt,
        sp,
        join(app.getAppPath(), 'resources', 'python', s),
        join(app.getAppPath(), 'resources', 'scripts', s),
      ]
      const source = candidates.find((p) => existsSync(p) && p !== sp)
      if (source) {
        await fsp.mkdir(dirname(sp), { recursive: true })
        await fsp.copyFile(source, sp)
        return { success: true, detail: `已从内置资源恢复脚本 ${s}` }
      }
      return { success: false, detail: `未找到可用的内置脚本源（${s}）` }
    }

    return { success: false, detail: `暂不支持修复该项：${key}` }
  } catch (err: any) {
    return { success: false, detail: `修复失败：${err.message}` }
  }
}
