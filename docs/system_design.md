# 玄枢AI Phase 2 核心推理引擎 — 深度审计规格

> **审计师**: 高见远（Bob, Architect）
> **审计日期**: 2025-07-16
> **审计范围**: LLM Provider 层、SGLang 引擎、CPU 推理、模型管理、聊天核心、辩论引擎、推理可视化
> **总文件数**: 14 个目标文件

---

## Part A: 审计架构设计

### 1. 审计方法概述

本次审计采用 **"代码静态分析 + 风险建模"** 方法：

1. **维度划分**: 将系统划分为 6 个正交审计维度，每个维度独立检查
2. **规则驱动**: 每个维度下设具体检查规则（Check Rule），基于代码实际读取结果定义
3. **风险分级**: 每条规则附带风险等级（🔴致命 / 🟠严重 / 🟡中等 / 🟢轻微）
4. **依赖排序**: 审计维度按依赖关系排序，确保上游维度结论可被下游维度引用

### 2. 审计维度总览

| 编号 | 审计维度 | 目标文件 | 风险重点 |
|------|---------|---------|---------|
| D1 | Provider 生命周期管理 | provider.ts, provider-registry.ts, local-gpu-provider.ts, chat.ipc.ts | 竞态、重复注册、资源泄漏 |
| D2 | SGLang 子进程管理 | sglang.ipc.ts, python.ts, hardware.ts | 僵尸进程、端口冲突、状态不一致 |
| D3 | 显存调度与模型生命周期 | model-manager/index.ts, cpu-engine.ts | 状态机、并发冲突、idle 逻辑 |
| D4 | 流式响应完整性 | chat.ipc.ts, provider.ts (所有 generateStream) | AbortController、done 信号、超时 |
| D5 | 错误降级链 | model-manager/index.ts, chat.ipc.ts, visual-reasoning.ts, cpu-engine.ts | 错误吞噬、回退路径断裂 |
| D6 | 硬件检测与多GPU | hardware.ts, cpu-engine.ts (isGpuAvailable) | 检测覆盖不全、阈值硬编码、双路径不一致 |

### 3. 审计依赖图

```
D1 (Provider 生命周期)
  │
  ├──→ D4 (流式响应完整性)  ← 依赖 Provider 注册状态
  │
D2 (SGLang 子进程管理)
  │
  ├──→ D3 (显存调度)        ← 依赖 SGLang 启停
  ├──→ D5 (错误降级链)     ← 依赖 SGLang 健康检查
  │
D6 (硬件检测)
  │
  ├──→ D3 (显存调度)        ← 依赖 VRAM 信息
  └──→ D5 (错误降级链)     ← 依赖 GPU 可用性判断
```

**审计顺序**: D1 → D2 → D6 → D3 → D4 → D5

---

## Part B: 逐维度审计规则

---

### D1: Provider 生命周期管理

#### D1.1 审计目标文件
- `E:\开发\src\main\llm\provider.ts` (LLMProvider 接口 + 5 个实现类)
- `E:\开发\src\main\llm\provider-registry.ts` (ProviderRegistry 单例)
- `E:\开发\src\main\llm\local-gpu-provider.ts` (LocalGPUProvider)
- `E:\开发\src\main\ipc\chat.ipc.ts` (ensureLocalProvider 调用者)

#### D1.2 代码现状分析

**已发现的风险点：**

1. **重复注册无防御** (`provider-registry.ts:7-9`)
   - `registerProvider()` 使用 `Map.set()` ，静默覆盖同 ID 的旧 Provider
   - 旧 Provider 不会被清理（如 HTTP 连接、reader 未释放）
   - 风险等级：🔴 致命

2. **ensureLocalProvider 每次调用都重新创建** (`chat.ipc.ts:30-68`)
   - 每次 `chat:send` 都可能调用 `ensureLocalProvider()`
   - 使用固定 ID（`__local_sglang__`、`__local_cpu__`、`__local_gpu__`）创建新 Provider
   - 旧 Provider 被覆盖但资源未释放
   - 风险等级：🟠 严重

3. **Provider 无析构/清理生命周期** (`provider.ts:11-23`)
   - `LLMProvider` 接口无 `dispose()` / `destroy()` 方法
   - SGLangProvider、OpenAIProvider 的 fetch 连接无主动关闭机制
   - 风险等级：🟠 严重

