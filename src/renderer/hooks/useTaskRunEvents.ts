/**
 * useTaskRunEvents —— 订阅任务步骤 / 工具调用 IPC 事件并归并进 taskRunStore
 *
 * 在对话页（Home）顶层调用一次即可。订阅签名 window.api.on(channel, (event, payload) => cleanup)，
 * payload 在第二个参数且类型为 unknown，这里经类型守卫收窄为 shared 强类型，禁用 as any。
 */
import { useEffect } from 'react'
import { useTaskRunStore } from '../store/taskRunStore'
import { isTaskStepEvent, isToolCallEvent } from '../components/taskflow/types'

export function useTaskRunEvents(): void {
  useEffect(() => {
    const api = window.api
    if (!api?.on) {return}

    const offStep = api.on('xuanshu:task-step', (_event, payload) => {
      if (isTaskStepEvent(payload)) {useTaskRunStore.getState().applyStep(payload)}
    })
    const offTool = api.on('xuanshu:tool-call', (_event, payload) => {
      if (isToolCallEvent(payload)) {useTaskRunStore.getState().applyTool(payload)}
    })

    return () => {
      offStep()
      offTool()
    }
  }, [])
}
