"""
audio_sense.py - 玄枢 听觉环境感知服务 v1.0 (M3 听觉情境)

职责：
  - 麦克风环境音采集与轻量分析（音量/人声/音乐/瞬态敲门等）
  - 通过 stdin/stdout JSON 协议与 Node.js 主进程通信
  - 输出归一化事件流，供感官总线(audio 通道)消费

协议（与 camera_tracker.py 一致）：
  输入 (stdin):  {"cmd": "start"|"stop"|"exit"}
  输出 (stdout): {"ts": ..., "db": -31.2, "level": "normal", "speech": false, "music": false, "transient": false, "changed": true}

分类说明（轻量规则，全部本地 numpy 实现，无重依赖）：
  - level:  silence(< -50dB) / quiet(-50~-38) / normal(-38~-25) / loud(>-25)
  - speech: 300-3400Hz 频带能量占比高 + 短时能量调制 2-10Hz
  - music:  频谱质心稳定 + 谐波结构（低频能量比高）
  - transient: 短时(10ms)能量尖峰跳变（敲门/拍桌/异响）
  - changed: 聚合场景相较上一秒发生变化时才置 true，用于事件驱动降噪
"""

import sys
import json
import time
import math
import threading
from typing import Optional

import numpy as np
import sounddevice as sd

# ============================================================
# 配置
# ============================================================

SAMPLE_RATE = 16000          # 16kHz 足够语音/环境音分析
BLOCK_SEC = 1.0              # 聚合分析窗口（秒）
TRANSIENT_WINDOW = 0.01      # 瞬态检测窗口（10ms）
RMS_MIN = 1e-6

# 电平阈值 (dBFS)
LV_SILENCE = -50.0
LV_QUIET = -38.0
LV_NORMAL = -25.0

# 语音频带 (Hz)
SPEECH_LOW = 300
SPEECH_HIGH = 3400

# 瞬态尖峰判定：当前 10ms RMS 相比前 100ms 中值高出倍数
TRANSIENT_RATIO = 4.0
TRANSIENT_DB_MIN = -30.0


# ============================================================
# 音频分析器
# ============================================================

