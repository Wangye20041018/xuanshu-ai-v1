"""
Plugin: File Operations (file_ops)
Level: Simple
"""
import os
import shutil
import json
import glob
from pathlib import Path
from datetime import datetime

def run(action: str, source: str, destination: str = "", pattern: str = "", recursive: bool = False) -> dict:
    """Execute a file system operation."""
    source_path = Path(source)

    try:
        if action == "search":
            return _search(source_path, pattern, recursive)
        elif action == "list":
            return _list_dir(source_path)
        elif action == "mkdir":
            source_path.mkdir(parents=True, exist_ok=True)
            return {"success": True, "created": str(source_path)}
        elif action == "copy":
            dest_path = Path(destination)
            if source_path.is_file():
                dest_path.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source_path, dest_path)
            else:
                shutil.copytree(source_path, dest_path, dirs_exist_ok=True)
            return {"success": True, "copied": str(source_path), "to": str(dest_path)}
        elif action == "move":
            dest_path = Path(destination)
            dest_path.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(source_path), str(dest_path))
            return {"success": True, "moved": str(source_path), "to": str(dest_path)}
        elif action == "delete":
            if source_path.is_file():
                source_path.unlink()
            else:
                shutil.rmtree(source_path)
            return {"success": True, "deleted": str(source_path)}
        elif action == "rename":
            dest_path = Path(destination)
            source_path.rename(dest_path)
            return {"success": True, "renamed": str(source_path), "to": str(dest_path)}
        else:
            return {"success": False, "error": f"Unknown action: {action}"}
    except Exception as e:
        return {"success": False, "error": str(e)}

def _search(base_path: Path, pattern: str, recursive: bool) -> dict:
    results = []
    search_pattern = pattern or "*"
    if recursive:
        search_glob = str(base_path / "**" / search_pattern)
    else:
        search_glob = str(base_path / search_pattern)

    for fpath in glob.glob(search_glob, recursive=recursive):
        p = Path(fpath)
        try:
            stat = p.stat()
            results.append({
                "name": p.name,
                "path": str(p),
                "size": stat.st_size,
                "modified": datetime.fromtimestamp(stat.st_mtime).isoformat(),
                "is_dir": p.is_dir(),
            })
        except OSError:
            results.append({"name": p.name, "path": str(p), "error": "access denied"})

    return {"success": True, "count": len(results), "results": results[:100]}

def _list_dir(path: Path) -> dict:
    items = []
    if not path.exists():
        return {"success": False, "error": f"Path not found: {path}"}
    for item in sorted(path.iterdir()):
        try:
            stat = item.stat()
            items.append({
                "name": item.name,
                "path": str(item),
                "size": stat.st_size,
                "modified": datetime.fromtimestamp(stat.st_mtime).isoformat(),
                "is_dir": item.is_dir(),
            })
        except OSError:
            items.append({"name": item.name, "path": str(item), "error": "access denied"})
    return {"success": True, "path": str(path), "count": len(items), "items": items}
