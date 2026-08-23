/**
 * 自我改造 —— 核心服务
 *
 * 职责：git 快照 / diff 生成 / 原子写入 + 失败回退 / 回滚 / 审计日志。
 *
 * 【安全底线】
 * 1. 所有路径在写入前经 whitelist 强制校验（渲染层输入一律不可信）；
 * 2. 写前 git commit 快照 + 标签，写后校验，失败 `git checkout -- <files>` 回退；
 * 3. 写权限仅存在于本模块（main 进程），渲染层只能走 IPC；
 * 4. writeEnabled 默认 false，getCapabilities 返回当前状态。
 *
 * @module main/self-modify/self-modify.service
 */

import { app } from 'electron'
import fs from 'fs'
import path from 'path'
import { execFile, execFileSync } from 'child_process'
import { createLogger } from '../utils/logging'
import {
  isAllowed,
  classifyLevel,
  normalizeRel,
  maxLevel,
  LIMITS,
  WHITELIST_DIRS,
  BLACKLIST_SEGMENTS,
  BLACKLIST_FILENAMES,
  L3_ARCHITECTURE_PATHS,
} from './whitelist'
import type {
  ApplyResult,
  ChangeSet,
  DiffLine,
  DiffResult,
  FileDiff,
  FileListEntry,
  FileReadResult,
  GenerateResult,
  ModifyLevel,
  RollbackResult,
  SelfModifyCapabilities,
  SelfModifyEffect,
  SelfModifyProgress,
  Snapshot,
} from './self-modify-types'

const logger = createLogger('SelfModify')

/** 读取单文件上限（字符数），超出则截断并标记 */
const MAX_READ_CHARS = 200_000

/** 快照索引文件（userData 下） */
function snapshotsPath(): string {
  return path.join(app.getPath('userData'), 'self-modify-snapshots.json')
}

/** 审计日志文件（userData 下） */
function auditLogPath(): string {
  return path.join(app.getPath('userData'), 'self-modify.log')
}

export class SelfModifyService {
  private repoRoot: string | null = null
  private gitAvailable = false
  private writeEnabled = false

  constructor() {
    this.detectRepo()
  }

  /** 探测仓库根（开发模式下 app.getAppPath() 即项目根）并校验 git 可用性 */
  private detectRepo(): void {
    try {
      const root = app.getAppPath()
      if (root && fs.existsSync(path.join(root, 'package.json'))) {
        this.repoRoot = root
      }
    } catch (e) {
      logger.warn(`[SelfModify] 无法定位仓库根: ${e instanceof Error ? e.message : String(e)}`)
    }
    this.gitAvailable = this.repoRoot ? this.isGitRepo(this.repoRoot) : false
  }

