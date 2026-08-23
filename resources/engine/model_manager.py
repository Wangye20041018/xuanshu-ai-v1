"""
玄枢 AI Engine — Model Manager
===============================
Downloads, verifies, and manages local model files.

Models (常驻投机解码):
  Draft:   Qwen2.5-VL-7B-Instruct.Q3_K_M.gguf (~4.1 GB) + mmproj-Qwen2.5-VL-7B-Instruct-f16.gguf (~1.3 GB)
  Verify:  qwen2.5-14b-instruct-Q4_K_M.gguf (~8.5 GB)

Sources:
  - VL models from ggml-org (HuggingFace: ggml-org/Qwen2.5-VL-7B-Instruct-GGUF)
  - 14B from HuggingFace: Qwen/Qwen2.5-14B-Instruct-GGUF
"""

import os
import sys
import json
import hashlib
import shutil
from pathlib import Path
from typing import Optional, Dict, Tuple
from datetime import datetime

try:
    from loguru import logger
except ImportError:
    import logging
    logger = logging.getLogger("model-manager")

try:
    from huggingface_hub import hf_hub_download, snapshot_download
    HAS_HF = True
except ImportError:
    HAS_HF = False

PROJECT_ROOT = Path(__file__).resolve().parent.parent

# Model directory: respect XUANSHU_MODEL_DIR env var, fallback to D:\模型\, then PROJECT_ROOT/models
_ENV_MODEL_DIR = os.environ.get("XUANSHU_MODEL_DIR", "")
if _ENV_MODEL_DIR:
    MODELS_DIR = Path(_ENV_MODEL_DIR)
elif os.path.isdir(r"D:\模型"):
    MODELS_DIR = Path(r"D:\模型")
else:
    MODELS_DIR = PROJECT_ROOT / "models"

# ============================================================================
# Model Definitions
# ============================================================================

DRAFT_MODEL = {
    "name": "Qwen2.5-VL-7B-Instruct",
    "display_name": "Qwen2.5-VL-7B (Draft · GPU)",
    "quantization": "Q3_K_M",
    "files": [
        {
            "filename": "Qwen2.5-VL-7B-Instruct.Q3_K_M.gguf",
            "size_gb": 4.1,
            "repo": "ggml-org/Qwen2.5-VL-7B-Instruct-GGUF",
        },
        {
            "filename": "mmproj-Qwen_Qwen2.5-VL-7B-Instruct-f16.gguf",
            "size_gb": 1.3,
            "repo": "ggml-org/Qwen2.5-VL-7B-Instruct-GGUF",
            "optional": False,
        },
    ],
    "estimated_vram_gb": 6.1,
    "context_length": 8192,
    "description": "轻量多模态模型，全 GPU 推理，适合日常对话和快速任务",
}

VERIFY_MODEL = {
    "name": "Qwen2.5-14B-Instruct",
    "display_name": "Qwen2.5-14B (Verify · CPU)",
    "quantization": "Q4_K_M",
    "files": [
        {
            "filename": "qwen2.5-14b-instruct-Q4_K_M.gguf",
            "size_gb": 20.0,
            "repo": "Qwen/Qwen2.5-14B-Instruct-GGUF",
        },
    ],
    "estimated_ram_gb": 20.0,
    "context_length": 32768,
    "description": "大参数纯文本模型，CPU 推理，适合深度分析、复杂推理和长篇创作",
}


# ============================================================================
# SHA256 Verification
# ============================================================================

# Expected SHA256 hashes (to be filled after first download)
EXPECTED_HASHES = {
    "Qwen2.5-VL-7B-Instruct.Q3_K_M.gguf": "",
    "mmproj-Qwen_Qwen2.5-VL-7B-Instruct-f16.gguf": "",
    "qwen2.5-14b-instruct-Q4_K_M.gguf": "",
}


def sha256_file(filepath: Path) -> str:
    """Compute SHA256 hash of a file."""
    sha = hashlib.sha256()
    with open(filepath, "rb") as f:
        while True:
            chunk = f.read(8 * 1024 * 1024)  # 8 MB chunks
            if not chunk:
                break
            sha.update(chunk)
    return sha.hexdigest()


def verify_model(filepath: Path, expected_hash: str = "") -> Tuple[bool, str]:
    """
    Verify model file integrity.

    Args:
        filepath: Path to the model file
        expected_hash: Expected SHA256 (empty = skip verification)

    Returns:
        (valid: bool, hash: str)
    """
    if not filepath.exists():
        return False, "File not found"

    actual_hash = sha256_file(filepath)

    if expected_hash and actual_hash != expected_hash:
        return False, f"SHA256 mismatch: expected {expected_hash[:16]}..., got {actual_hash[:16]}..."

    return True, actual_hash


# ============================================================================
# Model Manager
# ============================================================================

