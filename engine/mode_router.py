"""
玄枢 AI Engine — Mode Router
=============================
7B VL (GPU) + 14B (CPU)  常驻投机解码，不再路由。

v3.1 起废除快速/深度双模切换，两个模型随 start.bat 启动即加载。
本模块保留为兼容性存根。
"""

from typing import List, Dict, Optional


class ModeRouter:
    """
    兼容性存根 — 始终返回投机解码模式。
    """

    def __init__(self):
        pass

    def route(
        self,
        messages: List[Dict],
        context: Optional[Dict] = None,
    ) -> str:
        """始终返回 'speculative'（7B+14B 投机解码）。"""
        return "speculative"

    def stats(self) -> Dict:
        return {"mode": "speculative", "description": "7B VL (GPU) + 14B (CPU) 常驻投机解码"}


def main():
    print("玄枢 v3.1 模式路由: 7B VL (GPU) + 14B (CPU) 常驻投机解码")
    print("快速/深度双模切换已废除。")


if __name__ == "__main__":
    main()
