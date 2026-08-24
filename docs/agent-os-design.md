# 玄枢 AI — 智能体操作系统（Agent OS）系统设计

> 架构师 高见远 · 已读代码核实（`E:\玄枢AI\xuanshu-ai-dev`）
> 上游：`docs/prd-agent-os.md`（产品经理）+ 用户拍板 4 决策
> 本文为工程师的实现任务书，不写实现代码，仅给 schema / IPC 通道 / 接口签名 / 时序。

---

## 0. 现状核实结论（已读源码，非臆测）

| 资产 | 实际位置 | 状态 |
|---|---|---|
| Agent 框架 | `src/main/agent/{types,tool-registry,react-loop,index}.ts` | 已有 `ReActAgent` + `IAgent` + `ToolDefinition`（含 `dangerous/confirm`）+ 全局单例 `toolRegistry` |
| 人设加载 | `src/main/persona-loader/index.ts` | 只读元数据（listPersonas/getPersona/getTier），**canonical 源为 `resources/personas/`（44 套）** |
| 人设目录歧义 | 根目录 `personas/`（25 套 brain_* 系列）vs `resources/personas/`（44 套） | **两套已漂移**，见 §7 待明确 |
| 工具注册 | `tool-registry.ts` `registerAllTools` | 已实装搜索/知识/记忆/视觉/语音/自我改造只读工具，`control_computer` 已注册（dangerous） |
| ReAct 循环 | `react-loop.ts` | execute 循环 + `confirmIfDangerous` 危险门；**当前是全局工具集 + 单一 systemPrompt，无 per-agent 隔离** |
| 控制电脑 | `desktop-automation/index.ts` + `visual-agent/` | click/type/registry/service 均有；`confirmRisk`/`guardRisk`/`confirmExecute`/`confirmSingleAction` 四套确认门并存 |
| 特效 | `renderer/components/ControlOverlay.tsx` | 已有 HUD/扫描线/危险分级，监听 `control:state` |
| 自我改造 | `src/main/self-modify/` | 完整：whitelist + git 快照 + diff 确认 + 回滚 + 审计 |
| 双模型 | `tandem-manager/index.ts` | 多模型（dual/partner/mentor/debate），**非多智能体** |
| 编排器 | — | **不存在**，无 orchestrator/multi-agent 代码 |
| 浏览器 | — | **不存在**，全仓无 webview/BrowserView/WebContentsView 使用 |
| 配置 | `ipc/config.ipc.ts`（electron-store + `ALLOWED_CONFIG_KEYS` 白名单） | 新增配置项需进白名单 |
| 模型 | `model-manager/index.ts` `generateResponse(prompt, opts)` → `Promise<string>` | 单模型常驻（Qwen3.5-9B），6GB VRAM |

**关键约束**：本地小模型（Qwen3.5-9B）结构化 JSON 输出不稳定 → 所有"AI 生成配置/编排"必须走**模板填空 + 强校验 + 失败降级**，不做完全开放式生成。

---

## 1. 实现方案 + 技术选型（逐模块给推荐 + 理由）

### A. 智能体统一数据模型（核心）

**方案**：新增 `AgentDefinition` 数据结构，把 persona（人设）+ tools（工具集）+ memory（独立记忆）+ ReAct 循环四要素封装为单一对象。运行时由新类 `AgentRuntime` 凭 `agentId` 拉起完整循环，**复用** `react-loop.ts` + `tool-registry.ts` + `persona-loader`，不重写循环。

**存储位置决策：独立 `agents/` 目录（userData 下），不存 `personas/`。**

理由：
1. **生命周期不同**：人设是"静态模板"（随应用发布），智能体是"用户运行时产物"（动态创建/编辑/删除）。
2. **更新隔离**：应用升级会覆盖 `resources/personas`/仓库文件，`userData/agents` 不受影响。
3. **不污染 git/自我改造白名单**：避免用户态数据混入仓库，也避免与 self-modify 的路径白名单耦合。
4. **备份/导出简单**：`userData/agents/*.json` 扁平文件，导出即拷贝。

