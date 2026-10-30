import { NOTE_CATEGORIES, UNCATEGORIZED } from '../data/categories'
import type { NoteRow, TodoRow } from '../data/types'
import { isModelReady, parseJsonObject, streamChat } from './agent'
import { analyzeNoteLocal, findRelatedLocal } from './local'
import { loadSettings } from './settings'
import { defang, limit } from './text'

/**
 * 资料库智能整理。
 *
 * 一次跑完四件事，产出一份「可勾选的建议清单」，由用户决定哪几条照做：
 *   1. 分类不对或还是占位的，给出建议分类；
 *   2. 没摘要的补一句摘要；
 *   3. 内容高度重复的，建议把冗余那条归到「待归档」（不删，用户自己看着办）；
 *   4. 长期没动过又没有未完待办的，建议归档。
 *
 * 接了模型就交给模型判，没接就走本地规则（分类用关键词表、摘要取首句、重复用余弦相似度），
 * 两条路产出的结构一样，界面不用区分。
 */

export type OrganizeKind = 'category' | 'summary' | 'duplicate' | 'archive'

export interface OrganizeItem {
  key: string
  kind: OrganizeKind
  noteId: number
  title: string
  /** 现在的分类或摘要（补摘要时为空字符串）。 */
  current: string
  /** 建议的分类或摘要。重复与归档两类固定是「待归档」。 */
  next: string
  reason: string
  /** duplicate 类里被保留的那条，界面上要说明「已保留《X》」。 */
  partnerId?: number
  partnerTitle?: string
}

export interface OrganizeResult {
  items: OrganizeItem[]
  /** 建议由谁给出：模型还是本地规则。界面上要如实说明。 */
  source: 'model' | 'local'
  model: string
  note: string
  scanned: number
}

/** 这三种分类等于「还没归好」，是整理的首要对象。 */
const PLACEHOLDER_CATEGORIES = new Set([UNCATEGORIZED, '文件', '待确认', ''])

/** 多久没动过算「陈旧」。 */
const STALE_DAYS = 90
const STALE_MS = STALE_DAYS * 24 * 60 * 60 * 1000

/** 一次最多让模型看多少条。再多提示词会超长，判定质量也会下降。 */
const MAX_CANDIDATES = 30
/** 两两比对的成本是平方级，只拿最近更新的一批参与。 */
const MAX_COMPARE = 60
const DUPLICATE_THRESHOLD = 0.45
const MAX_DUPLICATE_PAIRS = 10

const ARCHIVE = '待归档'

function organizeKey(kind: OrganizeKind, noteId: number, partnerId?: number): string {
  return `${kind}-${noteId}${partnerId === undefined ? '' : `-${partnerId}`}`
}

function categoryOf(note: NoteRow): string {
  return (note.category ?? '').trim()
}

function needsCategory(note: NoteRow): boolean {
  return PLACEHOLDER_CATEGORIES.has(categoryOf(note))
}

function needsSummary(note: NoteRow): boolean {
  return !(note.summary ?? '').trim() && note.content.trim().length > 0
}

/** 按更新时间倒序：最近动过的排在前面，整理也更关心近期的东西。 */
function recentFirst(notes: NoteRow[]): NoteRow[] {
  return [...notes].sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))
}

function isStale(note: NoteRow, now: number, pendingNoteIds: Set<number>): boolean {
  if (categoryOf(note) === ARCHIVE) return false
  if (pendingNoteIds.has(note.id)) return false
  const updated = Date.parse(note.updated_at)
  if (Number.isNaN(updated)) return false
  return now - updated > STALE_MS
}

/**
 * 本地算疑似重复。
 *
 * 只做「高度相似」这一件事的判断，把候选对交给模型去定性（是不是同一件事记了两遍）；
 * 离线时就直接按分数认定，并在理由里说明是相似度判的。
 */
