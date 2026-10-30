import { useEffect, useMemo, useRef, useState } from 'react'
import { defaultSemesterStart, parseSemesterHint, parseTimetable, parseWeeks, weekdayName } from '../schedule/parse'
import { SLOT_PRESETS, loadSlots, saveSlots, slotRange, type Slot } from '../schedule/slots'
import { weekIndexOf } from '../schedule/occurrence'
import { daysBetween, shiftDays, today } from '../utils/date'

const WEEKDAY_OPTIONS = [1, 2, 3, 4, 5, 6, 7]

const SAMPLE = `周一 第1-2节 高等数学 教三-201 张建国 1-16周
周一 第3-4节 大学物理 实验楼A302 1-16周
周二 第1-2节 线性代数 教二-105 王敏 1-8周
周三 第5-6节 程序设计 机房B204 李强 1-16周(单)
周四 第3-4节 大学英语 外语楼302 陈静 1-16周`

export interface ImportRow {
  name: string
  weekday: number
  startSlot: number
  endSlot: number
  startTime: string
  endTime: string
  weeks: number[]
  location: string
  teacher: string
  semesterStart: string
}

interface Props {
  open: boolean
  busy?: boolean
  onCancel: () => void
  onImport: (rows: ImportRow[]) => void
}

interface DraftRow {
  key: string
  name: string
  weekday: number
  startSlot: number
  endSlot: number
  weeksText: string
  location: string
  teacher: string
}

/** 把 [1,2,3,5] 压成 "1-3,5"；单双周单独写成 "1-15单"，比罗列一串数字好读。 */
function compressWeeks(weeks: number[]): string {
  if (weeks.length === 0) return ''
  const sorted = [...weeks].sort((a, b) => a - b)

  const everyOther = sorted.length >= 3 && sorted.every((week, index) => index === 0 || week - sorted[index - 1] === 2)
  if (everyOther) {
    const odd = sorted[0] % 2 === 1
    return `${sorted[0]}-${sorted[sorted.length - 1]}${odd ? '单' : '双'}`
  }

  const parts: string[] = []
  let start = sorted[0]
  let prev = sorted[0]
  for (let index = 1; index <= sorted.length; index += 1) {
    const current = sorted[index]
    if (current !== prev + 1) {
      parts.push(start === prev ? `${start}` : `${start}-${prev}`)
      start = current
    }
    prev = current
  }
  return parts.join(',')
}

/** 开学日填错的话整学期的课都会画到错的日子上，所以把「今天在第几周」直接写出来给人核对。 */
function weekHint(semesterStart: string): string {
  const offset = daysBetween(semesterStart, today())
  if (Number.isNaN(offset)) return ''
  if (offset < 0) return '，今天还没到第 1 周'
  return `，今天是第 ${Math.floor(offset / 7) + 1} 周`
}

