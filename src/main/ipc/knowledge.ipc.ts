import { ipcMain, app } from 'electron'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join, resolve, sep } from 'path'
import { internetSearch } from '../search'
import { scrapeUrls } from '../search/scraper'
import type { ScrapedPage } from '../search/types'
import { vectorStore } from '../rag/vector-store'
import { getEmbedding, splitText } from '../rag/embedding'
import { knowledgeGraph } from '../knowledge-graph'
import { logger } from '../../shared/logger'

interface KnowledgeDoc {
  id: string
  title: string
  content: string
  tags: string[]
  type: 'file' | 'note' | 'web'
  createdAt: number
  source?: string
  size?: string
  updatedAt?: number
}

interface PendingKnowledge {
  id: string
  title: string
  sourceConversation: string
  createdAt: number
}

let writeLock: Promise<void> = Promise.resolve()

async function acquireLock(): Promise<() => void> {
  const prev = writeLock
  let release: () => void
  writeLock = new Promise<void>(resolve => { release = resolve })
  await prev
  return release!
}

function getKnowledgePath(): string {
  const dir = join(app.getPath('userData'), 'data')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return join(dir, 'knowledge.json')
}

function loadDocs(): KnowledgeDoc[] {
  try {
    const p = getKnowledgePath()
    if (!existsSync(p)) return getDefaultDocs()
    const data = JSON.parse(readFileSync(p, 'utf-8'))
    return Array.isArray(data) ? data : getDefaultDocs()
  } catch {
    return getDefaultDocs()
  }
}

function saveDocs(docs: KnowledgeDoc[]): void {
  try {
    writeFileSync(getKnowledgePath(), JSON.stringify(docs, null, 2))
  } catch (e) {
    logger.error('[Knowledge] 保存失败:', e)
  }
}

function getDefaultDocs(): KnowledgeDoc[] {
  return [
    {
      id: '1',
      title: '编程规范文档',
      content: '代码编写规范...',
      tags: ['技术', '规范'],
      type: 'file',
      createdAt: Date.now(),
      size: '128KB'
    },
    {
      id: '2',
      title: '项目笔记',
      content: '玄枢项目开发笔记...',
      tags: ['笔记', '项目'],
      type: 'note',
      createdAt: Date.now()
    }
  ]
}

let docs: KnowledgeDoc[] = loadDocs()

// @ts-expect-error TS6133 - getKnowledgeDir reserved for future use
function getKnowledgeDir(): string {
  const dir = join(app.getPath('userData'), 'knowledge')  // eslint-disable-line
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return dir
}

/* ============================================================
 * Pending Knowledge Storage
 * ============================================================ */
function getPendingPath(): string {
  const dir = join(app.getPath('userData'), 'data')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return join(dir, 'pending-knowledge.json')
}

function loadPending(): PendingKnowledge[] {
  try {
    const p = getPendingPath()
    if (!existsSync(p)) return []
    const data = JSON.parse(readFileSync(p, 'utf-8'))
    return Array.isArray(data) ? data : []
  } catch { return [] }
}

function savePending(items: PendingKnowledge[]): void {
  try {
    writeFileSync(getPendingPath(), JSON.stringify(items, null, 2))
  } catch (e) { logger.error('[Knowledge] 保存 pending 失败:', e) }
}

/* ============================================================
 * 知识联动：知识条目 → 语义向量（RAG）+ 知识图谱实体
 * 保证知识可被 rag:search-knowledge 跨重启检索，并沉淀进知识图谱
 * ============================================================ */
