/**
 * 本机 AI 客户端扫描 v12.2
 *
 * 职责：
 *   1. 扫描本机已安装的 AI 客户端软件（Kimi / 豆包 / DeepSeek / 智谱清言 /
 *      通义 / 文心一言 / 腾讯元宝 / ChatGPT / Copilot / Cursor / Trae /
 *      Chatbox / Cherry Studio / LM Studio / Ollama / Jan / GPT4All 等）
 *   2. 供"超大任务替换云端模型为本地 AI 客户端推理"场景使用：
 *      任务前扫描并建议用户，用户确认后由 app-agent 打开对应客户端
 *   3. 扫描结果缓存（10 分钟），避免频繁注册表读取
 *
 * 扫描源（只读，无副作用）：
 *   - 注册表 Uninstall 项（HKLM / HKLM WOW6432Node / HKCU）displayName 关键词匹配
 *   - 开始菜单快捷方式（解析 .lnk 目标）
 *   - 常见安装目录探测
 */
import { execFile } from 'child_process'
import { ipcMain } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { promisify } from 'util'
import { logger } from '../../shared/logger'

const execFileAsync = promisify(execFile)

export interface FoundAiClient {
  id: string
  name: string
  /** 可执行文件绝对路径（存在才返回） */
  exePath: string
  /** 扫描来源：registry / startmenu / common-path */
  source: 'registry' | 'startmenu' | 'common-path'
  /** 版本号（可从注册表 DisplayVersion 拿到） */
  version?: string
}

interface ClientProfile {
  id: string
  name: string
  /** 注册表 DisplayName 匹配关键词 */
  registryKeywords: string[]
  /** 常见 exe 文件名 */
  exeNames: string[]
  /** 常见安装目录名（AppData/Local/Programs 下） */
  dirNames: string[]
}

const KNOWN_CLIENTS: ClientProfile[] = [
  { id: 'kimi', name: 'Kimi', registryKeywords: ['kimi', '月之暗面'], exeNames: ['kimi.exe'], dirNames: ['Kimi'] },
  { id: 'doubao', name: '豆包', registryKeywords: ['豆包', 'doubao'], exeNames: ['doubao.exe', '豆包.exe'], dirNames: ['豆包', 'Doubao'] },
  { id: 'deepseek', name: 'DeepSeek', registryKeywords: ['deepseek'], exeNames: ['deepseek.exe'], dirNames: ['DeepSeek'] },
  { id: 'zhipu', name: '智谱清言', registryKeywords: ['智谱', '清言', 'zhipu', 'chatglm'], exeNames: ['chatglm.exe', '智谱清言.exe'], dirNames: ['ChatGLM', '智谱清言'] },
  { id: 'tongyi', name: '通义', registryKeywords: ['通义', 'tongyi', 'qianwen'], exeNames: ['tongyi.exe', '通义.exe', '通义千问.exe'], dirNames: ['通义', 'Tongyi'] },
  { id: 'wenxin', name: '文心一言', registryKeywords: ['文心一言', 'wenxin'], exeNames: ['wenxin.exe', '文心一言.exe'], dirNames: ['文心一言', 'Wenxin'] },
  { id: 'yuanbao', name: '腾讯元宝', registryKeywords: ['腾讯元宝', 'yuanbao'], exeNames: ['腾讯元宝.exe', 'yuanbao.exe'], dirNames: ['腾讯元宝', 'Yuanbao'] },
  { id: 'xinghuo', name: '讯飞星火', registryKeywords: ['讯飞星火', 'xinghuo', 'spark'], exeNames: ['xinghuo.exe', '星火.exe'], dirNames: ['讯飞星火', 'XingHuo'] },
  { id: 'chatgpt', name: 'ChatGPT', registryKeywords: ['chatgpt'], exeNames: ['chatgpt.exe'], dirNames: ['ChatGPT'] },
  { id: 'copilot', name: 'Microsoft Copilot', registryKeywords: ['copilot'], exeNames: ['copilot.exe'], dirNames: ['Copilot'] },
  { id: 'cursor', name: 'Cursor', registryKeywords: ['cursor'], exeNames: ['cursor.exe'], dirNames: ['Cursor'] },
  { id: 'trae', name: 'Trae', registryKeywords: ['trae'], exeNames: ['trae.exe'], dirNames: ['Trae'] },
  { id: 'chatbox', name: 'Chatbox', registryKeywords: ['chatbox'], exeNames: ['chatbox.exe'], dirNames: ['Chatbox'] },
  { id: 'cherry', name: 'Cherry Studio', registryKeywords: ['cherry studio', 'cherry-studio'], exeNames: ['cherry-studio.exe'], dirNames: ['Cherry Studio'] },
  { id: 'lmstudio', name: 'LM Studio', registryKeywords: ['lm studio', 'lmstudio'], exeNames: ['lm studio.exe'], dirNames: ['LM Studio'] },
  { id: 'ollama', name: 'Ollama', registryKeywords: ['ollama'], exeNames: ['ollama.exe'], dirNames: ['Ollama'] },
  { id: 'jan', name: 'Jan', registryKeywords: [' jan'], exeNames: ['jan.exe'], dirNames: ['Jan'] },
  { id: 'gpt4all', name: 'GPT4All', registryKeywords: ['gpt4all', 'gpt4 all'], exeNames: ['gpt4all.exe'], dirNames: ['GPT4All'] },
  { id: 'baixiaoying', name: '百小应', registryKeywords: ['百小应'], exeNames: ['百小应.exe'], dirNames: ['百小应'] },
  { id: 'metaso', name: '秘塔AI', registryKeywords: ['秘塔', 'metaso'], exeNames: ['metaso.exe'], dirNames: ['Metaso', '秘塔'] },
  { id: 'gemini', name: 'Gemini', registryKeywords: ['gemini'], exeNames: ['gemini.exe'], dirNames: ['Gemini'] },
]

