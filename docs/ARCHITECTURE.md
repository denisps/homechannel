# Architecture

HomeChannel's three-component architecture enables direct peer-to-peer connections while maintaining a lightweight coordinator.

## Components

### Client (Browser)

**Runtime**: Browser (vanilla JavaScript, ES modules)

**Responsibilities**:
- WebRTC connection initiation (creates offer)
- Gathers all ICE candidates before sending
- Computes challenge answer from password
- Verifies ECDSA signatures from coordinator and server
- Establishes direct datachannel with server

**Communication**:
- HTTPS polling to coordinator (no WebSockets)
- Direct WebRTC datachannel to server

**Key Files**:
- `/client/index.html` - Main UI
- `/client/js/main.js` - Application entry point
- `/client/js/webrtc.js` - WebRTC connection management
- `/client/js/crypto.js` - ECDSA verification, challenge answer
- `/client/js/api.js` - HTTPS polling to coordinator
- `/client/js/config.js` - Coordinator + server keys

### Server (Home Node.js)

**Runtime**: Node.js (home network)

**Responsibilities**:
- Initiates UDP connection to coordinator
- Generates challenge for client authentication
- Signs all payloads with ECDSA private key
- Sends AES-GCM encrypted messages to coordinator
- WebRTC peer connection handling (creates answer)
- Gathers all ICE candidates before sending
- Local service proxying (VNC, SSH, files)

**Communication**:
- UDP to coordinator (AES-GCM encrypted after registration)
- Direct WebRTC datachannel to client

**Key Files**:
- `/server/index.js` - Main server entry point
- `/server/udp.js` - UDP: ECDH initial, AES-GCM ongoing
- `/server/webrtc.js` - WebRTC connection handling
- `/server/crypto.js` - ECDSA signing, AES-GCM encryption
- `/server/challenge.js` - Challenge generation
- `/server/services/` - Service handlers (VNC, SSH, files)

### Coordinator (Public Node.js)

**Runtime**: Node.js (public server)

**Responsibilities**:
- Server registration and management
- Verifies server ECDSA signatures
- Stores challenges and expectedAnswer
- Verifies client challenge answers
- Relays signed payloads between client and server
- Periodic UDP exchange with servers
- Challenge refresh management
- AES-GCM encryption/decryption

**Communication**:
- HTTPS with clients (polling)
- UDP with servers (AES-GCM encrypted)
- Signs all responses

**Key Files**:
- `/coordinator/index.js` - Main coordinator entry point
- `/coordinator/https.js` - HTTPS server for clients
- `/coordinator/udp.js` - UDP: ECDH initial, AES-GCM ongoing
- `/coordinator/registry.js` - Memory-compact server registry
- `/coordinator/relay.js` - Payload relay
- `/coordinator/cleanup.js` - Periodic cleanup of expired servers
- `/coordinator/ratelimit.js` - Connection attempt rate limiting
- `/shared/crypto.js` - ECDSA and AES-GCM operations (shared with server)
- `/shared/keys.js` - Key loading and generation utilities

## Data Flow

### Server Registration

```
Server                    Coordinator
  │                           │
  │──register (ECDSA-signed)─→│
  │   (unencrypted)           │
  │                           │ Verify signature
  │                           │ Store challenge, expectedAnswer
  │                           │ Register IP:port
  │←─────── OK ──────────────│
  │                           │
```

### Client Connection

```
Client          Coordinator          Server
  │                  │                  │
  │──get challenge──→│                  │
  │←─────────────────│                  │
  │                  │                  │
  │ Compute answer   │                  │
  │ Gather ICE       │                  │
  │                  │                  │
  │──offer+answer───→│                  │
  │                  │ Verify answer    │
  │                  │──relay (AES)────→│
  │                  │                  │ Gather ICE
  │                  │                  │ Create answer
  │                  │←─answer (AES)────│
  │←─────────────────│                  │
  │                  │                  │
  │════════ WebRTC Datachannel ════════│
  │                  │                  │
```

### Keepalive

```
Server                    Coordinator
  │                           │
  │──ping (AES-encrypted)────→│
  │   every 30s               │ Update timestamp
  │                           │
  │──heartbeat (AES-GCM)────→│
  │   every 10 min            │ Decrypt & verify
  │                           │ Update challenge
  │                           │
```

## Coordinator State

Memory-compact registry design:

