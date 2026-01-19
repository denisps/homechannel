# HomeChannel Copilot Instructions

## Project Overview
HomeChannel is a minimal-dependency WebRTC datachannel solution for remote access to home systems (VNC, SSH, file access). Pure JavaScript, no transpilation or bundling.

## Core Principles

- **Pure JavaScript**: ES modules for client, CommonJS/ES modules for Node.js
- **Zero Build Tools**: No transpilation, bundling, or compilation
- **Minimal Dependencies**: Node.js built-in modules only
- **No WebSockets**: HTTP/HTTPS polling for client-coordinator
- **Alpha Status**: API and protocol subject to change

## Project Structure

```
homechannel/
├── client/          # Browser (vanilla JS, ES modules)
├── server/          # Home Node.js (UDP to coordinator)
├── coordinator/     # Public Node.js (UDP + HTTPS)
└── docs/            # Detailed documentation
```

## Documentation

**Refer to these files for detailed specs:**
- `README.md` - Project overview and quick start
- `docs/PROTOCOL.md` - Protocol specifications
- `docs/SECURITY.md` - Security architecture
- `docs/ARCHITECTURE.md` - System design
- `coordinator/README.md` - Coordinator implementation details

## Security Model

### Three-Party ECDSA Keys
- **Coordinator**: Has own ECDSA key pair (trusted by both)
- **Servers**: Identified by ECDSA public keys
- **Client**: Verifies signatures from coordinator and server

### Communication Security
- **Registration**: ECDSA-signed, encrypted with ECDH shared secret
- **Ongoing UDP**: AES-256-GCM authenticated encryption using expectedAnswer as key
- **Challenge-Response**: Prevents brute-force and DDoS

### Encryption Details
- **AES Key**: Derived from expectedAnswer via SHA-256
- **IV**: Random 12 bytes per message (GCM standard)
- **Auth Tag**: 16 bytes (GCM provides both encryption and authentication)

## Coordinator State

Memory-compact registry:
```javascript
Map<serverPublicKey, {
  ipPort: string,          // For UDP routing
  challenge: string,       // 16 bytes hex
  expectedAnswer: string,  // SHA-256 hash, also AES key source
  timestamp: number        // For cleanup
}>
```

- Periodic cleanup of expired servers
- Separate connection log for rate limiting

## Code Examples

### AES-GCM Encryption
```javascript
function deriveAESKey(expectedAnswer) {
  const hash = crypto.createHash('sha256');
  hash.update(expectedAnswer);
  return hash.digest(); // 256-bit key
}

function encryptAES(data, key) {
  const iv = crypto.randomBytes(12);  // 12 bytes for GCM
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const dataBuffer = Buffer.from(JSON.stringify(data), 'utf8');
  const encrypted = Buffer.concat([cipher.update(dataBuffer), cipher.final()]);
  const authTag = cipher.getAuthTag();  // 16 bytes authentication tag
  return Buffer.concat([iv, authTag, encrypted]);
}

function decryptAES(encryptedBuffer, key) {
  const iv = encryptedBuffer.slice(0, 12);
  const authTag = encryptedBuffer.slice(12, 28);
  const encrypted = encryptedBuffer.slice(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return JSON.parse(decrypted.toString('utf8'));
}
```

**Note**: AES-GCM provides authenticated encryption. If decryption succeeds, message integrity is guaranteed. No separate HMAC needed.

### ECDSA Signing

**Binary protocol format** (avoid fingerprinting, minimize overhead):
```
[Version (1 byte)][Type (1 byte)][Payload]
```

**Version**: `0x01`

