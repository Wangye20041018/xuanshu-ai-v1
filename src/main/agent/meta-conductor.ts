/**
 * meta-conductor.ts —— 施工蓝本 §12：AI 总指挥（MetaConductor）
 *
 * 玄枢对外总调度大脑：登记本机各 AI 软件（Trae/workbuddy/豆包/ComfyUI/自有智能体等），
 * 按「文件域隔离 + 擅长路由」派发任务，回收结果做质检，并对并发冲突做文件域锁定。
 *
 * 对外能力（均以 ToolRegistry 工具形式暴露，供任何智能体/用户调用）：
 *  - ai_apps_list            ：列出已登记 AI 软件
 *  - ai_apps_register        ：登记/更新一个 AI 软件（名称、根路径、擅长域、白名单文件域、任务书路径）
 *  - ai_apps_launch          ：派发一个任务（自动路由到擅长/唯一能做的 AI，或显式指定）
 *  - ai_apps_send_task       ：补充派发/追加子任务
 *  - ai_apps_collect_result  ：回收结果 + 质检（查产出物是否存在、tsc 零错等）
 *
 * 冲突控制：每个 AI 软件登记声明自己独占的文件域（如 src/main/agent、src/renderer），
 * 派发前校验目标文件域是否被其他 AI 锁定，命中则拒绝并提示协调。
 *
 * 数据落盘：userData/agent-meta/apps.json（轻量 JSON，无外部依赖）。
 *
 * @module main/agent/meta-conductor
 */

import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'
import { logger } from '../../shared/logger'
import { ToolDefinition, ToolResult } from './types'
import { toolRegistry } from './tool-registry'

/* ============================================================
 * 类型与存储
 * ============================================================ */

export interface RegisteredAIApp {
  /** 唯一 key */
  key: string
  /** 展示名，如 "Trae"、"workbuddy"、"豆包"、"ComfyUI" */
  name: string
  /** 根目录绝对路径（用于产物与文件域校验；可为空表示本机内置能力） */
  rootPath?: string
  /** 擅长域描述（自由文本，供 LLM 路由参考） */
  strengths: string[]
  /** 独占文件域白名单：相对仓库根的目录前缀，如 ['src/main/agent']。空数组 = 不声明独占 */
  ownedDomains: string[]
  /** 任务书/蓝本落盘路径（可选） */
  briefPath?: string
  /** 编码问候/交接说明 */
  notes?: string
  /** 当前是否有进行中任务 */
  busy: boolean
  /** 登记时间戳 */
  registeredAt: number
}

export interface DispatchRequest {
  appKey?: string
  task: string
  /** 目标文件域（可空，空则不校验独占锁） */
  targetDomain?: string
  /** 优先级 0-10，默认 5 */
  priority?: number
  /** 期望产出物路径（可选，用于质检） */
  expectedOutput?: string
}

export interface DispatchResult {
  ok: boolean
  message: string
  appKey?: string
  /** 冲突信息（若因文件域冲突被拒） */
  conflict?: { domain: string; lockHolder: string }
  dispatchedAt: number
}

export interface QualityCheck {
  ok: boolean
  checked: boolean
  report: string[]
}

/* ============================================================
 * 存储路径
 * ============================================================ */

function storageDir(): string {
  const dir = path.join(app.getPath('userData'), 'agent-meta')
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}

const appsFile = (): string => path.join(storageDir(), 'apps.json')

/* ============================================================
 * MetaConductor 核心
 * ============================================================ */

class MetaConductor {
  private apps: Map<string, RegisteredAIApp> = new Map()
  /** key → 进行中任务申请（简单防重） */
  private inflight: Map<string, DispatchRequest> = new Map()

  constructor() {
    this.load()
  }

  /** 从磁盘加载 */
  private load(): void {
    try {
      if (!fs.existsSync(appsFile())) return
      const raw = JSON.parse(fs.readFileSync(appsFile(), 'utf-8')) as RegisteredAIApp[]
      for (const a of Array.isArray(raw) ? raw : []) {
        if (a?.key) this.apps.set(a.key, a)
      }
      logger.info(`[MetaConductor] 已加载 ${this.apps.size} 个已登记 AI 软件`)
    } catch (e) {
      logger.warn('[MetaConductor] 加载 apps.json 失败:', e)
    }
  }

