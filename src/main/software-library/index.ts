/**
 * 软件库模块 — #27 第三方软件收录与学习体系
 *
 * 目标：玄枢从"仅会四类内建软件（WPS/浏览器/微信/系统工具）"扩展为
 * 海量第三方软件全能操控，越用越会。
 *
 * 收录四路（并行）：
 *   ① 本机扫描（scan）：开始菜单快捷方式 / 注册表 Uninstall 键 / 常见安装目录
 *   ② 手动添加（manual）：用户手动添加任意 .exe / 路径，命名 + 分类
 *   ③ 预置模板库（template）：内置/可下载的第三方软件操作模板
 *   ④ 用户示范学习（learn）：用户操作一次，玄枢录制轨迹自动生成技能包
 *
 * 管理页四态：已学(learned) / 待学(to-learn) / 学习中(learning) / 识别弱(weak)
 *
 * 词典提升意图匹配：为意图匹配提供"软件名/窗口标题/可执行文件"词典，
 * 显著提升第三方软件识别率（当前阈值 20 的短板由词典补齐）。
 *
 * @module main/software-library
 */

import { ipcMain, app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { COMMON_GUIDES } from './guides'
import { skillPackManager } from '../skill-pack'
import { logger } from '../../shared/logger'

const execFileAsync = promisify(execFile)

/** 软件状态：已学 / 待学 / 学习中 / 识别弱 */
export type SoftwareStatus = 'learned' | 'to-learn' | 'learning' | 'weak'

/** 收录来源 */
export type SoftwareSource = 'scan' | 'manual' | 'template' | 'learn'

export interface SoftwareEntry {
  id: string
  /** 软件显示名（如 腾讯会议） */
  name: string
  /** 可执行文件名（如 wemeet.exe，词典项） */
  exe?: string
  /** 完整安装路径 */
  installPath?: string
  /** 分类（如 办公/会议/设计/游戏/视频） */
  category: string
  /** 收录来源 */
  source: SoftwareSource
  /** 当前状态（四态） */
  status: SoftwareStatus
  /** 窗口标题词典（提升意图匹配） */
  windowTitles: string[]
  /** 别名（中英文名/简称，词典项） */
  aliases: string[]
  /** 关联技能包 id（专用层，已学） */
  skillPackId?: string
  /** 操控成功次数 */
  learnCount: number
  createdAt: number
  updatedAt: number
  note?: string
}

export interface LibraryState {
  entries: SoftwareEntry[]
  updatedAt: number
}

const DEFAULT_CATEGORY = '其他'

class SoftwareLibrary {
  private entries: Map<string, SoftwareEntry> = new Map()
  private statePath = ''

  init(): void {
    try {
      this.statePath = path.join(app.getPath('userData'), 'software-library.json')
      if (fs.existsSync(this.statePath)) {
        const raw = fs.readFileSync(this.statePath, 'utf-8')
        const state: LibraryState = JSON.parse(raw)
        this.entries = new Map(state.entries.map(e => [e.id, e]))
        logger.info(`[SoftwareLibrary] 加载 ${this.entries.size} 条软件收录`)
      }
    } catch (e) {
      logger.warn(`[SoftwareLibrary] 加载失败: ${e instanceof Error ? e.message : String(e)}`)
      this.entries = new Map()
    }
  }

  private persist(): void {
    if (!this.statePath) return
    try {
      const state: LibraryState = { entries: Array.from(this.entries.values()), updatedAt: Date.now() }
      fs.writeFileSync(this.statePath, JSON.stringify(state, null, 2), 'utf-8')
    } catch (e) {
      logger.warn(`[SoftwareLibrary] 持久化失败: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  private upsert(entry: SoftwareEntry): void {
    entry.updatedAt = Date.now()
    this.entries.set(entry.id, entry)
    this.persist()
  }

  list(): SoftwareEntry[] {
    return Array.from(this.entries.values()).sort((a, b) => b.updatedAt - a.updatedAt)
  }

  get(id: string): SoftwareEntry | null {
    return this.entries.get(id) || null
  }

  add(input: {
    name: string
    exe?: string
    installPath?: string
    category?: string
    source?: SoftwareSource
    aliases?: string[]
    windowTitles?: string[]
    note?: string
  }): SoftwareEntry {
    const id = `sw-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    const entry: SoftwareEntry = {
      id,
      name: input.name.trim(),
      exe: input.exe?.trim(),
      installPath: input.installPath?.trim(),
      category: input.category?.trim() || DEFAULT_CATEGORY,
      source: input.source || 'manual',
      status: 'to-learn',
      windowTitles: input.windowTitles || [],
      aliases: input.aliases || [],
      learnCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      note: input.note,
    }
    this.upsert(entry)
    return entry
  }

  remove(id: string): boolean {
    const existed = this.entries.delete(id)
    if (existed) this.persist()
    return existed
  }

  setStatus(id: string, status: SoftwareStatus): boolean {
    const entry = this.entries.get(id)
    if (!entry) return false
    entry.status = status
    this.upsert(entry)
    return true
  }

  linkSkillPack(id: string, skillPackId: string): boolean {
    const entry = this.entries.get(id)
    if (!entry) return false
    entry.skillPackId = skillPackId
    entry.status = 'learned'
    this.upsert(entry)
    return true
  }

  bumpLearnCount(id: string): boolean {
    const entry = this.entries.get(id)
    if (!entry) return false
    entry.learnCount += 1
    entry.status = 'learned'
    this.upsert(entry)
    return true
  }

  /** 词典：软件名 / 窗口标题 / 可执行文件 / 别名（供意图匹配补强识别率） */
  getDictionary(): { names: string[]; windowTitles: string[]; exes: string[]; aliases: string[] } {
    const names: string[] = []
    const windowTitles: string[] = []
    const exes: string[] = []
    const aliases: string[] = []
    for (const e of this.entries.values()) {
      if (e.name) names.push(e.name)
      if (e.exe) exes.push(e.exe)
      for (const t of e.windowTitles) windowTitles.push(t)
      for (const a of e.aliases) aliases.push(a)
    }
    return { names, windowTitles, exes, aliases }
  }

  /** 在词典中查找意图命中的软件（软件名/别名/窗口标题/可执行文件名） */
  matchIntent(intent: string): SoftwareEntry | null {
    const text = intent || ''
    if (!text) return null
    for (const e of this.entries.values()) {
      const candidates = [e.name, ...e.aliases, ...e.windowTitles, ...(e.exe ? [e.exe.replace(/\.exe$/i, '')] : [])]
      if (candidates.some(c => c && text.includes(c))) return e
    }
    return null
  }
}

export const softwareLibrary = new SoftwareLibrary()

// ============================================================
// ① 本机扫描：开始菜单 / 注册表 Uninstall / 常见安装目录
// ============================================================

const COMMON_INSTALL_DIRS = [
  process.env['ProgramFiles'] || 'C:\\Program Files',
  process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
  process.env['LOCALAPPDATA'] || '',
]

/** 从开始菜单快捷方式扫描软件（.lnk 指向的 exe 名） */
async function scanStartMenu(): Promise<Array<Pick<SoftwareEntry, 'name' | 'exe' | 'installPath' | 'category'>>> {
  const found: Array<Pick<SoftwareEntry, 'name' | 'exe' | 'installPath' | 'category'>> = []
  const roots = [
    process.env['APPDATA'],
    process.env['ProgramData'],
  ].filter(Boolean)
  for (const root of roots) {
    const startMenu = path.join(root!, 'Microsoft', 'Windows', 'Start Menu', 'Programs')
    if (!fs.existsSync(startMenu)) continue
    const walk = (dir: string): void => {
      let items: fs.Dirent[]
      try { items = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const it of items) {
        const full = path.join(dir, it.name)
        if (it.isDirectory()) {
          walk(full)
        } else if (/\.lnk$/i.test(it.name)) {
          const name = it.name.replace(/\.lnk$/i, '').replace(/\.(exe|url)$/i, '')
          found.push({ name, exe: `${name}.exe`, installPath: full, category: inferCategory(name) })
        }
      }
    }
    walk(startMenu)
  }
  return found
}

/** 从注册表 Uninstall 键扫描已安装软件 */
async function scanRegistry(): Promise<Array<Pick<SoftwareEntry, 'name' | 'exe' | 'installPath' | 'category'>>> {
  const found: Array<Pick<SoftwareEntry, 'name' | 'exe' | 'installPath' | 'category'>> = []
  const keys = [
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ]
  try {
    const { stdout } = await execFileAsync('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall', '/s', '/f', 'DisplayName', '/t', 'REG_SZ', '/e'], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 })
    for (const line of stdout.split(/\r?\n/)) {
      const m = line.match(/DisplayName\s+REG_SZ\s+(.+)/i)
      if (!m) continue
      const name = m[1].trim()
      if (!name || name.length > 60 || /^\$/.test(name)) continue
      if (name.toLowerCase().includes('update') || name.toLowerCase().includes('redist')) continue
      found.push({ name, exe: `${name}.exe`, category: inferCategory(name) })
    }
  } catch { /* reg 无结果或失败时忽略 */ }
  void keys
  return found
}

/** 从常见安装目录扫描顶层可执行文件 */
async function scanInstallDirs(): Promise<Array<Pick<SoftwareEntry, 'name' | 'exe' | 'installPath' | 'category'>>> {
  const found: Array<Pick<SoftwareEntry, 'name' | 'exe' | 'installPath' | 'category'>> = []
  const seen = new Set<string>()
  for (const dir of COMMON_INSTALL_DIRS.filter(Boolean)) {
    let items: fs.Dirent[]
    try { items = fs.readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const it of items) {
      if (!it.isDirectory()) continue
      const subDir = path.join(dir, it.name)
      let sub: fs.Dirent[]
      try { sub = fs.readdirSync(subDir, { withFileTypes: true }) } catch { continue }
      const exe = sub.find(s => s.isFile() && /\.exe$/i.test(s.name) && !/unins|setup|install/i.test(s.name))
      if (!exe) continue
      const key = `${it.name}/${exe.name}`.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      found.push({
        name: it.name,
        exe: exe.name,
        installPath: path.join(subDir, exe.name),
        category: inferCategory(it.name),
      })
    }
  }
  return found
}

/** 按名称推断分类（粗粒度，用于收录列表分组） */
function inferCategory(name: string): string {
  const n = name.toLowerCase()
  if (/(tencent|qq|wechat|weixin|dingtalk|feishu|lark|wemeet|zoom)/.test(n)) return '通讯会议'
  if (/(office|wps|word|excel|powerpoint|pdf|notion|typora)/.test(n)) return '办公'
  if (/(photoshop|ps|illustrator|figma|pr |premiere|剪映|capcut|wondershare|绘声绘影)/.test(n)) return '设计影音'
  if (/(steam|epic|游戏|game|battle|战网|wegame)/.test(n)) return '游戏'
  if (/(chrome|edge|firefox|浏览器|360|opera|safari)/.test(n)) return '浏览器'
  if (/(visual studio|idea|webstorm|pycharm|vscode|code|git|docker|node)/.test(n)) return '开发'
  if (/(potplayer|vlc|mpv|kmplayer|影音|media)/.test(n)) return '影音播放'
  return DEFAULT_CATEGORY
}

/** 全量扫描本机已安装软件（三路合并去重，按名字） */
export async function scanInstalledSoftware(): Promise<SoftwareEntry[]> {
  const [menu, reg, dirs] = await Promise.all([scanStartMenu(), scanRegistry(), scanInstallDirs()])
  const merged = new Map<string, Pick<SoftwareEntry, 'name' | 'exe' | 'installPath' | 'category'>>()
  for (const item of [...menu, ...reg, ...dirs]) {
    const key = item.name.toLowerCase()
    if (!merged.has(key)) merged.set(key, item)
  }
  const added: SoftwareEntry[] = []
  for (const item of merged.values()) {
    // 已存在则跳过（避免重复收录）
    const existed = softwareLibrary.list().some(e => e.name.toLowerCase() === item.name.toLowerCase())
    if (existed) continue
    added.push(softwareLibrary.add({
      name: item.name,
      exe: item.exe,
      installPath: item.installPath,
      category: item.category,
      source: 'scan',
      windowTitles: [item.name],
    }))
  }
  return added
}

// ============================================================
// 预置模板库（模板 = 预置的第三方软件操作要点，导入后进入软件库待学）
// ============================================================

export interface SoftwareTemplate {
  id: string
  name: string
  exe: string
  category: string
  aliases: string[]
  windowTitles: string[]
  /** 预置操作要点（供导入后生成待学条目，也可作为技能包雏形） */
  hints: string[]
}

export const PRESET_TEMPLATES: SoftwareTemplate[] = [
  {
    id: 'tpl-wemeet', name: '腾讯会议', exe: 'wemeetapp.exe', category: '通讯会议',
    aliases: ['腾讯会议', 'wemeet'], windowTitles: ['腾讯会议'],
    hints: ['进入会议：菜单栏 加入会议/快速会议；会中：Alt+A 静音/取消静音、Alt+V 开/关摄像头、Alt+S 共享屏幕'],
  },
  {
    id: 'tpl-dingtalk', name: '钉钉', exe: 'DingTalk.exe', category: '通讯会议',
    aliases: ['钉钉', 'dingtalk'], windowTitles: ['钉钉'],
    hints: ['发消息：左侧会话列表选中后输入框输入 Enter 发送；开会：顶部 发起直播/视频会议'],
  },
  {
    id: 'tpl-feishu', name: '飞书', exe: 'Feishu.exe', category: '通讯会议',
    aliases: ['飞书', 'lark', 'feishu'], windowTitles: ['飞书'],
    hints: ['发消息：Ctrl+N 新建会话；文档：Ctrl+O 打开最近文档；会议：Ctrl+D 快速发起会议'],
  },
  {
    id: 'tpl-photoshop', name: 'Photoshop', exe: 'Photoshop.exe', category: '设计影音',
    aliases: ['photoshop', 'ps'], windowTitles: ['Adobe Photoshop'],
    hints: ['打开文件：Ctrl+O；保存：Ctrl+S；导出：Ctrl+Alt+Shift+S；工具栏按字母键切换工具（V 移动/M 选框/B 画笔）'],
  },
  {
    id: 'tpl-steam', name: 'Steam', exe: 'steam.exe', category: '游戏',
    aliases: ['steam', '蒸汽平台'], windowTitles: ['Steam'],
    hints: ['打开库：顶部 库/商店 页签；启动游戏：库中游戏项点击 开始；搜索：商店页右上搜索框'],
  },
  {
    id: 'tpl-jianying', name: '剪映', exe: 'JianyingPro.exe', category: '设计影音',
    aliases: ['剪映', 'capcut', 'jianying'], windowTitles: ['剪映'],
    hints: ['新建草稿：首页 开始创作；导入素材：媒体区 +导入；导出：右上角 导出 按钮选择分辨率'],
  },
  {
    id: 'tpl-chrome', name: 'Chrome', exe: 'chrome.exe', category: '浏览器',
    aliases: ['chrome', '谷歌浏览器'], windowTitles: ['Chrome'],
    hints: ['打开标签：Ctrl+T；关闭标签：Ctrl+W；地址栏：Ctrl+L 聚焦；下载：Ctrl+J'],
  },
  {
    id: 'tpl-vscode', name: 'VS Code', exe: 'Code.exe', category: '开发',
    aliases: ['vscode', 'visual studio code'], windowTitles: ['Visual Studio Code'],
    hints: ['命令面板：Ctrl+Shift+P；打开文件：Ctrl+O；搜索：Ctrl+Shift+F；终端：Ctrl+`'],
  },
]

// ============================================================
// IPC 注册（软件库管理页 + 通用指南 + 词典）
// ============================================================

export function setupSoftwareLibraryHandlers(): void {
  try {
    softwareLibrary.init()
  } catch (e) {
    logger.warn(`[SoftwareLibrary] init 失败: ${e}`)
  }

  // 列表
  ipcMain.handle('software-library:list', () => softwareLibrary.list())

  // 收录：手动添加
  ipcMain.handle('software-library:add', (_e, input) => {
    try {
      if (!input?.name) return { success: false, error: '软件名不能为空' }
      const entry = softwareLibrary.add(input)
      return { success: true, entry }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  // 收录：本机扫描
  ipcMain.handle('software-library:scan', async () => {
    try {
      const added = await scanInstalledSoftware()
      return { success: true, added }
    } catch (e) {
      logger.error(`[SoftwareLibrary] 扫描失败: ${e}`)
      return { success: false, error: e instanceof Error ? e.message : String(e), added: [] }
    }
  })

  // 收录：模板库导入
  ipcMain.handle('software-library:templates', () => PRESET_TEMPLATES)

  ipcMain.handle('software-library:import-template', (_e, templateId: string) => {
    const tpl = PRESET_TEMPLATES.find(t => t.id === templateId)
    if (!tpl) return { success: false, error: '模板不存在' }
    const entry = softwareLibrary.add({
      name: tpl.name, exe: tpl.exe, category: tpl.category,
      aliases: tpl.aliases, windowTitles: tpl.windowTitles,
      source: 'template', note: tpl.hints.join('；'),
    })
    return { success: true, entry }
  })

  // 删除
  ipcMain.handle('software-library:remove', (_e, id: string) => {
    try { return { success: softwareLibrary.remove(id) } } catch { return { success: false } }
  })

  // 状态流转（已学/待学/学习中/识别弱）
  ipcMain.handle('software-library:set-status', (_e, id: string, status: SoftwareStatus) => {
    try { return { success: softwareLibrary.setStatus(id, status) } } catch { return { success: false } }
  })

  // 标记为已学并关联技能包
  ipcMain.handle('software-library:link-skillpack', (_e, id: string, skillPackId: string) => {
    try { return { success: softwareLibrary.linkSkillPack(id, skillPackId) } } catch { return { success: false } }
  })

  // 通用操作指南列表（三层架构·通用层，前端展示与诊断）
  ipcMain.handle('software-library:guides', () => COMMON_GUIDES)

  // 词典（供诊断/意图匹配调试）
  ipcMain.handle('software-library:dictionary', () => softwareLibrary.getDictionary())

  // 意图命中查询（前端诊断：某意图命中哪个软件库条目）
  ipcMain.handle('software-library:match-intent', (_e, intent: string) => {
    const hit = softwareLibrary.matchIntent(intent || '')
    if (!hit) return null
    return { id: hit.id, name: hit.name, status: hit.status, category: hit.category, skillPackId: hit.skillPackId }
  })
}

// ============================================================
// 通用指南辅助：为未收录/未学软件生成「通用起手」知识块
// ============================================================

/** 获取通用操作指南提示块（通用层注入决策链路） */
export function buildGenericGuideBlock(appHint: string): string {
  const lines: string[] = []
  lines.push('【通用操作指南·跨软件共性起手】')
  if (appHint) lines.push(`目标软件：${appHint}（尚未有专用技能包，先按通用方法论试探）`)
  lines.push('')
  lines.push('请按以下跨软件共性模式操作，成功后将被沉淀为专用技能包：')
  for (const guide of COMMON_GUIDES.slice(0, 5)) {
    for (const h of guide.hints.slice(0, 2)) {
      lines.push(`- [${guide.name}] ${h.text}`)
    }
  }
  lines.push('')
  lines.push('提示：优先用 UIA 语义定位；定位失败回退视觉点击，每步操作后截图验证结果再继续。')
  return lines.join('\n')
}

/**
 * 词典补强意图匹配：当 skill-pack 未命中（阈值 20 短板）时，
 * 若软件库词典命中目标软件，则按该软件进入「通用层试探」，
 * 并在成功时沉淀为专用技能包（升入专用层）。
 */
export function matchWithLibrary(intent: string): { entry: SoftwareEntry; guideBlock: string } | null {
  const hit = softwareLibrary.matchIntent(intent)
  if (!hit) return null
  return { entry: hit, guideBlock: buildGenericGuideBlock(hit.name) }
}

/** 让软件库词典参与 skill-pack 打分（提高第三方软件识别率） */
export function boostSkillPackMatch(intent: string): void {
  try {
    const lib = softwareLibrary.matchIntent(intent)
    if (!lib) return
    // 若词典命中的软件已有专用技能包则无需通用层兜底；否则登记为待学/学习中
    const packExists = skillPackManager.list().some(p => p.app.toLowerCase() === lib.name.toLowerCase() || p.id === lib.skillPackId)
    if (!packExists && lib.status !== 'learned') {
      // 只更新内存状态，交由成功后 maybeLearn 沉淀升级
      lib.status = 'learning'
    }
  } catch { /* 词典补强失败不影响主流程 */ }
}
