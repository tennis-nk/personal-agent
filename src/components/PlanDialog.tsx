import { useEffect, useMemo, useRef, useState } from 'react'
import type { TodoInput } from '../data/api'
import type { CourseRow } from '../data/types'
import {
  activateApp,
  clampDays,
  fetchFeishuStatus,
  fetchTodayReport,
  loadBridge,
  loadProfile,
  loadRemoteBridge,
  openFeishuAuth,
  recordSpeakers,
  saveBridge,
  startFeishuLogin,
  type BridgeConfig,
} from '../data/profile'
import {
  parseNotices,
  splitRawText,
  sortNotices,
  type NoticeItem,
  type NoticeMessage,
  type Profile,
} from '../schedule/notice'
import { today } from '../utils/date'

/** 每条解析结果最后落到什么位置。 */
export type Decision = 'go' | 'later' | 'skip'

export interface PlanPayload {
  item: NoticeItem
  decision: Decision
  todo: TodoInput
}

interface Props {
  open: boolean
  courses: CourseRow[]
  onClose: () => void
  onApply: (payloads: PlanPayload[], source: string) => void | Promise<void>
}

type Stage = 'input' | 'review' | 'confirm'

const SAMPLE = [
  '【2026级自动化1班群】班长 09:12：明天下午2点在行政楼A305开班会，全体同学务必参加，收到请回复。',
  '【年级通知群】辅导员 10:05：本周五晚上7点，大礼堂有职业规划讲座，自愿报名，名额有限，有意者在群里接龙。',
  '【社团群】社长 11:30：本周六上午9点-11点，体育馆集合，社团团建，自愿参加。',
  '【2026级自动化2班群】班长 14:20：2班同学下午4点到机房做实验。',
  '【教务通知】教务处 15:00：奖学金申请材料请于11月5日前交到学院办公室。',
].join('\n')

function decisionLabel(decision: Decision): string {
  if (decision === 'go') return '参加'
  if (decision === 'later') return '待定'
  return '不去'
}

/** 没手动选过时用哪个：别人的事和已经过去的默认「不去」，拿不准的默认「待定」。 */
function defaultDecision(item: NoticeItem): Decision {
  if (item.expired) return 'skip'
  if (item.relevance === 'other') return 'skip'
  return item.needConfirm ? 'later' : 'go'
}

/** 渠道标签：微信绿、飞书蓝，粘贴进来的不打标签（只有群名）。 */
function channelTag(channel: string): { text: string; className: string } | null {
  if (channel === '微信') return { text: '微信', className: 'tag green' }
  if (channel === '飞书') return { text: '飞书', className: 'tag blue' }
  return null
}

function buildTodo(item: NoticeItem, decision: Decision): TodoInput {
  const lines = [
    `来源：${[item.channel, item.source].filter(Boolean).join(' · ')}${item.sender ? ` · ${item.sender}` : ''}`,
    item.location ? `地点：${item.location}` : null,
    item.deadline ? `报名/提交截止：${item.deadline}` : null,
    `原文：${item.raw}`,
  ].filter((line): line is string => Boolean(line))

  if (decision === 'later') {
    return {
      title: `[待定] ${item.title}`,
      detail: lines.join('\n'),
      priority: 'low',
      category: '待确认',
      due_date: null,
      due_time: null,
    }
  }

  return {
    title: item.title,
    detail: lines.join('\n'),
    priority: item.date ? 'high' : 'medium',
    category: '通知',
    due_date: item.date,
    due_time: item.time,
  }
}

/**
 * 一键安排。
 *
 * 三步：拿到当天通知 → 预览解析结果 → 拿不准的逐个问。
 * 本机助手没开也能用，直接把聊天记录粘进来即可。
 */
