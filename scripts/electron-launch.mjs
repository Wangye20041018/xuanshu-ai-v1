// 关键修复：在 spawn 子进程（electron-vite / electron-builder）之前清掉
// ELECTRON_RUN_AS_NODE。开发/agent 环境中该变量常被预设，会让 Electron 主进程
// 以 Node 兼容模式启动，导致 require('electron') 返回字符串（electron.exe 路径）
// 而非内置模块，进而 @electron-toolkit/utils 顶层读取 electron.app.isPackaged
// 时崩溃（Cannot read properties of undefined）。清除后该干净环境会随 env 传给子进程。
delete process.env.ELECTRON_RUN_AS_NODE

import { spawn } from 'node:child_process'

/**
 * 玄枢AI 自清理启动器
 * 统一入口：先剥离被污染的环境变量，再用干净环境拉起 electron-vite / electron-builder。
 */

const command = process.argv[2] || 'dev'

// 支持透传 electron 参数：`npm run dev -- -- --remote-debugging-port=9222`
const passthrough = process.argv.slice(3)

let bin = ''
let binArgs = []

switch (command) {
  case 'dev':
    bin = 'electron-vite'
    binArgs = ['dev', ...passthrough]
    break
  case 'build':
    bin = 'electron-vite'
    binArgs = ['build']
    break
  case 'pack':
    bin = 'electron-builder'
    binArgs = ['--win', '--publish=never']
    break
  default:
    console.error(`[electron-launch] 未知命令: "${command}"，仅支持 dev / build / pack`)
    process.exit(1)
}

// shell: true 兼容 Windows 下 .cmd 脚本（electron-vite / electron-builder）的解析；
// env 使用已清除变量的干净 process.env，stdio 继承以便实时看到子进程输出。
const child = spawn(bin, binArgs, {
  shell: true,
  stdio: 'inherit',
  env: process.env,
})

child.on('error', (err) => {
  console.error(`[electron-launch] 启动 "${bin}" 失败:`, err.message)
  process.exit(1)
})

child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`[electron-launch] 子进程被信号终止: ${signal}`)
    process.exit(1)
  }
  process.exit(code ?? 0)
})
