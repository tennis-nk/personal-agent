import type { Priority } from '../data/types'
import { LEXICON } from './lexicon'

/* ------------------------------- 基础文本工具 ------------------------------ */

/** 去掉可能改写系统提示的结构性标记，降低提示词注入的影响面。 */
export function defang(value: string): string {
  return value
    .replace(/```/g, "'''")
    .replace(/\r/g, '')
    .replace(/system\s*:/gi, 'system：')
    .slice(0, 4000)
}

export function limit(value: string, max: number): string {
  const text = value.trim()
  return text.length > max ? `${text.slice(0, max)}…` : text
}

export function firstSentence(content: string, max = 120): string {
  const text = content.replace(/\s+/g, ' ').trim()
  if (!text) return ''
  const match = text.match(/^.{0,80}?[。！？!?.]/)
  return limit(match ? match[0] : text, max)
}

export function toStringArray(value: unknown, max = 60): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => limit(item, max))
}

export function normalizePriority(value: unknown): Priority {
  return value === 'high' || value === 'low' ? value : 'medium'
}

export function normalizeDate(value: unknown): string | null {
  if (typeof value !== 'string') return null
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null
}

export function clampScore(value: unknown): number {
  const num = typeof value === 'number' && Number.isFinite(value) ? value : 0.5
  return Math.min(1, Math.max(0, Math.round(num * 100) / 100))
}

export function dateValue(iso: string | null | undefined): number {
  if (!iso) return 0
  const time = Date.parse(iso)
  return Number.isNaN(time) ? 0 : time
}

/* --------------------------------- 断句 ---------------------------------- */

const SENTENCE_SPLIT = /[\n。！？!？；;]+/

/** 按标点与换行切句，过滤掉过短的碎片。 */
export function splitSentences(text: string, minLength = 4): string[] {
  return text
    .split(SENTENCE_SPLIT)
    .map((item) => item.trim())
    .filter((item) => item.length >= minLength)
}

/* ------------------------------- 关键词提取 ------------------------------- */

/**
 * 中文虚字。
 *
 * 没有词典可用，靠「首尾是否为虚字」来剔掉「的时」「我们」这类碎片，
 * 精度不如分词器，但对「看看自动摘要准不准」这个目标够用。
 */
const STOP_CHARS = new Set(
  '的了是在和有就不也都还很再又或与把被让给对对于关于通过并且而其之则即如同将已还未呢吗吧啊呀嘛哦嗯着过们个这那什怎可以自己一下一些'.split(
    '',
  ),
)

const STOP_WORDS = new Set([
  '我们',
  '你们',
  '他们',
  '这个',
  '那个',
  '什么',
  '怎么',
  '因为',
  '所以',
  '但是',
  '然后',
  '如果',
  '需要',
  '时候',
  '现在',
  '今天',
  '明天',
  '昨天',
  '觉得',
  '知道',
  '有点',
  '应该',
  '还是',
  '不是',
  '没有',
  '已经',
  'todo',
  '待办',
])

/**
 * 太泛的词。
 *
 * 它们能匹配上但说明不了「这条资料在讲什么」，
 * 排序时降权，让具体词排在前面。
 */
const GENERIC_WORDS = new Set([
  '问题',
  '情况',
  '内容',
  '方面',
  '部分',
  '方式',
  '方法',
  '事情',
  '信息',
  '东西',
  '时候',
  '现在',
  '目前',
  '可能',
  '一些',
  '很多',
])

/**
 * 长度权重。
 *
 * 四字词信息量更大，但滑窗切出来的四字碎片也最多，
 * 所以加成给得克制，并且后面还有「一次性长词」的过滤兜底。
 */
function lengthWeight(length: number): number {
  if (length >= 4) return 1.3
  if (length === 3) return 1.15
  return 1
}

function isStopTerm(term: string): boolean {
  if (STOP_WORDS.has(term)) return true
  if (term.length === 0) return true
  return STOP_CHARS.has(term[0]) || STOP_CHARS.has(term[term.length - 1])
}

export interface TermScore {
  term: string
  score: number
}

/**
 * 中文片段切词。
 *
 * 词表里能匹配到的按最长优先切；匹配不到的连续汉字整段保留，
 * 这样人名、产品名这类未登录词不会被切碎，也不会产生错位碎片。
 */
function segment(chunk: string): string[] {
  const out: string[] = []
  let buffer = ''
  let i = 0

  const flush = () => {
    if (buffer.length >= 4) {
      // 连续四个以上字都没命中词表，多半是几个词粘在一起，退回两字一切。
      for (let k = 0; k + 2 <= buffer.length; k += 2) out.push(buffer.slice(k, k + 2))
    } else if (buffer.length >= 2) {
      // 两三个字整体保留：人名、产品名常常是这种未登录词。
      out.push(buffer)
    }
    buffer = ''
  }

  while (i < chunk.length) {
    let matched = ''
    for (let size = Math.min(4, chunk.length - i); size >= 2; size -= 1) {
      const candidate = chunk.slice(i, i + size)
      if (LEXICON.has(candidate)) {
        matched = candidate
        break
      }
    }
    if (matched) {
      flush()
      out.push(matched)
      i += matched.length
      continue
    }
    // 虚字不当词用，直接当分隔符，避免「页的加载逻辑」这类粘连。
    if (STOP_CHARS.has(chunk[i])) {
      flush()
      i += 1
      continue
    }
    buffer += chunk[i]
    i += 1
  }

  flush()
  return out
}

/**
 * 从单篇文本里抽关键词。
 *
 * 先切词再统计词频，按「词频 × 长度权重」打分，标题里出现的词额外加权；
 * 最后贪心去重，有包含关系的只留得分更高的那个。
 */
export function extractTerms(text: string, title = '', topN = 6): TermScore[] {
  const counts = new Map<string, number>()

  const bump = (term: string) => {
    if (isStopTerm(term)) return
    counts.set(term, (counts.get(term) ?? 0) + 1)
  }

  for (const chunk of text.match(/[\u4e00-\u9fa5]{2,}/g) ?? []) {
    for (const word of segment(chunk)) bump(word)
  }

  // 英文与数字：整词统计
  for (const word of text.toLowerCase().match(/[a-z][a-z0-9+#.]{2,}|\d+(?:\.\d+)?%?/g) ?? []) {
    bump(word)
  }

  const titleLower = title.toLowerCase()
  const inTitle = (term: string) => titleLower.includes(term.toLowerCase())

  const scored: TermScore[] = []
  for (const [term, freq] of counts) {
    const weight = lengthWeight(term.length) * (GENERIC_WORDS.has(term) ? 0.4 : 1)
    scored.push({ term, score: freq * weight * (inTitle(term) ? 2 : 1) })
  }

  scored.sort((a, b) => b.score - a.score || b.term.length - a.term.length)

  const picked: TermScore[] = []
  for (const item of scored) {
    // 与已选词有包含关系的跳过，避免「机器学习」「机器学」同时入选。
    if (picked.some((chosen) => chosen.term.includes(item.term) || item.term.includes(chosen.term))) {
      continue
    }
    picked.push(item)
    if (picked.length >= topN) break
  }

  return picked
}

/* --------------------------------- 日期解析 -------------------------------- */

const WEEKDAY_MAP: Record<string, number> = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  日: 0,
  天: 0,
}

/** 把 YYYY-MM-DD 转成 Date（按本地时区，避免 UTC 解析差一天）。 */
export function parseDate(text: string): Date | null {
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) return null
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
}

export function formatDate(date: Date): string {
  const year = date.getFullYear()
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function addDays(date: Date, days: number): Date {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return next
}

export function today(): string {
  return formatDate(new Date())
}

/**
 * 从一句话里解析建议截止日。
 *
 * 只认明确的相对说法和日期字面量；解析不出来就返回 null，
 * 宁可留空也不编一个日期。
 */
export function parseDueDate(text: string, baseDate: string): string | null {
  const base = parseDate(baseDate) ?? new Date()

  const explicit = text.match(/(\d{4})-(\d{1,2})-(\d{1,2})/)
  if (explicit) {
    return `${explicit[1]}-${explicit[2].padStart(2, '0')}-${explicit[3].padStart(2, '0')}`
  }

  if (/(今天|今日|当天)/.test(text)) return formatDate(base)
  if (/(明天|明日)/.test(text)) return formatDate(addDays(base, 1))
  if (/(后天)/.test(text)) return formatDate(addDays(base, 2))
  if (/(大后天)/.test(text)) return formatDate(addDays(base, 3))

  const inDays = text.match(/(\d+)\s*(天|日)后/)
  if (inDays) return formatDate(addDays(base, Number(inDays[1])))

  const monthDay = text.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/)
  if (monthDay) {
    const month = Number(monthDay[1])
    const day = Number(monthDay[2])
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const candidate = new Date(base.getFullYear(), month - 1, day)
      // 今年这个日子已经过了就顺延到明年，常见于年底记录年初待办。
      if (candidate < new Date(base.getFullYear(), base.getMonth(), base.getDate())) {
        candidate.setFullYear(candidate.getFullYear() + 1)
      }
      return formatDate(candidate)
    }
  }

  const weekday = text.match(/(下)?\s*(?:周|星期|礼拜)\s*([一二三四五六日天])/)
  if (weekday) {
    const target = WEEKDAY_MAP[weekday[2]]
    const isNextWeek = weekday[1] === '下'
    const current = base.getDay()
    // 以「本周一」为基准算，避免「下周一」被算成下下周。
    const mondayOffset = (current + 6) % 7
    if (isNextWeek) {
      const targetIndex = (target + 6) % 7
      return formatDate(addDays(base, targetIndex - mondayOffset + 7))
    }
    // 不带「下」时指最近一次到来的那一天，正好是今天则按今天算。
    let offset = (target - current + 7) % 7
    if (offset === 0) offset = 7
    return formatDate(addDays(base, offset))
  }

  if (/(下周|下星期|下礼拜)/.test(text)) return formatDate(addDays(base, 7))
  if (/(本周|这周|本周内)/.test(text)) return formatDate(addDays(base, Math.max(0, 7 - base.getDay())))
  if (/(月底|月末)/.test(text)) {
    return formatDate(new Date(base.getFullYear(), base.getMonth() + 1, 0))
  }

  return null
}

/** 判断一条待办是否已逾期。 */
export function isOverdue(dueDate: string | null, baseDate: string): boolean {
  if (!dueDate) return false
  const due = parseDate(dueDate)
  const base = parseDate(baseDate)
  if (!due || !base) return false
  return due < base
}
