import type { NoteSource } from './types'

/**
 * 本地文件与文件夹的读取层。
 *
 * 浏览器能拿到的只有「用户主动选中的东西」，所以这里分两条路：
 *   1. File System Access API（Edge / Chrome 等）：选中文件夹后可以记住句柄，
 *      下次打开不用重选，点「重新扫描」即可；
 *   2. <input type="file" webkitdirectory>：所有浏览器都支持，但刷新后失效，
 *      只能当场扫一次。
 * 两条路产出的 FileEntry 结构完全一致，界面不需要区分。
 *
 * 正文只取纯文本类文件（含网页去标签、CSV 原文）。
 * docx / xlsx / pdf 这类需要专门解码器的格式不硬啃，只登记文件名与位置，
 * 免得为了读它往单文件产物里塞进一个几 MB 的解压库。
 */

/* ------------------------------- 类型定义 ------------------------------- */

/** 只用到这几个方法，自己声明一套最小接口，不依赖浏览器的 TS 类型库。 */
interface FsFileHandle {
  kind: 'file'
  name: string
  getFile: () => Promise<File>
}

interface FsDirHandle {
  kind: 'directory'
  name: string
  values?: () => AsyncIterableIterator<FsFileHandle | FsDirHandle>
  entries?: () => AsyncIterableIterator<[string, FsFileHandle | FsDirHandle]>
  queryPermission?: (options: { mode: 'read' }) => Promise<PermissionState>
  requestPermission?: (options: { mode: 'read' }) => Promise<PermissionState>
}

export interface FileEntry {
  /** 文件夹内相对路径 + 大小 + 修改时间，用作去重指纹。 */
  id: string
  name: string
  /** 文件夹内的相对路径，含文件名。 */
  relPath: string
  /** 界面展示用的路径：文件夹导入时是「文件夹名/相对路径」。 */
  path: string
  ext: string
  size: number
  mtime: number | null
  /** text 有内容才是可读文本；unsupported 说明为什么没读出来。 */
  text: string
  truncated: boolean
  unsupported: string | null
  folderId: string | null
  folderName: string | null
}

export interface FolderLink {
  id: string
  name: string
  /** fsa = 记住了目录句柄；pick = 一次性选择，刷新页面后失效。 */
  mode: 'fsa' | 'pick'
  addedAt: string
  lastScanAt: string | null
  fileCount: number
}

export interface ScanResult {
  entries: FileEntry[]
  /** 文件数到了上限，后面的没扫：界面上要说明，否则用户以为文件夹就这些文件。 */
  reachedLimit: boolean
}

/** 一条能直接写进资料库的草稿。 */
export interface FileNoteDraft {
  title: string
  content: string
  source: NoteSource
}

/* ------------------------------- 常量 ------------------------------- */

const FOLDER_KEY = 'infobutler.folders.v1'

/** 一次最多扫多少个文件。再多界面会卡住，也没法一次读完。 */
const MAX_FILES = 800
const MAX_DEPTH = 6
/** 单个文件最多读这么多字节；正文更长就截断。 */
const MAX_READ_BYTES = 400 * 1024
/** 存进资料库的正文上限，约 12000 字，够 AI 摘要用。 */
const MAX_KEEP_CHARS = 12_000

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.svn',
  'dist',
  'build',
  'out',
  'target',
  'coverage',
  '.next',
  '.nuxt',
  '.cache',
  '.idea',
  '.vscode',
  '.gradle',
  '__pycache__',
  '.venv',
  'venv',
  'env',
  'site-packages',
  'bin',
  'obj',
  '$recycle.bin',
  'system volume information',
])

const TEXT_EXT = new Set([
  'txt', 'md', 'markdown', 'rst', 'log', 'csv', 'tsv', 'json', 'jsonl', 'yaml', 'yml',
  'ini', 'cfg', 'conf', 'properties', 'xml', 'html', 'htm', 'css', 'scss', 'less',
  'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'vue', 'svelte', 'py', 'java', 'kt', 'go',
  'rs', 'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'rb', 'swift', 'sql', 'sh', 'bash',
  'bat', 'ps1', 'tex', 'r', 'm', 'mm', 'gradle', 'toml', 'plist',
])

/** 能读但得先处理的格式。 */
const HTML_EXT = new Set(['html', 'htm', 'xhtml'])

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function formatMtime(value: number | null): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (n: number) => `${n}`.padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/* --------------------------- 文件夹列表持久化 --------------------------- */

export function loadFolders(): FolderLink[] {
  try {
    const raw = window.localStorage.getItem(FOLDER_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is FolderLink => {
      const row = item as Partial<FolderLink>
      return typeof row?.id === 'string' && typeof row?.name === 'string'
    })
  } catch {
    return []
  }
}

export function saveFolders(list: FolderLink[]): void {
  try {
    window.localStorage.setItem(FOLDER_KEY, JSON.stringify(list))
  } catch {
    // 存不下就算了：文件夹列表只是个快捷方式，丢了重新关联一次即可。
  }
}

