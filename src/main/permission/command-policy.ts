/**
 * 动态命令策略 + 受信命令区 — 命令通道重构核心
 *
 * 背景：system-control.ipc.ts 的 execute-command 原为硬编码白名单 switch
 * （仅 open-url / get-system-info / get-disk-space / check-port 四项）。
 * 本模块将其升级为「动态命令策略」：
 *   - 内置命令级别表（默认放行，可在授权设置页调整级别）
 *   - 受信命令区（用户/管理员手动添加的受信命令，白名单化持久化）
 *   - 统一评估入口 evaluateCommand()：命令通道据此判定「放行 / 需确认 / 拒绝」
 *
 * 安全底线（保留不可破坏）：
 *   - 受信命令仅允许「可执行文件 + 固定参数数组」形式，最终仍走
 *     spawn + shell:false + 参数数组执行（system-control 侧实现），
 *     绝不拼接 shell 字符串，杜绝元字符注入。
 *   - 默认不信任任何自定义命令；级别为 L4(禁止) 的命令一律拒绝。
 *
 * @module main/permission/command-policy
 */

import { app } from 'electron'
import fs from 'fs'
import path from 'path'
import { logger } from '../../shared/logger'

/** 授权级别：数字越大越严格 */
export type AuthLevel = 0 | 1 | 2 | 3 | 4

export const AuthLevelName: Record<AuthLevel, string> = {
  0: 'L0 · 已授权',
  1: 'L1 · 留痕',
  2: 'L2 · 需确认',
  3: 'L3 · 需管理员',
  4: 'L4 · 禁止',
}

/** 受信命令区条目：可执行文件 + 固定参数数组（白名单化） */
export interface TrustedCommand {
  id: string
  /** 命令调用名（execute-command 的第一个 token） */
  name: string
  /** 可执行文件绝对路径 */
  exe: string
  /** 固定参数数组（执行时逐项作为独立 argv，不拼接 shell） */
  args: string[]
  description: string
  level: AuthLevel
  addedAt: number
}

/** 内置命令的默认级别 */
const BUILTIN_LEVELS: Record<string, AuthLevel> = {
  'open-url': 1,
  'get-system-info': 0,
  'get-disk-space': 0,
  'check-port': 0,
  'ui-scan': 0,
  'ui-inspect': 0,
  'ui-click': 1,
  'ui-type': 1,
  'ui-execute': 2,
}

interface CommandPolicyFile {
  version: number
  trustedCommands: TrustedCommand[]
  /** 内置命令级别覆盖（授权设置页可调，默认空） */
  builtinOverrides: Record<string, AuthLevel>
}

function policyPath(): string {
  return path.join(app.getPath('userData'), 'permissions', 'command-policy.json')
}

function emptyFile(): CommandPolicyFile {
  return { version: 1, trustedCommands: [], builtinOverrides: {} }
}

function readFile(): CommandPolicyFile {
  try {
    const p = policyPath()
    if (!fs.existsSync(p)) return emptyFile()
    const parsed = JSON.parse(fs.readFileSync(p, 'utf-8'))
    if (parsed && Array.isArray(parsed.trustedCommands)) {
      return {
        version: 1,
        trustedCommands: parsed.trustedCommands as TrustedCommand[],
        builtinOverrides: (parsed.builtinOverrides || {}) as Record<string, AuthLevel>,
      }
    }
    return emptyFile()
  } catch (e) {
    logger.warn(`[CommandPolicy] 读取失败: ${e instanceof Error ? e.message : String(e)}`)
    return emptyFile()
  }
}

function writeFile(file: CommandPolicyFile): boolean {
  try {
    const p = policyPath()
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, JSON.stringify(file, null, 2), 'utf-8')
    return true
  } catch (e) {
    logger.error(`[CommandPolicy] 写盘失败: ${e instanceof Error ? e.message : String(e)}`)
    return false
  }
}

export type CommandDecision =
  | { type: 'builtin'; cmdKey: string; level: AuthLevel }
  | { type: 'trusted'; command: TrustedCommand; level: AuthLevel }
  | { type: 'deny'; reason: string }

class CommandPolicy {
  /** 受信命令区：列出全部 */
  listTrusted(): TrustedCommand[] {
    return readFile().trustedCommands
  }

