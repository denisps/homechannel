# HomeChannel

**WebRTC datachannel to your home - Access VNC, SSH, and files from anywhere in the world**

HomeChannel is a lightweight, minimal-dependency solution for establishing secure WebRTC data channels to your home network from anywhere on the internet. Built entirely in JavaScript with security and efficiency in mind.

## 🌟 Features

- **Pure JavaScript**: No transpilation, no bundling, no build complexity
- **Minimal Dependencies**: Only essential packages for maximum security and reliability
- **Secure by Design**: ECDSA-signed communications, servers identified by public keys
- **Efficient Protocol**: UDP for server coordination, HTTPS (no WebSockets) for client communication
- **WebRTC Datachannel**: Peer-to-peer encrypted connections for actual data transfer
- **Versatile Access**: Support for VNC, SSH, file access, and custom protocols

## 📐 Architecture

HomeChannel consists of three independent components that work together to establish a **direct, client-initiated WebRTC datachannel** between the client and server:

```
┌──────────────┐                    ┌──────────────┐
│              │   HTTPS (polling)  │              │
│    Client    │◄──────────────────►│ Coordinator  │
│  (Browser)   │   No WebSockets    │  (Node.js)   │
│              │                    │ Has ECDSA    │
│  Verifies:   │                    │   Keys       │
│  - Coord sig │                    │              │
│  - Server sig│                    └──────┬───────┘
└──────────────┘                           │
       ║                                   │ UDP + ECDH
       ║ Direct WebRTC                     │ Periodic heartbeat
       ║  Datachannel                      │ Challenge refresh
       ║                            ┌──────▼───────┐
       ╚═══════════════════════════►│              │
                                    │    Server    │
                                    │  (Node.js)   │
                                    │  @Home       │
                                    │ Has ECDSA    │
                                    │   Keys       │
                                    └──────────────┘
                                           │
                          ┌────────────────┼────────────────┐
                          │                │                │
                      ┌───▼───┐       ┌───▼───┐       ┌───▼───┐
                      │  VNC  │       │  SSH  │       │ Files │
                      └───────┘       └───────┘       └───────┘
```

### Connection Flow

1. **Server Registration**: Server initiates connection to coordinator using ECDH, sends signed payload with challenge for clients
2. **Periodic Keepalive**: Server and coordinator exchange short UDP messages to keep ports open and refresh challenges
3. **Client Connection Request**: Client provides challenge answer to coordinator along with SDP offer + all ICE candidates
4. **Challenge Verification**: Coordinator verifies challenge answer (prevents brute-force/DDoS)
5. **Payload Exchange**: Coordinator delivers client payload to server; server responds with signed SDP answer + all ICE candidates
6. **Direct Channel Established**: Client and server establish direct WebRTC datachannel (peer-to-peer)

### 1. Client (Browser-based)

The client runs entirely in the browser using vanilla JavaScript and ES modules.

**Responsibilities:**
- User interface for connection management
- Provide challenge answer (derived from password)
- WebRTC peer connection initialization (creates offer)
- Gather all ICE candidates before sending to coordinator
- Signature verification of both coordinator and server responses
- Establish direct datachannel to server

**Communication:**
- HTTPS polling with coordinator (no WebSockets)
- Sends SDP offer + all ICE candidates in single request
- Receives SDP answer + all ICE candidates in single response
- Verifies coordinator's ECDSA signature
- Verifies server's ECDSA signature on received payload
- Direct WebRTC datachannel with server for actual data

**Key Files:**
- `/client/index.html` - Main UI
- `/client/js/main.js` - Application entry point
- `/client/js/webrtc.js` - WebRTC connection management
- `/client/js/crypto.js` - ECDSA signature verification and challenge answer derivation
- `/client/js/api.js` - Coordinator communication (HTTPS polling)
- `/client/js/config.js` - Configuration (coordinator and server keys)

### 2. Server (Home-side Node.js)

The server runs on your home network and provides access to local services.

**Responsibilities:**
- Initiates connection to coordinator using ECDH
- WebRTC peer connection handling (creates answer)
- Generates challenge for client authentication
- Signs all payloads with ECDSA private key
- Sends SDP answer + all ICE candidates to coordinator
- Local service proxying (VNC, SSH, files)
- Periodic heartbeat with coordinator to keep UDP ports open

