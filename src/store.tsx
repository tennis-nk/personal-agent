import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import * as api from './data/api'
import type { CourseRow, NoteRow, TodoRow } from './data/types'

interface StoreValue {
  notes: NoteRow[]
  todos: TodoRow[]
  courses: CourseRow[]
  loading: boolean
  error: string
  refresh: () => Promise<{ notes: NoteRow[]; todos: TodoRow[]; courses: CourseRow[] }>
  addNote: (input: api.NoteInput) => Promise<NoteRow>
  patchNote: (id: number, patch: api.NotePatch) => Promise<NoteRow>
  removeNote: (id: number) => Promise<void>
  addTodo: (input: api.TodoInput) => Promise<TodoRow>
  patchTodo: (id: number, patch: api.TodoPatch) => Promise<TodoRow>
  removeTodo: (id: number) => Promise<void>
  importCourses: (inputs: api.CourseInput[]) => Promise<CourseRow[]>
  rescheduleCourses: (date: string) => Promise<CourseRow[]>
  removeCourse: (id: number) => Promise<void>
  clearAllCourses: () => Promise<void>
}

const StoreContext = createContext<StoreValue | null>(null)

export function useStore(): StoreValue {
  const ctx = useContext(StoreContext)
  if (!ctx) throw new Error('useStore 必须在 StoreProvider 内部使用')
  return ctx
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [notes, setNotes] = useState<NoteRow[]>([])
  const [todos, setTodos] = useState<TodoRow[]>([])
  const [courses, setCourses] = useState<CourseRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const refresh = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [nextNotes, nextTodos, nextCourses] = await Promise.all([
        api.listNotes(),
        api.listTodos(),
        api.listCourses(),
      ])
      setNotes(nextNotes)
      setTodos(nextTodos)
      setCourses(nextCourses)
      // 返回一份快照：调用方要在刷新后立刻用到新数据，读 state 拿到的是旧值。
      return { notes: nextNotes, todos: nextTodos, courses: nextCourses }
    } catch (err) {
      setError(err instanceof Error ? err.message : '本地数据读取失败。')
      // 读取失败不抛出去，免得每个调用点都要 catch；这条 alerts 会在页面上显示。
      return { notes: [], todos: [], courses: [] }
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const addNote = useCallback(async (input: api.NoteInput) => {
    const created = await api.createNote(input)
    setNotes((prev) => [created, ...prev])
    return created
  }, [])

  const patchNote = useCallback(async (id: number, patch: api.NotePatch) => {
    const updated = await api.updateNote(id, patch)
    setNotes((prev) => prev.map((item) => (item.id === id ? updated : item)))
    return updated
  }, [])

  const removeNote = useCallback(async (id: number) => {
    await api.deleteNote(id)
    setNotes((prev) => prev.filter((item) => item.id !== id))
    setTodos((prev) => prev.filter((item) => item.note_id !== id))
  }, [])

  const addTodo = useCallback(async (input: api.TodoInput) => {
    const created = await api.createTodo(input)
    setTodos((prev) => [created, ...prev])
    return created
  }, [])

  const patchTodo = useCallback(async (id: number, patch: api.TodoPatch) => {
    const updated = await api.updateTodo(id, patch)
    setTodos((prev) => prev.map((item) => (item.id === id ? updated : item)))
    return updated
  }, [])

  const removeTodo = useCallback(async (id: number) => {
    await api.deleteTodo(id)
    setTodos((prev) => prev.filter((item) => item.id !== id))
  }, [])

  const importCourses = useCallback(async (inputs: api.CourseInput[]) => {
    const rows = await api.replaceCourses(inputs)
    setCourses(rows)
    return rows
  }, [])

  const rescheduleCourses = useCallback(async (date: string) => {
    const rows = await api.updateSemesterStart(date)
    setCourses(rows)
    return rows
  }, [])

  const removeCourse = useCallback(async (id: number) => {
    await api.deleteCourse(id)
    setCourses((prev) => prev.filter((item) => item.id !== id))
  }, [])

  const clearAllCourses = useCallback(async () => {
    await api.clearCourses()
    setCourses([])
  }, [])

  const value = useMemo<StoreValue>(
    () => ({
      notes,
      todos,
      courses,
      loading,
      error,
      refresh,
      addNote,
      patchNote,
      removeNote,
      addTodo,
      patchTodo,
      removeTodo,
      importCourses,
      rescheduleCourses,
      removeCourse,
      clearAllCourses,
    }),
    [
      notes,
      todos,
      courses,
      loading,
      error,
      refresh,
      addNote,
      patchNote,
      removeNote,
      addTodo,
      patchTodo,
      removeTodo,
      importCourses,
      rescheduleCourses,
      removeCourse,
      clearAllCourses,
    ],
  )

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>
}
