import { useEffect, useState } from 'react'
import { isModelReady } from './ai/agent'
import { LLM_CHANGED_EVENT, storageWritable } from './ai/settings'
import { DashboardPage } from './pages/DashboardPage'
import { CalendarPage } from './pages/CalendarPage'
import { NotesPage } from './pages/NotesPage'
import { TodosPage } from './pages/TodosPage'
import { AskPage } from './pages/AskPage'
import { ReportsPage } from './pages/ReportsPage'
import { SettingsPage } from './pages/SettingsPage'
import { ToastProvider, useToast } from './components/Toast'
import { StoreProvider, useStore } from './store'
import { courseOccursOn, suggestSemesterStart } from './schedule/occurrence'
import { today } from './utils/date'

type RouteKey = 'dashboard' | 'calendar' | 'notes' | 'todos' | 'ask' | 'reports' | 'settings'

interface NavDef {
  key: RouteKey
  label: string
  title: string
  subtitle: string
  path: string
}

const NAV: NavDef[] = [
  {
    key: 'dashboard',
    label: '工作台',
    title: '工作台',
    subtitle: '一眼看清进度与优先级',
    path: 'M3 12h4l3 8 4-16 3 8h4',
  },
  {
    key: 'calendar',
    label: '日历',
    title: '日历',
    subtitle: '待办与课表按时间铺开',
    path: 'M4 6h16v15H4z M4 10h16 M9 3v4 M15 3v4',
  },
  {
    key: 'notes',
    label: '资料库',
    title: '资料库',
    subtitle: '自动分类、摘要、提取重点',
    path: 'M4 5h16v14H4z M8 9h8 M8 13h6',
  },
  {
    key: 'todos',
    label: '待办',
    title: '待办整理',
    subtitle: '从资料自动派生，AI 帮你排序',
    path: 'M4 8l4 4 8-8 M4 16l4 4 8-8',
  },
  {
    key: 'ask',
    label: '智能问答',
    title: '智能问答',
    subtitle: '只依据你自己的资料作答',
    path: 'M20 15a2 2 0 0 1-2 2H8l-4 4V5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z',
  },
  {
    key: 'reports',
    label: '阶段总结',
    title: '阶段总结',
    subtitle: '阶段复盘与后续行动建议',
    path: 'M5 20V10 M12 20V4 M19 20v-7',
  },
  {
    key: 'settings',
    label: '设置',
    title: '设置',
    subtitle: '模型接入与本地数据管理',
    path: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 7 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 3 15a2 2 0 1 1 0-4 1.6 1.6 0 0 0 1.1-2.7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.6 1.6 0 0 0 9 3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.6 1.6 0 0 0 21 9v.1a2 2 0 1 1 0 4z',
  },
]

const ROUTE_KEYS = new Set<string>(NAV.map((item) => item.key))

