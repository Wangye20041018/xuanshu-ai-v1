/**
 * 智能模型调度系统 — 调度中枢
 *
 * 完整调度链路：
 *   任务识别(classifier) → 选模型(profiles) → 检查是否已加载 → 自动加载(分层) →
 *   推理(tandemManager.queryModel) → 失败回退(逐级降档) → 结果+决策反馈
 *
 * 复用现有链路：不重复造引擎。
 * - 模型注册/运行参数：model-registry + runtime/hardware.resolveModelRuntime
 * - 模型加载/推理：tandem-manager.startServer / queryModel
 *
 * 透明可观测：每次调度产出 ScheduleDecision（为什么选这个模型）+ ScheduleRecord（历史）。
 *
 * @module scheduler/index
 */

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { modelRegistry } from '../model-registry'
import { tandemManager, type TandemModelConfig } from '../tandem-manager'
import { getHardware, resolveModelRuntime, type HardwareInfo } from '../runtime/hardware'
import { logger } from '../../shared/logger'
import { sendToAllWindows } from '../utils/broadcast'
import { getStore } from '../ipc/config.ipc'
import { classifyTask } from './classifier'
import { profileManager, pickModelIds } from './profiles'
import { callCloud, isComplexForCloud, resolveCloudProviderConfig } from './cloud'
import type {
  ModelProfile,
  ScheduleAttempt,
  ScheduleDecision,
  ScheduleRecord,
  SchedulerConfig,
  TaskClassifyResult,
} from './types'

const HISTORY_KEY = 'schedulerHistory'
const CONFIG_KEY = 'schedulerConfig'

const DEFAULT_CONFIG: SchedulerConfig = {
  enabled: true,
  historyLimit: 50,
  version: 1,
  cloud: {
    enabled: true,
    providerId: 'deepseek',
    modelId: 'deepseek-v4-pro',
    complexOnly: true,
    complexThreshold: 8000,
    tokenBudget: 0,
  },
  resident: {
    residentModelId: 'qwen-coder-9b',
    swapEnabled: true,
    restoreAfterTask: true,
    swapTimeoutMs: 120000,
  },
}

export interface SchedulerRunResult {
  success: boolean
  content: string
  elapsedMs: number
  tokensPerSec: number
  decision: ScheduleDecision
  attempts: ScheduleAttempt[]
  fallbackChain: string[]
  error?: string
  record?: ScheduleRecord
  /** 本次是否实际走了云端补救 */
  usedCloud?: boolean
  /** 云端 Provider id（usedCloud 时有效） */
  cloudProviderId?: string
}

class Scheduler {
  private config: SchedulerConfig = { ...DEFAULT_CONFIG }
  /** 进行中的调度（防止同一请求重复触发） */
  private inflight = new Set<string>()

  private getStore() {
    const store = getStore()
    if (!store) throw new Error('[Scheduler] config store 未初始化')
    return store
  }

  /* ============================================================
   * 配置
   * ============================================================ */
  loadConfig(): void {
    try {
      const store = this.getStore()
      this.config = { ...DEFAULT_CONFIG, ...(store.get(CONFIG_KEY, {}) as SchedulerConfig) }
    } catch (e) {
      logger.error('[Scheduler] loadConfig 失败:', e)
    }
  }

  getConfig(): SchedulerConfig {
    return this.config
  }

  async setConfig(patch: Partial<SchedulerConfig>): Promise<SchedulerConfig> {
    this.config = { ...this.config, ...patch }
    const store = this.getStore()
    store.set(CONFIG_KEY, this.config)
    this.broadcast('config', this.config)
    return this.config
  }

  /* ============================================================
   * 任务识别 + 决策
   * ============================================================ */

  /** 步骤 1：任务识别 */
  classify(text: string): TaskClassifyResult {
    return classifyTask(text)
  }

