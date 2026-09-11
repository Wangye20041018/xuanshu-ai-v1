# Changelog

All notable changes to 玄枢AI (Xuanshu AI) will be documented in this file.

## [v12.3.0] — 2026-08-30

### Added
- **ReAct 智能体框架**：完整的思考→行动→观察循环，支持工具注册、危险操作确认、记忆隔离
- **智能模型调度系统**：任务识别→选模型→自动加载→推理→失败回退的完整链路
- **双模型协同（Tandem）**：支持 dual/partner/mentor/debate 四种协同模式
- **悬浮球语音交互**：3D 粒子球体 + 语音识别字幕 + 语音闭环（识别→意图→对话→TTS）
- **内置浏览器**：支持标签页管理、书签、扩展安装、内容提取、截图
- **技能包系统**：技能包匹配、执行、学习管理
- **MCP 协议支持**：MCP 工具注册与调用
- **数据备份/恢复**：支持用户数据导出、导入、校验

### Changed
- Python Flask 后端引擎正式废弃，全面迁移到 TypeScript Electron 主进程架构
- IPC 通道从 31 个扩展到 200+ 个，覆盖所有功能模块
- 项目结构重大重构：新增 agent/、scheduler/、tandem-manager/、floating-ball/、browser/、skill-pack/、mcp/、backup/ 等模块

### Security
- 移动通道绑定地址限制为 127.0.0.1，避免局域网暴露
- 应用权限从 requireAdministrator 降为 asInvoker
- 禁用自动更新和代码签名（个人自用场景）

## [v11.2.0] — 2026-08-07

### Added
- **RAG 检索增强生成模块**：实现完整的向量检索 IPC（rag:search / add-document / remove-document / rebuild-index / count / get-document），基于本地 VectorStore + 余弦相似度
- **31 个 IPC Handler 实现**：所有系统模块 stub 已替换为真正的 `ipcMain.handle()` 注册，消除 renderer 端 IPC 静默失败
- **权限管理 IPC**：实现 permission:check / request / list 基础接口
- **Agent 框架 IPC**：实现 visual-agent:status / agent:status 基础接口
- **自签名代码证书**：生成 `resources/cert/xuanshu-root.pfx` 和 `.cer`，支持本地签名

### Changed
- `src/main/ipc/system.ipc.ts`：所有 26 个模块 stub 函数已重写为注册真正的 IPC handler
- `src/main/ipc/rag.ts`：从 9 行空壳扩展为 6 个 IPC handler 的完整实现
- `src/main/ipc/permission.ts`：从空壳 stub 扩展为 3 个权限管理 handler
- `src/main/agent/index.ts`：setupVisualAgentHandlers / setupAgentHandlers 已注册实际 IPC handler

### Fixed
- 修复 `di-container.test.ts`：`register()` API 调用从旧版 `(token, factory)` 更新为 `(token, { useFactory })`
- 修复 `di-container.test.ts` / `resilience.test.ts`：导入路径从 `../src/` 修正为 `../../src/`
- 修复 `ui-components.test.ts`：VirtualList visible range 期望值修正（400/40+3=13 而非 16）

### Security
- `electron-builder.yml` 证书密码改为环境变量 `$env:CERT_PASSWORD`，不再硬编码

### Infrastructure
- 生成 `resources/cert/xuanshu-root.pfx`（代码签名证书）
- 生成 `resources/cert/xuanshu-root.cer`（公钥证书）
- 测试通过率：246/246（100%）

---

## [v11.1.0] — 2026-08-06

### Fixed
- electron-vite 构建导致运行时模块缺失（动态 require 改为静态 import）
- 6 个 IPC handler 未注册导致桌面宠物启动失败
- modules.register.ts、ipc.register.ts、system.ipc.ts 等路径修复

---

## [v11.0.0] — 2026-07

### Added
- 多角色管理框架（CharacterManager）
- 向量存储引擎（VectorStore + LRU Cache）
- 知识图谱（KnowledgeGraph）
- 语音引擎（VoiceEngine）：TTS + ASR + 声音克隆
- 模型管理（ModelManager）：GPU 显存优化、llama.cpp Server
- 设备优化器（DeviceOptimizer）
- 自动化引擎（Automation）
- 悬浮球 + 语音球体 + 桌面宠物
- 任务路由系统（Task Router）
- 移动端通道（Mobile Channel）
- 外部 AI 客户端（External AI）
- 联网搜索（Internet Search）

### Infrastructure
- DI 容器（DIContainer）
- 弹性中间件（Resilience）：熔断器、重试、超时、舱壁
- 进程守护（ProcessGuardian）
- 模块生命周期管理（Lifecycle Register）
*（内容由AI生成，仅供参考）*
