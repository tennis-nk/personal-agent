import { useMemo, useState } from 'react'
import { tidyTodos, type TodoTidyResult } from '../ai/agent'
import { ModeHint } from '../components/ModeHint'
import { useToast } from '../components/Toast'
import type { Priority, TodoRow } from '../data/types'
import { useStore } from '../store'
import { daysBetween, today } from '../utils/date'

const PRIORITY_LABEL: Record<Priority, string> = {
  high: '紧急',
  medium: '重要',
  low: '一般',
}

const PRIORITY_CLASS: Record<Priority, string> = {
  high: 'red',
  medium: 'amber',
  low: 'green',
}

type GroupMode = 'priority' | 'category' | 'all'

export function TodosPage() {
  const { todos, addTodo, patchTodo, removeTodo, loading } = useStore()
  const toast = useToast()
  const [title, setTitle] = useState('')
  const [priority, setPriority] = useState<Priority>('medium')
  const [dueDate, setDueDate] = useState('')
  const [dueTime, setDueTime] = useState('')
  const [category, setCategory] = useState('')
  const [mode, setMode] = useState<GroupMode>('priority')
  const [tidy, setTidy] = useState<TodoTidyResult | null>(null)
  const [tidying, setTidying] = useState(false)
  const [busy, setBusy] = useState(false)

  const pending = todos.filter((todo) => todo.status === 'pending')
  const done = todos.filter((todo) => todo.status === 'done')
  const overdue = pending.filter((todo) => todo.due_date && daysBetween(today(), todo.due_date) < 0)

  const groups = useMemo(() => {
    if (mode === 'all') return [{ key: 'all', label: `全部待办（${pending.length}）`, items: pending }]
    if (mode === 'priority') {
      return (['high', 'medium', 'low'] as Priority[]).map((level) => ({
        key: level,
        label: `${PRIORITY_LABEL[level]}（${pending.filter((todo) => todo.priority === level).length}）`,
        items: pending.filter((todo) => todo.priority === level),
      }))
    }
    const names = Array.from(new Set(pending.map((todo) => todo.category ?? '未分类')))
    return names.map((name) => ({
      key: name,
      label: `${name}（${pending.filter((todo) => (todo.category ?? '未分类') === name).length}）`,
      items: pending.filter((todo) => (todo.category ?? '未分类') === name),
    }))
  }, [mode, pending])

  async function handleAdd(event: React.FormEvent) {
    event.preventDefault()
    const text = title.trim()
    if (!text) return
    setBusy(true)
    try {
      await addTodo({
        title: text,
        priority,
        due_date: dueDate || null,
        due_time: dueDate ? dueTime || null : null,
        category: category.trim() || '未分类',
      })
      setTitle('')
      setDueDate('')
      setDueTime('')
      setCategory('')
      setPriority('medium')
    } catch (err) {
      toast(err instanceof Error ? err.message : '待办保存失败，请重试。', 'error')
    } finally {
      setBusy(false)
    }
  }

  async function handleTidy() {
    if (pending.length === 0) return
    setTidying(true)
    try {
      const result = await tidyTodos({ todos: pending, today: today() })
      setTidy(result)
    } catch (err) {
      toast(err instanceof Error ? err.message : '整理失败，请重试。', 'error')
    } finally {
      setTidying(false)
    }
  }

  async function applyTidy() {
    if (!tidy || tidy.schedule.length === 0) return
    setBusy(true)
    try {
      for (const item of tidy.schedule) {
        await patchTodo(item.id, {
          priority: item.priority,
          due_date: item.dueDate,
          category: item.category,
        })
      }
      setTidy(null)
    } catch (err) {
      toast(err instanceof Error ? err.message : '应用整理结果失败，请重试。', 'error')
    } finally {
      setBusy(false)
    }
  }

  function dueLabel(todo: TodoRow): string {
    if (!todo.due_date) return '无截止'
    const time = todo.due_time ? ` ${todo.due_time}` : ''
    const diff = daysBetween(today(), todo.due_date)
    if (diff < 0) return `已逾期 ${-diff} 天`
    if (diff === 0) return `今天${time || '到期'}`
    if (diff === 1) return `明天${time}`
    return `${todo.due_date}${time}`
  }

  return (
    <>
      <div className="card">
        <div className="card-head">
          <div className="card-title">新建待办</div>
        </div>
        <div className="card-body">
          <form onSubmit={handleAdd}>
            <div className="field">
              <label className="field-label" htmlFor="todo-title">
                内容
              </label>
              <input
                id="todo-title"
                className="input"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="例如：周五前把初稿发给导师"
              />
            </div>
            <div className="row wrap" style={{ marginBottom: 14 }}>
              <select
                className="select"
                style={{ width: 130 }}
                value={priority}
                onChange={(event) => setPriority(event.target.value as Priority)}
                aria-label="优先级"
              >
                <option value="high">紧急</option>
                <option value="medium">重要</option>
                <option value="low">一般</option>
              </select>
              <input
                className="input"
                style={{ width: 158 }}
                type="date"
                value={dueDate}
                onChange={(event) => setDueDate(event.target.value)}
                aria-label="截止日期"
              />
              <input
                className="input"
                style={{ width: 112 }}
                type="time"
                value={dueTime}
                onChange={(event) => setDueTime(event.target.value)}
                disabled={!dueDate}
                aria-label="截止时间"
              />
              <input
                className="input"
                style={{ width: 170 }}
                value={category}
                onChange={(event) => setCategory(event.target.value)}
                placeholder="分类（可选）"
              />
              <button className="btn primary" type="submit" disabled={!title.trim() || busy}>
                {busy ? <span className="spinner" /> : null}
                添加
              </button>
            </div>
          </form>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <div className="card-title">待办整理</div>
          <div className="card-head-right">
            <button className={`chip-btn${mode === 'priority' ? ' active' : ''}`} onClick={() => setMode('priority')}>
              按优先级
            </button>
            <button className={`chip-btn${mode === 'category' ? ' active' : ''}`} onClick={() => setMode('category')}>
              按分类
            </button>
            <button className={`chip-btn${mode === 'all' ? ' active' : ''}`} onClick={() => setMode('all')}>
              不分组
            </button>
            <button className="btn small" onClick={() => void handleTidy()} disabled={tidying || pending.length === 0}>
              {tidying ? <span className="spinner" /> : null}
              AI 一键整理
            </button>
          </div>
          <ModeHint text="离线模式下，一键整理会按逾期情况、优先级与截止日重排，并用关键词做主题分组。" />
        </div>
        <div className="card-body">
          {overdue.length > 0 ? (
            <div className="notice warn" style={{ marginBottom: 14 }}>
              有 {overdue.length} 条待办已逾期，建议先处理或改期。
            </div>
          ) : null}

          {tidy ? (
            <div className="notice" style={{ marginBottom: 14, background: 'var(--accent-soft)', borderColor: 'var(--accent-line)' }}>
              <div style={{ fontWeight: 650, marginBottom: 6 }}>AI 整理结果</div>
              {tidy.advice ? <div style={{ marginBottom: 8 }}>{tidy.advice}</div> : null}
              {tidy.groups.length > 0 ? (
                <div className="row wrap" style={{ marginBottom: 8 }}>
                  {tidy.groups.map((group, index) => (
                    <span key={index} className="tag blue" title={group.comment}>
                      {group.name} · {group.todoIds.length} 条
                    </span>
                  ))}
                </div>
              ) : null}
              <div className="row">
                <button className="btn primary small" onClick={() => void applyTidy()} disabled={busy}>
                  应用优先级与日期调整
                </button>
                <button className="btn small" onClick={() => setTidy(null)}>
                  忽略
                </button>
              </div>
            </div>
          ) : null}

          {loading && todos.length === 0 ? (
            <div className="empty">正在加载待办…</div>
          ) : groups.every((group) => group.items.length === 0) ? (
            <div className="empty">没有待处理的待办</div>
          ) : (
            groups
              .filter((group) => group.items.length > 0)
              .map((group) => (
                <div key={group.key} style={{ marginBottom: 16 }}>
                  <div className="section-title">{group.label}</div>
                  <div className="list">
                    {group.items.map((todo) => (
                      <div key={todo.id} className="list-item">
                        <input
                          type="checkbox"
                          checked={false}
                          onChange={() => void patchTodo(todo.id, { status: 'done' })}
                          aria-label="标记完成"
                        />
                        <div className="list-main">
                          <div className="list-title">{todo.title}</div>
                          <div className="row wrap" style={{ marginTop: 4 }}>
                            <span className={`tag ${PRIORITY_CLASS[todo.priority]}`}>
                              {PRIORITY_LABEL[todo.priority]}
                            </span>
                            <span className="tag">{todo.category ?? '未分类'}</span>
                            <span className="small muted">{dueLabel(todo)}</span>
                          </div>
                          {todo.detail ? (
                            <div className="small muted" style={{ marginTop: 4 }}>
                              {todo.detail}
                            </div>
                          ) : null}
                        </div>
                        <button className="btn ghost small danger" onClick={() => void removeTodo(todo.id)}>
                          删除
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              ))
          )}

          {done.length > 0 ? (
            <div>
              <div className="section-title">已完成（{done.length}）</div>
              <div className="list">
                {done.map((todo) => (
                  <div key={todo.id} className="list-item">
                    <input
                      type="checkbox"
                      checked
                      onChange={() => void patchTodo(todo.id, { status: 'pending' })}
                      aria-label="重新打开"
                    />
                    <div className="list-main">
                      <div className="list-title" style={{ textDecoration: 'line-through', color: 'var(--muted)' }}>
                        {todo.title}
                      </div>
                    </div>
                    <button className="btn ghost small danger" onClick={() => void removeTodo(todo.id)}>
                      删除
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </>
  )
}
