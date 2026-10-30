import type { NoticeMessage, Profile } from '../schedule/notice'

/**
 * 身份与本机助手的配置。
 *
 * 单独存一份，不塞进主数据库：身份只有本机用，跟着备份导出反而会带到别的机器上。
 */

const PROFILE_KEY = 'infobutler.profile.v1'
const BRIDGE_KEY = 'infobutler.bridge.v1'

export const DEFAULT_PROFILE: Profile = { org: '', roles: '', keywords: '' }

export interface BridgeConfig {
  /** 关掉就只用手动粘贴，不会去连本机端口。 */
  enabled: boolean
  port: number
  /** 往回取几天，1~7。1 就是只看今天。 */
  days: number
}

export const DEFAULT_BRIDGE: BridgeConfig = { enabled: false, port: 8787, days: 1 }

/** 收集范围只在 1~7 天之间，超出就夹回来。 */
export function clampDays(value: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.max(1, Math.min(7, Math.round(value)))
}

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return fallback
    return { ...fallback, ...(JSON.parse(raw) as T) }
  } catch {
    return fallback
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // 存不下就算了，身份信息丢了不影响主流程，下次打开重填即可。
  }
}

export function loadProfile(): Profile {
  return read<Profile>(PROFILE_KEY, DEFAULT_PROFILE)
}

export function saveProfile(profile: Profile): void {
  write(PROFILE_KEY, profile)
}

export function loadBridge(): BridgeConfig {
  return read<BridgeConfig>(BRIDGE_KEY, DEFAULT_BRIDGE)
}

export function saveBridge(config: BridgeConfig): void {
  write(BRIDGE_KEY, config)
}

/**
 * 最近一次读取里，每个群都有谁说过话。
 *
 * 群里要只看某几个人时，名字手打最容易出错——打错一个字，整个群就一条都读不到。
 * 所以读完顺手记下来，设置页里点一下就加进白名单。按应用分开记：
 * 同一个人微信里叫「王超老师」、飞书里叫「王超」。
 */
export type SpeakerMap = Record<string, Record<string, string[]>>

const SPEAKERS_KEY = 'infobutler.speakers.v1'

export function loadSpeakers(): SpeakerMap {
  return read<SpeakerMap>(SPEAKERS_KEY, {})
}

/** 把这次读到的说话人合进已有的名单，去重、保序，每个群最多留 30 个。 */
export function recordSpeakers(messages: NoticeMessage[]): SpeakerMap {
  const merged = loadSpeakers()
  for (const message of messages) {
    const channel = message.channel ?? ''
    const group = message.source ?? ''
    const sender = (message.sender ?? '').trim()
    if (!channel || !group || !sender || sender === '未署名') continue
    const bucket = (merged[channel] ??= {})
    const list = (bucket[group] ??= [])
    if (!list.includes(sender)) list.push(sender)
  }
  for (const groups of Object.values(merged)) {
    for (const [group, list] of Object.entries(groups)) {
      groups[group] = list.slice(0, 30)
    }
  }
  write(SPEAKERS_KEY, merged)
  return merged
}

/** 本机服务那边的完整配置，白名单会话名存在这里，不在浏览器里。 */
export interface BridgeRemoteConfig {
  port: number
  wechat: { enabled: boolean; sessions: string[]; max_messages: number; days: number }
  feishu: {
    enabled: boolean
    /** sdk：走开放平台接口直读群消息；clipboard：弹窗口 + 复制。 */
    mode: 'clipboard' | 'sdk'
    /** sdk 模式下要读的群名。 */
    chats: string[]
    days: number
    window: string
    use_clipboard: boolean
  }
}

export interface BridgePatch {
  port?: number
  wechat?: { enabled?: boolean; sessions?: string[]; max_messages?: number; days?: number }
  feishu?: {
    enabled?: boolean
    mode?: 'clipboard' | 'sdk'
    chats?: string[]
    days?: number
    window?: string
    use_clipboard?: boolean
  }
}

