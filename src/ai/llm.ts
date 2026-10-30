import { resolveEndpoint, type LlmSettings } from './settings'

function hostOf(endpoint: string): string {
  try {
    return new URL(endpoint).hostname
  } catch {
    return endpoint
  }
}

/**
 * 发一次模型请求。
 *
 * 页面是 file:// 打开的，Origin 是 null。有些服务商（智谱就是）在 OPTIONS 预检里
 * 不回跨域头，浏览器直接把请求拦死，fetch 抛 TypeError——看着像断网，其实是浏览器不让发。
 * 这类服务商在这个应用里用不了，只能换成回跨域头的那几家（DeepSeek、通义、硅基流动、Kimi）。
 */
async function postChat(
  endpoint: string,
  body: Record<string, unknown>,
  apiKey: string,
  signal?: AbortSignal,
): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  // 没填 Key 就别塞一个空的 Bearer 进去，个别网关会因此报 401 而不是「缺鉴权」。
  if (apiKey.trim()) headers.Authorization = `Bearer ${apiKey.trim()}`

  try {
    return await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body), ...(signal ? { signal } : {}) })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    const host = hostOf(endpoint)
    throw new LlmError(
      `连不上模型接口（${host}）。两种可能：网络不通（代理、VPN），` +
        '或者这家服务商不允许浏览器直连（跨域），后者在当前形态下没法绕，换一家能直连的即可。',
      'network_failed',
    )
  }
}

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

  const body: Record<string, unknown> = {
    model: settings.model.trim(),
    messages: options.messages,
    stream: true,
  }
  if (options.json && settings.jsonMode) body.response_format = { type: 'json_object' }
  if (options.temperature !== undefined) body.temperature = options.temperature

  const response = await postChat(endpoint, body, settings.apiKey, options.signal)

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
