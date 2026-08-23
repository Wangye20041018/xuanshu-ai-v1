import { useState, useRef, useEffect, type ReactNode } from 'react'
import { Copy, Check } from 'lucide-react'
import { HEX_COLORS, COLORS } from '../../shared/theme'
import { motion } from 'framer-motion'
import { safeCopyToClipboard } from '../../../shared/clipboard'

/* ========== 内容块类型 ========== */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'code'; code: string; language: string | null }
  | { type: 'table'; headers: string[]; rows: string[][] }
  | { type: 'file'; path: string }
  | { type: 'image'; path: string }
  | { type: 'video'; path: string }

/* ========== 联动模式类型 ========== */
export type TandemMode = 'dual' | 'partner' | 'mentor' | 'debate'

export const TANDEM_COLORS: Record<string, string> = {
  dual: COLORS.brand,
  partner: COLORS.violet,
  mentor: COLORS.warning,
  debate: COLORS.dangerAlt,
}

/* ========== Markdown 表格辅助 ========== */
export function isTableRow(line: string): boolean {
  const t = line.trim()
  return t.startsWith('|') && t.endsWith('|') && t.length > 1
}
export function splitRow(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(s => s.trim())
}
export function isSeparatorRow(line: string): boolean {
  const t = line.trim()
  return isTableRow(t) && t.includes('-') && /^[\s:\-|]+$/.test(t)
}

/* ========== 行内 [文件:]/[图片:]/[视频:] 占位识别 ========== */
export function classifyInline(text: string): ContentBlock[] {
  const result: ContentBlock[] = []
  const regex = /\[(?:文件|图片|视频|音频):([^\]]+)\]/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = regex.exec(text)) !== null) {
    if (m.index > last) {
      const t = text.slice(last, m.index)
      if (t.trim()) result.push({ type: 'text', text: t })
    }
    const raw = m[0]
    const kind = raw.startsWith('[文件') ? 'file' : raw.startsWith('[图片') ? 'image' : raw.startsWith('[视频') ? 'video' : 'audio'
    result.push({ type: kind, path: m[1].trim() } as any)
    last = regex.lastIndex
  }
  if (last < text.length) {
    const t = text.slice(last)
    if (t.trim()) result.push({ type: 'text', text: t })
  }
  return result
}

/* ========== 解析消息内容为结构化块（代码 / 表格 / 文件卡片 / 文本） ========== */
export function parseMessageContent(content: string): ContentBlock[] {
  const blocks: ContentBlock[] = []
  // C-17 修复：优先匹配三反引号，兼容双反引号
  // 分支1: ```lang\n code ```  分支2: ``lang\n code ``
  const codeRegex = /```(\w*)\n?([\s\S]*?)```|``(\w*)\n?([\s\S]*?)``/g
  let last = 0
  let m: RegExpExecArray | null
  const segments: string[] = []
  while ((m = codeRegex.exec(content)) !== null) {
    if (m.index > last) segments.push(content.slice(last, m.index))
    const language = m[1] ?? m[3] ?? null
    const code = (m[2] ?? m[4] ?? '').trim()
    blocks.push({ type: 'code', code, language: language || null })
    last = codeRegex.lastIndex
  }
  if (last < content.length) segments.push(content.slice(last))

  for (const seg of segments) {
    const lines = seg.split('\n')
    let i = 0
    while (i < lines.length) {
      const line = lines[i]
      if (isTableRow(line) && i + 1 < lines.length && isSeparatorRow(lines[i + 1])) {
        const headers = splitRow(line)
        const rows: string[][] = []
        i += 2
        while (i < lines.length && isTableRow(lines[i])) {
          rows.push(splitRow(lines[i]))
          i++
        }
        blocks.push({ type: 'table', headers, rows })
      } else {
        let j = i
        const buf: string[] = []
        while (j < lines.length && !(isTableRow(lines[j]) && j + 1 < lines.length && isSeparatorRow(lines[j + 1]))) {
          buf.push(lines[j])
          j++
        }
        const text = buf.join('\n')
        if (text.trim()) blocks.push(...classifyInline(text))
        i = j
      }
    }
  }
  return blocks
}