async function syncKnowledgeToVector(doc: KnowledgeDoc): Promise<boolean> {
  try {
    if (!doc?.content || !doc.id) return false

    // 1. 写入语义向量库（vector-store.json 持久化，重启后可检索）
    const chunks = splitText(doc.content)
    let chunkCount = 0
    for (let i = 0; i < chunks.length; i++) {
      try {
        const { embedding } = await getEmbedding(chunks[i])
        vectorStore.add(`knowledge-${doc.id}-${i}`, chunks[i], embedding, {
          type: 'knowledge',
          tags: doc.tags || [],
          source: doc.id,
          timestamp: Date.now(),
        })
        chunkCount++
      } catch (e) {
        logger.warn(`[Knowledge·联动] 单块嵌入失败: ${e}`)
      }
    }

    // 2. 抽取实体入知识图谱（避免重复文本重复入图）
    try {
      const entities = knowledgeGraph.extractEntitiesFromText(doc.content)
      const seen = new Set<string>()
      for (const ent of entities) {
        if (seen.has(ent.text)) continue
        seen.add(ent.text)
        knowledgeGraph.addEntity({
          name: ent.text,
          type: ent.type || 'concept',
          description: `知识条目「${doc.title}」自动抽取`,
          aliases: [],
          confidence: 0.6,
          properties: { source: `knowledge:${doc.id}` },
        })
      }
    } catch (e) {
      logger.warn(`[Knowledge·联动] 图谱实体抽取失败: ${e}`)
    }

    logger.info(`[Knowledge·联动] 条目「${doc.title}」已联动：向量 ${chunkCount} 块`)
    return true
  } catch (e) {
    logger.error(`[Knowledge·联动] 向量落库失败: ${e}`)
    return false
  }
}

/**
 * 删除知识条目时同步删除其语义向量（metadata.source === docId）
 */
function removeKnowledgeVectors(docId: string): void {
  try {
    const vectors = vectorStore.getByType('knowledge')
    for (const v of vectors) {
      if (v.metadata?.source === docId) {
        vectorStore.delete(v.id)
      }
    }
  } catch (e) {
    logger.warn(`[Knowledge·联动] 删除向量失败: ${e}`)
  }
}

/* ============================================================
 * Auto-Learn Engine: search → scrape → cross-validate → save
 * ============================================================ */

function generateSearchKeywords(topic: string): string[] {
  const t = topic.trim()
  return [
    t,
    `${t} 详解`,
    `${t} 是什么`,
    `${t} 原理`,
    `${t} 最新`,
  ]
}

function crossValidate(
  topic: string,
  pages: ScrapedPage[],
): {
  summary: string
  keyPoints: string[]
  conflicts: string[]
  confidence: number
} {
  if (pages.length === 0) {
    return {
      summary: `未能从网络中获取关于「${topic}」的有效信息。`,
      keyPoints: [],
      conflicts: [],
      confidence: 0,
    }
  }

  // Extract paragraphs from all pages
  const allParagraphs: string[] = []
  for (const page of pages) {
    const paras = page.text
      .split(/\n+/)
      .map(p => p.trim())
      .filter(p => p.length > 30 && p.length < 500)
    allParagraphs.push(...paras)
  }

  // Score paragraphs by keyword density (simple heuristic)
  const topicChars = topic.replace(/\s/g, '').split('')
  const scored = allParagraphs.map(p => {
    let score = 0
    for (const ch of topicChars) {
      if (p.includes(ch)) score += 1
    }
    // Bonus for key phrases
    const keyPhrases = ['定义', '概念', '原理', '特点', '应用', '方法', '技术', '研究', '发展']
    for (const kp of keyPhrases) {
      if (p.includes(kp)) score += 2
    }
    return { text: p, score }
  })

  scored.sort((a, b) => b.score - a.score)

  // Top 5 as key points
  const topParagraphs = scored.slice(0, Math.min(5, scored.length))
  const keyPoints = topParagraphs.map(p => {
    // Truncate long paragraphs for display
    return p.text.length > 200 ? p.text.substring(0, 200) + '...' : p.text
  })

  // Detect conflicts: find paragraphs that contain contradicting language
  const conflictMarkers = ['但是', '然而', '不过', '争议', '不同观点', '另一种说法', '相反']
  const conflictParas = allParagraphs.filter(p =>
    conflictMarkers.some(m => p.includes(m))
  )
  const conflicts = conflictParas.slice(0, 3).map(p =>
    p.length > 200 ? p.substring(0, 200) + '...' : p
  )

  // Build summary from top paragraphs
  const summaryText = topParagraphs.slice(0, 2).map(p => p.text).join(' ')
  const summary = summaryText.length > 400
    ? summaryText.substring(0, 400) + '...'
    : summaryText

  // Confidence: based on source count and paragraph quality
  const avgScore = topParagraphs.length > 0
    ? topParagraphs.reduce((s, p) => s + p.score, 0) / topParagraphs.length
    : 0
  const confidence = Math.min(0.95, 0.3 + (pages.length * 0.1) + (avgScore / 30))

  return { summary, keyPoints, conflicts, confidence }
}