function duplicatePairs(notes: NoteRow[]): { a: NoteRow; b: NoteRow; score: number }[] {
  const pool = recentFirst(notes).slice(0, MAX_COMPARE)
  const pairs: { a: NoteRow; b: NoteRow; score: number }[] = []
  const seen = new Set<string>()

  for (const note of pool) {
    const candidates = pool
      .filter((item) => item.id !== note.id)
      .map((item) => ({
        id: item.id,
        title: item.title,
        summary: item.summary,
        keywords: item.keywords,
      }))

    const related = findRelatedLocal({
      note: { title: note.title, content: note.content, keywords: note.keywords ?? [] },
      candidates,
    })

    for (const hit of related) {
      if (hit.score < DUPLICATE_THRESHOLD) continue
      const other = pool.find((item) => item.id === hit.noteId)
      if (!other) continue
      const fingerprint = [note.id, other.id].sort((x, y) => x - y).join('-')
      if (seen.has(fingerprint)) continue
      seen.add(fingerprint)
      pairs.push({ a: note, b: other, score: hit.score })
    }
  }

  return pairs.sort((x, y) => y.score - x.score).slice(0, MAX_DUPLICATE_PAIRS)
}

/* -------------------------------- 本地兜底 -------------------------------- */

function localCategoryFor(note: NoteRow, today: string): string {
  const analysis = analyzeNoteLocal({ title: note.title, content: note.content, today })
  return analysis.category
}

function localSummaryFor(note: NoteRow, today: string): string {
  const analysis = analyzeNoteLocal({ title: note.title, content: note.content, today })
  return analysis.summary
}

function planLocally(input: {
  notes: NoteRow[]
  todos: TodoRow[]
  today: string
}): OrganizeResult {
  const now = Date.parse(`${input.today}T00:00:00`)
  const pendingNoteIds = new Set(
    input.todos.filter((todo) => todo.status !== 'done' && todo.note_id !== null).map((todo) => todo.note_id as number),
  )

  const items: OrganizeItem[] = []
  const pool = recentFirst(input.notes)

  // 分类：只看还是占位的，且本地能给出比「待归档」更具体的判断
  for (const note of pool.filter(needsCategory).slice(0, MAX_CANDIDATES)) {
    const next = localCategoryFor(note, input.today)
    if (next === ARCHIVE) continue
    items.push({
      key: organizeKey('category', note.id),
      kind: 'category',
      noteId: note.id,
      title: note.title,
      current: categoryOf(note) || UNCATEGORIZED,
      next,
      reason: '按正文里的关键词判断',
    })
  }

  for (const note of pool.filter(needsSummary).slice(0, MAX_CANDIDATES)) {
    items.push({
      key: organizeKey('summary', note.id),
      kind: 'summary',
      noteId: note.id,
      title: note.title,
      current: '',
      next: limit(localSummaryFor(note, input.today), 120),
      reason: '取正文首句，仅供参考',
    })
  }

  for (const pair of duplicatePairs(input.notes)) {
    // 保留最近更新过的那条，另一条归到待归档。
    const [keep, drop] =
      Date.parse(pair.a.updated_at) >= Date.parse(pair.b.updated_at) ? [pair.a, pair.b] : [pair.b, pair.a]
    if (categoryOf(drop) === ARCHIVE) continue
    items.push({
      key: organizeKey('duplicate', drop.id, keep.id),
      kind: 'duplicate',
      noteId: drop.id,
      title: drop.title,
      current: categoryOf(drop) || UNCATEGORIZED,
      next: ARCHIVE,
      reason: `与《${keep.title}》内容重合 ${pair.score.toFixed(2)}`,
      partnerId: keep.id,
      partnerTitle: keep.title,
    })
  }

  for (const note of pool.filter((item) => isStale(item, now, pendingNoteIds)).slice(0, MAX_CANDIDATES)) {
    items.push({
      key: organizeKey('archive', note.id),
      kind: 'archive',
      noteId: note.id,
      title: note.title,
      current: categoryOf(note) || UNCATEGORIZED,
      next: ARCHIVE,
      reason: `超过 ${STALE_DAYS} 天没动过，也没有未完成的待办`,
    })
  }

  return {
    items,
    source: 'local',
    model: '',
    note: '没接模型，按本地规则整理：分类靠关键词表，摘要取正文首句，重复看内容相似度。',
    scanned: input.notes.length,
  }
}

/* -------------------------------- 模型整理 -------------------------------- */

const ORGANIZE_SYSTEM =
  '你是一个个人信息管家的整理引擎。给你一批资料的标题、现有分类、摘要或正文开头，你需要指出哪些需要调整。' +
  '只输出 JSON，不要任何解释文字。' +
  '分类必须从给定列表里选，不要自造；判定要保守，拿不准就不要输出这一条。' +
  '重复指同一件事被记了两遍或两篇内容几乎一样，保留信息更全的那条，另一条标为待归档。' +
  '归档只给明显过期、已经没有用的内容（比如早就取过的快递码、几个月前的临时安排）。'

