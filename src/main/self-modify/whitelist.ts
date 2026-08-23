/**
 * 自我改造 —— 路径白名单 / 黑名单 / 分级规则
 *
 * 【安全底线】本模块是"路径信任"的唯一真源，所有渲染进程传入的路径一律视为不可信，
 * 必须在写入前经过 normalizeRel + isAllowed + classifyLevel 三重校验。
 *
 * 【大小写不敏感】目标平台 Windows/NTFS 文件系统大小写不敏感，攻击者可用大小写变体
 * （如 `src/main/INDEX.ts`）绕过黑名单命中白名单。因此所有黑/白名单与路径的比较一律
 * 先 `toLowerCase()` 再比较（见 *_LOWER 常量），彻底封死大小写绕过。
 *
 * @module main/self-modify/whitelist
 */

import path from 'path'
import type { ModifyLevel } from './self-modify-types'

/** 允许改造的目录（相对仓库根，统一正斜杠，末尾带 /） */
export const WHITELIST_DIRS = [
  'src/renderer/',
  'src/main/',
  'src/shared/',
  'personas/',
  'docs/',
] as const

/** 绝对禁止的目录 / 文件名段（匹配路径中的任意段） */
export const BLACKLIST_SEGMENTS = [
  'node_modules',
  '.git',
  'out',
  'dist',
  'engine',
  'resources',
  '.trash_staging',
  'output',
] as const

/** 绝对禁止的文件名（精确匹配 basename） */
export const BLACKLIST_FILENAMES = [
  'package.json',
  'package-lock.json',
  'electron-builder.yml',
  'electron-builder.portable.yml',
  'vite.config.ts',
  'electron.vite.config.ts',
  'vite.renderer.config.ts',
  'postcss.config.js',
  'tailwind.config.js',
] as const

/** 架构性文件（L3 高风险，默认禁止写入，但可只读） */
export const L3_ARCHITECTURE_PATHS = [
  'src/main/index.ts',
  'src/main/agent/react-loop.ts',
  'src/main/agent/tool-registry.ts',
  'src/main/agent/index.ts',
  'src/main/process-guardian.ts',
  'src/main/register/',
  'src/main/secure/',
  'src/main/ipc/',
  'src/preload/',
  'src/shared/ipc-types.ts',
] as const

/** 单次改造上限 */
export const LIMITS = {
  MAX_FILES_PER_CHANGE: 5,
  MAX_LINES_PER_CHANGE: 300,
} as const

/* ============================================================
 * 小写化常量（用于大小写不敏感比较）
 * ============================================================ */
const L3_LOWER = L3_ARCHITECTURE_PATHS.map((s) => s.toLowerCase())
const WHITELIST_LOWER = WHITELIST_DIRS.map((s) => s.toLowerCase())
const BLACKLIST_SEGMENTS_LOWER = BLACKLIST_SEGMENTS.map((s) => s.toLowerCase())
const BLACKLIST_FILENAMES_LOWER = BLACKLIST_FILENAMES.map((s) => s.toLowerCase())

/** 敏感/危险文件扩展名与 `.env` 前缀 */
const SENSITIVE_PATTERN = /\.(log|pem|key|crt|p12|pfx)$/

/**
 * 规范化相对路径为仓库内相对路径（正斜杠，无 `./` 前缀，无尾部斜杠）。
 * 拒绝绝对路径、盘符路径、`..` 逃逸与空路径。
 *
 * @returns 规范化后的相对路径；非法时返回 null
 */
export function normalizeRel(input: string): string | null {
  if (typeof input !== 'string') return null
  const trimmed = input.trim()
  if (!trimmed) return null

  // 拒绝绝对路径（Windows 盘符 / UNC / POSIX 根）
  if (/^[a-zA-Z]:[\\/]/.test(trimmed) || trimmed.startsWith('\\\\') || trimmed.startsWith('/')) {
    return null
  }

  // 统一分隔符为 /
  const slash = trimmed.replace(/\\/g, '/')

  // 拒绝空字节等非法字符
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(slash)) return null

  // 拆段并拒绝 .. 与空段（. 允许但会被归一化掉）
  const segments: string[] = []
  for (const seg of slash.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') return null
    segments.push(seg)
  }
  if (segments.length === 0) return null

  return segments.join('/')
}

