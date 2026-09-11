/**
 * 分级授权管理 — 授权级别 / 信任列表 / 操作日志
 *
 * 为 #26 操控能力深度开放提供统一授权中枢：
 *   - 当前授权级别（用户可在授权设置页配置，决定系统级能力开放范围）
 *   - 信任列表（受信任的 命令 / 工具 / 软件，放行或免确认）
 *   - 操作日志（所有敏感操作留痕，持久化到 userData/permissions/operation-log.json）
 *
 * 保留底线（不可破坏）：
 *   - 授权判定仅在「既有安全门（白名单 / guardRisk / confirmUIAction）」之上叠加，
 *     不替代、不删除任何既有二次确认与管理员校验。
 *   - 级别为 L4(禁止) 的请求一律拒绝，日志必留痕。
 *
 * @module main/permission/authorization
 */

import { app } from 'electron'
import fs from 'fs'
import path from 'path'
import { logger } from '../../shared/logger'
import type { AuthLevel } from './command-policy'
import { AuthLevelName } from './command-policy'

export type TrustKind = 'command' | 'tool' | 'software'

export interface TrustEntry {
  id: string
  kind: TrustKind
  /** 命令名 / 工具名 / 软件名 */
  key: string
  /** true=免确认直接放行；false=仅加入信任列表但仍需确认 */
  trusted: boolean
  createdAt: number
  note?: string
}

export interface OperationLogEntry {
  id: string
  time: number
  channel: string
  action: string
  level: AuthLevel
  levelName: string
  decision: 'allow' | 'confirm' | 'deny' | 'blocked'
  detail?: string
}

interface AuthorizationFile {
  version: number
  /** 当前授权级别（L0-L4） */
  currentLevel: AuthLevel
  /** 每个级别开放的系统级能力说明（能力→级别映射） */
  levelCapabilities: Record<number, string[]>
  trustList: TrustEntry[]
}

const DEFAULT_CAPABILITIES: Record<number, string[]> = {
  0: ['系统信息读取', '磁盘/端口查询', 'UIA 界面扫描'],
  1: ['以上 + 浏览器导航/点击', 'UIA 点击/输入', '受信命令区执行'],
  2: ['以上 + 后台进程启动', '注册表读写', '服务启停', '需要确认'],
  3: ['以上 + 进程终止', '环境变量设置', '定时任务', '需管理员+确认'],
  4: [],
}

function authPath(): string {
  return path.join(app.getPath('userData'), 'permissions', 'authorization.json')
}

function logPath(): string {
  return path.join(app.getPath('userData'), 'permissions', 'operation-log.json')
}

function emptyAuth(): AuthorizationFile {
  return { version: 1, currentLevel: 1, levelCapabilities: DEFAULT_CAPABILITIES, trustList: [] }
}

function readAuth(): AuthorizationFile {
  try {
    const p = authPath()
    if (!fs.existsSync(p)) return emptyAuth()
    const parsed = JSON.parse(fs.readFileSync(p, 'utf-8'))
    if (parsed && typeof parsed.currentLevel === 'number') {
      return {
        version: 1,
        currentLevel: parsed.currentLevel as AuthLevel,
        levelCapabilities: { ...DEFAULT_CAPABILITIES, ...(parsed.levelCapabilities || {}) },
        trustList: Array.isArray(parsed.trustList) ? parsed.trustList : [],
      }
    }
    return emptyAuth()
  } catch (e) {
    logger.warn(`[Authorization] 读取失败: ${e instanceof Error ? e.message : String(e)}`)
    return emptyAuth()
  }
}

function writeAuth(file: AuthorizationFile): boolean {
  try {
    const p = authPath()
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, JSON.stringify(file, null, 2), 'utf-8')
    return true
  } catch (e) {
    logger.error(`[Authorization] 写盘失败: ${e instanceof Error ? e.message : String(e)}`)
    return false
  }
}

