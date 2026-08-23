import { useState, useEffect, useCallback, useRef } from 'react'
import { motion } from 'framer-motion'
import {Save, RotateCcw, Cpu, Zap, Activity, BarChart3, MemoryStick, Trash2, FolderOpen, Star, Loader, Power, PowerOff, Eye, EyeOff, Settings, AlertTriangle, ToggleLeft, ToggleRight, ChevronDown, ChevronRight, Wifi, WifiOff, Download, RefreshCw, CheckCircle} from 'lucide-react'
import { HEX_COLORS, COLORS, containerVariants, itemVariants } from '../../shared/theme'

import { logger } from '../../../shared/logger'
import ErrorBoundary from '../../components/ErrorBoundary'
import TandemPanel from '../../components/TandemPanel'
import ModelAnalysisCard from './ModelAnalysisCard'
import InferenceModeSelector from './InferenceModeSelector'
import CloudQuotaPanel from './CloudQuotaPanel'
import LocalAiPanel from './LocalAiPanel'
import { showToast } from '../../components/Toast'

/* ============================================================
 * 类型定义
 * ============================================================ */
interface GPUStats {
  usage: number
  memoryUsedMB: number
  memoryTotalMB: number
  temperature: number
  modelName: string
}
interface MemoryStats {
  totalMB: number
  usedMB: number
  freeMB: number
}
interface PerformanceStats {
  cpu: number
  memory: MemoryStats
  gpu: GPUStats
  modelLatency: number
  throughput: number
}

interface SystemSnapshot {
  timestamp: number
  gpu: { name: string; usage: number; temperature: number; memoryUsedMB: number; memoryTotalMB: number; powerWatts: number } | null
  cpu: { usage: number; cores: number }
  memory: { totalMB: number; usedMB: number; freeMB: number; usagePct: number }
  disk: { readMBps: number; writeMBps: number }
  tokens: { inputTokens: number; outputTokens: number; tokensPerSec: number; tokPerSecAvg10: number }
}

interface ModelInfo {
  id: string
  name: string
  size: string
  params: string
  quantization: string
  isActive: boolean
  isRegistered: boolean
  isDownloaded: boolean
  isStartup: boolean
  downloadProgress: number
  version: string
  isDefault: boolean
  type?: string
  path?: string
  /** v12.1 常驻内存待命标记 */
  isStandby?: boolean
}

interface ModelConfig {
  gpuLayers: number
  contextSize: number
  batchSize: number
  threads: number
  temperature: number
  topP: number
  topK: number
  repeatPenalty: number
  maxTokens: number
  idleUnloadMinutes: number
}

/** 默认推理参数（恢复默认与初始状态共用，保证 UI 与落盘一致） */
const DEFAULT_MODEL_CONFIG: ModelConfig = {
  gpuLayers: 35, contextSize: 4096, batchSize: 512,
  threads: 4, temperature: 0.7, topP: 0.9, topK: 40,
  repeatPenalty: 1.1, maxTokens: 2048, idleUnloadMinutes: 30,
}

interface ConfirmModalProps {
  open: boolean
  title: string
  message: string
  onConfirm: () => void
  onCancel: () => void
}

interface DeviceStrategy {
  gpuName: string
  vramGB: number
  cpuCores: number
  ramGB: number
  recommendedQuant: string
  strategy: string
}

interface RegisteredModel {
  id: string
  name: string
  modelPath: string
  type: 'main' | 'vision' | 'embedding'
  mmprojPath?: string
  gpuLayers: number
  mode: 'gpu' | 'cpu'
  contextSize: number
  temperature: number
  maxTokens: number
  port: number
  isDefault: boolean
  isStartup: boolean
  registeredAt: number
  sizeMB?: number
  params?: string
  quantization?: string
}

/* ============================================================
 * 工具函数
 * ============================================================ */
function fmtBytes(mb: number): string {
  if (mb <= 0) return '0 MB'
  if (mb >= 1024) return (mb / 1024).toFixed(1) + ' GB'
  return mb.toFixed(0) + ' MB'
}

function fmtLatency(ms: number): string {
  if (ms <= 0) return '--'
  if (ms < 1000) return ms.toFixed(0) + ' ms/token'
  return (ms / 1000).toFixed(1) + ' s/token'
}
/* ============================================================
 * API 接入面板组件
 * ============================================================ */

interface ApiProvider {
  id: string
  name: string
  defaultBaseUrl: string
}

