import { emptyDb, LOCAL_USER_ID, readDb, writeDb } from './storage'
import type {
  ChatMessageRow,
  CourseRow,
  LocalDatabase,
  NoteLinkRow,
  NoteRow,
  NoteSource,
  Priority,
  ReportRow,
  TodoRow,
  TodoStatus,
} from './types'

/**
 * 本地数据层。
 *
 * 对外暴露的接口与云端版本逐一同名同签名，
 * 上层页面与状态层不需要关心数据到底落在哪里。
 * 所有函数都是 async，未来换回云端实现时调用点不用改。
 */

function nowIso(): string {
  return new Date().toISOString()
}

function nextId(db: LocalDatabase): number {
  const maxId = Math.max(
    0,
    ...db.notes.map((item) => item.id),
    ...db.todos.map((item) => item.id),
    ...db.courses.map((item) => item.id),
    ...db.links.map((item) => item.id),
    ...db.messages.map((item) => item.id),
    ...db.reports.map((item) => item.id),
  )
  db.seq = Math.max(db.seq, maxId) + 1
  return db.seq
}

/** 读—改—写。改动发生在纯函数里，写完立刻落盘，避免半途失败留下脏数据。 */
function mutate<T>(fn: (db: LocalDatabase) => T): T {
  const db = readDb()
  const result = fn(db)
  writeDb(db)
  return result
}

function dateValue(iso: string | null | undefined): number {
  if (!iso) return Number.NEGATIVE_INFINITY
  const time = Date.parse(iso)
  return Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time
}

/* ---------------------------------- 资料 ---------------------------------- */

export interface NoteInput {
  title: string
  content: string
  category?: string | null
  summary?: string | null
  keywords?: string[]
  key_points?: string[]
  pinned?: boolean
  /** 本地文件导入时带上来源，用于去重。 */
  source?: NoteSource | null
}

export async function listNotes(keyword?: string): Promise<NoteRow[]> {
  const db = readDb()
  const kw = (keyword ?? '').trim().toLowerCase()
  const rows = kw
    ? db.notes.filter((note) =>
        [note.title, note.content, note.summary ?? '', note.category ?? '', (note.keywords ?? []).join(' ')]
          .join(' ')
          .toLowerCase()
          .includes(kw),
      )
    : [...db.notes]

  return rows.sort((a, b) => {
    const pinnedDiff = Number(b.pinned ?? false) - Number(a.pinned ?? false)
    return pinnedDiff !== 0 ? pinnedDiff : dateValue(b.created_at) - dateValue(a.created_at)
  })
}

export async function createNote(input: NoteInput): Promise<NoteRow> {
  return mutate((db) => {
    const timestamp = nowIso()
    const row: NoteRow = {
      id: nextId(db),
      owner_id: LOCAL_USER_ID,
      owner_name: null,
      title: input.title,
      content: input.content,
      category: input.category ?? '未分类',
      summary: input.summary ?? null,
      keywords: input.keywords ?? [],
      key_points: input.key_points ?? [],
      pinned: input.pinned ?? false,
      source: input.source ?? null,
      created_at: timestamp,
      updated_at: timestamp,
    }
    db.notes.push(row)
    return row
  })
}

export type NotePatch = Partial<NoteInput>

export async function updateNote(id: number, patch: NotePatch): Promise<NoteRow> {
  return mutate((db) => {
    const row = db.notes.find((item) => item.id === id)
    if (!row) throw new Error('这条资料已经不存在了。')

    if (patch.title !== undefined) row.title = patch.title
    if (patch.content !== undefined) row.content = patch.content
    if (patch.category !== undefined) row.category = patch.category
    if (patch.summary !== undefined) row.summary = patch.summary
    if (patch.keywords !== undefined) row.keywords = patch.keywords
    if (patch.key_points !== undefined) row.key_points = patch.key_points
    if (patch.pinned !== undefined) row.pinned = patch.pinned
    if (patch.source !== undefined) row.source = patch.source
    row.updated_at = nowIso()
    return row
  })
}

export async function deleteNote(id: number): Promise<void> {
  mutate((db) => {
    db.notes = db.notes.filter((item) => item.id !== id)
    // 关联边与派生待办跟着一起清，否则会留下指向空资料的悬空记录。
    db.links = db.links.filter((item) => item.note_id !== id && item.related_note_id !== id)
    db.todos = db.todos.filter((item) => item.note_id !== id)
  })
}

/* ---------------------------------- 待办 ---------------------------------- */

export interface TodoInput {
  title: string
  detail?: string | null
  status?: TodoStatus
  priority?: Priority
  due_date?: string | null
  due_time?: string | null
  category?: string | null
  note_id?: number | null
}