function readLogs(): OperationLogEntry[] {
  try {
    const p = logPath()
    if (!fs.existsSync(p)) return []
    const parsed = JSON.parse(fs.readFileSync(p, 'utf-8'))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeLogs(entries: OperationLogEntry[]): void {
  try {
    const p = logPath()
    fs.mkdirSync(path.dirname(p), { recursive: true })
    // 仅保留最近 500 条，防止无限膨胀
    fs.writeFileSync(p, JSON.stringify(entries.slice(0, 500), null, 2), 'utf-8')
  } catch (e) {
    logger.error(`[Authorization] 日志写盘失败: ${e instanceof Error ? e.message : String(e)}`)
  }
}

class AuthorizationManager {
  getLevel(): AuthLevel {
    return readAuth().currentLevel
  }

  /** 设置当前授权级别（0-4） */
  setLevel(level: AuthLevel): { success: boolean; error?: string } {
    if (![0, 1, 2, 3, 4].includes(level)) return { success: false, error: '级别必须为 0-4' }
    const file = readAuth()
    file.currentLevel = level
    const ok = writeAuth(file)
    logger.info(`[Authorization] 当前授权级别 → L${level}`)
    return ok ? { success: true } : { success: false, error: '写盘失败' }
  }

  /** 某能力所需的授权级别 */
  requiredLevel(action: string): AuthLevel {
    const table: Record<string, AuthLevel> = {
      'process-start': 2,
      'process-kill': 3,
      'registry-write': 2,
      'registry-read': 1,
      'service-start': 2,
      'service-stop': 2,
      'task-schedule': 3,
      'env-var-set': 3,
      'browser-evaluate': 2,
      'system-command': 1,
      'ui-execute': 2,
    }
    return table[action] ?? 2
  }

  /**
   * 判定某动作在「当前授权级别」下是否开放。
   * levelNeeded: 动作自身所需级别；若用户信任列表中命中则降级为留痕(L1)。
   */
  canAccess(action: string, kind: TrustKind = 'tool', key?: string): { allowed: boolean; level: AuthLevel; trusted: boolean } {
    const file = readAuth()
    const required = this.requiredLevel(action)
    let effective = required

    // 信任列表：命中则视为留痕级，免确认
    let trusted = false
    if (key) {
      const entry = file.trustList.find(
        (t) => t.kind === kind && t.key.toLowerCase() === key.toLowerCase() && t.trusted,
      )
      if (entry) {
        trusted = true
        effective = Math.min(required, 1) as AuthLevel
      }
    }

    const allowed = effective <= file.currentLevel && effective < 4
    return { allowed, level: effective, trusted }
  }

  /* ---------- 信任列表 ---------- */
  listTrust(): TrustEntry[] {
    return readAuth().trustList
  }

  addTrust(kind: TrustKind, key: string, trusted: boolean, note?: string): boolean {
    const file = readAuth()
    const k = (key || '').trim()
    if (!k) return false
    if (file.trustList.some((t) => t.kind === kind && t.key.toLowerCase() === k.toLowerCase())) {
      return false
    }
    file.trustList.push({
      id: `tr-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      kind,
      key: k,
      trusted,
      createdAt: Date.now(),
      note: note || '',
    })
    return writeAuth(file)
  }

  removeTrust(id: string): boolean {
    const file = readAuth()
    const next = file.trustList.filter((t) => t.id !== id)
    if (next.length === file.trustList.length) return false
    return writeAuth({ ...file, trustList: next })
  }

  /* ---------- 操作日志 ---------- */
  listLogs(limit = 100): OperationLogEntry[] {
    return readLogs().slice(0, limit)
  }

  clearLogs(): boolean {
    writeLogs([])
    return true
  }

  /** 记录一次操作留痕 */
  log(entry: Omit<OperationLogEntry, 'id' | 'time' | 'levelName' | 'level'> & { level?: AuthLevel }): void {
    const level = entry.level ?? this.requiredLevel(entry.action)
    const e: OperationLogEntry = {
      id: `op-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      time: Date.now(),
      channel: entry.channel,
      action: entry.action,
      level,
      levelName: AuthLevelName[level] || `L${level}`,
      decision: entry.decision,
      detail: entry.detail || '',
    }
    const logs = readLogs()
    logs.unshift(e)
    writeLogs(logs)
  }
}

/** 全局单例 */
export const authorization = new AuthorizationManager()

// ============================================================
// IPC 注册（分级授权设置页）
// ============================================================

import { ipcMain } from 'electron'

export function setupAuthorizationHandlers(): void {
  // 获取授权状态（级别 + 能力说明 + 信任列表）
  ipcMain.handle('authorization:get-state', () => {
    try {
      const file = readAuth()
      return {
        level: file.currentLevel,
        levelCapabilities: file.levelCapabilities,
        trustList: file.trustList,
        levels: [
          { level: 0, name: 'L0 · 已授权', desc: '基础能力：系统信息读取、磁盘/端口查询、UIA 界面扫描' },
          { level: 1, name: 'L1 · 留痕', desc: '浏览器导航/点击、UIA 点击/输入、受信命令区执行' },
          { level: 2, name: 'L2 · 需确认', desc: '后台进程启动、注册表读写、服务启停（操作前确认）' },
          { level: 3, name: 'L3 · 需管理员', desc: '进程终止、环境变量设置、定时任务（需管理员+确认）' },
          { level: 4, name: 'L4 · 禁止', desc: '禁止所有系统级开放能力' },
        ],
      }
    } catch (e) {
      logger.warn(`[Authorization] get-state 失败: ${e instanceof Error ? e.message : String(e)}`)
      return { level: 1, levelCapabilities: DEFAULT_CAPABILITIES, trustList: [], levels: [] }
    }
  })

  // 设置授权级别
  ipcMain.handle('authorization:set-level', (_e, level: number) => {
    try {
      const res = authorization.setLevel(level as AuthLevel)
      if (res.success) authorization.log({
        channel: 'authorization:set-level',
        action: 'authorization-set-level',
        level: level as AuthLevel,
        decision: 'allow',
        detail: `授权级别调整为 L${level}`,
      })
      return res
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  // 信任列表
  ipcMain.handle('authorization:list-trust', () => {
    try { return authorization.listTrust() } catch { return [] }
  })

  ipcMain.handle('authorization:add-trust', (_e, kind: TrustKind, key: string, trusted: boolean, note?: string) => {
    try {
      const ok = authorization.addTrust(kind, key, trusted, note)
      if (ok) authorization.log({
        channel: 'authorization:add-trust',
        action: 'authorization-add-trust',
        decision: 'allow',
        detail: `添加信任项 ${kind}:${key}`,
      })
      return { success: ok, trust: authorization.listTrust() }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('authorization:remove-trust', (_e, id: string) => {
    try {
      const ok = authorization.removeTrust(id)
      if (ok) authorization.log({
        channel: 'authorization:remove-trust',
        action: 'authorization-remove-trust',
        decision: 'allow',
        detail: `移除信任项 ${id}`,
      })
      return { success: ok }
    } catch {
      return { success: false }
    }
  })

  // 操作日志
  ipcMain.handle('authorization:list-logs', (_e, limit?: number) => {
    try { return authorization.listLogs(limit) } catch { return [] }
  })

  ipcMain.handle('authorization:clear-logs', () => {
    try { return { success: authorization.clearLogs() } } catch { return { success: false } }
  })
}
