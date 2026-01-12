# HomeChannel

A minimal-dependency WebRTC datachannel solution for secure remote access to home systems (VNC, SSH, file access).

## Overview

HomeChannel enables direct peer-to-peer connections between browser clients and home servers through a lightweight coordinator. Built with pure JavaScript, zero bundling, and minimal dependencies.

### Key Features

- **Zero Build Tooling**: Pure JavaScript (ES modules), no transpilation or bundling
- **Minimal Dependencies**: Uses only Node.js built-in modules
- **Direct P2P**: WebRTC datachannel between client and server
- **Secure**: ECDSA signatures, AES-CTR encryption, challenge-response authentication
- **Lightweight**: Memory-compact design, optimized protocol
- **NAT-Friendly**: Efficient keepalive and NAT traversal

## Architecture

```
┌─────────────────┐         ┌──────────────────┐         ┌─────────────────┐
│  Client         │◄───────►│   Coordinator    │◄───────►│  Home Server    │
│  (Browser)      │  HTTPS  │   (Public)       │   UDP   │  (Local Net)    │
│                 │ Polling │                  │ AES-CTR │                 │
└────────┬────────┘         └──────────────────┘         └────────┬────────┘
         │                                                          │
         │                 WebRTC Datachannel (Direct P2P)         │
         └──────────────────────────────────────────────────────────┘
                                    │
                            ┌───────▼────────┐
                            │  VNC, SSH,     │
                            │  File Access   │
                            └────────────────┘
```

**Three Components:**

1. **Client** (Browser): Initiates connections via HTTPS polling to coordinator
2. **Coordinator** (Public Node.js): Facilitates signaling, verifies challenges
3. **Server** (Home Node.js): Provides access to local services via WebRTC

## Quick Start

### Prerequisites

- Node.js 18+
- Modern browser with WebRTC support

### Installation

```bash
# Clone repository
git clone https://github.com/denisps/homechannel.git
cd homechannel

# Set up coordinator (on public server)
cd coordinator
cp config.example.json config.json
# Edit config.json with your settings
npm test  # Verify installation
npm start

# Set up server (on home network)
cd ../server
# Configure server (coming soon)

# Access client
# Open client/index.html in browser (coming soon)
```

## Security Model

- **ECDSA P-256**: Initial handshake and signature verification
- **AES-CTR Encryption**: All server-coordinator UDP messages (except registration)
- **Challenge-Response**: Prevents brute-force and DDoS attacks
- **HMAC Authentication**: For ongoing communication integrity
- **Direct Datachannel**: Coordinator cannot intercept peer data

## Protocol

### Server ↔ Coordinator (UDP)
- **Registration**: ECDSA-signed, unencrypted (initial ECDH)
- **Keepalive**: AES-CTR encrypted, every 30s
- **Challenge Refresh**: AES-CTR encrypted, every 10 minutes

### Client ↔ Coordinator (HTTPS)
- Standard polling (no WebSockets)
- Challenge verification before connection
- Signed SDP and ICE candidates relay

See [PROTOCOL.md](docs/PROTOCOL.md) for detailed specifications.

## Documentation

- [PROTOCOL.md](docs/PROTOCOL.md) - Detailed protocol specifications
- [SECURITY.md](docs/SECURITY.md) - Security architecture and cryptography
- [ARCHITECTURE.md](docs/ARCHITECTURE.md) - System design and components
- [coordinator/README.md](coordinator/README.md) - Coordinator implementation
- [.github/copilot-instructions.md](.github/copilot-instructions.md) - Development guidelines

## Development

```bash
# Run coordinator tests
cd coordinator
npm test

# Run in watch mode
npm run test:watch
```

**Technology Constraints:**
- Pure JavaScript (no TypeScript)
- ES modules for client, CommonJS/ES modules for Node.js
- No build tooling or bundling
- Minimal dependencies only

## Project Status

**Alpha**: API and protocol are subject to change.

## Roadmap

- [x] Coordinator implementation with tests
- [x] AES-CTR encryption for UDP communication
- [ ] Server implementation
- [ ] Client implementation
- [ ] HTTPS endpoints for client-coordinator communication
- [ ] End-to-end integration tests
- [ ] Documentation and examples
- [ ] Performance optimizations

## Contributing

Contributions welcome! Please read [.github/copilot-instructions.md](.github/copilot-instructions.md) for development guidelines.

## License

GPL-3.0 - See [LICENSE](LICENSE) for details.

## Credits

Designed for minimal resource usage and maximum simplicity.