  /** 步骤 2：根据任务类型做调度决策（选模型 + 计算期望运行位置/分层 + 云端补救标记） */
  async decide(text: string, taskType?: TaskClassifyResult['taskType']): Promise<ScheduleDecision> {
    const cls = taskType ? { taskType, confidence: 0.9, evidence: ['手动指定任务类型'], locked: true } : this.classify(text)

    // 候选模型链（按画像适用性 + 优先级）
    const candidates = pickModelIds(cls.taskType, 4)

    // 若没有候选（全部禁用或未注册文本模型），回退到注册表默认模型
    let finalCandidates = candidates
    if (finalCandidates.length === 0) {
      const def = modelRegistry.getDefault?.() || modelRegistry.list().find(m => m.type === 'main')
      if (def) finalCandidates = [def.id]
    }

    // 云端补救可用性（复杂任务 + 云端已配置激活）
    const cloudCfg = this.config.cloud
    const cloudProvider = resolveCloudProviderConfig(cloudCfg?.providerId)
    const cloudReady = !!(cloudCfg?.enabled && cloudProvider)
    const cloudCandidate = isComplexForCloud(cls.taskType, text.length, cloudCfg!)

    const selected = finalCandidates[0] || null
    if (!selected) {
      // 无本地可用模型：若云端已就绪且本任务适合升级云端，则标记云端兜底
      if (cloudReady && cloudCandidate) {
        return {
          taskType: cls.taskType,
          classify: cls,
          modelId: '',
          modelName: '',
          reason: `无可用本地模型，且任务判定为「${cls.taskType}」（${cloudCandidate ? '复杂任务，符合升级条件' : '非复杂任务'}），将升级云端补救（${cloudCfg!.providerId}/${cloudCfg!.modelId}）`,
          candidates: [],
          targetDevice: 'cpu',
          gpuLayers: 0,
          contextSize: cloudCfg!.tokenBudget || 2048,
          ts: Date.now(),
          cloudFallback: true,
          cloudProviderId: cloudCfg!.providerId,
        }
      }
      throw new Error('无可用的已注册文本模型（请先在模型页注册模型并启用调度画像，或启用云端补救）')
    }

    // 计算期望运行位置与分层（优先 GPU）
    const reg = modelRegistry.list().find(m => m.id === selected)
    const hw = await getHardware()
    const rt = resolveModelRuntime(
      { ...(reg || {}), runLocation: reg?.runLocation ?? 'auto' },
      hw,
    )

    const profile = profileManager.list().find(p => p.id === selected)
    const reason = this.buildReason(cls, profile, rt, hw, cloudReady && cloudCandidate)

    // 单模型常驻换载判断：目标模型 ≠ 常驻主力 且 需要 GPU 时，需停常驻换载目标
    const residentCfg = this.config.resident
    const residentModelId = residentCfg?.residentModelId || ''
    const needsSwap = !!(residentCfg?.swapEnabled && residentModelId && residentModelId !== selected && rt.available && rt.targetDevice === 'gpu')

    return {
      taskType: cls.taskType,
      classify: cls,
      modelId: selected,
      modelName: reg?.name || selected,
      reason,
      candidates: finalCandidates,
      targetDevice: rt.available ? rt.targetDevice : 'cpu',
      gpuLayers: rt.available ? rt.gpuLayers : 0,
      contextSize: rt.contextSize || reg?.contextSize || 2048,
      ts: Date.now(),
      cloudFallback: false,
      needsSwap,
      residentModelId: needsSwap ? residentModelId : undefined,
    }
  }

  private buildReason(
    cls: TaskClassifyResult,
    profile: ModelProfile | undefined,
    rt: { available: boolean; targetDevice: 'gpu' | 'cpu'; gpuLayers: number; reason: string },
    hw: HardwareInfo,
    cloudCandidate: boolean,
  ): string {
    const parts: string[] = []
    parts.push(`任务判定为「${cls.taskType}」`)
    if (profile) {
      parts.push(`画像匹配：${profile.name}（速度${profile.speed}/质量${profile.quality}）`)
    }
    if (rt.available) {
      if (rt.targetDevice === 'gpu') {
        parts.push(`显存充足（${hw.vramMB >= 1024 ? (hw.vramMB / 1024).toFixed(1) + 'GB' : hw.vramMB + 'MB'}），优先 GPU 分层 ${rt.gpuLayers} 层`)
      } else {
        parts.push(`GPU 不可用/显存不足，回退 CPU`)
      }
    } else {
      parts.push(`该模型当前不可用（${rt.reason}）`)
    }
    if (cloudCandidate) {
      parts.push('本地失败时可升级云端补救')
    }
    return parts.join('；')
  }

