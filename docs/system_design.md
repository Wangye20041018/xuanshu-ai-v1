# 玄枢 AI — UX 优化 + 自我改造能力设计

> 架构师 Bob · 已读代码核实（`E:\玄枢AI\xuanshu-ai-dev`）
> 本轮两件事：① UX 深度优化 TOP10 痛点；② 新增"自我改造"能力。

---

# Part A — UX 优化 TOP 10 痛点清单

按"用户可感知程度"排序，每条含 `file:line` 证据 + 具体改法。

## 痛点 1｜启动骨架屏三套并存（每次启动可见，优先级最高）

**证据**
- `src/renderer/index.html:9-63` — 内联 `#app-skeleton`（React 挂载前）
- `src/renderer/App.tsx:181-218` — `if (!appReady)` 又硬编码一套全屏骨架（React 接管后再次显示，视觉跳变）
- `src/renderer/components/LoadingSkeleton.tsx` — 已存在的统一组件，启动流程却未复用

**方案**：保留 `index.html` 内联作为唯一"首屏即时骨架"；把 `App.tsx:181-218` 的硬编码骨架替换为 `<LoadingSkeleton variant="page" loadingText="正在启动…" />`（视觉与首屏对齐）；`main.tsx:47-48` 隐藏内联骨架的时机由 `app:ready` 控制，避免"消失又出现"。

## 痛点 2｜IPC 失败大量静默，用户无感知、无重试

**证据**
- `src/renderer/pages/Automation/index.tsx:293-295` 加载失败仅 `logger.error`，页面空白无提示
- `Automation/index.tsx:328` 删除失败静默；`Automation/index.tsx:347` 执行失败静默
- `src/renderer/pages/Memory/index.tsx:484-488` `loadStats` 失败静默
- `src/renderer/pages/Voice/index.tsx:135-137` TTS 状态检查失败仅 log

**方案**：在 `src/preload/index.ts` 的 `invoke` 上做一层 `invokeSafe`（或 renderer 侧 `hooks/useAsync.ts`），统一捕获 reject → `showToast('error', …)`；每个列表页失败时渲染 `ErrorDisplay`（含"重试"按钮）。目标是"任何失败都有 toast + 可重试入口"。

## 痛点 3｜空态组件 4 套实现，风格割裂

**证据**
- 共享组件 `src/renderer/components/EmptyState.tsx`（仅 `Home/HomeHeader.tsx:52` 用了）
- 本地组件 `Automation/index.tsx:136-170` 自定义 `EmptyState`
- 内联空态 `Knowledge/index.tsx:530-546`、`Memory/index.tsx:1147-1167`、`Plugins/index.tsx:845-852`

**方案**：删除本地 `EmptyState`，Knowledge/Memory/Plugins/Automation 全部改用共享 `EmptyState`（带 `action`/`secondaryAction` 按钮，覆盖"添加知识/新建自动化"等引导入口）。

## 痛点 4｜双 Toast 体系，样式行为不一致

**证据**
- 全局 `src/renderer/components/Toast.tsx`（`showToast` + `ToastContainer`，App 已挂载）
- `src/renderer/pages/Plugins/index.tsx:51,125,161,400-420` 另写了一套本地 `ToastState`（顶部居中、无图标、颜色不同）

**方案**：Plugins 删除本地 Toast，统一调 `showToast`；`router:toast`（`RouteStatusIndicator.tsx:30` 已监听）也统一转发到全局 Toast。

## 痛点 5｜首次启动无新手引导，危险能力无使用说明

**证据**
- 全局 grep 无 onboarding/tour/welcome 流程（仅 HomeHeader 的"示例引导"文案）
- 危险工具 `control_computer`（`tool-registry.ts:327`，`dangerous:true`）首次触发仅弹确认门，无能力边界说明

**方案**：新增 `Onboarding` 流程（3-4 步，首次启动 localStorage 标记）；对桌面自动化/自我改造等危险能力，首次使用时弹"能力说明 + 风险 + 确认"卡片，而非简单 yes/no。

## 痛点 6｜硬编码色未清干净（renderer 内 150 处 hex）

**证据**
- `Automation/index.tsx:73,90,178` `#a78bfa`、`#3b82f6`
- `Model/index.tsx` 多处 `#a78bfa`/`#3b82f6`；`Home/index.tsx:599` `#3b82f6`
- `Plugins/index.tsx:825` 内联 `rgba(239,68,68,...)`

**方案**：在 `src/renderer/shared/theme.ts` 补充 token（`violet`/`blue` 等），批量替换硬编码；仅暗色主题 → 后续可低成本加亮色。

## 痛点 7｜加载态不统一（文字 vs 骨架）

**证据**
- `Plugins/index.tsx:373-382` `加载中...` 纯文字（其余页面用 `LoadingSkeleton` 或内联）
- `Memory`/`Knowledge` 无列表加载态，首次进入直接空态闪烁

