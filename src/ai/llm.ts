import { resolveEndpoint, type LlmSettings } from './settings'

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string }

export class LlmError extends Error {
  code: string

  constructor(message: string, code: string) {
    super(message)
    this.code = code
  }
}

export interface LlmStreamOptions {
  messages: ChatMessage[]
  signal?: AbortSignal
  /** 要求模型只输出 JSON。仅在设置里显式开启时才随请求下发。 */
  json?: boolean
  temperature?: number
  onDelta?: (chunk: string) => void
}

/**
 * 直连一个 OpenAI 兼容的 /chat/completions 端点，逐字回调。
 *
 * 用 fetch 而不是 SDK，是因为要连的是用户自己填的任意服务商，
 * 装哪家 SDK 都不合适；各家在鉴权和参数上的差异，
 * 靠统一成 OpenAI 这套最小子集来抹平。
 */
export async function streamChat(settings: LlmSettings, options: LlmStreamOptions): Promise<string> {
  const endpoint = resolveEndpoint(settings.baseUrl)
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  // 本机模型通常不校验 Key，别塞一个空的 Bearer 进去（个别服务会因此报 401）。
  if (settings.apiKey.trim()) headers.Authorization = `Bearer ${settings.apiKey.trim()}`

  const body: Record<string, unknown> = {
    model: settings.model.trim(),
    messages: options.messages,
    stream: true,
  }
  if (options.json && settings.jsonMode) body.response_format = { type: 'json_object' }
  if (options.temperature !== undefined) body.temperature = options.temperature

  let response: Response
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      ...(options.signal ? { signal: options.signal } : {}),
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    // fetch 只在网络层失败时抛错，浏览器直连第三方接口最常见的原因就是 CORS。
    throw new LlmError(
      '连不上模型接口。多半是该服务商不允许浏览器直连（跨域限制），可以换一家，或在设置里改用支持跨域的网关地址。',
      'network_failed',
    )
  }

  if (!response.ok) {
    throw new LlmError(await readError(response), classifyStatus(response.status))
  }
  if (!response.body) {
    throw new LlmError('模型接口没有返回数据流。', 'empty_stream')
  }

  return readStream(response.body, options)
}

async function readStream(
  stream: ReadableStream<Uint8Array>,
  options: LlmStreamOptions,
): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let content = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      // 一次 chunk 可能截断在任意字节上，攒到 buffer 里再按行切，
      // 最后一行留着等下个 chunk，避免半个事件被丢掉。
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue

        const payload = trimmed.slice(5).trim()
        if (payload === '[DONE]') return content

        const delta = extractDelta(payload)
        if (delta) {
          content += delta
          options.onDelta?.(delta)
        }
      }
    }
  } finally {
    reader.releaseLock()
  }

  return content
}

function extractDelta(payload: string): string | null {
  try {
    const parsed = JSON.parse(payload) as {
      choices?: { delta?: { content?: string | null } }[]
    }
    return parsed.choices?.[0]?.delta?.content ?? null
  } catch {
    return null
  }
}

async function readError(response: Response): Promise<string> {
  let detail = ''
  try {
    const text = await response.text()
    const parsed = JSON.parse(text) as { error?: { message?: string } }
    detail = parsed.error?.message ?? text.slice(0, 200)
  } catch {
    detail = ''
  }

  const prefix = `模型接口返回 ${response.status}`
  return detail ? `${prefix}：${detail}` : prefix
}

function classifyStatus(status: number): string {
  if (status === 401 || status === 403) return 'auth_failed'
  if (status === 404) return 'not_found'
  if (status === 429) return 'rate_limited'
  if (status >= 500) return 'server_error'
  return 'request_failed'
}

export interface VisionOptions {
  prompt: string
  /** data: URL 形式的图片，如 data:image/jpeg;base64,xxx。 */
  images: string[]
  temperature?: number
  maxTokens?: number
  signal?: AbortSignal
}

/**
 * 识图：一次性取回整段答案（不流式）。
 *
 * 图片走 OpenAI 的 content 数组格式，各家通用；流式在这里没意义，
 * 识别课表就一屏字，等它一次返回反而好解析。
 */
