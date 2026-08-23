/**
 * 自我改造流程页
 *
 * 流程：浏览白名单文件 → 编辑目标文件内容 → 预览 diff → 人工确认 → apply（git 快照 + 写入 + 校验）。
 * 所有写操作经 IPC 在 main 进程执行；写模式默认关闭，需显式开启。
 *
 * @module renderer/pages/SelfModify
 */

import { useEffect, useState, useCallback } from 'react'
import { motion } from 'framer-motion'
import {
  Wrench, RefreshCw, Sparkles, FileText, GitCommit, Undo2, ShieldAlert,
  ListTree, ToggleLeft, ToggleRight, Check, FolderOpen, Loader2,
} from 'lucide-react'
import { COLORS, HEX_COLORS, containerVariants, itemVariants } from '../../shared/theme'
import { useSelfModifyStore } from '../../store/selfModifyStore'
import DiffViewer from '../../components/DiffViewer'
import { EmptyState } from '../../components/EmptyState'
import { LoadingSkeleton } from '../../components/LoadingSkeleton'
import { ErrorDisplay } from '../../components/ErrorDisplay'
import { showToast } from '../../components/Toast'
import { logger } from '../../../shared/logger'
import ErrorBoundary from '../../components/ErrorBoundary'
import type { ChangeSet } from '../../../shared/self-modify-types'

