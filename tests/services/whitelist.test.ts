/**
 * whitelist 攻击性单元测试
 *
 * 覆盖 QA 发现的大小写不敏感绕过漏洞（Windows/NTFS）：
 *   攻击者用 `src/main/INDEX.ts`、`src/main/IPC/chat.ipc.ts`、`src/main/agent/REACT-LOOP.ts`
 *   等大小写变体绕过 L3 架构黑名单并命中 `src/main/` 白名单。
 * 修复后：所有 L3 架构路径（含大小写变体）isAllowed 必须为 false。
 */
import { describe, it, expect } from 'vitest'
import {
  normalizeRel,
  isAllowed,
  isReadable,
  classifyLevel,
  resolveRepoPath,
} from '@/main/self-modify/whitelist'

/* ============================================================
 * L3 架构文件（精确大小写）必须禁止写入
 * ============================================================ */
describe('L3 架构文件精确大小写（禁止写入）', () => {
  const l3Paths = [
    'src/main/index.ts',
    'src/main/agent/react-loop.ts',
    'src/main/agent/tool-registry.ts',
    'src/main/agent/index.ts',
    'src/main/process-guardian.ts',
    'src/main/register/ipc.register.ts',
    'src/main/secure/secure-store.ts',
    'src/main/ipc/chat.ipc.ts',
    'src/preload/index.ts',
    'src/shared/ipc-types.ts',
  ]
  it.each(l3Paths)('isAllowed(%s) === false', (p) => {
    expect(isAllowed(p)).toBe(false)
    expect(classifyLevel(p)).toBe('L3')
  })
})

/* ============================================================
 * L3 架构文件大小写变体（QA 发现的绕过）必须禁止写入
 * ============================================================ */
describe('L3 架构文件大小写变体（禁止写入）', () => {
  const variants = [
    'src/main/INDEX.ts',
    'src/main/Index.ts',
    'src/main/IPC/chat.ipc.ts',
    'src/main/Ipc/chat.ipc.ts',
    'src/main/agent/REACT-LOOP.ts',
    'src/main/agent/Tool-Registry.ts',
    'src/main/AGENT/index.ts',
    'src/main/Process-Guardian.ts',
    'src/main/REGISTER/ipc.register.ts',
    'src/main/SECURE/secure-store.ts',
    'src/PRELOAD/index.ts',
    'SRC/MAIN/INDEX.TS',
    'src/Main/Index.ts',
  ]
  it.each(variants)('isAllowed(%s) === false', (p) => {
    expect(isAllowed(p)).toBe(false)
    expect(classifyLevel(p)).toBe('L3')
  })
})

/* ============================================================
 * L3 架构文件可读（只读开放，仅禁止写入）
 * ============================================================ */
describe('L3 架构文件可读性', () => {
  it('src/main/index.ts 可读但不可写', () => {
    expect(isReadable('src/main/index.ts')).toBe(true)
    expect(isAllowed('src/main/index.ts')).toBe(false)
  })
  it('大小写变体 src/main/INDEX.ts 可读但不可写', () => {
    expect(isReadable('src/main/INDEX.ts')).toBe(true)
    expect(isAllowed('src/main/INDEX.ts')).toBe(false)
  })
})

/* ============================================================
 * 黑名单文件名（含大小写变体）必须禁止写入
 * ============================================================ */
describe('黑名单文件名（禁止写入）', () => {
  const blacklisted = [
    'package.json',
    'PACKAGE.JSON',
    'Package.json',
    'package-lock.json',
    'electron-builder.yml',
    'ELECTRON-BUILDER.YML',
    'electron-builder.portable.yml',
    'vite.config.ts',
    'electron.vite.config.ts',
    'postcss.config.js',
    'tailwind.config.js',
    '.env',
    '.ENV',
    '.env.local',
    'foo.log',
    'foo.pem',
    'id_rsa.key',
  ]
  it.each(blacklisted)('isAllowed(%s) === false', (p) => {
    expect(isAllowed(p)).toBe(false)
  })
})

