import { parseDueDate } from '../ai/text'
import type { CourseRow } from '../data/types'
import { shiftDays, today } from '../utils/date'
import { courseOccursOn, isoWeekday } from './occurrence'

/**
 * 通知解析：把微信/飞书里当天的一堆消息，变成「要不要去、几点、在哪」的候选日程。
 *
 * 和课表解析一个态度：认不出来的就交给用户确认，不猜一个看着像的答案。
 * 群里发的通知本来就写得随意，宁可多问一句，也别把没谱的事直接写进日历。
 */

export interface Profile {
  /** 班级 / 学院，例如「2026级自动化1班」。 */
  org: string
  /** 职务，逗号分隔，例如「班长, 社团干事」。 */
  roles: string
  /** 额外关注词，逗号分隔，例如「奖学金, 志愿, 讲座」。 */
  keywords: string
}

export interface NoticeMessage {
  /** 来源：微信群名、飞书会话名。 */
  source: string
  /** 发送人。 */
  sender: string
  /** 消息时间，形如「14:32」或 ISO 字符串。 */
  at: string
  /**
   * 这条消息属于哪一天（YYYY-MM-DD）。
   * 往回取好几天时，「明天下午两点」要以这条消息自己那天为基准算，
   * 不然前天的通知会被算成明天的日程。空字符串表示按今天算。
   */
  date?: string
  text: string
}

export interface NoticeItem {
  id: string
  source: string
  sender: string
  raw: string
  /** 事项名，取第一句。 */
  title: string
  date: string | null
  time: string | null
  endTime: string | null
  location: string | null
  /** 报名/交材料的截止日期。 */
  deadline: string | null
  /** mine 与自己有关，maybe 拿不准，other 明显是别人的事。 */
  relevance: 'mine' | 'maybe' | 'other'
  /** 要不要弹窗问一句。 */
  needConfirm: boolean
  /** 事情的发生日期已经过去了（往回翻一周时会有这种）。 */
  expired: boolean
  /** 为什么这么判断，界面上直接显示给用户看。 */
  reason: string
}

const SIGNUP_WORDS = /报名|自愿|有意|是否参加|接龙|统计|名额|可选|选报|扫码|有意者|需要参加|请回复/
const EVERYONE_WORDS = /(全体|所有|每位|各班|全班|同学|同学们)/
// 校区/园区/教学楼这些也是常见地点词，缺了「津南校区理科组团5B」就认不出来
const PLACE_WORDS = /(?:校区|园区|教学楼|楼|室|厅|馆|场|中心|教室|会议室|操场|广场|报告厅|礼堂|机房|实验室)/
// 「飞书私信我」不是线上会议；只有「飞书会议」「线上/直播」这类才算地点。
const ONLINE_WORDS = /腾讯会议|飞书会议|钉钉会议|Zoom|线上|直播/

function splitTags(value: string): string[] {
  return (value ?? '')
    .split(/[,，、;；]/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2)
}

function pad(value: number): string {
  return `${value}`.padStart(2, '0')
}

function toMinutes(hm: string): number {
  const [hour, minute] = hm.split(':').map((part) => Number(part) || 0)
  return hour * 60 + minute
}

/* -------------------------------- 字段抽取 -------------------------------- */

function normalize(hour: string, minute: string, period?: string): string {
  let value = Number(hour)
  if (period && /下午|晚上|晚|傍晚|夜/.test(period)) {
    if (value < 12) value += 12
  } else if (period && /中午/.test(period)) {
    if (value < 11) value += 12
  }
  return `${pad(value % 24)}:${minute}`
}

const TIME_RANGE =
  /(上午|下午|中午|晚上)?\s*(\d{1,2})\s*[:：]\s*(\d{2})\s*[-–—~至到]\s*(上午|下午|中午|晚上)?\s*(\d{1,2})\s*[:：]\s*(\d{2})/
const TIME_SINGLE = /(上午|下午|中午|晚上)?\s*(\d{1,2})\s*[:：]\s*(\d{2})/
// 中文数字时间。只认「点」不认「时」——「统一时间」里的「一时」不是时间点。
// 带时段（上午/今晚/下午）的直接算；不带时段的必须写明分钟（点半/点整/点一刻），
// 否则「注意一点」会被当成凌晨 1 点。
const TIME_CHINESE =
  /(清晨|凌晨|早上|早|上午|中午|下午|傍晚|晚上|晚)\s*([零一二三四五六七八九十两]{1,3})\s*点\s*(半|一刻|三刻|整)?/
