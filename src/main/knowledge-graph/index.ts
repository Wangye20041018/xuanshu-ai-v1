import { app } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync, writeFileSync, readFileSync, renameSync } from 'fs'
import * as crypto from 'crypto'
import { logger } from '../../shared/logger'

interface Entity {
  id: string
  name: string
  type: 'person' | 'organization' | 'location' | 'concept' | 'event' | 'object' | 'custom'
  properties: Record<string, any>
  aliases: string[]
  description?: string
  createdAt: number
  updatedAt: number
  confidence: number
}

interface Relation {
  id: string
  sourceId: string
  targetId: string
  type: string
  properties: Record<string, any>
  strength: number
  createdAt: number
}

interface QueryResult {
  entities: Entity[]
  relations: Relation[]
  path?: string[]
}

class KnowledgeGraph {
  private entities: Map<string, Entity> = new Map()
  private relations: Map<string, Relation> = new Map()
  private entityIndex: Map<string, Set<string>> = new Map()
  private graphDir: string | null = null
  private maxEntities: number = 10000
  private initialized: boolean = false
  private _batchMode: boolean = false

  constructor() {
    // 延迟初始化，等待 app ready
  }

  initialize(): void {
    if (this.initialized) return
    this.graphDir = join(app.getPath('userData'), 'knowledge-graph')
    mkdirSync(this.graphDir, { recursive: true })
    this.loadGraph()
    // T04: 加载85条常识规则
    this.loadCommonKnowledge()
    this.initialized = true
  }

  private getGraphDir(): string {
    if (!this.graphDir) {
      this.initialize()
    }
    return this.graphDir!
  }

  private loadGraph(): void {
    const graphDir = this.getGraphDir()
    const entitiesFile = join(graphDir, 'entities.json')
    if (existsSync(entitiesFile)) {
      try {
        const data = JSON.parse(readFileSync(entitiesFile, 'utf-8'))
        data.forEach((entity: Entity) => {
          this.entities.set(entity.id, entity)
          this.indexEntity(entity)
        })
      } catch (e) { logger.error('[KnowledgeGraph] 加载实体数据失败:', e) }
    }

    const relationsFile = join(graphDir, 'relations.json')
    if (existsSync(relationsFile)) {
      try {
        const data = JSON.parse(readFileSync(relationsFile, 'utf-8'))
        data.forEach((relation: Relation) => {
          this.relations.set(relation.id, relation)
        })
      } catch (e) { logger.error('[KnowledgeGraph] 加载关系数据失败:', e) }
    }
  }

  private saveGraph(): void {
    const graphDir = this.getGraphDir()
    const entitiesFile = join(graphDir, 'entities.json')
    const relationsFile = join(graphDir, 'relations.json')

    try {
      // B1.2: 静默吞错修复 — 先写临时文件再原子 rename，失败时回退到直接写入
      const entitiesTmp = entitiesFile + '.tmp'
      try {
        writeFileSync(entitiesTmp, JSON.stringify(Array.from(this.entities.values()), null, 2))
        renameSync(entitiesTmp, entitiesFile)
      } catch (writeErr) {
        logger.warn('[KnowledgeGraph] tmp 写入失败，尝试直接写入 entities.json:', writeErr)
        writeFileSync(entitiesFile, JSON.stringify(Array.from(this.entities.values()), null, 2))
      }

      const relationsTmp = relationsFile + '.tmp'
      try {
        writeFileSync(relationsTmp, JSON.stringify(Array.from(this.relations.values()), null, 2))
        renameSync(relationsTmp, relationsFile)
      } catch (writeErr) {
        logger.warn('[KnowledgeGraph] tmp 写入失败，尝试直接写入 relations.json:', writeErr)
        writeFileSync(relationsFile, JSON.stringify(Array.from(this.relations.values()), null, 2))
      }
    } catch (e) {
      logger.warn('[KnowledgeGraph] saveGraph 失败，图谱数据可能未持久化:', e instanceof Error ? e.message : String(e))
    }
  }

  private indexEntity(entity: Entity): void {
    const terms = [entity.name.toLowerCase(), ...entity.aliases.map(a => a.toLowerCase())]
    terms.forEach(term => {
      if (!this.entityIndex.has(term)) {
        this.entityIndex.set(term, new Set())
      }
      this.entityIndex.get(term)!.add(entity.id)
    })
  }

