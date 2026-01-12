# Protocol Specification

This document describes the communication protocols used by HomeChannel.

## UDP Protocol (Server ↔ Coordinator)

Server initiates UDP connection to coordinator. All messages use binary protocol for minimal fingerprinting and overhead.

### Binary Protocol Format

All UDP messages follow this format:

```
[Version (1 byte)][Type (1 byte)][Payload (variable length)]
```

**Protocol Version**: `0x01`

**Message Types**:
- `0x01` - Registration
- `0x02` - Ping (keepalive)
- `0x03` - Heartbeat (challenge refresh)
- `0x04` - Answer (SDP response)

### Registration Message (Unencrypted Payload)

Initial ECDH exchange with ECDSA-signed JSON payload:

```
Binary: [0x01][0x01][JSON payload]
```

JSON payload:
```javascript
{
  type: 'register',
  serverPublicKey: 'hex-encoded-ecdsa-public-key',
  timestamp: Date.now(),
  payload: {
    serverName: 'my-home-server',
    challenge: 'short-random-bytes-hex',
    challengeAnswerHash: 'sha256-hash-of-answer'
  },
  signature: 'hex-encoded-ecdsa-signature'
}
```

### Keepalive Ping (AES-CTR Encrypted Payload)

Sent every ~30 seconds:

```
Binary: [0x01][0x02][Encrypted payload]
```

Encrypted JSON:
```javascript
{
  type: 'ping'
}
```

### Challenge Refresh (AES-CTR Encrypted Payload)

Sent every ~10 minutes with HMAC:

```
Binary: [0x01][0x03][Encrypted payload]
```

Encrypted JSON:
```javascript
{
  type: 'heartbeat',
  payload: {
    newChallenge: 'refreshed-challenge-hex',
    challengeAnswerHash: 'new-expected-hash'
  },
  hmac: 'hmac-using-expectedAnswer-as-key'
}
```

### SDP Answer (AES-CTR Encrypted Payload)

Response to client offer:

```
Binary: [0x01][0x04][Encrypted payload]
```

Encrypted JSON:
```javascript
{
  type: 'answer',
  serverPublicKey: 'hex-encoded-ecdsa-public-key',
  sessionId: 'client-session-id',
  timestamp: Date.now(),
  payload: {
    sdp: { type: 'answer', sdp: '...' },
    candidates: [
      { candidate: '...', sdpMLineIndex: 0, sdpMid: 'data' },
      // ... all ICE candidates
    ]
  },
  signature: 'hex-encoded-ecdsa-signature'
}
```

## HTTPS Protocol (Client ↔ Coordinator)

Client connects via standard HTTPS polling (no WebSockets).

### Get Coordinator Key

```
GET /api/coordinator-key

Response:
{
  publicKey: '-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----',
  signature: 'self-signed-for-verification'
}
```

### List Servers

```
POST /api/servers

Request:
{
  serverPublicKeys: ['key1-hash', 'key2-hash']
}

Response:
{
  servers: [
    {
      publicKeyHash: 'key1-hash',
      name: 'Server Name',
      online: true,
      challenge: 'current-challenge-hex'
    }
  ],
  signature: 'coordinator-ecdsa-signature'
}
```

### Initiate Connection

Client provides challenge answer with SDP offer and all ICE candidates:

```
POST /api/connect

Request:
{
  serverPublicKey: 'target-server-public-key-hash',
  challengeAnswer: 'hash-of-challenge-plus-password',
  payload: {
    sdp: { type: 'offer', sdp: '...' },
    candidates: [
      { candidate: '...', sdpMLineIndex: 0, sdpMid: 'data' },
      // ... all ICE candidates
    ]
  },
  timestamp: Date.now()
}

Response:
{
  success: true,
  sessionId: 'unique-session-id',
  message: 'Waiting for server response',
  coordinatorSignature: 'coordinator-ecdsa-signature'
}
```

### Poll for Server Response

```
POST /api/poll

Request:
{
  sessionId: 'unique-session-id',
  lastUpdate: 1234567890
}

Response (when ready):
{
  success: true,
  payload: {
    sdp: { type: 'answer', sdp: '...' },
    candidates: [
      // ... all ICE candidates from server
    ]
  },
  serverSignature: 'server-ecdsa-signature',
  coordinatorSignature: 'coordinator-ecdsa-signature'
}

Response (waiting):
{
  success: false,
  waiting: true,
  coordinatorSignature: 'coordinator-ecdsa-signature'
}
```

## Message Flow

### Server Registration

1. Server generates challenge and expectedAnswer
2. Server sends unencrypted registration to coordinator (ECDSA-signed)
3. Coordinator verifies signature and stores server info
4. Server identified by IP:port for ongoing communication

### Client Connection

1. Client gets server's challenge from coordinator
2. Client computes challenge answer from password
3. Client gathers all ICE candidates
4. Client sends offer + candidates + challenge answer
5. Coordinator verifies challenge answer
6. Coordinator relays to server via encrypted UDP
7. Server sends encrypted answer + candidates
8. Coordinator relays to client via HTTPS
9. Direct WebRTC datachannel established

### Keepalive

- Server sends encrypted ping every ~30s
- Coordinator updates server timestamp
- No response needed (minimal overhead)

### Challenge Refresh

- Server sends encrypted heartbeat every ~10 minutes
- Contains new challenge and HMAC
- Coordinator verifies HMAC and updates challenge

## Encryption

### Binary Protocol

All UDP messages use binary protocol format to avoid fingerprinting:

```
[Version (1 byte)][Type (1 byte)][Payload (variable length)]
```

- **Version**: 0x01
- **Types**: 0x01=register, 0x02=ping, 0x03=heartbeat, 0x04=answer

### AES-CTR Encryption

All UDP messages after registration use AES-256-CTR encryption:

- **Key**: Derived from expectedAnswer using SHA-256
- **IV**: Random 16 bytes, prepended to ciphertext
- **Format**: `[IV (16 bytes)][Ciphertext]`
- **Payload**: JSON message (encrypted in binary format)

Registration message payload remains unencrypted JSON (initial ECDH exchange).

## Signatures

- **ECDSA**: P-256 curve, SHA-256 digest
- **HMAC**: SHA-256, using expectedAnswer as key
- **Timing-safe**: All comparisons use constant-time operations
