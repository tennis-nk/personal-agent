import { useEffect, useMemo, useRef, useState } from 'react'
import { isModelReady } from '../ai/agent'
import { planOrganize, type OrganizeItem, type OrganizeKind, type OrganizeResult } from '../ai/organize'
import { PRESETS, loadSettings, notifyLlmChanged, saveSettings } from '../ai/settings'
import type { NoteRow, TodoRow } from '../data/types'
import { today } from '../utils/date'

interface Props {
  open: boolean
  notes: NoteRow[]
  todos: TodoRow[]
  busy?: boolean
  onCancel: () => void
  onApply: (items: OrganizeItem[]) => void
}

const GROUP_TITLES: { kind: OrganizeKind; title: string; hint: string }[] = [
  { kind: 'category', title: '分类调整', hint: '还挂着「未分类 / 文件」这类占位分类的' },
  { kind: 'summary', title: '补一句摘要', hint: '存了内容但还没摘要的' },
  { kind: 'duplicate', title: '重复内容', hint: '同一件事记了两遍，冗余那条归到「待归档」' },
  { kind: 'archive', title: '建议归档', hint: '很久没动过、也没有未完成待办的' },
]

const DEEPSEEK = PRESETS.find((item) => item.id === 'deepseek') ?? PRESETS[0]

/**
 * 智能整理。
 *
 * 打开就跑一遍，跑完列一份建议清单：每条都写清楚「现在是什么、建议改成什么、为什么」，
 * 全勾选也行、只挑几条也行。重复和归档一律只改分类到「待归档」，不删资料——
 * 删错了找不回来，标成待归档还能在分类里翻出来。
 */
