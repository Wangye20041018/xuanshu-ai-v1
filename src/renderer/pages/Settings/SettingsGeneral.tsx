import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { Settings as SettingsIcon, Rocket, Zap, Activity, Palette, Download, Upload, Database } from 'lucide-react'
import { HEX_COLORS, COLORS, GlassCard, Toggle, THEME_OPTIONS } from './index'
import { flushChatStore, rehydrateChatStore } from '../../store/chatStore'

interface SettingsGeneralProps {
  autoUpdate: boolean
  sendStats: boolean
  autoStart: boolean
  themeColor: string
  onAutoUpdateChange: () => void
  onSendStatsChange: () => void
  onAutoStartChange: () => void
  onThemeColorChange: (themeId: string) => void
}

export default function SettingsGeneral({
  autoUpdate,
  sendStats,
  autoStart,
  themeColor,
  onAutoUpdateChange,
  onSendStatsChange,
  onAutoStartChange,
  onThemeColorChange,
}: SettingsGeneralProps) {
  const [backupInfo, setBackupInfo] = useState<{ totalSizeBytes: number; files: Array<{ name: string; sizeBytes: number }> } | null>(null)
  const [backupBusy, setBackupBusy] = useState<'export' | 'import' | null>(null)
  const [backupMsg, setBackupMsg] = useState<string>('')

  // 挂载时读取备份数据信息（大小）
  useEffect(() => {
    if (!window.api) return
    window.api.invoke('backup:get-info')
      .then((info: any) => { if (info && Array.isArray(info.files)) setBackupInfo(info) })
      .catch(() => { /* 忽略 */ })
  }, [])

  // 监听导入完成广播，rehydrate chatStore
  useEffect(() => {
    if (!window.api?.on) return
    const off = window.api.on('backup:restore-localstorage', (_event, json: unknown) => {
      if (typeof json === 'string') rehydrateChatStore(json)
      setBackupMsg('导入完成，会话数据已恢复')
      setTimeout(() => setBackupMsg(''), 3000)
    })
    return () => off()
  }, [])

  const handleExport = async () => {
    if (backupBusy) return
    setBackupBusy('export')
    setBackupMsg('')
    try {
      flushChatStore()
      let chatStore = ''
      try { chatStore = window.localStorage.getItem('xuanshu-chat-store') || '' } catch { /* ignore */ }
      const res = await window.api.invoke<{ success: boolean; path?: string; sizeBytes?: number; error?: string }>('backup:export', { chatStore })
      setBackupMsg(res?.success ? `已导出备份 (${((res.sizeBytes || 0) / 1024).toFixed(1)} KB)` : `导出失败：${res?.error || '未知错误'}`)
    } catch (e: any) {
      setBackupMsg(`导出失败：${e?.message || e}`)
    } finally {
      setBackupBusy(null)
      setTimeout(() => setBackupMsg(''), 4000)
    }
  }

  const handleImport = async () => {
    if (backupBusy) return
    setBackupBusy('import')
    setBackupMsg('')
    try {
      const res = await window.api.invoke<{ success: boolean; restoredFiles?: string[]; error?: string }>('backup:import')
      setBackupMsg(res?.success ? `已导入 ${res.restoredFiles?.length || 0} 个文件` : `导入失败：${res?.error || '未知错误'}`)
    } catch (e: any) {
      setBackupMsg(`导入失败：${e?.message || e}`)
    } finally {
      setBackupBusy(null)
      setTimeout(() => setBackupMsg(''), 4000)
    }
  }

  const totalKb = backupInfo ? (backupInfo.totalSizeBytes / 1024).toFixed(1) : '0.0'

  return (
    <GlassCard
      title="常规设置"
      icon={<SettingsIcon size={18} />}
      accentColor={COLORS.accent}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {/* 自动更新 */}
        <motion.div
          whileHover={{
            backgroundColor: 'rgba(255,255,255,0.03)',
            borderRadius: 'var(--radius-2xl)',
          }}
          style={{
            padding: '16px 18px',
            borderRadius: 'var(--radius-2xl)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            transition: 'all 0.35s cubic-bezier(0.4, 0, 0.2, 1)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <motion.span
              whileHover={{ scale: 1.1 }}
              animate={autoUpdate ? {
                boxShadow: ['0 0 0px transparent', `0 0 12px ${HEX_COLORS.accent}25`, '0 0 0px transparent'],
              } : {}}
              transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
              style={{
                width: 40,
                height: 40,
                borderRadius: '14px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: autoUpdate ? `${HEX_COLORS.accent}18` : 'rgba(255,255,255,0.04)',
                color: autoUpdate ? COLORS.accent : COLORS.textMuted,
                transition: 'all 0.35s cubic-bezier(0.4, 0, 0.2, 1)',
              }}
            >
              <Rocket size={17} />
            </motion.span>
            <div>
              <div style={{ fontSize: 14, fontWeight: 500, color: COLORS.textPrimary }}>
                自动检查更新
              </div>
              <div style={{ fontSize: 13, color: COLORS.textMuted, marginTop: 4, lineHeight: 1.5 }}>
                启动时检查新版本
              </div>
            </div>
          </div>
          <Toggle checked={autoUpdate} onChange={onAutoUpdateChange} />
        </motion.div>

        {/* 匿名统计 */}
        <motion.div
          whileHover={{
            backgroundColor: 'rgba(255,255,255,0.03)',
            borderRadius: 'var(--radius-2xl)',
          }}
          style={{
            padding: '16px 18px',
            borderRadius: 'var(--radius-2xl)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            transition: 'all 0.35s cubic-bezier(0.4, 0, 0.2, 1)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <motion.span
              whileHover={{ scale: 1.1 }}
              animate={sendStats ? {
                boxShadow: ['0 0 0px transparent', `0 0 12px ${HEX_COLORS.accent}25`, '0 0 0px transparent'],
              } : {}}
              transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
              style={{
                width: 40,
                height: 40,
                borderRadius: '14px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: sendStats ? `${HEX_COLORS.accent}18` : 'rgba(255,255,255,0.04)',
                color: sendStats ? COLORS.accent : COLORS.textMuted,
                transition: 'all 0.35s cubic-bezier(0.4, 0, 0.2, 1)',
              }}
            >
              <Activity size={17} />
            </motion.span>
            <div>
              <div style={{ fontSize: 14, fontWeight: 500, color: COLORS.textPrimary }}>
                发送匿名使用统计
              </div>
              <div style={{ fontSize: 13, color: COLORS.textMuted, marginTop: 4, lineHeight: 1.5 }}>
                帮助我们改进产品
              </div>
            </div>
          </div>
          <Toggle checked={sendStats} onChange={onSendStatsChange} />
        </motion.div>

        {/* 开机自启动 */}
        <motion.div
          whileHover={{
            backgroundColor: 'rgba(255,255,255,0.03)',
            borderRadius: 'var(--radius-2xl)',
          }}
          style={{
            padding: '16px 18px',
            borderRadius: 'var(--radius-2xl)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            transition: 'all 0.35s cubic-bezier(0.4, 0, 0.2, 1)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <motion.span
              whileHover={{ scale: 1.1 }}
              animate={autoStart ? {
                boxShadow: ['0 0 0px transparent', `0 0 12px ${HEX_COLORS.accent}25`, '0 0 0px transparent'],
              } : {}}
              transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
              style={{
                width: 40,
                height: 40,
                borderRadius: '14px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: autoStart ? `${HEX_COLORS.accent}18` : 'rgba(255,255,255,0.04)',
                color: autoStart ? COLORS.accent : COLORS.textMuted,
                transition: 'all 0.35s cubic-bezier(0.4, 0, 0.2, 1)',
              }}
            >
              <Zap size={17} />
            </motion.span>
            <div>
              <div style={{ fontSize: 14, fontWeight: 500, color: COLORS.textPrimary }}>
                开机自启动
              </div>
              <div style={{ fontSize: 13, color: COLORS.textMuted, marginTop: 4, lineHeight: 1.5 }}>
                系统启动时自动运行玄枢
              </div>
            </div>
          </div>
          <Toggle checked={autoStart} onChange={onAutoStartChange} />
        </motion.div>

        {/* 主题色选择 */}
        <motion.div
          whileHover={{
            backgroundColor: 'rgba(255,255,255,0.03)',
            borderRadius: 'var(--radius-2xl)',
          }}
          style={{
            padding: '16px 18px',
            borderRadius: 'var(--radius-2xl)',
            transition: 'all 0.35s cubic-bezier(0.4, 0, 0.2, 1)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 14 }}>
            <motion.span
              whileHover={{ scale: 1.1 }}
              style={{
                width: 40,
                height: 40,
                borderRadius: '14px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: `${HEX_COLORS.accent}18`,
                color: COLORS.accent,
              }}
            >
              <Palette size={17} />
            </motion.span>
            <div>
              <div style={{ fontSize: 14, fontWeight: 500, color: COLORS.textPrimary }}>
                主题色
              </div>
              <div style={{ fontSize: 13, color: COLORS.textMuted, marginTop: 4, lineHeight: 1.5 }}>
                选择你喜欢的界面强调色
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10, paddingLeft: 56 }}>
            {THEME_OPTIONS.map((opt) => (
              <motion.button
                key={opt.id}
                whileHover={{ scale: 1.15 }}
                whileTap={{ scale: 0.9 }}
                onClick={() => onThemeColorChange(opt.id)}
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: '50%',
                  background: opt.color,
                  border: themeColor === opt.id ? '3px solid rgba(255,255,255,0.8)' : '3px solid transparent',
                  boxShadow: themeColor === opt.id ? `0 0 12px ${opt.color}60` : 'none',
                  cursor: 'pointer',
                  transition: 'all 0.2s ease',
                  outline: 'none',
                }}
                title={opt.label}
              />
            ))}
          </div>
        </motion.div>

        {/* 数据备份 / 导入 */}
        <motion.div
          whileHover={{
            backgroundColor: 'rgba(255,255,255,0.03)',
            borderRadius: 'var(--radius-2xl)',
          }}
          style={{
            padding: '16px 18px',
            borderRadius: 'var(--radius-2xl)',
            transition: 'all 0.35s cubic-bezier(0.4, 0, 0.2, 1)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 14 }}>
            <motion.span
              whileHover={{ scale: 1.1 }}
              style={{
                width: 40,
                height: 40,
                borderRadius: '14px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: `${HEX_COLORS.accent}18`,
                color: COLORS.accent,
              }}
            >
              <Database size={17} />
            </motion.span>
            <div>
              <div style={{ fontSize: 14, fontWeight: 500, color: COLORS.textPrimary }}>
                数据备份
              </div>
              <div style={{ fontSize: 13, color: COLORS.textMuted, marginTop: 4, lineHeight: 1.5 }}>
                导出 / 导入对话、记忆与配置（约 {totalKb} KB）
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10, paddingLeft: 56, flexWrap: 'wrap' }}>
            <button
              onClick={handleExport}
              disabled={backupBusy !== null}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                padding: '8px 16px', borderRadius: 'var(--radius-lg)',
                background: COLORS.accent, color: '#1a1a1c',
                fontSize: 13, fontWeight: 500, cursor: backupBusy !== null ? 'default' : 'pointer',
                border: 'none', opacity: backupBusy !== null ? 0.6 : 1,
              }}
            >
              <Download size={14} />
              {backupBusy === 'export' ? '导出中...' : '导出备份'}
            </button>
            <button
              onClick={handleImport}
              disabled={backupBusy !== null}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                padding: '8px 16px', borderRadius: 'var(--radius-lg)',
                background: 'transparent', color: COLORS.textPrimary,
                fontSize: 13, fontWeight: 500, cursor: backupBusy !== null ? 'default' : 'pointer',
                border: `1px solid ${COLORS.cardBorder}`, opacity: backupBusy !== null ? 0.6 : 1,
              }}
            >
              <Upload size={14} />
              {backupBusy === 'import' ? '导入中...' : '导入备份'}
            </button>
          </div>
          {backupMsg && (
            <div style={{ paddingLeft: 56, marginTop: 10, fontSize: 12, color: COLORS.textMuted }}>
              {backupMsg}
            </div>
          )}
        </motion.div>
      </div>
    </GlassCard>
  )
}