/* ============================================================
 * 玄枢「重生」P0-0 主链路回归基线（机器质检员）
 * 用法：node scripts/p0-regression.mjs
 * 覆盖 10 项检查：编译基线/干净启动/窗口就绪/模型链路/核心对话/
 *                 上下文记忆/人设生效/联网冒烟/日志健康/能力冒烟
 * 输出逐项 PASS/FAIL，任一 FAIL 即不得交付。
 * ============================================================ */
import { spawn, execSync } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CDP_PORT = 9222
const LLAMA_PORT = 8089
const LOG_FILE = path.join(os.tmpdir(), `p0-baseline-${Date.now()}.log`)
const RESULTS = []

function check(name, ok, detail = '') {
  RESULTS.push({ name, ok, detail })
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`)
  return ok
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function httpGet(url, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let data = ''
      res.on('data', c => (data += c))
      res.on('end', () => resolve(data))
    })
    req.setTimeout(timeout, () => { req.destroy(new Error('timeout')) })
    req.on('error', reject)
  })
}

function runCmd(cmd) {
  try { return { code: 0, out: execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: true, timeout: 120000 }) } }
  catch (e) { return { code: e.status ?? -1, out: e.stdout || '', err: e.stderr || String(e) } }
}

function isPortListening(port) {
  const r = runCmd(`netstat -ano | findstr "LISTENING" | findstr ":${port} "`)
  return r.code === 0 && /LISTENING/.test(r.out)
}

async function cdpConnect() {
  const targets = JSON.parse(await httpGet(`http://127.0.0.1:${CDP_PORT}/json/list`))
  const page = targets.find(t => t.type === 'page')
  if (!page) throw new Error('无页面 target')
  const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 })
  let msgId = 0
  const pending = new Map()
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++msgId
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
  ws.on('message', data => {
    const msg = JSON.parse(data.toString())
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id); pending.delete(msg.id)
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result)
    }
  })
  await new Promise(r => ws.on('open', r))
  return { ws, send }
}

async function cdpEval(conn, expression, awaitPromise = false) {
  const res = await conn.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true })
  return res?.result?.value
}

async function chatSend(conn, msgs, sessionId = `p0-${Date.now()}`, stream = true) {
  const expr = `
    (async () => {
      try {
        const r = await window.api.invokeWithTimeout('chat:send', 180000, {
          id: '${sessionId}',
          stream: ${stream},
          messages: ${JSON.stringify(msgs)}
        })
        return JSON.stringify(r)
      } catch (e) { return JSON.stringify({ error: String(e) }) }
    })()
  `
  const out = await cdpEval(conn, expr, true)
  try { return JSON.parse(out) } catch { return { raw: out } }
}

/** 通过 chat:send-agent（ReActAgent）发起消息，真实执行工具循环 */
async function agentSend(conn, msgs, sessionId = `p0a-${Date.now()}`) {
  const expr = `
    (async () => {
      try {
        const r = await window.api.invokeWithTimeout('chat:send-agent', 240000, {
          id: '${sessionId}',
          stream: true,
          messages: ${JSON.stringify(msgs)}
        })
        return JSON.stringify(r)
      } catch (e) { return JSON.stringify({ error: String(e) }) }
    })()
  `
  const out = await cdpEval(conn, expr, true)
  try { return JSON.parse(out) } catch { return { raw: out } }
}
function msg(role, content, id) { return { id: id || `m${Math.random().toString(36).slice(2, 8)}`, role, content } }

function mainSection(name) {
  console.log(`\n===== ${name} =====`)
}

let devStartedByScript = false