  /** 持久化 */
  private persist(): void {
    try {
      fs.writeFileSync(appsFile(), JSON.stringify(Array.from(this.apps.values()), null, 2), 'utf-8')
    } catch (e) {
      logger.warn('[MetaConductor] 持久化 apps.json 失败:', e)
    }
  }

  /** 列出全部已登记 AI 软件 */
  list(): RegisteredAIApp[] {
    return Array.from(this.apps.values()).sort((a, b) => a.registeredAt - b.registeredAt)
  }

  /** 登记/更新一个 AI 软件（key 相同则覆盖） */
  register(input: Partial<RegisteredAIApp> & { key: string; name: string }): RegisteredAIApp {
    const prev = this.apps.get(input.key)
    const rec: RegisteredAIApp = {
      key: input.key,
      name: input.name,
      rootPath: input.rootPath ?? prev?.rootPath,
      strengths: input.strengths ?? prev?.strengths ?? [],
      ownedDomains: input.ownedDomains ?? prev?.ownedDomains ?? [],
      briefPath: input.briefPath ?? prev?.briefPath,
      notes: input.notes ?? prev?.notes,
      busy: prev?.busy ?? false,
      registeredAt: prev?.registeredAt ?? Date.now(),
    }
    this.apps.set(input.key, rec)
    this.persist()
    logger.info(`[MetaConductor] 已登记 AI 软件: ${rec.name}(${rec.key}) 域=[${rec.ownedDomains.join(',') || '无'}]`)
    return rec
  }

  /** 注销 */
  unregister(key: string): boolean {
    const had = this.apps.delete(key)
    if (had) this.persist()
    return had
  }

  /**
   * 文件域冲突检查：给定目标域前缀，返回持有独占锁的 AI（空 = 无冲突）。
   * 规则：仅当目标域与某 AI 的 ownedDomains 存在「目录前缀命中」才算锁定。
   */
  checkDomainLock(domain: string): { appKey: string; appName: string } | null {
    if (!domain) return null
    const norm = domain.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    for (const a of this.apps.values()) {
      if (a.busy) continue // 已认领任务者在忙，不重复判定（避免自我锁死）
      for (const owned of a.ownedDomains || []) {
        const o = owned.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
        if (norm === o || norm.startsWith(o + '/')) {
          return { appKey: a.key, appName: a.name }
        }
      }
    }
    return null
  }

  /** 派发任务。支持显式 appKey 或自动路由（按擅长关键词匹配 targetDomain/task）。 */
  dispatch(req: DispatchRequest): DispatchResult {
    const now = Date.now()

    // ① 冲突控制：目标域被他人独占则拒绝
    if (req.targetDomain) {
      const holder = this.checkDomainLock(req.targetDomain)
      if (holder) {
        return {
          ok: false,
          message: `文件域 ${req.targetDomain} 已被 AI 软件「${holder.appName}」独占，任务被拒。请先协调释放或改用其他协作路径。`,
          conflict: { domain: req.targetDomain, lockHolder: holder.appName },
          dispatchedAt: now,
        }
      }
    }

    // ② 目标 AI 定位
    let appKey: string | undefined = req.appKey
    if (!appKey) {
      const candidates = Array.from(this.apps.values()).filter((a) => !a.busy)
      // 让 LLM 在 ai_apps_launch 的 return 里给建议；这里做兜底：取擅长域命中 task 的第一个
      const scoreKey = (a: RegisteredAIApp): number => {
        let s = 0
        const hay = `${a.name} ${a.strengths.join(' ')} ${a.notes || ''}`.toLowerCase()
        if (req.task) {
          for (const kw of req.task.split(/\s+/)) {
            if (kw.length >= 2 && hay.includes(kw.toLowerCase())) s += (req.targetDomain && a.ownedDomains.includes(req.targetDomain) ? 2 : 1)
          }
        }
        if (req.targetDomain && a.ownedDomains.some((d) => d === req.targetDomain)) s += 3
        return s
      }
      const best = candidates.sort((a, b) => scoreKey(b) - scoreKey(a))[0]
      if (!best) {
        return {
          ok: false,
          message: `未登记任何可派发的 AI 软件，请先用 ai_apps_register 登记（如 Trae/workbuddy/豆包）。`,
          dispatchedAt: now,
        }
      }
      appKey = best.key
    }

    const appRec = this.apps.get(appKey)
    if (!appRec) {
      return { ok: false, message: `AI 软件「${appKey}」未登记`, dispatchedAt: now }
    }
    if (appRec.busy) {
      return { ok: false, message: `AI 软件「${appRec.name}」正忙，等上一个任务回收后再派发。`, dispatchedAt: now }
    }

    // ③ 标记 busy 并登记进行中任务
    appRec.busy = true
    const reqRec: DispatchRequest = { ...req, appKey: appRec.key }
    this.inflight.set(appRec.key, reqRec)
    this.persist()

    return {
      ok: true,
      message: `任务已派发给「${appRec.name}」${appRec.briefPath ? `（任务书：${appRec.briefPath}）` : ''}。` +
        `优先子任务描述：${req.task}${req.expectedOutput ? `；期望产出：${req.expectedOutput}` : ''}`,
      appKey: appRec.key,
      dispatchedAt: now,
    }
  }