const TIME_CHINESE_MINUTE =
  /([零一二三四五六七八九十两]{1,3})\s*点\s*(半|一刻|三刻)/
const CN_DIGITS: Record<string, number> = {
  零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
}

/** 「十」→10、「十一」→11、「二十」→20、「两」→2；认不出返回 null。 */
function cnNumber(text: string): number | null {
  const ten = text.indexOf('十')
  if (ten === -1) {
    const single = CN_DIGITS[text]
    return single === undefined ? null : single
  }
  const high = ten === 0 ? 1 : CN_DIGITS[text[0]]
  const low = ten === text.length - 1 ? 0 : CN_DIGITS[text[ten + 1]]
  if (high === undefined || low === undefined) return null
  return high * 10 + low
}

function cnMinute(marker: string | undefined): string {
  if (marker === '半') return '30'
  if (marker === '一刻') return '15'
  if (marker === '三刻') return '45'
  return '00'
}

/** 把时间片段抹掉，免得后面找地点、取标题时被「10点」「2:00」带偏。 */
function stripTime(text: string): string {
  return text
    .replace(TIME_RANGE, ' ')
    .replace(TIME_SINGLE, ' ')
    .replace(TIME_CHINESE, ' ')
}

function parseNoticeTime(text: string): { start: string; end: string | null } | null {
  const range = text.match(TIME_RANGE)
  if (range) {
    // 「下午2:00-4:00」只标了一次下午，两端都要跟着改。
    const period = range[1] ?? range[4]
    return {
      start: normalize(range[2], range[3], period ?? undefined),
      end: normalize(range[5], range[6], period ?? range[4] ?? undefined),
    }
  }

  const single = text.match(TIME_SINGLE)
  if (single) return { start: normalize(single[2], single[3], single[1]), end: null }

  const chinese = text.match(TIME_CHINESE)
  if (chinese) {
    const hour = cnNumber(chinese[2])
    if (hour !== null && hour >= 0 && hour <= 24) {
      return { start: normalize(String(hour), cnMinute(chinese[3]), chinese[1]), end: null }
    }
  }

  const chineseMinute = text.match(TIME_CHINESE_MINUTE)
  if (chineseMinute) {
    const hour = cnNumber(chineseMinute[1])
    if (hour !== null && hour >= 6 && hour <= 23) {
      return { start: normalize(String(hour), cnMinute(chineseMinute[2])), end: null }
    }
  }
  return null
}

/**
 * 截止日期和活动日期要分开：通知里常同时写着「11月5日截止报名」和「11月8日开会」，
 * 混在一起会把活动排到截止日那天去。
 */
function parseDeadline(text: string, baseDate: string): { deadline: string | null; rest: string } {
  const matched = text.match(
    /(?:截止|截至|请于|报名|提交|回复|反馈|确认)[^。！!？?\n；;]{0,16}?(\d{1,2}\s*月\s*\d{1,2}\s*[日号]|\d{4}-\d{1,2}-\d{1,2}|(?:本周|下周)?\s*周\s*[一二三四五六日天])/,
  )
  if (!matched) return { deadline: null, rest: text }
  const date = parseDueDate(matched[0], baseDate)
  return { deadline: date, rest: text.replace(matched[0], ' ') }
}

function parseLocation(text: string): string | null {
  const labelled = text.match(/(?:地点|位置|会议地点|活动地点|举办地点|集合地点|教室)\s*[:：]\s*([^\s，,。；;、]{2,24})/)
  if (labelled) return labelled[1]

  const online = text.match(ONLINE_WORDS)
  if (online) return online[0]

  // 先把时间抹掉，「于明天上午10点到行政楼A305」才不会把整段当成地点。
  const clean = stripTime(text)
  // 地点前面得有个明显的边界（在/于/到/标点/行首），否则「前把体检表交到辅导员办公室」
  // 会把前半句一起吞进来。门牌号那一截要求带数字，「中心有」之类的虚字就不会跟进来。
  const place = clean.match(
    new RegExp(
      `(?:^|[\\s，,。；;:：、]|在|于|到|前往)([\\u4e00-\\u9fa5A-Za-z0-9\\-]{2,12}${PLACE_WORDS.source})([A-Za-z]?[\\u4e00-\\u9fa5]{0,2}\\d{1,4})?`,
    ),
  )
  if (place) {
    const candidate = trimLeadingWords(`${place[1]}${place[2] ?? ''}`)
    // 只剩「校区」「楼」这种光秃秃的地点词，说明前面那截是动词，宁可不要；
    // 「A校区或B校区」是二选一，不是地址，也不要。
    if (candidate.length >= 3 && !candidate.includes('或')) return candidate
  }

  const room = clean.match(/(?:在|于)\s*([\u4e00-\u9fa5]{1,8}\d{2,4})/)
  if (room) return room[1]
  return null
}

