#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
vits_tts_bridge.py —— 玄枢内嵌高质量 TTS 桥接（sherpa-onnx VITS/Melo 中文）

选型：sherpa-onnx vits-melo-tts-zh_en（VITS 系中文，CPU 秒级离线合成）。
模型权重位于 resources/voice-models/vits-melo-tts-zh_en/。

用法：
  python vits_tts_bridge.py --text "要合成的文本" --out out.wav \
      [--speed 1.0] [--model-dir <模型目录>] [--sid 0]

返回：成功合成 wav，stdout 打印 {"ok": true, "path": "..."}；失败打印 {"ok": false, "error": "..."}
"""

import argparse
import json
import os
import sys


def main() -> int:
    parser = argparse.ArgumentParser(description="sherpa-onnx VITS TTS bridge")
    parser.add_argument("--text", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--speed", type=float, default=1.0)
    parser.add_argument("--sid", type=int, default=0)
    parser.add_argument("--model-dir", required=True)
    args = parser.parse_args()

    text = args.text.strip()
    if not text:
        print(json.dumps({"ok": False, "error": "text 为空"}, ensure_ascii=False))
        return 1

    model_dir = args.model_dir
    if not os.path.isdir(model_dir):
        print(json.dumps({"ok": False, "error": f"模型目录不存在: {model_dir}"}, ensure_ascii=False))
        return 1

    model_path = os.path.join(model_dir, "model.onnx")
    tokens_path = os.path.join(model_dir, "tokens.txt")
    lexicon_path = os.path.join(model_dir, "lexicon.txt")
    for p in (model_path, tokens_path, lexicon_path):
        if not os.path.exists(p):
            print(json.dumps({"ok": False, "error": f"模型文件缺失: {p}"}, ensure_ascii=False))
            return 1

    try:
        import sherpa_onnx

        tts_config = sherpa_onnx.OfflineTtsConfig(
            model=sherpa_onnx.OfflineTtsModelConfig(
                vits=sherpa_onnx.OfflineTtsVitsModelConfig(
                    model=model_path,
                    tokens=tokens_path,
                    lexicon=lexicon_path,
                    dict_dir=os.path.join(model_dir, "dict"),
                ),
                num_threads=2,
                debug=0,
                provider="cpu",
            ),
            rule_fsts=os.path.join(model_dir, "phone.fst") + "," + os.path.join(model_dir, "date.fst") + "," + os.path.join(model_dir, "number.fst"),
            max_num_sentences=2,
        )
        tts = sherpa_onnx.OfflineTts(tts_config)

        audio = tts.generate(text, sid=args.sid, speed=args.speed)
        if audio is None or audio.samples is None:
            print(json.dumps({"ok": False, "error": "合成返回空音频"}, ensure_ascii=False))
            return 1

        out_path = args.out
        os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
        import soundfile as sf
        sf.write(out_path, audio.samples, samplerate=audio.sample_rate)

        if os.path.exists(out_path) and os.path.getsize(out_path) > 0:
            print(json.dumps({"ok": True, "path": out_path, "sample_rate": audio.sample_rate}, ensure_ascii=False))
            return 0
        print(json.dumps({"ok": False, "error": "合成完成但未产出音频文件"}, ensure_ascii=False))
        return 1
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    sys.exit(main())
