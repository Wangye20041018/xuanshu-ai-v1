# 玄枢AI 代码审计与产品级修复报告

> 审计对象：`E:\玄枢AI\xuanshu-ai-dev`（玄枢AI v11.2.0，Electron 32 + React 18 + electron-vite）
> 审计范围：`src/` 全部 225 个源文件（主进程 140+ / 渲染层 60+ / 预加载 1 / 共享层若干）
> 结论：本项目功能面极广（本地大模型推理、桌面自动化、视觉代理、UIA、语音克隆、移动通道、知识图谱、RAG），但安全基线、错误处理与产品打磨存在大量欠账。本次已修复 CRITICAL/HIGH 级问题 10 项，并列出全部剩余问题与改造路线。

---

## 一、本次已修复（原地改动，`tsc` 两端 + `electron-vite build` 全部通过）

### 🔴 CRITICAL（命令执行 / 控制链路安全）

| # | 问题 | 位置 | 修复 |
|---|---|---|---|
| 1 | **移动通道配对码经无认证 HTTP 明文泄露** | `src/main/mobile-channel/index.ts` | `/status`、`/pairing-code` 端点不再返回 `pairingCode`（配对码只走受信任 IPC 通道本地展示） |
| 2 | **移动通道 0.0.0.0 绑定 + 配对码可暴力枚举** | 同上 | 增加配对失败速率限制（60s 窗口失败 ≥8 次 → 锁定 60s） |
| 3 | **插件引擎 `execute_command` shell 注入**（`exec` + 字符串拼接 + 黑名单可被 `% ^ "` 绕过） | `src/main/plugin-engine/index.ts` | 改为 `spawn` + 参数数组 + 严格白名单参数校验（仅 http/https、纯数字端口） |
| 4 | **视觉代理 `typeText/pressKeys` PowerShell 双引号注入** | `src/main/visual-agent/interaction-executor.ts` | SendKeys 文本经 Base64 + `-EncodedCommand` 传递，任意字符无法突破引号注入 |
| 5 | **视觉代理 LLM 决策直驱鼠标/键盘，全程无确认门**（prompt-injection → 任意操作） | `src/main/visual-agent/index.ts` | `executeTask` 入口增加人工确认对话框；`visual:click/type/press-keys/drag/scroll` 等裸通道全部加确认门 |

### 🟠 HIGH（稳定性 / 一致性）

| # | 问题 | 位置 | 修复 |
|---|---|---|---|
| 6 | **首页问候语问题（用户点名）**：产出「玄枢AI·下午好」非真问候、时段硬编码中文、`home.greeting` 死键、无"早上好"、跨时段不刷新 | `src/renderer/pages/Home/messageRender.tsx`、`HomeHeader.tsx`、`i18n/index.ts` | 重写 `getGreeting` 走 i18n 时段键，补"早上好"，加 30s 轮询跨时段自动刷新 |
| 7 | **`chatStore` 顶层直接访问 `localStorage`**（非浏览器环境/隐私模式抛错） | `src/renderer/store/chatStore.ts` | 增加 `typeof window` 守卫 + try/catch 探测 + 内存 fallback |
| 8 | **`TaskProgressOverlay` IPC 监听清理全 no-op**（依赖不存在的 `api.removeListener`） | `src/renderer/components/TaskProgressOverlay.tsx` | 改用 `api.on` 返回的退订函数 |
| 9 | **Toast 自动关闭定时器卸载不清理** | `src/renderer/components/Toast.tsx` | 用 `Set` 追踪定时器，卸载时统一 clear |

### ✨ 功能增强（用户点名）

| # | 项 | 位置 | 说明 |
|---|---|---|---|
| 10 | **控制电脑屏幕特效升级** | `src/renderer/components/ControlOverlay.tsx` | 危险分级配色（高风险=红 / 输入模拟=琥珀 / 普通=品牌蓝紫）、顶部 HUD 状态条（STATUS/T+耗时/OPS 计数）、底部滚动操作历史 ticker、鼠标"注视"光晕、四角框 + 扫描线 + 雷达动效 |

---

## 二、仍存在的问题（按优先级，未在本轮改动）

### 🔴 CRITICAL（需产品决策，不可贸然改）

| 问题 | 位置 | 建议 |
|---|---|---|
| **全应用 `requestedExecutionLevel: requireAdministrator`** | `electron-builder.yml:38`、`electron-builder.portable.yml:35` | 以管理员运行导致无 UAC 边界，任一注入/远程漏洞即系统级接管。**建议降为 `asInvoker`**，高危操作（注册表/服务/计划任务）通过已有 `run-elevated` 按需提权。此改动需端到端验证提权流程，故本轮未动。 |
| **自签名证书私钥入库 + 依赖自签名规避 SmartScreen** | `electron-builder.yml:42`、`resources/cert/xuanshu-root.pfx` | 私钥随源码/包分发，供攻击者仿冒/篡改签名。建议换正式代码签名证书，或至少将 `.pfx` 移出仓库并加密托管。 |
| **`desktop-automation:task-schedule` 可写任意命令 → 持久化后门** | `src/main/desktop-automation/index.ts:354` | 已有确认框，但 `command` 参数零校验。建议加命令白名单或明确二次确认。 |