interface ModelPayload {
  recategorize?: { id?: number; category?: string; reason?: string }[]
  summaries?: { id?: number; summary?: string }[]
  duplicates?: { keep?: number; drop?: number; reason?: string }[]
  archive?: { id?: number; reason?: string }[]
}

function buildPrompt(input: {
  candidates: NoteRow[]
  pairs: { a: NoteRow; b: NoteRow; score: number }[]
  stale: NoteRow[]
  today: string
}): string {
  const lines: string[] = [`今天是 ${input.today}。`, `可选分类：${NOTE_CATEGORIES.join(' / ')}`, '']

  lines.push('【需要判断分类或补摘要的资料】')
  for (const note of input.candidates) {
    const body = (note.summary ?? note.content).replace(/\s+/g, ' ').slice(0, 120)
    lines.push(
      `#${note.id} 《${defang(note.title)}》 现分类：${categoryOf(note) || '未分类'} 摘要：${note.summary ? '有' : '无'}`,
      `  正文开头：${defang(body)}`,
      `  关键词：${(note.keywords ?? []).slice(0, 5).join('、') || '无'}`,
    )
  }

  if (input.pairs.length > 0) {
    lines.push('', '【疑似重复，请判断是否真重复并决定保留哪条】')
    for (const pair of input.pairs) {
      lines.push(
        `${pair.a.id} 《${defang(pair.a.title)}》 与 ${pair.b.id} 《${defang(pair.b.title)}》 相似度 ${pair.score.toFixed(2)}`,
      )
    }
  }

  if (input.stale.length > 0) {
    lines.push('', `【超过 ${STALE_DAYS} 天没动过，判断是否该归档】`)
    for (const note of input.stale) {
      lines.push(`#${note.id} 《${defang(note.title)}》 ${(note.summary ?? note.content).replace(/\s+/g, ' ').slice(0, 80)}`)
    }
  }

  lines.push(
    '',
    '请输出如下结构的 JSON，拿不准的类别直接给空数组：',
    '{"recategorize":[{"id":1,"category":"学习","reason":"在讲高数作业"}],',
    '"summaries":[{"id":2,"summary":"一句话摘要"}],',
    '"duplicates":[{"keep":3,"drop":4,"reason":"同一件事记了两遍"}],',
    '"archive":[{"id":5,"reason":"几个月前的临时安排，已经没用了"}]}',
  )

  return lines.join('\n')
}

