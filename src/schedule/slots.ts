/**
 * 作息时间表。
 *
 * 课表里写的是「第几节」，日历要画在具体时间上，所以需要一张节次→时间的对照表。
 * 各校差异很大（有的 8 节有的 12 节、午休时间不同），因此存成可编辑的配置，
 * 默认给一份常见的 12 节安排，导入时按当时的表换算，换表不影响已导入的课程。
 */

export interface Slot {
  index: number
  start: string
  end: string
}

const SLOTS_KEY = 'infobutler.slots.v1'

export interface SlotPreset {
  id: string
  name: string
  slots: Slot[]
}

const make = (rows: [string, string][]): Slot[] =>
  rows.map(([start, end], index) => ({ index: index + 1, start, end }))

/**
 * 预设作息。换台电脑、换所学校，点一下就换过来，不用一节一节改。
 * 默认给通用的那份（上午 4 节、下午 4 节、晚上 4 节）；
 * 第二份是晚课 18:30 就开场的学校，留在列表里方便切换。
 */
export const SLOT_PRESETS: SlotPreset[] = [
  {
    id: 'generic',
    name: '通用（8:00 起，12 节）',
    slots: make([
      ['08:00', '08:45'],
      ['08:55', '09:40'],
      ['10:00', '10:45'],
      ['10:55', '11:40'],
      ['14:00', '14:45'],
      ['14:55', '15:40'],
      ['16:00', '16:45'],
      ['16:55', '17:40'],
      ['19:00', '19:45'],
      ['19:55', '20:40'],
      ['20:50', '21:35'],
      ['21:45', '22:30'],
    ]),
  },
  {
    id: 'late-evening',
    name: '晚课 18:30 起（12 节）',
    slots: make([
      ['08:00', '08:45'],
      ['08:55', '09:40'],
      ['10:00', '10:45'],
      ['10:55', '11:40'],
      ['14:00', '14:45'],
      ['14:55', '15:40'],
      ['16:00', '16:45'],
      ['16:55', '17:40'],
      ['18:30', '19:15'],
      ['19:25', '20:10'],
      ['20:20', '21:05'],
      ['21:15', '22:00'],
    ]),
  },
  {
    id: 'short',
    name: '只有白天（8 节）',
    slots: make([
      ['08:00', '08:45'],
      ['08:55', '09:40'],
      ['10:00', '10:45'],
      ['10:55', '11:40'],
      ['14:00', '14:45'],
      ['14:55', '15:40'],
      ['16:00', '16:45'],
      ['16:55', '17:40'],
    ]),
  },
]

export const DEFAULT_SLOTS: Slot[] = SLOT_PRESETS[0].slots.map((slot) => ({ ...slot }))

export function loadSlots(): Slot[] {
  try {
    const raw = window.localStorage.getItem(SLOTS_KEY)
    if (!raw) return DEFAULT_SLOTS.map((slot) => ({ ...slot }))
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed) || parsed.length === 0) return DEFAULT_SLOTS.map((slot) => ({ ...slot }))
    const rows = parsed
      .filter((item): item is Slot => Boolean(item) && typeof item === 'object')
      .map((item, index) => ({
        index: index + 1,
        start: typeof item.start === 'string' && item.start ? item.start : '08:00',
        end: typeof item.end === 'string' && item.end ? item.end : '08:45',
      }))
    return rows.length > 0 ? rows : DEFAULT_SLOTS.map((slot) => ({ ...slot }))
  } catch {
    return DEFAULT_SLOTS.map((slot) => ({ ...slot }))
  }
}

export function saveSlots(slots: Slot[]): void {
  try {
    window.localStorage.setItem(SLOTS_KEY, JSON.stringify(slots))
  } catch (error) {
    console.error('[信息管家] 作息时间保存失败', error)
  }
}

/** 第 startSlot 到 endSlot 节覆盖的时间区间。超范围时夹到表的两端。 */
export function slotRange(slots: Slot[], startSlot: number, endSlot: number): { start: string; end: string } {
  const first = slots[Math.min(Math.max(startSlot, 1), slots.length) - 1] ?? slots[0]
  const last = slots[Math.min(Math.max(endSlot, 1), slots.length) - 1] ?? slots[slots.length - 1]
  return { start: first.start, end: last.end }
}

/** 把作息表按 45 分钟一节的默认长度重排，用户改一节课的时长即可批量生效。 */
export function rebuildSlots(count: number, firstStart: string, lesson: number, breakTime: number): Slot[] {
  const [hour, minute] = firstStart.split(':').map((part) => Number(part) || 0)
  let cursor = hour * 60 + minute
  const rows: Slot[] = []
  for (let index = 1; index <= count; index += 1) {
    const start = cursor
    const end = start + lesson
    rows.push({ index, start: toHm(start), end: toHm(end) })
    cursor = end + breakTime
  }
  return rows
}

function toHm(minutes: number): string {
  const safe = Math.max(0, Math.min(minutes, 23 * 60 + 59))
  return `${`${Math.floor(safe / 60)}`.padStart(2, '0')}:${`${safe % 60}`.padStart(2, '0')}`
}

export function toMinutes(hm: string): number {
  const [hour, minute] = hm.split(':').map((part) => Number(part) || 0)
  return hour * 60 + minute
}

export function fromMinutes(minutes: number): string {
  return toHm(minutes)
}
