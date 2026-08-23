"""
玄枢 AI Engine v3.1 — Edge TTS 流式语音引擎
=============================================
使用 Windows WinRT Edge TTS 实现本地流式语音合成。
不依赖网络，离线可用。

架构：LLM 逐句输出 → 立即送 TTS 合成 → 加入播放队列
  - 句子边界检测：遇到 。！？\n 即截断
  - 防哽咽机制：队列耗尽播放 200ms 静音，绝不等 token
  - 播放队列：至少保持 2 句缓冲，异步播放

音色：默认 xiaoxiao(女), yunxi(男)，可切换
降级方案：WinRT 不可用时使用 pyttsx3
"""

import os
import sys
import time
import re
import queue
import threading
import tempfile
import subprocess
from pathlib import Path
from dataclasses import dataclass, field
from typing import Optional, List, Callable

# --- 日志 ---
import logging
logger = logging.getLogger("xuanshu-voice")

# ============================================================================
# 音色配置
# ============================================================================
VOICES = {
    "xiaoxiao": {"name": "Microsoft Xiaoxiao", "gender": "female", "lang": "zh-CN"},
    "yunxi":    {"name": "Microsoft Yunxi",    "gender": "male",   "lang": "zh-CN"},
    "xiaoyi":   {"name": "Microsoft Xiaoyi",   "gender": "female", "lang": "zh-CN"},
    "yunjian":  {"name": "Microsoft Yunjian",  "gender": "male",   "lang": "zh-CN"},
}

# 句子边界正则
SENTENCE_BOUNDARY = re.compile(r'[。！？\n]')

# 播放队列缓冲大小
MIN_QUEUE_BUFFER = 2
SILENCE_PAD_MS = 200  # 队列耗尽时的静音填充(ms)


