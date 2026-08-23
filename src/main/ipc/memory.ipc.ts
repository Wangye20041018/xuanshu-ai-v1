/**
 * memory.ipc.ts — 记忆/知识库 IPC 处理（better-sqlite3 持久化存储）
 *
 * P1-4: 从内存数组 + JSON 文件改为 better-sqlite3 数据库，
 *       支持并发安全写入、索引查询、事务保护。
 */

import { ipcMain, app } from 'electron'
import { existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import Database from 'better-sqlite3'
import { logger } from '../../shared/logger'

interface Memory {
  id: string
  content: string
  type: 'conversation' | 'preference' | 'fact'
  timestamp: number
  tags: string[]
}

let db: Database.Database | null = null

function getDbPath(): string {
  const dir = join(app.getPath('userData'), 'data')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return join(dir, 'memories.db')
}

function openDb(): Database.Database {
  if (db) return db
  const dbPath = getDbPath()
  db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('conversation', 'preference', 'fact')),
      timestamp INTEGER NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]'
    )
  `)
  // 迁移 JSON 文件中的旧数据
  migrateFromJson(db)
  return db
}

/**
 * 备份前调用：将 WAL 内容合并回主数据库文件（TRUNCATE 模式清空 -wal/-shm），
 * 使 memories.db 自包含，zip 中无需携带 wal/shm 伴生文件。
 */
export function checkpointMemoryDb(): void {
  try {
    const database = openDb()
    database.pragma('wal_checkpoint(TRUNCATE)')
    logger.debug('[Memory] wal_checkpoint(TRUNCATE) 完成')
  } catch (e) {
    logger.warn('[Memory] wal_checkpoint 失败:', e)
  }
}

function migrateFromJson(db: Database.Database): void {
  try {
    const jsonPath = join(app.getPath('userData'), 'data', 'memories.json')
    const fs = require('fs')
    if (!fs.existsSync(jsonPath)) return

    const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'))
    if (!Array.isArray(data) || data.length === 0) return

    const existing = db.prepare('SELECT COUNT(*) as cnt FROM memories').get() as any
    if (existing?.cnt > 0) {
      // 已迁移过，删除旧 JSON
      try { fs.unlinkSync(jsonPath) } catch { /* ignore */ }
      return
    }

    const insert = db.prepare(
      'INSERT OR IGNORE INTO memories (id, content, type, timestamp, tags) VALUES (?, ?, ?, ?, ?)'
    )
    const tx = db.transaction((items: any[]) => {
      for (const item of items) {
        insert.run(
          item.id || String(Date.now()),
          item.content || '',
          item.type || 'fact',
          item.timestamp || Date.now(),
          JSON.stringify(item.tags || [])
        )
      }
    })
    tx(data)
    try { fs.unlinkSync(jsonPath) } catch { /* ignore */ }
    logger.info('[Memory] 已从 JSON 迁移到 SQLite')
  } catch (e) {
    logger.error('[Memory] JSON 迁移失败:', e)
  }
}

function rowToMemory(row: any): Memory {
  return {
    id: row.id,
    content: row.content,
    type: row.type,
    timestamp: row.timestamp,
    tags: JSON.parse(row.tags || '[]')
  }
}

function seedDefaults(): void {
  const database = openDb()
  // P0-2 清理历史占位/示例记忆（曾写死"用户的名字是张先生"等错误数据，与真实用户不符）
  const removePlaceholders = database.prepare(
    "DELETE FROM memories WHERE id IN ('1','2') AND (content LIKE '%张先生%' OR content LIKE '%晚上使用软件%')"
  )
  removePlaceholders.run()
}

export function addMemorySync(memory: Omit<Memory, 'id' | 'timestamp'>): Memory {
  const database = openDb()
  const newMemory: Memory = {
    ...memory,
    id: `sync-${Date.now().toString()}-${Math.random().toString(36).substr(2, 5)}`,
    timestamp: Date.now()
  }
  database.prepare(
    'INSERT INTO memories (id, content, type, timestamp, tags) VALUES (?, ?, ?, ?, ?)'
  ).run(newMemory.id, newMemory.content, newMemory.type, newMemory.timestamp, JSON.stringify(newMemory.tags))
  return newMemory
}

export function deleteMemorySync(memoryId: string): boolean {
  const database = openDb()
  const result = database.prepare('DELETE FROM memories WHERE id = ?').run(memoryId)
  return result.changes > 0
}

export function setupMemoryHandlers(): void {
  seedDefaults()

  ipcMain.handle('memory:list', (_event, filter?: { type?: string; search?: string }) => {
    try {
      const database = openDb()
      let sql = 'SELECT * FROM memories WHERE 1=1'
      const params: any[] = []
      if (filter?.type) {
        sql += ' AND type = ?'
        params.push(filter.type)
      }
      if (filter?.search) {
        sql += ' AND (content LIKE ? OR tags LIKE ?)'
        const searchPattern = `%${filter.search}%`
        params.push(searchPattern, searchPattern)
      }
      sql += ' ORDER BY timestamp DESC LIMIT 500'
      const rows = database.prepare(sql).all(...params) as any[]
      return rows.map(rowToMemory)
    } catch (error) {
      logger.error('memory:list error:', error)
      return []
    }
  })

  ipcMain.handle('memory:add', async (_event, memory: Omit<Memory, 'id' | 'timestamp'>) => {
    try {
      if (memory?.content && typeof memory.content === 'string' && memory.content.length > 65536) {
        return { error: '记忆内容不能超过 64KB' }
      }

      const database = openDb()
      const newMemory: Memory = {
        ...memory,
        id: Date.now().toString(),
        timestamp: Date.now()
      }
      database.prepare(
        'INSERT INTO memories (id, content, type, timestamp, tags) VALUES (?, ?, ?, ?, ?)'
      ).run(newMemory.id, newMemory.content, newMemory.type, newMemory.timestamp, JSON.stringify(newMemory.tags))
      return newMemory
    } catch (error) {
      logger.error('memory:add 内部错误:', error)
      return { error: '记忆操作遇到内部错误' }
    }
  })

  ipcMain.handle('memory:delete', async (_event, memoryId: string) => {
    try {
      const database = openDb()
      database.prepare('DELETE FROM memories WHERE id = ?').run(memoryId)
      return true
    } catch (error) {
      logger.error('memory:delete error:', error)
      return false
    }
  })

  ipcMain.handle('memory:search', (_event, query: string) => {
    try {
      const database = openDb()
      const searchPattern = `%${query}%`
      const rows = database.prepare(
        'SELECT * FROM memories WHERE content LIKE ? OR tags LIKE ? ORDER BY timestamp DESC LIMIT 200'
      ).all(searchPattern, searchPattern) as any[]
      return rows.map(rowToMemory)
    } catch (error) {
      logger.error('memory:search error:', error)
      return []
    }
  })
}

export function closeMemoryDb(): void {
  if (db) {
    try { db.close() } catch { /* ignore */ }
    db = null
  }
}