async function bridgeFetch(config: BridgeConfig, path: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(`http://127.0.0.1:${config.port}${path}`, {
    ...init,
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    cache: 'no-store',
  })
  if (!response.ok) throw new Error(`本机助手返回 ${response.status}`)
  return response
}

/** 读本机服务上的白名单配置。 */
export async function loadRemoteBridge(config: BridgeConfig): Promise<BridgeRemoteConfig | null> {
  const response = await bridgeFetch(config, '/config')
  const data = (await response.json()) as { config?: BridgeRemoteConfig }
  return data.config ?? null
}

/** 把白名单写回本机服务的 config.json，改完立即生效，不用重启。 */
export async function pushBridgeConfig(config: BridgeConfig, patch: BridgePatch): Promise<BridgeRemoteConfig> {
  const response = await bridgeFetch(config, '/config', {
    method: 'POST',
    body: JSON.stringify(patch),
  })
  const data = (await response.json()) as { ok?: boolean; config?: BridgeRemoteConfig; error?: string }
  if (!data.ok || !data.config) throw new Error(data.error ?? '写入失败')
  return data.config
}

/** 让本机服务报一遍微信会话名，省得手打群名。 */
export interface BridgeHealth {
  python: string
  wechatReady: boolean
  wechatError: string
}

/**
 * 问一下本机助手自己好不好。
 *
 * 主要看两件事：它跑在哪个解释器上、那个解释器能不能读微信。
 * 微信那条路依赖 wxauto4，装在一个没有它的 Python 里就会安静地不工作，
 * 与其让用户对着"没连上"猜，不如把解释器路径直接摆出来。
 */
export async function fetchBridgeHealth(config: BridgeConfig): Promise<BridgeHealth | null> {
  try {
    const response = await bridgeFetch(config, '/health')
    const data = (await response.json()) as {
      python?: string
      wechat_ready?: boolean
      wechat_error?: string
    }
    return {
      python: data.python ?? '',
      wechatReady: Boolean(data.wechat_ready),
      wechatError: data.wechat_error ?? '',
    }
  } catch {
    return null
  }
}

export async function fetchWechatSessions(config: BridgeConfig): Promise<{ sessions: string[]; error: string }> {
  const response = await bridgeFetch(config, '/sessions')
  const data = (await response.json()) as { sessions?: string[]; error?: string }
  return { sessions: data.sessions ?? [], error: data.error ?? '' }
}

export interface FeishuStatus {
  ok: boolean
  error?: string
  app_ready: boolean
  client_id: string
  logged_in: boolean
  expires_in: number
  has_refresh: boolean
  scope: string
  login: { state: 'idle' | 'pending' | 'ok' | 'error'; url: string; error: string }
}

/** 飞书授权状态。没建应用、没登录、token 还剩多久，都靠它。 */
export async function fetchFeishuStatus(config: BridgeConfig): Promise<FeishuStatus> {
  const response = await bridgeFetch(config, '/feishu/status')
  const data = (await response.json()) as Partial<FeishuStatus>
  return {
    ok: Boolean(data.ok),
    error: data.error ?? '',
    app_ready: Boolean(data.app_ready),
    client_id: data.client_id ?? '',
    logged_in: Boolean(data.logged_in),
    expires_in: data.expires_in ?? 0,
    has_refresh: Boolean(data.has_refresh),
    scope: data.scope ?? '',
    login: data.login ?? { state: 'idle', url: '', error: '' },
  }
}

/** 我能在飞书里看到的群名。授权后用来做群名选择，不用手打。 */
export async function fetchFeishuChats(config: BridgeConfig): Promise<{ chats: string[]; error: string }> {
  const response = await bridgeFetch(config, '/feishu/chats')
  const data = (await response.json()) as { chats?: string[]; error?: string }
  return { chats: data.chats ?? [], error: data.error ?? '' }
}

