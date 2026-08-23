/**
 * 自我改造流程页 zustand store
 *
 * 统一管理：能力、文件清单、当前文件、diff 预览、快照、apply/rollback 状态。
 * 所有写操作均通过 IPC 转发到 main 进程（渲染层不直接触碰文件系统）。
 *
 * @module renderer/store/selfModifyStore
 */

import { create } from 'zustand'
import type {
  ApplyResult,
  ChangeSet,
  DiffResult,
  FileListEntry,
  FileReadResult,
  GenerateResult,
  SelfModifyCapabilities,
  Snapshot,
} from '../../shared/self-modify-types'

interface SelfModifyState {
  capabilities: SelfModifyCapabilities | null
  capabilitiesLoading: boolean
  files: FileListEntry[]
  filesLoading: boolean
  currentFile: FileReadResult | null
  fileLoading: boolean
  diff: DiffResult | null
  previewLoading: boolean
  snapshots: Snapshot[]
  snapshotsLoading: boolean
  applying: boolean
  error: string | null

  loadCapabilities: () => Promise<void>
  loadFiles: (dir?: string) => Promise<void>
  loadFile: (path: string) => Promise<void>
  generate: (requirement: string) => Promise<GenerateResult>
  previewDiff: (changeSet: ChangeSet) => Promise<DiffResult | null>
  applyChangeSet: (changeSet: ChangeSet) => Promise<ApplyResult | null>
  rollback: (hash: string) => Promise<boolean>
  loadSnapshots: () => Promise<void>
  clearError: () => void
}

export const useSelfModifyStore = create<SelfModifyState>((set, get) => ({
  capabilities: null,
  capabilitiesLoading: false,
  files: [],
  filesLoading: false,
  currentFile: null,
  fileLoading: false,
  diff: null,
  previewLoading: false,
  snapshots: [],
  snapshotsLoading: false,
  applying: false,
  error: null,

  loadCapabilities: async () => {
    set({ capabilitiesLoading: true, error: null })
    try {
      const res = await window.api.invokeSafe<SelfModifyCapabilities>('self-modify:get-capabilities')
      if (res.ok && res.data) set({ capabilities: res.data })
      else set({ error: res.error || '获取能力失败' })
    } finally {
      set({ capabilitiesLoading: false })
    }
  },

  loadFiles: async (dir?: string) => {
    set({ filesLoading: true, error: null })
    try {
      const res = await window.api.invokeSafe<FileListEntry[]>('self-modify:list-files', dir)
      if (res.ok) set({ files: res.data ?? [] })
      else set({ error: res.error || '列出文件失败' })
    } finally {
      set({ filesLoading: false })
    }
  },

  loadFile: async (path: string) => {
    set({ fileLoading: true, error: null })
    try {
      const res = await window.api.invokeSafe<FileReadResult>('self-modify:read-file', path)
      if (res.ok && res.data) set({ currentFile: res.data })
      else set({ error: res.error || '读取文件失败' })
    } finally {
      set({ fileLoading: false })
    }
  },

  generate: async (requirement: string): Promise<GenerateResult> => {
    set({ error: null })
    const res = await window.api.invokeSafe<GenerateResult>('self-modify:generate', requirement)
    if (res.ok && res.data) return res.data
    return { success: false, plan: '', error: res.error || '生成失败' }
  },

  previewDiff: async (changeSet: ChangeSet): Promise<DiffResult | null> => {
    set({ previewLoading: true, error: null, diff: null })
    try {
      const res = await window.api.invokeSafe<{ success: boolean; data?: DiffResult; error?: string }>(
        'self-modify:preview-diff',
        changeSet,
      )
      if (res.ok && res.data?.success && res.data.data) {
        set({ diff: res.data.data })
        return res.data.data
      }
      set({ error: res.data?.error || res.error || '生成 diff 失败' })
      return null
    } finally {
      set({ previewLoading: false })
    }
  },

  applyChangeSet: async (changeSet: ChangeSet): Promise<ApplyResult | null> => {
    set({ applying: true, error: null })
    try {
      const res = await window.api.invokeSafe<ApplyResult>('self-modify:apply', changeSet)
      if (res.ok && res.data) {
        if (!res.data.success) set({ error: res.data.error || '应用失败' })
        return res.data
      }
      set({ error: res.error || '应用失败' })
      return null
    } finally {
      set({ applying: false })
    }
  },

  rollback: async (hash: string): Promise<boolean> => {
    set({ error: null })
    try {
      const res = await window.api.invokeSafe<{ success: boolean; error?: string }>('self-modify:rollback', hash)
      if (res.ok && res.data?.success) {
        await get().loadSnapshots()
        return true
      }
      set({ error: res.data?.error || res.error || '回滚失败' })
      return false
    } catch {
      return false
    }
  },

  loadSnapshots: async () => {
    set({ snapshotsLoading: true, error: null })
    try {
      const res = await window.api.invokeSafe<Snapshot[]>('self-modify:list-snapshots')
      if (res.ok) set({ snapshots: res.data ?? [] })
      else set({ error: res.error || '获取快照失败' })
    } finally {
      set({ snapshotsLoading: false })
    }
  },

  clearError: () => set({ error: null }),
}))
