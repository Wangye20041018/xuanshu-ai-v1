/**
 * nomic-embed 嵌入器（v1.0）
 *
 * 通过 llama-cpp-python 的 embedding API 调用 nomic-embed，
 * 使用 Python 子进程模式，支持单条和批量嵌入。
 *
 * 模型路径：APP resources/models/nomic-embed.gguf
 */

import { app } from 'electron'
import { join } from 'path'
import { spawn, SpawnOptions } from 'child_process'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { EmbeddingVector, EmbedderConfig } from './types'
import { logger } from '../../shared/logger'

/**
 * spawnSafe — 中文路径安全的 spawn 封装
 * 参见 runtime/python.ts 中的同名函数说明。
 */
function spawnSafe(
  command: string,
  args: string[],
  options?: { timeout?: number }
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const spawnOpts: SpawnOptions = { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
    const child = spawn(command, args, spawnOpts)
    const timer = options?.timeout
      ? setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`spawnSafe 超时 (${options.timeout}ms)`)) }, options.timeout)
      : null
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (data: Buffer) => { stdout += data.toString('utf-8') })
    child.stderr?.on('data', (data: Buffer) => { stderr += data.toString('utf-8') })
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(stderr || `Exit code: ${code}`))
    })
    child.on('error', (err) => { if (timer) clearTimeout(timer); reject(err) })
  })
}

/**
 * 默认 nomic-embed 模型路径（APP 内置 resources 目录）。
 * 惰性求值：仅在首次真正使用时才访问 app.getAppPath()，
 * 避免模块加载时触发 Electron API / 磁盘写入副作用（如单元测试导入）。
 */
function resolveDefaultEmbedModelPath(): string {
  const resourcesDir = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'resources')
  return join(resourcesDir, 'models', 'nomic-embed.gguf')
}

/** 确保 resources/models 目录存在，否则创建占位 README（惰性调用，仅在 initialize 时执行） */
function ensureModelsDir(): void {
  const resourcesDir = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'resources')
  const modelsDir = join(resourcesDir, 'models')
  if (!existsSync(modelsDir)) {
    mkdirSync(modelsDir, { recursive: true })
    writeFileSync(
      join(modelsDir, 'README.txt'),
      '此目录用于存放嵌入模型文件。\n' +
      '请将 nomic-embed.gguf 模型文件放入此目录。\n' +
      '下载地址：https://huggingface.co/nomic-ai/nomic-embed-text-v1.5-GGUF\n',
      'utf-8'
    )
    logger.debug('[NomicEmbedder] 已创建 resources/models 占位目录')
  }
}

const DEFAULT_DIMENSIONS = 768
const DEFAULT_MAX_BATCH = 32

/** 余弦相似度 */
export function cosineSimilarity(a: EmbeddingVector, b: EmbeddingVector): number {
  if (a.length !== b.length) throw new Error(`向量维度不匹配: ${a.length} vs ${b.length}`)
  let dot = 0, normA = 0, normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom === 0 ? 0 : dot / denom
}

export class NomicEmbedder {
  private config: EmbedderConfig
  private pythonPath: string
  private initialized: boolean = false

  constructor(config?: Partial<EmbedderConfig>) {
    // 模型路径惰性求值：仅在首次使用时才访问 app.getAppPath()，
    // 避免模块加载（单例实例化）时触发 Electron API 副作用。
    this.config = {
      modelPath: config?.modelPath || '',
      dimensions: config?.dimensions || DEFAULT_DIMENSIONS,
      maxBatchSize: config?.maxBatchSize || DEFAULT_MAX_BATCH,
    }
    this.pythonPath = 'python'
  }

  /** 设置 Python 解释器路径（由外部注入，如 pythonRuntime.getPythonPath()） */
  setPythonPath(path: string): void {
    this.pythonPath = path
  }

  /** 解析实际模型路径（未显式指定时回退到 APP 内置 resources 目录） */
  private getModelPath(): string {
    return this.config.modelPath || resolveDefaultEmbedModelPath()
  }

