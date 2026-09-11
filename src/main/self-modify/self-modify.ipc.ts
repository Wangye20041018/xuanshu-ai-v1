﻿/**
 * 自我改造 —— IPC Handler 注册
 *
 * 通道：
 *   get-capabilities / list-files / read-file / generate /
 *   preview-diff / apply / rollback / list-snapshots
 * 以及主进程 → 渲染进程的 `self-modify:progress` 进度广播（webContents.send）。
 *
 * 写操作（apply/rollback）在服务层强制 writeEnabled + 白名单 + git 快照校验。
 *
 * @module main/self-modify/self-modify.ipc
 */

import { ipcMain, BrowserWindow, app } from 'electron'
import { selfModifyService } from './self-modify.service'
import { getStore } from '../ipc/config.ipc'
import type {
  ApplyResult,
  ChangeSet,
  SelfModifyEffect,
  SelfModifyProgress,
} from './self-modify-types'

/** 从配置读取写模式开关（默认关） */
async function readWriteEnabled(): Promise<boolean> {
  try {
    const v: unknown = getStore().get('selfModifyWriteEnabled', false)
    return v === true
  } catch {
    return false
  }
}

/** 广播进度到所有窗口 */
function broadcastProgress(p: SelfModifyProgress): void {
  BrowserWindow.getAllWindows().forEach((win) => {
    if (!win.isDestroyed()) {
      try {
        win.webContents.send('self-modify:progress', p)
      } catch {
        /* pipe broken */
      }
    }
  })
}

/** 依据生效方式触发重载 / 重启 */
function triggerEffect(effect: SelfModifyEffect): void {
  if (effect === 'reload') {
    setTimeout(() => {
      const win = BrowserWindow.getAllWindows()[0]
      if (win && !win.isDestroyed()) win.webContents.reload()
    }, 400)
  } else if (effect === 'relaunch') {
    setTimeout(() => {
      app.relaunch()
      app.exit(0)
    }, 600)
  }
  // 'hot' / 'none' 无需动作（配置/人设改动的热加载由对应模块自行处理）
}

export function setupSelfModifyHandlers(): void {
  ipcMain.handle('self-modify:get-capabilities', async () => {
    selfModifyService.setWriteEnabled(await readWriteEnabled())
    return selfModifyService.getCapabilities()
  })

  ipcMain.handle('self-modify:list-files', (_event, dir?: string) => {
    return selfModifyService.listFiles(dir)
  })

  ipcMain.handle('self-modify:read-file', (_event, rel: string) => {
    return selfModifyService.readFile(rel)
  })

  ipcMain.handle('self-modify:generate', (_event, requirement: string) => {
    return selfModifyService.generate(String(requirement || ''))
  })

  ipcMain.handle('self-modify:preview-diff', (_event, changeSet: ChangeSet) => {
    const { result, error } = selfModifyService.previewDiff(changeSet)
    if (error) return { success: false, error }
    return { success: true, data: result }
  })

  ipcMain.handle('self-modify:apply', async (_event, changeSet: ChangeSet): Promise<ApplyResult> => {
    selfModifyService.setWriteEnabled(await readWriteEnabled())
    const result = await selfModifyService.apply(changeSet, broadcastProgress)
    if (result.success) triggerEffect(result.effect)
    return result
  })

  ipcMain.handle('self-modify:rollback', async (_event, snapshotHash: string) => {
    // 防御纵深：转发前重新读 config 的写开关，为 false 直接拒绝（不依赖服务层状态）
    const enabled = await readWriteEnabled()
    if (!enabled) {
      return { success: false, effect: 'none' as const, error: '写模式未开启' }
    }
    selfModifyService.setWriteEnabled(true)
    const result = await selfModifyService.rollback(String(snapshotHash || ''), broadcastProgress)
    if (result.success) triggerEffect(result.effect)
    return result
  })

  ipcMain.handle('self-modify:list-snapshots', () => {
    return selfModifyService.listSnapshots()
  })
}
