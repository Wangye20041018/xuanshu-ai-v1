# UI-1~UI-4 改造映射与 Mock 方案（落地施工图）

> 作者：豆包（UI）｜日期：2026-09-02｜状态：**设计草稿（等待期产出，未改 renderer 代码）**
> 配套：视觉取值一律以《01_玄枢xTrae视觉规范_v1.md》为准。本文件回答"**改哪个文件、新建什么、数据从哪来、后端没好怎么先跑起来**"。
> 硬边界：只动 `src/renderer`；不动 `src/main`、`src/shared`、`src/preload`；不删后端功能。
>
> **【v2 更新 22:15】已核对 workbuddy《03 交付说明》与源码：A-4 事件已落地**——两通道已进 preload 白名单（`src/preload/index.ts:351-352`），共享类型已导出（`src/shared/agent-types.ts:231-256`）。本版据此改为**强类型直连**，并修正工具状态枚举差异（见 §2.1、§7）。

---

## 0. 一页总览：任务 × 落点 × 依赖 × 能否先行

| 任务 | 主要新建（renderer） | 主要修改（renderer） | 后端依赖 | 现状 / 可否先行 |
|---|---|---|---|---|
| **UI-1 步骤圆点面板** | `components/taskflow/*`、`store/taskRunStore.ts`、`hooks/useTaskRunEvents.ts` | `pages/Home/ChatPanel.tsx`（挂载） | `xuanshu:task-step` | ✅ 事件已就绪；组件可先做，mock 看观感 |
| **UI-2 工具调用过程行** | 同上（`ToolCallLine`） | `ChatPanel.tsx`、`messageRender.tsx`（折叠行统一） | `xuanshu:tool-call` | ✅ 事件已就绪（注意状态枚举 start/done/error） |
| **UI-3 回答格式升级** | 可选 `utils/highlightLite.ts` | `pages/Home/messageRender.tsx` | 无（纯渲染） | ✅ 完全独立 |
| **UI-4 布局轻量化** | 无（或少量样式组件） | `globals.css`、`layout/TitleBar|Sidebar|StatusBar.tsx`、`ChatPanel.tsx` | 无 | ✅ 独立；**只换皮不裁页，页面删留等 Trae 清单** |

结论：**后端事件侧已不阻塞**；UI-1/UI-2 可直接强类型订阅真实事件，mock 仅用于"本机没加载模型、触发不了真实任务"时调观感。

---

## 1. 现状关键事实（均来自实读，作为改造基线）

- **应用骨架** `App.tsx`：`.app-layout` = `Sidebar` + `.app-main`(`TitleBar` + `.app-content`(路由) + `StatusBar`)；首页 `/`=`Home`，其余 10 页懒加载。
- **首页** `pages/Home/index.tsx`（870 行）：`Home/StatusBar` + ai 建议条 + **`ChatPanel`（主体）** + 空态 `HomeHeader` + `RightPanel` + **`TaskProgressOverlay`（不订阅事件的空壳，见 §6 处置）**。
- **对话流** `pages/Home/ChatPanel.tsx`：`renderMessages()` 里 `messages.map(renderMessage)`；`renderMessage()` 按内容分流（`_tandem`/`_task` JSON 卡片，否则 `parseMessageContent` 分块 code/table/image/file/video/text），AI 消息顶部有 `ReasoningBlock`；`inputBar` 顶部内嵌 `<AgentRunner />`，maxWidth 860 居中。
- **消息渲染** `pages/Home/messageRender.tsx`：`CodeWindow`（mac 三色点+语言+行号+复制+折叠，**单色无真高亮**）、`ReasoningBlock`（小灰折叠行＝UI-2 过程行的样式近亲）、`TableCard`、`TypingDots`（三跳点，拟物，待换）、`renderInlineFormatted`。
- **既有"步骤"资产**：
  - `components/TaskCard.tsx`：消息内 `_task` 卡片（发光圆点+进度条+展开+追加/结束）；
  - `components/TaskProgressOverlay.tsx`：注释明示 task:*/scheduler:* 已废弃、不再订阅，恒 `visible=false`——**死组件**；
  - `pages/Home/AgentRunner.tsx`：订阅 `swarm:event`，含可借鉴的 `stepState()` 聚合状态机与步骤回放圆点，但属"团队编排"专属、藏输入框折叠区、10–11px 过密。
