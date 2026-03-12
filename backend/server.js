import cors from 'cors'
import express from 'express'
import { createServer } from 'node:http'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Server } from 'socket.io'

const __dirname = dirname(fileURLToPath(import.meta.url))
const dataDirectory = join(__dirname, 'data')
const dataFile = join(dataDirectory, 'store.json')

mkdirSync(dataDirectory, { recursive: true })

const createInitialStore = () => ({
  profiles: {},
  conversations: {},
  messages: {},
})

if (!existsSync(dataFile)) {
  writeFileSync(dataFile, JSON.stringify(createInitialStore(), null, 2))
}

const readStore = () => {
  try {
    const parsed = JSON.parse(readFileSync(dataFile, 'utf8'))
    return {
      profiles: parsed.profiles ?? {},
      conversations: parsed.conversations ?? {},
      messages: parsed.messages ?? {},
    }
  } catch {
    return createInitialStore()
  }
}

let store = readStore()

const persistStore = () => {
  writeFileSync(dataFile, JSON.stringify(store, null, 2))
}

const app = express()
const httpServer = createServer(app)

const clientOrigin = process.env.CLIENT_ORIGIN?.split(',').map((value) => value.trim())
const port = Number(process.env.PORT ?? 3001)

const io = new Server(httpServer, {
  cors: {
    origin: clientOrigin?.length ? clientOrigin : '*',
    methods: ['GET', 'POST'],
  },
})

app.use(
  cors({
    origin: clientOrigin?.length ? clientOrigin : '*',
  }),
)
app.use(express.json({ limit: '1mb' }))

const getProfile = (profileId) => store.profiles[profileId] ?? null
const getConversation = (conversationId) => store.conversations[conversationId] ?? null
const getMessages = (conversationId) => store.messages[conversationId] ?? []

const safeText = (value, fallback, maxLength) =>
  String(value ?? fallback).trim().slice(0, maxLength) || fallback

const generateInviteCode = () =>
  Math.random().toString(36).slice(2, 8).toUpperCase()

const generateUserCode = () =>
  `AM-${Math.random().toString(36).slice(2, 8).toUpperCase()}`

const summarizeMessage = (message) => {
  if (!message) {
    return ''
  }

  if (message.encrypted) {
    return 'Encrypted message'
  }

  return message.text.slice(0, 80)
}

const serializeConversationFor = (conversation, profileId) => {
  const members = conversation.memberIds
    .map((memberId) => getProfile(memberId))
    .filter(Boolean)
    .map((profile) => ({
      id: profile.id,
      displayName: profile.displayName,
      userCode: profile.userCode,
      lastSeenAt: profile.lastSeenAt,
    }))

  return {
    id: conversation.id,
    type: conversation.type,
    title:
      conversation.type === 'direct'
        ? members.find((member) => member.id !== profileId)?.displayName ?? 'Direct chat'
        : conversation.title,
    rawTitle: conversation.title,
    inviteCode: conversation.inviteCode,
    memberIds: conversation.memberIds,
    members,
    createdBy: conversation.createdBy,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    lastMessagePreview: conversation.lastMessagePreview ?? '',
    lastMessageAt: conversation.lastMessageAt ?? conversation.updatedAt,
  }
}

const requireProfile = (profileId) => {
  const profile = getProfile(profileId)
  if (!profile) {
    return null
  }

  profile.lastSeenAt = new Date().toISOString()
  persistStore()
  return profile
}

const profileConversationIds = (profileId) =>
  Object.values(store.conversations)
    .filter((conversation) => conversation.memberIds.includes(profileId))
    .sort((left, right) => {
      const leftTime = left.lastMessageAt ?? left.updatedAt
      const rightTime = right.lastMessageAt ?? right.updatedAt
      return rightTime.localeCompare(leftTime)
    })
    .map((conversation) => conversation.id)

const emitConversationToMembers = (conversationId) => {
  const conversation = getConversation(conversationId)
  if (!conversation) {
    return
  }

  conversation.memberIds.forEach((memberId) => {
    io.to(`profile:${memberId}`).emit('conversation-updated', {
      conversation: serializeConversationFor(conversation, memberId),
    })
  })
}