const API_PROVIDERS: ApiProvider[] = [
  { id: 'deepseek', name: 'DeepSeek', defaultBaseUrl: 'https://api.deepseek.com/v1' },
  { id: 'openai', name: 'OpenAI', defaultBaseUrl: 'https://api.openai.com/v1' },
  { id: 'qwen', name: '通义千问', defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  { id: 'zhipu', name: '智谱', defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
  { id: 'kimi', name: 'Kimi', defaultBaseUrl: 'https://api.moonshot.cn/v1' },
  { id: 'custom', name: '自定义', defaultBaseUrl: '' },
]

interface ApiModelCard {
  id: string
  name: string
  alias: string
  quotaUsed: number
  quotaTotal: number
  mode: 'hybrid' | 'fallback' | 'pureApi'
  provider: string
  enabled: boolean
  isDefault: boolean
}

const MODE_LABELS: Record<string, string> = {
  hybrid: '混合辅助',
  fallback: '仅兜底',
  pureApi: '纯API',
}

function ApiAccessPanel() {
  const [provider, setProvider] = useState('deepseek')
  const [apiKey, setApiKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [baseUrl, setBaseUrl] = useState(API_PROVIDERS[0].defaultBaseUrl)
  const [verifying, setVerifying] = useState(false)
  const [verifyResult, setVerifyResult] = useState<'success' | 'fail' | null>(null)
  const [models, setModels] = useState<ApiModelCard[]>([])
  const [editingAlias, setEditingAlias] = useState<string | null>(null)
  const [aliasDraft, setAliasDraft] = useState('')

  /* 动态拉取状态 */
  const [fetchingModels, setFetchingModels] = useState(false)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [connectionStatus, setConnectionStatus] = useState<'idle' | 'connected' | 'disconnected' | 'error'>('idle')
  const [fetchedApiModels, setFetchedApiModels] = useState<Array<{ id: string; name: string }>>([])

  // 从持久化配置加载已接入的模型列表
  useEffect(() => {
    const loadModels = async () => {
      try {
        if (window.api) {
          const saved = await window.api.invoke('config:get', 'cloudApiModels')
          if (Array.isArray(saved) && saved.length > 0) {
            setModels(saved)
          } else {
            setModels([])
          }
        } else {
          setModels([])
        }
      } catch {
        setModels([])
      }
    }
    loadModels()
  }, [])

  // 模型列表变更时持久化，并同步到主进程 providers（使 API 模型真正进入对话链路）
  const persistModels = useCallback((next: ApiModelCard[]) => {
    setModels(next)
    if (window.api) {
      window.api.invoke('config:set', 'cloudApiModels', next).catch((e) => { logger.warn('[Model] 保存API模型列表失败:', e) })
      // 同步当前 provider 组到主进程 providers store，供 chat 链路动态注册
      const group = next.filter(m => m.provider === provider)
      const apiProviderName = API_PROVIDERS.find(x => x.id === provider)?.name || provider
      if (group.length > 0 && baseUrl) {
        const cfg = {
          id: provider,
          name: apiProviderName,
          type: 'openai',
          baseUrl,
          apiKey,
          models: group.map(m => m.name),
        }
        window.api.invoke('llm:add-provider', cfg).then((res: any) => {
          if (res?.error === 'Provider already exists') {
            return window.api.invoke('llm:update-provider', provider, cfg)
          }
        }).catch(() => {})
      } else if (next.length === 0) {
        window.api.invoke('llm:delete-provider', provider).catch(() => {})
      }
      // 默认模型同步为主进程 activeProvider
      if (group.some(m => m.isDefault) && baseUrl) {
        window.api.invoke('llm:set-active-provider', provider).catch(() => {})
      }
    }
  }, [provider, apiKey, baseUrl])

  const handleProviderChange = (id: string) => {
    setProvider(id)
    const p = API_PROVIDERS.find(x => x.id === id)
    setBaseUrl(p?.defaultBaseUrl || '')
    setVerifyResult(null)
    setConnectionStatus('idle')
    setFetchedApiModels([])
    setFetchError(null)
  }

  const handleVerify = async () => {
    setVerifying(true)
    setVerifyResult(null)
    setConnectionStatus('idle')
    try {
      if (window.api) {
        const result = await window.api.invoke('llm:test-provider', { provider, apiKey, baseUrl }) as any
        if (result?.success) {
          setVerifyResult('success')
          setConnectionStatus('connected')
        } else {
          setVerifyResult('fail')
          setConnectionStatus('disconnected')
        }
      } else {
        setVerifyResult('success')
        setConnectionStatus('connected')
      }
    } catch {
      setVerifyResult('fail')
      setConnectionStatus('disconnected')
    }
    setVerifying(false)
  }

  /** 拉取模型列表 - 调用 /v1/models 端点 */
  const handleFetchModels = async () => {
    setFetchingModels(true)
    setFetchError(null)
    setFetchedApiModels([])
    try {
      const url = `${baseUrl.replace(/\/+$/, '')}/models`
      if (window.api) {
        const result = await window.api.invoke('llm:fetch-models', { provider, apiKey, baseUrl, url }) as any
        if (result?.models && Array.isArray(result.models)) {
          const apiModels = result.models.map((m: { id: string }) => ({
            id: m.id,
            name: m.id,
          }))
          setFetchedApiModels(apiModels)
          setConnectionStatus('connected')
          // 自动将拉取到的模型添加到列表
          const newModels: ApiModelCard[] = apiModels.map((m: { id: string; name: string }) => ({
            id: `${provider}-${m.id.replace(/[^a-zA-Z0-9_-]/g, '-')}`,
            name: m.id,
            alias: m.id,
            quotaUsed: 0,
            quotaTotal: 100000,
            mode: 'hybrid' as const,
            provider,
            enabled: true,
            isDefault: false,
          }))
          // 合并已有模型和拉取到的模型（去重）
          const existing = new Set(models.map(m => m.id))
          const merged = [...models, ...newModels.filter(m => !existing.has(m.id))]
          persistModels(merged)
        } else if (result?.error) {
          setFetchError(result.error)
          setConnectionStatus('error')
        }
      } else {
        // 浏览器模式：直接 fetch
        const response = await fetch(url, {
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
        })
        if (response.ok) {
          const data = await response.json()
          const apiModels = (data.data || []).map((m: { id: string }) => ({
            id: m.id,
            name: m.id,
          }))
          setFetchedApiModels(apiModels)
          setConnectionStatus('connected')
          const newModels: ApiModelCard[] = apiModels.map((m: { id: string; name: string }) => ({
            id: `${provider}-${m.id.replace(/[^a-zA-Z0-9_-]/g, '-')}`,
            name: m.id,
            alias: m.id,
            quotaUsed: 0,
            quotaTotal: 100000,
            mode: 'hybrid' as const,
            provider,
            enabled: true,
            isDefault: false,
          }))
          const existing = new Set(models.map(m => m.id))
          const merged = [...models, ...newModels.filter(m => !existing.has(m.id))]
          persistModels(merged)
        } else {
          setFetchError(`HTTP ${response.status}: ${response.statusText}`)
          setConnectionStatus('error')
        }
      }
    } catch (e) {
      setFetchError(String(e))
      setConnectionStatus('error')
    }
    setFetchingModels(false)
  }

  const toggleModel = (id: string) => {
    persistModels(models.map(m => m.id === id ? { ...m, enabled: !m.enabled } : m))
  }

  const deleteModel = (id: string) => {
    persistModels(models.filter(m => m.id !== id))
  }

  const setDefault = (id: string) => {
    persistModels(models.map(m => ({ ...m, isDefault: m.id === id })))
  }

  const startEditAlias = (id: string, current: string) => {
    setEditingAlias(id)
    setAliasDraft(current)
  }

  const saveAlias = (id: string) => {
    persistModels(models.map(m => m.id === id ? { ...m, alias: aliasDraft } : m))
    setEditingAlias(null)
  }

  return (
    <motion.div variants={containerVariants} initial="hidden" animate="visible"
      style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* 接入向导卡片 */}
      <motion.div variants={itemVariants} style={{
        background: COLORS.cardBg, border: `1px solid ${COLORS.cardBorder}`,
        borderRadius: 'var(--radius-2xl)', padding: 24,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
          <h3 style={{ fontSize: 16, fontWeight: 600, color: COLORS.textPrimary, margin: 0 }}>
            API 接入向导
          </h3>
          {/* 连接状态指示器 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {connectionStatus === 'connected' && (
              <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: COLORS.success }}>
                <Wifi size={13} /> 已连接
              </span>
            )}
            {connectionStatus === 'disconnected' && (
              <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: COLORS.danger }}>
                <WifiOff size={13} /> 连接失败
              </span>
            )}
            {connectionStatus === 'error' && (
              <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: COLORS.warning }}>
                <AlertTriangle size={13} /> 错误
              </span>
            )}
            {connectionStatus === 'idle' && (
              <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: COLORS.textMuted }}>
                <WifiOff size={13} /> 未连接
              </span>
            )}
          </div>
        </div>
        <p style={{ fontSize: 13, color: COLORS.textSecondary, margin: '0 0 20px' }}>
          选择模型提供商，输入 API Key 完成接入，即可在对话中使用云端模型
        </p>

        {/* 提供商选择 */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
          {API_PROVIDERS.map(p => (
            <button key={p.id} onClick={() => handleProviderChange(p.id)} style={{
              padding: '8px 16px', borderRadius: 10, cursor: 'pointer',
fontFamily: 'inherit', fontSize: 13, fontWeight: provider === p.id ? 600 : 400,
              border: provider === p.id ? `2px solid ${COLORS.accent}` : `1px solid ${COLORS.cardBorder}`,
background: provider === p.id ? `${HEX_COLORS.accent}15` : 'transparent',
              color: provider === p.id ? COLORS.accent : COLORS.textSecondary,
              transition: 'all 0.2s',
            }}>{p.name}</button>
          ))}
        </div>

        {/* API Key 输入 */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <div style={{ flex: 1, position: 'relative' }}>
            <input type={showKey ? 'text' : 'password'} value={apiKey}
              onChange={e => { setApiKey(e.target.value); setVerifyResult(null) }}
              placeholder="输入 API Key..."
              style={{
                width: '100%', padding: '10px 40px 10px 14px', borderRadius: 10,
                background: 'rgba(255,255,255,0.03)', border: `1px solid ${COLORS.cardBorder}`,
                color: COLORS.textPrimary, fontSize: 13, outline: 'none', boxSizing: 'border-box',
                fontFamily: 'var(--font-mono)',
              }}
              onFocus={e => e.currentTarget.style.borderColor = 'var(--border-focus)'}
              onBlur={e => e.currentTarget.style.borderColor = 'var(--border-default)'}
            />
            <button onClick={() => setShowKey(!showKey)} style={{
              position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)',
              background: 'none', border: 'none', cursor: 'pointer', padding: 4,
            }}>
              {showKey ? <EyeOff size={16} color={COLORS.textMuted} /> : <Eye size={16} color={COLORS.textMuted} />}
            </button>
          </div>
          <button onClick={handleVerify} disabled={verifying || !apiKey.trim()} style={{
            padding: '10px 20px', borderRadius: 10, cursor: (verifying || !apiKey.trim()) ? 'not-allowed' : 'pointer',
            fontFamily: 'inherit', fontSize: 13, fontWeight: 600,
            background: COLORS.accent, border: 'none', color: COLORS.bg,
            opacity: (verifying || !apiKey.trim()) ? 0.5 : 1,
          }}>
            {verifying ? <Loader size={14} style={{ animation: 'spin 1s linear infinite' }} /> : '验证连接'}
          </button>
          {/* 拉取模型列表按钮 */}
          <button
            onClick={handleFetchModels}
            disabled={fetchingModels || !apiKey.trim() || verifyResult !== 'success'}
            title={verifyResult !== 'success' ? '请先验证连接' : '拉取 API 模型列表'}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '10px 20px', borderRadius: 10,
              cursor: (fetchingModels || !apiKey.trim() || verifyResult !== 'success') ? 'not-allowed' : 'pointer',
              fontFamily: 'inherit', fontSize: 13, fontWeight: 600,
background: verifyResult === 'success' ? `${HEX_COLORS.success}20` : 'rgba(255,255,255,0.05)',
              border: verifyResult === 'success' ? `1px solid ${HEX_COLORS.success}30` : `1px solid ${COLORS.cardBorder}`,
              color: verifyResult === 'success' ? COLORS.success : COLORS.textMuted,
              opacity: (fetchingModels || !apiKey.trim() || verifyResult !== 'success') ? 0.5 : 1,
            }}
          >
            {fetchingModels ? (
              <Loader size={14} style={{ animation: 'spin 1s linear infinite' }} />
            ) : (
              <Download size={14} />
            )}
            拉取模型列表
          </button>
        </div>

        {/* Base URL */}
        <div style={{ marginBottom: 8 }}>
          <label style={{ fontSize: 12, color: COLORS.textSecondary }}>Base URL</label>
          <input type="text" value={baseUrl}
            onChange={e => setBaseUrl(e.target.value)}
            placeholder="https://api.example.com/v1"
            style={{
              width: '100%', padding: '10px 14px', borderRadius: 10,
              background: 'rgba(255,255,255,0.03)', border: `1px solid ${COLORS.cardBorder}`,
              color: COLORS.textPrimary, fontSize: 13, outline: 'none', boxSizing: 'border-box',
              fontFamily: 'var(--font-mono)', marginTop: 6,
            }}
            onFocus={e => e.currentTarget.style.borderColor = 'var(--border-focus)'}
            onBlur={e => e.currentTarget.style.borderColor = 'var(--border-default)'}
          />
        </div>

        {verifyResult === 'success' && (
          <span style={{ fontSize: 12, color: COLORS.success }}>连接成功，API 可用</span>
        )}
        {verifyResult === 'fail' && (
          <span style={{ fontSize: 12, color: COLORS.danger }}>连接失败，请检查 API Key 和 Base URL</span>
        )}

        {/* 拉取错误提示 */}
        {fetchError && (
          <div style={{
            marginTop: 8, padding: '8px 12px', borderRadius: 8,
background: COLORS.dangerDim, border: `1px solid ${HEX_COLORS.dangerAlt}26`,
            fontSize: 12, color: COLORS.danger, display: 'flex', alignItems: 'center', gap: 6,
          }}>
            <AlertTriangle size={14} />
            {fetchError}
          </div>
        )}

        {/* 拉取成功的模型列表 */}
        {fetchedApiModels.length > 0 && (
          <div style={{
            marginTop: 12, padding: '12px 16px', borderRadius: 12,
background: `${HEX_COLORS.success}0a`, border: `1px solid ${HEX_COLORS.success}26`,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
              <CheckCircle size={14} style={{ color: COLORS.success }} />
              <span style={{ fontSize: 13, fontWeight: 600, color: COLORS.success }}>
                已拉取 {fetchedApiModels.length} 个模型
              </span>
              <button
                onClick={handleFetchModels}
                disabled={fetchingModels}
                style={{
                  marginLeft: 'auto', padding: '4px 10px', borderRadius: 6, cursor: 'pointer',
                  fontFamily: 'inherit', fontSize: 11, fontWeight: 500,
                  background: 'rgba(255,255,255,0.05)', border: `1px solid ${COLORS.cardBorder}`,
                  color: COLORS.textSecondary, display: 'flex', alignItems: 'center', gap: 4,
                }}
              >
                <RefreshCw size={11} /> 刷新
              </button>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {fetchedApiModels.map(m => (
                <span key={m.id} style={{
                  fontSize: 11, padding: '2px 8px', borderRadius: 6,
background: COLORS.successDim, color: COLORS.success,
                  fontFamily: 'var(--font-mono)',
                }}>
                  {m.id}
                </span>
              ))}
            </div>
          </div>
        )}
      </motion.div>

      {/* 已接入模型列表 */}
      <motion.div variants={itemVariants} style={{
        background: COLORS.cardBg, border: `1px solid ${COLORS.cardBorder}`,
        borderRadius: 'var(--radius-2xl)', padding: 24,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <h3 style={{ fontSize: 14, fontWeight: 600, color: COLORS.textPrimary, margin: 0 }}>
            已接入模型 ({models.length})
          </h3>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {models.length === 0 && (
            <div style={{
              padding: '32px 16px', textAlign: 'center', borderRadius: 12,
              background: 'rgba(255,255,255,0.02)', border: `1px dashed ${COLORS.cardBorder}`,
            }}>
              <p style={{ fontSize: 13, color: COLORS.textMuted, margin: 0 }}>
                暂无已接入的云端模型，请先在上方输入 API Key 并点击「验证连接」→「拉取模型列表」
              </p>
            </div>
          )}
          {models.map(model => (
            <div key={model.id} style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '12px 16px', borderRadius: 12,
              background: 'rgba(255,255,255,0.02)', border: `1px solid ${COLORS.cardBorder}`,
            }}>
<div style={{ display: 'flex', alignItems: 'center', gap: 12, flex: 1 }}>
                <div style={{ width: 36, height: 36, borderRadius: 10, background: `${HEX_COLORS.accent}20`,
display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <Cpu size={18} color={COLORS.accent} />
                </div>
                <div>
                  {editingAlias === model.id ? (
                    <div style={{ display: 'flex', gap: 6 }}>
                      <input value={aliasDraft} onChange={e => setAliasDraft(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') saveAlias(model.id) }}
                        style={{ padding: '2px 8px', borderRadius: 6, fontSize: 13,
                          background: 'rgba(255,255,255,0.05)', border: `1px solid ${COLORS.accent}`,
                          color: COLORS.textPrimary, outline: 'none', width: 120 }}
                      />
                      <button onClick={() => saveAlias(model.id)} style={{
                        background: COLORS.accent, border: 'none', borderRadius: 6, color: COLORS.bg,
                        cursor: 'pointer', padding: '2px 8px', fontSize: 12, fontWeight: 600,
                      }}>保存</button>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontSize: 14, fontWeight: 500, color: COLORS.textPrimary }}>
                        {model.alias}
                      </span>
                      <button onClick={() => startEditAlias(model.id, model.alias)} style={{
                        background: 'none', border: 'none', cursor: 'pointer', padding: 2,
                      }}>
                        <Settings size={12} color={COLORS.textMuted} />
                      </button>
                    </div>
                  )}
                  <span style={{ fontSize: 11, color: COLORS.textMuted }}>{model.name} · {model.provider}</span>
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{
                  fontSize: 11, padding: '4px 10px', borderRadius: 8,
background: model.mode === 'hybrid' ? `${HEX_COLORS.success}1a` :
model.mode === 'fallback' ? COLORS.warningDim : 'rgba(59,130,246,0.1)',
                  color: model.mode === 'hybrid' ? COLORS.success :
                         model.mode === 'fallback' ? COLORS.warning : HEX_COLORS.blue,
                }}>{MODE_LABELS[model.mode]}</span>
                {/* 配额使用 */}
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                  <div style={{
                    width: 60, height: 4, borderRadius: 2,
                    background: 'rgba(255,255,255,0.08)', overflow: 'hidden',
                  }}>
                    <div style={{
                      height: '100%', borderRadius: 2,
                      width: `${Math.min((model.quotaUsed / Math.max(model.quotaTotal, 1)) * 100, 100)}%`,
                      background: (model.quotaUsed / Math.max(model.quotaTotal, 1)) > 0.8 ? COLORS.danger : COLORS.success,
transition: 'width 0.3s',
                    }} />
                  </div>
                  <span style={{ fontSize: 10, color: COLORS.textMuted }}>
                    {(((model.quotaUsed ?? 0) / Math.max(model.quotaTotal, 1)) * 100).toFixed(0)}%
                  </span>
                </div>
                <button onClick={() => toggleModel(model.id)} style={{
background: model.enabled ? `${HEX_COLORS.success}20` : 'rgba(255,255,255,0.05)',
                  border: 'none', borderRadius: 8, cursor: 'pointer', padding: '4px 10px',
                  fontSize: 11, fontWeight: 600, color: model.enabled ? COLORS.success : COLORS.textMuted,
                }}>
                  {model.enabled ? '已启用' : '已停用'}
                </button>
                {model.isDefault ? (
<span style={{ fontSize: 11, padding: '4px 10px', borderRadius: 8,
                    background: `${HEX_COLORS.accent}15`, color: COLORS.accent, fontWeight: 600 }}>
                    默认
                  </span>
                ) : (
                  <button onClick={() => setDefault(model.id)} style={{
background: 'rgba(255,255,255,0.05)', border: 'none', borderRadius: 8,
                    cursor: 'pointer', padding: '4px 10px', fontSize: 11, color: COLORS.textMuted,
                  }}>设为默认</button>
                )}
                <button onClick={() => deleteModel(model.id)} style={{
                  background: 'none', border: 'none', cursor: 'pointer', padding: 4,
                }}>
                  <Trash2 size={14} color={COLORS.textMuted} />
                </button>
              </div>
            </div>
          ))}
        </div>
      </motion.div>
    </motion.div>
  )
}

/* ============================================================
 * 确认弹窗组件
 * ============================================================ */
function ConfirmModal({ open, title, message, onConfirm, onCancel }: ConfirmModalProps) {
  // ESC / Enter 键盘行为：ESC 取消、Enter 确认，与原生对话框一致
  useEffect(() => {
    if (!open) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onCancel() }
      else if (e.key === 'Enter') { e.stopPropagation(); onConfirm() }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [open, onCancel, onConfirm])

  if (!open) return null
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9999,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)',
    }} onClick={onCancel}>
      <div onClick={e => e.stopPropagation()} style={{
        background: COLORS.cardBg, border: `1px solid ${COLORS.cardBorder}`,
        borderRadius: 'var(--radius-2xl)', padding: 28, maxWidth: 420, width: '90%',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          <AlertTriangle size={22} color={COLORS.danger} />
          <h3 style={{ fontSize: 16, fontWeight: 600, color: COLORS.textPrimary, margin: 0 }}>{title}</h3>
        </div>
        <p style={{ fontSize: 14, color: COLORS.textSecondary, lineHeight: 1.6, margin: '0 0 24px' }}>{message}</p>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button onClick={onCancel} style={{
            padding: '10px 24px', borderRadius: 10, cursor: 'pointer',
            fontFamily: 'inherit', fontSize: 13, fontWeight: 500,
            background: 'rgba(255,255,255,0.05)', border: `1px solid ${COLORS.cardBorder}`,
            color: COLORS.textSecondary,
          }}>取消</button>
          <button onClick={onConfirm} style={{
            padding: '10px 24px', borderRadius: 10, cursor: 'pointer',
            fontFamily: 'inherit', fontSize: 13, fontWeight: 600,
            background: COLORS.danger, border: 'none', color: '#fff',
          }}>确认</button>
        </div>
      </div>
    </div>
  )
}

/* ============================================================
 * 主组件
 * ============================================================ */

function ModelTuning() {
  /* ----- 状态 ----- */
  const [models, setModels] = useState<ModelInfo[]>([])
  const [config, setConfig] = useState<ModelConfig>({ ...DEFAULT_MODEL_CONFIG })
  // 用 ref 跟踪最新 config，避免 persistConfig 闭包过期
  const configRef = useRef(config)
  useEffect(() => { configRef.current = config }, [config])
  const [activeTab, setActiveTab] = useState<'local' | 'api' | 'tandem'>('local')
  const [perfStats, setPerfStats] = useState<PerformanceStats | null>(null)
  const [snapshots, setSnapshots] = useState<SystemSnapshot[]>([])
  const [snapshotRunning, setSnapshotRunning] = useState(false)
  const [deviceStrategy, setDeviceStrategy] = useState<DeviceStrategy | null>(null)
  const [showResetConfirm, setShowResetConfirm] = useState(false)
  const [showConfigFor, setShowConfigFor] = useState<string | null>(null)  // 当前打开配置面板的模型ID
  const [startupModelId, setStartupModelId] = useState<string | null>(null)
  /** v12.1 当前内存待命模型 ID */
  const [standbyModelId, setStandbyModelId] = useState<string | null>(null)
  const [registryModels, setRegistryModels] = useState<RegisteredModel[]>([])
  const [confirmModal, setConfirmModal] = useState<ConfirmModalProps & { open: boolean }>({
    open: false, title: '', message: '', onConfirm: () => {}, onCancel: () => {},
  })
  /* 拖拽导入状态 */
  const [isDragging, setIsDragging] = useState(false)
  const [importingFiles, setImportingFiles] = useState<string[]>([])
  /* 视觉模型双文件等待状态 */
  const [waitingForMmproj, setWaitingForMmproj] = useState(false)
  const [waitingModelPath, setWaitingModelPath] = useState<string | null>(null)

  /* 模型分析状态 */
  const [analyzedFilePath, setAnalyzedFilePath] = useState<string | null>(null)

  const [lastError, setLastError] = useState<string | null>(null)
  const [globalParamsCollapsed, setGlobalParamsCollapsed] = useState(false)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  /* A-3/A-4: 运行时状态聚合 + 参数回写辅助 refs */
  const [runtimeStatus, setRuntimeStatus] = useState<any>(null)
  const defaultModelIdRef = useRef<string | null>(null)
  const deviceStrategyRef = useRef<DeviceStrategy | null>(null)
  useEffect(() => { deviceStrategyRef.current = deviceStrategy }, [deviceStrategy])

  const tabs = [
    { key: 'local' as const, label: '本地模型' },
    { key: 'api' as const, label: '云端接入' },
    { key: 'tandem' as const, label: '联动模式' },
  ]

  /* ----- 数据加载 ----- */
  const loadModels = useCallback(async () => {
    try {
      if (window.api) {
        const result = await window.api.invoke('model:list') as any
        if (result?.models) {
          setModels(result.models)
        }
        const defaultId = await window.api.invoke('model:get-startup') as any
        setStartupModelId(defaultId || null)
      }
    } catch (e) { logger.error('[Model] 加载模型失败:', e); setLastError(String(e)) }
  }, [])

  const loadPerf = useCallback(async () => {
    try {
      if (window.api) {
        const stats = await window.api.invoke('model:manager:stats') as any
        if (stats) setPerfStats(stats)
      }
    } catch (e) { logger.error('[Model] 加载性能统计失败:', e) }
  }, [])

  const loadSnapshots = useCallback(async () => {
    try {
      if (window.api) {
        const result = await window.api.invoke('system:snapshots', { limit: 60 })
        if (result && Array.isArray(result)) setSnapshots(result)
      }
    } catch (e) { logger.error('[Model] 加载系统快照失败:', e) }
  }, [])

  /* ----- 注册表操作 ----- */
  const loadRegistry = useCallback(async () => {
    try {
      if (window.api) {
        const result = await window.api.invoke('model-registry:list')
        if (Array.isArray(result)) {
          setRegistryModels(result)
          const def = result.find((m: any) => m.isDefault)
          if (def) defaultModelIdRef.current = def.id
        }
      }
    } catch (e) { logger.error('[Model] 加载注册表失败:', e) }
  }, [])

  /* A-3: 加载综合运行状态（注册表模型 + tandem 服务器 + 已加载 + GPU 显存） */
  const loadRuntimeStatus = useCallback(async () => {
    try {
      if (window.api) {
        const result = await window.api.invoke('model-registry:runtime-status') as any
        if (result && result.success !== false) setRuntimeStatus(result)
      }
    } catch (e) { logger.error('[Model] 加载运行状态失败:', e) }
  }, [])

  /* v12.1 加载待命模型状态 */
  const loadStandbyStatus = useCallback(async () => {
    try {
      if (window.api) {
        const status = await window.api.invoke('model:standby:status') as { id: string | null; loaded: boolean }
        if (status) setStandbyModelId(status.id)
      }
    } catch (e) { logger.error('[Model] 加载待命模型状态失败:', e) }
  }, [])

  /* v12.1 切换内存待命：开启时加载到 RAM，关闭时卸载 */
  const toggleStandby = useCallback(async (modelId: string) => {
    try {
      if (!window.api) return
      const isOn = standbyModelId === modelId
      if (isOn) {
        // 关闭待命：卸载并清除标记
        await window.api.invoke('model:standby:unload')
        await window.api.invoke('model-registry:toggle-standby', modelId)
        setStandbyModelId(null)
      } else {
        // 开启待命：先加载到内存，成功后再持久化标记
        const res = await window.api.invoke('model:standby:load', modelId) as { success: boolean; error?: string }
        if (!res.success) {
          setLastError(res.error || '待命模型加载失败')
          return
        }
        await window.api.invoke('model-registry:toggle-standby', modelId)
        setStandbyModelId(modelId)
      }
    } catch (e) { logger.error('[Model] 切换待命失败:', e); setLastError(String(e)) }
  }, [standbyModelId])

  const removeRegistryModel = useCallback(async (id: string) => {
    try {
      if (window.api) {
        const result = await window.api.invoke('model-registry:remove', id) as { success: boolean; wasInUse?: boolean }
        if (result.success) {
          // 后端已联动停止 tandem 服务并卸载运行引擎；此处兜底再次确认端口已释放
          await window.api.invoke('tandem:stop-server', id)
          setRegistryModels(prev => prev.filter(m => m.id !== id))
          showToast('success', result.wasInUse ? '已移除并自动卸载运行中的模型引擎' : '模型已从注册表移除')
        } else {
          setLastError((result as any).error || '移除模型失败')
        }
      }
    } catch (e) { logger.error('[Model] 移除注册模型失败:', e); setLastError(String(e)) }
  }, [])

  const setRegistryDefault = useCallback(async (id: string) => {
    try {
      if (window.api) {
        const result = await window.api.invoke('model-registry:set-default', id) as { success: boolean }
        if (result.success) {
          setRegistryModels(prev => prev.map(m => ({ ...m, isDefault: m.id === id, isStartup: m.id === id })))
        }
      }
    } catch (e) { logger.error('[Model] 设默认失败:', e); setLastError(String(e)) }
  }, [])

  /* ----- 模型操作 ----- */
  const activateModel = useCallback(async (modelId: string) => {
    try {
      if (window.api) {
        await window.api.invoke('model:activate', modelId)
        setModels(prev => prev.map(m => ({
          ...m, isActive: m.id === modelId ? !m.isActive : m.isActive,
        })))
        loadPerf()
      }
    } catch (e) { logger.error('[Model] 激活模型失败:', e); setLastError(String(e)) }
  }, [loadPerf])

  const setDefault = useCallback(async (modelId: string) => {
    try {
      if (window.api) {
        await window.api.invoke('model:set-default', modelId)
        // 同步 model-registry（isDefault/isStartup），保证 model:health 与启动自动加载一致
        const regResult = await window.api.invoke('model-registry:set-default', modelId) as { success: boolean }
        if (!regResult.success) {
          logger.warn('[Model] model-registry 默认同步失败')
        }
        setModels(prev => prev.map(m => ({ ...m, isDefault: m.id === modelId })))
        setRegistryModels(prev => prev.map(m => ({ ...m, isDefault: m.id === modelId, isStartup: m.id === modelId })))
      }
    } catch (e) { logger.error('[Model] 设置默认模型失败:', e); setLastError(String(e)) }
  }, [])

  const setStartup = useCallback(async (modelId: string | null) => {
    const newId = startupModelId === modelId ? null : modelId
    try {
      if (window.api) {
        await window.api.invoke('model:set-startup', newId)
        setStartupModelId(newId)
      }
    } catch (e) { logger.error('[Model] 设置启动模型失败:', e); setLastError(String(e)) }
  }, [startupModelId])

  /** 保存模型参数到双通道（config:set + model:save-config），确保一致性
   *  使用 ref 避免闭包过期：无 partial 时读取最新 config */
  const persistConfig = useCallback(async (partial?: Partial<ModelConfig>) => {
    const current = configRef.current
    const newConfig = partial ? { ...current, ...partial } : { ...current }
    if (partial) setConfig(newConfig)
    try {
      if (window.api) {
        await window.api.invoke('config:set', 'modelConfig', newConfig)
        await window.api.invoke('model:save-config', newConfig)
        // A-4: 将推理模式/gpuLayers/contextSize 回写注册表并重启对应模型，使 UI 参数真实生效
        const targetId = defaultModelIdRef.current || null
        if (targetId) {
          const gpuLayers = Math.max(0, Math.min(99, Math.round(newConfig.gpuLayers ?? 0)))
          const ctx = Math.max(256, Math.round(newConfig.contextSize ?? 2048))
          const mode = gpuLayers > 0 ? 'gpu' : 'cpu'
          await window.api.invoke('model-registry:update-runtime', {
            id: targetId,
            patch: { gpuLayers, contextSize: ctx, mode },
          })
          const applied = await window.api.invoke('model-registry:restart-model', { id: targetId })
          logger.info('[Model] 参数已回写注册表并重启模型:', applied)
          await loadRuntimeStatus()
        }
      }
    } catch (e) { logger.error('[Model] 保存配置失败:', e); setLastError(String(e)) }
  }, [])

  const handleConfigChange = (key: keyof ModelConfig, value: number) => {
    setConfig(prev => ({ ...prev, [key]: value }))
  }

  const deleteModel = useCallback(async (modelId: string) => {
    setConfirmModal({
      open: true,
      title: '删除模型',
      message: '确定要删除该模型吗？此操作会从磁盘移除模型文件。',
      onConfirm: async () => {
        try {
          if (window.api) {
            await window.api.invoke('model:delete', modelId)
            setModels(prev => prev.filter(m => m.id !== modelId))
          }
        } catch (e) { logger.error('[Model] 删除模型失败:', e); setLastError(String(e)) }
        setConfirmModal(prev => ({ ...prev, open: false }))
      },
      onCancel: () => setConfirmModal(prev => ({ ...prev, open: false })),
    })
  }, [])

  /* ----- GGUF 拖拽导入 ----- */
  const dragCounterRef = useRef(0)
  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current += 1
    setIsDragging(true)
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current -= 1
    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0
      setIsDragging(false)
    }
  }, [])

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)
    dragCounterRef.current = 0

    const files = e.dataTransfer?.files
    if (!files || files.length === 0) return

    const ggufPaths: string[] = []
    const sizeMap: Record<string, number> = {}
    for (let i = 0; i < files.length; i++) {
      const f = files[i] as File & { path?: string }
      if (f.path && f.name.toLowerCase().endsWith('.gguf')) {
        if (f.size === 0) {
          setLastError(`文件 ${f.name} 为空（0 字节），无法导入，请检查文件是否完整`)
          continue
        }
        ggufPaths.push(f.path)
        sizeMap[f.path] = f.size
      }
    }
    if (ggufPaths.length === 0) return

    /* -- 触发模型分析 -- */
    setAnalyzedFilePath(ggufPaths[0])

    /* — 双文件等待模式：已有一个视觉模型在等待 mmproj — */
    if (waitingForMmproj && waitingModelPath) {
      const mmprojFile = ggufPaths.find(p => {
        const n = (p.split(/[/\\]/).pop() || '').toLowerCase()
        return n.startsWith('mmproj')
      })
      if (mmprojFile) {
        setImportingFiles([waitingModelPath, mmprojFile])
        await importModelWithMmp(waitingModelPath, mmprojFile, sizeMap[waitingModelPath])
        setImportingFiles([])
        setWaitingForMmproj(false)
        setWaitingModelPath(null)
        return
      }
      // 拖入的也不是 mmproj → 不配对，直接注册新文件
      setWaitingForMmproj(false)
      setWaitingModelPath(null)
    }

    setImportingFiles(ggufPaths)

    // 视觉模型配对：分离模型文件和 mmproj 文件
    const modelFiles: string[] = []
    const mmprojFiles: string[] = []
    for (const p of ggufPaths) {
      const name = (p.split(/[/\\]/).pop() || '').toLowerCase()
      if (name.startsWith('mmproj')) {
        mmprojFiles.push(p)
      } else {
        modelFiles.push(p)
      }
    }

    // 单文件 + 视觉模型名称 → 进入等待投影层状态
    if (modelFiles.length === 1 && mmprojFiles.length === 0) {
      const name = (modelFiles[0].split(/[/\\]/).pop() || '').toLowerCase()
      const isVision = name.includes('vl') || name.includes('vision') || name.includes('internvl') || name.includes('mmproj')
      if (isVision) {
        setWaitingForMmproj(true)
        setWaitingModelPath(modelFiles[0])
        setImportingFiles([])
        return
      }
    }

    // 按目录分组实现配对
    const paired: { modelPath: string; mmprojPath?: string }[] = []
    const unpairedMmp = [...mmprojFiles]

    for (const mp of modelFiles) {
      const dir = mp.substring(0, Math.max(mp.lastIndexOf('\\'), mp.lastIndexOf('/')))
      const matchIdx = unpairedMmp.findIndex(mm => {
        const mmDir = mm.substring(0, Math.max(mm.lastIndexOf('\\'), mm.lastIndexOf('/')))
        return mmDir === dir
      })
      if (matchIdx >= 0) {
        paired.push({ modelPath: mp, mmprojPath: unpairedMmp.splice(matchIdx, 1)[0] })
      } else {
        paired.push({ modelPath: mp })
      }
    }
    // 未配对的 mmproj 也作为独立条目（等待后续模型配对）
    for (const mm of unpairedMmp) {
      paired.push({ modelPath: mm })
    }

    for (const p of paired) {
      await importModelWithMmp(p.modelPath, p.mmprojPath, sizeMap[p.modelPath])
    }

    setImportingFiles([])
  }, [waitingForMmproj, waitingModelPath])

  const importModelWithMmp = useCallback(async (filePath: string, mmprojPath?: string, fileSize?: number) => {
    try {
      if (window.api) {
        const fileName = filePath.split(/[/\\]/).pop() || 'model.gguf'
        const baseName = fileName.replace(/\.gguf$/i, '')
        const modelId = baseName.replace(/[^a-zA-Z0-9_\u4e00-\u9fff-]/g, '-').substring(0, 64)
        const lowerName = modelId.toLowerCase()
        const type = mmprojPath || lowerName.includes('vl') || lowerName.includes('vision') || lowerName.includes('internvl') ? 'vision'
          : lowerName.includes('embed') || lowerName.includes('nomic') ? 'embedding'
          : 'main'

        await window.api.invoke('model:manager:register', {
          id: modelId,
          name: baseName,
          type,
          path: filePath,
          size: fileSize ?? 0,
          mmprojPath,
        })
        await window.api.invoke('model-registry:add', {
          id: modelId,
          name: baseName,
          modelPath: filePath,
          type,
          mmprojPath: mmprojPath || undefined,
          gpuLayers: 35,
          mode: 'gpu',
          contextSize: 4096,
          temperature: 0.7,
          maxTokens: 2048,
          isDefault: false,
          sizeMB: fileSize ? Math.round(fileSize / 1048576) : 0,
        })
        loadModels()
        loadRegistry()
        showToast('success', `模型「${baseName}」已接入`)
      }
    } catch (e) { logger.error('[Model] 导入模型失败:', e); setLastError(String(e)) }
  }, [loadModels, loadRegistry])

  /* ----- 配置变更（仅更新状态，不持久化，由用户手动保存） ----- */
  const updateConfig = useCallback((patch: Partial<ModelConfig>) => {
    setConfig(prev => ({ ...prev, ...patch }))
  }, [])

  const confirmReset = useCallback(() => {
    // 恢复默认：同时更新 UI 状态并落盘，避免「UI 显示默认值、磁盘仍是旧值」的不一致
    setConfig({ ...DEFAULT_MODEL_CONFIG })
    persistConfig(DEFAULT_MODEL_CONFIG)
    setShowResetConfirm(false)
  }, [persistConfig])

  /* ----- 初始化 ----- */
  useEffect(() => {
    loadModels()
    loadPerf()
    loadSnapshots()
    loadRegistry()
    loadStandbyStatus()
    loadRuntimeStatus()
  }, [loadModels, loadPerf, loadSnapshots, loadRegistry, loadStandbyStatus, loadRuntimeStatus])

  useEffect(() => {
    if (snapshotRunning) {
      intervalRef.current = setInterval(() => {
        loadPerf()
        loadSnapshots()
      }, 2000)
    } else {
      if (intervalRef.current) {
        clearInterval(intervalRef.current)
        intervalRef.current = null
      }
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [snapshotRunning, loadPerf, loadSnapshots])

  useEffect(() => {
    const loadDevice = async () => {
      try {
        if (window.api) {
          const strat = await window.api.invoke('model:config') as any
          if (strat?.deviceStrategy) setDeviceStrategy(strat.deviceStrategy)
        }
      } catch (e) { logger.error('[Model] 加载设备策略失败:', e) }
    }
    loadDevice()
  }, [])

  /* ===== 渲染 ===== */
  const activeCount = models.filter(m => m.isActive).length
  const totalCount = models.length

  /* 配置面板样式 */
  const sliderRowStyle: React.CSSProperties = {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '12px 0', borderBottom: '1px solid rgba(255,255,255,0.04)',
  }
  const sliderLabelStyle: React.CSSProperties = {
    display: 'flex', flexDirection: 'column', gap: 2, minWidth: 120,
  }
  const rangeStyle: React.CSSProperties = {
    flex: 1, height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.1)',
    accentColor: COLORS.accent, cursor: 'pointer',
  }

  return (
    <motion.div variants={containerVariants} initial="hidden" animate="visible"
      style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 20, paddingBottom: 40 }}>
      <ConfirmModal {...confirmModal} />

      {/* ===== 页面头部 ===== */}
      <motion.div variants={itemVariants} style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <div>
          <h2 style={{ fontSize: 22, fontWeight: 700, color: COLORS.textPrimary, margin: 0 }}>
            模型管理
          </h2>
          <p style={{ fontSize: 13, color: COLORS.textSecondary, margin: '4px 0 0' }}>
            {totalCount > 0 ? `${activeCount}/${totalCount} 已激活` : '暂无模型'}
            {deviceStrategy && ` · ${deviceStrategy.gpuName}`}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => setSnapshotRunning(!snapshotRunning)} style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '8px 16px', borderRadius: 10, cursor: 'pointer',
