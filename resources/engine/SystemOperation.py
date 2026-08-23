"""
玄枢 AI — SystemOperation 软件操控模块
========================================
三层操控策略：
  1. COM Automation（Office/WPS 等原生支持 COM 的软件）—— 毫秒级、零误差
  2. 命令行调用（ffmpeg / ImageMagick / 7z 等 CLI 工具）—— 秒级
  3. UI Automation + 视觉（兜底：pyautogui + screenshot + vision model）

Author: 玄枢开发组
Version: 1.0.0
"""

import os
import sys
import time
import json
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Optional, List, Dict, Any, Tuple
from dataclasses import dataclass

try:
    from loguru import logger
except ImportError:
    import logging
    logger = logging.getLogger("system-operation")

# ============================================================================
# 层一：COM Automation
# ============================================================================

class COMAutomation:
    """Windows COM 自动化层：直接操纵 Office/WPS/浏览器"""

    @staticmethod
    def _init_com():
        """初始化 COM 环境"""
        import pythoncom
        pythoncom.CoInitialize()

    # ---- PowerPoint / WPS 演示 ----

    @staticmethod
    def ppt_create_presentation(use_wps: bool = True) -> Any:
        """创建新的 PPT 演示文稿"""
        COMAutomation._init_com()
        import win32com.client

        app_id = "wps.Application" if use_wps else "PowerPoint.Application"
        app = win32com.client.Dispatch(app_id)
        app.Visible = True
        presentation = app.Presentations.Add()
        return {"app": app, "presentation": presentation}

    @staticmethod
    def ppt_add_slide(presentation, layout_index: int = 1):
        """添加一张幻灯片"""
        return presentation.Slides.Add(
            presentation.Slides.Count + 1,
            layout_index
        )

    @staticmethod
    def ppt_add_textbox(slide, text: str, left: int = 100, top: int = 100,
                        width: int = 700, height: int = 400, font_size: int = 18):
        """在幻灯片上添加文本框"""
        shape = slide.Shapes.AddTextbox(1, left, top, width, height)
        shape.TextFrame.TextRange.Text = text
        shape.TextFrame.TextRange.Font.Size = font_size
        return shape

    @staticmethod
    def ppt_apply_morph(slide):
        """对幻灯片应用 MORPH 切换动画"""
        try:
            # ppEffectMorph = 0x12 (18)
            slide.SlideShowTransition.EntryEffect = 18
            return True
        except Exception:
            return False

    @staticmethod
    def ppt_save_as(presentation, filepath: str):
        """保存 PPT"""
        presentation.SaveAs(filepath)

    @staticmethod
    def ppt_close(presentation, app):
        """关闭 PPT 应用"""
        presentation.Close()
        app.Quit()

    # ---- Word / WPS 文字 ----

    @staticmethod
    def word_create_document(use_wps: bool = True) -> Any:
        """创建 Word 文档"""
        COMAutomation._init_com()
        import win32com.client

        app_id = "wps.Application" if use_wps else "Word.Application"
        app = win32com.client.Dispatch(app_id)
        app.Visible = True
        doc = app.Documents.Add()
        return {"app": app, "document": doc}

    @staticmethod
    def word_insert_text(doc, text: str, font_name: str = "微软雅黑",
                         font_size: int = 12):
        """插入文本"""
        selection = doc.Application.Selection
        selection.Font.Name = font_name
        selection.Font.Size = font_size
        selection.TypeText(text)
        selection.TypeParagraph()

    @staticmethod
    def word_save_as(doc, filepath: str):
        """保存 Word 文档"""
        doc.SaveAs(filepath)

    @staticmethod
    def word_close(doc, app):
        """关闭 Word"""
        doc.Close()
        app.Quit()

    # ---- Excel / WPS 表格 ----

    @staticmethod
    def excel_create_workbook(use_wps: bool = True) -> Any:
        """创建 Excel 工作簿"""
        COMAutomation._init_com()
        import win32com.client

        app_id = "et.Application" if use_wps else "Excel.Application"
        app = win32com.client.Dispatch(app_id)
        app.Visible = True
        wb = app.Workbooks.Add()
        return {"app": app, "workbook": wb}

    @staticmethod
    def excel_write_cell(worksheet, row: int, col: int, value: Any):
        """写入单元格"""
        worksheet.Cells(row, col).Value = value

    @staticmethod
    def excel_save_as(workbook, filepath: str):
        """保存工作簿"""
        workbook.SaveAs(filepath)