/**
 * 判断路径是否"可读"：命中白名单目录且未触硬黑名单（node_modules/.git/.env 等）。
 * 注意：L3 架构文件在此仍为"可读"（只读开放），仅禁止写入。
 */
export function isReadable(rel: string): boolean {
  const p = normalizeRel(rel)
  if (!p) return false
  const lp = p.toLowerCase()

  // 黑名单目录段
  for (const seg of BLACKLIST_SEGMENTS_LOWER) {
    if (lp.split('/').includes(seg)) return false
  }
  // 敏感文件（.env / 私钥 / 证书 / 日志）
  const base = p.split('/').pop()?.toLowerCase() || ''
  if (base.startsWith('.env') || SENSITIVE_PATTERN.test(base)) return false

  // 黑名单文件名
  if (BLACKLIST_FILENAMES_LOWER.includes(base)) return false

  // 白名单目录
  return WHITELIST_LOWER.some((dir) => lp.startsWith(dir))
}

/**
 * 判断路径是否允许"写入"：可读且不命中 L3 架构黑名单。
 * 所有比较大小写不敏感，封死 Windows/NTFS 大小写绕过。
 */
export function isAllowed(rel: string): boolean {
  if (!isReadable(rel)) return false
  const lp = normalizeRel(rel)!.toLowerCase()

  for (const arch of L3_LOWER) {
    if (lp === arch || lp.startsWith(arch)) return false
  }
  return true
}

/**
 * 判定改动级别（大小写不敏感）：
 * - L3：架构性文件 / 硬黑名单 / 敏感文件（禁止写入）
 * - L1：人设 / 文档 / 共享常量 / 主题样式 token
 * - L2：业务逻辑（src/main 业务 handler、src/renderer 组件行为）
 * - L0：只读（未命中任何级别的兜底）
 */
export function classifyLevel(rel: string): ModifyLevel {
  const p = normalizeRel(rel)
  if (!p) return 'L3'
  const lp = p.toLowerCase()

  // 硬黑名单目录段
  for (const seg of BLACKLIST_SEGMENTS_LOWER) {
    if (lp.split('/').includes(seg)) return 'L3'
  }
  const base = p.split('/').pop()?.toLowerCase() || ''
  if (BLACKLIST_FILENAMES_LOWER.includes(base)) return 'L3'
  if (base.startsWith('.env') || SENSITIVE_PATTERN.test(base)) return 'L3'

  // 架构性文件
  for (const arch of L3_LOWER) {
    if (lp === arch || lp.startsWith(arch)) return 'L3'
  }

  if (lp.startsWith('personas/') || lp.startsWith('docs/')) return 'L1'
  if (lp.startsWith('src/shared/')) return 'L1'
  // 主题 token / 样式 / 文案类文件归为 L1
  if (lp.endsWith('.css') || lp.endsWith('theme.ts') || lp.includes('i18n')) return 'L1'

  if (lp.startsWith('src/main/')) return 'L2'
  if (lp.startsWith('src/renderer/')) return 'L2'

  return 'L1'
}

/** 风险等级排序（用于取变更集中的最高风险） */
const LEVEL_ORDER: ModifyLevel[] = ['L0', 'L1', 'L2', 'L3']

/** 取最高风险级别 */
export function maxLevel(a: ModifyLevel, b: ModifyLevel): ModifyLevel {
  return LEVEL_ORDER.indexOf(a) >= LEVEL_ORDER.indexOf(b) ? a : b
}

/**
 * 将相对路径解析为仓库根下的绝对路径（仅供 main 进程内部使用，调用前必须已通过 isAllowed）。
 * normalizeRel 失败时返回 null（绝不回退到未校验的原始路径）。
 */
export function resolveRepoPath(repoRoot: string, rel: string): string | null {
  const p = normalizeRel(rel)
  if (!p) return null
  return path.join(repoRoot, p)
}
