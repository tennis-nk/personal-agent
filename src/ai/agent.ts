import { NOTE_CATEGORIES } from '../data/categories'
import type { NoteRow, TodoRow } from '../data/types'
import {
  adviseOffline,
  analyzeNoteLocal,
  answerOffline,
  findRelatedLocal,
  generateReportLocal,
  tidyTodosLocal,
} from './local'
import { describeLlmError, LlmError, streamChat as streamFromLlm } from './llm'
import { isReady, loadSettings } from './settings'
import {
  clampScore,
  dateValue,
  defang,
  extractTerms,
  firstSentence,
  limit,
  normalizeDate,
  normalizePriority,
  toStringArray,
} from './text'
import type {
  ChatMessage,
  NoteAnalysis,
  QaContextChunk,
  RelatedResult,
  ReportResult,
  TodoTidyResult,
  TodoTidySuggestion,
} from './types'

export type { ChatMessage, NoteAnalysis, RelatedResult, TodoTidyResult, TodoTidySuggestion, ReportResult, QaContextChunk }

export class AgentError extends Error {
  code: string
  requestId?: string

  constructor(message: string, code: string, requestId?: string) {
    super(message)
    this.code = code
    this.requestId = requestId
  }
}

/* ------------------------------- 运行模式判断 ------------------------------ */

/**
 * 是否已接入大模型。
 *
 * 没接模型不报错、也不假装能用，而是切到本地规则引擎，
 * 由各能力自行决定降级后的输出形态，并在结果里说明来源。
 */
export function isModelReady(): boolean {
  return isReady(loadSettings())
}

/* ------------------------------- 流式调用出口 ------------------------------ */

export interface StreamOptions {
  messages: ChatMessage[]
  signal?: AbortSignal
  /** 要求模型只输出 JSON。是否随请求下发 json_mode 取决于设置里的开关。 */
  json?: boolean
  temperature?: number
  onDelta?: (chunk: string) => void
  /**
   * 未接入大模型时的替代答案。
   *
   * 由调用方提供，是因为「离线怎么答」跟具体场景强相关：
   * 问答场景适合列原文片段，别的地方可能需要别的兜底。
   */
  offlineFallback?: () => string
}

export async function streamChat(options: StreamOptions): Promise<string> {
  const settings = loadSettings()

  if (!isReady(settings)) {
    if (!options.offlineFallback) {
      throw new AgentError(
        '还没有接入大模型。到「设置」里填入模型接口地址、API Key 和模型名即可启用智能功能。',
        'model_not_configured',
      )
    }
    return emitLocally(options.offlineFallback(), options)
  }

  try {
    return await streamFromLlm(settings, options)
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    const code = error instanceof LlmError ? error.code : 'internal_unknown'
    throw new AgentError(describeLlmError(error), code)
  }
}

/** 离线答案也逐字吐出来，让界面上的流式和中断行为与接模型时一致。 */
function emitLocally(text: string, options: StreamOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    let index = 0
    const size = 6

    const tick = () => {
      if (options.signal?.aborted) {
        reject(new DOMException('Aborted', 'AbortError'))
        return
      }
      if (index >= text.length) {
        resolve(text)
        return
      }
      const chunk = text.slice(index, index + size)
      index += size
      options.onDelta?.(chunk)
      window.setTimeout(tick, 16)
    }

    tick()
  })
}

/** 从模型输出里剥出第一个 JSON 对象，容忍前后多余的说明文字或代码块围栏。 */
export function parseJsonObject<T>(text: string): T | null {
  const cleaned = text
    .replace(/^\s*```(?:json)?/i, '')
    .replace(/```\s*$/, '')
    .trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    return JSON.parse(cleaned.slice(start, end + 1)) as T
  } catch {
    return null
  }
}

/* --------------------------- 能力一：资料自动处理 --------------------------- */

// 分类只有一份定义，放在数据层，界面与提示词都从这里取。
export { NOTE_CATEGORIES } from '../data/categories'

const ANALYZE_SYSTEM =
  '你是一个个人信息管家的分析引擎。输入一段用户随手记下的资料，你需要给出分类、摘要、关键词、重点信息和可执行的待办。' +
  '只输出 JSON，不要任何解释文字。摘要控制在 80 字以内，关键词 3 到 6 个，重点信息 2 到 4 条，每条不超过 40 字。' +
  '只有当原文确实包含明确的行动项时才输出待办，否则返回空数组，不要臆造任务。'