fontFamily: 'inherit', fontSize: 13, fontWeight: 500,
background: snapshotRunning ? `${HEX_COLORS.success}20` : 'rgba(255,255,255,0.05)',
            border: `1px solid ${COLORS.cardBorder}`,
            color: snapshotRunning ? COLORS.success : COLORS.textSecondary,
            transition: 'all 0.2s',
          }}>
            <Activity size={14} />
            {snapshotRunning ? '监控中' : '系统监控'}
          </button>
          <button onClick={() => persistConfig()} style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '8px 16px', borderRadius: 10, cursor: 'pointer',
            fontFamily: 'inherit', fontSize: 13, fontWeight: 500,
            background: COLORS.accent, border: 'none', color: COLORS.bg,
          }}>
            <Save size={14} /> 保存配置
          </button>
        </div>
      </motion.div>

      {/* ===== Tab 切换 ===== */}
      <div style={{
        display: 'flex', gap: 4, padding: 4,
        background: 'rgba(255,255,255,0.03)', borderRadius: 14,
        border: `1px solid ${COLORS.cardBorder}`, width: 'fit-content',
      }}>
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            style={{
              padding: '8px 20px', borderRadius: 11, cursor: 'pointer',
              fontFamily: 'inherit', fontSize: 13, fontWeight: activeTab === tab.key ? 600 : 400,
              border: 'none',
              background: activeTab === tab.key ? COLORS.accent : 'transparent',
              color: activeTab === tab.key ? COLORS.bg : COLORS.textSecondary,
              transition: 'background-color 0.15s',
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* ===== 双模型运行状态条（v12.1） ===== */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
        background: 'rgba(255,255,255,0.03)', border: `1px solid ${COLORS.cardBorder}`,
        borderRadius: 14, padding: '10px 16px',
      }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: COLORS.textSecondary }}>模型运行状态</span>
        {/* 主模型常驻 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: COLORS.textSecondary }}>
          <span style={{
            width: 8, height: 8, borderRadius: '50%',
            background: models.some(m => m.isActive) ? COLORS.success : COLORS.textMuted,
          }} />
          主模型
          <span style={{ color: COLORS.textMuted }}>
            {models.find(m => m.isActive)?.name || (startupModelId ? models.find(m => m.id === startupModelId)?.name || '常驻' : '未加载')}
          </span>
          <span style={{ color: COLORS.textMuted, fontSize: 11 }}>常驻显存</span>
        </div>
        <div style={{ width: 1, height: 16, background: COLORS.cardBorder }} />
        {/* 待命模型 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: COLORS.textSecondary }}>
          <span style={{
            width: 8, height: 8, borderRadius: '50%',
            background: standbyModelId ? COLORS.accent : COLORS.textMuted,
          }} />
          待命模型
          <span style={{ color: COLORS.textMuted }}>
            {standbyModelId ? (models.find(m => m.id === standbyModelId)?.name || '已加载') : '无'}
          </span>
          <span style={{ color: COLORS.textMuted, fontSize: 11 }}>
            {standbyModelId ? '内存待命中' : '按需加载'}
          </span>
        </div>
      </div>

      {/* ===== 性能监控面板 ===== */}
      {snapshotRunning && (
        <ErrorBoundary fallback={
          <div style={{
            background: COLORS.cardBg, border: `1px solid ${COLORS.cardBorder}`,
            borderRadius: 'var(--radius-2xl)', padding: '20px 24px',
            textAlign: 'center', color: COLORS.textMuted, fontSize: 13,
          }}>
            系统监控组件加载失败，请刷新页面重试
          </div>
        }>
        <motion.div variants={itemVariants}
          initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }}
          transition={{ duration: 0.3 }}
          style={{
            background: COLORS.cardBg, border: `1px solid ${COLORS.cardBorder}`,
            borderRadius: 'var(--radius-2xl)', padding: '20px 24px',
            overflow: 'hidden', minHeight: 80,
          }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
            <Activity size={16} color={COLORS.accent} />
            <h3 style={{ fontSize: 14, fontWeight: 600, color: COLORS.textPrimary, margin: 0 }}>
              实时性能监控
            </h3>
            {!perfStats && (
              <span style={{ fontSize: 12, color: COLORS.textMuted, marginLeft: 8 }}>
                正在获取数据...
              </span>
            )}
            {lastError && (
              <span style={{ fontSize: 11, color: COLORS.dangerAlt, marginLeft: 8 }}>
                监控数据获取异常
              </span>
            )}
          </div>
          {perfStats ? (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12 }}>
              {/* CPU */}
              <div style={{
                background: 'rgba(255,255,255,0.02)', border: `1px solid ${COLORS.cardBorder}`,
                borderRadius: 12, padding: 14,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                  <Cpu size={14} color={COLORS.textSecondary} />
                  <span style={{ fontSize: 12, color: COLORS.textSecondary }}>CPU</span>
                </div>
                <div style={{ fontSize: 24, fontWeight: 700, color: COLORS.textPrimary }}>
                  {(perfStats?.cpu ?? 0).toFixed(0)}%
                </div>
                <div style={{
                  height: 4, borderRadius: 2, marginTop: 8,
                  background: 'rgba(255,255,255,0.08)', overflow: 'hidden',
                }}>
                  <div style={{
                    height: '100%', borderRadius: 2,
                    width: `${Math.min(perfStats?.cpu ?? 0, 100)}%`,
                    background: (perfStats?.cpu ?? 0) > 80 ? COLORS.danger :
                               (perfStats?.cpu ?? 0) > 50 ? COLORS.warning : COLORS.success,
                    transition: 'width 0.5s',
                  }} />
                </div>
              </div>
              {/* GPU */}
              <div style={{
                background: 'rgba(255,255,255,0.02)', border: `1px solid ${COLORS.cardBorder}`,
                borderRadius: 12, padding: 14,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                  <BarChart3 size={14} color={COLORS.textSecondary} />
                  <span style={{ fontSize: 12, color: COLORS.textSecondary }}>GPU</span>
                </div>
                <div style={{ fontSize: 24, fontWeight: 700, color: COLORS.textPrimary }}>
                  {perfStats?.gpu?.usage != null ? `${perfStats.gpu.usage.toFixed(0)}%` : '--'}
                </div>
                <div style={{ fontSize: 11, color: COLORS.textMuted, marginTop: 4 }}>
                  {perfStats?.gpu?.memoryUsedMB != null ?
                    `${fmtBytes(perfStats.gpu.memoryUsedMB)} / ${fmtBytes(perfStats.gpu.memoryTotalMB)}` :
                    '无 GPU'}
                </div>
              </div>
              {/* 显存 */}
              <div style={{
                background: 'rgba(255,255,255,0.02)', border: `1px solid ${COLORS.cardBorder}`,
                borderRadius: 12, padding: 14,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                  <MemoryStick size={14} color={COLORS.textSecondary} />
                  <span style={{ fontSize: 12, color: COLORS.textSecondary }}>显存</span>
                </div>
                <div style={{ fontSize: 24, fontWeight: 700, color: COLORS.textPrimary }}>
                  {perfStats?.gpu ? fmtBytes(perfStats.gpu.memoryUsedMB) : '--'}
                </div>
                <div style={{ fontSize: 11, color: COLORS.textMuted, marginTop: 4 }}>
                  {perfStats?.gpu ? `${((perfStats.gpu.memoryUsedMB / Math.max(perfStats.gpu.memoryTotalMB, 1)) * 100).toFixed(0)}%` : '--'}
                </div>
              </div>
              {/* 延迟 */}
              <div style={{
                background: 'rgba(255,255,255,0.02)', border: `1px solid ${COLORS.cardBorder}`,
                borderRadius: 12, padding: 14,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                  <Zap size={14} color={COLORS.textSecondary} />
                  <span style={{ fontSize: 12, color: COLORS.textSecondary }}>延迟</span>
                </div>
                <div style={{ fontSize: 24, fontWeight: 700, color: COLORS.textPrimary }}>
                  {fmtLatency(perfStats.modelLatency ?? 0)}
                </div>
                <div style={{ fontSize: 11, color: COLORS.textMuted, marginTop: 4 }}>
                  {(perfStats?.throughput ?? 0).toFixed(1)} tok/s
                </div>
              </div>
            </div>
          ) : (
            <div style={{ textAlign: 'center', padding: '24px 0', color: COLORS.textMuted, fontSize: 13 }}>
              暂无监控数据
            </div>
          )}
        </motion.div>
        </ErrorBoundary>
      )}

      {/* ===== 系统监控历史图表 ===== */}
      {snapshotRunning && snapshots.length > 0 && (
        <ErrorBoundary fallback={
          <div style={{
            background: COLORS.cardBg, border: `1px solid ${COLORS.cardBorder}`,
            borderRadius: 'var(--radius-2xl)', padding: '20px 24px',
            textAlign: 'center', color: COLORS.textMuted, fontSize: 13,
          }}>
            历史图表加载失败，请关闭监控后重试
          </div>
        }>
        <motion.div variants={itemVariants}
          initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }}
          transition={{ duration: 0.3 }}
          style={{
            background: COLORS.cardBg, border: `1px solid ${COLORS.cardBorder}`,
            borderRadius: 'var(--radius-2xl)', padding: '20px 24px', overflow: 'hidden',
          }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
            <Activity size={16} color={COLORS.accent} />
            <h3 style={{ fontSize: 14, fontWeight: 600, color: COLORS.textPrimary, margin: 0 }}>
              资源使用历史
            </h3>
            <span style={{ fontSize: 11, color: COLORS.textMuted, marginLeft: 'auto' }}>
              最近 {snapshots.length} 条
            </span>
          </div>
          <div style={{ display: 'flex', gap: 2, alignItems: 'flex-end', height: 80 }}>
            {snapshots.slice(-60).map((s, i) => (
              <div key={`${s.timestamp}-${i}`} style={{
                flex: 1, display: 'flex', flexDirection: 'column', gap: 2,
                minWidth: 4, maxWidth: 8,
              }}>
                <div style={{
                  height: `${Math.min(s.cpu?.usage ?? 0, 100)}%`,
                  background: (s.cpu?.usage ?? 0) > 80 ? COLORS.danger :
                             (s.cpu?.usage ?? 0) > 50 ? COLORS.warning : COLORS.success,
borderRadius: '2px 2px 0 0',
                  opacity: 0.7,
                }} />
                {s.gpu && (
                  <div style={{
                    height: `${Math.min(s.gpu.usage, 100)}%`,
                    background: `${HEX_COLORS.accent}80`,
borderRadius: '0 0 2px 2px',
                    opacity: 0.5,
                  }} />
                )}
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6, fontSize: 10, color: COLORS.textMuted }}>
            <span>{snapshots.length > 0 ? new Date(snapshots[0].timestamp).toLocaleTimeString() : ''}</span>
            <span>CPU(top) GPU(bottom)</span>
            <span>{snapshots.length > 0 ? new Date(snapshots[snapshots.length - 1].timestamp).toLocaleTimeString() : ''}</span>
          </div>
        </motion.div>
        </ErrorBoundary>
      )}

      {/* ===== 本地模型 Tab ===== */}
      {activeTab === 'local' && (
        <motion.div key="local" variants={containerVariants} initial="hidden" animate="visible"
          style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

          {/* 拖拽导入区域 — 始终可见在顶部 */}
          <motion.div variants={itemVariants}
            onDragEnter={handleDragEnter}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            style={{
              background: waitingForMmproj
? `${HEX_COLORS.violet}14`
                : isDragging ? `${HEX_COLORS.accent}10` : COLORS.cardBg,
              border: waitingForMmproj
                ? '2px dashed rgba(139,92,246,0.6)'
                : isDragging
                  ? `2px dashed ${COLORS.accent}`
                  : `2px dashed ${COLORS.cardBorder}`,
              borderRadius: 'var(--radius-2xl)', padding: '32px 24px',
              textAlign: 'center', cursor: 'default',
              transition: 'all 0.2s',
            }}>
            <FolderOpen size={40} color={waitingForMmproj ? HEX_COLORS.violetLight : isDragging ? COLORS.accent : COLORS.textMuted}
              style={{ marginBottom: 12, opacity: registryModels.length === 0 && !isDragging && !waitingForMmproj && !importingFiles.length ? 0.6 : 1 }} />
            {waitingForMmproj ? (
              <>
                <p style={{ fontSize: 15, color: HEX_COLORS.violetLight, fontWeight: 600, margin: '0 0 4px' }}>
                  等待投影层文件...
                </p>
                <p style={{ fontSize: 13, color: COLORS.textSecondary, margin: '0 0 8px' }}>
                  已识别视觉模型 <code style={{ background: `${HEX_COLORS.violet}26`, padding: '1px 6px', borderRadius: 4 }}>{waitingModelPath?.split(/[/\\]/).pop()}</code>，请拖入对应的 mmproj 投影文件
                </p>
                <button onClick={(e) => { e.stopPropagation(); setWaitingForMmproj(false); setWaitingModelPath(null); }}
                  style={{
                    padding: '4px 14px', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit', fontSize: 12,
                    background: 'rgba(255,255,255,0.05)', border: `1px solid ${COLORS.cardBorder}`,
                    color: COLORS.textSecondary,
                  }}>
                  取消
                </button>
              </>
            ) : isDragging ? (
              <>
                <p style={{ fontSize: 15, color: COLORS.accent, fontWeight: 600, margin: '0 0 4px' }}>
                  释放以导入模型
                </p>
                <p style={{ fontSize: 13, color: COLORS.textSecondary, margin: 0 }}>
                  支持拖入 GGUF 文件，视觉模型可同时拖入权重文件和 mmproj 投影文件自动配对
                </p>
              </>
            ) : importingFiles.length > 0 ? (
              <>
                <Loader size={24} color={COLORS.accent} style={{ marginBottom: 8, animation: 'spin 1s linear infinite' }} />
                <p style={{ fontSize: 14, color: COLORS.textPrimary, margin: 0 }}>
                  正在导入 {importingFiles.length} 个文件...
                </p>
              </>
            ) : models.length === 0 && registryModels.length === 0 ? (
              <>
                <p style={{ fontSize: 16, color: COLORS.textSecondary, fontWeight: 500, margin: '0 0 6px' }}>
                  暂无本地模型
                </p>
                <p style={{ fontSize: 14, color: COLORS.textMuted, margin: '0 0 12px', lineHeight: 1.6 }}>
                  拖拽 GGUF 模型文件到此区域进行接入
                </p>
                <p style={{ fontSize: 12, color: COLORS.textMuted, margin: 0, opacity: 0.7 }}>
                  视觉模型需同时拖入权重文件 (.gguf) 和投影层文件 (mmproj*.gguf)
                </p>
              </>
            ) : (
              <>
                <p style={{ fontSize: 15, color: COLORS.textSecondary, margin: '0 0 4px' }}>
                  拖拽 GGUF 模型文件到此处
                </p>
                <p style={{ fontSize: 13, color: COLORS.textMuted, margin: 0 }}>
                  支持单个/多个文件，视觉模型自动配对 mmproj 投影文件
                </p>
              </>
            )}
          </motion.div>

          {/* 模型分析卡片 - 当有文件被拖入/选中时显示 */}
          <ModelAnalysisCard
            filePath={analyzedFilePath}
            deviceStrategy={deviceStrategy}
            currentConfig={config}
            onApplyConfig={(newConfig) => {
              persistConfig(newConfig)
            }}
          />

          {/* 推理模式选择器 */}
          <InferenceModeSelector
            deviceStrategy={deviceStrategy}
            modelAnalysis={null}
            currentConfig={config}
            onApplyMode={(params) => {
              persistConfig(params)
            }}
          />

          {/* 已加载模型（实时运行状态）— A-3 */}
          {runtimeStatus && ((runtimeStatus.loaded && runtimeStatus.loaded.length > 0) || (runtimeStatus.servers && runtimeStatus.servers.length > 0)) && (
            <div>
              <motion.div variants={itemVariants} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <h3 style={{ fontSize: 14, fontWeight: 600, color: COLORS.textPrimary, margin: 0 }}>
                  已加载模型
                </h3>
                <span style={{ fontSize: 11, color: COLORS.textMuted }}>实时运行状态（GPU/CPU、层数、端口）</span>
              </motion.div>

              {/* GPU 显存总览 */}
              {runtimeStatus.gpu && (runtimeStatus.gpu.memoryTotal ?? 0) > 0 && (
                <motion.div variants={itemVariants} style={{
                  background: COLORS.cardBg, border: `1px solid ${COLORS.cardBorder}`,
                  borderRadius: 'var(--radius-2xl)', padding: '12px 16px', marginBottom: 8,
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                    <span style={{ fontSize: 12, color: COLORS.textSecondary }}>GPU 显存占用</span>
                    <span style={{ fontSize: 12, color: COLORS.textSecondary, fontWeight: 600 }}>
                      {Math.round(runtimeStatus.gpu.memoryUsed ?? 0)} / {Math.round(runtimeStatus.gpu.memoryTotal ?? 0)} MB
                    </span>
                  </div>
                  <div style={{ height: 6, borderRadius: 3, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
                    <div style={{
                      height: '100%', borderRadius: 3,
                      width: `${Math.min(100, Math.round(((runtimeStatus.gpu.memoryUsed ?? 0) / Math.max(1, runtimeStatus.gpu.memoryTotal ?? 1)) * 100))}%`,
                      background: 'linear-gradient(90deg, var(--accent), #a78bfa)',
                      transition: 'width 0.4s ease',
                    }} />
                  </div>
                </motion.div>
              )}

              {(runtimeStatus.loaded ?? []).map((m: any) => {
                const s = (runtimeStatus.servers ?? []).find((sv: any) => sv.id === m.id)
                const isGpu = m.mode === 'gpu' || (m.gpuLayers ?? 0) > 0
                const memMb = typeof m.memoryUsage === 'number' && m.memoryUsage > 0
                  ? (m.memoryUsage > 1048576 ? `${Math.round(m.memoryUsage / 1048576)} MB` : `${Math.round(m.memoryUsage)} B`)
                  : ''
                return (
                  <motion.div key={m.id} variants={itemVariants} style={{
                    background: COLORS.cardBg,
                    border: isGpu ? `1px solid ${HEX_COLORS.success}40` : `1px solid ${COLORS.cardBorder}`,
                    borderRadius: 'var(--radius-xl)', padding: '12px 16px', marginBottom: 8,
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                        <span style={{ fontSize: 13, fontWeight: 600, color: COLORS.textPrimary }}>{m.name}</span>
                        <span style={{
                          fontSize: 10, padding: '2px 6px', borderRadius: 6,
                          background: isGpu ? COLORS.successDim : COLORS.warningDim,
                          color: isGpu ? COLORS.success : COLORS.warning, fontWeight: 600,
                        }}>{isGpu ? 'GPU' : 'CPU'}</span>
                        {m.type === 'vision' && (
                          <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 6, background: COLORS.violetDim, color: HEX_COLORS.violetLight, fontWeight: 600 }}>视觉</span>
                        )}
                        {s && (
                          <span style={{
                            fontSize: 10, padding: '2px 6px', borderRadius: 6,
                            background: s.status === 'running' ? `${HEX_COLORS.success}15` : `${HEX_COLORS.warning}15`,
                            color: s.status === 'running' ? COLORS.success : COLORS.warning, fontWeight: 600,
                          }}>{s.status === 'running' ? `运行中 :${s.port}` : '未运行'}</span>
                        )}
                      </div>
                      <span style={{ fontSize: 11, color: COLORS.textMuted, flexShrink: 0 }}>
                        {isGpu ? `GPU ${m.gpuLayers ?? 0} 层` : '纯 CPU'}
                        {memMb ? ` · ${memMb}` : ''}
                      </span>
                    </div>
                  </motion.div>
                )
              })}
            </div>
          )}

          {/* 已接入模型（长效保存）— 在拖拽区下方滚动 */}
          {registryModels.length > 0 && (
            <div>
              <motion.div variants={itemVariants} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <h3 style={{ fontSize: 14, fontWeight: 600, color: COLORS.textPrimary, margin: 0 }}>
                  已接入模型
                </h3>
                <span style={{ fontSize: 11, color: COLORS.textMuted }}>({registryModels.length} 个，长效保存，随软件启动)</span>
              </motion.div>
              {registryModels.map((rm) => (
                <motion.div key={rm.id} variants={itemVariants} style={{
                  background: COLORS.cardBg,
                  border: rm.isDefault ? `1px solid ${HEX_COLORS.accent}50` : `1px solid ${COLORS.cardBorder}`,
                  borderRadius: 'var(--radius-2xl)', padding: '16px 20px',
                  position: 'relative', overflow: 'hidden',
                }}>
                  {rm.isDefault && (
                    <div style={{
                      position: 'absolute', top: 0, left: 0, right: 0, height: 2,
                      background: `linear-gradient(90deg, ${COLORS.accent}, ${COLORS.success}, ${COLORS.accent})`,
                      backgroundSize: '200% 100%', animation: 'shimmer 2s linear infinite',
                    }} />
                  )}
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
<div style={{ display: 'flex', gap: 12, alignItems: 'center', flex: 1, minWidth: 0 }}>
                      <div style={{
                        width: 40, height: 40, borderRadius: 12,
background: rm.isDefault ? `${HEX_COLORS.accent}20` : 'rgba(255,255,255,0.03)',
                        display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                      }}>
                        <Cpu size={18} color={rm.isDefault ? COLORS.accent : COLORS.textMuted} />
                      </div>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                          <span style={{ fontSize: 14, fontWeight: 600, color: COLORS.textPrimary }}>{rm.name}</span>
                          <span style={{
                            fontSize: 10, padding: '2px 6px', borderRadius: 6,
background: rm.mode === 'gpu' ? COLORS.successDim : COLORS.warningDim,
                            color: rm.mode === 'gpu' ? COLORS.success : COLORS.warning,
                            fontWeight: 600,
                          }}>{rm.mode === 'gpu' ? 'GPU' : 'CPU'}</span>
                          {rm.type === 'vision' && (
<span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 6, background: COLORS.violetDim, color: HEX_COLORS.violetLight, fontWeight: 600 }}>视觉</span>
                          )}
                          {rm.isDefault && (
<span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 6, background: `${HEX_COLORS.accent}15`, color: COLORS.accent, fontWeight: 600 }}>默认</span>
                          )}
                        </div>
<div style={{ fontSize: 11, color: COLORS.textMuted, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {rm.modelPath}
                        </div>
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 6, flexShrink: 0, alignItems: 'center' }}>
                      {/* 设为默认 */}
                      {!rm.isDefault && (
                        <button onClick={() => setRegistryDefault(rm.id)} style={{
                          padding: '5px 10px', borderRadius: 8, cursor: 'pointer',
                          fontFamily: 'inherit', fontSize: 11, fontWeight: 500,
                          background: 'rgba(255,255,255,0.03)', border: `1px solid ${COLORS.cardBorder}`,
                          color: COLORS.textSecondary,
                        }}><Star size={12} style={{ marginRight: 3, verticalAlign: -1 }} />设为默认</button>
                      )}
                      {/* 删除 */}
                      <button onClick={() => {
                        setConfirmModal({
                          open: true,
                          title: '移除模型',
                          message: `确定要移除「${rm.name}」吗？此操作仅从注册表删除模型路径，不删除模型文件。若该模型正在运行或作为当前推理模型使用，将被自动卸载并停止服务。`,
                          onConfirm: () => {
                            removeRegistryModel(rm.id)
                            setConfirmModal(prev => ({ ...prev, open: false }))
                          },
                          onCancel: () => setConfirmModal(prev => ({ ...prev, open: false })),
                        })
                      }} style={{
                        padding: '5px 8px', borderRadius: 8, cursor: 'pointer',
                        background: 'rgba(255,255,255,0.03)', border: `1px solid ${COLORS.cardBorder}`,
                        color: COLORS.textMuted,
                      }}><Trash2 size={13} /></button>
                    </div>
                  </div>
                </motion.div>
              ))}
            </div>
          )}

          {/* 模型卡片列表 — 自动换行网格布局，带滚动容器防止卡片遮挡 */}
          <div style={{ display: 'flex', gap: 16, paddingBottom: 8, flexWrap: 'wrap', maxHeight: 'calc(100vh - 520px)', overflowY: 'auto', minHeight: 60, alignContent: 'flex-start' }}>
          {models.map((model) => (
            <motion.div key={model.id} variants={itemVariants} style={{
              background: COLORS.cardBg,
              border: model.isActive ? `1px solid ${COLORS.accent}` : `1px solid ${COLORS.cardBorder}`,
              borderRadius: 'var(--radius-2xl)', padding: '20px 24px',
              position: 'relative', overflow: 'hidden',
              width: 280, flexShrink: 0,
            }}>
              {/* 激活状态指示器 */}
              {model.isActive && (
                <div style={{
                  position: 'absolute', top: 0, left: 0, right: 0, height: 2,
                  background: `linear-gradient(90deg, ${COLORS.accent}, ${COLORS.success}, ${COLORS.accent})`,
                  backgroundSize: '200% 100%',
                  animation: 'shimmer 2s linear infinite',
                }} />
              )}

              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
<div style={{ display: 'flex', gap: 14, flex: 1 }}>
                  {/* 模型图标 */}
                  <div style={{
                    width: 48, height: 48, borderRadius: 14,
background: model.isActive ? `${HEX_COLORS.accent}20` : 'rgba(255,255,255,0.03)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    flexShrink: 0,
                  }}>
                    {model.isActive ?
                      <Power size={22} color={COLORS.accent} /> :
                      <PowerOff size={22} color={COLORS.textMuted} />
                    }
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <h4 style={{ fontSize: 15, fontWeight: 600, color: COLORS.textPrimary, margin: 0 }}>
                        {model.name}
                      </h4>
                      {model.type && (
                        <span style={{
                          fontSize: 10, padding: '2px 8px', borderRadius: 6,
background: model.type === 'vision' ? `${HEX_COLORS.violet}26` :
                                       model.type === 'embedding' ? 'rgba(59,130,246,0.15)' :
COLORS.successDim,
                          color: model.type === 'vision' ? HEX_COLORS.violetLight :
                                  model.type === 'embedding' ? '#60a5fa' :
                                  COLORS.success,
                          fontWeight: 600,
                        }}>{model.type === 'vision' ? 'VL视觉' : model.type === 'embedding' ? 'Embedding' : '推理'}</span>
                      )}
                      {model.isDefault && (
                        <span style={{
fontSize: 10, padding: '2px 8px', borderRadius: 6,
                          background: `${HEX_COLORS.accent}15`, color: COLORS.accent,
                          fontWeight: 600,
                        }}>默认</span>
                      )}
                      {startupModelId === model.id && (
                        <span style={{
fontSize: 10, padding: '2px 8px', borderRadius: 6,
background: COLORS.successDim, color: COLORS.success,
                          fontWeight: 600,
                        }}>随软件启动</span>
                      )}
                    </div>
                    <div style={{ display: 'flex', gap: 12, marginTop: 4, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 12, color: COLORS.textMuted }}>{model.size}</span>
                      <span style={{ fontSize: 12, color: COLORS.textMuted }}>{model.params}</span>
                      <span style={{ fontSize: 12, color: COLORS.textMuted }}>{model.quantization}</span>
                      <span style={{ fontSize: 12, color: COLORS.textMuted }}>v{model.version}</span>
                    </div>
                  </div>
                </div>
                {/* 操作按钮组 */}
                <div style={{ display: 'flex', gap: 6, flexShrink: 0, alignItems: 'center' }}>
                  {/* 随软件启动开关 */}
                  {model.isDownloaded && (
                    <button
                      onClick={() => setStartup(model.id)}
                      title={startupModelId === model.id ? '取消随软件启动' : '设为随软件启动'}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 4,
                        padding: '6px 10px', borderRadius: 8, cursor: 'pointer',
fontFamily: 'inherit', fontSize: 12, fontWeight: 500,
background: startupModelId === model.id ? `${HEX_COLORS.success}15` : 'rgba(255,255,255,0.03)',
border: `1px solid ${startupModelId === model.id ? `${HEX_COLORS.success}4d` : COLORS.cardBorder}`,
                        color: startupModelId === model.id ? COLORS.success : COLORS.textSecondary,
                        transition: 'background-color 0.15s',
                      }}
                    >
                      {startupModelId === model.id ? <ToggleRight size={16} /> : <ToggleLeft size={16} />}
                      随软件启动
                    </button>
                  )}

                  {/* v12.1 内存待命开关 */}
                  {model.isDownloaded && (
                    <button
                      onClick={() => toggleStandby(model.id)}
                      title={standbyModelId === model.id ? '取消内存待命' : '常驻内存待命（随叫随用）'}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 4,
                        padding: '6px 10px', borderRadius: 8, cursor: 'pointer',
fontFamily: 'inherit', fontSize: 12, fontWeight: 500,
background: standbyModelId === model.id ? `${HEX_COLORS.accent}18` : 'rgba(255,255,255,0.03)',
                        border: `1px solid ${standbyModelId === model.id ? `${HEX_COLORS.accent}45` : COLORS.cardBorder}`,
                        color: standbyModelId === model.id ? COLORS.accent : COLORS.textSecondary,
transition: 'background-color 0.15s',
                      }}
                    >
                      {standbyModelId === model.id ? <MemoryStick size={16} /> : <ToggleLeft size={16} />}
                      {standbyModelId === model.id ? '内存待命中' : '设为待命'}
                    </button>
                  )}

                  {/* 设为默认 */}
                  {model.isDownloaded && !model.isDefault && (
                    <button onClick={() => setDefault(model.id)} style={{
                      padding: '6px 12px', borderRadius: 8, cursor: 'pointer',
                      fontFamily: 'inherit', fontSize: 12, fontWeight: 500,
                      background: 'rgba(255,255,255,0.03)', border: `1px solid ${COLORS.cardBorder}`,
                      color: COLORS.textSecondary,
                    }}>
                      <Star size={13} style={{ marginRight: 4, verticalAlign: 'middle' }} />
                      设为默认
                    </button>
                  )}

                  {/* 激活/停用 */}
                  <button onClick={() => activateModel(model.id)} style={{
                    padding: '6px 12px', borderRadius: 8, cursor: 'pointer',
fontFamily: 'inherit', fontSize: 12, fontWeight: 500,
                    background: model.isActive ? `${HEX_COLORS.danger}15` : `${HEX_COLORS.success}15`,
                    border: model.isActive ? `1px solid ${HEX_COLORS.danger}30` : `1px solid ${HEX_COLORS.success}30`,
                    color: model.isActive ? COLORS.danger : COLORS.success,
                  }}>
{model.isActive ? '停用' : '激活'}
                  </button>

                  {/* 模型配置 */}
                  <button onClick={() => setShowConfigFor(showConfigFor === model.id ? null : model.id)} style={{
padding: '6px 10px', borderRadius: 8, cursor: 'pointer',
background: showConfigFor === model.id ? `${HEX_COLORS.accent}15` : 'rgba(255,255,255,0.03)',
                    border: showConfigFor === model.id ? `1px solid ${HEX_COLORS.accent}40` : `1px solid ${COLORS.cardBorder}`,
                    color: showConfigFor === model.id ? COLORS.accent : COLORS.textMuted,
                  }}>
                    <Settings size={14} />
                  </button>

                  {/* 删除 */}
                  <button onClick={() => deleteModel(model.id)} style={{
                    padding: '6px 10px', borderRadius: 8, cursor: 'pointer',
                    background: 'rgba(255,255,255,0.03)', border: `1px solid ${COLORS.cardBorder}`,
                    color: COLORS.textMuted,
                  }}>
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            </motion.div>
          ))}

          {/* 模型参数配置面板 */}
          {showConfigFor && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              style={{
                background: COLORS.cardBg, border: `1px solid ${HEX_COLORS.accent}30`,
                borderRadius: 'var(--radius-xl)', padding: '20px 24px',
                overflow: 'hidden',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
                <h3 style={{ fontSize: 14, fontWeight: 600, color: COLORS.textPrimary, margin: 0 }}>
                  模型参数配置
                </h3>
                <button
                  onClick={() => persistConfig()}
                  style={{
                    padding: '6px 16px', borderRadius: 8, cursor: 'pointer',
fontFamily: 'inherit', fontSize: 12, fontWeight: 500,
                    background: `${HEX_COLORS.accent}20`, border: `1px solid ${HEX_COLORS.accent}30`,
                    color: COLORS.accent,
                  }}
                >
                  <Save size={12} style={{ marginRight: 4, verticalAlign: -1 }} />
                  保存配置
                </button>
              </div>

              {/* temperature */}
              <div style={sliderRowStyle}>
                <div style={sliderLabelStyle}>
                  <span>Temperature</span>
                  <span style={{ color: COLORS.textMuted, fontSize: 11 }}>创造性 (0-2)</span>
                </div>
<div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, maxWidth: 300 }}>
                  <input type="range" min={0} max={2} step={0.1} value={config.temperature}
                    onChange={e => handleConfigChange('temperature', parseFloat(e.target.value))}
                    style={rangeStyle} />
                  <span style={{ minWidth: 32, textAlign: 'right', fontSize: 13, color: COLORS.accent, fontFamily: 'var(--font-mono)' }}>
                    {config.temperature.toFixed(1)}
                  </span>
                </div>
              </div>

              {/* topP */}
              <div style={sliderRowStyle}>
                <div style={sliderLabelStyle}>
                  <span>Top-P</span>
                  <span style={{ color: COLORS.textMuted, fontSize: 11 }}>核采样 (0-1)</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, maxWidth: 300 }}>
                  <input type="range" min={0} max={1} step={0.05} value={config.topP}
                    onChange={e => handleConfigChange('topP', parseFloat(e.target.value))}
                    style={rangeStyle} />
                  <span style={{ minWidth: 32, textAlign: 'right', fontSize: 13, color: COLORS.accent, fontFamily: 'var(--font-mono)' }}>
                    {config.topP.toFixed(2)}
                  </span>
                </div>
              </div>

              {/* maxTokens */}
              <div style={sliderRowStyle}>
                <div style={sliderLabelStyle}>
                  <span>Max Tokens</span>
                  <span style={{ color: COLORS.textMuted, fontSize: 11 }}>最大生成长度 (100-8192)</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, maxWidth: 300 }}>
                  <input type="number" min={100} max={8192} step={100} value={config.maxTokens}
                    onChange={e => handleConfigChange('maxTokens', parseInt(e.target.value) || 2048)}
                    style={{
                      width: 80, padding: '6px 10px', borderRadius: 8, textAlign: 'center',
                      background: 'rgba(255,255,255,0.04)', border: `1px solid ${COLORS.cardBorder}`,
                      color: COLORS.textPrimary, fontSize: 13, fontFamily: 'var(--font-mono)',
                    }} />
                </div>
              </div>

              {/* topK */}
              <div style={sliderRowStyle}>
                <div style={sliderLabelStyle}>
                  <span>Top-K</span>
                  <span style={{ color: COLORS.textMuted, fontSize: 11 }}>候选词数量 (1-100)</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, maxWidth: 300 }}>
                  <input type="range" min={1} max={100} step={1} value={config.topK}
                    onChange={e => handleConfigChange('topK', parseInt(e.target.value))}
                    style={rangeStyle} />
                  <span style={{ minWidth: 32, textAlign: 'right', fontSize: 13, color: COLORS.accent, fontFamily: 'var(--font-mono)' }}>
                    {config.topK}
                  </span>
                </div>
              </div>

              {/* repeatPenalty */}
              <div style={sliderRowStyle}>
                <div style={sliderLabelStyle}>
                  <span>Repeat Penalty</span>
                  <span style={{ color: COLORS.textMuted, fontSize: 11 }}>重复惩罚 (1.0-2.0)</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, maxWidth: 300 }}>
                  <input type="range" min={1.0} max={2.0} step={0.05} value={config.repeatPenalty}
                    onChange={e => handleConfigChange('repeatPenalty', parseFloat(e.target.value))}
                    style={rangeStyle} />
                  <span style={{ minWidth: 32, textAlign: 'right', fontSize: 13, color: COLORS.accent, fontFamily: 'var(--font-mono)' }}>
                    {config.repeatPenalty.toFixed(2)}
                  </span>
                </div>
              </div>

              {/* contextSize */}
              <div style={sliderRowStyle}>
                <div style={sliderLabelStyle}>
                  <span>Context Size</span>
                  <span style={{ color: COLORS.textMuted, fontSize: 11 }}>上下文长度 (512-32768)</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, maxWidth: 300 }}>
                  <input type="number" min={512} max={32768} step={512} value={config.contextSize}
                    onChange={e => handleConfigChange('contextSize', parseInt(e.target.value) || 4096)}
                    style={{
                      width: 80, padding: '6px 10px', borderRadius: 8, textAlign: 'center',
                      background: 'rgba(255,255,255,0.04)', border: `1px solid ${COLORS.cardBorder}`,
                      color: COLORS.textPrimary, fontSize: 13, fontFamily: 'var(--font-mono)',
                    }} />
                </div>
              </div>
            </motion.div>
          )}
          </div>


        </motion.div>
      )}

      {/* ===== API 接入 Tab ===== */}
      {activeTab === 'api' && (<>
        <ApiAccessPanel />
        <CloudQuotaPanel />
        <LocalAiPanel />
      </>)}

      {/* ===== 联动模式 Tab ===== */}
      {activeTab === 'tandem' && <TandemPanel />}

      {/* ===== 全局推理参数（可折叠） ===== */}
      <motion.div variants={itemVariants} style={{
        background: COLORS.cardBg, border: `1px solid ${COLORS.cardBorder}`,
        borderRadius: 'var(--radius-2xl)', padding: '20px 24px',
      }}>
        <div
          onClick={() => setGlobalParamsCollapsed(!globalParamsCollapsed)}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', marginBottom: globalParamsCollapsed ? 0 : 16 }}
        >
          <h3 style={{ fontSize: 14, fontWeight: 600, color: COLORS.textPrimary, margin: 0 }}>
            全局推理参数
          </h3>
          <motion.span
            animate={{ rotate: globalParamsCollapsed ? 0 : 180 }}
            transition={{ duration: 0.25 }}
            style={{ color: COLORS.textSecondary, display: 'flex', alignItems: 'center' }}
          >
            {globalParamsCollapsed ? <ChevronRight size={18} /> : <ChevronDown size={18} />}
          </motion.span>
        </div>
        {!globalParamsCollapsed && (<>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '14px 20px' }}>
          {[
            { key: 'gpuLayers', label: 'GPU 层数', min: 0, max: 99, step: 1 },
            { key: 'contextSize', label: '上下文长度', min: 512, max: 32768, step: 512 },
            { key: 'batchSize', label: '批处理大小', min: 1, max: 2048, step: 1 },
            { key: 'threads', label: 'CPU 线程数', min: 1, max: 32, step: 1 },
            { key: 'temperature', label: '温度', min: 0, max: 2, step: 0.1 },
            { key: 'topP', label: 'Top-P', min: 0, max: 1, step: 0.05 },
            { key: 'topK', label: 'Top-K', min: 1, max: 100, step: 1 },
            { key: 'repeatPenalty', label: '重复惩罚', min: 1, max: 2, step: 0.05 },
            { key: 'idleUnloadMinutes', label: '空闲卸载(分钟)', min: 0, max: 120, step: 5 },
          ].map(({ key, label, min, max, step }) => {
            const val = config[key as keyof ModelConfig] as number
            return (
              <div key={key} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <label style={{ fontSize: 12, color: COLORS.textSecondary }}>{label}</label>
                  <span style={{ fontSize: 12, color: COLORS.textMuted, fontFamily: 'var(--font-mono)' }}>
                    {Number.isInteger(step) ? val : val.toFixed(2)}
                  </span>
                </div>
                <input type="range" min={min} max={max} step={step} value={val}
                  onChange={e => updateConfig({ [key]: parseFloat(e.target.value) } as Partial<ModelConfig>)}
                  style={{ width: '100%', accentColor: COLORS.accent }}
                />
              </div>
            )
          })}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
          <button onClick={() => setShowResetConfirm(true)} style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '8px 16px', borderRadius: 10, cursor: 'pointer',
            fontFamily: 'inherit', fontSize: 13, fontWeight: 500,
            background: 'rgba(255,255,255,0.03)', border: `1px solid ${COLORS.cardBorder}`,
            color: COLORS.textSecondary,
          }}>
            <RotateCcw size={14} /> 恢复默认
          </button>
        </div>
        </>)}
      </motion.div>

      {/* 恢复默认确认弹窗 */}
      {showResetConfirm && confirmModal.open === false && (
        <ConfirmModal
          open={showResetConfirm}
          title="恢复默认设置"
          message="所有参数将被重置为默认值，此操作不可撤销。是否继续？"
          onConfirm={confirmReset}
          onCancel={() => setShowResetConfirm(false)}
        />
      )}

      {/* 错误提示横幅 */}
      {lastError && (
        <div style={{
          position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 9998,
          height: 48, display: 'flex', alignItems: 'center', justifyContent: 'center',
          gap: 12, padding: '0 20px',
          background: 'rgba(220, 38, 38, 0.85)', color: '#fff',
          backdropFilter: 'blur(8px)',
          fontSize: 13, fontWeight: 500,
        }}>
          <AlertTriangle size={16} />
          <span style={{ flex: 1, textAlign: 'center', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            操作失败：{lastError}
          </span>
          <button onClick={() => setLastError(null)} style={{
            background: 'rgba(255,255,255,0.15)', border: 'none', borderRadius: 6,
            color: '#fff', cursor: 'pointer', padding: '4px 12px',
            fontSize: 12, fontWeight: 600, fontFamily: 'inherit',
          }}>关闭</button>
        </div>
      )}
    </motion.div>
  )
}

export default ModelTuning
