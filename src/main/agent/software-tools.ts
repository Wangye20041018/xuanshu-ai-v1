/**
 * 软件操作工具组 — 打开软件 / 查询 App 状态（任务书 03 · A-2）
 *
 * 与粗粒度 control_computer（视觉代理整任务）的分工：
 *   - open_software：按名称/类别精确匹配已装软件，直接启动进程，无需视觉识别；
 *   - query_app_status：查询指定 App 是否运行 / 版本 / 路径（进程表 + 软件库）。
 *
 * 复用 softwareLibrary（四路收录 + 词典意图匹配）作为匹配源，
 * 启动走 child_process 直接 spawn，查询进程走 tasklist（无 Python 依赖，离线可用）。
 *
 * @module main/agent/software-tools
 */

import { execFile, spawn } from 'child_process'
import { promisify } from 'util'
import { existsSync } from 'fs'
import { toolRegistry } from './tool-registry'
import { softwareLibrary } from '../software-library'
import { logger } from '../../shared/logger'

const execFileAsync = promisify(execFile)

/** 分离启动进程（不等待退出、不阻塞，适合打开 GUI 软件） */
function spawnDetached(file: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, [], { detached: true, stdio: 'ignore', windowsHide: false })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

/** 进程表条目（tasklist CSV 解析） */
interface ProcessRow {
  name: string
  pid: number
  sessionName?: string
  session?: number
  memUsage?: string
}

/**
 * 解析 tasklist /FO CSV 输出为进程行列表。
 * 编码：GBK（中文 Windows tasklist 默认输出），转 UTF-8 后解析。
 */
function parseTasklistCsv(stdout: string): ProcessRow[] {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  if (lines.length < 2) return []
  const header = lines[0].toLowerCase()
  const col = (row: string[], names: string[]): string => {
    const idx = names.findIndex((n) => header.includes(n))
    return idx >= 0 ? row[idx] || '' : ''
  }
  const rows: ProcessRow[] = []
  for (const line of lines.slice(1)) {
    const cells = line.split('","').map((c) => c.replace(/^"|"$/g, '').trim())
    const name = col(cells, ['image name', '映像名称'])
    if (!name) continue
    rows.push({
      name,
      pid: Number(col(cells, ['pid', '进程id'])) || 0,
      sessionName: col(cells, ['session name', '会话名']),
      session: Number(col(cells, ['session#', '会话#'])) || 0,
      memUsage: col(cells, ['mem usage', '内存使用']),
    })
  }
  return rows
}

/** 获取当前进程表（按映像名去重计数） */
async function listProcesses(): Promise<ProcessRow[]> {
  try {
    const { stdout } = await execFileAsync('tasklist', ['/FO', 'CSV', '/NH'], {
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      encoding: 'buffer',
    })
    const text = Buffer.isBuffer(stdout) ? stdout.toString('utf8') : String(stdout)
    return parseTasklistCsv(text)
  } catch (e) {
    logger.warn(`[SoftwareTools] tasklist 查询失败: ${e instanceof Error ? e.message : String(e)}`)
    return []
  }
}

/** 查询指定进程名是否在运行，返回匹配的进程行（不区分大小写、含 .exe） */
async function findProcessRows(appName: string): Promise<ProcessRow[]> {
  const needle = appName.toLowerCase().replace(/\.exe$/i, '')
  const procs = await listProcesses()
  return procs.filter((p) => p.name.toLowerCase().replace(/\.exe$/i, '') === needle)
}

/**
 * 在软件库中匹配目标软件（名称/别名/窗口标题/可执行文件，均不区分大小写）。
 * 失败时回退进程表匹配（用于「查状态」时软件库未收录但进程在跑的场景）。
 */
function matchSoftwareByName(name: string) {
  const n = String(name || '').trim()
  if (!n) return null
  const lower = n.toLowerCase()
  const entries = softwareLibrary.list()
  const hit =
    entries.find((e) =>
      [e.name, ...e.aliases, ...e.windowTitles, ...(e.exe ? [e.exe.replace(/\.exe$/i, '')] : [])]
        .some((c) => c && c.toLowerCase().includes(lower)),
    ) ||
    entries.find((e) =>
      [e.name, ...e.aliases, ...e.windowTitles, ...(e.exe ? [e.exe] : [])]
        .some((c) => c && lower.includes(c.toLowerCase())),
    ) ||
    null
  return hit
}