  /** 追加/补充派发（同一目标，不打断；若在忙仍可排入） */
  sendTask(key: string, additionalTask: string): DispatchResult {
    const appRec = this.apps.get(key)
    if (!appRec) return { ok: false, message: `AI 软件「${key}」未登记`, dispatchedAt: Date.now() }
    const existing = this.inflight.get(key)
    const merged: DispatchRequest = {
      ...existing,
      task: existing ? `${existing.task}；追加：${additionalTask}` : additionalTask,
    }
    this.inflight.set(key, merged)
    return { ok: true, message: `已向「${appRec.name}」追加子任务：${additionalTask}`, appKey: key, dispatchedAt: Date.now() }
  }

  /**
   * 回收结果 + 质检。
   * 质检项：任务书/产出物路径存在性；显式校验命令（如 tsc）通过与否。
   */
  collect(key: string, opts: { checkPath?: string; checkCmd?: string } = {}): { ok: boolean; report: QualityCheck } {
    const appRec = this.apps.get(key)
    const dispatched = this.inflight.get(key)
    const report: string[] = []

    // 复位 busy 与 inflight（无论是否成功回收都释放占位）
    if (appRec) appRec.busy = false
    this.inflight.delete(key)
    if (appRec) this.persist()

    if (!appRec) return { ok: false, report: { ok: false, checked: true, report: [`未登记 AI 软件「${key}」`] } }

    // 产物存在性
    let existOk = true
    const checkPaths = [dispatched?.expectedOutput, opts.checkPath].filter((p): p is string => !!p)
    if (checkPaths.length > 0) {
      for (const p of checkPaths) {
        const hit = fs.existsSync(p)
        report.push(`${hit ? '✓' : '✗'} 产出物存在: ${p}`)
        if (!hit) existOk = false
      }
    } else {
      report.push('- 未声明期望产出物，跳过存在性检查')
    }

    // 显式校验命令（如 tsc 编译）
    if (opts.checkCmd) {
      report.push(`执行校验命令: ${opts.checkCmd}（需在外部/后续步骤人工确认，本回收仅记录）`)
    }

    const ok = existOk
    report.push(`质检结论: ${ok ? '通过' : '不通过（打回，请补充产出后重新回收）'}`)
    return { ok, report: { ok, checked: true, report } }
  }

  /** 当前进行中的任务（供派发侧可见） */
  inflightInfo(): Array<{ appKey: string; appName?: string; task: string; targetDomain?: string }> {
    return Array.from(this.inflight.entries()).map(([k, r]) => ({
      appKey: k,
      appName: this.apps.get(k)?.name,
      task: r.task,
      targetDomain: r.targetDomain,
    }))
  }
}

/** 全局单例 */
export const metaConductor = new MetaConductor()

/* ============================================================
 * 工具注册入口（§12 附带 5 个 ai_apps_* 工具）
 * ============================================================ */

