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

HomeChannel consists of three independent components that work together:

```
┌──────────────┐                    ┌──────────────┐
│              │   HTTPS (polling)  │              │
│    Client    │◄──────────────────►│ Coordinator  │
│  (Browser)   │   No WebSockets    │   (Node.js)  │
│              │                    │              │
└──────────────┘                    └──────┬───────┘
                                           │
                                           │ UDP
                                           │
                                    ┌──────▼───────┐
                                    │              │
                                    │    Server    │
                                    │  (Node.js)   │
                                    │  @Home       │
                                    └──────────────┘
                                           │
                          ┌────────────────┼────────────────┐
                          │                │                │
                      ┌───▼───┐       ┌───▼───┐       ┌───▼───┐
                      │  VNC  │       │  SSH  │       │ Files │
                      └───────┘       └───────┘       └───────┘
```

### 1. Client (Browser-based)

The client runs entirely in the browser using vanilla JavaScript and ES modules.

**Responsibilities:**
- User interface for connection management
- WebRTC peer connection initialization
- SDP offer/answer handling
- ICE candidate collection and exchange
- Signature verification of server responses

**Communication:**
- HTTPS polling or long-polling with coordinator
- No WebSocket connections
- All SDPs and ICE candidates are ECDSA-signed

**Key Files:**
- `/client/index.html` - Main UI
- `/client/js/main.js` - Application entry point
- `/client/js/webrtc.js` - WebRTC connection management
- `/client/js/crypto.js` - ECDSA signature verification
- `/client/js/api.js` - Coordinator communication

### 2. Server (Home-side Node.js)

The server runs on your home network and provides access to local services.

**Responsibilities:**
- WebRTC peer connection handling
- Local service proxying (VNC, SSH, files)
- Registration and heartbeat with coordinator
- SDP answer generation
- ICE candidate handling
- Message signing with ECDSA private key

**Communication:**
- UDP with coordinator for signaling
- WebRTC datachannel with client for data transfer
- Efficient binary protocol for minimal overhead

**Key Files:**
- `/server/index.js` - Main server entry point
- `/server/udp.js` - UDP communication with coordinator
- `/server/webrtc.js` - WebRTC connection handling
- `/server/crypto.js` - ECDSA signing operations
- `/server/services/` - Service-specific handlers (VNC, SSH, files)

### 3. Coordinator (Cloud-hosted Node.js)

The coordinator is a publicly accessible Node.js service that facilitates signaling.

**Responsibilities:**
- Server registration and management
- Client request handling
- SDP and ICE candidate relay
- Signature verification for both clients and servers
- Server discovery and routing

**Communication:**
- HTTPS with clients (polling/long-polling)
- UDP with servers
- Stateless where possible for scalability

**Key Files:**
- `/coordinator/index.js` - Main coordinator entry point
- `/coordinator/https.js` - HTTPS server for clients
- `/coordinator/udp.js` - UDP server for home servers
- `/coordinator/crypto.js` - ECDSA verification
- `/coordinator/registry.js` - Server registration management

## 🔐 Security Model

### ECDSA Signature-Based Authentication

All signaling messages (SDPs and ICE candidates) are signed using ECDSA (Elliptic Curve Digital Signature Algorithm).

**Key Features:**
- **P-256 Curve** (secp256r1): Industry-standard elliptic curve
- **Server Identity**: Each server is identified by its ECDSA public key
- **No PKI Required**: Direct public key verification
- **Tamper-Proof**: Signatures prevent man-in-the-middle attacks during signaling

**Trust Model:**
- Trust-on-first-use (TOFU) or pre-shared public keys
- Client stores known server public keys
- Coordinator verifies server signatures
- Client verifies all server responses

### Key Management

**Server Keys:**
```bash
# Generate server key pair (done once per server)
node server/scripts/generate-keys.js

# Keys stored securely:
# - private.key (keep secret, 600 permissions)
# - public.key (share with clients)
```

**Key Distribution:**
- Server public keys distributed to clients via secure channel
- QR code, configuration file, or manual entry
- Clients verify all signed messages from servers

### WebRTC Security

Once the signaling is complete and verified:
- **DTLS**: All WebRTC connections use DTLS encryption
- **SRTP**: Media streams encrypted with SRTP
- **Peer-to-peer**: Direct connection, coordinator cannot intercept data

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
  "serverName": "my-home-server",
  "privateKeyPath": "./keys/private.key",
  "publicKeyPath": "./keys/public.key",
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
  "maxServers": 1000,
  "serverTimeout": 300000
}
```

#### Client Configuration

Edit `client/js/config.js`:

```javascript
export const config = {
  coordinatorUrl: 'https://coordinator.example.com',
  pollInterval: 5000,
  knownServers: {
    'my-home-server': {
      name: 'My Home Server',
      publicKey: '-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----'
    }
  }
};
```

## 📡 Communication Protocols

### UDP Protocol (Server ↔ Coordinator)

**Message Format:**
```javascript
{
  type: 'register' | 'heartbeat' | 'sdp' | 'candidate',
  serverId: 'server-public-key-hash',
  timestamp: 1234567890,
  payload: { /* type-specific data */ },
  signature: 'hex-encoded-ecdsa-signature'
}
```

**Message Types:**
- `register`: Server registration with coordinator
- `heartbeat`: Periodic keepalive (every 30s)
- `sdp`: SDP answer from server
- `candidate`: ICE candidate from server

### HTTPS Protocol (Client ↔ Coordinator)

**Endpoints:**

- `POST /api/servers` - List available servers
- `POST /api/connect` - Initiate connection to server
- `POST /api/poll` - Long-polling for server responses
- `POST /api/candidate` - Send ICE candidate to server

**Request/Response Format:**
```javascript
// Request
{
  action: 'connect',
  serverId: 'server-public-key-hash',
  sdp: { /* WebRTC SDP offer */ },
  signature: 'client-signature-if-needed'
}

// Response
{
  success: true,
  data: {
    sdp: { /* WebRTC SDP answer */ },
    signature: 'server-ecdsa-signature'
  }
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
│       ├── crypto.js
│       ├── api.js
│       └── config.js
├── server/
│   ├── index.js
│   ├── udp.js
│   ├── webrtc.js
│   ├── crypto.js
│   ├── config.json
│   ├── keys/
│   │   ├── private.key
│   │   └── public.key
│   ├── services/
│   │   ├── vnc.js
│   │   ├── ssh.js
│   │   └── files.js
│   ├── scripts/
│   │   └── generate-keys.js
│   └── package.json
├── coordinator/
│   ├── index.js
│   ├── https.js
│   ├── udp.js
│   ├── crypto.js
│   ├── registry.js
│   ├── config.json
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
