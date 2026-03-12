import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { FormEvent } from 'react'
import { io, Socket } from 'socket.io-client'
import './App.css'

type Participant = {
  id: string
  alias: string
  joinedAt: string
  isMuted?: boolean
  isCameraOff?: boolean
}

type ChatMessage = {
  id: string
  text: string
  alias: string
  senderId: string
  createdAt: string
}

type RoomStatePayload = {
  selfId: string
  roomId: string
  participants: Participant[]
}

type SignalPayload = {
  fromId: string
  targetId: string
  description?: RTCSessionDescriptionInit
  candidate?: RTCIceCandidateInit
}

const SIGNALING_URL =
  import.meta.env.VITE_SIGNALING_URL ?? 'http://localhost:3001'

const rtcConfig: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
}

const randomAlias = () =>
  `Ghost-${Math.floor(1000 + Math.random() * 9000)}`

const initialRoom = () => {
  const params = new URLSearchParams(window.location.search)
  return params.get('room') ?? 'lobby'
}

function App() {
  const [alias, setAlias] = useState(randomAlias)
  const [roomId, setRoomId] = useState(initialRoom)
  const [draft, setDraft] = useState('')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [participants, setParticipants] = useState<Participant[]>([])
  const [selfId, setSelfId] = useState('')
  const [activePeerId, setActivePeerId] = useState('')
  const [joined, setJoined] = useState(false)
  const [connectionLabel, setConnectionLabel] = useState('offline')
  const [callLabel, setCallLabel] = useState('Нет активного звонка')
  const [isMuted, setIsMuted] = useState(false)
  const [isCameraOff, setIsCameraOff] = useState(false)

  const socketRef = useRef<Socket | null>(null)
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null)
  const localStreamRef = useRef<MediaStream | null>(null)
  const localVideoRef = useRef<HTMLVideoElement | null>(null)
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null)
  const messagesEndRef = useRef<HTMLDivElement | null>(null)

  const roomLink = useMemo(() => {
    const url = new URL(window.location.href)
    url.searchParams.set('room', roomId)
    return url.toString()
  }, [roomId])

  const remoteParticipants = participants.filter((person) => person.id !== selfId)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  useEffect(() => {
    if (localVideoRef.current && localStreamRef.current) {
      localVideoRef.current.srcObject = localStreamRef.current
    }
  }, [joined, isMuted, isCameraOff])

  const createPeerConnection = (peerId: string) => {
    const peerConnection = new RTCPeerConnection(rtcConfig)

    peerConnection.onicecandidate = (event) => {
      if (!event.candidate || !socketRef.current) {
        return
      }

      socketRef.current.emit('webrtc-ice-candidate', {
        targetId: peerId,
        candidate: event.candidate.toJSON(),
      })
    }

    peerConnection.ontrack = (event) => {
      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = event.streams[0]
      }
    }

    peerConnection.onconnectionstatechange = () => {
      const state = peerConnection.connectionState
      if (state === 'connected') {
        setCallLabel('Звонок подключен')
      }
      if (state === 'disconnected' || state === 'failed' || state === 'closed') {
        setCallLabel('Нет активного звонка')
      }
    }

    peerConnectionRef.current = peerConnection
    setActivePeerId(peerId)

    return peerConnection
  }

  const ensureLocalMedia = async () => {
    if (localStreamRef.current) {
      return localStreamRef.current
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: true,
    })

    localStreamRef.current = stream

    stream.getAudioTracks().forEach((track) => {
      track.enabled = !isMuted
    })

    stream.getVideoTracks().forEach((track) => {
      track.enabled = !isCameraOff
    })

    if (localVideoRef.current) {
      localVideoRef.current.srcObject = stream
    }

    return stream
  }

  function tearDownCall() {
    peerConnectionRef.current?.close()
    peerConnectionRef.current = null
    setActivePeerId('')
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = null
    }

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => track.stop())
      localStreamRef.current = null
    }

    if (localVideoRef.current) {
      localVideoRef.current.srcObject = null
    }

    setCallLabel('Нет активного звонка')
  }

  useEffect(() => {
    return () => {
      tearDownCall()
      socketRef.current?.disconnect()
    }
  }, [])

  const attachSocketListeners = (socket: Socket) => {
    socket.on('connect', () => {
      setConnectionLabel('online')
      socket.emit('join-room', {
        alias,
        roomId,
      })
    })

    socket.on('disconnect', () => {
      setConnectionLabel('offline')
      setParticipants([])
      setSelfId('')
      tearDownCall()
    })

    socket.on('room-state', ({ selfId: socketId, participants }: RoomStatePayload) => {
      setSelfId(socketId)
      setParticipants(participants)
      if (!activePeerId && participants.length > 1) {
        const firstPeer = participants.find((person) => person.id !== socketId)
        if (firstPeer) {
          setActivePeerId(firstPeer.id)
        }
      }
    })

    socket.on('participant-joined', (participant: Participant) => {
      setParticipants((current) => [...current, participant])
    })

    socket.on('participant-left', ({ participantId }: { participantId: string }) => {
      setParticipants((current) => current.filter((person) => person.id !== participantId))
      if (participantId === activePeerId) {
        tearDownCall()
      }
    })

    socket.on('chat-message', (message: ChatMessage) => {
      setMessages((current) => [...current, message])
    })

    socket.on('media-state', (payload: Participant) => {
      setParticipants((current) =>
        current.map((person) =>
          person.id === payload.id
            ? {
                ...person,
                isMuted: payload.isMuted,
                isCameraOff: payload.isCameraOff,
              }
            : person,
        ),
      )
    })

    socket.on('webrtc-offer', async ({ fromId, description }: SignalPayload) => {
      try {
        const stream = await ensureLocalMedia()
        const peerConnection = createPeerConnection(fromId)

        stream.getTracks().forEach((track) => peerConnection.addTrack(track, stream))
        await peerConnection.setRemoteDescription(description!)

        const answer = await peerConnection.createAnswer()
        await peerConnection.setLocalDescription(answer)

        socket.emit('webrtc-answer', {
          targetId: fromId,
          description: answer,
        })

        setCallLabel('Входящий звонок принят')
      } catch (error) {
        console.error(error)
        setCallLabel('Не удалось принять звонок')
      }
    })

    socket.on('webrtc-answer', async ({ description }: SignalPayload) => {
      try {
        if (!peerConnectionRef.current) {
          return
        }

        await peerConnectionRef.current.setRemoteDescription(description!)
        setCallLabel('Звонок подключен')
      } catch (error) {
        console.error(error)
        setCallLabel('Ошибка при подключении ответа')
      }
    })

    socket.on('webrtc-ice-candidate', async ({ candidate }: SignalPayload) => {
      try {
        if (!candidate || !peerConnectionRef.current) {
          return
        }

        await peerConnectionRef.current.addIceCandidate(candidate)
      } catch (error) {
        console.error(error)
      }
    })
  }

  const connectRoom = async (event: FormEvent) => {
    event.preventDefault()

    const trimmedAlias = alias.trim() || randomAlias()
    const trimmedRoom = roomId.trim() || 'lobby'

    setAlias(trimmedAlias)
    setRoomId(trimmedRoom)
    setJoined(true)

    if (socketRef.current) {
      socketRef.current.disconnect()
    }

    const socket = io(SIGNALING_URL, {
      transports: ['websocket'],
    })

    socketRef.current = socket
    setMessages([])
    attachSocketListeners(socket)
  }

  const sendMessage = (event: FormEvent) => {
    event.preventDefault()
    const text = draft.trim()
    if (!text || !socketRef.current) {
      return
    }

    socketRef.current.emit('chat-message', { text })
    setDraft('')
  }

  const startCall = async () => {
    if (!socketRef.current || !activePeerId) {
      setCallLabel('Выберите собеседника в комнате')
      return
    }

    try {
      const stream = await ensureLocalMedia()
      const peerConnection = createPeerConnection(activePeerId)

      stream.getTracks().forEach((track) => peerConnection.addTrack(track, stream))

      const offer = await peerConnection.createOffer()
      await peerConnection.setLocalDescription(offer)

      socketRef.current.emit('webrtc-offer', {
        targetId: activePeerId,
        description: offer,
      })

      setCallLabel('Исходящий звонок...')
    } catch (error) {
      console.error(error)
      setCallLabel('Нет доступа к камере или микрофону')
    }
  }

  const toggleAudio = () => {
    const nextMuted = !isMuted
    setIsMuted(nextMuted)

    localStreamRef.current?.getAudioTracks().forEach((track) => {
      track.enabled = !nextMuted
    })

    socketRef.current?.emit('media-state', {
      isMuted: nextMuted,
      isCameraOff,
    })
  }

  const toggleVideo = () => {
    const nextCameraOff = !isCameraOff
    setIsCameraOff(nextCameraOff)

    localStreamRef.current?.getVideoTracks().forEach((track) => {
      track.enabled = !nextCameraOff
    })

    socketRef.current?.emit('media-state', {
      isMuted,
      isCameraOff: nextCameraOff,
    })
  }

  return (
    <main className="shell">
      <section className="hero">
        <div>
          <p className="eyebrow">ANONYMOUS MESSENGER</p>
          <h1>Комнаты без регистрации, чат и звонки в одном окне.</h1>
          <p className="subtitle">
            Открыл ссылку, выбрал псевдоним, зашёл в комнату и общаешься.
            История не хранится, аккаунт не нужен.
          </p>
        </div>
        <div className="status-card">
          <span>Сигналинг</span>
          <strong>{connectionLabel}</strong>
          <span>Комната</span>
          <strong>{roomId}</strong>
          <span>Звонок</span>
          <strong>{callLabel}</strong>
        </div>
      </section>

      <section className="panel auth-panel">
        <form className="join-form" onSubmit={connectRoom}>
          <label>
            Псевдоним
            <input
              value={alias}
              onChange={(event) => setAlias(event.target.value)}
              placeholder="Ghost-2048"
            />
          </label>
          <label>
            Комната
            <input
              value={roomId}
              onChange={(event) => setRoomId(event.target.value)}
              placeholder="lobby"
            />
          </label>
          <button type="submit">{joined ? 'Переподключиться' : 'Войти в комнату'}</button>
        </form>
        <div className="share-box">
          <span>Ссылка-приглашение</span>
          <code>{roomLink}</code>
        </div>
      </section>

      <section className="dashboard">
        <article className="panel video-panel">
          <div className="panel-head">
            <h2>Звонок</h2>
            <p>Для видео/аудио в комнате нужен второй участник.</p>
          </div>
          <div className="video-grid">
            <div className="video-card">
              <video ref={localVideoRef} autoPlay muted playsInline />
              <span>Вы</span>
            </div>
            <div className="video-card">
              <video ref={remoteVideoRef} autoPlay playsInline />
              <span>
                {participants.find((person) => person.id === activePeerId)?.alias ??
                  'Собеседник'}
              </span>
            </div>
          </div>
          <div className="call-controls">
            <button onClick={startCall} type="button">
              Начать звонок
            </button>
            <button onClick={toggleAudio} type="button" className="secondary">
              {isMuted ? 'Включить микрофон' : 'Выключить микрофон'}
            </button>
            <button onClick={toggleVideo} type="button" className="secondary">
              {isCameraOff ? 'Включить камеру' : 'Выключить камеру'}
            </button>
            <button onClick={tearDownCall} type="button" className="danger">
              Завершить
            </button>
          </div>
        </article>

        <article className="panel chat-panel">
          <div className="panel-head">
            <h2>Переписка</h2>
            <p>Сообщения живут только пока открыта комната.</p>
          </div>
          <div className="messages">
            {messages.length === 0 ? (
              <div className="empty-state">Пока пусто. Напишите первое сообщение.</div>
            ) : (
              messages.map((message) => (
                <div
                  key={message.id}
                  className={
                    message.senderId === selfId ? 'message message-self' : 'message'
                  }
                >
                  <strong>{message.alias}</strong>
                  <p>{message.text}</p>
                  <span>{new Date(message.createdAt).toLocaleTimeString()}</span>
                </div>
              ))
            )}
            <div ref={messagesEndRef} />
          </div>
          <form className="message-form" onSubmit={sendMessage}>
            <input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Напиши сообщение"
            />
            <button type="submit">Отправить</button>
          </form>
        </article>

        <article className="panel sidebar-panel">
          <div className="panel-head">
            <h2>Участники</h2>
            <p>{participants.length} в комнате</p>
          </div>
          <div className="participants">
            {participants.map((person) => (
              <button
                key={person.id}
                type="button"
                className={
                  person.id === activePeerId ? 'participant active' : 'participant'
                }
                onClick={() => setActivePeerId(person.id)}
                disabled={person.id === selfId}
              >
                <strong>{person.alias}</strong>
                <span>
                  {person.id === selfId
                    ? 'это вы'
                    : `${person.isMuted ? 'mic off' : 'mic on'} / ${
                        person.isCameraOff ? 'cam off' : 'cam on'
                      }`}
                </span>
              </button>
            ))}
            {remoteParticipants.length === 0 && (
              <div className="empty-state">
                Поделитесь ссылкой комнаты, чтобы кто-то подключился.
              </div>
            )}
          </div>
        </article>
      </section>
    </main>
  )
}

export default App