/* ========== 行内加粗渲染（**bold** / <strong>） ========== */
export function renderInlineFormatted(text: string): ReactNode {
  const nodes: ReactNode[] = []
  const regex = /\*\*(.+?)\*\*|<strong>(.+?)<\/strong>/g
  let last = 0
  let m: RegExpExecArray | null
  let key = 0
  while ((m = regex.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index))
    const bold = m[1] ?? m[2]
    nodes.push(<strong key={key++} style={{ fontWeight: 700 }}>{bold}</strong>)
    last = regex.lastIndex
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

/* ========== 表格卡片 ========== */
export function TableCard({ headers, rows }: { headers: string[]; rows: string[][] }) {
  return (
    <div style={{ marginTop: 6, borderRadius: 'var(--radius-md)', border: '1px solid var(--border-subtle)', overflow: 'hidden', background: 'var(--bg-elevated)' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr>
            {headers.map((h, i) => (
              <th key={i} style={{ textAlign: 'left', padding: '8px 12px', color: 'var(--text-secondary)', fontWeight: 600, borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-surface)' }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr key={ri} style={{ background: ri % 2 === 1 ? 'var(--bg-surface)' : 'transparent' }}>
              {row.map((cell, ci) => (
                <td key={ci} style={{ padding: '8px 12px', color: 'var(--text-primary)', borderBottom: ri < rows.length - 1 ? '1px solid var(--border-subtle)' : 'none' }}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/* ========== 头像组件 ========== */
export function UserAvatar() {
  return (
    <div style={{
      width: 32, height: 32, borderRadius: '50%', flexShrink: 0,
      background: COLORS.bg,
    }} />
  )
}

/* ========== 等待动效 ========== */
export function TypingDots() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
      style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '0 0 4px' }}
    >
      <div style={{
        padding: '12px 18px', borderRadius: 'var(--radius-lg)',
        background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)',
        display: 'flex', alignItems: 'center', gap: 5,
      }}>
        {[0, 1, 2].map((i) => (
          <motion.span
            key={i}
            animate={{ y: [0, -4, 0], opacity: [0.4, 1, 0.4] }}
            transition={{ duration: 0.7, repeat: Infinity, delay: i * 0.15, ease: 'easeInOut' }}
            style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--brand)', display: 'inline-block' }}
          />
        ))}
      </div>
    </motion.div>
  )
}

/* ========== 代码块解析 ========== */
export function CodeWindow({ code, language, isStreaming }: { code: string; language: string | null; isStreaming?: boolean }) {
  const [copied, setCopied] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const prevStreamingRef = useRef(isStreaming)

  useEffect(() => {
    if (prevStreamingRef.current === true && isStreaming === false) {
      const timer = setTimeout(() => setCollapsed(true), 1500)
      return () => clearTimeout(timer)
    }
    if (isStreaming) setCollapsed(false)
    prevStreamingRef.current = isStreaming
  }, [isStreaming])

  const handleCopy = () => {
    safeCopyToClipboard(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const lines = code.split('\n')

  return (
    <motion.div
      initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: collapsed ? 36 : 'auto' }}
      transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
      style={{ marginTop: 6, borderRadius: 'var(--radius-md)', background: 'var(--bg-base)', border: '1px solid var(--border-subtle)', overflow: 'hidden' }}
    >
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '6px 12px', background: 'var(--bg-surface)',
        borderBottom: collapsed ? 'none' : '1px solid var(--border-subtle)', cursor: 'pointer',
      }} onClick={() => setCollapsed(!collapsed)}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#ff5f56' }} />
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#ffbd2e' }} />
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#27c93f' }} />
          <span style={{ fontSize: 11, color: 'var(--text-tertiary)', marginLeft: 6, fontFamily: 'var(--font-mono)' }}>
            {language || 'code'}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <button onClick={(e) => { e.stopPropagation(); handleCopy() }}
            className="btn btn-ghost btn-sm" style={{ fontSize: 11, gap: 3, padding: '2px 8px' }}>
            {copied ? <><Check size={11} /> 已复制</> : <><Copy size={11} /> 复制</>}
          </button>
          <span style={{ color: 'var(--text-tertiary)', fontSize: 11, cursor: 'pointer' }}>
            {collapsed ? '展开' : '收起'}
          </span>
        </div>
      </div>
      {!collapsed && (
        <div style={{ padding: '12px', overflow: 'auto', maxHeight: 320 }}>
          <pre style={{ margin: 0, fontSize: 12, lineHeight: 1.7, fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)', whiteSpace: 'pre-wrap' }}>
            <code>
              {lines.map((line, i) => (
                <div key={i} style={{ display: 'flex' }}>
                  <span style={{ color: 'var(--text-disabled)', marginRight: 12, minWidth: 20, textAlign: 'right', userSelect: 'none', flexShrink: 0, fontSize: 11 }}>
                    {i + 1}
                  </span>
                  <span style={{ flex: 1 }}>{line || ' '}</span>
                </div>
              ))}
            </code>
          </pre>
        </div>
      )}
    </motion.div>
  )
}

/* ========== 联动结果卡片 ========== */
export function TandemResultCard({ content }: { content: string }) {
  let parsed: any
  try { parsed = JSON.parse(content) } catch { return <div style={{ color: 'var(--text-secondary)', fontSize: 13 }}>{content}</div> }
  if (!parsed?._tandem || !parsed?.success) {
    return <div style={{ color: 'var(--text-secondary)', fontSize: 13 }}>{content}</div>
  }

  const mode = parsed.mode as string
  const borderColor = TANDEM_COLORS[mode] || 'var(--border-subtle)'

  return (
    <div style={{
      border: `1px solid ${borderColor}30`, borderRadius: 'var(--radius-xl)',
      background: 'var(--bg-elevated)', overflow: 'hidden', maxWidth: '100%',
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '10px 16px', borderBottom: `1px solid ${borderColor}20`,
      }}>
        <span style={{
          fontSize: 11, padding: '2px 8px', borderRadius: 6,
          background: `${borderColor}20`, color: borderColor, fontWeight: 600,
        }}>
          {mode === 'dual' ? '双答案' : mode === 'partner' ? '搭档' : mode === 'mentor' ? '师徒' : '辩论'}
        </span>
      </div>

      {(mode === 'dual' || mode === 'partner') && parsed.results && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 0 }}>
          {parsed.results.map((r: any, i: number) => (
            <div key={i} style={{
              padding: '12px 16px', borderRight: i === 0 ? `1px solid var(--border-subtle)` : 'none',
            }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 8 }}>
                {r.modelName}
                <span style={{ fontSize: 10, color: 'var(--text-tertiary)', marginLeft: 8, fontWeight: 400 }}>
                  {r.elapsedMs > 0 ? `${(r.elapsedMs / 1000).toFixed(1)}s` : 'N/A'}
                </span>
              </div>
              <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6, whiteSpace: 'pre-wrap', maxHeight: 260, overflowY: 'auto' }}>
                {r.content || '(无输出)'}
              </div>
            </div>
          ))}
        </div>
      )}

      {mode === 'mentor' && parsed.result && (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 0 }}>
            {['draft', 'verified'].map((key, i) => {
              const r = parsed.result[key]
              if (!r) return null
              return (
                <div key={key} style={{
                  padding: '12px 16px', borderRight: i === 0 ? `1px solid var(--border-subtle)` : 'none',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                    <span style={{
                      fontSize: 10, padding: '2px 6px', borderRadius: 5,
                      background: i === 0 ? `${HEX_COLORS.warning}33` : `${HEX_COLORS.successAlt}33`,
                      color: i === 0 ? COLORS.warning : COLORS.successAlt,
                    }}>{i === 0 ? '学徒草稿' : '导师校验'}</span>
                    <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>{r.modelName}</span>
                    <span style={{ fontSize: 10, color: 'var(--text-tertiary)' }}>
                      {r.elapsedMs > 0 ? `${(r.elapsedMs / 1000).toFixed(1)}s` : ''}
                    </span>
                  </div>
                  <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6, whiteSpace: 'pre-wrap', maxHeight: 220, overflowY: 'auto' }}>
                    {r.content || '(无输出)'}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {mode === 'debate' && parsed.result && parsed.result.rounds && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
          {parsed.result.rounds.map((round: any, ri: number) => (
            <div key={ri} style={{
              padding: '12px 16px',
              borderBottom: ri < parsed.result.rounds.length - 1 ? `1px solid var(--border-subtle)` : 'none',
            }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: borderColor, marginBottom: 8 }}>
                第 {round.index} 轮
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                {[
                  { side: round.sideA, label: '正方' },
                  { side: round.sideB, label: '反方' },
                ].map(({ side, label }, j) => (
                  <div key={j} style={{
                    padding: '8px 12px', borderRadius: 8,
                    background: j === 0 ? `${HEX_COLORS.violet}08` : `${HEX_COLORS.dangerAlt}08`,
                    border: `1px solid ${j === 0 ? '#6366f120' : '#ef444420'}`,
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                      <span style={{ fontSize: 11, fontWeight: 600, color: j === 0 ? COLORS.violet : COLORS.dangerAlt }}>
                        {label} · {side.modelName}
                      </span>
                      <span style={{ fontSize: 10, color: 'var(--text-tertiary)' }}>
                        {side.elapsedMs > 0 ? `${(side.elapsedMs / 1000).toFixed(1)}s` : ''}
                      </span>
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5, whiteSpace: 'pre-wrap', maxHeight: 150, overflowY: 'auto' }}>
                      {side.content || '(无输出)'}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/* ========== 动画变体 ========== */
// L-12 修复：键名与使用处（ChatPanel initial="hidden" animate="visible"）对齐
export const messageVariants = {
  hidden: { opacity: 0, y: 12 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.35, ease: [0.16, 1, 0.3, 1] } },
  exit: { opacity: 0, transition: { duration: 0.2 } }
}

/* ========== 时间问候 ========== */
// 依据本地小时划分时段，返回语义完整、可国际化的问候语。
// 时段键与 i18n 表的 home.greetingPeriod.* 一一对应，语言切换时随之本地化。
const GREETING_PERIOD_KEYS = ['morning', 'forenoon', 'noon', 'afternoon', 'evening', 'night'] as const

export type GreetingPeriodKey = (typeof GREETING_PERIOD_KEYS)[number]

export function getGreetingPeriodKey(hour = new Date().getHours()): GreetingPeriodKey {
  if (hour < 5) return 'night'
  if (hour < 9) return 'morning'
  if (hour < 12) return 'forenoon'
  if (hour < 14) return 'noon'
  if (hour < 18) return 'afternoon'
  if (hour < 22) return 'evening'
  return 'night'
}

export function getGreeting(t: (key: string) => string): string {
  const periodKey = getGreetingPeriodKey()
  const period = t(`home.greetingPeriod.${periodKey}`)
  return `${period}，${t('home.selfIntro')}`
}
