---
AIGC:
    Label: "1"
    ContentProducer: 001191440300708461136T1XGW3
    ProduceID: 3c24a5e3a352f921a82f7d3a39c85647_62841e0fa3cc11f193c6525400f8a581
    ReservedCode1: L5aI5AR8DVCm3TZnJ2M1lPIs+0yyuBzXjOTmWOE+gnHggcM06xDLlI6UYHHEE4WbbjKkYojdphA2FkHJZBTGrlLQ/3VNf6wK3iF9fZ1xzSZctjzjOuWnk7vtw93i7eLX0e55vMMJYIQHEhUaqONXeRuwOq7AuXYVDIostA1S3YqsuQC0F6Hg4oAYIdQ=
    ContentPropagator: 001191440300708461136T1XGW3
    PropagateID: 3c24a5e3a352f921a82f7d3a39c85647_62841e0fa3cc11f193c6525400f8a581
    ReservedCode2: L5aI5AR8DVCm3TZnJ2M1lPIs+0yyuBzXjOTmWOE+gnHggcM06xDLlI6UYHHEE4WbbjKkYojdphA2FkHJZBTGrlLQ/3VNf6wK3iF9fZ1xzSZctjzjOuWnk7vtw93i7eLX0e55vMMJYIQHEhUaqONXeRuwOq7AuXYVDIostA1S3YqsuQC0F6Hg4oAYIdQ=
---

# 玄枢AI 智能体架构审查报告

- 审查对象：`E:\玄枢AI\xuanshu-ai-dev`
- 审查日期：2026-08-30
- 审查目标：回答三个问题 —— ① 玄枢智能体本质上是真 agent 还是"壳"；② 是否实现多 agent 协同；③ 若存在"壳"，具体在那一层。
- 方法：仅基于源码阅读与磁盘落盘事实，全部结论附文件 + 行号证据，禁止推测。

---

## 一、结论速览（三问直答）

| 问题 | 结论 |
|---|---|
| 1. 智能体本质 | **是"真 agent"而非纯壳**。存在完整执行内核：ReAct 循环（思考→调用工具→观察→再思考）、真实 LLM 调用链路、真实工具注册表、上下文/记忆注入。38 个预置智能体 + 5 个团队模板均真实种子落盘（`userData/agents/agt-preset-*.json`）。 |
| 2. 多 Agent 协同 | **已实现，且是真实的编排机制而非静态展示**。存在任务分解（AI plan）、Kahn 拓扑排序、分层并行派发、前序输出注入后序步骤、团队模板运行期解析到真实智能体。 |
| 3. 壳的程度 | **执行内核完整可用，但存在数处"半接线"残缺**（非空壳）：记忆 namespace 只注入 prompt 文本、向量检索未按 namespace 隔离；工具调用为文本协议而非原生 function calling；预置智能体默认工具子集极窄。逐层定位见第三章。 |

---

## 二、证据详情

### 2.1 智能体本质：真 agent（具备自主规划、调用工具、循环执行）

**① 自主发起 LLM 调用 —— 真实推理链路**

- `src/main/agent/react-loop.ts:89` ReAct 循环内调用 `mgr.generateResponse(prompt, {...})`；`:182` 循环结束后生成最终回复同样走 `generateResponse`。
- `src/main/model-manager/index.ts:952` `async generateResponse(...)`：优先探测 llama-server HTTP API（`:961 isServerRunning` → `generateViaServer`），失败回退 SGLang HTTP（`http://127.0.0.1:30000/v1/completions`，`:1075` 附近）或 CPU 引擎（`cpuInferenceEngine.generate`，`:1004`）。**这是真实推理链路，非桩代码**，与全局任务历史中"文本推理主链路为 tandem-manager（llama-server）"的结论一致。
- 启动接线：`src/main/register/modules.register.ts:146-152` 自动启动模型（`tandemManager.startServer`），`registerModels` 注册 qwen3.5-9b / nomic-embed / qwen2-vl-2b，`modelManager` 初始化。

**② 能调用工具 —— 真实工具注册表**

