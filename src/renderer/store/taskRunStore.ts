/**
 * taskRunStore —— 任务步骤 / 工具调用过程的渲染层归并 store
 *
 * 设计约束（见 docs/ui-redesign/02 方案）：
 * 1. 非持久化：任务过程是瞬时态，绝不写进被 persist 的 chatStore，刷新即清空。
 * 2. 后端事件无 runId / callId：
 *    - 运行边界：当不存在 run、或上一 run 已完全不活跃时，收到新的「起步事件」即开启新 run；
 *      pending 代表本轮步骤清单已下发，也算活跃，避免 pending→running 被误清成两轮。
 *    - 工具配对：done/error 从末尾向前找最近一条「同工具名且仍为 start」的记录闭合（LIFO），
 *      找不到闭合目标（异常时序/丢起始事件）时作为独立终态记录落地，保证信息不丢。
 * 3. 强类型：入参直接用 shared 的事件类型，订阅处经类型守卫收窄，全程禁用 as any。
 */
import { create } from 'zustand'
import type { TaskStepEvent, ToolCallEvent } from '../../shared/agent-types'
import type { StepView, ToolCallView, TaskRunView } from '../components/taskflow/types'

const MAX_TOOLS = 300
const MAX_STEPS = 200
let toolUidSeq = 0

interface TaskRunState {
  run: TaskRunView | null
  applyStep: (ev: TaskStepEvent) => void
  applyTool: (ev: ToolCallEvent) => void
  reset: () => void
}

/** 活跃判定：存在待执行/执行中步骤，或存在未闭合工具调用 */
function isActive(run: TaskRunView): boolean {
  return (
    run.steps.some((s) => s.status === 'pending' || s.status === 'running')
    || run.tools.some((t) => t.status === 'start')
  )
}

function emptyRun(ts: number): TaskRunView {
  return { active: true, startedAt: ts, steps: [], tools: [] }
}

export const useTaskRunStore = create<TaskRunState>()((set) => ({
  run: null,

  applyStep: (ev) => set((state) => {
    const starting = ev.status === 'pending' || ev.status === 'running'
    const run: TaskRunView = state.run
      ? starting && !state.run.active
        ? emptyRun(ev.ts)
        : { ...state.run, steps: [...state.run.steps], tools: [...state.run.tools] }
      : emptyRun(ev.ts)

    const idx = run.steps.findIndex((s) => s.stepId === ev.stepId)
    const merged: StepView = idx >= 0
      ? {
          ...run.steps[idx],
          title: ev.title || run.steps[idx].title,
          status: ev.status,
          detail: ev.detail ?? run.steps[idx].detail,
          startedAt: run.steps[idx].startedAt ?? (ev.status === 'running' ? ev.ts : undefined),
          updatedAt: ev.ts,
        }
      : {
          stepId: ev.stepId,
          title: ev.title,
          status: ev.status,
          detail: ev.detail,
          startedAt: ev.status === 'running' ? ev.ts : undefined,
          updatedAt: ev.ts,
        }

    run.steps = idx >= 0
      ? run.steps.map((s, i) => (i === idx ? merged : s))
      : [...run.steps, merged]
    run.steps = run.steps.slice(-MAX_STEPS)
    run.active = isActive(run)
    return { run }
  }),

  applyTool: (ev) => set((state) => {
    const run: TaskRunView = state.run
      ? ev.status === 'start' && !state.run.active
        ? emptyRun(ev.ts)
        : { ...state.run, steps: [...state.run.steps], tools: [...state.run.tools] }
      : emptyRun(ev.ts)

    if (ev.status === 'start') {
      const view: ToolCallView = {
        uid: ++toolUidSeq,
        tool: ev.tool,
        argsSummary: ev.argsSummary,
        status: 'start',
        startedAt: ev.ts,
      }
      run.tools = [...run.tools, view].slice(-MAX_TOOLS)
    } else {
      // 无 callId：LIFO 同名配对，闭合最近一条仍在 start 的同工具记录
      let pairedIdx = -1
      for (let i = run.tools.length - 1; i >= 0; i--) {
        if (run.tools[i].status === 'start' && run.tools[i].tool === ev.tool) {
          pairedIdx = i
          break
        }
      }
      if (pairedIdx >= 0) {
        run.tools = run.tools.map((t, i) => (i === pairedIdx
          ? { ...t, status: ev.status, resultPreview: ev.resultPreview ?? t.resultPreview, endedAt: ev.ts }
          : t))
      } else {
        // 异常时序兜底：直接落一条终态记录，避免 done/error 无对应起始而丢失
        const view: ToolCallView = {
          uid: ++toolUidSeq,
          tool: ev.tool,
          argsSummary: ev.argsSummary,
          status: ev.status,
          resultPreview: ev.resultPreview,
          startedAt: ev.ts,
          endedAt: ev.ts,
        }
        run.tools = [...run.tools, view].slice(-MAX_TOOLS)
      }
    }

    run.active = isActive(run)
    return { run }
  }),

  reset: () => set({ run: null }),
}))
