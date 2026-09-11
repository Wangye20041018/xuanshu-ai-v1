﻿/**
 * 本地全文搜索引擎
 * 基于 Whoosh 对指定目录建立索引，支持自然语言搜索文件内容
 */
import { app, ipcMain } from 'electron'
import { join } from 'path'
import { existsSync, readFileSync } from 'fs'
import { logger } from '../../shared/logger'
import { pythonRuntime } from '../runtime/python'

// @ts-expect-error TS6133 — assigned but consumed through IPC handlers
let searchEngine: { index: any; searcher: any } | null = null
let whooshInstalled: boolean | null = null  // 缓存安装状态，避免重复尝试

async function ensureWhoosh(): Promise<boolean> {
  if (whooshInstalled !== null) return whooshInstalled
  const script = `
import sys, json, os
try:
    from whoosh.index import create_in, open_dir
    from whoosh.fields import Schema, TEXT, ID
    from whoosh.qparser import QueryParser
    print("WHOOSH_READY")
except ImportError:
    import subprocess, platform
    # 安全检查：确认 Python 可用
    if not sys.executable:
        print("WHOOSH_FAILED")
    else:
        try:
            subprocess.check_call([sys.executable, "-m", "pip", "install", "whoosh"], timeout=30)
            from whoosh.index import create_in, open_dir
            from whoosh.fields import Schema, TEXT, ID
            from whoosh.qparser import QueryParser
            print("WHOOSH_INSTALLED")
        except subprocess.TimeoutExpired:
            print("WHOOSH_FAILED")
        except Exception:
            print("WHOOSH_FAILED")
`
  const result = await pythonRuntime.runScript(script)
  whooshInstalled = (result.output || '').includes('WHOOSH_READY') || (result.output || '').includes('WHOOSH_INSTALLED')
  if (!whooshInstalled) {
    logger.error('[FulltextSearch] 无法安装 Whoosh 引擎，全文搜索功能将不可用')
  }
  return whooshInstalled
}

/**
 * 本地文件全文检索（可复用函数，供工具层 local_file_search 与 IPC 共用）。
 * 在已建立的 Whoosh 索引中按关键词检索，返回 { results: [{path, filename, snippet}], total }。
 */
export async function queryFiles(query: string): Promise<{ results: Array<{ path: string; filename: string; snippet: string; score: number }>; total: number; error?: string }> {
  try {
    const idxDir = join(app.getPath('userData'), 'fulltext-index')
    const safeQuery = JSON.stringify(query)
    const script = `
import sys, json
sys.path.insert(0, r"${idxDir}")
from whoosh.index import open_dir
from whoosh.qparser import MultifieldParser

safe_query = json.loads(${safeQuery})

ix = open_dir(r"${idxDir}")
with ix.searcher() as searcher:
    query_parser = MultifieldParser(["filename","content"], ix.schema)
    q = query_parser.parse(safe_query)
    results = searcher.search(q, limit=30)
    items = []
    for r in results:
        items.append({
            "path": r["path"],
            "filename": r["filename"],
            "score": r.score,
            "snippet": r.highlights("content", text=r["content"], top=3) if r["content"] else ""
        })
    print(json.dumps({"results": items, "total": len(results)}, ensure_ascii=False))
`
    await ensureWhoosh()
    const result = await pythonRuntime.runScript(script)
    const outputLine = (result.output || '').trim().split('\n').pop() || '{}'
    return JSON.parse(outputLine)
  } catch (e) {
    return { results: [], total: 0, error: String(e) }
  }
}

