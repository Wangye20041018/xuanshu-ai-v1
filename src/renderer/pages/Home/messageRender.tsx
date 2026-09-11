import { useState, useRef, useEffect, useMemo, type ReactNode } from 'react'
import { Copy, Check, ChevronDown, Code2, Loader2, User, Brain } from 'lucide-react'
import { HEX_COLORS, COLORS } from '../../shared/theme'
import { motion } from 'framer-motion'
import { safeCopyToClipboard } from '../../../shared/clipboard'
import { highlightLines, tokenColor } from '../../utils/highlightLite'

/* ========== 内容块类型 ========== */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'heading'; level: 1 | 2 | 3; text: string }
  | { type: 'code'; code: string; language: string | null }
  | { type: 'table'; headers: string[]; rows: string[][] }
  | { type: 'file'; path: string }
  | { type: 'image'; path: string }
  | { type: 'video'; path: string }

/* ========== 联动模式类型 ========== */
export type TandemMode = 'dual' | 'partner' | 'mentor' | 'debate'

/* M-20 修复：TANDEM_COLORS 为非组件常量，与 React 组件混在同一文件导出会触发
   vite hmr "TANDEM_COLORS export is incompatible" 警告；该常量仅在模块内部使用，
   改为非导出 const 消除 HMR 兼容性告警。 */
const TANDEM_COLORS: Record<string, string> = {
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
        // v3 长回答分节：把 markdown 标题行（#/##/###）单独切出为 heading 块
        const flushBuf = () => {
          const text = buf.join('\n')
          if (text.trim()) blocks.push(...classifyInline(text))
          buf.length = 0
        }
        while (j < lines.length && !(isTableRow(lines[j]) && j + 1 < lines.length && isSeparatorRow(lines[j + 1]))) {
          const hm = /^(#{1,3})\s+(.+)$/.exec(lines[j])
          if (hm) {
            flushBuf()
            blocks.push({ type: 'heading', level: hm[1].length as 1 | 2 | 3, text: hm[2].replace(/#+\s*$/, '').trim() })
          } else {
            buf.push(lines[j])
          }
          j++
        }
        flushBuf()
        i = j
      }
    }
  }
  return blocks
}

/* ========== 链接徽章（自动 favicon / 类型图标） ========== */
const URL_RE = /(https?:\/\/[^\s<>()[\]]+|www\.[^\s<>()[\]]+)/g
const MD_LINK_RE = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g

function hostOf(url: string): string {
  try { return new URL(url.startsWith('www.') ? `https://${url}` : url).hostname } catch { return url }
}

function LinkBadge({ href, label }: { href: string; label: string }) {
  const host = hostOf(href)
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => e.stopPropagation()}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5, verticalAlign: 'baseline',
        margin: '0 2px', padding: '1px 8px 1px 4px',
        borderRadius: 8, border: '1px solid var(--border-subtle)',
        background: 'var(--bg-elevated)', color: 'var(--brand)', textDecoration: 'none',
        fontSize: 12.5, maxWidth: 320, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis',
        transition: 'border-color .15s, background .15s',
      }}
      title={href}
    >
      <img
        src={`https://icons.duckduckgo.com/ip3/${host}.ico`}
        alt=""
        style={{ width: 13, height: 13, borderRadius: 3, flexShrink: 0, background: 'transparent' }}
        onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
      />
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
    </a>
  )
}

/* ========== 行内加粗渲染（**bold** / <strong> / 链接徽章） ========== */
export function renderInlineFormatted(text: string): ReactNode {
  const nodes: ReactNode[] = []
  let key = 0
  const rest = text
  // 1) 优先处理 markdown 链接 [text](url)
  let m: RegExpExecArray | null
  let idx = 0
  const segs: { raw: string; node: ReactNode }[] = []
  MD_LINK_RE.lastIndex = 0
  while ((m = MD_LINK_RE.exec(rest)) !== null) {
    if (m.index > idx) segs.push({ raw: rest.slice(idx, m.index), node: null as unknown as ReactNode })
    segs.push({ raw: '', node: <LinkBadge key={key++} href={m[2]} label={m[1] || hostOf(m[2])} /> })
    idx = MD_LINK_RE.lastIndex
  }
  if (idx < rest.length) segs.push({ raw: rest.slice(idx), node: null as unknown as ReactNode })
  // 2) 对剩余纯文本继续识别裸 URL 与加粗
  for (const seg of segs) {
    if (seg.node) { nodes.push(seg.node); continue }
    const inner = seg.raw
    URL_RE.lastIndex = 0
    let last = 0
    let u: RegExpExecArray | null
    while ((u = URL_RE.exec(inner)) !== null) {
      if (u.index > last) nodes.push(renderBold(inner.slice(last, u.index), key++))
      const url = u[0]
      const href = url.startsWith('www.') ? `https://${url}` : url
      nodes.push(<LinkBadge key={key++} href={href} label={hostOf(href)} />)
      last = URL_RE.lastIndex
    }
    if (last < inner.length) nodes.push(renderBold(inner.slice(last), key++))
  }
  return nodes
}