**Communication:**
- UDP with coordinator for signaling (initiated by server)
- ECDH for initial secure communication with coordinator
- Periodic short UDP messages for keepalive and challenge refresh
- Verifies coordinator's ECDSA signature
- Direct WebRTC datachannel with client for data transfer

**Key Files:**
- `/server/index.js` - Main server entry point
- `/server/udp.js` - UDP communication with coordinator (ECDH + ECDSA)
- `/server/webrtc.js` - WebRTC connection handling
- `/server/crypto.js` - ECDSA signing and ECDH operations
- `/server/challenge.js` - Challenge generation and management
- `/server/services/` - Service-specific handlers (VNC, SSH, files)

### 3. Coordinator (Cloud-hosted Node.js)

The coordinator is a publicly accessible Node.js service that facilitates signaling between clients and servers.

**Responsibilities:**
- Has its own ECDSA key pair (trusted by both clients and servers)
- Server registration and management
- Verifies server payloads using server's public key
- Challenge-response verification for client authentication
- Payload relay between client and server
- Periodic UDP exchange with servers to keep ports open
- Challenge refresh management

**Communication:**
- HTTPS with clients (polling, no WebSockets)
- UDP with servers (accepts server-initiated connections)
- Signs all responses with coordinator's ECDSA private key
- Stateless where possible for scalability

**Key Files:**
- `/coordinator/index.js` - Main coordinator entry point
- `/coordinator/https.js` - HTTPS server for clients
- `/coordinator/udp.js` - UDP server for home servers (ECDH + ECDSA)
- `/coordinator/crypto.js` - ECDSA verification and ECDH operations
- `/coordinator/registry.js` - Server registration and challenge management
- `/coordinator/relay.js` - Payload relay between clients and servers

## 🔐 Security Model

### Three-Party Key System

Each component has its own ECDSA key pair:

1. **Coordinator Keys**: 
   - Has its own ECDSA key pair
   - Public key is trusted and saved by both clients and servers
   - Signs all messages it relays

2. **Server Keys**:
   - Each server has its own ECDSA key pair
   - Identified by its public key
   - Initiates connection to coordinator using ECDH
   - Signs all payloads sent through coordinator

3. **Client Trust**:
   - Stores coordinator's public key
   - Stores known server public keys
   - Verifies signatures from both coordinator and server

### Server-Coordinator Communication (ECDH + ECDSA)

**Initial Connection:**
- Server initiates UDP connection to coordinator
- Uses ECDH (Elliptic Curve Diffie-Hellman) for initial secure exchange
- Server verifies coordinator's ECDSA signature
- Coordinator verifies server's payload using server's public key

**Registration Message:**
```
Server → Coordinator:
{
  serverPublicKey: "...",
  challenge: "short-random-string",
  challengeAnswer: "expected-hash",
  signature: "server-ecdsa-signature"
}
```

**Periodic Heartbeat:**
- Short UDP messages every ~30 seconds
- Keeps UDP ports open for NAT traversal
- Refreshes challenge periodically
- Minimal bandwidth usage

### Challenge-Response Authentication

Prevents brute-force and DDoS attacks on home servers:

1. **Server generates challenge** when registering with coordinator
2. **Client must provide correct answer** (derived from password) to connect
3. **Coordinator verifies answer** before relaying client payload to server
4. **Challenge is short** to minimize bandwidth
5. **Challenge refreshes periodically** to maintain security

**Challenge Flow:**
```
Server: challenge = random_bytes(16)
Server: expectedAnswer = hash(challenge + shared_secret)

Client: answer = hash(challenge + password)
Coordinator: if (answer == expectedAnswer) → allow connection
```

### Signaling Security (ECDSA Signatures)

All payloads containing SDP and ICE candidates are ECDSA-signed:

**Client → Coordinator → Server:**
```javascript
{
  serverPublicKey: "target-server-key",
  challengeAnswer: "hash-of-challenge-plus-password",
  payload: {
    sdp: { type: 'offer', sdp: '...' },
    candidates: [/* all ICE candidates */]
  },
  coordinatorSignature: "coordinator-ecdsa-signature"
}
```

**Server → Coordinator → Client:**
```javascript
{
  payload: {
    sdp: { type: 'answer', sdp: '...' },
    candidates: [/* all ICE candidates */]
  },
  serverSignature: "server-ecdsa-signature",
  coordinatorSignature: "coordinator-ecdsa-signature"
}
```