  addEntity(entity: Omit<Entity, 'id' | 'createdAt' | 'updatedAt'>): Entity {
    const newEntity: Entity = {
      ...entity,
      id: `entity-${Date.now()}-${crypto.randomUUID()}`,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }

    this.entities.set(newEntity.id, newEntity)
    this.indexEntity(newEntity)

    if (!this._batchMode) {
      if (this.entities.size > this.maxEntities) {
        this.pruneOldEntities()
      }
      this.saveGraph()
    }
    return newEntity
  }

  updateEntity(id: string, updates: Partial<Entity>): Entity | null {
    const entity = this.entities.get(id)
    if (!entity) return null

    const updated: Entity = {
      ...entity,
      ...updates,
      id: entity.id,
      createdAt: entity.createdAt,
      updatedAt: Date.now()
    }

    // 从索引中移除旧 terms
    const oldTerms = [entity.name.toLowerCase(), ...entity.aliases.map(a => a.toLowerCase())]
    oldTerms.forEach(term => {
      const ids = this.entityIndex.get(term)
      if (ids) {
        ids.delete(entity.id)
        if (ids.size === 0) this.entityIndex.delete(term)
      }
    })

    this.entities.set(id, updated)
    // 增量添加新 terms 到索引
    this.indexEntity(updated)

    this.saveGraph()
    return updated
  }

  deleteEntity(id: string): boolean {
    const deleted = this.entities.delete(id)
    if (deleted) {
      const relatedRelations = Array.from(this.relations.values())
        .filter(r => r.sourceId === id || r.targetId === id)
      relatedRelations.forEach(r => this.relations.delete(r.id))

      this.entityIndex.clear()
      this.entities.forEach(e => this.indexEntity(e))
      this.saveGraph()
    }
    return deleted
  }

