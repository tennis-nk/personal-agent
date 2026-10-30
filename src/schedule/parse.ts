/**
 * 课表解析。
 *
 * 支持两种常见输入：
 * 1. 教务系统复制出来的表格（Tab 或逗号分隔，带或不带表头）；
 * 2. 手写的逐行文本，如「周一 第1-2节 高等数学 教三201 张老师 1-16周」。
 *
 * 解析结果一定给用户过目确认，所以这里宁可漏认、把问题行挑出来，
 * 也不猜一个看起来像模像样的错结果——错一行在日历上会错一整学期。
 */

const WEEKDAY_MAP: Record<string, number> = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  日: 7,
  天: 7,
  1: 1,
  2: 2,
  3: 3,
  4: 4,
  5: 5,
  6: 6,
  7: 7,
}

const WEEKDAY_NAME = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']

export function weekdayName(weekday: number): string {
  return WEEKDAY_NAME[weekday - 1] ?? '周一'
}

export interface ParsedCourse {
  key: string
  name: string
  teacher: string
  location: string
  weekday: number
  startSlot: number
  endSlot: number
  /** 形如 [1,2,3,...,16]。 */
  weeks: number[]
  raw: string
  /** 解析时的提醒，比如「没写周次，按整学期处理」。 */
  notes: string[]
}

export interface ParseResult {
  items: ParsedCourse[]
  failed: { raw: string; reason: string }[]
  mode: 'table' | 'text'
}

/* -------------------------------- 字段拆解 -------------------------------- */

export function parseWeekday(text: string): number | null {
  const matched = text.match(/(?:周|星期|礼拜)\s*([一二三四五六日天1-7])/)
  if (matched) return WEEKDAY_MAP[matched[1]] ?? null
  return null
}

/** 表格里的星期列可能就是一个「一」或「1」，单独处理。 */
export function parseWeekdayCell(cell: string): number | null {
  const trimmed = cell.trim()
  if (!trimmed) return null
  if (WEEKDAY_MAP[trimmed] !== undefined) return WEEKDAY_MAP[trimmed]
  return parseWeekday(trimmed)
}

/**
 * 解析节次。
 *
 * strict 模式（自由文本）必须带「节」字，否则「1-16周」会被当成第 1–16 节；
 * loose 模式（表格里的节次单元格）允许整格就是「1-2」这种写法。
 */
export function parseSlots(text: string, loose = false): { start: number; end: number } | null {
  const range = text.match(/第?\s*(\d{1,2})\s*[-–—~至到]\s*(\d{1,2})\s*节/) ??
    (loose ? text.trim().match(/^(\d{1,2})\s*[-–—~至到]\s*(\d{1,2})$/) : null)
  if (range) {
    const start = Number(range[1])
    const end = Number(range[2])
    if (start >= 1 && end >= 1) return { start: Math.min(start, end), end: Math.max(start, end) }
  }
  const single = text.match(/第\s*(\d{1,2})\s*节/) ?? (loose ? text.trim().match(/^(\d{1,2})$/) : null)
  if (single) {
    const value = Number(single[1])
    if (value >= 1) return { start: value, end: value }
  }
  return null
}

export function parseTimeRange(text: string): { start: string; end: string } | null {
  const matched = text.match(/(\d{1,2}[:：]\d{2})\s*[-–—~至]\s*(\d{1,2}[:：]\d{2})/)
  if (!matched) return null
  const normalize = (value: string) => value.replace('：', ':').padStart(5, '0')
  return { start: normalize(matched[1]), end: normalize(matched[2]) }
}

/** 把「1-16周」「2,4,6周」「1-16周(单)」这类写法展开成周次数组。 */
export function parseWeeks(text: string, totalWeeks: number): number[] {
  const source = (text ?? '').trim()
  const full = Array.from({ length: totalWeeks }, (_, index) => index + 1)
  if (!source) return full

  const oddOnly = /单/.test(source)
  const evenOnly = /双/.test(source) && !oddOnly

  const weeks = new Set<number>()
  // 一次扫描同时认「a-b」和孤立数字。以前分成两轮处理，遇到「3-5,8」这种
  // 区间与单周混写会只取到 3-5，把第 8 周丢掉。
  const pattern = /(\d{1,2})\s*[-–—~至]\s*(\d{1,2})|(\d{1,2})/g
  let matched = pattern.exec(source)
  while (matched) {
    if (matched[3] !== undefined) {
      weeks.add(Number(matched[3]))
    } else {
      const from = Number(matched[1])
      const to = Number(matched[2])
      for (let week = Math.min(from, to); week <= Math.max(from, to); week += 1) weeks.add(week)
    }
    matched = pattern.exec(source)
  }

  let list = [...weeks].filter((week) => week >= 1 && week <= 60).sort((a, b) => a - b)
  if (list.length === 0) return full
  if (oddOnly) list = list.filter((week) => week % 2 === 1)
  if (evenOnly) list = list.filter((week) => week % 2 === 0)
  return list
}

