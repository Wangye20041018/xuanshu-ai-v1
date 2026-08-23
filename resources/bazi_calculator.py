#!/usr/bin/env python3
"""
八字命盘计算器 — 四柱八字排盘与十神大运解读
使用 lunar-python 库进行精确计算。
支持命令行和 JSON 输出两种模式。

用法：
  python bazi_calculator.py 1990-06-15 12 male        # 命令行模式
  python bazi_calculator.py --json 1990-06-15 12 male  # JSON 模式
"""

import sys
import json
from datetime import datetime

try:
    from lunar_python import Solar, Lunar
except ImportError:
    print("错误: 需要安装 lunar-python。请执行: pip install lunar-python", file=sys.stderr)
    sys.exit(1)

# 天干地支常量
TIAN_GAN = ["甲", "乙", "丙", "丁", "戊", "己", "庚", "辛", "壬", "癸"]
DI_ZHI = ["子", "丑", "寅", "卯", "辰", "巳", "午", "未", "申", "酉", "戌", "亥"]
WU_XING = {
    "甲": "木", "乙": "木", "丙": "火", "丁": "火", "戊": "土",
    "己": "土", "庚": "金", "辛": "金", "壬": "水", "癸": "水"
}
WU_XING_DZ = {
    "子": "水", "丑": "土", "寅": "木", "卯": "木", "辰": "土", "巳": "火",
    "午": "火", "未": "土", "申": "金", "酉": "金", "戌": "土", "亥": "水"
}
SHI_SHEN = {
    "甲": {"甲": "比肩", "乙": "劫财", "丙": "食神", "丁": "伤官", "戊": "偏财", "己": "正财", "庚": "七杀", "辛": "正官", "壬": "偏印", "癸": "正印"},
    "乙": {"甲": "劫财", "乙": "比肩", "丙": "伤官", "丁": "食神", "戊": "正财", "己": "偏财", "庚": "正官", "辛": "七杀", "壬": "正印", "癸": "偏印"},
    "丙": {"甲": "偏印", "乙": "正印", "丙": "比肩", "丁": "劫财", "戊": "食神", "己": "伤官", "庚": "偏财", "辛": "正财", "壬": "七杀", "癸": "正官"},
    "丁": {"甲": "正印", "乙": "偏印", "丙": "劫财", "丁": "比肩", "戊": "伤官", "己": "食神", "庚": "正财", "辛": "偏财", "壬": "正官", "癸": "七杀"},
    "戊": {"甲": "七杀", "乙": "正官", "丙": "偏印", "丁": "正印", "戊": "比肩", "己": "劫财", "庚": "食神", "辛": "伤官", "壬": "偏财", "癸": "正财"},
    "己": {"甲": "正官", "乙": "七杀", "丙": "正印", "丁": "偏印", "戊": "劫财", "己": "比肩", "庚": "伤官", "辛": "食神", "壬": "正财", "癸": "偏财"},
    "庚": {"甲": "偏财", "乙": "正财", "丙": "七杀", "丁": "正官", "戊": "偏印", "己": "正印", "庚": "比肩", "辛": "劫财", "壬": "食神", "癸": "伤官"},
    "辛": {"甲": "正财", "乙": "偏财", "丙": "正官", "丁": "七杀", "戊": "正印", "己": "偏印", "庚": "劫财", "辛": "比肩", "壬": "伤官", "癸": "食神"},
    "壬": {"甲": "食神", "乙": "伤官", "丙": "偏财", "丁": "正财", "戊": "七杀", "己": "正官", "庚": "偏印", "辛": "正印", "壬": "比肩", "癸": "劫财"},
    "癸": {"甲": "伤官", "乙": "食神", "丙": "正财", "丁": "偏财", "戊": "正官", "己": "七杀", "庚": "正印", "辛": "偏印", "壬": "劫财", "癸": "比肩"},
}


