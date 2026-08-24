/**
 * 智能体动态创建 — 模板填空式生成
 *
 * 复用 self-modify 的「AI 生成 → 人工确认(confirmed) → 落盘」三段式交互模式，
 * 但独立模块、不碰 git/diff：
 *   ① 取 resources/personas 人设清单 + toolRegistry 工具清单
 *   ② 组装固定 schema 的「模板填空」prompt（只让 AI 填 personaId/name/description/tags/toolIds）
 *   ③ modelManager.generateResponse 生成 JSON → tryParseAgentConfig 严格解析
 *   ④ 解析失败 → 重试 1 次 → 报错降级（引导手动填写）
 *   ⑤ 返回 AgentCreatePreview（confirmed=false），渲染层确认后回传落盘
 *
 * 本地 9B 模型 JSON 输出不稳定 → 所有字段强校验 + 非法值剔除 + 默认兜底。
 *
 * @module main/agent/agent-factory
 */

import { logger } from '../../shared/logger'
import { buildDefaultDefinition, generateAgentId } from './agent-store'
import type {
  AgentCreatePreview,
  AgentDefinition,
} from '../../shared/agent-types'

/** AI 填空字段（其余字段由模板/默认值兜底） */
interface AgentFillFields {
  personaId?: string
  name?: string
  description?: string
  tags?: string[]
  toolIds?: string[]
}

/** 生成失败时的降级结果 */
const FALLBACK_WARNING = 'AI 生成失败，请手动填写智能体配置。'

/** 获取可用的工具名 + 描述（截断） */
async function listToolOptions(): Promise<Array<{ name: string; description: string }>> {
  try {
    const { toolRegistry } = await import('./tool-registry')
    return toolRegistry.getAll().map((t) => ({
      name: t.name,
      description: t.description.slice(0, 80),
    }))
  } catch {
    return []
  }
}

/** 获取可用人设清单 */
async function listPersonaOptions(): Promise<Array<{ id: string; name: string; description: string }>> {
  try {
    const { personaLoader } = await import('../persona-loader')
    return personaLoader.listPersonas().map((p) => ({
      id: p.id,
      name: p.name,
      description: (p.description || '').slice(0, 80),
    }))
  } catch {
    return []
  }
}

/** 构建模板填空 prompt（固定 schema） */
function buildFillPrompt(requirement: string, personas: Array<{ id: string; name: string }>, tools: Array<{ name: string; description: string }>): string {
  const personaLines = personas.map((p) => `- ${p.id}（${p.name}）`).join('\n')
  const toolLines = tools.map((t) => `- ${t.name}: ${t.description}`).join('\n')
  return `你是玄枢AI的智能体工厂。请根据用户需求，从给定人设与工具中创建智能体配置。

## 可用人设（personaId 必须从中选择）
${personaLines}

## 可用工具（toolIds 必须从中选择，只选与任务相关的）
${toolLines}

## 输出要求
只输出严格 JSON（不要输出其他文字），格式如下：
{"personaId":"人设id","name":"智能体名称","description":"一句话定位描述","tags":["标签1","标签2"],"toolIds":["工具名1","工具名2"]}

用户需求：${requirement}`
}

/** 严格解析 AI 输出（失败返回 undefined） */
function tryParseAgentConfig(text: string): AgentFillFields | undefined {
  if (!text) return undefined
  try {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start < 0 || end <= start) return undefined
    const json = text.slice(start, end + 1)
    const parsed = JSON.parse(json) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object') return undefined

    const fields: AgentFillFields = {}
    if (typeof parsed.personaId === 'string' && parsed.personaId.trim()) fields.personaId = parsed.personaId.trim()
    if (typeof parsed.name === 'string' && parsed.name.trim()) fields.name = parsed.name.trim()
    if (typeof parsed.description === 'string' && parsed.description.trim()) fields.description = parsed.description.trim()
    if (Array.isArray(parsed.tags)) {
      fields.tags = parsed.tags.filter((t): t is string => typeof t === 'string').map((t) => t.trim()).filter(Boolean).slice(0, 8)
    }
    if (Array.isArray(parsed.toolIds)) {
      fields.toolIds = parsed.toolIds.filter((t): t is string => typeof t === 'string').map((t) => t.trim()).filter(Boolean)
    }
    // 至少要有一个有效字段
    if (!fields.personaId && !fields.name && !fields.description) return undefined
    return fields
  } catch {
    return undefined
  }
}

/** 调模型生成一次（返回原始文本） */
async function generateOnce(prompt: string): Promise<string> {
  const { modelManager } = await import('../model-manager')
  const resp = await modelManager.generateResponse(prompt, { temperature: 0.4, maxTokens: 512 })
  return typeof resp === 'string' ? resp : (resp as { content?: string })?.content || String(resp)
}

/**
 * 生成智能体配置预览（confirmed=false）。
 * 失败返回 { success: false, error }，由渲染层降级为手动填写。
 */
export async function createAgentPreview(requirement: string): Promise<{ success: boolean; data?: AgentCreatePreview; error?: string }> {
  const req = String(requirement || '').trim()
  if (!req) {
    return { success: false, error: '需求描述不能为空' }
  }

  const personas = await listPersonaOptions()
  const tools = await listToolOptions()
  if (personas.length === 0) {
    return { success: false, error: '人设清单为空，无法创建智能体' }
  }

  const validPersonaIds = new Set(personas.map((p) => p.id))
  const validToolNames = new Set(tools.map((t) => t.name))

  const prompt = buildFillPrompt(req, personas, tools)

  // 最多尝试 2 次（首次 + 重试 1 次），失败降级
  let fields: AgentFillFields | undefined
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await generateOnce(prompt)
      fields = tryParseAgentConfig(raw)
      if (fields) break
      logger.warn(`[AgentFactory] 第 ${attempt + 1} 次解析失败，${attempt === 0 ? '重试' : '降级'}`)
    } catch (e) {
      logger.warn(`[AgentFactory] 生成异常（第 ${attempt + 1} 次）: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  if (!fields) {
    return { success: false, error: FALLBACK_WARNING }
  }

  // 交叉校验 + 非法值剔除
  const personaId = fields.personaId && validPersonaIds.has(fields.personaId) ? fields.personaId : 'default'
  const toolIds = (fields.toolIds || []).filter((t) => validToolNames.has(t))
  const persona = personas.find((p) => p.id === personaId)

  const definition = buildDefaultDefinition({
    id: generateAgentId(),
    name: fields.name || '未命名智能体',
    description: fields.description || '',
    personaId,
    toolIds,
    tags: fields.tags || [],
  })

  const preview: AgentCreatePreview = {
    definition,
    confirmed: false,
    sourcePersonaName: persona?.name,
  }
  if (personaId !== fields.personaId || toolIds.length !== (fields.toolIds || []).length) {
    preview.warning = '部分 AI 生成字段校验未通过，已自动剔除/回退默认值。'
  }

  return { success: true, data: preview }
}

/** 确认创建：校验 confirmed 后落盘 */
export async function confirmCreateAgent(
  preview: AgentCreatePreview,
): Promise<{ success: boolean; data?: AgentDefinition; error?: string }> {
  if (!preview || preview.confirmed !== true) {
    return { success: false, error: '创建未经人工确认（confirmed 未置 true）' }
  }
  const { agentStore } = await import('./agent-store')
  const result = agentStore.save(preview.definition)
  if (!result.success) {
    return { success: false, error: result.error }
  }
  return { success: true, data: result.data as AgentDefinition }
}