### 🟠 HIGH

| 问题 | 位置 | 建议 |
|---|---|---|
| **preload 通用 `invoke` 无运行时通道白名单** | `src/preload/index.ts:555` | `IpcChannels` 只是 TS 编译期 union，运行时任意字符串可透传。建议按窗口（主窗口/悬浮球）分权限 + 运行时白名单。 |
| **全部 IPC handler 无 zod 参数校验** | 全局 | `system:control:execute-command`、`desktop-automation:type-text` 等零运行时校验。建议引入 zod schema 层。 |
| **`type-text` / `send-keys` 无确认门** | `src/main/desktop-automation/index.ts:258-264` | 可模拟任意击键（含 Win+R）。建议与视觉代理一致加确认。 |
| **`plugin:execute` 无确认** | `src/main/ipc/plugin.ipc.ts:28` | 任意 Python/命令执行。建议加确认 + 审计日志。 |
| **屏幕/相机/麦克风/剪贴板无逐次授权** | `system-control.ipc.ts`、`interaction-executor.ts` 等 | `permission` 模块仅信息展示，非硬门控。建议接入 OS 级权限 + 首次使用授权。 |
| **IPC sender 白名单仅进程级，主 frame URL 不校验** | `src/main/utils/ipc-guard.ts:68-79` | 建议加 `will-navigate` 白名单 + 主 frame URL 校验。 |
| **i18n `setLocale` 全库零调用，en_US 死代码** | `src/renderer/i18n/` | 语言切换不可达，硬编码中文约 15+ 文件。建议补语言切换 UI + 逐文件抽词条。 |
| **仅暗色主题，无浅色主题 + 双套 token 混用** | `globals.css`、`theme.ts` | `COLORS.*` 与 `var(--*)` 并存，主题切换会撕裂。建议统一为 CSS 变量。 |

### 🟡 MEDIUM

- `formatRelativeTime` 边界：36h 前也显示"昨天"（`ChatPanel.tsx:72-85`）
- 流式写入读源不一致（`Home/index.tsx:397-414`，切走后仍在流时可能写错数据源）
- `addMessage` 标题命名依赖魔法串 `'新对话'`
- 图标按钮普遍缺 `aria-label`（`ChatPanel.tsx`、`WebSearchPanel.tsx` 等）
- 双 SkipLink（`a11y.tsx:28` 与 `Sidebar.tsx:109`）；`FocusTrap` 导出但零使用
- 组件硬编码颜色破坏主题（`EmptyState`、`ErrorDisplay`、`LoadingSkeleton` 等）
- 问候覆盖层与消息列表叠层、无过渡衔接

### 🟢 LOW / NIT

- 启动骨架屏重复（`index.html` 内联 + `App.tsx` 一套）
- `speakingId` 陈旧闭包（`Home/index.tsx:235`）
- FPS 上报无后台节流（`App.tsx:145-178`）
- JSON 键序检测脆弱（`ChatPanel.tsx:203`，依赖 `_tandem` 键序）
- `hardcoded` TTS token（`tts/edge.ts:133`，微软公开 token，建议配置化）
- lint 全库存在数百个历史 `any`/`require`/`curly` 告警（非本次引入）

---

## 三、改造路线（产品级大厂标准）

1. **安全优先**：`asInvoker` 降权 → zod 参数校验层 → per-window IPC 权限 → 控制类操作统一确认门 + 审计日志落盘。
2. **权限模型**：把「控制电脑」做成显式的、可撤销的权限，OS 级权限（摄像头/麦克风/屏幕录制）首次使用弹授权。
3. **i18n 补全**：语言切换 UI + 抽词条 + 消除硬编码中文。
4. **主题系统**：统一 CSS 变量，补浅色主题，消除组件级硬编码色值。
5. **可观测性**：统一结构化日志 + 操作审计 + 崩溃上报。
6. **发布**：正式代码签名、移除仓库内私钥、NSIS/portable 双通道回归。

---

## 四、验证结果

- ✅ `tsc --noEmit -p tsconfig.node.json`（主进程/预加载）：0 错误
- ✅ `tsc --noEmit -p tsconfig.web.json`（渲染层）：0 错误
- ✅ `electron-vite build`：2001 模块构建成功，`out/main`、`out/preload`、`out/renderer` 全部产出