**方案**：统一 `LoadingSkeleton`（list/card 变体）；数据未返回前显示骨架而非"空态"，避免误判。

## 痛点 8｜设置项扁平难找（10 个子页无分组/搜索）

**证据**
- `Settings/` 下 10 个 `Settings*.tsx`，`index.tsx` 平铺渲染

**方案**：设置页左侧加分组导航（通用/语音/自动化/权限/技能包…）或顶部搜索；常用开关（自动启动、麦克风、唤醒词）上提为"常用"区。

## 痛点 9｜无障碍未穷尽

**证据**
- 图标按钮仅 `title` 无 `aria-label`：`Automation/index.tsx:822-831`（删除）、`Plugins/index.tsx:917-931`（卸载）
- 模态框 Escape/FocusTrap 不一致：`Memory` DetailModal 有 Escape，`Knowledge`/`Automation` 模态无

**方案**：抽统一 `Modal` 组件（内置 FocusTrap + Escape + aria-labelledby），逐页替换；图标按钮补 `aria-label`。

## 痛点 10｜Memory 页面注释乱码 + 空行泛滥（可维护性 → 迭代速度）

**证据**
- `Memory/index.tsx:15,43,83,119` 等大量 mojibake 注释（`Ã¥Â¿Â™...`）+ 大量双空行

**方案**：prettier 格式化 + 修复注释编码，避免后续改动雪球。

---

# Part B — "自我改造"能力完整设计

## B1. 能力边界（白名单 + 分级）

**允许改造目录（白名单）**
```
src/renderer/**   (UI 层)
src/main/**        (业务层，排除下方黑名单)
src/shared/**      (类型/常量)
personas/**        (提示词 / 人设)
docs/**
```

**绝对禁止（黑名单）**
```
package.json / package-lock.json / *.config.ts|js / electron-builder*.yml
resources/** (二进制/模型/字体)  node_modules/**  .git/**  out/**  dist/**
engine/** (Python 推理引擎)  *.log  .env*  私钥/证书
src/main/register/**  src/main/process-guardian.ts  src/main/secure/**
src/preload/**  src/main/agent/react-loop.ts  src/main/index.ts  (架构性文件)
```

**改动类型分级**
| 级别 | 内容 | 默认 |
|---|---|---|
| L0 只读 | 列文件 / 读源码 | 开放 |
| L1 低风险 | 文案、样式 token、提示词/人设、config | 开放 |
| L2 中风险 | 组件行为、业务 handler 内纯逻辑 | 逐次确认 |
| L3 高风险 | agent 核心、preload、register、IPC 骨架 | 默认禁止，需 dev 开关 |

**只读/写分离**：默认 `writeEnabled=false`，只读分析随时可用；写模式需在设置页显式开启。

## B2. 安全机制（硬底线）

1. **git 快照兜底**：每次 `apply` 前 `git add -A && git commit -m "self-modify:snapshot <ts>"`，记录 `snapshotHash`（仓库已有 baseline commit，可直接回退）。
2. **diff 确认门**：复用 `confirmIfDangerous`（`react-loop.ts:257`）思路，但确认载体是**完整 diff**（文件清单 + 增删行），不是 boolean。
3. **防误删/逃逸**：路径规范化 + 白名单强制校验（main 进程执行，渲染进程传入路径一律不可信）；拒绝 `..`/符号链接/绝对路径逃逸；单次改动文件数 ≤5、单次 diff 行数 ≤300；默认禁止整文件删除。
4. **写操作原子性**：snapshot → 写 → 校验；任一步失败自动 `git checkout <hash> -- <files>` 回退。
5. **审计日志**：每次改动记录 `who/what/when/diff摘要` 到应用数据目录 `self-modify.log`。
6. **写权限只在 main 进程**：渲染进程只发起与展示，不直接 fs 写。

## B3. 技术方案

### 数据流
```
用户自然语言 → 模型理解(复用 modelManager 本地LLM)
  → L0: list-files + read-file 读源码
  → 生成 patch (diff 文本)
  → preview-diff 生成 diff
  → 渲染进程 DiffViewer 展示 + 用户确认
  → apply: git snapshot → 写文件 → 校验
  → 生效: renderer改→reload / main改→relaunch / 配置人设→热加载
  → 失败: rollback(snapshotHash)
```

### IPC 通道清单
| 通道 | 方向 | 说明 |
|---|---|---|
| `self-modify:get-capabilities` | invoke | 返回白名单/分级/writeEnabled |
| `self-modify:list-files (dir?)` | invoke | 仅白名单内文件清单 |
| `self-modify:read-file (path)` | invoke | 读单文件（含截断标记） |
| `self-modify:generate (requirement)` | invoke | 走模型生成 plan + patch |
| `self-modify:preview-diff (changeSet)` | invoke | 生成 diff 供展示 |
| `self-modify:apply (changeSet)` | invoke | 快照→写→校验，返回 snapshotHash |
| `self-modify:rollback (snapshotHash)` | invoke | 回退到快照 |
| `self-modify:list-snapshots ()` | invoke | 历史快照列表 |
| `self-modify:progress` | send | 进度事件 |

