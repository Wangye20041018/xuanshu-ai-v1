/**
 * 智能模型调度系统 — 模型画像管理
 *
 * 每个已注册文本模型的调度属性（速度/质量/上下文能力/适用任务/启用开关/优先级）。
 * 持久化到 electron-store（key: schedulerProfiles），与 model-registry 解耦：
 * registry 管"能否运行"，profile 管"该不该选它"。
 *
 * 默认画像（初始化时按 modelRegistry 注册情况补齐）：
 * - qwen-coder-9b   ：Qwopus3.5-9B-Coder-MTP，代码/日常主力（chat/quick/code/longctx）
 * - deepseek-math-9b：DeepSeek-V4-Pro-Qwen3.5-9B，数学/STEM/复杂推理（deep/code）
 *
 * 注册对齐采用动态过滤：凡 type === 'main' 的已注册文本模型均参与调度，
 * 新增/删除模型无需改本文件（见 list() 的 registeredIds 计算）。
 *
 * @module scheduler/profiles
 */

import { modelRegistry } from '../model-registry'
import { logger } from '../../shared/logger'
import { getStore } from '../ipc/config.ipc'
import type { ModelProfile, SchedulerTaskType } from './types'

const CONFIG_KEY = 'schedulerProfiles'

/** 默认画像（与注册模型 id 对应，初始化时合并） */
const DEFAULT_PROFILES: Omit<ModelProfile, 'name' | 'contextCap'>[] = [
  {
    id: 'qwen-coder-9b',
    speed: 8,
    quality: 8,
    role: '代码/日常主力 · 快速响应',
    enabled: true,
    priority: 1,
    suitedFor: ['chat', 'quick', 'code', 'longctx'],
    fallback: undefined,
  },
  {
    id: 'deepseek-math-9b',
    speed: 6,
    quality: 9,
    role: '数学/STEM/复杂推理',
    enabled: true,
    priority: 2,
    suitedFor: ['deep', 'code'],
    fallback: 'qwen-coder-9b',
  },
]

class ProfileManager {
  private cache: ModelProfile[] | null = null

  private getStore() {
    const store = getStore()
    if (!store) throw new Error('[SchedulerProfiles] config store 未初始化')
    return store
  }

  /** 读取（带缓存 + 与注册表自动对齐） */
  list(): ModelProfile[] {
    try {
      if (this.cache) return this.cache
      const store = this.getStore()
      let profiles = (store.get(CONFIG_KEY, []) as ModelProfile[])

      // 与 modelRegistry 对齐：注册表已删除的模型移出画像；新注册的补默认画像
      // 动态过滤：只保留 type === 'main' 的文本模型（vision/embedding 不参与文本调度），
      // 新增/删除模型无需修改本文件，系统自动跟随注册表。
      const registered = modelRegistry.list()
      const registeredIds = new Set(registered.filter(m => m.type === 'main').map(m => m.id))
      const existing = new Set(profiles.map(p => p.id))

      // 移除已下架
      profiles = profiles.filter(p => registeredIds.has(p.id))

      // 补齐默认画像（若注册表里有该模型且尚未有画像）
      for (const def of DEFAULT_PROFILES) {
        if (registeredIds.has(def.id) && !existing.has(def.id)) {
          const reg = registered.find(m => m.id === def.id)
          profiles.push({
            ...def,
            name: reg?.name || def.id,
            contextCap: reg?.contextSize || 2048,
          })
        }
      }

      // 更新名称/上下文能力（跟随注册表最新值）
      profiles = profiles.map(p => {
        const reg = registered.find(m => m.id === p.id)
        if (!reg) return p
        return { ...p, name: reg.name || p.name, contextCap: reg.contextSize || p.contextCap }
      })

      this.cache = profiles
      return profiles
    } catch (e) {
      logger.error('[SchedulerProfiles] list 失败:', e)
      return this.cache || []
    }
  }

  private save(profiles: ModelProfile[]): void {
    const store = this.getStore()
    store.set(CONFIG_KEY, profiles)
    this.cache = profiles
  }

  /** 更新单个画像（局部 patch） */
  update(id: string, patch: Partial<Omit<ModelProfile, 'id'>>): { success: boolean; profile?: ModelProfile; error?: string } {
    try {
      const profiles = this.list()
      const idx = profiles.findIndex(p => p.id === id)
      if (idx < 0) return { success: false, error: `画像 ${id} 不存在` }
      profiles[idx] = { ...profiles[idx], ...patch }
      this.save(profiles)
      logger.info(`[SchedulerProfiles] 更新画像: ${id}`)
      return { success: true, profile: profiles[idx] }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  }

  /** 批量重置为默认 */
  reset(): void {
    this.save([])
    this.cache = null
    this.list()
  }

  /** 强制刷新缓存（注册表变更后调用） */
  invalidate(): void {
    this.cache = null
  }
}

export const profileManager = new ProfileManager()

/** 根据任务类型挑选最合适（已启用 + 画像匹配）的模型 id 链 */
export function pickModelIds(taskType: SchedulerTaskType, topN = 3): string[] {
  const profiles = profileManager
    .list()
    .filter(p => p.enabled)
    .sort((a, b) => {
      // 优先看画像适用性，其次优先级
      const suitA = a.suitedFor.includes(taskType) ? 1 : 0
      const suitB = b.suitedFor.includes(taskType) ? 1 : 0
      if (suitA !== suitB) return suitB - suitA
      return a.priority - b.priority
    })
  return profiles.slice(0, topN).map(p => p.id)
}