export async function visionChat(settings: LlmSettings, options: VisionOptions): Promise<string> {
  const endpoint = resolveEndpoint(settings.baseUrl)
  const content: unknown[] = [{ type: 'text', text: options.prompt }]
  for (const image of options.images) {
    content.push({ type: 'image_url', image_url: { url: image } })
  }

  const body: Record<string, unknown> = {
    model: settings.model.trim(),
    messages: [{ role: 'user', content }],
    stream: false,
  }
  if (options.temperature !== undefined) body.temperature = options.temperature
  if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens

  let response: Response
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(settings.apiKey.trim() ? { Authorization: `Bearer ${settings.apiKey.trim()}` } : {}),
      },
      body: JSON.stringify(body),
      ...(options.signal ? { signal: options.signal } : {}),
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw new LlmError(
      '连不上模型接口。多半是该服务商不允许浏览器直连（跨域限制），可以换一家，或在设置里改用支持跨域的网关地址。',
      'network_failed',
    )
  }

  if (!response.ok) {
    const detail = await readError(response)
    // 纯文本模型收到图片基本都是 400，先按「不收图片」给提示，比让用户读原始报错有用。
    if (response.status === 400 || response.status === 422) {
      throw new LlmError(detail, 'vision_unsupported')
    }
    throw new LlmError(detail, classifyStatus(response.status))
  }

  const payload = (await response.json()) as {
    choices?: { message?: { content?: string | { text?: string }[] } }[]
  }
  const raw = payload.choices?.[0]?.message?.content
  if (typeof raw === 'string') return raw
  // 少数服务商把 content 拆成块返回，拼回来即可。
  if (Array.isArray(raw)) {
    return raw.map((part) => (typeof part === 'string' ? part : (part?.text ?? ''))).join('')
  }
  throw new LlmError('模型返回里没有文字内容，换一个识图模型试试。', 'empty_stream')
}

/** 把各种失败翻译成用户看得懂的一句话，顺带给出下一步动作。 */
export function describeLlmError(error: unknown): string {
  if (error instanceof DOMException && error.name === 'AbortError') return '已停止生成。'
  if (error instanceof LlmError) {
    switch (error.code) {
      case 'auth_failed':
        return `${error.message}｜请检查设置里的 API Key 是否正确、是否已过期。`
      case 'not_found':
        return `${error.message}｜请检查接口地址和模型名是否填对。`
      case 'rate_limited':
        return `${error.message}｜触发了限流，等一会儿再试。`
      case 'server_error':
        return `${error.message}｜服务商那边出问题了，稍后重试。`
      case 'network_failed':
        return error.message
      case 'vision_unsupported':
        return `${error.message}｜多半是当前模型不收图片。DeepSeek 要填 deepseek-flash，其他服务商要填带视觉的型号（glm-4v-flash / qwen-vl-max / gpt-4o-mini），在设置页的「识图模型」里改。`
      default:
        return error.message
    }
  }
  return error instanceof Error ? error.message : '模型调用失败。'
}

/** 连通性自检：发一条极短的请求，确认 Key、地址、模型名三者都对。 */
export async function testConnection(settings: LlmSettings): Promise<string> {
  const model = settings.model.trim()
  const text = await streamChat(settings, {
    messages: [
      { role: 'system', content: '只回复 OK 两个字母。' },
      { role: 'user', content: 'ping' },
    ],
    temperature: 0,
  })
  return `${model} 可用，回复：${text.trim().slice(0, 40) || '（空回复）'}`
}

/**
 * 问一下这个接口上有哪些模型。
 *
 * 只对本机模型有意义：Ollama 里 pull 过的模型名字带 tag（deepseek-r1:7b），
 * 手打容易错一个字符就报「model not found」。云端服务商的 /models 经常不开放，也犯不上探。
 */
export async function listModels(baseUrl: string, apiKey: string): Promise<string[]> {
  const root = baseUrl.trim().replace(/\/+$/, '').replace(/\/chat\/completions$/, '')
  const response = await fetch(`${root}/models`, {
    headers: apiKey.trim() ? { Authorization: `Bearer ${apiKey.trim()}` } : {},
  })
  if (!response.ok) throw new LlmError(`接口返回 ${response.status}`, 'network_failed')
  // 三种形状都要认：
  //   OpenAI 兼容 → {data:[{id}]}
  //   Ollama 原生 → {models:[{name}]}
  //   本机助手转发 → {models:["名字", ...]}（直接是字符串数组，别按对象取 .name）
  const payload = (await response.json()) as { data?: unknown[]; models?: unknown[] }
  const names: string[] = []
  for (const item of [...(payload.data ?? []), ...(payload.models ?? [])]) {
    if (typeof item === 'string') {
      names.push(item)
      continue
    }
    if (item && typeof item === 'object') {
      const record = item as { id?: string; name?: string; model?: string }
      const name = record.id ?? record.name ?? record.model
      if (name) names.push(name)
    }
  }
  return Array.from(new Set(names.filter(Boolean))).sort((a, b) => a.localeCompare(b))
}
