/**
 * 智能体存储 — userData/agents/ 目录 CRUD + 校验
 *
 * 存储位置决策（独立 agents/ 目录，不存 personas/）：
 *   1. 生命周期不同：人设是静态模板，智能体是用户运行时产物；
 *   2. 更新隔离：应用升级覆盖 resources/personas，不碰 userData/agents；
 *   3. 不污染 git / 自我改造白名单；
 *   4. 备份/导出简单：扁平 JSON 文件拷贝即可。
 *
 * 安全底线：渲染层传入的 agentId/definition 一律不可信，落盘前经 validate 强制校验。
 *
 * @module main/agent/agent-store
 */

import { app } from 'electron'
import fs from 'fs'
import path from 'path'
import { logger } from '../../shared/logger'
import type { AgentDefinition } from '../../shared/agent-types'

/** ID 前缀：与自改造 agent-/tool-/swarm- 前缀区分 */
const AGENT_ID_PREFIX = 'agt-'

/** 合法 id 校验：agt- 前缀 + 字母数字/连字符 */
const ID_PATTERN = /^agt-[a-zA-Z0-9-]{4,64}$/

/** 智能体目录（userData 下） */
function agentsDir(): string {
  return path.join(app.getPath('userData'), 'agents')
}

/** 单智能体文件路径 */
function agentPath(id: string): string {
  return path.join(agentsDir(), `${id}.json`)
}

/** 生成新智能体 id */
export function generateAgentId(): string {
  const ts = Date.now().toString(36)
  const rand = Math.random().toString(36).slice(2, 8)
  return `${AGENT_ID_PREFIX}${ts}-${rand}`
}

/** 生成默认记忆命名空间 */
export function defaultMemoryNamespace(agentId: string): string {
  return `agent:${agentId}`
}

/** 构造默认定义（创建预览时的兜底字段） */
export function buildDefaultDefinition(partial: Partial<AgentDefinition>): AgentDefinition {
  const id = partial.id && ID_PATTERN.test(partial.id) ? partial.id : generateAgentId()
  const now = Date.now()
  return {
    id,
    name: partial.name || '未命名智能体',
    description: partial.description || '',
    icon: partial.icon,
    color: partial.color,
    personaId: partial.personaId || 'default',
    personaOverride: partial.personaOverride,
    toolIds: Array.isArray(partial.toolIds) ? partial.toolIds : [],
    memoryConfig: {
      enabled: partial.memoryConfig?.enabled ?? true,
      namespace: partial.memoryConfig?.namespace || defaultMemoryNamespace(id),
      maxRecall: partial.memoryConfig?.maxRecall ?? 5,
    },
    modelConfig: {
      modelId: partial.modelConfig?.modelId,
      temperature: partial.modelConfig?.temperature ?? 0.7,
      maxSteps: partial.modelConfig?.maxSteps ?? 15,
    },
    tags: Array.isArray(partial.tags) ? partial.tags : [],
    createdAt: partial.createdAt ?? now,
    updatedAt: now,
    role: partial.role,
    skills: Array.isArray(partial.skills) ? partial.skills : undefined,
    collaboration: partial.collaboration,
    preset: partial.preset,
  }
}

export interface StoreResult {
  success: boolean
  data?: AgentDefinition | AgentDefinition[]
  error?: string
}

class AgentStore {
  private ensured = false

  /** 确保目录存在（懒初始化） */
  private ensureDir(): void {
    if (this.ensured) return
    try {
      const dir = agentsDir()
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }
      this.ensured = true
    } catch (e) {
      logger.error(`[AgentStore] 创建 agents 目录失败: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /** 列出所有智能体（按 updatedAt 倒序） */
  list(): AgentDefinition[] {
    this.ensureDir()
    const out: AgentDefinition[] = []
    try {
      const files = fs.readdirSync(agentsDir()).filter((f) => f.endsWith('.json'))
      for (const f of files) {
        try {
          const raw = fs.readFileSync(path.join(agentsDir(), f), 'utf-8')
          const parsed = JSON.parse(raw) as AgentDefinition
          if (parsed && typeof parsed.id === 'string') {
            out.push(parsed)
          }
        } catch (e) {
          logger.warn(`[AgentStore] 跳过损坏的智能体文件 ${f}: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
    } catch (e) {
      logger.error(`[AgentStore] 列出智能体失败: ${e instanceof Error ? e.message : String(e)}`)
    }
    return out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
  }

