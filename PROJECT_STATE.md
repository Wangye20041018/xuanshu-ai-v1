---
AIGC:
    Label: "1"
    ContentProducer: 001191440300708461136T1XGW3
    ProduceID: 3c24a5e3a352f921a82f7d3a39c85647_06719cf7a3a811f193c6525400f8a581
    ReservedCode1: UJKwlS9pjQAjm+QmO/thlq7CgIpptKRTDXpeIuqDmG4JWcwCCxyydyqO2WLZz9u8lhftrbgbnN4Nc1DJNY1oHdf9edmPswyBaHScFVEv2bWVAHRc8VtrN444bkWux1D1jL5htIXjjCsCV3OkWosHWD+bOeAUp2X0pkAY9Kb8PHuqSRZC/bmihnHNCA8=
    ContentPropagator: 001191440300708461136T1XGW3
    PropagateID: 3c24a5e3a352f921a82f7d3a39c85647_06719cf7a3a811f193c6525400f8a581
    ReservedCode2: UJKwlS9pjQAjm+QmO/thlq7CgIpptKRTDXpeIuqDmG4JWcwCCxyydyqO2WLZz9u8lhftrbgbnN4Nc1DJNY1oHdf9edmPswyBaHScFVEv2bWVAHRc8VtrN444bkWux1D1jL5htIXjjCsCV3OkWosHWD+bOeAUp2X0pkAY9Kb8PHuqSRZC/bmihnHNCA8=
---

# 玄枢AI 项目状态交接快照

> 用途：新会话 / 新 Agent 读此一页即可无缝接续开发，无需全盘重读代码。
> 生成时间：2026-08-29（会话 conv_19fc04d5bb1_a700da2e3f19）

---

## ① 项目概览

| 项 | 值 |
|---|---|
| 项目根目录 | `E:\玄枢AI\xuanshu-ai-dev` |
| 版本 | `12.3.0`（package.json，`xuanshu-ai`） |
| 技术栈 | Electron 32 + electron-vite + React 18 + Tailwind 4（渲染层）；node-llama-cpp / llama.cpp（推理）；Python（引擎/脚本，玄枢自带 `resources\python\python.exe` 3.12.4 CPU torch） |
| 入口 | `src/main/index.ts`（主进程）；`src/renderer/main.tsx`（渲染层）；构建产物 `out/main/index.js` |
| 命令 | `npm run dev` / `build` / `pack`（经 `scripts/electron-launch.mjs`） |
| 运行硬件 | RTX 3060 Laptop **6GB 显存**（6144 MiB）；玄枢与 Marvis 的 Python 均为 **CPU 版 torch（无 CUDA）** |

---

## ② 模型配置现状

**推理链路**：双引擎并存——
- **tandem-manager**（`src/main/tandem-manager/index.ts`）：spawn llama-server（`resources\llama-server.exe`），端口 8080 起；多模型联动（双答案/搭档/师徒/辩论）；**实际主流引擎**，`activeProvider = __local_tandem__`
- **model-manager**（`src/main/model-manager/index.ts`）：node-llama-cpp CPU 推理，兜底

**已注册模型**（electron-store `modelRegistry`，见 `src/main/model-registry/index.ts`）：

| 模型 | 类型 | 文件 | 端口 | 关键属性 |
|---|---|---|---|---|
| qwen3.5-9b | main | `resources\models\qwen3.5-9b.gguf` | 8086 | **默认+随启动**，gpuLayers=88(登记)/ctx=2048 |
| qwen2-vl-2b | vision | `resources\models\Qwen2-VL-2B-Instruct-Q4_K_M.gguf` | 8087 | 视觉待命，isMultimodal=true（95% 置信） |
| nomic-embed | embedding | `resources\models\nomic-embed.gguf` | 8085 | 向量检索 |

> ⚠️ 注意：`config.json` 中 `modelConfig.gpuLayers=35/ctx=4096`，但注册表 qwen3.5-9b 登记 `gpuLayers=88/ctx=2048`，两处不一致。**实际启动参数以 `resolveModelRuntime` 推导为准**（见下）。

