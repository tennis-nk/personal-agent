import type { CourseRow, Priority, TodoRow } from '../data/types'
import { daysBetween, shiftDays } from '../utils/date'

/** 一天的日历条目：待办或某节课当周的那一次。 */
export interface DayEvent {
  id: string
  kind: 'todo' | 'course'
  title: string
  subtitle: string
  /** HH:mm */
  start: string
  end: string
  allDay: boolean
  priority?: Priority
  done?: boolean
  todo?: TodoRow
  course?: CourseRow
  /** 课程用固定色板区分，同一门课在周视图和月视图里颜色一致。 */
  colorBorder?: string
  colorBg?: string
}

const COURSE_COLORS = [
  { border: '#2563eb', bg: '#eaf1ff' },
  { border: '#0f9960', bg: '#e6f6ef' },
  { border: '#b7791f', bg: '#fdf4e3' },
  { border: '#7c3aed', bg: '#f2ecfe' },
  { border: '#0e7490', bg: '#e4f4f8' },
  { border: '#c2410c', bg: '#fdeee4' },
]

/** 1 = 周一 … 7 = 周日。 */
export function isoWeekday(dateIso: string): number {
  const date = new Date(`${dateIso}T00:00:00`)
  if (Number.isNaN(date.getTime())) return 1
  const day = date.getDay()
  return day === 0 ? 7 : day
}

/** 该日期是学期第几周（第 1 周为学期起始日所在周）。 */
export function weekIndexOf(semesterStart: string, dateIso: string): number {
  return Math.floor(daysBetween(semesterStart, dateIso) / 7) + 1
}

/** 某一周的周一。 */
export function mondayOf(dateIso: string): string {
  return shiftDays(dateIso, 1 - isoWeekday(dateIso))
}

export function courseOccursOn(course: CourseRow, dateIso: string): boolean {
  if (isoWeekday(dateIso) !== course.weekday) return false
  const index = weekIndexOf(course.semester_start, dateIso)
  return course.weeks.includes(index)
}

export function buildDayEvents(
  dateIso: string,
  todos: TodoRow[],
  courses: CourseRow[],
  visibleCategories: Set<string> | null,
): DayEvent[] {
  const events: DayEvent[] = []

  for (const todo of todos) {
    if (todo.due_date !== dateIso) continue
    const category = todo.category ?? '未分类'
    if (visibleCategories && !visibleCategories.has(category)) continue
    events.push({
      id: `todo-${todo.id}`,
      kind: 'todo',
      title: todo.title,
      subtitle: category,
      start: todo.due_time ?? '',
      end: '',
      allDay: !todo.due_time,
      priority: todo.priority,
      done: todo.status === 'done',
      todo,
    })
  }

  courses.forEach((course, index) => {
    if (!courseOccursOn(course, dateIso)) return
    const palette = COURSE_COLORS[index % COURSE_COLORS.length]
    events.push({
      id: `course-${course.id}-${dateIso}`,
      kind: 'course',
      title: course.name,
      subtitle: [course.location, course.teacher].filter(Boolean).join(' · '),
      start: course.start_time,
      end: course.end_time,
      allDay: false,
      course,
      colorBorder: palette.border,
      colorBg: palette.bg,
    })
  })

  return events.sort((a, b) => {
    if (a.allDay !== b.allDay) return a.allDay ? -1 : 1
    return a.start.localeCompare(b.start, 'zh-Hans-CN')
  })
}

/**
 * 开学日填晚了的补救：把起算日往前挪 k 周，今天就会变成第 index+k 周。
 * 候选里挑「本周排课最多」的那个，并列时取挪得最少的——多数情况下正好是真正的开学日。
 * 不动数据，只给用户一个建议值确认。
 */
