import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { io, type Socket } from 'socket.io-client'
import './App.css'

type Profile = {
  id: string
  displayName: string
  userCode: string
}

type ConversationMember = {
  id: string
  displayName: string
  userCode: string
  lastSeenAt: string
}

type Conversation = {
  id: string
  type: 'direct' | 'group'
  title: string
  rawTitle: string
  inviteCode: string
  memberIds: string[]
  members: ConversationMember[]
  createdAt: string
  updatedAt: string
  lastMessagePreview: string
  lastMessageAt: string
}

type Message = {
  id: string
  conversationId: string
  senderId: string
  alias: string
  text: string
  encrypted?: boolean
  iv?: string
  createdAt: string
  cipherText?: string
  decryptionFailed?: boolean
}

const API_URL = import.meta.env.VITE_SIGNALING_URL ?? 'http://localhost:3001'
const PROFILE_ID_KEY = 'anonmess-profile-id'
const SECRET_KEYS_KEY = 'anonmess-secret-keys'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const request = async <T,>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(`${API_URL}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
    ...init,
  })

  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: 'REQUEST_FAILED' }))
    throw new Error(payload.error ?? 'REQUEST_FAILED')
  }

  return response.json() as Promise<T>
}

const bytesToBase64 = (bytes: Uint8Array) => {
  let binary = ''
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte)
  })
  return btoa(binary)
}

const base64ToBytes = (value: string) =>
  Uint8Array.from(atob(value), (char) => char.charCodeAt(0))

function App() {
  const [profile, setProfile] = useState<Profile | null>(null)
  const [displayName, setDisplayName] = useState('')
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeConversationId, setActiveConversationId] = useState('')
  const [messages, setMessages] = useState<Message[]>([])
  const [draft, setDraft] = useState('')
  const [status, setStatus] = useState('Connecting...')
  const [directUserCode, setDirectUserCode] = useState('')
  const [groupTitle, setGroupTitle] = useState('')
  const [groupMembers, setGroupMembers] = useState('')
  const [inviteCode, setInviteCode] = useState('')
  const [conversationSecrets, setConversationSecrets] = useState<Record<string, string>>(() => {
    const saved = localStorage.getItem(SECRET_KEYS_KEY)
    if (!saved) {
      return {}
    }

    try {
      return JSON.parse(saved) as Record<string, string>
    } catch {
      return {}
    }
  })

  const socketRef = useRef<Socket | null>(null)
  const messagesEndRef = useRef<HTMLDivElement | null>(null)
  const rawMessagesRef = useRef<Record<string, Message[]>>({})
  const keyCacheRef = useRef(new Map<string, CryptoKey>())
  const activeConversationIdRef = useRef('')

  const activeConversation = useMemo(
    () => conversations.find((conversation) => conversation.id === activeConversationId) ?? null,
    [activeConversationId, conversations],
  )

  const activeSecret = activeConversationId ? conversationSecrets[activeConversationId] ?? '' : ''

  useEffect(() => {
    activeConversationIdRef.current = activeConversationId
  }, [activeConversationId])

  useEffect(() => {
    localStorage.setItem(SECRET_KEYS_KEY, JSON.stringify(conversationSecrets))
  }, [conversationSecrets])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  useEffect(() => {
    const storedProfileId = localStorage.getItem(PROFILE_ID_KEY)
    if (!storedProfileId) {
      setStatus('Create your profile to start messaging')
      return
    }

    void bootstrap(storedProfileId)
  }, [])

  useEffect(() => {
    if (!profile) {
      return
    }

    const socket = io(API_URL, {
      transports: ['websocket'],
    })

    socketRef.current = socket

    socket.on('connect', () => {
      setStatus('Online')
      socket.emit('authenticate', { profileId: profile.id })
      socket.emit('join-conversations', {
        conversationIds: conversations.map((conversation) => conversation.id),
      })
    })

    socket.on('disconnect', () => {
      setStatus('Offline')
    })

    socket.on('conversation-updated', ({ conversation }: { conversation: Conversation }) => {
      setConversations((current) => {
        const next = current.some((item) => item.id === conversation.id)
          ? current.map((item) => (item.id === conversation.id ? conversation : item))
          : [conversation, ...current]

        return [...next].sort((left, right) =>
          right.lastMessageAt.localeCompare(left.lastMessageAt),
        )
      })

      socket.emit('join-conversations', {
        conversationIds: [conversation.id],
      })

      setActiveConversationId((current) => current || conversation.id)
    })

    socket.on(
      'message-created',
      async ({
        conversationId,
        message,
      }: {
        conversationId: string
        message: Message
      }) => {
        rawMessagesRef.current[conversationId] = [
          ...(rawMessagesRef.current[conversationId] ?? []),
          message,
        ]

        if (conversationId === activeConversationIdRef.current) {
          const resolved = await decryptMessage(conversationId, message)
          setMessages((current) => [...current, resolved])
        }
      },
    )

    return () => {
      socket.disconnect()
    }
  }, [profile])

  useEffect(() => {
    if (!socketRef.current || conversations.length === 0) {
      return
    }

    socketRef.current.emit('join-conversations', {
      conversationIds: conversations.map((conversation) => conversation.id),
    })
  }, [conversations])

  useEffect(() => {
    if (!profile || !activeConversationId) {
      return
    }

    void loadMessages(activeConversationId)
  }, [profile, activeConversationId])

  useEffect(() => {
    if (!activeConversationId) {
      return
    }

    const rawMessages = rawMessagesRef.current[activeConversationId] ?? []
    void Promise.all(
      rawMessages.map((message) => decryptMessage(activeConversationId, message)),
    ).then((nextMessages) => {
      setMessages(nextMessages)
    })
  }, [activeConversationId, activeSecret])

  const deriveConversationKey = async (conversationId: string) => {
    const secret = conversationSecrets[conversationId]?.trim()
    if (!secret) {
      return null
    }

    const cacheKey = `${conversationId}:${secret}`
    const cached = keyCacheRef.current.get(cacheKey)
    if (cached) {
      return cached
    }

    const baseKey = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      'PBKDF2',
      false,
      ['deriveKey'],
    )

    const derived = await crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        hash: 'SHA-256',
        salt: encoder.encode(`anonmess:${conversationId}`),
        iterations: 120000,
      },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    )

    keyCacheRef.current.set(cacheKey, derived)
    return derived
  }

  const encryptMessage = async (conversationId: string, plainText: string) => {
    const key = await deriveConversationKey(conversationId)
    if (!key) {
      return {
        text: plainText,
        encrypted: false,
        iv: undefined,
      }
    }

    const iv = crypto.getRandomValues(new Uint8Array(12))
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      encoder.encode(plainText),
    )

    return {
      text: bytesToBase64(new Uint8Array(encrypted)),
      encrypted: true,
      iv: bytesToBase64(iv),
    }
  }

  const decryptMessage = async (conversationId: string, message: Message) => {
    if (!message.encrypted || !message.iv) {
      return message
    }

    const cipherText = message.cipherText ?? message.text
    const key = await deriveConversationKey(conversationId)

    if (!key) {
      return {
        ...message,
        cipherText,
        text: 'Encrypted message. Enter the chat key to unlock it.',
        decryptionFailed: true,
      }
    }

    try {
      const decrypted = await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: base64ToBytes(message.iv),
        },
        key,
        base64ToBytes(cipherText),
      )

      return {
        ...message,
        cipherText,
        text: decoder.decode(decrypted),
        decryptionFailed: false,
      }
    } catch {
      return {
        ...message,
        cipherText,
        text: 'Encrypted message. Wrong chat key.',
        decryptionFailed: true,
      }
    }
  }

  const bootstrap = async (profileId: string) => {
    try {
      const payload = await request<{
        profile: Profile
        conversations: Conversation[]
      }>(`/api/bootstrap/${profileId}`)

      setProfile(payload.profile)
      setDisplayName(payload.profile.displayName)
      setConversations(payload.conversations)
      setActiveConversationId((current) => current || (payload.conversations[0]?.id ?? ''))
      setStatus('Online')
    } catch {
      localStorage.removeItem(PROFILE_ID_KEY)
      setStatus('Create your profile to start messaging')
    }
  }

  const loadMessages = async (conversationId: string) => {
    if (!profile) {
      return
    }

    const payload = await request<{ messages: Message[] }>(
      `/api/conversations/${conversationId}/messages?profileId=${profile.id}`,
    )

    rawMessagesRef.current[conversationId] = payload.messages
    const resolved = await Promise.all(
      payload.messages.map((message) => decryptMessage(conversationId, message)),
    )
    setMessages(resolved)
  }

  const createProfile = async (event: FormEvent) => {
    event.preventDefault()

    const payload = await request<{ profile: Profile }>('/api/profiles/register', {
      method: 'POST',
      body: JSON.stringify({
        displayName,
        profileId: localStorage.getItem(PROFILE_ID_KEY),
      }),
    })

    localStorage.setItem(PROFILE_ID_KEY, payload.profile.id)
    await bootstrap(payload.profile.id)
  }

  const createDirectChat = async (event: FormEvent) => {
    event.preventDefault()
    if (!profile) {
      return
    }

    const payload = await request<{ conversation: Conversation }>('/api/conversations/direct', {
      method: 'POST',
      body: JSON.stringify({
        profileId: profile.id,
        targetUserCode: directUserCode,
      }),
    })

    setDirectUserCode('')
    setActiveConversationId(payload.conversation.id)
    await bootstrap(profile.id)
  }

  const createGroup = async (event: FormEvent) => {
    event.preventDefault()
    if (!profile) {
      return
    }

    const payload = await request<{ conversation: Conversation }>('/api/conversations/group', {
      method: 'POST',
      body: JSON.stringify({
        profileId: profile.id,
        title: groupTitle,
        memberCodes: groupMembers
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean),
      }),
    })

    setGroupTitle('')
    setGroupMembers('')
    setActiveConversationId(payload.conversation.id)
    await bootstrap(profile.id)
  }

  const joinGroup = async (event: FormEvent) => {
    event.preventDefault()
    if (!profile) {
      return
    }

    const payload = await request<{ conversation: Conversation }>('/api/conversations/join', {
      method: 'POST',
      body: JSON.stringify({
        profileId: profile.id,
        inviteCode,
      }),
    })

    setInviteCode('')
    setActiveConversationId(payload.conversation.id)
    await bootstrap(profile.id)
  }

  const sendMessage = async (event: FormEvent) => {
    event.preventDefault()
    if (!profile || !activeConversationId || !draft.trim()) {
      return
    }

    const encryptedPayload = await encryptMessage(activeConversationId, draft.trim())
    await request<{ message: Message }>(`/api/conversations/${activeConversationId}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        profileId: profile.id,
        ...encryptedPayload,
      }),
    })

    setDraft('')
  }

  const activeConversationTitle = activeConversation?.title ?? 'Select a chat'

  if (!profile) {
    return (
      <main className="onboarding-shell">
        <section className="onboarding-card">
          <p className="eyebrow">ANONMESS REBUILD</p>
          <h1>Real chats instead of room links.</h1>
          <p className="subtitle">
            Create a device profile, share your user code, start direct chats,
            build groups, and keep conversation history.
          </p>
          <form className="onboarding-form" onSubmit={(event) => void createProfile(event)}>
            <label>
              Your display name
              <input
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                placeholder="Misha"
              />
            </label>
            <button type="submit">Enter messenger</button>
          </form>
          <p className="helper-text">{status}</p>
        </section>
      </main>
    )
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <section className="profile-card">
          <p className="eyebrow">PROFILE</p>
          <h2>{profile.displayName}</h2>
          <span className="status-pill">{status}</span>
          <div className="profile-meta">
            <span>Your code</span>
            <strong>{profile.userCode}</strong>
          </div>
          <p className="helper-text">
            Share this code to start private 1:1 chats. It works better than
            open room links.
          </p>
        </section>

        <section className="panel-block">
          <h3>New direct chat</h3>
          <form className="compact-form" onSubmit={(event) => void createDirectChat(event)}>
            <input
              value={directUserCode}
              onChange={(event) => setDirectUserCode(event.target.value.toUpperCase())}
              placeholder="AM-ABC123"
            />
            <button type="submit">Start</button>
          </form>
        </section>

        <section className="panel-block">
          <h3>New group</h3>
          <form className="stack-form" onSubmit={(event) => void createGroup(event)}>
            <input
              value={groupTitle}
              onChange={(event) => setGroupTitle(event.target.value)}
              placeholder="Family"
            />
            <input
              value={groupMembers}
              onChange={(event) => setGroupMembers(event.target.value.toUpperCase())}
              placeholder="AM-AAA111, AM-BBB222"
            />
            <button type="submit">Create group</button>
          </form>
        </section>

        <section className="panel-block">
          <h3>Join group</h3>
          <form className="compact-form" onSubmit={(event) => void joinGroup(event)}>
            <input
              value={inviteCode}
              onChange={(event) => setInviteCode(event.target.value.toUpperCase())}
              placeholder="AB12CD"
            />
            <button type="submit">Join</button>
          </form>
        </section>

        <section className="chat-list">
          <div className="chat-list-head">
            <h3>Chats</h3>
            <span>{conversations.length}</span>
          </div>
          {conversations.length === 0 ? (
            <div className="empty-state">No chats yet. Start a direct chat or create a group.</div>
          ) : (
            conversations.map((conversation) => (
              <button
                key={conversation.id}
                type="button"
                className={
                  conversation.id === activeConversationId ? 'chat-tile active' : 'chat-tile'
                }
                onClick={() => setActiveConversationId(conversation.id)}
              >
                <strong>{conversation.title}</strong>
                <span>{conversation.lastMessagePreview || 'No messages yet'}</span>
              </button>
            ))
          )}
        </section>
      </aside>

      <section className="conversation-panel">
        {activeConversation ? (
          <>
            <header className="conversation-head">
              <div>
                <p className="eyebrow">{activeConversation.type === 'group' ? 'GROUP' : 'DIRECT'}</p>
                <h1>{activeConversationTitle}</h1>
                <p className="helper-text">
                  {activeConversation.members.map((member) => member.displayName).join(', ')}
                </p>
              </div>
              <div className="conversation-tools">
                {activeConversation.type === 'group' && (
                  <div className="tool-box">
                    <span>Invite code</span>
                    <strong>{activeConversation.inviteCode}</strong>
                  </div>
                )}
                <label className="tool-box">
                  <span>Chat key</span>
                  <input
                    value={activeSecret}
                    onChange={(event) =>
                      setConversationSecrets((current) => ({
                        ...current,
                        [activeConversation.id]: event.target.value,
                      }))
                    }
                    placeholder="Optional encryption key"
                  />
                </label>
              </div>
            </header>

            <div className="message-stream">
              {messages.length === 0 ? (
                <div className="empty-state">
                  No messages yet. This chat already keeps history and supports an optional local chat key.
                </div>
              ) : (
                messages.map((message) => (
                  <article
                    key={message.id}
                    className={message.senderId === profile.id ? 'message self' : 'message'}
                  >
                    <strong>{message.alias}</strong>
                    <p>{message.text}</p>
                    <span>
                      {new Date(message.createdAt).toLocaleTimeString()}
                      {message.encrypted ? ' • encrypted' : ''}
                      {message.decryptionFailed ? ' • locked' : ''}
                    </span>
                  </article>
                ))
              )}
              <div ref={messagesEndRef} />
            </div>

            <form className="composer" onSubmit={(event) => void sendMessage(event)}>
              <input
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="Write a message"
              />
              <button type="submit">Send</button>
            </form>
          </>
        ) : (
          <section className="empty-conversation">
            <p className="eyebrow">MESSENGER</p>
            <h1>Select or create a chat</h1>
            <p className="subtitle">
              This rebuild already supports device identities, direct chats,
              groups, history, invite codes, and optional client-side message
              encryption.
            </p>
          </section>
        )}
      </section>
    </main>
  )
}

export default App
