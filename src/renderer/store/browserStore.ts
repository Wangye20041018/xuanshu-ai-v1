/**
 * browserStore — 内置浏览器状态（zustand）
 *
 * 标签页/地址栏/书签。视图由主进程 WebContentsView 承载，渲染层只发指令收状态。
 *
 * @module renderer/store/browserStore
 */

import { create } from 'zustand'

export interface BrowserTabInfo {
  id: string
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
}

export interface Bookmark {
  url: string
  title: string
  createdAt: number
}

interface BrowserState {
  tabs: BrowserTabInfo[]
  activeTabId: string | null
  bookmarks: Bookmark[]
  urlInput: string

  setTabs: (tabs: BrowserTabInfo[], activeTabId: string | null) => void
  setUrlInput: (v: string) => void
  createTab: (url?: string) => Promise<void>
  closeTab: (id: string) => Promise<void>
  switchTab: (id: string) => Promise<void>
  navigate: (url: string) => Promise<void>
  goBack: () => Promise<void>
  goForward: () => Promise<void>
  reload: () => Promise<void>
  loadTabs: () => Promise<void>
  loadBookmarks: () => Promise<void>
  addBookmark: (url: string, title: string) => Promise<void>
  removeBookmark: (url: string) => Promise<void>
}

const api = typeof window !== 'undefined' ? (window as any).api : undefined

export const useBrowserStore = create<BrowserState>((set, get) => ({
  tabs: [],
  activeTabId: null,
  bookmarks: [],
  urlInput: '',

  setTabs: (tabs, activeTabId) => set({ tabs, activeTabId, urlInput: tabs.find((t) => t.id === activeTabId)?.url || '' }),
  setUrlInput: (v) => set({ urlInput: v }),

  createTab: async (url) => {
    try {
      await api?.invoke?.('browser:create-tab', url)
      await get().loadTabs()
    } catch {
      /* ignore */
    }
  },

  closeTab: async (id) => {
    try {
      await api?.invoke?.('browser:close-tab', id)
      await get().loadTabs()
    } catch {
      /* ignore */
    }
  },

  switchTab: async (id) => {
    try {
      await api?.invoke?.('browser:switch-tab', id)
      await get().loadTabs()
    } catch {
      /* ignore */
    }
  },

  navigate: async (url) => {
    const id = get().activeTabId
    if (!id) return
    try {
      await api?.invoke?.('browser:navigate', { id, url })
    } catch {
      /* ignore */
    }
  },

  goBack: async () => {
    const id = get().activeTabId
    if (!id) return
    await api?.invoke?.('browser:go-back', id)
  },

  goForward: async () => {
    const id = get().activeTabId
    if (!id) return
    await api?.invoke?.('browser:go-forward', id)
  },

  reload: async () => {
    const id = get().activeTabId
    if (!id) return
    await api?.invoke?.('browser:reload', id)
  },

  loadTabs: async () => {
    try {
      const res = await api?.invoke?.('browser:list-tabs')
      if (res) {
        set({
          tabs: (res.data || []) as BrowserTabInfo[],
          activeTabId: res.activeTabId || null,
          urlInput: ((res.data || []) as BrowserTabInfo[]).find((t) => t.id === res.activeTabId)?.url || '',
        })
      }
    } catch {
      /* ignore */
    }
  },

  loadBookmarks: async () => {
    try {
      const res = await api?.invoke?.('browser:list-bookmarks')
      if (res?.success) set({ bookmarks: (res.data || []) as Bookmark[] })
    } catch {
      /* ignore */
    }
  },

  addBookmark: async (url, title) => {
    try {
      const res = await api?.invoke?.('browser:add-bookmark', { url, title })
      if (res?.success) set({ bookmarks: res.data || [] })
    } catch {
      /* ignore */
    }
  },

  removeBookmark: async (url) => {
    try {
      const res = await api?.invoke?.('browser:remove-bookmark', url)
      if (res?.success) set({ bookmarks: res.data || [] })
    } catch {
      /* ignore */
    }
  },
}))