# ============================================================================
# 层二：命令行工具调用
# ============================================================================

class CommandLineTools:
    """命令行工具层：ffmpeg / ImageMagick / 7z / aria2c 等"""

    # ---- FFmpeg ----

    @staticmethod
    def ffmpeg_convert(input_path: str, output_path: str, codec: str = "libx264",
                       crf: int = 23, preset: str = "medium") -> bool:
        """视频转码"""
        cmd = [
            "ffmpeg", "-y", "-i", input_path,
            "-c:v", codec, "-crf", str(crf), "-preset", preset,
            output_path
        ]
        result = subprocess.run(cmd, capture_output=True, text=True)
        return result.returncode == 0

    @staticmethod
    def ffmpeg_trim(input_path: str, output_path: str,
                    start: str, duration: str) -> bool:
        """视频裁剪"""
        cmd = [
            "ffmpeg", "-y", "-ss", start, "-i", input_path,
            "-t", duration, "-c", "copy", output_path
        ]
        result = subprocess.run(cmd, capture_output=True, text=True)
        return result.returncode == 0

    @staticmethod
    def ffmpeg_extract_audio(input_path: str, output_path: str,
                             bitrate: str = "192k") -> bool:
        """提取音频"""
        cmd = [
            "ffmpeg", "-y", "-i", input_path,
            "-vn", "-ab", bitrate, "-ar", "44100",
            output_path
        ]
        result = subprocess.run(cmd, capture_output=True, text=True)
        return result.returncode == 0

    @staticmethod
    def ffmpeg_merge_videos(input_paths: List[str], output_path: str) -> bool:
        """合并视频（无损）"""
        # 创建 concat 文件列表
        concat_file = tempfile.NamedTemporaryFile(mode="w", suffix=".txt", delete=False)
        for p in input_paths:
            concat_file.write(f"file '{p}'\n")
        concat_file.close()

        cmd = [
            "ffmpeg", "-y", "-f", "concat", "-safe", "0",
            "-i", concat_file.name, "-c", "copy", output_path
        ]
        result = subprocess.run(cmd, capture_output=True, text=True)
        os.unlink(concat_file.name)
        return result.returncode == 0

    @staticmethod
    def ffprobe_info(input_path: str) -> Optional[dict]:
        """获取视频/音频元信息"""
        cmd = [
            "ffprobe", "-v", "quiet", "-print_format", "json",
            "-show_format", "-show_streams", input_path
        ]
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode == 0:
            return json.loads(result.stdout)
        return None

    # ---- ImageMagick ----

    @staticmethod
    def imagemagick_convert(input_path: str, output_path: str,
                            width: int = None, height: int = None,
                            quality: int = 90) -> bool:
        """图片格式转换/缩放"""
        cmd = ["magick", input_path]
        if width and height:
            cmd.extend(["-resize", f"{width}x{height}"])
        if output_path.endswith(".jpg") or output_path.endswith(".jpeg"):
            cmd.extend(["-quality", str(quality)])
        cmd.append(output_path)
        result = subprocess.run(cmd, capture_output=True, text=True)
        return result.returncode == 0

    @staticmethod
    def imagemagick_batch_resize(input_dir: str, output_dir: str,
                                 width: int, height: int) -> int:
        """批量缩放图片"""
        Path(output_dir).mkdir(parents=True, exist_ok=True)
        count = 0
        for ext in ["*.jpg", "*.jpeg", "*.png", "*.webp"]:
            for f in Path(input_dir).glob(ext):
                out = Path(output_dir) / f.name
                if CommandLineTools.imagemagick_convert(
                    str(f), str(out), width, height
                ):
                    count += 1
        return count

    # ---- 7-Zip ----

    @staticmethod
    def zip_extract(archive_path: str, output_dir: str) -> bool:
        """解压文件"""
        Path(output_dir).mkdir(parents=True, exist_ok=True)
        cmd = ["7z", "x", archive_path, f"-o{output_dir}", "-y"]
        result = subprocess.run(cmd, capture_output=True, text=True)
        return result.returncode == 0

    @staticmethod
    def zip_compress(input_path: str, output_path: str,
                     level: int = 5) -> bool:
        """压缩文件/目录"""
        cmd = ["7z", "a", f"-mx{level}", output_path, input_path]
        result = subprocess.run(cmd, capture_output=True, text=True)
        return result.returncode == 0