  /** 按 id 读取单个智能体 */
  get(id: string): AgentDefinition | undefined {
    if (!id || !ID_PATTERN.test(id)) return undefined
    this.ensureDir()
    try {
      const p = agentPath(id)
      if (!fs.existsSync(p)) return undefined
      const raw = fs.readFileSync(p, 'utf-8')
      const parsed = JSON.parse(raw) as AgentDefinition
      return parsed && typeof parsed.id === 'string' ? parsed : undefined
    } catch (e) {
      logger.error(`[AgentStore] 读取智能体 ${id} 失败: ${e instanceof Error ? e.message : String(e)}`)
      return undefined
    }
  }

  /** 保存（新建/覆盖）。落盘前强制校验。 */
  save(def: AgentDefinition): StoreResult {
    const validated = this.validate(def)
    if (!validated.ok) {
      return { success: false, error: validated.error }
    }
    // 校验通过后重新规整（补默认值 + 归一化 id）
    const normalized = buildDefaultDefinition(def)
    normalized.id = def.id
    this.ensureDir()
    try {
      fs.writeFileSync(agentPath(normalized.id), JSON.stringify(normalized, null, 2), 'utf-8')
      logger.info(`[AgentStore] 已保存智能体 ${normalized.id} (${normalized.name})`)
      return { success: true, data: normalized }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      logger.error(`[AgentStore] 保存智能体 ${normalized.id} 失败: ${msg}`)
      return { success: false, error: `写入失败: ${msg}` }
    }
  }

  /** 删除单个智能体 */
  delete(id: string): StoreResult {
    if (!id || !ID_PATTERN.test(id)) {
      return { success: false, error: '非法智能体 id' }
    }
    this.ensureDir()
    try {
      const p = agentPath(id)
      if (!fs.existsSync(p)) {
        return { success: false, error: '智能体不存在' }
      }
      fs.unlinkSync(p)
      logger.info(`[AgentStore] 已删除智能体 ${id}`)
      return { success: true }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { success: false, error: `删除失败: ${msg}` }
    }
  }

  /**
   * 结构校验 + 引用校验（personaId 命中人设 / toolIds 命中工具集）。
   * 引用校验为尽力而为：对应模块未就绪时降级为仅结构校验，避免启动期循环依赖。
   */
  validate(def: AgentDefinition): { ok: boolean; error?: string } {
    if (!def || typeof def !== 'object') {
      return { ok: false, error: '智能体定义非法' }
    }
    if (typeof def.id !== 'string' || !ID_PATTERN.test(def.id)) {
      return { ok: false, error: '智能体 id 非法（需以 agt- 开头）' }
    }
    if (typeof def.name !== 'string' || def.name.trim().length === 0) {
      return { ok: false, error: '智能体名称不能为空' }
    }
    if (typeof def.personaId !== 'string' || def.personaId.trim().length === 0) {
      return { ok: false, error: '人设 personaId 不能为空' }
    }
    if (!Array.isArray(def.toolIds)) {
      return { ok: false, error: 'toolIds 必须为数组' }
    }
    if (def.tags && !Array.isArray(def.tags)) {
      return { ok: false, error: 'tags 必须为数组' }
    }

    // 引用校验（尽力而为）
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { personaLoader } = require('../persona-loader')
      if (!personaLoader.getPersona(def.personaId)) {
        return { ok: false, error: `人设不存在: ${def.personaId}` }
      }
    } catch {
      /* personaLoader 未就绪时跳过 */
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { toolRegistry } = require('./tool-registry')
      for (const t of def.toolIds) {
        if (!toolRegistry.get(t)) {
          return { ok: false, error: `工具不存在: ${t}` }
        }
      }
    } catch {
      /* toolRegistry 未就绪时跳过 */
    }

    return { ok: true }
  }
}

/** 全局单例 */
export const agentStore = new AgentStore()