export function setupFulltextSearchHandlers(): void {
  ipcMain.handle('search:index-directory', async (_e, dirPath: string) => {
    try {
      const idxDir = join(app.getPath('userData'), 'fulltext-index')
      // 规范化路径为正斜杠，避免 Python 字符串中反斜杠转义问题
      const safeIdxDir = idxDir.replace(/\\/g, '/')
      const safeDirPath = JSON.stringify(dirPath)
      const script = `
import sys, json, os
sys.path.insert(0, r"${safeIdxDir}")
from whoosh.index import create_in
from whoosh.fields import Schema, TEXT, ID, DATETIME
from whoosh.analysis import StandardAnalyzer
import glob, json

safe_dir = json.loads(${safeDirPath})

try:
    os.makedirs(r"${safeIdxDir}", exist_ok=True)
    schema = Schema(
        path=ID(stored=True, unique=True),
        filename=TEXT(stored=True),
        content=TEXT(analyzer=StandardAnalyzer(), stored=True),
    )
    ix = create_in(r"${safeIdxDir}", schema)
    writer = ix.writer()
    count = 0
    for ext in ['*.txt','*.md','*.csv','*.py','*.js','*.ts','*.tsx','*.html','*.json','*.xml','*.yaml','*.yml','*.log','*.ini','*.cfg']:
        for f in glob.glob(os.path.join(safe_dir, '**', ext), recursive=True):
            try:
                with open(f, 'r', encoding='utf-8', errors='ignore') as fh:
                    content = fh.read(10000)
                writer.add_document(path=f, filename=os.path.basename(f), content=content)
                count += 1
                if count >= 5000: break
            except: pass
        if count >= 5000: break
    writer.commit()
    print(json.dumps({"status":"ok","count":count}))
except Exception as e:
    print(json.dumps({"status":"error","msg":str(e)}))
`
      await ensureWhoosh()
      const result = await pythonRuntime.runScript(script)
      return JSON.parse((result.output || '').trim().split('\n').pop() || '{"status":"ok"}')
    } catch (e) {
      return { status: 'error', msg: String(e) }
    }
  })

  ipcMain.handle('search:query-files', async (_e, query: string) => {
    return queryFiles(String(query || ''))
  })

  // 增量索引 — 单个文件
  ipcMain.handle('search:index-file', async (_e, filePath: string) => {
    try {
      const idxDir = join(app.getPath('userData'), 'fulltext-index')
      if (!existsSync(filePath)) return { status: 'error', msg: '文件不存在' }
      const content = readFileSync(filePath, 'utf-8').slice(0, 100000)
      const fileName = filePath.split(/[\\/]/).pop() || filePath
      const safePath = JSON.stringify(filePath)
      const safeName = JSON.stringify(fileName)
      const safeContent = JSON.stringify(content.slice(0, 50000))
      const script = `
import sys, json, os
sys.path.insert(0, r"${idxDir}")
from whoosh.index import open_dir
os.makedirs(r"${idxDir}", exist_ok=True)

safe_path = json.loads(${safePath})
safe_name = json.loads(${safeName})
safe_content = json.loads(${safeContent})

try:
  ix = open_dir(r"${idxDir}")
  writer = ix.writer()
  writer.update_document(path=safe_path, filename=safe_name, content=safe_content)
  writer.commit()
  print(json.dumps({"status":"ok","path":safe_path}))
except Exception as e:
  print(json.dumps({"status":"error","msg":str(e)}))
`
      await ensureWhoosh()
      const result = await pythonRuntime.runScript(script)
      return JSON.parse((result.output || '').trim().split('\n').pop() || '{"status":"ok"}')
    } catch (e) {
      return { status: 'error', msg: String(e) }
    }
  })

  // 删除索引条目
  ipcMain.handle('search:delete-file', async (_e, filePath: string) => {
    try {
      const idxDir = join(app.getPath('userData'), 'fulltext-index')
      const safePath = JSON.stringify(filePath)
      const script = `
import sys, json, os
sys.path.insert(0, r"${idxDir}")
from whoosh.index import open_dir

safe_path = json.loads(${safePath})

try:
  ix = open_dir(r"${idxDir}")
  writer = ix.writer()
  writer.delete_by_term("path", safe_path)
  writer.commit()
  print(json.dumps({"status":"ok"}))
except Exception as e:
  print(json.dumps({"status":"error","msg":str(e)}))
`
      await ensureWhoosh()
      const result = await pythonRuntime.runScript(script)
      return JSON.parse((result.output || '').trim().split('\n').pop() || '{"status":"ok"}')
    } catch (e) {
      return { status: 'error', msg: String(e) }
    }
  })

  // 索引统计
  ipcMain.handle('search:index-stats', async () => {
    try {
      const idxDir = join(app.getPath('userData'), 'fulltext-index')
      if (!existsSync(idxDir)) return { docCount: 0, indexSize: 0, lastUpdate: null }
      const script = `
import sys, json, os
sys.path.insert(0, r"${idxDir}")
from whoosh.index import open_dir

try:
  ix = open_dir(r"${idxDir}")
  doc_count = ix.doc_count()
  index_size = sum(os.path.getsize(os.path.join(r"${idxDir}", f)) for f in os.listdir(r"${idxDir}"))
  with ix.searcher() as s:
    recent = list(s.documents())  # just to confirm alive
  print(json.dumps({"status":"ok","docCount":doc_count,"indexSize":index_size,"lastUpdate":None}))
except Exception as e:
  print(json.dumps({"status":"error","msg":str(e)}))
`
      await ensureWhoosh()
      const result = await pythonRuntime.runScript(script)
      return JSON.parse((result.output || '').trim().split('\n').pop() || '{"docCount":0}')
    } catch (e) {
      return { docCount: 0, indexSize: 0, lastUpdate: null }
    }
  })
}
