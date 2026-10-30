import { useEffect, useRef, useState } from 'react'
import { UNCATEGORIZED } from '../data/categories'

interface Props {
  open: boolean
  current: string
  options: string[]
  derivedTodoCount: number
  busy?: boolean
  onConfirm: (category: string, syncTodos: boolean) => void
  onCancel: () => void
}

/**
 * 修改资料分类。
 *
 * 手动改分类属于「用户显式指定」，优先级高于 AI 的推断结果，
 * 因此改完之后不再自动覆盖：只有用户再点「重新用 AI 处理」才会重写。
 */
export function CategoryPicker({
  open,
  current,
  options,
  derivedTodoCount,
  busy = false,
  onConfirm,
  onCancel,
}: Props) {
  const [custom, setCustom] = useState('')
  const [syncTodos, setSyncTodos] = useState(true)
  const confirmRef = useRef<HTMLButtonElement | null>(null)

  // 每次打开都按当前分类重算状态，避免上一次的残留值被带进来。
  useEffect(() => {
    if (!open) return
    const isPreset = options.includes(current)
    setCustom(isPreset ? '' : current)
    setSyncTodos(true)
    confirmRef.current?.focus()
  }, [open, current, options])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, onCancel])

  if (!open) return null

  const trimmedCustom = custom.trim()
  const selected = trimmedCustom || current

  return (
    <div className="modal-mask" onClick={() => (busy ? undefined : onCancel())}>
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-title">修改分类</div>
        <div className="modal-desc">
          当前分类：{current || UNCATEGORIZED}。选一个预设分类，或直接输入自定义分类。
        </div>

        <div className="row wrap" style={{ marginBottom: 14 }}>
          {options.map((item) => (
            <button
              key={item}
              className={`chip-btn${!trimmedCustom && item === current ? ' active' : ''}`}
              onClick={() => {
                setCustom('')
                onConfirm(item, syncTodos)
              }}
              disabled={busy}
            >
              {item}
            </button>
          ))}
        </div>

        <div className="field">
          <label className="field-label" htmlFor="category-custom">
            自定义分类
          </label>
          <input
            id="category-custom"
            className="input"
            value={custom}
            onChange={(event) => setCustom(event.target.value)}
            placeholder="例如：毕设、装修、副业"
            disabled={busy}
          />
        </div>

        {derivedTodoCount > 0 ? (
          <label className="check-line">
            <input
              type="checkbox"
              checked={syncTodos}
              onChange={(event) => setSyncTodos(event.target.checked)}
              disabled={busy}
            />
            <span className="small">
              同步更新由该资料派生的 {derivedTodoCount} 条待办的分类
            </span>
          </label>
        ) : null}

        <div className="modal-actions">
          <button className="btn" onClick={onCancel} disabled={busy}>
            取消
          </button>
          <button
            ref={confirmRef}
            className="btn primary"
            onClick={() => onConfirm(selected, syncTodos)}
            disabled={busy || !selected}
          >
            {busy ? <span className="spinner" /> : null}
            保存
          </button>
        </div>
      </div>
    </div>
  )
}