const emitMessageToConversation = (conversationId, message) => {
  io.to(`conversation:${conversationId}`).emit('message-created', {
    conversationId,
    message,
  })
}

app.get('/health', (_request, response) => {
  response.json({ ok: true })
})

app.post('/api/profiles/register', (request, response) => {
  const displayName = safeText(request.body.displayName, 'Anonymous', 40)
  const requestedId = request.body.profileId ? String(request.body.profileId) : null
  const profileId = requestedId && getProfile(requestedId) ? requestedId : crypto.randomUUID()

  const existingProfile = getProfile(profileId)
  const userCode = existingProfile?.userCode ?? generateUserCode()

  store.profiles[profileId] = {
    id: profileId,
    displayName,
    userCode,
    createdAt: existingProfile?.createdAt ?? new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
  }

  persistStore()
  response.json({ profile: store.profiles[profileId] })
})

app.get('/api/bootstrap/:profileId', (request, response) => {
  const profile = requireProfile(request.params.profileId)
  if (!profile) {
    response.status(404).json({ error: 'PROFILE_NOT_FOUND' })
    return
  }

  const conversations = profileConversationIds(profile.id)
    .map((conversationId) => getConversation(conversationId))
    .filter(Boolean)
    .map((conversation) => serializeConversationFor(conversation, profile.id))

  response.json({
    profile,
    conversations,
  })
})

app.get('/api/profiles/lookup/:userCode', (request, response) => {
  const normalizedCode = String(request.params.userCode ?? '').trim().toUpperCase()
  const profile = Object.values(store.profiles).find(
    (item) => item.userCode.toUpperCase() === normalizedCode,
  )

  if (!profile) {
    response.status(404).json({ error: 'PROFILE_NOT_FOUND' })
    return
  }

  response.json({
    profile: {
      id: profile.id,
      displayName: profile.displayName,
      userCode: profile.userCode,
    },
  })
})

app.post('/api/conversations/direct', (request, response) => {
  const profile = requireProfile(request.body.profileId)
  if (!profile) {
    response.status(404).json({ error: 'PROFILE_NOT_FOUND' })
    return
  }

  const targetUserCode = String(request.body.targetUserCode ?? '').trim().toUpperCase()
  const targetProfile = Object.values(store.profiles).find(
    (item) => item.userCode.toUpperCase() === targetUserCode,
  )

  if (!targetProfile) {
    response.status(404).json({ error: 'TARGET_NOT_FOUND' })
    return
  }

  if (targetProfile.id === profile.id) {
    response.status(400).json({ error: 'SELF_CHAT_NOT_ALLOWED' })
    return
  }

  const existingConversation = Object.values(store.conversations).find(
    (conversation) =>
      conversation.type === 'direct' &&
      conversation.memberIds.length === 2 &&
      conversation.memberIds.includes(profile.id) &&
      conversation.memberIds.includes(targetProfile.id),
  )

  if (existingConversation) {
    response.json({
      conversation: serializeConversationFor(existingConversation, profile.id),
    })
    return
  }

  const conversationId = crypto.randomUUID()
  const now = new Date().toISOString()

  store.conversations[conversationId] = {
    id: conversationId,
    type: 'direct',
    title: '',
    inviteCode: '',
    memberIds: [profile.id, targetProfile.id],
    createdBy: profile.id,
    createdAt: now,
    updatedAt: now,
    lastMessagePreview: '',
    lastMessageAt: now,
  }
  store.messages[conversationId] = []

  persistStore()
  emitConversationToMembers(conversationId)

  response.json({
    conversation: serializeConversationFor(store.conversations[conversationId], profile.id),
  })
})