`personaId` 引用静态人设（`personaLoader.getPersona` 取 system_prompt），`personaOverride` 承载动态创建时的 AI 微调（覆盖/追加 prompt）。

### B. 智能体动态创建（对话式）

**推荐：模板填空式生成（从 20 套人设选基础模板 + AI 填空），不复用 self-modify 的 git/diff 机制。**

理由：
1. 本地 9B 模型无法可靠产出完全开放的合法 JSON 配置 → 固定 schema + 只让 AI 填 `name/description/tags/toolIds` 少数字段，其余由模板兜底。
2. 创建智能体是"纯新增 JSON 文件"，无需 self-modify 的 git 快照/回滚/白名单复杂度；只需复用其"**AI 生成 → 人工确认 → 落盘**"三段式交互模式（`agent-factory` 独立模块）。
3. 确认门：复用 self-modify 的 `confirmed` 强制校验思路——渲染层展示配置预览，用户点确认后 `confirmed=true` 才写盘。

### C. 控制电脑接入工具集 + 白名单

**方案**：新增 `control-tools.ts`，把 `desktop-automation` + `visual-agent` 的裸通道封装为**细粒度工具**入 tool-registry（`control_computer` 已存在，作为"视觉代理整任务"粗粒度工具保留）。白名单 + 紧急暂停为新增独立模块。

**首次授权 + 白名单持久化**：存 `userData/permissions/control-whitelist.json`。
- 判定"首次"：查白名单中是否存在 `(toolName)` 记录，无 → 首次 → 弹授权确认 → 用户勾选"记住"则写入白名单。
- 白名单粒度：**按 toolName（细粒度）**，可选按 category 快捷全开（设置页提供）。白名单命中 → 直接放行，跳过逐次确认。

**全局紧急暂停**：Electron `globalShortcut`（`Ctrl+Shift+Escape` 备选 `Ctrl+Shift+F12`），触发后置全局 `panicStop.trigger()`，abort 所有运行中的 visual-agent 任务 + 杀掉 desktop-automation 子进程。

**与 confirmExecute/confirmRisk 关系（三级闸门）**：
```
① 白名单闸（permission-whitelist）：命中 → 放行
② 确认门（confirmExecute / confirmRisk）：白名单未命中 → 走既有弹窗确认
③ 紧急暂停（panic-stop）：最高优先级，随时中断 ①②
```
confirmExecute/confirmRisk 保持不动，作为兜底确认门；白名单是"前置加速"。

### D. 发光特效升级

**方案**：升级 `ControlOverlay.tsx` 为"屏幕四周发光"——8~12px 四周边框 + 蓝紫渐变 + 三态（思考/操作/完成）不同动效。可配置项入 electron-store（新增 config keys）。

三态与 `control:state` 的关系：扩展 `ControlState` payload，增加 `phase: 'thinking'|'acting'|'done'`。`notifyControlStart(detail, phase)` 时携带；`thinking`=冷静呼吸蓝、`acting`=高频流动紫、`done`=渐隐收束。配置项由 renderer 读 config 后以 CSS 变量注入（亮度/颜色/强度）。

### E. 内置浏览器（应用内标签页）

**推荐：WebContentsView（不是 webview tag，不是 BrowserView）。**

理由：
1. Electron 32 中 `BrowserView` 已废弃，官方推荐替代即 `WebContentsView`。
2. `<webview>` tag 需 `webviewTag:true` 且有历史 RCE 面，安全性差，且与 React 组件树集成别扭。
3. WebContentsView 作为独立 view 叠加在主窗口内容区之上，通过主进程 IPC 全权控制（导航/加载/执行 JS），渲染层只发指令、收状态，安全边界清晰。
4. 登录态隔离：每个 view 绑定独立 `session`（partition），标签页之间隔离；主应用 session 与浏览器 session 分离。

### F. 群协作（AI 自动调度）

**推荐：新建 `orchestrator`，不复用 tandem-manager，但复用其多模型底层能力。**

