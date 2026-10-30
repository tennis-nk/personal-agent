export type TodoStatus = 'pending' | 'done'
export type Priority = 'high' | 'medium' | 'low'

/**
 * 资料的外部来源。本地文件导入时记下来，用来去重、回看原文件位置。
 * 只用浏览器能拿到的信息：路径、大小、修改时间；不保存文件内容之外的东西。
 */
export interface NoteSource {
  kind: 'file' | 'folder'
  /** 展示用路径。文件夹导入是「文件夹名/相对路径」，单文件导入就是文件名。 */
  path: string
  /** 所属文件夹名，单文件导入时为 null。 */
  folder?: string | null
  size: number
  mtime?: number | null
  /** 正文没能读出来时记一句原因，界面上直接显示给用户看。 */
  hint?: string | null
}

/**
 * 资料条目。
 *
 * category / summary / keywords / key_points 是 AI 加工字段：
 * 保存时若接入了大模型则由模型补全，否则走本地规则引擎兜底，
 * 两者产出的结构完全一致，上层界面不需要区分数据来源。
 */
export interface NoteRow {
  id: number
  owner_id: string
  owner_name: string | null
  title: string
  content: string
  category: string | null
  summary: string | null
  keywords: string[] | null
  key_points: string[] | null
  pinned: boolean | null
  /** 由本地文件导入而来时记录来源；手动记录的资料为 null。 */
  source?: NoteSource | null
  created_at: string
  updated_at: string
}

/** 待办条目。可由资料自动派生（note_id 指向来源资料）。 */
export interface TodoRow {
  id: number
  owner_id: string
  owner_name: string | null
  title: string
  detail: string | null
  status: TodoStatus
  priority: Priority
  due_date: string | null
  /** 具体时刻 HH:mm。有值才在日历的时间轴上占位，为空则落在「全天」一栏。 */
  due_time?: string | null
  category: string | null
  note_id: number | null
  completed_at: string | null
  created_at: string
  updated_at: string
}

/**
 * 课表课程。
 *
 * 一门课在课表里是一周重复一次的，所以这里存「模板」而不是逐个日期生成待办：
 * weekday + 节次 + 周次 + 学期起始日，就能推导出整个学期它在哪几天上课。
 */
export interface CourseRow {
  id: number
  owner_id: string
  name: string
  teacher: string | null
  location: string | null
  /** 1 = 周一 … 7 = 周日 */
  weekday: number
  start_slot: number
  end_slot: number
  /** 由节次换算出的具体时间，导入时按当时的作息表算好存下来。 */
  start_time: string
  end_time: string
  /** 这节课出现在第几周，如 [1,2,...,16]。 */
  weeks: number[]
  /** 学期第一周的周一，YYYY-MM-DD，用来把周次换算成真实日期。 */
  semester_start: string
  created_at: string
}

/** 资料之间的关联关系，带理由与相关度。 */
export interface NoteLinkRow {
  id: number
  owner_id: string
  note_id: number
  related_note_id: number
  reason: string | null
  score: number | null
  created_at: string
}

/** 智能问答的会话消息。 */
export interface ChatMessageRow {
  id: number
  owner_id: string
  conversation_id: string
  role: 'user' | 'assistant'
  content: string
  refs: string[] | null
  created_at: string
}

/** 阶段总结。 */
export interface ReportRow {
  id: number
  owner_id: string
  period_start: string
  period_end: string
  title: string
  summary: string | null
  highlights: string[] | null
  next_actions: string[] | null
  stats: Record<string, number> | null
  created_at: string
}

/** 本地库的整体形状，导入导出与持久化都用它。 */
export interface LocalDatabase {
  version: number
  notes: NoteRow[]
  todos: TodoRow[]
  courses: CourseRow[]
  links: NoteLinkRow[]
  messages: ChatMessageRow[]
  reports: ReportRow[]
  seq: number
}