- **状态** `store/chatStore.ts`：Zustand+persist 持久化 `conversations/messages`；`ChatMessage={id,role,content,reasoning,timestamp}`（字符串内容，特殊卡片靠 JSON 前缀）。
- **IPC 接缝（已核实）**：
  - `api.on(channel, (event, ...args)=>unsub)`——**回调首参是 `IpcRendererEvent`，payload 在第二参**（参照 AgentRunner：`api.on('swarm:event', (_e, p)=>…)`）；
  - 两通道**已在 `IpcChannels` 白名单**（`preload/index.ts:351-352`），可强类型订阅，**无需 as any**；
  - 共享类型已导出，**只 import type、不改 shared**。
- **renderer 引 shared 用相对路径**（无路径别名）：`store|hooks` → `'../../shared/agent-types'`；`components/taskflow/*`（深一层）→ `'../../../shared/agent-types'`。
- 三态组件齐备：`EmptyState / LoadingSkeleton / ErrorDisplay`。
- 本机 **git 不可用**，防撞唯一手段＝协作快照 `xuanshu_diff.py`。

---

## 2. 数据层：新增 ephemeral「任务运行」store（不污染持久化会话）

### 2.1 事件类型（直接复用 workbuddy 定稿，UI 只做视图归一化）
`src/shared/agent-types.ts` 已定义（**不改它，只 import type**）：
```ts
TaskStepEvent { stepId, title, status:'pending'|'running'|'done'|'failed', detail?, ts }
ToolCallEvent { tool, argsSummary, status:'start'|'done'|'error', resultPreview?, ts }  // 注意：无 callId、无 runId
```
> **关键差异**：步骤状态用 `running`，工具状态却用 `start`；UI 内部统一成一套视图态，避免组件里到处判分支：
```ts
// components/taskflow/types.ts
import type { TaskStepEvent, ToolCallEvent } from '../../../shared/agent-types'
export type UiState = 'pending' | 'running' | 'done' | 'failed'
export type StepView = TaskStepEvent                       // 步骤四态与 UI 同名，直接用
export interface ToolView {                               // 工具调用的 UI 视图模型
  uid: string            // UI 本地生成（后端未给 callId）
  tool: string; argsSummary: string; resultPreview?: string
  state: UiState; ts: number
}
export const toolUiState = (s: ToolCallEvent['status']): UiState =>
  s === 'start' ? 'running' : s === 'done' ? 'done' : 'failed'
```

### 2.2 为什么独立 store 而不进 chatStore
UI-1/2 是高频、实时、临时数据。写进被 persist 的 chatStore 会反复写 localStorage 且把易变过程态固化进历史。故新建**不持久化** store。

### 2.3 新建 `src/renderer/store/taskRunStore.ts`（Zustand，无 persist）
```ts
state: { run: { steps: StepView[]; tools: ToolView[]; startedAt:number|null; finished:boolean } | null }
actions:
  beginRun()                       // 幂等：已有未结束 run 则复用
  upsertStep(p: TaskStepEvent)     // 同 stepId 覆盖、否则按到达顺序追加
  toolStarted(p: ToolCallEvent)    // 生成 uid，push 一条 state=running
  toolEnded(p: ToolCallEvent)      // 配对收尾（规则见下），写 state + resultPreview
  finishRun() / reset()
```
**无 callId 的配对兜底（重要）**：`done/error` 到达时，取 tools 中**最后一个 `tool 名相同且 state=running`** 的项收尾（LIFO 同名配对）；找不到则作为独立终态条目追加（不丢事件）。若 workbuddy 日后补 `callId`，只需把这里改成按 id 精确配对，组件零改动。
顺序/封顶：保持后端推送顺序，steps/tools 各设上限（如 200）防洪泛，超出丢最旧并计数；**不自行重排、不编造结果**，缺字段就不渲染对应区域。

### 2.4 新建 `src/renderer/hooks/useTaskRunEvents.ts`（唯一对接后端处，强类型）
```ts
import type { TaskStepEvent, ToolCallEvent } from '../../shared/agent-types'
useEffect(() => {
  const api = window.api
  const offStep = api.on('xuanshu:task-step', (_ev, p: TaskStepEvent) => { useStore.getState().upsertStep(p) })
  const offTool = api.on('xuanshu:tool-call', (_ev, p: ToolCallEvent) => {
    const s = useStore.getState(); s.beginRun()
    p.status === 'start' ? s.toolStarted(p) : s.toolEnded(p)
  })
  return () => { offStep(); offTool() }
}, [])
```
- 在 `Home/index.tsx` 顶层调用**一次**，全局只订阅一遍。
- **无 runId 的运行边界**：首个 `task-step`（或任一工具事件）到来时 `beginRun`；当所有 step 进入 `done/failed` 且无 running 工具、或 ChatPanel `isStreaming` 由 true→false 时 `finishRun`；下一次发送/首个新事件时 `reset→beginRun`。以步骤为主线、工具为附属。

