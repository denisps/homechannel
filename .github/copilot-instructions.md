# HomeChannel Copilot Instructions

## Project Overview
HomeChannel is a minimal, dependency-light WebRTC datachannel solution for remote access to home systems (VNC, SSH, file access). The project is written entirely in JavaScript with no transpilation or bundling required.

## Project Structure

The project consists of three independent components:

### 1. Client (`/client`)
- **Runtime**: Browser (vanilla JavaScript)
- **Communication**: HTTPS with coordinator (no WebSockets)
- **Purpose**: Browser-based interface for initiating and managing WebRTC connections

### 2. Server (`/server`)
- **Runtime**: Node.js
- **Communication**: UDP with coordinator
- **Purpose**: Home-side endpoint that provides access to local services

### 3. Coordinator (`/coordinator`)
- **Runtime**: Node.js
- **Communication**: 
  - UDP with server
  - HTTPS with client (no WebSockets)
- **Purpose**: Signaling and coordination between clients and servers

## Technology Constraints

### Core Requirements
- **Language**: Pure JavaScript (ES modules preferred)
- **Dependencies**: Minimal - only essential packages
- **No Transpilation**: Code should run directly without build steps where possible
- **No WebSockets**: Use HTTP/HTTPS polling or long-polling for client-coordinator communication
- **No Bundling**: Client code should work with native ES modules

### Allowed Dependencies Examples
- Node.js built-in modules (`crypto`, `https`, `dgram`, `fs`, etc.)
- Essential cryptographic libraries if needed beyond Node.js crypto
- Minimal HTTP frameworks (e.g., `express` only if absolutely necessary)

## Architecture Patterns

### Communication Protocols

#### Server ↔ Coordinator (UDP)
- Use Node.js `dgram` module
- Implement packet framing for reliability
- Handle packet loss and retransmission if necessary
- Keep overhead minimal

#### Client ↔ Coordinator (HTTPS)
- Use standard HTTP methods (GET/POST)
- Implement polling or long-polling for updates
- No WebSocket connections
- Keep connection overhead minimal

### Security Model

#### ECDSA Signing and Public Key Infrastructure
- **Coordinator** has its own ECDSA key pair (public key accepted and saved by both clients and servers)
- **Servers** identified by their ECDSA public keys
- **Server initiates** communication with coordinator using ECDH (Elliptic Curve Diffie-Hellman)
- Use P-256 (secp256r1) curve for compatibility
- All payloads are ECDSA-signed:
  - Coordinator verifies server payloads using server's public key
  - Server verifies coordinator responses using coordinator's public key
  - Client verifies both coordinator and server signatures

#### Challenge-Response Authentication
- **Server generates challenge** for each connection attempt (included in payload to coordinator)
- **Client must answer challenge correctly** to proceed (verifies client knows password)
- **Purpose**: Prevents brute-force attacks and DDoS on the server
- **Challenge refresh**: Coordinator and server periodically exchange short UDP messages to:
  - Keep UDP ports open (NAT hole-punching)
  - Refresh challenges from time to time
- Challenge is short to minimize bandwidth

#### WebRTC Signaling Flow
1. Server registers with coordinator, includes challenge for clients
2. Client connects to coordinator, provides challenge answer
3. If challenge answer is correct, coordinator delivers client's payload (SDP + all ICE candidates) to server
4. Server replies with its own signed payload (SDP + all ICE candidates)
5. Coordinator delivers server payload to client
6. **Direct datachannel** established between client and server (peer-to-peer)

## Coding Standards

### JavaScript Style
- Use modern ES6+ features
- Use `const` and `let`, never `var`
- Use arrow functions where appropriate
- Use template literals for string formatting
- Use async/await over raw Promises
- Use destructuring where it improves readability

### Module System
- Use ES modules (`import`/`export`) for client code
- Use CommonJS (`require`/`module.exports`) or ES modules for Node.js code
- Keep module dependencies clear and minimal

### Error Handling
- Always handle errors explicitly
- Use try/catch with async/await
- Provide meaningful error messages
- Log errors appropriately (console.error in client, proper logging in server)

### Code Organization
- Keep files focused and small
- Separate concerns clearly
- Use descriptive file and function names
- Avoid deep nesting

### Documentation
- Document complex algorithms
- Explain non-obvious design decisions
- Keep README files up to date
- Use JSDoc comments for public APIs

## Security Guidelines

### Cryptographic Operations
- Never implement custom crypto algorithms
- Use established libraries or Node.js crypto module
- Validate all signatures before trusting data
- Use constant-time comparison for sensitive data

### Input Validation
- Validate all network inputs
- Sanitize data before use
- Implement rate limiting where appropriate
- Check message sizes and bounds

### Key Management
- Never commit private keys to repository
- Store keys securely on filesystem with appropriate permissions
- Implement key rotation mechanisms
- Document key generation process

## Performance Guidelines