/**
 * 一条资料的自动处理：分类 + 摘要 + 关键词 + 重点提取 + 待办抽取，一次调用完成。
 *
 * 用户输入经过剥离处理再拼进提示词，避免内容里的指令改写系统提示。
 */
export async function analyzeNote(input: {
  title: string
  content: string
  today: string
  signal?: AbortSignal
}): Promise<NoteAnalysis> {
  if (!isModelReady()) return analyzeNoteLocal(input)

  const messages: ChatMessage[] = [
    { role: 'system', content: ANALYZE_SYSTEM },
    {
      role: 'user',
      content: [
        `今天是 ${input.today}。`,
        `可选分类：${NOTE_CATEGORIES.join(' / ')}`,
        '',
        '【标题】',
        defang(input.title),
        '',
        '【正文】',
        defang(input.content),
        '',
        '请输出如下结构的 JSON：',
        '{"category":"分类","summary":"摘要","keywords":["关键词"],"keyPoints":["重点"],"todos":[{"title":"任务","detail":"/说明","priority":"high|medium|low","dueDate":"YYYY-MM-DD或null"}]}',
      ].join('\n'),
    },
  ]

  const raw = await streamChat({ messages, json: true, temperature: 0.3, signal: input.signal })
  const parsed = parseJsonObject<{
    category?: string
    summary?: string
    keywords?: string[]
    keyPoints?: string[]
    todos?: { title?: string; detail?: string; priority?: string; dueDate?: string | null }[]
  }>(raw)

  if (!parsed) {
    return analyzeNoteLocal(input)
  }

  const category = NOTE_CATEGORIES.includes((parsed.category ?? '') as (typeof NOTE_CATEGORIES)[number])
    ? (parsed.category as string)
    : '其他'

  return {
    category,
    summary: limit(parsed.summary ?? firstSentence(input.content), 200),
    keywords: toStringArray(parsed.keywords).slice(0, 8),
    keyPoints: toStringArray(parsed.keyPoints).slice(0, 6),
    todos: (parsed.todos ?? [])
      .filter((item) => typeof item?.title === 'string' && item.title.trim().length > 0)
      .slice(0, 8)
      .map((item) => ({
        title: limit(item.title as string, 120),
        detail: limit(item.detail ?? '', 300) || null,
        priority: normalizePriority(item.priority),
        dueDate: normalizeDate(item.dueDate),
      })),
  }
}

/* --------------------------- 能力二：内容关联 ---------------------------- */

const RELATE_SYSTEM =
  '你是一个知识关联引擎。给定一条新资料和若干已有资料的标题、摘要与关键词，' +
  '判断哪些已有资料与新资料真正相关。只输出 JSON。' +
  '相关指同一件事、同一个项目、同一个人、同一主题的前后进展，或存在因果、依赖、延续关系。' +
  '仅因为都是同一大类主题不算相关。最多选 3 条，没有真正相关的就返回空数组。'

export async function findRelatedNotes(input: {
  note: { title: string; content: string; keywords: string[] }
  candidates: { id: number; title: string; summary: string | null; keywords: string[] | null }[]
  signal?: AbortSignal
}): Promise<RelatedResult[]> {
  if (input.candidates.length === 0) return []
  if (!isModelReady()) return findRelatedLocal(input)

  const listing = input.candidates
    .map(
      (item) =>
        `- id=${item.id}｜标题：${defang(item.title)}｜摘要：${defang(item.summary ?? '（无）')}｜关键词：${(item.keywords ?? []).join('、') || '（无）'}`,
    )
    .join('\n')

  const messages: ChatMessage[] = [
    { role: 'system', content: RELATE_SYSTEM },
    {
      role: 'user',
      content: [
        '【新资料】',
        `标题：${defang(input.note.title)}`,
        `正文：${defang(input.note.content)}`,
        `关键词：${input.note.keywords.join('、') || '（无）'}`,
        '',
        '【已有资料】',
        listing,
        '',
        '输出格式：{"related":[{"id":123,"reason":"为什么相关","score":0.8}]}，score 为 0 到 1 的相关度。',
      ].join('\n'),
    },
  ]

  const raw = await streamChat({ messages, json: true, temperature: 0.2, signal: input.signal })
  const parsed = parseJsonObject<{ related?: { id?: number; reason?: string; score?: number }[] }>(raw)
  if (!parsed?.related) return findRelatedLocal(input)

  const validIds = new Set(input.candidates.map((item) => item.id))
  const results = parsed.related
    .filter((item) => typeof item.id === 'number' && validIds.has(item.id as number))
    .slice(0, 3)
    .map((item) => ({
      noteId: item.id as number,
      reason: limit(item.reason ?? '', 120),
      score: clampScore(item.score),
    }))

  return results.length ? results : findRelatedLocal(input)
}