class ModelManager:
    """Manage model downloads, verification, and directory structure."""

    def __init__(self, models_dir: Optional[Path] = None):
        self.models_dir = Path(models_dir) if models_dir else MODELS_DIR
        self.draft_dir = self.models_dir / "draft"
        self.verify_dir = self.models_dir / "verify"
        self._ensure_dirs()

    def _ensure_dirs(self):
        """Create model directories if they don't exist."""
        self.models_dir.mkdir(parents=True, exist_ok=True)
        self.draft_dir.mkdir(exist_ok=True)
        self.verify_dir.mkdir(exist_ok=True)

    # ---- Status ----

    def status(self) -> Dict:
        """Return download/availability status for all models."""
        draft_files = DRAFT_MODEL["files"]
        verify_files = VERIFY_MODEL["files"]

        def check_files(files, directory):
            results = []
            for f in files:
                fpath = directory / f["filename"]
                exists = fpath.exists()
                size_gb = round(fpath.stat().st_size / (1024**3), 2) if exists else 0
                results.append({
                    "filename": f["filename"],
                    "exists": exists,
                    "size_gb": size_gb,
                    "expected_gb": f["size_gb"],
                })
            return results

        return {
            "draft": {
                "info": DRAFT_MODEL,
                "files": check_files(draft_files, self.draft_dir),
                "complete": all(f["exists"] for f in check_files(draft_files, self.draft_dir)),
            },
            "verify": {
                "info": VERIFY_MODEL,
                "files": check_files(verify_files, self.verify_dir),
                "complete": all(f["exists"] for f in check_files(verify_files, self.verify_dir)),
            },
        }

    def is_ready(self, mode: str = "draft") -> bool:
        """Check if a model mode is ready to use."""
        s = self.status()
        return s[mode]["complete"]

    # ---- Download ----

    def download_draft(self, force: bool = False) -> Dict:
        """Download Draft mode model files from HuggingFace."""
        if not HAS_HF:
            return {"success": False, "error": "huggingface_hub not installed. Run: pip install huggingface_hub"}

        results = []
        for file_info in DRAFT_MODEL["files"]:
            filename = file_info["filename"]
            dest = self.draft_dir / filename

            if dest.exists() and not force:
                logger.info(f"Draft model file already exists: {filename}")
                results.append({"filename": filename, "status": "already_exists"})
                continue

            try:
                logger.info(f"Downloading {filename} from {file_info['repo']}...")
                downloaded = hf_hub_download(
                    repo_id=file_info["repo"],
                    filename=filename,
                    local_dir=str(self.draft_dir),
                    local_dir_use_symlinks=False,
                )
                # Verify
                valid, hash_val = verify_model(Path(downloaded))
                results.append({
                    "filename": filename,
                    "status": "downloaded",
                    "path": downloaded,
                    "sha256": hash_val,
                    "verified": valid,
                })
            except Exception as e:
                logger.error(f"Download failed for {filename}: {e}")
                results.append({"filename": filename, "status": "failed", "error": str(e)})

        # Write model info
        self._write_model_info("draft", DRAFT_MODEL, results)

        return {"success": all(r["status"] != "failed" for r in results), "results": results}

    def download_verify(self, force: bool = False) -> Dict:
        """Download Verify mode model files from HuggingFace."""
        if not HAS_HF:
            return {"success": False, "error": "huggingface_hub not installed"}

        results = []
        for file_info in VERIFY_MODEL["files"]:
            filename = file_info["filename"]
            dest = self.verify_dir / filename

            if dest.exists() and not force:
                logger.info(f"Verify model file already exists: {filename}")
                results.append({"filename": filename, "status": "already_exists"})
                continue

            try:
                logger.info(f"Downloading {filename} from {file_info['repo']}...")
                downloaded = hf_hub_download(
                    repo_id=file_info["repo"],
                    filename=filename,
                    local_dir=str(self.verify_dir),
                    local_dir_use_symlinks=False,
                )
                valid, hash_val = verify_model(Path(downloaded))
                results.append({
                    "filename": filename,
                    "status": "downloaded",
                    "path": downloaded,
                    "sha256": hash_val,
                    "verified": valid,
                })
            except Exception as e:
                logger.error(f"Download failed for {filename}: {e}")
                results.append({"filename": filename, "status": "failed", "error": str(e)})

        self._write_model_info("verify", VERIFY_MODEL, results)

        return {"success": all(r["status"] != "failed" for r in results), "results": results}

    def download_all(self, force: bool = False) -> Dict:
        """Download all models."""
        draft_result = self.download_draft(force=force)
        verify_result = self.download_verify(force=force)
        return {
            "draft": draft_result,
            "verify": verify_result,
        }

    # ---- Helpers ----

    def _write_model_info(self, mode: str, model_def: Dict, results: list):
        """Write model_info.json after download."""
        info = {
            "name": model_def["name"],
            "display_name": model_def["display_name"],
            "quantization": model_def["quantization"],
            "context_length": model_def.get("context_length", 8192),
            "downloaded_at": datetime.now().isoformat(),
            "files": results,
        }
        dir_path = self.draft_dir if mode == "draft" else self.verify_dir
        info_path = dir_path / "model_info.json"
        with open(info_path, "w", encoding="utf-8") as f:
            json.dump(info, f, ensure_ascii=False, indent=2)

    def get_llama_cmd(self, mode: str = "draft", extra_args: Optional[list] = None) -> str:
        """
        Generate llama.cpp server launch command.

        Args:
            mode: 'draft' or 'verify'
            extra_args: Additional CLI args

        Returns:
            Full command string for llama-server
        """
        if mode == "draft":
            model_path = self.draft_dir / "Qwen2.5-VL-7B-Instruct.Q3_K_M.gguf"
            mmproj_path = self.draft_dir / "mmproj-Qwen_Qwen2.5-VL-7B-Instruct-f16.gguf"
            cmd = (
                f'llama-server '
                f'-m "{model_path}" '
                f'--mmproj "{mmproj_path}" '
                f'--host 127.0.0.1 --port 8080 '
                f'-ngl 99 '  # Full GPU
                f'-c 8192 '
                f'--temp 0.7 --top-p 0.9 --top-k 40 '
                f'--repeat-penalty 1.1 '
            )
        else:  # verify
            model_path = self.verify_dir / "qwen2.5-14b-instruct-Q4_K_M.gguf"
            cmd = (
                f'llama-server '
                f'-m "{model_path}" '
                f'--host 127.0.0.1 --port 8081 '
                f'-ngl 0 '  # CPU only
                f'-c 32768 '
                f'--temp 0.7 --top-p 0.9 --top-k 40 '
                f'--repeat-penalty 1.1 '
            )

        if extra_args:
            cmd += " ".join(extra_args)

        return cmd.strip()

    def clean(self, mode: Optional[str] = None):
        """Remove downloaded model files to free disk space."""
        if mode in (None, "draft"):
            for f in DRAFT_MODEL["files"]:
                fpath = self.draft_dir / f["filename"]
                if fpath.exists():
                    fpath.unlink()
                    logger.info(f"Removed: {fpath}")
        if mode in (None, "verify"):
            for f in VERIFY_MODEL["files"]:
                fpath = self.verify_dir / f["filename"]
                if fpath.exists():
                    fpath.unlink()
                    logger.info(f"Removed: {fpath}")

    def disk_usage(self) -> Dict:
        """Calculate disk usage for model files."""
        total = 0
        for dir_path in [self.draft_dir, self.verify_dir]:
            if dir_path.exists():
                for f in dir_path.rglob("*.gguf"):
                    total += f.stat().st_size
        return {
            "total_gb": round(total / (1024**3), 2),
            "draft_gb": round(
                sum(
                    (f.stat().st_size for f in self.draft_dir.rglob("*.gguf") if f.exists()),
                    0,
                ) / (1024**3),
                2,
            ) if self.draft_dir.exists() else 0,
            "verify_gb": round(
                sum(
                    (f.stat().st_size for f in self.verify_dir.rglob("*.gguf") if f.exists()),
                    0,
                ) / (1024**3),
                2,
            ) if self.verify_dir.exists() else 0,
        }


