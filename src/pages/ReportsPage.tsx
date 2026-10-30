import { useEffect, useMemo, useState } from 'react'
import { generateReport } from '../ai/agent'
import { createReport, deleteReport, listReports } from '../data/api'
import type { ReportRow } from '../data/types'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { useStore } from '../store'
import { formatDateTime, shiftDays, today } from '../utils/date'

type Preset = 7 | 30 | 90

function inRange(iso: string, start: string, end: string): boolean {
  const day = iso.slice(0, 10)
  return day >= start && day <= end
}

export function ReportsPage() {
  const { notes, todos } = useStore()
  const [preset, setPreset] = useState<Preset>(30)
  const [start, setStart] = useState(shiftDays(today(), -29))
  const [end, setEnd] = useState(today())
  const [reports, setReports] = useState<ReportRow[]>([])
  const [loading, setLoading] = useState(true)
  const [generating, setGenerating] = useState('')
  const [error, setError] = useState('')
  const [activeId, setActiveId] = useState<number | null>(null)
  const [pendingDelete, setPendingDelete] = useState<number | null>(null)
  const [deleting, setDeleting] = useState(false)

  useEffect(() => {
    let active = true
    listReports()
      .then((rows) => {
        if (active) setReports(rows)
      })
      .catch(() => {
        if (active) setReports([])
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [])

  function applyPreset(next: Preset) {
    setPreset(next)
    setStart(shiftDays(today(), -(next - 1)))
    setEnd(today())
  }

  const scoped = useMemo(() => {
    const scopedNotes = notes.filter((note) => inRange(note.created_at, start, end))
    const scopedTodos = todos.filter(
      (todo) =>
        inRange(todo.created_at, start, end) ||
        (todo.completed_at !== null && inRange(todo.completed_at, start, end)),
    )
    return { scopedNotes, scopedTodos }
  }, [notes, todos, start, end])

  async function handleGenerate() {
    const { scopedNotes, scopedTodos } = scoped
    if (scopedNotes.length === 0 && scopedTodos.length === 0) {
      setError('这个时间段里没有资料也没有待办，换个时间范围试试。')
      return
    }

    setError('')
    setGenerating('正在生成阶段总结…')
    try {
      const result = await generateReport({
        periodStart: start,
        periodEnd: end,
        notes: scopedNotes,
        todos: scopedTodos,
      })
      const created = await createReport({
        periodStart: start,
        periodEnd: end,
        title: result.title,
        summary: result.summary,
        highlights: result.highlights,
        nextActions: result.nextActions,
        stats: {
          资料: scopedNotes.length,
          新增待办: scopedTodos.length,
          已完成: scopedTodos.filter((todo) => todo.status === 'done').length,
        },
      })
      setReports((prev) => [created, ...prev])
      setActiveId(created.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : '生成失败，请重试。')
    } finally {
      setGenerating('')
    }
  }

  async function confirmDelete() {
    if (pendingDelete === null) return
    setDeleting(true)
    try {
      await deleteReport(pendingDelete)
      setReports((prev) => prev.filter((item) => item.id !== pendingDelete))
      if (activeId === pendingDelete) setActiveId(null)
      setPendingDelete(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除失败，请重试。')
    } finally {
      setDeleting(false)
    }
  }

  return (
    <>
      <div className="card">
        <div className="card-head">
          <div className="card-title">生成阶段总结</div>
          <div className="card-head-right">
            <button className={`chip-btn${preset === 7 ? ' active' : ''}`} onClick={() => applyPreset(7)}>
              最近 7 天
            </button>
            <button className={`chip-btn${preset === 30 ? ' active' : ''}`} onClick={() => applyPreset(30)}>
              最近 30 天
            </button>
            <button className={`chip-btn${preset === 90 ? ' active' : ''}`} onClick={() => applyPreset(90)}>
              最近 90 天
            </button>
          </div>
        </div>
        <div className="card-body">
          <div className="row wrap">
            <input
              className="input"
              style={{ width: 170 }}
              type="date"
              value={start}
              onChange={(event) => setStart(event.target.value)}
              aria-label="开始日期"
            />
            <span className="muted">至</span>
            <input
              className="input"
              style={{ width: 170 }}
              type="date"
              value={end}
              onChange={(event) => setEnd(event.target.value)}
              aria-label="结束日期"
            />
            <button
              className="btn primary"
              onClick={() => void handleGenerate()}
              disabled={generating !== '' || start > end}
            >
              {generating ? <span className="spinner" /> : null}
              生成总结与行动建议
            </button>
            {generating ? <span className="small muted">{generating}</span> : null}
          </div>

          <div className="small muted" style={{ marginTop: 10 }}>
            区间内共 {scoped.scopedNotes.length} 条资料、{scoped.scopedTodos.length} 条待办
            {start > end ? ' · 开始日期晚于结束日期' : ''}
          </div>

          {error ? (
            <div className="notice error" style={{ marginTop: 12 }}>
              {error}
            </div>
          ) : null}
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <div className="card-title">历史总结</div>
        </div>
        <div className="card-body tight">
          {loading ? (
            <div className="empty">正在加载…</div>
          ) : reports.length === 0 ? (
            <div className="empty">还没有生成过总结</div>
          ) : (
            <div className="list">
              {reports.map((report) => (
                <div key={report.id} style={{ padding: '12px 0', borderBottom: '1px solid var(--border)' }}>
                  <div className="row">
                    <div style={{ fontWeight: 650, minWidth: 0, flex: 1 }}>
                      {report.title}
                      <span className="small muted" style={{ marginLeft: 8 }}>
                        {report.period_start} ~ {report.period_end}
                      </span>
                    </div>
                    <button
                      className="btn ghost small"
                      onClick={() => setActiveId(activeId === report.id ? null : report.id)}
                    >
                      {activeId === report.id ? '收起' : '查看'}
                    </button>
                    <button
                      className="btn ghost small danger"
                      onClick={() => setPendingDelete(report.id)}
                    >
                      删除
                    </button>
                  </div>

                  {activeId === report.id ? (
                    <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 12 }}>
                      {report.stats ? (
                        <div className="row wrap">
                          {Object.entries(report.stats).map(([key, value]) => (
                            <span key={key} className="tag blue">
                              {key} {value}
                            </span>
                          ))}
                        </div>
                      ) : null}

                      <div>
                        <div className="section-title">总体判断</div>
                        <div>{report.summary}</div>
                      </div>

                      {report.highlights && report.highlights.length > 0 ? (
                        <div>
                          <div className="section-title">重点进展</div>
                          <ul className="bullets">
                            {report.highlights.map((item, index) => (
                              <li key={index}>{item}</li>
                            ))}
                          </ul>
                        </div>
                      ) : null}

                      {report.next_actions && report.next_actions.length > 0 ? (
                        <div>
                          <div className="section-title">后续行动建议</div>
                          <ul className="bullets">
                            {report.next_actions.map((item, index) => (
                              <li key={index}>{item}</li>
                          ))}
                          </ul>
                        </div>
                      ) : null}

                      <div className="small muted">生成于 {formatDateTime(report.created_at)}</div>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={pendingDelete !== null}
        title="删除阶段总结"
        description="这份总结会被删除，不可恢复。你的资料和待办不受影响。"
        confirmText="删除"
        danger
        busy={deleting}
        onConfirm={() => void confirmDelete()}
        onCancel={() => (deleting ? undefined : setPendingDelete(null))}
      />
    </>
  )
}