@dataclass
class VoiceConfig:
    voice: str = "xiaoxiao"
    rate: float = 0.0       # -100 ~ 100
    pitch: float = 0.0      # -50 ~ 50
    volume: float = 100.0   # 0 ~ 100

    def to_dict(self) -> dict:
        return {
            "voice": self.voice,
            "rate": self.rate,
            "pitch": self.pitch,
            "volume": self.volume,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "VoiceConfig":
        return cls(
            voice=d.get("voice", "xiaoxiao"),
            rate=d.get("rate", 0.0),
            pitch=d.get("pitch", 0.0),
            volume=d.get("volume", 100.0),
        )


# ============================================================================
# WinRT Edge TTS 核心
# ============================================================================
class WinRTTTSEngine:
    """通过 Windows WinRT (Windows.Media.SpeechSynthesis) 调用 Edge TTS"""

    def __init__(self, config: VoiceConfig = None):
        self.config = config or VoiceConfig()
        self._synth = None
        self._voices = {}
        self._initialized = False

    def initialize(self) -> bool:
        """初始化 WinRT SpeechSynthesizer"""
        if self._initialized:
            return True

        try:
            # 方式一：comtypes
            import comtypes.client
            self._synth = comtypes.client.CreateObject("Windows.Media.SpeechSynthesis.SpeechSynthesizer")
            self._initialized = True
            logger.info("Edge TTS (WinRT) 初始化成功")
            return True
        except ImportError:
            pass
        except Exception as e:
            logger.debug(f"comtypes 初始化失败: {e}")

        try:
            # 方式二：winsdk (winrt)
            import winrt.windows.media.speechsynthesis as speech
            self._synth = speech.SpeechSynthesizer()
            self._initialized = True
            logger.info("Edge TTS (winsdk) 初始化成功")
            return True
        except ImportError:
            pass
        except Exception as e:
            logger.debug(f"winsdk 初始化失败: {e}")

        logger.warning("Edge TTS (WinRT) 不可用，将使用降级方案")
        return False

    def synthesize_to_file(self, text: str, output_path: str) -> bool:
        """将文本合成为音频文件"""
        if not self._initialized:
            return False
        if not text.strip():
            return False

        try:
            import comtypes.client

            # 创建合成流
            synth = self._synth

            # 设置语音
            voice_info = VOICES.get(self.config.voice, VOICES["xiaoxiao"])

            # 使用 SSML 来控制语速、音调
            ssml = (
                f'<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" '
                f'xml:lang="{voice_info["lang"]}">'
                f'<voice name="{voice_info["name"]}">'
                f'<prosody rate="{self.config.rate:+d}%" pitch="{self.config.pitch:+d}Hz" '
                f'volume="{self.config.volume:.0f}">'
                f'{text}'
                f'</prosody></voice></speak>'
            )

            stream = synth.SynthesizeSsmlToStreamAsync(ssml)
            # WinRT 异步调用
            result = stream.get()  # 同步等待

            # 读取音频数据并写入文件
            import struct
            reader = result.GetInputStreamAt(0)
            buf_size = result.Size
            data = bytearray(buf_size)

            # 使用 Windows.Storage.Streams.DataReader
            import comtypes.gen.WindowsStorageStreams as wss
            dr = wss.DataReader(reader)
            dr.LoadAsync(buf_size).get()
            dr.ReadBytes(data)

            with open(output_path, "wb") as f:
                f.write(data)
            return True

        except Exception as e:
            logger.error(f"WinRT 合成失败: {e}")
            return False

    def is_available(self) -> bool:
        return self._initialized


# ============================================================================
# pyttsx3 降级引擎
# ============================================================================
class Pyttsx3FallbackEngine:
    """降级方案：pyttsx3 本地 TTS"""

    def __init__(self, config: VoiceConfig = None):
        self.config = config or VoiceConfig()
        self._engine = None

    def initialize(self) -> bool:
        try:
            import pyttsx3
            self._engine = pyttsx3.init()
            logger.info("pyttsx3 降级引擎初始化成功")
            return True
        except ImportError:
            logger.error("pyttsx3 未安装。运行: pip install pyttsx3")
            return False
        except Exception as e:
            logger.error(f"pyttsx3 初始化失败: {e}")
            return False

    def synthesize_to_file(self, text: str, output_path: str) -> bool:
        if self._engine is None:
            return False
        try:
            self._engine.save_to_file(text, output_path)
            self._engine.runAndWait()
            return True
        except Exception as e:
            logger.error(f"pyttsx3 合成失败: {e}")
            return False

    def is_available(self) -> bool:
        return self._engine is not None


# ============================================================================
# 音频播放器
# ============================================================================
class AudioPlayer:
    """异步音频播放队列"""

    def __init__(self):
        # BUG-010 fix: 使用 maxsize=50 限制队列容量，生产者满时阻塞实现背压控制
        self._queue: queue.Queue = queue.Queue(maxsize=50)
        self._thread: Optional[threading.Thread] = None
        self._running = False
        self._lock = threading.Lock()

    def start(self):
        if self._running:
            return
        self._running = True
        self._thread = threading.Thread(target=self._play_loop, daemon=True, name="audio-player")
        self._thread.start()
        logger.info("音频播放队列已启动")

    def stop(self):
        self._running = False
        # 放一个哨兵确保线程退出
        self._queue.put(None)
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=2)

    def enqueue(self, file_path: str):
        self._queue.put(file_path)

    def clear(self):
        while not self._queue.empty():
            try:
                self._queue.get_nowait()
            except queue.Empty:
                break

    def queue_size(self) -> int:
        return self._queue.qsize()

    def _play_loop(self):
        """播放循环"""
        while self._running:
            try:
                file_path = self._queue.get(timeout=0.2)
            except queue.Empty:
                # 队列空时播放入 200ms 静音（防哽咽）
                time.sleep(SILENCE_PAD_MS / 1000.0)
                continue

            if file_path is None:
                break

            if not os.path.exists(file_path):
                continue

            try:
                self._play_wav(file_path)
            except Exception as e:
                logger.error(f"播放失败 {file_path}: {e}")
            finally:
                # 清理临时文件
                try:
                    os.remove(file_path)
                except Exception:
                    pass

    @staticmethod
    def _play_wav(file_path: str):
        """使用 winsound 或 ffplay 播放 .wav 文件"""
        try:
            import winsound
            winsound.PlaySound(file_path, winsound.SND_FILENAME | winsound.SND_ASYNC)
            # 等待播放完成（估算时长）
            file_size = os.path.getsize(file_path)
            duration = max(file_size / 32000, 0.5)  # 粗略估计
            time.sleep(duration)
        except ImportError:
            # 降级到 ffplay
            subprocess.run(
                ["ffplay", "-nodisp", "-autoexit", "-loglevel", "quiet", file_path],
                timeout=30,
            )
        except Exception as e:
            logger.debug(f"winsound 播放失败，尝试 ffplay: {e}")
            try:
                subprocess.run(
                    ["ffplay", "-nodisp", "-autoexit", "-loglevel", "quiet", file_path],
                    timeout=30,
                )
            except Exception as e2:
                logger.error(f"无法播放音频: {e2}")


