# 此目录已废弃

`engine/` 目录为旧版 Python 架构的剩余文件（api_server.py、model_manager.py、mode_router.py 等）。

这些文件在 v10+ 版本中已被 TypeScript 主进程架构替代，不再使用。

保留原因：
- 部分主进程代码仍引用 engine/ 路径（如 config.ipc.ts）
- 可能作为快速回退方案

请勿在此目录添加新代码。如需清理，请先确认所有引用已移除。