  /** 初始化：验证模型文件存在 */
  async initialize(): Promise<boolean> {
    if (this.initialized) return true
    // 惰性创建 resources/models 占位目录（仅首次真正使用时才写磁盘）
    ensureModelsDir()
    const modelPath = this.getModelPath()
    if (!existsSync(modelPath)) {
      logger.error(`[NomicEmbedder] 模型文件不存在: ${modelPath}`)
      return false
    }
    // 快速验证 Python 可用（spawnSafe 避免中文路径被 cmd.exe GBK 编码乱码）
    try {
      await spawnSafe(this.pythonPath, ['-c', 'print(1)'], { timeout: 5000 })
    } catch {
      logger.error('[NomicEmbedder] Python 不可用')
      return false
    }
    this.initialized = true
    logger.debug(`[NomicEmbedder] 初始化完成，模型: ${modelPath}`)
    return true
  }

  /**
   * 单条文本嵌入
   */
  async embed(text: string): Promise<EmbeddingVector> {
    const results = await this.batchEmbed([text])
    return results[0]
  }

  /**
   * 批量文本嵌入
   * 通过 Python 子进程一次性完成，避免重复加载模型
   */
  async batchEmbed(texts: string[]): Promise<EmbeddingVector[]> {
    if (!this.initialized) {
      const ok = await this.initialize()
      if (!ok) throw new Error('NomicEmbedder 初始化失败')
    }

    if (texts.length === 0) return []
    if (texts.length > this.config.maxBatchSize * 2) {
      // 分批处理
      const allResults: EmbeddingVector[] = []
      for (let i = 0; i < texts.length; i += this.config.maxBatchSize) {
        const batch = texts.slice(i, i + this.config.maxBatchSize)
        const batchResults = await this._runEmbeddingBatch(batch)
        allResults.push(...batchResults)
      }
      return allResults
    }

    return this._runEmbeddingBatch(texts)
  }

  /**
   * 核心：调用 Python 子进程执行嵌入
   * 通过 JSON 管道传递文本，返回嵌入向量
   */
  private async _runEmbeddingBatch(texts: string[]): Promise<EmbeddingVector[]> {
    // 构建 Python 脚本：使用 llama-cpp-python 的 embedding API
    const pythonScript = `
import sys, json, os
os.environ['LLAMA_CPP_LIB'] = ''  # 防止冲突

from llama_cpp import Llama

model_path = ${JSON.stringify(this.getModelPath())}
texts = ${JSON.stringify(texts)}

try:
    llm = Llama(
        model_path=model_path,
        n_ctx=512,
        embedding=True,
        verbose=False,
        n_gpu_layers=0,  # nomic-embed 仅 137MB，纯 CPU 即可
    )
    results = []
    for text in texts:
        result = llm.create_embedding(text)
        emb = result['data'][0]['embedding']
        results.append(emb)
    print(json.dumps({"status": "ok", "embeddings": results}))
except Exception as e:
    print(json.dumps({"status": "error", "message": str(e)}))
    sys.exit(1)
`.trim()

    try {
      // spawnSafe 直接传参给 CreateProcessW，无需对 Python 脚本做 shell 转义
      const { stdout, stderr } = await spawnSafe(
        this.pythonPath,
        ['-c', pythonScript],
        { timeout: 60000 }
      )

      if (stderr) {
        logger.warn('[NomicEmbedder] stderr:', stderr.slice(0, 500))
      }

      const output = stdout.trim()
      // 找最后一个 JSON 行
      const lines = output.split('\n')
      let jsonLine = ''
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim()
        if (line.startsWith('{')) {
          jsonLine = line
          break
        }
      }

      const result = JSON.parse(jsonLine)
      if (result.status === 'ok') {
        return result.embeddings as EmbeddingVector[]
      }
      throw new Error(`嵌入失败: ${result.message}`)
    } catch (error: any) {
      logger.error('[NomicEmbedder] 嵌入执行失败:', error.message)
      throw error
    }
  }

  /** 获取嵌入配置 */
  getConfig(): EmbedderConfig {
    return { ...this.config, modelPath: this.getModelPath() }
  }
}

/** 单例 */
export const nomicEmbedder = new NomicEmbedder()