  /* ============================================================
   * 模型加载（自动分层，优先 GPU）
   * ============================================================ */

  /** 检查模型是否已加载运行 */
  isLoaded(modelId: string): boolean {
    return tandemManager
      .getServerStates()
      .some(s => s.modelId === modelId && (s.status === 'running' || s.status === 'starting'))
  }

  /**
   * 统一入口：EnsureModelAvailable(task, needVision?)
   * 判断当前任务所需能力的模型是否就绪；未就绪时执行「缩窗口 → 降档 → 云端补救」降级链。
   * 返回值 ok=false 且 cloudFallback=true 表示应切换云端对应能力模型。
   */
  async ensureModelAvailable(
    task: string,
    needVision = false,
    hw?: HardwareInfo,
  ): Promise<{ ok: boolean; modelId: string; device?: 'gpu' | 'cpu'; cloudFallback: boolean; reason?: string }> {
    logger.debug(`[Scheduler] EnsureModelAvailable: needVision=${needVision}, task=${task.slice(0, 60)}`)
    // 视觉任务：优先视觉模型；无则标记云端视觉补救
    if (needVision) {
      const visionId = modelRegistry.list().find(m => m.type === 'vision')?.id
      if (visionId && this.isLoaded(visionId)) {
        return { ok: true, modelId: visionId, device: 'gpu', cloudFallback: false }
      }
      // 视觉模型未就绪：交给云端多模态（若配置）或提示用户
      const cloudCfg = this.config.cloud
      const cloudProvider = resolveCloudProviderConfig(cloudCfg?.providerId)
      if (cloudCfg?.enabled && cloudProvider) {
        return { ok: false, modelId: '', cloudFallback: true, reason: '视觉模型未就绪，切换云端多模态' }
      }
      return { ok: false, modelId: '', cloudFallback: false, reason: '视觉模型未就绪且云端不可用' }
    }

    // 文本任务：默认主模型
    const def = modelRegistry.getDefault?.() || modelRegistry.list().find(m => m.type === 'main')
    if (!def) {
      const cloudCfg = this.config.cloud
      const cloudProvider = resolveCloudProviderConfig(cloudCfg?.providerId)
      if (cloudCfg?.enabled && cloudProvider) {
        return { ok: false, modelId: '', cloudFallback: true, reason: '无本地文本模型，切换云端' }
      }
      return { ok: false, modelId: '', cloudFallback: false, reason: '无本地文本模型且云端不可用' }
    }
    if (this.isLoaded(def.id)) {
      return { ok: true, modelId: def.id, device: 'gpu', cloudFallback: false }
    }
    const load = await this.ensureLoaded(def.id, hw)
    if (load.ok) {
      return { ok: true, modelId: def.id, device: load.attempt.device, cloudFallback: false }
    }
    // 本地加载失败：云端补救
    const cloudCfg = this.config.cloud
    const cloudProvider = resolveCloudProviderConfig(cloudCfg?.providerId)
    if (cloudCfg?.enabled && cloudProvider) {
      return { ok: false, modelId: '', cloudFallback: true, reason: `本地加载失败（${load.error}），切换云端` }
    }
    return { ok: false, modelId: '', cloudFallback: false, reason: `本地加载失败且云端不可用: ${load.error}` }
  }