理由：tandem-manager 是"**多模型**联动"（同一 prompt 给多个模型），群协作是"**多智能体**协作"（任务分解 → 派发 → 接力 → 汇总），语义不同。orchestrator 内部可调用 tandemManager/queryModel 或 modelManager 执行单个 agent 的推理。

**自动调度失败降级**（本地小模型自动调度易翻车，必须兜底）：
```
自动编排（AI 任务分解 + 派发）
  失败条件：JSON 解析失败 / 步骤超限 / 无进展（N 轮无新产出）/ 单个 agent 报错
  → 降级为手动编排：把已拆好的任务清单展示给用户，用户手动为每步指定
    "由哪个 agent 处理 + 输出喂给下一步谁"，点击逐步执行
```

---

## 2. 数据模型 Schema

### 2.1 Agent 定义（新增 `src/shared/agent-types.ts`）

```ts
/** 记忆配置：独立命名空间，隔离到 vectorStore 分区 */
export interface AgentMemoryConfig {
  enabled: boolean
  namespace: string        // 'agent:<agentId>'，检索时按 namespace 过滤
  maxRecall: number        // 默认 5
}

/** 模型配置（可空，默认回落全局 defaultModelId） */
export interface AgentModelConfig {
  modelId?: string
  temperature?: number
  maxSteps?: number        // ReAct 最大步数，默认 15
}

/** 智能体定义（落盘为 userData/agents/<id>.json） */
export interface AgentDefinition {
  id: string               // 'agt-' + 时间戳 + 随机段
  name: string
  description: string
  icon?: string
  color?: string
  personaId: string        // 引用静态人设（personaLoader）
  personaOverride?: {      // 动态创建时的 AI 微调
    name?: string
    systemPromptSuffix?: string  // 追加到人设 prompt 之后
  }
  toolIds: string[]        // 引用 toolRegistry 工具名（子集）
  memoryConfig: AgentMemoryConfig
  modelConfig: AgentModelConfig
  tags: string[]
  createdAt: number
  updatedAt: number
}
```

### 2.2 控制白名单记录（新增 `src/main/agent/permission-whitelist.ts`）

```ts
export interface WhitelistEntry {
  toolName: string         // 如 'click_at' / 'type_text' / 'registry_write'
  grantedAt: number
  /** 授权范围：'tool' 单个工具 | 'category' 整类 */
  scope: 'tool' | 'category'
  category?: string        // scope='category' 时的工具分类
}

/** userData/permissions/control-whitelist.json 顶层结构 */
export interface ControlWhitelistFile {
  version: 1
  entries: WhitelistEntry[]
}
```

### 2.3 控制状态扩展（修改 `src/main/control-state.ts`）

```ts
export type ControlPhase = 'thinking' | 'acting' | 'done'
export interface ControlState {
  active: boolean
  detail: string
  phase: ControlPhase       // 新增：三态驱动发光特效
  ts: number
}
```

### 2.4 群协作任务（新增 `src/main/agent/orchestrator.ts`）

```ts
export type SwarmStepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped'
export interface SwarmStep {
  id: string
  agentId: string           // 派发到的智能体
  instruction: string       // 该步指令
  dependsOn: string[]       // 前置步骤 id（接力关系）
}
export interface SwarmTask {
  id: string
  goal: string
  steps: SwarmStep[]
  mode: 'auto' | 'manual'   // auto=AI 调度 / manual=降级手动编排
  status: 'planning' | 'running' | 'paused' | 'done' | 'failed'
}
export interface SwarmResult {
  taskId: string
  steps: Array<{ stepId: string; agentId: string; output: string; status: SwarmStepStatus }>
  summary: string
}
```

### 2.5 发光特效配置（新增 config keys）

```ts
// 追加到 src/shared/config-keys.ts 的 CONFIG_KEYS
CONTROL_GLOW_ENABLED: 'controlGlowEnabled',      // 默认 true
CONTROL_GLOW_BRIGHTNESS: 'controlGlowBrightness',// 0.2~1.0，默认 0.8
CONTROL_GLOW_COLOR: 'controlGlowColor',          // 默认 'blueviolet'（可选 preset）
CONTROL_GLOW_INTENSITY: 'controlGlowIntensity',  // 0.2~1.0，默认 0.7（动效强度）
```

