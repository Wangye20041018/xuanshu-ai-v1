/**
 * DiffViewer —— diff 高亮展示组件
 *
 * 展示文件级 diff：新增行（绿）、删除行（红）、上下文行（灰）。
 * 供自我改造流程页在 apply 前的人工确认门使用。
 *
 * @module renderer/components/DiffViewer
 */

import React from 'react'
import { Plus, Minus, FileCode2 } from 'lucide-react'
import { COLORS, HEX_COLORS } from '../shared/theme'
import type { DiffResult } from '../../shared/self-modify-types'

export interface DiffViewerProps {
  diff: DiffResult
  /** 最大展示行数（超出的上下文行折叠，避免大 diff 拖垮渲染） */
  maxLinesPerFile?: number
}

export const DiffViewer: React.FC<DiffViewerProps> = ({ diff, maxLinesPerFile = 600 }) => {
  if (!diff || diff.files.length === 0) {
    return (
      <div
        style={{
          padding: '24px',
          textAlign: 'center',
          color: COLORS.textMuted,
          fontSize: 13,
        }}
      >
        暂无差异
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* 汇总条 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 12 }}>
        <span style={{ color: COLORS.success, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <Plus size={13} /> {diff.additions} 行新增
        </span>
        <span style={{ color: COLORS.danger, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <Minus size={13} /> {diff.deletions} 行删除
        </span>
        <span style={{ color: COLORS.textMuted }}>风险级别：</span>
        <RiskBadge level={diff.estimatedRisk} />
      </div>

      {diff.files.map((file) => (
        <div
          key={file.path}
          style={{
            border: `1px solid ${COLORS.cardBorder}`,
            borderRadius: 'var(--radius-lg)',
            overflow: 'hidden',
            background: COLORS.bg,
          }}
        >
          {/* 文件头 */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '8px 12px',
              background: 'rgba(255,255,255,0.03)',
              borderBottom: `1px solid ${COLORS.cardBorder}`,
              fontFamily: 'var(--font-mono)',
              fontSize: 12,
              color: COLORS.textSecondary,
            }}
          >
            <FileCode2 size={14} style={{ color: COLORS.textMuted }} />
            <span style={{ flex: 1, wordBreak: 'break-all' }}>{file.path}</span>
            <span style={{ color: COLORS.success }}>+{file.additions}</span>
            <span style={{ color: COLORS.danger }}>-{file.deletions}</span>
          </div>

          {/* 行内容 */}
          <div
            style={{
              maxHeight: 420,
              overflow: 'auto',
              fontFamily: 'var(--font-mono)',
              fontSize: 12,
              lineHeight: 1.6,
            }}
          >
            {file.lines.slice(0, maxLinesPerFile).map((line, idx) => (
              <div
                key={idx}
                style={{
                  display: 'flex',
                  padding: '0 12px',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                  background:
                    line.type === 'add'
                      ? `${HEX_COLORS.success}14`
                      : line.type === 'del'
                        ? `${HEX_COLORS.danger}14`
                        : 'transparent',
                  color:
                    line.type === 'add'
                      ? COLORS.success
                      : line.type === 'del'
                        ? COLORS.danger
                        : COLORS.textSecondary,
                }}
              >
                <span
                  style={{
                    width: 20,
                    flexShrink: 0,
                    textAlign: 'center',
                    color: COLORS.textMuted,
                    userSelect: 'none',
                  }}
                >
                  {line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '}
                </span>
                <span style={{ flex: 1 }}>{line.text || ' '}</span>
              </div>
            ))}
            {file.lines.length > maxLinesPerFile && (
              <div style={{ padding: '8px 12px', color: COLORS.textMuted, fontSize: 11 }}>
                … 其余 {file.lines.length - maxLinesPerFile} 行已折叠
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

function RiskBadge({ level }: { level: string }) {
  const color =
    level === 'L0'
      ? COLORS.textMuted
      : level === 'L1'
        ? COLORS.success
        : level === 'L2'
          ? COLORS.warning
          : COLORS.danger
  return (
    <span
      style={{
        padding: '2px 8px',
        borderRadius: 6,
        fontSize: 11,
        fontWeight: 600,
        background: `${color}1a`,
        color,
        border: `1px solid ${color}40`,
      }}
    >
      {level}
    </span>
  )
}

export default DiffViewer
