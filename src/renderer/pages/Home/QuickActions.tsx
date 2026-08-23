import { FileText, Lightbulb, BarChart3, Pencil, Sparkles, MessageSquare, ListChecks, Target } from 'lucide-react'
import { motion } from 'framer-motion'
import { useEffect, useState } from 'react'

export interface QuickActionCard {
  title: string
  desc: string
  hint: string
}

export interface QuickActionsConfig {
  /** 药丸快捷指令（B9：数量精简、配置驱动，可在设置页按需增删改） */
  pills: string[]
  /** 功能卡片 */
  cards: QuickActionCard[]
}

/** 默认预指令（仅作兜底，真实内容从配置读取） */
export const DEFAULT_QUICK_ACTIONS: QuickActionsConfig = {
  pills: ['写周报', '翻译英文', '写代码', '头脑风暴'],
  cards: [
    { title: '总结文档', desc: '快速提炼要点', hint: '帮我总结这段文档的要点' },
    { title: '头脑风暴', desc: '激发创意灵光', hint: '帮我想一些创意点子' },
    { title: '分析数据', desc: '洞察深层规律', hint: '帮我分析这组数据' },
    { title: '撰写内容', desc: '生成专业文稿', hint: '帮我写一篇专业文章' },
  ],
}

const ICON_POOL = [FileText, Lightbulb, BarChart3, Pencil, Sparkles, MessageSquare, ListChecks, Target]

interface QuickActionsProps {
  setInput: (value: string) => void
}

export default function QuickActions({ setInput }: QuickActionsProps) {
  const [cfg, setCfg] = useState<QuickActionsConfig>(DEFAULT_QUICK_ACTIONS)

  // B9：预指令从配置读取（config:get('homeQuickActions')），未配置时使用精简默认值
  useEffect(() => {
    if (!window.api) return
    window.api
      .invoke<QuickActionsConfig>('config:get', 'homeQuickActions')
      .then((saved) => {
        if (saved && Array.isArray(saved.pills) && Array.isArray(saved.cards)) {
          setCfg({ pills: saved.pills.slice(0, 12), cards: saved.cards.slice(0, 8) })
        }
      })
      .catch(() => { /* 读取失败使用默认值 */ })
  }, [])

  const pills = cfg.pills.length > 0 ? cfg.pills : DEFAULT_QUICK_ACTIONS.pills
  const cards = cfg.cards.length > 0 ? cfg.cards : DEFAULT_QUICK_ACTIONS.cards

  return (
    <>
      {/* 快捷提示 — 药丸标签（配置驱动） */}
      {pills.length > 0 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center', marginBottom: 16 }}>
          {pills.map((hint) => (
            <motion.button
              key={hint}
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              onClick={() => setInput(hint)}
              style={{
                padding: '6px 14px',
                borderRadius: 'var(--radius-full)',
                background: 'var(--bg-elevated)',
                border: '1px solid var(--border-default)',
                cursor: 'pointer',
                color: 'var(--text-secondary)',
                fontSize: 13,
                whiteSpace: 'nowrap',
              }}
            >
              {hint}
            </motion.button>
          ))}
        </div>
      )}

      {/* 功能卡片（配置驱动） */}
      {cards.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, maxWidth: 640 }}>
          {cards.map((card, idx) => {
            const Icon = ICON_POOL[idx % ICON_POOL.length] || FileText
            return (
              <motion.button
                key={card.title + idx}
                whileHover={{ scale: 1.02, y: -2 }}
                whileTap={{ scale: 0.98 }}
                onClick={() => setInput(card.hint)}
                style={{
                  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
                  padding: '16px 10px',
                  background: 'var(--bg-elevated)',
                  border: '1px solid var(--border-default)',
                  borderRadius: 'var(--radius-lg)',
                  cursor: 'pointer',
                  boxShadow: 'var(--shadow-card)',
                }}
              >
                <div style={{ width: 36, height: 36, borderRadius: '50%', background: 'var(--brand-dim)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--brand)' }}>
                  <Icon size={18} />
                </div>
                <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--text-primary)' }}>{card.title}</span>
                <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{card.desc}</span>
              </motion.button>
            )
          })}
        </div>
      )}
    </>
  )
}
