/**
 * 控制电脑白名单 — 三级闸门第 ① 级（白名单闸）
 *
 * 持久化到 userData/permissions/control-whitelist.json，按 toolName 细粒度。
 * 白名单命中 → 直接放行，跳过逐次确认弹窗；未命中 → 走 confirmExecute/confirmRisk 兜底。
 *
 * 首次授权流程：`confirm()` 弹原生对话框 + 「记住此授权」勾选，
 * 用户勾选后写入白名单，下次同 toolName 直接放行。
 *
 * 安全底线：渲染层传入的 toolName 一律视为不可信，本模块仅做持久化与判定，
 * 实际执行仍由 desktop-automation / visual-agent 的既有确认门兜底。
 *
 * @module main/permission/control-whitelist
 */

import { app, dialog, BrowserWindow } from 'electron'
import fs from 'fs'
import path from 'path'
import { logger } from '../../shared/logger'
import type { ControlWhitelistFile, WhitelistEntry, WhitelistScope } from '../../shared/agent-types'

function whitelistPath(): string {
  return path.join(app.getPath('userData'), 'permissions', 'control-whitelist.json')
}

/** 空文件结构 */
function emptyFile(): ControlWhitelistFile {
  return { version: 1, entries: [] }
}

/** 读取文件（损坏时降级为空） */
function readFile(): ControlWhitelistFile {
  try {
    const p = whitelistPath()
    if (!fs.existsSync(p)) return emptyFile()
    const parsed = JSON.parse(fs.readFileSync(p, 'utf-8'))
    if (parsed && Array.isArray(parsed.entries)) {
      return { version: 1, entries: parsed.entries as WhitelistEntry[] }
    }
    return emptyFile()
  } catch (e) {
    logger.warn(`[ControlWhitelist] 读取失败: ${e instanceof Error ? e.message : String(e)}`)
    return emptyFile()
  }
}

/** 原子写盘（先建目录） */
function writeFile(file: ControlWhitelistFile): boolean {
  try {
    const p = whitelistPath()
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, JSON.stringify(file, null, 2), 'utf-8')
    return true
  } catch (e) {
    logger.error(`[ControlWhitelist] 写盘失败: ${e instanceof Error ? e.message : String(e)}`)
    return false
  }
}

class ControlWhitelist {
  /**
   * 判定工具是否在白名单中（命中 tool 级或 category 级）。
   * @param toolName 工具名
   * @param category 工具分类（用于 category 级判定）
   */
  isAllowed(toolName: string, category?: string): boolean {
    const file = readFile()
    return file.entries.some((e) => {
      if (e.scope === 'tool') return e.toolName === toolName
      if (e.scope === 'category') return !!category && e.category === category
      return false
    })
  }

  /** 新增白名单记录（幂等：已存在则更新 grantedAt） */
  add(toolName: string, scope: WhitelistScope = 'tool', category?: string): boolean {
    if (!toolName) return false
    const file = readFile()
    const idx = file.entries.findIndex((e) => e.toolName === toolName)
    const entry: WhitelistEntry = {
      toolName,
      scope,
      category: scope === 'category' ? category : undefined,
      grantedAt: Date.now(),
    }
    if (idx >= 0) file.entries[idx] = entry
    else file.entries.push(entry)
    const ok = writeFile(file)
    if (ok) logger.info(`[ControlWhitelist] 授权 ${toolName}（scope=${scope}）`)
    return ok
  }

  /** 移除白名单记录 */
  remove(toolName: string): boolean {
    const file = readFile()
    const next = file.entries.filter((e) => e.toolName !== toolName)
    if (next.length === file.entries.length) return false
    return writeFile({ version: 1, entries: next })
  }

  /** 列出全部白名单记录 */
  list(): WhitelistEntry[] {
    return readFile().entries
  }

  /**
   * 确认门 + 「记住」勾选。
   * 返回 { allowed, remember }：remember 为 true 时调用方应写入白名单。
   */
  async confirm(
    toolName: string,
    category: string | undefined,
    label: string,
    detail: string,
  ): Promise<{ allowed: boolean; remember: boolean }> {
    void category
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
    if (!win || win.isDestroyed()) {
      logger.warn(`[ControlWhitelist] 无可用窗口，拒绝操作: ${toolName}`)
      return { allowed: false, remember: false }
    }
    try {
      const { response, checkboxChecked } = await dialog.showMessageBox(win, {
        type: 'warning',
        title: '电脑控制确认',
        message: `玄枢即将执行「${label}」`,
        detail: `${detail}\n\n该操作会直接作用于您的电脑。如非本人发起，请点击「取消」。`,
        buttons: ['允许', '取消'],
        defaultId: 1,
        cancelId: 1,
        checkboxLabel: '记住此授权（下次该操作不再询问）',
        checkboxChecked: false,
      })
      return { allowed: response === 0, remember: checkboxChecked === true }
    } catch (e) {
      logger.error(`[ControlWhitelist] 确认对话框异常，拒绝执行: ${e instanceof Error ? e.message : String(e)}`)
      return { allowed: false, remember: false }
    }
  }
}

/** 全局单例 */
export const controlWhitelist = new ControlWhitelist()