function formatKnowledgePack(
  topic: string,
  summary: string,
  keyPoints: string[],
  conflicts: string[],
  confidence: number,
  sources: { title: string; url: string }[],
): string {
  const sections: string[] = []

  sections.push(`# ${topic}`)
  sections.push('')
  sections.push('## 概述')
  sections.push(summary)
  sections.push('')

  if (keyPoints.length > 0) {
    sections.push('## 要点')
    keyPoints.forEach((kp, i) => {
      sections.push(`${i + 1}. ${kp}`)
    })
    sections.push('')
  }

  if (conflicts.length > 0) {
    sections.push('## 争议/冲突信息')
    conflicts.forEach((c) => {
      sections.push(`- ${c}`)
    })
    sections.push('')
  }

  sections.push('## 置信度')
  sections.push(`${(confidence * 100).toFixed(0)}%（基于 ${sources.length} 个来源交叉验证）`)
  sections.push('')

  sections.push('## 来源引用')
  sources.forEach((s, i) => {
    sections.push(`${i + 1}. [${s.title || s.url}](${s.url})`)
  })

  return sections.join('\n')
}

export function setupKnowledgeHandlers(): void {
  ipcMain.handle('knowledge:list', () => {
    try {
      return docs
    } catch (error) {
      logger.error('knowledge:list error:', error)
      return []
    }
  })

  ipcMain.handle('knowledge:add', async (_event, doc: Omit<KnowledgeDoc, 'id' | 'createdAt'>) => {
    const release = await acquireLock()
    try {
      // 输入校验
      if (doc?.content && typeof doc.content === 'string' && doc.content.length > 1048576) {
        return { success: false, error: '文档内容不能超过 1MB' }
      }
      const newDoc: KnowledgeDoc = {
        ...doc,
        id: Date.now().toString(),
        createdAt: Date.now()
      }
      docs.push(newDoc)
      saveDocs(docs)
      // 知识联动：写入语义向量库 + 知识图谱（异步，失败不影响主流程）
      syncKnowledgeToVector(newDoc).then(ok => {
        logger.info(`[Knowledge·联动] knowledge:add 条目 ${newDoc.id} 向量${ok ? '落库成功' : '落库失败'}`)
      }).catch(e => logger.error('[Knowledge·联动] knowledge:add 异步落库异常:', e))
      return newDoc
    } catch (error) {
      logger.error('knowledge:add 内部错误:', error)
      return { error: '知识库操作遇到内部错误' }
    } finally {
      release()
    }
  })

  ipcMain.handle('knowledge:delete', async (_event, docId: string) => {
    const release = await acquireLock()
    try {
      const index = docs.findIndex(d => d.id === docId)
      if (index !== -1) {
        docs.splice(index, 1)
        saveDocs(docs)
        // 同步清理该条目的语义向量（保持向量库与知识库一致）
        removeKnowledgeVectors(docId)
      }
      return true
    } catch (error) {
      logger.error('knowledge:delete error:', error)
      return false
    } finally {
      release()
    }
  })

  ipcMain.handle('knowledge:upload', async (_event, filePath: string) => {
    const release = await acquireLock()
    try {
      // 路径遍历防护：先 resolve 再检查
      const resolvedPath = resolve(filePath)
      // 允许的路径前缀：userData、Desktop、Documents
      const allowedBases = [
        resolve(app.getPath('userData')),
        resolve(app.getPath('desktop')),
        resolve(app.getPath('documents')),
      ]
      // 拒绝系统目录
      const systemDirs = [
        process.env.SystemRoot || 'C:\\Windows',
        process.env.SystemRoot ? join(process.env.SystemRoot, 'System32') : 'C:\\Windows\\System32',
        process.env.ProgramFiles || 'C:\\Program Files',
        process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
      ]
      if (systemDirs.some(dir => resolvedPath === dir || resolvedPath.startsWith(dir + sep))) {
        return { success: false, error: '不允许访问系统目录' }
      }
      // 使用 sep 附加确保精确子目录匹配，防止 /data-attack 绕过 /data
      const isAllowed = allowedBases.some(base =>
        resolvedPath === base || resolvedPath.startsWith(base + sep)
      )
      if (!isAllowed) {
        return { success: false, error: '不允许访问该路径' }
      }
      if (resolvedPath.includes('..')) {
        return { success: false, error: '路径包含非法字符' }
      }
      if (!existsSync(filePath)) {
        return { success: false, error: '文件不存在，请检查路径是否正确' }
      }

      // B2.3: 权限不足提示 — 区分 EACCES / ENOENT / 其他错误
      let content: string
      try {
        content = readFileSync(filePath, 'utf-8')
      } catch (readErr: any) {
        const code = readErr?.code
        if (code === 'EACCES') {
          return { success: false, error: '没有读取该文件的权限，请检查文件权限设置' }
        }
        if (code === 'ENOENT') {
          return { success: false, error: '文件不存在，可能已被移动或删除' }
        }
        logger.warn('[Knowledge] readFileSync 失败:', readErr)
        return { success: false, error: `读取文件失败: ${readErr.message || '未知错误'}` }
      }
      const fileName = filePath.split(/[/\\]/).pop() || 'Untitled'
      const newDoc: KnowledgeDoc = {
        id: Date.now().toString(),
        title: fileName,
        content: content.substring(0, 50000),
        tags: ['上传'],
        type: 'file',
        createdAt: Date.now(),
        size: `${(content.length / 1024).toFixed(2)}KB`
      }
      docs.push(newDoc)
      saveDocs(docs)
      // 知识联动：写入语义向量库 + 知识图谱（异步，失败不影响主流程）
      syncKnowledgeToVector(newDoc).then(ok => {
        logger.info(`[Knowledge·联动] knowledge:upload 条目 ${newDoc.id} 向量${ok ? '落库成功' : '落库失败'}`)
      }).catch(e => logger.error('[Knowledge·联动] knowledge:upload 异步落库异常:', e))
      return newDoc
    } catch (error) {
      logger.error('knowledge:upload 内部错误:', error)
      return { error: '知识库操作遇到内部错误' }
    } finally {
      release()
    }
  })

  ipcMain.handle('knowledge:update', async (_event, docId: string, updates: Partial<KnowledgeDoc>) => {
    const release = await acquireLock()
    try {
      const doc = docs.find(d => d.id === docId)
      if (doc) {
        Object.assign(doc, updates)
        doc.updatedAt = Date.now()
        saveDocs(docs)
      }
      return true
    } catch (error) {
      logger.error('knowledge:update error:', error)
      return false
    } finally {
      release()
    }
  })

  /* ------ Search ------ */
  ipcMain.handle('knowledge:search', async (_event, query: string) => {
    try {
      const allDocs = loadDocs()
      if (!query || query.trim() === '') return allDocs
      const q = query.toLowerCase()
      return allDocs.filter((d) =>
        d.title.toLowerCase().includes(q) ||
        d.content.toLowerCase().includes(q) ||
        d.tags.some(t => t.toLowerCase().includes(q))
      )
    } catch (error) {
      logger.error('knowledge:search error:', error)
      return []
    }
  })

  /* ------ Pending Knowledge ------ */
  ipcMain.handle('knowledge:pending', () => {
    try {
      return loadPending()
    } catch (error) {
      logger.error('knowledge:pending error:', error)
      return []
    }
  })

  ipcMain.handle('knowledge:ignore-pending', async (_event, pendingId: string) => {
    const release = await acquireLock()
    try {
      const pending = loadPending()
      savePending(pending.filter(p => p.id !== pendingId))
      return true
    } catch (error) {
      logger.error('knowledge:ignore-pending error:', error)
      return false
    } finally {
      release()
    }
  })

  /* ------ Auto-Learn ------ */
  ipcMain.handle('knowledge:auto-learn', async (_event, params: { topic: string; sourceConversation: string; pendingId: string }) => {
    const release = await acquireLock()
    try {
      // 1. Generate 3-5 search keywords
      const keywords = generateSearchKeywords(params.topic)

      // 2. Search with each keyword (parallel), collect results
      const searchPromises = keywords.map(kw =>
        internetSearch.search(kw, { count: 3, language: 'zh-CN' }).catch(() => ({ results: [], total: 0, provider: 'error' }))
      )
      const searchResponses = await Promise.all(searchPromises)

      // Deduplicate by URL
      const seen = new Set<string>()
      const uniqueResults: { title: string; url: string; snippet: string }[] = []
      for (const res of searchResponses) {
        for (const r of res.results) {
          if (!seen.has(r.url)) {
            seen.add(r.url)
            uniqueResults.push(r)
          }
        }
      }
      const topResults = uniqueResults.slice(0, 5)

      // 3. Scrape top 5 result pages
      let scrapedPages: ScrapedPage[] = []
      if (topResults.length > 0) {
        const urls = topResults.map(r => r.url)
        scrapedPages = await scrapeUrls(urls)
      }
      const validPages = scrapedPages.filter(p => p.text.length > 0)

      // 4. Cross-validate: extract consensus, mark conflicts
      const { summary, keyPoints, conflicts, confidence } = crossValidate(params.topic, validPages)

      // 5. Generate structured knowledge pack
      const sources = topResults.map(r => ({ title: r.title, url: r.url }))
      const content = formatKnowledgePack(params.topic, summary, keyPoints, conflicts, confidence, sources)

      // 6. Save to knowledge base
      const newDoc: KnowledgeDoc = {
        id: Date.now().toString(),
        title: params.topic,
        content,
        tags: ['自动整理', '联网学习'],
        type: 'web',
        createdAt: Date.now(),
        source: `auto-learn（${validPages.length} 来源）`,
      }
      docs.push(newDoc)
      saveDocs(docs)
      // 知识联动：联网自动生成的条目同步写入向量库 + 知识图谱（重启后可检索、可入图）
      syncKnowledgeToVector(newDoc).then(ok => {
        logger.info(`[Knowledge·联动] knowledge:auto-learn 条目 ${newDoc.id} 向量${ok ? '落库成功' : '落库失败'}`)
      }).catch(e => logger.error('[Knowledge·联动] knowledge:auto-learn 异步落库异常:', e))

      // 7. Remove from pending
      const pending = loadPending()
      savePending(pending.filter(p => p.id !== params.pendingId))

      return {
        id: newDoc.id,
        title: newDoc.title,
        confidence,
        sourceCount: validPages.length,
        keyPointCount: keyPoints.length,
      }
    } catch (error) {
      logger.error('knowledge:auto-learn error:', error)
      return { error: String(error) }
    } finally {
      release()
    }
  })
}