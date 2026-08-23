"""Plugin: Text Processor (text_processor) — Level: Simple"""
import re, json, csv, io

def run(action: str, input_text: str = "", pattern: str = "", replacement: str = "", file_path: str = "") -> dict:
    try: text = input_text; 
    except: return {"success": False, "error": "Invalid input"}
    if file_path:
        try:
            with open(file_path, "r", encoding="utf-8") as f: text = f.read()
        except Exception as e: return {"success": False, "error": f"Read file failed: {e}"}
    try:
        if action == "regex_replace":
            if not pattern: return {"success": False, "error": "pattern required"}
            result = re.sub(pattern, replacement, text)
            return {"success": True, "result": result, "count": len(re.findall(pattern, text))}
        elif action == "count":
            return {"success": True, "chars": len(text), "words": len(text.split()), "lines": len(text.splitlines())}
        elif action == "csv_to_json":
            reader = csv.DictReader(io.StringIO(text))
            data = [row for row in reader]
            return {"success": True, "result": json.dumps(data, ensure_ascii=False, indent=2), "rows": len(data)}
        elif action == "json_to_csv":
            data = json.loads(text) if isinstance(text, str) else text
            if not data: return {"success": False, "error": "Empty data"}
            if isinstance(data, dict): data = [data]
            output = io.StringIO()
            writer = csv.DictWriter(output, fieldnames=data[0].keys())
            writer.writeheader(); writer.writerows(data)
            return {"success": True, "result": output.getvalue(), "rows": len(data)}
        elif action == "sort":
            lines = text.splitlines()
            lines.sort()
            return {"success": True, "result": "\n".join(lines), "lines": len(lines)}
        return {"success": False, "error": f"Unknown action: {action}"}
    except Exception as e:
        return {"success": False, "error": str(e)}
