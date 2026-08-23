/**
 * 资源路径解析器
 *
 * 背景：便携版中重型资源（Python ~1.8GB / CUDA DLLs ~1.1GB / FFmpeg ~165MB）
 * 不再打包进自解压 7z，而是放在便携版 exe 同级目录的 resources/ 下。
 * 本模块提供统一的后备路径查询。
 */
import { join, dirname } from 'path'
import { existsSync } from 'fs'

/**
 * 返回便携版 exe 同级 resources 目录的绝对路径。
 * 仅当 process.resourcesPath 指向 NSIS 临时目录（nsi*.tmp）时才有效，
 * 否则返回空串表示不适用。
 */
export function getPortableDepotPath(): string {
  const resPath = process.resourcesPath || ''
  if (!/nsi[a-z0-9]+\.tmp/i.test(resPath)) return ''
  try {
    return join(dirname(process.execPath), 'resources')
  } catch { return '' }
}

/**
 * 解析资源文件/目录的绝对路径。
 * 优先使用 process.resourcesPath（安装版 / 开发模式 / 便携版 temp 提取目录），
 * 若目标不存在且当前运行在便携模式下，回退到便携版 exe 同级 resources 目录。
 */
export function resolveResource(relPath: string): string {
  const primary = join(process.resourcesPath, relPath)
  if (existsSync(primary)) return primary

  const depot = getPortableDepotPath()
  if (depot) {
    const fallback = join(depot, relPath)
    if (existsSync(fallback)) return fallback
  }

  // 返回主路径（即使不存在，由调用方决定如何处理）
  return primary
}