---

## 3. UI-1 步骤圆点面板 —— 组件拆分与落点

### 3.1 新建 `src/renderer/components/taskflow/`
| 文件 | 职责 |
|---|---|
| `types.ts` | §2.1 的视图类型与 `toolUiState` 归一化 |
| `StepDot.tsx` | 四态圆点原子（pending 空心灰/running 蓝 spinner/done 绿✓/failed 红✗），规格见视觉规范 §4.1，**无发光** |
| `StepItem.tsx` | 单行：StepDot+标题+括号补充+chevron；点击展开 `detail`；failed 整行偏红且默认展开原因 |
| `TaskStepTimeline.tsx` | 步骤列表 + 左侧竖向引导线，遍历 `run.steps` |
| `ToolCallLine.tsx` | UI-2 过程行（§4） |
| `TaskRunTimeline.tsx` | **对外主组件**：组合步骤时间线 + 工具过程行，订阅 store，空则返回 null |

### 3.2 状态来源
后端 `TaskStepEvent.status` 即权威值，前端只做同 stepId 覆盖（不再像 AgentRunner 那样由一堆 start/done 事件自行推断）。视觉映射严格按视觉规范 §4.1/§4.2。

### 3.3 挂载位置（`ChatPanel.tsx`，对齐 Trae 单栏流）
- 在 `renderMessages()` 列表内、**当前运行中的 assistant 消息下方**插入 `<TaskRunTimeline />`：进行中随事件实时刷新；运行结束停在最终态；下一轮 reset。
- 一期只做**当前运行实时时间线（ephemeral）**；"历史会话回放当时步骤"需把快照随消息持久化，列**二期**（避免现在改 chatStore 持久化结构）。
- 不用浮层：步骤就在主流内，不采用 `TaskProgressOverlay` 底部居中浮层形态。

### 3.4 交互
点行展开/折叠；失败红色+原因；button + aria-expanded 键盘可达；respect `prefers-reduced-motion`。

---

## 4. UI-2 工具调用过程行 —— 聚合摘要 + 可展开明细

### 4.1 两级结构（仿"已执行 N 条命令 〉"）
- **收起态 `ToolCallLine`（主行）**：13px 灰行 + 线性小图标 + **聚合文案**：`已读取 N 个文件`、`已执行 N 条命令`、`已调用 N 次工具`，或单工具 `调用 · {tool}`；右侧 chevron；运行中前置 12px 蓝 spinner，整体完成转静态并出 ✓。
- **展开态明细**：每条工具一行 = `tool`（mono 12px）+ `argsSummary`（超长省略、title 全文）+ 状态点/✓/✗；再展开显示 `resultPreview`（≤3 行，超出"展开全部"）。
- **实时性**：`start` 先插入 running 行，`done/error` 按 §2.3 配对收尾，不等整轮。

### 4.2 与 ReasoningBlock 统一
`messageRender.tsx` 的 `ReasoningBlock` 与本过程行是同一视觉语言（小灰行+chevron）。落地抽共享 `CollapsibleMetaLine`，杜绝同屏两种折叠行样式。

---

## 5. UI-3 回答格式呈现升级（纯渲染，零后端依赖）
落点 `pages/Home/messageRender.tsx`。
1. **代码语法高亮（补现状短板）**：现 `CodeWindow` 仅单色行号。
   - 推荐**零依赖**：新增 `utils/highlightLite.ts`，有限正则分 关键字/字符串/注释/数字/函数名 五类，低饱和深色配色，约百行、不增 bundle、契合本地离线优先。
   - 备选 prismjs/shiki（包体大，不推荐，除非明确要求）。
   - 保留并打磨一键复制、语言标签、行号、流式中不折叠/结束后折叠。
2. **长回答分节（结论→步骤→细节）**：不改模型文本，渲染层强化——识别 `##/###` 做分节标题；任务类有序列表/`- [ ]` 渲染为步骤清单（序号用 StepDot 同款语言）。一期做标题层级+清单美化；"结论/步骤/细节快捷锚点条"列二期。
3. 流式逐 token 渲染不回退。

