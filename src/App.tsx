import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { io, type Socket } from 'socket.io-client'
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
  encrypted?: boolean
  iv?: string
  cipherText?: string
  decryptionFailed?: boolean
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

type IncomingCall = {
  fromId: string
  description: RTCSessionDescriptionInit
}

const SIGNALING_URL =
  import.meta.env.VITE_SIGNALING_URL ?? 'http://localhost:3001'

const rtcConfig: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const randomAlias = () => `Ghost-${Math.floor(1000 + Math.random() * 9000)}`

const initialRoom = () => {
  const params = new URLSearchParams(window.location.search)
  return params.get('room') ?? 'lobby'
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
  const [alias, setAlias] = useState(randomAlias)
  const [roomId, setRoomId] = useState(initialRoom)
  const [draft, setDraft] = useState('')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [participants, setParticipants] = useState<Participant[]>([])
  const [selfId, setSelfId] = useState('')
  const [activePeerId, setActivePeerId] = useState('')
  const [joined, setJoined] = useState(false)
  const [connectionLabel, setConnectionLabel] = useState('offline')
  const [callLabel, setCallLabel] = useState('No active call')
  const [isMuted, setIsMuted] = useState(false)
  const [isCameraOff, setIsCameraOff] = useState(false)
  const [cameraFacingMode, setCameraFacingMode] =
    useState<'user' | 'environment'>('user')
  const [incomingCall, setIncomingCall] = useState<IncomingCall | null>(null)
  const [callPeerId, setCallPeerId] = useState('')
  const [roomSecret, setRoomSecret] = useState('')

  const socketRef = useRef<Socket | null>(null)
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null)
  const pendingJoinRef = useRef({
    alias,
    roomId,
  })
  const localStreamRef = useRef<MediaStream | null>(null)
  const remoteStreamRef = useRef<MediaStream | null>(null)
  const pendingIceCandidatesRef = useRef<RTCIceCandidateInit[]>([])
  const cryptoKeyCacheRef = useRef(new Map<string, CryptoKey>())
  const localVideoRef = useRef<HTMLVideoElement | null>(null)
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null)
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null)
  const messagesEndRef = useRef<HTMLDivElement | null>(null)

  const remoteParticipants = participants.filter((person) => person.id !== selfId)
  const activePeer =
    participants.find((person) => person.id === activePeerId) ?? null

  const roomLink = useMemo(() => {
    const url = new URL(window.location.href)
    url.searchParams.set('room', roomId)
    return url.toString()
  }, [roomId])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  useEffect(() => {
    const encryptedMessages = messages.filter((message) => message.encrypted)
    if (encryptedMessages.length === 0) {
      return
    }

    void Promise.all(messages.map((message) => decryptMessage(message))).then((nextMessages) => {
      setMessages(nextMessages)
    })
  }, [roomSecret])

  useEffect(() => {
    if (activePeerId && remoteParticipants.some((person) => person.id === activePeerId)) {
      return
    }

    setActivePeerId(remoteParticipants[0]?.id ?? '')
  }, [activePeerId, remoteParticipants])

  useEffect(() => {
    return () => {
      void hangUpCall(false)
      socketRef.current?.disconnect()
    }
  }, [])

  const applyLocalTrackState = (stream: MediaStream) => {
    stream.getAudioTracks().forEach((track) => {
      track.enabled = !isMuted
    })

    stream.getVideoTracks().forEach((track) => {
      track.enabled = !isCameraOff
    })
  }

  const safePlay = async (element: HTMLMediaElement | null) => {
    if (!element) {
      return
    }

    try {
      await element.play()
    } catch (error) {
      console.warn('Media playback requires user interaction.', error)
    }
  }

  const attachLocalPreview = (stream: MediaStream | null) => {
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = stream
      void safePlay(localVideoRef.current)
    }
  }

  const attachRemoteMedia = (stream: MediaStream | null) => {
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = stream
      void safePlay(remoteVideoRef.current)
    }

    if (remoteAudioRef.current) {
      remoteAudioRef.current.srcObject = stream
      void safePlay(remoteAudioRef.current)
    }
  }

  const stopStream = (stream: MediaStream | null) => {
    stream?.getTracks().forEach((track) => track.stop())
  }

  const deriveRoomKey = async () => {
    const normalizedSecret = roomSecret.trim()
    if (!normalizedSecret) {
      return null
    }

    const cacheKey = `${roomId}:${normalizedSecret}`
    const cachedKey = cryptoKeyCacheRef.current.get(cacheKey)
    if (cachedKey) {
      return cachedKey
    }

    const baseKey = await crypto.subtle.importKey(
      'raw',
      encoder.encode(normalizedSecret),
      'PBKDF2',
      false,
      ['deriveKey'],
    )

    const key = await crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        hash: 'SHA-256',
        salt: encoder.encode(`anonmess:${roomId}`),
        iterations: 120000,
      },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    )

    cryptoKeyCacheRef.current.set(cacheKey, key)
    return key
  }

  const encryptMessage = async (plainText: string) => {
    const key = await deriveRoomKey()
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

  const decryptMessage = async (message: ChatMessage) => {
    if (!message.encrypted || !message.iv) {
      return message
    }

    const key = await deriveRoomKey()
    const cipherText = message.cipherText ?? message.text
    if (!key) {
      return {
        ...message,
        cipherText,
        text: 'Encrypted message. Enter the room key to read it.',
        decryptionFailed: true,
      }
    }

    try {
      const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: base64ToBytes(message.iv) },
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
        text: 'Encrypted message. Wrong room key.',
        decryptionFailed: true,
      }
    }
  }

  const ensureLocalMedia = async () => {
    if (localStreamRef.current) {
      applyLocalTrackState(localStreamRef.current)
      attachLocalPreview(localStreamRef.current)
      return localStreamRef.current
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: {
        facingMode: { ideal: cameraFacingMode },
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
    })

    applyLocalTrackState(stream)
    localStreamRef.current = stream
    attachLocalPreview(stream)
    return stream
  }

  const resetPeerConnection = () => {
    peerConnectionRef.current?.close()
    peerConnectionRef.current = null
    pendingIceCandidatesRef.current = []
    remoteStreamRef.current = null
    attachRemoteMedia(null)
  }

  const resetCallUi = () => {
    setCallPeerId('')
    setIncomingCall(null)
    setCallLabel('No active call')
  }

  const flushPendingIceCandidates = async (peerConnection: RTCPeerConnection) => {
    if (!peerConnection.remoteDescription) {
      return
    }

    const queued = [...pendingIceCandidatesRef.current]
    pendingIceCandidatesRef.current = []

    for (const candidate of queued) {
      await peerConnection.addIceCandidate(candidate)
    }
  }

  const createPeerConnection = async (peerId: string) => {
    resetPeerConnection()

    const stream = await ensureLocalMedia()
    const peerConnection = new RTCPeerConnection(rtcConfig)
    const remoteStream = new MediaStream()

    remoteStreamRef.current = remoteStream
    attachRemoteMedia(remoteStream)

    stream.getTracks().forEach((track) => {
      peerConnection.addTrack(track, stream)
    })

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
      event.streams[0]?.getTracks().forEach((track) => {
        const alreadyAttached = remoteStream.getTracks().some(
          (existingTrack) => existingTrack.id === track.id,
        )

        if (!alreadyAttached) {
          remoteStream.addTrack(track)
        }
      })

      attachRemoteMedia(remoteStream)
    }

    peerConnection.onconnectionstatechange = () => {
      const state = peerConnection.connectionState

      if (state === 'connected') {
        setCallLabel(`Connected with ${activePeer?.alias ?? 'participant'}`)
      }

      if (state === 'disconnected' || state === 'failed' || state === 'closed') {
        setCallLabel('Call ended')
      }
    }

    peerConnectionRef.current = peerConnection
    setActivePeerId(peerId)
    setCallPeerId(peerId)
    return peerConnection
  }

  const hangUpCall = async (notifyPeer = true) => {
    if (notifyPeer && socketRef.current && callPeerId) {
      socketRef.current.emit('call-ended', {
        targetId: callPeerId,
      })
    }

    resetPeerConnection()
    stopStream(localStreamRef.current)
    localStreamRef.current = null
    attachLocalPreview(null)
    resetCallUi()
  }

  const replaceVideoTrack = async (nextFacingMode: 'user' | 'environment') => {
    setCameraFacingMode(nextFacingMode)

    if (!localStreamRef.current) {
      return
    }

    const cameraStream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: nextFacingMode },
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
      audio: false,
    })

    const [nextVideoTrack] = cameraStream.getVideoTracks()
    const [currentVideoTrack] = localStreamRef.current.getVideoTracks()

    if (!nextVideoTrack) {
      return
    }

    currentVideoTrack?.stop()
    if (currentVideoTrack) {
      localStreamRef.current.removeTrack(currentVideoTrack)
    }

    localStreamRef.current.addTrack(nextVideoTrack)
    applyLocalTrackState(localStreamRef.current)
    attachLocalPreview(localStreamRef.current)

    const sender = peerConnectionRef.current
      ?.getSenders()
      .find((item) => item.track?.kind === 'video')

    await sender?.replaceTrack(nextVideoTrack)
  }

  const attachSocketListeners = (socket: Socket) => {
    socket.removeAllListeners()

    socket.on('connect', () => {
      setConnectionLabel('online')
      socket.emit('join-room', {
        alias: pendingJoinRef.current.alias,
        roomId: pendingJoinRef.current.roomId,
      })
    })

    socket.on('disconnect', () => {
      setConnectionLabel('offline')
      setParticipants([])
      setSelfId('')
      void hangUpCall(false)
    })

    socket.on('room-state', ({ selfId: socketId, participants }: RoomStatePayload) => {
      setSelfId(socketId)
      setParticipants(participants)
    })

    socket.on('participant-joined', (participant: Participant) => {
      setParticipants((current) => {
        if (current.some((item) => item.id === participant.id)) {
          return current
        }

        return [...current, participant]
      })
    })

    socket.on('participant-left', ({ participantId }: { participantId: string }) => {
      setParticipants((current) => current.filter((person) => person.id !== participantId))

      if (participantId === callPeerId || participantId === activePeerId) {
        void hangUpCall(false)
      }
    })

    socket.on('chat-message', async (message: ChatMessage) => {
      const resolvedMessage = await decryptMessage(message)
      setMessages((current) => [...current, resolvedMessage])
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

    socket.on('webrtc-offer', ({ fromId, description }: SignalPayload) => {
      if (!description) {
        return
      }

      setIncomingCall({
        fromId,
        description,
      })
      setCallLabel(`Incoming call from ${participants.find((item) => item.id === fromId)?.alias ?? 'participant'}`)
    })

    socket.on('webrtc-answer', async ({ description }: SignalPayload) => {
      try {
        if (!description || !peerConnectionRef.current) {
          return
        }

        await peerConnectionRef.current.setRemoteDescription(description)
        await flushPendingIceCandidates(peerConnectionRef.current)
        setCallLabel('Call connected')
      } catch (error) {
        console.error(error)
        setCallLabel('Failed to connect the call')
      }
    })

    socket.on('webrtc-ice-candidate', async ({ candidate }: SignalPayload) => {
      if (!candidate) {
        return
      }

      const peerConnection = peerConnectionRef.current
      if (!peerConnection || !peerConnection.remoteDescription) {
        pendingIceCandidatesRef.current.push(candidate)
        return
      }

      try {
        await peerConnection.addIceCandidate(candidate)
      } catch (error) {
        console.error(error)
      }
    })

    socket.on('call-ended', () => {
      void hangUpCall(false)
    })

    socket.on('call-declined', () => {
      void hangUpCall(false)
      setCallLabel('Call declined')
    })
  }

  const connectRoom = async (event: FormEvent) => {
    event.preventDefault()

    const trimmedAlias = alias.trim() || randomAlias()
    const trimmedRoom = roomId.trim() || 'lobby'

    setAlias(trimmedAlias)
    setRoomId(trimmedRoom)
    setJoined(true)
    setMessages([])
    setIncomingCall(null)
    setCallLabel('No active call')

    pendingJoinRef.current = {
      alias: trimmedAlias,
      roomId: trimmedRoom,
    }

    if (socketRef.current) {
      socketRef.current.disconnect()
    }

    const socket = io(SIGNALING_URL, {
      transports: ['websocket'],
    })

    socketRef.current = socket
    attachSocketListeners(socket)
  }

  const sendMessage = async (event: FormEvent) => {
    event.preventDefault()

    const text = draft.trim()
    if (!text || !socketRef.current) {
      return
    }

    const payload = await encryptMessage(text)
    socketRef.current.emit('chat-message', payload)
    setDraft('')
  }

  const startCall = async () => {
    if (!socketRef.current || !activePeerId) {
      setCallLabel('Select another participant before starting a call')
      return
    }

    try {
      const peerConnection = await createPeerConnection(activePeerId)
      const offer = await peerConnection.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: true,
      })

      await peerConnection.setLocalDescription(offer)
      socketRef.current.emit('webrtc-offer', {
        targetId: activePeerId,
        description: offer,
      })

      setCallLabel('Calling...')
    } catch (error) {
      console.error(error)
      setCallLabel('Camera or microphone access was denied')
    }
  }

  const acceptIncomingCall = async () => {
    if (!incomingCall || !socketRef.current) {
      return
    }

    try {
      const peerConnection = await createPeerConnection(incomingCall.fromId)
      await peerConnection.setRemoteDescription(incomingCall.description)
      await flushPendingIceCandidates(peerConnection)

      const answer = await peerConnection.createAnswer()
      await peerConnection.setLocalDescription(answer)

      socketRef.current.emit('webrtc-answer', {
        targetId: incomingCall.fromId,
        description: answer,
      })

      setCallLabel('Call connected')
      setIncomingCall(null)
    } catch (error) {
      console.error(error)
      setCallLabel('Failed to accept the call')
    }
  }

  const declineIncomingCall = () => {
    if (!incomingCall || !socketRef.current) {
      return
    }

    socketRef.current.emit('call-declined', {
      targetId: incomingCall.fromId,
    })
    setIncomingCall(null)
    setCallLabel('Call declined')
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

  const switchCamera = async () => {
    try {
      const nextFacingMode =
        cameraFacingMode === 'user' ? 'environment' : 'user'
      await replaceVideoTrack(nextFacingMode)
    } catch (error) {
      console.error(error)
      setCallLabel('Failed to switch camera')
    }
  }

  return (
    <main className="shell">
      <section className="hero">
        <div>
          <p className="eyebrow">MESSENGER REBUILD</p>
          <h1>Private rooms, stronger calls, and a better mobile flow.</h1>
          <p className="subtitle">
            This version keeps the fast room-based entry, but now has a cleaner
            call lifecycle, optional client-side message encryption, and mobile
            camera switching.
          </p>
        </div>
        <div className="status-card">
          <span>Connection</span>
          <strong>{connectionLabel}</strong>
          <span>Conversation</span>
          <strong>{roomId}</strong>
          <span>Call</span>
          <strong>{callLabel}</strong>
        </div>
      </section>

      {incomingCall && (
        <section className="panel incoming-call">
          <div>
            <strong>
              {participants.find((person) => person.id === incomingCall.fromId)?.alias ??
                'Participant'}{' '}
              is calling you
            </strong>
            <p>Accept from a user gesture so mobile browsers allow audio playback.</p>
          </div>
          <div className="incoming-actions">
            <button type="button" onClick={acceptIncomingCall}>
              Accept
            </button>
            <button type="button" onClick={declineIncomingCall} className="danger">
              Decline
            </button>
          </div>
        </section>
      )}

      <section className="panel auth-panel">
        <form className="join-form" onSubmit={connectRoom}>
          <label>
            Alias
            <input
              value={alias}
              onChange={(event) => setAlias(event.target.value)}
              placeholder="Ghost-2048"
            />
          </label>
          <label>
            Chat ID
            <input
              value={roomId}
              onChange={(event) => setRoomId(event.target.value)}
              placeholder="family-room"
            />
          </label>
          <label>
            Room key (optional)
            <input
              value={roomSecret}
              onChange={(event) => setRoomSecret(event.target.value)}
              placeholder="shared secret"
            />
          </label>
          <button type="submit">{joined ? 'Reconnect' : 'Join chat'}</button>
        </form>
        <div className="share-box">
          <span>Invite link</span>
          <code>{roomLink}</code>
          <small>
            Add a room key on both devices if you want message text encrypted in
            the browser before it is sent.
          </small>
        </div>
      </section>

      <section className="dashboard">
        <article className="panel video-panel">
          <div className="panel-head">
            <h2>Call</h2>
            <p>One-to-one calling is now explicit, with accept, decline, hang up, and camera switching.</p>
          </div>
          <div className="video-grid">
            <div className="video-card">
              <video ref={localVideoRef} autoPlay muted playsInline />
              <span>You</span>
            </div>
            <div className="video-card">
              <video ref={remoteVideoRef} autoPlay playsInline />
              <span>{activePeer?.alias ?? 'Remote participant'}</span>
            </div>
          </div>
          <audio ref={remoteAudioRef} autoPlay playsInline />
          <div className="call-controls">
            <button onClick={startCall} type="button" disabled={!activePeerId}>
              Start call
            </button>
            <button onClick={toggleAudio} type="button" className="secondary">
              {isMuted ? 'Unmute' : 'Mute mic'}
            </button>
            <button onClick={toggleVideo} type="button" className="secondary">
              {isCameraOff ? 'Turn camera on' : 'Turn camera off'}
            </button>
            <button onClick={switchCamera} type="button" className="secondary">
              Flip camera
            </button>
            <button onClick={() => void hangUpCall(true)} type="button" className="danger">
              Hang up
            </button>
          </div>
        </article>

        <article className="panel chat-panel">
          <div className="panel-head">
            <h2>Messages</h2>
            <p>
              Messages stay live inside the current chat. With a room key they are
              encrypted before the server relays them.
            </p>
          </div>
          <div className="messages">
            {messages.length === 0 ? (
              <div className="empty-state">No messages yet. Start the conversation.</div>
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
                  <span>
                    {new Date(message.createdAt).toLocaleTimeString()}
                    {message.encrypted ? ' • encrypted' : ''}
                    {message.decryptionFailed ? ' • locked' : ''}
                  </span>
                </div>
              ))
            )}
            <div ref={messagesEndRef} />
          </div>
          <form className="message-form" onSubmit={(event) => void sendMessage(event)}>
            <input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Write a message"
            />
            <button type="submit">Send</button>
          </form>
        </article>

        <article className="panel sidebar-panel">
          <div className="panel-head">
            <h2>Participants</h2>
            <p>{participants.length} in this chat</p>
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
                    ? 'this is you'
                    : `${person.isMuted ? 'mic off' : 'mic on'} / ${
                        person.isCameraOff ? 'cam off' : 'cam on'
                      }`}
                </span>
              </button>
            ))}
            {remoteParticipants.length === 0 && (
              <div className="empty-state">
                Share the invite link to turn this into a private 1:1 chat or a small group.
              </div>
            )}
          </div>
        </article>
      </section>
    </main>
  )
}

export default App
