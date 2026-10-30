import { useMemo, useState } from 'react'
import { ImportTimetableDialog, type ImportRow } from '../components/ImportTimetableDialog'
import { MiniCalendar } from '../components/MiniCalendar'
import { TodoEditor, type TodoDraft } from '../components/TodoEditor'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { useToast } from '../components/Toast'
import { WeekGrid } from '../components/WeekGrid'
import {
  buildDayEvents,
  courseOccursOn,
  countWeekCourses,
  isoWeekday,
  mondayOf,
  suggestSemesterStart,
  weekIndexOf,
  type DayEvent,
} from '../schedule/occurrence'
import { weekdayName } from '../schedule/parse'
import type { TodoRow } from '../data/types'
import { useStore } from '../store'
import { shiftDays, today } from '../utils/date'

type View = 'day' | 'week' | 'month'

const VIEW_LABELS: { key: View; label: string }[] = [
  { key: 'day', label: '日' },
  { key: 'week', label: '周' },
  { key: 'month', label: '月' },
]

function pad(value: number): string {
  return `${value}`.padStart(2, '0')
}

function monthLabel(date: string): string {
  const [year, month] = date.split('-').map((part) => Number(part))
  return `${year}年${month}月`
}

function shortDate(date: string): string {
  const parts = date.split('-').map((part) => Number(part))
  return `${parts[1]}月${parts[2]}日`
}