function readRoute(): RouteKey {
  const raw = window.location.hash.replace(/^#\/?/, '')
  return ROUTE_KEYS.has(raw) ? (raw as RouteKey) : 'dashboard'
}

function navigate(key: string): void {
  window.location.hash = `#/${key}`
}

/** 顶部的数据错误提示。本地写入失败（配额满、隐私模式）必须让用户看到。 */
function StoreAlert() {
  const { error } = useStore()
  if (!error) return null
  return <div className="notice error">{error}</div>
}

/**
 * 这个页面能不能存住数据。
 *
 * 被嵌进预览窗口（沙盒 iframe）或跑在无痕模式时会写不进去，
 * 用户填了一整页才发现白填——所以在最上面先说清楚，并给条出路。
 */
function StorageAlert() {
  const [state] = useState(() => {
    let embedded = false
    try {
      embedded = window.top !== window.self
    } catch {
      // 跨源访问 window.top 被拦，说明确实嵌在别人的页面里。
      embedded = true
    }
    return { writable: storageWritable(), embedded }
  })

  if (state.writable && !state.embedded) return null

  return (
    <div className={`notice ${state.writable ? 'warn' : 'error'}`}>
      {state.writable
        ? '这一页是被嵌在窗口里打开的，数据只活在这次会话中，关掉就没了。想长期用，把 信息管家.html 复制到本地，用 Edge / Chrome 双击打开。'
        : '这个页面不允许保存数据（预览窗口、沙盒 iframe、无痕模式都会这样）。这里记的资料、填的 Key 刷新后都会消失。把 信息管家.html 复制到本地，用 Edge / Chrome 双击打开再操作。'}
    </div>
  )
}

function ModeBadge() {
  const [ready, setReady] = useState(() => isModelReady())
  useEffect(() => {
    // 设置页一改就派事件过来，徽章立刻变；focus 和 storage 覆盖切窗口、多标签页的情况。
    const sync = () => setReady(isModelReady())
    window.addEventListener('focus', sync)
    window.addEventListener('storage', sync)
    window.addEventListener(LLM_CHANGED_EVENT, sync)
    return () => {
      window.removeEventListener('focus', sync)
      window.removeEventListener('storage', sync)
      window.removeEventListener(LLM_CHANGED_EVENT, sync)
    }
  }, [])

  return (
    <span className={`tag ${ready ? 'green' : 'amber'}`}>{ready ? '智能模式' : '离线模式'}</span>
  )
}

function Shell() {
  const [route, setRoute] = useState<RouteKey>(() => readRoute())
  const { refresh } = useStore()
  const toast = useToast()

  // 光重读数据是不会把错位的课表变出来的。刷新后如果今天一节都排不上，
  // 直接把原因说出来，别让人对着空日历反复点按钮。
  async function handleRefresh(): Promise<void> {
    const snapshot = await refresh()
    if (snapshot.courses.length === 0) {
      toast('已刷新。')
      return
    }
    const hits = snapshot.courses.filter((course) => courseOccursOn(course, today())).length
    if (hits > 0) {
      toast(`已刷新，今天有 ${hits} 节课。`, 'ok')
      return
    }
    const suggestion = suggestSemesterStart(snapshot.courses, today())
    toast(
      suggestion
        ? `刷新了，但今天排不到课：开学日多半填晚了。建议改成 ${suggestion}，去日历页点「按这个日期重排」。`
        : '刷新了，但今天排不到课：开学日和学期周次对不上，到日历页重新导入一次。',
      'error',
    )
  }

  useEffect(() => {
    const onHashChange = () => setRoute(readRoute())
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  const current = NAV.find((item) => item.key === route) ?? NAV[0]

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <div className="brand-mark">管</div>
          <div className="brand-name">信息管家</div>
        </div>
        <nav className="nav">
          {NAV.map((item) => (
            <button
              key={item.key}
              className={`nav-item${route === item.key ? ' active' : ''}`}
              onClick={() => navigate(item.key)}
            >
              <svg
                className="nav-icon"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
              >
                <path d={item.path} strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              {item.label}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          数据保存在本机浏览器 · 单机自用
          <br />
          <span title="改完代码重新构建后这个时间会变，据此确认浏览器有没有加载到新版">
            构建 {typeof __BUILD_TIME__ === 'string' ? __BUILD_TIME__ : '开发模式'}
          </span>
        </div>
      </aside>

      <main className="main">
        <div className="topbar">
          <div>
            <div className="topbar-title">{current.title}</div>
            <div className="topbar-sub">{current.subtitle}</div>
          </div>
          <div className="topbar-right">
            <ModeBadge />
            <button className="btn small" onClick={() => void handleRefresh()}>
              刷新
            </button>
          </div>
        </div>

        <div className="content">
          <div className={`content-inner${route === 'calendar' ? ' wide' : ''}`}>
            <StorageAlert />
            <StoreAlert />
            {route === 'dashboard' ? <DashboardPage onNavigate={navigate} /> : null}
            {route === 'calendar' ? <CalendarPage /> : null}
            {route === 'notes' ? <NotesPage /> : null}
            {route === 'todos' ? <TodosPage /> : null}
            {route === 'ask' ? <AskPage /> : null}
            {route === 'reports' ? <ReportsPage /> : null}
            {route === 'settings' ? <SettingsPage onChanged={() => void refresh()} /> : null}
          </div>
        </div>
      </main>
    </div>
  )
}

export default function App() {
  return (
    <ToastProvider>
      <StoreProvider>
        <Shell />
      </StoreProvider>
    </ToastProvider>
  )
}
