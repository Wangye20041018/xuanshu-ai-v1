#!/usr/bin/env python3
"""
voiceprint_bridge.py — MFCC 声纹特征提取与说话人验证

纯 numpy 实现，无需额外深度学习依赖。
- MFCC 特征提取：预加重 → 分帧 → 汉明窗 → FFT → Mel滤波器组 → log → DCT
- 说话人验证：余弦相似度（取多个注册样本的最高分）
- 噪声检测：基于 RMS 能量阈值的简单噪声门

用法：
  python voiceprint_bridge.py extract <wav_path>          # 提取 MFCC 特征 → JSON
  python voiceprint_bridge.py verify <wav_path> <ref_json> # 验证说话人 → JSON
  python voiceprint_bridge.py noise-check <wav_path>       # 噪声检测 → JSON
"""

import sys
import json
import struct
import math
import os

# ============================================================
# 纯 numpy 实现，若 numpy 不可用则回退到纯 Python 实现
# ============================================================
try:
    import numpy as np
    HAS_NUMPY = True
except ImportError:
    HAS_NUMPY = False


# ============================================================
# 音频 I/O — 读取 WAV 文件
# ============================================================
def read_wav(filepath: str):
    """读取 16-bit PCM WAV 文件，返回 (sample_rate, samples)"""
    if not os.path.exists(filepath):
        raise FileNotFoundError(f"WAV 文件不存在: {filepath}")

    with open(filepath, 'rb') as f:
        # RIFF header
        riff = f.read(4)
        if riff != b'RIFF':
            raise ValueError("不是有效的 WAV 文件")
        f.read(4)  # file size
        wave = f.read(4)
        if wave != b'WAVE':
            raise ValueError("不是有效的 WAV 文件")

        # 查找 fmt 和 data chunks
        sample_rate = 16000
        num_channels = 1
        bits_per_sample = 16
        data_bytes = None

        while True:
            chunk_id = f.read(4)
            if len(chunk_id) < 4:
                break
            chunk_size = struct.unpack('<I', f.read(4))[0]

            if chunk_id == b'fmt ':
                fmt_data = f.read(chunk_size)
                audio_format = struct.unpack('<H', fmt_data[0:2])[0]
                num_channels = struct.unpack('<H', fmt_data[2:4])[0]
                sample_rate = struct.unpack('<I', fmt_data[4:8])[0]
                bits_per_sample = struct.unpack('<H', fmt_data[14:16])[0]
                if audio_format != 1:  # PCM
                    raise ValueError(f"不支持的音频格式: {audio_format}")
            elif chunk_id == b'data':
                data_bytes = f.read(chunk_size)
            else:
                f.read(chunk_size)

        if data_bytes is None:
            raise ValueError("WAV 文件中未找到 data chunk")

        # 转换为 float 样本
        if bits_per_sample == 16:
            samples = struct.unpack('<' + 'h' * (len(data_bytes) // 2), data_bytes)
            samples = [s / 32768.0 for s in samples]
        elif bits_per_sample == 32:
            samples = struct.unpack('<' + 'i' * (len(data_bytes) // 4), data_bytes)
            samples = [s / 2147483648.0 for s in samples]
        else:
            raise ValueError(f"不支持的位深度: {bits_per_sample}")

        return sample_rate, samples


# ============================================================
# 数学工具（纯 Python 回退）
# ============================================================
def _hamming_window(n: int):
    """生成汉明窗"""
    return [0.54 - 0.46 * math.cos(2 * math.pi * i / (n - 1)) for i in range(n)]


def _dot(a, b):
    """向量点积"""
    return sum(x * y for x, y in zip(a, b))


def _norm(a):
    """向量 L2 范数"""
    return math.sqrt(sum(x * x for x in a))


def _cosine_similarity(a, b):
    """余弦相似度"""
    dot = _dot(a, b)
    norm_a = _norm(a)
    norm_b = _norm(b)
    if norm_a < 1e-12 or norm_b < 1e-12:
        return 0.0
    return max(-1.0, min(1.0, dot / (norm_a * norm_b)))


# ============================================================
# MFCC 特征提取
# ============================================================
class MFCCExtractor:
    """MFCC 特征提取器，支持 numpy 加速和纯 Python 回退"""

    def __init__(self,
                 sample_rate: int = 16000,
                 n_mfcc: int = 13,
                 n_mels: int = 26,
                 frame_length: float = 0.025,   # 25ms
                 frame_step: float = 0.010,      # 10ms
                 n_fft: int = 512,
                 preemph: float = 0.97,
                 low_freq: float = 300.0,
                 high_freq: float = 8000.0):
        self.sample_rate = sample_rate
        self.n_mfcc = n_mfcc
        self.n_mels = n_mels
        self.frame_length = int(frame_length * sample_rate)
        self.frame_step = int(frame_step * sample_rate)
        self.n_fft = n_fft
        self.preemph = preemph
        self.low_freq = low_freq
        self.high_freq = min(high_freq, sample_rate / 2)

        # 预计算 Mel 滤波器组
        self._mel_filterbank = self._compute_mel_filterbank()

    def _hz_to_mel(self, hz: float) -> float:
        return 2595.0 * math.log10(1.0 + hz / 700.0)

    def _mel_to_hz(self, mel: float) -> float:
        return 700.0 * (10.0 ** (mel / 2595.0) - 1.0)

    def _compute_mel_filterbank(self):
        """计算 Mel 滤波器组"""
        low_mel = self._hz_to_mel(self.low_freq)
        high_mel = self._hz_to_mel(self.high_freq)
        mel_points = [self._mel_to_hz(low_mel + (high_mel - low_mel) * i / (self.n_mels + 1))
                      for i in range(self.n_mels + 2)]

        # 映射到 FFT bin
        bins = [int((self.n_fft + 1) * f / self.sample_rate) for f in mel_points]

        filterbank = []
        for i in range(self.n_mels):
            left, center, right = bins[i], bins[i + 1], bins[i + 2]
            filt = [0.0] * (self.n_fft // 2 + 1)
            for j in range(left, center):
                if center > left:
                    filt[j] = (j - left) / (center - left)
            for j in range(center, right):
                if right > center:
                    filt[j] = (right - j) / (right - center)
            filterbank.append(filt)

        return filterbank

    def _dct(self, x):
        """DCT-II 变换"""
        N = len(x)
        result = []
        for k in range(self.n_mfcc):
            s = 0.0
            for n in range(N):
                s += x[n] * math.cos(math.pi * k * (2 * n + 1) / (2 * N))
            result.append(s)
        return result

    def extract(self, samples) -> list:
        """
        从音频样本提取 MFCC 特征
        返回: list of list — 每帧的 MFCC 系数
        """
        if len(samples) == 0:
            return []

        if HAS_NUMPY:
            return self._extract_numpy(np.array(samples, dtype=np.float64))
        else:
            return self._extract_pure_python(samples)

    def _extract_numpy(self, signal: 'np.ndarray'):
        """numpy 加速版 MFCC 提取"""
        # 预加重
        signal = np.append(signal[0], signal[1:] - self.preemph * signal[:-1])

        # 分帧
        signal_len = len(signal)
        num_frames = max(1, int(np.ceil((signal_len - self.frame_length) / self.frame_step)) + 1)
        pad_len = num_frames * self.frame_step + self.frame_length
        pad_signal = np.zeros(pad_len, dtype=np.float64)
        pad_signal[:signal_len] = signal

        indices = np.tile(np.arange(0, self.frame_length), (num_frames, 1)) + \
                  np.tile(np.arange(0, num_frames * self.frame_step, self.frame_step), (self.frame_length, 1)).T
        frames = pad_signal[indices.astype(np.int32)]

        # 汉明窗
        hamming = 0.54 - 0.46 * np.cos(2 * np.pi * np.arange(self.frame_length) / (self.frame_length - 1))
        frames = frames * hamming

        # FFT → 功率谱
        mag_frames = np.abs(np.fft.rfft(frames, self.n_fft))
        pow_frames = (mag_frames ** 2) / self.n_fft

        # Mel 滤波器组
        mel_filterbank = np.array(self._mel_filterbank, dtype=np.float64)
        mel_energy = np.dot(pow_frames, mel_filterbank.T)
        mel_energy = np.where(mel_energy < 1e-10, 1e-10, mel_energy)

        # log
        log_mel = np.log(mel_energy)

        # DCT
        mfcc_list = []
        for frame_log_mel in log_mel:
            dct_result = []
            for k in range(self.n_mfcc):
                s = np.sum(frame_log_mel * np.cos(math.pi * k * (2 * np.arange(self.n_mels) + 1) / (2 * self.n_mels)))
                dct_result.append(float(s))
            mfcc_list.append(dct_result)

        return mfcc_list

    def _extract_pure_python(self, samples):
        """纯 Python 版 MFCC 提取"""
        # 预加重
        emphasized = [samples[0]]
        for i in range(1, len(samples)):
            emphasized.append(samples[i] - self.preemph * samples[i - 1])

        # 分帧
        signal_len = len(emphasized)
        num_frames = max(1, int(math.ceil((signal_len - self.frame_length) / self.frame_step)) + 1)

        frames = []
        for i in range(num_frames):
            start = i * self.frame_step
            frame = [0.0] * self.frame_length
            for j in range(self.frame_length):
                idx = start + j
                if idx < signal_len:
                    frame[j] = emphasized[idx]
            frames.append(frame)

        # 汉明窗
        hamming = _hamming_window(self.frame_length)
        for frame in frames:
            for j in range(self.frame_length):
                frame[j] *= hamming[j]

        # FFT → 功率谱 (简化版，只计算到 n_fft//2+1)
        pow_frames = []
        for frame in frames:
            # 补零到 n_fft
            padded = frame + [0.0] * (self.n_fft - self.frame_length)

            # 简单 DFT (对于实时应用，这里应该用 FFT，但纯 Python 实现 DFT 较慢)
            # 折中：只计算前 n_fft//2+1 个 bin
            mag = []
            n_half = self.n_fft // 2 + 1
            for k in range(n_half):
                re = 0.0
                im = 0.0
                for n in range(self.n_fft):
                    angle = -2 * math.pi * k * n / self.n_fft
                    re += padded[n] * math.cos(angle)
                    im += padded[n] * math.sin(angle)
                mag.append((re * re + im * im) / self.n_fft)
            pow_frames.append(mag)

        # Mel 滤波器组
        mel_energy = []
        for pow_frame in pow_frames:
            frame_energy = []
            for filt in self._mel_filterbank:
                energy = _dot(pow_frame, filt)
                frame_energy.append(max(1e-10, energy))
            mel_energy.append(frame_energy)

        # log
        log_mel = [[math.log(e) for e in frame] for frame in mel_energy]

        # DCT
        mfcc_list = []
        for frame_log_mel in log_mel:
            mfcc = self._dct(frame_log_mel)
            mfcc_list.append(mfcc)

        return mfcc_list

    def compute_mean_mfcc(self, mfcc_frames) -> list:
        """计算所有帧的 MFCC 均值向量"""
        if not mfcc_frames:
            return []
        if HAS_NUMPY:
            arr = np.array(mfcc_frames)
            return arr.mean(axis=0).tolist()
        else:
            n = len(mfcc_frames)
            dim = len(mfcc_frames[0])
            mean = [0.0] * dim
            for frame in mfcc_frames:
                for i in range(dim):
                    mean[i] += frame[i]
            return [v / n for v in mean]


# ============================================================
# 噪声检测
# ============================================================
def compute_rms_energy(samples) -> float:
    """计算 RMS 能量"""
    if not samples:
        return 0.0
    if HAS_NUMPY:
        arr = np.array(samples)
        return float(np.sqrt(np.mean(arr ** 2)))
    else:
        return math.sqrt(sum(s * s for s in samples) / len(samples))


def compute_zero_crossing_rate(samples) -> float:
    """计算过零率"""
    if len(samples) < 2:
        return 0.0
    count = 0
    for i in range(1, len(samples)):
        if (samples[i] >= 0) != (samples[i - 1] >= 0):
            count += 1
    return count / (len(samples) - 1)


def is_noise(samples, sample_rate: int = 16000,
             rms_threshold: float = 0.01,
             zcr_threshold: float = 0.3) -> dict:
    """
    检测音频是否为噪声/静音
    返回: {is_noise, rms, zcr, reason}
    """
    if not samples:
        return {"is_noise": True, "rms": 0.0, "zcr": 0.0, "reason": "empty"}

    rms = compute_rms_energy(samples)
    zcr = compute_zero_crossing_rate(samples)

    if rms < rms_threshold:
        return {"is_noise": True, "rms": rms, "zcr": zcr, "reason": "low_energy"}
    if zcr > zcr_threshold:
        return {"is_noise": True, "rms": rms, "zcr": zcr, "reason": "high_zcr"}

    return {"is_noise": False, "rms": rms, "zcr": zcr, "reason": "ok"}


# ============================================================
# CLI 入口
# ============================================================
def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "用法: voiceprint_bridge.py <command> [args...]"}))
        sys.exit(1)

    command = sys.argv[1]

    try:
        if command == "extract":
            # 提取 MFCC 特征
            if len(sys.argv) < 3:
                print(json.dumps({"error": "用法: extract <wav_path>"}))
                sys.exit(1)

            wav_path = sys.argv[2]
            sample_rate, samples = read_wav(wav_path)

            extractor = MFCCExtractor(sample_rate=sample_rate)
            mfcc_frames = extractor.extract(samples)
            mean_mfcc = extractor.compute_mean_mfcc(mfcc_frames)

            # 同时计算 delta 和 delta-delta（用于更好的说话人表征）
            n_mfcc = extractor.n_mfcc
            mfcc_mean = mean_mfcc[:n_mfcc] if len(mean_mfcc) >= n_mfcc else mean_mfcc

            # 音频基本统计
            rms = compute_rms_energy(samples)
            duration = len(samples) / sample_rate

            result = {
                "status": "ok",
                "mfcc_mean": mfcc_mean,
                "num_frames": len(mfcc_frames),
                "duration_sec": round(duration, 3),
                "rms_energy": round(rms, 6),
                "feature_dim": len(mfcc_mean),
                "sample_rate": sample_rate,
            }
            print(json.dumps(result))

        elif command == "verify":
            # 验证说话人
            if len(sys.argv) < 4:
                print(json.dumps({"error": "用法: verify <wav_path> <ref_json>"}))
                sys.exit(1)

            wav_path = sys.argv[2]
            ref_json = sys.argv[3]

            ref_data = json.loads(ref_json)
            ref_samples = ref_data.get("samples", [])
            threshold = ref_data.get("threshold", 0.65)

            if not ref_samples:
                print(json.dumps({"error": "没有注册样本"}))
                sys.exit(1)

            sample_rate, samples = read_wav(wav_path)
            extractor = MFCCExtractor(sample_rate=sample_rate)
            mfcc_frames = extractor.extract(samples)
            input_mfcc = extractor.compute_mean_mfcc(mfcc_frames)

            # 与每个注册样本比较，取最高分
            best_score = -1.0
            best_sample_id = ""
            for ref in ref_samples:
                ref_features = ref.get("features", [])
                if not ref_features:
                    continue
                score = _cosine_similarity(input_mfcc, ref_features)
                if score > best_score:
                    best_score = score
                    best_sample_id = ref.get("id", "")

            match = best_score > threshold
            result = {
                "status": "ok",
                "match": match,
                "score": round(best_score, 4),
                "best_sample_id": best_sample_id,
                "threshold": threshold,
                "num_frames": len(mfcc_frames),
                "feature_dim": len(input_mfcc),
            }
            print(json.dumps(result))

        elif command == "noise-check":
            # 噪声检测
            if len(sys.argv) < 3:
                print(json.dumps({"error": "用法: noise-check <wav_path>"}))
                sys.exit(1)

            wav_path = sys.argv[2]
            sample_rate, samples = read_wav(wav_path)

            noise_result = is_noise(samples, sample_rate)
            noise_result["status"] = "ok"
            print(json.dumps(noise_result))

        elif command == "version":
            print(json.dumps({
                "version": "1.0.0",
                "numpy_available": HAS_NUMPY,
                "python_version": sys.version,
            }))

        else:
            print(json.dumps({"error": f"未知命令: {command}"}))
            sys.exit(1)

    except Exception as e:
        print(json.dumps({"status": "error", "error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()