/* --------------------------- 能力三：智能问答 ---------------------------- */

const QA_SYSTEM =
  '你是用户的个人信息管家。用户会用自己的资料库向你提问。' +
  '只依据提供的资料片段作答；资料里没有的内容要直说「资料里没有记录」，不要编造。' +
  '回答用中文，先给结论，再列依据。引用依据时用 [1] [2] 标注对应的资料编号。'

export function buildQaMessages(question: string, chunks: QaContextChunk[]): ChatMessage[] {
  const context = chunks
    .map((chunk) => `[${chunk.index}] 《${defang(chunk.title)}》\n${defang(chunk.body)}`)
    .join('\n\n')

  const head = chunks.length
    ? `以下是相关资料片段：\n\n${context}\n\n`
    : '资料库里还没有任何资料。\n\n'

  return [
    { role: 'system', content: QA_SYSTEM },
    { role: 'user', content: `${head}问题：${defang(question)}` },
  ]
}

/**
 * 按关键词命中数粗排，取前 N 条喂给模型，避免把整个资料库塞进提示词。
 *
 * 这里用 n-gram 而不是按标点切词：中文问题常常不含空格，
 * 按标点切会得到整句话，一条资料都匹配不上。
 */
export function rankNotes(notes: NoteRow[], question: string, limit = 6): NoteRow[] {
  const terms = extractTerms(question, question, 12).map((item) => item.term)

  const scored = notes.map((note) => {
    const haystack = [
      note.title,
      note.content,
      note.summary ?? '',
      note.category ?? '',
      (note.keywords ?? []).join(' '),
    ]
      .join(' ')
      .toLowerCase()

    let score = 0
    for (const term of terms) {
      if (haystack.includes(term)) score += 1
    }
    return { note, score }
  })

  return scored
    .sort((a, b) => b.score - a.score || dateValue(b.note.created_at) - dateValue(a.note.created_at))
    .slice(0, limit)
    .filter((item) => item.score > 0 || notes.length <= limit)
    .map((item) => item.note)
}

/* --------------------------- 能力四：待办整理 ---------------------------- */

const TIDY_SYSTEM =
  '你是一个待办整理助手。给定一组待办，你需要做三件事：' +
  '1）按主题把它们归成若干组，给出组名和一句点评；' +
  '2）给每条待办重新评估优先级与建议截止日期（结合今天日期）；' +
  '3）给出一段不超过 100 字的执行建议。' +
  '只输出 JSON，不要解释。'

export async function tidyTodos(input: {
  todos: TodoRow[]
  today: string
  signal?: AbortSignal
}): Promise<TodoTidyResult> {
  if (input.todos.length === 0) {
    return { groups: [], schedule: [], advice: '还没有待办，先记点资料试试。' }
  }
  if (!isModelReady()) return tidyTodosLocal(input)

  const listing = input.todos
    .map(
      (todo) =>
        `- id=${todo.id}｜${defang(todo.title)}｜当前优先级：${todo.priority}｜当前截止：${todo.due_date ?? '无'}｜当前分类：${defang(todo.category ?? '未分类')}｜状态：${todo.status}`,
    )
    .join('\n')

  const messages: ChatMessage[] = [
    { role: 'system', content: TIDY_SYSTEM },
    {
      role: 'user',
      content: [
        `今天是 ${input.today}。`,
        '',
        '【待办列表】',
        listing,
        '',
        '输出格式：',
        '{"groups":[{"name":"组名","todoIds":[1],"comment":"点评"}],"schedule":[{"id":1,"priority":"high|medium|low","dueDate":"YYYY-MM-DD或null","category":"分类"}],"advice":"执行建议"}',
      ].join('\n'),
    },
  ]

  const raw = await streamChat({ messages, json: true, temperature: 0.3, signal: input.signal })
  const parsed = parseJsonObject<{
    groups?: { name?: string; todoIds?: number[]; comment?: string }[]
    schedule?: { id?: number; priority?: string; dueDate?: string | null; category?: string }[]
    advice?: string
  }>(raw)

  if (!parsed) return tidyTodosLocal(input)

  const validIds = new Set(input.todos.map((todo) => todo.id))

  const groups = (parsed.groups ?? [])
    .filter((group) => typeof group.name === 'string' && group.name.trim().length > 0)
    .slice(0, 6)
    .map((group) => ({
      name: limit(group.name as string, 30),
      todoIds: (group.todoIds ?? []).filter((id) => typeof id === 'number' && validIds.has(id)),
      comment: limit(group.comment ?? '', 80),
    }))

  const schedule: TodoTidySuggestion[] = (parsed.schedule ?? [])
    .filter((item) => typeof item.id === 'number' && validIds.has(item.id as number))
    .slice(0, 30)
    .map((item) => ({
      id: item.id as number,
      priority: normalizePriority(item.priority),
      dueDate: normalizeDate(item.dueDate),
      category: limit(item.category ?? '未分类', 20),
    }))

  if (groups.length === 0 && schedule.length === 0) return tidyTodosLocal(input)

  return { groups, schedule, advice: limit(parsed.advice ?? '', 300) }
}

