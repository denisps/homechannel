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

#### ECDSA Signing
- SDPs (Session Description Protocol) must be signed using ECDSA
- ICE candidates must be signed using ECDSA
- Use P-256 (secp256r1) curve for compatibility
- Implement signature verification on both sides

#### Public Key Infrastructure
- Servers identified by their ECDSA public keys
- No traditional PKI/certificates required
- Implement trust-on-first-use (TOFU) or pre-shared public keys
- Store known server public keys securely

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
// Example UDP message structure
{
  type: 'message_type',
  timestamp: Date.now(),
  payload: {},
  signature: 'hex_encoded_signature'
}
```

### HTTPS Polling Pattern
```javascript
// Long-polling example for client
async function pollForMessages() {
  try {
    const response = await fetch('/api/poll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lastMessageId: lastId })
    });
    const data = await response.json();
    // Process data
  } catch (error) {
    console.error('Polling error:', error);
  }
}
```

### ECDSA Signing Pattern
```javascript
// Example signing pattern
const crypto = require('crypto');

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
