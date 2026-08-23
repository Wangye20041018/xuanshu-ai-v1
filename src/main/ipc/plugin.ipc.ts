import { ipcMain, dialog } from 'electron'
import { pluginEngine, Plugin } from '../plugin-engine'
import { logger } from '../../shared/logger'

export function setupPluginHandlers(): void {
  /* ==================== 列出所有插件及状态 ==================== */
  ipcMain.handle('plugin:list', () => {
    try {
      return pluginEngine.listPlugins()
    } catch (error) {
      logger.error('plugin:list error:', error)
      return []
    }
  })

  /* ==================== 启用/禁用插件 ==================== */
  ipcMain.handle('plugin:toggle', (_event, pluginId: string) => {
    try {
      const result = pluginEngine.togglePlugin(pluginId)
      return { success: result }
    } catch (error) {
      logger.error('plugin:toggle 内部错误:', error)
      return { success: false, error: '插件操作遇到内部错误' }
    }
  })

  /* ==================== 执行插件 ==================== */
  ipcMain.handle('plugin:execute', async (_event, pluginId: string, params: Record<string, any>) => {
    try {
      const result = await pluginEngine.executePlugin(pluginId, params)
      return result
    } catch (error) {
      logger.error('plugin:execute 内部错误:', error)
      return { success: false, error: '插件操作遇到内部错误' }
    }
  })

  /* ==================== 获取插件状态 ==================== */
  ipcMain.handle('plugin:status', () => {
    try {
      return pluginEngine.getPluginStatus()
    } catch (error) {
      logger.error('plugin:status error:', error)
      return { total: 0, enabled: 0, disabled: 0, plugins: [] }
    }
  })

  /* ==================== 获取 SGLang Function Calling 工具列表 ==================== */
  ipcMain.handle('plugin:tools', () => {
    try {
      return pluginEngine.getToolDefinitions()
    } catch (error) {
      logger.error('plugin:tools error:', error)
      return []
    }
  })

  /* ==================== 注册自定义插件 ==================== */
  ipcMain.handle('plugin:register', (_event, plugin: Plugin) => {
    try {
      const result = pluginEngine.registerPlugin(plugin)
      return { success: result }
    } catch (error) {
      logger.error('plugin:register 内部错误:', error)
      return { success: false, error: '插件操作遇到内部错误' }
    }
  })

  /* ==================== 卸载插件 ==================== */
  ipcMain.handle('plugin:unregister', (_event, pluginId: string) => {
    try {
      const result = pluginEngine.unregisterPlugin(pluginId)
      return { success: result }
    } catch (error) {
      logger.error('plugin:unregister 内部错误:', error)
      return { success: false, error: '插件操作遇到内部错误' }
    }
  })

  /* ==================== 兼容旧接口 ==================== */
  ipcMain.handle('plugin:create', async (_event, name: string, description: string) => {
    try {
      const newPlugin: Plugin = {
        id: `custom-${Date.now()}`,
        name,
        description,
        version: '0.1.0',
        icon: 'zap',
        enabled: false,
        createdAt: Date.now(),
        toolDefinition: {
          type: 'function',
          function: {
            name: name.replace(/\s+/g, '_').toLowerCase(),
            description,
            parameters: {
              type: 'object',
              properties: {
                action: { type: 'string', description: '操作类型' }
              },
              required: ['action']
            }
          }
        }
      }
      const registered = pluginEngine.registerPlugin(newPlugin)
      return registered ? newPlugin : { error: '注册失败' }
    } catch (error) {
      logger.error('plugin:create 内部错误:', error)
      return { error: '插件操作遇到内部错误' }
    }
  })

  ipcMain.handle('plugin:delete', (_event, pluginId: string) => {
    try {
      const result = pluginEngine.unregisterPlugin(pluginId)
      return result
    } catch (error) {
      logger.error('plugin:delete error:', error)
      return false
    }
  })

  ipcMain.handle('plugin:toggle-auto', (_event, _pluginId: string) => {
    try {
      // 自动激活功能已合并到 toggle 中
      return true
    } catch (error) {
      logger.error('plugin:toggle-auto error:', error)
      return false
    }
  })

  ipcMain.handle('plugin:generate-code', async (_event, requirements: string) => {
    try {
      const result = await pluginEngine.generatePlugin(requirements)
      return result
    } catch (error) {
      logger.error('plugin:generate-code 内部错误:', error)
      return { success: false, error: '插件操作遇到内部错误' }
    }
  })

  /* ==================== AI 动态生成插件 ==================== */
  ipcMain.handle('plugin:generate', async (_event, requirements: string) => {
    try {
      const result = await pluginEngine.generatePlugin(requirements)
      return result
    } catch (error) {
      logger.error('plugin:generate 内部错误:', error)
      return { success: false, error: '插件操作遇到内部错误' }
    }
  })

  /* ==================== 打开文件选择框 ==================== */
  ipcMain.handle('dialog:open', async (_event, options: Electron.OpenDialogOptions) => {
    try {
      const result = await dialog.showOpenDialog(options || {})
      return { canceled: result.canceled, filePaths: result.filePaths }
    } catch (error) {
      logger.error('dialog:open error:', error)
      return { canceled: true, filePaths: [] }
    }
  })

  /* ==================== 从本地文件安装插件 ==================== */
  ipcMain.handle('plugin:install', async (_event, filePath: string) => {
    try {
      return await pluginEngine.installFromFile(filePath)
    } catch (error) {
      logger.error('plugin:install 内部错误:', error)
      return { success: false, error: '插件安装遇到内部错误' }
    }
  })

  /* ==================== 插件商店列表（未开通，明确禁用提示） ==================== */
  ipcMain.handle('plugin:store-list', () => {
    return { plugins: [], storeUnavailable: true }
  })
}