/* --------------------------- 能力五：阶段总结 ---------------------------- */

const REPORT_SYSTEM =
  '你是一个阶段复盘助手。给定一段时间内的资料记录与待办完成情况，' +
  '生成一份阶段总结：一句总体判断、一段不超过 200 字的总结、3 到 5 条重点进展、3 到 5 条后续行动建议。' +
  '重点进展要具体到事情，不要空话。后续行动建议要可执行、可验证。只输出 JSON。'

export async function generateReport(input: {
  periodStart: string
  periodEnd: string
  notes: NoteRow[]
  todos: TodoRow[]
  signal?: AbortSignal
}): Promise<ReportResult> {
  if (input.notes.length === 0 && input.todos.length === 0) {
    return {
      title: `${input.periodStart} 至 ${input.periodEnd} 阶段总结`,
      summary: '这段时间没有资料记录，也没有待办完成情况，无法生成总结。',
      highlights: [],
      nextActions: [],
    }
  }
  if (!isModelReady()) return generateReportLocal(input)

  const noteText = input.notes.length
    ? input.notes
        .map(
          (note) =>
            `- 《${defang(note.title)}》（${note.category ?? '未分类'}）：${defang(note.summary ?? note.content.slice(0, 80))}`,
        )
        .join('\n')
    : '（这段时间没有新资料）'

  const doneTodos = input.todos.filter((todo) => todo.status === 'done')
  const openTodos = input.todos.filter((todo) => todo.status === 'pending')
  const todoText =
    (doneTodos.length
      ? doneTodos.map((todo) => `- [已完成] ${defang(todo.title)}`).join('\n')
      : '（无已完成待办）') +
    '\n' +
    (openTodos.length
      ? openTodos
          .map((todo) => `- [未完成] ${defang(todo.title)}｜优先级 ${todo.priority}｜截止 ${todo.due_date ?? '无'}`)
          .join('\n')
      : '（无未完成待办）')

  const messages: ChatMessage[] = [
    { role: 'system', content: REPORT_SYSTEM },
    {
      role: 'user',
      content: [
        `总结区间：${input.periodStart} 至 ${input.periodEnd}`,
        '',
        '【期间新增资料】',
        noteText,
        '',
        '【待办情况】',
        todoText,
        '',
        '输出格式：{"title":"一句话标题","summary":"总结","highlights":["重点进展"],"nextActions":["后续行动建议"]}',
      ].join('\n'),
    },
  ]

  const raw = await streamChat({ messages, json: true, temperature: 0.4, signal: input.signal })
  const parsed = parseJsonObject<{
    title?: string
    summary?: string
    highlights?: string[]
    nextActions?: string[]
  }>(raw)

  if (!parsed) return generateReportLocal(input)

  return {
    title: limit(parsed.title ?? `${input.periodStart} 至 ${input.periodEnd} 阶段总结`, 60),
    summary: limit(parsed.summary ?? '这段时间没有可总结的内容。', 600),
    highlights: toStringArray(parsed.highlights, 120).slice(0, 5),
    nextActions: toStringArray(parsed.nextActions, 120).slice(0, 5),
  }
}

export { LlmError, answerOffline, adviseOffline }
