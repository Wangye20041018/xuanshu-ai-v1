/**
 * 本机 AI 客户端面板 v12.2
 *
 * 扫描并展示本机已安装的 AI 客户端软件（Kimi / 豆包 / DeepSeek / 智谱清言 / 通义 /
 * 文心一言 / 腾讯元宝 / ChatGPT / Copilot / Cursor / Trae / Chatbox / Cherry Studio /
 * LM Studio / Ollama / Jan / GPT4All 等）。
 *
 * 用途：超大任务中用户可要求"替换云端模型为本地 AI 客户端推理"，
 *      玄枢在任务前扫描并建议，确认后由 app-agent 打开对应客户端。
 */
import { useCallback, useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { Bot, RefreshCw, ExternalLink } from 'lucide-react'
import { logger } from '../../../shared/logger'
import { HEX_COLORS, COLORS, containerVariants, itemVariants } from '../../shared/theme'

interface FoundAiClient {
  id: string
  name: string
  exePath: string
  source: 'registry' | 'startmenu' | 'common-path'
  version?: string
}

const SOURCE_LABEL: Record<string, string> = {
  registry: '注册表',
  startmenu: '开始菜单',
  'common-path': '安装目录',
}

export default function LocalAiPanel() {
  const [clients, setClients] = useState<FoundAiClient[]>([])
  const [scanning, setScanning] = useState(false)

  const load = useCallback(async (force = false) => {
    try {
      const list = await window.api?.invoke<FoundAiClient[]>('local-ai:list')
      setClients(list || [])
      if (force || !list || list.length === 0) {
        setScanning(true)
        const fresh = await window.api?.invoke<FoundAiClient[]>('local-ai:scan', true)
        setClients(fresh || [])
      }
    } catch (e) {
      logger.warn('[LocalAi] load failed', e)
    } finally {
      setScanning(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const rescan = () => { setScanning(true); load(true) }

  const openClient = async (exePath: string) => {
    try {
      await window.api?.invoke('app:launch', exePath)
    } catch (e) {
      logger.warn('[LocalAi] open failed', e)
    }
  }

  return (
    <motion.div variants={containerVariants} initial="hidden" animate="visible"
      style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <motion.div variants={itemVariants} style={{
        background: COLORS.cardBg, border: `1px solid ${COLORS.cardBorder}`,
        borderRadius: 'var(--radius-2xl)', padding: 24,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
          <h3 style={{ fontSize: 16, fontWeight: 600, color: COLORS.textPrimary, margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Bot size={16} color={COLORS.accent} /> 本机 AI 客户端
          </h3>
          <button onClick={rescan} disabled={scanning} title="重新扫描" style={{
            background: 'rgba(255,255,255,0.05)', border: `1px solid ${COLORS.cardBorder}`,
            borderRadius: 8, cursor: 'pointer', padding: '6px 10px', display: 'flex', alignItems: 'center', gap: 6,
            color: COLORS.textSecondary, fontSize: 12, fontFamily: 'inherit',
          }}>
            <RefreshCw size={13} className={scanning ? 'spin' : ''} /> {scanning ? '扫描中...' : '重新扫描'}
          </button>
        </div>
        <p style={{ fontSize: 13, color: COLORS.textSecondary, margin: '0 0 16px' }}>
          超大任务中可指定由以下本地 AI 客户端接管推理，玄枢会在任务前扫描并建议
        </p>

        {clients.length === 0 ? (
          <div style={{ fontSize: 13, color: COLORS.textMuted, padding: '12px 0' }}>
            未发现已安装的 AI 客户端（支持 Kimi / 豆包 / DeepSeek / 智谱清言 / 通义 / 文心一言 / 腾讯元宝 / ChatGPT / Copilot / Cursor / Trae / Chatbox / Cherry Studio / LM Studio / Ollama / Jan / GPT4All 等）
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {clients.map(c => (
              <div key={c.exePath} style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                background: 'rgba(255,255,255,0.03)', border: `1px solid ${COLORS.cardBorder}`,
                borderRadius: 12, padding: '10px 14px',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ width: 32, height: 32, borderRadius: 9, background: `${HEX_COLORS.accent}18`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, fontWeight: 600, color: COLORS.accent }}>
                    {c.name.slice(0, 1)}
                  </span>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 500, color: COLORS.textPrimary }}>{c.name}</div>
                    <div style={{ fontSize: 11, color: COLORS.textMuted }}>
                      {c.version ? `v${c.version} · ` : ''}{SOURCE_LABEL[c.source] || c.source}
                    </div>
                  </div>
                </div>
                <button onClick={() => openClient(c.exePath)} title="打开" style={{
                  background: 'rgba(255,255,255,0.05)', border: `1px solid ${COLORS.cardBorder}`,
                  borderRadius: 8, cursor: 'pointer', padding: '6px 10px', display: 'flex', alignItems: 'center', gap: 6,
                  color: COLORS.textSecondary, fontSize: 12, fontFamily: 'inherit',
                }}>
                  <ExternalLink size={13} /> 打开
                </button>
              </div>
            ))}
          </div>
        )}
      </motion.div>
    </motion.div>
  )
}
