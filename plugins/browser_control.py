"""
Plugin: Browser Control (browser_control)
Level: Simple
Uses system default browser via os.startfile / webbrowser module.
For advanced automation (click/fill/screenshot), Selenium/Playwright needed.
"""
import webbrowser
import subprocess
import sys
import os

def run(action: str, url: str = "", selector: str = "", value: str = "") -> dict:
    try:
        if action == "open":
            if not url:
                return {"success": False, "error": "URL required"}
            webbrowser.open(url)
            return {"success": True, "opened": url}

        elif action == "screenshot":
            return {"success": False, "error": "Screenshot requires Playwright or Selenium. Install: pip install playwright && playwright install"}

        elif action in ("click", "fill", "execute_js"):
            return {"success": False, "error": f"Action '{action}' requires a browser automation framework (Selenium/Playwright). Install: pip install playwright && playwright install"}

        else:
            return {"success": False, "error": f"Unknown action: {action}"}

    except Exception as e:
        return {"success": False, "error": str(e)}