```javascript
Map<serverPublicKey, {
  ipPort: string,              // For UDP message routing
  challenge: string,           // Current challenge (16 bytes hex)
  expectedAnswer: string,      // SHA-256 hash for verification
  timestamp: number            // Last activity (for cleanup)
}>

// Separate connection log for rate limiting
Map<clientId, Array<timestamp>>
```

**Properties**:
- ~150 bytes per server
- O(1) lookup by public key
- O(1) lookup by IP:port (linear scan, acceptable for < 10K servers)
- Periodic cleanup removes expired entries
- No persistent storage required

## Protocol Layers

### Layer 1: Transport
- UDP for server-coordinator (low latency, NAT-friendly)
- HTTPS for client-coordinator (firewall-friendly)
- WebRTC for client-server (direct P2P)

### Layer 2: Encryption
- AES-256-GCM for UDP messages (after registration)
- TLS for HTTPS (standard browser behavior)
- DTLS for WebRTC (automatic)

### Layer 3: Authentication
- ECDSA P-256 signatures
- AES-GCM authenticated encryption
- Challenge-response for authorization

### Layer 4: Application
- JSON message format
- Session management
- Service multiplexing

## Design Decisions

### Why UDP for Server-Coordinator?

- **Low Latency**: No TCP handshake overhead
- **NAT Traversal**: Keepalive maintains port mapping
- **Simplicity**: No connection state to manage
- **Efficiency**: Minimal protocol overhead

### Why HTTPS Polling for Client-Coordinator?

- **Firewall Friendly**: Works everywhere HTTP works
- **No WebSocket**: Simpler implementation
- **Stateless**: No connection state on coordinator
- **Simple**: Standard HTTP client libraries

### Why Not WebSockets?

- **Complexity**: Additional protocol layer
- **State**: Connection state on server
- **Overkill**: Polling sufficient for signaling
- **Constraints**: Project goal is minimal dependencies

### Why AES-CTR?

- **Stream Cipher**: No padding required
- **Efficiency**: Fast encryption/decryption
- **Random IV**: Prevents pattern analysis
- **Standard**: Well-supported in Node.js crypto

### Why Memory-Compact Registry?

- **Scalability**: Support 1000+ servers on modest hardware
- **Simplicity**: No database required
- **Speed**: In-memory lookups
- **Cleanup**: Automatic expiry handling

## Performance Characteristics

### Coordinator

- **Memory**: ~150 bytes per server + ~100 bytes per connection log entry
- **CPU**: Minimal (signature verification, AES encryption)
- **Network**: ~100 bytes per keepalive, ~200 bytes per challenge refresh
- **Throughput**: 1000+ signaling operations/second (single core)

### Server

- **Memory**: Minimal (single connection state)
- **CPU**: Low (AES encryption, signature generation)
- **Network**: ~100 bytes keepalive + ~200 bytes challenge refresh per 10 min

### Client

- **Memory**: Minimal (single connection state)
- **CPU**: Low (signature verification)
- **Network**: Long-polling (minimal overhead)

## Failure Modes

### Coordinator Failure

- Servers cannot register
- New clients cannot connect
- Existing dataChannels unaffected (direct P2P)
- **Mitigation**: Coordinator migration support allows seamless failover to backup coordinator

### Coordinator Migration

HomeChannel supports coordinator migration for scalability and redundancy:

- **Initiated by Coordinator**: Current coordinator sends MIGRATE message to server
- **Encrypted Payload**: Contains new coordinator's host, port, and ECDSA public key
- **Automatic Failover**: Server immediately attempts registration with new coordinator
- **Persistent Storage**: Failover coordinator info saved to `failover-coordinator.json`
- **Seamless Transition**: Server switches to new coordinator upon successful registration
- **Graceful Fallback**: Migration failure does not interrupt current connection

**Use Cases:**
- Load balancing across multiple coordinators
- Coordinator maintenance and upgrades without downtime
- Geographic distribution of coordinator infrastructure
- Automatic failover during coordinator issues

### Server Failure

- Coordinator detects via timeout (no keepalive)
- Automatic cleanup after timeout period
- Clients notified via polling
- **Mitigation**: Server auto-restart

### Network Partition

- UDP keepalive fails
- Server re-registers when network recovers
- Challenge reset on re-registration
- **Mitigation**: Exponential backoff retry

## Future Enhancements

- [ ] Multi-coordinator redundancy
- [ ] Geographic distribution
- [ ] Metrics and monitoring endpoints
- [ ] Load balancing for high traffic
- [ ] Persistent session storage (optional)
