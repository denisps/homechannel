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

**Two-Phase ECDH Registration:**

**Phase 1: ECDH Init** (from server, binary payload with 1-byte lengths):
```
Format: [ecdhPubKeyLen(1)][ecdhPubKey][ecdsaPubKeyLen(1)][ecdsaPubKey][timestamp(8)][sigLen(1)][signature]

Fields:
- ecdhPubKeyLen: 1 byte - length of ECDH public key
- ecdhPubKey: variable - ECDH public key (raw bytes)
- ecdsaPubKeyLen: 1 byte - length of ECDSA public key
- ecdsaPubKey: variable - server's ECDSA public key in PEM format
- timestamp: 8 bytes (big-endian) - Unix timestamp in milliseconds
- sigLen: 1 byte - length of signature
- signature: variable - ECDSA signature over ECDH public key
```

**Phase 2: ECDH Response** (from coordinator, binary payload):
```
Format: [ecdhPubKeyLen(1)][ecdhPubKey][timestamp(8)][sigLen(1)][signature]

Fields:
- ecdhPubKeyLen: 1 byte - length of coordinator's ECDH public key
- ecdhPubKey: variable - coordinator's ECDH public key (raw bytes)
- timestamp: 8 bytes (big-endian) - Unix timestamp in milliseconds
- sigLen: 1 byte - length of signature
- signature: variable - coordinator's ECDSA signature over ECDH public key
```

Both parties compute ECDH shared secret.

**Phase 3: Registration** (from server, AES-CTR encrypted JSON):
Encrypted with key derived from ECDH shared secret.
```javascript
{
  serverPublicKey: '...',
  timestamp: 1234567890,
  payload: {
    challenge: '...',
    challengeAnswerHash: '...'
  },
  signature: '...'
}
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
