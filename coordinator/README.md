# HomeChannel Coordinator

The coordinator is a publicly accessible signaling server that facilitates WebRTC datachannel establishment between clients and home servers.

## Features

- **UDP Communication**: Server-initiated communication with ECDH and HMAC
- **Memory-Compact State**: Minimal server registry (publicKey → {ipPort, challenge, expectedAnswer, timestamp})
- **Optimized Protocol**: Tiny keepalive pings (30s), HMAC-authenticated challenge refresh (10min)
- **ECDSA Security**: Initial registration verification, ongoing HMAC authentication
- **Rate Limiting**: Connection attempt tracking and rate limiting
- **Auto Cleanup**: Periodic cleanup of expired server records

## Installation

```bash
cd coordinator
npm install
```

## Configuration

Copy the example configuration:

```bash
cp config.example.json config.json
```

Edit `config.json` with your settings:

```json
{
  "https": {
    "port": 8443,
    "certPath": "./keys/cert.pem",
    "keyPath": "./keys/key.pem"
  },
  "udp": {
    "port": 3478
  },
  "privateKeyPath": "./keys/coordinator-private.key",
  "publicKeyPath": "./keys/coordinator-public.key",
  "maxServers": 1000,
  "serverTimeout": 300000,
  "keepaliveInterval": 30000,
  "challengeRefreshInterval": 600000
}
```

## Running

Start the coordinator:

```bash
npm start
```

Or with Node directly:

```bash
node index.js
```

## Testing

Run the test suite:

```bash
npm test
```

Run tests in watch mode:

```bash
npm run test:watch
```

## Protocol

### UDP Messages

**Binary Protocol Format:**
```
[Version (1 byte)][Type (1 byte)][Payload (variable)]
```

Version: `0x01`
Types: `0x01`=register, `0x02`=ping, `0x03`=heartbeat, `0x04`=answer

**Registration** (from server, unencrypted JSON payload):
```javascript
{
  type: 'register',
  serverPublicKey: '...',
  timestamp: Date.now(),
  payload: {
    challenge: '...',
    challengeAnswerHash: '...'
  },
  signature: 'ecdsa-signature'
}
```

**All messages below have AES-CTR encrypted JSON payloads**

**Keepalive Ping** (from server, every ~30s):
```javascript
{
  type: 'ping'
}
```

**Challenge Refresh** (from server, every ~10min):
```javascript
{
  type: 'heartbeat',
  payload: {
    newChallenge: '...',
    challengeAnswerHash: '...'
  },
  hmac: 'hmac-using-expectedAnswer'
}
```

**SDP Answer** (from server):
```javascript
{
  type: 'answer',
  serverPublicKey: '...',
  sessionId: '...',
  timestamp: Date.now(),
  payload: {
    sdp: { type: 'answer', sdp: '...' },
    candidates: [...]
  },
  signature: 'ecdsa-signature'
}
```

## Architecture

The coordinator maintains a memory-compact registry:

```
Map<serverPublicKey, {
  ipPort: string,
  challenge: string,
  expectedAnswer: string,  // Used as shared secret
  timestamp: number
}>
```

**Key Features:**
- Server identified by IP:port for ongoing communication (no public key needed)
- expectedAnswer used as shared secret for HMAC authentication
- Minimal state per server
- Periodic cleanup of expired entries
- Separate connection log for rate limiting

## Security

- **Binary Protocol**: Version + type bytes avoid fingerprinting
- **Initial Registration**: ECDSA signature verification (unencrypted JSON payload)
- **Ongoing Communication**: AES-CTR encryption using expectedAnswer as key
  - 256-bit AES key derived from expectedAnswer
  - Random IV for each message
  - HMAC authentication for challenge updates
- **No Round-trips**: Shared secret eliminates signature overhead
- **Rate Limiting**: Connection attempt tracking per client
- **Challenge Refresh**: Periodic challenge updates for security

## License

GPL-3.0