4. **LocalGPUProvider 继承 LocalCPUProvider** (`local-gpu-provider.ts:11`)
   - 仅覆盖 `type` 字段，所有行为继承自 LocalCPUProvider
   - `ensureLoaded()` 延迟 require 可能抛出，但无类型安全保障
   - 风险等级：🟡 中等

5. **ProviderRegistry.removeProvider 无副作用清理** (`provider-registry.ts:80-82`)
   - 仅从 Map 中 delete，不调用任何清理逻辑
   - 风险等级：🟡 中等

#### D1.3 检查规则

| 规则ID | 规则描述 | 风险 |
|--------|---------|------|
| D1-R1 | `registerProvider` 是否在覆盖前检查 `has()` 并拒绝或先清理旧实例？ | 🔴 |
| D1-R2 | `ensureLocalProvider` 是否检查 Provider 已存在从而避免重复创建？ | 🟠 |
| D1-R3 | `LLMProvider` 接口是否提供 `dispose()` 方法用于资源释放？ | 🟠 |
| D1-R4 | 所有 Provider 实现类是否在 `removeProvider` 或覆盖时被正确清理？ | 🟠 |
| D1-R5 | `LocalGPUProvider` 是否与 `LocalCPUProvider` 有清晰的语义差异，而不是仅覆盖 `type`？ | 🟡 |
| D1-R6 | Provider 切换（如 SGLang→CPU）是否先注销旧 Provider 再注册新的？ | 🟡 |
| D1-R7 | Provider 的 `generateStream` 是否在 Provider 被注销后仍可能被调用（悬垂引用）？ | 🟠 |
| D1-R8 | `hasProvider()` 是否在 chat:send 前用于验证 Provider 有效性？ | 🟡 |

#### D1.4 审计检查点（代码位置）

```
[检查点 D1-C1] provider-registry.ts:7-9     — registerProvider 覆盖逻辑
[检查点 D1-C2] chat.ipc.ts:30-68            — ensureLocalProvider 重复创建
[检查点 D1-C3] provider.ts:11-23            — LLMProvider 接口缺少 dispose
[检查点 D1-C4] provider-registry.ts:80-82   — removeProvider 无清理
[检查点 D1-C5] provider-registry.ts:19-78   — createProvider 工厂方法
[检查点 D1-C6] local-gpu-provider.ts:11-18  — LocalGPUProvider 继承关系
[检查点 D1-C7] chat.ipc.ts:116-118          — 外部 Provider 获取逻辑
```

---

### D2: SGLang 子进程管理

#### D2.1 审计目标文件
- `E:\开发\src\main\ipc\sglang.ipc.ts` (SGLang IPC handlers + 启停逻辑)
- `E:\开发\src\main\runtime\python.ts` (Python 运行时管理)
- `E:\开发\src\main\runtime\hardware.ts` (硬件检测)

#### D2.2 代码现状分析

**已发现的风险点：**

1. **重复启动无防护** (`sglang.ipc.ts:119-216`)
   - `startSGLangWithModel()` 不检查 `sglangProcess` 是否已存在
   - 如果并发调用，会创建第二个子进程，旧进程泄漏
   - `sglang:start` handler 有检查 `sglangProcess && sglangReady`，但 `startSGLangServer()` 导出函数也有类似检查——两个入口的检查不一致
   - 风险等级：🔴 致命

2. **stopSGLang 竞态条件** (`sglang.ipc.ts:475-519`)
   - 先将 `sglangProcess = null`（行480），再等待 kill 完成
   - 如果在 kill 等待期间（10s timeout）另一个调用检查 `sglangProcess`，会认为已停止
   - 风险等级：🔴 致命

3. **端口冲突检测不充分** (`sglang.ipc.ts:104-116`)
   - `checkPort()` 只检查 `/health` 返回状态 < 500
   - 不验证响应内容是否确实是 SGLang 服务（可能是其他 HTTP 服务占用 30000 端口）
   - 风险等级：🟠 严重

4. **WSL 僵尸进程风险** (`sglang.ipc.ts:512-518`)
   - WSL 模式下的 `pkill -f sglang.launch_server` 可能在 `wsl.exe` 不可用时静默失败
   - 如果 SIGTERM 成功但 WSL pkill 失败（WSL 本身挂了），Linux 进程残留
   - 风险等级：🟠 严重

5. **进程 unref 导致孤儿进程** (`sglang.ipc.ts:161`)
   - `sglangProcess.unref()` 使父进程退出时不等待子进程
   - 如果 Electron 崩溃，SGLang 子进程成为孤儿继续占用显存
   - 风险等级：🟡 中等

