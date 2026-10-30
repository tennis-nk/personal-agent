import { useEffect, useRef, useState } from 'react'
import {
  AgentError,
  answerOffline,
  buildQaMessages,
  rankNotes,
  streamChat,
} from '../ai/agent'
import { appendMessage, clearMessages, listMessages } from '../data/api'
import type { ChatMessageRow } from '../data/types'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { useStore } from '../store'

const STORAGE_KEY = 'info-butler.conversation-id'

function newConversationId(): string {
  const random =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`
  return `cv_${random}`
}

export function AskPage() {
  const { notes } = useStore()
  const [conversationId, setConversationId] = useState('')
  const [messages, setMessages] = useState<ChatMessageRow[]>([])
  const [question, setQuestion] = useState('')
  const [streaming, setStreaming] = useState('')
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [loadingHistory, setLoadingHistory] = useState(false)
  const [inFlight, setInFlight] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)
  const [clearing, setClearing] = useState(false)

  const abortRef = useRef<AbortController | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  // 会话 ID 由应用自己生成、保存、恢复和轮换；它不是服务端的历史存储。
  useEffect(() => {
    const existing = window.localStorage.getItem(STORAGE_KEY)
    if (existing) {
      setConversationId(existing)
    } else {
      const created = newConversationId()
      window.localStorage.setItem(STORAGE_KEY, created)
      setConversationId(created)
    }
  }, [])

  useEffect(() => {
    if (!conversationId) return
    let active = true
    setLoadingHistory(true)
    listMessages(conversationId)
      .then((rows) => {
        if (active) setMessages(rows)
      })
      .catch(() => {
        if (active) setMessages([])
      })
      .finally(() => {
        if (active) setLoadingHistory(false)
      })
    return () => {
      active = false
    }
  }, [conversationId])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [messages, streaming])

  async function handleSend() {
    const text = question.trim()
    if (!text || inFlight) return

    const picked = rankNotes(notes, text)
    const refs = picked.map((note, index) => `[${index + 1}] ${note.title}`)

    setError('')
    setQuestion('')
    setMessages((prev) => [
      ...prev,
      {
        id: -Date.now(),
        owner_id: '',
        conversation_id: conversationId,
        role: 'user',
        content: text,
        refs,
        created_at: new Date().toISOString(),
      },
    ])
    void appendMessage({ conversationId, role: 'user', content: text, refs })

    const controller = new AbortController()
    abortRef.current = controller
    setStatus('正在阅读资料…')
    setInFlight(true)
    let answer = ''

    try {
      const messages_ = buildQaMessages(text, picked.map((note, index) => ({
        index: index + 1,
        noteId: note.id,
        title: note.title,
        body: `${note.summary ?? ''}\n${note.content}`.trim().slice(0, 1200),
      })))

      answer = await streamChat({
        messages: messages_,
        signal: controller.signal,
        temperature: 0.4,
        // 没接模型时退回检索：把命中的原文片段列出来，而不是编一个答案。
        offlineFallback: () => answerOffline(text, picked),
        onDelta: (chunk) => {
          setStreaming((prev) => prev + chunk)
          setStatus('正在生成回答…')
        },
      })

      setMessages((prev) => [
        ...prev,
        {
          id: -Date.now() - 1,
          owner_id: '',
          conversation_id: conversationId,
          role: 'assistant',
          content: answer,
          refs,
          created_at: new Date().toISOString(),
        },
      ])
      void appendMessage({ conversationId, role: 'assistant', content: answer, refs })
    } catch (err) {
      const agentError = err as AgentError
      if (agentError?.code) {
        const suffix = agentError.requestId ? `（编号 ${agentError.requestId}）` : ''
        setError(`${agentError.message}${suffix}`)
      } else {
        setError(err instanceof Error ? err.message : '问答失败，请重试。')
      }
    } finally {
      setStreaming('')
      setStatus('')
      setInFlight(false)
      abortRef.current = null
    }
  }

  function handleNewChat() {
    const created = newConversationId()
    window.localStorage.setItem(STORAGE_KEY, created)
    // 旧会话的记录留在本地库里，清空按钮才负责删掉它们。
    setConversationId(created)
    setMessages([])
    setError('')
  }

  async function handleClear() {
    setClearing(true)
    try {
      await clearMessages(conversationId)
      setMessages([])
      setError('')
      setConfirmClear(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : '清空失败，请重试。')
    } finally {
      setClearing(false)
    }
  }

  return (
    <div className="card">
      <div className="card-head">
        <div className="card-title">智能问答</div>
        <div className="card-head-right">
          <span className="small muted">
            {notes.length > 0 ? `基于 ${notes.length} 条资料作答` : '资料库为空'}
          </span>
          <button className="btn small" onClick={handleNewChat}>
            新会话
          </button>
          <button className="btn small" onClick={() => setConfirmClear(true)} disabled={messages.length === 0}>
            清空
          </button>
        </div>
      </div>

      <div className="chat-scroll" ref={scrollRef}>
        {loadingHistory ? <div className="small muted">正在加载会话…</div> : null}

        {!loadingHistory && messages.length === 0 && !streaming ? (
          <div className="empty">
            直接问就行，例如「这周待办里最紧急的是什么」「上次和导师聊了什么」
          </div>
        ) : null}

        {messages.map((message) => (
          <div key={message.id}>
            <div className={`bubble ${message.role}`}>{message.content}</div>
            {message.role === 'user' && message.refs && message.refs.length > 0 ? (
              <div className="refs">
                {message.refs.map((ref, index) => (
                  <span key={index} className="tag">
                    {ref}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        ))}

        {streaming ? <div className="bubble assistant">{streaming}</div> : null}
      </div>

      <div className="card-body">
        {error ? <div className="notice error">{error}</div> : null}
        {status ? <div className="small muted">{status}</div> : null}
        <div className="row" style={{ marginTop: 10 }}>
          <input
            className="input"
            placeholder="向你的资料库提问"
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) void handleSend()
            }}
          />
          {inFlight ? (
            <button className="btn" onClick={() => abortRef.current?.abort()}>
              停止
            </button>
          ) : (
            <button className="btn primary" onClick={() => void handleSend()} disabled={!question.trim()}>
              发送
            </button>
          )}
        </div>

        <ConfirmDialog
          open={confirmClear}
          title="清空会话记录"
          description="这个会话里的全部问答记录会被删除，不可恢复。其他会话不受影响。"
          confirmText="清空"
          danger
          busy={clearing}
          onConfirm={() => void handleClear()}
          onCancel={() => (clearing ? undefined : setConfirmClear(false))}
        />
      </div>
    </div>
  )
}
