/**
 * taskflow 视图层类型 + IPC 事件类型守卫
 *
 * 数据来源：src/shared/agent-types.ts 的 TaskStepEvent / ToolCallEvent
 * （由 main/agent/orchestrator.ts、tool-registry.ts 经 xuanshu:task-step / xuanshu:tool-call 推送）。
 * 本文件只做渲染层归并所需的视图类型与运行时收窄，不反向改动 shared 类型。
 */
import type { TaskStepEvent, ToolCallEvent } from '../../../shared/agent-types'

/** 步骤状态（与事件一致：pending / running / done / failed） */
export type StepStatus = TaskStepEvent['status']
/** 工具状态（注意是 start / done / error，与步骤的 running/done/failed 不同） */
export type ToolStatus = ToolCallEvent['status']

/** 归并后的单步视图（以 stepId 去重 upsert） */
export interface StepView {
  stepId: string
  title: string
  status: StepStatus
  detail?: string
  startedAt?: number
  updatedAt: number
}

/** 归并后的单次工具调用视图（后端无 callId，前端用自增 uid + LIFO 同名配对） */
export interface ToolCallView {
  uid: number
  tool: string
  argsSummary: string
  status: ToolStatus
  resultPreview?: string
  startedAt: number
  endedAt?: number
}

/** 一次任务运行的整体视图（后端无 runId，按事件流活跃边界推断） */
export interface TaskRunView {
  /** 是否仍在进行：存在 pending/running 步骤，或存在未闭合(start)工具 */
  active: boolean
  startedAt: number
  steps: Array<StepView>
  tools: Array<ToolCallView>
}

const isStr = (v: unknown): v is string => typeof v === 'string'
const isNum = (v: unknown): v is number => typeof v === 'number'
const isStepStatus = (v: unknown): v is StepStatus =>
  v === 'pending' || v === 'running' || v === 'done' || v === 'failed'
const isToolStatus = (v: unknown): v is ToolStatus =>
  v === 'start' || v === 'done' || v === 'error'

/** 运行时收窄：校验为合法 TaskStepEvent（IPC payload 是 unknown，禁止 as any） */
export function isTaskStepEvent(x: unknown): x is TaskStepEvent {
  if (!x || typeof x !== 'object') {return false}
  const o = x as Record<string, unknown>
  return isStr(o.stepId) && isStr(o.title) && isStepStatus(o.status) && isNum(o.ts)
}

/** 运行时收窄：校验为合法 ToolCallEvent */
export function isToolCallEvent(x: unknown): x is ToolCallEvent {
  if (!x || typeof x !== 'object') {return false}
  const o = x as Record<string, unknown>
  return isStr(o.tool) && isStr(o.argsSummary) && isToolStatus(o.status) && isNum(o.ts)
}

/** 工具名 → 中文过程标签（聚合过程行使用，未知工具回退「调用工具」） */
const TOOL_LABELS: Record<string, string> = {
  web_search: '联网搜索',
  search: '联网搜索',
  read_file: '读取文件',
  read_files: '读取文件',
  write_file: '写入文件',
  edit_file: '编辑文件',
  list_dir: '浏览目录',
  execute_command: '执行命令',
  run_command: '执行命令',
  open_software: '打开软件',
  open_app: '打开软件',
  close_software: '关闭软件',
  query_app_status: '查询状态',
  app_status: '查询状态',
  click: '界面点击',
  click_at: '界面点击',
  type_text: '输入文本',
  send_keys: '按键操作',
  screenshot: '屏幕截图',
  capture_screen: '屏幕截图',
}

export function toolLabel(tool: string): string {
  if (!tool) {return '调用工具'}
  return TOOL_LABELS[tool] ?? TOOL_LABELS[tool.toLowerCase()] ?? '调用工具'
}