6. **健康检查轮询效率** (`sglang.ipc.ts:197-210`)
   - 固定 2 秒轮询间隔，最长 120 秒
   - 如果 SGLang 已崩溃但端口仍被占用，会等到超时
   - 不检查 stderr 中的错误关键字（如 CUDA OOM）
   - 风险等级：🟡 中等

7. **Python 运行时心跳与 SGLang 进程独立** (`python.ts:51-72`)
   - Python 心跳只检查 `python -c "print('ok')"`，不检查 SGLang 子进程健康
   - SGLang 崩溃不会触发 Python 运行时重启
   - 风险等级：🟡 中等

8. **sglangModelPath 全局状态未同步** (`sglang.ipc.ts:24`)
   - `sglangModelPath` 是模块级变量，IPC handler 和导出函数都直接修改
   - `sglang:start` 设置的 `sglangModelPath` 可能与 `startSGLangServer()` 设置的冲突
   - 风险等级：🟡 中等

#### D2.3 检查规则

| 规则ID | 规则描述 | 风险 |
|--------|---------|------|
| D2-R1 | 启动前是否检查已有进程并正确清理？ | 🔴 |
| D2-R2 | stopSGLang 是否先将状态置空再等 kill，形成 TOCTOU 窗口？ | 🔴 |
| D2-R3 | 端口 30000 被非 SGLang 服务占用时，是否被正确检测？ | 🟠 |
| D2-R4 | WSL 模式下 pkill 回收失败是否有兜底方案？ | 🟠 |
| D2-R5 | SGLang 崩溃（非正常退出）时，显存是否被正确释放？ | 🟠 |
| D2-R6 | Electron 崩溃/强制退出时，SGLang 子进程是否成为孤儿？ | 🟡 |
| D2-R7 | 启动超时等待期间是否监控 stderr 中的 FATAL/OOM 关键字以快速失败？ | 🟡 |
| D2-R8 | sglang:start / startSGLangServer 两个入口是否有统一的并发保护？ | 🟡 |
| D2-R9 | sglangModelPath 的读写是否有并发保护？ | 🟡 |

#### D2.4 审计检查点（代码位置）

```
[检查点 D2-C1] sglang.ipc.ts:119-154        — startSGLangWithModel 无进程存在检查
[检查点 D2-C2] sglang.ipc.ts:475-519        — stopSGLang 竞态窗口
[检查点 D2-C3] sglang.ipc.ts:256-280        — sglang:start handler 的重复启动防护
[检查点 D2-C4] sglang.ipc.ts:522-535        — startSGLangServer 导出函数
[检查点 D2-C5] sglang.ipc.ts:104-116        — checkPort 实现
[检查点 D2-C6] sglang.ipc.ts:161            — process.unref()
[检查点 D2-C7] sglang.ipc.ts:197-210        — 健康检查轮询循环
[检查点 D2-C8] sglang.ipc.ts:512-518        — WSL pkill 回收
[检查点 D2-C9] python.ts:51-98              — 心跳检测与 SGLang 解耦
[检查点 D2-C10] python.ts:577-619           — WSL 环境探测
```

---

### D3: 显存调度与模型生命周期

#### D3.1 审计目标文件
- `E:\开发\src\main\model-manager\index.ts` (ModelManager 核心)
- `E:\开发\src\main\inference\cpu-engine.ts` (CpuInferenceEngine)
- `E:\开发\src\main\ipc\sglang.ipc.ts` (stopSGLang/startSGLangServer)

#### D3.2 代码现状分析

**已发现的风险点：**

1. **三态状态机缺乏原子性** (`model-manager/index.ts:95, 962-966`)
   - `gpuModelType` 在 `loadModel`、`swapToQuality`、`swapToMain` 等多处被修改
   - 无锁/互斥机制，并发调用可能导致状态不一致
   - 例如：`loadModel` 设置 `gpuModelType = deriveGpuModelType(model)`，但模型加载可能失败，状态未回滚
   - 风险等级：🔴 致命

2. **isGenerating 保护不完整** (`model-manager/index.ts:82, 734-807`)
   - `isGenerating` 仅在 `generateResponse()` 中设置
   - `cleanupUnusedModels()` 检查 `isGenerating`，但不检查 `loadModel()` / `swapToQuality()` 等是否在进行中
   - 如果 cleanup 在 loadModel 的 2 秒 wait 期间触发，可能干扰加载
   - 风险等级：🟠 严重

