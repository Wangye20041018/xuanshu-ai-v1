import { useEffect, useState } from 'react'
import { Save, RotateCcw, Sparkles } from 'lucide-react'
import { COLORS, GlassCard } from './index'
import { DEFAULT_QUICK_ACTIONS, type QuickActionsConfig } from '../Home/QuickActions'

/**
 * 首页快捷指令面板（B9）
 * 预指令不再写死：在此增删改药丸快捷指令与功能卡片，保存后写入配置，
 * 回到首页即按新配置渲染（config:get 每次挂载读取，即时生效）。
 */
export default function SettingsQuickActions() {
  const [pillsText, setPillsText] = useState('')
  const [cardsText, setCardsText] = useState('')
  const [flash, setFlash] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  const load = async () => {
    try {
      const cfg = await window.api.invoke<QuickActionsConfig>('config:get', 'homeQuickActions')
      const base = cfg && Array.isArray(cfg.pills) && Array.isArray(cfg.cards)
        ? cfg
        : DEFAULT_QUICK_ACTIONS
      setPillsText(base.pills.join('\n'))
      setCardsText(base.cards.map((c) => `${c.title}|${c.desc}|${c.hint}`).join('\n'))
    } catch {
      setPillsText(DEFAULT_QUICK_ACTIONS.pills.join('\n'))
      setCardsText(DEFAULT_QUICK_ACTIONS.cards.map((c) => `${c.title}|${c.desc}|${c.hint}`).join('\n'))
    }
  }

  useEffect(() => { load() }, [])

  const show = (type: 'success' | 'error', text: string) => {
    setFlash({ type, text })
    setTimeout(() => setFlash(null), 2200)
  }

  const save = async () => {
    const pills = pillsText.split('\n').map((s) => s.trim()).filter(Boolean)
    const cards = cardsText.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
      const [title = '', desc = '', hint = ''] = line.split('|').map((s) => s.trim())
      return { title, desc, hint }
    }).filter((c) => c.title && c.hint)
    if (pills.length === 0 && cards.length === 0) {
      show('error', '至少保留一条指令')
      return
    }
    const cfg: QuickActionsConfig = { pills: pills.slice(0, 12), cards: cards.slice(0, 8) }
    await window.api.invoke('config:set', 'homeQuickActions', cfg)
    show('success', '已保存，回到首页即可生效')
  }

  const reset = async () => {
    await window.api.invoke('config:set', 'homeQuickActions', DEFAULT_QUICK_ACTIONS)
    await load()
    show('success', '已恢复默认指令')
  }

  return (
    <GlassCard
      title="首页快捷指令"
      icon={<Sparkles size={18} />}
      accentColor={COLORS.violet}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ fontSize: 11, color: COLORS.textMuted, lineHeight: 1.5 }}>
          首页问候语下方的预指令从此处按真实需求调整，每行一条；保存后回到首页即时生效。
        </div>

        <div>
          <div style={{ fontSize: 12, fontWeight: 600, color: COLORS.textPrimary, marginBottom: 6 }}>
            快捷指令（药丸标签）
          </div>
          <textarea
            value={pillsText}
            onChange={(e) => setPillsText(e.target.value)}
            rows={4}
            placeholder={'每行一条，例如：\n写周报\n翻译英文'}
            style={{
              width: '100%', boxSizing: 'border-box', resize: 'vertical',
              padding: '10px 12px', borderRadius: 10,
              background: 'var(--bg-input, rgba(255,255,255,0.05))',
              border: '1px solid var(--border-default)',
              color: 'var(--text-primary)', fontSize: 13, lineHeight: 1.5,
              outline: 'none',
            }}
          />
        </div>

        <div>
          <div style={{ fontSize: 12, fontWeight: 600, color: COLORS.textPrimary, marginBottom: 6 }}>
            功能卡片（每行：标题|描述|点击填入的提示）
          </div>
          <textarea
            value={cardsText}
            onChange={(e) => setCardsText(e.target.value)}
            rows={4}
            placeholder={'总结文档|快速提炼要点|帮我总结这段文档的要点'}
            style={{
              width: '100%', boxSizing: 'border-box', resize: 'vertical',
              padding: '10px 12px', borderRadius: 10,
              background: 'var(--bg-input, rgba(255,255,255,0.05))',
              border: '1px solid var(--border-default)',
              color: 'var(--text-primary)', fontSize: 13, lineHeight: 1.5,
              outline: 'none',
            }}
          />
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button
            onClick={save}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '8px 16px', borderRadius: 10, border: 'none',
              background: 'linear-gradient(135deg, var(--brand, #5b8cff), var(--brand2, #7c6cf0))',
              color: '#fff', fontWeight: 600, fontSize: 12, cursor: 'pointer',
            }}
          >
            <Save size={14} /> 保存
          </button>
          <button
            onClick={reset}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '8px 14px', borderRadius: 10, border: '1px solid var(--border-default)',
              background: 'transparent', color: 'var(--text-secondary)',
              fontWeight: 500, fontSize: 12, cursor: 'pointer',
            }}
          >
            <RotateCcw size={14} /> 恢复默认
          </button>
          {flash && (
            <span style={{ fontSize: 12, color: flash.type === 'success' ? '#4ade80' : '#f87171' }}>
              {flash.text}
            </span>
          )}
        </div>
      </div>
    </GlassCard>
  )
}