# ============================================================================
# VoiceEngine — 统一语音接口
# ============================================================================
class VoiceEngine:
    """
    流式语音合成引擎。

    用法:
        engine = VoiceEngine()
        engine.set_voice("xiaoxiao")
        engine.play("你好，世界！")
        engine.enqueue("第一句话。")
        engine.enqueue("第二句话。")
        engine.stop()
    """

    def __init__(self):
        self.config = VoiceConfig()
        self._tts: Optional[WinRTTTSEngine | Pyttsx3FallbackEngine] = None
        self._player = AudioPlayer()
        self._temp_dir = Path(tempfile.gettempdir()) / "xuanshu_tts"
        self._temp_dir.mkdir(exist_ok=True)
        self._sentence_buffer: str = ""
        self._buffer_lock = threading.Lock()
        self._initialized = False

    def initialize(self) -> bool:
        """初始化 TTS 引擎（优先 WinRT，降级 pyttsx3）"""
        if self._initialized:
            return True

        # 尝试 WinRT
        winrt_engine = WinRTTTSEngine(self.config)
        if winrt_engine.initialize():
            self._tts = winrt_engine
            self._initialized = True
            self._player.start()
            logger.info("VoiceEngine 初始化完成（WinRT Edge TTS）")
            return True

        # 降级 pyttsx3
        fallback = Pyttsx3FallbackEngine(self.config)
        if fallback.initialize():
            self._tts = fallback
            self._initialized = True
            self._player.start()
            logger.info("VoiceEngine 初始化完成（pyttsx3 降级）")
            return True

        logger.error("VoiceEngine 初始化失败：无可用的 TTS 引擎")
        return False

    def set_voice(self, name: str):
        """切换音色"""
        if name not in VOICES:
            logger.warning(f"未知音色 '{name}'，可用: {list(VOICES.keys())}")
            return
        self.config.voice = name
        logger.info(f"音色切换到: {name} ({VOICES[name]['name']})")
        # 重新初始化 TTS 引擎以应用新音色
        self._initialized = False
        self.initialize()

    def play(self, text: str):
        """合成并立即播放单句文本"""
        self._synthesize_and_enqueue(text.strip())

    def enqueue(self, sentence: str):
        """将句子加入播放队列（流式场景）"""
        if not sentence.strip():
            return
        self._synthesize_and_enqueue(sentence.strip())

    def feed(self, chunk: str):
        """
        流式输入：逐 token 喂入文本。
        检测到句子边界时自动截断并送入合成队列。
        """
        with self._buffer_lock:
            self._sentence_buffer += chunk
            # 检查句子边界
            while True:
                match = SENTENCE_BOUNDARY.search(self._sentence_buffer)
                if not match:
                    break
                end_pos = match.end()
                sentence = self._sentence_buffer[:end_pos].strip()
                self._sentence_buffer = self._sentence_buffer[end_pos:]
                if sentence:
                    self._synthesize_and_enqueue(sentence)

    def flush(self):
        """刷新缓冲区：将剩余文本作为一句送出"""
        with self._buffer_lock:
            remaining = self._sentence_buffer.strip()
            self._sentence_buffer = ""
            if remaining:
                self._synthesize_and_enqueue(remaining)

    def stop(self):
        """停止播放并清空队列"""
        self._player.clear()
        with self._buffer_lock:
            self._sentence_buffer = ""
        logger.info("语音播放已停止，队列已清空")

    def shutdown(self):
        """关闭语音引擎"""
        self.stop()
        self._player.stop()

    def queue_size(self) -> int:
        return self._player.queue_size()

    def is_available(self) -> bool:
        return self._initialized and self._tts is not None

    def _synthesize_and_enqueue(self, text: str):
        """异步合成并加入播放队列"""
        if not text:
            return
        if not self._initialized:
            logger.warning("VoiceEngine 未初始化，跳过合成")
            return

        # 在单独线程中进行合成（避免阻塞）
        def do_synth():
            try:
                output_path = str(
                    self._temp_dir / f"tts_{int(time.time()*1000)}_{hash(text)%10000:04d}.wav"
                )
                success = self._tts.synthesize_to_file(text, output_path)
                if success:
                    self._player.enqueue(output_path)
                else:
                    logger.warning(f"合成失败: {text[:30]}...")
            except Exception as e:
                logger.error(f"合成异常: {e}")

        t = threading.Thread(target=do_synth, daemon=True)
        t.start()


# ============================================================================
# 便捷测试入口
# ============================================================================
if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s | %(levelname)s | %(message)s")

    engine = VoiceEngine()
    if engine.initialize():
        engine.set_voice("xiaoxiao")
        engine.play("你好，我是玄枢AI的语音引擎。")
        engine.enqueue("这是第二句话。")
        engine.enqueue("当前使用的是Edge TTS离线合成。")
        time.sleep(10)
        engine.shutdown()
    else:
        print("VoiceEngine 初始化失败")