export function CalendarPage({ onOpenPlan }: { onOpenPlan: () => void }) {
  const { todos, courses, addTodo, patchTodo, removeTodo, importCourses, rescheduleCourses, removeCourse } = useStore()
  const toast = useToast()

  const [view, setView] = useState<View>('week')
  const [cursor, setCursor] = useState(() => today())
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const [showCourses, setShowCourses] = useState(true)

  const [editorOpen, setEditorOpen] = useState(false)
  const [editing, setEditing] = useState<TodoRow | null>(null)
  const [seed, setSeed] = useState({ date: today(), time: '' })
  const [saving, setSaving] = useState(false)

  const [pendingDeleteTodo, setPendingDeleteTodo] = useState<number | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [importing, setImporting] = useState(false)
  const [pendingCourse, setPendingCourse] = useState<number | null>(null)

  const categories = useMemo(
    () => Array.from(new Set(todos.map((todo) => todo.category ?? '未分类'))),
    [todos],
  )

  const visibleCategories = useMemo(() => {
    if (hidden.size === 0) return null
    return new Set(categories.filter((item) => !hidden.has(item)))
  }, [hidden, categories])

  // 关掉「显示课程」时给个空数组，但必须是稳定引用，否则每次渲染都会重算整张日历。
  const visibleCourses = useMemo(() => (showCourses ? courses : []), [showCourses, courses])

  const days = useMemo(() => {
    if (view === 'day') return [cursor]
    if (view === 'week') {
      const start = mondayOf(cursor)
      return Array.from({ length: 7 }, (_, index) => shiftDays(start, index))
    }
    const first = `${cursor.slice(0, 7)}-01`
    const start = mondayOf(first)
    return Array.from({ length: 42 }, (_, index) => shiftDays(start, index))
  }, [view, cursor])

  const eventsByDate = useMemo(() => {
    const map = new Map<string, DayEvent[]>()
    for (const day of days) {
      map.set(day, buildDayEvents(day, todos, visibleCourses, visibleCategories))
    }
    return map
  }, [days, todos, visibleCourses, visibleCategories])

  const markers = useMemo(() => {
    const result: Record<string, number> = {}
    for (const day of days) {
      const count = (eventsByDate.get(day) ?? []).length
      if (count > 0) result[day] = count
    }
    return result
  }, [days, eventsByDate])

  // 导入成功但日历空白，几乎都是开学日算错了：这种情况直接把原因写在日历上，
  // 免得用户以为导入失败、反复重来。
  const emptyHint = useMemo(() => {
    if (courses.length === 0 || view === 'day') return null
    const date = today()
    if (!days.includes(date)) return null

    const current = courses[0].semester_start
    const index = weekIndexOf(current, date)
    const weekCount = countWeekCourses(courses, current, date)
    const suggestion = suggestSemesterStart(courses, date)
    const suggestionCount = suggestion ? countWeekCourses(courses, suggestion, date) : 0
    const head = `开学日 ${current}，今天是第 ${index} 周`

    if (suggestion && suggestionCount > weekCount) {
      return weekCount === 0
        ? `${head}，这一段一节都没排上。按 ${suggestion} 重排，本周能有 ${suggestionCount} 节。`
        : `${head}，本周只排到 ${weekCount} 节，少了点；按 ${suggestion} 重排是 ${suggestionCount} 节。`
    }
    if (weekCount === 0) return `${head}，这一段没排到课。开学日填错的话整学期都会错位。`
    return null
  }, [courses, days, view])

  /** 开学日多半填晚了：直接推一个能排上课的日期，省得用户自己算第几周。 */
  const suggestion = useMemo(() => suggestSemesterStart(courses, today()), [courses])

  const [draftStart, setDraftStart] = useState('')

  async function handleReschedule(date: string): Promise<void> {
    try {
      const rows = await rescheduleCourses(date)
      const hits = rows.filter((row) => courseOccursOn(row, today())).length
      toast(
        hits > 0
          ? `开学日改成了 ${date}，今天起按新的日期排课。`
          : `开学日改成了 ${date}，但今天还是排不到课，再往前推几周试试。`,
        hits > 0 ? 'ok' : 'error',
      )
    } catch (error) {
      toast(error instanceof Error ? error.message : '改开学日失败，请重试。', 'error')
    }
  }

  function step(delta: number): void {
    if (view === 'day') {
      setCursor(shiftDays(cursor, delta))
      return
    }
    if (view === 'week') {
      setCursor(shiftDays(cursor, delta * 7))
      return
    }
    const [year, month] = cursor.split('-').map((part) => Number(part))
    const next = new Date(year, month - 1 + delta, 1)
    setCursor(`${next.getFullYear()}-${pad(next.getMonth() + 1)}-01`)
  }

  const title =
    view === 'day'
      ? `${shortDate(cursor)} ${weekdayName(isoWeekday(cursor))}`
      : view === 'week'
        ? `${shortDate(days[0])} - ${shortDate(days[days.length - 1])}`
        : monthLabel(cursor)

  function openCreate(date: string, hour?: number): void {
    setEditing(null)
    setSeed({ date, time: hour === undefined ? '' : `${pad(hour)}:00` })
    setEditorOpen(true)
  }

  function openEvent(event: DayEvent): void {
    if (event.kind === 'todo' && event.todo) {
      setEditing(event.todo)
      setSeed({ date: event.todo.due_date ?? cursor, time: event.todo.due_time ?? '' })
      setEditorOpen(true)
      return
    }
    if (event.course) {
      const course = event.course
      toast(
        `${course.name} · ${weekdayName(course.weekday)} 第${course.start_slot}-${course.end_slot}节 · ${
          course.location || '未填地点'
        }`,
      )
    }
  }

  async function handleSave(draft: TodoDraft): Promise<void> {
    setSaving(true)
    try {
      const payload = {
        title: draft.title.trim(),
        detail: draft.detail.trim() || null,
        priority: draft.priority,
        category: draft.category.trim() || '未分类',
        due_date: draft.date || null,
        due_time: draft.time || null,
      }
      if (editing) {
        await patchTodo(editing.id, payload)
      } else {
        await addTodo(payload)
      }
      setEditorOpen(false)
    } catch (error) {
      toast(error instanceof Error ? error.message : '保存失败，请重试。', 'error')
    } finally {
      setSaving(false)
    }
  }

  async function confirmDeleteTodo(): Promise<void> {
    if (pendingDeleteTodo === null) return
    try {
      await removeTodo(pendingDeleteTodo)
      setPendingDeleteTodo(null)
      setEditorOpen(false)
    } catch (error) {
      toast(error instanceof Error ? error.message : '删除失败，请重试。', 'error')
    }
  }

  async function handleImport(rows: ImportRow[]): Promise<void> {
    setImporting(true)
    try {
      const saved = await importCourses(
        rows.map((row) => ({
          name: row.name,
          teacher: row.teacher || null,
          location: row.location || null,
          weekday: row.weekday,
          start_slot: row.startSlot,
          end_slot: row.endSlot,
          start_time: row.startTime,
          end_time: row.endTime,
          weeks: row.weeks,
          semester_start: row.semesterStart,
        })),
      )
      setImportOpen(false)
      toast(`已导入 ${saved.length} 门课，日历上按周自动展开。`, 'ok')
    } catch (error) {
      toast(error instanceof Error ? error.message : '导入失败，请重试。', 'error')
    } finally {
      setImporting(false)
    }
  }

  async function confirmRemoveCourse(): Promise<void> {
    if (pendingCourse === null) return
    try {
      await removeCourse(pendingCourse)
    } catch (error) {
      toast(error instanceof Error ? error.message : '删除失败，请重试。', 'error')
    } finally {
      setPendingCourse(null)
    }
  }

  return (
    <div className="cal">
      <aside className="cal-side">
        <MiniCalendar cursor={cursor} onSelect={setCursor} markers={markers} />

        <div className="cal-side-block">
          <div className="cal-side-title">待办筛选</div>
          {categories.length === 0 ? (
            <div className="small muted">还没有待办</div>
          ) : (
            categories.map((item) => (
              <label key={item} className="cal-check">
                <input
                  type="checkbox"
                  checked={!hidden.has(item)}
                  onChange={() =>
                    setHidden((prev) => {
                      const next = new Set(prev)
                      if (next.has(item)) next.delete(item)
                      else next.add(item)
                      return next
                    })
                  }
                />
                <span className="cal-check-dot" />
                <span className="cal-check-label">{item}</span>
                <span className="small muted">{todos.filter((todo) => (todo.category ?? '未分类') === item).length}</span>
              </label>
            ))
          )}
        </div>

        <div className="cal-side-block">
          <div className="cal-side-title">我的课表</div>
          <label className="cal-check">
            <input type="checkbox" checked={showCourses} onChange={() => setShowCourses((prev) => !prev)} />
            <span className="cal-check-dot course" />
            <span className="cal-check-label">在日历中显示课程</span>
          </label>

          {courses.length === 0 ? (
            <div className="small muted" style={{ padding: '4px 0 8px' }}>
              还没导入课表
            </div>
          ) : (
            <div className="cal-course-list">
              {courses.map((course) => (
                <div key={course.id} className="cal-course-item">
                  <div className="cal-course-main">
                    <div className="cal-course-name">{course.name}</div>
                    <div className="small muted">
                      {weekdayName(course.weekday)} 第{course.start_slot}-{course.end_slot}节 · {course.start_time}
                    </div>
                    {course.location ? <div className="small muted">{course.location}</div> : null}
                  </div>
                  <button
                    className="btn ghost small danger"
                    onClick={() => setPendingCourse(course.id)}
                    aria-label="删除课程"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}

          <button className="btn small block" style={{ marginTop: 8 }} onClick={() => setImportOpen(true)}>
            {courses.length === 0 ? '导入课表' : '重新导入'}
          </button>
        </div>
      </aside>

      <section className="cal-main">
        <div className="cal-toolbar">
          <button className="btn small" onClick={() => setCursor(today())}>
            今天
          </button>
          <div className="cal-nav">
            <button className="btn ghost small" onClick={() => step(-1)} aria-label="上一页">
              ‹
            </button>
            <button className="btn ghost small" onClick={() => step(1)} aria-label="下一页">
              ›
            </button>
          </div>
          <div className="cal-title">{title}</div>
          <div className="spacer" />
          <button className="btn small primary" onClick={onOpenPlan}>
            一键安排
          </button>
          <div className="cal-views">
            {VIEW_LABELS.map((item) => (
              <button
                key={item.key}
                className={`cal-view-btn${view === item.key ? ' active' : ''}`}
                onClick={() => setView(item.key)}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>

        {emptyHint ? (
          <div className="notice warn cal-empty-hint">
            <div>
              <div className="small">{emptyHint}</div>
              {suggestion && emptyHint ? (
                <div className="small" style={{ marginTop: 2 }}>
                  这个日期是按「本周排课最多」推算的。想要整学期都对得上，用写了开学日期的原文重新导入一次更准。
                </div>
              ) : null}
            </div>
            <div className="row" style={{ gap: 6 }}>
              <input
                className="input"
                type="date"
                style={{ width: 152 }}
                aria-label="第一周的周一"
                value={draftStart || suggestion || courses[0]?.semester_start || ''}
                onChange={(event) => setDraftStart(event.target.value)}
              />
              <button
                className="btn small"
                onClick={() => void handleReschedule(draftStart || suggestion || courses[0].semester_start)}
              >
                按这个日期重排
              </button>
            </div>
          </div>
        ) : null}

        {view === 'month' ? (
          <div className="cal-month">
            <div className="cal-month-head">
              {['周一', '周二', '周三', '周四', '周五', '周六', '周日'].map((item) => (
                <div key={item} className="cal-month-head-cell">
                  {item}
                </div>
              ))}
            </div>
            <div className="cal-month-body">
              {days.map((day) => {
                const events = eventsByDate.get(day) ?? []
                const outside = day.slice(0, 7) !== cursor.slice(0, 7)
                const isToday = day === today()
                return (
                  <div
                    key={day}
                    className={`cal-month-cell${outside ? ' out' : ''}${isToday ? ' today' : ''}`}
                    onClick={() => openCreate(day)}
                  >
                    <div className="cal-month-date">{Number(day.slice(8))}</div>
                    <div className="cal-month-items">
                      {events.slice(0, 3).map((event) => (
                        <button
                          key={event.id}
                          className={`cal-mini-event ${event.kind}${event.done ? ' done' : ''}`}
                          style={
                            event.colorBorder
                              ? { borderLeftColor: event.colorBorder, background: event.colorBg }
                              : undefined
                          }
                          onClick={(clickEvent) => {
                            clickEvent.stopPropagation()
                            openEvent(event)
                          }}
                        >
                          {event.start ? `${event.start} ` : ''}
                          {event.title}
                        </button>
                      ))}
                      {events.length > 3 ? (
                        <div className="small muted">还有 {events.length - 3} 条</div>
                      ) : null}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        ) : (
          <WeekGrid days={days} eventsByDate={eventsByDate} onCreate={openCreate} onOpenEvent={openEvent} />
        )}
      </section>

      <TodoEditor
        open={editorOpen}
        todo={editing}
        initialDate={seed.date}
        initialTime={seed.time}
        categoryOptions={categories}
        busy={saving}
        onSave={(draft) => void handleSave(draft)}
        onDelete={() => {
          if (editing) setPendingDeleteTodo(editing.id)
        }}
        onToggleDone={() => {
          if (!editing) return
          void patchTodo(editing.id, { status: editing.status === 'done' ? 'pending' : 'done' })
            .then(() => setEditorOpen(false))
            .catch((error: unknown) =>
              toast(error instanceof Error ? error.message : '更新失败，请重试。', 'error'),
            )
        }}
        onCancel={() => setEditorOpen(false)}
      />

      <ImportTimetableDialog
        open={importOpen}
        busy={importing}
        onCancel={() => setImportOpen(false)}
        onImport={(rows) => void handleImport(rows)}
      />

      <ConfirmDialog
        open={pendingDeleteTodo !== null}
        title="删除待办"
        description="这条待办会被删除，不可恢复。"
        confirmText="删除"
        danger
        onConfirm={() => void confirmDeleteTodo()}
        onCancel={() => setPendingDeleteTodo(null)}
      />

      <ConfirmDialog
        open={pendingCourse !== null}
        title="删除课程"
        description="这门课会从课表里移除，需要在日历上重新导入才能恢复。"
        confirmText="删除"
        danger
        onConfirm={() => void confirmRemoveCourse()}
        onCancel={() => setPendingCourse(null)}
      />
    </div>
  )
}
