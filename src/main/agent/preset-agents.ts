/**
 * preset-agents.ts — 预置智能体库（第三批：智能体阵列）
 *
 * 每个智能体 = 角色身份 + 技能描述 + 专属工具 + 记忆 + 协作协议。
 * 引用现有静态人设（resources/personas/*.json），落盘到 userData/agents/。
 * userData/agents 为空时自动种子（ensurePresetAgents），已存在则不动（尊重用户增删改）。
 *
 * @module main/agent/preset-agents
 */

import { app } from 'electron'
import fs from 'fs'
import path from 'path'
import { logger } from '../../shared/logger'
import type { AgentDefinition } from '../../shared/agent-types'
import { buildDefaultDefinition } from './agent-store'
import { AGENT_MANIFESTS } from './agent-manifests'

/** 通用只读/分析类工具（低风险，适合文档/分析角色） */
const COMMON_TOOLS = ['search_with_rag', 'analyze_task']
/** 操作类工具（测试/执行角色） */
const ACT_TOOLS = ['click_at', 'press_keys', 'take_screenshot', 'scroll_at', 'type_text']

export interface PresetAgentSpec {
  key: string
  name: string
  role: string
  personaId: string
  description: string
  skills: string[]
  collaboration: string
  toolIds: string[]
  tags: string[]
  icon?: string
  color?: string
}

