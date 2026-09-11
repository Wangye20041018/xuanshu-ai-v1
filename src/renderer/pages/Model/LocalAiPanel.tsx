/**
 * 本机 AI 客户端面板 v13.0
 *
 * 职责（真实可用）：
 *   1. 扫描并展示本机已安装的 AI 客户端软件（Kimi / 豆包 / DeepSeek / 智谱清言 /
 *      通义 / 文心一言 / 腾讯元宝 / ChatGPT / Copilot / Cursor / Trae / Chatbox /
 *      Cherry Studio / LM Studio / Ollama / Jan / GPT4All 等），支持一键打开。
 *   2. Ollama 本地服务管理：探测安装、查看运行状态、启动/停止服务、
 *      拉取已安装模型，并一键接入玄枢（注册为 OpenAI 兼容 provider，
 *      Ollama 模型即可在模型页/对话链路中使用）。
 */
import { useCallback, useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { Bot, RefreshCw, ExternalLink, Play, Square, Plug, Loader } from 'lucide-react'
import { logger } from '../../../shared/logger'
import { HEX_COLORS, COLORS, containerVariants, itemVariants } from '../../shared/theme'

interface FoundAiClient {
  id: string
  name: string
  exePath: string
  source: 'registry' | 'startmenu' | 'common-path'
  version?: string
}

interface OllamaStatus {
  installed: boolean
  exePath: string
  running: boolean
  version: string
}

const SOURCE_LABEL: Record<string, string> = {
  registry: '注册表',
  startmenu: '开始菜单',
  'common-path': '安装目录',
}

export default function LocalAiPanel() {
  const [clients, setClients] = useState<FoundAiClient[]>([])
  const [scanning, setScanning] = useState(false)
  const [ollama, setOllama] = useState<OllamaStatus>({ installed: false, exePath: '', running: false, version: '' })
  const [ollamaModels, setOllamaModels] = useState<Array<{ name: string; size: number }>>([])
  const [ollamaBusy, setOllamaBusy] = useState(false)
  const [ollamaMsg, setOllamaMsg] = useState('')

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

  const loadOllama = useCallback(async () => {
    try {
      const st = await window.api?.invoke<OllamaStatus>('local-ai:ollama-status')
      if (st) setOllama(st)
      if (st?.running) {
        const models = await window.api?.invoke<Array<{ name: string; size: number }>>('local-ai:ollama-models')
        setOllamaModels(models || [])
      } else {
        setOllamaModels([])
      }
    } catch (e) {
      logger.warn('[LocalAi] ollama status failed', e)
    }
  }, [])

  useEffect(() => { load() }, [load])
  useEffect(() => { loadOllama() }, [loadOllama])

  const rescan = () => { setScanning(true); load(true) }

  const openClient = async (exePath: string) => {
    try {
      await window.api?.invoke('app:launch', exePath)
    } catch (e) {
      logger.warn('[LocalAi] open failed', e)
    }
  }

  const toggleOllama = async () => {
    setOllamaBusy(true)
    setOllamaMsg('')
    try {
      if (ollama.running) {
        const r = await window.api?.invoke<{ success: boolean; error?: string }>('local-ai:ollama-stop')
        setOllamaMsg(r?.success ? 'Ollama 服务已停止' : `停止失败: ${r?.error || '未知错误'}`)
      } else {
        const r = await window.api?.invoke<{ success: boolean; error?: string }>('local-ai:ollama-start')
        setOllamaMsg(r?.success ? 'Ollama 服务已启动' : `启动失败: ${r?.error || '未知错误'}`)
      }
      await loadOllama()
    } catch (e: any) {
      setOllamaMsg(`操作失败: ${e?.message || String(e)}`)
    } finally {
      setOllamaBusy(false)
    }
  }

  const connectOllama = async () => {
    setOllamaBusy(true)
    setOllamaMsg('')
    try {
      const models = ollamaModels.length > 0
        ? ollamaModels
        : await window.api?.invoke<Array<{ name: string; size: number }>>('local-ai:ollama-models') || []
      if (models.length === 0) {
        setOllamaMsg('Ollama 中没有可用模型，请先通过 ollama pull 拉取模型')
        return
      }
      const cfg = {
        id: 'ollama',
        name: 'Ollama',
        type: 'openai',
        baseUrl: 'http://127.0.0.1:11434',
        apiKey: '',
        models: models.map(m => m.name),
      }
      const res = await window.api?.invoke<any>('llm:add-provider', cfg)
      if (res?.error === 'Provider already exists') {
        await window.api?.invoke('llm:update-provider', 'ollama', cfg)
      }
      await window.api?.invoke('config:set', 'cloudApiModels', models.map(m => ({ provider: 'ollama', name: m.name, isDefault: false }))).catch(() => {})
      setOllamaMsg(`已接入 ${models.length} 个 Ollama 模型，可在模型页/对话中选用`)
    } catch (e: any) {
      setOllamaMsg(`接入失败: ${e?.message || String(e)}`)
    } finally {
      setOllamaBusy(false)
    }
  }

  return (
    <motion.div variants={containerVariants} initial="hidden" animate="visible"
      style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

      {/* ===== Ollama 本地服务管理 ===== */}
      <motion.div variants={itemVariants} style={{
        background: COLORS.cardBg, border: `1px solid ${COLORS.cardBorder}`,
        borderRadius: 'var(--radius-2xl)', padding: 24,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
          <h3 style={{ fontSize: 16, fontWeight: 600, color: COLORS.textPrimary, margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Bot size={16} color={COLORS.accent} /> Ollama 本地服务
          </h3>
          <button onClick={toggleOllama} disabled={ollamaBusy || !ollama.installed} title={ollama.running ? '停止 Ollama 服务' : '启动 Ollama 服务'} style={{
            display: 'flex', alignItems: 'center', gap: 6,
            background: ollama.running ? 'rgba(255,255,255,0.05)' : COLORS.accent,
            border: ollama.running ? `1px solid ${COLORS.cardBorder}` : 'none',
            borderRadius: 8, cursor: ollamaBusy || !ollama.installed ? 'not-allowed' : 'pointer',
            padding: '6px 12px', color: ollama.running ? COLORS.textSecondary : '#1a1a1c',
            fontSize: 12, fontFamily: 'inherit', opacity: ollamaBusy ? 0.6 : 1,
          }}>
            {ollamaBusy ? <Loader size={13} className="animate-spin" /> : (ollama.running ? <Square size={13} /> : <Play size={13} />)}
            {ollama.running ? '停止服务' : '启动服务'}
          </button>
        </div>
        <p style={{ fontSize: 13, color: COLORS.textSecondary, margin: '0 0 12px' }}>
          管理本机 Ollama 推理服务：状态探测、启停、模型列表，并可一键接入玄枢对话链路
        </p>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 12.5, color: COLORS.textSecondary }}>
          <span style={{
            padding: '3px 10px', borderRadius: 8,
            background: ollama.installed ? (ollama.running ? '#22c55e18' : '#f59e0b18') : '#ef444410',
            border: `1px solid ${ollama.installed ? (ollama.running ? '#22c55e40' : '#f59e0b40') : '#ef444430'}`,
            color: ollama.installed ? (ollama.running ? '#22c55e' : '#f59e0b') : '#ef4444',
          }}>
            {!ollama.installed ? '未安装' : (ollama.running ? `运行中${ollama.version ? ` v${ollama.version}` : ''}` : '已安装，未运行')}
          </span>
          {ollama.installed && ollama.exePath && (
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: COLORS.textMuted }}>
              {ollama.exePath}
            </span>
          )}
          {ollama.running && ollamaModels.length > 0 && (
            <span>本地模型 {ollamaModels.length} 个</span>
          )}
          <button onClick={connectOllama} disabled={ollamaBusy || !ollama.running} title="将 Ollama 注册为玄枢 provider" style={{
            display: 'flex', alignItems: 'center', gap: 6,
            background: 'rgba(255,255,255,0.05)', border: `1px solid ${COLORS.cardBorder}`,
            borderRadius: 8, cursor: ollamaBusy || !ollama.running ? 'not-allowed' : 'pointer',
            padding: '6px 12px', color: COLORS.textSecondary, fontSize: 12, fontFamily: 'inherit',
            opacity: ollamaBusy ? 0.6 : 1,
          }}>
            <Plug size={13} /> 接入玄枢
          </button>
        </div>

        {ollama.running && ollamaModels.length > 0 && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
            {ollamaModels.map(m => (
              <span key={m.name} style={{
                fontSize: 11.5, padding: '3px 10px', borderRadius: 8,
                background: 'rgba(255,255,255,0.04)', border: `1px solid ${COLORS.cardBorder}`,
                color: COLORS.textSecondary, fontFamily: 'var(--font-mono)',
              }}>
                {m.name}
              </span>
            ))}
          </div>
        )}

        {ollamaMsg && (
          <div style={{ fontSize: 12, color: COLORS.accent, marginTop: 10 }}>{ollamaMsg}</div>
        )}
      </motion.div>

      {/* ===== 已安装 AI 客户端 ===== */}
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
          已安装的 AI 客户端软件，可一键打开；如需让本地模型接管推理，请使用上方 Ollama 服务接入玄枢
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
