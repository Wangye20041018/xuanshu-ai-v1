/**
 * team-templates.ts — 团队模板库（第三批：智能体阵列 · 一键成团）
 *
 * 常用角色组合模板：软件开发团队 / 文案团队 / PPT 团队。
 * 模板步骤按「角色名」引用预置智能体，运行期 resolve 到实际 agentId：
 *   1. 先按 name 精确匹配预置智能体
 *   2. 再按 personaId 匹配
 *   3. 兜底用第一个可用智能体
 *
 * @module main/agent/team-templates
 */

import type { AgentDefinition, SwarmStep, SwarmTask, TeamTemplate } from '../../shared/agent-types'

export const TEAM_TEMPLATES: TeamTemplate[] = [
  {
    id: 'team-software-dev',
    name: '软件开发团队',
    icon: '💻',
    description: '产品经理 → 架构师 → 前后端并行 → 测试 → 审核汇总，全流程交付',
    pipeline: '产品经理 → 架构师 → 前端 ∥ 后端 → 测试 → 审核',
    steps: [
      {
        id: 't1',
        role: '产品经理',
        instruction:
          '你是产品经理。请基于用户目标「{goal}」做需求分析：明确目标用户、核心场景、功能清单与验收标准。输出结构化需求说明。',
        dependsOn: [],
      },
      {
        id: 't2',
        role: '架构师',
        instruction:
          '你是架构师。请基于前序产品需求做技术设计：模块划分、技术选型、接口定义与关键难点方案。输出技术设计文档。',
        dependsOn: ['t1'],
      },
      {
        id: 't3',
        role: '前端开发',
        instruction:
          '你是前端工程师。请基于需求与技术设计，输出前端实现方案：页面结构、组件划分、交互逻辑与关键代码。',
        dependsOn: ['t1', 't2'],
      },
      {
        id: 't4',
        role: '后端开发',
        instruction:
          '你是后端工程师。请基于需求与技术设计，输出后端实现方案：接口清单、数据模型、服务端逻辑与关键代码。',
        dependsOn: ['t1', 't2'],
      },
      {
        id: 't5',
        role: '测试',
        instruction:
          '你是测试工程师。请基于前后端产物，输出测试计划与测试用例：功能点覆盖、边界场景、风险点与验收清单。',
        dependsOn: ['t3', 't4'],
      },
      {
        id: 't6',
        role: '审核',
        instruction:
          '你是审核。请汇总以上各步骤产物（需求、设计、前后端、测试），做最终交付总结：完成情况、遗留风险、验收结论。',
        dependsOn: ['t5'],
      },
    ],
  },
  {
    id: 'team-copywriting',
    name: '文案团队',
    icon: '✍️',
    description: '策划 → 文案 → 润色 → 校对，一条龙内容生产',
    pipeline: '策划 → 文案 → 润色 → 校对',
    steps: [
      {
        id: 't1',
        role: '策划',
        instruction:
          '你是策划。请围绕主题「{goal}」做内容策划：目标受众、核心信息、内容框架与传播角度。输出策划方案。',
        dependsOn: [],
      },
      {
        id: 't2',
        role: '文案撰写',
        instruction:
          '你是文案。请按前序策划框架撰写完整文案初稿：标题、正文、结尾引导，语言有感染力。',
        dependsOn: ['t1'],
      },
      {
        id: 't3',
        role: '润色',
        instruction:
          '你是润色编辑。请打磨前序文案：优化句式、统一风格、提升可读性，保留原意，输出润色稿。',
        dependsOn: ['t2'],
      },
      {
        id: 't4',
        role: '审核',
        instruction:
          '你是审核。请校对前序润色稿：错别字、逻辑、合规与一致性检查，输出最终定稿与修改说明。',
        dependsOn: ['t3'],
      },
    ],
  },
  {
    id: 'team-ppt',
    name: 'PPT 团队',
    icon: '📊',
    description: '框架 → 内容 → 设计 → 审核，产出演示文稿方案',
    pipeline: '框架 → 内容 → 设计 → 审核',
    steps: [
      {
        id: 't1',
        role: '策划',
        instruction:
          '你是策划。请为演示主题「{goal}」搭建 PPT 大纲框架：页数结构、每页核心观点、叙事逻辑。输出大纲。',
        dependsOn: [],
      },
      {
        id: 't2',
        role: '文案撰写',
        instruction:
          '你是文案。请按前序大纲填充每页内容：标题、要点、数据与案例，表述精炼适合演示。',
        dependsOn: ['t1'],
      },
      {
        id: 't3',
        role: 'PPT 专家',
        instruction:
          '你是 PPT 设计专家。请基于大纲与内容，输出演示文稿设计方案：每页版式、视觉层级、图表建议与配色。',
        dependsOn: ['t2'],
      },
      {
        id: 't4',
        role: '审核',
        instruction:
          '你是审核。请审查前序 PPT 方案：结构完整性、内容一致性、视觉规范，输出最终建议。',
        dependsOn: ['t3'],
      },
    ],
  },

  {
    id: 'team-content',
    name: '内容创作团队',
    icon: '🎨',
    description: '策划 → 文案 → 短视频/提示词 → 润色 → 审核，全链路内容生产',
    pipeline: '策划 → 文案 → 创作(短视频/提示词) → 润色 → 审核',
    steps: [
      {
        id: 't1',
        role: '策划',
        instruction:
          '你是策划。请围绕主题「{goal}」做内容策划：目标受众、核心信息、内容框架与传播角度。输出策划方案。',
        dependsOn: [],
      },
      {
        id: 't2',
        role: '文案撰写',
        instruction:
          '你是文案。请按前序策划框架撰写完整文案初稿：标题、正文、结尾引导，语言有感染力。',
        dependsOn: ['t1'],
      },
      {
        id: 't3',
        role: '短视频策划',
        instruction:
          '你是短视频脚本。请基于文案产出短视频脚本：分镜、口播词、画面提示与节奏设计。',
        dependsOn: ['t2'],
      },
      {
        id: 't4',
        role: '润色',
        instruction:
          '你是润色编辑。请打磨前序全部内容：优化句式、统一风格、提升可读性，输出润色稿。',
        dependsOn: ['t3'],
      },
      {
        id: 't5',
        role: '审核',
        instruction:
          '你是审核。请校对前序定稿：错别字、逻辑、合规与一致性检查，输出最终交付说明。',
        dependsOn: ['t4'],
      },
    ],
  },
  {
    id: 'team-life',
    name: '生活顾问团队',
    icon: '🏡',
    description: '理财 → 健康 → 旅行/健身 → 心理，一站式生活方案',
    pipeline: '理财 → 健康 → 生活方案(旅行/健身) → 心理综合',
    steps: [
      {
        id: 't1',
        role: '理财顾问',
        instruction:
          '你是理财顾问。请基于用户目标「{goal}」做个人财务规划：预算结构、资产配置建议与风险提示。',
        dependsOn: [],
      },
      {
        id: 't2',
        role: '健康顾问',
        instruction:
          '你是健康顾问。请基于前序目标给出健康生活建议：作息、饮食与就医指引（不替代医生诊断）。',
        dependsOn: ['t1'],
      },
      {
        id: 't3',
        role: '旅行规划',
        instruction:
          '你是旅行规划。请根据目标与预算输出可执行的生活方案：行程安排、开销预算与注意事项。',
        dependsOn: ['t2'],
      },
      {
        id: 't4',
        role: '心理疏导',
        instruction:
          '你是心理疏导。请综合前序方案给出心理与情绪层面的支持建议，关注可持续性与幸福感。',
        dependsOn: ['t3'],
      },
    ],
  },
]