/** 地点前面粘了动词（「前把体检表交到辅导员办公室」）时，从最后一个介词后面截断。 */
function trimLeadingWords(value: string): string {
  // 动词也算边界：「请大家注意投票校区」里的地点其实是「校区」，但整句不是地点。
  const markers = ['在', '于', '到', '前往', '地点', '选择', '注意', '不要', '投票', '修改', '查看']
  let cut = -1
  let width = 0
  for (const marker of markers) {
    const index = value.lastIndexOf(marker)
    // 记录命中的是整个标记，不是首字——「选择」要切两个字，只切一个会剩「择…」
    if (index > cut) {
      cut = index
      width = marker.length
    }
  }
  if (cut >= 0) return value.slice(cut + width)
  return value
}

function extractTitle(text: string): string {
  let value = text
    .replace(/^【[^】]*】\s*/, '')
    .replace(/^\s*(?:重要)?(?:通知|温馨提示|提醒)\s*[:：]?\s*/, '')
    .replace(/^\s*(?:各位同学|同学们|大家|同学们好)\s*[:：，,]?\s*/, '')
    // 日期、时间、地点都从标题里去掉，不然标题开头就是一串数字。
    .replace(/\d{4}-\d{1,2}-\d{1,2}/g, ' ')
    .replace(/\d{1,2}\s*月\s*\d{1,2}\s*[日号]/g, ' ')
    .replace(/(本周|下周|本|下)?\s*(?:周|星期|礼拜)\s*[一二三四五六日天]/g, ' ')
    .replace(/(今天|明天|后天|大后天)/g, ' ')
    .replace(TIME_RANGE, ' ')
    .replace(TIME_SINGLE, ' ')
    .replace(TIME_CHINESE, ' ')
    .replace(
      new RegExp(
        `(?:在|于)\\s*[\\u4e00-\\u9fa5A-Za-z0-9\\-]{2,20}${PLACE_WORDS.source}([A-Za-z]?[\\u4e00-\\u9fa5]{0,2}\\d{1,4})?`,
        'g',
      ),
      ' ',
    )
    .replace(/(?:在|于)\s*[\u4e00-\u9fa5]{1,8}\d{2,4}/g, ' ')
    // 「9点-11点」剥掉前半段后会剩下「-11点」，这里把落单的后半段也清掉。
    .replace(/[-–—~至到]\s*\d{1,2}\s*[点时](半)?/g, ' ')
    .replace(/\d{1,2}\s*[点时](半)?/g, ' ')
    .replace(/[（(]\s*[)）]/g, '')
    .replace(/[【\[〖]\s*[】\]〗]/g, '')

  value = value.split(/[。！!？?\n；;]/)[0]
  value = value
    .replace(/\s{2,}/g, ' ')
    .replace(/^[:：，,、\s]+/, '')
    .replace(/[:：，,、\s]+$/, '')
    // 「请于11月5日前交到……」里的日期被抹掉后，「请」会孤零零留在末尾。
    .replace(/[请麻烦]+$/, '')
    // 时间被抹掉后，「文化节将于」这种半截话会把「将于」留在末尾
    .replace(/(?:将于|于|在|为|由|从|对|与|和|及)$/, '')
    .replace(/[:：，,、\s]+$/, '')
    .replace(/[:：，,、\s]+$/, '')
  // 时间和地点被抹掉后常剩两截（「…文化节将于」「在某某大学校区」），取前一截
  const parts = value.split(/\s+/).filter(Boolean)
  if (parts.length > 1 && parts[0].length >= 6) value = parts[0]
  value = value.replace(/(?:将于|于|在|为|由|从|对|与|和|及)$/, '').trim()

  return value ? value.slice(0, 24) : text.slice(0, 24)
}

/* -------------------------------- 相关性判断 -------------------------------- */

