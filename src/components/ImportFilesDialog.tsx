import { useEffect, useMemo, useRef, useState } from 'react'
import {
  dropHandle,
  ensurePermission,
  entriesFromFiles,
  entryToDraft,
  folderLinkHint,
  formatMtime,
  formatSize,
  loadFolders,
  pickDirectory,
  putHandle,
  saveFolders,
  scanDirectory,
  sourceKey,
  supportsFolderLink,
  takeHandle,
  type FileEntry,
  type FileNoteDraft,
  type FolderLink,
} from '../data/files'

interface Props {
  open: boolean
  /** 已经导入过文件的指纹集合（路径|大小），用来标「已导入」。 */
  importedKeys: Set<string>
  busy?: boolean
  /** 页面上的按钮点哪一个进来：folder 直接弹目录选择，file 直接弹文件选择。 */
  initialMode?: 'folder' | 'file' | null
  onCancel: () => void
  onImport: (drafts: FileNoteDraft[], useAI: boolean) => void
}

/**
 * 导入本地文件 / 关联文件夹。
 *
 * 一个弹窗里两件事：
 *   - 关联文件夹：记住用户授权的目录，之后点「重新扫描」就能刷新文件清单；
 *   - 导入文件：直接选文件或临时选一个文件夹，扫出来的清单当场勾选导入。
 * 清单里每条都写明读不读得出正文，避免用户导入一堆空壳资料。
 */