  /**
   * 确保模型已加载：未加载则按真实显存分层启动。
   * 内置「降档重试」：显存不足/contextSize 过大（如 qwen2-vl-2b 的 65536 报错）时，
   * 先缩窗口重试一次，再降档 CPU 重试一次，仍失败才返回失败（交由上层云端补救）。
   */
  async ensureLoaded(modelId: string, hw?: HardwareInfo): Promise<{ ok: boolean; attempt: ScheduleAttempt; error?: string }> {
    if (this.isLoaded(modelId)) {
      const state = tandemManager.getServerStates().find(s => s.modelId === modelId)
      return {
        ok: true,
        attempt: {
          modelId,
          modelName: modelId,
          gpuLayers: state?.gpuLayers ?? 0,
          device: state?.mode === 'gpu' ? 'gpu' : 'cpu',
          status: 'running',
          elapsedMs: 0,
        },
      }
    }

    const reg = modelRegistry.list().find(m => m.id === modelId)
    if (!reg) {
      return { ok: false, attempt: { modelId, modelName: modelId, gpuLayers: 0, device: 'cpu', status: 'failed', elapsedMs: 0, error: `模型 ${modelId} 未注册` }, error: `模型 ${modelId} 未注册` }
    }
    if (!existsSync(reg.modelPath)) {
      return { ok: false, attempt: { modelId, modelName: reg.name, gpuLayers: 0, device: 'cpu', status: 'failed', elapsedMs: 0, error: `模型文件不存在: ${reg.modelPath}` }, error: `模型文件不存在: ${reg.modelPath}` }
    }

    const hwinfo = hw ?? await getHardware()
    const start = Date.now()
    // 通过 resolveModelRuntime 计算分层（含 18B 特殊策略，hardware.ts 已扩展）
    const rt = resolveModelRuntime({ ...reg, runLocation: reg.runLocation ?? 'auto' }, hwinfo)
    if (!rt.available) {
      return { ok: false, attempt: { modelId, modelName: reg.name, gpuLayers: 0, device: 'cpu', status: 'failed', elapsedMs: Date.now() - start, error: rt.reason }, error: rt.reason }
    }

    // 构造 tandem 配置并启动
    const buildCfg = (gpuLayers: number, contextSize: number, mode: 'gpu' | 'cpu'): TandemModelConfig => ({
      id: reg.id,
      name: reg.name,
      port: reg.port || 8082,
      modelPath: reg.modelPath,
      gpuLayers,
      contextSize,
      mode,
      temperature: reg.temperature ?? 0.7,
      maxTokens: reg.maxTokens ?? 2048,
      // v13.x 多模态主模型：透传 mmproj 视觉头（llama-server --mmproj），视觉推理直接走主模型
      mmprojPath: reg.mmprojPath,
    })

    let cfg = buildCfg(rt.gpuLayers, rt.contextSize || reg.contextSize || 2048, rt.targetDevice === 'gpu' ? 'gpu' : 'cpu')

    // 若目标需要 GPU 且已有其他 GPU 模型在跑（6GB 限制），先停旧的
    if (cfg.mode === 'gpu') {
      const others = tandemManager.getServerStates().filter(s => s.status === 'running' && s.modelId !== modelId && s.mode === 'gpu')
      for (const o of others) {
        logger.info(`[Scheduler] GPU 被 ${o.modelId} 占用，先停止以让位 ${modelId}`)
        await tandemManager.stopServer(o.modelId)
      }
    }

    // 第一次启动
    let result = await tandemManager.startServer(cfg)

    // 降档重试 1：缩窗口（contextSize 过大导致 VRAM 不足，如 qwen2-vl-2b 的 65536 报错）
    if (!result.success && cfg.mode === 'gpu' && cfg.contextSize > 8192) {
      const reduced = 8192
      logger.warn(`[Scheduler] ${modelId} 启动失败（可能 contextSize 过大），缩窗口 ${cfg.contextSize} → ${reduced} 重试一次: ${result.error}`)
      cfg = buildCfg(cfg.gpuLayers, reduced, 'gpu')
      result = await tandemManager.startServer(cfg)
    }

    // 降档重试 2：GPU 仍失败 → 降档纯 CPU
    if (!result.success && cfg.mode === 'gpu') {
      logger.warn(`[Scheduler] ${modelId} GPU 启动失败，降档纯 CPU 重试一次: ${result.error}`)
      cfg = buildCfg(0, 4096, 'cpu')
      result = await tandemManager.startServer(cfg)
    }

    const elapsed = Date.now() - start
    if (!result.success) {
      return {
        ok: false,
        attempt: { modelId, modelName: reg.name, gpuLayers: cfg.gpuLayers, device: cfg.mode, status: 'failed', elapsedMs: elapsed, error: result.error || '启动失败' },
        error: result.error || '启动失败',
      }
    }
    return {
      ok: true,
      attempt: { modelId, modelName: reg.name, gpuLayers: cfg.gpuLayers, device: cfg.mode, status: 'running', elapsedMs: elapsed },
    }
  }