- `src/main/agent/tool-registry.ts`：`register()`（`:18`）、`execute()`（经 `toolRegistry.execute(name, params)` 调用）。注册了搜索（`:155` `internetSearch.search`）、RAG 搜索（`:205` `searchWithRAG`）、记忆检索（`:221` `search_memories`、`:244` `search_memories_by_type`）、知识图谱、语音、浏览器插件、自我改造（只读）等，`execute` 均委托真实引擎。
- `src/main/agent/control-tools.ts`：注册 8 个电脑细粒度控制工具（`click_at / double_click_at / right_click_at / type_text / press_keys / drag_at / scroll_at / take_screenshot`），执行走 `interactionExecutor`（`user32.dll P/Invoke` + PowerShell SendKeys，见 `visual-agent/interaction-executor.ts`）。
- `visual-agent/index.ts:91` `executeTask` / `:104` `executeTaskInner`：截图 → `elementRecognizer.recognizeScreen`（`:135`）→ 决策 → `interactionExecutor.execute`（`:188`）。视觉执行内核真实存在，非空壳。
- 接线：`modules.register.ts:72-76` 调用 `registerAllTools({ dynamicOperationEngine, knowledgeGraph, vectorStore, voiceEngine, internetSearch })`；`:81-85` 调用 `registerControlTools()`。均为真实依赖注入。

**③ 循环执行 + 状态维护**

- `react-loop.ts:67` `for (let step = 0; step < maxSteps; step++)` 主循环；`:99` `parseToolCall(thought)` 解析工具调用；`:137/:140` `toolRegistry.execute(...)` 执行；`:123/:148/:155/:177` 将工具参数/结果/中间观察 push 进 `context` 数组（多轮状态累积）；`:191` `updateStats` 记录统计；`:40` `maxSteps: config.maxSteps ?? 15`（循环上限可配置）。
- `agent-runtime.ts:57` `buildSystemPrompt`：加载 persona 基础系统提示（`personaLoader`），`:76-78` 注入记忆命名空间与召回上限，`:139-141` 构造 `ReActAgent({ systemPrompt, toolIds, maxSteps })`。

**④ 38 个预置智能体真实落盘**

- `userData\agents\agt-preset-pm.json` 等实际存在，字段完整：`id / name / description / personaId / toolIds / memoryConfig{namespace,maxRecall} / modelConfig{temperature,maxSteps} / collaboration / preset:true`。
- 例：`agt-preset-pm`（产品经理）`personaId=product-manager`，`toolIds=[search_with_rag, analyze_task, speak]`，`memoryConfig.namespace="agent:agt-preset-pm"`。
- 启动确保：`ipc.register.ts` 启动时调用 `setupAgentHandlers / setupSwarmHandlers / ensurePresetAgents`（写入全部预置智能体 JSON）。

### 2.2 多 Agent 协同：已实现真实编排

**① 任务编排器（orchestrator）**

- `src/main/agent/orchestrator.ts:138` `async plan(goal)`：AI 将目标分解为多步 `SwarmTask`（`steps[] + dependsOn DAG`），`:155` 拓扑排序校验。
- `:81` `topoSort(steps)`：Kahn 算法拓扑排序，有环返回 null。
- `:210` `async run(task, onEvent)`：
  - `:231/:235` 构建 indegree/dependents；
  - `:277` `await Promise.all(ready.map(runStep))` —— **同层（无依赖）步骤并行执行**；
  - `:241-246` 每个 step 执行前把 `dependsOn` 前序步骤输出拼进 `instruction`（`[前序步骤输出]...`）—— **前序 agent 输出真实注入后序 agent 上下文**。
- `:299` `async runTemplate(templateId, goal)`：团队模板运行期解析。

**② 团队模板：5 个，真实联动而非静态展示**

- `src/main/agent/team-templates.ts`：定义 5 个团队模板（如研发/文案/PPT/内容/生活等）。模板中步骤按**角色名**引用，`runTemplate` 运行期 resolve 到真实 agentId，再走 `orchestrator.run` 的并行/串行派发——不是只展示不执行。

**③ IPC 三方闭环（协同可被渲染层触发）**