/** 加粗片段渲染（**bold** / <strong>）；A批7 扩展：解析模型输出的 HTML 彩色 span（color:#xxx）保留真实颜色 */
function renderBold(text: string, keyBase: number): ReactNode {
  const nodes: ReactNode[] = []
  // 1) 先切出带色 span 段，内部再做加粗/链接/裸URL递归
  const colorRegex = /<span[^>]*style=["'][^"']*color:\s*(\#[0-9a-fA-F]{3,8}|[A-Za-z]+)[^"']*["'][^>]*>([\s\S]*?)<\/span>/g
  const segs: { raw: string; node: ReactNode }[] = []
  let last = 0
  let k = 0
  let cm: RegExpExecArray | null
  while ((cm = colorRegex.exec(text)) !== null) {
    if (cm.index > last) segs.push({ raw: text.slice(last, cm.index), node: null as unknown as ReactNode })
    segs.push({
      raw: '',
      node: (
        <span key={`c-${keyBase}-${k++}`} style={{ color: cm[1] }}>
          {renderInlineFormatted(cm[2])}
        </span>
      ),
    })
    last = colorRegex.lastIndex
  }
  if (last < text.length) segs.push({ raw: text.slice(last), node: null as unknown as ReactNode })
  // 2) 对非色段（含普通整段）继续识别 **bold** / <strong>
  const regex = /\*\*(.+?)\*\*|<strong>(.+?)<\/strong>/g
  for (const seg of segs) {
    if (seg.node) { nodes.push(seg.node); continue }
    regex.lastIndex = 0
    let segLast = 0
    let m: RegExpExecArray | null
    while ((m = regex.exec(seg.raw)) !== null) {
      if (m.index > segLast) nodes.push(seg.raw.slice(segLast, m.index))
      const bold = m[1] ?? m[2]
      nodes.push(<strong key={`${keyBase}-${k++}`} style={{ fontWeight: 700 }}>{renderInlineFormatted(bold)}</strong>)
      segLast = regex.lastIndex
    }
    if (segLast < seg.raw.length) nodes.push(seg.raw.slice(segLast))
  }
  return nodes
}

/* ========== 长回答分节标题（# / ## / ###） ========== */
export function MarkdownHeading({ level, text }: { level: 1 | 2 | 3; text: string }) {
  const styleByLevel: Record<1 | 2 | 3, React.CSSProperties> = {
    1: { fontSize: 17, fontWeight: 700, margin: '18px 0 6px', color: 'var(--text-heading)', lineHeight: 1.4 },
    2: { fontSize: 15.5, fontWeight: 600, margin: '15px 0 5px', color: 'var(--text-heading)', lineHeight: 1.4 },
    3: { fontSize: 14, fontWeight: 600, margin: '12px 0 4px', color: 'var(--text-primary)', lineHeight: 1.4 },
  }
  return <div style={styleByLevel[level]}>{renderInlineFormatted(text)}</div>
}

/* ========== 表格卡片（A批7：表格/图表双视图——存在数值列时可用纯 CSS 横向条形图，零依赖、基于真实数据渲染） ========== */
export function TableCard({ headers, rows }: { headers: string[]; rows: string[][] }) {
  const [view, setView] = useState<'table' | 'chart'>('table')
  // 定位「数值列」：从第 2 列起，取首个大多数单元格可解析为数字的列（去掉千分位/百分号/货币符号）
  const numericCol = useMemo(() => {
    if (headers.length < 2 || rows.length < 1) return -1
    for (let c = 1; c < Math.min(headers.length, 8); c++) {
      let numericCount = 0
      for (const r of rows) {
        const v = r[c]
        if (v == null) continue
        const clean = String(v).trim().replace(/[,%¥$￥\s元]/g, '')
        if (clean !== '' && !Number.isNaN(Number(clean))) numericCount++
      }
      if (numericCount >= Math.max(1, rows.length * 0.6)) return c
    }
    return -1
  }, [headers, rows])
  const hasChart = numericCol >= 0
  const parseNum = (cell: string | undefined): number => {
    const clean = String(cell ?? '').replace(/[,%¥$￥\s元]/g, '')
    const n = Number(clean)
    return Number.isNaN(n) ? 0 : n
  }
  const maxVal = numericCol >= 0 ? Math.max(1, ...rows.map(r => parseNum(r[numericCol]))) : 1

  const tabBtn = (active: boolean) => ({
    background: active ? 'var(--bg-hover)' : 'transparent',
    border: 'none', cursor: 'pointer',
    color: active ? 'var(--text-primary)' : 'var(--text-tertiary)',
    fontSize: 11.5, padding: '4px 10px', borderRadius: 6, fontFamily: 'inherit',
  })

  return (
    <div style={{ marginTop: 6, borderRadius: 'var(--radius-md)', border: '1px solid var(--border-subtle)', overflow: 'hidden', background: 'var(--bg-elevated)' }}>
      {hasChart && (
        <div style={{ display: 'flex', gap: 2, padding: '6px 8px', borderBottom: '1px solid var(--border-subtle)', alignItems: 'center' }}>
          <button style={tabBtn(view === 'table')} onClick={() => setView('table')}>表格</button>
          <button style={tabBtn(view === 'chart')} onClick={() => setView('chart')}>图表</button>
        </div>
      )}
      {view === 'table' || !hasChart ? (
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
      ) : (
        <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 9 }}>
          {rows.map((row, i) => {
            const label = String(row[0] ?? `行 ${i + 1}`)
            const num = parseNum(row[numericCol])
            const pct = maxVal > 0 ? Math.max(2, Math.min(100, (num / maxVal) * 100)) : 0
            return (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ minWidth: 88, maxWidth: 140, fontSize: 12, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'right' }} title={label}>{label}</span>
                <div style={{ flex: 1, height: 16, borderRadius: 5, background: 'var(--bg-surface)', overflow: 'hidden', display: 'flex' }}>
                  <div style={{ width: `${pct}%`, borderRadius: 5, background: COLORS.brand, opacity: 0.85, transition: 'width .3s' }} />
                </div>
                <span style={{ minWidth: 50, textAlign: 'right', fontSize: 12, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>{num}</span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/* ========== 头像组件 ========== */
export function UserAvatar({ role = 'ai' }: { role?: 'ai' | 'user' }) {
  const isAi = role === 'ai'
  return (
    <div style={{
      width: 30, height: 30, borderRadius: '50%', flexShrink: 0,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      // v3：AI 头像淡蓝底+蓝边+「玄」字标识；用户头像中性抬升面+线性用户图标，均无辉光
      background: isAi ? 'var(--status-running-dim)' : 'var(--bg-elevated)',
      border: `1px solid ${isAi ? 'var(--status-running)' : 'var(--border-subtle)'}`,
      color: isAi ? 'var(--status-running)' : 'var(--text-tertiary)',
      fontSize: 12.5, fontWeight: 700, lineHeight: 1,
    }}>
      {isAi ? '玄' : <User size={14} strokeWidth={1.8} />}
    </div>
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

/* ========== 思考过程折叠区（M-3：推理可见；A批7：DeepSeek 客户端样式——大脑图标 + 「深度思考」chip + 完成标签区块） ========== */
export function ReasoningBlock({ text, streaming }: { text?: string; streaming?: boolean }) {
  const [open, setOpen] = useState(false)
  const reasoning = text ?? ''
  const hasReasoning = reasoning.trim().length > 0
  // 无推理内容时：仅「正在流式生成」显示蓝色思考中等待态；历史已结束消息直接不渲染，避免永久转圈
  if (!hasReasoning) {
    if (!streaming) return null
    return (
      <div style={{ margin: '2px 0 6px', display: 'inline-flex', alignItems: 'center', gap: 7, minHeight: 26, padding: '3px 10px', color: 'var(--text-tertiary)', fontSize: 13, borderRadius: 'var(--radius-md)', background: 'var(--bg-surface)' }}>
        <Loader2 size={13} className="animate-spin" style={{ color: 'var(--status-running)' }} />
        <span>深度思考中…</span>
      </div>
    )
  }
  return (
    <div style={{ margin: '2px 0 6px' }}>
      <button
        onClick={() => hasReasoning && setOpen(!open)}
        onMouseEnter={(e) => { if (hasReasoning) e.currentTarget.style.background = 'var(--bg-hover)' }}
        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
        style={{
          // A批7：DeepSeek 风格 —— brain 图标 +「深度思考」文字 chip，透明底、hover 抬亮
          display: 'inline-flex', alignItems: 'center', gap: 6,
          cursor: hasReasoning ? 'pointer' : 'default',
          background: 'transparent', border: 'none',
          borderRadius: 'var(--radius-md)', padding: '3px 10px', minHeight: 26,
          color: 'var(--text-tertiary)', fontSize: 13, fontFamily: 'inherit',
        }}
        aria-expanded={open}
      >
        {hasReasoning
          ? <ChevronDown size={13} style={{ flexShrink: 0, transition: 'transform 0.18s', transform: open ? 'rotate(180deg)' : 'none' }} />
          : <Loader2 size={13} className="animate-spin" style={{ flexShrink: 0, color: 'var(--status-running)' }} />}
        <Brain size={13} style={{ flexShrink: 0, color: 'var(--status-running)' }} />
        <span>{hasReasoning ? (open ? '收起深度思考' : `深度思考（${reasoning.trim().length} 字）`) : '深度思考中…'}</span>
      </button>
      {open && hasReasoning && (
        <motion.div
          initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }}
          transition={{ duration: 0.18 }}
          style={{
            marginTop: 4, marginLeft: 8, borderRadius: 'var(--radius-md)',
            background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)',
            borderLeft: '2px solid var(--status-running)', overflow: 'hidden',
          }}
        >
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '5px 12px', fontSize: 11, fontWeight: 600,
            color: 'var(--status-running)', background: 'var(--status-running-dim)',
          }}>
            <Brain size={12} />
            深度思考完成
          </div>
          <div style={{
            padding: '8px 12px 10px',
            fontSize: 12.5, lineHeight: 1.7, color: 'var(--text-secondary)',
            whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 320, overflowY: 'auto',
          }}>
            {reasoning}
          </div>
        </motion.div>
      )}
    </div>
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
    void safeCopyToClipboard(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  // v3：轻量语法高亮，按行产出 token 并与行号对齐
  const lineTokens = useMemo(() => highlightLines(code), [code])
  const langLabel = (language || 'text').toLowerCase()

  return (
    <motion.div
      initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: collapsed ? 34 : 'auto' }}
      transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
      style={{ marginTop: 8, borderRadius: 'var(--radius-lg)', background: 'var(--bg-base)', border: '1px solid var(--border-subtle)', overflow: 'hidden' }}
    >
      <div style={{
        height: 34, display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '0 8px 0 12px', background: 'var(--bg-surface)',
        borderBottom: collapsed ? 'none' : '1px solid var(--border-subtle)', cursor: 'pointer',
      }} onClick={() => setCollapsed(!collapsed)}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
          <Code2 size={13} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
          <span style={{
            fontSize: 11.5, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)',
            textTransform: 'lowercase', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {langLabel}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 2 }} onClick={(e) => e.stopPropagation()}>
          <button
            onClick={handleCopy}
            onMouseEnter={(e) => { if (!copied) e.currentTarget.style.color = 'var(--text-secondary)' }}
            onMouseLeave={(e) => { e.currentTarget.style.color = copied ? 'var(--status-done)' : 'var(--text-tertiary)' }}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 4, background: 'transparent', border: 'none',
              cursor: 'pointer', color: copied ? 'var(--status-done)' : 'var(--text-tertiary)',
              fontSize: 11, padding: '3px 7px', borderRadius: 6, fontFamily: 'inherit',
            }}
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}{copied ? '已复制' : '复制'}
          </button>
          <span
            onClick={() => setCollapsed(!collapsed)}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: 'var(--text-tertiary)', fontSize: 11, padding: '3px 6px', borderRadius: 6, cursor: 'pointer' }}
          >
            {collapsed ? '展开' : '收起'}
            <ChevronDown size={12} style={{ transition: 'transform 0.2s', transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }} />
          </span>
        </div>
      </div>
      {!collapsed && (
        <div style={{ overflow: 'auto', maxHeight: 360 }}>
          <pre style={{ margin: 0, padding: '10px 0', fontSize: 12.5, lineHeight: 1.7, fontFamily: 'var(--font-mono)', whiteSpace: 'pre' }}>
            <code>
              {lineTokens.map((tokens, i) => (
                <div key={i} style={{ display: 'flex', padding: '0 12px' }}>
                  <span style={{
                    color: 'var(--text-disabled)', marginRight: 16, minWidth: 24, textAlign: 'right',
                    userSelect: 'none', flexShrink: 0, fontSize: 11, lineHeight: 1.7,
                  }}>
                    {i + 1}
                  </span>
                  <span style={{ flex: 1, whiteSpace: 'pre' }}>
                    {tokens.length === 0 ? ' ' : tokens.map((t, j) => (
                      <span key={j} style={{ color: tokenColor(t.type), fontStyle: t.type === 'comment' ? 'italic' : undefined }}>{t.text}</span>
                    ))}
                  </span>
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
