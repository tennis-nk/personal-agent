import { useEffect, useRef, useState } from 'react'
import { isModelReady } from '../ai/agent'
import { describeLlmError, testConnection } from '../ai/llm'
import {
  PRESETS,
  DEFAULT_SETTINGS,
  isReady,
  notifyLlmChanged,
  loadSettings,
  saveSettings,
  type LlmSettings,
} from '../ai/settings'
import { exportBackup, importBackup, resetAll } from '../data/api'
import {
  clampDays,
  fetchBridgeHealth,
  fetchToday,
  fetchWechatSessions,
  loadBridge,
  loadProfile,
  loadRemoteBridge,
  fetchFeishuChats,
  fetchFeishuStatus,
  startFeishuLogin,
  pushBridgeConfig,
  saveBridge,
  saveProfile,
  type BridgeConfig,
  type BridgeHealth,
} from '../data/profile'
import type { Profile } from '../schedule/notice'
import { ConfirmDialog } from '../components/ConfirmDialog'

/**
 * 设置页。
 *
 * 这一页决定应用跑在哪种模式：填了模型接口就走大模型，
 * 没填就全程用本地规则引擎——两种模式功能入口完全一样，
 * 只是处理结果里会注明是哪一种产出的。
 */
export function SettingsPage({ onChanged }: { onChanged: () => void }) {
  const [settings, setSettings] = useState<LlmSettings>(() => loadSettings())
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState('')
  /** 上一次改动有没有写进浏览器；null 表示这次还没动过。 */
  const [saveState, setSaveState] = useState<{ ok: boolean; at: Date } | null>(null)
  const [dataMessage, setDataMessage] = useState('')
  const [confirmReset, setConfirmReset] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  // 飞书授权轮询的定时器，离开页面要清掉，别让它在后台一直打本机端口。
  const feishuPoll = useRef<number | null>(null)
  useEffect(() => {
    return () => {
      if (feishuPoll.current) window.clearInterval(feishuPoll.current)
    }
  }, [])
  const [profile, setProfile] = useState<Profile>(() => loadProfile())
  const [bridge, setBridge] = useState<BridgeConfig>(() => loadBridge())
  const [bridgeTesting, setBridgeTesting] = useState(false)
  const [bridgeResult, setBridgeResult] = useState('')
  const [sessionsText, setSessionsText] = useState('')
  // 飞书这一路：直读群消息（SDK）还是老办法（弹窗口+复制）
  const [feishuMode, setFeishuMode] = useState<'clipboard' | 'sdk'>('clipboard')
  const [feishuChatsText, setFeishuChatsText] = useState('')
  const [feishuPool, setFeishuPool] = useState<string[]>([])
  const [feishuNote, setFeishuNote] = useState('')
  const [feishuBusy, setFeishuBusy] = useState('')
  const [feishuLoginUrl, setFeishuLoginUrl] = useState('')
  const [sessionPool, setSessionPool] = useState<string[]>([])
  const [savingSessions, setSavingSessions] = useState(false)
  const [listingSessions, setListingSessions] = useState(false)
  /** 本机助手跑在哪个解释器上、能不能读微信。连不上时是 null。 */
  const [health, setHealth] = useState<BridgeHealth | null>(null)

  const ready = isModelReady()
  // 「测试连接」直接用输入框里的值，不看有没有存进浏览器：
  // 存不住的环境（预览窗口）也该让人先把 Key 验一下对不对。
  const canTest = isReady(settings)

  /**
   * 改一项就存一次，并把「存没存住」摆在界面上。
   *
   * 以前这里是静默 save：写失败也不会说，用户填完 Key 看着像没事，
   * 刷新之后才发现全没了。现在失败会写明原因和出路。
   */
  function update(patch: Partial<LlmSettings>): void {
    const next = { ...settings, ...patch }
    setSettings(next)
    const saved = saveSettings(next)
    setSaveState({ ok: saved, at: new Date() })
    if (saved) notifyLlmChanged()
    onChanged()
  }

  /**
   * 把当前配置（含 Key）复制成一段文本。
   *
   * Key 只存在浏览器的 localStorage 里，换 profile、清站点数据、用临时会话打开都会丢。
   * 给个出口让人自己存一份，比事后翻浏览器数据靠谱。
   */
  async function copyConfig(): Promise<void> {
    const text = [
      `接口地址：${settings.baseUrl}`,
      `模型：${settings.model}`,
      `API Key：${settings.apiKey}`,
    ]
      .filter(Boolean)
      .join('\n')

    try {
      await navigator.clipboard.writeText(text)
      setTestResult('配置已复制，粘到你自己记得住的地方存一份。')
      return
    } catch {
      // 剪贴板不可用时（某些浏览器的 file:// 限制）退回手动选中复制。
    }

    const area = document.createElement('textarea')
    area.value = text
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(area)
    setTestResult(ok ? '配置已复制，粘到你自己记得住的地方存一份。' : '复制失败，手动抄一下 Key 更稳。')
  }

  function updateProfile(patch: Partial<Profile>): void {
    const next = { ...profile, ...patch }
    setProfile(next)
    saveProfile(next)
  }

  function updateBridge(patch: Partial<BridgeConfig>): void {
    const next = { ...bridge, ...patch }
    setBridge(next)
    saveBridge(next)
    setBridgeResult('')
  }

  /**
   * 改收集范围。
   *
   * 本地先存（一键安排那边直接读这个值），再顺手同步一份到本机服务的 config.json；
   * 连不上就算了——取消息时请求里也带着 ?days，不依赖配置文件。
   */
  function changeBridgeDays(value: number): void {
    const next = { ...bridge, days: clampDays(value) }
    setBridge(next)
    saveBridge(next)
    setBridgeResult('')
    if (!next.enabled) return
    void pushBridgeConfig(next, { wechat: { days: next.days } }).catch(() => {
      // 本机服务没开，忽略即可。
    })
  }

  /** 白名单存在本机服务的 config.json 里，开设置页时拉一次。 */
  useEffect(() => {
    if (!bridge.enabled) return
    let alive = true
    void fetchBridgeHealth(bridge).then((info) => {
      if (alive) setHealth(info)
    })
    loadRemoteBridge(bridge)
      .then((remote) => {
        if (!alive || !remote) return
        setSessionsText(remote.wechat?.sessions?.join(', ') ?? '')
        setFeishuMode(remote.feishu?.mode === 'sdk' ? 'sdk' : 'clipboard')
        setFeishuChatsText(remote.feishu?.chats?.join(', ') ?? '')
      })
      .catch(() => {
        // 拉不到就用本地空值，用户手填再保存。
      })
    return () => {
      alive = false
    }
  }, [bridge.enabled, bridge.port])

  function splitSessions(): string[] {
    return sessionsText
      .split(/[,，、;；\n]/)
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
  }

  function addSession(name: string): void {
    const current = splitSessions()
    if (current.includes(name)) return
    setSessionsText([...current, name].join(', '))
  }

  // ------------------------------ 飞书 ------------------------------

  function splitFeishuChats(): string[] {
    return feishuChatsText
      .split(/[,，、;；\n]/)
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
  }

  function addFeishuChat(name: string): void {
    const current = splitFeishuChats()
    if (current.includes(name)) return
    setFeishuChatsText([...current, name].join(', '))
  }

  /** 保存飞书设置（模式 + 群名）到本机服务的 config.json。 */
  async function saveFeishu(patch: { mode?: 'clipboard' | 'sdk'; chats?: string[] }): Promise<void> {
    const chats = patch.chats ?? splitFeishuChats()
    const mode = patch.mode ?? feishuMode
    await pushBridgeConfig(bridge, { feishu: { mode, chats } })
    const label = mode === 'sdk' ? '直读群消息' : '弹窗口 + 复制'
    setFeishuNote(
      chats.length > 0
        ? `已保存：${label}，读这 ${chats.length} 个群（${chats.join('、')}）。`
        : `已保存：${label}，群名是空的，飞书这边暂时不会读任何群。`,
    )
  }

  async function handleFeishuMode(next: 'clipboard' | 'sdk'): Promise<void> {
    setFeishuMode(next)
    setFeishuNote('')
    try {
      await saveFeishu({ mode: next })
    } catch (error) {
      setFeishuNote(`保存失败：${error instanceof Error ? error.message : '未知错误'}`)
    }
  }

  async function handleSaveFeishuChats(): Promise<void> {
    setFeishuBusy('save')
    try {
      await saveFeishu({})
    } catch (error) {
      setFeishuNote(`保存失败：${error instanceof Error ? error.message : '未知错误'}`)
    } finally {
      setFeishuBusy('')
    }
  }

  async function handleListFeishuChats(): Promise<void> {
    setFeishuBusy('list')
    setFeishuNote('')
    try {
      const result = await fetchFeishuChats(bridge)
      setFeishuPool(result.chats)
      setFeishuNote(
        result.chats.length > 0
          ? `读到 ${result.chats.length} 个群，点名字加进上面的输入框。`
          : result.error || '没读到群，先完成授权。',
      )
    } catch (error) {
      setFeishuNote(`读取失败：${error instanceof Error ? error.message : '未知错误'}`)
    } finally {
      setFeishuBusy('')
    }
  }

  /**
   * 扫码授权。
   *
   * 本机助手在后台跑设备码流程：先拿一个验证链接，用户确认后再去换 token。
   * 这里不阻塞等待，隔 3 秒看一次状态，成功就自动把群名读出来。
   */
  async function handleFeishuLogin(): Promise<void> {
    setFeishuBusy('login')
    setFeishuLoginUrl('')
    setFeishuNote('正在向飞书申请授权链接…')
    try {
      const result = await startFeishuLogin(bridge)
      if (!result.ok || !result.url) {
        setFeishuNote(result.error || '发起授权失败，确认本机助手在运行')
        setFeishuBusy('')
        return
      }
      setFeishuLoginUrl(result.url)
      setFeishuNote('用飞书扫下面的二维码，或在浏览器里打开链接确认。确认后这里会自动更新。')

      const startedAt = Date.now()
      if (feishuPoll.current) window.clearInterval(feishuPoll.current)
      feishuPoll.current = window.setInterval(() => {
        void (async () => {
          try {
            const status = await fetchFeishuStatus(bridge)
            if (status.logged_in) {
              window.clearInterval(feishuPoll.current ?? undefined)
              feishuPoll.current = null
              setFeishuLoginUrl('')
              setFeishuBusy('')
              setFeishuNote('授权成功，飞书群消息可以直接读了。')
              const chats = await fetchFeishuChats(bridge)
              if (chats.chats.length > 0) setFeishuPool(chats.chats)
            } else if (status.login.state === 'error') {
              window.clearInterval(feishuPoll.current ?? undefined)
              feishuPoll.current = null
              setFeishuBusy('')
              setFeishuNote(`授权失败：${status.login.error || '未知原因'}`)
            } else if (Date.now() - startedAt > 11 * 60 * 1000) {
              window.clearInterval(feishuPoll.current ?? undefined)
              feishuPoll.current = null
              setFeishuBusy('')
              setFeishuNote('授权超时了，点一次「扫码授权」重新来。')
            }
          } catch {
            // 本机助手在轮询期间重启过，下一轮再试。
          }
        })()
      }, 3000)
    } catch (error) {
      setFeishuNote(`发起授权失败：${error instanceof Error ? error.message : '未知错误'}`)
      setFeishuBusy('')
    }
  }

  async function handleSaveSessions(): Promise<void> {
    setSavingSessions(true)
    setBridgeResult('')
    try {
      const list = splitSessions()
      await pushBridgeConfig(bridge, { wechat: { sessions: list } })
      setBridgeResult(
        list.length > 0
          ? `已保存，本机助手会读这 ${list.length} 个会话：${list.join('、')}`
          : '已保存，白名单是空的，微信不会被读取。',
      )
    } catch (error) {
      setBridgeResult(`保存失败：${error instanceof Error ? error.message : '未知错误'}`)
    } finally {
      setSavingSessions(false)
    }
  }

  async function handleListSessions(): Promise<void> {
    setListingSessions(true)
    setBridgeResult('')
    try {
      const result = await fetchWechatSessions(bridge)
      setSessionPool(result.sessions)
      setBridgeResult(
        result.sessions.length > 0
          ? `读到 ${result.sessions.length} 个会话，点名字加进白名单。`
          : result.error || '没读到会话，确认微信已登录并停在聊天页。',
      )
    } catch (error) {
      setBridgeResult(`读取失败：${error instanceof Error ? error.message : '未知错误'}`)
    } finally {
      setListingSessions(false)
    }
  }

  async function handleBridgeTest(): Promise<void> {
    setBridgeTesting(true)
    setBridgeResult('')
    try {
      const messages = await fetchToday(bridge)
      setBridgeResult(
        `已连上：127.0.0.1:${bridge.port}，抓到 ${messages.length} 条当天消息。` +
          (messages[0] ? `最新一条来自「${messages[0].source}」。` : ''),
      )
    } catch (error) {
      setBridgeResult(
        `连不上：${error instanceof Error ? error.message : '未知错误'}。双击 启动信息管家.bat 起它，并确认端口一致。`,
      )
    } finally {
      setBridgeTesting(false)
    }
  }

  function applyPreset(id: string): void {
    const preset = PRESETS.find((item) => item.id === id)
    if (!preset) return
    update({
      provider: id,
      baseUrl: preset.baseUrl,
      model: preset.model,
    })
  }

  async function handleTest(): Promise<void> {
    setTesting(true)
    setTestResult('')
    try {
      const message = await testConnection(settings)
      setTestResult(`连接成功：${message}`)
    } catch (error) {
      setTestResult(`连接失败：${describeLlmError(error)}`)
    } finally {
      setTesting(false)
    }
  }

  function handleExport(): void {
    const backup = exportBackup()
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `信息管家备份-${backup.exportedAt.slice(0, 10)}.json`
    link.click()
    URL.revokeObjectURL(url)
    setDataMessage(`已导出 ${backup.data.notes.length} 条资料、${backup.data.todos.length} 条待办。`)
  }

  async function handleImport(file: File): Promise<void> {
    try {
      const text = await file.text()
      importBackup(text)
      setDataMessage('导入完成，数据已整库替换。')
      onChanged()
    } catch (error) {
      setDataMessage(error instanceof Error ? error.message : '导入失败。')
    }
  }

  function handleReset(): void {
    setConfirmReset(false)
    try {
      resetAll()
      setDataMessage('已清空全部本地数据。')
      onChanged()
    } catch (error) {
      setDataMessage(error instanceof Error ? error.message : '清空失败，请重试。')
    }
  }

  return (
    <>
      <div className={`notice ${ready ? 'ok' : 'warn'}`}>
        {ready
          ? '当前为智能模式：资料会自动交给模型分类、摘要、提取重点，问答可跨条归纳。'
          : '当前为离线模式：未接入大模型，全部结果由本地规则引擎生成（检索 + 统计），不会产生额外的模型费用。'}
      </div>

      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">模型接口</div>
            <div className="small muted">填你自己的 Key，只保存在这台电脑的浏览器里</div>
          </div>
        </div>
        <div className="card-body">
          <div className="field">
            <div className="field-label">服务商</div>
            <select
              className="select"
              value={settings.provider}
              onChange={(event) => applyPreset(event.target.value)}
            >
              {PRESETS.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.name}
                </option>
              ))}
            </select>
            <div className="small muted">
              {PRESETS.find((item) => item.id === settings.provider)?.hint ?? ''}
            </div>
          </div>

          <div className="field">
            <div className="field-label">接口地址</div>
            <input
              className="input"
              value={settings.baseUrl}
              placeholder="https://api.deepseek.com/v1"
              onChange={(event) => update({ baseUrl: event.target.value })}
            />
          </div>

          <div className="field">
            <div className="field-label">API Key</div>
            <input
              className="input"
              type="password"
              value={settings.apiKey}
              placeholder="sk-..."
              onChange={(event) => update({ apiKey: event.target.value })}
            />
            {saveState === null ? (
              <div className="small muted">边输入边保存，填完这一栏就已经写进本机了。</div>
            ) : saveState.ok ? (
              <div className="small" style={{ color: 'var(--green)' }}>
                已保存到本机 · {saveState.at.toLocaleTimeString('zh-CN', { hour12: false })}
              </div>
            ) : (
              <div className="small" style={{ color: 'var(--red)' }}>
                这次没存住（浏览器不给这个页面写数据）。当前这一页还能用，但刷新或关掉就没了。
              </div>
            )}
          </div>

          <div className="field">
            <div className="field-label">模型名</div>
            <input
              className="input"
              value={settings.model}
              placeholder="deepseek-flash"
              onChange={(event) => update({ model: event.target.value })}
            />
            <div className="small muted">
              DeepSeek 填 deepseek-flash；换别家就填它文档里那个型号名。
            </div>
          </div>

          <label className="row">
            <input
              type="checkbox"
              checked={settings.jsonMode}
              onChange={(event) => update({ jsonMode: event.target.checked })}
            />
            <span className="small">强制 JSON 输出（部分服务商不支持，报错就关掉）</span>
          </label>

          <div className="row wrap" style={{ marginTop: 12 }}>
            <button className="btn primary small" onClick={() => void handleTest()} disabled={testing || !canTest}>
              {testing ? '测试中…' : '测试连接'}
            </button>
            {settings.apiKey ? (
              <button className="btn ghost small" onClick={() => void copyConfig()}>
                复制配置（含 Key）
              </button>
            ) : null}
            <button
              className="btn ghost small"
              onClick={() => {
                update({ ...DEFAULT_SETTINGS, apiKey: '' })
                setTestResult('')
              }}
            >
              恢复默认
            </button>
            {settings.apiKey ? (
              <button className="btn ghost small" onClick={() => update({ apiKey: '' })}>
                清除 Key
              </button>
            ) : null}
          </div>

          {testResult ? (
            <div className={`notice ${testResult.startsWith('连接成功') ? 'ok' : 'error'}`} style={{ marginTop: 12 }}>
              {testResult}
            </div>
          ) : null}
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
          <div className="card-head">
            <div>
              <div className="card-title">我的身份</div>
              <div className="small muted">
                一键安排靠它判断哪条通知与你有关，只存在这台电脑的浏览器里
              </div>
            </div>
          </div>
          <div className="card-body">
            <div className="field">
              <div className="field-label">班级 / 学院</div>
              <input
                className="input"
                value={profile.org}
                placeholder="2026级自动化1班"
                onChange={(event) => updateProfile({ org: event.target.value })}
              />
            </div>
            <div className="field">
              <div className="field-label">职务</div>
              <input
                className="input"
                value={profile.roles}
                placeholder="班长, 社团干事（逗号分隔）"
                onChange={(event) => updateProfile({ roles: event.target.value })}
              />
            </div>
            <div className="field">
              <div className="field-label">关注词</div>
              <input
                className="input"
                value={profile.keywords}
                placeholder="奖学金, 志愿, 讲座（逗号分隔）"
                onChange={(event) => updateProfile({ keywords: event.target.value })}
              />
            </div>
            <div className="small muted">
              通知里出现了这些词就判为「你的事」；点了别的班级、你又不在其中的，直接判成别人的事，不打扰你。
            </div>
          </div>
        </div>

      <div className="card" style={{ marginTop: 16 }}>
          <div className="card-head">
            <div>
              <div className="card-title">本机助手</div>
              <div className="small muted">
                开着它，「一键安排」就能直接读微信/飞书最近几天的通知（最多一周）；关掉也随时可以手动粘贴
              </div>
            </div>
          </div>
          <div className="card-body">
            <label className="row">
              <input
                type="checkbox"
                checked={bridge.enabled}
                onChange={(event) => updateBridge({ enabled: event.target.checked })}
              />
              <span className="small">启用本机助手</span>
            </label>

            <div className="field" style={{ marginTop: 10 }}>
              <div className="field-label">端口</div>
              <input
                className="input"
                style={{ width: 140 }}
                inputMode="numeric"
                value={bridge.port}
                onChange={(event) => updateBridge({ port: Number(event.target.value) || 8787 })}
              />
              <div className="small muted">
                双击 <code>启动信息管家.bat</code> 就会起它（已在跑则只打开应用）；端口要和这里一致。
              </div>
              {health ? (
                <div className="small" style={{ marginTop: 4 }}>
                  <span style={{ color: health.wechatReady ? 'var(--green)' : 'var(--red)' }}>
                    微信通道{health.wechatReady ? '可用' : '不可用'}
                  </span>
                  {health.wechatReady ? null : (
                    <span className="muted">
                      ：{health.wechatError || '当前解释器没有 wxauto4'}。
                      改用 <code>启动信息管家.bat</code> 启动，它会自动挑装了 wxauto4 的那个解释器。
                    </span>
                  )}
                </div>
              ) : null}
              {health?.python ? (
                <div className="small muted" style={{ marginTop: 2, wordBreak: 'break-all' }}>
                  解释器：{health.python}
                </div>
              ) : null}
            </div>

            <div className="field" style={{ marginTop: 10 }}>
              <div className="field-label">收集范围（往回读几天）</div>
              <select
                className="select"
                style={{ width: 160 }}
                value={clampDays(bridge.days)}
                onChange={(event) => changeBridgeDays(Number(event.target.value))}
              >
                {[1, 2, 3, 4, 5, 6, 7].map((value) => (
                  <option key={value} value={value}>
                    最近 {value} 天
                  </option>
                ))}
              </select>
              <div className="small muted">
                最多一周。范围越大，微信要往回翻的消息越多，读取会慢一点；往日的通知在预览里标「已过期」，
                默认不写进日历。
              </div>
            </div>

            <div className="field" style={{ marginTop: 10 }}>
              <div className="field-label">微信群名（逗号分隔，只这些会话会被读取）</div>
              <input
                className="input"
                value={sessionsText}
                placeholder="班级群, 年级通知群"
                onChange={(event) => setSessionsText(event.target.value)}
              />
              <div className="small muted">
                留空就完全不读微信。写不全也能匹配，比如填「自动化」能命中「2026级自动化1班群」。
              </div>
            </div>

            <div className="row wrap" style={{ marginTop: 12 }}>
              <button className="btn small primary" onClick={() => void handleSaveSessions()} disabled={savingSessions}>
                {savingSessions ? '保存中…' : '保存群名'}
              </button>
              <button className="btn small" onClick={() => void handleBridgeTest()} disabled={bridgeTesting}>
                {bridgeTesting ? '测试中…' : '测试连接'}
              </button>
              <button className="btn small" onClick={() => void handleListSessions()} disabled={listingSessions}>
                {listingSessions ? '读取中…' : '从微信读取会话名'}
              </button>
            </div>

            {sessionPool.length > 0 ? (
              <div style={{ marginTop: 10 }}>
                <div className="small muted">点一下就加进上面的输入框：</div>
                <div className="row wrap" style={{ marginTop: 6, gap: 6 }}>
                  {sessionPool.slice(0, 24).map((name) => (
                    <button key={name} className="btn small" onClick={() => addSession(name)}>
                      {name}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="sub-divider">飞书</div>

            <div className="field">
              <div className="field-label">读取方式</div>
              <select
                className="select"
                style={{ width: 300 }}
                value={feishuMode}
                onChange={(event) => void handleFeishuMode(event.target.value as 'clipboard' | 'sdk')}
              >
                <option value="sdk">直读群消息（推荐，需扫码授权一次）</option>
                <option value="clipboard">弹到前台 + 复制（老办法）</option>
              </select>
              <div className="small muted">
                {feishuMode === 'sdk'
                  ? '走飞书开放平台接口，不用把窗口弹到前台，也不用复制，消息带发送人和精确时间。'
                  : '把飞书窗口弹到前台，你在里面复制，脚本读剪贴板。不用授权，但每次都要手动复制。'}
              </div>
            </div>

            {feishuMode === 'sdk' ? (
              <>
                <div className="field" style={{ marginTop: 10 }}>
                  <div className="field-label">飞书群名（逗号分隔，只这些群会被读取）</div>
                  <input
                    className="input"
                    value={feishuChatsText}
                    placeholder="年级通知群, 班级群"
                    onChange={(event) => setFeishuChatsText(event.target.value)}
                  />
                  <div className="small muted">
                    留空就完全不读飞书。名字可以写不全，能命中子串就行。
                  </div>
                </div>

                <div className="row wrap" style={{ marginTop: 12 }}>
                  <button
                    className="btn small primary"
                    onClick={() => void handleSaveFeishuChats()}
                    disabled={feishuBusy === 'save'}
                  >
                    {feishuBusy === 'save' ? '保存中…' : '保存飞书群名'}
                  </button>
                  <button
                    className="btn small"
                    onClick={() => void handleFeishuLogin()}
                    disabled={feishuBusy === 'login'}
                  >
                    {feishuBusy === 'login' ? '等待确认…' : '扫码授权'}
                  </button>
                  <button
                    className="btn small"
                    onClick={() => void handleListFeishuChats()}
                    disabled={feishuBusy === 'list'}
                  >
                    {feishuBusy === 'list' ? '读取中…' : '读取飞书群名'}
                  </button>
                </div>

                {feishuLoginUrl ? (
                  <div className="notice warn" style={{ marginTop: 12 }}>
                    <div style={{ marginBottom: 6 }}>在飞书里打开这个链接确认授权：</div>
                    <a href={feishuLoginUrl} target="_blank" rel="noreferrer" className="small">
                      {feishuLoginUrl.length > 90 ? `${feishuLoginUrl.slice(0, 90)}…` : feishuLoginUrl}
                    </a>
                    <div className="row" style={{ marginTop: 8, gap: 8 }}>
                      <button
                        className="btn small"
                        onClick={() => {
                          void navigator.clipboard?.writeText(feishuLoginUrl).catch(() => undefined)
                        }}
                      >
                        复制链接
                      </button>
                      <span className="small muted">链接 10 分钟内有效</span>
                    </div>
                  </div>
                ) : null}

                {feishuPool.length > 0 ? (
                  <div style={{ marginTop: 10 }}>
                    <div className="small muted">点一下就加进上面的输入框：</div>
                    <div className="row wrap" style={{ marginTop: 6, gap: 6 }}>
                      {feishuPool.slice(0, 24).map((name) => (
                        <button key={name} className="btn small" onClick={() => addFeishuChat(name)}>
                          {name}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}
              </>
            ) : null}

            {feishuNote ? (
              <div
                className={`notice ${/^(已保存|授权成功|读到)/.test(feishuNote) ? 'ok' : 'warn'}`}
                style={{ marginTop: 12 }}
              >
                {feishuNote}
              </div>
            ) : null}

            {bridgeResult ? (
              <div
                className={`notice ${bridgeResult.startsWith('已连上') ? 'ok' : 'error'}`}
                style={{ marginTop: 12 }}
              >
                {bridgeResult}
              </div>
            ) : null}
          </div>
        </div>

      <div className="card" style={{ marginTop: 16 }}>
          <div className="card-head">
            <div>
              <div className="card-title">本地数据</div>
              <div className="small muted">数据存在浏览器 localStorage，换浏览器或清缓存会丢失</div>
            </div>
          </div>
          <div className="card-body">
            <div className="row wrap">
              <button className="btn small" onClick={handleExport}>
                导出备份
              </button>
              <button className="btn small" onClick={() => fileRef.current?.click()}>
                导入备份
              </button>
              <button className="btn danger small" onClick={() => setConfirmReset(true)}>
                清空全部数据
              </button>
              <input
                ref={fileRef}
                type="file"
                accept="application/json,.json"
                style={{ display: 'none' }}
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  if (file) void handleImport(file)
                  event.target.value = ''
                }}
              />
            </div>
            {dataMessage ? <div className="small muted" style={{ marginTop: 8 }}>{dataMessage}</div> : null}
            <div className="small muted" style={{ marginTop: 12 }}>
              建议每周导出一次备份。接口地址、Key、模型名存在单独的位置，不会随备份导出，也不会被清除数据清掉；
              Key 只在这个浏览器的这个地址下有效，换浏览器或清站点数据会丢，用上面的「复制配置」自己存一份。
            </div>
          </div>
        </div>

      <ConfirmDialog
        open={confirmReset}
        title="清空全部本地数据"
        description="资料、待办、关联关系、问答记录和阶段总结都会被删除，且无法撤销。建议先导出备份。模型接口配置不会被清除。"
        confirmText="确认清空"
        danger
        onConfirm={handleReset}
        onCancel={() => setConfirmReset(false)}
      />
    </>
  )
}
