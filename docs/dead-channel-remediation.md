# 死通道精确分类与功能补齐设计方案

> 审计基准：`src/preload/index.ts`（536 个 IpcChannels 声明）、`src/main/register/ipc.register.ts`（41 个模块 setup）、全量 `ipcMain.handle/on` 注册扫描（529 个 handler）、渲染进程真实调用扫描（123 个 invoke/send/on 字面量）。

## 一、核心结论（先纠正三个误判）

1. **"80+ 死通道"绝大多数是「僵尸声明」，不是「用户点不动」**。我把「preload 声明 → 主进程无 handler」的两类通道和「渲染进程真实调用」做了三向交叉，结果：**真正导致界面 30 秒超时的死通道只有 3 个，且全部集中在「插件页」**（`dialog:open`、`plugin:install`、`plugin:store-list`）。其余约 70 个通道渲染进程根本不调用，属于历史遗留的 preload 类型声明，不产生任何用户可见故障。
2. **`task-router` 不是「任务系统」**。`src/main/task-router/index.ts` 的职责是**模型路由**（`route() → classifyIntent → selectTier → ensureTier`，选 fast/vision 档、加载/换载模型），与 `task:create/execute` 那 18 个「任务管理」通道毫无关系。任务管理系统在主进程**完全不存在**。
3. **「辩论」不是没做，而是改名叫 `tandem`**。`tandem-manager/index.ts` 里 `dualAnswer/partnerAnswer/mentorAnswer/debateAnswer`（:505/:692）是完整实现，渲染层的「辩论」入口走的是 `tandem:*`（TandemPanel.tsx），`debate:*` 是废弃的旧命名空间。

---

## 二、精确分类表（A/B/C）

### A 类：命名错位（主进程已有等价实现，只需对齐/加别名）

| 死通道（preload/旧名） | 主进程实际实现 | 证据 file:line |
|---|---|---|
| `file:search` | `search:query-files` | fulltext-search/index.ts（有 query-files/index-directory/index-file/delete-file/index-stats 5 个真实 handler）；`file:search` 桩在 system.ipc.ts:317 |
| `debate:start / stop / history / query-A / query-B` | `tandem:debate-answer` / `tandem:dual-answer` | tandem-manager/index.ts:505/692；`debate:status` 空桩 system.ipc.ts:200 |
| `sync:connect / sync:send-message` | `mobile:*`（18 个真实通道） | mobile-channel/index.ts；sync 桩 sync.ipc.ts:78/111 |
| `operation:list-tasks` | `operation:get-tasks` | dynamic-operation/index.ts |
| `operation:history` | `system:operation:history` | operation/engine.ts |
| `desktop-automation:screenshot` | `system:control:take-screenshot` | system-control.ipc.ts:99（真实截图）；桩 system.ipc.ts:312 |
| `voice:set-voice / voice:get-voice` | `voice:set-current / voice:get-current` | tts.ipc.ts:178/186 |
| `voice:synthesize` | `voice:speak` / `tts:speak` | tts.ipc.ts:204/250 |

> 注意：`file:search`、`file:send`、`desktop-automation:screenshot` **根本不在 preload 的 IpcChannels 里**（渲染层无法通过 `window.api` 调用），它们是 system.ipc.ts 里「孤儿桩」，可直接删除或映射。

### B 类：后端空壳（有 handler 但返回桩/false）

| 通道 | 桩内容 | 位置 |
|---|---|---|
| `debate:status` | `{status:'active', topics:[]}` | system.ipc.ts:200-202 |
| `scheduler:cancel-all` | `{success:false, "任务调度器尚未接入"}` | system.ipc.ts:340-342 |
| `sync:connect` | `{success:false, "Use mobile channel instead"}` | sync.ipc.ts:78-86 |
| `sync:send-message` | 同上 | sync.ipc.ts:111-117 |
| `file:search / file:send` | `"尚未接入主进程"` | system.ipc.ts:317-324 |
| `desktop-automation:screenshot` | `"需 desktop_automation.py"` | system.ipc.ts:312-314 |
| `python:check-env` | `{pythonAvailable:false}` | system.ipc.ts:190-192 |
| `piper:download / download-models / needs-download` | **无 handler，但逻辑已存在** `PiperTTS.downloadPiper()`（tts/piper.ts:148）+ `isAvailable()`（:228），仅未暴露 IPC | tts.ipc.ts 未注册 |

### C 类：彻底缺失（无 handler、无后端）

