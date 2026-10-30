import type { NoteRow, Priority, TodoRow } from '../data/types'
import {
  addDays,
  clampScore,
  extractTerms,
  firstSentence,
  formatDate,
  isOverdue,
  limit,
  parseDate,
  parseDueDate,
  splitSentences,
  today,
} from './text'
import type { NoteAnalysis, RelatedResult, ReportResult, TodoTidyResult } from './types'

/**
 * 本地规则引擎。
 *
 * 没有接大模型时顶上，保证「记录—分类—摘要—检索—待办—总结」这条链路
 * 全程可用，方便先判断这套交互值不值得用，再决定要不要接真模型。
 * 它不做生成式改写，只做检索与统计，输出里也会如实说明这一点。
 */

/* --------------------------------- 自动分类 -------------------------------- */

const CATEGORY_RULES: { name: string; words: string[] }[] = [
  {
    name: '工作',
    words: ['会议', '项目', '需求', '排期', '评审', '汇报', '客户', '合同', '上线', '迭代', '方案', '加班', '同事', '领导', '绩效', '面试', '复盘', '周报', '邮件', '需求方', '交付', '对接', '老板', '季度', 'okr', 'okr'],
  },
  {
    name: '学习',
    words: [
      '课程', '学习', '读书', '笔记', '论文', '考试', '复习', '英语', '算法', '知识点', '教程', '刷题', '讲座',
      '考研', '教材', '章节', '推导', '公式', '网课', '作业', '习题', '上课', '课后', '学分', '绩点', '成绩',
      '学期', '必修', '选修', '答辩', '导师', '实验', '开学', '期末', '期中',
    ],
  },
  {
    name: '财务',
    words: ['工资', '报销', '发票', '预算', '支出', '收入', '账单', '信用卡', '基金', '股票', '理财', '转账', '房贷', '税', '余额', '退款'],
  },
  {
    name: '健康',
    words: ['体检', '医院', '感冒', '吃药', '运动', '跑步', '健身', '睡眠', '体重', '牙医', '疫苗', '头痛', '失眠', '复查', '挂号', '医生'],
  },
  {
    name: '人脉',
    words: ['微信', '名片', '介绍', '认识', '联系', '校友', '学长', '学姐', '老师', '合作', '引荐', '聚餐'],
  },
  {
    name: '灵感',
    words: ['想法', '灵感', '创意', '假如', '突发奇想', '脑洞', '试试', '想到', '或许', '也许', '构思'],
  },
  {
    name: '生活',
    words: ['超市', '快递', '做饭', '打扫', '水电', '物业', '房租', '旅行', '火车', '机票', '酒店', '宠物', '家人', '取件', '维修', '洗衣服'],
  },
]

function classify(text: string): string {
  let best = '待归档'
  let bestScore = 0
  for (const rule of CATEGORY_RULES) {
    let score = 0
    for (const word of rule.words) {
      if (text.toLowerCase().includes(word)) score += 1
    }
    if (score > bestScore) {
      bestScore = score
      best = rule.name
    }
  }
  return best
}

/* --------------------------------- 重点提取 -------------------------------- */

/** 去掉行首的列表符、复选框和待办标记，让重点信息读起来是干净的正文。 */
const LINE_MARK =
  /^\s*(?:[-*+•]|\d+[.、)])?\s*(?:\[\s*[xX]?\s*\]\s*)?(?:TODO|todo|待办|待做)?\s*[:：]?\s*/

function stripLineMark(line: string): string {
  return line.replace(LINE_MARK, '').trim()
}


/** 数字、比例、金额、日期这类硬信息最值得被挑出来。 */
const SIGNAL_PATTERNS = [
  /\d+(\.\d+)?\s*(%|％|percent)/,
  /\d+(\.\d+)?\s*(元|块|万|亿|k|K|w|W)/,
  /\d{4}[-/年]\d{1,2}[-/月]\d{1,2}/,
  /\d+\s*(天|周|月|年|小时|分钟|次|人|条|页)/,
]