- 主进程：`ipc.register.ts` `setupSwarmHandlers` 注册 `swarm:plan / swarm:run / swarm:status`，`setupAgentHandlers` 注册 `team:list / team:run-template / agent:list / agent:run / agent:stop` 等。
- 预加载白名单：`preload/index.ts` 的 `IpcChannels` 联合类型包含全部 `agent:* / swarm:* / team:*` 通道。
- 渲染层真实调用：
  - `src/renderer/pages/Agents/index.tsx:213` `team:list`、`:234` `team:run-template`、`:345` `swarm:plan`、`:360` `swarm:run`；
  - `src/renderer/pages/Agents/ManualTeamPanel.tsx:138/161/192` `swarm:run`；
  - `src/renderer/pages/Home/AgentRunner.tsx:66/72/105/122/139` `team:list / agent:list / team:run-template / swarm:plan / swarm:run`；
  - `src/renderer/store/agentStore.ts:73/88/97/171` `agent:list / list-personas / list-tools / run`。

### 2.3 壳的程度：执行内核完整，但有真实残缺点（非空壳）

| 层级 | 状态 | 证据 |
|---|---|---|
| 配置/描述/UI | **真实**（有落盘 + 真实驱动） | `agt-preset-*.json` 38 个；Agents 页 / AgentRunner / ManualTeamPanel 真实调用 IPC |
| 执行内核（循环） | **真实** | `react-loop.ts:67` for 循环 + `parseToolCall` + `toolRegistry.execute` + context 累积 |
| LLM 接线 | **真实** | `model-manager/index.ts:952` generateResponse → llama-server / SGLang / CPU 三路真实推理 |
| 工具接线 | **真实** | `tool-registry.ts` execute 委托 internetSearch / vectorStore / interactionExecutor 等真实引擎 |
| 协同编排 | **真实** | orchestrator plan/topoSort/分层并行/输出注入/runTemplate |
| 记忆 namespace 隔离 | **半接线（残缺点①）** | `agent-runtime.ts:76-78` 仅将 `memoryConfig.namespace` 作为**文本**注入 system prompt；而检索工具 `search_memories`（`tool-registry.ts:221-235`）参数仅 `query/topK`，调用 `vectorStore.search(embedding, topK)` **全库检索、无 namespace 过滤**；`search_memories_by_type` 仅按 type 过滤。即"命名空间隔离"目前是提示词标记，未真正参与向量检索隔离 |
| 工具调用协议 | **半接线（残缺点②）** | 工具调用靠 `parseToolCall`（`react-loop.ts:291`）解析 `tool` 文本 JSON，为文本协议，非模型原生 function-calling 硬绑定（本地 llama 生态常见做法，可用但非强约束） |
| 预置智能体默认能力 | **较窄（残缺点③）** | 多数预置 agent 默认 `toolIds` 仅 `search_with_rag / analyze_task / speak` 数项，完整工具集（control_computer、细粒度控制等）需用户编辑 agent 配置才能启用 |
| UI 滑块参数（gpuLayers 等） | **死参数（与 agent 无直接关系）** | 历史核查：Model 页滑块保存后推理链路不读取，运行时参数由 `runtime/hardware.ts` 推导 |

---

## 三、文件清单

### 3.1 智能体核心（主进程）

