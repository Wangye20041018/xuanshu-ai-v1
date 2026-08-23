/**
 * voicePresets.ts — 玄枢AI 音色预设
 *
 * 10 种真人级音色预设，ID 与后端 voice-engine 完全一致
 * Edge TTS 在线引擎为主，Piper 离线降级
 * 试听通过 Edge TTS 合成缓存播放
 * 引擎类型：hybrid（Edge 在线优先，离线降级 Piper）
 */

export interface VoicePreset {
  id: string
  name: string
  description: string
  gender: string
  age: string
  emotion: string
  pitch: number
  speed: number
  volume: number
  isBuiltIn: boolean
  ttsEngine: 'piper' | 'edge' | 'hybrid'
  piperModelId: string
  edgeVoiceId: string
  ttsLabel: string
}

/** 旧版 local_* ID → 新版 xuanxu_* ID 映射（向后兼容 localStorage） */
export const LEGACY_VOICE_ID_MAP: Record<string, string> = {
  'local_warm_female': 'xuanxu_warm_female',
  'local_professional_male': 'xuanxu_professional_male',
  'local_cheerful_female': 'xuanxu_cheerful_female',
  'local_calm_male': 'xuanxu_calm_male',
  'local_energetic_male': 'xuanxu_serious_male',
  'local_magnetic_male': 'xuanxu_deep_male',
  'local_sweet_female': 'xuanxu_sweet_female',
  'local_serious_male': 'xuanxu_serious_male',
  'local_natural_female': 'xuanxu_warm_female',
}

/** 10 种内置音色，与后端 voice-engine VOICE_TTS_MAP 完全一致 */
export const BUILT_IN_PRESETS: VoicePreset[] = [
  {
    id: 'xuanxu_warm_female',
    name: '温暖女声',
    description: '温暖亲切的女性音色，语调柔和自然，适合日常助手、情感交流和轻松聊天',
    gender: 'female', age: 'young', emotion: 'warm',
    pitch: 1.0, speed: 0.97, volume: 0.95, isBuiltIn: true,
    ttsEngine: 'hybrid', piperModelId: 'zh_female_warm',
    edgeVoiceId: 'zh-CN-XiaoxiaoNeural', ttsLabel: '在线(离线降级)',
  },
  {
    id: 'xuanxu_calm_male',
    name: '沉稳男声',
    description: '冷静理性的男性音色，语速从容节奏分明，适合系统播报、监控通知和技术讲解',
    gender: 'male', age: 'middle', emotion: 'calm',
    pitch: 0.90, speed: 0.82, volume: 0.85, isBuiltIn: true,
    ttsEngine: 'hybrid', piperModelId: 'zh_male',
    edgeVoiceId: 'zh-CN-YunxiNeural', ttsLabel: '在线(离线降级)',
  },
  {
    id: 'xuanxu_bright_female',
    name: '明亮女声',
    description: '明亮清脆的女性音色，语调活泼有辨识度，适合语音助手、导航播报和提醒通知',
    gender: 'female', age: 'young', emotion: 'cheerful',
    pitch: 1.05, speed: 1.05, volume: 1.0, isBuiltIn: true,
    ttsEngine: 'hybrid', piperModelId: 'zh_female_bright',
    edgeVoiceId: 'zh-CN-XiaoyiNeural', ttsLabel: '在线(离线降级)',
  },
  {
    id: 'xuanxu_deep_male',
    name: '阳刚男声',
    description: '低沉阳刚的男性音色，声音浑厚有力，适合权威播报、重要通知和正式演讲',
    gender: 'male', age: 'middle', emotion: 'professional',
    pitch: 0.85, speed: 0.88, volume: 0.90, isBuiltIn: true,
    ttsEngine: 'hybrid', piperModelId: 'zh_male',
    edgeVoiceId: 'zh-CN-YunjianNeural', ttsLabel: '在线(离线降级)',
  },
  {
    id: 'xuanxu_gentle_female',
    name: '温柔女声',
    description: '温柔细腻的女性音色，语调柔和舒缓，适合睡前故事、冥想引导和情感陪伴',
    gender: 'female', age: 'young', emotion: 'warm',
    pitch: 0.95, speed: 0.92, volume: 0.90, isBuiltIn: true,
    ttsEngine: 'hybrid', piperModelId: 'zh_female_warm',
    edgeVoiceId: 'zh-CN-XiaohanNeural', ttsLabel: '在线(离线降级)',
  },
  {
    id: 'xuanxu_professional_male',
    name: '专业男声',
    description: '沉稳专业的男性商务音色，字正腔圆节奏稳，适合数据播报、分析报告和正式场合',
    gender: 'male', age: 'middle', emotion: 'professional',
    pitch: 0.95, speed: 0.88, volume: 0.90, isBuiltIn: true,
    ttsEngine: 'hybrid', piperModelId: 'zh_male',
    edgeVoiceId: 'zh-CN-YunyangNeural', ttsLabel: '在线(离线降级)',
  },
  {
    id: 'xuanxu_cheerful_female',
    name: '活泼女声',
    description: '元气满满的年轻女性音色，语调轻快有活力，适合轻松互动、游戏聊天和娱乐场景',
    gender: 'female', age: 'young', emotion: 'cheerful',
    pitch: 1.1, speed: 1.15, volume: 1.0, isBuiltIn: true,
    ttsEngine: 'hybrid', piperModelId: 'zh_female_bright',
    edgeVoiceId: 'zh-CN-XiaoxiaoNeural', ttsLabel: '在线(离线降级)',
  },
  {
    id: 'xuanxu_elder_male',
    name: '慈祥男声',
    description: '沧桑慈祥的男性音色，语速和缓沉稳，适合长辈陪伴、历史讲述和传统文化内容',
    gender: 'male', age: 'senior', emotion: 'calm',
    pitch: 0.80, speed: 0.80, volume: 0.85, isBuiltIn: true,
    ttsEngine: 'hybrid', piperModelId: 'zh_male',
    edgeVoiceId: 'zh-CN-YunxiaNeural', ttsLabel: '在线(离线降级)',
  },
  {
    id: 'xuanxu_sweet_female',
    name: '甜美女声',
    description: '甜美可爱的女性音色，语调轻盈温柔，适合早安问候、温馨提醒和陪伴关怀',
    gender: 'female', age: 'young', emotion: 'sweet',
    pitch: 1.08, speed: 1.06, volume: 0.98, isBuiltIn: true,
    ttsEngine: 'hybrid', piperModelId: 'zh_female_warm',
    edgeVoiceId: 'zh-CN-XiaochenNeural', ttsLabel: '在线(离线降级)',
  },
  {
    id: 'xuanxu_serious_male',
    name: '严肃男声',
    description: '严肃庄重的男性音色，语气坚定有力，适合安全警告、重要通知和紧急播报',
    gender: 'male', age: 'middle', emotion: 'serious',
    pitch: 0.88, speed: 0.79, volume: 0.90, isBuiltIn: true,
    ttsEngine: 'hybrid', piperModelId: 'zh_male',
    edgeVoiceId: 'zh-CN-YunjianNeural', ttsLabel: '在线(离线降级)',
  },
]