---

## 6. UI-4 全局布局轻量化（只调视觉/层级，不删功能页）
| 文件 | 改动（仅视觉/样式，功能不动） |
|---|---|
| `styles/globals.css` | 落视觉规范 §3：新增 `--status-*`/`--taskflow-*`；校准表面色与字号下限；任务流去 accent-glow/inset-hi；卡片统一 12 圆角；功能 UI 去衬线 |
| `components/layout/TitleBar.tsx` | 极简：左侧补两线性图标位（历史/搜索，**功能映射等 Trae 清单，不新增后端能力**），中可放视图名，右侧窗口按钮保留 |
| `components/layout/Sidebar.tsx` | 降权：240→220、项高 38→34、激活态改"左 2px 蓝指示条+透明底"、分组标题弱化、折叠 64→56；**导航项一个不删**（裁留听 Trae 清单） |
| `components/layout/StatusBar.tsx` | 保留 CPU/内存/GPU/在线（本地算力特色），11px 弱色，阈值变色逻辑不动 |
| `pages/Home/ChatPanel.tsx` | 输入区去玻璃渐变/内高光/辉光，实底+1px 边框、focus 改蓝；maxWidth 860→`--taskflow-max 760`；`TypingDots` 换 14px 蓝 spinner+文案；主列居中单栏 |
| `pages/Home/AgentRunner.tsx` | 不重写功能；步骤回放圆点/徽章改用统一 `StepDot`/状态色，字号 10–11 抬到 12–13 |
| `components/TaskProgressOverlay.tsx` | **死组件**：从 `Home/index.tsx:867` 摘除挂载（本就恒不显示），文件先不删、登记《UI 侧建议删减清单》交 Marvis→Trae 裁决 |
| `shared/theme.ts`（renderer 内） | `HEX_COLORS` 补 status 四色字面量（供内联 alpha），与 globals 变量同值 |
| `App.tsx` | 结构不动；启动诊断面板若仍用衬线大标题顺手改无衬线（可选） |

> 注：`src/renderer/shared/theme.ts` 是 renderer 自己的主题文件（可改）；`src/shared/agent-types.ts` 是三方共享（只 import 不改），二者勿混。

---

## 7. 与 workbuddy 的接口接缝（**A-4 已交付，以下为核对结果 + 非阻塞增强建议**）

**已就绪（已核对源码，可直接用）**
1. 通道白名单：`preload/index.ts:351-352` 已含两通道 → 强类型 `window.api.on(...)`，无需 as any。
2. 共享类型：`shared/agent-types.ts:231-256` 导出 `TaskStepEvent/ToolCallEvent`，renderer 以相对路径 `import type` 复用。
3. 推送点：`orchestrator.runStep` 推 task-step；`tool-registry.execute` 推 tool-call；沿用既有 `sendToAllWindows` 广播。
4. 回调签名：`(_event, payload)`，payload 在第二参。

**枚举差异（UI 侧已归一化，无需后端改）**
- 步骤：`pending/running/done/failed`；工具：`start/done/error`。UI 用 `toolUiState()` 统一为 `running/done/failed`（§2.1）。

**非阻塞增强建议（当前 UI 已兜底，可后续再议，不影响开工）**
- 建议 `tool-call` 补 `callId`：现无 id，UI 用"LIFO 同名配对"兜底（§2.3），并发同名工具时可能错配；补 id 后改按 id 精确配对（仅改 store）。
- 建议两类事件补 `runId` 并显式 `run-start/run-end`：现 UI 用"首个事件开始 / 全部终态或 isStreaming=false 结束"推断边界；补 runId 后多任务并发更稳。
- 请确认 `detail/resultPreview/argsSummary` 的**截断长度与脱敏规则**（交付说明称已脱敏截断），UI 只负责展示，不再二次猜测。

---

## 8. Mock 方案（本机无模型时也能把 UI-1/2 做到以假乱真并截图）
新建 `src/renderer/mock/taskRunMock.ts`：
- 一条逼真任务时间轴（参照 Trae 抓帧：建立安全基线→建立编译基线→运行回归…），覆盖步骤四态（含一次 failed+原因）与工具 start→done/error。
- `playMockRun()`：按 300–700ms 节奏依次调 taskRunStore，模拟实时到达；**工具 mock 事件的 status 用后端真实枚举 `start/done/error`**，顺带验证归一化逻辑。
- 触发仅开发态：`import.meta.env.DEV` 且 URL `?mocktask=1`（或 dev 快捷键）出临时启动按钮；生产构建不含触发入口、不打包假结果。
- 联调/加载模型后直接消费真实事件，组件与 store 原样复用，仅移除 mock 触发。

