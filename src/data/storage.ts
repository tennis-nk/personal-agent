import type { LocalDatabase } from './types'

const STORAGE_KEY = 'infobutler.local.v1'
const SCHEMA_VERSION = 1
export const LOCAL_USER_ID = 'local-user'

function emptyDb(): LocalDatabase {
  return {
    version: SCHEMA_VERSION,
    notes: [],
    todos: [],
    courses: [],
    links: [],
    messages: [],
    reports: [],
    seq: 0,
  }
}

/**
 * 读本地库。
 *
 * localStorage 里的内容可能被手改、被旧版本写坏、也可能根本不存在，
 * 这里一律按「不可信输入」处理：解析失败或字段缺失都退回空库，
 * 而不是抛错让整个应用白屏。
 */
export function readDb(): LocalDatabase {
  let raw: string | null = null
  try {
    raw = window.localStorage.getItem(STORAGE_KEY)
  } catch {
    // 隐私模式下 localStorage 可能直接不可用，此时按空库运行，只是不落盘。
    return emptyDb()
  }
  if (!raw) return emptyDb()

  try {
    const parsed = JSON.parse(raw) as Partial<LocalDatabase>
    return {
      version: SCHEMA_VERSION,
      notes: Array.isArray(parsed.notes) ? parsed.notes : [],
      todos: Array.isArray(parsed.todos) ? parsed.todos : [],
      // courses 是后加的字段，旧库没有，这里补空数组即可，不影响既有数据。
      courses: Array.isArray(parsed.courses) ? parsed.courses : [],
      links: Array.isArray(parsed.links) ? parsed.links : [],
      messages: Array.isArray(parsed.messages) ? parsed.messages : [],
      reports: Array.isArray(parsed.reports) ? parsed.reports : [],
      seq: typeof parsed.seq === 'number' ? parsed.seq : 0,
    }
  } catch {
    console.warn('[信息管家] 本地数据解析失败，已按空库启动。')
    return emptyDb()
  }
}

export function writeDb(db: LocalDatabase): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(db))
  } catch (error) {
    // 写入失败（配额满 / 隐私模式）必须让用户知道，否则会误以为数据存住了。
    console.error('[信息管家] 本地数据保存失败', error)
    throw new Error('本地存储空间不足或被浏览器禁用，这次改动没有保存成功。')
  }
}

export { emptyDb }