def calculate_bazi(date_str: str, hour: int, gender: str) -> dict:
    """
    计算八字排盘。

    参数:
        date_str: 公历日期字符串，格式 "YYYY-MM-DD"
        hour: 时辰 (0-23)
        gender: 性别 "male" 或 "female"

    返回:
        包含四柱、五行、十神、大运的字典
    """
    dt = datetime.strptime(date_str, "%Y-%m-%d")
    y, m, d = dt.year, dt.month, dt.day

    # 使用 lunar_python 获取农历信息
    solar = Solar.fromYmd(y, m, d)
    lunar: Lunar = solar.getLunar()

    # 年柱（以立春为界）
    # lunar_python 中 getYearInGanZhi() 已按立春分界
    year_ganzhi = lunar.getYearInGanZhi()  # 如 "甲子"
    nian_gan = year_ganzhi[0]
    nian_zhi = year_ganzhi[1]

    # 月柱（以节气分界）
    month_ganzhi = lunar.getMonthInGanZhi()
    yue_gan = month_ganzhi[0]
    yue_zhi = month_ganzhi[1]

    # 日柱
    day_ganzhi = lunar.getDayInGanZhi()
    ri_gan = day_ganzhi[0]
    ri_zhi = day_ganzhi[1]

    # 时柱 — 按时辰排定
    # 农历时辰：子时 23-1, 丑时 1-3, ...
    lunar_hour = lunar.getTimeGanZhi() if hasattr(lunar, 'getTimeGanZhi') else None
    if lunar_hour:
        shi_gan = lunar_hour[0]
        shi_zhi = lunar_hour[1]
    else:
        # 手动计算时柱
        # 时支：地球时辰
        shi_zhi_idx = (hour + 1) // 2 % 12
        shi_zhi = DI_ZHI[shi_zhi_idx]
        # 时干 = (日干索引 % 5) * 2 + 时支索引
        ri_gan_idx = TIAN_GAN.index(ri_gan)
        shi_gan_idx = (ri_gan_idx % 5) * 2 + shi_zhi_idx
        shi_gan_idx = shi_gan_idx % 10
        shi_gan = TIAN_GAN[shi_gan_idx]

    nian_gan_idx = TIAN_GAN.index(nian_gan)
    nian_zhi_idx = DI_ZHI.index(nian_zhi)
    yue_gan_idx = TIAN_GAN.index(yue_gan)
    yue_zhi_idx = DI_ZHI.index(yue_zhi)
    ri_gan_idx = TIAN_GAN.index(ri_gan)
    ri_zhi_idx = DI_ZHI.index(ri_zhi)
    shi_gan_idx = TIAN_GAN.index(shi_gan)
    shi_zhi_idx = DI_ZHI.index(shi_zhi)

    # 日主
    day_master = ri_gan
    day_wx = WU_XING[day_master]

    # 十神
    ss_map = SHI_SHEN[day_master]

    # 大运
    # 阳年（甲丙戊庚壬）= 阳年，阴年（乙丁己辛癸）= 阴年
    is_yang_year = nian_gan_idx % 2 == 0  # 甲=0, 丙=2... 均为偶数
    is_male = gender == "male"
    shun_pai = (is_yang_year and is_male) or (not is_yang_year and not is_male)

    # 起运年龄（简化：基于日柱到下一个/上一个节气天数 / 3）
    # lunar_python 提供了精准计算
    try:
        # 获取起运信息
        yun_info = lunar.getTimeYun() if hasattr(lunar, 'getTimeYun') else None
        if yun_info:
            qi_yun_age = yun_info.get('startYear', 8)
            if shun_pai:
                da_yun_start = (yue_gan_idx + 1) % 10, (yue_zhi_idx + 1) % 12
            else:
                da_yun_start = ((yue_gan_idx - 1) % 10 + 10) % 10, ((yue_zhi_idx - 1) % 12 + 12) % 12
        else:
            qi_yun_age = abs(ri_gan_idx % 10) + 1
            if shun_pai:
                da_yun_start = ((yue_gan_idx + 1) % 10), ((yue_zhi_idx + 1) % 12)
            else:
                da_yun_start = (((yue_gan_idx - 1) % 10 + 10) % 10), (((yue_zhi_idx - 1) % 12 + 12) % 12)
    except Exception:
        qi_yun_age = abs(ri_gan_idx % 10) + 1
        if shun_pai:
            da_yun_start = ((yue_gan_idx + 1) % 10), ((yue_zhi_idx + 1) % 12)
        else:
            da_yun_start = (((yue_gan_idx - 1) % 10 + 10) % 10), (((yue_zhi_idx - 1) % 12 + 12) % 12)

    # 构建大运列表（8个十年大运）
    dayun_gan_idx, dayun_zhi_idx = da_yun_start
    dayun_list = []
    for i in range(8):
        age_start = qi_yun_age + i * 10
        dayun_list.append({
            "age": age_start,
            "gan": TIAN_GAN[dayun_gan_idx],
            "zhi": DI_ZHI[dayun_zhi_idx],
            "tenYear": f"{age_start}-{age_start+9}岁"
        })
        if shun_pai:
            dayun_gan_idx = (dayun_gan_idx + 1) % 10
            dayun_zhi_idx = (dayun_zhi_idx + 1) % 12
        else:
            dayun_gan_idx = ((dayun_gan_idx - 1) % 10 + 10) % 10
            dayun_zhi_idx = ((dayun_zhi_idx - 1) % 12 + 12) % 12

    return {
        "input": {"date": date_str, "hour": hour, "gender": gender},
        "nian": {"gan": nian_gan, "zhi": nian_zhi, "ganIdx": nian_gan_idx, "zhiIdx": nian_zhi_idx},
        "yue": {"gan": yue_gan, "zhi": yue_zhi, "ganIdx": yue_gan_idx, "zhiIdx": yue_zhi_idx},
        "ri": {"gan": ri_gan, "zhi": ri_zhi, "ganIdx": ri_gan_idx, "zhiIdx": ri_zhi_idx},
        "shi": {"gan": shi_gan, "zhi": shi_zhi, "ganIdx": shi_gan_idx, "zhiIdx": shi_zhi_idx},
        "dayMaster": day_master,
        "dayMasterWuXing": day_wx,
        "wuXing": {
            "nian": WU_XING[nian_gan],
            "yue": WU_XING[yue_gan],
            "ri": day_wx,
            "shi": WU_XING[shi_gan]
        },
        "shiShen": {
            "nian": ss_map[nian_gan],
            "yue": ss_map[yue_gan],
            "ri": "日主",
            "shi": ss_map[shi_gan]
        },
        "paiType": "顺排" if shun_pai else "逆排",
        "qiYunAge": qi_yun_age,
        "daYun": dayun_list,
        "isYangYear": is_yang_year,
        "shunPai": shun_pai
    }


