#!/usr/bin/env python3
"""数据库外挂 — SQLite/MySQL/PostgreSQL 查询"""

import os
from typing import Dict, Any

try:
    import sqlite3
except ImportError:
    sqlite3 = None


def execute(user_msg: str, **kwargs) -> Dict[str, Any]:
    action = kwargs.get("action", "query")
    db_type = kwargs.get("db_type", "sqlite")
    db_path = kwargs.get("db_path", "")
    sql = kwargs.get("sql", "")

    try:
        if db_type == "sqlite":
            return _sqlite_ops(action, db_path, sql)
        elif db_type == "mysql":
            return {"success": False, "error": "MySQL support not yet implemented"}
        elif db_type == "postgresql":
            return {"success": False, "error": "PostgreSQL support not yet implemented"}
        else:
            return {"success": False, "error": f"不支持的数据库类型: {db_type}"}
    except Exception as e:
        return {"success": False, "error": str(e)}


def _sqlite_ops(action: str, db_path: str, sql: str) -> Dict:
    if not sqlite3:
        return {"success": False, "error": "sqlite3 not available"}

    if not db_path or not os.path.exists(db_path):
        return {"success": False, "error": f"SQLite 文件不存在: {db_path}"}

    try:
        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        cur = conn.cursor()

        if action == "list_tables":
            cur.execute("SELECT name FROM sqlite_master WHERE type='table'")
            tables = [row[0] for row in cur.fetchall()]
            conn.close()
            return {"success": True, "tables": tables, "count": len(tables)}

        elif action == "schema":
            cur.execute("SELECT sql FROM sqlite_master WHERE type='table'")
            schemas = {row[0] if row[0] else "unknown": "no SQL" for row in cur.fetchall()}
            conn.close()
            return {"success": True, "schemas": schemas}

        elif action == "query":
            if not sql:
                conn.close()
                return {"success": False, "error": "SQL 不能为空"}
            cur.execute(sql)
            rows = [dict(row) for row in cur.fetchall()]
            conn.close()
            return {"success": True, "rows": rows[:100], "count": len(rows)}

        else:
            conn.close()
            return {"success": False, "error": f"未知操作: {action}"}

    except sqlite3.Error as e:
        return {"success": False, "error": f"SQLite错误: {e}"}
