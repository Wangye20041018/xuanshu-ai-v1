"""Plugin: Clipboard Tools (clipboard_tools) — Level: Simple"""
import subprocess, sys, json, os, tempfile
from datetime import datetime

HISTORY_FILE = os.path.join(tempfile.gettempdir(), "xuanshu_clipboard_history.json")

def _load_history():
    try:
        with open(HISTORY_FILE, "r") as f: return json.load(f)
    except: return []

def _save_history(entries):
    with open(HISTORY_FILE, "w") as f: json.dump(entries, f, ensure_ascii=False)

def _get_clipboard() -> str:
    r = subprocess.run(["powershell", "-Command", "Get-Clipboard"], capture_output=True, text=True, encoding="utf-8")
    if r.returncode != 0: return ""
    return r.stdout

def _set_clipboard(text: str):
    subprocess.run(["powershell", "-Command", f"$null = [System.Windows.Forms.Clipboard]::SetText('{text.replace(\"'\", \"''\")}')"], capture_output=True)

def run(action: str, text: str = "") -> dict:
    try:
        if action == "read":
            content = _get_clipboard()
            return {"success": True, "text": content, "length": len(content)}
        elif action == "write":
            if not text: return {"success": False, "error": "text required"}
            _set_clipboard(text)
            history = _load_history()
            history.insert(0, {"text": text[:500], "time": datetime.now().isoformat()})
            _save_history(history[:100])
            return {"success": True, "written": len(text)}
        elif action == "history":
            return {"success": True, "entries": _load_history()[:50]}
        elif action == "clear":
            _set_clipboard("")
            return {"success": True}
        return {"success": False, "error": f"Unknown action: {action}"}
    except Exception as e:
        return {"success": False, "error": str(e)}