---

## 3. 文件列表（新增/修改，相对路径）

### 新增（main 进程）

```
src/shared/agent-types.ts                     # Agent/白名单/Swarm 共享类型（渲染层也消费）
src/main/agent/agent-store.ts                 # userData/agents 目录 CRUD + 校验
src/main/agent/agent-runtime.ts               # 凭 agentId 拉起 ReAct 循环（封装 persona+tools+memory）
src/main/agent/agent-factory.ts               # AI 生成 agent 配置（模板填空 + confirmed 落盘）
src/main/agent/control-tools.ts               # 细粒度控制工具注册（click_at/type_text/registry_write 等）
src/main/agent/permission-whitelist.ts        # 白名单持久化 + 首次判定 + 放行判断
src/main/agent/panic-stop.ts                  # globalShortcut 紧急暂停 + 中断所有控制任务
src/main/agent/orchestrator.ts                # 群协作编排器（AI 调度 + 手动降级）
src/main/browser/index.ts                     # 浏览器模块入口 + IPC
src/main/browser/tab-manager.ts               # WebContentsView 标签页管理（前进后退/导航）
src/main/browser/security.ts                  # 导航/新窗口/下载/外链拦截
src/main/browser/feed-ai.ts                   # 提取正文/截图喂 AI/页内执行操作
```

### 新增（renderer 进程）

```
src/renderer/store/agentStore.ts              # zustand：智能体列表/创建/编辑
src/renderer/store/browserStore.ts            # zustand：标签页/地址栏/书签/历史
src/renderer/pages/Agents/index.tsx           # 智能体管理页（列表 + 对话式创建向导）
src/renderer/pages/Browser/index.tsx          # 内置浏览器标签页宿主 UI
```

### 修改

```
src/main/agent/react-loop.ts                  # 支持 per-agent 工具子集 + memory namespace 注入
src/main/agent/tool-registry.ts               # 工具子集过滤 getEnabled(ids) + 控制工具接入点
src/main/agent/index.ts                       # 导出新模块
src/main/control-state.ts                     # ControlState 增加 phase
src/main/register/ipc.register.ts             # 接入 agent/browser/orchestrator handler
src/main/register/modules.register.ts         # 初始化 agent-store / panic-stop / orchestrator
src/shared/config-keys.ts                     # 追加发光特效 config keys
src/shared/ipc-types.ts                       # 追加 AgentDefinition/SwarmTask 等返回类型
src/preload/index.ts                          # 追加新 IPC channel 类型
src/renderer/components/ControlOverlay.tsx    # 升级为四周边框发光 + 三态动效 + 可配置
src/renderer/components/layout/Sidebar.tsx    # 新增「智能体」「浏览器」入口
```

---

## 4. 依赖关系图 + 实现顺序（分阶段，标注依赖）

```
T01 基础设施 + 数据模型 + 存储
    ├─ src/shared/agent-types.ts
    ├─ src/main/agent/agent-store.ts
    ├─ src/shared/config-keys.ts / ipc-types.ts / preload/index.ts
    └─ register/ipc.register.ts / modules.register.ts（骨架接入）
        │
        ├──► T02 Agent 运行时 + 工具集改造
        │      ├─ agent-runtime.ts
        │      ├─ react-loop.ts（改造）
        │      ├─ tool-registry.ts（子集过滤）
        │      └─ control-tools.ts
        │
        ├──► T03 动态创建 + 白名单 + 紧急暂停
        │      ├─ agent-factory.ts
        │      ├─ permission-whitelist.ts
        │      ├─ panic-stop.ts
        │      └─ control-state.ts（phase）
        │
        ├──► T04 前端智能体页 + 发光特效
        │      ├─ pages/Agents + agentStore
        │      ├─ ControlOverlay.tsx（升级）
        │      └─ Sidebar 入口
        │
        └──► T05 内置浏览器 + 群协作编排器
               ├─ browser/*（4 文件）
               ├─ pages/Browser + browserStore
               └─ orchestrator.ts
```

