"""
Task Loop — 自主任务执行引擎

设计哲学：不修自己，只修任务脚本。
接收目标+约束 → 写脚本 → 执行 → 验结果 → 失败自动修 → 迭代到交付。
操作边界：只读/写 workspace，不碰玄枢本体。
"""

from .engine import TaskLoop, TaskResult, LoopState

__all__ = ['TaskLoop', 'TaskResult', 'LoopState']
