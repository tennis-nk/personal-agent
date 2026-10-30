import type { Priority, TodoRow } from '../data/types'

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string }

/** 一条资料的自动加工结果。两种后端（大模型 / 本地规则）产出同一结构。 */
export interface NoteAnalysis {
  category: string
  summary: string
  keywords: string[]
  keyPoints: string[]
  todos: { title: string; detail: string | null; priority: Priority; dueDate: string | null }[]
}

export interface RelatedResult {
  noteId: number
  reason: string
  score: number
}

export interface TodoTidySuggestion {
  id: number
  priority: Priority
  dueDate: string | null
  category: string
}

export interface TodoTidyResult {
  groups: { name: string; todoIds: number[]; comment: string }[]
  schedule: TodoTidySuggestion[]
  advice: string
}

export interface ReportResult {
  title: string
  summary: string
  highlights: string[]
  nextActions: string[]
}

export interface QaReference {
  index: number
  noteId: number
  title: string
}

export interface QaContextChunk {
  index: number
  noteId: number
  title: string
  body: string
}

export type { TodoRow }