/* -------------------------------- 表头识别 -------------------------------- */

type Column = 'name' | 'weekday' | 'slots' | 'time' | 'location' | 'teacher' | 'weeks'

const COLUMN_RULES: { column: Column; pattern: RegExp }[] = [
  { column: 'name', pattern: /课程|科目|名称/ },
  { column: 'weekday', pattern: /星期|周几|上课日|日期/ },
  { column: 'slots', pattern: /节次|节数|课节/ },
  { column: 'weeks', pattern: /周次|周数|起止周|教学周/ },
  { column: 'time', pattern: /时间|时段|时刻/ },
  { column: 'location', pattern: /地点|教室|上课地|位置|场地/ },
  { column: 'teacher', pattern: /教师|老师|任课|讲师/ },
]

function splitCells(line: string): string[] {
  if (line.includes('\t')) return line.split('\t').map((cell) => cell.trim())
  if (line.includes(',') || line.includes('，')) {
    return line
      .split(/[,，]/)
      .map((cell) => cell.replace(/^"|"$/g, '').trim())
  }
  return line.split(/\s{2,}/).map((cell) => cell.trim())
}

function readHeader(cells: string[]): Partial<Record<Column, number>> | null {
  const map: Partial<Record<Column, number>> = {}
  let hits = 0
  cells.forEach((cell, index) => {
    if (!cell) return
    for (const rule of COLUMN_RULES) {
      if (map[rule.column] !== undefined) continue
      if (rule.pattern.test(cell)) {
        map[rule.column] = index
        hits += 1
        return
      }
    }
  })
  // 至少认出两个字段才当成表头，否则可能是把数据行误判了。
  return hits >= 2 ? map : null
}

/* ------------------------------- 地点/教师猜测 ------------------------------ */

const LOCATION_HINT = /(楼|室|馆|场|校区|中心|实验|机房|阶梯|号|教\d|[A-Za-z]\s*-?\s*\d{2,4})/
const TEACHER_HINT = /(老师|教授|讲师|助教|先生|女士)$/

function classify(tokens: string[]): { location: string; teacher: string } {
  let location = ''
  let teacher = ''
  for (const token of tokens) {
    if (!token) continue
    if (!teacher && TEACHER_HINT.test(token)) {
      teacher = token
      continue
    }
    if (!location && LOCATION_HINT.test(token)) {
      location = token
      continue
    }
    if (!teacher && /^[\u4e00-\u9fa5·]{2,4}$/.test(token)) {
      teacher = token
      continue
    }
    if (!location) location = token
  }
  return { location, teacher }
}

/* --------------------------------- 主流程 --------------------------------- */