export function suggestSemesterStart(courses: CourseRow[], todayIso: string): string | null {
  if (courses.length === 0) return null
  const base = courses[0].semester_start

  let best: string | null = null
  let bestCount = 0
  for (let k = 1; k <= 30; k += 1) {
    const candidate = shiftDays(base, -7 * k)
    const index = weekIndexOf(candidate, todayIso)
    // 同一周里每天算出来的周次相同，所以整周只要算一次 index。
    const count = courses.filter((course) => course.weeks.includes(index)).length
    // 并列时取挪得最多的那个：真正的开学日往往让今天处在学期中后段，
    // 而今天还在第 2、3 周多半是把开学日填晚了。count 掉下来的候选说明学期已经过去了。
    if (count > 0 && count >= bestCount) {
      bestCount = count
      best = candidate
    }
  }
  return bestCount > 0 ? best : null
}

/** 某一天所在的那周里，总共排得到几节课。同一周每天算出的周次相同。 */
export function countWeekCourses(courses: CourseRow[], semesterStart: string, dateIso: string): number {
  const index = weekIndexOf(semesterStart, dateIso)
  return courses.filter((course) => course.weeks.includes(index)).length
}

/** 把「未排具体时间」的待办单独拎出来，铺在当天的全天栏里。 */
export function splitAllDay(events: DayEvent[]): { allDay: DayEvent[]; timed: DayEvent[] } {
  return {
    allDay: events.filter((item) => item.allDay),
    timed: events.filter((item) => !item.allDay),
  }
}

export interface LaidOutEvent extends DayEvent {
  top: number
  height: number
  left: number
  width: number
}

const MINUTES_IN_DAY = 24 * 60

function toMinutes(hm: string): number {
  const [hour, minute] = hm.split(':').map((part) => Number(part) || 0)
  return hour * 60 + minute
}

/**
 * 给时间轴上的事件算位置。
 *
 * 时间重叠的卡片并排放，谁先开始谁靠左；同一组里最多横向分三列，
 * 再多的会挤在一起——一个日历里同刻三件事已经很少见了。
 *
 * dayStart 是时间轴的第一个整点（现在是 7，凌晨那一段不显示）；
 * 早于它的事件会被压到顶端，不至于算出负的 top 跑到格子里看不见。
 */
export function layoutTimed(events: DayEvent[], hourHeight: number, dayStart = 0): LaidOutEvent[] {
  const offset = dayStart * 60
  const timed = events.filter((item) => !item.allDay && item.start)
  const sorted = [...timed].sort((a, b) => toMinutes(a.start) - toMinutes(b.start))

  const placed: { event: DayEvent; start: number; end: number; lane: number }[] = []
  const laneEnds: number[] = []

  for (const event of sorted) {
    const start = Math.max(toMinutes(event.start) - offset, 0)
    const rawEnd = event.end ? toMinutes(event.end) - offset : start + 45
    const end = Math.max(rawEnd, start + 20)
    let lane = laneEnds.findIndex((laneEnd) => laneEnd <= start)
    if (lane === -1) {
      lane = laneEnds.length
      laneEnds.push(end)
    } else {
      laneEnds[lane] = end
    }
    placed.push({ event, start, end, lane })
  }

  return placed.map(({ event, start, end, lane }) => {
    const lanes = Math.max(1, laneEnds.length)
    return {
      ...event,
      top: (start / 60) * hourHeight,
      height: Math.max(((end - start) / 60) * hourHeight, 22),
      left: lane / lanes,
      width: 1 / lanes,
    }
  })
}

/** 当前时间线的位置。落在时间轴显示范围之外就返回 null，画出去反而像条多余的横线。 */
export function nowOffset(hourHeight: number, dayStart = 0, dayEnd = 24): number | null {
  const now = new Date()
  const minutes = now.getHours() * 60 + now.getMinutes()
  if (minutes < dayStart * 60 || minutes >= dayEnd * 60) return null
  return ((minutes - dayStart * 60) / 60) * hourHeight
}

export function clampMinutes(value: number): number {
  return Math.max(0, Math.min(value, MINUTES_IN_DAY - 1))
}
