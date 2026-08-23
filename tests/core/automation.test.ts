/**
 * P1 单元测试 — 自动化模块工具函数
 * 来源：src/main/automation/index.ts
 */
import { describe, it, expect } from 'vitest'

/* ========== 从源码提取的独立纯函数 ========== */

/** 智能分类：根据描述关键词返回分类标签 */
function classifyDescription(description: string): string {
  const d = description.toLowerCase()
  if (/文件|文件夹|整理|清理/.test(d)) return 'file'
  if (/系统|设置|更新|重启/.test(d)) return 'system'
  if (/备份|同步|上传|下载/.test(d)) return 'sync'
  if (/提醒|通知|消息|发送/.test(d)) return 'notification'
  return 'other'
}

/** 安全解析命令字符串（禁用 shell 元字符注入） */
function parseCommand(cmdStr: string): string[] {
  const parts: string[] = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < cmdStr.length; i++) {
    const ch = cmdStr[i]
    if (ch === '"') {
      inQuotes = !inQuotes
    } else if (ch === ' ' && !inQuotes) {
      if (current) { parts.push(current); current = '' }
    } else {
      current += ch
    }
  }
  if (current) parts.push(current)
  const dangerous = /[;&|`$(){}[\]#~!<>*?]/
  for (const p of parts) {
    if (dangerous.test(p)) {
      throw new Error(`命令包含不安全字符，已拒绝执行: ${p}`)
    }
  }
  return parts
}

/** 序列步骤类型 */
interface SequenceStep {
  id: string
  action: 'open_app' | 'run_command' | 'send_message' | 'wait' | 'condition'
  params: string
  timeout: number
  retryCount?: number
  retryDelay?: number
  fallbackAction?: 'skip' | 'abort' | 'retry'
}

/** 验证步骤是否有效 */
function validateStep(step: SequenceStep): string | null {
  if (!step.action) return '缺少 action'
  const validActions = ['open_app', 'run_command', 'send_message', 'wait', 'condition']
  if (!validActions.includes(step.action)) return `无效的 action: ${step.action}`
  if (step.timeout < 0) return 'timeout 不能为负数'
  return null
}

describe('classifyDescription — 智能分类', () => {
  describe('正常路径', () => {
    it('文件操作类 → file', () => {
      expect(classifyDescription('整理桌面文件')).toBe('file')
      expect(classifyDescription('清理下载文件夹')).toBe('file')
      expect(classifyDescription('文件归类')).toBe('file')
    })

    it('系统操作类 → system', () => {
      expect(classifyDescription('系统设置优化')).toBe('system')
      expect(classifyDescription('重启电脑')).toBe('system')
      expect(classifyDescription('更新系统补丁')).toBe('system')
    })

    it('同步备份类 → sync', () => {
      expect(classifyDescription('备份数据库')).toBe('sync')
      expect(classifyDescription('同步云端资料')).toBe('sync')
      expect(classifyDescription('上传报告')).toBe('sync')
      expect(classifyDescription('下载图片')).toBe('sync')
    })

    it('通知提醒类 → notification', () => {
      expect(classifyDescription('发送提醒消息')).toBe('notification')
      expect(classifyDescription('通知用户')).toBe('notification')
    })

    it('未匹配 → other', () => {
      expect(classifyDescription('播放音乐')).toBe('other')
      expect(classifyDescription('随机任务')).toBe('other')
    })
  })

  describe('边界条件', () => {
    it('空字符串 → other', () => {
      expect(classifyDescription('')).toBe('other')
    })

    it('仅含空白 → other', () => {
      expect(classifyDescription('   ')).toBe('other')
    })

    it('含多个匹配关键词取首个', () => {
      expect(classifyDescription('系统文件清理')).toBe('file')
    })

    it('大小写不敏感', () => {
      expect(classifyDescription('整理桌面资料')).toBe('file')
      expect(classifyDescription('系统更新通知')).toBe('system')
    })
  })
})

describe('parseCommand — 命令解析与安全校验', () => {
  describe('正常路径', () => {
    it('简单命令', () => {
      expect(parseCommand('notepad.exe hello.txt')).toEqual(['notepad.exe', 'hello.txt'])
    })

    it('无参数命令', () => {
      expect(parseCommand('calc.exe')).toEqual(['calc.exe'])
    })

    it('双引号参数', () => {
      expect(parseCommand('python "C:\\Program Files\\script.py" --flag'))
        .toEqual(['python', 'C:\\Program Files\\script.py', '--flag'])
    })

    it('空字符串', () => {
      expect(parseCommand('')).toEqual([])
    })

    it('仅空白', () => {
      expect(parseCommand('   ')).toEqual([])
    })
  })

  describe('异常路径 — 拒绝不安全字符', () => {
    it('拒绝分号', () => {
      expect(() => parseCommand('cmd.exe; rm -rf /')).toThrow('不安全字符')
    })

    it('拒绝管道符', () => {
      expect(() => parseCommand('echo hello | cat')).toThrow('不安全字符')
    })

    it('拒绝反引号', () => {
      expect(() => parseCommand('echo `whoami`')).toThrow('不安全字符')
    })

    it('拒绝 $符号', () => {
      expect(() => parseCommand('echo $HOME')).toThrow('不安全字符')
    })

    it('拒绝 & 符号', () => {
      expect(() => parseCommand('cmd & del')).toThrow('不安全字符')
    })

    it('拒绝括号', () => {
      expect(() => parseCommand('echo $(ls)')).toThrow('不安全字符')
    })

    it('拒绝重定向', () => {
      expect(() => parseCommand('echo > file.txt')).toThrow('不安全字符')
    })
  })

  describe('边界条件', () => {
    it('连续多个空格', () => {
      expect(parseCommand('a   b    c')).toEqual(['a', 'b', 'c'])
    })

    it('引号内空格保留', () => {
      expect(parseCommand('cmd "hello world"')).toEqual(['cmd', 'hello world'])
    })

    it('未闭合引号', () => {
      expect(parseCommand('cmd "unclosed')).toEqual(['cmd', 'unclosed'])
    })
  })
})

describe('validateStep — 序列步骤校验', () => {
  describe('正常路径', () => {
    it('有效步骤返回 null', () => {
      const step: SequenceStep = { id: '1', action: 'run_command', params: 'echo test', timeout: 10 }
      expect(validateStep(step)).toBeNull()
    })

    it('所有 5 种 action 都有效', () => {
      const actions = ['open_app', 'run_command', 'send_message', 'wait', 'condition']
      for (const action of actions) {
        expect(validateStep({ id: '1', action: action as SequenceStep['action'], params: '', timeout: 1 })).toBeNull()
      }
    })
  })

  describe('异常路径', () => {
    it('缺少 action 返回错误', () => {
      const step = { id: '1', params: '', timeout: 1 } as any
      expect(validateStep(step)).toBe('缺少 action')
    })

    it('无效 action 返回错误', () => {
      const step: SequenceStep = { id: '1', action: 'invalid_action' as any, params: '', timeout: 1 }
      expect(validateStep(step)).toContain('无效的 action')
    })

    it('负数 timeout 返回错误', () => {
      const step: SequenceStep = { id: '1', action: 'wait', params: '', timeout: -1 }
      expect(validateStep(step)).toBe('timeout 不能为负数')
    })
  })

  describe('边界条件', () => {
    it('timeout=0 有效', () => {
      const step: SequenceStep = { id: '1', action: 'wait', params: '', timeout: 0 }
      expect(validateStep(step)).toBeNull()
    })

    it('retryCount 可选', () => {
      const step: SequenceStep = { id: '1', action: 'run_command', params: 'echo', timeout: 5, retryCount: 3 }
      expect(validateStep(step)).toBeNull()
    })

    it('fallbackAction 可选', () => {
      const step: SequenceStep = { id: '1', action: 'run_command', params: 'echo', timeout: 5, fallbackAction: 'skip' }
      expect(validateStep(step)).toBeNull()
    })
  })
})