  /* ============================================================
   * 调度主入口（选模型→加载→推理→回退）
   * ============================================================ */

  async run(text: string, opts?: { taskType?: TaskClassifyResult['taskType']; temperature?: number; maxTokens?: number }): Promise<SchedulerRunResult> {
    const ts = Date.now()
    const attempts: ScheduleAttempt[] = []
    const fallbackChain: string[] = []

    if (this.config.enabled === false) {
      // 调度关闭：直接用注册表默认主模型
      const def = modelRegistry.getDefault?.() || modelRegistry.list().find(m => m.type === 'main')
      if (!def) return { success: false, content: '', elapsedMs: 0, tokensPerSec: 0, decision: null as any, attempts, fallbackChain, error: '未启用调度且无默认模型' }
      const load = await this.ensureLoaded(def.id)
      attempts.push(load.attempt)
      if (!load.ok) return { success: false, content: '', elapsedMs: 0, tokensPerSec: 0, decision: null as any, attempts, fallbackChain, error: load.error }
      fallbackChain.push(def.id)
      try {
        const res = await tandemManager.queryModel(def.id, text, { temperature: opts?.temperature ?? 0.7, maxTokens: opts?.maxTokens ?? 2048 })
        attempts.push({ modelId: def.id, modelName: def.name, gpuLayers: load.attempt.gpuLayers, device: load.attempt.device, status: 'running', elapsedMs: res.elapsedMs, tokensPerSec: res.tokensPerSec, content: res.content })
        return {
          success: true, content: res.content, elapsedMs: res.elapsedMs, tokensPerSec: res.tokensPerSec,
          decision: null as any, attempts, fallbackChain,
          record: this.buildRecord(text, null, attempts, 'success', res.elapsedMs, res.tokensPerSec, res.content, fallbackChain),
        }
      } catch (e: any) {
        return { success: false, content: '', elapsedMs: 0, tokensPerSec: 0, decision: null as any, attempts, fallbackChain, error: e.message }
      }
    }

    // 正常调度路径
    let decision: ScheduleDecision
    try {
      decision = await this.decide(text, opts?.taskType)
    } catch (e: any) {
      return { success: false, content: '', elapsedMs: 0, tokensPerSec: 0, decision: null as any, attempts, fallbackChain, error: e.message }
    }

    this.broadcast('decision', decision)

    const hw = await getHardware()
    const chain = [...decision.candidates]
    let lastError = ''
    // 常驻换载跟踪：本次是否换载过 GPU 模型（目标 ≠ 常驻主力）
    let usedSwap = false
    // 云端补救结果（本地全失败后触发）
    const residentCfg = this.config.resident
    const residentModelId = residentCfg?.residentModelId || ''

    for (let i = 0; i < chain.length; i++) {
      const modelId = chain[i]
      if (this.inflight.has(modelId)) {
        fallbackChain.push(modelId)
        lastError = `${modelId} 正在启动中，跳过`
        attempts.push({ modelId, modelName: modelId, gpuLayers: 0, device: 'cpu', status: 'failed', elapsedMs: 0, error: lastError })
        continue
      }
      this.inflight.add(modelId)
      fallbackChain.push(modelId)

      const load = await this.ensureLoaded(modelId, hw)
      attempts.push(load.attempt)
      if (!load.ok) {
        lastError = load.error || '加载失败'
        this.inflight.delete(modelId)
        this.broadcast('attempt', attempts[attempts.length - 1])
        continue
      }

      this.broadcast('attempt', load.attempt)

      try {
        const res = await tandemManager.queryModel(modelId, text, {
          temperature: opts?.temperature ?? 0.7,
          maxTokens: opts?.maxTokens ?? 2048,
        })
        attempts.push({ modelId, modelName: load.attempt.modelName, gpuLayers: load.attempt.gpuLayers, device: load.attempt.device, status: 'running', elapsedMs: res.elapsedMs, tokensPerSec: res.tokensPerSec, content: res.content })
        // 换载检测：本次用的 GPU 模型不是常驻主力
        if (load.attempt.device === 'gpu' && residentModelId && modelId !== residentModelId) {
          usedSwap = true
        }
        const status = i > 0 ? 'fallback' : 'success'
        const record = this.buildRecord(text, decision, attempts, status, res.elapsedMs, res.tokensPerSec, res.content, fallbackChain.slice(0, i + 1))
        record.usedSwap = usedSwap
        this.pushHistory(record)
        this.broadcast('record', record)
        this.inflight.delete(modelId)
        // 单模型常驻换载：任务完成（成功）后切回常驻主力，释放显存
        await this.restoreResident(usedSwap, modelId)
        return {
          success: true,
          content: res.content,
          elapsedMs: res.elapsedMs,
          tokensPerSec: res.tokensPerSec,
          decision,
          attempts,
          fallbackChain,
          record,
        }
      } catch (e: any) {
        lastError = e.message
        attempts.push({ modelId, modelName: load.attempt.modelName, gpuLayers: load.attempt.gpuLayers, device: load.attempt.device, status: 'failed', elapsedMs: 0, error: e.message })
        this.inflight.delete(modelId)
        this.broadcast('attempt', attempts[attempts.length - 1])
        logger.warn(`[Scheduler] 模型 ${modelId} 推理失败，尝试下一个候选: ${e.message}`)
      }
    }

    // 本地全部失败：尝试云端补救（复杂任务 + 云端已配置 + 配额未耗尽）
    const cloudCfg = this.config.cloud
    let cloudError = ''
    const cloudProviderReady = resolveCloudProviderConfig(cloudCfg?.providerId) !== null
    const cloudCandidate = !!(cloudCfg?.enabled && cloudProviderReady && isComplexForCloud(decision.taskType, text.length, cloudCfg))
    if (cloudCandidate) {
      const cloudRes = await callCloud({
        text,
        cloud: cloudCfg!,
        temperature: opts?.temperature ?? 0.7,
        maxTokens: opts?.maxTokens ?? 2048,
      })
      if (cloudRes.success) {
        const record = this.buildRecord(text, decision, attempts, 'success', cloudRes.elapsedMs || 0, cloudRes.tokensPerSec || 0, cloudRes.content || '', [...fallbackChain, `cloud:${cloudRes.providerId}/${cloudRes.modelId}`])
        record.usedCloud = true
        record.cloudProviderId = cloudRes.providerId
        this.pushHistory(record)
        this.broadcast('record', record)
        return {
          success: true,
          content: cloudRes.content || '',
          elapsedMs: cloudRes.elapsedMs || 0,
          tokensPerSec: cloudRes.tokensPerSec || 0,
          decision,
          attempts,
          fallbackChain,
          record,
          usedCloud: true,
          cloudProviderId: cloudRes.providerId,
        }
      }
      cloudError = cloudRes.reason || '云端调用失败'
      // 云端失败：自动降级回本地（本地已尝试过失败，这里不再重复启动，保证离线可用性报告完整）
      lastError = `本地模型全部失败；云端补救失败：${cloudError}`
    }

    // 全部失败：记录并返回
    const record = this.buildRecord(text, decision, attempts, 'failed', 0, 0, '', fallbackChain)
    record.usedCloud = false
    this.pushHistory(record)
    this.broadcast('record', record)
    return {
      success: false,
      content: '',
      elapsedMs: Date.now() - ts,
      tokensPerSec: 0,
      decision,
      attempts,
      fallbackChain,
      error: lastError || '所有候选模型均失败',
      record,
      usedCloud: false,
    }
  }

