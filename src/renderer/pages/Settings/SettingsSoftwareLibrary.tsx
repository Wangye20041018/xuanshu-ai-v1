import { useCallback, useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import {
  LayoutGrid, Search, Plus, Trash2, RefreshCw, Download, Loader2,
  FileWarning, CheckCircle2, HelpCircle, Play, BookOpen, MonitorSmartphone, Link2,
  ShieldCheck, ShieldAlert, Layers,
} from 'lucide-react'
import { COLORS, GlassCard } from './index'

/* ============================================================
 * 软件库管理页 — #27 第三方软件收录与学习体系
 * 收录列表（已学/待学/学习中/识别弱 四态）+ 添加/删除 + 模板导入 + 示范录制入口
 * ============================================================ */

type SoftwareStatus = 'learned' | 'to-learn' | 'learning' | 'weak'
type SoftwareSource = 'scan' | 'manual' | 'template' | 'learn'

interface SoftwareEntry {
  id: string
  name: string
  exe?: string
  installPath?: string
  category: string
  source: SoftwareSource
  status: SoftwareStatus
  windowTitles: string[]
  aliases: string[]
  skillPackId?: string
  learnCount: number
  createdAt: number
  updatedAt: number
  note?: string
}

interface SoftwareTemplate {
  id: string
  name: string
  exe: string
  category: string
  aliases: string[]
  windowTitles: string[]
  hints: string[]
}

interface CommonGuide {
  id: string
  name: string
  hints: { category: string; text: string }[]
}

/* C3：控制能力与安全授权（真实数据：技能包能力 + 当前授权级别/放行范围） */
interface SkillPackAction { id: string; name: string; description?: string }
interface SkillPackInfo { id: string; app: string; version?: string; actions: SkillPackAction[] }
interface AuthLevelInfo { level: number; name: string; desc: string }
interface AuthInfo {
  level: number
  levels: AuthLevelInfo[]
  levelCapabilities: Record<number, string[]>
  trustList: unknown[]
}

const STATUS_META: Record<SoftwareStatus, { label: string; color: string; bg: string }> = {
  learned: { label: '已学', color: '#4ade80', bg: '#4ade8018' },
  'to-learn': { label: '待学', color: '#fbbf24', bg: '#fbbf2418' },
  learning: { label: '学习中', color: '#818cf8', bg: '#818cf818' },
  weak: { label: '识别弱', color: '#f87171', bg: '#f8717118' },
}

const SOURCE_LABEL: Record<SoftwareSource, string> = {
  scan: '本机扫描',
  manual: '手动添加',
  template: '模板库',
  learn: '示范学习',
}

const CATEGORIES = ['通讯会议', '办公', '设计影音', '游戏', '浏览器', '开发', '影音播放', '其他']

export default function SettingsSoftwareLibrary() {
  const [entries, setEntries] = useState<SoftwareEntry[]>([])
  const [templates, setTemplates] = useState<SoftwareTemplate[]>([])
  const [guides, setGuides] = useState<CommonGuide[]>([])
  const [skillPacks, setSkillPacks] = useState<SkillPackInfo[]>([])
  const [authInfo, setAuthInfo] = useState<AuthInfo | null>(null)
  const [learnedSkillCount, setLearnedSkillCount] = useState(0)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [errorMsg, setErrorMsg] = useState('')
  const [flash, setFlash] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [scanning, setScanning] = useState(false)
  const [filter, setFilter] = useState<'all' | SoftwareStatus>('all')
  const [keyword, setKeyword] = useState('')

  /* 手动添加表单 */
  const [newName, setNewName] = useState('')
  const [newExe, setNewExe] = useState('')
  const [newPath, setNewPath] = useState('')
  const [newCategory, setNewCategory] = useState(CATEGORIES[CATEGORIES.length - 1])
  const [newAliases, setNewAliases] = useState('')
  const [newNote, setNewNote] = useState('')
  const [linkingEntryId, setLinkingEntryId] = useState<string | null>(null)
  const [linkingPackId, setLinkingPackId] = useState('')

  const showFlash = useCallback((type: 'success' | 'error', text: string) => {
    setFlash({ type, text })
    if (flashTimer.current) clearTimeout(flashTimer.current)
    flashTimer.current = setTimeout(() => setFlash(null), 2500)
  }, [])

  const load = useCallback(async () => {
    setStatus('loading')
    setErrorMsg('')
    try {
      const [list, tpl, gd] = await Promise.all([
        window.api.invoke<SoftwareEntry[]>('software-library:list'),
        window.api.invoke<SoftwareTemplate[]>('software-library:templates'),
        window.api.invoke<CommonGuide[]>('software-library:guides'),
      ])
      setEntries(Array.isArray(list) ? list : [])
      setTemplates(Array.isArray(tpl) ? tpl : [])
      setGuides(Array.isArray(gd) ? gd : [])
      // C3：控制能力/授权为增强展示，任一失败不阻塞主列表
      try {
        const packs = await window.api.invoke<SkillPackInfo[]>('skill-pack:list')
        setSkillPacks(Array.isArray(packs) ? packs : [])
      } catch { setSkillPacks([]) }
      try {
        const auth = await window.api.invoke<AuthInfo>('authorization:get-state')
        setAuthInfo(auth || null)
      } catch { setAuthInfo(null) }
      try {
        const learned = await window.api.invoke<unknown[]>('skill-pack:learned-list')
        setLearnedSkillCount(Array.isArray(learned) ? learned.length : 0)
      } catch { setLearnedSkillCount(0) }
      setStatus('ready')
    } catch (e) {
      setStatus('error')
      setErrorMsg(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    load()
    return () => {
      if (flashTimer.current) clearTimeout(flashTimer.current)
    }
  }, [load])

  const handleScan = async () => {
    setScanning(true)
    try {
      const res = await window.api.invoke<{ success?: boolean; added?: SoftwareEntry[]; error?: string }>('software-library:scan')
      if (res?.success) {
        showFlash('success', `本机扫描完成，新收录 ${res.added?.length ?? 0} 个软件`)
      } else {
        showFlash('error', res?.error || '扫描失败')
      }
      await load()
    } catch (e) {
      showFlash('error', e instanceof Error ? e.message : String(e))
    } finally {
      setScanning(false)
    }
  }

  const handleAdd = async () => {
    if (!newName.trim()) {
      showFlash('error', '请输入软件名')
      return
    }
    const aliases = newAliases.split(/[,，、\s]+/).filter(Boolean)
    try {
      const res = await window.api.invoke<{ success?: boolean; entry?: SoftwareEntry; error?: string }>(
        'software-library:add',
        {
          name: newName.trim(),
          exe: newExe.trim() || undefined,
          installPath: newPath.trim() || undefined,
          category: newCategory,
          aliases,
          source: 'manual',
          note: newNote.trim() || undefined,
        },
      )
      if (res?.success) {
        showFlash('success', `已收录「${newName.trim()}」`)
        setNewName('')
        setNewExe('')
        setNewPath('')
        setNewAliases('')
        setNewNote('')
        await load()
      } else {
        showFlash('error', res?.error || '添加失败')
      }
    } catch (e) {
      showFlash('error', e instanceof Error ? e.message : String(e))
    }
  }

  const handleImportTemplate = async (tplId: string, name: string) => {
    try {
      const res = await window.api.invoke<{ success?: boolean; entry?: SoftwareEntry; error?: string }>('software-library:import-template', tplId)
      if (res?.success) {
        showFlash('success', `模板「${name}」已导入软件库（待学）`)
        await load()
      } else {
        showFlash('error', res?.error || '模板导入失败')
      }
    } catch (e) {
      showFlash('error', e instanceof Error ? e.message : String(e))
    }
  }

  const handleRemove = async (id: string, name: string) => {
    const ok = window.confirm(`确定从软件库删除「${name}」吗？删除后不再参与词典匹配与意图识别。`)
    if (!ok) return
    try {
      await window.api.invoke('software-library:remove', id)
      showFlash('success', `已删除「${name}」`)
      await load()
    } catch (e) {
      showFlash('error', e instanceof Error ? e.message : String(e))
    }
  }

  const handleSetStatus = async (id: string, name: string, st: SoftwareStatus) => {
    try {
      await window.api.invoke('software-library:set-status', id, st)
      showFlash('success', `「${name}」状态已更新`)
      await load()
    } catch (e) {
      showFlash('error', e instanceof Error ? e.message : String(e))
    }
  }

  const handleStartLearn = (entry: SoftwareEntry) => {
    // C3：不再使用占位确认框——真实关联技能包（skill-pack 内建能力，落盘持久化）。
    // 提示：真实「示范轨迹录制」（截图+动作序列自动沉淀学习型技能包）尚未接通，
    // 需要视觉轨迹录制通道后启用；当前可先手动关联内建技能包获得即用能力。
    setLinkingEntryId(entry.id)
    setLinkingPackId(entry.skillPackId || '')
  }

  const handleLinkSkillpack = async (entry: SoftwareEntry) => {
    if (!linkingPackId) {
      showFlash('error', '请先选择要关联的技能包')
      return
    }
    try {
      const res = await window.api.invoke<{ success?: boolean }>('software-library:link-skillpack', entry.id, linkingPackId)
      if (res?.success) {
        showFlash('success', `「${entry.name}」已关联技能包「${linkingPackId}」`)
        setLinkingEntryId(null)
        await load()
      } else {
        showFlash('error', '关联失败，请重试')
      }
    } catch (e) {
      showFlash('error', e instanceof Error ? e.message : String(e))
    }
  }

  const inputStyle: React.CSSProperties = {
    background: 'rgba(255,255,255,0.06)', color: COLORS.textSecondary,
    border: `1px solid ${COLORS.cardBorder}`, borderRadius: 10,
    padding: '8px 12px', fontSize: 12, outline: 'none', width: '100%',
  }
  const selectStyle: React.CSSProperties = { ...inputStyle, cursor: 'pointer', appearance: 'auto' }

  const filtered = entries.filter((e) => {
    if (filter !== 'all' && e.status !== filter) return false
    if (keyword.trim()) {
      const k = keyword.trim().toLowerCase()
      if (!e.name.toLowerCase().includes(k) && !(e.exe || '').toLowerCase().includes(k) && !e.aliases.some((a) => a.toLowerCase().includes(k))) return false
    }
    return true
  })

  const counts = {
    all: entries.length,
    learned: entries.filter((e) => e.status === 'learned').length,
    'to-learn': entries.filter((e) => e.status === 'to-learn').length,
    learning: entries.filter((e) => e.status === 'learning').length,
    weak: entries.filter((e) => e.status === 'weak').length,
  }

  return (
    <GlassCard
      title="软件库"
      icon={<LayoutGrid size={18} />}
      accentColor={COLORS.violet}
      headerRight={
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button onClick={load} style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'transparent', border: 'none', color: COLORS.textMuted, cursor: 'pointer', fontSize: 12 }}>
            <RefreshCw size={14} /> 刷新
          </button>
          <motion.button
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            onClick={handleScan}
            disabled={scanning}
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 14px', borderRadius: 10, border: 'none', background: 'linear-gradient(135deg, #a78bfa, #818cf8)', color: '#fff', fontWeight: 600, fontSize: 12, cursor: 'pointer', opacity: scanning ? 0.6 : 1 }}
          >
            {scanning ? <Loader2 size={14} className="animate-spin" /> : <MonitorSmartphone size={14} />}
            {scanning ? '扫描中...' : '扫描本机软件'}
          </motion.button>
        </div>
      }
    >
      {flash && (
        <div
          style={{
            marginBottom: 12, padding: '8px 12px', borderRadius: 10, fontSize: 12,
            background: flash.type === 'success' ? 'rgba(74,222,128,0.12)' : 'rgba(248,113,113,0.12)',
            color: flash.type === 'success' ? '#4ade80' : '#f87171',
            border: `1px solid ${flash.type === 'success' ? '#4ade8030' : '#f8717130'}`,
          }}
        >
          {flash.text}
        </div>
      )}

      {status === 'loading' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: COLORS.textMuted, fontSize: 13, padding: 20 }}>
          <Loader2 size={16} className="animate-spin" /> 加载软件库...
        </div>
      )}
      {status === 'error' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: COLORS.danger, fontSize: 13, padding: 20 }}>
          <FileWarning size={16} /> 软件库加载失败：{errorMsg}
        </div>
      )}
      {status === 'ready' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {/* ---------- C3：控制能力与安全授权（真实数据：技能包能力 + 授权级别/放行范围）---------- */}
          <div style={{ padding: 14, borderRadius: 14, border: '1px solid rgba(129,140,248,0.35)', background: 'rgba(129,140,248,0.06)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <ShieldCheck size={16} style={{ color: '#818cf8' }} />
              <span style={{ fontSize: 13, fontWeight: 700, color: COLORS.textPrimary }}>控制能力与安全授权</span>
              <span style={{ fontSize: 11, color: COLORS.textMuted }}>玄枢当前可执行的电脑控制能力与授权边界（来自本机真实状态）</span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.4fr', gap: 14 }}>
              {/* 授权范围 */}
              <div style={{ padding: 12, borderRadius: 12, border: `1px solid ${COLORS.cardBorder}`, background: 'rgba(255,255,255,0.02)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, color: COLORS.textSecondary, marginBottom: 8 }}>
                  <ShieldAlert size={13} /> 当前授权级别
                  {authInfo && <span style={{ fontSize: 11, color: COLORS.textMuted }}>· 信任条目 {authInfo.trustList?.length ?? 0} 条</span>}
                </div>
                {authInfo ? (
                  <>
                    <div style={{ fontSize: 13, fontWeight: 700, color: '#818cf8' }}>
                      {(authInfo.levels || []).find((l) => l.level === authInfo.level)?.name || `L${authInfo.level}`}
                    </div>
                    <div style={{ fontSize: 11, color: COLORS.textMuted, lineHeight: 1.6, marginTop: 4 }}>
                      {(authInfo.levels || []).find((l) => l.level === authInfo.level)?.desc || ''}
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                      {(authInfo.levelCapabilities?.[authInfo.level] || []).map((cap, i) => (
                        <span key={i} style={{ fontSize: 10, padding: '3px 8px', borderRadius: 8, background: 'rgba(129,140,248,0.14)', color: '#c7d2fe' }}>{cap}</span>
                      ))}
                    </div>
                  </>
                ) : (
                  <div style={{ fontSize: 12, color: COLORS.textMuted, opacity: 0.7 }}>未获取到授权状态（authorization:get-state 不可用）</div>
                )}
                <div style={{ fontSize: 11, color: COLORS.textMuted, marginTop: 8, opacity: 0.8 }}>
                  授权级别可在「设置 · 分级授权」中调整；每次电脑操控都会记录到操作日志。
                </div>
              </div>
              {/* 可控能力（技能包） */}
              <div style={{ padding: 12, borderRadius: 12, border: `1px solid ${COLORS.cardBorder}`, background: 'rgba(255,255,255,0.02)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, color: COLORS.textSecondary, marginBottom: 8 }}>
                  <Layers size={13} /> 已登记可控能力
                  {learnedSkillCount > 0 && <span style={{ fontSize: 11, color: '#4ade80' }}>· 学习型技能包 {learnedSkillCount} 个</span>}
                </div>
                {skillPacks.length > 0 ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {skillPacks.map((p) => (
                      <div key={p.id} style={{ padding: '8px 10px', borderRadius: 10, border: `1px solid ${COLORS.cardBorder}`, background: 'rgba(255,255,255,0.015)' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span style={{ fontSize: 12, fontWeight: 600, color: COLORS.textPrimary }}>{p.app}</span>
                          <span style={{ fontSize: 10, color: COLORS.textMuted }}>{p.id}{p.version ? ` v${p.version}` : ''}</span>
                          <span style={{ fontSize: 10, color: '#818cf8' }}>{p.actions.length} 项能力</span>
                        </div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 5 }}>
                          {p.actions.slice(0, 8).map((a) => (
                            <span key={a.id} title={a.description || ''} style={{ fontSize: 10, padding: '2px 7px', borderRadius: 7, background: 'rgba(255,255,255,0.05)', color: COLORS.textSecondary }}>{a.name}</span>
                          ))}
                          {p.actions.length > 8 && <span style={{ fontSize: 10, color: COLORS.textMuted }}>+{p.actions.length - 8} 项</span>}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div style={{ fontSize: 12, color: COLORS.textMuted, opacity: 0.7 }}>未获取到技能包能力（skill-pack:list 不可用）</div>
                )}
              </div>
            </div>
          </div>

          {/* ---------- 四态统计 ---------- */}
          <div style={{ display: 'flex', gap: 10 }}>
            {(['all', 'learned', 'to-learn', 'learning', 'weak'] as const).map((k) => {
              const meta = k === 'all'
                ? { label: '全部', color: COLORS.textPrimary, bg: 'rgba(255,255,255,0.05)' }
                : STATUS_META[k]
              const active = filter === k
              return (
                <motion.button
                  key={k}
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.97 }}
                  onClick={() => setFilter(k)}
                  style={{
                    padding: '8px 14px', borderRadius: 12, cursor: 'pointer',
                    border: `1px solid ${active ? `${meta.color}60` : COLORS.cardBorder}`,
                    background: active ? meta.bg : 'rgba(255,255,255,0.015)',
                    display: 'flex', alignItems: 'center', gap: 8, transition: 'all 0.3s',
                  }}
                >
                  <span style={{ fontSize: 12, color: active ? meta.color : COLORS.textSecondary }}>{meta.label}</span>
                  <span style={{ fontSize: 12, fontWeight: 700, color: meta.color }}>{counts[k]}</span>
                </motion.button>
              )
            })}
          </div>

          {/* ---------- 收录（四路） ---------- */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <Plus size={14} style={{ color: COLORS.accent }} />
              <span style={{ fontSize: 13, fontWeight: 600, color: COLORS.textPrimary }}>收录</span>
              <span style={{ fontSize: 12, color: COLORS.textMuted }}>四路：本机扫描 / 手动添加 / 模板库 / 示范学习</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {/* 手动添加 */}
              <div style={{ padding: 12, borderRadius: 12, border: `1px solid ${COLORS.cardBorder}`, background: 'rgba(255,255,255,0.02)' }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: COLORS.textSecondary, marginBottom: 8 }}>手动添加软件</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  <input style={inputStyle} placeholder="软件名 *（如 腾讯会议）" value={newName} onChange={(e) => setNewName(e.target.value)} />
                  <input style={inputStyle} placeholder="可执行文件名（如 wemeetapp.exe，词典项）" value={newExe} onChange={(e) => setNewExe(e.target.value)} />
                  <input style={inputStyle} placeholder="安装路径（可选）" value={newPath} onChange={(e) => setNewPath(e.target.value)} />
                  <select style={selectStyle} value={newCategory} onChange={(e) => setNewCategory(e.target.value)}>
                    {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                  <input style={inputStyle} placeholder="别名（逗号分隔，可选，如 wemeet）" value={newAliases} onChange={(e) => setNewAliases(e.target.value)} />
                  <input style={inputStyle} placeholder="备注（可选）" value={newNote} onChange={(e) => setNewNote(e.target.value)} />
                </div>
                <motion.button
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  onClick={handleAdd}
                  style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 10, padding: '8px 16px', borderRadius: 10, border: 'none', background: 'linear-gradient(135deg, #a78bfa, #818cf8)', color: '#fff', fontWeight: 600, fontSize: 12, cursor: 'pointer' }}
                >
                  <Plus size={14} /> 添加到软件库
                </motion.button>
              </div>

              {/* 模板库 */}
              <div style={{ padding: 12, borderRadius: 12, border: `1px solid ${COLORS.cardBorder}`, background: 'rgba(255,255,255,0.02)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <Download size={13} style={{ color: COLORS.accent }} />
                  <span style={{ fontSize: 12, fontWeight: 600, color: COLORS.textSecondary }}>预置模板库</span>
                  <span style={{ fontSize: 11, color: COLORS.textMuted }}>一键导入常见软件操作要点（进入待学）</span>
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {templates.map((t) => {
                    const already = entries.some((e) => e.name === t.name || e.exe === t.exe)
                    return (
                      <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderRadius: 10, border: `1px solid ${COLORS.cardBorder}`, background: 'rgba(255,255,255,0.02)' }}>
                        <span style={{ fontSize: 12, color: COLORS.textPrimary }}>{t.name}</span>
                        <span style={{ fontSize: 10, color: COLORS.textMuted }}>{t.category}</span>
                        {already ? (
                          <span style={{ fontSize: 10, color: '#4ade80', flexShrink: 0 }}>已收录</span>
                        ) : (
                          <button onClick={() => handleImportTemplate(t.id, t.name)} style={{ background: 'transparent', border: 'none', color: COLORS.accent, cursor: 'pointer', fontSize: 11, flexShrink: 0 }}>
                            + 导入
                          </button>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            </div>
          </div>

          {/* ---------- 收录列表 ---------- */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <Search size={14} style={{ color: COLORS.accent }} />
              <span style={{ fontSize: 13, fontWeight: 600, color: COLORS.textPrimary }}>收录列表</span>
              <input
                style={{ ...inputStyle, maxWidth: 220, marginLeft: 8, padding: '5px 10px' }}
                placeholder="搜索软件名 / exe / 别名..."
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
              />
            </div>
            {filtered.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {filtered.map((e) => {
                  const meta = STATUS_META[e.status]
                  return (
                    <div key={e.id} style={{ padding: '12px 14px', borderRadius: 12, border: `1px solid ${COLORS.cardBorder}`, background: 'rgba(255,255,255,0.02)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <div style={{ width: 34, height: 34, borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', background: meta.bg, color: meta.color, flexShrink: 0 }}>
                          {e.status === 'learned' ? <CheckCircle2 size={16} /> : e.status === 'weak' ? <HelpCircle size={16} /> : e.status === 'learning' ? <Play size={16} /> : <BookOpen size={16} />}
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                            <span style={{ fontSize: 13, fontWeight: 600, color: COLORS.textPrimary }}>{e.name}</span>
                            <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 8, background: meta.bg, color: meta.color }}>{meta.label}</span>
                            <span style={{ fontSize: 10, color: COLORS.textMuted }}>{SOURCE_LABEL[e.source]}</span>
                            {e.skillPackId && (
                              <span style={{ fontSize: 10, display: 'flex', alignItems: 'center', gap: 4, color: '#818cf8' }}>
                                <Link2 size={10} /> {e.skillPackId}
                              </span>
                            )}
                            {e.learnCount > 0 && <span style={{ fontSize: 10, color: COLORS.textMuted }}>学习 {e.learnCount} 次</span>}
                          </div>
                          <div style={{ fontSize: 11, color: COLORS.textMuted, marginTop: 3, wordBreak: 'break-all' }}>
                            {e.category}{e.exe ? ` · ${e.exe}` : ''}{e.installPath ? ` · ${e.installPath}` : ''}
                          </div>
                          {(e.aliases.length > 0 || e.windowTitles.length > 0) && (
                            <div style={{ fontSize: 11, color: COLORS.textMuted, marginTop: 2, opacity: 0.8 }}>
                              词典：{[e.aliases.join('/'), ...e.windowTitles].filter(Boolean).join(' · ')}
                            </div>
                          )}
                          {e.note && <div style={{ fontSize: 11, color: COLORS.textMuted, marginTop: 2, opacity: 0.7 }}>{e.note}</div>}
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flexShrink: 0 }}>
                          <div style={{ display: 'flex', gap: 6 }}>
                            <button
                              onClick={() => handleStartLearn(e)}
                              title="关联技能包：将内建操控能力绑定到该软件"
                              style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '5px 10px', borderRadius: 8, border: 'none', background: 'linear-gradient(135deg, #34d399, #22d3ee)', color: '#000', fontWeight: 600, fontSize: 11, cursor: 'pointer' }}
                            >
                              <Link2 size={11} /> {e.skillPackId ? '更换技能包' : '关联技能包'}
                            </button>
                            {linkingEntryId === e.id && (
                              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                                <select
                                  style={{ ...selectStyle, fontSize: 11, padding: '4px 8px', width: 170 }}
                                  value={linkingPackId}
                                  onChange={(ev) => setLinkingPackId(ev.target.value)}
                                >
                                  <option value="">选择技能包...</option>
                                  {skillPacks.map((p) => (
                                    <option key={p.id} value={p.id}>{p.app}（{p.actions.length} 项能力）</option>
                                  ))}
                                </select>
                                <button
                                  onClick={() => handleLinkSkillpack(e)}
                                  style={{ padding: '4px 10px', borderRadius: 8, border: 'none', background: 'rgba(129,140,248,0.25)', color: '#c7d2fe', fontWeight: 600, fontSize: 11, cursor: 'pointer' }}
                                >
                                  确认关联
                                </button>
                                <button
                                  onClick={() => setLinkingEntryId(null)}
                                  style={{ padding: '4px 8px', borderRadius: 8, border: 'none', background: 'transparent', color: COLORS.textMuted, fontSize: 11, cursor: 'pointer' }}
                                >
                                  取消
                                </button>
                              </div>
                            )}
                            <button
                              onClick={() => handleRemove(e.id, e.name)}
                              title="删除"
                              style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 26, height: 26, borderRadius: 8, border: 'none', background: 'rgba(248,113,113,0.1)', color: COLORS.danger, cursor: 'pointer' }}
                            >
                              <Trash2 size={12} />
                            </button>
                          </div>
                          <select
                            style={{ ...selectStyle, fontSize: 11, padding: '4px 8px' }}
                            value={e.status}
                            onChange={(ev) => handleSetStatus(e.id, e.name, ev.target.value as SoftwareStatus)}
                            title="修改状态"
                          >
                            <option value="learned">已学</option>
                            <option value="to-learn">待学</option>
                            <option value="learning">学习中</option>
                            <option value="weak">识别弱</option>
                          </select>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            ) : (
              <div style={{ fontSize: 12, color: COLORS.textMuted, opacity: 0.7, textAlign: 'center', padding: 20 }}>
                暂无符合条件的软件。可点击右上角「扫描本机软件」或手动添加 / 导入模板。
              </div>
            )}
          </div>

          {/* ---------- 通用操作指南（三层架构·通用层展示） ---------- */}
          <div style={{ height: 1, background: 'rgba(255,255,255,0.06)' }} />
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <BookOpen size={14} style={{ color: COLORS.accent }} />
              <span style={{ fontSize: 13, fontWeight: 600, color: COLORS.textPrimary }}>通用操作指南（通用层）</span>
              <span style={{ fontSize: 12, color: COLORS.textMuted }}>跨软件共性操控方法论，未收录软件据此「通用起手」，成功后自动沉淀为专用技能包</span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 8 }}>
              {guides.map((g) => (
                <div key={g.id} style={{ padding: 10, borderRadius: 12, border: `1px solid ${COLORS.cardBorder}`, background: 'rgba(255,255,255,0.02)' }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: COLORS.textPrimary, marginBottom: 6 }}>{g.name}</div>
                  {g.hints.slice(0, 2).map((h, i) => (
                    <div key={i} style={{ fontSize: 11, color: COLORS.textMuted, lineHeight: 1.6 }}>· {h.text}</div>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </GlassCard>
  )
}