# ============================================================================
# 层三：UI Automation + 视觉（兜底）
# ============================================================================

class UIAutomation:
    """UI Automation 层：pyautogui + 截图 + 视觉模型"""

    @staticmethod
    def screenshot(region: Tuple[int, int, int, int] = None) -> str:
        """截图并保存到临时文件，返回路径"""
        import pyautogui
        img = pyautogui.screenshot(region=region)
        path = os.path.join(tempfile.gettempdir(), f"xuan_screenshot_{int(time.time())}.png")
        img.save(path)
        return path

    @staticmethod
    def click(x: int, y: int, button: str = "left"):
        """鼠标点击"""
        import pyautogui
        pyautogui.click(x, y, button=button)

    @staticmethod
    def double_click(x: int, y: int):
        """鼠标双击"""
        import pyautogui
        pyautogui.doubleClick(x, y)

    @staticmethod
    def type_text(text: str, interval: float = 0.05):
        """键盘输入文字"""
        import pyautogui
        pyautogui.typewrite(text, interval=interval)

    @staticmethod
    def press_key(key: str):
        """按下按键"""
        import pyautogui
        pyautogui.press(key)

    @staticmethod
    def hotkey(*keys: str):
        """组合键"""
        import pyautogui
        pyautogui.hotkey(*keys)

    @staticmethod
    def move_to(x: int, y: int, duration: float = 0.3):
        """移动鼠标"""
        import pyautogui
        pyautogui.moveTo(x, y, duration=duration)

    @staticmethod
    def scroll(clicks: int):
        """滚轮滚动"""
        import pyautogui
        pyautogui.scroll(clicks)

    @staticmethod
    def get_screen_size() -> Tuple[int, int]:
        """获取屏幕尺寸"""
        import pyautogui
        return pyautogui.size()

    @staticmethod
    def locate_on_screen(image_path: str, confidence: float = 0.9) -> Optional[Tuple[int, int]]:
        """在屏幕上定位图像（视觉匹配）"""
        import pyautogui
        try:
            location = pyautogui.locateOnScreen(image_path, confidence=confidence)
            if location:
                return pyautogui.center(location)
        except Exception:
            pass
        return None

    @staticmethod
    def open_start_menu():
        """打开开始菜单"""
        import pyautogui
        pyautogui.press("win")

    @staticmethod
    def search_and_open(app_name: str):
        """通过开始菜单搜索并打开应用"""
        import pyautogui
        pyautogui.press("win")
        time.sleep(0.5)
        pyautogui.typewrite(app_name, interval=0.05)
        time.sleep(0.5)
        pyautogui.press("enter")


# ============================================================================
# 统一操控接口
# ============================================================================