export const PRESET_AGENTS: PresetAgentSpec[] = [
  {
    key: 'pm',
    name: '产品经理',
    role: '产品经理',
    personaId: 'product-manager',
    description: '梳理需求、明确目标用户与场景、输出 PRD 与验收标准',
    skills: ['需求分析', 'PRD 编写', '用户故事', '优先级排序'],
    collaboration: '团队起点：把用户目标翻译成可执行的需求说明，交付给架构师与各角色',
    toolIds: COMMON_TOOLS,
    tags: ['产品', '需求', 'PRD'],
    icon: '🧭',
    color: '#5B8DEF',
  },
  {
    key: 'architect',
    name: '架构师',
    role: '架构师',
    personaId: 'architect',
    description: '系统设计、技术选型、模块划分与接口定义',
    skills: ['技术架构', '模块设计', '接口定义', '技术选型'],
    collaboration: '接收产品需求后输出技术设计，供前后端并行实现',
    toolIds: [...COMMON_TOOLS, 'query_knowledge_graph'],
    tags: ['架构', '设计', '技术'],
    icon: '🏗️',
    color: '#7C6FF0',
  },
  {
    key: 'frontend',
    name: '前端工程师',
    role: '前端开发',
    personaId: 'frontend-dev',
    description: '界面实现、交互逻辑、组件化开发',
    skills: ['UI 实现', '组件开发', '交互逻辑'],
    collaboration: '按架构设计实现前端，与后端并行，产出可交付代码/方案',
    toolIds: COMMON_TOOLS,
    tags: ['前端', 'UI', '代码'],
    icon: '🎨',
    color: '#4FC3A1',
  },
  {
    key: 'backend',
    name: '后端工程师',
    role: '后端开发',
    personaId: 'backend-dev',
    description: '服务端逻辑、接口实现、数据存储',
    skills: ['接口开发', '服务端逻辑', '数据建模'],
    collaboration: '按架构设计实现后端，与前端并行，提供 API 与数据方案',
    toolIds: COMMON_TOOLS,
    tags: ['后端', 'API', '数据库'],
    icon: '⚙️',
    color: '#F0A94F',
  },
  {
    key: 'qa',
    name: '测试工程师',
    role: '测试',
    personaId: 'qa-tester',
    description: '测试计划、用例设计、缺陷分析与验收',
    skills: ['测试用例', '边界分析', '缺陷报告', '验收'],
    collaboration: '接收前后端产物，输出测试计划与用例，是交付前的质量闸门',
    toolIds: ACT_TOOLS,
    tags: ['测试', '质量', '验收'],
    icon: '🔍',
    color: '#E8636B',
  },
  {
    key: 'planner',
    name: '策划',
    role: '策划',
    personaId: 'marketing-strategist',
    description: '营销策划、活动方案、内容选题与传播策略',
    skills: ['策划方案', '内容选题', '传播策略'],
    collaboration: '输出内容框架与选题，交给文案撰写',
    toolIds: COMMON_TOOLS,
    tags: ['策划', '营销', '选题'],
    icon: '💡',
    color: '#E8A33D',
  },
  {
    key: 'copywriter',
    name: '文案',
    role: '文案撰写',
    personaId: 'sales-copywriter',
    description: '卖点提炼、广告文案、种草内容创作',
    skills: ['文案创作', '卖点提炼', '广告语'],
    collaboration: '按策划框架产出初稿，交给润色打磨',
    toolIds: COMMON_TOOLS,
    tags: ['文案', '写作', '卖点'],
    icon: '✍️',
    color: '#5FA8E8',
  },
  {
    key: 'polisher',
    name: '润色编辑',
    role: '润色',
    personaId: 'creative-writer',
    description: '文字润色、节奏调整、风格统一与可读性优化',
    skills: ['文字润色', '风格统一', '可读性优化'],
    collaboration: '接收文案初稿打磨润色，交付给校对审核',
    toolIds: COMMON_TOOLS,
    tags: ['润色', '编辑', '文笔'],
    icon: '🖋️',
    color: '#9A7FE8',
  },
  {
    key: 'ppt',
    name: 'PPT 设计专家',
    role: 'PPT 专家',
    personaId: 'designer',
    description: '演示结构设计、视觉排版、信息图表化',
    skills: ['演示结构', '视觉设计', '信息图表'],
    collaboration: '接收内容大纲，产出演示文稿结构与视觉方案',
    toolIds: COMMON_TOOLS,
    tags: ['PPT', '演示', '设计'],
    icon: '📊',
    color: '#E86BA1',
  },
  {
    key: 'analyst',
    name: '数据分析师',
    role: '数据分析',
    personaId: 'data-analyst',
    description: '数据清洗、统计分析、图表解读与结论推导',
    skills: ['数据分析', '统计建模', '图表解读'],
    collaboration: '为团队提供数据支撑与量化结论',
    toolIds: [...COMMON_TOOLS, 'query_knowledge_graph'],
    tags: ['数据', '分析', '统计'],
    icon: '📈',
    color: '#4FC3A1',
  },
  {
    key: 'translator',
    name: '翻译',
    role: '翻译',
    personaId: 'translator',
    description: '中英互译、术语统一、本地化表达',
    skills: ['中英互译', '术语管理', '本地化'],
    collaboration: '承接任意角色的文档翻译与术语校验',
    toolIds: COMMON_TOOLS,
    tags: ['翻译', '语言', '本地化'],
    icon: '🌐',
    color: '#6FA8DC',
  },
  {
    key: 'reviewer',
    name: '审核',
    role: '审核',
    personaId: 'tech-writer',
    description: '内容校对、质量审查、合规与一致性把关',
    skills: ['内容校对', '质量审查', '一致性检查'],
    collaboration: '团队流水线末端：对最终产物做质量与合规审核',
    toolIds: COMMON_TOOLS,
    tags: ['审核', '校对', '质量'],
    icon: '✅',
    color: '#7BBF6A',
  },

  /* ==================== 扩充批次：覆盖软件/办公/创作/生活/研究 ==================== */
  {
    key: 'devops',
    name: '运维工程师',
    role: '运维开发',
    personaId: 'devops-engineer',
    description: '部署发布、监控告警、CI/CD 流水线与故障排查',
    skills: ['CI/CD', '容器化', '监控告警', '故障排查'],
    collaboration: '承接前后端产物的部署与运维保障，是上线与稳定性负责人',
    toolIds: COMMON_TOOLS,
    tags: ['运维', 'DevOps', '部署'],
    icon: '🚀',
    color: '#4C8FBF',
  },
  {
    key: 'dba',
    name: '数据库工程师',
    role: '数据库开发',
    personaId: 'dba',
    description: '库表设计、SQL 优化、索引策略与数据迁移',
    skills: ['库表设计', 'SQL 优化', '索引策略', '数据迁移'],
    collaboration: '为后端提供数据建模与性能方案，保障数据层稳定高效',
    toolIds: [...COMMON_TOOLS, 'query_knowledge_graph'],
    tags: ['数据库', 'SQL', '建模'],
    icon: '🗄️',
    color: '#6B8F71',
  },
  {
    key: 'ui-designer',
    name: 'UI 设计师',
    role: 'UI/UX 设计',
    personaId: 'designer',
    description: '界面视觉、交互体验、设计规范与组件风格',
    skills: ['界面设计', '交互体验', '设计规范', '视觉风格'],
    collaboration: '为前端提供设计稿与交互方案，保证产品视觉与体验一致',
    toolIds: COMMON_TOOLS,
    tags: ['UI', 'UX', '设计'],
    icon: '🖌️',
    color: '#E86BA1',
  },
  {
    key: 'crawler',
    name: '爬虫/自动化工程师',
    role: '数据采集与自动化',
    personaId: 'code-expert',
    description: '网页抓取、接口采集、数据清洗与流程自动化',
    skills: ['数据抓取', '接口采集', '反爬处理', '流程自动化'],
    collaboration: '为数据分析师与研究角色提供原始数据与自动化脚本',
    toolIds: [...COMMON_TOOLS, 'type_text', 'click_at'],
    tags: ['爬虫', '自动化', '采集'],
    icon: '🕷️',
    color: '#7E57C2',
  },
  {
    key: 'security',
    name: '安全工程师',
    role: '安全评估',
    personaId: 'security-expert',
    description: '安全审计、漏洞分析、风险评估与加固建议',
    skills: ['安全审计', '漏洞分析', '风险评估', '安全加固'],
    collaboration: '为开发团队提供安全视角，输出风险清单与整改建议',
    toolIds: COMMON_TOOLS,
    tags: ['安全', '漏洞', '审计'],
    icon: '🛡️',
    color: '#C0392B',
  },
  {
    key: 'doc-writer',
    name: '文档撰写',
    role: '文档写作',
    personaId: 'academic-writer',
    description: '结构化写作、技术文档、说明文档与长篇报告',
    skills: ['结构化写作', '技术文档', '报告撰写', '逻辑组织'],
    collaboration: '为任何角色沉淀文档，把口头结论转化为可交付文字',
    toolIds: COMMON_TOOLS,
    tags: ['文档', '写作', '报告'],
    icon: '📄',
    color: '#5D8AA8',
  },
  {
    key: 'excel-expert',
    name: 'Excel/表格专家',
    role: '表格处理',
    personaId: 'data-analyst',
    description: '表格整理、公式建模、透视统计与数据可视化',
    skills: ['表格设计', '公式建模', '数据透视', '图表制作'],
    collaboration: '承接数据分析与办公场景的表格需求，输出可直接使用的表',
    toolIds: [...COMMON_TOOLS, 'query_knowledge_graph'],
    tags: ['Excel', '表格', '统计'],
    icon: '📋',
    color: '#27AE60',
  },
  {
    key: 'email-writer',
    name: '邮件撰写',
    role: '商务邮件',
    personaId: 'tech-writer',
    description: '商务邮件、通知函件、跟进话术与语气把控',
    skills: ['邮件写作', '商务表达', '语气把控', '跟进话术'],
    collaboration: '为团队输出得体邮件，覆盖对内通知与对外商务沟通',
    toolIds: COMMON_TOOLS,
    tags: ['邮件', '商务', '沟通'],
    icon: '✉️',
    color: '#2980B9',
  },
  {
    key: 'meeting-minutes',
    name: '会议纪要',
    role: '会议记录',
    personaId: 'tech-writer',
    description: '会议记录、要点提炼、待办拆解与决议跟进',
    skills: ['要点提炼', '待办拆解', '决议记录', '纪要输出'],
    collaboration: '把会议信息转化为结构化纪要与行动清单，供全员同步',
    toolIds: COMMON_TOOLS,
    tags: ['会议', '纪要', '协作'],
    icon: '🗒️',
    color: '#8E6E53',
  },
  {
    key: 'resume-optimizer',
    name: '简历优化',
    role: '简历顾问',
    personaId: 'career-coach',
    description: '简历诊断、经历改写、亮点提炼与投递建议',
    skills: ['简历诊断', '经历改写', '亮点提炼', '岗位匹配'],
    collaboration: '从招聘视角帮助求职者打磨简历，提升通过率',
    toolIds: COMMON_TOOLS,
    tags: ['简历', '求职', '职业'],
    icon: '📇',
    color: '#16A085',
  },
  {
    key: 'contract-review',
    name: '合同审查',
    role: '合同审阅',
    personaId: 'legal-advisor',
    description: '合同条款审阅、风险提示、修改建议与要点摘要',
    skills: ['条款审阅', '风险识别', '修改建议', '要点摘要'],
    collaboration: '为非法律背景用户把关合同，输出风险清单与谈判要点',
    toolIds: COMMON_TOOLS,
    tags: ['合同', '法律', '风险'],
    icon: '⚖️',
    color: '#6C5CE7',
  },
  {
    key: 'novelist',
    name: '小说家',
    role: '小说创作',
    personaId: 'novelist',
    description: '故事构思、人物塑造、情节推进与章节写作',
    skills: ['故事构思', '人物塑造', '情节设计', '章节写作'],
    collaboration: '独立产出小说创作，也可承接编剧/短篇的初稿任务',
    toolIds: COMMON_TOOLS,
    tags: ['小说', '故事', '创作'],
    icon: '📖',
    color: '#A569BD',
  },
  {
    key: 'poet',
    name: '诗人',
    role: '诗歌创作',
    personaId: 'poet',
    description: '现代诗、古体诗、意象打磨与韵律把控',
    skills: ['现代诗', '古体诗', '意象表达', '韵律打磨'],
    collaboration: '为文案与内容场景提供诗意表达与金句灵感',
    toolIds: COMMON_TOOLS,
    tags: ['诗歌', '文学', '创作'],
    icon: '🪶',
    color: '#B7955A',
  },
  {
    key: 'short-video',
    name: '短视频脚本',
    role: '短视频策划',
    personaId: 'creative-writer',
    description: '脚本撰写、分镜设计、爆点节奏与口播文案',
    skills: ['脚本撰写', '分镜设计', '节奏把控', '口播文案'],
    collaboration: '为视频创作提供可执行的脚本与分镜方案',
    toolIds: COMMON_TOOLS,
    tags: ['短视频', '脚本', '内容'],
    icon: '🎬',
    color: '#E67E22',
  },
  {
    key: 'prompt-eng',
    name: '图片生成提示词',
    role: 'AI 绘画提示词',
    personaId: 'designer',
    description: '画面描述、风格设定、参数建议与提示词优化',
    skills: ['画面描述', '风格设定', '参数建议', '提示词优化'],
    collaboration: '为设计与创作场景生成高质量图像提示词',
    toolIds: COMMON_TOOLS,
    tags: ['提示词', 'AI绘画', '设计'],
    icon: '🖼️',
    color: '#D35400',
  },
  {
    key: 'travel-planner',
    name: '旅行规划',
    role: '旅行顾问',
    personaId: 'travel-planner',
    description: '行程安排、预算规划、景点推荐与出行提示',
    skills: ['行程规划', '预算管理', '景点推荐', '出行提示'],
    collaboration: '根据目的地与偏好输出个性化旅行方案',
    toolIds: COMMON_TOOLS,
    tags: ['旅行', '攻略', '生活'],
    icon: '✈️',
    color: '#3498DB',
  },
  {
    key: 'fitness',
    name: '健身教练',
    role: '健身指导',
    personaId: 'fitness-trainer',
    description: '训练计划、动作指导、饮食建议与进度跟踪',
    skills: ['训练计划', '动作指导', '饮食建议', '进度管理'],
    collaboration: '根据目标与身体条件输出可执行的运动与饮食方案',
    toolIds: COMMON_TOOLS,
    tags: ['健身', '运动', '健康'],
    icon: '💪',
    color: '#E74C3C',
  },
  {
    key: 'chef',
    name: '美食菜谱',
    role: '菜谱顾问',
    personaId: 'recipe-chef',
    description: '菜品推荐、烹饪步骤、食材搭配与家常改造',
    skills: ['菜品推荐', '烹饪步骤', '食材搭配', '家常改造'],
    collaboration: '根据口味与食材条件提供可下厨的菜谱方案',
    toolIds: COMMON_TOOLS,
    tags: ['美食', '菜谱', '生活'],
    icon: '🍳',
    color: '#F39C12',
  },
  {
    key: 'psychologist',
    name: '心理疏导',
    role: '心理陪伴',
    personaId: 'psychologist',
    description: '情绪倾听、压力疏导、认知调节与心理科普',
    skills: ['情绪倾听', '压力疏导', '认知调节', '心理科普'],
    collaboration: '提供温和专业的心理支持，紧急情况建议寻求专业帮助',
    toolIds: COMMON_TOOLS,
    tags: ['心理', '情绪', '疏导'],
    icon: '🧠',
    color: '#8E44AD',
  },
  {
    key: 'health',
    name: '健康咨询',
    role: '健康顾问',
    personaId: 'medical-assistant',
    description: '症状解读、体检报告说明、养生建议与就医指引',
    skills: ['症状解读', '报告解读', '养生建议', '就医指引'],
    collaboration: '提供健康知识科普与就医指引，不替代医生诊断',
    toolIds: COMMON_TOOLS,
    tags: ['健康', '养生', '医疗'],
    icon: '🩺',
    color: '#27AE60',
  },
  {
    key: 'legal',
    name: '法律顾问',
    role: '法律咨询',
    personaId: 'lawyer-litigator',
    description: '法律常识、案例解析、权利义务说明与维权路径',
    skills: ['法律常识', '案例解析', '权利义务', '维权路径'],
    collaboration: '为日常法律问题提供参考意见，重要事项建议咨询执业律师',
    toolIds: COMMON_TOOLS,
    tags: ['法律', '维权', '常识'],
    icon: '📜',
    color: '#2C3E50',
  },
  {
    key: 'finance',
    name: '理财规划',
    role: '理财顾问',
    personaId: 'financial-advisor',
    description: '资产配置、预算管理、理财科普与风险提示',
    skills: ['资产配置', '预算管理', '理财科普', '风险提示'],
    collaboration: '提供个人理财建议与财务规划参考，不构成投资建议',
    toolIds: COMMON_TOOLS,
    tags: ['理财', '财务', '投资'],
    icon: '💰',
    color: '#F1C40F',
  },
  {
    key: 'customer-service',
    name: '客服话术',
    role: '客服支持',
    personaId: 'default',
    description: '客服应答、投诉处理、安抚话术与流程规范',
    skills: ['应答话术', '投诉处理', '情绪安抚', '流程规范'],
    collaboration: '为客服团队输出标准话术与疑难场景处理方案',
    toolIds: COMMON_TOOLS,
    tags: ['客服', '话术', '服务'],
    icon: '🎧',
    color: '#1ABC9C',
  },
  {
    key: 'pet-care',
    name: '宠物养护',
    role: '宠物顾问',
    personaId: 'pet-care',
    description: '宠物喂养、训练建议、健康护理与行为解读',
    skills: ['喂养指南', '训练建议', '健康护理', '行为解读'],
    collaboration: '为宠物主人提供日常养护与健康咨询参考',
    toolIds: COMMON_TOOLS,
    tags: ['宠物', '养护', '生活'],
    icon: '🐾',
    color: '#A0522D',
  },
  {
    key: 'academic-research',
    name: '学术论文',
    role: '学术研究',
    personaId: 'scholar',
    description: '选题论证、文献综述、论文结构与学术规范',
    skills: ['选题论证', '文献综述', '论文结构', '学术规范'],
    collaboration: '为科研场景提供论文写作框架与学术表达支持',
    toolIds: [...COMMON_TOOLS, 'query_knowledge_graph'],
    tags: ['论文', '学术', '科研'],
    icon: '🎓',
    color: '#34495E',
  },
  {
    key: 'industry-research',
    name: '行业调研',
    role: '行业研究',
    personaId: 'researcher',
    description: '行业分析、市场研究、趋势判断与报告输出',
    skills: ['行业分析', '市场研究', '趋势判断', '报告输出'],
    collaboration: '为决策提供行业全景、竞争格局与趋势洞察',
    toolIds: [...COMMON_TOOLS, 'query_knowledge_graph'],
    tags: ['行业', '调研', '研究'],
    icon: '🔬',
    color: '#16A085',
  },
]

