"""Plugin: Media Processor (media_processor) — Level: Heavy — Requires FFmpeg"""
import subprocess, os, json

# 优先使用 resources\ 下的 ffmpeg.exe
_RESOURCES_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "resources")
_FFMPEG_EXE = os.path.join(_RESOURCES_DIR, "ffmpeg.exe")
_FFPROBE_EXE = os.path.join(_RESOURCES_DIR, "ffprobe.exe")

def _get_ffmpeg():
    return _FFMPEG_EXE if os.path.exists(_FFMPEG_EXE) else "ffmpeg"

def _get_ffprobe():
    return _FFPROBE_EXE if os.path.exists(_FFPROBE_EXE) else "ffprobe"

def _ffmpeg(*args):
    r = subprocess.run([_get_ffmpeg(), "-y", "-hide_banner", "-loglevel", "error"] + list(args), capture_output=True, text=True)
    return r.returncode, r.stdout, r.stderr

def run(action: str, input_path: str, output_path: str = "", start_time: str = "", duration: str = "", bitrate: str = "") -> dict:
    if not os.path.exists(input_path):
        return {"success": False, "error": f"File not found: {input_path}"}
    try:
        if action == "info":
            code, out, err = _ffmpeg("-i", input_path, "-f", "null", "-")
            lines = [l for l in (out + err).split("\n") if l.strip()]
            info = {"file": os.path.basename(input_path), "size_mb": round(os.path.getsize(input_path) / 1e6, 1)}
            for line in lines:
                if "Duration:" in line:
                    info["duration"] = line.split("Duration:")[1].split(",")[0].strip()
                if "Stream #" in line and "Video:" in line:
                    parts = line.split("Video:")[1].split(",") if "Video:" in line else []
                    if parts: info["video_codec"] = parts[0].strip()
                    res = [p.strip() for p in parts if "x" in p and any(c.isdigit() for c in p)]
                    if res: info["resolution"] = res[0].split(" ")[0].split("[")[0]
                if "Stream #" in line and "Audio:" in line:
                    parts = line.split("Audio:")[1].split(",") if "Audio:" in line else []
                    if parts: info["audio_codec"] = parts[0].strip()
            return {"success": True, "info": info}

        if not output_path:
            base, ext = os.path.splitext(input_path)
            output_path = f"{base}_processed{ext}"

        if action == "extract_audio":
            out = output_path or os.path.splitext(input_path)[0] + ".mp3"
            code, _, err = _ffmpeg("-i", input_path, "-vn", "-acodec", "libmp3lame", "-q:a", "2", out)
            return {"success": code == 0, "output": out, "error": err if code else ""}

        elif action == "compress_video":
            code, _, err = _ffmpeg("-i", input_path, "-c:v", "libx264", "-crf", "28", "-preset", "fast",
                                    "-c:a", "aac", "-b:a", "128k", output_path)
            in_sz = os.path.getsize(input_path)
            out_sz = os.path.getsize(output_path) if os.path.exists(output_path) else 0
            return {"success": code == 0, "output": output_path,
                    "original_mb": round(in_sz / 1e6, 1), "compressed_mb": round(out_sz / 1e6, 1),
                    "ratio": f"{round(out_sz / in_sz * 100)}%" if out_sz else "N/A", "error": err if code else ""}

        elif action == "trim":
            args = ["-i", input_path]
            if start_time: args += ["-ss", start_time]
            if duration: args += ["-t", duration]
            args += ["-c", "copy", output_path]
            code, _, err = _ffmpeg(*args)
            return {"success": code == 0, "output": output_path, "error": err if code else ""}

        elif action == "concat":
            return {"success": False, "error": "Concatenation requires a file list. Use concat demuxer with file list."}

        elif action == "convert":
            code, _, err = _ffmpeg("-i", input_path, output_path)
            return {"success": code == 0, "output": output_path, "error": err if code else ""}

        elif action == "generate_subtitles":
            return {"success": False, "error": "Subtitle generation requires whisper or similar ASR engine. Install: pip install openai-whisper"}

        return {"success": False, "error": f"Unknown action: {action}"}
    except FileNotFoundError:
        return {"success": False, "error": "FFmpeg not installed. Download: https://ffmpeg.org"}
    except Exception as e:
        return {"success": False, "error": str(e)}