| 家族 | 数量 | 证据 |
|---|---|---|
| `task:*`（create/execute/get/get-all/stats/pause/resume/cancel/delete/clear-completed/export/import/templates/intent-match/retry-step/skip-step/execute-visual） | 18 | 全量 grep `task:` 无任何 handle；task-router 是模型路由非任务系统 |
| `scheduler:*`（submit-task/queue-status/cancel-task/pause-task/resume-task） | 5 | 仅 scheduler:cancel-all 桩 |
| `voice-orb:*`（show/hide/toggle/set-state/get-state/set-emotion/set-theme/get-theme/set-size/toggle-listening） | 11 | `floating-ball/voice-orb.ts` 文件不存在，grep 主进程 `voice-orb` 仅 1 条注释 |
| `plugin:install / plugin:store-list` | 2 | plugin.ipc.ts 未注册；plugin-engine/index.ts grep `install/store` 为空 |
| `debate:start/stop/history/query-A/query-B` | 5 | 仅 debate:status 桩 |
| `voice:*`（set-voice/get-voice/adjust-params/set-pitch/set-speed/set-volume/export/import/search/add-custom/remove-custom/get-by-emotion/get-by-gender/speak-edge/speech-input/start-discussion/stop-discussion/chat:start/chat:stop/update-settings/pause/resume/stop/synthesize） | ~24 | tts.ipc.ts 仅注册 8 个 voice 通道；voice-engine/index.ts 仅自注册 `voice:speech-audio` |
| `external-ai:history / settings / update-settings / clear-history` | 4 | external-ai/index.ts 只注册 generate-image/video/providers/quota/stats/update-provider/clear-cache |
| `operation:status / clear-history` | 2 | dynamic-operation/index.ts 未注册 |
| `python:ping / get-script` | 2 | runtime/python.ts 只注册 initialize/status/run/install/is-ready/health:check |

---

## 三、渲染进程真实调用交叉（判定"是否值得修"的关键）

渲染进程实际 invoke/send/on 的通道（123 个）中，**真正无 handler 的只有 3 个 invoke 死通道**：

| 通道 | 调用点 | 影响 |
|---|---|---|
| `dialog:open` | Plugins/index.tsx:286 | 插件页「选择文件」→ 30s 超时 |
| `plugin:install` | Plugins/index.tsx:292 | 插件页「安装」→ 30s 超时 |
| `plugin:store-list` | Plugins/index.tsx:314 | 插件页「商店」→ 30s 超时 |

另有 `task:layer-progress / queue-update / status-update / subtask-progress`（TaskProgressOverlay.tsx:144-147，`api.on` 监听）与 `scheduler:cancel-all`（:166，invoke）——它们说明**存在一个任务进度浮层 UI**，但主进程既无引擎推送进度事件，也无 cancel-all 真实实现，浮层处于「永远空转/取消无效」的半成品状态。

其余 `task:*`、`scheduler:*`、`voice-orb:*`、`piper:*`、`debate:*`、`voice:set-voice/search/export`、`external-ai:history`、`operation:*`、`python:ping/get-script`、`sync:connect/send-message` **在渲染进程无任何调用**——纯僵尸声明。

---

## 四、补齐方案（按价值分级）

### P0：修复真实故障（3 通道，半小时可完成）

**`dialog:open`**：在 plugin.ipc.ts 或新增 dialog.ipc.ts 注册 `ipcMain.handle('dialog:open', ...)`，内部 `dialog.showOpenDialog`，返回 `{filePaths}`。数据流：renderer invoke → Electron dialog 原生选择框 → 返回路径数组。这是插件页「选择 .js/.ts 插件文件」的前置。

**`plugin:install`**：plugin-engine 已具备 `registerPlugin()`，补一个 `installFromFile(filePath)`——读文件 → 校验（sandbox.ts 已有沙箱）→ `registerPlugin` → 落盘持久化（`plugin:list` 已能从 engine 读回）。数据流：文件路径 → 加载模块 → 注册 → 返回 `{success}`。

**`plugin:store-list`**：无后端可复用，**降级为「明确禁用 + 提示」**（返回空列表 + `{storeUnavailable:true}`，前端显示"插件商店未开通"），避免继续 30s 超时。真正的插件商店需要远端仓库，个人自用价值低，建议砍。

### P1：任务系统（半成品补齐，价值中）

现状：TaskProgressOverlay 浮层已在等 `task:*` 进度事件，但主进程无引擎。**建议降级**，不要重写完整任务编排：
- 删除/屏蔽 TaskProgressOverlay 的 `task:*` 事件监听和 `scheduler:cancel-all` 调用（或让 cancel-all 返回明确的 `{success:true}` 空转，消除「点了没反应」）。
- 真正的"任务系统"个人自用价值不高——自动化已由 `automation:*`（9 通道，全真）、`skill-pack:*`、`vision:*`（队列任务）覆盖。**砍掉 task:* / scheduler:* 的 23 个僵尸声明**。

### P2：僵尸声明清理（零风险，消除类型污染）

把 A 类做「别名映射」、把无调用且无后端的 C 类从 preload 的 `IpcChannels` 联合类型中移除，并同步删 system.ipc.ts 里的孤儿桩（file:search/file:send/desktop-automation:screenshot/python:check-env/external-ai:providers 旧桩）。**这是纯减负，不新增功能，但能防止未来工程师被死声明误导。**

### 待决策（价值存疑，需主理人/用户拍板，见第六节）

