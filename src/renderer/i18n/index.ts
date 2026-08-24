/**
 * i18n 国际化框架
 *
 * 基于轻量级 key-value 翻译表，零依赖。
 * 支持中文/英文，可扩展更多语言。
 *
 * @module i18n
 */

export type Locale = 'zh-CN' | 'en-US'

export interface TranslationTable {
  [key: string]: string | TranslationTable
}

/* ==================== 翻译表 ==================== */

const zh_CN: TranslationTable = {
  common: {
    appName: '玄枢AI',
    ok: '确定',
    cancel: '取消',
    save: '保存',
    delete: '删除',
    edit: '编辑',
    search: '搜索',
    loading: '加载中...',
    noData: '暂无数据',
    error: '出错了',
    retry: '重试',
    confirm: '确认',
    back: '返回',
    home: '首页',
    settings: '设置',
    close: '关闭',
    undo: '撤销',
    redo: '重做',
  },
  sidebar: {
    home: '首页',
    voice: '声音',
    model: '模型',
    memory: '记忆',
    knowledge: '知识',
    plugins: '智囊团',
    automation: '自动化',
    selfModify: '自我改造',
    agents: '智能体',
    browser: '浏览器',
    settings: '设置',
    section: {
      features: '功能',
      system: '系统',
    },
  },
  chat: {
    placeholder: '输入消息...',
    send: '发送',
    stopGeneration: '停止生成',
    thinking: '思考中...',
    emptyState: '开始和玄枢对话吧',
    modelLoading: '模型加载中...',
  },
  error: {
    networkError: '网络连接失败，请检查网络设置',
    modelLoadFailed: '模型加载失败，请检查模型文件',
    permissionDenied: '权限不足',
    unknown: '发生未知错误',
    crashMessage: '应用遇到问题，请尝试重启',
    reportError: '报告错误',
    goHome: '返回首页',
  },
  errorBoundary: {
    renderError: '组件渲染异常',
    viewDetail: '查看错误详情',
    reload: '重新加载',
    goHome: '回到首页',
  },
  errorDisplay: {
    detail: '错误详情',
    retry: '重试',
    report: '报告错误',
    goHome: '返回首页',
    network: '网络连接失败',
    permission: '权限不足',
    notFound: '页面不存在',
    crash: '应用遇到问题',
    timeout: '请求超时',
    unknown: '发生未知错误',
  },
  empty: {
    noFiles: '暂无文件',
    noResults: '未找到相关结果',
    noPlugins: '尚未安装插件',
    noKnowledge: '知识库为空',
    noMemories: '暂无记忆数据',
  },
  accessibility: {
    skipToContent: '跳转到主内容',
    mainNavigation: '主导航',
    closeDialog: '关闭对话框',
    expandMenu: '展开菜单',
    collapseMenu: '收起菜单',
    notification: '通知',
  },
  install: {
    certWarning: '此应用使用自签名证书，首次运行前请安装证书。',
    installCert: '安装证书',
    runAnyway: '仍要运行',
    certGuide: '证书安装指南',
  },
  home: {
    greeting: '你好，我是玄枢AI',
    selfIntro: '我是玄枢AI',
    greetingPeriod: {
      morning: '早上好',
      forenoon: '上午好',
      noon: '中午好',
      afternoon: '下午好',
      evening: '晚上好',
      night: '夜深了',
    },
    subtitle: '你的全能桌面智能助手',
    newChat: '新建对话',
    history: '对话历史',
    historyEmpty: '暂无对话',
    toggleSidebar: '切换历史栏',
    features: {
      chat: '智能对话',
      chatDesc: '多模型切换，流式输出',
      knowledge: '知识库',
      knowledgeDesc: 'RAG 增强检索，文档即问答',
      automation: '自动化',
      automationDesc: '定时任务与事件驱动',
      voice: '语音交互',
      voiceDesc: '实时语音识别与合成',
      brain: '记忆系统',
      brainDesc: '长期记忆与上下文感知',
      plugins: '智囊团',
      pluginsDesc: '内置多领域专家模型',
    },
    codeWindow: {
      code: '代码',
      preview: '预览',
      terminal: '终端',
      copy: '复制',
      copied: '已复制',
      run: '运行',
      empty: '无输出',
    },
    conversation: {
      starting: '等待模型加载...',
      error: '发送失败',
      retry: '重试',
      thinking: '思考中...',
      deleteWarning: '确定删除此对话？',
      undoDelete: '撤销删除',
      export: '导出对话',
      rename: '重命名对话',
    },
    input: {
      attach: '附加文件',
      voice: '语音输入',
      send: '发送',
      stop: '停止',
    },
  },
  knowledge: {
    title: '知识库管理',
    subtitle: '导入文档构建智能问答知识库',
    importFiles: '导入文件',
    importFolder: '导入文件夹',
    emptyTitle: '知识库为空',
    emptyDesc: '导入文档开始构建你的智能知识库',
    viewDocument: '查看文档',
    addToBase: '加入知识库',
    keywordLabel: '关键词标签',
    deleteWarning: '确定要删除此知识文档？',
    importProgress: '导入进度',
    analyzing: '分析中...',
    indexing: '索引构建中...',
    indexComplete: '索引完成',
    searchPlaceholder: '搜索知识库...',
    allCategories: '全部分类',
    documentCount: '{count} 个文档',
  },
  settings: {
    title: '设置',
    appearance: '外观',
    language: '语言',
    about: '关于',
    license: '许可证',
    dataPath: '数据路径',
    theme: '主题',
    permissions: '权限管理',
    modelManagement: '模型管理',
    languageLabel: '界面语言',
    undoChange: '撤销更改',
    saved: '设置已保存',
    reset: '恢复默认',
    resetWarning: '确定恢复所有设置为默认值？',
  },
}