class AudioAnalyzer:
    def __init__(self) -> None:
        self.running = False
        self.stream: Optional[sd.InputStream] = None
        self.buffer: list[np.ndarray] = []
        self.last_scene: Optional[dict] = None

    # ---------- 信号特征 ----------

    def _rms_db(self, x: np.ndarray) -> float:
        rms = float(np.sqrt(np.mean(np.square(x), axis=0))) if x.size else 0.0
        rms = max(rms, RMS_MIN)
        return 20.0 * math.log10(rms)

    def _fft_features(self, x: np.ndarray) -> dict:
        """FFT 特征：频谱质心 / 语音频带能量占比 / 低频占比"""
        n = len(x)
        if n < 32:
            return {'centroid': 0.0, 'speech_ratio': 0.0, 'low_ratio': 0.0}
        win = np.hanning(n)
        spec = np.abs(np.fft.rfft(x * win))
        freqs = np.fft.rfftfreq(n, d=1.0 / SAMPLE_RATE)
        total = float(np.sum(spec)) + 1e-9

        centroid = float(np.sum(freqs * spec) / total)
        speech_mask = (freqs >= SPEECH_LOW) & (freqs <= SPEECH_HIGH)
        low_mask = freqs <= 400
        return {
            'centroid': centroid,
            'speech_ratio': float(np.sum(spec[speech_mask]) / total),
            'low_ratio': float(np.sum(spec[low_mask]) / total),
        }

    def _energy_modulation(self, x: np.ndarray) -> float:
        """短时能量调制率：分 20ms 帧计算 RMS 序列，取 2-10Hz 频带占比（语音特征）"""
        frame = SAMPLE_RATE // 50  # 20ms
        if len(x) < frame * 4:
            return 0.0
        n_frames = len(x) // frame
        rms_seq = np.array([
            float(np.sqrt(np.mean(np.square(x[i * frame:(i + 1) * frame]), axis=0)))
            for i in range(n_frames)
        ])
        rms_seq = rms_seq - np.mean(rms_seq)
        if np.max(np.abs(rms_seq)) < 1e-6:
            return 0.0
        spec = np.abs(np.fft.rfft(rms_seq))
        freqs = np.fft.rfftfreq(len(rms_seq), d=frame / SAMPLE_RATE)
        total = float(np.sum(spec)) + 1e-9
        band = (freqs >= 2.0) & (freqs <= 10.0)
        return float(np.sum(spec[band]) / total)

    def _transient(self, x: np.ndarray) -> bool:
        """瞬态尖峰检测：10ms 子窗 RMS 相对前 100ms 中值跳变"""
        if len(x) < SAMPLE_RATE // 10:
            return False
        sub = SAMPLE_RATE // 100  # 10ms
        n = len(x) // sub
        rms_seq = np.array([
            float(np.sqrt(np.mean(np.square(x[i * sub:(i + 1) * sub]), axis=0)))
            for i in range(n)
        ])
        if n < 12:
            return False
        # 对每个 10ms 窗，与其前 10 个窗（100ms）中值比较
        for i in range(10, n):
            baseline = float(np.median(rms_seq[i - 10:i]))
            if baseline > 1e-5 and rms_seq[i] > baseline * TRANSIENT_RATIO:
                db = 20.0 * math.log10(max(rms_seq[i], RMS_MIN))
                if db > TRANSIENT_DB_MIN:
                    return True
        return False

    # ---------- 场景聚合 ----------

    def analyze(self, x: np.ndarray) -> dict:
        db = self._rms_db(x)
        fft = self._fft_features(x)
        mod = self._energy_modulation(x)
        transient = self._transient(x)

        # 电平分级
        if db < LV_SILENCE:
            level = 'silence'
        elif db < LV_QUIET:
            level = 'quiet'
        elif db < LV_NORMAL:
            level = 'normal'
        else:
            level = 'loud'

        # 语音判定：语音频带占比 + 能量调制 + 非纯瞬态
        speech = (fft['speech_ratio'] > 0.55 and mod > 0.35 and db > LV_QUIET)
        # 音乐判定：频谱质心稳定偏低 + 低频占比高 + 调制不强烈（排除语音）
        music = (fft['centroid'] < 2500 and fft['low_ratio'] > 0.35 and mod < 0.3 and db > LV_QUIET)

        # 安静时清零事件标志
        if db < LV_SILENCE:
            speech = music = False

        return {
            'ts': int(time.time() * 1000),
            'db': round(db, 1),
            'level': level,
            'speech': speech,
            'music': music,
            'transient': transient,
        }

    def scene_changed(self, cur: dict, prev: Optional[dict]) -> bool:
        if prev is None:
            return True
        keys = ['level', 'speech', 'music', 'transient']
        return any(cur[k] != prev[k] for k in keys)

    # ---------- 生命周期 ----------

    def _callback(self, indata: np.ndarray, _frames: int, _time_info, _status) -> None:
        if not self.running:
            return
        self.buffer.append(indata[:, 0].copy())

    def start(self) -> None:
        if self.running:
            return
        self.running = True
        self.buffer = []
        self.last_scene = None
        try:
            self.stream = sd.InputStream(
                samplerate=SAMPLE_RATE,
                channels=1,
                blocksize=SAMPLE_RATE // 10,   # 100ms 回调块
                callback=self._callback,
            )
            self.stream.start()
            print(json.dumps({'type': 'status', 'status': 'running'}, ensure_ascii=False), flush=True)
        except Exception as e:
            self.running = False
            print(json.dumps({'type': 'error', 'error': str(e)}, ensure_ascii=False), flush=True)

    def stop(self) -> None:
        self.running = False
        if self.stream:
            try:
                self.stream.stop()
                self.stream.close()
            except Exception:
                pass
            self.stream = None
        self.buffer = []
        print(json.dumps({'type': 'status', 'status': 'stopped'}, ensure_ascii=False), flush=True)

    def process_loop(self) -> None:
        """聚合线程：每秒对缓冲音频做一次场景分析并输出"""
        while True:
            if not self.running:
                time.sleep(0.1)
                continue
            time.sleep(BLOCK_SEC)
            if not self.running:
                break
            if not self.buffer:
                continue
            chunk = np.concatenate(self.buffer) if len(self.buffer) > 1 else self.buffer[0]
            self.buffer = []
            # 至少保留 0.5s 数据，避免启动瞬态
            if len(chunk) < SAMPLE_RATE // 2:
                continue
            scene = self.analyze(chunk)
            if self.scene_changed(scene, self.last_scene):
                scene['changed'] = True
                print(json.dumps(scene, ensure_ascii=False), flush=True)
            self.last_scene = scene


# ============================================================
# 主循环（stdin 命令协议）
# ============================================================

def main() -> None:
    analyzer = AudioAnalyzer()

    print(json.dumps({'type': 'status', 'status': 'ready'}, ensure_ascii=False), flush=True)

    # 主线程阻塞读 stdin 命令；分析循环在 start 后由独立线程驱动
    while True:
        line = sys.stdin.readline()
        if not line:
            break
        try:
            cmd = json.loads(line.strip()).get('cmd')
            if cmd == 'start':
                threading.Thread(target=analyzer.process_loop, daemon=True).start()
                analyzer.start()
            elif cmd == 'stop':
                analyzer.stop()
            elif cmd == 'exit':
                analyzer.stop()
                break
        except Exception as e:
            print(json.dumps({'type': 'error', 'error': str(e)}, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        pass
    except Exception as e:
        print(json.dumps({'type': 'error', 'error': str(e)}, ensure_ascii=False), flush=True)