  /**
   * 单模型常驻换载恢复：任务成功完成后，若曾换载 GPU 模型（非常驻主力），
   * 停掉该模型并切回常驻主力，释放显存。失败不抛异常（换载是增强能力，不影响主流程）。
   */
  private async restoreResident(usedSwap: boolean, currentModelId: string): Promise<void> {
    const cfg = this.config.resident
    if (!cfg?.restoreAfterTask || !usedSwap || !cfg.residentModelId) return
    if (currentModelId === cfg.residentModelId) return
    try {
      const reg = modelRegistry.list().find(m => m.id === cfg.residentModelId)
      if (!reg) {
        logger.warn(`[Scheduler] 常驻主力 ${cfg.residentModelId} 未注册，跳过恢复`)
        return
      }
      // 先停掉当前 GPU 模型（释放显存），再切回常驻主力
      logger.info(`[Scheduler] 任务完成，切回常驻主力 ${cfg.residentModelId}（释放 ${currentModelId}）`)
      const states = tandemManager.getServerStates()
      for (const s of states) {
        if (s.modelId === currentModelId && (s.status === 'running' || s.status === 'starting')) {
          await tandemManager.stopServer(currentModelId)
        }
      }
      if (cfg.swapEnabled) {
        await this.ensureLoaded(cfg.residentModelId)
      }
    } catch (e: any) {
      logger.warn(`[Scheduler] 恢复常驻主力失败（不影响本次结果）: ${e.message}`)
    }
  }

