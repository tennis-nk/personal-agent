import { useEffect, useRef } from 'react'

interface Props {
  open: boolean
  title: string
  description?: string
  confirmText?: string
  cancelText?: string
  danger?: boolean
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}

/**
 * 应用内确认框。
 *
 * 之前用的是 window.confirm，在预览面板这类沙箱 iframe 里会被静默拦掉：
 * 弹窗不出现、直接返回 false，界面上看起来就是「按钮按了没反应」。
 * 这里改成自己画的弹层，行为在任何环境下都一致。
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmText = '确定',
  cancelText = '取消',
  danger = false,
  busy = false,
  onConfirm,
  onCancel,
}: Props) {
  const confirmRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    if (!open) return
    confirmRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel()
      if (event.key === 'Enter') onConfirm()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, onCancel, onConfirm])

  if (!open) return null

  return (
    <div className="modal-mask" onClick={() => (busy ? undefined : onCancel())}>
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-title">{title}</div>
        {description ? <div className="modal-desc">{description}</div> : null}
        <div className="modal-actions">
          <button className="btn" onClick={onCancel} disabled={busy}>
            {cancelText}
          </button>
          <button
            ref={confirmRef}
            className={`btn ${danger ? 'danger-solid' : 'primary'}`}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? <span className="spinner" /> : null}
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  )
}