| 文件 | 职责 |
|---|---|
| `src/main/agent/types.ts` | IAgent 接口（run/cancel/reset）、AgentInput/Event/State/Stats/ToolDefinition/ToolResult |
| `src/main/agent/react-loop.ts` | ReAct 循环执行内核（思考→工具→观察→循环） |
| `src/main/agent/agent-runtime.ts` | 运行入口：buildSystemPrompt + 构造 ReActAgent + 逐事件回传 |
| `src/main/agent/agent-factory.ts` | 自定义智能体生成（LLM 出 JSON → tryParseAgentConfig） |
| `src/main/agent/agent-store.ts` | userData/agents JSON CRUD + 校验 |
| `src/main/agent/tool-registry.ts` | 工具注册表（搜索/RAG/记忆/图谱/语音/自我改造等） |
| `src/main/agent/control-tools.ts` | 8 个电脑细粒度控制工具（鼠标/键盘/截图） |
| `src/main/agent/orchestrator.ts` | 编排器：plan（AI 分解）/ topoSort / run（分层并行+输出注入）/ runTemplate |
| `src/main/agent/team-templates.ts` | 5 个团队模板定义 |
| `src/main/agent/preset-agents.ts` | 38 个预置智能体定义（PRESET_AGENTS） |
| `src/main/agent/shared/agent-types.ts` | AgentDefinition / SwarmTask / TeamTemplate 类型 |
| `src/main/agent/panic-stop.ts` | 紧急停止 |
| `src/main/visual-agent/index.ts` | 视觉代理执行内核（executeTask/executeTaskInner） |
| `src/main/visual-agent/element-recognizer.ts` / `screen-observer.ts` / `interaction-executor.ts` | 元素识别 / 截图 / 鼠标键盘模拟（真实实现） |
| `src/main/persona/` | persona 加载（智能体人设真源） |
| `src/main/model-manager/index.ts` | generateResponse 推理链路（llama-server/SGLang/CPU） |
| `src/main/tandem-manager/index.ts` | 文本推理主链路（llama-server 进程管理） |
| `src/main/rag/vector-store.ts` | 向量库 search / searchByType（注意：无 namespace 过滤参数） |
| `src/main/rag/index.ts` | RAG 检索封装 |

### 3.2 接线（启动 / IPC）

| 文件 | 职责 |
|---|---|
| `src/main/register/ipc.register.ts` | setupAgentHandlers / setupSwarmHandlers / ensurePresetAgents |
| `src/main/register/modules.register.ts` | registerAllTools / registerControlTools / 模型自动启动 |
| `src/main/ipc/agent.ipc.ts` / `swarm.ipc.ts`（或同目录内） | agent:/swarm:/team: 主进程 handler |
| `src/preload/index.ts` | IpcChannels 白名单（agent:* / swarm:* / team:*） |

### 3.3 渲染层

| 文件 | 职责 |
|---|---|
| `src/renderer/pages/Agents/index.tsx` | 智能体列表 + swarm/team 触发 |
| `src/renderer/pages/Agents/ManualTeamPanel.tsx` | 手动团队面板（swarm:run） |
| `src/renderer/pages/Home/AgentRunner.tsx` | 首页智能体/团队运行器 |
| `src/renderer/store/agentStore.ts` | agent:list/run 等状态管理 |

### 3.4 落盘数据

| 路径 | 内容 |
|---|---|
| `%APPDATA%\xuanshu-ai\agents\agt-preset-*.json` | 38 个预置智能体真实种子文件 |

---

## 四、最终结论

1. **智能体本质**：玄枢的智能体是**有真实执行内核的 agent**（ReAct 循环 + 真实 LLM 推理 + 真实工具执行 + 上下文累积），不是只有外观/模板的纯壳。核心实现集中在 `src/main/agent/`，且已完整接线（modules.register → tool-registry / control-tools → modelManager 推理链路；ipc.register → preload 白名单 → 渲染层真实调用）。

2. **多 Agent 协同**：**已实现真实的协同机制**。`orchestrator.ts` 提供 AI 任务分解、Kahn 拓扑排序、同层并行 + 串行接力、前序输出注入后序步骤；5 个团队模板运行期解析到真实智能体联动执行，非静态展示。

3. **壳的程度**：**执行内核"真"、局部接线"半"**。最值得关注的残缺点为：
   - 记忆 `namespace` 仅注入提示词文本，向量检索未按 namespace 隔离（`tool-registry.ts:235` 全库 `vectorStore.search`）；
   - 工具调用为文本 JSON 协议（`parseToolCall`），非原生 function calling；
   - 预置智能体默认工具子集窄，完整电脑控制能力需手动编辑启用。

整体判定：**非空壳；是真 agent 内核 + 已接通真实 LLM/工具/编排链路，但存在"记忆隔离未落检索、工具协议偏文本化、默认能力保守"三处半接线残缺**。
*（内容由AI生成，仅供参考）*