3. **CpuInferenceEngine 加载前不检查已有模型** (`cpu-engine.ts:140-188`)
   - `loadModel()` 不检查 `this.model` 是否已存在
   - 直接覆盖 `this.model`、`this.context`、`this.session`
   - 旧模型资源泄漏（未调用 `dispose()`）
   - 风险等级：🔴 致命

4. **idle 计时与 lastUsed 更新不同步** (`model-manager/index.ts:146-171`)
   - `cleanupUnusedModels` 使用 `model.lastUsed || currentModel.loadedAt` 作为活动时间
   - 但如果模型从未被使用过（`lastUsed=0`），fallback 到 `loadedAt`
   - `updateModelUsage` 更新 `lastUsed`，但 `resetIdleTimer` 又设置了一个 setTimeout 来 `unloadModel`
   - 存在 `cleanupInterval`（60s 定时）和 `idleTimeout`（15min setTimeout）两套机制并行
   - 风险等级：🟠 严重

5. **swapToMain 中的强制 unload 可能影响其他使用者** (`model-manager/index.ts:908-938`)
   - `swapToMain()` 无条件调用 `cpuInferenceEngine.unload()`，即使当前加载的是不同的模型
   - 如果其他模块（如 visual-reasoning）正在使用 cpuInferenceEngine，会被强制卸载
   - 风险等级：🟠 严重

6. **质量档加载失败时回退逻辑有瑕疵** (`model-manager/index.ts:972-1005`)
   - `swapToQuality` 失败时调用 `loadModel(defaultMainModelId)` 回退
   - 但如果 `defaultMainModelId` 也不可用，系统进入无模型状态
   - 且失败时 `this.gpuModelType` 被设为 `'main'`，与实际状态不符
   - 风险等级：🟡 中等

7. **6GB 显存约束仅软限制** (`model-manager/index.ts:283-292`)
   - `MAX_SGLANG_MODEL_SIZE_MB = 5 * 1024` (5GB) 阈值用于 gate SGLang
   - 但 `model.size` 可能未设置（注册时 size=0 的情况存在于 `scanResourceModels`）
   - `isTooLarge` 使用 `model.size > MAX_SGLANG_MODEL_SIZE_MB * 1024 * 1024` → 当 size=0 时永远为 false
   - 风险等级：🟡 中等

8. **tryCpuLoad 成功后未验证模型功能** (`model-manager/index.ts:190-224`)
   - 只检查 `cpuInferenceEngine.loadModel()` 返回值
   - 不验证模型是否能实际推理（可做一次 smoke test）
   - 风险等级：🟢 轻微

#### D3.3 检查规则

| 规则ID | 规则描述 | 风险 |
|--------|---------|------|
| D3-R1 | gpuModelType 状态转换是否原子？失败时是否回滚？ | 🔴 |
| D3-R2 | CpuInferenceEngine.loadModel 是否在覆盖前 dispose 旧模型？ | 🔴 |
| D3-R3 | 是否有全局互斥锁保护 load/unload/swap 操作的串行化？ | 🟠 |
| D3-R4 | isGenerating 标志是否覆盖所有不应被中断的操作？ | 🟠 |
| D3-R5 | 6GB 约束检查是否对所有模型路径生效（包括 size=0 的情况）？ | 🟡 |
| D3-R6 | idle 计时器（setTimeout）和 cleanupInterval（setInterval）是否会产生竞态？ | 🟠 |
| D3-R7 | swapToMain/cpuInferenceEngine.unload 是否检查调用者身份？ | 🟠 |
| D3-R8 | 质量档回退逻辑是否正确恢复了 gpuModelType？ | 🟡 |
| D3-R9 | model.size 未设置时，加载门控是否有合理默认值？ | 🟡 |

#### D3.4 审计检查点（代码位置）

```
[检查点 D3-C1] model-manager/index.ts:95     — gpuModelType 状态变量
[检查点 D3-C2] model-manager/index.ts:246-326 — loadModel 完整流程
[检查点 D3-C3] model-manager/index.ts:962-966 — deriveGpuModelType
[检查点 D3-C4] cpu-engine.ts:140-188         — CpuInferenceEngine.loadModel
[检查点 D3-C5] model-manager/index.ts:82,734 — isGenerating 标志
[检查点 D3-C6] model-manager/index.ts:146-186 — cleanupUnusedModels + resetIdleTimer
[检查点 D3-C7] model-manager/index.ts:908-938 — swapToMain
[检查点 D3-C8] model-manager/index.ts:972-1005 — swapToQuality 回退
[检查点 D3-C9] model-manager/index.ts:283-292 — 6GB 约束门控
[检查点 D3-C10] model-manager/index.ts:1094-1116 — scanResourceModels (size=0)
```

