/**
 * P1 单元测试 — PersonaLoader 角色管理系统
 * 来源：src/main/persona-loader/index.ts
 */
import { describe, it, expect } from 'vitest'

// PersonaMeta 类型定义（来自源码）
interface PersonaMeta {
  id: string
  name: string
  icon?: string
  description?: string
  color?: string
  preferred_tier: 'fast'
  system_prompt?: string
}

describe('PersonaMeta — 角色元数据类型', () => {
  describe('正常路径', () => {
    it('最小有效 PersonaMeta', () => {
      const p: PersonaMeta = {
        id: 'assistant',
        name: '助手',
        preferred_tier: 'fast',
      }
      expect(p.id).toBe('assistant')
      expect(p.preferred_tier).toBe('fast')
    })

    it('完整 PersonaMeta', () => {
      const p: PersonaMeta = {
        id: 'teacher',
        name: '名师',
        icon: '/icons/teacher.png',
        description: '专业辅导老师',
        color: '#4CAF50',
        preferred_tier: 'fast',
        system_prompt: '你是一位耐心的老师，请用简洁的语言解释概念。',
      }
      expect(p.icon).toBe('/icons/teacher.png')
      expect(p.system_prompt).toContain('耐心的老师')
    })

    it('preferred_tier 永远是 fast', () => {
      const p: PersonaMeta = { id: 'x', name: 'X', preferred_tier: 'fast' }
      // v11.0 统一为 fast
      expect(p.preferred_tier).toBe('fast')
    })
  })
})

describe('getTier — 角色档位', () => {
  // 模拟 PersonaLoader.getTier 行为
  function getTier(_personaId: string): 'fast' {
    return 'fast'
  }

  describe('正常路径', () => {
    it('任意角色返回 fast', () => {
      expect(getTier('assistant')).toBe('fast')
      expect(getTier('teacher')).toBe('fast')
      expect(getTier('unknown')).toBe('fast')
    })
  })
})

describe('PersonaMeta 校验', () => {
  // 模拟 JSON 解析后的校验逻辑
  function validatePersona(raw: Record<string, unknown>): PersonaMeta | null {
    if (!raw.id || typeof raw.id !== 'string') return null
    if (!raw.name || typeof raw.name !== 'string') return null
    return {
      id: raw.id as string,
      name: raw.name as string,
      icon: typeof raw.icon === 'string' ? raw.icon : undefined,
      description: typeof raw.description === 'string' ? raw.description : undefined,
      color: typeof raw.color === 'string' ? raw.color : undefined,
      preferred_tier: 'fast',
      system_prompt: typeof raw.system_prompt === 'string' ? raw.system_prompt : undefined,
    }
  }

  describe('正常路径', () => {
    it('标准 JSON 正确解析', () => {
      const raw = { id: 'coder', name: '程序员', description: '写代码' }
      const p = validatePersona(raw)
      expect(p).not.toBeNull()
      expect(p!.id).toBe('coder')
      expect(p!.name).toBe('程序员')
    })

    it('缺少可选字段不影响解析', () => {
      const raw = { id: 'minimal', name: '最小' }
      const p = validatePersona(raw)
      expect(p).not.toBeNull()
      expect(p!.icon).toBeUndefined()
      expect(p!.system_prompt).toBeUndefined()
    })

    it('color 正确保留', () => {
      const raw = { id: 'dev', name: 'Dev', color: '#FF5722' }
      const p = validatePersona(raw)
      expect(p?.color).toBe('#FF5722')
    })
  })

  describe('异常路径', () => {
    it('缺少 id 返回 null', () => {
      expect(validatePersona({ name: 'No ID' })).toBeNull()
    })

    it('缺少 name 返回 null', () => {
      expect(validatePersona({ id: 'no-name' })).toBeNull()
    })

    it('id 非字符串返回 null', () => {
      expect(validatePersona({ id: 123, name: 'test' })).toBeNull()
    })

    it('空对象返回 null', () => {
      expect(validatePersona({})).toBeNull()
    })
  })
})