class SystemOperation:
    """
    统一操控接口：自动选择最优操控方式

    优先级：COM > CLI > UI Automation
    """

    @staticmethod
    def open_app(app_name: str, method: str = "auto") -> bool:
        """
        打开应用

        Args:
            app_name: 应用名（如 'wps', 'code', 'chrome'）
            method: 'com' / 'cli' / 'ui' / 'auto'
        """
        if method == "auto":
            # 尝试 CLI 方式
            try:
                subprocess.Popen([app_name], shell=True)
                return True
            except Exception:
                pass
            # 兜底 UI
            try:
                UIAutomation.search_and_open(app_name)
                return True
            except Exception:
                return False
        elif method == "cli":
            try:
                subprocess.Popen([app_name], shell=True)
                return True
            except Exception:
                return False
        elif method == "ui":
            try:
                UIAutomation.search_and_open(app_name)
                return True
            except Exception:
                return False
        return False

    @staticmethod
    def read_file(filepath: str) -> Optional[str]:
        """读取文件内容（纯文本）"""
        try:
            with open(filepath, "r", encoding="utf-8") as f:
                return f.read()
        except UnicodeDecodeError:
            try:
                with open(filepath, "r", encoding="gbk") as f:
                    return f.read()
            except Exception:
                return None
        except Exception:
            return None

    @staticmethod
    def write_file(filepath: str, content: str) -> bool:
        """写入文件"""
        try:
            Path(filepath).parent.mkdir(parents=True, exist_ok=True)
            with open(filepath, "w", encoding="utf-8") as f:
                f.write(content)
            return True
        except Exception as e:
            logger.error(f"写入文件失败: {e}")
            return False

    @staticmethod
    def list_directory(dir_path: str, pattern: str = "*") -> List[str]:
        """列出目录内容"""
        p = Path(dir_path)
        if not p.exists():
            return []
        return [str(f) for f in p.glob(pattern)]

    @staticmethod
    def file_exists(filepath: str) -> bool:
        """检查文件是否存在"""
        return Path(filepath).exists()

    @staticmethod
    def copy_file(src: str, dst: str) -> bool:
        """复制文件"""
        try:
            Path(dst).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)
            return True
        except Exception as e:
            logger.error(f"复制失败: {e}")
            return False

    @staticmethod
    def move_file(src: str, dst: str) -> bool:
        """移动文件"""
        try:
            Path(dst).parent.mkdir(parents=True, exist_ok=True)
            shutil.move(src, dst)
            return True
        except Exception as e:
            logger.error(f"移动失败: {e}")
            return False

    @staticmethod
    def delete_file(filepath: str, to_recycle: bool = True) -> bool:
        """
        删除文件

        Args:
            filepath: 文件路径
            to_recycle: True = 移到回收站，False = 永久删除
        """
        if to_recycle:
            try:
                import send2trash
                send2trash.send2trash(filepath)
                return True
            except ImportError:
                # 降级：直接删除
                pass
        try:
            os.remove(filepath)
            return True
        except Exception as e:
            logger.error(f"删除失败: {e}")
            return False


# ============================================================================
# CLI / 测试入口
# ============================================================================

def main():
    import argparse

    parser = argparse.ArgumentParser(description="玄枢 SystemOperation CLI")
    parser.add_argument("action", choices=["open", "screenshot", "info", "list"])
    parser.add_argument("--target", default=None, help="目标（应用名/路径）")
    args = parser.parse_args()

    if args.action == "open" and args.target:
        success = SystemOperation.open_app(args.target)
        print(f"打开 {args.target}: {'成功' if success else '失败'}")

    elif args.action == "screenshot":
        path = UIAutomation.screenshot()
        print(f"截图保存到: {path}")

    elif args.action == "info":
        size = UIAutomation.get_screen_size()
        print(f"屏幕尺寸: {size[0]}x{size[1]}")

    elif args.action == "list" and args.target:
        files = SystemOperation.list_directory(args.target)
        print(f"\n{args.target} 内容 ({len(files)} 项):")
        for f in files:
            print(f"  {f}")


if __name__ == "__main__":
    main()