  /**
   * 添加受信命令（白名单化）。
   * 校验：name/exe 必填，name 只能由字母数字下划线短横线组成，exe 必须为可执行文件。
   */
  addTrusted(input: Omit<TrustedCommand, 'id' | 'addedAt'>): { success: boolean; error?: string; command?: TrustedCommand } {
    const name = (input.name || '').trim()
    const exe = (input.exe || '').trim()
    if (!name || !exe) return { success: false, error: '命令名与可执行文件路径不能为空' }
    if (!/^[\w-]+$/.test(name)) {
      return { success: false, error: '命令名仅允许字母、数字、下划线与短横线' }
    }
    if (!/\.(exe|bat|cmd|ps1|com)$/i.test(exe)) {
      return { success: false, error: '仅允许添加可执行文件（.exe/.bat/.cmd/.ps1/.com）' }
    }
    if (!fs.existsSync(exe)) {
      return { success: false, error: `可执行文件不存在: ${exe}` }
    }
    const level: AuthLevel = (input.level ?? 1) as AuthLevel
    if (level < 0 || level > 4) return { success: false, error: '授权级别非法' }

    const file = readFile()
    if (file.trustedCommands.some((c) => c.name.toLowerCase() === name.toLowerCase())) {
      return { success: false, error: `受信命令「${name}」已存在` }
    }
    const command: TrustedCommand = {
      id: `tc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name,
      exe,
      args: Array.isArray(input.args) ? input.args.slice(0, 32) : [],
      description: (input.description || '').slice(0, 200),
      level,
      addedAt: Date.now(),
    }
    file.trustedCommands.push(command)
    const ok = writeFile(file)
    if (ok) logger.info(`[CommandPolicy] 新增受信命令 ${name} → ${exe}（level=${level}）`)
    return ok ? { success: true, command } : { success: false, error: '写盘失败' }
  }

  /** 移除受信命令 */
  removeTrusted(id: string): boolean {
    const file = readFile()
    const next = file.trustedCommands.filter((c) => c.id !== id)
    if (next.length === file.trustedCommands.length) return false
    return writeFile({ ...file, trustedCommands: next })
  }

  /** 内置命令级别（含用户覆盖） */
  getBuiltinLevel(cmdKey: string): AuthLevel {
    const file = readFile()
    if (file.builtinOverrides[cmdKey] !== undefined) {
      const lvl = file.builtinOverrides[cmdKey]
      if (lvl >= 0 && lvl <= 4) return lvl as AuthLevel
    }
    return BUILTIN_LEVELS[cmdKey] ?? 4
  }

  /** 调整内置命令级别 */
  setBuiltinLevel(cmdKey: string, level: AuthLevel): boolean {
    if (level < 0 || level > 4) return false
    const file = readFile()
    file.builtinOverrides[cmdKey] = level
    return writeFile(file)
  }

  /** 列出内置命令及其当前级别 */
  listBuiltins(): Array<{ cmdKey: string; level: AuthLevel }> {
    return Object.keys(BUILTIN_LEVELS).map((cmdKey) => ({ cmdKey, level: this.getBuiltinLevel(cmdKey) }))
  }

  /**
   * 统一评估入口：解析命令字符串首 token，
   * 返回 builtin / trusted / deny 三态，供命令通道据此执行。
   */
  evaluateCommand(command: string): CommandDecision {
    const trimmed = (command || '').trim()
    if (!trimmed) return { type: 'deny', reason: '空命令' }
    const [cmdKey] = trimmed.split(/\s+/)

    // 受信命令区优先（用户显式添加的命令）
    const trusted = readFile().trustedCommands.find((c) => c.name.toLowerCase() === cmdKey.toLowerCase())
    if (trusted) {
      if (trusted.level === 4) return { type: 'deny', reason: `受信命令「${cmdKey}」已被设为禁止级别` }
      return { type: 'trusted', command: trusted, level: trusted.level }
    }

    // 内置命令
    if (BUILTIN_LEVELS[cmdKey] !== undefined) {
      const level = this.getBuiltinLevel(cmdKey)
      if (level === 4) return { type: 'deny', reason: `内置命令「${cmdKey}」已被设为禁止级别` }
      return { type: 'builtin', cmdKey, level }
    }

    return { type: 'deny', reason: `Command not allowed: ${cmdKey || 'unknown'}` }
  }
}

/** 全局单例 */
export const commandPolicy = new CommandPolicy()

// ============================================================
// IPC 注册（受信命令区管理）
// ============================================================

import { ipcMain } from 'electron'

export function setupCommandPolicyHandlers(): void {
  // 列出受信命令
  ipcMain.handle('command-policy:list-trusted', () => {
    try { return commandPolicy.listTrusted() } catch { return [] }
  })

  // 添加受信命令（白名单化）
  ipcMain.handle('command-policy:add-trusted', (_e, input: Omit<TrustedCommand, 'id' | 'addedAt'>) => {
    try { return commandPolicy.addTrusted(input) } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  // 移除受信命令
  ipcMain.handle('command-policy:remove-trusted', (_e, id: string) => {
    try { return { success: commandPolicy.removeTrusted(id) } } catch { return { success: false } }
  })

  // 列出内置命令及当前级别
  ipcMain.handle('command-policy:list-builtins', () => {
    try { return commandPolicy.listBuiltins() } catch { return [] }
  })

  // 调整内置命令级别
  ipcMain.handle('command-policy:set-builtin-level', (_e, cmdKey: string, level: AuthLevel) => {
    try { return { success: commandPolicy.setBuiltinLevel(cmdKey, level) } } catch { return { success: false } }
  })
}
