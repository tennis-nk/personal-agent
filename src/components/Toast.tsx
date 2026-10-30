import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'

type ToastKind = 'info' | 'error' | 'ok'

interface ToastItem {
  id: number
  text: string
  kind: ToastKind
}

type Push = (text: string, kind?: ToastKind) => void

const ToastContext = createContext<Push | null>(null)

export function useToast(): Push {
  const push = useContext(ToastContext)
  if (!push) throw new Error('useToast 必须在 ToastProvider 内部使用')
  return push
}

/**
 * 轻量提示条。
 *
 * 用来替代 window.alert——后者在沙箱 iframe 里同样会被静默拦掉，
 * 结果是操作失败了但界面上什么都不显示。
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([])
  const seq = useRef(0)
  const timers = useRef<number[]>([])

  const push = useCallback<Push>((text, kind = 'info') => {
    seq.current += 1
    const id = seq.current
    // 同一条消息连续触发时只保留一条，避免刷屏。
    setItems((prev) => [...prev.filter((item) => item.text !== text), { id, text, kind }])
    const timer = window.setTimeout(
      () => setItems((prev) => prev.filter((item) => item.id !== id)),
      kind === 'error' ? 5200 : 2800,
    )
    timers.current.push(timer)
  }, [])

  useEffect(() => {
    const pending = timers.current
    return () => {
      pending.forEach((timer) => window.clearTimeout(timer))
    }
  }, [])

  const value = useMemo<Push>(() => push, [push])

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-host">
        {items.map((item) => (
          <div key={item.id} className={`toast ${item.kind}`}>
            {item.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}