**Key Features:**
- **P-256 Curve** (secp256r1): Industry-standard elliptic curve
- **Server Identity**: Each server identified by its ECDSA public key
- **No Traditional PKI**: Direct public key verification
- **Tamper-Proof**: Multiple signatures prevent MITM attacks
- **Full Candidate Exchange**: SDP + all ICE candidates sent together (not incrementally)

### Key Management

**Coordinator Keys:**
```bash
# Generate coordinator key pair (done once)
node coordinator/scripts/generate-keys.js

# Keys stored securely:
# - coordinator-private.key (keep secret, 600 permissions)
# - coordinator-public.key (distributed to all clients and servers)
```

**Server Keys:**
```bash
# Generate server key pair (done once per server)
node server/scripts/generate-keys.js

# Keys stored securely:
# - server-private.key (keep secret, 600 permissions)
# - server-public.key (share with clients who need access)
```

**Key Distribution:**
- Coordinator public key: Embedded in client and server configurations
- Server public keys: Distributed to clients via secure channel (QR code, config file, or manual entry)
- Clients verify all signatures before trusting data

### WebRTC Security

Once signaling is complete and verified:
- **DTLS**: All WebRTC dataChannels use DTLS encryption
- **Peer-to-Peer**: Direct connection between client and server
- **Coordinator Cannot Intercept**: Only helps establish connection, cannot see data

## 🚀 Getting Started

### Prerequisites

- **Node.js**: v18 or higher
- **Modern Browser**: Chrome, Firefox, or Edge with WebRTC support
- **Home Server**: Machine on your home network to run the server component
- **Coordinator**: Public server or cloud instance for the coordinator

### Installation

#### 1. Clone the Repository

```bash
git clone https://github.com/denisps/homechannel.git
cd homechannel
```

#### 2. Set Up the Server (Home)

```bash
cd server
npm install

# Generate ECDSA key pair
node scripts/generate-keys.js

# Configure server
cp config.example.json config.json
# Edit config.json with your coordinator address

# Run server
node index.js
```

#### 3. Set Up the Coordinator (Public Server)

```bash
cd coordinator
npm install

# Configure coordinator
cp config.example.json config.json
# Edit config.json with desired ports and settings

# Run coordinator
node index.js
```

#### 4. Set Up the Client (Browser)

```bash
cd client

# For development:
# Serve with any static file server
python3 -m http.server 8080
# Or use: npx http-server -p 8080

# For production:
# Deploy to any static hosting (GitHub Pages, Netlify, etc.)
```

### Configuration

#### Server Configuration (`server/config.json`)

```json
{
  "coordinatorHost": "coordinator.example.com",
  "coordinatorPort": 3478,
  "coordinatorPublicKey": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----",
  "serverName": "my-home-server",
  "privateKeyPath": "./keys/private.key",
  "publicKeyPath": "./keys/public.key",
  "challengeRefreshInterval": 3600000,
  "sharedSecret": "password-for-challenge-answer",
  "services": {
    "vnc": {
      "enabled": true,
      "port": 5900
    },
    "ssh": {
      "enabled": true,
      "port": 22
    },
    "files": {
      "enabled": true,
      "rootPath": "/home/user/shared"
    }
  }
}
```

#### Coordinator Configuration (`coordinator/config.json`)

```json
{
  "https": {
    "port": 443,
    "certPath": "./certs/fullchain.pem",
    "keyPath": "./certs/privkey.pem"
  },
  "udp": {
    "port": 3478
  },
  "privateKeyPath": "./keys/coordinator-private.key",
  "publicKeyPath": "./keys/coordinator-public.key",
  "maxServers": 1000,
  "serverTimeout": 300000,
  "heartbeatInterval": 30000
}
```

#### Client Configuration

Edit `client/js/config.js`:

```javascript
export const config = {
  coordinatorUrl: 'https://coordinator.example.com',
  coordinatorPublicKey: '-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----',
  pollInterval: 5000,
  knownServers: {
    'server-key-hash-1': {
      name: 'My Home Server',
      publicKey: '-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----',
      password: '' // Client derives challenge answer from this
    }
  }
};
```

## 📡 Communication Protocols

### UDP Protocol (Server ↔ Coordinator)

Server **initiates** UDP connection to coordinator using ECDH.

