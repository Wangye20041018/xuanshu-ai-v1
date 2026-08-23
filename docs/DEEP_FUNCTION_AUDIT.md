# 玄枢AI 深度功能审计报告（第四轮）

> 结论：**用户判断正确。这不是"90% 到位"，而是"前端框架搭得完整、后端核心推理可用，但大量外围功能是空壳桩"。**
> 一句话：**剑胚**——剑柄、剑鞘、纹饰都画出来了，但剑刃（功能闭环）很多地方没开刃。

---

## 一、最硬核的实测：IPC 通道空壳清单

用脚本交叉比对 `preload` 声明的通道 vs 主进程实际注册的 handler/send，结果：

| 维度 | 数字 |
|---|---|
| preload 声明通道 | 405 个 |
| 主进程实际注册 handler | 528 个（含动态/兜底） |
| **真正死通道（声明了但两头都没接）** | **约 80+ 个** |
| 渲染层实际 invoke 通道 | 79 个 |

### 整块死掉的通道族（点一下没反应 / 30 秒超时）

| 模块 | 死通道数 | 具体 |
|---|---|---|
| **task: 任务系统** | 18 个全死 | `task:create/execute/get/get-all/stats/pause/resume/cancel/delete/export/import/templates/intent-match/retry-step/skip-step` |
| **scheduler: 调度器** | 5 个全死 | `scheduler:submit-task/queue-status/cancel/pause/resume` |
| **piper: TTS 引擎** | 3 个全死 | `piper:download/download-models/needs-download` |
| **debate: 辩论** | 3 个全死 | `debate:start/stop/history` |
| **voice-orb: 语音球** | 11 个全死 | `show/hide/toggle/set-state/get-state/set-emotion/set-theme/set-size/toggle-listening` |
| **voice: 语音** | 大量死 | `set-voice/get-voice/adjust-params/set-pitch/set-speed/set-volume/export/import/search` 等 |
| **external-ai** | 部分死 | `history/settings/update-settings/clear-history` |
| **operation** | 部分死 | `list-tasks/history/clear-history/status` |
| **plugin** | 部分死 | `install/store-list` |
| **python** | 部分死 | `get-script/ping` |

## 二、写死在代码里的"未实现"桩（实锤）

| 位置 | 原文 |
|---|---|
| `src/main/ipc/sync.ipc.ts:4` | 文件头直接标 **【状态：未实现】**，`sync:connect`/`sync:send-message` 返回桩响应 |
| `src/main/ipc/system.ipc.ts:339` | `scheduler:cancel-all` —「**调度器未实现**」 |
| `src/main/ipc/system.ipc.ts:312` | `desktop-automation:screenshot` —「**当前未接入**」 |
| `src/main/ipc/system.ipc.ts:317` | `file:search` —「**尚未接入主进程**」 |
| `src/main/ipc/system.ipc.ts:322` | `file:send` —「**尚未接入主进程**」 |
| `src/main/agent/tool-registry.ts:131` | `registerAllTools` 是**空 stub**（ReAct 工具系统没接） |
| `src/renderer/utils/voice-commands.ts` | 截图/文件搜索/文件发送 语音指令都 `speak('XX功能暂未开放')` |

## 三、核心模块真实度分级

| 模块 | 真实度 | 说明 |
|---|---|---|
| 本地 CPU 推理 | ✅ 真实 | `cpu-engine.ts` 445 行 + `provider.ts` 610 行，完整实现 |
| 本地 GPU provider | ⚠️ 名义 | `local-gpu-provider.ts` **仅 18 行**，完全复用父类，无独立 GPU 逻辑 |
| ReAct 智能体 | ❌ 空壳 | `tool-registry.ts` 的 `registerAllTools` 是 stub，系统提示词告诉模型"可调工具"但工具没注册 |
| 手机同步（sync） | ❌ 空壳 | 整文件标注未实现，靠 mobile-channel 另走 |
| 任务系统 / 调度器 | ❌ 空壳 | task/scheduler 通道全死 |
| 语音球 / 部分语音 | ❌ 空壳 | voice-orb 全死，voice 大量死通道 |
| 前端页面 | ✅ 完整 | Voice 827 / Knowledge 965 / Memory 1324 / Plugins 1012 / Automation 974 / Settings 1446 行，UI 都搭好了 |

## 四、核心矛盾

**"前端把按钮都画好了，后端接口是空的。"**

用户在界面上能看到"任务系统""调度器""语音球""辩论""文件搜索"等完整入口，点进去发现：
- 要么 30 秒超时（死通道，连 handler 都没有）
- 要么弹"功能未实现/暂未开放"（桩响应）
- 要么静默失败无反馈

这正是"很多核心功能完全用不了"的技术根因——**不是前端没做，是前后端没打通。**

---

## 五、重新评估：离"能用"还差多少

| 层级 | 现状 | 差距 |
|---|---|---|
| **能启动、能聊天（本地模型）** | ✅ 已通 | 无 |
| **核心功能闭环** | ❌ 约 30-40% 是空壳 | 任务/调度/语音球/辩论/文件搜索/手机同步等需真正实现 |
| **交互人性化** | ⚠️ 大量空态/错误无反馈 | 死通道应改"明确禁用+原因提示"而非静默 |
| **设计一致性** | ⚠️ 双 token、硬编码色、仅暗色 | 需统一 |

**结论：这不是"差几天"，而是"差一个真正的功能补齐阶段"。** 之前我给的"个人自用 1 周"是错的——那只是数据备份的工作量。真正要让"剑胚成剑"，需要把上面 80+ 死通道对应的功能一个个真正实现，这是以"周"为单位的工程。
