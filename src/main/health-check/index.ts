/**
 * HealthCheck — 玄枢智能自检修复引擎
 *
 * 玄枢不下载模型（模型由用户自备），因此体检重点不是"下载完整性"，
 * 而是"自备模型可用性 + 运行环境 + 系统资源 + 配置合法性 + 运行时链路"。
 *
 * 检查项：
 *  1. 模型文件校验：GGUF magic number、文件存在、大小非零、与注册路径一致
 *  2. 兼容性预检：解析 GGUF 头部（架构/参数量/量化类型），与运行时匹配
 *  3. 环境自检：Python 运行时、关键脚本、依赖完整性
 *  4. 资源评估：内存是否满足所选模型加载
 *  5. 配置合法性：模型路径、provider、启动模型等配置一致性
 *  6. 模型运行时链路：llama-server 进程、8089 端口监听、显存占用（对齐 P0-0 基线判据）
 *  7. 联网链路：外网可达性（联网检索可用性的先决条件）
 *  8. 日志健康：日志目录容量/文件数（死循环刷屏、膨胀预警，修复=归档重建）
 *  9. 运行资源：语音面板、浏览器预载等前端关键资源存在性（防"壳子"）
 *
 * 修复能力（分级）：
 *  - 自动可修复（fixable=true，前端一键勾选执行）：
 *      env.* 脚本丢失 → 从内置资源恢复
 *      cfg.startup 指向缺失模型 → 重置为默认
 *      runtime.residual 多个引擎实例 → 保留监听者，终止多余实例
 *      runtime.engine 僵死（进程在但端口未监听）→ 终止僵死进程，引擎按需自动重启
 *      logs.grow 日志膨胀 → 归档为 .archived 重建
 *  - 需用户决策：模型文件损坏（重新导入）、网络不通（检查代理）、GGUF 非法等
 *
 * 修复后由前端自动重新体检（复检）验证修复生效。
 *
 * @module main/health-check
 */

import { ipcMain } from 'electron'
import { existsSync, statSync, promises as fsp, readdirSync, openSync, readSync, closeSync } from 'fs'
import { join, dirname } from 'path'
import { app } from 'electron'
import { exec } from 'child_process'
import { promisify } from 'util'
import { logger } from '../../shared/logger'
import { getStore } from '../ipc/config.ipc'
import { modelRegistry } from '../model-registry'

/** 危险工具一键冻结开关（§14），与 agent/react-loop.ts 共用同一 key */
export const DANGER_FREEZE_KEY = 'dangerToolsFrozen'

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
/** 玄枢本机会话引擎（llama-server）进程名，与 P0-0 基线 scripts/p0-regression.mjs 判据一致 */
const LLAMA_PROC = 'llama-server.exe'

const asyncExec = promisify(exec)

/** 只读执行系统命令，失败/超时返回空串（永不抛错） */
async function execSafe(cmd: string): Promise<string> {
  try {
    const { stdout } = await asyncExec(cmd, { timeout: 8000, windowsHide: true })
    return String(stdout || '')
  } catch (e: any) {
    // exec 对非零退出码会抛错，但 stdout 可能仍有有效输出
    if (e && e.stdout) return String(e.stdout)
    return ''
  }
}

function readGgufHeader(path: string): { arch?: string; params?: string; quant?: string } | null {
  // 只读文件头（前 1MB），避免大模型（数 GB）被整读进内存导致读取失败/卡顿
  let fd: number | null = null
  try {
    const size = statSync(path).size
    if (size < 4) return null
    fd = openSync(path, 'r')
    const buf = Buffer.alloc(Math.min(1024 * 1024, size))
    readSync(fd, buf, 0, buf.length, 0)
    if (!buf.subarray(0, 4).equals(GGUF_MAGIC)) return null
    const text = buf.toString('latin1')
    const arch = text.match(/general\.architecture\s*=\s*([a-zA-Z0-9_-]+)/)?.[1]
    const params = text.match(/general\.size_label\s*=\s*([0-9.]+[A-Za-z]+)/)?.[1]
    const quant = text.match(/quantization_version|f16|q4_k|q8_0|q5_k|q2_k/i)?.[0]
    return { arch, params, quant }
  } catch {
    return null
  } finally {
    if (fd !== null) { try { closeSync(fd) } catch {} }
  }
}