/** 预置智能体文件目录（userData/agents） */
function agentsDir(): string {
  return path.join(app.getPath('userData'), 'agents')
}

/**
 * 预置智能体种子：
 * - agents 目录不存在时全量写入
 * - 已有目录时只补齐缺失的预置智能体（按 preset key 判断），不覆盖已有定义
 * 返回本次写入数量。
 */
export function ensurePresetAgents(): number {
  try {
    const dir = agentsDir()
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })

    const existingNames = new Set<string>()
    const existingIds = new Set<string>()
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')) as AgentDefinition
        if (parsed?.id) existingIds.add(parsed.id)
        if (parsed?.name) existingNames.add(parsed.name)
      } catch { /* 忽略损坏文件 */ }
    }

    let count = 0
    for (const spec of PRESET_AGENTS) {
      const id = `agt-preset-${spec.key}`
      // 已存在同名或同 id 的智能体则跳过（尊重用户增删改）
      if (existingIds.has(id) || existingNames.has(spec.name)) continue
      const def: AgentDefinition = buildDefaultDefinition({
        id,
        name: spec.name,
        role: spec.role,
        description: spec.description,
        icon: spec.icon,
        color: spec.color,
        personaId: spec.personaId,
        toolIds: spec.toolIds,
        memoryConfig: { enabled: true, namespace: `agent:${id}`, maxRecall: 5 },
        tags: spec.tags,
        skills: spec.skills,
        collaboration: spec.collaboration,
        preset: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(def, null, 2), 'utf-8')
      count++
    }
    if (count > 0) logger.info(`[PresetAgents] 已补齐 ${count} 个预置智能体`)
    return count
  } catch (e) {
    logger.error(`[PresetAgents] 种子失败: ${e instanceof Error ? e.message : String(e)}`)
    return 0
  }
}

