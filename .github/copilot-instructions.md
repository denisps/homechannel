# HomeChannel Copilot Instructions

## Project Overview
Minimal-dependency WebRTC datachannel solution for remote home access. Pure JavaScript, no build tools, Node.js built-ins only.

**Core Principles:**
- Pure JavaScript (ES modules/CommonJS), zero transpilation
- Minimal dependencies, no WebSockets (HTTP/HTTPS polling)
- Alpha status - API subject to change

**Project Structure:**
- `client/` - Browser (vanilla JS, ES modules)
- `server/` - Home Node.js (UDP to coordinator)
- `coordinator/` - Public Node.js (UDP + HTTPS)
- `docs/` - Detailed documentation

**Reference Documentation:**
- `docs/PROTOCOL.md` - Protocol specifications and message formats
- `docs/SECURITY.md` - Security model and cryptography
- `docs/ARCHITECTURE.md` - System design
- `shared/crypto.js` - Crypto implementations (AES-GCM, Ed25519/Ed448, X25519/X448)
- `shared/protocol.js` - Protocol helpers and UDPClient

## Security Essentials

**Encryption:**
- AES-256-GCM for authenticated encryption (see `shared/crypto.js`)
- Ed448 for signatures (configurable Ed25519), X25519/X448 for key exchange
- expectedAnswer → SHA-256 → AES key
- Never implement custom crypto, use Node.js crypto module

**Critical Rules:**
- Validate all signatures before processing
- Timing-safe comparisons for secrets
- Sanitize all inputs
- File permissions 600 for private keys
- Never commit secrets

**Files to NEVER Commit:**
- `node_modules/` - Dependencies (already in .gitignore)
- `package-lock.json` - Lock files (use --no-save for test deps)
- `*.key`, `*.pem` - Private keys (already in .gitignore)
- `config.json` - Configuration files (already in .gitignore)
- `*.log` - Log files (already in .gitignore)
- `coverage/`, `dist/`, `build/` - Build artifacts (already in .gitignore)

**Test Dependencies:**
- WebRTC libraries (`werift`, `wrtc`, `node-datachannel`) are optional
- Install with `npm install --no-save` to avoid changing package.json
- Never commit `package-lock.json` files for test dependencies

## Coding Standards

**JavaScript:**
- `const`/`let` (never `var`), arrow functions, template literals
- Async/await for all I/O (❌ no sync file operations)
- Proper error handling (try/catch), meaningful messages
- Small focused files, descriptive names, avoid deep nesting

**Performance:**
- Minimize allocations, avoid unnecessary copying
- Use streams for large data, implement backpressure
- No blocking operations in event loop

**SVG/XML:**
- Always escape special characters in SVG text content:
  - `&` → `&amp;`
  - `<` → `&lt;`
  - `>` → `&gt;`
  - `"` → `&quot;`
  - `'` → `&apos;`
- Validate SVG files load correctly in browsers

## Development Workflow

### Pre-Implementation Checklist
- [ ] Requirements clear, no forbidden practices (see below)
- [ ] Async operations for all I/O (no sync file ops)
- [ ] Node.js built-ins only, minimal dependencies
- [ ] Security considered (crypto, validation, sanitization)
- [ ] Test strategy identified

### Testing Requirements

**Tests MUST verify actual behavior, not just side effects:**
- ❌ DON'T: Check connection still alive → assume keepalive works
- ✅ DO: Listen for keepalive events, count messages, verify exchange
- ❌ DON'T: Check file exists → assume write succeeded
- ✅ DO: Read file back, verify exact content matches
- ❌ DON'T: Check no error thrown → assume encryption worked
- ✅ DO: Decrypt result, verify plaintext matches original

**Critical test standards:**
- Listen for/capture events being tested (use `.on()` handlers)
- Count messages/calls if testing message exchange
- Verify exact data (decrypt, read back, parse) not just absence of errors
- Test both positive and negative cases (success AND failure paths)
- Include timeouts for all async operations
- Clean up all resources in `after()` hooks using proper stop/close methods

### Workflow Steps

1. **Branch:** `git checkout -b feature/name` or `fix/name`
2. **Baseline test:** `npm test` (ensure passing)
3. **Write tests** (TDD: verify ACTUAL behavior, not side effects)
4. **Implement** (async/await, error handling, meaningful messages)
5. **Test:** `npm test` (verify implementation)
6. **Review checklist:**
   - [ ] Tests pass, no sync file ops (fs.readFileSync, etc.)
   - [ ] No blocking, async properly awaited
   - [ ] Error handling, input validation/sanitization
   - [ ] No console.log, no custom crypto
   - [ ] Timing-safe secret comparisons, file perms 600 for keys
   - [ ] Clear, self-documenting code
7. **Optimize** if needed (memory, copying, backpressure)
8. **Retest:** `npm test`
9. **Update docs** (README, PROTOCOL, SECURITY, ARCHITECTURE as needed)
10. **Commit:** `git commit -m "feat: description"` or `"fix: description"`
11. **Push:** `git push origin branch-name`
12. **PR/merge** to main

### Quick Reference

**Forbidden:** Heavy frameworks, WebSockets, build tools, TypeScript, custom crypto, secrets in commits, sync file ops, blocking event loop, console.log in production, committing node_modules, committing package-lock.json, committing test dependencies

**Required:** Node.js built-ins, async I/O, error handling, Ed448 signatures (configurable Ed25519), AES-GCM encryption, input validation, tests, semantic versioning, simple maintainable code, `--no-save` flag when installing test dependencies
