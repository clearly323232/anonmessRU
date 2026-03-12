import cors from 'cors'
import express from 'express'
import { createServer } from 'node:http'
import { Server } from 'socket.io'

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

app.get('/health', (_request, response) => {
  response.json({ ok: true })
})

const rooms = new Map()
const participantsBySocket = new Map()

const createParticipant = (socket, alias, roomId) => ({
  id: socket.id,
  alias,
  roomId,
  joinedAt: new Date().toISOString(),
  isMuted: false,
  isCameraOff: false,
})

io.on('connection', (socket) => {
  socket.on('join-room', ({ alias, roomId }) => {
    const safeAlias = String(alias ?? 'Ghost').slice(0, 32)
    const safeRoomId = String(roomId ?? 'lobby').slice(0, 64)

    socket.join(safeRoomId)

    const participant = createParticipant(socket, safeAlias, safeRoomId)
    participantsBySocket.set(socket.id, participant)

    const roomParticipants = rooms.get(safeRoomId) ?? new Map()
    roomParticipants.set(socket.id, participant)
    rooms.set(safeRoomId, roomParticipants)

    socket.emit('room-state', {
      selfId: socket.id,
      roomId: safeRoomId,
      participants: Array.from(roomParticipants.values()),
    })

    socket.to(safeRoomId).emit('participant-joined', participant)
  })

  socket.on('chat-message', ({ text }) => {
    const participant = participantsBySocket.get(socket.id)
    if (!participant) {
      return
    }

    const message = {
      id: crypto.randomUUID(),
      text: String(text ?? '').slice(0, 5000),
      alias: participant.alias,
      senderId: socket.id,
      createdAt: new Date().toISOString(),
    }

    io.to(participant.roomId).emit('chat-message', message)
  })

  socket.on('media-state', ({ isMuted, isCameraOff }) => {
    const participant = participantsBySocket.get(socket.id)
    if (!participant) {
      return
    }

    participant.isMuted = Boolean(isMuted)
    participant.isCameraOff = Boolean(isCameraOff)

    io.to(participant.roomId).emit('media-state', participant)
  })

  socket.on('webrtc-offer', ({ targetId, description }) => {
    io.to(targetId).emit('webrtc-offer', {
      fromId: socket.id,
      targetId,
      description,
    })
  })

  socket.on('webrtc-answer', ({ targetId, description }) => {
    io.to(targetId).emit('webrtc-answer', {
      fromId: socket.id,
      targetId,
      description,
    })
  })

  socket.on('webrtc-ice-candidate', ({ targetId, candidate }) => {
    io.to(targetId).emit('webrtc-ice-candidate', {
      fromId: socket.id,
      targetId,
      candidate,
    })
  })

  socket.on('disconnect', () => {
    const participant = participantsBySocket.get(socket.id)
    if (!participant) {
      return
    }

    participantsBySocket.delete(socket.id)

    const roomParticipants = rooms.get(participant.roomId)
    roomParticipants?.delete(socket.id)

    if (roomParticipants && roomParticipants.size === 0) {
      rooms.delete(participant.roomId)
    }

    socket.to(participant.roomId).emit('participant-left', {
      participantId: socket.id,
    })
  })
})

httpServer.listen(port, () => {
  console.log(`Signaling server listening on ${port}`)
})