---

### D4: 流式响应完整性

#### D4.1 审计目标文件
- `E:\开发\src\main\ipc\chat.ipc.ts` (chat:send 流式主逻辑)
- `E:\开发\src\main\llm\provider.ts` (SGLangProvider, OpenAIProvider, AnthropicProvider, OllamaProvider, LocalCPUProvider 的 generateStream)

#### D4.2 代码现状分析

**已发现的风险点：**

1. **流式响应无超时机制** (`chat.ipc.ts:147-154`)
   - `provider.generateStream()` 调用无超时包装
   - 如果 SSE 流卡住（服务器挂起但不关闭连接），`reader.read()` 永远不会 resolve
   - 仅靠 `AbortController` 的用户手动取消
   - 风险等级：🔴 致命

2. **done:true 发送的可靠性** (`chat.ipc.ts:155-159`)
   - `done:true` 在 `finally` 块中发送——这是正确的
   - 但如果 `win?.webContents.send()` 抛出（窗口已关闭），done 信号丢失
   - 渲染进程可能永远等待 `done:true`
   - 风险等级：🟡 中等

3. **AbortController 泄漏路径** (`chat.ipc.ts:140-185`)
   - 正常路径：`finally` 中 `streamAbortControllers.delete(sessionId)` ✓
   - 异常路径：外层 `catch` 也执行 `streamAbortControllers.delete(sessionId)` ✓
   - 但如果在 `finally` 和 `catch` 之间（`return { success: true, content: fullResponse }`），没有额外风险
   - 风险等级：🟢 轻微

4. **SGLangProvider generateStream 中 signal.aborted 检查时机** (`provider.ts:76-98`)
   - 在 `while(true)` 循环中，先 `await reader.read()` 再检查 `signal.aborted`
   - 如果在 `reader.read()` 阻塞期间 abort，需要等到 read 返回才能检测
   - 使用 `reader.cancel()` + `signal.addEventListener('abort', ...)` 可以更及时
   - 风险等级：🟡 中等

5. **LocalCPUProvider generateStream 的 EventEmitter 泄漏** (`provider.ts:348-376`)
   - `cpuInferenceEngine.on('token', handler)` 注册监听器
   - `finally` 中 `removeListener` 移除
   - 但如果 `cpuInferenceEngine.generate()` 抛出且 `finally` 未执行（极端情况），监听器残留
   - 风险等级：🟡 中等

6. **SSE 解析的健壮性差异**（跨 Provider 比较）
   - SGLangProvider：检查 `data: [DONE]` ✓，JSON parse catch ✓
   - OpenAIProvider：检查 `data: [DONE]` ✓，JSON parse catch ✓
   - AnthropicProvider：检查 `message_stop` type ✓，JSON parse catch ✓
   - OllamaProvider：检查 `data.done` ✓，JSON parse catch ✓
   - LocalCPUProvider：完全不同的机制（EventEmitter），无 done 语义
   - **所有 Provider 的 SSE 解析都在 catch 中只 console.error，不向上传播**
   - 风险等级：🟡 中等

7. **reader.releaseLock 异常处理**（跨 Provider 比较）
   - 所有 Provider 的 `finally` 中都有 `try { reader.releaseLock() } catch`
   - 但如果 `reader` 本身就是 null/undefined，`reader.releaseLock` 会抛 TypeError 被 catch 吞掉
   - 风险等级：🟢 轻微

#### D4.3 检查规则

| 规则ID | 规则描述 | 风险 |
|--------|---------|------|
| D4-R1 | generateStream 是否有超时机制防止流卡死？ | 🔴 |
| D4-R2 | done:true 信号在任何异常路径下是否都会被发送？ | 🟡 |
| D4-R3 | AbortController 在所有代码路径下是否都被清理？ | 🟠 |
| D4-R4 | 多会话的 AbortController 是否严格隔离（sessionId 唯一性）？ | 🟠 |
| D4-R5 | SSE reader 在 abort 时是否通过 reader.cancel() 立即中断？ | 🟡 |
| D4-R6 | LocalCPUProvider 的 EventEmitter 监听器是否保证被移除？ | 🟡 |
| D4-R7 | 各 Provider 的 SSE 解析失败是否会导致流中断？ | 🟡 |

#### D4.4 审计检查点（代码位置）

