/**
 * 微信（Windows 版）技能包
 *
 * 覆盖：微信 PC 端常用收发操作。
 */
import type { SkillPack } from '../types'

export const wechatSkillPack: SkillPack = {
  id: 'wechat.pc',
  app: '微信',
  appMatch: ['微信', 'wechat', 'WeChat', '发消息', '发文件'],
  version: '1.0.0',
  actions: [
    {
      id: 'send_message',
      name: '发送消息',
      description: '给联系人发送文字消息',
      keywords: ['发消息', '发微信', '告诉', '发送消息', '微信说', '发信息'],
      hints: [
        '微信 PC 端主窗口左侧为联系人/群聊列表',
        '可通过顶部搜索框（Ctrl+F）搜索联系人名称',
        '点击联系人后，底部输入框键入文字，回车发送',
        '发送快捷键：Enter（默认）或 Ctrl+Enter（设置中可切换）',
        '如果输入框未聚焦，先点击输入框再打字',
      ],
      shortcuts: ['Ctrl+F（搜索）', 'Enter（发送）'],
      verifyHint: '确认消息已出现在聊天窗口，且无红色感叹号（发送失败标志）',
    },
    {
      id: 'send_file',
      name: '发送文件',
      description: '给联系人发送文件/图片',
      keywords: ['发文件', '传文件', '发图片', '发送文件', '发文档', '传图片'],
      hints: [
        '打开聊天窗口后，点击输入框左侧"+"号或文件图标',
        '选择"文件"后弹出文件选择框，定位文件后点击"打开"',
        '文件发送前会出现在输入框上方，点击"发送"按钮确认发送',
        '拖拽文件到聊天窗口也可直接发送',
        '发送大文件时请等待进度条完成',
      ],
      shortcuts: [],
      verifyHint: '确认文件出现在聊天窗口且发送成功（无感叹号）',
    },
    {
      id: 'open_chat',
      name: '打开聊天',
      description: '打开指定联系人或群聊的聊天窗口',
      keywords: ['打开聊天', '找联系人', '打开群', '和谁聊', '找群'],
      hints: [
        '主窗口顶部搜索框（Ctrl+F）输入联系人/群名称',
        '搜索结果中点击目标项即打开聊天窗口',
        '如果联系人不在最近列表，搜索是最快方式',
        '搜索支持拼音首字母（如输入 wb 找"王博"）',
      ],
      shortcuts: ['Ctrl+F'],
      verifyHint: '确认聊天窗口标题为目标联系人或群聊名称',
    },
  ],
}