- T02/T03/T04/T05 均只依赖 T01（基础设施），相互之间解耦，可并行开发。
- T02 是 T03/T04/T05 的隐性依赖源（agent-runtime 被 factory/orchestrator 调用，control-tools 被白名单引用），但代码层面通过接口解耦，不构成硬阻塞。

---

## 5. 关键流程图（时序文字描述）

### 5.1 智能体动态创建（对话式）

```
用户「帮我建一个股票分析智能体」
  → renderer Agents 页 → agent:create-request (自然语言)
  → agent-factory：
      ① 取 20 套人设清单（personaLoader.listPersonas）
      ② 组装"模板填空" prompt（固定 schema + 人设列表 + 工具列表）
      ③ modelManager.generateResponse 生成 JSON
      ④ tryParseAgentConfig 严格解析，失败→重试1次→报错降级（引导手动填）
      ⑤ 返回 AgentDefinition 预览（confirmed=false）
  → renderer 展示预览表单（名称/定位/标签/工具集可改）
  → 用户点「确认创建」→ agent:create-confirm (definition, confirmed=true)
  → agent-store.validate + save (userData/agents/<id>.json)
  → 返回 AgentDefinition → 刷新列表
```

### 5.2 凭 agentId 拉起循环

```
renderer → agent:run (agentId, messages)
  → agent-runtime.run(agentId, messages)：
      ① agentStore.get(agentId) 读定义
      ② personaLoader.getPersona(personaId) 取 system_prompt
         + personaOverride.systemPromptSuffix 拼接
      ③ toolRegistry.getEnabled(toolIds) 过滤工具子集
      ④ memory：vectorStore 按 namespace 检索记忆 → 注入 system prompt 末尾
      ⑤ new ReActAgent({ systemPrompt, 工具子集, maxSteps })
      ⑥ for await (event of agent.run(...)) → 广播 agent:event 到渲染层
  → renderer 逐条渲染 thinking/tool_call/tool_result/response
```

### 5.3 控制电脑白名单 + 紧急暂停

```
ReAct 循环遇到工具 click_at
  → toolRegistry.execute('click_at', params)
  → permission-whitelist.check('click_at')：
      - 命中白名单 → 放行 → desktop-automation 执行
      - 未命中 → confirmExecute/confirmRisk 弹窗确认
          - 用户勾选「记住」→ whitelist.add('click_at') 持久化
  → 执行中用户按 Ctrl+Shift+Escape
  → panic-stop.trigger() → 广播 control:panic → abort 所有任务 + 杀子进程
  → 渲染层 overlay 进入「已暂停」态
```

### 5.4 群协作自动调度 + 降级

```
用户「让三个智能体协作写一份行业报告」
  → orchestrator.plan(goal)：
      ① 列出可用 agents + 各 agent 能力描述（名称+description+toolIds）
      ② AI 生成 SwarmTask（steps + dependsOn 接力 DAG）
      ③ 解析失败 / 无依赖合法 DAG → 降级 manual（展示任务清单待用户编排）
  → 自动模式：拓扑排序 → 逐 step 派发 agent-runtime.run(step.agentId, instruction)
      - 单 step 失败/超限 → 标记 failed，尝试下一步（不整体崩）
      - N 步无进展 → 暂停 → 降级 manual
  → 汇总：把各 step output 拼装 → 最终 summary 返回
  → renderer 展示协作过程（谁做了什么 + 接力链）
```

---

## 6. 共享知识（跨文件约定）

