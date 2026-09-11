#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
cosyvoice_bridge.py —— 玄枢内嵌高质量 TTS 桥接（施工单 §6.2）

选型：CosyVoice 2（阿里 FunAudioLLM），中文 CER 2.4 接近 ElevenLabs 商用级，
150ms 首包延迟，零样本克隆，对 6GB 显存友好。

用法：
  python cosyvoice_bridge.py --text "要合成的文本" --out out.wav \
      [--speed 1.0] [--pitch 1.0] [--model-dir <cosyvoice2权重目录>]

返回：
  正常合成输出 wav 文件，stdout 打印 {"ok": true, "path": "..."}
  失败时 stdout 打印 {"ok": false, "error": "..."}，退出码非 0。

模型权重获取（交付说明同步）：
  - ModelScope: https://www.modelscope.cn/models/iic/CosyVoice2-0.5B
  - HuggingFace: https://huggingface.co/FunAudioLLM/CosyVoice2-0.5B
  下载后放到 resources/voice-models/cosyvoice2/ 目录。
"""

import argparse
import json
import os
import sys


def main() -> int:
    parser = argparse.ArgumentParser(description="CosyVoice 2 TTS bridge")
    parser.add_argument("--text", required=True, help="要合成的文本")
    parser.add_argument("--out", required=True, help="输出 wav 路径")
    parser.add_argument("--speed", type=float, default=1.0)
    parser.add_argument("--pitch", type=float, default=1.0)
    parser.add_argument("--model-dir", required=True, help="CosyVoice2 权重目录")
    args = parser.parse_args()

    text = args.text.strip()
    if not text:
        print(json.dumps({"ok": False, "error": "text 为空"}, ensure_ascii=False))
        return 1

    model_dir = args.model_dir
    if not os.path.isdir(model_dir):
        print(json.dumps({"ok": False, "error": f"模型目录不存在: {model_dir}"}, ensure_ascii=False))
        return 1

    try:
        # 延迟导入：避免无依赖环境下 import 阶段崩溃影响主进程
        sys.path.insert(0, model_dir)
        try:
            from cosyvoice.cli.cosyvoice import CosyVoice2
            from cosyvoice.utils.file_utils import load_wav
        except ImportError as e:
            print(json.dumps({"ok": False, "error": f"CosyVoice 依赖未安装: {e}"}, ensure_ascii=False))
            return 1

        # 加载模型（使用默认 zero_shot 音色，中文自然女声）
        cosyvoice = CosyVoice2(model_dir, load_jit=False, load_trt=False, fp16=False)

        # 合成参考音频（内置 prompt 音色）→ 生成目标文本
        out_path = args.out
        os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)

        # 使用内置参考音色合成
        from cosyvoice.utils.file_utils import save_wav
        output = cosyvoice.inference_zero_shot(text, "", "", stream=False, speed=args.speed)
        # output 为 generator，逐段写文件
        import soundfile as sf  # noqa
        # CosyVoice 2 返回 dict(generator) 结构，此处按官方示例处理
        for chunk in output:
            save_wav(chunk, out_path, 22050)
            break

        if os.path.exists(out_path) and os.path.getsize(out_path) > 0:
            print(json.dumps({"ok": True, "path": out_path}, ensure_ascii=False))
            return 0
        print(json.dumps({"ok": False, "error": "合成完成但未产出音频文件"}, ensure_ascii=False))
        return 1
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    sys.exit(main())
