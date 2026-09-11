/**
 * 通用操作指南库（通用层）— #27 第三方软件收录与学习体系
 *
 * 三层学习架构的「通用层」：与具体软件无关的跨软件共性操控模式。
 * 面对从未收录、从未见过的软件，玄枢先按本指南库的通用方法论「通用起手」，
 * 试探成功后由 maybeLearn 沉淀为专用技能包（升入专用层）。
 *
 * 通用指南来源：
 *   ① 预置规则库（本文件，覆盖主流软件共性）
 *   ② 从已收录软件中自动提炼共性操作（反向学习）
 *   ③ 模板库 / 社区导入扩充
 *
 * @module main/software-library/guides
 */

export interface GuideHint {
  /** 场景类型：菜单 / 工具栏 / 对话框 / 右键 / 输入 / 快捷键 / 导航 / 通用 */
  category: string
  text: string
}

export interface CommonGuide {
  id: string
  /** 适用场景描述（用于匹配"未收录软件的通用起手"） */
  name: string
  /** 通用操控提示块（注入决策链路） */
  hints: GuideHint[]
}

export const COMMON_GUIDES: CommonGuide[] = [
  {
    id: 'guide-menu-bar',
    name: '标准菜单栏',
    hints: [
      { category: '菜单', text: '先找应用顶部菜单栏（文件/编辑/视图/工具/帮助），多数核心操作均可从菜单进入，这是最稳妥的入口。' },
      { category: '菜单', text: '优先用键盘展开菜单：Alt 激活菜单栏，方向键移动，Enter 确认，Esc 收起。' },
      { category: '菜单', text: '菜单项右侧字母下划线通常表示快捷键（如文件(F) → Alt+F）。' },
    ],
  },
  {
    id: 'guide-toolbar',
    name: '工具栏/快捷按钮',
    hints: [
      { category: '工具栏', text: '工具栏图标悬停会显示工具提示（tooltip），用 UIA/视觉定位读取文字后再点击，避免盲点。' },
      { category: '工具栏', text: '工具栏常有「新建/打开/保存/撤销/重做/搜索」通用按钮，位置多在窗口左上或顶部。' },
    ],
  },
  {
    id: 'guide-dialog',
    name: '对话框/弹窗',
    hints: [
      { category: '对话框', text: '对话框默认焦点常在「确定/OK」按钮，Enter 触发主按钮，Esc 取消/关闭。' },
      { category: '对话框', text: '出现模态弹窗时先识别其标题与按钮文案（确定/取消/保存/否），再决定点击目标，勿跳过。' },
    ],
  },
  {
    id: 'guide-context-menu',
    name: '右键菜单',
    hints: [
      { category: '右键', text: '对目标元素右键（或 Shift+F10 / 菜单键）可唤出上下文菜单，操作选项通常在这里最全。' },
      { category: '右键', text: '右键菜单操作后按 Esc 关闭，避免菜单残留干扰后续点击。' },
    ],
  },
  {
    id: 'guide-input',
    name: '输入框/下拉',
    hints: [
      { category: '输入', text: '点击输入框获得焦点后再输入文本；输入前清空旧内容（Ctrl+A 全选后删除）。' },
      { category: '输入', text: '下拉/组合框：Alt+方向键展开选项，输入首字母可快速定位候选项，Enter 选中。' },
    ],
  },
  {
    id: 'guide-shortcuts',
    name: '通用快捷键',
    hints: [
      { category: '快捷键', text: '通用快捷键：Ctrl+O 打开、Ctrl+S 保存、Ctrl+N 新建、Ctrl+C/V/X 复制粘贴剪切、Ctrl+F 查找。' },
      { category: '快捷键', text: 'F1 帮助、F5 刷新、Ctrl+Z 撤销、Ctrl+Y 重做、Esc 取消。' },
    ],
  },
  {
    id: 'guide-navigation',
    name: '标准导航',
    hints: [
      { category: '导航', text: '多页/多标签应用：Ctrl+Tab 切换页签，Ctrl+W 关闭当前页，Alt+←/→ 前进后退。' },
      { category: '导航', text: '列表/树形导航：方向键上下移动，→ 展开子项，Enter 打开/进入。' },
      { category: '导航', text: 'Alt+Tab 在应用间切换，Alt+F4 关闭当前窗口（谨慎，需确认窗口已保存内容）。' },
    ],
  },
  {
    id: 'guide-uia-locate',
    name: 'UIA 语义定位',
    hints: [
      { category: 'UIA', text: '优先用 UIA 按「名称/控件类型/自动化ID」定位元素，比纯像素点击更稳定、更可验证。' },
      { category: 'UIA', text: '定位失败时回退视觉：截图 → 识别文字/图标 → 计算坐标点击，点击后再截图验证结果。' },
    ],
  },
]

/** 内置通用快捷键速查（供通用层决策引用） */
export const COMMON_SHORTCUTS: Record<string, string[]> = {
  open: ['Ctrl+O'],
  save: ['Ctrl+S'],
  new: ['Ctrl+N'],
  copy: ['Ctrl+C'],
  paste: ['Ctrl+V'],
  cut: ['Ctrl+X'],
  find: ['Ctrl+F'],
  help: ['F1'],
  refresh: ['F5'],
  undo: ['Ctrl+Z'],
  redo: ['Ctrl+Y'],
  tabNext: ['Ctrl+Tab'],
  tabClose: ['Ctrl+W'],
  switchApp: ['Alt+Tab'],
}
