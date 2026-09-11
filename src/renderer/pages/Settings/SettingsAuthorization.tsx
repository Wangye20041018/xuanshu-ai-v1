import { useCallback, useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import {
  Shield, ShieldAlert, ShieldCheck, Lock, KeyRound, History,
  UserPlus, Trash2, RefreshCw, FileWarning, Loader2, Plus,
} from 'lucide-react'
import { COLORS, GlassCard } from './index'

/* ============================================================
 * 分级授权设置页 — #26 操控能力深度开放
 * 级别配置 + 信任列表 + 操作日志
 * ============================================================ */

interface LevelInfo {
  level: number
  name: string
  desc: string
}

interface AuthState {
  level: number
  levelCapabilities: Record<number, string[]>
  trustList: TrustEntry[]
  levels: LevelInfo[]
}

interface TrustEntry {
  id: string
  kind: 'command' | 'tool' | 'software'
  key: string
  trusted: boolean
  createdAt: number
  note?: string
}

interface OpLog {
  id: string
  time: number
  channel: string
  action: string
  level: number
  levelName: string
  decision: 'allow' | 'confirm' | 'deny' | 'blocked'
  detail?: string
}

interface TrustedCommand {
  id: string
  name: string
  exe: string
  args: string[]
  description: string
  level: number
  addedAt: number
}

interface BuiltinCmd {
  cmdKey: string
  level: number
}

const KIND_LABEL: Record<TrustEntry['kind'], string> = {
  command: '命令',
  tool: '工具',
  software: '软件',
}

const DECISION_COLOR: Record<OpLog['decision'], string> = {
  allow: '#4ade80',
  confirm: '#fbbf24',
  deny: '#f87171',
  blocked: '#f87171',
}

const DECISION_LABEL: Record<OpLog['decision'], string> = {
  allow: '放行',
  confirm: '需确认',
  deny: '拒绝',
  blocked: '拦截',
}

const LEVEL_LABEL: Record<number, string> = {
  0: 'L0 · 已授权',
  1: 'L1 · 留痕',
  2: 'L2 · 需确认',
  3: 'L3 · 需管理员',
  4: 'L4 · 禁止',
}

export default function SettingsAuthorization() {
  const [authState, setAuthState] = useState<AuthState | null>(null)
  const [logs, setLogs] = useState<OpLog[]>([])
  const [trustedCmds, setTrustedCmds] = useState<TrustedCommand[]>([])
  const [builtins, setBuiltins] = useState<BuiltinCmd[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [errorMsg, setErrorMsg] = useState('')
  const [flash, setFlash] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  /* 新增信任项表单 */
  const [newTrustKind, setNewTrustKind] = useState<TrustEntry['kind']>('command')
  const [newTrustKey, setNewTrustKey] = useState('')
  const [newTrustNote, setNewTrustNote] = useState('')

  /* 新增受信命令表单 */
  const [newCmdName, setNewCmdName] = useState('')
  const [newCmdExe, setNewCmdExe] = useState('')
  const [newCmdArgs, setNewCmdArgs] = useState('')
  const [newCmdDesc, setNewCmdDesc] = useState('')
  const [newCmdLevel, setNewCmdLevel] = useState(1)

  const showFlash = useCallback((type: 'success' | 'error', text: string) => {
    setFlash({ type, text })
    if (flashTimer.current) clearTimeout(flashTimer.current)
    flashTimer.current = setTimeout(() => setFlash(null), 2500)
  }, [])

  const load = useCallback(async () => {
    setStatus('loading')
    setErrorMsg('')
    try {
      const [state, logsRes, cmds, built] = await Promise.all([
        window.api.invoke<AuthState>('authorization:get-state'),
        window.api.invoke<OpLog[]>('authorization:list-logs', 60),
        window.api.invoke<TrustedCommand[]>('command-policy:list-trusted'),
        window.api.invoke<BuiltinCmd[]>('command-policy:list-builtins'),
      ])
      setAuthState(state)
      setLogs(Array.isArray(logsRes) ? logsRes : [])
      setTrustedCmds(Array.isArray(cmds) ? cmds : [])
      setBuiltins(Array.isArray(built) ? built : [])
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

  const handleSetLevel = async (level: number) => {
    try {
      const res = await window.api.invoke<{ success?: boolean; error?: string }>('authorization:set-level', level)
      if (res?.success) {
        showFlash('success', `授权级别已切换为 ${LEVEL_LABEL[level] ?? `L${level}`}`)
        await load()
      } else {
        showFlash('error', res?.error || '级别切换失败')
      }
    } catch (e) {
      showFlash('error', e instanceof Error ? e.message : String(e))
    }
  }

  const handleAddTrust = async () => {
    if (!newTrustKey.trim()) {
      showFlash('error', '请输入命令名 / 工具名 / 软件名')
      return
    }
    try {
      const res = await window.api.invoke<{ success?: boolean; trust?: TrustEntry[] }>(
        'authorization:add-trust', newTrustKind, newTrustKey.trim(), true, newTrustNote.trim() || undefined,
      )
      if (res?.success) {
        showFlash('success', '信任项已添加（该操作免确认直接放行）')
        setNewTrustKey('')
        setNewTrustNote('')
        await load()
      } else {
        showFlash('error', '添加失败：可能已存在该信任项')
      }
    } catch (e) {
      showFlash('error', e instanceof Error ? e.message : String(e))
    }
  }

  const handleRemoveTrust = async (id: string) => {
    try {
      await window.api.invoke('authorization:remove-trust', id)
      showFlash('success', '信任项已移除')
      await load()
    } catch (e) {
      showFlash('error', e instanceof Error ? e.message : String(e))
    }
  }

  const handleClearLogs = async () => {
    const ok = window.confirm('确定清空全部操作日志吗？该操作不可恢复。')
    if (!ok) return
    try {
      await window.api.invoke('authorization:clear-logs')
      setLogs([])
      showFlash('success', '操作日志已清空')
    } catch (e) {
      showFlash('error', e instanceof Error ? e.message : String(e))
    }
  }

  const handleAddCommand = async () => {
    if (!newCmdName.trim() || !newCmdExe.trim()) {
      showFlash('error', '受信命令需填写命令名与可执行文件路径')
      return
    }
    const args = newCmdArgs.split(/\s+/).filter(Boolean)
    try {
      const res = await window.api.invoke<{ success?: boolean; error?: string }>(
        'command-policy:add-trusted',
        { name: newCmdName.trim(), exe: newCmdExe.trim(), args, description: newCmdDesc.trim(), level: newCmdLevel },
      )
      if (res?.success) {
        showFlash('success', `受信命令「${newCmdName.trim()}」已添加`)
        setNewCmdName('')
        setNewCmdExe('')
        setNewCmdArgs('')
        setNewCmdDesc('')
        await load()
      } else {
        showFlash('error', res?.error || '添加失败')
      }
    } catch (e) {
      showFlash('error', e instanceof Error ? e.message : String(e))
    }
  }

  const handleRemoveCommand = async (id: string, name: string) => {
    const ok = window.confirm(`确定移除受信命令「${name}」吗？移除后将不再允许执行。`)
    if (!ok) return
    try {
      await window.api.invoke('command-policy:remove-trusted', id)
      showFlash('success', `受信命令「${name}」已移除`)
      await load()
    } catch (e) {
      showFlash('error', e instanceof Error ? e.message : String(e))
    }
  }

  const handleSetBuiltinLevel = async (cmdKey: string, level: number) => {
    try {
      const res = await window.api.invoke<{ success?: boolean }>('command-policy:set-builtin-level', cmdKey, level)
      if (res?.success) {
        showFlash('success', `内置命令「${cmdKey}」级别已调整为 ${LEVEL_LABEL[level]}`)
        await load()
      }
    } catch (e) {
      showFlash('error', e instanceof Error ? e.message : String(e))
    }
  }

  const fmtTime = (ts: number) => {
    const d = new Date(ts)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
  }

  const inputStyle: React.CSSProperties = {
    background: 'rgba(255,255,255,0.06)', color: COLORS.textSecondary,
    border: `1px solid ${COLORS.cardBorder}`, borderRadius: 10,
    padding: '8px 12px', fontSize: 12, outline: 'none', width: '100%',
  }
  const selectStyle: React.CSSProperties = {
    ...inputStyle,
    cursor: 'pointer',
    appearance: 'auto',
  }

  return (
    <GlassCard
      title="分级授权设置"
      icon={<ShieldCheck size={18} />}
      accentColor={COLORS.violet}
      headerRight={
        <button
          onClick={load}
          style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'transparent', border: 'none', color: COLORS.textMuted, cursor: 'pointer', fontSize: 12 }}
        >
          <RefreshCw size={14} /> 刷新
        </button>
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
          <Loader2 size={16} className="animate-spin" /> 加载授权状态...
        </div>
      )}
      {status === 'error' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: COLORS.danger, fontSize: 13, padding: 20 }}>
          <FileWarning size={16} /> 授权状态加载失败：{errorMsg}
        </div>
      )}
      {status === 'ready' && authState && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {/* ---------- 级别配置 ---------- */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <KeyRound size={14} style={{ color: COLORS.accent }} />
              <span style={{ fontSize: 13, fontWeight: 600, color: COLORS.textPrimary }}>当前授权级别</span>
              <span style={{ fontSize: 12, color: COLORS.textMuted }}>决定系统级能力开放范围</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {authState.levels.map((lv) => {
                const active = lv.level === authState.level
                const danger = lv.level === 4
                return (
                  <motion.div
                    key={lv.level}
                    whileHover={{ borderColor: COLORS.cardBorderHover }}
                    onClick={() => handleSetLevel(lv.level)}
                    style={{
                      padding: '12px 16px', borderRadius: 14, cursor: 'pointer',
                      border: `1px solid ${active ? `${COLORS.violet}60` : COLORS.cardBorder}`,
                      background: active
                        ? `linear-gradient(90deg, ${COLORS.violet}1a, transparent)`
                        : 'rgba(255,255,255,0.015)',
                      display: 'flex', alignItems: 'center', gap: 12,
                      transition: 'all 0.3s',
                    }}
                  >
                    <div style={{ width: 34, height: 34, borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', background: active ? `${COLORS.violet}22` : 'rgba(255,255,255,0.05)', color: danger ? COLORS.danger : (active ? COLORS.violet : COLORS.textMuted), flexShrink: 0 }}>
                      {danger ? <ShieldAlert size={16} /> : active ? <ShieldCheck size={16} /> : <Shield size={16} />}
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: active ? COLORS.violet : COLORS.textPrimary }}>
                        {lv.name}
                        {active && <span style={{ marginLeft: 8, fontSize: 10, padding: '2px 8px', borderRadius: 8, background: `${COLORS.violet}20`, color: COLORS.violet }}>当前</span>}
                      </div>
                      <div style={{ fontSize: 12, color: COLORS.textMuted, marginTop: 2 }}>{lv.desc}</div>
                    </div>
                    <div style={{ display: 'flex', gap: 4 }}>
                      <div style={{ width: 22, height: 4, borderRadius: 2, background: lv.level <= authState.level ? COLORS.violet : 'rgba(255,255,255,0.08)' }} />
                    </div>
                  </motion.div>
                )
              })}
            </div>
            {authState.levelCapabilities && (
              <div style={{ marginTop: 10, fontSize: 11, color: COLORS.textMuted, lineHeight: 1.6 }}>
                当前级别开放能力：{(authState.levelCapabilities[authState.level] || []).join('、') || '无（L4 禁止）'}
              </div>
            )}
          </div>

          {/* ---------- 受信命令区 ---------- */}
          <div style={{ height: 1, background: 'rgba(255,255,255,0.06)' }} />
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <Lock size={14} style={{ color: COLORS.accent }} />
              <span style={{ fontSize: 13, fontWeight: 600, color: COLORS.textPrimary }}>受信命令区</span>
              <span style={{ fontSize: 12, color: COLORS.textMuted }}>白名单化的自定义命令（可执行文件 + 固定参数，spawn 无 shell 执行）</span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 }}>
              <input style={inputStyle} placeholder="命令名（如 open-notepad）" value={newCmdName} onChange={(e) => setNewCmdName(e.target.value)} />
              <input style={inputStyle} placeholder="可执行文件绝对路径（如 C:\\Windows\\notepad.exe）" value={newCmdExe} onChange={(e) => setNewCmdExe(e.target.value)} />
              <input style={inputStyle} placeholder="固定参数（空格分隔，可选）" value={newCmdArgs} onChange={(e) => setNewCmdArgs(e.target.value)} />
              <div style={{ display: 'flex', gap: 8 }}>
                <input style={inputStyle} placeholder="说明（可选）" value={newCmdDesc} onChange={(e) => setNewCmdDesc(e.target.value)} />
                <select style={{ ...selectStyle, width: 110, flexShrink: 0 }} value={newCmdLevel} onChange={(e) => setNewCmdLevel(Number(e.target.value))}>
                  {[0, 1, 2, 3].map((l) => <option key={l} value={l}>{LEVEL_LABEL[l]}</option>)}
                </select>
              </div>
            </div>
            <motion.button
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
              onClick={handleAddCommand}
              style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', borderRadius: 10, border: 'none', background: 'linear-gradient(135deg, #a78bfa, #818cf8)', color: '#fff', fontWeight: 600, fontSize: 12, cursor: 'pointer' }}
            >
              <Plus size={14} /> 添加受信命令
            </motion.button>
            {trustedCmds.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
                {trustedCmds.map((c) => (
                  <div key={c.id} style={{ padding: '12px 14px', borderRadius: 12, border: `1px solid ${COLORS.cardBorder}`, background: 'rgba(255,255,255,0.02)', display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontSize: 13, fontWeight: 600, color: COLORS.textPrimary, fontFamily: 'var(--font-mono)' }}>{c.name}</span>
                        <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 8, background: `${COLORS.violet}18`, color: COLORS.violet }}>{LEVEL_LABEL[c.level]}</span>
                      </div>
                      <div style={{ fontSize: 11, color: COLORS.textMuted, marginTop: 3, wordBreak: 'break-all' }}>
                        {c.exe}{c.args.length > 0 ? ` ${c.args.join(' ')}` : ''}{c.description ? ` — ${c.description}` : ''}
                      </div>
                    </div>
                    <button
                      onClick={() => handleRemoveCommand(c.id, c.name)}
                      style={{ background: 'transparent', border: 'none', color: COLORS.danger, cursor: 'pointer', padding: 4 }}
                      title="移除受信命令"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            {trustedCmds.length === 0 && (
              <div style={{ fontSize: 12, color: COLORS.textMuted, marginTop: 10, opacity: 0.7 }}>暂无受信命令。添加后，玄枢可执行这些命令（受级别约束）。</div>
            )}
          </div>

          {/* ---------- 内置命令级别 ---------- */}
          <div style={{ height: 1, background: 'rgba(255,255,255,0.06)' }} />
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <Shield size={14} style={{ color: COLORS.accent }} />
              <span style={{ fontSize: 13, fontWeight: 600, color: COLORS.textPrimary }}>内置命令级别</span>
              <span style={{ fontSize: 12, color: COLORS.textMuted }}>可在授权设置页调整每项内置命令的开放级别</span>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {builtins.map((b) => (
                <div key={b.cmdKey} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderRadius: 10, border: `1px solid ${COLORS.cardBorder}`, background: 'rgba(255,255,255,0.02)' }}>
                  <span style={{ fontSize: 12, color: COLORS.textPrimary, fontFamily: 'var(--font-mono)' }}>{b.cmdKey}</span>
                  <select
                    style={{ ...selectStyle, width: 110, padding: '4px 8px' }}
                    value={b.level}
                    onChange={(e) => handleSetBuiltinLevel(b.cmdKey, Number(e.target.value))}
                  >
                    {[0, 1, 2, 3, 4].map((l) => <option key={l} value={l}>{LEVEL_LABEL[l]}</option>)}
                  </select>
                </div>
              ))}
            </div>
          </div>

          {/* ---------- 信任列表 ---------- */}
          <div style={{ height: 1, background: 'rgba(255,255,255,0.06)' }} />
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <UserPlus size={14} style={{ color: COLORS.accent }} />
              <span style={{ fontSize: 13, fontWeight: 600, color: COLORS.textPrimary }}>信任列表</span>
              <span style={{ fontSize: 12, color: COLORS.textMuted }}>命中信任项的操作免逐次确认（仅留痕），管理员要求仍保留</span>
            </div>
            <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
              <select style={{ ...selectStyle, width: 110 }} value={newTrustKind} onChange={(e) => setNewTrustKind(e.target.value as TrustEntry['kind'])}>
                <option value="command">命令</option>
                <option value="tool">工具</option>
                <option value="software">软件</option>
              </select>
              <input style={{ ...inputStyle, flex: 1, minWidth: 160 }} placeholder={newTrustKind === 'command' ? '命令名 / 工具名 / 软件名（如 open-url / browser_evaluate / 腾讯会议）' : '名称'} value={newTrustKey} onChange={(e) => setNewTrustKey(e.target.value)} />
              <input style={{ ...inputStyle, flex: 1, minWidth: 120 }} placeholder="备注（可选）" value={newTrustNote} onChange={(e) => setNewTrustNote(e.target.value)} />
              <motion.button
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                onClick={handleAddTrust}
                style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', borderRadius: 10, border: 'none', background: 'linear-gradient(135deg, #a78bfa, #818cf8)', color: '#fff', fontWeight: 600, fontSize: 12, cursor: 'pointer' }}
              >
                <Plus size={14} /> 添加信任
              </motion.button>
            </div>
            {authState.trustList.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {authState.trustList.map((t) => (
                  <div key={t.id} style={{ padding: '10px 14px', borderRadius: 12, border: `1px solid ${COLORS.cardBorder}`, background: 'rgba(255,255,255,0.02)', display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 8, background: `${COLORS.violet}18`, color: COLORS.violet, flexShrink: 0 }}>{KIND_LABEL[t.kind]}</span>
                    <span style={{ fontSize: 13, color: COLORS.textPrimary, fontFamily: 'var(--font-mono)', flex: 1 }}>{t.key}</span>
                    {t.note && <span style={{ fontSize: 11, color: COLORS.textMuted }}>{t.note}</span>}
                    <span style={{ fontSize: 10, color: '#4ade80', flexShrink: 0 }}>免确认</span>
                    <button onClick={() => handleRemoveTrust(t.id)} style={{ background: 'transparent', border: 'none', color: COLORS.danger, cursor: 'pointer', padding: 4 }} title="移除信任">
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ fontSize: 12, color: COLORS.textMuted, opacity: 0.7 }}>暂无信任项。</div>
            )}
          </div>

          {/* ---------- 操作日志 ---------- */}
          <div style={{ height: 1, background: 'rgba(255,255,255,0.06)' }} />
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <History size={14} style={{ color: COLORS.accent }} />
              <span style={{ fontSize: 13, fontWeight: 600, color: COLORS.textPrimary }}>操作日志</span>
              <span style={{ fontSize: 12, color: COLORS.textMuted }}>最近 60 条敏感操作留痕</span>
              <button onClick={handleClearLogs} style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 5, background: 'transparent', border: 'none', color: COLORS.danger, cursor: 'pointer', fontSize: 12 }}>
                <Trash2 size={13} /> 清空日志
              </button>
            </div>
            {logs.length > 0 ? (
              <div style={{ maxHeight: 260, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
                {logs.map((log) => (
                  <div key={log.id} style={{ padding: '8px 12px', borderRadius: 10, background: 'rgba(255,255,255,0.02)', border: `1px solid ${COLORS.cardBorder}`, fontSize: 12 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 10, color: DECISION_COLOR[log.decision], fontWeight: 600, flexShrink: 0 }}>{DECISION_LABEL[log.decision]}</span>
                      <span style={{ color: COLORS.textPrimary, fontFamily: 'var(--font-mono)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{log.action}</span>
                      <span style={{ fontSize: 10, color: COLORS.textMuted, flexShrink: 0 }}>{log.levelName}</span>
                      <span style={{ fontSize: 10, color: COLORS.textMuted, flexShrink: 0 }}>{fmtTime(log.time)}</span>
                    </div>
                    {log.detail && <div style={{ fontSize: 11, color: COLORS.textMuted, marginTop: 3, wordBreak: 'break-all' }}>{log.detail}</div>}
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ fontSize: 12, color: COLORS.textMuted, opacity: 0.7 }}>暂无操作日志。</div>
            )}
          </div>
        </div>
      )}
    </GlassCard>
  )
}