def format_output(data: dict) -> str:
    """格式化八字排盘结果"""
    n, y, r, s = data["nian"], data["yue"], data["ri"], data["shi"]
    inp = data["input"]

    lines = []
    lines.append("=" * 60)
    lines.append(f"八字命盘 · {inp['date']} · {['男', '女'][0 if inp['gender']=='male' else 1]}")
    lines.append("=" * 60)
    lines.append("")
    lines.append(f"{'':>6} {'年柱':>8} {'月柱':>8} {'日柱':>8} {'时柱':>8}")
    lines.append(f"{'天干':>6} {n['gan']:>8} {y['gan']:>8} {r['gan']:>8} {s['gan']:>8}")
    lines.append(f"{'地支':>6} {n['zhi']:>8} {y['zhi']:>8} {r['zhi']:>8} {s['zhi']:>8}")
    lines.append(f"{'五行':>6} {data['wuXing']['nian']:>8} {data['wuXing']['yue']:>8} {data['wuXing']['ri']:>8} {data['wuXing']['shi']:>8}")
    lines.append(f"{'十神':>6} {data['shiShen']['nian']:>8} {data['shiShen']['yue']:>8} {'日主':>8} {data['shiShen']['shi']:>8}")
    lines.append("")
    lines.append(f"日主: {data['dayMaster']}（{data['dayMasterWuXing']}）")
    lines.append(f"排法: {data['paiType']} · 起运 {data['qiYunAge']} 岁")
    lines.append("")
    lines.append("大运:")
    for dy in data["daYun"]:
        lines.append(f"  {dy['tenYear']:>12}  →  {dy['gan']}{dy['zhi']}")
    lines.append("")
    lines.append("=" * 60)
    lines.append("排盘仅供参考，不构成命理建议")
    lines.append("=" * 60)
    return "\n".join(lines)


def main():
    json_mode = "--json" in sys.argv

    # 过滤出非 flag 参数
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if len(args) < 2:
        print("用法: python bazi_calculator.py [--json] <日期YYYY-MM-DD> <时辰(0-23)> <性别(male/female)>")
        print("示例: python bazi_calculator.py 1990-06-15 12 male")
        print("示例: python bazi_calculator.py --json 1990-06-15 12 male")
        sys.exit(1)

    date_str = args[0]
    hour = int(args[1])
    gender = args[2].lower() if len(args) > 2 else "male"

    result = calculate_bazi(date_str, hour, gender)

    if json_mode:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(format_output(result))


if __name__ == "__main__":
    main()
