"""
Task Loop Runner — LLM 辅助的任务执行入口

职责：
1. 接收自然语言任务描述
2. 调用 LLM 生成初始脚本
3. 喂给 engine.py 执行机械修复循环
4. 遇到机械修复搞不定的错误时，把上下文发给 LLM 生成修正
5. 重复直到交付或放弃

由 Main Agent (Marvis) 通过 python_executor 调用。
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

# 把 engine 目录加入 path
sys.path.insert(0, str(Path(__file__).parent))

from engine import TaskLoop, TaskResult, LoopState


def run_with_llm_fallback(
    goal: str,
    work_dir: str,
    initial_script: str,
    max_iterations: int = 5,
    timeout: int = 300,
    success_markers: list[str] = None,
) -> dict:
    """
    执行任务循环，输出结构化状态供 Main Agent 决策。

    返回格式:
    {
        "status": "success" | "need_fix" | "give_up",
        "result": { ... TaskResult ... },
        "context_for_llm": "给 LLM 看的错误上下文，仅在 need_fix 时提供",
        "current_script": "当前执行的脚本，仅在 need_fix 时提供"
    }

    Main Agent 使用方式:
    1. 调用本函数
    2. 如果 status == "success"，交付产物
    3. 如果 status == "need_fix"：
       a. 把 context_for_llm + current_script 喂给 LLM
       b. LLM 生成修正后的脚本
       c. 用修正后的脚本再次调用本函数（initial_script 换成修正版）
    4. 如果 status == "give_up"，报告失败
    """
    loop = TaskLoop(
        goal=goal,
        work_dir=work_dir,
        max_iterations=max_iterations,
        timeout=timeout,
        success_markers=success_markers,
    )

    result = loop.run(initial_script)

    if result.success:
        return {
            "status": "success",
            "result": result.to_dict(),
        }

    if result.final_state == LoopState.GIVE_UP:
        # 构建给 LLM 的修正上下文
        last_log = result.logs[-1] if result.logs else None

        context = f"""## 任务目标
{goal}

## 执行失败
- 迭代次数: {result.total_iterations}/{max_iterations}
- 退出码: {last_log.exit_code if last_log else 'N/A'}
- 错误类型: {last_log.error_type if last_log else 'N/A'}

## STDERR
{result.error}

## 已尝试的自动修复
{chr(10).join(f'- [{l.index}] {l.fix_applied}' for l in result.logs if l.fix_applied)}

## 当前脚本
{initial_script}

---
请根据以上信息修改脚本，使其能够成功完成任务。只输出修正后的完整 Python 脚本代码，不要解释。
"""

        return {
            "status": "need_fix",
            "result": result.to_dict(),
            "context_for_llm": context,
            "current_script": initial_script,
        }

    return {
        "status": "give_up",
        "result": result.to_dict(),
    }


# ---------------------------------------------------------------------------
# CLI 入口
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    """
    用法一：直接传 JSON
        python runner.py '{"goal":"...", "work_dir":"...", "script":"..."}'
    
    用法二：传 JSON 文件路径
        python runner.py config.json
    """
    import argparse

    parser = argparse.ArgumentParser(description="Task Loop Runner")
    parser.add_argument("config", help="JSON config or path to config file")
    parser.add_argument("--output", "-o", help="结果输出文件路径", default=None)
    args = parser.parse_args()

    config_path = Path(args.config)
    if config_path.exists():
        config = json.loads(config_path.read_text(encoding='utf-8'))
    else:
        config = json.loads(args.config)

    outcome = run_with_llm_fallback(
        goal=config["goal"],
        work_dir=config["work_dir"],
        initial_script=config["script"],
        max_iterations=config.get("max_iterations", 5),
        timeout=config.get("timeout", 300),
        success_markers=config.get("success_markers", []),
    )

    output = json.dumps(outcome, ensure_ascii=False, indent=2)

    if args.output:
        Path(args.output).write_text(output, encoding='utf-8')
        print(f"Result written to {args.output}")
    else:
        print(output)