**显存自适应策略**（`src/main/runtime/hardware.ts`）：
- `detectHardware()` 用 nvidia-smi 探测显存（1.5s 超时、模块级缓存单例）
- `resolveModelRuntime(model, hw)` 按显存分级自动推导 **gpuLayers 与 contextSize**：
  - ≥12GB：gpuLayers 原样，ctx 8192
  - ≥8GB：÷2，ctx 4096
  - **≥6GB（本机命中）：÷3（空闲显存紧时 ÷4 且 ≥16），ctx 16384**
  - ≥4GB：÷4 且 ≥16，ctx 1024
  - <4GB / 无独显：gpuLayers=0 纯 CPU，ctx 1024
- `runLocation`（auto/cpu/gpu/layered）显式指定时直通用户设置，不参与自动缩放
- **UI 上 Model 页的"GPU 层数/线程/batchSize"滑块是死参数，保存后推理链路不读取**（真实值由硬件探测推导）

**模型库 `E:\模型库`**（社区 GGUF 下载落盘地，非注册目录）：

| 文件 | 大小 |
|---|---|
| Qwen3.5-9B-Q4_K_M.gguf | 5366 MB |
| Qwen2-VL-2B-Instruct-Q4_K_M.gguf | 940 MB |
| mmproj-Qwen2-VL-2B-Instruct-f16.gguf | 1270 MB |
| 向量检索-nomic-embed.gguf | 139 MB |
| **Qwopus-GLM-18B\Qwopus-GLM-18B-Healed-Q4_K_M.gguf** | **9381 MB（已下载完成，见⑥）** |
| **Florence-2-base\model.safetensors + 全套配置** | 442 MB（safetensors 非 GGUF，见⑥） |

**云端 Provider**：`providers` 已配置 deepseek（apiKey 已存）；`cloudApiModels` 含 deepseek-v4-flash / pro / flash-vision-exp（hybrid 配额各 10 万）。当前 `activeProvider=__local_tandem__`（本地为主）。

---

## ③ 功能模块清单（src/main 下 46 个目录）

| 模块 | 一句话说明 | 关键文件 |
|---|---|---|
| floating-ball | 悬浮球 + 语音交互球（毛玻璃球体，ASR→对话→TTS 闭环） | `floating-ball/voice-ball.ts`、`floating-ball/index.ts`、`resources/voice-ball-panel.html`、`resources/floating-ball.html` |
| browser | 内置浏览器（联网搜索中枢），WebContentsView 多标签、扩展市场 | `browser/browser-manager.ts`、`browser/extension-manager.ts` |
| intent | 意图引擎：手势/语音/系统五路信号融合 | `intent/intent-engine.ts` |
| vision | 摄像头手势追踪（gaze 人脸信号源） | `vision/camera-tracker.ts` |
| tts | 语音合成：Edge TTS（联网真声）+ Piper（本地离线） | `tts/edge.ts`、`tts/piper.ts` |
| voice-engine | 语音引擎总装（VAD/降噪/声纹，自动朗读） | `voice-engine/index.ts` |
| agent | 智能体操作系统：预设 38 个智能体、组队模板、工具注册、ReAct | `agent/preset-agents.ts`、`agent/team-templates.ts`、`agent/orchestrator.ts`、`agent/tool-registry.ts`、`agent/react-loop.ts` |
| model-manager | node-llama-cpp 推理管理器（CPU 路径） | `model-manager/index.ts` |
| model-registry | 模型长效注册表（卡片增删/默认/启动/待命） | `model-registry/index.ts` |
| tandem-manager | llama-server 多模型联动引擎（GPU 主引擎） | `tandem-manager/index.ts` |
| runtime | 硬件探测 + 运行参数自适应 | `runtime/hardware.ts` |
| self-modify | 自我改造（AI 自主改代码，白名单+开关） | `self-modify/self-modify.ipc.ts`、`self-modify/whitelist.ts` |
| llm | LLM Provider 注册表（本地 GPU / 云端 API） | `llm/provider.ts`、`llm/provider-registry.ts`、`llm/local-gpu-provider.ts` |
| context / context-manager / context-window | 上下文管理、长期记忆、压缩 | `context/`、`context-window/manager.ts`、`context-window/compressor.ts` |
| rag | 检索增强（nomic-embed 向量库） | `rag/index.ts` |
| ipc | 全部 IPC 处理器（chat/config/tts/model/inference/vision 等 20 个） | `ipc/chat.ipc.ts`、`ipc/config.ipc.ts`、`ipc/tts.ipc.ts` |
| task-router | 任务路由（信号分级分发） | `task-router/` |
| wake / mobile-channel / device | 语音唤醒 / 手机通道 / 设备协同 | `wake/`、`mobile-channel/`、`device/` |
| automation / desktop-automation / ui-automation / uia | 桌面自动化 / UI 自动化 | `automation/`、`desktop-automation/`、`ui-automation/`、`uia/` |
| ppt-flow | PPT 生成流程 | `ppt-flow/` |
| 其他 | backup 备份 / secure 加密 / skill-pack 插件 / cloud-quota 配额 / knowledge-graph 知识图谱 / persona 人格 / visual-agent 视觉 / search 搜索 / fulltext-search 全文检索 / health-check 健康检查 / inference / operation / permission / personalization / persona-loader / dynamic-operation / external-ai / local-ai-scanner / register / utils | 同名目录 |