export async function listTodos(): Promise<TodoRow[]> {
  const db = readDb()
  return [...db.todos].sort((a, b) => {
    // 未完成的排前面；都没有截止日时按创建时间倒序。
    const statusDiff = Number(a.status === 'done') - Number(b.status === 'done')
    if (statusDiff !== 0) return statusDiff

    const aDue = a.due_date ? dateValue(a.due_date) : Number.POSITIVE_INFINITY
    const bDue = b.due_date ? dateValue(b.due_date) : Number.POSITIVE_INFINITY
    if (aDue !== bDue) return aDue - bDue

    return dateValue(b.created_at) - dateValue(a.created_at)
  })
}

export async function createTodo(input: TodoInput): Promise<TodoRow> {
  return mutate((db) => {
    const timestamp = nowIso()
    const row: TodoRow = {
      id: nextId(db),
      owner_id: LOCAL_USER_ID,
      owner_name: null,
      title: input.title,
      detail: input.detail ?? null,
      status: input.status ?? 'pending',
      priority: input.priority ?? 'medium',
      due_date: input.due_date ?? null,
      due_time: input.due_time ?? null,
      category: input.category ?? '未分类',
      note_id: input.note_id ?? null,
      completed_at: null,
      created_at: timestamp,
      updated_at: timestamp,
    }
    db.todos.push(row)
    return row
  })
}

export interface TodoPatch {
  title?: string
  detail?: string | null
  status?: TodoStatus
  priority?: Priority
  due_date?: string | null
  due_time?: string | null
  category?: string | null
}

export async function updateTodo(id: number, patch: TodoPatch): Promise<TodoRow> {
  return mutate((db) => {
    const row = db.todos.find((item) => item.id === id)
    if (!row) throw new Error('这条待办已经不存在了。')

    if (patch.title !== undefined) row.title = patch.title
    if (patch.detail !== undefined) row.detail = patch.detail
    if (patch.status !== undefined) row.status = patch.status
    if (patch.priority !== undefined) row.priority = patch.priority
    if (patch.due_date !== undefined) row.due_date = patch.due_date
    if (patch.due_time !== undefined) row.due_time = patch.due_time
    if (patch.category !== undefined) row.category = patch.category

    if (patch.status === 'done') row.completed_at = nowIso()
    if (patch.status === 'pending') row.completed_at = null
    row.updated_at = nowIso()
    return row
  })
}

export async function deleteTodo(id: number): Promise<void> {
  mutate((db) => {
    db.todos = db.todos.filter((item) => item.id !== id)
  })
}

/* ---------------------------------- 课表 ---------------------------------- */

export interface CourseInput {
  name: string
  teacher?: string | null
  location?: string | null
  weekday: number
  start_slot: number
  end_slot: number
  start_time: string
  end_time: string
  weeks: number[]
  semester_start: string
}

export async function listCourses(): Promise<CourseRow[]> {
  const db = readDb()
  return [...db.courses].sort(
    (a, b) => a.weekday - b.weekday || a.start_slot - b.start_slot || a.name.localeCompare(b.name, 'zh-Hans-CN'),
  )
}

/** 导入是「整表替换」语义：先清空再写入，避免反复导入叠成一堆重复课程。 */
export async function replaceCourses(inputs: CourseInput[]): Promise<CourseRow[]> {
  return mutate((db) => {
    db.courses = []
    const rows: CourseRow[] = inputs.map((input) => ({
      id: nextId(db),
      owner_id: LOCAL_USER_ID,
      name: input.name,
      teacher: input.teacher ?? null,
      location: input.location ?? null,
      weekday: input.weekday,
      start_slot: input.start_slot,
      end_slot: input.end_slot,
      start_time: input.start_time,
      end_time: input.end_time,
      weeks: input.weeks,
      semester_start: input.semester_start,
      created_at: nowIso(),
    }))
    db.courses.push(...rows)
    return rows
  })
}

export async function deleteCourse(id: number): Promise<void> {
  mutate((db) => {
    db.courses = db.courses.filter((item) => item.id !== id)
  })
}

/** 开学日填错不用重新导入：整份课表相对周次不变，只把起算日期平移过去。 */
export async function updateSemesterStart(date: string): Promise<CourseRow[]> {
  return mutate((db) => {
    db.courses = db.courses.map((row) => ({ ...row, semester_start: date }))
    return db.courses
  })
}

export async function clearCourses(): Promise<void> {
  mutate((db) => {
    db.courses = []
  })
}

/* --------------------------------- 内容关联 -------------------------------- */

export interface LinkInput {
  related_note_id: number
  reason?: string | null
  score?: number | null
}