**Registration Message:**
```javascript
{
  type: 'register',
  serverPublicKey: 'hex-encoded-ecdsa-public-key',
  timestamp: Date.now(),
  payload: {
    serverName: 'my-home-server',
    challenge: 'short-random-bytes-hex',
    challengeAnswerHash: 'sha256-hash-of-answer',
    ecdhPublicKey: 'ecdh-public-key-for-initial-exchange'
  },
  signature: 'hex-encoded-ecdsa-signature'
}
```

**Heartbeat Message (every ~30s):**
```javascript
{
  type: 'heartbeat',
  serverPublicKey: 'hex-encoded-ecdsa-public-key',
  timestamp: Date.now(),
  payload: {
    refreshChallenge: 'new-challenge-hex', // optional, when refreshing
    challengeAnswerHash: 'new-hash' // optional
  },
  signature: 'hex-encoded-ecdsa-signature'
}
```

**Answer Message (response to client offer):**
```javascript
{
  type: 'answer',
  serverPublicKey: 'hex-encoded-ecdsa-public-key',
  sessionId: 'client-session-id',
  timestamp: Date.now(),
  payload: {
    sdp: { type: 'answer', sdp: '...' },
    candidates: [
      // ALL ICE candidates gathered by server
      { candidate: '...', sdpMLineIndex: 0, sdpMid: 'data' },
      // ...
    ]
  },
  signature: 'hex-encoded-ecdsa-signature'
}
```

**Coordinator Response:**
```javascript
{
  status: 'ok' | 'error',
  timestamp: Date.now(),
  signature: 'coordinator-ecdsa-signature'
}
```

### HTTPS Protocol (Client ↔ Coordinator)

Client connects to coordinator via standard HTTPS (no WebSockets).

**Endpoints:**

#### `GET /api/coordinator-key`
Get coordinator's public key (for first-time setup).

**Response:**
```javascript
{
  publicKey: '-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----',
  signature: 'self-signed-for-verification'
}
```

#### `POST /api/servers`
List available servers that client knows about.

**Request:**
```javascript
{
  serverPublicKeys: ['key1-hash', 'key2-hash'] // servers client wants to see
}
```

**Response:**
```javascript
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

#### `POST /api/connect`
Initiate connection to server (with challenge answer, SDP offer, and all ICE candidates).

**Request:**
```javascript
{
  serverPublicKey: 'target-server-public-key-hash',
  challengeAnswer: 'hash-of-challenge-plus-password',
  payload: {
    sdp: { type: 'offer', sdp: '...' },
    candidates: [
      // ALL ICE candidates gathered by client before sending
      { candidate: '...', sdpMLineIndex: 0, sdpMid: 'data' },
      // ...
    ]
  },
  timestamp: Date.now()
}
```

**Response:**
```javascript
{
  success: true,
  sessionId: 'unique-session-id',
  message: 'Waiting for server response',
  coordinatorSignature: 'coordinator-ecdsa-signature'
}
```

#### `POST /api/poll`
Poll for server response (gets SDP answer + all ICE candidates).

**Request:**
```javascript
{
  sessionId: 'unique-session-id',
  lastUpdate: 1234567890 // timestamp
}
```

**Response (when server responds):**
```javascript
{
  success: true,
  payload: {
    sdp: { type: 'answer', sdp: '...' },
    candidates: [
      // ALL ICE candidates from server
      { candidate: '...', sdpMLineIndex: 0, sdpMid: 'data' },
      // ...
    ]
  },
  serverSignature: 'server-ecdsa-signature',
  coordinatorSignature: 'coordinator-ecdsa-signature'
}
```

**Response (while waiting):**
```javascript
{
  success: false,
  waiting: true,
  coordinatorSignature: 'coordinator-ecdsa-signature'
}
```

## 🔧 Development

### Project Structure

```
homechannel/
├── client/
│   ├── index.html
│   ├── css/
│   │   └── style.css
│   └── js/
│       ├── main.js
│       ├── webrtc.js
│       ├── crypto.js         # ECDSA verification, challenge answer
│       ├── api.js            # HTTPS polling to coordinator
│       └── config.js         # Coordinator + server keys
├── server/
│   ├── index.js
│   ├── udp.js                # UDP with ECDH + ECDSA
│   ├── webrtc.js
│   ├── crypto.js             # ECDSA signing, ECDH
│   ├── challenge.js          # Challenge generation
│   ├── config.json
│   ├── keys/
│   │   ├── private.key       # Server ECDSA private key
│   │   └── public.key        # Server ECDSA public key
│   ├── services/
│   │   ├── vnc.js
│   │   ├── ssh.js
│   │   └── files.js
│   ├── scripts/
│   │   └── generate-keys.js
│   └── package.json
├── coordinator/
│   ├── index.js
│   ├── https.js              # HTTPS server for clients
│   ├── udp.js                # UDP with ECDH + ECDSA
│   ├── crypto.js             # ECDSA verification, ECDH
│   ├── registry.js           # Server registry + challenges
│   ├── relay.js              # Payload relay
│   ├── config.json
│   ├── keys/
│   │   ├── coordinator-private.key
│   │   └── coordinator-public.key
│   ├── scripts/
│   │   └── generate-keys.js
│   └── package.json
├── .github/
│   └── copilot-instructions.md
├── LICENSE
└── README.md
```

### Coding Standards

- **Pure JavaScript**: ES6+ syntax, no TypeScript
- **ES Modules**: Use `import`/`export` in client, CommonJS or ES modules in Node.js
- **Minimal Dependencies**: Only add dependencies that are absolutely necessary
- **No Build Tools**: Code should run without transpilation
- **Async/Await**: Prefer async/await over raw Promises
- **Error Handling**: Always handle errors explicitly

### Testing

```bash
# Run server tests
cd server
npm test