function informativeScore(sentence: string): number {
  let score = 0
  for (const pattern of SIGNAL_PATTERNS) {
    if (pattern.test(sentence)) score += 2
  }
  if (/(周|星期|礼拜)[一二三四五六日天]/.test(sentence)) score += 1.5
  if (sentence.length >= 10 && sentence.length <= 45) score += 0.6
  return score
}

function pickKeyPoints(sentences: string[], terms: string[]): string[] {
  const scored = sentences.map((raw, index) => {
    const sentence = stripLineMark(raw)
    let score = informativeScore(sentence)
    for (const term of terms) {
      if (sentence.includes(term)) score += 1.2
    }
    // 靠前的句子往往是结论，给一点位置加成。
    if (index <= 1) score += 0.8
    return { sentence, score, index }
  })

  return scored
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 4)
    .sort((a, b) => a.index - b.index)
    .map((item) => limit(item.sentence, 60))
}

/* --------------------------------- 待办抽取 -------------------------------- */

const ACTION_WORDS = [
  '需要',
  '应该',
  '必须',
  '记得',
  '打算',
  '计划',
  '准备',
  '尽快',
  '安排',
  '跟进',
  '确认',
  '联系',
  '提交',
  '整理',
  '复习',
  '预约',
  '催',
  '回复',
  '完成',
  '补齐',
]

const HIGH_SIGNALS = /紧急|尽快|马上|立刻|今天|今日|asap|优先|必须|务必|截止/i
const LOW_SIGNALS = /有空|以后|回头|或许|考虑|不急|将来|慢慢|得空/

/** 行首带明确待办标记的行，直接当任务收。 */
const MARKED_LINE = [
  /^\s*(?:[-*+•]|\d+[.、)])\s*\[\s*[xX]?\s*\]\s*(.+)$/,
  /^\s*(?:[-*+•]|\d+[.、)])\s*(?:TODO|待办|待做)\s*[:：]?\s*(.+)$/i,
  /^\s*(?:TODO|待办|待做|要做|记得|别忘|提醒我)\s*[:：]?\s*(.+)$/i,
]

function extractTodoCandidates(content: string): string[] {
  const lines = content.split(/\r?\n/)
  const found: string[] = []
  const seen = new Set<string>()

  const push = (raw: string) => {
    const text = raw
      .replace(/^[：:\-\s]+/, '')
      .replace(/[。；;，,]$/, '')
      .trim()
    if (text.length < 2 || text.length > 60) return
    if (seen.has(text)) return
    seen.add(text)
    found.push(text)
  }

  for (const line of lines) {
    if (!line.trim()) continue

    let matched = false
    for (const pattern of MARKED_LINE) {
      const match = line.match(pattern)
      if (match?.[1]) {
        push(match[1])
        matched = true
        break
      }
    }
    if (matched) continue

    // 没有标记的行：只有出现动作信号才收，避免把整段随笔都变成待办。
    if (ACTION_WORDS.some((word) => line.includes(word)) && line.length <= 60) {
      push(line)
    }
  }

  // 整段没有换行时也别漏：按句扫描带动作信号的短句。
  if (found.length === 0) {
    for (const sentence of splitSentences(content)) {
      if (sentence.length <= 45 && ACTION_WORDS.some((word) => sentence.includes(word))) {
        push(sentence)
      }
    }
  }

  return found.slice(0, 6)
}

function guessPriority(text: string, dueDate: string | null, baseDate: string): Priority {
  if (HIGH_SIGNALS.test(text)) return 'high'
  if (LOW_SIGNALS.test(text)) return 'low'
  if (dueDate && isOverdue(dueDate, baseDate)) return 'high'
  if (dueDate) {
    const days = Math.round((Date.parse(dueDate) - Date.parse(baseDate)) / 86400000)
    if (days <= 2) return 'high'
    if (days <= 7) return 'medium'
    return 'low'
  }
  return 'medium'
}

/* ------------------------------ 能力一：资料分析 ----------------------------- */