### Resource Usage
- Minimize memory allocation
- Avoid unnecessary copying of data
- Use streams for large data transfers
- Implement backpressure handling

### Network Efficiency
- Batch operations where possible
- Implement connection pooling if needed
- Use compression for large payloads
- Minimize protocol overhead

## Testing Guidelines

### Test Structure
- Write tests for critical paths
- Test error conditions
- Test cryptographic operations thoroughly
- Test network protocol edge cases

### Test Files
- Place tests near the code they test
- Use descriptive test names
- Keep tests independent
- Mock external dependencies

## Development Workflow

### Before Committing
- Test your changes locally
- Verify no unnecessary dependencies added
- Check for console.log statements (remove or make configurable)
- Ensure code follows style guidelines

### Pull Requests
- Keep changes focused and small
- Provide clear description
- Update documentation as needed
- Ensure tests pass

## Common Patterns

### UDP Message Format
```javascript
// Server -> Coordinator registration message
{
  type: 'register',
  serverPublicKey: 'hex-encoded-ecdsa-public-key',
  timestamp: Date.now(),
  payload: {
    challenge: 'short-random-challenge-for-client',
    challengeAnswer: 'expected-answer-hash'
  },
  signature: 'hex-encoded-ecdsa-signature'
}

// Periodic keepalive (every ~30s)
{
  type: 'heartbeat',
  serverPublicKey: 'hex-encoded-ecdsa-public-key',
  timestamp: Date.now(),
  payload: {
    newChallenge: 'refreshed-challenge' // optional
  },
  signature: 'hex-encoded-ecdsa-signature'
}

// Server -> Coordinator: SDP answer + all ICE candidates
{
  type: 'answer',
  serverPublicKey: 'hex-encoded-ecdsa-public-key',
  timestamp: Date.now(),
  payload: {
    sessionId: 'client-session-id',
    sdp: { type: 'answer', sdp: '...' },
    candidates: [/* all ICE candidates */]
  },
  signature: 'hex-encoded-ecdsa-signature'
}
```

### HTTPS Polling Pattern
```javascript
// Client connects to server through coordinator
async function connectToServer(serverPublicKey, challengeAnswer, sdp, candidates) {
  try {
    const response = await fetch('/api/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        serverPublicKey: serverPublicKey,
        challengeAnswer: challengeAnswer,
        payload: {
          sdp: sdp, // WebRTC offer
          candidates: candidates // All gathered ICE candidates
        },
        signature: 'client-signature-if-needed'
      })
    });
    const data = await response.json();
    
    // Verify coordinator and server signatures
    if (verifyCoordinatorSignature(data) && verifyServerSignature(data.serverPayload)) {
      // Use server's SDP answer and ICE candidates
      return data.serverPayload;
    }
  } catch (error) {
    console.error('Connection error:', error);
  }
}
```

### ECDSA Signing and ECDH Pattern
```javascript
const crypto = require('crypto');

// ECDSA signing (for payloads)
function signData(data, privateKey) {
  const sign = crypto.createSign('SHA256');
  sign.update(JSON.stringify(data));
  return sign.sign(privateKey, 'hex');
}

function verifySignature(data, signature, publicKey) {
  const verify = crypto.createVerify('SHA256');
  verify.update(JSON.stringify(data));
  return verify.verify(publicKey, signature, 'hex');
}

// ECDH for initial server-coordinator communication
function performECDH(privateKey, coordinatorPublicKey) {
  const ecdh = crypto.createECDH('prime256v1'); // P-256 curve
  ecdh.setPrivateKey(privateKey);
  const sharedSecret = ecdh.computeSecret(coordinatorPublicKey);
  return sharedSecret;
}

// Challenge-response pattern
function generateChallenge() {
  return crypto.randomBytes(16).toString('hex'); // Short challenge
}

function hashChallengeAnswer(challenge, password) {
  const hash = crypto.createHash('sha256');
  hash.update(challenge + password);
  return hash.digest('hex');
}
```

## Forbidden Practices

- ❌ Adding heavy frameworks (React, Vue, Angular, etc.)
- ❌ Using WebSockets
- ❌ Adding build tools unless absolutely necessary (webpack, rollup, etc.)
- ❌ Using TypeScript (pure JavaScript only)
- ❌ Implementing custom cryptography
- ❌ Committing sensitive keys or credentials
- ❌ Using synchronous file operations in server code
- ❌ Blocking the event loop with CPU-intensive operations

## Recommended Practices

- ✅ Use native Node.js modules
- ✅ Keep dependencies minimal and audited
- ✅ Write clear, self-documenting code
- ✅ Implement proper error handling
- ✅ Use ECDSA for all signature operations
- ✅ Validate and sanitize all inputs
- ✅ Write tests for critical functionality
- ✅ Document API endpoints and message formats
- ✅ Use semantic versioning
- ✅ Keep the codebase simple and maintainable
