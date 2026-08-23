/**
 * 任务实时进度覆盖面板
 * 在模型执行任务时，首页文字交互区底部展现可收缩的任务进度条
 * 不占用推理算力、不阻塞主链路
 */
import { useState, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { ChevronDown, ChevronUp, Square, CheckCircle2, XCircle, Loader2, Wifi } from 'lucide-react'

/* ========== 类型定义 ========== */
interface SubtaskInfo {
  subtaskId: string
  subtaskDescription: string
  subtaskStatus: 'running' | 'completed' | 'error'
  subtaskError: string | null
}

interface LayerInfo {
  taskId: string
  completedLayers: number
  totalLayers: number
  stage: string
  layerDescriptions: string[]
  modelStatus: {
    visionLoaded: boolean
    mainLoaded: boolean
    switchingTo: string | null
  }
}

interface TaskProgress {
  taskId: string
  taskTitle: string
  progress: number
  completedCount: number
  totalCount: number
  taskStatus: string
  latestSubtask: SubtaskInfo | null
  latestLayer: LayerInfo | null
}

const defaultProgress: TaskProgress = {
  taskId: '',
  taskTitle: '',
  progress: 0,
  completedCount: 0,
  totalCount: 0,
  taskStatus: 'idle',
  latestSubtask: null,
  latestLayer: null,
}

/* ========== 组件 ========== */
export default function TaskProgressOverlay() {
  const [visible, setVisible] = useState(false)
  const [expanded, setExpanded] = useState(true)
  const [progress] = useState<TaskProgress>(defaultProgress)
  const [subtaskHistory] = useState<SubtaskInfo[]>([])

  // 主进程无任务引擎，task:* / scheduler:* 通道已废弃，本浮层不再订阅任何事件，
  // 保持 visible=false 的惰性状态，避免空转监听。
  /* 取消任务 */
  const handleCancel = useCallback(() => {
    setVisible(false)
  }, [])

  /* 展开/折叠 */
  const toggleExpanded = useCallback(() => {
    setExpanded(prev => !prev)
  }, [])

  const isRunning = progress.taskStatus === 'running'
  const isComplete = progress.taskStatus === 'completed'
  const isError = progress.taskStatus === 'error'

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 30 }}
          transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
          className="fixed bottom-24 left-1/2 -translate-x-1/2 z-50 w-full max-w-2xl px-4"
        >
          <div className="bg-[#1c1c1e]/95 backdrop-blur-xl border border-white/8 rounded-2xl shadow-2xl overflow-hidden">
            {/* 折叠栏 */}
            <div
              className="flex items-center justify-between px-4 py-2.5 cursor-pointer hover:bg-white/[0.03] transition-colors"
              onClick={toggleExpanded}
            >
              <div className="flex items-center gap-3 min-w-0">
                {/* 状态图标 */}
                {isRunning && <Loader2 size={16} className="text-blue-400 animate-spin shrink-0" />}
                {isComplete && <CheckCircle2 size={16} className="text-emerald-400 shrink-0" />}
                {isError && <XCircle size={16} className="text-red-400 shrink-0" />}

                <div className="min-w-0">
                  <div className="text-white/90 text-sm font-medium truncate">
                    {progress.taskTitle || '任务执行中'}
                  </div>
                  <div className="text-white/40 text-xs mt-0.5 truncate">
                    {progress.latestSubtask?.subtaskDescription || (
                      isRunning ? '正在分析需求...' :
                      isComplete ? '已完成' :
                      isError ? '执行失败' : ''
                    )}
                  </div>
                </div>

                {/* 模型状态指示 */}
                {isRunning && (
                  <div className="flex items-center gap-1.5 shrink-0 ml-auto">
                    <Wifi size={12} className={
                      progress.latestLayer?.modelStatus.switchingTo
                        ? 'text-amber-400 animate-pulse'
                        : 'text-white/20'
                    } />
                  </div>
                )}
              </div>

              <div className="flex items-center gap-2 ml-3 shrink-0">
                {/* 进度数字 */}
                <span className="text-white/50 text-xs tabular-nums">
                  {progress.completedCount}/{progress.totalCount}
                </span>

                {/* 取消按钮 */}
                {isRunning && (
                  <button
                    onClick={(e) => { e.stopPropagation(); handleCancel() }}
                    className="p-1 rounded-md hover:bg-white/10 transition-colors"
                    title="取消任务"
                    aria-label="取消任务"
                  >
                    <Square size={14} className="text-red-400/80" />
                  </button>
                )}

                {/* 折叠按钮 */}
                <button
                  className="p-1 rounded-md hover:bg-white/10 transition-colors"
                  aria-label={expanded ? '折叠任务详情' : '展开任务详情'}
                >
                  {expanded ? <ChevronDown size={14} className="text-white/40" /> : <ChevronUp size={14} className="text-white/40" />}
                </button>
              </div>
            </div>

            {/* 展开内容 */}
            <AnimatePresence>
              {expanded && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.25 }}
                  className="overflow-hidden"
                >
                  {/* 进度条 */}
                  <div className="px-4 pb-2">
                    <div className="h-1 bg-white/8 rounded-full overflow-hidden">
                      <motion.div
                        className={`h-full rounded-full transition-colors duration-500 ${
                          isError ? 'bg-red-500/60' :
                          isComplete ? 'bg-emerald-500/60' :
                          'bg-blue-500/60'
                        }`}
                        initial={{ width: 0 }}
                        animate={{ width: `${progress.progress}%` }}
                        transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
                      />
                    </div>
                  </div>

                  {/* 模型加载状态 */}
                  {isRunning && progress.latestLayer && (
                    <div className="px-4 pb-2">
                      <div className="flex items-center gap-2 text-xs text-white/30">
                        <span>模型:</span>
                        <span className={progress.latestLayer.modelStatus.visionLoaded ? 'text-cyan-400/70' : 'text-white/20'}>
                          视觉{progress.latestLayer.modelStatus.visionLoaded ? ' ✓' : ''}
                        </span>
                        <span className={progress.latestLayer.modelStatus.mainLoaded ? 'text-blue-400/70' : 'text-white/20'}>
                          主模型{progress.latestLayer.modelStatus.mainLoaded ? ' ✓' : ''}
                        </span>
                        {progress.latestLayer.modelStatus.switchingTo && (
                          <span className="text-amber-400/80">
                            切换中 → {progress.latestLayer.modelStatus.switchingTo}
                          </span>
                        )}
                      </div>
                    </div>
                  )}

                  {/* 子任务列表 */}
                  <div className="max-h-48 overflow-y-auto px-4 pb-3">
                    {subtaskHistory.length > 0 ? (
                      <div className="space-y-1">
                        {subtaskHistory.map((st) => (
                          <div
                            key={st.subtaskId}
                            className={`flex items-center gap-2.5 text-xs py-1 px-2 rounded-md transition-colors ${
                              st.subtaskStatus === 'running' ? 'bg-blue-500/10 text-blue-300/80' :
                              st.subtaskStatus === 'completed' ? 'text-emerald-300/60' :
                              'bg-red-500/5 text-red-300/70'
                            }`}
                          >
                            {/* 图标 */}
                            {st.subtaskStatus === 'running' && <Loader2 size={12} className="text-blue-400 animate-spin shrink-0" />}
                            {st.subtaskStatus === 'completed' && <CheckCircle2 size={12} className="text-emerald-400 shrink-0" />}
                            {st.subtaskStatus === 'error' && <XCircle size={12} className="text-red-400 shrink-0" />}

                            <span className="truncate">{st.subtaskDescription}</span>

                            {st.subtaskStatus === 'error' && st.subtaskError && (
                              <span className="text-red-400/40 truncate ml-auto text-[10px]">
                                {st.subtaskError.slice(0, 40)}
                              </span>
                            )}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="text-center text-white/20 text-xs py-2">
                        暂无子任务详情
                      </div>
                    )}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