app.post('/api/conversations/group', (request, response) => {
  const profile = requireProfile(request.body.profileId)
  if (!profile) {
    response.status(404).json({ error: 'PROFILE_NOT_FOUND' })
    return
  }

  const title = safeText(request.body.title, 'New group', 60)
  const memberCodes = Array.isArray(request.body.memberCodes)
    ? request.body.memberCodes.map((value) => String(value).trim().toUpperCase()).filter(Boolean)
    : []

  const memberIds = new Set([profile.id])
  memberCodes.forEach((code) => {
    const member = Object.values(store.profiles).find(
      (item) => item.userCode.toUpperCase() === code,
    )
    if (member) {
      memberIds.add(member.id)
    }
  })

  const conversationId = crypto.randomUUID()
  const now = new Date().toISOString()

  store.conversations[conversationId] = {
    id: conversationId,
    type: 'group',
    title,
    inviteCode: generateInviteCode(),
    memberIds: Array.from(memberIds),
    createdBy: profile.id,
    createdAt: now,
    updatedAt: now,
    lastMessagePreview: '',
    lastMessageAt: now,
  }
  store.messages[conversationId] = []

  persistStore()
  emitConversationToMembers(conversationId)

  response.json({
    conversation: serializeConversationFor(store.conversations[conversationId], profile.id),
  })
})

app.post('/api/conversations/join', (request, response) => {
  const profile = requireProfile(request.body.profileId)
  if (!profile) {
    response.status(404).json({ error: 'PROFILE_NOT_FOUND' })
    return
  }

  const inviteCode = String(request.body.inviteCode ?? '').trim().toUpperCase()
  const conversation = Object.values(store.conversations).find(
    (item) => item.type === 'group' && item.inviteCode === inviteCode,
  )

  if (!conversation) {
    response.status(404).json({ error: 'INVITE_NOT_FOUND' })
    return
  }

  if (!conversation.memberIds.includes(profile.id)) {
    conversation.memberIds.push(profile.id)
    conversation.updatedAt = new Date().toISOString()
    persistStore()
    emitConversationToMembers(conversation.id)
  }

  response.json({
    conversation: serializeConversationFor(conversation, profile.id),
  })
})

app.get('/api/conversations/:conversationId/messages', (request, response) => {
  const profileId = String(request.query.profileId ?? '')
  const profile = requireProfile(profileId)
  const conversation = getConversation(request.params.conversationId)

  if (!profile || !conversation || !conversation.memberIds.includes(profile.id)) {
    response.status(404).json({ error: 'CONVERSATION_NOT_FOUND' })
    return
  }

  response.json({
    messages: getMessages(conversation.id),
  })
})

app.post('/api/conversations/:conversationId/messages', (request, response) => {
  const profile = requireProfile(request.body.profileId)
  const conversation = getConversation(request.params.conversationId)

  if (!profile || !conversation || !conversation.memberIds.includes(profile.id)) {
    response.status(404).json({ error: 'CONVERSATION_NOT_FOUND' })
    return
  }

  const text = String(request.body.text ?? '').slice(0, 5000)
  if (!text.trim()) {
    response.status(400).json({ error: 'EMPTY_MESSAGE' })
    return
  }

  const message = {
    id: crypto.randomUUID(),
    conversationId: conversation.id,
    senderId: profile.id,
    alias: profile.displayName,
    text,
    encrypted: Boolean(request.body.encrypted),
    iv: request.body.iv ? String(request.body.iv).slice(0, 512) : undefined,
    createdAt: new Date().toISOString(),
  }

  store.messages[conversation.id] ??= []
  store.messages[conversation.id].push(message)
  conversation.updatedAt = message.createdAt
  conversation.lastMessageAt = message.createdAt
  conversation.lastMessagePreview = summarizeMessage(message)

  persistStore()
  emitConversationToMembers(conversation.id)
  emitMessageToConversation(conversation.id, message)

  response.json({ message })
})

io.on('connection', (socket) => {
  socket.on('authenticate', ({ profileId }) => {
    const profile = getProfile(String(profileId ?? ''))
    if (!profile) {
      socket.emit('auth-error', { error: 'PROFILE_NOT_FOUND' })
      return
    }

    socket.data.profileId = profile.id
    socket.join(`profile:${profile.id}`)
  })

  socket.on('join-conversations', ({ conversationIds }) => {
    if (!socket.data.profileId || !Array.isArray(conversationIds)) {
      return
    }

    conversationIds.forEach((conversationId) => {
      const conversation = getConversation(String(conversationId))
      if (conversation?.memberIds.includes(socket.data.profileId)) {
        socket.join(`conversation:${conversation.id}`)
      }
    })
  })
})

httpServer.listen(port, () => {
  console.log(`Messenger API listening on ${port}`)
})