---

## 9. 实施顺序（每批＝落盘前 diff 防撞 + 落盘后 tsc 零错 + dev 截图）

> 正式改 renderer 仍**等 Trae《保留页面与功能清单》到位**（避免改到将删页面）。其中"批次1 纯新增组件 + mock"不触碰任何现有页面、风险最低，可最早开始；UI-4 只换皮不裁页。

- **批次 0｜全局基调（UI-4 主体，纯视觉）**：globals token/字体/去辉光 → Sidebar/TitleBar/StatusBar → ChatPanel 输入区。
- **批次 1｜UI-1/2 组件（纯新增，零侵入）**：types→taskRunStore→taskflow 五组件→useTaskRunEvents（**直接强类型连真实通道**）→mock。`?mocktask=1` 下四态/展开/失败正确，对照抓帧。
- **批次 2｜接入对话流**：ChatPanel 挂载 TaskRunTimeline、messageRender 折叠行统一、TypingDots 替换。
- **批次 3｜UI-3**：highlightLite 接 CodeWindow、长回答分节/清单化。
- **批次 4｜统一与清理**：AgentRunner 步骤视觉统一、摘除 TaskProgressOverlay 挂载并登记删减清单。
- **批次 5｜真机联调**：加载模型跑真实复杂任务，核对真实事件时序与配对；移除 mock 触发；历史回放列二期。

每批命令：
```
# 落盘前：只在 NO_CHANGES 或仅 [豆包(UI)] 时继续；出现 main/shared 改动立即暂停回报
python <marvis workspace temp>/xuanshu_diff.py
npx tsc --noEmit     # 零错误
npm run dev          # 逐屏截图，对照 01 规范与 Trae 抓帧
```

---

## 10. 文件改动总表（自检与防撞）
**新增（均在 src/renderer）**
```
components/taskflow/types.ts
components/taskflow/StepDot.tsx
components/taskflow/StepItem.tsx
components/taskflow/TaskStepTimeline.tsx
components/taskflow/ToolCallLine.tsx
components/taskflow/TaskRunTimeline.tsx
store/taskRunStore.ts
hooks/useTaskRunEvents.ts
utils/highlightLite.ts
mock/taskRunMock.ts            # 仅 dev，联调后去触发
```
**修改（均在 src/renderer）**
```
styles/globals.css
shared/theme.ts                # renderer 自己的主题文件，非 src/shared
pages/Home/ChatPanel.tsx
pages/Home/messageRender.tsx
pages/Home/AgentRunner.tsx
pages/Home/index.tsx           # 挂 hook、摘除 TaskProgressOverlay 挂载
components/layout/TitleBar.tsx
components/layout/Sidebar.tsx
components/layout/StatusBar.tsx
```
**绝不触碰**：`src/main/**`、`src/shared/**`（只 import type）、`src/preload/**`、`docs/保留页面与功能清单.md`（Trae 产物）。

---

## 11. 风险与对策
1. **撞车**：每文件落盘前跑 `xuanshu_diff.py`，仅 `NO_CHANGES`/`[豆包(UI)]` 才继续；检出 main/shared 新改动立即停并回报（22:06 快照显示对方正在大规模删旧 engine，renderer 未受影响，继续保持隔离）。git 不可用，不依赖 git。
2. **页面白做**：Trae 保留清单未到前只"换皮不裁页"，不删导航/页面；删留以清单为准，冗余项只进《UI 侧建议删减清单》。
3. **枚举/字段错配**：工具状态 start/done/error 已在 `toolUiState` 单点归一；无 callId/runId 已做 LIFO 配对与边界推断兜底，后端补字段后只改 store。
4. **类型安全**：通道已在白名单，全程强类型、**不使用 as any**；`npx tsc --noEmit` 零错。
5. **性能**：高频事件按 id 覆盖+上限裁剪；长列表后续可上虚拟滚动（一期步骤量级不大，暂不需要）。
6. **零假显示**：所有步骤/工具内容来自真实事件；无事件时不渲染、不写死进度/结果，mock 仅 dev 且有显式开关。

*（v2：已按 workbuddy A-4 真实交付对齐；待 Trae《保留页面与功能清单》到位后按 §9 正式落码。）*
