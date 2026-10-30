/** 本地时区的 YYYY-MM-DD，避免 toISOString() 在东八区凌晨串日期。 */
export function toDateInput(date: Date): string {
  const year = date.getFullYear()
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function today(): string {
  return toDateInput(new Date())
}

export function formatDateTime(iso: string): string {
  const time = Date.parse(iso)
  if (Number.isNaN(time)) return ''
  const date = new Date(time)
  return `${toDateInput(date)} ${`${date.getHours()}`.padStart(2, '0')}:${`${date.getMinutes()}`.padStart(2, '0')}`
}

export function daysBetween(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00`)
  const end = Date.parse(`${to}T00:00:00`)
  if (Number.isNaN(start) || Number.isNaN(end)) return 0
  return Math.round((end - start) / 86400000)
}

export function shiftDays(from: string, days: number): string {
  const time = Date.parse(`${from}T00:00:00`)
  if (Number.isNaN(time)) return from
  return toDateInput(new Date(time + days * 86400000))
}