**Message Types**:
- `0x01` - HELLO (Phase 1: DoS prevention, 4-byte tag)
- `0x02` - HELLO_ACK (Phase 2: Echo + coordinator tag, rate-limited)
- `0x03` - ECDH Init (Phase 3: With coordinator tag verification)
- `0x04` - ECDH Response (Phase 4: Coordinator's ECDH key)
- `0x05` - Registration (Phase 5: AES-GCM encrypted)
- `0x06` - Ping (Keepalive, no payload)
- `0x07` - Heartbeat (AES-GCM encrypted)
- `0x08` - Answer (AES-GCM encrypted)
- `0xFF` - ERROR (Rate limiting/ban notification, not sent for HELLO)

**HELLO** (binary payload, DoS prevention):
```
Format: [serverTag(4)]
```
Server sends 4-byte random tag. No expensive operations. **Source IP:port cannot be trusted at this stage** - only used for reply routing.

**HELLO_ACK** (binary payload, rate-limited):
```
Format: [serverTag(4)][coordinatorTag(4)]
```
Coordinator echoes server's tag and sends its own 4-byte random tag. **Rate-limiting applies to replies sent**, not incoming HELLOs. No ERROR responses sent to HELLOs (prevents amplification attacks). Coordinator does not store server's tag (server will echo it back).

**ECDH Init** (binary payload with tag verification):
```
Format: [coordinatorTag(4)][ecdhPubKeyLen(1)][ecdhPubKey]
```
Server includes coordinator's tag. Coordinator verifies tag before expensive ECDH operation.

**ECDH Response** (binary payload with encrypted signature):
```
Format: [ecdhPubKeyLen(1)][ecdhPubKey][encryptedData]
```
Coordinator sends ECDH public key plus AES-GCM encrypted `{timestamp, signature}` using shared secret.

**Registration** (AES-GCM encrypted JSON, key from ECDH shared secret):
```javascript
{ 
  serverPublicKey,    // Server identity revealed only after encryption
  timestamp, 
  payload: { challenge, challengeAnswerHash }, 
  signature 
}
```

**All other messages** (AES-GCM encrypted JSON, key from expectedAnswer):
```javascript
{ type: 'ping' }  // Keepalive

{ type: 'heartbeat', payload: {...} }  // Challenge refresh (auth via GCM)

{ type: 'answer', ...payload, signature: '...' }  // SDP answer
```

## Coding Standards

### JavaScript Style
- Use `const` and `let`, never `var`
- Arrow functions where appropriate
- Template literals for strings
- Async/await over Promises
- Destructuring for readability

### Error Handling
- Always handle errors explicitly
- Use try/catch with async/await
- Provide meaningful error messages
- Log appropriately

### Module System
- ES modules for client
- ES modules or CommonJS for Node.js
- Clear dependencies

### Code Organization
- Small, focused files
- Separate concerns
- Descriptive names
- Avoid deep nesting

## Security Guidelines

- Never implement custom crypto
- Use Node.js crypto module
- Validate all signatures
- Sanitize all inputs
- Timing-safe comparisons for secrets
- File permissions 600 for private keys

## Performance Guidelines

- Minimize memory allocation
- Avoid unnecessary copying
- Use streams for large data
- Implement backpressure

## Testing

- Test critical paths
- Test error conditions
- Test crypto operations thoroughly
- Test protocol edge cases
- Keep tests independent
- Mock external dependencies

## Development Workflow

When making changes to code:
1. **Run tests first**: Ensure all tests pass before making changes
2. **Make changes**: Implement the requested modifications
3. **Run tests again**: Verify all tests still pass after changes
4. **Update documentation**: Keep documentation in sync with code changes
   - Update relevant README files if behavior changes
   - Update PROTOCOL.md if protocol changes
   - Update SECURITY.md if security model changes
   - Update ARCHITECTURE.md if design changes
5. **Make a commit**: Create a descriptive commit message
6. **Push changes**: Push to the repository

Best practices:
- Test changes locally
- No console.log in production code
- Follow style guidelines
- Keep changes focused and small
- Update documentation as needed

## Forbidden Practices

❌ Heavy frameworks (React, Vue, Angular, etc.)
❌ WebSockets
❌ Build tools (webpack, rollup, etc.)
❌ TypeScript
❌ Custom cryptography
❌ Committing secrets
❌ Synchronous file operations in server code
❌ Blocking event loop

## Recommended Practices

✅ Node.js built-in modules
✅ Minimal, audited dependencies
✅ Clear, self-documenting code
✅ Proper error handling
✅ ECDSA for signatures
✅ AES-GCM for authenticated encryption
✅ Input validation and sanitization
✅ Tests for critical functionality
✅ Semantic versioning
✅ Simple, maintainable code
