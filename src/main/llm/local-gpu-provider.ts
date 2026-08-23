/**
 * LocalGPUProvider（v10.2，REQ 任务 #4）
 *
 * 质量档（Qwen2-VL-2B）经 node-llama-cpp 全量加载（2B 小模型可完整驻留 GPU）的推理 provider。
 * 复用既有 CpuInferenceEngine（cpu-engine.ts）的进程内推理能力，仅 type 标识为 'localgpu'，
 * 与 'localcpu' 区分（质量态 vs 纯 CPU 回落）。generate/generateStream 逻辑完全由父类提供。
 */

import { LocalCPUProvider } from './provider'

export class LocalGPUProvider extends LocalCPUProvider {
  // 覆盖父类 type 标识，便于 provider 注册表与路由区分质量态
  type = 'localgpu' as const

  constructor(config: { id: string; name: string; modelPath?: string }) {
    super(config)
  }
}
