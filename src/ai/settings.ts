const SETTINGS_KEY = 'infobutler.llm.v1'

export interface LlmSettings {
  /** 服务商 id，对应 PRESETS 里的某一项。 */
  provider: string
  baseUrl: string
  apiKey: string
  model: string
  /** 是否给请求加上 response_format: json_object。部分服务商不支持，默认关。 */
  jsonMode: boolean
  /** 识图用的模型名。留空则复用 model（很多服务商图文同一个模型）。 */
  visionModel: string
  /** 识图用的接口地址。换一家服务商识图时才需要填。 */
  visionBaseUrl: string
}

export interface Preset {
  id: string
  name: string
  baseUrl: string
  model: string
  hint: string
}

export const PRESETS: Preset[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-flash',
    hint: '便宜、中文好，文本和图片都支持，浏览器可直连',
  },
  {
    id: 'zhipu',
    name: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-flash',
    hint: 'glm-4-flash 有免费额度',
  },
  {
    id: 'moonshot',
    name: '月之暗面 Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'moonshot-v1-8k',
    hint: '长文本场景合适',
  },
  {
    id: 'siliconflow',
    name: '硅基流动',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'Qwen/Qwen2.5-7B-Instruct',
    hint: '聚合多家开源模型',
  },
  {
    id: 'qwen',
    name: '通义千问',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    hint: '阿里云 DashScope 兼容模式',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    hint: '需要能访问 OpenAI 的网络',
  },
  { id: 'custom', name: '自定义', baseUrl: '', model: '', hint: '任意 OpenAI 兼容接口' },
]

/**
 * 识图模型预设。
 *
 * 纯文本模型收不了图片，一到识图就会报 400。DeepSeek 的视觉模型叫 deepseek-flash
 * （旧的 deepseek-v4-flash-vision-exp 也能用），其余各家也都有带 -v / -vl 后缀的型号，
 * 这里单独列一份，省得用户去翻文档。
 */
export const VISION_PRESETS: Preset[] = [
  {
    id: 'deepseek-flash',
    name: 'DeepSeek V4 Flash（识图）',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-flash',
    hint: '官方视觉模型，和文本模型同一个 Key',
  },
  {
    id: 'zhipu-vision',
    name: '智谱 GLM-4V',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4v-flash',
    hint: '有免费额度',
  },
  {
    id: 'qwen-vl',
    name: '通义千问 VL',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-vl-max',
    hint: '阿里云 DashScope 兼容模式',
  },
  {
    id: 'siliconflow-vl',
    name: '硅基流动 Qwen2.5-VL',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'Qwen/Qwen2.5-VL-72B-Instruct',
    hint: '开源视觉模型，按量计费',
  },
  {
    id: 'openai-vision',
    name: 'OpenAI gpt-4o-mini',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    hint: '需要能访问 OpenAI 的网络',
  },
]

/**
 * 识图实际会打到哪个接口、哪个模型。
 *
 * resolveVision() 已经把「留空就同上」算进去了，这里再给一层判断，
 * 好在界面上说清楚「现在到底谁在读图」——文本模型被继承去识图是最常见的坑，
 * 而 DeepSeek 的文本模型并不收图片。
 */
export function visionTarget(settings: LlmSettings): {
  baseUrl: string
  model: string
  /** 没单独填，直接沿用了文本模型。 */
  inherited: boolean
} {
  const resolved = resolveVision(settings)
  return {
    baseUrl: resolved.baseUrl,
    model: resolved.model,
    inherited: !settings.visionModel.trim() && !settings.visionBaseUrl.trim(),
  }
}

export const DEFAULT_SETTINGS: LlmSettings = {
  provider: 'deepseek',
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: '',
  model: 'deepseek-flash',
  jsonMode: false,
  visionModel: '',
  visionBaseUrl: '',
}

/** 识图时实际用的配置：没单独填就整套复用文本模型。 */
export function resolveVision(settings: LlmSettings): LlmSettings {
  return {
    ...settings,
    baseUrl: settings.visionBaseUrl.trim() || settings.baseUrl,
    model: settings.visionModel.trim() || settings.model,
  }
}

export function loadSettings(): LlmSettings {
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY)
    if (!raw) return { ...DEFAULT_SETTINGS }
    const parsed = JSON.parse(raw) as Partial<LlmSettings>
    // 老版本存过 'local' / 'local-bridge' 这类已下线的服务商，落到下拉框里会是个空白项。
    // 认不出来就退回自定义，地址和模型名还留着，用户自己改成有效的一家即可。
    const provider =
      typeof parsed.provider === 'string' && PRESETS.some((item) => item.id === parsed.provider)
        ? parsed.provider
        : 'custom'
    return {
      provider,
      baseUrl: typeof parsed.baseUrl === 'string' ? parsed.baseUrl : DEFAULT_SETTINGS.baseUrl,
      apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey : '',
      model: typeof parsed.model === 'string' ? parsed.model : DEFAULT_SETTINGS.model,
      jsonMode: parsed.jsonMode === true,
      visionModel: typeof parsed.visionModel === 'string' ? parsed.visionModel : '',
      visionBaseUrl: typeof parsed.visionBaseUrl === 'string' ? parsed.visionBaseUrl : '',
    }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

/**
 * 保存模型配置。
 *
 * 返回 false 表示这次没写进去（隐私模式、沙盒 iframe、配额满都会这样）。
 * 调用方必须把它显示出来——保存失败却看着像成功，等于让人白填一遍 Key。
 */
export function saveSettings(settings: LlmSettings): boolean {
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
    return true
  } catch (error) {
    console.error('[信息管家] 模型配置保存失败', error)
    return false
  }
}

/** 配置变了。顶栏的「智能/离线」徽章靠它实时刷新，不用等窗口失焦再回来。 */
export const LLM_CHANGED_EVENT = 'infobutler:llm-changed'

export function notifyLlmChanged(): void {
  try {
    window.dispatchEvent(new Event(LLM_CHANGED_EVENT))
  } catch {
    // 老浏览器不支持自定义事件也无所谓，顶栏还会在 focus 时补一次。
  }
}

/**
 * 这个页面到底能不能往 localStorage 里写东西。
 *
 * 双击打开的本地文件一般没问题；被塞进沙盒 iframe（没有 allow-same-origin）
 * 或者无痕窗口里写过一次就会失败。启动时先探一次，别等到用户填完 Key 才发现存不住。
 */
export function storageWritable(): boolean {
  const probe = 'infobutler.probe.v1'
  try {
    window.localStorage.setItem(probe, '1')
    window.localStorage.removeItem(probe)
    return true
  } catch {
    return false
  }
}

/** 地址、模型名、Key 三样齐全才认为接入了模型，否则一律走本地规则引擎。 */
export function isReady(settings: LlmSettings): boolean {
  return (
    settings.baseUrl.trim().length > 0 &&
    settings.model.trim().length > 0 &&
    settings.apiKey.trim().length > 0
  )
}

/** 把用户填的地址补成完整的 chat completions 端点，容忍末尾斜杠和多余路径。 */
export function resolveEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  if (trimmed.endsWith('/chat/completions')) return trimmed
  return `${trimmed}/chat/completions`
}