export function analyzeNoteLocal(input: {
  title: string
  content: string
  today: string
}): NoteAnalysis {
  const haystack = `${input.title}\n${input.content}`
  const terms = extractTerms(haystack, input.title, 6).map((item) => item.term)
  const sentences = splitSentences(input.content)

  return {
    category: classify(haystack),
    summary: limit(firstSentence(input.content, 100) || input.title, 120),
    keywords: terms.slice(0, 6),
    keyPoints: pickKeyPoints(sentences, terms),
    todos: extractTodoCandidates(input.content).map((raw) => {
      const title = stripLineMark(raw)
      const dueDate = parseDueDate(title, input.today)
      return {
        title,
        detail: null,
        priority: guessPriority(title, dueDate, input.today),
        dueDate,
      }
    }),
  }
}

/* ------------------------------ 能力二：内容关联 ---------------------------- */

/** 一篇资料的加权词向量：[词, 权重] 形式，交给余弦相似度算相关性。 */
function termVector(text: string, keywords: string[]): Map<string, number> {
  const vector = new Map<string, number>()
  for (const item of extractTerms(text, '', 20)) {
    vector.set(item.term, item.score)
  }
  // 模型/人工标注过的关键词权重更高，反映「这是重点」这件事本身。
  for (const keyword of keywords) {
    vector.set(keyword, (vector.get(keyword) ?? 0) + 3)
  }
  return vector
}

