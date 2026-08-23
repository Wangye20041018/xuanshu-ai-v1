/**
 * 浏览器技能包
 *
 * 覆盖：Edge / Chrome / 360 等主流 Chromium 内核浏览器通用操作。
 */
import type { SkillPack } from '../types'

export const browserSkillPack: SkillPack = {
  id: 'browser.generic',
  app: '浏览器',
  appMatch: ['浏览器', '网页', '网站', 'Edge', 'Chrome', 'chrome', 'edge', '360'],
  version: '1.0.0',
  actions: [
    {
      id: 'open_url',
      name: '打开网址',
      description: '在浏览器中打开指定网址',
      keywords: ['打开网页', '打开网址', '访问网站', '打开链接', '上网站', '打开网站'],
      hints: [
        '浏览器地址栏快捷键：Ctrl+L（或 F6 / Alt+D），焦点自动定位到地址栏',
        '输入网址后按回车即可打开',
        '如果地址栏已被内容占据，先 Ctrl+L 全选再输入',
        '打开新标签页：Ctrl+T',
        '地址栏输入时浏览器会有智能补全，直接回车走第一个建议即可',
      ],
      shortcuts: ['Ctrl+L', 'Ctrl+T'],
      verifyHint: '确认页面加载完成，标题栏/地址栏显示目标网址',
    },
    {
      id: 'search_web',
      name: '网页搜索',
      description: '在搜索引擎中搜索关键词',
      keywords: ['搜索', '查一下', '百度', '搜一下', '搜索一下', '查资料'],
      hints: [
        '在地址栏直接输入搜索词，回车即默认搜索引擎搜索（Edge 默认必应，Chrome 默认谷歌）',
        '如需指定搜索引擎：先打开百度（www.baidu.com），在搜索框输入关键词回车',
        '搜索结果页可点击第一条结果进入目标页面',
        '如果搜索框需要点击才可输入，点击搜索框后再输入',
      ],
      shortcuts: ['Ctrl+L 然后直接输入关键词'],
      verifyHint: '确认搜索结果页已显示，且能点击进入目标页面',
    },
    {
      id: 'download_file',
      name: '下载文件',
      description: '下载网页中的文件',
      keywords: ['下载', '下载文件', '保存文件', '下载安装包'],
      hints: [
        '点击下载链接后浏览器会在底部（Edge）或右上角（Chrome）显示下载进度',
        '下载弹窗若询问保存位置，默认直接保存到"下载"文件夹',
        '下载完成后底部提示条可点击"打开文件夹"定位文件',
        '若浏览器拦截下载，可在地址栏右侧或下载提示中点击"保留"',
      ],
      shortcuts: [],
      verifyHint: '确认浏览器下载栏出现该文件且进度完成',
    },
    {
      id: 'fill_form',
      name: '填写表单',
      description: '在网页表单中填写内容',
      keywords: ['填写表单', '填表单', '注册', '登录', '填写信息', '提交表单'],
      hints: [
        '点击输入框后直接键入文字，Tab 键切换到下一个输入框',
        '表单填写完成后点击"提交/登录/注册"按钮',
        '若输入框有占位提示文字，直接输入即可覆盖',
        '下拉选择框点击后出现选项列表，点击目标选项',
        '复选框/单选框直接点击即可选中',
      ],
      shortcuts: ['Tab（切换输入框）'],
      verifyHint: '确认表单内容已填入，提交后页面有响应',
    },
  ],
}