/**
 * ppt-flow.ts — PPT 演示链路编排（P4）
 *
 * 目标：用户一句话 → 玄枢完成整套 PPT 制作
 * 链路：意图/文案生成 → 启动 WPS → 新建演示文稿
 *       → 逐页填充（标题/正文）→ 放映预览 → 保存
 *
 * 实现策略：文案交给本地模型生成，操作优先走纯键盘工作流
 * （keyboard-workflow，不依赖视觉引擎；6GB 显存下视觉闭环不可用）。
 * 视觉闭环链路保留在旧实现中，待显存条件允许时恢复。
 */
import { ipcMain } from 'electron'
import { executeSkillIntent } from '../skill-pack/executor'
import { logger } from '../../shared/logger'
import { runKeyboardWorkflow } from './keyboard-workflow'

export interface PptCreateParams {
  /** 主题，如"年度总结汇报" */
  topic: string
  /** 页数（可选，默认 8） */
  pages?: number
  /** 附加要求（可选） */
  requirements?: string
  /** 是否自动放映预览（可选，默认 true） */
  preview?: boolean
}

export interface PptOutline {
  title: string
  slides: Array<{
    title: string
    bullets: string[]
  }>
}

/**
 * 生成演示文稿大纲（本地模型，无模型时回退模板）
 */
async function generateOutline(params: PptCreateParams): Promise<PptOutline> {
  const { topic } = params
  const pageCount = params.pages || 8

  // 尝试调用本地模型生成
  try {
    const { modelManager } = await import('../model-manager')
    const prompt = [
      `请为演示文稿《${topic}》生成大纲，共 ${pageCount} 页。`,
      '输出格式（严格 JSON，不要多余文字）：',
      '{"title":"演示标题","slides":[{"title":"第1页标题","bullets":["要点1","要点2"]},...]}',
      params.requirements ? `附加要求：${params.requirements}` : '',
      '要求：内容专业、逻辑连贯、每页 2-4 个要点。',
    ].join('\n')
    const res = await modelManager.generateResponse(prompt, { maxTokens: 2048, temperature: 0.7 })
    const text = typeof res === 'string' ? res : JSON.stringify(res)
    // 提取 JSON
    const match = text.match(/\{[\s\S]*\}/)
    if (match) {
      const parsed = JSON.parse(match[0]) as PptOutline
      if (parsed.title && Array.isArray(parsed.slides) && parsed.slides.length > 0) {
        return parsed
      }
    }
  } catch (e) {
    logger.debug(`[PptFlow] 模型大纲生成失败，回退模板: ${e}`)
  }

  // 回退模板
  const slides = Array.from({ length: pageCount }, (_, i) => ({
    title: `第 ${i + 1} 部分`,
    bullets: [`关于「${topic}」的核心要点 ${i + 1}`, `数据与案例支撑`, `关键结论与下一步`],
  }))
  return { title: topic, slides }
}

/**
 * 创建演示文稿主流程
 *
 * 优先走纯键盘工作流（不依赖视觉引擎）。键盘流成功后立即返回；
 * 失败时回退到视觉闭环（executeSkillIntent），供显存条件允许时使用。
 */
export async function createPresentation(params: PptCreateParams): Promise<{
  success: boolean
  outline?: PptOutline
  steps?: string[]
  savedPath?: string
  error?: string
}> {
  const steps: string[] = []
  try {
    // 1. 生成大纲
    steps.push('生成演示大纲')
    const outline = await generateOutline(params)
    steps.push(`大纲完成：${outline.title}（${outline.slides.length} 页）`)

    // 2. 键盘工作流（主路径）
    steps.push('启动 WPS 并填充幻灯片（键盘工作流）')
    const kb = await runKeyboardWorkflow(outline, params.topic, params.preview !== false)
    if (kb.success) {
      steps.push(`幻灯片填充完成，已保存：${kb.savedPath || '未知路径'}`)
      if (params.preview !== false) steps.push('放映预览完成')
      return { success: true, outline, steps, savedPath: kb.savedPath }
    }
    steps.push(`键盘工作流失败：${kb.error || '未知错误'}，尝试视觉闭环回退`)
    logger.warn(`[PptFlow] 键盘工作流失败，回退视觉闭环: ${kb.error}`)

    // 3. 视觉闭环回退（旧实现，依赖 SGLang/视觉引擎）
    const launch = await executeSkillIntent('打开 WPS 演示', { extra: { 应用: 'WPS' } })
    if (!launch.success) {
      logger.warn(`[PptFlow] WPS 启动未确认，继续尝试新建: ${launch.summary || ''}`)
    }

    // 4. 新建演示文稿
    steps.push('新建演示文稿')
    const create = await executeSkillIntent('新建演示文稿', { extra: { 标题: outline.title } })
    if (!create.success) {
      return { success: false, steps, error: `新建演示文稿失败: ${create.error || '未确认成功'}` }
    }

    // 5. 逐页填充（每页：添加幻灯片 → 填写标题 → 填写要点）
    for (let i = 0; i < outline.slides.length; i++) {
      const slide = outline.slides[i]
      steps.push(`填充第 ${i + 1} 页：${slide.title}`)
      // 第一页已在新建时创建，后续页需要新增幻灯片
      if (i > 0) {
        await executeSkillIntent('新增幻灯片')
      }
      await executeSkillIntent('编辑幻灯片标题', { extra: { 内容: slide.title } })
      await executeSkillIntent('添加幻灯片正文', { extra: { 内容: slide.bullets.join('；') } })
    }
    steps.push('幻灯片内容填充完成')

    // 6. 保存
    steps.push('保存演示文稿')
    const save = await executeSkillIntent('保存演示文稿', { extra: { 文件名: outline.title } })
    if (!save.success) {
      logger.warn(`[PptFlow] 保存未确认: ${save.summary || ''}`)
    }

    // 7. 放映预览
    if (params.preview !== false) {
      steps.push('放映预览')
      await executeSkillIntent('幻灯片放映预览')
    }

    return { success: true, outline, steps }
  } catch (e: any) {
    logger.error(`[PptFlow] 流程异常: ${e}`)
    return { success: false, steps, error: String(e) }
  }
}

/**
 * 注册 PPT 链路 IPC
 */
export function setupPptFlowHandlers(): void {
  ipcMain.handle('ppt:create', async (_e, params: PptCreateParams) => {
    try {
      return await createPresentation(params || { topic: '未命名演示' })
    } catch (e: any) {
      return { success: false, error: String(e) }
    }
  })
}