function judgeRelevance(text: string, profile: Profile): { relevance: NoticeItem['relevance']; reason: string } {
  // 先看有没有点名别的班级。「请2026级2班班长开会」里也带「班长」，
  // 如果先比身份词，就会把别人的事当成自己的。
  const mentioned = [...text.matchAll(/([一二三四五六七八九十\d]{1,3})班/g)].map((item) => `${item[1]}班`)
  const myClass = profile.org.match(/([一二三四五六七八九十\d]{1,3})班/)?.[1]
  if (mentioned.length > 0 && myClass && !mentioned.includes(`${myClass}班`)) {
    return { relevance: 'other', reason: `只点了 ${mentioned.join('、')}，不是你所在的 ${myClass}班` }
  }

  const tags = [...splitTags(profile.org), ...splitTags(profile.roles), ...splitTags(profile.keywords)]
  const hit = tags.find((tag) => text.includes(tag))
  if (hit) return { relevance: 'mine', reason: `提到了「${hit}」，与你的身份对得上` }

  if (EVERYONE_WORDS.test(text)) return { relevance: 'mine', reason: '面向全体同学' }
  return { relevance: 'maybe', reason: '没提到你的班级或职务，不确定和你有关' }
}

/* --------------------------------- 冲突检查 -------------------------------- */

function findClash(
  courses: CourseRow[],
  date: string,
  start: string,
  end: string | null,
): CourseRow | null {
  const from = toMinutes(start)
  const to = end ? toMinutes(end) : from + 45
  for (const course of courses) {
    if (!courseOccursOn(course, date)) continue
    const courseFrom = toMinutes(course.start_time)
    const courseTo = toMinutes(course.end_time)
    if (from < courseTo && to > courseFrom) return course
  }
  return null
}

/* ---------------------------------- 主流程 --------------------------------- */

/**
 * 去掉消息头里的来源和发送信息。
 *
 * 群里复制出来的一行常常是「班长 09:12：明天下午2点开会」，
 * 不剥掉这层壳，「09:12」会被当成开会时间，标题也变成「班长 ： 开会」。
 */
function stripPreamble(text: string, sender = ''): string {
  let value = text.replace(/^\s*【[^】]{1,20}】\s*/g, '')

  const stamped = value.match(/^\s*([^\s:：]{1,12})\s+(\d{1,2}:\d{2})\s*[：:]?\s*/)
  if (stamped) value = value.slice(stamped[0].length)

  if (sender) {
    const named = value.match(new RegExp(`^\\s*${sender.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[：:]?\\s*`))
    if (named) value = value.slice(named[0].length)
  }
  return value.trim()
}