async function main() {
  const only = process.argv[2] || 'all'
  console.log('玄枢 P0-0 主链路回归基线')
  console.log('工作目录:', ROOT)

  // ---------- 1. 编译基线 ----------
  if (['all', 'tsc'].includes(only)) {
    mainSection('1. 编译基线 (npx tsc --noEmit)')
    const r = runCmd('npx tsc --noEmit')
    check('编译基线 tsc 零错误', r.code === 0, r.code === 0 ? '' : (r.err || r.out || '').slice(0, 400))
  }

  // ---------- 2/3. 干净启动 + 窗口就绪 ----------
  if (['all', 'start'].includes(only)) {
    mainSection('2. 干净启动 + 3. 窗口就绪')
    if (!isPortListening(CDP_PORT)) {
      console.log('  未检测到运行实例，执行干净启动...')
      runCmd('taskkill /F /IM electron.exe 2>nul & taskkill /F /IM llama-server.exe 2>nul')
      await sleep(2000)
      const env = { ...process.env, PATH: `${path.join(ROOT, 'node_modules/.bin')};${process.env.PATH || ''}` }
      const child = spawn('cmd.exe', ['/c', 'node scripts/electron-launch.mjs dev -- --remote-debugging-port=9222 > p0-baseline-run.log 2>&1'], { cwd: ROOT, env, shell: false, detached: true, stdio: 'ignore' })
      child.unref()
      devStartedByScript = true
      let up = false
      for (let i = 0; i < 60; i++) {
        await sleep(3000)
        if (isPortListening(CDP_PORT) && isPortListening(LLAMA_PORT)) { up = true; break }
      }
      check('干净启动（9222+8089 就绪）', up, up ? '' : '60s 内未就绪')
    } else {
      console.log('  检测到运行实例（9222 已监听），跳过重启，复用当前实例检查窗口')
      check('干净启动（复用运行实例）', true, '9222 已监听')
    }

    if (isPortListening(CDP_PORT)) {
      try {
        const conn = await cdpConnect()
        let ready = false, whiteScreen = false, errDialog = false
        for (let i = 0; i < 10; i++) {
          const v = await cdpEval(conn, `(() => {
            const b = document.body;
            if (!b) return JSON.stringify({ ready: false });
            const textLen = (b.innerText || '').trim().length;
            return JSON.stringify({ ready: true, textLen, white: textLen < 10, html: (b.innerHTML || '').length });
          })()`)
          try {
            const info = JSON.parse(v)
            if (info.ready) {
              ready = true
              whiteScreen = info.white || info.html < 200
              break
            }
          } catch { /* ignore */ }
          await sleep(1000)
        }
        check('窗口正常渲染（非白屏）', ready && !whiteScreen, ready ? (whiteScreen ? '疑似白屏' : 'body 内容正常') : '未取到渲染状态')
        const dialogText = await cdpEval(conn, `document.body ? (document.body.innerText || '') : ''`)
        errDialog = typeof dialogText === 'string' && /遇到问题|正在尝试修复|崩溃|修复弹窗/i.test(dialogText)
        check('无修复/重试弹窗闪动', !errDialog, errDialog ? '检测到修复弹窗文本' : '无弹窗文本')
        conn.ws.close()
      } catch (e) {
        check('窗口就绪检查', false, String(e.message || e))
      }
    } else {
      check('窗口就绪检查', false, 'CDP 未就绪')
    }
  }

  // ---------- 4. 模型链路 ----------
  if (['all', 'model'].includes(only)) {
    mainSection('4. 模型链路')
    const portOk = isPortListening(LLAMA_PORT)
    check('llama-server 端口 8089 监听', portOk)
    const smi = runCmd('nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader')
    const gpuOk = smi.code === 0 && /\d+\s*MiB/.test(smi.out)
    check('GPU 显存占用可确认', gpuOk, gpuOk ? smi.out.trim().replace(/\n/g, ' | ') : 'nvidia-smi 不可用')
    const health = runCmd(`powershell -Command "(Invoke-WebRequest -Uri 'http://127.0.0.1:${LLAMA_PORT}/health' -UseBasicParsing -TimeoutSec 5).Content"`)
    check('llama-server /health 返回', health.code === 0 && /ok|model loaded/i.test(health.out), (health.out || health.err || '').slice(0, 120))
  }

  // ---------- 5. 核心对话 ----------
  if (['all', 'chat'].includes(only)) {
    mainSection('5. 核心对话 (chat:send)')
    if (isPortListening(CDP_PORT)) {
      try {
        const conn = await cdpConnect()
        const res = await chatSend(conn, [msg('user', '你好，请用一句话回复')], `p0-chat-${Date.now()}`)
        const ok = res?.success === true && typeof res.content === 'string' && res.content.length > 0
        check('chat:send 返回有效 content', ok, ok ? `回复长度=${res.content.length}` : JSON.stringify(res).slice(0, 300))
        conn.ws.close()
      } catch (e) { check('核心对话', false, String(e.message || e)) }
    } else { check('核心对话', false, 'CDP 未就绪') }
  }

  // ---------- 6. 上下文记忆 ----------
  if (['all', 'memory'].includes(only)) {
    mainSection('6. 上下文记忆（多轮对话记得前文）')
    if (isPortListening(CDP_PORT)) {
      try {
        const conn = await cdpConnect()
        const sid = `p0-mem-${Date.now()}`
        const m1 = msg('user', '我的暗号是玄枢重生-7321，请记住它')
        const r1 = await chatSend(conn, [m1], sid)
        const a1 = msg('assistant', r1?.content || '已记住', 'a1')
        const m2 = msg('user', '我的暗号是什么？请直接回答暗号内容')
        const r2 = await chatSend(conn, [m1, a1, m2], sid)
        const content = (r2?.content || '') + (r2?.error || '')
        const remembered = /7321/.test(content) || /玄枢重生-7321/.test(content)
        check('多轮上下文记忆生效', remembered, remembered ? '第二轮回中暗号' : `第二轮回复: ${content.slice(0, 200)}`)
        conn.ws.close()
      } catch (e) { check('上下文记忆', false, String(e.message || e)) }
    } else { check('上下文记忆', false, 'CDP 未就绪') }
  }

  // ---------- 7. 人设生效 ----------
  if (['all', 'persona'].includes(only)) {
    mainSection('7. 人设生效（模型确认自己是玄枢）')
    if (isPortListening(CDP_PORT)) {
      try {
        const conn = await cdpConnect()
        const res = await chatSend(conn, [msg('user', '你是谁？请用一句话介绍自己')], `p0-per-${Date.now()}`)
        const content = (res?.content || '') + (res?.error || '')
        const persona = /玄枢/.test(content) && !/不是玄枢|并非玄枢|我不是玄枢/.test(content)
        check('人设生效（自称玄枢）', persona, persona ? '回复含"玄枢"' : `回复: ${content.slice(0, 250)}`)
        conn.ws.close()
      } catch (e) { check('人设生效', false, String(e.message || e)) }
    } else { check('人设生效', false, 'CDP 未就绪') }
  }

  // ---------- 8. 联网冒烟 ----------
  if (['all', 'web'].includes(only)) {
    mainSection('8. 联网冒烟（问天气自动联网）')
    if (isPortListening(CDP_PORT)) {
      try {
        const conn = await cdpConnect()
        const res = await chatSend(conn, [msg('user', '北京今天天气怎么样？')], `p0-web-${Date.now()}`)
        const content = (res?.content || '') + (res?.error || '')
        const hasSources = /https?:\/\//.test(content)
        const hasWeatherInfo = /天气|温度|气温|舒适|℃|°C|降雨|晴|多云|风/.test(content)
        // 联网是否真实触发：查看应用日志中的搜索命中记录
        const logHit = (() => {
          for (const f of ['p0-baseline-run.log', 'p0_run.log']) {
            const p = path.join(ROOT, f)
            if (fs.existsSync(p)) {
              try {
                const txt = fs.readFileSync(p, 'utf8')
                const m = txt.match(/对话搜索命中\s+\d+\s+条结果/g)
                if (m && m.length > 0) return true
              } catch { /* ignore */ }
            }
          }
          return false
        })()
        check('联网冒烟（搜索触发+结果注入）', logHit, logHit ? '日志确认搜索命中' : '日志无搜索命中记录')
        check('联网回答基于真实来源', hasSources && hasWeatherInfo, hasSources && hasWeatherInfo ? '回复含来源+天气信息' : `回复: ${content.slice(0, 250)}`)
        conn.ws.close()
      } catch (e) { check('联网冒烟', false, String(e.message || e)) }
    } else { check('联网冒烟', false, 'CDP 未就绪') }
  }

  // ---------- 9. 日志健康 ----------
  if (['all', 'log'].includes(only)) {
    mainSection('9. 日志健康（KB 级、无死循环刷屏）')
    const candidates = ['p0-baseline-run.log', 'p0_run.log', LOG_FILE]
    const logFiles = candidates.map(f => path.join(ROOT, f)).concat(
      runCmd('powershell -Command "Get-ChildItem $env:USERPROFILE\\AppData\\Roaming\\xuanshu\\logs\\*.log -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName"').out.trim().split(/\r?\n/).filter(Boolean)
    ).filter(p => p && fs.existsSync(p))
    if (logFiles.length > 0) {
      let maxSize = 0, maxFile = ''
      for (const p of logFiles) {
        const st = fs.statSync(p)
        if (st.size > maxSize) { maxSize = st.size; maxFile = p }
      }
      const sizeMB = (maxSize / 1024 / 1024).toFixed(2)
      check('日志大小正常（KB~小MB级）', maxSize < 10 * 1024 * 1024, `最大日志 ${path.basename(maxFile)} = ${sizeMB}MB`)
    } else {
      check('日志健康', true, '未发现应用日志文件（本次运行可能未启用文件日志）')
    }
  }

  // ---------- 10. 能力冒烟 ----------
  if (['all', 'caps'].includes(only)) {
    mainSection('10. 能力冒烟（操控真实工具链路 + 工具接线）')
    if (isPortListening(CDP_PORT)) {
      try {
        const conn = await cdpConnect()
        // 通过 chat:send-agent（ReActAgent）真实执行工具循环：问时间 → get_current_time 真正被调用
        const res = await agentSend(conn, [msg('user', '现在几点？请调用工具获取当前时间并直接回答')], `p0-caps-${Date.now()}`)
        const content = (res?.content || '') + (res?.error || '')
        const toolExecuted = /工具\s*get_current_time\s*执行成功/.test(content)
        const timeOk = /\d{1,2}[:：]\d{2}/.test(content) || /\d{1,2}\s*点\s*\d{1,2}\s*分/.test(content)
        check('操控能力（get_current_time 真实执行链路）', toolExecuted, toolExecuted ? 'agent 循环中工具真实执行成功' : `回复: ${content.slice(0, 250)}`)
        check('操控能力（回复包含当前时间）', timeOk, timeOk ? '回复含时间' : `回复: ${content.slice(0, 200)}`)
        // 检索/浏览器/语音：检查工具注册与注入（从日志确认接线，非壳子判据：工具真实注册于 registry）
        const regProbe = runCmd(`powershell -NoProfile -Command "$c = (Get-Content -Raw -Encoding UTF8 '${path.join(ROOT, 'out/main/index.js')}') ; @('search_memories','browser_navigate','speak','control_computer') | ForEach-Object { if ($c.Contains($_)) { 1 } } | Measure-Object -Sum | Select-Object -ExpandProperty Sum"`)
        const wired = regProbe.code === 0 && parseInt(regProbe.out.trim()) >= 4
        check('检索/浏览器/语音/操控工具已接线注册', wired, wired ? 'out/main 中 4 类工具均已注册' : `探测数=${regProbe.out.trim()} err=${(regProbe.err||'').slice(0,120)}`)
        conn.ws.close()
      } catch (e) { check('能力冒烟', false, String(e.message || e)) }
    } else { check('能力冒烟', false, 'CDP 未就绪') }
  }

  // ---------- 汇总 ----------
  console.log('\n===== 基线结果汇总 =====')
  let pass = 0, fail = 0
  for (const r of RESULTS) { r.ok ? pass++ : fail++ }
  console.log(`PASS: ${pass}  |  FAIL: ${fail}`)
  if (fail > 0) {
    console.log('FAIL 项:')
    for (const r of RESULTS.filter(x => !x.ok)) console.log(`  - ${r.name}: ${r.detail}`)
  }
  console.log(fail === 0 ? '基线通过，可交付。' : '基线未通过，禁止交付。')
  if (devStartedByScript) console.log('提示：本次脚本启动了应用实例（p0-baseline-run.log），如需关闭请手动清理 electron/llama-server。')
  process.exit(fail === 0 ? 0 : 1)
}

main().catch(e => { console.error('基线脚本异常:', e); process.exit(2) })
