"""Plugin: Quick Launch (quick_launch) — Level: Simple"""
import subprocess, os, sys, shutil

APP_DB = {
    "vscode": "code", "visual studio code": "code", "chrome": "chrome", "chromium": "chrome",
    "firefox": "firefox", "edge": "msedge", "notepad": "notepad", "explorer": "explorer",
    "cmd": "cmd", "powershell": "powershell", "terminal": "wt", "calculator": "calc",
    "paint": "mspaint", "word": "winword", "excel": "excel", "powerpoint": "powerpnt",
    "wechat": "wechat", "qq": "qq", "photoshop": "photoshop", "illustrator": "illustrator",
    "terminal.exe": "wt",
}

def run(target: str, args: str = "", as_admin: bool = False) -> dict:
    try:
        t = target.lower().strip()
        cmd = None

        if os.path.exists(target):
            cmd = [target]
        elif t in APP_DB:
            cmd = [APP_DB[t]]
        elif shutil.which(target):
            cmd = [target]
        else:
            return {"success": False, "error": f"Cannot find: {target}"}

        if args:
            cmd.extend(args.split())

        if as_admin:
            p = subprocess.run(["powershell", "-Command", f"Start-Process '{cmd[0]}' -ArgumentList '{' '.join(cmd[1:])}' -Verb RunAs"], capture_output=True, text=True)
        else:
            subprocess.Popen(cmd, shell=True if sys.platform == "win32" else False,
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

        return {"success": True, "launched": cmd[0], "args": args, "as_admin": as_admin}
    except Exception as e:
        return {"success": False, "error": str(e)}
