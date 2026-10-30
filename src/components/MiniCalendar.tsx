import { useEffect, useMemo, useState } from 'react'
import { isoWeekday, mondayOf } from '../schedule/occurrence'
import { shiftDays, today } from '../utils/date'

const WEEK_LABELS = ['一', '二', '三', '四', '五', '六', '日']

interface Props {
  cursor: string
  onSelect: (date: string) => void
  /** 每天有多少条日程，用于在日期下点小圆点。 */
  markers: Record<string, number>
}

export function MiniCalendar({ cursor, onSelect, markers }: Props) {
  const [monthCursor, setMonthCursor] = useState(() => cursor.slice(0, 7))

  // 点了外部日期（比如工具栏的「今天」）时，日历跟着翻到对应月份。
  useEffect(() => {
    setMonthCursor(cursor.slice(0, 7))
  }, [cursor])

  const { cells, label } = useMemo(() => {
    const [year, month] = monthCursor.split('-').map((part) => Number(part))
    const first = `${monthCursor}-01`
    const lead = isoWeekday(first) - 1
    const start = shiftDays(first, -lead)

    const rows: string[] = []
    for (let index = 0; index < 42; index += 1) rows.push(shiftDays(start, index))

    return { cells: rows, label: `${year}年${month}月` }
  }, [monthCursor])

  const weekStart = mondayOf(cursor)
  const weekEnd = shiftDays(weekStart, 6)
  const todayIso = today()

  function shiftMonth(delta: number): void {
    const [year, month] = monthCursor.split('-').map((part) => Number(part))
    const next = new Date(year, month - 1 + delta, 1)
    setMonthCursor(`${next.getFullYear()}-${`${next.getMonth() + 1}`.padStart(2, '0')}`)
  }

  return (
    <div className="mini-cal">
      <div className="mini-cal-head">
        <button className="mini-cal-nav" onClick={() => shiftMonth(-1)} aria-label="上个月">
          ‹
        </button>
        <div className="mini-cal-label">{label}</div>
        <button className="mini-cal-nav" onClick={() => shiftMonth(1)} aria-label="下个月">
          ›
        </button>
      </div>

      <div className="mini-cal-week">
        {WEEK_LABELS.map((item) => (
          <div key={item} className="mini-cal-week-cell">
            {item}
          </div>
        ))}
      </div>

      <div className="mini-cal-grid">
        {cells.map((date) => {
          const inMonth = date.slice(0, 7) === monthCursor
          const inWeek = date >= weekStart && date <= weekEnd
          const isToday = date === todayIso
          const isCursor = date === cursor
          const count = markers[date] ?? 0
          return (
            <button
              key={date}
              className={[
                'mini-cal-day',
                inMonth ? '' : 'out',
                inWeek ? 'in-week' : '',
                isToday ? 'today' : '',
                isCursor ? 'active' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              onClick={() => onSelect(date)}
            >
              {Number(date.slice(8))}
              {count > 0 ? <span className="mini-cal-dot" /> : null}
            </button>
          )
        })}
      </div>
    </div>
  )
}
