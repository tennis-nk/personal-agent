import { useEffect, useState } from 'react'
import { listLinks } from '../data/api'
import type { NoteLinkRow, NoteRow, TodoRow } from '../data/types'
import { formatDateTime } from '../utils/date'

interface Props {
  note: NoteRow
  notes: NoteRow[]
  todos: TodoRow[]
  onClose: () => void
  onTogglePin: (note: NoteRow) => void
  onDelete: (note: NoteRow) => void
  onReanalyze: (note: NoteRow) => void
  onChangeCategory: (note: NoteRow) => void
  onOpenNote: (id: number) => void
  onToggleTodo: (todo: TodoRow) => void
}

export function NoteDrawer({
  note,
  notes,
  todos,
  onClose,
  onTogglePin,
  onDelete,
  onReanalyze,
  onChangeCategory,
  onOpenNote,
  onToggleTodo,
}: Props) {
  const [links, setLinks] = useState<NoteLinkRow[]>([])
  const [loadingLinks, setLoadingLinks] = useState(true)

  useEffect(() => {
    let active = true
    setLoadingLinks(true)
    listLinks(note.id)
      .then((rows) => {
        if (active) setLinks(rows)
      })
      .catch(() => {
        if (active) setLinks([])
      })
      .finally(() => {
        if (active) setLoadingLinks(false)
      })
    return () => {
      active = false
    }
  }, [note.id])

  const byId = new Map(notes.map((item) => [item.id, item]))
  const derived = todos.filter((todo) => todo.note_id === note.id)

  return (
    <div className="drawer-mask" onClick={onClose}>
      <div className="drawer" onClick={(event) => event.stopPropagation()}>
        <div className="drawer-head">
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 16, fontWeight: 650, wordBreak: 'break-word' }}>{note.title}</div>
            <div className="row" style={{ marginTop: 4 }}>
              <span className="tag blue">{note.category ?? '未分类'}</span>
              <button className="btn ghost small" onClick={() => onChangeCategory(note)}>
                改分类
              </button>
              {note.source?.path ? (
                <span className="tag gray" title={note.source.hint ?? undefined}>
                  📄 {note.source.path}
                </span>
              ) : null}
              <span className="small muted">更新于 {formatDateTime(note.updated_at)}</span>
            </div>
          </div>
          <button className="btn small" onClick={() => onReanalyze(note)}>
            重新用 AI 处理
          </button>
          <button className="btn small" onClick={() => onTogglePin(note)}>
            {note.pinned ? '取消置顶' : '置顶'}
          </button>
          <button className="btn small danger" onClick={() => onDelete(note)}>
            删除
          </button>
          <button className="btn ghost" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </div>

        <div className="drawer-body">
          {note.summary ? (
            <div>
              <div className="section-title">摘要</div>
              <div>{note.summary}</div>
            </div>
          ) : null}

          {note.key_points && note.key_points.length > 0 ? (
            <div>
              <div className="section-title">重点信息</div>
              <ul className="bullets">
                {note.key_points.map((point, index) => (
                  <li key={index}>{point}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {note.keywords && note.keywords.length > 0 ? (
            <div>
              <div className="section-title">关键词</div>
              <div className="row wrap">
                {note.keywords.map((word, index) => (
                  <span key={index} className="tag blue">
                    {word}
                  </span>
                ))}
              </div>
            </div>
          ) : null}

          <div>
            <div className="section-title">相关内容</div>
            {loadingLinks ? (
              <div className="small muted">正在匹配关联…</div>
            ) : links.length === 0 ? (
              <div className="small muted">暂无关联内容</div>
            ) : (
              links.map((link) => {
                const targetId = link.note_id === note.id ? link.related_note_id : link.note_id
                const target = byId.get(targetId)
                if (!target) return null
                return (
                  <div key={link.id} className="link-card">
                    <button
                      className="btn ghost"
                      style={{ padding: 0, fontWeight: 600, color: 'var(--accent)' }}
                      onClick={() => onOpenNote(targetId)}
                    >
                      {target.title}
                    </button>
                    <div className="small muted">
                      {link.reason ?? '主题相关'}
                      {link.score !== null ? ` · 相关度 ${link.score.toFixed(2)}` : ''}
                    </div>
                  </div>
                )
              })
            )}
          </div>

          {derived.length > 0 ? (
            <div>
              <div className="section-title">由此生成的待办</div>
              <ul className="bullets">
                {derived.map((todo) => (
                  <li key={todo.id}>
                    <span style={todo.status === 'done' ? { textDecoration: 'line-through', color: 'var(--muted)' } : undefined}>
                      {todo.title}
                    </span>{' '}
                    <button className="btn ghost small" onClick={() => onToggleTodo(todo)}>
                      {todo.status === 'done' ? '重新打开' : '标记完成'}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div>
            <div className="section-title">原文</div>
            <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{note.content}</div>
          </div>
        </div>
      </div>
    </div>
  )
}