# Run coordinator tests
cd coordinator
npm test

# Client tests run in browser
cd client
npm test
```

## 🛠️ Troubleshooting

### Connection Issues

**Symptom**: Client cannot connect to server

**Solutions**:
1. Verify coordinator is running and accessible
2. Check server is registered with coordinator (check coordinator logs)
3. Verify firewall allows UDP on coordinator port
4. Check NAT traversal - may need STUN/TURN servers for some networks

### Signature Verification Failures

**Symptom**: "Invalid signature" errors

**Solutions**:
1. Verify server public key is correctly configured in client
2. Check clock synchronization on all systems
3. Verify private key file permissions (should be 600)
4. Regenerate keys if corrupted

### Performance Issues

**Symptom**: Slow connection or high latency

**Solutions**:
1. Check network bandwidth on both sides
2. Verify WebRTC is establishing direct peer connection (check ICE candidates)
3. Consider adding TURN server for relay if direct connection fails
4. Monitor CPU usage on server for service bottlenecks

## 📚 API Reference

### Server API

```javascript
// Server instance
const server = new HomeChannelServer(config);

// Start server
await server.start();

// Register with coordinator
await server.register();

// Handle incoming connection
server.on('connection', (peer) => {
  // Handle datachannel messages
});
```

### Client API

```javascript
// Create client instance
const client = new HomeChannelClient(config);

// Connect to server
const connection = await client.connect(serverId);

// Send data over datachannel
connection.send(data);

// Receive data
connection.on('data', (data) => {
  // Handle received data
});
```

## 🤝 Contributing

Contributions are welcome! Please follow these guidelines:

1. **Keep it Simple**: Maintain the minimal-dependency philosophy
2. **Pure JavaScript**: No TypeScript, no build tools unless absolutely necessary
3. **Security First**: All security-related changes require thorough review
4. **Test Your Changes**: Ensure existing functionality is not broken
5. **Document**: Update README and code comments as needed

### Pull Request Process

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## 📄 License

This project is licensed under the GNU General Public License v3.0 - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- WebRTC community for excellent documentation
- Node.js community for reliable runtime
- ECDSA and elliptic curve cryptography researchers

## 📞 Support

- **Issues**: [GitHub Issues](https://github.com/denisps/homechannel/issues)
- **Discussions**: [GitHub Discussions](https://github.com/denisps/homechannel/discussions)

## 🗺️ Roadmap

- [ ] Initial implementation of all three components
- [ ] Key generation and management tools
- [ ] Support for VNC protocol
- [ ] Support for SSH protocol  
- [ ] File access implementation
- [ ] STUN/TURN server support for NAT traversal
- [ ] Mobile client support
- [ ] Performance optimizations
- [ ] Comprehensive test suite
- [ ] Docker deployment examples
- [ ] Kubernetes deployment examples

---

**Built with ❤️ for secure, private access to your home network**