/** 模型没覆盖到的条目用本地结论补上，保证每条候选都有说法。 */
function mergeModelResult(
  payload: ModelPayload,
  byId: Map<number, NoteRow>,
  input: { today: string; categoryIds: Set<number>; summaryIds: Set<number> },
): { category: Map<number, OrganizeItem>; summary: Map<number, OrganizeItem>; others: OrganizeItem[] } {
  const category = new Map<number, OrganizeItem>()
  const summary = new Map<number, OrganizeItem>()
  const others: OrganizeItem[] = []

  for (const row of payload.recategorize ?? []) {
    const note = typeof row.id === 'number' ? byId.get(row.id) : undefined
    const next = (row.category ?? '').trim()
    if (!note || !(NOTE_CATEGORIES as readonly string[]).includes(next)) continue
    if (next === categoryOf(note)) continue
    category.set(note.id, {
      key: organizeKey('category', note.id),
      kind: 'category',
      noteId: note.id,
      title: note.title,
      current: categoryOf(note) || UNCATEGORIZED,
      next,
      reason: limit(row.reason ?? '模型给出的分类', 80),
    })
  }

  for (const row of payload.summaries ?? []) {
    const note = typeof row.id === 'number' ? byId.get(row.id) : undefined
    const next = limit((row.summary ?? '').trim(), 120)
    if (!note || !next) continue
    summary.set(note.id, {
      key: organizeKey('summary', note.id),
      kind: 'summary',
      noteId: note.id,
      title: note.title,
      current: '',
      next,
      reason: '模型生成的一句话摘要',
    })
  }

  for (const row of payload.duplicates ?? []) {
    const keep = typeof row.keep === 'number' ? byId.get(row.keep) : undefined
    const drop = typeof row.drop === 'number' ? byId.get(row.drop) : undefined
    if (!keep || !drop || keep.id === drop.id) continue
    if (categoryOf(drop) === ARCHIVE) continue
    others.push({
      key: organizeKey('duplicate', drop.id, keep.id),
      kind: 'duplicate',
      noteId: drop.id,
      title: drop.title,
      current: categoryOf(drop) || UNCATEGORIZED,
      next: ARCHIVE,
      reason: limit(row.reason ?? `与《${keep.title}》重复`, 80),
      partnerId: keep.id,
      partnerTitle: keep.title,
    })
  }

  for (const row of payload.archive ?? []) {
    const note = typeof row.id === 'number' ? byId.get(row.id) : undefined
    if (!note || categoryOf(note) === ARCHIVE) continue
    others.push({
      key: organizeKey('archive', note.id),
      kind: 'archive',
      noteId: note.id,
      title: note.title,
      current: categoryOf(note) || UNCATEGORIZED,
      next: ARCHIVE,
      reason: limit(row.reason ?? '内容已经过期', 80),
    })
  }

  // 模型漏掉的：本地补上，理由写清楚是规则给的
  for (const id of input.categoryIds) {
    if (category.has(id)) continue
    const note = byId.get(id)
    if (!note) continue
    const next = localCategoryFor(note, input.today)
    if (next === ARCHIVE || next === categoryOf(note)) continue
    category.set(id, {
      key: organizeKey('category', id),
      kind: 'category',
      noteId: id,
      title: note.title,
      current: categoryOf(note) || UNCATEGORIZED,
      next,
      reason: '模型没给建议，按关键词判断',
    })
  }

  for (const id of input.summaryIds) {
    if (summary.has(id)) continue
    const note = byId.get(id)
    if (!note) continue
    summary.set(id, {
      key: organizeKey('summary', id),
      kind: 'summary',
      noteId: id,
      title: note.title,
      current: '',
      next: limit(localSummaryFor(note, input.today), 120),
      reason: '模型没给摘要，取正文首句',
    })
  }

  return { category, summary, others }
}

export async function planOrganize(input: {
  notes: NoteRow[]
  todos: TodoRow[]
  today: string
  signal?: AbortSignal
}): Promise<OrganizeResult> {
  if (input.notes.length === 0) {
    return { items: [], source: 'local', model: '', note: '资料库是空的，没什么可整理。', scanned: 0 }
  }

  if (!isModelReady()) return planLocally(input)

  const settings = loadSettings()
  const now = Date.parse(`${input.today}T00:00:00`)
  const pendingNoteIds = new Set(
    input.todos.filter((todo) => todo.status !== 'done' && todo.note_id !== null).map((todo) => todo.note_id as number),
  )

  const pool = recentFirst(input.notes)
  const categoryIds = new Set(pool.filter(needsCategory).slice(0, MAX_CANDIDATES).map((note) => note.id))
  const summaryIds = new Set(pool.filter(needsSummary).slice(0, MAX_CANDIDATES).map((note) => note.id))
  const candidateIds = new Set([...categoryIds, ...summaryIds])
  const candidates = pool.filter((note) => candidateIds.has(note.id))
  const pairs = duplicatePairs(input.notes)
  const stale = pool.filter((note) => isStale(note, now, pendingNoteIds)).slice(0, MAX_CANDIDATES)
  const byId = new Map(input.notes.map((note) => [note.id, note]))

  let payload: ModelPayload | null = null
  try {
    const raw = await streamChat({
      messages: [
        { role: 'system', content: ORGANIZE_SYSTEM },
        { role: 'user', content: buildPrompt({ candidates, pairs, stale, today: input.today }) },
      ],
      json: true,
      temperature: 0.2,
      signal: input.signal,
    })
    payload = parseJsonObject<ModelPayload>(raw)
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    // 模型调用失败就退回本地，整理这件事不能因为接口抽风就做不了。
    const fallback = planLocally(input)
    return { ...fallback, note: `模型没调通，改按本地规则整理（${error instanceof Error ? error.message : '未知原因'}）` }
  }

  const merged = mergeModelResult(payload ?? {}, byId, { today: input.today, categoryIds, summaryIds })
  const items = [...merged.category.values(), ...merged.summary.values(), ...merged.others]

  return {
    items,
    source: 'model',
    model: settings.model,
    note: `用 ${settings.model} 看过了 ${candidates.length} 条候选。`,
    scanned: input.notes.length,
  }
}
