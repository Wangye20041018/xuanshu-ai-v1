/**
 * 结构化上下文组包 —— 全局骨架 MEMORY.md + 会话摘要 + RAM 常驻层
 *
 * 三层结构化上下文（替代「压缩即删除历史」的旧语义）：
 *   L0    系统层（固定 system prompt）
 *   L0.5  全局骨架层（MEMORY.md：工程/用户常驻记忆，注入组包，RAM 缓存）
 *   L0.6  会话摘要层（压缩触发的会话摘要 + 运行记录，RAM 常驻 + 每日落盘）
 *   L1    记忆层（RAG 向量检索注入）
 *   L2    历史层（滑动窗口 + 截断，保留全文语义，不删除）
 *   L3    当前层（当前轮消息）
 *
 * 语义约束：压缩产生的是「摘要」，绝不删除历史；全文仍走既有落盘
 * （history.json / vector-store.json），摘要/骨架/常用信息放内存（RAM 常驻）。
 */

import { app } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { createLogger } from '../../shared/logger'

const logger = createLogger('StructuredMemory')

/* ============================================================
 * 全局骨架层（MEMORY.md）
 * ============================================================ */

/** 默认骨架模板（首次创建时写入） */
const DEFAULT_SKELETON = `# 全局记忆骨架 (MEMORY.md)

> 本文件由玄枢AI 结构化上下文组包自动维护，作为跨会话的常驻上下文骨架注入组包。
> 语义：常驻记忆（放内存、注入组包），不随压缩删除；全文落盘于此。

## 项目/用户概况
- 工程: 玄枢AI (xuanshu-ai-dev)

## 全局目标与工作约定
- 上下文压缩 = 三层结构化组包（骨架 + 会话摘要 + 当前窗口），不得把压缩改成删除历史
- 云端接入以 providers 为唯一真相源，apiKey 用 safeStorage 加密
- 改动须引用真实文件行号，禁止臆测与假显示

## 运行记录
- (空，等待首次运行记录写入)
`

export class MemorySkeletonService {
  private cached: string | null = null
  private skeletonPath: string | null = null

  private resolvePath(): string {
    if (!this.skeletonPath) {
      this.skeletonPath = join(app.getPath('userData'), 'data', 'MEMORY.md')
    }
    return this.skeletonPath
  }

  /** 确保骨架文件存在（不存在则写入默认模板），返回内容并写入 RAM 缓存 */
  ensureSkeleton(): string {
    const path = this.resolvePath()
    try {
      if (!existsSync(path)) {
        mkdirSync(join(path, '..'), { recursive: true })
        writeFileSync(path, DEFAULT_SKELETON, 'utf-8')
        logger.info(`[StructuredMemory] 已创建全局骨架: ${path}`)
      }
      this.cached = readFileSync(path, 'utf-8')
      return this.cached
    } catch (e) {
      logger.warn('[StructuredMemory] ensureSkeleton 失败，使用默认骨架兜底:', e)
      this.cached = DEFAULT_SKELETON
      return this.cached
    }
  }

  /** 读取全局骨架（优先 RAM 缓存，未缓存时读盘） */
  getSkeleton(): string {
    if (this.cached !== null) return this.cached
    const path = this.resolvePath()
    try {
      if (existsSync(path)) {
        this.cached = readFileSync(path, 'utf-8')
      } else {
        this.cached = this.ensureSkeleton()
      }
    } catch (e) {
      logger.warn('[StructuredMemory] getSkeleton 读盘失败:', e)
      this.cached = DEFAULT_SKELETON
    }
    return this.cached
  }

  /** 追加一条运行记录到 MEMORY.md（同时更新 RAM 缓存并落盘） */
  appendNote(note: string): void {
    const path = this.resolvePath()
    try {
      const current = this.getSkeleton()
      const stamp = new Date()
      const line = `- ${stamp.getFullYear()}-${String(stamp.getMonth() + 1).padStart(2, '0')}-${String(stamp.getDate()).padStart(2, '0')} ${String(stamp.getHours()).padStart(2, '0')}:${String(stamp.getMinutes()).padStart(2, '0')} ${note}`
      // 确保落点：写入「## 运行记录」小节末尾
      const sectionIdx = current.indexOf('## 运行记录')
      const content = sectionIdx >= 0
        ? current.slice(0, sectionIdx) + '## 运行记录\n' + line + '\n' + current.slice(sectionIdx).split('\n').slice(1).join('\n')
        : current + '\n## 运行记录\n' + line + '\n'
      mkdirSync(join(path, '..'), { recursive: true })
      writeFileSync(path, content, 'utf-8')
      this.cached = content
      logger.info(`[StructuredMemory] 已写入运行记录: ${note}`)
    } catch (e) {
      logger.warn('[StructuredMemory] appendNote 失败:', e)
    }
  }