/* ============================================================
 * 黑名单目录段（含大小写变体）必须禁止写入
 * ============================================================ */
describe('黑名单目录段（禁止写入）', () => {
  const segments = [
    'node_modules/foo.ts',
    'NODE_MODULES/foo.ts',
    'out/main/index.js',
    'OUT/main/index.js',
    'dist/foo.js',
    '.git/config',
    'engine/foo.py',
    'resources/icon.png',
    '.trash_staging/foo.ts',
    'output/foo.js',
  ]
  it.each(segments)('isAllowed(%s) === false', (p) => {
    expect(isAllowed(p)).toBe(false)
  })
})

/* ============================================================
 * 路径逃逸 / 绝对路径必须拒绝
 * ============================================================ */
describe('路径逃逸与绝对路径', () => {
  const bad = [
    '../src/main/index.ts',
    './../src/main/index.ts',
    '..\\src\\main\\index.ts',
    'src/../main/index.ts',
    'C:\\Windows\\system32\\cmd.exe',
    '/etc/passwd',
    '\\\\server\\share\\file.ts',
    '',
    '   ',
    '..',
  ]
  it.each(bad)('normalizeRel/isAllowed(%s) 拒绝', (p) => {
    expect(isAllowed(p)).toBe(false)
  })
  it('normalizeRel 对空/逃逸返回 null', () => {
    expect(normalizeRel('../x')).toBeNull()
    expect(normalizeRel('')).toBeNull()
    expect(normalizeRel('C:\\x\\y.ts')).toBeNull()
  })
})

/* ============================================================
 * 合法白名单路径必须放行
 * ============================================================ */
describe('合法白名单路径（允许写入）', () => {
  const allowed = [
    'src/renderer/pages/Home/index.tsx',
    'src/renderer/shared/theme.ts',
    'src/main/utils/logging.ts',
    'src/main/self-modify/whitelist.ts',
    'src/shared/logger.ts',
    'personas/assistant.md',
    'docs/design.md',
  ]
  it.each(allowed)('isAllowed(%s) === true', (p) => {
    expect(isAllowed(p)).toBe(true)
  })
})

/* ============================================================
 * resolveRepoPath 不回退到未校验路径
 * ============================================================ */
describe('resolveRepoPath 安全回退', () => {
  it('非法路径返回 null（不回退原始路径）', () => {
    expect(resolveRepoPath('/repo', '../etc/passwd')).toBeNull()
    expect(resolveRepoPath('/repo', 'C:\\Windows\\x.ts')).toBeNull()
  })
  it('合法路径正确拼接', () => {
    const r = resolveRepoPath('/repo', 'src/renderer/a.ts')
    expect(r).not.toBeNull()
    expect(r!.replace(/\\/g, '/')).toBe('/repo/src/renderer/a.ts')
  })
})

/* ============================================================
 * classifyLevel 大小写不敏感分级
 * ============================================================ */
describe('classifyLevel 分级', () => {
  it('业务逻辑 → L2', () => {
    expect(classifyLevel('src/renderer/pages/Home/index.tsx')).toBe('L2')
    expect(classifyLevel('src/main/utils/logging.ts')).toBe('L2')
  })
  it('文案/样式/人设/文档 → L1', () => {
    expect(classifyLevel('personas/assistant.md')).toBe('L1')
    expect(classifyLevel('docs/design.md')).toBe('L1')
    expect(classifyLevel('src/renderer/shared/theme.ts')).toBe('L1')
  })
  it('大小写变体不影响分级（INDEX.ts 仍为 L3）', () => {
    expect(classifyLevel('src/main/INDEX.ts')).toBe('L3')
    expect(classifyLevel('SRC/MAIN/INDEX.TS')).toBe('L3')
  })
})
