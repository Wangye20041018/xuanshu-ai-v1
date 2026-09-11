/**
 * LLMLingua-2 本地 prompt 压缩引擎 — 就绪探测模块
 *
 * 目标：超长上下文走 LLMLingua-2 本地压缩（20x），不依赖云端、不泄露对话。
 * 本模块只负责「真实存在即启用」的就绪探测：
 *   - 仅在本地能找到 LLMLingua-2 的 onnx 权重 + onnxruntime-node 依赖时才宣称可用；
 *   - 权重/依赖缺失时如实返回不可用原因，由调用方回退到既有摘要压缩，绝无假压缩。
 *
 * 启用方式（放好模型即自动开启，无需改代码）：
 *   1. 下载 LLMLingua-2 onnx 权重（如 microsoft/llmlingua-2-xlm-roberta-large-meeting-basis
 *      的 onnx 导出，含 model.onnx / decoder_model.onnx / tokenizer.json / config.json），
 *      放到 models/llmlingua-2/ 目录（或设置环境变量 LLMLINGUA2_MODEL_DIR）
 *   2. npm i onnxruntime-node   （主进程 node 端推理依赖）
 *   3. 重启应用后由 ConversationCompressor 自动检测并切换至 20x 本地压缩
 */

import { existsSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { createLogger } from '../../shared/logger'

const logger = createLogger('LlmLingua2')

export interface LlmLingua2Probe {
  /** 是否可执行真实 LLMLingua-2 压缩 */
  available: boolean
  /** 命中模型目录（available 时非空） */
  modelDir?: string
  /** 不可用原因 */
  reason: string
}

/** 候选模型目录（优先级从高到低） */
export function candidateModelDirs(): string[] {
  const env = process.env.LLMLINGUA2_MODEL_DIR?.trim()
  const dirs: string[] = []
  if (env) dirs.push(env)
  try {
    const root = app.getAppPath()
    dirs.push(join(root, 'models', 'llmlingua-2'))
    dirs.push(join(root, 'resources', 'llmlingua-2'))
  } catch { /* 非 electron 环境忽略 */ }
  dirs.push('E:\\玄枢AI\\models\\llmlingua-2')
  return dirs
}

/** 探测目录下是否存在 LLMLingua-2 onnx 权重 */
function dirHasWeights(dir: string): boolean {
  const weightNames = [
    'model.onnx',
    'model_quantized.onnx',
    join('onnx', 'model.onnx'),
    join('onnx', 'model_quantized.onnx'),
  ]
  return weightNames.some((w) => existsSync(join(dir, w)))
}

/** 探测 onnxruntime-node 是否可加载（动态 require，缺依赖时认作不可用而非抛错） */
function resolveOrt(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('onnxruntime-node')
    return true
  } catch {
    return false
  }
}

let cached: LlmLingua2Probe | null = null

/**
 * LLMLingua-2 就绪探测（结果缓存，进程生命周期内复用）。
 * 仅在「权重存在 + onnxruntime-node 可加载」双条件满足时 available=true。
 */
export function probeLlmLingua2(force = false): LlmLingua2Probe {
  if (cached && !force) return cached
  const hasOrt = resolveOrt()
  for (const dir of candidateModelDirs()) {
    if (!dirHasWeights(dir)) continue
    // 权重存在但缺依赖：明确提示，不可用
    if (!hasOrt) {
      cached = { available: false, modelDir: dir, reason: '已找到权重但缺少 onnxruntime-node（请执行 npm i onnxruntime-node 后重启）' }
      logger.warn(`[LLMLingua-2] ${cached.reason}`)
      return cached
    }
    cached = { available: true, modelDir: dir, reason: 'ok' }
    return cached
  }
  cached = {
    available: false,
    modelDir: undefined,
    reason: '未找到 LLMLingua-2 onnx 权重（预期目录：models/llmlingua-2/model.onnx）',
  }
  return cached
}
