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
- **Registration**: ECDSA-signed, unencrypted (initial ECDH)
- **Ongoing UDP**: AES-256-CTR encrypted using expectedAnswer as key
- **Challenge-Response**: Prevents brute-force and DDoS

### Encryption Details
- **AES Key**: Derived from expectedAnswer via SHA-256
- **IV**: Random 16 bytes per message
- **HMAC**: SHA-256 for challenge refresh

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

### AES-CTR Encryption
```javascript
function deriveAESKey(expectedAnswer) {
  const hash = crypto.createHash('sha256');
  hash.update(expectedAnswer);
  return hash.digest(); // 256-bit key
}

function encryptAES(data, key) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-ctr', key, iv);
  const dataBuffer = Buffer.from(JSON.stringify(data), 'utf8');
  const encrypted = Buffer.concat([cipher.update(dataBuffer), cipher.final()]);
  return Buffer.concat([iv, encrypted]).toString('hex');
}

function decryptAES(encryptedHex, key) {
  const buffer = Buffer.from(encryptedHex, 'hex');
  const iv = buffer.slice(0, 16);
  const encrypted = buffer.slice(16);
  const decipher = crypto.createDecipheriv('aes-256-ctr', key, iv);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return JSON.parse(decrypted.toString('utf8'));
}
```

### ECDSA Signing
```javascript
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
```

### HMAC
```javascript
function createHMAC(data, secret) {
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(JSON.stringify(data));
  return hmac.digest('hex');
}

function verifyHMAC(data, hmacValue, secret) {
  const expected = createHMAC(data, secret);
  return crypto.timingSafeEqual(
    Buffer.from(hmacValue, 'hex'),
    Buffer.from(expected, 'hex')
  );
}
```

## UDP Message Format

**Binary protocol format** (avoid fingerprinting, minimize overhead):
```
[Version (1 byte)][Type (1 byte)][Payload]
```

**Version**: `0x01`

**Message Types**:
- `0x01` - Registration (binary payload)
- `0x02` - Ping (AES-CTR encrypted)
- `0x03` - Heartbeat (AES-CTR encrypted)
- `0x04` - Answer (AES-CTR encrypted)

**Registration** (binary payload):
```
Format: [pubKeyLen(2)][pubKey][timestamp(8)][challenge(16)][answerHash(32)][sigLen(2)][signature]
```

**All other messages** (AES-CTR encrypted JSON payloads):
```javascript
{ type: 'ping' }  // Keepalive

{ type: 'heartbeat', payload: {...}, hmac: '...' }  // Challenge refresh

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
✅ AES-CTR for encryption
✅ Input validation and sanitization
✅ Tests for critical functionality
✅ Semantic versioning
✅ Simple, maintainable code
