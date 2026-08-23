"""Plugin: Image Basic (image_basic) — Level: Simple"""
from PIL import Image
import os

def run(action: str, input_path: str = "", output_path: str = "", width: int = 0, height: int = 0, format: str = "", quality: int = 85) -> dict:
    try:
        if not os.path.exists(input_path): return {"success": False, "error": "File not found"}
        img = Image.open(input_path)

        if action == "info":
            return {"success": True, "format": img.format, "size": img.size, "mode": img.mode, "file_size_kb": round(os.path.getsize(input_path) / 1024, 1)}

        if not output_path:
            base, _ = os.path.splitext(input_path)
            out_fmt = format.lower() if format else img.format.lower()
            if out_fmt == "jpeg": out_fmt = "jpg"
            output_path = f"{base}_processed.{out_fmt}"

        if action == "resize":
            if not width and not height: return {"success": False, "error": "width or height required"}
            if width and height: img = img.resize((width, height), Image.LANCZOS)
            elif width: ratio = width / img.width; img = img.resize((width, int(img.height * ratio)), Image.LANCZOS)
            else: ratio = height / img.height; img = img.resize((int(img.width * ratio), height), Image.LANCZOS)

        elif action == "crop":
            img = img.crop((0, 0, width or img.width, height or img.height))

        elif action == "convert":
            pass  # format conversion handled below

        elif action == "compress":
            save_fmt = format.lower() if format else img.format
            if save_fmt in ("jpg", "jpeg"): img = img.convert("RGB")
            img.save(output_path, save_fmt.upper(), quality=quality, optimize=True)
            return {"success": True, "output": output_path, "size_kb": round(os.path.getsize(output_path) / 1024, 1)}

        save_fmt = format.upper() if format else img.format
        if save_fmt == "JPEG": img = img.convert("RGB")
        img.save(output_path, save_fmt, quality=quality)
        return {"success": True, "output": output_path, "size": img.size, "size_kb": round(os.path.getsize(output_path) / 1024, 1)}

    except Exception as e:
        return {"success": False, "error": str(e)}