```
[检查点 D4-C1] chat.ipc.ts:147-154           — generateStream 无超时包装
[检查点 D4-C2] chat.ipc.ts:155-159           — done:true 发送
[检查点 D4-C3] chat.ipc.ts:140-141,157,183   — AbortController 生命周期
[检查点 D4-C4] chat.ipc.ts:25-27             — getSessionId 唯一性
[检查点 D4-C5] provider.ts:76-98             — SGLang SSE 流处理
[检查点 D4-C6] provider.ts:144-178           — OpenAI SSE 流处理
[检查点 D4-C7] provider.ts:236-291           — Anthropic SSE 流处理
[检查点 D4-C8] provider.ts:348-376           — LocalCPU EventEmitter 流处理
[检查点 D4-C9] provider.ts:415-447           — Ollama SSE 流处理
```

---

### D5: 错误降级链

#### D5.1 审计目标文件
- `E:\开发\src\main\model-manager\index.ts` (loadModel 降级路径)
- `E:\开发\src\main\ipc\chat.ipc.ts` (taskRouter + ensureLocalProvider)
- `E:\开发\src\main\inference\visual-reasoning.ts` (invokeModel 降级)
- `E:\开发\src\main\inference\cpu-engine.ts` (CpuInferenceEngine)

#### D5.2 代码现状分析

**已发现的风险点：**

1. **SGLang→CPU 降级时错误信息丢失** (`model-manager/index.ts:272-317`)
   - SGLang 启动失败 → 直接 `tryCpuLoad`，不记录 SGLang 失败的根因
   - CPU 失败 → 返回 false，但用户不知道是两段都失败了
   - 风险等级：🟠 严重

2. **taskRouter.route 异常被静默吞噬** (`chat.ipc.ts:121-126`)
   - `await taskRouter.route(signal)` 的异常只 `console.warn`
   - 路由失败（如模型切换失败）不影响后续流程——可能用错误模型回答
   - 风险等级：🟠 严重

3. **visual-reasoning 终极回退掩盖真实错误** (`visual-reasoning.ts:297-335`)
   - SGLang 失败 → CPU 失败 → 返回硬编码 `{ action: 'screenshot', reason: '等待模型就绪', confidence: 0.3 }`
   - 调用者无法区分"模型暂时不可用"和"推理引擎崩溃"
   - 风险等级：🟠 严重

4. **ensureLocalProvider 的三层回退均不保留错误** (`chat.ipc.ts:30-68`)
   - SGLang 检测失败 → 吞掉错误
   - CPU 模型检查失败 → 吞掉错误
   - 最终返回 null 时，调用者只知道"没有 provider"，不知道为什么
   - 风险等级：🟡 中等

5. **ModelManager.generateResponse 的异常处理过于宽泛** (`model-manager/index.ts:733-808`)
   - catch 返回 `[推理失败：模型未就绪，请先在模型页面加载模型]`
   - 但可能不是"模型未就绪"而是其他错误（网络超时、OOM等）
   - 错误信息失真
   - 风险等级：🟡 中等

6. **CpuInferenceEngine.generate 无重试机制** (`cpu-engine.ts:193-245`)
   - 如果推理过程中 node-llama-cpp 内部错误，直接抛出
   - 没有针对瞬时错误的重试
   - 风险等级：🟢 轻微

7. **跨模块降级链不透明**
   - chat.ipc → taskRouter → modelManager.loadModel → SGLang/CPU → cpuInferenceEngine
   - 每一层都可能失败，但上层只得到 boolean/success
   - 没有统一的错误聚合机制展示完整降级路径
   - 风险等级：🟡 中等

#### D5.3 检查规则

| 规则ID | 规则描述 | 风险 |
|--------|---------|------|
| D5-R1 | SGLang→CPU 降级时，SGLang 失败原因是否被记录并可供诊断？ | 🟠 |
| D5-R2 | taskRouter 路由失败是否影响 chat:send 的模型选择正确性？ | 🟠 |
| D5-R3 | visual-reasoning 的终极回退是否会掩盖需要用户干预的错误？ | 🟠 |
| D5-R4 | 降级链中每一层的错误信息是否向上聚合传递？ | 🟡 |
| D5-R5 | ModelManager.generateResponse 的错误消息是否准确反映实际失败原因？ | 🟡 |
| D5-R6 | CPU 推理失败后是否有机制通知用户 vs 静默失败？ | 🟡 |

#### D5.4 审计检查点（代码位置）

