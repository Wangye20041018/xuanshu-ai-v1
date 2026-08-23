"""Plugin: Database Tools (db_tools) — Level: Simple"""
import sqlite3, json, os

def run(action: str, db_type: str = "sqlite", connection: str = "", sql: str = "", params: dict = None) -> dict:
    try:
        if db_type == "sqlite":
            return _sqlite(action, connection, sql, params)
        elif db_type in ("mysql", "postgres"):
            return {"success": False, "error": f"{db_type} requires driver. Install: pip install {'pymysql' if db_type == 'mysql' else 'psycopg2'}"}
        return {"success": False, "error": f"Unsupported db_type: {db_type}"}
    except Exception as e:
        return {"success": False, "error": str(e)}

def _sqlite(action: str, connection: str, sql: str, params: dict) -> dict:
    if not connection or not os.path.exists(connection):
        return {"success": False, "error": f"Database not found: {connection}"}
    conn = sqlite3.connect(connection)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    try:
        if action == "connect_test":
            cur.execute("SELECT sqlite_version()")
            return {"success": True, "version": cur.fetchone()[0]}
        elif action == "list_tables":
            cur.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            return {"success": True, "tables": [r[0] for r in cur.fetchall()]}
        elif action == "describe":
            if not sql: return {"success": False, "error": "Table name required as sql param"}
            cur.execute(f"PRAGMA table_info({sql})")
            cols = [{"name": r[1], "type": r[2], "nullable": not r[3]} for r in cur.fetchall()]
            return {"success": True, "columns": cols}
        elif action == "query":
            if not sql: return {"success": False, "error": "SQL required"}
            cur.execute(sql, params or {})
            rows = [dict(r) for r in cur.fetchall()]
            return {"success": True, "rows": rows, "count": len(rows)}
        return {"success": False, "error": f"Unknown action: {action}"}
    finally:
        conn.close()
