"""Plugin: Git Helper (git_helper) — Level: Simple"""
import subprocess, os

def run(action: str, repo_path: str = ".", message: str = "", branch_name: str = "", file_paths: str = "") -> dict:
    def git(*args):
        r = subprocess.run(["git"] + list(args), cwd=repo_path, capture_output=True, text=True)
        return r.stdout.strip(), r.stderr.strip(), r.returncode
    try:
        if not os.path.isdir(os.path.join(repo_path, ".git")):
            return {"success": False, "error": f"Not a git repository: {repo_path}"}
        if action == "status":
            out, err, code = git("status", "--short")
            return {"success": True, "output": out or "clean"}
        elif action == "log":
            out, err, code = git("log", "--oneline", "-20")
            return {"success": True, "commits": [l for l in out.split("\n") if l]}
        elif action == "diff":
            files = file_paths.split(",") if file_paths else []
            out, err, code = git("diff", "--stat", *files)
            return {"success": True, "output": out or "no changes"}
        elif action == "commit":
            if not message: return {"success": False, "error": "commit message required"}
            out, err, code = git("commit", "-m", message)
            return {"success": code == 0, "output": out or err}
        elif action == "push":
            out, err, code = git("push")
            return {"success": code == 0, "output": out or err}
        elif action == "pull":
            out, err, code = git("pull")
            return {"success": code == 0, "output": out or err}
        elif action == "branch":
            out, err, code = git("branch", "-a")
            return {"success": True, "branches": [l.strip() for l in out.split("\n") if l]}
        elif action == "add":
            paths = file_paths.split(",") if file_paths else ["."]
            out, err, code = git("add", *paths)
            return {"success": code == 0, "output": out or "files staged"}
        elif action == "checkout":
            if not branch_name: return {"success": False, "error": "branch_name required"}
            out, err, code = git("checkout", branch_name)
            return {"success": code == 0, "output": out or err}
        elif action == "init":
            os.makedirs(repo_path, exist_ok=True)
            out, err, code = git("init")
            return {"success": code == 0, "output": out or err}
        return {"success": False, "error": f"Unknown action: {action}"}
    except FileNotFoundError:
        return {"success": False, "error": "Git not installed. Download: https://git-scm.com"}
    except Exception as e:
        return {"success": False, "error": str(e)}