# ============================================================================
# Standalone usage
# ============================================================================

def main():
    """CLI for model management."""
    import argparse

    parser = argparse.ArgumentParser(description="玄枢 Model Manager")
    parser.add_argument("action", nargs="?", default="status",
                        choices=["status", "download-draft", "download-verify", "download-all", "clean", "disk"])
    parser.add_argument("--force", action="store_true", help="Force re-download")
    args = parser.parse_args()

    mgr = ModelManager()

    if args.action == "status":
        s = mgr.status()
        print("=" * 60)
        print("  玄枢 Model Status")
        print("=" * 60)
        for mode in ["draft", "verify"]:
            info = s[mode]
            print(f"\n  [{mode.upper()}] {info['info']['display_name']}")
            print(f"    Quantization: {info['info']['quantization']}")
            print(f"    Complete: {info['complete']}")
            for f in info["files"]:
                status = "✓" if f["exists"] else "✗"
                print(f"    [{status}] {f['filename']} ({f['size_gb']} GB)")
        print()

    elif args.action == "download-draft":
        result = mgr.download_draft(force=args.force)
        print(json.dumps(result, ensure_ascii=False, indent=2))

    elif args.action == "download-verify":
        result = mgr.download_verify(force=args.force)
        print(json.dumps(result, ensure_ascii=False, indent=2))

    elif args.action == "download-all":
        result = mgr.download_all(force=args.force)
        print(json.dumps(result, ensure_ascii=False, indent=2))

    elif args.action == "clean":
        mgr.clean()
        print("All model files removed.")

    elif args.action == "disk":
        usage = mgr.disk_usage()
        print(f"Total model storage: {usage['total_gb']} GB")
        print(f"  Draft:  {usage['draft_gb']} GB")
        print(f"  Verify: {usage['verify_gb']} GB")


if __name__ == "__main__":
    main()