**渲染层页面**（`src/renderer/pages/`）：Home、Voice、Model、Agents、Browser、Settings、Memory、Knowledge、Automation、SelfModify。
**智能体 UI**：`Home/AgentRunner.tsx`、`Agents/ManualTeamPanel.tsx`、`Agents/AgentProfileModal.tsx`（第3批真实化产物）。

---

## ④ 关键配置当前值（`C:\Users\24228\AppData\Roaming\xuanshu-ai\config.json`）

| 配置键 | 当前值 | 说明 |
|---|---|---|
| activeProvider / activeModel | `__local_tandem__` / `qwen3.5-9b` | 本地双引擎为主 |
| defaultModelId / startupModelId | `qwen3.5-9b` | 默认+随启动 |
| **floatingBallEnabled** | **true** | 悬浮球已启用 |
| **floatingBallSnapToEdge** | **false** | 吸附边缘关闭 |
| **floatingBallVoiceId** | `xuanxu_warm_female` | 语音球音色 |
| **floatingBallWakeMode** | `auto` | 唤醒方式 |
| **floatingBallAutoStart** | **false** | 不随系统自启 |
| orbEnabled / orbTheme / orbSize | true / red / 120 | 桌宠发光球 |
| intentEnabled | **true** | 意图引擎开启 |
| selfModifyWriteEnabled | **true** | 自我改造写权限开启 |
| webSearchEnabled | true | 联网搜索 |
| voice | pack=default, speed/pitch/volume=1 | 通用语音设置 |
| modelConfig | gpuLayers=35, ctx=4096, threads=4, temp=0.7, maxTokens=2048, idleUnloadMinutes=30 | 部分为 UI 死参数（见②） |
| voiceprint | 未录入（samples 空，noiseFilter 开 level=3） | 声纹待用 |
| browserExtensions | ublock-origin 已启用 | 插件市场 |
| autoStart / sendStats | true / true | 系统自启 + 统计上报 |

---

## ⑤ 历史开发批次回顾

1. **构建发布 + 整体测评**：环境搭建、Electron 32 + Node 22，修复首页/GPU/语音/测评问题。
2. **智能体阵列 + 插件系统**：先做插件池，后**删除插件池、扩充智能体真实功能**（第3批：AgentRunner/组队/能力抽测 38 预设智能体 + 5 团队模板全 OK）。
3. **崩溃修复 + 质量整改（五批）**：稳定性守护（CrashGuard/process-guardian）、假显示零容忍，逐批消除 No handler/Error/Traceback。
4. **第4批·语音重构推倒重来**：TTS/ASR/VoiceEngine 加固，Edge TTS + Piper 双引擎，真人声好听好用；IPC 改用 sendToWindow 安全广播。
5. **第5批·手势可见化 + 任督二脉打通**：意图引擎 UI 可见化（SettingsIntent.tsx）、IPC 死通道审计修复（mobile/python ping）、camera-tracker 补 emitFaceSignal。
6. **语音交互球**：悬浮球球体形态语音中枢，ASR→对话→TTS 闭环、意图 voice 信号接通、人在感知联动、毛玻璃。
7. **内置浏览器改进**：窗口最大化兜底（boundsReady/ensureFallbackBounds）、聚合结果全宽网格、AI 面板默认收起、毛玻璃工具条；修复 voice-ball 启动 ERROR（运行时 require→静态 import）。