**ChangeSet / DiffResult schema（示意）**
```ts
interface ChangeSet {
  files: Array<{ path: string; content: string; mode: 'patch'|'overwrite' }>
  summary: string
}
interface DiffResult {
  filesAffected: string[]
  additions: number
  deletions: number
  diffText: string          // unified diff
  estimatedRisk: 'L0'|'L1'|'L2'|'L3'
}
interface Snapshot { hash: string; createdAt: number; files: string[] }
```

### 与 ReAct 的关系（推荐双轨）
- **方式 A（MVP 主路径）**：独立流程页 `SelfModify` + 独立 IPC，**写操作全部走流程页人工确认**（diff 需要丰富 UI，ReAct 的 boolean confirm 承载不了）。
- **方式 B（进阶）**：向 `toolRegistry` 注册 3 个**只读**工具（`self_modify_list_files`/`self_modify_read_file`/`self_modify_preview_diff`，category:`system`），让用户在聊天里"帮我看看某页面代码"走 ReAct；`self_modify_apply` 写工具标记 `dangerous:true` + confirm 回调（弹 diff 确认），默认**不注册**。

### 生效机制
- renderer 改 → `webContents.reload()`
- main 改 → `app.relaunch() + app.exit(0)`
- 配置/人设/shared 改 → 热加载对应模块（persona reload / config reload）

### 新增/修改文件清单
```
新增:
  src/shared/self-modify-types.ts           # 共享类型
  src/main/self-modify/whitelist.ts         # 白名单/分级规则
  src/main/self-modify/self-modify.service.ts # snapshot/diff/apply/rollback/审计
  src/main/self-modify/self-modify.ipc.ts   # IPC handler 注册
  src/renderer/pages/SelfModify/index.tsx   # 流程页
  src/renderer/components/SelfModify/DiffViewer.tsx
  src/renderer/store/selfModifyStore.ts     # zustand
修改:
  src/main/register/ipc.register.ts         # 接入 handler
  src/main/register/modules.register.ts     # 初始化 service
  src/preload/index.ts                       # 补 channel 类型
  src/main/agent/tool-registry.ts            # (可选)只读工具
  src/renderer/components/layout/Sidebar.tsx # 入口
```

## B4. 任务分解（≤5 任务，依赖排序）

| ID | 任务 | 文件 | 依赖 | 优先级 |
|---|---|---|---|---|
| T01 | 基础设施 + 类型 + IPC 骨架 | `shared/self-modify-types.ts`、`main/self-modify/whitelist.ts`、`self-modify.ipc.ts`、`preload/index.ts`、`register/ipc.register.ts`、`register/modules.register.ts` | — | P0 |
| T02 | 核心服务（快照/diff/apply/rollback + 审计） | `main/self-modify/self-modify.service.ts` | T01 | P0 |
| T03 | 只读工具接入 ReAct（可选） | `main/agent/tool-registry.ts` | T01 | P1 |
| T04 | 前端流程页 + Diff 展示 | `pages/SelfModify/index.tsx`、`components/SelfModify/DiffViewer.tsx`、`store/selfModifyStore.ts`、`Sidebar.tsx` | T02 | P0 |
| T05 | 生效机制 + 回退 UI + 端到端联调 | 上述 + `main` 窗口 reload/relaunch | T02, T04 | P1 |

## B5. 风险点 & 安全底线（重点标注）

1. **本地模型代码质量不可控** → 强制 diff 人工确认 + 快照回退兜底，绝不自动落地。
2. **路径信任** → 白名单校验必须在 main 进程强制，渲染进程输入一律视为不可信。
3. **原子性** → 写前快照、写失败自动回退，杜绝半写状态。
4. **禁改安全面** → preload / register / process-guardian / secure / react-loop / 入口文件 列入黑名单，禁止 AI 触碰。
5. **禁止动态 eval** → 不运行时加载未审查代码，改动只走"写文件→重启/重载"。
6. **写模式默认关闭** → 设置页显式开启"自我改造-写模式"。

## B6. 待拍板项

1. 写模式默认开启还是需设置开关？（建议默认关）
2. 改造用哪个模型？（默认本地 `defaultModelId` vs 允许指定 coding 模型）
3. L2/L3 是否开放？开放到何种程度？（建议 L3 默认禁）
4. 是否注册 ReAct 写工具，还是仅流程页？（建议仅流程页 + 只读工具）
5. git 快照用 commit（污染历史）还是 `git stash create`（轻量）？（建议 commit + 标签，便于人工排查）
