import { resolveEndpoint, type LlmSettings } from './settings'
import { loadBridge } from '../data/profile'

/**
 * 这些域名实测会给浏览器回跨域头（Access-Control-Allow-Origin: null 或 *），
 * 从 file:// 打开也能直连。别的不一定——智谱就完全不回，前端只能报「连不上」。
 * 这里只用来决定报错时该说什么，不参与请求。
 */
const CORS_OK_HOSTS = new Set([
  'api.deepseek.com',
  'api.moonshot.cn',
  'api.siliconflow.cn',
  'dashscope.aliyuncs.com',
  'ark.cn-beijing.volces.com',
])

function hostOf(endpoint: string): string {
  try {
    return new URL(endpoint).hostname
  } catch {
    return endpoint
  }
}

/**
 * 发一次模型请求，直连不通就经本机助手转发一次。
 *
 * 为什么要转发：页面是 file:// 打开的，Origin 是 null。浏览器在发
 * POST + Authorization 之前会先发 OPTIONS 预检，服务商不回跨域头就直接拦死，
 * fetch 抛 TypeError，前端只看得到「连不上」——其实网络是通的，是浏览器不让发。
 * 经 127.0.0.1:8787/proxy 转发，浏览器只跟本机说话，跨域这回事就没了。
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
  const payload = JSON.stringify(body)

  try {
    return await fetch(endpoint, { method: 'POST', headers, body: payload, ...(signal ? { signal } : {}) })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    // 直连失败：多半是被跨域拦了。落到下面的转发。
  }

  const { port } = loadBridge()
  const relayUrl = `http://127.0.0.1:${port}/proxy?url=${encodeURIComponent(endpoint)}`
  let relayed: Response
  try {
    relayed = await fetch(relayUrl, { method: 'POST', headers, body: payload })
  } catch {
    throw new LlmError(networkHint(endpoint, ''), 'network_failed')
  }
  // 本机助手自己的报错（地址不在白名单、上游连不上）是普通 JSON，没这个头。
  // 有它才说明这是上游的真实回答，4xx/5xx 也该按上游的意思解释。
  if (relayed.headers.get('x-relay') !== '1') {
    throw new LlmError(networkHint(endpoint, relayDetail(await relayed.text().catch(() => ''))), 'network_failed')
  }
  return relayed
}

/** 本机助手的 502 里带着具体原因（比如上游连接被拒），别丢掉。 */
function relayDetail(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: string }
    return parsed.error ?? body.slice(0, 160)
  } catch {
    return body.slice(0, 160)
  }
}

