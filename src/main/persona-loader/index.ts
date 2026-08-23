/**
 * persona-loader（v11.0，单模型常驻）
 *
 * 架构 §7.3：扫描 resources/personas/*.json（canonical 主源），
 * 输出含 preferred_tier 的清单供路由与渲染端共用。
 *
 * 每套人格结构：
 *   { id, name, icon, description, color, temperature,
 *     preferred_tier: 'fast', system_prompt }
 *
 * v11.0 变更：preferred_tier 统一为 'fast'，不再有 quality 档位。
 */

import {ipcMain} from 'electron'
import { join } from 'path'
import { existsSync, readFileSync, readdirSync } from 'fs'
import { is } from '@electron-toolkit/utils'
import { logger } from '../../shared/logger'

export interface PersonaMeta {
  id: string
  name: string
  icon?: string
  description?: string
  color?: string
  preferred_tier: 'fast'
  system_prompt?: string
}

class PersonaLoader {
  private personas: Map<string, PersonaMeta> = new Map()
  private loaded = false

  /** 扫描 resources/personas（dev: 项目根；prod: 安装包 resources） */
  initialize(): void {
    if (this.loaded) return
    try {
      const dir = is.dev
        ? join(__dirname, '../../resources/personas')
        : join(process.resourcesPath, 'personas')
      if (!existsSync(dir)) {
        logger.warn('[PersonaLoader] 人格目录不存在:', dir)
        return
      }
      const files = readdirSync(dir).filter((f) => f.endsWith('.json'))
      for (const f of files) {
        try {
          const raw = JSON.parse(readFileSync(join(dir, f), 'utf-8'))
          const id = raw.id || f.replace(/\.json$/, '')
          this.personas.set(id, {
            id,
            name: raw.name || id,
            icon: raw.icon,
            description: raw.description,
            color: raw.color,
            preferred_tier: 'fast',
            system_prompt: raw.system_prompt,
          })
        } catch (e) {
          logger.error('[PersonaLoader] 解析失败:', f, e)
        }
      }
      this.loaded = true
      logger.debug(`[PersonaLoader] 已加载 ${this.personas.size} 套人格（来源 resources/personas，canonical）`)
    } catch (e) {
      logger.error('[PersonaLoader] init error:', e)
    }
  }

  listPersonas(): PersonaMeta[] {
    this.initialize()
    return Array.from(this.personas.values())
  }

  /** 路由读取人格档位（v11.0 统一返回 fast） */
  getTier(_personaId: string): 'fast' {
    return 'fast'
  }

  getPersona(id: string): PersonaMeta | undefined {
    this.initialize()
    return this.personas.get(id)
  }
}

export const personaLoader = new PersonaLoader()

/**
 * 注册 persona IPC 通道（命名空间 persona:*，见架构 §10 对齐点）
 */
export function setupPersonaLoaderHandlers(): void {
  ipcMain.handle('persona:list', () => personaLoader.listPersonas())
  ipcMain.handle('persona:get', (_e: any, id: string) => personaLoader.getPersona(id))
  ipcMain.handle('persona:tier', (_e: any, id: string) => personaLoader.getTier(id))
}
