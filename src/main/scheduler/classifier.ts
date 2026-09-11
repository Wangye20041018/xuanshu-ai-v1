/**
 * 智能模型调度系统 — 任务类型识别
 *
 * 识别依据（真实可靠，非拍脑袋）：
 * 1. 关键词：代码/数学/推理/文档等领域的强特征词
 * 2. 结构特征：代码块标记、文件扩展名、公式语法、URL
 * 3. 长度：长文本（>1200 字符）倾向长上下文/深度任务
 * 4. 语义：问句形式、指令式动词、复杂度词
 *
 * 每个类型给出置信度与命中证据，供 UI 展示"为什么这么判定"。
 *
 * @module scheduler/classifier
 */

import type { SchedulerTaskType, TaskClassifyResult } from './types'

/** 代码领域强特征关键词（命中即 lock 为 code） */
const CODE_KEYWORDS = [
  '代码', '编程', '函数', '算法', 'bug', 'debug', '调试', '重构', 'class ',
  'def ', 'function', 'var ', 'const ', 'let ', 'import ', 'return ',
  'react', 'vue', 'typescript', 'javascript', 'python', 'java', 'c++',
  'golang', 'sql', '数据库', '前端', '后端', '接口', 'api', '报错', '错误信息',
  'git', 'commit', 'pr ', 'issue', 'syntax', '编译', '运行报错', '堆栈',
  '正则', 'regex', '命令行', 'shell', '脚本', '自动化', '测试用例',
  '性能优化', '内存泄漏', '并发', '线程', '异步', 'promise', '回调',
]

/** 深度推理强特征关键词（命中即 lock 为 deep） */
const DEEP_KEYWORDS = [
  '为什么', '原理', '本质', '推导', '证明', '论证', '分析', '深入',
  '逻辑', '因果', '权衡', '利弊', '优缺点', '对比', '区别', '差异',
  '哲学', '经济', '物理', '数学', '量子', '相对论', '社会学', '心理学',
  '批判', '评价', '总结', '归纳', '预测', '展望', '趋势', '策略',
  '深度思考', '仔细想想', '理性', '客观', '辩证', '推理题', '脑筋急转弯',
]

/** 数学强特征关键词 */
const MATH_KEYWORDS = [
  '方程', '导数', '积分', '矩阵', '向量', '概率', '统计', '微积分',
  '线性代数', '几何', '三角函数', '对数', '极限', '级数', '证明', '公式推导',
]

/** 长上下文/文档分析关键词 */
const LONGCTX_KEYWORDS = [
  '文档', '文章', '论文', '报告', '合同', '长文', '摘要', '总结',
  '阅读', '理解', '分析这段', '分析以下', '这段文字', '翻译', '润色',
  '改写', '整理', '提炼', '要点', '大纲', '目录', '章节', '上下文',
]

/** 快捷问答特征词（短、直接、单点事实型） */
const QUICK_KEYWORDS = [
  '是什么', '什么意思', '多少', '几', '几号', '几点', '哪里', '谁',
  '哪个', '怎么用', '怎么做', '步骤', '今天', '明天', '日期', '天气',
  '你好', 'hi', 'hello', '在吗', '谢谢', '再见', 'yes', 'no', 'ok',
  '推荐', '介绍', '简述', '简单说', '概括一下',
]