function cosine(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0
  let normA = 0
  let normB = 0
  for (const value of a.values()) normA += value * value
  for (const [key, value] of b) {
    normB += value * value
    const other = a.get(key)
    if (other !== undefined) dot += other * value
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

export function findRelatedLocal(input: {
  note: { title: string; content: string; keywords: string[] }
  candidates: { id: number; title: string; summary: string | null; keywords: string[] | null }[]
}): RelatedResult[] {
  const target = termVector(
    `${input.note.title}\n${input.note.content}`,
    input.note.keywords,
  )

  const scored = input.candidates.map((candidate) => {
    const vector = termVector(
      `${candidate.title}\n${candidate.summary ?? ''}`,
      candidate.keywords ?? [],
    )
    const similarity = cosine(target, vector)

    // 直接共现的关键词最能解释「为什么相关」，单独加成。
    const shared = (candidate.keywords ?? []).filter(
      (keyword) => input.note.keywords.includes(keyword),
    )
    const sharedTerms = [...vector.keys()].filter(
      (term) => target.has(term) && term.length >= 2,
    )

    return {
      candidate,
      score: similarity,
      shared: [...new Set([...shared, ...sharedTerms])].slice(0, 3),
    }
  })

  return scored
    .filter((item) => item.score >= 0.12)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((item) => ({
      noteId: item.candidate.id,
      reason: item.shared.length
        ? `共同关注：${item.shared.join('、')}`
        : '内容主题接近',
      score: clampScore(item.score),
    }))
}

/* ------------------------------ 能力三：离线问答 ---------------------------- */

/** 从一篇资料里挑出与问题最相关的句子。 */
function bestSentences(text: string, terms: string[], topN = 2): string[] {
  const sentences = splitSentences(text)
  if (sentences.length === 0) return []

  return sentences
    .map((sentence, index) => {
      let score = 0
      for (const term of terms) {
        if (sentence.includes(term)) score += 1
      }
      if (index === 0) score += 0.5
      return { sentence, score, index }
    })
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, topN)
    .filter((item) => item.score > 0)
    .sort((a, b) => a.index - b.index)
    .map((item) => item.sentence)
}

/**
 * 离线问答。
 *
 * 不给模型就老老实实做检索：把命中的原文片段按相关度列出来，
 * 并说明这是原文摘录而不是生成式回答，避免看起来像模型在编。
 */
export function answerOffline(question: string, notes: NoteRow[]): string {
  const terms = extractTerms(question, '', 8).map((item) => item.term)
  if (notes.length === 0) {
    return [
      '资料库里还没有任何资料，先去「资料库」记一条再回来问。',
      '',
      '（当前为离线检索模式：没有接入大模型，只能按关键词找原文。）',
    ].join('\n')
  }

  const hits = notes
    .map((note) => {
      const text = `${note.title}\n${note.summary ?? ''}\n${note.content}`
      let score = 0
      for (const term of terms) {
        if (text.toLowerCase().includes(term)) score += 1
      }
      return { note, score }
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)

  if (hits.length === 0) {
    return [
      `资料里没有找到与「${limit(question, 40)}」相关的内容。`,
      '',
      '离线检索按关键词匹配，换个说法或更具体的词可能更容易命中。',
      '接入大模型后可以做语义匹配，问法不要求完全对上。',
    ].join('\n')
  }

  const lines: string[] = [
    `关于「${limit(question, 40)}」，在你的资料里找到 ${hits.length} 条相关内容：`,
    '',
  ]

  hits.forEach((hit, index) => {
    const body = `${hit.note.summary ?? ''}\n${hit.note.content}`
    const quotes = bestSentences(body, terms, 2)
    lines.push(`[${index + 1}] 《${hit.note.title}》${hit.note.category ? ` · ${hit.note.category}` : ''}`)
    if (quotes.length) {
      for (const quote of quotes) lines.push(`    ${limit(quote, 100)}`)
    } else {
      lines.push(`    ${limit(hit.note.summary ?? hit.note.content, 100)}`)
    }
    lines.push('')
  })

  lines.push('—— 以上为离线检索结果，是原文摘录，未做生成式改写。')
  lines.push('在「设置」里填入模型接口的 API Key，可以让模型直接作答并跨条归纳。')

  return lines.join('\n')
}

/* ------------------------------ 能力四：待办整理 ---------------------------- */

export function tidyTodosLocal(input: { todos: TodoRow[]; today: string }): TodoTidyResult {
  const pending = input.todos.filter((todo) => todo.status === 'pending')
  const done = input.todos.filter((todo) => todo.status === 'done')

  // 按分类分组，组内再按是否有截止日排一次，读起来有先后。
  const buckets = new Map<string, TodoRow[]>()
  for (const todo of pending) {
    const key = todo.category?.trim() || '未分类'
    const list = buckets.get(key) ?? []
    list.push(todo)
    buckets.set(key, list)
  }

  const groups = [...buckets.entries()]
    .map(([name, list]) => {
      const overdue = list.filter((todo) => isOverdue(todo.due_date, input.today)).length
      const high = list.filter((todo) => todo.priority === 'high').length
      const dated = list.filter((todo) => todo.due_date).length
      const parts = [`${list.length} 条`]
      if (overdue > 0) parts.push(`${overdue} 条已逾期`)
      if (high > 0) parts.push(`${high} 条高优先级`)
      if (dated < list.length) parts.push(`${list.length - dated} 条没有截止日`)
      const comment = overdue > 0 ? `共 ${parts.join('，')}，建议先清逾期项。` : `共 ${parts.join('，')}。`

      const todoIds = [...list]
        .sort(
          (a, b) =>
            Number(isOverdue(b.due_date, input.today)) - Number(isOverdue(a.due_date, input.today)) ||
            priorityWeight(b.priority) - priorityWeight(a.priority),
        )
        .map((todo) => todo.id)

      return { name, todoIds, comment: limit(comment, 90) }
    })
    .sort((a, b) => b.todoIds.length - a.todoIds.length)

  const schedule = pending.map((todo) => {
    const overdue = isOverdue(todo.due_date, input.today)
    let priority = todo.priority
    let dueDate = todo.due_date

    if (overdue) {
      // 逾期的直接顶到今天，并把优先级提到最高。
      priority = 'high'
      dueDate = input.today
    } else if (!dueDate) {
      const offset = todo.priority === 'high' ? 2 : todo.priority === 'low' ? 10 : 5
      dueDate = formatDate(addDays(parseDate(input.today) ?? new Date(), offset))
    }

    return { id: todo.id, priority, dueDate, category: todo.category ?? '未分类' }
  })

  return { groups, schedule, advice: buildAdvice(pending, done, input.today) }
}

function priorityWeight(priority: Priority): number {
  return priority === 'high' ? 3 : priority === 'medium' ? 2 : 1
}

function buildAdvice(pending: TodoRow[], done: TodoRow[], baseDate: string): string {
  if (pending.length === 0) {
    return done.length
      ? `待办已经清空，这段时间完成了 ${done.length} 条。可以回顾一下完成情况再定新目标。`
      : '还没有待办。记资料时如果写了「记得」「需要」这类话，会自动变成待办。'
  }

  const overdue = pending.filter((todo) => isOverdue(todo.due_date, baseDate))
  const high = pending.filter((todo) => todo.priority === 'high')
  const undated = pending.filter((todo) => !todo.due_date)
  const rate = pending.length + done.length > 0 ? done.length / (pending.length + done.length) : 0

  const parts: string[] = []
  if (overdue.length > 0) {
    parts.push(`${overdue.length} 条已逾期，优先在今天清掉`)
  } else {
    parts.push('暂无逾期项')
  }
  if (high.length > 0) parts.push(`高优先级 ${high.length} 条`)
  if (undated.length > 0) parts.push(`${undated.length} 条缺截止日`)
  parts.push(`完成率 ${Math.round(rate * 100)}%`)

  return limit(`${parts.join('，')}。建议每天先处理逾期与高优先级，其余按截止日推进。`, 200)
}

/* ------------------------ 工作台：下一步该做什么 ------------------------ */

/**
 * 离线版的「接下来最该先做哪三件事」。
 *
 * 不做语义理解，纯按逾期、优先级、截止日和最近资料主题排序，
 * 输出里注明是本地统计，避免看起来像模型推理的结果。
 */
export function adviseOffline(notes: NoteRow[], todos: TodoRow[]): string {
  const base = today()
  const open = todos.filter((todo) => todo.status !== 'done')
  const overdue = open
    .filter((todo) => isOverdue(todo.due_date, base))
    .sort((a, b) => Date.parse(a.due_date ?? '') - Date.parse(b.due_date ?? ''))

  const high = open
    .filter((todo) => todo.priority === 'high' && !isOverdue(todo.due_date, base))
    .sort((a, b) => (a.due_date ?? '9999').localeCompare(b.due_date ?? '9999'))

  const dated = open
    .filter((todo) => todo.due_date && !isOverdue(todo.due_date, base) && todo.priority !== 'high')
    .sort((a, b) => (a.due_date ?? '').localeCompare(b.due_date ?? ''))

  const lines: string[] = []
  if (open.length === 0) {
    return notes.length
      ? '当前没有未完成待办。可以在「资料库」里挑一条最近的记录，把里面提到的事转成待办。'
      : '还没有资料与待办，先去「资料库」记一条。'
  }

  const taken = new Set<number>([...overdue, ...high, ...dated].map((todo) => todo.id))
  const rest = open
    .filter((todo) => !taken.has(todo.id))
    .sort((a, b) => priorityWeight(b.priority) - priorityWeight(a.priority))

  const pick = [...overdue, ...high, ...dated, ...rest].slice(0, 3)
  pick.forEach((todo, index) => {
    const bits: string[] = []
    if (isOverdue(todo.due_date, base) && todo.due_date) bits.push(`已逾期（原定 ${todo.due_date}）`)
    else if (todo.due_date) bits.push(`截止 ${todo.due_date}`)
    if (todo.priority === 'high') bits.push('高优先级')
    if (todo.category) bits.push(todo.category)
    lines.push(`${index + 1}. ${limit(todo.title, 50)}${bits.length ? ` —— ${bits.join('，')}` : ''}`)
  })

  const recentTopics = topTopics(notes.slice(0, 10), 3)
  if (recentTopics.length) {
    lines.push('')
    lines.push(`最近记录集中在：${recentTopics.join('、')}，可以顺着这个方向继续推进。`)
  }

  lines.push('')
  lines.push('—— 以上为本地统计结果，依据逾期情况、优先级与截止日排序得出。')

  return lines.join('\n')
}

/** 取若干篇资料里出现次数最多的主题词。 */
function topTopics(notes: NoteRow[], topN: number): string[] {
  const counts = new Map<string, number>()
  for (const note of notes) {
    const text = `${note.title}\n${note.summary ?? ''}\n${note.content}`
    for (const item of extractTerms(text, note.title, 2)) {
      counts.set(item.term, (counts.get(item.term) ?? 0) + 1)
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, topN)
    .map(([term]) => term)
}

/* ------------------------------ 能力五：阶段总结 ---------------------------- */

export function generateReportLocal(input: {
  periodStart: string
  periodEnd: string
  notes: NoteRow[]
  todos: TodoRow[]
}): ReportResult {
  const notes = input.notes
  const done = input.todos.filter((todo) => todo.status === 'done')
  const open = input.todos.filter((todo) => todo.status !== 'done')
  const rate = input.todos.length ? done.length / input.todos.length : 0

  const byCategory = new Map<string, number>()
  for (const note of notes) {
    const key = note.category?.trim() || '未分类'
    byCategory.set(key, (byCategory.get(key) ?? 0) + 1)
  }
  const categoryTop = [...byCategory.entries()].sort((a, b) => b[1] - a[1])

  const termCounts = new Map<string, number>()
  for (const note of notes) {
    const text = `${note.title}\n${note.summary ?? ''}\n${note.content}`
    for (const item of extractTerms(text, note.title, 3)) {
      termCounts.set(item.term, (termCounts.get(item.term) ?? 0) + 1)
    }
  }
  const termTop = [...termCounts.entries()]
    .filter(([term, count]) => count >= 2 && term.length >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)

  const title = notes.length
    ? `${input.periodStart} 起 ${notes.length} 条记录，${categoryTop[0]?.[0] ?? '未分类'}占多数`
    : `${input.periodStart} 至 ${input.periodEnd}：暂无新记录`

  const summaryParts: string[] = []
  if (notes.length === 0 && input.todos.length === 0) {
    summaryParts.push('这段时间没有新增资料，也没有待办记录。')
  } else {
    summaryParts.push(`区间内新增资料 ${notes.length} 条`)
    if (categoryTop.length) {
      summaryParts.push(
        `分布为 ${categoryTop.map(([name, count]) => `${name} ${count} 条`).join('、')}`,
      )
    }
    summaryParts.push(`待办完成 ${done.length} 条，未完成 ${open.length} 条，完成率 ${Math.round(rate * 100)}%`)
    if (termTop.length) {
      summaryParts.push(`高频主题：${termTop.map(([term]) => term).join('、')}`)
    }
  }
  summaryParts.push('本段由本地规则引擎统计生成，未接入大模型')

  const highlights: string[] = []
  for (const [name, count] of categoryTop.slice(0, 3)) {
    const sample = notes.filter((note) => (note.category?.trim() || '未分类') === name)[0]
    highlights.push(
      limit(`${name}方向 ${count} 条${sample ? `，例如《${sample.title}》` : ''}`, 80),
    )
  }
  for (const todo of done.slice(0, 3)) {
    highlights.push(limit(`完成：${todo.title}`, 80))
  }

  const nextActions: string[] = []
  const overdue = open.filter((todo) => isOverdue(todo.due_date, input.periodEnd))
  for (const todo of overdue.slice(0, 2)) {
    nextActions.push(limit(`逾期未处理，先安排掉：${todo.title}`, 80))
  }
  for (const todo of open.filter((todo) => todo.priority === 'high').slice(0, 2)) {
    nextActions.push(limit(`高优先级推进：${todo.title}`, 80))
  }
  for (const todo of open.filter((todo) => !todo.due_date).slice(0, 1)) {
    nextActions.push(limit(`补一个截止日期：${todo.title}`, 80))
  }
  if (nextActions.length === 0) {
    nextActions.push('当前没有待推进的未完成项，可以规划下一阶段目标。')
  }

  return {
    title: limit(title, 60),
    summary: limit(summaryParts.join('，') + '。', 500),
    highlights: highlights.slice(0, 5),
    nextActions: nextActions.slice(0, 5),
  }
}