/* ------------------------- 目录句柄存 IndexedDB ------------------------- */

const DB_NAME = 'infobutler-files'
const STORE = 'handles'

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const request = indexedDB.open(DB_NAME, 1)
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE)) {
          request.result.createObjectStore(STORE)
        }
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

function idbTx(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest): Promise<unknown> {
  return openDb().then(
    (db) =>
      new Promise<unknown>((resolve) => {
        if (!db) {
          resolve(null)
          return
        }
        try {
          const request = run(db.transaction(STORE, mode).objectStore(STORE))
          request.onsuccess = () => resolve(request.result ?? null)
          request.onerror = () => resolve(null)
        } catch {
          resolve(null)
        }
      }),
  )
}

export async function putHandle(id: string, handle: unknown): Promise<void> {
  await idbTx('readwrite', (store) => store.put(handle, id))
}

export async function takeHandle(id: string): Promise<FsDirHandle | null> {
  const value = await idbTx('readonly', (store) => store.get(id))
  return (value as FsDirHandle | null) ?? null
}

export async function dropHandle(id: string): Promise<void> {
  await idbTx('readwrite', (store) => store.delete(id))
}

/* ---------------------------- 选择目录 / 文件 ---------------------------- */

interface PickerWindow {
  showDirectoryPicker?: (options?: { mode?: 'read' }) => Promise<FsDirHandle>
}

export function supportsFolderLink(): boolean {
  const picker = (window as unknown as PickerWindow).showDirectoryPicker
  return typeof picker === 'function'
}

/** 浏览器不支持记住文件夹时给一句能照做的话，而不是干巴巴的「不支持」。 */
export function folderLinkHint(): string {
  return '这个浏览器不支持记住文件夹（Edge / Chrome 桌面版可以）。可以先点「选择文件夹内容」扫一次，或者直接用「选择文件」。'
}

export async function pickDirectory(): Promise<FsDirHandle> {
  const picker = (window as unknown as PickerWindow).showDirectoryPicker
  if (!picker) throw new Error('浏览器不支持选择文件夹。')
  return picker.call(window, { mode: 'read' })
}

/** 目录权限只在用户手势里能申请，所以这个函数必须从点击事件直接调用。 */
export async function ensurePermission(handle: FsDirHandle): Promise<boolean> {
  if (!handle.queryPermission) return true
  try {
    const options = { mode: 'read' as const }
    const current = await handle.queryPermission(options)
    if (current === 'granted') return true
    if (!handle.requestPermission) return false
    return (await handle.requestPermission(options)) === 'granted'
  } catch {
    return false
  }
}

/* -------------------------------- 扫描 -------------------------------- */

function iteratorOf(dir: FsDirHandle): AsyncIterableIterator<FsFileHandle | FsDirHandle> | null {
  if (typeof dir.values === 'function') return dir.values()
  if (typeof dir.entries === 'function') {
    const source = dir.entries()
    return {
      next: async () => {
        const step = await source.next()
        if (step.done) return { done: true, value: undefined } as IteratorReturnResult<never>
        return { done: false, value: step.value[1] }
      },
      [Symbol.asyncIterator]() {
        return this
      },
    } as AsyncIterableIterator<FsFileHandle | FsDirHandle>
  }
  return null
}

async function walk(
  dir: FsDirHandle,
  prefix: string,
  depth: number,
  out: FileEntry[],
  stats: { stopped: boolean },
  meta: { folderId: string | null; folderName: string | null },
): Promise<void> {
  if (stats.stopped || depth > MAX_DEPTH) return
  const iterator = iteratorOf(dir)
  if (!iterator) return

  for await (const entry of iterator) {
    if (out.length >= MAX_FILES) {
      stats.stopped = true
      return
    }
    if (entry.kind === 'directory') {
      if (SKIP_DIRS.has(entry.name.toLowerCase())) continue
      if (prefix.split('/').length > MAX_DEPTH) continue
      await walk(entry as FsDirHandle, `${prefix}${entry.name}/`, depth + 1, out, stats, meta)
      continue
    }
    if (entry.name.startsWith('.')) continue
    out.push(await toEntry(entry as FsFileHandle, `${prefix}${entry.name}`, meta))
  }
}

async function toEntry(
  handle: FsFileHandle,
  relPath: string,
  meta: { folderId: string | null; folderName: string | null },
): Promise<FileEntry> {
  const file = await handle.getFile()
  const ext = extensionOf(file.name)
  const { text, truncated, unsupported } = await extractText(file, ext)

  return {
    id: `${relPath}|${file.size}|${file.lastModified}`,
    name: file.name,
    relPath,
    path: meta.folderName ? `${meta.folderName}/${relPath}` : relPath,
    ext,
    size: file.size,
    mtime: file.lastModified || null,
    text,
    truncated,
    unsupported,
    folderId: meta.folderId,
    folderName: meta.folderName,
  }
}