export function PlanDialog({ open, courses, onClose, onApply }: Props) {
  const [stage, setStage] = useState<Stage>('input')
  const [text, setText] = useState('')
  const [source, setSource] = useState('手动粘贴')
  const [items, setItems] = useState<NoticeItem[]>([])
  const [decisions, setDecisions] = useState<Record<string, Decision>>({})
  const [queue, setQueue] = useState<string[]>([])
  const [cursor, setCursor] = useState(0)
  const [fetching, setFetching] = useState(false)
  const [note, setNote] = useState<{ text: string; kind: 'ok' | 'error' | 'info' } | null>(null)
  const [profile] = useState<Profile>(() => loadProfile())
  const [bridge, setBridge] = useState<BridgeConfig>(() => loadBridge())
  /** 往回取几天。改一次就存进设置，下次打开还是这个范围。 */
  const [days, setDays] = useState(() => clampDays(loadBridge().days))
  /**
   * 预览里是否藏掉已经过去的事。
   *
   * 默认藏起来：往回取 3~7 天时，大部分条目早就结束了，留着只会把还没做的压在下面。
   * 想补记的时候把这个勾去掉，过期条目照常可选。
   */
  const [hideExpired, setHideExpired] = useState(true)
  /**
   * 是否显示「别人的事」。
   *
   * 默认不显示：身份填了班级/年级/职务之后，通知里点别的班、别的年级的，
   * 一条都不该占屏幕。想核对判断对不对再打开。
   */
  const [showOther, setShowOther] = useState(false)
  /** 与身份无关、又没认岀时间的闲聊，解析时就被丢掉了，这里只记条数。 */
  const [skipped, setSkipped] = useState(0)
  /** 本机助手带回来的抱怨：微信没读成、剪贴板是空的、飞书没授权。 */
  const [warnings, setWarnings] = useState<string[]>([])
  /**
   * 飞书授权提醒。null 表示不用管（没开直读、或授权还新鲜）。
   * 只有「直读群消息」这条路径依赖授权，剪贴板模式不用登录。
   */
  const [feishuAuth, setFeishuAuth] = useState<{ message: string; url: string; busy: boolean } | null>(null)
  const feishuPoll = useRef<number | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  function stopFeishuPoll(): void {
    if (feishuPoll.current !== null) {
      window.clearInterval(feishuPoll.current)
      feishuPoll.current = null
    }
  }

  /** 开弹窗时先看一眼飞书授权还在不在，掉了对着空列表点读取是浪费时间。 */
  async function checkFeishuAuth(): Promise<void> {
    if (!bridge.enabled) {
      setFeishuAuth(null)
      return
    }
    try {
      const remote = await loadRemoteBridge(bridge)
      const section = remote?.feishu
      if (!section?.enabled || section.mode !== 'sdk') {
        setFeishuAuth(null)
        return
      }
      const status = await fetchFeishuStatus(bridge)
      if (!status.ok || !status.app_ready) {
        setFeishuAuth(null)
        return
      }
      if (!status.logged_in) {
        setFeishuAuth({ message: '飞书授权掉了，直读群消息读不到飞书内容。重新授权一次就好。', url: '', busy: false })
        return
      }
      // 没有 refresh token 的授权过期即失效，快到点的时候先提醒，别等到读不出来才发现。
      if (!status.has_refresh && status.expires_in <= 1800) {
        const minutes = Math.max(1, Math.round(status.expires_in / 60))
        setFeishuAuth({
          message: `飞书授权还剩约 ${minutes} 分钟，而且不能自动续期。现在重新授权一次，省得读到一半断掉。`,
          url: '',
          busy: false,
        })
        return
      }
      setFeishuAuth(null)
    } catch {
      // 助手没开或刚好重启，下次再问。
      setFeishuAuth(null)
    }
  }

  async function handleFeishuLogin(): Promise<void> {
    setFeishuAuth((prev) => (prev ? { ...prev, busy: true } : prev))
    try {
      const result = await startFeishuLogin(bridge)
      if (!result.ok || !result.url) {
        setFeishuAuth((prev) =>
          prev ? { ...prev, busy: false, message: result.error || '发起授权失败，确认本机助手在运行' } : prev,
        )
        return
      }
      const opened = await openFeishuAuth(bridge, result.url)
      setFeishuAuth((prev) =>
        prev
          ? {
              ...prev,
              busy: false,
              url: result.url,
              message: opened
                ? '已经用默认浏览器打开授权页，在里面点「确认授权」就行。确认后这条提示会自动消失。'
                : '浏览器没能自动打开，点下面的链接过去确认。确认后这条提示会自动消失。',
            }
          : prev,
      )
      stopFeishuPoll()
      const startedAt = Date.now()
      feishuPoll.current = window.setInterval(() => {
        void (async () => {
          try {
            const status = await fetchFeishuStatus(bridge)
            if (status.logged_in) {
              stopFeishuPoll()
              setFeishuAuth(null)
              setNote({ text: '飞书授权好了，可以再点一次「从本机助手读取」。', kind: 'ok' })
            } else if (Date.now() - startedAt > 10 * 60 * 1000) {
              stopFeishuPoll()
              setFeishuAuth((prev) => (prev ? { ...prev, busy: false, message: '授权超时了，再点一次「扫码授权」。' } : prev))
            }
          } catch {
            // 轮询期间助手重启过，下一轮再试。
          }
        })()
      }, 3000)
    } catch (error) {
      setFeishuAuth((prev) =>
        prev ? { ...prev, busy: false, message: `发起授权失败：${error instanceof Error ? error.message : '未知错误'}` } : prev,
      )
    }
  }

  function changeDays(next: number): void {
    const value = clampDays(next)
    setDays(value)
    const saved = { ...bridge, days: value }
    setBridge(saved)
    saveBridge(saved)
  }

  useEffect(() => {
    if (!open) return
    setStage('input')
    setItems([])
    setDecisions({})
    setQueue([])
    setCursor(0)
    setNote(null)
    setSkipped(0)
    setShowOther(false)
    setWarnings([])
    setFeishuAuth(null)
    stopFeishuPoll()
    if (bridge.enabled) void checkFeishuAuth()
  }, [open, bridge.enabled])

  // 弹窗关掉就别再轮询授权状态了。
  useEffect(() => stopFeishuPoll, [])

  // 已经过去的不再问「去不去」，问了也没意义。
  // 别人的事不逐个问，问了也是白问。
  const pending = useMemo(
    () => items.filter((item) => item.needConfirm && !item.expired && item.relevance !== 'other'),
    [items],
  )

  const expiredCount = useMemo(() => items.filter((item) => item.expired).length, [items])
  const otherCount = useMemo(() => items.filter((item) => item.relevance === 'other').length, [items])
  const mineCount = useMemo(() => items.filter((item) => item.relevance === 'mine').length, [items])
  /** 「微信 4 条 · 飞书 2 条」，让人一眼看出这批消息是从哪儿来的。 */
  const channelSummary = useMemo(() => {
    const counts = new Map<string, number>()
    for (const item of items) {
      const key = item.channel || (source === '手动粘贴' ? '手动粘贴' : '本机助手')
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    return [...counts.entries()].map(([name, count]) => `${name} ${count} 条`).join(' · ')
  }, [items, source])
  /** 预览里实际列出来的条目：过期的不显示（可选），别人的事不显示（可选）。 */
  const visible = useMemo(() => {
    let list = hideExpired ? items.filter((item) => !item.expired) : items
    if (!showOther) list = list.filter((item) => item.relevance !== 'other')
    return list
  }, [items, hideExpired, showOther])

  const chosen = useMemo(() => {
    const result: PlanPayload[] = []
    for (const item of items) {
      const decision = decisions[item.id] ?? defaultDecision(item)
      if (decision === 'skip') continue
      result.push({ item, decision, todo: buildTodo(item, decision) })
    }
    return result
  }, [items, decisions])

  function handleParse(messages: NoticeMessage[], from: string): void {
    const report = parseNotices(messages, profile, today(), courses)
    const parsed = sortNotices(report.items)
    setItems(parsed)
    setSkipped(report.skipped)
    setSource(from)
    setDecisions({})
    setStage('review')
    if (parsed.length === 0) {
      setNote({
        text:
          `读完 ${messages.length} 条，没有一条对得上你的身份` +
          `（另有 ${report.skipped} 条无关闲聊已略过）。到设置页把「班级 / 学院、职务、关注词」写全一些，或者直接粘贴你要处理的那几条。`,
        kind: 'info',
      })
    }
  }

  async function handleFetch(): Promise<void> {
    setFetching(true)
    setNote(null)
    try {
      const report = await fetchTodayReport(bridge, days)
      const messages = report.messages
      setWarnings(report.warnings)
      // 读的时候才发现授权掉了（比如刚才还有几分钟过期）：把提示顶上去。
      if (report.warnings.some((line) => /授权|登录|token/i.test(line))) void checkFeishuAuth()
      if (messages.length === 0) {
        setNote({
          text:
            report.warnings.length > 0
              ? `本机助手连上了，但一条消息都没读到：${report.warnings.join('；')}`
              : `本机助手连上了，但最近 ${days} 天没抓到消息。确认微信已登录、飞书里的总结已复制，或直接粘贴。`,
          kind: 'error',
        })
        return
      }
      // 记下每个群里都有谁说过话：设置页要按人缩小范围，手打名字容易错。
      recordSpeakers(messages)
      // 只有剪贴板那一路是「一整块文本」，需要按行拆。
      // 结构化来源（微信、飞书接口）每条消息自带发送人和日期，再按行拆会把
      // 一条通知里的「1.… 2.… 3.…」拆成三条日程，纯属制造噪音。
      const expanded = messages.flatMap((message) =>
        !message.date && message.text.includes('\n')
          ? splitRawText(message.text, message.source || '本机助手')
          : [message],
      )
      setNote({
        text: `读到最近 ${days} 天的 ${expanded.length} 条消息${days > 1 ? '（含往日记录，已经过去的会标出来）' : ''}。`,
        kind: 'ok',
      })
      handleParse(expanded, '本机助手')
    } catch (err) {
      setNote({
        text: `${err instanceof Error ? err.message : '连不上本机助手'}。先双击 启动信息管家.bat，或直接把通知粘进来。`,
        kind: 'error',
      })
    } finally {
      setFetching(false)
    }
  }

  async function handleActivate(app: 'wechat' | 'feishu'): Promise<void> {
    setNote(null)
    try {
      const ok = await activateApp(bridge, app)
      setNote({
        text: ok
          ? app === 'feishu'
            ? '飞书已弹到前台。在里面复制智能体的总结（Ctrl+A / Ctrl+C），再点「从本机助手读取」。'
            : '微信已弹到前台。'
          : '没找到窗口，确认客户端是开着的。',
        kind: ok ? 'info' : 'error',
      })
    } catch (err) {
      setNote({
        text: `${err instanceof Error ? err.message : '唤不起窗口'}。本机助手没开的话，直接粘贴也能用。`,
        kind: 'error',
      })
    }
  }

  async function handleFile(file: File): Promise<void> {
    const content = await file.text()
    setText(content)
  }

  function startConfirm(): void {
    const ids = pending.filter((item) => !decisions[item.id]).map((item) => item.id)
    if (ids.length === 0) {
      void onApply(chosen, source)
      return
    }
    setQueue(ids)
    setCursor(0)
    setStage('confirm')
  }

  function answer(decision: Decision): void {
    const id = queue[cursor]
    setDecisions((prev) => ({ ...prev, [id]: decision }))
    if (cursor + 1 < queue.length) {
      setCursor(cursor + 1)
      return
    }
    const nextDecisions = { ...decisions, [id]: decision }
    const payloads: PlanPayload[] = []
    for (const item of items) {
      const value = nextDecisions[item.id] ?? defaultDecision(item)
      if (value === 'skip') continue
      payloads.push({ item, decision: value, todo: buildTodo(item, value) })
    }
    void onApply(payloads, source)
  }

  if (!open) return null

  const current = stage === 'confirm' ? items.find((item) => item.id === queue[cursor]) : null

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal modal-wide" onClick={(event) => event.stopPropagation()}>
        <div className="modal-title">
          {stage === 'input' ? `一键安排：取最近 ${days} 天的通知` : null}
          {stage === 'review' ? `解析出 ${items.length} 条（${source}）` : null}
          {stage === 'confirm' ? `第 ${cursor + 1} / ${queue.length} 项，请你定` : null}
        </div>
        <div className="modal-desc">
          {stage === 'input'
            ? '从本机助手读取，或把微信/飞书的通知整段粘进来。拿不准参不参加的，后面会逐条问你。'
            : null}
          {stage === 'review' ? '参加的直接进日历，待定的进待办列表，不去的丢弃。' : null}
          {stage === 'confirm' ? '这条是不是你的事、去不去，由你说了算。' : null}
        </div>

        <div className="modal-body">
          {stage === 'input' ? (
            <>
              <div className="row wrap" style={{ marginBottom: 8 }}>
                <button className="btn small" onClick={() => void handleFetch()} disabled={fetching}>
                  {fetching ? '读取中…' : '从本机助手读取'}
                </button>
                <button className="btn small" onClick={() => setText(SAMPLE)}>
                  填入示例
                </button>
                <button
                  className="btn small"
                  disabled={!bridge.enabled}
                  onClick={() => void handleActivate('feishu')}
                  title="把飞书窗口弹到前台"
                >
                  唤起飞书
                </button>
                <button
                  className="btn small"
                  disabled={!bridge.enabled}
                  onClick={() => void handleActivate('wechat')}
                  title="把微信窗口弹到前台"
                >
                  唤起微信
                </button>
                <button className="btn small" onClick={() => fileRef.current?.click()}>
                  打开文本文件
                </button>
                <label className="row" style={{ gap: 4, marginLeft: 2 }}>
                  <span className="small muted">收集范围</span>
                  <select
                    className="select"
                    style={{ width: 104 }}
                    value={days}
                    onChange={(event) => changeDays(Number(event.target.value))}
                    title="往回读几天，最多一周"
                  >
                    {[1, 2, 3, 4, 5, 6, 7].map((value) => (
                      <option key={value} value={value}>
                        最近 {value} 天
                      </option>
                    ))}
                  </select>
                </label>
                <input
                  ref={fileRef}
                  type="file"
                  accept=".txt,.md,.csv,text/plain"
                  style={{ display: 'none' }}
                  onChange={(event) => {
                    const file = event.target.files?.[0]
                    if (file) void handleFile(file)
                    event.target.value = ''
                  }}
                />
              </div>

              {note ? (
                <div className={`notice ${note.kind === 'ok' ? 'ok' : note.kind === 'error' ? 'error' : ''}`} style={{ marginBottom: 8 }}>
                  {note.text}
                </div>
              ) : null}

              {feishuAuth ? (
                <div className="notice error" style={{ marginBottom: 8 }}>
                  <div className="row wrap" style={{ justifyContent: 'space-between', gap: 8 }}>
                    <span>{feishuAuth.message}</span>
                    <button className="btn small" disabled={feishuAuth.busy} onClick={() => void handleFeishuLogin()}>
                      {feishuAuth.busy ? '正在申请…' : '扫码授权'}
                    </button>
                  </div>
                  {feishuAuth.url ? (
                    <div className="small" style={{ marginTop: 6, wordBreak: 'break-all' }}>
                      授权链接：
                      <a href={feishuAuth.url} target="_blank" rel="noreferrer">
                        {feishuAuth.url}
                      </a>
                    </div>
                  ) : null}
                </div>
              ) : null}

              {warnings.length > 0 ? (
                <div className="small muted" style={{ marginBottom: 8 }}>
                  本机助手提示：{warnings.join('；')}
                </div>
              ) : null}

              <textarea
                className="textarea mono"
                style={{ minHeight: 150 }}
                placeholder={'每行一条通知，行首的【群名】会被当成来源。例如：\n【班级群】班长 09:12：明天下午2点行政楼A305开会'}
                value={text}
                onChange={(event) => setText(event.target.value)}
              />
              <div className="small muted" style={{ marginTop: 6 }}>
                {bridge.enabled
                  ? `本机助手：127.0.0.1:${bridge.port}（设置里可关）· 收集范围：最近 ${days} 天`
                  : '本机助手未开启，只能在上面粘贴。开启方法见设置页。'}
                {bridge.enabled && days > 1 ? ' · 往日的通知会标「已过期」，默认不写进日历' : ''}
              </div>
            </>
          ) : null}

          {stage === 'review' ? (
            <div className="plan-list">
              <div className="small muted" style={{ marginBottom: 6 }}>
                按你的身份筛过：共 {items.length} 条，与你有关 {mineCount} 条
                {skipped > 0 ? `；另有 ${skipped} 条无关闲聊没有列出来` : ''}
                {channelSummary ? ` · 来源：${channelSummary}` : ''}
              </div>

              {warnings.length > 0 ? (
                <div className="small muted" style={{ marginBottom: 6 }}>
                  本机助手提示：{warnings.join('；')}
                </div>
              ) : null}

              {otherCount > 0 ? (
                <label className="check-line plan-filter">
                  <input type="checkbox" checked={showOther} onChange={() => setShowOther((prev) => !prev)} />
                  <span>
                    显示与身份无关的（{otherCount} 条）
                    <span className="small muted"> · 点了别的班/别的年级，默认不显示</span>
                  </span>
                </label>
              ) : null}

              {expiredCount > 0 ? (
                <label className="check-line plan-filter">
                  <input
                    type="checkbox"
                    checked={hideExpired}
                    onChange={() => setHideExpired((prev) => !prev)}
                  />
                  <span>
                    隐藏已过期（{expiredCount} 条）
                    <span className="small muted"> · 这些时间已经过了，勾掉可以补记</span>
                  </span>
                </label>
              ) : null}

              {visible.length === 0 ? (
                <div className="empty">
                  {items.length === 0
                    ? '这次没读到与你有关的通知。可以点「返回」换个范围，或直接把要处理的那几条粘进来。'
                    : '剩下的都被筛掉了（已过期、或与你的身份无关）。上面两个勾去掉就能看到。'}
                </div>
              ) : null}

              {visible.map((item) => {
                const decision = decisions[item.id] ?? defaultDecision(item)
                const channel = channelTag(item.channel)
                return (
                  <div className={`plan-item${item.expired ? ' expired' : ''}`} key={item.id}>
                    <div className="plan-item-head">
                      <span className="plan-item-title">{item.title}</span>
                      {channel ? <span className={channel.className}>{channel.text}</span> : null}
                      {item.expired ? <span className="tag">已过期</span> : null}
                      {item.needConfirm && !item.expired ? <span className="tag amber">待你确认</span> : null}
                      {item.relevance === 'other' ? <span className="tag">别人的事</span> : null}
                    </div>
                    <div className="small muted">
                      {item.date ? `${item.date} ${item.time ?? ''}${item.endTime ? `-${item.endTime}` : ''}` : '没认出时间'}
                      {item.location ? ` · ${item.location}` : ''}
                      {item.deadline ? ` · 截止 ${item.deadline}` : ''}
                      {' · '}
                      {[item.channel, item.source, item.sender].filter(Boolean).join(' · ')}
                    </div>
                    <div className="small muted" style={{ marginTop: 2 }}>
                      {item.reason}
                    </div>
                    <div className="row" style={{ marginTop: 6, gap: 6 }}>
                      {(['go', 'later', 'skip'] as Decision[]).map((value) => (
                        <button
                          key={value}
                          className={`btn small ${decision === value ? 'primary' : ''}`}
                          onClick={() => setDecisions((prev) => ({ ...prev, [item.id]: value }))}
                        >
                          {decisionLabel(value)}
                        </button>
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>
          ) : null}

          {stage === 'confirm' && current ? (
            <div>
              <div className="plan-ask-title">{current.title}</div>
              <div className="small muted" style={{ marginTop: 4 }}>
                {current.date
                  ? `${current.date} ${current.time ?? ''}${current.endTime ? `-${current.endTime}` : ''}`
                  : '没认出具体时间'}
                {current.location ? ` · ${current.location}` : ''}
                {' · '}
                {[current.channel, current.source].filter(Boolean).join(' · ')}
              </div>
              <div className="notice" style={{ marginTop: 8 }}>{current.reason}</div>
              <div
                className="small muted"
                style={{ marginTop: 8, whiteSpace: 'pre-wrap', background: 'var(--panel-soft)', padding: 10, borderRadius: 8 }}
              >
                {current.raw}
              </div>
            </div>
          ) : null}
        </div>

        <div className="modal-actions">
          {stage === 'input' ? (
            <>
              <button className="btn" onClick={onClose}>
                取消
              </button>
              <button
                className="btn primary"
                disabled={text.trim().length === 0}
                onClick={() => handleParse(splitRawText(text), '手动粘贴')}
              >
                解析
              </button>
            </>
          ) : null}
          {stage === 'review' ? (
            <>
              <button className="btn" onClick={() => setStage('input')}>
                返回
              </button>
              <button className="btn primary" onClick={startConfirm}>
                {pending.length > 0 ? `确认 ${pending.length} 项并写入` : `写入 ${chosen.length} 条`}
              </button>
            </>
          ) : null}
          {stage === 'confirm' ? (
            <>
              <button className="btn" onClick={() => answer('later')}>
                待定
              </button>
              <button className="btn" onClick={() => answer('skip')}>
                不去
              </button>
              <button className="btn primary" onClick={() => answer('go')}>
                参加
              </button>
            </>
          ) : null}
        </div>
      </div>
    </div>
  )
}