```
[检查点 D5-C1] model-manager/index.ts:272-317  — SGLang→CPU 降级路径
[检查点 D5-C2] chat.ipc.ts:121-126             — taskRouter 异常处理
[检查点 D5-C3] chat.ipc.ts:30-68               — ensureLocalProvider 降级
[检查点 D5-C4] visual-reasoning.ts:297-335      — invokeModel 三层回退
[检查点 D5-C5] model-manager/index.ts:733-808   — generateResponse 错误处理
[检查点 D5-C6] cpu-engine.ts:193-245            — generate 异常传播
```

---

### D6: 硬件检测与多GPU

#### D6.1 审计目标文件
- `E:\开发\src\main\runtime\hardware.ts` (detectHardware, resolveModelRuntime)
- `E:\开发\src\main\inference\cpu-engine.ts` (isGpuAvailable)

#### D6.2 代码现状分析

**已发现的风险点：**

1. **两套 GPU 检测逻辑不一致** (`hardware.ts:28-58` vs `cpu-engine.ts:79-127`)
   - `hardware.ts/detectHardware()`: 仅 NVIDIA (nvidia-smi)，1.5s 超时，失败返回 fallback
   - `cpu-engine.ts/isGpuAvailable()`: NVIDIA → AMD(ROCm) → DirectX(PowerShell)，5s 超时
   - `model-manager` 使用 `isGpuAvailable()` 判断 GPU 可用性
   - `resolveModelRuntime` 使用 `getHardware()` 的结果——只含 NVIDIA 信息
   - **不一致性**: 如果用户有 AMD GPU，`isGpuAvailable()` 返回 true，但 `getHardware()` 返回 fallback（无 GPU），导致 `resolveModelRuntime` 错误判断
   - 风险等级：🔴 致命

2. **多 GPU 仅取第一行** (`hardware.ts:43-44`, `cpu-engine.ts:87-88`)
   - `detectHardware`: `stdout.trim().split('\n')[0]` — 只读第一个 GPU
   - `isGpuAvailable`: `stdout.trim()` — 同样只读第一行输出
   - 如果第一块 GPU 显存不足但第二块充足，系统会错误判断
   - 风险等级：🟠 严重

3. **VRAM 阈值硬编码** (`hardware.ts:87-124`)
   - `qwen2-vl-7b`: 6144MB 硬编码
   - `quality` tier: 8192MB 硬编码
   - 不随模型实际大小动态计算
   - 风险等级：🟡 中等

4. **nvidia-smi 超时太短** (`hardware.ts:38-41`)
   - 仅 1.5s 超时——在某些系统上 nvidia-smi 首次调用可能需要 2-3s
   - 导致误判"无 GPU"
   - 风险等级：🟡 中等

5. **model.size 与 VRAM 检查脱节** (`hardware.ts:77-125`)
   - `resolveModelRuntime` 不参考 `model.size`
   - 仅依赖硬编码的 `model.id` 和 `model.tier` 判断
   - 新模型（不在已知列表中）一律走 CPU + contextSize=512
   - 风险等级：🟡 中等

6. **GPU 检测结果缓存无失效机制** (`hardware.ts:24`)
   - `cache ??= detectHardware()` — 永久缓存
   - GPU 热插拔、驱动更新后不刷新
   - 应用重启才能重新检测
   - 风险等级：🟡 中等

#### D6.3 检查规则

| 规则ID | 规则描述 | 风险 |
|--------|---------|------|
| D6-R1 | detectHardware 和 isGpuAvailable 的 GPU 检测路径是否一致？ | 🔴 |
| D6-R2 | 多 GPU 场景下是否遍历所有 GPU 取总显存/最大显存？ | 🟠 |
| D6-R3 | VRAM 阈值是否可配置，而非硬编码？ | 🟡 |
| D6-R4 | nvidia-smi 超时是否足够（至少 5s）？ | 🟡 |
| D6-R5 | 新模型（不在硬编码列表）是否有合理的默认 GPU 策略？ | 🟡 |
| D6-R6 | GPU 缓存是否可手动刷新？ | 🟡 |

#### D6.4 审计检查点（代码位置）

```
[检查点 D6-C1] hardware.ts:26               — getHardware 单例缓存
[检查点 D6-C2] hardware.ts:28-58            — detectHardware (仅NVIDIA)
[检查点 D6-C3] cpu-engine.ts:79-127         — isGpuAvailable (NVIDIA+AMD+DX)
[检查点 D6-C4] hardware.ts:43-44            — 多GPU取第一行
[检查点 D6-C5] hardware.ts:87-124           — resolveModelRuntime 硬编码阈值
[检查点 D6-C6] hardware.ts:38-41            — 1.5s 超时
```