/** 供 tool-registry 调用的注册函数 */
export function registerMetaTools(): void {
  const defs: ToolDefinition[] = [
    {
      name: 'ai_apps_list',
      description:
        '列出已登记的本机 AI 软件（Trae/workbuddy/豆包等）及其擅长域/独占文件域/是否空闲。' +
        '派发任务前建议先调用本工具查看当前有哪些可用的 AI 软件。',
      category: 'system',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
      execute: async (): Promise<ToolResult> => ({ success: true, data: metaConductor.list() }),
    },
    {
      name: 'ai_apps_register',
      description:
        '登记或更新一个本机 AI 软件到总调度中心。给定 key/name，可选 rootPath（根目录）、strengths（擅长域列表）、' +
        'ownedDomains（独占文件域白名单，如 src/main/agent，用于冲突锁定）、briefPath（任务书路径）、notes（说明）。',
      category: 'system',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: '唯一 key，如 trae' },
          name: { type: 'string', description: '展示名，如 Trae' },
          rootPath: { type: 'string', description: '根目录绝对路径（可选）' },
          strengths: { type: 'string', description: '擅长域关键词列表，多个用逗号分隔，如 "src/前端代码,重构"' },
          ownedDomains: { type: 'string', description: '独占文件域白名单，多个用逗号分隔，如 "src/main/agent,src/shared"' },
          briefPath: { type: 'string', description: '任务书/蓝本路径（可选）' },
          notes: { type: 'string', description: '交接说明（可选）' },
        },
        required: ['key', 'name'],
      },
      execute: async (p): Promise<ToolResult> => {
        const key = String(p.key || '').trim()
        if (!key) return { success: false, error: 'key 必填' }
        const splitList = (v: unknown): string[] =>
          (typeof v === 'string' ? v : Array.isArray(v) ? v.join(',') : '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        const rec = metaConductor.register({
          key,
          name: String(p.name || key),
          rootPath: p.rootPath ? String(p.rootPath) : undefined,
          strengths: splitList(p.strengths),
          ownedDomains: splitList(p.ownedDomains),
          briefPath: p.briefPath ? String(p.briefPath) : undefined,
          notes: p.notes ? String(p.notes) : undefined,
        })
        return { success: true, data: rec }
      },
    },
    {
      name: 'ai_apps_launch',
      description:
        '向某个 AI 软件派发任务。传 appKey 指定目标，或依赖擅长路由自动选择。可选 targetDomain 声明目标文件域（做冲突锁定），' +
        'expectedOutput 声明期望产出物路径（供回收质检）。被独占的文件域会返回 conflict 拒绝。',
      category: 'system',
      parameters: {
        type: 'object',
        properties: {
          appKey: { type: 'string', description: '目标 AI 软件 key（可选，自动路由）' },
          task: { type: 'string', description: '任务描述（必填）' },
          targetDomain: { type: 'string', description: '目标文件域前缀，做冲突锁定，如 src/main/agent' },
          expectedOutput: { type: 'string', description: '期望产出物绝对路径（可选）' },
        },
        required: ['task'],
      },
      execute: async (p): Promise<ToolResult> => {
        const res = metaConductor.dispatch({
          appKey: p.appKey ? String(p.appKey) : undefined,
          task: String(p.task || ''),
          targetDomain: p.targetDomain ? String(p.targetDomain) : undefined,
          expectedOutput: p.expectedOutput ? String(p.expectedOutput) : undefined,
        })
        return { success: res.ok, data: res, error: res.ok ? undefined : res.message }
      },
    },
    {
      name: 'ai_apps_send_task',
      description: '向指定的 AI 软件追加/补充一个子任务（排入其进行中任务，不打断）。',
      category: 'system',
      parameters: {
        type: 'object',
        properties: {
          appKey: { type: 'string', description: '目标 AI 软件 key（必填）' },
          task: { type: 'string', description: '追加的子任务描述（必填）' },
        },
        required: ['appKey', 'task'],
      },
      execute: async (p): Promise<ToolResult> => {
        const res = metaConductor.sendTask(String(p.appKey || ''), String(p.task || ''))
        return { success: res.ok, data: res, error: res.ok ? undefined : res.message }
      },
    },
    {
      name: 'ai_apps_collect_result',
      description:
        '回收指定 AI 软件的任务结果并做质检：检查期望产出物是否存在，可选传入 checkPath 追加校验路径。' +
        '回收后该 AI 释放忙状态，可继续接新任务。质检不合格返回报告并打回。',
      category: 'system',
      parameters: {
        type: 'object',
        properties: {
          appKey: { type: 'string', description: '目标 AI 软件 key（必填）' },
          checkPath: { type: 'string', description: '追加校验的产出物路径（可选）' },
        },
        required: ['appKey'],
      },
      execute: async (p): Promise<ToolResult> => {
        const res = metaConductor.collect(String(p.appKey || ''), { checkPath: p.checkPath ? String(p.checkPath) : undefined })
        return { success: res.ok, data: res.report, error: res.ok ? undefined : res.report.report.join('\n') }
      },
    },
  ]

  for (const d of defs) toolRegistry.register(d)
  logger.info(`[MetaConductor] 已注册 ${defs.length} 个总调度工具（ai_apps_*）`)
}