/** 按角色名解析模板步骤 → SwarmStep（落到真实 agentId） */
export function resolveTemplate(
  template: TeamTemplate,
  goal: string,
  agents: AgentDefinition[],
): { success: boolean; task?: SwarmTask; error?: string } {
  if (!template || !Array.isArray(template.steps) || template.steps.length === 0) {
    return { success: false, error: '模板为空' }
  }
  if (agents.length === 0) {
    return { success: false, error: '没有可用智能体，请先创建智能体' }
  }

  const steps: SwarmStep[] = []
  for (const ts of template.steps) {
    const agent = pickAgent(ts.role, agents)
    steps.push({
      id: ts.id,
      agentId: agent.id,
      instruction: ts.instruction.replace(/\{goal\}/g, goal),
      dependsOn: Array.isArray(ts.dependsOn) ? ts.dependsOn.filter((d) => template.steps.some((s) => s.id === d)) : [],
    })
  }

  if (steps.some((s) => !s.agentId)) {
    return { success: false, error: '模板角色解析失败' }
  }

  const task: SwarmTask = {
    id: `swarm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    goal: goal || template.name,
    steps,
    mode: 'manual',
    status: 'planning',
    createdAt: Date.now(),
  }
  return { success: true, task }
}

/** 角色 → 智能体：name 精确 > personaId > 名称包含 > 兜底第一个 */
function pickAgent(role: string, agents: AgentDefinition[]): AgentDefinition {
  const byName = agents.find((a) => a.name === role || a.role === role)
  if (byName) return byName
  const byPersona = agents.find((a) => a.personaId === role)
  if (byPersona) return byPersona
  const byFuzzy = agents.find((a) => a.name.includes(role) || role.includes(a.name) || (a.role && a.role.includes(role)))
  if (byFuzzy) return byFuzzy
  return agents[0]
}

export function getTeamTemplate(id: string): TeamTemplate | undefined {
  return TEAM_TEMPLATES.find((t) => t.id === id)
}