/** 发起扫码授权：后台起一次设备码流程，返回的 url 给用户扫。 */
export async function startFeishuLogin(config: BridgeConfig): Promise<{ ok: boolean; url: string; error: string }> {
  const response = await bridgeFetch(config, '/feishu/login', { method: 'POST' })
  const data = (await response.json()) as { ok?: boolean; url?: string; error?: string }
  return { ok: Boolean(data.ok), url: data.url ?? '', error: data.error ?? '' }
}

/**
 * 让本机助手用默认浏览器打开飞书授权页。
 *
 * 网页自己开新窗口在 file:// 下常被拦掉，交给本机脚本更稳。失败也不用管，
 * 界面上链接照旧显示着，手动点是一样的。
 */
export async function openFeishuAuth(config: BridgeConfig, url: string): Promise<boolean> {
  try {
    const response = await fetch(
      `http://127.0.0.1:${config.port}/feishu/open?url=${encodeURIComponent(url)}`,
      { headers: { Accept: 'application/json' }, cache: 'no-store' },
    )
    if (!response.ok) return false
    const data = (await response.json()) as { ok?: boolean }
    return Boolean(data.ok)
  } catch {
    return false
  }
}

/**
 * 让本机助手把微信/飞书窗口弹到前台。
 *
 * 网页自己唤不起客户端（URL scheme 不一定注册了），交给本机脚本更稳。
 * 飞书读不到文本，弹到前台后由用户复制，脚本再读剪贴板。
 */
export async function activateApp(config: BridgeConfig, app: 'wechat' | 'feishu'): Promise<boolean> {
  const response = await fetch(`http://127.0.0.1:${config.port}/activate?app=${app}`, {
    headers: { Accept: 'application/json' },
    cache: 'no-store',
  })
  if (!response.ok) throw new Error(`本机助手返回 ${response.status}`)
  const data = (await response.json()) as { ok?: boolean }
  return Boolean(data.ok)
}

/**
 * 从本机助手取最近几天的消息。
 *
 * days 走请求参数而不是只读 config：改范围要立刻生效，
 * 不该为了换天数去重启一个常驻进程；config 里的值只是默认值。
 *
 * 助手是自己电脑上跑的 Python 服务，只监听 127.0.0.1，数据不出本机。
 * 连不上会直接抛错，界面上给用户一句可操作的提示。
 */
export interface TodayReport {
  messages: NoticeMessage[]
  /** 本机助手的抱怨：微信没读成、飞书没授权、剪贴板是空的，都会写在这里。 */
  warnings: string[]
  /** 本机助手认为的今天，取值失败时是空串。 */
  date: string
}

export async function fetchTodayReport(config: BridgeConfig, days = config.days): Promise<TodayReport> {
  const span = clampDays(days)
  const response = await fetch(`http://127.0.0.1:${config.port}/today?days=${span}`, {
    headers: { Accept: 'application/json' },
    cache: 'no-store',
  })
  if (!response.ok) throw new Error(`本机助手返回 ${response.status}`)

  const data = (await response.json()) as
    | { messages?: NoticeMessage[]; warnings?: string[]; date?: string }
    | NoticeMessage[]
  const raw = Array.isArray(data) ? data : (data.messages ?? [])
  return {
    messages: raw
      .filter((item) => item && typeof item.text === 'string' && item.text.trim().length > 0)
      .map((item) => ({
        source: item.source ?? '本机助手',
        sender: item.sender ?? '',
        at: item.at ?? '',
        // 老版本的后端不返回 date，留空让解析时按今天算。
        date: item.date ?? '',
        // 老版本的后端不分渠道，留空，界面上就不显示「微信 / 飞书」标签。
        channel: item.channel ?? '',
        text: item.text.trim(),
      })),
    warnings: Array.isArray(data) ? [] : (data.warnings ?? []),
    date: Array.isArray(data) ? '' : (data.date ?? ''),
  }
}

export async function fetchToday(config: BridgeConfig, days = config.days): Promise<NoticeMessage[]> {
  return (await fetchTodayReport(config, days)).messages
}