const en_US: TranslationTable = {
  common: {
    appName: 'XuanShu AI',
    ok: 'OK',
    cancel: 'Cancel',
    save: 'Save',
    delete: 'Delete',
    edit: 'Edit',
    search: 'Search',
    loading: 'Loading...',
    noData: 'No Data',
    error: 'Error',
    retry: 'Retry',
    confirm: 'Confirm',
    back: 'Back',
    home: 'Home',
    settings: 'Settings',
    close: 'Close',
    undo: 'Undo',
    redo: 'Redo',
  },
  sidebar: {
    home: 'Home',
    voice: 'Voice',
    model: 'Model',
    memory: 'Memory',
    knowledge: 'Knowledge',
    plugins: 'Plugins',
    automation: 'Automation',
    selfModify: 'Self-Modify',
    agents: 'Agents',
    browser: 'Browser',
    settings: 'Settings',
    section: {
      features: 'Features',
      system: 'System',
    },
  },
  chat: {
    placeholder: 'Type a message...',
    send: 'Send',
    stopGeneration: 'Stop',
    thinking: 'Thinking...',
    emptyState: 'Start a conversation with XuanShu',
    modelLoading: 'Loading model...',
  },
  error: {
    networkError: 'Network connection failed. Please check your network settings.',
    modelLoadFailed: 'Model loading failed. Please check model files.',
    permissionDenied: 'Permission denied.',
    unknown: 'An unknown error occurred.',
    crashMessage: 'The application encountered an issue. Please try restarting.',
    reportError: 'Report Error',
    goHome: 'Go Home',
  },
  errorBoundary: {
    renderError: 'Component Render Error',
    viewDetail: 'View Error Details',
    reload: 'Reload',
    goHome: 'Go Home',
  },
  errorDisplay: {
    detail: 'Error Details',
    retry: 'Retry',
    report: 'Report Error',
    goHome: 'Go Home',
    network: 'Network Connection Failed',
    permission: 'Permission Denied',
    notFound: 'Page Not Found',
    crash: 'Application Crashed',
    timeout: 'Request Timed Out',
    unknown: 'Unknown Error',
  },
  empty: {
    noFiles: 'No files',
    noResults: 'No results found',
    noPlugins: 'No plugins installed',
    noKnowledge: 'Knowledge base is empty',
    noMemories: 'No memory data',
  },
  accessibility: {
    skipToContent: 'Skip to main content',
    mainNavigation: 'Main navigation',
    closeDialog: 'Close dialog',
    expandMenu: 'Expand menu',
    collapseMenu: 'Collapse menu',
    notification: 'Notification',
  },
  install: {
    certWarning: 'This application uses a self-signed certificate. Please install the certificate before running.',
    installCert: 'Install Certificate',
    runAnyway: 'Run Anyway',
    certGuide: 'Certificate Installation Guide',
  },
  home: {
    greeting: 'Hello, I am XuanShu AI',
    selfIntro: "I'm XuanShu AI",
    greetingPeriod: {
      morning: 'Good morning',
      forenoon: 'Good morning',
      noon: 'Good afternoon',
      afternoon: 'Good afternoon',
      evening: 'Good evening',
      night: 'Good night',
    },
    subtitle: 'Your All-in-One Desktop AI Assistant',
    newChat: 'New Chat',
    history: 'Chat History',
    historyEmpty: 'No conversations yet',
    toggleSidebar: 'Toggle sidebar',
    features: {
      chat: 'Smart Chat',
      chatDesc: 'Multi-model switching, streaming output',
      knowledge: 'Knowledge Base',
      knowledgeDesc: 'RAG-enhanced retrieval, document Q&A',
      automation: 'Automation',
      automationDesc: 'Scheduled tasks & event-driven',
      voice: 'Voice Interaction',
      voiceDesc: 'Real-time speech recognition & synthesis',
      brain: 'Memory System',
      brainDesc: 'Long-term memory & context awareness',
      plugins: 'Expert Panel',
      pluginsDesc: 'Built-in multi-domain expert models',
    },
    codeWindow: {
      code: 'Code',
      preview: 'Preview',
      terminal: 'Terminal',
      copy: 'Copy',
      copied: 'Copied',
      run: 'Run',
      empty: 'No output',
    },
    conversation: {
      starting: 'Waiting for model to load...',
      error: 'Failed to send',
      retry: 'Retry',
      thinking: 'Thinking...',
      deleteWarning: 'Delete this conversation?',
      undoDelete: 'Undo delete',
      export: 'Export conversation',
      rename: 'Rename conversation',
    },
    input: {
      attach: 'Attach file',
      voice: 'Voice input',
      send: 'Send',
      stop: 'Stop',
    },
  },
  knowledge: {
    title: 'Knowledge Base',
    subtitle: 'Import documents to build intelligent Q&A knowledge base',
    importFiles: 'Import Files',
    importFolder: 'Import Folder',
    emptyTitle: 'Knowledge Base is Empty',
    emptyDesc: 'Import documents to start building your knowledge base',
    viewDocument: 'View Document',
    addToBase: 'Add to Base',
    keywordLabel: 'Keywords',
    deleteWarning: 'Delete this knowledge document?',
    importProgress: 'Import Progress',
    analyzing: 'Analyzing...',
    indexing: 'Indexing...',
    indexComplete: 'Index Complete',
    searchPlaceholder: 'Search knowledge base...',
    allCategories: 'All Categories',
    documentCount: '{count} documents',
  },
  settings: {
    title: 'Settings',
    appearance: 'Appearance',
    language: 'Language',
    about: 'About',
    license: 'License',
    dataPath: 'Data Path',
    theme: 'Theme',
    permissions: 'Permissions',
    modelManagement: 'Model Management',
    languageLabel: 'Interface Language',
    undoChange: 'Undo Changes',
    saved: 'Settings saved',
    reset: 'Restore Defaults',
    resetWarning: 'Restore all settings to defaults?',
  },
}

const translations: Record<Locale, TranslationTable> = {
  'zh-CN': zh_CN,
  'en-US': en_US,
}

/* ==================== i18n 核心 ==================== */

function getNestedValue(obj: Record<string, unknown>, path: string): string {
  const keys = path.split('.')
  let current: unknown = obj
  for (const key of keys) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return path
    }
    current = (current as Record<string, unknown>)[key]
  }
  return typeof current === 'string' ? current : path
}

let currentLocale: Locale = 'zh-CN'

/** 获取当前语言 */
export function getLocale(): Locale {
  return currentLocale
}

/** 设置语言 */
export function setLocale(locale: Locale): void {
  currentLocale = locale
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('locale-changed', { detail: locale }))
  }
}

/** 翻译函数 */
export function t(key: string, params?: Record<string, string | number>): string {
  const table = translations[currentLocale] as Record<string, unknown>
  let result = getNestedValue(table, key)

  if (params) {
    for (const [k, v] of Object.entries(params)) {
      result = result.replace(`{${k}}`, String(v))
    }
  }

  return result
}

/** React Hook: 响应式翻译 */
export { useTranslation } from './useTranslation'
