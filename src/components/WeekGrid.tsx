import { useRef, useState } from 'react'
import {
  isoWeekday,
  layoutTimed,
  nowOffset,
  splitAllDay,
  type DayEvent,
} from '../schedule/occurrence'
import { today } from '../utils/date'

const HOUR_HEIGHT = 56
// 凌晨到早上基本没课，留着只会占掉一屏的高度。时间轴从 7 点画到午夜。
const DAY_START = 7
const DAY_END = 24
const HOURS = Array.from({ length: DAY_END - DAY_START }, (_, index) => DAY_START + index)
const WEEK_LABELS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']

// 全天栏按条目数长高：一条 21px，默认最多占 2 行，点「+N」放到 8 行。
// 行数给得克制，是因为它每长一行，下面的时间轴就少一行——
// 而日程才是这个页面的主体。再多就交给格子内部滚动。
const ALLDAY_ROW = 21
const ALLDAY_MIN = 30
const ALLDAY_ROWS = 2
const ALLDAY_ROWS_OPEN = 8
/** 全天栏最多吃掉视口这么高的比例，剩下的留给时间轴。 */
const ALLDAY_MAX_VH = 24

interface Props {
  days: string[]
  eventsByDate: Map<string, DayEvent[]>
  onCreate: (date: string, hour: number) => void
  onOpenEvent: (event: DayEvent) => void
}

export function WeekGrid({ days, eventsByDate, onCreate, onOpenEvent }: Props) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const todayIso = today()
  const [allDayOpen, setAllDayOpen] = useState(false)

  const columns = `56px repeat(${days.length}, minmax(0, 1fr))`

  // 取一周里全天任务最多的那天定高，这样七列的格子一样高，不会参差不齐。
  const maxAllDay = Math.max(
    0,
    ...days.map((day) => splitAllDay(eventsByDate.get(day) ?? []).allDay.length),
  )
  const rows = allDayOpen ? ALLDAY_ROWS_OPEN : ALLDAY_ROWS
  const allDayHeight = Math.max(ALLDAY_MIN, Math.min(maxAllDay, rows) * ALLDAY_ROW + 8)
  // 高度封顶：按行数算出来是多少就算多少，但不能超过视口的 24%，
  // 否则全天任务一多，下面的时间轴就只剩一条缝了。
  const allDayMax = `min(${allDayHeight}px, ${ALLDAY_MAX_VH}vh)`

  return (
    <div className="cal-grid" ref={scrollRef}>
      {/*
        表头和全天栏跟时间轴放在同一个滚动容器里，一起吸顶。
        之前时间轴单独滚动，那条滚动条只出现在下半部分，
        于是下面的七列比上面的七列窄了一条滚动条的宽度，看着就是整列错位。
      */}
      <div className="cal-grid-fixed">
        <div className="cal-grid-head" style={{ gridTemplateColumns: columns }}>
        <div className="cal-gutter-head">GMT+8</div>
        {days.map((day) => {
          const isToday = day === todayIso
          return (
            <div key={day} className={`cal-day-head${isToday ? ' today' : ''}`}>
              <div className="cal-day-name">{WEEK_LABELS[isoWeekday(day) - 1]}</div>
              <div className="cal-day-num">{Number(day.slice(8))}</div>
            </div>
          )
        })}
      </div>

        <div className="cal-grid-allday" style={{ gridTemplateColumns: columns }}>
            <div className="cal-allday-label">
              <span>全天</span>
              {maxAllDay > ALLDAY_ROWS || allDayOpen ? (
                <button
                  className="cal-allday-toggle"
                  onClick={() => setAllDayOpen((prev) => !prev)}
                  title={allDayOpen ? '收起全天栏' : '展开全天栏'}
                >
                  {allDayOpen ? '收起' : `+${Math.max(1, maxAllDay - ALLDAY_ROWS)}`}
                </button>
              ) : null}
            </div>
            {days.map((day) => {
              const { allDay } = splitAllDay(eventsByDate.get(day) ?? [])
              return (
                <div
                  key={day}
                  className={`cal-allday-cell${allDayOpen ? ' open' : ''}`}
                  style={{ height: allDayHeight, maxHeight: allDayMax }}
                >
                  {allDay.map((event) => (
                    <button
                      key={event.id}
                      className={`cal-chip ${event.kind}${event.done ? ' done' : ''}`}
                      onClick={() => onOpenEvent(event)}
                      title={event.title}
                    >
                      {event.title}
                    </button>
                  ))}
                </div>
              )
            })}
          </div>
      </div>

      <div className="cal-grid-body" style={{ gridTemplateColumns: columns }}>
          <div className="cal-gutter">
            {HOURS.map((hour) => (
              <div key={hour} className="cal-hour" style={{ height: HOUR_HEIGHT }}>
                <span>{`${`${hour}`.padStart(2, '0')}:00`}</span>
              </div>
            ))}
          </div>

          {days.map((day) => {
            const events = eventsByDate.get(day) ?? []
            const laidOut = layoutTimed(events, HOUR_HEIGHT, DAY_START)
            const isToday = day === todayIso
            const nowTop = isToday ? nowOffset(HOUR_HEIGHT, DAY_START, DAY_END) : null
            return (
              <div key={day} className="cal-col">
                {HOURS.map((hour) => (
                  <div
                    key={hour}
                    className="cal-slot"
                    style={{ height: HOUR_HEIGHT }}
                    onClick={() => onCreate(day, hour)}
                  />
                ))}

                {laidOut.map((event) => (
                  <button
                    key={event.id}
                    className={`cal-event ${event.kind}${event.done ? ' done' : ''}${
                      event.priority ? ` p-${event.priority}` : ''
                    }`}
                    style={{
                      top: event.top,
                      height: event.height,
                      left: `calc(${event.left * 100}% + 2px)`,
                      width: `calc(${event.width * 100}% - 6px)`,
                      borderLeftColor: event.colorBorder,
                      background: event.colorBg,
                    }}
                    onClick={(clickEvent) => {
                      clickEvent.stopPropagation()
                      onOpenEvent(event)
                    }}
                    title={`${event.start}${event.end ? `-${event.end}` : ''} ${event.title}`}
                  >
                    <span className="cal-event-time">{event.start}</span>
                    <span className="cal-event-title">{event.title}</span>
                    {event.subtitle ? <span className="cal-event-sub">{event.subtitle}</span> : null}
                  </button>
                ))}

                {nowTop !== null ? (
                  <div className="cal-now" style={{ top: nowTop }}>
                    <span className="cal-now-dot" />
                  </div>
                ) : null}
              </div>
            )
          })}
      </div>
    </div>
  )
}