export function OrganizeDialog({ open, notes, todos, busy = false, onCancel, onApply }: Props) {
  const [plan, setPlan] = useState<OrganizeResult | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [apiKey, setApiKey] = useState('')
  const abortRef = useRef<AbortController | null>(null)

  const ready = isModelReady()

  useEffect(() => {
    if (!open) return
    setPlan(null)
    setError(null)
    setSelected(new Set())
    void run()
    return () => abortRef.current?.abort()
  }, [open])

  async function run(): Promise<void> {
    const controller = new AbortController()
    abortRef.current = controller
    setRunning(true)
    setError(null)
    try {
      const result = await planOrganize({
        notes,
        todos,
        today: today(),
        signal: controller.signal,
      })
      setPlan(result)
      setSelected(new Set(result.items.map((item) => item.key)))
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      setError(err instanceof Error ? err.message : '整理失败，请重试。')
    } finally {
      setRunning(false)
      abortRef.current = null
    }
  }

  /** 在整理弹窗里直接接入 DeepSeek：填个 Key 就够，地址和模型按官方预设写好。 */
  function connectDeepSeek(): void {
    const key = apiKey.trim()
    if (!key) {
      setError('先把 DeepSeek 的 API Key 粘进来。')
      return
    }
    const current = loadSettings()
    const saved = saveSettings({
      ...current,
      provider: DEEPSEEK.id,
      baseUrl: DEEPSEEK.baseUrl,
      model: DEEPSEEK.model,
      apiKey: key,
    })
    if (!saved) {
      setError('这个页面存不住配置（多半是预览窗口），刷新就没了。把 信息管家.html 到本地用 Edge 打开再填。')
      return
    }
    notifyLlmChanged()
    setApiKey('')
    void run()
  }

  const grouped = useMemo(() => {
    const map = new Map<OrganizeKind, OrganizeItem[]>()
    for (const item of plan?.items ?? []) {
      const list = map.get(item.kind) ?? []
      list.push(item)
      map.set(item.kind, list)
    }
    return map
  }, [plan])

  function toggle(key: string): void {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function toggleGroup(items: OrganizeItem[]): void {
    setSelected((prev) => {
      const next = new Set(prev)
      const allOn = items.every((item) => next.has(item.key))
      for (const item of items) {
        if (allOn) next.delete(item.key)
        else next.add(item.key)
      }
      return next
    })
  }

  function submit(): void {
    const picked = (plan?.items ?? []).filter((item) => selected.has(item.key))
    if (picked.length === 0) return
    onApply(picked)
  }

  if (!open) return null

  return (
    <div className="modal-mask" onClick={() => (busy || running ? undefined : onCancel())}>
      <div className="modal modal-wide" onClick={(event) => event.stopPropagation()}>
        <div className="modal-title">智能整理</div>
        <div className="modal-desc">
          翻一遍资料库，给出可以照做的建议：改分类、补摘要、把重复和过期的归到「待归档」。
          只改分类和摘要，不删任何一条。
        </div>

        <div className="modal-body">
          {!ready ? (
            <div className="organize-connect">
              <div className="small">没接模型，现在只能按本地规则整理。填一个 DeepSeek 的 Key 就能用上模型：</div>
              <div className="row wrap" style={{ marginTop: 6 }}>
                <input
                  className="input"
                  style={{ width: 260 }}
                  placeholder="sk-…"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                />
                <button className="btn small primary" disabled={running} onClick={connectDeepSeek}>
                  接入并重新整理
                </button>
                <button className="btn small" onClick={() => (window.location.hash = '#/settings')}>
                  去设置页慢慢填
                </button>
              </div>
              <div className="small muted" style={{ marginTop: 4 }}>
                接口 {DEEPSEEK.baseUrl} · 模型 {DEEPSEEK.model} · Key 只存在这台机器的浏览器里
              </div>
            </div>
          ) : null}

          {running ? (
            <div className="row" style={{ padding: '18px 0' }}>
              <span className="spinner" />
              <span className="small muted">
                {ready ? '模型正在看资料库…' : '正在按本地规则比对…'}
              </span>
            </div>
          ) : null}

          {error ? <div className="notice error">{error}</div> : null}

          {plan && !running ? (
            <>
              <div className="notice ok">
                {plan.note}
                {plan.items.length === 0 ? ' 现在没什么要动的。' : ` 共 ${plan.items.length} 条建议，默认全选，不需要的取消勾选即可。`}
              </div>

              {plan.items.length === 0 ? (
                <div className="empty">资料库很整齐，没有需要整理的地方</div>
              ) : (
                GROUP_TITLES.map((group) => {
                  const items = grouped.get(group.kind) ?? []
                  if (items.length === 0) return null
                  return (
                    <div key={group.kind} style={{ marginTop: 12 }}>
                      <div className="section-title">
                        {group.title}（{items.length}）
                        <button
                          className="btn ghost small"
                          style={{ marginLeft: 8, fontWeight: 400 }}
                          onClick={() => toggleGroup(items)}
                        >
                          {items.every((item) => selected.has(item.key)) ? '这组都不做' : '这组全做'}
                        </button>
                        <div className="small muted" style={{ fontWeight: 400, marginTop: 2 }}>
                          {group.hint}
                        </div>
                      </div>

                      <div className="organize-list">
                        {items.map((item) => (
                          <label key={item.key} className={`file-row${selected.has(item.key) ? ' on' : ''}`}>
                            <input
                              type="checkbox"
                              checked={selected.has(item.key)}
                              onChange={() => toggle(item.key)}
                              disabled={busy}
                            />
                            <div className="file-main">
                              <div className="file-name">{item.title}</div>
                              <div className="file-meta small muted">
                                {item.kind === 'summary' ? (
                                  <>补摘要：{item.next}</>
                                ) : (
                                  <>
                                    {item.current} → <span className="tag blue">{item.next}</span>
                                  </>
                                )}
                              </div>
                              <div className="small muted" style={{ marginTop: 2 }}>
                                {item.reason}
                                {item.partnerTitle ? `（保留《${item.partnerTitle}》）` : ''}
                              </div>
                            </div>
                          </label>
                        ))}
                      </div>
                    </div>
                  )
                })
              )}
            </>
          ) : null}
        </div>

        <div className="modal-actions">
          <button className="btn" disabled={busy} onClick={onCancel}>
            关闭
          </button>
          <button className="btn" disabled={busy || running || !plan} onClick={() => void run()}>
            重新整理
          </button>
          <button
            className="btn primary"
            disabled={busy || running || selected.size === 0}
            onClick={submit}
          >
            {busy ? <span className="spinner" /> : null}
            应用所选（{selected.size}）
          </button>
        </div>
      </div>
    </div>
  )
}