/** 匹配结果暂存（去重用） */
interface RawHit {
  profile: ClientProfile
  exePath: string
  source: FoundAiClient['source']
  version?: string
}

class LocalAiScanner {
  private cache: FoundAiClient[] | null = null
  private cacheAt: number = 0
  private readonly CACHE_TTL_MS = 10 * 60 * 1000
  private scanning: Promise<FoundAiClient[]> | null = null

  list(): FoundAiClient[] {
    if (this.cache && Date.now() - this.cacheAt < this.CACHE_TTL_MS) {
      return this.cache
    }
    return []
  }

  async scan(force = false): Promise<FoundAiClient[]> {
    if (!force && this.cache && Date.now() - this.cacheAt < this.CACHE_TTL_MS) {
      return this.cache
    }
    if (this.scanning) {
      return this.scanning
    }
    this.scanning = this.doScan().finally(() => { this.scanning = null })
    return this.scanning
  }

  private async doScan(): Promise<FoundAiClient[]> {
    const hits: RawHit[] = []
    const seen = new Set<string>()

    const pushHit = (hit: RawHit) => {
      if (!hit.exePath || seen.has(hit.exePath.toLowerCase())) return
      seen.add(hit.exePath.toLowerCase())
      hits.push(hit)
    }

    try {
      // 1) 注册表 Uninstall 扫描
      const regHits = await this.scanRegistry()
      regHits.forEach(h => pushHit(h))
    } catch (e) {
      logger.warn('[LocalAiScanner] 注册表扫描失败（忽略）:', e)
    }

    try {
      // 2) 开始菜单快捷方式
      const menuHits = await this.scanStartMenu()
      menuHits.forEach(h => pushHit(h))
    } catch (e) {
      logger.warn('[LocalAiScanner] 开始菜单扫描失败（忽略）:', e)
    }

    // 3) 常见安装目录兜底
    for (const profile of KNOWN_CLIENTS) {
      for (const dir of profile.dirNames) {
        const dirs = [
          join(process.env.LOCALAPPDATA || '', 'Programs', dir),
          join(process.env.ProgramFiles || 'C:\\Program Files', dir),
          join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', dir),
        ]
        for (const d of dirs) {
          for (const exe of profile.exeNames) {
            const p = join(d, exe)
            if (existsSync(p)) {
              pushHit({ profile, exePath: p, source: 'common-path' })
            }
          }
        }
      }
    }

    const result: FoundAiClient[] = hits.map(h => ({
      id: h.profile.id,
      name: h.profile.name,
      exePath: h.exePath,
      source: h.source,
      version: h.version,
    }))

    this.cache = result
    this.cacheAt = Date.now()
    logger.info(`[LocalAiScanner] 扫描完成，发现 ${result.length} 个 AI 客户端`)
    return result
  }