export default function SelfModify() {
  const store = useSelfModifyStore()
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [editorContent, setEditorContent] = useState('')
  const [dirty, setDirty] = useState(false)
  const [summary, setSummary] = useState('')
  const [requirement, setRequirement] = useState('')
  const [generating, setGenerating] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)

  const writeEnabled = store.capabilities?.writeEnabled ?? false

  useEffect(() => {
    store.loadCapabilities()
    store.loadFiles()
    store.loadSnapshots()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleSelectFile = useCallback(
    async (path: string) => {
      setSelectedPath(path)
      await store.loadFile(path)
      // 编辑器内容由 loadFile 的 currentFile 派生，故在这里同步
      const res = await window.api.invokeSafe<{ path: string; content: string }>('self-modify:read-file', path)
      if (res.ok && res.data) {
        setEditorContent(res.data.content)
        setDirty(false)
      }
    },
    [store],
  )

  const handleToggleWrite = useCallback(async () => {
    const next = !writeEnabled
    try {
      await window.api.invoke('config:set', 'selfModifyWriteEnabled', next)
      await store.loadCapabilities()
      showToast(next ? 'warning' : 'info', next ? '已开启写模式，改动将真实写入文件' : '已关闭写模式（只读）')
    } catch (e) {
      logger.error('[SelfModify] 切换写模式失败:', e)
      showToast('error', '切换写模式失败')
    }
  }, [writeEnabled, store])

  const buildChangeSet = useCallback((): ChangeSet | null => {
    if (!selectedPath || !editorContent.trim()) return null
    return {
      summary: summary.trim() || '自我改造：' + selectedPath,
      files: [{ path: selectedPath, content: editorContent, mode: 'overwrite' }],
    }
  }, [selectedPath, editorContent, summary])

  const handlePreview = useCallback(async () => {
    const cs = buildChangeSet()
    if (!cs) {
      showToast('info', '请先选择文件并填写内容')
      return
    }
    await store.previewDiff(cs)
  }, [buildChangeSet, store])

  const handleApply = useCallback(async () => {
    const cs = buildChangeSet()
    if (!cs) return
    setConfirmOpen(false)
    // 服务端确认门：diff 人工确认后置 confirmed=true，服务层强制校验
    const result = await store.applyChangeSet({ ...cs, confirmed: true })
    if (result?.success) {
      showToast('success', '改动已应用，正在按生效方式刷新/重启…')
      setDirty(false)
    }
  }, [buildChangeSet, store])

  const handleGenerate = useCallback(async () => {
    if (!requirement.trim() || generating) return
    setGenerating(true)
    try {
      const res = await store.generate(requirement)
      if (!res.success) {
        showToast('error', res.error || '生成失败')
        return
      }
      if (res.changeSet && res.changeSet.files.length > 0) {
        const first = res.changeSet.files[0]
        setSelectedPath(first.path)
        setEditorContent(first.content)
        setSummary(res.changeSet.summary)
        setDirty(true)
        showToast('info', '已根据模型输出填充改动，请预览 diff 确认')
        await store.loadFiles()
      } else {
        showToast('warning', '模型未产出结构化改动，请查看计划文本手动编辑')
        // 将 plan 文本放入编辑器便于查看
        setEditorContent(res.plan)
      }
    } finally {
      setGenerating(false)
    }
  }, [requirement, generating, store])

  const handleRollback = useCallback(
    async (hash: string) => {
      const ok = await store.rollback(hash)
      if (ok) showToast('success', '已回退到快照')
    },
    [store],
  )

  return (
    <ErrorBoundary>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', background: COLORS.bg, minHeight: 0, overflow: 'auto' }}>
        <motion.div
          variants={containerVariants}
          initial="hidden"
          animate="visible"
          style={{ maxWidth: 1200, margin: '0 auto', width: '100%', padding: '20px', display: 'flex', flexDirection: 'column', gap: 20 }}
        >
          {/* 标题 + 写模式开关 */}
          <motion.div variants={itemVariants} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <h2 style={{ fontSize: '1.4rem', fontWeight: 600, color: COLORS.textPrimary, margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
                <Wrench size={22} style={{ color: COLORS.accent }} /> 自我改造
              </h2>
              <p style={{ fontSize: '0.85rem', color: COLORS.textMuted, margin: '4px 0 0' }}>
                让 AI 在严格安全约束下修改自身代码（白名单 + diff 确认 + git 快照回退）
              </p>
            </div>
            <motion.button
              whileTap={{ scale: 0.96 }}
              onClick={handleToggleWrite}
              style={{
                display: 'flex', alignItems: 'center', gap: 8, padding: '10px 20px',
                borderRadius: 'var(--radius-lg)', cursor: 'pointer', fontFamily: 'inherit', fontWeight: 600, fontSize: 13,
                background: writeEnabled ? `${HEX_COLORS.warning}18` : 'rgba(255,255,255,0.05)',
                border: `1px solid ${writeEnabled ? `${HEX_COLORS.warning}45` : COLORS.cardBorder}`,
                color: writeEnabled ? COLORS.warning : COLORS.textSecondary,
              }}
            >
              {writeEnabled ? <ToggleRight size={18} /> : <ToggleLeft size={18} />}
              写模式 {writeEnabled ? '已开启' : '已关闭'}
            </motion.button>
          </motion.div>

          {/* 能力说明 */}
          {store.capabilities && (
            <motion.div
              variants={itemVariants}
              style={{
                padding: '14px 18px', borderRadius: 'var(--radius-2xl)',
                background: COLORS.cardBg, border: `1px solid ${COLORS.cardBorder}`,
                display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'center', fontSize: 12,
              }}
            >
              <span style={{ display: 'flex', alignItems: 'center', gap: 6, color: COLORS.textSecondary }}>
                <ShieldAlert size={14} style={{ color: COLORS.warning }} />
                允许目录：{store.capabilities.whitelist.join('、')}
              </span>
              <span style={{ color: COLORS.textMuted }}>
                单次 ≤{store.capabilities.limits.maxFilesPerChange} 文件 · ≤{store.capabilities.limits.maxLinesPerChange} 行 · L3 架构级禁止
              </span>
            </motion.div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, alignItems: 'start' }}>
            {/* 左：文件浏览 + 编辑 */}
            <motion.div variants={itemVariants} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <h3 style={{ fontSize: '1rem', fontWeight: 600, color: COLORS.textPrimary, margin: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <ListTree size={16} style={{ color: COLORS.accent }} /> 白名单文件
                </h3>
                <motion.button whileTap={{ scale: 0.95 }} onClick={() => store.loadFiles()} title="刷新文件清单" aria-label="刷新文件清单"
                  style={{ background: 'none', border: 'none', color: COLORS.textMuted, cursor: 'pointer', padding: 4, display: 'flex' }}>
                  <RefreshCw size={15} />
                </motion.button>
              </div>

              <div style={{ maxHeight: 320, overflow: 'auto', border: `1px solid ${COLORS.cardBorder}`, borderRadius: 'var(--radius-lg)', background: COLORS.cardBg }}>
                {store.filesLoading ? (
                  <LoadingSkeleton variant="list" lines={6} loadingText="加载文件清单" />
                ) : store.files.length === 0 ? (
                  <EmptyState title="暂无可改造文件" description="白名单目录内未发现源码文件" />
                ) : (
                  store.files.map((f) => (
                    <button
                      key={f.path}
                      onClick={() => handleSelectFile(f.path)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                        padding: '8px 12px', background: selectedPath === f.path ? `${HEX_COLORS.accent}14` : 'transparent',
                        border: 'none', borderBottom: `1px solid ${COLORS.cardBorder}`, cursor: 'pointer',
                        color: selectedPath === f.path ? COLORS.accent : COLORS.textSecondary, fontFamily: 'var(--font-mono)', fontSize: 12,
                        textAlign: 'left',
                      }}
                    >
                      <FileText size={13} style={{ flexShrink: 0 }} />
                      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.path}</span>
                      <span style={{ fontSize: 10, color: f.level === 'L3' ? COLORS.danger : COLORS.textMuted, flexShrink: 0 }}>{f.level}</span>
                    </button>
                  ))
                )}
              </div>

              {/* 文件编辑器 */}
              {selectedPath && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: COLORS.textSecondary, fontSize: 12 }}>
                    <FolderOpen size={14} style={{ color: COLORS.textMuted }} />
                    <span style={{ fontFamily: 'var(--font-mono)', wordBreak: 'break-all' }}>{selectedPath}</span>
                    {dirty && <span style={{ color: COLORS.warning }}>（已修改）</span>}
                  </div>
                  <textarea
                    value={editorContent}
                    onChange={(e) => { setEditorContent(e.target.value); setDirty(true) }}
                    spellCheck={false}
                    style={{
                      width: '100%', minHeight: 260, padding: 12, boxSizing: 'border-box',
                      background: COLORS.bg, border: `1px solid ${COLORS.cardBorder}`, borderRadius: 'var(--radius-lg)',
                      color: COLORS.textPrimary, fontFamily: 'var(--font-mono)', fontSize: 12, lineHeight: 1.5, resize: 'vertical', outline: 'none',
                    }}
                  />
                </div>
              )}
            </motion.div>

            {/* 右：需求生成 + diff 预览 + 应用 */}
            <motion.div variants={itemVariants} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <h3 style={{ fontSize: '1rem', fontWeight: 600, color: COLORS.textPrimary, margin: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
                <Sparkles size={16} style={{ color: COLORS.accent }} /> AI 生成 / 预览
              </h3>

              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  value={requirement}
                  onChange={(e) => setRequirement(e.target.value)}
                  placeholder="描述改造需求，如：把首页问候语改成'早安，主人'"
                  style={{
                    flex: 1, padding: '10px 14px', borderRadius: 'var(--radius-lg)', fontFamily: 'inherit', fontSize: 13,
                    background: COLORS.bg, border: `1px solid ${COLORS.cardBorder}`, color: COLORS.textPrimary, outline: 'none',
                  }}
                />
                <motion.button whileTap={{ scale: 0.96 }} onClick={handleGenerate} disabled={generating}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6, padding: '10px 16px', borderRadius: 'var(--radius-lg)',
                    border: 'none', cursor: generating ? 'wait' : 'pointer', fontFamily: 'inherit', fontSize: 13, fontWeight: 600,
                    background: COLORS.accent, color: '#fff', opacity: generating ? 0.7 : 1,
                  }}>
                  {generating ? <Loader2 size={15} className="spin-anim" /> : <Sparkles size={15} />}
                  生成
                </motion.button>
              </div>

              <input
                value={summary}
                onChange={(e) => setSummary(e.target.value)}
                placeholder="改动摘要（写入审计日志，可选）"
                style={{
                  padding: '10px 14px', borderRadius: 'var(--radius-lg)', fontFamily: 'inherit', fontSize: 13,
                  background: COLORS.bg, border: `1px solid ${COLORS.cardBorder}`, color: COLORS.textPrimary, outline: 'none',
                }}
              />

              <motion.button whileTap={{ scale: 0.97 }} onClick={handlePreview} disabled={!selectedPath || store.previewLoading}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '10px 16px',
                  borderRadius: 'var(--radius-lg)', border: `1px solid ${COLORS.cardBorder}`, cursor: 'pointer',
                  fontFamily: 'inherit', fontSize: 13, fontWeight: 500, color: COLORS.textPrimary,
                  background: 'rgba(255,255,255,0.04)',
                }}>
                {store.previewLoading ? <Loader2 size={15} className="spin-anim" /> : <GitCommit size={15} />}
                预览 diff
              </motion.button>

              {store.error && (
                <ErrorDisplay type="unknown" title="操作失败" message={store.error} onRetry={() => { store.clearError() }} />
              )}

              {store.diff && <DiffViewer diff={store.diff} />}

              {store.diff && (
                <motion.button whileTap={{ scale: 0.97 }} onClick={() => setConfirmOpen(true)} disabled={!writeEnabled}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '12px 16px',
                    borderRadius: 'var(--radius-lg)', border: 'none', cursor: writeEnabled ? 'pointer' : 'not-allowed',
                    fontFamily: 'inherit', fontSize: 14, fontWeight: 600,
                    background: writeEnabled ? COLORS.success : 'rgba(255,255,255,0.08)',
                    color: writeEnabled ? '#fff' : COLORS.textMuted, opacity: writeEnabled ? 1 : 0.6,
                  }}>
                  <Check size={16} /> 应用改动（git 快照后写入）
                </motion.button>
              )}
            </motion.div>
          </div>

          {/* 快照列表 */}
          <motion.div variants={itemVariants}>
            <h3 style={{ fontSize: '1rem', fontWeight: 600, color: COLORS.textPrimary, margin: '0 0 12px', display: 'flex', alignItems: 'center', gap: 6 }}>
              <GitCommit size={16} style={{ color: COLORS.accent }} /> 历史快照
            </h3>
            {store.snapshots.length === 0 ? (
              <EmptyState title="暂无快照" description="每次成功应用改动前都会创建 git 快照" />
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {store.snapshots.map((s) => (
                  <div key={s.hash} style={{
                    display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px',
                    background: COLORS.cardBg, border: `1px solid ${COLORS.cardBorder}`, borderRadius: 'var(--radius-lg)',
                  }}>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: COLORS.textSecondary, flexShrink: 0 }}>{s.hash.slice(0, 10)}</span>
                    <span style={{ flex: 1, fontSize: 12, color: COLORS.textMuted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.summary}</span>
                    <span style={{ fontSize: 11, color: COLORS.textMuted, flexShrink: 0 }}>{new Date(s.createdAt).toLocaleString()}</span>
                    <motion.button whileTap={{ scale: 0.95 }} onClick={() => handleRollback(s.hash)}
                      style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '5px 12px', borderRadius: 8, border: `1px solid ${COLORS.cardBorder}`, background: 'transparent', color: COLORS.textSecondary, fontSize: 12, cursor: 'pointer', fontFamily: 'inherit' }}>
                      <Undo2 size={13} /> 回退
                    </motion.button>
                  </div>
                ))}
              </div>
            )}
          </motion.div>
        </motion.div>

        {/* 最终确认门 */}
        {confirmOpen && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }}
            style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(10,10,15,0.65)', backdropFilter: 'blur(8px)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            onClick={() => setConfirmOpen(false)}
          >
            <motion.div
              initial={{ scale: 0.95, y: 20 }} animate={{ scale: 1, y: 0 }}
              onClick={(e) => e.stopPropagation()}
              style={{ width: 460, maxWidth: '92vw', background: COLORS.cardBg, border: `1px solid ${COLORS.cardBorder}`, borderRadius: 16, padding: 26, display: 'flex', flexDirection: 'column', gap: 16 }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <ShieldAlert size={22} style={{ color: COLORS.warning }} />
                <h3 style={{ fontSize: 16, fontWeight: 600, color: COLORS.textPrimary, margin: 0 }}>确认写入改动</h3>
              </div>
              <p style={{ fontSize: 13, color: COLORS.textSecondary, lineHeight: 1.6, margin: 0 }}>
                即将写入 <b>{store.diff?.filesAffected.length ?? 0}</b> 个文件（已创建 git 快照，失败自动回退）。
                {store.diff?.estimatedRisk === 'L2' && ' 本次为 L2 中风险改动，请仔细核对 diff。'}
                写入后应用将按生效方式自动重载或重启。
              </p>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
                <button onClick={() => setConfirmOpen(false)} style={{ padding: '9px 18px', borderRadius: 10, border: `1px solid ${COLORS.cardBorder}`, background: 'transparent', color: COLORS.textSecondary, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit' }}>取消</button>
                <motion.button whileTap={{ scale: 0.97 }} onClick={handleApply} disabled={store.applying}
                  style={{ padding: '9px 20px', borderRadius: 10, border: 'none', background: COLORS.success, color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', opacity: store.applying ? 0.7 : 1 }}>
                  {store.applying ? '写入中…' : '确认写入'}
                </motion.button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </div>
    </ErrorBoundary>
  )
}