/** 关联关系是「重新计算」语义：先清掉旧边再写新边，避免反复重算时无限累积。 */
export async function replaceLinks(noteId: number, links: LinkInput[]): Promise<NoteLinkRow[]> {
  return mutate((db) => {
    db.links = db.links.filter((item) => item.note_id !== noteId)
    const created: NoteLinkRow[] = links.map((link) => ({
      id: nextId(db),
      owner_id: LOCAL_USER_ID,
      note_id: noteId,
      related_note_id: link.related_note_id,
      reason: link.reason ?? null,
      score: link.score ?? 0,
      created_at: nowIso(),
    }))
    db.links.push(...created)
    return created
  })
}

/** 双向取边：A→B 与 B→A 都算相关。 */
export async function listLinks(noteId: number): Promise<NoteLinkRow[]> {
  const db = readDb()
  return db.links.filter((item) => item.note_id === noteId || item.related_note_id === noteId)
}

/** 一次性取全部关联边，供待办整理和工作台复用，避免逐条查询。 */
export async function listAllLinks(): Promise<NoteLinkRow[]> {
  return readDb().links
}

/* --------------------------------- 智能问答 -------------------------------- */

const MAX_MESSAGES = 200

export async function listMessages(conversationId: string): Promise<ChatMessageRow[]> {
  const db = readDb()
  return db.messages
    .filter((item) => item.conversation_id === conversationId)
    .sort((a, b) => dateValue(a.created_at) - dateValue(b.created_at))
    .slice(0, MAX_MESSAGES)
}

export async function appendMessage(input: {
  conversationId: string
  role: 'user' | 'assistant'
  content: string
  refs?: string[]
}): Promise<void> {
  mutate((db) => {
    db.messages.push({
      id: nextId(db),
      owner_id: LOCAL_USER_ID,
      conversation_id: input.conversationId,
      role: input.role,
      content: input.content,
      refs: input.refs ?? [],
      created_at: nowIso(),
    })
    // 会话记录只保留最近若干条，防止本地库无限膨胀。
    if (db.messages.length > MAX_MESSAGES) {
      db.messages = db.messages.slice(db.messages.length - MAX_MESSAGES)
    }
  })
}

export async function clearMessages(conversationId: string): Promise<void> {
  mutate((db) => {
    db.messages = db.messages.filter((item) => item.conversation_id !== conversationId)
  })
}

/* --------------------------------- 阶段总结 -------------------------------- */

export async function listReports(): Promise<ReportRow[]> {
  const db = readDb()
  return [...db.reports].sort((a, b) => dateValue(b.created_at) - dateValue(a.created_at))
}

export async function createReport(input: {
  periodStart: string
  periodEnd: string
  title: string
  summary: string
  highlights: string[]
  nextActions: string[]
  stats: Record<string, number>
}): Promise<ReportRow> {
  return mutate((db) => {
    const row: ReportRow = {
      id: nextId(db),
      owner_id: LOCAL_USER_ID,
      period_start: input.periodStart,
      period_end: input.periodEnd,
      title: input.title,
      summary: input.summary,
      highlights: input.highlights,
      next_actions: input.nextActions,
      stats: input.stats,
      created_at: nowIso(),
    }
    db.reports.push(row)
    return row
  })
}

export async function deleteReport(id: number): Promise<void> {
  mutate((db) => {
    db.reports = db.reports.filter((item) => item.id !== id)
  })
}

/* ------------------------------ 备份与迁移 ------------------------------ */

const SCHEMA_VERSION_LOCAL = 1

export interface BackupFile {
  app: 'infobutler'
  version: number
  exportedAt: string
  data: LocalDatabase
}

export function exportBackup(): BackupFile {
  return {
    app: 'infobutler',
    version: SCHEMA_VERSION_LOCAL,
    exportedAt: nowIso(),
    data: readDb(),
  }
}

/** 导入备份：整库替换前先验形，形状不对就拒绝，宁可不导也不能写坏。 */
export function importBackup(raw: string): void {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('这不是有效的 JSON 文件。')
  }

  const payload = parsed as Partial<BackupFile>
  const data = (payload.data ?? (payload as unknown as LocalDatabase)) as Partial<LocalDatabase>
  if (!data || !Array.isArray(data.notes) || !Array.isArray(data.todos)) {
    throw new Error('文件里没有找到资料与待办数据。')
  }

  const merged: LocalDatabase = {
    version: SCHEMA_VERSION_LOCAL,
    notes: data.notes,
    todos: data.todos,
    courses: Array.isArray(data.courses) ? data.courses : [],
    links: Array.isArray(data.links) ? data.links : [],
    messages: Array.isArray(data.messages) ? data.messages : [],
    reports: Array.isArray(data.reports) ? data.reports : [],
    seq: typeof data.seq === 'number' ? data.seq : 0,
  }
  writeDb(merged)
}

export function resetAll(): void {
  writeDb(emptyDb())
}