/** 去掉链接、数字序号、标点后还剩多少真内容。纯链接消息用它挡掉。 */
function hasRealContent(text: string): boolean {
  return (
    text
      .replace(/https?:\/\/\S+/g, '')
      .replace(/www\.\S+/g, '')
      .replace(/[\s\d.、,，。；;:：!！?？()（）\[\]【】"“”'‘’\-—_/\\]/g, '')
      .length >= 4
  )
}

/**
 * 聊天记录里的「日期分割条」。
 *
 * 微信把这些条子塞在消息流里（「星期三 17:22」「昨天 12:15」「08:55」），
 * sender 还叫 system。bridge 已经会拿它们校准日期并不再返回，
 * 但手动粘贴、飞书剪贴板这些路径绕不过去——留着这层判断，避免一条
 * 「星期三 17:22」被当成「17:22 有个活动」排进日程。
 */
const DIVIDER_RULES: RegExp[] = [
  /^(?:今天|昨天|前天)(?:\s*(?:[上下晚早凌]午?)?\s*\d{1,2}[:：]\d{2})?$/,
  /^(?:\d{4}年)?\d{1,2}月\d{1,2}日(?:\s*(?:[上下晚早凌]午?)?\s*\d{1,2}[:：]\d{2})?$/,
  /^(?:星期|周)[一二三四五六日天](?:\s*(?:[上下晚早凌]午?)?\s*\d{1,2}[:：]\d{2})?$/,
  /^(?:[上下晚早凌]午?)?\s*\d{1,2}[:：]\d{2}$/,
]

export function isDateDivider(text: string): boolean {
  const value = text.trim()
  return value.length > 0 && DIVIDER_RULES.some((rule) => rule.test(value))
}

export function parseNotices(
  messages: NoticeMessage[],
  profile: Profile,
  baseDate: string = today(),
  courses: CourseRow[] = [],
): NoticeItem[] {
  const now = today()

  return messages
    .map((message, index) => {
      if (isDateDivider(message.text)) return null
      const raw = stripPreamble(message.text.trim(), message.sender)
      if (!raw) return null
      // 群里常有人只丢一个链接（公众号文章、金山文档）。去掉链接和标点后没剩内容，
      // 就不是一条能被安排的事，别让它占一条待办。
      if (!hasRealContent(raw)) return null

      // 每条消息按它自己那天算「明天」「本周五」，跨天收集时不会算错。
      const anchor = message.date && /^\d{4}-\d{2}-\d{2}$/.test(message.date) ? message.date : baseDate
      const { deadline, rest } = parseDeadline(raw, anchor)
      const date = parseDueDate(rest, anchor) ?? parseDueDate(raw, anchor) ?? null
      const time = parseNoticeTime(rest)
      const location = parseLocation(raw)
      const { relevance, reason } = judgeRelevance(raw, profile)
      const signUp = SIGNUP_WORDS.test(raw)

      let needConfirm = relevance !== 'mine' || signUp
      let finalReason = signUp ? `${reason}；需要报名或回复，去不去由你定` : reason

      // 往回取一周时，前几天的通知本身可能已经过期：标出来，别让人误当新日程。
      const expired = Boolean(date && date < now)

      if (date && time && courses.length > 0) {
        const clash = findClash(courses, date, time.start, time.end)
        if (clash) {
          needConfirm = true
          finalReason = `与《${clash.name}》（${clash.start_time}-${clash.end_time}）时间重叠`
        }
      }

      if (!date && !deadline) {
        finalReason = `${finalReason}；没认出时间，先列为待办`
      }
      if (expired) {
        finalReason = `${finalReason}；这条是 ${date} 的，已经过去了`
      }

      return {
        id: `notice-${index}-${message.source}-${message.at}`.replace(/\s/g, ''),
        source: message.source,
        sender: message.sender,
        raw,
        title: extractTitle(raw),
        date,
        time: time?.start ?? null,
        endTime: time?.end ?? null,
        location,
        deadline,
        relevance,
        needConfirm,
        expired,
        reason: finalReason,
      }
    })
    .filter((item): item is NoticeItem => item !== null)
}

/**
 * 粘贴兜底：本机助手没开、或者只想手动复制几段时，把整块文本拆成消息。
 * 行首的「【xx群】」「xx群:」当作来源，其余一行算一条。
 */
export function splitRawText(text: string, fallbackSource = '手动粘贴'): NoticeMessage[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

  const messages: NoticeMessage[] = []
  let source = fallbackSource

  for (const line of lines) {
    let body = line
    const head = line.match(/^【([^】]{1,20})】\s*/)
    if (head) {
      source = head[1]
      body = line.slice(head[0].length).trim()
      if (!body) continue
    }

    // 「班长 09:12：……」这种带时间戳的开头，把人和时间都记下来，正文只留后面的话。
    const stamped = body.match(/^([^\s:：]{1,12})\s+(\d{1,2}:\d{2})\s*[：:]?\s*(.+)$/)
    if (stamped) {
      messages.push({ source, sender: stamped[1], at: stamped[2], text: stamped[3].trim() })
      continue
    }

    const named = body.match(/^([^\s:：]{2,16}(?:群|班|部|组|会|队))\s*[:：]\s*(.+)$/)
    if (named) {
      source = named[1]
      messages.push({ source, sender: '', at: '', text: named[2].trim() })
      continue
    }
    // 上一行的续行：短行多半是被截断的半句话，接着上一条写。
    const last = messages[messages.length - 1]
    if (last && line.length < 12) {
      last.text += line
      continue
    }
    messages.push({ source, sender: '', at: '', text: line })
  }
  return messages
}

/** 候选条目在界面上按「有时间的排前面，需要确认的排前面」排序。 */
export function sortNotices(items: NoticeItem[]): NoticeItem[] {
  return [...items].sort((a, b) => {
    if (a.needConfirm !== b.needConfirm) return a.needConfirm ? -1 : 1
    if ((a.date ?? '') !== (b.date ?? '')) return (a.date ?? '9999').localeCompare(b.date ?? '9999')
    return (a.time ?? '99:99').localeCompare(b.time ?? '99:99')
  })
}

/** 没写日期的通知默认放到明天，避免全部堆到今天。 */
export function fallbackDate(baseDate: string = today()): string {
  return shiftDays(baseDate, 1)
}

export function weekdayOf(date: string): number {
  return isoWeekday(date)
}