---

## Part C: 审计执行计划

### C.1 审计顺序（带依赖关系）

```
Phase 1: 基础设施审计
├── D1: Provider 生命周期管理 (无依赖)
└── D2: SGLang 子进程管理 (无依赖)

Phase 2: 环境审计
└── D6: 硬件检测与多GPU (无依赖，但结果被 D3/D5 使用)

Phase 3: 核心逻辑审计
├── D3: 显存调度与模型生命周期 (依赖 D2 的进程状态结论, D6 的硬件信息)
├── D4: 流式响应完整性 (依赖 D1 的 Provider 注册状态)
└── D5: 错误降级链 (依赖 D2 健康检查, D3 加载状态, D6 GPU 可用性)
```

### C.2 每维度审计步骤

每个维度的审计步骤：
1. **代码走查**: 逐行审阅目标文件，标记所有检查点
2. **控制流分析**: 绘制关键函数的控制流图，识别所有异常路径
3. **状态机验证**: 验证关键状态转换的完整性（如 gpuModelType, sglangReady）
4. **并发分析**: 识别所有异步操作的交错可能性
5. **风险定级**: 根据影响范围和触发概率确定风险等级
6. **修复建议**: 每个问题提供具体修复方案

### C.3 输出格式约定

每个审计发现的输出格式：

```json
{
  "findingId": "D1-F01",
  "dimension": "D1: Provider 生命周期管理",
  "severity": "CRITICAL|HIGH|MEDIUM|LOW",
  "checkpoint": "D1-C1",
  "title": "简短描述（<=80字符）",
  "location": "文件:行号",
  "description": "详细描述问题",
  "reproduction": "触发条件/复现步骤",
  "impact": "影响范围和后果",
  "recommendation": "具体修复建议",
  "codeSnippet": "相关代码片段（如果适用）"
}
```

---

## Part D: 已知问题基线

以下是从代码注释（FIX/Bug#标记）和代码审查中提取的已知问题，审计时应验证这些修复是否生效：

| Bug# | 描述 | 文件 | 状态 |
|------|------|------|------|
| Bug#4 | lastUsed 替代 loadedAt 判断空闲 | model-manager/index.ts:146 | 已标记FIX |
| Bug#10 | checkPort 改用 /health 端点 | sglang.ipc.ts:103 | 已标记FIX |
| Bug#11 | 双重除法修复 | model-manager/index.ts:508 | 已标记FIX |
| Bug#12 | generateResponse 判断 SGLang/CPU 模式 | model-manager/index.ts:731, debate-engine.ts:3 | 已标记FIX |
| Bug#14 | 改用 Map 管理多会话 AbortController | chat.ipc.ts:22 | 已标记FIX |
| Bug#15 | done:true 移到 finally 块 | chat.ipc.ts:156 | 已标记FIX |
| Bug#16 | 使用静态 import 替代 require | chat.ipc.ts:51 | 已标记FIX |
| Bug#17 | 无GPU返回0不返回假数据6144 | model-manager/index.ts:442 | 已标记FIX |
| Bug#19 | unloadModel 加 await | model-manager/index.ts:711 | 已标记FIX |
| Bug#25 | 先注册 exit 监听再 kill | sglang.ipc.ts:483 | 已标记FIX |
| Bug#28 | 删除冗余 require('fs') | model-manager/index.ts:677 | 已标记FIX |
| Bug#29 | 设置 memoryUsage 和 gpuUsage | model-manager/index.ts:189 | 已标记FIX |
| Bug#30 | stderr 环形缓冲 | sglang.ipc.ts:163 | 已标记FIX |
| Bug#32 | 合并后的公共 SGLang 启动函数 | sglang.ipc.ts:118 | 已标记FIX |

---

## Part E: 审计输出物清单

| 文件 | 说明 |
|------|------|
| `docs/system_design.md` | 本文件 — 审计规格定义 |
| `docs/sequence-diagram.mermaid` | 关键流程时序图 |
| `docs/class-diagram.mermaid` | 核心类图 |

最终审计报告将包含：
- 每个维度的完整发现列表（D1-F01 ~ D6-Fxx）
- 跨维度影响分析（一个维度的问题如何影响其他维度）
- 修复优先级排序（P0/P1/P2）
- 回归测试检查清单