- **IPC 命名空间**：`agent:*`（智能体）、`browser:*`（浏览器）、`swarm:*`（群协作）、`control:*`（沿用，扩展 phase）。所有 handler 经 `register/ipc.register.ts` 的 `validateSender` 来源鉴权。
- **返回格式**：invoke 统一 `{ success: boolean, data?, error? }`（与 self-modify 一致）；广播用 `webContents.send` + `sendToAllWindows`。
- **时间戳**：一律 `number`（`Date.now()` 毫秒），与 self-modify `createdAt` 一致。
- **ID 前缀**：智能体 `agt-`，群协作任务 `swarm-`，步骤 `step-`，避免与现有 `agent-`/`tool-` 冲突。
- **配置**：所有新配置项必须加入 `config.ipc.ts` 的 `ALLOWED_CONFIG_KEYS` 白名单，否则 `config:set` 拒绝写入。
- **安全底线**：渲染进程传入的 agentId/toolName/路径一律视为不可信，main 进程强制校验（agent-store.validate / whitelist / 浏览器导航拦截）。
- **模型调用**：统一走 `modelManager.generateResponse(prompt, opts)`（返回 string）；结构化产出必须 `tryParseXxx` 严格解析 + 失败降级，不做直接 eval/信任。
- **preload 类型**：新增 channel 需同步追加到 `src/preload/index.ts` 的 `IpcChannels` 联合类型，否则 TS 报错。

---

## 7. 待明确事项（给团队，非阻塞设计）

1. **人设双目录漂移（最重要）**：根目录 `personas/`（25 套 brain_*）与 `resources/personas/`（44 套）两套并存，`persona-loader` 实际读 `resources/personas`。PRD 提到"20 套人设：personas/ 目录"，但 canonical 是 resources。**需确认以哪套为准**，建议：brain_* 系列（根目录）为"智能体 OS 专用 20 套"，由产品经理/团队拍板是否合并或仅用其中一套作为 `personaId` 引用源。
2. **紧急暂停快捷键**：`Ctrl+Shift+Escape` 可能与系统任务管理器冲突，建议 `Ctrl+Shift+F12` 或让用户自定义。需产品确认默认值。
3. **白名单默认策略**：细粒度 tool 逐个授权 vs 首次给"整类授权"选项（category 级），后者体验好但安全粒度粗。建议默认细粒度 + 设置页提供"整类快捷开"。
4. **浏览器登录态隔离粒度**：默认每标签页独立 partition，是否需要"同源共享登录态"（如所有 *.github.com 共享）？建议先独立，后续按需加 domain 级共享。
5. **群协作并发 vs 串行**：本地单模型常驻，多智能体本质是串行接力（无法真正并行推理）。设计已按"串行拓扑排序"实现，若未来接云端可升级并行。需确认默认串行即可。

---

## 8. 任务分解（≤5 任务，依赖排序）

| 任务 ID | 任务名 | 来源文件 | 依赖 | 优先级 |
|---|---|---|---|---|
| **T01** | 基础设施 + 数据模型 + 存储 | `shared/agent-types.ts`、`main/agent/agent-store.ts`、`shared/config-keys.ts`、`shared/ipc-types.ts`、`preload/index.ts`、`register/ipc.register.ts`、`register/modules.register.ts` | — | P0 |
| **T02** | Agent 运行时 + 工具集改造 | `main/agent/agent-runtime.ts`、`main/agent/react-loop.ts`(改)、`main/agent/tool-registry.ts`(改)、`main/agent/control-tools.ts`、`main/agent/index.ts`(改) | T01 | P0 |
| **T03** | 动态创建 + 白名单 + 紧急暂停 | `main/agent/agent-factory.ts`、`main/agent/permission-whitelist.ts`、`main/agent/panic-stop.ts`、`main/control-state.ts`(改) | T01 | P0 |
| **T04** | 前端智能体页 + 发光特效 | `renderer/pages/Agents/index.tsx`、`renderer/store/agentStore.ts`、`renderer/components/ControlOverlay.tsx`(改)、`renderer/components/layout/Sidebar.tsx`(改) | T01 | P1 |
| **T05** | 内置浏览器 + 群协作编排器 | `main/browser/{index,tab-manager,security,feed-ai}.ts`、`main/agent/orchestrator.ts`、`renderer/pages/Browser/index.tsx`、`renderer/store/browserStore.ts` | T01 | P1 |

> 任务数 = 5，符合硬性上限。每任务 ≥3 文件。T02~T05 仅依赖 T01，可并行。

---

## 附：类图 + 时序图（mermaid）

另存：`docs/agent-os-class-diagram.mermaid`、`docs/agent-os-sequence-diagram.mermaid`。
