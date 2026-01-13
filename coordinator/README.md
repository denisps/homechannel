# HomeChannel Coordinator

The coordinator is a publicly accessible signaling server that facilitates WebRTC datachannel establishment between clients and home servers.

## Features

- **UDP Communication**: ECDH-based two-phase registration with binary protocol
- **Memory-Compact State**: Minimal server registry (publicKey → {ipPort, challenge, expectedAnswer, timestamp})
- **Optimized Protocol**: Tiny keepalive pings (30s), HMAC-authenticated challenge refresh (10min)
- **ECDSA Security**: ECDH key exchange signed with ECDSA keys, ongoing HMAC authentication
- **AES-CTR Encryption**: All communication after ECDH handshake is encrypted
- **Rate Limiting**: Connection attempt tracking and rate limiting
- **Auto Cleanup**: Periodic cleanup of expired server records and ECDH sessions

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
Types: `0x01`=ecdh_init, `0x02`=ecdh_response, `0x03`=register, `0x04`=ping, `0x05`=heartbeat, `0x06`=answer

**Three-Phase ECDH Registration:**

**Phase 1: ECDH Init** (from server, binary payload):
```
Format: [ecdhPubKeyLen(1)][ecdhPubKey]

Fields:
- ecdhPubKeyLen: 1 byte - length of ECDH public key
- ecdhPubKey: variable - ECDH public key (raw bytes)

Security: No server identity or signature transmitted. Observer cannot identify which server is connecting.
```

**Phase 2: ECDH Response** (from coordinator, binary payload with encrypted signature):
```
Format: [ecdhPubKeyLen(1)][ecdhPubKey][encryptedData]

Fields:
- ecdhPubKeyLen: 1 byte - length of coordinator's ECDH public key
- ecdhPubKey: variable - coordinator's ECDH public key (raw bytes)
- encryptedData: variable - AES-CTR encrypted {timestamp, signature}

Both parties compute ECDH shared secret. Coordinator's ECDSA signature on its ECDH public key is encrypted with shared secret. Server verifies coordinator identity using trusted coordinator public key.

Security: Coordinator proves identity, but signature is encrypted. Observer cannot impersonate coordinator.
```

**Phase 3: Registration** (from server, AES-CTR encrypted JSON):
```
Encrypted with key derived from ECDH shared secret

JSON payload:
{
  serverPublicKey: 'pem-key',
  timestamp: 1234567890,
  payload: {
    challenge: 'hex-string',
    challengeAnswerHash: 'hex-string'
  },
  signature: 'ecdsa-hex-signature'
}

Security: Server identity (ECDSA public key) and challenge data only revealed after encryption established. Observer cannot see challenge or identify server.
```

After registration, expectedAnswer becomes the shared secret for all future communication.

**All messages below have AES-CTR encrypted JSON payloads (key from expectedAnswer)**

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