export function ImportTimetableDialog({ open, busy = false, onCancel, onImport }: Props) {
  const [text, setText] = useState('')
  const [semesterStart, setSemesterStart] = useState(() => defaultSemesterStart(today()))
  const [totalWeeks, setTotalWeeks] = useState(16)
  const [slots, setSlots] = useState<Slot[]>(() => loadSlots())
  const [drafts, setDrafts] = useState<DraftRow[]>([])
  const [showSlots, setShowSlots] = useState(false)
  /** 用户手动改过开学日之后，就不再用文本里的日期覆盖他的输入。 */
  const [semesterTouched, setSemesterTouched] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const parsed = useMemo(() => parseTimetable(text, totalWeeks), [text, totalWeeks])
  const semesterHint = useMemo(() => parseSemesterHint(text), [text])

  // 周次换算是「相对开学日」算的：开学日填成学期中间的日子，整份课表会平移好几周，
  // 表现出来就是导入成功但日历上一节课都没有。文本里写了日期就直接用它的。
  useEffect(() => {
    if (semesterTouched) return
    if (semesterHint) setSemesterStart(semesterHint)
  }, [semesterHint, semesterTouched])

  const thisWeek = useMemo(() => weekIndexOf(semesterStart, today()), [semesterStart])

  // 开学日填错时最常见的信号：一门课都没排在本周。提交前先在这里拦一下。
  const missedThisWeek = useMemo(() => {
    if (drafts.length === 0) return false
    return !drafts.some((row) => parseWeeks(row.weeksText, totalWeeks).includes(thisWeek))
  }, [drafts, totalWeeks, thisWeek])

  // 只在弹窗打开时归零一次。放进下面那个跟着文本走的 effect 里，
  // 识别结果一改文本就会把刚填的提示和手动改过的开学日一起冲掉。
  useEffect(() => {
    if (!open) return
    setSlots(loadSlots())
    setSemesterTouched(false)
  }, [open])

  useEffect(() => {
    if (!open || semesterTouched) return
    setSemesterStart(semesterHint ?? defaultSemesterStart(today()))
  }, [open, semesterHint, semesterTouched])

  useEffect(() => {
    setDrafts(
      parsed.items.map((item) => ({
        key: item.key,
        name: item.name,
        weekday: item.weekday,
        startSlot: item.startSlot,
        endSlot: item.endSlot,
        weeksText: compressWeeks(item.weeks),
        location: item.location,
        teacher: item.teacher,
      })),
    )
  }, [parsed])

  if (!open) return null

  const updateRow = (key: string, patch: Partial<DraftRow>) => {
    setDrafts((prev) => prev.map((row) => (row.key === key ? { ...row, ...patch } : row)))
  }

  const updateSlot = (index: number, patch: Partial<Slot>) => {
    const next = slots.map((slot, position) => (position === index ? { ...slot, ...patch } : slot))
    setSlots(next)
    saveSlots(next)
  }

  async function handleFile(file: File): Promise<void> {
    const content = await file.text()
    // 开学日统一交给上面的 effect 从文本里读，这里只负责把内容填进文本框。
    setText(content)
  }

  function handleImport(): void {
    const rows = drafts
      .filter((row) => row.name.trim() && row.weekday >= 1 && row.weekday <= 7)
      .map((row) => {
        const startSlot = Math.max(1, Math.min(row.startSlot, slots.length))
        const endSlot = Math.max(1, Math.min(row.endSlot, slots.length))
        const range = slotRange(slots, startSlot, endSlot)
        return {
          name: row.name.trim(),
          weekday: row.weekday,
          startSlot,
          endSlot,
          startTime: range.start,
          endTime: range.end,
          weeks: parseWeeks(row.weeksText, totalWeeks),
          location: row.location.trim(),
          teacher: row.teacher.trim(),
          semesterStart,
        }
      })
    if (rows.length > 0) onImport(rows)
  }

  return (
    <div className="modal-mask" onClick={() => (busy ? undefined : onCancel())}>
      <div className="modal modal-wide" onClick={(event) => event.stopPropagation()}>
        <div className="modal-title">导入课表</div>
        <div className="modal-desc">
          把教务系统的表格整块复制进来，或者按行手写。认不准的行可以在下面直接改，确认无误再导入。
        </div>

        <div className="modal-body">
          <div className="row wrap" style={{ marginBottom: 10 }}>
            <button className="btn small" onClick={() => setText(SAMPLE)}>
              填入示例
            </button>
            <button className="btn small" onClick={() => fileRef.current?.click()}>
              选择文件
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,.txt,text/plain,text/csv"
              style={{ display: 'none' }}
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (file) void handleFile(file)
                event.target.value = ''
              }}
            />
            <button className="btn small" onClick={() => setText('')} disabled={!text}>
              清空
            </button>
            <div className="spacer" />
            <span className="small muted">
              支持「周一 第1-2节 课程 地点 教师 1-16周」，也认 Tab 分隔的表格
            </span>
          </div>

          <textarea
            className="textarea mono"
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="把课表贴在这里。想看格式就点「填入示例」，那会真的填进内容，不是灰字提示。"
          />

          <div className="row wrap" style={{ margin: '12px 0' }}>
            <label className="small muted" htmlFor="semester-start">
              第一周的周一
            </label>
          <input
            id="semester-start"
            className="input"
            style={{ width: 156 }}
            type="date"
            value={semesterStart}
            onChange={(event) => {
              setSemesterTouched(true)
              setSemesterStart(event.target.value)
            }}
          />
            <label className="small muted" htmlFor="total-weeks">
              学期周数
            </label>
            <input
              id="total-weeks"
              className="input"
              style={{ width: 76 }}
              type="number"
              min={1}
              max={30}
              value={totalWeeks}
              onChange={(event) => setTotalWeeks(Math.max(1, Math.min(30, Number(event.target.value) || 16)))}
            />
            <button className="btn ghost small" onClick={() => setShowSlots((prev) => !prev)}>
              {showSlots ? '收起作息时间' : '调整作息时间'}
            </button>
          </div>

          <div className="small muted" style={{ marginTop: -4, marginBottom: 10 }}>
            第 1 周：{semesterStart} ~ {shiftDays(semesterStart, 6)}
            {weekHint(semesterStart)}
          </div>

          {missedThisWeek ? (
            <div className="notice warn" style={{ marginTop: 0, marginBottom: 10 }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>
                今天是第 {thisWeek} 周，可 {drafts.length} 门课里没有一门排在第 {thisWeek} 周
              </div>
              <div className="small">
                一般是「第一周的周一」填成了学期中间的日子，整份课表会往后平移。把它改成真正的开学日再导入。
              </div>
              {semesterHint && semesterHint !== semesterStart ? (
                <button
                  className="btn small"
                  style={{ marginTop: 8 }}
                  onClick={() => {
                    setSemesterTouched(true)
                    setSemesterStart(semesterHint)
                  }}
                >
                  开学日改成 {semesterHint}
                </button>
              ) : null}
            </div>
          ) : null}

          {showSlots ? (
            <div className="slot-editor">
              <div className="small muted" style={{ marginBottom: 8 }}>
                课表只写了「第几节」，日历要画在具体时间上。这里的时间只影响后续导入，已导入的课程不会变。
              </div>
              <div className="row wrap" style={{ marginBottom: 10 }}>
                {SLOT_PRESETS.map((preset) => {
                  const active =
                    preset.slots.length === slots.length &&
                    preset.slots.every((slot, index) => slot.start === slots[index].start && slot.end === slots[index].end)
                  return (
                    <button
                      key={preset.id}
                      className={`btn small${active ? ' primary' : ' ghost'}`}
                      onClick={() => {
                        const next = preset.slots.map((slot) => ({ ...slot }))
                        setSlots(next)
                        saveSlots(next)
                      }}
                    >
                      {preset.name}
                    </button>
                  )
                })}
              </div>
              <div className="slot-grid">
                {slots.map((slot, index) => (
                  <div key={slot.index} className="slot-row">
                    <span className="small muted">第{slot.index}节</span>
                    <input
                      className="input"
                      type="time"
                      value={slot.start}
                      onChange={(event) => updateSlot(index, { start: event.target.value })}
                    />
                    <input
                      className="input"
                      type="time"
                      value={slot.end}
                      onChange={(event) => updateSlot(index, { end: event.target.value })}
                    />
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {text.trim() ? (
            <div style={{ marginTop: 14 }}>
              <div className="section-title">
                识别到 {drafts.length} 门课
                {parsed.failed.length > 0 ? `，${parsed.failed.length} 行没认出来` : ''}
              </div>

              {parsed.items.length > 0 ? (
                <div className="import-table">
                  <div className="import-row import-head">
                    <span>课程</span>
                    <span>星期</span>
                    <span>节次</span>
                    <span>周次</span>
                    <span>地点</span>
                    <span>教师</span>
                    <span />
                  </div>
                  {drafts.map((row) => {
                    const range = slotRange(slots, row.startSlot, row.endSlot)
                    return (
                      <div className="import-row" key={row.key}>
                        <input
                          className="cell-input"
                          value={row.name}
                          onChange={(event) => updateRow(row.key, { name: event.target.value })}
                        />
                        <select
                          className="cell-input"
                          value={row.weekday}
                          onChange={(event) => updateRow(row.key, { weekday: Number(event.target.value) })}
                        >
                          {WEEKDAY_OPTIONS.map((day) => (
                            <option key={day} value={day}>
                              {weekdayName(day)}
                            </option>
                          ))}
                        </select>
                        <span className="cell-pair">
                          <input
                            className="cell-input cell-num"
                            type="number"
                            min={1}
                            value={row.startSlot}
                            onChange={(event) => updateRow(row.key, { startSlot: Number(event.target.value) || 1 })}
                          />
                          <span className="muted">-</span>
                          <input
                            className="cell-input cell-num"
                            type="number"
                            min={1}
                            value={row.endSlot}
                            onChange={(event) => updateRow(row.key, { endSlot: Number(event.target.value) || 1 })}
                          />
                        </span>
                        <span className="cell-stack">
                          <input
                            className="cell-input"
                            value={row.weeksText}
                            onChange={(event) => updateRow(row.key, { weeksText: event.target.value })}
                            placeholder="1-16"
                          />
                          <span className="cell-hint">{range.start}–{range.end}</span>
                        </span>
                        <input
                          className="cell-input"
                          value={row.location}
                          onChange={(event) => updateRow(row.key, { location: event.target.value })}
                        />
                        <input
                          className="cell-input"
                          value={row.teacher}
                          onChange={(event) => updateRow(row.key, { teacher: event.target.value })}
                        />
                        <button
                          className="btn ghost small danger"
                          onClick={() => setDrafts((prev) => prev.filter((item) => item.key !== row.key))}
                          aria-label="移除这一行"
                        >
                          ✕
                        </button>
                      </div>
                    )
                  })}
                </div>
              ) : (
                <div className="notice warn" style={{ marginTop: 8 }}>
                  一行都没认出来。检查一下每行是否同时写了「周几」和「第几节」，例如：
                  周一 第1-2节 高等数学 教三201
                </div>
              )}

              {parsed.failed.length > 0 ? (
                <div className="notice warn" style={{ marginTop: 10 }}>
                  <div style={{ fontWeight: 600, marginBottom: 4 }}>这几行没认出来，已跳过：</div>
                  {parsed.failed.slice(0, 6).map((item, index) => (
                    <div key={index} className="small">
                      {item.reason}：{item.raw}
                    </div>
                  ))}
                  {parsed.failed.length > 6 ? (
                    <div className="small muted">还有 {parsed.failed.length - 6} 行…</div>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}

        </div>

        <div className="modal-actions">
          <button className="btn" onClick={onCancel} disabled={busy}>
            取消
          </button>
          <button className="btn primary" onClick={handleImport} disabled={busy || drafts.length === 0}>
            {busy ? <span className="spinner" /> : null}
            导入 {drafts.length} 门课
          </button>
        </div>
      </div>
    </div>
  )
}