  private buildRecord(
    text: string,
    decision: ScheduleDecision | null,
    attempts: ScheduleAttempt[],
    status: 'success' | 'fallback' | 'failed',
    elapsedMs: number,
    tokensPerSec: number,
    content: string,
    fallbackChain: string[],
  ): ScheduleRecord {
    const successAttempt = [...attempts].reverse().find(a => a.status === 'running')
    return {
      id: randomUUID(),
      ts: Date.now(),
      request: text.slice(0, 120),
      taskType: decision?.taskType ?? 'chat',
      classifyConfidence: decision?.classify.confidence ?? 0,
      evidence: decision?.classify.evidence ?? [],
      modelId: successAttempt?.modelId || decision?.modelId || '',
      modelName: successAttempt?.modelName || decision?.modelName || '',
      reason: decision?.reason || '调度关闭，使用默认模型',
      device: successAttempt?.device ?? 'cpu',
      gpuLayers: successAttempt?.gpuLayers ?? 0,
      elapsedMs,
      tokensPerSec,
      status,
      fallbackChain,
      contentPreview: content.slice(0, 200),
    }
  }

  /* ============================================================
   * 历史记录（electron-store 持久化）
   * ============================================================ */

  getHistory(): ScheduleRecord[] {
    try {
      return this.getStore().get(HISTORY_KEY, []) as ScheduleRecord[]
    } catch {
      return []
    }
  }

  private pushHistory(record: ScheduleRecord): void {
    try {
      const store = this.getStore()
      const list = [record, ...(store.get(HISTORY_KEY, []) as ScheduleRecord[])]
      const trimmed = list.slice(0, this.config.historyLimit || 50)
      store.set(HISTORY_KEY, trimmed)
      this.broadcast('history', trimmed)
    } catch (e) {
      logger.error('[Scheduler] pushHistory 失败:', e)
    }
  }

  clearHistory(): void {
    try {
      this.getStore().set(HISTORY_KEY, [])
      this.broadcast('history', [])
    } catch (e) {
      logger.error('[Scheduler] clearHistory 失败:', e)
    }
  }

  /* ============================================================
   * 广播（前端实时刷新）
   * ============================================================ */

  private broadcast(type: string, payload: unknown): void {
    try {
      sendToAllWindows(`scheduler:update`, { type, payload })
    } catch (e) {
      logger.debug(`[Scheduler] broadcast ${type} 失败:`, e)
    }
  }
}

export const scheduler = new Scheduler()