export function parseTimetable(text: string, totalWeeks = 16): ParseResult {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#') && !/^[-—–\s]+$/.test(line))

  if (lines.length === 0) return { items: [], failed: [], mode: 'text' }

  const headerCells = splitCells(lines[0])
  const header = readHeader(headerCells)
  const items: ParsedCourse[] = []
  const failed: { raw: string; reason: string }[] = []

  const push = (item: Omit<ParsedCourse, 'key'>) => {
    // 周次和教师必须进去重键。同一门课常常拆成好几段上（换教师、换教室、
    // 只上前八周），只按「课程+星期+节次」去重会把它们并成一条，
    // 比如「大学生心理健康」一学期换五个老师，就只剩第一个了。
    const key = `${item.name}|${item.weekday}|${item.startSlot}|${item.endSlot}|${item.weeks.join(',')}|${item.teacher}`
    if (items.some((existing) => existing.key === key)) return
    items.push({ ...item, key })
  }

  if (header) {
    for (const line of lines.slice(1)) {
      const cells = splitCells(line)
      if (cells.length < 2) continue
      const pick = (column: Column): string => {
        const index = header[column]
        return index === undefined ? '' : (cells[index] ?? '')
      }

      const name = pick('name')
      const weekday = parseWeekdayCell(pick('weekday')) ?? parseWeekday(line)
      const slots = parseSlots(pick('slots'), true) ?? parseSlots(line)
      const timeRange = parseTimeRange(pick('time') || line)

      if (!name) {
        failed.push({ raw: line, reason: '没找到课程名' })
        continue
      }
      if (weekday === null) {
        failed.push({ raw: line, reason: '没认岀星期几' })
        continue
      }
      if (!slots && !timeRange) {
        failed.push({ raw: line, reason: '没认岀第几节' })
        continue
      }

      const notes: string[] = []
      const weeks = parseWeeks(pick('weeks'), totalWeeks)
      if (!pick('weeks').trim()) notes.push('未写周次，按整学期处理')

      push({
        name,
        weekday,
        startSlot: slots?.start ?? 1,
        endSlot: slots?.end ?? 1,
        teacher: pick('teacher'),
        location: pick('location'),
        weeks,
        raw: line,
        notes,
      })
    }
    return { items, failed, mode: 'table' }
  }

  // 逐行文本模式：先把结构化片段抠出来，剩下的碎词再分类。
  for (const line of lines) {
    const weekday = parseWeekday(line)
    const slots = parseSlots(line)
    const timeRange = parseTimeRange(line)

    // 注意：「节」必须跟着一起剔除，否则 1-16 周会被当成节次范围。
    let rest = line
      .replace(/(?:周|星期|礼拜)\s*[一二三四五六日天1-7]/g, ' ')
      .replace(/第?\s*\d{1,2}\s*[-–—~至到]\s*\d{1,2}\s*节/g, ' ')
      .replace(/第\s*\d{1,2}\s*节/g, ' ')
      .replace(/\d{1,2}[:：]\d{2}\s*[-–—~至]\s*\d{1,2}[:：]\d{2}/g, ' ')

    let weeksSource = ''
    const weekMatched = rest.match(/\d{1,2}\s*[-–—~至]\s*\d{1,2}\s*周(\s*[（(]?\s*[单双]\s*[)）]?)?/)
    if (weekMatched) {
      weeksSource = weekMatched[0]
      rest = rest.replace(weekMatched[0], ' ')
    } else {
      const singleWeek = rest.match(/\d{1,2}\s*周(\s*[（(]?\s*[单双]\s*[)）]?)?/)
      if (singleWeek) {
        weeksSource = singleWeek[0]
        rest = rest.replace(singleWeek[0], ' ')
      }
    }

    const tokens = rest
      .split(/[\s,，;；|/]+/)
      .map((token) => token.trim())
      .filter((token) => token.length > 0 && !/^[-—–.。]+$/.test(token))

    if (tokens.length === 0) {
      failed.push({ raw: line, reason: '没找到课程名' })
      continue
    }
    if (weekday === null) {
      failed.push({ raw: line, reason: '没认岀星期几' })
      continue
    }
    if (!slots && !timeRange) {
      failed.push({ raw: line, reason: '没认岀第几节' })
      continue
    }

    const [name, ...others] = tokens
    const { location, teacher } = classify(others)
    const notes: string[] = []
    const weeks = parseWeeks(weeksSource, totalWeeks)
    if (!weeksSource) notes.push('未写周次，按整学期处理')

    push({
      name,
      weekday,
      startSlot: slots?.start ?? 1,
      endSlot: slots?.end ?? 1,
      teacher,
      location,
      weeks,
      raw: line,
      notes,
    })
  }

  return { items, failed, mode: 'text' }
}

/**
 * 从文件头的注释行里读学期起始日，形如「# 第一周 2026-09-07」。
 *
 * 只填课程不填开学日的话，周次换算不出真实日期，整学期的课会画错位置。
 * 有这一行就能在选文件时自动带出来，省得每次手改。
 */
export function parseSemesterHint(text: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim().startsWith('#')) continue
    const matched = line.match(/(\d{4})-(\d{1,2})-(\d{1,2})/)
    if (!matched) continue
    const month = `${Number(matched[2])}`.padStart(2, '0')
    const day = `${Number(matched[3])}`.padStart(2, '0')
    return `${matched[1]}-${month}-${day}`
  }
  return null
}

/** 学期第一周的周一。默认取今天所在周的周一，导入时用户可以改成真实开学日。 */
export function defaultSemesterStart(todayIso: string): string {
  const date = new Date(`${todayIso}T00:00:00`)
  const day = date.getDay() // 0 = 周日
  const offset = day === 0 ? -6 : 1 - day
  date.setDate(date.getDate() + offset)
  const year = date.getFullYear()
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const dayOfMonth = `${date.getDate()}`.padStart(2, '0')
  return `${year}-${month}-${dayOfMonth}`
}