- **debate:\***：已被 tandem 完全替代 → 建议从 preload 删 5 个通道，`debate:status` 桩删掉。
- **voice-orb:\***：11 通道无任何实现文件 → 建议整体砍（语音球 UI 也不存在）。
- **piper:\***：`downloadPiper()` 逻辑在但未暴露。若用户需要"离线 TTS 模型下载"入口，补 3 个 handler 转发到 `PiperTTS.downloadPiper/isAvailable`；否则删。当前 Voice 页走 `voice:tts-status`，已有 `piperAvailable` 字段，可能无需 piper:* 单独通道。
- **voice:\*** 死别名（~24 个）：语音主链路（speak/tts-status/get-voices/set-current/get-current/get-settings/preview/delete-voice/clone:start）**全部正常**。死别名里仅 `voice:speech-input`（对应 sensevoice-asr.ts 真实 ASR）有实现价值，可补一个 handler 暴露 ASR；其余（search/export/import/add-custom/get-by-emotion/get-by-gender/set-pitch/set-speed/set-volume/update-settings/chat:start/chat:stop）为渲染层不再使用的旧接口，删。
- **external-ai:history/settings/update-settings/clear-history**：external-ai 的画像生成/配额/providers 已真，缺的是「历史记录与设置持久化」。个人自用价值低，建议补一个最小 `settings`/`history` 持久化到 userData 即可，或直接删。
- **operation:status/clear-history**：动态操作引擎主体已真（analyze/execute-task/cancel/get-task 等 15 通道），仅 status/clear-history 缺。补 status（汇总任务数）即可，clear-history 若引擎无历史可删。

---

## 五、依赖排序与实现顺序（分阶段）

**阶段 0（P0，先做）**：`dialog:open` + `plugin:install` + `plugin:store-list` 三个 handler，直接修复插件页三处超时。无依赖，独立成任务。

**阶段 1（P1，做）**：任务系统降级——屏蔽 TaskProgressOverlay 空转逻辑 + `scheduler:cancel-all` 返回明确状态；删除 task:*（18）+ scheduler:*（5）僵尸声明。

**阶段 2（P2，做）**：A 类别名映射 + 全量僵尸声明清理 + system.ipc.ts 孤儿桩删除。此阶段把 preload 从 536 通道收敛到 ~480 个「有实现或有意为之」的通道。

**阶段 3（待决策后，可选做）**：
- 若保留辩论：删除 debate:* 由 tandem:* 承担（仅删，不新增）。
- 若保留离线 TTS 下载：补 piper:* 3 handler（转发 PiperTTS）。
- 若保留语音输入：补 voice:speech-input（转发 sensevoice-asr）。
- 若保留外部 AI 历史：补 external-ai:history/settings 持久化。

**可安全砍掉（建议直接禁用+提示）**：voice-orb:*（11）、debate:*（5）、plugin 商店、task 完整编排、scheduler 完整编排、voice 死别名（~20）。

---

## 六、待确认事项（需主理人/用户拍板）

1. **辩论功能**：`debate:*` 废弃命名空间是否直接删除？UI 已走 tandem，删除无副作用——建议直接删，无需拍板（除非有外部脚本依赖旧通道名）。
2. **语音球（voice-orb）**：11 通道 + UI 均不存在，是否确认整体砍掉？
3. **任务系统**：是否接受"任务编排不重做、只降级屏蔽"？还是需要真正的多步任务编排（会是一个较大的新模块）？
4. **离线 TTS 模型下载入口**：用户是否需要 Piper 模型手动下载/管理界面（piper:* 3 通道），还是保持"首次使用时自动判断下载"（当前 `voice:tts-status` 已含 `piperAvailable`）？
5. **插件商店**：`plugin:store-list` 是做成远端商店（需仓库/审核），还是明确禁用？
6. **外部 AI 历史**：`external-ai:history` 是否需要本地持久化历史记录，还是仅保留本次会话？

---

## 附：给工程师的关键实现注意点

- 所有新增 handler 必须走 `ipcMain.handle` 并通过 `setupAllIpcHandlers` 的鉴权包装（ipc-guard），不要绕过。
- 新增通道需同步在 `src/preload/index.ts` 的 `IpcChannels` 联合类型 + `index.d.ts` 里声明，避免渲染层 TS 报错。
- **严禁在 system.ipc.ts 里再堆桩**：该文件已有 15+ 个「死代码 setup 函数」被真实模块 import 覆盖（如 setupExternalAIHandlers/setupPythonHandlers/setupModelManagerHandlers），新逻辑应放进对应模块目录并在此注册 import。
- `local-gpu-provider.ts`（18 行，仅 `type='localgpu'` 复用 LocalCPUProvider）确认无独立 GPU 逻辑，属已知欠账，不在本次死通道修复范围内，另行立项。
- `agent/tool-registry.ts` 的 `registerAllTools` 是空 stub（:131-133），ReAct 智能体工具系统未接线，属独立欠账，另行立项。
