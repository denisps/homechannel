# HomeChannel Coordinator

The coordinator is a publicly accessible signaling server that facilitates WebRTC datachannel establishment between clients and home servers.

## Features

- **UDP Communication**: X25519/X448-based two-phase registration with binary protocol
- **Memory-Compact State**: Minimal server registry (publicKey → {ipPort, challenge, expectedAnswer, timestamp})
- **Optimized Protocol**: Tiny keepalive pings (30s), authenticated challenge refresh (10min)
- **Ed448 Security**: X25519/X448 key exchange signed with Ed448 keys (configurable Ed25519)
- **AES-GCM Encryption**: All communication after X25519/X448 handshake uses authenticated encryption
- **Rate Limiting**: Connection attempt tracking and rate limiting
- **Auto Cleanup**: Periodic cleanup of expired server records and X25519/X448 sessions

## Installation

```bash
cd coordinator
npm install
```

## Configuration

Edit `config.json` in the coordinator directory:

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
  "crypto": {
    "signatureAlgorithm": "ed448",
    "keyAgreementCurve": "x448"
  },
  "maxServers": 1000,
  "serverTimeout": 300000,
  "keepaliveInterval": 30000,
  "challengeRefreshInterval": 600000
}
```

If you change `crypto.signatureAlgorithm`, regenerate coordinator keys to match the new algorithm.

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

**Three-Phase X25519/X448 Registration:**

**Phase 1: ECDH Init** (from server, binary payload):
```
Format: [ecdhPubKeyLen(1)][ecdhPubKey]

Fields:
- ecdhPubKeyLen: 1 byte - length of X25519/X448 public key (SPKI DER)
- ecdhPubKey: variable - X25519/X448 public key (SPKI DER bytes)

Security: No server identity or signature transmitted. Observer cannot identify which server is connecting.
```

**Phase 2: ECDH Response** (from coordinator, binary payload with encrypted signature):
```
Format: [ecdhPubKeyLen(1)][ecdhPubKey][encryptedData]

Fields:
- ecdhPubKeyLen: 1 byte - length of coordinator's X25519/X448 public key
- ecdhPubKey: variable - coordinator's X25519/X448 public key (SPKI DER bytes)
- encryptedData: variable - AES-GCM encrypted {timestamp, signature}

Both parties compute an X25519/X448 shared secret. Coordinator's Ed448 signature on its X25519/X448 public key is encrypted with the shared secret. Server verifies coordinator identity using the trusted coordinator public key (Ed448/Ed25519).

Security: Coordinator proves identity, but signature is encrypted. Observer cannot impersonate coordinator.
```

**Phase 3: Registration** (from server, AES-GCM encrypted JSON):
```
Encrypted with key derived from X25519/X448 shared secret

JSON payload:
{
  serverPublicKey: 'pem-key',
  timestamp: 1234567890,
  payload: {
    challenge: 'hex-string',
    challengeAnswerHash: 'hex-string'
  },
  signature: 'eddsa-hex-signature'
}

Security: Server identity (Ed25519/Ed448 public key) and challenge data only revealed after encryption established. Observer cannot see challenge or identify server.
```

After registration, expectedAnswer becomes the shared secret for all future communication.

**All messages below have AES-GCM encrypted JSON payloads (key from expectedAnswer)**

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
  }
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
  signature: 'eddsa-signature'
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
- expectedAnswer used as shared secret for AES-GCM encryption
- Minimal state per server
- Periodic cleanup of expired entries
- Separate connection log for rate limiting

## Security

- **Binary Protocol**: Version + type bytes avoid fingerprinting
- **Initial Registration**: Ed448 signature verification (encrypted with X25519/X448 shared secret)
- **Ongoing Communication**: AES-GCM authenticated encryption using expectedAnswer as key
  - 256-bit AES key derived from expectedAnswer
  - Random IV for each message
  - Authentication tag ensures message integrity
  - If decryption succeeds, authentication is guaranteed
- **No Round-trips**: Shared secret eliminates signature overhead
- **Rate Limiting**: Connection attempt tracking per client
- **Challenge Refresh**: Periodic challenge updates for security

## License

GPL-3.0
