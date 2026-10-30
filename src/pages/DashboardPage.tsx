import { useMemo, useState } from 'react'
import { adviseOffline, buildAdviceMessages, isModelReady, streamChat } from '../ai/agent'
import { useStore } from '../store'
import { daysBetween, formatDateTime, shiftDays, today } from '../utils/date'

interface Props {
  onNavigate: (route: string) => void
  /** 打开一键安排。日历页也有同一个入口，两边共用弹窗。 */
  onOpenPlan: () => void
}

export function DashboardPage({ onNavigate, onOpenPlan }: Props) {
  const { notes, todos, loading, error, patchTodo } = useStore()
  const now = today()

  const stats = useMemo(() => {
    const pending = todos.filter((todo) => todo.status === 'pending')
    const weekStart = shiftDays(now, -6)
    const newNotes = notes.filter((note) => note.created_at.slice(0, 10) >= weekStart)
    const doneThisWeek = todos.filter(
      (todo) => todo.completed_at !== null && todo.completed_at.slice(0, 10) >= weekStart,
    )
    const urgent = pending.filter(
      (todo) => todo.priority === 'high' || (todo.due_date !== null && daysBetween(now, todo.due_date) <= 0),
    )
    const categories = new Set(notes.map((note) => note.category ?? '未分类')).size
    return { pending: pending.length, newNotes: newNotes.length, doneThisWeek: doneThisWeek.length, urgent: urgent.length, categories }
  }, [notes, todos, now])

  const urgentTodos = useMemo(
    () =>
      todos
        .filter((todo) => todo.status === 'pending')
        .filter(
          (todo) =>
            todo.priority === 'high' ||
            (todo.due_date !== null && daysBetween(now, todo.due_date) < 0),
        )
        .slice(0, 5),
    [todos, now],
  )

  const recentNotes = useMemo(
    () =>
      [...notes]
        .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))
        .slice(0, 5),
    [notes],
  )

  const [advice, setAdvice] = useState('')
  const [adviceState, setAdviceState] = useState('')
  const ready = isModelReady()

  async function handleAdvice() {
    if (notes.length === 0 && todos.length === 0) {
      setAdvice('先记几条资料或待办，我就能给出下一步建议。')
      return
    }
    setAdviceState('正在分析…')
    setAdvice('')
    try {
      const answer = await streamChat({
        // 资料与待办一起喂：只给资料的话，模型嘴上说「根据资料与待办」，
        // 其实没见过待办，建议和待办清单对不上。
        messages: buildAdviceMessages(notes, todos, now),
        temperature: 0.4,
        // 没接模型时按逾期、优先级、截止日排序给建议，不假装是模型推理。
        offlineFallback: () => adviseOffline(notes, todos),
      })
      setAdvice(answer)
    } catch (err) {
      setAdvice(err instanceof Error ? err.message : '生成建议失败，请重试。')
    } finally {
      setAdviceState('')
    }
  }

  return (
    <>
      <div className="stat-grid">
        <div className="stat">
          <div className="stat-value">{notes.length}</div>
          <div className="stat-label">资料总数</div>
        </div>
        <div className="stat">
          <div className="stat-value">{stats.newNotes}</div>
          <div className="stat-label">近 7 天新增</div>
        </div>
        <div className="stat">
          <div className="stat-value">{stats.pending}</div>
          <div className="stat-label">待处理待办</div>
        </div>
        <div className="stat">
          <div className="stat-value">{stats.urgent}</div>
          <div className="stat-label">紧急 / 已逾期</div>
        </div>
        <div className="stat">
          <div className="stat-value">{stats.categories}</div>
          <div className="stat-label">资料分类数</div>
        </div>
      </div>

      {error ? <div className="notice error">{error}</div> : null}
      {loading && notes.length === 0 ? <div className="notice">正在读取本地数据…</div> : null}

      <div className="card">
        <div className="card-head">
          <div className="card-title">一键安排</div>
          <div className="card-head-right">
            <button className="btn small primary" onClick={onOpenPlan}>
              开始安排
            </button>
          </div>
        </div>
        <div className="card-body">
          <div className="small muted">
            读微信/飞书最近几天的通知（或整段粘贴进来），按你填的身份筛一遍：
            参加的直接进日历，拿不准的挂进待办，别人的事和闲聊不占位置。
            没开本机助手也能用，直接粘贴就行。
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <div className="card-title">优先处理</div>
          <div className="card-head-right">
            <button className="btn small" onClick={() => onNavigate('todos')}>
              查看全部待办
            </button>
          </div>
        </div>
        <div className="card-body tight">
          {urgentTodos.length === 0 ? (
            <div className="empty">没有紧急待办</div>
          ) : (
            <div className="list">
              {urgentTodos.map((todo) => (
                <div key={todo.id} className="list-item">
                  <input
                    type="checkbox"
                    checked={false}
                    onChange={() => void patchTodo(todo.id, { status: 'done' })}
                    aria-label="标记完成"
                  />
                  <div className="list-main">
                    <div className="list-title">{todo.title}</div>
                    <div className="small muted">
                      {todo.due_date ? `${todo.due_date} 截止` : '无截止日期'}
                      {todo.due_date && daysBetween(now, todo.due_date) < 0
                        ? ` · 已逾期 ${-daysBetween(now, todo.due_date)} 天`
                        : ''}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <div className="card-title">AI 行动建议</div>
          <div className="card-head-right">
            <button className="btn small" onClick={() => void handleAdvice()} disabled={adviceState !== ''}>
              {adviceState ? <span className="spinner" /> : null}
              生成
            </button>
          </div>
        </div>
        <div className="card-body">
          {advice ? (
            <div style={{ whiteSpace: 'pre-wrap' }}>{advice}</div>
          ) : (
            <>
              <div className="small muted">
                {ready
                  ? '让 AI 同时看你的资料与未完成待办（逾期的排在最前），给出接下来最该做的三件事。'
                  : '未接入模型，将按逾期、优先级与截止日给出本地排序建议。'}
              </div>
              {ready ? null : (
                <button className="btn small" style={{ marginTop: 10 }} onClick={() => onNavigate('settings')}>
                  去设置接入模型
                </button>
              )}
            </>
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <div className="card-title">最近更新</div>
          <div className="card-head-right">
            <button className="btn small" onClick={() => onNavigate('notes')}>
              进入资料库
            </button>
          </div>
        </div>
        <div className="card-body tight">
          {recentNotes.length === 0 ? (
            <div className="empty">还没有资料</div>
          ) : (
            <div className="list">
              {recentNotes.map((note) => (
                <div
                  key={note.id}
                  className="list-item"
                  style={{ cursor: 'pointer' }}
                  onClick={() => onNavigate('notes')}
                >
                  <div className="list-main">
                    <div className="list-title">{note.title}</div>
                    <div className="list-desc">{note.summary ?? note.content}</div>
                  </div>
                  <span className="small muted">{formatDateTime(note.updated_at)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  )
}
