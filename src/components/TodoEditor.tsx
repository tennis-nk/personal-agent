import { useEffect, useState } from 'react'
import { NOTE_CATEGORIES } from '../data/categories'
import type { Priority, TodoRow } from '../data/types'

export interface TodoDraft {
  title: string
  detail: string
  date: string
  time: string
  priority: Priority
  category: string
}

interface Props {
  open: boolean
  /** 为空表示新建。 */
  todo: TodoRow | null
  initialDate: string
  initialTime: string
  categoryOptions: string[]
  busy?: boolean
  onSave: (draft: TodoDraft) => void
  onDelete?: () => void
  onToggleDone?: () => void
  onCancel: () => void
}

function toDraft(todo: TodoRow | null, date: string, time: string): TodoDraft {
  if (!todo) {
    return { title: '', detail: '', date, time, priority: 'medium', category: '' }
  }
  return {
    title: todo.title,
    detail: todo.detail ?? '',
    date: todo.due_date ?? date,
    time: todo.due_time ?? '',
    priority: todo.priority,
    category: todo.category && todo.category !== '未分类' ? todo.category : '',
  }
}

/**
 * 待办的编辑弹层，新建和修改共用。
 *
 * 日历上点空白新建、点日程编辑都走这里，
 * 顺带把「待办建好之后改不了」这个缺口补上。
 */
export function TodoEditor({
  open,
  todo,
  initialDate,
  initialTime,
  categoryOptions,
  busy = false,
  onSave,
  onDelete,
  onToggleDone,
  onCancel,
}: Props) {
  const [draft, setDraft] = useState<TodoDraft>(() => toDraft(todo, initialDate, initialTime))

  useEffect(() => {
    if (open) setDraft(toDraft(todo, initialDate, initialTime))
  }, [open, todo, initialDate, initialTime])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, onCancel])

  if (!open) return null

  const update = (patch: Partial<TodoDraft>) => setDraft((prev) => ({ ...prev, ...patch }))
  const done = todo?.status === 'done'

  return (
    <div className="modal-mask" onClick={() => (busy ? undefined : onCancel())}>
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-title">{todo ? '编辑待办' : '新建待办'}</div>

        <div className="field">
          <label className="field-label" htmlFor="todo-editor-title">
            内容
          </label>
          <input
            id="todo-editor-title"
            className="input"
            value={draft.title}
            onChange={(event) => update({ title: event.target.value })}
            placeholder="例如：周五前把初稿发给导师"
            autoFocus
          />
        </div>

        <div className="row wrap" style={{ marginBottom: 14 }}>
          <input
            className="input"
            style={{ width: 150 }}
            type="date"
            value={draft.date}
            onChange={(event) => update({ date: event.target.value })}
            aria-label="日期"
          />
          <input
            className="input"
            style={{ width: 116 }}
            type="time"
            value={draft.time}
            onChange={(event) => update({ time: event.target.value })}
            aria-label="时间"
          />
          <select
            className="select"
            style={{ width: 108 }}
            value={draft.priority}
            onChange={(event) => update({ priority: event.target.value as Priority })}
            aria-label="优先级"
          >
            <option value="high">紧急</option>
            <option value="medium">重要</option>
            <option value="low">一般</option>
          </select>
          <input
            className="input"
            style={{ width: 140 }}
            value={draft.category}
            onChange={(event) => update({ category: event.target.value })}
            placeholder="分类（可选）"
            list="todo-editor-categories"
            aria-label="分类"
          />
          <datalist id="todo-editor-categories">
            {Array.from(new Set([...NOTE_CATEGORIES, ...categoryOptions])).map((item) => (
              <option key={item} value={item} />
            ))}
          </datalist>
        </div>

        <div className="field">
          <label className="field-label" htmlFor="todo-editor-detail">
            备注（可选）
          </label>
          <textarea
            id="todo-editor-detail"
            className="textarea"
            style={{ minHeight: 72 }}
            value={draft.detail}
            onChange={(event) => update({ detail: event.target.value })}
            placeholder="补充说明、链接、验收标准…"
          />
        </div>

        <div className="modal-actions">
          {todo ? (
            <button className="btn ghost small danger" onClick={onDelete} disabled={busy}>
              删除
            </button>
          ) : null}
          {todo && onToggleDone ? (
            <button className="btn ghost small" onClick={onToggleDone} disabled={busy}>
              {done ? '重新打开' : '标记完成'}
            </button>
          ) : null}
          <div className="spacer" />
          <button className="btn" onClick={onCancel} disabled={busy}>
            取消
          </button>
          <button
            className="btn primary"
            onClick={() => onSave(draft)}
            disabled={busy || !draft.title.trim()}
          >
            {busy ? <span className="spinner" /> : null}
            保存
          </button>
        </div>
      </div>
    </div>
  )
}