function checkModels(): HealthItem[] {
  const items: HealthItem[] = []
  try {
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

/**
 * 模型运行时链路检测（对齐 P0-0 基线"模型链路"判据）：
 *  llama-server 进程存活、8089 端口监听、显存占用。
 */
async function checkModelRuntime(): Promise<HealthItem[]> {
  const items: HealthItem[] = []
  const [net, ps] = await Promise.all([
    execSafe('netstat -ano -p tcp'),
    execSafe(`tasklist /FI "IMAGENAME eq ${LLAMA_PROC}" /FO CSV /NH`),
  ])

  const listeningLines = net.split(/\r?\n/).filter((l) => /:8089\s/.test(l) && /LISTENING/i.test(l))
  let portPid = ''
  for (const l of listeningLines) {
    const m = l.match(/(\d+)\s*$/)
    if (m) { portPid = m[1]; break }
  }

  const llamaPids: string[] = []
  for (const l of ps.split(/\r?\n/)) {
    const m = l.match(/"llama-server\.exe","(\d+)"/i)
    if (m) llamaPids.push(m[1])
  }

  if (portPid) {
    items.push({
      key: 'runtime.port',
      label: '模型服务端口(8089)',
      status: 'ok',
      detail: `llama-server 正在监听 · PID ${portPid}`,
    })
  } else {
    items.push({
      key: 'runtime.port',
      label: '模型服务端口(8089)',
      status: 'warn',
      detail: '8089 未监听，本机会话引擎未运行（首次对话会自动启动）',
    })
  }

  if (llamaPids.length > 1) {
    const extra = portPid ? llamaPids.filter((p) => p !== portPid) : llamaPids.slice(1)
    items.push({
      key: 'runtime.residual',
      label: '推理引擎实例',
      status: 'warn',
      detail: `多余实例 ${llamaPids.length - 1} 个（PID ${extra.join(',')}），可能造成资源占用/端口冲突`,
      fix: '终止多余实例，保留正在服务的引擎（被终止者将在需要时自动重启）',
      fixable: true,
      fixLabel: '清理多余实例',
    })
  } else if (llamaPids.length === 1 && !portPid) {
    // 进程在但端口未监听：僵死/半启动状态 —— 自动修复：清理后按需重启
    items.push({
      key: 'runtime.engine',
      label: '推理引擎进程',
      status: 'warn',
      detail: `检测到 llama-server（PID ${llamaPids[0]}）但 8089 端口未监听，处于僵死/启动异常状态`,
      fix: '终止僵死进程，对话时引擎将自动重新拉起',
      fixable: true,
      fixLabel: '清理僵死进程',
    })
  } else if (llamaPids.length === 1) {
    items.push({ key: 'runtime.engine', label: '推理引擎进程', status: 'ok', detail: `llama-server 运行中 · PID ${llamaPids[0]}` })
  } else {
    items.push({ key: 'runtime.engine', label: '推理引擎进程', status: 'warn', detail: '未发现 llama-server 进程（等待按需启动）' })
  }

  const smi = await execSafe('nvidia-smi --query-gpu=name,memory.used,memory.total --format=csv,noheader,nounits')
  const smiLine = smi.split(/\r?\n/).find((l) => l.trim().length > 0)
  if (smiLine) {
    items.push({ key: 'runtime.gpu', label: 'GPU/显存', status: 'ok', detail: smiLine.trim() })
  } else {
    items.push({ key: 'runtime.gpu', label: 'GPU/显存', status: 'warn', detail: '未检测到 nvidia-smi，无法读取显存（CPU 推理或驱动缺失）' })
  }
  return items
}

/** 联网链路检测：外网可达性是联网检索可用的先决条件 */
async function checkNetwork(): Promise<HealthItem[]> {
  const items: HealthItem[] = []
  try {
    const t0 = Date.now()
    const res = await fetch('https://www.baidu.com', { method: 'HEAD', signal: AbortSignal.timeout(4000) } as any).catch(() => null)
    if (res) {
      items.push({ key: 'net.online', label: '联网链路', status: 'ok', detail: `外网可达 · ${Date.now() - t0}ms` })
    } else {
      items.push({
        key: 'net.online',
        label: '联网链路',
        status: 'warn',
        detail: '外网探测失败（断网或代理未通），联网检索将不可用',
        fix: '检查系统网络/代理连接后重新自检',
      })
    }
  } catch {
    items.push({
      key: 'net.online',
      label: '联网链路',
      status: 'warn',
      detail: '外网探测失败',
      fix: '检查系统网络/代理连接后重新自检',
    })
  }
  return items
}

/** 日志健康：检测死循环刷屏/膨胀（P0-1 症候），修复=归档重建，不删除数据 */
async function checkLogs(): Promise<HealthItem[]> {
  const items: HealthItem[] = []
  try {
    const logsDir = join(app.getPath('userData'), 'logs')
    if (!existsSync(logsDir)) {
      items.push({ key: 'logs.grow', label: '日志健康', status: 'ok', detail: '无日志文件积压（logs 目录尚未产生）' })
      return items
    }
    let total = 0
    let count = 0
    let biggestMB = 0
    for (const f of readdirSync(logsDir)) {
      if (!/\.(log|txt)$/i.test(f)) continue
      const p = join(logsDir, f)
      let s = 0
      try { s = statSync(p).size } catch { continue }
      total += s
      count++
      const mb = Math.round(s / 1024 / 1024)
      if (mb > biggestMB) biggestMB = mb
    }
    const totalMB = Math.round(total / 1024 / 1024)
    if (totalMB > 200) {
      items.push({
        key: 'logs.grow',
        label: '日志健康',
        status: 'error',
        detail: `日志累计 ${totalMB} MB / ${count} 个文件（${logsDir}），存在死循环刷屏/膨胀风险`,
        fix: '归档现有日志（保留为 .archived 后缀），后续日志重新积累',
        fixable: true,
        fixLabel: '归档重建日志',
      })
    } else if (totalMB > 30) {
      items.push({
        key: 'logs.grow',
        label: '日志健康',
        status: 'warn',
        detail: `日志累计 ${totalMB} MB / ${count} 个文件，建议归档`,
        fix: '归档现有日志（保留为 .archived 后缀），后续日志重新积累',
        fixable: true,
        fixLabel: '归档重建日志',
      })
    } else {
      items.push({ key: 'logs.grow', label: '日志健康', status: 'ok', detail: `日志 ${totalMB} MB / ${count} 个文件，健康` })
    }
  } catch (e: any) {
    items.push({ key: 'logs.err', label: '日志健康', status: 'warn', detail: `检查失败：${e.message}` })
  }
  return items
}

/** 运行关键资源存在性：悬浮球 / 浏览器预载等（防止"壳子"） */
function checkRuntimeAssets(): HealthItem[] {
  const items: HealthItem[] = []
  const resDir = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'resources')
  const floatBall = join(resDir, 'floating-ball.html')
  if (existsSync(floatBall)) {
    items.push({ key: 'assets.voice', label: '悬浮球资源', status: 'ok', detail: '悬浮球就绪' })
  } else {
    items.push({
      key: 'assets.voice',
      label: '悬浮球资源',
      status: 'warn',
      detail: `悬浮球资源缺失：${floatBall}`,
      fix: '重新构建或安装完整资源',
    })
  }
  const preload = join(app.getAppPath(), 'out', 'preload', 'index.js')
  const preloadAlt = join(app.getAppPath(), 'src', 'preload', 'index.ts')
  if (existsSync(preload) || existsSync(preloadAlt)) {
    items.push({ key: 'assets.preload', label: '浏览器/权限预载', status: 'ok', detail: 'preload 就绪' })
  } else {
    items.push({
      key: 'assets.preload',
      label: '浏览器/权限预载',
      status: 'warn',
      detail: '未找到 preload 产物，浏览器/权限桥接可能失效',
      fix: '重新构建（npm run build）',
    })
  }
  return items
}

export async function runHealthCheck(): Promise<HealthReport> {
  const runtime = await checkModelRuntime()
  const net = await checkNetwork()
  const logs = await checkLogs()
  const items = [
    ...checkModels(),
    ...checkEnvironment(),
    ...checkResources(),
    ...checkConfig(),
    ...runtime,
    ...net,
    ...logs,
    ...checkRuntimeAssets(),
  ]
  const hasError = items.some((i) => i.status === 'error')
  const hasWarn = items.some((i) => i.status === 'warn')
  const overall: HealthStatus = hasError ? 'error' : hasWarn ? 'warn' : 'ok'
  return { timestamp: Date.now(), overall, items }
}

export function setupHealthCheckHandlers(): void {
  ipcMain.handle('health:run', async () => {
    try {
      return await runHealthCheck()
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

/**
 * 自动修复：按健康项 key 执行对应修复逻辑。
 * 分级：自动可修复（进程/脚本/日志归档/配置重置）直接处理；
 *      文件损坏、网络不通等需用户决策的项不在此列（前端仅展示指引）。
 */
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
      const candidates = [
        join(resDir, 'python', s),
        sp,
        join(app.getAppPath(), 'resources', 'python', s),
        join(app.getAppPath(), 'resources', 'scripts', s),
      ]
      const source = candidates.find((p) => existsSync(p) && dirname(p) !== dirname(sp))
      if (source) {
        await fsp.mkdir(dirname(sp), { recursive: true })
        await fsp.copyFile(source, sp)
        return { success: true, detail: `已从内置资源恢复脚本 ${s}` }
      }
      return { success: false, detail: `未找到可用的内置脚本源（${s}）` }
    }

    // ---- 运行时清理（只针对玄枢自管理的 llama-server.exe）----
    if (key === 'runtime.residual' || key === 'runtime.engine') {
      const [net, ps] = await Promise.all([
        execSafe('netstat -ano -p tcp'),
        execSafe(`tasklist /FI "IMAGENAME eq ${LLAMA_PROC}" /FO CSV /NH`),
      ])
      const listeningLines = net.split(/\r?\n/).filter((l) => /:8089\s/.test(l) && /LISTENING/i.test(l))
      let portPid = ''
      for (const l of listeningLines) {
        const m = l.match(/(\d+)\s*$/)
        if (m) { portPid = m[1]; break }
      }
      const pids: string[] = []
      for (const l of ps.split(/\r?\n/)) {
        const m = l.match(/"llama-server\.exe","(\d+)"/i)
        if (m) pids.push(m[1])
      }
      // residual：保留监听者，杀其余；engine（僵死且无监听）：全清，引擎按需重启
      const toKill = key === 'runtime.residual' && portPid
        ? pids.filter((p) => p !== portPid)
        : pids
      if (toKill.length === 0) {
        return { success: true, detail: '未发现需清理的进程（可能已恢复正常）' }
      }
      for (const pid of toKill) {
        await execSafe(`taskkill /PID ${pid} /F`)
      }
      return {
        success: true,
        detail: `已终止 ${toKill.length} 个 ${LLAMA_PROC} 实例（PID ${toKill.join(',')}）${key === 'runtime.engine' ? '，对话时引擎将自动重新拉起' : '，保留正在服务的引擎'}（已终止者按需自动重启）`,
      }
    }

    // ---- 日志归档重建（保留数据，不删除）----
    if (key === 'logs.grow') {
      const logsDir = join(app.getPath('userData'), 'logs')
      if (!existsSync(logsDir)) return { success: true, detail: '日志目录不存在，无需处理' }
      const ts = Date.now()
      let archived = 0
      for (const f of readdirSync(logsDir)) {
        if (!/\.(log|txt)$/i.test(f)) continue
        const src = join(logsDir, f)
        const dst = join(logsDir, `${f}.archived-${ts}`)
        try {
          await fsp.rename(src, dst)
          archived++
        } catch { /* 单个失败不阻断 */ }
      }
      if (archived > 0) {
        return { success: true, detail: `已归档 ${archived} 个日志文件为 .archived-${ts}（数据保留），日志将重新积累` }
      }
      return { success: true, detail: '无可归档的日志文件' }
    }

    return { success: false, detail: `暂不支持修复该项：${key}` }
  } catch (err: any) {
    return { success: false, detail: `修复失败：${err.message}` }
  }
}