export function ImportFilesDialog({
  open,
  importedKeys,
  busy = false,
  initialMode = null,
  onCancel,
  onImport,
}: Props) {
  const [folders, setFolders] = useState<FolderLink[]>([])
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [scanning, setScanning] = useState('')
  const [note, setNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [onlyNew, setOnlyNew] = useState(true)
  const [useAI, setUseAI] = useState(false)
  const [limitHit, setLimitHit] = useState(false)

  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const dirInputRef = useRef<HTMLInputElement | null>(null)

  // 打开时载入已关联的文件夹。句柄存在 IndexedDB 里，这里只恢复列表。
  useEffect(() => {
    if (!open) return
    setFolders(loadFolders())
    setError(null)
    // 从哪个按钮进来就把对应的选择器直接弹出来，省得再点一次。
    if (initialMode === 'folder') {
      if (supportsFolderLink()) void linkFolder()
      else dirInputRef.current?.click()
    }
    if (initialMode === 'file') fileInputRef.current?.click()
  }, [open, initialMode])

  const visible = useMemo(
    () => (onlyNew ? entries.filter((entry) => !importedKeys.has(sourceKey(entry))) : entries),
    [entries, onlyNew, importedKeys],
  )

  const newCount = useMemo(
    () => entries.filter((entry) => !importedKeys.has(sourceKey(entry))).length,
    [entries, importedKeys],
  )

  const selectedBytes = useMemo(
    () => entries.filter((entry) => selected.has(entry.id)).reduce((sum, entry) => sum + Math.min(entry.size, 12_000), 0),
    [entries, selected],
  )

  function adopt(next: FileEntry[], reachedLimit = false): void {
    setEntries(next)
    setLimitHit(reachedLimit)
    setSelected(new Set(next.filter((entry) => !importedKeys.has(sourceKey(entry))).map((entry) => entry.id)))
    setError(null)
    setNote(
      next.length === 0
        ? '这个文件夹里没有找到可读的文件。'
        : `扫到 ${next.length} 个文件，其中 ${next.filter((item) => !importedKeys.has(sourceKey(item))).length} 个还没导入。`,
    )
  }

  async function runScan(link: FolderLink): Promise<void> {
    setScanning(link.id)
    setError(null)
    try {
      const handle = await takeHandle(link.id)
      if (!handle) {
        setError('这个文件夹的访问授权已经失效（换浏览器或清过站点数据都会这样），请移除后重新关联。')
        return
      }
      const allowed = await ensurePermission(handle)
      if (!allowed) {
        setError('浏览器没有允许访问这个文件夹。重新点一次扫描并在弹出的提示里选「允许」即可。')
        return
      }
      // 授权成功后把句柄存回去：多数浏览器会记住授权，下次打开不用再选一次。
      await putHandle(link.id, handle)
      const result = await scanDirectory(handle, link.name, link.id)
      adopt(result.entries, result.reachedLimit)

      const next = loadFolders().map((item) =>
        item.id === link.id
          ? { ...item, lastScanAt: new Date().toISOString(), fileCount: result.entries.length }
          : item,
      )
      saveFolders(next)
      setFolders(next)
    } catch (err) {
      setError(err instanceof Error ? err.message : '扫描失败，请重试。')
    } finally {
      setScanning('')
    }
  }

  async function linkFolder(): Promise<void> {
    setError(null)
    setNote(null)
    try {
      const handle = await pickDirectory()
      const allowed = await ensurePermission(handle)
      if (!allowed) {
        setError('没有拿到这个文件夹的读取权限，导入已取消。')
        return
      }
      const link: FolderLink = {
        id: `f-${Date.now()}`,
        name: handle.name,
        mode: 'fsa',
        addedAt: new Date().toISOString(),
        lastScanAt: null,
        fileCount: 0,
      }
      await putHandle(link.id, handle)
      const next = [...loadFolders(), link]
      saveFolders(next)
      setFolders(next)
      await runScan(link)
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      setError(err instanceof Error ? err.message : '关联失败，请重试。')
    }
  }

  async function removeFolder(link: FolderLink): Promise<void> {
    const next = loadFolders().filter((item) => item.id !== link.id)
    saveFolders(next)
    setFolders(next)
    await dropHandle(link.id)
    setEntries((prev) => (prev.some((item) => item.folderId === link.id) ? [] : prev))
    setNote(`已解除与「${link.name}」的关联。资料库里已经导入的内容不受影响。`)
  }

  async function readInput(files: FileList | null): Promise<void> {
    if (!files || files.length === 0) return
    setScanning('input')
    setError(null)
    try {
      const list = await entriesFromFiles(Array.from(files))
      adopt(list)
    } catch (err) {
      setError(err instanceof Error ? err.message : '读取失败，请重试。')
    } finally {
      setScanning('')
    }
  }

  function toggle(id: string): void {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleAll(): void {
    setSelected((prev) =>
      prev.size === visible.length && visible.length > 0
        ? new Set()
        : new Set(visible.map((entry) => entry.id)),
    )
  }

  function submit(): void {
    const picked = entries.filter((entry) => selected.has(entry.id))
    if (picked.length === 0) return
    onImport(picked.map((entry) => entryToDraft(entry)), useAI)
  }

  if (!open) return null

  return (
    <div className="modal-mask" onClick={() => (busy || scanning ? undefined : onCancel())}>
      <div className="modal modal-wide" onClick={(event) => event.stopPropagation()}>
        <div className="modal-title">导入本地文件</div>
        <div className="modal-desc">
          关联一个文件夹后可以随时重新扫描，新文件会自动出现在清单里；也可以直接挑几个文件导进来。
          只有你自己选中的目录会被读取，应用不会在后台扫描磁盘。
        </div>

        <div className="modal-body">
          <div className="section-title">已关联的文件夹</div>

          {folders.length === 0 ? (
            <div className="small muted" style={{ padding: '4px 0 8px' }}>
              还没有关联任何文件夹。
            </div>
          ) : (
            <div className="folder-list">
              {folders.map((link) => (
                <div key={link.id} className="folder-row">
                  <div className="folder-main">
                    <div className="folder-name">{link.name}</div>
                    <div className="small muted">
                      {link.fileCount > 0 ? `${link.fileCount} 个文件` : '还没扫描'}
                      {link.lastScanAt ? ` · 上次扫描 ${formatMtime(Date.parse(link.lastScanAt))}` : ''}
                    </div>
                  </div>
                  <button
                    className="btn small"
                    disabled={scanning !== '' || busy}
                    onClick={() => void runScan(link)}
                  >
                    {scanning === link.id ? <span className="spinner" /> : null}
                    重新扫描
                  </button>
                  <button
                    className="btn ghost small danger"
                    disabled={scanning !== '' || busy}
                    onClick={() => void removeFolder(link)}
                  >
                    解除
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="row wrap" style={{ marginTop: 8 }}>
            {supportsFolderLink() ? (
              <button className="btn small primary" disabled={scanning !== '' || busy} onClick={() => void linkFolder()}>
                关联文件夹
              </button>
            ) : (
              <button
                className="btn small primary"
                disabled={scanning !== '' || busy}
                onClick={() => dirInputRef.current?.click()}
              >
                选择文件夹内容
              </button>
            )}
            <button
              className="btn small"
              disabled={scanning !== '' || busy}
              onClick={() => fileInputRef.current?.click()}
            >
              选择文件
            </button>
            {scanning === 'input' ? <span className="small muted">正在读取…</span> : null}
          </div>

          {!supportsFolderLink() ? <div className="notice warn" style={{ marginTop: 8 }}>{folderLinkHint()}</div> : null}

          <div className="section-title" style={{ marginTop: 14 }}>
            文件清单
            {entries.length > 0 ? (
              <span className="small muted" style={{ fontWeight: 400, marginLeft: 6 }}>
                共 {entries.length} 个，{newCount} 个还没导入
              </span>
            ) : null}
          </div>

          {entries.length === 0 ? (
            <div className="empty">先关联文件夹或选择文件，扫出来的内容会列在这里</div>
          ) : (
            <>
              <div className="row wrap" style={{ padding: '4px 0 8px' }}>
                <label className="cal-check">
                  <input type="checkbox" checked={onlyNew} onChange={() => setOnlyNew((prev) => !prev)} />
                  <span className="cal-check-dot" />
                  <span className="cal-check-label">只看没导入过的</span>
                </label>
                <button className="btn ghost small" onClick={toggleAll}>
                  {selected.size === visible.length && visible.length > 0 ? '取消全选' : '全选当前列表'}
                </button>
                <span className="small muted">已选 {selected.size} 个</span>
              </div>

              <div className="file-list">
                {visible.map((entry) => {
                  const already = importedKeys.has(sourceKey(entry))
                  return (
                    <label key={entry.id} className={`file-row${selected.has(entry.id) ? ' on' : ''}`}>
                      <input
                        type="checkbox"
                        checked={selected.has(entry.id)}
                        onChange={() => toggle(entry.id)}
                        disabled={busy}
                      />
                      <div className="file-main">
                        <div className="file-name">
                          {entry.name}
                          {already ? <span className="tag green" style={{ marginLeft: 6 }}>已导入</span> : null}
                          {entry.unsupported ? <span className="tag amber" style={{ marginLeft: 6 }}>无正文</span> : null}
                          {entry.truncated ? <span className="tag" style={{ marginLeft: 6 }}>已截断</span> : null}
                        </div>
                        <div className="file-meta small muted">
                          {entry.path} · {formatSize(entry.size)}
                          {entry.mtime ? ` · ${formatMtime(entry.mtime)}` : ''}
                        </div>
                        {entry.text ? (
                          <div className="file-preview">{entry.text.slice(0, 140)}</div>
                        ) : (
                          <div className="file-preview muted">{entry.unsupported}</div>
                        )}
                      </div>
                    </label>
                  )
                })}
                {visible.length === 0 ? <div className="empty">这些都导入过了，取消上面的勾选可以看全部</div> : null}
              </div>

              {limitHit ? (
                <div className="notice warn" style={{ marginTop: 8 }}>
                  文件太多，只扫了前 800 个。建议关联更具体的子文件夹。
                </div>
              ) : null}
            </>
          )}

          <label className="cal-check" style={{ marginTop: 10 }}>
            <input type="checkbox" checked={useAI} onChange={() => setUseAI((prev) => !prev)} />
            <span className="cal-check-dot" />
            <span className="cal-check-label">导入后交给 AI 分类、摘要、提取重点（最多处理前 20 条，其余只存原文）</span>
          </label>

          {selectedBytes > 2 * 1024 * 1024 ? (
            <div className="notice warn" style={{ marginTop: 8 }}>
              选中的内容约 {formatSize(selectedBytes)}，快到浏览器本地存储上限了。一次少选一些更稳。
            </div>
          ) : null}

          {error ? <div className="notice error" style={{ marginTop: 8 }}>{error}</div> : null}
          {note && !error ? <div className="notice ok" style={{ marginTop: 8 }}>{note}</div> : null}
        </div>

        <div className="modal-actions">
          <button className="btn" disabled={busy || scanning !== ''} onClick={onCancel}>
            关闭
          </button>
          <button
            className="btn primary"
            disabled={busy || scanning !== '' || selected.size === 0}
            onClick={submit}
          >
            {busy ? <span className="spinner" /> : null}
            导入所选（{selected.size}）
          </button>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            void readInput(event.target.files)
            event.target.value = ''
          }}
        />
        <input
          ref={dirInputRef}
          type="file"
          multiple
          hidden
          // 兼容性写法：部分浏览器只认 webkitdirectory，React 不认识的属性要用原生方式给。
          {...{ webkitdirectory: '', directory: '' }}
          onChange={(event) => {
            void readInput(event.target.files)
            event.target.value = ''
          }}
        />
      </div>
    </div>
  )
}