**近期改动文件**（2026-08-29 当日）：`floating-ball/index.ts`(18:37)、`Browser/index.tsx`(18:19)、`browser-manager.ts`(18:05)、`voice-ball.ts`(17:30)、`intent-engine.ts`(17:13)；前一日：`voice-engine/index.ts`、`model-manager/index.ts`、`AgentRunner/ManualTeamPanel/AgentProfileModal`。

---

## ⑥ 待办与下一步

1. **语音交互球 GUI 手动验证**：代码已通过 tsc0/build 成功，需真人手动验证悬浮球语音交互（对话/朗读/人在感知联动）。
2. **Qwopus-GLM-18B 替代 9B**：
   - ✅ **下载已确认完成**：`E:\模型库\Qwopus-GLM-18B\Qwopus-GLM-18B-Healed-Q4_K_M.gguf`，9,836,641,632 字节（9.16GB），日志 20:16:47 `DONE 9.16GB / exit ok=True`。
   - ⏳ **待实测**：用 `resources\llama-server.exe` 加载，测 token/s、加载时间、显存、**16384 ctx 可行性**（6GB 显存 ÷3 策略下能否承载），对比 9B 基线；若跑不动需调 ngl/ctx。
   - 来源：ModelScope `Jackrong/Qwopus-GLM-18B-Merged-GGUF`（HF 直连失败、hf-mirror 限速不可用）。
