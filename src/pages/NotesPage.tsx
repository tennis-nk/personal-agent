import { useEffect, useMemo, useRef, useState } from 'react'
import { analyzeNote, findRelatedNotes } from '../ai/agent'
import type { OrganizeItem } from '../ai/organize'
import { listNotes, replaceLinks } from '../data/api'
import { mergeCategories } from '../data/categories'
import { sourceKey, type FileNoteDraft } from '../data/files'
import type { NoteRow } from '../data/types'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { ImportFilesDialog } from '../components/ImportFilesDialog'
import { ModeHint } from '../components/ModeHint'
import { NoteDrawer } from '../components/NoteDrawer'
import { CategoryPicker } from '../components/CategoryPicker'
import { OrganizeDialog } from '../components/OrganizeDialog'
import { useToast } from '../components/Toast'
import { useStore } from '../store'
import { formatDateTime, today } from '../utils/date'

/** 一次导入最多让 AI 处理多少条。再多条数会让等待时间变得难以忍受。 */
const MAX_AI_PER_IMPORT = 20

/** 来源路径可能很长，列表里只留最后一段文件名。 */
function fileNameOf(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] || path
}

export function NotesPage() {
  const { notes, todos, loading, error, refresh, addNote, patchNote, removeNote, addTodo, patchTodo } =
    useStore()
  const toast = useToast()

  const [keyword, setKeyword] = useState('')
  const [debounced, setDebounced] = useState('')
  const [category, setCategory] = useState('全部')
  const [results, setResults] = useState<NoteRow[] | null>(null)
  const [searching, setSearching] = useState(false)

  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [composerOpen, setComposerOpen] = useState(false)
  const [busy, setBusy] = useState('')

  const [openId, setOpenId] = useState<number | null>(null)
  const [pendingDelete, setPendingDelete] = useState<NoteRow | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [pendingCategory, setPendingCategory] = useState<NoteRow | null>(null)
  const [savingCategory, setSavingCategory] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [importMode, setImportMode] = useState<'folder' | 'file' | null>(null)
  const [importing, setImporting] = useState(false)
  const [organizeOpen, setOrganizeOpen] = useState(false)
  const [organizing, setOrganizing] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  /** 已经导入过的文件指纹，避免同一个文件反复进库。 */
  const importedKeys = useMemo(() => {
    const set = new Set<string>()
    for (const note of notes) {
      if (note.source?.path) set.add(sourceKey(note.source))
    }
    return set
  }, [notes])

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(keyword.trim()), 300)
    return () => window.clearTimeout(timer)
  }, [keyword])

  useEffect(() => {
    if (!debounced) {
      setResults(null)
      return
    }
    let active = true
    setSearching(true)
    listNotes(debounced)
      .then((rows) => {
        if (active) setResults(rows)
      })
      .catch(() => {
        if (active) setResults([])
      })
      .finally(() => {
        if (active) setSearching(false)
      })
    return () => {
      active = false
    }
  }, [debounced])

  const categories = useMemo(
    () => ['全部', ...Array.from(new Set(notes.map((note) => note.category ?? '未分类')))],
    [notes],
  )

  const categoryOptions = useMemo(() => mergeCategories(notes.map((note) => note.category)), [notes])

  const visible = useMemo(() => {
    const source = results ?? notes
    const filtered =
      category === '全部' ? source : source.filter((note) => (note.category ?? '未分类') === category)
    return [...filtered].sort((a, b) => {
      if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1
      return Date.parse(b.updated_at) - Date.parse(a.updated_at)
    })
  }, [results, notes, category])

  /**
   * 一条资料交给 AI：分类 + 摘要 + 关键词 + 重点 + 派生待办 + 关联已有资料。
   * 「保存并处理」和「重新用 AI 处理」共用这一段。
   */
  async function runAI(note: NoteRow, controller: AbortController) {
    const analysis = await analyzeNote({
      title: note.title,
      content: note.content,
      today: today(),
      signal: controller.signal,
    })

    await patchNote(note.id, {
      category: analysis.category,
      summary: analysis.summary,
      keywords: analysis.keywords,
      key_points: analysis.keyPoints,
    })

    for (const item of analysis.todos) {
      await addTodo({
        title: item.title,
        detail: item.detail,
        priority: item.priority,
        due_date: item.dueDate,
        category: analysis.category,
        note_id: note.id,
      })
    }

    setBusy('正在匹配相关内容…')
    const candidates = notes
      .filter((item) => item.id !== note.id)
      .slice(0, 40)
      .map((item) => ({
        id: item.id,
        title: item.title,
        summary: item.summary,
        keywords: item.keywords,
      }))

    if (candidates.length > 0) {
      const related = await findRelatedNotes({
        note: { title: note.title, content: note.content, keywords: analysis.keywords },
        candidates,
        signal: controller.signal,
      })
      await replaceLinks(
        note.id,
        related.map((item) => ({
          related_note_id: item.noteId,
          reason: item.reason,
          score: item.score,
        })),
      )
    }
  }

  async function handleSave(useAI: boolean) {
    const trimmedContent = content.trim()
    if (!trimmedContent) return
    const trimmedTitle = title.trim() || trimmedContent.slice(0, 20)

    const controller = new AbortController()
    abortRef.current = controller
    setBusy('正在保存…')

    try {
      const created = await addNote({ title: trimmedTitle, content: trimmedContent })
      if (useAI) {
        setBusy('正在分类、摘要、提取重点…')
        await runAI(created, controller)
      }
      setTitle('')
      setContent('')
      setComposerOpen(false)
    } catch (err) {
      toast(err instanceof Error ? err.message : '保存失败，请重试。', 'error')
    } finally {
      setBusy('')
      abortRef.current = null
    }
  }

  async function handleReanalyze(note: NoteRow) {
    const controller = new AbortController()
    abortRef.current = controller
    setBusy('正在分类、摘要、提取重点…')
    try {
      await runAI(note, controller)
    } catch (err) {
      toast(err instanceof Error ? err.message : '处理失败，请重试。', 'error')
    } finally {
      setBusy('')
      abortRef.current = null
    }
  }

  async function confirmDelete() {
    if (!pendingDelete) return
    setDeleting(true)
    try {
      await removeNote(pendingDelete.id)
      // 正在检索时列表来自 results 快照，删完要同步去掉，否则条目还留在页面上。
      setResults((prev) => (prev ? prev.filter((item) => item.id !== pendingDelete.id) : null))
      if (openId === pendingDelete.id) setOpenId(null)
      setPendingDelete(null)
    } catch (err) {
      toast(err instanceof Error ? err.message : '删除失败，请重试。', 'error')
    } finally {
      setDeleting(false)
    }
  }

  async function saveCategory(next: string, syncTodos: boolean) {
    if (!pendingCategory) return
    setSavingCategory(true)
    try {
      await patchNote(pendingCategory.id, { category: next })
      if (syncTodos) {
        for (const todo of todos.filter((item) => item.note_id === pendingCategory.id)) {
          await patchTodo(todo.id, { category: next })
        }
      }
      setPendingCategory(null)
      toast(`已把《${pendingCategory.title}》归到「${next}」。`, 'ok')
    } catch (err) {
      toast(err instanceof Error ? err.message : '分类保存失败，请重试。', 'error')
    } finally {
      setSavingCategory(false)
    }
  }

  async function togglePin(note: NoteRow) {
    try {
      await patchNote(note.id, { pinned: !note.pinned })
    } catch (err) {
      toast(err instanceof Error ? err.message : '置顶失败，请重试。', 'error')
    }
  }

  /**
   * 导入文件：按指纹去重，同一条文件第二次导入直接跳过。
   * AI 处理默认是关的——几百个文件逐个问模型既不现实也没必要，
   * 需要时勾上，只对前 20 条生效，其余先存原文，之后在详情里单独处理。
   */
  async function handleImportFiles(drafts: FileNoteDraft[], useAI: boolean) {
    setImporting(true)
    let created = 0
    let skipped = 0
    let aiDone = 0
    let failed = 0
    let quotaBroken = false

    try {
      for (const draft of drafts) {
        const key = sourceKey(draft.source)
        if (importedKeys.has(key)) {
          skipped += 1
          continue
        }
        try {
          const note = await addNote({
            title: draft.title,
            content: draft.content,
            category: '文件',
            source: draft.source,
          })
          importedKeys.add(key)
          created += 1

          if (useAI && aiDone < MAX_AI_PER_IMPORT) {
            const analysis = await analyzeNote({
              title: note.title,
              content: draft.content,
              today: today(),
            })
            await patchNote(note.id, {
              category: analysis.category,
              summary: analysis.summary,
              keywords: analysis.keywords,
              key_points: analysis.keyPoints,
            })
            for (const item of analysis.todos) {
              await addTodo({
                title: item.title,
                detail: item.detail,
                priority: item.priority,
                due_date: item.dueDate,
                category: analysis.category,
                note_id: note.id,
              })
            }
            aiDone += 1
          }
        } catch (err) {
          // 本地存储写满是唯一需要立刻停下的情况，其余的单条失败跳过去即可。
          if (err instanceof Error && err.message.includes('存储空间')) {
            quotaBroken = true
            toast(err.message, 'error')
            break
          }
          failed += 1
        }
      }

      if (!quotaBroken) setImportOpen(false)
      const parts: string[] = []
      if (created > 0) parts.push(`${created} 个文件已进库`)
      if (aiDone > 0) parts.push(`${aiDone} 条已分类摘要`)
      if (skipped > 0) parts.push(`${skipped} 个跳过（已导入过）`)
      if (failed > 0) parts.push(`${failed} 个失败`)
      toast(parts.length > 0 ? `${parts.join('，')}。` : '一个都没导入。', created > 0 ? 'ok' : 'error')
    } finally {
      setImporting(false)
    }
  }

  /**
   * 应用整理建议。
   *
   * 四类建议落到数据上只有两种动作：改分类、改摘要。
   * 重复与归档都只是把分类改成「待归档」，不动原文也不删除。
   */
  async function handleOrganizeApply(items: OrganizeItem[]) {
    setOrganizing(true)
    let done = 0
    let failed = 0
    let quotaBroken = false

    try {
      for (const item of items) {
        try {
          if (item.kind === 'summary') {
            await patchNote(item.noteId, { summary: item.next })
          } else {
            await patchNote(item.noteId, { category: item.next })
          }
          done += 1
        } catch (err) {
          if (err instanceof Error && err.message.includes('存储空间')) {
            quotaBroken = true
            toast(err.message, 'error')
            break
          }
          failed += 1
        }
      }

      if (!quotaBroken) setOrganizeOpen(false)
      const parts: string[] = []
      if (done > 0) parts.push(`${done} 条已改`)
      if (failed > 0) parts.push(`${failed} 条失败`)
      toast(parts.length > 0 ? `${parts.join('，')}。` : '一条都没改。', done > 0 ? 'ok' : 'error')
    } finally {
      setOrganizing(false)
    }
  }

  async function toggleTodo(id: number, status: string) {
    try {
      await patchTodo(id, { status: status === 'done' ? 'pending' : 'done' })
    } catch (err) {
      toast(err instanceof Error ? err.message : '状态更新失败，请重试。', 'error')
    }
  }

  const openNote = notes.find((note) => note.id === openId) ?? null
  const pendingDerivedCount = pendingCategory
    ? todos.filter((todo) => todo.note_id === pendingCategory.id).length
    : 0

  return (
    <>
      <div className="card">
        <div className="card-head">
          <div className="card-title">记录新资料</div>
          <div className="card-head-right">
            <button className="btn small" onClick={() => setComposerOpen((prev) => !prev)}>
              {composerOpen ? '收起' : '展开'}
            </button>
          </div>
        </div>
        <div className="card-body">
          {composerOpen ? (
            <div>
              <div className="field">
                <label className="field-label" htmlFor="note-title">
                  标题（可留空，留空时取正文前 20 字）
                </label>
                <input
                  id="note-title"
                  className="input"
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder="例如：和导师讨论选题"
                />
              </div>
              <div className="field">
                <label className="field-label" htmlFor="note-content">
                  正文
                </label>
                <textarea
                  id="note-content"
                  className="textarea"
                  value={content}
                  onChange={(event) => setContent(event.target.value)}
                  placeholder="把想法、会议记录、链接、待办都写下来，剩下的交给 AI"
                />
              </div>
              <div className="row">
                <button
                  className="btn primary"
                  disabled={!content.trim() || busy !== ''}
                  onClick={() => handleSave(true)}
                >
                  {busy ? <span className="spinner" /> : null}
                  保存并交给 AI 处理
                </button>
                <button className="btn" disabled={!content.trim() || busy !== ''} onClick={() => handleSave(false)}>
                  只保存
                </button>
                {busy ? <span className="small muted">{busy}</span> : null}
              </div>
              <ModeHint text="离线模式下，分类、摘要、重点和待办由本地规则引擎生成；接入模型后同一入口自动切换为大模型处理。" />
            </div>
          ) : (
            <button
              className="btn primary block"
              onClick={() => setComposerOpen(true)}
              style={{ justifyContent: 'center' }}
            >
              记下点什么
            </button>
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <div className="card-title">资料库</div>
          <div className="card-head-right">
            <button className="btn small primary" onClick={() => setOrganizeOpen(true)}>
              智能整理
            </button>
            <button
              className="btn small"
              onClick={() => {
                setImportMode('folder')
                setImportOpen(true)
              }}
            >
              关联文件夹
            </button>
            <button
              className="btn small"
              onClick={() => {
                setImportMode('file')
                setImportOpen(true)
              }}
            >
              导入文件
            </button>
            <input
              className="input"
              style={{ width: 180 }}
              placeholder="关键词检索"
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
            />
            <button className="btn small" onClick={() => void refresh()} disabled={loading}>
              {loading ? <span className="spinner" /> : null}
              刷新
            </button>
          </div>
        </div>
        <div className="card-body tight">
          <div className="row wrap" style={{ padding: '8px 0 12px' }}>
            {categories.map((item) => (
              <button
                key={item}
                className={`chip-btn${category === item ? ' active' : ''}`}
                onClick={() => setCategory(item)}
              >
                {item}
              </button>
            ))}
          </div>

          {error ? <div className="notice error">{error}</div> : null}

          {searching ? (
            <div className="empty">正在检索…</div>
          ) : visible.length === 0 ? (
            <div className="empty">{debounced ? '没有匹配的资料' : '还没有任何资料，先在上面记一条'}</div>
          ) : (
            <div className="list">
              {visible.map((note) => (
                <div
                  key={note.id}
                  className="list-item"
                  style={{ cursor: 'pointer' }}
                  onClick={() => setOpenId(note.id)}
                >
                  <div className="list-main">
                    <div className="list-title">
                      {note.pinned ? '📌 ' : ''}
                      {note.title}
                    </div>
                    <div className="list-desc">{note.summary ?? note.content}</div>
                    <div className="row wrap" style={{ marginTop: 6 }}>
                      <span className="tag blue">{note.category ?? '未分类'}</span>
                      {(note.keywords ?? []).slice(0, 4).map((word, index) => (
                        <span key={index} className="tag">
                          {word}
                        </span>
                      ))}
                      {note.source?.path ? (
                        <span className="tag gray" title={note.source.path}>
                          📄 {fileNameOf(note.source.path)}
                        </span>
                      ) : null}
                      <span className="small muted">{formatDateTime(note.created_at)}</span>
                    </div>
                  </div>

                  <div className="item-actions">
                    <button
                      className="btn ghost small"
                      onClick={(event) => {
                        event.stopPropagation()
                        setPendingCategory(note)
                      }}
                    >
                      改分类
                    </button>
                    <button
                      className="btn ghost small danger"
                      onClick={(event) => {
                        event.stopPropagation()
                        setPendingDelete(note)
                      }}
                    >
                      删除
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {openNote ? (
        <NoteDrawer
          note={openNote}
          notes={notes}
          todos={todos}
          onClose={() => setOpenId(null)}
          onReanalyze={(note) => void handleReanalyze(note)}
          onTogglePin={(note) => void togglePin(note)}
          onChangeCategory={(note) => setPendingCategory(note)}
          onDelete={(note) => setPendingDelete(note)}
          onOpenNote={(id) => setOpenId(id)}
          onToggleTodo={(todo) => void toggleTodo(todo.id, todo.status)}
        />
      ) : null}

      <ConfirmDialog
        open={pendingDelete !== null}
        title="删除资料"
        description={
          pendingDelete
            ? `《${pendingDelete.title}》将被删除，由它派生的待办和它参与的关联关系也会一并清掉，这一步不可撤销。`
            : undefined
        }
        confirmText="删除"
        danger
        busy={deleting}
        onConfirm={() => void confirmDelete()}
        onCancel={() => (deleting ? undefined : setPendingDelete(null))}
      />

      <OrganizeDialog
        open={organizeOpen}
        notes={notes}
        todos={todos}
        busy={organizing}
        onCancel={() => setOrganizeOpen(false)}
        onApply={(items) => void handleOrganizeApply(items)}
      />

      <ImportFilesDialog
        open={importOpen}
        importedKeys={importedKeys}
        busy={importing}
        initialMode={importMode}
        onCancel={() => {
          setImportOpen(false)
          setImportMode(null)
        }}
        onImport={(drafts, useAI) => void handleImportFiles(drafts, useAI)}
      />

      <CategoryPicker
        open={pendingCategory !== null}
        current={pendingCategory?.category?.trim() || '未分类'}
        options={categoryOptions}
        derivedTodoCount={pendingDerivedCount}
        busy={savingCategory}
        onConfirm={(next, sync) => void saveCategory(next, sync)}
        onCancel={() => (savingCategory ? undefined : setPendingCategory(null))}
      />
    </>
  )
}