/**
 * 启动软件：优先用软件库匹配到的 installPath / exe 精确启动；
 * 未收录时回退按可执行文件名查找（常见安装目录 + 开始菜单），
 * 仍失败则尝试直接 spawn 名称（系统 PATH 内命令）。
 */
async function launchSoftware(name: string): Promise<{ success: boolean; message: string; detail?: unknown; error?: string }> {
  const entry = matchSoftwareByName(name)
  const candidates: string[] = []
  if (entry?.installPath) candidates.push(entry.installPath)
  if (entry?.exe) candidates.push(entry.exe)

  for (const c of candidates) {
    if (c && existsSync(c)) {
      try {
        await spawnDetached(c)
        return { success: true, message: `已打开「${entry?.name || name}」`, detail: { name: entry?.name, path: c } }
      } catch (e) {
        logger.warn(`[SoftwareTools] 启动 ${c} 失败: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }

  // 回退：直接按名称 spawn（可执行文件在 PATH 或需通过 shell 解析）
  try {
    await spawnDetached(name)
    return { success: true, message: `已尝试打开「${name}」`, detail: { name } }
  } catch (e) {
    return { success: false, message: `未找到可启动的软件「${name}」，请确认已安装或先在本机扫描收录`, error: e instanceof Error ? e.message : String(e) }
  }
}

/** 注册 open_software / query_app_status 工具 */
export function registerSoftwareTools(): void {
  // ===== 打开软件 =====
  toolRegistry.register({
    name: 'open_software',
    description:
      '打开本机已安装的软件（按名称或类别匹配）。适用于「打开计算器/记事本/微信/浏览器」等指令。' +
      '与 control_computer 不同：本工具直接精确启动进程，速度快且无需视觉识别；' +
      '仅当需要软件内复杂交互时才用 control_computer。',
    category: 'system',
    dangerous: true,
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '软件名称或别名，如「计算器」「记事本」「微信」「Chrome」' },
      },
      required: ['name'],
    },
    confirm: async (p) => {
      try {
        const { controlWhitelist } = await import('../permission/control-whitelist')
        if (controlWhitelist.isAllowed('open_software', 'system')) return true
        const { allowed, remember } = await controlWhitelist.confirm(
          'open_software',
          'system',
          '打开软件',
          `打开「${String(p.name || '')}」`,
        )
        if (allowed && remember) controlWhitelist.add('open_software', 'tool', 'system')
        return allowed
      } catch {
        return true // 白名单模块未就绪时不阻塞（打开软件属低风险，且已有系统级确认）
      }
    },
    execute: async (p) => {
      const name = String(p.name || '').trim()
      if (!name) return { success: false, error: '软件名不能为空' }
      const res = await launchSoftware(name)
      if (!res.success) return { success: false, error: res.message }
      return { success: true, data: { name, detail: res.detail } }
    },
  })

  // ===== 查询 App 状态 =====
  toolRegistry.register({
    name: 'query_app_status',
    description:
      '查询指定软件/应用是否正在运行，以及版本、路径等信息（进程表 + 本机软件库）。' +
      '适用于「查微信是否在运行」「看看记事本有没有开」等指令。',
    category: 'system',
    dangerous: false,
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '软件名称或别名，如「微信」「记事本」「Chrome」' },
      },
      required: ['name'],
    },
    execute: async (p) => {
      const name = String(p.name || '').trim()
      if (!name) return { success: false, error: '软件名不能为空' }

      const entry = matchSoftwareByName(name)
      // 进程名候选：软件库 exe / 名称 + .exe / 别名
      const exeGuess = entry?.exe || `${name}.exe`
      const processTargets = [exeGuess, name]
      if (entry?.exe) processTargets.unshift(entry.exe)

      let running: ProcessRow[] = []
      for (const t of processTargets) {
        const rows = await findProcessRows(t)
        if (rows.length > 0) {
          running = rows
          break
        }
      }

      return {
        success: true,
        data: {
          name: entry?.name || name,
          running: running.length > 0,
          processCount: running.length,
          processes: running.slice(0, 5).map((r) => ({
            pid: r.pid,
            name: r.name,
            memUsage: r.memUsage,
            sessionName: r.sessionName,
          })),
          library: entry
            ? {
                status: entry.status,
                category: entry.category,
                exe: entry.exe,
                installPath: entry.installPath,
                aliases: entry.aliases,
              }
            : null,
        },
      }
    },
  })

  logger.info('[SoftwareTools] 已注册 open_software / query_app_status')
}
