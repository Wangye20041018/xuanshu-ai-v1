/**
 * highlightLite —— 轻量代码语法高亮（零第三方依赖）
 *
 * 目标：在不引入 shiki/highlight.js（体积大、与 Electron 本地包冲突）的前提下，
 * 为 CodeWindow 提供「够用且克制」的暗色语法着色。采用语言无关的关键字超集 +
 * 通用词法规则（注释 / 字符串 / 数字 / 关键字 / 函数调用 / 类型名），
 * 对 JS/TS/TSX/Python/JSON/Bash/Go/Rust/Java/C 等均有稳定表现，不认识的 token 回落普通文本色。
 */

export type TokenType =
  | 'plain'
  | 'keyword'
  | 'string'
  | 'comment'
  | 'number'
  | 'fn'
  | 'type'

export interface Token {
  text: string
  type: TokenType
}

/** 跨语言关键字超集（重复交给 Set 去重） */
const KEYWORDS = new Set([
  // JS / TS
  'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'do',
  'switch', 'case', 'break', 'continue', 'new', 'class', 'extends', 'super', 'this',
  'import', 'from', 'export', 'default', 'async', 'await', 'try', 'catch', 'finally',
  'throw', 'typeof', 'instanceof', 'delete', 'void', 'yield', 'static', 'get', 'set',
  'public', 'private', 'protected', 'readonly', 'interface', 'type', 'enum', 'implements',
  'namespace', 'abstract', 'satisfies', 'keyof', 'infer', 'never', 'unknown', 'any',
  'string', 'number', 'boolean', 'true', 'false', 'null', 'undefined',
  // Python
  'def', 'lambda', 'pass', 'with', 'elif', 'except', 'raise', 'global', 'nonlocal',
  'assert', 'del', 'not', 'and', 'or', 'None', 'True', 'False', 'self',
  // Go / Rust / C / Java / Kotlin 等通用
  'fn', 'mut', 'pub', 'struct', 'impl', 'match', 'use', 'mod', 'crate', 'where',
  'trait', 'unsafe', 'move', 'ref', 'extern', 'package', 'func', 'defer', 'chan',
  'range', 'select', 'map', 'int', 'int8', 'int16', 'int32', 'int64', 'uint',
  'float', 'float32', 'float64', 'bool', 'byte', 'rune', 'char', 'short', 'long',
  'signed', 'unsigned', 'double', 'final', 'volatile', 'transient', 'throws',
  'when', 'object', 'sealed', 'data', 'override', 'open', 'inline', 'lateinit',
  'vararg', 'constructor', 'then', 'end', 'begin', 'rescue', 'ensure', 'module',
  'require', 'include', 'echo', 'local', 'in', 'of', 'is', 'as',
])

const keywordAlt = Array.from(KEYWORDS).sort((a, b) => b.length - a.length).join('|')

// 捕获组顺序：1 块注释  2 行注释  3 字符串  4 数字  5 关键字  6 函数调用  7 类型名
const MASTER = new RegExp(
  [
    /\/\*[\s\S]*?\*\//.source,                       // 1 block comment
    /\/\/[^\n]*|#[^\n]*/.source,                     // 2 line comment (// 或 #)
    /"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`/.source, // 3 strings
    /\b0[xX][0-9a-fA-F_]+\b|\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?\b/.source, // 4 number
    `\\b(?:${keywordAlt})\\b`,                       // 5 keyword
    /[A-Za-z_$][\w$]*(?=\s*\()/.source,              // 6 fn call
    /\b[A-Z][A-Za-z0-9_$]*\b/.source,                // 7 Type/Class
    // 每个顶层分支包一个捕获组（分支内部均为非捕获组/前瞻，不占用编号），
    // 捕获组 1..7 与 tokenize 中 m[1]..m[7] 的类别判定一一对应
  ].map((src) => `(${src})`).join('|'),
  'g',
)

function tokenize(code: string): Array<Token> {
  const out: Array<Token> = []
  let last = 0
  let m: RegExpExecArray | null
  MASTER.lastIndex = 0
  while ((m = MASTER.exec(code)) !== null) {
    if (m.index > last) {out.push({ text: code.slice(last, m.index), type: 'plain' })}
    let type: TokenType = 'plain'
    if (m[1] !== undefined || m[2] !== undefined) {type = 'comment'}
    else if (m[3] !== undefined) {type = 'string'}
    else if (m[4] !== undefined) {type = 'number'}
    else if (m[5] !== undefined) {type = 'keyword'}
    else if (m[6] !== undefined) {type = 'fn'}
    else if (m[7] !== undefined) {type = 'type'}
    out.push({ text: m[0], type })
    last = MASTER.lastIndex
    if (m[0].length === 0) {MASTER.lastIndex++} // 防御零宽死循环
  }
  if (last < code.length) {out.push({ text: code.slice(last), type: 'plain' })}
  return out
}

/** 整段高亮后按行切分，返回每行的 token 序列（与行号一一对应） */
export function highlightLines(code: string): Array<Array<Token>> {
  const flat = tokenize(code)
  const lines: Array<Array<Token>> = [[]]
  for (const tok of flat) {
    const parts = tok.text.split('\n')
    parts.forEach((part, i) => {
      if (i > 0) {lines.push([])}
      if (part) {lines[lines.length - 1].push({ text: part, type: tok.type })}
    })
  }
  if (lines.length === 0) {lines.push([])}
  return lines
}

/** 暗色低饱和语法色（克制、不刺眼；与 #1a1b1d 基底协调） */
export function tokenColor(type: TokenType): string {
  switch (type) {
    case 'keyword': return '#7aa2f7'
    case 'string': return '#9ece8a'
    case 'comment': return '#767c88'
    case 'number': return '#f0a868'
    case 'fn': return '#d2c08a'
    case 'type': return '#5fc4b4'
    default: return '#c6cbd4'
  }
}
