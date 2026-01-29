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
- `shared/crypto.js` - Crypto implementations (AES-GCM, ECDSA, ECDH)
- `shared/protocol.js` - Protocol helpers and UDPClient

## Security Essentials

**Encryption:**
- AES-256-GCM for authenticated encryption (see `shared/crypto.js`)
- ECDSA for signatures, ECDH for key exchange
- expectedAnswer → SHA-256 → AES key
- Never implement custom crypto, use Node.js crypto module

**Critical Rules:**
- Validate all signatures before processing
- Timing-safe comparisons for secrets
- Sanitize all inputs
- File permissions 600 for private keys
- Never commit secrets

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

### Workflow Steps

1. **Branch:** `git checkout -b feature/name` or `fix/name`
2. **Baseline test:** `timeout 60 npm test` (ensure passing, never hang)
3. **Write tests** (TDD: test critical paths, errors, edge cases)
   - **Always specify explicit timeouts** using `{ timeout: ms }` option:
     - `it('test name', { timeout: 5000 }, async () => { ... })`
     - Use appropriate timeouts: 3s for simple tests, 5-10s for integration, 10-15s for system tests
   - Only use `setTimeout()` for actual delays in test logic (waiting for async operations), not as test timeouts
   - Test timeout prevents the entire test from hanging
   - `setTimeout()` for waiting is when you need a specific component behavior to complete
4. **Implement** (async/await, error handling, meaningful messages)
5. **Test:** `timeout 60 npm test` (verify implementation, never hang)
6. **Review checklist:**
   - [ ] Tests pass, no sync file ops (fs.readFileSync, etc.)
   - [ ] All tests have explicit `{ timeout: ms }` options
   - [ ] No blocking, async properly awaited
   - [ ] Error handling, input validation/sanitization
   - [ ] No console.log, no custom crypto
   - [ ] Timing-safe secret comparisons, file perms 600 for keys
   - [ ] Clear, self-documenting code
7. **Optimize** if needed (memory, copying, backpressure)
8. **Retest:** `timeout 60 npm test`
9. **Update docs** (README, PROTOCOL, SECURITY, ARCHITECTURE as needed)
10. **Commit:** `git commit -m "feat: description"` or `"fix: description"`
11. **Push/PR:**
    - Local agents: `git push origin branch-name` (then create PR manually)
    - Unattended agents: Create pull request automatically (don't push directly)
12. **Merge** after review

## Testing Guidelines

**Running Tests:**
- Always wrap test commands with timeout: `timeout 60 npm test`
- Prevents agent/process from hanging indefinitely
- Use appropriate timeout values: 30-60 seconds for most test suites
- Tests themselves should have explicit `{ timeout: ms }` options

**Test Timeouts:**
- Always use explicit timeout option: `it('test', { timeout: 5000 }, async () => { ... })`
- Recommended timeouts:
  - Unit tests: 3000ms (3 seconds)
  - Integration tests: 5000ms (5 seconds)
  - E2E tests: 10000ms (10 seconds)
  - System/load tests: 10000-15000ms (10-15 seconds)
- Use `setTimeout()` only for actual delays in test logic (e.g., waiting for async operations to complete)
- Never rely on default test timeout - always specify explicitly

**Test Structure:**
- Use Node.js built-in test runner (`node:test`)
- Async/await for all async operations
- Proper cleanup in `after()` hooks
- Meaningful test descriptions
- Test both success and error paths

### Quick Reference

**Forbidden:** Heavy frameworks, WebSockets, build tools, TypeScript, custom crypto, secrets in commits, sync file ops, blocking event loop, console.log in production

**Required:** Node.js built-ins, async I/O, error handling, ECDSA signatures, AES-GCM encryption, input validation, tests, semantic versioning, simple maintainable code