/** 代码结构特征：代码块标记或常见文件扩展名 */
const CODE_BLOCK_RE = /```[a-zA-Z]*\n[\s\S]*\n```|(?:[\w-]+\.(?:ts|tsx|js|jsx|py|java|c|cpp|cs|go|rs|php|rb|sql|sh|html|css|json|yaml|yml|vue|kt|swift))/
const MATH_FORMULA_RE = /[∫∑∏√±×÷≤≥∞∂∇π]|\\frac|\\sum|\\int|\\sqrt|\^\{|_\{|\$\$/

/** 问句检测：以疑问词/问号结尾 */
const QUESTION_RE = /(?:^|[\s。，,！!？?])(什么|怎么|为什么|如何|怎样|可否|能否|是不是|有没有|多少|哪)\b/
const QUESTION_END_RE = /[?？]\s*$/

/** 复杂度/深度副词 */
const DEPTH_ADVERBS = ['深入', '详细', '全面', '彻底', '严谨', '专业', '复杂', '难度', '挑战']

/** 长度阈值 */
const LONG_THRESHOLD = 1200
const VERY_LONG_THRESHOLD = 4000

function score(text: string, keywords: string[]): { score: number; hits: string[] } {
  let s = 0
  const hits: string[] = []
  const lower = text.toLowerCase()
  for (const kw of keywords) {
    if (lower.includes(kw.toLowerCase())) {
      s += 1
      if (hits.length < 6) hits.push(kw)
    }
  }
  return { score: s, hits }
}

/**
 * 任务类型识别主入口
 * 返回：taskType + 置信度 + 证据列表（供 UI 透明展示）
 */
export function classifyTask(text: string): TaskClassifyResult {
  const t = (text || '').trim()
  const len = t.length
  const evidence: string[] = []
  let locked = false
  let taskType: SchedulerTaskType = 'chat'

  // ---- 1. 结构特征（最强证据）----
  if (CODE_BLOCK_RE.test(t)) {
    evidence.push('检测到代码块/文件扩展名')
    locked = true
    return { taskType: 'code', confidence: 0.98, evidence, locked }
  }
  if (MATH_FORMULA_RE.test(t)) {
    evidence.push('检测到数学公式语法')
    locked = true
    return { taskType: 'deep', confidence: 0.95, evidence, locked }
  }

  // ---- 2. 关键词打分 ----
  const code = score(t, CODE_KEYWORDS)
  const deep = score(t, DEEP_KEYWORDS)
  const math = score(t, MATH_KEYWORDS)
  const longctx = score(t, LONGCTX_KEYWORDS)
  const quick = score(t, QUICK_KEYWORDS)

  // 代码强命中 → 直接锁定
  if (code.score >= 2) {
    evidence.push(`命中代码关键词: ${code.hits.slice(0, 3).join('、')}`)
    locked = true
    return { taskType: 'code', confidence: Math.min(0.98, 0.7 + code.score * 0.06), evidence, locked }
  }
  // 数学强命中 → 深度推理
  if (math.score >= 2) {
    evidence.push(`命中数学关键词: ${math.hits.slice(0, 3).join('、')}`)
    locked = true
    return { taskType: 'deep', confidence: 0.9, evidence, locked }
  }
  // 深度关键词强命中
  if (deep.score >= 3) {
    evidence.push(`命中深度推理关键词: ${deep.hits.slice(0, 3).join('、')}`)
    locked = true
    return { taskType: 'deep', confidence: Math.min(0.95, 0.6 + deep.score * 0.08), evidence, locked }
  }

  // ---- 3. 长度特征 ----
  if (len >= VERY_LONG_THRESHOLD) {
    evidence.push(`文本长度 ${len} 字符（超长文本，倾向长上下文）`)
    taskType = 'longctx'
    locked = true
    return { taskType, confidence: 0.88, evidence, locked }
  }
  if (len >= LONG_THRESHOLD) {
    evidence.push(`文本长度 ${len} 字符（>${LONG_THRESHOLD}，倾向长上下文/深度）`)
    taskType = longctx.score >= deep.score ? 'longctx' : 'deep'
  }

  // ---- 4. 问句形态 + 语义权重 ----
  const isQuestion = QUESTION_RE.test(t) || QUESTION_END_RE.test(t)
  const depthAdverb = DEPTH_ADVERBS.filter(w => t.includes(w))
  if (depthAdverb.length > 0) evidence.push(`检测到复杂度词: ${depthAdverb.slice(0, 3).join('、')}`)

  // 长文档关键词命中且非锁定时，加权
  if (longctx.score >= 2 && !locked) {
    evidence.push(`命中文档分析关键词: ${longctx.hits.slice(0, 3).join('、')}`)
    taskType = 'longctx'
  }

  // 快捷问答：短文本 + 疑问 + 无深度词；或极短文本 + 快捷词（问候/致谢/单点事实）
  const quickCue = !locked && quick.score > 0 && depthAdverb.length === 0
  const quickQuestion = quickCue && len <= 80 && isQuestion
  const quickTerse = quickCue && len <= 12
  if (quickQuestion || quickTerse) {
    evidence.push(`短文本(${len}字符)命中快捷词: ${quick.hits.slice(0, 2).join('、')}`)
    return { taskType: 'quick', confidence: 0.82, evidence, locked: false }
  }

  // ---- 5. 综合判定（未锁定时）----
  if (!locked) {
    if (taskType === 'chat') {
      // 深度词存在 → deep；长文本 + 疑问 → deep
      if (depthAdverb.length > 0) {
        evidence.push('语义含深入分析诉求')
        taskType = 'deep'
      } else if (len >= 200 && isQuestion) {
        evidence.push('较长且为提问，判为深度推理')
        taskType = 'deep'
      } else {
        evidence.push('无强特征，判为日常对话')
        taskType = 'chat'
      }
    }
  }

  // 置信度估算
  let conf = 0.6
  if (taskType === 'deep') conf = 0.62 + Math.min(0.2, depthAdverb.length * 0.05)
  if (taskType === 'longctx') conf = 0.68 + Math.min(0.15, len / 10000)
  if (taskType === 'chat') conf = 0.65

  return { taskType, confidence: Number(conf.toFixed(2)), evidence, locked }
}

/** 供 IPC 快速判定（无锁定时也返回完整证据） */
export function classifyWithEvidence(text: string): TaskClassifyResult {
  return classifyTask(text)
}
