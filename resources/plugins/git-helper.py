#!/usr/bin/env python3
"""Git操作外挂 — status/log/diff/commit/push"""

import subprocess
import os
from typing import Dict, Any


def execute(user_msg: str, **kwargs) -> Dict[str, Any]:
    action = kwargs.get("action", "status")
    repo_path = kwargs.get("repo_path", os.getcwd())
    message = kwargs.get("message", "")
    branch = kwargs.get("branch", "")

    try:
        os.chdir(repo_path)
    except Exception:
        return {"success": False, "error": f"无法切换到目录: {repo_path}"}

    try:
        if action == "status":
            return _git_status()
        elif action == "log":
            return _git_log()
        elif action == "diff":
            return _git_diff()
        elif action == "commit":
            return _git_commit(message)
        elif action == "push":
            return _git_push(branch)
        elif action == "pull":
            return _git_pull(branch)
        elif action == "branch":
            return _git_branch()
        else:
            return {"success": False, "error": f"未知操作: {action}"}
    except Exception as e:
        return {"success": False, "error": str(e)}


def _run_git(args: list) -> Dict:
    try:
        result = subprocess.run(
            ["git"] + args,
            capture_output=True, text=True, timeout=30
        )
        return {
            "success": result.returncode == 0,
            "stdout": result.stdout[:2000],
            "stderr": result.stderr[:500],
            "returncode": result.returncode
        }
    except FileNotFoundError:
        return {"success": False, "error": "Git 未安装或不在 PATH 中"}
    except subprocess.TimeoutExpired:
        return {"success": False, "error": "Git 命令超时"}


def _git_status() -> Dict:
    return _run_git(["status", "--short", "-b"])


def _git_log() -> Dict:
    return _run_git(["log", "--oneline", "-20"])


def _git_diff() -> Dict:
    return _run_git(["diff", "--stat"])


def _git_commit(message: str) -> Dict:
    if not message:
        return {"success": False, "error": "commit message 不能为空"}
    return _run_git(["commit", "-m", message])


def _git_push(branch: str = "") -> Dict:
    args = ["push"]
    if branch:
        args.extend(["origin", branch])
    return _run_git(args)


def _git_pull(branch: str = "") -> Dict:
    args = ["pull"]
    if branch:
        args.extend(["origin", branch])
    return _run_git(args)


def _git_branch() -> Dict:
    return _run_git(["branch", "-a"])