/**
 * 施工蓝本 §5：二十智能体种子（新体系，与旧 PRESET_AGENTS 并存）。
 * 将 AGENT_MANIFESTS（20 个 manifest）转换为 AgentDefinition 落盘，
 * 落盘 id 为 agt-mf-<manifestKey>，满足 agent-store 的 ID_PATTERN。
 * 默认 persona 引用 'default'（通用基座），prompt 由 manifest 的 mission/role/boundaries 拼装。
 * 仅补齐缺失项，不覆盖已有定义（尊重用户增删改）。
 * 返回本次写入数量。
 */
export function ensureManifestAgents(): number {
  try {
    const dir = agentsDir()
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })

    const existingIds = new Set<string>()
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')) as AgentDefinition
        if (parsed?.id) existingIds.add(parsed.id)
      } catch { /* 忽略损坏文件 */ }
    }

    // AGENT_MANIFESTS 已通过顶层静态 import 引入（electron-vite 内联进主 bundle，
    // 避免动态 require('./agent-manifests') 在产物中被拆分为带 hash 的独立 chunk 而解析失败）

    let count = 0
    for (const m of AGENT_MANIFESTS) {
      const id = `agt-mf-${m.id.replace(/^agent-/, '')}`
      // 清单种子唯一键为 id（agt-mf-<key>）；不按 name 判重，
      // 否则与旧预设模板同名（如"数据分析师"= agt-preset-analyst）会被错误跳过，导致清单缺员
      if (existingIds.has(id)) continue

      // 固有使命 + 边界红线注入 prompt，作为该角色的默认基座
      const suffix = [
        `## 使命\n${m.mission}`,
        m.role ? `\n## 角色\n${m.role}` : '',
        m.collaboration ? `\n## 协作协议\n${m.collaboration}` : '',
        m.boundaries.length > 0 ? `\n## 边界（红线，不可违反）\n- ${m.boundaries.join('\n- ')}` : '',
      ].join('')

      const def: AgentDefinition = buildDefaultDefinition({
        id,
        name: m.name,
        role: m.role,
        description: m.mission,
        icon: m.icon,
        color: m.color,
        personaId: 'default',
        personaOverride: { systemPromptSuffix: suffix },
        toolIds: m.toolIds,
        memoryConfig: { enabled: true, namespace: `agent:${id}`, maxRecall: 5 },
        tags: [...m.tags, ...(m.defaultModelTier === 'cloud' ? ['云端'] : ['本地'])],
        skills: m.skills,
        collaboration: m.collaboration,
        preset: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(def, null, 2), 'utf-8')
      count++
    }
    if (count > 0) logger.info(`[PresetAgents] 已补齐 ${count} 个 manifest 智能体（§5 二十智能体）`)
    return count
  } catch (e) {
    logger.error(`[PresetAgents] manifest 种子失败: ${e instanceof Error ? e.message : String(e)}`)
    return 0
  }
}
