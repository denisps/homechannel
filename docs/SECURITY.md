# Security Architecture

HomeChannel's security model balances strong cryptography with minimal overhead.

## Three-Party Key System

Each component has its own Ed25519/Ed448 key pair:

### 1. Coordinator Keys
- Own Ed448 key pair (configurable Ed25519)
- Public key trusted by both clients and servers
- Signs all relayed messages

### 2. Server Keys
- Each server has unique Ed448 key pair (configurable Ed25519)
- Identified by public key
- Signs all payloads sent through coordinator

### 3. Client Trust
- Stores coordinator's public key
- Stores known server public keys (embedded in `index.html`, entered manually, or saved in localStorage)
- Verifies all signatures before trusting data

## Cryptographic Operations

### EdDSA Signatures (Ed25519/Ed448)
- **Algorithm**: Ed448 (default) or Ed25519
- **Digest**: Internal to the algorithm (no external hash parameter)
- **Use**: Initial registration, SDP/candidate exchange

### AES-GCM Authenticated Encryption
- **Algorithm**: AES-256-GCM
- **Key**: Derived from expectedAnswer via SHA-256
- **IV**: Random 12 bytes per message
- **Authentication**: Built-in 16-byte authentication tag
- **Use**: All server-coordinator UDP after registration
- **Properties**: Provides both confidentiality and authenticity in one operation

### Key Derivation
```javascript
// Derive 256-bit AES key from expectedAnswer
function deriveAESKey(expectedAnswer) {
  const hash = crypto.createHash('sha256');
  hash.update(expectedAnswer);
  return hash.digest(); // 32 bytes
}
```

## Challenge-Response Authentication

Prevents brute-force and DDoS attacks on home servers.

### Flow

1. **Server generates challenge**: Random 16 bytes
2. **Server computes expectedAnswer**: `SHA256(challenge + shared_secret)`
3. **Client computes answer**: `SHA256(challenge + password)`
4. **Coordinator verifies**: `answer === expectedAnswer`
5. **Connection proceeds** only if answer is correct

### Properties

- **Short challenge**: Minimizes bandwidth (16 bytes)
- **Periodic refresh**: Every 10 minutes
- **No brute-force**: Wrong answers rejected at coordinator
- **No DDoS**: Server never sees unauthorized connection attempts

## Communication Security

### Phase 1: Initial Registration (Unencrypted)

**Why unencrypted?**
- Initial X25519/X448 exchange must be verifiable
- EdDSA signature provides authenticity
- No shared secret exists yet

**Protection:**
- EdDSA signature prevents tampering
- Coordinator verifies against server's public key
- Replay attacks mitigated by timestamp checking

### Phase 2: Ongoing Communication (AES-GCM Encrypted)

**Why AES-GCM?**
- Authenticated encryption (confidentiality + authenticity)
- Single operation for encrypt + authenticate (20-100x faster than signature verification)
- Built-in tampering detection
- Industry standard for secure communication

**Protection:**
- Random IV prevents pattern analysis
- expectedAnswer as shared secret
- Authentication tag ensures message integrity
- If decryption succeeds, authentication is guaranteed

## WebRTC Security

Once datachannel is established:

- **DTLS**: All WebRTC connections use DTLS encryption
- **Peer-to-Peer**: Direct connection between client and server
- **No Coordinator**: Coordinator cannot intercept data
- **Perfect Forward Secrecy**: WebRTC provides PFS

## App Delivery Security

- App bundles are delivered directly from the server over WebRTC datachannels.
- App payloads are trusted from the server (no extra integrity layer).
- Client runs apps in sandboxed iframes to reduce UI attack surface.
- Server runs app handlers with try/catch or promise error handlers.
- Optional per-app workers provide fault isolation on the server side.

## Threat Model

### Protected Against

✅ **Man-in-the-Middle**: Ed25519/Ed448 signatures + AES-GCM encryption
✅ **Eavesdropping**: AES-GCM encryption of all sensitive data
✅ **Brute-Force**: Challenge-response at coordinator
✅ **DDoS**: Server never sees unauthorized attempts
✅ **Replay Attacks**: Timestamps + random IVs
✅ **Pattern Analysis**: Random IVs prevent traffic analysis
✅ **Tampering**: AES-GCM authentication tag detects modifications

### Not Protected Against

❌ **Compromised Coordinator**: Can see challenges (but not peer data)
❌ **Stolen Keys**: Physical access to key files
❌ **Weak Passwords**: Challenge-response only as strong as password
❌ **Browser Vulnerabilities**: Client runs in browser context
❌ **Malicious Server Apps**: App payloads are trusted from the server

## Key Management

### Coordinator Keys

```bash
# Generated on first run
./keys/coordinator-private.key  # chmod 600
./keys/coordinator-public.key   # Distributed to all
```

### Server Keys

```bash
# Generated per server
./keys/server-private.key  # chmod 600, keep secret
./keys/server-public.key   # Share with authorized clients
```

### Key Distribution

- **Coordinator Public Key**: Embedded in client and server configs
- **Server Public Keys**: Distributed via secure channel (QR code, config file)
- **expectedAnswer**: Never transmitted, derived from challenge

## Best Practices

1. **Use Strong Passwords**: expectedAnswer security depends on it
2. **Secure Key Storage**: File permissions 600 for private keys
3. **Regular Updates**: Keep Node.js and dependencies updated
4. **Monitor Logs**: Watch for unusual connection patterns
5. **Rotate Challenges**: Automatic every 10 minutes
6. **Limit Coordinators**: Trust only one coordinator per deployment

## Security Assumptions

- **Coordinator is Trusted**: Verifies challenges, relays messages
- **TLS for HTTPS**: Client-coordinator uses TLS (not specified here)
- **Physical Security**: Private keys stored securely
- **Network Security**: Home network is reasonably secure

## Future Enhancements

- [ ] Certificate pinning for coordinator
- [ ] Multi-coordinator support with key rotation
- [ ] Hardware security module (HSM) support
- [ ] Audit logging and intrusion detection
- [ ] Rate limiting enhancements