  addRelation(sourceId: string, targetId: string, type: string, properties: Record<string, any> = {}, strength: number = 1): Relation | null {
    const source = this.entities.get(sourceId)
    const target = this.entities.get(targetId)
    if (!source || !target) return null

    const relation: Relation = {
      id: `relation-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      sourceId,
      targetId,
      type,
      properties,
      strength: Math.max(0, Math.min(1, strength)),
      createdAt: Date.now()
    }

    this.relations.set(relation.id, relation)
    if (!this._batchMode) {
      this.saveGraph()
    }
    return relation
  }

  deleteRelation(id: string): boolean {
    const deleted = this.relations.delete(id)
    if (deleted) this.saveGraph()
    return deleted
  }

  searchEntities(query: string, options?: {
    type?: Entity['type']
    limit?: number
    minConfidence?: number
  }): Entity[] {
    const queryLower = query.toLowerCase()
    const matchedIds = new Set<string>()

    this.entityIndex.forEach((ids, term) => {
      if (term.includes(queryLower) || queryLower.includes(term)) {
        ids.forEach(id => matchedIds.add(id))
      }
    })

    let results = Array.from(matchedIds)
      .map(id => this.entities.get(id)!)
      .filter(Boolean)

    if (options?.type) {
      results = results.filter(e => e.type === options.type)
    }

    if (options?.minConfidence) {
      results = results.filter(e => e.confidence >= options.minConfidence!)
    }

    results.sort((a, b) => b.confidence - a.confidence)

    if (options?.limit) {
      results = results.slice(0, options.limit)
    }

    return results
  }

  getEntity(id: string): Entity | undefined {
    return this.entities.get(id)
  }

  getRelations(entityId: string, options?: {
    type?: string
    direction?: 'outgoing' | 'incoming' | 'both'
  }): Relation[] {
    let relations = Array.from(this.relations.values())

    if (options?.direction === 'outgoing') {
      relations = relations.filter(r => r.sourceId === entityId)
    } else if (options?.direction === 'incoming') {
      relations = relations.filter(r => r.targetId === entityId)
    } else {
      relations = relations.filter(r => r.sourceId === entityId || r.targetId === entityId)
    }

    if (options?.type) {
      relations = relations.filter(r => r.type === options.type)
    }

    return relations.sort((a, b) => b.strength - a.strength)
  }

  query(query: string): QueryResult {
    const entities = this.searchEntities(query, { limit: 20 })
    const entityIds = new Set(entities.map(e => e.id))

    const relations = Array.from(this.relations.values())
      .filter(r => entityIds.has(r.sourceId) || entityIds.has(r.targetId))
      .slice(0, 50)

    return { entities, relations }
  }

  findPath(startId: string, endId: string, maxDepth: number = 5): string[] | null {
    const visited = new Set<string>()
    const queue: Array<{ id: string; path: string[] }> = [{ id: startId, path: [startId] }]

    while (queue.length > 0) {
      const { id, path } = queue.shift()!

      if (id === endId) {
        return path
      }

      if (path.length >= maxDepth) {
        continue
      }

      if (visited.has(id)) {
        continue
      }
      visited.add(id)

      const relations = this.getRelations(id)
      relations.forEach(r => {
        const nextId = r.sourceId === id ? r.targetId : r.sourceId
        if (!visited.has(nextId)) {
          queue.push({ id: nextId, path: [...path, nextId] })
        }
      })
    }

    return null
  }

  extractEntitiesFromText(text: string): Array<{ text: string; type: Entity['type']; start: number; end: number }> {
    const results: Array<{ text: string; type: Entity['type']; start: number; end: number }> = []

    const patterns = {
      person: /[A-Z\u4e00-\u9fa5][a-z\u4e00-\u9fa5]{1,3} (先生|女士|博士|教授)/g,
      location: /(北京|上海|深圳|广州|杭州|成都|武汉|西安|南京|重庆|美国|中国|英国|法国|德国|日本|韩国)/g,
      organization: /(公司|集团|大学|医院|银行|医院|机构|组织)/g,
      other: /\d{4}年\d{1,2}月\d{1,2}日|\d{1,2}月\d{1,2}日/g
    }

    Object.entries(patterns).forEach(([type, pattern]) => {
      let match
      while ((match = pattern.exec(text)) !== null) {
        results.push({
          text: match[0],
          type: type as Entity['type'],
          start: match.index,
          end: match.index + match[0].length
        })
      }
    })

    return results
  }

  inferRelation(entityId1: string, entityId2: string): Array<{ type: string; confidence: number; reasoning: string }> {
    const inferred: Array<{ type: string; confidence: number; reasoning: string }> = []
    const entity1 = this.entities.get(entityId1)
    const entity2 = this.entities.get(entityId2)

    if (!entity1 || !entity2) return inferred

    if (entity1.type === 'person' && entity2.type === 'organization') {
      inferred.push({
        type: 'works_at',
        confidence: 0.6,
        reasoning: '人物与组织之间可能存在工作关系'
      })
    }

    if (entity1.type === 'location' && entity2.type === 'location') {
      inferred.push({
        type: 'nearby',
        confidence: 0.5,
        reasoning: '两个地点可能相邻'
      })
    }

    if (entity1.type === entity2.type) {
      inferred.push({
        type: 'similar',
        confidence: 0.4,
        reasoning: '同类实体可能具有相似属性'
      })
    }

    return inferred
  }

  getGraphStats(): {
    totalEntities: number
    totalRelations: number
    entityTypes: Record<string, number>
    relationTypes: Record<string, number>
    avgRelationsPerEntity: number
  } {
    const entityTypes: Record<string, number> = {}
    const relationTypes: Record<string, number> = {}

    this.entities.forEach(e => {
      entityTypes[e.type] = (entityTypes[e.type] || 0) + 1
    })

    this.relations.forEach(r => {
      relationTypes[r.type] = (relationTypes[r.type] || 0) + 1
    })

    return {
      totalEntities: this.entities.size,
      totalRelations: this.relations.size,
      entityTypes,
      relationTypes,
      avgRelationsPerEntity: this.relations.size / Math.max(1, this.entities.size)
    }
  }

  private pruneOldEntities(): void {
    const beforeCount = this.entities.size
    const entities = Array.from(this.entities.values())
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(this.maxEntities / 2)

    const prunedCount = beforeCount - entities.length

    this.entities.clear()
    entities.forEach(e => this.entities.set(e.id, e))

    this.entityIndex.clear()
    this.entities.forEach(e => this.indexEntity(e))

    const keepRelations = Array.from(this.relations.values())
      .filter(r => this.entities.has(r.sourceId) && this.entities.has(r.targetId))
    const orphanCount = this.relations.size - keepRelations.length
    this.relations.clear()
    keepRelations.forEach(r => this.relations.set(r.id, r))

    if (prunedCount > 0) {
      logger.warn(`[KnowledgeGraph] 裁剪了 ${prunedCount} 个旧实体和 ${orphanCount} 个孤儿关系 (剩余实体: ${this.entities.size})`)
    }
  }

  exportGraph(): string {
    return JSON.stringify({
      entities: Array.from(this.entities.values()),
      relations: Array.from(this.relations.values()),
      exportedAt: Date.now()
    }, null, 2)
  }

  importGraph(jsonData: string): boolean {
    try {
      const data = JSON.parse(jsonData)
      if (data.entities) {
        this.entities.clear()
        this.entityIndex.clear()
        data.entities.forEach((entity: Entity) => {
          this.entities.set(entity.id, entity)
          this.indexEntity(entity)
        })
      }
      if (data.relations) {
        this.relations.clear()
        data.relations.forEach((relation: Relation) => {
          this.relations.set(relation.id, relation)
        })
      }
      this.saveGraph()
      return true
    } catch (e) {
      logger.error('[KnowledgeGraph] 导入图谱数据失败:', e)
      return false
    }
  }

  clearGraph(): void {
    this.entities.clear()
    this.relations.clear()
    this.entityIndex.clear()
    this.saveGraph()
  }

  /* ============================================================
   * T04: 加载85条常识规则 + 查询API
   * ============================================================ */

  /**
   * 从 common-knowledge.json 加载常识规则为 Entity + Relation
   */
  loadCommonKnowledge(): void {
    this._batchMode = true
    try {
      // 尝试多个路径
      const possiblePaths = [
        join(process.resourcesPath, 'knowledge', 'common-knowledge.json'),
        join(app.getAppPath(), 'out', 'main', 'visual-agent', 'common-knowledge', 'common-knowledge.json'),
        join(__dirname, 'visual-agent', 'common-knowledge', 'common-knowledge.json'),
      ]

      let jsonPath: string | null = null
      for (const p of possiblePaths) {
        if (existsSync(p)) { jsonPath = p; break }
      }

      if (!jsonPath) {
        logger.debug('[KnowledgeGraph] common-knowledge.json 未找到，使用内嵌规则')
        return
      }

      const data = JSON.parse(readFileSync(jsonPath, 'utf-8'))
      if (!data.categories) return

      let ruleCount = 0
      const categoryEntityId = `entity-kg-common-knowledge`
      const categoryEntity = this.entities.get(categoryEntityId) || this.addEntity({
        name: '通用操作常识',
        type: 'concept',
        properties: { source: 'common-knowledge.json', version: data.version || '1.0' },
        aliases: ['common knowledge', '常识规则', '操作知识'],
        description: '85条通用电脑操作常识规则',
        confidence: 1.0
      })

      for (const [category, rules] of Object.entries(data.categories)) {
        if (!Array.isArray(rules)) continue

        for (const rule of rules as any[]) {
          if (!rule.id) continue

          const entityName = `规则${rule.id}: ${rule.title}`
          const entityId = `entity-kg-rule-${rule.id}`

          // 如果已存在就跳过
          if (this.entities.has(entityId)) {
            ruleCount++
            continue
          }

          this.addEntity({
            name: entityName,
            type: 'concept',
            properties: {
              ruleId: rule.id,
              category: rule.category,
              title: rule.title,
              description: rule.description || '',
              keywords: rule.keywords || [],
              elementTypes: rule.elementTypes || [],
              actionSequence: rule.actionSequence || [],
              fallbackSequence: rule.fallbackSequence || [],
              source: 'common-knowledge.json'
            },
            aliases: [...(rule.keywords || []), rule.title],
            description: rule.description || '',
            confidence: 0.9
          })

          // 创建分类→规则的 relation
          this.addRelation(categoryEntity.id, entityId, 'has_rule', { category }, 0.9)
          ruleCount++
        }
      }

      logger.debug(`[KnowledgeGraph] 注入了 ${ruleCount} 条常识规则`)
      this.saveGraph()
    } catch (e) {
      logger.error('[KnowledgeGraph] 加载常识规则失败:', e)
    } finally {
      this._batchMode = false
    }
  }

  /**
   * 查询常识规则（按意图关键词匹配）
   */
  queryCommonRules(intent: string): Array<{
    id: number
    category: string
    title: string
    description: string
    keywords: string[]
    elementTypes: string[]
    actionSequence: string[]
    fallbackSequence: string[]
  }> {
    const intentLower = intent.toLowerCase()
    const matchedRules: Array<{
      id: number
      category: string
      title: string
      description: string
      keywords: string[]
      elementTypes: string[]
      actionSequence: string[]
      fallbackSequence: string[]
      score: number
    }> = []

    for (const entity of this.entities.values()) {
      const props = entity.properties || {}
      if (!props.ruleId) continue

      let score = 0

      // 匹配关键词
      const keywords: string[] = props.keywords || []
      for (const kw of keywords) {
        if (intentLower.includes(kw.toLowerCase())) {
          score += kw.length * 2
        }
      }

      // 匹配标题
      if (intentLower.includes(props.title?.toLowerCase() || '')) {
        score += 20
      }

      // 匹配分类名
      if (intentLower.includes(props.category?.toLowerCase() || '')) {
        score += 5
      }

      if (score > 0) {
        matchedRules.push({
          id: props.ruleId,
          category: props.category || '',
          title: props.title || '',
          description: props.description || '',
          keywords: keywords,
          elementTypes: props.elementTypes || [],
          actionSequence: props.actionSequence || [],
          fallbackSequence: props.fallbackSequence || [],
          score
        })
      }
    }

    // 按分数降序排列
    matchedRules.sort((a, b) => b.score - a.score)

    return matchedRules.map(({ score, ...rule }) => rule)
  }
}

export const knowledgeGraph = new KnowledgeGraph()

export function setupKnowledgeGraphHandlers(): void {
  const { ipcMain } = require('electron')

  ipcMain.handle('kg:add-entity', (_event: any, entity: Omit<Entity, 'id' | 'createdAt' | 'updatedAt'>) => {
    return knowledgeGraph.addEntity(entity)
  })

  ipcMain.handle('kg:update-entity', (_event: any, id: string, updates: Partial<Entity>) => {
    return knowledgeGraph.updateEntity(id, updates)
  })

  ipcMain.handle('kg:delete-entity', (_event: any, id: string) => {
    return { success: knowledgeGraph.deleteEntity(id) }
  })

  ipcMain.handle('kg:add-relation', (_event: any, sourceId: string, targetId: string, type: string, properties?: Record<string, any>, strength?: number) => {
    return knowledgeGraph.addRelation(sourceId, targetId, type, properties, strength)
  })

  ipcMain.handle('kg:delete-relation', (_event: any, id: string) => {
    return { success: knowledgeGraph.deleteRelation(id) }
  })

  ipcMain.handle('kg:get-entity', (_event: any, id: string) => {
    return knowledgeGraph.getEntity(id)
  })

  ipcMain.handle('kg:search-entities', (_event: any, query: string, options?: { type?: Entity['type']; limit?: number; minConfidence?: number }) => {
    return knowledgeGraph.searchEntities(query, options)
  })

  ipcMain.handle('kg:get-relations', (_event: any, entityId: string, options?: { type?: string; direction?: string }) => {
    return knowledgeGraph.getRelations(entityId, options as any)
  })

  ipcMain.handle('kg:query', (_event: any, query: string) => {
    return knowledgeGraph.query(query)
  })

  ipcMain.handle('kg:find-path', (_event: any, startId: string, endId: string, maxDepth?: number) => {
    return knowledgeGraph.findPath(startId, endId, maxDepth)
  })

  ipcMain.handle('kg:extract-entities', (_event: any, text: string) => {
    return knowledgeGraph.extractEntitiesFromText(text)
  })

  ipcMain.handle('kg:infer-relation', (_event: any, entityId1: string, entityId2: string) => {
    return knowledgeGraph.inferRelation(entityId1, entityId2)
  })

  ipcMain.handle('kg:stats', () => {
    return knowledgeGraph.getGraphStats()
  })

  ipcMain.handle('kg:export', () => {
    return knowledgeGraph.exportGraph()
  })

  ipcMain.handle('kg:import', (_event: any, jsonData: string) => {
    return { success: knowledgeGraph.importGraph(jsonData) }
  })

  ipcMain.handle('kg:clear', () => {
    knowledgeGraph.clearGraph()
    return { success: true }
  })
}