  /** 注册表 Uninstall 项扫描 */
  private async scanRegistry(): Promise<RawHit[]> {
    const hits: RawHit[] = []
    const roots = [
      'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
      'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
      'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    ]
    // PowerShell 一次性导出三个根下的 (DisplayName, InstallLocation, DisplayVersion)
    const psScript = `
$ErrorActionPreference = 'SilentlyContinue'
$roots = @('${roots.join("','")}')
$out = @()
foreach ($root in $roots) {
  $subs = Get-ChildItem -Path $root
  foreach ($sub in $subs) {
    $p = Get-ItemProperty -Path $sub.PSPath
    if ($p.DisplayName) {
      $out += [pscustomobject]@{ Name = $p.DisplayName; Location = $p.InstallLocation; Version = $p.DisplayVersion }
    }
  }
}
$out | ConvertTo-Json -Compress
`
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript], {
      timeout: 15000,
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    })
    let rows: Array<{ Name?: string; Location?: string; Version?: string }> = []
    try {
      rows = JSON.parse(stdout || '[]')
      if (!Array.isArray(rows)) rows = []
    } catch {
      rows = []
    }
    for (const row of rows) {
      const name = (row.Name || '').toLowerCase()
      if (!name) continue
      for (const profile of KNOWN_CLIENTS) {
        const matched = profile.registryKeywords.some(kw => name.includes(kw.toLowerCase()))
        if (!matched) continue
        // 优先用 InstallLocation 定位 exe；失败则跳过（避免虚报）
        const location = (row.Location || '').replace(/"/g, '')
        for (const exe of profile.exeNames) {
          if (location && existsSync(join(location, exe))) {
            hits.push({ profile, exePath: join(location, exe), source: 'registry', version: row.Version })
            break
          }
        }
      }
    }
    return hits
  }

  /** 开始菜单快捷方式扫描（解析 .lnk 目标） */
  private async scanStartMenu(): Promise<RawHit[]> {
    const hits: RawHit[] = []
    const appData = process.env.APPDATA || ''
    const menuRoots = [
      join(appData, 'Microsoft\\Windows\\Start Menu\\Programs'),
      join(process.env.ProgramData || 'C:\\ProgramData', 'Microsoft\\Windows\\Start Menu\\Programs'),
    ]
    const psScript = `
$ErrorActionPreference = 'SilentlyContinue'
$shell = New-Object -ComObject WScript.Shell
$out = @()
foreach ($root in @('${menuRoots.join("','")}')) {
  if (-not (Test-Path $root)) { continue }
  Get-ChildItem -Path $root -Recurse -Filter *.lnk | ForEach-Object {
    $target = $shell.CreateShortcut($_.FullName).TargetPath
    if ($target) {
      $out += [pscustomobject]@{ Lnk = $_.FullName; Target = $target }
    }
  }
}
$out | ConvertTo-Json -Compress
`
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript], {
      timeout: 15000,
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    })
    let rows: Array<{ Lnk?: string; Target?: string }> = []
    try {
      rows = JSON.parse(stdout || '[]')
      if (!Array.isArray(rows)) rows = []
    } catch {
      rows = []
    }
    for (const row of rows) {
      const target = (row.Target || '').toLowerCase()
      const targetFull = (row.Target || '')
      if (!targetFull || !target.endsWith('.exe')) continue
      const exeName = targetFull.split(/[\\/]/).pop() || ''
      for (const profile of KNOWN_CLIENTS) {
        const matched = profile.exeNames.some(e => e.toLowerCase() === exeName.toLowerCase())
        if (!matched) continue
        if (existsSync(targetFull)) {
          hits.push({ profile, exePath: targetFull, source: 'startmenu' })
        }
      }
    }
    return hits
  }

  /** 任务前建议：返回未安装的推荐 AI 客户端（简化：直接返回已安装列表 + 常用推荐） */
  suggest(): { installed: FoundAiClient[]; recommended: string[] } {
    const installed = this.list()
    const installedIds = new Set(installed.map(c => c.id))
    const recommended = ['kimi', 'doubao', 'deepseek', 'zhipu'].filter(id => !installedIds.has(id))
    return { installed, recommended }
  }
}

export const localAiScanner = new LocalAiScanner()

/**
 * 注册 local-ai IPC 通道
 */
export function setupLocalAiHandlers(): void {
  ipcMain.handle('local-ai:list', () => localAiScanner.list())

  ipcMain.handle('local-ai:scan', async (_e, force?: boolean) => {
    try {
      return await localAiScanner.scan(!!force)
    } catch (e) {
      logger.error('[LocalAiScanner] local-ai:scan 失败:', e)
      return []
    }
  })

  ipcMain.handle('local-ai:suggest', () => localAiScanner.suggest())

  // 应用启动后延迟静默扫描一次（不阻塞启动）
  try {
    setTimeout(() => {
      localAiScanner.scan().catch(() => { /* 静默失败 */ })
    }, 15000)
  } catch { /* ignore */ }
}
