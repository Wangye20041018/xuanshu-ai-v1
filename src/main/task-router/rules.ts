/**
 * task-router 规则/关键词启发分类器（v11.0，单模型常驻）
 *
 * 设计原则：
 * - 零显存：纯规则匹配，不加载任何模型。
 * - 优先级：图片 > 代码扩展名/代码关键词 > 数学 > 长文 > 质量关键词 > 语音球闲聊 > 普通闲聊。
 * - 命中即返回，避免误判（口语化词汇不参与质量判定）。
 *
 * v11.0 变更：QUALITY_KEYWORDS 保留但仅用于日志标记，不再触发模型档位切换。
 */

import { IntentClass, RouteSignal } from './signals'

/** 代码文件扩展名 → 命中即判 quality(代码) */
const CODE_EXT = [
  'js', 'ts', 'tsx', 'jsx', 'py', 'java', 'go', 'rs', 'c', 'cpp', 'cc', 'h',
  'cs', 'php', 'rb', 'kt', 'swift', 'sql', 'sh', 'bash', 'ps1', 'html', 'htm',
  'css', 'scss', 'vue', 'svelte', 'json', 'yaml', 'yml', 'toml', 'lua', 'r',
]

/** 代码语义关键词（出现在文本中时判 code） */
const CODE_HINT = /\b(function|def |class |import |const |let |var |public |private |async |await |return|代码|函数|类|接口|编译|报错|bug|debug|exception|stack ?trace|syntax)\b/i

/** 数学关键词 */
const MATH_KEYWORDS = [
  '方程', '积分', '微分', '导数', '矩阵', '概率', '统计', '极限', '几何', '代数',
  '数列', '微积分', '线性方程组', '求导', '不等式', 'math', 'integral', 'derivative',
  'matrix', 'probability', 'equation', 'calculus', 'theorem',
]

/** v11.0：质量档通用触发词（保留仅用于意图分类日志，不再触发模型切换） */
const QUALITY_KEYWORDS = [
  '推导', '推理', '证明', '复杂', '长篇', '论文', '架构', '优化', '调试', '深度',
  '分析', '复盘', '总结', '方案', '设计', '算法', '重构', 'refactor', 'optimize',
  'analyze', 'complex', 'reasoning', 'prove', 'derive', 'architecture', 'in-depth',
  '对比', '评测', '报告', '研究',
]

/**
 * 根据信号分类意图
 */
export function classifyIntent(signal: RouteSignal): IntentClass {
  // 1) 图片/截图 → 视觉（方案X：不换载，VL-7B 直接处理）
  if (signal.hasImage) return 'image'

  const text = (signal.text || signal.audioText || '').toLowerCase()

  // 2) 语音球触发窗口 → 语音闲聊（除非文本命中质量/代码关键词，交由后续判断）
  const fromVoiceBall = signal.triggerWindow === 'voice-ball'

  // 3) 上传代码文件 → code
  if (signal.fileType) {
    const ext = signal.fileType.split('.').pop()?.toLowerCase() || ''
    if (CODE_EXT.includes(ext)) return 'code'
  }

  // 4) 代码语义 → code
  if (CODE_HINT.test(signal.text || '')) return 'code'

  // 5) 数学 → math
  if (MATH_KEYWORDS.some((k) => text.includes(k.toLowerCase()))) return 'math'

  // 6) 长文档（>1200 字）→ longdoc
  if ((signal.text || '').length > 1200) return 'longdoc'

  // 7) 质量关键词 → reasoning
  if (QUALITY_KEYWORDS.some((k) => text.includes(k.toLowerCase()))) return 'reasoning'

  // 8) 语音球且未命中上述 → 语音闲聊
  if (fromVoiceBall) return 'voice'

  return 'chat'
}