export async function scanDirectory(
  handle: FsDirHandle,
  folderName: string,
  folderId: string,
): Promise<ScanResult> {
  const out: FileEntry[] = []
  const stats = { stopped: false }
  await walk(handle, '', 1, out, stats, { folderId, folderName })
  out.sort((a, b) => a.relPath.localeCompare(b.relPath, 'zh-Hans-CN'))
  return { entries: out, reachedLimit: stats.stopped }
}

/**
 * 从 <input type="file"> 拿到的文件构造条目。
 * 选文件夹时浏览器会给 webkitRelativePath（顶层目录名/子路径），据此还原相对路径。
 */
export async function entriesFromFiles(files: File[]): Promise<FileEntry[]> {
  // 用 webkitRelativePath 的第一段当文件夹名，扫描目录时界面上才有「文件夹名/子路径」可显示。
  const folderName = files.find((file) => file.webkitRelativePath)?.webkitRelativePath.split('/')[0] ?? null
  const out: FileEntry[] = []

  for (const file of files.slice(0, MAX_FILES)) {
    const relPath = file.webkitRelativePath ? file.webkitRelativePath.split('/').slice(1).join('/') : file.name
    if (!relPath) continue
    const ext = extensionOf(file.name)
    const { text, truncated, unsupported } = await extractText(file, ext)
    out.push({
      id: `${relPath}|${file.size}|${file.lastModified}`,
      name: file.name,
      relPath,
      path: folderName ? `${folderName}/${relPath}` : relPath,
      ext,
      size: file.size,
      mtime: file.lastModified || null,
      text,
      truncated,
      unsupported,
      folderId: null,
      folderName,
    })
  }

  out.sort((a, b) => a.relPath.localeCompare(b.relPath, 'zh-Hans-CN'))
  return out
}

/* ------------------------------ 正文提取 ------------------------------ */

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

/** 中文用户的 txt 常常是 GBK，按替换字符的比例判断一次，比让用户手动选编码省事。 */
function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(bytes.subarray(3))
  }
  const utf8 = new TextDecoder('utf-8').decode(bytes)
  const bad = (utf8.match(/\uFFFD/g) ?? []).length
  if (bad > 0 && bad / Math.max(1, utf8.length) > 0.005) {
    try {
      return new TextDecoder('gbk').decode(bytes)
    } catch {
      // 浏览器不认 gbk 就退回 utf-8，最差情况是少量乱码。
    }
  }
  return utf8
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|table)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function tidyText(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    // 二进制文件被当成文本读进来时会带 NUL，去掉它才不会污染资料正文。
    .split('\u0000').join('')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

async function extractText(
  file: File,
  ext: string,
): Promise<{ text: string; truncated: boolean; unsupported: string | null }> {
  if (!TEXT_EXT.has(ext)) {
    return { text: '', truncated: false, unsupported: `${ext || '未知'} 格式的正文读不出来，只登记文件名和位置` }
  }
  if (file.size === 0) {
    return { text: '', truncated: false, unsupported: '空文件' }
  }

  const slice = file.size > MAX_READ_BYTES ? file.slice(0, MAX_READ_BYTES) : file
  let raw: string
  try {
    raw = decodeText(new Uint8Array(await slice.arrayBuffer()))
  } catch {
    return { text: '', truncated: false, unsupported: '读取失败，文件可能被占用或没有权限' }
  }

  const body = HTML_EXT.has(ext) ? stripHtml(raw) : tidyText(raw)
  const text = body.length > MAX_KEEP_CHARS ? body.slice(0, MAX_KEEP_CHARS) : body
  return {
    text,
    truncated: file.size > MAX_READ_BYTES || body.length > MAX_KEEP_CHARS,
    unsupported: text.trim().length === 0 ? '没读到文字内容' : null,
  }
}

/* ------------------------------ 转成资料 ------------------------------ */

/** 去重指纹：同一个文件（路径 + 大小）不重复导入，内容变了大小多半也变。 */
export function sourceKey(entry: { path: string; size: number }): string {
  return `${entry.path}|${entry.size}`
}

export function entryToDraft(entry: FileEntry): FileNoteDraft {
  const base = entry.name.replace(/\.[^.]+$/, '')
  const title = base.trim() || entry.name

  const header = [
    `来源：${entry.path}`,
    `${formatSize(entry.size)}${entry.mtime ? ` · 修改于 ${formatMtime(entry.mtime)}` : ''}`,
  ].join(' · ')

  const parts = [header, '']
  if (entry.text) {
    parts.push(entry.text)
  } else {
    parts.push(entry.unsupported ?? '这个文件没有可读取的文本内容。')
  }
  if (entry.truncated) {
    parts.push('', '（正文过长，只保留了前 12000 字）')
  }

  return {
    title: title.length > 80 ? `${title.slice(0, 80)}…` : title,
    content: parts.join('\n'),
    source: {
      kind: entry.folderName ? 'folder' : 'file',
      path: entry.path,
      folder: entry.folderName,
      size: entry.size,
      mtime: entry.mtime,
      hint: entry.unsupported,
    },
  }
}