  /** 手动注入/覆盖骨架（供上层把最新骨架写入内存） */
  setCached(content: string): void {
    this.cached = content
  }

  /** 读取骨架文件中「运行记录」小节最近 N 条（供组包注入，控制 token 预算） */
  getRecentNotes(limit = 5): string[] {
    const current = this.getSkeleton()
    const sectionIdx = current.indexOf('## 运行记录')
    if (sectionIdx < 0) return []
    const block = current.slice(sectionIdx)
    const lines = block.split('\n').filter(l => l.trim().startsWith('- ')).map(l => l.trim().slice(2))
    return lines.slice(-limit)
  }
}

/** 全局骨架单例（RAM 常驻） */
export const memorySkeleton = new MemorySkeletonService()

/* ============================================================
 * 会话摘要层（RAM 常驻 + 每日落盘）
 * ============================================================ */

export interface SessionSummaryRecord {
  /** 会话 id（无则用 shared 全局会话） */
  sessionId: string
  /** 摘要角色来源：compression=压缩触发 | runtime=运行记录 */
  source: 'compression' | 'runtime'
  /** 摘要文本 */
  summary: string
  /** 关联元信息 */
  meta?: { rounds?: number; mode?: string; model?: string }
  /** 记录时间戳 */
  timestamp: number
}

export class SessionSummaryStore {
  /** RAM 常驻摘要列表（最新在前） */
  private ram: SessionSummaryRecord[] = []
  private summariesDir: string | null = null
  private readonly RAM_CAP = 50

  private resolveDir(): string {
    if (!this.summariesDir) {
      this.summariesDir = join(app.getPath('userData'), 'data', 'context-summaries')
    }
    return this.summariesDir
  }

  /** 今日摘要文件路径（每日一个 jsonl，append-only，留作全文存档） */
  private todayPath(): string {
    const d = new Date()
    const name = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.jsonl`
    return join(this.resolveDir(), name)
  }

  /** 加载历史今日摘要入 RAM（init 时调用；不重复加载已缓存的） */
  loadTodayIntoRam(): void {
    const path = this.todayPath()
    try {
      if (!existsSync(path)) return
      const lines = readFileSync(path, 'utf-8').split('\n').filter(Boolean)
      const loaded: SessionSummaryRecord[] = []
      for (const line of lines) {
        try { loaded.push(JSON.parse(line)) } catch { /* skip bad line */ }
      }
      this.ram = [...loaded.slice(-this.RAM_CAP).reverse(), ...this.ram].slice(0, this.RAM_CAP)
    } catch (e) {
      logger.warn('[StructuredMemory] loadTodayIntoRam 失败:', e)
    }
  }

  /** 记录一条会话摘要：先入 RAM（常驻），再追加落盘今日文件（全文存档） */
  record(rec: Omit<SessionSummaryRecord, 'timestamp'>): void {
    const full: SessionSummaryRecord = { ...rec, timestamp: Date.now() }
    this.ram.unshift(full)
    if (this.ram.length > this.RAM_CAP) this.ram.length = this.RAM_CAP
    try {
      const dir = this.resolveDir()
      mkdirSync(dir, { recursive: true })
      writeFileSync(this.todayPath(), JSON.stringify(full) + '\n', { flag: 'a', encoding: 'utf-8' })
      logger.info(`[StructuredMemory] 会话摘要已记录（${rec.source}/${rec.sessionId}）`)
    } catch (e) {
      logger.warn('[StructuredMemory] 摘要落盘失败（内存保留）:', e)
    }
  }

  /** 组装供注入组包的摘要文本（RAM 常量读取；按条数与字符预算裁剪） */
  composeInjection(limit = 3, charBudget = 4000): string {
    if (this.ram.length === 0) return ''
    const recent = this.ram.slice(0, limit)
    let out = ''
    for (const r of recent) {
      const line = `- [${new Date(r.timestamp).toISOString().slice(0, 16).replace('T', ' ')}]${r.source === 'compression' ? '[会话摘要]' : '[运行记录]'} ${r.summary}`.trim()
      if (out.length + line.length > charBudget) break
      out += line + '\n'
    }
    return out.trim()
  }
}

/** 会话摘要存储单例（RAM 常驻） */
export const sessionSummaryStore = new SessionSummaryStore()

/** 初始化：确保骨架存在 + 今日摘要加载入 RAM（应在应用启动/首个会话前调用一次） */
export function initStructuredMemory(): void {
  memorySkeleton.ensureSkeleton()
  sessionSummaryStore.loadTodayIntoRam()
  logger.info('[StructuredMemory] 结构化上下文初始化完成（骨架 + 摘要 RAM 常驻）')
}