3. **Florence-2 替代 2B（视觉）**：
   - ✅ 已下载 `E:\模型库\Florence-2-base\`（model.safetensors 442MB + config/tokenizer 全套）。
   - ⚠️ **无官方 GGUF / 4bit 量化**：当前是 FP16 safetensors；环境 Python 无 CUDA torch / onnxruntime-gpu / bitsandbytes，**量化推理无法直接跑**。下一步需找量化方案（社区 ONNX q4f16 或装 GPU 推理依赖）再实测 CPU/核显 OCR 效果。

---

## ⑦ 开发约定与踩坑速查

- **验证铁律**：任何修复必须 `tsc` 零错误 + `electron-vite build` 成功 + 启动日志无 `No handler/Error/Traceback`；判成功以真实日志/JSON 字段为准，不以 stdout 短语。
- **IPC 三方闭环**：新增 IPC 必须三处对齐——preload 白名单（`src/preload/index.ts`）+ 主进程 handler + 渲染层调用；禁止裸 `webContents.send`，统一走 `utils/broadcast.ts` 的 sendToWindow/sendToAllWindows。
- **COLORS / GlassCard 签名核对**：改动共享组件/主题时先核对调用方签名，避免破坏既有引用。
- **同文件编辑串行**：同一文件的多处修改须顺序执行（编辑后重新读取再改），禁止并行编辑同一文件。
- **假显示零容忍**：UI 数据必须接真实链路（快照/IPC/轮询），禁止空壳 stub；Model 页 gpuLayers 等死参数需在 UI 注明"由硬件自动推导"。
- **显存冲突处理**：6GB 显存同时只能跑一个 GPU 模型；切换模型前先停旧引擎（tandem:switch-model 已内置）；启动/实测前先清理残留 llama-server 进程避免端口占用。
- **启动前清理**：`Get-Process llama-server -ErrorAction SilentlyContinue | Stop-Process -Force`（或 tandem:stop-all），避免端口 8082/8086 被旧实例占用。
- **路径安全**：模型/配置路径用绝对路径；electron-store 在非 ASCII 用户路径会回退 `~\.xuanshu-config`（本机 24228 为 ASCII，实际在 `%APPDATA%\xuanshu-ai\config.json`）。
- **网络**：HF 直连不可达、hf-mirror 限速不可用；大文件下载用 ModelScope 直链（断点续传）。

---

## ⑩ 本次改造：调度系统模型重排 + 云端补救 + 动态稳健 + 单模型换载（2026-08-30）

### A. 主力模型重排
- **启用两个 9B**：`qwen-coder-9b`（Qwopus3.5-9B-Coder-MTP，代码/日常主力，`scheduler/profiles.ts` priority=1，suitedFor=chat/quick/code/longctx）、`deepseek-math-9b`（DeepSeek-V4-Pro-Qwen3.5-9B，数学/STEM/复杂推理，priority=2，suitedFor=deep/code）。
- **移除**：`qwen3.5-9b`、`qwopus-18b`。config.json `modelRegistry` 已替换为新两 9B；`model-registry/index.ts` 的 `REMOVED_MODEL_IDS` 惰性清理这两个旧条目（防旧持久化残留）；`activeModel/defaultModelId/startupModelId` 均指向 `qwen-coder-9b`。
- **不动**：`qwen2-vl-2b`（vision）、`nomic-embed`（embedding），不参与文本调度。
- **注册稳健**：`modelRegistry.add()` 新增文件存在性校验（modelPath 不存在拒绝注册，幂等 upsert 同路径视为同一模型），并支持 `opts.allowMissing` 跳过（供预注册场景）。

### B. 云端补救接入调度决策链
- 新增 `src/main/scheduler/cloud.ts`（复用既有链路，不重复实现）：
  - `resolveCloudProviderConfig(preferredId)`：读 config.providers，优先取调度配置 providerId，兼容全局 activeProvider；仅支持 openai 兼容。
  - `isComplexForCloud`：复杂任务（deep/code/longctx）或超长文本（≥complexThreshold，默认 8000 字符）才升云端。
  - `callCloud`：配额前置校验（`cloudQuota.isExhausted` 耗尽即不升云端）→ `LLMProviderRegistry` 惰性创建 Provider → `provider.generate` → 调用后 `cloudQuota.recordUsage` 记账（`estimateTokens` 估算）。
- `scheduler/index.ts`：
  - `decide()`：无本地可用模型且复杂任务 → 返回 `cloudFallback=true` 决策；正常路径计算 `cloudReady`。
  - `run()`：本地全部候选失败后，若 cloudCandidate 成立则尝试 `callCloud`，成功即返回（record 标 `usedCloud`），失败自动降级回本地（不重复启动，保离线可用）。
- **接通**：config.json 新增 `schedulerConfig.cloud`（enabled/providerId=deepseek/modelId=deepseek-v4-pro/complexOnly/complexThreshold/tokenBudget）与 `cloudQuota` 配额条目（deepseek limitTokens=100000）；全局 `activeProvider` 保持 `__local_tandem__` 不变，调度云端补救通过 scheduler.cloud.providerId 单独接通。

### C. 动态模型接入/删除稳健性
- 调度系统不再硬编码模型列表：`scheduler/profiles.ts` 的 `registeredIds` 按 `modelRegistry.list()` 中 `type==='main'` 动态过滤，新增/删除模型自动跟随，无需改代码。
- 无可用模型/删模型场景优雅兜底：`decide()` 在无候选时回退注册表默认模型；仍无则标记云端兜底或抛出可读错误（"无可用的已注册文本模型…"），`run()` 侧由云端补救/失败记录承接，不崩溃。

### D. 显卡单模型常驻换载机制（6GB 一次一 GPU 模型）
- `scheduler/types.ts` 新增 `SchedulerResidentConfig`（residentModelId/swapEnabled/restoreAfterTask/swapTimeoutMs）。
- `decide()` 计算 `needsSwap`：目标模型 ≠ 常驻主力且需 GPU（`rt.targetDevice==='gpu'`）时标记换载。
- `run()` 跟踪 `usedSwap`，任务成功后调用 `restoreResident()`：停掉当前 llama-server（`tandemManager.stopServer` 释放显存）再切回常驻主力（`ensureLoaded`），换载失败不抛异常（增强能力不影响主流程）。
- config.json `schedulerConfig.resident`：residentModelId=`qwen-coder-9b`、swapEnabled/restoreAfterTask=true。

### 完成状态
- `tsc --noEmit -p tsconfig.node.json` 零错误；`electron-vite build` 通过（main/preload/renderer 三端构建成功，4.75s）。
- 模型 GGUF 文件下载另行处理（本次仅代码与配置注册）；两个新 9B 的 modelPath 指向 `resources\models\` 下待下载文件。

*（内容由AI生成，仅供参考）*
