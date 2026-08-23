/**
 * 自我改造类型 —— 主进程入口
 *
 * 规范源位于 `src/shared/self-modify-types.ts`（渲染层与主进程共用）。
 * 本文件作为主进程侧薄封装，统一从共享类型库再导出，避免重复定义漂移。
 *
 * @module main/self-modify/self-modify-types
 */
export * from '../../shared/self-modify-types'