function networkHint(endpoint: string, detail: string): string {
  const host = hostOf(endpoint)
  if (detail) {
    return `连不上模型接口（${host}）。本机助手转发也失败了：${detail}`
  }
  if (!CORS_OK_HOSTS.has(host)) {
    return (
      `连不上模型接口（${host}）。这个域名不给浏览器跨域，从本机文件打开的页面发不出去，` +
      '只能经本机助手转发——而它现在没在跑。双击「启动信息管家.bat」把助手起来，再点一次。'
    )
  }
  return (
    `连不上模型接口（${host}）。直连和经本机助手转发都失败了：` +
    '先确认网络能通（代理、VPN），再看设置里的接口地址有没有写错。'
  )
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

export interface VisionOptions {
  prompt: string
  /** data: URL 形式的图片，如 data:image/jpeg;base64,xxx。 */
  images: string[]
  temperature?: number
  maxTokens?: number
  signal?: AbortSignal
}

/**
 * 各家的 max_tokens 上限不一样，而且不会写在文档的显眼处：
 * 智谱 glm-4v-flash 只收 1~1024，超一个数就 400「max_tokens参数非法」。
 * 撞过一次就把上限按域名记下来，后面的请求直接按上限发。
 */
const TOKEN_CAPS = new Map<string, number>()

/** 已经知道的上限。识图那边用它算预算，免得明知不可为还往上加。 */
export function visionTokenCap(baseUrl: string): number | undefined {
  return TOKEN_CAPS.get(hostOf(resolveEndpoint(baseUrl)))
}

/** 从「限制数值范围[1,1024]」这类话里把上限抠出来。 */
function capFromMessage(detail: string): number | null {
  const match = detail.match(/max_tokens[^0-9]*\[?\s*\d+\s*,\s*(\d+)/i)
  if (!match) return null
  const value = Number(match[1])
  return Number.isFinite(value) && value > 0 ? value : null
}

/** 记下这家真正的上限，返回「该按多少重发」；已经按上限发过就返回 null。 */
function lowerTokenCap(endpoint: string, detail: string, current?: number): number | null {
  if (!/max_tokens/i.test(detail)) return null
  const found = capFromMessage(detail)
  if (!found) return null
  const host = hostOf(endpoint)
  const known = TOKEN_CAPS.get(host)
  if (known !== undefined && known <= found) return null
  TOKEN_CAPS.set(host, found)
  if (current !== undefined && current <= found) return null
  return found
}

/**
 * 内容审核把整个请求拒了。
 *
 * 智谱常见的一句话：「系统检测到输入或生成内容可能包含不安全或敏感内容」。
 * 它既可能是图里的字（姓名、学号），也可能是提示语本身，还可能是校对模型误判，
 * 换一句话重问有时就过了，所以调用方可以拿这个码再做一次更朴素的尝试。
 */
function contentFiltered(detail: string): boolean {
  return /敏感|不安全|审核|违规|safety|moderation|risk control/i.test(detail)
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
  const knownCap = TOKEN_CAPS.get(hostOf(endpoint))
  if (options.maxTokens !== undefined) {
    body.max_tokens = knownCap ? Math.min(options.maxTokens, knownCap) : options.maxTokens
  }

  let response = await postChat(endpoint, body, settings.apiKey, options.signal)

  if (!response.ok) {
    let detail = await readError(response)
    // 400 有时不是「不收图」，而是 max_tokens 超了这家允许的范围。
    // 这种错误是自解释的，把上限记下来、按上限重发一次，比让用户自己翻文档强。
    const cap = lowerTokenCap(endpoint, detail, body.max_tokens as number | undefined)
    if (cap !== null) {
      body.max_tokens = cap
      response = await postChat(endpoint, body, settings.apiKey, options.signal)
      if (!response.ok) detail = await readError(response)
    }
    if (!response.ok) {
      const paramIssue = /max_tokens|temperature|invalid|参数|范围/i.test(detail)
      if (contentFiltered(detail)) throw new LlmError(detail, 'content_filter')
      if (paramIssue) throw new LlmError(detail, 'request_failed')
      // 纯文本模型收到图片基本都是 400，先按「不收图片」给提示，比让用户读原始报错有用。
      if (response.status === 400 || response.status === 422) {
        throw new LlmError(detail, 'vision_unsupported')
      }
      throw new LlmError(detail, classifyStatus(response.status))
    }
  }

  const payload = (await response.json()) as {
    choices?: {
      message?: { content?: string | { text?: string }[]; reasoning_content?: string }
      finish_reason?: string
    }[]
    usage?: { completion_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number } }
  }
  const choice = payload.choices?.[0]
  const raw = choice?.message?.content
  let text = ''
  if (typeof raw === 'string') text = raw
  // 少数服务商把 content 拆成块返回，拼回来即可。
  else if (Array.isArray(raw)) {
    text = raw.map((part) => (typeof part === 'string' ? part : (part?.text ?? ''))).join('')
  }

  if (text.trim()) return text

  // 空内容要把「为什么空」查清楚：finish_reason=length 是输出被截断
  // （推理模型把预算全花在思考上时 content 就是空的），其余多半是模型压根不看图。
  const reason = choice?.finish_reason ?? 'unknown'
  const used = payload.usage?.completion_tokens
  const thought = choice?.message?.reasoning_content?.length ?? 0
  const facts = [
    `finish_reason=${reason}`,
    used ? `输出 ${used} tokens` : '',
    thought ? `其中思考内容 ${thought} 字` : '',
  ]
    .filter(Boolean)
    .join('，')

  if (reason === 'length') {
    throw new LlmError(`模型输出被长度限制截断了（${facts}）`, 'truncated')
  }
  // 带上返回体前 160 字：万一网关给的不是标准结构（没有 choices 之类），
  // 有这段原文才查得下去。
  const shape = JSON.stringify(payload).slice(0, 160)
  throw new LlmError(`模型返回了空内容（${facts}；返回体 ${shape}）`, 'empty_content')
}

/** 把各种失败翻译成用户看得懂的一句话，顺带给出下一步动作。 */
export function describeLlmError(error: unknown): string {
  if (error instanceof DOMException && error.name === 'AbortError') return '已停止生成。'
  if (error instanceof LlmError) {
    switch (error.code) {
      case 'auth_failed':
        return `${error.message}｜请检查设置里的 API Key 是否正确、是否已过期。`
      case 'request_failed':
        return `${error.message}｜接口不认这次请求的参数：多半是这个型号对参数有更严的限制（比如 max_tokens 上限），或者「识图模型」填成了文本型号。`
      case 'content_filter':
        return `${error.message}｜这是服务商的内容审核把请求拦了，跟你的网络、Key 都无关。截图里带姓名、学号、证件号，或者课程名被审核词命中，都会这样。先试「只框课表那块」的小图；还不行就换一家视觉模型——通义 qwen-vl-max、硅基流动的 Qwen-VL 对这类内容宽松得多。`
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
      case 'truncated':
        return `${error.message}｜这个型号是「先想很久再说话」的那种，读表格经常把预算全花在思考上。换一个不做长推理的视觉型号最省事（glm-4v-flash 有免费额度，或 qwen-vl-max / gpt-4o-mini），设置页的识图模型一栏可以直接切。`
      case 'empty_content':
        return `${error.message}｜这个型号看到了图但没吐字：要么它不是视觉模型，要么图里字太小看不清。把「识图模型」改成 deepseek-flash，截图时只框课表那块（别整屏截）再试。`
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