  private isGitRepo(root: string): boolean {
    try {
      execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root, stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  }

  /* ============================================================
   * 能力查询
   * ============================================================ */
  getCapabilities(): SelfModifyCapabilities {
    return {
      writeEnabled: this.writeEnabled,
      repoRoot: this.repoRoot || '',
      whitelist: [...WHITELIST_DIRS],
      blacklist: [...BLACKLIST_FILENAMES, ...L3_ARCHITECTURE_PATHS],
      levels: [
        { level: 'L0', description: '只读：列文件 / 读源码', writable: false },
        { level: 'L1', description: '低风险：文案 / 样式 token / 人设 / 文档', writable: true },
        { level: 'L2', description: '中风险：组件行为 / 业务 handler 纯逻辑（逐次 diff 确认）', writable: true },
        { level: 'L3', description: '高风险：agent 核心 / preload / register / IPC 骨架（禁止写入）', writable: false },
      ],
      limits: {
        maxFilesPerChange: LIMITS.MAX_FILES_PER_CHANGE,
        maxLinesPerChange: LIMITS.MAX_LINES_PER_CHANGE,
      },
    }
  }

  /** 设置写模式开关（仅由 main 内部 / IPC 调用，渲染层经 config 开关间接控制） */
  setWriteEnabled(enabled: boolean): void {
    this.writeEnabled = enabled === true
    logger.info(`[SelfModify] 写模式 ${this.writeEnabled ? '开启' : '关闭'}`)
  }

  /* ============================================================
   * 只读：列文件 / 读文件
   * ============================================================ */
  listFiles(dir?: string): FileListEntry[] {
    if (!this.repoRoot) return []
    const base = dir && normalizeRel(dir) && isAllowed(dir) ? normalizeRel(dir)! : null

    const results: FileListEntry[] = []
    const dirsToWalk: string[] = base ? [base] : [...WHITELIST_DIRS]

    for (const relDir of dirsToWalk) {
      const abs = path.join(this.repoRoot, relDir)
      if (!fs.existsSync(abs)) continue
      try {
        this.walkRecursive(relDir.replace(/\/$/, ''), abs, results, 0)
      } catch (e) {
        logger.warn(`[SelfModify] 遍历 ${relDir} 失败: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    return results.sort((a, b) => a.path.localeCompare(b.path))
  }

  /** 深度优先遍历（限制深度，避免扫到超大树） */
  private walkRecursive(rel: string, abs: string, out: FileListEntry[], depth: number): void {
    if (depth > 8) return
    if (out.length >= 2000) return
    let dirents: fs.Dirent[]
    try {
      dirents = fs.readdirSync(abs, { withFileTypes: true })
    } catch {
      return
    }
    for (const d of dirents) {
      const childRel = rel ? `${rel}/${d.name}` : d.name
      const childAbs = path.join(abs, d.name)
      if (d.isDirectory()) {
        // 跳过黑名单目录
        if (childRel.split('/').some((s) => (BLACKLIST_SEGMENTS as readonly string[]).includes(s))) continue
        this.walkRecursive(childRel, childAbs, out, depth + 1)
      } else if (d.isFile()) {
        if (!isAllowed(childRel)) continue
        let size = 0
        try {
          size = fs.statSync(childAbs).size
        } catch {
          /* ignore */
        }
        out.push({ path: childRel, size, level: classifyLevel(childRel) })
      }
    }
  }

  readFile(rel: string): FileReadResult {
    const p = normalizeRel(rel)
    if (!p || !this.repoRoot) {
      return { path: rel, content: '', truncated: false, totalLines: 0, level: 'L0' }
    }
    if (!isAllowed(p)) {
      return { path: p, content: '', truncated: false, totalLines: 0, level: 'L3' }
    }
    const abs = path.join(this.repoRoot, p)
    if (!fs.existsSync(abs)) {
      return { path: p, content: '', truncated: false, totalLines: 0, level: classifyLevel(p) }
    }
    try {
      const raw = fs.readFileSync(abs, 'utf-8')
      const truncated = raw.length > MAX_READ_CHARS
      const content = truncated ? raw.slice(0, MAX_READ_CHARS) : raw
      const totalLines = raw.split('\n').length
      return { path: p, content, truncated, totalLines, level: classifyLevel(p) }
    } catch (e) {
      logger.error(`[SelfModify] 读取 ${p} 失败: ${e instanceof Error ? e.message : String(e)}`)
      return { path: p, content: '', truncated: false, totalLines: 0, level: classifyLevel(p) }
    }
  }

  /* ============================================================
   * diff 生成
   * ============================================================ */
  previewDiff(changeSet: ChangeSet): { result?: DiffResult; error?: string } {
    const validated = this.validateChangeSet(changeSet)
    if (!validated.ok) return { error: validated.error }

    const files: FileDiff[] = []
    let additions = 0
    let deletions = 0
    let risk: ModifyLevel = 'L0'

    for (const fc of changeSet.files) {
      const p = normalizeRel(fc.path)!
      const oldContent = this.readCurrentContent(p)
      const oldLines = oldContent ? oldContent.split('\n') : []
      const newLines = fc.content.split('\n')
      const lines = diffLines(oldLines, newLines)

      let add = 0
      let del = 0
      for (const l of lines) {
        if (l.type === 'add') add++
        else if (l.type === 'del') del++
      }
      additions += add
      deletions += del
      risk = maxLevel(risk, classifyLevel(p))
      files.push({ path: p, additions: add, deletions: del, lines })
    }

    const diffText = files
      .map((f) => `--- ${f.path}\n+++ ${f.path}\n${f.lines.map((l) => `${l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' '} ${l.text}`).join('\n')}`)
      .join('\n\n')

    return {
      result: {
        filesAffected: files.map((f) => f.path),
        additions,
        deletions,
        diffText,
        files,
        estimatedRisk: risk,
      },
    }
  }

  private readCurrentContent(rel: string): string | null {
    if (!this.repoRoot) return null
    const abs = path.join(this.repoRoot, rel)
    if (!fs.existsSync(abs)) return null
    try {
      return fs.readFileSync(abs, 'utf-8')
    } catch {
      return null
    }
  }

  /* ============================================================
   * apply：快照 → 写 → 校验 → 失败回退
   * ============================================================ */
  async apply(changeSet: ChangeSet, onProgress?: (p: SelfModifyProgress) => void): Promise<ApplyResult> {
    if (!this.writeEnabled) {
      return { success: false, filesWritten: [], effect: 'none', error: '写模式未开启，请在自我改造页开启后再试' }
    }
    if (!this.repoRoot || !this.gitAvailable) {
      return { success: false, filesWritten: [], effect: 'none', error: 'git 快照不可用，为安全起见拒绝写入' }
    }

    const validated = this.validateChangeSet(changeSet)
    if (!validated.ok) {
      return { success: false, filesWritten: [], effect: 'none', error: validated.error }
    }

    const rels = changeSet.files.map((f) => normalizeRel(f.path)!)
    const effect = computeEffect(rels)

    onProgress?.({ phase: 'snapshot', message: '正在创建 git 快照...' })
    let snapshotHash: string
    try {
      snapshotHash = await this.createSnapshot()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { success: false, filesWritten: [], effect: 'none', error: `git 快照失败: ${msg}` }
    }

    const absPaths = rels.map((r) => path.join(this.repoRoot!, r))

    try {
      // 逐文件写入
      for (let i = 0; i < rels.length; i++) {
        onProgress?.({ phase: 'write', message: `写入 ${rels[i]}`, file: rels[i] })
        fs.mkdirSync(path.dirname(absPaths[i]), { recursive: true })
        fs.writeFileSync(absPaths[i], changeSet.files[i].content, 'utf-8')
      }

      // 校验：回读确认内容一致
      onProgress?.({ phase: 'verify', message: '校验写入结果...' })
      for (let i = 0; i < rels.length; i++) {
        const written = fs.readFileSync(absPaths[i], 'utf-8')
        if (written !== changeSet.files[i].content) {
          throw new Error(`写入校验不一致: ${rels[i]}`)
        }
      }

      // 记录快照 + 审计
      this.recordSnapshot({ hash: snapshotHash, createdAt: Date.now(), files: rels, summary: changeSet.summary })
      this.audit('apply', changeSet.summary, snapshotHash, rels)
      onProgress?.({ phase: 'done', message: '写入完成' })

      return { success: true, snapshotHash, filesWritten: rels, effect }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      logger.error(`[SelfModify] apply 失败，执行回退: ${e instanceof Error ? e.message : String(e)}`)
      onProgress?.({ phase: 'rollback', message: `写入失败，正在回退: ${msg}` })
      const rolledBack = await this.rollbackToIndex(rels)
      this.audit('apply-failed', `${changeSet.summary} —— ${msg}`, snapshotHash, rels)
      return {
        success: false,
        snapshotHash,
        filesWritten: [],
        effect: 'none',
        error: `${msg}${rolledBack ? '' : '（且回退失败，请检查 git 状态）'}`,
      }
    }
  }

  /** 创建 git 快照：git add -A && git commit（空变更则跳过 commit）+ 轻量标签 */
  private async createSnapshot(): Promise<string> {
    await this.git(['add', '-A'])
    try {
      await this.git(['commit', '-m', `self-modify:snapshot ${Date.now()}`])
    } catch (e) {
      // 无变更可提交（working tree clean）是正常情况，忽略
      const msg = e instanceof Error ? e.message : String(e)
      if (!/nothing to commit|no changes added/i.test(msg)) throw e
    }
    const { stdout } = await this.git(['rev-parse', 'HEAD'])
    const hash = stdout.trim()
    try {
      await this.git(['tag', `self-modify-snapshot-${Date.now()}`, hash])
    } catch {
      /* 标签失败不影响快照 */
    }
    return hash
  }

  /** 回退到 index（即快照 commit 的内容） */
  private async rollbackToIndex(rels: string[]): Promise<boolean> {
    try {
      await this.git(['checkout', '--', ...rels])
      return true
    } catch (e) {
      logger.error(`[SelfModify] 回退失败: ${e instanceof Error ? e.message : String(e)}`)
      return false
    }
  }

  /* ============================================================
   * rollback：回退到指定快照
   * ============================================================ */
  async rollback(snapshotHash: string, onProgress?: (p: SelfModifyProgress) => void): Promise<RollbackResult> {
    if (!this.repoRoot || !this.gitAvailable) {
      return { success: false, effect: 'none', error: 'git 快照不可用' }
    }
    const snap = this.findSnapshot(snapshotHash)
    try {
      onProgress?.({ phase: 'rollback', message: `回退到快照 ${snapshotHash.slice(0, 8)}` })
      if (snap && snap.files.length > 0) {
        await this.git(['checkout', snapshotHash, '--', ...snap.files])
      } else {
        await this.git(['checkout', snapshotHash, '--', '.'])
      }
      const effect = computeEffect(snap?.files || [])
      this.audit('rollback', `回退到快照 ${snapshotHash}`, snapshotHash, snap?.files || [])
      return { success: true, restoredFiles: snap?.files || [], effect }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { success: false, effect: 'none', error: msg }
    }
  }

  listSnapshots(): Snapshot[] {
    try {
      if (!fs.existsSync(snapshotsPath())) return []
      const raw = fs.readFileSync(snapshotsPath(), 'utf-8')
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? (parsed as Snapshot[]) : []
    } catch {
      return []
    }
  }

  /* ============================================================
   * 本地模型生成（尽力而为）
   * ============================================================ */
  async generate(requirement: string): Promise<GenerateResult> {
    try {
      const mod: { modelManager: any } = await import('../model-manager')
      const prompt = buildGeneratePrompt(requirement)
      const response: any = await mod.modelManager.generateResponse(prompt, { temperature: 0.4, maxTokens: 2048 })
      const text: string = typeof response === 'string' ? response : response?.content || response?.text || ''
      if (!text) return { success: false, plan: '', error: '模型未返回内容' }

      const changeSet = tryParseChangeSet(text)
      return { success: true, plan: text, changeSet }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { success: false, plan: '', error: `生成失败: ${msg}` }
    }
  }

  /* ============================================================
   * 校验 + 持久化辅助
   * ============================================================ */
  private validateChangeSet(changeSet: ChangeSet): { ok: boolean; error?: string } {
    if (!changeSet || !Array.isArray(changeSet.files) || changeSet.files.length === 0) {
      return { ok: false, error: '变更集为空' }
    }
    if (changeSet.files.length > LIMITS.MAX_FILES_PER_CHANGE) {
      return { ok: false, error: `单次改动文件数超过上限（≤${LIMITS.MAX_FILES_PER_CHANGE}）` }
    }
    const seen = new Set<string>()
    for (const fc of changeSet.files) {
      const p = normalizeRel(fc.path)
      if (!p) return { ok: false, error: `非法路径: ${fc.path}` }
      if (seen.has(p)) return { ok: false, error: `重复文件: ${p}` }
      seen.add(p)
      if (!isAllowed(p)) {
        return { ok: false, error: `路径不在白名单或命中黑名单: ${p}` }
      }
      const level = classifyLevel(p)
      if (level === 'L3') {
        return { ok: false, error: `禁止改动架构性文件（L3）: ${p}` }
      }
      if (typeof fc.content !== 'string') {
        return { ok: false, error: `文件内容必须为字符串: ${p}` }
      }
      if (fc.content.trim().length === 0) {
        return { ok: false, error: `禁止整文件删除（内容为空）: ${p}` }
      }
    }
    const totalLines = changeSet.files.reduce((s, f) => s + f.content.split('\n').length, 0)
    if (totalLines > LIMITS.MAX_LINES_PER_CHANGE) {
      return { ok: false, error: `单次改动总行数超过上限（≤${LIMITS.MAX_LINES_PER_CHANGE}）` }
    }
    return { ok: true }
  }

  private git(args: string[]): Promise<{ stdout: string; stderr: string }> {
    const root = this.repoRoot
    if (!root) return Promise.reject(new Error('repoRoot 未初始化'))
    return new Promise((resolve, reject) => {
      execFile('git', args, { cwd: root, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) reject(err)
        else resolve({ stdout: String(stdout), stderr: String(stderr) })
      })
    })
  }

  private recordSnapshot(snap: Snapshot): void {
    try {
      const list = this.listSnapshots()
      list.unshift(snap)
      // 最多保留最近 50 条
      fs.writeFileSync(snapshotsPath(), JSON.stringify(list.slice(0, 50), null, 2), 'utf-8')
    } catch (e) {
      logger.error(`[SelfModify] 记录快照失败: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  private findSnapshot(hash: string): Snapshot | undefined {
    return this.listSnapshots().find((s) => s.hash === hash)
  }

  private audit(action: string, summary: string, hash: string, files: string[]): void {
    try {
      const line = JSON.stringify({
        ts: new Date().toISOString(),
        action,
        summary,
        snapshotHash: hash,
        files,
      })
      fs.appendFileSync(auditLogPath(), line + '\n', 'utf-8')
    } catch (e) {
      logger.error(`[SelfModify] 审计日志写入失败: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
}

/* ============================================================
 * 纯函数：diff / 生效方式 / 模型 prompt
 * ============================================================ */

/** 基于 LCS 的行级 diff（文件 ≤300 行，O(n*m) 足够） */
export function diffLines(oldLines: string[], newLines: string[]): DiffLine[] {
  const n = oldLines.length
  const m = newLines.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        oldLines[i] === newLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }

  const ops: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      ops.push({ type: 'context', text: oldLines[i] })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: 'del', text: oldLines[i] })
      i++
    } else {
      ops.push({ type: 'add', text: newLines[j] })
      j++
    }
  }
  while (i < n) {
    ops.push({ type: 'del', text: oldLines[i] })
    i++
  }
  while (j < m) {
    ops.push({ type: 'add', text: newLines[j] })
    j++
  }
  return ops
}

/** 根据改动文件集合推导生效方式（relaunch 优先级最高） */
export function computeEffect(rels: string[]): SelfModifyEffect {
  const hasMain = rels.some((r) => r.startsWith('src/main/'))
  const hasRenderer = rels.some((r) => r.startsWith('src/renderer/'))
  if (hasMain) return 'relaunch'
  if (hasRenderer) return 'reload'
  return 'hot'
}

/** 构建本地模型的改造生成 prompt */
function buildGeneratePrompt(requirement: string): string {
  return `你是玄枢AI的自我改造模块。请根据用户需求生成对代码库的改动。
只允许改动以下白名单目录内的文件：${WHITELIST_DIRS.join('、')}
禁止改动：${[...BLACKLIST_FILENAMES, ...L3_ARCHITECTURE_PATHS].join('、')}

请输出严格 JSON（不要输出其他文字），格式如下：
{"summary":"改动摘要","files":[{"path":"相对路径","content":"完整新内容","mode":"overwrite"}]}

用户需求：${requirement}`
}

/** 尝试从模型输出中解析 ChangeSet；失败返回 undefined */
function tryParseChangeSet(text: string): ChangeSet | undefined {
  try {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start < 0 || end <= start) return undefined
    const json = text.slice(start, end + 1)
    const parsed = JSON.parse(json)
    if (parsed && Array.isArray(parsed.files)) {
      return {
        summary: String(parsed.summary || '模型生成'),
        files: parsed.files.map((f: any) => ({
          path: String(f.path || ''),
          content: String(f.content || ''),
          mode: f.mode === 'patch' ? 'patch' : 'overwrite',
        })),
      }
    }
    return undefined
  } catch {
    return undefined
  }
}

/** 全局单例 */
export const selfModifyService = new SelfModifyService()
