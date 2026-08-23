/**
 * useUndoManager — 操作可撤销 Hook
 *
 * 基于 Command Pattern 的撤销/重做管理器。
 * 支持配置修改、文件操作等可逆操作的撤销。
 *
 * @module useUndoManager
 */

import { useState, useCallback, useRef } from 'react'

export interface UndoableCommand {
  /** 执行操作 */
  execute: () => void | Promise<void>
  /** 撤销操作 */
  undo: () => void | Promise<void>
  /** 操作描述（用于 UI 提示） */
  description: string
}

interface HistoryEntry {
  command: UndoableCommand
  timestamp: number
}

export interface UseUndoManagerReturn {
  /** 执行一个可撤销的操作 */
  execute: (command: UndoableCommand) => Promise<void>
  /** 撤销最近一次操作 */
  undo: () => Promise<void>
  /** 重做最近撤销的操作 */
  redo: () => Promise<void>
  /** 是否可以撤销 */
  canUndo: boolean
  /** 是否可以重做 */
  canRedo: boolean
  /** 撤销栈中的操作描述列表 */
  undoStack: Array<string>
  /** 清空历史 */
  clear: () => void
}

export function useUndoManager(maxHistory = 50): UseUndoManagerReturn {
  // L-17: 栈数据存 ref，避免 useCallback 依赖整个栈数组导致回调频繁重建与闭包过期
  const stackRef = useRef<{ undo: HistoryEntry[]; redo: HistoryEntry[] }>({
    undo: [],
    redo: [],
  })
  const [undoStack, setUndoStack] = useState<Array<string>>([])
  const [redoStack, setRedoStack] = useState<Array<string>>([])
  const isExecuting = useRef(false)

  const syncStacks = (): void => {
    const s = stackRef.current
    setUndoStack(s.undo.map((e) => e.command.description))
    setRedoStack(s.redo.map((e) => e.command.description))
  }

  const execute = useCallback(
    async (command: UndoableCommand): Promise<void> => {
      if (isExecuting.current) {
        return
      }
      isExecuting.current = true
      try {
        await command.execute()
        const next = [...stackRef.current.undo, { command, timestamp: Date.now() }]
        stackRef.current.undo = next.length > maxHistory ? next.slice(-maxHistory) : next
        stackRef.current.redo = []
        syncStacks()
      } finally {
        isExecuting.current = false
      }
    },
    [maxHistory],
  )

  const undo = useCallback(async (): Promise<void> => {
    const s = stackRef.current
    if (s.undo.length === 0) {
      return
    }
    const entry = s.undo[s.undo.length - 1]
    if (!entry) {
      return
    }
    await entry.command.undo()
    s.undo = s.undo.slice(0, -1)
    s.redo = [...s.redo, entry]
    syncStacks()
  }, [])

  const redo = useCallback(async (): Promise<void> => {
    const s = stackRef.current
    if (s.redo.length === 0) {
      return
    }
    const entry = s.redo[s.redo.length - 1]
    if (!entry) {
      return
    }
    await entry.command.execute()
    s.redo = s.redo.slice(0, -1)
    s.undo = [...s.undo, entry]
    syncStacks()
  }, [])

  const clear = useCallback((): void => {
    stackRef.current = { undo: [], redo: [] }
    syncStacks()
  }, [])

  return {
    execute,
    undo,
    redo,
    canUndo: undoStack.length > 0,
    canRedo: redoStack.length > 0,
    undoStack,
    clear,
  }
}
